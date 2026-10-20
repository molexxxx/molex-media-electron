/**
 * The table region's empty states: the empty queue, which teaches the page's four ideas in order and offers the
 * recent folders, Review with nothing waiting, an empty History, and filters that hide every row.
 */
import React, { useId } from 'react'
import type { RecentFolder } from '../../../../../shared/jobs/types'
import { countOf, PART_SEPARATOR } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { Kbd } from '../../../ui/Kbd'

/** The words of every empty state. */
export const EMPTY_COPY = Object.freeze({
  queueHeading: 'Add media to start a batch',
  queueLine: 'Drop files or folders anywhere on this page, or add them here.',
  addFiles: 'Add files',
  addFolder: 'Add folder',
  howHeading: 'How a batch works',
  recentHeading: 'Recent folders',
  review: 'Nothing waits to start. Add files, or retry returned jobs.',
  history: 'No batches yet. Finished batches are listed here with their reports.',
  filtered: 'No jobs match these filters.',
  clearFilters: 'Clear filters'
})

/** The four ideas of the page, in the order the empty queue teaches them. */
export function howSteps(recipe: string | null): string[]
{
  const first = recipe === null
    ? 'Files you add get the New files operation. Change it before you add.'
    : `Files you add get ${recipe}. Change it under New files before you add.`
  return [
    first,
    'Select rows, then change their settings in the inspector. Ctrl+K sets any operation; Alt+1 to Alt+9 set pinned ones.',
    'Review lists every output path, encoder, and warning before anything runs. Originals are never touched unless you choose Replace originals for that batch.',
    'Start runs the batch. Each finished job is stamped with what was measured in its output.'
  ]
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** "D:\Rips\Podcasts · 212 files · Oct 12". */
export function recentFolderDetail(folder: Pick<RecentFolder, 'path' | 'files' | 'addedAt'>): string
{
  return [folder.path, countOf(folder.files, 'file'), DATE.format(new Date(folder.addedAt))].join(PART_SEPARATOR)
}

/** How many recent folders the empty state lists, as the Add menu does. */
export const RECENT_SHOWN = 5

/** Props of {@link QueueEmptyState}. */
export interface QueueEmptyStateProps
{
  /** The "New files get" recipe, such as "Normalize · Podcast (Apple Podcasts)". */
  recipe: string | null
  recentFolders: readonly RecentFolder[]
  /** Add files is the brass action of the moment while the queue is empty. */
  brass: boolean
  onAddFiles: () => void
  onAddFolder: () => void
  /** Rescans a recent folder. */
  onOpenFolder: (path: string) => void
  /** Disables Add while a file picker is open. */
  busy?: boolean
}

/** The empty queue: what to do first, how a batch works, and the recent folders. */
export function QueueEmptyState({ recipe, recentFolders, brass, onAddFiles, onAddFolder, onOpenFolder, busy = false }: QueueEmptyStateProps): React.JSX.Element
{
  const headingId = useId()
  const howId = useId()
  const recentId = useId()
  const shown = recentFolders.slice(0, RECENT_SHOWN)
  return (
    <section aria-labelledby={headingId} data-empty-state="queue" className="flex max-w-[44rem] flex-col gap-6 px-4 py-6">
      <div className="flex flex-col gap-3">
        <h2 id={headingId} className="text-section text-ink">{EMPTY_COPY.queueHeading}</h2>
        <p className="text-body text-ink-2">{EMPTY_COPY.queueLine}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={brass ? 'primary' : 'secondary'} icon="action.addFiles" onClick={onAddFiles} disabled={busy}>{EMPTY_COPY.addFiles}</Button>
          <Button variant="secondary" icon="action.addFolder" onClick={onAddFolder} disabled={busy}>{EMPTY_COPY.addFolder}</Button>
          <span className="flex items-center gap-2 text-label text-ink-3">
            <Kbd keys={['Mod', 'O']} />
            <span aria-hidden="true">{PART_SEPARATOR.trim()}</span>
            <Kbd keys={['Mod', 'Shift', 'O']} />
            <span aria-hidden="true">{PART_SEPARATOR.trim()}</span>
            <Kbd keys={['Mod', 'V']} />
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h3 id={howId} className="text-body font-semibold text-ink">{EMPTY_COPY.howHeading}</h3>
        <ol aria-labelledby={howId} className="flex list-decimal flex-col gap-1.5 ps-5 text-body text-ink-2 marker:tabular-nums marker:text-ink-3">
          {howSteps(recipe).map((step) => <li key={step} className="max-w-[65ch]">{step}</li>)}
        </ol>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 id={recentId} className="text-body font-semibold text-ink">{EMPTY_COPY.recentHeading}</h3>
          <ul aria-labelledby={recentId} className="flex flex-col">
            {shown.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  onClick={() => onOpenFolder(folder.path)}
                  disabled={busy}
                  className="grid h-8 w-full grid-cols-[10rem_minmax(0,1fr)] items-center gap-4 rounded-sm px-2 text-start text-body hover:bg-wash-hover disabled:text-ink-disabled"
                >
                  <span className="truncate text-ink">{folder.name}</span>
                  <span className="truncate text-label tabular-nums text-ink-2">{recentFolderDetail(folder)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Props of {@link EmptyNote}. */
export interface EmptyNoteProps
{
  kind: 'review' | 'history' | 'filtered'
  /** Clears the list's filters; the filtered note offers it. */
  onClearFilters?: () => void
}

/** A one-line empty state: Review with nothing waiting, an empty History, or filters that hide every row. */
export function EmptyNote({ kind, onClearFilters }: EmptyNoteProps): React.JSX.Element
{
  return (
    <div data-empty-state={kind} className="flex flex-col items-start gap-3 px-4 py-6">
      <p className="text-body text-ink-2">{EMPTY_COPY[kind]}</p>
      {kind === 'filtered' && onClearFilters !== undefined && (
        <Button variant="secondary" size="sm" onClick={onClearFilters}>{EMPTY_COPY.clearFilters}</Button>
      )}
    </div>
  )
}
