/**
 * Gain plans in dB from one measurement per stream: a linear gain when the peaks allow it, else peak limiting
 * within the allowance N or the reachable level the policy names. Gains sit on the 0.01 dB grid the chains write:
 * normalize and cap gains round down, so no plan lands above its target or past a cap, and a boost keeps the
 * requested gain to the nearest step. The planners are total over validated input and never throw.
 */
import { LIMITER_MARGIN_DB, presetMaxFor } from './ceilings'
import type {
  BoostRecipe, Ceiling, GainMode, GainPlan, LoudnessStats, LoudnessTarget, NormalizeRecipe, OutputClass, PlanReason,
  UnreachablePolicy
} from '../../../shared/audio/types'

export type { GainPlan, PlanReason }

/** Planned limiting at or under this counts as none, so the plan stays linear. */
export const LINEAR_EPSILON_DB = 0.005

/** Short-term values at or below this are FFmpeg's placeholder before the first full 3 s window. */
export const SHORT_TERM_FLOOR_LUFS = -120

/** The app's own check per output class, in LU. */
export const APP_TOLERANCE_LU = { lossless: 0.5, lossy: 1 } as const

/** A normalize recipe as the planner reads it; the short-form rule is optional and album members never use it. */
export type NormalizePlanRecipe = Pick<NormalizeRecipe, 'target' | 'policy' | 'maxLimitingDb'> & Partial<Pick<NormalizeRecipe, 'shortForm'>>

/** A boost recipe as the planner reads it. */
export type BoostPlanRecipe = Pick<BoostRecipe, 'gainDb' | 'maxLimitingDb'>

/** One album member: its pass A measurement and the ceiling of its output stream. */
export interface AlbumMember
{
  jobId: string
  stats: LoudnessStats
  ceiling: Ceiling
  audioIndex: number
}

/** One gain for the whole album, anchored on the loudest member, and the plan of every member in input order. */
export interface AlbumPlan
{
  anchorJobId: string
  anchorLufs: number
  gainDb: number
  reason: PlanReason
  plans: Array<{ jobId: string; plan: GainPlan }>
}

interface Decision
{
  mode: GainMode
  reason: PlanReason
  gainDb: number
  limitingDb: number
}

interface Measured
{
  index: number
  member: AlbumMember
  integrated: number
  peak: number
  ceiling: Ceiling
}

/** True when a short-form rule is on, or automatic and the item lasts at most its automatic duration. */
export function shortFormApplies(shortForm: NormalizeRecipe['shortForm'] | undefined, durationSec: number): boolean
{
  if (shortForm === null || shortForm === undefined || shortForm.mode === 'off')
  {
    return false
  }
  return shortForm.mode === 'on' || durationSec <= shortForm.rule.autoMaxDurationSec
}

/**
 * The plan that brings a stream to the target. With the short-form rule the gain also keeps the maximum
 * short-term loudness at T + D; the rule needs a short-term value, and in automatic mode durationSec, when
 * given, must be within the rule's duration. Spotify-style targets with a lower maximum above a level are
 * planned against that maximum when the plan lands above the level.
 */
export function planNormalize(stats: LoudnessStats, recipe: NormalizePlanRecipe, ceiling: Ceiling, audioIndex: number,
  durationSec?: number): GainPlan
{
  const integrated = stats.integratedLufs
  const peak = stats.truePeakDbtp
  if (stats.status !== 'measured' || integrated === null || peak === null)
  {
    return passthrough(stats, recipe.target.integratedLufs, 0, recipe.maxLimitingDb, ceiling, audioIndex)
  }
  const first = normalizeWith(stats, integrated, peak, recipe, ceiling, audioIndex, durationSec)
  const tightened = tightenForLevel(recipe.target, ceiling, first.predictedLufs)
  return tightened === ceiling ? first : normalizeWith(stats, integrated, peak, recipe, tightened, audioIndex, durationSec)
}

/**
 * The plan of a gain in dB with the limiter always on. Only digital silence passes through: a stream too
 * short or too quiet to measure is still boosted, since the plan needs only its true peak.
 */
