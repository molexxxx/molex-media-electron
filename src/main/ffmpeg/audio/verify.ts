/**
 * Output verification: one decode of the finished file measures every processed stream (loudness, the 8x true
 * peak reference, and the decoded sample peak) and decode-checks the copied ones; the judge compares each stream
 * with its plan and preset, the correction plans the one corrective encode, and better keeps the better pass.
 */
import type { GainPlan, LoudnessTarget, StreamVerdict, UnreachablePolicy, VerifiedStream } from '../../../shared/audio/types'
import { filterComplex } from './chains'
import type { FilterPart } from './chains'
import { ebur128Stage, isSummaryLine, parseEbur128Blocks, shortTermStage } from './measure'

/** How one output stream is verified. */
export interface VerifySpec
{
  outIndex: number
  sampleRate: number
  dualMono: boolean
  /** The annex3Stage pre-scale for the loudness branch. */
  weights: string | null
  /** Adds the lavfi.r128.S printer. */
  shortTerm: boolean
  /** Decode check only, mapped directly with no graph branch. */
  passthrough: boolean
  /** From the encode run's astats@p<k> line; null for lossless outputs. */
  preEncodeTruePeakDbtp: number | null
}

/** Subtracted from every true-peak limit: swresample's 8x reference under-reads clipped content by up to 0.169 dB. */
export const METER_MARGIN_DB = { soxr: 0, swr: 0.2 } as const

/** The first decode errors a verification keeps; the rest are only counted. */
export const MAX_DECODE_ERRORS = 20

/** The extra true-peak reduction of a corrective encode beyond the measured excess. */
export const CORRECTION_STEP_DB = 0.3

/** The lowest limiter ceiling a correction sets: alimiter's limit minimum of 0.0625. */
export const LIMITER_FLOOR_DBTP = -24

const EPSILON = 1e-9

const DECODE_ERROR = /^(?:\[[^\]\n]+ @ [0-9A-Fa-fx]+\] )*\[(?:error|fatal|panic)\] /
const PEAK_LINE = /^\[astats@([ts])(\d+) @ [0-9A-Fa-fx]+\] (?:\[info\] )?Peak level dB: (\S+)$/
const NUMBER = /^-?\d+(?:\.\d+)?$/

function referenceStages(meter: 'soxr' | 'swr', sampleRate: number, label: string): string[]
{
  const rate = sampleRate * 8
  const resampler = meter === 'soxr' ? `aresample=resampler=soxr:precision=33:osr=${rate}:osf=dbl` : `aresample=osr=${rate}:osf=dbl`
  return ['aformat=sample_fmts=dbl', resampler, `astats@${label}=measure_perchannel=none:measure_overall=Peak_level`, 'anullsink']
}

/** Output stream N split three ways: loudness into [v<N>], the 8x reference into astats@t<N>, the samples into astats@s<N>. */
function verifyParts(spec: VerifySpec, meter: 'soxr' | 'swr'): FilterPart[]
{
  const n = spec.outIndex
  const loudness = [
    'aformat=sample_fmts=dbl',
    ...(spec.weights === null ? [] : [spec.weights]),
    ebur128Stage(`v${n}`, 'none', spec.dualMono, spec.shortTerm),
    ...(spec.shortTerm ? [shortTermStage(`s${n}`)] : [])
  ]
  return [
    { input: `0:a:${n}`, stages: [`asplit=3[x${n}][y${n}][z${n}]`], output: '' },
    { input: `x${n}`, stages: loudness, output: `v${n}` },
    { input: `y${n}`, stages: referenceStages(meter, spec.sampleRate, `t${n}`), output: '' },
    { input: `z${n}`, stages: [`astats@s${n}=measure_perchannel=none:measure_overall=Peak_level`, 'anullsink'], output: '' }
  ]
}

/**
 * The verify argv after exec's prefix. Measured streams map [v<N>]; passthrough streams map 0:a:<N> straight to
 * the null muxer, and with no measured stream the graph is left out, since 9.0.2 refuses a graph without outputs.
 */
export function buildVerifyArgs(output: string, specs: readonly VerifySpec[], meter: 'soxr' | 'swr'): string[]
{
  const parts = specs.filter((spec) => !spec.passthrough).flatMap((spec) => verifyParts(spec, meter))
  const graph = parts.length === 0 ? [] : ['-filter_complex', filterComplex(parts)]
  const maps = specs.flatMap((spec) => ['-map', spec.passthrough ? `0:a:${spec.outIndex}` : `[v${spec.outIndex}]`])
  return ['-loglevel', 'level+info', '-i', output, ...graph, ...maps, '-f', 'null', '-']
}

