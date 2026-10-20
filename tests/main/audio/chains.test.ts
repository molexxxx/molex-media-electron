/**
 * The encode and measure stage builders. Stage order, the oversampled limiter with level=disabled and latency=1
 * written in dB, the output pins, the pre-encode meter branch, the export tail, filter_complex assembly, and the
 * D1 guarantee that every chain ends in an aformat pin with a rate and a layout. The documented encode commands
 * are rebuilt from their chain inputs, and every chain shape recorded on both builds still matches the builders and
 * exited 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  LIMITER, OVERSAMPLE_MIN_RATE, encodeChain, encodeParts, exportLimiterTail, filterComplex, formatDb, limiterStages,
  duplicatedPinStages, meterPrefix, oversampleRate, pinStages, preEncodeMeterStages
} from '../../../src/main/ffmpeg/audio/chains'
import type { ChainOutput, ChainSpec } from '../../../src/main/ffmpeg/audio/chains'
import { LIMITER_MARGIN_DB } from '../../../src/main/ffmpeg/audio/ceilings'
import { DOWNMIX_LAYOUTS } from '../../../src/main/ffmpeg/audio/downmix'
import { NIGHT, compressorStage } from '../../../src/main/ffmpeg/audio/dynamics'
import {
  AC3_DEFAULT_LEVELS, CHAIN_CASES, CHAIN_PREFIX, EXPORT_CEILING, chainRunArgs, chainSpec, scenarioDocuments
} from '../fixtures/ffmpeg/downmix/cases'

const CHAIN_FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'downmix', 'chains')
const BUILDS = ['2022-10-13', '9.0.2'] as const
const LIMITER_15 = 'alimiter=limit=-1.50dB:attack=20:release=200:level=disabled:latency=1'
const LIMITER_25 = 'alimiter=limit=-2.50dB:attack=20:release=200:level=disabled:latency=1'
const SOXR_METER_0 = '[q0]aformat=sample_fmts=dbl,aresample=resampler=soxr:precision=33:osr=384000:osf=dbl,' +
  'astats@p0=measure_perchannel=none:measure_overall=Peak_level,anullsink'

function graph(spec: ChainSpec, k = 0, input = `0:a:${k}`): string
{
  return filterComplex(encodeParts(spec, input, k))
}

/** Parses `name=k=v:k=v` into its options. */
function options(stage: string): Record<string, string>
{
  const out: Record<string, string> = {}
  for (const pair of stage.slice(stage.indexOf('=') + 1).split(':'))
  {
    const at = pair.indexOf('=')
    if (at > 0)
    {
      out[pair.slice(0, at)] = pair.slice(at + 1)
    }
  }
  return out
}

function linear(dbText: string): number
{
  return 10 ** (Number(dbText.replace(/dB$/, '')) / 20)
}

const OUTPUTS: readonly ChainOutput[] =
[
  { sampleRate: 44100, layout: 'stereo', pin: 's16-dither' },
  { sampleRate: 44100, layout: 'stereo', pin: 's16-dither', encoder: 'alac' },
  { sampleRate: 48000, layout: 'stereo', pin: 's32' },
  { sampleRate: 96000, layout: '5.1(side)', pin: 's32', encoder: 'alac' },
  { sampleRate: 48000, layout: '5.1', pin: 'encoder' },
  { sampleRate: 32000, layout: 'mono', pin: 'encoder' },
  { sampleRate: 192000, layout: '7.1', pin: 'encoder' }
]

/** Every combination of the options that change a chain's shape. */
function chainMatrix(): ChainSpec[]
{
  const matrix: ChainSpec[] = []
  for (const out of OUTPUTS)
  {
    for (const processRate of [8000, 22050, 44100, 48000, 96000, 192000, 384000])
    {
      for (const [inputLayout, monoToStereo, downmix] of [['mono', true, null], ['stereo', false, null], ['5.1(side)', false, 'standard'], ['7.1', false, 'dialog']] as const)
      {
        for (const dynamics of [null, compressorStage(NIGHT, -20)])
        {
          for (const preEncodeMeter of [null, 'soxr', 'swr'] as const)
          {
            matrix.push(chainSpec({ inputLayout, monoToStereo, downmix, dynamics, processRate, highpassHz: dynamics === null ? 0 : 80, gainDb: -3.3, out, preEncodeMeter }))
          }
        }
      }
    }
  }
  return matrix
}

