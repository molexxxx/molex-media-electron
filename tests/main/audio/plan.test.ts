/**
 * Gain plans (D5, D7, D12). Every row of the normalize decision table at its boundaries (Z = 0, 0.005, N,
 * N + 0.01, and a negative gain that still needs limiting), the short-form cap of EBU R 128 s1 and AES TD1004,
 * boost reduction, album gains anchored on the loudest member with the corpus numbers, Spotify's lower maximum
 * above -14.0 LUFS, the tolerance table, and a sweep over validated recipes showing the planners are total.
 * Plans take no loudness range input: a range never forces a mode (D7).
 */
import { describe, it, expect } from 'vitest'
import {
  APP_TOLERANCE_LU, LINEAR_EPSILON_DB, SHORT_TERM_FLOOR_LUFS, planAlbum, planBoost, planNormalize, shortFormApplies, toleranceLu
} from '../../../src/main/ffmpeg/audio/plan'
import type { AlbumMember, NormalizePlanRecipe } from '../../../src/main/ffmpeg/audio/plan'
import { resolveCeiling } from '../../../src/main/ffmpeg/audio/ceilings'
import { applyGainPreset, applyLoudnessPreset, findLoudnessPreset } from '../../../src/shared/audio/presets'
import { validateAudioRecipe } from '../../../src/shared/audio/limits'
import type {
  Ceiling, GainPlan, LoudnessStats, LoudnessTarget, NormalizeRecipe, OutputClass, PresetId, UnreachablePolicy
} from '../../../src/shared/audio/types'

const SAME = { kind: 'same-as-source' } as const
const FLAC = resolveCeiling('flac', null, -1)

function stats(over: Partial<LoudnessStats> = {}): LoudnessStats
{
  return {
    status: 'measured',
    integratedLufs: -20,
    thresholdLufs: -30,
    loudnessRangeLu: null,
    lraStatus: 'not-applicable',
    maxShortTermLufs: null,
    truePeakDbtp: -10,
    dialogueLufs: null,
    dualMono: false,
    channelWeights: 'bs1770-annex1',
    ...over
  }
}

function target(over: Partial<LoudnessTarget> = {}): LoudnessTarget
{
  return { integratedLufs: -16, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: null, unit: 'LUFS', ...over }
}

function recipe(over: Partial<NormalizePlanRecipe> = {}): NormalizePlanRecipe
{
  return { target: target(), policy: 'peak-limit', maxLimitingDb: 1, shortForm: null, ...over }
}

function preset(id: PresetId): NormalizeRecipe
{
  return applyLoudnessPreset(id, SAME)
}

function member(jobId: string, integratedLufs: number, truePeakDbtp: number, over: Partial<LoudnessStats> = {}): AlbumMember
{
  return { jobId, stats: stats({ integratedLufs, truePeakDbtp, ...over }), ceiling: FLAC, audioIndex: 0 }
}

function planOf(album: ReturnType<typeof planAlbum>, jobId: string): GainPlan
{
  return (album.plans.find((entry) => entry.jobId === jobId) as { plan: GainPlan }).plan
}

