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
import { chooseEncoder, encoderArgs, type BuildCapabilities } from './audio/encoders'
import { pinStages } from './audio/chains'
import { resolveLayout } from './audio/facts'
import type { AudioFacts } from '../../shared/audio/types'

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

/** The first audio stream as the playback target reads it. */
export interface PlaybackStream {
  codec: string
  channels: number
  /** The probed layout name; absent or unknown takes FFmpeg's default for the channel count. */
  layout?: string
  sampleRate: number
}

/** What a playback extraction writes: the cache extension and the audio arguments after `-map 0:a:0`. */
export interface PlaybackTarget {
  ext: string
  args: string[]
  mode: 'remux' | 'transcode'
  /** The layout written when libopus needed a relabel, such as 5.1(side) written as 5.1; null otherwise. */
  remappedTo: string | null
}

/** The Opus rate per channel pair of the playback transcode. */
export const PLAYBACK_KBPS_PER_PAIR = 192

/** The playback transcode always writes libopus, so its target never depends on the build's other encoders. */
const OPUS_ONLY: BuildCapabilities = { encoders: new Set(['libopus']), experimental: new Set(), soxr: false }

function playbackFacts(stream: PlaybackStream): AudioFacts {
  const { layout, guessed } = resolveLayout(stream.channels, stream.layout)
  return {
    audioIndex: 0,
    streamIndex: 0,
    codecName: stream.codec,
    profile: null,
    channels: stream.channels,
    layout,
    layoutGuessed: guessed,
    sampleRate: stream.sampleRate,
    sampleFmt: null,
    bitsPerRawSample: null,
    bitRate: null,
    durationSec: null,
    language: null,
    title: null,
    disposition: {}
  }
}

/**
 * The output of a playback extraction. A codec Chromium decodes is copied bit for bit, so PCM keeps its depth;
 * any other codec is encoded with libopus into WebM through chooseEncoder, which relabels a layout libopus lacks
 * (5.1(side) is written as 5.1) and pins the rate and layout. A stream libopus cannot write at its own layout,
 * such as more than eight channels or an unnamed layout, is folded to stereo for listening.
 */
export function playbackTarget(stream: PlaybackStream): PlaybackTarget {
  const native = NATIVE_CODEC_MAP[stream.codec]
  if (native) return { ext: native.ext, args: ['-c:a', native.codec], mode: 'remux', remappedTo: null }
  const facts = playbackFacts(stream)
  const policy = { kind: 'codec', codec: 'opus', kbpsPerPair: PLAYBACK_KBPS_PER_PAIR } as const
  const own = chooseEncoder(facts, policy, 'webm', { channels: stream.channels, layout: facts.layout ?? '', minSampleRate: null }, OPUS_ONLY)
  const decision = own.ok ? own : chooseEncoder(facts, policy, 'webm', { channels: 2, layout: 'stereo', minSampleRate: null }, OPUS_ONLY)
  if (!decision.ok) throw new Error(`No playback encoder for ${stream.codec}`)
  const c = decision.choice
  const pin = pinStages({ sampleRate: c.sampleRate, layout: c.layout, pin: c.pin, encoder: c.encoder })
  return {
    ext: 'webm',
    args: [...encoderArgs(c, 0), '-af', pin.join(',')],
    mode: 'transcode',
    remappedTo: c.notes.includes('layout-remapped') ? c.layout : null
  }
}

/** Reads the first audio stream from ffprobe's JSON; null when there is none. */
export function parsePlaybackProbe(json: string): PlaybackStream | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const streams = (parsed as { streams?: unknown } | null)?.streams
  const first = Array.isArray(streams) ? (streams[0] as Record<string, unknown> | undefined) : undefined
  if (!first || typeof first.codec_name !== 'string' || first.codec_name === '') return null
  const channels = Number(first.channels)
  const sampleRate = Number(first.sample_rate)
  return {
    codec: first.codec_name,
    channels: Number.isInteger(channels) && channels > 0 ? channels : 2,
    ...(typeof first.channel_layout === 'string' && first.channel_layout !== '' ? { layout: first.channel_layout } : {}),
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
  }
}

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
  const ffmpegPath = config.ffmpeg?.ffmpegPath
  const ffprobePath = config.ffmpeg?.ffprobePath
  if (!ffmpegPath) throw new Error('FFmpeg not configured')
  if (!ffprobePath) throw new Error('ffprobe not configured')

  // Probe the source to find the first audio stream
  const stream = await probeAudioStream(ffprobePath, filePath)
  if (!stream) throw new Error('No audio stream found in file')

  const baseName = path.basename(filePath, path.extname(filePath))
  // Use a hash of the full path to avoid collisions
  const hash = simpleHash(filePath)

  const target = playbackTarget(stream)
  const outExt = target.ext
  const ffmpegCodecArgs = target.args
  if (target.mode === 'remux') {
    logger.info(`Playback: remuxing ${stream.codec} → .${outExt} (stream copy)`)
  } else {
    const layoutNote = target.remappedTo ? `, written as ${target.remappedTo}` : ''
    logger.info(`Playback: transcoding ${stream.codec} → Opus/WebM${layoutNote}`)
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

  const { promise } = runCommand(ffmpegPath, args)
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
  const ffmpegPath = config.ffmpeg?.ffmpegPath
  const ffprobePath = config.ffmpeg?.ffprobePath
  if (!ffmpegPath) throw new Error('FFmpeg not configured')
  if (!ffprobePath) throw new Error('ffprobe not configured')

  const stream = await probeAudioStream(ffprobePath, filePath)
  if (!stream) throw new Error('No audio stream found in file')

  const baseName = path.basename(filePath, path.extname(filePath))
  const hash = simpleHash(filePath)
  const seekTag = `seek${Math.floor(seekTime)}`

  const target = playbackTarget(stream)
  const outExt = target.ext
  const ffmpegCodecArgs = target.args

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
  const { promise } = runCommand(ffmpegPath, args)
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
 * Probe the first audio stream's codec, channels, layout, and rate using ffprobe.
 */
async function probeAudioStream(ffprobePath: string, filePath: string): Promise<PlaybackStream | null> {
  const { spawn } = await import('child_process')
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels,channel_layout',
      '-of', 'json',
      filePath
    ]
    const proc = spawn(ffprobePath, args, { windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.on('close', () => resolve(parsePlaybackProbe(out)))
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