describe('LIMITER', () =>
{
  it('limits with a 20 ms attack and a 200 ms release, 0.5 dB under the ceiling', () =>
  {
    expect(LIMITER).toEqual({ attackMs: 20, releaseMs: 200, marginDb: 0.5 })
    expect(LIMITER.marginDb).toBe(LIMITER_MARGIN_DB)
  })
})

describe('formatDb', () =>
{
  it.each([
    [-2, '-2.00dB'],
    [12.646, '12.65dB'],
    [12.644, '12.64dB'],
    [1.005, '1.01dB'],
    [-2.005, '-2.01dB'],
    [-1.9000000000000004, '-1.90dB'],
    [0.30000000000000004, '0.30dB'],
    [-0.004, '0.00dB'],
    [-0, '0.00dB'],
    [0, '0.00dB'],
    [1e-9, '0.00dB'],
    [-1e-7, '0.00dB'],
    [0.005, '0.01dB'],
    [123.456, '123.46dB'],
    [-60.2, '-60.20dB']
  ])('%d is %s, two decimals, never exponential or a negative zero', (db, text) =>
  {
    expect(formatDb(db)).toBe(text)
    expect(text).toMatch(/^-?\d+\.\d{2}dB$/)
  })
})

describe('oversampleRate', () =>
{
  it.each([
    [8000, 192000],
    [16000, 192000],
    [22050, 198450],
    [32000, 192000],
    [44100, 220500],
    [48000, 192000],
    [88200, 264600],
    [96000, 192000],
    [176400, 352800],
    [192000, 192000]
  ])('%d Hz runs the limiter at %d Hz', (rate, oversampled) =>
  {
    expect(oversampleRate(rate)).toBe(oversampled)
    expect(oversampled % rate).toBe(0)
    expect(oversampled).toBeGreaterThanOrEqual(OVERSAMPLE_MIN_RATE)
  })

  it('keeps a rate above 192 kHz and falls back to 192 kHz for an unknown rate', () =>
  {
    expect(oversampleRate(384000)).toBe(384000)
    for (const unknown of [0, -48000, Number.NaN])
    {
      expect(oversampleRate(unknown)).toBe(192000)
    }
  })
})

describe('limiterStages', () =>
{
  it('writes the limiter literal: limit in dB, attack 20, release 200, level disabled, latency 1', () =>
  {
    expect(limiterStages(-1.5, 44100)).toEqual(['aresample=220500', LIMITER_15])
    expect(limiterStages(-2.5, 48000)).toEqual(['aresample=192000', LIMITER_25])
  })

  it('skips the oversampler when the source already runs at 192 kHz or more', () =>
  {
    expect(limiterStages(-1.5, 192000)).toEqual([LIMITER_15])
    expect(limiterStages(-1.5, 352800)).toEqual([LIMITER_15])
  })

  it('clamps the limit into alimiter\'s option range of 0.0625 to 1', () =>
  {
    const low = options(limiterStages(-30, 48000)[1])
    const high = options(limiterStages(3, 48000)[1])
    expect(low.limit).toBe('-24.00dB')
    expect(high.limit).toBe('0.00dB')
    expect(linear(low.limit)).toBeGreaterThanOrEqual(0.0625)
    expect(linear(high.limit)).toBeLessThanOrEqual(1)
  })

  it.each([-0.3, -1, -1.5, -2.5, -3.5, -9.5])('limits at %d dBTP with auto level off and the lookahead compensated', (ceiling) =>
  {
    const limiter = options(limiterStages(ceiling, 44100)[1])
    expect(limiter).toEqual({ limit: formatDb(ceiling), attack: '20', release: '200', level: 'disabled', latency: '1' })
    expect(linear(limiter.limit)).toBeCloseTo(10 ** (ceiling / 20), 3)
  })
})

