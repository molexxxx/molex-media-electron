/**
 * @module editor/edit/Ruler
 * The timeline's time ruler on a canvas, with tick spacing that follows the zoom and the in and out marks. It is
 * where the playhead is grabbed: press or drag anywhere on it to scrub, or focus it and use the arrow keys. The
 * track lanes below never take the playhead, so it never fights a clip edge or a track control.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { fontsReady } from '../../../ui/tokens'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import { useCanvasPalette } from '../shared/canvasPalette'
import { formatTimecode } from '../shared/TimeDisplay'

interface RulerProps
{
  coords: TimelineCoords
  width: number
  headerWidth: number
}

/** The ruler's height in px. */
export const RULER_HEIGHT = 28

/** Interval steps in seconds, chosen so labels never overlap. */
const STEP_CANDIDATES = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

const LABEL_FONT = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'

/** The major and minor tick spacing in seconds for a zoom in px per second; a timecode label needs 96 px. */
export function chooseStep(zoom: number): { major: number, minor: number }
{
  for (const step of STEP_CANDIDATES)
  {
    if (step * zoom >= 96)
    {
      return { major: step, minor: step / 5 }
    }
  }
  return { major: 600, minor: 120 }
}

function setScrubbing(on: boolean): void
{
  useEditorStore.setState((s) => ({ playback: { ...s.playback, isScrubbing: on } }))
}

/** The ruler row: the playhead position over the track headers, then the scrubbable ruler. */
export function Ruler({ coords, width, headerWidth }: RulerProps): ReactElement
{
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { frameRate, zoom, scrollX } = coords
  const palette = useCanvasPalette()
  const seek = useEditorStore((s) => s.seek)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const inPoint = useEditorStore((s) => s.playback.inPoint)
  const outPoint = useEditorStore((s) => s.playback.outPoint)
  const duration = useEditorStore((s) => s.timeline.duration)
  const [fontsLoaded, setFontsLoaded] = useState(false)

  useEffect(() =>
  {
    let alive = true
    void fontsReady(LABEL_FONT).then(() =>
    {
      if (alive)
      {
        setFontsLoaded(true)
      }
    })
    return () =>
    {
      alive = false
    }
  }, [])

  const draw = useCallback(() =>
  {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || width <= 0)
    {
      return
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = RULER_HEIGHT * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, RULER_HEIGHT)

    const { major, minor } = chooseStep(zoom)
    const startSec = scrollX / frameRate
    const endSec = startSec + width / zoom
    const toPx = (seconds: number): number => (seconds - startSec) * zoom

    if (inPoint !== null && outPoint !== null && outPoint > inPoint)
    {
      const left = Math.max(0, toPx(inPoint / frameRate))
      const right = Math.min(width, toPx(outPoint / frameRate))
      ctx.fillStyle = palette.selectionWash
      ctx.fillRect(left, 0, Math.max(0, right - left), RULER_HEIGHT)
    }

    ctx.strokeStyle = palette.grid
    ctx.lineWidth = 1
    for (let t = Math.floor(startSec / minor) * minor; t <= endSec + minor; t += minor)
    {
      const px = Math.round(toPx(t)) + 0.5
      if (px < 0)
      {
        continue
      }
      ctx.beginPath()
      ctx.moveTo(px, 20)
      ctx.lineTo(px, RULER_HEIGHT)
      ctx.stroke()
    }

    ctx.strokeStyle = palette.axis
    ctx.fillStyle = palette.ink3
    ctx.font = LABEL_FONT
    ctx.textBaseline = 'top'
    for (let t = Math.floor(startSec / major) * major; t <= endSec + major; t += major)
    {
      const px = Math.round(toPx(t)) + 0.5
      if (px < -84)
      {
        continue
      }
      ctx.beginPath()
      ctx.moveTo(px, 12)
      ctx.lineTo(px, RULER_HEIGHT)
      ctx.stroke()
      ctx.fillText(formatTimecode(Math.round(t * frameRate), frameRate), px + 4, 1)
    }

    ctx.fillStyle = palette.accentInk
    if (inPoint !== null)
    {
      const px = toPx(inPoint / frameRate)
      if (px >= -2 && px <= width + 2)
      {
        ctx.fillRect(px, 0, 2, RULER_HEIGHT)
      }
    }
    if (outPoint !== null)
    {
      const px = toPx(outPoint / frameRate)
      if (px >= -2 && px <= width + 2)
      {
        ctx.fillRect(px - 2, 0, 2, RULER_HEIGHT)
      }
    }
  }, [width, zoom, scrollX, frameRate, inPoint, outPoint, palette, fontsLoaded])

  useEffect(() =>
  {
    draw()
  }, [draw])

  const frameAt = (clientX: number): number =>
  {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect ? Math.max(0, coords.pixelToFrame(clientX - rect.left)) : 0
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void =>
  {
    if (event.button !== 0)
    {
      return
    }
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    element.focus()
    setScrubbing(true)
    seek(frameAt(event.clientX))
    const move = (moveEvent: globalThis.PointerEvent): void => seek(frameAt(moveEvent.clientX))
    const end = (): void =>
    {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', end)
      element.removeEventListener('pointercancel', end)
      requestAnimationFrame(() => setScrubbing(false))
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', end)
    element.addEventListener('pointercancel', end)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    let next: number
    switch (event.key)
    {
      case 'ArrowLeft':
        next = currentFrame - (event.shiftKey ? 10 : 1)
        break
      case 'ArrowRight':
        next = currentFrame + (event.shiftKey ? 10 : 1)
        break
      case 'PageDown':
        next = currentFrame - Math.round(frameRate)
        break
      case 'PageUp':
        next = currentFrame + Math.round(frameRate)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = duration
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    seek(Math.max(0, next))
  }

  const headLeft = coords.frameToPixel(currentFrame)

  return (
    <div className="flex shrink-0 border-b border-line bg-panel" style={{ height: RULER_HEIGHT }}>
      <div
        className="flex shrink-0 items-center border-e border-line px-2 text-label tabular-nums text-ink-2"
        style={{ width: headerWidth }}
        aria-hidden="true"
      >
        {formatTimecode(currentFrame, frameRate)}
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.max(duration, currentFrame)}
        aria-valuenow={currentFrame}
        aria-valuetext={formatTimecode(currentFrame, frameRate)}
        data-focus="inset"
        data-ruler
        className="relative min-w-0 flex-1 cursor-col-resize touch-none select-none overflow-hidden"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} aria-hidden="true" className="block" style={{ width, height: RULER_HEIGHT }} />
        {headLeft >= 0 && headLeft <= width && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 h-2 w-2.5 -translate-x-1/2 rounded-t-xs bg-playhead"
            style={{ left: headLeft }}
          />
        )}
      </div>
    </div>
  )
}
