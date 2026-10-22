/**
 * @module main/ytdlp/resolver
 * @description YouTube URL resolution and audio stream extraction.
 *
 * Resolves YouTube (and other yt-dlp-supported) URLs into playlist
 * entries and direct audio stream URLs. Prefers non-HLS URLs for
 * instant `<audio>` playback; a live link, or one offering only HLS,
 * is planned as a stream FFmpeg reads, and downloading through yt-dlp
 * stays the fallback for a recording.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logger } from '../logger'
import { getYtDl, baseFlags } from './binary'
import { withCookieRetry } from './cookies'

/** The yt-dlp errors that mean the site wants a signed-in session, so a cookie-free run is retried with cookies. */
export function needsCookies(message: string): boolean {
  return /sign in|log ?in|age[- ]restricted|confirm your age|private|members[- ]only|not a bot|cookies/i.test(message)
}

/**
 * Runs a yt-dlp request without cookies first, and with the exported cookies only when the site asks for a
 * sign-in. A signed-in session makes YouTube hand out stream URLs bound to that session, which the player's
 * own requests cannot fetch (403), and the site may skip formats for signed-in web clients; a cookie-free run
 * gets plain URLs that play directly. Links that need an account still get the cookies through withCookieRetry.
 */
export async function cookieFreeFirst<T>(fn: (cookieFlags: Record<string, any>) => Promise<T>): Promise<T> {
  try {
    return await fn({})
  } catch (err: any) {
    const message = String(err?.message ?? err)
    if (!needsCookies(message)) throw err
    logger.info('yt-dlp asked for a sign-in; retrying with the exported cookies')
    return withCookieRetry(fn)
  }
}

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** A single entry from a resolved playlist. */
export interface PlaylistEntry {
  id: string
  title: string
  url: string
  duration: number | null
}

/** Resolved audio track ready for streaming. */
export interface ResolvedTrack {
  audioUrl: string
  title: string
  duration: number | null
  /** The request headers yt-dlp sends for this format, which the proxy forwards. */
  httpHeaders: Record<string, string>
  /**
   * Set, with an empty `audioUrl`, when the link is live or offers only HLS: the player streams it through FFmpeg
   * instead of downloading it first, which never finishes for a live stream.
   */
  stream?: { live: boolean }
}

/** Audio quality presets for stream selection. */
export type AudioQuality = 'best' | 'good' | 'low'

/* ------------------------------------------------------------------ */
/*  Playlist resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse the raw yt-dlp JSON into a normalised array of playlist entries.
 */
function parsePlaylistData(data: any, originalUrl: string): PlaylistEntry[] {
  if (!data.entries) {
    return [{
      id: data.id || 'unknown',
      title: data.title || data.id || 'Unknown',
      url: data.webpage_url || data.url || originalUrl,
      duration: data.duration ?? null
    }]
  }
  return data.entries
    .filter((e: any) => e && (e.id || e.url))
    .map((e: any) => ({
      id: e.id || '',
      title: e.title || e.id || 'Unknown',
      url: e.webpage_url || e.url || `https://www.youtube.com/watch?v=${e.id}`,
      duration: e.duration ?? null
    }))
}

/** Return `true` if the URL points to a single video (not a playlist). */
function isSingleVideoUrl(url: string): boolean {
  if (/youtube\.com\/watch\?v=[^&]+$/i.test(url)) return true
  if (/youtu\.be\/[^/?]+$/i.test(url)) return true
  if (/[?&]list=/i.test(url)) return false
  if (/youtube\.com\/(shorts|live)\/[^/?]+/i.test(url)) return true
  if (!/youtube\.com|youtu\.be/i.test(url)) return true
  return false
}

/**
 * Resolve a URL into an array of playlist entries.
 *
 * For single videos the expensive `flatPlaylist` call is skipped -
 * only basic metadata is fetched.  For playlists all entries are
 * resolved in a single request.
 */
