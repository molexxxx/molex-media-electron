/**
 * @module main/ffmpeg/processor/extract
 * @description Multi-mode media extraction.
 *
 * `extractAudio` is the single public entry point. Despite the legacy name
 * (kept for backwards compatibility with the renderer dispatcher and the
 * full test suite), it actually drives FIVE extraction modes selected via
 * `task.extractOptions.mode`:
 *
 *   1. **audio**     — demux/transcode an audio stream to a standalone
 *                       container (MP3, AAC, M4A, FLAC, WAV, Ogg, Opus).
 *   2. **video**     — strip audio, keep the video track. Stream copy
 *                       by default; optional H.264 re-encode.
 *   3. **gif**       — render a clip to an optimized GIF using the
 *                       two-step palettegen + paletteuse pipeline.
 *   4. **frames**    — export still frames at an interval, target fps,
 *                       evenly-spaced count, or a single thumbnail.
 *   5. **subtitles** — pull an embedded subtitle stream to .srt / .vtt /
 *                       .ass.
 *
 * When `mode` is omitted the legacy audio path runs unchanged, so all
 * pre-revamp tasks and tests behave identically.
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
  type ExtractOptions,
  cleanupTemp,
  formatElapsed,
  extractFFmpegError,
  ensureDir,
  validateOutput
} from './types'

/** Output container extension → FFmpeg audio encoder. */
const AUDIO_CODEC_MAP: Record<string, string> = {
  mp3: 'libmp3lame', aac: 'aac', flac: 'flac', wav: 'pcm_s16le',
  ogg: 'libvorbis', opus: 'libopus', m4a: 'aac'
}

/** Output container extension → FFmpeg subtitle encoder. */
const SUBTITLE_CODEC_MAP: Record<string, string> = {
  srt: 'srt', vtt: 'webvtt', ass: 'ass', ssa: 'ass'
}

