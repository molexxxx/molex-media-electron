import type { ReactElement } from 'react'
import type { JobId, RunId } from '../../../../../shared/jobs/ids'
import { needsAttention, needsDecision } from '../../../../../shared/jobs/states'
import type { JobHold, JobView } from '../../../../../shared/jobs/types'
import { countOf, verbFor, warningWord } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { Icon } from '../../../ui/Icon'
import { Tooltip } from '../../../ui/Tooltip'

/** The fields the returned-job rules read; a JobView carries them. */
export type ReturnedSubject = Pick<JobView, 'id' | 'seq' | 'state' | 'acknowledged' | 'warnings' | 'error' | 'hold' | 'runId'>

/** Returned jobs that share one short reason, with what the group's controls may do. */
export interface ReasonGroup
{
  key: string
  short: string
  /** The sentence every job of the group shares; null when their sentences differ. */
  sentence: string | null
  jobIds: JobId[]
  /** Jobs of the group that still need attention. */
  attention: number
  /** The group waits for decisions, which only a decision resolves. */
  decision: boolean
}

const HOLD_SHORT: Readonly<Record<JobHold['reason'], string>> = {
  'outside-tolerance': 'Needs a decision',
  'destination-appeared': 'File appeared, needs a decision',
  'file-locked': 'File in use, needs a decision',
  'storage-unavailable': 'Needs a decision',
  'interrupted-finalize': 'Interrupted while saving'
}

const INTERRUPTED_SENTENCE = 'molexMedia closed during the run; partial files were removed.'

/**
 * Whether a job counts as returned in a finished batch: failed, interrupted, waiting for a decision, or placed
 * outside tolerance. Acknowledging a job keeps it returned.
 */
export function isReturned(job: Pick<ReturnedSubject, 'state' | 'warnings'>): boolean
{
  if (job.state === 'failed' || job.state === 'interrupted' || job.state === 'held')
  {
    return true
  }
  return job.state === 'done' && job.warnings.some((warning) => warning.code === 'outside-tolerance-placed')
}

/** A returned job's short reason and its sentence; null for a job that did not return. */
export function returnedReason(job: ReturnedSubject): { short: string; sentence: string | null; decision: boolean } | null
{
  switch (job.state)
  {
    case 'failed':
      return { short: job.error?.short ?? 'Failed', sentence: job.error?.message ?? null, decision: false }
    case 'interrupted':
      return { short: 'Interrupted', sentence: INTERRUPTED_SENTENCE, decision: false }
    case 'held':
      return { short: job.hold ? HOLD_SHORT[job.hold.reason] : 'Needs a decision', sentence: job.hold?.message ?? null, decision: true }
    case 'done':
    {
      const warning = job.warnings.find((item) => item.code === 'outside-tolerance-placed')
      return warning ? { short: warning.short || warningWord(warning.code), sentence: null, decision: false } : null
    }
    default:
      return null
  }
}

/**
 * The batch's returned jobs grouped by short reason, largest group first and then by the first job's catalog
 * order. Acknowledged jobs stay in their groups; `attention` counts those that still need it.
 */