export async function resolvePlaylist(url: string): Promise<PlaylistEntry[]> {
  const dl = await getYtDl()

  // Fast path: single video
  if (isSingleVideoUrl(url)) {
    logger.info(`Resolving single video: ${url}`)
    return cookieFreeFirst(async (cookieFlags) => {
      const data = await dl(url, {
        dumpSingleJson: true,
        noPlaylist: true,
        skipDownload: true,
        ...baseFlags(),
        ...cookieFlags
      }) as any
      return [{
        id: data.id || 'unknown',
        title: data.title || data.id || 'Unknown',
        url: data.webpage_url || data.url || url,
        duration: data.duration ?? null
      }]
    })
  }

  // Playlist path
  logger.info(`Resolving playlist: ${url}`)
  return cookieFreeFirst(async (cookieFlags) => {
    const data = await dl(url, {
      flatPlaylist: true,
      dumpSingleJson: true,
      ...baseFlags(),
      ...cookieFlags
    }) as any
    const entries = parsePlaylistData(data, url)
    logger.info(`Playlist resolved: ${entries.length} entries`)
    return entries
  })
}

/* ------------------------------------------------------------------ */
/*  Audio stream URL extraction                                        */
/* ------------------------------------------------------------------ */

/**
 * yt-dlp format strings per quality preset.
 *
 * Prefer direct HTTPS URLs over HLS manifests (m3u8) which `<audio>`
 * cannot play natively.
 */
const FORMAT_STRINGS: Record<AudioQuality, string> = {
  best: 'bestaudio[ext=m4a][protocol=https]/bestaudio[ext=webm][protocol=https]/bestaudio[ext=m4a][protocol=http]/bestaudio[protocol=https]/bestaudio[protocol=http]',
  good: 'bestaudio[ext=m4a][abr<=160][protocol=https]/bestaudio[abr<=160][protocol=https]/bestaudio[abr<=160][protocol=http]/bestaudio[protocol=https]/bestaudio[protocol=http]',
  low:  'worstaudio[ext=m4a][protocol=https]/worstaudio[protocol=https]/worstaudio[protocol=http]'
}

/** Return `true` if the URL is an HLS manifest. */
function isHlsUrl(url: string): boolean {
  return /\.m3u8|\bmanifest\/hls|\/hls_|m3u8/i.test(url)
}

/** Return `true` if the protocol string indicates HLS. */
function isHlsProtocol(protocol: string | undefined): boolean {
  if (!protocol) return false
  return /m3u8|hls/i.test(protocol)
}

/** The format a quality preset falls back to when no plain HTTPS audio exists, so a live or HLS-only link reads in one run. */
const FORMAT_FALLBACKS: Record<AudioQuality, string> = {
  best: 'bestaudio/best',
  good: 'bestaudio/best',
  low: 'worstaudio/worst'
}

/** True when yt-dlp reports the link as live now; a finished broadcast, even one still processing, is a recording. */
export function isLiveData(data: any): boolean {
  return data?.is_live === true || data?.live_status === 'is_live'
}

/** How long a link's yt-dlp reading is reused for its stream sessions; the stream URLs in it outlive this. */
export const LINK_DATA_TTL_MS = 30 * 60 * 1000

const linkData = new Map<string, { data: any, at: number }>()

/** Keeps a link's yt-dlp reading for the stream sessions that follow: seeks, view changes, and restarts. */
export function rememberLinkData(videoUrl: string, data: any): void {
  linkData.set(videoUrl, { data, at: Date.now() })
}

/** True when the link's last reading said it is live, so nothing tries to download it. */
export function knownLive(videoUrl: string): boolean {
  const entry = linkData.get(videoUrl)
  return entry !== undefined && Date.now() - entry.at < LINK_DATA_TTL_MS && isLiveData(entry.data)
}

/** A link's yt-dlp reading with every format, reused while fresh unless `fresh` asks yt-dlp again. */
export async function getLinkData(videoUrl: string, fresh = false): Promise<any> {
  const entry = linkData.get(videoUrl)
  if (!fresh && entry !== undefined && Date.now() - entry.at < LINK_DATA_TTL_MS) return entry.data
  const dl = await getYtDl()
  const data = await cookieFreeFirst(async (cookieFlags) => await dl(videoUrl, {
    dumpSingleJson: true,
    noPlaylist: true,
    ...baseFlags(),
    ...cookieFlags
  }) as any)
  rememberLinkData(videoUrl, data)
  return data
}

/**
 * Get a direct audio stream URL for a video.
 *
 * Asks for plain HTTPS audio first, falling back to any format so a live or HLS-only link reads in the same run;
 * a failed run is retried without a format restriction. A link that is live, or offers no direct audio, answers
 * `stream` instead of a URL: the player streams it through FFmpeg, and downloading it stays the fallback.
 */