/**
 * Extract a media stream (audio / video / gif / frames / subtitles)
 * from a source file. Branches internally on `extractOptions.mode`.
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
  if (!ffmpegPath) {
    task.status = 'error'
    task.error = 'FFmpeg not configured'
    onProgress(task)
    return task
  }

  const opts: ExtractOptions = task.extractOptions || { outputFormat: 'mp3', streamIndex: 0 }
  const mode = opts.mode || 'audio'

  task.status = 'analyzing'
  task.startedAt = Date.now()
  task.message = 'Analyzing media...'
  onProgress(task)

  try {
    const info = await probeMedia(task.filePath)
    task.mediaInfo = info
    task.inputSize = parseInt(info.format.size, 10) || 0
    const totalDuration = parseFloat(info.format.duration) || 0

    // Per-mode stream availability checks.
    if (mode === 'audio') {
      if (info.audioStreams.length === 0) throw new Error('No audio streams found')
      if (opts.streamIndex >= info.audioStreams.length) {
        throw new Error(`Audio stream ${opts.streamIndex} not found (file has ${info.audioStreams.length} audio stream${info.audioStreams.length === 1 ? '' : 's'})`)
      }
    } else if (mode === 'video' || mode === 'gif' || mode === 'frames') {
      if (info.videoStreams.length === 0) throw new Error('No video streams found')
    } else if (mode === 'subtitles') {
      if (info.subtitleStreams.length === 0) throw new Error('No subtitle streams found')
      if (opts.streamIndex >= info.subtitleStreams.length) {
        throw new Error(`Subtitle stream ${opts.streamIndex} not found (file has ${info.subtitleStreams.length} subtitle stream${info.subtitleStreams.length === 1 ? '' : 's'})`)
      }
    }

    const outDir = task.outputDir || config.outputDirectory || path.dirname(task.filePath)
    ensureDir(outDir)
    const baseName = path.basename(task.filePath, path.extname(task.filePath))

    // Build args + output path per mode.
    let args: string[]
    let outPath: string
    let isFrameSequence = false

    if (mode === 'audio') {
      outPath = path.join(outDir, `${baseName}_audio.${opts.outputFormat}`)
      args = buildAudioArgs(task.filePath, outPath, opts, config.audioBitrate)
      logger.info(`Extracting audio: ${task.fileName} stream ${opts.streamIndex} → .${opts.outputFormat}`)
      task.message = `Extracting audio to ${opts.outputFormat.toUpperCase()}...`
    } else if (mode === 'video') {
      const ext = opts.outputFormat || 'mp4'
      outPath = path.join(outDir, `${baseName}_video.${ext}`)
      args = buildVideoArgs(task.filePath, outPath, opts)
      logger.info(`Extracting silent video: ${task.fileName} → .${ext}${opts.videoReencode ? ' (H.264 re-encode)' : ' (stream copy)'}`)
      task.message = opts.videoReencode ? 'Re-encoding video (no audio)...' : 'Stream-copying video (no audio)...'
    } else if (mode === 'gif') {
      outPath = path.join(outDir, `${baseName}.gif`)
      args = buildGifArgs(task.filePath, outPath, opts)
      logger.info(`Generating GIF: ${task.fileName} → .gif @ ${opts.gifFps || 12}fps, width ${opts.gifWidth || 'source'}`)
      task.message = 'Generating optimized GIF (palettegen + paletteuse)...'
    } else if (mode === 'frames') {
      const fmt = opts.frameFormat || 'png'
      isFrameSequence = (opts.framesMode || 'interval') !== 'thumbnail'
      if (isFrameSequence) {
        const framesDir = path.join(outDir, `${baseName}_frames`)
        ensureDir(framesDir)
        outPath = path.join(framesDir, `frame_%04d.${fmt}`)
      } else {
        outPath = path.join(outDir, `${baseName}_thumb.${fmt}`)
      }
      args = buildFramesArgs(task.filePath, outPath, opts, totalDuration)
      logger.info(`Extracting frames: ${task.fileName} → ${path.basename(outPath)} (${opts.framesMode || 'interval'})`)
      task.message = `Extracting frames (${opts.framesMode || 'interval'})...`
    } else {
      // subtitles
      const ext = opts.outputFormat || 'srt'
      outPath = path.join(outDir, `${baseName}.${ext}`)
      args = buildSubtitleArgs(task.filePath, outPath, opts)
      logger.info(`Extracting subtitles: ${task.fileName} stream ${opts.streamIndex} → .${ext}`)
      task.message = `Extracting subtitles to ${ext.toUpperCase()}...`
    }

    task.status = 'processing'
    task.progress = 5
    onProgress(task)

    const { promise, process: proc } = runCommand(ffmpegPath, args, (line) => {
      const progress = parseProgress(line)
      if (progress && totalDuration > 0) {
        const pct = Math.min(95, 5 + Math.round((progress.time / totalDuration) * 90))
        task.progress = pct
        task.message = `Extracting... ${formatDuration(progress.time)} / ${formatDuration(totalDuration)} ${progress.speed ? `@ ${progress.speed}` : ''}`
        onProgress(task)
      }
    })

    if (abortSignal) abortSignal.signal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })
    const result = await promise

    if (result.killed || abortSignal?.signal.aborted) {
      cleanupTemp(outPath)
      task.status = 'cancelled'
      task.message = 'Cancelled'
      onProgress(task)
      return task
    }
    if (result.code !== 0) {
      cleanupTemp(outPath)
      const reason = extractFFmpegError(result.stderr)
      logger.ffmpeg('ERROR', result.stderr.slice(-1500))
      throw new Error(`Extraction failed: ${reason}`)
    }

    task.status = 'complete'
    task.progress = 100
    task.completedAt = Date.now()

    if (isFrameSequence) {
      // Frame sequences: report directory + frame count instead of a single file.
      const framesDir = path.dirname(outPath)
      task.outputPath = framesDir
      let frameCount = 0
      let totalSize = 0
      try {
        const entries = fs.readdirSync(framesDir).filter((f) => f.startsWith('frame_'))
        frameCount = entries.length
        for (const f of entries) {
          try { totalSize += fs.statSync(path.join(framesDir, f)).size } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      task.outputSize = totalSize
      task.message = `Extracted ${frameCount} frame${frameCount === 1 ? '' : 's'} in ${formatElapsed(task.startedAt!, task.completedAt)}`
      logger.success(`Extracted: ${task.fileName} → ${frameCount} frames (${formatFileSize(totalSize)})`)
    } else {
      task.outputPath = outPath
      validateOutput(outPath, 'Extraction')
      task.outputSize = fs.statSync(outPath).size
      const label = mode === 'audio' ? 'audio'
        : mode === 'video' ? 'silent video'
        : mode === 'gif' ? 'GIF'
        : mode === 'subtitles' ? 'subtitles'
        : 'frame'
      task.message = `Extracted ${label} in ${formatElapsed(task.startedAt!, task.completedAt)}`
      logger.success(`Extracted: ${task.fileName} → ${path.basename(outPath)} (${formatFileSize(task.outputSize)})`)
    }
    onProgress(task)
    return task
  } catch (err: any) {
    task.status = 'error'
    task.error = err.message
    task.message = `Error: ${err.message}`
    task.completedAt = Date.now()
    logger.error(`Failed to extract from ${task.fileName}: ${err.message}`)
    onProgress(task)
    return task
  }
}

/* ------------------------------------------------------------------ */
/*  Per-mode arg builders                                             */
/* ------------------------------------------------------------------ */

