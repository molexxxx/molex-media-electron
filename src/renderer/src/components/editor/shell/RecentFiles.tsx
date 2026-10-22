/**
 * @module editor/shell/RecentFiles
 * The empty editor's recent files: a quiet grid of name, length, and when each file was opened. Enter or a
 * double click opens a file; the row menu opens it in another mode, shows it in its folder, or forgets it.
 */
import { useEffect, useId, useMemo, useState, type ReactElement } from 'react'
import { clearRecentFiles, getRecentFiles, removeRecentFile, type RecentFile } from '../../../utils/recentFiles'
import { Button } from '../../../ui/Button'
import { DataGrid, type GridColumn, type GridMenuButton, type GridRowBase } from '../../../ui/DataGrid'
import { Icon } from '../../../ui/Icon'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import type { MenuEntry } from '../../../ui/Menu'
import { createGridSelection, type GridSelectionState } from '../../../ui/useGridSelection'
import { EDITOR_MODES } from '../modes'
import { formatLength, formatOpened } from '../shared/format'
import type { EditorMode } from '../types'

/** One recent file as a grid row, keyed by its path. */
export interface RecentRow extends GridRowBase
{
  file: RecentFile
}

/** The recent files, kept current as files are opened or forgotten anywhere in the app. */
export function useRecentFiles(): RecentFile[]
{
  const [recents, setRecents] = useState<RecentFile[]>(() => getRecentFiles())
  useEffect(() =>
  {
    const refresh = (): void => setRecents(getRecentFiles())
    window.addEventListener('molex:recents-changed', refresh)
    window.addEventListener('storage', refresh)
    return () =>
    {
      window.removeEventListener('molex:recents-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return recents
}

const COLUMNS: ReadonlyArray<GridColumn<RecentRow>> = [
  { id: 'name', label: 'Name', width: 'minmax(12rem, 1fr)', sortable: true, sortValue: (row) => row.file.fileName },
  { id: 'length', label: 'Length', width: '6rem', align: 'end', sortable: true, sortValue: (row) => row.file.durationSec ?? null },
  { id: 'opened', label: 'Opened', width: '9.5rem', sortable: true, sortValue: (row) => -row.file.openedAt },
  { id: 'actions', label: 'Actions', width: '48px', kind: 'actions' }
]

function RowActions({ name, button }: { name: string, button: GridMenuButton }): ReactElement
{
  return (
    <button type="button" {...button} aria-label={`More actions for ${name}`} className="ui-icon-button ui-row-actions">
      <Icon name="action.more" size="md" />
    </button>
  )
}

/** Props of {@link RecentFiles}. */
export interface RecentFilesProps
{
  /** The mode a plain open goes to. */
  mode: EditorMode
  onOpen: (filePath: string, mode: EditorMode) => void
}

/** The recent files grid with its heading and the Clear list confirmation; nothing while the list is empty. */
export function RecentFiles({ mode, onOpen }: RecentFilesProps): ReactElement | null
{
  const headingId = useId()
  const recents = useRecentFiles()
  const rows = useMemo<RecentRow[]>(() => recents.map((file) => ({ id: file.filePath, file })), [recents])
  const [selected, setSelected] = useState<GridSelectionState>(() => createGridSelection())
  const [confirming, setConfirming] = useState(false)

  if (rows.length === 0)
  {
    return null
  }

  const open = (id: string, target: EditorMode = mode): void =>
  {
    onOpen(id, target)
  }

  const menu = (row: RecentRow): MenuEntry[] => [
    { id: 'open', label: 'Open', shortcut: 'Enter', onSelect: () => open(row.id) },
    {
      id: 'open-in',
      kind: 'submenu',
      label: 'Open in',
      items: EDITOR_MODES.map((entry) => ({ id: entry.value, label: entry.label, onSelect: () => open(row.id, entry.value) }))
    },
    { id: 'reveal', label: 'Show in folder', icon: 'action.reveal', onSelect: () => void window.api.showInFolder(row.id) },
    'separator',
    { id: 'forget', label: 'Remove from recent files', icon: 'action.remove', shortcut: 'Delete', onSelect: () => removeRecentFile(row.id) }
  ]

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-line">
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 px-4">
        <h2 id={headingId} className="text-body font-semibold text-ink">Recent files</h2>
        {confirming
          ? (
              <InlineConfirm
                question="Clear the recent files list?"
                safeLabel="Keep"
                confirmLabel="Clear list"
                danger
                size="sm"
                onResolve={(yes) =>
                {
                  setConfirming(false)
                  if (yes)
                  {
                    clearRecentFiles()
                  }
                }}
              />
            )
          : <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>Clear list</Button>}
      </div>
      <DataGrid<RecentRow>
        label="Recent files"
        rows={rows}
        columns={COLUMNS}
        hiddenColumns={[]}
        onHiddenColumnsChange={() => undefined}
        selected={selected}
        onSelectionChange={(next) => setSelected(next)}
        unsortedLabel="most recent first"
        onOpen={(id) => open(id)}
        rowLabel={(row) => row.file.fileName}
        countLabel={(count) => (count === 1 ? '1 file' : `${count} files`)}
        typeahead={{ columnId: 'name', text: (row) => row.file.fileName }}
        onKeyCommand={(event, focusedId) =>
        {
          if (event.key === 'Delete' && focusedId !== null)
          {
            removeRecentFile(focusedId)
            return true
          }
          return false
        }}
        rowMenu={menu}
        ownMoveItems
        rowTooltip={(row) => row.file.filePath}
        renderCell={(row, column, context) =>
        {
          switch (column.id)
          {
            case 'name':
              return <span className="truncate text-ink">{row.file.fileName}</span>
            case 'length':
              return <span className="text-ink-2">{formatLength(row.file.durationSec)}</span>
            case 'opened':
              return <span className="truncate tabular-nums text-ink-2">{formatOpened(row.file.openedAt)}</span>
            case 'actions':
              return <RowActions name={row.file.fileName} button={context.menuButton} />
            default:
              return null
          }
        }}
        className="min-h-0 flex-1"
      />
    </section>
  )
}
