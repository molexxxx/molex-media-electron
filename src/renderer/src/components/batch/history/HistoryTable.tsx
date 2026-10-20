/**
 * History mode: the kept batches newest first, the jobs that match a search across them, and a batch opened
 * read-only in Run columns. The data comes from main's run index and history files through the runs commands;
 * how the lists look (selection, sort, hidden columns, the query, the opened batch) lives in the batch view store.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createStore, useStore, type StoreApi } from 'zustand'
import type { RunSearchMatch } from '../../../../../shared/jobs/contract'
import type { RunId } from '../../../../../shared/jobs/ids'
import type { BatchSummary, HistoryRecord, JobView, RunIndexEntry } from '../../../../../shared/jobs/types'
import { formatCount, formatLoudness, formatTruePeak, revealLabel } from '../../../copy/batch'
import { activeViewKey, BATCH_COLUMNS, columnSetFor, useBatchView, type BatchViewState, type ViewKey } from '../../../stores/batchView'
import type { BatchActions } from '../../../stores/batchActions'
import { Button } from '../../../ui/Button'
import { CatalogNumber } from '../../../ui/CatalogNumber'
import { DataGrid, sortGridRows, type GridCellContext, type GridColumn, type GridSortValue } from '../../../ui/DataGrid'
import { cx } from '../../../ui/cx'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import { usePlatform } from '../../../ui/Kbd'
import { useAnnounce } from '../../../ui/LiveRegion'
import type { MenuEntry } from '../../../ui/Menu'
import { Stamp, type StampValue } from '../../../ui/Stamp'
import { StatusLabel, type StatusKey } from '../../../ui/StatusLabel'
import type { GridSelectionAction, GridSelectionState } from '../../../ui/useGridSelection'
import { useBatchActions } from '../BatchActionsContext'
import { ActionsCell, finishedText, JobCell, MiddleTruncate, ValueText } from '../table/cells'
import { ACTIONS_LABEL, jobColumns, type JobRow } from '../table/columns'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const OPEN_QUOTE = '“'

const CLOSE_QUOTE = '”'

/** What the toolbar's History search field is called; it searches every kept batch. */
export const HISTORY_SEARCH_LABEL = 'Find a file or job number'

/** What Delete and the other edit keys announce in a batch opened from History or in search results. */
export const READ_ONLY_ANNOUNCEMENT = 'History is read-only.'

/** How many batches main keeps; older ones are pruned first. */
export const HISTORY_RETENTION_RUNS = 200

/** "Batch 29" for run R-0029; an id that does not parse reads as itself. */
export function batchName(runId: string): string
{
  const match = /^R-(\d+)$/.exec(runId)
  return match ? `Batch ${Number(match[1])}` : runId
}

/** The batch's sequence number for sorting, or null when the id does not parse. */
export function batchNumber(runId: string): number | null
{
  const match = /^R-(\d+)$/.exec(runId)
  return match ? Number(match[1]) : null
}