describe('planNormalize: the decision table at T -16, I -20 (G = +4), L -1.5', () =>
{
  const rows: ReadonlyArray<readonly [string, UnreachablePolicy, number, number, Partial<GainPlan>]> =
  [
    ['Z = 0', 'peak-limit', 1, -5.5, { mode: 'linear', reason: 'fits', gainDb: 4, limitingDb: 0, predictedLufs: -16, headroomDb: 4, predictedTruePeakDbtp: -1.5 }],
    ['Z = 0.005', 'peak-limit', 1, -5.495, { mode: 'linear', reason: 'fits', gainDb: 4, limitingDb: 0, predictedLufs: -16, headroomDb: 3.995 }],
    ['Z = 0.01', 'peak-limit', 1, -5.49, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 4, limitingDb: 0.01, predictedLufs: -16 }],
    ['Z = N', 'peak-limit', 1, -4.5, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 4, limitingDb: 1, predictedLufs: -16, predictedTruePeakDbtp: -0.5 }],
    ['Z = N + 0.01', 'peak-limit', 1, -4.49, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 3.99, limitingDb: 1, predictedLufs: -16.01 }],
    ['Z = 5.5', 'peak-limit', 1, 0, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: -0.5, limitingDb: 1, predictedLufs: -20.5, predictedTruePeakDbtp: -0.5 }],
    ['N = 3, Z = N', 'peak-limit', 3, -2.5, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 4, limitingDb: 3, predictedLufs: -16 }],
    ['N = 3, Z = N + 0.01', 'peak-limit', 3, -2.49, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 3.99, limitingDb: 3, predictedLufs: -16.01 }],
    ['N = 0, Z = 0.005', 'peak-limit', 0, -5.495, { mode: 'linear', reason: 'fits', gainDb: 4, limitingDb: 0 }],
    ['N = 0, Z = 0.01', 'peak-limit', 0, -5.49, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 3.99, limitingDb: 0, predictedLufs: -16.01 }],
    ['stop, Z = 0', 'stop-at-reachable', 1, -5.5, { mode: 'linear', reason: 'fits', gainDb: 4, limitingDb: 0, predictedLufs: -16 }],
    ['stop, Z = 0.005', 'stop-at-reachable', 1, -5.495, { mode: 'linear', reason: 'fits', gainDb: 4, limitingDb: 0, predictedLufs: -16 }],
    ['stop, Z = 0.01', 'stop-at-reachable', 1, -5.49, { mode: 'reachable-linear', reason: 'headroom-capped', gainDb: 3.99, limitingDb: 0, predictedLufs: -16.01, predictedTruePeakDbtp: -1.5 }],
    ['stop, Z = N + 0.01', 'stop-at-reachable', 1, -4.49, { mode: 'reachable-linear', reason: 'headroom-capped', gainDb: 2.99, limitingDb: 0, predictedLufs: -17.01, predictedTruePeakDbtp: -1.5 }],
    ['reduce dynamics, Z = N', 'reduce-dynamics', 1, -4.5, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 4, limitingDb: 1, predictedLufs: -16 }],
    ['reduce dynamics, Z = N + 0.01', 'reduce-dynamics', 1, -4.49, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 3.99, limitingDb: 1, predictedLufs: -16.01 }]
  ]

  it.each(rows)('%s (%s, N %d, P %d)', (_name, policy, maxLimitingDb, truePeakDbtp, expected) =>
  {
    const plan = planNormalize(stats({ truePeakDbtp }), recipe({ policy, maxLimitingDb }), FLAC, 3)
    expect(plan).toMatchObject({ audioIndex: 3, targetLufs: -16, requestedGainDb: 4, maxLimitingDb, ceiling: FLAC, ...expected })
    expect(plan.shortTermLimitLufs).toBeNull()
    expect(plan.predictedMaxShortTermLufs).toBeNull()
  })

  it('counts at most 0.005 dB of planned limiting as linear', () =>
  {
    expect(LINEAR_EPSILON_DB).toBe(0.005)
  })

  const negative: ReadonlyArray<readonly [UnreachablePolicy, number, Partial<GainPlan>]> =
  [
    ['peak-limit', 1, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: -1, limitingDb: 1, predictedLufs: -16, predictedTruePeakDbtp: -0.5 }],
    ['peak-limit', 0.5, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: -1.5, limitingDb: 0.5, predictedLufs: -16.5 }],
    ['stop-at-reachable', 1, { mode: 'reachable-linear', reason: 'headroom-capped', gainDb: -2, limitingDb: 0, predictedLufs: -17, predictedTruePeakDbtp: -1.5 }]
  ]

  it.each(negative)('an attenuation of a clipped master still needs limiting: %s, N %d', (policy, maxLimitingDb, expected) =>
  {
    const plan = planNormalize(stats({ integratedLufs: -15, truePeakDbtp: 0.5 }), recipe({ policy, maxLimitingDb }), FLAC, 0)
    expect(plan).toMatchObject({ requestedGainDb: -1, headroomDb: -2, ...expected })
  })

  it('plans against the codec ceiling, not only the preset maximum', () =>
  {
    const aac = resolveCeiling('aac', 256, -1)
    expect(aac.limiterCeilingDbtp).toBe(-2.5)
    expect(planNormalize(stats({ truePeakDbtp: -6.5 }), recipe(), aac, 0)).toMatchObject({ mode: 'linear', headroomDb: 4 })
    expect(planNormalize(stats({ truePeakDbtp: -6 }), recipe(), aac, 0)).toMatchObject({ mode: 'peak-limited', limitingDb: 0.5 })
  })

  it('rounds a gain down to the 0.01 dB grid, so a plan never lands above its target', () =>
  {
    const plan = planNormalize(stats({ integratedLufs: -13.993, truePeakDbtp: -20 }), recipe(), FLAC, 0)
    expect(plan).toMatchObject({ mode: 'linear', gainDb: -2.01, requestedGainDb: -2.01, predictedLufs: -16.003 })
  })
})

