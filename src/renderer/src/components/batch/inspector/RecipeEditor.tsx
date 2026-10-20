/**
 * The field set of the Recipe tab for the selected jobs of one operation: it renders each field from the field-state
 * model, applies one-field patches to the editable jobs, states consequences before anything is applied, shows locked
 * jobs read-only with their reason, and edits a returned job as an attempt draft after "Edit and retry".
 */
import { useId, useMemo, useRef, type ReactElement } from 'react'
import type { Operation } from '../../../../../shared/jobs/recipes'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { JobMeasurement, JobView } from '../../../../../shared/jobs/types'
import type { BatchActions, DraftCommit } from '../../../stores/batchActions'
import
{
  editField,
  jobLock,
  lockReason,
  recipeFields,
  splitSelection,
  type FieldPatch,
  type FieldState,
  type RecipeContext
} from '../../../stores/recipeFields'
import { Button, FieldMessage } from '../../../ui'
import type { CommitDraftResult } from '../../../ui/NumberField'
import { useBatchActions } from '../BatchActionsContext'
import { CompressFields } from './fields/CompressFields'
import { ConvertFields, type PatchHandler } from './fields/ConvertFields'
import { ExtractFields } from './fields/ExtractFields'
import { GainFields, type GainPrediction } from './fields/GainFields'
import { DraftRegistryContext, NormalizeFields, type DraftRegistry } from './fields/NormalizeFields'

/** What an assignRecipes call resolves to. */
export type AssignOutcome = Awaited<ReturnType<BatchActions['assignRecipes']>>

/** The last field edit the editor sent, so a primary action can wait for it. */
export interface SentEdit
{
  field: string
  promise: PromiseLike<AssignOutcome>
  settled: boolean
}

/**
 * The selection as the recipe model sees it: a finished job being edited for its next attempt counts as editable,
 * because "Edit and retry" unlocks it.
 */
export function draftSelection(jobs: readonly JobView[], drafts: ReadonlySet<JobId>): JobView[]
{
  return jobs.map((job) => (drafts.has(job.id) && jobLock(job) === 'finished' ? { ...job, state: 'pending' as const } : job))
}

/** Whether an edit of the selection must also reach finished jobs, which then wait in the queue for their next attempt. */
export function needsRetryDraft(jobs: readonly JobView[], drafts: ReadonlySet<JobId>): boolean
{
  return jobs.some((job) => drafts.has(job.id) && jobLock(job) === 'finished')
}

/** The note over an attempt draft: "Editing MM-0139 for attempt 2. Attempt 1 stays in the record." */
export function attemptNote(jobs: readonly JobView[], drafts: ReadonlySet<JobId>): string | null
{
  const editing = jobs.filter((job) => drafts.has(job.id))
  if (editing.length === 0)
  {
    return null
  }
  if (editing.length === 1)
  {
    const job = editing[0]
    return `Editing ${job.id} for attempt ${job.attempt + 1}. Attempt ${job.attempt} stays in the record.`
  }
  return `Editing ${editing.length} jobs for their next attempt. Earlier attempts stay in the record.`
}

/** Why every selected job keeps its recipe, with the action that frees the queued ones. */
export interface SelectionLock
{
  text: string
  /** "Take out of Batch 31", offered when the jobs are queued in one batch. */
  action: string | null
  /** The queued jobs the action takes out of their batch. */
  queued: JobId[]
}

/** The lock of a selection whose jobs are all in a batch; null while any selected job can be edited. */
export function selectionLock(jobs: readonly JobView[]): SelectionLock | null
{
  const { editable, locked } = splitSelection(jobs)
  if (editable.length > 0 || locked.length === 0)
  {
    return null
  }
  const reasons = locked.map((job) => lockReason(job) as { text: string; action: string | null })
  const first = reasons[0]
  if (reasons.every((reason) => reason.text === first.text))
  {
    return { text: first.text, action: first.action, queued: first.action === null ? [] : locked.filter((job) => jobLock(job) === 'queued').map((job) => job.id) }
  }
  return { text: `${locked.length} queued, running, or finished jobs keep their settings.`, action: null, queued: [] }
}

/** Fields of a locked selection without the lock reason each would repeat, since the editor states it once above them. */
export function withoutLockReason(fields: readonly FieldState[], lock: SelectionLock | null): FieldState[]
{
  if (lock === null)
  {
    return [...fields]
  }
  const strip = (field: FieldState): FieldState =>
  {
    const nested = field.nested === null ? null : strip(field.nested)
    return field.reason === lock.text ? { ...field, reason: null, nested } : { ...field, nested }
  }
  return fields.map(strip)
}

/** The caption of the field a patch sets, looking inside nested fields such as the limiting allowance. */
export function patchLabel(fields: readonly FieldState[], patch: FieldPatch): string
{
  for (const field of fields)
  {
    if (field.key === patch.field)
    {
      return field.label
    }
    if (field.nested !== null && field.nested.key === patch.field)
    {
      return field.nested.label
    }
  }
  return 'Settings'
}

/**
 * Hands the focused field's draft to the page's committer. A valid draft resolves with the seq of the assignment it
 * sent, or of the one its blur already sent, so the action waits until main has applied it; an invalid draft refuses
 * the action and names the field.
 */
