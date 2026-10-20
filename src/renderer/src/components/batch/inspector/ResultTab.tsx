import React, { useEffect, useId, useRef, useState } from 'react'
import
{
  batchLabel,
  ESTIMATING_TIME_LEFT,
  formatBytes,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatSizeChange,
  formatSpeed,
  revealLabel,
  screenMessage,
  stampWords,
  type CopiedKind
} from '../../../copy/batch'
import type { Ack } from '../../../../../shared/jobs/contract'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { Recipe } from '../../../../../shared/jobs/recipes'
import { needsAttention, needsDecision } from '../../../../../shared/jobs/states'
import type { JobDetail, JobProgress, JobResult, JobState, JobView, StageId } from '../../../../../shared/jobs/types'
import type { BatchActions } from '../../../stores/batchActions'
import { Button, CapsText, cx, Stamp, StageTrack, usePlatform, type Stage, type StageState } from '../../../ui'
import { useBatchActions } from '../BatchActionsContext'
import { AcknowledgmentCheck, volumeOf } from '../summary/AcknowledgmentCheck'
import { Attempts } from './Attempts'
import { BeforePlanAfterTable, jobUnit } from './BeforePlanAfterTable'
import { DecisionButtons, focusJobRow } from './DecisionButtons'
import { copyErrorText, ErrorDetail, failedCommand, STAGE_NAMES } from './ErrorDetail'

/** What the Result tab shows for a job, by where the job stands. */
export type ResultPhase = 'not-started' | 'running' | 'done' | 'held' | 'failed' | 'interrupted' | 'canceled' | 'skipped'

const PHASES: Readonly<Record<JobState, ResultPhase>> =
{
  pending: 'not-started',
  queued: 'not-started',
  analyzing: 'running',
  encoding: 'running',
  verifying: 'running',
  finalizing: 'running',
  held: 'held',
  done: 'done',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
  interrupted: 'interrupted'
}

/** The Result tab's view of a job's state. */
export function resultPhase(job: Pick<JobView, 'state'>): ResultPhase
{
  return PHASES[job.state]
}

/** The stages each operation runs, in order; an operation that does not measure has no Measure stage. */
export const PLANNED_STAGES: Readonly<Record<Recipe['kind'], readonly StageId[]>> =
{
  normalize: ['probe', 'measure', 'encode', 'verify', 'place'],
  boost: ['probe', 'measure', 'encode', 'verify', 'place'],
  convert: ['probe', 'encode', 'verify', 'place'],
  compress: ['probe', 'encode', 'verify', 'place'],
  extract: ['probe', 'encode', 'verify', 'place']
}

/** The words of the stage track. */
export const TRACK_WORDS =
{
  corrective: 'Re-encode (correction)',
  correctiveDetail: 'corrective'
} as const

const CORRECTION_LABEL = /correction/i

/**
 * The StageTrack for a job: every stage the attempt ran, in order, with the time each finished stage took and the
 * failed stage marked; while the job waits or runs, the stages its operation still has to run follow as pending.
 */
export function trackStages(job: Pick<JobView, 'state' | 'stage' | 'recipe' | 'error'>, detail: Pick<JobDetail, 'stages'> | null): Stage[]
{
  const ran: JobDetail['stages'] = detail?.stages
    ?? (job.stage !== null
      ? [{ ...job.stage, endedAt: null, outcome: 'active' }]
      : job.error !== null ? [{ id: job.error.stage, pass: 1, passes: 1, label: '', startedAt: job.error.at, endedAt: job.error.at, outcome: 'failed' }] : [])
  let verified = false
  const stages = ran.map((stage, index): Stage =>
  {
    const corrective = stage.id === 'encode' && (verified || CORRECTION_LABEL.test(stage.label))
    if (stage.id === 'verify')
    {
      verified = true
    }
    const name = corrective ? TRACK_WORDS.corrective : STAGE_NAMES[stage.id]
    const label = !corrective && stage.passes > 1 ? `${name}, pass ${stage.pass} of ${stage.passes}` : name
    const took = stage.outcome === 'done' && stage.endedAt !== null ? formatElapsed(stage.endedAt - stage.startedAt) : null
    const detailText = corrective ? [TRACK_WORDS.correctiveDetail, took].filter((part) => part !== null).join(', ') : took
    const state: StageState = stage.outcome
    return detailText === null
      ? { key: `${stage.id}-${stage.pass}-${index}`, label, state }
      : { key: `${stage.id}-${stage.pass}-${index}`, label, state, detail: detailText }
  })
  const phase = resultPhase(job)
  if (phase === 'not-started' || phase === 'running')
  {
    const seen = new Set<StageId>(ran.map((stage) => stage.id === 'measure-dynamics' || stage.id === 'measure-album' ? 'measure' : stage.id))
    for (const id of PLANNED_STAGES[job.recipe.kind] ?? [])
    {
      if (!seen.has(id))
      {
        stages.push({ key: `${id}-planned`, label: STAGE_NAMES[id], state: 'pending' })
      }
    }
  }
  return stages
}

