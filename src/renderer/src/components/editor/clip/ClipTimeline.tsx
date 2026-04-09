/**
 * @module editor/clip/ClipTimeline
 * Scrub bar with draggable in/out handles for Clip mode.
 *
 * Visual structure:
 *  [IN handle]--selected-region--[OUT handle]
 *  dimmed ░░░   full brightness   ░░░ dimmed
 *          ----------▲----------  (playhead)
 */
import React, { useRef, useCallback, useEffect, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { MediaSource } from '../types'
import { Waveform } from '../shared/Waveform'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'

interface ClipTimelineProps {
  totalFrames: number
  seekToFrame: (frame: number) => void
  source?: MediaSource
}

type DragTarget = 'in' | 'out' | 'playhead' | null

export function ClipTimeline({ totalFrames, seekToFrame, source }: ClipTimelineProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<DragTarget>(null)
  const [barSize, setBarSize] = useState<{ w: number; h: number } | null>(null)

  const inPoint = useEditorStore((s) => s.clipMode.inPoint)
  const outPoint = useEditorStore((s) => s.clipMode.outPoint)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const setClipInPoint = useEditorStore((s) => s.setClipInPoint)
  const setClipOutPoint = useEditorStore((s) => s.setClipOutPoint)

  const safe = totalFrames > 0 ? totalFrames : 1

  // Convert pixel X to frame number
  const pixelToFrame = useCallback(
    (clientX: number): number => {
      const el = containerRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return Math.round(ratio * safe)
    },
    [safe]
  )

  // Percentages for positioning
  const inPct = (inPoint / safe) * 100
  const outPct = (outPoint / safe) * 100
  const playheadPct = (currentFrame / safe) * 100

  // Mouse/touch move handler
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const frame = pixelToFrame(e.clientX)
      if (dragging === 'in') {
        setClipInPoint(Math.min(frame, outPoint - 1))
        seekToFrame(Math.min(frame, outPoint - 1))
      } else if (dragging === 'out') {
        setClipOutPoint(Math.max(frame, inPoint + 1))
        seekToFrame(Math.max(frame, inPoint + 1))
      } else if (dragging === 'playhead') {
        seekToFrame(frame)
      }
    },
    [dragging, inPoint, outPoint, pixelToFrame, seekToFrame, setClipInPoint, setClipOutPoint]
  )

  const onPointerUp = useCallback(() => {
    setDragging(null)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const opts: AddEventListenerOptions = { passive: true }
    window.addEventListener('pointermove', onPointerMove, opts)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [dragging, onPointerMove, onPointerUp])

  // Click on the bar to seek
  const onBarClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) return
      const frame = pixelToFrame(e.clientX)
      seekToFrame(frame)
    },
    [dragging, pixelToFrame, seekToFrame]
  )

  // Handle drag start for in/out handles
  const startDrag = useCallback(
    (target: DragTarget, e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      setDragging(target)
    },
    []
  )

  return (
    <div className="flex flex-col gap-1 px-2">
      {/* Main scrub bar */}
      <div
        ref={(node) => {
          ;(containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
          if (node) {
            const ro = new ResizeObserver((entries) => {
              const e = entries[0]
              if (e) setBarSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) })
            })
            ro.observe(node)
          }
        }}
        className="relative h-10 rounded-md bg-surface-800 cursor-pointer select-none overflow-hidden"
        onClick={onBarClick}
      >
        {/* Waveform / thumbnail background */}
        {source && barSize && barSize.w > 20 && (
          <div className="absolute inset-0 opacity-30 pointer-events-none">
            {source.width > 0 ? (
              <ThumbnailStrip
                filePath={source.filePath}
                durationSeconds={source.durationSeconds}
                width={barSize.w}
                height={barSize.h}
              />
            ) : source.audioChannels > 0 ? (
              <Waveform
                filePath={source.filePath}
                width={barSize.w}
                height={barSize.h}
                color="rgba(124, 58, 237, 0.8)"
              />
            ) : null}
          </div>
        )}

        {/* Dimmed region left of in-point */}
        <div
          className="absolute inset-y-0 left-0 bg-black/50 pointer-events-none"
          style={{ width: `${inPct}%` }}
        />

        {/* Dimmed region right of out-point */}
        <div
          className="absolute inset-y-0 right-0 bg-black/50 pointer-events-none"
          style={{ width: `${100 - outPct}%` }}
        />

        {/* Selected region indicator */}
        <div
          className="absolute inset-y-0 bg-accent-500/10 pointer-events-none"
          style={{ left: `${inPct}%`, width: `${outPct - inPct}%` }}
        />

        {/* In handle - touch-friendly: wider on coarse pointers via CSS */}
        <div
          className="absolute inset-y-0 w-3 cursor-col-resize z-10 group [@media(pointer:coarse)]:w-8"
          style={{ left: `calc(${inPct}% - 6px)` }}
          onPointerDown={(e) => startDrag('in', e)}
        >
          <div className="absolute inset-y-0 left-1/2 w-0.5 bg-accent-400 group-hover:bg-accent-300 transition-colors" />
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-2 h-6 rounded-sm bg-accent-400 group-hover:bg-accent-300 [@media(pointer:coarse)]:w-3 [@media(pointer:coarse)]:h-10 transition-colors" />
        </div>

        {/* Out handle - touch-friendly */}
        <div
          className="absolute inset-y-0 w-3 cursor-col-resize z-10 group [@media(pointer:coarse)]:w-8"
          style={{ left: `calc(${outPct}% - 6px)` }}
          onPointerDown={(e) => startDrag('out', e)}
        >
          <div className="absolute inset-y-0 left-1/2 w-0.5 bg-accent-400 group-hover:bg-accent-300 transition-colors" />
          <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 w-2 h-6 rounded-sm bg-accent-400 group-hover:bg-accent-300 [@media(pointer:coarse)]:w-3 [@media(pointer:coarse)]:h-10 transition-colors" />
        </div>

        {/* Playhead */}
        <div
          className="absolute inset-y-0 w-3 cursor-col-resize z-20 group"
          style={{ left: `calc(${playheadPct}% - 6px)` }}
          onPointerDown={(e) => startDrag('playhead', e)}
        >
          <div className="absolute inset-y-0 left-1/2 w-0.5 bg-red-500" />
          {/* Playhead top handle */}
          <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-red-500 rounded-sm" />
        </div>
      </div>
    </div>
  )
}
