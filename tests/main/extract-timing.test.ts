/**
 * Tests for extract's time-range arithmetic and subtitle validation.
 *
 * Two defects motivated these:
 *
 *   - `count` mode spaced frames across the whole file rather than the
 *     selected range, so asking for 6 frames from a 1-second window of a
 *     3-second source produced 2 (measured).
 *   - Extracting an image-based subtitle to a text format failed deep in
 *     FFmpeg with "Subtitle encoding currently only possible from text to
 *     text or bitmap to bitmap" (measured) instead of being refused up
 *     front with an explanation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a)
}))

const mockProbeMedia = vi.fn()
vi.mock('../../src/main/ffmpeg/probe', () => ({
  probeMedia: (...a: unknown[]) => mockProbeMedia(...a),
  formatDuration: vi.fn((s: number) => `${Math.floor(s)}s`),
  formatFileSize: vi.fn((b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`)
}))

const mockRunCommand = vi.fn()
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: (...a: unknown[]) => mockRunCommand(...a),
  parseProgress: vi.fn(() => ({ time: 1, speed: '2x', size: '10kB' }))
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 1000 })),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => [])
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import {
  extractAudio,
  parseTimeToSeconds,
  effectiveDuration
} from '../../src/main/ffmpeg/processor/extract'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioBitrate: '256k',
  outputDirectory: '/out',
  tempSuffix: '_temp',
  afterProcessing: 'output'
}

function probe(over: Record<string, unknown> = {}) {
  return {
    audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000' }],
    videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
    subtitleStreams: [],
    format: { duration: '120', size: '5000000', format_name: 'matroska' },
    isVideoFile: true,
    isAudioOnly: false,
    ...over
  }
}

function task(over: Partial<ProcessingTask> = {}): ProcessingTask {
  return {
    id: 'ex-1',
    filePath: '/media/movie.mkv',
    fileName: 'movie.mkv',
    operation: 'extract',
    status: 'queued',
    progress: 0,
    message: '',
    ...over
  }
}

function argv(): string[] {
  return mockRunCommand.mock.calls[0]?.[1] as string[]
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetConfig.mockResolvedValue(baseConfig)
  mockProbeMedia.mockResolvedValue(probe())
  mockRunCommand.mockReturnValue({
    promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
    process: { kill: vi.fn() }
  })
})

/* ------------------------------------------------------------------ */
/*  Time parsing                                                       */
/* ------------------------------------------------------------------ */

describe('parseTimeToSeconds', () => {
  it('parses plain seconds', () => {
    expect(parseTimeToSeconds('12')).toBe(12)
    expect(parseTimeToSeconds('1.5')).toBe(1.5)
  })

  it('parses mm:ss and hh:mm:ss', () => {
    expect(parseTimeToSeconds('01:30')).toBe(90)
    expect(parseTimeToSeconds('00:01:30')).toBe(90)
    expect(parseTimeToSeconds('01:00:00')).toBe(3600)
    expect(parseTimeToSeconds('00:00:02.500')).toBeCloseTo(2.5, 6)
  })

  it('returns 0 for absent or unparseable values', () => {
    for (const v of [undefined, '', '   ', 'abc', '1:xx']) {
      expect(parseTimeToSeconds(v as string), String(v)).toBe(0)
    }
  })
})

