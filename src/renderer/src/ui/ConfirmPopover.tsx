import { useId, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { cx } from './cx'
import { ConfirmChoices, focusAfterConfirm, focusedElement, type FocusFallback } from './InlineConfirm'
import { hidePopover, showPopover } from './platform'
import type { TooltipPlacement } from './Tooltip'

/** Props for {@link ConfirmPopover}. */
export interface ConfirmPopoverProps
{
  /** The control that asked, or the focused row when a key asked; the popover anchors to it and focus returns to it. */
  anchor: HTMLElement | null
  /** The question, which also names the dialog. */
  question: string
  /** The choice that keeps things as they are, such as "Keep queued"; it comes first and takes focus. */
  safeLabel: string
  /** The choice that goes ahead, such as "Cancel job". */
  confirmLabel: string
  /** Draws the confirm choice in the danger variant. */
  danger?: boolean
  /** Called once with the choice; the owner then unmounts the popover. */
  onResolve: (confirmed: boolean) => void
  /** The slot's stable element, focused after the choice when the anchor is gone. */
  fallbackFocus?: FocusFallback
  placement?: TooltipPlacement
  className?: string
}

const ANCHOR_NAME = 'anchor-name'

/** Adds `name` to the element's anchor names, beside any it already has, and returns the undo. */
function addAnchorName(element: HTMLElement, name: string): () => void
{
  const names = (): string[] => element.style.getPropertyValue(ANCHOR_NAME).split(',').map((part) => part.trim()).filter(Boolean)
  element.style.setProperty(ANCHOR_NAME, [...names(), name].join(', '))
  return () =>
  {
    const rest = names().filter((part) => part !== name)
    if (rest.length > 0)
    {
      element.style.setProperty(ANCHOR_NAME, rest.join(', '))
    }
    else
    {
      element.style.removeProperty(ANCHOR_NAME)
    }
  }
}

/**
 * A small confirmation in an auto popover anchored to the control that asked, shown for as long as it is
 * mounted. Focus starts on the safe choice. Escape, light dismiss, and focus leaving the popover choose the
 * safe action. The owner's update from `onResolve` is applied before focus moves, and focus then returns to
 * the anchor, or to the fallback when the anchor is gone, unless the user already moved it to another control.
 */
export function ConfirmPopover({
  anchor,
  question,
  safeLabel,
  confirmLabel,
  danger,
  onResolve,
  fallbackFocus,
  placement = 'bottom',
  className
}: ConfirmPopoverProps): ReactElement
{
  const id = useId()
  const questionId = `${id}-question`
  const anchorName = `--confirm-${id.replace(/[^\w-]/g, '')}`
  const popoverRef = useRef<HTMLDivElement>(null)
  const safeRef = useRef<HTMLButtonElement>(null)
  const resolved = useRef(false)
  const latest = useRef({ anchor, onResolve, fallbackFocus })

  useLayoutEffect(() =>
  {
    latest.current = { anchor, onResolve, fallbackFocus }
  })

  const resolve = (confirmed: boolean, restoreFocus: boolean): void =>
  {
    if (resolved.current)
    {
      return
    }
    resolved.current = true
    const { anchor: opener, onResolve: report, fallbackFocus: fallback } = latest.current
    flushSync(() => report(confirmed))
    if (restoreFocus)
    {
      focusAfterConfirm(opener, fallback)
    }
  }

  useLayoutEffect(() =>
  {
    if (!anchor)
    {
      return
    }
    return addAnchorName(anchor, anchorName)
  }, [anchor, anchorName])

  useLayoutEffect(() =>
  {
    const popover = popoverRef.current as HTMLDivElement
    showPopover(popover)
    safeRef.current?.focus()
    const onToggle = (event: Event): void =>
    {
      if ((event as ToggleEvent).newState !== 'closed')
      {
        return
      }
      const focused = focusedElement()
      resolve(false, focused === null || popover.contains(focused))
    }
    popover.addEventListener('toggle', onToggle)
    return () =>
    {
      popover.removeEventListener('toggle', onToggle)
      hidePopover(popover)
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key === 'Escape' && !event.defaultPrevented)
    {
      event.preventDefault()
      resolve(false, true)
    }
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void =>
  {
    const next = event.relatedTarget
    if (next instanceof Node && !event.currentTarget.contains(next))
    {
      resolve(false, false)
    }
  }

  return (
    <div
      ref={popoverRef}
      popover="auto"
      role="dialog"
      aria-labelledby={questionId}
      tabIndex={-1}
      data-placement={placement}
      data-danger={danger || undefined}
      className={cx('ui-popover w-max max-w-80 rounded-md border border-line-strong bg-overlay p-3 text-ink shadow-overlay', className)}
      style={anchor ? { positionAnchor: anchorName } : undefined}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <p id={questionId} className="mb-3 text-control text-ink">{question}</p>
      <ConfirmChoices safeLabel={safeLabel} confirmLabel={confirmLabel} danger={danger} safeRef={safeRef} onChoose={(confirmed) => resolve(confirmed, true)} />
    </div>
  )
}