/**
 * Build FFmpeg args for the legacy audio extraction path.
 * Argument order is preserved exactly to keep the existing test suite green.
 */
function buildAudioArgs(
  input: string,
  output: string,
  opts: ExtractOptions,
  defaultBitrate: string
): string[] {
  const codec = AUDIO_CODEC_MAP[opts.outputFormat] || 'copy'
  const args = ['-y', '-i', input, '-threads', '0', '-vn', '-map', `0:a:${opts.streamIndex}`, '-c:a', codec]
  if (codec !== 'copy' && codec !== 'pcm_s16le' && codec !== 'flac') {
    args.push('-b:a', opts.audioBitrate || defaultBitrate)
  }
  if (opts.sampleRate) args.push('-ar', opts.sampleRate)
  if (opts.channels === 'mono') args.push('-ac', '1')
  else if (opts.channels === 'stereo') args.push('-ac', '2')
  args.push(output)
  return args
}

/**
 * Build FFmpeg args for a silent video extraction. Strips all audio
 * streams (`-an`) and either stream-copies the video or re-encodes
 * with H.264 at the supplied CRF.
 */
function buildVideoArgs(input: string, output: string, opts: ExtractOptions): string[] {
  const args = ['-y']
  applyTimeRange(args, opts)
  args.push('-i', input, '-threads', '0', '-map', '0:v:0', '-an')
  if (opts.videoReencode) {
    const crf = clampInt(opts.videoCrf, 0, 51, 20)
    args.push('-c:v', 'libx264', '-crf', String(crf), '-preset', 'medium', '-pix_fmt', 'yuv420p')
  } else {
    args.push('-c:v', 'copy')
  }
  args.push(output)
  return args
}

/**
 * Build FFmpeg args for GIF rendering via the recommended
 * palettegen → paletteuse pipeline. Runs in a single invocation
 * using `split` to share the scaled stream between the palette
 * generator and the palette consumer.
 */
