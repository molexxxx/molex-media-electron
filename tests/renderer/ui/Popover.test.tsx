/**
 * Popover: the trigger's expanded, controls, and popup wiring, the platform calls on open and close, focus
 * moving inside and coming back on every close path that leaves it nowhere, light dismiss through the
 * platform's toggle event, Tab leaving it, and the close function handed to content.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Popover, type PopoverProps } from '../../../src/renderer/src/ui/Popover'
import { Button } from '../../../src/renderer/src/ui/Button'
import { IconButton } from '../../../src/renderer/src/ui/IconButton'

function setup(props: Partial<PopoverProps> = {}): { trigger: HTMLElement, popover: HTMLElement }
{
  render(
    <>
      <Popover label="Output" trigger={<Button>Output</Button>} {...props}>
        {props.children ?? (
          <>
            <p>Where finished files go</p>
            <button type="button" disabled>Locked</button>
            <button type="button">Choose folder</button>
          </>
        )}
      </Popover>
      <button type="button">After</button>
    </>
  )
  return { trigger: screen.getByRole('button', { name: 'Output' }), popover: screen.getByRole('dialog', { hidden: true }) }
}

function toggleEvent(state: 'open' | 'closed'): Event
{
  return Object.assign(new Event('toggle'), { newState: state })
}

describe('Popover', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.restoreAllMocks()
  })

  it('wires the trigger with aria-expanded, aria-controls, aria-haspopup, and popovertarget', () =>
  {
    const { trigger, popover } = setup()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-controls', popover.id)
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('popovertarget', popover.id)
    expect(trigger).toHaveClass('aria-expanded:bg-raised')
    expect(popover).toHaveAttribute('popover', 'auto')
    expect(popover).toHaveAttribute('aria-label', 'Output')
    expect(popover).toHaveClass('ui-popover', 'bg-overlay', 'border-line-strong', 'rounded-md', 'shadow-overlay', 'p-3')
    expect(popover).toHaveAttribute('data-placement', 'bottom')
  })

  it('anchors the popover to its trigger by a shared anchor name', () =>
  {
    const { trigger, popover } = setup({ placement: 'top' })
    const anchor = (trigger.style as CSSStyleDeclaration & { anchorName: string }).anchorName
    expect(anchor).toMatch(/^--pop-[\w-]+$/)
    expect((popover.style as CSSStyleDeclaration & { positionAnchor: string }).positionAnchor).toBe(anchor)
    expect(popover).toHaveAttribute('data-placement', 'top')
  })

  it('calls showPopover on open, moves focus to the first enabled control, and reports the state', () =>
  {
    const showPopover = vi.spyOn(HTMLElement.prototype, 'showPopover')
    const onOpenChange = vi.fn()
    const { trigger, popover } = setup({ onOpenChange })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(fireEvent.click(trigger)).toBe(false)
    expect(showPopover).toHaveBeenCalledTimes(1)
    expect(showPopover.mock.contexts[0]).toBe(popover)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(popover).toHaveAttribute('data-open')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose folder', hidden: true }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
  })

  it('closes on Escape, calls hidePopover, and returns focus to the trigger', () =>
  {
    const hidePopover = vi.spyOn(HTMLElement.prototype, 'hidePopover')
    const onOpenChange = vi.fn()
    const { trigger, popover } = setup({ onOpenChange })
    fireEvent.click(trigger)
    hidePopover.mockClear()
    const notCanceled = fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(notCanceled).toBe(false)
    expect(hidePopover).toHaveBeenCalledTimes(1)
    expect(hidePopover.mock.contexts[0]).toBe(popover)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('leaves an Escape that content already handled alone', () =>
  {
    const { trigger } = setup({
      children: <input aria-label="Folder" onKeyDown={(event) => event.key === 'Escape' && event.preventDefault()} />
    })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder', hidden: true }), { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder', hidden: true }), { key: 'Enter' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes from its trigger', () =>
  {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps focus inside on a press of the open trigger, so the click closes it for good', () =>
  {
    const onMouseDown = vi.fn()
    const { trigger } = setup({ trigger: <Button onMouseDown={onMouseDown}>Output</Button> })
    expect(fireEvent.mouseDown(trigger)).toBe(true)
    fireEvent.click(trigger)
    const inside = document.activeElement
    expect(fireEvent.mouseDown(trigger)).toBe(false)
    expect(document.activeElement).toBe(inside)
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
    expect(onMouseDown).toHaveBeenCalledTimes(2)
  })

  it('follows light dismiss from the toggle event and returns focus when it was left nowhere', () =>
  {
    const { trigger, popover } = setup()
    fireEvent.click(trigger)
    act(() =>
    {
      (document.activeElement as HTMLElement).blur()
      popover.dispatchEvent(toggleEvent('open'))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    act(() =>
    {
      popover.dispatchEvent(toggleEvent('closed'))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('does not take focus back from a control the user clicked outside', () =>
  {
    const { trigger, popover } = setup()
    fireEvent.click(trigger)
    const after = screen.getByRole('button', { name: 'After' })
    act(() =>
    {
      after.focus()
      popover.dispatchEvent(toggleEvent('closed'))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(after)
  })

  it('closes when Tab leaves it and leaves focus where Tab put it', () =>
  {
    const { trigger } = setup()
    fireEvent.click(trigger)
    const after = screen.getByRole('button', { name: 'After' })
    act(() =>
    {
      after.focus()
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(after)
  })

  it('stays open while focus moves inside it or leaves the window', () =>
  {
    const { trigger } = setup({
      children: (
        <>
          <button type="button">One</button>
          <button type="button">Two</button>
        </>
      )
    })
    fireEvent.click(trigger)
    act(() =>
    {
      screen.getByRole('button', { name: 'Two', hidden: true }).focus()
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.blur(screen.getByRole('button', { name: 'Two', hidden: true }), { relatedTarget: null })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('focuses the popover itself with container focus or when it holds no control', () =>
  {
    const { trigger, popover } = setup({ initialFocus: 'container' })
    fireEvent.click(trigger)
    expect(document.activeElement).toBe(popover)
    cleanup()
    const second = setup({ children: <p>Nothing to choose</p> })
    fireEvent.click(second.trigger)
    expect(document.activeElement).toBe(second.popover)
  })

  it('hands content a close function that returns focus to the trigger', () =>
  {
    const { trigger } = setup({
      children: (close: () => void) => <button type="button" onClick={close}>Done</button>
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Done', hidden: true }))
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('calls the trigger handler and stays shut when the trigger cannot act', () =>
  {
    const onClick = vi.fn()
    render(
      <Popover label="Workers" trigger={<Button onClick={onClick} unavailableReason="Locked while running">Workers</Button>}>
        <button type="button">Two</button>
      </Popover>
    )
    const trigger = screen.getByRole('button', { name: 'Workers' })
    fireEvent.click(trigger)
    expect(onClick).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    cleanup()
    const onOpen = vi.fn()
    render(
      <Popover label="Workers" trigger={<Button onClick={onOpen}>Workers</Button>}>
        <button type="button">Two</button>
      </Popover>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Workers' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('composes its anchor with an icon button trigger and its tooltip', () =>
  {
    render(
      <Popover label="Settings" trigger={<IconButton label="Settings" icon="action.more" style={{ color: 'inherit' }} />}>
        <button type="button">Reset</button>
      </Popover>
    )
    const trigger = screen.getByRole('button', { name: 'Settings' })
    const anchor = (trigger.style as CSSStyleDeclaration & { anchorName: string }).anchorName
    expect(anchor).toMatch(/^--pop-[\w-]+, --tip-[\w-]+$/)
    expect(trigger.style.color).toBe('inherit')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
})
