/**
 * @module main/ffmpeg/processor/types
 * @description Shared types, constants, and utility helpers for the processing pipeline.
 *
 * All batch operation modules import their task structure and common
 * helpers (temp-path generation, metadata tag stripping, channel layout
 * mapping, elapsed-time formatting) from this single source of truth.
 */

import * as path from 'path'
import * as fs from 'fs'
import { type MediaInfo } from '../probe'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A single file queued for processing. */
export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: 'normalize' | 'boost' | 'convert' | 'extract' | 'compress'
  boostPercent?: number
  /**
   * Advanced volume-boost knobs. When omitted the pipeline falls back to
   * the simple `volume=<multiplier>` filter (legacy behaviour).
   *
   * - `limiter`: when true, append `alimiter` after the volume stage so
   *   peaks don't clip. Required for any aggressive positive gain.
   * - `limiterCeiling`: dBTP ceiling for the limiter. Typically -1.
   * - `hpfHz`: high-pass cutoff applied BEFORE the volume stage. 0 = off.
   *   Removes sub-audible energy that would otherwise consume headroom.
   */
  boostOptions?: {
    limiter?: boolean
    limiterCeiling?: number
    hpfHz?: number
  }
  preset?: string
  normalizeOptions?: {
    I: number
    TP: number
    LRA: number
    /** 'off' | 'light' | 'medium' | 'heavy' — post-loudnorm dynamic range compression. */
    compression?: 'off' | 'light' | 'medium' | 'heavy'
    /** 'keep' | 'stereo' | 'dialog-stereo' — channel layout strategy. */
    downmix?: 'keep' | 'stereo' | 'dialog-stereo'
  }
  convertOptions?: ConvertOptions
  extractOptions?: ExtractOptions
  compressOptions?: CompressOptions
  outputDir?: string
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

export interface ConvertOptions {
  outputFormat: string
  videoCodec: string
  audioCodec: string
  videoBitrate: string
  audioBitrate: string
  resolution: string
  framerate: string
}

export interface ExtractOptions {
  /**
   * Extraction mode.
   * - `audio` (default): demux/transcode an audio stream into a standalone file.
   * - `video`: strip audio, keep the video track. Stream copy or re-encode.
   * - `gif`: render a section of video to an optimized GIF via the two-step
   *   palettegen + paletteuse method.
   * - `frames`: extract still frames (PNG/JPG/WebP) at an interval, fps, or
   *   single thumbnail.
   * - `subtitles`: extract an embedded subtitle stream to .srt/.vtt/.ass.
   *
   * When `mode` is omitted, callers receive the legacy audio-only path so
   * existing tasks remain compatible.
   */
  mode?: 'audio' | 'video' | 'gif' | 'frames' | 'subtitles'
  outputFormat: string
  /** Index into the chosen stream kind (audio: 0..N audio, subs: 0..N subs). */
  streamIndex: number
  /* ---- Audio ---- */
  audioBitrate?: string
  sampleRate?: string
  channels?: string
  /* ---- Video (silent extraction) ---- */
  /** Re-encode using H.264 instead of stream-copying the source video. */
  videoReencode?: boolean
  /** CRF used when videoReencode is true. */
  videoCrf?: number
  /* ---- GIF ---- */
  /** GIF frame rate (1–30). */
  gifFps?: number
  /** Output width in pixels. 0 keeps source width. */
  gifWidth?: number
  /** Dithering algorithm passed to paletteuse. */
  gifDither?: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
  /** Loop count for the GIF. 0 = infinite, -1 = play once, N = N loops. */
  gifLoop?: number
  /* ---- Frames ---- */
  /** How the frames mode samples the source. */
  framesMode?: 'interval' | 'fps' | 'thumbnail' | 'count'
  /** Seconds between frames when framesMode === 'interval'. */
  frameInterval?: number
  /** Output frames per second when framesMode === 'fps'. */
  framesFps?: number
  /** Total number of evenly-spaced frames when framesMode === 'count'. */
  frameCount?: number
  /** Output image format. Default 'png'. */
  frameFormat?: 'png' | 'jpg' | 'webp'
  /** MJPEG quality scale (2 best – 31 worst) when frameFormat === 'jpg'. */
  jpgQuality?: number
  /* ---- Time range (shared by gif / frames / video) ---- */
  /** Start offset, hh:mm:ss(.ms) or plain seconds. */
  startTime?: string
  /** Clip duration, hh:mm:ss(.ms) or plain seconds. */
  duration?: string
}

export interface CompressOptions {
  /**
   * Encoding mode.
   *
   * - `crf`: quality-targeted constant rate factor. Bitrate fluctuates;
   *   visual quality stays constant. Default unless legacy targetSizeMB is
   *   set (in which case legacy behavior treats it as `target-size`).
   * - `target-size`: bitrate-constrained ABR/CBR aimed at a specific file
   *   size in MB. Optionally two-pass for better bit distribution.
   */
  mode?: 'crf' | 'target-size'

