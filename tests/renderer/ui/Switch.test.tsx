/**
 * Switch: a button with switch semantics whose 32 by 24 px box is the target. Covers the toggle, naming
 * through a label, the busy spell (visible word, description, aria-disabled, ignored clicks), the outcome
 * spoken through the view's LiveRegion, and the disabled state.
 */
import React, { createRef, useState, type ReactElement } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Switch, SWITCH_BUSY_LABEL, type SwitchProps } from '../../../src/renderer/src/ui/Switch'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'

/** A settings row whose label names the switch and is a second target. */
function Row({ name = 'Hardware encoding', ...rest }: Partial<SwitchProps> & { name?: string }): ReactElement
{
  const [checked, setChecked] = useState(false)
  return (
    <>
      <label htmlFor="setting">{name}</label>
      <Switch id="setting" checked={checked} onChange={setChecked} {...rest} />
    </>
  )
}

/** A setting that applies through an async call: busy until the test settles it, applied or refused. */
function AsyncRow({ name, labelProps }: { name: string, labelProps?: Partial<SwitchProps> }): ReactElement
{
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [requested, setRequested] = useState<boolean | null>(null)
  return (
    <>
      {!labelProps && <label htmlFor="async-setting">{name}</label>}
      <Switch
        id="async-setting"
        checked={checked}
        busy={busy}
        onChange={(next) =>
        {
          setBusy(true)
          setRequested(next)
        }}
        {...labelProps}
      />
      <button
        type="button"
        onClick={() =>
        {
          setChecked(Boolean(requested))
          setBusy(false)
        }}
      >
        Apply
      </button>
      <button type="button" onClick={() => setBusy(false)}>Refuse</button>
    </>
  )
}

function region(): HTMLElement
{
  return screen.getByRole('status')
}

function nextFrame(): void
{
  act(() =>
  {
    vi.advanceTimersByTime(20)
  })
}

