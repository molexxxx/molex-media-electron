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
  parseProgress: vi.fn(() => ({ time: 60, speed: '2x', size: '2000kB' }))
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 3000000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { compressFile } from '../../src/main/ffmpeg/processor/compress'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioBitrate: '256k',
  tempSuffix: '_temp',
  overwriteOriginal: true,
  outputDirectory: '',
  preserveSubtitles: true,
  preserveMetadata: true
}

const videoProbe = {
  audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000' }],
  videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
  subtitleStreams: [],
  format: { duration: '120', size: '50000000', format_name: 'matroska' },
  isVideoFile: true,
  isAudioOnly: false
}

const audioProbe = {
  audioStreams: [{ index: 0, codec_name: 'mp3', channels: 2, sample_rate: '44100' }],
  videoStreams: [],
  subtitleStreams: [],
  format: { duration: '240', size: '8000000', format_name: 'mp3' },
  isVideoFile: false,
  isAudioOnly: true
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'comp-1',
    filePath: '/media/video.mkv',
    fileName: 'video.mkv',
    operation: 'compress',
    compressOptions: { targetSizeMB: 0, quality: 'high' },
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

describe('compressFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(videoProbe)
  })

  it('returns error when ffmpegPath is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('compresses video with high quality preset', async () => {
    mockRunCommand.mockImplementation((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:01:00.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 0, quality: 'high' } }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses video with medium quality', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 0, quality: 'medium' } }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses video with low quality', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 0, quality: 'low' } }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses video with target size', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 25, quality: 'high' } }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses audio-only files', async () => {
    mockProbeMedia.mockResolvedValue(audioProbe)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const task = makeTask({
      filePath: '/media/song.mp3',
      fileName: 'song.mp3',
      compressOptions: { targetSizeMB: 0, quality: 'medium' }
    })
    const onProgress = vi.fn()
    const result = await compressFile(task, onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses lossless preset for audio (FLAC)', async () => {
    mockProbeMedia.mockResolvedValue(audioProbe)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const task = makeTask({
      filePath: '/media/song.mp3',
      fileName: 'song.mp3',
      compressOptions: { targetSizeMB: 0, quality: 'lossless' }
    })
    const onProgress = vi.fn()
    const result = await compressFile(task, onProgress)
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
    const result = await compressFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
  })

  it('returns error when ffmpeg fails', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'encoding error' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('uses default compressOptions when not provided', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: undefined }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses output directory when overwriteOriginal is false', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '/output' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await compressFile(makeTask(), onProgress)
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
    const result = await compressFile(makeTask(), onProgress, abort)
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
    const result = await compressFile(makeTask({ outputDir: '/custom' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('preserves subtitles in video file', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: true })
    mockProbeMedia.mockResolvedValue({
      ...videoProbe,
      subtitleStreams: [{ index: 2, codec_name: 'srt' }]
    })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-c:s')
  })

  it('compresses audio with low quality preset', async () => {
    mockProbeMedia.mockResolvedValue(audioProbe)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({
      filePath: '/media/song.mp3',
      fileName: 'song.mp3',
      compressOptions: { targetSizeMB: 0, quality: 'low' }
    })
    const onProgress = vi.fn()
    const result = await compressFile(task, onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses video with lossless quality (veryslow preset)', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 0, quality: 'lossless' } }), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('veryslow')
  })

  it('compresses video with low quality uses 128k audio', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ compressOptions: { targetSizeMB: 0, quality: 'low' } }), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('128k')
  })

  it('exercises progress callback with and without speed', async () => {
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
    const result = await compressFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('falls back to path.dirname when no outputDir configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, overwriteOriginal: false, outputDirectory: '' })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask({ outputDir: '' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('compresses video with subtitles disabled', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: false })
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await compressFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).not.toContain('-c:s')
  })

  /* ---- New codec / speed / audioBitrate options ---- */

  it('uses libx265 when videoCodec is specified', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'high', videoCodec: 'libx265' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libx265')
    expect(args).toContain('-crf')
    expect(args).toContain('22') // HEVC high CRF
  })

  it('uses VP9 with -b:v 0 for CRF mode', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'medium', videoCodec: 'libvpx-vp9' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libvpx-vp9')
    expect(args).toContain('-b:v')
    expect(args).toContain('0')
    expect(args).toContain('-cpu-used')
  })

  it('uses AV1 with cpu-used flag', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'high', videoCodec: 'libaom-av1' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libaom-av1')
    expect(args).toContain('-cpu-used')
  })

  it('respects custom speed preset', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'high', speed: 'slow' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-preset')
    expect(args).toContain('slow')
  })

  it('uses custom audioBitrate when specified', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'high', audioBitrate: '320k' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('320k')
  })

  it('uses custom audioBitrate for audio-only files', async () => {
    mockProbeMedia.mockResolvedValue(audioProbe)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })
    const task = makeTask({
      filePath: '/media/song.mp3',
      fileName: 'song.mp3',
      compressOptions: { targetSizeMB: 0, quality: 'medium', audioBitrate: '160k' }
    })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('160k')
  })

  it('target size mode overrides CRF with bitrate constraints', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 10, quality: 'high', videoCodec: 'libx265' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('libx265')
    expect(args).toContain('-maxrate')
  })

  it('VP9 fast speed uses cpu-used 4', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask({ compressOptions: { targetSizeMB: 0, quality: 'medium', videoCodec: 'libvpx-vp9', speed: 'fast' } })
    const onProgress = vi.fn()
    await compressFile(task, onProgress)
    const args = mockRunCommand.mock.calls[0][1]
    expect(args).toContain('-cpu-used')
    expect(args).toContain('4')
  })
})