/** Whether a normalized stderr line is a decode error: any context prefixes, then an error, fatal, or panic tag. */
export function isDecodeError(line: string): boolean
{
  return DECODE_ERROR.test(line)
}

function peakValue(text: string): number | null
{
  return NUMBER.test(text) ? Number(text) : null
}

/** A parsed verify run: the measured streams by output audio index, the first decode errors, and their count. */
export interface VerifyParse
{
  streams: Map<number, VerifiedStream>
  decodeErrors: string[]
  decodeErrorCount: number
}

/**
 * Reads a verify run from its stderr line stream: the Summary blocks, the short-term maxima, the peak lines, the
 * first 20 decode errors, and their count. Passthrough streams get only the decode check, so they have no entry.
 */
export function parseVerify(lines: Iterable<string>, specs: readonly VerifySpec[], meter: 'soxr' | 'swr'): VerifyParse
{
  const decodeErrors: string[] = []
  let decodeErrorCount = 0
  const kept: string[] = []
  const references = new Map<number, number | null>()
  const samples = new Map<number, number | null>()
  let inSummary = false
  const chunks = typeof lines === 'string' ? [lines] : lines
  for (const chunk of chunks)
  {
    for (const line of chunk.replace(/\r\n?/g, '\n').split('\n'))
    {
      if (isDecodeError(line))
      {
        decodeErrorCount++
        if (decodeErrors.length < MAX_DECODE_ERRORS)
        {
          decodeErrors.push(line)
        }
      }
      if (line.startsWith('['))
      {
        inSummary = isSummaryLine(line)
      }
      const peak = PEAK_LINE.exec(line)
      if (peak !== null)
      {
        (peak[1] === 't' ? references : samples).set(Number(peak[2]), peakValue(peak[3]))
      }
      else if (inSummary || line.startsWith('[ametadata@'))
      {
        kept.push(line)
      }
    }
  }
  const blocks = parseEbur128Blocks(kept.join('\n'))
  const streams = new Map<number, VerifiedStream>()
  for (const spec of specs)
  {
    const n = spec.outIndex
    const block = blocks.get(`v${n}`)
    if (spec.passthrough || block === undefined)
    {
      continue
    }
    const truePeak = references.get(n) ?? null
    streams.set(n, {
      outIndex: n,
      integratedLufs: block.integratedLufs,
      loudnessRangeLu: block.loudnessRangeLu,
      maxShortTermLufs: spec.shortTerm ? (blocks.get(`s${n}`)?.maxShortTermLufs ?? null) : null,
      preEncodeTruePeakDbtp: spec.preEncodeTruePeakDbtp ?? truePeak,
      truePeakDbtp: truePeak,
      samplePeakDbfs: samples.get(n) ?? null,
      meter: meter === 'soxr' ? 'soxr-8x' : 'swr-8x'
    })
  }
  return { streams, decodeErrors, decodeErrorCount }
}

function round(value: number, digits: number): number
{
  const factor = 10 ** digits
  const rounded = Math.round(value * factor + Math.sign(value) * EPSILON) / factor
  return rounded === 0 ? 0 : rounded
}

function isReachable(plan: GainPlan): boolean
{
  return plan.mode === 'reachable-linear' || plan.mode === 'reachable-limited'
}

/** A measured value against a limit: 'within' at or under it, bounds inclusive; the excess when over. */
function against(value: number | null, limit: number): { status: 'within' | 'over' | 'not-checked'; overDb: number | null }
{
  if (value === null)
  {
    return { status: 'not-checked', overDb: null }
  }
  const excess = value - limit
  return excess <= EPSILON ? { status: 'within', overDb: null } : { status: 'over', overDb: round(excess, 2) }
}

/**
 * Judges one output stream. Loudness is checked against the plan's target for linear and peak-limited plans and
 * against the predicted reachable level for reachable plans; the true peak before encoding against the gate (the
 * louder maximum when the output is above its level), the decoded true peak against the app's limit, and decoded
 * samples against 0 dBFS. With swresample every true-peak limit is lowered by the meter margin.
 */
