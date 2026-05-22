/**
 * Vet the FFmpeg filter chain produced by `normalizeFile` for the
 * compression/downmix/limiter revamp. Confirms:
 *
 *   [downmix?] → loudnorm → [acompressor → alimiter]?
 *
 * The order is deliberate: downmix first so the limiter's TP ceiling
 * applies to the final layout; DRC after loudnorm so makeup gain doesn't
 * shift the LUFS target; alimiter LAST so makeup peaks honor the TP
 * ceiling.
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

const loudnessJson = JSON.stringify({
  input_i: '-20.0',
  input_tp: '-3.0',
  input_lra: '8.0',
  input_thresh: '-30.0',
  target_offset: '4.0'
})

function makeStereoProbe() {
  return {
    audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, sample_rate: '48000', channel_layout: 'stereo' }],
    videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
    subtitleStreams: [],
    format: { duration: '120', size: '10000000', format_name: 'matroska' },
    isVideoFile: true,
    isAudioOnly: false
  }
}

function make51Probe() {
  return {
    audioStreams: [{ index: 1, codec_name: 'aac', channels: 6, sample_rate: '48000', channel_layout: '5.1' }],
    videoStreams: [{ index: 0, codec_name: 'h264', width: 1920, height: 1080 }],
    subtitleStreams: [],
    format: { duration: '120', size: '10000000', format_name: 'matroska' },
    isVideoFile: true,
    isAudioOnly: false
  }
}

function makeTask(overrides?: Partial<ProcessingTask>): ProcessingTask {
  return {
    id: 'norm-chain-1',
    filePath: '/media/test.mkv',
    fileName: 'test.mkv',
    operation: 'normalize',
    status: 'queued',
    progress: 0,
    message: '',
    ...overrides
  }
}

/** Pull `-filter_complex` from the SECOND runCommand call (pass-2 encode). */
function extractEncodeFilterComplex(): string {
  // Pass 1 = loudnorm analysis; pass 2 = the encode with the full chain.
  const args = mockRunCommand.mock.calls[1]?.[1] as string[]
  expect(args, 'encode pass not invoked').toBeDefined()
  const idx = args.indexOf('-filter_complex')
  expect(idx).toBeGreaterThanOrEqual(0)
  return args[idx + 1]
}

function extractChain(filterComplex: string, streamIdx = 0): string[] {
  // Per-stream chain is wrapped `[0:a:N]…[aN]`. Filters inside may contain
  // commas — but the `pan` filter uses `|` separators, and our top-level
  // chain segments are also comma-separated. We split by ',' which works
  // because no filter argument value contains a literal comma in our chains.
  const re = new RegExp(`\\[0:a:${streamIdx}\\](.+?)\\[a${streamIdx}\\]`)
  const m = filterComplex.match(re)
  expect(m, `chain for stream ${streamIdx} not found in: ${filterComplex}`).not.toBeNull()
  return m![1].split(',')
}

function mockAnalysisAndEncode() {
  // Pass 1: loudnorm analysis (stderr JSON).
  mockRunCommand.mockImplementationOnce(() => ({
    promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: loudnessJson }),
    process: { kill: vi.fn() }
  }))
  // Pass 2: encode.
  mockRunCommand.mockImplementationOnce(() => ({
    promise: Promise.resolve({ code: 0, killed: false, stdout: '', stderr: '' }),
    process: { kill: vi.fn() }
  }))
}

