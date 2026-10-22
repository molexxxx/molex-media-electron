/**
 * Stage builders for the measure and encode graphs. Every chain processes in double precision, applies its gain
 * in dB, limits at L = C - 0.5 on a signal oversampled to at least 192 kHz, and ends with an aformat pin that
 * carries the output rate and layout, so FFmpeg never picks either on its own (D1).
 *
 * No branch that resamples ends in anullsink: FFmpeg 7.0 and 7.1 abort with `Assertion best_input >= 0 failed`
 * (fftools/ffmpeg_filter.c, choose_input) when a rate-changing aresample feeds an in-graph sink, because the
 * sink's EOF arrives inside avfilter_graph_request_oldest and the graph answers EAGAIN after every input has
 * ended. Meter branches are therefore graph outputs, drained by a second output into the null muxer.
 */
import { LIMITER_MARGIN_DB } from './ceilings'
import { downmixStage } from './downmix'
import type { DownmixLevels } from './downmix'
import type { Ceiling, DownmixMode, PinFormat } from '../../../shared/audio/types'

export type { PinFormat }

/** The limiter's timing in ms and its margin under the ceiling C in dB. */
export const LIMITER = { attackMs: 20, releaseMs: 200, marginDb: LIMITER_MARGIN_DB } as const

/** The limiter runs at or above this rate, so its sample-peak detection holds a true-peak ceiling. */
export const OVERSAMPLE_MIN_RATE = 192000

/** alimiter's limit option accepts 0.0625 to 1, that is -24.08 to 0 dB. */
const LIMIT_RANGE_DB = { min: -24, max: 0 } as const

const FLOAT = 'aformat=sample_fmts=dbl'
const STEREO_FLOAT = 'aformat=sample_fmts=dbl:channel_layouts=stereo'
const MONO_TO_STEREO = 'pan=stereo|c0=c0|c1=c0'

/** The output format of one stream: its rate and layout come from the encoder choice, not the source. */
export interface ChainOutput
{
  sampleRate: number
  layout: string
  pin: PinFormat
  /** The output encoder; alac takes planar samples, so its 16-bit pin also allows s16p. */
  encoder?: string
}

/** Everything one stream's encode chain depends on. */
export interface ChainSpec
{
  inputLayout: string
  /** The source sample rate. */
  processRate: number
  /** Duplicates a mono source into two identical channels at full level. */
  monoToStereo: boolean
  downmix: DownmixMode | null
  /** The stream's own downmix levels; null or absent takes BS.775-4. */
  downmixLevels?: DownmixLevels | null
  /** The compressor stage from dynamics.ts, its threshold already anchored. */
  dynamics: string | null
  /** 0 is off. */
  highpassHz: number
  gainDb: number
  /** L, the ceiling minus the limiter margin. */
  limiterCeilingDbtp: number
  out: ChainOutput
  /** The pre-encode true-peak meter of lossy outputs; null for lossless ones. */
  preEncodeMeter: 'soxr' | 'swr' | null
}

/** One chain of a filter graph: [input]stages[output]. An empty label is left out. */
export interface FilterPart
{
  input: string
  stages: readonly string[]
  output: string
}

/** A gain in dB with two decimals, halves rounded away from zero: '-2.00dB'. */
export function formatDb(db: number): string
{
  const hundredths = Math.sign(db) * Math.round(Number((Math.abs(db) * 100).toFixed(6)))
  return `${(hundredths === 0 ? 0 : hundredths / 100).toFixed(2)}dB`
}

/** The smallest multiple of the rate at or above 192 kHz; a rate already there is kept. */
export function oversampleRate(sampleRate: number): number
{
  if (!(sampleRate > 0))
  {
    return OVERSAMPLE_MIN_RATE
  }
  if (sampleRate >= OVERSAMPLE_MIN_RATE)
  {
    return sampleRate
  }
  return Math.ceil(OVERSAMPLE_MIN_RATE / sampleRate) * sampleRate
}

/**
 * Stages 1 to 4, shared by the meter and the encoder: float processing, mono duplication of a mono source,
 * the downmix with its stereo float pin, and the anchored compressor.
 */
export function meterPrefix(spec: Pick<ChainSpec, 'inputLayout' | 'monoToStereo' | 'downmix' | 'downmixLevels' | 'dynamics'>): string[]
{
  const stages = [FLOAT]
  if (spec.monoToStereo && spec.inputLayout === 'mono')
  {
    stages.push(MONO_TO_STEREO)
  }
  const downmix = spec.downmix === null ? null : downmixStage(spec.downmix, spec.inputLayout, spec.downmixLevels ?? null)
  if (downmix !== null)
  {
    stages.push(downmix.stage, STEREO_FLOAT)
  }
  if (spec.dynamics !== null)
  {
    stages.push(spec.dynamics)
  }
  return stages
}

/**
 * Stages 1 to 8 of one stream: the meter prefix, the high-pass, the gain, the oversampled limiter, and the pin. A
 * mono source that becomes two speakers is processed and pinned in mono and duplicated last, so dither is drawn once
 * and both channels carry identical samples; gain and limiting on identical channels match the duplicated meter.
 */
