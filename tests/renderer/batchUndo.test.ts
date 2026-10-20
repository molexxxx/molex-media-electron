/**
 * The queue edit history: one undo reverts an edit across every job it touched in one command, jobs that started
 * since are refused with a counted message, an expired restore is refused with the fixed wording, and redo applies
 * the reverted edit again.
 */
import { describe, it, expect, vi } from 'vitest'
import { createJobsStore } from '../../src/renderer/src/stores/jobs'
import
{
  REDO_EXPIRED_MESSAGE,
  RESTORE_EXPIRED_MESSAGE,
  UNDO_LIMIT,
  countOf,
  createUndoHistory,
  editLabel,
  policyInput,
  restoreOrderCommands,
  runEdit,
  settleCommand,
  startedRefusal,
  type QueueEdit
} from '../../src/renderer/src/stores/batchUndo'
import { formatCatalog, type JobId } from '../../src/shared/jobs/ids'
import type { Recipe } from '../../src/shared/jobs/recipes'
import type { BatchPolicy, JobState, JobView } from '../../src/shared/jobs/types'

const A = formatCatalog(1)
const B = formatCatalog(2)
const C = formatCatalog(3)
const D = formatCatalog(4)
const E = formatCatalog(5)

const LOUD = { kind: 'normalize', name: 'loud' } as unknown as Recipe
const QUIET = { kind: 'normalize', name: 'quiet' } as unknown as Recipe

function ok<T>(value: T, seq: number = 1): { ok: true; value: T; seq: number }
{
  return { ok: true, value, seq }
}

function fail(code: string, message: string = code): { ok: false; error: { code: string; message: string; issues: never[]; details: null } }
{
  return { ok: false, error: { code, message, issues: [], details: null } }
}

function view(id: JobId, state: JobState = 'pending', recipe: Recipe = LOUD): JobView
{
  return { id, state, recipe, inputsRev: 1, rev: 1, runId: null } as unknown as JobView
}

function setup(jobs: Array<[JobId, JobState?]> = [[A], [B], [C]])
{
  const store = createJobsStore()
  store.setState({
    order: jobs.map(([id]) => id),
    jobs: Object.fromEntries(jobs.map(([id, state]) => [id, view(id, state ?? 'pending')])) as Record<JobId, JobView>
  })
  const api =
  {
    remove: vi.fn(async (req: { ids: JobId[] }) => ok({ applied: req.ids, refused: [], tombstone: 'tomb-remove' }, 11)),
    restore: vi.fn(async (_req: { tombstone: string }) => ok({ applied: [A, B], refused: [] }, 12)),
    assignRecipe: vi.fn(async (req: { assignments: Array<{ jobId: JobId; recipe: Recipe }> }) =>
      ok({ applied: req.assignments.map((assignment) => assignment.jobId), refused: [] }, 13)),
    reorder: vi.fn(async (req: { ids: JobId[]; before: JobId | null }) => ok({ applied: req.ids, refused: [] }, 14)),
    setPolicy: vi.fn(async (req: { policy: Omit<BatchPolicy, 'rev'> }) => ok({ policy: { ...req.policy, rev: 9 }, demoted: [] }, 15)),
    clear: vi.fn(async (_req: unknown) => ok({ removed: 2, kept: 0, tombstone: 'tomb-clear' }, 16))
  }
  const deps = { api: api as never, getJobs: () => store.getState() }
  return { store, api, deps, history: createUndoHistory(deps) }
}

function setState(store: ReturnType<typeof createJobsStore>, id: JobId, state: JobState): void
{
  const current = store.getState()
  store.setState({ jobs: { ...current.jobs, [id]: { ...current.jobs[id], state } } })
}