describe('pinStages', () =>
{
  it('dithers 16-bit outputs with TPDF and pins s16 with the rate and layout', () =>
  {
    expect(pinStages({ sampleRate: 44100, layout: 'stereo', pin: 's16-dither' })).toEqual([
      'aresample=osr=44100:osf=s16:dither_method=triangular',
      'aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo'
    ])
    expect(pinStages({ sampleRate: 44100, layout: 'stereo', pin: 's16-dither', encoder: 'flac' })[1]).toBe('aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo')
  })

  it('lets ALAC take planar 16-bit samples', () =>
  {
    expect(pinStages({ sampleRate: 44100, layout: 'stereo', pin: 's16-dither', encoder: 'alac' })[1])
      .toBe('aformat=sample_fmts=s16|s16p:sample_rates=44100:channel_layouts=stereo')
  })

  it('pins 24-bit outputs as s32, ALAC included', () =>
  {
    expect(pinStages({ sampleRate: 48000, layout: 'stereo', pin: 's32' })).toEqual(['aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo'])
    expect(pinStages({ sampleRate: 48000, layout: 'stereo', pin: 's32', encoder: 'alac' })).toEqual(['aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo'])
  })

  it('leaves the sample format to lossy encoders and pins their rate and layout, remaps included', () =>
  {
    expect(pinStages({ sampleRate: 48000, layout: '5.1', pin: 'encoder' })).toEqual(['aformat=sample_rates=48000:channel_layouts=5.1'])
  })
})

describe('meterPrefix', () =>
{
  it('starts every chain in double precision', () =>
  {
    expect(meterPrefix(chainSpec())).toEqual(['aformat=sample_fmts=dbl'])
  })

  it('duplicates a mono source into two full-level channels, and only a mono source', () =>
  {
    expect(meterPrefix(chainSpec({ inputLayout: 'mono', monoToStereo: true }))).toEqual(['aformat=sample_fmts=dbl', 'pan=stereo|c0=c0|c1=c0'])
    expect(meterPrefix(chainSpec({ inputLayout: 'stereo', monoToStereo: true }))).toEqual(['aformat=sample_fmts=dbl'])
    expect(meterPrefix(chainSpec({ inputLayout: 'mono', monoToStereo: false }))).toEqual(['aformat=sample_fmts=dbl'])
  })

  it('downmixes before measurement and pins the stereo result in float', () =>
  {
    expect(meterPrefix(chainSpec({ inputLayout: '5.1(side)', downmix: 'standard', downmixLevels: AC3_DEFAULT_LEVELS }))).toEqual([
      'aformat=sample_fmts=dbl',
      'pan=stereo|FL=FL+0.594604*FC+0.5*SL|FR=FR+0.594604*FC+0.5*SR',
      'aformat=sample_fmts=dbl:channel_layouts=stereo'
    ])
    const { downmixLevels: _omitted, ...withoutLevels } = chainSpec({ inputLayout: '5.1(side)', downmix: 'standard' })
    expect(meterPrefix(withoutLevels)[1]).toBe('pan=stereo|FL=FL+0.7071*FC+0.7071*SL|FR=FR+0.7071*FC+0.7071*SR')
  })

  it('adds no downmix to a stereo or mono source, or to a layout that cannot be downmixed', () =>
  {
    for (const inputLayout of ['stereo', 'mono', '7.1(wide)'])
    {
      expect(meterPrefix(chainSpec({ inputLayout, downmix: 'dialog' }))).toEqual(['aformat=sample_fmts=dbl'])
    }
  })

  it('runs the anchored compressor last, after the downmix', () =>
  {
    const compressor = compressorStage(NIGHT, -22.6)
    const stages = meterPrefix(chainSpec({ inputLayout: '5.1', downmix: 'dialog', dynamics: compressor }))
    expect(stages[1]).toBe('pan=stereo|FL=FL+FC+0.5*BL|FR=FR+FC+0.5*BR')
    expect(stages[stages.length - 1]).toBe(compressor)
  })
})

