/**
 * @module editor/shell/EditorHeader
 * The editor's header: the mode switch, the open file with its menu, and the editor-wide actions.
 */
import type { ReactElement, ReactNode } from 'react'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { Tabs } from '../../../ui/Tabs'
import { EDITOR_MODES } from '../modes'
import type { EditorMode, MediaSource } from '../types'
import { useRecentFiles } from './RecentFiles'

/** How many other recent files the file menu lists. */
export const FILE_MENU_RECENTS = 6

/** Props of {@link EditorHeader}. */
export interface EditorHeaderProps
{
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
  /** The id the mode tabs and the mode panel share. */
  tabsId: string
  /** The active file, which Trim and Inspect show. */
  source: MediaSource | undefined
  loading: boolean
  onOpenDialog: () => void
  onOpenPath: (filePath: string) => void
  onCloseFile: () => void
  onShowShortcuts: () => void
  /** The mode's own header actions, such as the timeline's Export. */
  children?: ReactNode
}

function FileMenu({ source, onOpenDialog, onOpenPath, onCloseFile }: Pick<EditorHeaderProps, 'onOpenDialog' | 'onOpenPath' | 'onCloseFile'> & { source: MediaSource }): ReactElement
{
  const recents = useRecentFiles().filter((file) => file.filePath !== source.filePath).slice(0, FILE_MENU_RECENTS)
  const items: MenuEntry[] = []
  if (recents.length > 0)
  {
    items.push({
      group: 'Recent files',
      items: recents.map((file) => ({ id: file.filePath, label: file.fileName, onSelect: () => onOpenPath(file.filePath) }))
    })
    items.push('separator')
  }
  items.push(
    { id: 'open', label: 'Open another file', icon: 'action.browse', shortcut: 'Mod+O', onSelect: onOpenDialog },
    { id: 'reveal', label: 'Show in folder', icon: 'action.reveal', onSelect: () => void window.api.showInFolder(source.filePath) },
    'separator',
    { id: 'close', label: 'Close file', icon: 'action.close', onSelect: onCloseFile }
  )
  return (
    <Menu
      label={`File ${source.fileName}`}
      items={items}
      trigger={(
        <Button variant="ghost" size="sm" iconEnd="action.openMenu" aria-label={`${source.fileName}, file menu`} className="min-w-0 max-w-80">
          <span className="min-w-0 truncate text-ink">{source.fileName}</span>
        </Button>
      )}
    />
  )
}

/** The header row. */
export function EditorHeader({ mode, onModeChange, tabsId, source, loading, onOpenDialog, onOpenPath, onCloseFile, onShowShortcuts, children }: EditorHeaderProps): ReactElement
{
  return (
    <header className="flex h-11 shrink-0 items-stretch gap-3 border-b border-line bg-panel pe-3 ps-1">
      <Tabs<EditorMode>
        id={tabsId}
        label="Editor modes"
        value={mode}
        onChange={onModeChange}
        tabs={EDITOR_MODES.map((entry) => ({ value: entry.value, label: entry.label }))}
        className="self-end"
      />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {source !== undefined && (
          <FileMenu source={source} onOpenDialog={onOpenDialog} onOpenPath={onOpenPath} onCloseFile={onCloseFile} />
        )}
        <div className="min-w-0 flex-1" />
        {children}
        {source !== undefined && (
          <Button variant="ghost" size="sm" icon="action.browse" loading={loading} loadingLabel="Opening" onClick={onOpenDialog}>
            Open
          </Button>
        )}
        <IconButton label="Keyboard shortcuts" icon="action.shortcuts" size="sm" shortcut="?" onClick={onShowShortcuts} />
      </div>
    </header>
  )
}
