/**
 * ToastRegion and the announcement policy: the two live regions exist empty at mount, run-blocking errors
 * speak through the alert region and everything else through the status region, timers dismiss info and
 * warnings and pause on hover and focus, errors and toasts with actions persist, at most three toasts show,
 * keyed repeats update one toast in place, and the progress digest speaks nothing unless enabled.
 */
import React, { createRef, useRef, type ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import {
  ToastRegion,
  clearToasts,
  createProgressDigest,
  toast,
  toastLifetime,
  useProgressDigest,
  useToast,
  useToastCount,
  PROGRESS_DIGEST_MS,
  TOAST_INFO_MS,
  TOAST_REANNOUNCE_MS,
  TOAST_WARNING_MS,
  type ToastApi,
  type ToastOptions
} from '../../../src/renderer/src/ui/Toast'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'

const FRAME_MS = 16

let reducedMotion = false

function stubMatchMedia(): void
{
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reducedMotion && query.includes('reduce'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
}

interface Speech
{
  text: string
  at: number
}

/** Records every non-empty text written into a live region, with the fake clock's time. */
function recordSpeech(element: Element): Speech[]
{
  const spoken: Speech[] = []
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent') as PropertyDescriptor
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get()
    {
      return descriptor.get?.call(this)
    },
    set(value: string)
    {
      descriptor.set?.call(this, value)
      if (value)
      {
        spoken.push({ text: value, at: Date.now() })
      }
    }
  })
  return spoken
}

function advance(ms: number): void
{
  act(() =>
  {
    vi.advanceTimersByTime(ms)
  })
}

function show(options: ToastOptions): string
{
  let id = ''
  act(() =>
  {
    id = toast.show(options)
  })
  return id
}

function renderRegion(props: React.ComponentProps<typeof ToastRegion> = {}): { region: HTMLElement, polite: Speech[], assertive: Speech[] }
{
  render(
    <main>
      <button type="button">Before</button>
      <button type="button">After</button>
      <ToastRegion {...props} />
    </main>
  )
  const region = screen.getByRole('region', { name: 'Notifications' })
  return { region, polite: recordSpeech(screen.getByRole('status')), assertive: recordSpeech(screen.getByRole('alert')) }
}

function toastNamed(name: string): HTMLElement
{
  return screen.getByRole('group', { name })
}

beforeEach(() =>
{
  reducedMotion = false
  stubMatchMedia()
  vi.useFakeTimers()
})

afterEach(() =>
{
  cleanup()
  act(() => clearToasts())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'elementFromPoint')
})

function stubHitTest(result: () => Element | null): ReturnType<typeof vi.fn>
{
  const hit = vi.fn(result)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, writable: true, value: hit })
  return hit
}

