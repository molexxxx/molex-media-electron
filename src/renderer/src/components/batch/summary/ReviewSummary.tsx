import { useId, useRef, type ReactElement, type Ref, type RefObject } from 'react'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { BatchPolicy, PlanFix, PreflightReport, VolumeReport } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { countOf, formatBytes, formatCount, verbFor } from '../../../copy/batch'
import type { ReviewCounts } from '../../../stores/batchView'
import { Button } from '../../../ui/Button'
import
{
  AcknowledgmentCheck,
  binName,
  needsAcknowledgment,
  originalsByVolume,
  volumeName,
  volumeOf,
  type AcknowledgmentFacts
} from './AcknowledgmentCheck'
import { IssueGroups, groupIssues, type IssueActionId } from './IssueGroup'

type ReportJob = PreflightReport['jobs'][number]

/** How a report's jobs stand: ready ones without warnings, ready ones with warnings, skipped, and blocked. */
export interface ReviewTally
{
  total: number
  ready: number
  warnings: number
  willSkip: number
  blocked: number
}

/** Counts the report's jobs by how they stand; a ready job with a warning-level issue counts as "with warnings". */
export function reviewTally(jobs: readonly ReportJob[]): ReviewTally
{
  const tally: ReviewTally = { total: jobs.length, ready: 0, warnings: 0, willSkip: 0, blocked: 0 }
  for (const job of jobs)
  {
    if (job.status === 'blocked')
    {
      tally.blocked += 1
    }
    else if (job.status === 'will-skip')
    {
      tally.willSkip += 1
    }
    else if (job.issues.some((issue) => issue.severity === 'warning'))
    {
      tally.warnings += 1
    }
    else
    {
      tally.ready += 1
    }
  }
  return tally
}

/** "22 jobs: 18 ready, 3 with warnings, 1 blocked.", naming skipped jobs before the blocked ones when there are any. */
export function reviewCountsLine(tally: ReviewTally): string
{
  const parts = [`${formatCount(tally.ready)} ready`, `${formatCount(tally.warnings)} with warnings`]
  if (tally.willSkip > 0)
  {
    parts.push(`${formatCount(tally.willSkip)} will skip`)
  }
  parts.push(`${formatCount(tally.blocked)} blocked`)
  return `${countOf(tally.total, 'job')}: ${parts.join(', ')}.`
}

/** "Measuring loudness: 6 of 15 jobs." */
export function measuringLine(done: number, total: number): string
{
  return `Measuring loudness: ${formatCount(done)} of ${countOf(total, 'job')}.`
}

/** What "Stop measuring" announces and leaves in the summary. */
export const MEASURING_STOPPED = 'Measuring stopped.'

/** The summary line while a folder scan still adds rows Start will not include. */
export const SCAN_ADDING_LINE = 'A folder scan is still adding files; they wait for the next Review.'

/** "Plan for 8 selected jobs" */
export function subsetLine(count: number): string
{
  return `Plan for ${countOf(count, 'selected job')}`
}

/** "Back to all 22" */
export function backToAllLabel(total: number): string
{
  return `Back to all ${formatCount(total)}`
}

/** Why Start came back stale: the user's own edit of a field, or sources that changed on disk. */
export type ReviewStale =
  | { kind: 'edited', field: string, count: number }
  | { kind: 'sources', count: number }

/** "Target, integrated changed for 8 jobs. Review them, then Start again." or "2 sources changed since this review." */
export function staleLine(stale: ReviewStale): string
{
  if (stale.kind === 'sources')
  {
    return `${countOf(stale.count, 'source')} changed since this review.`
  }
  return `${stale.field} changed for ${countOf(stale.count, 'job')}. Review ${verbFor(stale.count, 'it', 'them')}, then Start again.`
}

interface VolumeShare
{
  volume: string
  count: number
  bytes: number
  known: number
}

