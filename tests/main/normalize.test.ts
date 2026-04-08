import { describe, it, expect, vi, beforeEach } from 'vitest'

// -- Shared mocks for all processor operations --
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: any[]) => mockGetConfig(...a)
}))

const mockProbeMedia = vi.fn()
const mockFormatDuration = vi.fn((s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`)
const mockFormatFileSize = vi.fn((b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`)
vi.mock('../../src/main/ffmpeg/probe', () => ({
  probeMedia: (...a: any[]) => mockProbeMedia(...a),
  formatDuration: (...a: any[]) => mockFormatDuration(...a),
  formatFileSize: (...a: any[]) => mockFormatFileSize(...a)
}))

const mockRunCommand = vi.fn()
const mockParseProgress = vi.fn()
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: (...a: any[]) => mockRunCommand(...a),
  parseProgress: (...a: any[]) => mockParseProgress(...a)
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 5000000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { normalizeFile } from '../../src/main/ffmpeg/processor/normalize'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe',
  normalization: { I: -16, TP: -1.5, LRA: 11 },
  audioCodec: 'inherit',
  fallbackCodec: 'ac3',
  audioBitrate: '256k',
  tempSuffix: '_temp',
  afterProcessing: 'replace',
  outputDirectory: '',
  preserveSubtitles: true,
  preserveMetadata: true
}

const sampleProbe = {
  audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }],
  videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
  subtitleStreams: [],
  format: { duration: '120', size: '10000000', format_name: 'matroska' },
  isVideoFile: true,
  isAudioOnly: false
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'test-1',
    filePath: '/media/test.mkv',
    fileName: 'test.mkv',
    operation: 'normalize',
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

