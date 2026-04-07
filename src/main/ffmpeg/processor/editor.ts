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
import { runCommand, parseProgress } from '../runner'
import { cleanupTemp } from './types'

/** Progress info emitted during editor operations. */
export interface EditorProgress {
  /** 0-100 */
  percent: number
  /** Human-readable status message */
  message: string
}

/** Optional callback for reporting editor operation progress. */
export type EditorProgressCallback = (progress: EditorProgress) => void

/** GIF-specific encoding options. */
export interface GifOptions {
  /** Whether the GIF should loop. Defaults to true. */
  loop?: boolean
  /** Frame rate for the GIF (1-30). Defaults to 15. */
  fps?: number
  /** Output width in pixels (-1 = original). Defaults to 480. */
  width?: number
}

/** Options that control how each cut/trim is performed. */
export interface CutOptions {
  /** `'fast'` = stream-copy (keyframe-aligned).  `'precise'` = re-encode (frame-accurate). */
  mode?: 'fast' | 'precise'
  /** Override the output container, e.g. `'mp4'`, `'mkv'`, `'mp3'`.  Defaults to the source extension. */
  outputFormat?: string
  /** Override the output directory. Defaults to `config.outputDirectory` or source file directory. */
  outputDir?: string
  /** GIF-specific options. Only used when outputFormat is 'gif'. */
  gifOptions?: GifOptions
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
  options: CutOptions = {},
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const mode = options.outputFormat === 'gif' ? 'precise' : (options.mode || 'precise')
  const srcExt = path.extname(filePath)
  const outExt = options.outputFormat ? `.${options.outputFormat.replace(/^\./, '')}` : srcExt
  const base = path.basename(filePath, srcExt)
  const dir = options.outputDir || config.outputDirectory || path.dirname(filePath)
  const outputPath = path.join(dir, `${base}_cut${outExt}`)
  const totalDuration = outPoint - inPoint

  logger.info(`Cutting ${path.basename(filePath)}: ${inPoint.toFixed(2)}s → ${outPoint.toFixed(2)}s (mode=${mode}, ext=${outExt})`)

  onProgress?.({ percent: 0, message: 'Starting export...' })

  // GIF export uses two-pass palette generation for quality
  if (outExt === '.gif') {
    return exportGif(config.ffmpegPath, filePath, inPoint, outPoint, outputPath, options.gifOptions || {}, totalDuration, onProgress)
  }

  const args = buildCutArgs(filePath, inPoint, outPoint, outputPath, mode)