describe('planNormalize: passthrough', () =>
{
  it.each([
    ['silent', stats({ status: 'silent', integratedLufs: null, truePeakDbtp: null }), 'silent', null],
    ['too short', stats({ status: 'too-short', integratedLufs: null, truePeakDbtp: -10 }), 'too-short', 8.5],
    ['below the floor', stats({ status: 'below-floor', integratedLufs: -75, truePeakDbtp: -40 }), 'below-floor', 38.5],
    ['measured without a loudness', stats({ integratedLufs: null, truePeakDbtp: -10 }), 'below-floor', 8.5],
    ['measured without a peak', stats({ truePeakDbtp: null }), 'silent', null]
  ] as const)('%s passes through with its status as the reason', (_name, measured, reason, headroomDb) =>
  {
    expect(planNormalize(measured, recipe(), FLAC, 2)).toEqual({
      audioIndex: 2,
      mode: 'passthrough',
      reason,
      targetLufs: -16,
      requestedGainDb: 0,
      gainDb: 0,
      headroomDb,
      limitingDb: 0,
      maxLimitingDb: 1,
      predictedLufs: null,
      predictedTruePeakDbtp: null,
      shortTermLimitLufs: null,
      predictedMaxShortTermLufs: null,
      ceiling: FLAC
    })
  })
})

