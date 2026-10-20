/**
 * NumberField: a text field with spinbutton semantics and a draft model. Guards the regressions it
 * replaces: an empty field committing 0, Home committing the minimum to every selected job, one command
 * per key press, and a primary action running with a value the field shows but never committed.
 */
import React, { createRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import {
  FieldMessage,
  MIXED_LABEL,
  NumberField,
  STEP_COMMIT_DELAY_MS,
  type CommitDraftResult,
  type NumberFieldHandle,
  type NumberFieldProps
} from '../../../src/renderer/src/ui/NumberField'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'

const MINUS = '−'

type FieldProps = Partial<Omit<NumberFieldProps, 'value'>> & { initial?: number | null }

/** A controlled field on the true-peak scale: step 0.1, from -9 to -1 dBTP. */
function Field({ initial = -5, onCommit, ...rest }: FieldProps): ReactElement
{
  const [value, setValue] = useState<number | null>(initial)
  return (
    <NumberField
      label="Maximum true peak"
      step={0.1}
      min={-9}
      max={-1}
      unit="dBTP"
      {...rest}
      value={value}
      onCommit={(next) =>
      {
        setValue(next)
        return onCommit?.(next)
      }}
    />
  )
}

function field(name = 'Maximum true peak'): HTMLInputElement
{
  return screen.getByRole('spinbutton', { name }) as HTMLInputElement
}

function type(input: HTMLInputElement, text: string): void
{
  fireEvent.change(input, { target: { value: text } })
}

function focus(input: HTMLInputElement): void
{
  act(() =>
  {
    input.focus()
  })
}

function blur(input: HTMLInputElement): void
{
  act(() =>
  {
    input.blur()
  })
}

function advance(ms: number): void
{
  act(() =>
  {
    vi.advanceTimersByTime(ms)
  })
}

async function commitDraft(ref: { current: NumberFieldHandle | null }): Promise<CommitDraftResult>
{
  let result: CommitDraftResult | undefined
  await act(async () =>
  {
    result = await (ref.current as NumberFieldHandle).commitDraft()
  })
  return result as CommitDraftResult
}

describe('NumberField', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.useRealTimers()
  })

  it('exposes spinbutton semantics with the value, its limits, and the value text with its unit', () =>
  {
    render(<Field />)
    const input = field()
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('inputmode', 'decimal')
    expect(input).toHaveAttribute('aria-valuenow', '-5')
    expect(input).toHaveAttribute('aria-valuemin', '-9')
    expect(input).toHaveAttribute('aria-valuemax', '-1')
    expect(input).toHaveAttribute('aria-valuetext', `${MINUS}5.0 dBTP`)
    expect(input.value).toBe(`${MINUS}5.0`)
    const unit = screen.getByText('dBTP')
    expect(unit).toHaveAttribute('aria-hidden', 'true')
    expect(input).toHaveAttribute('data-size', 'md')
  })

  it('steps with Up and Down, by ten steps with Shift, and commits once after the keys go idle', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false)
    expect(input.value).toBe(`${MINUS}4.9`)
    expect(input).toHaveAttribute('aria-valuenow', '-4.9')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe(`${MINUS}5.1`)
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true })
    expect(input.value).toBe(`${MINUS}4.1`)
    advance(STEP_COMMIT_DELAY_MS - 1)
    expect(onCommit).not.toHaveBeenCalled()
    advance(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-4.1)
    advance(STEP_COMMIT_DELAY_MS * 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('restarts the idle wait on every key, so a run of steps is one commit', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    for (let i = 0; i < 4; i++)
    {
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      advance(STEP_COMMIT_DELAY_MS - 100)
    }
    expect(onCommit).not.toHaveBeenCalled()
    advance(100)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-4.6)
  })

  it('uses bigStep for PageUp and PageDown, and ten steps without it', () =>
  {
    render(<Field bigStep={2} />)
    const input = field()
    expect(fireEvent.keyDown(input, { key: 'PageUp' })).toBe(false)
    expect(input.value).toBe(`${MINUS}3.0`)
    fireEvent.keyDown(input, { key: 'PageDown' })
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(input.value).toBe(`${MINUS}7.0`)
    cleanup()
    render(<Field />)
    fireEvent.keyDown(field(), { key: 'PageDown' })
    expect(field().value).toBe(`${MINUS}6.0`)
  })

  it('clamps steps at the limits and commits nothing when they end where they began', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field initial={-1} onCommit={onCommit} />)
    const input = field()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe(`${MINUS}1.0`)
    advance(STEP_COMMIT_DELAY_MS)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    advance(STEP_COMMIT_DELAY_MS)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('leaves Home and End to text editing: not consumed, nothing committed, the value unchanged', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(true)
    advance(STEP_COMMIT_DELAY_MS * 2)
    blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-valuenow', '-5')
    expect(input.value).toBe(`${MINUS}5.0`)
  })

  it('leaves arrows with Alt, Ctrl, or Meta to the view', () =>
  {
    render(<Field />)
    const input = field()
    expect(fireEvent.keyDown(input, { key: 'ArrowUp', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'ArrowDown', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'PageUp', metaKey: true })).toBe(true)
    expect(input.value).toBe(`${MINUS}5.0`)
  })

  it('refuses "abc" on blur: aria-invalid, the range message, and no commit', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(
      <LiveRegion>
        <Field onCommit={onCommit} />
      </LiveRegion>
    )
    const input = field()
    focus(input)
    type(input, 'abc')
    blur(input)
    const message = `Enter a number from ${MINUS}9 to ${MINUS}1.`
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(message)).toBeVisible()
    expect(input).toHaveAccessibleDescription(message)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe('abc')
    advance(20)
    expect(screen.getByRole('status')).toHaveTextContent(message)
  })

  it('reverts the draft on Escape and calls preventDefault, and leaves a clean Escape alone', () =>
  {
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true)
    type(input, '-3')
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(input.value).toBe(`${MINUS}5.0`)
    blur(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reverts a pending step and a shown error on Escape', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(input.value).toBe(`${MINUS}5.0`)
    advance(STEP_COMMIT_DELAY_MS)
    expect(onCommit).not.toHaveBeenCalled()
    type(input, '1..2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input.value).toBe(`${MINUS}5.0`)
  })

  it('never commits an empty field as 0, and refuses a lone sign or point', () =>
  {
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    type(input, '')
    blur(input)
    expect(onCommit).not.toHaveBeenCalled()
    expect(input.value).toBe(`${MINUS}5.0`)
    expect(input).not.toHaveAttribute('aria-invalid')
    for (const partial of ['-', MINUS, '.'])
    {
      focus(input)
      type(input, partial)
      blur(input)
      expect(onCommit).not.toHaveBeenCalled()
      expect(input).toHaveAttribute('aria-invalid', 'true')
    }
  })

  it('refuses digits too long to read as a finite number', () =>
  {
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    type(input, '9'.repeat(400))
    blur(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reads both "−5" and "-5" as minus five, and a typed unit as part of the number', () =>
  {
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    type(input, `${MINUS}2`)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(onCommit).toHaveBeenLastCalledWith(-2)
    type(input, '-3')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(-3)
    type(input, ' -4.5 dbtp ')
    blur(input)
    expect(onCommit).toHaveBeenLastCalledWith(-4.5)
    expect(input.value).toBe(`${MINUS}4.5`)
    expect(onCommit).toHaveBeenCalledTimes(3)
  })

  it('commits an out-of-range entry clamped and shows and announces the note', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(
      <LiveRegion>
        <Field onCommit={onCommit} />
      </LiveRegion>
    )
    const input = field()
    focus(input)
    type(input, '0')
    fireEvent.keyDown(input, { key: 'Enter' })
    const note = `Set to ${MINUS}1.0, the maximum.`
    expect(onCommit).toHaveBeenCalledWith(-1)
    expect(screen.getByText(note)).toBeVisible()
    expect(input).toHaveAccessibleDescription(note)
    expect(input).not.toHaveAttribute('aria-invalid')
    advance(20)
    expect(screen.getByRole('status')).toHaveTextContent(note)
    type(input, '-20')
    expect(document.querySelector('[data-tone]')).toBeNull()
    expect(input).toHaveAccessibleDescription('')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith(-9)
    expect(screen.getByText(`Set to ${MINUS}9.0, the minimum.`)).toBeVisible()
  })

  it('shows the clamp note only while the value it explains is shown', () =>
  {
    const onCommit = vi.fn()
    const { rerender } = render(<NumberField label="Ceiling" value={-5} step={0.1} min={-9} max={-1} onCommit={onCommit} />)
    const input = field('Ceiling')
    focus(input)
    type(input, '3')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(-1)
    expect(screen.queryByText(`Set to ${MINUS}1.0, the maximum.`)).toBeNull()
    rerender(<NumberField label="Ceiling" value={-1} step={0.1} min={-9} max={-1} onCommit={onCommit} />)
    expect(screen.getByText(`Set to ${MINUS}1.0, the maximum.`)).toBeVisible()
  })

  it('renders a null value as "Mixed": no aria-valuenow, the Mixed value text and placeholder', () =>
  {
    const onCommit = vi.fn()
    render(<Field initial={null} onCommit={onCommit} />)
    const input = field()
    expect(input).not.toHaveAttribute('aria-valuenow')
    expect(input).toHaveAttribute('aria-valuetext', MIXED_LABEL)
    expect(input).toHaveAttribute('placeholder', 'Mixed')
    expect(input.value).toBe('')
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(true)
    expect(input.value).toBe('')
    focus(input)
    type(input, '-2')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(-2)
    expect(input).toHaveAttribute('aria-valuenow', '-2')
    expect(input).not.toHaveAttribute('placeholder')
  })

  it('reads a custom nullLabel', () =>
  {
    render(<Field initial={null} nullLabel="Several values" />)
    expect(field()).toHaveAttribute('aria-valuetext', 'Several values')
    expect(field()).toHaveAttribute('placeholder', 'Several values')
  })

  it('commitDraft sends a valid draft and resolves committed', async () =>
  {
    const ref = createRef<NumberFieldHandle>()
    const onCommit = vi.fn()
    render(<Field ref={ref} onCommit={onCommit} />)
    const input = field()
    focus(input)
    type(input, '-2.5')
    expect(await commitDraft(ref)).toBe('committed')
    expect(onCommit).toHaveBeenCalledWith(-2.5)
    expect(document.activeElement).toBe(input)
    blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commitDraft flushes a pending key step at once', async () =>
  {
    vi.useFakeTimers()
    const ref = createRef<NumberFieldHandle>()
    const onCommit = vi.fn()
    render(<Field ref={ref} onCommit={onCommit} />)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(await commitDraft(ref)).toBe('committed')
    expect(onCommit).toHaveBeenCalledWith(-5.1)
    advance(STEP_COMMIT_DELAY_MS * 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commitDraft refuses an invalid draft with invalid and moves focus back to the field', async () =>
  {
    const ref = createRef<NumberFieldHandle>()
    const onCommit = vi.fn()
    render(
      <>
        <Field ref={ref} onCommit={onCommit} />
        <button type="button">Start</button>
      </>
    )
    const input = field()
    focus(input)
    type(input, '12abc')
    act(() =>
    {
      screen.getByRole('button', { name: 'Start' }).focus()
    })
    expect(document.activeElement).not.toBe(input)
    expect(await commitDraft(ref)).toBe('invalid')
    expect(document.activeElement).toBe(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commitDraft keeps focus on a focused field with an invalid draft', async () =>
  {
    const ref = createRef<NumberFieldHandle>()
    render(<Field ref={ref} />)
    const input = field()
    focus(input)
    type(input, 'x')
    expect(await commitDraft(ref)).toBe('invalid')
    expect(document.activeElement).toBe(input)
  })

  it('commitDraft resolves unchanged with nothing to send, or a draft equal to the value', async () =>
  {
    const ref = createRef<NumberFieldHandle>()
    const onCommit = vi.fn()
    render(<Field ref={ref} onCommit={onCommit} />)
    expect(await commitDraft(ref)).toBe('unchanged')
    const input = field()
    focus(input)
    type(input, '-5.0')
    expect(await commitDraft(ref)).toBe('unchanged')
    type(input, '   ')
    expect(await commitDraft(ref)).toBe('unchanged')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commitDraft waits for a returned promise and keeps the committed value shown until it settles', async () =>
  {
    const ref = createRef<NumberFieldHandle>()
    let resolve: () => void = () => {}
    const onCommit = vi.fn(() => new Promise<void>((done) =>
    {
      resolve = done
    }))
    render(<NumberField ref={ref} label="Gain" value={2} step={0.5} unit="dB" onCommit={onCommit} />)
    const input = field('Gain')
    focus(input)
    type(input, '3')
    let result: CommitDraftResult | undefined
    let pending: Promise<CommitDraftResult> = Promise.resolve('unchanged')
    act(() =>
    {
      pending = (ref.current as NumberFieldHandle).commitDraft()
    })
    expect(input.value).toBe('3.0')
    expect(input).toHaveAttribute('aria-valuetext', '3.0 dB')
    await act(async () =>
    {
      resolve()
      result = await pending
    })
    expect(result).toBe('committed')
    expect(input.value).toBe('2.0')
  })

  it('drops the shown commit once the value prop moves, and ignores a superseded promise', async () =>
  {
    const settles: Array<() => void> = []
    const onCommit = vi.fn(() => new Promise<void>((done) =>
    {
      settles.push(done)
    }))
    const { rerender } = render(<NumberField label="Gain" value={2} step={0.5} onCommit={onCommit} />)
    const input = field('Gain')
    focus(input)
    type(input, '3')
    fireEvent.keyDown(input, { key: 'Enter' })
    type(input, '4')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input.value).toBe('4.0')
    await act(async () =>
    {
      settles[0]()
      await Promise.resolve()
    })
    expect(input.value).toBe('4.0')
    rerender(<NumberField label="Gain" value={4} step={0.5} onCommit={onCommit} />)
    expect(input.value).toBe('4.0')
    rerender(<NumberField label="Gain" value={6} step={0.5} onCommit={onCommit} />)
    expect(input.value).toBe('6.0')
    await act(async () =>
    {
      settles[1]()
      await Promise.resolve()
    })
    expect(input.value).toBe('6.0')
  })

  it('clears the shown commit when the promise rejects', async () =>
  {
    let reject: (reason: Error) => void = () => {}
    const onCommit = vi.fn(() => new Promise<void>((_, fail) =>
    {
      reject = fail
    }))
    render(<NumberField label="Gain" value={2} step={0.5} onCommit={onCommit} />)
    const input = field('Gain')
    focus(input)
    type(input, '5')
    blur(input)
    expect(input.value).toBe('5.0')
    await act(async () =>
    {
      reject(new Error('main refused'))
      await Promise.resolve()
    })
    expect(input.value).toBe('2.0')
  })

  it('steps from a typed draft, or from the value when the draft is unreadable', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    type(input, '-3')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe(`${MINUS}2.9`)
    advance(STEP_COMMIT_DELAY_MS)
    expect(onCommit).toHaveBeenLastCalledWith(-2.9)
    type(input, 'abc')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe(`${MINUS}3.0`)
  })

  it('drops a pending step once typing starts', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    type(input, '-7')
    advance(STEP_COMMIT_DELAY_MS * 2)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-7)
  })

  it('leaves Enter to the view when clean, and Shift, Ctrl, or Alt with Enter always', () =>
  {
    const onCommit = vi.fn()
    render(<Field onCommit={onCommit} />)
    const input = field()
    focus(input)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
    type(input, '-3')
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'Enter', altKey: true })).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('keeps a focused draft through an outside value change and clears a stale error after blur', () =>
  {
    const { rerender } = render(<NumberField label="Ceiling" value={-5} step={0.1} onCommit={() => {}} />)
    const input = field('Ceiling')
    focus(input)
    type(input, '-3')
    rerender(<NumberField label="Ceiling" value={-4} step={0.1} onCommit={() => {}} />)
    expect(input.value).toBe('-3')
    type(input, 'oops')
    blur(input)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    rerender(<NumberField label="Ceiling" value={-6} step={0.1} onCommit={() => {}} />)
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input.value).toBe(`${MINUS}6.0`)
  })

  it('commits a pending step or a valid draft when it unmounts, silently and never an unreadable one', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    const first = render(<Field onCommit={onCommit} />)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    first.unmount()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-4.9)

    const second = render(<Field onCommit={onCommit} />)
    type(field(), '-8')
    second.unmount()
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenLastCalledWith(-8)

    const third = render(<Field onCommit={onCommit} />)
    type(field(), 'nope')
    third.unmount()
    const fourth = render(<Field onCommit={onCommit} />)
    fourth.unmount()
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('states the range message for one limit or none', () =>
  {
    render(
      <>
        <NumberField label="Width" value={480} step={1} min={16} onCommit={() => {}} />
        <NumberField label="Quality" value={80} step={1} max={100} onCommit={() => {}} />
        <NumberField label="Offset" value={0} step={1} onCommit={() => {}} />
      </>
    )
    for (const name of ['Width', 'Quality', 'Offset'])
    {
      const input = field(name)
      focus(input)
      type(input, '?')
      blur(input)
    }
    expect(screen.getByText('Enter a number of 16 or more.')).toBeVisible()
    expect(screen.getByText('Enter a number of 100 or less.')).toBeVisible()
    expect(screen.getByText('Enter a number.')).toBeVisible()
  })

  it('speaks a plain number without a unit, honors decimals and valueText, and prints zero without a sign', () =>
  {
    render(
      <>
        <NumberField label="Count" value={12} step={1} onCommit={() => {}} />
        <NumberField label="Ratio" value={1.5} step={0.5} decimals={2} onCommit={() => {}} />
        <NumberField label="Workers" value={8} step={1} valueText={(v) => `${v} workers`} onCommit={() => {}} />
        <NumberField label="Gain" value={-0.04} step={0.1} unit="dB" onCommit={() => {}} />
        <NumberField label="Tolerance" value={0.5} step={1e-7} onCommit={() => {}} />
      </>
    )
    expect(field('Count')).toHaveAttribute('aria-valuetext', '12')
    expect(field('Ratio').value).toBe('1.50')
    expect(field('Workers')).toHaveAttribute('aria-valuetext', '8 workers')
    expect(field('Gain').value).toBe('0.0')
    expect(field('Gain')).toHaveAttribute('aria-valuetext', '0.0 dB')
    expect(field('Tolerance').value).toBe('0.5000000')
  })

  it('carries error, describedBy, size, disabled, id, labelledBy, and className', () =>
  {
    const { container } = render(
      <>
        <span id="peak-caption">Peak ceiling</span>
        <span id="peak-hint">Mixed</span>
        <NumberField
          id="peak"
          labelledBy="peak-caption"
          describedBy="peak-hint"
          value={null}
          step={0.1}
          unit="dBTP"
          size="sm"
          error={`Enter a number from ${MINUS}9 to ${MINUS}1.`}
          className="w-28"
          onCommit={() => {}}
        />
        <NumberField label="Locked" value={-2} step={0.1} unit="dBTP" disabled onCommit={() => {}} />
      </>
    )
    const input = field('Peak ceiling')
    expect(input).toHaveAttribute('id', 'peak')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('data-size', 'sm')
    expect(input).toHaveAccessibleDescription(`Mixed Enter a number from ${MINUS}9 to ${MINUS}1.`)
    expect(container.querySelector('.w-28')).toContainElement(input)
    const locked = field('Locked')
    expect(locked).toBeDisabled()
    expect(locked.parentElement?.querySelector('[aria-hidden="true"]')).toHaveClass('text-ink-disabled')
  })

  it('forwards focus and the input through its handle', () =>
  {
    const ref = createRef<NumberFieldHandle>()
    render(<Field ref={ref} />)
    act(() =>
    {
      ref.current?.focus()
    })
    expect(document.activeElement).toBe(field())
    expect(ref.current?.input).toBe(field())
  })
})

describe('FieldMessage', () =>
{
  afterEach(() =>
  {
    cleanup()
  })

  it('draws the error glyph for errors and none for notes, and stays bounded unless told otherwise', () =>
  {
    render(
      <>
        <FieldMessage id="error">Enter a number.</FieldMessage>
        <FieldMessage id="note" tone="note">Set to 5, the maximum.</FieldMessage>
        <FieldMessage id="free" bounded={false}>Not available with GPU encoding.</FieldMessage>
      </>
    )
    const error = document.getElementById('error') as HTMLElement
    const note = document.getElementById('note') as HTMLElement
    const free = document.getElementById('free') as HTMLElement
    expect(error.querySelector('[data-icon="status.failed"]')).not.toBeNull()
    expect(error).toHaveClass('text-error', 'w-0', 'min-w-full')
    expect(note.querySelector('svg')).toBeNull()
    expect(note).toHaveClass('text-ink-2')
    expect(free).not.toHaveClass('w-0')
  })
})
