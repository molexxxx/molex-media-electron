/**
 * @module main/ffmpeg/playback
 * @description On-demand audio extraction for browser playback.
 *
 * Chromium can only decode a limited set of audio/video formats natively.
 * For everything else (MKV, AVI, WMV, FLV, WMA, AC3, DTS …) this module
 * uses FFmpeg to extract the first audio stream into a browser-compatible
 * container.  The result is cached in a temp directory so repeat plays
 * don't re-transcode.
 *
 * Strategy:
 *   1. If the source audio codec is already browser-decodable, **remux**
 *      (stream-copy) into a matching container - effectively instant.
 *   2. Otherwise **transcode** to Opus in a WebM container (small, fast,
 *      universally supported in Chromium).
 */

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { logger } from '../logger'
import { getConfig } from '../config'
import { runCommand } from './runner'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Audio codecs Chromium can decode natively.
 *
 * For codecs that need transcoding or remuxing out of a video container,
 * Prefer **WebM** as the output container because:
 *   - Duration is stored in the Segment header (no end-of-file seek)
 *   - Chromium has native WebM demuxing (no plugin needed)
 *   - Cues (seek index) can be placed near the start
 *
 * Pure audio formats like MP3/FLAC/WAV have their own simple headers
 * and don't need the WebM wrapper.
 *
 * Mapping: FFmpeg codec name → { ext, codec }.
 * - `copy` means stream-copy (instant).
 * - Anything else is a transcode codec name.
 */
const NATIVE_CODEC_MAP: Record<string, { ext: string; codec: string }> = {
  // Self-contained audio formats (headers always at front)
  mp3:        { ext: 'mp3',  codec: 'copy' },
  flac:       { ext: 'flac', codec: 'copy' },
  pcm_s16le:  { ext: 'wav',  codec: 'copy' },
  pcm_s24le:  { ext: 'wav',  codec: 'copy' },
  pcm_s32le:  { ext: 'wav',  codec: 'copy' },
  pcm_f32le:  { ext: 'wav',  codec: 'copy' },
  pcm_u8:     { ext: 'wav',  codec: 'copy' },
  // WebM-wrapped codecs (duration in header, no end-of-file seek)
  vorbis:     { ext: 'webm', codec: 'copy' },
  opus:       { ext: 'webm', codec: 'copy' },
  // AAC: remux to M4A with -movflags +faststart (moov atom at front).
  // Stream copy = instant; faststart relocates the moov atom so the
  // browser reads duration and seek-points immediately.
  aac:        { ext: 'm4a', codec: 'copy' },
}

/**
 * Pure audio extensions that Chromium can play directly through the
 * custom `media://` protocol without needing FFmpeg extraction.
 *
 * Video containers (MP4, MOV, WebM-with-video, MKV, AVI …) are
 * intentionally excluded - even though Chromium *can* decode MP4,
 * serving multi-GB video files through a custom protocol causes
 * PIPELINE_ERROR_READ on seek.  Instead, FFmpeg extracts just the
 * audio stream into a lightweight file.
 */
const DIRECT_AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.opus', '.aac', '.m4a'
])

/** Temp directory for extracted playback files. */
let playbackTempDir: string | null = null

