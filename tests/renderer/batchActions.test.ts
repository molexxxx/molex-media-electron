/**
 * The Batch view's commands against a fake engine surface and manual timers: adds select only their own jobs and
 * confirm when they settle, the live plan preflights the pending jobs once 400 ms after the last plan-input change
 * and never after a measurement, Start sends the latest report id with the report's counts, a stale Start returns
 * the review with the reason, an append is a preflight then a Start, and every brass action commits the focused
 * field's draft first.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React, { createElement } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import
{
  BatchActionsContext,
  INERT_COMMAND_MESSAGE,
  TestBatchActionsProvider,
  createTestBatchActions,
  inertJobsApi,
  useBatchActions
} from '../../src/renderer/src/components/batch/BatchActionsContext'
import { createJobsStore, type JobsState } from '../../src/renderer/src/stores/jobs'
import { createBatchViewStore } from '../../src/renderer/src/stores/batchView'
import
{
  LIVE_PREFLIGHT_DELAY_MS,
  binOf,
  createBatchActions,
  createDraftCommitters,
  joinList,
  planDelete,
  relinkOffer,
  searchSummary,
  skippedSentence,
  type BatchToast
} from '../../src/renderer/src/stores/batchActions'
import { formatCatalog, formatRunId, type JobId } from '../../src/shared/jobs/ids'
import type { Recipe } from '../../src/shared/jobs/recipes'
import type { JobState, JobView, PreflightReport, RunState, ScanState } from '../../src/shared/jobs/types'

const A = formatCatalog(1)
const B = formatCatalog(2)
const C = formatCatalog(3)
const D = formatCatalog(4)
const RUN = formatRunId(31)

const LOUD = { kind: 'normalize', name: 'loud' } as unknown as Recipe
const QUIET = { kind: 'normalize', name: 'quiet' } as unknown as Recipe
const MP4 = { kind: 'convert', name: 'mp4' } as unknown as Recipe

type Reply = { ok: true; value: unknown; seq: number } | { ok: false; error: { code: string; message: string; issues: never[]; details: unknown } }

function ok(value: unknown, seq: number = 0): Reply
{
  return { ok: true, value, seq }
}

function fail(code: string, message: string = code, details: unknown = null): Reply
{
  return { ok: false, error: { code, message, issues: [], details } }
}

function job(id: JobId, over: Partial<JobView> = {}): JobView
{
  return {
    id,
    state: 'pending',
    recipe: LOUD,
    recipeLabel: 'Normalize · Loud',
    inputsRev: 1,
    rev: 1,
    runId: null,
    source: { path: `D:\\Rips\\${id}.wav`, name: `${id}.wav`, ext: 'wav', dir: 'D:\\Rips', size: 10, mtimeMs: 1, origin: 'files', subdir: '' },
    analysis: null,
    previewed: false,
    audioPlan: null,
    acknowledged: false,
    warnings: [],
    hold: null,
    stamp: null,
    error: null,
    plan: null,
    ...over
  } as unknown as JobView
}

function report(id: string, counts: Partial<PreflightReport['counts']> = {}): PreflightReport
{
  return {
    preflightId: id,
    createdAt: 0,
    policyRev: 1,
    capabilitiesRev: 1,
    jobs: [],
    counts: { jobs: 2, ready: 2, blocked: 0, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0, ...counts },
    volumes: [],
    collisions: [],
    blocking: [],
    warnings: [],
    limits: { total: 4, videoCpu: 2, gpu: 1 }
  }
}

function run(over: Partial<RunState> = {}): RunState
{
  return {
    status: 'running',
    runId: RUN,
    startedAt: 1,
    pause: null,
    counts: { pending: 0, queued: 4, analyzing: 0, encoding: 3, verifying: 0, finalizing: 0, held: 0, done: 0, failed: 0, canceled: 0, skipped: 0, interrupted: 0 },
    progress: { percent: 10, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 },
    workers: { setting: 'auto', limits: { total: 4, videoCpu: 2, gpu: 1 }, active: { total: 3, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 } },
    quitWhenIdle: false,
    needsAck: null,
    ...over
  } as unknown as RunState
}

function manualTimers()
{
  let now = 0
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  return {
    schedule(fn: () => void, ms: number): () => void
    {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return () =>
      {
        timer.live = false
      }
    },
    advance(ms: number): void
    {
      now += ms
      for (const timer of timers.filter((candidate) => candidate.live && candidate.at <= now).sort((a, b) => a.at - b.at))
      {
        timer.live = false
        timer.fn()
      }
    },
    pending(): number
    {
      return timers.filter((timer) => timer.live).length
    }
  }
}

function fakeApi()
{
  const reply = (value: unknown = null) => vi.fn(async (_req?: unknown): Promise<Reply> => ok(value))
  return {
    subscribe: reply(),
    unsubscribe: reply(),
    get: reply(),
    add: vi.fn(async (req: { paths: string[] }): Promise<Reply> => ok({ added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [], echo: req })),
    pasteFiles: vi.fn(async (_req: unknown): Promise<Reply> => ok({ added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [], source: 'empty' })),
    cancelScan: reply(),
    forgetFolder: reply(),
    clearRecentFolders: reply(),
    remove: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [], tombstone: 'tomb-1' })),
    restore: vi.fn(async (_req: unknown): Promise<Reply> => ok({ applied: [], refused: [] })),
    reorder: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    assignRecipe: vi.fn(async (req: { assignments: Array<{ jobId: JobId }> }): Promise<Reply> => ok({ applied: req.assignments.map((entry) => entry.jobId), refused: [] })),
    duplicate: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [], created: [] })),
    locate: reply(),
    relink: reply(),
    reprobe: reply(),
    setPolicy: vi.fn(async (req: { policy: object }): Promise<Reply> => ok({ policy: { ...req.policy, rev: 2 }, demoted: [] })),
    setDefaultRecipe: reply(),
    preflight: vi.fn(async (_req: unknown): Promise<Reply> => ok(report('pf-1'))),
    analyze: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    cancelAnalyze: vi.fn(async (_req: unknown): Promise<Reply> => ok({ applied: [], refused: [] })),
    start: vi.fn(async (_req: unknown): Promise<Reply> => ok({ runId: RUN, queued: [A, B], skipped: [], blocked: [], repeated: false })),
    pause: vi.fn(async (_req: unknown): Promise<Reply> => ok(run({ status: 'pausing' }))),
    resume: vi.fn(async (_req: unknown): Promise<Reply> => ok(run())),
    cancelRun: vi.fn(async (_req: unknown): Promise<Reply> => ok({ canceled: 4 })),
    setWorkers: reply(),
    setSettings: reply(),
    dismissAlert: reply(),
    revealAlert: reply(),
    cancel: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    skip: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    unqueue: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    retry: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [], queued: req.ids, pending: [], changed: [], runId: RUN })),
    keepOutput: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    discardOutput: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    acknowledge: vi.fn(async (req: { ids: JobId[] }): Promise<Reply> => ok({ applied: req.ids, refused: [] })),
    clear: vi.fn(async (_req: unknown): Promise<Reply> => ok({ removed: 3, kept: 0, tombstone: 'tomb-clear' })),
    log: reply(),
    reveal: reply(),
    exportReport: vi.fn(async (_req: unknown): Promise<Reply> => ok({ path: 'D:\\Exports\\molexMedia Batch 31 report.csv' })),
    listRuns: reply(),
    getRun: reply(),
    searchRuns: vi.fn(async (_req: unknown): Promise<Reply> => ok({ matches: [], runs: 0, more: false })),
    rerun: vi.fn(async (_req: unknown): Promise<Reply> => ok({ added: [], missing: [], holdsOutput: [] })),
    deleteRuns: vi.fn(async (_req: unknown): Promise<Reply> => ok({ deleted: 1 })),
    revealRecord: reply(),
    savePreset: reply(),
    renamePreset: reply(),
    removePreset: reply(),
    setPin: reply(),
    onEvents: vi.fn(() => () => undefined)
  }
}

function harness(rows: JobView[] = [job(A), job(B)], state: Partial<JobsState> = {})
{
  const jobs = createJobsStore()
  jobs.setState({
    status: 'hydrated',
    hydrations: 1,
    policy: { rev: 1, template: '{name}' } as unknown as JobsState['policy'],
    order: rows.map((row) => row.id),
    jobs: Object.fromEntries(rows.map((row) => [row.id, row])) as Record<JobId, JobView>,
    ...state
  })
  const view = createBatchViewStore({ storage: null })
  const api = fakeApi()
  const toasts: BatchToast[] = []
  const notify = vi.fn((toast: BatchToast) =>
  {
    toasts.push(toast)
  })
  const announce = vi.fn()
  const timers = manualTimers()
  const drafts = createDraftCommitters()
  const revealPath = vi.fn()
  const actions = createBatchActions({ api: api as never, jobs, view, notify, announce, schedule: timers.schedule, drafts, revealPath })
  live.push(actions)
  return { jobs, view, api, toasts, notify, announce, timers, drafts, revealPath, actions }
}

const live: Array<{ dispose(): void }> = []

afterEach(() =>
{
  cleanup()
  for (const actions of live.splice(0))
  {
    actions.dispose()
  }
})

function patchJob(jobs: ReturnType<typeof createJobsStore>, id: JobId, patch: Partial<JobView>, seq?: number): void
{
  const state = jobs.getState()
  jobs.setState({ jobs: { ...state.jobs, [id]: { ...state.jobs[id], ...patch } }, seq: seq ?? state.seq + 1 })
}

function addRows(jobs: ReturnType<typeof createJobsStore>, rows: JobView[], seq?: number): void
{
  const state = jobs.getState()
  jobs.setState({
    order: [...state.order, ...rows.map((row) => row.id)],
    jobs: { ...state.jobs, ...Object.fromEntries(rows.map((row) => [row.id, row])) },
    seq: seq ?? state.seq + 1
  })
}

async function flush(): Promise<void>
{
  for (let index = 0; index < 10; index += 1)
  {
    await Promise.resolve()
  }
}

function toastAction(toast: BatchToast, label: string): () => void
{
  const action = toast.actions?.find((candidate) => candidate.label === label)
  if (action === undefined)
  {
    throw new Error(`No ${label} action on ${toast.title}`)
  }
  return action.run
}

describe('wording helpers', () =>
{
  it('joins lists with commas and a final and', () =>
  {
    expect(joinList(['a'])).toBe('a')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c')
  })

  it('words the skipped parts that are present', () =>
  {
    expect(skippedSentence(9, 3, 120)).toBe('Skipped 9 that are not media, 3 already in the queue, and 120 outputs of earlier batches.')
    expect(skippedSentence(1, 0, 0)).toBe('Skipped 1 that is not media.')
    expect(skippedSentence(0, 2, 1)).toBe('Skipped 2 already in the queue and 1 output of earlier batches.')
    expect(skippedSentence(0, 0, 0)).toBeNull()
  })
})

describe('draft committers', () =>
{
  it('commits nothing without a committer and unregisters only the current one', async () =>
  {
    const drafts = createDraftCommitters()
    await expect(drafts.commit()).resolves.toEqual({ status: 'none' })
    const first = drafts.register(() => ({ status: 'committed', seq: 3 }))
    drafts.register(() => ({ status: 'invalid', field: 'Target, integrated' }))
    first()
    await expect(drafts.commit()).resolves.toEqual({ status: 'invalid', field: 'Target, integrated' })
  })

  it('treats a committer that throws as an invalid draft', async () =>
  {
    const drafts = createDraftCommitters()
    const stop = drafts.register(() =>
    {
      throw new Error('broken')
    })
    await expect(drafts.commit()).resolves.toEqual({ status: 'invalid', field: 'the edited field' })
    stop()
    await expect(drafts.commit()).resolves.toEqual({ status: 'none' })
  })
})

describe('adding files', () =>
{
  it('adds with the "New files get" recipe, selects only the new jobs once applied, and confirms', async () =>
  {
    const { api, jobs, view, toasts, actions } = harness([job(A)])
    api.add.mockResolvedValueOnce(ok({
      added: [B, C],
      duplicates: { paths: ['D:\\Rips\\a.wav'], jobIds: [A] },
      previousOutputs: ['D:\\Out\\x.wav'],
      refused: [{ path: 'D:\\Rips\\notes.txt', code: 'not-media', message: 'Not media.' }],
      scanIds: []
    }, 4))
    const pending = actions.addPaths(['D:\\Rips\\b.wav', 'D:\\Rips\\c.wav'], { origin: 'drop' })
    await flush()
    expect(api.add).toHaveBeenCalledWith({
      paths: ['D:\\Rips\\b.wav', 'D:\\Rips\\c.wav'], recipe: null, origin: 'drop', after: null, recursive: true, allowSecondJobs: false, force: false
    })
    expect(view.getState().views.queue.selection.selected.size).toBe(0)
    addRows(jobs, [job(B), job(C)], 4)
    const outcome = await pending
    expect(outcome).toMatchObject({ status: 'done', seq: 4 })
    expect([...view.getState().views.queue.selection.selected]).toEqual([B, C])
    expect(view.getState().views.queue.selection.focus).toBe(B)
    expect(toasts[0].title).toBe('Added 2 files.')
    expect(toasts[0].body).toBe('Skipped 1 that is not media, 1 already in the queue, and 1 output of earlier batches.')
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Select added', 'Show skipped', 'Undo'])
  })

  it('follows "Include subfolders" and leaves the selection alone in Run mode', async () =>
  {
    const { api, jobs, view, actions } = harness([job(A)])
    jobs.setState({ settings: { includeSubfolders: false } as unknown as JobsState['settings'] })
    view.setState({ mode: 'run' })
    api.add.mockResolvedValueOnce(ok({ added: [B], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [] }))
    await actions.addPaths(['D:\\Rips'], { origin: 'folder' })
    expect(api.add.mock.calls[0][0]).toMatchObject({ recursive: false, origin: 'folder' })
    expect(view.getState().views.queue.selection.selected.size).toBe(0)
  })

  it('offers the skipped list with ways to add them anyway', async () =>
  {
    const { api, toasts, actions, view } = harness([job(A), job(B)])
    api.add.mockResolvedValueOnce(ok({
      added: [],
      duplicates: { paths: ['D:\\Rips\\a.wav'], jobIds: [A] },
      previousOutputs: ['D:\\Out\\x.wav'],
      refused: [{ path: 'D:\\Locked', code: 'unreadable', message: 'Skipped 1 folder that could not be read (access denied).' }],
      scanIds: []
    }))
    await actions.addPaths(['D:\\Rips\\a.wav', 'D:\\Out\\x.wav', 'D:\\Locked'])
    expect(toasts[0].title).toBe('No files were added.')
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Show skipped'])
    toastAction(toasts[0], 'Show skipped')()
    expect(toasts[1].title).toBe('Already in the queue: 1 · Outputs of earlier batches: 1')
    expect(toasts[1].body).toBe('Skipped 1 folder that could not be read (access denied).')
    toastAction(toasts[1], 'Select them')()
    expect([...view.getState().views.queue.selection.selected]).toEqual([A])
    toastAction(toasts[1], 'Add as second jobs')()
    toastAction(toasts[1], 'Add them anyway')()
    await flush()
    expect(api.add.mock.calls[1][0]).toMatchObject({ paths: ['D:\\Rips\\a.wav'], allowSecondJobs: true, force: false })
    expect(api.add.mock.calls[2][0]).toMatchObject({ paths: ['D:\\Out\\x.wav'], allowSecondJobs: false, force: true })
  })

  it('follows a folder scan: found rows extend the selection and the undo entry, and the toast waits for the end', async () =>
  {
    const { api, jobs, view, toasts, actions } = harness([job(A)])
    const scan = (status: ScanState['status'], added: number): ScanState => ({
      scanId: 'scan-1', root: 'D:\\Rips\\Podcasts', status, error: status === 'failed' ? 'D:\\Rips is no longer available' : null, visited: 10, added,
      excluded: { links: 1, unreadable: 2, workFiles: 0, unsupported: 4, overLimit: 0, outputFolder: 0, previousOutputs: 5, duplicates: 6 }
    })
    api.add.mockResolvedValueOnce(ok({ added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: ['scan-1'] }, 2))
    jobs.setState({ scans: [scan('scanning', 0)], seq: 2 })
    const outcome = await actions.addPaths(['D:\\Rips\\Podcasts'], { origin: 'drop' })
    expect(outcome).toMatchObject({ status: 'done', entryId: null })
    expect(toasts).toHaveLength(0)
    const found = (id: JobId, path: string) => job(id, { source: { path, name: 'x', ext: 'wav', dir: 'D:\\Rips', size: 1, mtimeMs: 1, origin: 'folder', subdir: '' } as JobView['source'] })
    addRows(jobs, [found(B, 'D:\\Rips\\Podcasts\\one.wav')])
    addRows(jobs, [found(C, 'D:\\Rips\\Podcasts\\two.wav'), found(D, 'E:\\Elsewhere\\three.wav')])
    expect([...view.getState().views.queue.selection.selected]).toEqual([B, C])
    jobs.setState({ scans: [scan('failed', 2)] })
    expect(toasts.map((toast) => toast.title)).toEqual(['Folder scan stopped: D:\\Rips is no longer available.', 'Added 2 files.'])
    expect(toasts[0].body).toBe('Added 2 files found before the error.')
    expect(toasts[1].body).toBe('Skipped 4 that are not media, 6 already in the queue, and 5 outputs of earlier batches.')
    toastAction(toasts[1], 'Show skipped')()
    expect(toasts[2].body).toBe('Skipped 2 folders that could not be read. Skipped 1 link: folder links are not followed.')
    toastAction(toasts[1], 'Undo')()
    await flush()
    expect(api.remove).toHaveBeenCalledWith({ ids: [B, C] })
  })

  it('pastes files from the clipboard, and says so when it holds none', async () =>
  {
    const { api, toasts, actions } = harness([job(A)])
    await expect(actions.pasteFiles()).resolves.toEqual({ status: 'empty' })
    expect(toasts[0].title).toBe('The clipboard has no files or file paths.')
    api.pasteFiles.mockResolvedValueOnce(ok({ added: [B], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [], source: 'file-list' }))
    const outcome = await actions.pasteFiles()
    expect(outcome.status).toBe('done')
    expect(api.pasteFiles).toHaveBeenLastCalledWith({ recipe: null, recursive: true })
    expect(toasts[1].title).toBe('Added 1 file.')
  })

  it('shows a refused add without a rejection', async () =>
  {
    const { api, toasts, actions } = harness()
    api.add.mockRejectedValueOnce(new Error('Error invoking remote method'))
    await expect(actions.addPaths(['x'])).resolves.toEqual({ status: 'refused', code: 'internal', message: 'Error invoking remote method' })
    expect(toasts[0]).toMatchObject({ tone: 'error', title: 'Error invoking remote method' })
  })
})

function deferred<T>()
{
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) =>
  {
    resolve = done
  })
  return { promise, resolve }
}

describe('the live plan', () =>
{
  it('preflights the pending jobs once, 400 ms after the last plan-input change', () =>
  {
    const { api, jobs, timers } = harness()
    patchJob(jobs, A, { recipe: QUIET })
    timers.advance(300)
    patchJob(jobs, B, { recipe: MP4 })
    timers.advance(300)
    expect(api.preflight).not.toHaveBeenCalled()
    timers.advance(LIVE_PREFLIGHT_DELAY_MS - 300)
    expect(api.preflight).toHaveBeenCalledTimes(1)
    expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS * 3)
    expect(api.preflight).toHaveBeenCalledTimes(1)
  })

  it('lets a newer request supersede an older one, whose reply is ignored', async () =>
  {
    const { api, jobs, view, timers } = harness()
    const first = deferred<Reply>()
    api.preflight.mockImplementationOnce(() => first.promise)
    api.preflight.mockResolvedValueOnce(ok(report('pf-2')))
    patchJob(jobs, A, { recipe: QUIET })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    patchJob(jobs, A, { inputsRev: 2 })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    await flush()
    expect(api.preflight).toHaveBeenCalledTimes(2)
    expect(view.getState().review.reportId).toBe('pf-2')
    first.resolve(ok(report('pf-1')))
    await flush()
    expect(view.getState().review.reportId).toBe('pf-2')
  })

  it('reports a superseded request as superseded, whichever side noticed', async () =>
  {
    const { api, actions } = harness()
    const first = deferred<Reply>()
    api.preflight.mockImplementationOnce(() => first.promise)
    const older = actions.refreshReview()
    const newer = actions.refreshReview()
    await expect(newer).resolves.toMatchObject({ status: 'done', value: { preflightId: 'pf-1' } })
    first.resolve(ok(report('pf-0')))
    await expect(older).resolves.toEqual({ status: 'superseded' })
    api.preflight.mockResolvedValueOnce(fail('superseded'))
    await expect(actions.refreshReview()).resolves.toEqual({ status: 'superseded' })
    api.preflight.mockResolvedValueOnce(fail('internal', 'Planner failed.'))
    await expect(actions.refreshReview()).resolves.toEqual({ status: 'refused', code: 'internal', message: 'Planner failed.' })
  })

  it('never re-plans after a measurement, a plan, or progress lands', () =>
  {
    const { api, jobs, timers } = harness()
    patchJob(jobs, A, { analysis: { status: 'running' } as unknown as JobView['analysis'], rev: 2 })
    patchJob(jobs, A, { previewed: true, audioPlan: { gainDb: -3 } as unknown as JobView['audioPlan'], rev: 3 })
    patchJob(jobs, B, { plan: { status: 'ready' } as unknown as JobView['plan'], rev: 2 })
    jobs.setState({ measurements: { [A]: { pass: 'preview' } } as unknown as JobsState['measurements'] })
    jobs.setState({ run: run() })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS * 2)
    expect(api.preflight).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it('re-plans after a policy change, a reorder, or a source change, and at once on window focus', () =>
  {
    const { api, jobs, timers, actions } = harness()
    jobs.setState({ policy: { rev: 2, template: '{name}' } as unknown as JobsState['policy'] })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    jobs.setState({ order: [B, A] })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    patchJob(jobs, B, { source: { ...jobs.getState().jobs[B].source, size: 99 } })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    addRows(jobs, [job(C)])
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    expect(api.preflight).toHaveBeenCalledTimes(4)
    actions.windowFocused()
    expect(api.preflight).toHaveBeenCalledTimes(5)
  })

  it('waits for hydration and skips an empty queue', () =>
  {
    const { api, jobs, timers, actions } = harness()
    jobs.setState({ status: 'resyncing' })
    patchJob(jobs, A, { recipe: QUIET })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    actions.windowFocused()
    expect(api.preflight).not.toHaveBeenCalled()
    jobs.setState({ status: 'hydrated' })
    patchJob(jobs, A, { state: 'done' as JobState })
    patchJob(jobs, B, { state: 'done' as JobState })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    expect(api.preflight).not.toHaveBeenCalled()
  })

  it('covers the Review subset in Review, and waits for a running Review check', async () =>
  {
    const { api, jobs, view, timers, actions } = harness()
    view.getState().setMode('review')
    view.getState().setReviewSubset([A])
    const check = deferred<Reply>()
    api.preflight.mockImplementationOnce(() => check.promise)
    const refresh = actions.refreshReview()
    patchJob(jobs, A, { recipe: QUIET })
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    expect(api.preflight).toHaveBeenCalledTimes(1)
    check.resolve(ok(report('pf-sub')))
    await refresh
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    expect(api.preflight).toHaveBeenCalledTimes(2)
    expect(api.preflight).toHaveBeenLastCalledWith({ ids: [A] })
    actions.notePlanInputChange()
    timers.advance(LIVE_PREFLIGHT_DELAY_MS)
    expect(api.preflight).toHaveBeenCalledTimes(3)
  })
})

describe('Review and Start', () =>
{
  it('opens Review on the Queue selection, measures unmeasured loudness jobs, and refreshes the plan', async () =>
  {
    const { api, view, actions } = harness([job(A), job(B, { recipe: MP4 }), job(C, { previewed: true })])
    view.getState().select('queue', { type: 'selectAll', ids: [A, B] })
    const outcome = await actions.openReview()
    expect(view.getState().mode).toBe('review')
    expect(api.analyze).toHaveBeenCalledWith({ ids: [A] })
    expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
    expect(outcome).toMatchObject({ status: 'done', value: { preflightId: 'pf-1' } })
    expect(view.getState().review.reportId).toBe('pf-1')
  })

  it('leaves measuring off when Settings turned it off, and stops measuring on request', async () =>
  {
    const { api, jobs, actions } = harness()
    jobs.setState({ settings: { measureOnReview: false } as unknown as JobsState['settings'] })
    await actions.openReview({ fromQueue: false })
    expect(api.analyze).not.toHaveBeenCalled()
    await expect(actions.measureForReview()).resolves.toBeNull()
    await expect(actions.stopMeasuring()).resolves.toMatchObject({ status: 'done' })
    expect(api.cancelAnalyze).toHaveBeenCalledWith({ ids: 'all' })
    api.cancelAnalyze.mockResolvedValueOnce(fail('not-found', 'Nothing is measuring.'))
    await expect(actions.stopMeasuring()).resolves.toMatchObject({ status: 'refused', message: 'Nothing is measuring.' })
  })

  it('reports a refused measurement and measures nothing when every job has a measurement', async () =>
  {
    const { api, jobs, actions } = harness()
    api.analyze.mockResolvedValueOnce(fail('invalid-state', 'Cannot measure now.'))
    await expect(actions.measureForReview()).resolves.toMatchObject({ status: 'refused', message: 'Cannot measure now.' })
    patchJob(jobs, A, { previewed: true })
    patchJob(jobs, B, { previewed: true })
    await expect(actions.measureForReview()).resolves.toBeNull()
  })

  it('sends Start with the latest report id and, when destructive, the report counts', async () =>
  {
    const { api, view, toasts, announce, actions } = harness()
    api.preflight.mockResolvedValueOnce(ok(report('pf-2', { originalsAffected: 20, overwrites: 3 })))
    await actions.openReview()
    await expect(actions.start()).resolves.toEqual({ status: 'needs-acknowledgment', notice: null })
    expect(api.start).not.toHaveBeenCalled()
    view.getState().setAcknowledged(true)
    api.preflight.mockResolvedValueOnce(ok(report('pf-3', { originalsAffected: 20, overwrites: 3 })))
    await actions.refreshReview()
    expect(view.getState().review.acknowledged).toBe(true)
    const outcome = await actions.start()
    expect(api.start).toHaveBeenCalledWith({ preflightId: 'pf-3', ack: { preflightId: 'pf-3', originalsAffected: 20, overwrites: 3 }, resume: false })
    expect(outcome).toEqual({ status: 'started', runId: RUN, queued: [A, B], skipped: [], blocked: [], appended: false })
    expect(view.getState().mode).toBe('run')
    expect(toasts.at(-1)?.title).toBe('Batch 31 started: 2 jobs.')
    expect(announce).toHaveBeenCalledWith('Start waits for the acknowledgment.')
  })

  it('unchecks the acknowledgment when a count changes and says why', async () =>
  {
    const { api, view, announce, actions } = harness()
    api.preflight.mockResolvedValueOnce(ok(report('pf-2', { originalsAffected: 20 })))
    await actions.openReview()
    view.getState().setAcknowledged(true)
    api.preflight.mockResolvedValueOnce(ok(report('pf-3', { originalsAffected: 22 })))
    await actions.refreshReview()
    expect(view.getState().review.acknowledged).toBe(false)
    expect(announce).toHaveBeenCalledWith('The number of originals changed to 22; confirm again.')
  })

  it('sends no acknowledgment for a plan that touches nothing, and counts skips in the toast', async () =>
  {
    const { api, toasts, actions } = harness()
    await actions.openReview()
    api.start.mockResolvedValueOnce(ok({ runId: RUN, queued: [A], skipped: [B], blocked: [], repeated: false }))
    await actions.start()
    expect(api.start).toHaveBeenCalledWith({ preflightId: 'pf-1', ack: null, resume: false })
    expect(toasts.at(-1)).toMatchObject({ title: 'Batch 31 started: 1 job.', body: '1 skipped because its output exists.' })
  })

  it('says nothing new for a repeated Start and words several skips', async () =>
  {
    const { api, toasts, actions } = harness()
    await actions.openReview()
    api.start.mockResolvedValueOnce(ok({ runId: RUN, queued: [A], skipped: [B, C], blocked: [], repeated: false }))
    await actions.start()
    expect(toasts.at(-1)?.body).toBe('2 skipped because their output exists.')
    await actions.openReview()
    api.start.mockResolvedValueOnce(ok({ runId: RUN, queued: [A], skipped: [], blocked: [], repeated: true }))
    const count = toasts.length
    await expect(actions.start()).resolves.toMatchObject({ status: 'started' })
    expect(toasts).toHaveLength(count)
  })

  it('returns the review with the reason when Start comes back stale', async () =>
  {
    const { api, view, announce, actions } = harness()
    await actions.openReview()
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', { changed: [A, B] }))
    const outcome = await actions.start()
    expect(outcome).toEqual({ status: 'stale', changed: [A, B], reason: '2 sources changed since this review.' })
    expect(announce).toHaveBeenCalledWith('2 sources changed since this review.')
    expect(api.preflight).toHaveBeenCalledTimes(2)
    expect(view.getState().mode).toBe('review')
    await flush()
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', { changed: [A] }))
    await expect(actions.start()).resolves.toMatchObject({ reason: '1 source changed since this review.' })
    await flush()
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', null))
    await expect(actions.start()).resolves.toMatchObject({ reason: 'The output changed since this review. Review it, then Start again.' })
  })

  it('names the edited field when an edit made the plan stale', async () =>
  {
    const { api, actions } = harness()
    await actions.openReview()
    await actions.assignRecipes([{ jobId: A, recipe: QUIET }, { jobId: B, recipe: QUIET }], { field: 'Target, integrated' })
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', { changed: [A, B] }))
    await expect(actions.start()).resolves.toMatchObject({ reason: 'Target, integrated changed for 2 jobs. Review them, then Start again.' })
    await flush()
    await actions.setPolicy({ template: '{name}-x' } as never)
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', { changed: [B] }))
    await expect(actions.start()).resolves.toMatchObject({ reason: 'Output settings changed for 1 job. Review it, then Start again.' })
  })

  it('takes the counts main asks to confirm, and shows other refusals beside Start', async () =>
  {
    const { api, view, announce, actions } = harness()
    await actions.openReview()
    api.start.mockResolvedValueOnce(fail('confirmation-required', 'Confirm first.', { preflightId: 'pf-9', originalsAffected: 2, overwrites: 0 }))
    await expect(actions.start()).resolves.toMatchObject({ status: 'needs-acknowledgment' })
    expect(view.getState().review.reportId).toBe('pf-9')
    view.getState().setAcknowledged(true)
    api.start.mockResolvedValueOnce(fail('invalid-state', 'FFmpeg is not ready.'))
    await expect(actions.start()).resolves.toEqual({ status: 'refused', code: 'invalid-state', message: 'FFmpeg is not ready.' })
    expect(api.start).toHaveBeenLastCalledWith({ preflightId: 'pf-9', ack: { preflightId: 'pf-9', originalsAffected: 2, overwrites: 0 }, resume: false })
    expect(announce).toHaveBeenCalledWith('FFmpeg is not ready.')
  })

  it('holds Start while Review checks, without a report, and when nothing can run', async () =>
  {
    const { api, jobs, actions } = harness()
    await expect(actions.start()).resolves.toEqual({ status: 'not-ready', reason: 'Checking 2 jobs.' })
    expect(api.preflight).toHaveBeenCalledTimes(1)
    await flush()
    const check = deferred<Reply>()
    api.preflight.mockImplementationOnce(() => check.promise)
    const refresh = actions.refreshReview()
    jobs.setState({ preflight: { preflightId: 'pf-x', done: 412, total: 1000 } })
    await expect(actions.start()).resolves.toEqual({ status: 'not-ready', reason: 'Checking 412 of 1,000 jobs.' })
    check.resolve(ok(report('pf-blocked', { ready: 0, blocked: 2 })))
    await refresh
    await expect(actions.start()).resolves.toEqual({ status: 'not-ready', reason: 'Nothing can run: 2 jobs are blocked.' })
    api.preflight.mockResolvedValueOnce(ok(report('pf-one', { ready: 0, blocked: 1 })))
    await actions.refreshReview()
    await expect(actions.start()).resolves.toEqual({ status: 'not-ready', reason: 'Nothing can run: 1 job is blocked.' })
    api.preflight.mockResolvedValueOnce(ok(report('pf-none', { ready: 0, blocked: 0 })))
    await actions.refreshReview()
    await expect(actions.start()).resolves.toEqual({ status: 'not-ready', reason: 'Nothing can run.' })
    expect(api.start).not.toHaveBeenCalled()
  })

  it('ignores further presses while Start is answered', async () =>
  {
    const { api, actions } = harness()
    await actions.openReview()
    const answer = deferred<Reply>()
    api.start.mockImplementationOnce(() => answer.promise)
    const first = actions.start()
    await flush()
    await expect(actions.start()).resolves.toEqual({ status: 'busy' })
    await expect(actions.append()).resolves.toEqual({ status: 'busy' })
    answer.resolve(ok({ runId: RUN, queued: [A, B], skipped: [], blocked: [], repeated: false }))
    await expect(first).resolves.toMatchObject({ status: 'started' })
    expect(api.start).toHaveBeenCalledTimes(1)
  })

  it('starts only the selected jobs with their own plan, and goes back to all', async () =>
  {
    const { api, view, actions } = harness()
    await actions.openReview()
    api.preflight.mockResolvedValueOnce(ok(report('pf-sub', { jobs: 1, ready: 1 })))
    const outcome = await actions.startSelected([A])
    expect(api.preflight).toHaveBeenLastCalledWith({ ids: [A] })
    expect(api.start).toHaveBeenCalledWith({ preflightId: 'pf-sub', ack: null, resume: false })
    expect(outcome.status).toBe('started')
    await actions.openReview()
    view.getState().setReviewSubset([A])
    await actions.backToAll()
    expect(view.getState().review.subset).toBeNull()
    expect(api.preflight).toHaveBeenLastCalledWith({ ids: 'pending' })
  })

  it('returns a refused or superseded subset plan without starting', async () =>
  {
    const { api, actions } = harness()
    api.preflight.mockResolvedValueOnce(fail('not-found', 'Those jobs are gone.'))
    await expect(actions.startSelected([A])).resolves.toMatchObject({ status: 'refused', message: 'Those jobs are gone.' })
    api.preflight.mockResolvedValueOnce(fail('superseded'))
    await expect(actions.startSelected([A])).resolves.toMatchObject({ status: 'not-ready' })
    api.preflight.mockResolvedValueOnce(fail('superseded'))
    await expect(actions.append()).resolves.toMatchObject({ status: 'not-ready' })
    api.preflight.mockResolvedValueOnce(fail('io-error', 'Disk error.'))
    await expect(actions.append()).resolves.toMatchObject({ status: 'refused', message: 'Disk error.' })
    expect(api.start).not.toHaveBeenCalled()
  })

  it('appends as a preflight of the waiting jobs, then Start', async () =>
  {
    const { api, view, toasts, actions } = harness([job(A), job(B), job(C, { state: 'encoding' as JobState, runId: RUN })], { run: run() })
    view.getState().markRunAvailable()
    view.getState().setMode('review')
    api.preflight.mockResolvedValueOnce(ok(report('pf-append')))
    const outcome = await actions.append()
    expect(api.preflight.mock.invocationCallOrder[0]).toBeLessThan(api.start.mock.invocationCallOrder[0])
    expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
    expect(api.start).toHaveBeenCalledWith({ preflightId: 'pf-append', ack: null, resume: false })
    expect(outcome).toMatchObject({ status: 'started', appended: true })
    expect(toasts.at(-1)?.title).toBe('Appended 2 jobs to Batch 31.')
  })
})

describe('commit before acting', () =>
{
  it('waits for a committed draft to be applied before sending Start, which then comes back stale', async () =>
  {
    const { api, jobs, actions } = harness()
    await actions.openReview()
    const stop = actions.registerDraftCommitter(() => ({ status: 'committed', seq: 7, field: 'Target, integrated', ids: [A] }))
    api.start.mockResolvedValueOnce(fail('plan-stale', 'Plan changed.', { changed: [A] }))
    const pending = actions.start()
    await flush()
    expect(api.start).not.toHaveBeenCalled()
    jobs.setState({ seq: 7 })
    await expect(pending).resolves.toEqual({ status: 'stale', changed: [A], reason: 'Target, integrated changed for 1 job. Review it, then Start again.' })
    expect(api.start).toHaveBeenCalledTimes(1)
    stop()
  })

  it('refuses every brass action on an invalid draft and names the field', async () =>
  {
    const { api, announce, drafts, actions } = harness()
    drafts.register(() => ({ status: 'invalid', field: 'Target, integrated' }))
    const refusal = { status: 'invalid-draft', field: 'Target, integrated' }
    await expect(actions.openReview()).resolves.toEqual(refusal)
    await expect(actions.start()).resolves.toEqual(refusal)
    await expect(actions.startSelected([A])).resolves.toEqual(refusal)
    await expect(actions.append()).resolves.toEqual(refusal)
    await expect(actions.retry([A])).resolves.toEqual(refusal)
    await expect(actions.resume()).resolves.toEqual(refusal)
    expect(announce).toHaveBeenCalledWith('Fix Target, integrated first.')
    expect(api.preflight).not.toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled()
    expect(api.retry).not.toHaveBeenCalled()
    expect(api.resume).not.toHaveBeenCalled()
  })

  it('goes ahead at once when a committed draft names no field and is already applied', async () =>
  {
    const { api, jobs, actions } = harness()
    jobs.setState({ seq: 9 })
    actions.registerDraftCommitter(async () => ({ status: 'committed', seq: 9 }))
    await actions.openReview()
    await expect(actions.start()).resolves.toMatchObject({ status: 'started' })
    expect(api.start).toHaveBeenCalledTimes(1)
  })
})

describe('queue edits and undo', () =>
{
  it('applies a recipe to the jobs not in a batch as one command and undoes it across every job in one step', async () =>
  {
    const { api, jobs, toasts, announce, actions } = harness([job(A), job(B), job(C, { state: 'queued' as JobState, runId: RUN })])
    const outcome = await actions.assignRecipes([A, B, C].map((jobId) => ({ jobId, recipe: QUIET })), {
      toast: { kind: 'applied', preset: 'Quiet', note: '1 has no video stream and is now blocked.' }
    })
    expect(api.assignRecipe).toHaveBeenCalledWith({ assignments: [{ jobId: A, recipe: QUIET }, { jobId: B, recipe: QUIET }] })
    expect(outcome).toMatchObject({ status: 'done', entryId: expect.any(Number) })
    expect(toasts[0]).toMatchObject({ tone: 'success', title: 'Applied Quiet to 2 jobs.', body: '1 has no video stream and is now blocked.' })
    patchJob(jobs, A, { recipe: QUIET })
    patchJob(jobs, B, { recipe: QUIET })
    toastAction(toasts[0], 'Undo')()
    await flush()
    expect(api.assignRecipe).toHaveBeenCalledTimes(2)
    expect(api.assignRecipe).toHaveBeenLastCalledWith({ assignments: [{ jobId: A, recipe: LOUD }, { jobId: B, recipe: LOUD }] })
    expect(announce).toHaveBeenCalledWith('Undid the settings change for 2 jobs.')
    expect(actions.canRedo()).toBe(true)
    patchJob(jobs, A, { recipe: LOUD })
    patchJob(jobs, B, { recipe: LOUD })
    await actions.redo()
    expect(api.assignRecipe).toHaveBeenLastCalledWith({ assignments: [{ jobId: A, recipe: QUIET }, { jobId: B, recipe: QUIET }] })
    expect(announce).toHaveBeenCalledWith('Redid the settings change for 2 jobs.')
  })

  it('refuses the undo for jobs that started since, with the counted message', async () =>
  {
    const { api, jobs, toasts, actions } = harness([job(A), job(B), job(C)])
    await actions.assignRecipes([A, B, C].map((jobId) => ({ jobId, recipe: QUIET })), { toast: { kind: 'operation', label: 'Normalize · Quiet' } })
    expect(toasts[0].title).toBe('Changed 3 jobs to Normalize · Quiet.')
    patchJob(jobs, A, { recipe: QUIET, state: 'encoding' as JobState, runId: RUN })
    patchJob(jobs, B, { recipe: QUIET, state: 'done' as JobState, runId: RUN })
    patchJob(jobs, C, { recipe: QUIET })
    const outcome = await actions.undo()
    expect(outcome).toMatchObject({ status: 'done', refusal: 'Cannot undo for 2 jobs that already started.' })
    expect(api.assignRecipe).toHaveBeenLastCalledWith({ assignments: [{ jobId: C, recipe: LOUD }] })
    expect(toasts.at(-1)).toMatchObject({ tone: 'warning', title: 'Cannot undo for 2 jobs that already started.' })
  })

  it('removes with Undo, and words a restore main no longer keeps', async () =>
  {
    const { api, jobs, toasts, actions } = harness([job(A), job(B), job(C)])
    await actions.remove([A, B])
    expect(toasts[0]).toMatchObject({ title: 'Removed 2 jobs.' })
    jobs.setState({ order: [C], jobs: { [C]: jobs.getState().jobs[C] } as Record<JobId, JobView> })
    api.restore.mockResolvedValueOnce(fail('restore-expired', 'Tombstone expired.'))
    toastAction(toasts[0], 'Undo')()
    await flush()
    expect(api.restore).toHaveBeenCalledWith({ tombstone: 'tomb-1' })
    expect(toasts.at(-1)).toMatchObject({ tone: 'warning', title: 'Cannot undo: removed jobs can be restored for 10 minutes.' })
    api.remove.mockResolvedValueOnce(fail('invalid-state', 'Cannot remove now.'))
    await expect(actions.remove([C])).resolves.toMatchObject({ status: 'refused', message: 'Cannot remove now.' })
  })

  it('says when there is nothing to undo or redo, and tells listeners when the history changes', async () =>
  {
    const { announce, actions } = harness()
    await expect(actions.undo()).resolves.toEqual({ status: 'empty' })
    expect(announce).toHaveBeenCalledWith('Nothing to undo.')
    await expect(actions.redo()).resolves.toEqual({ status: 'empty' })
    expect(announce).toHaveBeenCalledWith('Nothing to redo.')
    const listener = vi.fn()
    const stop = actions.subscribeUndo(listener)
    expect(actions.canUndo()).toBe(false)
    await actions.remove([A])
    expect(listener).toHaveBeenCalled()
    expect(actions.canUndo()).toBe(true)
    stop()
  })

  it('keeps the recipes of jobs in a batch, lets Edit and retry change a finished job, and shows a refusal', async () =>
  {
    const { api, toasts, actions } = harness([job(A, { state: 'failed' as JobState, runId: RUN }), job(B, { state: 'encoding' as JobState, runId: RUN }), job(C)])
    await expect(actions.assignRecipes([{ jobId: A, recipe: QUIET }])).resolves.toEqual({
      status: 'refused', code: 'nothing', message: 'Queued, running, and finished jobs keep their settings.'
    })
    await actions.assignRecipes([{ jobId: A, recipe: QUIET }, { jobId: B, recipe: QUIET }], { retryDraft: true })
    expect(api.assignRecipe).toHaveBeenCalledWith({ assignments: [{ jobId: A, recipe: QUIET }] })
    expect(toasts).toHaveLength(0)
    api.assignRecipe.mockResolvedValueOnce(fail('invalid-payload', 'The recipe is not valid.'))
    await expect(actions.assignRecipes([{ jobId: C, recipe: QUIET }])).resolves.toMatchObject({ status: 'refused' })
    expect(toasts[0]).toMatchObject({ tone: 'error', title: 'The recipe is not valid.' })
    api.assignRecipe.mockResolvedValueOnce(ok({ applied: [], refused: [{ jobId: C, code: 'invalid-recipe', message: 'Invalid.' }] }))
    await expect(actions.assignRecipes([{ jobId: C, recipe: QUIET }])).resolves.toMatchObject({ status: 'done', entryId: null })
  })

  it('duplicates jobs, selects the new ones once applied, and offers Undo', async () =>
  {
    const { api, jobs, view, toasts, actions } = harness()
    api.duplicate.mockResolvedValueOnce(ok({ applied: [A], refused: [], created: [C] }, 3))
    const pending = actions.duplicate([A])
    await flush()
    addRows(jobs, [job(C)], 3)
    await expect(pending).resolves.toMatchObject({ status: 'done', entryId: expect.any(Number) })
    expect([...view.getState().views.queue.selection.selected]).toEqual([C])
    expect(toasts[0]).toMatchObject({ title: 'Duplicated 1 job.' })
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Undo'])
    api.duplicate.mockResolvedValueOnce(ok({ applied: [A, B], refused: [], created: [D] }))
    await actions.duplicate([A, B], { recipe: MP4, preset: 'MP3 320k' })
    expect(api.duplicate).toHaveBeenLastCalledWith({ ids: [A, B], recipe: MP4 })
    expect(toasts[1].title).toBe('Added 1 job with MP3 320k.')
    api.duplicate.mockResolvedValueOnce(ok({ applied: [], refused: [], created: [] }))
    await expect(actions.duplicate([A])).resolves.toMatchObject({ status: 'done', entryId: null })
    api.duplicate.mockResolvedValueOnce(fail('queue-full', 'The queue is full.'))
    await expect(actions.duplicate([A])).resolves.toMatchObject({ status: 'refused', code: 'queue-full' })
  })

  it('moves jobs among the movable ones, with an undo entry for the move', async () =>
  {
    const { api, actions } = harness([job(A), job(B), job(C), job(D, { state: 'done' as JobState })])
    await expect(actions.move([C], 'up')).resolves.toMatchObject({ status: 'done', entryId: expect.any(Number) })
    expect(api.reorder).toHaveBeenLastCalledWith({ ids: [C], before: B })
    await actions.move([A], 'down')
    expect(api.reorder).toHaveBeenLastCalledWith({ ids: [A], before: C })
    await actions.move([B, C], 'top')
    expect(api.reorder).toHaveBeenLastCalledWith({ ids: [B, C], before: A })
    await actions.move([A], 'bottom')
    expect(api.reorder).toHaveBeenLastCalledWith({ ids: [A], before: null })
    for (const [ids, where] of [[[A], 'up'], [[C], 'down'], [[A, B], 'top'], [[C], 'bottom'], [[D], 'up']] as const)
    {
      await expect(actions.move(ids, where)).resolves.toEqual({ status: 'refused', code: 'nothing', message: 'Nothing to move.' })
    }
    api.reorder.mockResolvedValueOnce(ok({ applied: [], refused: [] }))
    await expect(actions.reorder([A], B)).resolves.toMatchObject({ status: 'done', entryId: null })
    api.reorder.mockResolvedValueOnce(fail('invalid-state', 'Sort by queue order to reorder.'))
    await expect(actions.reorder([A], B)).resolves.toMatchObject({ status: 'refused' })
  })

  it('clears with Undo and says how many jobs that need attention stayed', async () =>
  {
    const { api, toasts, actions } = harness()
    api.clear.mockResolvedValueOnce(ok({ removed: 3, kept: 2, tombstone: 'tomb-clear' }))
    await expect(actions.clear({ kind: 'done' })).resolves.toMatchObject({ status: 'done', entryId: expect.any(Number) })
    expect(toasts[0]).toMatchObject({ title: 'Cleared 3 jobs.', body: '2 jobs that need attention stay until acknowledged.' })
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Undo'])
    api.clear.mockResolvedValueOnce(ok({ removed: 0, kept: 1, tombstone: null }))
    await expect(actions.clear({ kind: 'finished' })).resolves.toMatchObject({ entryId: null })
    expect(toasts[1]).toMatchObject({ tone: 'warning', title: '1 job that needs attention stays until acknowledged.' })
    api.clear.mockResolvedValueOnce(ok({ removed: 0, kept: 0, tombstone: null }))
    await actions.clear({ kind: 'ids', ids: [A] })
    expect(toasts).toHaveLength(2)
    api.clear.mockResolvedValueOnce(fail('invalid-state', 'Cannot clear now.'))
    await expect(actions.clear({ kind: 'done' })).resolves.toMatchObject({ status: 'refused' })
    expect(toasts[2]).toMatchObject({ tone: 'error', title: 'Cannot clear now.' })
  })

  it('changes the output settings with an undo entry, and shows a refusal while a batch runs', async () =>
  {
    const { api, toasts, actions } = harness()
    await expect(actions.setPolicy({ template: '{name}-x' } as never)).resolves.toMatchObject({ status: 'done', entryId: expect.any(Number) })
    await actions.undo()
    expect(api.setPolicy).toHaveBeenLastCalledWith({ policy: expect.objectContaining({ template: '{name}' }) })
    api.setPolicy.mockResolvedValueOnce(fail('invalid-state', 'Output is locked while Batch 31 runs.'))
    await expect(actions.setPolicy({ template: '{name}' } as never)).resolves.toMatchObject({ status: 'refused', code: 'invalid-state' })
    expect(toasts.at(-1)?.title).toBe('Output is locked while Batch 31 runs.')
  })

  it('records no undo entry for a policy change before the policy is known', async () =>
  {
    const { actions } = harness([job(A)], { policy: null })
    await expect(actions.setPolicy({ template: '{name}' } as never)).resolves.toMatchObject({ status: 'done', entryId: null })
  })
})

describe('run control', () =>
{
  it('announces a pause at once and again when it settles', async () =>
  {
    const { api, jobs, announce, actions } = harness([job(A, { state: 'encoding' as JobState, runId: RUN })], { run: run() })
    const outcome = await actions.pause()
    expect(api.pause).toHaveBeenCalledWith({ mode: 'finish-running' })
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31. 3 running jobs finish first.')
    jobs.setState({ run: run({ status: 'pausing' }) })
    expect(announce).not.toHaveBeenCalledWith('Batch 31 paused.')
    jobs.setState({ run: run({ status: 'paused' }) })
    expect(announce).toHaveBeenCalledWith('Batch 31 paused.')
    expect(outcome).toMatchObject({ status: 'done' })
    jobs.setState({ run: run({ status: 'running' }) })
    jobs.setState({ run: run({ status: 'paused' }) })
    expect(announce.mock.calls.filter(([message]) => message === 'Batch 31 paused.')).toHaveLength(1)
  })

  it('words Pause now, a pause with nothing running, and a refusal', async () =>
  {
    const counts = run().counts
    const { api, jobs, announce, actions } = harness([job(A)], { run: run({ counts: { ...counts, encoding: 0, analyzing: 1, verifying: 2 } }) })
    api.pause.mockResolvedValueOnce(ok(run({ status: 'paused' })))
    await actions.pause('stop-running')
    expect(api.pause).toHaveBeenCalledWith({ mode: 'stop-running' })
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31. 1 running job restarts from the beginning.')
    expect(announce).toHaveBeenCalledWith('Batch 31 paused.')
    jobs.setState({ run: run({ counts: { ...counts, encoding: 1 } }) })
    api.pause.mockResolvedValueOnce(ok(run({ status: 'paused' })))
    await actions.pause('stop-running')
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31. 1 running job restarts from the beginning.')
    jobs.setState({ run: run({ counts: { ...counts, encoding: 1, analyzing: 1 } }) })
    api.pause.mockResolvedValueOnce(ok(run({ status: 'paused' })))
    await actions.pause('stop-running')
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31. 2 running jobs restart from the beginning.')
    jobs.setState({ run: run({ counts: { ...counts, encoding: 1 } }) })
    api.pause.mockResolvedValueOnce(ok(run({ status: 'paused' })))
    await actions.pause()
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31. 1 running job finishes first.')
    jobs.setState({ run: run({ counts: { ...counts, encoding: 0 } }) })
    api.pause.mockResolvedValueOnce(ok(run({ status: 'paused' })))
    await actions.pause()
    expect(announce).toHaveBeenCalledWith('Pausing Batch 31.')
    api.pause.mockResolvedValueOnce(fail('invalid-state', 'No batch is running.'))
    await expect(actions.pause()).resolves.toMatchObject({ status: 'refused' })
    expect(announce).toHaveBeenLastCalledWith('No batch is running.')
  })

  it('stops watching a pause the run left by ending, and words a pause without a run', async () =>
  {
    const { jobs, announce, actions } = harness([job(A)], { run: null })
    await actions.pause()
    expect(announce).toHaveBeenCalledWith('Pausing the batch.')
    jobs.setState({ run: run({ status: 'running' }) })
    await actions.pause()
    jobs.setState({ run: run({ status: 'canceling' }) })
    jobs.setState({ run: run({ status: 'paused' }) })
    expect(announce).not.toHaveBeenCalledWith('Batch 31 paused.')
  })

  it('resumes, and a restored batch that replaces originals waits for its acknowledgment', async () =>
  {
    const { api, jobs, announce, actions } = harness([job(A)], { run: run({ status: 'paused', needsAck: { originalsAffected: 4, overwrites: 1 } }) })
    await expect(actions.resume()).resolves.toEqual({ status: 'needs-acknowledgment' })
    expect(api.resume).not.toHaveBeenCalled()
    expect(announce).toHaveBeenCalledWith('Resume waits for the acknowledgment.')
    await expect(actions.resume({ acknowledged: true })).resolves.toMatchObject({ status: 'done' })
    expect(api.resume).toHaveBeenCalledWith({ ack: { preflightId: RUN, originalsAffected: 4, overwrites: 1 } })
    expect(announce).toHaveBeenCalledWith('Batch 31 resumed.')
    api.resume.mockResolvedValueOnce(fail('confirmation-required', 'Confirm.'))
    await expect(actions.resume({ acknowledged: true })).resolves.toEqual({ status: 'needs-acknowledgment' })
    jobs.setState({ run: run({ status: 'paused' }) })
    await actions.resume()
    expect(api.resume).toHaveBeenLastCalledWith({ ack: null })
    api.resume.mockResolvedValueOnce(fail('invalid-state', 'The batch is not paused.'))
    await expect(actions.resume()).resolves.toMatchObject({ status: 'refused', message: 'The batch is not paused.' })
    expect(announce).toHaveBeenLastCalledWith('The batch is not paused.')
  })

  it('toggles with Ctrl+P and says so when no batch runs', async () =>
  {
    const { api, jobs, announce, actions } = harness()
    await expect(actions.togglePause()).resolves.toEqual({ status: 'refused', code: 'nothing', message: 'No batch is running.' })
    expect(announce).toHaveBeenCalledWith('No batch is running.')
    jobs.setState({ run: run() })
    await actions.togglePause()
    expect(api.pause).toHaveBeenCalledTimes(1)
    jobs.setState({ run: run({ status: 'pausing' }) })
    await actions.togglePause()
    expect(api.resume).toHaveBeenCalledTimes(1)
    jobs.setState({ run: run({ status: 'paused' }) })
    await actions.togglePause()
    expect(api.resume).toHaveBeenCalledTimes(2)
  })

  it('cancels the run and drops a pending pause announcement', async () =>
  {
    const { api, jobs, announce, actions } = harness([job(A)], { run: run() })
    await actions.pause()
    await expect(actions.cancelRun()).resolves.toMatchObject({ status: 'done', value: { canceled: 4 } })
    expect(api.cancelRun).toHaveBeenCalledWith({})
    expect(announce).toHaveBeenCalledWith('Canceling Batch 31.')
    jobs.setState({ run: run({ status: 'paused' }) })
    expect(announce).not.toHaveBeenCalledWith('Batch 31 paused.')
    api.cancelRun.mockResolvedValueOnce(fail('invalid-state', 'No batch is running.'))
    await expect(actions.cancelRun()).resolves.toMatchObject({ status: 'refused' })
  })
})

describe('per-job intervention', () =>
{
  const rows = (): JobView[] => [
    job(A, { state: 'encoding' as JobState, runId: RUN }),
    job(B, { state: 'queued' as JobState, runId: RUN }),
    job(C, { state: 'queued' as JobState, runId: RUN }),
    job(D)
  ]

  it('cancels running jobs only, with Retry', async () =>
  {
    const { api, toasts, actions } = harness(rows(), { run: run() })
    await actions.cancelJobs([A, B])
    expect(api.cancel).toHaveBeenCalledWith({ ids: [A] })
    expect(toasts[0]).toMatchObject({ title: `Canceled ${A}.`, body: 'Retry runs it later.' })
    toastAction(toasts[0], 'Retry')()
    await flush()
    expect(api.retry).toHaveBeenCalledWith({ ids: [A], recipe: null, ack: null, start: true })
    await expect(actions.cancelJobs([B, D])).resolves.toEqual({ status: 'refused', code: 'nothing', message: 'Only running jobs can be canceled.' })
  })

  it('words several cancels and announces jobs main left as they were', async () =>
  {
    const { api, toasts, announce, actions } = harness([
      job(A, { state: 'encoding' as JobState }), job(B, { state: 'finalizing' as JobState }), job(C, { state: 'verifying' as JobState })
    ], { run: run() })
    api.cancel.mockResolvedValueOnce(ok({ applied: [A, C], refused: [{ jobId: B, code: 'job-finalizing', message: `${B} is saving its output.` }] }))
    await actions.cancelJobs([A, B, C])
    expect(toasts[0]).toMatchObject({ title: 'Canceled 2 jobs.', body: 'Retry runs them later.' })
    expect(announce).toHaveBeenCalledWith(`${B} is saving its output.`)
    api.cancel.mockResolvedValueOnce(ok({ applied: [], refused: [{ jobId: A, code: 'job-finalizing', message: 'One.' }, { jobId: B, code: 'job-finalizing', message: 'Two.' }] }))
    await actions.cancelJobs([A, B])
    expect(announce).toHaveBeenCalledWith('2 jobs were not changed. One.')
    expect(toasts).toHaveLength(1)
    api.cancel.mockResolvedValueOnce(fail('internal', 'Broken.'))
    await expect(actions.cancelJobs([A])).resolves.toMatchObject({ status: 'refused', message: 'Broken.' })
  })

  it('skips queued jobs with Retry, worded for one and for several', async () =>
  {
    const { api, toasts, actions } = harness(rows(), { run: run() })
    await actions.skip([B])
    expect(toasts[0]).toMatchObject({ title: `Skipped ${B}. Retry runs it later.` })
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Retry'])
    await actions.skip([A, B, C])
    expect(api.skip).toHaveBeenLastCalledWith({ ids: [B, C] })
    expect(toasts[1].title).toBe('Skipped 2 jobs. Retry runs them later.')
    await expect(actions.skip([A, D])).resolves.toMatchObject({ code: 'nothing', message: 'Only queued jobs can be skipped.' })
    api.skip.mockResolvedValueOnce(ok({ applied: [], refused: [] }))
    await actions.skip([B])
    expect(toasts).toHaveLength(2)
    api.skip.mockResolvedValueOnce(fail('invalid-state', 'Nope.'))
    await expect(actions.skip([B])).resolves.toMatchObject({ status: 'refused' })
  })

  it('takes queued jobs out of the batch and offers Review', async () =>
  {
    const { api, view, toasts, actions } = harness(rows(), { run: run() })
    view.getState().markRunAvailable()
    view.getState().setMode('run')
    await actions.takeOut([B])
    expect(api.unqueue).toHaveBeenCalledWith({ ids: [B] })
    expect(toasts[0].title).toBe(`Took ${B} out of Batch 31. It waits in the queue.`)
    toastAction(toasts[0], 'Review')()
    await flush()
    expect(view.getState().mode).toBe('review')
    expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
    await actions.takeOut([B, C])
    expect(toasts.at(-1)?.title).toBe('Took 2 jobs out of Batch 31. They wait in the queue.')
    await expect(actions.takeOut([D])).resolves.toMatchObject({ code: 'nothing' })
    api.unqueue.mockResolvedValueOnce(ok({ applied: [], refused: [] }))
    const count = toasts.length
    await actions.takeOut([B])
    expect(toasts).toHaveLength(count)
    api.unqueue.mockResolvedValueOnce(fail('invalid-state', 'Nope.'))
    await expect(actions.takeOut([B])).resolves.toMatchObject({ status: 'refused' })
  })

  it('retries returned jobs and sends jobs whose plans changed to Review', async () =>
  {
    const { api, view, toasts, announce, actions } = harness([job(A, { state: 'failed' as JobState, runId: RUN }), job(B, { state: 'failed' as JobState, runId: RUN })])
    api.retry.mockResolvedValueOnce(ok({ applied: [A, B], refused: [], queued: [A], pending: [B], changed: [B], runId: RUN }))
    await expect(actions.retry('failed')).resolves.toMatchObject({ status: 'done' })
    expect(api.retry).toHaveBeenCalledWith({ ids: 'failed', recipe: null, ack: null, start: true })
    expect(announce).toHaveBeenCalledWith(`Retrying ${A}.`)
    expect(toasts[0]).toMatchObject({ tone: 'warning', title: '1 job waits for review: its output changed.' })
    toastAction(toasts[0], 'Review')()
    await flush()
    expect(view.getState().mode).toBe('review')
    api.retry.mockResolvedValueOnce(ok({ applied: [A, B], refused: [], queued: [A, B], pending: [], changed: [A, B], runId: RUN }))
    await actions.retry([A, B], { recipe: QUIET })
    expect(api.retry).toHaveBeenLastCalledWith({ ids: [A, B], recipe: QUIET, ack: null, start: true })
    expect(toasts[1].title).toBe('2 jobs wait for review: their outputs changed.')
    expect(announce).toHaveBeenCalledWith('Retrying 2 jobs.')
  })

  it('asks for the acknowledgment a destructive retry needs, then sends it', async () =>
  {
    const { api, toasts, actions } = harness([job(A, { state: 'failed' as JobState, runId: RUN })])
    const ack = { preflightId: 'pf-r', originalsAffected: 1, overwrites: 0 }
    api.retry.mockResolvedValueOnce(fail('confirmation-required', 'Confirm.', ack))
    await expect(actions.retry([A])).resolves.toEqual({ status: 'needs-acknowledgment', ack })
    expect(toasts).toHaveLength(0)
    api.retry.mockResolvedValueOnce(ok({ applied: [], refused: [], queued: [], pending: [], changed: [], runId: null }))
    await actions.retry([A], { ack })
    expect(api.retry).toHaveBeenLastCalledWith({ ids: [A], recipe: null, ack, start: true })
    api.retry.mockResolvedValueOnce(fail('confirmation-required', 'Confirm.', null))
    await expect(actions.retry([A])).resolves.toMatchObject({ status: 'refused', code: 'confirmation-required' })
    api.retry.mockResolvedValueOnce(fail('invalid-state', 'Not retryable.'))
    await expect(actions.retry([A])).resolves.toMatchObject({ status: 'refused', message: 'Not retryable.' })
  })
})

describe('decisions and acknowledgments', () =>
{
  const hold = (displaces: string | null): JobView['hold'] => ({
    reason: 'outside-tolerance', message: 'Outside tolerance.', outputPath: 'D:\\Out\\a.wav', displaces, actions: ['keep', 'keep-renamed', 'discard', 'retry'], since: 1
  }) as unknown as JobView['hold']

  it('asks before a placement that displaces a file, then sends the confirmed count', async () =>
  {
    const { api, announce, actions } = harness([
      job(A, { state: 'held' as JobState, hold: hold('D:\\Rips\\a.wav') }), job(B, { state: 'held' as JobState, hold: hold(null) }), job(C)
    ])
    await expect(actions.keepOutput([A, B])).resolves.toEqual({ status: 'needs-confirmation', displaces: 1 })
    expect(api.keepOutput).not.toHaveBeenCalled()
    await actions.keepOutput([A, B, C], { confirmed: true })
    expect(api.keepOutput).toHaveBeenCalledWith({ ids: [A, B], placement: 'planned', confirm: { displaces: 1 } })
    expect(announce).toHaveBeenCalledWith('Kept 2 outputs.')
    await actions.keepOutput([A], { placement: 'renamed' })
    expect(api.keepOutput).toHaveBeenLastCalledWith({ ids: [A], placement: 'renamed', confirm: null })
    expect(announce).toHaveBeenCalledWith(`Kept the output of ${A} under a new name.`)
    await actions.keepOutput([A, B], { placement: 'renamed' })
    expect(announce).toHaveBeenCalledWith('Kept 2 outputs under new names.')
    await actions.keepOutput([B])
    expect(announce).toHaveBeenCalledWith(`Kept the output of ${B}.`)
    api.keepOutput.mockResolvedValueOnce(ok({ applied: [], refused: [{ jobId: B, code: 'not-held', message: 'Already decided.' }] }))
    await actions.keepOutput([B])
    expect(announce).toHaveBeenLastCalledWith('Already decided.')
    api.keepOutput.mockResolvedValueOnce(fail('confirmation-required', 'Confirm.'))
    await expect(actions.keepOutput([A], { confirmed: true })).resolves.toEqual({ status: 'needs-confirmation', displaces: 1 })
    api.keepOutput.mockResolvedValueOnce(fail('invalid-state', 'Nope.'))
    await expect(actions.keepOutput([B])).resolves.toMatchObject({ status: 'refused' })
    await expect(actions.keepOutput([C])).resolves.toMatchObject({ code: 'nothing' })
  })

  it('discards waiting outputs', async () =>
  {
    const { api, announce, actions } = harness([job(A, { state: 'held' as JobState, hold: hold(null) }), job(B, { state: 'held' as JobState, hold: hold(null) }), job(C)])
    await actions.discardOutput([A])
    expect(api.discardOutput).toHaveBeenCalledWith({ ids: [A] })
    expect(announce).toHaveBeenCalledWith(`Discarded the output of ${A}.`)
    await actions.discardOutput([A, B, C])
    expect(announce).toHaveBeenCalledWith('Discarded 2 outputs.')
    api.discardOutput.mockResolvedValueOnce(ok({ applied: [], refused: [] }))
    await actions.discardOutput([A])
    await expect(actions.discardOutput([C])).resolves.toMatchObject({ code: 'nothing' })
    api.discardOutput.mockResolvedValueOnce(fail('invalid-state', 'Nope.'))
    await expect(actions.discardOutput([A])).resolves.toMatchObject({ status: 'refused' })
  })

  it('acknowledges every job of the batch that needs attention and counts the decisions left', async () =>
  {
    const OTHER = formatRunId(30)
    const { api, toasts, announce, actions } = harness([
      job(A, { state: 'failed' as JobState, runId: RUN }),
      job(B, { state: 'done' as JobState, runId: RUN, warnings: [{ code: 'below-target' }] as unknown as JobView['warnings'] }),
      job(C, { state: 'held' as JobState, runId: RUN, hold: hold(null) }),
      job(D, { state: 'done' as JobState, runId: RUN }),
      job(formatCatalog(5), { state: 'interrupted' as JobState, runId: OTHER })
    ])
    await actions.acknowledgeAll(RUN)
    expect(api.acknowledge).toHaveBeenCalledWith({ ids: [A, B] })
    expect(toasts[0]).toMatchObject({ tone: 'success', title: 'Acknowledged 2 jobs.', body: '1 job still needs a decision.' })
    await actions.acknowledgeAll(null)
    expect(api.acknowledge).toHaveBeenLastCalledWith({ ids: [A, B, formatCatalog(5)] })
    await actions.acknowledge([A])
    expect(toasts.at(-1)).toMatchObject({ title: 'Acknowledged 1 job.', body: undefined })
    await expect(actions.acknowledge([D])).resolves.toMatchObject({ code: 'nothing', message: 'Nothing to acknowledge.' })
    await expect(actions.acknowledge([C, 'MM-9999' as JobId])).resolves.toMatchObject({ code: 'nothing', message: '1 job still needs a decision.' })
    expect(announce).toHaveBeenCalledWith('1 job still needs a decision.')
    api.acknowledge.mockResolvedValueOnce(ok({ applied: [], refused: [{ jobId: A, code: 'needs-decision', message: 'Decide first.' }] }))
    const count = toasts.length
    await actions.acknowledge([A])
    expect(toasts).toHaveLength(count)
    api.acknowledge.mockResolvedValueOnce(fail('invalid-state', 'Nope.'))
    await expect(actions.acknowledge([A])).resolves.toMatchObject({ status: 'refused' })
  })
})

describe('Delete', () =>
{
  const E = formatCatalog(5)
  const F = formatCatalog(6)

  it('sorts the selection by what Delete does to each job', () =>
  {
    const rows = [job(A), job(B, { state: 'queued' as JobState }), job(C, { state: 'encoding' as JobState }), job(D, { state: 'done' as JobState }), job(E, { state: 'failed' as JobState })]
    const state = { jobs: Object.fromEntries(rows.map((row) => [row.id, row])) as Record<JobId, JobView> }
    expect(planDelete(state, [A, B, C, D, E, 'MM-9999' as JobId])).toEqual({ remove: [A], skip: [B], clear: [D], running: [C], attention: [E] })
  })

  it('acts on each job by its state, asks before several skips, and explains what stays', async () =>
  {
    const rows = [
      job(A), job(B, { state: 'queued' as JobState, runId: RUN }), job(C, { state: 'queued' as JobState, runId: RUN }),
      job(D, { state: 'encoding' as JobState, runId: RUN }), job(E, { state: 'done' as JobState, runId: RUN }), job(F, { state: 'failed' as JobState, runId: RUN })
    ]
    const { api, view, toasts, actions } = harness(rows, { run: run() })
    const all = [A, B, C, D, E, F]
    await expect(actions.deleteJobs(all)).resolves.toMatchObject({ status: 'needs-confirmation', plan: { skip: [B, C] } })
    expect(api.remove).not.toHaveBeenCalled()
    await expect(actions.deleteJobs(all, { confirmed: true })).resolves.toMatchObject({ status: 'done' })
    expect(api.remove).toHaveBeenCalledWith({ ids: [A] })
    expect(api.skip).toHaveBeenCalledWith({ ids: [B, C] })
    expect(api.clear).toHaveBeenCalledWith({ scope: { kind: 'ids', ids: [E] } })
    const running = toasts.find((toast) => toast.title === 'Running jobs are not stopped by Delete.')
    expect(running?.body).toBe('Use Cancel job (Shift+Delete).')
    const stays = toasts.find((toast) => toast.title === '1 job that needs attention stays until acknowledged.')
    expect(stays).toBeDefined()
    view.getState().markRunAvailable()
    view.getState().setMode('run')
    toastAction(stays as BatchToast, 'Show')()
    expect([...view.getState().views.run.selection.selected]).toEqual([F])
    view.getState().setMode('queue')
    toastAction(stays as BatchToast, 'Show')()
    expect([...view.getState().views.queue.selection.selected]).toEqual([F])
    view.getState().setMode('history')
    toastAction(stays as BatchToast, 'Show')()
    await expect(actions.deleteJobs([B])).resolves.toEqual({ status: 'refused', code: 'nothing', message: 'History is read-only.' })
    view.getState().setMode('run')
    await expect(actions.deleteJobs([B])).resolves.toMatchObject({ status: 'done' })
    expect(api.skip).toHaveBeenLastCalledWith({ ids: [B] })
  })
})

describe('reports, scans, and History', () =>
{
  it('saves a report and offers Show in folder; a canceled dialog says nothing', async () =>
  {
    const { api, toasts, revealPath, actions } = harness()
    await actions.exportReport({ runId: RUN }, 'csv')
    expect(api.exportReport).toHaveBeenCalledWith({ scope: { runId: RUN }, format: 'csv' })
    expect(toasts[0].title).toBe('Report saved: D:\\Exports\\molexMedia Batch 31 report.csv.')
    toastAction(toasts[0], 'Show in folder')()
    expect(revealPath).toHaveBeenCalledWith('D:\\Exports\\molexMedia Batch 31 report.csv')
    api.exportReport.mockResolvedValueOnce(ok({ canceled: true }))
    await expect(actions.exportReport({ ids: [A] }, 'json')).resolves.toMatchObject({ status: 'done', value: { canceled: true } })
    expect(toasts).toHaveLength(1)
    api.exportReport.mockResolvedValueOnce(fail('io-error', 'Could not write the report.'))
    await expect(actions.exportReport({ runId: RUN }, 'csv')).resolves.toMatchObject({ status: 'refused' })
  })

  it('offers no Show in folder without a way to show paths, and plans on window timers by default', async () =>
  {
    vi.useFakeTimers()
    try
    {
      const jobs = createJobsStore()
      jobs.setState({ status: 'hydrated', order: [A], jobs: { [A]: job(A) } as Record<JobId, JobView> })
      const api = fakeApi()
      const toasts: BatchToast[] = []
      const actions = createBatchActions({ api: api as never, jobs, view: createBatchViewStore({ storage: null }), notify: (toast) => toasts.push(toast), announce: () => undefined })
      live.push(actions)
      await actions.exportReport({ runId: RUN }, 'csv')
      expect(toasts[0].actions).toEqual([])
      patchJob(jobs, A, { recipe: QUIET })
      vi.advanceTimersByTime(LIVE_PREFLIGHT_DELAY_MS - 1)
      expect(api.preflight).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
      patchJob(jobs, A, { recipe: LOUD })
      actions.dispose()
      vi.advanceTimersByTime(LIVE_PREFLIGHT_DELAY_MS)
      expect(api.preflight).toHaveBeenCalledTimes(1)
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('sends other commands as settled outcomes, and words the relink offer', async () =>
  {
    const { api, actions } = harness()
    api.analyze.mockResolvedValueOnce(ok({ applied: [A], refused: [] }, 5))
    await expect(actions.send('analyze', { ids: [A] })).resolves.toEqual({ status: 'done', value: { applied: [A], refused: [] }, seq: 5 })
    api.reprobe.mockRejectedValueOnce(new Error('Error invoking remote method'))
    await expect(actions.send('reprobe', { ids: [A] })).resolves.toEqual({ status: 'refused', code: 'internal', message: 'Error invoking remote method' })
    expect(relinkOffer({ fromDir: 'D:\\Rips\\Old', toDir: 'E:\\Rips\\New', ids: Array.from({ length: 23 }, (_, index) => formatCatalog(index + 10)) }))
      .toBe('Relink 23 more jobs from D:\\Rips\\Old to E:\\Rips\\New?')
    expect(relinkOffer({ fromDir: 'a', toDir: 'b', ids: [A] })).toBe('Relink 1 more job from a to b?')
  })

  it('stops a folder scan', async () =>
  {
    const { api, actions } = harness()
    await expect(actions.cancelScan('scan-1')).resolves.toEqual({ status: 'done', value: null, seq: 0 })
    expect(api.cancelScan).toHaveBeenCalledWith({ scanId: 'scan-1' })
    api.cancelScan.mockResolvedValueOnce(fail('not-found', 'No such scan.'))
    await expect(actions.cancelScan('scan-2')).resolves.toMatchObject({ status: 'refused', message: 'No such scan.' })
  })

  it('searches History, ignoring a reply a newer search replaced', async () =>
  {
    const { api, actions } = harness()
    const first = deferred<Reply>()
    api.searchRuns.mockImplementationOnce(() => first.promise)
    const older = actions.searchHistory(' interview ')
    const newer = actions.searchHistory('interview 2')
    await expect(newer).resolves.toMatchObject({ status: 'done', value: { matches: [] } })
    first.resolve(ok({ matches: [], runs: 0, more: false }))
    await expect(older).resolves.toEqual({ status: 'superseded' })
    expect(api.searchRuns).toHaveBeenNthCalledWith(1, { query: 'interview', limit: 200, before: null })
    api.searchRuns.mockResolvedValueOnce(fail('io-error', 'Could not read history.'))
    await expect(actions.searchHistory('x', { limit: 50, before: { runId: RUN, jobId: A } })).resolves.toMatchObject({ status: 'refused' })
    expect(api.searchRuns).toHaveBeenLastCalledWith({ query: 'x', limit: 50, before: { runId: RUN, jobId: A } })
  })

  it('words the search summary and where a trashed original may be', () =>
  {
    expect(searchSummary(12, 5, 'interview')).toBe('12 jobs in 5 batches match “interview”.')
    expect(searchSummary(1, 1, ' tape ')).toBe('1 job in 1 batch matches “tape”.')
    expect(searchSummary(0, 0, 'none')).toBe('No jobs match “none”.')
    expect(binOf('d:\\Rips\\a.wav')).toBe('the Recycle Bin on D:')
    expect(binOf('/media/a.wav')).toBe('the Trash')
  })

  it('reruns a kept batch with an undo entry and reports sources it did not add', async () =>
  {
    const { api, toasts, actions } = harness()
    api.rerun.mockResolvedValueOnce(ok({ added: [C, D], missing: [{ jobId: A, path: 'D:\\Rips\\a.wav' }, { jobId: B, path: 'D:\\Rips\\b.wav' }], holdsOutput: [] }))
    const outcome = await actions.rerun(RUN, 'returned')
    expect(api.rerun).toHaveBeenCalledWith({ runId: RUN, jobIds: 'returned', force: false })
    expect(outcome).toMatchObject({ status: 'done', entryId: expect.any(Number) })
    expect(toasts[0]).toMatchObject({ title: 'Added 2 jobs to rerun Batch 31.', body: '2 sources are no longer at their paths; they were not added.' })
    expect(toasts[0].actions?.map((action) => action.label)).toEqual(['Show'])
    toastAction(toasts[0], 'Show')()
    expect(toasts[1]).toMatchObject({ title: 'No longer at their paths: 2', body: 'D:\\Rips\\a.wav; D:\\Rips\\b.wav' })
    expect(actions.canUndo()).toBe(true)
  })

  it('never reruns an output silently: one is named, several are counted, and Add anyway forces them', async () =>
  {
    const { api, toasts, actions } = harness()
    api.rerun.mockResolvedValueOnce(ok({ added: [], missing: [{ jobId: B, path: 'D:\\Rips\\b.wav' }], holdsOutput: [{ jobId: A, path: 'D:\\Rips\\a.wav', originalTrashed: true }] }))
    await expect(actions.rerun(RUN, [A, B])).resolves.toMatchObject({ entryId: null })
    expect(api.rerun).toHaveBeenCalledWith({ runId: RUN, jobIds: [A, B], force: false })
    expect(toasts[0]).toMatchObject({
      tone: 'warning',
      title: 'No jobs were added to rerun Batch 31.',
      body: `1 source is no longer at its path; it was not added. ${A} replaced its original; rerunning would process its output again. The original may still be in the Recycle Bin on D:.`
    })
    toastAction(toasts[0], 'Add anyway')()
    await flush()
    expect(api.rerun).toHaveBeenLastCalledWith({ runId: RUN, jobIds: [A], force: true })
    api.rerun.mockResolvedValueOnce(ok({ added: [], missing: [], holdsOutput: [{ jobId: A, path: '/media/a.wav', originalTrashed: false }] }))
    await actions.rerun(RUN, 'all')
    expect(toasts.at(-1)?.body).toBe(`${A} replaced its original; rerunning would process its output again.`)
    api.rerun.mockResolvedValueOnce(ok({ added: [], missing: [], holdsOutput: [{ jobId: A, path: '/media/a.wav', originalTrashed: false }, { jobId: B, path: '/media/b.wav', originalTrashed: true }] }))
    await actions.rerun(RUN, 'all')
    expect(toasts.at(-1)?.body).toBe('2 paths now hold outputs of the jobs they would rerun; they were not added.')
    api.rerun.mockResolvedValueOnce(fail('shutting-down', 'molexMedia is quitting.'))
    await expect(actions.rerun(RUN, 'all')).resolves.toMatchObject({ status: 'refused' })
  })

  it('deletes batches from history and closes an opened batch it deleted', async () =>
  {
    const { api, view, announce, actions } = harness()
    view.getState().setMode('history')
    view.getState().openHistoryBatch(RUN)
    await actions.deleteRuns([RUN])
    expect(api.deleteRuns).toHaveBeenCalledWith({ runIds: [RUN] })
    expect(view.getState().history.openRunId).toBeNull()
    expect(announce).toHaveBeenCalledWith('Deleted Batch 31 from history.')
    view.getState().openHistoryBatch(RUN)
    api.deleteRuns.mockResolvedValueOnce(ok({ deleted: 3 }))
    await actions.deleteRuns('all')
    expect(announce).toHaveBeenCalledWith('Deleted 3 batches from history.')
    expect(view.getState().history.openRunId).toBeNull()
    view.getState().openHistoryBatch(RUN)
    await actions.deleteRuns([formatRunId(30)])
    expect(view.getState().history.openRunId).toBe(RUN)
    api.deleteRuns.mockResolvedValueOnce(fail('invalid-state', 'Batch 31 is still open.'))
    await expect(actions.deleteRuns([RUN])).resolves.toMatchObject({ status: 'refused' })
  })
})

describe('the actions context', () =>
{
  type WrapperProps = { children?: React.ReactNode }

  it('hands regions the provided actions and refuses to run without a provider', () =>
  {
    const actions = createTestBatchActions()
    live.push(actions)
    const wrapper = ({ children }: WrapperProps) => createElement(BatchActionsContext.Provider, { value: actions }, children)
    const { result } = renderHook(() => useBatchActions(), { wrapper })
    expect(result.current).toBe(actions)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try
    {
      expect(() => renderHook(() => useBatchActions())).toThrow('useBatchActions needs a provider of BatchActionsContext.')
    }
    finally
    {
      quiet.mockRestore()
    }
  })

  it('binds the test provider to fresh stores and an engine surface that refuses what the test does not answer', async () =>
  {
    const notify = vi.fn()
    const preflight = vi.fn(async () => ok(report('pf-t')))
    const wrapper = ({ children }: WrapperProps) => createElement(TestBatchActionsProvider, { api: { preflight } as never, notify }, children)
    const { result, rerender, unmount } = renderHook(() => useBatchActions(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    await expect(result.current.refreshReview()).resolves.toMatchObject({ status: 'done', value: { preflightId: 'pf-t' } })
    await expect(result.current.remove([A])).resolves.toEqual({ status: 'refused', code: 'internal', message: INERT_COMMAND_MESSAGE })
    expect(notify).toHaveBeenCalledWith({ tone: 'error', title: INERT_COMMAND_MESSAGE })
    unmount()
  })

  it('lets a test replace single actions or pass its own', async () =>
  {
    const start = vi.fn(async () => ({ status: 'busy' as const }))
    const replaced = renderHook(() => useBatchActions(), {
      wrapper: ({ children }: WrapperProps) => createElement(TestBatchActionsProvider, { overrides: { start } }, children)
    })
    await replaced.result.current.start()
    expect(start).toHaveBeenCalledTimes(1)
    const own = createTestBatchActions({ jobs: createJobsStore(), view: createBatchViewStore({ storage: null }), announce: vi.fn() })
    live.push(own)
    const given = renderHook(() => useBatchActions(), {
      wrapper: ({ children }: WrapperProps) => createElement(TestBatchActionsProvider, { actions: own }, children)
    })
    expect(given.result.current).toBe(own)
  })

  it('answers inert commands with a refusal and never delivers events', async () =>
  {
    const api = inertJobsApi()
    await expect(api.start({ preflightId: 'x', ack: null, resume: false })).resolves.toMatchObject({ ok: false, error: { code: 'internal', message: INERT_COMMAND_MESSAGE } })
    const stop = api.onEvents(() => undefined)
    expect(stop()).toBeUndefined()
  })
})
