/**
 * @module main/ffmpeg/processor/boost
 * @description Volume boost processor.
 *
 * Applies a percentage-based volume multiplier to every audio stream in
 * the file using FFmpeg's `volume` filter.  Re-encodes audio while
 * stream-copying video and subtitle tracks.
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
  channelLayout,
  stripMolexTag,
  createTempPath,
  cleanupTemp,
  formatElapsed
} from './types'

/**
 * Boost or attenuate the volume of all audio streams by a percentage.
 *
 * A value of `+50` increases volume by 50 %; a value of `-20` decreases
 * it by 20 %. Each stream is reformatted to its native sample rate and
 * channel layout before the volume filter is applied.
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
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
