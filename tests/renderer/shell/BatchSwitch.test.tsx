/**
 * The shell's side of the Batch page: one engine subscription from the main window only, a drop outside the page
 * that becomes one jobs:add with the "New files get" recipe and shows Batch, the Batch view without the shell's
 * padding, and the first view chosen from the first engine snapshot.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { AddResult, JobsApi } from '../../../src/shared/jobs/contract'
import type { JobView, RunState } from '../../../src/shared/jobs/types'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { initialJobsState, useJobsStore, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { clearToasts } from '../../../src/renderer/src/ui/Toast'
import App, { addDroppedItems, opensOnBatch, type DropAddDeps } from '../../../src/renderer/src/App'

function StubBatch(): React.JSX.Element
{
  return <section aria-label="Batch page"><button type="button">Start</button></section>
}

function StubView(): React.JSX.Element
{
  return <div />
}

vi.mock('../../../src/renderer/src/hooks/useIPC', () => ({ useIPC: () => undefined }))
vi.mock('../../../src/renderer/src/components/layout', async () =>
{
  const { CloseConfirmModal } = await import('../../../src/renderer/src/components/layout/CloseConfirmModal')
  return { TitleBar: StubView, Sidebar: StubView, CloseConfirmModal }
})
vi.mock('../../../src/renderer/src/components/layout/components/PopoutShell', () => ({ PopoutShell: StubView }))
vi.mock('../../../src/renderer/src/components/dashboard', () => ({ Dashboard: StubView }))
vi.mock('../../../src/renderer/src/components/batch/BatchPage', () => ({ BatchPage: StubBatch }))
vi.mock('../../../src/renderer/src/components/settings', () => ({ Settings: StubView }))
vi.mock('../../../src/renderer/src/components/logs', () => ({ LogViewer: StubView }))
vi.mock('../../../src/renderer/src/components/editor', () => ({ MediaEditor: StubView }))
vi.mock('../../../src/renderer/src/components/player', () => ({ MediaPlayer: StubView }))
vi.mock('../../../src/renderer/src/components/setup', () => ({ SetupWizard: StubView }))

function result(patch: Partial<AddResult> = {}): AddResult
{
  return { added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [], ...patch }
}

function deps(reply: Awaited<ReturnType<JobsApi['add']>>, includeSubfolders = true): DropAddDeps & { calls: string[] }
{
  const calls: string[] = []
  return {
    calls,
    add: vi.fn(async () =>
    {
      calls.push('add')
      return reply
    }),
    includeSubfolders: () => includeSubfolders,
    showBatch: vi.fn(() =>
    {
      calls.push('show')
    }),
    notify: vi.fn()
  }
}

function jobs(states: JobView['state'][]): JobsState['jobs']
{
  return Object.fromEntries(states.map((state, i) => [`j${i}`, { id: `j${i}`, state } as unknown as JobView])) as JobsState['jobs']
}

function snapshot(patch: Partial<JobsState>): JobsState
{
  return { ...initialJobsState(), hydrations: 1, ...patch }
}

const jobsApi = {
  onEvents: vi.fn(() => () => undefined),
  subscribe: vi.fn(() => new Promise(() => undefined)),
  unsubscribe: vi.fn(async () => ({ ok: true, seq: 0, value: null })),
  add: vi.fn(async () => ({ ok: true, seq: 1, value: result({ added: ['j1', 'j2'] }) }))
}

const api = {
  onUpdaterStatus: () => () => undefined,
  getUpdaterStatus: () => Promise.resolve(null),
  getFilePath: (file: File) => `D:\\Media\\${file.name}`,
  showTextContextMenu: vi.fn(),
  onCloseConfirm: () => () => undefined,
  closeConfirmResponse: vi.fn(),
  zoomIn: vi.fn(() => 1),
  zoomOut: vi.fn(() => 1),
  setZoomFactor: vi.fn((factor: number) => factor),
  jobs: jobsApi
}

function drop(names: string[], directories: string[] = []): Event
{
  const files = names.map((name) => new File(['x'], name))
  const items = names.map((name) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: directories.includes(name) }) }))
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, items } })
  act(() =>
  {
    document.body.dispatchEvent(event)
  })
  return event
}

beforeEach(() =>
{
  window.location.hash = ''
  Object.assign(window, { api })
  useAppStore.setState(useAppStore.getInitialState())
  useAppStore.setState({ ffmpegChecking: false, showSetup: false })
  useJobsStore.setState(initialJobsState())
  jobsApi.onEvents.mockClear()
  jobsApi.subscribe.mockClear()
  jobsApi.add.mockClear()
})

afterEach(() =>
{
  cleanup()
  act(() =>
  {
    clearToasts()
  })
  window.location.hash = ''
})

describe('addDroppedItems', () =>
{
  it('ignores a drop with no media file and no folder', async () =>
  {
    const d = deps({ ok: true, seq: 1, value: result() })
    await addDroppedItems([{ path: 'D:\\notes.txt', directory: false }], d)
    expect(d.add).not.toHaveBeenCalled()
    expect(d.showBatch).not.toHaveBeenCalled()
  })

  it('sends every path in one jobs:add with the New files get recipe, then reports what it skipped', async () =>
  {
    const d = deps({ ok: true, seq: 1, value: result({ added: ['j1', 'j2'], refused: [{ path: 'D:\\notes.txt', code: 'not-media', message: 'Not media.' }] }) }, false)
    await addDroppedItems([{ path: 'D:\\a.mkv', directory: false }, { path: 'D:\\b.flac', directory: false }, { path: 'D:\\notes.txt', directory: false }], d)
    expect(d.add).toHaveBeenCalledWith({
      paths: ['D:\\a.mkv', 'D:\\b.flac', 'D:\\notes.txt'],
      recipe: null,
      origin: 'drop',
      after: null,
      recursive: false,
      allowSecondJobs: false,
      force: false
    })
    expect(d.calls).toEqual(['show', 'add'])
    expect(d.notify).toHaveBeenCalledWith({ tone: 'success', title: 'Added 2 files.', body: 'Skipped 1 that is not media.' })
  })

  it('takes a folder and leaves its scan to report on the Batch page', async () =>
  {
    const d = deps({ ok: true, seq: 1, value: result({ scanIds: ['s1'] }) })
    await addDroppedItems([{ path: 'D:\\Media\\Season.01', directory: true }], d)
    expect(d.add).toHaveBeenCalledWith(expect.objectContaining({ paths: ['D:\\Media\\Season.01'], recursive: true }))
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('says so when nothing was added', async () =>
  {
    const d = deps({ ok: true, seq: 1, value: result({ duplicates: { paths: ['D:\\a.mkv'], jobIds: ['j1'] } }) })
    await addDroppedItems([{ path: 'D:\\a.mkv', directory: false }], d)
    expect(d.notify).toHaveBeenCalledWith({ tone: 'warning', title: 'No files were added.', body: 'Skipped 1 already in the queue.' })
  })

  it('shows the refusal', async () =>
  {
    const d = deps({ ok: false, error: { code: 'queue-full', message: 'The queue is full.' } } as Awaited<ReturnType<JobsApi['add']>>)
    await addDroppedItems([{ path: 'D:\\a.mkv', directory: false }], d)
    expect(d.notify).toHaveBeenCalledWith({ tone: 'error', title: 'The queue is full.' })
  })
})

describe('opensOnBatch', () =>
{
  it('opens on Batch while a batch is in progress or jobs wait', () =>
  {
    expect(opensOnBatch(snapshot({ run: { status: 'running' } as RunState }))).toBe(true)
    expect(opensOnBatch(snapshot({ run: { status: 'paused' } as RunState }))).toBe(true)
    expect(opensOnBatch(snapshot({ jobs: jobs(['done', 'queued']) }))).toBe(true)
    expect(opensOnBatch(snapshot({ jobs: jobs(['pending']) }))).toBe(true)
  })

  it('opens on the Dashboard with no batch and nothing waiting', () =>
  {
    expect(opensOnBatch(snapshot({}))).toBe(false)
    expect(opensOnBatch(snapshot({ run: { status: 'idle' } as RunState, jobs: jobs(['done', 'failed']) }))).toBe(false)
  })
})

describe('App and the job engine', () =>
{
  it('subscribes once from the main window', () =>
  {
    render(<App />)
    expect(jobsApi.onEvents).toHaveBeenCalledTimes(1)
    expect(jobsApi.subscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps the popout off the engine and out of the batch', () =>
  {
    window.location.hash = '#popout'
    render(<App />)
    expect(jobsApi.onEvents).not.toHaveBeenCalled()
    expect(jobsApi.subscribe).not.toHaveBeenCalled()
    drop(['a.mkv'])
    expect(jobsApi.add).not.toHaveBeenCalled()
  })

  it('subscribes while the first-run setup shows', () =>
  {
    useAppStore.setState({ showSetup: true })
    render(<App />)
    expect(jobsApi.subscribe).toHaveBeenCalledTimes(1)
  })

  it('adds a drop outside the Batch page and shows Batch', async () =>
  {
    render(<App />)
    const event = drop(['a.mkv', 'b.flac'])
    expect(event.defaultPrevented).toBe(true)
    await act(async () =>
    {
      await Promise.resolve()
    })
    expect(jobsApi.add).toHaveBeenCalledWith(expect.objectContaining({ paths: ['D:\\Media\\a.mkv', 'D:\\Media\\b.flac'], recipe: null, origin: 'drop' }))
    expect(useAppStore.getState().currentView).toBe('batch')
    expect(await screen.findByText('Added 2 files.')).toBeTruthy()
  })

  it('leaves a drop that a view already took', () =>
  {
    render(<App />)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'a.mkv')], items: [] } })
    event.preventDefault()
    act(() =>
    {
      document.body.dispatchEvent(event)
    })
    expect(jobsApi.add).not.toHaveBeenCalled()
    expect(useAppStore.getState().currentView).toBe('dashboard')
  })

  it('draws the Batch view to the window edges', () =>
  {
    useAppStore.setState({ currentView: 'batch' })
    render(<App />)
    const frame = screen.getByRole('region', { name: 'Batch page' }).parentElement as HTMLElement
    expect(frame.className).not.toMatch(/\bp-3\b|\bpl-3\b/)
    expect(frame.style.display).toBe('flex')
  })

  it('opens on Batch when the first snapshot holds a running batch', () =>
  {
    render(<App />)
    expect(useAppStore.getState().currentView).toBe('dashboard')
    act(() =>
    {
      useJobsStore.setState({ hydrations: 1, run: { status: 'running' } as RunState })
    })
    expect(useAppStore.getState().currentView).toBe('batch')
    expect(useAppStore.getState().viewHistory).toEqual([])
  })

  it('stays on the Dashboard when nothing waits, and decides only once', () =>
  {
    render(<App />)
    act(() =>
    {
      useJobsStore.setState({ hydrations: 1 })
    })
    act(() =>
    {
      useJobsStore.setState({ hydrations: 2, jobs: jobs(['queued']) })
    })
    expect(useAppStore.getState().currentView).toBe('dashboard')
  })

  it('leaves a view the user chose before the snapshot', () =>
  {
    render(<App />)
    act(() =>
    {
      useAppStore.getState().setView('settings')
    })
    act(() =>
    {
      useJobsStore.setState({ hydrations: 1, jobs: jobs(['queued']) })
    })
    expect(useAppStore.getState().currentView).toBe('settings')
  })

  it('decides at mount when the store is already hydrated', () =>
  {
    useJobsStore.setState(snapshot({ jobs: jobs(['queued']) }))
    render(<App />)
    expect(useAppStore.getState().currentView).toBe('batch')
  })
})