describe('wording', () =>
{
  it('counts with the noun in the singular or plural', () =>
  {
    expect(countOf(1, 'job')).toBe('1 job')
    expect(countOf(3, 'job')).toBe('3 jobs')
    expect(countOf(1204, 'file')).toBe('1,204 files')
  })

  it('words the started refusal with the count, or nothing when none started', () =>
  {
    expect(startedRefusal('undo', 3)).toBe('Cannot undo for 3 jobs that already started.')
    expect(startedRefusal('undo', 1)).toBe('Cannot undo for 1 job that already started.')
    expect(startedRefusal('redo', 2)).toBe('Cannot redo for 2 jobs that already started.')
    expect(startedRefusal('undo', 0)).toBeNull()
  })

  it('labels every kind of edit', () =>
  {
    const policy = policyInput({ rev: 3, template: '{name}' } as unknown as BatchPolicy)
    const edits: QueueEdit[] = [
      { kind: 'add', ids: [A, B], tombstone: null },
      { kind: 'duplicate', ids: [A], tombstone: null },
      { kind: 'remove', ids: [A, B, C], tombstone: 't' },
      { kind: 'clear', ids: [], count: 12, tombstone: 't' },
      { kind: 'recipe', changes: [{ jobId: A, before: LOUD, after: QUIET }] },
      { kind: 'reorder', ids: [A, B], before: null, previous: [] },
      { kind: 'policy', before: policy, after: policy }
    ]
    expect(edits.map(editLabel)).toEqual([
      'adding 2 files',
      'duplicating 1 job',
      'removing 3 jobs',
      'clearing 12 jobs',
      'the settings change for 1 job',
      'moving 2 jobs',
      'the output settings change'
    ])
  })

  it('drops the revision from a policy', () =>
  {
    expect(policyInput({ rev: 4, template: '{name}', conflict: 'rename' } as unknown as BatchPolicy)).toEqual({ template: '{name}', conflict: 'rename' })
  })
})

describe('settleCommand', () =>
{
  it('passes a reply through', async () =>
  {
    await expect(settleCommand(async () => ok(5, 2))).resolves.toEqual({ ok: true, value: 5, seq: 2 })
  })

  it('turns a rejection into an internal error', async () =>
  {
    const reply = await settleCommand(async () =>
    {
      throw new Error('Error invoking remote method')
    })
    expect(reply).toEqual({ ok: false, error: { code: 'internal', message: 'Error invoking remote method', issues: [], details: null } })
    const text = await settleCommand(() => Promise.reject('gone'))
    expect(text.ok === false && text.error.message).toBe('gone')
  })
})

describe('restoreOrderCommands', () =>
{
  it('moves a job back before the job that followed it', () =>
  {
    expect(restoreOrderCommands([B], [A, B, C, D], [A, C, D, B])).toEqual([{ ids: [B], before: C }])
  })

  it('puts runs back around jobs added since', () =>
  {
    expect(restoreOrderCommands([B], [A, B, C, D], [A, C, D, B, E])).toEqual([{ ids: [B], before: C }])
    expect(restoreOrderCommands([C], [A, B, C], [C, A, B, D])).toEqual([{ ids: [C], before: D }])
    expect(restoreOrderCommands([C], [A, B, C], [C, A, B])).toEqual([{ ids: [C], before: null }])
  })

  it('restores scattered jobs with one command per run', () =>
  {
    expect(restoreOrderCommands([A, C, E], [A, B, C, D, E], [B, D, A, C, E])).toEqual([
      { ids: [A], before: B },
      { ids: [C], before: D },
      { ids: [E], before: null }
    ])
  })

  it('anchors past jobs that left the queue and skips jobs that cannot move', () =>
  {
    expect(restoreOrderCommands([A], [A, B, C], [C, A])).toEqual([{ ids: [A], before: C }])
    expect(restoreOrderCommands([A, B], [A, B, C], [C, A, B], new Set([B]))).toEqual([{ ids: [A], before: C }])
    expect(restoreOrderCommands([A], [A], [A, B])).toEqual([{ ids: [A], before: B }])
    expect(restoreOrderCommands([A], [A, B], [B])).toEqual([])
  })
})