export function planBoost(stats: LoudnessStats, recipe: BoostPlanRecipe, ceiling: Ceiling, audioIndex: number): GainPlan
{
  const peak = stats.truePeakDbtp
  const requested = hundredths(recipe.gainDb)
  if (stats.status === 'silent' || peak === null)
  {
    return { ...passthrough(stats, null, requested, recipe.maxLimitingDb, ceiling, audioIndex), reason: 'silent' }
  }
  const headroom = clean(ceiling.limiterCeilingDbtp - peak)
  const decision = decide(requested, headroom, recipe.maxLimitingDb, 'peak-limit', false)
  const integrated = stats.status === 'measured' ? stats.integratedLufs : null
  return {
    audioIndex,
    mode: decision.mode,
    reason: decision.reason,
    targetLufs: integrated === null ? null : clean(integrated + requested),
    requestedGainDb: requested,
    gainDb: decision.gainDb,
    headroomDb: headroom,
    limitingDb: decision.limitingDb,
    maxLimitingDb: recipe.maxLimitingDb,
    predictedLufs: integrated === null ? null : clean(integrated + decision.gainDb),
    predictedTruePeakDbtp: clean(peak + decision.gainDb),
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling
  }
}

/**
 * One gain for an album: T minus the loudest member's integrated loudness (the first of a tie), applied to every
 * member when every member's limiting stays within the allowance (none for stop-at-reachable); otherwise the
 * lowest reachable gain, so the members keep their relative levels. No member is planned louder than T, and
 * each member's plan targets its own level at the album gain. Members that are not measured pass through; with
 * none measured, the first member stands as the anchor at the target with no gain.
 */
export function planAlbum(members: ReadonlyArray<AlbumMember>, recipe: Pick<NormalizeRecipe, 'target' | 'policy' | 'maxLimitingDb'>): AlbumPlan
{
  const plans = members.map((member) => ({
    jobId: member.jobId,
    plan: passthrough(member.stats, recipe.target.integratedLufs, 0, recipe.maxLimitingDb, member.ceiling, member.audioIndex)
  }))
  const measured: Measured[] = []
  members.forEach((member, index) =>
  {
    const { status, integratedLufs, truePeakDbtp } = member.stats
    if (status === 'measured' && integratedLufs !== null && truePeakDbtp !== null)
    {
      measured.push({ index, member, integrated: integratedLufs, peak: truePeakDbtp, ceiling: member.ceiling })
    }
  })
  if (measured.length === 0)
  {
    return {
      anchorJobId: members.length === 0 ? '' : members[0].jobId,
      anchorLufs: recipe.target.integratedLufs,
      gainDb: 0,
      reason: members.length === 0 ? 'silent' : passthroughReason(members[0].stats),
      plans
    }
  }
  const anchor = measured.reduce((loudest, candidate) => candidate.integrated > loudest.integrated ? candidate : loudest)
  const requested = floorHundredths(recipe.target.integratedLufs - anchor.integrated)
  let album = albumGain(measured, requested, recipe)
  let tightenedAny = false
  for (const entry of measured)
  {
    const tightened = tightenForLevel(recipe.target, entry.ceiling, clean(entry.integrated + album.gainDb))
    tightenedAny = tightenedAny || tightened !== entry.ceiling
    entry.ceiling = tightened
  }
  if (tightenedAny)
  {
    album = albumGain(measured, requested, recipe)
  }
  for (const entry of measured)
  {
    plans[entry.index] = { jobId: entry.member.jobId, plan: albumMemberPlan(entry, requested, album, recipe) }
  }
  return { anchorJobId: anchor.member.jobId, anchorLufs: anchor.integrated, gainDb: album.gainDb, reason: album.reason, plans }
}

/** The loudness tolerance of an output: the standard's own where it states one, tightened from the app's check. */
export function toleranceLu(target: LoudnessTarget | null, cls: OutputClass): number
{
  const app = cls === 'lossless' ? APP_TOLERANCE_LU.lossless : APP_TOLERANCE_LU.lossy
  return Math.min(target?.toleranceLu ?? Infinity, app)
}

