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
  parseProgress: vi.fn(() => ({ time: 60, speed: '2x', size: '5000kB' }))
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 4000000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { boostFile } from '../../src/main/ffmpeg/processor/boost'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioCodec: 'inherit',
  fallbackCodec: 'ac3',
  audioBitrate: '256k',
  tempSuffix: '_temp',
  overwriteOriginal: true,
  outputDirectory: '',
  preserveSubtitles: true,
  preserveMetadata: true
}

const sampleProbe = {
  audioStreams: [{ index: 0, codec_name: 'mp3', channels: 2, sample_rate: '44100', channel_layout: 'stereo' }],
  videoStreams: [],
  subtitleStreams: [],
  format: { duration: '180', size: '5000000', format_name: 'mp3' },
  isVideoFile: false,
  isAudioOnly: true
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'boost-1',
    filePath: '/media/song.mp3',
    fileName: 'song.mp3',
    operation: 'boost',
    boostPercent: 50,
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

describe('boostFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(sampleProbe)
  })

  it('returns error when ffmpegPath is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('FFmpeg not configured')
  })

  it('returns error when no audio streams found', async () => {
    mockProbeMedia.mockResolvedValue({ ...sampleProbe, audioStreams: [] })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('completes successfully with positive boost', async () => {
    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:01:00.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 100 }), onProgress)
    expect(result.status).toBe('complete')
    expect(result.progress).toBe(100)
  })

  it('completes successfully with negative boost (attenuation)', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: -30 }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('handles video file with non-inherit audio codec', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, audioCodec: 'aac' })
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
      isVideoFile: true,
      isAudioOnly: false
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 50 }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('handles abort signal during processing', async () => {
    const abort = new AbortController()
    abort.abort()

    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
  })

  it('returns error when ffmpeg command fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'encoding error' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('defaults boostPercent to 0 when not set', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: undefined }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses output directory when overwriteOriginal is false', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '/output' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
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
    const result = await boostFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
    expect(killMock).toHaveBeenCalledWith('SIGTERM')
  })

  it('uses task.outputDir when overwriteOriginal is false', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ outputDir: '/custom' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('handles video file with subtitles and inherit codec', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
      subtitleStreams: [{ index: 2, codec_name: 'srt' }],
      isVideoFile: true,
      isAudioOnly: false
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 50 }), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-c:v')
    expect(args).toContain('-c:s')
  })

  it('handles video file with subtitles disabled', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: false })
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
      isVideoFile: true,
      isAudioOnly: false
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 25 }), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-c:s')
  })

  it('handles multiple audio streams with tags', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [
        { index: 0, codec_name: 'mp3', channels: 2, sample_rate: '44100', tags: { title: '[molexMedia old] Song' } },
        { index: 1, codec_name: 'aac', channels: 6, sample_rate: '48000', tags: { handler_name: 'Surround' } }
      ]
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 50 }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('exercises progress callback with speed and without speed', async () => {
    const { parseProgress: mockPP } = await import('../../src/main/ffmpeg/runner')
    vi.mocked(mockPP)
      .mockReturnValueOnce({ time: 30, speed: '1.5x' } as any)
      .mockReturnValueOnce({ time: 60 } as any)
      .mockReturnValueOnce(null)

    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) { onLine('line1'); onLine('line2'); onLine('line3') }
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ boostPercent: 25 }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('falls back to path.dirname when no outputDir configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask({ outputDir: '' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('sets outputPath to filePath when overwriteOriginal is true', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: true })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask()
    const onProgress = vi.fn()
    const result = await boostFile(task, onProgress)
    expect(result.status).toBe('complete')
    expect(result.outputPath).toBe(task.filePath)
  })

  it('sets outputPath with boosted_ prefix when overwriteOriginal is false', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '/out' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(result.outputPath).toContain('boosted_')
  })

  it('returns error when output file is empty (validateOutput)', async () => {
    const fs = await import('fs')
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    // First call from statSync for validateOutput returns 0, second for outputSize is normal
    vi.mocked(fs.statSync).mockReturnValueOnce({ size: 0 } as any)
    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('empty file')
  })

  it('creates output directory when it does not exist', async () => {
    const fs = await import('fs')
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '/new/dir' })
    vi.mocked(fs.existsSync).mockReturnValue(false)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await boostFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true })
  })
})
