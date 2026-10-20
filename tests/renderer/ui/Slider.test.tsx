/**
 * Slider: the native range input with its limits and step, value text that carries the unit, live input
 * through onInput and commits through onChange with their source, the bigStep page keys, the mixed state
 * (no fill, hollow thumb, "Mixed" spoken), merged descriptions, and the disabled state.
 */
import React, { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Slider, type SliderProps } from '../../../src/renderer/src/ui/Slider'

const MINUS = '−'

function lufs(value: number): string
{
  return `${value.toFixed(1).replace('-', MINUS)} LUFS`
}

type Rendered = ReturnType<typeof render> & {
  slider: HTMLInputElement
  onInput: ReturnType<typeof vi.fn>
  onChange: ReturnType<typeof vi.fn>
}

function renderSlider(props: Partial<SliderProps> = {}): Rendered
{
  const onInput = vi.fn()
  const onChange = vi.fn()
  const utils = render(
    <Slider
      label="Integrated target"
      value={-16}
      min={-30}
      max={-5}
      step={0.5}
      valueText={lufs}
      onInput={onInput}
      onChange={onChange}
      {...props}
    />
  )
  return { ...utils, slider: screen.getByRole('slider', { name: 'Integrated target' }) as HTMLInputElement, onInput, onChange }
}

function fillOf(slider: HTMLInputElement): string
{
  return slider.style.getPropertyValue('--fill')
}

