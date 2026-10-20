/**
 * Loudness measurement: one decode measures every audio stream of a file through labeled ebur128 instances, with
 * the ITU-R BS.1770-5 Annex 3 pre-scale for layouts beyond five main channels, the center-channel estimate for
 * cinematic jobs, and the maximum short-term loudness for short-form items. The Summary parser keeps the last
 * block per label, and classify decides whether a stream can be planned.
 */
import type { AudioJobInput, LoudnessStats } from '../../../shared/audio/types'
import { filterComplex } from './chains'
import type { FilterPart } from './chains'

/** How one audio stream is measured. */
export interface MeasureSpec
{
  audioIndex: number
  /** The meter prefix from chains.meterPrefix: float, then mono duplication, downmix, dynamics. */
  pre: readonly string[]
  dualMono: boolean
  /** The loudness-branch pre-scale from annex3Stage; null when FFmpeg's weights match BS.1770-5. */
  weights: string | null
  /** Records the maximum short-term loudness (the short-form rule applies). */
  shortTerm: boolean
  /** The center-channel estimate: a cinematic recipe and a layout with FC and at least five channels. */
  dialogue: boolean
}

/** 1 / sqrt(1.41): turns FFmpeg's 1.41 channel weight into the Annex 3 weight of 1.00. */
export const ANNEX3_FACTOR = 0.842152

/** Channels at ear height that count toward the main channels. */
const MAIN_CHANNELS: ReadonlySet<string> = new Set(['FL', 'FR', 'FC', 'FLC', 'FRC', 'BL', 'BR', 'BC', 'SL', 'SR'])

