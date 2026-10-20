import React, { useRef, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { OVERLAY_THUMB_MIN, OverlayScrollbar, scrollForDrag, thumbGeometry } from '../../../src/renderer/src/ui/OverlayScrollbar'

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
})

describe('thumbGeometry', () =>
{
  it('returns null while the content fits or there is no track', () =>
  {
    expect(thumbGeometry(400, 400, 0, 368)).toBeNull()
    expect(thumbGeometry(400, 401, 0, 368)).toBeNull()
    expect(thumbGeometry(400, 800, 0, 0)).toBeNull()
  })

  it('sizes the thumb by the visible share and places it by the scroll progress', () =>
  {
    expect(thumbGeometry(400, 800, 0, 400)).toEqual({ size: 200, offset: 0 })
    expect(thumbGeometry(400, 800, 200, 400)).toEqual({ size: 200, offset: 100 })
    expect(thumbGeometry(400, 800, 400, 400)).toEqual({ size: 200, offset: 200 })
  })

  it('keeps a catchable thumb on long content and clamps an overscrolled position', () =>
  {
    expect(thumbGeometry(400, 100_000, 0, 400)?.size).toBe(OVERLAY_THUMB_MIN)
    expect(thumbGeometry(400, 800, 900, 400)).toEqual({ size: 200, offset: 200 })
    expect(thumbGeometry(400, 800, -50, 400)).toEqual({ size: 200, offset: 0 })
    expect(thumbGeometry(400, 800, 0, 20)?.size).toBe(20)
  })
})

describe('scrollForDrag', () =>
{
  it('maps thumb travel onto the scroll range and clamps at both ends', () =>
  {
    expect(scrollForDrag(0, 100, 400, 800, 400, 200)).toBe(200)
    expect(scrollForDrag(200, 500, 400, 800, 400, 200)).toBe(400)
    expect(scrollForDrag(200, -500, 400, 800, 400, 200)).toBe(0)
  })

  it('stays put when the thumb fills the track or nothing scrolls', () =>
  {
    expect(scrollForDrag(30, 100, 400, 800, 200, 200)).toBe(30)
    expect(scrollForDrag(30, 100, 400, 400, 400, 200)).toBe(30)
  })
})

interface Box
{
  clientHeight: number
  scrollHeight: number
}

function Harness({ box, inset = 0 }: { box: Box, inset?: number }): ReactElement
{
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div>
      <div
        data-testid="scroller"
        ref={(node) =>
        {
          ref.current = node
          if (node)
          {
            Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => box.clientHeight })
            Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => box.scrollHeight })
          }
        }}
      >
        <div />
      </div>
      <OverlayScrollbar target={ref} insetStart={inset} className="extra" />
    </div>
  )
}

function thumb(container: HTMLElement): HTMLElement | null
{
  return container.querySelector<HTMLElement>('.ui-overlay-thumb')
}

async function nextFrame(): Promise<void>
{
  await act(async () => await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
}

describe('OverlayScrollbar', () =>
{
  it('draws nothing while the content fits', () =>
  {
    const { container } = render(<Harness box={{ clientHeight: 400, scrollHeight: 400 }} />)
    expect(thumb(container)).toBeNull()
  })

  it('draws a hidden bar below the inset with a thumb that follows the scroll', async () =>
  {
    const { container, getByTestId } = render(<Harness box={{ clientHeight: 432, scrollHeight: 864 }} inset={32} />)
    const bar = container.querySelector('.ui-overlay-bar') as HTMLElement
    expect(bar).toHaveAttribute('aria-hidden', 'true')
    expect(bar).toHaveClass('extra')
    expect(bar.style.insetBlockStart).toBe('32px')
    expect(thumb(container)?.style.blockSize).toBe('200px')
    const scroller = getByTestId('scroller')
    scroller.scrollTop = 216
    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    await nextFrame()
    expect(thumb(container)?.style.transform).toBe('translateY(100px)')
  })

  it('scrolls its target while the thumb is dragged and lights the bar until release', () =>
  {
    const { container, getByTestId } = render(<Harness box={{ clientHeight: 400, scrollHeight: 800 }} />)
    const scroller = getByTestId('scroller')
    const element = thumb(container) as HTMLElement
    fireEvent.pointerDown(element, { button: 2, pointerId: 1, clientY: 10 })
    expect(container.querySelector('.ui-overlay-bar')).not.toHaveAttribute('data-dragging')
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 60 })
    expect(scroller.scrollTop).toBe(0)
    fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientY: 10 })
    expect(container.querySelector('.ui-overlay-bar')).toHaveAttribute('data-dragging')
    fireEvent.pointerMove(element, { pointerId: 2, clientY: 60 })
    expect(scroller.scrollTop).toBe(0)
    fireEvent.pointerMove(element, { pointerId: 1, clientY: 60 })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.pointerUp(element, { pointerId: 2 })
    expect(container.querySelector('.ui-overlay-bar')).toHaveAttribute('data-dragging')
    fireEvent.pointerUp(element, { pointerId: 1 })
    expect(container.querySelector('.ui-overlay-bar')).not.toHaveAttribute('data-dragging')
  })

  it('remeasures when the observed content resizes and stops listening on unmount', async () =>
  {
    const observed: Element[] = []
    const callbacks: ResizeObserverCallback[] = []
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class
    {
      constructor(callback: ResizeObserverCallback)
      {
        callbacks.push(callback)
      }

      observe(element: Element): void
      {
        observed.push(element)
      }

      disconnect(): void
      {
        disconnect()
      }
    })
    const box = { clientHeight: 400, scrollHeight: 400 }
    const { container, unmount } = render(<Harness box={box} />)
    expect(observed).toHaveLength(2)
    expect(thumb(container)).toBeNull()
    box.scrollHeight = 1600
    act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)))
    await nextFrame()
    expect(thumb(container)?.style.blockSize).toBe('100px')
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
