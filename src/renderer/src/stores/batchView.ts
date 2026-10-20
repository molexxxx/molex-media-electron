/**
 * The Batch view's own state: the mode that shows and, for each list, its selection, focus, sort, scroll, and
 * filters; the Review session (report, subset, acknowledgment); History's search and opened batch; and the
 * per-viewer layout choices (hidden columns per column set, compact rows, inspector width), which persist in
 * browser storage when it is available and fall back to defaults when it is not. View state never lives in
 * appStore and never crosses IPC: the engine owns jobs, this store owns how the page looks at them.
 */
import { create, createStore, type StateCreator, type StoreApi } from 'zustand'
import type { JobView, RunState } from '../../../shared/jobs/types'
import { createGridSelection, gridSelectionReducer, type GridSelectionAction, type GridSelectionState } from '../ui/useGridSelection'
import
{
  filterRows,
  formatCount,
  hiddenSelectionMessage,
  NO_FILTERS,
  selectedSimilarMessage,
  similarRowIds,
  toggledFilter,
  withFilter,
  withoutFilter,
  withSearch,
  type BatchFilter,
  type BatchFilters,
  type FilterContext,
  type SimilarBasis
} from './batchFilters'
import type { JobsState } from './jobs'
import { selectLatestRunId, selectOrderedJobs } from './jobsSelectors'

/** The modes of the one table, in tab order; Ctrl+1 to Ctrl+4 select them. */
export type BatchMode = 'queue' | 'review' | 'run' | 'history'

/** Every mode, in tab order. */
export const BATCH_MODES: readonly BatchMode[] = ['queue', 'review', 'run', 'history']

/** The lists the view remembers on their own: each mode, History's search results, and a batch opened from History. */
export type ViewKey = BatchMode | 'historyResults' | 'historyBatch'

/** Every list the view remembers. */
export const VIEW_KEYS: readonly ViewKey[] = ['queue', 'review', 'run', 'history', 'historyResults', 'historyBatch']

/** The Run tab's tooltip until a batch starts in this session. */
export const RUN_UNAVAILABLE_TOOLTIP = 'Starts when you press Start.'

/** What Ctrl+3 announces while Run is unavailable; focus stays where it is. */
export const RUN_UNAVAILABLE_ANNOUNCEMENT = 'Run starts when you press Start.'

/** The mode a Ctrl+digit selects (1 Queue, 2 Review, 3 Run, 4 History); null for any other digit. */
export function modeForDigit(digit: number): BatchMode | null
{
  return Number.isInteger(digit) ? BATCH_MODES[digit - 1] ?? null : null
}

/**
 * The mode the page opens on from the engine's first snapshot in this window: Run while a batch is open (running,
 * pausing, paused, restored, or canceling), so a reload mid-run lands where the run is; null leaves the mode alone.
 */
export function openingMode(run: Pick<RunState, 'status'> | null): BatchMode | null
{
  return run !== null && run.status !== 'idle' ? 'run' : null
}

/** A column sort as the DataGrid takes it; null is the order given (queue order). */
export interface GridSort
{
  column: string
  direction: 'ascending' | 'descending'
}

/** What one list remembers while the user is elsewhere. */
export interface ModeView
{
  selection: GridSelectionState
  sort: GridSort | null
  scrollTop: number
  filters: BatchFilters
  /** The row the inspector shows inside a multi-selection ("Showing MM-0137 of 8 selected"); null shows them all. */
  detail: string | null
}

/** A list with nothing selected, no sort, no filters, scrolled to the top. */
export function freshView(): ModeView
{
  return { selection: createGridSelection(), sort: null, scrollTop: 0, filters: NO_FILTERS, detail: null }
}

/** The column sets of the table: one per mode, and two for History (its batches and its search results). */
export type ColumnSetId = 'queue' | 'review' | 'run' | 'historyBatches' | 'historyResults'

/** Every column set. */
export const COLUMN_SET_IDS: readonly ColumnSetId[] = ['queue', 'review', 'run', 'historyBatches', 'historyResults']