function normalizeWith(stats: LoudnessStats, integrated: number, peak: number, recipe: NormalizePlanRecipe, ceiling: Ceiling,
  audioIndex: number, durationSec: number | undefined): GainPlan
{
  const target = recipe.target.integratedLufs
  const toTarget = target - integrated
  const shortTerm = shortTermRule(recipe, stats.maxShortTermLufs, durationSec)
  const cap = shortTerm === null ? null : target + shortTerm.allowance - shortTerm.measured
  const capped = cap !== null && toTarget - cap > LINEAR_EPSILON_DB
  const requested = floorHundredths(capped ? cap : toTarget)
  const headroom = clean(ceiling.limiterCeilingDbtp - peak)
  const decision = decide(requested, headroom, recipe.maxLimitingDb, recipe.policy, capped)
  return {
    audioIndex,
    mode: decision.mode,
    reason: decision.reason,
    targetLufs: target,
    requestedGainDb: floorHundredths(toTarget),
    gainDb: decision.gainDb,
    headroomDb: headroom,
    limitingDb: decision.limitingDb,
    maxLimitingDb: recipe.maxLimitingDb,
    predictedLufs: clean(integrated + decision.gainDb),
    predictedTruePeakDbtp: clean(peak + decision.gainDb),
    shortTermLimitLufs: shortTerm === null ? null : clean(target + shortTerm.allowance),
    predictedMaxShortTermLufs: shortTerm === null ? null : clean(shortTerm.measured + decision.gainDb),
    ceiling
  }
}

function shortTermRule(recipe: NormalizePlanRecipe, measured: number | null, durationSec: number | undefined):
  { allowance: number; measured: number } | null
{
  const shortForm = recipe.shortForm
  if (shortForm === null || shortForm === undefined || measured === null || measured <= SHORT_TERM_FLOOR_LUFS)
  {
    return null
  }
  const applies = durationSec === undefined ? shortForm.mode !== 'off' : shortFormApplies(shortForm, durationSec)
  return applies ? { allowance: shortForm.rule.maxAboveTargetLu, measured } : null
}

/** The decision table of a requested gain G against the headroom H with the allowance N. */
function decide(requested: number, headroom: number, allowance: number, policy: UnreachablePolicy, capped: boolean): Decision
{
  const limiting = clean(Math.max(0, requested - headroom))
  if (limiting <= LINEAR_EPSILON_DB)
  {
    return capped
      ? { mode: 'reachable-linear', reason: 'short-term-capped', gainDb: requested, limitingDb: 0 }
      : { mode: 'linear', reason: 'fits', gainDb: requested, limitingDb: 0 }
  }
  if (policy === 'stop-at-reachable')
  {
    return { mode: 'reachable-linear', reason: 'headroom-capped', gainDb: floorHundredths(headroom), limitingDb: 0 }
  }
  if (limiting <= allowance)
  {
    return capped
      ? { mode: 'reachable-limited', reason: 'short-term-capped', gainDb: requested, limitingDb: limiting }
      : { mode: 'peak-limited', reason: 'needs-limiting', gainDb: requested, limitingDb: limiting }
  }
  const gain = floorHundredths(headroom + allowance)
  return { mode: 'reachable-limited', reason: 'limiting-capped', gainDb: gain, limitingDb: clean(Math.max(0, gain - headroom)) }
}

function albumGain(measured: readonly Measured[], requested: number, recipe: Pick<NormalizeRecipe, 'policy' | 'maxLimitingDb'>):
  { gainDb: number; reason: PlanReason }
{
  const allowance = recipe.policy === 'stop-at-reachable' ? 0 : recipe.maxLimitingDb
  const headrooms = measured.map((entry) => clean(entry.ceiling.limiterCeilingDbtp - entry.peak))
  const limiting = headrooms.map((headroom) => clean(Math.max(0, requested - headroom)))
  if (limiting.every((z) => z <= LINEAR_EPSILON_DB))
  {
    return { gainDb: requested, reason: 'fits' }
  }
  if (limiting.every((z) => z <= allowance))
  {
    return { gainDb: requested, reason: 'needs-limiting' }
  }
  const lowest = Math.min(...headrooms.map((headroom) => headroom + allowance))
  return { gainDb: floorHundredths(lowest), reason: recipe.policy === 'stop-at-reachable' ? 'headroom-capped' : 'limiting-capped' }
}