describe('Slider', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('is a range input with min, max, and step', () =>
  {
    const { slider } = renderSlider()
    expect(slider).toHaveAttribute('type', 'range')
    expect(slider).toHaveAttribute('min', '-30')
    expect(slider).toHaveAttribute('max', '-5')
    expect(slider).toHaveAttribute('step', '0.5')
    expect(slider.value).toBe('-16')
    expect(slider).toHaveClass('ui-slider')
    expect(fillOf(slider)).toBe('56%')
  })

  it('speaks the value with its unit', () =>
  {
    const { slider } = renderSlider()
    expect(slider).toHaveAttribute('aria-valuetext', `${MINUS}16.0 LUFS`)
  })

  it('reports live input through onInput and shows the moved thumb before the value catches up', () =>
  {
    const { slider, onInput, onChange } = renderSlider()
    fireEvent.input(slider, { target: { value: '-12' } })
    expect(onInput).toHaveBeenCalledWith(-12)
    expect(onChange).not.toHaveBeenCalled()
    expect(slider.value).toBe('-12')
    expect(slider).toHaveAttribute('aria-valuetext', `${MINUS}12.0 LUFS`)
    expect(fillOf(slider)).toBe('72%')
  })

  it('reports a commit through onChange with a pointer source after a press', () =>
  {
    const { slider, onChange } = renderSlider()
    fireEvent.pointerDown(slider)
    fireEvent.input(slider, { target: { value: '-10' } })
    fireEvent.change(slider, { target: { value: '-10' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(-10, 'pointer')
  })

  it('reports a commit with a keyboard source after a key and by default', () =>
  {
    const { slider, onChange } = renderSlider()
    fireEvent.change(slider, { target: { value: '-15.5' } })
    expect(onChange).toHaveBeenLastCalledWith(-15.5, 'keyboard')
    fireEvent.pointerDown(slider)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.change(slider, { target: { value: '-15' } })
    expect(onChange).toHaveBeenLastCalledWith(-15, 'keyboard')
  })

  it('works without onInput', () =>
  {
    const { slider, onChange } = renderSlider({ onInput: undefined })
    fireEvent.input(slider, { target: { value: '-20' } })
    expect(slider.value).toBe('-20')
    fireEvent.change(slider, { target: { value: '-20' } })
    expect(onChange).toHaveBeenCalledWith(-20, 'keyboard')
  })

  it('steps by bigStep on PageUp and PageDown and clamps at the limits', () =>
  {
    const { slider, onInput, onChange } = renderSlider({ bigStep: 5 })
    expect(fireEvent.keyDown(slider, { key: 'PageUp' })).toBe(false)
    expect(onInput).toHaveBeenLastCalledWith(-11)
    expect(onChange).toHaveBeenLastCalledWith(-11, 'keyboard')
    expect(slider.value).toBe('-11')
    fireEvent.keyDown(slider, { key: 'PageUp' })
    expect(onChange).toHaveBeenLastCalledWith(-6, 'keyboard')
    fireEvent.keyDown(slider, { key: 'PageUp' })
    expect(onChange).toHaveBeenLastCalledWith(-5, 'keyboard')
    expect(fireEvent.keyDown(slider, { key: 'PageUp' })).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(slider, { key: 'PageDown' })
    expect(onChange).toHaveBeenLastCalledWith(-10, 'keyboard')
  })

  it('rounds big steps to the step on an integer scale', () =>
  {
    const onChange = vi.fn()
    render(<Slider label="Quality" value={23} min={0} max={51} step={1} bigStep={10} valueText={(v) => `CRF ${v}`} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Quality' }), { key: 'PageDown' })
    expect(onChange).toHaveBeenCalledWith(13, 'keyboard')
  })

  it('leaves page keys to the platform without bigStep, and modified or other keys always', () =>
  {
    const { slider, onChange } = renderSlider()
    expect(fireEvent.keyDown(slider, { key: 'PageUp' })).toBe(true)
    cleanup()
    const second = renderSlider({ bigStep: 5 })
    expect(fireEvent.keyDown(second.slider, { key: 'PageUp', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(second.slider, { key: 'PageDown', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(second.slider, { key: 'PageDown', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(second.slider, { key: 'PageDown', metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(second.slider, { key: 'Home' })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    expect(second.onChange).not.toHaveBeenCalled()
  })

  it('retires a held move once the value prop changes, even back to its old value', () =>
  {
    const { slider, rerender, onChange } = renderSlider()
    fireEvent.input(slider, { target: { value: '-12' } })
    rerender(<Slider label="Integrated target" value={-10} min={-30} max={-5} step={0.5} valueText={lufs} onChange={onChange} />)
    expect(slider.value).toBe('-10')
    rerender(<Slider label="Integrated target" value={-16} min={-30} max={-5} step={0.5} valueText={lufs} onChange={onChange} />)
    expect(slider.value).toBe('-16')
  })

  it('shows mixed with no fill, a hollow thumb, and "Mixed" spoken until the thumb moves', () =>
  {
    const { slider } = renderSlider({ value: -17.5, mixed: true })
    expect(slider).toHaveAttribute('data-mixed', 'true')
    expect(slider).toHaveAttribute('aria-valuetext', 'Mixed')
    fireEvent.input(slider, { target: { value: '-14' } })
    expect(slider).not.toHaveAttribute('data-mixed')
    expect(slider).toHaveAttribute('aria-valuetext', `${MINUS}14.0 LUFS`)
  })

  it('merges describedBy with its own error id and marks the error', () =>
  {
    render(
      <>
        <span id="target-hint">From {MINUS}30 to {MINUS}5 LUFS</span>
        <Slider
          label="Integrated target"
          value={-16}
          min={-30}
          max={-5}
          step={0.5}
          valueText={lufs}
          onChange={() => {}}
          describedBy="target-hint"
          error="This preset fixes the target."
        />
      </>
    )
    const slider = screen.getByRole('slider', { name: 'Integrated target' })
    expect(slider).toHaveAttribute('aria-invalid', 'true')
    expect(slider).toHaveAccessibleDescription(`From ${MINUS}30 to ${MINUS}5 LUFS This preset fixes the target.`)
    expect(screen.getByText('This preset fixes the target.')).toBeVisible()
  })

  it('passes describedBy alone without an error', () =>
  {
    const { slider } = renderSlider({ describedBy: 'target-hint' })
    expect(slider).toHaveAttribute('aria-describedby', 'target-hint')
    expect(slider).not.toHaveAttribute('aria-invalid')
  })

  it('disables the range natively', () =>
  {
    const { slider } = renderSlider({ disabled: true })
    expect(slider).toBeDisabled()
  })

  it('takes its name from labelledBy', () =>
  {
    render(
      <>
        <span id="gain-caption">Gain</span>
        <Slider labelledBy="gain-caption" value={0} min={-12} max={12} step={0.5} valueText={(v) => `${v} dB`} onChange={() => {}} />
      </>
    )
    expect(screen.getByRole('slider', { name: 'Gain' })).toHaveAttribute('aria-valuetext', '0 dB')
  })

  it('draws no fill when the range is empty', () =>
  {
    const { slider } = renderSlider({ value: 0, min: 0, max: 0 })
    expect(fillOf(slider)).toBe('0%')
  })

  it('stops reporting commits once unmounted', () =>
  {
    const { slider, onChange, unmount } = renderSlider()
    unmount()
    slider.dispatchEvent(new Event('change'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts className on the outer box and forwards the ref to the input', () =>
  {
    const ref = createRef<HTMLInputElement>()
    const { slider } = renderSlider({ ref, className: '[--ui-slider-ground:var(--color-overlay)]' })
    expect(ref.current).toBe(slider)
    expect(slider.parentElement).toHaveClass('[--ui-slider-ground:var(--color-overlay)]')
  })
})
