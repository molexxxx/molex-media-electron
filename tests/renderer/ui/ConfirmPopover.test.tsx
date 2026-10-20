/**
 * ConfirmPopover: an auto popover anchored to the control that asked, named by its question, with focus on
 * the safe choice; Escape, light dismiss, and focus leaving it choose the safe action; focus returns to the
 * anchor, or to the slot's stable element when the anchor is gone, unless the user moved it elsewhere.
 */
import React, { useRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'
import { ConfirmPopover, type ConfirmPopoverProps } from '../../../src/renderer/src/ui/ConfirmPopover'

type Extra = Partial<Omit<ConfirmPopoverProps, 'anchor' | 'onResolve'>>

interface HarnessProps
{
  onResolve: (confirmed: boolean) => void
  extra?: Extra
  /** Removes the asking control when the user confirms, as a skipped row leaves the table. */
  dropOnConfirm?: boolean
  /** Keeps the popover mounted after a choice, to check that it answers once. */
  keepMounted?: boolean
  anchorless?: boolean
}

function Harness({ onResolve, extra = {}, dropOnConfirm = false, keepMounted = false, anchorless = false }: HarnessProps): ReactElement
{
  const [anchor, setAnchor] = useState<HTMLElement | null | undefined>(undefined)
  const [present, setPresent] = useState(true)
  const slot = useRef<HTMLDivElement>(null)
  return (
    <div ref={slot} tabIndex={-1} data-testid="slot">
      {present && <button type="button" onClick={(event) => setAnchor(anchorless ? null : event.currentTarget)}>Skip</button>}
      <button type="button">Elsewhere</button>
      {anchor !== undefined && (
        <ConfirmPopover
          anchor={anchor}
          question="Skip 4 queued jobs?"
          safeLabel="Keep queued"
          confirmLabel="Skip 4 jobs"
          danger
          fallbackFocus={slot}
          {...extra}
          onResolve={(confirmed) =>
          {
            onResolve(confirmed)
            if (!keepMounted)
            {
              setAnchor(undefined)
            }
            if (confirmed && dropOnConfirm)
            {
              setPresent(false)
            }
          }}
        />
      )}
    </div>
  )
}

function ask(): { anchor: HTMLElement, dialog: HTMLElement, safe: HTMLElement, confirm: HTMLElement }
{
  const anchor = screen.getByRole('button', { name: 'Skip' })
  anchor.focus()
  fireEvent.click(anchor)
  const dialog = screen.getByRole('dialog', { hidden: true })
  return {
    anchor,
    dialog,
    safe: within(dialog).getByRole('button', { hidden: true, name: 'Keep queued' }),
    confirm: within(dialog).getByRole('button', { hidden: true, name: 'Skip 4 jobs' })
  }
}

function toggleEvent(state: 'open' | 'closed'): Event
{
  return Object.assign(new Event('toggle'), { newState: state })
}

describe('ConfirmPopover', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('opens as an auto popover dialog named by its question with focus on the safe choice', () =>
  {
    render(<Harness onResolve={() => undefined} />)
    const { dialog, safe, confirm } = ask()
    expect(dialog).toHaveAttribute('popover', 'auto')
    expect(dialog).toHaveAttribute('data-popover-open')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby') as string)).toHaveTextContent('Skip 4 queued jobs?')
    expect(dialog).not.toHaveAttribute('aria-modal')
    expect(dialog).toHaveAttribute('data-placement', 'bottom')
    expect(dialog).toHaveAttribute('data-danger')
    expect(document.activeElement).toBe(safe)
    expect(safe.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(confirm).toHaveAttribute('data-variant', 'danger')
  })

  it('anchors to the control that asked and lets go of it when it closes', () =>
  {
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    const removeProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'removeProperty')
    render(<Harness onResolve={() => undefined} />)
    const { anchor, dialog, safe } = ask()
    const call = setProperty.mock.calls.find(([property]) => property === 'anchor-name')
    expect(call?.[1]).toMatch(/^--confirm-/)
    expect(setProperty.mock.contexts[setProperty.mock.calls.indexOf(call as never)]).toBe(anchor.style)
    expect(dialog.style.getPropertyValue('position-anchor') || (dialog.style as unknown as Record<string, string>).positionAnchor).toBe(call?.[1])
    fireEvent.click(safe)
    expect(removeProperty).toHaveBeenCalledWith('anchor-name')
    setProperty.mockRestore()
    removeProperty.mockRestore()
  })

  it('keeps the anchor names the control already had', () =>
  {
    const values = new Map<CSSStyleDeclaration, string>()
    const get = vi.spyOn(CSSStyleDeclaration.prototype, 'getPropertyValue').mockImplementation(function (this: CSSStyleDeclaration, property: string)
    {
      return property === 'anchor-name' ? values.get(this) ?? '' : ''
    })
    const set = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty').mockImplementation(function (this: CSSStyleDeclaration, property: string, value: string | null)
    {
      if (property === 'anchor-name')
      {
        values.set(this, value ?? '')
      }
    })
    const remove = vi.spyOn(CSSStyleDeclaration.prototype, 'removeProperty').mockImplementation(function (this: CSSStyleDeclaration)
    {
      values.delete(this)
      return ''
    })
    render(<Harness onResolve={() => undefined} />)
    const anchor = screen.getByRole('button', { name: 'Skip' })
    values.set(anchor.style, '--pop-trigger')
    const { safe } = ask()
    expect(values.get(anchor.style)).toMatch(/^--pop-trigger, --confirm-/)
    fireEvent.click(safe)
    expect(values.get(anchor.style)).toBe('--pop-trigger')
    expect(remove).not.toHaveBeenCalled()
    get.mockRestore()
    set.mockRestore()
    remove.mockRestore()
  })

  it('chooses the safe action on Escape and returns focus to the anchor', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} />)
    const { anchor, safe } = ask()
    fireEvent.keyDown(safe, { key: 'Escape' })
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })

  it('ignores an Escape that another handler already took, and other keys', () =>
  {
    const onResolve = vi.fn()
    const takeEscape = (event: KeyboardEvent): void => event.preventDefault()
    render(<Harness onResolve={onResolve} />)
    const { safe } = ask()
    document.addEventListener('keydown', takeEscape, { capture: true })
    fireEvent.keyDown(safe, { key: 'Escape' })
    document.removeEventListener('keydown', takeEscape, { capture: true })
    fireEvent.keyDown(safe, { key: 'Tab' })
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('chooses the safe action on light dismiss and returns focus that was left nowhere', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} />)
    const { anchor, dialog, safe } = ask()
    safe.blur()
    expect(document.activeElement).toBe(document.body)
    act(() =>
    {
      dialog.dispatchEvent(toggleEvent('closed'))
    })
    expect(onResolve).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(anchor)
  })

  it('returns focus after a light dismiss that left it inside', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} />)
    const { anchor, dialog } = ask()
    act(() =>
    {
      dialog.dispatchEvent(toggleEvent('closed'))
    })
    expect(onResolve).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(anchor)
  })

  it('leaves focus on the control a light dismiss moved it to', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} keepMounted />)
    const { dialog } = ask()
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    act(() =>
    {
      elsewhere.focus()
    })
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith(false)
    act(() =>
    {
      dialog.dispatchEvent(toggleEvent('closed'))
    })
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('leaves focus outside alone on a light dismiss that found it there', () =>
  {
    const onResolve = vi.fn()
    const outside = document.createElement('button')
    document.body.append(outside)
    render(<Harness onResolve={onResolve} />)
    const { dialog, safe } = ask()
    fireEvent.blur(safe, { relatedTarget: null })
    outside.focus()
    act(() =>
    {
      dialog.dispatchEvent(toggleEvent('closed'))
    })
    expect(onResolve).toHaveBeenCalledWith(false)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('ignores the platform opening it and focus moving between its choices', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} />)
    const { dialog, confirm } = ask()
    act(() =>
    {
      dialog.dispatchEvent(toggleEvent('open'))
      confirm.focus()
    })
    expect(onResolve).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(confirm)
  })

  it('confirms and returns focus to the anchor', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} />)
    const { anchor, confirm } = ask()
    fireEvent.click(confirm)
    expect(onResolve).toHaveBeenCalledWith(true)
    expect(document.activeElement).toBe(anchor)
  })

  it('moves focus to the slot stable element when the anchor is gone', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} dropOnConfirm />)
    const { anchor, confirm } = ask()
    fireEvent.click(confirm)
    expect(onResolve).toHaveBeenCalledWith(true)
    expect(anchor.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByTestId('slot'))
  })

  it('answers once even when the owner keeps it mounted', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} keepMounted />)
    const { safe, confirm } = ask()
    fireEvent.click(safe)
    fireEvent.click(confirm)
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith(false)
  })

  it('opens without an anchor and falls back to the slot', () =>
  {
    const onResolve = vi.fn()
    render(<Harness onResolve={onResolve} anchorless extra={{ placement: 'end', className: 'max-w-64' }} />)
    const { dialog, safe } = ask()
    expect(dialog).toHaveAttribute('data-placement', 'end')
    expect(dialog).toHaveClass('max-w-64')
    expect(document.activeElement).toBe(safe)
    fireEvent.keyDown(safe, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('slot'))
  })

  it('draws a plain confirm choice when the act is not dangerous', () =>
  {
    render(<Harness onResolve={() => undefined} extra={{ danger: false }} />)
    const { dialog, confirm } = ask()
    expect(confirm).toHaveAttribute('data-variant', 'secondary')
    expect(dialog).not.toHaveAttribute('data-danger')
  })
})
