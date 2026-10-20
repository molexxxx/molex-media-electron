/**
 * The inspector region of the Batch view: where it sits at the view's width (docked, beside the narrowed table on
 * demand, or a sheet over the whole view), which tab each mode opens on, and the composition of the identity header,
 * the Recipe, Plan, and Result tabs, the scope footer, and the batch overview when nothing is selected.
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { useStore, type StoreApi } from 'zustand'
import { recipeLabel } from '../../../../../shared/jobs/describe'
import type { JobId } from '../../../../../shared/jobs/ids'
import { DEFAULT_PINS, presetLookup } from '../../../../../shared/jobs/presets'
import { STATE_GROUPS } from '../../../../../shared/jobs/states'
import type { BatchSummary, JobDetail, JobView, PlanFix, PresetState, RunState } from '../../../../../shared/jobs/types'
import type { Platform } from '../../../../../shared/text/platform'
import type { CopiedKind } from '../../../copy/batch'
import { policySentence } from '../../../stores/batchHeader'
import
{
  activeViewKey,
  clampInspectorWidth,
  INSPECTOR_WIDTH,
  MIN_TABLE_WIDTH,
  useBatchView,
  type BatchMode,
  type BatchViewState,
  type ViewKey
} from '../../../stores/batchView'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { recipeFields, type RecipeContext } from '../../../stores/recipeFields'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { TabPanel, Tabs } from '../../../ui/Tabs'
import { useBatchActions } from '../BatchActionsContext'
import { HistoryInspector } from '../history/HistoryInspector'
import { BatchOverview } from '../inspector/BatchOverview'
import { IdentityHeader, nextNeedingAttention, type IdentityHeaderProps } from '../inspector/IdentityHeader'
import { PlanTab, type IssueAction } from '../inspector/PlanTab'
import { draftSelection } from '../inspector/RecipeEditor'
import { RecipeTab } from '../inspector/RecipeTab'
import type { JobFilter } from '../inspector/RecipeProgressList'
import { ResultTab } from '../inspector/ResultTab'
import { ScopeFooter } from '../inspector/ScopeFooter'
import { useLatestReport } from './BatchActionsProvider'

/** The inspector's tabs. */
export type InspectorTab = 'recipe' | 'plan' | 'result'

/** The tab each mode opens the inspector on. */
export const DEFAULT_TAB: Readonly<Record<BatchMode, InspectorTab>> = Object.freeze({
  queue: 'recipe',
  review: 'plan',
  run: 'result',
  history: 'result'
})

/** The tabs' labels, in order. */
export const INSPECTOR_TABS: ReadonlyArray<{ value: InspectorTab; label: string }> = [
  { value: 'recipe', label: 'Settings' },
  { value: 'plan', label: 'Output' },
  { value: 'result', label: 'Result' }
]

/** The inspector's words. */
export const INSPECTOR_COPY = Object.freeze({
  label: 'Inspector',
  tabs: 'Inspector sections',
  back: 'Back to jobs',
  close: 'Close inspector',
  widthLabel: 'Inspector width',
  resultForOne: 'Results show for one job at a time. Select one job to see its result.',
  planWaiting: 'The output preview appears once the output settings arrive.'
})

/** Where the inspector sits: docked beside the table, beside it on demand, or a sheet over the whole view. */
export type InspectorPlacement = 'docked' | 'beside' | 'sheet'

/** The inspector's place and size at a view width. */
export interface InspectorLayout
{
  placement: InspectorPlacement
  /** Its width in px; null for the sheet, which takes the whole view. */
  width: number | null
  /** The splitter and the Inspector width menu size it only where the user's width applies. */
  resizable: boolean
  /** The widest the splitter may make it without leaving the table under 560 px. */
  max: number
}

/** View widths where the layout changes, in px. */
export const VIEW_BREAKPOINTS = Object.freeze({ full: 1180, medium: 1000, compact: 880, narrow: 700, sheet: 600 })

/**
 * The inspector's layout at a view width: the user's width from 1180 px (300 to 520, never leaving the table under
 * 560 px), 320 from 1000, 300 from 880, 320 beside the narrowed table on demand from 600, and a sheet below 600. A
 * view not yet measured reads as wide.
 */
