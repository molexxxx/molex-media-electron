import React, { useRef, useState } from 'react'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { JobHold, JobView } from '../../../../../shared/jobs/types'
import type { Ack } from '../../../../../shared/jobs/contract'
import { Button, cx, InlineConfirm } from '../../../ui'
import { useBatchActions } from '../BatchActionsContext'
import { rowElement } from '../table/RowMenu'

/** A decision a held job offers. */
export type Decision = JobHold['actions'][number]

/** The fixed labels of the decisions; Keep output relabels by what placing would do, see {@link keepLabel}. */
export const DECISION_LABELS =
{
  keep: 'Keep output',
  keepReplace: 'Keep output and replace original',
  finishSaving: 'Finish saving',
  keepRenamed: 'Keep under a new name',
  discard: 'Discard output',
  retry: 'Retry'
} as const

/** The order the decisions sit in, the planned placement first. */
export const DECISION_ORDER: readonly Decision[] = ['keep', 'keep-renamed', 'discard', 'retry']

/** An inline confirmation's words. */
export interface ConfirmWords
{
  question: string
  safe: string
  confirm: string
  danger: boolean
}

function displacesOriginal(job: Pick<JobView, 'source' | 'hold'>): boolean
{
  return job.hold !== null && job.hold.displaces !== null && job.hold.displaces === job.source.path
}

/** Keep output's label: "Finish saving" after an interruption while saving, and naming the original in Replace mode. */
export function keepLabel(job: Pick<JobView, 'source' | 'hold'>): string
{
  if (job.hold?.reason === 'interrupted-finalize')
  {
    return DECISION_LABELS.finishSaving
  }
  return displacesOriginal(job) ? DECISION_LABELS.keepReplace : DECISION_LABELS.keep
}

function fileName(path: string): string
{
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** The confirmation Keep output asks for when placing the output would displace a file. */
export function keepConfirmWords(job: Pick<JobView, 'id' | 'source' | 'hold'>): ConfirmWords
{
  if (displacesOriginal(job))
  {
    const outside = job.hold?.reason === 'outside-tolerance' ? ' with an output outside tolerance' : ''
    return {
      question: `Replace the original of ${job.id}${outside}? The original goes to the Recycle Bin.`,
      safe: 'Keep both',
      confirm: 'Replace original',
      danger: true
    }
  }
  const existing = job.hold?.displaces ?? null
  return {
    question: `Replace ${existing === null ? 'the existing file' : fileName(existing)} with the output of ${job.id}? The existing file goes to the Recycle Bin.`,
    safe: 'Keep both',
    confirm: 'Replace file',
    danger: true
  }
}

/** Discard output's confirmation. */
export function discardConfirmWords(jobId: JobId): ConfirmWords
{
  return {
    question: `Discard the output of ${jobId}? The file is deleted. The original and any existing file stay.`,
    safe: 'Keep it',
    confirm: 'Discard',
    danger: true
  }
}

/** Retry's confirmation for a job waiting for a decision. */
export function retryConfirmWords(jobId: JobId): ConfirmWords
{
  return {
    question: `Retry ${jobId}? The output waiting for a decision is deleted first.`,
    safe: 'Keep waiting',
    confirm: 'Retry',
    danger: false
  }
}

/** Focuses a job's table row; the default when the page gives no focus handler. */
export function focusJobRow(id: JobId): void
{
  rowElement(id)?.focus()
}

/** Props for {@link DecisionButtons}. */
export interface DecisionButtonsProps
{
  /** A job waiting for a decision, with its hold. */
  job: JobView
  /** Moves focus to the job's row after any decision; the row element is focused by default. */
  onFocusRow?: (id: JobId) => void
  /** A retry that replaces files asks for its acknowledgment first; the owner shows the check and retries with it. */
  onNeedsAcknowledgment?: (ack: Ack) => void
  size?: 'sm' | 'md'
  className?: string
}

type Pending = { kind: 'keep'; words: ConfirmWords } | { kind: 'discard'; words: ConfirmWords } | { kind: 'retry'; words: ConfirmWords }

/**
 * Keep output (or Finish saving), Keep under a new name, Discard output, and Retry for a job waiting for a decision.
 * Discard and Retry confirm inline first, and Keep output does when its placement displaces a file. After any
 * decision, focus moves to the job's row.
 */
export function DecisionButtons({ job, onFocusRow = focusJobRow, onNeedsAcknowledgment, size = 'sm', className }: DecisionButtonsProps): React.JSX.Element | null
{
  const actions = useBatchActions()
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  if (job.hold === null)
  {
    return null
  }
  const offered = DECISION_ORDER.filter((decision) => job.hold?.actions.includes(decision) === true)
  const ids = [job.id]

  const settle = async (run: () => Promise<{ status: string }>): Promise<void> =>
  {
    setBusy(true)
    try
    {
      const outcome = await run()
      if (outcome.status === 'done')
      {
        onFocusRow(job.id)
      }
    }
    finally
    {
      setBusy(false)
    }
  }

  const keep = async (confirmed: boolean): Promise<void> =>
  {
    await settle(async () =>
    {
      const outcome = await actions.keepOutput(ids, { placement: 'planned', confirmed })
      if (outcome.status === 'needs-confirmation')
      {
        setPending({ kind: 'keep', words: keepConfirmWords(job) })
      }
      return outcome
    })
  }

  const retry = async (): Promise<void> =>
  {
    await settle(async () =>
    {
      const outcome = await actions.retry(ids)
      if (outcome.status === 'needs-acknowledgment')
      {
        onNeedsAcknowledgment?.(outcome.ack)
      }
      return outcome
    })
  }

  const resolve = (confirmed: boolean): void =>
  {
    const asked = pending
    setPending(null)
    if (!confirmed || asked === null)
    {
      return
    }
    if (asked.kind === 'keep')
    {
      void keep(true)
    }
    else if (asked.kind === 'discard')
    {
      void settle(() => actions.discardOutput(ids))
    }
    else
    {
      void retry()
    }
  }

  return (
    <div ref={slot} tabIndex={-1} data-part='decisions' className={cx('flex flex-wrap items-center gap-2', className)}>
      {pending !== null
        ? (
            <InlineConfirm
              question={pending.words.question}
              safeLabel={pending.words.safe}
              confirmLabel={pending.words.confirm}
              danger={pending.words.danger}
              onResolve={resolve}
              fallbackFocus={slot}
              size={size}
            />
          )
        : offered.map((decision) =>
          {
            if (decision === 'keep')
            {
              return (
                <Button key={decision} variant='secondary' size={size} disabled={busy} onClick={() => { void keep(false) }}>
                  {keepLabel(job)}
                </Button>
              )
            }
            if (decision === 'keep-renamed')
            {
              return (
                <Button
                  key={decision}
                  variant='secondary'
                  size={size}
                  disabled={busy}
                  onClick={() => { void settle(() => actions.keepOutput(ids, { placement: 'renamed' })) }}
                >
                  {DECISION_LABELS.keepRenamed}
                </Button>
              )
            }
            if (decision === 'discard')
            {
              return (
                <Button key={decision} variant='secondary' size={size} disabled={busy} onClick={() => setPending({ kind: 'discard', words: discardConfirmWords(job.id) })}>
                  {DECISION_LABELS.discard}
                </Button>
              )
            }
            return (
              <Button key={decision} variant='secondary' size={size} icon='action.retry' disabled={busy} onClick={() => setPending({ kind: 'retry', words: retryConfirmWords(job.id) })}>
                {DECISION_LABELS.retry}
              </Button>
            )
          })}
    </div>
  )
}
