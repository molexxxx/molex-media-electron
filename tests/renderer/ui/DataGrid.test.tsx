/**
 * DataGrid: the ARIA grid of selectable rows behind the batch table. Guards one Tab stop with roving row
 * focus, selection through the grid selection actions, the keyboard table, key routing around cell widgets,
 * the sort cycle ending in the order given, reordering in the order given with announcements, column
 * priorities and the column menu, typeahead, row tooltips, and virtualization that keeps the focused row.
 */
import React, { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  DataGrid,
  gridTemplate,
  isGridCommand,
  dropOrder,
  isMenuKey,
  moveAnnouncement,
  moveGridRows,
  nextGridSort,
  sortGridRows,
  visibleGridColumns,
  type DataGridProps,
  type GridCellContext,
  type GridColumn,
  type GridDensity,
  type GridMoveTo,
  type GridSort
} from '../../../src/renderer/src/ui/DataGrid'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'
import { Menu, type MenuActionItem, type MenuGroup } from '../../../src/renderer/src/ui/Menu'
import { createGridSelection, type GridSelectionState } from '../../../src/renderer/src/ui/useGridSelection'

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Waits for the view's LiveRegion to speak `text`; announcements land a frame later and coalesce within 500 ms. */
async function announced(text: string): Promise<void>
{
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(text))
}

interface Job
{
  id: string
  name: string
  size: number
  number: string
}

const NAMES = ['Concert.mkv', 'beach.mp4', '2021 recap.mov', 'Ambient.flac', 'chapter 7.wav', 'Bonus.mp3', 'aria.ogg', '1999.avi']

function makeJobs(count: number): Job[]
{
  return Array.from({ length: count }, (_value, index) => ({
    id: `j${index + 1}`,
    name: NAMES[index % NAMES.length],
    size: (index * 37) % 11,
    number: `MM-${String(index + 1).padStart(4, '0')}`
  }))
}

const COLUMNS: Array<GridColumn<Job>> = [
  { id: 'grip', label: 'Reorder', width: '24px', kind: 'grip' },
  { id: 'number', label: 'No.', width: '88px', sortable: true, sortValue: (job) => job.number },
  { id: 'file', label: 'File', width: 'minmax(160px, 1fr)', sortable: true, sortValue: (job) => job.name },
  { id: 'size', label: 'Size', width: '96px', align: 'end', sortable: true, sortValue: (job) => job.size, priority: 2, optional: true },
  { id: 'output', label: 'Output', width: '160px', priority: 3, optional: true },
  { id: 'actions', label: 'Actions', width: '24px', kind: 'actions' }
]

interface Spies
{
  selection: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  move: ReturnType<typeof vi.fn>
  sort: ReturnType<typeof vi.fn>
  hidden: ReturnType<typeof vi.fn>
  density: ReturnType<typeof vi.fn>
}

interface HarnessProps
{
  spies: Spies
  rows: Job[]
  initial?: GridSelectionState
  initialSort?: GridSort | null
  reorder?: boolean
  grid?: Partial<DataGridProps<Job>>
}

function Harness({ spies, rows: initialRows, initial, initialSort = null, reorder = true, grid }: HarnessProps): ReactElement
{
  const [rows, setRows] = useState(initialRows)
  const [selected, setSelected] = useState(initial ?? createGridSelection())
  const [sort, setSort] = useState<GridSort | null>(initialSort)
  const [hidden, setHidden] = useState<string[]>([])
  const [density, setDensity] = useState<GridDensity>('default')
  const onMoveRows = (ids: string[], to: GridMoveTo): void =>
  {
    spies.move(ids, to)
    setRows((current) =>
    {
      const order = moveGridRows(current.map((row) => row.id), ids, to)
      return order.map((id) => current.find((row) => row.id === id) as Job)
    })
  }
  return (
    <LiveRegion>
      <DataGrid<Job>
        label="Jobs"
        rows={rows}
        columns={COLUMNS}
        hiddenColumns={hidden}
        onHiddenColumnsChange={(next) =>
        {
          spies.hidden(next)
          setHidden(next)
        }}
        selected={selected}
        onSelectionChange={(next, action) =>
        {
          spies.selection(next, action)
          setSelected(next)
        }}
        sort={sort}
        onSortChange={(next) =>
        {
          spies.sort(next)
          setSort(next)
        }}
        density={density}
        onDensityChange={(next) =>
        {
          spies.density(next)
          setDensity(next)
        }}
        unsortedLabel="queue order"
        reorderDisabledReason="Sort by queue order to reorder."
        countLabel={(count) => `${count} jobs`}
        onOpen={spies.open}
        onMoveRows={reorder ? onMoveRows : undefined}
        rowLabel={(job) => job.number}
        renderCell={(job, column) =>
        {
          switch (column.id)
          {
            case 'number':
              return job.number
            case 'file':
              return <span className="truncate">{job.name}</span>
            case 'size':
              return String(job.size)
            default:
              return null
          }
        }}
        {...grid}
      />
    </LiveRegion>
  )
}

function setup(options: Omit<HarnessProps, 'spies' | 'rows'> & { rows?: Job[] } = {}): Spies & { grid: HTMLElement, rerender: () => void }
{
  const spies: Spies = { selection: vi.fn(), open: vi.fn(), move: vi.fn(), sort: vi.fn(), hidden: vi.fn(), density: vi.fn() }
  const view = render(<Harness spies={spies} rows={options.rows ?? makeJobs(5)} {...options} />)
  return { ...spies, grid: screen.getByRole('grid'), rerender: () => view.rerender(<Harness spies={spies} rows={options.rows ?? makeJobs(5)} {...options} />) }
}

function bodyRows(): HTMLElement[]
{
  return Array.from(document.querySelectorAll<HTMLElement>('[role="row"][data-row-id]'))
}

function row(id: string): HTMLElement
{
  return document.querySelector<HTMLElement>(`[role="row"][data-row-id="${id}"]`) as HTMLElement
}

function selectedIds(): string[]
{
  return bodyRows().filter((element) => element.getAttribute('aria-selected') === 'true').map((element) => element.dataset.rowId as string)
}

function order(): string[]
{
  return bodyRows().map((element) => element.dataset.rowId as string)
}

