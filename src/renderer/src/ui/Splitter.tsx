import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { cx } from './cx'

/** Props for {@link Splitter}. Sizes are in px and belong to the pane the splitter resizes. */
export interface SplitterProps
{
  /** Names the separator by what it sizes, for example "Inspector width". */
  label: string
  value: number
  min: number
  max: number
  /** Called with every new size while dragging and on each key step, clamped to the limits. */
  onChange(value: number): void
  /** Called once a gesture settles (pointer release, key step, or reset), for persisting the size. */
  onCommit?(value: number): void
  /** The size a double-click restores; without it a double-click does nothing. */
  defaultValue?: number
  /** Which pane `value` sizes: `before` grows as the line moves right, `after` grows as it moves left. */
  pane?: 'before' | 'after'
  /** The key step in px. */
  step?: number
  className?: string
}

/** How far Left and Right move the line, in px. */
export const SPLITTER_STEP = 16

interface Drag
{
  pointerId: number
  startX: number
  startValue: number
  last: number
}

/**
 * A vertical window splitter: a 1 px line with a 24 px hit area centered on it, focusable with an inset
 * ring. Drag it, press Left and Right to step, Home and End to reach the limits, or double-click to
 * reset. Its layout slot stays 1 px wide; the hit area overhangs both neighbors above their content.
 * Dragging needs a single-pointer alternative in the view, such as a menu of fixed sizes.
 */
export function Splitter({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
  defaultValue,
  pane = 'before',
  step = SPLITTER_STEP,
  className
}: SplitterProps): ReactElement
{
  const dragRef = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)))
  const direction = pane === 'before' ? 1 : -1

  const settle = (next: number): void =>
  {
    const clamped = clamp(next)
    if (clamped !== value)
    {
      onChange(clamped)
    }
    onCommit?.(clamped)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    let next: number
    switch (event.key)
    {
      case 'ArrowLeft':
        next = value - step * direction
        break
      case 'ArrowRight':
        next = value + step * direction
        break
      case 'Home':
        next = min
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    event.preventDefault()
    settle(next)
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void =>
  {
    if (event.button !== 0)
    {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, last: value }
    setDragging(true)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId)
    {
      return
    }
    const next = clamp(drag.startValue + (event.clientX - drag.startX) * direction)
    if (next !== drag.last)
    {
      drag.last = next
      onChange(next)
    }
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId)
    {
      return
    }
    dragRef.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    onCommit?.(drag.last)
  }

  const handleDoubleClick = (): void =>
  {
    if (defaultValue !== undefined)
    {
      settle(defaultValue)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      data-focus="inset"
      data-dragging={dragging || undefined}
      className={cx(
        'relative z-(--z-index-splitter) -mx-[11.5px] w-(--size-target-min) shrink-0 cursor-col-resize touch-none self-stretch select-none',
        'before:pointer-events-none before:absolute before:inset-y-0 before:start-[calc(50%-0.5px)] before:border-s before:border-line-strong before:transition-colors before:duration-fast before:ease-out',
        'hover:before:border-line-control-hover data-dragging:before:border-line-control-hover',
        className
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={handleDoubleClick}
    />
  )
}
