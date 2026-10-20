import { cloneElement, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { hidePopover, showPopover } from './platform'
import type { TooltipPlacement } from './Tooltip'

/** The props a popover sets on its trigger. */
interface PopoverTriggerProps
{
  className?: string
  style?: CSSProperties
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
}

/** Props for {@link Popover}. */
export interface PopoverProps
{
  /** The button that opens and closes the popover. */
  trigger: ReactElement<PopoverTriggerProps>
  /** The content, or a function that receives `close` for content that finishes the task. */
  children: ReactNode | ((close: () => void) => ReactNode)
  /** The popover's accessible name. */
  label: string
  placement?: TooltipPlacement
  onOpenChange?: (open: boolean) => void
  /** Where focus lands on open: the first focusable element, or the popover itself. */
  initialFocus?: 'first' | 'container'
  /** Classes for the popover box, such as a width. */
  className?: string
}

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'

function firstFocusable(container: HTMLElement): HTMLElement | null
{
  for (const element of container.querySelectorAll<HTMLElement>(FOCUSABLE))
  {
    if (!element.matches(':disabled') && !element.closest('[inert]'))
    {
      return element
    }
  }
  return null
}

/**
 * Non-modal interactive content in the top layer, anchored to its trigger, so it escapes clipping ancestors.
 * Focus moves inside on open and returns to the trigger when the popover closes with focus inside it or
 * nowhere: on Escape, on light dismiss, from the trigger, or through `close`. Tab can leave it, which closes
 * it and leaves focus where Tab put it. A press on the open trigger keeps focus inside, so its click closes
 * the popover instead of a blur closing it and the click opening it again. The trigger reports the state
 * through `aria-expanded`, kept in sync with the platform's `toggle` event, and shows a raised fill while open.
 */
export function Popover({
  trigger,
  children,
  label,
  placement = 'bottom',
  onOpenChange,
  initialFocus = 'first',
  className
}: PopoverProps): ReactElement
{
  const id = useId()
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const reported = useRef(false)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const anchorName = `--pop-${id.replace(/[^\w-]/g, '')}`

  const close = (): void => setOpen(false)

  useEffect(() =>
  {
    const popover = popoverRef.current as HTMLDivElement
    if (open)
    {
      showPopover(popover)
      const target = initialFocus === 'first' ? firstFocusable(popover) ?? popover : popover
      target.focus()
    }
    else
    {
      const focused = document.activeElement
      const focusInside = popover.contains(focused)
      hidePopover(popover)
      if (reported.current && (focusInside || focused === null || focused === document.body))
      {
        triggerRef.current?.focus()
      }
    }
    if (reported.current !== open)
    {
      reported.current = open
      onOpenChangeRef.current?.(open)
    }
    if (!open)
    {
      return
    }
    const onToggle = (event: Event): void =>
    {
      if ((event as ToggleEvent).newState === 'closed')
      {
        setOpen(false)
      }
    }
    popover.addEventListener('toggle', onToggle)
    return () => popover.removeEventListener('toggle', onToggle)
  }, [open, initialFocus])

  const props = trigger.props
  const anchoredTrigger = cloneElement(trigger, {
    popoverTarget: id,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': id,
    className: cx(props.className, 'aria-expanded:bg-raised'),
    style: { ...props.style, anchorName: cx(props.style?.anchorName && `${props.style.anchorName},`, anchorName) },
    onMouseDown: (event: MouseEvent<HTMLElement>) =>
    {
      props.onMouseDown?.(event)
      if (open)
      {
        event.preventDefault()
      }
    },
    onClick: (event: MouseEvent<HTMLElement>) =>
    {
      props.onClick?.(event)
      if (event.defaultPrevented)
      {
        return
      }
      event.preventDefault()
      triggerRef.current = event.currentTarget
      setOpen((current) => !current)
    }
  } as Partial<PopoverTriggerProps>)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key === 'Escape' && !event.defaultPrevented)
    {
      event.preventDefault()
      close()
    }
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void =>
  {
    const next = event.relatedTarget
    if (next instanceof Node && !event.currentTarget.contains(next))
    {
      close()
    }
  }

  return (
    <>
      {anchoredTrigger}
      <div
        ref={popoverRef}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-placement={placement}
        data-open={open || undefined}
        className={cx('ui-popover rounded-md border border-line-strong bg-overlay p-3 text-ink shadow-overlay', className)}
        style={{ positionAnchor: anchorName }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      >
        {typeof children === 'function' ? children(close) : children}
      </div>
    </>
  )
}
