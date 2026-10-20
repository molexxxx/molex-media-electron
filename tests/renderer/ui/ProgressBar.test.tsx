/**
 * ProgressBar: a named progressbar with its value from 0 to 100 and a spoken value, an indeterminate form
 * without a value, the static variant and the word "Working" under reduced motion (following preference
 * changes), the supplementary percent text, sizes, and the error tone. Also covers the reduced-motion
 * helpers it reads through.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { ProgressBar } from '../../../src/renderer/src/ui/ProgressBar'
import { prefersReducedMotion, subscribeReducedMotion } from '../../../src/renderer/src/ui/platform'

const REDUCED = '(prefers-reduced-motion: reduce)'

interface FakeQuery
{
  matches: boolean
  listeners: Set<() => void>
}

/** Replaces matchMedia with a controllable reduced-motion query; other queries never match. */
function mockReducedMotion(initial: boolean): FakeQuery
{
  const state: FakeQuery = { matches: initial, listeners: new Set() }
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    get matches(): boolean
    {
      return query === REDUCED && state.matches
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) => state.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => state.listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }) as unknown as MediaQueryList)
  return state
}

function classesOf(element: Element): string[]
{
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

function fillOf(bar: HTMLElement): HTMLElement
{
  return bar.firstElementChild as HTMLElement
}

describe('ProgressBar', () =>
{
  afterEach(() =>
  {
    cleanup()
    vi.restoreAllMocks()
  })

  it('exposes a named progressbar from 0 to 100 with the percent as its value', () =>
  {
    render(<ProgressBar value={0.46} label="Encoding MM-0141" />)
    const bar = screen.getByRole('progressbar', { name: 'Encoding MM-0141' })
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuenow', '46')
    expect(bar).toHaveAttribute('aria-valuetext', '46 percent')
    expect(bar).not.toHaveAttribute('data-indeterminate')
  })

  it('speaks the caller value text', () =>
  {
    render(<ProgressBar value={0.46} label="Encoding MM-0141" valueText="46 percent, pass 1 of 2" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '46 percent, pass 1 of 2')
  })

  it('rounds to whole percents and clamps to the range', () =>
  {
    const { rerender } = render(<ProgressBar value={0.456} label="Run" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '46')
    rerender(<ProgressBar value={1.4} label="Run" />)
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(fillOf(bar).style.transform).toBe('scaleX(1)')
    rerender(<ProgressBar value={-0.2} label="Run" />)
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(fillOf(bar).style.transform).toBe('scaleX(0)')
  })

  it('grows its neutral fill by scaling at the base duration', () =>
  {
    render(<ProgressBar value={0.25} label="Run" />)
    const fill = fillOf(screen.getByRole('progressbar'))
    expect(fill.style.transform).toBe('scaleX(0.25)')
    expect(classesOf(fill)).toEqual(expect.arrayContaining(['ui-progress-fill', 'bg-ink-2', 'w-full', 'origin-left', 'transition-transform', 'duration-base']))
  })

  it('prints the percent after the bar by default and not when the row prints it', () =>
  {
    const { container, rerender } = render(<ProgressBar value={0.46} label="Run" />)
    const text = screen.getByText('46%')
    expect(text).toHaveAttribute('aria-hidden', 'true')
    expect(classesOf(text)).toEqual(expect.arrayContaining(['text-label', 'text-ink-2', 'tabular-nums']))
    rerender(<ProgressBar value={0.46} label="Run" showValue={false} />)
    expect(screen.queryByText('46%')).toBeNull()
    expect(container.firstElementChild?.children).toHaveLength(1)
  })

  it('omits the value while the amount of work is unknown and shows a traveling segment', () =>
  {
    mockReducedMotion(false)
    render(<ProgressBar label="Measuring album" />)
    const bar = screen.getByRole('progressbar', { name: 'Measuring album' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('aria-valuetext', 'Working')
    expect(bar).toHaveAttribute('data-indeterminate')
    expect(bar).not.toHaveAttribute('data-static')
    const fill = fillOf(bar)
    expect(fill.getAttribute('style')).toBeNull()
    expect(classesOf(fill)).toContain('bg-ink-2')
    expect(classesOf(fill)).not.toContain('w-full')
    expect(screen.queryByText('Working')).toBeNull()
  })

  it('treats a NaN value as unknown', () =>
  {
    render(<ProgressBar value={Number.NaN} label="Run" valueText="Starting" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('aria-valuetext', 'Starting')
  })

  it('renders the static variant with the word Working under reduced motion', () =>
  {
    mockReducedMotion(true)
    render(<ProgressBar label="Measuring album" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('data-static')
    expect(classesOf(fillOf(bar))).not.toContain('bg-ink-2')
    expect(screen.getByText('Working')).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps a determinate bar unchanged under reduced motion and hides the word when the row speaks', () =>
  {
    mockReducedMotion(true)
    const { rerender } = render(<ProgressBar value={0.5} label="Run" />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('data-static')
    expect(screen.getByText('50%')).toBeInTheDocument()
    rerender(<ProgressBar label="Run" showValue={false} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-static')
    expect(screen.queryByText('Working')).toBeNull()
  })

  it('follows a change of the motion preference while mounted', () =>
  {
    const query = mockReducedMotion(false)
    render(<ProgressBar label="Run" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveAttribute('data-static')
    expect(query.listeners.size).toBe(1)
    act(() =>
    {
      query.matches = true
      query.listeners.forEach((listener) => listener())
    })
    expect(bar).toHaveAttribute('data-static')
    cleanup()
    expect(query.listeners.size).toBe(0)
  })

  it('draws the sm and md sizes inside a framed sunken track', () =>
  {
    const { rerender } = render(<ProgressBar value={0.1} label="Run" size="sm" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('data-size', 'sm')
    expect(classesOf(bar)).toEqual(expect.arrayContaining(['ui-progress', 'h-1', 'box-content', 'border', 'border-line-control', 'bg-sunken', 'rounded-xs', 'overflow-hidden']))
    rerender(<ProgressBar value={0.1} label="Run" />)
    expect(bar).toHaveAttribute('data-size', 'md')
    expect(classesOf(bar)).toContain('h-1.5')
  })

  it('holds the error fill at the value it stopped on', () =>
  {
    render(<ProgressBar value={0.62} label="Encoding MM-0141" tone="error" />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('data-tone', 'error')
    expect(bar).toHaveAttribute('aria-valuenow', '62')
    const fill = fillOf(bar)
    expect(classesOf(fill)).toContain('bg-error-fill')
    expect(classesOf(fill)).not.toContain('bg-ink-2')
    expect(fill.style.transform).toBe('scaleX(0.62)')
  })

  it('puts a caller class on the row that holds the bar and its value', () =>
  {
    const { container } = render(<ProgressBar value={0.3} label="Run" className="w-40" />)
    expect(classesOf(container.firstElementChild!)).toEqual(expect.arrayContaining(['flex', 'items-center', 'w-40']))
  })
})

describe('reduced-motion helpers', () =>
{
  afterEach(() =>
  {
    vi.restoreAllMocks()
  })

  it('reads the system preference', () =>
  {
    const query = mockReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
    query.matches = true
    expect(prefersReducedMotion()).toBe(true)
  })

  it('subscribes to preference changes and unsubscribes', () =>
  {
    const query = mockReducedMotion(false)
    const listener = vi.fn()
    const unsubscribe = subscribeReducedMotion(listener)
    expect(query.listeners.has(listener)).toBe(true)
    unsubscribe()
    expect(query.listeners.has(listener)).toBe(false)
  })
})
