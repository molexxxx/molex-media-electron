/**
 * Contract tests for the audio filter builders.
 *
 * Every assertion here is pinned to documented FFmpeg behaviour, verified
 * against `doc/filters.texi` and `ffmpeg -h filter=<name>`. The comments
 * name the guarantee each test protects so a future change that silently
 * reintroduces one of the audited defects fails loudly.
 *
 * Reference values used throughout:
 *   10^(-1/20)   = 0.891251  -> "0.8913"
 *   10^(-0.3/20) = 0.966051  -> "0.9661"
 *   10^(-1.5/20) = 0.841395  -> "0.8414"
 *   10^(-2/20)   = 0.794328  -> "0.7943"
 */

import { describe, it, expect } from 'vitest'

import {
  channelLayoutName,
  dbToLinear,
  linearToDb,
  percentToMultiplier,
  buildAformat,
  buildLimiter,
  buildBoostChain,
  buildCompressorFilter,
  buildDownmixFilter,
  buildPreLoudnormFilters,
  buildLoudnormFilter,
  buildAnalysisChain,
  buildLoudnormChain,
  predictsLinearNormalization,
  COMPRESSOR_MAKEUP_DB,
  type NormalizeSpec,
  type LoudnessMeasurement
} from '../../src/main/ffmpeg/processor/audio-filters'

/** Parse `name=k=v:k=v` into a lookup of its options. */
function parseFilterOptions(filter: string): Record<string, string> {
  const eq = filter.indexOf('=')
  if (eq === -1) return {}
  const out: Record<string, string> = {}
  for (const pair of filter.slice(eq + 1).split(':')) {
    const i = pair.indexOf('=')
    if (i === -1) continue
    out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

const measurement = (over: Partial<LoudnessMeasurement> = {}): LoudnessMeasurement => ({
  input_i: '-23.10',
  input_tp: '-5.20',
  input_lra: '7.30',
  input_thresh: '-33.40',
  target_offset: '-0.15',
  ...over
})

const spec = (over: Partial<NormalizeSpec> = {}): NormalizeSpec => ({
  I: -16,
  TP: -1.5,
  LRA: 11,
  ...over
})

/* ------------------------------------------------------------------ */
/*  Unit conversions                                                   */
/* ------------------------------------------------------------------ */

describe('dB / linear conversions', () => {
  it('converts dB to linear amplitude', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 10)
    expect(dbToLinear(-6.020599913)).toBeCloseTo(0.5, 9)
    expect(dbToLinear(6.020599913)).toBeCloseTo(2, 9)
    expect(dbToLinear(-1)).toBeCloseTo(0.891251, 6)
  })

  it('round-trips through linearToDb', () => {
    for (const db of [-24, -12, -6, -3, -1, -0.3, 0]) {
      expect(linearToDb(dbToLinear(db))).toBeCloseTo(db, 10)
    }
  })

  it('maps boost percent to the linear multiplier the volume filter wants', () => {
    // `volume` takes a linear multiplier: output = volume * input.
    expect(percentToMultiplier(0)).toBe(1)
    expect(percentToMultiplier(100)).toBe(2)
    expect(percentToMultiplier(-50)).toBe(0.5)
    expect(percentToMultiplier(-100)).toBe(0)
    // +100 % is the doubling the UI advertises as "≈ +6 dB".
    expect(linearToDb(percentToMultiplier(100))).toBeCloseTo(6.0206, 4)
  })
})

/* ------------------------------------------------------------------ */
/*  Channel layouts                                                    */
/* ------------------------------------------------------------------ */

describe('channelLayoutName', () => {
  it('names the layouts FFmpeg has an unambiguous term for', () => {
    expect(channelLayoutName(1)).toBe('mono')
    expect(channelLayoutName(2)).toBe('stereo')
    expect(channelLayoutName(4)).toBe('quad')
    expect(channelLayoutName(6)).toBe('5.1')
    expect(channelLayoutName(8)).toBe('7.1')
  })

  it('returns null rather than guessing for ambiguous counts', () => {
    // Regression: the previous helper returned "stereo" for anything it
    // did not recognise, so `aformat=channel_layouts=stereo` silently
    // downmixed 3/5/7-channel sources during a volume-only operation.
    for (const n of [0, 3, 5, 7, 9, 99]) {
      expect(channelLayoutName(n)).toBeNull()
    }
  })
})

