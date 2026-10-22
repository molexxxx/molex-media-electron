/**
 * @module editor/clip/ClipTimeline
 * Trim's bar: the file's thumbnails or waveform, the kept part framed in accent between the in and out handles,
 * the rest dimmed, and the playhead. Pressing the bar scrubs; the handles sit above the playhead, so a handle
 * always wins where they meet. Each handle is a slider: Left and Right move it a frame, Shift ten, Page Up and
 * Page Down a second, Home and End to its limits.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { cx } from '../../../ui/cx'
import { formatLength } from '../shared/format'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'
import { formatTimecode } from '../shared/TimeDisplay'
import { Waveform } from '../shared/Waveform'
import type { MediaSource } from '../types'

interface ClipTimelineProps
{
  totalFrames: number
  frameRate: number
  seekToFrame: (frame: number) => void
  source: MediaSource
}

type Target = 'in' | 'out' | 'scrub'

/** The bar's height in px. */
export const TRIM_BAR_HEIGHT = 56

/** The handle's hit width in px, centered on its point. */
const HANDLE_HIT = 14

function clamp(value: number, min: number, max: number): number
{
  return Math.max(min, Math.min(max, value))
}

/** The trim bar. */
export function ClipTimeline({ totalFrames, frameRate, seekToFrame, source }: ClipTimelineProps): ReactElement
{
  const barRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState<Target | null>(null)
  const inPoint = useEditorStore((s) => s.clipMode.inPoint)
  const outPoint = useEditorStore((s) => s.clipMode.outPoint)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const safe = totalFrames > 0 ? totalFrames : 1

  useEffect(() =>
  {
    const element = barRef.current
    if (!element)
    {
      return
    }
    const observer = new ResizeObserver((entries) =>
    {
      setWidth(Math.round(entries[0]?.contentRect.width ?? 0))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const frameAt = (clientX: number): number =>
  {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0)
    {
      return 0
    }
    return Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * safe)
  }

  const apply = (target: Target, frame: number): void =>
  {
    const { clipMode, setClipInPoint, setClipOutPoint } = useEditorStore.getState()
    if (target === 'in')
    {
      const next = clamp(frame, 0, clipMode.outPoint - 1)
      setClipInPoint(next)
      seekToFrame(next)
    }
    else if (target === 'out')
    {
      const next = clamp(frame, clipMode.inPoint + 1, totalFrames)
      setClipOutPoint(next)
      seekToFrame(next)
    }
    else
    {
      seekToFrame(frame)
    }
  }

  const startDrag = (target: Target) => (event: PointerEvent<HTMLElement>): void =>
  {
    if (event.button !== 0)
    {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    if (target === 'scrub')
    {
      apply('scrub', frameAt(event.clientX))
    }
    else
    {
      element.focus()
    }
    setDragging(target)
    const move = (moveEvent: globalThis.PointerEvent): void => apply(target, frameAt(moveEvent.clientX))
    const end = (): void =>
    {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', end)
      element.removeEventListener('pointercancel', end)
      setDragging(null)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', end)
    element.addEventListener('pointercancel', end)
  }

  const onHandleKey = (target: 'in' | 'out') => (event: KeyboardEvent<HTMLElement>): void =>
  {
    const { clipMode } = useEditorStore.getState()
    const value = target === 'in' ? clipMode.inPoint : clipMode.outPoint
    const second = Math.max(1, Math.round(frameRate))
    let next: number | null = null
    switch (event.key)
    {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - (event.shiftKey ? 10 : 1)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + (event.shiftKey ? 10 : 1)
        break
      case 'PageDown':
        next = value - second
        break
      case 'PageUp':
        next = value + second
        break
      case 'Home':
        next = target === 'in' ? 0 : clipMode.inPoint + 1
        break
      case 'End':
        next = target === 'in' ? clipMode.outPoint - 1 : totalFrames
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    apply(target, next)
  }

  const pct = (frame: number): number => (clamp(frame, 0, safe) / safe) * 100
  const inPct = pct(inPoint)
  const outPct = pct(outPoint)
  const playPct = pct(currentFrame)
  const thumbHeight = TRIM_BAR_HEIGHT

  const handle = (target: 'in' | 'out', at: number): ReactElement =>
  {
    const label = target === 'in' ? 'In point' : 'Out point'
    const value = target === 'in' ? inPoint : outPoint
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={target === 'in' ? 0 : inPoint + 1}
        aria-valuemax={target === 'in' ? outPoint - 1 : totalFrames}
        aria-valuenow={value}
        aria-valuetext={formatTimecode(value, frameRate)}
        data-handle={target}
        className="group absolute inset-y-0 z-raised flex cursor-ew-resize justify-center rounded-xs"
        style={{ left: `clamp(0px, calc(${at}% - ${HANDLE_HIT / 2}px), calc(100% - ${HANDLE_HIT}px))`, width: HANDLE_HIT }}
        onPointerDown={startDrag(target)}
        onKeyDown={onHandleKey(target)}
      >
        <span
          aria-hidden="true"
          className={cx(
            'my-1 w-1 rounded-xs transition-colors duration-fast',
            dragging === target ? 'bg-accent-pressed' : 'bg-accent group-hover:bg-accent-hover'
          )}
        />
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-line bg-panel px-4 pt-3 pb-2">
      <div
        ref={barRef}
        data-trim-bar
        className="relative overflow-hidden rounded-sm bg-sunken shadow-well select-none"
        style={{ height: TRIM_BAR_HEIGHT }}
        onPointerDown={startDrag('scrub')}
      >
        {width > 20 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {source.width > 0
              ? <ThumbnailStrip filePath={source.filePath} durationSeconds={source.durationSeconds} width={width} height={thumbHeight} />
              : source.audioChannels > 0
                ? <Waveform filePath={source.filePath} width={width} height={thumbHeight} />
                : null}
          </div>
        )}
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 bg-scrim" style={{ width: `${inPct}%` }} />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 bg-scrim" style={{ width: `${100 - outPct}%` }} />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 border-y-2 border-accent"
          style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
        />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-playhead" style={{ left: `${playPct}%` }} />
        {handle('in', inPct)}
        {handle('out', outPct)}
      </div>
      <div className="mt-1 flex justify-between text-label tabular-nums text-ink-3">
        <span>0:00</span>
        <span>{formatLength(source.durationSeconds)}</span>
      </div>
    </div>
  )
}