/** One live number while a job runs. */
export interface LiveFact
{
  label: string
  value: string
}

/** The live numbers of a running job: percent, speed, time left, elapsed, and bytes written. */
export function liveFacts(progress: JobProgress): LiveFact[]
{
  const facts: LiveFact[] = [
    { label: 'Progress', value: formatPercent(progress.percent) },
    { label: 'Speed', value: progress.speed === null ? 'Not reported' : formatSpeed(progress.speed) },
    { label: 'Time left', value: progress.etaSec === null ? ESTIMATING_TIME_LEFT : formatDuration(progress.etaSec) },
    { label: 'Elapsed', value: formatElapsed(progress.elapsedMs) }
  ]
  if (progress.bytesWritten !== null)
  {
    facts.push({ label: 'Written', value: formatBytes(progress.bytesWritten) })
  }
  return facts
}

/** The sizes of a finished output: the source, and the output with its change. */
export function sizeFacts(result: Pick<JobResult, 'inputBytes' | 'outputBytes'>): LiveFact[]
{
  return [
    { label: 'Source', value: formatBytes(result.inputBytes) },
    { label: 'Output', value: `${formatBytes(result.outputBytes)} (${formatSizeChange(result.outputBytes, result.inputBytes)})` }
  ]
}

/** The Result tab's fixed words. */
export const RESULT_WORDS =
{
  live: 'Running now',
  sizes: 'Sizes',
  output: 'Output',
  notStarted: 'Results appear here when this job runs.',
  canceled: 'Canceled. Nothing was measured, so this job has no stamp.',
  skipped: 'Skipped. Retry runs it later.',
  interrupted: 'molexMedia closed during this job. The partial file was removed.',
  retry: 'Retry',
  editAndRetry: 'Edit and retry',
  showLog: 'Show log',
  copyError: 'Copy error',
  acknowledge: 'Acknowledge',
  actions: 'Result actions'
} as const

/** The queued line: "Queued in Batch 31. Results appear here when it runs." */
export function queuedText(job: Pick<JobView, 'runId'>): string
{
  return job.runId === null ? RESULT_WORDS.notStarted : `Queued in ${batchLabel(job.runId)}. Results appear here when it runs.`
}

/** "Next: MM-0152", the button Acknowledge leaves focus on when another job needs attention. */
export function nextLabel(jobId: JobId): string
{
  return `Next: ${jobId}`
}

/** Whether the tab shows a stamp: only for a measured outcome, and for a decision only when it is outside tolerance. */
export function showsStamp(job: Pick<JobView, 'state' | 'stamp'>): boolean
{
  const phase = resultPhase(job)
  if (phase === 'failed' || phase === 'interrupted')
  {
    return true
  }
  if (phase === 'held')
  {
    return job.stamp?.verdict === 'outside-tolerance'
  }
  return phase === 'done' && job.stamp !== null
}