describe('ToastRegion', () =>
{
  it('mounts both live regions empty inside the Notifications region', () =>
  {
    const { region } = renderRegion()
    const status = screen.getByRole('status')
    const alert = screen.getByRole('alert')
    expect(region).toContainElement(status)
    expect(region).toContainElement(alert)
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toBeEmptyDOMElement()
    expect(alert).toBeEmptyDOMElement()
    expect(region).toHaveAttribute('data-empty')
  })

  it('speaks run-blocking errors through the alert region and every other toast through the status region', () =>
  {
    const { polite, assertive } = renderRegion()
    show({ tone: 'error', title: 'D: is full.', announce: 'assertive' })
    advance(20)
    expect(screen.getByRole('alert')).toHaveTextContent('D: is full.')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'success', title: 'Batch 31 started: 22 jobs.' })
    advance(20)
    expect(polite.map((entry) => entry.text)).toEqual(['MM-0141 returned: Disk full. Batch 31 started: 22 jobs.'])
    expect(assertive.map((entry) => entry.text)).toEqual(['D: is full.'])
    show({ tone: 'info', title: 'Added 4 files.', announce: 'none' })
    advance(TOAST_REANNOUNCE_MS)
    expect(polite).toHaveLength(1)
    expect(toastNamed('Added 4 files.')).toBeInTheDocument()
  })

  it('dismisses info after 6 s and warnings after 10 s', () =>
  {
    renderRegion()
    show({ tone: 'info', title: 'Copied path.' })
    show({ tone: 'warning', title: 'MM-0007: Loudness is 0.6 LU off target.' })
    advance(TOAST_INFO_MS - 1)
    expect(toastNamed('Copied path.')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('group', { name: 'Copied path.' })).toBeNull()
    advance(TOAST_WARNING_MS - TOAST_INFO_MS - 1)
    expect(toastNamed('MM-0007: Loudness is 0.6 LU off target.')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByRole('group', { name: 'MM-0007: Loudness is 0.6 LU off target.' })).toBeNull()
  })

  it('pauses the timers while the stack is hovered', () =>
  {
    renderRegion()
    show({ tone: 'info', title: 'Copied path.' })
    advance(3000)
    fireEvent.pointerEnter(toastNamed('Copied path.'))
    advance(20_000)
    expect(toastNamed('Copied path.')).toBeInTheDocument()
    fireEvent.pointerLeave(toastNamed('Copied path.'))
    advance(2900)
    expect(toastNamed('Copied path.')).toBeInTheDocument()
    advance(200)
    expect(screen.queryByRole('group', { name: 'Copied path.' })).toBeNull()
  })

  it('ends the hover pause at the next pointer move outside the stack', () =>
  {
    renderRegion()
    show({ tone: 'info', title: 'Copied path.' })
    const element = toastNamed('Copied path.')
    fireEvent.pointerEnter(element)
    fireEvent.pointerMove(element)
    advance(TOAST_INFO_MS * 2)
    expect(toastNamed('Copied path.')).toBeInTheDocument()
    fireEvent.pointerMove(screen.getByRole('button', { name: 'After' }))
    advance(TOAST_INFO_MS)
    expect(screen.queryByRole('group', { name: 'Copied path.' })).toBeNull()
  })

  it('speaks a burst of updates once, with the latest title, when the spacing allows', () =>
  {
    const { polite } = renderRegion()
    const id = show({ tone: 'error', title: 'MM-0141 returned: Disk full.', key: 'returned:31' })
    for (const count of [2, 3, 4])
    {
      advance(1000)
      act(() => toast.update(id, { title: `${count} jobs returned in Batch 31.` }))
    }
    advance(TOAST_REANNOUNCE_MS)
    expect(polite.map((entry) => entry.text)).toEqual(['MM-0141 returned: Disk full.', '4 jobs returned in Batch 31.'])
  })

  it('holds a second message until the first has had its moment', () =>
  {
    const { polite } = renderRegion()
    show({ tone: 'success', title: 'Batch 31 started: 22 jobs.' })
    advance(100)
    show({ tone: 'info', title: 'Copied command.' })
    advance(300)
    expect(polite.map((entry) => entry.text)).toEqual(['Batch 31 started: 22 jobs.'])
    advance(300)
    expect(polite.map((entry) => entry.text)).toEqual(['Batch 31 started: 22 jobs.', 'Copied command.'])
    expect(polite[1].at - polite[0].at).toBeGreaterThanOrEqual(500)
  })

  it('pauses the timers while focus is within the stack', () =>
  {
    renderRegion()
    show({ tone: 'success', title: 'Saved preset Archive.' })
    act(() => toastNamed('Saved preset Archive.').focus())
    advance(20_000)
    expect(toastNamed('Saved preset Archive.')).toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'Before' }).focus())
    advance(TOAST_INFO_MS)
    expect(screen.queryByRole('group', { name: 'Saved preset Archive.' })).toBeNull()
  })

  it('keeps errors until they are dismissed and gives toasts with actions the warning time', () =>
  {
    renderRegion()
    const undo = vi.fn()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'info', title: 'Removed 3 jobs.', actions: [{ label: 'Undo', onAction: undo }] })
    advance(TOAST_WARNING_MS - 100)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toastNamed('Removed 3 jobs.')).toBeInTheDocument()
    advance(60_000)
    expect(toastNamed('MM-0141 returned: Disk full.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Removed 3 jobs.' })).toBeNull()
  })

  it('shows at most three toasts and folds older ones into a line that opens Logs', () =>
  {
    const onShowMore = vi.fn()
    renderRegion({ onShowMore })
    for (const n of [1, 2, 3, 4, 5])
    {
      show({ tone: 'error', title: `Toast ${n}.` })
    }
    const shown = screen.getAllByRole('group').map((element) => element.querySelector('p')?.textContent)
    expect(shown).toEqual(['Toast 3.', 'Toast 4.', 'Toast 5.'])
    const more = screen.getByRole('button', { name: '+2 more notifications, open Logs' })
    expect(more).toHaveTextContent('+2 more')
    fireEvent.click(more)
    expect(onShowMore).toHaveBeenCalledTimes(1)
  })

  it('keeps timing the toasts folded into the line, so an older one never resurfaces late', () =>
  {
    renderRegion()
    for (const n of [1, 2, 3, 4])
    {
      show({ tone: 'info', title: `Toast ${n}.` })
      advance(1000)
    }
    expect(screen.getByText('+1 more')).toBeInTheDocument()
    advance(TOAST_INFO_MS - 4000)
    expect(screen.queryByText('+1 more')).toBeNull()
    expect(screen.getAllByRole('group').map((element) => element.querySelector('p')?.textContent)).toEqual(['Toast 2.', 'Toast 3.', 'Toast 4.'])
    advance(1000)
    expect(screen.queryByRole('group', { name: 'Toast 2.' })).toBeNull()
  })

  it('draws the fold line as text without a Logs handler', () =>
  {
    renderRegion()
    for (const n of [1, 2, 3, 4])
    {
      show({ tone: 'error', title: `Toast ${n}.` })
    }
    expect(screen.getByText('+1 more').tagName).toBe('P')
    expect(screen.queryByRole('button', { name: /more notifications/ })).toBeNull()
  })

  it('coalesces three returns within 10 s into one toast keyed by the run and speaks at most once per 5 s', () =>
  {
    const { polite } = renderRegion()
    const showJob = { label: 'Show', onAction: vi.fn() }
    const retry = { label: 'Retry', onAction: vi.fn() }
    const showReturned = { label: 'Show returned', onAction: vi.fn() }
    const first = show({ tone: 'error', title: 'MM-0141 returned: Disk full.', key: 'returned:31', jobId: 'job-141', actions: [showJob, retry] })
    advance(4000)
    const second = show({ tone: 'error', title: '2 jobs returned in Batch 31.', key: 'returned:31', actions: [showReturned] })
    advance(4000)
    const third = show({ tone: 'error', title: '3 jobs returned in Batch 31.', key: 'returned:31', actions: [showReturned] })
    expect(second).toBe(first)
    expect(third).toBe(first)
    const groups = screen.getAllByRole('group')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveAccessibleName('3 jobs returned in Batch 31.')
    expect(groups[0]).not.toHaveAttribute('data-job-id')
    expect(screen.getByRole('button', { name: 'Show returned' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    advance(TOAST_REANNOUNCE_MS)
    expect(polite.map((entry) => entry.text)).toEqual([
      'MM-0141 returned: Disk full.',
      '2 jobs returned in Batch 31.',
      '3 jobs returned in Batch 31.'
    ])
    for (let index = 1; index < polite.length; index += 1)
    {
      // Writes land on animation frames, so a gap can read up to one frame short of the policy's spacing.
      expect(polite[index].at - polite[index - 1].at).toBeGreaterThanOrEqual(TOAST_REANNOUNCE_MS - FRAME_MS)
    }
  })

  it('returns an id from show and updates that toast in place', () =>
  {
    const { polite } = renderRegion()
    const id = show({ tone: 'info', title: 'Probing 4 files.', body: 'Started.' })
    const node = toastNamed('Probing 4 files.')
    expect(node).toHaveAttribute('data-toast-id', id)
    expect(node).toHaveAccessibleDescription('Started.')
    advance(20)
    act(() => toast.update(id, { title: 'Probed 4 files.', body: undefined, actions: [{ label: 'Select', onAction: () => undefined }] }))
    expect(toastNamed('Probed 4 files.')).toBe(node)
    expect(node).not.toHaveAttribute('aria-describedby')
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument()
    act(() => toast.update(id, { body: 'Nothing new to say.' }))
    act(() => toast.update('toast-missing', { title: 'Ignored.' }))
    act(() => toast.dismiss('toast-missing'))
    advance(TOAST_REANNOUNCE_MS)
    expect(polite.map((entry) => entry.text)).toEqual(['Probing 4 files.', 'Probed 4 files.'])
  })

  it('updates a shown toast with the same key instead of stacking, and restarts its timer', () =>
  {
    renderRegion()
    const first = show({ tone: 'warning', title: 'MM-0007: Loudness is 0.6 LU off target.', key: 'held:31' })
    advance(8000)
    const again = show({ tone: 'warning', title: '2 jobs have new warnings in Batch 31.', key: 'held:31' })
    expect(again).toBe(first)
    expect(screen.getAllByRole('group')).toHaveLength(1)
    advance(8000)
    expect(toastNamed('2 jobs have new warnings in Batch 31.')).toBeInTheDocument()
    advance(TOAST_WARNING_MS - 8000)
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    const fresh = show({ tone: 'warning', title: 'MM-0009: Clipped 3 samples.', key: 'held:31' })
    expect(fresh).not.toBe(first)
  })

  it('drops a pending repeat announcement when the toast goes away', () =>
  {
    const { polite } = renderRegion()
    const id = show({ tone: 'error', title: 'MM-0141 returned: Disk full.', key: 'returned:31' })
    show({ tone: 'error', title: '2 jobs returned in Batch 31.', key: 'returned:31' })
    act(() => toast.dismiss(id))
    advance(TOAST_REANNOUNCE_MS * 2)
    expect(polite.map((entry) => entry.text)).toEqual(['MM-0141 returned: Disk full.'])
    const next = show({ tone: 'error', title: 'MM-0150 returned: Source missing.', key: 'returned:32' })
    show({ tone: 'error', title: '2 jobs returned in Batch 32.', key: 'returned:32' })
    act(() => clearToasts())
    advance(TOAST_REANNOUNCE_MS * 2)
    expect(next).toMatch(/^toast-/)
    expect(polite.map((entry) => entry.text)).toEqual(['MM-0141 returned: Disk full.', 'MM-0150 returned: Source missing.'])
  })

  it('folds the stack into a one-line summary while it would cover the focused control', () =>
  {
    const { region } = renderRegion()
    const first = show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    const covered = toastNamed('MM-0150 returned: Source missing.')
    const hit = stubHitTest(() => covered)
    act(() => screen.getByRole('button', { name: 'Before' }).focus())
    expect(hit).toHaveBeenCalled()
    expect(region).toHaveAttribute('data-collapsed')
    expect(screen.getByText('2 notifications, F6 to review')).toBeInTheDocument()
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    act(() => toast.dismiss(first))
    expect(screen.getByText('1 notification, F6 to review')).toBeInTheDocument()
    hit.mockReturnValue(null)
    act(() => screen.getByRole('button', { name: 'After' }).focus())
    expect(region).not.toHaveAttribute('data-collapsed')
    expect(screen.getAllByRole('group')).toHaveLength(1)
  })

  it('folds when a new toast lands over the focused control', () =>
  {
    const { region } = renderRegion()
    act(() => screen.getByRole('button', { name: 'After' }).focus())
    stubHitTest(() => region.querySelector('[data-toast-id]'))
    show({ tone: 'info', title: 'Copied command.' })
    expect(region).toHaveAttribute('data-collapsed')
  })

  it('focuses the newest toast when the region is entered, expanding a folded stack', () =>
  {
    const { region } = renderRegion()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    stubHitTest(() => toastNamed('MM-0141 returned: Disk full.'))
    act(() => screen.getByRole('button', { name: 'Before' }).focus())
    expect(region).toHaveAttribute('data-collapsed')
    act(() => region.focus())
    expect(region).not.toHaveAttribute('data-collapsed')
    expect(toastNamed('MM-0150 returned: Source missing.')).toHaveFocus()
  })

  it('dismisses the focused toast on Escape and moves focus to the next toast, then back to where focus was', () =>
  {
    const { region } = renderRegion()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    const before = screen.getByRole('button', { name: 'Before' })
    act(() => before.focus())
    act(() => region.focus())
    const newest = toastNamed('MM-0150 returned: Source missing.')
    expect(newest).toHaveFocus()
    fireEvent.keyDown(newest, { key: 'Enter' })
    expect(toastNamed('MM-0150 returned: Source missing.')).toBeInTheDocument()
    fireEvent.keyDown(newest, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'MM-0150 returned: Source missing.' })).toBeNull()
    const next = toastNamed('MM-0141 returned: Disk full.')
    expect(next).toHaveFocus()
    fireEvent.keyDown(next, { key: 'Escape' })
    expect(screen.queryAllByRole('group')).toHaveLength(0)
    expect(before).toHaveFocus()
  })

  it('leaves the toast up when an inner control already handled Escape', () =>
  {
    renderRegion()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    const element = toastNamed('MM-0141 returned: Disk full.')
    element.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(element, { key: 'Escape' })
    expect(toastNamed('MM-0141 returned: Disk full.')).toBeInTheDocument()
  })

  it('moves focus to the next toast with the close button', () =>
  {
    const { region } = renderRegion()
    show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    act(() => region.focus())
    const close = screen.getAllByRole('button', { name: 'Dismiss notification' })[1]
    act(() => close.focus())
    fireEvent.click(close)
    expect(toastNamed('MM-0141 returned: Disk full.')).toHaveFocus()
  })

  it.each([false, true])('hands focus on when the focused toast is dismissed elsewhere (reduced motion %s)', (reduce) =>
  {
    reducedMotion = reduce
    const { region } = renderRegion()
    const older = show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    const newer = show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    const before = screen.getByRole('button', { name: 'Before' })
    act(() => before.focus())
    act(() => region.focus())
    act(() => toast.dismiss(newer))
    expect(toastNamed('MM-0141 returned: Disk full.')).toHaveFocus()
    act(() => toast.dismiss(older))
    expect(before).toHaveFocus()
    show({ tone: 'info', title: 'Copied path.' })
    advance(TOAST_INFO_MS)
    expect(screen.queryByRole('group', { name: 'Copied path.' })).toBeNull()
  })

  it('keeps a dismissed toast as an inert, hidden copy until its exit transition ends', () =>
  {
    const { region } = renderRegion()
    const id = show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    fireEvent.transitionEnd(toastNamed('MM-0141 returned: Disk full.'))
    expect(toastNamed('MM-0141 returned: Disk full.')).toBeInTheDocument()
    act(() => toast.dismiss(id))
    const ghost = region.querySelector('[data-leaving]') as HTMLElement
    expect(ghost).toHaveAttribute('aria-hidden', 'true')
    expect(ghost).toHaveAttribute('inert')
    fireEvent.transitionEnd(ghost.querySelector('button') as HTMLElement)
    expect(region.querySelector('[data-leaving]')).not.toBeNull()
    fireEvent.transitionEnd(ghost)
    expect(region.querySelector('[data-leaving]')).toBeNull()
    const next = show({ tone: 'error', title: 'MM-0150 returned: Source missing.' })
    act(() => toast.dismiss(next))
    expect(region.querySelector('[data-leaving]')).not.toBeNull()
    advance(400)
    expect(region.querySelector('[data-leaving]')).toBeNull()
  })

  it('removes a dismissed toast at once under reduced motion', () =>
  {
    reducedMotion = true
    const { region } = renderRegion()
    const id = show({ tone: 'error', title: 'MM-0141 returned: Disk full.' })
    act(() => toast.dismiss(id))
    expect(region.querySelector('[data-toast-id]')).toBeNull()
  })

  it('publishes the band the stack occupies as --toast-stack-size on its parent', () =>
  {
    let notify: (() => void) | undefined
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class
    {
      constructor(callback: () => void)
      {
        notify = callback
      }

      observe = observe
      disconnect = disconnect
    })
    const { region } = renderRegion()
    const main = region.parentElement as HTMLElement
    expect(observe).toHaveBeenCalledWith(region)
    expect(main.style.getPropertyValue('--toast-stack-size')).toBe('0px')
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ height: 119.5 } as DOMRect)
    act(() => notify?.())
    expect(main.style.getPropertyValue('--toast-stack-size')).toBe('136px')
    cleanup()
    expect(disconnect).toHaveBeenCalled()
    expect(main.style.getPropertyValue('--toast-stack-size')).toBe('')
  })

  it('places the stack by its anchor and exposes the region through ref', () =>
  {
    const ref = createRef<HTMLDivElement>()
    const { region } = renderRegion({ anchor: { side: 'end', inset: 24, bottom: 8 }, ref })
    expect(ref.current).toBe(region)
    expect(region.style.insetInlineEnd).toBe('24px')
    expect(region.style.insetBlockEnd).toBe('8px')
    cleanup()
    const fallback = renderRegion()
    expect(fallback.region.style.insetInlineStart).toBe('16px')
    expect(fallback.region.style.insetBlockEnd).toBe('16px')
  })

  it('counts the stack for the F6 cycle and hands out the shared toast functions', () =>
  {
    let api: ToastApi | undefined
    function Probe(): ReactElement
    {
      api = useToast()
      return <output>{useToastCount()}</output>
    }
    render(<Probe />)
    expect(screen.getByRole('status')).toHaveTextContent('0')
    show({ tone: 'info', title: 'Copied path.' })
    show({ tone: 'info', title: 'Copied command.' })
    expect(screen.getByRole('status')).toHaveTextContent('2')
    expect(api).toBe(toast)
  })
})

