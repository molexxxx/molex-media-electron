import { useLayoutEffect, useReducer, useRef, type Dispatch } from 'react'

/**
 * A grid's selection: the selected row ids, the anchor that Shift ranges extend from, and the focused row.
 * The set is never mutated; every change makes a new one.
 */
export interface GridSelectionState
{
  selected: Set<string>
  anchor: string | null
  focus: string | null
}

/** Where a key moves focus: one row, one visible page, or the first or last row. */
export type GridMove = 'next' | 'previous' | 'pageNext' | 'pagePrevious' | 'first' | 'last'

/** How a key treats the selection: plain keys select the target, Shift extends from the anchor, Ctrl moves focus only. */
export type GridKeyMode = 'select' | 'extend' | 'focus'

/** Rows a page key moves when the grid has not measured how many rows its viewport shows. */
export const GRID_PAGE_ROWS = 10

/**
 * What the reducer understands. Range actions carry `ids`, the rows in their displayed order. A `key` action
 * names a `move` from the focused row or, for typeahead, the row `id` focus lands on.
 */
export type GridSelectionAction =
  | { type: 'click', id: string }
  | { type: 'ctrlClick', id: string }
  | { type: 'shiftClick', id: string, ids: readonly string[] }
  | { type: 'ctrlShiftClick', id: string, ids: readonly string[] }
  | { type: 'toggle', id?: string }
  | { type: 'key', move: GridMove, mode?: GridKeyMode, ids: readonly string[], page?: number }
  | { type: 'key', id: string, mode?: GridKeyMode, ids: readonly string[] }
  | { type: 'selectAll', ids: readonly string[] }
  | { type: 'clear' }
  | { type: 'sync', ids: readonly string[], previous?: readonly string[] }

/** A selection holding `selected`, with focus and the anchor on `focus`. */
export function createGridSelection(selected: Iterable<string> = [], focus: string | null = null): GridSelectionState
{
  return { selected: new Set(selected), anchor: focus, focus }
}

/**
 * The row a move lands on, or null for an empty grid. Moves stop at the ends rather than wrap; without a
 * focused row in `ids`, `last` lands on the last row and every other move on the first.
 */
