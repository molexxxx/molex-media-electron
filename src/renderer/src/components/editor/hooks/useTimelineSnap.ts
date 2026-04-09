/**
 * @module editor/hooks/useTimelineSnap
 * Snap-to-edges system for drag/trim operations.
 */
import { useCallback, useMemo, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'

export interface SnapPoint {
  frame: number
  type: 'clip-edge' | 'playhead' | 'marker'
}

export interface UseTimelineSnapReturn {
  /** Whether snap is enabled. */
  enabled: boolean
  /** Toggle snap. */
  toggle: () => void
  /** Collect all snap points from the current timeline. */
  collectSnapPoints: (excludeClipIds?: string[]) => SnapPoint[]
  /** Given a frame, return the nearest snap target within threshold, or null. */
  findSnap: (frame: number, thresholdFrames: number, excludeClipIds?: string[]) => number | null
  /** Frame currently snapped to (for visual indicator). */
  snapIndicator: number | null
  /** Show a snap indicator at the given frame. */
  showSnapIndicator: (frame: number | null) => void
}

export function useTimelineSnap(): UseTimelineSnapReturn {
  const enabled = useEditorStore((s) => s.snapEnabled)
  const setSnapEnabled = useEditorStore((s) => s.setSnapEnabled)
  const [snapIndicator, setSnapIndicator] = useState<number | null>(null)

  const toggle = useCallback(() => {
    setSnapEnabled(!useEditorStore.getState().snapEnabled)
  }, [setSnapEnabled])

  const collectSnapPoints = useCallback((excludeClipIds?: string[]): SnapPoint[] => {
    const { timeline, playback } = useEditorStore.getState()
    const points: SnapPoint[] = []
    const excludeSet = excludeClipIds ? new Set(excludeClipIds) : null

    // Playhead
    points.push({ frame: playback.currentFrame, type: 'playhead' })

    // Timeline in/out points
    if (playback.inPoint !== null) {
      points.push({ frame: playback.inPoint, type: 'marker' })
    }
    if (playback.outPoint !== null) {
      points.push({ frame: playback.outPoint, type: 'marker' })
    }

    // All clip edges (excluding specified clips)
    for (const clip of timeline.clips) {
      if (excludeSet?.has(clip.id)) continue
      const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
      points.push({ frame: clip.timelineStart, type: 'clip-edge' })
      points.push({ frame: clip.timelineStart + dur, type: 'clip-edge' })
    }

    return points
  }, [])

  const findSnap = useCallback(
    (frame: number, thresholdFrames: number, excludeClipIds?: string[]): number | null => {
      if (!useEditorStore.getState().snapEnabled) return null
      const points = collectSnapPoints(excludeClipIds)
      let nearest: number | null = null
      let minDist = Infinity
      for (const sp of points) {
        const dist = Math.abs(sp.frame - frame)
        if (dist < minDist && dist <= thresholdFrames) {
          minDist = dist
          nearest = sp.frame
        }
      }
      return nearest
    },
    [collectSnapPoints]
  )

  const showSnapIndicator = useCallback((frame: number | null) => {
    setSnapIndicator(frame)
  }, [])

  return useMemo(
    () => ({ enabled, toggle, collectSnapPoints, findSnap, snapIndicator, showSnapIndicator }),
    [enabled, toggle, collectSnapPoints, findSnap, snapIndicator, showSnapIndicator]
  )
}