/** Low-frequency and elevated channels, whose Annex 3 weight FFmpeg already applies except for the top-back ones. */
const OTHER_CHANNELS: ReadonlySet<string> = new Set(['LFE', 'LFE2', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR'])

const TOP_BACK: ReadonlySet<string> = new Set(['TBL', 'TBC', 'TBR'])

const INPUT_ARGS: readonly string[] = ['-loglevel', 'level+info', '-analyzeduration', '200M', '-probesize', '200M']

const DIALOGUE_PAN = 'pan=mono|c0=FC'

/** The ametadata key that carries ebur128's short-term loudness, one frame per 100 ms. */
const SHORT_TERM_KEY = 'lavfi.r128.S'

/** An Annex 3 pre-scale stage (null when the layout needs none), or the channel that has no known position. */
export type Annex3Result = { ok: true; stage: string | null } | { ok: false; channel: string }

/**
 * The Annex 3 pre-scale of a layout's loudness branch: a pan that scales by ANNEX3_FACTOR the channels FFmpeg
 * weights 1.41 where Annex 3 weights 1.00 (BL and BR beside SL and SR, BC with more than five main channels, and
 * the top-back channels), or null when none needs it. A channel without a known position is refused.
 */
export function annex3Stage(layout: string, channels: readonly string[]): Annex3Result
{
  const unknown = channels.find((channel) => !MAIN_CHANNELS.has(channel) && !OTHER_CHANNELS.has(channel))
  if (unknown !== undefined)
  {
    return { ok: false, channel: unknown }
  }
  const main = channels.filter((channel) => MAIN_CHANNELS.has(channel)).length
  const sides = channels.includes('SL') && channels.includes('SR')
  const scaled = (channel: string): boolean =>
    TOP_BACK.has(channel) || ((channel === 'BL' || channel === 'BR') && sides) || (channel === 'BC' && main > 5)
  if (!channels.some(scaled))
  {
    return { ok: true, stage: null }
  }
  const gains = channels.map((channel) => (scaled(channel) ? `${channel}=${ANNEX3_FACTOR}*${channel}` : `${channel}=${channel}`))
  return { ok: true, stage: `pan=${layout}|${gains.join('|')}` }
}

/** A labeled ebur128 meter; metadata=1 adds the per-100 ms frame metadata a short-term printer reads. */
export function ebur128Stage(label: string, peak: 'true' | 'none', dualMono: boolean, metadata: boolean): string
{
  return `ebur128@${label}=peak=${peak}:dualmono=${dualMono}:framelog=verbose${metadata ? ':metadata=1' : ''}`
}

/** The short-term printer that follows a loudness meter with metadata=1. */
export function shortTermStage(label: string): string
{
  return `ametadata@${label}=mode=print:key=${SHORT_TERM_KEY}`
}

/** The graph parts that measure stream N into [m<N>], with its Annex 3 and center-channel branches. */
function measureParts(spec: MeasureSpec): FilterPart[]
{
  const n = spec.audioIndex
  const input = `0:a:${n}`
  const onMain = spec.weights === null && spec.shortTerm
  const meter = [ebur128Stage(`m${n}`, 'true', spec.dualMono, onMain), ...(onMain ? [shortTermStage(`s${n}`)] : [])]
  const labels = [`p${n}`]
  const branches: FilterPart[] = []
  if (spec.weights !== null)
  {
    labels.push(`q${n}`)
    const printer = spec.shortTerm ? [shortTermStage(`s${n}`)] : []
    branches.push({
      input: `q${n}`,
      stages: [spec.weights, ebur128Stage(`w${n}`, 'none', spec.dualMono, spec.shortTerm), ...printer, 'anullsink'],
      output: ''
    })
  }
  if (spec.dialogue)
  {
    labels.push(`c${n}`)
    branches.push({ input: `c${n}`, stages: [DIALOGUE_PAN, ebur128Stage(`d${n}`, 'none', false, false), 'anullsink'], output: '' })
  }
  if (branches.length === 0)
  {
    return [{ input, stages: [...spec.pre, ...meter], output: `m${n}` }]
  }
  const split = `asplit=${labels.length}${labels.map((label) => `[${label}]`).join('')}`
  return [{ input, stages: [...spec.pre, split], output: '' }, { input: `p${n}`, stages: meter, output: `m${n}` }, ...branches]
}

/** The measure argv after exec's prefix: every stream in one decode, each [m<N>] mapped to the null muxer. */
export function buildMeasureArgs(input: string, specs: readonly MeasureSpec[]): string[]
{
  if (specs.length === 0)
  {
    throw new Error('A measure run needs at least one stream')
  }
  const maps = specs.flatMap((spec) => ['-map', `[m${spec.audioIndex}]`])
  return [...INPUT_ARGS, '-i', input, '-filter_complex', filterComplex(specs.flatMap(measureParts)), ...maps, '-f', 'null', '-']
}

/** The measurement cache key: the source's path, size, and modification time, the FFmpeg build, and every spec. */
export function measureKey(job: AudioJobInput, buildId: string, specs: readonly MeasureSpec[]): string
{
  const streams = specs.map((spec) => [spec.audioIndex, spec.pre, spec.dualMono, spec.weights, spec.shortTerm, spec.dialogue])
  return JSON.stringify(['measure', job.sourcePath, job.sourceSize, job.sourceMtimeMs, buildId, streams])
}

/** One labeled ebur128 Summary, or the short-term maximum of an ametadata printer. */
export interface Ebur128Block
{
  integratedLufs: number | null
  thresholdLufs: number | null
  loudnessRangeLu: number | null
  lraLowLufs: number | null
  lraHighLufs: number | null
  /** -Infinity for digital silence; other non-finite values are null. */
  truePeakDbtp: number | null
  /** The largest lavfi.r128.S value above the empty-window placeholder; null without one. */
  maxShortTermLufs: number | null
}

const SUMMARY = /^\[ebur128@([a-z]+\d*) @ [0-9A-Fa-fx]+\] (?:\[info\] )?Summary:$/
const SHORT_TERM = /^\[ametadata@([a-z]+\d*) @ [0-9A-Fa-fx]+\] (?:\[info\] )?lavfi\.r128\.S=(\S+)$/
const SUMMARY_VALUE = /^\s+(I|Threshold|LRA|LRA low|LRA high|Peak):\s+(\S+) (?:LUFS|LU|dBFS|dBTP)$/
const SECTION = /^\s+(Integrated loudness|Loudness range|True peak|Sample peak):$/
const NUMBER = /^-?\d+(?:\.\d+)?$/

/** ebur128 prints -120.691 while its 3 s short-term window is still empty. */
const SHORT_TERM_PLACEHOLDER_MAX = -120

/** Whether a normalized stderr line opens a labeled ebur128 Summary block. */
export function isSummaryLine(line: string): boolean
{
  return SUMMARY.test(line)
}

function emptyBlock(): Ebur128Block
{
  return {
    integratedLufs: null,
    thresholdLufs: null,
    loudnessRangeLu: null,
    lraLowLufs: null,
    lraHighLufs: null,
    truePeakDbtp: null,
    maxShortTermLufs: null
  }
}

function summaryValue(text: string, peak: boolean): number | null
{
  if (NUMBER.test(text))
  {
    return Number(text)
  }
  return peak && text === '-inf' ? -Infinity : null
}

function readSummary(lines: readonly string[], start: number): Ebur128Block
{
  const block = emptyBlock()
  let section = ''
  for (let i = start; i < lines.length && !lines[i].startsWith('['); i++)
  {
    const heading = SECTION.exec(lines[i])
    if (heading !== null)
    {
      section = heading[1]
      continue
    }
    const value = SUMMARY_VALUE.exec(lines[i])
    if (value === null)
    {
      continue
    }
    const [, name, text] = value
    if (section === 'Integrated loudness' && name === 'I')
    {
      block.integratedLufs = summaryValue(text, false)
    }
    else if (section === 'Integrated loudness' && name === 'Threshold')
    {
      block.thresholdLufs = summaryValue(text, false)
    }
    else if (section === 'Loudness range' && name === 'LRA')
    {
      block.loudnessRangeLu = summaryValue(text, false)
    }
    else if (section === 'Loudness range' && name === 'LRA low')
    {
      block.lraLowLufs = summaryValue(text, false)
    }
    else if (section === 'Loudness range' && name === 'LRA high')
    {
      block.lraHighLufs = summaryValue(text, false)
    }
    else if (section === 'True peak' && name === 'Peak')
    {
      block.truePeakDbtp = summaryValue(text, true)
    }
  }
  return block
}

/**
 * Every labeled ebur128 Summary in a run's stderr, keyed by its label (m0, w0, d1), the last block per label
 * winning over the bogus first Summary of 5.1-era builds; and every short-term printer's maximum, keyed by its
 * label (s0). A block runs from its Summary line to the next line that starts with '['.
 */
export function parseEbur128Blocks(stderr: string): Map<string, Ebur128Block>
{
  const lines = stderr.replace(/\r\n?/g, '\n').split('\n')
  const blocks = new Map<string, Ebur128Block>()
  lines.forEach((line, index) =>
  {
    const summary = SUMMARY.exec(line)
    if (summary !== null)
    {
      blocks.set(summary[1], readSummary(lines, index + 1))
      return
    }
    const shortTerm = SHORT_TERM.exec(line)
    if (shortTerm === null)
    {
      return
    }
    const entry = blocks.get(shortTerm[1]) ?? emptyBlock()
    const value = NUMBER.test(shortTerm[2]) ? Number(shortTerm[2]) : null
    if (value !== null && value > SHORT_TERM_PLACEHOLDER_MAX && (entry.maxShortTermLufs === null || value > entry.maxShortTermLufs))
    {
      entry.maxShortTermLufs = value
    }
    blocks.set(shortTerm[1], entry)
  })
  return blocks
}

/**
 * Stream N's reading: loudness, threshold, and range from its Annex 3 branch when the spec has one, otherwise
 * from m<N>; the true peak always from m<N>; the short-term maximum from s<N>. Undefined when a block is missing.
 */
export function streamBlock(blocks: ReadonlyMap<string, Ebur128Block>, spec: MeasureSpec): Ebur128Block | undefined
{
  const n = spec.audioIndex
  const main = blocks.get(`m${n}`)
  const loudness = spec.weights === null ? main : blocks.get(`w${n}`)
  if (main === undefined || loudness === undefined)
  {
    return undefined
  }
  return {
    integratedLufs: loudness.integratedLufs,
    thresholdLufs: loudness.thresholdLufs,
    loudnessRangeLu: loudness.loudnessRangeLu,
    lraLowLufs: loudness.lraLowLufs,
    lraHighLufs: loudness.lraHighLufs,
    truePeakDbtp: main.truePeakDbtp,
    maxShortTermLufs: spec.shortTerm ? (blocks.get(`s${n}`)?.maxShortTermLufs ?? null) : null
  }
}

/** Shorter than one BS.1770 gating block. */
const GATING_BLOCK_SEC = 0.4

/** Loudness range is reported only for items of at least a minute (EBU R 128, Tech 3342). */
export const LRA_MIN_SEC = 60

/** I at or under -70.0 with a threshold of 0.0: no gating block passed the absolute gate. */
function gateFailed(block: Ebur128Block): boolean
{
  return block.integratedLufs === null || (block.integratedLufs <= -70 && block.thresholdLufs === 0)
}

/**
 * A stream's LoudnessStats from its reading: a -inf or missing true peak is silent; a reading where no gating
 * block passed the absolute gate is too-short under 0.4 s and below-floor otherwise; everything else is measured.
 * The dialogue block is the center-channel estimate of a cinematic job.
 */
export function classify(block: Ebur128Block | undefined, durationSec: number | null, dualMono: boolean,
  dialogue: Ebur128Block | undefined, annex3 = false): LoudnessStats
{
  const lraApplies = durationSec !== null && durationSec >= LRA_MIN_SEC
  const stats: LoudnessStats = {
    status: 'silent',
    integratedLufs: null,
    thresholdLufs: null,
    loudnessRangeLu: null,
    lraStatus: lraApplies ? 'measured' : 'not-applicable',
    maxShortTermLufs: null,
    truePeakDbtp: null,
    dialogueLufs: null,
    dualMono,
    channelWeights: annex3 ? 'bs1770-annex3' : 'bs1770-annex1'
  }
  const peak = block?.truePeakDbtp ?? null
  if (block === undefined || peak === null || peak === -Infinity)
  {
    return stats
  }
  if (gateFailed(block))
  {
    const tooShort = durationSec !== null && durationSec < GATING_BLOCK_SEC
    return { ...stats, status: tooShort ? 'too-short' : 'below-floor', truePeakDbtp: peak }
  }
  return {
    ...stats,
    status: 'measured',
    integratedLufs: block.integratedLufs,
    thresholdLufs: block.thresholdLufs,
    loudnessRangeLu: lraApplies ? block.loudnessRangeLu : null,
    maxShortTermLufs: block.maxShortTermLufs,
    truePeakDbtp: peak,
    dialogueLufs: dialogue === undefined || gateFailed(dialogue) ? null : dialogue.integratedLufs
  }
}
