import * as path from 'path'
import * as fs from 'fs'
import { getConfig, AppConfig } from '../config'
import { logger } from '../logger'
import { probeMedia, MediaInfo, formatDuration, formatFileSize } from './probe'
import { runCommand, parseProgress } from './runner'

export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: 'normalize' | 'boost' | 'convert' | 'extract' | 'compress'
  boostPercent?: number
  preset?: string
  convertOptions?: { outputFormat: string; videoCodec: string; audioCodec: string; videoBitrate: string; audioBitrate: string; resolution: string; framerate: string }
  extractOptions?: { outputFormat: string; streamIndex: number }
  compressOptions?: { targetSizeMB: number; quality: string }
  status: 'queued' | 'analyzing' | 'processing' | 'finalizing' | 'complete' | 'error' | 'cancelled'
  progress: number
  message: string
  startedAt?: number
  completedAt?: number
  error?: string
  mediaInfo?: MediaInfo
  outputSize?: number
  inputSize?: number
  outputPath?: string
}

export type TaskProgressCallback = (task: ProcessingTask) => void

const CHANNEL_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  6: '5.1',
  8: '7.1'
}

function channelLayout(channels: number): string {
  return CHANNEL_LAYOUTS[channels] || 'stereo'
}

function stripMolexTag(title: string): string {
  return title.replace(/\[molex(?:Audio|Media)[^\]]*\]\s*/g, '').trim()
}

function createTempPath(filePath: string, suffix: string): string {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  return path.join(dir, `${base}${suffix}${ext}`)
}

interface LoudnessMetrics {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

async function analyzeLoudness(
  ffmpegPath: string,
  filePath: string,
  streamIndex: number,
  config: AppConfig,
  onStderrLine?: (line: string) => void
): Promise<LoudnessMetrics> {
  const { I, TP, LRA } = config.normalization
  const args = [
    '-i', filePath,
    '-threads', '0',
    '-map', `0:a:${streamIndex}`,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
    '-f', 'null',
    '-'
  ]

  logger.ffmpeg('ANALYZE', `Stream ${streamIndex} of ${path.basename(filePath)}`)

  const { promise } = runCommand(ffmpegPath, args, onStderrLine)
  const result = await promise

  if (result.code !== 0 && !result.killed) {
    throw new Error(`Analysis failed: ${result.stderr.slice(-500)}`)
  }

  const jsonMatch = result.stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Could not extract loudness data from FFmpeg output')
  }

  const metrics = JSON.parse(jsonMatch[0])
  logger.ffmpeg('METRICS', `Stream ${streamIndex}: I=${metrics.input_i} TP=${metrics.input_tp} LRA=${metrics.input_lra}`)

  return {
    input_i: metrics.input_i,
    input_tp: metrics.input_tp,
    input_lra: metrics.input_lra,
    input_thresh: metrics.input_thresh,
    target_offset: metrics.target_offset
  }
}