/** A local date and time as "Oct 14, 22:10"; empty for a missing time. */
export function formatWhen(ms: number | null | undefined): string
{
  if (ms === null || ms === undefined || !Number.isFinite(ms))
  {
    return ''
  }
  const date = new Date(ms)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hours}:${minutes}`
}

/** Elapsed time as h:mm:ss, or m:ss under an hour; empty for a missing or negative span. */
export function formatElapsed(ms: number | null | undefined): string
{
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
  {
    return ''
  }
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A size in the units Explorer shows (1 KB is 1024 bytes): "980 KB", "12.4 MB"; empty for a missing size. */
export function formatBytes(bytes: number | null | undefined): string
{
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0)
  {
    return ''
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1)
  {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function count(n: number, one: string, many: string): string
{
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

/** The summary of a search: "12 jobs in 5 batches match “interview”."; "At least" when main has more matches. */
export function searchSummary(matches: number, batches: number, query: string, more: boolean = false): string
{
  const quoted = `${OPEN_QUOTE}${query.trim()}${CLOSE_QUOTE}`
  if (matches === 0)
  {
    return `No jobs match ${quoted}.`
  }
  const verb = matches === 1 && !more ? 'matches' : 'match'
  return `${more ? 'At least ' : ''}${count(matches, 'job', 'jobs')} in ${count(batches, 'batch', 'batches')} ${verb} ${quoted}.`
}

/** The summary of a batch opened from History: "Batch 29 · Oct 14, 22:10 · read-only." */
export function openedSummary(runId: string, startedAt: number | null | undefined): string
{
  const when = formatWhen(startedAt)
  return when === '' ? `${batchName(runId)} · read-only.` : `${batchName(runId)} · ${when} · read-only.`
}

/** The inline question before a batch leaves History. */
export function deleteQuestion(runId: string): string
{
  return `Delete ${batchName(runId)} from history? Its outputs stay on disk; its report can no longer be exported.`
}

/** What History holds and what it keeps: "31 batches, 12.4 MB of history, 40.2 MB of logs. History keeps the newest 200 batches." */
export function usageSentence(usage: { runs: number, historyBytes: number, logBytes: number }): string
{
  const kept = `${count(usage.runs, 'batch', 'batches')}, ${formatBytes(usage.historyBytes)} of history, ${formatBytes(usage.logBytes)} of logs.`
  return `${kept} History keeps the newest ${HISTORY_RETENTION_RUNS} batches.`
}

/** How many batches one page of the list asks main for. */
export const HISTORY_PAGE_SIZE = 50

/** How many job records an opened batch asks main for at a time. */
export const OPENED_PAGE_SIZE = 500

/** How long the search waits after the last keystroke before it asks main. */
export const HISTORY_SEARCH_DELAY_MS = 150

/** What History uses on disk. */
export interface HistoryUsage
{
  runs: number
  historyBytes: number
  logBytes: number
}

/** The kept batches newest first, what History uses, and the row that takes focus next. */
export interface HistoryListState
{
  runs: readonly RunIndexEntry[]
  more: boolean
  usage: HistoryUsage | null
  status: 'idle' | 'loading' | 'ready' | 'failed'
  message: string | null
  /** The batch rows in the order shown, so focus can move to the row after a deleted batch. */
  order: readonly string[]
  /** A row id, of whichever History list shows, that takes focus once it is on screen. */
  focusRequest: string | null
}

function emptyList(): HistoryListState
{
  return { runs: [], more: false, usage: null, status: 'idle', message: null, order: [], focusRequest: null }
}

/** A fresh batch list, for a page or a test. */
export function createHistoryListStore(): StoreApi<HistoryListState>
{
  return createStore<HistoryListState>()(() => emptyList())
}

/** The batch list History's table and inspector share. */
export const historyList = createHistoryListStore()

/** Batches newest first: by start time, then by batch number. */
export function newestFirst(runs: readonly RunIndexEntry[]): RunIndexEntry[]
{
  return [...runs].sort((a, b) => (b.startedAt - a.startedAt) || ((batchNumber(b.runId) ?? 0) - (batchNumber(a.runId) ?? 0)))
}

/**
 * Loads the newest page of batches, or with `older` the page after the last batch shown; a refusal keeps the
 * batches already shown and stores main's message.
 */
export async function loadHistoryRuns(
  actions: Pick<BatchActions, 'send'>,
  list: StoreApi<HistoryListState>,
  options: { older?: boolean, limit?: number } = {}
): Promise<boolean>
{
  const shown = list.getState().runs
  const older = options.older === true && shown.length > 0
  list.setState({ status: 'loading', message: null })
  const outcome = await actions.send('listRuns', { before: older ? shown[shown.length - 1].runId : null, limit: options.limit ?? HISTORY_PAGE_SIZE })
  if (outcome.status !== 'done')
  {
    list.setState({ status: 'failed', message: outcome.message })
    return false
  }
  const { runs, more, usage } = outcome.value
  const kept = older ? list.getState().runs : []
  const seen = new Set(kept.map((entry) => entry.runId))
  list.setState({ runs: newestFirst([...kept, ...runs.filter((entry) => !seen.has(entry.runId))]), more, usage, status: 'ready', message: null })
  return true
}

/** The row focus moves to when `id` leaves a list: the next row, else the one before, else none. */
export function nextRowAfter(order: readonly string[], id: string): string | null
{
  const index = order.indexOf(id)
  if (index === -1)
  {
    return null
  }
  return order[index + 1] ?? order[index - 1] ?? null
}

/**
 * Delete from history, after its inline confirmation. The row leaves the list at once and focus moves to the next
 * batch row; when main refuses, the row comes back and the refusal's toast explains why.
 */
export async function deleteFromHistory(
  runId: string,
  deps: { actions: Pick<BatchActions, 'deleteRuns'>, list: StoreApi<HistoryListState>, view: StoreApi<BatchViewState> }
): Promise<boolean>
{
  const { list, view } = deps
  const before = list.getState()
  const next = nextRowAfter(before.order, runId)
  list.setState({
    runs: before.runs.filter((entry) => entry.runId !== runId),
    order: before.order.filter((id) => id !== runId),
    usage: before.usage === null ? null : { ...before.usage, runs: Math.max(0, before.usage.runs - 1) },
    focusRequest: next
  })
  view.getState().select('history', next === null ? { type: 'clear' } : { type: 'click', id: next })
  const outcome = await deps.actions.deleteRuns([runId as RunId])
  if (outcome.status !== 'done')
  {
    const now = list.getState()
    list.setState({ runs: newestFirst([...now.runs, ...before.runs.filter((entry) => entry.runId === runId)]), order: before.order, usage: before.usage })
    return false
  }
  return true
}

/** A row of the batch list. */
export interface BatchRow extends RunIndexEntry
{
  id: string
}

/** A row of the search results: one job attempt of a kept batch. */
export interface MatchRow extends RunSearchMatch
{
  id: string
}

/** A search result's row id, unique across batches and attempts. */
export function matchRowId(match: Pick<RunSearchMatch, 'runId' | 'jobId' | 'attempt'>): string
{
  return `${match.runId}/${match.jobId}/${match.attempt}`
}

/** The batch a search result's row id belongs to; null for an id that is not one. */
export function runIdOfMatchRow(id: string): string | null
{
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : null
}

const BATCH_TRACKS: Readonly<Record<string, string>> =
{
  batch: 'minmax(104px, 1fr)',
  started: '128px',
  duration: '96px',
  jobs: '72px',
  verified: '88px',
  returned: '88px',
  canceled: '88px',
  in: '96px',
  out: '96px'
}

const RESULT_TRACKS: Readonly<Record<string, string>> =
{
  no: '52px',
  batch: '96px',
  file: 'minmax(160px, 2fr)',
  result: 'minmax(150px, 1.3fr)',
  finished: '120px',
  recipe: 'minmax(140px, 1.4fr)'
}

const END_ALIGNED = new Set(['duration', 'jobs', 'verified', 'returned', 'canceled', 'in', 'out'])

const BATCH_SORT: Readonly<Record<string, (row: BatchRow) => GridSortValue>> =
{
  batch: (row) => batchNumber(row.runId) ?? row.runId,
  started: (row) => row.startedAt,
  duration: (row) => (row.endedAt === null ? null : row.endedAt - row.startedAt),
  jobs: (row) => row.counts.total,
  verified: (row) => row.counts.verified,
  returned: (row) => row.counts.returned,
  canceled: (row) => row.counts.canceled,
  in: (row) => row.bytes.input,
  out: (row) => row.bytes.output
}

const RESULT_SORT: Readonly<Record<string, (row: MatchRow) => GridSortValue>> =
{
  no: (row) => row.jobId,
  batch: (row) => batchNumber(row.runId) ?? row.runId,
  file: (row) => row.sourceName,
  result: (row) => matchStatus(row).label,
  finished: (row) => row.endedAt
}

function gridColumns<T extends { id: string }>(
  set: 'historyBatches' | 'historyResults',
  tracks: Readonly<Record<string, string>>,
  sorts: Readonly<Record<string, (row: T) => GridSortValue>>
): Array<GridColumn<T>>
{
  return BATCH_COLUMNS[set].map((entry) =>
  {
    const column: GridColumn<T> =
    {
      id: entry.id,
      label: entry.kind === 'actions' ? ACTIONS_LABEL : entry.label,
      width: tracks[entry.id] ?? 'minmax(96px, 1fr)',
      priority: entry.priority,
      optional: entry.optional,
      kind: entry.kind,
      align: END_ALIGNED.has(entry.id) ? 'end' : 'start'
    }
    const sort = Object.hasOwn(sorts, entry.id) ? sorts[entry.id] : undefined
    if (sort !== undefined)
    {
      column.sortable = true
      column.sortValue = sort
    }
    return column
  })
}

/** History's batch columns (Batch, Started, Duration, Jobs, Verified, Returned, Canceled, In, Out) with their priorities. */
export function historyBatchColumns(): Array<GridColumn<BatchRow>>
{
  return gridColumns<BatchRow>('historyBatches', BATCH_TRACKS, BATCH_SORT)
}

/** The search result columns (No., Batch, File, Result, Finished, Recipe) with their priorities. */
export function historyResultColumns(): Array<GridColumn<MatchRow>>
{
  return gridColumns<MatchRow>('historyResults', RESULT_TRACKS, RESULT_SORT)
}

/** What a search result's Result cell says without a stamp, as a status key and its word. */
export function matchStatus(match: Pick<RunSearchMatch, 'state' | 'verdict'>): { status: StatusKey, label: string }
{
  switch (match.state)
  {
    case 'failed':
      return { status: 'failed', label: 'Failed' }
    case 'canceled':
      return { status: 'cancelled', label: 'Canceled' }
    case 'skipped':
      return { status: 'skipped', label: 'Skipped' }
    case 'interrupted':
      return { status: 'returned', label: 'Interrupted' }
    case 'held':
      return { status: 'returned', label: 'Returned' }
    default:
      return match.verdict === 'outside-tolerance' || match.verdict === 'failed'
        ? { status: 'returned', label: 'Returned' }
        : { status: 'verified', label: 'Verified' }
  }
}

/** A search result's stamp: loudness and true peak when measured, else the output size; null without a stamp. */
export function matchStampValues(match: Pick<RunSearchMatch, 'stamp'>): { outcome: 'verified' | 'returned', values: StampValue[] } | null
{
  const stamp = match.stamp
  if (stamp === null)
  {
    return null
  }
  if (stamp.verdict === 'passthrough')
  {
    return { outcome: 'verified', values: [{ text: 'Silent, copied' }] }
  }
  const values: StampValue[] = []
  if (stamp.loudness !== null)
  {
    values.push({ text: formatLoudness(stamp.loudness.lufs, stamp.loudness.unit), failing: stamp.loudness.status === 'below' || stamp.loudness.status === 'above' })
  }
  if (stamp.truePeak !== null)
  {
    values.push({ text: formatTruePeak(stamp.truePeak.dbtp), failing: stamp.truePeak.status === 'over' })
  }
  if (values.length === 0)
  {
    values.push({ text: formatBytes(stamp.outputBytes), failing: stamp.size?.status === 'over' })
  }
  const returned = stamp.verdict === 'outside-tolerance' || stamp.verdict === 'failed'
  return { outcome: returned ? 'returned' : 'verified', values }
}

function MatchResult({ match }: { match: MatchRow }): ReactElement
{
  const stamp = matchStampValues(match)
  if (stamp !== null && match.state !== 'failed' && match.state !== 'interrupted')
  {
    return <Stamp outcome={stamp.outcome} values={stamp.values} landing={false} />
  }
  const { status, label } = matchStatus(match)
  return <StatusLabel status={status} label={label} />
}

function BatchCell({ row, column, selected, menu }: { row: BatchRow, column: string, selected: boolean, menu: () => MenuEntry[] }): ReactNode
{
  switch (column)
  {
    case 'batch':
      return <span className="truncate text-ink">{batchName(row.runId)}</span>
    case 'started':
      return <ValueText text={formatWhen(row.startedAt)} selected={selected} />
    case 'duration':
      return <ValueText text={row.endedAt === null ? '' : formatElapsed(row.endedAt - row.startedAt)} selected={selected} />
    case 'jobs':
      return <ValueText text={formatCount(row.counts.total)} selected={selected} />
    case 'verified':
      return <ValueText text={formatCount(row.counts.verified)} selected={selected} />
    case 'returned':
      return <ValueText text={formatCount(row.counts.returned)} selected={selected} />
    case 'canceled':
      return <ValueText text={formatCount(row.counts.canceled)} selected={selected} />
    case 'in':
      return <ValueText text={formatBytes(row.bytes.input)} selected={selected} />
    case 'out':
      return <ValueText text={formatBytes(row.bytes.output)} selected={selected} />
    case 'actions':
      return <ActionsCell id={batchName(row.runId)} items={menu()} />
    default:
      return null
  }
}

function MatchCell({ row, column, selected, menu }: { row: MatchRow, column: string, selected: boolean, menu: () => MenuEntry[] }): ReactNode
{
  switch (column)
  {
    case 'no':
      return <CatalogNumber value={row.jobId} selected={selected} />
    case 'batch':
      return <ValueText text={batchName(row.runId)} selected={selected} />
    case 'file':
      return <MiddleTruncate text={row.sourceName} className="text-ink" />
    case 'result':
      return <MatchResult match={row} />
    case 'finished':
      return <ValueText text={finishedText({ endedAt: row.endedAt })} selected={selected} />
    case 'actions':
      return <ActionsCell id={row.jobId} items={menu()} />
    default:
      return null
  }
}

function jobNumber(jobId: string): number
{
  const match = /(\d+)$/.exec(jobId)
  return match ? Number(match[1]) : 0
}

function fileNameOf(path: string): string
{
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * A kept job record as a settled job row, so an opened batch shows the Run columns with the cells the live table
 * uses. It never runs, waits, or needs attention, so its stamp shows in its final state with no landing.
 */
export function historyJobView(record: HistoryRecord, seq: number = jobNumber(record.jobId)): JobView
{
  const path = record.source.path
  const name = fileNameOf(path)
  const dot = name.lastIndexOf('.')
  const error = record.error
  return {
    id: record.jobId,
    seq,
    rev: 0,
    inputsRev: 0,
    source: {
      path,
      name,
      ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
      dir: path.slice(0, Math.max(0, path.length - name.length - 1)),
      size: record.source.size,
      mtimeMs: record.source.mtimeMs,
      origin: 'files',
      subdir: ''
    },
    recipe: record.recipe,
    recipeLabel: record.recipeLabel,
    state: record.state,
    reason: 'engine',
    attempt: record.attempt,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'ok',
    plan: null,
    audioPlan: null,
    stamp: record.result?.stamp ?? null,
    error: error === null ? null : { code: error.code, short: error.short, message: error.message, stage: error.stage, at: error.at },
    warnings: record.warnings,
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: true,
    runId: record.runId,
    rerunOf: record.rerunOf,
    addedAt: record.startedAt ?? record.endedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    albumGroupId: null
  }
}

/** One record per job, its latest attempt, in the order the jobs first appear. */
export function latestAttempts(records: readonly HistoryRecord[]): HistoryRecord[]
{
  const latest = new Map<string, HistoryRecord>()
  for (const record of records)
  {
    const held = latest.get(record.jobId)
    if (held === undefined || record.attempt >= held.attempt)
    {
      latest.set(record.jobId, record)
    }
  }
  return [...latest.values()]
}

function isTextField(target: EventTarget | null): boolean
{
  if (!(target instanceof HTMLElement))
  {
    return false
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
  {
    return true
  }
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(target.type)
}

/** True for the edit keys that change jobs, which History refuses: Ctrl+V, Ctrl+D, and Alt with a top-row digit. */
export function isEditKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean
{
  const mod = event.ctrlKey || event.metaKey
  if (event.altKey && !mod)
  {
    return /^Digit[1-9]$/.test(event.code)
  }
  return mod && !event.shiftKey && ['d', 'v'].includes(event.key.toLowerCase())
}

interface ListGrid
{
  selection: GridSelectionState
  sort: BatchViewState['views'][ViewKey]['sort']
  hidden: readonly string[]
  compact: boolean
  select: (action: GridSelectionAction) => void
}

function useListGrid(view: StoreApi<BatchViewState>, key: ViewKey): ListGrid
{
  const selection = useStore(view, (state) => state.views[key].selection)
  const sort = useStore(view, (state) => state.views[key].sort)
  const set = columnSetFor(key)
  const hidden = useStore(view, (state) => state.prefs.hiddenColumns[set])
  const compact = useStore(view, (state) => state.prefs.compactRows)
  const select = useCallback((action: GridSelectionAction) =>
  {
    view.getState().select(key, action)
  }, [view, key])
  return { selection, sort, hidden, compact, select }
}

function gridProps(view: StoreApi<BatchViewState>, key: ViewKey, grid: ListGrid): {
  selected: GridSelectionState
  onSelectionChange: (next: GridSelectionState, action: GridSelectionAction) => void
  sort: ListGrid['sort']
  onSortChange: (sort: ListGrid['sort']) => void
  hiddenColumns: readonly string[]
  onHiddenColumnsChange: (hidden: string[]) => void
  density: 'default' | 'compact'
  onDensityChange: (density: 'default' | 'compact') => void
}
{
  const set = columnSetFor(key)
  return {
    selected: grid.selection,
    onSelectionChange: (_next, action) => grid.select(action),
    sort: grid.sort,
    onSortChange: (sort) => view.getState().setSort(key, sort),
    hiddenColumns: grid.hidden,
    onHiddenColumnsChange: (hidden) => view.getState().setHiddenColumns(set, hidden),
    density: grid.compact ? 'compact' : 'default',
    onDensityChange: (density) => view.getState().setCompactRows(density === 'compact')
  }
}

function StatusLine({ children, action }: { children: ReactNode, action?: ReactNode }): ReactElement
{
  return (
    <div className="flex min-h-(--size-control-md) min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 text-ink-2">
      <p role="status" className="min-w-0 text-label">{children}</p>
      {action}
    </div>
  )
}

/** A focus request for the first row of whichever list shows next, such as a batch opened without a job. */
export const FIRST_ROW_REQUEST = '\u0000first-row'

function useFocusRequest(list: StoreApi<HistoryListState>, root: React.RefObject<HTMLDivElement | null>, rows: readonly unknown[]): void
{
  const request = useStore(list, (state) => state.focusRequest)
  useLayoutEffect(() =>
  {
    if (request === null || rows.length === 0)
    {
      return
    }
    const elements = [...(root.current?.querySelectorAll<HTMLElement>('[role="row"][data-row-id]') ?? [])]
    const row = request === FIRST_ROW_REQUEST ? elements[0] : elements.find((element) => element.dataset.rowId === request)
    if (row !== undefined)
    {
      row.focus()
      list.setState({ focusRequest: null })
    }
  }, [list, request, rows, root])
}

/** Back to history from an opened batch: the search results or the batch list, with focus on the row it came from. */
export function backToHistory(view: StoreApi<BatchViewState>, list: StoreApi<HistoryListState>): void
{
  const state = view.getState()
  const runId = state.history.openRunId
  if (runId === null)
  {
    return
  }
  const searching = state.history.query.trim() !== ''
  state.closeHistoryBatch()
  if (searching)
  {
    list.setState({ focusRequest: state.views.historyResults.selection.focus ?? FIRST_ROW_REQUEST })
    return
  }
  if (state.views.history.selection.focus !== runId)
  {
    view.getState().select('history', { type: 'click', id: runId })
  }
  list.setState({ focusRequest: runId })
}

interface ListProps
{
  view: StoreApi<BatchViewState>
  list: StoreApi<HistoryListState>
  actions: BatchActions
  announce: (message: string) => void
}

function readOnlyKeys(props: ListProps, key: ViewKey): (event: KeyboardEvent, focusedId: string | null) => boolean
{
  return (event, focusedId) =>
  {
    if (event.key === ' ')
    {
      if (focusedId !== null)
      {
        props.view.getState().select(key, { type: 'toggle', id: focusedId })
      }
      return true
    }
    if (event.key === 'Delete')
    {
      void props.actions.deleteJobs([])
      return true
    }
    if (isEditKey(event))
    {
      props.announce(READ_ONLY_ANNOUNCEMENT)
      return true
    }
    return false
  }
}

function countBatches(n: number): string
{
  return count(n, 'batch', 'batches')
}

function countJobs(n: number): string
{
  return count(n, 'job', 'jobs')
}

function BatchList(props: ListProps): ReactElement
{
  const { view, list, actions } = props
  const runs = useStore(list, (state) => state.runs)
  const status = useStore(list, (state) => state.status)
  const message = useStore(list, (state) => state.message)
  const more = useStore(list, (state) => state.more)
  const usage = useStore(list, (state) => state.usage)
  const grid = useListGrid(view, 'history')
  const root = useRef<HTMLDivElement>(null)
  const confirmed = useRef(false)
  const [confirming, setConfirming] = useState<{ runId: string, opener: HTMLElement | null } | null>(null)

  useEffect(() =>
  {
    if (list.getState().status === 'idle')
    {
      void loadHistoryRuns(actions, list)
    }
  }, [actions, list])

  const rows = useMemo<BatchRow[]>(() => runs.map((entry) => ({ ...entry, id: entry.runId })), [runs])
  const columns = useMemo(() => historyBatchColumns(), [])

  useEffect(() =>
  {
    list.setState({ order: sortGridRows(rows, columns, grid.sort).map((row) => row.id) })
  }, [list, rows, columns, grid.sort])

  useFocusRequest(list, root, rows)

  const open = (runId: string): void =>
  {
    view.getState().openHistoryBatch(runId)
    list.setState({ focusRequest: FIRST_ROW_REQUEST })
  }

  const askDelete = (runId: string, opener: HTMLElement | null): void =>
  {
    confirmed.current = false
    setConfirming({ runId, opener })
  }

  const rowElement = (runId: string): HTMLElement | null =>
    [...(root.current?.querySelectorAll<HTMLElement>('[role="row"][data-row-id]') ?? [])].find((element) => element.dataset.rowId === runId) ?? null

  const menu = (row: BatchRow): MenuEntry[] =>
  {
    const runId = row.runId
    return [
      { id: 'open', label: 'Open jobs', shortcut: 'Enter', onSelect: () => open(runId) },
      { id: 'export', label: 'Export report', onSelect: () => void actions.exportReport({ runId }, 'csv') },
      {
        id: 'rerun-returned',
        label: 'Rerun returned',
        disabled: row.counts.returned === 0,
        disabledReason: row.counts.returned === 0 ? 'No jobs were returned.' : undefined,
        onSelect: () => void actions.rerun(runId, 'returned')
      },
      { id: 'rerun-all', label: 'Rerun all', onSelect: () => void actions.rerun(runId, 'all') },
      'separator',
      { id: 'delete', label: 'Delete from history', shortcut: 'Delete', danger: true, onSelect: () => askDelete(runId, rowElement(runId)) }
    ]
  }

  const onKeyCommand = (event: KeyboardEvent, focusedId: string | null): boolean =>
  {
    if (event.key === 'Delete')
    {
      if (focusedId !== null)
      {
        askDelete(focusedId, document.activeElement instanceof HTMLElement ? document.activeElement : rowElement(focusedId))
      }
      return true
    }
    if (event.key === ' ')
    {
      if (focusedId !== null)
      {
        grid.select({ type: 'toggle', id: focusedId })
      }
      return true
    }
    if (isEditKey(event))
    {
      props.announce(READ_ONLY_ANNOUNCEMENT)
      return true
    }
    return false
  }

  const resolve = (yes: boolean): void =>
  {
    const target = confirming
    confirmed.current = yes
    setConfirming(null)
    if (yes && target !== null)
    {
      void deleteFromHistory(target.runId, { actions, list, view })
    }
  }

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {confirming !== null && (
        <div className="border-b border-line px-3 py-2">
          <InlineConfirm
            question={deleteQuestion(confirming.runId)}
            safeLabel="Keep"
            confirmLabel="Delete"
            danger
            opener={null}
            fallbackFocus={() => (confirmed.current ? null : confirming.opener)}
            onResolve={resolve}
          />
        </div>
      )}
      {status === 'failed' && message !== null && (
        <StatusLine action={<Button size="sm" variant="secondary" onClick={() => void loadHistoryRuns(actions, list)}>Try again</Button>}>
          {message}
        </StatusLine>
      )}
      {status === 'ready' && rows.length === 0 && <StatusLine>No batches yet. Each batch is kept here when it ends.</StatusLine>}
      <DataGrid<BatchRow>
        label="Batches"
        rows={rows}
        columns={columns}
        {...gridProps(view, 'history', grid)}
        unsortedLabel="newest first"
        onOpen={open}
        rowLabel={(row) => batchName(row.runId)}
        countLabel={countBatches}
        onKeyCommand={onKeyCommand}
        renderCell={(row, column, context: GridCellContext) => <BatchCell row={row} column={column.id} selected={context.selected} menu={() => menu(row)} />}
        rowMenu={menu}
        loading={status === 'loading' && rows.length === 0}
        className="min-h-0 flex-1"
      />
      {(more || usage !== null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          {more && (
            <Button size="sm" variant="ghost" loading={status === 'loading'} onClick={() => void loadHistoryRuns(actions, list, { older: true })}>
              Show older batches
            </Button>
          )}
          {usage !== null && <p className="text-label text-ink-3">{usageSentence(usage)}</p>}
        </div>
      )}
    </div>
  )
}

interface SearchState
{
  query: string
  rows: MatchRow[]
  runs: number
  more: boolean
}

function SearchResults(props: ListProps & { query: string }): ReactElement
{
  const { view, list, actions, query } = props
  const grid = useListGrid(view, 'historyResults')
  const root = useRef<HTMLDivElement>(null)
  const [result, setResult] = useState<SearchState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() =>
  {
    let live = true
    const timer = window.setTimeout(() =>
    {
      void actions.searchHistory(query).then((outcome) =>
      {
        if (!live || outcome.status === 'superseded')
        {
          return
        }
        if (outcome.status === 'refused')
        {
          setFailure(outcome.message)
          return
        }
        const rows = outcome.value.matches.map((match) => ({ ...match, id: matchRowId(match) }))
        setFailure(null)
        setResult({ query, rows, runs: outcome.value.runs, more: outcome.value.more })
        view.getState().syncRows('historyResults', rows.map((row) => row.id))
      })
    }, HISTORY_SEARCH_DELAY_MS)
    return () =>
    {
      live = false
      window.clearTimeout(timer)
    }
  }, [actions, query, view])

  const rows = useMemo(() => result?.rows ?? [], [result])
  const columns = useMemo(() => historyResultColumns(), [])
  useFocusRequest(list, root, rows)

  const open = (id: string): void =>
  {
    const match = rows.find((row) => row.id === id)
    if (match !== undefined)
    {
      view.getState().openHistoryBatch(match.runId, match.jobId)
      list.setState({ focusRequest: match.jobId })
    }
  }

  const menu = (row: MatchRow): MenuEntry[] =>
    [{ id: 'open', label: `Open ${batchName(row.runId)}`, shortcut: 'Enter', onSelect: () => open(row.id) }]

  const summary = failure ?? (result === null ? 'Searching kept batches…' : searchSummary(result.rows.length, result.runs, result.query, result.more))

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <StatusLine>{summary}</StatusLine>
      <DataGrid<MatchRow>
        label="Matching jobs"
        rows={rows}
        columns={columns}
        {...gridProps(view, 'historyResults', grid)}
        unsortedLabel="newest first"
        onOpen={open}
        rowLabel={(row) => row.jobId}
        countLabel={countJobs}
        typeahead={{ columnId: 'file', text: (row) => row.sourceName }}
        onKeyCommand={readOnlyKeys(props, 'historyResults')}
        renderCell={(row, column, context: GridCellContext) => <MatchCell row={row} column={column.id} selected={context.selected} menu={() => menu(row)} />}
        rowMenu={menu}
        rowTooltip={(row) => row.sourcePath}
        loading={result === null && failure === null}
        className="min-h-0 flex-1"
      />
    </div>
  )
}

interface OpenedState
{
  runId: string
  summary: BatchSummary | null
  records: HistoryRecord[]
  total: number
}

function OpenedBatch(props: ListProps & { runId: string }): ReactElement
{
  const { view, list, actions, runId } = props
  const platform = usePlatform()
  const grid = useListGrid(view, 'historyBatch')
  const root = useRef<HTMLDivElement>(null)
  const entry = useStore(list, (state) => state.runs.find((run) => run.runId === runId) ?? null)
  const [data, setData] = useState<OpenedState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async (offset: number): Promise<void> =>
  {
    const outcome = await actions.send('getRun', { runId: runId as RunId, offset, limit: OPENED_PAGE_SIZE })
    if (outcome.status !== 'done')
    {
      setFailure(outcome.message)
      return
    }
    setFailure(null)
    const { summary, records, total } = outcome.value
    setData((previous) => (offset === 0 || previous === null || previous.runId !== runId
      ? { runId, summary, records, total }
      : { ...previous, records: [...previous.records, ...records], total }))
  }, [actions, runId])

  useEffect(() =>
  {
    void load(0)
  }, [load])

  const records = useMemo(() => latestAttempts(data?.records ?? []), [data])
  const jobs = useMemo(() => new Map(records.map((record) => [record.jobId as string, historyJobView(record)])), [records])
  const recordOf = useMemo(() => new Map(records.map((record) => [record.jobId as string, record])), [records])
  const rows = useMemo<JobRow[]>(() => records.map((record) => ({ id: record.jobId })), [records])
  const columns = useMemo(() => jobColumns('run', { lookup: (id) => jobs.get(id) ?? null, platform }), [jobs, platform])
  useFocusRequest(list, root, rows)

  const reveal = (record: HistoryRecord, target: 'output' | 'log'): void =>
  {
    void actions.send('revealRecord', { runId: record.runId, jobId: record.jobId, attempt: record.attempt, target })
  }

  const menu = (id: string): MenuEntry[] =>
  {
    const record = recordOf.get(id)
    if (record === undefined)
    {
      return []
    }
    return [
      { id: 'reveal-output', label: revealLabel(platform), disabled: record.output === null, disabledReason: record.output === null ? 'This job left no output.' : undefined, onSelect: () => reveal(record, 'output') },
      { id: 'log', label: 'Show log', disabled: record.logFile === null, disabledReason: record.logFile === null ? 'This job kept no log.' : undefined, onSelect: () => reveal(record, 'log') },
      { id: 'rerun', label: 'Rerun', onSelect: () => void actions.rerun(record.runId, [record.jobId]) }
    ]
  }

  const startedAt = data?.summary?.startedAt ?? entry?.startedAt ?? records[0]?.startedAt ?? null
  const more = data !== null && data.records.length < data.total

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <StatusLine action={<Button size="sm" variant="ghost" aria-keyshortcuts="Backspace" onClick={() => backToHistory(view, list)}>Back to history</Button>}>
        {failure ?? openedSummary(runId, startedAt)}
      </StatusLine>
      <DataGrid<JobRow>
        label={`Jobs of ${batchName(runId)}`}
        rows={rows}
        columns={columns}
        {...gridProps(view, 'historyBatch', grid)}
        unsortedLabel="queue order"
        rowLabel={(row) => row.id}
        countLabel={countJobs}
        typeahead={{ columnId: 'file', text: (row) => jobs.get(row.id)?.source.name ?? '' }}
        onKeyCommand={readOnlyKeys(props, 'historyBatch')}
        renderCell={(row, column, context: GridCellContext) =>
        {
          const job = jobs.get(row.id)
          return job === undefined
            ? null
            : <JobCell job={job} column={column.id} selected={context.selected} platform={platform} inRunMode menuItems={() => menu(row.id)} />
        }}
        rowMenu={(row) => menu(row.id)}
        rowTooltip={(row) => jobs.get(row.id)?.source.path ?? ''}
        loading={data === null && failure === null}
        className="min-h-0 flex-1"
      />
      {more && (
        <div className="px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            loading={loadingMore}
            onClick={() =>
            {
              setLoadingMore(true)
              void load(data.records.length).finally(() => setLoadingMore(false))
            }}
          >
            Show more jobs
          </Button>
        </div>
      )}
    </div>
  )
}

/** Props for {@link HistoryTable}. */
export interface HistoryTableProps
{
  /** The batch view store; the page's own by default. */
  view?: StoreApi<BatchViewState>
  /** The batch list the inspector shares; the page's own by default. */
  list?: StoreApi<HistoryListState>
  className?: string
}

/**
 * History mode's table: the kept batches newest first; with a search, the matching jobs across every kept batch;
 * and a batch opened from either, read-only in Run columns. Backspace outside a text field goes back to history.
 */
export function HistoryTable({ view = useBatchView, list = historyList, className }: HistoryTableProps): ReactElement
{
  const actions = useBatchActions()
  const announce = useAnnounce()
  const key = useStore(view, activeViewKey)
  const openRunId = useStore(view, (state) => state.history.openRunId)
  const query = useStore(view, (state) => state.history.query)
  const props: ListProps = { view, list, actions, announce: (message) => announce(message) }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key !== 'Backspace' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextField(event.target))
    {
      return
    }
    if (view.getState().history.openRunId !== null)
    {
      event.preventDefault()
      backToHistory(view, list)
    }
  }

  let content: ReactElement
  if (key === 'historyBatch' && openRunId !== null)
  {
    content = <OpenedBatch key={openRunId} {...props} runId={openRunId} />
  }
  else if (key === 'historyResults')
  {
    content = <SearchResults {...props} query={query.trim()} />
  }
  else
  {
    content = <BatchList {...props} />
  }

  return (
    <div className={cx('flex min-h-0 min-w-0 flex-col', className)} onKeyDown={onKeyDown}>
      {content}
    </div>
  )
}
