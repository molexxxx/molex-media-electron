/**
 * Argv-level guarantees for the audio pipelines.
 *
 * The filter-chain tests cover what goes inside `-filter_complex`; these
 * cover the surrounding command line, where several of the audited defects
 * lived: a global `-ac` that reshaped every audio stream, an analysis pass
 * that measured a different signal than the encode pass normalized, and a
 * two-pass stats file shared by every concurrent worker.
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
import { boostFile } from '../../src/main/ffmpeg/processor/boost'
import { normalizeFile } from '../../src/main/ffmpeg/processor/normalize'
import { compressFile } from '../../src/main/ffmpeg/processor/compress'

const baseConfig = {
  ffmpegPath: '/usr/bin/ffmpeg',
  audioCodec: 'inherit',
  fallbackCodec: 'ac3',
  audioBitrate: '256k',
  tempSuffix: '_temp',
  afterProcessing: 'replace',
  outputDirectory: '',
  preserveSubtitles: true,
  preserveMetadata: true,
  gpuAcceleration: 'off',
  normalization: { I: -16, TP: -1.5, LRA: 11 }
}

const LOUDNORM_JSON = JSON.stringify({
  input_i: '-23.10',
  input_tp: '-9.20',
  input_lra: '7.30',
  input_thresh: '-33.40',
  output_i: '-16.00',
  normalization_type: 'dynamic',
  target_offset: '-0.15'
})

function probe(over: Record<string, unknown> = {}) {
  return {
    audioStreams: [{ index: 0, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }],
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
    id: 'pipeline-1',
    filePath: '/media/movie.mkv',
    fileName: 'movie.mkv',
    operation: 'boost',
    status: 'queued',
    progress: 0,
    message: '',
    ...over
  }
}

/** All argv arrays passed to ffmpeg, in call order. */
function calls(): string[][] {
  return mockRunCommand.mock.calls.map((c) => c[1] as string[])
}

/** Value that follows `flag` in an argv array, or undefined. */
function argAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
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
/*  Boost                                                              */
/* ------------------------------------------------------------------ */

describe('boost: command line', () => {
  it('never forces a global channel count', async () => {
    // Regression: `-ac <maxChannels>` applied the widest stream's channel
    // count to EVERY audio output, so a stereo commentary track alongside
    // a 5.1 main track came back upmixed to 5.1.
    mockProbeMedia.mockResolvedValue(probe({
      audioStreams: [
        { index: 0, codec_name: 'eac3', channels: 6, sample_rate: '48000', channel_layout: '5.1' },
        { index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }
      ]
    }))
    await boostFile(task({ boostPercent: 50 }), vi.fn())
    expect(calls()[0]).not.toContain('-ac')
  })

  it('keeps each stream at its own layout and rate', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      audioStreams: [
        { index: 0, codec_name: 'eac3', channels: 6, sample_rate: '48000', channel_layout: '5.1' },
        { index: 1, codec_name: 'aac', channels: 2, sample_rate: '44100', channel_layout: 'stereo' }
      ]
    }))
    await boostFile(task({ boostPercent: 50 }), vi.fn())
    const fc = argAfter(calls()[0], '-filter_complex')!
    expect(fc).toContain('channel_layouts=5.1:sample_rates=48000')
    expect(fc).toContain('channel_layouts=stereo:sample_rates=44100')
  })

  it('does not quantise the gain stage to 16-bit', async () => {
    await boostFile(task({ boostPercent: 50 }), vi.fn())
    expect(argAfter(calls()[0], '-filter_complex')).not.toContain('sample_fmts=s16')
  })

  it('emits a limiter that holds the ceiling instead of auto-levelling', async () => {
    await boostFile(
      task({ boostPercent: 100, boostOptions: { limiter: true, limiterCeiling: -1 } }),
      vi.fn()
    )
    const fc = argAfter(calls()[0], '-filter_complex')!
    expect(fc).toContain('alimiter=limit=0.8913:level=disabled:latency=1')
  })

  it('maps one filtered output per audio stream', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      audioStreams: [
        { index: 0, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' },
        { index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }
      ]
    }))
    await boostFile(task({ boostPercent: 20 }), vi.fn())
    const argv = calls()[0]
    expect(argv).toContain('[a0]')
    expect(argv).toContain('[a1]')
  })

  it('stream-copies video rather than re-encoding it', async () => {
    await boostFile(task({ boostPercent: 20 }), vi.fn())
    expect(argAfter(calls()[0], '-c:v')).toBe('copy')
  })
})

/* ------------------------------------------------------------------ */
/*  Normalize                                                          */
/* ------------------------------------------------------------------ */