describe('planNormalize: the short-form rule', () =>
{
  const r128 = preset('ebu-r128')
  const corpus = (over: Partial<LoudnessStats> = {}): LoudnessStats =>
    stats({ integratedLufs: -36.2, maxShortTermLufs: -30.646, truePeakDbtp: -20, ...over })

  it('caps the measured 30 s clip at T + 5 LU: +12.64 dB instead of +13.20, reachable -23.56', () =>
  {
    expect(r128.shortForm).toEqual({ rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'auto' })
    expect(planNormalize(corpus(), r128, FLAC, 0, 30)).toMatchObject({
      mode: 'reachable-linear',
      reason: 'short-term-capped',
      targetLufs: -23,
      requestedGainDb: 13.2,
      gainDb: 12.64,
      limitingDb: 0,
      headroomDb: 18.5,
      predictedLufs: -23.56,
      shortTermLimitLufs: -18,
      predictedMaxShortTermLufs: -18.006
    })
  })

  it('without the rule the same clip plans the full +13.20 dB', () =>
  {
    expect(planNormalize(corpus(), { ...r128, shortForm: { ...(r128.shortForm as NonNullable<NormalizeRecipe['shortForm']>), mode: 'off' } }, FLAC, 0, 30))
      .toMatchObject({ mode: 'linear', reason: 'fits', gainDb: 13.2, predictedLufs: -23, shortTermLimitLufs: null, predictedMaxShortTermLufs: null })
  })

  it('records the limit but does not cap when the short-term term is not the smaller one', () =>
  {
    expect(planNormalize(corpus({ maxShortTermLufs: -40 }), r128, FLAC, 0, 30))
      .toMatchObject({ mode: 'linear', reason: 'fits', gainDb: 13.2, shortTermLimitLufs: -18, predictedMaxShortTermLufs: -26.8 })
  })

  it('does not cap when the short-term term is smaller by 0.005 dB or less', () =>
  {
    expect(planNormalize(corpus({ maxShortTermLufs: -31.196 }), r128, FLAC, 0, 30))
      .toMatchObject({ mode: 'linear', reason: 'fits', gainDb: 13.2, predictedMaxShortTermLufs: -17.996 })
  })

  it('caps when the short-term term is smaller by more than 0.005 dB', () =>
  {
    expect(planNormalize(corpus({ maxShortTermLufs: -31.194 }), r128, FLAC, 0, 30))
      .toMatchObject({ mode: 'reachable-linear', reason: 'short-term-capped', gainDb: 13.19, predictedLufs: -23.01 })
  })

  it('lets the headroom cap win when it is lower than the short-term cap', () =>
  {
    expect(planNormalize(corpus({ truePeakDbtp: -6 }), r128, FLAC, 0, 30)).toMatchObject({
      mode: 'reachable-linear', reason: 'headroom-capped', gainDb: 4.5, predictedLufs: -31.7, shortTermLimitLufs: -18, predictedMaxShortTermLufs: -26.146
    })
    const limited = { ...r128, policy: 'peak-limit' as const }
    expect(planNormalize(corpus({ truePeakDbtp: -14 }), limited, FLAC, 0, 30)).toMatchObject({
      mode: 'reachable-limited', reason: 'short-term-capped', gainDb: 12.64, limitingDb: 0.14, predictedLufs: -23.56
    })
    expect(planNormalize(corpus({ truePeakDbtp: -12 }), limited, FLAC, 0, 30)).toMatchObject({
      mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 11.5, limitingDb: 1, predictedLufs: -24.7
    })
  })

  it('applies automatically at 120 s and not above for EBU R 128', () =>
  {
    expect(planNormalize(corpus(), r128, FLAC, 0, 120)).toMatchObject({ gainDb: 12.64, reason: 'short-term-capped' })
    expect(planNormalize(corpus(), r128, FLAC, 0, 120.5)).toMatchObject({ gainDb: 13.2, reason: 'fits', shortTermLimitLufs: null })
  })

  it('applies automatically at 60 s and not above for AES TD1004', () =>
  {
    const aes = preset('aes-streaming')
    expect(aes.shortForm?.rule.autoMaxDurationSec).toBe(60)
    const clip = stats({ integratedLufs: -30, maxShortTermLufs: -20, truePeakDbtp: -30 })
    expect(planNormalize(clip, aes, FLAC, 0, 60)).toMatchObject({ gainDb: 7, predictedLufs: -23, shortTermLimitLufs: -13, reason: 'short-term-capped' })
    expect(planNormalize(clip, aes, FLAC, 0, 61)).toMatchObject({ gainDb: 12, predictedLufs: -18, shortTermLimitLufs: null, reason: 'fits' })
  })

  it('applies at any duration when on, never when off, and trusts the measurement when no duration is given', () =>
  {
    const rule = (r128.shortForm as NonNullable<NormalizeRecipe['shortForm']>).rule
    expect(planNormalize(corpus(), { ...r128, shortForm: { rule, mode: 'on' } }, FLAC, 0, 600).gainDb).toBe(12.64)
    expect(planNormalize(corpus(), { ...r128, shortForm: { rule, mode: 'off' } }, FLAC, 0, 30).gainDb).toBe(13.2)
    expect(planNormalize(corpus(), r128, FLAC, 0).gainDb).toBe(12.64)
  })

  it.each([
    ['the -120.691 placeholder of a clip under 3 s', -120.691],
    ['exactly the floor', SHORT_TERM_FLOOR_LUFS],
    ['no short-term value', null]
  ])('does not apply without a short-term value: %s', (_name, maxShortTermLufs) =>
  {
    expect(planNormalize(corpus({ maxShortTermLufs }), r128, FLAC, 0, 1.5))
      .toMatchObject({ gainDb: 13.2, reason: 'fits', shortTermLimitLufs: null, predictedMaxShortTermLufs: null })
  })

  it('needs no short-form rule at all', () =>
  {
    const { shortForm: _none, ...withoutRule } = recipe()
    expect(planNormalize(corpus(), { ...withoutRule, target: target({ integratedLufs: -23 }) }, FLAC, 0, 30)).toMatchObject({ gainDb: 13.2 })
  })

  it.each([
    [null, 10, false],
    [undefined, 10, false],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'off' }, 10, false],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'on' }, 3600, true],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'auto' }, 120, true],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'auto' }, 120.01, false],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0, autoMaxDurationSec: 60 }, mode: 'auto' }, 60, true],
    [{ rule: { maxAboveTargetLu: 5, toleranceLu: 0, autoMaxDurationSec: 60 }, mode: 'auto' }, 61, false]
  ] as const)('shortFormApplies(%j, %d) is %s', (shortForm, durationSec, applies) =>
  {
    expect(shortFormApplies(shortForm as NormalizeRecipe['shortForm'], durationSec)).toBe(applies)
  })
})

