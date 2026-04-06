/**
 * @module main/ffmpeg/processor/editor
 * @description Non-destructive media editing operations.
 *
 * Provides cut (trim), merge (concatenate), and remux (stream selection +
 * metadata editing + disposition flags).  Supports two cut modes:
 *
 * - **fast** — stream-copy; snaps to the nearest keyframe (may be a few
 *   seconds off for video with large GOP sizes).
 * - **precise** — re-encodes so the cut is frame-accurate to the exact
 *   timestamps the user selected in the editor preview.
 */

import * as path from 'path'
import * as fs from 'fs'
import { getConfig } from '../../config'
import { logger } from '../../logger'
import { runCommand } from '../runner'
import { cleanupTemp } from './types'

/** Options that control how each cut/trim is performed. */
export interface CutOptions {
  /** `'fast'` = stream-copy (keyframe-aligned).  `'precise'` = re-encode (frame-accurate). */
  mode?: 'fast' | 'precise'
  /** Override the output container, e.g. `'mp4'`, `'mkv'`, `'mp3'`.  Defaults to the source extension. */
  outputFormat?: string
}

/* ------------------------------------------------------------------ */
/*  Cut / Trim                                                         */
/* ------------------------------------------------------------------ */

/**
 * Cut (trim) a media file between two time points.
 *
 * In **fast** mode the cut uses stream-copy (`-c copy`) with `-ss` placed
 * after `-i` (output-level seeking).  This is fast but still snaps to the
 * nearest prior keyframe for video tracks.
 *
 * In **precise** mode the file is re-encoded so the cut is frame-accurate
 * to the exact timestamps selected in the editor preview.
 *
 * @param filePath - Absolute path to the source file.
 * @param inPoint  - Start time in seconds.
 * @param outPoint - End time in seconds.
 * @param options  - Cut mode and optional output format override.
 * @returns Result object with `success`, optional `outputPath`, and optional `error`.
 */
