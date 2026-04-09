/**
 * @module editor/edit/Playhead
 * Red vertical line spanning full timeline height, draggable.
 */
import React, { useCallback, useRef } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineCoords } from '../hooks/useTimelineZoom'

interface PlayheadProps {
  coords: TimelineCoords
  height: number
  /** Ref to the track area container - used for stable drag coordinates. */
  trackAreaRef: React.RefObject<HTMLDivElement | null>
}

export function Playhead({ coords, height, trackAreaRef }: PlayheadProps): React.JSX.Element {
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const seek = useEditorStore((s) => s.seek)
  const dragging = useRef(false)

  const left = coords.frameToPixel(currentFrame)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragging.current = true

      // Use the track area for stable rect - the playhead wrapper moves during drag
      const areaEl = trackAreaRef.current
      if (!areaEl) return

      const onMove = (ev: MouseEvent): void => {
        if (!dragging.current) return
        const rect = areaEl.getBoundingClientRect()
        const px = ev.clientX - rect.left
        const frame = coords.pixelToFrame(px)
        seek(Math.max(0, frame))
      }

      const onUp = (): void => {
        dragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [coords, seek, trackAreaRef]
  )

  if (left < 0) return <></>

  return (
    <div
      className="absolute top-0 z-20 pointer-events-none"
      style={{ left, height }}
    >
      {/* Draggable handle */}
      <div
        className="pointer-events-auto cursor-col-resize absolute -left-[5px] top-0 w-[11px] h-3 bg-red-500 rounded-b-sm"
        onMouseDown={handleMouseDown}
      />
      {/* Line */}
      <div className="w-px h-full bg-red-500" />
    </div>
  )
}
