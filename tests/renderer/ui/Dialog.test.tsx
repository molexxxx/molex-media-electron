/**
 * Dialog: the native modal opened with showModal, its title and description wiring, initial focus on the
 * safe action, close requests held open and reported with their reason, closes the platform makes on its
 * own, and focus returning to the opener when the owner closes or unmounts it.
 */
import React, { useRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Dialog, type DialogCloseReason, type DialogProps } from '../../../src/renderer/src/ui/Dialog'
import { Button } from '../../../src/renderer/src/ui/Button'

/** A run with a confirmation that cancels it, opened from a toolbar button. */
function CancelRun({ onClose, ...props }: Partial<DialogProps> & { onClose?: (reason: DialogCloseReason) => void }): ReactElement
{
  const [open, setOpen] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)
  const close = (reason: DialogCloseReason): void =>
  {
    onClose?.(reason)
    setOpen(false)
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Cancel run</button>
      <Dialog
        open={open}
        onClose={close}
        title="Cancel this run?"
        description="Jobs already finished keep their outputs."
        initialFocusRef={keepRef}
        actions={(
          <>
            <Button ref={keepRef} onClick={() => close('cancel')}>Keep running</Button>
            <Button variant="danger" onClick={() => close('confirm')}>Cancel run</Button>
          </>
        )}
        {...props}
      />
    </>
  )
}

function dialog(): HTMLDialogElement
{
  return document.querySelector('dialog') as HTMLDialogElement
}

function openFromOpener(): HTMLElement
{
  const opener = screen.getAllByRole('button', { name: 'Cancel run' })[0]
  act(() =>
  {
    opener.focus()
  })
  fireEvent.click(opener)
  return opener
}

