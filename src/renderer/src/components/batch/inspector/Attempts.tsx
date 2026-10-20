import React, { useId } from 'react'
import { batchLabel, formatDay, formatTimeOfDay, PART_SEPARATOR } from '../../../copy/batch'
import type { AttemptRecord, JobErrorCode, JobView, Verdict } from '../../../../../shared/jobs/types'
import { CapsText, cx } from '../../../ui'

/** The short reason of each error code, as stamps and reason groups print it; main's own short reason wins when known. */
export const ERROR_SHORT: Readonly<Record<JobErrorCode, string>> =
{
  'ffmpeg-failed': 'FFmpeg failed',
  'ffmpeg-unavailable': 'FFmpeg missing',
  'probe-failed': 'Unreadable',
  'not-media': 'Not media',
  'source-missing': 'Source missing',
  'source-offline': 'Lost access',
  'plan-refused': 'Blocked',
  'measure-failed': 'Measuring failed',
  'decode-errors': 'Output does not decode',
  'output-unreadable': 'Output unreadable',
  'disk-full': 'Disk full',
  'permission-denied': 'No permission',
  'destination-missing': 'Folder missing',
  'file-locked': 'File in use',
  'gpu-session-limit': 'GPU busy',
  'gpu-init-failed': 'GPU failed to start',
  'album-measure-failed': 'Album measure failed',
  'held-output-missing': 'Output missing',
  'internal': 'Internal error'
}

/** The caption of the attempts list. */
export const ATTEMPTS_CAPTION = 'Attempts'

const VERDICT_WORDS: Readonly<Record<Verdict, string>> =
{
  'verified': 'Verified',
  'verified-below-target': 'Verified, reachable level',
  'outside-tolerance': 'Outside tolerance',
  'passthrough': 'Verified',
  'failed': 'Returned'
}

const STATE_WORDS: Readonly<Partial<Record<JobView['state'], string>>> =
{
  pending: 'Not started',
  queued: 'Queued',
  analyzing: 'Running',
  encoding: 'Running',
  verifying: 'Running',
  finalizing: 'Saving',
  held: 'Needs a decision',
  failed: 'Failed',
  canceled: 'Canceled',
  skipped: 'Skipped',
  interrupted: 'Interrupted'
}

/** One attempt as the list prints it. */
export interface AttemptLine
{
  attempt: number
  /** "Batch 31"; null when the attempt ran in no batch. */
  batch: string | null
  outcome: string
  /** The short reason of a failed attempt. */
  reason: string | null
  /** "Oct 14, 22:10" when the attempt ended. */
  ended: string | null
  current: boolean
}

function endedText(epochMs: number | null): string | null
{
  return epochMs === null ? null : `${formatDay(epochMs)}, ${formatTimeOfDay(epochMs)}`
}

function recordOutcome(record: AttemptRecord): string
{
  if (record.state === 'done')
  {
    return record.verdict === null ? 'Done' : VERDICT_WORDS[record.verdict]
  }
  return STATE_WORDS[record.state] ?? record.state
}

function currentOutcome(job: JobView): string
{
  if (job.state === 'done')
  {
    return job.stamp === null ? 'Done' : VERDICT_WORDS[job.stamp.verdict]
  }
  return STATE_WORDS[job.state] ?? job.state
}

/** Every attempt of a job, oldest first: the earlier records, then the attempt the job holds now. */
export function attemptLines(records: readonly AttemptRecord[], job: JobView): AttemptLine[]
{
  const earlier = records
    .filter((record) => record.attempt !== job.attempt)
    .sort((a, b) => a.attempt - b.attempt)
    .map((record): AttemptLine => ({
      attempt: record.attempt,
      batch: record.runId === null ? null : batchLabel(record.runId),
      outcome: recordOutcome(record),
      reason: record.errorCode === null ? null : ERROR_SHORT[record.errorCode],
      ended: endedText(record.endedAt),
      current: false
    }))
  const current: AttemptLine =
  {
    attempt: job.attempt,
    batch: job.runId === null ? null : batchLabel(job.runId),
    outcome: currentOutcome(job),
    reason: job.state === 'failed' ? job.error?.short ?? null : null,
    ended: endedText(job.endedAt),
    current: true
  }
  return [...earlier, current]
}

/** The text of one attempt line after its number: "Batch 31 · Failed · Decode failed · Oct 14, 22:10". */
export function attemptText(line: AttemptLine): string
{
  return [line.batch, line.outcome, line.reason, line.ended].filter((part) => part !== null).join(PART_SEPARATOR)
}

/** Props for {@link Attempts}. */
export interface AttemptsProps
{
  /** The job's earlier attempts, from its detail. */
  records: readonly AttemptRecord[]
  job: JobView
  className?: string
}

/** Every attempt of one job under its catalog number, oldest first, the current one marked. */
export function Attempts({ records, job, className }: AttemptsProps): React.JSX.Element
{
  const captionId = `${useId()}-caption`
  const lines = attemptLines(records, job)
  return (
    <section aria-labelledby={captionId} className={cx('flex flex-col gap-1.5', className)}>
      <h4 id={captionId} className='type-legend text-brass'>
        <CapsText>{ATTEMPTS_CAPTION}</CapsText>
      </h4>
      <ol className='flex flex-col gap-1 select-text'>
        {lines.map((line) => (
          <li
            key={line.attempt}
            aria-current={line.current ? 'step' : undefined}
            className={cx('flex flex-wrap gap-x-2 text-label', line.current ? 'text-ink' : 'text-ink-2')}
          >
            <span className='tabular-nums'>{`Attempt ${line.attempt}`}</span>
            <span>{attemptText(line)}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
