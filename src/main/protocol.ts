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
      try {
        const fileUrl = `file:///${previewPath.replace(/\\/g, '/')}`
        const resp = await net.fetch(fileUrl, {
          headers: request.headers
        })
        return resp
      } catch (err: any) {
        logger.error(`media:// preview file failed: ${err.message}`)
        return new Response('Preview file not found', { status: 404 })
      }
    }

    const cdnUrl = resolveStreamToken(token)

    if (!cdnUrl) {
      logger.warn('media:// token not found or expired')
      return new Response('Stream expired or not found', { status: 404 })
    }

    // Local file (HLS download fallback) — serve via net.fetch
    if (cdnUrl.startsWith('file:///')) {
      try {
        const resp = await net.fetch(cdnUrl)
        logger.info(`media:// local file: ${resp.status} type=${resp.headers.get('content-type')}`)
        return resp
      } catch (err: any) {
        logger.error(`media:// local file failed: ${err.message}`)
        return new Response('File not found', { status: 404 })
      }
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
