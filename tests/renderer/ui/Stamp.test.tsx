/**
 * Stamp: the verified and returned anatomy with a sentence-case word, qualifiers kept inside the value
 * text, and the landing rules: only a live transition in view lands, never a mount from history, never
 * under reduced motion, at most four landings per 500 ms, and data-landing clears on animationend.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach, type MockInstance } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { STAMP_LANDING_EXPIRY_MS, STAMP_LANDING_LIMIT, STAMP_LANDING_WINDOW_MS, Stamp, useStampLanding, type StampOutcome } from '../../../src/renderer/src/ui/Stamp'

/** The text a screen reader reaches: every text node outside `aria-hidden` subtrees. */
function accessibleText(element: Element): string
{
  let text = ''
  element.childNodes.forEach((node) =>
  {
    if (node.nodeType === Node.TEXT_NODE)
    {
      text += node.textContent ?? ''
    }
    else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true')
    {
      text += accessibleText(node)
    }
  })
  return text
}

function stamps(container: HTMLElement): HTMLElement[]
{
  return Array.from(container.querySelectorAll<HTMLElement>('.ui-stamp'))
}

function stampIn(container: HTMLElement): HTMLElement
{
  const [stamp] = stamps(container)
  expect(stamp).toBeDefined()
  return stamp
}

function animationEvent(type: 'animationend' | 'animationcancel', animationName?: string): Event
{
  const event = new Event(type, { bubbles: true })
  if (animationName !== undefined)
  {
    Object.defineProperty(event, 'animationName', { value: animationName })
  }
  return event
}

let clock = 1_000_000
let clockSpy: MockInstance<() => number> | undefined
let motionSpy: MockInstance<(query: string) => MediaQueryList> | undefined

function preferReducedMotion(): void
{
  motionSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }) as MediaQueryList)
}

type JobState = 'encoding' | 'verifying' | 'verified' | 'returned'

/** A table row as the batch view builds one: progress while active, then the stamp. */
function Row({ state }: { state: JobState }): React.ReactElement
{
  const active = state === 'encoding' || state === 'verifying'
  const landing = useStampLanding(active)
  return (
    <div role="row">
      {active
        ? <span>{state}</span>
        : <Stamp outcome={state as StampOutcome} values={[{ text: '-16.0 LUFS' }, { text: '-1.6 dBTP' }]} landing={landing} />}
    </div>
  )
}

function LandingProbe({ active }: { active: boolean }): React.ReactElement
{
  return <output>{String(useStampLanding(active))}</output>
}

