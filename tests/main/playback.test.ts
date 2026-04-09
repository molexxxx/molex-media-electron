import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app') }
}))

// Mock config
const mockGetConfig = vi.fn(() => ({
  ffmpegPath: '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe'
}))
vi.mock('../../src/main/config', () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args)
}))

// Mock logger
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn() }
}))

// Mock runner
const mockRunCommand = vi.fn()
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: (...args: any[]) => mockRunCommand(...args)
}))

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => ({ size: 1024 })),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    rmdirSync: vi.fn()
  }
})

// Mock child_process for probeAudioCodec
vi.mock('child_process', () => {
  const EventEmitter = require('events')
  const { Readable } = require('stream')
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter()
      const stdout = new Readable({ read() {} })
      proc.stdout = stdout
      // Emit codec name after a tick
      setTimeout(() => {
        stdout.push('aac\n')
        stdout.push(null)
        proc.emit('close', 0)
      }, 5)
      return proc
    })
  }
})

import {
  isBrowserNative,
  prepareForPlayback,
  prepareForPlaybackAt,
  clearPlaybackCacheFor,
  cleanupPlaybackTemp
} from '../../src/main/ffmpeg/playback'

describe('isBrowserNative', () => {
  // Pure audio formats → true (served directly)
  it('returns true for .mp3', () => {
    expect(isBrowserNative('/path/to/song.mp3')).toBe(true)
  })

  it('returns true for .wav', () => {
    expect(isBrowserNative('/path/to/audio.wav')).toBe(true)
  })

  it('returns true for .flac', () => {
    expect(isBrowserNative('C:\\Music\\track.flac')).toBe(true)
  })

  it('returns true for .m4a', () => {
    expect(isBrowserNative('/path/song.m4a')).toBe(true)
  })

  it('returns true for .ogg', () => {
    expect(isBrowserNative('/path/track.ogg')).toBe(true)
  })

  it('returns true for .opus', () => {
    expect(isBrowserNative('/path/track.opus')).toBe(true)
  })

  it('returns true for .aac', () => {
    expect(isBrowserNative('/path/track.aac')).toBe(true)
  })

  // Video containers → false (must extract audio via FFmpeg)
  it('returns false for .mp4 (video container)', () => {
    expect(isBrowserNative('/video/clip.mp4')).toBe(false)
  })

  it('returns false for .webm (may contain video)', () => {
    expect(isBrowserNative('/path/audio.webm')).toBe(false)
  })

  it('returns false for .mov (video container)', () => {
    expect(isBrowserNative('/video/clip.mov')).toBe(false)
  })

  it('returns false for .m4v (video container)', () => {
    expect(isBrowserNative('/video/clip.m4v')).toBe(false)
  })

  it('returns false for .ogv (video container)', () => {
    expect(isBrowserNative('/video/clip.ogv')).toBe(false)
  })

  it('returns false for .3gp (video container)', () => {
    expect(isBrowserNative('/video/clip.3gp')).toBe(false)
  })

  it('returns false for .mkv', () => {
    expect(isBrowserNative('/video/movie.mkv')).toBe(false)
  })

  it('returns false for .avi', () => {
    expect(isBrowserNative('/video/clip.avi')).toBe(false)
  })

  it('returns false for .wmv', () => {
    expect(isBrowserNative('/video/clip.wmv')).toBe(false)
  })

  it('returns false for .flv', () => {
    expect(isBrowserNative('/video/clip.flv')).toBe(false)
  })

  it('returns false for .wma', () => {
    expect(isBrowserNative('/audio/track.wma')).toBe(false)
  })

  it('returns false for .ac3', () => {
    expect(isBrowserNative('/audio/track.ac3')).toBe(false)
  })

  it('returns false for .mts', () => {
    expect(isBrowserNative('/video/clip.mts')).toBe(false)
  })

  it('returns false for .ts', () => {
    expect(isBrowserNative('/video/clip.ts')).toBe(false)
  })

  it('is case-insensitive via extname', () => {
    expect(isBrowserNative('/path/SONG.MP3')).toBe(true)
    expect(isBrowserNative('/path/VIDEO.MP4')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  prepareForPlayback                                                 */
/* ------------------------------------------------------------------ */

describe('prepareForPlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, stderr: '', killed: false }),
      process: { kill: vi.fn() }
    })
  })

  it('returns original path for browser-native files', async () => {
    const result = await prepareForPlayback('/music/song.mp3')
    expect(result).toBe('/music/song.mp3')
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('returns original path for .wav files', async () => {
    const result = await prepareForPlayback('/music/audio.wav')
    expect(result).toBe('/music/audio.wav')
  })

  it('extracts audio from video container via FFmpeg', async () => {
    const result = await prepareForPlayback('/video/clip.mp4')
    expect(result).toMatch(/clip_.*\.m4a$/)
    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-vn')
    expect(args).toContain('-c:a')
    expect(args).toContain('copy')
  })

  it('adds -movflags +faststart for m4a output', async () => {
    await prepareForPlayback('/video/clip.mp4')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-movflags')
    expect(args).toContain('+faststart')
  })

  it('returns cached file on repeat call', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false) // temp dir ogg cleanup
    const first = await prepareForPlayback('/video/movie.mkv')
    // Second call - the file is now in memory cache; mock existsSync to return true for it
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 5000 } as any)
    const second = await prepareForPlayback('/video/movie.mkv')
    expect(second).toBe(first)
    // runCommand called only once (first extraction)
    expect(mockRunCommand).toHaveBeenCalledTimes(1)
  })

  it('re-extracts when cached file is empty (corrupt)', async () => {
    // First call extracts
    await prepareForPlayback('/video/movie.avi')
    // Second call - cached file exists but is empty
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any)
    await prepareForPlayback('/video/movie.avi')
    expect(mockRunCommand).toHaveBeenCalledTimes(2)
  })

  it('re-extracts when memory-cached file no longer exists on disk', async () => {
    // First call extracts and caches
    await prepareForPlayback('/video/vanished.mkv')
    // Second call - cached path is in memory but file was deleted
    vi.mocked(fs.existsSync).mockReturnValue(false)
    await prepareForPlayback('/video/vanished.mkv')
    expect(mockRunCommand).toHaveBeenCalledTimes(2)
  })

  it('removes corrupted zero-byte disk cache and re-extracts', async () => {
    // existsSync returns true for the output path on disk
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any)
    await prepareForPlayback('/video/zerobyte.mp4')
    // Should have removed empty file and re-extracted
    expect(fs.unlinkSync).toHaveBeenCalled()
    expect(mockRunCommand).toHaveBeenCalled()
  })

  it('throws when FFmpeg is not configured', async () => {
    mockGetConfig.mockResolvedValueOnce({ ffmpegPath: '', ffprobePath: '/usr/bin/ffprobe' } as any)
    await expect(prepareForPlayback('/video/clip.mp4')).rejects.toThrow('FFmpeg not configured')
  })

  it('throws when ffprobe is not configured', async () => {
    mockGetConfig.mockResolvedValueOnce({ ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '' } as any)
    await expect(prepareForPlayback('/video/clip.mp4')).rejects.toThrow('ffprobe not configured')
  })

  it('throws when FFmpeg extraction fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, stderr: 'encoding error', killed: false }),
      process: { kill: vi.fn() }
    })
    await expect(prepareForPlayback('/video/clip.mp4')).rejects.toThrow('Audio extraction failed')
  })

  it('uses disk cache when temp file already exists from previous session', async () => {
    // existsSync returns true for the output file on disk
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 2048 } as any)
    const result = await prepareForPlayback('/video/clip.mp4')
    expect(result).toMatch(/\.m4a$/)
    // Should NOT call runCommand - reused from disk
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('uses webm + reserve_index_space for unknown codecs', async () => {
    // Make probeAudioCodec return 'dts' (not in NATIVE_CODEC_MAP)
    const { spawn } = await import('child_process')
    vi.mocked(spawn).mockImplementationOnce(() => {
      const EventEmitter = require('events')
      const { Readable } = require('stream')
      const proc = new EventEmitter()
      const stdout = new Readable({ read() {} })
      proc.stdout = stdout
      setTimeout(() => { stdout.push('dts\n'); stdout.push(null); proc.emit('close', 0) }, 5)
      return proc as any
    })
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = await prepareForPlayback('/video/surround.mkv')
    expect(result).toMatch(/\.webm$/)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-c:a')
    expect(args).toContain('libopus')
    expect(args).toContain('-reserve_index_space')
    expect(args).toContain('50000')
  })
})

