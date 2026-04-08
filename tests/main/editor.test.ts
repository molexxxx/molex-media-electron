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

import { cutMedia, mergeMedia, remuxMedia, replaceAudio } from '../../src/main/ffmpeg/processor/editor'
import * as fs from 'fs'

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

    it('returns error for NaN time range', async () => {
      const result = await cutMedia('/media/video.mp4', NaN, 10)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid time range')
    })

    it('returns error for Infinity time range', async () => {
      const result = await cutMedia('/media/video.mp4', 0, Infinity)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid time range')
    })

    it('returns error when inPoint is negative', async () => {
      const result = await cutMedia('/media/video.mp4', -5, 10)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid time range')
    })

    it('returns error when outPoint equals inPoint', async () => {
      const result = await cutMedia('/media/video.mp4', 10, 10)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid time range')
    })

    it('returns error when outPoint is before inPoint', async () => {
      const result = await cutMedia('/media/video.mp4', 20, 5)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid time range')
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

    it('gif export uses two-pass palette generation', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 5, 15, {
        outputFormat: 'gif',
        gifOptions: { loop: true, fps: 10, width: 320 }
      })

      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('video_cut.gif')
      // Two calls: palette generation + encoding
      expect(mockRunCommand).toHaveBeenCalledTimes(2)

      const paletteArgs = mockRunCommand.mock.calls[0][1]
      expect(paletteArgs.some((a: string) => a.includes('palettegen'))).toBe(true)
      expect(paletteArgs.some((a: string) => a.includes('fps=10'))).toBe(true)
      expect(paletteArgs.some((a: string) => a.includes('scale=320'))).toBe(true)

      const encodeArgs = mockRunCommand.mock.calls[1][1]
      expect(encodeArgs.some((a: string) => a.includes('paletteuse'))).toBe(true)
      expect(encodeArgs).toContain('-loop')
      expect(encodeArgs).toContain('0') // loop enabled
    })

    it('gif export with loop disabled uses -1', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      await cutMedia('/media/video.mp4', 0, 10, {
        outputFormat: 'gif',
        gifOptions: { loop: false, fps: 15, width: 480 }
      })

      const encodeArgs = mockRunCommand.mock.calls[1][1]
      expect(encodeArgs).toContain('-loop')
      expect(encodeArgs).toContain('-1') // no loop
    })

    it('gif export with width=-1 uses original size filter', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      await cutMedia('/media/video.mp4', 0, 10, {
        outputFormat: 'gif',
        gifOptions: { width: -1 }
      })

      const paletteArgs = mockRunCommand.mock.calls[0][1]
      expect(paletteArgs.some((a: string) => a.includes('trunc(iw/2)*2'))).toBe(true)
    })

    it('gif export defaults options when gifOptions omitted', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 5, { outputFormat: 'gif' })

      expect(result.success).toBe(true)
      expect(mockRunCommand).toHaveBeenCalledTimes(2)
      const paletteArgs = mockRunCommand.mock.calls[0][1]
      expect(paletteArgs.some((a: string) => a.includes('fps=15'))).toBe(true)
      expect(paletteArgs.some((a: string) => a.includes('scale=480'))).toBe(true)
    })

    it('gif export forces precise mode regardless of option', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      // Request fast mode with gif — should still get gif (no -c copy)
      const result = await cutMedia('/media/video.mp4', 0, 5, { mode: 'fast', outputFormat: 'gif' })
      expect(result.success).toBe(true)
      // Should use gif pipeline (2 calls), not fast stream-copy
      expect(mockRunCommand).toHaveBeenCalledTimes(2)
    })

    it('gif export returns error when palette generation fails', async () => {
      mockRunCommand.mockReturnValueOnce({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'palette error' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10, { outputFormat: 'gif' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('palette')
    })

    it('gif export returns error when encoding fails', async () => {
      mockRunCommand
        .mockReturnValueOnce({
          promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
          process: {}
        })
        .mockReturnValueOnce({
          promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'encode error' }),
          process: {}
        })

      const result = await cutMedia('/media/video.mp4', 0, 10, { outputFormat: 'gif' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('GIF encoding failed')
    })

    it('gif export returns error when ffmpeg throws', async () => {
      mockRunCommand.mockReturnValueOnce({
        promise: Promise.reject(new Error('gif spawn failed')),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10, { outputFormat: 'gif' })
      expect(result.success).toBe(false)
      expect(result.error).toBe('gif spawn failed')
    })

    it('gif export reports progress via callback', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      mockParseProgress.mockReturnValue({ time: 5, speed: '1x' })

      const progress = vi.fn()
      await cutMedia('/media/video.mp4', 0, 10, { outputFormat: 'gif' }, progress)

      // Should have been called with palette and encoding progress messages
      expect(progress).toHaveBeenCalled()
      const messages = progress.mock.calls.map((c: any[]) => c[0].message)
      expect(messages.some((m: string) => m.includes('palette'))).toBe(true)

      // Trigger the stderr line callbacks to exercise progress parsing
      const pass1Cb = mockRunCommand.mock.calls[0][2]
      const pass2Cb = mockRunCommand.mock.calls[1][2]
      pass1Cb('frame= 100')
      pass2Cb('frame= 200')

      // Verify parseProgress was called for each line
      expect(mockParseProgress).toHaveBeenCalledWith('frame= 100')
      expect(mockParseProgress).toHaveBeenCalledWith('frame= 200')
    })
  })

  describe('mergeMedia', () => {
    it('returns error when no segments provided', async () => {
      const result = await mergeMedia([])
      expect(result.success).toBe(false)
      expect(result.error).toContain('No segments')
    })

    it('uses single filter_complex pass in precise mode', async () => {
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

      // Precise mode uses a single filter_complex call
      expect(mockRunCommand).toHaveBeenCalledTimes(1)
      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-filter_complex')
    })

    it('returns error when merge fails', async () => {
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
      expect(result.error).toContain('failed')
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

    it('returns error when remux throws', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.reject(new Error('remux spawn failed')),
        process: {}
      })

      const result = await remuxMedia('/media/video.mkv', { keepStreams: [0] })
      expect(result.success).toBe(false)
      expect(result.error).toBe('remux spawn failed')
    })

    it('uses outputDirectory from config', async () => {
      mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/output' })
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await remuxMedia('/media/video.mkv', { keepStreams: [0] })
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('output')
    })
  })

  describe('mergeMedia – error paths', () => {
    it('returns error when merge throws unexpectedly', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.reject(new Error('merge spawn failed')),
        process: {}
      })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(false)
      expect(result.error).toBe('merge spawn failed')
    })

    it('reports progress during merge', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      mockParseProgress.mockReturnValue({ time: 5, speed: '1x' })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const progress = vi.fn()
      await mergeMedia(segments, {}, progress)

      // Single filter_complex call — trigger stderr callback
      const cb = mockRunCommand.mock.calls[0][2]
      if (cb) cb('time=00:00:05.00')

      expect(progress).toHaveBeenCalled()
    })

    it('uses outputFormat override in merge', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments, { outputFormat: 'mkv' })
      expect(result.success).toBe(true)
    })
  })

  describe('cutMedia – progress callbacks', () => {
    it('reports progress during precise cut', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      mockParseProgress.mockReturnValue({ time: 5, speed: '2x' })

      const progress = vi.fn()
      await cutMedia('/media/video.mp4', 0, 10, {}, progress)

      const cb = mockRunCommand.mock.calls[0][2]
      cb('time=00:00:05.00')

      expect(mockParseProgress).toHaveBeenCalledWith('time=00:00:05.00')
      expect(progress).toHaveBeenCalled()
    })

    it('uses outputDir option', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await cutMedia('/media/video.mp4', 0, 10, { outputDir: '/custom' })
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('custom')
    })
  })

  describe('mergeMedia – single segment with A2', () => {
    it('delegates single segment without A2 to cutMedia', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await mergeMedia([{ path: '/media/a.mp4', inPoint: 5, outPoint: 15 }])
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('a_cut.mp4')
    })

    it('uses mergePrecise for single segment with A2 audio', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [{
        path: '/media/a.mp4',
        inPoint: 0,
        outPoint: 10,
        audioReplacement: { path: '/media/audio.mp3', offset: 1, trimIn: 0, trimOut: 8 }
      }]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('a_export.mp4')

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-filter_complex')
      // Should have A2 mixing filter with amix
      const fc = args[args.indexOf('-filter_complex') + 1]
      expect(fc).toContain('amix')
      expect(fc).toContain('atrim')
    })
  })

  describe('mergeMedia – precise with A2 audio', () => {
    it('builds filter graph with A2 trim, delay, and amix', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        {
          path: '/media/a.mp4',
          inPoint: 0,
          outPoint: 10,
          audioReplacement: { path: '/media/overlay.mp3', offset: 2, trimIn: 1, trimOut: 9 }
        },
        { path: '/media/b.mp4', inPoint: 5, outPoint: 15 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      const fc = args[args.indexOf('-filter_complex') + 1]

      // Video trim
      expect(fc).toContain('[0:v]trim=start=0:end=10')
      // A1 original audio
      expect(fc).toContain('[0:a]atrim=start=0:end=10')
      // A2 overlay with trimIn/trimOut
      expect(fc).toContain('atrim=start=1:end=9')
      // A2 delay (2s = 2000ms)
      expect(fc).toContain('adelay=2000|2000')
      // amix
      expect(fc).toContain('amix=inputs=2')
      // concat
      expect(fc).toContain('concat=n=2')
    })

    it('handles A2 without offset (no adelay filter)', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [{
        path: '/media/a.mp4',
        inPoint: 0,
        outPoint: 10,
        audioReplacement: { path: '/media/overlay.mp3', offset: 0, trimIn: 0, trimOut: 10 }
      }]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      const fc = args[args.indexOf('-filter_complex') + 1]
      expect(fc).not.toContain('adelay')
    })

    it('deduplicates input files (same file in multiple segments)', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/media/a.mp4', inPoint: 0, outPoint: 5 },
        { path: '/media/a.mp4', inPoint: 10, outPoint: 20 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      // Should only have one -i for a.mp4
      const inputFlags = args.filter((a: string, i: number) => a === '-i' && args[i + 1] === '/media/a.mp4')
      expect(inputFlags).toHaveLength(1)
    })

    it('handles audio-only files (no video track in filter)', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/media/a.mp3', inPoint: 0, outPoint: 10 },
        { path: '/media/b.mp3', inPoint: 0, outPoint: 5 }
      ]

      const result = await mergeMedia(segments)
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      const fc = args[args.indexOf('-filter_complex') + 1]
      // Should not have video trim/concat
      expect(fc).not.toContain(':v]trim')
      expect(fc).toContain('concat=n=2:v=0:a=1')
      // Should not map [vout]
      expect(args).not.toContain('[vout]')
      expect(args).toContain('[aout]')
    })
  })

  describe('mergeMedia – fast mode', () => {
    it('processes segments individually and concatenates', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/media/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/media/b.mp4', inPoint: 5, outPoint: 15 }
      ]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('merged_')

      // 2 segments + 1 concat = 3 calls
      expect(mockRunCommand).toHaveBeenCalledTimes(3)

      // Concat call uses -f concat
      const concatArgs = mockRunCommand.mock.calls[2][1]
      expect(concatArgs).toContain('-f')
      expect(concatArgs).toContain('concat')
    })

    it('single segment fast mode renames without concat', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [{
        path: '/media/a.mp4',
        inPoint: 0,
        outPoint: 10,
        audioReplacement: { path: '/media/overlay.mp3', offset: 0, trimIn: 0, trimOut: 10 }
      }]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(true)

      // 1 segment = 1 FFmpeg call, no concat
      expect(mockRunCommand).toHaveBeenCalledTimes(1)
      // Should rename temp file
      expect(fs.renameSync).toHaveBeenCalled()
    })

    it('fast mode with A2 uses filter_complex for audio mixing', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [{
        path: '/media/a.mp4',
        inPoint: 0,
        outPoint: 10,
        audioReplacement: { path: '/media/overlay.mp3', offset: 1.5, trimIn: 0.5, trimOut: 8 }
      }]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-filter_complex')
      const fc = args[args.indexOf('-filter_complex') + 1]
      expect(fc).toContain('atrim=start=0.5:end=8')
      expect(fc).toContain('adelay=1500|1500')
      expect(fc).toContain('amix')
    })

    it('returns error when segment processing fails', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'seg error' }),
        process: {}
      })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('segment')
    })

    it('returns error when concat step fails', async () => {
      mockRunCommand
        .mockReturnValueOnce({
          promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
          process: {}
        })
        .mockReturnValueOnce({
          promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
          process: {}
        })
        .mockReturnValueOnce({
          promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'concat error' }),
          process: {}
        })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('merge failed')
    })

    it('returns error when fast merge throws', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.reject(new Error('fast spawn failed')),
        process: {}
      })

      const segments = [
        { path: '/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/b.mp4', inPoint: 0, outPoint: 10 }
      ]

      const result = await mergeMedia(segments, { mode: 'fast' })
      expect(result.success).toBe(false)
      expect(result.error).toBe('fast spawn failed')
    })

    it('reports progress during fast merge segments', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      mockParseProgress.mockReturnValue({ time: 5, speed: '1x' })

      const segments = [{
        path: '/a.mp4',
        inPoint: 0,
        outPoint: 10,
        audioReplacement: { path: '/b.mp3', offset: 0, trimIn: 0, trimOut: 10 }
      }]

      const progress = vi.fn()
      await mergeMedia(segments, { mode: 'fast' }, progress)

      expect(progress).toHaveBeenCalled()
      // Trigger the stderr callback for segment processing
      const cb = mockRunCommand.mock.calls[0][2]
      if (cb) cb('time=00:00:05.00')
      expect(mockParseProgress).toHaveBeenCalled()
    })

    it('writes concat file for multi-segment fast merge', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const segments = [
        { path: '/media/a.mp4', inPoint: 0, outPoint: 10 },
        { path: '/media/b.mp4', inPoint: 0, outPoint: 5 }
      ]

      await mergeMedia(segments, { mode: 'fast' })

      // Should write concat file
      expect(fs.writeFileSync).toHaveBeenCalled()
      const writeCall = (fs.writeFileSync as any).mock.calls[0]
      expect(writeCall[0]).toContain('concat')
      expect(writeCall[1]).toContain("file '")
    })
  })

  describe('replaceAudio', () => {
    it('replaces audio track successfully', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3')
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('video_replaced.mp4')

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-map')
      expect(args).toContain('0:v')
      expect(args).toContain('1:a')
      expect(args).toContain('-c:v')
      expect(args).toContain('copy')
    })

    it('returns error when ffmpeg is not configured', async () => {
      mockGetConfig.mockResolvedValue({ ...baseConfig, ffmpegPath: '' })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3')
      expect(result.success).toBe(false)
      expect(result.error).toContain('FFmpeg not configured')
    })

    it('applies audio offset with -itsoffset', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3', { audioOffset: 2.5 })
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-itsoffset')
      expect(args).toContain('2.5')
    })

    it('applies trim with inPoint and outPoint', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3', {
        inPoint: 5,
        outPoint: 25
      })
      expect(result.success).toBe(true)

      const args = mockRunCommand.mock.calls[0][1]
      expect(args).toContain('-ss')
      expect(args).toContain('5')
      expect(args).toContain('-t')
      expect(args).toContain('20') // duration = 25 - 5
    })

    it('returns error when ffmpeg fails', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'replace error' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3')
      expect(result.success).toBe(false)
      expect(result.error).toContain('replace audio failed')
    })

    it('returns error when ffmpeg throws', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.reject(new Error('replace spawn failed')),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3')
      expect(result.success).toBe(false)
      expect(result.error).toBe('replace spawn failed')
    })

    it('reports progress via callback', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })
      mockParseProgress.mockReturnValue({ time: 5, speed: '1x' })

      const progress = vi.fn()
      await replaceAudio('/media/video.mp4', '/media/audio.mp3', {}, progress)

      expect(progress).toHaveBeenCalled()
      const cb = mockRunCommand.mock.calls[0][2]
      if (cb) cb('time=00:00:05.00')
      expect(mockParseProgress).toHaveBeenCalled()
    })

    it('uses outputDir from options', async () => {
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3', { outputDir: '/custom' })
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('custom')
    })

    it('uses outputDirectory from config as fallback', async () => {
      mockGetConfig.mockResolvedValue({ ...baseConfig, outputDirectory: '/output' })
      mockRunCommand.mockReturnValue({
        promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
        process: {}
      })

      const result = await replaceAudio('/media/video.mp4', '/media/audio.mp3')
      expect(result.success).toBe(true)
      expect(result.outputPath).toContain('output')
    })
  })
})