export function inspectorLayout(viewWidth: number | null, preferred: number): InspectorLayout
{
  const width = viewWidth === null || viewWidth <= 0 ? Number.POSITIVE_INFINITY : viewWidth
  if (width >= VIEW_BREAKPOINTS.full)
  {
    const max = Math.max(INSPECTOR_WIDTH.min, Math.min(INSPECTOR_WIDTH.max, width - MIN_TABLE_WIDTH))
    return { placement: 'docked', width: Math.min(clampInspectorWidth(preferred), max), resizable: true, max }
  }
  if (width >= VIEW_BREAKPOINTS.medium)
  {
    return { placement: 'docked', width: 320, resizable: false, max: 320 }
  }
  if (width >= VIEW_BREAKPOINTS.compact)
  {
    return { placement: 'docked', width: 300, resizable: false, max: 300 }
  }
  if (width >= VIEW_BREAKPOINTS.sheet)
  {
    return { placement: 'beside', width: 320, resizable: false, max: 320 }
  }
  return { placement: 'sheet', width: null, resizable: false, max: 0 }
}

/** The tab the inspector shows: the user's choice until the next mode change sets the mode's default. */
export function useInspectorTab(mode: BatchMode): [InspectorTab, (tab: InspectorTab) => void]
{
  const [state, setState] = useState<{ mode: BatchMode; tab: InspectorTab }>(() => ({ mode, tab: DEFAULT_TAB[mode] }))
  const tab = state.mode === mode ? state.tab : DEFAULT_TAB[mode]
  return [tab, (next) => setState({ mode, tab: next })]
}

const NO_PRESETS: PresetState = { user: [], pins: { ...DEFAULT_PINS }, recent: [] }

/**
 * What the Recipe tab reads from the engine: the presets with their pins and recent recipes, and the album letters
 * the queue uses. Normalize and Gain start from same-as-source output and the Custom values main keeps.
 */
export function recipeContextOf(state: Pick<JobsState, 'presets' | 'order' | 'jobs'>): RecipeContext
{
  const albums = new Set<string>()
  for (const id of state.order)
  {
    const album = state.jobs[id]?.albumGroupId
    if (album !== null && album !== undefined)
    {
      albums.add(album)
    }
  }
  return {
    presets: state.presets ?? NO_PRESETS,
    output: { kind: 'same-as-source' },
    albumIds: [...albums]
  }
}

/** The selected jobs in selection order, or the one job shown from inside a multi-selection. */
export function selectedJobs(state: Pick<JobsState, 'jobs'>, selected: ReadonlySet<string>, detail: string | null): JobView[]
{
  const ids = detail !== null && selected.has(detail) ? [detail] : [...selected]
  return ids.map((id) => state.jobs[id as JobId]).filter((job): job is JobView => job !== undefined)
}

/** The last finished batch, while any of its jobs are still on the page. */
export function summaryOnPage(state: Pick<JobsState, 'completed' | 'jobs' | 'order'>): BatchSummary | null
{
  const summary = state.completed
  if (summary === null)
  {
    return null
  }
  return state.order.some((id) => state.jobs[id]?.runId === summary.runId) ? summary : null
}

/** A run that has not started, for the batch overview before the first snapshot. */
export const IDLE_RUN: RunState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  pause: null,
  counts: Object.fromEntries(Object.keys(STATE_GROUPS).map((state) => [state, 0])) as RunState['counts'],
  progress: { percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 },
  workers: {
    setting: { mode: 'auto' },
    limits: { total: 0, videoCpu: 0, gpu: 0 },
    active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
  },
  quitWhenIdle: false,
  needsAck: null
}