describe('DataGrid pointer reorder', () =>
{
  afterEach(() =>
  {
    vi.restoreAllMocks()
    cleanup()
  })

  /** Lays the body rows out 36 px apart below a 32 px header, the way the grid draws them. */
  function layoutRows(): void
  {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect
    {
      const index = this.dataset.rowId === undefined ? -1 : order().indexOf(this.dataset.rowId)
      const top = index < 0 ? 0 : 32 + index * 36
      const height = index < 0 ? 600 : 36
      return { top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
  }

  const over = (index: number): number => 32 + index * 36 + 6

  it('moves rows in their relative order before a row or to the end', () =>
  {
    expect(dropOrder(['a', 'b', 'c', 'd'], ['a'], 'd')).toEqual(['b', 'c', 'a', 'd'])
    expect(dropOrder(['a', 'b', 'c', 'd'], ['d', 'b'], 'a')).toEqual(['b', 'd', 'a', 'c'])
    expect(dropOrder(['a', 'b', 'c'], ['a'], null)).toEqual(['b', 'c', 'a'])
    expect(dropOrder(['a', 'b', 'c'], ['a'], 'x')).toEqual(['a', 'b', 'c'])
  })

  it('starts a drag past five pixels, marks where the rows land, and moves them there on release', () =>
  {
    const drop = vi.fn()
    const { selection } = setup({ grid: { onDropRows: drop } })
    layoutRows()
    const ids = order()
    fireEvent.pointerDown(row(ids[0]), { button: 0, clientX: 100, clientY: over(0) })
    fireEvent.pointerMove(window, { clientX: 102, clientY: over(0) + 2 })
    expect(row(ids[0])).not.toHaveAttribute('data-dragging')
    fireEvent.pointerMove(window, { clientX: 100, clientY: over(3) })
    expect(row(ids[0])).toHaveAttribute('data-dragging')
    expect(row(ids[3])).toHaveAttribute('data-drop-before')
    expect(screen.getByText('Move 1 jobs')).toBeInTheDocument()
    fireEvent.pointerUp(window)
    expect(drop).toHaveBeenCalledWith([ids[0]], ids[3])
    expect(row(ids[3])).not.toHaveAttribute('data-drop-before')
    const before = selection.mock.calls.length
    fireEvent.click(row(ids[0]))
    expect(selection.mock.calls.length).toBe(before)
  })

  it('drags the whole selection, lands after the last row, and leaves the order alone when nothing would move', () =>
  {
    const drop = vi.fn()
    setup({ grid: { onDropRows: drop }, initial: createGridSelection(['j1', 'j3'], 'j3') })
    layoutRows()
    fireEvent.pointerDown(row('j3'), { button: 0, clientX: 100, clientY: over(2) })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 32 + 5 * 36 + 10 })
    expect(row('j1')).toHaveAttribute('data-dragging')
    expect(row('j5')).toHaveAttribute('data-drop-after')
    fireEvent.pointerUp(window)
    expect(drop).toHaveBeenCalledWith(['j1', 'j3'], null)
    fireEvent.pointerDown(row('j2'), { button: 0, clientX: 100, clientY: over(1) })
    fireEvent.pointerMove(window, { clientX: 100, clientY: over(1) + 12 })
    fireEvent.pointerUp(window)
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape and never drags while sorted or with a modifier held', () =>
  {
    const drop = vi.fn()
    setup({ grid: { onDropRows: drop } })
    layoutRows()
    fireEvent.pointerDown(row('j1'), { button: 0, clientX: 100, clientY: over(0) })
    fireEvent.pointerMove(window, { clientX: 100, clientY: over(3) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(row('j1')).not.toHaveAttribute('data-dragging')
    fireEvent.pointerUp(window)
    fireEvent.pointerDown(row('j1'), { button: 0, ctrlKey: true, clientX: 100, clientY: over(0) })
    fireEvent.pointerMove(window, { clientX: 100, clientY: over(3) })
    expect(row('j1')).not.toHaveAttribute('data-dragging')
    fireEvent.pointerUp(window)
    cleanup()
    setup({ grid: { onDropRows: drop }, initialSort: { column: 'file', direction: 'ascending' } })
    layoutRows()
    fireEvent.pointerDown(row('j1'), { button: 0, clientX: 100, clientY: over(0) })
    fireEvent.pointerMove(window, { clientX: 100, clientY: over(3) })
    expect(row('j1')).not.toHaveAttribute('data-dragging')
    fireEvent.pointerUp(window)
    expect(drop).not.toHaveBeenCalled()
  })
})

describe('DataGrid structure', () =>
{
  it('is a named, multiselectable grid with header and body row groups', () =>
  {
    const { grid } = setup()
    expect(grid).toHaveAttribute('aria-label', 'Jobs')
    expect(grid).toHaveAttribute('aria-multiselectable', 'true')
    expect(within(grid).getAllByRole('rowgroup')).toHaveLength(2)
    expect(within(grid).getAllByRole('columnheader').length).toBeGreaterThan(0)
    expect(bodyRows()).toHaveLength(5)
    expect(within(bodyRows()[0]).getAllByRole('gridcell', { hidden: true }).length).toBe(COLUMNS.length)
  })

  it('exposes aria-selected on every row and never aria-disabled', () =>
  {
    setup({ initial: createGridSelection(['j2'], 'j2') })
    for (const element of bodyRows())
    {
      expect(element).toHaveAttribute('aria-selected')
      expect(element).not.toHaveAttribute('aria-disabled')
    }
    expect(row('j2')).toHaveAttribute('aria-selected', 'true')
    expect(row('j1')).toHaveAttribute('aria-selected', 'false')
  })

  it('gives exactly one row tabIndex 0, the focused row or else the first', () =>
  {
    setup()
    expect(bodyRows().filter((element) => element.tabIndex === 0).map((element) => element.dataset.rowId)).toEqual(['j1'])
    cleanup()
    setup({ initial: createGridSelection([], 'j4') })
    expect(bodyRows().filter((element) => element.tabIndex === 0).map((element) => element.dataset.rowId)).toEqual(['j4'])
  })

  it('shares one column template through a custom property, with actions columns at 24 px', () =>
  {
    const { grid } = setup()
    expect(grid.style.getPropertyValue('--ui-grid-columns')).toBe('24px 88px minmax(160px, 1fr) 96px 160px 48px')
    expect(gridTemplate([{ width: '200px', kind: 'actions' }, { width: '1fr' }])).toBe('48px 1fr')
  })

  it('hides the grip column from assistive technology and shows the grip only while reorderable', () =>
  {
    setup()
    const grip = within(bodyRows()[0]).getAllByRole('gridcell', { hidden: true })[0]
    expect(grip).toHaveAttribute('aria-hidden', 'true')
    expect(grip.querySelector('.ui-grid-grip')).not.toBeNull()
    expect(grip.querySelector('[tabindex]')).toBeNull()
    cleanup()
    setup({ reorder: false })
    expect(within(bodyRows()[0]).getAllByRole('gridcell', { hidden: true })[0].querySelector('.ui-grid-grip')).toBeNull()
  })

  it('renders skeleton rows hidden from assistive technology while loading', () =>
  {
    const { grid } = setup({ grid: { loading: true } })
    expect(grid).toHaveAttribute('aria-busy', 'true')
    expect(bodyRows()).toHaveLength(0)
    expect(grid.querySelectorAll('.ui-grid-skeleton')).toHaveLength(6)
    expect(grid.querySelector('.ui-grid-skeleton')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('DataGrid mouse selection', () =>
{
  it('selects one row on click, toggles on Ctrl+click, and selects a range on Shift+click', () =>
  {
    setup()
    fireEvent.click(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
    fireEvent.click(row('j4'), { ctrlKey: true })
    expect(selectedIds()).toEqual(['j2', 'j4'])
    fireEvent.click(row('j2'), { ctrlKey: true })
    expect(selectedIds()).toEqual(['j4'])
    fireEvent.click(row('j5'), { shiftKey: true })
    expect(selectedIds()).toEqual(['j2', 'j3', 'j4', 'j5'])
  })

  it('adds a range to the selection on Ctrl+Shift+click', () =>
  {
    setup()
    fireEvent.click(row('j1'))
    fireEvent.click(row('j3'), { ctrlKey: true })
    fireEvent.click(row('j5'), { ctrlKey: true, shiftKey: true })
    expect(selectedIds()).toEqual(['j1', 'j3', 'j4', 'j5'])
  })

  it('ignores clicks on widgets inside cells', () =>
  {
    const { selection } = setup({
      grid: {
        renderCell: (job, column) => column.kind === 'actions' ? <button type="button">More actions for {job.number}</button> : job.name
      }
    })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for MM-0002' }))
    expect(selection).not.toHaveBeenCalled()
  })
})

function press(target: Element, key: string, init: Partial<KeyboardEventInit> = {}): void
{
  fireEvent.keyDown(target, { key, ...init })
}

function focusOn(element: HTMLElement): void
{
  act(() => element.focus())
}

function tabStops(): string[]
{
  return bodyRows().filter((element) => element.tabIndex === 0).map((element) => element.dataset.rowId as string)
}

function RevertingField({ initial }: { initial: string }): ReactElement
{
  const [value, setValue] = useState(initial)
  return (
    <input
      aria-label={`Name of ${initial}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) =>
      {
        if (event.key === 'Escape' && value !== initial)
        {
          event.preventDefault()
          setValue(initial)
        }
      }}
    />
  )
}

describe('DataGrid keyboard', () =>
{
  it('moves focus and selection together on Down and Up', () =>
  {
    setup()
    focusOn(row('j1'))
    press(row('j1'), 'ArrowDown')
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
    expect(tabStops()).toEqual(['j2'])
    press(row('j2'), 'ArrowUp')
    expect(document.activeElement).toBe(row('j1'))
    expect(selectedIds()).toEqual(['j1'])
  })

  it('focuses with preventScroll and then scrolls the nearest edge into view', () =>
  {
    setup()
    focusOn(row('j1'))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    press(row('j1'), 'ArrowDown')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
    expect(focus.mock.invocationCallOrder[0]).toBeLessThan(scroll.mock.invocationCallOrder[0])
  })

  it('extends from the anchor with Shift and moves focus only with Ctrl', () =>
  {
    setup()
    fireEvent.click(row('j2'))
    press(row('j2'), 'ArrowDown', { shiftKey: true })
    press(row('j3'), 'ArrowDown', { shiftKey: true })
    expect(selectedIds()).toEqual(['j2', 'j3', 'j4'])
    press(row('j4'), 'ArrowUp', { ctrlKey: true })
    expect(document.activeElement).toBe(row('j3'))
    expect(selectedIds()).toEqual(['j2', 'j3', 'j4'])
    press(row('j3'), 'ArrowUp', { ctrlKey: true })
    press(row('j2'), 'ArrowUp', { ctrlKey: true })
    expect(document.activeElement).toBe(row('j1'))
    expect(tabStops()).toEqual(['j1'])
    expect(selectedIds()).toEqual(['j2', 'j3', 'j4'])
  })

  it('toggles the focused row with Ctrl+Space and selects the range to it with Shift+Space', () =>
  {
    setup()
    fireEvent.click(row('j1'))
    press(row('j1'), 'ArrowDown', { ctrlKey: true })
    press(row('j2'), 'ArrowDown', { ctrlKey: true })
    press(row('j3'), ' ', { ctrlKey: true })
    expect(selectedIds()).toEqual(['j1', 'j3'])
    press(row('j3'), ' ', { ctrlKey: true })
    expect(selectedIds()).toEqual(['j1'])
    press(row('j3'), ' ', { shiftKey: true })
    expect(selectedIds()).toEqual(['j3'])
    press(row('j3'), 'ArrowDown', { ctrlKey: true })
    press(row('j4'), 'ArrowDown', { ctrlKey: true })
    press(row('j5'), ' ', { shiftKey: true })
    expect(selectedIds()).toEqual(['j3', 'j4', 'j5'])
  })

  it('selects every displayed row with Ctrl+A and clears with Escape, keeping focus', () =>
  {
    setup()
    fireEvent.click(row('j3'))
    press(row('j3'), 'a', { ctrlKey: true })
    expect(selectedIds()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
    press(row('j3'), 'Escape')
    expect(selectedIds()).toEqual([])
    expect(document.activeElement).toBe(row('j3'))
    expect(tabStops()).toEqual(['j3'])
  })

  it('leaves Escape alone when nothing is selected', () =>
  {
    setup()
    focusOn(row('j1'))
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    row('j1').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('reaches the first and last rows with Home and End, extending with Shift', () =>
  {
    setup()
    fireEvent.click(row('j3'))
    press(row('j3'), 'End')
    expect(document.activeElement).toBe(row('j5'))
    expect(selectedIds()).toEqual(['j5'])
    press(row('j5'), 'Home', { shiftKey: true })
    expect(document.activeElement).toBe(row('j1'))
    expect(selectedIds()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
    press(row('j1'), 'End', { ctrlKey: true })
    expect(document.activeElement).toBe(row('j5'))
    expect(selectedIds()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
  })

  it('moves by one visible page with PageDown and PageUp', () =>
  {
    setup({ rows: makeJobs(30) })
    fireEvent.click(row('j1'))
    press(row('j1'), 'PageDown')
    expect(document.activeElement).toBe(row('j11'))
    press(row('j11'), 'PageDown', { shiftKey: true })
    expect(document.activeElement).toBe(row('j21'))
    expect(selectedIds()).toEqual(Array.from({ length: 11 }, (_value, index) => `j${index + 11}`))
    press(row('j21'), 'PageUp')
    expect(document.activeElement).toBe(row('j11'))
    expect(selectedIds()).toEqual(['j11'])
  })

  it('calls onOpen for the focused row on Enter', () =>
  {
    const { open } = setup()
    fireEvent.click(row('j2'))
    press(row('j2'), 'Enter')
    expect(open).toHaveBeenCalledWith('j2')
  })

  it('makes the row the focused row when focus arrives by Tab, so returning restores it', () =>
  {
    const { selection } = setup()
    focusOn(row('j1'))
    expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({ focus: 'j1' }), expect.objectContaining({ type: 'key', mode: 'focus' }))
    press(row('j1'), 'ArrowDown', { ctrlKey: true })
    press(row('j2'), 'ArrowDown', { ctrlKey: true })
    act(() => (document.activeElement as HTMLElement).blur())
    expect(tabStops()).toEqual(['j3'])
  })

  it('takes cell widgets out of the tab order and moves into them with Right, back with Left', () =>
  {
    setup({
      grid: {
        renderCell: (job, column) => column.id === 'file' ? <button type="button">Open {job.number}</button> : column.kind === 'actions' ? <button type="button">More {job.number}</button> : null
      }
    })
    const open = screen.getByRole('button', { name: 'Open MM-0002' })
    const more = screen.getByRole('button', { name: 'More MM-0002' })
    expect(open.tabIndex).toBe(-1)
    expect(more.tabIndex).toBe(-1)
    fireEvent.click(row('j2'))
    press(row('j2'), 'ArrowRight')
    expect(document.activeElement).toBe(open)
    press(open, 'ArrowRight')
    expect(document.activeElement).toBe(more)
    press(more, 'ArrowRight')
    expect(document.activeElement).toBe(more)
    press(more, 'ArrowLeft')
    expect(document.activeElement).toBe(open)
    press(open, 'ArrowLeft')
    expect(document.activeElement).toBe(row('j2'))
    press(row('j2'), 'ArrowLeft')
    expect(document.activeElement).toBe(row('j2'))
    press(row('j2'), 'ArrowRight')
    press(open, 'Escape')
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
  })

  it('moves focus to a row whose cell widget takes focus, without changing the selection', () =>
  {
    setup({
      grid: {
        renderCell: (job, column) => column.kind === 'actions' ? <button type="button">More {job.number}</button> : null
      }
    })
    fireEvent.click(row('j1'))
    focusOn(screen.getByRole('button', { name: 'More MM-0004' }))
    expect(tabStops()).toEqual(['j4'])
    expect(selectedIds()).toEqual(['j1'])
  })
})

describe('DataGrid key routing around cell widgets', () =>
{
  const COMMANDS: Array<[string, Partial<KeyboardEventInit>]> = [
    [' ', {}],
    ['Delete', {}],
    ['Delete', { shiftKey: true }],
    ...Array.from({ length: 9 }, (_value, index): [string, Partial<KeyboardEventInit>] => [String(index + 1), { code: `Digit${index + 1}`, altKey: true }]),
    ...Array.from({ length: 9 }, (_value, index): [string, Partial<KeyboardEventInit>] => ['!', { code: `Digit${index + 1}`, altKey: true, shiftKey: true }]),
    ['v', { ctrlKey: true }],
    ['d', { ctrlKey: true }],
    ['c', { ctrlKey: true }],
    ['F8', {}],
    ['?', { shiftKey: true }],
    ['ArrowUp', { altKey: true }],
    ['ArrowDown', { altKey: true }],
    ['ArrowLeft', { altKey: true }],
    ['ArrowRight', { altKey: true }],
    ['Home', { altKey: true }],
    ['End', { altKey: true }]
  ]

  it('hands every command key on a row to onKeyCommand with the focused id', () =>
  {
    const command = vi.fn(() => true)
    const { move } = setup({ grid: { onKeyCommand: command } })
    fireEvent.click(row('j2'))
    for (const [key, init] of COMMANDS)
    {
      command.mockClear()
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      row('j2').dispatchEvent(event)
      expect(command).toHaveBeenCalledTimes(1)
      expect(command).toHaveBeenCalledWith(event, 'j2')
      expect(event.defaultPrevented).toBe(true)
    }
    expect(move).not.toHaveBeenCalled()
  })

  it('never offers numeric keypad digits, and lets the grid run its own keys when a command is declined', () =>
  {
    const command = vi.fn(() => false)
    setup({ grid: { onKeyCommand: command } })
    fireEvent.click(row('j2'))
    press(row('j2'), '1', { code: 'Numpad1', altKey: true })
    press(row('j2'), 'ArrowDown')
    expect(command).not.toHaveBeenCalled()
    press(row('j3'), ' ')
    expect(command).toHaveBeenCalledTimes(1)
    expect(selectedIds()).toEqual(['j3'])
  })

  it('sends no command from inside a cell widget', () =>
  {
    const command = vi.fn(() => true)
    setup({
      grid: {
        onKeyCommand: command,
        renderCell: (job, column) => column.kind === 'actions' ? <button type="button">More {job.number}</button> : null
      }
    })
    const more = screen.getByRole('button', { name: 'More MM-0002' })
    focusOn(more)
    for (const [key, init] of COMMANDS)
    {
      press(more, key, init)
    }
    expect(command).not.toHaveBeenCalled()
  })

  it('leaves Left, Right, Home, End, Space, and Ctrl+A in a cell text field alone', () =>
  {
    const { selection } = setup({
      grid: {
        renderCell: (job, column) => column.id === 'file' ? <RevertingField initial={job.name} /> : null
      }
    })
    fireEvent.click(row('j2'))
    const field = screen.getByRole('textbox', { name: 'Name of beach.mp4' })
    focusOn(field)
    selection.mockClear()
    for (const [key, init] of [['ArrowLeft', {}], ['ArrowRight', {}], ['Home', {}], ['End', {}], [' ', {}], ['a', { ctrlKey: true }], ['ArrowDown', {}]] as Array<[string, Partial<KeyboardEventInit>]>)
    {
      press(field, key, init)
      expect(document.activeElement).toBe(field)
    }
    expect(selection).not.toHaveBeenCalled()
    expect(selectedIds()).toEqual(['j2'])
  })

  it('reverts a cell field on the first Escape and returns to the row on the second', () =>
  {
    setup({
      grid: {
        renderCell: (job, column) => column.id === 'file' ? <RevertingField initial={job.name} /> : null
      }
    })
    fireEvent.click(row('j2'))
    const field = screen.getByRole('textbox', { name: 'Name of beach.mp4' }) as HTMLInputElement
    focusOn(field)
    fireEvent.change(field, { target: { value: 'renamed.mp4' } })
    press(field, 'Escape')
    expect(field.value).toBe('beach.mp4')
    expect(document.activeElement).toBe(field)
    expect(selectedIds()).toEqual(['j2'])
    press(field, 'Escape')
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
  })

  it('starts editing the row field with F2', () =>
  {
    setup({
      grid: {
        renderCell: (job, column) => column.id === 'file' ? <RevertingField initial={job.name} /> : null
      }
    })
    fireEvent.click(row('j2'))
    press(row('j2'), 'F2')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name of beach.mp4' }))
  })
})

describe('DataGrid helpers', () =>
{
  it('cycles a sort ascending, descending, then back to the order given', () =>
  {
    expect(nextGridSort(null, 'file')).toEqual({ column: 'file', direction: 'ascending' })
    expect(nextGridSort({ column: 'file', direction: 'ascending' }, 'file')).toEqual({ column: 'file', direction: 'descending' })
    expect(nextGridSort({ column: 'file', direction: 'descending' }, 'file')).toBeNull()
    expect(nextGridSort({ column: 'size', direction: 'descending' }, 'file')).toEqual({ column: 'file', direction: 'ascending' })
  })

  it('sorts stably with numeric collation, empty values last in both directions', () =>
  {
    interface Item { id: string, value: string | number | null }
    const items: Item[] = [{ id: 'a', value: 'MM-0010' }, { id: 'b', value: null }, { id: 'c', value: 'MM-0002' }, { id: 'd', value: 'mm-0010' }]
    const columns: Array<GridColumn<Item>> = [{ id: 'v', label: 'V', width: '1fr', sortable: true, sortValue: (item) => item.value }]
    expect(sortGridRows(items, columns, { column: 'v', direction: 'ascending' }).map((item) => item.id)).toEqual(['c', 'a', 'd', 'b'])
    expect(sortGridRows(items, columns, { column: 'v', direction: 'descending' }).map((item) => item.id)).toEqual(['a', 'd', 'c', 'b'])
    expect(sortGridRows(items, columns, null)).toBe(items)
    expect(sortGridRows(items, columns, { column: 'missing', direction: 'ascending' })).toBe(items)
    const numbers: Item[] = [{ id: 'x', value: 10 }, { id: 'y', value: 9 }, { id: 'z', value: undefined as unknown as null }]
    expect(sortGridRows(numbers, columns, { column: 'v', direction: 'ascending' }).map((item) => item.id)).toEqual(['y', 'x', 'z'])
    const compared: Array<GridColumn<Item>> = [{ id: 'v', label: 'V', width: '1fr', compare: (a, b) => a.id.localeCompare(b.id) }]
    expect(sortGridRows(items, compared, { column: 'v', direction: 'descending' }).map((item) => item.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('moves rows up and down one place, as a block, and gathers them at the top or bottom', () =>
  {
    const ids = ['a', 'b', 'c', 'd', 'e']
    expect(moveGridRows(ids, ['c'], 'up')).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(moveGridRows(ids, ['c', 'd'], 'up')).toEqual(['a', 'c', 'd', 'b', 'e'])
    expect(moveGridRows(ids, ['a', 'c'], 'up')).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(moveGridRows(ids, ['b', 'd'], 'down')).toEqual(['a', 'c', 'b', 'e', 'd'])
    expect(moveGridRows(ids, ['e'], 'down')).toEqual(ids)
    expect(moveGridRows(ids, ['d', 'b'], 'top')).toEqual(['b', 'd', 'a', 'c', 'e'])
    expect(moveGridRows(ids, ['b', 'd'], 'bottom')).toEqual(['a', 'c', 'e', 'b', 'd'])
  })

  it('recognizes exactly the view command keys', () =>
  {
    const key = (init: Partial<KeyboardEvent>): boolean => isGridCommand({ key: '', code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })
    expect(key({ key: ' ' })).toBe(true)
    expect(key({ key: ' ', shiftKey: true })).toBe(false)
    expect(key({ key: ' ', ctrlKey: true })).toBe(false)
    expect(key({ key: 'Delete' })).toBe(true)
    expect(key({ key: 'Delete', shiftKey: true })).toBe(true)
    for (let digit = 1; digit <= 9; digit++)
    {
      expect(key({ key: String(digit), code: `Digit${digit}`, altKey: true })).toBe(true)
      expect(key({ key: '!', code: `Digit${digit}`, altKey: true, shiftKey: true })).toBe(true)
      expect(key({ key: String(digit), code: `Numpad${digit}`, altKey: true })).toBe(false)
    }
    expect(key({ key: '0', code: 'Digit0', altKey: true })).toBe(false)
    expect(key({ key: '1', code: 'Digit1', altKey: true, ctrlKey: true })).toBe(false)
    expect(key({ key: 'v', ctrlKey: true })).toBe(true)
    expect(key({ key: 'D', ctrlKey: true })).toBe(true)
    expect(key({ key: 'c', metaKey: true })).toBe(true)
    expect(key({ key: 'c', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(key({ key: 'a', ctrlKey: true })).toBe(false)
    expect(key({ key: 'F8' })).toBe(true)
    expect(key({ key: '?', shiftKey: true })).toBe(true)
    for (const name of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
    {
      expect(key({ key: name, altKey: true })).toBe(true)
      expect(key({ key: name })).toBe(false)
    }
    expect(key({ key: 'Enter' })).toBe(false)
    expect(key({ key: 'a' })).toBe(false)
  })

  it('drops hidden optional columns and columns whose priority needs a wider grid', () =>
  {
    const ids = (width: number | null, hidden: string[] = []): string[] => visibleGridColumns(COLUMNS, hidden, width).map((column) => column.id)
    expect(ids(null)).toEqual(['grip', 'number', 'file', 'size', 'output', 'actions'])
    expect(ids(679)).toEqual(['grip', 'number', 'file', 'actions'])
    expect(ids(680)).toEqual(['grip', 'number', 'file', 'size', 'actions'])
    expect(ids(960)).toEqual(['grip', 'number', 'file', 'size', 'output', 'actions'])
    expect(ids(1200, ['size', 'file'])).toEqual(['grip', 'number', 'file', 'output', 'actions'])
  })

  it('recognizes Shift+F10 and the Menu key as the menu keys', () =>
  {
    const key = (init: Partial<KeyboardEvent>): boolean => isMenuKey({ key: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })
    expect(key({ key: 'ContextMenu' })).toBe(true)
    expect(key({ key: 'F10', shiftKey: true })).toBe(true)
    expect(key({ key: 'F10' })).toBe(false)
    expect(key({ key: 'F10', shiftKey: true, ctrlKey: true })).toBe(false)
    expect(key({ key: 'ContextMenu', altKey: true })).toBe(false)
  })

  it('words single, contiguous, and scattered moves', () =>
  {
    const name = (id: string): string => id.toUpperCase()
    const count = (n: number): string => `${n} jobs`
    expect(moveAnnouncement(['a', 'b', 'c'], ['a'], 'down', name, count)).toBe('A moved to position 1 of 3.')
    expect(moveAnnouncement(['a', 'b', 'c', 'd'], ['c', 'b'], 'up', name, count)).toBe('2 jobs moved to positions 2 to 3 of 4.')
    expect(moveAnnouncement(['b', 'a', 'd', 'c'], ['a', 'c'], 'down', name, count)).toBe('2 jobs moved down one position.')
    expect(moveAnnouncement(['a', 'b', 'c', 'd'], ['b', 'd'], 'up', name, count)).toBe('2 jobs moved up one position.')
  })
})

describe('DataGrid reordering', () =>
{
  it('moves the selection with Alt and the arrows, End, and Home, keeping focus and announcing the landing', async () =>
  {
    const { move } = setup()
    fireEvent.click(row('j2'))
    press(row('j2'), 'ArrowDown', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j2'], 'down')
    expect(order()).toEqual(['j1', 'j3', 'j2', 'j4', 'j5'])
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
    await announced('MM-0002 moved to position 3 of 5.')
    press(row('j2'), 'End', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j2'], 'bottom')
    expect(order()).toEqual(['j1', 'j3', 'j4', 'j5', 'j2'])
    await announced('MM-0002 moved to position 5 of 5.')
    press(row('j2'), 'ArrowDown', { altKey: true })
    expect(move).toHaveBeenCalledTimes(2)
    press(row('j2'), 'Home', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j2'], 'top')
    expect(order()).toEqual(['j2', 'j1', 'j3', 'j4', 'j5'])
    press(row('j2'), 'ArrowUp', { altKey: true })
    expect(move).toHaveBeenCalledTimes(3)
    press(row('j3'), 'ArrowUp', { altKey: true, shiftKey: true })
    expect(move).toHaveBeenCalledTimes(3)
    fireEvent.click(row('j3'))
    press(row('j3'), 'ArrowUp', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j3'], 'up')
    expect(order()).toEqual(['j2', 'j3', 'j1', 'j4', 'j5'])
    expect(document.activeElement).toBe(row('j3'))
  })

  it('moves several rows as a block and names their count', async () =>
  {
    const { move } = setup()
    fireEvent.click(row('j2'))
    fireEvent.click(row('j3'), { shiftKey: true })
    press(row('j3'), 'ArrowDown', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j2', 'j3'], 'down')
    expect(order()).toEqual(['j1', 'j4', 'j2', 'j3', 'j5'])
    await announced('2 jobs moved to positions 3 to 4 of 5.')
  })

  it('moves the focused row when nothing is selected', () =>
  {
    const { move } = setup({ initial: createGridSelection([], 'j4') })
    press(row('j4'), 'ArrowUp', { altKey: true })
    expect(move).toHaveBeenLastCalledWith(['j4'], 'up')
  })

  it('does nothing with the move keys while a column sort is active, and hides the grip', async () =>
  {
    const { move } = setup({ initialSort: { column: 'file', direction: 'ascending' } })
    fireEvent.click(row('j2'))
    const before = order()
    for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home'])
    {
      press(row('j2'), key, { altKey: true })
    }
    expect(move).not.toHaveBeenCalled()
    expect(order()).toEqual(before)
    expect(row('j2').querySelector('.ui-grid-grip')).toBeNull()
    await announced('Sort by queue order to reorder.')
  })

  it('ignores the move keys when the view cannot reorder', () =>
  {
    setup({ reorder: false })
    fireEvent.click(row('j2'))
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })
    row('j2').dispatchEvent(event)
    expect(order()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
    expect(document.activeElement).toBe(row('j2'))
  })
})

function moveItem(menu: HTMLElement, name: string): HTMLElement
{
  return within(menu).getByRole('menuitem', { hidden: true, name })
}

/** jsdom styles a popover as display: none, which empties its accessible name, so menus are found by their label. */
function menuNamed(name: string): HTMLElement
{
  const menu = screen.getAllByRole('menu', { hidden: true }).find((candidate) => candidate.getAttribute('aria-label') === name)
  if (!menu)
  {
    throw new Error(`No menu labeled "${name}"`)
  }
  return menu
}

describe('DataGrid row menu', () =>
{

  it('opens on Shift+F10 with the four move items, disabled at the top, and moves through them', async () =>
  {
    const { move } = setup()
    fireEvent.click(row('j1'))
    press(row('j1'), 'F10', { shiftKey: true })
    const menu = menuNamed('Actions for MM-0001')
    expect(document.activeElement).toBe(moveItem(menu, 'Move up'))
    for (const name of ['Move up', 'Move to top'])
    {
      expect(moveItem(menu, name)).toHaveAttribute('aria-disabled', 'true')
      expect(moveItem(menu, name)).toHaveAccessibleDescription('Already at the top.')
    }
    for (const name of ['Move down', 'Move to bottom'])
    {
      expect(moveItem(menu, name)).not.toHaveAttribute('aria-disabled')
    }
    fireEvent.click(moveItem(menu, 'Move up'))
    expect(move).not.toHaveBeenCalled()
    fireEvent.click(moveItem(menu, 'Move down'))
    expect(move).toHaveBeenCalledWith(['j1'], 'down')
    expect(order()).toEqual(['j2', 'j1', 'j3', 'j4', 'j5'])
    expect(document.activeElement).toBe(row('j1'))
    await announced('MM-0001 moved to position 2 of 5.')
  })

  it('disables the bottom items on the last row and moves to the top through the menu key', () =>
  {
    const { move } = setup()
    fireEvent.click(row('j5'))
    press(row('j5'), 'ContextMenu')
    const menu = menuNamed('Actions for MM-0005')
    for (const name of ['Move down', 'Move to bottom'])
    {
      expect(moveItem(menu, name)).toHaveAttribute('aria-disabled', 'true')
      expect(moveItem(menu, name)).toHaveAccessibleDescription('Already at the bottom.')
    }
    fireEvent.click(moveItem(menu, 'Move to top'))
    expect(move).toHaveBeenCalledWith(['j5'], 'top')
    expect(order()).toEqual(['j5', 'j1', 'j2', 'j3', 'j4'])
  })

  it('disables every move item while sorted, with the reason', () =>
  {
    setup({ initialSort: { column: 'number', direction: 'descending' } })
    fireEvent.click(row('j3'))
    press(row('j3'), 'F10', { shiftKey: true })
    const menu = menuNamed('Actions for MM-0003')
    for (const name of ['Move up', 'Move down', 'Move to top', 'Move to bottom'])
    {
      expect(moveItem(menu, name)).toHaveAttribute('aria-disabled', 'true')
      expect(moveItem(menu, name)).toHaveAccessibleDescription('Sort by queue order to reorder.')
    }
  })

  it('acts on the whole selection from a right click on a selected row, after the view entries', async () =>
  {
    const opened = vi.fn()
    const { move } = setup({ grid: { rowMenu: (job) => [{ id: 'open', label: `Open ${job.number}`, onSelect: () => opened(job.id) }] } })
    fireEvent.click(row('j2'))
    fireEvent.click(row('j3'), { ctrlKey: true })
    fireEvent.contextMenu(row('j3'), { button: 2, clientX: 40, clientY: 60 })
    const menu = menuNamed('Actions for 2 jobs')
    const items = within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.textContent)
    expect(items[0]).toContain('Open MM-0003')
    expect(within(menu).getByRole('separator', { hidden: true })).toBeInTheDocument()
    const anchor = document.querySelector<HTMLElement>('.ui-grid-menu-anchor') as HTMLElement
    expect(anchor.style.left).toBe('40px')
    expect(anchor.style.top).toBe('60px')
    fireEvent.click(moveItem(menu, 'Move to bottom'))
    expect(move).toHaveBeenCalledWith(['j2', 'j3'], 'bottom')
    expect(order()).toEqual(['j1', 'j4', 'j5', 'j2', 'j3'])
    await announced('2 jobs moved to positions 4 to 5 of 5.')
  })

  it('selects an unselected row on right click and acts on it alone', () =>
  {
    setup()
    fireEvent.click(row('j1'))
    fireEvent.contextMenu(row('j4'), { button: 2, clientX: 4, clientY: 4 })
    expect(selectedIds()).toEqual(['j4'])
    expect(menuNamed('Actions for MM-0004')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the row, keeping the selection', () =>
  {
    setup()
    fireEvent.click(row('j2'))
    press(row('j2'), 'F10', { shiftKey: true })
    const menu = menuNamed('Actions for MM-0002')
    press(document.activeElement as HTMLElement, 'Escape')
    expect(within(menu).queryAllByRole('menuitem', { hidden: true })).toHaveLength(0)
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
  })

  it('leaves right clicks on cell widgets and the menu keys alone when there is no row menu', () =>
  {
    setup({
      reorder: false,
      grid: { renderCell: (job, column) => column.kind === 'actions' ? <button type="button">More {job.number}</button> : null }
    })
    fireEvent.click(row('j2'))
    const event = new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
    row('j2').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="menu"][aria-label^="Actions for"]')).toBeNull()
    const click = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    screen.getByRole('button', { name: 'More MM-0002' }).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it('opens the row menu under a row button, selecting a row outside the selection, and closes on a second press', () =>
  {
    setup({ grid: { renderCell: moreButtonCell } })
    fireEvent.click(row('j1'))
    const more = moreButton('MM-0003')
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    pressButton(more)
    expect(selectedIds()).toEqual(['j3'])
    const menu = menuNamed('Actions for MM-0003')
    expect(within(menu).getByRole('menuitem', { hidden: true, name: 'Move up' })).toBeInTheDocument()
    expect(more).toHaveAttribute('aria-expanded', 'true')
    pressButton(more)
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(within(menu).queryAllByRole('menuitem', { hidden: true })).toHaveLength(0)
  })

  it('moves an open row menu to another row in one press', async () =>
  {
    setup({ grid: { renderCell: moreButtonCell } })
    pressButton(moreButton('MM-0002'))
    expect(moreButton('MM-0002')).toHaveAttribute('aria-expanded', 'true')
    pressButton(moreButton('MM-0004'))
    await act(async () => await new Promise((resolve) => requestAnimationFrame(resolve)))
    expect(moreButton('MM-0002')).toHaveAttribute('aria-expanded', 'false')
    expect(moreButton('MM-0004')).toHaveAttribute('aria-expanded', 'true')
    expect(selectedIds()).toEqual(['j4'])
    expect(within(menuNamed('Actions for MM-0004')).getByRole('menuitem', { hidden: true, name: 'Move up' })).toBeInTheDocument()
  })

  it('keeps a selection the pressed row belongs to, and toggles from the keyboard', () =>
  {
    setup({ grid: { renderCell: moreButtonCell } })
    fireEvent.click(row('j1'))
    fireEvent.click(row('j3'), { shiftKey: true })
    const more = moreButton('MM-0002')
    fireEvent.click(more)
    expect(selectedIds()).toEqual(['j1', 'j2', 'j3'])
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(within(menuNamed('Actions for 3 jobs')).getByRole('menuitem', { hidden: true, name: 'Move up' })).toBeInTheDocument()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('leaves the move items to a view whose row menu brings its own', () =>
  {
    setup({ grid: { ownMoveItems: true, rowMenu: (job) => [{ id: 'up', label: `Move ${job.number} up`, onSelect: () => undefined }] } })
    fireEvent.click(row('j2'))
    press(row('j2'), 'F10', { shiftKey: true })
    const menu = menuNamed('Actions for MM-0002')
    expect(within(menu).getAllByRole('menuitem', { hidden: true }).map((item) => item.textContent)).toEqual(['Move MM-0002 up'])
    expect(within(menu).queryByRole('group', { hidden: true, name: 'Move' })).toBeNull()
  })
})

function moreButtonCell(job: Job, column: GridColumn<Job>, context: GridCellContext): ReactElement | null
{
  return column.kind === 'actions' ? <button type="button" {...context.menuButton} aria-label={`More actions for ${job.number}`} /> : null
}

function moreButton(number: string): HTMLElement
{
  return screen.getByRole('button', { name: `More actions for ${number}` })
}

/** A pointer press: pointerdown, then a click with a pointer's detail. */
function pressButton(button: HTMLElement): void
{
  fireEvent.pointerDown(button)
  fireEvent.click(button, { detail: 1 })
}

function headerButton(name: string): HTMLElement
{
  return screen.getByRole('button', { name })
}

function sortOf(name: string): string | null
{
  return (headerButton(name).closest('[role="columnheader"]') as HTMLElement).getAttribute('aria-sort')
}

describe('DataGrid sorting', () =>
{
  it('keeps the order given while unsorted, then cycles ascending, descending, and back to it', async () =>
  {
    const jobs = makeJobs(5)
    const given = [jobs[2], jobs[0], jobs[4], jobs[1], jobs[3]]
    const { sort } = setup({ rows: given })
    expect(order()).toEqual(['j3', 'j1', 'j5', 'j2', 'j4'])
    expect(document.querySelectorAll('[aria-sort]')).toHaveLength(0)
    fireEvent.click(headerButton('File'))
    expect(sort).toHaveBeenLastCalledWith({ column: 'file', direction: 'ascending' })
    expect(sortOf('File')).toBe('ascending')
    expect(document.querySelectorAll('[aria-sort]')).toHaveLength(1)
    expect(order()).toEqual(['j3', 'j4', 'j2', 'j5', 'j1'])
    await announced('Sorted by File, ascending.')
    fireEvent.click(headerButton('File'))
    expect(sortOf('File')).toBe('descending')
    expect(order()).toEqual(['j1', 'j5', 'j2', 'j4', 'j3'])
    await announced('Sorted by File, descending.')
    fireEvent.click(headerButton('File'))
    expect(sort).toHaveBeenLastCalledWith(null)
    expect(sortOf('File')).toBeNull()
    expect(order()).toEqual(['j3', 'j1', 'j5', 'j2', 'j4'])
    await announced('Back to queue order.')
  })

  it('moves aria-sort to the newly sorted header and says "the order given" by default', async () =>
  {
    setup({ initialSort: { column: 'file', direction: 'descending' }, grid: { unsortedLabel: undefined } })
    fireEvent.click(headerButton('No.'))
    expect(sortOf('No.')).toBe('ascending')
    expect(sortOf('File')).toBeNull()
    expect(order()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5'])
    fireEvent.click(headerButton('No.'))
    fireEvent.click(headerButton('No.'))
    await announced('Back to the order given.')
  })

  it('keeps focus on the same row when a sort reorders the rows', () =>
  {
    setup()
    fireEvent.click(row('j2'))
    fireEvent.click(headerButton('File'))
    expect(selectedIds()).toEqual(['j2'])
    expect(tabStops()).toEqual(['j2'])
  })
})

describe('DataGrid typeahead', () =>
{
  const typeahead = { columnId: 'file', text: (job: Job) => job.name }

  it('jumps to the next row whose text starts with the typed letters or digits', () =>
  {
    vi.useFakeTimers()
    setup({ rows: makeJobs(8), grid: { typeahead } })
    fireEvent.click(row('j1'))
    press(row('j1'), 'b')
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
    press(row('j2'), 'b')
    expect(document.activeElement).toBe(row('j6'))
    press(row('j6'), 'B')
    expect(document.activeElement).toBe(row('j2'))
    act(() => vi.advanceTimersByTime(500))
    press(row('j2'), '1')
    expect(document.activeElement).toBe(row('j8'))
    expect(selectedIds()).toEqual(['j8'])
  })

  it('builds a buffer that resets 500 ms after the last key and never takes Space', () =>
  {
    vi.useFakeTimers()
    setup({ grid: { typeahead } })
    fireEvent.click(row('j1'))
    press(row('j1'), 'c')
    expect(document.activeElement).toBe(row('j5'))
    press(row('j5'), ' ')
    press(row('j5'), 'o')
    expect(document.activeElement).toBe(row('j1'))
    act(() => vi.advanceTimersByTime(499))
    press(row('j1'), 'n')
    expect(document.activeElement).toBe(row('j1'))
    act(() => vi.advanceTimersByTime(500))
    press(row('j1'), '2')
    expect(document.activeElement).toBe(row('j3'))
    press(row('j3'), 'z')
    expect(document.activeElement).toBe(row('j3'))
  })

  it('takes no keys from inside a cell widget and does nothing without a typeahead column', () =>
  {
    setup({
      grid: {
        typeahead,
        renderCell: (job, column) => column.kind === 'actions' ? <button type="button">More {job.number}</button> : null
      }
    })
    fireEvent.click(row('j1'))
    const more = screen.getByRole('button', { name: 'More MM-0001' })
    focusOn(more)
    press(more, 'b')
    expect(document.activeElement).toBe(more)
    expect(selectedIds()).toEqual(['j1'])
    cleanup()
    setup()
    fireEvent.click(row('j1'))
    press(row('j1'), 'b')
    expect(document.activeElement).toBe(row('j1'))
  })
})

/** Replaces the ResizeObserver so a test can report grid widths. */
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

function template(): string
{
  return screen.getByRole('grid').style.getPropertyValue('--ui-grid-columns')
}

describe('DataGrid columns', () =>
{
  it('shows priority 2 columns from 680 px and priority 3 columns from 960 px of grid width', () =>
  {
    const resize = observeWidths()
    setup()
    resize(679)
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 48px')
    expect(screen.queryByRole('columnheader', { name: 'Size' })).toBeNull()
    expect(within(bodyRows()[0]).getAllByRole('gridcell', { hidden: true })).toHaveLength(4)
    resize(680)
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 96px 48px')
    expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument()
    resize(959)
    expect(screen.queryByRole('columnheader', { name: 'Output' })).toBeNull()
    resize(960)
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 96px 160px 48px')
    resize(0)
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 96px 160px 48px')
  })

  it('reads the content box when the observer reports no border box', () =>
  {
    const callbacks: ResizeObserverCallback[] = []
    vi.stubGlobal('ResizeObserver', class
    {
      constructor(callback: ResizeObserverCallback)
      {
        callbacks.push(callback)
      }

      observe(): void {}

      disconnect(): void {}
    })
    setup()
    act(() => callbacks.forEach((callback) => callback([{ contentRect: { width: 700, height: 300 } } as unknown as ResizeObserverEntry], {} as ResizeObserver)))
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 96px 48px')
  })

  it('opens the column menu from a header cell and hides, compacts, and resets columns', () =>
  {
    const { hidden, density, grid } = setup()
    const file = headerButton('File')
    focusOn(file)
    press(file, 'F10', { shiftKey: true })
    let menu = menuNamed('Column options')
    const size = within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Size' })
    expect(size).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(size)
    fireEvent.click(size)
    expect(hidden).toHaveBeenLastCalledWith(['size'])
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 160px 48px')
    expect(document.activeElement).toBe(file)
    fireEvent.contextMenu(file, { button: 2, clientX: 12, clientY: 8 })
    menu = menuNamed('Column options')
    expect(within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Size' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Compact rows' }))
    expect(density).toHaveBeenLastCalledWith('compact')
    expect(grid).toHaveAttribute('data-density', 'compact')
    press(file, 'ContextMenu')
    menu = menuNamed('Column options')
    expect(within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Compact rows' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: 'Reset columns' }))
    expect(hidden).toHaveBeenLastCalledWith([])
    expect(template()).toBe('24px 88px minmax(160px, 1fr) 96px 160px 48px')
    press(file, 'ContextMenu')
    fireEvent.click(within(menuNamed('Column options')).getByRole('menuitemcheckbox', { hidden: true, name: 'Compact rows' }))
    expect(density).toHaveBeenLastCalledWith('default')
  })

  it('notes a checked column that waits for a wider table, and opens from a plain header cell', () =>
  {
    const resize = observeWidths()
    setup({ grid: { onDensityChange: undefined, defaultHiddenColumns: ['output'] } })
    resize(700)
    const actions = screen.getByRole('columnheader', { name: 'Actions' })
    fireEvent.contextMenu(actions)
    const menu = menuNamed('Column options')
    expect(within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Output' })).toHaveAccessibleDescription('Shows when the table is wider')
    expect(within(menu).getByRole('menuitemcheckbox', { hidden: true, name: 'Size' })).not.toHaveAccessibleDescription()
    expect(within(menu).queryByRole('menuitemcheckbox', { hidden: true, name: 'Compact rows' })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { hidden: true, name: 'Reset columns' }))
    expect(screen.queryByRole('columnheader', { name: 'Output' })).toBeNull()
  })

  it('offers only Reset columns when no column is optional', () =>
  {
    const reset = vi.fn()
    setup({ grid: { columns: COLUMNS.map((column) => ({ ...column, optional: false })), onDensityChange: undefined, onHiddenColumnsChange: reset } })
    fireEvent.contextMenu(headerButton('No.'))
    const items = within(menuNamed('Column options')).getAllByRole('menuitem', { hidden: true })
    expect(items).toHaveLength(1)
    fireEvent.click(items[0])
    expect(reset).toHaveBeenCalledWith([])
  })
})

describe('DataGrid header keyboard', () =>
{
  it('keeps one Tab stop in the rows and moves up from the first row into the header and back', () =>
  {
    setup()
    const headerItems = Array.from(document.querySelectorAll<HTMLElement>('[data-header-focus]'))
    expect(headerItems.map((item) => item.tabIndex)).toEqual([-1, -1, -1, -1, -1])
    fireEvent.click(row('j1'))
    press(row('j1'), 'ArrowUp')
    expect(document.activeElement).toBe(headerButton('No.'))
    expect(selectedIds()).toEqual(['j1'])
    press(headerButton('No.'), 'ArrowRight')
    expect(document.activeElement).toBe(headerButton('File'))
    press(headerButton('File'), 'End')
    expect(document.activeElement).toBe(screen.getByRole('columnheader', { name: 'Actions' }))
    press(document.activeElement as HTMLElement, 'Home')
    expect(document.activeElement).toBe(headerButton('No.'))
    press(headerButton('No.'), 'ArrowLeft')
    expect(document.activeElement).toBe(headerButton('No.'))
    press(headerButton('No.'), 'ArrowRight')
    press(headerButton('File'), 'ArrowRight', { shiftKey: true })
    expect(document.activeElement).toBe(headerButton('File'))
    press(headerButton('File'), 'ArrowDown')
    expect(document.activeElement).toBe(row('j1'))
    press(row('j1'), 'ArrowUp')
    expect(document.activeElement).toBe(headerButton('File'))
    press(headerButton('File'), 'a')
    expect(document.activeElement).toBe(headerButton('File'))
  })

  it('starts at the sorted header, stays on the first row with Shift or Ctrl, and makes the header the Tab stop of an empty grid', () =>
  {
    setup({ initialSort: { column: 'size', direction: 'ascending' } })
    const first = bodyRows()[0]
    fireEvent.click(first)
    press(first, 'ArrowUp', { shiftKey: true })
    press(first, 'ArrowUp', { ctrlKey: true })
    expect(document.activeElement).toBe(first)
    press(first, 'ArrowUp')
    expect(document.activeElement).toBe(headerButton('Size'))
    cleanup()
    setup({ rows: [] })
    expect(headerButton('No.').tabIndex).toBe(0)
    press(headerButton('No.'), 'ArrowDown')
    expect(document.activeElement).not.toBe(headerButton('No.'))
  })

  it('makes the header the Tab stop while loading', () =>
  {
    setup({ grid: { loading: true } })
    expect(headerButton('No.').tabIndex).toBe(0)
  })
})

describe('DataGrid row tooltips and Escape', () =>
{
  it('shows the row tooltip after a 500 ms keyboard dwell and dismisses it before the selection clears', () =>
  {
    vi.useFakeTimers()
    setup({ grid: { rowTooltip: (job) => job.name } })
    fireEvent.click(row('j1'))
    press(row('j1'), 'ArrowDown')
    const tip = row('j2').querySelector('[role="tooltip"]') as HTMLElement
    expect(tip).toHaveTextContent('beach.mp4')
    expect(tip).toHaveAttribute('aria-hidden', 'true')
    expect(row('j2')).not.toHaveAttribute('aria-describedby')
    act(() => vi.advanceTimersByTime(499))
    expect(tip).not.toHaveAttribute('data-open')
    act(() => vi.advanceTimersByTime(1))
    expect(tip).toHaveAttribute('data-open')
    press(row('j2'), 'Escape')
    expect(tip).not.toHaveAttribute('data-open')
    expect(selectedIds()).toEqual(['j2'])
    expect(document.activeElement).toBe(row('j2'))
    press(row('j2'), 'Escape')
    expect(selectedIds()).toEqual([])
    expect(document.activeElement).toBe(row('j2'))
  })

  it('stays quiet while arrowing through rows faster than the dwell', () =>
  {
    vi.useFakeTimers()
    setup({ grid: { rowTooltip: (job) => job.name } })
    fireEvent.click(row('j1'))
    for (const id of ['j1', 'j2', 'j3'])
    {
      press(row(id), 'ArrowDown')
      act(() => vi.advanceTimersByTime(200))
    }
    expect(document.querySelectorAll('[role="tooltip"][data-open]')).toHaveLength(0)
  })

  it('renders no tooltip for an empty text', () =>
  {
    setup({ grid: { rowTooltip: (job) => job.id === 'j1' ? '' : job.name } })
    expect(row('j1').querySelector('[role="tooltip"]')).toBeNull()
    expect(row('j2').querySelector('[role="tooltip"]')).not.toBeNull()
  })
})

describe('DataGrid cell menu buttons', () =>
{
  it('opens a cell menu on ArrowDown and leaves the row focus and selection alone', () =>
  {
    const chosen = vi.fn()
    const { selection } = setup({
      grid: {
        renderCell: (job, column) => column.kind === 'actions'
          ? <Menu label={`More for ${job.number}`} trigger={<button type="button">More {job.number}</button>} items={[{ id: 'skip', label: 'Skip', onSelect: chosen }, { id: 'retry', label: 'Retry', onSelect: chosen }]} />
          : job.name
      }
    })
    fireEvent.click(row('j2'))
    press(row('j2'), 'ArrowRight')
    const more = screen.getByRole('button', { name: 'More MM-0002' })
    expect(document.activeElement).toBe(more)
    expect(more).toHaveAttribute('aria-haspopup', 'menu')
    selection.mockClear()
    press(more, 'ArrowDown')
    const menu = menuNamed('More for MM-0002')
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { hidden: true, name: 'Skip' }))
    press(document.activeElement as HTMLElement, 'ArrowDown')
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { hidden: true, name: 'Retry' }))
    press(document.activeElement as HTMLElement, 'End')
    press(document.activeElement as HTMLElement, ' ', {})
    expect(chosen).toHaveBeenCalledTimes(1)
    expect(selection).not.toHaveBeenCalled()
    expect(selectedIds()).toEqual(['j2'])
    expect(tabStops()).toEqual(['j2'])
    expect(document.activeElement).toBe(more)
    press(more, 'Enter')
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { hidden: true, name: 'Skip' }))
    press(document.activeElement as HTMLElement, 'Escape')
    expect(document.activeElement).toBe(more)
    expect(selectedIds()).toEqual(['j2'])
    press(more, 'Escape')
    expect(document.activeElement).toBe(row('j2'))
    expect(selectedIds()).toEqual(['j2'])
  })
})

describe('DataGrid virtualization', () =>
{
  it('sets aria-rowcount and aria-rowindex and mounts only the rows near the viewport plus the focused row', () =>
  {
    const { grid } = setup({ rows: makeJobs(150), initial: createGridSelection(['j120'], 'j120') })
    expect(grid).toHaveAttribute('aria-rowcount', '151')
    expect(within(grid).getAllByRole('row')[0]).toHaveAttribute('aria-rowindex', '1')
    expect(bodyRows().length).toBeLessThan(30)
    expect(row('j1')).toHaveAttribute('aria-rowindex', '2')
    expect(row('j60')).toBeNull()
    expect(row('j120')).toHaveAttribute('aria-rowindex', '121')
    expect(tabStops()).toEqual(['j120'])
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 40 * 36 })
    fireEvent.scroll(grid)
    expect(row('j1')).toBeNull()
    expect(row('j41')).not.toBeNull()
    expect(row('j120')).not.toBeNull()
    const gaps = Array.from(grid.querySelectorAll<HTMLElement>('.ui-grid-gap'))
    expect(gaps.every((gap) => gap.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(gaps[0].style.blockSize).toBe(`${32 * 36}px`)
  })

  it('mounts and focuses a row that keyboard focus reaches outside the window', () =>
  {
    setup({ rows: makeJobs(150), initial: createGridSelection(['j1'], 'j1') })
    focusOn(row('j1'))
    press(row('j1'), 'End')
    expect(document.activeElement).toBe(row('j150'))
    expect(row('j150')).toHaveAttribute('aria-rowindex', '151')
    expect(selectedIds()).toEqual(['j150'])
  })

  it('leaves short lists and loading grids unvirtualized', () =>
  {
    const { grid } = setup({ rows: makeJobs(20), grid: { virtualizeFrom: 50 } })
    expect(grid).not.toHaveAttribute('aria-rowcount')
    expect(bodyRows()).toHaveLength(20)
    expect(row('j1')).not.toHaveAttribute('aria-rowindex')
    fireEvent.scroll(grid)
    expect(bodyRows()).toHaveLength(20)
  })
})
