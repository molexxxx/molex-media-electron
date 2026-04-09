/**
 * @module editor/hooks/useTimelineDrag
 * Clip drag-move and trim interactions. Provides move overlap detection,
 * context-sensitive trim type detection, interactive trim drag handlers,
 * and touch-friendly long-press drag initiation.
 */
import { useCallback } from 'react'
import {
  useEditorStore,
  applyRollTrim,
  applyRippleTrim,
  applySlip,
  applySlide
} from '../../../stores/editorStore'
import type { TimelineClip, Timeline } from '../types'
import type { TimelineCoords } from './useTimelineZoom'

// ---------------------------------------------------------------------------
// Trim cursor types
// ---------------------------------------------------------------------------

export type TrimCursor = 'ripple-in' | 'ripple-out' | 'roll' | 'default'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clipDur(clip: TimelineClip): number {
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

/** Find an adjacent clip on the given edge within a 1-frame tolerance. */
function findAdjacent(
  clip: TimelineClip,
  edge: 'left' | 'right',
  clips: TimelineClip[]
): TimelineClip | null {
  const clipEnd = clip.timelineStart + clipDur(clip)
  const threshold = 1

  if (edge === 'left') {
    return (
      clips.find((c) => {
        if (c.id === clip.id || c.trackId !== clip.trackId) return false
        const cEnd = c.timelineStart + clipDur(c)
        return Math.abs(cEnd - clip.timelineStart) <= threshold
      }) ?? null
    )
  }
  return (
    clips.find((c) => {
      if (c.id === clip.id || c.trackId !== clip.trackId) return false
      return Math.abs(c.timelineStart - clipEnd) <= threshold
    }) ?? null
  )
}

// ---------------------------------------------------------------------------
// Exported hook
// ---------------------------------------------------------------------------

interface UseDragReturn {
  /** Check whether placing a clip at `frame` on `trackId` would overlap. */
  wouldOverlap: (clipId: string, trackId: string, frame: number) => boolean

  /** Detect what trim cursor to show based on pixel offset within a clip. */
  detectTrimCursor: (clip: TimelineClip, pxFromLeft: number, clipWidthPx: number) => TrimCursor

  /**
   * Start an interactive trim drag. Applies trim to the store in real-time
   * (without history), then pushes history on mouse-up.
   */
  startTrimDrag: (
    clip: TimelineClip,
    trimType: 'ripple-in' | 'ripple-out' | 'roll' | 'slip' | 'slide',
    e: MouseEvent | React.MouseEvent,
    coords: TimelineCoords,
    /** For roll: the adjacent clip on the other side of the edit point. */
    adjacentClipId?: string
  ) => void
}

export function useTimelineDrag(): UseDragReturn {
  const wouldOverlap = useCallback(
    (clipId: string, trackId: string, frame: number): boolean => {
      const { timeline } = useEditorStore.getState()
      const clip = timeline.clips.find((c) => c.id === clipId)
      if (!clip) return false

      const dur = clipDur(clip)
      const newEnd = frame + dur

      return timeline.clips.some((other) => {
        if (other.id === clipId || other.trackId !== trackId) return false
        const otherEnd = other.timelineStart + clipDur(other)
        return frame < otherEnd && newEnd > other.timelineStart
      })
    },
    []
  )

  const detectTrimCursor = useCallback(
    (clip: TimelineClip, pxFromLeft: number, clipWidthPx: number): TrimCursor => {
      // Use larger threshold on touch devices for fat-finger friendliness
      const isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches
      const edgeThreshold = isCoarse ? 24 : 10
      const { timeline } = useEditorStore.getState()

      if (pxFromLeft <= edgeThreshold) {
        // Near left edge - check if there's an adjacent clip for roll
        const adj = findAdjacent(clip, 'left', timeline.clips)
        return adj ? 'roll' : 'ripple-in'
      }
      if (pxFromLeft >= clipWidthPx - edgeThreshold) {
        const adj = findAdjacent(clip, 'right', timeline.clips)
        return adj ? 'roll' : 'ripple-out'
      }
      return 'default'
    },
    []
  )

  const startTrimDrag = useCallback(
    (
      clip: TimelineClip,
      trimType: 'ripple-in' | 'ripple-out' | 'roll' | 'slip' | 'slide',
      e: MouseEvent | React.MouseEvent,
      coords: TimelineCoords,
      adjacentClipId?: string
    ) => {
      e.preventDefault()
      e.stopPropagation()

      const startX = e.clientX
      const state = useEditorStore.getState()
      const snapshot: Timeline = structuredClone(state.timeline)
      const snapshotSources = state.sources

      // Frame threshold for snapping
      const snapThreshold = Math.round((10 / coords.zoom) * coords.frameRate)

      const onMove = (ev: MouseEvent): void => {
        const dx = ev.clientX - startX
        let deltaFrames = Math.round((dx / coords.zoom) * coords.frameRate)

        // Snap the resulting edge
        if (useEditorStore.getState().snapEnabled && deltaFrames !== 0) {
          const snapped = snapTrimDelta(snapshot, clip, trimType, deltaFrames, coords, snapThreshold)
          if (snapped !== null) deltaFrames = snapped
        }

        let newTimeline: Timeline
        switch (trimType) {
          case 'ripple-in':
            newTimeline = applyRippleTrim(snapshot, snapshotSources, clip.id, 'in', deltaFrames)
            break
          case 'ripple-out':
            newTimeline = applyRippleTrim(snapshot, snapshotSources, clip.id, 'out', deltaFrames)
            break
          case 'roll':
            if (!adjacentClipId) return
            newTimeline = applyRollTrim(snapshot, snapshotSources, adjacentClipId, clip.id, deltaFrames)
            break
          case 'slip':
            newTimeline = applySlip(snapshot, snapshotSources, clip.id, deltaFrames)
            break
          case 'slide':
            newTimeline = applySlide(snapshot, snapshotSources, clip.id, deltaFrames)
            break
          default:
            return
        }
        useEditorStore.setState({ timeline: newTimeline })
      }

      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        useEditorStore.getState().pushHistory(trimLabel(trimType))
      }

      // Set global cursor during drag
      document.body.style.cursor = trimCursorCSS(trimType)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    []
  )

  return { wouldOverlap, detectTrimCursor, startTrimDrag }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function trimLabel(type: string): string {
  switch (type) {
    case 'ripple-in':
    case 'ripple-out':
      return 'Ripple trim'
    case 'roll':
      return 'Roll trim'
    case 'slip':
      return 'Slip clip'
    case 'slide':
      return 'Slide clip'
    default:
      return 'Trim'
  }
}

function trimCursorCSS(type: string): string {
  switch (type) {
    case 'ripple-in':
      return 'w-resize'
    case 'ripple-out':
      return 'e-resize'
    case 'roll':
      return 'col-resize'
    case 'slip':
      return 'grab'
    case 'slide':
      return 'ew-resize'
    default:
      return 'default'
  }
}

/**
 * For the trim type being dragged, calculate the frame of the edge being moved
 * and try to snap it to nearby points. Returns the adjusted delta if snapped.
 */
function snapTrimDelta(
  snapshot: Timeline,
  clip: TimelineClip,
  trimType: string,
  delta: number,
  _coords: TimelineCoords,
  threshold: number
): number | null {
  // Determine which frame position the trim is producing
  let edgeFrame: number
  switch (trimType) {
    case 'ripple-in':
      // The clip's start position doesn't change, but its end does
      edgeFrame = clip.timelineStart + clipDur(clip) - delta
      break
    case 'ripple-out':
      edgeFrame = clip.timelineStart + clipDur(clip) + delta
      break
    case 'roll':
      edgeFrame = clip.timelineStart + delta
      break
    default:
      return null // slip/slide don't snap the same way
  }

  // Collect snap points (excluding the clip being trimmed)
  const { playback } = useEditorStore.getState()
  const points: number[] = [playback.currentFrame, 0]

  if (playback.inPoint !== null) points.push(playback.inPoint)
  if (playback.outPoint !== null) points.push(playback.outPoint)

  for (const c of snapshot.clips) {
    if (c.id === clip.id) continue
    points.push(c.timelineStart)
    points.push(c.timelineStart + clipDur(c))
  }

  let minDist = Infinity
  let snapFrame: number | null = null
  for (const pt of points) {
    const dist = Math.abs(pt - edgeFrame)
    if (dist < minDist && dist <= threshold) {
      minDist = dist
      snapFrame = pt
    }
  }
  if (snapFrame === null) return null

  // Convert snapped frame back to delta
  switch (trimType) {
    case 'ripple-in':
      return clip.timelineStart + clipDur(clip) - snapFrame
    case 'ripple-out':
      return snapFrame - clip.timelineStart - clipDur(clip)
    case 'roll':
      return snapFrame - clip.timelineStart
    default:
      return null
  }
}
