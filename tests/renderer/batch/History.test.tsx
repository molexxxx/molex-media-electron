import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import type { CommandResult, JobsApi, RunSearchMatch } from '../../../src/shared/jobs/contract'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { BatchSummary, HistoryRecord, ResultStamp, RunIndexEntry } from '../../../src/shared/jobs/types'
import { createBatchViewStore, type BatchViewState } from '../../../src/renderer/src/stores/batchView'
import type { BatchToast } from '../../../src/renderer/src/stores/batchActions'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import
{
  appVersionLine,
  conflictText,
  destinationText,
  ffmpegLine,
  ffmpegSourceLabel,
  HistoryInspector,
  inspectedRunId,
  originalsText,
  previousText,
  recipeOutcomeText
} from '../../../src/renderer/src/components/batch/history/HistoryInspector'
import
{
  backToHistory,
  createHistoryListStore,
  deleteFromHistory,
  historyBatchColumns,
  historyJobView,
  HistoryTable,
  historyResultColumns,
  isEditKey,
  latestAttempts,
  loadHistoryRuns,
  matchRowId,
  matchStampValues,
  matchStatus,
  newestFirst,
  nextRowAfter,
  READ_ONLY_ANNOUNCEMENT,
  runIdOfMatchRow,
  type HistoryListState,
  batchName,
  batchNumber,
  deleteQuestion,
  formatBytes,
  formatElapsed,
  formatWhen,
  openedSummary,
  searchSummary,
  usageSentence
} from '../../../src/renderer/src/components/batch/history/HistoryTable'

const OCT_14_2210 = new Date(2026, 9, 14, 22, 10).getTime()

afterEach(() =>
{
  cleanup()
})

describe('History wording', () =>
{
  it('names batches by their run number', () =>
  {
    expect(batchName('R-0029')).toBe('Batch 29')
    expect(batchName('draft')).toBe('draft')
    expect(batchNumber('R-0131')).toBe(131)
    expect(batchNumber('draft')).toBeNull()
  })

  it('formats dates, durations, and sizes', () =>
  {
    expect(formatWhen(OCT_14_2210)).toBe('Oct 14, 22:10')
    expect(formatWhen(null)).toBe('')
    expect(formatWhen(Number.NaN)).toBe('')
    expect(formatElapsed(125_000)).toBe('2:05')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(formatElapsed(-1)).toBe('')
    expect(formatElapsed(undefined)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(980 * 1024)).toBe('980 KB')
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB')
    expect(formatBytes(null)).toBe('')
  })

  it('summarizes a search across batches', () =>
  {
    expect(searchSummary(12, 5, 'interview')).toBe('12 jobs in 5 batches match \u201cinterview\u201d.')
    expect(searchSummary(1, 1, ' interview ')).toBe('1 job in 1 batch matches \u201cinterview\u201d.')
    expect(searchSummary(0, 0, 'nothing')).toBe('No jobs match \u201cnothing\u201d.')
    expect(searchSummary(200, 31, 'mix', true)).toBe('At least 200 jobs in 31 batches match \u201cmix\u201d.')
  })

  it('words the opened batch, the delete question, and the usage', () =>
  {
    expect(openedSummary('R-0029', OCT_14_2210)).toBe('Batch 29 \u00b7 Oct 14, 22:10 \u00b7 read-only.')
    expect(openedSummary('R-0029', null)).toBe('Batch 29 \u00b7 read-only.')
    expect(deleteQuestion('R-0029')).toBe('Delete Batch 29 from history? Its outputs stay on disk; its report can no longer be exported.')
    expect(usageSentence({ runs: 31, historyBytes: 12.4 * 1024 * 1024, logBytes: 40.2 * 1024 * 1024 }))
      .toBe('31 batches, 12.4 MB of history, 40.2 MB of logs. History keeps the newest 200 batches.')
  })
})

const MB = 1024 * 1024
const OCT_13_0900 = new Date(2026, 9, 13, 9, 0).getTime()
const OCT_12_0900 = new Date(2026, 9, 12, 9, 0).getTime()
const R27 = 'R-0027' as RunId
const R28 = 'R-0028' as RunId
const R29 = 'R-0029' as RunId
const RECIPE = { kind: 'normalize', presetId: 'streaming' } as unknown as HistoryRecord['recipe']

let reportWidth: (width: number) => void = () => undefined

beforeEach(() =>
{
  reportWidth = observeWidths()
})