export async function normalizeFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath

  if (!ffmpegPath) {
    task.status = 'error'
    task.error = 'FFmpeg not configured'
    onProgress(task)
    return task
  }

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing audio loudness...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0

    if (info.audioStreams.length === 0) {
      throw new Error('No audio streams found in file')
    }

    const totalDuration = parseFloat(info.format.duration) || 0

    logger.info(`Normalizing: ${task.fileName} (${info.audioStreams.length} audio streams, ${formatDuration(totalDuration)})`)

    // Analysis pass — measure all streams
    const metrics: LoudnessMetrics[] = []
    for (let i = 0; i < info.audioStreams.length; i++) {
      const streamLabel = `Analyzing stream ${i + 1}/${info.audioStreams.length}`
      task.message = `${streamLabel}...`
      task.progress = Math.round(((i) / info.audioStreams.length) * 30)
      onProgress(task)

      if (abortSignal?.signal.aborted) {
        task.status = 'cancelled'
        task.message = 'Cancelled'
        onProgress(task)
        return task
      }

      const m = await analyzeLoudness(ffmpegPath, task.filePath, i, config, (line) => {
        const progress = parseProgress(line)
        if (progress && totalDuration > 0) {
          const streamBase = Math.round((i / info.audioStreams.length) * 30)
          const streamSlice = 30 / info.audioStreams.length
          const pct = Math.min(streamBase + Math.round((progress.time / totalDuration) * streamSlice), 29)
          task.progress = pct
          task.message = `${streamLabel} — ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
          onProgress(task)
        }
      })
      metrics.push(m)
    }

    // Build encode command
    task.status = 'processing'
    task.message = 'Encoding normalized audio...'
    task.progress = 30
    onProgress(task)

    const { I, TP, LRA } = config.normalization
    const filterParts: string[] = []
    const mapArgs: string[] = []

    for (let i = 0; i < info.audioStreams.length; i++) {
      const m = metrics[i]
      filterParts.push(
        `[0:a:${i}]loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:` +
        `measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
        `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:` +
        `offset=${m.target_offset}[a${i}]`
      )
      mapArgs.push('-map', `[a${i}]`)
    }

    const tempPath = createTempPath(task.filePath, config.tempSuffix)
    const args: string[] = ['-y', '-i', task.filePath, '-threads', '0']

    args.push('-filter_complex', filterParts.join(';'))

    if (info.isVideoFile) {
      args.push('-map', '0:v')
    }
    if (config.preserveSubtitles) {
      args.push('-map', '0:s?')
    }

    args.push(...mapArgs)

    // Metadata
    for (let i = 0; i < info.audioStreams.length; i++) {
      const stream = info.audioStreams[i]
      const origTitle = stream.tags?.title || stream.tags?.handler_name || `Track ${i + 1}`
      const cleanTitle = stripMolexTag(origTitle)
      const newTitle = `[molexMedia Normalized] ${cleanTitle}`
      args.push(`-metadata:s:a:${i}`, `title=${newTitle}`)
    }

    // Codec
    if (config.audioCodec === 'inherit') {
      for (let i = 0; i < info.audioStreams.length; i++) {
        const codec = info.audioStreams[i].codec_name || config.fallbackCodec
        args.push(`-c:a:${i}`, codec, `-b:a:${i}`, config.audioBitrate)
      }
    } else {
      args.push('-c:a', config.audioCodec, '-b:a', config.audioBitrate)
    }

    if (info.isVideoFile) {
      args.push('-c:v', 'copy')
      if (config.preserveSubtitles) {
        args.push('-c:s', 'copy')
      }
    }

    args.push(tempPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 30 + Math.round((progress.time / totalDuration) * 65))
        task.progress = pct
        task.message = `Encoding... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) {
      abortSignal.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM')
      })
    }

    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) {
      cleanupTemp(tempPath)
      task.status = 'cancelled'
      task.message = 'Cancelled'
      onProgress(task)
      return task
    }

    if (result.code !== 0) {
      cleanupTemp(tempPath)
      throw new Error(`FFmpeg encode failed (code ${result.code})`)
    }

    // Finalize
    task.status = 'finalizing'
    task.message = 'Replacing original file...'
    task.progress = 96
    onProgress(task)

    if (config.overwriteOriginal) {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
    } else {
      const outDir = config.outputDirectory || path.dirname(task.filePath)
      const outPath = path.join(outDir, `normalized_${path.basename(task.filePath)}`)
      fs.renameSync(tempPath, outPath)
    }

    const stat = fs.statSync(task.filePath)
    task.outputSize = stat.size
    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.message = `Normalized successfully in ${formatElapsed(task.startedAt!, task.completedAt)}`

    logger.success(`Normalized: ${task.fileName} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)})`)
    onProgress(task)

    return task
  } catch (err: any) {
    task.status = 'error'
    task.error = err.message
    task.message = `Error: ${err.message}`
    task.completedAt = Date.now()
    logger.error(`Failed to normalize ${task.fileName}: ${err.message}`)
    onProgress(task)
    return task
  }
}

export async function boostFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath

  if (!ffmpegPath) {
    task.status = 'error'
    task.error = 'FFmpeg not configured'
    onProgress(task)
    return task
  }

  const boostPercent = task.boostPercent || 0
  const multiplier = 1.0 + boostPercent / 100.0

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = `Preparing to boost by ${boostPercent > 0 ? '+' : ''}${boostPercent}%...`
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0

    if (info.audioStreams.length === 0) {
      throw new Error('No audio streams found')
    }

    const totalDuration = parseFloat(info.format.duration) || 0

    logger.info(`Boosting: ${task.fileName} by ${boostPercent}% (${info.audioStreams.length} streams)`)

    task.status = 'processing'
    task.message = `Boosting volume by ${boostPercent > 0 ? '+' : ''}${boostPercent}%...`
    task.progress = 10
    onProgress(task)

    const filterParts: string[] = []
    const mapArgs: string[] = []
    let maxChannels = 0

    for (let i = 0; i < info.audioStreams.length; i++) {
      const stream = info.audioStreams[i]
      const layout = channelLayout(stream.channels)
      const sampleRate = stream.sample_rate || '48000'
      maxChannels = Math.max(maxChannels, stream.channels)

      filterParts.push(
        `[0:a:${i}]aformat=channel_layouts=${layout}:sample_fmts=s16:sample_rates=${sampleRate},volume=${multiplier}[a${i}]`
      )
      mapArgs.push('-map', `[a${i}]`)
    }

    const tempPath = createTempPath(task.filePath, config.tempSuffix)
    const args: string[] = ['-y', '-i', task.filePath, '-threads', '0']

    args.push('-filter_complex', filterParts.join(';'))

    if (info.isVideoFile) {
      args.push('-map', '0:v')
    }
    if (config.preserveSubtitles) {
      args.push('-map', '0:s?')
    }

    args.push(...mapArgs)

    // Metadata
    for (let i = 0; i < info.audioStreams.length; i++) {
      const stream = info.audioStreams[i]
      const origTitle = stream.tags?.title || stream.tags?.handler_name || `Track ${i + 1}`
      const cleanTitle = stripMolexTag(origTitle)
      const sign = boostPercent > 0 ? '+' : ''
      const newTitle = `[molexMedia Boosted ${sign}${boostPercent}%] ${cleanTitle}`
      args.push(`-metadata:s:a:${i}`, `title=${newTitle}`)
    }

    // Codec
    if (config.audioCodec === 'inherit') {
      for (let i = 0; i < info.audioStreams.length; i++) {
        const codec = info.audioStreams[i].codec_name || config.fallbackCodec
        args.push(`-c:a:${i}`, codec, `-b:a:${i}`, config.audioBitrate)
      }
    } else {
      args.push('-c:a', config.audioCodec, '-b:a', config.audioBitrate)
    }

    args.push('-ac', String(maxChannels))

    if (info.isVideoFile) {
      args.push('-c:v', 'copy')
      if (config.preserveSubtitles) {
        args.push('-c:s', 'copy')
      }
    }

    args.push(tempPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 10 + Math.round((progress.time / totalDuration) * 85))
        task.progress = pct
        task.message = `Boosting... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) {
      abortSignal.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM')
      })
    }

    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) {
      cleanupTemp(tempPath)
      task.status = 'cancelled'
      task.message = 'Cancelled'
      onProgress(task)
      return task
    }

    if (result.code !== 0) {
      cleanupTemp(tempPath)
      throw new Error(`FFmpeg encode failed (code ${result.code})`)
    }

    task.status = 'finalizing'
    task.message = 'Replacing original file...'
    task.progress = 96
    onProgress(task)

    if (config.overwriteOriginal) {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
    } else {
      const outDir = config.outputDirectory || path.dirname(task.filePath)
      const outPath = path.join(outDir, `boosted_${path.basename(task.filePath)}`)
      fs.renameSync(tempPath, outPath)
    }

    const stat = fs.statSync(task.filePath)
    task.outputSize = stat.size
    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.message = `Boosted by ${boostPercent > 0 ? '+' : ''}${boostPercent}% in ${formatElapsed(task.startedAt!, task.completedAt)}`

    logger.success(`Boosted: ${task.fileName} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)})`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'
    task.error = err.message
    task.message = `Error: ${err.message}`
    task.completedAt = Date.now()
    logger.error(`Failed to boost ${task.fileName}: ${err.message}`)
    onProgress(task)
    return task
  }
}