describe('normalize: two-pass parity', () => {
  beforeEach(() => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: LOUDNORM_JSON }),
      process: { kill: vi.fn() }
    })
  })

  /** Everything in a chain up to and including the loudnorm stage. */
  function throughLoudnorm(chain: string): string[] {
    const parts = chain.split(',')
    const i = parts.findIndex((f) => f.startsWith('loudnorm='))
    return parts.slice(0, i)
  }

  it('measures the same pre-filters it later normalizes through', async () => {
    // A downmix changes the programme's measured loudness. Measuring the
    // 5.1 source and then normalizing a stereo fold-down misses the target
    // by whatever the fold shifted it.
    mockProbeMedia.mockResolvedValue(probe({
      audioStreams: [{ index: 0, codec_name: 'eac3', channels: 6, sample_rate: '48000', channel_layout: '5.1' }]
    }))
    await normalizeFile(
      task({ operation: 'normalize', normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'dialog-stereo' } }),
      vi.fn()
    )

    const analysisChain = argAfter(calls()[0], '-af')!
    const encodeChain = argAfter(calls()[1], '-filter_complex')!.replace(/^\[0:a:0\]/, '').replace(/\[a0\]$/, '')

    expect(throughLoudnorm(analysisChain)).toEqual(throughLoudnorm(encodeChain))
    expect(throughLoudnorm(analysisChain).some((f) => f.startsWith('pan='))).toBe(true)
  })

  it('runs the analysis pass in JSON print mode without measured values', async () => {
    await normalizeFile(task({ operation: 'normalize' }), vi.fn())
    const af = argAfter(calls()[0], '-af')!
    expect(af).toContain('print_format=json')
    expect(af).not.toContain('measured_')
  })

  it('feeds every measured value back into the encode pass', async () => {
    await normalizeFile(task({ operation: 'normalize' }), vi.fn())
    const fc = argAfter(calls()[1], '-filter_complex')!
    for (const key of ['measured_I=-23.10', 'measured_TP=-9.20', 'measured_LRA=7.30', 'measured_thresh=-33.40', 'offset=-0.15']) {
      expect(fc).toContain(key)
    }
  })

  it('pins the output sample rate so dynamic mode cannot leave it at 192 kHz', async () => {
    await normalizeFile(task({ operation: 'normalize' }), vi.fn())
    expect(argAfter(calls()[1], '-filter_complex')).toContain('aresample=48000')
  })

  it('analyses each audio stream separately', async () => {
    mockProbeMedia.mockResolvedValue(probe({
      audioStreams: [
        { index: 0, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' },
        { index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }
      ]
    }))
    await normalizeFile(task({ operation: 'normalize' }), vi.fn())
    // Two analysis passes, then one encode.
    expect(calls()).toHaveLength(3)
    expect(argAfter(calls()[0], '-map')).toBe('0:a:0')
    expect(argAfter(calls()[1], '-map')).toBe('0:a:1')
  })

  it('includes the compressor in the encode pass only', async () => {
    // The compressor runs after loudnorm, so it must not colour the
    // measurement taken in pass 1.
    await normalizeFile(
      task({ operation: 'normalize', normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'medium' } }),
      vi.fn()
    )
    expect(argAfter(calls()[0], '-af')).not.toContain('acompressor=')
    expect(argAfter(calls()[1], '-filter_complex')).toContain('acompressor=')
  })

  it('asks the compressor for makeup gain in dB', async () => {
    await normalizeFile(
      task({ operation: 'normalize', normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'heavy' } }),
      vi.fn()
    )
    const fc = argAfter(calls()[1], '-filter_complex')!
    expect(fc).toContain('makeup=5dB')
    // A bare `makeup=5` is a linear x5, i.e. +14 dB.
    expect(fc).not.toMatch(/makeup=\d+(:|,|\[|$)/)
  })
})

/* ------------------------------------------------------------------ */
/*  Compress                                                           */
/* ------------------------------------------------------------------ */

describe('compress: two-pass stats file', () => {
  it('gives each task its own pass log so parallel workers cannot collide', async () => {
    // FFmpeg defaults the stats file to "ffmpeg2pass" in the CWD. Batch
    // workers run concurrently, so without a per-task prefix two parallel
    // two-pass encodes read and overwrite each other's statistics.
    await compressFile(
      task({
        id: 'task-abc',
        operation: 'compress',
        compressOptions: { mode: 'target-size', targetSizeMB: 100, quality: 'medium', twoPass: true }
      }),
      vi.fn()
    )

    const argv = calls()
    expect(argv).toHaveLength(2)

    const first = argAfter(argv[0], '-passlogfile')
    const second = argAfter(argv[1], '-passlogfile')
    expect(first).toBeDefined()
    expect(first).toContain('task-abc')
    // Both passes must agree, or pass 2 finds no statistics.
    expect(second).toBe(first)
  })

  it('uses a different pass log for a different task', async () => {
    await compressFile(
      task({ id: 'task-one', operation: 'compress', compressOptions: { mode: 'target-size', targetSizeMB: 50, quality: 'medium', twoPass: true } }),
      vi.fn()
    )
    const first = argAfter(calls()[0], '-passlogfile')

    mockRunCommand.mockClear()
    await compressFile(
      task({ id: 'task-two', operation: 'compress', compressOptions: { mode: 'target-size', targetSizeMB: 50, quality: 'medium', twoPass: true } }),
      vi.fn()
    )
    expect(argAfter(calls()[0], '-passlogfile')).not.toBe(first)
  })

  it('does not set a pass log for single-pass encodes', async () => {
    await compressFile(
      task({ operation: 'compress', compressOptions: { mode: 'crf', targetSizeMB: 0, quality: 'medium' } }),
      vi.fn()
    )
    expect(calls()[0]).not.toContain('-passlogfile')
  })
})
