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
 *    proxied with a plain Node request that forwards the Range header and
 *    the headers the source expects.
 */

import * as http from 'http'
import * as https from 'https'
import * as fs from 'fs'
import { spawn, type ChildProcess } from 'child_process'
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

/** CDN stream tokens: token → { url, headers, expires }. */
const streamMap = new Map<string, { url: string; headers: Record<string, string>; expires: number }>()

/**
 * Register a remote CDN URL and return a token the renderer can use
 * to stream through this HTTP server.  Tokens expire after 4 hours.
 * `headers` are the request headers the source expects, such as the
 * User-Agent and Cookie yt-dlp fetched the URL with.
 */
export function registerStreamProxy(cdnUrl: string, headers: Record<string, string> = {}): string {
  const token = `s${++nextId}`
  streamMap.set(token, { url: cdnUrl, headers, expires: Date.now() + STREAM_TTL })
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

/** A command whose stdout is served as one unseekable stream, such as a picture converted while it plays. */
export interface LiveStream {
  command: string
  args: string[]
  contentType: string
}

/** Live stream tokens: token to the command each request runs. */
const liveMap = new Map<string, LiveStream>()

/** The processes feeding live responses, stopped when their client leaves or the server stops. */
const liveProcesses = new Set<ChildProcess>()

/** Registers a command whose output each request streams; the request's end stops the command. */
export function registerLiveStream(stream: LiveStream): string {
  const token = `l${++nextId}`
  liveMap.set(token, stream)
  return token
}

export function unregisterLiveStream(token: string): void {
  liveMap.delete(token)
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
        proxyCdn(cdnUrl.url, cdnUrl.headers, req, res, corsHeaders)
        return
      }

      // -- Live command output (converted pictures) --
      const live = liveMap.get(token)
      if (live) {
        serveLive(live, req, res, corsHeaders)
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
    liveMap.clear()
    for (const proc of liveProcesses) proc.kill()
    liveProcesses.clear()
    logger.info('[preview-server] Stopped')
  }
}

/* ------------------------------------------------------------------ */
/*  Live command output                                                */
/* ------------------------------------------------------------------ */

/**
 * Runs a live stream's command for one request and pipes its stdout as an unseekable 200 response. The process
 * stops when the client closes the connection, as a media element does when its source changes.
 */
function serveLive(live: LiveStream, req: http.IncomingMessage, res: http.ServerResponse, corsHeaders: Record<string, string>): void {
  const headers = { ...corsHeaders, 'Content-Type': live.contentType, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'none' }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  const proc = spawn(live.command, live.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  liveProcesses.add(proc)
  let stderr = ''
  let clientGone = false
  proc.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000) })
  res.writeHead(200, headers)
  proc.stdout?.pipe(res)
  proc.on('error', (err) => {
    liveProcesses.delete(proc)
    logger.error(`[preview-server] Live stream failed to start: ${err.message}`)
    res.end()
  })
  proc.on('close', (code) => {
    liveProcesses.delete(proc)
    if (code !== 0 && !clientGone) logger.warn(`[preview-server] Live stream ended with code ${code}: ${stderr.trim().slice(-300)}`)
    res.end()
  })
  res.on('close', () => {
    clientGone = true
    if (proc.exitCode === null) proc.kill()
  })
}

/* ------------------------------------------------------------------ */
/*  CDN proxy (YouTube etc.)                                           */
/* ------------------------------------------------------------------ */

/** The most redirects a CDN request follows. */
export const PROXY_MAX_REDIRECTS = 5

/** The User-Agent a CDN request carries when the source named none. */
export const PROXY_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

/**
 * The headers a CDN request carries: the source's own headers (User-Agent, Accept, Cookie, and the rest yt-dlp
 * fetched the URL with), the default User-Agent when the source named none, and the client's Range. Nothing
 * else is added, since a browser's extra headers make some CDNs refuse a URL that was issued to another client.
 */
export function proxyRequestHeaders(sourceHeaders: Record<string, string>, range: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'range') headers[key] = value
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')) headers['User-Agent'] = PROXY_DEFAULT_USER_AGENT
  if (range) headers['Range'] = range
  return headers
}

/** The response headers a CDN answer passes through to the media element. */
export function proxyResponseHeaders(status: number, incoming: http.IncomingHttpHeaders, corsHeaders: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...corsHeaders, 'Cache-Control': 'no-cache' }
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = incoming[name]
    if (typeof value === 'string' && value !== '') out[name] = value
  }
  if (status === 206 && !out['accept-ranges']) out['accept-ranges'] = 'bytes'
  return out
}

/**
 * Proxies a request to a remote CDN URL with a plain Node request, forwarding the Range header for seeking and
 * the headers the source expects, and following redirects. Electron's own fetch adds the headers a browser
 * sends, which some CDNs answer with 403 for a URL they issued to another client.
 */
function proxyCdn(
  cdnUrl: string,
  sourceHeaders: Record<string, string>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsHeaders: Record<string, string>,
  redirects = 0
): void {
  let target: URL
  try {
    target = new URL(cdnUrl)
  } catch {
    res.writeHead(502, corsHeaders)
    res.end('Bad stream URL')
    return
  }
  const client = target.protocol === 'http:' ? http : https
  const upstream = client.request(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: proxyRequestHeaders(sourceHeaders, req.headers.range) }, (answer) => {
    const status = answer.statusCode ?? 502
    const location = answer.headers.location
    if (status >= 300 && status < 400 && location && redirects < PROXY_MAX_REDIRECTS) {
      answer.resume()
      proxyCdn(new URL(location, target).href, sourceHeaders, req, res, corsHeaders, redirects + 1)
      return
    }
    if (status < 200 || status >= 300) {
      logger.warn(`[preview-server] CDN returned ${status}`)
      answer.resume()
      res.writeHead(status, corsHeaders)
      res.end(`CDN returned ${status}`)
      return
    }
    const type = String(answer.headers['content-type'] ?? '')
    if (type.startsWith('text/html') || type.startsWith('text/xml')) {
      logger.warn(`[preview-server] CDN returned non-media content-type: ${type}`)
      answer.resume()
      res.writeHead(502, corsHeaders)
      res.end('CDN returned non-media content')
      return
    }
    res.writeHead(status, proxyResponseHeaders(status, answer.headers, corsHeaders))
    answer.pipe(res)
    res.on('close', () => answer.destroy())
  })
  upstream.on('error', (err) => {
    logger.error(`[preview-server] CDN request failed: ${err.message}`)
    if (!res.headersSent) res.writeHead(502, corsHeaders)
    res.end('CDN request failed')
  })
  req.on('close', () => upstream.destroy())
  upstream.end()
}
