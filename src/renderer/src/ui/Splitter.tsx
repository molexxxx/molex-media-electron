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
  /**
   * Which pane `value` sizes: `before` (left, or above) grows as the line moves right or down, `after` (right, or
   * below) grows as it moves left or up.
   */
  pane?: 'before' | 'after'
  /** `vertical` (the default) splits side by side; `horizontal` stacks the panes and moves with Up and Down. */
  orientation?: 'vertical' | 'horizontal'
  /** The key step in px. */
  step?: number
  className?: string
}

/** How far the arrow keys move the line, in px. */
export const SPLITTER_STEP = 16

interface Drag
{
  pointerId: number
  start: number
  startValue: number
  last: number
}

const LAYOUT = {
  vertical: {
    box: 'w-(--size-target-min) cursor-col-resize self-stretch before:inset-y-0 before:border-s',
    before: '-ms-[21px] -me-[2px] before:start-[21px]',
    after: '-ms-[2px] -me-[21px] before:start-[2px]'
  },
  horizontal: {
    box: 'h-(--size-target-min) cursor-row-resize before:inset-x-0 before:border-t',
    before: '-mt-[21px] -mb-[2px] before:top-[21px]',
    after: '-mt-[2px] -mb-[21px] before:top-[2px]'
  }
} as const

/**
 * A window splitter: a 1 px line with a 24 px hit area, focusable with an inset ring. Drag it, press Left and Right
 * (Up and Down when horizontal) to step, Home and End to reach the limits, or double-click to reset. Its layout slot
 * stays 1 px; the hit area reaches 2 px over the other pane and the rest over the pane it sizes, whose padding takes
 * it, so the scrollbar and edge controls of the other pane stay reachable.
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
  orientation = 'vertical',
  step = SPLITTER_STEP,
  className
}: SplitterProps): ReactElement
{
  const dragRef = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)))
  const direction = pane === 'before' ? 1 : -1
  const along = (event: PointerEvent<HTMLDivElement>): number => (orientation === 'vertical' ? event.clientX : event.clientY)
  const layout = LAYOUT[orientation]

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
    const [back, forward] = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    let next: number
    switch (event.key)
    {
      case back:
        next = value - step * direction
        break
      case forward:
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
    dragRef.current = { pointerId: event.pointerId, start: along(event), startValue: value, last: value }
    setDragging(true)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void =>
  {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId)
    {
      return
    }
    const next = clamp(drag.startValue + (along(event) - drag.start) * direction)
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
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${value} pixels`}
      tabIndex={0}
      data-focus="inset"
      data-dragging={dragging || undefined}
      className={cx(
        'relative z-(--z-index-splitter) shrink-0 touch-none select-none',
        layout.box,
        pane === 'after' ? layout.after : layout.before,
        'before:pointer-events-none before:absolute before:border-line-strong before:transition-colors before:duration-fast before:ease-out',
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