describe('effectiveDuration', () => {
  it('prefers an explicit duration', () => {
    expect(effectiveDuration({ duration: '10' }, 120)).toBe(10)
    expect(effectiveDuration({ startTime: '30', duration: '00:00:05' }, 120)).toBe(5)
  })

  it('uses what remains after the start time', () => {
    expect(effectiveDuration({ startTime: '100' }, 120)).toBe(20)
  })

  it('falls back to the whole file', () => {
    expect(effectiveDuration({}, 120)).toBe(120)
  })

  it('never returns zero or negative', () => {
    expect(effectiveDuration({ startTime: '500' }, 120)).toBe(120)
    expect(effectiveDuration({}, 0)).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/*  Frames: count mode                                                 */
/* ------------------------------------------------------------------ */

describe('extract frames: count mode', () => {
  /** fps value from the -vf argument. */
  function vfFps(): number {
    const vf = argAfter(argv(), '-vf') || ''
    const m = /fps=([0-9.]+)/.exec(vf)
    expect(m, `no fps in -vf: ${vf}`).not.toBeNull()
    return parseFloat(m![1])
  }

  it('spaces the requested count across the whole file when no range is set', async () => {
    await extractAudio(task({
      extractOptions: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'count', frameCount: 60 }
    }), vi.fn())
    // 60 frames across 120 s.
    expect(vfFps()).toBeCloseTo(0.5, 6)
  })

  it('spaces the requested count across the selected range', async () => {
    // Regression: this used count/totalDuration, so a 10 s window of a
    // 120 s file produced 2 frames instead of 24.
    await extractAudio(task({
      extractOptions: {
        mode: 'frames', outputFormat: 'png', streamIndex: 0,
        framesMode: 'count', frameCount: 24, startTime: '30', duration: '10'
      }
    }), vi.fn())
    expect(vfFps()).toBeCloseTo(2.4, 6)
  })

  it('accounts for a start time with no explicit duration', async () => {
    await extractAudio(task({
      extractOptions: {
        mode: 'frames', outputFormat: 'png', streamIndex: 0,
        framesMode: 'count', frameCount: 30, startTime: '00:01:00'
      }
    }), vi.fn())
    // 60 s remain of 120 s.
    expect(vfFps()).toBeCloseTo(0.5, 6)
  })

  it('still passes the range through to ffmpeg', async () => {
    await extractAudio(task({
      extractOptions: {
        mode: 'frames', outputFormat: 'png', streamIndex: 0,
        framesMode: 'count', frameCount: 24, startTime: '30', duration: '10'
      }
    }), vi.fn())
    expect(argAfter(argv(), '-ss')).toBe('30')
    expect(argAfter(argv(), '-t')).toBe('10')
    // -ss must precede -i so the seek is a fast keyframe seek.
    expect(argv().indexOf('-ss')).toBeLessThan(argv().indexOf('-i'))
  })
})

/* ------------------------------------------------------------------ */
/*  Subtitles: bitmap validation                                       */
/* ------------------------------------------------------------------ */

describe('extract subtitles: bitmap sources', () => {
  const bitmapProbe = (codec: string) =>
    probe({ subtitleStreams: [{ index: 2, codec_name: codec }] })

  it('refuses a bitmap subtitle bound for a text format', async () => {
    for (const codec of ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvbsub']) {
      mockProbeMedia.mockResolvedValue(bitmapProbe(codec))
      const result = await extractAudio(task({
        extractOptions: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 0 }
      }), vi.fn())
      expect(result.status, codec).toBe('error')
      expect(result.error, codec).toMatch(/image-based/i)
      expect(result.error, codec).toContain(codec)
    }
  })

  it('names the target format in the refusal', async () => {
    mockProbeMedia.mockResolvedValue(bitmapProbe('hdmv_pgs_subtitle'))
    const result = await extractAudio(task({
      extractOptions: { mode: 'subtitles', outputFormat: 'vtt', streamIndex: 0 }
    }), vi.fn())
    expect(result.error).toContain('VTT')
  })

  it('refuses before spawning ffmpeg', async () => {
    mockProbeMedia.mockResolvedValue(bitmapProbe('hdmv_pgs_subtitle'))
    await extractAudio(task({
      extractOptions: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 0 }
    }), vi.fn())
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('allows text subtitles through to every text format', async () => {
    for (const [codec, fmt] of [['subrip', 'srt'], ['ass', 'ass'], ['mov_text', 'vtt']] as const) {
      vi.clearAllMocks()
      mockGetConfig.mockResolvedValue(baseConfig)
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      })
      mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 2, codec_name: codec }] }))
      const result = await extractAudio(task({
        extractOptions: { mode: 'subtitles', outputFormat: fmt, streamIndex: 0 }
      }), vi.fn())
      expect(result.status, `${codec}->${fmt}`).toBe('complete')
    }
  })

  it('maps the requested subtitle stream index', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      subtitleStreams: [{ index: 2, codec_name: 'subrip' }, { index: 3, codec_name: 'subrip' }]
    }))
    await extractAudio(task({
      extractOptions: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 1 }
    }), vi.fn())
    expect(argAfter(argv(), '-map')).toBe('0:s:1')
  })
})
