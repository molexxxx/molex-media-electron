/**
 * RangeField: a caption, a slider, and a number field sharing one value, so one gesture is one commit.
 * Covers the shared value, the field's distinct name, the caption's hint on both controls, the mixed state
 * on both, one commit per drag on release, one commit per run of key steps after 500 ms of idle (or on
 * blur and unmount), commitDraft flushing a pending commit, promises from onCommit, and the error state.
 */
import React, { createRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { RangeField, EXACT_VALUE_LABEL, type RangeFieldHandle, type RangeFieldProps } from '../../../src/renderer/src/ui/RangeField'
import { STEP_COMMIT_DELAY_MS } from '../../../src/renderer/src/ui/NumberField'

const MINUS = '−'

function lufs(value: number): string
{
  return `${value.toFixed(1).replace('-', MINUS)} LUFS`
}

type TargetProps = Partial<RangeFieldProps> & { initial?: number | null, follow?: boolean }

/** The inspector's Integrated target: the value follows each commit unless `follow` is false. */
function Target({ initial = -16, follow = true, onCommit, ...rest }: TargetProps): ReactElement
{
  const [value, setValue] = useState<number | null>(initial)
  return (
    <RangeField
      label="Integrated target"
      hint={`From ${MINUS}30 to ${MINUS}5 LUFS`}
      value={value}
      min={-30}
      max={-5}
      step={0.5}
      unit="LUFS"
      valueText={lufs}
      {...rest}
      onCommit={(next) =>
      {
        const outcome = onCommit?.(next)
        if (follow)
        {
          setValue(next)
        }
        return outcome
      }}
    />
  )
}

function slider(): HTMLInputElement
{
  return screen.getByRole('slider', { name: 'Integrated target' }) as HTMLInputElement
}

function field(): HTMLInputElement
{
  return screen.getByRole('spinbutton', { name: `Integrated target ${EXACT_VALUE_LABEL}` }) as HTMLInputElement
}

/** A native range key step as jsdom cannot run it: the key, then the input and change events it fires. */
function keyStep(value: number, key = 'ArrowRight'): void
{
  fireEvent.keyDown(slider(), { key })
  fireEvent.input(slider(), { target: { value: String(value) } })
  fireEvent.change(slider(), { target: { value: String(value) } })
}

function drag(values: number[]): void
{
  fireEvent.pointerDown(slider())
  for (const value of values)
  {
    fireEvent.input(slider(), { target: { value: String(value) } })
  }
  fireEvent.change(slider(), { target: { value: String(values[values.length - 1]) } })
}

function advance(ms: number): void
{
  act(() =>
  {
    vi.advanceTimersByTime(ms)
  })
}

describe('RangeField', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.useRealTimers()
  })

  it('shares one value between the slider and the field', () =>
  {
    render(<Target />)
    expect(slider().value).toBe('-16')
    expect(slider()).toHaveAttribute('aria-valuetext', `${MINUS}16.0 LUFS`)
    expect(field().value).toBe(`${MINUS}16.0`)
    expect(field()).toHaveAttribute('aria-valuenow', '-16')
    expect(field()).toHaveAttribute('aria-valuetext', `${MINUS}16.0 LUFS`)
  })

  it('names the slider by the caption and the field apart from it', () =>
  {
    render(<Target />)
    expect(slider()).toHaveAccessibleName('Integrated target')
    expect(field()).toHaveAccessibleName('Integrated target exact value')
    expect(screen.getAllByLabelText('Integrated target')).toContain(slider())
    expect(screen.getByLabelText('Integrated target exact value')).toBe(field())
    expect(screen.queryByRole('spinbutton', { name: 'Integrated target' })).toBeNull()
  })

  it('describes both controls with the caption hint', () =>
  {
    render(<Target describedBy="spread" />)
    const hint = screen.getByText(`From ${MINUS}30 to ${MINUS}5 LUFS`)
    for (const control of [slider(), field()])
    {
      const described = (control.getAttribute('aria-describedby') ?? '').split(' ')
      expect(described).toContain(hint.id)
      expect(described).toContain('spread')
    }
  })

  it('omits the description without a hint', () =>
  {
    render(<Target hint={undefined} />)
    expect(slider()).not.toHaveAttribute('aria-describedby')
    expect(field()).not.toHaveAttribute('aria-describedby')
  })

  it('with a null value reads Mixed on both, with a hollow thumb at the midpoint', () =>
  {
    render(<Target initial={null} />)
    expect(slider()).toHaveAttribute('aria-valuetext', 'Mixed')
    expect(slider()).toHaveAttribute('data-mixed')
    expect(slider().value).toBe('-17.5')
    expect(field()).toHaveAttribute('aria-valuetext', 'Mixed')
    expect(field()).not.toHaveAttribute('aria-valuenow')
    expect(field()).toHaveAttribute('placeholder', 'Mixed')
    expect(field().value).toBe('')
  })

  it('rests a mixed thumb at the value the page gives', () =>
  {
    render(<Target initial={null} mixedValue={-23} />)
    expect(slider().value).toBe('-23')
    expect(slider()).toHaveAttribute('aria-valuetext', 'Mixed')
  })

  it('commits a drag once on pointer release while the field follows live', () =>
  {
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} />)
    fireEvent.pointerDown(slider())
    fireEvent.input(slider(), { target: { value: '-15' } })
    expect(field().value).toBe(`${MINUS}15.0`)
    fireEvent.input(slider(), { target: { value: '-13.5' } })
    fireEvent.input(slider(), { target: { value: '-12' } })
    expect(field().value).toBe(`${MINUS}12.0`)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.change(slider(), { target: { value: '-12' } })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-12)
    expect(slider().value).toBe('-12')
    expect(field().value).toBe(`${MINUS}12.0`)
  })

  it('sets every job from the mixed state with a drag', () =>
  {
    const onCommit = vi.fn()
    render(<Target initial={null} onCommit={onCommit} />)
    fireEvent.pointerDown(slider())
    fireEvent.input(slider(), { target: { value: '-20' } })
    expect(slider()).not.toHaveAttribute('data-mixed')
    expect(field().value).toBe(`${MINUS}20.0`)
    fireEvent.change(slider(), { target: { value: '-20' } })
    expect(onCommit).toHaveBeenCalledWith(-20)
    expect(slider()).toHaveAttribute('aria-valuetext', `${MINUS}20.0 LUFS`)
    expect(field()).toHaveAttribute('aria-valuetext', `${MINUS}20.0 LUFS`)
  })

  it('commits nothing when a drag ends where it started', () =>
  {
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} />)
    drag([-14, -16])
    expect(onCommit).not.toHaveBeenCalled()
    expect(field().value).toBe(`${MINUS}16.0`)
  })

  it('commits a run of slider key steps once, 500 ms after the last key', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} />)
    keyStep(-15.5)
    advance(300)
    keyStep(-15)
    advance(300)
    keyStep(-14.5)
    expect(field().value).toBe(`${MINUS}14.5`)
    expect(onCommit).not.toHaveBeenCalled()
    advance(STEP_COMMIT_DELAY_MS - 1)
    expect(onCommit).not.toHaveBeenCalled()
    advance(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-14.5)
    advance(STEP_COMMIT_DELAY_MS * 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending key step through commitDraft and resolves committed', async () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    const ref = createRef<RangeFieldHandle>()
    render(<Target ref={ref} onCommit={onCommit} />)
    keyStep(-15.5)
    keyStep(-15)
    let result: string | undefined
    await act(async () =>
    {
      result = await ref.current?.commitDraft()
    })
    expect(result).toBe('committed')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-15)
    advance(STEP_COMMIT_DELAY_MS * 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('resolves commitDraft as unchanged with nothing pending, and sends a typed draft', async () =>
  {
    const onCommit = vi.fn()
    const ref = createRef<RangeFieldHandle>()
    render(<Target ref={ref} onCommit={onCommit} />)
    let result: string | undefined
    await act(async () =>
    {
      result = await ref.current?.commitDraft()
    })
    expect(result).toBe('unchanged')
    fireEvent.focus(field())
    fireEvent.change(field(), { target: { value: '-18' } })
    await act(async () =>
    {
      result = await ref.current?.commitDraft()
    })
    expect(result).toBe('committed')
    expect(onCommit).toHaveBeenCalledWith(-18)
    expect(slider().value).toBe('-18')
  })

  it('refuses commitDraft with an unreadable draft and keeps focus on the field', async () =>
  {
    const onCommit = vi.fn()
    const ref = createRef<RangeFieldHandle>()
    render(<Target ref={ref} onCommit={onCommit} />)
    fireEvent.focus(field())
    fireEvent.change(field(), { target: { value: 'abc' } })
    let result: string | undefined
    await act(async () =>
    {
      result = await ref.current?.commitDraft()
    })
    expect(result).toBe('invalid')
    expect(onCommit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field())
    expect(field()).toHaveAttribute('aria-invalid', 'true')
  })

  it('commits typed numbers on Enter, and the slider follows', () =>
  {
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} />)
    fireEvent.focus(field())
    fireEvent.change(field(), { target: { value: '-23' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-23)
    expect(slider().value).toBe('-23')
  })

  it('commits a pending key step at once when the slider loses focus', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} />)
    keyStep(-15.5)
    fireEvent.blur(slider())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-15.5)
    advance(STEP_COMMIT_DELAY_MS)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits a pending key step when it unmounts', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    const { unmount } = render(<Target onCommit={onCommit} />)
    keyStep(-15.5)
    unmount()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-15.5)
  })

  it('snaps back when the page refuses a commit', () =>
  {
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} follow={false} />)
    drag([-12])
    expect(onCommit).toHaveBeenCalledWith(-12)
    expect(slider().value).toBe('-16')
    expect(field().value).toBe(`${MINUS}16.0`)
  })

  it('keeps a sent value shown until the promise from onCommit settles', async () =>
  {
    let settle: (() => void) | undefined
    const onCommit = vi.fn(() => new Promise<void>((resolve) =>
    {
      settle = resolve
    }))
    render(<Target onCommit={onCommit} follow={false} />)
    drag([-12])
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(slider().value).toBe('-12')
    expect(field().value).toBe(`${MINUS}12.0`)
    await act(async () =>
    {
      settle?.()
    })
    expect(slider().value).toBe('-16')
  })

  it('retires the sent value as soon as the page applies a commit that is still settling', async () =>
  {
    let settle: (() => void) | undefined
    const onCommit = vi.fn(() => new Promise<void>((resolve) =>
    {
      settle = resolve
    }))
    render(<Target onCommit={onCommit} />)
    drag([-12])
    expect(slider().value).toBe('-12')
    expect(field()).toHaveAttribute('aria-valuenow', '-12')
    fireEvent.pointerDown(slider())
    fireEvent.input(slider(), { target: { value: '-11' } })
    await act(async () =>
    {
      settle?.()
    })
    expect(slider().value).toBe('-11')
  })

  it('keeps a new gesture live when an older commit settles', async () =>
  {
    let settle: (() => void) | undefined
    const onCommit = vi.fn(() => new Promise<void>((resolve) =>
    {
      settle = resolve
    }))
    render(<Target onCommit={onCommit} follow={false} />)
    drag([-12])
    fireEvent.pointerDown(slider())
    fireEvent.input(slider(), { target: { value: '-10' } })
    await act(async () =>
    {
      settle?.()
    })
    expect(slider().value).toBe('-10')
    expect(field().value).toBe(`${MINUS}10.0`)
  })

  it('awaits the promise of a flushed key step in commitDraft', async () =>
  {
    vi.useFakeTimers()
    let settle: (() => void) | undefined
    const onCommit = vi.fn(() => new Promise<void>((resolve) =>
    {
      settle = resolve
    }))
    const ref = createRef<RangeFieldHandle>()
    render(<Target ref={ref} onCommit={onCommit} follow={false} />)
    keyStep(-15.5)
    let result: string | undefined
    let pending: Promise<void> | undefined
    act(() =>
    {
      pending = ref.current?.commitDraft().then((value) =>
      {
        result = value
      })
    })
    await act(async () =>
    {
      await Promise.resolve()
    })
    expect(result).toBeUndefined()
    await act(async () =>
    {
      settle?.()
      await pending
    })
    expect(result).toBe('committed')
  })

  it('focuses the slider through the handle', () =>
  {
    const ref = createRef<RangeFieldHandle>()
    render(<Target ref={ref} />)
    act(() =>
    {
      ref.current?.focus()
    })
    expect(document.activeElement).toBe(slider())
  })

  it('marks both controls invalid with one visible message', () =>
  {
    const { container } = render(<Target error="Out of reach for 3 jobs." />)
    expect(slider()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(slider()).toHaveAccessibleDescription(expect.stringContaining('Out of reach for 3 jobs.'))
    expect(field()).toHaveAccessibleDescription(expect.stringContaining('Out of reach for 3 jobs.'))
    const messages = screen.getAllByText('Out of reach for 3 jobs.')
    expect(messages).toHaveLength(2)
    const fieldBox = field().closest('.shrink-0') as HTMLElement
    expect(fieldBox).toHaveClass('[&>[data-tone]]:hidden')
    expect(container.querySelector('.ui-slider')?.parentElement).toContainElement(messages[0])
  })

  it('disables both controls, takes sizes, ids, and classes', () =>
  {
    const { container } = render(<Target disabled size="sm" id="target" className="w-80" />)
    expect(slider()).toBeDisabled()
    expect(field()).toBeDisabled()
    expect(slider()).toHaveAttribute('id', 'target')
    expect(field()).toHaveAttribute('data-size', 'sm')
    expect(container.firstElementChild).toHaveClass('w-80')
    expect(slider().closest('.pt-0\\.5')).not.toBeNull()
    expect(container.querySelector('label')).toHaveAttribute('for', 'target')
  })

  it('passes bigStep to the slider page keys and commits them like steps', () =>
  {
    vi.useFakeTimers()
    const onCommit = vi.fn()
    render(<Target onCommit={onCommit} bigStep={5} />)
    fireEvent.keyDown(slider(), { key: 'PageUp' })
    expect(slider().value).toBe('-11')
    expect(field().value).toBe(`${MINUS}11.0`)
    advance(STEP_COMMIT_DELAY_MS)
    expect(onCommit).toHaveBeenCalledWith(-11)
  })
})
