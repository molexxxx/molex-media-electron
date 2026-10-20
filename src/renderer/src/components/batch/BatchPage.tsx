/**
 * The Batch view: the run header, the table toolbar, the summary slot, the job table, and the inspector, meeting
 * the window edges with 1 px lines. The page binds the regions to one set of actions, lays them out by the view's
 * own width, offers its five regions to the F6 cycle, plans the pending jobs live, takes dropped files, speaks the
 * opt-in progress digest, raises the reload notice, and brings a job or batch forward when a notification asks.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createStore, useStore } from 'zustand'
import type { JobsApi } from '../../../../shared/jobs/contract'
import { recipeLabel } from '../../../../shared/jobs/describe'
import type { JobId, RunId } from '../../../../shared/jobs/ids'
import { presetLookup } from '../../../../shared/jobs/presets'
import type { BatchSummary, JobView, PlanFix, RunAlert, RunState, ScanState } from '../../../../shared/jobs/types'
import type { Platform } from '../../../../shared/text/platform'
import { copiedToast, countOf, PART_SEPARATOR, REGION_NAMES, timeLeftSentence } from '../../copy/batch'
import { useF6Region } from '../../hooks/useF6Region'
import { useAppStore } from '../../stores/appStore'
import type { StartOutcome } from '../../stores/batchActions'
import type { FilterContext } from '../../stores/batchFilters'
import { deriveHeader, newJobsWaiting, selectHeaderFacts, type BatchFacts, type HeaderAction, type HeaderView } from '../../stores/batchHeader'
import { activeViewKey, INSPECTOR_WIDTH, modeRows, useBatchView, visibleIds, type BatchMode, type ViewKey } from '../../stores/batchView'
import { clearFocusRequest, useJobsStore, type FocusRequest, type JobsState } from '../../stores/jobs'
import { selectAttentionCount, selectLatestRunId } from '../../stores/jobsSelectors'
import { Button } from '../../ui/Button'
import { detectPlatform, PlatformProvider } from '../../ui/Kbd'
import { LiveRegion, useAnnounce } from '../../ui/LiveRegion'
import { ProgressBar } from '../../ui/ProgressBar'
import { Splitter } from '../../ui/Splitter'
import { useProgressDigest } from '../../ui/Toast'
import { inertJobsApi, useBatchActions } from './BatchActionsContext'
import { HistoryTable, historyList, loadHistoryRuns } from './history/HistoryTable'
import { attentionFilters, RunHeader, type AttentionRequest } from './header/RunHeader'
import { OutputPolicyPopover } from './header/OutputPolicyPopover'
import { WorkersPopover } from './header/WorkersPopover'
import { applyPlanFix, BatchActionsProvider, revealInFolder, useCommitDraft, useLatestReport, type PageActions } from './page/BatchActionsProvider'
import { DropOverlay, useFileDrop } from './page/DropOverlay'
import { EmptyNote, QueueEmptyState } from './page/EmptyState'
import { useFocusOnShow, useFocusRescue, type FocusTargets } from './page/focus'
import { INSPECTOR_COPY, InspectorPanel, inspectorLayout, summaryOnPage, VIEW_BREAKPOINTS } from './page/InspectorPanel'
import { ShortcutsPopover } from './page/ShortcutsPopover'
import { useBatchKeys, type PrimaryMoment } from './page/useBatchKeys'
import { useLivePreflight } from './page/useLivePreflight'
import type { BannerAction } from './summary/Banners'
import type { ReviewStale } from './summary/ReviewSummary'
import { RunNotices } from './summary/RunNotices'
import { SummarySlot, type SummarySituation, type SummarySlotHandle } from './summary/SummarySlot'
import type { QuickAction } from './table/cells'
import { JobTable, type JobListKey } from './table/JobTable'
import { TableConfirm, useRowMenu, type RowMenuHost } from './table/RowMenu'
import { cancelQuestion, useTableCommands } from './table/tableCommands'
import { clearCounts, clearSubmenu } from './toolbar/ClearMenu'
import { Toolbar, useElementWidth, type ToolbarHandle } from './toolbar/Toolbar'

/** The view root's id, which the shell's work area and the tests find it by. */
export const BATCH_VIEW_ID = 'batch-view'

/** The five regions the Batch view offers to the F6 cycle, in order. */
export const F6_REGIONS = ['header', 'toolbar', 'summary', 'table', 'inspector'] as const

/** The opt-in progress digest: "10 of 22 finished. About 18 min left.", and the counts it changes with. */
export function digestSentence(batch: Pick<BatchFacts, 'settled' | 'total'> | null, run: Pick<RunState, 'status' | 'progress'> | null): { counts: string; text: string }
{
  if (batch === null || run === null || batch.total === 0)
  {
    return { counts: '', text: '' }
  }
  const finished = `${batch.settled.toLocaleString('en-US')} of ${batch.total.toLocaleString('en-US')} finished.`
  const eta = run.status === 'running' ? run.progress.etaSec : null
  return { counts: `${batch.settled}/${batch.total}`, text: eta === null ? finished : `${finished} ${timeLeftSentence(eta)}` }
}