describe('buildAformat', () => {
  it('pins the source layout and rate', () => {
    expect(buildAformat(6, '48000')).toBe('aformat=channel_layouts=5.1:sample_rates=48000')
  })

  it('prefers the layout ffprobe reported over the count-derived name', () => {
    expect(buildAformat(6, '48000', '5.1(side)')).toBe(
      'aformat=channel_layouts=5.1(side):sample_rates=48000'
    )
  })

  it('omits the layout constraint when the count is ambiguous', () => {
    // Better to let FFmpeg carry the source layout through than to force
    // a fold-down the user never asked for.
    expect(buildAformat(5, '44100')).toBe('aformat=sample_rates=44100')
  })

  it('never constrains sample_fmts on a real stream', () => {
    // `volume` runs at precision=float, which already restricts its input
    // to FLT. Forcing s16 first quantised 24-bit and float sources to 16
    // bits and then converted straight back up.
    expect(buildAformat(2, '96000')).not.toContain('sample_fmts')
    expect(buildAformat(6, '48000', '5.1')).not.toContain('sample_fmts')
  })

  it('falls back to a valid filter when nothing is known', () => {
    expect(buildAformat(0, undefined)).toBe('aformat=sample_fmts=fltp')
  })
})

/* ------------------------------------------------------------------ */
/*  Limiter                                                            */
/* ------------------------------------------------------------------ */

describe('buildLimiter', () => {
  it('converts the dB ceiling to alimiter\'s linear limit', () => {
    expect(buildLimiter({ ceilingDb: -1 })).toContain('limit=0.8913')
    expect(buildLimiter({ ceilingDb: -0.3 })).toContain('limit=0.9661')
    expect(buildLimiter({ ceilingDb: -1.5 })).toContain('limit=0.8414')
    expect(buildLimiter({ ceilingDb: -2 })).toContain('limit=0.7943')
  })

  it('always disables auto-level', () => {
    // The docs: "level - Auto level output signal. Default is enabled.
    // This normalizes audio back to 0dB if enabled." That auto makeup is
    // 1/limit, applied unconditionally. Measured against ffmpeg: a
    // -6.02 dBFS tone through volume=1.0 + alimiter=limit=0.8913 came out
    // at -5.02 dBFS -- a full dB of gain nobody asked for -- and
    // volume=2.0 peaked at 0.00 dBFS instead of the requested -1.0.
    for (const ceilingDb of [-0.3, -1, -1.5, -3, -6]) {
      expect(buildLimiter({ ceilingDb })).toContain('level=disabled')
    }
  })

  it('always compensates lookahead latency', () => {
    // Without latency=1 every limited stream is delayed by the attack time
    // (5 ms by default) and the lookahead buffer is not flushed at EOF, so
    // video drifts out of sync and the tail of the audio is lost.
    expect(buildLimiter({ ceilingDb: -1 })).toContain('latency=1')
  })

  it('clamps the ceiling into alimiter\'s documented limit range', () => {
    // `limit` is documented as 0.0625 - 1 (i.e. -24 dBFS - 0 dBFS).
    const tooLow = parseFilterOptions(buildLimiter({ ceilingDb: -60 }))
    const tooHigh = parseFilterOptions(buildLimiter({ ceilingDb: 6 }))
    expect(parseFloat(tooLow.limit)).toBeGreaterThanOrEqual(0.0625)
    expect(parseFloat(tooHigh.limit)).toBeLessThanOrEqual(1)
  })

  it('emits attack and release only when asked', () => {
    expect(buildLimiter({ ceilingDb: -1 })).not.toContain('attack=')
    const tuned = buildLimiter({ ceilingDb: -1, attackMs: 5, releaseMs: 50 })
    expect(tuned).toContain('attack=5')
    expect(tuned).toContain('release=50')
  })
})

/* ------------------------------------------------------------------ */
/*  Boost chain                                                        */
/* ------------------------------------------------------------------ */

