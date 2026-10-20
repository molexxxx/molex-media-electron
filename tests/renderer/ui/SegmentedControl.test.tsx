/**
 * SegmentedControl: a radio group of segments named by its caption, with one Tab stop, arrows that move
 * and check with wrap and skip disabled segments, Home and End, the mixed state (no checked segment, the
 * first enabled one tabbable, the "Mixed" hint in the description), the error state, and per-segment
 * descriptions.
 */
import React, { useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SegmentedControl, type SegmentOption, type SegmentedControlProps } from '../../../src/renderer/src/ui/SegmentedControl'
import { FieldCaption } from '../../../src/renderer/src/ui/FieldCaption'

type Mode = 'size' | 'quality' | 'lossless' | 'copy'

const MODES: ReadonlyArray<SegmentOption<Mode>> = [
  { value: 'size', label: 'Size' },
  { value: 'quality', label: 'Quality' },
  { value: 'lossless', label: 'Lossless', disabled: true },
  { value: 'copy', label: 'Copy' }
]

function Field(props: Partial<SegmentedControlProps<Mode>> & { initial?: Mode | null, hint?: string }): ReactElement
{
  const { initial = 'size', hint, ...rest } = props
  const [value, setValue] = useState<Mode | null>(initial)
  const shownHint = hint ?? (value === null ? 'Mixed' : undefined)
  return (
    <>
      <FieldCaption id="mode" hint={shownHint}>Compress mode</FieldCaption>
      <SegmentedControl
        value={value}
        options={MODES}
        labelledBy="mode"
        describedBy={shownHint ? 'mode-hint' : undefined}
        {...rest}
        onChange={(next) =>
        {
          rest.onChange?.(next)
          setValue(next)
        }}
      />
    </>
  )
}

function radio(name: string): HTMLButtonElement
{
  return screen.getByRole('radio', { name }) as HTMLButtonElement
}

function tabStops(): HTMLElement[]
{
  return screen.getAllByRole('radio').filter((element) => element.tabIndex === 0)
}

