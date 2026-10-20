import type { ReactElement } from 'react'
import { formatNumber } from '../../../../../shared/audio/messages'
import { findGainPreset, findLoudnessPreset, presetName } from '../../../../../shared/audio/presets'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { AlbumSummary, BatchSummary, RecipeOutcome } from '../../../../../shared/jobs/types'
import { countOf, formatBytes, formatCount, formatLoudness, formatTarget, formatTolerance, joinList, screenMessage } from '../../../copy/batch'

type LoudnessOutcome = NonNullable<RecipeOutcome['loudness']>

/** One line of the finished summary: a recipe's measured outcome or an album's shared gain. */
export interface OutcomeLine
{
  key: string
  kind: 'recipe' | 'album'
  text: string
  /** The check the line's jobs were held to, as the line names it; null when the line carries none. */
  check: string | null
}

const OP_WORDS: Readonly<Record<RecipeOutcome['op'], string>> = {
  normalize: 'Normalize',
  boost: 'Gain',
  convert: 'Convert',
  compress: 'Compress',
  extract: 'Extract'
}

/** The name a recipe line uses: the preset's name when the preset is known, else the label without its operation word. */
export function recipeName(outcome: Pick<RecipeOutcome, 'op' | 'label' | 'presetId'>): string
{
  const id = outcome.presetId
  if (id !== null && (findLoudnessPreset(id) !== null || findGainPreset(id) !== null))
  {
    return presetName(id)
  }
  const lead = `${OP_WORDS[outcome.op]} · `
  return outcome.label.startsWith(lead) ? outcome.label.slice(lead.length) : outcome.label
}

function level(value: number): string
{
  return formatNumber(value, 'level', 'unicode')
}

/** The checks a recipe's jobs were held to: "±0.2 LU", or "their checks (±0.5 dB lossless, ±1.0 dB lossy)". */
export function checkPhrase(loudness: Pick<LoudnessOutcome, 'checks' | 'deviationUnit'>): string | null
{
  const checks = loudness.checks.filter((entry) => entry.jobs > 0)
  if (checks.length === 0)
  {
    return null
  }
  const values = new Set(checks.map((entry) => entry.check))
  if (values.size === 1)
  {
    return formatTolerance(checks[0].check, loudness.deviationUnit)
  }
  const ordered = [...checks].sort((a, b) => a.check - b.check)
  return `their checks (${ordered.map((entry) => `${formatTolerance(entry.check, loudness.deviationUnit)} ${entry.checkClass}`).join(', ')})`
}

function rangePhrase(loudness: LoudnessOutcome, measured: number): string | null
{
  if (loudness.minLufs === null || loudness.maxLufs === null)
  {
    return null
  }
  const span = loudness.minLufs === loudness.maxLufs
    ? formatLoudness(loudness.minLufs, loudness.unit)
    : `${level(loudness.minLufs)} to ${level(loudness.maxLufs)} ${loudness.unit}`
  return loudness.streams > measured ? `${span} across ${countOf(loudness.streams, 'stream')}` : span
}

function reachablePhrase(outcome: RecipeOutcome, loudness: LoudnessOutcome): string | null
{
  if (outcome.reachable <= 0)
  {
    return null
  }
  const levels = loudness.reachableLevels.filter((value) => Number.isFinite(value))
  const head = `${countOf(outcome.reachable, 'job')} verified at the reachable level`
  if (levels.length === 0)
  {
    return head
  }
  const low = Math.min(...levels)
  const high = Math.max(...levels)
  const value = low === high ? formatLoudness(low, loudness.unit) : `${level(low)} to ${level(high)} ${loudness.unit}`
  return `${head} (${value})`
}

function outsidePhrase(outcome: RecipeOutcome, loudness: LoudnessOutcome): string | null
{
  if (outcome.outsideTolerance <= 0)
  {
    return null
  }
  const missed = loudness.checks.filter((entry) => entry.jobs > entry.within)
  const values = [...new Set(missed.map((entry) => entry.check))]
  const head = `${countOf(outcome.outsideTolerance, 'job')} outside tolerance`
  if (values.length === 1)
  {
    return `${head} against the ${formatTolerance(values[0], loudness.deviationUnit)} check`
  }
  return values.length === 0 ? head : `${head} against their checks`
}

function sentence(parts: ReadonlyArray<string | null>): string
{
  return parts.filter((part): part is string => part !== null && part !== '').join(' ')
}

/**
 * A Normalize recipe's line: "Apple Podcasts, −16 LKFS: 9 verified within their checks (±0.5 dB lossless, ±1.0 dB
 * lossy), −16.2 to −15.9 LKFS. Highest true peak −1.6 dBTP.", with the jobs verified at the reachable level and those
 * outside tolerance when present. Null when the recipe has no loudness outcome.
 */
export function normalizeLine(outcome: RecipeOutcome): OutcomeLine | null
{
  const loudness = outcome.loudness
  if (loudness === null)
  {
    return null
  }
  const name = recipeName(outcome)
  const head = loudness.targetLufs === null ? name : `${name}, ${formatTarget(loudness.targetLufs, loudness.unit, outcome.presetId)}`
  const check = checkPhrase(loudness)
  const measured = outcome.verified + outcome.reachable + outcome.outsideTolerance
  const range = rangePhrase(loudness, measured)
  const verified = `${formatCount(outcome.verified)} verified${check === null ? '' : ` within ${check}`}`
  const extras = [reachablePhrase(outcome, loudness), outsidePhrase(outcome, loudness)].filter((part): part is string => part !== null)
  const peak = loudness.maxTruePeakDbtp === null ? null : `Highest true peak ${level(loudness.maxTruePeakDbtp)} dBTP.`
  return {
    key: `recipe:${outcome.label}`,
    kind: 'recipe',
    text: sentence([
      `${head}: ${range === null ? verified : `${verified}, ${range}`}.`,
      extras.length === 0 ? null : `${joinList(extras)}.`,
      peak
    ]),
    check
  }
}

