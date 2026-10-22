/**
 * @module editor/edit/TrackHeader
 * A track's header: its name, which selects it as the target for pastes and edits, its show, sound, and lock
 * toggles, and its menu with Remove track. The controls live in the header column, apart from the lanes.
 */
import type { ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { Menu } from '../../../ui/Menu'
import type { TimelineTrack } from '../types'

interface TrackHeaderProps
{
  track: TimelineTrack
  isSelected: boolean
  onSelect: () => void
}

function toggle(trackId: string, key: 'muted' | 'locked' | 'visible'): void
{
  useEditorStore.setState((s) => ({
    timeline: {
      ...s.timeline,
      tracks: s.timeline.tracks.map((t) => (t.id === trackId ? { ...t, [key]: !t[key] } : t))
    }
  }))
}

/** The track's word: "Video track V1". */
export function trackTitle(track: Pick<TimelineTrack, 'type' | 'name'>): string
{
  return `${track.type === 'video' ? 'Video' : 'Audio'} track ${track.name}`
}

/** One header row, as tall as its track. */
export function TrackHeader({ track, isSelected, onSelect }: TrackHeaderProps): ReactElement
{
  const removeTrack = useEditorStore((s) => s.removeTrack)
  const title = trackTitle(track)

  return (
    <div
      data-track-header={track.id}
      className={cx(
        'relative flex items-center gap-1 border-b border-line pe-1 ps-2',
        isSelected ? 'bg-wash-selected' : 'bg-panel'
      )}
      style={{ height: track.height }}
    >
      {isSelected && <span aria-hidden="true" className="absolute inset-y-0 start-0 w-0.5 bg-accent" />}
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={`${title}, target for pastes and edits`}
        className="flex h-(--size-control-sm) min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-start hover:bg-wash-hover"
        onClick={onSelect}
      >
        <span className="text-label font-semibold text-ink">{track.name}</span>
        <span className="truncate text-label text-ink-3">{track.type === 'video' ? 'Video' : 'Audio'}</span>
      </button>
      {track.type === 'video' && (
        <IconButton
          size="sm"
          label={track.visible ? `Hide ${title}` : `Show ${title}`}
          icon={track.visible ? 'editor.visible' : 'editor.hidden'}
          pressed={!track.visible}
          onClick={() => toggle(track.id, 'visible')}
        />
      )}
      <IconButton
        size="sm"
        label={track.muted ? `Unmute ${title}` : `Mute ${title}`}
        icon={track.muted ? 'editor.muted' : 'editor.sound'}
        pressed={track.muted}
        onClick={() => toggle(track.id, 'muted')}
      />
      <IconButton
        size="sm"
        label={track.locked ? `Unlock ${title}` : `Lock ${title}`}
        icon={track.locked ? 'editor.lock' : 'editor.unlock'}
        pressed={track.locked}
        onClick={() => toggle(track.id, 'locked')}
      />
      <Menu
        label={`${title} actions`}
        align="end"
        items={[
          {
            id: 'remove',
            label: 'Remove track',
            icon: 'action.trash',
            danger: true,
            disabled: track.locked,
            disabledReason: track.locked ? 'Unlock the track to remove it.' : undefined,
            onSelect: () => removeTrack(track.id)
          }
        ]}
        trigger={<IconButton size="sm" label={`More actions for ${title}`} icon="action.more" />}
      />
    </div>
  )
}
