/**
 * @module components/editor/hooks/useTimelineDrag
 * @description Hook encapsulating timeline scrubbing and in/out handle dragging via pointer-capture.
 */

import React, { useRef, useCallback } from 'react'
import type { EditorClip } from '../../../stores/editorStore'
import { useEditorStore } from '../../../stores/editorStore'

/**
 * Encapsulates timeline scrubbing and in/out handle dragging via
 * pointer-capture on the timeline element.
 */
export function useTimelineDrag(
  clip: EditorClip | null,
  activeIdx: number,
  seek: (time: number) => void
) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragTarget = useRef<'playhead' | 'in' | 'out' | null>(null)

  const pctToTime = useCallback((e: MouseEvent | React.MouseEvent): number => {
    if (!clip || !timelineRef.current) return 0
    const rect = timelineRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return pct * clip.duration
  }, [clip])

  const handleTimelineMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!clip || !timelineRef.current || e.button !== 0) return
    e.preventDefault()

    const rect = timelineRef.current.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const hitX = pct * clip.duration

    const handleThreshold = clip.duration * 0.015
    if (Math.abs(hitX - clip.inPoint) < handleThreshold) {
      dragTarget.current = 'in'
    } else if (Math.abs(hitX - clip.outPoint) < handleThreshold) {
      dragTarget.current = 'out'
    } else {
      dragTarget.current = 'playhead'
      seek(Math.max(0, Math.min(clip.duration, hitX)))
    }

    const onMove = (me: MouseEvent): void => {
      const t = pctToTime(me)
      if (dragTarget.current === 'playhead') {
        seek(t)
      } else if (dragTarget.current === 'in') {
        useEditorStore.getState().setInPoint(t)
      } else if (dragTarget.current === 'out') {
        useEditorStore.getState().setOutPoint(t)
      }
    }

    const onUp = (): void => {
      dragTarget.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [clip, activeIdx, seek, pctToTime])

  return { timelineRef, handleTimelineMouseDown }
}