describe('planNormalize: a lower maximum for louder outputs', () =>
{
  const spotify = preset('spotify')

  it('keeps Spotify\'s -1.0 dBTP for a plan at -14.0 LUFS', () =>
  {
    const plan = planNormalize(stats({ truePeakDbtp: -10 }), spotify, FLAC, 0)
    expect(plan).toMatchObject({ mode: 'linear', predictedLufs: -14, headroomDb: 8.5 })
    expect(plan.ceiling).toBe(FLAC)
  })

  it('plans against -2.0 dBTP for a target above -14.0 LUFS', () =>
  {
    const louder = { ...spotify, target: { ...spotify.target, integratedLufs: -12 } }
    const plan = planNormalize(stats({ truePeakDbtp: -11 }), louder, FLAC, 0)
    expect(plan.ceiling).toMatchObject({ presetMaxDbtp: -2, ceilingDbtp: -2, limiterCeilingDbtp: -2.5, gateDbtp: -2, decodedLimitDbtp: -2 })
    expect(plan).toMatchObject({ mode: 'linear', predictedLufs: -12, headroomDb: 8.5 })
    expect(planNormalize(stats({ truePeakDbtp: -10 }), louder, FLAC, 0)).toMatchObject({ mode: 'peak-limited', limitingDb: 0.5, headroomDb: 7.5 })
  })

  it('keeps a lower codec ceiling and judges a lossy output against the louder maximum', () =>
  {
    const aac = resolveCeiling('aac', 128, -1)
    const louder = { ...spotify, target: { ...spotify.target, integratedLufs: -12 } }
    expect(planNormalize(stats({ truePeakDbtp: -10 }), louder, aac, 0).ceiling)
      .toMatchObject({ presetMaxDbtp: -2, codecCeilingDbtp: -3, ceilingDbtp: -3, limiterCeilingDbtp: -3.5, gateDbtp: -2, decodedLimitDbtp: -2 })
  })

  it('keeps the base maximum when the reachable level stays at or below the threshold', () =>
  {
    const louder = { ...spotify, target: { ...spotify.target, integratedLufs: -12 } }
    const plan = planNormalize(stats({ truePeakDbtp: -2 }), louder, FLAC, 0)
    expect(plan).toMatchObject({ mode: 'reachable-limited', gainDb: 1.5, predictedLufs: -18.5 })
    expect(plan.ceiling).toBe(FLAC)
  })
})

describe('planBoost', () =>
{
  const boost = (gainDb: number, maxLimitingDb = 3): { gainDb: number; maxLimitingDb: number } => ({ gainDb, maxLimitingDb })

  it('reduces +6 dB to +5.5 when the peaks need 3.5 dB of limiting against an allowance of 3', () =>
  {
    expect(planBoost(stats({ integratedLufs: -14, truePeakDbtp: -4 }), boost(6), FLAC, 1)).toMatchObject({
      audioIndex: 1, mode: 'reachable-limited', reason: 'limiting-capped', requestedGainDb: 6, gainDb: 5.5, limitingDb: 3,
      headroomDb: 2.5, targetLufs: -8, predictedLufs: -8.5, predictedTruePeakDbtp: 1.5, maxLimitingDb: 3
    })
  })

  it.each([
    ['Z = 0', 2.5, -4, { mode: 'linear', reason: 'fits', gainDb: 2.5, limitingDb: 0 }],
    ['Z = 0.005', 2.5, -3.995, { mode: 'linear', reason: 'fits', gainDb: 2.5, limitingDb: 0 }],
    ['Z = 0.5', 3, -4, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 3, limitingDb: 0.5 }],
    ['Z = N', 5.5, -4, { mode: 'peak-limited', reason: 'needs-limiting', gainDb: 5.5, limitingDb: 3 }],
    ['Z = N + 0.01', 5.51, -4, { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 5.5, limitingDb: 3 }],
    ['a cut', -2.5, -1, { mode: 'linear', reason: 'fits', gainDb: -2.5, limitingDb: 0 }]
  ] as const)('%s', (_name, gainDb, truePeakDbtp, expected) =>
  {
    expect(planBoost(stats({ integratedLufs: -14, truePeakDbtp }), boost(gainDb), FLAC, 0)).toMatchObject({ requestedGainDb: gainDb, ...expected })
  })

  it('caps at the headroom with no allowance', () =>
  {
    expect(planBoost(stats({ truePeakDbtp: -4 }), boost(3, 0), FLAC, 0)).toMatchObject({ mode: 'reachable-limited', gainDb: 2.5, limitingDb: 0 })
  })

  it('still boosts a stream too short or too quiet to measure, since the plan needs only its peak', () =>
  {
    expect(planBoost(stats({ status: 'too-short', integratedLufs: null, truePeakDbtp: -10 }), boost(6), FLAC, 0))
      .toMatchObject({ mode: 'linear', gainDb: 6, targetLufs: null, predictedLufs: null, predictedTruePeakDbtp: -4 })
    expect(planBoost(stats({ status: 'below-floor', integratedLufs: -75, truePeakDbtp: -50 }), boost(12), FLAC, 0))
      .toMatchObject({ mode: 'linear', gainDb: 12, targetLufs: null, predictedLufs: null })
  })

  it('passes digital silence through', () =>
  {
    for (const silent of [stats({ status: 'silent', integratedLufs: null, truePeakDbtp: null }), stats({ status: 'too-short', truePeakDbtp: null })])
    {
      expect(planBoost(silent, boost(6), FLAC, 0)).toMatchObject({
        mode: 'passthrough', reason: 'silent', requestedGainDb: 6, gainDb: 0, limitingDb: 0, headroomDb: null, targetLufs: null,
        predictedLufs: null, predictedTruePeakDbtp: null
      })
    }
  })

  it('plans the gain presets with their own allowance', () =>
  {
    const louder = applyGainPreset('louder', SAME)
    expect(planBoost(stats({ truePeakDbtp: -4 }), louder, FLAC, 0)).toMatchObject({ requestedGainDb: 6, gainDb: 5.5, limitingDb: 3 })
  })
})