describe('undo history', () =>
{
  it('undoes an add by removing its jobs and redoes it from the tombstone', async () =>
  {
    const { api, history } = setup()
    history.record({ kind: 'add', ids: [A, B], tombstone: null })
    expect(history.canUndo()).toBe(true)
    expect(history.canRedo()).toBe(false)

    const undone = await history.undo()
    expect(undone).toEqual({ status: 'done', label: 'adding 2 files', refusal: null, seq: 11 })
    expect(api.remove).toHaveBeenCalledWith({ ids: [A, B] })
    expect(history.canUndo()).toBe(false)
    expect(history.redoEntries()[0].edit).toEqual({ kind: 'add', ids: [A, B], tombstone: 'tomb-remove' })

    const redone = await history.redo()
    expect(redone).toEqual({ status: 'done', label: 'adding 2 files', refusal: null, seq: 12 })
    expect(api.restore).toHaveBeenCalledWith({ tombstone: 'tomb-remove' })
    expect(history.entries()[0].edit).toEqual({ kind: 'add', ids: [A, B], tombstone: null })
  })

  it('reverts a recipe change for every job in one command', async () =>
  {
    const { api, history } = setup()
    history.record({
      kind: 'recipe',
      changes: [A, B, C].map((jobId) => ({ jobId, before: LOUD, after: QUIET }))
    })
    const outcome = await history.undo()
    expect(outcome.status).toBe('done')
    expect(api.assignRecipe).toHaveBeenCalledTimes(1)
    expect(api.assignRecipe).toHaveBeenCalledWith({
      assignments: [{ jobId: A, recipe: LOUD }, { jobId: B, recipe: LOUD }, { jobId: C, recipe: LOUD }]
    })
    await history.redo()
    expect(api.assignRecipe).toHaveBeenLastCalledWith({
      assignments: [{ jobId: A, recipe: QUIET }, { jobId: B, recipe: QUIET }, { jobId: C, recipe: QUIET }]
    })
  })

  it('refuses jobs that started since with the counted message and reverts the rest', async () =>
  {
    const { api, history, store } = setup([[A], [B], [C], [D]])
    history.record({ kind: 'recipe', changes: [A, B, C, D].map((jobId) => ({ jobId, before: LOUD, after: QUIET })) })
    setState(store, A, 'queued')
    setState(store, B, 'encoding')
    setState(store, C, 'done')
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'done', label: 'the settings change for 4 jobs', refusal: 'Cannot undo for 3 jobs that already started.', seq: 13 })
    expect(api.assignRecipe).toHaveBeenCalledWith({ assignments: [{ jobId: D, recipe: LOUD }] })
    expect(history.redoEntries()[0].edit).toEqual({ kind: 'recipe', changes: [{ jobId: D, before: LOUD, after: QUIET }] })
  })

  it('refuses the whole undo when every job started, and drops the entry', async () =>
  {
    const { api, history, store } = setup()
    history.record({ kind: 'add', ids: [A, B], tombstone: null })
    setState(store, A, 'queued')
    setState(store, B, 'failed')
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'refused', label: 'adding 2 files', message: 'Cannot undo for 2 jobs that already started.' })
    expect(api.remove).not.toHaveBeenCalled()
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })

  it('counts jobs main refuses as started', async () =>
  {
    const { api, history } = setup()
    api.remove.mockResolvedValueOnce(ok({ applied: [A], refused: [{ jobId: B, code: 'job-running', message: 'Running.' }], tombstone: 'tomb-1' }, 21))
    history.record({ kind: 'duplicate', ids: [A, B], tombstone: null })
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'done', label: 'duplicating 2 jobs', refusal: 'Cannot undo for 1 job that already started.', seq: 21 })
    expect(history.redoEntries()[0].edit).toEqual({ kind: 'duplicate', ids: [A], tombstone: 'tomb-1' })
  })

  it('passes other refusals through in main\'s words', async () =>
  {
    const { api, history } = setup()
    api.restore.mockResolvedValueOnce(ok({ applied: [A], refused: [{ jobId: B, code: 'duplicate', message: 'B already has a waiting job.' }] }, 22))
    history.record({ kind: 'remove', ids: [A, B], tombstone: 'tomb-9' })
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'done', label: 'removing 2 jobs', refusal: 'B already has a waiting job.', seq: 22 })
  })

  it('restores a removal and removes it again on redo', async () =>
  {
    const { api, history } = setup()
    history.record({ kind: 'remove', ids: [A, B], tombstone: 'tomb-9' })
    await history.undo()
    expect(api.restore).toHaveBeenCalledWith({ tombstone: 'tomb-9' })
    expect(history.redoEntries()[0].edit).toEqual({ kind: 'remove', ids: [A, B], tombstone: null })
    await history.redo()
    expect(api.remove).toHaveBeenCalledWith({ ids: [A, B] })
    expect(history.entries()[0].edit).toEqual({ kind: 'remove', ids: [A, B], tombstone: 'tomb-remove' })
  })

  it('refuses an expired restore with the fixed wording and drops the entry', async () =>
  {
    const { api, history } = setup()
    api.restore.mockResolvedValueOnce(fail('restore-expired', 'The tombstone expired.'))
    history.record({ kind: 'remove', ids: [A], tombstone: 'tomb-old' })
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'refused', label: 'removing 1 job', message: 'Cannot undo: removed jobs can be restored for 10 minutes.' })
    expect(outcome.status === 'refused' && outcome.message).toBe(RESTORE_EXPIRED_MESSAGE)
    expect(history.canUndo()).toBe(false)
  })

  it('refuses an expired redo of an add', async () =>
  {
    const { api, history } = setup()
    history.record({ kind: 'add', ids: [A], tombstone: null })
    await history.undo()
    api.restore.mockResolvedValueOnce(fail('restore-expired'))
    const outcome = await history.redo()
    expect(outcome).toEqual({ status: 'refused', label: 'adding 1 file', message: REDO_EXPIRED_MESSAGE })
    expect(history.canRedo()).toBe(false)
  })

  it('undoes a clear by restoring it and clears the same jobs again on redo', async () =>
  {
    const { api, history } = setup()
    history.record({ kind: 'clear', ids: [], count: 2, tombstone: 'tomb-c' })
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'done', label: 'clearing 2 jobs', refusal: null, seq: 12 })
    expect(history.redoEntries()[0].edit).toEqual({ kind: 'clear', ids: [A, B], count: 2, tombstone: null })
    await history.redo()
    expect(api.clear).toHaveBeenCalledWith({ scope: { kind: 'ids', ids: [A, B] } })
    expect(history.entries()[0].edit).toEqual({ kind: 'clear', ids: [A, B], count: 2, tombstone: 'tomb-clear' })
  })

  it('moves reordered jobs back and repeats the move on redo', async () =>
  {
    const { api, history, store } = setup([[A], [B], [C]])
    history.record({ kind: 'reorder', ids: [C], before: A, previous: [A, B, C] })
    store.setState({ order: [C, A, B] })
    await history.undo()
    expect(api.reorder).toHaveBeenCalledWith({ ids: [C], before: null })
    store.setState({ order: [A, B, C] })
    await history.redo()
    expect(api.reorder).toHaveBeenLastCalledWith({ ids: [C], before: A })
    expect(history.entries()[0].edit).toEqual({ kind: 'reorder', ids: [C], before: A, previous: [A, B, C] })
  })

  it('refuses to move back a job that started since', async () =>
  {
    const { api, history, store } = setup([[A], [B], [C]])
    history.record({ kind: 'reorder', ids: [C], before: A, previous: [A, B, C] })
    store.setState({ order: [C, A, B] })
    setState(store, C, 'encoding')
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'refused', label: 'moving 1 job', message: 'Cannot undo for 1 job that already started.' })
    expect(api.reorder).not.toHaveBeenCalled()
  })

  it('keeps what a reorder applied before a later command failed', async () =>
  {
    const { api, store } = setup([[A], [B], [C], [D], [E]])
    store.setState({ order: [B, D, A, C, E] })
    api.reorder
      .mockResolvedValueOnce(ok({ applied: [A], refused: [] }, 30))
      .mockResolvedValueOnce(fail('internal', 'Lost.'))
    const step = await runEdit({ api: api as never, getJobs: () => store.getState() }, { kind: 'reorder', ids: [A, C, E], before: null, previous: [A, B, C, D, E] }, 'undo')
    expect(step.inverse).toEqual({ kind: 'reorder', ids: [A], before: null, previous: [A, B, C, D, E] })
    expect(step.seq).toBe(30)
    api.reorder.mockResolvedValueOnce(fail('internal', 'Lost.'))
    const failed = await runEdit({ api: api as never, getJobs: () => store.getState() }, { kind: 'reorder', ids: [A], before: null, previous: [A, B] }, 'undo')
    expect(failed).toEqual({ inverse: null, refusal: 'Lost.', retain: true, seq: 0 })
  })

  it('reports a redo of a move whose jobs all started', async () =>
  {
    const { api, store, deps } = setup([[A], [B]])
    setState(store, A, 'done')
    const step = await runEdit(deps, { kind: 'reorder', ids: [A], before: null, previous: [A, B] }, 'redo')
    expect(step).toEqual({ inverse: null, refusal: 'Cannot redo for 1 job that already started.', retain: false, seq: 0 })
    api.reorder.mockResolvedValueOnce(fail('invalid-payload', 'Bad.'))
    const bad = await runEdit(deps, { kind: 'reorder', ids: [B], before: null, previous: [A, B] }, 'redo')
    expect(bad).toEqual({ inverse: null, refusal: 'Bad.', retain: false, seq: 0 })
  })

  it('undoes and redoes an output settings change', async () =>
  {
    const { api, history } = setup()
    const before = { template: '{name}' } as unknown as Omit<BatchPolicy, 'rev'>
    const after = { template: '{name}-{op}' } as unknown as Omit<BatchPolicy, 'rev'>
    history.record({ kind: 'policy', before, after })
    await history.undo()
    expect(api.setPolicy).toHaveBeenCalledWith({ policy: before })
    await history.redo()
    expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: after })
  })

  it('keeps an entry whose command failed for a reason that can pass', async () =>
  {
    const { api, history } = setup()
    api.setPolicy.mockResolvedValueOnce(fail('invalid-state', 'Output is locked while Batch 3 runs.'))
    const policy = { template: '{name}' } as unknown as Omit<BatchPolicy, 'rev'>
    history.record({ kind: 'policy', before: policy, after: policy })
    const outcome = await history.undo()
    expect(outcome).toEqual({ status: 'refused', label: 'the output settings change', message: 'Output is locked while Batch 3 runs.' })
    expect(history.canUndo()).toBe(true)
    await history.undo()
    expect(history.canUndo()).toBe(false)
  })

  it('fails as a whole without a rejection when a command throws', async () =>
  {
    const { api, history } = setup()
    api.assignRecipe.mockRejectedValueOnce(new Error('Error invoking remote method'))
    api.remove.mockResolvedValueOnce(fail('not-found', 'Gone.'))
    history.record({ kind: 'add', ids: [A], tombstone: null })
    history.record({ kind: 'recipe', changes: [{ jobId: A, before: LOUD, after: QUIET }] })
    await expect(history.undo()).resolves.toEqual({ status: 'refused', label: 'the settings change for 1 job', message: 'Error invoking remote method' })
    expect(history.entries()).toHaveLength(2)
    api.assignRecipe.mockResolvedValueOnce(fail('invalid-payload', 'Bad recipe.'))
    await history.undo()
    expect(history.entries()).toHaveLength(1)
    await expect(history.undo()).resolves.toEqual({ status: 'refused', label: 'adding 1 file', message: 'Gone.' })
    expect(history.canUndo()).toBe(false)
  })

  it('skips jobs that are gone and treats an edit with none left as nothing to undo', async () =>
  {
    const { api, history, deps } = setup([[A]])
    history.record({ kind: 'recipe', changes: [{ jobId: B, before: LOUD, after: QUIET }] })
    await expect(history.undo()).resolves.toEqual({ status: 'refused', label: 'the settings change for 1 job', message: 'Nothing to undo.' })
    expect(api.assignRecipe).not.toHaveBeenCalled()
    await expect(runEdit(deps, { kind: 'clear', ids: [B], count: 1, tombstone: null }, 'redo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 0 })
    await expect(runEdit(deps, { kind: 'remove', ids: [A], tombstone: null }, 'undo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 0 })
  })

  it('handles replies that apply nothing', async () =>
  {
    const { api, deps } = setup()
    api.remove.mockResolvedValueOnce(ok({ applied: [], refused: [], tombstone: null }, 3))
    await expect(runEdit(deps, { kind: 'add', ids: [A], tombstone: null }, 'undo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 3 })
    api.restore.mockResolvedValueOnce(ok({ applied: [], refused: [] }, 4))
    await expect(runEdit(deps, { kind: 'clear', ids: [], count: 1, tombstone: 't' }, 'undo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 4 })
    api.clear.mockResolvedValueOnce(ok({ removed: 0, kept: 1, tombstone: null }, 5))
    await expect(runEdit(deps, { kind: 'clear', ids: [A], count: 1, tombstone: null }, 'redo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 5 })
    api.clear.mockResolvedValueOnce(fail('internal', 'Disk.'))
    await expect(runEdit(deps, { kind: 'clear', ids: [A], count: 1, tombstone: null }, 'redo')).resolves.toEqual({ inverse: null, refusal: 'Disk.', retain: true, seq: 0 })
    api.assignRecipe.mockResolvedValueOnce(ok({ applied: [], refused: [{ jobId: A, code: 'job-terminal', message: 'Done.' }] }, 6))
    await expect(runEdit(deps, { kind: 'recipe', changes: [{ jobId: A, before: LOUD, after: QUIET }] }, 'undo')).resolves.toEqual({
      inverse: null, refusal: 'Cannot undo for 1 job that already started.', retain: false, seq: 6
    })
    api.reorder.mockResolvedValueOnce(ok({ applied: [], refused: [] }, 7))
    await expect(runEdit(deps, { kind: 'reorder', ids: [A], before: null, previous: [A] }, 'redo')).resolves.toEqual({ inverse: null, refusal: null, retain: false, seq: 7 })
    api.setPolicy.mockResolvedValueOnce(fail('restore-expired'))
    const policy = { template: '{name}' } as unknown as Omit<BatchPolicy, 'rev'>
    await expect(runEdit(deps, { kind: 'policy', before: policy, after: policy }, 'redo')).resolves.toEqual({ inverse: null, refusal: REDO_EXPIRED_MESSAGE, retain: false, seq: 0 })
  })

  it('undoes a given entry wherever it is, for a toast\'s Undo', async () =>
  {
    const { api, history } = setup()
    const first = history.record({ kind: 'add', ids: [A], tombstone: null })
    history.record({ kind: 'reorder', ids: [B], before: null, previous: [A, B, C] })
    await history.undo(first.id)
    expect(api.remove).toHaveBeenCalledWith({ ids: [A] })
    expect(history.entries().map((entry) => entry.edit.kind)).toEqual(['reorder'])
    await expect(history.undo(first.id)).resolves.toEqual({ status: 'empty' })
  })

  it('puts a retained entry back where it was', async () =>
  {
    const { api, history } = setup()
    const first = history.record({ kind: 'add', ids: [A], tombstone: null })
    const second = history.record({ kind: 'add', ids: [B], tombstone: null })
    api.remove.mockResolvedValueOnce(fail('shutting-down', 'Closing.'))
    await history.undo(first.id)
    expect(history.entries().map((entry) => entry.id)).toEqual([first.id, second.id])
  })

  it('answers empty with nothing to undo or redo', async () =>
  {
    const { history } = setup()
    await expect(history.undo()).resolves.toEqual({ status: 'empty' })
    await expect(history.redo()).resolves.toEqual({ status: 'empty' })
  })

  it('keeps the last 50 edits and clears redo on a new edit', async () =>
  {
    const { history } = setup()
    for (let index = 0; index < UNDO_LIMIT + 5; index += 1)
    {
      history.record({ kind: 'add', ids: [A], tombstone: null })
    }
    expect(history.entries()).toHaveLength(UNDO_LIMIT)
    expect(history.entries()[0].id).toBe(6)
    await history.undo()
    expect(history.canRedo()).toBe(true)
    history.record({ kind: 'add', ids: [B], tombstone: null })
    expect(history.canRedo()).toBe(false)
    history.clear()
    expect(history.canUndo()).toBe(false)
  })

  it('runs undo and redo one at a time in the order asked', async () =>
  {
    const { api, history } = setup()
    let release: () => void = () => undefined
    api.remove.mockImplementationOnce((req: { ids: JobId[] }) => new Promise((resolve) =>
    {
      release = () => resolve(ok({ applied: req.ids, refused: [], tombstone: 'slow' }, 40))
    }))
    history.record({ kind: 'add', ids: [A], tombstone: null })
    history.record({ kind: 'add', ids: [B], tombstone: null })
    const first = history.undo()
    const second = history.undo()
    await Promise.resolve()
    expect(api.remove).toHaveBeenCalledTimes(1)
    release()
    await first
    await second
    expect(api.remove).toHaveBeenCalledTimes(2)
    expect(api.remove.mock.calls[0][0]).toEqual({ ids: [B] })
    expect(api.remove.mock.calls[1][0]).toEqual({ ids: [A] })
  })

  it('amends a recorded edit and tells listeners about every change', async () =>
  {
    const { history } = setup()
    const listener = vi.fn()
    const stop = history.subscribe(listener)
    const entry = history.record({ kind: 'add', ids: [A], tombstone: null })
    expect(history.amend(entry.id, (edit) => (edit.kind === 'add' ? { ...edit, ids: [...edit.ids, B] } : edit))).toBe(true)
    expect(history.entries()[0].edit).toEqual({ kind: 'add', ids: [A, B], tombstone: null })
    expect(history.amend(999, (edit) => edit)).toBe(false)
    await history.undo()
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    history.clear()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