function getTempDir(): string {
  if (!playbackTempDir) {
    playbackTempDir = path.join(app.getPath('temp'), 'molex-playback')
    fs.mkdirSync(playbackTempDir, { recursive: true })
    // Clean up stale .ogg cache files from the previous OGG-based extraction
    // strategy - these are now replaced by .webm files.
    try {
      for (const f of fs.readdirSync(playbackTempDir)) {
        if (f.endsWith('.ogg')) {
          try { fs.unlinkSync(path.join(playbackTempDir, f)) } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }
  return playbackTempDir
}

/* ------------------------------------------------------------------ */
/*  Cache: source path → extracted path                                */
/* ------------------------------------------------------------------ */

const extractionCache = new Map<string, string>()

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Returns `true` if the file is a pure audio format that Chromium can
 * play directly - no FFmpeg extraction needed.
 */
export function isBrowserNative(filePath: string): boolean {
  return DIRECT_AUDIO_EXTS.has(path.extname(filePath).toLowerCase())
}

/**
 * Prepare a media file for browser playback.
 *
 * - If the format is browser-native, returns the original path.
 * - Otherwise, extracts the first audio stream via FFmpeg (remux or transcode)
 *   and returns the path to the extracted file.
 *
 * Results are cached so repeat plays are instant.
 */
export async function prepareForPlayback(filePath: string): Promise<string> {
  // Already playable → skip extraction
  if (isBrowserNative(filePath)) return filePath

  // Check cache - but validate the file still exists and isn't empty
  const cached = extractionCache.get(filePath)
  if (cached) {
    if (fs.existsSync(cached)) {
      const cachedStat = fs.statSync(cached)
      if (cachedStat.size > 0) return cached
      // Cached file is empty/corrupt - remove it
      try { fs.unlinkSync(cached) } catch { /* best effort */ }
      logger.warn(`Playback: removed corrupt memory-cached file ${path.basename(cached)}`)
    }
    extractionCache.delete(filePath)
  }

  const config = await getConfig()
  if (!config.ffmpegPath) throw new Error('FFmpeg not configured')
  if (!config.ffprobePath) throw new Error('ffprobe not configured')

  // Probe the source to find the first audio stream's codec
  const codec = await probeAudioCodec(config.ffprobePath, filePath)
  if (!codec) throw new Error('No audio stream found in file')

  const native = NATIVE_CODEC_MAP[codec]
  const baseName = path.basename(filePath, path.extname(filePath))
  // Use a hash of the full path to avoid collisions
  const hash = simpleHash(filePath)

  let outExt: string
  let ffmpegCodecArgs: string[]

  if (native) {
    outExt = native.ext
    ffmpegCodecArgs = ['-c:a', native.codec]
    // Add bitrate for non-copy encoders (e.g. AAC → libopus)
    if (native.codec !== 'copy') {
      ffmpegCodecArgs.push('-b:a', '192k')
      logger.info(`Playback: transcoding ${codec} → ${native.codec}/.${outExt}`)
    } else {
      logger.info(`Playback: remuxing ${codec} → .${outExt} (stream copy)`)
    }
  } else {
    // Unknown codec - transcode to Opus in WebM container
    outExt = 'webm'
    ffmpegCodecArgs = ['-c:a', 'libopus', '-b:a', '192k']
    logger.info(`Playback: transcoding ${codec} → Opus/WebM`)
  }

  const outPath = path.join(getTempDir(), `${baseName}_${hash}.${outExt}`)

  // If the output already exists on disk (from a previous session), use it -
  // but only if it's non-empty (a zero-byte file means a previous extraction
  // was interrupted and should be retried).
  if (fs.existsSync(outPath)) {
    const existingStat = fs.statSync(outPath)
    if (existingStat.size > 0) {
      extractionCache.set(filePath, outPath)
      return outPath
    }
    // Remove the empty/corrupted file so extraction can proceed
    try { fs.unlinkSync(outPath) } catch { /* best effort */ }
    logger.warn(`Playback: removed corrupted cache file ${path.basename(outPath)}`)
  }

  // Format-specific flags for seekability
  const formatArgs: string[] = []
  if (outExt === 'm4a') {
    // Move moov atom to front so the browser reads duration immediately
    formatArgs.push('-movflags', '+faststart')
  } else if (outExt === 'webm') {
    // Reserve space at front for Cues (seek index) so seeking works
    // without an extra round-trip to the end of the file
    formatArgs.push('-reserve_index_space', '50000')
  }

  const args = [
    '-y', '-i', filePath,
    '-vn',           // strip video
    '-map', '0:a:0', // first audio stream
    ...ffmpegCodecArgs,
    ...formatArgs,
    '-threads', '0',
    outPath
  ]

  const { promise } = runCommand(config.ffmpegPath, args)
  const result = await promise

  if (result.code !== 0) {
    throw new Error(`Audio extraction failed (code ${result.code}): ${result.stderr.slice(-200)}`)
  }

  extractionCache.set(filePath, outPath)
  logger.success(`Playback: extracted ${path.basename(filePath)} → ${path.basename(outPath)}`)
  return outPath
}

/**
 * Extract audio starting at a specific timestamp.
 *
 * Uses `-ss` (input seeking) before `-i` so FFmpeg skips directly to
 * the target position without decoding the skipped portion - this is
 * nearly instant even for multi-GB video files.
 *
 * The resulting file starts at t=0 from the caller's perspective;
 * the renderer is responsible for offsetting the displayed time.
 *
 * Previous seek-extracted files for the same source are cleaned up
 * automatically to avoid filling the temp directory.
 */
export async function prepareForPlaybackAt(filePath: string, seekTime: number): Promise<string> {
  // Browser-native audio files don't go through extraction - seeking is
  // handled directly by the media element and the custom protocol.
  if (isBrowserNative(filePath)) return filePath

  const config = await getConfig()
  if (!config.ffmpegPath) throw new Error('FFmpeg not configured')
  if (!config.ffprobePath) throw new Error('ffprobe not configured')

  const codec = await probeAudioCodec(config.ffprobePath, filePath)
  if (!codec) throw new Error('No audio stream found in file')

  const native = NATIVE_CODEC_MAP[codec]
  const baseName = path.basename(filePath, path.extname(filePath))
  const hash = simpleHash(filePath)
  const seekTag = `seek${Math.floor(seekTime)}`

  let outExt: string
  let ffmpegCodecArgs: string[]

  if (native) {
    outExt = native.ext
    ffmpegCodecArgs = ['-c:a', native.codec]
    if (native.codec !== 'copy') ffmpegCodecArgs.push('-b:a', '192k')
  } else {
    outExt = 'webm'
    ffmpegCodecArgs = ['-c:a', 'libopus', '-b:a', '192k']
  }

  const outPath = path.join(getTempDir(), `${baseName}_${hash}_${seekTag}.${outExt}`)

  // Clean up previous seek files for this source (keep only the current)
  const seekPrefix = `${baseName}_${hash}_seek`
  try {
    for (const f of fs.readdirSync(getTempDir())) {
      if (f.startsWith(seekPrefix) && path.join(getTempDir(), f) !== outPath) {
        try { fs.unlinkSync(path.join(getTempDir(), f)) } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  // Reuse if already extracted at this exact position
  if (fs.existsSync(outPath)) {
    const s = fs.statSync(outPath)
    if (s.size > 0) return outPath
    try { fs.unlinkSync(outPath) } catch { /* best effort */ }
  }

  const formatArgs: string[] = []
  if (outExt === 'm4a') formatArgs.push('-movflags', '+faststart')
  else if (outExt === 'webm') formatArgs.push('-reserve_index_space', '50000')

  const args = [
    '-y',
    '-ss', String(seekTime), // Input seeking - fast, skips before decoding
    '-i', filePath,
    '-vn',
    '-map', '0:a:0',
    ...ffmpegCodecArgs,
    ...formatArgs,
    '-threads', '0',
    outPath
  ]

  logger.info(`Playback: seek-extracting ${path.basename(filePath)} from ${seekTime.toFixed(1)}s`)
  const { promise } = runCommand(config.ffmpegPath, args)
  const result = await promise

  if (result.code !== 0) {
    throw new Error(`Seek extraction failed (code ${result.code}): ${result.stderr.slice(-200)}`)
  }

  logger.success(`Playback: seek-extracted ${path.basename(filePath)} @${seekTime.toFixed(1)}s → ${path.basename(outPath)}`)
  return outPath
}

/**
 * Clear the extraction cache for a specific file.
 * Called when the player needs to force re-extraction (e.g. after a
 * playback error - the cached temp file may be corrupt).
 */
export function clearPlaybackCacheFor(filePath: string): void {
  const cached = extractionCache.get(filePath)
  if (cached) {
    extractionCache.delete(filePath)
    try { if (fs.existsSync(cached)) fs.unlinkSync(cached) } catch { /* best effort */ }
    logger.info(`Playback: cleared cache for ${path.basename(filePath)}`)
  }
}

/**
 * Clean up all temp playback files. Call on app quit.
 */
export function cleanupPlaybackTemp(): void {
  const dir = playbackTempDir
  if (!dir || !fs.existsSync(dir)) return
  try {
    const files = fs.readdirSync(dir)
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)) } catch { /* best effort */ }
    }
    fs.rmdirSync(dir)
  } catch { /* best effort */ }
  extractionCache.clear()
  playbackTempDir = null
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Probe the first audio stream's codec name using ffprobe.
 */
async function probeAudioCodec(ffprobePath: string, filePath: string): Promise<string | null> {
  const { spawn } = await import('child_process')
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filePath
    ]
    const proc = spawn(ffprobePath, args, { windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.on('close', () => resolve(out.trim() || null))
    proc.on('error', () => resolve(null))
  })
}

/** Simple string hash for cache filenames. */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