describe('encodeChain', () =>
{
  it('orders float, duplication, downmix, compressor, high-pass, gain, oversampler, limiter, and pin', () =>
  {
    const chain = encodeChain(chainSpec({
      inputLayout: '5.1(side)', downmix: 'standard', dynamics: compressorStage(NIGHT, -22.6), highpassHz: 60, gainDb: 3,
      processRate: 48000, out: { sampleRate: 48000, layout: 'stereo', pin: 's16-dither' }
    }))
    const at = (prefix: string): number => chain.findIndex((stage) => stage.startsWith(prefix))
    const order = ['aformat=sample_fmts=dbl', 'pan=stereo', 'aformat=sample_fmts=dbl:channel_layouts=stereo', 'acompressor=',
      'highpass=f=60:poles=2', 'volume=3.00dB:precision=double', 'aresample=192000', 'alimiter=', 'aresample=osr=48000', 'aformat=sample_fmts=s16']
    expect(order.map(at)).toEqual(order.map((_, index) => index))
    expect(chain).toHaveLength(order.length)
  })

  it('shares stages 1 to 4 with the meter, so measure and encode see the same signal', () =>
  {
    for (const spec of chainMatrix())
    {
      const duplicated = spec.monoToStereo && spec.inputLayout === 'mono'
      const prefix = meterPrefix(duplicated ? { ...spec, monoToStereo: false } : spec)
      expect(encodeChain(spec).slice(0, prefix.length)).toEqual(prefix)
    }
  })

  it('duplicates a mono source after its pin, so one dither reaches both channels', () =>
  {
    const chain = encodeChain(chainSpec({ inputLayout: 'mono', monoToStereo: true }))
    expect(meterPrefix(chainSpec({ inputLayout: 'mono', monoToStereo: true }))).toContain('pan=stereo|c0=c0|c1=c0')
    expect(chain.indexOf('pan=stereo|c0=c0|c1=c0')).toBe(chain.length - 2)
    expect(chain.slice(-3)).toEqual([
      'aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono',
      'pan=stereo|c0=c0|c1=c0',
      'aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo'
    ])
    expect(duplicatedPinStages({ sampleRate: 48000, layout: 'stereo', pin: 'encoder' }))
      .toEqual(['aformat=sample_rates=48000:channel_layouts=mono', 'pan=stereo|c0=c0|c1=c0', 'aformat=sample_rates=48000:channel_layouts=stereo'])
    expect(duplicatedPinStages({ sampleRate: 48000, layout: 'stereo', pin: 's32' }).at(-1)).toBe('aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo')
  })

  it('applies the gain as volume in dB at double precision, never a linear factor', () =>
  {
    for (const gainDb of [-20, -2, 0, 0.1, 5.5, 12])
    {
      const volume = encodeChain(chainSpec({ gainDb })).find((stage) => stage.startsWith('volume=')) as string
      expect(volume).toBe(`volume=${formatDb(gainDb)}:precision=double`)
    }
  })

  it('adds the high-pass only when one is set', () =>
  {
    expect(encodeChain(chainSpec({ highpassHz: 0 })).some((stage) => stage.startsWith('highpass='))).toBe(false)
    expect(encodeChain(chainSpec({ highpassHz: 100 }))).toContain('highpass=f=100:poles=2')
  })

  it('always limits: a boost or an attenuation gets the limiter at any gain (D5)', () =>
  {
    for (const gainDb of [-20, 0, 12])
    {
      expect(encodeChain(chainSpec({ gainDb })).filter((stage) => stage.startsWith('alimiter='))).toEqual([LIMITER_15])
    }
  })

  it('keeps a stream at its own layout when no downmix is set', () =>
  {
    const chain = encodeChain(chainSpec({ inputLayout: '5.1', processRate: 48000, out: { sampleRate: 48000, layout: '5.1', pin: 'encoder' } }))
    expect(chain.some((stage) => stage.includes('stereo'))).toBe(false)
    expect(chain[chain.length - 1]).toBe('aformat=sample_rates=48000:channel_layouts=5.1')
  })

  it('every chain ends in an aformat pin with rate and layout and has no bare aresample (D1)', () =>
  {
    const matrix = chainMatrix()
    expect(matrix.length).toBeGreaterThan(1000)
    for (const spec of matrix)
    {
      const chain = encodeChain(spec)
      expect(chain[chain.length - 1]).toMatch(/^aformat=(sample_fmts=[^:]+:)?sample_rates=\d+:channel_layouts=[^:]+$/)
      expect(chain).not.toContain('aresample')
      chain.forEach((stage, index) =>
      {
        if (/^aresample=\d+$/.test(stage))
        {
          expect(chain[index + 1]).toMatch(/^alimiter=/)
        }
      })
      const limiter = chain.findIndex((stage) => stage.startsWith('alimiter='))
      expect(chain.slice(limiter + 1).some((stage) => /^aresample(=\d+)?$/.test(stage))).toBe(false)
    }
  })
})

