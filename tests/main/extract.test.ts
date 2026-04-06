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
})
