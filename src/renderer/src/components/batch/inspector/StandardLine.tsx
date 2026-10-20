import React, { useId, useState } from 'react'
import { AUDIO_LIMITS } from '../../../../../shared/audio/limits'
import { formatNumber } from '../../../../../shared/audio/messages'
import { findLoudnessPreset, type LoudnessPreset, type StandardRef } from '../../../../../shared/audio/presets'
import { formatTarget, formatTolerance, formatTruePeak } from '../../../copy/batch'
import { Button, cx } from '../../../ui'

/** This app's loudness check per output class; a standard's own tolerance can only tighten it. */
export const APP_CHECK = { lossless: 0.5, lossy: 1 } as const

/** Where a preset's details word themselves differently from its data. */
interface Wording
{
  /** What the target measures, after its unit. */
  qualifier?: string
  /** The short name that states the editable range, as in "(s2 allows -20 to -16)". */
  range?: string
  /** Who states the tolerance and how, when it differs from the check. */
  states?: string
}

const WORDING: Readonly<Record<string, Wording>> =
{
  'atsc-a85': { states: 'A/85 anticipates' },
  'film-r128s4': { qualifier: 'program loudness' },
  'apple-podcasts': { states: 'Apple states' },
  'streaming-r128s2': { range: 's2' }
}

/** One labeled fact of a loudness preset's technical details. */
export interface StandardFact
{
  term: string
  detail: string
}

/** A loudness preset's technical details: what it follows, its labeled facts in reading order, and its sources. */
export interface StandardDetails
{
  /** The document the preset follows, or "Not a standard". */
  basis: string
  facts: StandardFact[]
  sources: readonly StandardRef[]
}

/** The terms of the facts, so a reader of one preset finds the same row in another. */
export const FACT_TERMS =
{
  loudness: 'Integrated loudness',
  peak: 'True peak',
  dynamics: 'Dynamics',
  check: 'Checked within',
  short: 'Short items',
  measured: 'Measured',
  status: 'Status'
} as const

function stated(value: number): string
{
  return formatNumber(value, 'stated', 'unicode')
}

