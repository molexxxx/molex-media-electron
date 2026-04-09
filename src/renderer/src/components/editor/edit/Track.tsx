/**
 * @module editor/edit/Track
 * A single track lane: renders clips that belong to this track.
 */
import React, { useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineTrack, TimelineClip as Clip, MediaSource } from '../types'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import { TimelineClipComponent } from './Clip'

interface TrackProps {
  track: TimelineTrack
  clips: Clip[]
  sources: MediaSource[]
  coords: TimelineCoords
  onClipDragStart: (clipId: string, e: React.MouseEvent) => void
  onTrackDrop: (trackId: string, frame: number) => void
}

export function Track({ track, clips, sources, coords, onClipDragStart, onTrackDrop }: TrackProps): React.JSX.Element {
  const clearSelection = useEditorStore((s) => s.clearSelection)

  const sourceMap = React.useMemo(() => {
    const m: Record<string, MediaSource> = {}
    for (const s of sources) m[s.id] = s
    return m
  }, [sources])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Click on empty area deselects
      if (e.target === e.currentTarget) {
        clearSelection()
      }
    },
    [clearSelection]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const frame = coords.pixelToFrame(px)
      onTrackDrop(track.id, Math.max(0, frame))
    },
    [track.id, coords, onTrackDrop]
  )

  return (
    <div
      className="relative border-b border-white/5"
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
          source={sourceMap[clip.sourceId]}
          trackType={track.type}
          onDragStart={onClipDragStart}
        />
      ))}
    </div>
  )
}
