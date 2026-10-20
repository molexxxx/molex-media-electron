import { Fragment, useEffect, useId, useRef, type FocusEvent, type KeyboardEvent, type ReactElement } from 'react'
import { formatKeys, type Platform } from '../../../../../shared/text/platform'
import { IconButton } from '../../../ui/IconButton'
import { Kbd, splitChord, usePlatform } from '../../../ui/Kbd'
import { hidePopover, showPopover } from '../../../ui/platform'
import { canFocus, focusIsLost } from './focus'

/** The popover's accessible name, also the overflow menu item that opens it. */
export const SHORTCUTS_LABEL = 'Keyboard shortcuts'

/** One line of the shortcuts list. Chords are written in Windows words, with Mod for Ctrl (Cmd on macOS). */
export interface ShortcutEntry
{
  label: string
  /** Alternative chords, or the two ends of a range when `range` is set. */
  keys: readonly string[]
  range?: boolean
  /** Chords macOS uses instead, where its keys differ in more than their names. */
  mac?: readonly string[]
  /** Words shown instead of keys, for an action no key performs ("Type a name"). */
  text?: string
  /** Words macOS shows instead of keys. */
  macText?: string
}

/** One area of the keyboard map. */
export interface ShortcutGroup
{
  id: string
  title: string
  entries: readonly ShortcutEntry[]
}

/** The keyboard map of the Batch view, grouped by where the keys act. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: 'table',
    title: 'Table',
    entries: [
      { label: 'Move focus and selection', keys: ['Down', 'Up'] },
      { label: 'Extend the selection', keys: ['Shift+Down', 'Shift+Up'] },
      { label: 'Move focus only', keys: ['Mod+Down', 'Mod+Up'] },
      { label: 'Select or deselect the focused row', keys: ['Space', 'Mod+Space'], mac: ['Space'] },
      { label: 'Select up to the focused row', keys: ['Shift+Space'] },
      { label: 'First or last row, Shift extends', keys: ['Home', 'End'] },
      { label: 'One page down or up, Shift extends', keys: ['PageDown', 'PageUp'] },
      { label: 'Select every row shown', keys: ['Mod+A'] },
      { label: 'Open in the inspector', keys: ['Enter'] },
      { label: 'Move between the row\'s controls', keys: ['Right', 'Left'] },
      { label: 'Jump to a file by name', keys: [], text: 'Type a name' },
      { label: 'Row menu', keys: ['Shift+F10', 'Menu'], macText: 'Ctrl+click, or More actions' },
      { label: 'Close, then clear the selection', keys: ['Esc'] },
      { label: 'Keyboard shortcuts', keys: ['?'] }
    ]
  },
  {
    id: 'jobs',
    title: 'Jobs',
    entries: [
      { label: 'Apply pinned operation 1 to 9', keys: ['Alt+1', 'Alt+9'], range: true },
      { label: 'Add a job with pinned operation 1 to 9', keys: ['Alt+Shift+1', 'Alt+Shift+9'], range: true },
      { label: 'Set operation', keys: ['Mod+K'] },
      { label: 'Remove, skip, or clear the selected jobs', keys: ['Delete'] },
      { label: 'Cancel the selected running jobs', keys: ['Shift+Delete'] },
      { label: 'Duplicate', keys: ['Mod+D'] },
      { label: 'Move up or down one place', keys: ['Alt+Up', 'Alt+Down'] },
      { label: 'Move to the top or bottom', keys: ['Alt+Home', 'Alt+End'] },
      { label: 'Copy as text', keys: ['Mod+C'] },
      { label: 'Add the files on the clipboard', keys: ['Mod+V'] },
      { label: 'Undo', keys: ['Mod+Z'] },
      { label: 'Redo', keys: ['Mod+Y', 'Mod+Shift+Z'], mac: ['Mod+Shift+Z'] }
    ]
  },
  {
    id: 'batch',
    title: 'Batch',
    entries: [
      { label: 'Review, Start, or the next action', keys: ['Mod+Enter'] },
      { label: 'Start only the selected jobs', keys: ['Mod+Shift+Enter'] },
      { label: 'Pause or resume', keys: ['Mod+P'] },
      { label: 'Next or previous job that needs attention', keys: ['F8', 'Shift+F8'] },
      { label: 'Add files', keys: ['Mod+O'] },
      { label: 'Add folder', keys: ['Mod+Shift+O'] }
    ]
  },
  {
    id: 'view',
    title: 'View',
    entries: [
      { label: 'Queue, Review, Run, History', keys: ['Mod+1', 'Mod+4'], range: true },
      { label: 'Search', keys: ['Mod+F'] },
      { label: 'Show or hide the inspector', keys: ['Mod+I'] },
      { label: 'From the inspector back to the row', keys: ['Esc'] },
      { label: 'Next or previous region', keys: ['F6', 'Shift+F6'] },
      { label: 'Back to the History list', keys: ['Backspace'] },
      { label: 'Back to Batch from Logs', keys: ['Alt+Left'] },
      { label: 'Keyboard shortcuts', keys: ['Mod+/', 'F1'] }
    ]
  }
]

/** An entry as one platform shows it: chord key lists in that platform's order, or words. */
export interface ResolvedShortcut
{
  label: string
  chords: string[][]
  joiner: 'or' | 'to'
  text: string | null
}

