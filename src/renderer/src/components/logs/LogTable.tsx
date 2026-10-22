/**
 * @module components/logs/LogTable
 * @description The log lines on the DataGrid: time, level, source, and message columns, a row menu, Ctrl+C to copy
 * the selected lines, Enter or a double-click to open a line's details, and an error wash under failed lines.
 */

import React, { memo, useMemo, type ReactElement } from 'react'
import { Button, DataGrid, GRID_ACTIONS_WIDTH, Icon, cx, type GridCellContext, type GridColumn, type GridDensity, type GridMenuButton, type GridSelectionState, type IconName, type MenuEntry } from '../../ui'
import type { LogEntry, LogFilter } from '../../stores/types'
import { countOf } from '../../copy/batch'
import {
  clockTime,
  commandText,
  firstLine,
  hiddenLineCount,
  isRawText,
  LEVEL_LABELS,
  levelGroup,
  LOG_WORDS,
  logSource,
  rowId,
  SOURCE_LABELS,
  type LogLevelGroup
} from './logModel'

/** One grid row: the entry under its row id. */
export interface LogRow
{
  id: string
  entry: LogEntry
}

/** The glyph and ink of each level; only the level cell carries status color. */
export const LEVEL_LOOK: Readonly<Record<LogLevelGroup, { icon: IconName, ink: string, word: string }>> = {
  info: { icon: 'action.info', ink: 'text-ink-3', word: 'text-ink-3' },
  warning: { icon: 'status.warning', ink: 'text-warning', word: 'text-warning' },
  error: { icon: 'status.failed', ink: 'text-error', word: 'text-error' }
}

/** The columns, in order; Source drops out first on a narrow grid and can be hidden. */
export const LOG_COLUMNS: ReadonlyArray<GridColumn<LogRow>> = [
  { id: 'time', label: 'Time', width: '84px' },
  { id: 'level', label: 'Level', width: '108px' },
  { id: 'source', label: 'Source', width: '144px', optional: true, priority: 2 },
  { id: 'message', label: 'Message', width: 'minmax(0, 1fr)' },
  { id: 'actions', label: 'Actions', width: GRID_ACTIONS_WIDTH, kind: 'actions' }
]

/** "12 more lines": what a row leaves out, on the button that opens the details. */
export function moreLinesText(count: number): string
{
  return `${countOf(count, 'more line', 'more lines')}`
}

/** A line's level as a glyph and a word. */
export function LevelLabel({ entry, className }: { entry: LogEntry, className?: string }): ReactElement
{
  const group = levelGroup(entry)
  const look = LEVEL_LOOK[group]
  return (
    <span data-level={group} className={cx('inline-flex min-w-0 items-center gap-1.5 text-label', className)}>
      <Icon name={look.icon} size="sm" className={cx('shrink-0', look.ink)} />
      <span className={cx('truncate', look.word)}>{LEVEL_LABELS[group]}</span>
    </span>
  )
}

/** A row's message: its job, the first line (a command or a process's output in mono), and what it leaves out. */
function MessageCell({ entry, showJob, onMore }: { entry: LogEntry, showJob: boolean, onMore: () => void }): ReactElement
{
  const command = commandText(entry)
  const mono = isRawText(entry)
  const hidden = hiddenLineCount(entry)
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {showJob && entry.jobId !== undefined && <span className="shrink-0 text-label tabular-nums text-ink-2">{entry.jobId}</span>}
      <span
        data-part="message"
        className={cx('min-w-0 flex-1 truncate', mono ? 'font-mono text-label' : 'text-body', command !== null || !mono ? 'text-ink' : 'text-ink-2')}
      >
        {firstLine(entry)}
      </span>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onMore}>
          {moreLinesText(hidden)}
        </Button>
      )}
    </span>
  )
}

/** The row's More actions button, which opens the grid's own row menu. */
function ActionsCell({ entry, button }: { entry: LogEntry, button: GridMenuButton }): ReactElement
{
  return (
    <button type="button" {...button} aria-label={`More actions for the ${clockTime(entry)} line`} className="ui-icon-button ui-row-actions">
      <Icon name="action.more" size="md" />
    </button>
  )
}

interface CellProps
{
  row: LogRow
  column: string
  menuButton?: GridMenuButton
  /** Shows each line's job; off while the view shows one job. */
  showJob: boolean
  onMore: (id: string) => void
}

const LogCell = memo(function LogCell({ row, column, menuButton, showJob, onMore }: CellProps): ReactElement | null
{
  const { entry } = row
  switch (column)
  {
    case 'time':
      return <span className="text-label tabular-nums text-ink-3">{clockTime(entry)}</span>
    case 'level':
      return <LevelLabel entry={entry} />
    case 'source':
      return <span className="truncate text-label text-ink-2">{SOURCE_LABELS[logSource(entry)]}</span>
    case 'message':
      return <MessageCell entry={entry} showJob={showJob} onMore={() => onMore(row.id)} />
    case 'actions':
      return menuButton === undefined ? null : <ActionsCell entry={entry} button={menuButton} />
    default:
      return null
  }
})