describe('Dialog', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.restoreAllMocks()
  })

  it('stays closed until open, then calls showModal', () =>
  {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(<CancelRun />)
    expect(dialog().open).toBe(false)
    expect(showModal).not.toHaveBeenCalled()
    openFromOpener()
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(showModal.mock.contexts[0]).toBe(dialog())
    expect(dialog().open).toBe(true)
  })

  it('is labeled by its title and described by its description', () =>
  {
    render(<CancelRun />)
    openFromOpener()
    const element = screen.getByRole('dialog', { hidden: true })
    expect(element).toHaveAttribute('aria-labelledby', screen.getByText('Cancel this run?').id)
    expect(element).toHaveAttribute('aria-describedby', screen.getByText('Jobs already finished keep their outputs.').id)
    expect(element).toHaveAccessibleName('Cancel this run?')
    expect(element).toHaveAccessibleDescription('Jobs already finished keep their outputs.')
  })

  it('starts on the safe action', () =>
  {
    render(<CancelRun />)
    openFromOpener()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep running', hidden: true }))
  })

  it('reports a cancel event as cancel and holds the dialog open for its owner', () =>
  {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Replace originals?" actions={<Button>Keep originals</Button>} />
    )
    const cancel = new Event('cancel', { cancelable: true })
    act(() =>
    {
      dialog().dispatchEvent(cancel)
    })
    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('cancel')
    expect(dialog().open).toBe(true)
  })

  it('returns focus to the opener when the owner closes it', () =>
  {
    const onClose = vi.fn()
    render(<CancelRun onClose={onClose} />)
    const opener = openFromOpener()
    act(() =>
    {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenCalledWith('cancel')
    expect(dialog().open).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the opener after the confirming action', () =>
  {
    const onClose = vi.fn()
    render(<CancelRun onClose={onClose} />)
    const opener = openFromOpener()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel run', hidden: true })[1])
    expect(onClose).toHaveBeenCalledWith('confirm')
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus to the opener when it unmounts while open', () =>
  {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<Dialog open onClose={vi.fn()} title="Shortcuts" actions={<Button>Close</Button>} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close', hidden: true }))
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('keeps focus where it is when the owner rerenders it open with a new focus ref', () =>
  {
    const onClose = vi.fn()
    const first = React.createRef<HTMLButtonElement>()
    const second = React.createRef<HTMLButtonElement>()
    const actions = (ref: React.RefObject<HTMLButtonElement | null>): ReactElement => (
      <>
        <Button ref={ref}>Keep running</Button>
        <Button variant="danger">Cancel run</Button>
      </>
    )
    const { rerender } = render(<Dialog open onClose={onClose} title="Cancel this run?" initialFocusRef={first} actions={actions(first)} />)
    const danger = screen.getByRole('button', { name: 'Cancel run', hidden: true })
    act(() =>
    {
      danger.focus()
    })
    rerender(<Dialog open onClose={onClose} title="Cancel this run?" initialFocusRef={second} actions={actions(second)} />)
    expect(document.activeElement).toBe(danger)
  })

  it('leaves focus alone when the opener is gone or focus moved on', () =>
  {
    const { rerender } = render(<Dialog open onClose={vi.fn()} title="Shortcuts" actions={<Button>Close</Button>} />)
    rerender(<Dialog open={false} onClose={vi.fn()} title="Shortcuts" actions={<Button>Close</Button>} />)
    expect(document.activeElement).toBe(document.body)
  })

  it('without an initial focus ref starts on the first control, or on itself when it has none', () =>
  {
    const { rerender } = render(
      <Dialog open onClose={vi.fn()} title="Export" actions={<><Button>Back</Button><Button variant="primary">Export</Button></>}>
        <input aria-label="File name" />
      </Dialog>
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'File name', hidden: true }))
    rerender(<Dialog open={false} onClose={vi.fn()} title="Export" actions={null} />)
    rerender(<Dialog open onClose={vi.fn()} title="Export" actions={null} />)
    expect(document.activeElement).toBe(dialog())
  })

  it('reports closes the platform made on its own by their return value', () =>
  {
    const onClose = vi.fn()
    render(<Dialog open onClose={onClose} title="Export" actions={<Button>Close</Button>} />)
    for (const [value, reason] of [['confirm', 'confirm'], ['cancel', 'cancel'], ['', 'dismiss']] as const)
    {
      act(() =>
      {
        dialog().close(value)
      })
      expect(onClose).toHaveBeenLastCalledWith(reason)
      act(() =>
      {
        dialog().showModal()
      })
    }
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('does not report the close its owner asked for', () =>
  {
    const onClose = vi.fn()
    const { rerender } = render(<Dialog open onClose={onClose} title="Export" actions={<Button>Close</Button>} />)
    rerender(<Dialog open={false} onClose={onClose} title="Export" actions={<Button>Close</Button>} />)
    expect(dialog().open).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders closedby, closerequest by default, and reports a backdrop click as dismiss', () =>
  {
    const onClose = vi.fn()
    const { rerender } = render(<Dialog open onClose={onClose} title="Shortcuts" actions={<Button>Close</Button>} />)
    expect(dialog()).toHaveAttribute('closedby', 'closerequest')
    rerender(<Dialog open closedBy="any" onClose={onClose} title="Shortcuts" actions={<Button>Close</Button>} />)
    expect(dialog()).toHaveAttribute('closedby', 'any')
    fireEvent.pointerDown(dialog(), { clientX: 900, clientY: 700 })
    act(() =>
    {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenLastCalledWith('dismiss')
    fireEvent.pointerDown(dialog(), { clientX: 900, clientY: 700 })
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    act(() =>
    {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenLastCalledWith('cancel')
  })

  it('treats a pointer down inside the box or on its content as no backdrop click', () =>
  {
    const onClose = vi.fn()
    render(<Dialog open closedBy="any" onClose={onClose} title="Shortcuts" actions={<Button>Close</Button>} />)
    fireEvent.pointerDown(dialog(), { clientX: 0, clientY: 0 })
    act(() =>
    {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenLastCalledWith('cancel')
    fireEvent.pointerDown(screen.getByText('Shortcuts'), { clientX: 900, clientY: 700 })
    act(() =>
    {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true }))
    })
    expect(onClose).toHaveBeenLastCalledWith('cancel')
  })

  it('draws the overlay box at the small width by default and the medium width on request', () =>
  {
    const { rerender } = render(<Dialog open onClose={vi.fn()} title="Shortcuts" actions={<Button>Close</Button>} />)
    expect(dialog()).toHaveClass('ui-dialog', 'bg-overlay', 'border-line-strong', 'rounded-md', 'shadow-dialog', 'p-5', 'w-100')
    expect(dialog()).toHaveAttribute('data-size', 'sm')
    expect(dialog()).not.toHaveAttribute('aria-describedby')
    expect(screen.getByText('Shortcuts')).toHaveClass('text-section', 'text-ink')
    rerender(
      <Dialog open size="md" onClose={vi.fn()} title="Shortcuts" description="Keys for the queue." actions={<Button>Close</Button>}>
        <p>Body</p>
      </Dialog>
    )
    expect(dialog()).toHaveClass('w-140')
    expect(screen.getByText('Keys for the queue.')).toHaveClass('text-ink-2')
    expect(screen.getByText('Body')).toBeInTheDocument()
    const footer = screen.getByRole('button', { name: 'Close', hidden: true }).parentElement as HTMLElement
    expect(footer).toHaveClass('flex', 'justify-end')
  })
})
