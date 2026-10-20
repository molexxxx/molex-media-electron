import { useRef, useState, type ReactElement } from 'react'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { BatchPolicy, BatchSummary } from '../../../../../shared/jobs/types'
import { PART_SEPARATOR, batchLabel, formatBytes, formatCount, formatDuration, formatElapsed, formatSizeChange } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { RecipeOutcomeLines, outcomeLines, type AlbumContext } from './RecipeOutcomeLines'
import
{
  ReasonGroups,
  acknowledgeAllPlan,
  acknowledgedAllText,
  reasonGroups,
  returnedIds,
  type ReturnedSubject
} from './ReasonGroups'

type SummaryCounts = BatchSummary['counts']

/** The ink of each count's number: verified lights green, a returned job red, and a count of zero recedes. */
const COUNT_INK: Readonly<Record<OutcomeCount['key'], (value: number) => string>> = {
  verified: (value) => value > 0 ? 'text-verified' : 'text-ink-3',
  returned: (value) => value > 0 ? 'text-error' : 'text-ink-3',
  canceled: (value) => value > 0 ? 'text-ink' : 'text-ink-3',
  skipped: (value) => value > 0 ? 'text-ink' : 'text-ink-3'
}

/** One outcome count as the summary shows it: the display number, its word, and the breakdown under it. */
export interface OutcomeCount
{
  key: 'verified' | 'returned' | 'canceled' | 'skipped'
  value: number
  word: string
  detail: string | null
}

/** "1 failed · 1 outside tolerance", with interrupted jobs and decisions when present; null when nothing returned. */
export function returnedBreakdown(counts: SummaryCounts): string | null
{
  if (counts.returned <= 0)
  {
    return null
  }
  const parts: string[] = []
  if (counts.failed > 0)
  {
    parts.push(`${formatCount(counts.failed)} failed`)
  }
  if (counts.outsideTolerance > 0)
  {
    parts.push(`${formatCount(counts.outsideTolerance)} outside tolerance`)
  }
  if (counts.interrupted > 0)
  {
    parts.push(`${formatCount(counts.interrupted)} interrupted`)
  }
  if (counts.held > 0)
  {
    parts.push(`${formatCount(counts.held)} waiting for a decision`)
  }
  return parts.length === 0 ? null : parts.join(PART_SEPARATOR)
}

/**
 * The batch's outcome counts: verified, returned, and canceled, then skipped when any. They read main's summary,
 * so acknowledged jobs keep counting; only the header's attention count drops as jobs are acknowledged.
 */
export function outcomeCounts(counts: SummaryCounts): OutcomeCount[]
{
  const list: OutcomeCount[] = [
    { key: 'verified', value: counts.verified, word: 'verified', detail: null },
    { key: 'returned', value: counts.returned, word: 'returned', detail: returnedBreakdown(counts) },
    { key: 'canceled', value: counts.canceled, word: 'canceled', detail: null }
  ]
  if (counts.skipped > 0)
  {
    list.push({ key: 'skipped', value: counts.skipped, word: 'skipped', detail: null })
  }
  return list
}

/** "25.8 GB in · 21.4 GB out (−17%) · 9 h 49 min of media in 42 min 10 s" */
export function sizesLine(summary: Pick<BatchSummary, 'bytes' | 'mediaSec' | 'elapsedMs'>): string
{
  const { input, output } = summary.bytes
  const change = input > 0 ? ` (${formatSizeChange(output, input)})` : ''
  return [
    `${formatBytes(input)} in`,
    `${formatBytes(output)} out${change}`,
    `${formatDuration(summary.mediaSec)} of media in ${formatElapsed(summary.elapsedMs)}`
  ].join(PART_SEPARATOR)
}

/** Where new jobs write once Replace originals ended, as the Replace ended line says it: "write to D:\Exports". */
export function newJobsPolicy(policy: BatchPolicy): string
{
  return policy.destination.mode === 'folder' ? `write to ${policy.destination.folder}` : 'write next to each source'
}

/** "Replace originals ended with Batch 31. New jobs write to D:\Exports." Null unless the batch replaced originals. */
export function replaceEndedLine(summary: Pick<BatchSummary, 'runId' | 'policy'>, current: BatchPolicy | null): string | null
{
  if (summary.policy.destination.mode !== 'replace-originals')
  {
    return null
  }
  const lead = `Replace originals ended with ${batchLabel(summary.runId)}.`
  return current === null ? lead : `${lead} New jobs ${newJobsPolicy(current)}.`
}

/** The next-batch line. */
export const NEXT_BATCH_LINE = 'Next batch: add files, then Review and Start.'

/** "Clear done (19)". */
export function clearDoneLabel(count: number): string
{
  return `Clear done (${formatCount(count)})`
}

/** "Show 3 more". */
export function showMoreLabel(count: number): string
{
  return `Show ${formatCount(count)} more`
}