/** Where a notification click lands: the list and the job to select, or a batch opened in History. */
export type FocusLanding =
  | { kind: 'job'; mode: BatchMode; key: ViewKey; jobId: JobId }
  | { kind: 'run'; runId: RunId }
  | { kind: 'history'; runId: RunId; jobId: JobId | null }
  | { kind: 'none' }

/**
 * How a ui.focus request lands: a job still on the page is selected in Run when it belongs to the current batch,
 * else in Queue; the current batch shows in Run; any other batch, and a job no longer on the page, opens in History.
 */
export function focusLanding(request: Pick<FocusRequest, 'jobId' | 'runId'>, state: Pick<JobsState, 'jobs' | 'run' | 'order'>): FocusLanding
{
  const current = state.run?.runId ?? null
  if (request.jobId !== null)
  {
    const job = state.jobs[request.jobId]
    if (job !== undefined)
    {
      const inRun = job.runId !== null && (job.runId === current || job.runId === request.runId) && job.state !== 'pending'
      return inRun ? { kind: 'job', mode: 'run', key: 'run', jobId: job.id } : { kind: 'job', mode: 'queue', key: 'queue', jobId: job.id }
    }
    const runId = request.runId
    return runId === null ? { kind: 'none' } : { kind: 'history', runId, jobId: request.jobId }
  }
  if (request.runId === null)
  {
    return { kind: 'none' }
  }
  const onPage = state.order.some((id) => state.jobs[id]?.runId === request.runId)
  return request.runId === current || onPage ? { kind: 'run', runId: request.runId } : { kind: 'history', runId: request.runId, jobId: null }
}

/** The jobs of the latest batch that need attention when this window first hydrated: what the reload notice names. */
export function reloadAttention(state: JobsState): { runId: RunId; count: number } | null
{
  const runId = selectLatestRunId(state)
  if (runId === null)
  {
    return null
  }
  const count = selectAttentionCount(runId)(state)
  return count > 0 ? { runId, count } : null
}

/** The preload's jobs surface, when it offers one. */
function windowJobsApi(): JobsApi | null
{
  const api = (window as unknown as { api?: { jobs?: JobsApi } }).api
  return api?.jobs ?? null
}

/** Props of {@link BatchPage}. */
export interface BatchPageProps
{
  /** The engine surface: the preload's jobs api by default, the dev preview api, or a test's fake. */
  api?: JobsApi
  /** The preload's platform; read from the user agent when left out. */
  platform?: Platform
}

/**
 * The Batch view with its own LiveRegion and actions. The shell mounts it once in the work area, keeps the jobs
 * store in sync, and mounts the toast region.
 */
export function BatchPage({ api, platform }: BatchPageProps): React.JSX.Element
{
  const [engine] = useState<JobsApi>(() => api ?? windowJobsApi() ?? inertJobsApi())
  const resolved = platform ?? detectPlatform()
  return (
    <PlatformProvider platform={resolved}>
      <LiveRegion>
        <BatchActionsProvider api={engine}>
          <BatchView platform={resolved} />
        </BatchActionsProvider>
      </LiveRegion>
    </PlatformProvider>
  )
}

/** What a job list asks of the page. */
interface JobListProps
{
  list: JobListKey
  active: boolean
  platform: Platform
  filterContext: FilterContext
  host: RowMenuHost
  onOpen: (id: string) => void
  /** The table's stable element, focused after a confirmation when its row is gone. */
  fallbackFocus: () => HTMLElement | null
}

/**
 * One mode's job table with its key commands, row menu, and the confirmation they share. Every list stays mounted
 * and hides while another mode shows, so each keeps its scroll position.
 */
function JobList({ list, active, platform, filterContext, host, onOpen, fallbackFocus }: JobListProps): React.JSX.Element
{
  const actions = useBatchActions()
  const announce = useAnnounce()
  const sorted = useBatchView((state) => state.views[list].sort !== null)
  const commands = useTableCommands({ list, platform, announce })
  const rowMenu = useRowMenu({ list, platform, announce, confirm: commands.confirm, host, filterContext })
  const onQuickAction = (action: QuickAction, job: JobView): void =>
  {
    if (action === 'cancel')
    {
      commands.confirm({
        question: cancelQuestion([job], { now: Date.now(), platform, queued: 0 }),
        safeLabel: 'Keep running',
        confirmLabel: 'Cancel job',
        danger: true,
        anchorId: job.id,
        onConfirm: () => void actions.cancelJobs([job.id])
      })
      return
    }
    void (action === 'skip' ? actions.skip([job.id]) : actions.acknowledge([job.id]))
  }
  return (
    <div hidden={!active} data-list={list} className="flex min-h-0 flex-1 flex-col">
      <JobTable
        list={list}
        platform={platform}
        rowMenu={rowMenu}
        onKeyCommand={commands.onKeyCommand}
        onOpen={onOpen}
        onMoveRows={list === 'queue' && !sorted ? (ids, to) => void actions.move(ids as JobId[], to) : undefined}
        onDropRows={list === 'queue' && !sorted ? (ids, before) => void actions.reorder(ids as JobId[], before as JobId | null) : undefined}
        onQuickAction={list === 'run' ? onQuickAction : undefined}
        filterContext={filterContext}
        className="min-h-0 flex-1"
      />
      <TableConfirm pending={commands.pending} onResolve={commands.resolve} fallbackFocus={fallbackFocus} />
    </div>
  )
}

