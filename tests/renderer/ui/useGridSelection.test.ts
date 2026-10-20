/**
 * The grid selection reducer: every action, ranges in displayed order, identity kept when nothing changes,
 * and `sync` dropping rows that left the list.
 */
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  createGridSelection,
  GRID_PAGE_ROWS,
  gridMoveTarget,
  gridSelectionReducer,
  useGridSelection,
  type GridSelectionAction,
  type GridSelectionState
} from '../../../src/renderer/src/ui/useGridSelection'

const IDS = ['a', 'b', 'c', 'd', 'e', 'f']

function state(selected: string[], anchor: string | null, focus: string | null): GridSelectionState
{
  return { selected: new Set(selected), anchor, focus }
}

function run(start: GridSelectionState, ...actions: GridSelectionAction[]): GridSelectionState
{
  return actions.reduce(gridSelectionReducer, start)
}

function sorted(selection: GridSelectionState): string[]
{
  return [...selection.selected].sort()
}

describe('createGridSelection', () =>
{
  it('starts empty with no anchor or focus', () =>
  {
    const empty = createGridSelection()
    expect(sorted(empty)).toEqual([])
    expect(empty.anchor).toBeNull()
    expect(empty.focus).toBeNull()
  })

  it('holds the given rows with focus and the anchor on the focused row', () =>
  {
    const start = createGridSelection(['b', 'c'], 'c')
    expect(sorted(start)).toEqual(['b', 'c'])
    expect(start.anchor).toBe('c')
    expect(start.focus).toBe('c')
  })
})

describe('gridMoveTarget', () =>
{
  it('moves one row and stops at the ends', () =>
  {
    expect(gridMoveTarget(IDS, 'c', 'next')).toBe('d')
    expect(gridMoveTarget(IDS, 'c', 'previous')).toBe('b')
    expect(gridMoveTarget(IDS, 'f', 'next')).toBe('f')
    expect(gridMoveTarget(IDS, 'a', 'previous')).toBe('a')
  })

  it('reaches the first and last rows', () =>
  {
    expect(gridMoveTarget(IDS, 'c', 'first')).toBe('a')
    expect(gridMoveTarget(IDS, 'c', 'last')).toBe('f')
  })

  it('moves by a page and clamps at the ends', () =>
  {
    expect(gridMoveTarget(IDS, 'a', 'pageNext', 2)).toBe('c')
    expect(gridMoveTarget(IDS, 'e', 'pagePrevious', 2)).toBe('c')
    expect(gridMoveTarget(IDS, 'e', 'pageNext', 4)).toBe('f')
    expect(gridMoveTarget(IDS, 'b', 'pagePrevious', 4)).toBe('a')
  })

  it('moves at least one row for a page smaller than one', () =>
  {
    expect(gridMoveTarget(IDS, 'b', 'pageNext', 0)).toBe('c')
    expect(gridMoveTarget(IDS, 'b', 'pagePrevious', 0.4)).toBe('a')
  })

  it('pages by the default row count when no page is measured', () =>
  {
    const many = Array.from({ length: 30 }, (_, index) => `r${index}`)
    expect(gridMoveTarget(many, 'r0', 'pageNext')).toBe(`r${GRID_PAGE_ROWS}`)
  })

  it('lands on the first row without a focused row, or the last for last', () =>
  {
    expect(gridMoveTarget(IDS, null, 'next')).toBe('a')
    expect(gridMoveTarget(IDS, null, 'previous')).toBe('a')
    expect(gridMoveTarget(IDS, 'gone', 'pageNext')).toBe('a')
    expect(gridMoveTarget(IDS, null, 'last')).toBe('f')
  })

  it('returns null for an empty grid', () =>
  {
    expect(gridMoveTarget([], 'a', 'next')).toBeNull()
  })
})

