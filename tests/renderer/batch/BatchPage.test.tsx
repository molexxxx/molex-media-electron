/**
 * The Batch page frame: the provider's bindings (toasts, Logs, the report tap, plan fixes), the live plan on a
 * plan-input change and on window focus, the drop overlay and the empty state's words, the regions and their F6
 * order, the container layout at the responsive widths, the opt-in digest, the reload notice, a notification
 * click, and the selection kept across a trip to Logs and back.
 */
import React, { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { CommandResult, JobsApi } from '../../../src/shared/jobs/contract'
import { formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { ConvertRecipe, Recipe } from '../../../src/shared/jobs/recipes'
import type { BatchPolicy, BatchSummary, JobView, PreflightReport, RecentFolder, RunState } from '../../../src/shared/jobs/types'
import { focusNextRegion, f6Order } from '../../../src/renderer/src/hooks/useF6Region'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { createBatchViewStore, useBatchView } from '../../../src/renderer/src/stores/batchView'
import { createJobsStore, initialJobsState, useJobsStore, type JobsState } from '../../../src/renderer/src/stores/jobs'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'
import { clearToasts, type ToastApi } from '../../../src/renderer/src/ui/Toast'
import { inertJobsApi, useBatchActions } from '../../../src/renderer/src/components/batch/BatchActionsContext'
import
{
  BATCH_VIEW_ID,
  BatchPage,
  digestSentence,
  discardedSeconds,
  focusLanding,
  outputFolders,
  reloadAttention,
  resetPageSession,
  rowIn
} from '../../../src/renderer/src/components/batch/BatchPage'
import
{
  applyPlanFix,
  BatchActionsProvider,
  FIX_UNAVAILABLE,
  fixedPolicy,
  patchRecipe,
  showJobLog,
  toastOptions,
  useCommitDraft,
  useLatestReport,
  withReportTap,
  type PageActions,
  type ReportState
} from '../../../src/renderer/src/components/batch/page/BatchActionsProvider'
import { carriesFiles, DropOverlay, dropLine, subfolderLine } from '../../../src/renderer/src/components/batch/page/DropOverlay'
import { EMPTY_COPY, EmptyNote, howSteps, QueueEmptyState, recentFolderDetail } from '../../../src/renderer/src/components/batch/page/EmptyState'
import { IDLE_RUN } from '../../../src/renderer/src/components/batch/page/InspectorPanel'
import { firstHydration, useLivePreflight } from '../../../src/renderer/src/components/batch/page/useLivePreflight'
import { createStore } from 'zustand'

const AT = new Date(2026, 9, 16, 13, 40).getTime()
const RECIPE = applyLoudnessPreset('streaming-r128s2', { kind: 'same-as-source' }) as Recipe
const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'folder', folder: 'D:\\Exports' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off' }
const RUN_ID = formatRunId(31)
const RUN_12 = formatRunId(12)

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

function hydrated(jobs: readonly JobView[], over: Partial<JobsState> = {}): JobsState
{
  return {
    ...initialJobsState(),
    seq: 1,
    status: 'hydrated',
    hydrations: 1,
    policy: POLICY,
    defaultRecipe: RECIPE,
    order: jobs.map((entry) => entry.id),
    jobs: Object.fromEntries(jobs.map((entry) => [entry.id, entry])) as JobsState['jobs'],
    ...over
  }
}

function load(jobs: readonly JobView[], over: Partial<JobsState> = {}): void
{
  act(() =>
  {
    useJobsStore.setState(hydrated(jobs, over), true)
  })
}

function update(id: JobId, over: Partial<JobView>): void
{
  act(() =>
  {
    const state = useJobsStore.getState()
    useJobsStore.setState({ jobs: { ...state.jobs, [id]: { ...state.jobs[id], ...over } } })
  })
}

function running(over: Partial<RunState> = {}): RunState
{
  return { ...IDLE_RUN, status: 'running', runId: RUN_ID, startedAt: AT, ...over }
}

function refuse<T>(): Promise<CommandResult<T>>
{
  return Promise.resolve({ ok: false, error: { code: 'internal', message: 'not here', issues: [], details: null } })
}

let reportWidth: (width: number) => void = () => undefined

/** Replaces the ResizeObserver so a test can report the view's width to every observer. */
function observeWidths(): (width: number) => void
{
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal('ResizeObserver', class
  {
    constructor(callback: ResizeObserverCallback)
    {
      callbacks.push(callback)
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  })
  return (width: number) =>
  {
    const entry = { borderBoxSize: [{ inlineSize: width, blockSize: 800 }], contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry
    act(() => callbacks.forEach((callback) => callback([entry], {} as ResizeObserver)))
  }
}

function fakeApi(commands: Partial<JobsApi> = {}): JobsApi & Record<string, ReturnType<typeof vi.fn>>
{
  const preflight = vi.fn(() => refuse<PreflightReport>())
  const add = vi.fn(() => refuse<never>())
  return inertJobsApi({ preflight, add, ...commands }) as JobsApi & Record<string, ReturnType<typeof vi.fn>>
}

function renderPage(api: JobsApi = fakeApi()): ReturnType<typeof render>
{
  return render(<BatchPage api={api} platform="win32" />)
}

function root(): HTMLElement
{
  return document.getElementById(BATCH_VIEW_ID) as HTMLElement
}

beforeEach(() =>
{
  seq = 0
  resetPageSession()
  clearToasts()
  useJobsStore.setState(initialJobsState(), true)
  useBatchView.setState(useBatchView.getInitialState(), true)
  useAppStore.setState({ currentView: 'batch', viewHistory: [], logFilter: null, config: null })
  reportWidth = observeWidths()
  vi.stubGlobal('api', undefined)
})

afterEach(() =>
{
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('page helpers', () =>
{
  it('words the opt-in digest from the batch counts and the time left', () =>
  {
    expect(digestSentence(null, null)).toEqual({ counts: '', text: '' })
    expect(digestSentence({ settled: 10, total: 22 }, running({ progress: { ...IDLE_RUN.progress, etaSec: 18 * 60 } })))
      .toEqual({ counts: '10/22', text: '10 of 22 finished. About 18 min left.' })
    expect(digestSentence({ settled: 3, total: 4 }, running({ status: 'paused' })).text).toBe('3 of 4 finished.')
    expect(digestSentence({ settled: 0, total: 0 }, running()).text).toBe('')
  })

  it('lands a notification click on the job, the running batch, or History', () =>
  {
    const queued = job({ runId: RUN_ID, state: 'encoding' })
    const waiting = job()
    const state = hydrated([queued, waiting], { run: running() })
    expect(focusLanding({ jobId: queued.id, runId: RUN_ID }, state)).toEqual({ kind: 'job', mode: 'run', key: 'run', jobId: queued.id })
    expect(focusLanding({ jobId: waiting.id, runId: null }, state)).toEqual({ kind: 'job', mode: 'queue', key: 'queue', jobId: waiting.id })
    expect(focusLanding({ jobId: 'MM-0999' as JobId, runId: RUN_12 }, state)).toEqual({ kind: 'history', runId: RUN_12, jobId: 'MM-0999' })
    expect(focusLanding({ jobId: 'MM-0999' as JobId, runId: null }, state)).toEqual({ kind: 'none' })
    expect(focusLanding({ jobId: null, runId: RUN_ID }, state)).toEqual({ kind: 'run', runId: RUN_ID })
    expect(focusLanding({ jobId: null, runId: RUN_12 }, state)).toEqual({ kind: 'history', runId: RUN_12, jobId: null })
    expect(focusLanding({ jobId: null, runId: null }, state)).toEqual({ kind: 'none' })
  })

  it('counts the jobs of the latest batch that need attention for the reload notice', () =>
  {
    const failed = job({ runId: RUN_ID, state: 'failed', error: { code: 'ffmpeg-failed', message: 'Decode failed', short: 'Decode failed' } as unknown as JobView['error'] })
    expect(reloadAttention(hydrated([failed]))).toEqual({ runId: RUN_ID, count: 1 })
    expect(reloadAttention(hydrated([job({ runId: RUN_ID, state: 'done' })]))).toBeNull()
    expect(reloadAttention(hydrated([job()]))).toBeNull()
  })

  it('sums the analyzing and encoding work a restart discards, and names the folder a batch wrote to', () =>
  {
    const now = AT + 90_000
    expect(discardedSeconds([
      { state: 'encoding', startedAt: AT },
      { state: 'analyzing', startedAt: AT + 60_000 },
      { state: 'verifying', startedAt: AT },
      { state: 'encoding', startedAt: null }
    ], now)).toBe(120)
    expect(outputFolders({ policy: { destination: { mode: 'folder', folder: 'D:\\Exports' } } } as unknown as BatchSummary)).toEqual(['D:\\Exports'])
    expect(outputFolders({ policy: { destination: { mode: 'next-to-source' } } } as unknown as BatchSummary)).toBeUndefined()
    expect(outputFolders(null)).toBeUndefined()
    const host = document.createElement('div')
    host.innerHTML = '<div role="row" data-row-id="MM-0001"></div>'
    expect(rowIn(host, 'MM-0001')).not.toBeNull()
    expect(rowIn(host, 'MM-"0002')).toBeNull()
    expect(rowIn(null, 'MM-0001')).toBeNull()
  })
})

describe('BatchActionsProvider', () =>
{
  it('maps batch toasts onto the toast region', () =>
  {
    const run = vi.fn()
    const options = toastOptions({ tone: 'neutral', title: 'Added 3 files.', body: 'Skipped 1.', actions: [{ label: 'Undo', run }] })
    expect(options).toMatchObject({ tone: 'info', title: 'Added 3 files.', body: 'Skipped 1.' })
    options.actions?.[0].onAction()
    expect(run).toHaveBeenCalledTimes(1)
    expect(toastOptions({ tone: 'error', title: 'Disk full.', persist: true })).toEqual({ tone: 'error', title: 'Disk full.' })
  })

  it('binds the actions to the stores, the toasts, the live region, Logs, and the draft committer', async () =>
  {
    const show = vi.fn(() => 'toast-1')
    const toasts: ToastApi = { show, update: vi.fn(), dismiss: vi.fn() }
    const announce = vi.fn()
    const jobs = createJobsStore()
    const view = createBatchViewStore({ storage: null })
    let actions: PageActions | null = null
    let commit: (() => Promise<unknown>) | null = null
    function Probe(): null
    {
      actions = useBatchActions() as PageActions
      commit = useCommitDraft()
      return null
    }
    const { unmount } = render(
      <LiveRegion>
        <BatchActionsProvider api={inertJobsApi()} jobs={jobs} view={view} toasts={toasts} announce={announce}>
          <Probe />
        </BatchActionsProvider>
      </LiveRegion>
    )
    expect(actions).not.toBeNull()
    await act(async () =>
    {
      await actions!.undo()
    })
    expect(announce).toHaveBeenCalledWith('Nothing to undo.', undefined)
    await expect(commit!()).resolves.toEqual({ status: 'none' })
    const unregister = actions!.registerDraftCommitter(() => ({ status: 'invalid', field: 'Target, integrated' }))
    await expect(commit!()).resolves.toEqual({ status: 'invalid', field: 'Target, integrated' })
    unregister()
    await act(async () =>
    {
      await actions!.setPolicy({ ...POLICY })
    })
    expect(show).toHaveBeenCalled()
    actions!.showLog('MM-0007' as JobId)
    expect(useAppStore.getState().logFilter).toEqual({ jobId: 'MM-0007' })
    expect(useAppStore.getState().currentView).toBe('logs')
    showJobLog('MM-0008' as JobId)
    expect(useAppStore.getState().logFilter).toEqual({ jobId: 'MM-0008' })
    unmount()
  })

  it('rebuilds its actions after the development double effect disposed them', () =>
  {
    const seen = new Set<unknown>()
    function Probe(): null
    {
      seen.add(useBatchActions())
      return null
    }
    render(
      <StrictMode>
        <LiveRegion>
          <BatchActionsProvider api={inertJobsApi()}>
            <Probe />
          </BatchActionsProvider>
        </LiveRegion>
      </StrictMode>
    )
    expect(seen.size).toBeGreaterThanOrEqual(2)
  })

  it('records only the latest preflight reply', async () =>
  {
    const reports = createStore<ReportState>(() => ({ report: null }))
    const resolvers: Array<(value: CommandResult<PreflightReport>) => void> = []
    const api = inertJobsApi({ preflight: () => new Promise((resolve) => resolvers.push(resolve)) })
    const tapped = withReportTap(api, reports)
    const first = tapped.preflight({ ids: 'pending' })
    const second = tapped.preflight({ ids: 'pending' })
    resolvers[1]({ ok: true, seq: 2, value: { preflightId: 'p2' } as PreflightReport })
    await second
    resolvers[0]({ ok: true, seq: 1, value: { preflightId: 'p1' } as PreflightReport })
    await first
    expect(reports.getState().report?.preflightId).toBe('p2')
    const { result } = renderHook(() => useLatestReport())
    expect(result.current).toBeNull()
  })

  it('turns batch fixes into policy changes', () =>
  {
    expect(fixedPolicy(POLICY, { kind: 'set-conflict-rule', rule: 'skip', scope: 'batch' })?.conflict).toBe('skip')
    expect(fixedPolicy(POLICY, { kind: 'add-token', token: '{subdir}', scope: 'batch' })?.template).toBe('{subdir}/{name}')
    expect(fixedPolicy(POLICY, { kind: 'add-token', token: '{catalog}', scope: 'batch' })?.template).toBe('{name}-{catalog}')
    expect(fixedPolicy({ ...POLICY, template: '{name}-{catalog}' }, { kind: 'add-token', token: '{catalog}', scope: 'batch' })?.template).toBe('{name}-{catalog}')
    expect(fixedPolicy(POLICY, { kind: 'set-gpu', gpu: 'auto', scope: 'batch' })?.gpu).toBe('auto')
    expect(fixedPolicy(POLICY, { kind: 'set-displaced', displaced: 'keep', scope: 'batch' })?.displaced).toBe('keep')
    expect(fixedPolicy(POLICY, { kind: 'set-destination', destination: 'next-to-source', scope: 'batch' })?.destination).toEqual({ mode: 'next-to-source' })
    expect(fixedPolicy(POLICY, { kind: 'remove', scope: 'jobs' })).toBeNull()
    expect(fixedPolicy(POLICY, { kind: 'add-token', token: '{ext}', scope: 'batch' })).not.toHaveProperty('rev')
  })

  it('patches the recipe fields a fix names', () =>
  {
    const convert: ConvertRecipe = {
      kind: 'convert',
      presetId: null,
      userPreset: null,
      container: 'mp4',
      video: { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p' } as ConvertRecipe['video'],
      audio: { kind: 'copy' },
      channels: 'keep',
      subtitles: 'keep'
    }
    expect(patchRecipe(convert, { field: 'audio', value: { kind: 'same-as-source' } as ConvertRecipe['audio'] })).toMatchObject({ audio: { kind: 'same-as-source' } })
    expect(patchRecipe(convert, { field: 'channels', value: 'stereo' as ConvertRecipe['channels'] })).toMatchObject({ channels: 'stereo' })
    expect(patchRecipe(convert, { field: 'video-encoder', value: 'libx265' as never })).toMatchObject({ video: { encoder: 'libx265' } })
    expect(patchRecipe(convert, { field: 'sampleRate', value: 48000 })).toBeNull()
    expect(patchRecipe(convert, { field: 'stream', value: { by: 'default' } })).toBeNull()
    expect(patchRecipe(convert, { field: 'extract-reencode', value: { encoder: 'libx264', crf: 20 } })).toBeNull()
    expect(patchRecipe(convert, { field: 'compress-target', value: { mode: 'crf', crf: 20 }, encoder: 'libx264' as never })).toBeNull()
    expect(patchRecipe(convert, { field: 'downmix', value: 'standard' })).toBeNull()
    const compress = { kind: 'compress', encoder: 'libx264', target: { mode: 'crf', crf: 23 } } as unknown as Recipe
    expect(patchRecipe(compress, { field: 'video-encoder', value: 'libx265' as never })).toMatchObject({ encoder: 'libx265' })
    expect(patchRecipe(compress, { field: 'video-encoder', value: 'copy' })).toBeNull()
    expect(patchRecipe(compress, { field: 'compress-target', value: { mode: 'crf', crf: 18 }, encoder: 'libx265' as never })).toMatchObject({ target: { crf: 18 }, encoder: 'libx265' })
    const extract = { kind: 'extract', mode: 'audio', stream: { by: 'default' }, sampleRate: null, reencode: null } as unknown as Recipe
    expect(patchRecipe(extract, { field: 'sampleRate', value: 44100 })).toMatchObject({ sampleRate: 44100 })
    expect(patchRecipe(extract, { field: 'stream', value: { by: 'ordinal', ordinal: 2 } })).toMatchObject({ stream: { ordinal: 2 } })
    expect(patchRecipe(extract, { field: 'extract-reencode', value: { encoder: 'libx264', crf: 20 } })).toMatchObject({ reencode: { crf: 20 } })
  })

  it('applies plan fixes through the actions, or says why it cannot', async () =>
  {
    const actions = { setPolicy: vi.fn(async () => ({}) as never), remove: vi.fn(async () => ({}) as never), assignRecipes: vi.fn(async () => ({}) as never) }
    const a = job({ recipe: { kind: 'convert', container: 'mkv' } as unknown as Recipe })
    const b = job()
    const state = { policy: POLICY, jobs: { [a.id]: a, [b.id]: b } as JobsState['jobs'] }
    await expect(applyPlanFix(actions, state, { kind: 'set-conflict-rule', rule: 'skip', scope: 'batch' }, [])).resolves.toEqual({ status: 'sent' })
    expect(actions.setPolicy).toHaveBeenCalledWith(expect.objectContaining({ conflict: 'skip' }))
    await expect(applyPlanFix(actions, { ...state, policy: null }, { kind: 'set-gpu', gpu: 'off', scope: 'batch' }, [])).resolves.toEqual({ status: 'none', reason: FIX_UNAVAILABLE })
    await expect(applyPlanFix(actions, state, { kind: 'remove', scope: 'jobs' }, [a.id])).resolves.toEqual({ status: 'sent' })
    expect(actions.remove).toHaveBeenCalledWith([a.id])
    await applyPlanFix(actions, state, { kind: 'set-container', container: 'mp4', scope: 'jobs' }, [a.id, b.id, 'MM-0999' as JobId])
    expect(actions.assignRecipes).toHaveBeenCalledWith([{ jobId: a.id, recipe: expect.objectContaining({ container: 'mp4' }) }], { field: 'Container' })
    await expect(applyPlanFix(actions, state, { kind: 'patch-recipe', label: 'Downmix', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' }, [b.id]))
      .resolves.toEqual({ status: 'none', reason: FIX_UNAVAILABLE })
  })
})

describe('useLivePreflight', () =>
{
  it('plans on window focus and once after the first snapshot', () =>
  {
    const actions = { windowFocused: vi.fn(), notePlanInputChange: vi.fn() }
    const jobs = createJobsStore()
    renderHook(() => useLivePreflight(actions, { jobs }))
    expect(actions.notePlanInputChange).not.toHaveBeenCalled()
    act(() => jobs.setState(hydrated([job()])))
    expect(actions.notePlanInputChange).toHaveBeenCalledTimes(1)
    act(() => jobs.setState({ seq: 2 }))
    expect(actions.notePlanInputChange).toHaveBeenCalledTimes(1)
    fireEvent.focus(window)
    expect(actions.windowFocused).toHaveBeenCalledTimes(1)
    expect(firstHydration({ hydrations: 0 }, { hydrations: 1, status: 'hydrated' })).toBe(true)
    expect(firstHydration({ hydrations: 1 }, { hydrations: 2, status: 'hydrated' })).toBe(false)
    expect(firstHydration({ hydrations: 0 }, { hydrations: 1, status: 'resyncing' })).toBe(false)
  })

  it('plans at once when mounted after the snapshot, and binds no window when there is none', () =>
  {
    const actions = { windowFocused: vi.fn(), notePlanInputChange: vi.fn() }
    const jobs = createJobsStore()
    jobs.setState(hydrated([job()]))
    renderHook(() => useLivePreflight(actions, { jobs, target: undefined }))
    expect(actions.notePlanInputChange).toHaveBeenCalledTimes(1)
  })
})

describe('DropOverlay and EmptyState', () =>
{
  it('names the recipe new files get and the subfolder rule, without primary', () =>
  {
    expect(dropLine('Normalize · Podcast (Apple Podcasts)')).toBe('Drop to add. New files get Normalize · Podcast (Apple Podcasts).')
    expect(dropLine(null)).toBe('Drop to add.')
    expect(subfolderLine(true)).toBe('Folders are scanned, including subfolders.')
    expect(subfolderLine(false)).toBe('Folders are scanned without their subfolders.')
    expect(carriesFiles(null)).toBe(false)
    expect(carriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
    expect(carriesFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true)
    const { container } = render(<DropOverlay recipe="Normalize · Podcast (Apple Podcasts)" recursive />)
    const overlay = container.querySelector('[data-drop-overlay]') as HTMLElement
    expect(overlay).toHaveTextContent('Drop to add. New files get Normalize · Podcast (Apple Podcasts).Folders are scanned, including subfolders.')
    expect(overlay.className).not.toMatch(/primary/)
  })

  it('teaches the four ideas and lists the recent folders', () =>
  {
    const folders: RecentFolder[] = Array.from({ length: 7 }, (_, index) => ({ path: `D:\\Rips\\F${index}`, name: `F${index}`, files: 212, addedAt: new Date(2026, 9, 12).getTime() }))
    const onAddFiles = vi.fn()
    const onAddFolder = vi.fn()
    const onOpenFolder = vi.fn()
    render(
      <PlatformProvider platform="win32">
        <QueueEmptyState recipe="Normalize · Podcast (Apple Podcasts)" recentFolders={folders} primary onAddFiles={onAddFiles} onAddFolder={onAddFolder} onOpenFolder={onOpenFolder} />
      </PlatformProvider>
    )
    expect(screen.getByRole('heading', { name: EMPTY_COPY.queueHeading })).toBeInTheDocument()
    const steps = within(screen.getByRole('list', { name: EMPTY_COPY.howHeading })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual(howSteps('Normalize · Podcast (Apple Podcasts)'))
    expect(steps[0]).toHaveTextContent('Files you add get Normalize · Podcast (Apple Podcasts). Change it under New files before you add.')
    const recent = within(screen.getByRole('list', { name: EMPTY_COPY.recentHeading })).getAllByRole('button')
    expect(recent).toHaveLength(5)
    expect(recent[0]).toHaveTextContent('F0')
    expect(recent[0]).toHaveTextContent('D:\\Rips\\F0 · 212 files · Oct 12')
    fireEvent.click(recent[1])
    expect(onOpenFolder).toHaveBeenCalledWith('D:\\Rips\\F1')
    const add = screen.getByRole('button', { name: EMPTY_COPY.addFiles })
    expect(add).toHaveAttribute('data-variant', 'primary')
    fireEvent.click(add)
    fireEvent.click(screen.getByRole('button', { name: EMPTY_COPY.addFolder }))
    expect(onAddFiles).toHaveBeenCalledTimes(1)
    expect(onAddFolder).toHaveBeenCalledTimes(1)
    expect(howSteps(null)[0]).toBe('Files you add get the New files operation. Change it before you add.')
    expect(recentFolderDetail({ path: 'E:\\Tapes', files: 1, addedAt: new Date(2026, 8, 30).getTime() })).toBe('E:\\Tapes · 1 file · Sep 30')
  })

  it('words Review with nothing waiting, an empty History, and filters that hide every row', () =>
  {
    const onClear = vi.fn()
    const { rerender } = render(<EmptyNote kind="review" />)
    expect(screen.getByText(EMPTY_COPY.review)).toBeInTheDocument()
    rerender(<EmptyNote kind="history" />)
    expect(screen.getByText(EMPTY_COPY.history)).toBeInTheDocument()
    rerender(<EmptyNote kind="filtered" onClearFilters={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: EMPTY_COPY.clearFilters }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('BatchPage', () =>
{
  it('builds the regions and registers the five F6 regions in order', () =>
  {
    load([job(), job()])
    renderPage()
    const view = root()
    expect(view.tagName).toBe('SECTION')
    expect(within(view).getByRole('region', { name: 'Batch status and controls' })).toBeInTheDocument()
    expect(within(view).getByRole('group', { name: 'Queue tools' })).toBeInTheDocument()
    expect(within(view).getByRole('grid', { name: 'Jobs' })).toBeInTheDocument()
    expect(within(view).getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
    expect(f6Order().filter((stop) => stop.kind === 'region').map((stop) => stop.name)).toEqual(['header', 'toolbar', 'table', 'inspector'])
    act(() =>
    {
      useJobsStore.setState({ scans: [{ scanId: 's1', root: 'D:\\Rips', status: 'scanning', error: null, visited: 10, added: 4, excluded: {} as never }] })
    })
    const slot = view.querySelector('[data-region="summary"]') as HTMLElement
    expect(within(slot).getByText('Scanning D:\\Rips · 4 files found')).toBeInTheDocument()
    expect(within(slot).getByRole('button', { name: 'Stop scan' })).toBeInTheDocument()
    expect(f6Order().filter((stop) => stop.kind === 'region').map((stop) => stop.name)).toEqual(['header', 'toolbar', 'summary', 'table', 'inspector'])
    const entered = focusNextRegion('next')
    expect(entered).not.toBeNull()
  })

  it('lays the inspector out by the view width', () =>
  {
    const a = job()
    load([a, job()])
    act(() =>
    {
      useBatchView.getState().select('queue', { type: 'selectAll', ids: [a.id] })
    })
    renderPage()
    reportWidth(1657)
    let aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside.style.width).toBe('360px')
    expect(screen.getByRole('separator', { name: 'Inspector width' })).toBeInTheDocument()
    reportWidth(1100)
    expect(screen.getByRole('complementary', { name: 'Inspector' }).style.width).toBe('320px')
    expect(screen.queryByRole('separator', { name: 'Inspector width' })).toBeNull()
    reportWidth(900)
    expect(screen.getByRole('complementary', { name: 'Inspector' }).style.width).toBe('300px')
    reportWidth(760)
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    fireEvent.keyDown(root(), { key: 'i', ctrlKey: true })
    aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside).toHaveAttribute('data-placement', 'beside')
    expect(aside.style.width).toBe('320px')
    fireEvent.keyDown(aside, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    reportWidth(560)
    fireEvent.keyDown(root(), { key: 'i', ctrlKey: true })
    aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(aside).toHaveAttribute('data-placement', 'sheet')
    fireEvent.click(within(aside).getByRole('button', { name: 'Back to jobs' }))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
  })

  it('plans the pending jobs 400 ms after a plan input changes and on window focus', async () =>
  {
    const a = job()
    load([a])
    const api = fakeApi()
    renderPage(api)
    await waitFor(() => expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' }), { timeout: 2000 })
    api.preflight.mockClear()
    update(a.id, { inputsRev: 2 })
    expect(api.preflight).not.toHaveBeenCalled()
    await waitFor(() => expect(api.preflight).toHaveBeenCalledTimes(1), { timeout: 2000 })
    api.preflight.mockClear()
    await act(async () =>
    {
      fireEvent.focus(window)
    })
    expect(api.preflight).toHaveBeenCalledWith({ ids: 'pending' })
  })

  it('shows the drop overlay while files are dragged and adds what is dropped', async () =>
  {
    vi.stubGlobal('api', { getFilePath: (file: File) => `D:\\Drops\\${file.name}` })
    load([job()])
    const api = fakeApi()
    renderPage(api)
    const files = { types: ['Files'], files: [new File(['x'], 'a.wav')], dropEffect: 'none' }
    fireEvent.dragEnter(root(), { dataTransfer: files })
    const overlay = root().querySelector('[data-drop-overlay]') as HTMLElement
    expect(overlay).toHaveTextContent('Drop to add. New files get Normalize')
    expect(overlay).toHaveTextContent('Folders are scanned, including subfolders.')
    fireEvent.dragOver(root(), { dataTransfer: files })
    fireEvent.dragEnter(root(), { dataTransfer: { types: ['text/plain'] } })
    fireEvent.dragLeave(root(), { dataTransfer: files })
    expect(root().querySelector('[data-drop-overlay]')).toBeNull()
    fireEvent.dragEnter(root(), { dataTransfer: files })
    await act(async () =>
    {
      fireEvent.drop(root(), { dataTransfer: files })
    })
    expect(root().querySelector('[data-drop-overlay]')).toBeNull()
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ paths: ['D:\\Drops\\a.wav'], origin: 'drop', recursive: true }))
  })

  it('shows the empty state with recent folders on an empty queue', () =>
  {
    load([], { recentFolders: [{ path: 'D:\\Rips\\Podcasts', name: 'Podcasts', files: 212, addedAt: AT }] })
    renderPage()
    expect(screen.getByRole('heading', { name: EMPTY_COPY.queueHeading })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Podcasts/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: EMPTY_COPY.addFiles })).toHaveAttribute('data-variant', 'primary')
  })

  it('raises the one reload notice when the batch has jobs that need attention', () =>
  {
    const failed = job({ runId: RUN_ID, state: 'failed', error: { code: 'ffmpeg-failed', message: 'Decode failed', short: 'Decode failed' } as unknown as JobView['error'] })
    load([failed, job({ runId: RUN_ID, state: 'done' })])
    const { unmount } = renderPage()
    const notice = 'The window reloaded. 1 job needs attention in Batch 31. Undo history was cleared.'
    expect(screen.getByText(notice)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(useBatchView.getState().mode).toBe('run')
    expect(useBatchView.getState().views.run.filters.chips.map((chip) => chip.value)).toEqual(['attention', RUN_ID])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(notice)).toBeNull()
    unmount()
    renderPage()
    expect(screen.queryByText(notice)).toBeNull()
  })

  it('opens on Run after a reload while a batch runs, with the Run tab available', () =>
  {
    load([job({ runId: RUN_ID, state: 'encoding', startedAt: AT }), job({ runId: RUN_ID, state: 'queued' })], { run: running() })
    renderPage()
    expect(useBatchView.getState()).toMatchObject({ mode: 'run', runAvailable: true })
    const tab = within(root()).getByRole('tab', { name: /^Run/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(tab).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('opens on Run once when the first snapshot lands after the page mounts, and leaves a later choice alone', () =>
  {
    renderPage()
    expect(useBatchView.getState()).toMatchObject({ mode: 'queue', runAvailable: false })
    const paused = job({ runId: RUN_ID, state: 'queued' })
    load([paused], { run: running({ status: 'paused' }) })
    expect(useBatchView.getState()).toMatchObject({ mode: 'run', runAvailable: true })
    act(() =>
    {
      useBatchView.getState().setMode('queue')
    })
    load([paused], { run: running(), hydrations: 2 })
    expect(useBatchView.getState().mode).toBe('queue')
  })

  it('stays on Queue after a reload when no batch is open', () =>
  {
    load([job({ runId: RUN_ID, state: 'done' }), job()])
    renderPage()
    expect(useBatchView.getState()).toMatchObject({ mode: 'queue', runAvailable: false })
    expect(within(root()).getByRole('tab', { name: /^Queue/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('brings a job forward on a notification click', async () =>
  {
    const a = job()
    const b = job()
    load([a, b])
    useAppStore.setState({ currentView: 'dashboard' })
    renderPage()
    act(() =>
    {
      useJobsStore.setState({ focus: { jobId: b.id, runId: null, seq: 9 } })
    })
    expect(useAppStore.getState().currentView).toBe('batch')
    expect([...useBatchView.getState().views.queue.selection.selected]).toEqual([b.id])
    expect(useJobsStore.getState().focus).toBeNull()
    act(() =>
    {
      useJobsStore.setState({ focus: { jobId: null, runId: RUN_12, seq: 10 } })
    })
    expect(useBatchView.getState().mode).toBe('history')
    expect(useBatchView.getState().history.openRunId).toBe(RUN_12)
  })

  it('keeps the selection when the user returns from Logs with Alt+Left', () =>
  {
    const a = job()
    load([a, job()])
    const { unmount } = renderPage()
    act(() =>
    {
      useBatchView.getState().select('queue', { type: 'click', id: a.id })
    })
    expect(screen.getByRole('heading', { name: `${a.id}, ${a.source.name}` })).toBeInTheDocument()
    act(() =>
    {
      useAppStore.getState().showLog({ jobId: a.id })
    })
    unmount()
    act(() =>
    {
      useAppStore.getState().goBack()
    })
    expect(useAppStore.getState().currentView).toBe('batch')
    renderPage()
    expect([...useBatchView.getState().views.queue.selection.selected]).toEqual([a.id])
    expect(screen.getByRole('heading', { name: `${a.id}, ${a.source.name}` })).toBeInTheDocument()
  })

  it('speaks the progress digest only when announceProgress is on', () =>
  {
    for (const on of [false, true])
    {
      cleanup()
      resetPageSession()
      vi.useFakeTimers()
      useAppStore.setState({ config: on ? { announceProgress: true } as never : null })
      const a = job({ runId: RUN_ID, state: 'encoding', startedAt: AT })
      const b = job({ runId: RUN_ID, state: 'done' })
      load([a, b], { run: running() })
      renderPage()
      act(() =>
      {
        within(root()).getAllByRole('button')[0].focus()
      })
      update(a.id, { state: 'done' })
      act(() =>
      {
        vi.advanceTimersByTime(31_000)
      })
      const spoken = Array.from(document.querySelectorAll('[role="status"]')).some((region) => region.textContent === '2 of 2 finished.')
      expect(spoken).toBe(on)
      vi.useRealTimers()
    }
  })
})
