/**
 * @module main/ytdlp/net
 * @description The HTTPS transport for yt-dlp release lookups and downloads: GitHub hosts only, bounded
 * redirects and sizes, a stall timeout, and a SHA-256 computed while a download streams to disk.
 */

import * as https from 'https'
import * as fs from 'fs'
import { once } from 'events'
import { createHash } from 'crypto'
import type { IncomingMessage } from 'http'

/** A response whose status was neither success nor a redirect. */
export class HttpStatusError extends Error
{
  constructor(readonly url: string, readonly status: number)
  {
    super(`${url} answered with status ${status}`)
    this.name = 'HttpStatusError'
  }
}

/** A response larger than the caller allows. */
export class TooLargeError extends Error
{
  constructor(readonly url: string, readonly limit: number)
  {
    super(`${url} is larger than ${limit} bytes`)
    this.name = 'TooLargeError'
  }
}

/** A URL, or a redirect to one, outside HTTPS on GitHub's hosts. */
export class RefusedUrlError extends Error
{
  constructor(readonly url: string)
  {
    super(`Refusing to fetch ${url}`)
    this.name = 'RefusedUrlError'
  }
}

/** A connection that stopped sending for {@link STALL_MS}; it carries the code a socket timeout has. */
function stalled(url: string): Error
{
  return Object.assign(new Error(`${url} stalled`), { code: 'ETIMEDOUT' })
}

/** Options of {@link Http.download}. */
export interface DownloadOptions
{
  maxBytes: number
  /** Bytes received so far and the whole size when the server sent it. */
  onProgress(received: number, total: number | null): void
}

/** What the updater needs from the network. */
export interface Http
{
  getJson(url: string, maxBytes: number): Promise<unknown>
  getBuffer(url: string, maxBytes: number): Promise<Buffer>
  /** Where a URL redirects to, without following it; null when it answers without a redirect. */
  redirectTarget(url: string): Promise<string | null>
  /** Streams a URL into a new file (it must not exist) and answers its size and SHA-256. */
  download(url: string, file: string, options: DownloadOptions): Promise<{ bytes: number; sha256: string }>
}

/** The `https.get` shape the transport calls; tests pass a fake. */
export type HttpsGet = (url: string, options: https.RequestOptions, callback: (res: IncomingMessage) => void) => { on(event: 'error', listener: (err: Error) => void): unknown; setTimeout(ms: number, listener: () => void): unknown; destroy(err?: Error): unknown }

const MAX_REDIRECTS = 5
/** How long a connection may send nothing before it is dropped. */
export const STALL_MS = 30_000
const USER_AGENT = 'molexMedia'

/** Whether a URL may be requested: HTTPS on GitHub or its release asset hosts. */
export function allowedUrl(url: string): boolean
{
  let parsed: URL
  try
  {
    parsed = new URL(url)
  }
  catch
  {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return parsed.protocol === 'https:' && (host === 'github.com' || host === 'api.github.com' || host.endsWith('.githubusercontent.com'))
}

function declaredLength(res: IncomingMessage): number | null
{
  const value = Number(res.headers['content-length'])
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** The transport over `get`, which defaults to Node's `https.get`. */
export function createHttp(get: HttpsGet = https.get as unknown as HttpsGet): Http
{
  function request(url: string, accept: string, follow: boolean, depth = 0): Promise<IncomingMessage>
  {
    if (!allowedUrl(url))
    {
      return Promise.reject(new RefusedUrlError(url))
    }
    return new Promise((resolve, reject) =>
    {
      const req = get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': accept } }, (res) =>
      {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (follow && status >= 300 && status < 400 && location)
        {
          res.resume()
          if (depth >= MAX_REDIRECTS)
          {
            reject(new Error(`${url} redirected too many times`))
            return
          }
          request(new URL(location, url).toString(), accept, follow, depth + 1).then(resolve, reject)
          return
        }
        if (follow && status !== 200)
        {
          res.resume()
          reject(new HttpStatusError(url, status))
          return
        }
        resolve(res)
      })
      req.on('error', reject)
      req.setTimeout(STALL_MS, () => req.destroy(stalled(url)))
    })
  }

  async function readAll(url: string, accept: string, maxBytes: number): Promise<Buffer>
  {
    const res = await request(url, accept, true)
    const declared = declaredLength(res)
    if (declared !== null && declared > maxBytes)
    {
      res.destroy()
      throw new TooLargeError(url, maxBytes)
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res as AsyncIterable<Buffer>)
    {
      total += chunk.length
      if (total > maxBytes)
      {
        res.destroy()
        throw new TooLargeError(url, maxBytes)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  return {
    async getJson(url, maxBytes)
    {
      const body = await readAll(url, 'application/vnd.github+json', maxBytes)
      return JSON.parse(body.toString('utf8')) as unknown
    },

    getBuffer: (url, maxBytes) => readAll(url, 'application/octet-stream', maxBytes),

    async redirectTarget(url)
    {
      const res = await request(url, 'text/html', false)
      res.resume()
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location)
      {
        return new URL(location, url).toString()
      }
      if (status !== 200)
      {
        throw new HttpStatusError(url, status)
      }
      return null
    },

    async download(url, file, options)
    {
      const res = await request(url, 'application/octet-stream', true)
      const total = declaredLength(res)
      if (total !== null && total > options.maxBytes)
      {
        res.destroy()
        throw new TooLargeError(url, options.maxBytes)
      }
      const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o755 })
      let writeError: Error | null = null
      out.on('error', (err) =>
      {
        writeError = err
      })
      const hash = createHash('sha256')
      let received = 0
      try
      {
        for await (const chunk of res as AsyncIterable<Buffer>)
        {
          if (writeError)
          {
            throw writeError
          }
          received += chunk.length
          if (received > options.maxBytes)
          {
            throw new TooLargeError(url, options.maxBytes)
          }
          hash.update(chunk)
          if (!out.write(chunk))
          {
            await once(out, 'drain')
          }
          options.onProgress(received, total)
        }
        const closed = once(out, 'close')
        out.end()
        await closed
        if (writeError)
        {
          throw writeError
        }
        return { bytes: received, sha256: hash.digest('hex') }
      }
      catch (err)
      {
        res.destroy()
        out.destroy()
        throw err
      }
    }
  }
}
