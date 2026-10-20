/**
 * LiveRegion and useAnnounce: one polite region per view, empty at mount; an announcement lands on the next
 * frame after the region is cleared, so a repeated message is spoken again; messages within 500 ms of
 * the last one spoken coalesce to the last; unmounting cancels anything pending. Also covers the frame
 * scheduler the region uses.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { LiveRegion, useAnnounce, ANNOUNCE_COALESCE_MS, type Announce } from '../../../src/renderer/src/ui/LiveRegion'
import { nextFrame } from '../../../src/renderer/src/ui/platform'

let announce: Announce = () => {}

function Capture(): null
{
  announce = useAnnounce()
  return null
}

function renderRegion(): { region: HTMLElement, unmount: () => void }
{
  const { unmount } = render(
    <LiveRegion>
      <p>Batch view</p>
      <Capture />
    </LiveRegion>
  )
  return { region: screen.getByRole('status'), unmount }
}

/** Every text the region was given, in order, read from mutation records. */
function spokenTexts(records: MutationRecord[]): string[]
{
  return records.flatMap((record) => [...record.addedNodes].map((node) => node.textContent ?? ''))
}

describe('LiveRegion', () =>
{
  beforeEach(() =>
  {
    vi.useFakeTimers()
  })

  afterEach(() =>
  {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
    announce = () => {}
  })

  it('renders one polite, atomic, visually hidden status region, empty at mount, beside the view', () =>
  {
    const { region } = renderRegion()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
    expect(region).toBeEmptyDOMElement()
    expect(region.className.split(/\s+/)).toEqual(expect.arrayContaining(['sr-only', 'select-none']))
    expect(screen.getByText('Batch view')).toBeInTheDocument()
  })

  it('sets the text on the next frame', () =>
  {
    const { region } = renderRegion()
    announce('Sorted by File, ascending.')
    expect(region).toBeEmptyDOMElement()
    vi.advanceTimersByTime(20)
    expect(region).toHaveTextContent('Sorted by File, ascending.')
  })

  it('clears and sets a repeated message, so it is spoken again', () =>
  {
    const { region } = renderRegion()
    const observer = new MutationObserver(() => {})
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    announce('3 jobs selected.')
    vi.advanceTimersByTime(20)
    vi.advanceTimersByTime(ANNOUNCE_COALESCE_MS + 100)
    announce('3 jobs selected.')
    expect(region).toBeEmptyDOMElement()
    vi.advanceTimersByTime(20)
    expect(region).toHaveTextContent('3 jobs selected.')
    expect(spokenTexts(observer.takeRecords())).toEqual(['3 jobs selected.', '3 jobs selected.'])
    observer.disconnect()
  })

  it('speaks only the last of several messages sent before the frame', () =>
  {
    const { region } = renderRegion()
    const observer = new MutationObserver(() => {})
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    announce('Sorted by File, ascending.')
    announce('MM-0141 moved to position 3 of 12.')
    vi.advanceTimersByTime(20)
    expect(region).toHaveTextContent('MM-0141 moved to position 3 of 12.')
    expect(spokenTexts(observer.takeRecords())).toEqual(['MM-0141 moved to position 3 of 12.'])
    observer.disconnect()
  })

  it('holds messages that follow within 500 ms and speaks only the last of them', () =>
  {
    const { region } = renderRegion()
    const observer = new MutationObserver(() => {})
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    announce('Batch 31 paused.')
    vi.advanceTimersByTime(20)
    vi.advanceTimersByTime(100)
    announce('Batch 31 resumed.')
    expect(region).toBeEmptyDOMElement()
    vi.advanceTimersByTime(100)
    announce('Pausing Batch 31. 3 running jobs finish first.')
    vi.advanceTimersByTime(200)
    expect(region).toBeEmptyDOMElement()
    vi.advanceTimersByTime(200)
    expect(region).toHaveTextContent('Pausing Batch 31. 3 running jobs finish first.')
    expect(spokenTexts(observer.takeRecords())).toEqual(['Batch 31 paused.', 'Pausing Batch 31. 3 running jobs finish first.'])
    observer.disconnect()
  })

  it('cancels a pending frame on unmount', () =>
  {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { unmount } = renderRegion()
    announce('Back to queue order.')
    unmount()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(() => vi.advanceTimersByTime(100)).not.toThrow()
  })

  it('drops a held message on unmount and ignores announcements after it', () =>
  {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    const { unmount } = renderRegion()
    announce('Batch 31 paused.')
    vi.advanceTimersByTime(20)
    announce('Batch 31 resumed.')
    expect(frame).toHaveBeenCalledTimes(1)
    unmount()
    vi.advanceTimersByTime(ANNOUNCE_COALESCE_MS * 2)
    expect(frame).toHaveBeenCalledTimes(1)
    const stale = announce
    expect(() => stale('Batch 31 finished.')).not.toThrow()
    vi.advanceTimersByTime(100)
    expect(frame).toHaveBeenCalledTimes(1)
  })

  it('does nothing outside a region', () =>
  {
    render(<Capture />)
    expect(() => announce('Nobody hears this.')).not.toThrow()
    vi.advanceTimersByTime(100)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('nextFrame', () =>
{
  beforeEach(() =>
  {
    vi.useFakeTimers()
  })

  afterEach(() =>
  {
    vi.useRealTimers()
  })

  it('runs a callback on the next animation frame', () =>
  {
    const callback = vi.fn()
    nextFrame(callback)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('returns a cancel function that stops the callback', () =>
  {
    const callback = vi.fn()
    const cancel = nextFrame(callback)
    cancel()
    vi.advanceTimersByTime(20)
    expect(callback).not.toHaveBeenCalled()
  })
})