export function judge(plan: GainPlan, v: VerifiedStream | undefined, target: LoudnessTarget | null, toleranceLu: number,
  encodePass: 1 | 2, decodeErrorCount: number, shortTermToleranceLu = 0): StreamVerdict
{
  const margin = v?.meter === 'swr-8x' ? METER_MARGIN_DB.swr : METER_MARGIN_DB.soxr
  const reachable = isReachable(plan)
  const referenceLufs = plan.mode === 'passthrough' ? null : reachable ? plan.predictedLufs : plan.targetLufs
  const measured = v?.integratedLufs ?? null
  const deviationLu = measured === null || referenceLufs === null ? null : round(measured - referenceLufs, 2)
  const loudnessStatus = deviationLu === null ? 'not-checked'
    : Math.abs(deviationLu) <= toleranceLu + EPSILON ? 'within' : deviationLu < 0 ? 'below' : 'above'
  const louderMax = target?.louderMax ?? null
  const louder = louderMax !== null && measured !== null && measured > louderMax.aboveLufs
  const gateDbtp = louder ? Math.min(plan.ceiling.gateDbtp, louderMax.maxTruePeakDbtp) : plan.ceiling.gateDbtp
  const truePeak = against(v?.preEncodeTruePeakDbtp ?? null, gateDbtp - margin)
  const decoded = against(v?.truePeakDbtp ?? null, plan.ceiling.decodedLimitDbtp - margin)
  const shortTermLimit = plan.shortTermLimitLufs
  const maxShortTerm = v?.maxShortTermLufs ?? null
  const shortTerm = shortTermLimit === null ? { status: 'not-checked' as const, overDb: null }
    : against(maxShortTerm, shortTermLimit + shortTermToleranceLu)
  const samplePeak = v?.samplePeakDbfs ?? null
  const samplePeakOver = samplePeak !== null && samplePeak > 0
  const passes = loudnessStatus === 'within' && shortTerm.status !== 'over' && truePeak.status === 'within' && !samplePeakOver
  const outcome = decodeErrorCount > 0 ? 'failed'
    : plan.mode === 'passthrough' ? 'passthrough'
      : v === undefined ? 'failed'
        : passes ? (reachable ? 'verified-below-target' : 'verified') : 'outside-tolerance'
  return {
    audioIndex: plan.audioIndex,
    outcome,
    loudness: {
      status: loudnessStatus,
      reference: reachable ? 'reachable' : 'target',
      referenceLufs,
      deviationLu,
      toleranceLu,
      standardTolerance: target === null || target.toleranceLu === null
        ? null
        : { value: target.toleranceLu, unit: target.unit === 'LKFS' ? 'dB' : 'LU' }
    },
    shortTerm: { status: shortTerm.status, limitLufs: shortTermLimit, maxLufs: maxShortTerm, toleranceLu: shortTermToleranceLu },
    truePeak: { status: truePeak.status, basis: 'pre-encode', gateDbtp, overDb: truePeak.overDb },
    decoded: { status: decoded.status, limitDbtp: plan.ceiling.decodedLimitDbtp, overDb: decoded.overDb },
    samplePeakOver,
    warnings: decoded.status === 'over' ? ['decoded-overshoot'] : [],
    meterMarginDb: margin,
    encodePasses: encodePass
  }
}

function floorHundredths(value: number): number
{
  return Math.floor(value * 100 + 1e-6) / 100
}

/**
 * The plan of the corrective encode, or null when none applies (pass 2, a failed or passthrough stream, or
 * nothing to correct). A true peak over the gate, a decoded true peak over the app's limit, or decoded samples
 * over 0 dBFS lower the limiter ceiling by the largest excess plus 0.3 dB, to no lower than -24 dBTP. A linear
 * plan outside the loudness tolerance moves its gain by the deviation when the limiting that needs stays within
 * the allowance (none under 'stop-at-reachable'). A maximum short-term loudness over its limit lowers the gain to
 * meet it, and the plan becomes short-term-capped with its predicted level lowered by the same amount.
 */
