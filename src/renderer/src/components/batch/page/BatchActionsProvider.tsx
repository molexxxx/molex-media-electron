/**
 * The page's provider of the Batch view's actions: createBatchActions bound to the window's jobs and view stores,
 * the toast region, the view's LiveRegion, Logs through the app store, and the focused field's draft committer.
 * The actions are built once per mount and disposed when the provider unmounts.
 */
import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createStore, useStore, type StoreApi } from 'zustand'
import type { JobsApi } from '../../../../../shared/jobs/contract'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { Recipe } from '../../../../../shared/jobs/recipes'
import type { BatchPolicy, PlanFix, PreflightReport, RecipePatch } from '../../../../../shared/jobs/types'
import { useAppStore } from '../../../stores/appStore'
import
{
  createBatchActions,
  createDraftCommitters,
  type BatchActions,
  type BatchActionsDeps,
  type BatchToast,
  type DraftCommit,
  type DraftCommitters,
  type Politeness
} from '../../../stores/batchActions'
import { policyInput, type PolicyInput } from '../../../stores/batchUndo'
import { useBatchView, type BatchViewState } from '../../../stores/batchView'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { useAnnounce } from '../../../ui/LiveRegion'
import { useToast, type ToastApi, type ToastOptions } from '../../../ui/Toast'
import { BatchActionsContext } from '../BatchActionsContext'

/** Opens Logs filtered to a job; an attempt narrows it to that attempt's complete FFmpeg log where Logs can. */
export type ShowJobLog = (jobId: JobId, options?: { attempt?: number }) => void

/** The provided actions: the engine commands plus Logs for a job. */
export type PageActions = BatchActions & { showLog: ShowJobLog }

/** A batch toast in the toast region's terms: neutral reads as info, and each action runs on press. */
export function toastOptions(toast: BatchToast): ToastOptions
{
  const options: ToastOptions = {
    tone: toast.tone === 'neutral' ? 'info' : toast.tone,
    title: toast.title
  }
  if (toast.body !== undefined)
  {
    options.body = toast.body
  }
  if (toast.actions !== undefined && toast.actions.length > 0)
  {
    options.actions = toast.actions.map((action) => ({ label: action.label, onAction: () => action.run() }))
  }
  return options
}

/** Opens Logs filtered to the job through the app store. */
export function showJobLog(jobId: JobId): void
{
  useAppStore.getState().showLog({ jobId })
}

/** Shows a file in its folder through the preload, when the preload offers it. */
export function revealInFolder(path: string): void
{
  const api = (window as unknown as { api?: { showInFolder?: (target: string) => Promise<void> } }).api
  void api?.showInFolder?.(path)
}

/** The latest plan main returned for the pending jobs, live or from Review; null before the first. */
export interface ReportState
{
  report: PreflightReport | null
}

/**
 * The engine surface with its preflight replies recorded: a reply counts only when no newer request was sent after
 * it, as the actions themselves ignore a superseded reply.
 */
export function withReportTap(api: JobsApi, reports: StoreApi<ReportState>): JobsApi
{
  let issued = 0
  const preflight: JobsApi['preflight'] = async (request) =>
  {
    issued += 1
    const mine = issued
    const reply = await api.preflight(request)
    if (reply.ok && mine === issued)
    {
      reports.setState({ report: reply.value })
    }
    return reply
  }
  return { ...api, preflight }
}

const NO_REPORTS = createStore<ReportState>(() => ({ report: null }))

const ReportContext = createContext<StoreApi<ReportState>>(NO_REPORTS)

/** The latest plan report, for the Review summary and the Plan tab. */
export function useLatestReport(): PreflightReport | null
{
  return useStore(useContext(ReportContext), (state) => state.report)
}

const CommitDraftContext = createContext<() => Promise<DraftCommit>>(async () => ({ status: 'none' }))

/** Commits the focused field's draft through its blur path, so an action never runs on a value main has not received. */
export function useCommitDraft(): () => Promise<DraftCommit>
{
  return useContext(CommitDraftContext)
}

interface Bound
{
  value: PageActions
  drafts: DraftCommitters
  /** Set when an unmount, or React's development double effect, disposed these actions. */
  disposed: boolean
}

/** Props of {@link BatchActionsProvider}. */
export interface BatchActionsProviderProps
{
  /** The engine surface: the preload's jobs api, the dev preview api, or a test's fake. */
  api: JobsApi
  /** The window's stores by default. */
  jobs?: StoreApi<JobsState>
  view?: StoreApi<BatchViewState>
  /** The toast region; the shell's by default. */
  toasts?: ToastApi
  /** Speaks through the view's LiveRegion by default. */
  announce?: (message: string, politeness?: Politeness) => void
  /** Opens Logs for a job; the app store's showLog by default. */
  showLog?: ShowJobLog
  schedule?: BatchActionsDeps['schedule']
  revealPath?: BatchActionsDeps['revealPath']
  children?: ReactNode
}

