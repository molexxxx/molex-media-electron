import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode, type UIEvent } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import { useAnnounce } from './LiveRegion'
import { Menu, type MenuActionItem, type MenuCheckboxItem, type MenuEntry, type MenuHandle } from './Menu'
import { OverlayScrollbar } from './OverlayScrollbar'
import { GRID_FOCUS_DELAY_MS, Tooltip } from './Tooltip'
import { GRID_PAGE_ROWS, gridSelectionReducer, type GridMove, type GridSelectionAction, type GridSelectionState } from './useGridSelection'
import { VisuallyHidden } from './VisuallyHidden'

/** What a column holds: data, per-row IconButtons (24 px wide), or the pointer-only reorder grip. */
export type GridColumnKind = 'data' | 'actions' | 'grip'

/** Priority 1 columns always show; priority 2 and 3 need the grid widths in {@link GRID_PRIORITY_WIDTHS}. */
export type GridColumnPriority = 1 | 2 | 3

/** The direction of a column sort. */
export type GridSortDirection = 'ascending' | 'descending'

/** A column sort; no sort shows the rows in the order given. */
export interface GridSort
{
  column: string
  direction: GridSortDirection
}

/** Where the move keys and the row menu move the selected rows. */
export type GridMoveTo = 'up' | 'down' | 'top' | 'bottom'

/** Row height: 36 px by default, 30 px compact. */
export type GridDensity = 'default' | 'compact'

/** A status wash under a whole row, such as a failed line in a log; selection and hover still read over it. */
export type GridRowTone = 'error' | 'warning'

/** What a grid row needs: a stable id, such as a job id. */
export interface GridRowBase
{
  id: string
}

/** The value a column sorts by; strings compare with numeric collation, and empty values sort last. */
export type GridSortValue = string | number | null | undefined

/** One column of a {@link DataGrid}. */
export interface GridColumn<T extends GridRowBase = GridRowBase>
{
  id: string
  /** Sentence case; the header shows it as caption capitals. */
  label: string
  /**
   * A track size that does not depend on the cells, such as '96px' or 'minmax(160px, 1fr)': every cell is an
   * inline-size container. Actions columns are 24 px whatever is given.
   */
  width: string
  sortable?: boolean
  /** `end` right-aligns the cells in mono with tabular numerals. */
  align?: 'start' | 'end'
  priority?: GridColumnPriority
  /** Listed in the column menu, where the user can hide it. */
  optional?: boolean
  kind?: GridColumnKind
  /** The value a sortable column sorts by. */
  sortValue?: (row: T) => GridSortValue
  /** A full comparison for a sortable column, used instead of `sortValue`. */
  compare?: (a: T, b: T) => number
}

/** What `renderCell` receives besides the row and the column. */
export interface GridCellContext
{
  /** The row's position in the displayed order, from 0. */
  index: number
  selected: boolean
  focused: boolean
  /** Wires a row's More actions button to the grid's row menu. */
  menuButton: GridMenuButton
}

/**
 * The props a row's More actions button spreads: it opens the grid's own row menu under itself, the same menu a
 * right click and Shift+F10 open, so there is one menu per grid and it lives outside the rows.
 */
export interface GridMenuButton
{
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  onPointerDown: () => void
  onClick: (event: MouseEvent<HTMLElement>) => void
}

/** Props for {@link DataGrid}. */
export interface DataGridProps<T extends GridRowBase>
{
  /** The grid's accessible name. */
  label: string
  /** The rows in the order given, which is also the unsorted order (the batch view passes its queue order). */
  rows: readonly T[]
  columns: ReadonlyArray<GridColumn<T>>
  /** Optional columns the user hid; controlled, so the view can keep the choice per mode. */
  hiddenColumns: readonly string[]
  onHiddenColumnsChange: (hidden: string[]) => void
  /** What "Reset columns" restores; nothing hidden by default. */
  defaultHiddenColumns?: readonly string[]
  /** The selection, owned by the caller: a store keyed by row id, or {@link useGridSelection}. */
  selected: GridSelectionState
  onSelectionChange: (next: GridSelectionState, action: GridSelectionAction) => void
  sort?: GridSort | null
  onSortChange?: (sort: GridSort | null) => void
  /** Names the order given in announcements and reasons; "the order given" by default. */
  unsortedLabel?: string
  /** Opens the focused row, for example in the inspector. */
  onOpen?: (id: string) => void
  /** Moves rows in the order given; omitted when the view cannot reorder. */
  onMoveRows?: (ids: string[], to: GridMoveTo) => void
  /** Why the move items are disabled while sorted; "Sort by {unsortedLabel} to reorder." by default. */
  reorderDisabledReason?: string
  /** Moves rows dragged with the pointer before another row, or to the end when `before` is null; omitted when the view cannot reorder. */
  onDropRows?: (ids: string[], before: string | null) => void
  /** Names a row in announcements, such as its catalog number. */
  rowLabel: (row: T) => string
  /** How a count of rows reads in announcements ("3 jobs"); "3 rows" by default. */
  countLabel?: (count: number) => string
  typeahead?: { columnId: string, text: (row: T) => string }
  /** Receives the view's command keys while a row has focus; returns true when it handled the key. */
  onKeyCommand?: (event: KeyboardEvent, focusedId: string | null) => boolean
  density?: GridDensity
  /** Adds "Compact rows" to the column menu. */
  onDensityChange?: (density: GridDensity) => void
  renderCell: (row: T, column: GridColumn<T>, context: GridCellContext) => ReactNode
  /** The view's row menu entries, ahead of the move items. */
  rowMenu?: (row: T) => MenuEntry[]
  /** The view's row menu brings its own move items, so the grid adds none. */
  ownMoveItems?: boolean
  /** The row's tooltip, such as a truncated file name; an empty string shows none. */
  rowTooltip?: (row: T) => string
  /** A status wash for the row; none when it returns null or undefined. */
  rowTone?: (row: T) => GridRowTone | null | undefined
  /** Shows skeleton rows and marks the grid busy. */
  loading?: boolean
  /** Above this many rows only the rows near the viewport mount, plus the focused row. */
  virtualizeFrom?: number
  className?: string
}

/** Grid widths in px from which each column priority shows, measured on the grid itself. */
export const GRID_PRIORITY_WIDTHS: Readonly<Record<GridColumnPriority, number>> = { 1: 0, 2: 680, 3: 960 }

