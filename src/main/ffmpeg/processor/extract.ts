/**
 * @module main/ffmpeg/processor/extract
 * @description Audio extraction from video files.
 *
 * Demuxes and optionally re-encodes a single audio stream from a
 * video container into a standalone audio file.  Supports MP3, AAC,
 * FLAC, WAV, Ogg Vorbis, Opus, and M4A output formats.
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
 * Extract a single audio stream from a media file and write it to a
 * new audio-only container.
 *
 * @param task        - The processing task (mutated with status updates).
 * @param onProgress  - Callback invoked on every status / progress change.
 * @param abortSignal - Optional abort controller for cancellation.
 * @returns The completed (or errored / cancelled) task.
 */
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

    const outDir = task.outputDir || config.outputDirectory || path.dirname(task.filePath)
    const baseName = path.basename(task.filePath, path.extname(task.filePath))
    const outPath = path.join(outDir, `${baseName}_audio.${opts.outputFormat}`)

    /** Maps output extension → FFmpeg encoder name. */
    const codecMap: Record<string, string> = { mp3: 'libmp3lame', aac: 'aac', flac: 'flac', wav: 'pcm_s16le', ogg: 'libvorbis', opus: 'libopus', m4a: 'aac' }
    const codec = codecMap[opts.outputFormat] || 'copy'

    const args = ['-y', '-i', task.filePath, '-threads', '0', '-vn', '-map', `0:a:${opts.streamIndex}`, '-c:a', codec]
    if (codec !== 'copy' && codec !== 'pcm_s16le' && codec !== 'flac') {
      args.push('-b:a', opts.audioBitrate || config.audioBitrate)
    }
    if (opts.sampleRate) args.push('-ar', opts.sampleRate)
    if (opts.channels === 'mono') args.push('-ac', '1')
    else if (opts.channels === 'stereo') args.push('-ac', '2')
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
