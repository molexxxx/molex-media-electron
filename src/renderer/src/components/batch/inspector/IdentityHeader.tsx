import React, { useContext, useState } from 'react'
import type { JobCommandResponse } from '../../../../../shared/jobs/contract'
import { operationLabel, presetLabel } from '../../../../../shared/jobs/describe'
import type { JobId } from '../../../../../shared/jobs/ids'
import { presetLookup } from '../../../../../shared/jobs/presets'
import type { Operation } from '../../../../../shared/jobs/recipes'
import { needsAttention, needsDecision } from '../../../../../shared/jobs/states'
import type { JobHold, JobView, SourceRef, UserPreset } from '../../../../../shared/jobs/types'
import { platformWords, type Platform } from '../../../../../shared/text/platform'
import { countOf, formatBytes, formatCount, formatDuration, PART_SEPARATOR, statusWords, type StatusKey as CopyStatusKey } from '../../../copy/batch'
import { relinkOffer, type RetryOutcome } from '../../../stores/batchActions'
import { Button, CatalogNumber, cx, InlineConfirm, StatusLabel, usePlatform, type StatusKey } from '../../../ui'
import { BatchActionsContext } from '../BatchActionsContext'

/** The characters a file name keeps before it truncates in the middle; two lines at the narrowest inspector. */
export const NAME_BUDGET = 64

/** The characters a folder keeps before it truncates in the middle. */
export const FOLDER_BUDGET = 56

/** The batch view's heading and teaching sentence, while nothing is selected. */
export const NO_SELECTION = 'No jobs selected'
export const NO_SELECTION_TEXT = 'Select jobs to change their settings and see what they will write.'