export function encodeChain(spec: ChainSpec): string[]
{
  const duplicate = spec.monoToStereo && spec.inputLayout === 'mono'
  return [
    ...meterPrefix(duplicate ? { ...spec, monoToStereo: false } : spec),
    ...(spec.highpassHz > 0 ? [`highpass=f=${spec.highpassHz}:poles=2`] : []),
    `volume=${formatDb(spec.gainDb)}:precision=double`,
    ...limiterStages(spec.limiterCeilingDbtp, spec.processRate),
    ...(duplicate ? duplicatedPinStages(spec.out) : pinStages(spec.out))
  ]
}

/** The pin of a duplicated mono stream: pinned in mono, then copied to both channels and pinned again as stereo. */
export function duplicatedPinStages(out: ChainOutput): string[]
{
  const mono = pinStages({ ...out, layout: 'mono' })
  const stereo = pinStages({ ...out, layout: 'stereo' })
  return [...mono, MONO_TO_STEREO, stereo[stereo.length - 1]]
}

/** The oversampler unless the signal already runs at 192 kHz or more, then the limiter at L. */
export function limiterStages(limiterCeilingDbtp: number, processRate: number): string[]
{
  const limit = Math.min(LIMIT_RANGE_DB.max, Math.max(LIMIT_RANGE_DB.min, limiterCeilingDbtp))
  const limiter = `alimiter=limit=${formatDb(limit)}:attack=${LIMITER.attackMs}:release=${LIMITER.releaseMs}:level=disabled:latency=1`
  return processRate >= OVERSAMPLE_MIN_RATE ? [limiter] : [`aresample=${oversampleRate(processRate)}`, limiter]
}

/** The output pin: TPDF-dithered 16-bit, 32-bit for 24-bit outputs, or the encoder's own format; always ends in aformat. */
export function pinStages(out: ChainOutput): string[]
{
  const rateAndLayout = `sample_rates=${out.sampleRate}:channel_layouts=${out.layout}`
  if (out.pin === 's16-dither')
  {
    const formats = out.encoder === 'alac' ? 's16|s16p' : 's16'
    return [
      `aresample=osr=${out.sampleRate}:osf=s16:dither_method=triangular`,
      `aformat=sample_fmts=${formats}:${rateAndLayout}`
    ]
  }
  if (out.pin === 's32')
  {
    return [`aformat=sample_fmts=s32:${rateAndLayout}`]
  }
  return [`aformat=${rateAndLayout}`]
}

/** The pre-encode meter branch of output k: 8x oversampled in float, read from astats@p<k>, ending in [p<k>]. */
export function preEncodeMeterStages(meter: 'soxr' | 'swr', sampleRate: number, k: number): string[]
{
  const rate = sampleRate * 8
  const resampler = meter === 'soxr' ? `aresample=resampler=soxr:precision=33:osr=${rate}:osf=dbl` : `aresample=osr=${rate}:osf=dbl`
  return [FLOAT, resampler, `astats@p${k}=measure_perchannel=none:measure_overall=Peak_level`]
}

/**
 * The graph parts of output k read from input: the chain into [a<k>], or, with a pre-encode meter, the chain
 * split into [a<k>] for the encoder and [q<k>] for the meter, whose branch ends in [p<k>] (stage 9).
 */
export function encodeParts(spec: ChainSpec, input: string, k: number): FilterPart[]
{
  const chain = encodeChain(spec)
  if (spec.preEncodeMeter === null)
  {
    return [{ input, stages: chain, output: `a${k}` }]
  }
  return [
    { input, stages: [...chain, `asplit=2[a${k}][q${k}]`], output: '' },
    { input: `q${k}`, stages: preEncodeMeterStages(spec.preEncodeMeter, spec.out.sampleRate, k), output: `p${k}` }
  ]
}

/** The second output of an encode: every meter branch [p<k>] of the given outputs into the null muxer; empty with none. */
export function meterOutputArgs(metered: readonly number[]): string[]
{
  return metered.length === 0 ? [] : [...metered.flatMap((k) => ['-map', `[p${k}]`]), '-f', 'null', '-']
}

/** The timeline export tail after amix: float, the oversampled limiter at the export ceiling, and the encoder pin. */
export function exportLimiterTail(ceiling: Ceiling, sampleRate: number, layout: string): string[]
{
  return [FLOAT, ...limiterStages(ceiling.limiterCeilingDbtp, sampleRate), ...pinStages({ sampleRate, layout, pin: 'encoder' })]
}

/** A -filter_complex value: each part as [input]stage,stage[output], parts joined by semicolons. */
export function filterComplex(parts: ReadonlyArray<FilterPart>): string
{
  return parts
    .map((part) =>
    {
      const input = part.input === '' ? '' : `[${part.input}]`
      const output = part.output === '' ? '' : `[${part.output}]`
      const stages = part.stages.length === 0 ? 'anull' : part.stages.join(',')
      return `${input}${stages}${output}`
    })
    .join(';')
}
