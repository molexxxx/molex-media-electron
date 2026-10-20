/**
 * InlineConfirm: a group named by its question that takes the place of an action area, focus on the safe
 * choice, Escape choosing it, and focus coming back to the opener, or to the slot's stable element when the
 * opener left the document with the area it lived in.
 */
import React, { useRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { focusAfterConfirm, focusedElement, InlineConfirm, type FocusFallback, type InlineConfirmProps } from '../../../src/renderer/src/ui/InlineConfirm'

const QUESTION = 'Cancel the run? 3 running jobs stop and their partial files are deleted.'

type Extra = Partial<Omit<InlineConfirmProps, 'onResolve'>>

/** The opener lives inside the slot, so the confirmation removes it and the restored area renders a new one. */
function InsideSlot({ onResolve, extra = {}, useFallback = true }: { onResolve: (confirmed: boolean) => void, extra?: Extra, useFallback?: boolean }): ReactElement
{
  const [asking, setAsking] = useState(false)
  const slot = useRef<HTMLDivElement>(null)
  return (
    <div ref={slot} tabIndex={-1} data-testid="slot">
      {asking
        ? (
          <InlineConfirm
            question={QUESTION}
            safeLabel="Keep running"
            confirmLabel="Cancel run"
            danger
            fallbackFocus={useFallback ? slot : undefined}
            {...extra}
            onResolve={(confirmed) =>
            {
              onResolve(confirmed)
              setAsking(false)
            }}
          />
        )
        : <button type="button" onClick={() => setAsking(true)}>Cancel run</button>}
    </div>
  )
}

/** The opener stays in the document beside the slot the confirmation fills. */
function OutsideOpener({ onResolve, extra = {} }: { onResolve: (confirmed: boolean) => void, extra?: Extra }): ReactElement
{
  const [asking, setAsking] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setAsking(true)}>Pause</button>
      <div data-testid="slot">
        {asking && (
          <InlineConfirm
            question="Pause now? 40 s of encoding is discarded."
            safeLabel="Keep running"
            confirmLabel="Pause now"
            {...extra}
            onResolve={(confirmed) =>
            {
              onResolve(confirmed)
              setAsking(false)
            }}
          />
        )}
      </div>
    </>
  )
}

function ask(name: string): HTMLElement
{
  const opener = screen.getByRole('button', { name })
  opener.focus()
  fireEvent.click(opener)
  return opener
}