/** The per-window state of the page that outlives a remount: the reload notice, checked once per window. */
interface PageSession
{
  /** Undefined until checked; null when there was nothing to say or it was dismissed. */
  reload: { runId: RunId; count: number } | null | undefined
  /** When the window took main's snapshot, for which alerts read out as alerts. */
  loadedAt: number
}

const pageSession = createStore<PageSession>(() => ({ reload: undefined, loadedAt: Date.now() }))

/** Forgets the reload check, as a new window would; for tests. */
export function resetPageSession(): void
{
  pageSession.setState({ reload: undefined, loadedAt: Date.now() }, true)
}

/** Seconds of analyzing and encoding work the running jobs would lose if they restarted now. */
export function discardedSeconds(jobs: readonly Pick<JobView, 'state' | 'startedAt'>[], now: number): number
{
  let total = 0
  for (const job of jobs)
  {
    if ((job.state === 'analyzing' || job.state === 'encoding') && job.startedAt !== null)
    {
      total += Math.max(0, now - job.startedAt) / 1000
    }
  }
  return Math.round(total)
}

/** The row element of a job inside a region. */
export function rowIn(root: ParentNode | null, id: string): HTMLElement | null
{
  return root?.querySelector<HTMLElement>(`[role="row"][data-row-id="${id.replace(/["\\]/g, '\\$&')}"]`) ?? null
}

