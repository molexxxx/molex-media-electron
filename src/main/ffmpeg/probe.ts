/**
 * @module main/ffmpeg/probe
 * @description FFprobe media analysis wrapper.
 *
 * Spawns `ffprobe` with JSON output to extract stream information,
 * format metadata, chapter markers, and disposition flags from media
 * files. Exports typed interfaces (`MediaInfo`, `StreamInfo`) and
 * utility formatters for duration and file size display.
 */

import { spawn } from 'child_process'
import { getConfig } from '../config'
import { logger } from '../logger'

/** One stream as ffprobe's JSON writer reports it; only the fields the app reads are typed. */
export interface ProbeStream {
  index: number
  codec_type?: string
  codec_name?: string
  profile?: string
  channels?: number
  channel_layout?: string
  sample_rate?: string
  sample_fmt?: string
  bits_per_sample?: number
  bits_per_raw_sample?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  time_base?: string
  start_time?: string
  duration?: string
  duration_ts?: number
  bit_rate?: string
  nb_frames?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
}

/** One chapter from `-show_chapters`; times are seconds as decimal strings. */
export interface ProbeChapter {
  id: number
  time_base?: string
  start?: number
  start_time?: string
  end?: number
  end_time?: string
  tags?: Record<string, string>
}

/** The container section from `-show_format`. */
export interface ProbeFormat {
  filename?: string
  nb_streams?: number
  format_name?: string
  format_long_name?: string
  start_time?: string
  duration?: string
  size?: string
  bit_rate?: string
  tags?: Record<string, string>
}

/** What ffprobe reported for one file, with nothing added: no stream, field, or chapter is invented. */
export interface ProbeJson {
  streams: ProbeStream[]
  format: ProbeFormat | null
  chapters: ProbeChapter[]
}

/** Probes one file; the signal stops the ffprobe process and rejects with an AbortError. */
export type Probe = (filePath: string, signal?: AbortSignal) => Promise<ProbeJson>

export interface AudioStream {
  index: number
  codec_name: string
  channels: number
  sample_rate: string
  bit_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
  channel_layout?: string
  profile?: string
  sample_fmt?: string
  /** Bits per decoded sample, from `bits_per_raw_sample` or `bits_per_sample`; absent for lossy codecs. */
  bit_depth?: number
  duration?: string
}

export interface VideoStream {
  index: number
  codec_name: string
  width: number
  height: number
  duration?: string
  bit_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
  r_frame_rate?: string
  pix_fmt?: string
  profile?: string
}

export interface SubtitleStream {
  index: number
  codec_name: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

export interface DataStream {
  index: number
  codec_name: string
  codec_type: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

export interface MediaInfo {
  audioStreams: AudioStream[]
  videoStreams: VideoStream[]
  subtitleStreams: SubtitleStream[]
  dataStreams: DataStream[]
  format: {
    filename: string
    duration: string
    size: string
    bit_rate: string
    format_name: string
    tags?: Record<string, string>
  }
  isVideoFile: boolean
  isAudioOnly: boolean
  chapters?: ProbeChapter[]
}

/** Raised when ffprobe exits cleanly but its output is not a JSON object. */
export class ProbeOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProbeOutputError'
  }
}

/** The ffprobe arguments of a full probe: format, streams, and chapters as JSON, with only errors on stderr. */
export function probeArgs(filePath: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', '-i', filePath]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads ffprobe's JSON output. A missing section reads as empty, entries that
 * are not objects are dropped, and nothing is added.
 * @throws ProbeOutputError when the output is not a JSON object.
 */
export function parseProbeJson(stdout: string): ProbeJson {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new ProbeOutputError('ffprobe printed output that is not JSON')
  }
  if (!isObject(data)) throw new ProbeOutputError('ffprobe printed no JSON object')
  const streams = Array.isArray(data.streams) ? (data.streams.filter(isObject) as unknown as ProbeStream[]) : []
  const chapters = Array.isArray(data.chapters) ? (data.chapters.filter(isObject) as unknown as ProbeChapter[]) : []
  const format = isObject(data.format) ? (data.format as ProbeFormat) : null
  return { streams, format, chapters }
}