describe('documented encode commands', () =>
{
  it('16-bit FLAC to -16 LUFS: G -2.00 linear with the dithered 16-bit pin', () =>
  {
    expect(graph(chainSpec({ gainDb: -2 }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=-2.00dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a0]')
  })

  it('boost +6 dB capped to +5.5 with the 20 Hz high-pass', () =>
  {
    expect(graph(chainSpec({ highpassHz: 20, gainDb: 5.5 }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,highpass=f=20:poles=2,volume=5.50dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a0]')
  })

  it('mono podcast to WAV for Apple Podcasts, duplicated into two channels', () =>
  {
    expect(graph(chainSpec({ inputLayout: 'mono', monoToStereo: true, gainDb: 5 }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=5.00dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono,' +
      'pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a0]')
  })

  it('a 32 kHz mono source oversampled to 192 kHz and pinned to 44.1 kHz', () =>
  {
    expect(graph(chainSpec({ inputLayout: 'mono', processRate: 32000, monoToStereo: true, gainDb: 5 }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=5.00dB:precision=double,aresample=192000,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono,' +
      'pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo[a0]')
  })

  it('mono speech to EBU R 128 as one channel', () =>
  {
    expect(graph(chainSpec({ inputLayout: 'mono', gainDb: 1, out: { sampleRate: 44100, layout: 'mono', pin: 's16-dither' } }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=1.00dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono[a0]')
  })

  it('5.1(side) to Opus 5.1 with the remap in the pin and the pre-encode meter', () =>
  {
    expect(graph(chainSpec({ inputLayout: '5.1(side)', processRate: 48000, gainDb: -0.4, limiterCeilingDbtp: -3.5,
      out: { sampleRate: 48000, layout: '5.1', pin: 'encoder' }, preEncodeMeter: 'soxr' }))).toBe(
      '[0:a:0]aformat=sample_fmts=dbl,volume=-0.40dB:precision=double,aresample=192000,' +
      'alimiter=limit=-3.50dB:attack=20:release=200:level=disabled:latency=1,aformat=sample_rates=48000:channel_layouts=5.1,' +
      `asplit=2[a0][q0];${SOXR_METER_0}`)
  })

  it('AC-3 5.1(side) downmixed with its own levels to AC-3 stereo', () =>
  {
    expect(graph(chainSpec({ inputLayout: '5.1(side)', processRate: 48000, downmix: 'standard', downmixLevels: AC3_DEFAULT_LEVELS,
      gainDb: 1.4, limiterCeilingDbtp: -2.5, out: { sampleRate: 48000, layout: 'stereo', pin: 'encoder' }, preEncodeMeter: 'soxr' }))).toBe(
      '[0:a:0]aformat=sample_fmts=dbl,pan=stereo|FL=FL+0.594604*FC+0.5*SL|FR=FR+0.594604*FC+0.5*SR,' +
      `aformat=sample_fmts=dbl:channel_layouts=stereo,volume=1.40dB:precision=double,aresample=192000,${LIMITER_25},` +
      `aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[a0][q0];${SOXR_METER_0}`)
  })

  it('a short-form item at +12.64 dB to 24-bit PCM', () =>
  {
    expect(graph(chainSpec({ processRate: 48000, gainDb: 12.64, out: { sampleRate: 48000, layout: 'stereo', pin: 's32' } }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=12.64dB:precision=double,aresample=192000,${LIMITER_15},` +
      'aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo[a0]')
  })

  it('night listening: the anchored compressor, then +10.50 dB linear', () =>
  {
    expect(graph(chainSpec({ inputLayout: '5.1(side)', processRate: 48000, dynamics: compressorStage(NIGHT, -22.6), gainDb: 10.5,
      limiterCeilingDbtp: -2.5, out: { sampleRate: 48000, layout: '5.1(side)', pin: 'encoder' }, preEncodeMeter: 'soxr' }))).toBe(
      '[0:a:0]aformat=sample_fmts=dbl,acompressor=threshold=-22.60dB:ratio=3:attack=25:release=300:knee=2.8284:detection=rms:link=maximum,' +
      `volume=10.50dB:precision=double,aresample=192000,${LIMITER_25},aformat=sample_rates=48000:channel_layouts=5.1(side),` +
      `asplit=2[a0][q0];${SOXR_METER_0}`)
  })

  it('ALAC 16-bit with the s16 or s16p pin', () =>
  {
    expect(graph(chainSpec({ gainDb: -1.9, out: { sampleRate: 44100, layout: 'stereo', pin: 's16-dither', encoder: 'alac' } }))).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=-1.90dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16|s16p:sample_rates=44100:channel_layouts=stereo[a0]')
  })

  it('a multi-stream MKV: one chain and one meter per audio stream, joined by semicolons', () =>
  {
    const stream = (gainDb: number, layout: string): ChainSpec => chainSpec({ inputLayout: layout, processRate: 48000, gainDb,
      limiterCeilingDbtp: -2.5, out: { sampleRate: 48000, layout, pin: 'encoder' }, preEncodeMeter: 'soxr' })
    const parts = [...encodeParts(stream(-8.9, 'stereo'), '0:a:0', 0), ...encodeParts(stream(-2.1, '5.1(side)'), '0:a:1', 1)]
    expect(filterComplex(parts)).toBe(
      `[0:a:0]aformat=sample_fmts=dbl,volume=-8.90dB:precision=double,aresample=192000,${LIMITER_25},` +
      `aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[a0][q0];${SOXR_METER_0};` +
      `[0:a:1]aformat=sample_fmts=dbl,volume=-2.10dB:precision=double,aresample=192000,${LIMITER_25},` +
      'aformat=sample_rates=48000:channel_layouts=5.1(side),asplit=2[a1][q1];' +
      '[q1]aformat=sample_fmts=dbl,aresample=resampler=soxr:precision=33:osr=384000:osf=dbl,' +
      'astats@p1=measure_perchannel=none:measure_overall=Peak_level,anullsink')
  })

  it('the startup self-test chains are the builders\' output', () =>
  {
    expect(encodeChain(chainSpec({ gainDb: 6 })).join(',')).toBe(
      `aformat=sample_fmts=dbl,volume=6.00dB:precision=double,aresample=220500,${LIMITER_15},` +
      'aresample=osr=44100:osf=s16:dither_method=triangular,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo')
    expect(encodeChain(chainSpec({ inputLayout: '5.1(side)', processRate: 48000, gainDb: -3, limiterCeilingDbtp: -3.5,
      out: { sampleRate: 48000, layout: '5.1', pin: 'encoder' } })).join(',')).toBe(
      'aformat=sample_fmts=dbl,volume=-3.00dB:precision=double,aresample=192000,' +
      'alimiter=limit=-3.50dB:attack=20:release=200:level=disabled:latency=1,aformat=sample_rates=48000:channel_layouts=5.1')
    expect(encodeChain(chainSpec({ inputLayout: 'mono', processRate: 32000, limiterCeilingDbtp: -3.5,
      out: { sampleRate: 32000, layout: 'mono', pin: 'encoder' } })).join(',')).toBe(
      'aformat=sample_fmts=dbl,volume=0.00dB:precision=double,aresample=192000,' +
      'alimiter=limit=-3.50dB:attack=20:release=200:level=disabled:latency=1,aformat=sample_rates=32000:channel_layouts=mono')
  })
})

describe('pre-encode meter', () =>
{
  it('oversamples 8x with soxr at precision 33 in float', () =>
  {
    expect(preEncodeMeterStages('soxr', 48000, 3)).toEqual([
      'aformat=sample_fmts=dbl', 'aresample=resampler=soxr:precision=33:osr=384000:osf=dbl',
      'astats@p3=measure_perchannel=none:measure_overall=Peak_level', 'anullsink'
    ])
  })

  it('falls back to the default resampler without libsoxr', () =>
  {
    expect(preEncodeMeterStages('swr', 44100, 0)[1]).toBe('aresample=osr=352800:osf=dbl')
  })

  it('splits the pinned signal into the encoder label and the meter branch', () =>
  {
    const spec = chainSpec({ out: { sampleRate: 44100, layout: 'stereo', pin: 'encoder' }, preEncodeMeter: 'swr' })
    const parts = encodeParts(spec, '0:a:2', 1)
    expect(parts).toEqual([
      { input: '0:a:2', stages: [...encodeChain(spec), 'asplit=2[a1][q1]'], output: '' },
      { input: 'q1', stages: preEncodeMeterStages('swr', 44100, 1), output: '' }
    ])
  })

  it('leaves lossless outputs unsplit', () =>
  {
    expect(encodeParts(chainSpec(), '0:a:0', 0)).toEqual([{ input: '0:a:0', stages: encodeChain(chainSpec()), output: 'a0' }])
  })
})

describe('exportLimiterTail', () =>
{
  it('limits the mix at the export ceiling and pins the encoder rate and layout (D17)', () =>
  {
    expect(filterComplex([{ input: 'mix', stages: exportLimiterTail(EXPORT_CEILING, 48000, 'stereo'), output: 'aout' }])).toBe(
      `[mix]aformat=sample_fmts=dbl,aresample=192000,${LIMITER_25},aformat=sample_rates=48000:channel_layouts=stereo[aout]`)
  })

  it('needs no oversampler for a 192 kHz mix', () =>
  {
    expect(exportLimiterTail(EXPORT_CEILING, 192000, '5.1')).toEqual(['aformat=sample_fmts=dbl', LIMITER_25, 'aformat=sample_rates=192000:channel_layouts=5.1'])
  })
})

describe('filterComplex', () =>
{
  it('labels inputs and outputs and joins parts with semicolons', () =>
  {
    expect(filterComplex([
      { input: '0:a:0', stages: ['anull', 'volume=0.00dB:precision=double'], output: 'a0' },
      { input: '0:a:1', stages: ['anull'], output: 'a1' }
    ])).toBe('[0:a:0]anull,volume=0.00dB:precision=double[a0];[0:a:1]anull[a1]')
  })

  it('leaves out empty labels and stands in anull for an empty chain', () =>
  {
    expect(filterComplex([{ input: '', stages: [], output: '' }])).toBe('anull')
    expect(filterComplex([{ input: 'x', stages: [], output: 'y' }])).toBe('[x]anull[y]')
    expect(filterComplex([])).toBe('')
  })
})

describe('recorded chain runs', () =>
{
  it('come from the generated scenarios', () =>
  {
    const scenarios = JSON.parse(fs.readFileSync(path.join(CHAIN_FIXTURES, 'scenarios.json'), 'utf8')) as unknown
    expect(scenarios).toEqual(JSON.parse(JSON.stringify(scenarioDocuments().chains)))
  })

  it('cover every supported downmix layout with the standard downmix, and a fold for each', () =>
  {
    const names = new Set(CHAIN_CASES.map((chain) => chain.name))
    for (const layout of DOWNMIX_LAYOUTS)
    {
      const slug = layout.replace('(', '-').replace(')', '')
      expect(names.has(`downmix-bs775-${slug}`), layout).toBe(true)
      expect(names.has(`fold-${slug}`), layout).toBe(true)
    }
  })

  it.each(BUILDS)('%s: every chain still matches the builders and exited 0', (build) =>
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(CHAIN_FIXTURES, build, 'runs.json'), 'utf8')) as
      { runs: Array<{ name: string; argv: string[]; code: number | null; signal: string | null }> }
    expect(manifest.runs.map((run) => run.name)).toEqual(CHAIN_CASES.map((chain) => chain.name))
    manifest.runs.forEach((run, index) =>
    {
      expect(run.argv, run.name).toEqual([...CHAIN_PREFIX, ...chainRunArgs(CHAIN_CASES[index])])
      expect(run.code, run.name).toBe(0)
      expect(run.signal, run.name).toBeNull()
    })
  })
})