/** The typeahead buffer clears this long after the last key. */
export const GRID_TYPEAHEAD_RESET_MS = 500

/** Grids with more rows than this virtualize by default. */
export const GRID_VIRTUALIZE_FROM = 100

/** Rows mounted beyond each edge of the viewport while virtualized. */
export const GRID_OVERSCAN_ROWS = 8

/** The track size of an actions column. */
export const GRID_ACTIONS_WIDTH = '48px'

const ROW_HEIGHTS: Readonly<Record<GridDensity, number>> = { default: 36, compact: 30 }

const HEADER_HEIGHT = 32

const SKELETON_ROWS = 6

const COMMAND_NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

const FOCUS_KEYS: Readonly<Record<string, GridMove>> = {
  ArrowDown: 'next',
  ArrowUp: 'previous',
  PageDown: 'pageNext',
  PageUp: 'pagePrevious',
  Home: 'first',
  End: 'last'
}

const REORDER_KEYS: Readonly<Record<string, GridMoveTo>> = { ArrowDown: 'down', ArrowUp: 'up', End: 'bottom', Home: 'top' }

const FOCUSABLE = ['button', 'a[href]', 'input', 'select', 'textarea', '[contenteditable]:not([contenteditable="false"])', '[tabindex]']

const CELL_FOCUSABLE = FOCUSABLE.map((selector) => `[role="gridcell"] ${selector}`).join(', ')

const TEXT_EDITING = 'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="color"], [type="file"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

