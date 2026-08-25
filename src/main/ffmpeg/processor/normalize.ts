/**
 * @module main/ffmpeg/processor/normalize
 * @description Two-pass loudness normalization using the ITU-R BS.1770-4
 * measurement standard.
 *
 * Pass 1 measures each audio stream's integrated loudness, true peak, and
 * loudness range through the same pre-filters pass 2 will use, so the
 * measurement describes the signal that actually gets normalized. Pass 2
 * feeds those measurements back to `loudnorm`, which scales the programme
 * linearly when the measurement allows it and falls back to dynamic mode
 * when it doesn't.
 */

import * as path from 'path'
import * as fs from 'fs'
import { getConfig } from '../../config'
import { logger } from '../../logger'
import { probeMedia, formatDuration, formatFileSize } from '../probe'
import { runCommand, parseProgress } from '../runner'
import {
  type NormalizeSpec,
  type LoudnessMeasurement,
  buildAnalysisChain,
  buildLoudnormChain,
  predictsLinearNormalization
} from './audio-filters'
import {
  type ProcessingTask,
  type TaskProgressCallback,
  stripMolexTag,
  needsStrictExperimental,
  resolveInheritedAudioEncoder,
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

type LoudnessMetrics = LoudnessMeasurement & { normalization_type?: string }

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
  norm: NormalizeSpec,
  srcChannels: number,
  onStderrLine?: (line: string) => void
): Promise<LoudnessMetrics> {
  // The analysis chain must match the encode chain up to `loudnorm`,
  // otherwise the measurement describes a different signal than the one
  // pass 2 normalizes and the output misses the target.
  const chain = buildAnalysisChain(norm, { channels: srcChannels })
  const args = [
    '-i', filePath,
    '-threads', '0',
    '-map', `0:a:${streamIndex}`,
    '-af', chain.join(','),
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
    target_offset: metrics.target_offset,
    normalization_type: metrics.normalization_type
  }
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

      const m = await analyzeLoudness(ffmpegPath, task.filePath, i, norm, info.audioStreams[i].channels || 2, (line) => {
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

    const filterParts: string[] = []
    const mapArgs: string[] = []

    for (let i = 0; i < info.audioStreams.length; i++) {
      const m = metrics[i]
      const stream = info.audioStreams[i]

      // A stream reverts to dynamic mode - reshaping the programme rather
      // than scaling it - when the measurement doesn't satisfy loudnorm's
      // linear conditions. Pass 1 can't report this (it is always dynamic),
      // so derive it and surface it instead of claiming linear normalization.
      if (!predictsLinearNormalization(norm, m)) {
        logger.warn(
          `Stream ${i} of ${task.fileName}: loudnorm will use dynamic mode ` +
          `(measured I=${m.input_i} TP=${m.input_tp} LRA=${m.input_lra}; ` +
          `target I=${norm.I} TP=${norm.TP} LRA=${norm.LRA})`
        )
      }

      const chain = buildLoudnormChain(
        norm,
        { channels: stream.channels || 2, sampleRate: stream.sample_rate || '48000' },
        m
      )
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
      const chosen: string[] = []
      for (let i = 0; i < info.audioStreams.length; i++) {
        const stream = info.audioStreams[i]
        const { codec, bitrate } = resolveInheritedAudioEncoder(
          stream.codec_name,
          stream.channels || 2,
          config.fallbackCodec,
          config.audioBitrate
        )
        chosen.push(codec)
        args.push(`-c:a:${i}`, codec, `-b:a:${i}`, bitrate)
      }
      // In case any chosen encoder is still flagged experimental.
      if (needsStrictExperimental(chosen)) {
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