describe('SegmentedControl', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a radiogroup named by its caption, of native buttons with radio roles', () =>
  {
    render(<Field />)
    const group = screen.getByRole('radiogroup', { name: 'Compress mode' })
    expect(group).toHaveAttribute('aria-labelledby', 'mode')
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    for (const element of radios)
    {
      expect(element.tagName).toBe('BUTTON')
      expect(element).toHaveAttribute('type', 'button')
      expect(element.parentElement).toBe(group)
    }
    expect(radio('Size')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Quality')).toHaveAttribute('aria-checked', 'false')
  })

  it('gives the checked segment the only Tab stop', () =>
  {
    render(<Field initial="quality" />)
    expect(tabStops()).toEqual([radio('Quality')])
    expect(radio('Size').tabIndex).toBe(-1)
  })

  it('moves focus and calls onChange with the next value on Right and Down, wrapping and skipping disabled', () =>
  {
    const onChange = vi.fn()
    render(<Field initial="quality" onChange={onChange} />)
    fireEvent.keyDown(radio('Quality'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('copy')
    expect(document.activeElement).toBe(radio('Copy'))
    expect(radio('Copy')).toHaveAttribute('aria-checked', 'true')
    expect(tabStops()).toEqual([radio('Copy')])
    fireEvent.keyDown(radio('Copy'), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('size')
    expect(document.activeElement).toBe(radio('Size'))
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('reverses on Left and Up, wrapping and skipping disabled', () =>
  {
    const onChange = vi.fn()
    render(<Field initial="size" onChange={onChange} />)
    fireEvent.keyDown(radio('Size'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('copy')
    expect(document.activeElement).toBe(radio('Copy'))
    fireEvent.keyDown(radio('Copy'), { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('quality')
    expect(document.activeElement).toBe(radio('Quality'))
  })

  it('reaches the first and last enabled segments with Home and End', () =>
  {
    const onChange = vi.fn()
    const options: ReadonlyArray<SegmentOption<Mode>> = [
      { value: 'size', label: 'Size', disabled: true },
      { value: 'quality', label: 'Quality' },
      { value: 'lossless', label: 'Lossless' },
      { value: 'copy', label: 'Copy', disabled: true }
    ]
    render(<Field initial="quality" options={options} onChange={onChange} />)
    fireEvent.keyDown(radio('Quality'), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('lossless')
    expect(document.activeElement).toBe(radio('Lossless'))
    fireEvent.keyDown(radio('Lossless'), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('quality')
    expect(document.activeElement).toBe(radio('Quality'))
  })

  it('keeps disabled segments out of reach and draws them in disabled ink', () =>
  {
    render(<Field />)
    const lossless = radio('Lossless')
    expect(lossless).toBeDisabled()
    expect(lossless).toHaveClass('disabled:text-ink-disabled')
    expect(lossless.tabIndex).toBe(-1)
  })

  it('calls onChange when an unchecked segment is clicked, and not for the checked one', () =>
  {
    const onChange = vi.fn()
    render(<Field onChange={onChange} />)
    fireEvent.click(radio('Size'))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(radio('Copy'))
    expect(onChange).toHaveBeenCalledWith('copy')
    expect(radio('Copy')).toHaveAttribute('aria-checked', 'true')
  })

  it('with a null value checks no segment, makes the first enabled one tabbable, and describes the group as Mixed', () =>
  {
    const options: ReadonlyArray<SegmentOption<Mode>> = [
      { value: 'size', label: 'Size', disabled: true },
      ...MODES.slice(1)
    ]
    render(<Field initial={null} options={options} />)
    for (const element of screen.getAllByRole('radio'))
    {
      expect(element).toHaveAttribute('aria-checked', 'false')
    }
    expect(tabStops()).toEqual([radio('Quality')])
    const group = screen.getByRole('radiogroup', { name: 'Compress mode' })
    const described = (group.getAttribute('aria-describedby') ?? '').split(' ')
    expect(described).toContain('mode-hint')
    expect(document.getElementById('mode-hint')).toHaveTextContent('Mixed')
    expect(group).toHaveAccessibleDescription('Mixed')
  })

  it('checks the focused segment with Space while none is checked', () =>
  {
    const onChange = vi.fn()
    render(<Field initial={null} onChange={onChange} />)
    const size = radio('Size')
    size.focus()
    fireEvent.keyDown(size, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('size')
    expect(size).toHaveAttribute('aria-checked', 'true')
  })

  it('moves from the mixed state with an arrow, checking the next segment', () =>
  {
    const onChange = vi.fn()
    render(<Field initial={null} onChange={onChange} />)
    fireEvent.keyDown(radio('Size'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('quality')
  })

  it('leaves modified and other keys to the page', () =>
  {
    const onChange = vi.fn()
    render(<Field onChange={onChange} />)
    for (const init of [{ key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', altKey: true }, { key: 'ArrowRight', metaKey: true }, { key: 'a' }, { key: 'Enter' }])
    {
      const event = fireEvent.keyDown(radio('Size'), init)
      expect(event).toBe(true)
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stays on the only enabled segment when arrows find no other', () =>
  {
    const onChange = vi.fn()
    const options: ReadonlyArray<SegmentOption<Mode>> = [
      { value: 'size', label: 'Size' },
      { value: 'quality', label: 'Quality', disabled: true }
    ]
    render(<Field options={options} onChange={onChange} />)
    fireEvent.keyDown(radio('Size'), { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(radio('Size'))
  })

  it('shows a checked segment that became disabled and moves the Tab stop to the first enabled one', () =>
  {
    const options: ReadonlyArray<SegmentOption<Mode>> = [
      { value: 'size', label: 'Size' },
      { value: 'quality', label: 'Quality', disabled: true }
    ]
    render(<Field initial="quality" options={options} />)
    expect(radio('Quality')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Quality')).toBeDisabled()
    expect(tabStops()).toEqual([radio('Size')])
  })

  it('sets aria-invalid and describes the group with the error', () =>
  {
    render(<Field error="Choose a mode for every job." hint="Applies to the selection" />)
    const group = screen.getByRole('radiogroup', { name: 'Compress mode' })
    expect(group).toHaveAttribute('aria-invalid', 'true')
    expect(group).toHaveAccessibleDescription('Applies to the selection Choose a mode for every job.')
    expect(group).toHaveClass('outline-error-fill')
    expect(screen.getByText('Choose a mode for every job.')).toBeVisible()
  })

  it('takes a disabled group out of the tab order', () =>
  {
    render(<Field disabled />)
    const group = screen.getByRole('radiogroup', { name: 'Compress mode' })
    expect(group).toHaveAttribute('aria-disabled', 'true')
    expect(tabStops()).toEqual([])
    for (const element of screen.getAllByRole('radio'))
    {
      expect(element).toBeDisabled()
    }
  })

  it('links each segment description through its own aria-describedby', () =>
  {
    const options: ReadonlyArray<SegmentOption<Mode>> = [
      { value: 'size', label: 'Size', description: 'Aims for a file size.' },
      { value: 'quality', label: 'Quality', icon: 'op.compress' }
    ]
    render(<Field options={options} />)
    expect(radio('Size')).toHaveAccessibleDescription('Aims for a file size.')
    expect(radio('Quality')).not.toHaveAttribute('aria-describedby')
    expect(radio('Quality').querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('takes an aria-label, a size, and a class, and carries boolean values', () =>
  {
    const onChange = vi.fn()
    const { container } = render(
      <SegmentedControl
        value={false}
        onChange={onChange}
        options={[{ value: false, label: 'Off' }, { value: true, label: 'On', icon: 'op.compress' }]}
        label="GPU encoding"
        size="sm"
        className="mt-2"
      />
    )
    const group = screen.getByRole('radiogroup', { name: 'GPU encoding' })
    expect(group).toHaveClass('h-7')
    expect(radio('Off')).toHaveClass('h-(--size-control-sm)', 'text-label')
    expect(radio('On').querySelector('svg')).toHaveAttribute('width', '14')
    expect(container.firstElementChild).toHaveClass('mt-2')
    expect(group).not.toHaveAttribute('aria-describedby')
    fireEvent.click(radio('On'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('draws the checked segment raised with an inset frame and the md metrics', () =>
  {
    render(<Field />)
    expect(screen.getByRole('radiogroup')).toHaveClass('h-(--size-control-md)', 'outline-line-strong', 'bg-sunken')
    expect(radio('Size')).toHaveClass('bg-raised', 'text-ink', 'inset-ring-line-control', 'h-7', 'min-w-10')
    expect(radio('Quality')).toHaveClass('text-ink-2')
  })
})