/* ------------------------------------------------------------------ */
/*  prepareForPlaybackAt                                               */
/* ------------------------------------------------------------------ */

describe('prepareForPlaybackAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.statSync).mockReturnValue({ size: 1024 } as any)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, stderr: '', killed: false }),
      process: { kill: vi.fn() }
    })
  })

  it('returns original path for browser-native files', async () => {
    const result = await prepareForPlaybackAt('/music/song.flac', 120)
    expect(result).toBe('/music/song.flac')
  })

  it('extracts from seek position with -ss flag', async () => {
    const result = await prepareForPlaybackAt('/video/movie.mp4', 300)
    expect(result).toMatch(/seek300/)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-ss')
    expect(args).toContain('300')
    // -ss must appear before -i for input seeking
    const ssIdx = args.indexOf('-ss')
    const iIdx = args.indexOf('-i')
    expect(ssIdx).toBeLessThan(iIdx)
  })

  it('reuses existing seek file if present on disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.statSync).mockReturnValue({ size: 2048 } as any)
    await prepareForPlaybackAt('/video/movie.mp4', 60)
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('re-extracts when existing seek file is empty', async () => {
    // existsSync true but statSync returns size 0
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      return String(p).includes('seek60')
    })
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any)
    await prepareForPlaybackAt('/video/movie.mp4', 60)
    expect(mockRunCommand).toHaveBeenCalledTimes(1)
  })

  it('scans temp dir for old seek files to clean up', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    await prepareForPlaybackAt('/video/movie.mp4', 200)
    // readdirSync is called for seek file cleanup scan
    expect(fs.readdirSync).toHaveBeenCalled()
  })

  it('throws when seek extraction fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, stderr: 'seek error details', killed: false }),
      process: { kill: vi.fn() }
    })
    await expect(prepareForPlaybackAt('/video/clip.mp4', 60)).rejects.toThrow('Seek extraction failed')
  })
})