/** The sentences under the stamp: Verify's messages as main wrote them, then each warning's sentence, then notes. */
export function resultSentences(job: Pick<JobView, 'warnings'>, detail: Pick<JobDetail, 'verification' | 'result'> | null): string[]
{
  const messages = (detail?.verification?.messages ?? []).map(screenMessage)
  const warnings = (detail?.result?.warnings ?? job.warnings).map((warning) => warning.message)
  return [...messages, ...warnings, ...(detail?.result?.notes ?? [])].filter((text, index, all) => text !== '' && all.indexOf(text) === index)
}

/** Opens Logs filtered to a job, or to one attempt's complete FFmpeg log. */
export type ShowLog = (jobId: JobId, options?: { attempt?: number }) => void

/** The Logs action the page binds into the actions context, when the shell provides one. */
export function contextShowLog(actions: BatchActions): ShowLog | undefined
{
  const candidate = (actions as BatchActions & { showLog?: unknown }).showLog
  return typeof candidate === 'function' ? (candidate as ShowLog) : undefined
}

/** Props for {@link ResultTab}. */
export interface ResultTabProps
{
  job: JobView
  /** The selected job's detail; null while it loads, when the tab shows what the row knows. */
  detail: JobDetail | null
  /** The next job that needs attention, for "Next: MM-0152" after Acknowledge. */
  nextAttention?: JobId | null
  /** Moves focus to the job's table row after a decision. */
  onFocusRow?: (id: JobId) => void
  /** Focuses the inspector's tab list after Acknowledge when no other job needs attention. */
  onFocusTabs?: () => void
  /** Selects a job and focuses its row: the "Next" button. */
  onSelectJob?: (id: JobId) => void
  /** Unlocks the Recipe tab as the next attempt's draft. */
  onEditAndRetry?: (id: JobId) => void
  /** Opens Logs; the actions context's showLog by default. */
  onShowLog?: ShowLog
  /** Shows a path in the file manager. */
  onReveal?: (path: string) => void
  /** Writes text to the clipboard; the system clipboard by default. */
  onCopy?: (text: string) => void | Promise<void>
  /** Runs after a copy, for the page's "Copied ..." toast. */
  onCopied?: (kind: CopiedKind) => void
  className?: string
}

async function writeClipboard(text: string): Promise<void>
{
  await navigator.clipboard.writeText(text)
}

function Caption({ id, children }: { id?: string; children: string }): React.JSX.Element
{
  return (
    <h4 id={id} className='type-legend text-brass'>
      <CapsText>{children}</CapsText>
    </h4>
  )
}