/** The engine's full record of one job, fetched again whenever the job changes; null while it loads or with no job. */
export function useJobDetail(job: Pick<JobView, 'id' | 'rev' | 'state'> | null): JobDetail | null
{
  const actions = useBatchActions()
  const [detail, setDetail] = useState<{ key: string; value: JobDetail } | null>(null)
  const key = job === null ? null : `${job.id}:${job.rev}:${job.state}`
  const id = job?.id ?? null

  useEffect(() =>
  {
    if (key === null || id === null)
    {
      return undefined
    }
    let live = true
    void actions.send('get', { jobId: id }).then((outcome) =>
    {
      if (live && outcome.status === 'done')
      {
        setDetail({ key, value: outcome.value })
      }
    })
    return () =>
    {
      live = false
    }
  }, [actions, key, id])

  if (detail === null || id === null || !detail.key.startsWith(`${id}:`))
  {
    return null
  }
  return detail.value
}

/** What the panel asks of the page. */
export interface InspectorHandlers
{
  /** Moves the table's focus to a job's row. */
  onFocusRow?: (id: JobId) => void
  /** Filters the table to exactly the jobs a batch overview count counts. */
  onFilter?: (filter: JobFilter) => void
  /** The row menu's items for the identity header's "Job actions" button. */
  rowMenu?: (job: JobView) => MenuEntry[]
  /** Re-plans exactly these jobs with main's fix, or changes the batch's policy, undoably. */
  onFix?: (fix: PlanFix, ids: readonly JobId[]) => void
  /** A Plan tab page action: Locate, Probe again, Show log, Change output, and the rest. */
  onPlanAction?: (action: IssueAction, ids: readonly JobId[]) => void
  onReveal?: (path: string) => void
  onCopied?: (kind: CopiedKind) => void
  /** History's Show log for a batch. */
  onShowRunLog?: (runId: string) => void
  /** The Locate dialog; Locate is left out without it. */
  pickSource?: IdentityHeaderProps['pickSource']
}

/** Props of {@link InspectorPanel}. */
export interface InspectorPanelProps extends InspectorHandlers
{
  layout: InspectorLayout
  /** Beside the table and as a sheet the inspector shows only while open; docked, it always shows. */
  open?: boolean
  /** Close, Back to jobs, and Escape outside docked placement; the page returns focus to the row. */
  onClose?: () => void
  platform: Platform
  id?: string
  ref?: Ref<HTMLElement>
  className?: string
  /** The window's stores by default. */
  jobs?: StoreApi<JobsState>
  view?: StoreApi<BatchViewState>
}

const NO_DRAFTS: ReadonlySet<JobId> = new Set()

/**
 * The inspector: the identity header, the Recipe, Plan, and Result tabs over a scroll body that keeps each tab's
 * scroll position, and the scope footer; with nothing selected, the batch overview; in History, the batch inspector.
 * Docked it sits beside the table; beside the narrowed table it carries Close; as a sheet it carries "Back to jobs".
 */
