/**
 * The development Batch mount: the remembered mode, the window's one preview engine, the new page kept in sync with
 * that engine, and the strip that switches to the previous view and back.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { JobsApi } from '../../../src/shared/jobs/contract'
import { BATCH_VIEW_ID, resetPageSession } from '../../../src/renderer/src/components/batch/BatchPage'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { useBatchView } from '../../../src/renderer/src/stores/batchView'
import { initialJobsState, useJobsStore } from '../../../src/renderer/src/stores/jobs'
import { clearToasts } from '../../../src/renderer/src/ui/Toast'
import { createPreviewJobsApi, type PreviewClock } from '../../../src/renderer/src/dev/previewJobs'
import { PREVIEW_SAMPLES } from '../../../src/renderer/src/dev/previewMedia'
import
{
  PREVIEW_MODE_KEY,
  PreviewBatch,
  previewJobsApi,
  readPreviewMode,
  resetPreviewJobsApi,
  writePreviewMode
} from '../../../src/renderer/src/dev/PreviewBatch'

vi.mock('../../../src/renderer/src/components/batch', () => ({ FileQueue: () => <div data-testid="file-queue">Old queue</div> }))

/** A clock that runs nothing until the test advances it. */
function manualClock(): PreviewClock & { advance: (ms: number) => void }
{
  let now = Date.UTC(2026, 9, 19, 9, 0)
  let timers: { at: number; fn: () => void }[] = []
  return {
    now: () => now,
    schedule: (fn, ms) =>
    {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () =>
      {
        timers = timers.filter((entry) => entry !== timer)
      }
    },
    advance: (ms) =>
    {
      now += ms
      const due = timers.filter((entry) => entry.at <= now)
      timers = timers.filter((entry) => entry.at > now)
      due.forEach((entry) => entry.fn())
    }
  }
}

/** An in-memory Storage. */
function memoryStorage(initial: Record<string, string> = {}): Storage
{
  const items = new Map(Object.entries(initial))
  return {
    get length()
    {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) =>
    {
      items.delete(key)
    },
    setItem: (key, value) =>
    {
      items.set(key, value)
    }
  }
}

/** A Storage whose every call throws, as a blocked origin's does. */
function blockedStorage(): Storage
{
  const refuse = (): never =>
  {
    throw new Error('blocked')
  }
  return { length: 0, clear: refuse, getItem: refuse, key: refuse, removeItem: refuse, setItem: refuse }
}

function previewApi(): JobsApi
{
  return createPreviewJobsApi({ clock: manualClock() })
}

beforeEach(() =>
{
  resetPageSession()
  resetPreviewJobsApi()
  clearToasts()
  useJobsStore.setState(initialJobsState(), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
  useAppStore.setState({ currentView: 'batch', viewHistory: [], logFilter: null, config: null })
  vi.stubGlobal('api', undefined)
  vi.stubGlobal('ResizeObserver', class
  {
    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  })
})

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
})

describe('remembered mode', () =>
{
  it('defaults to the new page and reads back only a stored old view', () =>
  {
    expect(readPreviewMode(memoryStorage())).toBe('page')
    expect(readPreviewMode(memoryStorage({ [PREVIEW_MODE_KEY]: 'legacy' }))).toBe('legacy')
    expect(readPreviewMode(memoryStorage({ [PREVIEW_MODE_KEY]: 'sideways' }))).toBe('page')
    expect(readPreviewMode(null)).toBe('page')
  })

  it('treats a storage that throws as empty and keeps the choice for the session', () =>
  {
    expect(readPreviewMode(blockedStorage())).toBe('page')
    expect(() => writePreviewMode('legacy', blockedStorage())).not.toThrow()
    expect(() => writePreviewMode('legacy', null)).not.toThrow()
  })

  it('writes the chosen mode under its key', () =>
  {
    const storage = memoryStorage()
    writePreviewMode('legacy', storage)
    expect(storage.getItem(PREVIEW_MODE_KEY)).toBe('legacy')
    writePreviewMode('page', storage)
    expect(readPreviewMode(storage)).toBe('page')
  })

  it('uses the window localStorage by default', () =>
  {
    window.localStorage.removeItem(PREVIEW_MODE_KEY)
    writePreviewMode('legacy')
    expect(readPreviewMode()).toBe('legacy')
    window.localStorage.removeItem(PREVIEW_MODE_KEY)
    expect(readPreviewMode()).toBe('page')
  })
})

describe('window preview engine', () =>
{
  it('creates one engine per window until reset', () =>
  {
    const first = previewJobsApi()
    expect(previewJobsApi()).toBe(first)
    resetPreviewJobsApi()
    expect(previewJobsApi()).not.toBe(first)
  })
})

describe('PreviewBatch', () =>
{
  it('shows the new page on the preview engine and fills the jobs store with the samples', async () =>
  {
    const api = previewApi()
    render(<PreviewBatch api={api} storage={memoryStorage()} />)
    expect(document.getElementById(BATCH_VIEW_ID)).not.toBeNull()
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'New page' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/no file is read or written/)).toBeInTheDocument()
    await waitFor(() => expect(useJobsStore.getState().order).toHaveLength(PREVIEW_SAMPLES.length))
    expect(screen.queryByTestId('file-queue')).toBeNull()
  })

  it('switches to the old view, remembers it, and stops syncing until the new page returns', async () =>
  {
    const api = previewApi()
    const unsubscribe = vi.spyOn(api, 'unsubscribe')
    const storage = memoryStorage()
    render(<PreviewBatch api={api} storage={storage} />)
    await waitFor(() => expect(useJobsStore.getState().order).toHaveLength(PREVIEW_SAMPLES.length))
    act(() => fireEvent.click(screen.getByRole('radio', { name: 'Old view' })))
    expect(screen.getByTestId('file-queue')).toBeInTheDocument()
    expect(document.getElementById(BATCH_VIEW_ID)).toBeNull()
    expect(storage.getItem(PREVIEW_MODE_KEY)).toBe('legacy')
    expect(unsubscribe).toHaveBeenCalled()
    expect(screen.getByText('The previous Batch view on the real engine.')).toBeInTheDocument()
    act(() => fireEvent.click(screen.getByRole('radio', { name: 'New page' })))
    expect(document.getElementById(BATCH_VIEW_ID)).not.toBeNull()
    expect(storage.getItem(PREVIEW_MODE_KEY)).toBe('page')
  })

  it('opens on the remembered old view without subscribing to the preview', () =>
  {
    const api = previewApi()
    const subscribe = vi.spyOn(api, 'subscribe')
    render(<PreviewBatch api={api} storage={memoryStorage({ [PREVIEW_MODE_KEY]: 'legacy' })} />)
    expect(screen.getByTestId('file-queue')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Old view' })).toHaveAttribute('aria-checked', 'true')
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('runs on the window engine when no api is passed', async () =>
  {
    render(<PreviewBatch storage={memoryStorage()} />)
    await waitFor(() => expect(useJobsStore.getState().order).toHaveLength(PREVIEW_SAMPLES.length))
  })
})