  try {
    const { promise } = runCommand(config.ffmpegPath, args, (line) => {
      if (!onProgress || totalDuration <= 0) return
      const progress = parseProgress(line)
      if (progress) {
        const pct = Math.min(95, Math.round((progress.time / totalDuration) * 95))
        onProgress({ percent: pct, message: `Exporting... ${pct}%${progress.speed ? ` @ ${progress.speed}` : ''}` })
      }
    })
    const result = await promise
    if (result.code !== 0 && !result.killed) {
      logger.error(`Cut failed: ${result.stderr.slice(-300)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'FFmpeg cut failed' }
    }
    onProgress?.({ percent: 100, message: 'Complete' })
    logger.success(`Cut saved: ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    logger.error(`Cut error: ${err.message}`)
    onProgress?.({ percent: 0, message: '' })
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

/**
 * Export a GIF using two-pass palette generation for high quality.
 *
 * Pass 1: Generate an optimised palette from the input segment.
 * Pass 2: Encode the GIF using that palette at the requested fps/width.
 */
async function exportGif(
  ffmpegPath: string,
  filePath: string,
  inPoint: number,
  outPoint: number,
  outputPath: string,
  gifOpts: GifOptions,
  totalDuration: number,
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const fps = gifOpts.fps ?? 15
  const width = gifOpts.width ?? 480
  const loop = gifOpts.loop !== false
  const duration = outPoint - inPoint

  const scaleFilter = width > 0 ? `scale=${width}:-1:flags=lanczos` : 'scale=trunc(iw/2)*2:-1:flags=lanczos'
  const palettePath = outputPath.replace(/\.gif$/, '_palette.png')

  try {
    // Pass 1 — generate palette
    onProgress?.({ percent: 0, message: 'Generating palette...' })
    const paletteArgs = [
      '-y', '-ss', String(inPoint), '-i', filePath, '-t', String(duration),
      '-vf', `fps=${fps},${scaleFilter},palettegen=stats_mode=diff`,
      palettePath
    ]
    const p1 = runCommand(ffmpegPath, paletteArgs, (line) => {
      if (!onProgress || totalDuration <= 0) return
      const progress = parseProgress(line)
      if (progress) {
        const pct = Math.min(40, Math.round((progress.time / totalDuration) * 40))
        onProgress({ percent: pct, message: `Generating palette... ${pct}%` })
      }
    })
    const r1 = await p1.promise
    if (r1.code !== 0 && !r1.killed) {
      logger.error(`GIF palette generation failed: ${r1.stderr.slice(-300)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'GIF palette generation failed' }
    }

    // Pass 2 — encode with palette
    onProgress?.({ percent: 45, message: 'Encoding GIF...' })
    const encodeArgs = [
      '-y', '-ss', String(inPoint), '-i', filePath, '-i', palettePath, '-t', String(duration),
      '-lavfi', `fps=${fps},${scaleFilter} [x]; [x][1:v] paletteuse=dither=sierra2_4a`,
      '-loop', loop ? '0' : '-1',
      outputPath
    ]
    const p2 = runCommand(ffmpegPath, encodeArgs, (line) => {
      if (!onProgress || totalDuration <= 0) return
      const progress = parseProgress(line)
      if (progress) {
        const pct = Math.min(95, 45 + Math.round((progress.time / totalDuration) * 50))
        onProgress({ percent: pct, message: `Encoding GIF... ${pct}%` })
      }
    })
    const r2 = await p2.promise
    if (r2.code !== 0 && !r2.killed) {
      logger.error(`GIF encoding failed: ${r2.stderr.slice(-300)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'GIF encoding failed' }
    }

    onProgress?.({ percent: 100, message: 'Complete' })
    logger.success(`GIF saved: ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    logger.error(`GIF export error: ${err.message}`)
    onProgress?.({ percent: 0, message: '' })
    return { success: false, error: err.message }
  } finally {
    // Clean up temporary palette file
    try { fs.unlinkSync(palettePath) } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Merge / Concatenate                                                */
/* ------------------------------------------------------------------ */

/** A single segment to include in a merge operation. */
export interface MergeSegment {
  path: string
  inPoint: number
  outPoint: number
  /** Optional A2 audio replacement for this segment. */
  audioReplacement?: {
    path: string
    offset: number
    trimIn: number
    trimOut: number
  }
}

/**
 * Export the timeline: trim, mix A2 audio, and concatenate segments
 * into a single output file.
 *
 * Handles all editor export scenarios:
 * - Single segment (trim/cut)
 * - Single segment with A2 audio overlay
 * - Multiple segments (split + rearrange)
 * - Multiple segments with per-segment A2 audio
 *
 * In **precise** mode (default) all segments are processed in a single
 * FFmpeg filter_complex pass using `trim`/`atrim` + `concat`, which
 * eliminates boundary artifacts between segments.  A2 audio is mixed
 * (overlaid) with `amix` rather than replacing the original track.
 *
 * In **fast** mode segments are stream-copied individually and joined
 * with the concat demuxer.
 *
 * @param segments - Ordered list of segments to export (min 1).
 * @param options  - Cut mode and optional output format override.
 * @returns Result object with `success`, optional `outputPath`, and optional `error`.
 */
export async function mergeMedia(
  segments: MergeSegment[],
  options: CutOptions = {},
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const mode = options.outputFormat === 'gif' ? 'precise' : (options.mode || 'precise')

  if (segments.length < 1) return { success: false, error: 'No segments provided' }

  // Single segment without A2 — delegate to simple cutMedia
  if (segments.length === 1 && !segments[0].audioReplacement) {
    return cutMedia(segments[0].path, segments[0].inPoint, segments[0].outPoint, options, onProgress)
  }

  const srcExt = path.extname(segments[0].path)
  const outExt = options.outputFormat ? `.${options.outputFormat.replace(/^\./, '')}` : srcExt
  const dir = options.outputDir || config.outputDirectory || path.dirname(segments[0].path)
  const base = path.basename(segments[0].path, srcExt)
  const outputPath = segments.length === 1
    ? path.join(dir, `${base}_export${outExt}`)
    : path.join(dir, `merged_${Date.now()}${outExt}`)

  const AUDIO_ONLY_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus']
  const hasVideo = !AUDIO_ONLY_EXTS.includes(srcExt.toLowerCase())
  const hasA2 = segments.some((s) => s.audioReplacement)

  logger.info(`Exporting ${segments.length} segment(s) (mode=${mode}${hasA2 ? ', with A2' : ''})`)
  onProgress?.({ percent: 0, message: 'Preparing export...' })

  if (mode === 'precise') {
    return mergePrecise(config.ffmpegPath, segments, outputPath, hasVideo, onProgress)
  }
  return mergeFast(config.ffmpegPath, segments, outputPath, outExt, dir, hasVideo, onProgress)
}

/**
 * Precise merge: single-pass filter_complex with trim + concat.
 * Produces seamless boundaries and mixes A2 audio with the original.
 */
async function mergePrecise(
  ffmpegPath: string,
  segments: MergeSegment[],
  outputPath: string,
  hasVideo: boolean,
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  // Collect unique input files and assign FFmpeg input indices
  const inputPaths: string[] = []
  const pathToIdx = new Map<string, number>()

  for (const seg of segments) {
    if (!pathToIdx.has(seg.path)) {
      pathToIdx.set(seg.path, inputPaths.length)
      inputPaths.push(seg.path)
    }
    if (seg.audioReplacement && !pathToIdx.has(seg.audioReplacement.path)) {
      pathToIdx.set(seg.audioReplacement.path, inputPaths.length)
      inputPaths.push(seg.audioReplacement.path)
    }
  }

  // Build filter graph
  const filters: string[] = []
  const concatParts: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const srcIdx = pathToIdx.get(seg.path)!
    const segDur = seg.outPoint - seg.inPoint

    if (hasVideo) {
      filters.push(
        `[${srcIdx}:v]trim=start=${seg.inPoint}:end=${seg.outPoint},setpts=PTS-STARTPTS[v${i}]`
      )
    }

    if (seg.audioReplacement) {
      const a2Idx = pathToIdx.get(seg.audioReplacement.path)!
      const a2TrimIn = seg.audioReplacement.trimIn ?? 0
      const a2TrimOut = seg.audioReplacement.trimOut ?? (a2TrimIn + segDur)
      const a2Offset = seg.audioReplacement.offset || 0
      filters.push(
        `[${srcIdx}:a]atrim=start=${seg.inPoint}:end=${seg.outPoint},asetpts=PTS-STARTPTS[a${i}_orig]`
      )
      const delayFilter = a2Offset > 0 ? `,adelay=${Math.round(a2Offset * 1000)}|${Math.round(a2Offset * 1000)}` : ''
      filters.push(
        `[${a2Idx}:a]atrim=start=${a2TrimIn}:end=${a2TrimOut},asetpts=PTS-STARTPTS${delayFilter}[a${i}_a2]`
      )
      filters.push(
        `[a${i}_orig][a${i}_a2]amix=inputs=2:duration=first:dropout_transition=0[a${i}]`
      )
    } else {
      filters.push(
        `[${srcIdx}:a]atrim=start=${seg.inPoint}:end=${seg.outPoint},asetpts=PTS-STARTPTS[a${i}]`
      )
    }

    concatParts.push(hasVideo ? `[v${i}][a${i}]` : `[a${i}]`)
  }

  // Final concat
  const concatV = hasVideo ? 1 : 0
  const concatOuts = hasVideo ? '[vout][aout]' : '[aout]'
  filters.push(
    `${concatParts.join('')}concat=n=${segments.length}:v=${concatV}:a=1${concatOuts}`
  )

  const totalDuration = segments.reduce((sum, s) => sum + (s.outPoint - s.inPoint), 0)

  const args = [
    '-y',
    ...inputPaths.flatMap((p) => ['-i', p]),
    '-filter_complex', filters.join('; '),
    ...(hasVideo ? ['-map', '[vout]'] : []),
    '-map', '[aout]',
    '-c:a', 'aac', '-b:a', '256k',
    outputPath
  ]

  try {
    const { promise } = runCommand(ffmpegPath, args, (line) => {
      if (!onProgress || totalDuration <= 0) return
      const progress = parseProgress(line)
      if (progress) {
        const pct = Math.min(95, Math.round((progress.time / totalDuration) * 95))
        onProgress({ percent: pct, message: `Exporting... ${pct}%${progress.speed ? ` @ ${progress.speed}` : ''}` })
      }
    })
    const result = await promise
    if (result.code !== 0 && !result.killed) {
      logger.error(`Merge failed: ${result.stderr.slice(-500)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'Export failed' }
    }
    onProgress?.({ percent: 100, message: 'Complete' })
    logger.success(`Merged ${segments.length} segments → ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    logger.error(`Merge error: ${err.message}`)
    onProgress?.({ percent: 0, message: '' })
    return { success: false, error: err.message }
  }
}

/**
 * Fast merge: stream-copy each segment, concatenate with concat demuxer.
 * A2 segments get audio mixed via amix (audio is re-encoded for those).
 */
async function mergeFast(
  ffmpegPath: string,
  segments: MergeSegment[],
  outputPath: string,
  outExt: string,
  dir: string,
  hasVideo: boolean,
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const concatFile = path.join(dir, `.molexmedia_concat_${Date.now()}.txt`)
  const tempFiles: string[] = []

  try {
    const totalSegments = segments.length

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const segDuration = seg.outPoint - seg.inPoint
      const tempPath = path.join(dir, `.molexmedia_seg_${Date.now()}_${i}${outExt}`)
      const segBase = Math.round((i / (totalSegments + 1)) * 90)

      onProgress?.({ percent: segBase, message: `Processing segment ${i + 1}/${totalSegments}...` })

      let args: string[]
      if (seg.audioReplacement) {
        // Mix A2 audio with original using amix (not replace)
        const a2TrimIn = seg.audioReplacement.trimIn ?? 0
        const a2TrimOut = seg.audioReplacement.trimOut ?? (a2TrimIn + segDuration)
        const a2Offset = seg.audioReplacement.offset || 0
        const delayFilter = a2Offset > 0 ? `adelay=${Math.round(a2Offset * 1000)}|${Math.round(a2Offset * 1000)},` : ''
        const filterComplex = `[1:a]atrim=start=${a2TrimIn}:end=${a2TrimOut},asetpts=PTS-STARTPTS,${delayFilter}apad[a2p]; [0:a][a2p]amix=inputs=2:duration=first:dropout_transition=0[aout]`
        args = [
          '-y',
          '-ss', String(seg.inPoint),
          '-i', seg.path,
          '-i', seg.audioReplacement.path,
          '-t', String(segDuration),
          '-filter_complex', filterComplex,
          ...(hasVideo ? ['-map', '0:v', '-c:v', 'copy'] : []),
          '-map', '[aout]',
          '-c:a', 'aac', '-b:a', '256k',
          '-avoid_negative_ts', 'make_zero',
          tempPath
        ]
      } else {
        args = buildCutArgs(seg.path, seg.inPoint, seg.outPoint, tempPath, 'fast')
      }

      const { promise } = runCommand(ffmpegPath, args, (line) => {
        if (!onProgress || segDuration <= 0) return
        const progress = parseProgress(line)
        if (progress) {
          const segPct = Math.min(1, progress.time / segDuration)
          const pct = Math.round(segBase + segPct * (90 / (totalSegments + 1)))
          onProgress({ percent: Math.min(90, pct), message: `Processing segment ${i + 1}/${totalSegments}... ${Math.round(segPct * 100)}%` })
        }
      })
      const result = await promise
      if (result.code !== 0 && !result.killed) {
        cleanupTempFiles([...tempFiles, concatFile])
        logger.error(`Segment ${i + 1} failed: ${result.stderr.slice(-300)}`)
        onProgress?.({ percent: 0, message: '' })
        return { success: false, error: `Failed to process segment ${i + 1}` }
      }
      tempFiles.push(tempPath)
    }

    // Single segment — no concat needed, just rename temp to output
    if (segments.length === 1) {
      fs.renameSync(tempFiles[0], outputPath)
      onProgress?.({ percent: 100, message: 'Complete' })
      logger.success(`Exported: ${outputPath}`)
      return { success: true, outputPath }
    }

    // Multiple segments — concat
    const concatContent = tempFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(concatFile, concatContent, 'utf-8')

    onProgress?.({ percent: 90, message: 'Merging segments...' })

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      outputPath
    ]

    const { promise } = runCommand(ffmpegPath, args)
    const result = await promise

    cleanupTempFiles([...tempFiles, concatFile])

    if (result.code !== 0 && !result.killed) {
      logger.error(`Merge failed: ${result.stderr.slice(-300)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'FFmpeg merge failed' }
    }

    onProgress?.({ percent: 100, message: 'Complete' })
    logger.success(`Merged ${segments.length} segments → ${outputPath}`)
    return { success: true, outputPath }
  } catch (err: any) {
    cleanupTempFiles([...tempFiles, concatFile])
    logger.error(`Export error: ${err.message}`)
    onProgress?.({ percent: 0, message: '' })
    return { success: false, error: err.message }
  }
}

/** Best-effort cleanup of temporary files. */
function cleanupTempFiles(files: string[]): void {
  for (const f of files) { try { fs.unlinkSync(f) } catch { /* best-effort */ } }
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

/* ------------------------------------------------------------------ */
/*  Replace Audio                                                      */
/* ------------------------------------------------------------------ */

/** Options for the replaceAudio operation. */
export interface ReplaceAudioOptions {
  /** Override the output directory. Defaults to source file directory. */
  outputDir?: string
  /** Offset in seconds to delay the replacement audio. Positive delays audio start. */
  audioOffset?: number
  /** Trim start point in seconds (absolute position in source file). */
  inPoint?: number
  /** Trim end point in seconds (absolute position in source file). */
  outPoint?: number
}

/**
 * Replace the audio track(s) in a video file with audio from another file.
 *
 * Copies the video stream(s) from the source and takes the audio stream(s)
 * from the replacement file.  No re-encoding is performed on the video;
 * audio is copied if codec-compatible, otherwise re-encoded to AAC.
 *
 * @param videoPath - Absolute path to the source video file.
 * @param audioPath - Absolute path to the replacement audio file.
 * @param options   - Optional output directory override.
 * @returns Result object with `success`, optional `outputPath`, and optional `error`.
 */
export async function replaceAudio(
  videoPath: string,
  audioPath: string,
  options: ReplaceAudioOptions = {},
  onProgress?: EditorProgressCallback
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpegPath
  if (!ffmpegPath) return { success: false, error: 'FFmpeg not configured' }

  const ext = path.extname(videoPath)
  const base = path.basename(videoPath, ext)
  const dir = options.outputDir || config.outputDirectory || path.dirname(videoPath)
  const outputPath = path.join(dir, `${base}_replaced${ext}`)

  logger.info(`Replacing audio: ${path.basename(videoPath)} ← ${path.basename(audioPath)}`)
  onProgress?.({ percent: 0, message: 'Replacing audio track...' })

  const hasTrim = options.inPoint != null && options.outPoint != null && (options.inPoint > 0 || options.outPoint < Infinity)
  const duration = hasTrim ? options.outPoint! - options.inPoint! : undefined

  const args = [
    '-y',
    ...(hasTrim ? ['-ss', String(options.inPoint)] : []),
    '-i', videoPath,
    ...(options.audioOffset ? ['-itsoffset', String(options.audioOffset)] : []),
    '-i', audioPath,
    '-map', '0:v',
    '-map', '1:a',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '256k',
    ...(duration != null ? ['-t', String(duration)] : []),
    '-shortest',
    outputPath
  ]

  try {
    const { promise } = runCommand(ffmpegPath, args, (line) => {
      if (!onProgress) return
      const progress = parseProgress(line)
      if (progress) {
        const pct = Math.min(95, Math.round(progress.time))
        onProgress({ percent: pct, message: `Replacing audio... ${pct}%${progress.speed ? ` @ ${progress.speed}` : ''}` })
      }
    })
    const result = await promise
    if (result.code !== 0 && !result.killed) {
      cleanupTemp(outputPath)
      logger.error(`Replace audio failed: ${result.stderr.slice(-300)}`)
      onProgress?.({ percent: 0, message: '' })
      return { success: false, error: 'FFmpeg replace audio failed' }
    }
    onProgress?.({ percent: 100, message: 'Complete' })
    logger.success(`Audio replaced: ${path.basename(outputPath)}`)
    return { success: true, outputPath }
  } catch (err: any) {
    cleanupTemp(outputPath)
    logger.error(`Replace audio error: ${err.message}`)
    onProgress?.({ percent: 0, message: '' })
    return { success: false, error: err.message }
  }
}