afterEach(() =>
{
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function observeWidths(): (width: number) => void
{
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal('ResizeObserver', class
  {
    constructor(callback: ResizeObserverCallback)
    {
      callbacks.push(callback)
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  })
  return (width: number) =>
  {
    const entry = { borderBoxSize: [{ inlineSize: width, blockSize: 400 }], contentRect: { width, height: 400 } } as unknown as ResizeObserverEntry
    act(() => callbacks.forEach((callback) => callback([entry], {} as ResizeObserver)))
  }
}

function counts(over: Partial<RunIndexEntry['counts']> = {}): RunIndexEntry['counts']
{
  return { total: 12, done: 10, verified: 9, reachable: 0, outsideTolerance: 1, failed: 1, canceled: 1, skipped: 0, held: 0, interrupted: 0, returned: 2, ...over }
}

function entry(runId: RunId, startedAt: number, over: Partial<RunIndexEntry> = {}): RunIndexEntry
{
  return { runId, startedAt, endedAt: startedAt + 724_000, endedBy: 'completed', counts: counts(), bytes: { input: 800 * MB, output: 120 * MB }, ...over }
}

function stamp(over: Partial<ResultStamp> = {}): ResultStamp
{
  return {
    verdict: 'verified',
    outputName: 'a.wav',
    container: 'wav',
    inputBytes: 80 * MB,
    outputBytes: 24 * MB,
    durationSec: 600,
    decode: 'full',
    audioStreams: 1,
    verdictStream: 0,
    loudness: { lufs: -16, unit: 'LUFS', reference: 'target', referenceLufs: -16, deviation: 0, deviationUnit: 'LU', check: 1, checkClass: 'lossless', status: 'within' },
    truePeak: { dbtp: -1.6, preEncodeDbtp: null, limitDbtp: -1, status: 'within' },
    size: null,
    frames: null,
    cues: null,
    placement: 'new',
    warnings: 0,
    ...over
  }
}

function record(jobId: string, over: Partial<HistoryRecord> = {}): HistoryRecord
{
  return {
    type: 'record',
    schema: 1,
    runId: R29,
    jobId: jobId as JobId,
    attempt: 1,
    op: 'normalize' as HistoryRecord['op'],
    source: { path: `D:\\Audio\\${jobId}-interview.wav`, size: 80 * MB, mtimeMs: 1 },
    recipe: RECIPE,
    recipeLabel: 'Normalize \u00b7 Streaming',
    state: 'done',
    startedAt: OCT_14_2210,
    endedAt: OCT_14_2210 + 60_000,
    output: { path: `D:\\Out\\${jobId}.wav`, bytes: 24 * MB, container: 'wav' },
    placement: null,
    plan: null,
    measurement: null,
    verification: null,
    result: { stamp: stamp(), outputPath: `D:\\Out\\${jobId}.wav`, durationSec: 600, elapsedMs: 60_000 } as unknown as HistoryRecord['result'],
    error: null,
    warnings: [],
    attempts: [],
    rerunOf: null,
    logFile: 'D:\\logs\\job.log',
    ...over
  }
}

function match(index: number): RunSearchMatch
{
  const runId = `R-00${25 + (index % 5)}` as RunId
  const jobId = `MM-01${String(index).padStart(2, '0')}` as JobId
  return { runId, jobId, attempt: 1, sourceName: `interview-${index}.wav`, sourcePath: `D:\\Audio\\interview-${index}.wav`, state: 'done', verdict: 'verified', endedAt: OCT_14_2210, stamp: stamp() }
}

function summary(runId: RunId, over: Partial<BatchSummary> = {}): BatchSummary
{
  return {
    runId,
    startedAt: OCT_14_2210,
    endedAt: OCT_14_2210 + 724_000,
    elapsedMs: 724_000,
    endedBy: 'completed',
    interruptions: 0,
    counts: { ...counts(), skipped: 0 },
    bytes: { input: 800 * MB, output: 120 * MB },
    mediaSec: 7200,
    originals: { trashed: 0, kept: 0, volumes: [] },
    previous: { trashed: 0, kept: 0 },
    recipes: [],
    albums: [],
    failures: [],
    policy: { rev: 1, destination: { mode: 'folder', folder: 'D:\\Out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto', frozenAt: OCT_14_2210, date: '2026-10-14' },
    ffmpeg: { version: '9.0.2', source: 'bundled' },
    appVersion: '4.8.0',
    ...over
  }
}

function ok<T>(value: T): Promise<CommandResult<T>>
{
  return Promise.resolve({ ok: true, value, seq: 0 })
}

function refused(message: string): Promise<CommandResult<never>>
{
  return Promise.resolve({ ok: false, error: { code: 'internal', message, issues: [], details: null } } as unknown as CommandResult<never>)
}

const USAGE = { runs: 3, historyBytes: 12.4 * MB, logBytes: 40.2 * MB }

function listOf(...runs: RunIndexEntry[]): JobsApi['listRuns']
{
  return vi.fn(() => ok({ runs, more: false, usage: USAGE })) as unknown as JobsApi['listRuns']
}

interface Mounted
{
  view: StoreApi<BatchViewState>
  list: StoreApi<HistoryListState>
  announce: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
}

function mount(api: Partial<JobsApi>, children?: (mounted: Omit<Mounted, 'announce' | 'notify'>) => React.ReactNode): Mounted
{
  const view = createBatchViewStore({ storage: null })
  view.getState().setMode('history')
  const list = createHistoryListStore()
  const announce = vi.fn()
  const notify = vi.fn()
  render(
    <TestBatchActionsProvider api={api} view={view} announce={announce} notify={notify}>
      {children ? children({ view, list }) : <HistoryTable view={view} list={list} />}
    </TestBatchActionsProvider>
  )
  return { view, list, announce, notify }
}

function rows(): HTMLElement[]
{
  return [...document.querySelectorAll<HTMLElement>('[role="row"][data-row-id]')]
}

function rowIds(): string[]
{
  return rows().map((row) => row.dataset.rowId ?? '')
}

function row(id: string): HTMLElement
{
  const found = rows().find((element) => element.dataset.rowId === id)
  if (found === undefined)
  {
    throw new Error(`No row ${id}`)
  }
  return found
}

function headers(): string[]
{
  return screen.getAllByRole('columnheader').map((cell) => cell.querySelector('.sr-only')?.textContent ?? cell.textContent ?? '')
}

/** jsdom styles a popover as display: none, which empties accessible names, so menus and items are found by text. */
function menuItem(menuLabel: string, label: string): HTMLElement
{
  const name = menuLabel.replace(/^Actions for /, '')
  const owner = rows().find((element) => within(element).queryByRole('button', { name: `More actions for ${name}` }) !== null)
  const trigger = owner === undefined ? null : within(owner).getByRole('button', { name: `More actions for ${name}` })
  if (trigger !== null && trigger.getAttribute('aria-expanded') !== 'true')
  {
    fireEvent.click(trigger)
  }
  const menus = screen.getAllByRole('menu', { hidden: true }).filter((menu) => menu.getAttribute('aria-label') === menuLabel)
  for (const menu of menus)
  {
    const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => (element.textContent ?? '').startsWith(label))
    if (item !== undefined)
    {
      return item
    }
  }
  throw new Error(`No item ${label} in ${menuLabel}`)
}

function focusedRowId(): string | null
{
  return (document.activeElement as HTMLElement | null)?.dataset.rowId ?? null
}

describe('History helpers', () =>
{
  it('orders batches newest first and finds the row after a removed one', () =>
  {
    expect(newestFirst([entry(R27, OCT_12_0900), entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)]).map((run) => run.runId)).toEqual([R29, R28, R27])
    expect(newestFirst([entry(R28, OCT_13_0900), entry(R29, OCT_13_0900)]).map((run) => run.runId)).toEqual([R29, R28])
    expect(nextRowAfter(['a', 'b', 'c'], 'a')).toBe('b')
    expect(nextRowAfter(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextRowAfter(['a'], 'a')).toBeNull()
    expect(nextRowAfter(['a'], 'z')).toBeNull()
  })

  it('names search rows by batch, job, and attempt', () =>
  {
    const id = matchRowId({ runId: R29, jobId: 'MM-0131' as JobId, attempt: 2 })
    expect(id).toBe('R-0029/MM-0131/2')
    expect(runIdOfMatchRow(id)).toBe('R-0029')
    expect(runIdOfMatchRow('R-0029')).toBeNull()
  })

  it('words a search result without a stamp and builds the stamp it has', () =>
  {
    expect(matchStatus({ state: 'failed', verdict: null })).toEqual({ status: 'failed', label: 'Failed' })
    expect(matchStatus({ state: 'canceled', verdict: null })).toEqual({ status: 'cancelled', label: 'Canceled' })
    expect(matchStatus({ state: 'skipped', verdict: null })).toEqual({ status: 'skipped', label: 'Skipped' })
    expect(matchStatus({ state: 'interrupted', verdict: null }).label).toBe('Interrupted')
    expect(matchStatus({ state: 'held', verdict: 'outside-tolerance' }).label).toBe('Returned')
    expect(matchStatus({ state: 'done', verdict: 'outside-tolerance' }).status).toBe('returned')
    expect(matchStatus({ state: 'done', verdict: 'verified' }).status).toBe('verified')
    expect(matchStampValues({ stamp: null })).toBeNull()
    expect(matchStampValues({ stamp: stamp({ verdict: 'passthrough' }) })?.values[0].text).toBe('Silent, copied')
    const measured = matchStampValues({ stamp: stamp({ verdict: 'outside-tolerance', truePeak: { dbtp: -0.4, preEncodeDbtp: null, limitDbtp: -1, status: 'over' } }) })
    expect(measured?.outcome).toBe('returned')
    expect(measured?.values.map((value) => value.failing)).toEqual([false, true])
    const sized = matchStampValues({ stamp: stamp({ loudness: null, truePeak: null, size: { targetBytes: MB, status: 'over' } }) })
    expect(sized?.values).toEqual([{ text: '24.0 MB', failing: true }])
  })

  it('turns a kept record into a settled job row with its latest attempt', () =>
  {
    const failed = record('MM-0131', { state: 'failed', result: null, error: { code: 'ffmpeg-failed', short: 'Encoder failed', message: 'x', stage: 'encode', at: 5 } as unknown as HistoryRecord['error'] })
    const job = historyJobView(failed)
    expect(job.id).toBe('MM-0131')
    expect(job.seq).toBe(131)
    expect(job.source).toMatchObject({ name: 'MM-0131-interview.wav', ext: 'wav', dir: 'D:\\Audio' })
    expect(job.stamp).toBeNull()
    expect(job.error).toEqual({ code: 'ffmpeg-failed', short: 'Encoder failed', message: 'x', stage: 'encode', at: 5 })
    expect(job.acknowledged).toBe(true)
    expect(historyJobView(record('MM-0132', { source: { path: 'noext', size: 1, mtimeMs: 0 }, startedAt: null })).source.ext).toBe('')
    expect(historyJobView(record('draft')).seq).toBe(0)
    const latest = latestAttempts([record('MM-0131'), record('MM-0132'), record('MM-0131', { attempt: 2 })])
    expect(latest.map((one) => `${one.jobId}:${one.attempt}`)).toEqual(['MM-0131:2', 'MM-0132:1'])
  })

  it('recognizes the edit keys History refuses', () =>
  {
    const key = (over: Partial<KeyboardEvent>): Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> =>
      ({ key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over })
    expect(isEditKey(key({ key: 'v', ctrlKey: true }))).toBe(true)
    expect(isEditKey(key({ key: 'D', metaKey: true }))).toBe(true)
    expect(isEditKey(key({ key: '2', code: 'Digit2', altKey: true }))).toBe(true)
    expect(isEditKey(key({ key: 'c', ctrlKey: true }))).toBe(false)
    expect(isEditKey(key({ key: 'v', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isEditKey(key({ key: 'Delete' }))).toBe(false)
  })

  it('pages older batches and keeps the shown ones when main refuses', async () =>
  {
    const list = createHistoryListStore()
    const send = vi.fn()
      .mockResolvedValueOnce({ status: 'done', value: { runs: [entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)], more: true, usage: USAGE }, seq: 0 })
      .mockResolvedValueOnce({ status: 'done', value: { runs: [entry(R28, OCT_13_0900), entry(R27, OCT_12_0900)], more: false, usage: USAGE }, seq: 0 })
      .mockResolvedValueOnce({ status: 'refused', code: 'internal', message: 'History is unavailable.' })
    const actions = { send } as unknown as Parameters<typeof loadHistoryRuns>[0]
    expect(await loadHistoryRuns(actions, list)).toBe(true)
    expect(list.getState().more).toBe(true)
    expect(await loadHistoryRuns(actions, list, { older: true, limit: 2 })).toBe(true)
    expect(send).toHaveBeenLastCalledWith('listRuns', { before: R28, limit: 2 })
    expect(list.getState().runs.map((run) => run.runId)).toEqual([R29, R28, R27])
    expect(await loadHistoryRuns(actions, list)).toBe(false)
    expect(list.getState()).toMatchObject({ status: 'failed', message: 'History is unavailable.' })
    expect(list.getState().runs).toHaveLength(3)
  })

  it('brings a batch back when main refuses to delete it', async () =>
  {
    const list = createHistoryListStore()
    const view = createBatchViewStore({ storage: null })
    list.setState({ runs: [entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)], order: [R29, R28], usage: USAGE })
    const deleteRuns = vi.fn().mockResolvedValue({ status: 'refused', code: 'internal', message: 'No.' })
    expect(await deleteFromHistory(R29, { actions: { deleteRuns }, list, view })).toBe(false)
    expect(list.getState().runs.map((run) => run.runId)).toEqual([R29, R28])
    expect(list.getState().usage).toEqual(USAGE)
    list.setState({ order: [R29] })
    deleteRuns.mockResolvedValue({ status: 'done', value: { deleted: 1 }, seq: 0 })
    expect(await deleteFromHistory(R29, { actions: { deleteRuns }, list, view })).toBe(true)
    expect(view.getState().views.history.selection.selected.size).toBe(0)
  })

  it('goes back to the search results or the batch list', () =>
  {
    const list = createHistoryListStore()
    const view = createBatchViewStore({ storage: null })
    backToHistory(view, list)
    expect(list.getState().focusRequest).toBeNull()
    view.getState().openHistoryBatch(R29)
    backToHistory(view, list)
    expect(view.getState().history.openRunId).toBeNull()
    expect(view.getState().views.history.selection.focus).toBe(R29)
    expect(list.getState().focusRequest).toBe(R29)
    view.getState().setHistoryQuery('interview')
    view.getState().openHistoryBatch(R28, 'MM-0101')
    backToHistory(view, list)
    expect(list.getState().focusRequest).toBe('\u0000first-row')
  })

  it('carries the History column sets and their priorities', () =>
  {
    expect(historyBatchColumns().map((column) => `${column.id}:${column.priority}`)).toEqual(
      ['batch:1', 'started:1', 'duration:3', 'jobs:1', 'verified:2', 'returned:1', 'canceled:3', 'in:3', 'out:3', 'actions:1'])
    expect(historyResultColumns().map((column) => `${column.id}:${column.priority}`)).toEqual(
      ['no:1', 'file:1', 'batch:1', 'result:1', 'finished:2', 'recipe:3', 'actions:1'])
    const sorted = historyBatchColumns().filter((column) => column.sortable).map((column) => column.sortValue?.({ ...entry(R29, OCT_14_2210), id: R29 }))
    expect(sorted).toEqual([29, OCT_14_2210, 724_000, 12, 9, 2, 1, 800 * MB, 120 * MB])
    expect(historyBatchColumns()[2].sortValue?.({ ...entry(R29, OCT_14_2210, { endedAt: null }), id: R29 })).toBeNull()
    const results = historyResultColumns().filter((column) => column.sortable).map((column) => column.sortValue?.({ ...match(0), id: 'x' }))
    expect(results).toEqual(['MM-0100', 'interview-0.wav', 25, 'Verified', OCT_14_2210])
  })
})

describe('History table', () =>
{
  it('lists the kept batches newest first with their History columns and usage', async () =>
  {
    const listRuns = listOf(entry(R28, OCT_13_0900), entry(R29, OCT_14_2210, { endedAt: null }))
    mount({ listRuns })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    expect(listRuns).toHaveBeenCalledWith({ before: null, limit: 50 })
    reportWidth(1200)
    expect(headers()).toEqual(['Batch', 'Started', 'Duration', 'Jobs', 'Verified', 'Returned', 'Canceled', 'In', 'Out', 'Actions'])
    expect(row(R28).textContent).toContain('Batch 28')
    expect(row(R28).textContent).toContain('Oct 13, 09:00')
    expect(row(R28).textContent).toContain('12:04')
    expect(row(R28).textContent).toContain('800 MB')
    expect(screen.getByText('3 batches, 12.4 MB of history, 40.2 MB of logs. History keeps the newest 200 batches.')).toBeTruthy()
    reportWidth(600)
    expect(headers()).toEqual(['Batch', 'Started', 'Jobs', 'Returned', 'Actions'])
  })

  it('says when nothing is kept and offers to try again after a refusal', async () =>
  {
    const listRuns = vi.fn()
      .mockImplementationOnce(() => refused('History is unavailable.'))
      .mockImplementationOnce(() => ok({ runs: [], more: false, usage: { runs: 0, historyBytes: 0, logBytes: 0 } }))
    mount({ listRuns: listRuns as unknown as JobsApi['listRuns'] })
    await waitFor(() => expect(screen.getByText('History is unavailable.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByText('No batches yet. Each batch is kept here when it ends.')).toBeTruthy())
  })

  it('shows older batches on request', async () =>
  {
    const listRuns = vi.fn()
      .mockImplementationOnce(() => ok({ runs: [entry(R29, OCT_14_2210)], more: true, usage: USAGE }))
      .mockImplementationOnce(() => ok({ runs: [entry(R28, OCT_13_0900)], more: false, usage: USAGE }))
    mount({ listRuns: listRuns as unknown as JobsApi['listRuns'] })
    await waitFor(() => expect(rowIds()).toEqual([R29]))
    fireEvent.click(screen.getByRole('button', { name: 'Show older batches' }))
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    expect(listRuns).toHaveBeenLastCalledWith({ before: R29, limit: 50 })
    expect(screen.queryByRole('button', { name: 'Show older batches' })).toBeNull()
  })

  it('switches to the matching jobs when searching and opens a batch with the job focused', async () =>
  {
    const matches = Array.from({ length: 12 }, (_, index) => match(index))
    const searchRuns = vi.fn(() => ok({ matches, runs: 5, more: false }))
    const target = matches[3]
    const getRun = vi.fn(({ runId }: { runId: RunId }) => ok({
      summary: summary(runId),
      records: matches.filter((one) => one.runId === runId).map((one) => record(one.jobId, { runId })),
      total: 3
    }))
    const mounted = mount({ listRuns: listOf(entry(R29, OCT_14_2210)), searchRuns: searchRuns as unknown as JobsApi['searchRuns'], getRun: getRun as unknown as JobsApi['getRun'] })
    await waitFor(() => expect(rowIds()).toEqual([R29]))
    act(() => mounted.view.getState().setHistoryQuery('interview'))
    await waitFor(() => expect(screen.getByText('12 jobs in 5 batches match \u201cinterview\u201d.')).toBeTruthy())
    expect(searchRuns).toHaveBeenCalledWith({ query: 'interview', limit: 200, before: null })
    reportWidth(900)
    expect(headers()).toEqual(['#', 'File', 'Batch', 'Result', 'Finished', 'Actions'])
    expect(rowIds()).toHaveLength(12)
    expect(row(matchRowId(target)).querySelector('.ui-stamp')?.hasAttribute('data-landing')).toBe(false)

    const resultRow = row(matchRowId(target))
    resultRow.focus()
    fireEvent.keyDown(resultRow, { key: 'Enter' })
    expect(mounted.view.getState().history.openRunId).toBe(target.runId)
    await waitFor(() => expect(focusedRowId()).toBe(target.jobId))
    expect(getRun).toHaveBeenCalledWith({ runId: target.runId, offset: 0, limit: 500 })
    expect(screen.getByText(`Batch 28 \u00b7 Oct 14, 22:10 \u00b7 read-only.`)).toBeTruthy()
    expect(mounted.view.getState().views.historyBatch.selection.focus).toBe(target.jobId)
  })

  it('keeps an opened batch read-only with settled stamps, and Backspace returns to the list', async () =>
  {
    const getRun = vi.fn(() => ok({ summary: summary(R29), records: [record('MM-0101'), record('MM-0102', { state: 'failed', result: null, error: { code: 'ffmpeg-failed', short: 'Encoder failed', message: 'x', stage: 'encode', at: 1 } as unknown as HistoryRecord['error'] })], total: 2 }))
    const mounted = mount({ listRuns: listOf(entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)), getRun: getRun as unknown as JobsApi['getRun'] })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    const batchRow = row(R29)
    batchRow.focus()
    fireEvent.keyDown(batchRow, { key: 'Enter' })
    await waitFor(() => expect(rowIds()).toEqual(['MM-0101', 'MM-0102']))
    await waitFor(() => expect(focusedRowId()).toBe('MM-0101'))
    reportWidth(1200)
    expect(headers()).toContain('Result')
    const stamps = [...document.querySelectorAll('.ui-stamp')]
    expect(stamps).toHaveLength(2)
    expect(stamps.every((one) => !one.hasAttribute('data-landing'))).toBe(true)
    expect(row('MM-0102').textContent).toContain('Encoder failed')

    const jobRow = row('MM-0101')
    fireEvent.keyDown(jobRow, { key: 'Delete' })
    await waitFor(() => expect(mounted.announce).toHaveBeenCalledWith(READ_ONLY_ANNOUNCEMENT))
    fireEvent.keyDown(jobRow, { key: ' ' })
    expect(mounted.view.getState().views.historyBatch.selection.selected.has('MM-0101')).toBe(true)
    expect(fireEvent.keyDown(jobRow, { key: 'v', ctrlKey: true })).toBe(false)

    fireEvent.keyDown(jobRow, { key: 'Backspace' })
    expect(mounted.view.getState().history.openRunId).toBeNull()
    await waitFor(() => expect(focusedRowId()).toBe(R29))
  })

  it('reveals a job record and reruns it from the row menu, and pages long batches', async () =>
  {
    const revealRecord = vi.fn(() => ok(null))
    const rerun = vi.fn(() => ok({ added: ['MM-0200' as JobId], missing: [], holdsOutput: [] }))
    const getRun = vi.fn()
      .mockImplementationOnce(() => ok({ summary: null, records: [record('MM-0101', { logFile: null })], total: 2 }))
      .mockImplementationOnce(() => ok({ summary: null, records: [record('MM-0102', { output: null })], total: 2 }))
    const mounted = mount({ listRuns: listOf(entry(R29, OCT_14_2210)), getRun: getRun as unknown as JobsApi['getRun'], revealRecord: revealRecord as unknown as JobsApi['revealRecord'], rerun: rerun as unknown as JobsApi['rerun'] })
    act(() => mounted.view.getState().openHistoryBatch(R29))
    await waitFor(() => expect(rowIds()).toEqual(['MM-0101']))
    expect(screen.getByText('Batch 29 \u00b7 Oct 14, 22:10 \u00b7 read-only.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show more jobs' }))
    await waitFor(() => expect(rowIds()).toEqual(['MM-0101', 'MM-0102']))
    expect(getRun).toHaveBeenLastCalledWith({ runId: R29, offset: 1, limit: 500 })

    reportWidth(1200)
    expect(menuItem('Actions for MM-0101', 'Show log').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(menuItem('Actions for MM-0101', 'Show in folder'))
    expect(revealRecord).toHaveBeenCalledWith({ runId: R29, jobId: 'MM-0101', attempt: 1, target: 'output' })
    expect(menuItem('Actions for MM-0102', 'Show in folder').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(menuItem('Actions for MM-0102', 'Show log'))
    expect(revealRecord).toHaveBeenLastCalledWith({ runId: R29, jobId: 'MM-0102', attempt: 1, target: 'log' })
    fireEvent.click(menuItem('Actions for MM-0102', 'Rerun'))
    await waitFor(() => expect(rerun).toHaveBeenCalledWith({ runId: R29, jobIds: ['MM-0102'], force: false }))
  })

  it('asks inline before deleting a batch from history, with Keep focused, then focuses the next batch', async () =>
  {
    const deleteRuns = vi.fn(() => ok({ deleted: 1 }))
    const mounted = mount({ listRuns: listOf(entry(R29, OCT_14_2210), entry(R28, OCT_13_0900), entry(R27, OCT_12_0900)), deleteRuns: deleteRuns as unknown as JobsApi['deleteRuns'] })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28, R27]))
    const first = row(R29)
    first.focus()
    fireEvent.keyDown(first, { key: 'Delete' })
    expect(screen.getByText('Delete Batch 29 from history? Its outputs stay on disk; its report can no longer be exported.')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Keep')
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(focusedRowId()).toBe(R29)
    expect(deleteRuns).not.toHaveBeenCalled()

    fireEvent.keyDown(row(R29), { key: 'Delete' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(rowIds()).toEqual([R28, R27])
    expect(focusedRowId()).toBe(R28)
    await waitFor(() => expect(deleteRuns).toHaveBeenCalledWith({ runIds: [R29] }))
    await waitFor(() => expect(mounted.announce).toHaveBeenCalledWith('Deleted Batch 29 from history.'))
    expect(mounted.view.getState().views.history.selection.focus).toBe(R28)
  })

  it('offers the batch actions in the row menu and toggles selection with Space', async () =>
  {
    const exportReport = vi.fn(() => ok({ canceled: true as const }))
    const rerun = vi.fn(() => ok({ added: [], missing: [], holdsOutput: [] }))
    const getRun = vi.fn(() => ok({ summary: summary(R28), records: [], total: 0 }))
    const mounted = mount({
      listRuns: listOf(entry(R29, OCT_14_2210, { counts: counts({ returned: 0 }) }), entry(R28, OCT_13_0900)),
      exportReport: exportReport as unknown as JobsApi['exportReport'],
      rerun: rerun as unknown as JobsApi['rerun'],
      getRun: getRun as unknown as JobsApi['getRun']
    })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    fireEvent.keyDown(row(R29), { key: ' ' })
    expect(mounted.view.getState().views.history.selection.selected.has(R29)).toBe(true)
    expect(fireEvent.keyDown(row(R29), { key: 'd', ctrlKey: true })).toBe(false)
    reportWidth(1200)
    expect(menuItem('Actions for Batch 29', 'Rerun returned').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(menuItem('Actions for Batch 29', 'Export report'))
    expect(exportReport).toHaveBeenCalledWith({ scope: { runId: R29 }, format: 'csv' })
    fireEvent.click(menuItem('Actions for Batch 28', 'Rerun returned'))
    await waitFor(() => expect(rerun).toHaveBeenCalledWith({ runId: R28, jobIds: 'returned', force: false }))
    fireEvent.click(menuItem('Actions for Batch 28', 'Rerun all'))
    await waitFor(() => expect(rerun).toHaveBeenLastCalledWith({ runId: R28, jobIds: 'all', force: false }))
    fireEvent.click(menuItem('Actions for Batch 28', 'Delete from history'))
    expect(await screen.findByText(/Delete Batch 28 from history\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.click(menuItem('Actions for Batch 28', 'Open jobs'))
    expect(mounted.view.getState().history.openRunId).toBe(R28)
  })

  it('reports a refused search in the summary', async () =>
  {
    const searchRuns = vi.fn(() => refused('Search is unavailable.'))
    const mounted = mount({ listRuns: listOf(), searchRuns: searchRuns as unknown as JobsApi['searchRuns'] })
    act(() => mounted.view.getState().setHistoryQuery('mix'))
    await waitFor(() => expect(screen.getByText('Search is unavailable.')).toBeTruthy())
  })
})

function outcome(over: Record<string, unknown> = {}): BatchSummary['recipes'][number]
{
  return {
    op: 'normalize',
    label: 'Normalize \u00b7 Streaming',
    presetId: 'streaming',
    userPresetId: null,
    jobs: 12,
    verified: 10,
    reachable: 0,
    outsideTolerance: 2,
    returned: 2,
    loudness: { unit: 'LUFS', targetLufs: -14, deviationUnit: 'LU', checks: [], minLufs: -14.6, maxLufs: -13.8 },
    ...over
  } as unknown as BatchSummary['recipes'][number]
}

function mountWithInspector(api: Partial<JobsApi>, onShowLog?: (runId: string) => void): Mounted
{
  return mount(api, ({ view, list }) => (
    <>
      <HistoryTable view={view} list={list} />
      <HistoryInspector view={view} list={list} onShowLog={onShowLog} />
    </>
  ))
}

function inspector(): HTMLElement
{
  const found = screen.getAllByRole('region').find((region) => (region.getAttribute('aria-label') ?? '').endsWith('details'))
  if (found === undefined)
  {
    throw new Error('No inspector')
  }
  return found
}

describe('History inspector wording', () =>
{
  it('names the FFmpeg build and the app version a batch ran on', () =>
  {
    expect(ffmpegSourceLabel('bundled')).toBe('pinned')
    expect(ffmpegSourceLabel('path')).toBe('PATH')
    expect(ffmpegSourceLabel('custom')).toBe('custom')
    expect(ffmpegLine({ version: '9.0.2', source: 'bundled' })).toBe('FFmpeg 9.0.2, pinned')
    expect(ffmpegLine({ version: ' ', source: 'path' })).toBe('FFmpeg unknown version, PATH')
    expect(appVersionLine('4.8.0')).toBe('molexMedia 4.8.0')
    expect(appVersionLine('')).toBe('molexMedia, unknown version')
  })

  it('states the output a batch used and what happened to originals and earlier files', () =>
  {
    expect(destinationText({ mode: 'folder', folder: 'D:\\Out' })).toBe('D:\\Out')
    expect(destinationText({ mode: 'next-to-source' })).toBe('Next to each source')
    expect(destinationText({ mode: 'replace-originals' })).toBe('Replaced originals')
    expect(conflictText({ conflict: 'skip', displaced: 'trash' }, 'win32')).toBe('Skipped the job')
    expect(conflictText({ conflict: 'rename', displaced: 'trash' }, 'win32')).toBe('Renamed the output')
    expect(conflictText({ conflict: 'overwrite', displaced: 'trash' }, 'win32')).toBe('Replaced the file; the old one went to the Recycle Bin')
    expect(conflictText({ conflict: 'overwrite', displaced: 'keep' }, 'darwin')).toBe('Replaced the file; the old one stayed as name (previous).ext')
    const replace = summary(R29, { policy: { ...summary(R29).policy, destination: { mode: 'replace-originals' } } })
    expect(originalsText(summary(R29), 'win32')).toBe('Not touched')
    expect(originalsText(replace, 'win32')).toBe('None were replaced')
    expect(originalsText({ ...replace, originals: { trashed: 3, kept: 0, volumes: [{ volume: 'D:', trashed: 3 }] } }, 'win32')).toBe('3 originals went to the Recycle Bin on D:')
    expect(originalsText({ ...replace, originals: { trashed: 2, kept: 1, volumes: [{ volume: 'D:', trashed: 1 }, { volume: 'E:', trashed: 1 }] } }, 'win32'))
      .toBe('2 originals went to the Recycle Bin; 1 original stayed as name (original).ext')
    expect(originalsText({ ...replace, originals: { trashed: 1, kept: 2, volumes: [] } }, 'darwin')).toBe('1 original went to the Trash; 2 originals stayed as name (original).ext')
    expect(previousText(summary(R29), 'win32')).toBeNull()
    expect(previousText({ previous: { trashed: 1, kept: 2 } }, 'win32')).toBe('1 earlier file went to the Recycle Bin; 2 earlier files stayed as name (previous).ext')
    expect(previousText({ previous: { trashed: 2, kept: 1 } }, 'linux')).toBe('2 earlier files went to the Trash; 1 earlier file stayed as name (previous).ext')
  })

  it('words each recipe outcome', () =>
  {
    expect(recipeOutcomeText(outcome())).toBe('12 jobs \u00b7 10 verified \u00b7 2 returned \u00b7 \u221214.6 to \u221213.8 LUFS')
    expect(recipeOutcomeText(outcome({ jobs: 1, verified: 0, reachable: 1, returned: 0, loudness: { unit: 'LKFS', targetLufs: -16, deviationUnit: 'dB', checks: [], minLufs: -16, maxLufs: -16 } })))
      .toBe('1 job \u00b7 0 verified \u00b7 1 at the reachable level \u00b7 0 returned \u00b7 \u221216.0 LKFS')
    expect(recipeOutcomeText(outcome({ loudness: null }))).toBe('12 jobs \u00b7 10 verified \u00b7 2 returned')
  })

  it('follows the opened batch, the focused batch, or the focused result', () =>
  {
    const view = createBatchViewStore({ storage: null })
    expect(inspectedRunId(view.getState())).toBeNull()
    view.getState().setMode('history')
    expect(inspectedRunId(view.getState())).toBeNull()
    view.getState().select('history', { type: 'click', id: R28 })
    expect(inspectedRunId(view.getState())).toBe(R28)
    view.getState().setHistoryQuery('interview')
    expect(inspectedRunId(view.getState())).toBeNull()
    view.getState().select('historyResults', { type: 'click', id: 'R-0027/MM-0101/1' })
    expect(inspectedRunId(view.getState())).toBe(R27)
    view.getState().openHistoryBatch(R29)
    expect(inspectedRunId(view.getState())).toBe(R29)
  })
})

describe('History inspector', () =>
{
  it('asks for a batch until one is focused, then shows what it used and how it ended', async () =>
  {
    const getRun = vi.fn(({ runId }: { runId: RunId }) => ok({ summary: summary(runId, { recipes: [outcome()] }), records: [], total: 12 }))
    const mounted = mountWithInspector({ listRuns: listOf(entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)), getRun: getRun as unknown as JobsApi['getRun'] })
    expect(screen.getByText('Select a batch to see what it used and how it ended.')).toBeTruthy()
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    const panel = inspector()
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('Batch 29')
    expect(within(panel).getByText('Reading the batch summary\u2026')).toBeTruthy()
    await waitFor(() => expect(within(panel).getByText('FFmpeg')).toBeTruthy())
    expect(getRun).toHaveBeenCalledWith({ runId: R29, offset: 0, limit: 1 })
    const text = panel.textContent ?? ''
    expect(text).toContain('Oct 14, 22:10 \u00b7 12:04')
    expect(text).toContain('800 MB')
    for (const heading of ['Output used', 'Ran on', 'Operations'])
    {
      expect(within(panel).getByRole('heading', { name: heading })).toBeTruthy()
    }
    expect(text).toContain('D:\\Out')
    expect(text).toContain('{name}')
    expect(text).toContain('Renamed the output')
    expect(text).toContain('Not touched')
    expect(text).toContain('9.0.2, pinned')
    expect(text).toContain('molexMedia 4.8.0')
    expect(text).toContain('12 jobs \u00b7 10 verified \u00b7 2 returned')
  })

  it('says when a batch has no summary or main refuses to read it', async () =>
  {
    const getRun = vi.fn()
      .mockImplementationOnce(() => ok({ summary: null, records: [], total: 0 }))
      .mockImplementationOnce(() => refused('The history file is unreadable.'))
    const mounted = mountWithInspector({ listRuns: listOf(entry(R29, OCT_14_2210, { endedAt: null, endedBy: null }), entry(R28, OCT_13_0900)), getRun: getRun as unknown as JobsApi['getRun'] })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    await waitFor(() => expect(screen.getByText('This batch did not finish, so it has no summary of what it used.')).toBeTruthy())
    expect(inspector().textContent).toContain('Oct 14, 22:10')
    act(() => mounted.view.getState().select('history', { type: 'click', id: R28 }))
    await waitFor(() => expect(screen.getByText('The history file is unreadable.')).toBeTruthy())
  })

  it('reruns returned jobs and asks before adding a job whose path now holds its own output', async () =>
  {
    const rerun = vi.fn()
      .mockImplementationOnce(() => ok({ added: [], missing: [{ jobId: 'MM-0130', path: 'D:\\gone.wav' }, { jobId: 'MM-0132', path: 'D:\\gone2.wav' }], holdsOutput: [{ jobId: 'MM-0131', path: 'D:\\Audio\\a.wav', originalTrashed: true }] }))
      .mockImplementationOnce(() => ok({ added: ['MM-0200'], missing: [], holdsOutput: [] }))
    const getRun = vi.fn(() => ok({ summary: summary(R29), records: [], total: 0 }))
    const mounted = mountWithInspector({ listRuns: listOf(entry(R29, OCT_14_2210)), getRun: getRun as unknown as JobsApi['getRun'], rerun: rerun as unknown as JobsApi['rerun'] })
    await waitFor(() => expect(rowIds()).toEqual([R29]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Rerun returned' }))
    await waitFor(() => expect(mounted.notify).toHaveBeenCalled())
    expect(rerun).toHaveBeenCalledWith({ runId: R29, jobIds: 'returned', force: false })
    const toast = mounted.notify.mock.calls[0][0] as BatchToast
    expect(toast.body).toContain('2 sources are no longer at their paths; they were not added.')
    expect(toast.body).toContain('MM-0131 replaced its original; rerunning would process its output again.')
    expect(toast.body).toContain('Recycle Bin')
    expect(toast.actions?.map((action) => action.label)).toEqual(['Show', 'Add anyway'])
    toast.actions?.find((action) => action.label === 'Add anyway')?.run()
    await waitFor(() => expect(rerun).toHaveBeenLastCalledWith({ runId: R29, jobIds: ['MM-0131'], force: true }))
  })

  it('reruns all, exports the report, opens the jobs, and shows the log', async () =>
  {
    const rerun = vi.fn(() => ok({ added: ['MM-0200' as JobId], missing: [], holdsOutput: [] }))
    const exportReport = vi.fn(() => ok({ canceled: true as const }))
    const getRun = vi.fn(() => ok({ summary: summary(R29, { counts: { ...counts(), returned: 0 } }), records: [record('MM-0101')], total: 1 }))
    const shown = vi.fn()
    const mounted = mountWithInspector({
      listRuns: listOf(entry(R29, OCT_14_2210, { counts: counts({ returned: 0 }) })),
      getRun: getRun as unknown as JobsApi['getRun'],
      rerun: rerun as unknown as JobsApi['rerun'],
      exportReport: exportReport as unknown as JobsApi['exportReport']
    }, shown)
    await waitFor(() => expect(rowIds()).toEqual([R29]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    const panel = inspector()
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Rerun returned' })).toHaveAttribute('aria-disabled', 'true'))
    expect(within(panel).getByRole('button', { name: 'Rerun returned' })).toHaveAccessibleDescription('No jobs were returned.')
    fireEvent.click(within(panel).getByRole('button', { name: 'Rerun all' }))
    await waitFor(() => expect(rerun).toHaveBeenCalledWith({ runId: R29, jobIds: 'all', force: false }))
    const exportItem = (label: string): HTMLElement =>
    {
      fireEvent.click(within(panel).getByRole('button', { name: 'Export report' }))
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => (element.textContent ?? '').startsWith(label))
      if (item === undefined)
      {
        throw new Error(`No ${label} item`)
      }
      return item
    }
    fireEvent.click(exportItem('JSON'))
    expect(exportReport).toHaveBeenCalledWith({ scope: { runId: R29 }, format: 'json' })
    fireEvent.click(exportItem('CSV'))
    expect(exportReport).toHaveBeenLastCalledWith({ scope: { runId: R29 }, format: 'csv' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Show log' }))
    expect(shown).toHaveBeenCalledWith(R29)
    fireEvent.click(within(panel).getByRole('button', { name: 'Open jobs' }))
    expect(mounted.view.getState().history.openRunId).toBe(R29)
    await waitFor(() => expect(focusedRowId()).toBe('MM-0101'))
  })

  it('opens Logs when no log handler is given', async () =>
  {
    const { useAppStore } = await import('../../../src/renderer/src/stores/appStore')
    const getRun = vi.fn(() => ok({ summary: summary(R29), records: [], total: 0 }))
    const mounted = mountWithInspector({ listRuns: listOf(entry(R29, OCT_14_2210)), getRun: getRun as unknown as JobsApi['getRun'] })
    await waitFor(() => expect(rowIds()).toEqual([R29]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Show log' }))
    expect(useAppStore.getState().currentView).toBe('logs')
  })

  it('deletes from history after its inline confirmation and moves focus to the next batch row', async () =>
  {
    const deleteRuns = vi.fn(() => ok({ deleted: 1 }))
    const getRun = vi.fn(({ runId }: { runId: RunId }) => ok({ summary: summary(runId), records: [], total: 0 }))
    const mounted = mountWithInspector({ listRuns: listOf(entry(R29, OCT_14_2210), entry(R28, OCT_13_0900)), getRun: getRun as unknown as JobsApi['getRun'], deleteRuns: deleteRuns as unknown as JobsApi['deleteRuns'] })
    await waitFor(() => expect(rowIds()).toEqual([R29, R28]))
    act(() => mounted.view.getState().select('history', { type: 'click', id: R29 }))
    const remove = within(inspector()).getByRole('button', { name: 'Delete from history' })
    fireEvent.click(remove)
    expect(within(inspector()).getByText('Delete Batch 29 from history? Its outputs stay on disk; its report can no longer be exported.')).toBeTruthy()
    expect(document.activeElement?.textContent).toBe('Keep')
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Keep' }))
    expect(document.activeElement).toBe(remove)
    fireEvent.click(remove)
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Delete' }))
    expect(rowIds()).toEqual([R28])
    expect(focusedRowId()).toBe(R28)
    await waitFor(() => expect(deleteRuns).toHaveBeenCalledWith({ runIds: [R29] }))
    expect(within(inspector()).getByRole('heading', { level: 2 }).textContent).toBe('Batch 28')
  })
})

void React
