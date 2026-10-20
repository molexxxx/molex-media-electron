/**
 * The Add menu: "Add files…", "Add folder…", "Paste files", the persisted "Include subfolders" check item, the five
 * most recent folders, "Clear recent folders", and, while the view is too narrow for the toolbar's select, the
 * "New files get" submenu. The trigger is unavailable while a picker is open, so a second picker cannot open behind
 * the first.
 */
import React, { type Ref } from 'react'
import { Button, Menu, type MenuEntry, type MenuSubmenuItem } from '../../../ui'
import type { RecentFolder } from '../../../../../shared/jobs/types'
import { formatCount } from '../../../stores/batchFilters'

/** The trigger's text and the menu's name. */
export const ADD_LABEL = 'Add'

/** The words of the Add menu. */
export const ADD_COPY = Object.freeze({
  files: 'Add files…',
  folder: 'Add folder…',
  paste: 'Paste files',
  subfolders: 'Include subfolders',
  recent: 'Recent folders',
  clearRecent: 'Clear recent folders',
  picking: 'A file picker is already open.'
})

/** The chords of the add items, bound by the page's shortcuts. */
export const ADD_SHORTCUTS = Object.freeze({
  files: 'Mod+O',
  folder: 'Mod+Shift+O',
  paste: 'Mod+V'
})

/** How many recent folders the menu lists; main keeps eight. */
export const RECENT_FOLDERS_SHOWN = 5

/** When a folder was added: "Oct 12", with the year when it is not this year. */
export function recentFolderDate(at: number, now: number = Date.now()): string
{
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const format: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  return new Intl.DateTimeFormat('en-US', format).format(date)
}

/** A recent folder's secondary text: "D:\Rips\Podcasts · 212 files · Oct 12". */
export function recentFolderDescription(folder: RecentFolder, now?: number): string
{
  const files = `${formatCount(folder.files)} ${folder.files === 1 ? 'file' : 'files'}`
  return `${folder.path} · ${files} · ${recentFolderDate(folder.addedAt, now)}`
}

/** What the menu runs; each item closes the menu first. */
export interface AddMenuActions
{
  onAddFiles(): void
  onAddFolder(): void
  onPaste(): void
  onToggleSubfolders(): void
  /** Rescans a recent folder: files not yet in the queue are added. */
  onOpenRecent(folder: RecentFolder): void
  onClearRecent(): void
}

/** What the menu shows besides its fixed items. */
export interface AddMenuState
{
  includeSubfolders: boolean
  /** Main's recent folders, newest first. */
  recentFolders: readonly RecentFolder[]
  /** The "New files get" submenu, while the view is too narrow for the toolbar's select. */
  newFiles?: MenuSubmenuItem | null
  /** The clock the folder dates are read against. */
  now?: number
}

/** The menu's entries: the three ways in, "Include subfolders", the recent folders, then "New files get" when given. */
export function addMenuEntries(state: AddMenuState, actions: AddMenuActions): MenuEntry[]
{
  const entries: MenuEntry[] = [
    { id: 'add-files', label: ADD_COPY.files, icon: 'action.addFiles', shortcut: ADD_SHORTCUTS.files, onSelect: actions.onAddFiles },
    { id: 'add-folder', label: ADD_COPY.folder, icon: 'action.addFolder', shortcut: ADD_SHORTCUTS.folder, onSelect: actions.onAddFolder },
    { id: 'paste-files', label: ADD_COPY.paste, icon: 'action.paste', shortcut: ADD_SHORTCUTS.paste, onSelect: actions.onPaste },
    { kind: 'checkbox', id: 'include-subfolders', label: ADD_COPY.subfolders, checked: state.includeSubfolders, onSelect: actions.onToggleSubfolders }
  ]
  const recent = state.recentFolders.slice(0, RECENT_FOLDERS_SHOWN)
  if (recent.length > 0)
  {
    entries.push(
      'separator',
      {
        group: ADD_COPY.recent,
        items: recent.map((folder) => ({
          id: `recent:${folder.path}`,
          label: folder.name,
          description: recentFolderDescription(folder, state.now),
          onSelect: () => actions.onOpenRecent(folder)
        }))
      },
      { id: 'clear-recent', label: ADD_COPY.clearRecent, onSelect: actions.onClearRecent }
    )
  }
  if (state.newFiles !== undefined && state.newFiles !== null)
  {
    entries.push('separator', state.newFiles)
  }
  return entries
}

/** Props of AddMenu. */
export interface AddMenuProps extends AddMenuState, AddMenuActions
{
  /** True while a picker is open. */
  picking?: boolean
  /** Classes of the trigger's text, such as a container query that keeps it for assistive technology only. */
  labelClassName?: string
  triggerRef?: Ref<HTMLButtonElement>
  onOpenChange?(open: boolean): void
}

/** The toolbar's Add menu button. */
export function AddMenu({ picking = false, labelClassName, triggerRef, onOpenChange, ...rest }: AddMenuProps): React.JSX.Element
{
  const trigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      icon="action.addFiles"
      iconEnd="action.openMenu"
      unavailableReason={picking ? ADD_COPY.picking : undefined}
    >
      <span className={labelClassName}>{ADD_LABEL}</span>
    </Button>
  )
  return <Menu trigger={trigger} label={ADD_LABEL} items={addMenuEntries(rest, rest)} onOpenChange={onOpenChange} />
}