describe('planAlbum', () =>
{
  const music = (jobId: string): AlbumMember => member(jobId, -13.993, -1.2)
  const corpus = [music('m1'), music('m2'), music('m3'), member('loud', -7.851, 0.3)]

  it('anchors AES -18 on the loudest track: -10.15 dB, the loud track at the target, the others at -24.14', () =>
  {
    const album = planAlbum(corpus, preset('aes-streaming'))
    expect(album).toMatchObject({ anchorJobId: 'loud', anchorLufs: -7.851, gainDb: -10.15, reason: 'fits' })
    expect(planOf(album, 'loud')).toMatchObject({ mode: 'linear', gainDb: -10.15, predictedLufs: -18.001, targetLufs: -18.001, requestedGainDb: -10.15 })
    for (const id of ['m1', 'm2', 'm3'])
    {
      expect(planOf(album, id).predictedLufs).toBeCloseTo(-24.14, 2)
      expect(planOf(album, id).gainDb).toBe(-10.15)
    }
    expect(album.plans.map((entry) => entry.jobId)).toEqual(['m1', 'm2', 'm3', 'loud'])
  })

  it('anchors Spotify -14 the same way: -6.15 dB, the others at -20.14', () =>
  {
    const album = planAlbum(corpus, preset('spotify'))
    expect(album).toMatchObject({ anchorJobId: 'loud', gainDb: -6.15, reason: 'fits' })
    expect(planOf(album, 'loud').predictedLufs).toBe(-14.001)
    expect(planOf(album, 'm2').predictedLufs).toBeCloseTo(-20.14, 2)
    expect(planOf(album, 'loud').ceiling).toBe(FLAC)
  })

  const pair = [member('a', -20, -6), member('b', -18, -1)]

  it('gives every track the lowest reachable gain when one track is over its allowance, keeping relative levels', () =>
  {
    const album = planAlbum(pair, recipe())
    expect(album).toMatchObject({ anchorJobId: 'b', anchorLufs: -18, gainDb: 0.5, reason: 'limiting-capped' })
    expect(planOf(album, 'a')).toMatchObject({ mode: 'reachable-linear', reason: 'limiting-capped', gainDb: 0.5, limitingDb: 0, predictedLufs: -19.5, targetLufs: -18, requestedGainDb: 2 })
    expect(planOf(album, 'b')).toMatchObject({ mode: 'reachable-limited', reason: 'limiting-capped', gainDb: 0.5, limitingDb: 1, predictedLufs: -17.5, targetLufs: -16 })
  })

  it('stops at the lowest headroom with stop-at-reachable', () =>
  {
    const album = planAlbum(pair, recipe({ policy: 'stop-at-reachable' }))
    expect(album).toMatchObject({ gainDb: -0.5, reason: 'headroom-capped' })
    expect(planOf(album, 'a')).toMatchObject({ mode: 'reachable-linear', reason: 'headroom-capped', predictedLufs: -20.5, limitingDb: 0 })
    expect(planOf(album, 'b')).toMatchObject({ mode: 'reachable-linear', reason: 'headroom-capped', predictedLufs: -18.5, limitingDb: 0 })
  })

  it('limits the tracks that need it when every track stays within the allowance', () =>
  {
    const album = planAlbum(pair, recipe({ maxLimitingDb: 3 }))
    expect(album).toMatchObject({ gainDb: 2, reason: 'needs-limiting' })
    expect(planOf(album, 'a')).toMatchObject({ mode: 'linear', reason: 'fits', predictedLufs: -18 })
    expect(planOf(album, 'b')).toMatchObject({ mode: 'peak-limited', reason: 'needs-limiting', limitingDb: 2.5, predictedLufs: -16 })
  })

  it('anchors on the first of two equally loud tracks', () =>
  {
    const x = member('x', -14, -10)
    const y = member('y', -14, -3)
    expect(planAlbum([x, y], recipe()).anchorJobId).toBe('x')
    expect(planAlbum([y, x], recipe()).anchorJobId).toBe('y')
  })

  it('passes a member that is not measured through and leaves it out of the anchor', () =>
  {
    const silent: AlbumMember = { jobId: 's', stats: stats({ status: 'silent', integratedLufs: null, truePeakDbtp: null }), ceiling: FLAC, audioIndex: 1 }
    const album = planAlbum([pair[0], silent, pair[1]], recipe())
    expect(album.plans.map((entry) => entry.jobId)).toEqual(['a', 's', 'b'])
    expect(planOf(album, 's')).toMatchObject({ mode: 'passthrough', reason: 'silent', gainDb: 0, audioIndex: 1 })
    expect(album).toMatchObject({ anchorJobId: 'b', gainDb: 0.5 })
  })

  it('stands the first member in as the anchor when no member is measured', () =>
  {
    const none = [
      { jobId: 's1', stats: stats({ status: 'silent', integratedLufs: null, truePeakDbtp: null }), ceiling: FLAC, audioIndex: 0 },
      { jobId: 's2', stats: stats({ status: 'too-short', integratedLufs: null, truePeakDbtp: -30 }), ceiling: FLAC, audioIndex: 0 }
    ]
    const album = planAlbum(none, recipe())
    expect(album).toMatchObject({ anchorJobId: 's1', anchorLufs: -16, gainDb: 0, reason: 'silent' })
    expect(album.plans.map((entry) => entry.plan.reason)).toEqual(['silent', 'too-short'])
    expect(planAlbum([], recipe())).toEqual({ anchorJobId: '', anchorLufs: -16, gainDb: 0, reason: 'silent', plans: [] })
  })

  it('never plans a member louder than the target', () =>
  {
    const levels = [-30, -25.55, -19.994, -16.001, -15.996, -9.5]
    for (const count of [5, 6])
    {
      for (const policy of ['peak-limit', 'stop-at-reachable', 'reduce-dynamics'] as const)
      {
        const album = planAlbum(levels.slice(0, count).map((level, index) => member(`t${index}`, level, level + 12)), recipe({ policy }))
        for (const entry of album.plans)
        {
          expect(entry.plan.predictedLufs as number).toBeLessThanOrEqual(-16)
        }
      }
    }
  })

  it('never uses the short-form rule for a member', () =>
  {
    const withRule = { ...preset('ebu-r128'), shortForm: { rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'on' as const } }
    const album = planAlbum([member('a', -36.2, -20, { maxShortTermLufs: -30.646 })], withRule)
    expect(planOf(album, 'a')).toMatchObject({ gainDb: 13.2, shortTermLimitLufs: null, predictedMaxShortTermLufs: null })
  })

  it('plans a member above a lower-maximum threshold against that maximum', () =>
  {
    const louder = recipe({ target: target({ integratedLufs: -12, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 } }) })
    const album = planAlbum([member('c', -15, -10), member('d', -20, -10)], louder)
    expect(album).toMatchObject({ anchorJobId: 'c', gainDb: 3, reason: 'fits' })
    expect(planOf(album, 'c').ceiling).toMatchObject({ presetMaxDbtp: -2, limiterCeilingDbtp: -2.5 })
    expect(planOf(album, 'c').headroomDb).toBe(7.5)
    expect(planOf(album, 'd').ceiling).toBe(FLAC)
  })

  it('recomputes the album gain when the lower maximum leaves less headroom', () =>
  {
    const louder = recipe({ target: target({ integratedLufs: -12, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 } }), maxLimitingDb: 0 })
    const album = planAlbum([member('c', -15, -4.4)], louder)
    expect(album).toMatchObject({ gainDb: 1.9, reason: 'limiting-capped' })
    expect(planOf(album, 'c')).toMatchObject({ predictedLufs: -13.1, predictedTruePeakDbtp: -2.5 })
  })
})