function shares(jobs: readonly ReportJob[], pathOf: (job: ReportJob) => string, volumes: readonly VolumeReport[]): VolumeShare[]
{
  const byVolume = new Map<string, VolumeShare>()
  for (const job of jobs)
  {
    const volume = volumeOf(pathOf(job), volumes)
    const share = byVolume.get(volume) ?? { volume, count: 0, bytes: 0, known: 0 }
    share.count += 1
    const bytes = job.plan?.estimate.outputBytes ?? null
    if (bytes !== null)
    {
      share.bytes += bytes
      share.known += 1
    }
    byVolume.set(volume, share)
  }
  return [...byVolume.values()]
}

function freeOn(volume: string, volumes: readonly VolumeReport[]): number | null
{
  return volumes.find((entry) => volumeName(entry.volume) === volume)?.freeBytes ?? null
}

function aboutSize(list: readonly VolumeShare[]): string
{
  const known = list.reduce((sum, share) => sum + share.known, 0)
  return known === 0 ? '' : `, about ${formatBytes(list.reduce((sum, share) => sum + share.bytes, 0))}`
}

function perVolume(list: readonly VolumeShare[], volumes: readonly VolumeReport[]): string
{
  return list.map((share) =>
  {
    const free = freeOn(share.volume, volumes)
    const detail = [share.known > 0 ? formatBytes(share.bytes) : null, free === null ? null : `${formatBytes(free)} free`].filter((part) => part !== null)
    return `${formatCount(share.count)} on ${share.volume}${detail.length === 0 ? '' : ` (${detail.join(', ')})`}`
  }).join(', ')
}

function unknownSizes(list: readonly VolumeShare[]): string | null
{
  const unknown = list.reduce((sum, share) => sum + share.count - share.known, 0)
  return unknown === 0 ? null : `Size unknown for ${countOf(unknown, 'job')}.`
}

function withUnknown(line: string, list: readonly VolumeShare[]): string
{
  const unknown = unknownSizes(list)
  return unknown === null ? line : `${line} ${unknown}`
}

function writesLine(writers: readonly ReportJob[], destination: BatchPolicy['destination'], volumes: readonly VolumeReport[]): string
{
  const list = shares(writers, (job) => (job.plan as NonNullable<ReportJob['plan']>).output.finalPath, volumes)
  const files = countOf(writers.length, 'new file')
  if (writers.length === 0)
  {
    return 'Writes no new files.'
  }
  if (list.length > 1)
  {
    return withUnknown(`Writes ${files}: ${perVolume(list, volumes)}.`, list)
  }
  if (destination.mode === 'folder')
  {
    const free = freeOn(list[0].volume, volumes)
    const freeText = free === null ? '' : ` ${formatBytes(free)} free on ${list[0].volume}.`
    return withUnknown(`Writes ${files} to ${destination.folder}${aboutSize(list)}.${freeText}`, list)
  }
  return withUnknown(`Writes ${files} next to their sources${aboutSize(list)}.`, list)
}

function replacesLine(replacing: readonly ReportJob[], extracts: number, volumes: readonly VolumeReport[]): string
{
  const list = shares(replacing, (job) => (job.plan as NonNullable<ReportJob['plan']>).source.path, volumes)
  const originals = countOf(replacing.length, 'original')
  let line: string
  if (list.length > 1)
  {
    line = `Replaces ${originals} in place: ${perVolume(list, volumes)}.`
  }
  else
  {
    const free = freeOn(list[0].volume, volumes)
    line = `Replaces ${originals} in place${aboutSize(list)}${free === null ? '' : `; ${formatBytes(free)} free on ${list[0].volume}`}.`
  }
  if (extracts > 0)
  {
    line = `${line} ${countOf(extracts, 'extract job')} ${verbFor(extracts, 'writes beside its source', 'write beside their sources')}.`
  }
  return withUnknown(line, list)
}

