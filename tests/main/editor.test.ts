import { describe, it, expect, vi, beforeEach } from 'vitest'

// -- Mocks --
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...a: any[]) => mockGetConfig(...a)
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
  writeFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 5000000 })),
  mkdirSync: vi.fn()
}))

import { cutMedia, mergeMedia, remuxMedia } from '../../src/main/ffmpeg/processor/editor'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe',
  outputDirectory: '',
  tempSuffix: '_temp',
  overwriteOriginal: false,
  preserveSubtitles: true
}

describe('editor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
  })

  describe('cutMedia', () => {
    it('defaults to precise mode — re-encodes without -c copy', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 10.5, 30.0)

      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('video_cut.mp4')

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-ss')
      expect(args).toContain('10.5')
      expect(args).toContain('-t')
      expect(args).toContain(String(30.0 - 10.5))
      // precise mode does NOT use -c copy
      expect(args).not.toContain('copy')
    })

    it('fast mode uses stream copy', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 10.5, 30.0, { mode: 'fast' })

      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-ss')
      expect(args).toContain('10.5')
      expect(args).toContain('-t')
      expect(args).toContain(String(30.0 - 10.5))
      expect(args).toContain('-c')
      expect(args).toContain('copy')
    })

    it('outputFormat overrides the output extension', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10, { outputFormat: 'mkv' })
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('video_cut.mkv')
    })

    it('returns error when ffmpeg fails', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'Error: invalid input' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10)
      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
    })

    it('returns error when ffmpeg throws', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.reject(new Error('spawn failed')),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10)
      expect(result.success).toBe(false)
      expect(result.error).toBe('spawn failed')
    })

    it('uses outputDirectory from config when set', async () => {
      mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/output' })
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10)
      expect(result.outputPath).toContain('output')
    })
  })

  describe('mergeMedia', () => {
    it('returns error when fewer than 2 segments', async () => {
      const result = await mergeMedia([{ path: '/a.mp4', inPoint: 0, outPoint: 10 }])
      expect(result.success).toBe(false)
      expect(result.error).toContain('2 segments')
    })

    it('cuts segments then concatenates them', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/media/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/media/b.mp4', inPoint: 5, outPoint: 15 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('merged_')

      // Should call runCommand 3 times: 2 segment cuts + 1 concat
      expect(mockRunCommand).toHaveBeenCalledTimes(3)
    })

    it('returns error when a segment cut fails', async () => {
      mockRunCommand.mockReturnValueOnce({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'bad' }),
        process: {}
      })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(false)
      expect(result.error).toContain('segment 1')
    })

    it('returns error when concat fails', async () => {
      // First two cuts succeed, concat fails
      mockRunCommand
        .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }), process: {} })
        .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }), process: {} })
        .mockReturnValueOnce({ promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'concat error' }), process: {} })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(false)
      expect(result.error).toContain('merge failed')
    })
  })

  describe('remuxMedia', () => {
    it('remuxes with selected streams', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await remuxMedia('/media/video.mkv', {
        keepStreams: [0, 1]
      })

      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('video_edited.mkv')

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-map')
      expect(args).toContain('0:0')
      expect(args).toContain('0:1')
    })

    it('returns error when ffmpeg is not configured', async () => {
      mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })

      const result = await remuxMedia('/media/video.mkv', { keepStreams: [0] })
      expect(result.success).toBe(false)
      expect(result.error).toContain('FFmpeg not configured')
    })

    it('applies metadata overrides', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      await remuxMedia('/media/video.mkv', {
        keepStreams: [0],
        metadata: { title: 'New Title', comment: '' }
      })

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-metadata')
      expect(args).toContain('title=New Title')
      expect(args).toContain('comment=')
    })

    it('applies per-stream dispositions', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      await remuxMedia('/media/video.mkv', {
        keepStreams: [0, 1, 2],
        dispositions: { 1: { default: 1, forced: 0 } }
      })

      const args = mockRunCommand.mock.calls[0][1]
      // Stream 1 is at output index 1 in keepStreams
      expect(args).toContain('-disposition:1')
    })

    it('skips dispositions for streams not in keepStreams', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      await remuxMedia('/media/video.mkv', {
        keepStreams: [0, 2],
        dispositions: { 1: { default: 1 } } // stream 1 not in keepStreams
      })

      const args = mockRunCommand.mock.calls[0][1]
      // Should not include disposition for stream 1
      const dispArgs = args.filter((a: string) => a.startsWith('-disposition'))
      expect(dispArgs).toHaveLength(0)
    })

    it('returns error when remux fails', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'remux error' }),
        process: {}
      })

      const result = await remuxMedia('/media/video.mkv', { keepStreams: [0] })
      expect(result.success).toBe(false)
    })
  })
})