/** A Gain recipe's line: "Gain · Louder: 4 verified; peak limiting on 1 job, at most 1.8 dB." */
export function gainLine(outcome: RecipeOutcome): OutcomeLine
{
  const loudness = outcome.loudness
  const check = loudness === null ? null : checkPhrase(loudness)
  const verified = `${formatCount(outcome.verified)} verified${check === null ? '' : ` within ${check}`}`
  const limited = loudness !== null && loudness.limitedJobs > 0
    ? `; peak limiting on ${countOf(loudness.limitedJobs, 'job')}${loudness.maxLimitingDb === null ? '' : `, at most ${formatNumber(loudness.maxLimitingDb, 'amount', 'unicode')} dB`}`
    : ''
  return {
    key: `recipe:${outcome.label}`,
    kind: 'recipe',
    text: `Gain · ${recipeName(outcome)}: ${verified}${limited}.`,
    check
  }
}

/** A Compress recipe's line for a size target: "Compress · Target 25 MB: 2 of 2 at or under 25 MB." Null for quality presets. */
export function compressLine(outcome: RecipeOutcome): OutcomeLine | null
{
  const size = outcome.size
  if (size === null)
  {
    return null
  }
  const target = formatBytes(size.targetBytes)
  return {
    key: `recipe:${outcome.label}`,
    kind: 'recipe',
    text: `Compress · ${recipeName(outcome)}: ${formatCount(size.within)} of ${formatCount(size.jobs)} at or under ${target}.`,
    check: `at or under ${target}`
  }
}

/** One recipe's line by its operation; null for a recipe without a measured outcome. */
export function recipeLine(outcome: RecipeOutcome): OutcomeLine | null
{
  switch (outcome.op)
  {
    case 'normalize':
      return normalizeLine(outcome)
    case 'boost':
      return gainLine(outcome)
    case 'compress':
      return compressLine(outcome)
    default:
      return null
  }
}

/** What an album line reads besides its summary. */
export interface AlbumContext
{
  /** The album's display name; defaults to a letter by position, "A", "B". */
  albumName?: (album: AlbumSummary, index: number) => string
  /** The anchor track's file name; defaults to its catalog number. */
  nameOf?: (jobId: JobId) => string
  /** The loudness preset the album's jobs ran, which sets the unit and the basis; null when unknown. */
  presetOf?: (album: AlbumSummary) => string | null
}

/** The letter an album gets by position: A to Z, then AA. */
export function albumLetter(index: number): string
{
  let n = index
  let letters = ''
  do
  {
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return letters
}

/** An album's line, the audio `album` sentence: "Album A: one gain of −10.1 dB for 4 tracks, anchored on the loudest track, …". */
export function albumLine(album: AlbumSummary, index: number, context: AlbumContext = {}): OutcomeLine
{
  const preset = context.presetOf?.(album) ?? null
  return {
    key: `album:${album.groupId}`,
    kind: 'album',
    text: screenMessage({
      key: 'album',
      params: {
        x: context.albumName?.(album, index) ?? albumLetter(index),
        G: album.gainDb,
        n: album.members,
        name: context.nameOf?.(album.anchorJobId) ?? album.anchorJobId,
        I: album.anchorLufs,
        preset
      }
    }),
    check: null
  }
}

/** Every line a finished batch's summary shows, recipes first in main's order, then albums, as History shows them. */
export function outcomeLines(summary: Pick<BatchSummary, 'recipes' | 'albums'>, context: AlbumContext = {}): OutcomeLine[]
{
  const recipes = summary.recipes.map(recipeLine).filter((line): line is OutcomeLine => line !== null)
  return [...recipes, ...summary.albums.map((album, index) => albumLine(album, index, context))]
}

/** Props for {@link RecipeOutcomeLines}. */
export interface RecipeOutcomeLinesProps
{
  lines: readonly OutcomeLine[]
}

/** A line's name before its first colon and the facts after it; a line without a name is all facts. */
export function lineParts(text: string): { name: string | null, detail: string }
{
  const at = text.indexOf(': ')
  return at <= 0 ? { name: null, detail: text } : { name: text.slice(0, at), detail: text.slice(at + 2) }
}

/** The operation and album lines, one per item; nothing when there are none. The caller trims them to the slot's cap. */
export function RecipeOutcomeLines({ lines }: RecipeOutcomeLinesProps): ReactElement | null
{
  if (lines.length === 0)
  {
    return null
  }
  return (
    <ul data-slot-part="recipe-outcomes" className="flex flex-col gap-1.5">
      {lines.map((line) =>
      {
        const { name, detail } = lineParts(line.text)
        return (
          <li key={line.key} data-line-kind={line.kind} className="text-body tabular-nums">
            {name !== null && <span className="font-semibold text-ink">{name}</span>}
            {name !== null && <span className="text-ink-3">{': '}</span>}
            <span className="text-ink-2">{detail}</span>
          </li>
        )
      })}
    </ul>
  )
}
