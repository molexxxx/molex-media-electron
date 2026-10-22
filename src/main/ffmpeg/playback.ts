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
import { createProbe } from './probe'
import { videoEncoderArgs, videoFilters } from '../jobs/runners/convert'
import { audioTracks, CHROMIUM_AUDIO_CODECS, containerPlays, summarizeProbe, type PlayerMedia, type PlayerStream, type RawProbe, type SoundPlan } from '../../shared/player/media'
import { detectGpuMode, getGpuPreset, getGpuQualityArgs, getHwaccelInputArgs, resolveGpuCodec, type GpuMode } from './gpu'

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
export async function prepareForPlayback(filePath: string, audioIndex = 0): Promise<string> {
  // Already playable → skip extraction
  if (isBrowserNative(filePath) && audioIndex === 0) return filePath

  // Check cache - but validate the file still exists and isn't empty
  const cacheKey = trackKey(filePath, audioIndex)
  const cached = extractionCache.get(cacheKey)
  if (cached) {
    if (fs.existsSync(cached)) {
      const cachedStat = fs.statSync(cached)
      if (cachedStat.size > 0) return cached
      // Cached file is empty/corrupt - remove it
      try { fs.unlinkSync(cached) } catch { /* best effort */ }
      logger.warn(`Playback: removed corrupt memory-cached file ${path.basename(cached)}`)
    }
    extractionCache.delete(cacheKey)
  }

  const config = await getConfig()
  const ffmpegPath = config.ffmpeg?.ffmpegPath
  const ffprobePath = config.ffmpeg?.ffprobePath
  if (!ffmpegPath) throw new Error('FFmpeg not configured')
  if (!ffprobePath) throw new Error('ffprobe not configured')

  // Probe the source to find the chosen audio stream
  const stream = await probeAudioStream(ffprobePath, filePath, audioIndex)
  if (!stream) throw new Error('No audio stream found in file')

  const baseName = path.basename(filePath, path.extname(filePath))
  // Use a hash of the full path to avoid collisions
  const hash = simpleHash(filePath) + trackTag(audioIndex)

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
      extractionCache.set(cacheKey, outPath)
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
    '-vn',
    '-map', `0:a:${audioIndex}`,
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

  extractionCache.set(cacheKey, outPath)
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
export async function prepareForPlaybackAt(filePath: string, seekTime: number, audioIndex = 0): Promise<string> {
  // Browser-native audio files don't go through extraction - seeking is
  // handled directly by the media element and the custom protocol.
  if (isBrowserNative(filePath) && audioIndex === 0) return filePath

  const config = await getConfig()
  const ffmpegPath = config.ffmpeg?.ffmpegPath
  const ffprobePath = config.ffmpeg?.ffprobePath
  if (!ffmpegPath) throw new Error('FFmpeg not configured')
  if (!ffprobePath) throw new Error('ffprobe not configured')

  const stream = await probeAudioStream(ffprobePath, filePath, audioIndex)
  if (!stream) throw new Error('No audio stream found in file')

  const baseName = path.basename(filePath, path.extname(filePath))
  const hash = simpleHash(filePath) + trackTag(audioIndex)
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
    '-map', `0:a:${audioIndex}`,
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
  for (const [key, cached] of [...extractionCache]) {
    if (key !== filePath && !key.startsWith(`${filePath}#`)) continue
    extractionCache.delete(key)
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
  remuxCache.clear()
  subtitleCache.clear()
  playbackTempDir = null
}

/* ------------------------------------------------------------------ */
/*  Pictures, tracks, and subtitles                                    */
/* ------------------------------------------------------------------ */

/** The display a decoded picture is sized for when the renderer names none; a picture is never scaled up past its source. */
export const DEFAULT_DISPLAY_BOX = Object.freeze({ width: 1920, height: 1080 })

/** The media type of a picture FFmpeg decodes for display: fragmented MP4 that Chromium plays while it arrives. */
export const PICTURE_STREAM_TYPE = 'video/mp4'

/** The quality step a display picture is encoded at, on the shared CRF and quantizer scale. */
export const DISPLAY_QUALITY = 23

/** How a picture FFmpeg decodes is handed to Chromium: a hardware H.264 encoder when this computer has one, else x264. */
export interface DisplayEncoder {
  mode: GpuMode
  codec: string
}

/** The software display encoder. */
export const SOFTWARE_DISPLAY_ENCODER: DisplayEncoder = { mode: 'off', codec: 'libx264' }

/** About a second of frames between keyframes, so a seek restarts the picture within a second. */
export function displayGop(fps: number | null): number {
  const rate = fps !== null && Number.isFinite(fps) && fps > 0 ? fps : 30
  return Math.min(60, Math.max(12, Math.round(rate)))
}

/**
 * The encoder arguments of a display picture, tuned for latency rather than quality: the hardware encoder's fastest
 * preset at the shared quality step with no B-frames, or x264's ultrafast preset with its zero-latency tune; both
 * with a short GOP.
 */
export function displayEncoderArgs(encoder: DisplayEncoder, gop: number): string[] {
  if (encoder.mode === 'off' || encoder.mode === 'auto') {
    return [...videoEncoderArgs('libx264', null, 0), '-preset:v:0', 'ultrafast', '-tune:v:0', 'zerolatency', '-g:v:0', String(gop)]
  }
  return ['-c:v:0', encoder.codec, ...getGpuPreset(encoder.mode, 'veryfast'), ...getGpuQualityArgs(encoder.mode, DISPLAY_QUALITY), '-bf:v:0', '0', '-g:v:0', String(gop)]
}

/** The hardware encoder this computer offers for display pictures, found once; software when it has none. */
export async function displayEncoder(ffmpegPath: string): Promise<DisplayEncoder> {
  const mode = await detectGpuMode(ffmpegPath)
  if (mode === 'off' || mode === 'auto') return SOFTWARE_DISPLAY_ENCODER
  const resolved = await resolveGpuCodec(ffmpegPath, 'libx264', mode)
  return resolved.isGpu ? { mode: resolved.activeMode, codec: resolved.codec } : SOFTWARE_DISPLAY_ENCODER
}

/** The file facts a sound plan depends on besides the track itself. */
export interface SoundContext {
  /** ffprobe's format name. */
  container: string
  audioCount: number
}

/**
 * How one audio track plays. A plain audio file's first track, and the only track of a file in a container Chromium
 * reads with a codec it decodes, play as they are; every other track is copied or converted by {@link playbackTarget}.
 * Chromium plays only a file's first audio track, so a file with several tracks always goes through extraction.
 */
export function soundPlanFor(filePath: string, stream: PlayerStream, audioIndex: number, context: SoundContext): SoundPlan {
  const plainAudio = isBrowserNative(filePath) && audioIndex === 0
  const soleNativeTrack = context.audioCount === 1 && containerPlays(context.container) && CHROMIUM_AUDIO_CODECS.has(stream.codec)
  if (plainAudio || soleNativeTrack) {
    return { route: 'direct', audioIndex, streamIndex: stream.index, target: null, remappedTo: null }
  }
  const target = playbackTarget({
    codec: stream.codec,
    channels: stream.channels ?? 2,
    ...(stream.layout === null ? {} : { layout: stream.layout }),
    sampleRate: stream.sampleRate ?? 48000
  })
  return target.mode === 'remux'
    ? { route: 'remux', audioIndex, streamIndex: stream.index, target: null, remappedTo: null }
    : { route: 'convert', audioIndex, streamIndex: stream.index, target: 'opus', remappedTo: target.remappedTo }
}

/** The player's model of a probe: its streams and one sound plan per audio track; the renderer plans the picture. */
export function playerMediaOf(raw: RawProbe, filePath: string): PlayerMedia {
  const summary = summarizeProbe(raw, filePath)
  const tracks = audioTracks(summary.streams)
  const context: SoundContext = { container: summary.container, audioCount: tracks.length }
  return { ...summary, picture: null, sound: tracks.map((stream, i) => soundPlanFor(filePath, stream, i, context)) }
}

/** Probes a file with the configured ffprobe and plans how the player plays it. */
export async function inspectForPlayback(filePath: string): Promise<PlayerMedia> {
  const config = await getConfig()
  const ffprobePath = config.ffmpeg?.ffprobePath
  if (!ffprobePath) throw new Error('ffprobe not configured')
  const raw = await createProbe(ffprobePath)(filePath)
  return playerMediaOf(raw as unknown as RawProbe, filePath)
}

/** What a display picture is sized and encoded for. */
export interface DisplayOptions {
  encoder: DisplayEncoder
  /** The display in physical pixels; the picture fits inside it and never grows past its source size. */
  width: number
  height: number
  /** The source frame rate, for the keyframe interval. */
  fps: number | null
}

/**
 * The FFmpeg arguments of a picture FFmpeg decodes for display from `seekTime` on: hardware decoding where the encoder
 * is hardware, the picture fitted to the display as 8-bit 4:2:0, encoded for latency, with no sound, as fragmented MP4
 * on stdout. Seeking before the input starts the stream exactly at `seekTime`, so a seek restarts it there.
 */
export function pictureDecodeArgs(filePath: string, streamIndex: number, seekTime: number, options: DisplayOptions): string[] {
  const seek = seekTime > 0 ? ['-ss', seekTime.toFixed(3)] : []
  const fit = { maxWidth: Math.max(2, Math.round(options.width)), maxHeight: Math.max(2, Math.round(options.height)), mode: 'fit' as const }
  const filters = videoFilters({ fit, fps: null, pixelFormat: 'yuv420p' }, options.encoder.codec)
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...getHwaccelInputArgs(options.encoder.mode === 'auto' ? 'off' : options.encoder.mode, false),
    ...seek, '-i', filePath,
    '-map', `0:${streamIndex}`, '-an', '-sn', '-dn',
    '-vf', filters.join(','),
    ...displayEncoderArgs(options.encoder, displayGop(options.fps)),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]
}

/** The FFmpeg arguments that copy one picture stream, unchanged, into Matroska with its seek index at the front. */
export function pictureRemuxArgs(filePath: string, streamIndex: number, outPath: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath, '-map', `0:${streamIndex}`, '-c', 'copy', '-an', '-sn', '-dn', '-reserve_index_space', '50000', outPath]
}