/** Provides the Batch view's actions to every region of the page; mount it inside the view's LiveRegion. */
export function BatchActionsProvider({
  api,
  jobs = useJobsStore,
  view = useBatchView,
  toasts,
  announce,
  showLog = showJobLog,
  schedule,
  revealPath = revealInFolder,
  children
}: BatchActionsProviderProps): React.JSX.Element
{
  const shellToasts = useToast()
  const speak = useAnnounce()
  const toastRef = useRef(toasts ?? shellToasts)
  const announceRef = useRef(announce ?? ((message: string) => speak(message)))
  const showLogRef = useRef(showLog)

  useEffect(() =>
  {
    toastRef.current = toasts ?? shellToasts
    announceRef.current = announce ?? ((message: string) => speak(message))
    showLogRef.current = showLog
  })

  const [reports] = useState(() => createStore<ReportState>(() => ({ report: null })))

  const build = (): Bound =>
  {
    const drafts: DraftCommitters = createDraftCommitters()
    const actions = createBatchActions({
      api: withReportTap(api, reports),
      jobs,
      view,
      notify: (toast) => void toastRef.current.show(toastOptions(toast)),
      announce: (message, politeness) => announceRef.current(message, politeness),
      drafts,
      schedule,
      revealPath
    })
    const value: PageActions = { ...actions, showLog: (jobId, options) => showLogRef.current(jobId, options) }
    return { value, drafts, disposed: false }
  }
  const [bound, setBound] = useState(build)

  useEffect(() =>
  {
    if (bound.disposed)
    {
      setBound(build())
      return undefined
    }
    return () =>
    {
      bound.disposed = true
      bound.value.dispose()
    }
  }, [bound])

  return (
    <BatchActionsContext.Provider value={bound.value}>
      <CommitDraftContext.Provider value={bound.drafts.commit}>
        <ReportContext.Provider value={reports}>
          {children}
        </ReportContext.Provider>
      </CommitDraftContext.Provider>
    </BatchActionsContext.Provider>
  )
}

/** One recipe with main's patch applied, or null when the recipe has no such field. */
export function patchRecipe(recipe: Recipe, patch: RecipePatch): Recipe | null
{
  const has = (key: string): boolean => Object.hasOwn(recipe, key)
  switch (patch.field)
  {
    case 'audio':
      return has('audio') ? { ...recipe, audio: patch.value } as Recipe : null
    case 'channels':
      return has('channels') ? { ...recipe, channels: patch.value } as Recipe : null
    case 'sampleRate':
      return has('sampleRate') ? { ...recipe, sampleRate: patch.value } as Recipe : null
    case 'stream':
      return has('stream') ? { ...recipe, stream: patch.value } as Recipe : null
    case 'extract-reencode':
      return has('reencode') ? { ...recipe, reencode: patch.value } as Recipe : null
    case 'video-encoder':
      if (recipe.kind === 'convert' && recipe.video !== null)
      {
        return { ...recipe, video: { ...recipe.video, encoder: patch.value } }
      }
      return recipe.kind === 'compress' && patch.value !== 'copy' ? { ...recipe, encoder: patch.value } : null
    case 'compress-target':
      return recipe.kind === 'compress' ? { ...recipe, target: patch.value, encoder: patch.encoder } : null
    default:
      return null
  }
}

/** The policy a batch fix asks for, or null for a jobs fix. */
export function fixedPolicy(policy: BatchPolicy, fix: PlanFix): PolicyInput | null
{
  const input = policyInput(policy)
  switch (fix.kind)
  {
    case 'set-conflict-rule':
      return { ...input, conflict: fix.rule }
    case 'add-token':
      if (input.template.includes(fix.token))
      {
        return input
      }
      return { ...input, template: fix.token === '{subdir}' ? `${fix.token}/${input.template}` : `${input.template}-${fix.token}` }
    case 'set-gpu':
      return { ...input, gpu: fix.gpu }
    case 'set-displaced':
      return { ...input, displaced: fix.displaced }
    case 'set-destination':
      return { ...input, destination: { mode: 'next-to-source' } }
    default:
      return null
  }
}

/** What a fix did: sent, or nothing to send, with the reason the page announces. */
export type FixOutcome = { status: 'sent' } | { status: 'none'; reason: string }

/** The announcement when a fix has nothing it can change here. */
export const FIX_UNAVAILABLE = 'This fix cannot be applied here. Change it in the Settings tab.'

/**
 * Applies a plan fix: a batch fix changes the output policy, a jobs fix removes the jobs, changes their container,
 * or patches their recipes. Every change goes through the actions, so it re-plans and lands on the undo stack.
 */
export async function applyPlanFix(
  actions: Pick<BatchActions, 'setPolicy' | 'remove' | 'assignRecipes'>,
  state: Pick<JobsState, 'policy' | 'jobs'>,
  fix: PlanFix,
  ids: readonly JobId[]
): Promise<FixOutcome>
{
  if (fix.scope === 'batch')
  {
    const next = state.policy === null ? null : fixedPolicy(state.policy, fix)
    if (next === null)
    {
      return { status: 'none', reason: FIX_UNAVAILABLE }
    }
    await actions.setPolicy(next)
    return { status: 'sent' }
  }
  if (fix.kind === 'remove')
  {
    await actions.remove(ids)
    return { status: 'sent' }
  }
  const assignments: Array<{ jobId: JobId; recipe: Recipe }> = []
  for (const id of ids)
  {
    const job = state.jobs[id]
    if (job === undefined)
    {
      continue
    }
    const recipe = fix.kind === 'set-container'
      ? (Object.hasOwn(job.recipe, 'container') ? { ...job.recipe, container: fix.container } as Recipe : null)
      : fix.kind === 'patch-recipe' ? patchRecipe(job.recipe, fix.patch) : null
    if (recipe !== null)
    {
      assignments.push({ jobId: id, recipe })
    }
  }
  if (assignments.length === 0)
  {
    return { status: 'none', reason: FIX_UNAVAILABLE }
  }
  await actions.assignRecipes(assignments, { field: fix.kind === 'patch-recipe' ? fix.label : 'Container' })
  return { status: 'sent' }
}
