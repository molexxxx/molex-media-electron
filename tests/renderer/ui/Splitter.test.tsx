/**
 * Splitter: a focusable vertical separator with its size and limits in px, Left and Right steps of 16 px
 * in the direction of the sized pane, Home and End to the limits, a double-click reset, pointer dragging
 * that commits once on release, and a 24 px hit area centered on its 1 px line.
 */
import React, { useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Splitter, SPLITTER_STEP, type SplitterProps } from '../../../src/renderer/src/ui/Splitter'

type ControlledProps = Omit<SplitterProps, 'value' | 'onChange' | 'label' | 'min' | 'max'> & {
  initial?: number
  onChange?: (value: number) => void
}

function Controlled({ initial = 360, onChange, ...rest }: ControlledProps): ReactElement
{
  const [value, setValue] = useState(initial)
  return (
    <Splitter
      label="Inspector width"
      min={300}
      max={520}
      {...rest}
      value={value}
      onChange={(next) =>
      {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

function separator(): HTMLElement
{
  return screen.getByRole('separator', { name: 'Inspector width' })
}

function classesOf(element: Element): string[]
{
  return element.className.split(/\s+/).filter(Boolean)
}

describe('Splitter', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a focusable vertical separator named by what it sizes, with its size and limits', () =>
  {
    render(<Controlled />)
    const line = separator()
    expect(line).toHaveAttribute('aria-orientation', 'vertical')
    expect(line).toHaveAttribute('aria-valuenow', '360')
    expect(line).toHaveAttribute('aria-valuemin', '300')
    expect(line).toHaveAttribute('aria-valuemax', '520')
    expect(line).toHaveAttribute('aria-valuetext', '360 pixels')
    expect(line).toHaveAttribute('tabindex', '0')
    expect(line).toHaveAttribute('data-focus', 'inset')
    line.focus()
    expect(document.activeElement).toBe(line)
  })

  it('steps 16 px with Left and Right, growing a pane after the line as the line moves left', () =>
  {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<Controlled pane="after" onChange={onChange} onCommit={onCommit} />)
    const line = separator()
    expect(SPLITTER_STEP).toBe(16)
    expect(fireEvent.keyDown(line, { key: 'ArrowLeft' })).toBe(false)
    expect(line).toHaveAttribute('aria-valuenow', '376')
    expect(onChange).toHaveBeenLastCalledWith(376)
    expect(onCommit).toHaveBeenLastCalledWith(376)
    fireEvent.keyDown(line, { key: 'ArrowRight' })
    fireEvent.keyDown(line, { key: 'ArrowRight' })
    expect(line).toHaveAttribute('aria-valuenow', '344')
    expect(onCommit).toHaveBeenCalledTimes(3)
  })

  it('grows a pane before the line as the line moves right, by a custom step', () =>
  {
    render(<Controlled step={8} />)
    const line = separator()
    fireEvent.keyDown(line, { key: 'ArrowRight' })
    expect(line).toHaveAttribute('aria-valuenow', '368')
    fireEvent.keyDown(line, { key: 'ArrowLeft' })
    fireEvent.keyDown(line, { key: 'ArrowLeft' })
    expect(line).toHaveAttribute('aria-valuenow', '352')
  })

  it('reaches the limits with Home and End and never steps past them', () =>
  {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<Controlled initial={512} pane="after" onChange={onChange} onCommit={onCommit} />)
    const line = separator()
    fireEvent.keyDown(line, { key: 'ArrowLeft' })
    expect(line).toHaveAttribute('aria-valuenow', '520')
    onChange.mockClear()
    fireEvent.keyDown(line, { key: 'ArrowLeft' })
    expect(onChange).not.toHaveBeenCalled()
    expect(onCommit).toHaveBeenLastCalledWith(520)
    expect(fireEvent.keyDown(line, { key: 'Home' })).toBe(false)
    expect(line).toHaveAttribute('aria-valuenow', '300')
    fireEvent.keyDown(line, { key: 'End' })
    expect(line).toHaveAttribute('aria-valuenow', '520')
  })

  it('leaves other keys to the page', () =>
  {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    expect(fireEvent.keyDown(separator(), { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(separator(), { key: 'ArrowUp' })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resets to the default size on double-click, and does nothing without one', () =>
  {
    const onCommit = vi.fn()
    const { unmount } = render(<Controlled initial={440} defaultValue={360} onCommit={onCommit} />)
    fireEvent.doubleClick(separator())
    expect(separator()).toHaveAttribute('aria-valuenow', '360')
    expect(onCommit).toHaveBeenCalledWith(360)
    unmount()

    const onChange = vi.fn()
    render(<Controlled initial={440} onChange={onChange} />)
    fireEvent.doubleClick(separator())
    expect(separator()).toHaveAttribute('aria-valuenow', '440')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('follows a drag with the pointer captured and commits once on release', () =>
  {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<Controlled pane="after" onChange={onChange} onCommit={onCommit} />)
    const line = separator()
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(line, { setPointerCapture: capture, releasePointerCapture: release })

    fireEvent.pointerDown(line, { button: 0, pointerId: 1, clientX: 1000 })
    expect(capture).toHaveBeenCalledWith(1)
    expect(line).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 980 })
    expect(onChange).toHaveBeenLastCalledWith(380)
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 980 })
    expect(onChange).toHaveBeenCalledTimes(1)
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 900 })
    expect(line).toHaveAttribute('aria-valuenow', '460')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(line, { pointerId: 1, clientX: 900 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(460)
    expect(release).toHaveBeenCalledWith(1)
    expect(line).not.toHaveAttribute('data-dragging')

    fireEvent.pointerMove(line, { pointerId: 1, clientX: 800 })
    expect(line).toHaveAttribute('aria-valuenow', '460')
  })

  it('clamps a drag to the limits', () =>
  {
    render(<Controlled />)
    const line = separator()
    fireEvent.pointerDown(line, { button: 0, pointerId: 3, clientX: 500 })
    fireEvent.pointerMove(line, { pointerId: 3, clientX: 2000 })
    expect(line).toHaveAttribute('aria-valuenow', '520')
    fireEvent.pointerMove(line, { pointerId: 3, clientX: -2000 })
    expect(line).toHaveAttribute('aria-valuenow', '300')
    fireEvent.pointerUp(line, { pointerId: 3 })
  })

  it('ignores secondary buttons and other pointers, and ends a canceled drag', () =>
  {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<Controlled onChange={onChange} onCommit={onCommit} />)
    const line = separator()
    fireEvent.pointerDown(line, { button: 2, pointerId: 1, clientX: 500 })
    expect(line).not.toHaveAttribute('data-dragging')
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 600 })
    fireEvent.pointerUp(line, { pointerId: 1, clientX: 600 })
    expect(onChange).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerDown(line, { button: 0, pointerId: 1, clientX: 500 })
    fireEvent.pointerMove(line, { pointerId: 2, clientX: 600 })
    fireEvent.pointerUp(line, { pointerId: 2, clientX: 600 })
    expect(onChange).not.toHaveBeenCalled()
    expect(line).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerMove(line, { pointerId: 1, clientX: 510 })
    fireEvent.pointerCancel(line, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(370)
    expect(line).not.toHaveAttribute('data-dragging')
  })

  it('owns a 24 px hit area centered on a 1 px line that lights on hover and drag', () =>
  {
    render(<Controlled className="order-2" />)
    const classes = classesOf(separator())
    expect(classes).toEqual(expect.arrayContaining([
      'w-(--size-target-min)',
      '-mx-[11.5px]',
      'z-(--z-index-splitter)',
      'cursor-col-resize',
      'touch-none',
      'before:border-s',
      'before:border-line-strong',
      'hover:before:border-line-control-hover',
      'data-dragging:before:border-line-control-hover',
      'order-2'
    ]))
  })
})