describe('normalize: filter chain construction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue(baseConfig)
    mockProbeMedia.mockResolvedValue(makeStereoProbe())
  })

  it('default chain = loudnorm only (no DRC, no downmix, no extra limiter)', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11 } }), vi.fn())
    const chain = extractChain(extractEncodeFilterComplex())
    expect(chain.length).toBe(1)
    expect(chain[0]).toMatch(/^loudnorm=/)
    expect(chain.some((f) => f.startsWith('acompressor='))).toBe(false)
    expect(chain.some((f) => f.startsWith('alimiter='))).toBe(false)
    expect(chain.some((f) => f.startsWith('pan='))).toBe(false)
  })

  it('loudnorm carries measured_* and target_offset values from pass 1', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11 } }), vi.fn())
    const chain = extractChain(extractEncodeFilterComplex())
    const ln = chain.find((f) => f.startsWith('loudnorm='))!
    expect(ln).toContain('I=-16')
    expect(ln).toContain('TP=-1.5')
    expect(ln).toContain('LRA=11')
    expect(ln).toContain('measured_I=-20.0')
    expect(ln).toContain('measured_TP=-3.0')
    expect(ln).toContain('measured_LRA=8.0')
    expect(ln).toContain('measured_thresh=-30.0')
    expect(ln).toContain('offset=4.0')
  })

  it('compression=medium appends acompressor AND alimiter after loudnorm', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'medium' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    const lnIdx = chain.findIndex((f) => f.startsWith('loudnorm='))
    const acIdx = chain.findIndex((f) => f.startsWith('acompressor='))
    const limIdx = chain.findIndex((f) => f.startsWith('alimiter='))
    expect(lnIdx).toBeGreaterThan(-1)
    expect(acIdx).toBeGreaterThan(lnIdx)
    expect(limIdx).toBeGreaterThan(acIdx)
    expect(chain[acIdx]).toContain('threshold=-24dB')
    expect(chain[acIdx]).toContain('ratio=3')
    expect(chain[acIdx]).toContain('makeup=3')
  })

  it('compression=light uses 2:1 ratio at -22 dB', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'light' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    const ac = chain.find((f) => f.startsWith('acompressor='))!
    expect(ac).toContain('threshold=-22dB')
    expect(ac).toContain('ratio=2')
    expect(ac).toContain('makeup=2')
  })

  it('compression=heavy uses 6:1 ratio at -26 dB', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'heavy' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    const ac = chain.find((f) => f.startsWith('acompressor='))!
    expect(ac).toContain('threshold=-26dB')
    expect(ac).toContain('ratio=6')
    expect(ac).toContain('makeup=5')
  })

  it('compression=off skips acompressor and the safety alimiter', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'off' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    expect(chain.some((f) => f.startsWith('acompressor='))).toBe(false)
    expect(chain.some((f) => f.startsWith('alimiter='))).toBe(false)
  })

  it('post-DRC alimiter limit honors the configured TP ceiling (-1.5 dBTP)', async () => {
    mockAnalysisAndEncode()
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, compression: 'medium' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    const lim = chain.find((f) => f.startsWith('alimiter='))!
    // 10^(-1.5/20) ≈ 0.8414
    expect(lim).toBe('alimiter=limit=0.8414')
  })

  it('downmix=keep on stereo source does NOT inject a pan filter', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(makeStereoProbe())
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'keep' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    expect(chain.some((f) => f.startsWith('pan='))).toBe(false)
  })

  it('downmix=stereo on stereo source is a no-op (≤2 channels)', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(makeStereoProbe())
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'stereo' } as any }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    expect(chain.some((f) => f.startsWith('pan='))).toBe(false)
    expect(chain.some((f) => f.startsWith('aresample='))).toBe(false)
  })

  it('downmix=stereo on 5.1 source injects aresample+pan BEFORE loudnorm', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(make51Probe())
    await normalizeFile(
      makeTask({ normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'stereo' } as any }),
      vi.fn()
    )
    const fc = extractEncodeFilterComplex()
    // aresample and pan are comma-joined inside the chain string. The
    // chain string before loudnorm should contain both.
    const lnPos = fc.indexOf('loudnorm=')
    const panPos = fc.indexOf('pan=')
    expect(panPos).toBeGreaterThan(-1)
    expect(panPos).toBeLessThan(lnPos)
    expect(fc).toContain('aresample=matrix_encoding=none')
  })

  it('downmix=dialog-stereo on 5.1 boosts center channel via pan coefficients', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(make51Probe())
    await normalizeFile(
      makeTask({
        normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'dialog-stereo' } as any
      }),
      vi.fn()
    )
    const fc = extractEncodeFilterComplex()
    // Dialog-stereo coefficients: FC=0.707, FL=0.85, BL=0.5, LFE=0.2.
    // The FL term comes first in `pan=stereo|FL=…`.
    expect(fc).toContain('pan=stereo|FL=0.707*FC+0.85*FL+0.5*BL+0.2*LFE')
    expect(fc).toContain('FR=0.707*FC+0.85*FR+0.5*BR+0.2*LFE')
  })

  it('downmix=dialog-stereo on stereo source is a no-op (no center to boost)', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(makeStereoProbe())
    await normalizeFile(
      makeTask({
        normalizeOptions: { I: -16, TP: -1.5, LRA: 11, downmix: 'dialog-stereo' } as any
      }),
      vi.fn()
    )
    const chain = extractChain(extractEncodeFilterComplex())
    expect(chain.some((f) => f.startsWith('pan='))).toBe(false)
  })

  it('full chain on 5.1+dialog-stereo+medium DRC: pan → loudnorm → acompressor → alimiter', async () => {
    mockAnalysisAndEncode()
    mockProbeMedia.mockResolvedValue(make51Probe())
    await normalizeFile(
      makeTask({
        normalizeOptions: {
          I: -16, TP: -1.5, LRA: 11,
          downmix: 'dialog-stereo', compression: 'medium'
        } as any
      }),
      vi.fn()
    )
    const fc = extractEncodeFilterComplex()
    // Verify ordering via string positions (commas internal to pan use `|`).
    const panPos = fc.indexOf('pan=')
    const lnPos = fc.indexOf('loudnorm=')
    const acPos = fc.indexOf('acompressor=')
    const limPos = fc.indexOf('alimiter=')
    expect(panPos).toBeGreaterThanOrEqual(0)
    expect(panPos).toBeLessThan(lnPos)
    expect(lnPos).toBeLessThan(acPos)
    expect(acPos).toBeLessThan(limPos)
  })
})
