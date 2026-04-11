/**
 * @module main/preview-server
 * @description Local HTTP server for all media playback and editor preview.
 *
 * Custom Electron protocols (`media://`) have chronic issues with
 * Chromium's media pipeline - seeking breaks, large files stall, and
 * Range negotiation is unreliable.  A plain HTTP server on localhost
 * gives the `<audio>` / `<video>` element exactly what it expects:
 * standard HTTP Range responses, proper Content-Type, and no
 * custom-protocol quirks.
 *
 * The server binds to 127.0.0.1 on a random port and serves:
 *  - **Local files** registered via {@link registerPreviewPath}
 *  - **CDN streams** (YouTube) registered via {@link registerStreamProxy},
 *    proxied with Range header forwarding using Electron's `net.fetch`.
 */

import * as http from 'http'
import * as fs from 'fs'
import { extname } from 'path'
import { net } from 'electron'
import { logger } from './logger'

/* ------------------------------------------------------------------ */
/*  MIME types                                                         */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.ts': 'video/mp2t',
  '.m4v': 'video/mp4', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.ogv': 'video/ogg', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff',
  '.ac3': 'audio/ac3'
}

/* ------------------------------------------------------------------ */
/*  Token registries                                                   */
/* ------------------------------------------------------------------ */

/** Local file tokens: token → absolute file path. */
const tokenMap = new Map<string, string>()
let nextId = 0

export function registerPreviewPath(filePath: string): string {
  const token = `p${++nextId}`
  tokenMap.set(token, filePath)
  return token
}

export function unregisterPreviewPath(token: string): void {
  tokenMap.delete(token)
}

/** YouTube CDN URLs expire in ~6 h; use a 4 h TTL to be safe. */
const STREAM_TTL = 4 * 60 * 60 * 1000

/** CDN stream tokens: token → { url, expires }. */
const streamMap = new Map<string, { url: string; expires: number }>()

/**
 * Register a remote CDN URL and return a token the renderer can use
 * to stream through this HTTP server.  Tokens expire after 4 hours.
 */
export function registerStreamProxy(cdnUrl: string): string {
  const token = `s${++nextId}`
  streamMap.set(token, { url: cdnUrl, expires: Date.now() + STREAM_TTL })
  return token
}

/** Resolve a stream token to its CDN URL, or null if expired/unknown. */
export function resolveStreamProxy(token: string): string | null {
  const entry = streamMap.get(token)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    streamMap.delete(token)
    return null
  }
  return entry.url
}

/* ------------------------------------------------------------------ */
/*  Server                                                             */
/* ------------------------------------------------------------------ */

let server: http.Server | null = null
let serverPort = 0

/** Start the preview server. Returns the base URL. */
export async function startPreviewServer(): Promise<string> {
  if (server) return `http://127.0.0.1:${serverPort}`

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      // -- CORS preflight --
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders)
        res.end()
        return
      }

      const token = (req.url || '/').slice(1) // strip leading /

      // -- CDN stream proxy (YouTube etc.) --
      const cdnUrl = streamMap.get(token)
      if (cdnUrl) {
        if (Date.now() > cdnUrl.expires) {
          streamMap.delete(token)
          res.writeHead(410, corsHeaders)
          res.end('Stream expired')
          return
        }
        proxyCdn(cdnUrl.url, req, res, corsHeaders)
        return
      }

      // -- Local file serving --
      const filePath = tokenMap.get(token)

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, corsHeaders)
        res.end('Not found')
        return
      }

      const stat = fs.statSync(filePath)
      const total = stat.size
      const ext = extname(filePath).toLowerCase()
      const contentType = MIME[ext] || 'application/octet-stream'
      const rangeHeader = req.headers.range

      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
        if (!match) {
          res.writeHead(416, { ...corsHeaders, 'Content-Range': `bytes */${total}` })
          res.end()
          return
        }

        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : total - 1

        if (start >= total || start < 0 || end < start) {
          res.writeHead(416, { ...corsHeaders, 'Content-Range': `bytes */${total}` })
          res.end()
          return
        }

        const clampedEnd = Math.min(end, total - 1)
        const chunkSize = clampedEnd - start + 1

        res.writeHead(206, {
          ...corsHeaders,
          'Content-Type': contentType,
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${clampedEnd}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        })

        fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res)
      } else {
        // No Range header - serve full file as streamable
        res.writeHead(200, {
          ...corsHeaders,
          'Content-Type': contentType,
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        })

        fs.createReadStream(filePath).pipe(res)
      }
    })

    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (typeof addr === 'object' && addr) {
        serverPort = addr.port
        server = s
        logger.info(`[preview-server] Listening on http://127.0.0.1:${serverPort}`)
        resolve(`http://127.0.0.1:${serverPort}`)
      } else {
        reject(new Error('Failed to bind preview server'))
      }
    })

    s.on('error', (err) => {
      logger.error(`[preview-server] ${err.message}`)
      reject(err)
    })
  })
}

/** Stop the preview server and clear all tokens. */
export function stopPreviewServer(): void {
  if (server) {
    server.close()
    server = null
    serverPort = 0
    tokenMap.clear()
    streamMap.clear()
    logger.info('[preview-server] Stopped')
  }
}

/* ------------------------------------------------------------------ */
/*  CDN proxy (YouTube etc.)                                           */
/* ------------------------------------------------------------------ */

/**
 * Proxy a request to a remote CDN URL, forwarding Range headers for
 * seeking.  Uses Electron's `net.fetch` which shares the session
 * and bypasses CORS restrictions.
 */
function proxyCdn(
  cdnUrl: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsHeaders: Record<string, string>
): void {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
  const range = req.headers.range
  if (range) headers['Range'] = range

  net.fetch(cdnUrl, { headers })
    .then(async (response) => {
      // Expired CDN URLs return HTML error pages
      if (!response.ok) {
        logger.warn(`[preview-server] CDN returned ${response.status}`)
        res.writeHead(response.status, corsHeaders)
        res.end(`CDN returned ${response.status}`)
        return
      }

      const ct = response.headers.get('content-type') || ''
      if (ct.startsWith('text/html') || ct.startsWith('text/xml')) {
        logger.warn(`[preview-server] CDN returned non-audio content-type: ${ct}`)
        res.writeHead(502, corsHeaders)
        res.end('CDN returned non-audio content')
        return
      }

      // Build response headers
      const outHeaders: Record<string, string> = { ...corsHeaders }
      if (ct) outHeaders['Content-Type'] = ct
      const cl = response.headers.get('content-length')
      if (cl) outHeaders['Content-Length'] = cl
      const cr = response.headers.get('content-range')
      if (cr) outHeaders['Content-Range'] = cr
      const ar = response.headers.get('accept-ranges')
      if (ar) outHeaders['Accept-Ranges'] = ar
      outHeaders['Cache-Control'] = 'no-cache'

      res.writeHead(response.status, outHeaders)

      if (!response.body) {
        res.end()
        return
      }

      // Pipe the readable stream from the CDN response
      const reader = response.body.getReader()
      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) { res.end(); return }
          res.write(Buffer.from(value), () => pump())
        }).catch(() => res.end())
      }
      pump()

      // Clean up if the client disconnects mid-stream
      res.on('close', () => reader.cancel().catch(() => {}))
    })
    .catch((err) => {
      logger.error(`[preview-server] CDN fetch failed: ${err.message}`)
      res.writeHead(502, corsHeaders)
      res.end('CDN fetch failed')
    })
}
