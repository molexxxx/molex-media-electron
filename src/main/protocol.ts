/**
 * @module main/protocol
 * @description Custom `media://` protocol registration and handler.
 *
 * The `media://` scheme is registered as privileged before `app.ready`
 * so that `<audio>` and `<video>` elements can load from it.  The
 * handler proxies YouTube CDN audio streams (preserving Range headers
 * for seeking) and serves locally-downloaded HLS fallback files.
 */

import { protocol, net } from 'electron'
import { openSync, readSync, closeSync, statSync, existsSync } from 'fs'
import { extname } from 'path'
import { logger } from './logger'
import { resolveStreamToken } from './ytdlp'

/* ------------------------------------------------------------------ */
/*  Preview file registry (editor playback for non-browser formats)    */
/* ------------------------------------------------------------------ */

const previewFiles = new Map<string, string>()

/** Register a local file path and return a token for media:// access. */
export function registerPreviewFile(filePath: string): string {
  const token = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  previewFiles.set(token, filePath)
  return token
}

/** Remove a preview token (cleanup). */
export function unregisterPreviewFile(token: string): void {
  previewFiles.delete(token)
}

/**
 * Register `media://` as a privileged scheme.
 * **Must** be called before `app.ready`.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: {
        standard: false,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: true
      }
    }
  ])
}

/* ------------------------------------------------------------------ */
/*  MIME type lookup for local audio/video files                       */
/* ------------------------------------------------------------------ */

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus', '.webm': 'audio/webm',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.ts': 'video/mp2t', '.m4v': 'video/mp4',
  '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.ogv': 'video/ogg',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.aiff': 'audio/aiff',
  '.ac3': 'audio/ac3'
}

/**
 * Serve a local file with proper HTTP Range support for seeking.
 *
 * Reads the requested byte range into a `Buffer` using synchronous
 * `fs.readSync` - this is reliable with Electron's Chromium layer
 * (unlike `Readable.toWeb()` which produces Node.js Web Streams that
 * can cause PIPELINE_ERROR_READ on seek).  For large files without a
 * Range header the response is capped at {@link MAX_CHUNK} bytes and
 * returned as 206 so the media element requests subsequent ranges.
 *
 * @internal Exported for testing only.
 */

export function serveLocalFile(filePath: string, request: Request): Response {
  try {
    if (!existsSync(filePath)) {
      return new Response('File not found', { status: 404 })
    }

    const stat = statSync(filePath)
    const total = stat.size
    if (total === 0) {
      return new Response(null, { status: 204 })
    }

    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const rangeHeader = request.headers.get('Range')

    // Cap open-ended range requests to avoid huge buffer allocations.
    // The browser sends `bytes=0-` on first load and seeks with
    // `bytes=N-` (no end) - without a cap these can try to alloc
    // hundreds of MB for large extracted audio files.
    const MAX_CHUNK = 2 * 1024 * 1024 // 2 MB

    let start = 0
    let end = total - 1
    let openEnded = true

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
      if (match) {
        start = parseInt(match[1], 10)
        openEnded = !match[2]
        end = match[2] ? parseInt(match[2], 10) : total - 1
      }

      // Validate range
      if (start >= total || start < 0 || end < start) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` }
        })
      }
      end = Math.min(end, total - 1)
    }

    // Only cap when no explicit end byte was given (open-ended).
    // Precise ranges like bytes=100-200 are served exactly.
    if (openEnded && (end - start + 1) > MAX_CHUNK) {
      end = Math.min(start + MAX_CHUNK - 1, total - 1)
    }

    const chunkSize = end - start + 1
    const fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(chunkSize)
    readSync(fd, buffer, 0, chunkSize, start)
    closeSync(fd)

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Content-Range': `bytes ${start}-${end}/${total}`
    }

    // Always 206 - tells the media element that Range requests are
    // supported and communicates the full file size via Content-Range.
    return new Response(buffer, { status: 206, headers })
  } catch (err: any) {
    logger.error(`media:// local file error: ${err.message}`)
    return new Response('File read error', { status: 500 })
  }
}

/**
 * Install the `media://` protocol handler.
 * Called once inside `app.whenReady()`.
 */
export function registerMediaHandler(): void {
  protocol.handle('media', async (request) => {
    const raw = request.url
    const token = decodeURIComponent(raw.replace('media://', '').replace(/\/$/, ''))
    const rangeInfo = request.headers.get('Range') || 'none'
    logger.info(`media:// url=${raw.slice(0, 50)}... range=${rangeInfo}`)

    // Check preview files (editor playback previews)
    const previewPath = previewFiles.get(token)
    if (previewPath) {
      return serveLocalFile(previewPath, request)
    }

    const cdnUrl = resolveStreamToken(token)

    if (!cdnUrl) {
      logger.warn('media:// token not found or expired')
      return new Response('Stream expired or not found', { status: 404 })
    }

    // Local file (HLS download fallback) - serve with Range support
    if (cdnUrl.startsWith('file:///')) {
      const filePath = decodeURIComponent(cdnUrl.replace('file:///', '').replace(/\//g, '\\'))
      return serveLocalFile(filePath, request)
    }

    // Forward to the real CDN URL, preserving Range headers for seeking
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    const range = request.headers.get('Range')
    if (range) headers['Range'] = range

    try {
      const response = await net.fetch(cdnUrl, { headers })
      logger.info(`media:// CDN response: ${response.status} type=${response.headers.get('content-type')}`)

      // Validate response - expired CDN URLs return HTML error pages
      if (!response.ok) {
        logger.warn(`media:// CDN returned ${response.status} for token=${token.slice(0, 8)}`)
        return new Response(`CDN returned ${response.status}`, { status: response.status })
      }

      const ct = response.headers.get('content-type') || ''
      if (ct.startsWith('text/html') || ct.startsWith('text/xml')) {
        logger.warn(`media:// CDN returned non-audio content-type: ${ct}`)
        return new Response('CDN returned non-audio content', { status: 502 })
      }

      return response
    } catch (err: any) {
      logger.error(`media:// fetch failed: ${err.message}`)
      return new Response('CDN fetch failed', { status: 502 })
    }
  })
}
