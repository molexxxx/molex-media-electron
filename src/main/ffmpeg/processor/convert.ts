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
import { resolveGpuCodec, getHwaccelInputArgs, type GpuMode } from '../gpu'
import {
  type ProcessingTask,
  type TaskProgressCallback,
  cleanupTemp,
  formatElapsed,
  extractFFmpegError,
  ensureDir
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

    // Determine where the final file should land
    // When replacing, always output next to the original so it can be deleted
    const replaceMode = config.afterProcessing === 'replace'
    const outDir = replaceMode
      ? path.dirname(task.filePath)
      : (task.outputDir || config.outputDirectory || path.dirname(task.filePath))
    ensureDir(outDir)
    const baseName = path.basename(task.filePath, path.extname(task.filePath))
    const inputExt = path.extname(task.filePath).toLowerCase()
    const outputExt = `.${opts.outputFormat.toLowerCase()}`
    const sameDir = path.resolve(outDir) === path.resolve(path.dirname(task.filePath))
    const wouldCollide = inputExt === outputExt && sameDir

    let finalPath: string
    if (wouldCollide && replaceMode) {
      // Same format, same dir, overwrite: final IS the original path
      finalPath = task.filePath
    } else if (wouldCollide) {
      // Same format, same dir, no overwrite: add suffix
      finalPath = path.join(outDir, `${baseName}_converted.${opts.outputFormat}`)
    } else {
      finalPath = path.join(outDir, `${baseName}.${opts.outputFormat}`)
    }

    // FFmpeg cannot write to the same path it reads from - always use a temp file
    const tempPath = path.join(outDir, `${baseName}_converting_${Date.now()}.${opts.outputFormat}`)

    const args: string[] = ['-y']

    // GPU acceleration for decoding (only when re-encoding video, no complex filters)
    const gpuMode = (config.gpuAcceleration || 'off') as GpuMode
    const hasFilterComplex = !!opts.resolution // scale filter means software pixel formats
    let activeGpuMode: GpuMode = 'off'

    if (info.isVideoFile && opts.videoCodec !== 'copy') {
      const gpuResult = await resolveGpuCodec(ffmpegPath, opts.videoCodec, gpuMode)
      activeGpuMode = gpuResult.activeMode
      const hwArgs = getHwaccelInputArgs(activeGpuMode, hasFilterComplex)
      args.push(...hwArgs)
    }

    args.push('-i', task.filePath, '-threads', '0')

    // Video codec
    if (info.isVideoFile) {
      if (opts.videoCodec === 'copy') {
        args.push('-c:v', 'copy')
      } else {
        const gpuResult = await resolveGpuCodec(ffmpegPath, opts.videoCodec, gpuMode)
        args.push('-c:v', gpuResult.codec)
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

    args.push(tempPath)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
        task.progress = pct
        task.message = `Converting... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) { cleanupTemp(tempPath); task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task }
    if (result.code !== 0) {
      cleanupTemp(tempPath)
      const reason = extractFFmpegError(result.stderr)
      logger.ffmpeg('ERROR', result.stderr.slice(-1500))
      throw new Error(`Convert failed: ${reason}`)
    }

    // Validate temp output before placing it
    const tempStat = fs.statSync(tempPath)
    if (tempStat.size === 0) {
      cleanupTemp(tempPath)
      throw new Error('Convert produced an empty file')
    }

    // Swap temp into final location
    if (path.resolve(finalPath) === path.resolve(task.filePath)) {
      // Same path (same format overwrite): delete original first
      fs.unlinkSync(task.filePath)
    } else if (replaceMode && inputExt !== outputExt) {
      // Cross-format replace: delete the old file (different extension)
      fs.unlinkSync(task.filePath)
    }
    fs.renameSync(tempPath, finalPath)

    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()
    task.outputPath = finalPath
    task.outputSize = fs.statSync(finalPath).size
    task.message = `Converted to ${opts.outputFormat.toUpperCase()} in ${formatElapsed(task.startedAt!, task.completedAt)}`
    logger.success(`Converted: ${task.fileName} → ${path.basename(finalPath)} (${formatFileSize(task.inputSize!)} → ${formatFileSize(task.outputSize)})`)
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'; task.error = err.message; task.message = `Error: ${err.message}`; task.completedAt = Date.now()
    logger.error(`Failed to convert ${task.fileName}: ${err.message}`); onProgress(task); return task
  }
}
