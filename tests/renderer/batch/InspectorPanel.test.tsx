/**
 * The inspector region: its placement and width at each view width of the responsive table, the tab each mode
 * opens on and the user's tab until the next mode change, the batch overview with nothing selected, one job with
 * its identity, tabs, and scope footer, Close beside the narrowed table, the sheet with "Back to jobs", Escape,
 * and History's batch inspector.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { CommandResult } from '../../../src/shared/jobs/contract'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, BatchSummary, JobDetail, JobView } from '../../../src/shared/jobs/types'
import { useBatchView } from '../../../src/renderer/src/stores/batchView'
import { initialJobsState, useJobsStore, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'
import { TestBatchActionsProvider } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import
{
  DEFAULT_TAB,
  IDLE_RUN,
  INSPECTOR_COPY,
  InspectorPanel,
  inspectorLayout,
  recipeContextOf,
  selectedJobs,
  summaryOnPage,
  useInspectorTab,
  type InspectorLayout,
  type InspectorPanelProps
} from '../../../src/renderer/src/components/batch/page/InspectorPanel'

const AT = new Date(2026, 9, 16, 13, 40).getTime()
const SAME: EncoderPolicy = { kind: 'same-as-source' }
const RECIPE = applyLoudnessPreset('streaming-r128s2', SAME) as Recipe
const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' }
const DOCKED: InspectorLayout = { placement: 'docked', width: 360, resizable: true, max: 520 }

let seq = 0

function job(over: Partial<JobView> = {}): JobView
{
  seq += 1
  const id = `MM-${String(seq).padStart(4, '0')}` as JobId
  return {
    id,
    seq,
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

function load(jobs: readonly JobView[], over: Partial<JobsState> = {}): void
{
  act(() =>
  {
    useJobsStore.setState({
      ...initialJobsState(),
      status: 'hydrated',
      hydrations: 1,
      policy: POLICY,
      order: jobs.map((entry) => entry.id),
      jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])),
      ...over
    }, true)
  })
}

function selectIds(ids: readonly string[], key: 'queue' | 'review' | 'run' = 'queue'): void
{
  act(() =>
  {
    useBatchView.getState().select(key, { type: 'selectAll', ids })
  })
}

function setMode(mode: 'queue' | 'review' | 'run' | 'history'): void
{
  act(() =>
  {
    if (mode === 'run')
    {
      useBatchView.getState().markRunAvailable()
    }
    useBatchView.getState().setMode(mode)
  })
}

const getDetail = vi.fn(async ({ jobId }: { jobId: JobId }): Promise<CommandResult<JobDetail>> =>
{
  const view = useJobsStore.getState().jobs[jobId]
  return { ok: true, seq: 0, value: { view, plan: null, media: null, measurement: null, verification: null, result: null, error: null, stderrTail: null, stages: [], commands: [], attempts: [] } }
})

function renderPanel(props: Partial<InspectorPanelProps> = {}): ReturnType<typeof render>
{
  return render(
    <PlatformProvider platform="win32">
      <LiveRegion>
        <TestBatchActionsProvider api={{ get: getDetail }} jobs={useJobsStore} view={useBatchView}>
          <InspectorPanel layout={DOCKED} platform="win32" {...props} />
        </TestBatchActionsProvider>
      </LiveRegion>
    </PlatformProvider>
  )
}

beforeEach(() =>
{
  seq = 0
  getDetail.mockClear()
  useJobsStore.setState(initialJobsState(), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
})

afterEach(() =>
{
  cleanup()
})

describe('inspectorLayout', () =>
{
  it('docks at the user width from 1180 px and keeps the table at 560 px or more', () =>
  {
    expect(inspectorLayout(1657, 360)).toEqual({ placement: 'docked', width: 360, resizable: true, max: 520 })
    expect(inspectorLayout(1657, 520).width).toBe(520)
    expect(inspectorLayout(1657, 900).width).toBe(520)
    expect(inspectorLayout(1657, 100).width).toBe(300)
    const tight = inspectorLayout(1180, 520)
    expect(tight.width).toBe(520)
    expect(1180 - (tight.width ?? 0)).toBeGreaterThanOrEqual(560)
    expect(inspectorLayout(1200, 520).max).toBe(520)
  })

  it('follows the responsive table at 1000, 880, 700, and 600 px', () =>
  {
    expect(inspectorLayout(1179, 440)).toEqual({ placement: 'docked', width: 320, resizable: false, max: 320 })
    expect(inspectorLayout(1000, 440).width).toBe(320)
    expect(inspectorLayout(999, 440)).toEqual({ placement: 'docked', width: 300, resizable: false, max: 300 })
    expect(inspectorLayout(880, 440).width).toBe(300)
    expect(inspectorLayout(879, 440)).toEqual({ placement: 'beside', width: 320, resizable: false, max: 320 })
    expect(inspectorLayout(700, 440).placement).toBe('beside')
    expect(inspectorLayout(600, 440).placement).toBe('beside')
    expect(inspectorLayout(599, 440)).toEqual({ placement: 'sheet', width: null, resizable: false, max: 0 })
  })

  it('reads a view not yet measured as wide', () =>
  {
    expect(inspectorLayout(null, 440)).toMatchObject({ placement: 'docked', width: 440, resizable: true })
    expect(inspectorLayout(0, 360).placement).toBe('docked')
  })
})

describe('inspector helpers', () =>
{
  it('opens each mode on its default tab and keeps the user tab until the mode changes', () =>
  {
    expect(DEFAULT_TAB).toEqual({ queue: 'recipe', review: 'plan', run: 'result', history: 'result' })
    const { result, rerender } = renderHook(({ mode }: { mode: 'queue' | 'review' | 'run' }) => useInspectorTab(mode), { initialProps: { mode: 'queue' } })
    expect(result.current[0]).toBe('recipe')
    act(() => result.current[1]('result'))
    expect(result.current[0]).toBe('result')
    rerender({ mode: 'review' })
    expect(result.current[0]).toBe('plan')
    rerender({ mode: 'run' })
    expect(result.current[0]).toBe('result')
  })

  it('builds the recipe context from the presets and the album letters in use', () =>
  {
    const a = job({ albumGroupId: 'A' })
    const b = job({ albumGroupId: 'A' })
    const c = job({ albumGroupId: 'B' })
    const ctx = recipeContextOf({ presets: null, order: [a.id, b.id, c.id], jobs: { [a.id]: a, [b.id]: b, [c.id]: c } as JobsState['jobs'] })
    expect(ctx.albumIds).toEqual(['A', 'B'])
    expect(ctx.output).toEqual(SAME)
    expect(ctx.presets.user).toEqual([])
  })

  it('reads the selection in order, or the one job shown from inside it', () =>
  {
    const a = job()
    const b = job()
    const jobs = { [a.id]: a, [b.id]: b } as JobsState['jobs']
    expect(selectedJobs({ jobs }, new Set([b.id, a.id, 'MM-9999']), null).map((entry) => entry.id)).toEqual([b.id, a.id])
    expect(selectedJobs({ jobs }, new Set([a.id, b.id]), b.id).map((entry) => entry.id)).toEqual([b.id])
    expect(selectedJobs({ jobs }, new Set([a.id]), b.id).map((entry) => entry.id)).toEqual([a.id])
  })

  it('keeps the last summary only while its jobs are on the page', () =>
  {
    const runId = 'run-31' as RunId
    const a = job({ runId, state: 'done' })
    const summary = { runId } as unknown as BatchSummary
    expect(summaryOnPage({ completed: summary, order: [a.id], jobs: { [a.id]: a } as JobsState['jobs'] })).toBe(summary)
    expect(summaryOnPage({ completed: summary, order: [], jobs: {} as JobsState['jobs'] })).toBeNull()
    expect(summaryOnPage({ completed: null, order: [], jobs: {} as JobsState['jobs'] })).toBeNull()
    expect(IDLE_RUN.status).toBe('idle')
  })
})

describe('InspectorPanel', () =>
{
  it('is an aside named Inspector that shows the batch with nothing selected', () =>
  {
    load([job(), job()], { defaultRecipe: RECIPE })
    renderPanel()
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside).toHaveAttribute('data-placement', 'docked')
    expect(aside.style.width).toBe('360px')
    expect(within(aside).getByRole('heading', { name: 'No jobs selected' })).toBeInTheDocument()
    expect(within(aside).getByRole('group', { name: 'Batch overview' })).toHaveTextContent('New files')
    expect(within(aside).queryByRole('tablist')).toBeNull()
  })

  it('shows one job with the Settings, Output, and Result tabs and the scope footer', async () =>
  {
    const a = job()
    load([a, job()])
    selectIds([a.id])
    renderPanel()
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(aside).getByRole('heading', { name: `${a.id}, ${a.source.name}` })).toBeInTheDocument()
    const tabs = within(aside).getByRole('tablist', { name: INSPECTOR_COPY.tabs })
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Settings', 'Output', 'Result'])
    expect(within(tabs).getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
    expect(aside).toHaveTextContent('Changes apply to')
    await act(async () => undefined)
    expect(getDetail).toHaveBeenCalledWith({ jobId: a.id })
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Result' }))
    expect(within(tabs).getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true')
    expect(aside).toHaveTextContent('Results appear here when this job runs.')
  })

  it('opens Review on Output and Run on Result', () =>
  {
    const a = job()
    load([a])
    setMode('review')
    selectIds([a.id], 'review')
    const { unmount } = renderPanel()
    expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
    unmount()
    const runId = 'run-31' as RunId
    const b = job({ runId, state: 'queued' })
    load([b], { run: { ...IDLE_RUN, status: 'running', runId } })
    setMode('run')
    selectIds([b.id], 'run')
    renderPanel()
    expect(screen.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true')
  })

  it('says Results show for one job when several are selected', () =>
  {
    const a = job()
    const b = job()
    load([a, b])
    selectIds([a.id, b.id])
    renderPanel()
    expect(screen.getByRole('heading', { name: '2 jobs selected' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Result' }))
    expect(screen.getByText(INSPECTOR_COPY.resultForOne)).toBeInTheDocument()
  })

  it('opens beside the table only while open, with Close and Escape', () =>
  {
    load([job()])
    const onClose = vi.fn()
    const beside: InspectorLayout = { placement: 'beside', width: 320, resizable: false, max: 320 }
    const { rerender } = renderPanel({ layout: beside, open: false, onClose })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    rerender(
      <PlatformProvider platform="win32">
        <LiveRegion>
          <TestBatchActionsProvider api={{ get: getDetail }} jobs={useJobsStore} view={useBatchView}>
            <InspectorPanel layout={beside} open onClose={onClose} platform="win32" />
          </TestBatchActionsProvider>
        </LiveRegion>
      </PlatformProvider>
    )
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside.style.width).toBe('320px')
    fireEvent.click(within(aside).getByRole('button', { name: INSPECTOR_COPY.close }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(aside, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('opens as a sheet over the whole view with Back to jobs', () =>
  {
    load([job()])
    const onClose = vi.fn()
    renderPanel({ layout: { placement: 'sheet', width: null, resizable: false, max: 0 }, open: true, onClose })
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside).toHaveAttribute('data-placement', 'sheet')
    expect(aside.className).toContain('inset-0')
    fireEvent.click(within(aside).getByRole('button', { name: INSPECTOR_COPY.back }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never closes a docked inspector on Escape', () =>
  {
    load([job()])
    const onClose = vi.fn()
    renderPanel({ onClose })
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Inspector' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the batch inspector in History', () =>
  {
    load([])
    setMode('history')
    renderPanel()
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(aside).queryByRole('tablist', { name: INSPECTOR_COPY.tabs })).toBeNull()
  })
})
