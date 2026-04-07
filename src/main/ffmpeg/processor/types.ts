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
 * Delete a temp file if it exists. Swallows errors silently —
 * this is best-effort cleanup only.
 */
export function cleanupTemp(tempPath: string): void {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  } catch { /* best-effort */ }
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
