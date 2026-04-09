/**
 * @module main/ffmpeg/processor/compress
 * @description Media file compression.
 *
 * Compresses video files using CRF-based H.264 encoding with optional
 * target-size bitrate limiting, and audio-only files using AAC or FLAC.
 * Supports four quality presets: lossless, high, medium, and low.
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
  createTempPath,
  cleanupTemp,
  formatElapsed,
  extractFFmpegError,
  safeRename,
  ensureDir,
  validateOutput
} from './types'
import {
  resolveGpuCodec,
  getHwaccelInputArgs,
  getGpuPreset,
  getGpuQualityArgs,
  type GpuMode
} from '../gpu'

/**
 * Compress a media file using quality-preset or target-size encoding.
 *
 * For video files the encoder is `libx264` with CRF quality control.
 * When a target size (MB) is provided, a constrained bitrate is
 * calculated instead.  Audio-only files are compressed with AAC (lossy)
 * or FLAC (lossless preset).
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
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

    const softwareCodec = opts.videoCodec || 'libx264'
    const speed = opts.speed || (opts.quality === 'lossless' ? 'veryslow' : 'medium')
    const gpuMode = (config.gpuAcceleration || 'off') as GpuMode

    // Resolve GPU codec (auto-detect if needed)
    const gpuResult = info.isVideoFile
      ? await resolveGpuCodec(ffmpegPath, softwareCodec, gpuMode)
      : { codec: softwareCodec, activeMode: 'off' as GpuMode, isGpu: false }
    const codec = gpuResult.codec

    if (gpuResult.isGpu) {
      logger.info(`[compress] Using GPU encoder: ${codec} (${gpuResult.activeMode})`)
    }

    /** Quality preset → CRF value per codec. */
    const CRF_MAP: Record<string, Record<string, number>> = {
      libx264:        { lossless: 0, high: 18, medium: 23, low: 28 },
      libx265:        { lossless: 0, high: 22, medium: 28, low: 33 },
      'libvpx-vp9':   { lossless: 0, high: 24, medium: 31, low: 38 },
      'libaom-av1':   { lossless: 0, high: 22, medium: 28, low: 35 },
    }
    const crfTable = CRF_MAP[softwareCodec] || CRF_MAP.libx264
    const crf = crfTable[opts.quality] ?? 23

    // Build args - hwaccel input flags come before -i
    const hwaccelArgs = getHwaccelInputArgs(gpuResult.activeMode, false)
    const args = ['-y', ...hwaccelArgs, '-i', task.filePath, '-threads', '0']

    if (info.isVideoFile) {
      args.push('-c:v', codec)

      // Encoding speed / quality trade-off (GPU-aware)
      if (gpuResult.isGpu) {
        args.push(...getGpuPreset(gpuResult.activeMode, speed))
      } else if (codec === 'libx264' || codec === 'libx265') {
        args.push('-preset', speed)
      } else if (codec === 'libvpx-vp9') {
        const cpuMap: Record<string, string> = { veryslow: '0', slow: '1', medium: '2', fast: '4', veryfast: '5' }
        args.push('-cpu-used', cpuMap[speed] || '2')
      } else if (codec === 'libaom-av1') {
        const cpuMap: Record<string, string> = { veryslow: '1', slow: '2', medium: '4', fast: '6', veryfast: '8' }
        args.push('-cpu-used', cpuMap[speed] || '4')
      }

      // Quality parameter (GPU-aware)
      if (gpuResult.isGpu) {
        args.push(...getGpuQualityArgs(gpuResult.activeMode, crf))
      } else {
        args.push('-crf', String(crf))
      }

      // VP9 needs -b:v 0 for CRF-only mode
      if (codec === 'libvpx-vp9') args.push('-b:v', '0')

      if (opts.targetSizeMB > 0 && totalDuration > 0) {
        const targetBits = opts.targetSizeMB * 8 * 1024 * 1024
        const audioBitrate = 128000
        const videoBitrate = Math.max(100000, Math.floor((targetBits / totalDuration) - audioBitrate))
        args.length = 5 // reset after -threads 0
        args.push('-c:v', codec, '-b:v', String(videoBitrate), '-maxrate', String(videoBitrate * 2), '-bufsize', String(videoBitrate * 4))
      }
      const abr = opts.audioBitrate || (opts.quality === 'low' ? '128k' : '256k')
      args.push('-c:a', 'aac', '-b:a', abr)
    } else {
      // Audio-only compression
      const audioBitrates: Record<string, string> = { lossless: '0', high: '256k', medium: '192k', low: '128k' }
      const abr = opts.audioBitrate || audioBitrates[opts.quality] || '192k'
      if (opts.quality === 'lossless') {
        args.push('-c:a', 'flac')
      } else {
        args.push('-c:a', 'aac', '-b:a', abr)
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

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) { cleanupTemp(tempPath); task.status = 'cancelled'; task.message = 'Cancelled'; onProgress(task); return task }
    if (result.code !== 0) {
      cleanupTemp(tempPath)
      const reason = extractFFmpegError(result.stderr)
      logger.ffmpeg('ERROR', result.stderr.slice(-1500))
      throw new Error(`Compression failed: ${reason}`)
    }

    task.status = 'finalizing'
    task.message = 'Finalizing...'
    task.progress = 96
    onProgress(task)

    validateOutput(tempPath, 'Compression')

    if (config.afterProcessing === 'replace') {
      fs.unlinkSync(task.filePath)
      fs.renameSync(tempPath, task.filePath)
      task.outputPath = task.filePath
    } else {
      const outDir = task.outputDir || config.outputDirectory || path.dirname(task.filePath)
      ensureDir(outDir)
      const outPath = path.join(outDir, `compressed_${path.basename(task.filePath)}`)
      safeRename(tempPath, outPath)
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