describe('buildBoostChain', () => {
  const stereo = { channels: 2, sampleRate: '48000' }

  it('applies the requested gain as a linear volume multiplier', () => {
    expect(buildBoostChain(50, stereo)).toContain('volume=1.5')
    expect(buildBoostChain(100, stereo)).toContain('volume=2')
    expect(buildBoostChain(0, stereo)).toContain('volume=1')
    expect(buildBoostChain(-25, stereo)).toContain('volume=0.75')
    expect(buildBoostChain(-100, stereo)).toContain('volume=0')
  })

  it('never emits exponential or float-noise numbers', () => {
    // `volume=1.0000000000000002` would still parse, but a filter graph
    // that reads back cleanly is worth the rounding.
    for (const pct of [0.1, 1, 7, 33, 66, 99, 1000, -0.1, -99.9]) {
      const vol = buildBoostChain(pct, stereo).find((f) => f.startsWith('volume='))!
      expect(vol).toMatch(/^volume=-?\d+(\.\d+)?$/)
    }
  })

  it('orders the chain aformat -> highpass -> volume -> alimiter', () => {
    const chain = buildBoostChain(75, stereo, { limiter: true, limiterCeiling: -1, hpfHz: 100 })
    expect(chain).toHaveLength(4)
    expect(chain[0]).toMatch(/^aformat=/)
    expect(chain[1]).toBe('highpass=f=100')
    expect(chain[2]).toBe('volume=1.75')
    expect(chain[3]).toMatch(/^alimiter=/)
  })

  it('places the high-pass before the gain stage', () => {
    // Removing rumble first means it does not consume the headroom the
    // gain stage is about to need.
    const chain = buildBoostChain(30, stereo, { hpfHz: 80 })
    expect(chain.findIndex((f) => f.startsWith('highpass='))).toBeLessThan(
      chain.findIndex((f) => f.startsWith('volume='))
    )
  })

  it('places the limiter after the gain stage', () => {
    const chain = buildBoostChain(200, stereo, { limiter: true })
    expect(chain.findIndex((f) => f.startsWith('alimiter='))).toBeGreaterThan(
      chain.findIndex((f) => f.startsWith('volume='))
    )
  })

  it('omits the high-pass when it is zero, negative, or absent', () => {
    for (const opts of [{}, { hpfHz: 0 }, { hpfHz: -20 }]) {
      expect(buildBoostChain(20, stereo, opts).some((f) => f.startsWith('highpass='))).toBe(false)
    }
  })

  it('omits the limiter unless it is explicitly enabled', () => {
    // Clip risk is surfaced in the UI; the backend does not silently
    // override the user's choice even at extreme gain.
    for (const opts of [{}, { limiter: false }, { limiter: undefined }]) {
      expect(buildBoostChain(500, stereo, opts).some((f) => f.startsWith('alimiter='))).toBe(false)
    }
  })

  it('defaults the limiter ceiling to -1 dBFS', () => {
    const chain = buildBoostChain(50, stereo, { limiter: true })
    expect(chain.find((f) => f.startsWith('alimiter='))).toContain('limit=0.8913')
  })

  it('carries a boosted stream at its own layout, not a folded-down one', () => {
    // A boost must not change the channel count of the stream.
    const chain = buildBoostChain(25, { channels: 6, sampleRate: '48000', channelLayout: '5.1' })
    expect(chain[0]).toBe('aformat=channel_layouts=5.1:sample_rates=48000')
    const chain5 = buildBoostChain(25, { channels: 5, sampleRate: '48000' })
    expect(chain5[0]).not.toContain('stereo')
  })

  it('produces a limiter that actually enforces the advertised ceiling', () => {
    // End-to-end guard on the reported bug: the ceiling must survive into
    // the emitted filter with auto-level off, otherwise a boosted file
    // comes back pinned at 0 dBFS regardless of the requested gain.
    const chain = buildBoostChain(100, stereo, { limiter: true, limiterCeiling: -1 })
    const lim = chain.find((f) => f.startsWith('alimiter='))!
    const opts = parseFilterOptions(lim)
    expect(parseFloat(opts.limit)).toBeCloseTo(dbToLinear(-1), 4)
    expect(opts.level).toBe('disabled')
    expect(opts.latency).toBe('1')
  })
})

/* ------------------------------------------------------------------ */
/*  Compressor                                                         */
/* ------------------------------------------------------------------ */