beforeAll(() =>
{
  clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterAll(() =>
{
  clockSpy?.mockRestore()
})

beforeEach(() =>
{
  clock += 10_000
})

afterEach(() =>
{
  cleanup()
  motionSpy?.mockRestore()
  motionSpy = undefined
})

describe('Stamp anatomy', () =>
{
  it('renders a verified stamp with icon, word, and values', () =>
  {
    const { container } = render(<Stamp outcome="verified" values={[{ text: '−16.0 LUFS' }, { text: '−1.6 dBTP' }]} />)
    const stamp = stampIn(container)
    expect(stamp).toHaveAttribute('data-outcome', 'verified')
    expect(stamp).not.toHaveAttribute('data-size')
    expect(stamp).toHaveClass('text-label')
    const icon = stamp.querySelector('svg[data-icon]')
    expect(icon).toHaveAttribute('data-icon', 'status.verified')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(stamp.querySelector('[data-part="values"]')).toHaveTextContent('−16.0 LUFS')
    expect(stamp.querySelectorAll('[data-part="value"]')).toHaveLength(2)
    expect(accessibleText(stamp)).toBe('Verified, −16.0 LUFS, −1.6 dBTP')
  })

  it('names the word in sentence case while the visible copy is uppercase', () =>
  {
    const { container } = render(<Stamp outcome="verified" values={[]} />)
    const stamp = stampIn(container)
    const visible = stamp.querySelector('.uppercase')
    expect(visible).toHaveAttribute('aria-hidden', 'true')
    expect(visible).toHaveTextContent('Verified')
    expect(visible).toHaveClass('type-legend')
    expect(stamp.querySelector('.sr-only')).toHaveTextContent(/^Verified$/)
    expect(accessibleText(stamp)).toBe('Verified')
    expect(stamp.querySelector('[data-part="values"]')).toBeNull()
  })

  it('renders a returned stamp with failing values and the reason', () =>
  {
    const { container } = render(
      <Stamp
        outcome="returned"
        values={[{ text: '−21.8 LUFS' }, { text: '−0.4 dBTP over', failing: true }]}
        reason="True peak −0.4 dBTP over −1.0"
      />
    )
    const stamp = stampIn(container)
    expect(stamp).toHaveAttribute('data-outcome', 'returned')
    expect(stamp.querySelector('svg[data-icon]')).toHaveAttribute('data-icon', 'status.failed')
    const values = stamp.querySelectorAll('[data-part="value"]')
    expect(values[0]).not.toHaveAttribute('data-failing')
    expect(values[1]).toHaveAttribute('data-failing')
    expect(stamp.querySelector('[data-part="reason"]')).toHaveTextContent('True peak −0.4 dBTP over −1.0')
    expect(accessibleText(stamp)).toBe('Returned, −21.8 LUFS, −0.4 dBTP over, True peak −0.4 dBTP over −1.0')
  })

  it('reads a reason without values', () =>
  {
    const { container } = render(<Stamp outcome="returned" values={[]} reason="Decode failed" />)
    expect(accessibleText(stampIn(container))).toBe('Returned, Decode failed')
  })

  it('keeps qualifiers inside the value text', () =>
  {
    const { container } = render(
      <>
        <Stamp outcome="verified" values={[{ text: '-19.1 LUFS, reachable' }, { text: '-1.5 dBTP' }]} />
        <Stamp outcome="verified" values={[{ text: 'MP4 · 38:20 · sampled' }]} />
        <Stamp outcome="verified" values={[{ text: '-16.0 LKFS' }, { text: '-1.6 dBTP' }, { text: '+2 streams' }]} />
      </>
    )
    const [reachable, sampled, streams] = stamps(container)
    const first = (stamp: HTMLElement): string => accessibleText(stamp.querySelector('[data-part="value"]') as Element)
    expect(first(reachable)).toBe(', -19.1 LUFS, reachable')
    expect(first(sampled)).toBe(', MP4 · 38:20 · sampled')
    expect(streams.querySelectorAll('[data-part="value"]')[2]).toHaveTextContent('+2 streams')
    expect(accessibleText(reachable)).toBe('Verified, -19.1 LUFS, reachable, -1.5 dBTP')
  })

  it('renders a value label and the md size', () =>
  {
    const { container } = render(<Stamp outcome="verified" size="md" className="ms-2" values={[{ label: 'Loudness', text: '-16.0 LKFS' }]} />)
    const stamp = stampIn(container)
    expect(stamp).toHaveAttribute('data-size', 'md')
    expect(stamp).toHaveClass('ms-2')
    expect(stamp.querySelector('[data-part="value-label"]')).toHaveTextContent('Loudness')
    expect(accessibleText(stamp)).toBe('Verified, Loudness -16.0 LKFS')
  })

  it('describes itself with the reference line through the tooltip prop', () =>
  {
    const reference = 'Apple Podcasts: -16 LKFS; this app\'s check ±1.0 dB for lossy outputs; limit -1.0 dBTP'
    const { container } = render(<Stamp outcome="verified" values={[{ text: '-16.0 LKFS' }]} tooltip={reference} />)
    const stamp = stampIn(container)
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).toHaveTextContent(reference)
    expect(stamp).toContainElement(tip)
    expect(stamp.getAttribute('aria-describedby')).toContain(tip.id)
    expect(accessibleText(stamp)).toBe('Verified, -16.0 LKFS')
  })

  it('is not focusable and carries no description without a tooltip', () =>
  {
    const { container } = render(<Stamp outcome="verified" values={[{ text: '412 MB' }]} />)
    const stamp = stampIn(container)
    expect(stamp).not.toHaveAttribute('tabindex')
    expect(stamp).not.toHaveAttribute('aria-describedby')
    stamp.focus()
    expect(document.activeElement).not.toBe(stamp)
  })
})

describe('Stamp landing without an observer', () =>
{
  it('lands at once for a mounted stamp, counted as in view', () =>
  {
    const { container, rerender } = render(<Stamp outcome="verified" values={[]} />)
    expect(stampIn(container)).not.toHaveAttribute('data-landing')
    rerender(<Stamp outcome="verified" values={[]} landing />)
    expect(stampIn(container)).toHaveAttribute('data-landing')
    expect(stampIn(container)).not.toHaveAttribute('style')
  })
})

type FakeEntry = Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>

class FakeIntersectionObserver
{
  static instances: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()

  constructor(readonly callback: (entries: FakeEntry[]) => void)
  {
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void
  {
    this.targets.add(target)
  }

  unobserve(target: Element): void
  {
    this.targets.delete(target)
  }

  disconnect(): void
  {
    this.targets.clear()
  }
}

function report(target: Element, isIntersecting: boolean): void
{
  act(() =>
  {
    for (const observer of FakeIntersectionObserver.instances)
    {
      if (observer.targets.has(target))
      {
        observer.callback([{ target, isIntersecting }])
      }
    }
  })
}

describe('Stamp landing', () =>
{
  const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

  beforeAll(() =>
  {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver
  })

  afterAll(() =>
  {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original
  })

  /** Mounts a running row, finishes it, and reports the new stamp's visibility. */
  function finish(visible: boolean, outcome: StampOutcome = 'verified'): { container: HTMLElement, stamp: HTMLElement, rerender: (state: JobState) => void }
  {
    const { container, rerender } = render(<Row state="encoding" />)
    rerender(<Row state={outcome} />)
    const stamp = stampIn(container)
    report(stamp, visible)
    return { container, stamp, rerender: (state) => rerender(<Row state={state} />) }
  }

  it('lands when a mounted row rerenders from an active state to verified', () =>
  {
    const { container, rerender } = render(<Row state="encoding" />)
    expect(stamps(container)).toHaveLength(0)
    rerender(<Row state="verifying" />)
    rerender(<Row state="verified" />)
    const stamp = stampIn(container)
    expect(stamp).not.toHaveAttribute('data-landing')
    expect(stamp.style.opacity).toBe('0')
    report(stamp, true)
    expect(stamp).toHaveAttribute('data-landing')
    expect(stamp.style.opacity).toBe('')
  })

  it('lands for a returned outcome too', () =>
  {
    const { stamp } = finish(true, 'returned')
    expect(stamp).toHaveAttribute('data-outcome', 'returned')
    expect(stamp).toHaveAttribute('data-landing')
  })

  it('never lands when the row mounts already verified, scrolls into view, or rerenders', () =>
  {
    const { container, rerender } = render(<Row state="verified" />)
    const stamp = stampIn(container)
    expect(stamp.style.opacity).toBe('')
    report(stamp, false)
    report(stamp, true)
    rerender(<Row state="verified" />)
    expect(stampIn(container)).not.toHaveAttribute('data-landing')
  })

  it('removes data-landing on animationend and never replays on rerender or scroll', () =>
  {
    const { container, stamp, rerender } = finish(true)
    expect(stamp).toHaveAttribute('data-landing')
    fireEvent(stamp, animationEvent('animationend'))
    expect(stamp).not.toHaveAttribute('data-landing')
    rerender('verified')
    report(stamp, false)
    report(stamp, true)
    expect(stampIn(container)).not.toHaveAttribute('data-landing')
  })

  it('keeps the landing until the impression ring ends', () =>
  {
    const { stamp } = finish(true)
    Object.defineProperty(stamp, 'getAnimations', { configurable: true, value: () => [{ playState: 'running' }] })
    fireEvent(stamp, animationEvent('animationend', 'stamp-land'))
    expect(stamp).toHaveAttribute('data-landing')
    fireEvent(stamp, animationEvent('animationend', 'stamp-impression'))
    expect(stamp).not.toHaveAttribute('data-landing')
  })

  it('settles when stamp-land ends with nothing left running', () =>
  {
    const { stamp } = finish(true)
    Object.defineProperty(stamp, 'getAnimations', { configurable: true, value: () => [] })
    fireEvent(stamp, animationEvent('animationend', 'stamp-land'))
    expect(stamp).not.toHaveAttribute('data-landing')
  })

  it('ignores animation events from inside the stamp and settles on animationcancel', () =>
  {
    const { stamp } = finish(true)
    const icon = stamp.querySelector('svg') as SVGElement
    fireEvent(icon, animationEvent('animationend'))
    fireEvent(icon, animationEvent('animationcancel'))
    expect(stamp).toHaveAttribute('data-landing')
    fireEvent(stamp, animationEvent('animationcancel'))
    expect(stamp).not.toHaveAttribute('data-landing')
    fireEvent(stamp, animationEvent('animationend'))
    fireEvent(stamp, animationEvent('animationcancel'))
    expect(stamp).not.toHaveAttribute('data-landing')
  })

  it('never lands under reduced motion', () =>
  {
    preferReducedMotion()
    const { container, rerender } = render(<Row state="encoding" />)
    rerender(<Row state="verified" />)
    const stamp = stampIn(container)
    expect(stamp.style.opacity).toBe('')
    report(stamp, true)
    expect(stamp).not.toHaveAttribute('data-landing')
  })

  it('settles when reduced motion turns on before the stamp is seen', () =>
  {
    const { container, rerender } = render(<Row state="encoding" />)
    rerender(<Row state="verified" />)
    const stamp = stampIn(container)
    expect(stamp.style.opacity).toBe('0')
    preferReducedMotion()
    report(stamp, true)
    expect(stamp).not.toHaveAttribute('data-landing')
    expect(stamp.style.opacity).toBe('')
  })

  it('never lands out of view', () =>
  {
    const { stamp } = finish(false)
    expect(stamp).not.toHaveAttribute('data-landing')
    expect(stamp.style.opacity).toBe('')
    report(stamp, true)
    expect(stamp).not.toHaveAttribute('data-landing')
  })

  it('lands at once when a mounted, visible stamp receives landing', () =>
  {
    const { container, rerender } = render(<Stamp outcome="verified" values={[]} />)
    report(stampIn(container), true)
    rerender(<Stamp outcome="verified" values={[]} landing />)
    expect(stampIn(container)).toHaveAttribute('data-landing')
    rerender(<Stamp outcome="verified" values={[]} landing={false} />)
    expect(stampIn(container)).toHaveAttribute('data-landing')
  })

  it('ignores a repeated landing report while the stamp is still landing', () =>
  {
    const { container, rerender } = render(<Stamp outcome="verified" values={[]} />)
    report(stampIn(container), true)
    rerender(<Stamp outcome="verified" values={[]} landing />)
    rerender(<Stamp outcome="verified" values={[]} landing={false} />)
    rerender(<Stamp outcome="verified" values={[]} landing />)
    expect(stampIn(container)).toHaveAttribute('data-landing')
    const others = [0, 1, 2].map(() => finish(true).stamp)
    expect(others.every((stamp) => stamp.hasAttribute('data-landing'))).toBe(true)
  })

  it('renders a fifth landing inside one 500 ms window settled', () =>
  {
    expect(STAMP_LANDING_LIMIT).toBe(4)
    expect(STAMP_LANDING_WINDOW_MS).toBe(500)
    const finished = [0, 1, 2, 3, 4].map(() => finish(true).stamp)
    expect(finished.map((stamp) => stamp.hasAttribute('data-landing'))).toEqual([true, true, true, true, false])
    expect(finished[4].style.opacity).toBe('')
    clock += STAMP_LANDING_WINDOW_MS - 1
    expect(finish(true).stamp).not.toHaveAttribute('data-landing')
    clock += 1
    expect(finish(true).stamp).toHaveAttribute('data-landing')
  })

  it('lets the row report lapse so a later remount never lands', () =>
  {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try
    {
      const { rerender } = render(<LandingProbe active />)
      expect(screen.getByRole('status')).toHaveTextContent('false')
      rerender(<LandingProbe active={false} />)
      expect(screen.getByRole('status')).toHaveTextContent('true')
      act(() =>
      {
        vi.advanceTimersByTime(STAMP_LANDING_EXPIRY_MS)
      })
      expect(screen.getByRole('status')).toHaveTextContent('false')
      rerender(<LandingProbe active />)
      expect(screen.getByRole('status')).toHaveTextContent('false')
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('releases the observer when the stamp unmounts', () =>
  {
    const { container, unmount } = render(<Stamp outcome="verified" values={[]} />)
    const stamp = stampIn(container)
    expect(FakeIntersectionObserver.instances.some((observer) => observer.targets.has(stamp))).toBe(true)
    unmount()
    expect(FakeIntersectionObserver.instances.some((observer) => observer.targets.has(stamp))).toBe(false)
  })
})
