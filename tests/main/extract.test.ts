import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: any[]) => mockGetConfig(...a)
}))

const mockProbeMedia = vi.fn()
vi.mock('../../src/main/ffmpeg/probe', () => ({
  probeMedia: (...a: any[]) => mockProbeMedia(...a),
  formatDuration: vi.fn((s: number) => `${Math.floor(s)}s`),
  formatFileSize: vi.fn((b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`)
}))

const mockRunCommand = vi.fn()
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: (...a: any[]) => mockRunCommand(...a),
  parseProgress: vi.fn(() => ({ time: 60, speed: '2x', size: '3000kB' }))
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 2000000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { extractAudio } from '../../src/main/ffmpeg/processor/extract'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioBitrate: '256k',
  outputDirectory: ''
}

const sampleProbe = {
  audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000' }],
  videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
  subtitleStreams: [],
  format: { duration: '120', size: '10000000', format_name: 'matroska' },
  isVideoFile: true,
  isAudioOnly: false
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'ext-1',
    filePath: '/media/video.mkv',
    fileName: 'video.mkv',
    operation: 'extract',
    extractOptions: { outputFormat: 'mp3', streamIndex: 0 },
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

describe('extractAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(sampleProbe)
  })

  it('returns error when ffmpegPath is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('FFmpeg not configured')
  })

  it('returns error when no audio streams found', async () => {
    mockProbeMedia.mockResolvedValue({ ...sampleProbe, audioStreams: [] })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('No audio')
  })

  it('completes successfully with mp3 extraction', async () => {
    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:01:00.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(result.progress).toBe(100)
  })

  it('uses default extractOptions when not provided', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask({ extractOptions: undefined }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('handles abort signal', async () => {
    const abort = new AbortController()
    abort.abort()

    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
  })

  it('returns error when ffmpeg fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'extraction failed' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('generates correct output filename', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.outputPath).toContain('_audio.mp3')
  })

  it('handles flac output format', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const task = makeTask({ extractOptions: { outputFormat: 'flac', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses output directory when configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/output' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('fires abort listener during active processing', async () => {
    const abort = new AbortController()
    const killMock = vi.fn()

    mockRunCommand.mockImplementation(() => {
      queueMicrotask(() => abort.abort())
      return {
        promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
        process: { kill: killMock }
      }
    })

    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
    expect(killMock).toHaveBeenCalledWith('SIGTERM')
  })

  it('extracts to wav using pcm codec without bitrate', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'wav', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('pcm_s16le')
    expect(args).not.toContain('-b:a')
  })

  it('extracts to ogg using libvorbis', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'ogg', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libvorbis')
  })

  it('extracts to opus using libopus', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'opus', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libopus')
  })

  it('uses copy codec for unknown format', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'xyz', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('copy')
    expect(args).not.toContain('-b:a')
  })

  it('uses task.outputDir when configured', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask({ outputDir: '/custom' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('extracts to m4a using aac codec', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'm4a', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('aac')
  })

  it('exercises progress callback with and without speed', async () => {
    const { parseProgress: mockPP } = await import('../../src/main/ffmpeg/runner')
    vi.mocked(mockPP)
      .mockReturnValueOnce({ time: 30, speed: '1x' } as any)
      .mockReturnValueOnce({ time: 60 } as any)
      .mockReturnValueOnce(null)

    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) { onLine('a'); onLine('b'); onLine('c') }
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('falls back to path.dirname when no outputDir configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask({ outputDir: '' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('extracts to aac with bitrate', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'aac', streamIndex: 0 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-b:a')
  })

  /* ---- New audioBitrate / sampleRate / channels options ---- */

  it('uses custom audioBitrate when specified', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, audioBitrate: '320k' } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-b:a')
    expect(args).toContain('320k')
  })

  it('custom audioBitrate overrides config default', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, audioBitrate: '128k' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'aac', streamIndex: 0, audioBitrate: '256k' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    const bitrateIdx = args.indexOf('-b:a')
    expect(args[bitrateIdx + 1]).toBe('256k')
  })

  it('applies sample rate when specified', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, sampleRate: '44100' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-ar')
    expect(args).toContain('44100')
  })

  it('does not add -ar when sampleRate is empty', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, sampleRate: '' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-ar')
  })

  it('sets mono channel when channels is mono', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, channels: 'mono' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-ac')
    expect(args).toContain('1')
  })

  it('sets stereo channel when channels is stereo', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, channels: 'stereo' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-ac')
    expect(args).toContain('2')
  })

  it('does not add -ac when channels is empty', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 0, channels: '' } })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-ac')
  })

  it('combines audioBitrate, sampleRate, and channels', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({
      extractOptions: {
        outputFormat: 'mp3',
        streamIndex: 0,
        audioBitrate: '192k',
        sampleRate: '48000',
        channels: 'stereo'
      }
    })
    const onProgress = vi.fn()
    await extractAudio(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('192k')
    expect(args).toContain('-ar')
    expect(args).toContain('48000')
    expect(args).toContain('-ac')
    expect(args).toContain('2')
  })

  it('returns error when streamIndex exceeds available streams', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000' }]
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ extractOptions: { outputFormat: 'mp3', streamIndex: 5 } })
    const onProgress = vi.fn()
    const result = await extractAudio(task, onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('stream 5 not found')
  })

  it('returns error when output file is empty (validateOutput)', async () => {
    const fs = await import('fs')
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    vi.mocked(fs.statSync).mockReturnValueOnce({ size: 0 } as any)
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('empty file')
  })

  it('creates output directory when it does not exist', async () => {
    const fs = await import('fs')
    mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/new/dir' })
    vi.mocked(fs.existsSync).mockReturnValue(false)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await extractAudio(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true })
  })

  /* ---------------- Multi-mode revamp ---------------- */

  describe('video mode', () => {
    it('stream-copies video and strips audio by default', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({ extractOptions: { mode: 'video', outputFormat: 'mp4', streamIndex: 0 } })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('complete')
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-an')
      expect(args).toContain('-map')
      expect(args).toContain('0:v:0')
      expect(args).toContain('-c:v')
      expect(args).toContain('copy')
      expect(args[args.length - 1]).toMatch(/_video\.mp4$/)
    })

    it('re-encodes with H.264 when videoReencode is true', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({ extractOptions: { mode: 'video', outputFormat: 'mp4', streamIndex: 0, videoReencode: true, videoCrf: 18 } })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('libx264')
      expect(args).toContain('-crf')
      expect(args).toContain('18')
    })

    it('errors when no video streams present', async () => {
      mockProbeMedia.mockResolvedValue({ ...sampleProbe, videoStreams: [] })
      const task = makeTask({ extractOptions: { mode: 'video', outputFormat: 'mp4', streamIndex: 0 } })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('error')
      expect(result.error).toContain('No video streams')
    })
  })

  describe('gif mode', () => {
    it('builds a two-pass palettegen + paletteuse filter graph', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 12, gifWidth: 480, gifDither: 'sierra2_4a', gifLoop: 0 }
      })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('complete')
      const args = mockRunCommand.mock.calls[0][1]
      const filterIdx = args.indexOf('-filter_complex')
      expect(filterIdx).toBeGreaterThan(-1)
      const filter = args[filterIdx + 1]
      expect(filter).toContain('palettegen')
      expect(filter).toContain('paletteuse')
      expect(filter).toContain('fps=12')
      expect(filter).toContain('scale=480')
      expect(filter).toContain('dither=sierra2_4a')
      expect(args).toContain('-loop')
      expect(args).toContain('0')
      expect(args[args.length - 1]).toMatch(/\.gif$/)
    })

    it('respects custom dither and loop count', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 10, gifWidth: 320, gifDither: 'bayer', gifLoop: 1 }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      const filter = args[args.indexOf('-filter_complex') + 1]
      expect(filter).toContain('dither=bayer')
      const loopIdx = args.indexOf('-loop')
      expect(args[loopIdx + 1]).toBe('1')
    })
  })

  describe('frames mode', () => {
    it('builds interval-based fps filter for frame sequence', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'interval', frameInterval: 2, frameFormat: 'png' }
      })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('complete')
      const args = mockRunCommand.mock.calls[0][1]
      const vfIdx = args.indexOf('-vf')
      expect(args[vfIdx + 1]).toBe('fps=1/2')
      expect(args[args.length - 1]).toMatch(/frame_%04d\.png$/)
    })

    it('uses single-frame thumbnail at midpoint', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'thumbnail', frameFormat: 'png' }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-ss')
      expect(args).toContain('-frames:v')
      expect(args).toContain('1')
      expect(args[args.length - 1]).toMatch(/_thumb\.png$/)
    })

    it('adds jpg quality flag when frameFormat is jpg', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'frames', outputFormat: 'jpg', streamIndex: 0, framesMode: 'interval', frameInterval: 1, frameFormat: 'jpg', jpgQuality: 4 }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-q:v')
      expect(args).toContain('4')
    })

    it('count mode computes fps from duration', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'count', frameCount: 24, frameFormat: 'png' }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      const vfIdx = args.indexOf('-vf')
      // 24 frames over 120s = fps=0.2
      expect(args[vfIdx + 1]).toBe('fps=0.2')
    })
  })

  describe('subtitles mode', () => {
    it('errors when no subtitle streams present', async () => {
      mockProbeMedia.mockResolvedValue({ ...sampleProbe, subtitleStreams: [] })
      const task = makeTask({ extractOptions: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 0 } })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('error')
      expect(result.error).toContain('No subtitle streams')
    })

    it('extracts to srt with appropriate codec', async () => {
      mockProbeMedia.mockResolvedValue({
        ...sampleProbe,
        subtitleStreams: [{ index: 2, codec_name: 'subrip' }]
      })
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({ extractOptions: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 0 } })
      const result = await extractAudio(task, vi.fn())
      expect(result.status).toBe('complete')
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-c:s')
      expect(args).toContain('srt')
      expect(args).toContain('-map')
      expect(args).toContain('0:s:0')
      expect(args[args.length - 1]).toMatch(/\.srt$/)
    })

    it('maps vtt format to webvtt encoder', async () => {
      mockProbeMedia.mockResolvedValue({
        ...sampleProbe,
        subtitleStreams: [{ index: 2, codec_name: 'subrip' }]
      })
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({ extractOptions: { mode: 'subtitles', outputFormat: 'vtt', streamIndex: 0 } })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('webvtt')
    })
  })

  describe('time range', () => {
    it('applies startTime and duration before input for video mode', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'video', outputFormat: 'mp4', streamIndex: 0, startTime: '00:00:05', duration: '10' }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      const inputIdx = args.indexOf('-i')
      const ssIdx = args.indexOf('-ss')
      const tIdx = args.indexOf('-t')
      expect(ssIdx).toBeGreaterThan(-1)
      expect(ssIdx).toBeLessThan(inputIdx)
      expect(tIdx).toBeLessThan(inputIdx)
      expect(args[ssIdx + 1]).toBe('00:00:05')
      expect(args[tIdx + 1]).toBe('10')
    })

    it('applies time range to gif mode', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      const task = makeTask({
        extractOptions: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 12, gifWidth: 480, startTime: '3', duration: '2' }
      })
      await extractAudio(task, vi.fn())
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-ss')
      expect(args).toContain('3')
      expect(args).toContain('-t')
      expect(args).toContain('2')
    })
  })
})
