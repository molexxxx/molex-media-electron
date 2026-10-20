/**
 * The window's undo history of queue edits: adds, removals, recipe changes, duplicates, reorders, clears, and
 * output settings changes. Each entry carries what its inverse commands need, so one undo reverts an edit across
 * every job it touched in one step, and the reverted edit moves to the redo stack. Run actions never enter it.
 * The history lives in the window, so a reload clears it.
 */
import type { CommandError, CommandResult, JobRefusal, JobRefusalCode, JobsApi } from '../../../shared/jobs/contract'
import type { JobId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import type { BatchPolicy, JobState } from '../../../shared/jobs/types'
import type { JobsState } from './jobs'

/** The most queue edits each stack keeps; older ones fall off. */
export const UNDO_LIMIT = 50

/** The refusal for a restore main no longer keeps (50 operations or 10 minutes). */
export const RESTORE_EXPIRED_MESSAGE = 'Cannot undo: removed jobs can be restored for 10 minutes.'

/** The same refusal when a redo would restore jobs the undo removed. */
export const REDO_EXPIRED_MESSAGE = 'Cannot redo: removed jobs can be restored for 10 minutes.'

/** The output settings a policy change set, without the revision main assigns. */
export type PolicyInput = Omit<BatchPolicy, 'rev'>

/** One job's recipe before and after a recipe edit. */
export interface RecipeChange
{
  jobId: JobId
  before: Recipe
  after: Recipe
}

/**
 * One queue edit and what reverting or repeating it needs. `tombstone` names the tombstone that holds the edit's
 * jobs while they are removed: set for a removal on the undo stack and for an add on the redo stack, null otherwise.
 */
export type QueueEdit =
  | { kind: 'add'; ids: JobId[]; tombstone: string | null }
  | { kind: 'duplicate'; ids: JobId[]; tombstone: string | null }
  | { kind: 'remove'; ids: JobId[]; tombstone: string | null }
  | { kind: 'clear'; ids: JobId[]; count: number; tombstone: string | null }
  | { kind: 'recipe'; changes: RecipeChange[] }
  | { kind: 'reorder'; ids: JobId[]; before: JobId | null; previous: JobId[] }
  | { kind: 'policy'; before: PolicyInput; after: PolicyInput }

/** A recorded edit. */
export interface UndoEntry
{
  readonly id: number
  readonly edit: QueueEdit
}

/** Which way an entry runs. */
export type UndoDirection = 'undo' | 'redo'

/** The commands undo and redo send. */
export type UndoApi = Pick<JobsApi, 'remove' | 'restore' | 'assignRecipe' | 'reorder' | 'setPolicy' | 'clear'>

/** What running an entry needs. */
export interface UndoDeps
{
  api: UndoApi
  getJobs(): JobsState
}

/** What one direction of an entry did. */
export interface UndoStep
{
  /** The edit for the opposite stack; null when nothing was applied. */
  inverse: QueueEdit | null
  /** The refusal to show when the edit could not be reverted for some or all of its jobs. */
  refusal: string | null
  /** True when the whole command failed for a reason that can pass, so the entry stays where it was. */
  retain: boolean
  /** The last event seq the commands caused; 0 when none. */
  seq: number
}

/** What an undo or a redo did, worded for the page. */
export type UndoOutcome =
  | { status: 'empty' }
  | { status: 'done'; label: string; refusal: string | null; seq: number }
  | { status: 'refused'; label: string; message: string }

/** The window's undo and redo stacks. */
export interface UndoHistory
{
  canUndo(): boolean
  canRedo(): boolean
  /** The undo stack, oldest first. */
  entries(): readonly UndoEntry[]
  /** The redo stack, oldest first. */
  redoEntries(): readonly UndoEntry[]
  /** Records a new edit on top of the undo stack and clears the redo stack. */
  record(edit: QueueEdit): UndoEntry
  /** Replaces a recorded edit, such as an add whose folder scan found more jobs; false when it is gone. */
  amend(id: number, update: (edit: QueueEdit) => QueueEdit): boolean
  /** Reverts the latest edit, or the given one wherever it is on the stack (a toast's Undo). */
  undo(id?: number): Promise<UndoOutcome>
  /** Applies the latest reverted edit again. */
  redo(): Promise<UndoOutcome>
  clear(): void
  /** Calls the listener after every change to either stack; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

const STARTED_CODES: ReadonlySet<JobRefusalCode> = new Set<JobRefusalCode>([
  'job-running', 'job-finalizing', 'job-held', 'job-terminal', 'not-movable', 'needs-attention', 'needs-decision'
])

const LASTING_ERRORS: ReadonlySet<CommandError['code']> = new Set<CommandError['code']>(['restore-expired', 'invalid-payload', 'not-found'])

const EDITABLE: ReadonlySet<JobState> = new Set<JobState>(['pending'])

const MOVABLE: ReadonlySet<JobState> = new Set<JobState>(['pending', 'queued'])

/** "1 job", "1,204 files". */
export function countOf(n: number, noun: string, plural: string = `${noun}s`): string
{
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : plural}`
}

/** A command's reply; a rejected or thrown call becomes an internal error, so no caller sees a rejection. */
export async function settleCommand<T>(call: () => Promise<CommandResult<T>>): Promise<CommandResult<T>>
{
  try
  {
    return await call()
  }
  catch (error)
  {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: { code: 'internal', message, issues: [], details: null } }
  }
}

/** The output settings a policy change sends: the policy without its revision. */
export function policyInput(policy: BatchPolicy): PolicyInput
{
  const copy: Partial<BatchPolicy> = { ...policy }
  delete copy.rev
  return copy as PolicyInput
}

/** What an edit did, as a phrase for "Undid ..." and "Redid ...". */
export function editLabel(edit: QueueEdit): string
{
  switch (edit.kind)
  {
    case 'add':
      return `adding ${countOf(edit.ids.length, 'file')}`
    case 'duplicate':
      return `duplicating ${countOf(edit.ids.length, 'job')}`
    case 'remove':
      return `removing ${countOf(edit.ids.length, 'job')}`
    case 'clear':
      return `clearing ${countOf(edit.count, 'job')}`
    case 'recipe':
      return `the settings change for ${countOf(edit.changes.length, 'job')}`
    case 'reorder':
      return `moving ${countOf(edit.ids.length, 'job')}`
    default:
      return 'the output settings change'
  }
}

/** The refusal for jobs that left the queue's editable states since the edit. */
export function startedRefusal(direction: UndoDirection, count: number): string | null
{
  return count === 0 ? null : `Cannot ${direction} for ${countOf(count, 'job')} that already started.`
}

function refusalFor(direction: UndoDirection, startedLocally: number, refused: readonly JobRefusal[]): string | null
{
  const started = startedLocally + refused.filter((refusal) => STARTED_CODES.has(refusal.code)).length
  if (started > 0)
  {
    return startedRefusal(direction, started)
  }
  const other = refused.find((refusal) => refusal.code !== 'not-found')
  return other === undefined ? null : other.message
}

function failure(direction: UndoDirection, error: CommandError): UndoStep
{
  if (error.code === 'restore-expired')
  {
    return { inverse: null, refusal: direction === 'undo' ? RESTORE_EXPIRED_MESSAGE : REDO_EXPIRED_MESSAGE, retain: false, seq: 0 }
  }
  return { inverse: null, refusal: error.message, retain: !LASTING_ERRORS.has(error.code), seq: 0 }
}

function nothing(refusal: string | null): UndoStep
{
  return { inverse: null, refusal, retain: false, seq: 0 }
}

/** Splits ids into jobs still in an allowed state and a count of jobs that left it; jobs that are gone drop out. */
function partition(state: JobsState, ids: readonly JobId[], allowed: ReadonlySet<JobState>): { live: JobId[]; started: number }
{
  const live: JobId[] = []
  let started = 0
  for (const id of ids)
  {
    const job = state.jobs[id]
    if (job === undefined)
    {
      continue
    }
    if (allowed.has(job.state))
    {
      live.push(id)
    }
    else
    {
      started += 1
    }
  }
  return { live, started }
}

/**
 * The reorder commands that put moved jobs back where `previous` had them. Each run of moved jobs goes before the
 * next job that did not move and is still present; a run at the end goes before whatever now follows the last such
 * job. Jobs that left `current` or appear in `skip` are not moved.
 */
export function restoreOrderCommands(
  moved: readonly JobId[],
  previous: readonly JobId[],
  current: readonly JobId[],
  skip: ReadonlySet<JobId> = new Set()
): Array<{ ids: JobId[]; before: JobId | null }>
{
  const movedSet = new Set(moved)
  const present = new Set(current)
  const commands: Array<{ ids: JobId[]; before: JobId | null }> = []
  let run: JobId[] = []
  let lastAnchor: JobId | null = null
  for (const id of previous)
  {
    if (movedSet.has(id))
    {
      if (present.has(id) && !skip.has(id))
      {
        run.push(id)
      }
      continue
    }
    if (!present.has(id))
    {
      continue
    }
    if (run.length > 0)
    {
      commands.push({ ids: run, before: id })
      run = []
    }
    lastAnchor = id
  }
  if (run.length > 0)
  {
    const start = lastAnchor === null ? 0 : current.indexOf(lastAnchor) + 1
    const next = current.slice(start).find((id) => !movedSet.has(id)) ?? null
    commands.push({ ids: run, before: next })
  }
  return commands
}

async function removeJobs(deps: UndoDeps, kind: 'add' | 'duplicate' | 'remove', ids: readonly JobId[], direction: UndoDirection): Promise<UndoStep>
{
  const { live, started } = partition(deps.getJobs(), ids, EDITABLE)
  if (live.length === 0)
  {
    return nothing(startedRefusal(direction, started))
  }
  const reply = await settleCommand(() => deps.api.remove({ ids: live }))
  if (!reply.ok)
  {
    return failure(direction, reply.error)
  }
  const { applied, refused, tombstone } = reply.value
  const inverse: QueueEdit | null = applied.length > 0 && tombstone !== null ? { kind, ids: applied, tombstone } : null
  return { inverse, refusal: refusalFor(direction, started, refused), retain: false, seq: reply.seq }
}

async function restoreJobs(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'add' | 'duplicate' | 'remove' | 'clear' }>, direction: UndoDirection): Promise<UndoStep>
{
  if (edit.tombstone === null)
  {
    return nothing(null)
  }
  const tombstone = edit.tombstone
  const reply = await settleCommand(() => deps.api.restore({ tombstone }))
  if (!reply.ok)
  {
    return failure(direction, reply.error)
  }
  const { applied, refused } = reply.value
  let inverse: QueueEdit | null = null
  if (applied.length > 0)
  {
    inverse = edit.kind === 'clear'
      ? { kind: 'clear', ids: applied, count: applied.length, tombstone: null }
      : { kind: edit.kind, ids: applied, tombstone: null }
  }
  return { inverse, refusal: refusalFor(direction, 0, refused), retain: false, seq: reply.seq }
}

async function clearAgain(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'clear' }>, direction: UndoDirection): Promise<UndoStep>
{
  const present = edit.ids.filter((id) => deps.getJobs().jobs[id] !== undefined)
  if (present.length === 0)
  {
    return nothing(null)
  }
  const reply = await settleCommand(() => deps.api.clear({ scope: { kind: 'ids', ids: present } }))
  if (!reply.ok)
  {
    return failure(direction, reply.error)
  }
  const { removed, tombstone } = reply.value
  const inverse: QueueEdit | null = removed > 0 && tombstone !== null ? { kind: 'clear', ids: present, count: removed, tombstone } : null
  return { inverse, refusal: null, retain: false, seq: reply.seq }
}

async function assignAgain(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'recipe' }>, direction: UndoDirection): Promise<UndoStep>
{
  const ids = edit.changes.map((change) => change.jobId)
  const { live, started } = partition(deps.getJobs(), ids, EDITABLE)
  const usable = new Set(live)
  const changes = edit.changes.filter((change) => usable.has(change.jobId))
  if (changes.length === 0)
  {
    return nothing(startedRefusal(direction, started))
  }
  const assignments = changes.map((change) => ({ jobId: change.jobId, recipe: direction === 'undo' ? change.before : change.after }))
  const reply = await settleCommand(() => deps.api.assignRecipe({ assignments }))
  if (!reply.ok)
  {
    return failure(direction, reply.error)
  }
  const applied = new Set(reply.value.applied)
  const kept = changes.filter((change) => applied.has(change.jobId))
  const inverse: QueueEdit | null = kept.length > 0 ? { kind: 'recipe', changes: kept } : null
  return { inverse, refusal: refusalFor(direction, started, reply.value.refused), retain: false, seq: reply.seq }
}

async function moveBack(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'reorder' }>): Promise<UndoStep>
{
  const state = deps.getJobs()
  const { live, started } = partition(state, edit.ids, MOVABLE)
  const liveSet = new Set(live)
  const skip = new Set(edit.ids.filter((id) => !liveSet.has(id)))
  const commands = restoreOrderCommands(edit.ids, edit.previous, state.order, skip)
  if (commands.length === 0)
  {
    return nothing(startedRefusal('undo', started))
  }
  const applied: JobId[] = []
  const refused: JobRefusal[] = []
  let seq = 0
  for (const command of commands)
  {
    const reply = await settleCommand(() => deps.api.reorder(command))
    if (!reply.ok)
    {
      if (applied.length === 0)
      {
        return failure('undo', reply.error)
      }
      break
    }
    applied.push(...reply.value.applied)
    refused.push(...reply.value.refused)
    seq = Math.max(seq, reply.seq)
  }
  const inverse: QueueEdit | null = applied.length > 0 ? { kind: 'reorder', ids: applied, before: edit.before, previous: edit.previous } : null
  return { inverse, refusal: refusalFor('undo', started, refused), retain: false, seq }
}

async function moveAgain(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'reorder' }>): Promise<UndoStep>
{
  const state = deps.getJobs()
  const { live, started } = partition(state, edit.ids, MOVABLE)
  if (live.length === 0)
  {
    return nothing(startedRefusal('redo', started))
  }
  const previous = [...state.order]
  const reply = await settleCommand(() => deps.api.reorder({ ids: live, before: edit.before }))
  if (!reply.ok)
  {
    return failure('redo', reply.error)
  }
  const applied = reply.value.applied
  const inverse: QueueEdit | null = applied.length > 0 ? { kind: 'reorder', ids: applied, before: edit.before, previous } : null
  return { inverse, refusal: refusalFor('redo', started, reply.value.refused), retain: false, seq: reply.seq }
}

async function setPolicyAgain(deps: UndoDeps, edit: Extract<QueueEdit, { kind: 'policy' }>, direction: UndoDirection): Promise<UndoStep>
{
  const policy = direction === 'undo' ? edit.before : edit.after
  const reply = await settleCommand(() => deps.api.setPolicy({ policy }))
  if (!reply.ok)
  {
    return failure(direction, reply.error)
  }
  return { inverse: edit, refusal: null, retain: false, seq: reply.seq }
}

/** Runs one direction of an edit: the undo reverts it, the redo applies it again. */
export async function runEdit(deps: UndoDeps, edit: QueueEdit, direction: UndoDirection): Promise<UndoStep>
{
  switch (edit.kind)
  {
    case 'add':
    case 'duplicate':
      return direction === 'undo' ? removeJobs(deps, edit.kind, edit.ids, direction) : restoreJobs(deps, edit, direction)
    case 'remove':
      return direction === 'undo' ? restoreJobs(deps, edit, direction) : removeJobs(deps, 'remove', edit.ids, direction)
    case 'clear':
      return direction === 'undo' ? restoreJobs(deps, edit, direction) : clearAgain(deps, edit, direction)
    case 'recipe':
      return assignAgain(deps, edit, direction)
    case 'reorder':
      return direction === 'undo' ? moveBack(deps, edit) : moveAgain(deps, edit)
    default:
      return setPolicyAgain(deps, edit, direction)
  }
}

function pushLimited(stack: UndoEntry[], entry: UndoEntry, limit: number): void
{
  stack.push(entry)
  if (stack.length > limit)
  {
    stack.splice(0, stack.length - limit)
  }
}

/**
 * An undo history over the given commands and jobs. Undo and redo run one at a time in the order asked, so a
 * second Ctrl+Z waits for the first to settle.
 */
export function createUndoHistory(deps: UndoDeps, limit: number = UNDO_LIMIT): UndoHistory
{
  const undoStack: UndoEntry[] = []
  const redoStack: UndoEntry[] = []
  const listeners = new Set<() => void>()
  let nextId = 1
  let chain: Promise<unknown> = Promise.resolve()

  function emit(): void
  {
    for (const listener of [...listeners])
    {
      listener()
    }
  }

  function entry(edit: QueueEdit): UndoEntry
  {
    const made = { id: nextId, edit }
    nextId += 1
    return made
  }

  function serial<T>(task: () => Promise<T>): Promise<T>
  {
    const result = chain.then(task, task)
    chain = result.catch(() => undefined)
    return result
  }

  async function step(from: UndoEntry[], to: UndoEntry[], direction: UndoDirection, id?: number): Promise<UndoOutcome>
  {
    const index = id === undefined ? from.length - 1 : from.findIndex((candidate) => candidate.id === id)
    if (index < 0)
    {
      return { status: 'empty' }
    }
    const [taken] = from.splice(index, 1)
    const label = editLabel(taken.edit)
    const result = await runEdit(deps, taken.edit, direction)
    if (result.retain)
    {
      from.splice(Math.min(index, from.length), 0, taken)
    }
    if (result.inverse !== null)
    {
      pushLimited(to, entry(result.inverse), limit)
    }
    emit()
    if (result.inverse === null)
    {
      return { status: 'refused', label, message: result.refusal ?? `Nothing to ${direction}.` }
    }
    return { status: 'done', label, refusal: result.refusal, seq: result.seq }
  }

  return {
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    entries: () => [...undoStack],
    redoEntries: () => [...redoStack],
    record(edit: QueueEdit): UndoEntry
    {
      const made = entry(edit)
      pushLimited(undoStack, made, limit)
      redoStack.length = 0
      emit()
      return made
    },
    amend(id: number, update: (edit: QueueEdit) => QueueEdit): boolean
    {
      const index = undoStack.findIndex((candidate) => candidate.id === id)
      if (index < 0)
      {
        return false
      }
      undoStack[index] = { id, edit: update(undoStack[index].edit) }
      emit()
      return true
    },
    undo: (id?: number) => serial(() => step(undoStack, redoStack, 'undo', id)),
    redo: () => serial(() => step(redoStack, undoStack, 'redo')),
    clear(): void
    {
      undoStack.length = 0
      redoStack.length = 0
      emit()
    },
    subscribe(listener: () => void): () => void
    {
      listeners.add(listener)
      return () =>
      {
        listeners.delete(listener)
      }
    }
  }
}