function existingLine(report: PreflightReport, writers: readonly ReportJob[], keepOld: boolean, platform: Platform): string
{
  const overwrites = report.counts.overwrites
  if (overwrites > 0)
  {
    const fate = keepOld
      ? `${verbFor(overwrites, 'stays', 'stay')} as name (previous).ext`
      : `${verbFor(overwrites, 'goes', 'go')} to ${binName(platform)}`
    return `Existing files: ${formatCount(overwrites)} ${fate} and ${verbFor(overwrites, 'is', 'are')} replaced.`
  }
  const skipped = report.jobs.filter((job) => job.status === 'will-skip').length
  if (skipped > 0)
  {
    return `Existing files: ${formatCount(skipped)} skipped; ${verbFor(skipped, 'that job', 'those jobs')} will not run.`
  }
  const kept = writers.filter((job) => job.plan?.output.conflict === 'exists' && job.plan.output.resolution === 'rename').length
  if (kept > 0)
  {
    return `Existing files: ${formatCount(kept)} kept; ${verbFor(kept, 'the new file is', 'the new files are')} numbered (2).`
  }
  return 'Existing files: none replaced.'
}

/** What the consequence lines read from outside the report. */
export interface ConsequenceContext
{
  destination: BatchPolicy['destination']
  /** "Keep old files beside the new ones". */
  keepOld: boolean
  platform: Platform
}

/**
 * The consequences of starting the report: where the new files go with their size and the free space per volume
 * (or, under Replace originals, the originals replaced in place and the extract jobs that write beside them), what
 * happens to originals, and what happens to files already at the output paths. Sizes say "about" and leave out jobs
 * whose size cannot be predicted, which are counted instead.
 */
export function consequenceLines(report: PreflightReport, context: ConsequenceContext): string[]
{
  const writers = report.jobs.filter((job) => job.status === 'ready' && job.plan !== null)
  const lines: string[] = []
  if (context.destination.mode === 'replace-originals')
  {
    const replacing = writers.filter((job) => job.plan?.output.resolution === 'replace-original')
    const extracts = writers.filter((job) => job.issues.some((issue) => issue.code === 'extract-never-replaces')).length
    lines.push(replacing.length > 0 ? replacesLine(replacing, extracts, report.volumes) : 'Originals: not touched.')
  }
  else
  {
    lines.push(writesLine(writers, context.destination, report.volumes))
    lines.push('Originals: not touched.')
  }
  lines.push(existingLine(report, writers, context.keepOld, context.platform))
  return lines
}

/** The acknowledgment's facts for a report: the session's counts when it holds them, the report's otherwise. */
export function reviewAcknowledgmentFacts(report: PreflightReport, counts: ReviewCounts | null, keepOld: boolean, platform: Platform): AcknowledgmentFacts
{
  return {
    originals: counts?.originalsAffected ?? report.counts.originalsAffected,
    overwrites: counts?.overwrites ?? report.counts.overwrites,
    originalsByVolume: originalsByVolume(report),
    keepOld,
    platform
  }
}

/** The Review session's side of the acknowledgment, which the view store owns. */
export interface ReviewAcknowledgment
{
  checked: boolean
  notice: string | null
  /** The counts the session holds and Start sends; they equal the latest report's. */
  counts: ReviewCounts | null
  onChange: (checked: boolean) => void
  ref?: Ref<HTMLInputElement>
}

/** Loudness measured as Review opened. */
export interface ReviewMeasuring
{
  done: number
  total: number
  stopped?: boolean
}

