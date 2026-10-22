/**
 * @module editor/shell/ShortcutsDialog
 * The editor's keyboard map on the shared dialog, grouped by where the keys act and drawn as keycaps.
 */
import { Fragment, useId, type ReactElement } from 'react'
import { Button } from '../../../ui/Button'
import { Dialog } from '../../../ui/Dialog'
import { Kbd, splitChord } from '../../../ui/Kbd'

/** One line of the map: what the keys do and the chords that do it. */
export interface EditorShortcut
{
  label: string
  /** Alternative chords in Windows words, with Mod for Ctrl (Cmd on macOS). */
  keys: readonly string[]
  /** Words shown instead of keys, for a gesture such as Ctrl and the scroll wheel. */
  text?: string
}

/** One area of the map. */
export interface EditorShortcutGroup
{
  id: string
  title: string
  entries: readonly EditorShortcut[]
}

/** Every editor key, by where it acts. */
export const EDITOR_SHORTCUTS: readonly EditorShortcutGroup[] = [
  {
    id: 'general',
    title: 'Editor',
    entries: [
      { label: 'Open a file', keys: ['Mod+O'] },
      { label: 'Trim, Timeline, Inspect', keys: ['Mod+1', 'Mod+2', 'Mod+3'] },
      { label: 'Keyboard shortcuts', keys: ['?', 'F1'] }
    ]
  },
  {
    id: 'playback',
    title: 'Playback',
    entries: [
      { label: 'Play or pause', keys: ['Space'] },
      { label: 'Step one frame', keys: ['Left', 'Right'] },
      { label: 'Step ten frames', keys: ['Shift+Left', 'Shift+Right'] },
      { label: 'Go to the start or the end', keys: ['Home', 'End'] },
      { label: 'Play backward, stop, play forward', keys: ['J', 'K', 'L'] }
    ]
  },
  {
    id: 'trim',
    title: 'Trim',
    entries: [
      { label: 'Mark in at the playhead', keys: ['I'] },
      { label: 'Mark out at the playhead', keys: ['O'] },
      { label: 'Reset in and out to the whole file', keys: ['Esc'] }
    ]
  },
  {
    id: 'timeline',
    title: 'Timeline',
    entries: [
      { label: 'Select tool', keys: ['V'] },
      { label: 'Trim tool', keys: ['T'] },
      { label: 'Split tool', keys: ['B'] },
      { label: 'Snap to edges', keys: ['N'] },
      { label: 'Split at the playhead', keys: ['S'] },
      { label: 'Delete the selected clips', keys: ['Delete', 'Backspace'] },
      { label: 'Delete and close the gap', keys: ['Shift+Delete'] },
      { label: 'Mark in or out at the playhead', keys: ['I', 'O'] },
      { label: 'Clear in and out, then the selection', keys: ['Esc'] },
      { label: 'Insert the source at the playhead', keys: [','] },
      { label: 'Overwrite at the playhead', keys: ['.'] },
      { label: 'Previous or next edit point', keys: ['Up', 'Down'] }
    ]
  },
  {
    id: 'clips',
    title: 'Clips',
    entries: [
      { label: 'Select every clip', keys: ['Mod+A'] },
      { label: 'Clear the selection', keys: ['Mod+D'] },
      { label: 'Copy, cut, paste', keys: ['Mod+C', 'Mod+X', 'Mod+V'] },
      { label: 'Undo', keys: ['Mod+Z'] },
      { label: 'Redo', keys: ['Mod+Shift+Z'] }
    ]
  },
  {
    id: 'view',
    title: 'Timeline view',
    entries: [
      { label: 'Zoom in or out', keys: ['Mod+=', 'Mod+-'] },
      { label: 'Fit the timeline to the view', keys: ['Mod+0'] },
      { label: 'Zoom at the pointer', keys: [], text: 'Ctrl and scroll' },
      { label: 'Scroll sideways', keys: [], text: 'Shift and scroll' }
    ]
  }
]

function ShortcutRow({ entry }: { entry: EditorShortcut }): ReactElement
{
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 py-0.5">
      <dt className="min-w-0 text-body text-ink-2">{entry.label}</dt>
      <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {entry.text !== undefined
          ? <span className="text-body text-ink-3">{entry.text}</span>
          : entry.keys.map((chord, index) => (
            <Fragment key={chord}>
              {index > 0 && <span className="text-label text-ink-3">or</span>}
              <Kbd keys={splitChord(chord)} />
            </Fragment>
          ))}
      </dd>
    </div>
  )
}

function ShortcutSection({ group }: { group: EditorShortcutGroup }): ReactElement
{
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-group={group.id} className="flex flex-col">
      <h3 id={headingId} className="type-legend pb-1 text-accent-ink">{group.title}</h3>
      <dl>
        {group.entries.map((entry) => <ShortcutRow key={entry.label} entry={entry} />)}
      </dl>
    </section>
  )
}

/** Props of {@link ShortcutsDialog}. */
export interface ShortcutsDialogProps
{
  open: boolean
  onClose: () => void
}

/** The keyboard map in a modal dialog that Escape, Close, and the ? key close. */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps): ReactElement
{
  const actions = <Button onClick={onClose}>Close</Button>
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md" closedBy="any" actions={actions}>
      <div className="flex max-h-[min(30rem,calc(100vh-14rem))] flex-col gap-4 overflow-y-auto pe-2">
        {EDITOR_SHORTCUTS.map((group) => <ShortcutSection key={group.id} group={group} />)}
      </div>
    </Dialog>
  )
}