describe('normalizeFile', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(sampleProbe)
    mockParseProgress.mockReturnValue({ time: 60, speed: '2x', size: '5000kB' })
  })

  it('returns error when ffmpegPath is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('FFmpeg not configured')
  })

  it('returns error when no audio streams found', async () => {
    mockProbeMedia.mockResolvedValue({ ...sampleProbe, audioStreams: [] })
    const onProgress = vi.fn()

    // runCommand for analysis would not be needed since we error before
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('No audio')
  })

  it('completes successfully with valid inputs', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })

    // Analysis pass - invoke callback
    mockRunCommand.mockImplementationOnce((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:00:30.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
        process: { kill: vi.fn() }
      }
    })
    // Encoding pass - invoke callback
    mockRunCommand.mockImplementationOnce((_cmd: any, _args: any, onLine: any) => {
      if (onLine) onLine('time=00:01:00.00 speed=2x')
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)

    expect(result.status).toBe('complete')
    expect(result.progress).toBe(100)
    expect(mockRunCommand).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenCalled()
  })

  it('reports progress via onProgress callback', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })

    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: {}
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)

    // Should invoke onProgress for: analyzing, processing, finalizing, complete
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('handles abort signal during processing', async () => {
    const abort = new AbortController()

    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })

    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: {}
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
      process: {}
    })

    abort.abort()

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress, abort)

    expect(result.status).toBe('cancelled')
  })

  it('returns error when analysis pass fails', async () => {
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'analysis error' }),
      process: {}
    })

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
  })

  it('uses output directory when afterProcessing is keep-both', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, afterProcessing: 'keep-both', outputDirectory: '/output' })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })

    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('handles encode failure after analysis', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })

    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'encode error' }),
      process: { kill: vi.fn() }
    })

    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('Normalize encode failed')
  })

  it('handles audio-only file with non-inherit codec', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, audioCodec: 'aac', afterProcessing: 'keep-both', outputDirectory: '/output' })
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      videoStreams: [],
      isVideoFile: false,
      isAudioOnly: true
    })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses task.outputDir when afterProcessing is keep-both and outputDir is set', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, afterProcessing: 'keep-both', outputDirectory: '' })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask({ outputDir: '/custom/output' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('cancels during analysis loop when abort is signalled', async () => {
    const abort = new AbortController()
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [sampleProbe.audioStreams[0], { ...sampleProbe.audioStreams[0], index: 2 }]
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    // Abort after first analysis pass
    abort.abort()
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress, abort)
    expect(result.status).toBe('cancelled')
  })

  it('returns error when loudness JSON cannot be extracted', async () => {
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: 'no json data here' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('Could not extract loudness')
  })

  it('preserves subtitles disabled does not add -map 0:s', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: false })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[1][1]
    expect(args).not.toContain('0:s?')
  })

  it('uses audio stream title tags for metadata', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [{ ...sampleProbe.audioStreams[0], tags: { title: '[molexMedia old] Song Title' } }]
    })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('exercises encoding progress with speed falsy and null progress', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockImplementationOnce(() => ({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    }))
    mockRunCommand.mockImplementationOnce((_cmd: any, _args: any, onLine: any) => {
      if (onLine) { onLine('a'); onLine('b'); onLine('c') }
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: { kill: vi.fn() }
      }
    })
    mockParseProgress
      .mockReturnValueOnce({ time: 30, speed: '2x' })
      .mockReturnValueOnce({ time: 60 })
      .mockReturnValueOnce(null)
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('falls back to path.dirname when both outputDir and outputDirectory empty', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, afterProcessing: 'keep-both', outputDirectory: '' })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask({ outputDir: '' }), onProgress)
    expect(result.status).toBe('complete')
  })

  it('exercises analysis progress with speed falsy', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockImplementationOnce((_cmd: any, _args: any, onLine: any) => {
      if (onLine) { onLine('x'); onLine('y') }
      return {
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
        process: { kill: vi.fn() }
      }
    })
    mockRunCommand.mockImplementationOnce(() => ({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    }))
    mockParseProgress
      .mockReturnValueOnce({ time: 30 })
      .mockReturnValueOnce(null)
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
  })

  it('uses non-inherit audioCodec with explicit codec name', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, audioCodec: 'libopus', audioBitrate: '128k' })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[1][1]
    expect(args).toContain('-c:a')
    expect(args).toContain('libopus')
    expect(args).toContain('-b:a')
    expect(args).toContain('128k')
    // Should NOT contain per-stream codec args like -c:a:0
    expect(args).not.toContain('-c:a:0')
  })

  it('uses fallbackCodec when stream codec_name is undefined with inherit mode', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [{ index: 1, channels: 2, sample_rate: '48000', channel_layout: 'stereo' }]
    })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[1][1]
    expect(args).toContain('ac3') // fallbackCodec
  })

  it('uses handler_name when title tag is absent', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [{ ...sampleProbe.audioStreams[0], tags: { handler_name: 'SoundHandler' } }]
    })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[1][1]
    const metadataIdx = args.findIndex((a: string) => a.includes('metadata:s:a:0'))
    expect(args[metadataIdx + 1]).toContain('SoundHandler')
  })

  it('uses default Track N label when no tags present', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [{ ...sampleProbe.audioStreams[0], tags: {} }]
    })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    const args = mockRunCommand.mock.calls[1][1]
    const metadataIdx = args.findIndex((a: string) => a.includes('metadata:s:a:0'))
    expect(args[metadataIdx + 1]).toContain('Track 1')
  })

  it('returns cancelled when encode returns killed=true', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: true, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('cancelled')
  })

  it('sets outputPath to filePath when afterProcessing is replace', async () => {
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const task = makeTask()
    const onProgress = vi.fn()
    const result = await normalizeFile(task, onProgress)
    expect(result.status).toBe('complete')
    expect(result.outputPath).toBe(task.filePath)
  })

  it('sets outputPath with normalized_ prefix when afterProcessing is keep-both', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, afterProcessing: 'keep-both', outputDirectory: '/out' })
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(result.outputPath).toContain('normalized_')
  })

  it('returns error when output file is empty (validateOutput)', async () => {
    const fs = await import('fs')
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    vi.mocked(fs.statSync).mockReturnValueOnce({ size: 0 } as any)
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('error')
    expect(result.error).toContain('empty file')
  })

  it('creates output directory when it does not exist', async () => {
    const fs = await import('fs')
    mockGetConfig.mockResolvedValue({ ...baseConfig, afterProcessing: 'keep-both', outputDirectory: '/new/dir' })
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const loudnessJson = JSON.stringify({
      input_i: '-20.0', input_tp: '-3.0', input_lra: '8.0',
      input_thresh: '-30.0', target_offset: '4.0'
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
      process: { kill: vi.fn() }
    })
    mockRunCommand.mockReturnValueOnce({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
    const onProgress = vi.fn()
    const result = await normalizeFile(makeTask(), onProgress)
    expect(result.status).toBe('complete')
    expect(fs.mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true })
  })
})