export function InspectorPanel({
  layout,
  open = true,
  onClose,
  platform,
  id,
  ref,
  className,
  jobs = useJobsStore,
  view = useBatchView,
  ...handlers
}: InspectorPanelProps): React.JSX.Element | null
{
  const mode = useStore(view, (state) => state.mode)
  const key = useStore(view, activeViewKey)
  const selection = useStore(view, (state) => state.views[key].selection.selected)
  const detailId = useStore(view, (state) => state.views[key].detail)
  const jobsMap = useStore(jobs, (state) => state.jobs)
  const order = useStore(jobs, (state) => state.order)
  const shown = useMemo(() => selectedJobs({ jobs: jobsMap }, selection, detailId), [jobsMap, selection, detailId])

  if (!open && layout.placement !== 'docked')
  {
    return null
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void =>
  {
    if (event.key === 'Escape' && !event.defaultPrevented && layout.placement !== 'docked' && onClose !== undefined)
    {
      event.preventDefault()
      onClose()
    }
  }

  const sheet = layout.placement === 'sheet'
  return (
    <aside
      ref={ref}
      id={id}
      aria-label={INSPECTOR_COPY.label}
      data-placement={layout.placement}
      onKeyDown={onKeyDown}
      style={layout.width === null ? undefined : { width: layout.width }}
      className={cx(
        'flex min-h-0 shrink-0 flex-col bg-panel',
        sheet ? 'absolute inset-0 z-30' : 'border-s border-line',
        className
      )}
    >
      {sheet && onClose !== undefined && (
        <div className="flex h-11 shrink-0 items-center border-b border-line px-4">
          <Button variant="ghost" size="sm" icon="action.collapse" onClick={onClose}>{INSPECTOR_COPY.back}</Button>
        </div>
      )}
      {mode === 'history'
        ? <HistoryInspector view={view} onShowLog={handlers.onShowRunLog} className="min-h-0 flex-1 overflow-y-auto ps-4 pe-1 py-3" />
        : (
          <InspectorBody
            key={key}
            mode={mode}
            listKey={key}
            jobs={shown}
            selectionSize={selection.size}
            detailId={detailId}
            order={order}
            platform={platform}
            closable={layout.placement === 'beside' ? onClose : undefined}
            jobsStore={jobs}
            view={view}
            handlers={handlers}
          />
        )}
    </aside>
  )
}

interface InspectorBodyProps
{
  mode: Exclude<BatchMode, 'history'>
  listKey: ViewKey
  jobs: readonly JobView[]
  selectionSize: number
  detailId: string | null
  order: readonly JobId[]
  platform: Platform
  closable?: () => void
  jobsStore: StoreApi<JobsState>
  view: StoreApi<BatchViewState>
  handlers: InspectorHandlers
}

function InspectorBody({ mode, listKey, jobs, selectionSize, detailId, order, platform, closable, jobsStore, view, handlers }: InspectorBodyProps): React.JSX.Element
{
  const actions = useBatchActions()
  const [tab, setTab] = useInspectorTab(mode)
  const tabsId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const scrolls = useRef<Partial<Record<InspectorTab, number>>>({})
  const [drafts, setDrafts] = useState<ReadonlySet<JobId>>(NO_DRAFTS)
  const presets = useStore(jobsStore, (state) => state.presets)
  const albumKey = useStore(jobsStore, (state) => state.order.map((id) => state.jobs[id]?.albumGroupId ?? '').join('|'))
  const ctx = useMemo(() => recipeContextOf(jobsStore.getState()), [jobsStore, presets, albumKey])
  const policy = useStore(jobsStore, (state) => state.policy)
  const run = useStore(jobsStore, (state) => state.run)
  const jobsMap = useStore(jobsStore, (state) => state.jobs)
  const completed = useStore(jobsStore, (state) => state.completed)
  const defaultRecipe = useStore(jobsStore, (state) => state.defaultRecipe)
  const measurements = useStore(jobsStore, (state) => state.measurements)
  const report = useLatestReport()
  const one = jobs.length === 1 ? jobs[0] : null
  const detail = useJobDetail(one)
  const selectionKey = jobs.map((job) => job.id).join('|')

  useEffect(() =>
  {
    setDrafts(NO_DRAFTS)
  }, [selectionKey])

  useLayoutEffect(() =>
  {
    if (scrollRef.current !== null)
    {
      scrollRef.current.scrollTop = scrolls.current[tab] ?? 0
    }
  }, [tab])

  const queue = useMemo(() => order.map((id) => jobsMap[id]).filter((job): job is JobView => job !== undefined), [order, jobsMap])
  const select = (ids: readonly JobId[]): void =>
  {
    view.getState().select(listKey, { type: 'selectAll', ids })
    if (ids.length > 0)
    {
      handlers.onFocusRow?.(ids[0])
    }
  }
  const showJob = (id: JobId): void =>
  {
    if (!view.getState().openDetail(listKey, id))
    {
      view.getState().select(listKey, { type: 'click', id })
    }
  }
  const selectJob = (id: JobId): void =>
  {
    view.getState().select(listKey, { type: 'click', id })
    handlers.onFocusRow?.(id)
  }
  const chooseTab = (next: InspectorTab): void =>
  {
    if (scrollRef.current !== null)
    {
      scrolls.current[tab] = scrollRef.current.scrollTop
    }
    setTab(next)
  }
  const editAndRetry = (id: JobId): void =>
  {
    setDrafts((current) => new Set([...current, id]))
    chooseTab('recipe')
  }
  const focusTabs = (): void =>
  {
    tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }

  const closeButton = closable === undefined
    ? null
    : <IconButton label={INSPECTOR_COPY.close} icon="action.close" size="sm" variant="ghost" onClick={closable} />

  if (jobs.length === 0)
  {
    const lookup = presetLookup(presets?.user ?? [])
    return (
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto ps-5 pe-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <IdentityHeader jobs={[]} users={presets?.user ?? []} />
          {closeButton}
        </div>
        <BatchOverview
          jobs={queue}
          run={run ?? IDLE_RUN}
          summary={summaryOnPage({ completed, jobs: jobsMap, order })}
          outputPolicy={policy === null ? '' : policySentence(policy, platform).text}
          newFilesRecipe={defaultRecipe === null ? '' : recipeLabel(defaultRecipe, lookup)}
          onFilter={(filter) => handlers.onFilter?.(filter)}
          onFocusJob={(jobId) => selectJob(jobId)}
        />
      </div>
    )
  }

  const op = jobs.every((job) => job.recipe.kind === jobs[0].recipe.kind) ? jobs[0].recipe.kind : null
  const fields = op === null ? [] : recipeFields(draftSelection(jobs, drafts), op, ctx)
  const within = detailId !== null && selectionSize > 1 ? { count: selectionSize, onBack: () => view.getState().closeDetail(listKey) } : undefined
  const rowMenu = handlers.rowMenu
  const jobActions = one !== null && rowMenu !== undefined
    ? <Menu trigger={<IconButton label="Job actions" icon="action.more" size="sm" variant="ghost" />} items={rowMenu(one)} label={`Actions for ${one.id}`} align="end" />
    : undefined

  return (
    <>
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto ps-5 pe-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <IdentityHeader
            jobs={jobs}
            users={presets?.user ?? []}
            onSelectOnly={(ids) => select(ids)}
            within={within}
            jobActions={jobActions}
            queue={queue}
            onShowJob={showJob}
            onFocusRow={handlers.onFocusRow}
            pickSource={handlers.pickSource}
            className="min-w-0 flex-1"
          />
          {closeButton}
        </div>
        <div ref={tabsRef}>
          <Tabs value={tab} onChange={chooseTab} tabs={INSPECTOR_TABS} label={INSPECTOR_COPY.tabs} id={tabsId} />
        </div>
        <TabPanel tabsId={tabsId} value={tab} className="flex flex-col gap-5">
          {tab === 'recipe' && (
            <RecipeTab
              jobs={jobs}
              ctx={ctx}
              drafts={drafts}
              onSelectOnly={(ids) => select(ids)}
              measurement={one === null ? null : detail?.measurement ?? measurements[one.id] ?? null}
            />
          )}
          {tab === 'plan' && (policy === null
            ? <p className="text-body text-ink-2">{INSPECTOR_COPY.planWaiting}</p>
            : (
              <PlanTab
                jobs={jobs}
                detail={detail}
                entries={report?.jobs ?? []}
                policy={policy}
                platform={platform}
                onFix={(fix, ids) => handlers.onFix?.(fix, ids)}
                onAction={(action, ids) => handlers.onPlanAction?.(action, ids)}
                onSelect={(ids) => select(ids)}
                onCopied={() => handlers.onCopied?.('command')}
                onMeasureNow={(jobId) => void actions.send('analyze', { ids: [jobId] })}
              />
            ))}
          {tab === 'result' && (one === null
            ? <p className="text-body text-ink-2">{INSPECTOR_COPY.resultForOne}</p>
            : (
              <ResultTab
                job={one}
                detail={detail}
                nextAttention={nextNeedingAttention(queue, one.id)?.id ?? null}
                onFocusRow={handlers.onFocusRow}
                onFocusTabs={focusTabs}
                onSelectJob={selectJob}
                onEditAndRetry={editAndRetry}
                onReveal={handlers.onReveal}
                onCopied={handlers.onCopied}
              />
            ))}
        </TabPanel>
      </div>
      <ScopeFooter jobs={jobs} fields={fields} className="shrink-0 border-t border-line px-5 py-2.5" />
    </>
  )
}