export async function getAudioStreamUrl(
  videoUrl: string,
  quality: AudioQuality = 'best'
): Promise<ResolvedTrack> {
  const dl = await getYtDl()
  const fmt = `${FORMAT_STRINGS[quality] || FORMAT_STRINGS.best}/${FORMAT_FALLBACKS[quality] || FORMAT_FALLBACKS.best}`

  return cookieFreeFirst(async (cookieFlags) => {
    let data: any
    try {
      data = await dl(videoUrl, {
        dumpSingleJson: true,
        format: fmt,
        noPlaylist: true,
        ...baseFlags(),
        ...cookieFlags
      }) as any
    } catch {
      logger.warn('yt-dlp format filter failed, retrying without format restriction...')
      data = await dl(videoUrl, {
        dumpSingleJson: true,
        noPlaylist: true,
        ...baseFlags(),
        ...cookieFlags
      }) as any
    }

    const title = data.title || data.id || 'Unknown'
    const duration = data.duration ?? null
    const live = isLiveData(data)

    const picked = live ? null : pickDirectAudioUrl(data)
    if (picked) {
      logger.info(`Audio stream: direct URL (protocol=${data.protocol || '?'}, ext=${data.ext || '?'})`)
      return { audioUrl: picked.url, title, duration, httpHeaders: picked.headers }
    }

    rememberLinkData(videoUrl, data)
    logger.info(live
      ? `"${title}" is live; it streams through FFmpeg`
      : `All ${data.formats?.length || 0} formats are HLS for "${title}"; it streams through FFmpeg`)
    return { audioUrl: '', title, duration, httpHeaders: {}, stream: { live } }
  })
}

/** The refusal for a download of a live link, which would never finish. */
export const LIVE_DOWNLOAD_ERROR = 'A live stream cannot be downloaded'

/** Downloads a link's best audio into the cache and answers its path, for a stream Chromium could not play. */
export async function getAudioFile(videoUrl: string): Promise<string> {
  if (knownLive(videoUrl)) throw new Error(LIVE_DOWNLOAD_ERROR)
  return cookieFreeFirst((cookieFlags) => downloadAudioToFile(videoUrl, cookieFlags))
}

/** The request headers of a yt-dlp format, as plain strings. */
function headersOf(format: any): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(format?.http_headers ?? {})) {
    if (typeof value === 'string' && key.toLowerCase() !== 'host') out[key] = value
  }
  return out
}

/**
 * Pick the best direct (non-HLS) audio URL from yt-dlp JSON output.
 *
 * Probes in order: top-level URL → `requested_formats` → full
 * `formats` list (audio-only first, then a/v).  Returns `null` if
 * every available URL is HLS.
 */
function pickDirectAudioUrl(data: any): { url: string; headers: Record<string, string> } | null {
  const isDirect = (url: string, protocol?: string): boolean =>
    !!url && !isHlsUrl(url) && !isHlsProtocol(protocol)

  // 1. Top-level URL
  if (data.url && isDirect(data.url, data.protocol)) {
    logger.info(`pickDirectAudioUrl: using top-level URL (protocol=${data.protocol})`)
    return { url: data.url, headers: headersOf(data) }
  }

  // 2. requested_formats - audio track from a/v split
  if (data.requested_formats) {
    const direct = data.requested_formats.find(
      (f: any) => f.acodec !== 'none' && isDirect(f.url, f.protocol)
    )
    if (direct?.url) {
      logger.info(`pickDirectAudioUrl: using requested_formats (protocol=${direct.protocol}, ext=${direct.ext})`)
      return { url: direct.url, headers: headersOf(direct) }
    }
  }

  // 3. Full formats list - audio-only first
  if (data.formats) {
    const directAudio = data.formats
      .filter((f: any) => f.acodec !== 'none' && f.vcodec === 'none' && isDirect(f.url, f.protocol))
      .sort((a: any, b: any) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))

    if (directAudio.length > 0) {
      const best = directAudio[0]
      logger.info(`pickDirectAudioUrl: using formats list (protocol=${best.protocol}, ext=${best.ext}, abr=${best.abr || best.tbr})`)
      return { url: best.url, headers: headersOf(best) }
    }

    // 3b. a/v formats as fallback
    const anyDirect = data.formats
      .filter((f: any) => f.acodec !== 'none' && isDirect(f.url, f.protocol))
      .sort((a: any, b: any) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))

    if (anyDirect.length > 0) {
      const best = anyDirect[0]
      logger.info(`pickDirectAudioUrl: using a/v format (protocol=${best.protocol}, ext=${best.ext}, abr=${best.abr || best.tbr})`)
      return { url: best.url, headers: headersOf(best) }
    }
  }

  logger.warn(`pickDirectAudioUrl: no direct audio URL found (top-level protocol=${data.protocol}, formats=${data.formats?.length || 0})`)
  return null
}

