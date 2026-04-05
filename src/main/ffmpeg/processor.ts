import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { getConfig, AppConfig } from '../config'
import { logger } from '../logger'
import { probeMedia, AudioStream, MediaInfo, formatDuration, formatFileSize } from './probe'
import { runCommand, parseProgress } from './runner'

export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: 'normalize' | 'boost'
  boostPercent?: number
  status: 'queued' | 'analyzing' | 'processing' | 'finalizing' | 'complete' | 'error' | 'cancelled'
  progress: number
  message: string
  startedAt?: number
  completedAt?: number
  error?: string
  mediaInfo?: MediaInfo
  outputSize?: number
  inputSize?: number
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
  return title.replace(/\[molexAudio[^\]]*\]\s*/g, '').trim()
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
  config: AppConfig
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

  const { promise } = runCommand(ffmpegPath, args)
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
      task.message = `Analyzing stream ${i + 1}/${info.audioStreams.length}...`
      task.progress = Math.round(((i) / info.audioStreams.length) * 30)
      onProgress(task)

      if (abortSignal?.signal.aborted) {
        task.status = 'cancelled'
        task.message = 'Cancelled'
        onProgress(task)
        return task
      }

      const m = await analyzeLoudness(ffmpegPath, task.filePath, i, config)
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
      const newTitle = `[molexAudio Normalized] ${cleanTitle}`
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
      const newTitle = `[molexAudio Boosted ${sign}${boostPercent}%] ${cleanTitle}`
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
      const i = index++
      const task = tasks[i]
      task.message = `Queued (${i + 1}/${total})`
      onProgress(task)

      let result: ProcessingTask
      if (task.operation === 'normalize') {
        result = await normalizeFile(task, onProgress, abortSignal)
      } else {
        result = await boostFile(task, onProgress, abortSignal)
      }
      results.push(result)
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, total) }, () => worker())
  await Promise.all(workers)

  const succeeded = results.filter((r) => r.status === 'complete').length
  const failed = results.filter((r) => r.status === 'error').length
  logger.info(`Batch complete: ${succeeded} succeeded, ${failed} failed, ${total - succeeded - failed} other`)

  return results
}