/** One column of a set: priority 1 always shows, 2 from 680 px of grid width, 3 from 960 px. */
export interface BatchColumn
{
  id: string
  label: string
  priority: 1 | 2 | 3
  /** Whether the column menu can hide it; priority 1 columns always show. */
  optional: boolean
  kind: 'data' | 'actions'
}

function column(id: string, label: string, priority: 1 | 2 | 3, kind: BatchColumn['kind'] = 'data'): BatchColumn
{
  return Object.freeze({ id, label, priority, optional: priority > 1, kind })
}

const ACTIONS = column('actions', 'More actions', 1, 'actions')

/** Each set's columns in display order, with their priorities. */
export const BATCH_COLUMNS: Readonly<Record<ColumnSetId, readonly BatchColumn[]>> = Object.freeze(
{
  queue: [column('no', '#', 1), column('file', 'File', 1), column('recipe', 'Operation', 1), column('status', 'Status', 1), column('size', 'Size', 2), column('duration', 'Duration', 3), column('source', 'Source', 3), ACTIONS],
  review: [column('no', '#', 1), column('file', 'File', 2), column('plan', 'Check', 1), column('output', 'Output file', 1), column('encoder', 'Encoder', 2), column('audioPlan', 'Audio', 3), ACTIONS],
  run: [column('no', '#', 1), column('file', 'File', 1), column('status', 'Status', 1), column('progress', 'Progress', 1), column('time', 'Time', 2), column('speed', 'Speed', 3), column('out', 'Out', 3), ACTIONS],
  historyBatches: [column('batch', 'Batch', 1), column('started', 'Started', 1), column('duration', 'Duration', 3), column('jobs', 'Jobs', 1), column('verified', 'Verified', 2), column('returned', 'Returned', 1), column('canceled', 'Canceled', 3), column('in', 'In', 3), column('out', 'Out', 3), ACTIONS],
  historyResults: [column('no', '#', 1), column('file', 'File', 1), column('batch', 'Batch', 1), column('result', 'Result', 1), column('finished', 'Finished', 2), column('recipe', 'Operation', 3), ACTIONS]
})

/** The column set a list shows: History's batches and results have their own; an opened batch shows Run's. */
export function columnSetFor(key: ViewKey): ColumnSetId
{
  switch (key)
  {
    case 'history':
      return 'historyBatches'
    case 'historyBatch':
      return 'run'
    default:
      return key
  }
}

/** The ids the column menu may hide in a set, without duplicates, in the order given. */
export function sanitizeHiddenColumns(set: ColumnSetId, ids: readonly unknown[]): string[]
{
  const optional = new Set(BATCH_COLUMNS[set].filter((entry) => entry.optional).map((entry) => entry.id))
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && optional.has(id)))]
}

/** A set's columns without the hidden ones; the DataGrid then drops priorities its width cannot hold. */
export function shownColumns(set: ColumnSetId, hidden: readonly string[]): BatchColumn[]
{
  const out = new Set(hidden)
  return BATCH_COLUMNS[set].filter((entry) => !entry.optional || !out.has(entry.id))
}

/** The docked inspector's width range and default, in px. */
export const INSPECTOR_WIDTH = Object.freeze({ min: 300, max: 520, default: 360 })

/** The narrowest the table gets while the inspector is docked; the splitter refuses widths that would take more. */
export const MIN_TABLE_WIDTH = 560

/** A width the user chose, kept within 300 to 520 px; anything that is not a number gives the default. */
export function clampInspectorWidth(width: number): number
{
  if (!Number.isFinite(width))
  {
    return INSPECTOR_WIDTH.default
  }
  return Math.round(Math.min(INSPECTOR_WIDTH.max, Math.max(INSPECTOR_WIDTH.min, width)))
}

/**
 * The inspector's width for a view width: the user's width from 1180 px (never leaving the table under 560 px),
 * 320 from 1000, 300 from 880, 320 beside the table from 600, and null below 600, where it is a sheet.
 */