/** Props for {@link FinishedSummary}. */
export interface FinishedSummaryProps
{
  summary: BatchSummary
  /** The batch's jobs in their current states, for the reason groups and "Acknowledge all". */
  jobs: readonly ReturnedSubject[]
  /** The policy in effect now, which the Replace ended line names for new jobs. */
  currentPolicy?: BatchPolicy | null
  albums?: AlbumContext
  /** Recipe lines and reason groups share this many lines; the rest sit behind "Show {n} more". */
  limit?: number
  /** Verified jobs and acknowledged warnings "Clear done" would remove; null hides the next-batch line. */
  clearDone?: number | null
  onSelect: (ids: readonly JobId[]) => void
  onRetry: (ids: readonly JobId[]) => void
  onEditAndRetry: (ids: readonly JobId[]) => void
  onAcknowledgeAll: (ids: readonly JobId[]) => void
  onChangeOutput?: () => void
  onAddFiles?: () => void
  onClearDone?: () => void
}

/**
 * A finished batch's summary: the outcome counts as display numbers with the returned breakdown, sizes and
 * times, the Replace ended line, one line per measured recipe and album, returned jobs grouped by reason, and the
 * next-batch line. "Acknowledge all" acknowledges every job that needs attention except decisions, says how many
 * remain, and moves focus to the summary heading.
 */
export function FinishedSummary({
  summary,
  jobs,
  currentPolicy = null,
  albums,
  limit = Number.POSITIVE_INFINITY,
  clearDone = null,
  onSelect,
  onRetry,
  onEditAndRetry,
  onAcknowledgeAll,
  onChangeOutput,
  onAddFiles,
  onClearDone
}: FinishedSummaryProps): ReactElement
{
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [acknowledged, setAcknowledged] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const lines = outcomeLines(summary, albums)
  const groups = reasonGroups(jobs, summary.runId)
  const plan = acknowledgeAllPlan(jobs, summary.runId)
  const replaceEnded = replaceEndedLine(summary, currentPolicy)
  const total = lines.length + groups.length
  const cap = expanded ? Number.POSITIVE_INFINITY : Math.max(0, limit)
  const shownLines = lines.slice(0, cap)
  const shownGroups = groups.slice(0, Math.max(0, cap - shownLines.length))
  const hidden = total - shownLines.length - shownGroups.length

  const acknowledgeAll = (): void =>
  {
    if (plan.ids.length === 0)
    {
      return
    }
    onAcknowledgeAll(plan.ids)
    setAcknowledged(acknowledgedAllText(plan.ids.length, plan.decisions))
    headingRef.current?.focus()
  }

  return (
    <section data-slot-part="finished-summary" aria-labelledby={`summary-${summary.runId}`} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2
          id={`summary-${summary.runId}`}
          ref={headingRef}
          tabIndex={-1}
          className="flex flex-wrap items-start gap-x-8 gap-y-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {outcomeCounts(summary.counts).map((count) => (
            <span key={count.key} data-count={count.key} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className={cx('font-display text-display leading-none font-semibold tabular-nums', COUNT_INK[count.key](count.value))}>{formatCount(count.value)}</span>
                <span className="text-body font-normal text-ink-2">{count.word}</span>
              </span>
              {count.detail === null ? null : <span className="text-label font-normal text-ink-3">{count.detail}</span>}
            </span>
          ))}
        </h2>
        <p className="text-label text-ink-3 tabular-nums">{sizesLine(summary)}</p>
      </div>
      {replaceEnded === null
        ? null
        : (
          <div data-line="replace-ended" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-body text-ink">{replaceEnded}</p>
            {onChangeOutput ? <Button size="sm" variant="secondary" onClick={onChangeOutput}>Change output</Button> : null}
          </div>
        )}
      <RecipeOutcomeLines lines={shownLines} />
      <ReasonGroups
        groups={shownGroups}
        returned={returnedIds(jobs, summary.runId)}
        acknowledgePlan={plan}
        onSelect={onSelect}
        onRetry={onRetry}
        onEditAndRetry={onEditAndRetry}
        onAcknowledgeAll={acknowledgeAll}
        acknowledgedText={acknowledged}
      />
      {hidden > 0 || (expanded && total > limit)
        ? (
          <div>
            <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show fewer' : showMoreLabel(hidden)}
            </Button>
          </div>
        )
        : null}
      {clearDone === null
        ? null
        : (
          <div data-line="next-batch" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-3">
            <p className="text-body text-ink-2">{NEXT_BATCH_LINE}</p>
            <span className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" icon="action.addFiles" onClick={() => onAddFiles?.()}>Add files</Button>
              {clearDone > 0 ? <Button size="sm" variant="ghost" onClick={() => onClearDone?.()}>{clearDoneLabel(clearDone)}</Button> : null}
            </span>
          </div>
        )}
    </section>
  )
}