describe('Switch', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.useRealTimers()
  })

  it('has the switch role and toggles aria-checked on click', () =>
  {
    render(<Row />)
    const control = screen.getByRole('switch')
    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('type', 'button')
    expect(control).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(control)
    expect(control).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(control)
    expect(control).toHaveAttribute('aria-checked', 'false')
  })

  it('is named by its label, and clicking the label toggles it', () =>
  {
    render(<Row />)
    const control = screen.getByRole('switch', { name: 'Hardware encoding' })
    fireEvent.click(screen.getByText('Hardware encoding'))
    expect(control).toHaveAttribute('aria-checked', 'true')
  })

  it('takes its name from label or labelledBy', () =>
  {
    render(
      <>
        <Switch label="Keep the computer awake" checked onChange={() => {}} />
        <span id="sound-caption">Play a sound when a batch finishes</span>
        <Switch labelledBy="sound-caption" checked={false} onChange={() => {}} />
      </>
    )
    expect(screen.getByRole('switch', { name: 'Keep the computer awake' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Play a sound when a batch finishes' })).not.toBeChecked()
  })

  it('draws the track and knob inside the 32 by 24 px button', () =>
  {
    render(<Row />)
    const control = screen.getByRole('switch')
    expect(control).toHaveClass('ui-switch')
    expect(control.querySelector('.ui-switch-track > .ui-switch-knob')).not.toBeNull()
  })

  it('while busy shows the visible word, describes the switch with it, sets aria-disabled, and ignores clicks', () =>
  {
    const onChange = vi.fn()
    render(
      <>
        <span id="hw-hint">Uses the GPU when one is found</span>
        <Switch id="hw" label="Hardware encoding" checked={false} busy describedBy="hw-hint" onChange={onChange} />
      </>
    )
    const control = screen.getByRole('switch', { name: 'Hardware encoding' })
    expect(screen.getByText(SWITCH_BUSY_LABEL)).toBeVisible()
    expect(SWITCH_BUSY_LABEL).toBe('Applying')
    expect(control).toHaveAttribute('aria-disabled', 'true')
    expect(control).not.toBeDisabled()
    expect(control).toHaveAccessibleDescription('Uses the GPU when one is found Applying')
    expect(document.querySelector('[data-icon="status.active"]')).not.toBeNull()
    expect(fireEvent.click(control)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    act(() =>
    {
      control.focus()
    })
    expect(document.activeElement).toBe(control)
  })

  it('takes a custom busy word and drops the busy state once it ends', () =>
  {
    const { rerender } = render(<Switch label="Tray icon" checked busy busyLabel="Saving" onChange={() => {}} />)
    expect(screen.getByText('Saving')).toBeVisible()
    rerender(<Switch label="Tray icon" checked onChange={() => {}} />)
    const control = screen.getByRole('switch', { name: 'Tray icon' })
    expect(screen.queryByText('Saving')).toBeNull()
    expect(control).not.toHaveAttribute('aria-disabled')
    expect(control).not.toHaveAttribute('aria-describedby')
  })

  it('speaks the applied outcome through the view\'s LiveRegion', () =>
  {
    vi.useFakeTimers()
    render(
      <LiveRegion>
        <AsyncRow name="Hardware encoding" />
      </LiveRegion>
    )
    const control = screen.getByRole('switch', { name: 'Hardware encoding' })
    fireEvent.click(control)
    expect(control).toHaveAttribute('aria-disabled', 'true')
    nextFrame()
    expect(region()).toHaveTextContent('')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    nextFrame()
    expect(control).toHaveAttribute('aria-checked', 'true')
    expect(region()).toHaveTextContent('Hardware encoding on')
  })

  it('speaks "Could not apply" when the state did not change, keeping an acronym\'s capitals', () =>
  {
    vi.useFakeTimers()
    render(
      <LiveRegion>
        <AsyncRow name="Hardware encoding" />
      </LiveRegion>
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Hardware encoding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }))
    nextFrame()
    expect(region()).toHaveTextContent('Could not apply hardware encoding')
    cleanup()
    render(
      <LiveRegion>
        <AsyncRow name="GPU encoding" />
      </LiveRegion>
    )
    fireEvent.click(screen.getByRole('switch', { name: 'GPU encoding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }))
    vi.advanceTimersByTime(1000)
    nextFrame()
    expect(region()).toHaveTextContent('Could not apply GPU encoding')
  })

  it('reads the name for the outcome from label and labelledBy too', () =>
  {
    vi.useFakeTimers()
    render(
      <LiveRegion>
        <AsyncRow name="unused" labelProps={{ label: 'Tray icon' }} />
      </LiveRegion>
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Tray icon' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    nextFrame()
    expect(region()).toHaveTextContent('Tray icon on')
    cleanup()
    render(
      <LiveRegion>
        <span id="awake-caption">Keep awake</span>
        <AsyncRow name="unused" labelProps={{ labelledBy: 'awake-caption missing-id' }} />
      </LiveRegion>
    )
    const control = screen.getByRole('switch', { name: 'Keep awake' })
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    vi.advanceTimersByTime(1000)
    nextFrame()
    expect(region()).toHaveTextContent('Keep awake on')
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    vi.advanceTimersByTime(1000)
    nextFrame()
    expect(region()).toHaveTextContent('Keep awake off')
  })

  it('says nothing for a setting that applied at once, or for a busy spell it did not start', () =>
  {
    vi.useFakeTimers()
    const { rerender } = render(
      <LiveRegion>
        <Row />
      </LiveRegion>
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Hardware encoding' }))
    nextFrame()
    expect(region()).toHaveTextContent('')
    rerender(
      <LiveRegion>
        <Row busy />
      </LiveRegion>
    )
    rerender(
      <LiveRegion>
        <Row />
      </LiveRegion>
    )
    nextFrame()
    expect(region()).toHaveTextContent('')
  })

  it('is disabled natively and ignores clicks', () =>
  {
    const onChange = vi.fn()
    render(<Switch label="Hardware encoding" checked={false} disabled onChange={onChange} />)
    const control = screen.getByRole('switch', { name: 'Hardware encoding' })
    expect(control).toBeDisabled()
    fireEvent.click(control)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts className on the outer box and forwards the ref to the button', () =>
  {
    const ref = createRef<HTMLButtonElement>()
    render(<Switch ref={ref} label="Hardware encoding" checked={false} className="ms-auto" onChange={() => {}} />)
    const control = screen.getByRole('switch')
    expect(ref.current).toBe(control)
    expect(control.parentElement).toHaveClass('ms-auto')
  })
})