/** The FFmpeg arguments that write one text subtitle stream as WebVTT on stdout. */
export function subtitleArgs(filePath: string, streamIndex: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', filePath, '-map', `0:${streamIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1']
}

const remuxCache = new Map<string, Promise<string>>()
const subtitleCache = new Map<string, Promise<string>>()

async function ffmpegPathOrThrow(): Promise<string> {
  const config = await getConfig()
  const ffmpegPath = config.ffmpeg?.ffmpegPath
  if (!ffmpegPath) throw new Error('FFmpeg not configured')
  return ffmpegPath
}

/** Copies a picture stream into a cached Matroska file Chromium reads and seeks; concurrent requests share one copy. */
export function prepareRemuxedPicture(filePath: string, streamIndex: number): Promise<string> {
  const key = `${filePath}#v${streamIndex}`
  const pending = remuxCache.get(key)
  if (pending) return pending
  const work = (async (): Promise<string> => {
    const ffmpegPath = await ffmpegPathOrThrow()
    const outPath = path.join(getTempDir(), `${path.basename(filePath, path.extname(filePath))}_${simpleHash(filePath)}_v${streamIndex}.mkv`)
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath
    logger.info(`Playback: copying the picture of ${path.basename(filePath)} into Matroska`)
    const result = await runCommand(ffmpegPath, pictureRemuxArgs(filePath, streamIndex, outPath)).promise
    if (result.code !== 0) throw new Error(`Picture remux failed (code ${result.code}): ${result.stderr.slice(-200)}`)
    return outPath
  })()
  remuxCache.set(key, work)
  work.catch(() => remuxCache.delete(key))
  return work
}

