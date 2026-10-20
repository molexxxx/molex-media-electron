/**
 * Guards the Batch view store: each mode keeps its own selection, focus, sort, scroll, filters, and hidden columns;
 * Run stays closed until a batch starts; the brass Review carries only the pending part of the Queue selection;
 * filter changes deselect what they hide and report it; Ctrl+A reaches only visible rows; the Review
 * acknowledgment survives refreshes with unchanged counts; and layout choices persist per viewer, with storage
 * that is missing, full, or refusing access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchFilter } from '../../src/renderer/src/stores/batchFilters'
import {
  activeViewKey,
  BATCH_COLUMNS,
  BATCH_MODES,
  browserStorage,
  clampInspectorWidth,
  columnSetFor,
  COLUMN_SET_IDS,
  countChangeNotice,
  createBatchViewStore,
  defaultPrefs,
  freshReview,
  freshView,
  INSPECTOR_WIDTH,
  inspectorWidthFor,
  modeForDigit,
  modeRows,
  parsePrefs,
  PREFS_KEY,
  readPrefs,
  reviewAwaitsAcknowledgment,
  reviewNeedsAcknowledgment,
  RUN_UNAVAILABLE_ANNOUNCEMENT,
  RUN_UNAVAILABLE_TOOLTIP,
  sanitizeHiddenColumns,
  shownColumns,
  useBatchView,
  VIEW_KEYS,
  visibleIds,
  writePrefs,
  type PrefsStorage
} from '../../src/renderer/src/stores/batchView'
import type { JobsState } from '../../src/renderer/src/stores/jobs'
import type { JobView } from '../../src/shared/jobs/types'

type Over = Partial<Omit<JobView, 'source'>> & { source?: Partial<JobView['source']> }

function job(id: string, over: Over = {}): JobView
{
  const { source, ...rest } = over
  return {
    id,
    source: { path: `D:\\Media\\${id}.mkv`, name: `${id}.mkv`, ext: '.mkv', dir: 'D:\\Media', size: 1, mtimeMs: 1, origin: 'files', subdir: '', ...source },
    recipe: { kind: 'normalize', presetId: 'ebu-r128', userPreset: null },
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    media: { container: 'matroska', durationSec: 1, video: { codec: 'h264', width: 1, height: 1, rotation: 0, fps: 25 }, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false },
    plan: null,
    warnings: [],
    acknowledged: false,
    runId: null,
    albumGroupId: null,
    ...rest
  } as unknown as JobView
}

const audioOnly = { container: 'wav', durationSec: 1, video: null, audio: [{ codec: 'pcm_s16le', channels: 2, layout: 'stereo', sampleRate: 48000, bitsPerSample: 16, bitrateKbps: null, language: null, isDefault: true }], subtitles: 0, attachments: 0, chapters: 0, cover: false } as unknown as JobView['media']

const AUDIO: BatchFilter = { facet: 'type', value: 'audio' }

class MemoryStorage implements PrefsStorage
{
  readonly items = new Map<string, string>()
  writes = 0

  getItem(key: string): string | null
  {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void
  {
    this.writes += 1
    this.items.set(key, value)
  }
}

const refusing: PrefsStorage =
{
  getItem: () =>
  {
    throw new Error('SecurityError')
  },
  setItem: () =>
  {
    throw new Error('QuotaExceededError')
  }
}

function store(storage: PrefsStorage | null = new MemoryStorage()): ReturnType<typeof createBatchViewStore>
{
  return createBatchViewStore({ storage })
}

const ids = ['MM-0001', 'MM-0002', 'MM-0003', 'MM-0004']

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('modes', () =>
{
  it('starts in Queue with Run unavailable and every list fresh', () =>
  {
    const state = store().getState()
    expect(state.mode).toBe('queue')
    expect(state.runAvailable).toBe(false)
    expect(Object.keys(state.views)).toEqual([...VIEW_KEYS])
    expect(state.views.review).toEqual(freshView())
    expect(BATCH_MODES).toEqual(['queue', 'review', 'run', 'history'])
  })

  it('refuses Run with its announcement until a batch starts, without changing mode', () =>
  {
    const view = store()
    expect(view.getState().setMode('review')).toEqual({ changed: true, announcement: null })
    expect(view.getState().setMode('run')).toEqual({ changed: false, announcement: RUN_UNAVAILABLE_ANNOUNCEMENT })
    expect(view.getState().mode).toBe('review')
    expect(RUN_UNAVAILABLE_TOOLTIP).toBe('Starts when you press Start.')
    view.getState().markRunAvailable()
    view.getState().markRunAvailable()
    expect(view.getState().runAvailable).toBe(true)
    expect(view.getState().setMode('run')).toEqual({ changed: true, announcement: null })
    expect(view.getState().setMode('run')).toEqual({ changed: false, announcement: null })
  })

  it('maps Ctrl+1 to Ctrl+4 onto the tabs', () =>
  {
    expect([1, 2, 3, 4].map(modeForDigit)).toEqual(['queue', 'review', 'run', 'history'])
    expect(modeForDigit(0)).toBeNull()
    expect(modeForDigit(5)).toBeNull()
    expect(modeForDigit(1.5)).toBeNull()
  })
})

describe('selection per mode', () =>
{
  it('keeps each mode its own selection, focus, sort, and scroll', () =>
  {
    const view = store()
    const state = (): ReturnType<typeof view.getState> => view.getState()
    state().select('queue', { type: 'click', id: ids[0] })
    state().select('queue', { type: 'shiftClick', id: ids[2], ids })
    state().setSort('queue', { column: 'file', direction: 'ascending' })
    state().setScroll('queue', 640)
    state().select('review', { type: 'click', id: ids[3] })
    state().setSort('review', { column: 'plan', direction: 'descending' })
    state().setScroll('review', 32)
    state().setMode('review')
    state().setMode('queue')
    const { queue, review, run } = state().views
    expect([...queue.selection.selected]).toEqual(ids.slice(0, 3))
    expect(queue.selection.focus).toBe(ids[2])
    expect(queue.selection.anchor).toBe(ids[0])
    expect(queue.sort).toEqual({ column: 'file', direction: 'ascending' })
    expect(queue.scrollTop).toBe(640)
    expect([...review.selection.selected]).toEqual([ids[3]])
    expect(review.sort).toEqual({ column: 'plan', direction: 'descending' })
    expect(review.scrollTop).toBe(32)
    expect(run).toEqual(freshView())
  })

  it('returns the selection and keeps the same objects when an action changes nothing', () =>
  {
    const view = store()
    const before = view.getState().views
    const selection = view.getState().select('queue', { type: 'clear' })
    expect(selection).toBe(before.queue.selection)
    expect(view.getState().views).toBe(before)
    view.getState().setSort('queue', null)
    view.getState().setScroll('queue', 0)
    expect(view.getState().views).toBe(before)
  })

  it('changes a sort only when column or direction differ, and clears it with null', () =>
  {
    const view = store()
    view.getState().setSort('run', { column: 'time', direction: 'ascending' })
    const sorted = view.getState().views
    view.getState().setSort('run', { column: 'time', direction: 'ascending' })
    expect(view.getState().views).toBe(sorted)
    view.getState().setSort('run', { column: 'time', direction: 'descending' })
    expect(view.getState().views.run.sort).toEqual({ column: 'time', direction: 'descending' })
    view.getState().setSort('run', { column: 'speed', direction: 'descending' })
    expect(view.getState().views.run.sort?.column).toBe('speed')
    view.getState().setSort('run', null)
    expect(view.getState().views.run.sort).toBeNull()
  })

  it('keeps scroll offsets at zero or above', () =>
  {
    const view = store()
    view.getState().setScroll('history', -20)
    expect(view.getState().views.history.scrollTop).toBe(0)
    view.getState().setScroll('history', Number.NaN)
    expect(view.getState().views.history.scrollTop).toBe(0)
    view.getState().setScroll('history', 96)
    expect(view.getState().views.history.scrollTop).toBe(96)
  })

  it('drops rows that left a list and passes focus to the next row', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: ids[1] })
    view.getState().select('queue', { type: 'ctrlClick', id: ids[2] })
    const deselected = view.getState().syncRows('queue', [ids[0], ids[1], ids[3]], ids)
    expect(deselected).toBe(1)
    expect([...view.getState().views.queue.selection.selected]).toEqual([ids[1]])
    expect(view.getState().views.queue.selection.focus).toBe(ids[3])
    expect(view.getState().syncRows('queue', [ids[0], ids[1], ids[3]])).toBe(0)
  })

  it('shows one row of a multi-selection in the inspector until the selection moves away from it', () =>
  {
    const view = store()
    view.getState().select('review', { type: 'click', id: ids[0] })
    expect(view.getState().openDetail('review', ids[0])).toBe(false)
    view.getState().select('review', { type: 'shiftClick', id: ids[2], ids })
    expect(view.getState().openDetail('review', ids[3])).toBe(false)
    expect(view.getState().openDetail('review', ids[1])).toBe(true)
    expect(view.getState().views.review.detail).toBe(ids[1])
    view.getState().select('review', { type: 'ctrlClick', id: ids[0] })
    expect(view.getState().views.review.detail).toBe(ids[1])
    view.getState().closeDetail('review')
    expect(view.getState().views.review.detail).toBeNull()
    const closed = view.getState().views
    view.getState().closeDetail('review')
    expect(view.getState().views).toBe(closed)
    view.getState().openDetail('review', ids[2])
    view.getState().select('review', { type: 'ctrlClick', id: ids[2] })
    expect(view.getState().views.review.detail).toBeNull()
  })

  it('selects the jobs an add created and extends that selection only until the user changes it', () =>
  {
    const view = store()
    view.getState().selectAdded([])
    expect(view.getState().addedSelection).toBeNull()
    expect(view.getState().extendAdded([ids[3]])).toBe(false)
    view.getState().selectAdded([ids[1], ids[2]])
    const queue = view.getState().views.queue.selection
    expect([...queue.selected]).toEqual([ids[1], ids[2]])
    expect(queue.focus).toBe(ids[1])
    expect(view.getState().extendAdded([ids[3]])).toBe(true)
    expect([...view.getState().views.queue.selection.selected]).toEqual([ids[1], ids[2], ids[3]])
    expect(view.getState().views.queue.selection.focus).toBe(ids[1])
    view.getState().select('queue', { type: 'click', id: ids[0] })
    expect(view.getState().extendAdded(['MM-0009'])).toBe(false)
    expect([...view.getState().views.queue.selection.selected]).toEqual([ids[0]])
  })

  it('leaves the other modes alone when an add sets the Queue selection', () =>
  {
    const view = store()
    view.getState().select('run', { type: 'click', id: ids[0] })
    view.getState().selectAdded([ids[1]])
    expect([...view.getState().views.run.selection.selected]).toEqual([ids[0]])
  })
})

describe('columns', () =>
{
  it('defines each set in display order with priorities and the actions column last', () =>
  {
    expect(BATCH_COLUMNS.queue.map((entry) => [entry.id, entry.priority])).toEqual([['no', 1], ['file', 1], ['recipe', 1], ['status', 1], ['size', 2], ['duration', 3], ['source', 3], ['actions', 1]])
    expect(BATCH_COLUMNS.review.filter((entry) => entry.priority === 1).map((entry) => entry.id)).toEqual(['no', 'plan', 'output', 'actions'])
    expect(BATCH_COLUMNS.run.filter((entry) => entry.priority === 1).map((entry) => entry.id)).toEqual(['no', 'file', 'status', 'progress', 'actions'])
    expect(BATCH_COLUMNS.historyBatches.map((entry) => entry.label)).toEqual(['Batch', 'Started', 'Duration', 'Jobs', 'Verified', 'Returned', 'Canceled', 'In', 'Out', 'More actions'])
    expect(BATCH_COLUMNS.historyResults.filter((entry) => entry.priority === 1).map((entry) => entry.id)).toEqual(['no', 'file', 'batch', 'result', 'actions'])
    for (const set of COLUMN_SET_IDS)
    {
      const last = BATCH_COLUMNS[set][BATCH_COLUMNS[set].length - 1]
      expect(last.kind).toBe('actions')
      expect(BATCH_COLUMNS[set].every((entry) => entry.optional === entry.priority > 1)).toBe(true)
    }
  })

  it('maps each list to its column set; an opened batch uses Run columns', () =>
  {
    expect(VIEW_KEYS.map(columnSetFor)).toEqual(['queue', 'review', 'run', 'historyBatches', 'historyResults', 'run'])
  })

  it('hides only optional columns of the set, once each', () =>
  {
    expect(sanitizeHiddenColumns('queue', ['size', 'file', 'size', 3, 'source', 'plan'])).toEqual(['size', 'source'])
    expect(shownColumns('queue', ['size', 'file']).map((entry) => entry.id)).toEqual(['no', 'file', 'recipe', 'status', 'duration', 'source', 'actions'])
  })

  it('keeps hidden columns per set and toggles and resets them', () =>
  {
    const view = store()
    view.getState().setHiddenColumns('queue', ['size', 'no'])
    view.getState().toggleColumn('run', 'speed')
    view.getState().toggleColumn('run', 'out')
    view.getState().toggleColumn('run', 'speed')
    view.getState().toggleColumn('run', 'status')
    expect(view.getState().prefs.hiddenColumns.queue).toEqual(['size'])
    expect(view.getState().prefs.hiddenColumns.run).toEqual(['out'])
    expect(view.getState().prefs.hiddenColumns.review).toEqual([])
    const prefs = view.getState().prefs
    view.getState().setHiddenColumns('queue', ['size'])
    expect(view.getState().prefs).toBe(prefs)
    view.getState().resetColumns('queue')
    expect(view.getState().prefs.hiddenColumns.queue).toEqual([])
    expect(view.getState().prefs.hiddenColumns.run).toEqual(['out'])
  })
})

describe('inspector width', () =>
{
  it('clamps the chosen width to 300 to 520', () =>
  {
    expect(clampInspectorWidth(200)).toBe(300)
    expect(clampInspectorWidth(900)).toBe(520)
    expect(clampInspectorWidth(401.6)).toBe(402)
    expect(clampInspectorWidth(Number.NaN)).toBe(INSPECTOR_WIDTH.default)
    expect(clampInspectorWidth(Number.POSITIVE_INFINITY)).toBe(INSPECTOR_WIDTH.default)
  })

  it('follows the view width and never leaves the table under 560', () =>
  {
    expect(inspectorWidthFor(1657, 480)).toBe(480)
    expect(inspectorWidthFor(1180, 520)).toBe(520)
    expect(inspectorWidthFor(1180, 600)).toBe(520)
    expect(inspectorWidthFor(1180, 100)).toBe(300)
    expect(inspectorWidthFor(1100, 480)).toBe(320)
    expect(inspectorWidthFor(900, 480)).toBe(300)
    expect(inspectorWidthFor(700, 480)).toBe(320)
    expect(inspectorWidthFor(600, 480)).toBe(320)
    expect(inspectorWidthFor(599, 480)).toBeNull()
  })

  it('keeps the width in prefs', () =>
  {
    const view = store()
    view.getState().setInspectorWidth(450)
    expect(view.getState().prefs.inspectorWidth).toBe(450)
    const prefs = view.getState().prefs
    view.getState().setInspectorWidth(450.2)
    expect(view.getState().prefs).toBe(prefs)
  })
})

describe('per-viewer prefs', () =>
{
  it('survives a reload through storage', () =>
  {
    const storage = new MemoryStorage()
    const first = store(storage)
    first.getState().setHiddenColumns('review', ['audioPlan', 'encoder'])
    first.getState().setHiddenColumns('historyBatches', ['in'])
    first.getState().setCompactRows(true)
    first.getState().setInspectorWidth(410)
    const reloaded = store(storage).getState().prefs
    expect(reloaded.hiddenColumns.review).toEqual(['audioPlan', 'encoder'])
    expect(reloaded.hiddenColumns.historyBatches).toEqual(['in'])
    expect(reloaded.compactRows).toBe(true)
    expect(reloaded.inspectorWidth).toBe(410)
    expect(JSON.parse(storage.items.get(PREFS_KEY) as string).compactRows).toBe(true)
  })

  it('writes only when a choice changes', () =>
  {
    const storage = new MemoryStorage()
    const view = store(storage)
    view.getState().setCompactRows(false)
    view.getState().resetColumns('queue')
    view.getState().setInspectorWidth(INSPECTOR_WIDTH.default)
    expect(storage.writes).toBe(0)
    view.getState().setCompactRows(true)
    expect(storage.writes).toBe(1)
  })

  it('works without storage and with storage that refuses access', () =>
  {
    for (const storage of [null, refusing])
    {
      const view = store(storage)
      expect(view.getState().prefs).toEqual(defaultPrefs())
      view.getState().setCompactRows(true)
      view.getState().toggleColumn('queue', 'size')
      expect(view.getState().prefs.compactRows).toBe(true)
      expect(view.getState().prefs.hiddenColumns.queue).toEqual(['size'])
    }
    expect(writePrefs(null, defaultPrefs())).toBe(false)
    expect(writePrefs(refusing, defaultPrefs())).toBe(false)
    expect(readPrefs(refusing)).toEqual(defaultPrefs())
    expect(readPrefs(null)).toEqual(defaultPrefs())
  })

  it('falls back to defaults for anything malformed or out of range', () =>
  {
    expect(parsePrefs(null)).toEqual(defaultPrefs())
    expect(parsePrefs('{not json')).toEqual(defaultPrefs())
    expect(parsePrefs('42')).toEqual(defaultPrefs())
    expect(parsePrefs('null')).toEqual(defaultPrefs())
    expect(parsePrefs('[1, 2]')).toEqual(defaultPrefs())
    const parsed = parsePrefs(JSON.stringify({ hiddenColumns: { queue: ['size', 'file', 7], run: 'speed', constructor: ['x'] }, compactRows: 'yes', inspectorWidth: 9000 }))
    expect(parsed.hiddenColumns).toEqual({ queue: ['size'], review: [], run: [], historyBatches: [], historyResults: [] })
    expect(parsed.compactRows).toBe(false)
    expect(parsed.inspectorWidth).toBe(520)
    expect(parsePrefs(JSON.stringify({ hiddenColumns: null, inspectorWidth: '400' }))).toEqual(defaultPrefs())
  })

  it('reads the window storage, and none where reading it throws', () =>
  {
    expect(browserStorage()).toBe(window.localStorage)
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() =>
    {
      throw new Error('SecurityError')
    })
    expect(browserStorage()).toBeNull()
    expect(createBatchViewStore().getState().prefs).toEqual(defaultPrefs())
  })

  it('gives the window one shared store', () =>
  {
    expect(useBatchView.getState().mode).toBe('queue')
    expect(typeof useBatchView.getState().setMode).toBe('function')
  })
})

describe('filters per mode', () =>
{
  const rows = [
    job('MM-0001'),
    job('MM-0002', { media: audioOnly }),
    job('MM-0003'),
    job('MM-0004', { media: audioOnly })
  ]

  it('deselects the rows a filter hides, moves focus to a shown row, and reports the count', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: 'MM-0001' })
    view.getState().select('queue', { type: 'shiftClick', id: 'MM-0003', ids: rows.map((row) => row.id) })
    view.getState().setScroll('queue', 300)
    const change = view.getState().addFilter('queue', AUDIO, rows)
    expect(change).toEqual({ visible: 2, deselected: 2, announcement: '2 selected jobs are hidden by the filter and were deselected.' })
    const queue = view.getState().views.queue
    expect([...queue.selection.selected]).toEqual(['MM-0002'])
    expect(queue.selection.focus).toBe('MM-0004')
    expect(queue.filters.chips).toEqual([AUDIO])
    expect(queue.scrollTop).toBe(0)
  })

  it('reports no announcement when nothing selected was hidden, and no change for the same filters', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: 'MM-0002' })
    expect(view.getState().addFilter('queue', AUDIO, rows)).toEqual({ visible: 2, deselected: 0, announcement: null })
    const views = view.getState().views
    expect(view.getState().addFilter('queue', AUDIO, rows)).toEqual({ visible: 2, deselected: 0, announcement: null })
    expect(view.getState().views).toBe(views)
  })

  it('counts only rows the filter hid, not rows that already left the list', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: 'MM-0001' })
    view.getState().select('queue', { type: 'ctrlClick', id: 'MM-0099' })
    expect(view.getState().addFilter('queue', AUDIO, rows).deselected).toBe(1)
    expect(view.getState().views.queue.selection.selected.size).toBe(0)
  })

  it('keeps filters in the mode they were set in', () =>
  {
    const view = store()
    view.getState().addFilter('queue', AUDIO, rows)
    view.getState().setSearch('review', 'MM-0003', rows)
    expect(view.getState().views.queue.filters).toEqual({ chips: [AUDIO], search: '' })
    expect(view.getState().views.review.filters).toEqual({ chips: [], search: 'MM-0003' })
    expect(view.getState().views.run.filters).toEqual({ chips: [], search: '' })
  })

  it('removes, toggles, and clears chips', () =>
  {
    const view = store()
    view.getState().toggleFilter('run', AUDIO, rows)
    expect(view.getState().views.run.filters.chips).toEqual([AUDIO])
    view.getState().toggleFilter('run', AUDIO, rows)
    expect(view.getState().views.run.filters.chips).toEqual([])
    view.getState().addFilter('run', AUDIO, rows)
    expect(view.getState().removeFilter('run', AUDIO, rows).visible).toBe(4)
    view.getState().addFilter('run', AUDIO, rows)
    view.getState().setSearch('run', 'x', rows)
    expect(view.getState().clearFilters('run', rows).visible).toBe(4)
    expect(view.getState().views.run.filters).toEqual({ chips: [], search: '' })
    const views = view.getState().views
    view.getState().clearFilters('run', rows)
    expect(view.getState().views).toBe(views)
  })

  it('deselects rows a search hides too', () =>
  {
    const view = store()
    view.getState().select('review', { type: 'click', id: 'MM-0001' })
    view.getState().select('review', { type: 'ctrlClick', id: 'MM-0003' })
    const change = view.getState().setSearch('review', 'MM-0003', rows)
    expect(change.announcement).toBe('1 selected job is hidden by the filter and was deselected.')
    expect([...view.getState().views.review.selection.selected]).toEqual(['MM-0003'])
  })

  it('replaces every filter of a list at once', () =>
  {
    const view = store()
    view.getState().select('run', { type: 'click', id: 'MM-0003' })
    const change = view.getState().setFilters('run', { chips: [AUDIO], search: '0004' }, rows)
    expect(change).toEqual({ visible: 1, deselected: 1, announcement: '1 selected job is hidden by the filter and was deselected.' })
    expect(view.getState().views.run.filters).toEqual({ chips: [AUDIO], search: '0004' })
    expect(view.getState().views.run.selection.focus).toBe('MM-0004')
  })

  it('lists the visible ids in the order given', () =>
  {
    expect(visibleIds(rows, { chips: [AUDIO], search: '' })).toEqual(['MM-0002', 'MM-0004'])
  })
})

describe('Ctrl+A and Select similar', () =>
{
  const rows = [
    job('MM-0001', { source: { dir: 'D:\\A' } }),
    job('MM-0002', { media: audioOnly, source: { dir: 'D:\\A' } }),
    job('MM-0003', { source: { dir: 'D:\\B' } }),
    job('MM-0004', { media: audioOnly, source: { dir: 'D:\\A' } })
  ]

  it('selects only the rows the filters show', () =>
  {
    const view = store()
    view.getState().addFilter('queue', AUDIO, rows)
    const selection = view.getState().selectAllVisible('queue', rows)
    expect([...selection.selected]).toEqual(['MM-0002', 'MM-0004'])
    view.getState().clearFilters('queue', rows)
    expect([...view.getState().selectAllVisible('queue', rows).selected]).toEqual(rows.map((row) => row.id))
  })

  it('selects the visible rows like the focused one and focuses it', () =>
  {
    const view = store()
    view.getState().addFilter('queue', AUDIO, rows)
    expect(view.getState().selectSimilar('queue', rows[1], rows, 'folder')).toBe('Selected 2 jobs in the same folder.')
    const selection = view.getState().views.queue.selection
    expect([...selection.selected]).toEqual(['MM-0002', 'MM-0004'])
    expect(selection.focus).toBe('MM-0002')
    expect(selection.anchor).toBe('MM-0002')
    view.getState().clearFilters('queue', rows)
    expect(view.getState().selectSimilar('queue', rows[2], rows, 'folder')).toBe('Selected 1 job in the same folder.')
  })
})

describe('Review handoff', () =>
{
  const rows = [
    job('MM-0001'),
    job('MM-0002', { state: 'queued', runId: 'R-0001' as JobView['runId'] }),
    job('MM-0003', { media: audioOnly }),
    job('MM-0004'),
    job('MM-0005', { state: 'done', runId: 'R-0001' as JobView['runId'] })
  ]
  const order = rows.map((row) => row.id)

  it('carries only the pending part of the Queue selection into Review and opens it', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: 'MM-0002' })
    view.getState().select('queue', { type: 'shiftClick', id: 'MM-0005', ids: order })
    expect(view.getState().openReviewFromQueue(rows)).toBe(2)
    const state = view.getState()
    expect(state.mode).toBe('review')
    expect([...state.views.review.selection.selected]).toEqual(['MM-0003', 'MM-0004'])
    expect(state.views.review.selection.focus).toBe('MM-0003')
    expect(state.views.review.selection.anchor).toBe('MM-0003')
    expect([...state.views.queue.selection.selected]).toEqual(['MM-0002', 'MM-0003', 'MM-0004', 'MM-0005'])
  })

  it('keeps the Queue focus and anchor when they are carried', () =>
  {
    const view = store()
    view.getState().select('queue', { type: 'click', id: 'MM-0001' })
    view.getState().select('queue', { type: 'shiftClick', id: 'MM-0004', ids: order })
    view.getState().openReviewFromQueue(rows)
    const selection = view.getState().views.review.selection
    expect(selection.focus).toBe('MM-0004')
    expect(selection.anchor).toBe('MM-0001')
  })

  it('leaves out rows Review filters hide', () =>
  {
    const view = store()
    view.getState().addFilter('review', AUDIO, rows)
    view.getState().select('queue', { type: 'click', id: 'MM-0001' })
    view.getState().select('queue', { type: 'shiftClick', id: 'MM-0004', ids: order })
    expect(view.getState().openReviewFromQueue(rows)).toBe(1)
    expect([...view.getState().views.review.selection.selected]).toEqual(['MM-0003'])
  })

  it('with nothing pending selected, clears the Review selection and keeps a focus Review still shows', () =>
  {
    const view = store()
    view.getState().select('review', { type: 'click', id: 'MM-0004' })
    view.getState().select('queue', { type: 'click', id: 'MM-0005' })
    expect(view.getState().openReviewFromQueue(rows)).toBe(0)
    const selection = view.getState().views.review.selection
    expect(selection.selected.size).toBe(0)
    expect(selection.focus).toBe('MM-0004')
    const other = store()
    other.getState().select('review', { type: 'click', id: 'MM-0002' })
    other.getState().openReviewFromQueue(rows)
    expect(other.getState().views.review.selection.focus).toBeNull()
  })

  it('drops a subset and its session, and keeps a session without one', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 2, overwrites: 0 })
    view.getState().setAcknowledged(true)
    view.getState().openReviewFromQueue(rows)
    expect(view.getState().review.acknowledged).toBe(true)
    view.getState().setReviewSubset(['MM-0001'])
    view.getState().openReviewFromQueue(rows)
    expect(view.getState().review).toEqual(freshReview())
  })

  it('opens Run after Start and forgets the acknowledgment', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 2, overwrites: 0 })
    view.getState().setAcknowledged(true)
    view.getState().openRunAfterStart()
    const state = view.getState()
    expect(state.mode).toBe('run')
    expect(state.runAvailable).toBe(true)
    expect(state.review).toEqual(freshReview())
  })
})

describe('Review acknowledgment', () =>
{
  it('needs the acknowledgment only when originals are affected or files replaced', () =>
  {
    expect(reviewNeedsAcknowledgment(freshReview())).toBe(false)
    expect(reviewNeedsAcknowledgment({ ...freshReview(), counts: { originalsAffected: 0, overwrites: 0 } })).toBe(false)
    expect(reviewNeedsAcknowledgment({ ...freshReview(), counts: { originalsAffected: 0, overwrites: 3 } })).toBe(true)
    expect(reviewAwaitsAcknowledgment({ ...freshReview(), counts: { originalsAffected: 20, overwrites: 0 } })).toBe(true)
    expect(reviewAwaitsAcknowledgment({ ...freshReview(), counts: { originalsAffected: 20, overwrites: 0 }, acknowledged: true })).toBe(false)
  })

  it('stays checked across refreshes while both counts are unchanged', () =>
  {
    const view = store()
    expect(view.getState().receiveReport({ reportId: 'r1', originalsAffected: 20, overwrites: 3 })).toBeNull()
    view.getState().setAcknowledged(true)
    expect(view.getState().receiveReport({ reportId: 'r2', originalsAffected: 20, overwrites: 3 })).toBeNull()
    expect(view.getState().receiveReport({ reportId: 'r3', originalsAffected: 20, overwrites: 3 })).toBeNull()
    expect(view.getState().review).toMatchObject({ reportId: 'r3', counts: { originalsAffected: 20, overwrites: 3 }, acknowledged: true, notice: null })
  })

  it('unchecks with the reason when a count changes', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 20, overwrites: 3 })
    view.getState().setAcknowledged(true)
    const notice = view.getState().receiveReport({ reportId: 'r2', originalsAffected: 22, overwrites: 3 })
    expect(notice).toBe('The number of originals changed to 22; confirm again.')
    expect(view.getState().review).toMatchObject({ reportId: 'r2', acknowledged: false, notice })
    expect(view.getState().receiveReport({ reportId: 'r3', originalsAffected: 22, overwrites: 4 })).toBe('The number of existing files replaced changed to 4; confirm again.')
    view.getState().setAcknowledged(true)
    expect(view.getState().review.notice).toBeNull()
  })

  it('stays quiet when a count changes before the user ever checked it', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 20, overwrites: 0 })
    expect(view.getState().receiveReport({ reportId: 'r2', originalsAffected: 21, overwrites: 0 })).toBeNull()
    expect(view.getState().review).toMatchObject({ acknowledged: false, notice: null })
  })

  it('drops the acknowledgment and notice once nothing needs confirming', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 2, overwrites: 0 })
    view.getState().setAcknowledged(true)
    expect(view.getState().receiveReport({ reportId: 'r2', originalsAffected: 0, overwrites: 0 })).toBeNull()
    expect(view.getState().review).toMatchObject({ acknowledged: false, notice: null })
    view.getState().setAcknowledged(true)
    view.getState().receiveReport({ reportId: 'r3', originalsAffected: 0, overwrites: 0 })
    expect(view.getState().review.acknowledged).toBe(false)
  })

  it('names both counts when both change', () =>
  {
    expect(countChangeNotice({ originalsAffected: 20, overwrites: 3 }, { originalsAffected: 1200, overwrites: 5 })).toBe('The number of originals changed to 1,200 and the number of existing files replaced changed to 5; confirm again.')
  })

  it('unchecks by the user without a notice and ignores repeats', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 2, overwrites: 0 })
    const session = view.getState().review
    view.getState().setAcknowledged(false)
    expect(view.getState().review).toBe(session)
    view.getState().setAcknowledged(true)
    view.getState().setAcknowledged(false)
    expect(view.getState().review).toMatchObject({ acknowledged: false, notice: null })
  })

  it('restarts the session when the subset changes, and not when it is the same', () =>
  {
    const view = store()
    view.getState().receiveReport({ reportId: 'r1', originalsAffected: 2, overwrites: 0 })
    view.getState().setAcknowledged(true)
    view.getState().setReviewSubset(null)
    expect(view.getState().review.acknowledged).toBe(true)
    view.getState().setReviewSubset(['MM-0001', 'MM-0002'])
    expect(view.getState().review).toEqual({ ...freshReview(), subset: ['MM-0001', 'MM-0002'] })
    const session = view.getState().review
    view.getState().setReviewSubset(['MM-0001', 'MM-0002'])
    expect(view.getState().review).toBe(session)
    view.getState().setReviewSubset(['MM-0001'])
    expect(view.getState().review.subset).toEqual(['MM-0001'])
    view.getState().setReviewSubset(null)
    expect(view.getState().review.subset).toBeNull()
    view.getState().receiveReport({ reportId: 'r9', originalsAffected: 1, overwrites: 1 })
    view.getState().resetReview()
    expect(view.getState().review).toEqual(freshReview())
  })
})

describe('History', () =>
{
  it('switches between the batch list, the search results, and an opened batch', () =>
  {
    const view = store()
    const key = (): ReturnType<typeof activeViewKey> => activeViewKey(view.getState())
    expect(key()).toBe('queue')
    view.getState().setMode('history')
    expect(key()).toBe('history')
    view.getState().select('history', { type: 'click', id: 'R-0029' })
    view.getState().setHistoryQuery('  ')
    expect(key()).toBe('history')
    view.getState().setHistoryQuery('interview')
    expect(key()).toBe('historyResults')
    view.getState().select('historyResults', { type: 'click', id: 'MM-0131' })
    view.getState().openHistoryBatch('R-0029', 'MM-0131')
    expect(key()).toBe('historyBatch')
    const opened = view.getState().views.historyBatch.selection
    expect([...opened.selected]).toEqual(['MM-0131'])
    expect(opened.focus).toBe('MM-0131')
    view.getState().closeHistoryBatch()
    expect(key()).toBe('historyResults')
    expect([...view.getState().views.historyResults.selection.selected]).toEqual(['MM-0131'])
    view.getState().setHistoryQuery('')
    expect(key()).toBe('history')
    expect([...view.getState().views.history.selection.selected]).toEqual(['R-0029'])
  })

  it('opens a batch from anywhere into History, with nothing selected when no job is named', () =>
  {
    const view = store()
    view.getState().openHistoryBatch('R-0031')
    expect(view.getState().mode).toBe('history')
    expect(view.getState().history.openRunId).toBe('R-0031')
    expect(view.getState().views.historyBatch.selection.selected.size).toBe(0)
    const history = view.getState().history
    view.getState().closeHistoryBatch()
    view.getState().closeHistoryBatch()
    expect(view.getState().history).toEqual({ ...history, openRunId: null })
  })

  it('closes an opened batch and starts the results at the top on a new search', () =>
  {
    const view = store()
    view.getState().setHistoryQuery('a')
    view.getState().setScroll('historyResults', 200)
    view.getState().openHistoryBatch('R-0002')
    view.getState().setHistoryQuery('ab')
    expect(view.getState().history).toEqual({ query: 'ab', openRunId: null })
    expect(view.getState().views.historyResults.scrollTop).toBe(0)
    const history = view.getState().history
    view.getState().setHistoryQuery('ab')
    expect(view.getState().history).toBe(history)
  })
})

describe('mode rows', () =>
{
  function jobsState(jobs: JobView[], run: JobsState['run'] = null): JobsState
  {
    return { order: jobs.map((entry) => entry.id), jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])), run } as unknown as JobsState
  }

  const jobs = [
    job('MM-0001', { state: 'done', runId: 'R-0001' as JobView['runId'] }),
    job('MM-0002', { state: 'queued', runId: 'R-0002' as JobView['runId'] }),
    job('MM-0003'),
    job('MM-0004', { state: 'failed', runId: 'R-0002' as JobView['runId'] })
  ]

  it('gives Queue every job, Review the pending ones, and History none', () =>
  {
    const state = jobsState(jobs)
    expect(modeRows('queue', state).map((row) => row.id)).toEqual(['MM-0001', 'MM-0002', 'MM-0003', 'MM-0004'])
    expect(modeRows('review', state).map((row) => row.id)).toEqual(['MM-0003'])
    expect(modeRows('history', state)).toEqual([])
  })

  it('gives Run the current batch, or the last one when none runs', () =>
  {
    expect(modeRows('run', jobsState(jobs)).map((row) => row.id)).toEqual(['MM-0002', 'MM-0004'])
    expect(modeRows('run', jobsState(jobs, { runId: 'R-0001' } as unknown as JobsState['run'])).map((row) => row.id)).toEqual(['MM-0001'])
    expect(modeRows('run', jobsState([job('MM-0009')]))).toEqual([])
  })
})