/* ------------------------------------------------------------------ */
/*  Picture for a link                                                 */
/* ------------------------------------------------------------------ */

/** A video codec family; the renderer says which ones its Chromium decodes. */
export type VideoCodecFamily = 'avc1' | 'vp9' | 'av01'

/** A link's picture as a direct URL: a progressive file with its own sound, or a video-only DASH stream. */
export interface LinkVideo {
  kind: 'progressive' | 'dash'
  url: string
  httpHeaders: Record<string, string>
  formatId: string
  ext: string
  width: number | null
  height: number | null
  /** yt-dlp's codec string, such as avc1.640028 or vp09.00.40.08. */
  codec: string
  fps: number | null
  hasSound: boolean
}

/**
 * The yt-dlp format selector for a link's picture no taller than `maxHeight`, in the order the player can use
 * them: a video-only H.264 MP4 (the player's sound element is the clock, so a separate stream costs nothing and
 * reaches the cap, where a progressive file stops at 360p), then a progressive H.264 MP4 with AAC sound, then VP9
 * and AV1 video-only streams when the renderer decodes them. Every choice is one plain HTTPS URL; HLS playlists
 * and DASH segment lists never qualify, since Chromium plays neither.
 */
export function videoFormatSelector(maxHeight: number, codecs: readonly VideoCodecFamily[]): string {
  const cap = `[height<=${Math.max(144, Math.round(maxHeight))}]`
  const https = '[protocol=https]'
  const parts = [
    `bv[ext=mp4][vcodec^=avc1]${cap}${https}`,
    `b[ext=mp4][vcodec^=avc1][acodec^=mp4a]${cap}${https}`
  ]
  if (codecs.includes('vp9')) parts.push(`bv[vcodec^=vp09]${cap}${https}`, `bv[vcodec=vp9]${cap}${https}`)
  if (codecs.includes('av01')) parts.push(`bv[vcodec^=av01]${cap}${https}`)
  return parts.join('/')
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The family of a yt-dlp codec string, or of FFmpeg's codec name; null for one Chromium never decodes. */
export function codecFamily(codec: string): VideoCodecFamily | null {
  if (/^(avc[13]|h264$)/.test(codec)) return 'avc1'
  if (/^vp0?9/.test(codec)) return 'vp9'
  if (/^(av01|av1$)/.test(codec)) return 'av01'
  return null
}

/** The chosen format from yt-dlp's JSON as a link picture, or null when it is HLS, segmented, or a codec Chromium cannot decode. */
export function pickLinkVideo(data: any, codecs: readonly VideoCodecFamily[]): LinkVideo | null {
  const url = typeof data?.url === 'string' ? data.url : null
  const codec = typeof data?.vcodec === 'string' ? data.vcodec : ''
  const family = codecFamily(codec)
  if (!url || isHlsUrl(url) || isHlsProtocol(data.protocol) || /dash/i.test(String(data.protocol ?? ''))) return null
  if (family === null || (family !== 'avc1' && !codecs.includes(family))) return null
  const hasSound = typeof data.acodec === 'string' && data.acodec !== 'none'
  return {
    kind: hasSound ? 'progressive' : 'dash',
    url,
    httpHeaders: headersOf(data),
    formatId: String(data.format_id ?? ''),
    ext: String(data.ext ?? ''),
    width: finiteOrNull(data.width),
    height: finiteOrNull(data.height),
    codec,
    fps: finiteOrNull(data.fps),
    hasSound
  }
}

/** Resolves a link's picture as a direct URL; null when the link offers none the player can show that way. */
export async function getLinkVideo(videoUrl: string, maxHeight: number, codecs: readonly VideoCodecFamily[]): Promise<LinkVideo | null> {
  const dl = await getYtDl()
  return cookieFreeFirst(async (cookieFlags) => {
    let data: any
    try {
      data = await dl(videoUrl, {
        dumpSingleJson: true,
        format: videoFormatSelector(maxHeight, codecs),
        noPlaylist: true,
        ...baseFlags(),
        ...cookieFlags
      }) as any
    } catch (err: any) {
      if (/requested format is not available/i.test(String(err?.message ?? err))) {
        logger.info(`Link picture: no direct format up to ${maxHeight}p for ${videoUrl}`)
        return null
      }
      throw err
    }
    const picture = pickLinkVideo(data, codecs)
    if (picture) logger.info(`Link picture: ${picture.kind} ${picture.formatId} ${picture.codec} ${picture.width ?? '?'}x${picture.height ?? '?'}`)
    return picture
  })
}

/** The percent of a yt-dlp `--newline` download line, such as "[download]  43.2% of 10.00MiB"; null for other lines. */
export function parseDownloadProgress(line: string): number | null {
  const match = /\[download\]\s+([\d.]+)%/.exec(line)
  return match ? Number(match[1]) : null
}

/** The selector of a merged download no taller than `maxHeight`: H.264 and AAC in MP4 when the site offers them, else the best the cap allows. */
export function mergedFormatSelector(maxHeight: number): string {
  const cap = `[height<=${Math.max(144, Math.round(maxHeight))}]`
  return `bv*${cap}[ext=mp4]+ba[ext=m4a]/b${cap}[ext=mp4]/bv*${cap}+ba/b${cap}`
}

/**
 * Downloads a link's picture and sound merged into one MP4 in the cache, reporting each percent yt-dlp prints,
 * and answers the file's path. The route for links that offer only HLS or DASH segments.
 */
export async function downloadLinkVideo(videoUrl: string, maxHeight: number, onProgress: (percent: number) => void): Promise<string> {
  if (knownLive(videoUrl)) throw new Error(LIVE_DOWNLOAD_ERROR)
  const dl = await getYtDl()
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true })
  const id = `molex-video-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const outTemplate = path.join(AUDIO_CACHE_DIR, `${id}.%(ext)s`)
  await cookieFreeFirst(async (cookieFlags) => {
    const run = dl.exec(videoUrl, {
      format: mergedFormatSelector(maxHeight),
      mergeOutputFormat: 'mp4',
      output: outTemplate,
      noPlaylist: true,
      newline: true,
      ...baseFlags(),
      ...cookieFlags
    })
    let rest = ''
    run.stdout?.on('data', (chunk: Buffer | string) => {
      rest += chunk.toString()
      const lines = rest.split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const percent = parseDownloadProgress(line)
        if (percent !== null) onProgress(percent)
      }
    })
    await run
  })
  const files = fs.readdirSync(AUDIO_CACHE_DIR).filter((f) => f.startsWith(id) && !/\.part$/.test(f)).map((f) => path.join(AUDIO_CACHE_DIR, f))
  if (files.length === 0) throw new Error('yt-dlp download produced no output file')
  logger.info(`Link picture: downloaded ${path.basename(files[0])}`)
  return files[0]
}

/* ------------------------------------------------------------------ */
/*  Streams through FFmpeg - live and HLS-only links                   */
/* ------------------------------------------------------------------ */

/** One URL FFmpeg reads, with the request headers yt-dlp fetched it with. */
export interface StreamInput {
  url: string
  headers: Record<string, string>
}

/** The sound of a stream session: its input, and its codec as FFmpeg names it, null when the site did not say. */
export interface StreamSoundPart {
  input: number
  codec: string | null
  channels: number | null
  sampleRate: number | null
  /** True when the format may carry no sound, so FFmpeg maps it only if it is there. */
  optional: boolean
}

/** The picture of a stream session: its input, yt-dlp's codec string, and the family Chromium knows it by. */
export interface StreamPicturePart {
  input: number
  codec: string | null
  family: VideoCodecFamily | null
  fps: number | null
}

/** Which formats a stream session reads and what it takes from each. */
export interface LinkStreamPlan {
  live: boolean
  duration: number | null
  inputs: StreamInput[]
  sound: StreamSoundPart | null
  picture: StreamPicturePart | null
  /** True when the link offers a picture, whether or not the session takes it. */
  hasPicture: boolean
}

/** What a stream session asks of the link. */
export interface LinkStreamWant {
  sound: boolean
  picture: boolean
  soundQuality: AudioQuality
  maxHeight: number
  codecs: readonly VideoCodecFamily[]
}

/** Whether a format carries a part: known yes or no, or maybe when yt-dlp could not tell. */
export type Presence = 'yes' | 'no' | 'maybe'

/** Protocols FFmpeg does not read from a single URL. */
const UNSTREAMABLE = /dash|mhtml|f4m|ism/i

/** The formats FFmpeg can read from one URL, in yt-dlp's order (worst first); the reading itself when it lists none. */
export function streamFormats(data: any): any[] {
  const list = Array.isArray(data?.formats) && data.formats.length > 0 ? data.formats : [data]
  return list.filter((f: any) => f && typeof f.url === 'string' && f.url !== '' && !UNSTREAMABLE.test(String(f.protocol ?? '')))
}

/** Whether a format carries a picture: its codec decides, then yt-dlp's audio-only marks, then a height. */
export function videoPresence(f: any): Presence {
  if (f.vcodec === 'none') return 'no'
  if (typeof f.vcodec === 'string' && f.vcodec !== '') return 'yes'
  if (f.video_ext === 'none' || f.resolution === 'audio only') return 'no'
  return typeof f.height === 'number' && f.height > 0 ? 'yes' : 'maybe'
}

/**
 * Whether a format carries sound: its codec decides; with none named, an audio-only rendition does and any other
 * format may. yt-dlp's `audio_ext` reads none for every format with a picture, sound or not, so it is not read.
 */
export function audioPresence(f: any): Presence {
  if (f.acodec === 'none') return 'no'
  if (typeof f.acodec === 'string' && f.acodec !== '') return 'yes'
  return videoPresence(f) === 'no' ? 'yes' : 'maybe'
}

/** yt-dlp's or FFmpeg's audio codec string as FFmpeg's codec name, such as aac for mp4a.40.2; null when unnamed. */
export function audioCodecName(acodec: unknown): string | null {
  if (typeof acodec !== 'string' || acodec === '' || acodec === 'none') return null
  const c = acodec.toLowerCase()
  if (c === 'mp4a.40.34' || c === 'mp4a.6b' || c.startsWith('mp3')) return 'mp3'
  if (c.startsWith('mp4a') || c === 'aac') return 'aac'
  if (c.startsWith('opus')) return 'opus'
  if (c.startsWith('flac')) return 'flac'
  if (c.startsWith('vorbis')) return 'vorbis'
  if (c === 'ac-3' || c.startsWith('ac3')) return 'ac3'
  if (c === 'ec-3' || c.startsWith('eac3')) return 'eac3'
  return c
}

function heightOf(f: any): number {
  return typeof f.height === 'number' && Number.isFinite(f.height) ? f.height : 0
}

/**
 * How good a format's sound is: its audio bitrate, an audio-only format's total bitrate, else a hint from the codec
 * (HE-AAC below other codecs), else 0 when nothing is known.
 */
function soundScore(f: any): number {
  const abr = finiteOrNull(f.abr)
  if (abr !== null && abr > 0) return abr
  const tbr = finiteOrNull(f.tbr)
  if (videoPresence(f) === 'no' && tbr !== null && tbr > 0) return tbr
  const codec = typeof f.acodec === 'string' ? f.acodec.toLowerCase() : ''
  if (codec === '' || codec === 'none') return 0
  return /^mp4a\.40\.(5|29)$/.test(codec) ? 1 : 2
}

/**
 * The format the sound comes from for a quality: an audio-only rendition first, else a format with a picture and
 * sound. Among formats whose sound ranks the same, the one with the smallest picture costs the least to read; yt-dlp
 * lists formats worst first, so a tie goes to the later one, or the earlier one for the low quality.
 */
export function pickSoundFormat(formats: readonly any[], quality: AudioQuality): any | null {
  const order = new Map(formats.map((f, i) => [f, i]))
  const audioOnly = formats.filter((f) => audioPresence(f) === 'yes' && videoPresence(f) === 'no')
  const muxed = formats.filter((f) => audioPresence(f) === 'yes' && videoPresence(f) !== 'no')
  const maybe = formats.filter((f) => audioPresence(f) === 'maybe')
  const pool = audioOnly.length > 0 ? audioOnly : muxed.length > 0 ? muxed : maybe
  if (pool.length === 0) return null
  const scores = pool.map(soundScore)
  const capped = scores.filter((score) => score > 0 && score <= 160)
  const target = quality === 'low' ? Math.min(...scores) : quality === 'good' && capped.length > 0 ? Math.max(...capped) : Math.max(...scores)
  const later = quality === 'low' ? -1 : 1
  return pool
    .filter((f) => soundScore(f) === target)
    .sort((a, b) => (heightOf(a) - heightOf(b)) || later * ((order.get(b) ?? 0) - (order.get(a) ?? 0)))[0]
}

/** The picture format no taller than the cap, preferring one Chromium decodes as it is, then the tallest. */
export function pickPictureFormat(pictures: readonly any[], maxHeight: number, codecs: readonly VideoCodecFamily[]): any | null {
  if (pictures.length === 0) return null
  const order = new Map(pictures.map((f, i) => [f, i]))
  const within = pictures.filter((f) => heightOf(f) === 0 || heightOf(f) <= maxHeight)
  const pool = within.length > 0 ? within : [[...pictures].sort((a, b) => heightOf(a) - heightOf(b))[0]]
  const copyable = pool.filter((f) => {
    const family = typeof f.vcodec === 'string' ? codecFamily(f.vcodec) : null
    return family !== null && (family === 'avc1' || codecs.includes(family))
  })
  const choices = copyable.length > 0 ? copyable : pool
  return [...choices].sort((a, b) => (heightOf(a) - heightOf(b)) || ((finiteOrNull(a.tbr) ?? 0) - (finiteOrNull(b.tbr) ?? 0)) || ((order.get(a) ?? 0) - (order.get(b) ?? 0)))[choices.length - 1]
}

/**
 * The formats a stream session reads for a link's yt-dlp reading: the picture no taller than the cap when the
 * picture is wanted, and the sound from the picture's own format when it carries sound, else from the best
 * audio-only rendition for the quality. Each distinct URL is one FFmpeg input.
 */
export function planLinkStream(data: any, want: LinkStreamWant): LinkStreamPlan {
  const formats = streamFormats(data)
  const pictures = formats.filter((f) => videoPresence(f) === 'yes')
  const inputs: StreamInput[] = []
  const inputOf = (f: any): number => {
    const found = inputs.findIndex((input) => input.url === f.url)
    if (found >= 0) return found
    inputs.push({ url: f.url, headers: headersOf(f) })
    return inputs.length - 1
  }
  const pictureFormat = want.picture ? pickPictureFormat(pictures, want.maxHeight, want.codecs) : null
  let picture: StreamPicturePart | null = null
  if (pictureFormat !== null) {
    const codec = typeof pictureFormat.vcodec === 'string' && pictureFormat.vcodec !== '' ? pictureFormat.vcodec : null
    picture = { input: inputOf(pictureFormat), codec, family: codec === null ? null : codecFamily(codec), fps: finiteOrNull(pictureFormat.fps) }
  }
  let sound: StreamSoundPart | null = null
  if (want.sound) {
    const soundFormat = pictureFormat !== null && audioPresence(pictureFormat) === 'yes' ? pictureFormat : pickSoundFormat(formats, want.soundQuality)
    if (soundFormat !== null) {
      sound = {
        input: inputOf(soundFormat),
        codec: audioCodecName(soundFormat.acodec),
        channels: finiteOrNull(soundFormat.audio_channels),
        sampleRate: finiteOrNull(soundFormat.asr),
        optional: audioPresence(soundFormat) === 'maybe'
      }
    }
  }
  const duration = finiteOrNull(data?.duration)
  return { live: isLiveData(data), duration: duration !== null && duration > 0 ? duration : null, inputs, sound, picture, hasPicture: pictures.length > 0 }
}

/** What ffprobe found in a format yt-dlp could not describe. */
export interface ProbedFormat {
  video: { codec: string, width: number | null, height: number | null } | null
  audio: { codec: string, channels: number | null, sampleRate: number | null } | null
}

/**
 * A reading whose formats yt-dlp could not say carry a picture, such as a bare HLS playlist, filled in from
 * ffprobe: the codecs, the size, and the sound's layout. At most three such formats are probed; a failed probe
 * leaves its format as it was.
 */
export async function withProbedFormats(data: any, probe: (input: StreamInput) => Promise<ProbedFormat | null>): Promise<any> {
  const formats = streamFormats(data)
  const unknown = formats.filter((f) => videoPresence(f) === 'maybe').slice(0, 3)
  if (unknown.length === 0) return data
  const filled = new Map<any, any>()
  for (const f of unknown) {
    const found = await probe({ url: f.url, headers: headersOf(f) }).catch(() => null)
    if (found === null) continue
    filled.set(f, {
      ...f,
      vcodec: found.video?.codec ?? 'none',
      width: found.video?.width ?? f.width ?? null,
      height: found.video?.height ?? f.height ?? null,
      acodec: found.audio?.codec ?? 'none',
      audio_channels: found.audio?.channels ?? f.audio_channels ?? null,
      asr: found.audio?.sampleRate ?? f.asr ?? null
    })
  }
  if (filled.size === 0) return data
  if (!Array.isArray(data?.formats) || data.formats.length === 0) return filled.get(data) ?? data
  return { ...data, formats: data.formats.map((f: any) => filled.get(f) ?? f) }
}

/**
 * A plan whose sound format may carry none, settled by probing that format before FFmpeg runs: FFmpeg refuses an
 * output whose optional map finds nothing, which would end the picture with it. The probed sound brings its codec,
 * so it can be copied; a format without sound leaves the plan without it. A failed probe leaves the plan as it was.
 */
export async function withProbedSound(plan: LinkStreamPlan, probe: (input: StreamInput) => Promise<ProbedFormat | null>): Promise<LinkStreamPlan> {
  const sound = plan.sound
  if (sound === null || !sound.optional) return plan
  const found = await probe(plan.inputs[sound.input]).catch(() => null)
  if (found === null) return plan
  if (found.audio === null) return { ...plan, sound: null }
  return {
    ...plan,
    sound: {
      ...sound,
      codec: audioCodecName(found.audio.codec),
      channels: found.audio.channels ?? sound.channels,
      sampleRate: found.audio.sampleRate ?? sound.sampleRate,
      optional: false
    }
  }
}

/* ------------------------------------------------------------------ */
/*  HLS fallback - download to temp file                               */
/* ------------------------------------------------------------------ */

const AUDIO_CACHE_DIR = path.join(os.tmpdir(), 'molex-audio-cache')

/**
 * Download audio from a URL using yt-dlp + FFmpeg (handles HLS/m3u8).
 * @returns Absolute path to the downloaded audio file.
 */
async function downloadAudioToFile(
  videoUrl: string,
  cookieFlags: Record<string, any>
): Promise<string> {
  const dl = await getYtDl()
  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true })

  const id = `molex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const outTemplate = path.join(AUDIO_CACHE_DIR, `${id}.%(ext)s`)

  await dl(videoUrl, {
    format: 'bestaudio/best',
    extractAudio: true,
    audioFormat: 'opus',
    output: outTemplate,
    noPlaylist: true,
    ...baseFlags(),
    ...cookieFlags
  })

  const files = fs.readdirSync(AUDIO_CACHE_DIR)
    .filter(f => f.startsWith(id))
    .map(f => path.join(AUDIO_CACHE_DIR, f))

  if (files.length === 0) throw new Error('yt-dlp download produced no output file')
  return files[0]
}

/**
 * Remove cached audio files older than {@link maxAgeMs}.
 * Safe to call on app startup.
 */
export function cleanupAudioCache(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(AUDIO_CACHE_DIR)) return
    const now = Date.now()
    let removed = 0
    for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
      const fp = path.join(AUDIO_CACHE_DIR, f)
      try {
        const stat = fs.statSync(fp)
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fp)
          removed++
        }
      } catch { /* ignore */ }
    }
    if (removed > 0) logger.info(`Cleaned up ${removed} cached audio file(s)`)
  } catch { /* ignore */ }
}
