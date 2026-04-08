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
  statSync: vi.fn(() => ({ size: 3000000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { convertFile } from '../../src/main/ffmpeg/processor/convert'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioBitrate: '256k',
  preserveSubtitles: true,
  preserveMetadata: true,
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
    id: 'conv-1',
    filePath: '/media/video.mkv',
    fileName: 'video.mkv',
    operation: 'convert',
    convertOptions: {
      outputFormat: 'mp4',
      videoCodec: 'libx264',
      audioCodec: 'aac',
      videoBitrate: '5000k',
      audioBitrate: '256k',
      resolution: '',
      framerate: ''
    },
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

describe('convertFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(sampleProbe)
  })

  it('returns error when ffmpegPath is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })
    const onProgress = vi.fn()
    const result = await convertFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('FFmpeg not configured')
  })

  it('returns error when no convert options', async () => {
    const onProgress = vi.fn()
    const result = await convertFile(makeTask({ convertOptions: undefined }), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('No convert options')
  })

  it('completes successfully with valid options', async () => {
    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:01:00.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })

    const onProgress = vi.fn()
    const result = await convertFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(result.progress).toBe(100)
  })

  it('uses copy codec when videoCodec is copy', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const task = makeTask({
      convertOptions: {
        outputFormat: 'mp4',
        videoCodec: 'copy',
        audioCodec: 'copy',
        videoBitrate: '',
        audioBitrate: '',
        resolution: '',
        framerate: ''
      }
    })

    const onProgress = vi.fn()
    const result = await convertFile(task, onProgress)
    expect(result.status).toBe('complete')

    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('copy')
  })

  it('applies resolution and framerate options', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const task = makeTask({
      convertOptions: {
        outputFormat: 'mp4',
        videoCodec: 'libx264',
        audioCodec: 'aac',
        videoBitrate: '5000k',
        audioBitrate: '256k',
        resolution: '1280x720',
        framerate: '30'
      }
    })

    const onProgress = vi.fn()
    const result = await convertFile(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-vf')
    expect(args).toContain('-r')
  })

  it('handles abort signal', async () => {
    const abort = new AbortController()
    abort.abort()

    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await convertFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
  })

  it('returns error when ffmpeg fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'conversion error' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await convertFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('uses output directory when not overwriting original', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/output' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await convertFile(makeTask(), onProgress)
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
    const result = await convertFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
    expect(killMock).toHaveBeenCalledWith('SIGTERM')
  })

  it('converts audio-only file without video codec args', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [],
      isVideoFile: false,
      isAudioOnly: true
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await convertFile(makeTask({
      convertOptions: {
        outputFormat: 'mp3', videoCodec: '', audioCodec: 'libmp3lame',
        videoBitrate: '', audioBitrate: '320k', resolution: '', framerate: ''
      }
    }), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-c:v')
  })

  it('handles audioBitrate of 0 (no bitrate flag)', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({
      convertOptions: {
        outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac',
        videoBitrate: '5000k', audioBitrate: '0', resolution: '', framerate: ''
      }
    })
    const onProgress = vi.fn()
    const result = await convertFile(task, onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-b:a')
  })

  it('does not add subtitles for audio-only files', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [],
      isVideoFile: false,
      isAudioOnly: true
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    await convertFile(makeTask(), onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-c:s')
  })

  it('uses task.outputDir over config.outputDirectory', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await convertFile(makeTask({ outputDir: '/custom' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('applies video codec with no bitrate when empty', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({
      convertOptions: {
        outputFormat: 'mp4', videoCodec: 'libx265', audioCodec: 'aac',
        videoBitrate: '', audioBitrate: '256k', resolution: '', framerate: ''
      }
    })
    const onProgress = vi.fn()
    await convertFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-c:v')
    expect(args).toContain('libx265')
    expect(args).not.toContain('-b:v')
  })

  it('exercises progress callback with speed and without speed', async () => {
    const { parseProgress: mockPP } = await import('../../src/main/ffmpeg/runner')
    vi.mocked(mockPP)
      .mockReturnValueOnce({ time: 30, speed: '2x' } as any)
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
    const result = await convertFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('falls back to path.dirname when no outputDir configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await convertFile(makeTask({ outputDir: '' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('preserves subtitles disabled does not add subtitle flags', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: false })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    await convertFile(makeTask(), onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-c:s')
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
    const result = await convertFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true })
  })
})
