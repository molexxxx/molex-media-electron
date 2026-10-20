/**
 * Tooltip: role and description wiring, the label mode that stays out of the accessibility tree, keyboard
 * focus versus pointer focus, the hover delay and its warm window, the grid dwell, the hover grace that keeps
 * the tip hoverable, and every dismissal path (Escape, blur, pointer leave, pointer down, ancestor scroll,
 * and the platform closing the popover).
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { GRID_FOCUS_DELAY_MS, TOOLTIP_DELAY_MS, TOOLTIP_GRACE_MS, Tooltip, type TooltipProps } from '../../../src/renderer/src/ui/Tooltip'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'

let clock = Date.UTC(2030, 0, 1)

function setup(props: Partial<TooltipProps> = {}, trigger: React.ReactElement = <button type="button">Pause</button>): { trigger: HTMLElement, tip: HTMLElement }
{
  render(
    <PlatformProvider platform="win32">
      <Tooltip content="Pause the run" {...props}>{trigger}</Tooltip>
    </PlatformProvider>
  )
  return { trigger: screen.getByRole('button'), tip: screen.getByRole('tooltip', { hidden: true }) }
}

function keyboardFocus(element: HTMLElement): void
{
  fireEvent.keyDown(document.body, { key: 'Tab' })
  act(() =>
  {
    element.focus()
  })
}

function pointerFocus(element: HTMLElement): void
{
  fireEvent.pointerDown(element)
  fireEvent.mouseDown(element)
  act(() =>
  {
    element.focus()
  })
}

function advance(ms: number): void
{
  act(() =>
  {
    vi.advanceTimersByTime(ms)
  })
}

function isOpen(tip: HTMLElement): boolean
{
  return tip.hasAttribute('data-open')
}

describe('Tooltip', () =>
{
  beforeEach(() =>
  {
    clock += 60_000
    vi.useFakeTimers({ now: clock })
  })

  afterEach(() =>
  {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders a hint popover with the tooltip role that describes its trigger', () =>
  {
    const { trigger, tip } = setup()
    expect(tip).toHaveAttribute('popover', 'hint')
    expect(tip).toHaveTextContent('Pause the run')
    expect(tip).not.toHaveAttribute('aria-hidden')
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)
    expect(trigger).toHaveAccessibleDescription('Pause the run')
    expect(trigger).toHaveAccessibleName('Pause')
    expect(isOpen(tip)).toBe(false)
  })

  it('anchors the tip to its trigger by a shared anchor name and keeps the placement', () =>
  {
    const { trigger, tip } = setup({ placement: 'end' })
    const anchor = (trigger.style as CSSStyleDeclaration & { anchorName: string }).anchorName
    expect(anchor).toMatch(/^--tip-[\w-]+$/)
    expect((tip.style as CSSStyleDeclaration & { positionAnchor: string }).positionAnchor).toBe(anchor)
    expect(tip).toHaveAttribute('data-placement', 'end')
  })

  it('in label mode leaves the name alone and hides the tip from assistive technology', () =>
  {
    const { trigger, tip } = setup({ mode: 'label', content: 'Pause' }, <button type="button" aria-label="Pause" />)
    expect(tip).toHaveAttribute('aria-hidden', 'true')
    expect(trigger).not.toHaveAttribute('aria-describedby')
    expect(trigger).toHaveAccessibleName('Pause')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('merges a caller description and anchor name on the trigger', () =>
  {
    const { trigger, tip } = setup({}, <button type="button" aria-describedby="hint" style={{ anchorName: '--menu' } as React.CSSProperties}>Pause</button>)
    expect(trigger.getAttribute('aria-describedby')).toBe(`hint ${tip.id}`)
    expect((trigger.style as CSSStyleDeclaration & { anchorName: string }).anchorName).toMatch(/^--menu, --tip-/)
  })

  it('shows at once on keyboard focus and calls showPopover', () =>
  {
    const showPopover = vi.spyOn(HTMLElement.prototype, 'showPopover')
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    expect(isOpen(tip)).toBe(true)
    expect(showPopover).toHaveBeenCalledTimes(1)
    expect(showPopover.mock.contexts[0]).toBe(tip)
  })

  it('does not show on pointer focus', () =>
  {
    const { trigger, tip } = setup()
    pointerFocus(trigger)
    advance(TOOLTIP_DELAY_MS * 2)
    expect(isOpen(tip)).toBe(false)
  })

  it('shows after the delay on hover', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(TOOLTIP_DELAY_MS - 1)
    expect(isOpen(tip)).toBe(false)
    advance(1)
    expect(isOpen(tip)).toBe(true)
  })

  it('honors a custom hover delay', () =>
  {
    const { trigger, tip } = setup({ delay: 200 })
    fireEvent.pointerEnter(trigger)
    advance(199)
    expect(isOpen(tip)).toBe(false)
    advance(1)
    expect(isOpen(tip)).toBe(true)
  })

  it('ignores touch pointers, which have no hover', () =>
  {
    const { trigger, tip } = setup()
    const touch = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    act(() =>
    {
      trigger.dispatchEvent(touch)
    })
    advance(TOOLTIP_DELAY_MS * 2)
    expect(isOpen(tip)).toBe(false)
  })

  it('does not restart the delay when the pointer enters again while it waits', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(300)
    fireEvent.pointerEnter(trigger)
    advance(200)
    expect(isOpen(tip)).toBe(true)
  })

  it('shows at once on keyboard focus while a hover show is still waiting', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(100)
    keyboardFocus(trigger)
    expect(isOpen(tip)).toBe(true)
    advance(TOOLTIP_DELAY_MS)
    expect(isOpen(tip)).toBe(true)
  })

  it('keeps a pending hover show when a grid row takes keyboard focus during it', () =>
  {
    const { trigger, tip } = setup({ focusDelay: GRID_FOCUS_DELAY_MS })
    fireEvent.pointerEnter(trigger)
    advance(300)
    keyboardFocus(trigger)
    advance(TOOLTIP_DELAY_MS - 300 - 1)
    expect(isOpen(tip)).toBe(false)
    advance(1)
    expect(isOpen(tip)).toBe(true)
  })

  it('cancels a pending show when the pointer leaves first', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(300)
    fireEvent.pointerLeave(trigger)
    advance(TOOLTIP_DELAY_MS)
    expect(isOpen(tip)).toBe(false)
  })

  it('hides on pointer leave after the grace period', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(TOOLTIP_DELAY_MS)
    fireEvent.pointerLeave(trigger)
    advance(TOOLTIP_GRACE_MS - 1)
    expect(isOpen(tip)).toBe(true)
    advance(1)
    expect(isOpen(tip)).toBe(false)
  })

  it('stays while the pointer moves onto the tip, and hides when it leaves the tip', () =>
  {
    const { trigger, tip } = setup()
    fireEvent.pointerEnter(trigger)
    advance(TOOLTIP_DELAY_MS)
    fireEvent.pointerLeave(trigger)
    advance(50)
    fireEvent.pointerEnter(tip)
    advance(TOOLTIP_GRACE_MS * 5)
    expect(isOpen(tip)).toBe(true)
    fireEvent.pointerLeave(tip)
    advance(TOOLTIP_GRACE_MS)
    expect(isOpen(tip)).toBe(false)
  })

  it('shows the next tooltip at once when another closed moments ago', () =>
  {
    render(
      <>
        <Tooltip content="Pause the run"><button type="button">Pause</button></Tooltip>
        <Tooltip content="Stop the run"><button type="button">Stop</button></Tooltip>
      </>
    )
    const [pause, stop] = screen.getAllByRole('button')
    const [pauseTip, stopTip] = screen.getAllByRole('tooltip', { hidden: true })
    fireEvent.pointerEnter(pause)
    advance(TOOLTIP_DELAY_MS)
    fireEvent.pointerLeave(pause)
    advance(TOOLTIP_GRACE_MS)
    expect(isOpen(pauseTip)).toBe(false)
    fireEvent.pointerEnter(stop)
    expect(isOpen(stopTip)).toBe(true)
  })

  it('waits the full delay again once the warm window has passed', () =>
  {
    render(
      <>
        <Tooltip content="Pause the run"><button type="button">Pause</button></Tooltip>
        <Tooltip content="Stop the run"><button type="button">Stop</button></Tooltip>
      </>
    )
    const [pause, stop] = screen.getAllByRole('button')
    const stopTip = screen.getAllByRole('tooltip', { hidden: true })[1]
    fireEvent.pointerEnter(pause)
    advance(TOOLTIP_DELAY_MS)
    fireEvent.pointerLeave(pause)
    advance(TOOLTIP_GRACE_MS + 300)
    fireEvent.pointerEnter(stop)
    expect(isOpen(stopTip)).toBe(false)
    advance(TOOLTIP_DELAY_MS)
    expect(isOpen(stopTip)).toBe(true)
  })

  it('hides on Escape without moving focus and calls preventDefault', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    expect(isOpen(tip)).toBe(true)
    const notCanceled = fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(notCanceled).toBe(false)
    expect(isOpen(tip)).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('consumes Escape before a grid handler sees it', () =>
  {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.defaultPrevented)
    render(
      <div role="grid" onKeyDown={onKeyDown}>
        <Tooltip content="Two-pass is off for GPU encodes"><button type="button">Recipe</button></Tooltip>
      </div>
    )
    const trigger = screen.getByRole('button')
    keyboardFocus(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(onKeyDown).toHaveLastReturnedWith(true)
  })

  it('leaves other keys and a closed tip alone', () =>
  {
    const { trigger, tip } = setup()
    expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(true)
    keyboardFocus(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(true)
    expect(isOpen(tip)).toBe(true)
  })

  it('hides on blur', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    act(() =>
    {
      trigger.blur()
    })
    expect(isOpen(tip)).toBe(false)
  })

  it('stays open on pointer leave while its trigger has keyboard focus', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    fireEvent.pointerEnter(trigger)
    fireEvent.pointerLeave(trigger)
    advance(TOOLTIP_GRACE_MS * 2)
    expect(isOpen(tip)).toBe(true)
  })

  it('hides on pointer down and cancels a pending show', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    fireEvent.pointerDown(trigger)
    expect(isOpen(tip)).toBe(false)
    fireEvent.pointerEnter(trigger)
    advance(100)
    fireEvent.pointerDown(trigger)
    advance(TOOLTIP_DELAY_MS)
    expect(isOpen(tip)).toBe(false)
  })

  it('hides on a pointer down anywhere in the document', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    fireEvent.pointerDown(document.body)
    expect(isOpen(tip)).toBe(false)
  })

  it('hides when an ancestor scrolls, not when an unrelated scroller does', () =>
  {
    render(
      <>
        <div data-testid="list">
          <Tooltip content="Pause the run"><button type="button">Pause</button></Tooltip>
        </div>
        <div data-testid="log" />
      </>
    )
    const trigger = screen.getByRole('button')
    const tip = screen.getByRole('tooltip', { hidden: true })
    keyboardFocus(trigger)
    fireEvent.scroll(screen.getByTestId('log'))
    expect(isOpen(tip)).toBe(true)
    fireEvent.scroll(screen.getByTestId('list'))
    expect(isOpen(tip)).toBe(false)
    keyboardFocus(screen.getByTestId('log'))
    keyboardFocus(trigger)
    fireEvent.scroll(document)
    expect(isOpen(tip)).toBe(false)
  })

  it('follows the platform closing the popover', () =>
  {
    const { trigger, tip } = setup()
    keyboardFocus(trigger)
    const closed = Object.assign(new Event('toggle'), { newState: 'closed' })
    const opened = Object.assign(new Event('toggle'), { newState: 'open' })
    act(() =>
    {
      tip.dispatchEvent(opened)
    })
    expect(isOpen(tip)).toBe(true)
    act(() =>
    {
      tip.dispatchEvent(closed)
    })
    expect(isOpen(tip)).toBe(false)
  })

  it('with a focus delay waits the dwell before showing on keyboard focus', () =>
  {
    const { trigger, tip } = setup({ focusDelay: GRID_FOCUS_DELAY_MS })
    keyboardFocus(trigger)
    advance(GRID_FOCUS_DELAY_MS - 1)
    expect(isOpen(tip)).toBe(false)
    advance(1)
    expect(isOpen(tip)).toBe(true)
  })

  it('shows nothing when focus leaves within the dwell', () =>
  {
    const { trigger, tip } = setup({ focusDelay: 500 })
    keyboardFocus(trigger)
    advance(300)
    act(() =>
    {
      trigger.blur()
    })
    advance(1000)
    expect(isOpen(tip)).toBe(false)
  })

  it('ignores focus moving inside a trigger that holds the focusable element', () =>
  {
    render(
      <Tooltip content="Locked while the run is active" mode="label">
        <label>
          <input type="checkbox" />
          <input type="text" aria-label="Note" />
        </label>
      </Tooltip>
    )
    const [box, note] = [screen.getByRole('checkbox'), screen.getByRole('textbox')]
    const tip = screen.getByRole('tooltip', { hidden: true })
    keyboardFocus(box)
    expect(isOpen(tip)).toBe(true)
    keyboardFocus(note)
    expect(isOpen(tip)).toBe(true)
  })

  it('draws the shortcut as keycaps after the text', () =>
  {
    const { tip } = setup({ shortcut: 'Mod+P' })
    expect(tip.querySelectorAll('kbd')).toHaveLength(2)
    expect(tip).toHaveTextContent('Pause the runCtrl+P')
  })

  it('draws the tip as label text on the overlay with a strong frame', () =>
  {
    const { tip } = setup()
    expect(tip).toHaveClass('ui-tooltip', 'bg-overlay', 'border-line-strong', 'rounded-sm', 'shadow-overlay', 'text-label', 'text-ink', 'max-w-70', 'px-2', 'py-1')
  })

  it('renders the trigger alone without content, keeping it mounted when content arrives', () =>
  {
    const { rerender } = render(<Tooltip content=""><button type="button">Run</button></Tooltip>)
    const trigger = screen.getByRole('button')
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
    expect(trigger).not.toHaveAttribute('aria-describedby')
    rerender(<Tooltip content="Add files first"><button type="button">Run</button></Tooltip>)
    expect(screen.getByRole('button')).toBe(trigger)
    expect(trigger).toHaveAccessibleDescription('Add files first')
  })

  it('hides when its content goes away while open', () =>
  {
    const { rerender } = render(<Tooltip content="Add files first"><button type="button">Run</button></Tooltip>)
    const trigger = screen.getByRole('button')
    keyboardFocus(trigger)
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveAttribute('data-open')
    rerender(<Tooltip content=""><button type="button">Run</button></Tooltip>)
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('calls the trigger handlers it wraps', () =>
  {
    const handlers = {
      onPointerEnter: vi.fn(),
      onPointerLeave: vi.fn(),
      onPointerDown: vi.fn(),
      onFocus: vi.fn(),
      onBlur: vi.fn()
    }
    const { trigger } = setup({}, <button type="button" {...handlers}>Pause</button>)
    fireEvent.pointerEnter(trigger)
    fireEvent.pointerLeave(trigger)
    fireEvent.pointerDown(trigger)
    keyboardFocus(trigger)
    act(() =>
    {
      trigger.blur()
    })
    for (const handler of Object.values(handlers))
    {
      expect(handler).toHaveBeenCalledTimes(1)
    }
  })

  it('clears its timers when it unmounts', () =>
  {
    const { trigger } = setup()
    fireEvent.pointerEnter(trigger)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })
})