describe('gridSelectionReducer', () =>
{
  it('click selects one row and moves the anchor and focus to it', () =>
  {
    const next = run(state(['a', 'b'], 'a', 'b'), { type: 'click', id: 'd' })
    expect(sorted(next)).toEqual(['d'])
    expect(next.anchor).toBe('d')
    expect(next.focus).toBe('d')
  })

  it('ctrlClick toggles one row and keeps the rest', () =>
  {
    const added = run(state(['a'], 'a', 'a'), { type: 'ctrlClick', id: 'c' })
    expect(sorted(added)).toEqual(['a', 'c'])
    expect(added.anchor).toBe('c')
    expect(added.focus).toBe('c')
    const removed = run(added, { type: 'ctrlClick', id: 'a' })
    expect(sorted(removed)).toEqual(['c'])
    expect(removed.focus).toBe('a')
  })

  it('shiftClick selects the range from the anchor in displayed order and keeps the anchor', () =>
  {
    const down = run(state(['b'], 'b', 'b'), { type: 'shiftClick', id: 'e', ids: IDS })
    expect(sorted(down)).toEqual(['b', 'c', 'd', 'e'])
    expect(down.anchor).toBe('b')
    expect(down.focus).toBe('e')
    const up = run(down, { type: 'shiftClick', id: 'a', ids: IDS })
    expect(sorted(up)).toEqual(['a', 'b'])
    expect(up.anchor).toBe('b')
  })

  it('shiftClick replaces rows outside the range', () =>
  {
    const next = run(state(['f', 'b'], 'b', 'b'), { type: 'shiftClick', id: 'c', ids: IDS })
    expect(sorted(next)).toEqual(['b', 'c'])
  })

  it('shiftClick follows the given order, not the id order', () =>
  {
    const order = ['d', 'a', 'c', 'b']
    const next = run(state(['a'], 'a', 'a'), { type: 'shiftClick', id: 'b', ids: order })
    expect(sorted(next)).toEqual(['a', 'b', 'c'])
  })

  it('shiftClick without an anchor ranges from the focused row, or selects the row alone', () =>
  {
    const fromFocus = run(state([], null, 'b'), { type: 'shiftClick', id: 'd', ids: IDS })
    expect(sorted(fromFocus)).toEqual(['b', 'c', 'd'])
    expect(fromFocus.anchor).toBe('b')
    const alone = run(createGridSelection(), { type: 'shiftClick', id: 'c', ids: IDS })
    expect(sorted(alone)).toEqual(['c'])
    expect(alone.anchor).toBe('c')
  })

  it('shiftClick with an anchor that is not shown ranges from the focused row', () =>
  {
    const next = run(state(['zz'], 'zz', 'c'), { type: 'shiftClick', id: 'e', ids: IDS })
    expect(sorted(next)).toEqual(['c', 'd', 'e'])
    expect(next.anchor).toBe('c')
  })

  it('shiftClick on a row that is not shown selects that row alone', () =>
  {
    const next = run(state(['a'], 'a', 'a'), { type: 'shiftClick', id: 'zz', ids: IDS })
    expect(sorted(next)).toEqual(['zz'])
    expect(next.focus).toBe('zz')
  })

  it('ctrlShiftClick adds the range from the anchor to the selection', () =>
  {
    const start = run(createGridSelection(), { type: 'click', id: 'a' }, { type: 'ctrlClick', id: 'd' })
    const next = run(start, { type: 'ctrlShiftClick', id: 'f', ids: IDS })
    expect(sorted(next)).toEqual(['a', 'd', 'e', 'f'])
    expect(next.anchor).toBe('d')
    expect(next.focus).toBe('f')
  })

  it('toggle flips the given row and moves the anchor and focus to it', () =>
  {
    const on = run(state(['a'], 'a', 'a'), { type: 'toggle', id: 'c' })
    expect(sorted(on)).toEqual(['a', 'c'])
    expect(on.anchor).toBe('c')
    expect(on.focus).toBe('c')
    const off = run(on, { type: 'toggle', id: 'c' })
    expect(sorted(off)).toEqual(['a'])
  })

  it('toggle without an id flips the focused row', () =>
  {
    const next = run(state(['a', 'b'], 'a', 'b'), { type: 'toggle' })
    expect(sorted(next)).toEqual(['a'])
    expect(next.focus).toBe('b')
  })

  it('toggle without an id or a focused row changes nothing', () =>
  {
    const start = createGridSelection(['a'])
    expect(run(start, { type: 'toggle' })).toBe(start)
  })

  it('key moves focus and the selection follows', () =>
  {
    const next = run(state(['b'], 'b', 'b'), { type: 'key', move: 'next', ids: IDS })
    expect(sorted(next)).toEqual(['c'])
    expect(next.anchor).toBe('c')
    expect(next.focus).toBe('c')
  })

  it('key with extend selects from the anchor and keeps it', () =>
  {
    const next = run(
      state(['b'], 'b', 'b'),
      { type: 'key', move: 'next', mode: 'extend', ids: IDS },
      { type: 'key', move: 'next', mode: 'extend', ids: IDS }
    )
    expect(sorted(next)).toEqual(['b', 'c', 'd'])
    expect(next.anchor).toBe('b')
    expect(next.focus).toBe('d')
    const back = run(next, { type: 'key', move: 'first', mode: 'extend', ids: IDS })
    expect(sorted(back)).toEqual(['a', 'b'])
  })

  it('key with extend and no anchor starts from the row focus leaves', () =>
  {
    const next = run(state([], null, 'c'), { type: 'key', move: 'previous', mode: 'extend', ids: IDS })
    expect(sorted(next)).toEqual(['b', 'c'])
    expect(next.anchor).toBe('c')
  })

  it('key with focus mode moves focus without changing the selection or the anchor', () =>
  {
    const start = state(['a', 'b'], 'a', 'b')
    const next = run(start, { type: 'key', move: 'last', mode: 'focus', ids: IDS })
    expect(next.selected).toBe(start.selected)
    expect(next.anchor).toBe('a')
    expect(next.focus).toBe('f')
  })

  it('key pages by the given row count', () =>
  {
    const next = run(state(['a'], 'a', 'a'), { type: 'key', move: 'pageNext', page: 3, ids: IDS })
    expect(next.focus).toBe('d')
    expect(sorted(next)).toEqual(['d'])
  })

  it('key with an id lands there, as typeahead does', () =>
  {
    const next = run(state(['a'], 'a', 'a'), { type: 'key', id: 'e', ids: IDS })
    expect(sorted(next)).toEqual(['e'])
    expect(next.focus).toBe('e')
    const extended = run(state(['a'], 'a', 'a'), { type: 'key', id: 'c', mode: 'extend', ids: IDS })
    expect(sorted(extended)).toEqual(['a', 'b', 'c'])
  })

  it('key in an empty grid changes nothing', () =>
  {
    const start = createGridSelection()
    expect(run(start, { type: 'key', move: 'next', ids: [] })).toBe(start)
  })

  it('key at an end with the row already selected returns the same state', () =>
  {
    const start = state(['f'], 'f', 'f')
    expect(run(start, { type: 'key', move: 'next', ids: IDS })).toBe(start)
  })

  it('selectAll selects every given row and keeps the anchor and focus', () =>
  {
    const next = run(state(['a'], 'a', 'c'), { type: 'selectAll', ids: ['b', 'c', 'd'] })
    expect(sorted(next)).toEqual(['b', 'c', 'd'])
    expect(next.anchor).toBe('a')
    expect(next.focus).toBe('c')
  })

  it('clear empties the selection, keeps focus, and moves the anchor to the focused row', () =>
  {
    const next = run(state(['a', 'b', 'c'], 'a', 'c'), { type: 'clear' })
    expect(sorted(next)).toEqual([])
    expect(next.focus).toBe('c')
    expect(next.anchor).toBe('c')
  })

  it('clear on an empty selection returns the same state', () =>
  {
    const start = state([], 'b', 'b')
    expect(run(start, { type: 'clear' })).toBe(start)
  })

  it('sync drops vanished ids from the selection and the anchor', () =>
  {
    const next = run(state(['a', 'c', 'e'], 'c', 'a'), { type: 'sync', ids: ['a', 'b', 'd', 'e'] })
    expect(sorted(next)).toEqual(['a', 'e'])
    expect(next.anchor).toBeNull()
    expect(next.focus).toBe('a')
  })

  it('sync moves a vanished focus to the next surviving row of the previous order', () =>
  {
    const next = run(state(['c'], 'c', 'c'), { type: 'sync', ids: ['a', 'b', 'e', 'f'], previous: IDS })
    expect(next.focus).toBe('e')
    expect(sorted(next)).toEqual([])
  })

  it('sync moves a vanished focus back to the nearest earlier row when none follows', () =>
  {
    const next = run(state([], null, 'f'), { type: 'sync', ids: ['a', 'b'], previous: IDS })
    expect(next.focus).toBe('b')
  })

  it('sync clears a vanished focus with no previous order, no survivors, or an unknown position', () =>
  {
    expect(run(state([], null, 'c'), { type: 'sync', ids: ['a'] }).focus).toBeNull()
    expect(run(state([], null, 'c'), { type: 'sync', ids: [], previous: IDS }).focus).toBeNull()
    expect(run(state([], null, 'zz'), { type: 'sync', ids: ['a'], previous: IDS }).focus).toBeNull()
  })

  it('sync with every row still present returns the same state', () =>
  {
    const start = state(['a', 'b'], 'a', 'b')
    expect(run(start, { type: 'sync', ids: ['b', 'a', 'c'] })).toBe(start)
  })

  it('keeps the selected set when only focus changes', () =>
  {
    const start = state(['a', 'b', 'c'], 'a', 'b')
    const next = run(start, { type: 'shiftClick', id: 'c', ids: IDS })
    expect(next).not.toBe(start)
    expect(next.focus).toBe('c')
    expect(next.selected).toBe(start.selected)
  })

  it('returns the same state when an action reproduces it', () =>
  {
    const start = state(['a', 'b'], 'a', 'b')
    expect(run(start, { type: 'selectAll', ids: ['b', 'a'] })).toBe(start)
    expect(run(state(['c'], 'c', 'c'), { type: 'click', id: 'c' }).focus).toBe('c')
    const single = state(['c'], 'c', 'c')
    expect(run(single, { type: 'click', id: 'c' })).toBe(single)
  })

  it('never mutates the previous set', () =>
  {
    const start = state(['a'], 'a', 'a')
    run(start, { type: 'ctrlClick', id: 'b' }, { type: 'selectAll', ids: IDS }, { type: 'clear' })
    expect(sorted(start)).toEqual(['a'])
  })
})