function buildGifArgs(input: string, output: string, opts: ExtractOptions): string[] {
  const fps = clampInt(opts.gifFps, 1, 60, 12)
  const width = Math.max(0, Math.floor(opts.gifWidth ?? 480))
  const dither = opts.gifDither || 'sierra2_4a'
  const loop = opts.gifLoop != null ? opts.gifLoop : 0
  const scaleExpr = width > 0 ? `scale=${width}:-1:flags=lanczos` : `scale=iw:-1:flags=lanczos`
  const filter =
    `fps=${fps},${scaleExpr},split [a][b];` +
    `[a] palettegen=stats_mode=diff [p];` +
    `[b][p] paletteuse=dither=${dither}`
  const args = ['-y']
  applyTimeRange(args, opts)
  args.push('-i', input, '-threads', '0', '-filter_complex', filter, '-loop', String(loop), output)
  return args
}

/**
 * Build FFmpeg args for still-frame extraction. Supports four sampling
 * strategies via `framesMode`:
 *
 * - `interval`  — one frame every `frameInterval` seconds (default 1s).
 * - `fps`       — output at `framesFps` frames per second.
 * - `count`     — N evenly-spaced frames across the full duration.
 * - `thumbnail` — single frame near the midpoint of the clip.
 */
function buildFramesArgs(
  input: string,
  output: string,
  opts: ExtractOptions,
  totalDuration: number
): string[] {
  const mode = opts.framesMode || 'interval'
  const args = ['-y']
  let videoFilter = ''

  if (mode === 'thumbnail') {
    const seek = totalDuration > 0 ? totalDuration / 2 : 1
    args.push('-ss', String(seek), '-i', input, '-frames:v', '1', '-q:v', String(clampInt(opts.jpgQuality, 2, 31, 2)))
  } else if (mode === 'fps') {
    applyTimeRange(args, opts)
    args.push('-i', input)
    const fps = Math.max(0.01, opts.framesFps ?? 1)
    videoFilter = `fps=${fps}`
  } else if (mode === 'count') {
    applyTimeRange(args, opts)
    args.push('-i', input)
    const count = clampInt(opts.frameCount, 1, 1000, 25)
    // Use thumbnail filter to find best frames within evenly-sized bins.
    // We approximate by spacing the count over the duration: fps = count / duration.
    const dur = totalDuration > 0 ? totalDuration : 1
    const fps = count / dur
    videoFilter = `fps=${fps}`
  } else {
    // interval
    applyTimeRange(args, opts)
    args.push('-i', input)
    const interval = Math.max(0.05, opts.frameInterval ?? 1)
    videoFilter = `fps=1/${interval}`
  }

  if (videoFilter) args.push('-vf', videoFilter)

  // Apply jpg quality (-q:v) for jpg/mjpeg outputs.
  if ((opts.frameFormat || 'png') === 'jpg' && mode !== 'thumbnail') {
    args.push('-q:v', String(clampInt(opts.jpgQuality, 2, 31, 3)))
  }

  args.push('-threads', '0', output)
  return args
}

/**
 * Build FFmpeg args for subtitle extraction. Uses the appropriate
 * subtitle encoder for the target container; falls back to stream copy
 * when the output extension is unknown.
 */
function buildSubtitleArgs(input: string, output: string, opts: ExtractOptions): string[] {
  const codec = SUBTITLE_CODEC_MAP[opts.outputFormat] || 'copy'
  return ['-y', '-i', input, '-map', `0:s:${opts.streamIndex}`, '-c:s', codec, output]
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Append `-ss` (start) and `-t` (duration) flags to `args` *before*
 * the input is appended. FFmpeg treats `-ss` as fast keyframe seek
 * when placed before `-i`, which is the right default for everything
 * but frame-accurate cuts.
 */
function applyTimeRange(args: string[], opts: ExtractOptions): void {
  if (opts.startTime && opts.startTime.trim()) args.push('-ss', opts.startTime.trim())
  if (opts.duration && opts.duration.trim()) args.push('-t', opts.duration.trim())
}

/** Clamp `v` to [min, max], falling back to `fallback` if missing/NaN. */
function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && !Number.isNaN(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}
