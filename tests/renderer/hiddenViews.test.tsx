/**
 * The shell keeps every view mounted and hides the ones not shown. No keyboard handler of a hidden view may act:
 * the editor timeline's keys never fire from Batch, and Batch keys never fire from the editor.
 */
import React, { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLoudnessPreset } from '../../src/shared/audio/presets'
import type { JobsApi } from '../../src/shared/jobs/contract'
import { formatRunId, type JobId } from '../../src/shared/jobs/ids'
import type { Recipe } from '../../src/shared/jobs/recipes'
import type { BatchPolicy, JobView, RunState } from '../../src/shared/jobs/types'
import { inertJobsApi } from '../../src/renderer/src/components/batch/BatchActionsContext'
import { BATCH_VIEW_ID, BatchPage, resetPageSession } from '../../src/renderer/src/components/batch/BatchPage'
import { IDLE_RUN } from '../../src/renderer/src/components/batch/page/InspectorPanel'
import { useBatchKeys, type BatchKeyFacts } from '../../src/renderer/src/components/batch/page/useBatchKeys'
import { useTimelineKeyboard } from '../../src/renderer/src/components/editor/hooks/useTimelineKeyboard'
import type { TimelineCoords } from '../../src/renderer/src/components/editor/hooks/useTimelineZoom'
import { useAppStore } from '../../src/renderer/src/stores/appStore'
import { useBatchView } from '../../src/renderer/src/stores/batchView'
import { useEditorStore } from '../../src/renderer/src/stores/editorStore'
import { initialJobsState, useJobsStore, type JobsState } from '../../src/renderer/src/stores/jobs'
import type { View } from '../../src/renderer/src/stores/types'
import { clearToasts } from '../../src/renderer/src/ui/Toast'

const AT = new Date(2026, 9, 16, 13, 40).getTime()
const RECIPE = applyLoudnessPreset('streaming-r128s2', { kind: 'same-as-source' }) as Recipe
const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' }

/** The keys a hidden view must never act on. */
const KEYS: Array<[string, KeyboardEventInit]> = [
  ['Space', { key: ' ', code: 'Space' }],
  ['Delete', { key: 'Delete', code: 'Delete' }],
  ['Backspace', { key: 'Backspace', code: 'Backspace' }],
  ['Ctrl+A', { key: 'a', code: 'KeyA', ctrlKey: true }],
  ['Ctrl+Z', { key: 'z', code: 'KeyZ', ctrlKey: true }],
  ['Ctrl+Shift+Z', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }],
  ['Ctrl+P', { key: 'p', code: 'KeyP', ctrlKey: true }],
  ...Array.from({ length: 9 }, (_, index): [string, KeyboardEventInit] => [`Alt+${index + 1}`, { key: String(index + 1), code: `Digit${index + 1}`, altKey: true }]),
  ['Alt+Shift+1', { key: '!', code: 'Digit1', altKey: true, shiftKey: true }]
]

