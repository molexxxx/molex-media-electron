/**
 * Checkbox: a native checkbox inside its own label row, which names it and is its target. Covers the
 * mixed state through `indeterminate` (activating it checks the box, and a pending commit never shows a
 * lie), change reporting, the error state, and an unavailable reason that keeps the box focusable.
 */
import React, { createRef, useState, type ChangeEvent, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Checkbox } from '../../../src/renderer/src/ui/Checkbox'

/** An inspector boolean over several jobs: mixed until a click sets every job. */
function Recipe(): ReactElement
{
  const [state, setState] = useState<{ checked: boolean, mixed: boolean }>({ checked: false, mixed: true })
  return (
    <Checkbox
      checked={state.checked}
      indeterminate={state.mixed}
      onChange={(event) => setState({ checked: event.currentTarget.checked, mixed: false })}
    >
      Keep subtitles
    </Checkbox>
  )
}

function box(name: string): HTMLInputElement
{
  return screen.getByRole('checkbox', { name }) as HTMLInputElement
}

describe('Checkbox', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a native checkbox inside its own label and named by it', () =>
  {
    render(<Checkbox defaultChecked={false}>Two-pass</Checkbox>)
    const input = box('Two-pass')
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('type', 'checkbox')
    expect(input).toHaveClass('ui-checkbox')
    const label = input.closest('label') as HTMLLabelElement
    expect(label).not.toBeNull()
    expect(label).toHaveTextContent('Two-pass')
    expect(label).toHaveClass('min-h-(--size-target-min)')
  })

  it('sets indeterminate from the prop and exposes it as mixed', () =>
  {
    const { rerender } = render(<Checkbox checked={false} indeterminate onChange={() => {}}>Keep subtitles</Checkbox>)
    expect(box('Keep subtitles')).toBePartiallyChecked()
    expect(box('Keep subtitles').indeterminate).toBe(true)
    rerender(<Checkbox checked={false} onChange={() => {}}>Keep subtitles</Checkbox>)
    expect(box('Keep subtitles')).not.toBePartiallyChecked()
  })

  it('checks every job when the mixed box is activated', () =>
  {
    render(<Recipe />)
    const input = box('Keep subtitles')
    expect(input).toBePartiallyChecked()
    fireEvent.click(input)
    expect(input).toBeChecked()
    expect(input).not.toBePartiallyChecked()
    fireEvent.click(input)
    expect(input).not.toBeChecked()
  })

  it('stays mixed while a commit from the mixed state has not landed', () =>
  {
    const requested: boolean[] = []
    const onChange = vi.fn((event: ChangeEvent<HTMLInputElement>) =>
    {
      requested.push(event.currentTarget.checked)
    })
    render(<Checkbox checked={false} indeterminate onChange={onChange}>Keep subtitles</Checkbox>)
    const input = box('Keep subtitles')
    fireEvent.click(input)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(requested).toEqual([true])
    expect(input).not.toBeChecked()
    expect(input).toBePartiallyChecked()
  })

  it('calls onChange and onClick when activated', () =>
  {
    const onChange = vi.fn()
    const onClick = vi.fn()
    render(<Checkbox onChange={onChange} onClick={onClick}>One folder per preset</Checkbox>)
    const input = box('One folder per preset')
    fireEvent.click(input)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(input).toBeChecked()
  })

  it('toggles from its label row, and works without handlers', () =>
  {
    render(<Checkbox>Include subfolders</Checkbox>)
    fireEvent.click(screen.getByText('Include subfolders'))
    expect(box('Include subfolders')).toBeChecked()
  })

  it('marks an error with aria-invalid and describes the box with the message', () =>
  {
    render(
      <>
        <span id="ack-hint">Originals move to the Recycle Bin</span>
        <Checkbox describedBy="ack-hint" error="Acknowledge the replacement to start.">Replace originals</Checkbox>
      </>
    )
    const input = box('Replace originals')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Originals move to the Recycle Bin Acknowledge the replacement to start.')
    expect(screen.getByText('Acknowledge the replacement to start.')).toBeVisible()
  })

  it('passes describedBy alone without an error or reason', () =>
  {
    render(<Checkbox describedBy="hint">Keep source subfolders</Checkbox>)
    const input = box('Keep source subfolders')
    expect(input).toHaveAttribute('aria-describedby', 'hint')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).not.toHaveAttribute('aria-disabled')
  })

  it('with an unavailable reason sets aria-disabled, keeps focus, ignores activation, and shows the reason', () =>
  {
    const onChange = vi.fn()
    const onClick = vi.fn()
    render(
      <Checkbox unavailableReason="Not available with GPU encoding." disabled onChange={onChange} onClick={onClick}>
        Two-pass
      </Checkbox>
    )
    const input = box('Two-pass')
    expect(input).toHaveAttribute('aria-disabled', 'true')
    expect(input).not.toBeDisabled()
    act(() =>
    {
      input.focus()
    })
    expect(document.activeElement).toBe(input)
    expect(fireEvent.click(input)).toBe(false)
    fireEvent.click(screen.getByText('Two-pass'))
    expect(input).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
    expect(onClick).not.toHaveBeenCalled()
    const reason = screen.getByText('Not available with GPU encoding.', { selector: ':not([role="tooltip"])' })
    expect(reason).toBeVisible()
    expect(reason.closest('label')).toBeNull()
    expect(input).toHaveAccessibleDescription('Not available with GPU encoding.')
    expect(input.closest('label')).toHaveClass('text-ink-disabled')
  })

  it('repeats the unavailable reason as the row tooltip, shown on keyboard focus and hidden from assistive technology', () =>
  {
    render(<Checkbox unavailableReason="Not available with GPU encoding.">Two-pass</Checkbox>)
    const input = box('Two-pass')
    const tip = screen.getByRole('tooltip', { hidden: true })
    const row = input.closest('label') as HTMLElement
    expect(tip).toHaveTextContent('Not available with GPU encoding.')
    expect(tip).toHaveAttribute('aria-hidden', 'true')
    expect(row).not.toContainElement(tip)
    expect(input).toHaveAccessibleName('Two-pass')
    expect(input).toHaveAccessibleDescription('Not available with GPU encoding.')
    fireEvent.keyDown(document.body, { key: 'Tab' })
    act(() =>
    {
      input.focus()
    })
    expect(tip).toHaveAttribute('data-open')
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(tip).not.toHaveAttribute('data-open')
    expect(document.activeElement).toBe(input)
  })

  it('renders no tooltip while the box is available, and keeps the box when the reason clears', () =>
  {
    const { rerender } = render(<Checkbox unavailableReason="Locked during the run.">Keep subtitles</Checkbox>)
    const input = box('Keep subtitles')
    rerender(<Checkbox>Keep subtitles</Checkbox>)
    expect(box('Keep subtitles')).toBe(input)
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  })

  it('keeps a mixed box mixed when an unavailable box is activated', () =>
  {
    const onChange = vi.fn()
    render(<Checkbox indeterminate unavailableReason="Locked during the run." onChange={onChange}>Keep subtitles</Checkbox>)
    const input = box('Keep subtitles')
    expect(fireEvent.click(input)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(input).toBePartiallyChecked()
    expect(input).not.toBeChecked()
  })

  it('is disabled natively without a reason', () =>
  {
    const onChange = vi.fn()
    render(<Checkbox disabled onChange={onChange}>Album group</Checkbox>)
    const input = box('Album group')
    expect(input).toBeDisabled()
    expect(input).not.toHaveAttribute('aria-disabled')
    expect(input.closest('label')).toHaveClass('text-ink-disabled')
    act(() =>
    {
      input.click()
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(input).not.toBeChecked()
  })

  it('passes native attributes through, puts className on the outer box, and forwards the ref', () =>
  {
    const ref = createRef<HTMLInputElement>()
    render(
      <Checkbox ref={ref} id="ack" name="acknowledge" value="yes" className="mt-2">
        I understand
      </Checkbox>
    )
    const input = box('I understand')
    expect(ref.current).toBe(input)
    expect(input).toHaveAttribute('id', 'ack')
    expect(input).toHaveAttribute('name', 'acknowledge')
    expect(input).toHaveAttribute('value', 'yes')
    expect(input.closest('label')?.parentElement).toHaveClass('mt-2')
    expect(input.closest('label')).toHaveClass('text-ink')
  })
})