/** The Output trigger in the run header, which the summary's and the plan's "Change output" open. */
function outputTrigger(header: HTMLElement | null): HTMLButtonElement | null
{
  const buttons = header === null ? [] : Array.from(header.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((button) => (button.textContent ?? '').trim().startsWith('Output')) ?? null
}

/** A folder scan in progress, with Stop scan. */
function ScanLine({ scan, onStop }: { scan: ScanState; onStop: () => void }): React.JSX.Element
{
  const text = `Scanning ${scan.root}${PART_SEPARATOR}${countOf(scan.added, 'file')} found`
  return (
    <div data-slot-part="scan" className="flex items-center gap-3">
      <p className="min-w-0 truncate text-body text-ink-2">{text}</p>
      <ProgressBar label={text} size="sm" showValue={false} className="w-40 shrink-0" />
      <Button size="sm" variant="ghost" onClick={onStop}>Stop scan</Button>
    </div>
  )
}

/** Pending jobs selected in Review, which "Start only the selected jobs" starts. */
function selectedPendingIds(state: Pick<JobsState, 'jobs'>): JobId[]
{
  const selected = useBatchView.getState().views.review.selection.selected
  return [...selected].filter((id) => state.jobs[id as JobId]?.state === 'pending') as JobId[]
}

function selectedPending(state: Pick<JobsState, 'jobs'>): number
{
  return useBatchView.getState().mode === 'review' ? selectedPendingIds(state).length : 0
}

/** The folder a finished batch wrote to, when it wrote to one folder. */
export function outputFolders(summary: BatchSummary | null): string[] | undefined
{
  const destination = (summary?.policy as { destination?: { mode: string; folder?: string } } | undefined)?.destination
  return destination?.mode === 'folder' && destination.folder !== undefined ? [destination.folder] : undefined
}

/** The job the Output popover's name preview resolves: the focused job, else the first waiting one. */
function previewJob(state: Pick<JobsState, 'jobs' | 'order'>): JobView | null
{
  const view = useBatchView.getState()
  const focused = view.views[activeViewKey(view)].selection.focus
  const job = focused === null ? undefined : state.jobs[focused as JobId]
  if (job !== undefined)
  {
    return job
  }
  const first = state.order.find((id) => state.jobs[id]?.state === 'pending')
  return first === undefined ? null : state.jobs[first]
}

/** The Batch view inside its providers. */
function BatchView({ platform }: { platform: Platform }): React.JSX.Element
{
  const actions = useBatchActions() as PageActions
  const announce = useAnnounce()
  const report = useLatestReport()
  const rootRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const toolbarRegionRef = useRef<HTMLDivElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const toolbarRef = useRef<ToolbarHandle>(null)
  const slotRef = useRef<SummarySlotHandle>(null)
  const inspectorId = useId()
  const commitDraft = useCommitDraft()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  useF6Region('batch', [
    { name: 'header', ref: headerRef },
    { name: 'toolbar', ref: toolbarRegionRef },
    { name: 'summary', ref: summaryRef },
    { name: 'table', ref: tableRef },
    { name: 'inspector', ref: inspectorRef }
  ])
  useLivePreflight(actions)

  const state = useJobsStore()
  const mode = useBatchView((view) => view.mode)
  const key = useBatchView(activeViewKey)
  const review = useBatchView((view) => view.review)
  const preferredWidth = useBatchView((view) => view.prefs.inspectorWidth)
  const filters = useBatchView((view) => view.views[key].filters)
  const session = useStore(pageSession)
  const announceProgress = useAppStore((app) => app.config?.announceProgress ?? false)
  const viewWidth = useElementWidth(rootRef)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [stale, setStale] = useState<ReviewStale | null>(null)
  const [restoredAck, setRestoredAck] = useState(false)

  const layout = inspectorLayout(viewWidth, dragWidth ?? preferredWidth)
  const lookup = useMemo(() => presetLookup(state.presets?.user ?? []), [state.presets])
  const filterContext = useMemo<FilterContext>(() => ({ lookup }), [lookup])
  const facts = selectHeaderFacts(state)
  const reportMatches = report !== null && review.reportId === report.preflightId
  const headerView: HeaderView = {
    mode,
    platform,
    review: review.reportId === null ? null : { counts: reportMatches ? report.counts : null, subset: review.subset !== null, acknowledged: review.acknowledged },
    starting,
    summary: state.completed,
    restoredAcknowledged: restoredAck
  }
  const header = deriveHeader(state, headerView)
  const summary = summaryOnPage(state)
  const runActive = state.run !== null && state.run.status !== 'idle'
  const newFilesRecipe = state.defaultRecipe === null ? null : recipeLabel(state.defaultRecipe, lookup)
  const recursive = state.settings?.includeSubfolders ?? true

  useEffect(() =>
  {
    const check = (jobs: JobsState): void =>
    {
      if (pageSession.getState().reload === undefined && jobs.status === 'hydrated' && jobs.hydrations > 0)
      {
        pageSession.setState({ reload: reloadAttention(jobs), loadedAt: Date.now() })
        useBatchView.getState().openFromSnapshot(jobs.run)
      }
    }
    check(useJobsStore.getState())
    return useJobsStore.subscribe(check)
  }, [])

  const digest = digestSentence(facts.batch, state.run)
  useProgressDigest({ enabled: announceProgress && runActive, scope: rootRef, counts: digest.counts, text: digest.text })

  const focusRow = useCallback((id: string): void =>
  {
    const row = rowIn(tableRef.current, id)
    if (row !== null)
    {
      row.focus()
      return
    }
    tableRef.current?.querySelector<HTMLElement>('[role="grid"]')?.focus()
  }, [])

  const focusTable = useCallback((): void =>
  {
    const view = useBatchView.getState()
    const focused = view.views[activeViewKey(view)].selection.focus
    if (focused !== null && rowIn(tableRef.current, focused) !== null)
    {
      focusRow(focused)
      return
    }
    const grids = Array.from(tableRef.current?.querySelectorAll<HTMLElement>('[role="grid"]') ?? [])
    grids.find((element) => element.closest('[hidden]') === null)?.focus()
  }, [focusRow])

  const selectAndFocus = useCallback((list: ViewKey, ids: readonly string[]): void =>
  {
    useBatchView.getState().select(list, { type: 'selectAll', ids })
    if (ids.length > 0)
    {
      requestAnimationFrame(() => focusRow(ids[0]))
    }
  }, [focusRow])

  const openInspector = useCallback((): void =>
  {
    setInspectorOpen(true)
    requestAnimationFrame(() => inspectorRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button')?.focus())
  }, [])

  const closeInspector = useCallback((): void =>
  {
    setInspectorOpen(false)
    requestAnimationFrame(focusTable)
  }, [focusTable])

  const openOutput = useCallback((): void =>
  {
    outputTrigger(headerRef.current)?.click()
  }, [])

  const showAttention = useCallback((request: AttentionRequest): void =>
  {
    const view = useBatchView.getState()
    view.markRunAvailable()
    view.setMode('run')
    const rows = modeRows('run', useJobsStore.getState())
    const next = { chips: request.filters, search: '' }
    useBatchView.getState().setFilters('run', next, rows, filterContext)
    const shown = visibleIds(rows, next, filterContext)
    if (shown.length > 0)
    {
      selectAndFocus('run', [shown[0]])
    }
  }, [filterContext, selectAndFocus])

  const settleStart = (outcome: StartOutcome): void =>
  {
    switch (outcome.status)
    {
      case 'needs-acknowledgment':
      {
        const text = slotRef.current?.focusAcknowledgment() ?? null
        if (text !== null)
        {
          announce(text)
        }
        return
      }
      case 'stale':
        setStale({ kind: 'sources', count: outcome.changed.length })
        setRefusal(outcome.reason)
        return
      case 'refused':
        setRefusal(outcome.message)
        return
      case 'not-ready':
        announce(outcome.reason)
        return
      case 'invalid-draft':
        announce(`Fix ${outcome.field} first.`)
        return
      case 'started':
        setStale(null)
        requestAnimationFrame(focusTable)
        return
      default:
    }
  }

  const perform = async (action: HeaderAction): Promise<void> =>
  {
    setRefusal(null)
    switch (action.kind)
    {
      case 'review':
        await actions.openReview({ fromQueue: true })
        return
      case 'review-new':
        await actions.openReview({ fromQueue: false })
        return
      case 'start':
      case 'append':
      {
        setStarting(true)
        const outcome = action.kind === 'start' ? await actions.start() : await actions.append()
        setStarting(false)
        settleStart(outcome)
        return
      }
      case 'resume':
      {
        const outcome = await actions.resume({ acknowledged: restoredAck })
        if (outcome.status === 'refused')
        {
          setRefusal(outcome.message)
        }
        return
      }
      case 'retry-returned':
        await actions.retry('failed')
        return
      case 'add-files':
        await toolbarRef.current?.addFiles()
        return
      default:
    }
  }

  const fix = (planFix: PlanFix, ids: readonly JobId[]): void =>
  {
    void applyPlanFix(actions, useJobsStore.getState(), planFix, ids).then((outcome) =>
    {
      if (outcome.status === 'none')
      {
        announce(outcome.reason)
      }
    })
  }

  const issueAction = (action: string, ids: readonly JobId[]): void =>
  {
    switch (action)
    {
      case 'locate':
        selectAndFocus(key, ids)
        openInspector()
        return
      case 'probe-again':
        void actions.send('reprobe', { ids: [...ids] })
        return
      case 'show-log':
        if (ids.length > 0)
        {
          actions.showLog(ids[0])
        }
        return
      case 'change-output':
      case 'change-file-name':
      case 'choose-replace':
        openOutput()
        return
      case 'open-settings':
        useAppStore.getState().setView('settings')
        return
      case 'select-album':
      {
        const jobs = useJobsStore.getState()
        const album = ids.length > 0 ? jobs.jobs[ids[0]]?.albumGroupId ?? null : null
        selectAndFocus(key, album === null ? ids : jobs.order.filter((id) => jobs.jobs[id]?.albumGroupId === album))
        return
      }
      default:
    }
  }

  const bannerAction = (action: BannerAction, alert: RunAlert | null): void =>
  {
    switch (action.id)
    {
      case 'resume':
        void actions.resume({ acknowledged: restoredAck })
        return
      case 'select-waiting':
      case 'show-decisions':
      case 'show-missing':
        selectAndFocus(mode === 'history' ? 'queue' : key, action.jobIds)
        return
      case 'retry-interrupted':
        void actions.retry(action.jobIds)
        return
      case 'change-output':
      case 'write-elsewhere':
        openOutput()
        return
      case 'show-log':
        useAppStore.getState().showLog(state.run?.runId ? { runId: state.run.runId } : null)
        return
      case 'open-settings':
        useAppStore.getState().setView('settings')
        return
      case 'show-folder':
      case 'show-file':
        if (action.path !== null)
        {
          revealInFolder(action.path)
        }
        else if (alert !== null)
        {
          void actions.send('revealAlert', { alertId: alert.id })
        }
        return
      case 'clear-restored':
        void actions.clear({ kind: 'ids', ids: [...action.jobIds] })
        return
      case 'show-attention':
      {
        const runId = session.reload?.runId ?? state.run?.runId ?? null
        if (runId !== null)
        {
          showAttention({ runId, count: 0, filters: attentionFilters(runId) })
        }
        return
      }
      default:
    }
  }

  const host = useMemo<RowMenuHost>(() => ({
    editRecipe: (job: JobView) =>
    {
      selectAndFocus(activeViewKey(useBatchView.getState()), [job.id])
      openInspector()
    },
    openPicker: () => toolbarRef.current?.openRecipePicker(),
    showLog: (job: JobView) => actions.showLog(job.id),
    editAndRetry: (job: JobView) =>
    {
      selectAndFocus(activeViewKey(useBatchView.getState()), [job.id])
      openInspector()
    }
  }), [actions, openInspector, selectAndFocus])

  useEffect(() =>
  {
    const land = (request: FocusRequest): void =>
    {
      const landing = focusLanding(request, useJobsStore.getState())
      const view = useBatchView.getState()
      useAppStore.getState().setView('batch')
      if (landing.kind === 'job')
      {
        if (landing.mode === 'run')
        {
          view.markRunAvailable()
        }
        view.setMode(landing.mode)
        selectAndFocus(landing.key, [landing.jobId])
      }
      else if (landing.kind === 'run')
      {
        view.markRunAvailable()
        view.setMode('run')
      }
      else if (landing.kind === 'history')
      {
        view.setMode('history')
        view.openHistoryBatch(landing.runId, landing.jobId)
      }
      clearFocusRequest(request.seq)
    }
    const pending = useJobsStore.getState().focus
    if (pending !== null)
    {
      land(pending)
    }
    return useJobsStore.subscribe((next, previous) =>
    {
      if (next.focus !== null && next.focus !== previous.focus)
      {
        land(next.focus)
      }
    })
  }, [selectAndFocus])

  const runStatus = state.run?.status ?? 'idle'
  const lastStatus = useRef(runStatus)
  useEffect(() =>
  {
    if (lastStatus.current !== 'idle' && runStatus === 'idle')
    {
      void loadHistoryRuns(actions, historyList)
    }
    lastStatus.current = runStatus
  }, [actions, runStatus])

  const onDrop = useCallback((paths: string[]): void =>
  {
    void actions.addPaths(paths, { origin: 'drop', recursive })
  }, [actions, recursive])
  const dragging = useFileDrop(rootRef, { onDrop })

  const toggleInspector = (): void =>
  {
    if (layout.placement === 'docked')
    {
      inspectorRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], button')?.focus()
    }
    else if (inspectorOpen)
    {
      closeInspector()
    }
    else
    {
      openInspector()
    }
  }

  const visibleGrid = (): HTMLElement | null =>
    Array.from(tableRef.current?.querySelectorAll<HTMLElement>('[role="grid"]') ?? []).find((element) => element.closest('[hidden]') === null) ?? null

  const primaryMoment = (): PrimaryMoment =>
  {
    const action = header.slot
    if (action === null)
    {
      return { kind: 'none' }
    }
    if (!action.enabled)
    {
      return action.blockedBy === 'acknowledgment'
        ? { kind: 'gated', focusAcknowledgment: () => slotRef.current?.focusAcknowledgment() ?? null }
        : { kind: 'none' }
    }
    return { kind: 'ready', perform: () => perform(action) }
  }

  useBatchKeys({
    rootRef,
    platform,
    announce,
    facts: () =>
    {
      const view = useBatchView.getState()
      const jobs = useJobsStore.getState()
      return {
        mode: view.mode,
        runStatus: jobs.run?.status ?? 'idle',
        runLabel: header.title,
        runningCount: Object.values(jobs.jobs).filter((job) => job.state === 'encoding' || job.state === 'analyzing' || job.state === 'verifying' || job.state === 'finalizing').length,
        runAvailable: view.runAvailable,
        historyBatchOpen: activeViewKey(view) === 'historyBatch'
      }
    },
    handlers: {
      commitDraft,
      primary: primaryMoment,
      startSelected: () => actions.startSelected(selectedPendingIds(useJobsStore.getState())).then(settleStart),
      togglePause: (to) =>
      {
        if (to === 'pause')
        {
          void actions.pause('finish-running')
        }
        else
        {
          void actions.resume({ acknowledged: restoredAck })
        }
      },
      openPicker: () => toolbarRef.current?.openRecipePicker(),
      addFiles: () => void toolbarRef.current?.addFiles(),
      addFolder: () => void toolbarRef.current?.addFolder(),
      focusSearch: () => toolbarRef.current?.focusSearch(),
      setMode: (next) =>
      {
        useBatchView.getState().setMode(next)
        requestAnimationFrame(focusTable)
      },
      toggleInspector,
      openShortcuts: () => setShortcutsOpen(true),
      undo: () => void actions.undo(),
      redo: () => void actions.redo(),
      historyBack: () => useBatchView.getState().closeHistoryBatch(),
      returnToRow: () => (layout.placement === 'docked' ? focusTable() : closeInspector())
    }
  })

  const focusTargets: FocusTargets = {
    row: (id) => rowIn(tableRef.current, id),
    focusedRow: () =>
    {
      const view = useBatchView.getState()
      const focused = view.views[activeViewKey(view)].selection.focus
      return focused === null ? null : rowIn(tableRef.current, focused)
    },
    table: visibleGrid,
    actionSlot: () => headerRef.current?.querySelector<HTMLElement>('[data-slot="action"] button') ?? null,
    runControls: () => headerRef.current?.querySelector<HTMLElement>('[data-slot="run-controls"] button') ?? null,
    summaryHeading: () => summaryRef.current?.querySelector<HTMLElement>('h2') ?? null,
    inspectorField: () => inspectorRef.current?.querySelector<HTMLElement>('[role="tabpanel"] :is(input, select, button, [tabindex="0"])') ?? null,
    inspectorTabs: () => inspectorRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null,
    addFiles: () => rootRef.current?.querySelector<HTMLElement>('[data-empty-state="queue"] button, [data-batch-toolbar] button[aria-haspopup="menu"]') ?? null,
    acknowledgment: () => rootRef.current?.querySelector<HTMLElement>('[data-summary-slot] input[type="checkbox"]') ?? null,
    view: () => rootRef.current
  }
  useFocusRescue(rootRef, focusTargets)
  useFocusOnShow('batch', rootRef, () =>
  {
    const view = useBatchView.getState()
    return { kind: 'open-view', lastRow: view.views[activeViewKey(view)].selection.focus, queueEmpty: useJobsStore.getState().order.length === 0 }
  }, focusTargets)

  const notices = noticeParts()
  const situation = summarySituation()

  const inspector = (
    <InspectorPanel
      ref={inspectorRef}
      id={inspectorId}
      layout={layout}
      open={inspectorOpen}
      onClose={closeInspector}
      platform={platform}
      onFocusRow={focusRow}
      onFilter={(filter) =>
      {
        useBatchView.getState().setMode('run')
        selectAndFocus('run', filter.ids)
      }}
      onFix={fix}
      onPlanAction={issueAction}
      onReveal={revealInFolder}
      onCopied={(kind) => announce(copiedToast(kind).title)}
      onShowRunLog={(runId) => useAppStore.getState().showLog({ runId })}
    />
  )

  return (
    <section
      ref={rootRef}
      id={BATCH_VIEW_ID}
      aria-label={header.title}
      data-placement={layout.placement}
      tabIndex={-1}
      className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-ground text-ink"
    >
      <div ref={headerRef} data-region="header">
        <RunHeader
          header={header}
          batch={facts.batch}
          viewWidth={viewWidth ?? undefined}
          inspectorWidth={layout.width ?? undefined}
          selectedCount={selectedPending(state)}
          refusal={refusal}
          outputFolders={outputFolders(summary)}
          discardedWork={() => discardedSeconds(Object.values(useJobsStore.getState().jobs), Date.now())}
          renderOutput={(control) => (
            <OutputPolicyPopover
              control={control}
              policy={state.policy}
              runId={runActive ? state.run?.runId ?? null : null}
              previewJob={previewJob(state)}
              platform={platform}
            />
          )}
          renderWorkers={(control) => (
            <WorkersPopover
              control={control}
              workers={state.run?.workers ?? null}
              settings={state.settings}
              capabilities={state.capabilities}
              policy={state.policy}
              runId={runActive ? state.run?.runId ?? null : null}
              onOpenSettings={() => useAppStore.getState().setView('settings')}
            />
          )}
          onAction={(action) => void perform(action)}
          onStartSelected={() => void actions.startSelected(selectedPendingIds(state)).then(settleStart)}
          onPause={(pauseMode) => void actions.pause(pauseMode)}
          onCancelRun={() => void actions.cancelRun()}
          onShowAttention={showAttention}
          onOpenFolder={(folder) => revealInFolder(folder)}
          onExportReport={(runId, format) => void actions.exportReport({ runId }, format)}
          onOutput={openOutput}
          onShowLog={(runId) => useAppStore.getState().showLog({ runId })}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onInspectorWidth={(width) => useBatchView.getState().setInspectorWidth(width)}
          focusTable={focusTable}
          overflowItems={viewWidth !== null && viewWidth < VIEW_BREAKPOINTS.compact
            ? [clearSubmenu(clearCounts(Object.values(state.jobs)), (scope) => void actions.clear(scope))]
            : undefined}
        />
      </div>
      <div ref={toolbarRegionRef} role="group" aria-label={REGION_NAMES.toolbar} data-region="toolbar">
        <Toolbar
          ref={toolbarRef}
          tableElement={() => tableRef.current?.querySelector<HTMLElement>('[role="grid"]') ?? null}
          inspectorOpen={layout.placement === 'docked' ? true : inspectorOpen}
          onToggleInspector={() => (inspectorOpen ? closeInspector() : openInspector())}
          inspectorId={inspectorId}
          onSearchLeave={focusTable}
          filterContext={filterContext}
        />
      </div>
      {situation.kind !== 'none' || notices !== null
        ? (
          <div ref={summaryRef} data-region="summary" className="flex max-h-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-b border-line px-4 py-3">
            <SummarySlot ref={slotRef} situation={situation} notices={notices} />
          </div>
        )
        : null}
      <div className="flex min-h-0 flex-1">
        <div ref={tableRef} data-region="table" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {tableContent()}
          {dragging && <DropOverlay recipe={newFilesRecipe} recursive={recursive} />}
        </div>
        {layout.resizable && layout.width !== null && (
          <Splitter
            label={INSPECTOR_COPY.widthLabel}
            value={layout.width}
            min={INSPECTOR_WIDTH.min}
            max={layout.max}
            pane="after"
            defaultValue={INSPECTOR_WIDTH.default}
            onChange={setDragWidth}
            onCommit={(width) =>
            {
              useBatchView.getState().setInspectorWidth(width)
              setDragWidth(null)
            }}
          />
        )}
        {layout.placement !== 'sheet' && inspector}
      </div>
      {layout.placement === 'sheet' && inspector}
      <ShortcutsPopover open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} platform={platform} fallbackFocus={visibleGrid} />
    </section>
  )

  function noticeParts(): ReactNode
  {
    const runId = facts.batch?.runId ?? state.run?.runId ?? null
    const reload = session.reload ?? null
    const failedScans = state.scans.some((scan) => scan.status === 'failed')
    const scanning = state.scans.filter((scan) => scan.status === 'scanning')
    if (state.alerts.length === 0 && reload === null && !failedScans && scanning.length === 0)
    {
      return null
    }
    return (
      <>
        {scanning.map((scan) => <ScanLine key={scan.scanId} scan={scan} onStop={() => void actions.cancelScan(scan.scanId)} />)}
        <RunNotices
          runId={reload?.runId ?? runId}
          alerts={state.alerts}
          context={{
            running: facts.batch?.active ?? 0,
            stateOf: (id) => useJobsStore.getState().jobs[id]?.state
          }}
          loadedAt={session.loadedAt}
          onAction={bannerAction}
          onDismissAlert={(alert) => void actions.send('dismissAlert', { alertId: alert.id })}
          acknowledgment={state.run?.needsAck
            ? {
              originals: state.run.needsAck.originalsAffected,
              overwrites: state.run.needsAck.overwrites,
              drive: null,
              platform,
              checked: restoredAck,
              onChange: setRestoredAck
            }
            : null}
          reloadAttention={reload?.count ?? null}
          onDismissReload={() => pageSession.setState({ reload: null })}
          scans={state.scans}
          onDismissScan={() => undefined}
        />
      </>
    )
  }

  function summarySituation(): SummarySituation
  {
    if (mode === 'review' && report !== null && state.policy !== null)
    {
      const pending = state.order.filter((id) => state.jobs[id]?.state === 'pending').length
      return {
        kind: 'review',
        props: {
          report,
          policy: state.policy,
          platform,
          onStopMeasuring: () => void actions.stopMeasuring(),
          subset: review.subset === null ? null : { count: review.subset.length, total: pending },
          onBackToAll: () => void actions.backToAll(),
          scanRunning: state.scans.some((scan) => scan.status === 'scanning'),
          stale,
          onSelect: (ids) => selectAndFocus('review', ids),
          onFix: fix,
          onAction: issueAction,
          onAnnounce: (message) => announce(message)
        }
      }
    }
    if ((mode === 'run' || mode === 'queue') && summary !== null && !runActive)
    {
      const jobs = state.order.map((id) => state.jobs[id]).filter((job) => job !== undefined && job.runId === summary.runId)
      return {
        kind: 'finished',
        props: {
          summary,
          jobs,
          currentPolicy: state.policy,
          clearDone: clearCounts(Object.values(state.jobs)).done,
          onSelect: (ids) => selectAndFocus(key, ids),
          onRetry: (ids) => void actions.retry(ids),
          onEditAndRetry: (ids) =>
          {
            selectAndFocus(key, ids)
            openInspector()
          },
          onAcknowledgeAll: (ids) => void actions.acknowledge(ids),
          onChangeOutput: openOutput,
          onAddFiles: () => void toolbarRef.current?.addFiles(),
          onClearDone: () => void actions.clear({ kind: 'done' })
        }
      }
    }
    if (mode === 'run' && runActive && facts.batch !== null && newJobsWaiting(facts) > 0)
    {
      return {
        kind: 'run',
        props: {
          runId: facts.batch.runId,
          appended: newJobsWaiting(facts),
          appendedPrimary: false,
          onReviewAppended: () => void actions.openReview({ fromQueue: false }),
          onAction: bannerAction
        }
      }
    }
    return { kind: 'none' }
  }

  function tableContent(): ReactNode
  {
    if (mode === 'history')
    {
      return <HistoryTable className="min-h-0 flex-1" />
    }
    const hydrated = state.hydrations > 0
    const rows = modeRows(mode, state)
    let empty: ReactNode = null
    if (hydrated && mode === 'queue' && state.order.length === 0)
    {
      empty = (
        <QueueEmptyState
          recipe={newFilesRecipe}
          recentFolders={state.recentFolders}
          primary={header.primary === 'empty-state'}
          onAddFiles={() => void toolbarRef.current?.addFiles()}
          onAddFolder={() => void toolbarRef.current?.addFolder()}
          onOpenFolder={(path) => void actions.addPaths([path], { origin: 'folder', recursive })}
        />
      )
    }
    else if (hydrated && mode === 'review' && rows.length === 0)
    {
      empty = <EmptyNote kind="review" />
    }
    else if (hydrated && rows.length > 0 && visibleIds(rows, filters, filterContext).length === 0)
    {
      empty = <EmptyNote kind="filtered" onClearFilters={() => useBatchView.getState().clearFilters(key, rows, filterContext)} />
    }
    return (
      <>
        {empty}
        {(['queue', 'review', 'run'] as const).map((list) => (
          <JobList
            key={list}
            list={list}
            active={empty === null && key === list}
            platform={platform}
            filterContext={filterContext}
            host={host}
            onOpen={() => openInspector()}
            fallbackFocus={() => tableRef.current?.querySelector<HTMLElement>('[role="grid"]') ?? null}
          />
        ))}
      </>
    )
  }
}
