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
import { createReadStream, statSync } from 'fs'
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
  '.mov': 'video/quicktime', '.ts': 'video/mp2t'
}

/**
 * Serve a local file with proper Range request support for seeking.
 * Uses a pull-based ReadableStream so Chromium can control the read rate.
 */
function serveLocalFile(filePath: string, request: Request): Response {
  try {
    const stat = statSync(filePath)
    const total = stat.size
    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const rangeHeader = request.headers.get('Range')

    let start = 0
    let end = total - 1

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
      if (match) {
        start = parseInt(match[1], 10)
        end = match[2] ? parseInt(match[2], 10) : total - 1
      }
    }

    // Clamp to valid range
    if (start >= total) start = total - 1
    if (end >= total) end = total - 1

    const chunkSize = end - start + 1
    const stream = createReadStream(filePath, { start, end })

    const body = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: Buffer) => {
          try { controller.enqueue(new Uint8Array(chunk)) } catch { /* closed */ }
        })
        stream.on('end', () => {
          try { controller.close() } catch { /* already closed */ }
        })
        stream.on('error', (err) => {
          logger.error(`media:// stream error for ${filePath}: ${err.message}`)
          try { controller.error(err) } catch { /* already closed */ }
        })
      },
      cancel() {
        stream.destroy()
      }
    })

    const status = rangeHeader ? 206 : 200
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes'
    }
    if (rangeHeader) {
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    }

    return new Response(body, { status, headers })
  } catch (err: any) {
    logger.error(`media:// local file failed: ${err.message}`)
    return new Response('File not found', { status: 404 })
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

    // Check preview files first (editor playback previews)
    const previewPath = previewFiles.get(token)
    if (previewPath) {
      return serveLocalFile(previewPath, request)
    }

    const cdnUrl = resolveStreamToken(token)

    if (!cdnUrl) {
      logger.warn('media:// token not found or expired')
      return new Response('Stream expired or not found', { status: 404 })
    }

    // Local file (HLS download fallback) — serve with Range support
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

      // Validate response — expired CDN URLs return HTML error pages
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