describe('toleranceLu', () =>
{
  const classes: readonly OutputClass[] = ['lossless', 'broadcast-lossy', 'lossy-high', 'lossy-low']

  it('is the app\'s check without a standard: 0.5 LU lossless, 1.0 LU lossy', () =>
  {
    expect(APP_TOLERANCE_LU).toEqual({ lossless: 0.5, lossy: 1 })
    expect(classes.map((cls) => toleranceLu(null, cls))).toEqual([0.5, 1, 1, 1])
  })

  it.each([
    ['ebu-r128', [0.2, 0.2, 0.2, 0.2]],
    ['film-r128s4', [0.2, 0.2, 0.2, 0.2]],
    ['atsc-a85', [0.5, 1, 1, 1]],
    ['apple-podcasts', [0.5, 1, 1, 1]],
    ['spotify', [0.5, 1, 1, 1]],
    ['streaming-r128s2', [0.5, 1, 1, 1]],
    ['aes-streaming', [0.5, 0.5, 0.5, 0.5]],
    ['night', [0.5, 1, 1, 1]],
    ['custom', [0.5, 1, 1, 1]]
  ] as const)('%s tightens the app check where the standard states less', (id, expected) =>
  {
    const presetTarget = (findLoudnessPreset(id) as { target: LoudnessTarget }).target
    expect(classes.map((cls) => toleranceLu(presetTarget, cls))).toEqual(expected)
  })
})

