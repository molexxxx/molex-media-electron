import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { Button, type ButtonSize } from './Button'
import { cx } from './cx'

/** The slot's stable element that takes focus when the opener is gone: an element, a ref to one, or a lookup. */
export type FocusFallback = HTMLElement | null | RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined)

function fallbackElement(fallback: FocusFallback | undefined): HTMLElement | null
{
  if (!fallback)
  {
    return null
  }
  if (typeof fallback === 'function')
  {
    return fallback() ?? null
  }
  return fallback instanceof HTMLElement ? fallback : fallback.current
}

/**
 * Returns focus after a confirmation: to the opener while it is still in the document and can take focus,
 * otherwise to the fallback.
 */
export function focusAfterConfirm(opener: HTMLElement | null | undefined, fallback?: FocusFallback): void
{
  if (opener?.isConnected)
  {
    opener.focus()
    if (document.activeElement === opener)
    {
      return
    }
  }
  fallbackElement(fallback)?.focus()
}

/** The element focused right now, unless focus is nowhere. */
export function focusedElement(): HTMLElement | null
{
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/** Props for the two choices shared by {@link InlineConfirm} and the confirmation popover. */
export interface ConfirmChoicesProps
{
  safeLabel: string
  confirmLabel: string
  danger?: boolean
  size?: ButtonSize
  safeRef: RefObject<HTMLButtonElement | null>
  onChoose: (confirmed: boolean) => void
}

/** The safe action first, then the confirm action, in the danger variant when the act destroys work. */
export function ConfirmChoices({ safeLabel, confirmLabel, danger, size = 'md', safeRef, onChoose }: ConfirmChoicesProps): ReactElement
{
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button ref={safeRef} size={size} data-choice="safe" onClick={() => onChoose(false)}>{safeLabel}</Button>
      <Button size={size} variant={danger ? 'danger' : 'secondary'} data-choice="confirm" onClick={() => onChoose(true)}>{confirmLabel}</Button>
    </div>
  )
}

/** Props for {@link InlineConfirm}. */
export interface InlineConfirmProps
{
  /** The question, which also names the group. */
  question: string
  /** The choice that keeps things as they are, such as "Keep running"; it comes first and takes focus. */
  safeLabel: string
  /** The choice that goes ahead, such as "Cancel run". */
  confirmLabel: string
  /** Draws the confirm choice in the danger variant. */
  danger?: boolean
  /** Called with the choice; the owner then restores the action area. */
  onResolve: (confirmed: boolean) => void
  /** The control that asked; by default, the element that had focus when the confirmation first rendered. */
  opener?: HTMLElement | null
  /** The slot's stable element, focused after the choice when the opener is gone. */
  fallbackFocus?: FocusFallback
  size?: ButtonSize
  /** Lets the question and its choices wrap onto a second line (the default); false keeps them on one line. */
  wrap?: boolean
  className?: string
}

/**
 * A question and two buttons that take the place of an action area, never modal. Focus starts on the safe
 * choice and Escape chooses it. The owner's update from `onResolve` is applied before focus moves, so focus
 * lands on the opener when it is still there, or else on the slot's stable element.
 */
export function InlineConfirm({
  question,
  safeLabel,
  confirmLabel,
  danger,
  onResolve,
  opener,
  fallbackFocus,
  size,
  wrap = true,
  className
}: InlineConfirmProps): ReactElement
{
  const questionId = `${useId()}-question`
  const [captured] = useState(focusedElement)
  const safeRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() =>
  {
    safeRef.current?.focus()
  }, [])

  const resolve = (confirmed: boolean): void =>
  {
    const target = opener === undefined ? captured : opener
    flushSync(() => onResolve(confirmed))
    focusAfterConfirm(target, fallbackFocus)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key === 'Escape' && !event.defaultPrevented)
    {
      event.preventDefault()
      resolve(false)
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      data-danger={danger || undefined}
      className={cx('flex min-w-0 items-center gap-x-3 gap-y-2', wrap ? 'flex-wrap' : 'flex-nowrap', className)}
      onKeyDown={handleKeyDown}
    >
      <p id={questionId} className="min-w-0 text-control text-ink">{question}</p>
      <ConfirmChoices safeLabel={safeLabel} confirmLabel={confirmLabel} danger={danger} size={size} safeRef={safeRef} onChoose={resolve} />
    </div>
  )
}