export function reasonGroups(jobs: Iterable<ReturnedSubject>, runId: RunId | null = null): ReasonGroup[]
{
  const groups = new Map<string, ReasonGroup & { first: number; sentences: Set<string | null> }>()
  for (const job of jobs)
  {
    if (runId !== null && job.runId !== runId)
    {
      continue
    }
    const reason = returnedReason(job)
    if (reason === null)
    {
      continue
    }
    const key = `${reason.decision ? 'decision' : 'returned'}:${reason.short}`
    let group = groups.get(key)
    if (!group)
    {
      group = { key, short: reason.short, sentence: null, jobIds: [], attention: 0, decision: reason.decision, first: job.seq, sentences: new Set() }
      groups.set(key, group)
    }
    group.jobIds.push(job.id)
    group.sentences.add(reason.sentence)
    group.first = Math.min(group.first, job.seq)
    if (needsAttention(job))
    {
      group.attention += 1
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.jobIds.length - a.jobIds.length || a.first - b.first)
    .map(({ first: _first, sentences, ...group }) => ({ ...group, sentence: sentences.size === 1 ? [...sentences][0] : null }))
}

/** Every returned job of the batch, acknowledged or not, in catalog order: what "Select returned" selects. */
export function returnedIds(jobs: Iterable<ReturnedSubject>, runId: RunId | null = null): JobId[]
{
  const list: ReturnedSubject[] = []
  for (const job of jobs)
  {
    if ((runId === null || job.runId === runId) && isReturned(job))
    {
      list.push(job)
    }
  }
  return list.sort((a, b) => a.seq - b.seq).map((job) => job.id)
}

/** What "Acknowledge all" clears: every acknowledgeable job that needs attention, and the decisions it leaves. */
export interface AcknowledgeAllPlan
{
  ids: JobId[]
  decisions: number
}

/** Plans "Acknowledge all" for a batch: every job that needs attention except those waiting for a decision. */
export function acknowledgeAllPlan(jobs: Iterable<ReturnedSubject>, runId: RunId | null = null): AcknowledgeAllPlan
{
  const ids: JobId[] = []
  let decisions = 0
  for (const job of jobs)
  {
    if ((runId !== null && job.runId !== runId) || !needsAttention(job))
    {
      continue
    }
    if (needsDecision(job))
    {
      decisions += 1
    }
    else
    {
      ids.push(job.id)
    }
  }
  return { ids, decisions }
}

/** "1 job still needs a decision." */
export function decisionsRemain(decisions: number): string
{
  return `${countOf(decisions, 'job')} still ${verbFor(decisions, 'needs', 'need')} a decision.`
}

/** "Acknowledged 3 jobs. 1 job still needs a decision." */
export function acknowledgedAllText(count: number, decisions: number): string
{
  const tail = decisions > 0 ? ` ${decisionsRemain(decisions)}` : ''
  return `Acknowledged ${countOf(count, 'job')}.${tail}`
}

/** Why "Acknowledge all" is unavailable, or null when it has jobs to acknowledge. */
export function acknowledgeAllReason(plan: AcknowledgeAllPlan): string | null
{
  if (plan.ids.length > 0)
  {
    return null
  }
  return plan.decisions > 0 ? `Nothing left to acknowledge. ${decisionsRemain(plan.decisions)}` : 'Nothing left to acknowledge.'
}

/** The text of a group: "Decode failed: FFmpeg could not decode the source." or the short reason alone. */
export function groupText(group: Pick<ReasonGroup, 'short' | 'sentence'>): string
{
  return group.sentence === null ? group.short : `${group.short}: ${group.sentence}`
}

/** The returned heading's text. */
export const RETURNED_HEADING = 'Needs attention'

/** What the heading says under it: returned jobs stay marked until acknowledged. */
export const RETURNED_NOTE = 'Returned jobs stay marked until you acknowledge them.'

/** Props for {@link ReasonGroups}. */
export interface ReasonGroupsProps
{
  groups: readonly ReasonGroup[]
  /** Every returned job of the batch, for "Select returned". */
  returned: readonly JobId[]
  acknowledgePlan: AcknowledgeAllPlan
  onSelect: (ids: readonly JobId[]) => void
  onRetry: (ids: readonly JobId[]) => void
  onEditAndRetry: (ids: readonly JobId[]) => void
  onAcknowledgeAll: () => void
  /** The result of the last "Acknowledge all", read out politely. */
  acknowledgedText?: string | null
}

/**
 * Returned jobs grouped by reason, each group with its text, its count, and "Retry these", "Edit and retry", and
 * "Select"; a group of decisions offers "Select" only, since a decision resolves it. The heading carries "Select
 * returned" and "Acknowledge all". Renders nothing when no job returned.
 */
export function ReasonGroups({
  groups,
  returned,
  acknowledgePlan,
  onSelect,
  onRetry,
  onEditAndRetry,
  onAcknowledgeAll,
  acknowledgedText = null
}: ReasonGroupsProps): ReactElement | null
{
  if (groups.length === 0)
  {
    return null
  }
  const ackReason = acknowledgeAllReason(acknowledgePlan)
  return (
    <section data-slot-part="reason-groups" aria-label="Returned jobs" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="type-legend text-error">{RETURNED_HEADING}</p>
          <p className="text-label text-ink-3">{RETURNED_NOTE}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => onSelect(returned)}>Select returned</Button>
          <Button size="sm" variant="secondary" unavailableReason={ackReason ?? undefined} onClick={onAcknowledgeAll}>Acknowledge all</Button>
        </div>
      </div>
      <p role="status" className="text-label text-ink-2 empty:hidden">{acknowledgedText}</p>
      <ul className="flex flex-col rounded-sm border border-line">
        {groups.map((group) => (
          <li
            key={group.key}
            data-reason={group.short}
            data-decision={group.decision ? '' : undefined}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-line px-3 py-2 first:border-t-0"
          >
            <span className={group.decision ? 'flex text-warning' : 'flex text-error'}>
              <Icon name={group.decision ? 'status.warning' : 'status.failed'} size="sm" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-body text-ink">
                {group.short}
                <span className="ms-2 text-label text-ink-3 tabular-nums">{countOf(group.jobIds.length, 'job')}</span>
              </span>
              {group.sentence !== null && (
                <Tooltip content={group.sentence} mode="label">
                  <span className="truncate text-label text-ink-3" data-part="reason-detail">{group.sentence}</span>
                </Tooltip>
              )}
            </span>
            <span className="flex flex-wrap justify-end gap-1.5">
              {group.decision
                ? null
                : (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => onRetry(group.jobIds)}>Retry these</Button>
                    <Button size="sm" variant="ghost" onClick={() => onEditAndRetry(group.jobIds)}>Edit and retry</Button>
                  </>
                )}
              <Button size="sm" variant="ghost" onClick={() => onSelect(group.jobIds)}>Select</Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