export function correctedPlan(plan: GainPlan, verdict: StreamVerdict, verified: VerifiedStream,
  policy: UnreachablePolicy = 'peak-limit'): GainPlan | null
{
  if (verdict.encodePasses === 2 || verdict.outcome === 'failed' || plan.mode === 'passthrough')
  {
    return null
  }
  const margin = verdict.meterMarginDb
  const excesses = [
    verified.preEncodeTruePeakDbtp === null ? null : verified.preEncodeTruePeakDbtp - (verdict.truePeak.gateDbtp - margin),
    verified.truePeakDbtp === null ? null : verified.truePeakDbtp - (verdict.decoded.limitDbtp - margin),
    verified.samplePeakDbfs
  ]
  const excess = Math.max(0, ...excesses.filter((value): value is number => value !== null))
  const ceiling = plan.ceiling.limiterCeilingDbtp
  const limiter = excess > EPSILON ? Math.max(LIMITER_FLOOR_DBTP, round(ceiling - (excess + CORRECTION_STEP_DB), 2)) : ceiling
  const peak = plan.predictedTruePeakDbtp === null ? null : plan.predictedTruePeakDbtp - plan.gainDb
  const limitingAt = (gain: number): number | null => (peak === null ? null : round(Math.max(0, peak + gain - limiter), 2))

  let loudnessGain: number | null = null
  const reference = verdict.loudness.referenceLufs
  if (plan.mode === 'linear' && reference !== null && verified.integratedLufs !== null)
  {
    const deviation = verified.integratedLufs - reference
    const gain = floorHundredths(plan.gainDb - deviation)
    const limiting = limitingAt(gain)
    const allowance = policy === 'stop-at-reachable' ? 0 : plan.maxLimitingDb
    if (Math.abs(deviation) > verdict.loudness.toleranceLu + EPSILON && limiting !== null && limiting <= allowance + EPSILON)
    {
      loudnessGain = gain
    }
  }
  let capGain: number | null = null
  const limit = verdict.shortTerm.limitLufs
  if (limit !== null && verified.maxShortTermLufs !== null && verified.maxShortTermLufs - (limit + verdict.shortTerm.toleranceLu) > EPSILON)
  {
    capGain = floorHundredths(plan.gainDb - (verified.maxShortTermLufs - limit))
  }
  const capped = capGain !== null && (loudnessGain === null || capGain < loudnessGain)
  const gain = capped ? (capGain as number) : (loudnessGain ?? plan.gainDb)
  if (gain === plan.gainDb && limiter === ceiling)
  {
    return null
  }
  const shift = gain - plan.gainDb
  const shifted = (value: number | null): number | null => (value === null ? null : round(value + shift, 2))
  return {
    ...plan,
    mode: capped ? (plan.mode === 'linear' || plan.mode === 'reachable-linear' ? 'reachable-linear' : 'reachable-limited') : plan.mode,
    reason: capped ? 'short-term-capped' : plan.reason,
    gainDb: gain,
    headroomDb: peak === null ? plan.headroomDb : round(limiter - peak, 2),
    limitingDb: limitingAt(gain) ?? plan.limitingDb,
    predictedLufs: shifted(plan.predictedLufs),
    predictedTruePeakDbtp: shifted(plan.predictedTruePeakDbtp),
    predictedMaxShortTermLufs: shifted(plan.predictedMaxShortTermLufs),
    ceiling: { ...plan.ceiling, limiterCeilingDbtp: limiter }
  }
}

/** The gain and limiter ceiling of the one corrective encode, read from the measured values; null when none applies. */
export function correction(plan: GainPlan, verdict: StreamVerdict, verified: VerifiedStream,
  policy: UnreachablePolicy = 'peak-limit'): { gainDb: number; limiterCeilingDbtp: number } | null
{
  const next = correctedPlan(plan, verdict, verified, policy)
  return next === null ? null : { gainDb: next.gainDb, limiterCeilingDbtp: next.ceiling.limiterCeilingDbtp }
}

/** A pass's rank, smaller is better: failures, true-peak misses, overs, loudness misses, then the largest deviation. */
function rank(verdicts: readonly StreamVerdict[]): number[]
{
  const checked = verdicts.filter((verdict) => verdict.outcome !== 'passthrough')
  return [
    verdicts.some((verdict) => verdict.outcome === 'failed') ? 1 : 0,
    checked.some((verdict) => verdict.truePeak.status !== 'within') ? 1 : 0,
    checked.some((verdict) => verdict.samplePeakOver) ? 1 : 0,
    checked.some((verdict) => verdict.loudness.status !== 'within') ? 1 : 0,
    Math.max(0, ...checked.map((verdict) => Math.abs(verdict.loudness.deviationLu ?? 0)))
  ]
}

/** Which of two encode passes to keep, ranked lexicographically; a tie keeps the first. */
export function better(a: readonly StreamVerdict[], b: readonly StreamVerdict[]): 'first' | 'second'
{
  const first = rank(a)
  const second = rank(b)
  for (let i = 0; i < first.length; i++)
  {
    if (first[i] !== second[i])
    {
      return second[i] < first[i] ? 'second' : 'first'
    }
  }
  return 'first'
}
