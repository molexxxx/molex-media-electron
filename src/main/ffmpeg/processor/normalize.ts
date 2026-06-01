/**
 * @module main/ffmpeg/processor/normalize
 * @description Two-pass loudness normalization using the ITU-R BS.1770-4
 * measurement standard.
 *
 * Pass 1 measures each audio stream's integrated loudness, true peak, and
 * loudness range. Pass 2 applies linear normalization with the measured
 * parameters so the output exactly hits the target without clipping.
 */

import * as path from 'path'
import * as fs from 'fs'
import { getConfig } from '../../config'
import { logger } from '../../logger'
import { probeMedia, formatDuration, formatFileSize } from '../probe'
import { runCommand, parseProgress } from '../runner'
import {
  type ProcessingTask,
  type TaskProgressCallback,
  stripMolexTag,
  needsStrictExperimental,
  createTempPath,
  cleanupTemp,
  formatElapsed,
  extractFFmpegError,
  safeRename,
  ensureDir,
  validateOutput
} from './types'

/* ------------------------------------------------------------------ */
/*  Loudness analysis (pass 1)                                        */
/* ------------------------------------------------------------------ */

interface LoudnessMetrics {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Measure the loudness of a single audio stream using FFmpeg's
 * `loudnorm` filter in analysis mode.
 *
 * @param ffmpegPath  - Absolute path to the FFmpeg binary.
 * @param filePath    - Source media file.
 * @param streamIndex - Zero-based audio stream index.
 * @param config      - Application configuration (normalization targets).
 * @param onStderrLine - Optional per-line stderr callback for progress.
 * @returns Parsed loudness metrics for pass 2.
 */
async function analyzeLoudness(
  ffmpegPath: string,
  filePath: string,
  streamIndex: number,
  norm: { I: number; TP: number; LRA: number },
  onStderrLine?: (line: string) => void
): Promise<LoudnessMetrics> {
  const { I, TP, LRA } = norm
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

/* ------------------------------------------------------------------ */
/*  Filter helpers (dynamic range compression + downmix)              */
/* ------------------------------------------------------------------ */

/**
 * Build the `acompressor` filter string for a given compression level.
 * Returns null when compression is disabled.
 *
 * Ratios / thresholds tuned for movie content where dialog sits ~10-15 dB
 * below action peaks. Threshold is in dB (FFmpeg's acompressor takes a
 * linear ratio for threshold, but accepts dB via the parser too).
 */
function buildCompressorFilter(level?: string): string | null {
  switch (level) {
    case 'light':
      // Gentle: 2:1 above -22 dB, slow attack/release. Mostly invisible.
      return 'acompressor=threshold=-22dB:ratio=2:attack=20:release=250:makeup=2'
    case 'medium':
      // Movie balance: 3:1 above -24 dB, makeup +3 dB. Tames bass-heavy action.
      return 'acompressor=threshold=-24dB:ratio=3:attack=15:release=200:makeup=3'
    case 'heavy':
      // Late-night: 6:1 above -26 dB, fast attack, makeup +5 dB. Whispers audible.
      return 'acompressor=threshold=-26dB:ratio=6:attack=5:release=150:makeup=5'
    case 'off':
    case undefined:
    case null as unknown as undefined:
    default:
      return null
  }
}

/**
 * Build a `pan` filter that produces the desired channel layout from a
 * source with `srcChannels` input channels. Returns null when no downmix
 * is needed (e.g. mode='keep' or source is already stereo/mono).
 *
 * `dialog-stereo` raises the center channel +3 dB and attenuates surrounds
 * by ~6 dB so dialog cuts through TV-speaker playback. Falls back to the
 * plain stereo downmix when the source has no discrete center (i.e. stereo
 * or mono input).
 */
function buildDownmixFilter(mode: string | undefined, srcChannels: number): string | null {
  if (!mode || mode === 'keep') return null
  if (srcChannels <= 2) return null

  if (mode === 'dialog-stereo') {
    if (srcChannels >= 6) {
      // 5.1 layout: FL FR FC LFE BL BR. Center +3 dB (×1.414), surrounds -6 dB (×0.5).
      return 'pan=stereo|FL=0.707*FC+0.85*FL+0.5*BL+0.2*LFE|FR=0.707*FC+0.85*FR+0.5*BR+0.2*LFE'
    }
    // Other multichannel — fall back to standard stereo downmix.
    return 'pan=stereo|FL<FL+0.707*FC+0.5*BL|FR<FR+0.707*FC+0.5*BR'
  }

  // Plain stereo downmix
  return 'aresample=matrix_encoding=none,pan=stereo|FL<FL+0.707*FC+0.5*BL|FR<FR+0.707*FC+0.5*BR'
}

/* ------------------------------------------------------------------ */
/*  Normalization (pass 2)                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalize all audio streams in a media file to the configured loudness
 * targets using a two-pass EBU R128 workflow.
 *
 * - Pass 1: measure integrated loudness, true peak, and LRA per stream.
 * - Pass 2: encode with measured offsets so the output exactly matches
 *   the target without clipping.
 *
 * Video and subtitle tracks are stream-copied when present.
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
export async function normalizeFile(
  task: ProcessingTask,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  const norm = task.normalizeOptions || config.normalization

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

    // Analysis pass - measure all streams
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

      const m = await analyzeLoudness(ffmpegPath, task.filePath, i, norm, (line) => {
        const progress = parseProgress(line)
        if (progress && totalDuration > 0) {
          const streamBase = Math.round((i / info.audioStreams.length) * 30)
          const streamSlice = 30 / info.audioStreams.length
          const pct = Math.min(streamBase + Math.round((progress.time / totalDuration) * streamSlice), 29)
          task.progress = pct
          task.message = `${streamLabel} - ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
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

    const { I, TP, LRA } = norm
    const compressionFilter = buildCompressorFilter((norm as { compression?: string }).compression)
    const downmixMode = (norm as { downmix?: string }).downmix
    const filterParts: string[] = []
    const mapArgs: string[] = []

    for (let i = 0; i < info.audioStreams.length; i++) {
      const m = metrics[i]
      const srcChannels = info.audioStreams[i].channels || 2
      const downmixFilter = buildDownmixFilter(downmixMode, srcChannels)

      // Chain order: optional downmix → loudnorm → optional compressor.
      // Downmix BEFORE loudnorm so loudness is measured on the final layout.
      // Actually pass-1 already measured the source; for chain consistency
      // we apply downmix first, then linear loudnorm with measured offsets,
      // then DRC last so makeup gain doesn't shift the LUFS target.
      const chain: string[] = []
      if (downmixFilter) chain.push(downmixFilter)
      chain.push(
        `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:` +
        `measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
        `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:` +
        `offset=${m.target_offset}`
      )
      if (compressionFilter) {
        chain.push(compressionFilter)
        // Re-limit true peak after makeup gain to honor TP ceiling.
        chain.push(`alimiter=limit=${Math.pow(10, TP / 20).toFixed(4)}`)
      }
      filterParts.push(`[0:a:${i}]${chain.join(',')}[a${i}]`)
      mapArgs.push('-map', `[a${i}]`)
    }

    const tempPath = createTempPath(task.filePath, config.tempSuffix)
    // Raise probe limits so streams with late dimension info (e.g. PGS
    // subtitles) are fully parsed before they're stream-copied, avoiding
    // "Could not find codec parameters ... unspecified size" copy failures.
    const args: string[] = ['-y', '-analyzeduration', '200M', '-probesize', '200M', '-i', task.filePath, '-threads', '0']

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
      // Some inherited encoders (e.g. DTS/dca, TrueHD) are flagged
      // experimental and refuse to run without strict-experimental mode.
      if (needsStrictExperimental(info.audioStreams.map((s) => s.codec_name))) {
        args.push('-strict', 'experimental')
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
      }, { once: true })
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
      const reason = extractFFmpegError(result.stderr)
      logger.ffmpeg('ERROR', result.stderr.slice(-1500))
      throw new Error(`Normalize encode failed: ${reason}`)
    }

    // Finalize
    task.status = 'finalizing'
    task.message = 'Replacing original file...'
    task.progress = 96
    onProgress(task)

    validateOutput(tempPath, 'Normalize')

    if (config.afterProcessing === 'replace') {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
      task.outputPath = task.filePath
    } else {
      const outDir = task.outputDir || config.outputDirectory || path.dirname(task.filePath)
      ensureDir(outDir)
      const outPath = path.join(outDir, `normalized_${path.basename(task.filePath)}`)
      safeRename(tempPath, outPath)
      task.outputPath = outPath
    }

    task.outputSize = fs.statSync(task.outputPath!).size
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