// ─── Convert File ───────────────────────────────────
export async function convertFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) { task.status = 'error'; task.error = 'FFmpeg not configured'; onProgress(task); return task }

  const opts = task.convertOptions
  if (!opts) { task.status = 'error'; task.error = 'No convert options'; onProgress(task); return task }

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing media...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0
    const totalDuration = parseFloat(info.format.duration) || 0

    logger.info(`Converting: ${task.fileName} → .${opts.outputFormat}`)

    task.status = 'processing'
    task.message = `Converting to ${opts.outputFormat.toUpperCase()}...`
    task.progress = 5
    onProgress(task)

    const outDir = config.outputDirectory || path.dirname(task.filePath)
    const baseName = path.basename(task.filePath, path.extname(task.filePath))
    const outPath = path.join(outDir, `${baseName}.${opts.outputFormat}`)

    const args: string[] = ['-y', '-i', task.filePath, '-threads', '0']

    // Video codec
    if (info.isVideoFile) {
      if (opts.videoCodec === 'copy') {
        args.push('-c:v', 'copy')
      } else {
        args.push('-c:v', opts.videoCodec)
        if (opts.videoBitrate) args.push('-b:v', opts.videoBitrate)
      }
      if (opts.resolution) {
        args.push('-vf', `scale=${opts.resolution.replace('x', ':')}`)
      }
      if (opts.framerate) {
        args.push('-r', opts.framerate)
      }
    }

    // Audio codec
    if (opts.audioCodec === 'copy') {
      args.push('-c:a', 'copy')
    } else {
      args.push('-c:a', opts.audioCodec)
      if (opts.audioBitrate && opts.audioBitrate !== '0') args.push('-b:a', opts.audioBitrate)
    }

    if (config.preserveSubtitles && info.isVideoFile) {
      args.push('-map', '0', '-c:s', 'copy')
    }

    args.push(outPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
        task.progress = pct
        task.message = `Converting... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'))
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) { cleanupTemp(outPath); task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task }
    if (result.code !== 0) { cleanupTemp(outPath); throw new Error(`FFmpeg convert failed (code ${result.code})`) }

    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.outputPath = outPath
    task.outputSize = fs.statSync(outPath).size
    task.message = `Converted to ${opts.outputFormat.toUpperCase()} in ${formatElapsed(task.startedAt!, task.completedAt)}`
    logger.success(`Converted: ${task.fileName} → ${path.basename(outPath)} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)})`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'; task.error = err.message; task.message = `Error: ${err.message}`; task.completedAt = Date.now()
    logger.error(`Failed to convert ${task.fileName}: ${err.message}`); onProgress(task); return task
  }
}

// ─── Extract Audio ──────────────────────────────────
export async function extractAudio(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) { task.status = 'error'; task.error = 'FFmpeg not configured'; onProgress(task); return task }

  const opts = task.extractOptions || { outputFormat: 'mp3', streamIndex: 0 }

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing media...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0
    const totalDuration = parseFloat(info.format.duration) || 0

    if (info.audioStreams.length === 0) throw new Error('No audio streams found')

    logger.info(`Extracting audio: ${task.fileName} stream ${opts.streamIndex} → .${opts.outputFormat}`)

    task.status = 'processing'
    task.message = `Extracting audio to ${opts.outputFormat.toUpperCase()}...`
    task.progress = 5
    onProgress(task)

    const outDir = config.outputDirectory || path.dirname(task.filePath)
    const baseName = path.basename(task.filePath, path.extname(task.filePath))
    const outPath = path.join(outDir, `${baseName}_audio.${opts.outputFormat}`)

    const codecMap: Record<string, string> = { mp3: 'libmp3lame', aac: 'aac', flac: 'flac', wav: 'pcm_s16le', ogg: 'libvorbis', opus: 'libopus', m4a: 'aac' }
    const codec = codecMap[opts.outputFormat] || 'copy'

    const args = ['-y', '-i', task.filePath, '-threads', '0', '-vn', '-map', `0:a:${opts.streamIndex}`, '-c:a', codec]
    if (codec !== 'copy' && codec !== 'pcm_s16le' && codec !== 'flac') {
      args.push('-b:a', config.audioBitrate)
    }
    args.push(outPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
        task.progress = pct
        task.message = `Extracting... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'))
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) { cleanupTemp(outPath); task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task }
    if (result.code !== 0) { cleanupTemp(outPath); throw new Error(`Audio extraction failed (code ${result.code})`) }

    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.outputPath = outPath
    task.outputSize = fs.statSync(outPath).size
    task.message = `Extracted audio in ${formatElapsed(task.startedAt!, task.completedAt)}`
    logger.success(`Extracted: ${task.fileName} → ${path.basename(outPath)} (${formatFileSize(task.outputSize)})`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'; task.error = err.message; task.message = `Error: ${err.message}`; task.completedAt = Date.now()
    logger.error(`Failed to extract audio from ${task.fileName}: ${err.message}`); onProgress(task); return task
  }
}

