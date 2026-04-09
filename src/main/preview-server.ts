/**
 * @module main/preview-server
 * @description Lightweight local HTTP server for editor media preview.
 *
 * Custom Electron protocols (`media://`) have chronic issues with
 * Chromium's media pipeline - seeking breaks, large files stall, and
 * Range negotiation is unreliable.  A plain HTTP server on localhost
 * gives the `<video>` element exactly what it expects: standard HTTP
 * Range responses, proper Content-Type, and no custom-protocol quirks.
 *
 * The server binds to 127.0.0.1 on a random port and only serves
 * files that have been explicitly registered via `registerPreviewPath`.
 */

import * as http from 'http'
import * as fs from 'fs'
import { extname } from 'path'
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
/*  Token registry                                                     */
/* ------------------------------------------------------------------ */

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
    logger.info('[preview-server] Stopped')
  }
}