describe('InlineConfirm', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a group named by its question with the safe choice first and focused', () =>
  {
    render(<InsideSlot onResolve={() => undefined} />)
    ask('Cancel run')
    const group = screen.getByRole('group', { name: QUESTION })
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Keep running', 'Cancel run'])
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons[1]).toHaveAttribute('data-variant', 'danger')
    expect(group).toHaveAttribute('data-danger')
    expect(group).not.toHaveAttribute('aria-modal')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('chooses the safe action on Escape and returns focus to the opener', () =>
  {
    const onResolve = vi.fn()
    render(<OutsideOpener onResolve={onResolve} />)
    const opener = ask('Pause')
    const safe = screen.getByRole('button', { name: 'Keep running' })
    expect(document.activeElement).toBe(safe)
    fireEvent.keyDown(safe, { key: 'Escape' })
    expect(onResolve).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus to the opener after either button', () =>
  {
    const onResolve = vi.fn()
    render(<OutsideOpener onResolve={onResolve} />)
    const opener = ask('Pause')
    fireEvent.click(screen.getByRole('button', { name: 'Pause now' }))
    expect(onResolve).toHaveBeenLastCalledWith(true)
    expect(document.activeElement).toBe(opener)
    ask('Pause')
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(onResolve).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(opener)
  })

  it('draws the confirm choice in the secondary variant unless it is dangerous', () =>
  {
    render(<OutsideOpener onResolve={() => undefined} />)
    ask('Pause')
    expect(screen.getByRole('button', { name: 'Pause now' })).toHaveAttribute('data-variant', 'secondary')
    expect(screen.getByRole('group')).not.toHaveAttribute('data-danger')
  })

  it('wraps onto a second line by default and stays on one line when asked', () =>
  {
    const { rerender } = render(<InlineConfirm question={QUESTION} safeLabel="Keep running" confirmLabel="Cancel run" onResolve={() => undefined} />)
    expect(screen.getByRole('group')).toHaveClass('flex-wrap')
    expect(screen.getByRole('group')).not.toHaveClass('flex-nowrap')
    rerender(<InlineConfirm question={QUESTION} safeLabel="Keep running" confirmLabel="Cancel run" wrap={false} onResolve={() => undefined} />)
    expect(screen.getByRole('group')).toHaveClass('flex-nowrap')
    expect(screen.getByRole('group')).not.toHaveClass('flex-wrap')
  })

  it('moves focus to the slot stable element when the opener is gone', () =>
  {
    const onResolve = vi.fn()
    render(<InsideSlot onResolve={onResolve} />)
    const first = ask('Cancel run')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    expect(onResolve).toHaveBeenLastCalledWith(true)
    expect(first.isConnected).toBe(false)
    expect(document.activeElement).toBe(screen.getByTestId('slot'))
    ask('Cancel run')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep running' }), { key: 'Escape' })
    expect(onResolve).toHaveBeenLastCalledWith(false)
    expect(document.activeElement).toBe(screen.getByTestId('slot'))
  })

  it('takes the fallback as a lookup function', () =>
  {
    render(<InsideSlot onResolve={() => undefined} useFallback={false} extra={{ fallbackFocus: () => screen.getByTestId('slot') }} />)
    ask('Cancel run')
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(document.activeElement).toBe(screen.getByTestId('slot'))
  })

  it('prefers an explicit opener over the element focused when it rendered', () =>
  {
    const other = document.createElement('button')
    document.body.append(other)
    render(<OutsideOpener onResolve={() => undefined} extra={{ opener: other }} />)
    ask('Pause')
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('leaves focus nowhere when there is no opener and no fallback', () =>
  {
    render(<InsideSlot onResolve={() => undefined} useFallback={false} />)
    ask('Cancel run')
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(document.activeElement).toBe(document.body)
  })

  it('ignores an Escape that another handler already took', () =>
  {
    const onResolve = vi.fn()
    const takeEscape = (event: KeyboardEvent): void => event.preventDefault()
    document.addEventListener('keydown', takeEscape, { capture: true })
    render(<OutsideOpener onResolve={onResolve} />)
    ask('Pause')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep running' }), { key: 'Escape' })
    document.removeEventListener('keydown', takeEscape, { capture: true })
    expect(onResolve).not.toHaveBeenCalled()
    expect(screen.getByRole('group')).toBeInTheDocument()
  })

  it('ignores keys other than Escape', () =>
  {
    const onResolve = vi.fn()
    render(<OutsideOpener onResolve={onResolve} />)
    ask('Pause')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep running' }), { key: 'Enter' })
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('sizes both choices together', () =>
  {
    render(<OutsideOpener onResolve={() => undefined} extra={{ size: 'sm', className: 'justify-end' }} />)
    ask('Pause')
    expect(screen.getByRole('button', { name: 'Keep running' })).toHaveAttribute('data-size', 'sm')
    expect(screen.getByRole('button', { name: 'Pause now' })).toHaveAttribute('data-size', 'sm')
    expect(screen.getByRole('group')).toHaveClass('justify-end')
  })
})

describe('focusAfterConfirm', () =>
{
  afterEach(() =>
  {
    document.body.replaceChildren()
  })

  function button(label: string, disabled = false): HTMLButtonElement
  {
    const element = document.createElement('button')
    element.textContent = label
    element.disabled = disabled
    document.body.append(element)
    return element
  }

  it('focuses the opener while it is in the document', () =>
  {
    const opener = button('Cancel job')
    const slot = button('Slot')
    focusAfterConfirm(opener, slot)
    expect(document.activeElement).toBe(opener)
  })

  it('falls back when the opener cannot take focus', () =>
  {
    const opener = button('Cancel job', true)
    const slot = button('Slot')
    focusAfterConfirm(opener, slot)
    expect(document.activeElement).toBe(slot)
  })

  it('falls back when the opener left the document, through an element, a ref, or a lookup', () =>
  {
    const gone = document.createElement('button')
    const slot = button('Slot')
    const fallbacks: FocusFallback[] = [slot, { current: slot }, () => slot]
    for (const fallback of fallbacks)
    {
      slot.blur()
      focusAfterConfirm(gone, fallback)
      expect(document.activeElement).toBe(slot)
    }
  })

  it('does nothing without an opener or a fallback', () =>
  {
    focusAfterConfirm(null)
    focusAfterConfirm(undefined, null)
    focusAfterConfirm(undefined, () => undefined)
    focusAfterConfirm(undefined, { current: null })
    expect(document.activeElement).toBe(document.body)
  })

  it('reports nothing focused while focus is on the body', () =>
  {
    expect(focusedElement()).toBeNull()
    const element = button('Retry')
    element.focus()
    expect(focusedElement()).toBe(element)
  })
})
