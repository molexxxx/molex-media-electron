/**
 * The Batch page's job table: one of the engine's job lists (Queue, Review, or Run) on the DataGrid, in the queue
 * order the snapshot gives, with the list's own selection, sort, filters, hidden columns, and row density from the
 * batch view. Rows carry only job ids and each cell reads its own job, so a progress event re-renders the one row
 * it changes. The page owns the commands: key commands, the row menu, moves, and the quick buttons.
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { JobView } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import { countOf, REGION_NAMES } from '../../../copy/batch'
import type { BatchFilters, FilterContext } from '../../../stores/batchFilters'
import { modeRows, useBatchView, visibleIds } from '../../../stores/batchView'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { selectHydrated, selectJob, selectRunStatus } from '../../../stores/jobsSelectors'
import { cx } from '../../../ui/cx'
import { DataGrid, type GridCellContext, type GridColumn, type GridDensity, type GridMoveTo, type GridSort } from '../../../ui/DataGrid'
import { usePlatform } from '../../../ui/Kbd'
import type { MenuEntry } from '../../../ui/Menu'
import type { GridSelectionAction, GridSelectionState } from '../../../ui/useGridSelection'
import { albumLetter, JobCell, planPending, usePlanChecking, type QuickAction } from './cells'
import { jobColumns, NARROW_TABLE_WIDTH, sortKey, type JobRow } from './columns'

/** The lists the job table shows; History's lists come from its own records. */
export type JobListKey = 'queue' | 'review' | 'run'

/** What the unsorted order is called in the sort cycle's last announcement and in the reorder reason. */
export const QUEUE_ORDER_LABEL = 'queue order'

/** Why the move items are disabled while a column sort is active. */
export const REORDER_SORTED_REASON = 'Sort by queue order to reorder.'

/** Props for {@link JobTable}. */
export interface JobTableProps
{
  list: JobListKey
  /** The grid's accessible name, "Jobs" by default. */
  label?: string
  /** Words the Recycle Bin step and keys for the platform; the shell's PlatformProvider decides when omitted. */
  platform?: Platform
  /** The row menu's own entries, ahead of the move items; the More actions button opens the same menu. */
  rowMenu?: (job: JobView) => MenuEntry[]
  /** The page's command keys while a row has focus (Space, Delete, Ctrl+C, and the rest); true when handled. */
  onKeyCommand?: (event: KeyboardEvent, focusedId: string | null) => boolean
  /** Enter on a row, which opens the inspector. */
  onOpen?: (id: string) => void
  /** Moves rows in queue order; omitted where the list cannot reorder. */
  onMoveRows?: (ids: string[], to: GridMoveTo) => void
  /** Moves jobs dragged with the pointer before another job, or to the end. */
  onDropRows?: (ids: string[], before: string | null) => void
  /** Run's quick buttons at priority 3 widths (Cancel job, Skip, Acknowledge); omitted, Run shows only More actions. */
  onQuickAction?: (action: QuickAction, job: JobView) => void
  /** Jobs this window asked to stop that main has not settled yet; their Status reads "Stopping". */
  stopping?: ReadonlySet<string>
  /** What the list's filters read, such as the preset lookup that decides Edited. */
  filterContext?: FilterContext
  className?: string
}

interface TableSettings
{
  list: JobListKey
  platform: Platform
  replaceMode: boolean
  stopping: ReadonlySet<string>
  albums: ReadonlyMap<string, string>
  rowMenu?: (job: JobView) => MenuEntry[]
  onQuickAction?: (action: QuickAction, job: JobView) => void
}

const NONE: ReadonlySet<string> = new Set()

const TableContext = createContext<TableSettings>({ list: 'queue', platform: 'win32', replaceMode: false, stopping: NONE, albums: new Map() })

function jobIn(state: JobsState, id: string): JobView | null
{
  return Object.hasOwn(state.jobs, id) ? state.jobs[id as JobId] : null
}

function lookup(id: string): JobView | null
{
  return jobIn(useJobsStore.getState(), id)
}