/**
 * Bits per decoded sample: `bits_per_raw_sample` when set, else
 * `bits_per_sample`. Null when both are absent or 0, as for lossy codecs.
 */
export function bitDepth(stream: Pick<ProbeStream, 'bits_per_sample' | 'bits_per_raw_sample'>): number | null {
  const raw = Number.parseInt(stream.bits_per_raw_sample ?? '', 10)
  if (Number.isFinite(raw) && raw > 0) return raw
  const bits = stream.bits_per_sample
  return typeof bits === 'number' && bits > 0 ? bits : null
}

const TAG_DURATION = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/
const DURATION_KEY = /^duration(?:-[a-z]+)?$/i

/**
 * A stream's duration in seconds: ffprobe's `duration`, else the
 * `DURATION` tag Matroska writes per stream. Null when neither is present.
 */
export function streamDuration(stream: Pick<ProbeStream, 'duration' | 'tags'>): number | null {
  const direct = Number.parseFloat(stream.duration ?? '')
  if (Number.isFinite(direct) && direct >= 0) return direct
  const key = Object.keys(stream.tags ?? {}).find((k) => DURATION_KEY.test(k))
  const m = key ? TAG_DURATION.exec(String(stream.tags?.[key]).trim()) : null
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function toAudioStream(s: ProbeStream): AudioStream {
  const depth = bitDepth(s)
  const duration = streamDuration(s)
  return {
    index: s.index,
    codec_name: s.codec_name || 'unknown',
    channels: Number(s.channels) || 2,
    sample_rate: s.sample_rate || '48000',
    bit_rate: s.bit_rate,
    tags: s.tags,
    disposition: s.disposition,
    channel_layout: s.channel_layout,
    profile: s.profile,
    sample_fmt: s.sample_fmt,
    ...(depth !== null ? { bit_depth: depth } : {}),
    ...(duration !== null ? { duration: duration.toFixed(6) } : {})
  }
}

/** Shapes a probe into the {@link MediaInfo} the processors read. Streams are only ever the ones ffprobe listed. */
export function toMediaInfo(data: ProbeJson, filePath: string): MediaInfo {
  const of = (type: string): ProbeStream[] => data.streams.filter((s) => s.codec_type === type)
  const audioStreams = of('audio').map(toAudioStream)
  const videoStreams: VideoStream[] = of('video').map((s) => ({
    index: s.index,
    codec_name: s.codec_name || 'unknown',
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    duration: s.duration,
    bit_rate: s.bit_rate,
    tags: s.tags,
    disposition: s.disposition,
    r_frame_rate: s.r_frame_rate,
    pix_fmt: s.pix_fmt,
    profile: s.profile
  }))
  const subtitleStreams: SubtitleStream[] = of('subtitle').map((s) => ({
    index: s.index,
    codec_name: s.codec_name || 'unknown',
    tags: s.tags,
    disposition: s.disposition
  }))
  const dataStreams: DataStream[] = data.streams
    .filter((s) => s.codec_type === 'data' || s.codec_type === 'attachment')
    .map((s) => ({
      index: s.index,
      codec_name: s.codec_name || 'unknown',
      codec_type: s.codec_type as string,
      tags: s.tags,
      disposition: s.disposition
    }))
  const format = data.format ?? {}
  return {
    audioStreams,
    videoStreams,
    subtitleStreams,
    dataStreams,
    format: {
      filename: format.filename || filePath,
      duration: format.duration || '0',
      size: format.size || '0',
      bit_rate: format.bit_rate || '0',
      format_name: format.format_name || 'unknown',
      tags: format.tags
    },
    isVideoFile: videoStreams.length > 0,
    isAudioOnly: videoStreams.length === 0 && audioStreams.length > 0,
    chapters: data.chapters
  }
}

/** The default limit for one ffprobe run. */
export const PROBE_TIMEOUT_MS = 30000

/** Options for {@link createProbe}; `spawn` is a seam for tests. */
export interface ProbeOptions {
  timeoutMs?: number
  spawn?: typeof spawn
}

function abortError(): Error {
  const err = new Error('The probe was canceled')
  err.name = 'AbortError'
  return err
}

function toBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
}

