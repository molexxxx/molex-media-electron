import React, { useId, useState } from 'react'
import { AUDIO_LIMITS } from '../../../../../shared/audio/limits'
import { formatNumber } from '../../../../../shared/audio/messages'
import { findLoudnessPreset, type LoudnessPreset, type StandardRef } from '../../../../../shared/audio/presets'
import { formatTarget, formatTolerance, formatTruePeak } from '../../../copy/batch'
import { Button, cx } from '../../../ui'

/** This app's loudness check per output class; a standard's own tolerance can only tighten it. */
export const APP_CHECK = { lossless: 0.5, lossy: 1 } as const

/** Where a preset's standard line words itself differently from its data. */
interface Wording
{
  /** The name the line opens with, when it differs from the standard's name. */
  name?: string
  /** What the target measures, after its unit. */
  qualifier?: string
  /** The short name that states the editable range, as in "(s2 allows -20 to -16)". */
  range?: string
  /** The verb phrase that opens the check, when the standard's tolerance is the check. */
  checked?: string
  /** Who states the tolerance and how, when it differs from the check. */
  states?: string
}

const WORDING: Readonly<Record<string, Wording>> =
{
  'ebu-r128': { checked: 'Files are normalized to the target and checked' },
  'atsc-a85': { states: 'A/85 anticipates' },
  'film-r128s4': { qualifier: 'program loudness' },
  'apple-podcasts': { states: 'Apple states' },
  'spotify': { name: 'Spotify reference' },
  'streaming-r128s2': { range: 's2' },
  'aes-streaming': { name: 'AES TD1004 (2015)' }
}

/** The parts of a standard line, in reading order. */
export interface StandardLineText
{
  /** The standard's name, target, and true-peak maximum, then its tolerance and this app's check. */
  sentence: string
  /** The successors of a superseded preset and what was not verified against them. */
  superseded: string | null
  /** How the preset measures, when its data says. */
  note: string | null
  sources: readonly StandardRef[]
}

function stated(value: number): string
{
  return formatNumber(value, 'stated', 'unicode')
}

function sentenceEnd(text: string): string
{
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** The tolerance clause: the check alone when the standard's tolerance is the check, else both. */
function checkClause(preset: LoudnessPreset, wording: Wording): string
{
  const own = preset.target.toleranceLu
  const unit = preset.deviationUnit
  const lossless = Math.min(own ?? Infinity, APP_CHECK.lossless)
  const lossy = Math.min(own ?? Infinity, APP_CHECK.lossy)
  if (lossless === lossy)
  {
    return `${wording.checked ?? 'Checked'} within ${formatTolerance(lossless, unit)}.`
  }
  const lead = own === null
    ? 'No tolerance stated'
    : `${wording.states ?? `${preset.standardName as string} states`} ±${stated(own)} ${unit}`
  return `${lead}; this app checks within ${formatTolerance(lossless, unit)} for lossless and ` +
    `${formatTolerance(lossy, unit)} for lossy outputs.`
}

function presetSentence(preset: LoudnessPreset, targetLufs: number): string
{
  const wording = WORDING[preset.id] ?? {}
  if (preset.id === 'custom')
  {
    const loudness = AUDIO_LIMITS.integratedLufs
    const peak = AUDIO_LIMITS.maxTruePeakDbtp
    return `Custom: integrated ${stated(loudness.min)} to ${stated(loudness.max)} ${preset.target.unit}, ` +
      `true peak ${stated(peak.min)} to ${stated(peak.max)} dBTP.`
  }
  const name = wording.name ?? preset.standardName ?? 'Not a standard'
  const parts = [formatTarget(targetLufs, preset.target.unit, preset.id)]
  if (wording.qualifier !== undefined)
  {
    parts.push(` ${wording.qualifier}`)
  }
  if (preset.dynamics !== null)
  {
    parts.push(' after reducing dynamics')
  }
  if (wording.range !== undefined && preset.targetRange !== null)
  {
    parts.push(` (${wording.range} allows ${stated(preset.targetRange[0])} to ${stated(preset.targetRange[1])})`)
  }
  const head = `${name}: ${parts.join('')}, true peak at most ${formatTruePeak(preset.target.maxTruePeakDbtp)}.`
  return preset.standard ? `${head} ${checkClause(preset, wording)}` : head
}

function supersededText(preset: LoudnessPreset): string | null
{
  if (preset.supersededBy === null)
  {
    return null
  }
  const latest = preset.supersededBy.split(' and ').at(-1) as string
  return `Superseded by ${preset.supersededBy}; these values are not verified against ${latest}.`
}

/**
 * The standard line of a loudness preset, built from its data; null for an id that names no loudness preset.
 * A target inside the preset's editable range replaces the preset's own target.
 */
export function standardLineText(presetId: string, targetLufs: number | null = null): StandardLineText | null
{
  const preset = findLoudnessPreset(presetId)
  if (preset === null)
  {
    return null
  }
  return {
    sentence: presetSentence(preset, targetLufs ?? preset.target.integratedLufs),
    superseded: supersededText(preset),
    note: preset.measurementNote === null ? null : sentenceEnd(preset.measurementNote),
    sources: preset.sources
  }
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

/** The label of the toggle that shows a loudness preset's standard and sources. */
export const STANDARD_TOGGLE = 'About this standard'

/**
 * A loudness preset's standard, its check, and its sources, folded under one toggle below the Preset select so the
 * fields stay first; the text stays in the document for find-in-page and assistive technology.
 */
export function StandardLine({ presetId, targetLufs = null, id, className }: StandardLineProps): React.JSX.Element | null
{
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const text = standardLineText(presetId, targetLufs)
  if (text === null)
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
        <div id={id} className='flex select-text flex-col gap-1.5 text-label text-ink-2'>
          <p>{text.sentence}</p>
          {text.superseded !== null && <p>{text.superseded}</p>}
          {text.note !== null && <p>{text.note}</p>}
          {text.sources.length > 0 && (
            <ul aria-label='Sources' className='flex flex-col gap-0.5 text-ink-3'>
              {text.sources.map((source) => (
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
          )}
        </div>
      </div>
    </div>
  )
}
