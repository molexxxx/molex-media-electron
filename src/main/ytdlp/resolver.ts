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
import { logger } from '../logger'
import { getYtDl, baseFlags } from './binary'
import { withCookieRetry } from './cookies'

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
    return withCookieRetry(async (cookieFlags) => {
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
  return withCookieRetry(async (cookieFlags) => {
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

  return withCookieRetry(async (cookieFlags) => {
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

    const audioUrl = pickDirectAudioUrl(data)
    if (audioUrl) {
      logger.info(`Audio stream: direct URL (protocol=${data.protocol || '?'}, ext=${data.ext || '?'})`)
      return { audioUrl, title, duration }
    }

    // All formats are HLS - download to a local temp file as fallback
    logger.info(`All ${data.formats?.length || 0} formats are HLS for "${title}", downloading audio...`)
    const localPath = await downloadAudioToFile(videoUrl, cookieFlags)
    const fileUrl = `file:///${localPath.replace(/\\/g, '/')}`
    logger.info(`Audio downloaded to temp file: ${localPath}`)
    return { audioUrl: fileUrl, title, duration }
  })
}

/**
 * Pick the best direct (non-HLS) audio URL from yt-dlp JSON output.
 *
 * Probes in order: top-level URL → `requested_formats` → full
 * `formats` list (audio-only first, then a/v).  Returns `null` if
 * every available URL is HLS.
 */
function pickDirectAudioUrl(data: any): string | null {
  const isDirect = (url: string, protocol?: string): boolean =>
    !!url && !isHlsUrl(url) && !isHlsProtocol(protocol)

  // 1. Top-level URL
  if (data.url && isDirect(data.url, data.protocol)) {
    logger.info(`pickDirectAudioUrl: using top-level URL (protocol=${data.protocol})`)
    return data.url
  }

  // 2. requested_formats - audio track from a/v split
  if (data.requested_formats) {
    const direct = data.requested_formats.find(
      (f: any) => f.acodec !== 'none' && isDirect(f.url, f.protocol)
    )
    if (direct?.url) {
      logger.info(`pickDirectAudioUrl: using requested_formats (protocol=${direct.protocol}, ext=${direct.ext})`)
      return direct.url
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
      return best.url
    }

    // 3b. a/v formats as fallback
    const anyDirect = data.formats
      .filter((f: any) => f.acodec !== 'none' && isDirect(f.url, f.protocol))
      .sort((a: any, b: any) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))

    if (anyDirect.length > 0) {
      const best = anyDirect[0]
      logger.info(`pickDirectAudioUrl: using a/v format (protocol=${best.protocol}, ext=${best.ext}, abr=${best.abr || best.tbr})`)
      return best.url
    }
  }

  logger.warn(`pickDirectAudioUrl: no direct audio URL found (top-level protocol=${data.protocol}, formats=${data.formats?.length || 0})`)
  return null
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
