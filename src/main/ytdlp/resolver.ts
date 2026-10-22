/**
 * @module main/ytdlp/resolver
 * @description YouTube URL resolution and audio stream extraction.
 *
 * Resolves YouTube (and other yt-dlp-supported) URLs into playlist
 * entries and direct audio stream URLs. Prefers non-HLS URLs for
 * instant `<audio>` playback; falls back to downloading via yt-dlp +
 * FFmpeg when only HLS streams are available.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { pathToFileURL } from 'url'
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

/**
 * Get a direct audio stream URL for a video.
 *
 * Tries the strict format filter first. If that fails (e.g. the site
 * only offers HLS), retries without a format restriction and attempts
 * to pick a direct URL manually.  As a last resort downloads the audio
 * to a local temp file.
 */
export async function getAudioStreamUrl(
  videoUrl: string,
  quality: AudioQuality = 'best'
): Promise<ResolvedTrack> {
  const dl = await getYtDl()
  const fmt = FORMAT_STRINGS[quality] || FORMAT_STRINGS.best

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

    const picked = pickDirectAudioUrl(data)
    if (picked) {
      logger.info(`Audio stream: direct URL (protocol=${data.protocol || '?'}, ext=${data.ext || '?'})`)
      return { audioUrl: picked.url, title, duration, httpHeaders: picked.headers }
    }

    // All formats are HLS - download to a local temp file as fallback
    logger.info(`All ${data.formats?.length || 0} formats are HLS for "${title}", downloading audio...`)
    const localPath = await downloadAudioToFile(videoUrl, cookieFlags)
    const fileUrl = pathToFileURL(localPath).href
    logger.info(`Audio downloaded to temp file: ${localPath}`)
    return { audioUrl: fileUrl, title, duration, httpHeaders: {} }
  })
}

/** Downloads a link's best audio into the cache and answers its path, for a stream Chromium could not play. */
export async function getAudioFile(videoUrl: string): Promise<string> {
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

/** The family of a yt-dlp codec string; null for one Chromium never decodes. */
export function codecFamily(codec: string): VideoCodecFamily | null {
  if (/^avc1/.test(codec)) return 'avc1'
  if (/^vp0?9/.test(codec)) return 'vp9'
  if (/^av01/.test(codec)) return 'av01'
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
