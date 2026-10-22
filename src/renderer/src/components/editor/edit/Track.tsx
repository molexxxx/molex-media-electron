/**
 * @module editor/edit/Track
 * One track lane and its clips. A press on the empty lane clears the selection; a source dragged from the
 * source bin drops here at the pointer.
 */
import { useCallback, useMemo, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { cx } from '../../../ui/cx'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import type { MediaSource, TimelineClip, TimelineTrack } from '../types'
import { TimelineClipComponent } from './Clip'

interface TrackProps
{
  track: TimelineTrack
  clips: TimelineClip[]
  sources: MediaSource[]
  coords: TimelineCoords
  isSelected: boolean
  onClipDragStart: (clipId: string, event: MouseEvent) => void
  onTrackDrop: (trackId: string, frame: number) => boolean
}

/** The lane. */
export function Track({ track, clips, sources, coords, isSelected, onClipDragStart, onTrackDrop }: TrackProps): ReactElement
{
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources])

  const handleMouseDown = useCallback((event: MouseEvent) =>
  {
    if (event.target === event.currentTarget)
    {
      clearSelection()
    }
  }, [clearSelection])

  const handleDragOver = useCallback((event: DragEvent) =>
  {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback((event: DragEvent) =>
  {
    const rect = event.currentTarget.getBoundingClientRect()
    if (onTrackDrop(track.id, Math.max(0, coords.pixelToFrame(event.clientX - rect.left))))
    {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [track.id, coords, onTrackDrop])

  return (
    <div
      data-track-lane={track.id}
      className={cx('track-lane relative border-b border-line', isSelected && 'bg-wash-hover')}
      style={{ height: track.height }}
      onMouseDown={handleMouseDown}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {clips.map((clip) => (
        <TimelineClipComponent
          key={clip.id}
          clip={clip}
          coords={coords}
          source={sourceMap.get(clip.sourceId)}
          trackType={track.type}
          onDragStart={onClipDragStart}
        />
      ))}
    </div>
  )
}