export function inspectorWidthFor(viewWidth: number, preferred: number): number | null
{
  if (viewWidth >= 1180)
  {
    return Math.max(INSPECTOR_WIDTH.min, Math.min(clampInspectorWidth(preferred), viewWidth - MIN_TABLE_WIDTH))
  }
  if (viewWidth >= 1000)
  {
    return 320
  }
  if (viewWidth >= 880)
  {
    return 300
  }
  return viewWidth >= 600 ? 320 : null
}

/** The layout choices one viewer keeps across reloads. */
export interface BatchViewPrefs
{
  hiddenColumns: Readonly<Record<ColumnSetId, readonly string[]>>
  compactRows: boolean
  inspectorWidth: number
}

/** Where the choices live in browser storage. */
export const PREFS_KEY = 'molexMedia.batchView.v1'

/** The part of Web Storage the choices use. */
export interface PrefsStorage
{
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function noHiddenColumns(): Record<ColumnSetId, readonly string[]>
{
  return { queue: [], review: [], run: [], historyBatches: [], historyResults: [] }
}

/** Every column shown, default rows, and the default inspector width. */
export function defaultPrefs(): BatchViewPrefs
{
  return { hiddenColumns: noHiddenColumns(), compactRows: false, inspectorWidth: INSPECTOR_WIDTH.default }
}

/** The choices stored text holds; anything missing, malformed, or out of range falls back to its default. */
export function parsePrefs(text: string | null): BatchViewPrefs
{
  const prefs = defaultPrefs()
  if (text === null)
  {
    return prefs
  }
  let data: unknown
  try
  {
    data = JSON.parse(text)
  }
  catch
  {
    return prefs
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
  {
    return prefs
  }
  const record = data as Record<string, unknown>
  const hidden = record.hiddenColumns
  if (typeof hidden === 'object' && hidden !== null)
  {
    const stored = hidden as Record<string, unknown>
    const next = noHiddenColumns()
    for (const set of COLUMN_SET_IDS)
    {
      const ids = Object.hasOwn(stored, set) ? stored[set] : undefined
      next[set] = Array.isArray(ids) ? sanitizeHiddenColumns(set, ids) : []
    }
    prefs.hiddenColumns = next
  }
  if (typeof record.compactRows === 'boolean')
  {
    prefs.compactRows = record.compactRows
  }
  if (typeof record.inspectorWidth === 'number')
  {
    prefs.inspectorWidth = clampInspectorWidth(record.inspectorWidth)
  }
  return prefs
}

/** The stored choices, or the defaults when storage is missing, refuses access, or holds nothing usable. */
export function readPrefs(storage: PrefsStorage | null): BatchViewPrefs
{
  if (storage === null)
  {
    return defaultPrefs()
  }
  try
  {
    return parsePrefs(storage.getItem(PREFS_KEY))
  }
  catch
  {
    return defaultPrefs()
  }
}

/** Stores the choices; false when storage is missing, full, or refuses access, and the page carries on without it. */
export function writePrefs(storage: PrefsStorage | null, prefs: BatchViewPrefs): boolean
{
  if (storage === null)
  {
    return false
  }
  try
  {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs))
    return true
  }
  catch
  {
    return false
  }
}

/** The window's localStorage, or null where reading it throws (blocked site data, a sandboxed frame). */
export function browserStorage(): PrefsStorage | null
{
  try
  {
    return typeof window === 'undefined' ? null : window.localStorage ?? null
  }
  catch
  {
    return null
  }
}

/** The result of asking for a mode: whether it changed, and what to announce when it could not. */
export interface ModeChange
{
  changed: boolean
  announcement: string | null
}

/** What a filter change did: the rows it keeps, the selected rows it hid, and the polite announcement. */
export interface FilterChange
{
  visible: number
  deselected: number
  announcement: string | null
}

/** The ids of the rows a list's filters keep, in the order given. */
export function visibleIds(rows: readonly JobView[], filters: BatchFilters, context: FilterContext = {}): string[]
{
  return filterRows(rows, filters, context).map((row) => row.id)
}

