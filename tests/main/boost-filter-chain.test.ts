/**
 * Vet the FFmpeg filter chain produced by `boostFile` for the revamped
 * volume-boost pipeline:
 *
 *   aformat=… → [highpass=f=N] → volume=M → [alimiter=limit=L]
 *
 * Order matters: HPF must come BEFORE `volume` (so rumble doesn't eat
 * headroom), and `alimiter` must come AFTER `volume` (so it catches peaks
 * created by the gain stage). These tests parse the `-filter_complex`
 * argument actually passed to FFmpeg and assert structure, ordering, and
 * numeric values.
 */

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
  afterProcessing: 'replace',
  outputDirectory: '',
  preserveSubtitles: true,
  preserveMetadata: true
}

const sampleProbe = {
  audioStreams: [
    { index: 0, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }
  ],
  videoStreams: [],
  subtitleStreams: [],
  format: { duration: '120', size: '5000000', format_name: 'mp3' },
  isVideoFile: false,
  isAudioOnly: true
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'boost-chain-1',
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

/** Pull the `-filter_complex` value out of the args passed to ffmpeg. */
function extractFilterComplex(): string {
  const args = mockRunCommand.mock.calls[0]?.[1] as string[]
  expect(args, 'runCommand was not invoked').toBeDefined()
  const idx = args.indexOf('-filter_complex')
  expect(idx).toBeGreaterThanOrEqual(0)
  return args[idx + 1]
}

/** Pull the per-stream chain (between input tag and output tag). */
function extractStreamChain(filterComplex: string, streamIdx = 0): string[] {
  const re = new RegExp(`\\[0:a:${streamIdx}\\]([^\\[]+)\\[a${streamIdx}\\]`)
  const m = filterComplex.match(re)
  expect(m, `chain for stream ${streamIdx} not found in: ${filterComplex}`).not.toBeNull()
  return m![1].split(',')
}

describe('boost: filter chain construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(sampleProbe)
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
      process: { kill: vi.fn() }
    })
  })

  it('legacy mode (no boostOptions) produces aformat → volume only', async () => {
    await boostFile(makeTask({ boostPercent: 50 }), vi.fn())
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain.length).toBe(2)
    expect(chain[0]).toMatch(/^aformat=/)
    expect(chain[1]).toBe('volume=1.5')
    expect(chain.some((f) => f.startsWith('highpass='))).toBe(false)
    expect(chain.some((f) => f.startsWith('alimiter='))).toBe(false)
  })

  it('inserts highpass BEFORE volume when hpfHz > 0', async () => {
    await boostFile(
      makeTask({ boostPercent: 30, boostOptions: { limiter: false, hpfHz: 80 } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    const hpfIdx = chain.findIndex((f) => f === 'highpass=f=80')
    const volIdx = chain.findIndex((f) => f.startsWith('volume='))
    expect(hpfIdx).toBeGreaterThan(-1)
    expect(volIdx).toBeGreaterThan(hpfIdx)
  })

  it('omits highpass when hpfHz is 0', async () => {
    await boostFile(
      makeTask({ boostOptions: { limiter: false, hpfHz: 0 } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain.some((f) => f.startsWith('highpass='))).toBe(false)
  })

  it('omits highpass when hpfHz is missing', async () => {
    await boostFile(
      makeTask({ boostOptions: { limiter: false } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain.some((f) => f.startsWith('highpass='))).toBe(false)
  })

  it('appends alimiter AFTER volume when limiter is enabled', async () => {
    await boostFile(
      makeTask({ boostPercent: 100, boostOptions: { limiter: true, limiterCeiling: -1 } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    const volIdx = chain.findIndex((f) => f.startsWith('volume='))
    const limIdx = chain.findIndex((f) => f.startsWith('alimiter='))
    expect(volIdx).toBeGreaterThan(-1)
    expect(limIdx).toBeGreaterThan(volIdx)
  })

  it('computes alimiter ceiling as 10^(ceiling/20) — -1 dBTP ≈ 0.8913', async () => {
    await boostFile(
      makeTask({ boostOptions: { limiter: true, limiterCeiling: -1 } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    const lim = chain.find((f) => f.startsWith('alimiter='))!
    expect(lim).toBe('alimiter=limit=0.8913')
  })

  it('computes alimiter ceiling for -0.3 dBTP (loudness max)', async () => {
    await boostFile(
      makeTask({ boostOptions: { limiter: true, limiterCeiling: -0.3 } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    const lim = chain.find((f) => f.startsWith('alimiter='))!
    // 10^(-0.3/20) ≈ 0.9661
    expect(lim).toBe('alimiter=limit=0.9661')
  })

  it('full chain order: aformat → highpass → volume → alimiter', async () => {
    await boostFile(
      makeTask({
        boostPercent: 75,
        boostOptions: { limiter: true, limiterCeiling: -1, hpfHz: 100 }
      }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain.length).toBe(4)
    expect(chain[0]).toMatch(/^aformat=/)
    expect(chain[1]).toBe('highpass=f=100')
    expect(chain[2]).toBe('volume=1.75')
    expect(chain[3]).toMatch(/^alimiter=limit=/)
  })

  it('multiplier matches 1 + percent/100 across positive/zero/negative', async () => {
    for (const [pct, expected] of [
      [0, 'volume=1'],
      [25, 'volume=1.25'],
      [100, 'volume=2'],
      [200, 'volume=3'],
      [-25, 'volume=0.75'],
      [-50, 'volume=0.5']
    ] as const) {
      mockRunCommand.mockClear()
      await boostFile(makeTask({ boostPercent: pct }), vi.fn())
      const chain = extractStreamChain(extractFilterComplex())
      expect(chain.find((f) => f.startsWith('volume='))).toBe(expected)
    }
  })

  it('does NOT auto-add a limiter when limiter is off, even at high boost', async () => {
    // Honoring user choice: clip risk is surfaced in the UI, not silently
    // patched in the backend.
    await boostFile(
      makeTask({ boostPercent: 200, boostOptions: { limiter: false } }),
      vi.fn()
    )
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain.some((f) => f.startsWith('alimiter='))).toBe(false)
  })

  it('emits one chain per audio stream for multi-stream sources', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [
        { index: 0, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' },
        { index: 1, codec_name: 'aac', channels: 6, sample_rate: '48000', channel_layout: '5.1' }
      ]
    })
    await boostFile(
      makeTask({
        boostPercent: 50,
        boostOptions: { limiter: true, limiterCeiling: -1, hpfHz: 60 }
      }),
      vi.fn()
    )
    const fc = extractFilterComplex()
    // Two chains joined by ';'.
    expect(fc.split(';').length).toBe(2)
    const c0 = extractStreamChain(fc, 0)
    const c1 = extractStreamChain(fc, 1)
    for (const c of [c0, c1]) {
      expect(c[0]).toMatch(/^aformat=/)
      expect(c).toContain('highpass=f=60')
      expect(c.find((f) => f.startsWith('volume='))).toBe('volume=1.5')
      expect(c.some((f) => f.startsWith('alimiter='))).toBe(true)
    }
  })

  it('aformat reflects per-stream channel layout and sample rate', async () => {
    mockProbeMedia.mockResolvedValue({
      ...sampleProbe,
      audioStreams: [
        { index: 0, codec_name: 'aac', channels: 1, sample_rate: '44100', channel_layout: 'mono' }
      ]
    })
    await boostFile(makeTask({ boostPercent: 25 }), vi.fn())
    const chain = extractStreamChain(extractFilterComplex())
    expect(chain[0]).toMatch(/sample_rates=44100/)
  })
})