/** Props for {@link LogTable}. */
export interface LogTableProps
{
  /** The lines that show, oldest first. */
  entries: readonly LogEntry[]
  selection: GridSelectionState
  onSelectionChange: (next: GridSelectionState) => void
  hiddenColumns: readonly string[]
  onHiddenColumnsChange: (hidden: string[]) => void
  density: GridDensity
  onDensityChange: (density: GridDensity) => void
  /** Opens a line's details: Enter, a double-click, the row menu, or a row's "more lines" button. */
  onOpen: (id: string) => void
  /** Copies lines, the selection in display order or one line. */
  onCopy: (entries: LogEntry[]) => void
  onCopyCommand: (command: string) => void
  onShowJob: (entry: LogEntry) => void
  /** Narrows the view to a job's lines. */
  onFilterJob: (jobId: string) => void
  /** The job or batch the view is already narrowed to. */
  filter: LogFilter | null
  className?: string
}

const rowCache = new WeakMap<LogEntry, LogRow>()

function rowFor(entry: LogEntry, index: number): LogRow
{
  const id = rowId(entry, index)
  const cached = rowCache.get(entry)
  if (cached !== undefined && cached.id === id)
  {
    return cached
  }
  const row = { id, entry }
  rowCache.set(entry, row)
  return row
}

/** The lines on a DataGrid with their row menu and copy keys. */
export function LogTable({
  entries,
  selection,
  onSelectionChange,
  hiddenColumns,
  onHiddenColumnsChange,
  density,
  onDensityChange,
  onOpen,
  onCopy,
  onCopyCommand,
  onShowJob,
  onFilterJob,
  filter,
  className
}: LogTableProps): ReactElement
{
  const rows = useMemo(() => entries.map(rowFor), [entries])

  const selectedEntries = (): LogEntry[] => rows.filter((row) => selection.selected.has(row.id)).map((row) => row.entry)

  const rowMenu = (row: LogRow): MenuEntry[] =>
  {
    const { entry } = row
    const many = selection.selected.has(row.id) && selection.selected.size > 1
    const command = commandText(entry)
    const items: MenuEntry[] = [
      many
        ? { id: 'copy-lines', label: `Copy ${countOf(selection.selected.size, 'line')}`, icon: 'action.copy', shortcut: 'Mod+C', onSelect: () => onCopy(selectedEntries()) }
        : { id: 'copy-line', label: LOG_WORDS.copyLine, icon: 'action.copy', shortcut: 'Mod+C', onSelect: () => onCopy([entry]) }
    ]
    if (command !== null && !many)
    {
      items.push({ id: 'copy-command', label: LOG_WORDS.copyCommand, onSelect: () => onCopyCommand(command) })
    }
    if (!many)
    {
      items.push({ id: 'details', label: LOG_WORDS.showDetails, shortcut: 'Enter', onSelect: () => onOpen(row.id) })
    }
    const jobId = entry.jobId
    if (jobId !== undefined && !many)
    {
      items.push('separator', { id: 'show-job', label: `${LOG_WORDS.showJob} ${jobId}`, icon: 'nav.batch', onSelect: () => onShowJob(entry) })
      if (filter === null || !('jobId' in filter) || filter.jobId !== jobId)
      {
        items.push({ id: 'only-job', label: `Show only lines for ${jobId}`, icon: 'action.filter', onSelect: () => onFilterJob(jobId) })
      }
    }
    return items
  }

  const onKeyCommand = (event: KeyboardEvent, focusedId: string | null): boolean =>
  {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c')
    {
      const picked = selectedEntries()
      const focused = rows.find((row) => row.id === focusedId)
      const lines = picked.length > 0 ? picked : focused ? [focused.entry] : []
      if (lines.length > 0)
      {
        onCopy(lines)
      }
      return true
    }
    return false
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void =>
  {
    const target = event.target as Element
    const row = target.closest<HTMLElement>('[role="row"][data-row-id]')
    if (row !== null && target.closest('button') === null)
    {
      onOpen(row.dataset.rowId as string)
    }
  }

  const select = (id: string): void =>
  {
    onSelectionChange({ selected: new Set([id]), anchor: id, focus: id })
    onOpen(id)
  }

  return (
    <div className={cx('flex min-h-0 flex-col', className)} onDoubleClick={onDoubleClick}>
      <DataGrid<LogRow>
        label={LOG_WORDS.gridLabel}
        rows={rows}
        columns={LOG_COLUMNS}
        hiddenColumns={hiddenColumns}
        onHiddenColumnsChange={onHiddenColumnsChange}
        selected={selection}
        onSelectionChange={(next) => onSelectionChange(next)}
        onOpen={onOpen}
        rowLabel={(row) => `the ${clockTime(row.entry)} line`}
        countLabel={(count) => countOf(count, 'line')}
        unsortedLabel="the time order"
        density={density}
        onDensityChange={onDensityChange}
        onKeyCommand={onKeyCommand}
        rowMenu={rowMenu}
        rowTone={(row) => (levelGroup(row.entry) === 'error' ? 'error' : null)}
        renderCell={(row, column, context: GridCellContext) => (
          <LogCell
            row={row}
            column={column.id}
            menuButton={column.kind === 'actions' ? context.menuButton : undefined}
            showJob={filter === null || !('jobId' in filter)}
            onMore={select}
          />
        )}
        className="min-h-0 flex-1"
      />
    </div>
  )
}