/**
 * The rows a mode shows before its filters, in queue order: Queue every job, Review the jobs not in a batch, and
 * Run the jobs of the current batch or, when none runs, of the last one. History's rows come from its own search.
 * Each call makes a new array, so compute it in a memo rather than in a store selector.
 */
export function modeRows(mode: BatchMode, jobs: JobsState): readonly JobView[]
{
  const ordered = selectOrderedJobs(jobs)
  switch (mode)
  {
    case 'queue':
      return ordered
    case 'review':
      return ordered.filter((job) => job.state === 'pending')
    case 'run':
    {
      const runId = selectLatestRunId(jobs)
      return runId === null ? [] : ordered.filter((job) => job.runId === runId)
    }
    default:
      return []
  }
}

/** The counts a Review report states; Start sends them back and the engine checks them. */
export interface ReviewCounts
{
  originalsAffected: number
  overwrites: number
}

/** What the view keeps of a preflight report. */
export interface ReviewReport extends ReviewCounts
{
  reportId: string
}

/** The Review session: the latest report, the subset "Start only the selected" plans for, and the acknowledgment. */
export interface ReviewSession
{
  reportId: string | null
  counts: ReviewCounts | null
  /** The jobs a subset Start preflights; null reviews every job not in a batch. */
  subset: readonly string[] | null
  acknowledged: boolean
  /** Why the acknowledgment was unchecked: "The number of originals changed to 22; confirm again." */
  notice: string | null
}

/** No report, no subset, nothing acknowledged. */
export function freshReview(): ReviewSession
{
  return { reportId: null, counts: null, subset: null, acknowledged: false, notice: null }
}

/** Whether the report's counts call for the acknowledgment: originals are affected or existing files replaced. */
export function reviewNeedsAcknowledgment(session: ReviewSession): boolean
{
  return session.counts !== null && (session.counts.originalsAffected > 0 || session.counts.overwrites > 0)
}

/** Whether Start waits for the acknowledgment. */
export function reviewAwaitsAcknowledgment(session: ReviewSession): boolean
{
  return reviewNeedsAcknowledgment(session) && !session.acknowledged
}

