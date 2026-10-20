/**
 * The inspector's Recipe tab: the Operation select (with "Mixed" and the narrowing links), the Preset select with its
 * standard line, then the operation's fields. Locked jobs read as read-only with their reason, and a returned job
 * opened with "Edit and retry" reads as an attempt draft whose first change puts it back in the queue.
 */
import { useId, useMemo, type ReactElement } from 'react'
import { recipeLabel } from '../../../../../shared/jobs/describe'
import type { JobId } from '../../../../../shared/jobs/ids'
import { presetLookup } from '../../../../../shared/jobs/presets'
import type { Operation } from '../../../../../shared/jobs/recipes'
import type { JobMeasurement, JobView } from '../../../../../shared/jobs/types'
import type { BatchActions } from '../../../stores/batchActions'
import
{
  chooseOperation,
  operationField,
  operationStart,
  type OperationField,
  type RecipeContext
} from '../../../stores/recipeFields'
import { Button, FieldCaption, Select } from '../../../ui'
import { BatchActionsContext, useBatchActions } from '../BatchActionsContext'
import { PresetSelect } from './PresetSelect'
import
{
  AttemptNote,
  LockNotice,
  RecipeEditor,
  attemptNote,
  draftSelection,
  needsRetryDraft,
  selectionLock
} from './RecipeEditor'

const NO_DRAFTS: ReadonlySet<JobId> = new Set<JobId>()

/** What choosing another operation would block, one line per option: "Compress: 8 of 38 have no video stream ...". */
export function operationNotes(field: OperationField): string[]
{
  if (field.disabled)
  {
    return []
  }
  const current = field.mixed ? null : field.value
  const base = field.options.find((option) => option.value === current)?.note ?? null
  return field.options
    .filter((option) => option.value !== current && option.note !== null && option.note !== '' && option.note !== base)
    .map((option) => `${option.label}: ${option.note}`)
}

/** The actions the tab hands its controls: while it edits attempt drafts, every assignment also reaches those finished jobs. */
export function draftActions(actions: BatchActions, retryDraft: boolean): BatchActions
{
  if (!retryDraft)
  {
    return actions
  }
  return {
    ...actions,
    assignRecipes: (assignments, options = {}) => actions.assignRecipes(assignments, { ...options, retryDraft: true })
  }
}

/** Props of {@link OperationSelect}. */
export interface OperationSelectProps
{
  field: OperationField
  onChoose(op: Operation): void
}

/** The Operation select; a mixed selection reads "Mixed: 8 Normalize, 4 Compress" and checks nothing. */
export function OperationSelect({ field, onChoose }: OperationSelectProps): ReactElement
{
  const base = useId()
  const notes = operationNotes(field)
  const notesId = `${base}notes`
  return (
    <div className='flex min-w-0 flex-col' data-field='operation'>
      <FieldCaption htmlFor={`${base}control`}>{field.label}</FieldCaption>
      <Select
        id={`${base}control`}
        value={field.mixed ? null : field.value}
        nullLabel={field.mixed ? field.text : undefined}
        onChange={(value) => onChoose(value as Operation)}
        options={field.options.map((option) => ({ value: option.key, label: option.label, disabled: option.disabled || undefined }))}
        describedBy={notes.length > 0 ? notesId : undefined}
        disabled={field.disabled}
      />
      {notes.length > 0
        ? (
            <ul id={notesId} hidden>
              {notes.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )
        : null}
    </div>
  )
}

/** Props of {@link MixedOperations}. */
export interface MixedOperationsProps
{
  field: OperationField
  onSelectOnly(ids: readonly JobId[]): void
}

/** What replaces the fields while the selection mixes operations: the prompt and one "Select only" link per operation. */
export function MixedOperations({ field, onSelectOnly }: MixedOperationsProps): ReactElement
{
  const base = useId()
  const prompt = field.disabled ? 'These jobs use different operations. Narrow the selection:' : field.prompt
  return (
    <section aria-labelledby={`${base}prompt`} className='flex flex-col gap-2' data-recipe-mixed=''>
      <p id={`${base}prompt`} className='text-body text-ink-2'>{prompt}</p>
      <ul className='flex flex-col items-start gap-1'>
        {field.selectOnly.map((entry) => (
          <li key={entry.op}>
            <Button variant='ghost' size='sm' className='-ms-2' onClick={() => onSelectOnly(entry.jobIds)}>{entry.label}</Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Props of {@link RecipeTab}. */
export interface RecipeTabProps
{
  /** The selected jobs in selection order. */
  jobs: readonly JobView[]
  ctx: RecipeContext
  /** Jobs opened with "Edit and retry"; their recipes stay editable until they run again. */
  drafts?: ReadonlySet<JobId>
  /** Narrows the selection to exactly these jobs. */
  onSelectOnly(ids: readonly JobId[]): void
  /** The measurement of a one-job selection, for the predicted peak limiting line. */
  measurement?: JobMeasurement | null
  className?: string
}

/** The Recipe tab for the selected jobs; nothing for an empty selection. */
export function RecipeTab({ jobs, ctx, drafts = NO_DRAFTS, onSelectOnly, measurement = null, className }: RecipeTabProps): ReactElement | null
{
  const actions = useBatchActions()
  const view = useMemo(() => draftSelection(jobs, drafts), [jobs, drafts])
  const retryDraft = needsRetryDraft(jobs, drafts)
  const scoped = useMemo(() => draftActions(actions, retryDraft), [actions, retryDraft])
  const operation = operationField(view, ctx)
  if (operation === null)
  {
    return null
  }
  const lock = selectionLock(view)
  const note = attemptNote(jobs, drafts)
  const selection = jobs.map((job) => job.id).join(' ')
  const choose = (op: Operation): void =>
  {
    const edit = chooseOperation(view, op, ctx)
    if (edit.assignments.length === 0)
    {
      return
    }
    const label = recipeLabel(operationStart(op, ctx), presetLookup(ctx.presets.user))
    void scoped.assignRecipes(edit.assignments, { toast: { kind: 'operation', label } })
  }
  return (
    <BatchActionsContext.Provider value={scoped}>
      <div className={['flex min-w-0 flex-col gap-5', className].filter(Boolean).join(' ')} data-recipe-tab=''>
        {note !== null ? <AttemptNote text={note} /> : null}
        {lock !== null ? <LockNotice lock={lock} onTakeOut={(ids) => void actions.takeOut(ids)} /> : null}
        <OperationSelect field={operation} onChoose={choose} />
        {operation.mixed
          ? <MixedOperations field={operation} onSelectOnly={onSelectOnly} />
          : (
              <>
                <PresetSelect jobs={view} op={operation.value} ctx={ctx} />
                <RecipeEditor key={selection} jobs={view} op={operation.value} ctx={ctx} measurement={measurement} />
              </>
            )}
      </div>
    </BatchActionsContext.Provider>
  )
}