describe('useGridSelection', () =>
{
  it('dispatches actions through the reducer', () =>
  {
    const { result } = renderHook(() => useGridSelection(IDS))
    act(() =>
    {
      result.current[1]({ type: 'click', id: 'b' })
    })
    expect(sorted(result.current[0])).toEqual(['b'])
    expect(result.current[0].focus).toBe('b')
  })

  it('starts from an initial selection', () =>
  {
    const { result } = renderHook(() => useGridSelection(IDS, createGridSelection(['c'], 'c')))
    expect(sorted(result.current[0])).toEqual(['c'])
  })

  it('syncs when rows leave the list and moves focus to the next surviving row', () =>
  {
    const { result, rerender } = renderHook(({ ids }) => useGridSelection(ids), { initialProps: { ids: IDS } })
    act(() =>
    {
      result.current[1]({ type: 'click', id: 'c' })
      result.current[1]({ type: 'ctrlClick', id: 'e' })
    })
    rerender({ ids: ['a', 'b', 'd', 'f'] })
    expect(sorted(result.current[0])).toEqual([])
    expect(result.current[0].focus).toBe('f')
  })

  it('keeps the same state when the rows are unchanged in a new array', () =>
  {
    const { result, rerender } = renderHook(({ ids }) => useGridSelection(ids), { initialProps: { ids: IDS } })
    act(() =>
    {
      result.current[1]({ type: 'click', id: 'a' })
    })
    const before = result.current[0]
    rerender({ ids: [...IDS] })
    expect(result.current[0]).toBe(before)
  })
})