export async function cutMedia(
  filePath: string,
  inPoint: number,
  outPoint: number,
  options: CutOptions = {}
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const mode = options.mode || 'precise'
  const srcExt = path.extname(filePath)
  const outExt = options.outputFormat ? `.${options.outputFormat.replace(/^\./, '')}` : srcExt
  const base = path.basename(filePath, srcExt)
  const dir = config.outputDirectory || path.dirname(filePath)
  const outputPath = path.join(dir, `${base}_cut${outExt}`)

  logger.info(`Cutting ${path.basename(filePath)}: ${inPoint.toFixed(2)}s → ${outPoint.toFixed(2)}s (mode=${mode}, ext=${outExt})`)

  const args = buildCutArgs(filePath, inPoint, outPoint, outputPath, mode)

  try {
    const { promise } = runCommand(config.ffmpegPath, args)
    const result = await promise
    if (result.code !== 0 && !result.killed) {
      logger.error(`Cut failed: ${result.stderr.slice(-300)}`)
      return { success: false, error: 'FFmpeg cut failed' }
    }
    logger.success(`Cut saved: ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    logger.error(`Cut error: ${err.message}`)
    return { success: false, error: err.message }
  }
}

/**
 * Build the FFmpeg argument list for a single cut operation.
 *
 * - **fast**: input seek (`-ss` before `-i`) for speed, then output seek
 *   (`-ss 0` after `-i`) to reset timestamps, with `-c copy`.
 * - **precise**: input seek for coarse positioning, then output seek from
 *   exact start with re-encoding for frame accuracy.
 */
function buildCutArgs(
  filePath: string,
  inPoint: number,
  outPoint: number,
  outputPath: string,
  mode: 'fast' | 'precise'
): string[] {
  const duration = outPoint - inPoint

  if (mode === 'fast') {
    return [
      '-y',
      '-ss', String(inPoint),
      '-i', filePath,
      '-t', String(duration),
      '-c', 'copy',
      '-map', '0',
      '-avoid_negative_ts', 'make_zero',
      outputPath
    ]
  }

  // precise — re-encode for frame-accurate boundaries
  return [
    '-y',
    '-ss', String(inPoint),
    '-i', filePath,
    '-t', String(duration),
    '-map', '0',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ]
}

/* ------------------------------------------------------------------ */
/*  Merge / Concatenate                                                */
/* ------------------------------------------------------------------ */

/** A single segment to include in a merge operation. */
export interface MergeSegment {
  path: string
  inPoint: number
  outPoint: number
}

/**
 * Merge (concatenate) multiple trimmed segments into a single file
 * using FFmpeg's concat demuxer.
 *
 * Each segment is first cut to a temp file (using {@link buildCutArgs}),
 * then the temp files are concatenated.  All temp files are cleaned up
 * afterward.
 *
 * @param segments - Ordered list of segments to merge (min 2).
 * @param options  - Cut mode and optional output format override.
 * @returns Result object with `success`, optional `outputPath`, and optional `error`.
 */
export async function mergeMedia(
  segments: MergeSegment[],
  options: CutOptions = {}
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const mode = options.mode || 'precise'

  if (segments.length < 2) return { success: false, error: 'Need at least 2 segments' }

  const srcExt = path.extname(segments[0].path)
  const outExt = options.outputFormat ? `.${options.outputFormat.replace(/^\./, '')}` : srcExt
  const dir = config.outputDirectory || path.dirname(segments[0].path)
  const outputPath = path.join(dir, `merged_${Date.now()}${outExt}`)
  const concatFile = path.join(dir, `.molexmedia_concat_${Date.now()}.txt`)

  logger.info(`Merging ${segments.length} segments (mode=${mode})`)

  try {
    // First, cut each segment to a temp file
    const tempFiles: string[] = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const tempPath = path.join(dir, `.molexmedia_seg_${Date.now()}_${i}${outExt}`)
      const args = buildCutArgs(seg.path, seg.inPoint, seg.outPoint, tempPath, mode)

      const { promise } = runCommand(config.ffmpegPath, args)
      const result = await promise
      if (result.code !== 0 && !result.killed) {
        // Cleanup temp files
        for (const f of tempFiles) { try { fs.unlinkSync(f) } catch { /* best-effort */ } }
        return { success: false, error: `Failed to cut segment ${i + 1}` }
      }
      tempFiles.push(tempPath)
    }

    // Write concat list
    const concatContent = tempFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(concatFile, concatContent, 'utf-8')

    // Merge
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      outputPath
    ]

    const { promise } = runCommand(config.ffmpegPath, args)
    const result = await promise

    // Cleanup temp files
    for (const f of tempFiles) { try { fs.unlinkSync(f) } catch { /* best-effort */ } }
    try { fs.unlinkSync(concatFile) } catch { /* best-effort */ }

    if (result.code !== 0 && !result.killed) {
      logger.error(`Merge failed: ${result.stderr.slice(-300)}`)
      return { success: false, error: 'FFmpeg merge failed' }
    }

    logger.success(`Merged ${segments.length} segments → ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    try { fs.unlinkSync(concatFile) } catch { /* best-effort */ }
    logger.error(`Merge error: ${err.message}`)
    return { success: false, error: err.message }
  }
}

/* ------------------------------------------------------------------ */
/*  Remux                                                              */
/* ------------------------------------------------------------------ */

/** Options for the remux operation. */
export interface RemuxOptions {
  /** Absolute stream indices to keep in the output. */
  keepStreams: number[]
  /** Global metadata key-value pairs (empty string clears a key). */
  metadata?: Record<string, string>
  /** Per-stream disposition flag overrides, keyed by original stream index. */
  dispositions?: Record<number, Record<string, number>>
}

/**
 * Remux a media file: selectively keep streams, edit global metadata,
 * and set per-stream disposition flags — all without re-encoding.
 *
 * @param filePath - Absolute path to the source file.
 * @param options  - Streams to keep, metadata overrides, disposition flags.
 * @returns Result object with `success`, optional `outputPath`, and optional `error`.
 */
export async function remuxMedia(
  filePath: string,
  options: RemuxOptions
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }

  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const dir = config.outputDirectory || path.dirname(filePath)
  const outputPath = path.join(dir, `${base}_edited${ext}`)

  logger.info(`Remuxing ${path.basename(filePath)}: keeping streams [${options.keepStreams.join(', ')}]`)

  const args: string[] = ['-y', '-i', filePath]

  // Map only the streams the user wants to keep
  for (const idx of options.keepStreams) {
    args.push('-map', `0:${idx}`)
  }

  // Copy all codecs (no re-encode)
  args.push('-c', 'copy')

  // Apply global metadata
  if (options.metadata) {
    for (const [key, value] of Object.entries(options.metadata)) {
      if (value === '') {
        args.push('-metadata', `${key}=`)
      } else {
        args.push('-metadata', `${key}=${value}`)
      }
    }
  }

  // Apply per-stream disposition flags
  if (options.dispositions) {
    const streamOrder = options.keepStreams
    for (const [origIdxStr, flags] of Object.entries(options.dispositions)) {
      const origIdx = parseInt(origIdxStr, 10)
      const outIdx = streamOrder.indexOf(origIdx)
      if (outIdx === -1) continue

      const flagStr = Object.entries(flags)
        .map(([k, v]) => (v ? k : `-${k}`))
        .join('+') || '0'
      args.push(`-disposition:${outIdx}`, flagStr)
    }
  }

  args.push(outputPath)

  try {
    const { promise } = runCommand(ffmpegPath, args)
    const result = await promise
    if (result.code !== 0 && !result.killed) {
      cleanupTemp(outputPath)
      logger.error(`Remux failed: ${result.stderr.slice(-300)}`)
      return { success: false, error: 'FFmpeg remux failed' }
    }
    logger.success(`Remuxed: ${path.basename(outputPath)}`)
    return { success: true, outputPath }
  } catch (err: any) {
    cleanupTemp(outputPath)
    logger.error(`Remux error: ${err.message}`)
    return { success: false, error: err.message }
  }
}
