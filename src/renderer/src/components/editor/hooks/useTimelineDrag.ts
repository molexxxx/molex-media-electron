/**
 * @module components/editor/hooks/useTimelineDrag
 * @description Hook encapsulating timeline scrubbing and in/out handle dragging via pointer-capture.
 */

import React, { useRef, useCallback } from 'react'
import type { Clip } from '../types'

/**
 * Encapsulates timeline scrubbing and in/out handle dragging via
 * pointer-capture on the timeline element.
 */
export function useTimelineDrag(
  clip: Clip | null,
  activeIdx: number,
  seek: (time: number) => void,
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>
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
        setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, inPoint: Math.min(t, c.outPoint - 0.1) } : c))
      } else if (dragTarget.current === 'out') {
        setClips((prev) => prev.map((c, i) => i === activeIdx ? { ...c, outPoint: Math.max(t, c.inPoint + 0.1) } : c))
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