describe('validated input', () =>
{
  it('plans every validated normalize recipe without throwing, under the target and within the allowance', () =>
  {
    let checked = 0
    for (const integratedLufs of [-60, -23, -5])
    {
      for (const maxTruePeakDbtp of [-9, -1, 0])
      {
        for (const policy of ['peak-limit', 'stop-at-reachable', 'reduce-dynamics'] as const)
        {
          for (const maxLimitingDb of [0, 1.5, 3])
          {
            const full = { ...preset('custom'), target: target({ integratedLufs, maxTruePeakDbtp }), policy, maxLimitingDb }
            if (policy === 'reduce-dynamics')
            {
              full.dynamics = { thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 300 }
            }
            expect(validateAudioRecipe(full)).toEqual([])
            for (const ceiling of [resolveCeiling('flac', null, maxTruePeakDbtp), resolveCeiling('aac', 96, maxTruePeakDbtp)])
            {
              for (const measured of [-70, -40, -10, 0])
              {
                for (const peak of [-60, -10, 0, 3])
                {
                  const plan = planNormalize(stats({ integratedLufs: measured, truePeakDbtp: peak }), full, ceiling, 0)
                  const limiter = plan.ceiling.limiterCeilingDbtp
                  expect(Number.isFinite(plan.gainDb)).toBe(true)
                  expect(plan.predictedLufs as number).toBeLessThanOrEqual(integratedLufs)
                  expect(plan.limitingDb).toBeGreaterThanOrEqual(0)
                  expect(plan.limitingDb).toBeLessThanOrEqual(maxLimitingDb + LINEAR_EPSILON_DB)
                  expect((plan.predictedTruePeakDbtp as number) - plan.limitingDb).toBeLessThanOrEqual(limiter + LINEAR_EPSILON_DB)
                  checked++
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2592)
  })

  it('plans every validated gain recipe without throwing and within the allowance', () =>
  {
    for (const gainDb of [-20, 0, 6, 12])
    {
      for (const maxLimitingDb of [0, 3, 6])
      {
        for (const maxTruePeakDbtp of [-9, -1])
        {
          const full = { ...applyGainPreset('gentle-lift', SAME), gainDb, maxLimitingDb, maxTruePeakDbtp }
          expect(validateAudioRecipe(full)).toEqual([])
          for (const peak of [-60, -10, 0, 3])
          {
            const ceiling = resolveCeiling('flac', null, maxTruePeakDbtp)
            const plan = planBoost(stats({ truePeakDbtp: peak }), full, ceiling, 0)
            expect(plan.gainDb).toBeLessThanOrEqual(gainDb)
            expect(plan.limitingDb).toBeLessThanOrEqual(maxLimitingDb)
            expect((plan.predictedTruePeakDbtp as number) - plan.limitingDb).toBeLessThanOrEqual(ceiling.limiterCeilingDbtp + LINEAR_EPSILON_DB)
          }
        }
      }
    }
  })
})
