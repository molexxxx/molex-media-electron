/**
 * @module ui/OverlayScrollbar
 * @description A thin vertical scrollbar drawn over the edge of a scroller whose own vertical bar is hidden, as the
 * system's overlay scrollbars are: rows run to the edge with no gutter, nothing shifts when the content starts to
 * overflow, and the thumb widens under the pointer. Only the thumb takes the pointer, so controls at the edge stay
 * reachable; wheel and keyboard scrolling stay with the scroller, and the bar is hidden from assistive technology.
 */
import { useEffect, useRef, useState, type PointerEvent, type ReactElement, type RefObject } from 'react'
import { cx } from './cx'

/** The thumb's length and its offset from the top of the track, in px. */
export interface ThumbGeometry
{
  size: number
  offset: number
}

/** The shortest thumb, so a long list keeps a thumb the pointer can catch. */
export const OVERLAY_THUMB_MIN = 32

/** The thumb along a track for a viewport over its content, or null when the content fits. */
export function thumbGeometry(viewport: number, content: number, scroll: number, track: number, min: number = OVERLAY_THUMB_MIN): ThumbGeometry | null
{
  if (content <= viewport + 1 || track <= 0)
  {
    return null
  }
  const size = Math.min(track, Math.max(min, Math.round(track * viewport / content)))
  const progress = Math.min(1, Math.max(0, scroll / (content - viewport)))
  return { size, offset: Math.round((track - size) * progress) }
}

/** The scroll position a thumb dragged `delta` px from `start` reaches, within the content. */
export function scrollForDrag(start: number, delta: number, viewport: number, content: number, track: number, size: number): number
{
  const travel = track - size
  const range = content - viewport
  if (travel <= 0 || range <= 0)
  {
    return start
  }
  return Math.min(range, Math.max(0, start + delta * range / travel))
}

/** Props for {@link OverlayScrollbar}. */
export interface OverlayScrollbarProps
{
  /** The scroller; it hides its own vertical bar and sits in a positioned parent with this bar. */
  target: RefObject<HTMLElement | null>
  /** Space the track leaves at the top, such as a sticky header. */
  insetStart?: number
  className?: string
}

interface Drag
{
  pointerId: number
  startY: number
  startScroll: number
}

/** The overlay bar of `target`; renders nothing while the content fits. */
export function OverlayScrollbar({ target, insetStart = 0, className }: OverlayScrollbarProps): ReactElement | null
{
  const [geometry, setGeometry] = useState<ThumbGeometry | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<Drag | null>(null)

  useEffect(() =>
  {
    const element = target.current
    if (!element)
    {
      return
    }
    let frame = 0
    const measure = (): void =>
    {
      frame = 0
      setGeometry(thumbGeometry(element.clientHeight, element.scrollHeight, element.scrollTop, element.clientHeight - insetStart))
    }
    const schedule = (): void =>
    {
      if (frame === 0)
      {
        frame = requestAnimationFrame(measure)
      }
    }
    measure()
    element.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    for (const child of Array.from(element.children))
    {
      observer.observe(child)
    }
    return () =>
    {
      element.removeEventListener('scroll', schedule)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [target, insetStart])

  if (geometry === null)
  {
    return null
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const element = target.current
    if (event.button !== 0 || !element)
    {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startScroll: element.scrollTop }
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const element = target.current
    const current = drag.current
    if (!element || !current || current.pointerId !== event.pointerId)
    {
      return
    }
    const track = element.clientHeight - insetStart
    element.scrollTop = scrollForDrag(current.startScroll, event.clientY - current.startY, element.clientHeight, element.scrollHeight, track, geometry.size)
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void =>
  {
    if (drag.current?.pointerId !== event.pointerId)
    {
      return
    }
    drag.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  return (
    <div aria-hidden="true" className={cx('ui-overlay-bar', className)} data-dragging={dragging || undefined} style={{ insetBlockStart: insetStart }}>
      <div
        className="ui-overlay-thumb"
        style={{ blockSize: geometry.size, transform: `translateY(${geometry.offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
    </div>
  )
}