/** Text shortened in the middle to a number of characters, keeping more of the end, where extensions and leaf folders are. */
export function middleTruncate(text: string, max: number): string
{
  const chars = Array.from(text)
  if (chars.length <= max)
  {
    return text
  }
  const keep = max - 1
  const tail = Math.ceil(keep * 0.45)
  return `${chars.slice(0, keep - tail).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/** The StatusLabel key of a status word; the registry spells the canceled state as the engine does. */
export function statusKey(status: CopyStatusKey): StatusKey
{
  return status === 'canceled' ? 'cancelled' : status
}

/** "8 Normalize", or "6 Normalize, 2 Compress" with the most common operation first. */
export function operationBreakdown(jobs: readonly JobView[]): string
{
  const counts = new Map<Operation, number>()
  for (const job of jobs)
  {
    counts.set(job.recipe.kind, (counts.get(job.recipe.kind) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([op, count]) => `${count} ${operationLabel(op)}`)
    .join(', ')
}

/** The breakdown of several jobs: operations, total source size, and total duration once every job is probed. */
export function selectionBreakdown(jobs: readonly JobView[]): string
{
  const parts = [operationBreakdown(jobs), formatBytes(jobs.reduce((sum, job) => sum + job.source.size, 0))]
  if (jobs.every((job) => typeof job.media?.durationSec === 'number'))
  {
    parts.push(formatDuration(jobs.reduce((sum, job) => sum + (job.media?.durationSec ?? 0), 0)))
  }
  return parts.join(PART_SEPARATOR)
}

/** One narrowing link: "Select only: Apple Podcasts (6)". */
export interface Narrowing
{
  label: string
  ids: JobId[]
}

/** The narrowing links of several jobs: by operation when they mix operations, else by preset when they mix presets. */
export function narrowings(jobs: readonly JobView[], users: readonly UserPreset[] = []): Narrowing[]
{
  const lookup = presetLookup(users)
  const byOperation = new Set(jobs.map((job) => job.recipe.kind)).size > 1
  const groups = new Map<string, JobId[]>()
  for (const job of jobs)
  {
    const name = byOperation ? operationLabel(job.recipe.kind) : presetLabel(job.recipe, lookup)
    groups.set(name, [...(groups.get(name) ?? []), job.id])
  }
  if (groups.size < 2)
  {
    return []
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, ids]) => ({ label: `Select only: ${name} (${ids.length})`, ids }))
}

/** The next job in table order after this one that needs attention, wrapping around; null when no other job does. */
export function nextNeedingAttention(queue: readonly JobView[], after: JobId): JobView | null
{
  const start = queue.findIndex((job) => job.id === after)
  for (let step = 1; step <= queue.length; step += 1)
  {
    const job = queue[(start + step) % queue.length]
    if (job.id !== after && needsAttention(job))
    {
      return job
    }
  }
  return null
}

/** One choice of a job waiting for a decision. */
export type DecisionAction = JobHold['actions'][number]

/** Whether two paths name the same file; Windows paths compare without case and with either separator. */
export function samePath(a: string, b: string, platform: Platform): boolean
{
  const normal = (path: string): string =>
  {
    const unified = platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path
    return unified.replace(/\/+$/, '')
  }
  return normal(a) === normal(b)
}

/** Whether keeping a waiting output as planned replaces the job's original. */
export function keepReplacesOriginal(job: Pick<JobView, 'hold' | 'source'>, platform: Platform): boolean
{
  const displaces = job.hold?.displaces ?? null
  return displaces !== null && samePath(displaces, job.source.path, platform)
}

/** A decision button's label; after an interruption while saving, keeping the output reads "Finish saving". */
export function decisionLabel(action: DecisionAction, job: Pick<JobView, 'hold' | 'source'>, platform: Platform): string
{
  switch (action)
  {
    case 'keep':
    {
      if (job.hold?.reason === 'interrupted-finalize')
      {
        return 'Finish saving'
      }
      return keepReplacesOriginal(job, platform) ? 'Keep output and replace original' : 'Keep output'
    }
    case 'keep-renamed':
      return 'Keep under a new name'
    case 'discard':
      return 'Discard output'
    case 'retry':
      return 'Retry'
  }
}

/** The decisions that ask first. */
export type DecisionConfirm = 'keep' | 'discard' | 'retry'

/** An inline confirmation's question and its two choices. */
export interface ConfirmWords
{
  question: string
  safe: string
  confirm: string
  danger: boolean
}

/** The inline confirmation of a decision that discards, deletes, or replaces a file. */
export function decisionConfirmWords(kind: DecisionConfirm, job: Pick<JobView, 'id' | 'hold' | 'source'>, platform: Platform): ConfirmWords
{
  if (kind === 'discard')
  {
    return {
      question: `Discard the output of ${job.id}? The file is deleted. The original and any existing file stay.`,
      safe: 'Keep it',
      confirm: 'Discard',
      danger: true
    }
  }
  if (kind === 'retry')
  {
    return { question: `Retry ${job.id}? The output waiting for a decision is deleted first.`, safe: 'Keep waiting', confirm: 'Retry', danger: false }
  }
  const bin = platformWords(platform).binName
  if (keepReplacesOriginal(job, platform))
  {
    const output = job.hold?.reason === 'outside-tolerance' ? 'an output outside tolerance' : 'its output'
    return {
      question: `Replace the original of ${job.id} with ${output}? The original goes to the ${bin}.`,
      safe: 'Keep both',
      confirm: 'Replace original',
      danger: true
    }
  }
  return {
    question: `Replace the existing file with the output of ${job.id}? The existing file goes to the ${bin}.`,
    safe: 'Keep both',
    confirm: 'Replace file',
    danger: true
  }
}

/** Whether a job's source file is missing, so the header offers Locate. */
export function sourceMissing(job: Pick<JobView, 'plan' | 'error'>): boolean
{
  return job.plan?.firstIssue?.code === 'source-missing' || job.error?.code === 'source-missing'
}

/** What the Locate dialog needs: it opens in the old folder with the old name filled in, filtered to its type. */
export interface LocateRequest
{
  defaultPath: string
  name: string
  extensions: string[]
}

/** The Locate dialog's request for a source. */
export function locateRequest(source: Pick<SourceRef, 'path' | 'name' | 'ext'>): LocateRequest
{
  const ext = source.ext.replace(/^\./, '')
  return { defaultPath: source.path, name: source.name, extensions: ext === '' ? ['*'] : [ext] }
}

/** The jobs a Locate in another folder offers to relink. */
export type Relinkable = NonNullable<JobCommandResponse<'locate'>['relinkable']>

/** "Showing MM-0137 of 8 selected", for one job shown from inside a multi-selection. */
export function showingOf(id: JobId, count: number): string
{
  return `Showing ${id} of ${formatCount(count)} selected`
}

export interface IdentityHeaderProps
{
  /** The selected jobs, in selection order. */
  jobs: readonly JobView[]
  /** The user's presets, for preset names. */
  users?: readonly UserPreset[]
  /** Narrows the selection to these jobs. */
  onSelectOnly?(ids: JobId[]): void
  /** One job shown from inside a multi-selection: the selection's size and the way back to all of it. */
  within?: { count: number; onBack(): void }
  /** The "Job actions" overflow button with the row menu's items, placed beside the catalog number. */
  jobActions?: React.ReactNode
  /** Every job in table order, for "Next: {no}" after Acknowledge. */
  queue?: readonly JobView[]
  /** Shows one job in the inspector, from "Next: {no}". */
  onShowJob?(id: JobId): void
  /** Moves focus to the job's row, after a decision. */
  onFocusRow?(id: JobId): void
  /** A Retry that needs the destructive acknowledgment first; the inspector shows the acknowledgment for these jobs. */
  onRetryNeedsAcknowledgment?(ids: JobId[], ack: RetryAck): void
  /** Opens the Locate file dialog; resolves to the chosen path, or null when the dialog was canceled. */
  pickSource?(request: LocateRequest): Promise<string | null>
  className?: string
}

/** The acknowledgment counts a destructive Retry needs. */
export type RetryAck = Extract<RetryOutcome, { status: 'needs-acknowledgment' }>['ack']

function LinkButton({ onClick, children }: { onClick(): void; children: React.ReactNode }): React.JSX.Element
{
  return (
    <button
      type='button'
      onClick={onClick}
      className='rounded-xs text-label text-ink-2 underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink-3'
    >
      {children}
    </button>
  )
}

function SeveralJobs({ jobs, users = [], onSelectOnly }: IdentityHeaderProps): React.JSX.Element
{
  const links = narrowings(jobs, users)
  return (
    <div className='flex flex-col gap-1'>
      <h2 className='text-body font-semibold text-ink'>{`${countOf(jobs.length, 'job')} selected`}</h2>
      <p className='text-label tabular-nums text-ink-2'>{selectionBreakdown(jobs)}</p>
      {links.length > 0 && onSelectOnly !== undefined && (
        <ul aria-label='Narrow the selection' className='mt-1 flex flex-wrap gap-x-3 gap-y-1'>
          {links.map((link) => (
            <li key={link.label}>
              <LinkButton onClick={() => onSelectOnly(link.ids)}>{link.label}</LinkButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function NoJobs(): React.JSX.Element
{
  return (
    <div className='flex flex-col gap-1'>
      <h2 className='text-section text-ink'>{NO_SELECTION}</h2>
      <p className='text-label text-ink-2'>{NO_SELECTION_TEXT}</p>
    </div>
  )
}

/** The inspector header: one job's identity and status, several jobs' breakdown and narrowing links, or no selection. */
export function IdentityHeader(props: IdentityHeaderProps): React.JSX.Element
{
  const { jobs, className } = props
  return (
    <header className={cx('flex flex-col gap-2', className)}>
      {jobs.length === 0 && <NoJobs />}
      {jobs.length === 1 && <OneJob key={jobs[0].id} {...props} job={jobs[0]} />}
      {jobs.length > 1 && <SeveralJobs {...props} />}
    </header>
  )
}

type OneJobProps = IdentityHeaderProps & { job: JobView }

function Acknowledge({ job, queue = [], onShowJob }: OneJobProps): React.JSX.Element | null
{
  const actions = useContext(BatchActionsContext)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  if (actions === null)
  {
    return null
  }
  const act = actions
  async function acknowledge(): Promise<void>
  {
    setBusy(true)
    const outcome = await act.acknowledge([job.id])
    setBusy(false)
    setDone(outcome.status === 'done')
  }
  if (done || !needsAttention(job) || needsDecision(job))
  {
    const next = done ? nextNeedingAttention(queue, job.id) : null
    return next === null || onShowJob === undefined ? null : <LinkButton onClick={() => onShowJob(next.id)}>{`Next: ${next.id}`}</LinkButton>
  }
  return (
    <Button size='sm' variant='secondary' loading={busy} loadingLabel='Acknowledge' onClick={() => void acknowledge()}>
      Acknowledge
    </Button>
  )
}

function Decisions({ job, onFocusRow, onRetryNeedsAcknowledgment }: OneJobProps): React.JSX.Element | null
{
  const actions = useContext(BatchActionsContext)
  const platform = usePlatform()
  const [asking, setAsking] = useState<DecisionConfirm | null>(null)
  const [busy, setBusy] = useState<DecisionAction | null>(null)
  const hold = job.hold
  if (actions === null || hold === null)
  {
    return null
  }
  const act = actions
  const ids = [job.id]
  async function settle(action: DecisionAction, work: Promise<{ status: string }>): Promise<void>
  {
    setBusy(action)
    const outcome = await work
    setBusy(null)
    if (outcome.status === 'needs-confirmation')
    {
      setAsking('keep')
    }
    else if (outcome.status === 'done')
    {
      onFocusRow?.(job.id)
    }
  }
  async function retry(): Promise<void>
  {
    setBusy('retry')
    const outcome = await act.retry(ids)
    setBusy(null)
    if (outcome.status === 'needs-acknowledgment')
    {
      onRetryNeedsAcknowledgment?.(ids, outcome.ack)
    }
    else if (outcome.status === 'done')
    {
      onFocusRow?.(job.id)
    }
  }
  function choose(action: DecisionAction): void
  {
    if (busy !== null)
    {
      return
    }
    if (action === 'keep')
    {
      void settle(action, act.keepOutput(ids))
    }
    else if (action === 'keep-renamed')
    {
      void settle(action, act.keepOutput(ids, { placement: 'renamed' }))
    }
    else
    {
      setAsking(action)
    }
  }
  function resolve(kind: DecisionConfirm, confirmed: boolean): void
  {
    setAsking(null)
    if (!confirmed)
    {
      return
    }
    if (kind === 'keep')
    {
      void settle('keep', act.keepOutput(ids, { confirmed: true }))
    }
    else if (kind === 'discard')
    {
      void settle('discard', act.discardOutput(ids))
    }
    else
    {
      void retry()
    }
  }
  if (asking !== null)
  {
    const words = decisionConfirmWords(asking, job, platform)
    return (
      <InlineConfirm
        question={words.question}
        safeLabel={words.safe}
        confirmLabel={words.confirm}
        danger={words.danger}
        size='sm'
        onResolve={(confirmed) => resolve(asking, confirmed)}
      />
    )
  }
  return (
    <div role='group' aria-label={`Decide ${job.id}`} className='flex flex-wrap gap-2'>
      {hold.actions.map((action) =>
      {
        const label = decisionLabel(action, job, platform)
        return (
          <Button key={action} size='sm' variant='secondary' loading={busy === action} loadingLabel={label} onClick={() => choose(action)}>
            {label}
          </Button>
        )
      })}
    </div>
  )
}

function Locate({ job, pickSource }: OneJobProps): React.JSX.Element | null
{
  const actions = useContext(BatchActionsContext)
  const [busy, setBusy] = useState(false)
  const [offer, setOffer] = useState<Relinkable | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (actions === null || pickSource === undefined)
  {
    return null
  }
  const act = actions
  const pick = pickSource
  async function locate(): Promise<void>
  {
    setError(null)
    setBusy(true)
    const path = await pick(locateRequest(job.source)).catch(() => null)
    if (path === null)
    {
      setBusy(false)
      return
    }
    const outcome = await act.send('locate', { jobId: job.id, path })
    setBusy(false)
    if (outcome.status !== 'done')
    {
      setError(outcome.message)
      return
    }
    const relinkable = outcome.value.relinkable
    setOffer(relinkable !== null && relinkable.ids.length > 0 ? relinkable : null)
  }
  async function relink(target: Relinkable): Promise<void>
  {
    const outcome = await act.send('relink', { fromDir: target.fromDir, toDir: target.toDir, ids: target.ids })
    if (outcome.status !== 'done')
    {
      setError(outcome.message)
    }
  }
  function resolve(target: Relinkable, confirmed: boolean): void
  {
    setOffer(null)
    if (confirmed)
    {
      void relink(target)
    }
  }
  const missing = sourceMissing(job)
  if (!missing && offer === null && error === null)
  {
    return null
  }
  return (
    <div className='flex flex-col gap-2'>
      {missing && offer === null && (
        <div>
          <Button size='sm' variant='secondary' icon='action.locate' loading={busy} loadingLabel={'Locate…'} onClick={() => void locate()}>
            {'Locate…'}
          </Button>
        </div>
      )}
      {offer !== null && (
        <InlineConfirm
          question={relinkOffer(offer)}
          safeLabel='Not now'
          confirmLabel='Relink'
          size='sm'
          onResolve={(confirmed) => resolve(offer, confirmed)}
        />
      )}
      {error !== null && <p role='alert' className='select-text text-label text-error'>{error}</p>}
    </div>
  )
}

function OneJob(props: OneJobProps): React.JSX.Element
{
  const { job, within, jobActions } = props
  const platform = usePlatform()
  const words = statusWords(job, { platform })
  const name = middleTruncate(job.source.name, NAME_BUDGET)
  const folder = middleTruncate(job.source.dir, FOLDER_BUDGET)
  return (
    <div className='flex flex-col gap-2'>
      {within !== undefined && (
        <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
          <p className='text-label text-ink-2'>{showingOf(job.id, within.count)}</p>
          <LinkButton onClick={within.onBack}>{`Back to all ${formatCount(within.count)}`}</LinkButton>
        </div>
      )}
      <div className='flex items-start justify-between gap-2'>
        <h2 aria-label={`${job.id}, ${job.source.name}`} className='flex min-w-0 flex-col gap-0.5'>
          <span title={job.source.name} className='line-clamp-2 select-text text-section text-ink wrap-anywhere'>
            {name}
          </span>
          <span className='flex min-w-0 items-baseline gap-2 text-label text-ink-3'>
            <CatalogNumber value={job.id} />
            <span title={job.source.dir} className='min-w-0 select-text truncate'>{folder}</span>
          </span>
        </h2>
        {jobActions}
      </div>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <StatusLabel status={statusKey(words.status)} label={words.label} compactLabel={words.compact} held={words.held} size='md' />
        <Acknowledge {...props} />
      </div>
      {needsDecision(job) && <Decisions {...props} />}
      <Locate {...props} />
    </div>
  )
}