/** Props for {@link ReviewSummary}. */
export interface ReviewSummaryProps
{
  report: PreflightReport
  policy: Pick<BatchPolicy, 'destination' | 'displaced'>
  platform: Platform
  acknowledgment: ReviewAcknowledgment
  measuring?: ReviewMeasuring | null
  onStopMeasuring?: () => void
  /** "Start only the {k} selected jobs": the report is the subset's, and `total` is every job Review shows. */
  subset?: { count: number, total: number } | null
  onBackToAll?: () => void
  scanRunning?: boolean
  stale?: ReviewStale | null
  /** "Hide summary": only the count line stays, with the acknowledgment whenever it is needed. */
  collapsed?: boolean
  /** How many issue groups show before "Show {n} more issues". */
  groupLimit?: number
  headingRef?: RefObject<HTMLHeadingElement | null>
  onSelect: (ids: readonly JobId[]) => void
  onFix: (fix: PlanFix, ids: readonly JobId[]) => void
  onAction?: (action: IssueActionId, ids: readonly JobId[]) => void
  onAnnounce?: (message: string) => void
}

/**
 * The Review summary, always in this order: the count sentence with measurement progress, the consequences, the
 * acknowledgment when anything is destructive, then the issue groups. Collapsed, it keeps the count sentence and
 * the acknowledgment, so the checkbox that gates Start is never hidden.
 */
export function ReviewSummary({
  report,
  policy,
  platform,
  acknowledgment,
  measuring = null,
  onStopMeasuring,
  subset = null,
  onBackToAll,
  scanRunning = false,
  stale = null,
  collapsed = false,
  groupLimit = 3,
  headingRef,
  onSelect,
  onFix,
  onAction,
  onAnnounce
}: ReviewSummaryProps): ReactElement
{
  const headingId = useId()
  const ownHeading = useRef<HTMLHeadingElement>(null)
  const heading = headingRef ?? ownHeading
  const keepOld = policy.displaced === 'keep'
  const facts = reviewAcknowledgmentFacts(report, acknowledgment.counts, keepOld, platform)
  const tally = reviewTally(report.jobs)

  const stopMeasuring = (): void =>
  {
    onStopMeasuring?.()
    heading.current?.focus()
    onAnnounce?.(MEASURING_STOPPED)
  }

  return (
    <section data-slot-part="review-summary" aria-labelledby={headingId} className="flex flex-col gap-2">
      {subset === null || collapsed
        ? null
        : (
          <div data-line="subset" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-body text-ink">{subsetLine(subset.count)}</p>
            <Button size="sm" variant="ghost" onClick={() => onBackToAll?.()}>{backToAllLabel(subset.total)}</Button>
          </div>
        )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="text-body font-normal text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {reviewCountsLine(tally)}
        </h2>
        {measuring === null
          ? null
          : measuring.stopped
            ? <p data-line="measuring" className="text-body text-ink-2">{MEASURING_STOPPED}</p>
            : (
              <span data-line="measuring" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-body text-ink-2 tabular-nums">{measuringLine(measuring.done, measuring.total)}</span>
                <Button size="sm" variant="ghost" onClick={stopMeasuring}>Stop measuring</Button>
              </span>
            )}
      </div>
      {collapsed
        ? null
        : (
          <>
            {stale === null ? null : <p data-line="stale" className="text-body text-warning">{staleLine(stale)}</p>}
            {scanRunning ? <p data-line="scan" className="text-body text-ink-2">{SCAN_ADDING_LINE}</p> : null}
            {consequenceLines(report, { destination: policy.destination, keepOld, platform }).map((line) => (
              <p key={line} data-line="consequence" className="text-body text-ink">{line}</p>
            ))}
          </>
        )}
      {needsAcknowledgment(facts)
        ? (
          <AcknowledgmentCheck
            ref={acknowledgment.ref}
            facts={facts}
            volumes={report.volumes}
            checked={acknowledgment.checked}
            notice={acknowledgment.notice}
            onChange={acknowledgment.onChange}
          />
        )
        : null}
      {collapsed
        ? null
        : (
          <IssueGroups
            groups={groupIssues(report.jobs)}
            limit={groupLimit}
            headingRef={heading}
            onSelect={onSelect}
            onFix={onFix}
            onAction={onAction}
            onAnnounce={onAnnounce}
          />
        )}
    </section>
  )
}