function sameIds(a: readonly string[], b: readonly string[]): boolean
{
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** The album groups in queue order, joined, so the letters change only when the groups do. */
function selectAlbumOrder(state: JobsState): string
{
  const seen = new Set<string>()
  for (const id of state.order)
  {
    const group = jobIn(state, id)?.albumGroupId ?? null
    if (group !== null)
    {
      seen.add(group)
    }
  }
  return [...seen].join('\u0000')
}

function selectReplaceMode(state: JobsState): boolean
{
  return state.policy?.destination.mode === 'replace-originals'
}

function selectRunning(state: JobsState): boolean
{
  return selectRunStatus(state) !== 'idle'
}

/** The ids a list shows after its filters, in queue order; the same array until the ids or their order change. */
function useListIds(list: JobListKey, filters: BatchFilters, context: FilterContext | undefined): readonly string[]
{
  const cache = useRef<readonly string[]>([])
  const select = useCallback((state: JobsState): readonly string[] =>
  {
    const next = visibleIds(modeRows(list, state), filters, context)
    if (sameIds(cache.current, next))
    {
      return cache.current
    }
    cache.current = next
    return next
  }, [list, filters, context])
  return useJobsStore(select)
}

/** The sorted column's values joined, so a sorted list re-sorts when a value it sorts by changes. */
function useSortValues(ids: readonly string[], sort: GridSort | null, list: JobListKey, platform: Platform): string
{
  const select = useCallback((state: JobsState): string =>
  {
    if (sort === null)
    {
      return ''
    }
    return ids.map((id) =>
    {
      const job = jobIn(state, id)
      return job === null ? '' : String(sortKey(sort.column, job, list, platform) ?? '')
    }).join('\u0000')
  }, [ids, sort, list, platform])
  return useJobsStore(select)
}

/** Whether the element is narrower than {@link NARROW_TABLE_WIDTH}; a hidden element (0 px) never counts as narrow. */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean
{
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined')
    {
      return undefined
    }
    const observer = new ResizeObserver((entries) =>
    {
      const entry = entries[entries.length - 1]
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
      setNarrow(width > 0 && width < NARROW_TABLE_WIDTH)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

/** Row objects for the ids, one per id for as long as it shows; a new array when the sorted values change, so the grid sorts again. */
function useRows(ids: readonly string[], sortValues: string): JobRow[]
{
  const cache = useRef(new Map<string, JobRow>())
  return useMemo(() =>
  {
    const rows = ids.map((id) => cache.current.get(id) ?? { id })
    cache.current = new Map(rows.map((row) => [row.id, row]))
    return rows
  }, [ids, sortValues])
}

function menuEntries(own: MenuEntry[], moves: MenuEntry[]): MenuEntry[]
{
  if (own.length === 0 || moves.length === 0)
  {
    return [...own, ...moves]
  }
  return [...own, 'separator', ...moves]
}

interface RowCellProps
{
  id: string
  column: string
  selected: boolean
  /** Only the actions cell takes the grid's move items, so every other cell keeps equal props between renders. */
  moveItems?: () => MenuEntry[]
}

/** One cell subscribed to its own job, so a change to one job re-renders only that job's cells. */
const JobRowCell = memo(function JobRowCell({ id, column, selected, moveItems }: RowCellProps): ReactNode
{
  const table = useContext(TableContext)
  const select = useMemo(() => selectJob(id as JobId), [id])
  const job = useJobsStore(select)
  const checking = usePlanChecking(job !== null && (column === 'status' || column === 'plan') && planPending(job))
  if (job === null)
  {
    return null
  }
  const menuItems = column === 'actions' ? () => menuEntries(table.rowMenu?.(job) ?? [], moveItems?.() ?? []) : undefined
  return (
    <JobCell
      job={job}
      column={column}
      selected={selected}
      platform={table.platform}
      inRunMode={table.list === 'run'}
      checking={checking}
      stopping={table.stopping.has(id)}
      replaceMode={table.replaceMode}
      album={job.albumGroupId === null ? null : table.albums.get(job.albumGroupId) ?? null}
      menuItems={menuItems}
      onQuickAction={table.onQuickAction}
    />
  )
})

function renderCell(row: JobRow, column: GridColumn<JobRow>, context: GridCellContext): ReactNode
{
  return <JobRowCell id={row.id} column={column.id} selected={context.selected} moveItems={column.id === 'actions' ? context.moveItems : undefined} />
}

function rowLabel(row: JobRow): string
{
  return row.id
}

function countLabel(count: number): string
{
  return countOf(count, 'job')
}

const TYPEAHEAD = { columnId: 'file', text: (row: JobRow): string => lookup(row.id)?.source.name ?? '' }

/** One job list of the Batch page as a DataGrid. */
export function JobTable(props: JobTableProps): ReactElement
{
  const { list, rowMenu, onQuickAction } = props
  const shellPlatform = usePlatform()
  const platform = props.platform ?? shellPlatform
  const stopping = props.stopping ?? NONE
  const view = useBatchView((state) => state.views[list])
  const hidden = useBatchView((state) => state.prefs.hiddenColumns[list])
  const compact = useBatchView((state) => state.prefs.compactRows)
  const hydrated = useJobsStore(selectHydrated)
  const running = useJobsStore(selectRunning)
  const replaceMode = useJobsStore(selectReplaceMode)
  const albumOrder = useJobsStore(selectAlbumOrder)
  const ids = useListIds(list, view.filters, props.filterContext)
  const sortValues = useSortValues(ids, view.sort, list, platform)

  const rows = useRows(ids, sortValues)
  const frame = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(frame)
  const quickActions = onQuickAction !== undefined
  const columns = useMemo(() => jobColumns(list, { lookup, platform, running, quickActions, narrow }), [list, platform, running, quickActions, narrow])

  const albums = useMemo(() => new Map(albumOrder.split('\u0000').filter((group) => group !== '').map((group, index) => [group, albumLetter(index)])), [albumOrder])
  const settings = useMemo<TableSettings>(() => ({ list, platform, replaceMode, stopping, albums, rowMenu, onQuickAction }), [list, platform, replaceMode, stopping, albums, rowMenu, onQuickAction])

  const synced = useRef<{ list: JobListKey, ids: readonly string[] } | null>(null)
  useEffect(() =>
  {
    if (!hydrated)
    {
      return
    }
    const previous = synced.current?.list === list ? synced.current.ids : undefined
    if (previous !== ids)
    {
      useBatchView.getState().syncRows(list, ids, previous)
    }
    synced.current = { list, ids }
  }, [hydrated, list, ids])

  const onSelectionChange = useCallback((_next: GridSelectionState, action: GridSelectionAction): void =>
  {
    useBatchView.getState().select(list, action)
  }, [list])
  const onSortChange = useCallback((sort: GridSort | null): void =>
  {
    useBatchView.getState().setSort(list, sort)
  }, [list])
  const onHiddenColumnsChange = useCallback((next: string[]): void =>
  {
    useBatchView.getState().setHiddenColumns(list, next)
  }, [list])
  const onDensityChange = useCallback((density: GridDensity): void =>
  {
    useBatchView.getState().setCompactRows(density === 'compact')
  }, [])
  const gridRowMenu = useMemo(() =>
  {
    if (rowMenu === undefined)
    {
      return undefined
    }
    return (row: JobRow): MenuEntry[] =>
    {
      const job = lookup(row.id)
      return job === null ? [] : rowMenu(job)
    }
  }, [rowMenu])

  return (
    <TableContext.Provider value={settings}>
      <div ref={frame} className={cx('flex min-h-0 min-w-0 flex-col', props.className)} data-part="job-table">
        <DataGrid<JobRow>
          label={props.label ?? REGION_NAMES.jobs}
          rows={rows}
          columns={columns}
          hiddenColumns={hidden}
          onHiddenColumnsChange={onHiddenColumnsChange}
          selected={view.selection}
          onSelectionChange={onSelectionChange}
          sort={view.sort}
          onSortChange={onSortChange}
          unsortedLabel={QUEUE_ORDER_LABEL}
          reorderDisabledReason={REORDER_SORTED_REASON}
          onOpen={props.onOpen}
          onMoveRows={props.onMoveRows}
          onDropRows={props.onDropRows}
          rowLabel={rowLabel}
          countLabel={countLabel}
          typeahead={TYPEAHEAD}
          onKeyCommand={props.onKeyCommand}
          density={compact ? 'compact' : 'default'}
          onDensityChange={onDensityChange}
          renderCell={renderCell}
          rowMenu={gridRowMenu}
          loading={!hydrated}
          className="min-h-0 flex-1"
        />
      </div>
    </TableContext.Provider>
  )
}
