/**
 * The title bar: the molexMedia wordmark, the engine's run state as a still glyph and a word, and the
 * caption IconButtons (Minimize, Maximize or Restore, Close) with inset focus and the error-fill Close.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import TitleBar, { readMaximized, RUN_STATE_LOOKS, runStateLook } from '../../../src/renderer/src/components/layout/TitleBar'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import type { RunState } from '../../../src/shared/jobs/types'

const api = {
  windowMinimize: vi.fn(),
  windowMaximize: vi.fn(),
  windowClose: vi.fn()
}

function setRun(status: RunState['status'] | null): void
{
  useJobsStore.setState({ run: status === null ? null : ({ status, progress: { percent: 10 } } as unknown as RunState) })
}

function setWindow(outerWidth: number, outerHeight: number, availWidth = 1920, availHeight = 1040): void
{
  Object.defineProperty(window, 'outerWidth', { configurable: true, value: outerWidth })
  Object.defineProperty(window, 'outerHeight', { configurable: true, value: outerHeight })
  Object.defineProperty(window.screen, 'availWidth', { configurable: true, value: availWidth })
  Object.defineProperty(window.screen, 'availHeight', { configurable: true, value: availHeight })
}

beforeEach(() =>
{
  useJobsStore.setState(initialJobsState(), true)
  ;(window as unknown as { api: unknown }).api = api
  Object.values(api).forEach((fn) => fn.mockClear())
  setWindow(1200, 800)
})

afterEach(() =>
{
  cleanup()
})

describe('run state words', () =>
{
  it('shows nothing while idle and a word for every open state', () =>
  {
    expect(runStateLook('idle')).toBeNull()
    expect(runStateLook('running')?.word).toBe('Batch running')
    expect(runStateLook('pausing')?.word).toBe('Batch pausing')
    expect(runStateLook('paused')?.word).toBe('Batch paused')
    expect(runStateLook('canceling')?.word).toBe('Batch stopping')
  })

  it('uses still glyphs only, never the spinning loader', () =>
  {
    for (const look of Object.values(RUN_STATE_LOOKS))
    {
      expect(look.icon).not.toBe('status.active')
    }
  })
})

describe('readMaximized', () =>
{
  it('is true when the window fills the work area', () =>
  {
    expect(readMaximized({ outerWidth: 1920, outerHeight: 1040, screen: { availWidth: 1920, availHeight: 1040 } as Screen })).toBe(true)
    expect(readMaximized({ outerWidth: 1936, outerHeight: 1056, screen: { availWidth: 1920, availHeight: 1040 } as Screen })).toBe(true)
  })

  it('is false for a smaller window or an unknown screen', () =>
  {
    expect(readMaximized({ outerWidth: 1200, outerHeight: 1040, screen: { availWidth: 1920, availHeight: 1040 } as Screen })).toBe(false)
    expect(readMaximized({ outerWidth: 0, outerHeight: 0, screen: { availWidth: 0, availHeight: 0 } as Screen })).toBe(false)
  })
})

describe('TitleBar', () =>
{
  it('writes the molexMedia wordmark with Media in walnut ink and the version', () =>
  {
    render(<TitleBar />)
    const header = screen.getByRole('banner')
    expect(header.textContent).toContain('molexMedia')
    expect(header.textContent).toContain('0.0.0-test')
    const media = screen.getByText('Media')
    expect(media.className).toContain('text-walnut-ink')
    expect(media.parentElement?.className).toContain('text-ink')
    expect(header.className).toContain('drag-region')
    expect(header.className).toContain('bg-rail')
    expect(header.className).toContain('border-rail-edge')
  })

  it('renders the caption buttons as named IconButtons with inset focus', () =>
  {
    render(<TitleBar />)
    const names = ['Minimize', 'Maximize', 'Close']
    for (const name of names)
    {
      const button = screen.getByRole('button', { name })
      expect(button.getAttribute('data-size')).toBe('caption')
      expect(button.getAttribute('data-focus')).toBe('inset')
      expect(button.classList.contains('ui-icon-button')).toBe(true)
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.className).toContain('hover:bg-error-fill')
    expect(close.querySelector('svg')?.getAttribute('data-icon')).toBe('window.close')
    expect(screen.getByRole('button', { name: 'Minimize' }).querySelector('svg')?.getAttribute('data-icon')).toBe('window.minimize')
    expect(screen.getByRole('button', { name: 'Maximize' }).querySelector('svg')?.getAttribute('data-icon')).toBe('window.maximize')
    expect(close.parentElement?.className).toContain('no-drag')
  })

  it('calls the window controls', () =>
  {
    render(<TitleBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.windowMinimize).toHaveBeenCalledTimes(1)
    expect(api.windowMaximize).toHaveBeenCalledTimes(1)
    expect(api.windowClose).toHaveBeenCalledTimes(1)
  })

  it('names the middle button Restore while maximized and follows resizes', () =>
  {
    setWindow(1920, 1040)
    render(<TitleBar />)
    const restore = screen.getByRole('button', { name: 'Restore' })
    expect(restore.querySelector('svg')?.getAttribute('data-icon')).toBe('window.restore')
    act(() =>
    {
      setWindow(1000, 700)
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('shows no run state while the engine is idle', () =>
  {
    setRun(null)
    render(<TitleBar />)
    expect(document.querySelector('[data-run-status]')).toBeNull()
    act(() => setRun('idle'))
    expect(document.querySelector('[data-run-status]')).toBeNull()
  })

  it('shows the engine run state as a word with a still glyph', () =>
  {
    setRun('running')
    render(<TitleBar />)
    const label = document.querySelector('[data-run-status="running"]') as HTMLElement
    expect(label.textContent).toBe('Batch running')
    expect(label.className).toContain('text-running')
    const glyph = label.querySelector('svg') as SVGElement
    expect(glyph.getAttribute('data-icon')).toBe('action.start')
    expect(glyph.getAttribute('class') ?? '').not.toContain('animate-spin')
    const classes = [label, ...label.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').join(' ')
    expect(classes).not.toMatch(/animate-|shadow-|transition/)

    act(() => setRun('paused'))
    expect(document.querySelector('[data-run-status="paused"]')?.textContent).toBe('Batch paused')
    act(() => setRun('canceling'))
    expect(document.querySelector('[data-run-status="canceling"]')?.textContent).toBe('Batch stopping')
    act(() => setRun('pausing'))
    expect(document.querySelector('[data-run-status="pausing"]')?.textContent).toBe('Batch pausing')
  })

  it('reads the run state from the job engine, not the legacy processing flags', () =>
  {
    render(<TitleBar />)
    expect(screen.queryByText('Processing')).toBeNull()
    expect(screen.queryByText('Paused')).toBeNull()
  })
})