function job(index: number, over: Partial<JobView> = {}): JobView
{
  const id = `MM-${String(index).padStart(4, '0')}` as JobId
  return {
    id,
    seq: index,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.wav`, name: `${id}.wav`, ext: 'wav', dir: 'D:\\Rips', size: 498_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE,
    recipeLabel: 'Normalize · Streaming (EBU R 128 s2)',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: { container: 'wav', durationSec: 3730, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false },
    probe: 'ok',
    plan: null,
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function hydrated(jobs: readonly JobView[], run: RunState): JobsState
{
  return {
    ...initialJobsState(),
    seq: 1,
    status: 'hydrated',
    hydrations: 1,
    policy: POLICY,
    defaultRecipe: RECIPE,
    run,
    order: jobs.map((entry) => entry.id),
    jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])) as JobsState['jobs']
  }
}

/** Every engine command the page could send, recorded by name. */
function recordingApi(): { api: JobsApi; sent: string[] }
{
  const sent: string[] = []
  const base = inertJobsApi() as unknown as Record<string, unknown>
  const api = Object.fromEntries(Object.entries(base).map(([name, value]) => [
    name,
    typeof value === 'function'
      ? (...args: unknown[]) =>
        {
          sent.push(name)
          return (value as (...input: unknown[]) => unknown)(...args)
        }
      : value
  ])) as unknown as JobsApi
  return { api, sent }
}

const COORDS = {
  zoom: 1,
  scrollX: 0,
  scrollY: 0,
  frameRate: 30,
  frameToPixel: (frame: number) => frame,
  pixelToFrame: (pixels: number) => pixels,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitToView: vi.fn()
} as unknown as TimelineCoords

/** The editor's timeline with its real keyboard hook. */
function EditorTimeline(): React.JSX.Element
{
  useTimelineKeyboard({ coords: COORDS })
  return <div role="application" aria-label="Timeline" tabIndex={0}>Timeline</div>
}

/** The shell's work area: every view stays mounted, and the ones not shown are styled out. */
function Shell({ api }: { api: JobsApi }): React.JSX.Element
{
  const current = useAppStore((state) => state.currentView)
  const shown = (view: View): React.CSSProperties => ({ display: current === view ? 'flex' : 'none' })
  return (
    <main>
      <div data-view="editor" style={shown('editor')}><EditorTimeline /></div>
      <div data-view="batch" style={shown('batch')}><BatchPage api={api} platform="win32" /></div>
    </main>
  )
}

function stubResizeObserver(): void
{
  vi.stubGlobal('ResizeObserver', class
  {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
}

const editorSpies = {
  togglePlayback: vi.fn(),
  setActiveTool: vi.fn(),
  removeClips: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  copyClips: vi.fn(),
  pasteClips: vi.fn(),
  clearSelection: vi.fn()
}

async function settle(): Promise<void>
{
  await act(async () =>
  {
    for (let index = 0; index < 6; index += 1)
    {
      await Promise.resolve()
    }
  })
}

/** Dispatches a key and reports whether any handler prevented it. */
function press(target: Element, init: KeyboardEventInit): boolean
{
  return !fireEvent.keyDown(target, init)
}

beforeEach(() =>
{
  resetPageSession()
  clearToasts()
  stubResizeObserver()
  vi.stubGlobal('api', undefined)
  for (const spy of Object.values(editorSpies))
  {
    spy.mockClear()
  }
  useEditorStore.setState({ mode: 'edit', selectedClipIds: ['clip-1'], ...editorSpies })
  const jobs = [job(1), job(2), job(3)]
  useJobsStore.setState(hydrated(jobs, { ...IDLE_RUN, status: 'running', runId: formatRunId(31), startedAt: AT }), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
  useBatchView.getState().select('queue', { type: 'selectAll', ids: jobs.map((entry) => entry.id) })
  useAppStore.setState({ currentView: 'editor', viewHistory: [], logFilter: null, config: null })
})

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
})

describe('hidden views', () =>
{
  it('lets the visible editor timeline act on its keys', () =>
  {
    const { api } = recordingApi()
    render(<Shell api={api} />)
    const timeline = screen.getByRole('application', { name: 'Timeline' })
    expect(press(timeline, { key: ' ', code: 'Space' })).toBe(true)
    expect(editorSpies.togglePlayback).toHaveBeenCalledTimes(1)
    expect(press(timeline, { key: 'Delete', code: 'Delete' })).toBe(true)
    expect(editorSpies.removeClips).toHaveBeenCalledWith(['clip-1'])
  })

  it('never acts on editor keys while Batch shows', async () =>
  {
    act(() => useAppStore.setState({ currentView: 'batch' }))
    const { api } = recordingApi()
    render(<Shell api={api} />)
    await settle()
    const editorBefore = useEditorStore.getState()
    const batchRoot = document.getElementById(BATCH_VIEW_ID) as HTMLElement
    for (const [name, init] of KEYS)
    {
      for (const target of [document.body, batchRoot])
      {
        fireEvent.keyDown(target, init)
        expect(useEditorStore.getState(), `${name} reached the hidden editor`).toBe(editorBefore)
      }
    }
    for (const [name, spy] of Object.entries(editorSpies))
    {
      expect(spy, `editor ${name}`).not.toHaveBeenCalled()
    }
  })

  it('never acts on Batch keys while the editor shows', async () =>
  {
    useEditorStore.setState({ mode: 'clip' })
    const { api, sent } = recordingApi()
    render(<Shell api={api} />)
    await settle()
    sent.length = 0
    const view = useBatchView.getState()
    const jobs = useJobsStore.getState()
    const timeline = screen.getByRole('application', { name: 'Timeline' })
    timeline.focus()
    for (const [name, init] of KEYS)
    {
      for (const target of [timeline, document.body])
      {
        expect(press(target, init), `${name} was prevented`).toBe(false)
      }
    }
    await settle()
    expect(sent).toEqual([])
    expect(useBatchView.getState()).toBe(view)
    expect(useJobsStore.getState()).toBe(jobs)
    expect(document.activeElement).toBe(timeline)
  })
})

/** A Batch view bound to the real keyboard hook, with every handler recorded. */
function BatchKeysView({ handlers }: { handlers: Record<string, ReturnType<typeof vi.fn>> }): React.JSX.Element
{
  const rootRef = useRef<HTMLElement>(null)
  const facts: BatchKeyFacts = { mode: 'queue', runStatus: 'running', runLabel: 'Batch 31', runningCount: 2, runAvailable: true, historyBatchOpen: true }
  useBatchKeys({ rootRef, platform: 'win32', handlers, facts: () => facts, announce: handlers.announce })
  return (
    <section ref={rootRef} aria-label="Batch">
      <div role="grid" aria-label="Jobs" tabIndex={0} />
    </section>
  )
}

describe('the Batch keyboard map in a hidden view', () =>
{
  const names = ['brass', 'startSelected', 'togglePause', 'openPicker', 'addFiles', 'addFolder', 'focusSearch', 'setMode', 'toggleInspector', 'openShortcuts', 'focusRegion', 'focusAttention', 'undo', 'redo', 'historyBack', 'resolveConfirmation', 'clearSelection', 'returnToRow', 'announce']

  it('acts on nothing, wherever the key lands', () =>
  {
    const handlers = Object.fromEntries(names.map((name) => [name, vi.fn(() => true)]))
    render(
      <main>
        <div data-view="editor"><div role="application" aria-label="Timeline" tabIndex={0} /></div>
        <div data-view="batch" style={{ display: 'none' }}><BatchKeysView handlers={handlers} /></div>
      </main>
    )
    const grid = screen.getByRole('grid', { name: 'Jobs', hidden: true })
    const extra: Array<[string, KeyboardEventInit]> = [
      ['Ctrl+Enter', { key: 'Enter', ctrlKey: true }],
      ['Ctrl+K', { key: 'k', ctrlKey: true }],
      ['Ctrl+3', { key: '3', code: 'Digit3', ctrlKey: true }],
      ['F1', { key: 'F1' }],
      ['F6', { key: 'F6' }],
      ['F8', { key: 'F8' }],
      ['Escape', { key: 'Escape' }]
    ]
    for (const [name, init] of [...KEYS, ...extra])
    {
      for (const target of [screen.getByRole('application', { name: 'Timeline' }), document.body, grid])
      {
        expect(press(target, init), `${name} was prevented`).toBe(false)
      }
    }
    for (const [name, handler] of Object.entries(handlers))
    {
      expect(handler, name).not.toHaveBeenCalled()
    }
  })

  it('acts again once the shell shows the view', () =>
  {
    const handlers = Object.fromEntries(names.map((name) => [name, vi.fn(() => true)]))
    act(() => useAppStore.setState({ currentView: 'batch' }))
    render(<BatchKeysView handlers={handlers} />)
    const grid = screen.getByRole('grid', { name: 'Jobs' })
    expect(press(grid, { key: 'p', code: 'KeyP', ctrlKey: true })).toBe(true)
    expect(press(grid, { key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(true)
    expect(handlers.togglePause).toHaveBeenCalledWith('pause')
    expect(handlers.undo).toHaveBeenCalledTimes(1)
  })
})
