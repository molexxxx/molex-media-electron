/**
 * The Gain fields of the Recipe tab: the gain in dB as a RangeField, the high-pass filter, the true-peak ceiling and
 * the peak limiting allowance, mono sources, and the output codec, with the predicted peak limiting line under Gain.
 */
import { useId, type ReactElement } from 'react'
import { formatNumber, formatSigned, type FieldKey, type FieldState } from '../../../../stores/recipeFields'
import { Button } from '../../../../ui/Button'
import { FieldCaption } from '../../../../ui/FieldCaption'
import type { VideoFieldsProps } from './ConvertFields'
import { GroupedFields, type FieldGroup } from './NormalizeFields'

/** The note over the Gain fields: its presets are this app's, not a standard's. */
export const GAIN_GROUP_NOTE = 'App presets, not standards.'

/** The caption of the read-only line under Gain. */
export const PREDICTED_LIMITING_LABEL = 'Predicted peak limiting'

/** What "peak limiting" means wherever the page uses the term. */
export const PEAK_LIMITING_TERM = 'The gain reduction the limiter applies to keep true peaks under the ceiling.'

/** The line before the source's true peak is known. */
export const UNMEASURED_TEXT = 'Known after measuring.'

/** The line for several jobs, whose sources peak differently. */
export const SEVERAL_TEXT = 'Depends on each file\'s true peak. See Output for each job.'

/** The Gain groups in page order; fields the model leaves out are skipped. */
export const GAIN_GROUPS: readonly FieldGroup[] =
[
  { heading: 'Gain', keys: ['gain', 'truePeak'] },
  { heading: 'Output format', keys: ['output', 'bitrate'] }
]

/** Gain fields most recipes leave alone, shown behind "More settings". */
export const GAIN_MORE: ReadonlySet<FieldKey> = new Set<FieldKey>(['highpass', 'allowance', 'mono'])

/** What the predicted peak limiting line reads from: the requested gain and the source's measured true peak. */
export interface LimitingInput
{
  /** The requested gain, dB. */
  gain: number
  /** The ceiling true peaks stay under, dBTP. */
  ceiling: number
  /** The most peak limiting the recipe allows, dB. */
  allowance: number
  /** The source's measured true peak, dBTP. */
  truePeak: number
}

/** The limiting a gain needs, and the gain applied when that is over the allowance. */
export interface LimitingPrediction
{
  /** Peak limiting the full gain needs, dB, never below zero. */
  needed: number
  /** The gain applied: the requested gain, or less when the full gain needs more limiting than the allowance. */
  applied: number
  over: boolean
}

/** Rounds to the tenth the line shows, so the numbers in one sentence add up. */
function tenth(value: number): number
{
  return Math.round(value * 10) / 10
}

/** The peak limiting a gain needs to keep the source's true peak under the ceiling, and the gain applied. */
export function predictLimiting({ gain, ceiling, allowance, truePeak }: LimitingInput): LimitingPrediction
{
  const needed = Math.max(0, tenth(truePeak + gain - ceiling))
  const over = needed > allowance
  return { needed, applied: over ? tenth(gain - (needed - allowance)) : gain, over }
}

function db(value: number): string
{
  return `${formatNumber(value, 1)} dB`
}

function signedDb(value: number): string
{
  return `${formatSigned(value, 1)} dB`
}

function dbtp(value: number): string
{
  return `${formatNumber(value, 1)} dBTP`
}

/** The predicted peak limiting sentence for one measured source. */
export function limitingText(input: LimitingInput): string
{
  const prediction = predictLimiting(input)
  if (prediction.over)
  {
    return `Applying ${signedDb(prediction.applied)} of the requested ${signedDb(input.gain)}: the full gain needs ` +
      `${db(prediction.needed)} of peak limiting, over the ${db(input.allowance)} allowance.`
  }
  const needs = prediction.needed === 0 ? 'needs no peak limiting' : `needs about ${db(prediction.needed)} of peak limiting`
  return `Measured true peak ${dbtp(input.truePeak)}. ${signedDb(input.gain)} ${needs} to stay under the ${dbtp(input.ceiling)} ceiling.`
}

/** What the predicted peak limiting line knows about the sources: nothing yet, several sources, or one measured peak. */
export type GainPrediction =
  | { kind: 'unmeasured' }
  | { kind: 'several' }
  | { kind: 'measured'; truePeak: number }

/** Props of {@link PredictedLimiting}. */
export interface PredictedLimitingProps
{
  gain: FieldState | undefined
  ceiling: FieldState | undefined
  allowance: FieldState | undefined
  prediction: GainPrediction
  /** Measures the job now; without it the line offers no button. */
  onMeasure?: () => void
}

/** The sentence of the predicted peak limiting line, or null when a value it needs is mixed or missing. */
export function predictionText(gain: FieldState | undefined, ceiling: FieldState | undefined, allowance: FieldState | undefined,
  prediction: GainPrediction): string
{
  if (prediction.kind === 'unmeasured')
  {
    return UNMEASURED_TEXT
  }
  const values = [gain, ceiling, allowance]
  if (prediction.kind === 'several' || values.some((field) => field === undefined || field.mixed))
  {
    return SEVERAL_TEXT
  }
  return limitingText({
    gain: gain?.value as number,
    ceiling: ceiling?.value as number,
    allowance: allowance?.value as number,
    truePeak: prediction.truePeak
  })
}

/** The read-only line under Gain: the peak limiting the gain needs for the measured source, and the gain it applies. */
export function PredictedLimiting({ gain, ceiling, allowance, prediction, onMeasure }: PredictedLimitingProps): ReactElement
{
  const base = useId()
  const termId = `${base}term`
  const text = predictionText(gain, ceiling, allowance, prediction)
  return (
    <div className='flex min-w-0 flex-col' data-field='predictedLimiting'>
      <FieldCaption id={`${base}caption`}>{PREDICTED_LIMITING_LABEL}</FieldCaption>
      <p aria-labelledby={`${base}caption`} aria-describedby={termId} className='select-text text-body text-ink-2' role='status'>{text}</p>
      <span id={termId} className='sr-only'>{PEAK_LIMITING_TERM}</span>
      {prediction.kind === 'unmeasured' && onMeasure !== undefined
        ? <Button variant='ghost' size='sm' onClick={onMeasure} className='-ms-2 mt-1 self-start'>Measure now</Button>
        : null}
    </div>
  )
}

/** Props of {@link GainFields}. */
export interface GainFieldsProps extends VideoFieldsProps
{
  /** What the predicted peak limiting line knows about the selected sources. */
  prediction?: GainPrediction
  /** "Measure now" for one unmeasured job. */
  onMeasure?: () => void
}

/** The Gain fields of the Recipe tab, in dB, with the predicted peak limiting line under Gain. */
export function GainFields({ fields, onPatch, prediction = { kind: 'unmeasured' }, onMeasure }: GainFieldsProps): ReactElement
{
  const find = (key: FieldKey): FieldState | undefined => fields.find((field) => field.key === key)
  const gain = find('gain')
  const line = gain === undefined
    ? null
    : <PredictedLimiting gain={gain} ceiling={find('truePeak')} allowance={find('allowance')} prediction={prediction} onMeasure={onMeasure} />
  return (
    <div className='flex flex-col gap-6'>
      <p className='text-label text-ink-3'>{GAIN_GROUP_NOTE}</p>
      <GroupedFields fields={fields} onPatch={onPatch} groups={GAIN_GROUPS} scope='gain' more={GAIN_MORE} after={{ gain: line }} />
    </div>
  )
}
