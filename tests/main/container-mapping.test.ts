/**
 * Argv-level guarantees for stream mapping in convert and compress.
 *
 * Both operations previously emitted no `-map` at all (or, for convert
 * with subtitles preserved, a blanket `-map 0`). Measured consequences on
 * a 3-audio-track MKV:
 *
 *   - compress kept 1 of 3 audio tracks
 *   - convert kept 1 of 3 audio tracks
 *   - convert mkv -> mp4 with subtitles failed outright
 *   - convert video -> mp3 failed outright
 *
 * The existing convert and compress suites passed throughout, because
 * neither asserted anything about mapping. These tests close that gap.
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
  parseProgress: vi.fn(() => ({ time: 10, speed: '2x', size: '100kB' }))
}))

vi.mock('../../src/main/ffmpeg/gpu', () => ({
  resolveGpuCodec: vi.fn(async (_p: string, codec: string) => ({ codec, activeMode: 'off', isGpu: false })),
  getHwaccelInputArgs: vi.fn(() => []),
  getGpuPreset: vi.fn(() => []),
  getGpuQualityArgs: vi.fn(() => [])
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 4_000_000 })),
  mkdirSync: vi.fn()
}))

import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'
import { convertFile } from '../../src/main/ffmpeg/processor/convert'
import { compressFile } from '../../src/main/ffmpeg/processor/compress'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioCodec: 'inherit',
  fallbackCodec: 'ac3',
  audioBitrate: '256k',
  tempSuffix: '_temp',
  afterProcessing: 'output',
  outputDirectory: '/out',
  preserveSubtitles: true,
  gpuAcceleration: 'off'
}

/** A 3-audio-track MKV, optionally with subtitles. */
function probe(over: Record<string, unknown> = {}) {
  return {
    audioStreams: [
      { index: 1, codec_name: 'aac', channels: 6, sample_rate: '48000' },
      { index: 2, codec_name: 'aac', channels: 2, sample_rate: '48000' },
      { index: 3, codec_name: 'aac', channels: 2, sample_rate: '48000' }
    ],
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
    id: 'map-1',
    filePath: '/media/movie.mkv',
    fileName: 'movie.mkv',
    operation: 'convert',
    status: 'queued',
    progress: 0,
    message: '',
    ...over
  }
}

const convertOpts = (over: Record<string, unknown> = {}) => ({
  outputFormat: 'mp4',
  videoCodec: 'libx264',
  audioCodec: 'aac',
  videoBitrate: '5000k',
  audioBitrate: '256k',
  resolution: '',
  framerate: '',
  ...over
})

function argv(call = 0): string[] {
  return mockRunCommand.mock.calls[call]?.[1] as string[]
}

/** Values of every `-map` flag, in order. */
function maps(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-map') out.push(args[i + 1])
  }
  return out
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
/*  Convert                                                            */
/* ------------------------------------------------------------------ */