describe('buildCompressorFilter', () => {
  it('returns null when compression is off or unset', () => {
    for (const level of ['off', undefined, null, '', 'nonsense']) {
      expect(buildCompressorFilter(level as string)).toBeNull()
    }
  })

  it('emits a filter for each supported level', () => {
    for (const level of ['light', 'medium', 'heavy']) {
      expect(buildCompressorFilter(level)).toMatch(/^acompressor=/)
    }
  })

  it('expresses makeup gain in dB, not as a bare linear factor', () => {
    // acompressor's `makeup` is documented as a LINEAR factor, range 1-64.
    // Writing `makeup=3` therefore asks for x3 = +9.54 dB, not +3 dB.
    // Measured against ffmpeg on a below-threshold tone:
    //   makeup=2 -> +6.02 dB, makeup=3 -> +9.54 dB, makeup=5 -> +13.98 dB.
    // FFmpeg's expression evaluator converts an `NdB` suffix via 10^(N/20),
    // so the suffix is both correct and self-documenting.
    for (const [level, db] of Object.entries(COMPRESSOR_MAKEUP_DB)) {
      const opts = parseFilterOptions(buildCompressorFilter(level)!)
      expect(opts.makeup).toBe(`${db}dB`)
    }
  })

  it('keeps every option inside its documented range once converted', () => {
    for (const level of ['light', 'medium', 'heavy']) {
      const o = parseFilterOptions(buildCompressorFilter(level)!)

      // threshold: 0.000976563 - 1 (dB suffix -> 10^(x/20))
      const threshold = dbToLinear(parseFloat(o.threshold))
      expect(threshold).toBeGreaterThanOrEqual(0.000976563)
      expect(threshold).toBeLessThanOrEqual(1)

      // makeup: 1 - 64
      const makeup = dbToLinear(parseFloat(o.makeup))
      expect(makeup).toBeGreaterThanOrEqual(1)
      expect(makeup).toBeLessThanOrEqual(64)

      // ratio: 1 - 20, attack: 0.01 - 2000, release: 0.01 - 9000
      expect(parseFloat(o.ratio)).toBeGreaterThanOrEqual(1)
      expect(parseFloat(o.ratio)).toBeLessThanOrEqual(20)
      expect(parseFloat(o.attack)).toBeGreaterThanOrEqual(0.01)
      expect(parseFloat(o.attack)).toBeLessThanOrEqual(2000)
      expect(parseFloat(o.release)).toBeGreaterThanOrEqual(0.01)
      expect(parseFloat(o.release)).toBeLessThanOrEqual(9000)
    }
  })

  it('escalates ratio and makeup from light to heavy', () => {
    const ratio = (l: string) => parseFloat(parseFilterOptions(buildCompressorFilter(l)!).ratio)
    expect(ratio('light')).toBeLessThan(ratio('medium'))
    expect(ratio('medium')).toBeLessThan(ratio('heavy'))
    expect(COMPRESSOR_MAKEUP_DB.light).toBeLessThan(COMPRESSOR_MAKEUP_DB.medium)
    expect(COMPRESSOR_MAKEUP_DB.medium).toBeLessThan(COMPRESSOR_MAKEUP_DB.heavy)
  })
})

/* ------------------------------------------------------------------ */
/*  Downmix                                                            */
/* ------------------------------------------------------------------ */

describe('buildDownmixFilter', () => {
  it('is a no-op for keep / unset', () => {
    expect(buildDownmixFilter('keep', 6)).toBeNull()
    expect(buildDownmixFilter(undefined, 6)).toBeNull()
  })

  it('is a no-op for sources that are already mono or stereo', () => {
    for (const mode of ['stereo', 'dialog-stereo']) {
      expect(buildDownmixFilter(mode, 1)).toBeNull()
      expect(buildDownmixFilter(mode, 2)).toBeNull()
    }
  })

  it('folds multichannel down to stereo', () => {
    const f = buildDownmixFilter('stereo', 6)!
    expect(f).toContain('pan=stereo|')
    expect(f).toContain('FL<')
    expect(f).toContain('FR<')
  })

  it('favours the centre channel in dialog-stereo on 5.1+ sources', () => {
    const f = buildDownmixFilter('dialog-stereo', 6)!
    expect(f).toContain('FC')
    expect(f).toContain('LFE')
    // Uses the non-renormalising form so the centre lift is preserved.
    expect(f).toContain('FL=')
  })

  it('falls back to the plain fold for multichannel without a discrete centre', () => {
    const f = buildDownmixFilter('dialog-stereo', 4)!
    expect(f).toContain('FL<')
    expect(f).not.toContain('LFE')
  })
})

/* ------------------------------------------------------------------ */
/*  loudnorm                                                           */
/* ------------------------------------------------------------------ */

