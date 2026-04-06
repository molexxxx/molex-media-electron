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
/*  MIME type lookup for local audio/video files                       */
/* ------------------------------------------------------------------ */

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus', '.webm': 'audio/webm',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.ts': 'video/mp2t'
}

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

/**
 * Serve a local file with proper Range request support for seeking.
 */
function serveLocalFile(filePath: string, request: Request): Response {
  try {
    const stat = statSync(filePath)
    const total = stat.size
    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const rangeHeader = request.headers.get('Range')

    const wrapStream = (stream: ReturnType<typeof createReadStream>): ReadableStream => {
      let closed = false
      return new ReadableStream({
        start(controller) {
          stream.on('data', (chunk: Buffer) => {
            if (!closed) {
              try { controller.enqueue(chunk) } catch { closed = true }
            }
          })
          stream.on('end', () => {
            if (!closed) { closed = true; try { controller.close() } catch { /* ok */ } }
          })
          stream.on('error', (err) => {
            if (!closed) { closed = true; try { controller.error(err) } catch { /* ok */ } }
          })
        },
        cancel() {
          closed = true
          stream.destroy()
        }
      })
    }

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : total - 1
        const chunkSize = end - start + 1

        return new Response(wrapStream(createReadStream(filePath, { start, end })) as any, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    return new Response(wrapStream(createReadStream(filePath)) as any, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes'
      }
    })
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
    const token = decodeURIComponent(request.url.replace('media://', '').replace(/\/$/, ''))
    logger.info(`media:// request for token=${token.slice(0, 8)}...`)

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
      return response
    } catch (err: any) {
      logger.error(`media:// fetch failed: ${err.message}`)
      return new Response('CDN fetch failed', { status: 502 })
    }
  })
}