/** One entry resolved for a platform. */
export function resolveShortcut(entry: ShortcutEntry, platform: Platform): ResolvedShortcut
{
  const mac = platform === 'darwin'
  const text = mac ? entry.macText ?? entry.text ?? null : entry.text ?? null
  const keys = mac && entry.mac !== undefined ? entry.mac : entry.keys
  return {
    label: entry.label,
    chords: text === null ? keys.map(splitChord) : [],
    joiner: entry.range === true ? 'to' : 'or',
    text
  }
}

/** An entry's keys as plain text in the platform's words: "Ctrl+P", "Option+1 to Option+9". */
export function shortcutText(entry: ShortcutEntry, platform: Platform): string
{
  const resolved = resolveShortcut(entry, platform)
  if (resolved.text !== null)
  {
    return resolved.text
  }
  return resolved.chords.map((chord) => formatKeys(chord, platform)).join(` ${resolved.joiner} `)
}

function ShortcutRow({ entry, platform }: { entry: ShortcutEntry, platform: Platform }): ReactElement
{
  const resolved = resolveShortcut(entry, platform)
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 py-0.5">
      <dt className="min-w-0 text-body text-ink-2">{resolved.label}</dt>
      <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1 tabular-nums">
        {resolved.text !== null
          ? <span className="text-body text-ink-3">{resolved.text}</span>
          : resolved.chords.map((chord, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="text-label text-ink-3">{resolved.joiner}</span>}
              <Kbd keys={chord} platform={platform} />
            </Fragment>
          ))}
      </dd>
    </div>
  )
}

function ShortcutSection({ group, platform }: { group: ShortcutGroup, platform: Platform }): ReactElement
{
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-group={group.id} className="mb-4 break-inside-avoid">
      <h3 id={headingId} className="type-legend pb-1 text-accent-ink">{group.title}</h3>
      <dl>
        {group.entries.map((entry) => <ShortcutRow key={`${entry.label}:${entry.keys.join(',')}`} entry={entry} platform={platform} />)}
      </dl>
    </section>
  )
}

/** Props for {@link ShortcutsPopover}. */
export interface ShortcutsPopoverProps
{
  open: boolean
  onClose: () => void
  /** Overrides the platform from the nearest PlatformProvider. */
  platform?: Platform
  /** Where focus goes on close when the element focused before opening is gone, such as an overflow menu item. */
  fallbackFocus?: () => HTMLElement | null
}

/**
 * The Batch view's keyboard map in a non-modal popover, grouped by area and written in the platform's words. The
 * page opens it on Ctrl+/ or F1, on "?" from the table, and from the batch overflow menu. Escape, Close, and light
 * dismiss close it and return focus to the element focused before it opened (or `fallbackFocus`); Tab out of it
 * closes it and leaves focus where Tab put it.
 */
export function ShortcutsPopover({ open, onClose, platform, fallbackFocus }: ShortcutsPopoverProps): ReactElement
{
  const contextPlatform = usePlatform()
  const resolvedPlatform = platform ?? contextPlatform
  const popoverRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, fallbackFocus })
  latest.current = { onClose, fallbackFocus }

  useEffect(() =>
  {
    const element = popoverRef.current
    if (element === null || !open)
    {
      return undefined
    }
    const doc = element.ownerDocument
    const active = doc.activeElement
    const returnTo = active instanceof HTMLElement && active !== doc.body ? active : null
    const onToggle = (event: Event): void =>
    {
      if ((event as Event & { newState?: string }).newState === 'closed')
      {
        latest.current.onClose()
      }
    }
    showPopover(element)
    element.focus()
    element.addEventListener('toggle', onToggle)
    return () =>
    {
      element.removeEventListener('toggle', onToggle)
      const hadFocus = element.contains(doc.activeElement) || focusIsLost(doc)
      hidePopover(element)
      if (!hadFocus)
      {
        return
      }
      if (canFocus(returnTo))
      {
        returnTo.focus()
        return
      }
      latest.current.fallbackFocus?.()?.focus()
    }
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key === 'Escape')
    {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void =>
  {
    const next = event.relatedTarget
    if (next instanceof Node && !event.currentTarget.contains(next))
    {
      onClose()
    }
  }

  return (
    <div
      ref={popoverRef}
      popover="auto"
      role="dialog"
      aria-label={SHORTCUTS_LABEL}
      tabIndex={-1}
      data-open={open || undefined}
      className="@container max-h-[min(36rem,calc(100vh-4rem))] w-[min(52rem,calc(100vw-2rem))] overflow-y-auto rounded-md border border-line-strong bg-overlay text-ink shadow-overlay"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {open && (
        <>
          <div className="sticky top-0 flex items-center justify-between gap-4 border-b border-line bg-overlay py-2 pr-2 pl-4">
            <h2 className="text-section font-semibold text-ink">{SHORTCUTS_LABEL}</h2>
            <IconButton icon="action.close" label="Close" size="sm" onClick={onClose} />
          </div>
          <div className="gap-8 px-4 pt-3 @[44rem]:columns-2">
            {SHORTCUT_GROUPS.map((group) => <ShortcutSection key={group.id} group={group} platform={resolvedPlatform} />)}
          </div>
        </>
      )}
    </div>
  )
}