describe('buildLoudnormFilter', () => {
  it('carries the targets', () => {
    const o = parseFilterOptions(buildLoudnormFilter(spec(), 2))
    expect(o.I).toBe('-16')
    expect(o.TP).toBe('-1.5')
    expect(o.LRA).toBe('11')
  })

  it('supplies every measured_* value plus offset in two-pass mode', () => {
    // The docs: linear mode requires measured_I, measured_LRA, measured_TP
    // and measured_thresh to ALL be specified, or it reverts to dynamic.
    const o = parseFilterOptions(buildLoudnormFilter(spec(), 2, measurement()))
    expect(o.measured_I).toBe('-23.10')
    expect(o.measured_TP).toBe('-5.20')
    expect(o.measured_LRA).toBe('7.30')
    expect(o.measured_thresh).toBe('-33.40')
    expect(o.offset).toBe('-0.15')
  })

  it('omits measured_* in analysis mode', () => {
    const o = parseFilterOptions(buildLoudnormFilter(spec(), 2, undefined, 'json'))
    expect(o.measured_I).toBeUndefined()
    expect(o.print_format).toBe('json')
  })

  it('applies dual_mono only to mono sources and only when asked', () => {
    expect(buildLoudnormFilter(spec({ dualMono: true }), 1)).toContain('dual_mono=true')
    expect(buildLoudnormFilter(spec({ dualMono: true }), 2)).not.toContain('dual_mono')
    expect(buildLoudnormFilter(spec(), 1)).not.toContain('dual_mono')
  })
})

