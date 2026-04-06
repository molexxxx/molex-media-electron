/**
 * @module main/ffmpeg/processor/convert
 * @description Media format conversion.
 *
 * Converts a file from one container / codec combination to another
 * using user-specified video codec, audio codec, bitrate, resolution,
 * and framerate options.  Supports both stream-copy and re-encode modes.
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
  cleanupTemp,
  formatElapsed
} from './types'

/**
 * Convert a media file to a different format / codec.
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
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