function sameOrder(a: readonly string[], b: readonly string[]): boolean
{
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** The columns that show: optional columns the user hid and columns whose priority needs a wider grid drop out. */
export function visibleGridColumns<T extends GridRowBase>(columns: ReadonlyArray<GridColumn<T>>, hidden: readonly string[], width: number | null): Array<GridColumn<T>>
{
  return columns.filter((column) => !(column.optional && hidden.includes(column.id)) && (width === null || width >= GRID_PRIORITY_WIDTHS[column.priority ?? 1]))
}

/** The `grid-template-columns` value the header and every row share. */
export function gridTemplate(columns: ReadonlyArray<Pick<GridColumn, 'width' | 'kind'>>): string
{
  return columns.map((column) => column.kind === 'actions' ? GRID_ACTIONS_WIDTH : column.width).join(' ')
}

/** The sort after a header activation: ascending, then descending, then back to the order given. */
export function nextGridSort(sort: GridSort | null | undefined, column: string): GridSort | null
{
  if (!sort || sort.column !== column)
  {
    return { column, direction: 'ascending' }
  }
  return sort.direction === 'ascending' ? { column, direction: 'descending' } : null
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function isEmpty(value: GridSortValue): value is null | undefined
{
  return value === null || value === undefined
}

function compareValues(a: string | number, b: string | number): number
{
  if (typeof a === 'number' && typeof b === 'number')
  {
    return a - b
  }
  return collator.compare(String(a), String(b))
}

/** The rows in display order. Sorting is stable, so ties keep the order given; empty values sort last both ways. */
export function sortGridRows<T extends GridRowBase>(rows: readonly T[], columns: ReadonlyArray<GridColumn<T>>, sort: GridSort | null | undefined): readonly T[]
{
  const column = sort ? columns.find((candidate) => candidate.id === sort.column) : undefined
  if (!sort || !column || (!column.compare && !column.sortValue))
  {
    return rows
  }
  const sign = sort.direction === 'ascending' ? 1 : -1
  const { compare, sortValue } = column
  if (compare)
  {
    return [...rows].sort((a, b) => sign * compare(a, b))
  }
  const value = sortValue as (row: T) => GridSortValue
  return [...rows].sort((a, b) =>
  {
    const left = value(a)
    const right = value(b)
    if (isEmpty(left) || isEmpty(right))
    {
      return Number(isEmpty(left)) - Number(isEmpty(right))
    }
    return sign * compareValues(left, right)
  })
}

/**
 * The order after moving `ids` within `order`. Up and down move each row one place unless a moving row
 * blocks it, so a contiguous run moves as one; top and bottom gather the rows in their current order.
 */
export function moveGridRows(order: readonly string[], ids: Iterable<string>, to: GridMoveTo): string[]
{
  const moving = new Set(ids)
  if (to === 'top' || to === 'bottom')
  {
    const picked = order.filter((id) => moving.has(id))
    const rest = order.filter((id) => !moving.has(id))
    return to === 'top' ? [...picked, ...rest] : [...rest, ...picked]
  }
  const next = [...order]
  const swap = (a: number, b: number): void =>
  {
    const held = next[a]
    next[a] = next[b]
    next[b] = held
  }
  if (to === 'up')
  {
    for (let i = 1; i < next.length; i++)
    {
      if (moving.has(next[i]) && !moving.has(next[i - 1]))
      {
        swap(i, i - 1)
      }
    }
  }
  else
  {
    for (let i = next.length - 2; i >= 0; i--)
    {
      if (moving.has(next[i]) && !moving.has(next[i + 1]))
      {
        swap(i, i + 1)
      }
    }
  }
  return next
}

/**
 * True for the keys a view receives through `onKeyCommand` while a row has focus: Space, Delete,
 * Shift+Delete, Alt with the top-row digits 1 to 9 (by `event.code`, with or without Shift; never the keypad,
 * since Windows types characters with Alt and keypad digits), Ctrl+V, Ctrl+D, Ctrl+C, F8, "?", and Alt with
 * the arrows, Home, and End.
 */
export function isGridCommand(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean
{
  const mod = event.ctrlKey || event.metaKey
  if (event.altKey)
  {
    return !mod && (/^Digit[1-9]$/.test(event.code) || COMMAND_NAVIGATION_KEYS.has(event.key))
  }
  if (mod)
  {
    return !event.shiftKey && ['c', 'd', 'v'].includes(event.key.toLowerCase())
  }
  switch (event.key)
  {
    case ' ':
    case 'F8':
      return !event.shiftKey
    case 'Delete':
    case '?':
      return true
    default:
      return false
  }
}

/** Shift+F10 or the Menu key, which open the row menu on a row and the column menu on a header cell. */
export function isMenuKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean
{
  if (event.altKey || event.ctrlKey || event.metaKey)
  {
    return false
  }
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/**
 * A div-based ARIA grid of selectable rows with sortable headers: one Tab stop with roving focus on rows,
 * selection owned by the caller through the {@link gridSelectionReducer} actions, column priorities by grid
 * width, typeahead, keyboard and menu reordering in the order given, and virtualization that keeps the
 * focused row mounted. No row is ever disabled; only unavailable actions are.
 */
export function DataGrid<T extends GridRowBase>(props: DataGridProps<T>): ReactElement
{
  const {
    label,
    rows,
    columns,
    hiddenColumns,
    selected,
    onSelectionChange,
    sort = null,
    density = 'default',
    loading = false,
    virtualizeFrom = GRID_VIRTUALIZE_FROM,
    className
  } = props

  const gridRef = useRef<HTMLDivElement>(null)
  const rowElements = useRef(new Map<string, HTMLDivElement>())
  const rowRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const propState = useRef(selected)
  const state = useRef(selected)
  const [width, setWidth] = useState<number | null>(null)
  const [viewport, setViewport] = useState(0)
  const [firstVisible, setFirstVisible] = useState(0)
  const [headerFocus, setHeaderFocus] = useState<string | null>(null)
  const idsRef = useRef<string[]>([])
  const previousIds = useRef<string[] | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const pointerFocus = useRef(false)
  const [drag, setDrag] = useState<GridDrag | null>(null)
  const dragEnded = useRef(false)
  const restoreAfterMove = useRef(false)
  const typed = useRef<{ buffer: string, timer: number | undefined }>({ buffer: '', timer: undefined })
  const rowAnchor = useRef<HTMLSpanElement>(null)
  const columnAnchor = useRef<HTMLSpanElement>(null)
  const rowMenu = useRef<MenuHandle>(null)
  const columnMenu = useRef<MenuHandle>(null)
  const menuOpen = useRef<'row' | 'column' | null>(null)
  const menuReturn = useRef<HTMLElement | null>(null)
  const [menuClosed, setMenuClosed] = useState(0)
  const [menuFor, setMenuFor] = useState<{ id: string, targets: string[] } | null>(null)
  const [menuEdge, setMenuEdge] = useState<'start' | 'end'>('start')
  const [rowMenuShownFor, setRowMenuShownFor] = useState<string | null>(null)
  const rowMenuId = useRef<string | null>(null)
  const pressedOpen = useRef(false)
  const announce = useAnnounce()

  if (propState.current !== selected)
  {
    propState.current = selected
    state.current = selected
  }

  const shown = useMemo(() => visibleGridColumns(columns, hiddenColumns, width), [columns, hiddenColumns, width])
  const displayed = useMemo(() => sortGridRows(rows, columns, sort), [rows, columns, sort])
  const ids = useMemo(() =>
  {
    const next = displayed.map((row) => row.id)
    if (sameOrder(next, idsRef.current))
    {
      return idsRef.current
    }
    idsRef.current = next
    return next
  }, [displayed])
  const rowHeight = ROW_HEIGHTS[density]
  const unsortedLabel = props.unsortedLabel ?? 'the order given'
  const reorderReason = props.reorderDisabledReason ?? `Sort by ${unsortedLabel} to reorder.`
  const headerIds = shown.filter((column) => column.kind !== 'grip').map((column) => column.id)
  const headerStop = headerFocus !== null && headerIds.includes(headerFocus)
    ? headerFocus
    : sort && headerIds.includes(sort.column) ? sort.column : headerIds[0] ?? null
  const virtual = !loading && displayed.length > virtualizeFrom
  const rowsShown = !loading && ids.length > 0
  const focusIndex = selected.focus === null ? -1 : ids.indexOf(selected.focus)
  const tabStop = focusIndex >= 0 ? ids[focusIndex] : ids[0] ?? null
  const pageRows = viewport > HEADER_HEIGHT ? Math.max(1, Math.floor((viewport - HEADER_HEIGHT) / rowHeight)) : GRID_PAGE_ROWS

  useLayoutEffect(() =>
  {
    const grid = gridRef.current as HTMLDivElement
    const measure = (inline: number, block: number): void =>
    {
      if (inline > 0)
      {
        setWidth(inline)
      }
      setViewport(block)
    }
    measure(grid.getBoundingClientRect().width, grid.clientHeight)
    const observer = new ResizeObserver((entries) =>
    {
      const entry = entries[entries.length - 1]
      const box = entry.borderBoxSize?.[0]
      measure(box ? box.inlineSize : entry.contentRect.width, grid.clientHeight || entry.contentRect.height)
    })
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  const dispatch = (action: GridSelectionAction): GridSelectionState =>
  {
    const previous = state.current
    const next = gridSelectionReducer(previous, action)
    if (next !== previous)
    {
      state.current = next
      onSelectionChange(next, action)
    }
    return next
  }

  /** Focuses without the browser's own scroll, then scrolls the nearest edge into view past the sticky header. */
  const focusElement = (element: HTMLElement): void =>
  {
    element.focus({ preventScroll: true })
    element.scrollIntoView({ block: 'nearest' })
  }

  /** Focuses a row now, or after the render that mounts it when virtualization left it out. */
  const focusRow = (id: string | null): void =>
  {
    if (id === null)
    {
      return
    }
    const element = rowElements.current.get(id)
    if (element)
    {
      focusElement(element)
    }
    else
    {
      pendingFocus.current = id
    }
  }

  /** Moves focus up from the first row onto the remembered, sorted, or first header cell; the sticky header never needs a scroll. */
  const focusHeader = (): void =>
  {
    const grid = gridRef.current as HTMLDivElement
    const items = Array.from(grid.querySelectorAll<HTMLElement>('[data-header-focus]'))
    items.find((item) => item.dataset.headerFocus === headerStop)?.focus({ preventScroll: true })
  }

  useLayoutEffect(() =>
  {
    const id = pendingFocus.current
    const element = id === null ? undefined : rowElements.current.get(id)
    if (element)
    {
      pendingFocus.current = null
      focusElement(element)
    }
    const grid = gridRef.current as HTMLDivElement
    for (const widget of grid.querySelectorAll<HTMLElement>(CELL_FOCUSABLE))
    {
      if (widget.tabIndex !== -1 && !widget.closest('[popover]'))
      {
        widget.tabIndex = -1
      }
    }
  })

  useLayoutEffect(() =>
  {
    const before = previousIds.current
    previousIds.current = ids
    if (before === null || before === ids)
    {
      return
    }
    dispatch({ type: 'sync', ids, previous: before })
    if (restoreAfterMove.current)
    {
      restoreAfterMove.current = false
      focusRow(state.current.focus)
    }
  }, [ids])

  useEffect(() => () => window.clearTimeout(typed.current.timer), [])

  /** The rows a move acts on: the selection in display order, or else the focused row. */
  const movingRows = (): string[] =>
  {
    const current = state.current
    const picked = ids.filter((id) => current.selected.has(id))
    if (picked.length > 0)
    {
      return picked
    }
    return current.focus !== null && ids.includes(current.focus) ? [current.focus] : []
  }

  const nameOf = (id: string): string =>
  {
    const row = displayed.find((candidate) => candidate.id === id)
    return row ? props.rowLabel(row) : id
  }

  /** Moves rows in the order given and announces where they landed; while sorted it only says why it cannot. */
  const moveRows = (targets: string[], to: GridMoveTo): void =>
  {
    const onMoveRows = props.onMoveRows
    if (!onMoveRows || targets.length === 0)
    {
      return
    }
    if (sort)
    {
      announce(reorderReason)
      return
    }
    const after = moveGridRows(ids, targets, to)
    if (sameOrder(after, ids))
    {
      return
    }
    restoreAfterMove.current = true
    onMoveRows(targets, to)
    announce(moveAnnouncement(after, targets, to, nameOf, countText))
  }

  const typeahead = (char: string): void =>
  {
    const text = props.typeahead?.text
    if (!text)
    {
      return
    }
    const buffer = typed.current
    window.clearTimeout(buffer.timer)
    buffer.buffer += char.toLowerCase()
    buffer.timer = window.setTimeout(() =>
    {
      buffer.buffer = ''
    }, GRID_TYPEAHEAD_RESET_MS)
    const target = typeaheadMatch(displayed, text, buffer.buffer, state.current.focus)
    if (target !== null)
    {
      focusRow(dispatch({ type: 'key', id: target, ids }).focus)
    }
  }

  /** Keys on a focused row: the view's commands first, then the grid's own table of keys. */
  const onRowKey = (event: ReactKeyboardEvent<HTMLDivElement>, element: HTMLElement, id: string): void =>
  {
    const native = event.nativeEvent
    if (props.onKeyCommand && isGridCommand(native) && props.onKeyCommand(native, id))
    {
      event.preventDefault()
      return
    }
    if (isMenuKey(event))
    {
      if (hasRowMenu)
      {
        event.preventDefault()
        openRowMenu(id, element, null, 'key')
      }
      return
    }
    const { key, shiftKey, altKey } = event
    const mod = event.ctrlKey || event.metaKey
    if (altKey)
    {
      const to = mod || shiftKey ? undefined : REORDER_KEYS[key]
      if (to)
      {
        event.preventDefault()
        moveRows(movingRows(), to)
      }
      return
    }
    const move = FOCUS_KEYS[key]
    if (move)
    {
      event.preventDefault()
      if (key === 'ArrowUp' && !shiftKey && !mod && ids[0] === id)
      {
        focusHeader()
        return
      }
      focusRow(dispatch({ type: 'key', move, mode: shiftKey ? 'extend' : mod ? 'focus' : 'select', ids, page: pageRows }).focus)
      return
    }
    if (key === ' ')
    {
      event.preventDefault()
      if (mod && !shiftKey)
      {
        dispatch({ type: 'toggle', id })
      }
      else if (shiftKey && !mod)
      {
        dispatch({ type: 'shiftClick', id, ids })
      }
      return
    }
    if (mod)
    {
      if (key.toLowerCase() === 'a' && !shiftKey)
      {
        event.preventDefault()
        dispatch({ type: 'selectAll', ids })
      }
      return
    }
    switch (key)
    {
      case 'Enter':
        if (props.onOpen && !shiftKey)
        {
          event.preventDefault()
          props.onOpen(id)
        }
        return
      case 'Escape':
        if (!popoverOpen(element.ownerDocument) && state.current.selected.size > 0)
        {
          event.preventDefault()
          dispatch({ type: 'clear' })
        }
        return
      case 'ArrowRight':
      case 'F2':
      {
        const widgets = rowWidgets(element)
        const target = key === 'F2' ? widgets.find((widget) => widget.matches(TEXT_EDITING)) : widgets[0]
        if (target)
        {
          event.preventDefault()
          target.focus()
        }
        return
      }
    }
    if (key.length === 1)
    {
      typeahead(key)
    }
  }

  /** Keys inside a cell widget: the widget keeps its own keys; Left and Right move between widgets and Escape returns to the row. */
  const onWidgetKey = (event: ReactKeyboardEvent<HTMLDivElement>, target: HTMLElement, element: HTMLElement): void =>
  {
    const { key } = event
    if (key === 'Escape')
    {
      event.preventDefault()
      focusElement(element)
      return
    }
    if (target.matches(TEXT_EDITING) || (key !== 'ArrowRight' && key !== 'ArrowLeft') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    {
      return
    }
    const widgets = rowWidgets(element)
    const cell = target.closest('[role="gridcell"]')
    const index = widgets.findIndex((widget) => widget === target || widget.contains(target))
    const current = index >= 0 ? index : widgets.findIndex((widget) => widget.closest('[role="gridcell"]') === cell)
    event.preventDefault()
    if (key === 'ArrowRight')
    {
      widgets[current + 1]?.focus()
    }
    else if (current > 0)
    {
      widgets[current - 1].focus()
    }
    else
    {
      focusElement(element)
    }
  }

  /** Header keys: roving focus across the header cells, and Down into the rows. */
  const onHeaderKey = (event: ReactKeyboardEvent<HTMLDivElement>, target: HTMLElement): void =>
  {
    const grid = gridRef.current as HTMLDivElement
    const items = Array.from(grid.querySelectorAll<HTMLElement>('[data-header-focus]'))
    const index = items.findIndex((item) => item === target || item.contains(target))
    if (isMenuKey(event))
    {
      event.preventDefault()
      openColumnMenu(items[index] ?? target, null)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    {
      return
    }
    let next: HTMLElement | undefined
    switch (event.key)
    {
      case 'ArrowRight':
        next = items[index + 1]
        break
      case 'ArrowLeft':
        next = items[index - 1]
        break
      case 'Home':
        next = items[0]
        break
      case 'End':
        next = items[items.length - 1]
        break
      case 'ArrowDown':
        if (rowsShown && tabStop !== null)
        {
          event.preventDefault()
          focusRow(tabStop)
        }
        return
    }
    if (next)
    {
      event.preventDefault()
      next.focus()
    }
  }

  /** One keydown handler at the grid; a key a primitive inside already consumed (`defaultPrevented`) is left alone. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void =>
  {
    pointerFocus.current = false
    if (event.defaultPrevented)
    {
      return
    }
    restoreAfterMove.current = false
    const target = event.target as HTMLElement
    if (target.closest('[data-part="head"]'))
    {
      onHeaderKey(event, target)
      return
    }
    const element = target.closest<HTMLElement>('[role="row"][data-row-id]')
    if (!element)
    {
      return
    }
    if (target === element)
    {
      onRowKey(event, element, element.dataset.rowId as string)
    }
    else
    {
      onWidgetKey(event, target, element)
    }
  }

  /** Focus entering a row or a widget inside one makes that row the focused row; a pointer focus waits for the click. */
  const onFocus = (event: FocusEvent<HTMLDivElement>): void =>
  {
    const target = event.target as HTMLElement
    const headerItem = target.closest<HTMLElement>('[data-header-focus]')
    if (headerItem)
    {
      setHeaderFocus(headerItem.dataset.headerFocus as string)
      return
    }
    const element = target.closest<HTMLElement>('[role="row"][data-row-id]')
    if (!element)
    {
      return
    }
    const fromPointer = pointerFocus.current
    pointerFocus.current = false
    const id = element.dataset.rowId as string
    if ((fromPointer && target === element) || id === state.current.focus)
    {
      return
    }
    dispatch({ type: 'key', id, mode: 'focus', ids })
  }

  const hasRowMenu = Boolean(props.rowMenu || props.onMoveRows)

  /** The rows a row's menu acts on: the whole selection when the row is in it, else the row alone. */
  const menuRowsFor = (id: string): string[] =>
  {
    const current = state.current
    return current.selected.has(id) ? ids.filter((rowId) => current.selected.has(rowId)) : [id]
  }

  /** "Move up", "Move down", "Move to top", and "Move to bottom" for `targets`, disabled at the ends and while sorted. */
  const moveItemsFor = (targets: string[]): MenuEntry[] =>
  {
    if (!props.onMoveRows || targets.length === 0)
    {
      return []
    }
    const item = (id: string, text: string, to: GridMoveTo, shortcut: string, end: string): MenuActionItem =>
    {
      const reason = sort ? reorderReason : sameOrder(moveGridRows(ids, targets, to), ids) ? end : undefined
      return { id, label: text, shortcut, disabled: reason !== undefined, disabledReason: reason, onSelect: () => moveRows(targets, to) }
    }
    return [{
      group: 'Move',
      items: [
        item('move-up', 'Move up', 'up', 'Alt+Up', 'Already at the top.'),
        item('move-down', 'Move down', 'down', 'Alt+Down', 'Already at the bottom.'),
        item('move-top', 'Move to top', 'top', 'Alt+Home', 'Already at the top.'),
        item('move-bottom', 'Move to bottom', 'bottom', 'Alt+End', 'Already at the bottom.')
      ]
    }]
  }

  /**
   * Places a menu's anchor at the pointer, or under `from` on the given edge, and opens the menu. A menu still open,
   * or light-dismissed by this very press, closes first and the new one opens on the next frame, so moving from one
   * row's menu to another's takes one press. `from` takes focus before the menu shows, because a popover returns
   * focus on hide to whatever held it when it showed, which after a move would be the previous row.
   */
  const openMenu = (kind: 'row' | 'column', from: HTMLElement, point: { x: number, y: number } | null, edge: 'start' | 'end', prepare?: () => void): void =>
  {
    const open = [rowMenu.current, columnMenu.current].filter((handle) => handle?.isOpen())
    if (open.length > 0)
    {
      open.forEach((handle) => handle?.close(false))
      requestAnimationFrame(() => openMenu(kind, from, point, edge, prepare))
      return
    }
    const anchor = (kind === 'row' ? rowAnchor : columnAnchor).current
    const handle = (kind === 'row' ? rowMenu : columnMenu).current
    const frame = anchor?.parentElement
    if (!anchor || !frame || !handle || !from.isConnected)
    {
      return
    }
    prepare?.()
    const box = frame.getBoundingClientRect()
    const rect = from.getBoundingClientRect()
    const at = point ?? { x: edge === 'end' ? rect.right : rect.left, y: rect.bottom }
    anchor.style.left = `${at.x - box.left}px`
    anchor.style.top = `${at.y - box.top}px`
    menuReturn.current = from
    if (from.ownerDocument.activeElement !== from)
    {
      from.focus({ preventScroll: true })
    }
    handle.open()
  }

  /**
   * Opens the row menu for `id`. A press on a row outside the selection selects it first, as a right click does in
   * a file manager, so the menu, the selection, and the inspector always name the same jobs; the keyboard keeps the
   * selection it has.
   */
  const openRowMenu = (id: string, from: HTMLElement, point: { x: number, y: number } | null, source: 'pointer' | 'button' | 'key'): void =>
  {
    if (!hasRowMenu)
    {
      return
    }
    openMenu('row', from, point, source === 'button' ? 'end' : 'start', () =>
    {
      if (source !== 'key' && !state.current.selected.has(id))
      {
        dispatch({ type: 'click', id })
      }
      rowMenuId.current = id
      setMenuFor({ id, targets: menuRowsFor(id) })
      setMenuEdge(source === 'button' ? 'end' : 'start')
    })
  }

  const openColumnMenu = (from: HTMLElement, point: { x: number, y: number } | null): void =>
  {
    openMenu('column', from, point, 'start')
  }

  const onMenuOpenChange = (kind: 'row' | 'column') => (open: boolean): void =>
  {
    menuOpen.current = open ? kind : null
    if (kind === 'row')
    {
      setRowMenuShownFor(open ? rowMenuId.current : null)
    }
    if (!open)
    {
      setMenuClosed((count) => count + 1)
    }
  }

  /** A row's More actions button: a press on the row whose menu is open closes it, any other press opens it there. */
  const menuButtonFor = (id: string): GridMenuButton => ({
    'aria-haspopup': 'menu',
    'aria-expanded': rowMenuShownFor === id,
    onPointerDown: () =>
    {
      pressedOpen.current = rowMenu.current?.isOpen() === true && rowMenuId.current === id
    },
    onClick: (event) =>
    {
      const wasOpen = event.detail === 0 ? rowMenu.current?.isOpen() === true && rowMenuId.current === id : pressedOpen.current
      pressedOpen.current = false
      if (wasOpen)
      {
        rowMenu.current?.close(false)
        return
      }
      openRowMenu(id, event.currentTarget, null, 'button')
    }
  })

  useLayoutEffect(() =>
  {
    const target = menuReturn.current
    if (menuClosed === 0 || !target)
    {
      return
    }
    menuReturn.current = null
    const active = target.ownerDocument.activeElement
    if (target.isConnected && (active === null || active === target.ownerDocument.body))
    {
      target.focus({ preventScroll: true })
    }
  }, [menuClosed])

  const pointOf = (event: MouseEvent): { x: number, y: number } | null => event.button === 2 ? { x: event.clientX, y: event.clientY } : null

  const onRowContextMenu = (event: MouseEvent<HTMLDivElement>, id: string): void =>
  {
    if (!hasRowMenu || insideWidget(event.target as Element, event.currentTarget))
    {
      return
    }
    event.preventDefault()
    const point = pointOf(event)
    openRowMenu(id, event.currentTarget, point, point ? 'pointer' : 'key')
  }

  const onHeaderContextMenu = (event: MouseEvent<HTMLDivElement>): void =>
  {
    const cell = (event.target as Element).closest('[role="columnheader"]')
    const from = cell?.matches('[data-header-focus]') ? cell : cell?.querySelector('[data-header-focus]')
    event.preventDefault()
    openColumnMenu((from ?? event.currentTarget) as HTMLElement, pointOf(event))
  }

  /** The grid's own menus sit beside the grid, where a right click or the Menu key must not raise the native menu. */
  const onFrameContextMenu = (event: MouseEvent<HTMLDivElement>): void =>
  {
    if (!(gridRef.current as HTMLDivElement).contains(event.target as Node))
    {
      event.preventDefault()
    }
  }

  const toggleColumn = (id: string): void =>
  {
    props.onHiddenColumnsChange(hiddenColumns.includes(id) ? hiddenColumns.filter((hidden) => hidden !== id) : [...hiddenColumns, id])
  }

  /** The column menu: optional columns as check items, then "Compact rows" and "Reset columns". */
  const columnEntries = (): MenuEntry[] =>
  {
    const entries: MenuEntry[] = []
    const optional = columns.filter((column) => column.optional)
    if (optional.length > 0)
    {
      entries.push({
        group: 'Columns',
        items: optional.map((column): MenuCheckboxItem =>
        {
          const checked = !hiddenColumns.includes(column.id)
          const narrow = width !== null && width < GRID_PRIORITY_WIDTHS[column.priority ?? 1]
          return {
            kind: 'checkbox',
            id: `column-${column.id}`,
            label: column.label,
            checked,
            description: checked && narrow ? 'Shows when the table is wider' : undefined,
            onSelect: () => toggleColumn(column.id)
          }
        })
      })
    }
    const onDensityChange = props.onDensityChange
    if (onDensityChange)
    {
      if (entries.length > 0)
      {
        entries.push('separator')
      }
      entries.push({
        kind: 'checkbox',
        id: 'compact-rows',
        label: 'Compact rows',
        checked: density === 'compact',
        onSelect: () => onDensityChange(density === 'compact' ? 'default' : 'compact')
      })
    }
    if (entries.length > 0)
    {
      entries.push('separator')
    }
    entries.push({ id: 'reset-columns', label: 'Reset columns', onSelect: () => props.onHiddenColumnsChange([...(props.defaultHiddenColumns ?? [])]) })
    return entries
  }

  const rowMenuEntries = (): MenuEntry[] =>
  {
    const row = menuFor ? displayed.find((candidate) => candidate.id === menuFor.id) : undefined
    if (!menuFor || !row)
    {
      return []
    }
    const own = props.rowMenu?.(row) ?? []
    const moves = props.ownMoveItems ? [] : moveItemsFor(menuFor.targets)
    return own.length > 0 && moves.length > 0 ? [...own, 'separator', ...moves] : [...own, ...moves]
  }

  const countText = props.countLabel ?? ((count: number) => `${count} rows`)
  const rowMenuLabel = !menuFor
    ? label
    : menuFor.targets.length > 1 ? `Actions for ${countText(menuFor.targets.length)}` : `Actions for ${nameOf(menuFor.id)}`

  const rowRef = (id: string): ((node: HTMLDivElement | null) => void) =>
  {
    let ref = rowRefs.current.get(id)
    if (!ref)
    {
      ref = (node) =>
      {
        if (node)
        {
          rowElements.current.set(id, node)
        }
        else
        {
          rowElements.current.delete(id)
          rowRefs.current.delete(id)
        }
      }
      rowRefs.current.set(id, ref)
    }
    return ref
  }

  const dropBefore = (clientY: number, moving: ReadonlySet<string>): string | null =>
  {
    for (const id of ids)
    {
      const element = rowElements.current.get(id)
      if (!element)
      {
        continue
      }
      const box = element.getBoundingClientRect()
      if (clientY < box.top + box.height / 2)
      {
        return moving.has(id) ? nextOutside(ids, id, moving) : id
      }
    }
    return null
  }

  const onRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string): void =>
  {
    const onDropRows = props.onDropRows
    if (!onDropRows || sort || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || insideWidget(event.target as Element, event.currentTarget))
    {
      return
    }
    const startX = event.clientX
    const startY = event.clientY
    const grid = gridRef.current
    let moving: string[] | null = null
    const move = (next: PointerEvent): void =>
    {
      if (moving === null)
      {
        if (Math.hypot(next.clientX - startX, next.clientY - startY) < DRAG_START_PX)
        {
          return
        }
        moving = selected.selected.has(id) ? ids.filter((candidate) => selected.selected.has(candidate)) : [id]
      }
      if (grid !== null)
      {
        const box = grid.getBoundingClientRect()
        if (next.clientY < box.top + HEADER_HEIGHT + DRAG_EDGE_PX)
        {
          grid.scrollTop -= DRAG_SCROLL_PX
        }
        else if (next.clientY > box.bottom - DRAG_EDGE_PX)
        {
          grid.scrollTop += DRAG_SCROLL_PX
        }
      }
      setDrag({ ids: moving, before: dropBefore(next.clientY, new Set(moving)), x: next.clientX, y: next.clientY })
    }
    const finish = (commit: boolean): void =>
    {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', key, true)
      setDrag((current) =>
      {
        if (commit && current !== null && !sameOrder(dropOrder(ids, current.ids, current.before), ids))
        {
          onDropRows(current.ids, current.before)
        }
        return null
      })
      if (moving !== null)
      {
        dragEnded.current = true
      }
    }
    const up = (): void => finish(true)
    const key = (next: KeyboardEvent): void =>
    {
      if (next.key === 'Escape' && moving !== null)
      {
        next.preventDefault()
        next.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', key, true)
  }

  const onRowClick = (event: MouseEvent<HTMLDivElement>, id: string): void =>
  {
    pointerFocus.current = false
    const element = event.currentTarget
    if (dragEnded.current)
    {
      dragEnded.current = false
      return
    }
    if (insideWidget(event.target as Element, element))
    {
      return
    }
    const mod = event.ctrlKey || event.metaKey
    if (event.shiftKey)
    {
      dispatch({ type: mod ? 'ctrlShiftClick' : 'shiftClick', id, ids })
    }
    else
    {
      dispatch({ type: mod ? 'ctrlClick' : 'click', id })
    }
    if (!element.contains(element.ownerDocument.activeElement))
    {
      element.focus({ preventScroll: true })
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void =>
  {
    pointerFocus.current = (event.target as Element).closest('[role="row"][data-row-id]') !== null
  }

  const cycleSort = (column: GridColumn<T>): void =>
  {
    const next = nextGridSort(sort, column.id)
    props.onSortChange?.(next)
    announce(next ? `Sorted by ${column.label}, ${next.direction}.` : `Back to ${unsortedLabel}.`)
  }

  const onScroll = (event: UIEvent<HTMLDivElement>): void =>
  {
    if (virtual)
    {
      setFirstVisible(Math.floor(event.currentTarget.scrollTop / rowHeight))
    }
  }

  const cellContext = (row: T, index: number, isSelected: boolean): GridCellContext => ({
    index,
    selected: isSelected,
    focused: row.id === selected.focus,
    menuButton: menuButtonFor(row.id)
  })

  const renderRow = (row: T, index: number): ReactElement =>
  {
    const isSelected = selected.selected.has(row.id)
    const context = cellContext(row, index, isSelected)
    const element = (
      <div
        key={row.id}
        ref={rowRef(row.id)}
        role="row"
        aria-selected={isSelected}
        aria-rowindex={virtual ? index + 2 : undefined}
        tabIndex={row.id === tabStop ? 0 : -1}
        data-row-id={row.id}
        data-tone={props.rowTone?.(row) ?? undefined}
        data-dragging={drag !== null && drag.ids.includes(row.id) ? '' : undefined}
        data-drop-before={drag !== null && drag.before === row.id ? '' : undefined}
        data-drop-after={drag !== null && drag.before === null && index === displayed.length - 1 ? '' : undefined}
        className="ui-grid-row"
        onPointerDown={(event) => onRowPointerDown(event, row.id)}
        onClick={(event) => onRowClick(event, row.id)}
        onContextMenu={(event) => onRowContextMenu(event, row.id)}
      >
        {shown.map((column) => (
          <div
            key={column.id}
            role="gridcell"
            className="ui-grid-cell"
            data-kind={column.kind ?? 'data'}
            data-align={column.align ?? 'start'}
            aria-hidden={column.kind === 'grip' || undefined}
          >
            {column.kind === 'grip'
              ? props.onMoveRows && !sort && <span className="ui-grid-grip"><Icon name="action.reorder" size="sm" /></span>
              : props.renderCell(row, column, context)}
          </div>
        ))}
      </div>
    )
    if (!props.rowTooltip)
    {
      return element
    }
    return <Tooltip key={row.id} content={props.rowTooltip(row)} focusDelay={GRID_FOCUS_DELAY_MS} mode="label" inside>{element}</Tooltip>
  }

  const mounted: number[] = []
  if (virtual)
  {
    const start = Math.max(0, firstVisible - GRID_OVERSCAN_ROWS)
    const end = Math.min(displayed.length - 1, firstVisible + pageRows + GRID_OVERSCAN_ROWS)
    const kept = new Set<number>()
    for (let index = start; index <= end; index++)
    {
      kept.add(index)
    }
    const stopIndex = tabStop === null ? -1 : ids.indexOf(tabStop)
    if (stopIndex >= 0)
    {
      kept.add(stopIndex)
    }
    mounted.push(...[...kept].sort((a, b) => a - b))
  }
  else if (!loading)
  {
    mounted.push(...displayed.map((_row, index) => index))
  }

  const body: ReactNode[] = []
  let previous = -1
  for (const index of mounted)
  {
    if (index - previous > 1)
    {
      body.push(<div key={`gap-${index}`} aria-hidden="true" className="ui-grid-gap" style={{ blockSize: (index - previous - 1) * rowHeight }} />)
    }
    body.push(renderRow(displayed[index], index))
    previous = index
  }
  if (virtual && previous < displayed.length - 1)
  {
    body.push(<div key="gap-end" aria-hidden="true" className="ui-grid-gap" style={{ blockSize: (displayed.length - 1 - previous) * rowHeight }} />)
  }

  const headerCell = (column: GridColumn<T>): ReactElement =>
  {
    const kind = column.kind ?? 'data'
    if (kind === 'grip')
    {
      return <div key={column.id} role="columnheader" aria-hidden="true" className="ui-grid-header-cell" data-kind="grip" />
    }
    const roving = { tabIndex: column.id === headerStop && !rowsShown ? 0 : -1, 'data-header-focus': column.id, 'data-focus': 'inset' }
    const align = column.align ?? 'start'
    if (kind === 'data' && column.sortable)
    {
      const direction = sort?.column === column.id ? sort.direction : undefined
      const icon = direction === 'ascending' ? 'action.sortAscending' : direction === 'descending' ? 'action.sortDescending' : 'action.sortNone'
      return (
        <div key={column.id} role="columnheader" aria-sort={direction} className="ui-grid-header-cell" data-kind={kind} data-align={align} data-sortable="">
          <button type="button" className="ui-grid-sort" data-sorted={direction ? '' : undefined} {...roving} onClick={() => cycleSort(column)}>
            <span>{column.label}</span>
            <Icon name={icon} size="sm" className="ui-grid-sort-icon" />
          </button>
        </div>
      )
    }
    return (
      <div key={column.id} role="columnheader" className="ui-grid-header-cell" data-kind={kind} data-align={align} {...roving}>
        {kind === 'actions' ? <VisuallyHidden>{column.label}</VisuallyHidden> : <span>{column.label}</span>}
      </div>
    )
  }

  return (
    <div className={cx('ui-grid-frame', className)} onContextMenu={onFrameContextMenu}>
      <div
        ref={gridRef}
        role="grid"
        aria-label={label}
        aria-multiselectable="true"
        aria-rowcount={virtual ? displayed.length + 1 : undefined}
        aria-busy={loading || undefined}
        className="ui-grid"
        data-density={density}
        data-dragging={drag !== null ? '' : undefined}
        style={{ '--ui-grid-columns': gridTemplate(shown) } as CSSProperties}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onPointerDown={onPointerDown}
      >
        <div role="rowgroup" className="ui-grid-head" data-part="head" onContextMenu={onHeaderContextMenu}>
          <div role="row" className="ui-grid-head-row" aria-rowindex={virtual ? 1 : undefined}>
            {shown.map(headerCell)}
          </div>
        </div>
        <div role="rowgroup" className="ui-grid-body" data-part="body">
          {loading
            ? Array.from({ length: SKELETON_ROWS }, (_item, index) => (
              <div key={index} aria-hidden="true" className="ui-grid-row ui-grid-skeleton">
                {shown.map((column) => <div key={column.id} className="ui-grid-cell" data-kind={column.kind ?? 'data'}><span className="ui-grid-skeleton-bar" /></div>)}
              </div>
            ))
            : body}
        </div>
      </div>
      <OverlayScrollbar target={gridRef} insetStart={HEADER_HEIGHT} />
      {drag !== null && (
        <div aria-hidden="true" className="ui-grid-drag-chip" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {`Move ${countText(drag.ids.length)}`}
        </div>
      )}
      {hasRowMenu && (
        <Menu
          handle={rowMenu}
          trigger={<span ref={rowAnchor} aria-hidden="true" className="ui-grid-menu-anchor" />}
          items={rowMenuEntries()}
          label={rowMenuLabel}
          align={menuEdge}
          onOpenChange={onMenuOpenChange('row')}
        />
      )}
      <Menu
        handle={columnMenu}
        trigger={<span ref={columnAnchor} aria-hidden="true" className="ui-grid-menu-anchor" />}
        items={columnEntries()}
        label="Column options"
        onOpenChange={onMenuOpenChange('column')}
      />
    </div>
  )
}

/** A pointer drag of rows: what moves, where it lands, and the pointer for the chip that follows it. */
interface GridDrag
{
  ids: string[]
  before: string | null
  x: number
  y: number
}

/** How far the pointer travels before a press on a row becomes a drag, and the edge band and step that scroll the grid while dragging. */
const DRAG_START_PX = 5
const DRAG_EDGE_PX = 28
const DRAG_SCROLL_PX = 12

/** The first row after `id` that is not being moved, or null at the end. */
function nextOutside(order: readonly string[], id: string, moving: ReadonlySet<string>): string | null
{
  for (let index = order.indexOf(id) + 1; index < order.length; index++)
  {
    if (!moving.has(order[index]))
    {
      return order[index]
    }
  }
  return null
}

/** The order after moving `moving`, in its relative order, before `before`, or to the end when it is null. */
export function dropOrder(order: readonly string[], moving: readonly string[], before: string | null): string[]
{
  const set = new Set(moving)
  const rest = order.filter((id) => !set.has(id))
  const kept = order.filter((id) => set.has(id))
  const at = before === null ? rest.length : rest.indexOf(before)
  return at < 0 ? [...order] : [...rest.slice(0, at), ...kept, ...rest.slice(at)]
}

const WIDGET_SELECTOR = 'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"]), [tabindex], [role="menu"], [popover]'

/** True when `target` sits inside a widget within the row, such as a cell's button or field. */
function insideWidget(target: Element, row: Element): boolean
{
  const widget = target.closest(WIDGET_SELECTOR)
  return widget !== null && widget !== row && row.contains(widget)
}

/** The focusable widgets of a row's cells in order, leaving out open overlays, hidden parts, and disabled controls. */
function rowWidgets(row: HTMLElement): HTMLElement[]
{
  return Array.from(row.querySelectorAll<HTMLElement>(CELL_FOCUSABLE))
    .filter((element) => !element.closest('[popover], [aria-hidden="true"], [inert]') && !element.matches(':disabled'))
}

/**
 * The row typeahead lands on. A single key, or one key repeated, cycles through the rows starting with it
 * after the focused row; a longer buffer matches from the focused row on.
 */
function typeaheadMatch<T extends GridRowBase>(rows: readonly T[], text: (row: T) => string, buffer: string, focus: string | null): string | null
{
  const repeated = [...buffer].every((char) => char === buffer[0])
  const needle = repeated ? buffer[0] : buffer
  const current = focus === null ? -1 : rows.findIndex((row) => row.id === focus)
  const start = repeated ? current + 1 : Math.max(current, 0)
  for (let step = 0; step < rows.length; step++)
  {
    const row = rows[(start + step) % rows.length]
    if (text(row).toLowerCase().startsWith(needle))
    {
      return row.id
    }
  }
  return null
}

/** The announcement for a move: "MM-0141 moved to position 3 of 12." or "3 jobs moved to positions 4 to 6 of 12." */
export function moveAnnouncement(after: readonly string[], moved: readonly string[], to: GridMoveTo, name: (id: string) => string, count: (count: number) => string): string
{
  const positions = moved.map((id) => after.indexOf(id) + 1).sort((a, b) => a - b)
  if (positions.length === 1)
  {
    return `${name(moved[0])} moved to position ${positions[0]} of ${after.length}.`
  }
  const first = positions[0]
  const last = positions[positions.length - 1]
  if (last - first + 1 === positions.length)
  {
    return `${count(positions.length)} moved to positions ${first} to ${last} of ${after.length}.`
  }
  return `${count(positions.length)} moved ${to === 'up' ? 'up' : 'down'} one position.`
}

/** True while a menu or popover shows; jsdom cannot parse `:popover-open`, so it reports none there. */
function popoverOpen(doc: Document): boolean
{
  try
  {
    return doc.querySelector('[popover]:not([popover="hint"]):popover-open') !== null
  }
  catch
  {
    return false
  }
}