// ─── Compress / Reduce File Size ────────────────────
export async function compressFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) { task.status = 'error'; task.error = 'FFmpeg not configured'; onProgress(task); return task }

  const opts = task.compressOptions || { targetSizeMB: 0, quality: 'high' }

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing media...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0
    const totalDuration = parseFloat(info.format.duration) || 0

    logger.info(`Compressing: ${task.fileName} (${opts.quality} quality)`)

    task.status = 'processing'
    task.message = `Compressing (${opts.quality} quality)...`
    task.progress = 5
    onProgress(task)

    const tempPath = createTempPath(task.filePath, config.tempSuffix)

    // Quality → CRF mapping for H.264
    const crfMap: Record<string, number> = { lossless: 0, high: 18, medium: 23, low: 28 }
    const crf = crfMap[opts.quality] ?? 23

    const args = ['-y', '-i', task.filePath, '-threads', '0']

    if (info.isVideoFile) {
      args.push('-c:v', 'libx264', '-preset', opts.quality === 'lossless' ? 'veryslow' : 'medium', '-crf', String(crf))
      if (opts.targetSizeMB > 0 && totalDuration > 0) {
        const targetBits = opts.targetSizeMB * 8 * 1024 * 1024
        const audioBitrate = 128000
        const videoBitrate = Math.max(100000, Math.floor((targetBits / totalDuration) - audioBitrate))
        args.length = 5 // reset after -threads 0
        args.push('-c:v', 'libx264', '-b:v', String(videoBitrate), '-maxrate', String(videoBitrate * 2), '-bufsize', String(videoBitrate * 4))
      }
      args.push('-c:a', 'aac', '-b:a', opts.quality === 'low' ? '128k' : '256k')
    } else {
      // Audio-only compression
      const audioBitrates: Record<string, string> = { lossless: '0', high: '256k', medium: '192k', low: '128k' }
      if (opts.quality === 'lossless') {
        args.push('-c:a', 'flac')
      } else {
        args.push('-c:a', 'aac', '-b:a', audioBitrates[opts.quality])
      }
    }

    if (info.isVideoFile && config.preserveSubtitles) args.push('-c:s', 'copy')
    args.push(tempPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
        task.progress = pct
        task.message = `Compressing... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'))
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) { cleanupTemp(tempPath); task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task }
    if (result.code !== 0) { cleanupTemp(tempPath); throw new Error(`Compression failed (code ${result.code})`) }

    task.status = 'finalizing'
    task.message = 'Finalizing...'
    task.progress = 96
    onProgress(task)

    if (config.overwriteOriginal) {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
      task.outputPath = task.filePath
    } else {
      const outDir = config.outputDirectory || path.dirname(task.filePath)
      const outPath = path.join(outDir, `compressed_${path.basename(task.filePath)}`)
      fs.renameSync(tempPath, outPath)
      task.outputPath = outPath
    }

    task.outputSize = fs.statSync(task.outputPath!).size
    const ratio = task.inputSize ? Math.round((1 - task.outputSize / task.inputSize) * 100) : 0
    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.message = `Compressed (${ratio}% smaller) in ${formatElapsed(task.startedAt!, task.completedAt)}`
    logger.success(`Compressed: ${task.fileName} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)}, ${ratio}% reduction)`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'; task.error = err.message; task.message = `Error: ${err.message}`; task.completedAt = Date.now()
    logger.error(`Failed to compress ${task.fileName}: ${err.message}`); onProgress(task); return task
  }
}

function cleanupTemp(tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  } catch {}
}

function formatElapsed(start: number, end: number): string {
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

export function findMediaFiles(dirPath: string, extensions: string[]): string[] {
  const results: string[] = []
  const extSet = new Set(extensions.map((e) => e.toLowerCase()))

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (extSet.has(ext)) {
          results.push(fullPath)
        }
      }
    }
  }

  walk(dirPath)
  return results.sort()
}

// Batch concurrent processor
let pauseResolve: (() => void) | null = null
let pausePromise: Promise<void> | null = null
let isPaused = false

export function pauseProcessing(): void {
  if (isPaused) return
  isPaused = true
  pausePromise = new Promise<void>((resolve) => {
    pauseResolve = resolve
  })
  logger.info('Processing paused')
}

export function resumeProcessing(): void {
  if (!isPaused) return
  isPaused = false
  if (pauseResolve) {
    pauseResolve()
    pauseResolve = null
    pausePromise = null
  }
  logger.info('Processing resumed')
}

export function getIsPaused(): boolean {
  return isPaused
}

export async function processBatch(
  tasks: ProcessingTask[],
  maxConcurrency: number,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask[]> {
  const results: ProcessingTask[] = []
  let index = 0
  const total = tasks.length

  logger.info(`Starting batch: ${total} files, ${maxConcurrency} concurrent workers`)

  async function worker(): Promise<void> {
    while (index < total) {
      if (abortSignal?.signal.aborted) break

      // Wait if paused
      if (pausePromise) {
        await pausePromise
      }
      if (abortSignal?.signal.aborted) break

      const i = index++
      const task = tasks[i]
      task.message = `Queued (${i + 1}/${total})`
      onProgress(task)

      let result: ProcessingTask
      if (task.operation === 'normalize') {
        result = await normalizeFile(task, onProgress, abortSignal)
      } else if (task.operation === 'boost') {
        result = await boostFile(task, onProgress, abortSignal)
      } else if (task.operation === 'convert') {
        result = await convertFile(task, onProgress, abortSignal)
      } else if (task.operation === 'extract') {
        result = await extractAudio(task, onProgress, abortSignal)
      } else if (task.operation === 'compress') {
        result = await compressFile(task, onProgress, abortSignal)
      } else {
        result = await normalizeFile(task, onProgress, abortSignal)
      }
      results.push(result)
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, total) }, () => worker())
  await Promise.all(workers)

  // Reset pause state when batch ends
  isPaused = false
  pauseResolve = null
  pausePromise = null

  const succeeded = results.filter((r) => r.status === 'complete').length
  const failed = results.filter((r) => r.status === 'error').length
  logger.info(`Batch complete: ${succeeded} succeeded, ${failed} failed, ${total - succeeded - failed} other`)

  return results
}
