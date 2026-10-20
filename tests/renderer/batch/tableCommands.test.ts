/**
 * The Batch table's key commands: Space only toggles, Delete never stops a running job and asks before skipping
 * several, Shift+Delete asks before canceling, pins apply only in Queue and Review and never from a control.
 */
import { describe, expect, it, vi } from 'vitest'
import type { JobId } from '../../../src/shared/jobs/ids'
import { DEFAULT_PINS } from '../../../src/shared/jobs/presets'
import type { JobView, MediaSummary, PlanSummary } from '../../../src/shared/jobs/types'
import { createTestBatchActions } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import type { BatchActions } from '../../../src/renderer/src/stores/batchActions'
import { createBatchViewStore, type BatchMode, type ViewKey } from '../../../src/renderer/src/stores/batchView'
import { createJobsStore, initialJobsState } from '../../../src/renderer/src/stores/jobs'
import
{
  cancelQuestion,
  commandTargets,
  COPY_COLUMNS,
  CORRECTIVE_WORD,
  isHistoryList,
  isRunningJob,
  keyBelongsToControl,
  pinDigit,
  readTableKey,
  REORDER_SORTED,
  resultText,
  rowsAsText,
  runTableCommand,
  skipQuestion,
  type ConfirmRequest,
  type KeyChord,
  type TableCommandContext
} from '../../../src/renderer/src/components/batch/table/tableCommands'

const AT = new Date(2026, 9, 16, 13, 40).getTime()

const RECIPE = { kind: 'normalize', presetId: 'streaming' } as unknown as JobView['recipe']

let seq = 0

function plan(over: Partial<PlanSummary> = {}): PlanSummary
{
  return {
    status: 'ready',
    current: true,
    finalName: 'a.wav',
    relativePath: 'out\\a.wav',
    container: 'wav',
    resolution: 'place',
    encoderLabel: 'PCM 24-bit',
    errors: 0,
    warnings: 0,
    firstIssue: null,
    ...over
  } as PlanSummary
}

function media(over: Partial<MediaSummary> = {}): MediaSummary
{
  return { container: 'wav', durationSec: 3730, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false, ...over } as MediaSummary
}