/** Why a refreshed report unchecked the acknowledgment, naming each count that changed. */
export function countChangeNotice(before: ReviewCounts, after: ReviewCounts): string
{
  const originals = `the number of originals changed to ${formatCount(after.originalsAffected)}`
  const overwrites = `the number of existing files replaced changed to ${formatCount(after.overwrites)}`
  const parts: string[] = []
  if (before.originalsAffected !== after.originalsAffected)
  {
    parts.push(originals)
  }
  if (before.overwrites !== after.overwrites)
  {
    parts.push(overwrites)
  }
  const sentence = parts.join(' and ')
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}; confirm again.`
}

/** History's own state: the search text and the batch opened from the list or from a search result. */
export interface HistoryView
{
  query: string
  openRunId: string | null
}

/** The list the page shows: the mode's own, or in History the opened batch, the search results, or the batches. */
export function activeViewKey(state: Pick<BatchViewState, 'mode' | 'history'>): ViewKey
{
  if (state.mode !== 'history')
  {
    return state.mode
  }
  if (state.history.openRunId !== null)
  {
    return 'historyBatch'
  }
  return state.history.query.trim() !== '' ? 'historyResults' : 'history'
}

/** The Batch view store's state and actions. */
export interface BatchViewState
{
  readonly mode: BatchMode
  /** False until the first batch of the session starts, or a restored or interrupted batch is found. */
  readonly runAvailable: boolean
  readonly views: Readonly<Record<ViewKey, ModeView>>
  readonly review: ReviewSession
  readonly history: HistoryView
  readonly prefs: BatchViewPrefs
  /** The Queue selection the add command's reply set, while the user has not changed it since. */
  readonly addedSelection: GridSelectionState | null

  /** Shows a mode; Run is refused, with its announcement, until a batch has started. */
  setMode(mode: BatchMode): ModeChange
  /** Makes Run available for the rest of the session. */
  markRunAvailable(): void
  /**
   * The engine's first snapshot in this window: an open batch makes Run available and shows it in place of the
   * initial Queue, so a reload mid-run reopens on Run; any other mode stays. Returns whether Run is shown.
   */
  openFromSnapshot(run: Pick<RunState, 'status'> | null): boolean

  /** Applies a DataGrid selection action to one list and returns the new selection. */
  select(key: ViewKey, action: GridSelectionAction): GridSelectionState
  /** Drops rows that left a list from its selection (focus passes to the nearest survivor); returns how many were deselected. */
  syncRows(key: ViewKey, ids: readonly string[], previous?: readonly string[]): number
  /** Shows one row of a multi-selection in the inspector; false when the row is not part of one. */
  openDetail(key: ViewKey, id: string): boolean
  /** Back to all the selected rows. */
  closeDetail(key: ViewKey): void
  /** The add command's reply: its jobs become the Queue selection and focus moves to the first. */
  selectAdded(ids: readonly string[]): void
  /** Rows a scan streams in later join that selection only while the user has not changed it; true when they joined. */
  extendAdded(ids: readonly string[]): boolean

  setSort(key: ViewKey, sort: GridSort | null): void
  setScroll(key: ViewKey, scrollTop: number): void

  /**
   * Replaces a list's filters. `rows` are the list's rows before any filter (see modeRows). Selected rows the new
   * filters hide are deselected, focus passes to the nearest row still shown, and the list scrolls to the top.
   */
  setFilters(key: ViewKey, filters: BatchFilters, rows: readonly JobView[], context?: FilterContext): FilterChange
  addFilter(key: ViewKey, filter: BatchFilter, rows: readonly JobView[], context?: FilterContext): FilterChange
  removeFilter(key: ViewKey, filter: BatchFilter, rows: readonly JobView[], context?: FilterContext): FilterChange
  /** A Filter menu check item: adds the chip, or removes it when the list has it. */
  toggleFilter(key: ViewKey, filter: BatchFilter, rows: readonly JobView[], context?: FilterContext): FilterChange
  clearFilters(key: ViewKey, rows: readonly JobView[], context?: FilterContext): FilterChange
  setSearch(key: ViewKey, search: string, rows: readonly JobView[], context?: FilterContext): FilterChange
  /** Ctrl+A: selects every row the list's filters show, and no other. */
  selectAllVisible(key: ViewKey, rows: readonly JobView[], context?: FilterContext): GridSelectionState
  /** Select similar: every visible row that matches `focused` on the basis, focus on it; returns the announcement. */
  selectSimilar(key: ViewKey, focused: JobView, rows: readonly JobView[], basis: SimilarBasis, context?: FilterContext): string

  /**
   * The primary Review action: opens Review with the part of the Queue selection that Review shows (jobs not in a
   * batch that Review's filters keep), so "select, Review, Start only the selected" needs no reselecting. Any
   * subset is dropped. Returns how many jobs were carried.
   */
  openReviewFromQueue(rows: readonly JobView[], context?: FilterContext): number
  /** Start opened Run: Run becomes available and the Review session ends, so no acknowledgment carries over. */
  openRunAfterStart(): void
  /**
   * A report landed. The acknowledgment stays checked while the counts of originals affected and files replaced
   * are unchanged; when one changes it unchecks and the returned reason is announced. Null when nothing unchecked.
   */
  receiveReport(report: ReviewReport): string | null
  setAcknowledged(checked: boolean): void
  /** "Start only the {k} selected jobs", or null for "Back to all"; the scope changes, so the session restarts. */
  setReviewSubset(ids: readonly string[] | null): void
  resetReview(): void

  /** History's search text; a new search closes an opened batch. */
  setHistoryQuery(query: string): void
  /** Opens a batch's jobs in History, read-only, with `jobId` selected and focused when given. */
  openHistoryBatch(runId: string, jobId?: string | null): void
  /** Back to history: the batch list or the search results, as they were. */
  closeHistoryBatch(): void

  /** Hides optional columns of a set; ids the set cannot hide are ignored. */
  setHiddenColumns(set: ColumnSetId, ids: readonly string[]): void
  /** Shows a hidden optional column or hides a shown one. */
  toggleColumn(set: ColumnSetId, id: string): void
  /** Shows every column of a set again. */
  resetColumns(set: ColumnSetId): void
  setCompactRows(compact: boolean): void
  /** Keeps the user's inspector width, within 300 to 520 px. */
  setInspectorWidth(width: number): void
}

/** What the store reads from outside; storage defaults to the window's localStorage. */
export interface BatchViewDeps
{
  storage?: PrefsStorage | null
}

function withSelection(view: ModeView, selection: GridSelectionState): ModeView
{
  if (selection === view.selection)
  {
    return view
  }
  const keepDetail = view.detail !== null && selection.selected.size > 1 && selection.selected.has(view.detail)
  return { ...view, selection, detail: keepDetail ? view.detail : null }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean
{
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function batchViewCreator(deps: BatchViewDeps): StateCreator<BatchViewState>
{
  const storage = deps.storage === undefined ? browserStorage() : deps.storage

  return (set, get) =>
  {
    const putView = (key: ViewKey, view: ModeView): void =>
    {
      if (view !== get().views[key])
      {
        set((state) => ({ views: { ...state.views, [key]: view } }))
      }
    }

    const putPrefs = (prefs: BatchViewPrefs): void =>
    {
      set({ prefs })
      writePrefs(storage, prefs)
    }

    const putHidden = (columnSet: ColumnSetId, ids: readonly string[]): void =>
    {
      const prefs = get().prefs
      const hidden = sanitizeHiddenColumns(columnSet, ids)
      if (!sameIds(hidden, prefs.hiddenColumns[columnSet]))
      {
        putPrefs({ ...prefs, hiddenColumns: { ...prefs.hiddenColumns, [columnSet]: hidden } })
      }
    }

    const applyFilters = (key: ViewKey, filters: BatchFilters, rows: readonly JobView[], context: FilterContext = {}): FilterChange =>
    {
      const view = get().views[key]
      const after = visibleIds(rows, filters, context)
      if (filters === view.filters)
      {
        return { visible: after.length, deselected: 0, announcement: null }
      }
      const before = visibleIds(rows, view.filters, context)
      const shown = new Set(after)
      const wasShown = new Set(before)
      const deselected = [...view.selection.selected].filter((id) => wasShown.has(id) && !shown.has(id)).length
      const selection = gridSelectionReducer(view.selection, { type: 'sync', ids: after, previous: before })
      putView(key, { ...withSelection(view, selection), filters, scrollTop: 0 })
      return { visible: after.length, deselected, announcement: hiddenSelectionMessage(deselected) }
    }

    return {
      mode: 'queue',
      runAvailable: false,
      views: { queue: freshView(), review: freshView(), run: freshView(), history: freshView(), historyResults: freshView(), historyBatch: freshView() },
      review: freshReview(),
      history: { query: '', openRunId: null },
      prefs: readPrefs(storage),
      addedSelection: null,

      setMode: (mode) =>
      {
        const state = get()
        if (mode === 'run' && !state.runAvailable)
        {
          return { changed: false, announcement: RUN_UNAVAILABLE_ANNOUNCEMENT }
        }
        if (mode === state.mode)
        {
          return { changed: false, announcement: null }
        }
        set({ mode })
        return { changed: true, announcement: null }
      },

      markRunAvailable: () =>
      {
        if (!get().runAvailable)
        {
          set({ runAvailable: true })
        }
      },

      openFromSnapshot: (run) =>
      {
        if (openingMode(run) !== 'run')
        {
          return false
        }
        const state = get()
        const mode = state.mode === 'queue' ? 'run' : state.mode
        if (!state.runAvailable || mode !== state.mode)
        {
          set({ runAvailable: true, mode })
        }
        return mode === 'run'
      },

      select: (key, action) =>
      {
        const view = get().views[key]
        const selection = gridSelectionReducer(view.selection, action)
        putView(key, withSelection(view, selection))
        return selection
      },

      syncRows: (key, ids, previous) =>
      {
        const view = get().views[key]
        const selection = gridSelectionReducer(view.selection, { type: 'sync', ids, previous })
        putView(key, withSelection(view, selection))
        return view.selection.selected.size - selection.selected.size
      },

      openDetail: (key, id) =>
      {
        const view = get().views[key]
        if (view.selection.selected.size < 2 || !view.selection.selected.has(id))
        {
          return false
        }
        putView(key, { ...view, detail: id })
        return true
      },

      closeDetail: (key) =>
      {
        const view = get().views[key]
        if (view.detail !== null)
        {
          putView(key, { ...view, detail: null })
        }
      },

      selectAdded: (ids) =>
      {
        if (ids.length === 0)
        {
          return
        }
        const selection = createGridSelection(ids, ids[0])
        putView('queue', withSelection(get().views.queue, selection))
        set({ addedSelection: selection })
      },

      extendAdded: (ids) =>
      {
        const { addedSelection, views } = get()
        if (addedSelection === null || views.queue.selection !== addedSelection)
        {
          return false
        }
        const selection: GridSelectionState = { selected: new Set([...addedSelection.selected, ...ids]), anchor: addedSelection.anchor, focus: addedSelection.focus }
        putView('queue', withSelection(views.queue, selection))
        set({ addedSelection: selection })
        return true
      },

      setSort: (key, sort) =>
      {
        const view = get().views[key]
        const same = sort === null ? view.sort === null : view.sort !== null && view.sort.column === sort.column && view.sort.direction === sort.direction
        if (!same)
        {
          putView(key, { ...view, sort: sort === null ? null : { ...sort } })
        }
      },

      setScroll: (key, scrollTop) =>
      {
        const view = get().views[key]
        const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
        if (top !== view.scrollTop)
        {
          putView(key, { ...view, scrollTop: top })
        }
      },

      setFilters: (key, filters, rows, context) => applyFilters(key, filters, rows, context),

      addFilter: (key, filter, rows, context) => applyFilters(key, withFilter(get().views[key].filters, filter), rows, context),

      removeFilter: (key, filter, rows, context) => applyFilters(key, withoutFilter(get().views[key].filters, filter), rows, context),

      toggleFilter: (key, filter, rows, context) => applyFilters(key, toggledFilter(get().views[key].filters, filter), rows, context),

      clearFilters: (key, rows, context) =>
      {
        const filters = get().views[key].filters
        const empty = filters.chips.length === 0 && filters.search === ''
        return applyFilters(key, empty ? filters : NO_FILTERS, rows, context)
      },

      setSearch: (key, search, rows, context) => applyFilters(key, withSearch(get().views[key].filters, search), rows, context),

      selectAllVisible: (key, rows, context) => get().select(key, { type: 'selectAll', ids: visibleIds(rows, get().views[key].filters, context) }),

      selectSimilar: (key, focused, rows, basis, context = {}) =>
      {
        const view = get().views[key]
        const ids = similarRowIds(focused, filterRows(rows, view.filters, context), basis)
        putView(key, withSelection(view, { selected: new Set(ids), anchor: focused.id, focus: focused.id }))
        return selectedSimilarMessage(ids.length, basis)
      },

      openReviewFromQueue: (rows, context) =>
      {
        const { views } = get()
        const queue = views.queue.selection
        const review = views.review
        const visible = visibleIds(rows.filter((row) => row.state === 'pending'), review.filters, context)
        const carried = visible.filter((id) => queue.selected.has(id))
        const carriedSet = new Set(carried)
        const remembered = review.selection.focus !== null && visible.includes(review.selection.focus) ? review.selection.focus : null
        const focus = queue.focus !== null && carriedSet.has(queue.focus) ? queue.focus : carried[0] ?? remembered
        const anchor = queue.anchor !== null && carriedSet.has(queue.anchor) ? queue.anchor : focus
        const selection: GridSelectionState = { selected: carriedSet, anchor, focus }
        set((state) => (
        {
          mode: 'review',
          views: { ...state.views, review: withSelection(review, selection) },
          review: state.review.subset === null ? state.review : freshReview()
        }))
        return carried.length
      },

      openRunAfterStart: () => set({ mode: 'run', runAvailable: true, review: freshReview() }),

      receiveReport: (report) =>
      {
        const session = get().review
        const counts: ReviewCounts = { originalsAffected: report.originalsAffected, overwrites: report.overwrites }
        const previous = session.counts
        const changed = previous !== null && (previous.originalsAffected !== counts.originalsAffected || previous.overwrites !== counts.overwrites)
        const needed = counts.originalsAffected > 0 || counts.overwrites > 0
        let acknowledged = session.acknowledged
        let notice = session.notice
        let announcement: string | null = null
        if (changed)
        {
          const confirmed = acknowledged || notice !== null
          acknowledged = false
          notice = confirmed && needed ? countChangeNotice(previous, counts) : null
          announcement = notice
        }
        if (!needed)
        {
          acknowledged = false
          notice = null
        }
        set({ review: { ...session, reportId: report.reportId, counts, acknowledged, notice } })
        return announcement
      },

      setAcknowledged: (checked) =>
      {
        const session = get().review
        if (session.acknowledged !== checked || session.notice !== null)
        {
          set({ review: { ...session, acknowledged: checked, notice: null } })
        }
      },

      setReviewSubset: (ids) =>
      {
        const current = get().review.subset
        const same = ids === null ? current === null : current !== null && sameIds(current, ids)
        if (!same)
        {
          set({ review: { ...freshReview(), subset: ids === null ? null : [...ids] } })
        }
      },

      resetReview: () => set({ review: freshReview() }),

      setHistoryQuery: (query) =>
      {
        const { history, views } = get()
        if (query !== history.query)
        {
          set({ history: { query, openRunId: null }, views: { ...views, historyResults: { ...views.historyResults, scrollTop: 0 } } })
        }
      },

      openHistoryBatch: (runId, jobId = null) =>
      {
        const selection = jobId === null ? createGridSelection() : createGridSelection([jobId], jobId)
        set((state) => (
        {
          mode: 'history',
          history: { ...state.history, openRunId: runId },
          views: { ...state.views, historyBatch: { ...freshView(), selection } }
        }))
      },

      closeHistoryBatch: () =>
      {
        const history = get().history
        if (history.openRunId !== null)
        {
          set({ history: { ...history, openRunId: null } })
        }
      },

      setHiddenColumns: (columnSet, ids) => putHidden(columnSet, ids),

      toggleColumn: (columnSet, id) =>
      {
        const hidden = get().prefs.hiddenColumns[columnSet]
        putHidden(columnSet, hidden.includes(id) ? hidden.filter((entry) => entry !== id) : [...hidden, id])
      },

      resetColumns: (columnSet) => putHidden(columnSet, []),

      setCompactRows: (compact) =>
      {
        const prefs = get().prefs
        if (prefs.compactRows !== compact)
        {
          putPrefs({ ...prefs, compactRows: compact })
        }
      },

      setInspectorWidth: (width) =>
      {
        const prefs = get().prefs
        const next = clampInspectorWidth(width)
        if (prefs.inspectorWidth !== next)
        {
          putPrefs({ ...prefs, inspectorWidth: next })
        }
      }
    }
  }
}

/** A Batch view store of its own, for tests and for a window that needs a separate one. */
export function createBatchViewStore(deps: BatchViewDeps = {}): StoreApi<BatchViewState>
{
  return createStore<BatchViewState>()(batchViewCreator(deps))
}

/** The window's Batch view store. */
export const useBatchView = create<BatchViewState>()(batchViewCreator({}))
