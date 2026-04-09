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
  preset?: string
  normalizeOptions?: { I: number; TP: number; LRA: number }
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
  outputFormat: string
  streamIndex: number
  audioBitrate?: string
  sampleRate?: string
  channels?: string
}

export interface CompressOptions {
  targetSizeMB: number
  quality: string
  videoCodec?: string
  speed?: string
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