function job(over: Partial<JobView> = {}): JobView
{
  seq += 1
  const id = `MM-${String(seq).padStart(4, '0')}` as JobId
  return {
    id,
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.wav`, name: `${id}.wav`, ext: 'wav', dir: 'D:\\Rips', size: 498_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE,
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: media(),
    probe: 'ok',
    plan: plan(),
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

interface Harness
{
  ctx: TableCommandContext
  confirms: ConfirmRequest[]
  announced: string[]
  select: ReturnType<typeof vi.fn>
  spies: Record<string, ReturnType<typeof vi.fn>>
}

function harness(jobs: readonly JobView[], over: Partial<TableCommandContext> = {}, actions: Partial<BatchActions> = {}): Harness
{
  const store = createJobsStore()
  store.setState({
    ...initialJobsState(),
    status: 'hydrated',
    hydrations: 1,
    order: jobs.map((entry) => entry.id),
    jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])),
    presets: { user: [], pins: DEFAULT_PINS, recent: [] }
  }, true)
  const done = { status: 'done', value: { applied: [], refused: [] }, seq: 1, entryId: null }
  const spies = {
    deleteJobs: vi.fn(async () => ({ status: 'done', plan: { remove: [], skip: [], clear: [], running: [], attention: [] } })),
    cancelJobs: vi.fn(async () => done),
    duplicate: vi.fn(async () => done),
    move: vi.fn(async () => done),
    pasteFiles: vi.fn(async () => ({ status: 'empty' })),
    assignRecipes: vi.fn(async () => done)
  }
  const real = createTestBatchActions({ jobs: store, view: createBatchViewStore({ storage: null }) })
  const confirms: ConfirmRequest[] = []
  const announced: string[] = []
  const select = vi.fn()
  const ctx: TableCommandContext = {
    actions: { ...real, ...spies, ...actions } as unknown as BatchActions,
    list: 'queue',
    mode: 'queue',
    platform: 'win32',
    jobs: store.getState(),
    selection: { selected: new Set(jobs.map((entry) => entry.id)), anchor: null, focus: jobs[0]?.id ?? null },
    focusedId: jobs[0]?.id ?? null,
    sorted: false,
    fromControl: false,
    now: AT + 271_000,
    select,
    confirm: (request) => void confirms.push(request),
    announce: (message) => void announced.push(message),
    writeText: vi.fn(),
    ...over
  }
  return { ctx, confirms, announced, select, spies }
}

async function settle(): Promise<void>
{
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function chord(key: string, extra: Partial<KeyChord> = {}): KeyChord
{
  return { key, code: extra.code ?? '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra }
}

describe('pinDigit', () =>
{
  it('reads the top-row digits by key position', () =>
  {
    expect(pinDigit('Digit1')).toBe(1)
    expect(pinDigit('Digit9')).toBe(9)
  })

  it('ignores zero, numeric keypad digits, and other keys', () =>
  {
    expect(pinDigit('Digit0')).toBeNull()
    expect(pinDigit('Numpad1')).toBeNull()
    expect(pinDigit('KeyA')).toBeNull()
  })
})

describe('readTableKey', () =>
{
  it('reads Space as a toggle and never as anything else', () =>
  {
    expect(readTableKey(chord(' ', { code: 'Space' }))).toEqual({ kind: 'toggle' })
    expect(readTableKey(chord(' ', { code: 'Space', ctrlKey: true }))).toEqual({ kind: 'toggle' })
    expect(readTableKey(chord(' ', { code: 'Space', shiftKey: true }))).toBeNull()
  })

  it('leaves Ctrl+Space and Cmd+Space to macOS', () =>
  {
    expect(readTableKey(chord(' ', { ctrlKey: true }), true)).toBeNull()
    expect(readTableKey(chord(' ', { metaKey: true }), true)).toBeNull()
    expect(readTableKey(chord(' '), true)).toEqual({ kind: 'toggle' })
  })

  it('reads Delete and Shift+Delete', () =>
  {
    expect(readTableKey(chord('Delete'))).toEqual({ kind: 'delete' })
    expect(readTableKey(chord('Delete', { shiftKey: true }))).toEqual({ kind: 'cancel' })
    expect(readTableKey(chord('Backspace'))).toBeNull()
  })

  it('reads the macOS delete key and Cmd+Delete', () =>
  {
    expect(readTableKey(chord('Backspace'), true)).toEqual({ kind: 'delete' })
    expect(readTableKey(chord('Backspace', { metaKey: true }), true)).toEqual({ kind: 'cancel' })
    expect(readTableKey(chord('Delete', { shiftKey: true }), true)).toBeNull()
  })

  it('reads Ctrl+D, Ctrl+C, and Ctrl+V in either case', () =>
  {
    expect(readTableKey(chord('d', { ctrlKey: true }))).toEqual({ kind: 'duplicate' })
    expect(readTableKey(chord('C', { ctrlKey: true }))).toEqual({ kind: 'copy' })
    expect(readTableKey(chord('v', { ctrlKey: true }))).toEqual({ kind: 'paste' })
    expect(readTableKey(chord('x', { ctrlKey: true }))).toBeNull()
    expect(readTableKey(chord('d', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(readTableKey(chord('d', { metaKey: true }), true)).toEqual({ kind: 'duplicate' })
  })

  it('ignores chords with the other platform modifier', () =>
  {
    expect(readTableKey(chord('d', { metaKey: true }))).toBeNull()
    expect(readTableKey(chord('d', { ctrlKey: true }), true)).toBeNull()
  })

  it('reads Alt with a top-row digit as a pin and Alt+Shift as an added job', () =>
  {
    expect(readTableKey(chord('1', { code: 'Digit1', altKey: true }))).toEqual({ kind: 'pin', digit: 1, add: false })
    expect(readTableKey(chord('!', { code: 'Digit1', altKey: true, shiftKey: true }))).toEqual({ kind: 'pin', digit: 1, add: true })
    expect(readTableKey(chord('¡', { code: 'Digit1', altKey: true }), true)).toEqual({ kind: 'pin', digit: 1, add: false })
  })

  it('ignores Alt with numeric keypad digits and AltGr', () =>
  {
    expect(readTableKey(chord('1', { code: 'Numpad1', altKey: true }))).toBeNull()
    expect(readTableKey(chord('End', { code: 'Numpad1', altKey: true }))).toBeNull()
    expect(readTableKey(chord('End', { code: 'End', altKey: true }))).toEqual({ kind: 'move', where: 'bottom' })
    expect(readTableKey(chord('2', { code: 'Digit2', altKey: true, ctrlKey: true }))).toBeNull()
  })

  it('reads Alt with arrows, Home, and End as moves', () =>
  {
    expect(readTableKey(chord('ArrowUp', { altKey: true }))).toEqual({ kind: 'move', where: 'up' })
    expect(readTableKey(chord('ArrowDown', { altKey: true }))).toEqual({ kind: 'move', where: 'down' })
    expect(readTableKey(chord('Home', { altKey: true }))).toEqual({ kind: 'move', where: 'top' })
    expect(readTableKey(chord('End', { altKey: true }))).toEqual({ kind: 'move', where: 'bottom' })
    expect(readTableKey(chord('ArrowUp', { altKey: true, shiftKey: true }))).toBeNull()
    expect(readTableKey(chord('ArrowLeft', { altKey: true }))).toBeNull()
  })

  it('forwards F8, Shift+F8, and the question mark', () =>
  {
    expect(readTableKey(chord('F8'))).toEqual({ kind: 'attention', direction: 'next' })
    expect(readTableKey(chord('F8', { shiftKey: true }))).toEqual({ kind: 'attention', direction: 'previous' })
    expect(readTableKey(chord('?', { shiftKey: true }))).toEqual({ kind: 'shortcuts' })
  })

  it('leaves plain keys to the grid', () =>
  {
    expect(readTableKey(chord('ArrowDown'))).toBeNull()
    expect(readTableKey(chord('Home'))).toBeNull()
    expect(readTableKey(chord('a'))).toBeNull()
  })
})

describe('keyBelongsToControl', () =>
{
  it('is true inside text fields, selects, menus, and popovers', () =>
  {
    const input = document.createElement('input')
    const select = document.createElement('select')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    const popover = document.createElement('div')
    popover.setAttribute('popover', 'auto')
    const inner = document.createElement('button')
    popover.append(inner)
    expect(keyBelongsToControl(input)).toBe(true)
    expect(keyBelongsToControl(select)).toBe(true)
    expect(keyBelongsToControl(item)).toBe(true)
    expect(keyBelongsToControl(inner)).toBe(true)
  })

  it('is false for a grid row and for no target', () =>
  {
    const row = document.createElement('div')
    row.setAttribute('role', 'row')
    expect(keyBelongsToControl(row)).toBe(false)
    expect(keyBelongsToControl(null)).toBe(false)
  })
})

describe('helpers', () =>
{
  it('knows running jobs and History lists', () =>
  {
    expect(isRunningJob({ state: 'encoding' })).toBe(true)
    expect(isRunningJob({ state: 'finalizing' })).toBe(true)
    expect(isRunningJob({ state: 'queued' })).toBe(false)
    expect((['history', 'historyResults', 'historyBatch', 'queue'] as ViewKey[]).map(isHistoryList)).toEqual([true, true, true, false])
  })

  it('takes the selection in queue order, else the focused job', () =>
  {
    const a = job()
    const b = job()
    const state = { order: [a.id, b.id], jobs: { [a.id]: a, [b.id]: b } }
    expect(commandTargets(state, new Set([b.id, a.id]), null).map((entry) => entry.id)).toEqual([a.id, b.id])
    expect(commandTargets(state, new Set(), b.id).map((entry) => entry.id)).toEqual([b.id])
    expect(commandTargets(state, new Set(['MM-9999']), null)).toEqual([])
  })

  it('words the skip question', () =>
  {
    expect(skipQuestion(38)).toBe('Skip 38 queued jobs? They end as Skipped; Retry runs them later.')
  })

  it('words the cancel question for one job and several', () =>
  {
    const one = job({ state: 'encoding', startedAt: AT })
    expect(cancelQuestion([one], { now: AT + 271_000, platform: 'win32', queued: 0 }))
      .toBe(`Cancel ${one.id}? 4 min 31 s of encoding is discarded and its partial file is deleted. The source is not touched.`)
    const several = [job({ state: 'encoding', startedAt: AT }), job({ state: 'verifying', startedAt: AT + 60_000 }), job({ state: 'analyzing', startedAt: null })]
    expect(cancelQuestion(several, { now: AT + 360_000, platform: 'win32', queued: 2 }))
      .toBe('Cancel 3 running jobs? 11 min of work is discarded and their partial files are deleted. 2 queued jobs in the selection stay queued; Delete skips them.')
    expect(cancelQuestion([one], { now: AT, platform: 'win32', queued: 1 })).toContain('1 queued job in the selection stays queued; Delete skips it.')
  })

  it('adds the first encode to the cancel question during the corrective encode', () =>
  {
    const corrective = job({ state: 'encoding', startedAt: AT, stage: { id: 'encode', pass: 2, passes: 2, label: CORRECTIVE_WORD, startedAt: AT } })
    const measured = cancelQuestion([corrective], { now: AT + 1000, platform: 'win32', queued: 0, firstMeasured: () => '-21.8 LUFS' })
    const unknown = cancelQuestion([corrective], { now: AT + 1000, platform: 'win32', queued: 0 })
    expect(measured).toContain('The first encode, measured -21.8 LUFS, is discarded too.')
    expect(unknown).toContain('The first encode is discarded too.')
  })

  it('copies rows as tab-separated text under a header', () =>
  {
    const a = job({ recipeLabel: 'Normalize\tStreaming' })
    const failed = job({ state: 'failed', plan: null, error: { code: 'ffmpeg-failed', short: 'Decode failed', message: 'x', stage: 'encode', at: AT } as JobView['error'] })
    const lines = rowsAsText([a, failed], 'win32').split('\n')
    expect(lines[0]).toBe(COPY_COLUMNS.join('\t'))
    expect(lines[1].split('\t')).toEqual([a.id, a.source.name, 'Ready', 'Normalize Streaming', '', 'out\\a.wav'])
    expect(lines[2].split('\t')[4]).toBe('Returned, Decode failed')
    expect(resultText(job())).toBe('')
  })
})

describe('runTableCommand', () =>
{
  it('toggles the focused row with Space in every mode and never pauses', () =>
  {
    for (const mode of ['queue', 'review', 'run'] as BatchMode[])
    {
      const togglePause = vi.fn()
      const pause = vi.fn()
      const a = job({ state: mode === 'run' ? 'encoding' : 'pending' })
      const { ctx, select, spies } = harness([a], { mode, list: mode }, { togglePause, pause } as Partial<BatchActions>)
      expect(runTableCommand({ kind: 'toggle' }, ctx)).toBe(true)
      expect(select).toHaveBeenCalledWith({ type: 'toggle', id: a.id })
      expect(togglePause).not.toHaveBeenCalled()
      expect(pause).not.toHaveBeenCalled()
      expect(spies.cancelJobs).not.toHaveBeenCalled()
    }
    const { ctx } = harness([], { focusedId: null })
    expect(runTableCommand({ kind: 'toggle' }, ctx)).toBe(false)
  })

  it('sends Delete to the state rules and confirms several skips at the focused row', async () =>
  {
    const queued = [job({ state: 'queued' }), job({ state: 'queued' })]
    const { ctx, confirms, spies } = harness(queued, { mode: 'run', list: 'run' })
    spies.deleteJobs.mockResolvedValueOnce({ status: 'needs-confirmation', plan: { remove: [], skip: queued.map((entry) => entry.id), clear: [], running: [], attention: [] } })
    expect(runTableCommand({ kind: 'delete' }, ctx)).toBe(true)
    await settle()
    expect(spies.deleteJobs).toHaveBeenCalledWith(queued.map((entry) => entry.id))
    expect(confirms).toHaveLength(1)
    expect(confirms[0]).toMatchObject({
      question: 'Skip 2 queued jobs? They end as Skipped; Retry runs them later.',
      safeLabel: 'Keep queued',
      confirmLabel: 'Skip 2 jobs',
      danger: false,
      anchorId: queued[0].id
    })
    confirms[0].onConfirm()
    expect(spies.deleteJobs).toHaveBeenLastCalledWith(queued.map((entry) => entry.id), { confirmed: true })
  })

  it('does not ask when Delete needs no confirmation', async () =>
  {
    const { ctx, confirms, spies } = harness([job()])
    runTableCommand({ kind: 'delete' }, ctx)
    await settle()
    expect(spies.deleteJobs).toHaveBeenCalledTimes(1)
    expect(confirms).toHaveLength(0)
  })

  it('leaves Delete on the History batch list to that list', () =>
  {
    const { ctx, spies } = harness([job()], { mode: 'history', list: 'history' })
    expect(runTableCommand({ kind: 'delete' }, ctx)).toBe(false)
    expect(spies.deleteJobs).not.toHaveBeenCalled()
    const opened = harness([], { mode: 'history', list: 'historyBatch', focusedId: null })
    expect(runTableCommand({ kind: 'delete' }, opened.ctx)).toBe(true)
    expect(opened.spies.deleteJobs).toHaveBeenCalledWith([])
    const empty = harness([], { focusedId: null })
    expect(runTableCommand({ kind: 'delete' }, empty.ctx)).toBe(false)
  })

  it('asks before canceling running jobs with Shift+Delete and leaves queued jobs alone', () =>
  {
    const running = job({ state: 'encoding', startedAt: AT })
    const queued = job({ state: 'queued' })
    const { ctx, confirms, spies } = harness([running, queued], { mode: 'run', list: 'run' })
    expect(runTableCommand({ kind: 'cancel' }, ctx)).toBe(true)
    expect(spies.cancelJobs).not.toHaveBeenCalled()
    expect(confirms[0]).toMatchObject({ safeLabel: 'Keep running', confirmLabel: 'Cancel job', danger: true, anchorId: running.id })
    expect(confirms[0].question).toContain(`Cancel ${running.id}? 4 min 31 s of encoding is discarded`)
    expect(confirms[0].question).toContain('1 queued job in the selection stays queued; Delete skips it.')
    confirms[0].onConfirm()
    expect(spies.cancelJobs).toHaveBeenCalledWith([running.id])
  })

  it('names several running jobs in the cancel confirmation', () =>
  {
    const { ctx, confirms } = harness([job({ state: 'encoding', startedAt: AT }), job({ state: 'verifying', startedAt: AT })], { mode: 'run', list: 'run' })
    runTableCommand({ kind: 'cancel' }, ctx)
    expect(confirms[0].confirmLabel).toBe('Cancel 2 jobs')
  })

  it('announces that only running jobs can be canceled, and leaves History alone', () =>
  {
    const { ctx, confirms, announced } = harness([job({ state: 'queued' })], { mode: 'run', list: 'run' })
    expect(runTableCommand({ kind: 'cancel' }, ctx)).toBe(true)
    expect(confirms).toHaveLength(0)
    expect(announced).toEqual(['Only running jobs can be canceled.'])
    expect(runTableCommand({ kind: 'cancel' }, harness([job()], { mode: 'history', list: 'historyBatch' }).ctx)).toBe(false)
  })

  it('applies a pin in Queue and adds second jobs with Alt+Shift in Review', async () =>
  {
    const a = job()
    const queue = harness([a])
    expect(runTableCommand({ kind: 'pin', digit: 6, add: false }, queue.ctx)).toBe(true)
    await settle()
    expect(queue.spies.assignRecipes).toHaveBeenCalledTimes(1)
    const [assignments, options] = queue.spies.assignRecipes.mock.calls[0] as unknown as [Array<{ jobId: string, recipe: { kind: string } }>, { toast: { kind: string } }]
    expect(assignments.map((entry) => entry.jobId)).toEqual([a.id])
    expect(assignments[0].recipe.kind).toBe('compress')
    expect(options.toast.kind).toBe('applied')

    const review = harness([a], { mode: 'review', list: 'review' })
    expect(runTableCommand({ kind: 'pin', digit: 7, add: true }, review.ctx)).toBe(true)
    await settle()
    expect(review.spies.duplicate).toHaveBeenCalledTimes(1)
    expect(review.spies.assignRecipes).not.toHaveBeenCalled()
  })

  it('never applies a pin in Run or History or from a control', () =>
  {
    const a = job()
    for (const over of [{ mode: 'run', list: 'run' }, { mode: 'history', list: 'historyBatch' }, { fromControl: true }] as Array<Partial<TableCommandContext>>)
    {
      const other = harness([a], over)
      expect(runTableCommand({ kind: 'pin', digit: 6, add: false }, other.ctx)).toBe(false)
      expect(other.spies.assignRecipes).not.toHaveBeenCalled()
      expect(other.spies.duplicate).not.toHaveBeenCalled()
    }
  })

  it('announces an empty pin and a selection that keeps its recipes', async () =>
  {
    const { ctx, announced } = harness([job({ state: 'queued' })])
    runTableCommand({ kind: 'pin', digit: 1, add: false }, ctx)
    await settle()
    expect(announced).toEqual(['These jobs keep their settings: they are queued, running, or finished.'])
    const empty = harness([job()])
    runTableCommand({ kind: 'pin', digit: 1, add: false }, { ...empty.ctx, jobs: { ...empty.ctx.jobs, presets: null } })
    await settle()
    expect(empty.announced[0]).toMatch(/^Nothing is pinned to Alt\+1\./)
  })

  it('moves in queue order and refuses while sorted', () =>
  {
    const a = job()
    const { ctx, spies, announced } = harness([a])
    expect(runTableCommand({ kind: 'move', where: 'top' }, ctx)).toBe(true)
    expect(spies.move).toHaveBeenCalledWith([a.id], 'top')
    expect(announced).toEqual([])
    const sorted = harness([a], { sorted: true })
    expect(runTableCommand({ kind: 'move', where: 'up' }, sorted.ctx)).toBe(true)
    expect(sorted.spies.move).not.toHaveBeenCalled()
    expect(sorted.announced).toEqual([REORDER_SORTED])
    expect(runTableCommand({ kind: 'move', where: 'up' }, harness([], { focusedId: null }).ctx)).toBe(false)
    expect(runTableCommand({ kind: 'move', where: 'up' }, harness([a], { list: 'historyBatch', mode: 'history' }).ctx)).toBe(false)
  })

  it('duplicates, pastes, and copies', async () =>
  {
    const a = job()
    const { ctx, spies, announced } = harness([a])
    expect(runTableCommand({ kind: 'duplicate' }, ctx)).toBe(true)
    expect(spies.duplicate).toHaveBeenCalledWith([a.id])
    expect(runTableCommand({ kind: 'paste' }, ctx)).toBe(true)
    expect(spies.pasteFiles).toHaveBeenCalled()
    expect(runTableCommand({ kind: 'copy' }, ctx)).toBe(true)
    await settle()
    expect(ctx.writeText).toHaveBeenCalledWith(rowsAsText([a], 'win32'))
    expect(announced).toEqual(['Copied 1 row.'])

    const history = harness([a], { list: 'historyBatch', mode: 'history' })
    expect(runTableCommand({ kind: 'duplicate' }, history.ctx)).toBe(false)
    expect(runTableCommand({ kind: 'paste' }, history.ctx)).toBe(false)
    expect(runTableCommand({ kind: 'copy' }, harness([], { focusedId: null }).ctx)).toBe(false)
  })

  it('announces a copy the clipboard refused', async () =>
  {
    const failing = harness([job()], { writeText: () => Promise.reject(new Error('denied')) })
    runTableCommand({ kind: 'copy' }, failing.ctx)
    await settle()
    expect(failing.announced).toEqual(['Could not copy the rows.'])
  })

  it('forwards the shortcuts popover and F8 to the page', () =>
  {
    const onShortcuts = vi.fn()
    const onAttention = vi.fn()
    const { ctx } = harness([job()], { onShortcuts, onAttention })
    expect(runTableCommand({ kind: 'shortcuts' }, ctx)).toBe(true)
    expect(runTableCommand({ kind: 'attention', direction: 'previous' }, ctx)).toBe(true)
    expect(onShortcuts).toHaveBeenCalled()
    expect(onAttention).toHaveBeenCalledWith('previous')
    const bare = harness([job()])
    expect(runTableCommand({ kind: 'shortcuts' }, bare.ctx)).toBe(false)
    expect(runTableCommand({ kind: 'attention', direction: 'next' }, bare.ctx)).toBe(false)
  })
})