export function draftRegistry(actions: Pick<BatchActions, 'registerDraftCommitter'>, last: { current: SentEdit | null }): DraftRegistry
{
  return {
    register(label: string, commitDraft: () => Promise<CommitDraftResult>): () => void
    {
      return actions.registerDraftCommitter(async (): Promise<DraftCommit> =>
      {
        const before = last.current
        const inFlight = before !== null && !before.settled ? before : null
        const result = await commitDraft()
        if (result === 'invalid')
        {
          return { status: 'invalid', field: label }
        }
        const sent = last.current !== before ? last.current : inFlight
        if (sent === null)
        {
          return { status: 'none' }
        }
        const outcome = await sent.promise
        return outcome.status === 'done'
          ? { status: 'committed', seq: outcome.seq, field: sent.field, ids: outcome.value.applied }
          : { status: 'none' }
      })
    }
  }
}

/** What the predicted peak limiting line knows: one job's measured source peak, several jobs, or nothing yet. */
export function gainPrediction(jobs: readonly JobView[], measurement: JobMeasurement | null): GainPrediction
{
  if (jobs.length > 1)
  {
    return { kind: 'several' }
  }
  const source = measurement !== null && measurement.pass !== 'after-dynamics' ? measurement.streams : []
  const peaks = source
    .map((stream) => stream.measurement.stats.truePeakDbtp)
    .filter((peak): peak is number => peak !== null)
  return peaks.length === 0 ? { kind: 'unmeasured' } : { kind: 'measured', truePeak: Math.max(...peaks) }
}

/** Props of {@link LockNotice}. */
export interface LockNoticeProps
{
  lock: SelectionLock
  onTakeOut(ids: JobId[]): void
}

/** Why the selected jobs are read-only, with "Take out of Batch {b}" for queued jobs. */
export function LockNotice({ lock, onTakeOut }: LockNoticeProps): ReactElement
{
  const id = useId()
  return (
    <div className='flex flex-col items-start gap-2' data-recipe-lock=''>
      <FieldMessage id={id} tone='note'>{lock.text}</FieldMessage>
      {lock.action !== null && lock.queued.length > 0
        ? <Button variant='secondary' size='sm' onClick={() => onTakeOut(lock.queued)}>{lock.action}</Button>
        : null}
    </div>
  )
}

/** The note over an attempt draft. */
export function AttemptNote({ text }: { text: string }): ReactElement
{
  return <p className='text-body text-ink-2' data-attempt-draft=''>{text}</p>
}

/** Props of {@link RecipeEditor}. */
export interface RecipeEditorProps
{
  /** The selected jobs as the model sees them; see {@link draftSelection}. */
  jobs: readonly JobView[]
  op: Operation
  ctx: RecipeContext
  /** The selected job's measurement, for the predicted peak limiting line. */
  measurement?: JobMeasurement | null
}

/**
 * The fields of the selected jobs' operation. Each gesture sets one field on every editable selected job; the focused
 * field registers its draft with the page, so every primary action commits it first.
 */
export function RecipeEditor({ jobs, op, ctx, measurement = null }: RecipeEditorProps): ReactElement
{
  const actions = useBatchActions()
  const last = useRef<SentEdit | null>(null)
  const registry = useMemo(() => draftRegistry(actions, last), [actions])
  const lock = selectionLock(jobs)
  const fields = withoutLockReason(recipeFields(jobs, op, ctx), lock)
  const onPatch: PatchHandler = (patch) =>
  {
    const edit = editField(jobs, patch, ctx)
    if (edit.assignments.length === 0)
    {
      return undefined
    }
    const field = patchLabel(fields, patch)
    const promise = actions.assignRecipes(edit.assignments, { field })
    const sent: SentEdit = { field, promise, settled: false }
    last.current = sent
    const settle = (): void =>
    {
      sent.settled = true
    }
    promise.then(settle, settle)
    return promise
  }
  const { editable } = splitSelection(jobs)
  const single = editable.length === 1 ? editable[0] : null
  const onMeasure = single !== null && single.analysis === null && measurement === null
    ? () => void actions.send('analyze', { ids: [single.id] })
    : undefined
  return (
    <DraftRegistryContext.Provider value={registry}>
      <div className='flex min-w-0 flex-col gap-6' data-recipe-editor={lock === null ? 'editable' : 'locked'}>
        <OperationFields op={op} fields={fields} onPatch={onPatch} prediction={gainPrediction(jobs, measurement)} onMeasure={onMeasure} />
      </div>
    </DraftRegistryContext.Provider>
  )
}

interface OperationFieldsProps
{
  op: Operation
  fields: FieldState[]
  onPatch: PatchHandler
  prediction: GainPrediction
  onMeasure?: () => void
}

function OperationFields({ op, fields, onPatch, prediction, onMeasure }: OperationFieldsProps): ReactElement
{
  switch (op)
  {
    case 'normalize':
      return <NormalizeFields fields={fields} onPatch={onPatch} />
    case 'boost':
      return <GainFields fields={fields} onPatch={onPatch} prediction={prediction} onMeasure={onMeasure} />
    case 'convert':
      return <ConvertFields fields={fields} onPatch={onPatch} />
    case 'compress':
      return <CompressFields fields={fields} onPatch={onPatch} />
    default:
      return <ExtractFields fields={fields} onPatch={onPatch} />
  }
}
