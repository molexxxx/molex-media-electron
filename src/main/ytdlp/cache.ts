/**
 * @module main/ytdlp/cache
 * @description Stream URL token cache for the `media://` protocol proxy.
 *
 * Maps opaque tokens to YouTube CDN URLs with a 4-hour TTL so the
 * renderer can request `media://<token>` without ever seeing the real
 * CDN URL (which may carry auth cookies).
 */

const streamMap = new Map<string, { url: string; expires: number }>()

/** YouTube CDN URLs expire in ~6 h; use a 4 h TTL to be safe. */
const STREAM_TTL = 4 * 60 * 60 * 1000

/**
 * Store a CDN URL and return an opaque token the renderer can use
 * in a `media://` URL.
 */
export function registerStreamUrl(cdnUrl: string): string {
  const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  streamMap.set(token, { url: cdnUrl, expires: Date.now() + STREAM_TTL })
  return token
}

/**
 * Resolve a token back to its CDN URL, or `null` if expired / unknown.
 */
export function resolveStreamToken(token: string): string | null {
  const entry = streamMap.get(token)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    streamMap.delete(token)
    return null
  }
  return entry.url
}