describe('progress digest', () =>
{
  function BatchView({ enabled, done }: { enabled: boolean, done: number }): ReactElement
  {
    const scope = useRef<HTMLElement>(null)
    useProgressDigest({ enabled, scope, counts: `${done}/50`, text: `${done} of 50 finished. About ${50 - done} min left.` })
    return (
      <section ref={scope}>
        <button type="button">Inside</button>
      </section>
    )
  }

  function Shell({ enabled, done }: { enabled: boolean, done: number }): ReactElement
  {
    return (
      <main>
        <LiveRegion>
          <BatchView enabled={enabled} done={done} />
        </LiveRegion>
        <button type="button">Outside</button>
        <ToastRegion />
      </main>
    )
  }

  it.each([
    { enabled: false, expected: 0 },
    { enabled: true, expected: 1 }
  ])('turns 50 verifications inside one 30 s window into $expected announcements when enabled is $enabled', ({ enabled, expected }) =>
  {
    const { container, rerender } = render(<Shell enabled={enabled} done={0} />)
    const speech = Array.from(container.querySelectorAll('[role="status"], [role="alert"]')).map(recordSpeech)
    act(() => screen.getByRole('button', { name: 'Inside' }).focus())
    const start = Date.now()
    for (let done = 1; done <= 50; done += 1)
    {
      rerender(<Shell enabled={enabled} done={done} />)
      advance(600)
    }
    expect(Date.now() - start).toBe(PROGRESS_DIGEST_MS)
    advance(FRAME_MS)
    const spoken = speech.flat()
    expect(spoken).toHaveLength(expected)
    if (expected > 0)
    {
      expect(spoken[0].text).toBe('50 of 50 finished. About 0 min left.')
      expect(spoken[0].at - start).toBeLessThanOrEqual(PROGRESS_DIGEST_MS + FRAME_MS)
    }
    advance(PROGRESS_DIGEST_MS * 2)
    expect(speech.flat()).toHaveLength(expected)
  })

  it('stays silent while focus is outside the view and speaks once it returns', () =>
  {
    const { container, rerender } = render(<Shell enabled done={0} />)
    const speech = recordSpeech(container.querySelector('[role="status"]') as Element)
    act(() => screen.getByRole('button', { name: 'Outside' }).focus())
    rerender(<Shell enabled done={3} />)
    advance(PROGRESS_DIGEST_MS * 2)
    expect(speech).toHaveLength(0)
    act(() => screen.getByRole('button', { name: 'Inside' }).focus())
    advance(PROGRESS_DIGEST_MS + FRAME_MS)
    expect(speech.map((entry) => entry.text)).toEqual(['3 of 50 finished. About 47 min left.'])
    rerender(<Shell enabled={false} done={4} />)
    advance(PROGRESS_DIGEST_MS * 2)
    expect(speech).toHaveLength(1)
  })

  it('speaks nothing unless enabled, then only changed counts at most once per interval', () =>
  {
    const announce = vi.fn()
    const digest = createProgressDigest({ announce })
    digest.report('0/5', '0 of 5 finished.')
    digest.report('1/5', '1 of 5 finished.')
    advance(PROGRESS_DIGEST_MS * 3)
    expect(announce).not.toHaveBeenCalled()
    digest.setEnabled(true)
    advance(PROGRESS_DIGEST_MS - 1)
    expect(announce).not.toHaveBeenCalled()
    advance(1)
    expect(announce).toHaveBeenCalledWith('1 of 5 finished.')
    digest.report('1/5', '1 of 5 finished. About 2 min left.')
    advance(PROGRESS_DIGEST_MS * 2)
    expect(announce).toHaveBeenCalledTimes(1)
    digest.report('2/5', '2 of 5 finished.')
    digest.report('1/5', '1 of 5 finished.')
    advance(PROGRESS_DIGEST_MS)
    expect(announce).toHaveBeenCalledTimes(1)
    digest.report('3/5', '3 of 5 finished.')
    digest.setEnabled(false)
    advance(PROGRESS_DIGEST_MS * 2)
    expect(announce).toHaveBeenCalledTimes(1)
    digest.setEnabled(true)
    digest.dispose()
    advance(PROGRESS_DIGEST_MS * 2)
    expect(announce).toHaveBeenCalledTimes(1)
  })

  it('checks whether it may speak each time the interval ends', () =>
  {
    const announce = vi.fn()
    let active = false
    const digest = createProgressDigest({ announce, isActive: () => active, intervalMs: 1000 })
    digest.setEnabled(true)
    digest.report('0/2', '0 of 2 finished.')
    digest.report('1/2', '1 of 2 finished.')
    advance(3000)
    expect(announce).not.toHaveBeenCalled()
    active = true
    advance(1000)
    expect(announce).toHaveBeenCalledWith('1 of 2 finished.')
  })
})

describe('toastLifetime', () =>
{
  it('persists errors, gives toasts with actions the warning time, and times the rest by tone', () =>
  {
    const action = { label: 'Undo', onAction: () => undefined }
    expect(toastLifetime({ tone: 'error' })).toBeNull()
    expect(toastLifetime({ tone: 'info', actions: [action] })).toBe(TOAST_WARNING_MS)
    expect(toastLifetime({ tone: 'info', actions: [] })).toBe(TOAST_INFO_MS)
    expect(toastLifetime({ tone: 'success' })).toBe(TOAST_INFO_MS)
    expect(toastLifetime({ tone: 'warning' })).toBe(TOAST_WARNING_MS)
  })
})