  /** Target output size in MB. Only used when mode === 'target-size'. */
  targetSizeMB: number

  /**
   * Quality tier. `lossless` maps to CRF 0 (true lossless for CPU codecs).
   * `custom` reads `customCrf` instead of the per-codec CRF table.
   */
  quality: string

  /** Custom CRF / CQ value when `quality === 'custom'`. 0–51 range. */
  customCrf?: number

  /** Video encoder: libx264 | libx265 | libvpx-vp9 | libaom-av1 | libsvtav1. */
  videoCodec?: string

  /** Encoder speed preset (or `-cpu-used` analog for VP9/AV1). */
  speed?: string

  /** Pixel format. '' = encoder default, 'yuv420p' = max compat, 'yuv420p10le' = 10-bit. */
  pixelFormat?: string

  /** Encoder tune: '' | film | animation | grain | fastdecode | zerolatency. x264/x265 only. */
  tune?: string

  /** Cap output height (downscale). 0 = no scaling. e.g. 1080 = max 1080p. */
  maxHeight?: number

  /** Use two-pass encoding (target-size mode only). Improves quality at the cost of ~2× time. */
  twoPass?: boolean

  /** Audio codec: 'aac' | 'libopus' | 'flac' | 'copy'. Defaults to aac (or flac for lossless audio-only). */
  audioCodec?: string

  /** Audio bitrate (e.g. '128k'). Ignored for flac/copy. */
  audioBitrate?: string
}

/** Callback invoked whenever a task's status or progress changes. */
export type TaskProgressCallback = (task: ProcessingTask) => void

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maps channel count → FFmpeg layout string. */
const CHANNEL_LAYOUTS: Record<number, string> = {
  1: 'mono',
  2: 'stereo',
  6: '5.1',
  8: '7.1'
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Return the FFmpeg channel layout name for the given channel count.
 * Falls back to `"stereo"` for unknown counts.
 */
export function channelLayout(channels: number): string {
  return CHANNEL_LAYOUTS[channels] || 'stereo'
}

/**
 * Remove any `[molexAudio …]` or `[molexMedia …]` tag prefix from a
 * stream title so it can be re-tagged cleanly.
 */
export function stripMolexTag(title: string): string {
  return title.replace(/\[molex(?:Audio|Media)[^\]]*\]\s*/g, '').trim()
}

/**
 * Generate a sibling temp-file path by appending {@link suffix} before
 * the file extension. Used for in-place "process → rename" workflows.
 */
export function createTempPath(filePath: string, suffix: string): string {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  return path.join(dir, `${base}${suffix}${ext}`)
}

/**
 * Format the wall-clock elapsed time between two timestamps
 * into a human-readable string (`"350ms"`, `"2.4s"`, `"1m 12s"`).
 */
export function formatElapsed(start: number, end: number): string {
  const ms = end - start
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m ${sec}s`
}

/**
 * Delete a temp file if it exists. Swallows errors silently -
 * this is best-effort cleanup only.
 */
export function cleanupTemp(tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  } catch { /* best-effort */ }
}

/**
 * Rename/move a file, falling back to copy+delete when the source and
 * destination are on different drives/filesystems (EXDEV).
 */
export function safeRename(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest)
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(src, dest)
      fs.unlinkSync(src)
    } else {
      throw err
    }
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Validate that a temp/output file is non-empty after processing.
 * Cleans up and throws if the file is zero bytes.
 */
export function validateOutput(filePath: string, label: string): void {
  const stat = fs.statSync(filePath)
  if (stat.size === 0) {
    cleanupTemp(filePath)
    throw new Error(`${label} produced an empty file`)
  }
}

/**
 * Extracts the most meaningful error line(s) from FFmpeg stderr output.
 * Falls back to the last non-empty line if no known error pattern is found.
 */
export function extractFFmpegError(stderr: string): string {
  if (!stderr) return 'Unknown error (no output)'
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  // Look for common FFmpeg error patterns (most specific first)
  const errorLines = lines.filter((l) =>
    /^(Error|.*error.*:|.*Invalid.*|.*No such.*|.*not found.*|.*Unsupported.*|.*Could not.*|.*does not.*|.*Unknown.*codec|.*Encoder.*not found|.*Decoder.*not found|.*Permission denied|.*already exists)/i.test(l)
  )
  if (errorLines.length > 0) return errorLines.slice(-3).join(' | ')
  // Fall back to last 2 meaningful lines
  return lines.slice(-2).join(' | ')
}

/**
 * Recursively walk {@link dirPath} and collect files whose extensions
 * match the given allow-list (e.g. `[".mp3", ".flac"]`).
 */
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
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && extSet.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath)
      }
    }
  }

  walk(dirPath)
  return results.sort()
}
