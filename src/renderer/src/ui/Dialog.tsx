import { useId, useLayoutEffect, useRef, type PointerEvent, type ReactElement, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import { cx } from './cx'
import { closeDialog, showModal } from './platform'

/** Why a dialog asks to close: Escape or a close request, a confirming form submission, or a backdrop click. */
export type DialogCloseReason = 'cancel' | 'confirm' | 'dismiss'

/** Props for {@link Dialog}. */
export interface DialogProps
{
  open: boolean
  /** Called when the dialog asks to close; the owner closes it by setting `open` to false. */
  onClose: (reason: DialogCloseReason) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  /** Footer buttons, the secondary first, then the primary or danger action. */
  actions: ReactNode
  /** 400 or 560 px wide. */
  size?: 'sm' | 'md'
  /** `any` also closes on a backdrop click; the default keeps a confirmation open until a choice. */
  closedBy?: 'any' | 'closerequest'
  /** The element that takes focus on open, the safe action of a destructive confirmation. */
  initialFocusRef?: RefObject<HTMLElement | null>
}

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'

function isNowhere(element: Element | null): boolean
{
  return element === null || element === document.body
}

/**
 * A modal dialog on the native element, opened with `showModal`, so the rest of the page is inert and Tab
 * cycles inside. Focus starts on `initialFocusRef` (the safe action) or the first control, and returns to
 * the opener when the dialog closes or unmounts. Escape and other close requests are held open and reported
 * through `onClose`, so the owner decides; a backdrop click does the same only with `closedBy="any"`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  size = 'sm',
  closedBy = 'closerequest',
  initialFocusRef
}: DialogProps): ReactElement
{
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  const backdropRef = useRef(false)
  openRef.current = open

  const closeAndReturnFocus = (dialog: HTMLDialogElement): void =>
  {
    closeDialog(dialog)
    const opener = openerRef.current
    openerRef.current = null
    const focused = document.activeElement
    if (opener?.isConnected && (dialog.contains(focused) || isNowhere(focused)))
    {
      opener.focus()
    }
    else if (focused instanceof HTMLElement && dialog.contains(focused))
    {
      focused.blur()
    }
  }

  useLayoutEffect(() =>
  {
    const dialog = dialogRef.current as HTMLDialogElement
    if (!open)
    {
      closeAndReturnFocus(dialog)
      return
    }
    if (dialog.open)
    {
      return
    }
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && !isNowhere(active) ? active : null
    showModal(dialog)
    const target = initialFocusRef?.current
      ?? (dialog.contains(document.activeElement) ? null : dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)
    target?.focus()
  }, [open, initialFocusRef])

  useLayoutEffect(() =>
  {
    const dialog = dialogRef.current as HTMLDialogElement
    return () => closeAndReturnFocus(dialog)
  }, [])

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>): void =>
  {
    event.preventDefault()
    const reason = backdropRef.current ? 'dismiss' : 'cancel'
    backdropRef.current = false
    onClose(reason)
  }

  const handleClose = (event: SyntheticEvent<HTMLDialogElement>): void =>
  {
    if (!openRef.current)
    {
      return
    }
    const value = event.currentTarget.returnValue
    onClose(value === 'confirm' || value === 'cancel' ? value : 'dismiss')
  }

  const handlePointerDown = (event: PointerEvent<HTMLDialogElement>): void =>
  {
    const dialog = event.currentTarget
    const box = dialog.getBoundingClientRect()
    backdropRef.current = event.target === dialog
      && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      closedby={closedBy}
      tabIndex={-1}
      data-size={size}
      className={cx(
        'ui-dialog m-auto rounded-md border border-line-strong bg-overlay p-5 text-ink shadow-dialog',
        size === 'md' ? 'w-140' : 'w-100'
      )}
      onCancel={handleCancel}
      onClose={handleClose}
      onPointerDown={handlePointerDown}
      onKeyDown={() =>
      {
        backdropRef.current = false
      }}
    >
      <h2 id={titleId} className="text-section text-ink">{title}</h2>
      {description && <div id={descriptionId} className="mt-2 text-body text-ink-2">{description}</div>}
      {children && <div className="mt-4">{children}</div>}
      <div className="mt-5 flex justify-end gap-2">{actions}</div>
    </dialog>
  )
}
