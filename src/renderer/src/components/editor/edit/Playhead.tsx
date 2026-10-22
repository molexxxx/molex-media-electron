/**
 * @module editor/edit/Playhead
 * The playhead's line across the track lanes. It never takes the pointer: the ruler above is where it is
 * grabbed, so clips and their edges stay fully reachable under it.
 */
import type { ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineCoords } from '../hooks/useTimelineZoom'

interface PlayheadProps
{
  coords: TimelineCoords
  height: number
}

/** The line, or nothing while the playhead is scrolled out of view. */
export function Playhead({ coords, height }: PlayheadProps): ReactElement | null
{
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const left = coords.frameToPixel(currentFrame)
  if (left < 0)
  {
    return null
  }
  return (
    <div
      aria-hidden="true"
      data-playhead
      className="pointer-events-none absolute top-0 z-sticky w-px bg-playhead"
      style={{ left, height }}
    />
  )
}
