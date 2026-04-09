import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock electron imports (protocol.ts imports { protocol, net })
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  net: { fetch: vi.fn() }
}))

// Mock logger - serveLocalFile calls logger.error on exceptions
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// Mock ytdlp - protocol.ts imports resolveStreamToken
vi.mock('../../src/main/ytdlp', () => ({
  resolveStreamToken: vi.fn()
}))

import { serveLocalFile } from '../../src/main/protocol'

const DIR = join(tmpdir(), 'molex-test-protocol')
const TEST_FILE = join(DIR, 'test.mp3')
const TEST_DATA = Buffer.alloc(1024, 0x41) // 1 KB of 'A'

describe('serveLocalFile', () => {
  beforeEach(() => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(TEST_FILE, TEST_DATA)
  })

  afterEach(() => {
    try { unlinkSync(TEST_FILE) } catch { /* ok */ }
  })

  // -- 404 --
  it('returns 404 for non-existent file', () => {
    const res = serveLocalFile('/no/such/file.mp3', new Request('media://x'))
    expect(res.status).toBe(404)
  })

  // -- 204 --
  it('returns 204 for empty file', () => {
    writeFileSync(TEST_FILE, Buffer.alloc(0))
    const res = serveLocalFile(TEST_FILE, new Request('media://x'))
    expect(res.status).toBe(204)
  })

  // -- 206 (no Range, small file - always 206 with Content-Range) --
  it('returns 206 with full content and Content-Range when no Range header', () => {
    const res = serveLocalFile(TEST_FILE, new Request('media://x'))
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Length')).toBe('1024')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1023/1024')
  })

  // -- 206 (closed range) --
  it('returns 206 with partial content for bytes=0-99', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=0-99' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Length')).toBe('100')
    expect(res.headers.get('Content-Range')).toBe('bytes 0-99/1024')
    expect(res.headers.get('Accept-Ranges')).toBe('bytes')
  })

  // -- 206 (open-ended range) --
  it('handles open-ended Range (bytes=500-)', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=500-' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Length')).toBe('524')
    expect(res.headers.get('Content-Range')).toBe('bytes 500-1023/1024')
  })

  // -- 206 (last byte) --
  it('handles Range for the very last byte', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=1023-1023' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Length')).toBe('1')
    expect(res.headers.get('Content-Range')).toBe('bytes 1023-1023/1024')
  })

  // -- 416 (start beyond file size) --
  it('returns 416 when start exceeds file size', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=2000-' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(416)
    expect(res.headers.get('Content-Range')).toBe('bytes */1024')
  })

  // -- 416 (start == file size) --
  it('returns 416 when start equals file size', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=1024-' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(416)
  })

  // -- Clamps oversized end --
  it('clamps end value to file size - 1', () => {
    const req = new Request('media://x', { headers: { Range: 'bytes=0-9999' } })
    const res = serveLocalFile(TEST_FILE, req)
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Length')).toBe('1024')
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1023/1024')
  })

  // -- MIME type detection --
  it('detects MIME type from file extension', () => {
    const wavFile = join(DIR, 'test.wav')
    writeFileSync(wavFile, TEST_DATA)
    try {
      const res = serveLocalFile(wavFile, new Request('media://x'))
      expect(res.headers.get('Content-Type')).toBe('audio/wav')
    } finally {
      unlinkSync(wavFile)
    }
  })

  it('uses application/octet-stream for unknown extensions', () => {
    const unkFile = join(DIR, 'test.xyz')
    writeFileSync(unkFile, TEST_DATA)
    try {
      const res = serveLocalFile(unkFile, new Request('media://x'))
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    } finally {
      unlinkSync(unkFile)
    }
  })

  // -- Correct body content --
  it('streams the exact byte range requested', async () => {
    const patternFile = join(DIR, 'pattern.mp3')
    writeFileSync(patternFile, Buffer.from('ABCDEFGHIJ'))
    try {
      const req = new Request('media://x', { headers: { Range: 'bytes=3-7' } })
      const res = serveLocalFile(patternFile, req)
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.toString()).toBe('DEFGH')
    } finally {
      unlinkSync(patternFile)
    }
  })

  it('returns full content as 206 when no Range header', async () => {
    const patternFile = join(DIR, 'full.mp3')
    writeFileSync(patternFile, Buffer.from('HELLO'))
    try {
      const res = serveLocalFile(patternFile, new Request('media://x'))
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Range')).toBe('bytes 0-4/5')
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.toString()).toBe('HELLO')
    } finally {
      unlinkSync(patternFile)
    }
  })

  // -- Cache-Control --
  it('includes Cache-Control: no-cache to prevent stale responses', () => {
    const res = serveLocalFile(TEST_FILE, new Request('media://x'))
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  // -- Video MIME type --
  it('uses video/mp4 for .mp4 files', () => {
    const mp4File = join(DIR, 'test.mp4')
    writeFileSync(mp4File, TEST_DATA)
    try {
      const res = serveLocalFile(mp4File, new Request('media://x'))
      expect(res.headers.get('Content-Type')).toBe('video/mp4')
    } finally {
      unlinkSync(mp4File)
    }
  })

  // -- Chunk-capped serving for open-ended ranges --
  it('caps open-ended Range to 2 MB', () => {
    const bigFile = join(DIR, 'large.mp3')
    const size = 8 * 1024 * 1024 // 8 MB
    const MAX = 2 * 1024 * 1024  // 2 MB cap
    const bigData = Buffer.alloc(size, 0x42)
    writeFileSync(bigFile, bigData)
    try {
      const req = new Request('media://x', { headers: { Range: 'bytes=0-' } })
      const res = serveLocalFile(bigFile, req)
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Length')).toBe(String(MAX))
      expect(res.headers.get('Content-Range')).toBe(`bytes 0-${MAX - 1}/${size}`)
    } finally {
      unlinkSync(bigFile)
    }
  })

  it('caps no-Range-header response to 2 MB', () => {
    const bigFile = join(DIR, 'large2.mp3')
    const size = 6 * 1024 * 1024
    const MAX = 2 * 1024 * 1024
    const bigData = Buffer.alloc(size, 0x43)
    writeFileSync(bigFile, bigData)
    try {
      const res = serveLocalFile(bigFile, new Request('media://x'))
      expect(res.status).toBe(206)
      expect(res.headers.get('Content-Length')).toBe(String(MAX))
      expect(res.headers.get('Content-Range')).toBe(`bytes 0-${MAX - 1}/${size}`)
    } finally {
      unlinkSync(bigFile)
    }
  })
})