function sentenceEnd(text: string): string
{
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** The tolerance: the check alone when the standard's tolerance is the check, else the standard's and the app's. */
function checkDetail(preset: LoudnessPreset, wording: Wording): string
{
  const own = preset.target.toleranceLu
  const unit = preset.deviationUnit
  const lossless = Math.min(own ?? Infinity, APP_CHECK.lossless)
  const lossy = Math.min(own ?? Infinity, APP_CHECK.lossy)
  if (lossless === lossy)
  {
    return formatTolerance(lossless, unit)
  }
  const lead = own === null
    ? 'No tolerance stated'
    : `${wording.states ?? `${preset.standardName as string} states`} ±${stated(own)} ${unit}`
  return `${lead}; this app checks ${formatTolerance(lossless, unit)} for lossless and ${formatTolerance(lossy, unit)} for lossy outputs`
}

function loudnessDetail(preset: LoudnessPreset, targetLufs: number, wording: Wording): string
{
  const parts = [formatTarget(targetLufs, preset.target.unit, preset.id)]
  if (wording.qualifier !== undefined)
  {
    parts.push(` ${wording.qualifier}`)
  }
  if (wording.range !== undefined && preset.targetRange !== null)
  {
    parts.push(` (${wording.range} allows ${stated(preset.targetRange[0])} to ${stated(preset.targetRange[1])})`)
  }
  return parts.join('')
}

function peakDetail(preset: LoudnessPreset): string
{
  const louder = preset.target.louderMax
  const base = `At most ${formatTruePeak(preset.target.maxTruePeakDbtp)}`
  return louder === null
    ? base
    : `${base}, or ${formatTruePeak(louder.maxTruePeakDbtp)} for masters louder than ${stated(louder.aboveLufs)} ${preset.target.unit}`
}

function customFacts(preset: LoudnessPreset): StandardFact[]
{
  const loudness = AUDIO_LIMITS.integratedLufs
  const peak = AUDIO_LIMITS.maxTruePeakDbtp
  return [
    { term: FACT_TERMS.loudness, detail: `Your choice, ${stated(loudness.min)} to ${stated(loudness.max)} ${preset.target.unit}` },
    { term: FACT_TERMS.peak, detail: `Your choice, ${stated(peak.min)} to ${stated(peak.max)} dBTP` }
  ]
}

/**
 * The technical details of a loudness preset, built from its data; null for an id that names no loudness preset.
 * A target inside the preset's editable range replaces the preset's own target.
 */
export function standardDetails(presetId: string, targetLufs: number | null = null): StandardDetails | null
{
  const preset = findLoudnessPreset(presetId)
  if (preset === null)
  {
    return null
  }
  const basis = preset.id === 'custom' ? 'Custom' : preset.standardName ?? 'Not a standard'
  if (preset.id === 'custom')
  {
    return { basis, facts: customFacts(preset), sources: preset.sources }
  }
  const wording = WORDING[preset.id] ?? {}
  const facts: StandardFact[] = [
    { term: FACT_TERMS.loudness, detail: loudnessDetail(preset, targetLufs ?? preset.target.integratedLufs, wording) },
    { term: FACT_TERMS.peak, detail: peakDetail(preset) }
  ]
  if (preset.dynamics !== null)
  {
    const d = preset.dynamics
    const anchor = d.thresholdOffsetDb === 0 ? 'the program\'s own loudness' : `${stated(d.thresholdOffsetDb)} dB from the program's own loudness`
    facts.push({ term: FACT_TERMS.dynamics, detail: `${stated(d.ratio)}:1 above ${anchor}, ${stated(d.attackMs)} ms attack, ${stated(d.releaseMs)} ms release` })
  }
  if (preset.standard)
  {
    facts.push({ term: FACT_TERMS.check, detail: checkDetail(preset, wording) })
  }
  if (preset.shortForm !== null)
  {
    const rule = preset.shortForm
    facts.push({ term: FACT_TERMS.short, detail: `${stated(rule.autoMaxDurationSec)} s or less: short-term loudness at most ${stated(rule.maxAboveTargetLu)} LU above the target` })
  }
  if (preset.measurementNote !== null)
  {
    facts.push({ term: FACT_TERMS.measured, detail: sentenceEnd(preset.measurementNote) })
  }
  if (preset.supersededBy !== null)
  {
    const latest = preset.supersededBy.split(' and ').at(-1) as string
    facts.push({ term: FACT_TERMS.status, detail: `Superseded by ${preset.supersededBy}; these values are not verified against ${latest}.` })
  }
  return { basis, facts, sources: preset.sources }
}

export interface StandardLineProps
{
  /** The loudness preset the selected jobs share. */
  presetId: string
  /** The jobs' shared target when the preset lets it be edited; the preset's own target otherwise. */
  targetLufs?: number | null
  id?: string
  className?: string
}

/** The label of the toggle that shows a loudness preset's technical details. */
export const STANDARD_TOGGLE = 'Technical details'

/**
 * A loudness preset's technical details folded under one toggle, so the plain guidance stays first: what it follows,
 * a list of labeled facts, and the sources. The text stays in the document for find-in-page and assistive technology.
 */
export function StandardLine({ presetId, targetLufs = null, id, className }: StandardLineProps): React.JSX.Element | null
{
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const details = standardDetails(presetId, targetLufs)
  if (details === null)
  {
    return null
  }
  return (
    <div className={cx('flex flex-col items-start gap-2', className)}>
      <Button
        variant='ghost'
        size='sm'
        icon={open ? 'action.collapse' : 'action.expand'}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        className='-ms-2'
      >
        {STANDARD_TOGGLE}
      </Button>
      <div id={regionId} hidden={!open} className='w-full'>
        <div id={id} className='flex select-text flex-col gap-3 border-s border-line ps-3'>
          <p className='type-caption text-ink-2'>{details.basis}</p>
          <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-label'>
            {details.facts.map((fact) => (
              <React.Fragment key={fact.term}>
                <dt className='text-ink-3'>{fact.term}</dt>
                <dd className='text-ink tabular-nums'>{fact.detail}</dd>
              </React.Fragment>
            ))}
          </dl>
          {details.sources.length > 0 && (
            <div className='flex flex-col gap-1'>
              <p className='type-caption text-ink-3'>Sources</p>
              <ul aria-label='Sources' className='flex flex-col gap-1 text-label text-ink-3'>
                {details.sources.map((source) => (
                  <li key={`${source.url} ${source.clause}`}>
                    <a
                      href={source.url}
                      target='_blank'
                      rel='noreferrer'
                      className='text-ink-2 underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink-3'
                    >
                      {source.name}
                    </a>
                    {source.clause !== '' && <span>, {source.clause}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