/* ------------------------------------------------------------------ */
/*  clearPlaybackCacheFor                                              */
/* ------------------------------------------------------------------ */

describe('clearPlaybackCacheFor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when file is not in cache', () => {
    clearPlaybackCacheFor('/nonexistent/file.mp4')
    expect(fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('removes cached file from memory and disk', async () => {
    // First, populate the cache by extracting a file
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, stderr: '', killed: false }),
      process: { kill: vi.fn() }
    })
    await prepareForPlayback('/video/cached.mp4')

    // Now clear - the file is in the cache
    vi.mocked(fs.existsSync).mockReturnValue(true)
    clearPlaybackCacheFor('/video/cached.mp4')
    expect(fs.unlinkSync).toHaveBeenCalled()
  })

  it('handles unlinkSync error gracefully when clearing cache', async () => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, stderr: '', killed: false }),
      process: { kill: vi.fn() }
    })
    await prepareForPlayback('/video/cached2.mp4')

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('EPERM') })
    expect(() => clearPlaybackCacheFor('/video/cached2.mp4')).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/*  cleanupPlaybackTemp                                                */
/* ------------------------------------------------------------------ */

describe('cleanupPlaybackTemp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cleans up temp directory and all files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(['file1.webm' as any, 'file2.m4a' as any])
    cleanupPlaybackTemp()
    expect(fs.unlinkSync).toHaveBeenCalled()
  })

  it('handles unlinkSync errors during cleanup', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(['file1.webm' as any])
    vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('EBUSY') })
    expect(() => cleanupPlaybackTemp()).not.toThrow()
  })

  it('handles rmdirSync error during cleanup', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.rmdirSync).mockImplementation(() => { throw new Error('ENOTEMPTY') })
    expect(() => cleanupPlaybackTemp()).not.toThrow()
  })

  it('does nothing when temp dir is null', () => {
    // After a previous cleanup, playbackTempDir is null
    cleanupPlaybackTemp()
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })
})