/** One text subtitle stream as WebVTT, cached per file and stream. */
export function extractSubtitles(filePath: string, streamIndex: number): Promise<string> {
  const key = `${filePath}#s${streamIndex}`
  const pending = subtitleCache.get(key)
  if (pending) return pending
  const work = (async (): Promise<string> => {
    const ffmpegPath = await ffmpegPathOrThrow()
    const result = await runCommand(ffmpegPath, subtitleArgs(filePath, streamIndex), undefined, { log: false }).promise
    if (result.code !== 0) throw new Error(`Subtitle extraction failed (code ${result.code}): ${result.stderr.slice(-200)}`)
    return result.stdout
  })()
  subtitleCache.set(key, work)
  work.catch(() => subtitleCache.delete(key))
  return work
}

/** The command for a picture FFmpeg decodes for display, on this computer's display encoder unless software is asked for. */
export async function pictureDecodeCommand(
  filePath: string,
  streamIndex: number,
  seekTime: number,
  display: { width: number, height: number, fps: number | null, software: boolean }
): Promise<{ command: string, args: string[], encoder: string }> {
  const command = await ffmpegPathOrThrow()
  const encoder = display.software ? SOFTWARE_DISPLAY_ENCODER : await displayEncoder(command)
  return { command, args: pictureDecodeArgs(filePath, streamIndex, seekTime, { encoder, width: display.width, height: display.height, fps: display.fps }), encoder: encoder.codec }
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Probe the first audio stream's codec, channels, layout, and rate using ffprobe.
 */
async function probeAudioStream(ffprobePath: string, filePath: string, audioIndex = 0): Promise<PlaybackStream | null> {
  const { spawn } = await import('child_process')
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-select_streams', `a:${audioIndex}`,
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

/** The cache key of one audio track of a file; track 0 keeps the bare path. */
function trackKey(filePath: string, audioIndex: number): string {
  return audioIndex === 0 ? filePath : `${filePath}#a${audioIndex}`
}

/** The file name tag of one audio track; track 0 has none, so earlier cache files stay valid. */
function trackTag(audioIndex: number): string {
  return audioIndex === 0 ? '' : `_a${audioIndex}`
}

/** Simple string hash for cache filenames. */
function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}