/**
 * Runs ffprobe hidden and resolves with its stdout. Rejects on a non-zero
 * exit (with stderr), a spawn error, the time limit, or the abort signal,
 * and stops the process in the last two cases.
 */
function runProbe(run: typeof spawn, ffprobe: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const proc = run(ffprobe, args, { windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const stop = (error: Error): void => {
      proc.kill()
      finish(() => reject(error))
    }
    const onAbort = (): void => stop(abortError())
    const timer = setTimeout(() => stop(new Error(`ffprobe did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', (d: unknown) => out.push(toBuffer(d)))
    proc.stderr?.on('data', (d: unknown) => err.push(toBuffer(d)))
    proc.on('error', (e: Error) => finish(() => reject(e)))
    proc.on('close', (code: number | null, sig: NodeJS.Signals | null) => finish(() => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`ffprobe exited with ${code ?? sig}: ${Buffer.concat(err).toString('utf8').trim()}`))
    }))
  })
}

/**
 * A config-free probe bound to one ffprobe binary. Each call runs one hidden
 * ffprobe process whose output carries chapters, sample formats, bit depths,
 * and stream durations, and returns what ffprobe reported, unchanged.
 * @param ffprobePath - Absolute path to the ffprobe binary.
 */
export function createProbe(ffprobePath: string, options: ProbeOptions = {}): Probe {
  const run = options.spawn ?? spawn
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return async (filePath, signal) => parseProbeJson(await runProbe(run, ffprobePath, probeArgs(filePath), timeoutMs, signal))
}

/**
 * Probes a media file with the configured ffprobe and returns typed
 * stream, format, and chapter information. Falls back to an audio-only
 * probe when the full output cannot be parsed; never invents a stream.
 *
 * @param filePath - Absolute path to the media file.
 * @returns Detailed media information including audio, video, and subtitle streams.
 * @throws When ffprobe is not configured, fails, or both probes are unreadable.
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const config = await getConfig()
  const ffprobe = config.ffprobePath

  if (!ffprobe) throw new Error('ffprobe path not configured')

  logger.debug(`Probing: ${filePath}`)

  try {
    return toMediaInfo(await createProbe(ffprobe)(filePath), filePath)
  } catch (e) {
    if (!(e instanceof ProbeOutputError)) throw e
    logger.warn(`Primary probe failed for ${filePath}, trying fallback...`)
    return fallbackProbe(ffprobe, filePath)
  }
}

/**
 * Fallback probe that only queries audio streams with a minimal set
 * of entry fields. Used when the full probe fails to parse.
 *
 * @param ffprobe  - Absolute path to the FFprobe binary.
 * @param filePath - Absolute path to the media file.
 * @returns The audio streams ffprobe listed, possibly none, without format details.
 */
async function fallbackProbe(ffprobe: string, filePath: string): Promise<MediaInfo> {
  const args = [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index,codec_name,channels,sample_rate',
    '-of', 'json',
    '-i', filePath
  ]

  let data: ProbeJson
  try {
    data = parseProbeJson(await runProbe(spawn, ffprobe, args, PROBE_TIMEOUT_MS))
  } catch (e) {
    logger.error(`All probe methods failed for ${filePath}`)
    throw new Error(`Could not read media information: ${(e as Error).message}`)
  }

  const audioStreams = data.streams.map((s) => toAudioStream({ ...s, index: Number(s.index) || 0 }))

  return {
    audioStreams,
    videoStreams: [],
    subtitleStreams: [],
    dataStreams: [],
    format: {
      filename: filePath,
      duration: '0',
      size: '0',
      bit_rate: '0',
      format_name: 'unknown'
    },
    isVideoFile: false,
    isAudioOnly: audioStreams.length > 0,
    chapters: []
  }
}

/**
 * Formats a duration in seconds to a human-readable `H:MM:SS` or `M:SS` string.
 * @param seconds - Duration in seconds.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Formats a byte count to a human-readable size string (B / KB / MB / GB).
 * @param bytes - File size in bytes.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