describe('predictsLinearNormalization', () => {
  // Ported from libavfilter/af_loudnorm.c:init():
  //   offset_tp = measured_tp + (target_i - measured_i)
  //   linear iff offset_tp <= target_tp && measured_lra <= target_lra
  //   and none of the "not measured" sentinels are present.

  it('is linear when the gain fits under the ceiling and LRA fits the target', () => {
    // -23.10 -> -16 is +7.10 dB; -5.20 + 7.10 = +1.90 ... above -1.5, so
    // this one must NOT be linear. Use a quieter true peak instead.
    expect(predictsLinearNormalization(spec(), measurement({ input_tp: '-12.00' }))).toBe(true)
  })

  it('is dynamic when the scaled true peak would exceed the target TP', () => {
    expect(predictsLinearNormalization(spec(), measurement({ input_tp: '-5.20' }))).toBe(false)
  })

  it('is dynamic when the source LRA exceeds the target LRA', () => {
    // Very common for film: source LRA of 18 LU against a target of 11.
    expect(
      predictsLinearNormalization(spec(), measurement({ input_tp: '-12.00', input_lra: '18.00' }))
    ).toBe(false)
  })

  it('honours the exact boundary conditions FFmpeg uses', () => {
    // offset_tp == target_tp and measured_lra == target_lra both qualify
    // (the comparisons are <=, not <).
    const m = measurement({ input_i: '-20.00', input_tp: '-5.50', input_lra: '11.00' })
    // -5.50 + (-16 - -20) = -1.50, exactly the target TP.
    expect(predictsLinearNormalization(spec(), m)).toBe(true)
  })

  it('treats FFmpeg\'s "not measured" sentinels as dynamic', () => {
    const base = measurement({ input_tp: '-12.00' })
    expect(predictsLinearNormalization(spec(), { ...base, input_tp: '99' })).toBe(false)
    expect(predictsLinearNormalization(spec(), { ...base, input_thresh: '-70' })).toBe(false)
    expect(predictsLinearNormalization(spec(), { ...base, input_lra: '0' })).toBe(false)
    expect(predictsLinearNormalization(spec(), { ...base, input_i: '0' })).toBe(false)
  })

  it('is dynamic when a measurement is unparseable', () => {
    expect(predictsLinearNormalization(spec(), measurement({ input_i: '-inf' }))).toBe(false)
    expect(predictsLinearNormalization(spec(), measurement({ input_lra: 'n/a' }))).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Normalize chains                                                   */
/* ------------------------------------------------------------------ */

describe('normalization chains', () => {
  const stereo = { channels: 2, sampleRate: '48000' }
  const surround = { channels: 6, sampleRate: '48000' }

  it('analysis and encode share the same pre-loudnorm stages', () => {
    // This is the correctness guarantee behind two-pass normalization: a
    // downmix changes the programme's measured loudness, so measuring the
    // 5.1 source and then normalising a stereo fold-down misses the target
    // by however much the fold shifted it.
    const s = spec({ downmix: 'dialog-stereo' })
    const pre = buildPreLoudnormFilters(s, 6)

    const analysis = buildAnalysisChain(s, surround)
    const encode = buildLoudnormChain(s, surround, measurement())

    expect(analysis.slice(0, pre.length)).toEqual(pre)
    expect(encode.slice(0, pre.length)).toEqual(pre)
    expect(pre.length).toBeGreaterThan(0)
  })

  it('analysis chain ends at loudnorm in JSON mode', () => {
    const chain = buildAnalysisChain(spec(), stereo)
    expect(chain[chain.length - 1]).toMatch(/^loudnorm=/)
    expect(chain[chain.length - 1]).toContain('print_format=json')
  })

  it('analysis chain never carries measured_* values', () => {
    const chain = buildAnalysisChain(spec(), stereo).join(',')
    expect(chain).not.toContain('measured_')
    expect(chain).not.toContain('offset=')
  })

  it('encode chain pins the output sample rate to the source rate', () => {
    // The docs: "In dynamic mode, to accurately detect true peaks, the
    // audio stream will be upsampled to 192 kHz. Use the -ar option or
    // aresample filter to explicitly set an output sample rate."
    // Verified: a 48 kHz source through single-pass loudnorm emerges at
    // 192000 Hz. Without this pin the whole encode ran at 4x the rate.
    for (const rate of ['44100', '48000', '96000']) {
      const chain = buildLoudnormChain(spec(), { channels: 2, sampleRate: rate }, measurement())
      expect(chain[chain.length - 1]).toBe(`aresample=${rate}`)
    }
  })

  it('still pins a rate when the source rate is unknown', () => {
    const chain = buildLoudnormChain(spec(), { channels: 2 }, measurement())
    expect(chain[chain.length - 1]).toBe('aresample')
  })

  it('default encode chain is loudnorm plus the rate pin', () => {
    const chain = buildLoudnormChain(spec(), stereo, measurement())
    expect(chain).toHaveLength(2)
    expect(chain[0]).toMatch(/^loudnorm=/)
    expect(chain[1]).toBe('aresample=48000')
  })

  it('inserts the compressor after loudnorm and closes with a limiter', () => {
    const chain = buildLoudnormChain(spec({ compression: 'medium' }), stereo, measurement())
    const loud = chain.findIndex((f) => f.startsWith('loudnorm='))
    const comp = chain.findIndex((f) => f.startsWith('acompressor='))
    const lim = chain.findIndex((f) => f.startsWith('alimiter='))
    expect(comp).toBeGreaterThan(loud)
    expect(lim).toBeGreaterThan(comp)
    expect(chain[chain.length - 1]).toMatch(/^aresample=/)
  })

  it('sets the post-compressor limiter to the configured TP ceiling', () => {
    const chain = buildLoudnormChain(spec({ TP: -1.5, compression: 'heavy' }), stereo, measurement())
    const lim = parseFilterOptions(chain.find((f) => f.startsWith('alimiter='))!)
    expect(parseFloat(lim.limit)).toBeCloseTo(dbToLinear(-1.5), 4)
    // Auto-level here would have undone the ceiling the whole two-pass
    // workflow exists to hold.
    expect(lim.level).toBe('disabled')
    expect(lim.latency).toBe('1')
  })

  it('adds no limiter when compression is off', () => {
    const chain = buildLoudnormChain(spec({ compression: 'off' }), stereo, measurement())
    expect(chain.some((f) => f.startsWith('alimiter='))).toBe(false)
  })

  it('puts the downmix before loudnorm in both passes', () => {
    const s = spec({ downmix: 'stereo' })
    for (const chain of [buildAnalysisChain(s, surround), buildLoudnormChain(s, surround, measurement())]) {
      const joined = chain.join(',')
      expect(joined.indexOf('pan=')).toBeLessThan(joined.indexOf('loudnorm='))
    }
  })

  it('skips the downmix on stereo sources in both passes', () => {
    const s = spec({ downmix: 'stereo' })
    for (const chain of [buildAnalysisChain(s, stereo), buildLoudnormChain(s, stereo, measurement())]) {
      expect(chain.some((f) => f.startsWith('pan='))).toBe(false)
    }
  })
})
