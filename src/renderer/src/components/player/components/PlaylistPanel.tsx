/**
 * The playlist on the DataGrid: the playing track marked in the accent, lengths in tabular figures, reordering by
 * drag and by the move keys, removal by Delete, and one row menu for the More actions button, right click, and
 * Shift+F10. Enter or a double click plays a track.
 */

import { useCallback, useMemo, useState, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { Button } from '../../../ui/Button'
import { DataGrid, type GridCellContext, type GridColumn, type GridMenuButton } from '../../../ui/DataGrid'
import { Icon } from '../../../ui/Icon'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import type { MenuEntry } from '../../../ui/Menu'
import { useGridSelection } from '../../../ui/useGridSelection'
import { cx } from '../../../ui/cx'
import { PLAYER_COPY, playlistSummary } from '../copy'
import { trackFacts } from '../engine/describe'
import type { PlayerEngine } from '../hooks/usePlayer'
import { formatTime, totalDuration, type Track } from '../types'

interface PlaylistRow
{
  id: string
  track: Track
}

/** The playlist's columns: position or the playing mark, title, length, and More actions. */
export const PLAYLIST_COLUMNS: ReadonlyArray<GridColumn<PlaylistRow>> = [
  { id: 'position', label: '#', width: '44px', align: 'end' },
  { id: 'title', label: 'Title', width: 'minmax(120px, 1fr)' },
  { id: 'length', label: 'Length', width: '72px', align: 'end' },
  { id: 'actions', label: 'Actions', width: '48px', kind: 'actions' }
]

const NO_HIDDEN: readonly string[] = []

/** What the playlist's row menu offers beside the move items; the page fills it in. */
export interface PlaylistActions
{
  onShowInfo: (id: string) => void
  onShowInFolder: (path: string) => void
  onCopyLink: (url: string) => void
}

function ActionsCell({ name, button }: { name: string, button: GridMenuButton }): ReactElement
{
  return (
    <button type="button" {...button} aria-label={`More actions for ${name}`} className="ui-icon-button ui-row-actions">
      <Icon name="action.more" size="md" />
    </button>
  )
}

/** The rows a command acts on: the selection when it holds the row, else the row alone. */
export function targetIds(id: string, selected: ReadonlySet<string>, order: readonly string[]): string[]
{
  return selected.has(id) ? order.filter((candidate) => selected.has(candidate)) : [id]
}

/** The playlist panel with its header and the grid. */
export function PlaylistPanel({ player, actions, className, style }: { player: PlayerEngine, actions: PlaylistActions, className?: string, style?: CSSProperties }): ReactElement
{
  const rows = useMemo<PlaylistRow[]>(() => player.tracks.map((track) => ({ id: track.id, track })), [player.tracks])
  const ids = useMemo(() => rows.map((row) => row.id), [rows])
  const [selection, dispatch] = useGridSelection(ids)
  const [confirming, setConfirming] = useState(false)
  const total = totalDuration(player.tracks)
  const currentId = player.current?.id ?? null
  const playing = player.status === 'playing' || player.status === 'loading'

  const removeTargets = useCallback((id: string): void =>
  {
    player.removeIds(targetIds(id, selection.selected, ids))
  }, [player, selection.selected, ids])

  const rowMenu = useCallback((row: PlaylistRow): MenuEntry[] =>
  {
    const { track } = row
    const entries: MenuEntry[] = [{ id: 'play', label: PLAYER_COPY.playNow, icon: 'player.play', shortcut: 'Enter', onSelect: () => player.playId(track.id) }]
    if (track.filePath !== undefined)
    {
      const path = track.filePath
      entries.push({ id: 'info', label: PLAYER_COPY.mediaInfo, icon: 'player.mediaInfo', onSelect: () => actions.onShowInfo(track.id) })
      entries.push({ id: 'reveal', label: PLAYER_COPY.showInFolder, icon: 'action.reveal', onSelect: () => actions.onShowInFolder(path) })
    }
    const link = track.videoUrl ?? (track.filePath === undefined && !track.isBlob ? track.src : undefined)
    if (link !== undefined && link !== '')
    {
      entries.push({ id: 'copy', label: PLAYER_COPY.copyLink, icon: 'action.copy', onSelect: () => actions.onCopyLink(link) })
    }
    entries.push('separator', { id: 'remove', label: PLAYER_COPY.remove, icon: 'action.remove', shortcut: 'Delete', danger: true, onSelect: () => removeTargets(track.id) })
    return entries
  }, [actions, player, removeTargets])

  const onKeyCommand = useCallback((event: KeyboardEvent, focusedId: string | null): boolean =>
  {
    if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && focusedId !== null)
    {
      removeTargets(focusedId)
      return true
    }
    return false
  }, [removeTargets])

  const renderCell = useCallback((row: PlaylistRow, column: GridColumn<PlaylistRow>, context: GridCellContext): ReactNode =>
  {
    const isCurrent = row.id === currentId
    switch (column.id)
    {
      case 'position':
        return isCurrent
          ? (
            <span className="flex text-accent-ink" data-now-playing="">
              <Icon name={playing ? 'player.volume' : 'player.pause'} size="sm" />
              <span className="sr-only">{playing ? 'Playing' : 'Paused'}</span>
            </span>
          )
          : <span className="text-label text-ink-3">{context.index + 1}</span>
      case 'title':
        return <span className={cx('truncate text-body', isCurrent ? 'font-semibold text-accent-ink' : 'text-ink')}>{row.track.name}</span>
      case 'length':
        return <span className={cx('text-label', isCurrent ? 'text-accent-ink' : 'text-ink-2')}>{typeof row.track.duration === 'number' ? formatTime(row.track.duration) : ''}</span>
      default:
        return <ActionsCell name={row.track.name} button={context.menuButton} />
    }
  }, [currentId, playing])

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>): void =>
  {
    const row = (event.target as Element).closest('[role="row"][data-row-id]')
    const id = row?.getAttribute('data-row-id')
    if (id && !(event.target as Element).closest('button'))
    {
      player.playId(id)
    }
  }

  return (
    <section aria-label={PLAYER_COPY.playlist} className={cx('flex min-h-0 min-w-0 flex-col bg-panel', className)} style={style} data-region="playlist">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line ps-4 pe-2">
        {confirming
          ? (
            <InlineConfirm
              question={PLAYER_COPY.clearQuestion}
              safeLabel={PLAYER_COPY.keep}
              confirmLabel={PLAYER_COPY.clearConfirm}
              danger
              size="sm"
              wrap={false}
              onResolve={(confirmed) =>
              {
                setConfirming(false)
                if (confirmed)
                {
                  player.clear()
                }
              }}
            />
          )
          : (
            <>
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="text-body font-semibold text-ink">{PLAYER_COPY.playlist}</h2>
                <span className="truncate text-label text-ink-3 tabular-nums">{playlistSummary(player.tracks.length, formatTime(total.seconds), total.complete)}</span>
              </div>
              <Button variant="ghost" size="sm" icon="action.clearFinished" disabled={player.tracks.length === 0} onClick={() => setConfirming(true)}>{PLAYER_COPY.clear}</Button>
            </>
          )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col" onDoubleClick={onDoubleClick}>
        <DataGrid<PlaylistRow>
          label={PLAYER_COPY.playlist}
          rows={rows}
          columns={PLAYLIST_COLUMNS}
          hiddenColumns={NO_HIDDEN}
          onHiddenColumnsChange={() => undefined}
          selected={selection}
          onSelectionChange={(_next, action) => dispatch(action)}
          unsortedLabel="playlist order"
          onOpen={(id) => player.playId(id)}
          onMoveRows={(moving, to) => player.moveIds(moving, to)}
          onDropRows={(moving, before) => player.dropIds(moving, before)}
          rowLabel={(row) => row.track.name}
          countLabel={(count) => count === 1 ? '1 track' : `${count} tracks`}
          typeahead={{ columnId: 'title', text: (row) => row.track.name }}
          onKeyCommand={onKeyCommand}
          renderCell={renderCell}
          rowMenu={rowMenu}
          rowTooltip={(row) => `${row.track.name}\n${row.track.filePath ?? row.track.videoUrl ?? trackFacts(row.track)}`}
          className="min-h-0 flex-1"
        />
      </div>
    </section>
  )
}
