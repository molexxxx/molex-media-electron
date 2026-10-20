import { Children, cloneElement, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { Kbd, splitChord } from './Kbd'
import { hidePopover, showPopover } from './platform'

/** The side of the trigger a tooltip prefers; it flips when that side has no room. */
export type TooltipPlacement = 'top' | 'bottom' | 'start' | 'end'

/** `describe` adds the tooltip to the trigger's description; `label` repeats the trigger's name visually only. */
export type TooltipMode = 'describe' | 'label'

/** The hover delay before a tooltip shows. */
export const TOOLTIP_DELAY_MS = 500
/** How long a tooltip waits after the pointer leaves, so the pointer can move onto it. */
export const TOOLTIP_GRACE_MS = 100
/** After a tooltip hides, the next one shows on hover without a delay for this long. */
export const TOOLTIP_WARM_MS = 300
/** The keyboard dwell for tooltips on grid rows and cells, so arrowing through rows stays quiet. */
export const GRID_FOCUS_DELAY_MS = 500

/** The trigger props a tooltip merges with its own. */
interface TriggerProps
{
  children?: ReactNode
  'aria-describedby'?: string
  style?: CSSProperties
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
}

/** Props for {@link Tooltip}. */
export interface TooltipProps
{
  /** Plain text; an empty string renders the trigger alone. */
  content: string
  /** One focusable trigger element, or an element whose descendant takes focus. */
  children: ReactElement<TriggerProps>
  placement?: TooltipPlacement
  /** A chord such as "Mod+Shift+P", drawn as keycaps after the text. */
  shortcut?: string
  /** Milliseconds of hover before showing. */
  delay?: number
  /** Milliseconds of keyboard focus before showing; {@link GRID_FOCUS_DELAY_MS} on grid rows and cells. */
  focusDelay?: number
  mode?: TooltipMode
  /**
   * Renders the tip as the trigger's last child, so the trigger stays one element in its parent's layout.
   * The tip is then hidden from assistive technology in both modes; `describe` still references it.
   */
  inside?: boolean
}

let keyboardModality = true
let modalityTracked = false
let lastHiddenAt = Number.NEGATIVE_INFINITY

/** Follows whether the last interaction was a key or a pointer, which is what `:focus-visible` decides on. */
function trackModality(): void
{
  if (modalityTracked)
  {
    return
  }
  modalityTracked = true
  document.addEventListener('keydown', () =>
  {
    keyboardModality = true
  }, true)
  document.addEventListener('pointerdown', () =>
  {
    keyboardModality = false
  }, true)
  document.addEventListener('mousedown', () =>
  {
    keyboardModality = false
  }, true)
}

function within(container: Element, node: EventTarget | null): boolean
{
  return node instanceof Node && container.contains(node)
}

/**
 * A plain-text hint in the top layer, anchored to its trigger. It shows after `delay` on hover (at once when
 * another tooltip closed moments ago) and after `focusDelay` on keyboard focus, never on pointer focus. It
 * stays while the pointer moves onto it and hides on pointer leave after a short grace, on blur, on pointer
 * down, when an ancestor scrolls, and on Escape, which it consumes so a grid keeps its selection; focus never
 * moves. The text is the trigger's description in `describe` mode and hidden from assistive technology in
 * `label` mode, where the trigger already carries it as its name.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
  shortcut,
  delay = TOOLTIP_DELAY_MS,
  focusDelay = 0,
  mode = 'describe',
  inside = false
}: TooltipProps): ReactElement
{
  const tipId = useId()
  const [open, setOpen] = useState(false)
  const tipRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(false)
  const focusedRef = useRef(false)
  const showTimer = useRef<number | undefined>(undefined)
  const hideTimer = useRef<number | undefined>(undefined)
  const shown = open && Boolean(content)
  const anchorName = `--tip-${tipId.replace(/[^\w-]/g, '')}`

  const clearTimers = (): void =>
  {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
    showTimer.current = undefined
    hideTimer.current = undefined
  }

  const show = (): void =>
  {
    clearTimers()
    openRef.current = true
    setOpen(true)
  }

  const hide = (): void =>
  {
    clearTimers()
    if (openRef.current)
    {
      openRef.current = false
      lastHiddenAt = Date.now()
      setOpen(false)
    }
  }

  const schedule = (wait: number): void =>
  {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = undefined
    if (openRef.current)
    {
      return
    }
    if (wait <= 0)
    {
      show()
      return
    }
    if (showTimer.current === undefined)
    {
      showTimer.current = window.setTimeout(show, wait)
    }
  }

  const leave = (): void =>
  {
    window.clearTimeout(showTimer.current)
    showTimer.current = undefined
    if (openRef.current && !focusedRef.current && hideTimer.current === undefined)
    {
      hideTimer.current = window.setTimeout(hide, TOOLTIP_GRACE_MS)
    }
  }

  useEffect(trackModality, [])

  useEffect(() => () =>
  {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
  }, [])

  useEffect(() =>
  {
    const tip = tipRef.current
    if (!tip)
    {
      return
    }
    if (!shown)
    {
      hidePopover(tip)
      return
    }
    showPopover(tip)
    const onToggle = (event: Event): void =>
    {
      if ((event as ToggleEvent).newState === 'closed')
      {
        hide()
      }
    }
    const onKeyDown = (event: KeyboardEvent): void =>
    {
      if (event.key === 'Escape')
      {
        event.preventDefault()
        hide()
      }
    }
    const onScroll = (event: Event): void =>
    {
      const trigger = triggerRef.current
      if (event.target === document || (trigger && within(event.target as Element, trigger)))
      {
        hide()
      }
    }
    tip.addEventListener('toggle', onToggle)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', onScroll, true)
    return () =>
    {
      tip.removeEventListener('toggle', onToggle)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [shown])

  const child = Children.only(children)
  const props = child.props

  if (!content)
  {
    return <>{inside ? cloneElement(child, { children: <>{props.children}{null}</> }) : child}{null}</>
  }

  const tip = (
    <span
      ref={tipRef}
      id={tipId}
      popover="hint"
      role="tooltip"
      aria-hidden={mode === 'label' || inside || undefined}
      data-placement={placement}
      data-open={shown || undefined}
      className="ui-tooltip max-w-70 rounded-sm border border-line-strong bg-overlay px-2 py-1 text-start text-label font-normal whitespace-normal text-ink shadow-overlay"
      style={{ positionAnchor: anchorName }}
      onPointerEnter={() =>
      {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = undefined
      }}
      onPointerLeave={leave}
    >
      {content}
      {shortcut && <Kbd keys={splitChord(shortcut)} className="ms-2" />}
    </span>
  )

  const trigger = cloneElement(child, {
    ...(inside ? { children: <>{props.children}{tip}</> } : null),
    'aria-describedby': mode === 'describe' ? cx(props['aria-describedby'], tipId) : props['aria-describedby'],
    style: { ...props.style, anchorName: cx(props.style?.anchorName && `${props.style.anchorName},`, anchorName) },
    onPointerEnter: (event: PointerEvent<HTMLElement>) =>
    {
      props.onPointerEnter?.(event)
      if (event.pointerType === 'touch')
      {
        return
      }
      triggerRef.current = event.currentTarget
      schedule(Date.now() - lastHiddenAt < TOOLTIP_WARM_MS ? 0 : delay)
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) =>
    {
      props.onPointerLeave?.(event)
      leave()
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) =>
    {
      props.onPointerDown?.(event)
      focusedRef.current = false
      hide()
    },
    onFocus: (event: FocusEvent<HTMLElement>) =>
    {
      props.onFocus?.(event)
      if (within(event.currentTarget, event.relatedTarget) || !keyboardModality)
      {
        return
      }
      triggerRef.current = event.currentTarget
      focusedRef.current = true
      schedule(focusDelay)
    },
    onBlur: (event: FocusEvent<HTMLElement>) =>
    {
      props.onBlur?.(event)
      if (within(event.currentTarget, event.relatedTarget))
      {
        return
      }
      focusedRef.current = false
      hide()
    }
  })

  return <>{trigger}{inside ? null : tip}</>
}