export function gridMoveTarget(ids: readonly string[], focus: string | null, move: GridMove, page: number = GRID_PAGE_ROWS): string | null
{
  if (ids.length === 0)
  {
    return null
  }
  const last = ids.length - 1
  const index = focus === null ? -1 : ids.indexOf(focus)
  if (index < 0)
  {
    return move === 'last' ? ids[last] : ids[0]
  }
  const step = Math.max(1, Math.floor(page))
  switch (move)
  {
    case 'next':
      return ids[Math.min(index + 1, last)]
    case 'previous':
      return ids[Math.max(index - 1, 0)]
    case 'pageNext':
      return ids[Math.min(index + step, last)]
    case 'pagePrevious':
      return ids[Math.max(index - step, 0)]
    case 'first':
      return ids[0]
    case 'last':
      return ids[last]
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean
{
  if (a.size !== b.size)
  {
    return false
  }
  for (const id of a)
  {
    if (!b.has(id))
    {
      return false
    }
  }
  return true
}

/** The next state, or `state` itself when nothing changed, so a store or component can skip the update. */
function settle(state: GridSelectionState, selected: Set<string>, anchor: string | null, focus: string | null): GridSelectionState
{
  if (state.anchor === anchor && state.focus === focus && sameSet(state.selected, selected))
  {
    return state
  }
  return { selected: sameSet(state.selected, selected) ? state.selected : selected, anchor, focus }
}

function toggled(selected: ReadonlySet<string>, id: string): Set<string>
{
  const next = new Set(selected)
  if (!next.delete(id))
  {
    next.add(id)
  }
  return next
}

function present(id: string | null, ids: readonly string[]): string | null
{
  return id !== null && ids.includes(id) ? id : null
}

/** The rows from `from` to `to` inclusive in displayed order; just `to` when either end is not shown. */
function rangeOf(ids: readonly string[], from: string, to: string): string[]
{
  const start = ids.indexOf(from)
  const end = ids.indexOf(to)
  if (start < 0 || end < 0)
  {
    return [to]
  }
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1)
}

/** Selects the range from the anchor (or the focused row when there is none) to `id`; `additive` keeps the rest. */
function extend(state: GridSelectionState, id: string, ids: readonly string[], additive: boolean): GridSelectionState
{
  const anchor = present(state.anchor, ids) ?? present(state.focus, ids) ?? id
  const range = rangeOf(ids, anchor, id)
  const selected = additive ? new Set([...state.selected, ...range]) : new Set(range)
  return settle(state, selected, anchor, id)
}

/** The surviving row nearest to a vanished one: the first after it in `previous`, else the last before it. */
function successor(id: string, previous: readonly string[], kept: ReadonlySet<string>): string | null
{
  const index = previous.indexOf(id)
  if (index < 0)
  {
    return null
  }
  const after = previous.slice(index + 1).find((candidate) => kept.has(candidate))
  if (after !== undefined)
  {
    return after
  }
  const before = previous.slice(0, index).reverse().find((candidate) => kept.has(candidate))
  return before ?? null
}

/** Drops ids that left the list from the selection and the anchor; a vanished focus moves to its successor. */
function sync(state: GridSelectionState, ids: readonly string[], previous: readonly string[] | undefined): GridSelectionState
{
  const kept = new Set(ids)
  const selected = new Set([...state.selected].filter((id) => kept.has(id)))
  const anchor = state.anchor !== null && kept.has(state.anchor) ? state.anchor : null
  let focus = state.focus
  if (focus !== null && !kept.has(focus))
  {
    focus = previous ? successor(focus, previous, kept) : null
  }
  return settle(state, selected, anchor, focus)
}

/**
 * The pure selection reducer behind a DataGrid, so selection logic is tested without a DOM. Click selects
 * one row; Ctrl+click and `toggle` flip one; Shift+click selects the range from the anchor, and
 * Ctrl+Shift+click adds it; `key` moves focus with the selection following, extending, or staying;
 * `selectAll` replaces the selection with the given rows; `clear` empties it and keeps focus; `sync` drops
 * rows that left the list. An action that changes nothing returns the same state object.
 */
export function gridSelectionReducer(state: GridSelectionState, action: GridSelectionAction): GridSelectionState
{
  switch (action.type)
  {
    case 'click':
      return settle(state, new Set([action.id]), action.id, action.id)
    case 'ctrlClick':
      return settle(state, toggled(state.selected, action.id), action.id, action.id)
    case 'shiftClick':
      return extend(state, action.id, action.ids, false)
    case 'ctrlShiftClick':
      return extend(state, action.id, action.ids, true)
    case 'toggle':
    {
      const id = action.id ?? state.focus
      return id === null ? state : settle(state, toggled(state.selected, id), id, id)
    }
    case 'key':
    {
      const target = 'move' in action ? gridMoveTarget(action.ids, state.focus, action.move, action.page) : action.id
      if (target === null)
      {
        return state
      }
      switch (action.mode ?? 'select')
      {
        case 'focus':
          return settle(state, state.selected, state.anchor, target)
        case 'extend':
          return extend(state, target, action.ids, false)
        default:
          return settle(state, new Set([target]), target, target)
      }
    }
    case 'selectAll':
      return settle(state, new Set(action.ids), state.anchor, state.focus)
    case 'clear':
      return settle(state, new Set(), state.focus, state.focus)
    case 'sync':
      return sync(state, action.ids, action.previous)
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean
{
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * Grid selection held in component state and kept in step with `ids`: rows that leave the list drop out of
 * the selection, and a focused row that leaves passes focus to its nearest surviving neighbor.
 */
export function useGridSelection(ids: readonly string[], initial?: GridSelectionState): [GridSelectionState, Dispatch<GridSelectionAction>]
{
  const [state, dispatch] = useReducer(gridSelectionReducer, initial ?? null, (start) => start ?? createGridSelection())
  const previous = useRef(ids)

  useLayoutEffect(() =>
  {
    if (!sameOrder(previous.current, ids))
    {
      dispatch({ type: 'sync', ids, previous: previous.current })
    }
    previous.current = ids
  }, [ids])

  return [state, dispatch]
}