function albumMemberPlan(entry: Measured, requested: number, album: { gainDb: number; reason: PlanReason },
  recipe: Pick<NormalizeRecipe, 'maxLimitingDb'>): GainPlan
{
  const ceiling = entry.ceiling
  const headroom = clean(ceiling.limiterCeilingDbtp - entry.peak)
  const limiting = clean(Math.max(0, album.gainDb - headroom))
  const limited = limiting > LINEAR_EPSILON_DB
  const reachable = album.reason === 'limiting-capped' || album.reason === 'headroom-capped'
  let mode: GainMode
  let reason: PlanReason
  if (reachable)
  {
    mode = limited ? 'reachable-limited' : 'reachable-linear'
    reason = album.reason
  }
  else
  {
    mode = limited ? 'peak-limited' : 'linear'
    reason = limited ? 'needs-limiting' : 'fits'
  }
  return {
    audioIndex: entry.member.audioIndex,
    mode,
    reason,
    targetLufs: clean(entry.integrated + requested),
    requestedGainDb: requested,
    gainDb: album.gainDb,
    headroomDb: headroom,
    limitingDb: limited ? limiting : 0,
    maxLimitingDb: recipe.maxLimitingDb,
    predictedLufs: clean(entry.integrated + album.gainDb),
    predictedTruePeakDbtp: clean(entry.peak + album.gainDb),
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling
  }
}

function passthrough(stats: LoudnessStats, targetLufs: number | null, requested: number, allowance: number, ceiling: Ceiling,
  audioIndex: number): GainPlan
{
  const peak = stats.truePeakDbtp
  return {
    audioIndex,
    mode: 'passthrough',
    reason: passthroughReason(stats),
    targetLufs,
    requestedGainDb: requested,
    gainDb: 0,
    headroomDb: peak === null ? null : clean(ceiling.limiterCeilingDbtp - peak),
    limitingDb: 0,
    maxLimitingDb: allowance,
    predictedLufs: null,
    predictedTruePeakDbtp: null,
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling
  }
}

/** The measure status, or for a measured stream that lacks a value: silence without a peak, else below the floor. */
function passthroughReason(stats: LoudnessStats): PlanReason
{
  if (stats.status !== 'measured')
  {
    return stats.status
  }
  return stats.truePeakDbtp === null ? 'silent' : 'below-floor'
}

/**
 * The ceiling under the target's lower maximum for outputs above a level, when the level is above it;
 * otherwise the same ceiling object.
 */
function tightenForLevel(target: LoudnessTarget, ceiling: Ceiling, levelLufs: number | null): Ceiling
{
  const presetMax = presetMaxFor(target, levelLufs)
  if (presetMax >= ceiling.presetMaxDbtp)
  {
    return ceiling
  }
  const ceilingDbtp = ceiling.codecCeilingDbtp === null ? presetMax : Math.min(presetMax, ceiling.codecCeilingDbtp)
  return {
    ...ceiling,
    presetMaxDbtp: presetMax,
    ceilingDbtp,
    limiterCeilingDbtp: ceilingDbtp - LIMITER_MARGIN_DB,
    gateDbtp: presetMax,
    decodedLimitDbtp: ceiling.outputClass === 'lossless' ? ceilingDbtp : presetMax
  }
}

/** The nearest 0.01 dB, halves away from zero. */
function hundredths(db: number): number
{
  return clean(Math.sign(db) * Math.round(Number((Math.abs(db) * 100).toFixed(6))) / 100)
}

/** The 0.01 dB step at or below the value, ignoring float noise under 1e-6. */
function floorHundredths(db: number): number
{
  return clean(Math.floor(Number((db * 100).toFixed(6))) / 100)
}

/** The value at 1e-6 precision, without float noise or a negative zero. */
function clean(value: number): number
{
  const rounded = Number(value.toFixed(6))
  return rounded === 0 ? 0 : rounded
}