describe('convert: stream mapping', () => {
  it('keeps every audio track when converting to mp4', async () => {
    await convertFile(task({ convertOptions: convertOpts() }), vi.fn())
    expect(maps(argv())).toContain('0:a?')
  })

  it('never emits a blanket -map 0', async () => {
    // `-map 0` pulled in attachments and container-incompatible subtitles
    // and failed mkv -> mp4 outright.
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await convertFile(task({ convertOptions: convertOpts() }), vi.fn())
    expect(maps(argv())).not.toContain('0')
  })

  it('transcodes subtitles to mov_text for mp4 rather than copying', async () => {
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'mp4' }) }), vi.fn())
    expect(argAfter(argv(), '-c:s')).toBe('mov_text')
    expect(maps(argv())).toContain('0:s:0?')
  })

  it('copies subtitles through for mkv', async () => {
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'mkv' }) }), vi.fn())
    expect(argAfter(argv(), '-c:s')).toBe('copy')
    expect(maps(argv())).toContain('0:s?')
  })

  it('drops bitmap subtitles when targeting mp4', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      subtitleStreams: [{ index: 4, codec_name: 'hdmv_pgs_subtitle' }]
    }))
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'mp4' }) }), vi.fn())
    expect(maps(argv()).some((m) => m.startsWith('0:s'))).toBe(false)
    expect(argv()).not.toContain('-c:s')
  })

  it('emits no subtitle args for a container that cannot carry them', async () => {
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'webm', videoCodec: 'libvpx-vp9' }) }), vi.fn())
    expect(argv()).not.toContain('-c:s')
    expect(maps(argv()).some((m) => m.startsWith('0:s'))).toBe(false)
  })

  it('maps a single audio stream and no video for an audio-only target', async () => {
    // Measured: mapping 3 audio streams into mp3 fails with "Exactly one
    // MP3 audio stream is required", and mapping video fails too.
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'mp3', audioCodec: 'libmp3lame' }) }), vi.fn())
    expect(maps(argv())).toEqual(['0:a:0?'])
    expect(argv()).not.toContain('-c:v')
  })

  it('keeps all audio streams for m4a, which accepts many', async () => {
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'm4a' }) }), vi.fn())
    expect(maps(argv())).toEqual(['0:a?'])
  })

  it('honours preserveSubtitles=false by mapping no subtitles', async () => {
    mockGetConfig.mockResolvedValue({ ...baseConfig, preserveSubtitles: false })
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await convertFile(task({ convertOptions: convertOpts() }), vi.fn())
    expect(maps(argv()).some((m) => m.startsWith('0:s'))).toBe(false)
    // Audio must still be mapped explicitly, or FFmpeg keeps only one track.
    expect(maps(argv())).toContain('0:a?')
  })

  it('still maps audio for an audio-only source', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      videoStreams: [],
      isVideoFile: false,
      isAudioOnly: true,
      audioStreams: [{ index: 0, codec_name: 'flac', channels: 2, sample_rate: '44100' }]
    }))
    await convertFile(task({ convertOptions: convertOpts({ outputFormat: 'mp3', audioCodec: 'libmp3lame' }) }), vi.fn())
    expect(maps(argv())).toEqual(['0:a:0?'])
  })
})

/* ------------------------------------------------------------------ */
/*  Compress                                                           */
/* ------------------------------------------------------------------ */

describe('compress: stream mapping', () => {
  it('keeps every audio track instead of letting FFmpeg pick one', async () => {
    await compressFile(
      task({ operation: 'compress', compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'medium' } }),
      vi.fn()
    )
    expect(maps(argv())).toContain('0:a?')
    expect(maps(argv())).toContain('0:v?')
  })

  it('maps subtitles and copies them for an mkv source', async () => {
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await compressFile(
      task({ operation: 'compress', compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'medium' } }),
      vi.fn()
    )
    expect(maps(argv())).toContain('0:s?')
    expect(argAfter(argv(), '-c:s')).toBe('copy')
  })

  it('maps only video on the first of two passes', async () => {
    // Pass 1 runs with `-an` into the null muxer; mapping subtitles there
    // without a subtitle encoder would fail the pass.
    mockProbeMedia.mockResolvedValue(probe({ subtitleStreams: [{ index: 4, codec_name: 'subrip' }] }))
    await compressFile(
      task({
        operation: 'compress',
        compressOptions: { mode: 'target-size', targetSizeMB: 100, quality: 'medium', twoPass: true }
      }),
      vi.fn()
    )
    expect(maps(argv(0))).toEqual(['0:v?'])
    expect(argv(0)).not.toContain('-c:s')
    // Pass 2 carries the full mapping.
    expect(maps(argv(1))).toContain('0:a?')
    expect(argAfter(argv(1), '-c:s')).toBe('copy')
  })

  it('maps audio for an audio-only source', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      videoStreams: [],
      isVideoFile: false,
      isAudioOnly: true,
      audioStreams: [{ index: 0, codec_name: 'flac', channels: 2, sample_rate: '44100' }]
    }))
    await compressFile(
      task({
        filePath: '/media/song.m4a',
        fileName: 'song.m4a',
        operation: 'compress',
        compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'medium' }
      }),
      vi.fn()
    )
    expect(maps(argv())).toContain('0:a?')
  })
})