function FactList({ caption, facts }: { caption: string; facts: readonly LiveFact[] }): React.JSX.Element
{
  const captionId = `${useId()}-caption`
  return (
    <section aria-labelledby={captionId} className='flex flex-col gap-1.5'>
      <Caption id={captionId}>{caption}</Caption>
      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-label select-text'>
        {facts.map((fact) => (
          <React.Fragment key={fact.label}>
            <dt className='text-ink-2'>{fact.label}</dt>
            <dd className='tabular-nums text-ink'>{fact.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  )
}

interface RetryAck
{
  jobId: JobId
  ack: Ack
  checked: boolean
}

/**
 * The inspector's Result tab for one job: the StageTrack, live numbers while it runs, then the stamp with the
 * sentences Verify wrote, the before, plan, and after table, sizes and the output path; for a failure the full
 * error, FFmpeg's output tail, the command, the exit code, and the attempts; and the recovery actions or decisions.
 */
export function ResultTab({
  job,
  detail,
  nextAttention = null,
  onFocusRow = focusJobRow,
  onFocusTabs,
  onSelectJob,
  onEditAndRetry,
  onShowLog,
  onReveal,
  onCopy = writeClipboard,
  onCopied,
  className
}: ResultTabProps): React.JSX.Element
{
  const actions = useBatchActions()
  const platform = usePlatform()
  const [acknowledged, setAcknowledged] = useState<{ jobId: JobId; next: JobId | null } | null>(null)
  const [retryAck, setRetryAck] = useState<RetryAck | null>(null)
  const [busy, setBusy] = useState(false)
  const nextButton = useRef<HTMLButtonElement>(null)
  const focusAfterAcknowledge = useRef(false)
  const phase = resultPhase(job)
  const showLog = onShowLog ?? contextShowLog(actions)
  const done = acknowledged !== null && acknowledged.jobId === job.id ? acknowledged : null
  const pendingAck = retryAck !== null && retryAck.jobId === job.id ? retryAck : null
  const error = detail?.error ?? null
  const words = showsStamp(job) ? stampWords(job) : null
  const sentences = phase === 'done' || phase === 'held' ? resultSentences(job, detail) : []
  const result = phase === 'done' ? detail?.result ?? null : null

  useEffect(() =>
  {
    if (!focusAfterAcknowledge.current)
    {
      return
    }
    focusAfterAcknowledge.current = false
    if (nextButton.current !== null)
    {
      nextButton.current.focus()
    }
    else
    {
      onFocusTabs?.()
    }
  }, [acknowledged, onFocusTabs])

  const acknowledge = async (): Promise<void> =>
  {
    setBusy(true)
    try
    {
      const outcome = await actions.acknowledge([job.id])
      if (outcome.status === 'done')
      {
        focusAfterAcknowledge.current = true
        setAcknowledged({ jobId: job.id, next: nextAttention })
      }
    }
    finally
    {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> =>
  {
    setBusy(true)
    try
    {
      const outcome = await actions.retry([job.id], pendingAck === null ? {} : { ack: pendingAck.ack })
      if (outcome.status === 'needs-acknowledgment')
      {
        setRetryAck({ jobId: job.id, ack: outcome.ack, checked: false })
      }
      else if (outcome.status === 'done')
      {
        setRetryAck(null)
      }
    }
    finally
    {
      setBusy(false)
    }
  }

  const copyError = async (): Promise<void> =>
  {
    const text = error !== null
      ? copyErrorText(error, failedCommand(error, detail?.commands))
      : job.error === null ? '' : `${job.error.message}\nReason: ${job.error.short}`
    if (text === '')
    {
      return
    }
    try
    {
      await onCopy(text)
    }
    catch
    {
      return
    }
    onCopied?.('error')
  }

  const canAcknowledge = needsAttention(job) && !needsDecision(job) && done === null
  const canRetry = phase === 'failed' || phase === 'interrupted' || phase === 'canceled' || phase === 'skipped' || (phase === 'done' && needsAttention(job))
  const canEdit = onEditAndRetry !== undefined && (phase === 'failed' || phase === 'interrupted' || phase === 'done')
  const canCopyError = phase === 'failed' && (error !== null || job.error !== null)
  const canShowLog = showLog !== undefined && phase !== 'not-started'
  const hasActions = canRetry || canEdit || canCopyError || canShowLog || canAcknowledge || done !== null

  return (
    <div className={cx('flex flex-col gap-4', className)} data-phase={phase}>
      <StageTrack stages={trackStages(job, detail)} />

      {phase === 'not-started' && (
        <p className='text-label text-ink-2'>{job.state === 'queued' ? queuedText(job) : RESULT_WORDS.notStarted}</p>
      )}
      {phase === 'canceled' && <p className='text-label text-ink-2'>{RESULT_WORDS.canceled}</p>}
      {phase === 'skipped' && <p className='text-label text-ink-2'>{RESULT_WORDS.skipped}</p>}

      {phase === 'running' && job.progress !== null && <FactList caption={RESULT_WORDS.live} facts={liveFacts(job.progress)} />}

      {words !== null && (
        <div className='flex flex-col items-start gap-1.5' data-part='stamp'>
          <Stamp outcome={words.tone} values={words.values} size='md' tooltip={words.tooltip ?? undefined} />
          {words.tooltip !== null && <p className='text-label text-ink-3 select-text'>{words.tooltip}</p>}
        </div>
      )}

      {sentences.length > 0 && (
        <div className='flex flex-col gap-1 select-text' data-part='sentences'>
          {sentences.map((sentence) => <p key={sentence} className='text-body text-ink'>{sentence}</p>)}
        </div>
      )}

      {phase === 'held' && job.hold !== null && (
        <div className='flex flex-col gap-2'>
          <p className='text-body text-ink select-text'>{job.hold.message}</p>
          <DecisionButtons job={job} onFocusRow={onFocusRow} onNeedsAcknowledgment={(ack) => setRetryAck({ jobId: job.id, ack, checked: false })} />
        </div>
      )}

      {phase === 'failed' && error !== null && (
        <ErrorDetail
          error={error}
          detail={detail ?? { stages: [], commands: [], stderrTail: null }}
          onCopy={onCopy}
          onCopied={(kind) => onCopied?.(kind)}
          onFullOutput={showLog === undefined ? undefined : () => showLog(job.id, { attempt: error.attempt })}
        />
      )}
      {phase === 'failed' && error === null && job.error !== null && (
        <p className='text-body text-ink select-text'>{job.error.message}</p>
      )}
      {phase === 'interrupted' && <p className='text-body text-ink select-text'>{RESULT_WORDS.interrupted}</p>}

      {(detail?.measurement != null || detail?.verification?.audio != null) && (
        <BeforePlanAfterTable measurement={detail?.measurement ?? null} verification={detail?.verification ?? null} unit={jobUnit(job)} />
      )}

      {result !== null && (
        <>
          <FactList caption={RESULT_WORDS.sizes} facts={sizeFacts(result)} />
          <section className='flex flex-col items-start gap-1.5' aria-label={RESULT_WORDS.output}>
            <Caption>{RESULT_WORDS.output}</Caption>
            <p className='break-all text-label text-ink-2 select-text'>{result.outputPath}</p>
            {onReveal !== undefined && (
              <Button variant='secondary' size='sm' icon='action.reveal' onClick={() => onReveal(result.outputPath)}>
                {revealLabel(platform)}
              </Button>
            )}
          </section>
        </>
      )}

      {detail !== null && (phase === 'failed' || phase === 'interrupted' || phase === 'held' || detail.attempts.length > 0) && (
        <Attempts records={detail.attempts} job={job} />
      )}

      {pendingAck !== null && (
        <AcknowledgmentCheck
          facts={{
            originals: pendingAck.ack.originalsAffected,
            overwrites: pendingAck.ack.overwrites,
            originalsByVolume: pendingAck.ack.originalsAffected > 0 ? [{ volume: volumeOf(job.source.path), count: pendingAck.ack.originalsAffected }] : [],
            keepOld: false,
            platform
          }}
          volumes={[]}
          checked={pendingAck.checked}
          onChange={(checked) => setRetryAck({ ...pendingAck, checked })}
        />
      )}

      {hasActions && (
        <div role='group' aria-label={RESULT_WORDS.actions} className='flex flex-wrap items-center gap-2' data-part='actions'>
          {canRetry && (
            <Button
              variant='secondary'
              size='sm'
              icon='action.retry'
              disabled={busy || (pendingAck !== null && !pendingAck.checked)}
              onClick={() => { void retry() }}
            >
              {RESULT_WORDS.retry}
            </Button>
          )}
          {canEdit && (
            <Button variant='secondary' size='sm' icon='action.edit' disabled={busy} onClick={() => onEditAndRetry?.(job.id)}>
              {RESULT_WORDS.editAndRetry}
            </Button>
          )}
          {canShowLog && (
            <Button variant='ghost' size='sm' icon='action.showLog' onClick={() => showLog?.(job.id)}>
              {RESULT_WORDS.showLog}
            </Button>
          )}
          {canCopyError && (
            <Button variant='ghost' size='sm' icon='action.copy' onClick={() => { void copyError() }}>
              {RESULT_WORDS.copyError}
            </Button>
          )}
          {canAcknowledge && (
            <Button variant='secondary' size='sm' icon='action.acknowledge' disabled={busy} onClick={() => { void acknowledge() }}>
              {RESULT_WORDS.acknowledge}
            </Button>
          )}
          {done !== null && done.next !== null && (
            <Button ref={nextButton} variant='secondary' size='sm' iconEnd='action.next' onClick={() => onSelectJob?.(done.next as JobId)}>
              {nextLabel(done.next)}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
