/**
 * Every command the Batch view starts, in one place: adds and pastes, queue edits with their undo entries, the live
 * plan, Review, Start and Append with the report id and acknowledgment counts, run control, per-job intervention,
 * decisions, acknowledgments, Clear, reports, and History. The actions hold no React state: they read and drive
 * the jobs and view stores and speak through an injected notifier and announcer, so the page's provider binds them
 * to its toasts and live region and a test binds them to fakes. No command rejects; every outcome is a value.
 */
import type { StoreApi } from 'zustand'
import type
{
  Ack,
  AddResult,
  ClearScope,
  CommandError,
  CommandErrorCode,
  CommandResult,
  JobCommandName,
  JobCommandRequest,
  JobCommandResponse,
  JobsApi,
  PerJob
} from '../../../shared/jobs/contract'
import { formatRunLabel, type JobId, type RunId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import { needsAttention, needsDecision } from '../../../shared/jobs/states'
import type { BatchPolicy, JobState, PauseMode, PreflightReport, RunState, ScanState, SourceRef } from '../../../shared/jobs/types'
import { reviewAwaitsAcknowledgment, reviewNeedsAcknowledgment, type BatchViewState } from './batchView'
import
{
  countOf,
  createUndoHistory,
  policyInput,
  settleCommand,
  type PolicyInput,
  type RecipeChange,
  type UndoHistory,
  type UndoOutcome
} from './batchUndo'
import { whenApplied, type JobsState } from './jobs'
import { selectOrderedJobs } from './jobsSelectors'

/** How long after the last change to a plan input the page asks main to re-plan the pending jobs. */
export const LIVE_PREFLIGHT_DELAY_MS = 400

/** The History search's page size. */
export const HISTORY_SEARCH_LIMIT = 200

/** A toast's button. */
export interface BatchToastAction
{
  label: string
  run(): void
}

/** A toast the page shows through the injected notifier. */
export interface BatchToast
{
  tone: 'neutral' | 'success' | 'warning' | 'error'
  title: string
  body?: string
  actions?: BatchToastAction[]
  /** Error toasts stay until dismissed. */
  persist?: boolean
}

/** How urgently the live region speaks. */
export type Politeness = 'polite' | 'assertive'

/**
 * What committing the focused field's draft did: nothing to commit, a valid draft sent (its command's seq, and the
 * field and jobs when known, for the stale-plan wording), or an invalid draft, which refuses the action.
 */
export type DraftCommit =
  | { status: 'none' }
  | { status: 'committed'; seq: number; field?: string; ids?: readonly JobId[] }
  | { status: 'invalid'; field: string }

/** Commits the focused field's draft through the same path as blur. */
export type DraftCommitter = () => DraftCommit | Promise<DraftCommit>

/** The one committer the focused field registers. */
export interface DraftCommitters
{
  /** Registers the focused field's committer; the returned function unregisters it if it is still the current one. */
  register(committer: DraftCommitter): () => void
  commit(): Promise<DraftCommit>
}

/** A registry of the focused field's committer; a committer that throws counts as an invalid draft. */
export function createDraftCommitters(): DraftCommitters
{
  let current: DraftCommitter | null = null
  return {
    register(committer: DraftCommitter): () => void
    {
      current = committer
      return () =>
      {
        if (current === committer)
        {
          current = null
        }
      }
    },
    async commit(): Promise<DraftCommit>
    {
      const committer = current
      if (committer === null)
      {
        return { status: 'none' }
      }
      try
      {
        return await committer()
      }
      catch
      {
        return { status: 'invalid', field: 'the edited field' }
      }
    }
  }
}

/** What the actions read and drive. */
export interface BatchActionsDeps
{
  api: JobsApi
  jobs: StoreApi<JobsState>
  view: StoreApi<BatchViewState>
  notify(toast: BatchToast): void
  announce(message: string, politeness?: Politeness): void
  /** The focused field's committer registry; a fresh one by default. */
  drafts?: DraftCommitters
  /** Runs fn after ms and returns a cancel; window timers by default. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Shows a saved file in its folder, for the report toast's "Show in folder". */
  revealPath?: (path: string) => void
}

/** A refused command, worded for the page. */
export interface Refused
{
  status: 'refused'
  code: CommandErrorCode | 'nothing'
  message: string
}

/** A command that was applied: its reply and the last event seq it caused. */
export interface Done<T>
{
  status: 'done'
  value: T
  seq: number
}

/** Every command's outcome. */
export type Outcome<T> = Done<T> | Refused

/** How an add enters the queue. */
export interface AddOptions
{
  origin?: SourceRef['origin']
  /** The recipe for the new jobs; null gives them the "New files get" recipe. */
  recipe?: Recipe | null
  /** Folders scan their subfolders; "Include subfolders" by default. */
  recursive?: boolean
  after?: JobId | null
  allowSecondJobs?: boolean
  force?: boolean
}

/** What an add set aside, for its toast and the "Show skipped" list. */
export interface AddSkipped
{
  duplicates: { paths: string[]; jobIds: JobId[] }
  previousOutputs: string[]
  notMedia: string[]
  other: Array<{ path: string; message: string }>
  /** What the folder scans set aside; scans count these without naming paths. */
  scanned: { duplicates: number; previousOutputs: number; notMedia: number; links: number; unreadable: number }
}

/** An add's outcome: the reply and its undo entry, the clipboard holding nothing usable, or a refusal. */
export type AddOutcome =
  | { status: 'done'; value: AddResult; seq: number; entryId: number | null }
  | { status: 'empty' }
  | Refused

/** A queue edit's outcome: the reply and its undo entry, when it recorded one. */
export type EditOutcome<T> = (Done<T> & { entryId: number | null }) | Refused

/** The toast a recipe change shows: an applied preset with an optional note, or an operation change. */
export type AssignToast =
  | { kind: 'applied'; preset: string; note?: string | null }
  | { kind: 'operation'; label: string }

/** How a recipe change is confirmed and named. */
export interface AssignOptions
{
  /** None for a field edit. */
  toast?: AssignToast | null
  /** The field a draft set ("Target, integrated"), named when a Start comes back stale. */
  field?: string
  /** "Edit and retry": the change also reaches finished jobs, which then wait in the queue for their next attempt. */
  retryDraft?: boolean
}

/** Where a move puts the selected jobs. */
export type MoveTarget = 'up' | 'down' | 'top' | 'bottom'

/**
 * The reorder for a move among the jobs that can move (pending and queued): the selected ones in queue order and
 * the job they go before, or null for the end. Null when the move changes nothing.
 */
export function moveBefore(state: Pick<JobsState, 'order' | 'jobs'>, ids: readonly JobId[], where: MoveTarget): { ids: JobId[]; before: JobId | null } | null
{
  const chosen = new Set(ids)
  const movable = state.order.filter((id) =>
  {
    const job = state.jobs[id]
    return job !== undefined && (job.state === 'pending' || job.state === 'queued')
  })
  const moving = movable.filter((id) => chosen.has(id))
  if (moving.length === 0)
  {
    return null
  }
  const first = movable.indexOf(moving[0])
  const last = movable.indexOf(moving[moving.length - 1])
  const contiguous = last - first + 1 === moving.length
  switch (where)
  {
    case 'top':
      return contiguous && first === 0 ? null : { ids: moving, before: movable.find((id) => !chosen.has(id)) ?? null }
    case 'bottom':
      return contiguous && last === movable.length - 1 ? null : { ids: moving, before: null }
    case 'up':
      return first === 0 ? null : { ids: moving, before: movable[first - 1] }
    default:
      return last === movable.length - 1 ? null : { ids: moving, before: movable[last + 2] ?? null }
  }
}

/** An action refused because the focused field's draft is invalid. */
export interface InvalidDraft
{
  status: 'invalid-draft'
  field: string
}

/** A preflight's outcome; a superseded one is ignored, because a newer request covers it. */
export type PreflightOutcome = Done<PreflightReport> | Refused | { status: 'superseded' }

/**
 * What Start, Start only the selected, and Append did: started (or appended), stale with the reason Review shows,
 * waiting for the acknowledgment (with the notice when a count changed), refused by an invalid draft, not ready
 * (with the reason shown beside Start), ignored while an earlier press is answered, or refused by main.
 */
export type StartOutcome =
  | { status: 'started'; runId: RunId; queued: JobId[]; skipped: JobId[]; blocked: JobId[]; appended: boolean }
  | { status: 'stale'; changed: JobId[]; reason: string }
  | { status: 'needs-acknowledgment'; notice: string | null }
  | InvalidDraft
  | { status: 'not-ready'; reason: string }
  | { status: 'busy' }
  | Refused

/** What Resume did: resumed, waiting for a restored batch's acknowledgment, refused by an invalid draft, or refused. */
export type ResumeOutcome = Done<RunState> | { status: 'needs-acknowledgment' } | InvalidDraft | Refused

/** A retry's reply: the jobs queued, the jobs waiting in the queue, and the jobs whose plans changed. */
export type RetryResult = JobCommandResponse<'retry'>

/** What a retry did: the reply, the acknowledgment a destructive retry asks for first, an invalid draft, or a refusal. */
export type RetryOutcome = Done<RetryResult> | { status: 'needs-acknowledgment'; ack: Ack } | InvalidDraft | Refused

/** What a decision did: the reply, the inline confirmation a displacing placement asks for first, or a refusal. */
export type DecisionOutcome = Done<PerJob> | { status: 'needs-confirmation'; displaces: number } | Refused

/** How Delete treats each selected job, by its state. */
export interface DeletePlan
{
  /** Jobs not in a batch: removed, with Undo. */
  remove: JobId[]
  /** Queued jobs: skipped; several ask first. */
  skip: JobId[]
  /** Finished jobs that need no attention: cleared from the table; their records stay in History. */
  clear: JobId[]
  /** Running jobs: never stopped by Delete. */
  running: JobId[]
  /** Finished and held jobs that need attention: they stay until acknowledged or decided. */
  attention: JobId[]
}

/** What Delete did: each part's outcome, or the confirmation several skips ask for first. */
export type DeleteOutcome =
  | { status: 'done'; plan: DeletePlan }
  | { status: 'needs-confirmation'; plan: DeletePlan }
  | Refused

const RUNNING_STATES: ReadonlySet<JobState> = new Set<JobState>(['analyzing', 'encoding', 'verifying', 'finalizing'])

const QUEUED_STATES: ReadonlySet<JobState> = new Set<JobState>(['queued'])

const HELD_STATES: ReadonlySet<JobState> = new Set<JobState>(['held'])

const FINISHED_STATES: ReadonlySet<JobState> = new Set<JobState>(['done', 'failed', 'canceled', 'skipped', 'interrupted'])

/** Sorts the selected jobs by what Delete does to each. */
export function planDelete(state: Pick<JobsState, 'jobs'>, ids: readonly JobId[]): DeletePlan
{
  const plan: DeletePlan = { remove: [], skip: [], clear: [], running: [], attention: [] }
  for (const id of ids)
  {
    const job = state.jobs[id]
    if (job === undefined)
    {
      continue
    }
    if (job.state === 'pending')
    {
      plan.remove.push(id)
    }
    else if (job.state === 'queued')
    {
      plan.skip.push(id)
    }
    else if (RUNNING_STATES.has(job.state))
    {
      plan.running.push(id)
    }
    else if (needsAttention(job))
    {
      plan.attention.push(id)
    }
    else
    {
      plan.clear.push(id)
    }
  }
  return plan
}

/** "12 jobs in 5 batches match “interview”." */
export function searchSummary(matches: number, runs: number, query: string): string
{
  const text = query.trim()
  if (matches === 0)
  {
    return `No jobs match “${text}”.`
  }
  return `${countOf(matches, 'job')} in ${countOf(runs, 'batch', 'batches')} ${matches === 1 ? 'matches' : 'match'} “${text}”.`
}

/** The offer after a Locate in another folder: "Relink 23 more jobs from D:\Rips\Old to E:\Rips\New?" */
export function relinkOffer(relinkable: { fromDir: string; toDir: string; ids: readonly JobId[] }): string
{
  return `Relink ${countOf(relinkable.ids.length, 'more job')} from ${relinkable.fromDir} to ${relinkable.toDir}?`
}

/** Where a trashed original may still be: "the Recycle Bin on D:" on Windows, the Trash elsewhere. */
export function binOf(path: string): string
{
  const volume = /^([A-Za-z]:)/.exec(path)
  return volume === null ? 'the Trash' : `the Recycle Bin on ${volume[1].toUpperCase()}`
}

/** Whether a preflight's ids are the Review session's scope (its subset, or every job not in a batch). */
export function sameScope(ids: readonly JobId[] | 'pending', subset: readonly string[] | null): boolean
{
  if (subset === null || ids === 'pending')
  {
    return subset === null && ids === 'pending'
  }
  const wanted = new Set<string>(subset)
  return ids.length === subset.length && ids.every((id) => wanted.has(id))
}

function sameRecipe(a: Recipe, b: Recipe): boolean
{
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function pendingOrder(state: JobsState): JobId[]
{
  return state.order.filter((id) => state.jobs[id]?.state === 'pending')
}

/**
 * Whether a store change touched a plan input: the output policy, which jobs wait and in what order, or a waiting
 * job's recipe, source, or input revision. Measurements, plans, progress, and run state are not plan inputs.
 */
export function planInputsChanged(previous: JobsState, next: JobsState): boolean
{
  if ((previous.policy?.rev ?? null) !== (next.policy?.rev ?? null))
  {
    return true
  }
  if (previous.order === next.order && previous.jobs === next.jobs)
  {
    return false
  }
  const before = pendingOrder(previous)
  const after = pendingOrder(next)
  if (before.length !== after.length)
  {
    return true
  }
  return after.some((id, index) =>
  {
    if (before[index] !== id)
    {
      return true
    }
    const a = previous.jobs[id]
    const b = next.jobs[id]
    if (a === b)
    {
      return false
    }
    return a.inputsRev !== b.inputsRev
      || a.source.path !== b.source.path || a.source.size !== b.source.size || a.source.mtimeMs !== b.source.mtimeMs
      || !sameRecipe(a.recipe, b.recipe)
  })
}

/** "2 jobs that need attention stay until acknowledged." */
export function attentionStays(count: number): string
{
  return count === 1
    ? '1 job that needs attention stays until acknowledged.'
    : `${countOf(count, 'job')} that need attention stay until acknowledged.`
}

/** The add-toast body: "Skipped 9 that are not media, 3 already in the queue, and 120 outputs of earlier batches." */
export function skippedSentence(notMedia: number, duplicates: number, previousOutputs: number): string | null
{
  const parts: string[] = []
  if (notMedia > 0)
  {
    parts.push(`${notMedia.toLocaleString('en-US')} that ${notMedia === 1 ? 'is' : 'are'} not media`)
  }
  if (duplicates > 0)
  {
    parts.push(`${duplicates.toLocaleString('en-US')} already in the queue`)
  }
  if (previousOutputs > 0)
  {
    parts.push(`${countOf(previousOutputs, 'output')} of earlier batches`)
  }
  return parts.length === 0 ? null : `Skipped ${joinList(parts)}.`
}

/** "a", "a and b", "a, b, and c". */
export function joinList(parts: readonly string[]): string
{
  if (parts.length <= 2)
  {
    return parts.join(' and ')
  }
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function refused(error: CommandError): Refused
{
  return { status: 'refused', code: error.code, message: error.message }
}

function nothingToDo(message: string): Refused
{
  return { status: 'refused', code: 'nothing', message }
}

function normalizedPath(path: string): string
{
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isUnder(path: string, root: string): boolean
{
  const normalized = normalizedPath(path)
  return normalized === root || normalized.startsWith(`${root}/`)
}

const NOT_MEDIA_CODES: ReadonlySet<string> = new Set(['not-media', 'unsupported'])

function defaultSchedule(fn: () => void, ms: number): () => void
{
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

/** The Batch view's commands over the given engine surface, stores, notifier, and announcer. */
export function createBatchActions(deps: BatchActionsDeps)
{
  const { api, jobs, view, notify, announce } = deps
  const drafts = deps.drafts ?? createDraftCommitters()
  const schedule = deps.schedule ?? defaultSchedule
  const watchers = new Set<() => void>()
  const history: UndoHistory = createUndoHistory({ api, getJobs: () => jobs.getState() })

  function call<T>(send: () => Promise<CommandResult<T>>): Promise<CommandResult<T>>
  {
    return settleCommand(send)
  }

  function applied(seq: number): Promise<void>
  {
    return whenApplied(seq, jobs)
  }

  function includeSubfolders(): boolean
  {
    return jobs.getState().settings?.includeSubfolders ?? true
  }

  function inRunMode(): boolean
  {
    return view.getState().mode === 'run'
  }

  function skippedOf(result: AddResult): AddSkipped
  {
    const notMedia = result.refused.filter((entry) => NOT_MEDIA_CODES.has(entry.code)).map((entry) => entry.path)
    const other = result.refused.filter((entry) => !NOT_MEDIA_CODES.has(entry.code)).map((entry) => ({ path: entry.path, message: entry.message }))
    return {
      duplicates: { paths: [...result.duplicates.paths], jobIds: [...result.duplicates.jobIds] },
      previousOutputs: [...result.previousOutputs],
      notMedia,
      other,
      scanned: { duplicates: 0, previousOutputs: 0, notMedia: 0, links: 0, unreadable: 0 }
    }
  }

  function withScans(skipped: AddSkipped, scans: readonly ScanState[]): AddSkipped
  {
    const scanned = { ...skipped.scanned }
    for (const scan of scans)
    {
      scanned.duplicates += scan.excluded.duplicates
      scanned.previousOutputs += scan.excluded.previousOutputs
      scanned.notMedia += scan.excluded.unsupported
      scanned.links += scan.excluded.links
      scanned.unreadable += scan.excluded.unreadable
    }
    return { ...skipped, scanned }
  }

  function skippedTotal(skipped: AddSkipped): number
  {
    const { scanned } = skipped
    return skipped.duplicates.paths.length + skipped.previousOutputs.length + skipped.notMedia.length + skipped.other.length
      + scanned.duplicates + scanned.previousOutputs + scanned.notMedia + scanned.links + scanned.unreadable
  }

  /** The "Show skipped" list: what was set aside, and the ways to add it anyway. */
  function showSkipped(skipped: AddSkipped): void
  {
    const duplicates = skipped.duplicates.paths.length + skipped.scanned.duplicates
    const previous = skipped.previousOutputs.length + skipped.scanned.previousOutputs
    const notMedia = skipped.notMedia.length + skipped.scanned.notMedia
    const heads: string[] = []
    if (duplicates > 0)
    {
      heads.push(`Already in the queue: ${duplicates.toLocaleString('en-US')}`)
    }
    if (previous > 0)
    {
      heads.push(`Outputs of earlier batches: ${previous.toLocaleString('en-US')}`)
    }
    if (notMedia > 0)
    {
      heads.push(`Not media: ${notMedia.toLocaleString('en-US')}`)
    }
    const lines: string[] = []
    if (skipped.scanned.unreadable > 0)
    {
      lines.push(`Skipped ${countOf(skipped.scanned.unreadable, 'folder')} that could not be read.`)
    }
    if (skipped.scanned.links > 0)
    {
      lines.push(`Skipped ${countOf(skipped.scanned.links, 'link')}: folder links are not followed.`)
    }
    lines.push(...skipped.other.map((entry) => entry.message))
    const actions: BatchToastAction[] = []
    if (skipped.duplicates.jobIds.length > 0)
    {
      actions.push({ label: 'Select them', run: () => selectRows(skipped.duplicates.jobIds) })
    }
    if (skipped.duplicates.paths.length > 0)
    {
      actions.push({ label: 'Add as second jobs', run: () => void addPaths(skipped.duplicates.paths, { allowSecondJobs: true }) })
    }
    if (skipped.previousOutputs.length > 0)
    {
      actions.push({ label: 'Add them anyway', run: () => void addPaths(skipped.previousOutputs, { force: true }) })
    }
    const title = heads.length > 0 ? heads.join(' · ') : lines.shift() ?? 'Nothing was skipped.'
    notify({ tone: 'neutral', title, body: lines.length > 0 ? lines.join(' ') : undefined, actions })
  }

  /** Selects rows in the list on show: the add's selection in Queue, a plain selection elsewhere. */
  function selectRows(ids: readonly JobId[]): void
  {
    if (ids.length === 0)
    {
      return
    }
    const state = view.getState()
    if (state.mode === 'queue')
    {
      state.selectAdded(ids)
      return
    }
    if (state.mode === 'review')
    {
      state.select('review', { type: 'selectAll', ids })
    }
  }

  function addToast(added: readonly JobId[], skipped: AddSkipped, entryId: number | null): void
  {
    const notMedia = skipped.notMedia.length + skipped.scanned.notMedia
    const duplicates = skipped.duplicates.paths.length + skipped.scanned.duplicates
    const previous = skipped.previousOutputs.length + skipped.scanned.previousOutputs
    const actions: BatchToastAction[] = []
    if (added.length > 0)
    {
      actions.push({ label: 'Select added', run: () => view.getState().selectAdded(added) })
    }
    if (skippedTotal(skipped) > 0)
    {
      actions.push({ label: 'Show skipped', run: () => showSkipped(skipped) })
    }
    if (entryId !== null)
    {
      actions.push({ label: 'Undo', run: () => void undo(entryId) })
    }
    notify({
      tone: added.length > 0 ? 'success' : 'neutral',
      title: added.length > 0 ? `Added ${countOf(added.length, 'file')}.` : 'No files were added.',
      body: skippedSentence(notMedia, duplicates, previous) ?? undefined,
      actions
    })
  }

  /**
   * Follows an add's folder scans: rows they find join the end of the queue, extend the add's selection while the
   * user has not changed it, and join the add's undo entry; when every scan settles the add toast confirms it.
   */
  function followScans(scanIds: readonly string[], known: Set<JobId>, added: JobId[], skipped: AddSkipped, entryId: number | null): void
  {
    let entry = entryId
    const selectionAtAdd = view.getState().views.queue.selection
    const ours = (state: JobsState): ScanState[] => state.scans.filter((scan) => scanIds.includes(scan.scanId))
    const join = (found: JobId[]): void =>
    {
      const current = view.getState()
      if (added.length === found.length && current.views.queue.selection === selectionAtAdd)
      {
        current.selectAdded(found)
        return
      }
      current.extendAdded(found)
    }
    const settle = (state: JobsState): boolean =>
    {
      const scans = ours(state)
      const roots = scans.map((scan) => normalizedPath(scan.root))
      const found: JobId[] = []
      for (const id of state.order)
      {
        if (known.has(id))
        {
          continue
        }
        known.add(id)
        const job = state.jobs[id]
        if (job !== undefined && job.source.origin === 'folder' && roots.some((root) => isUnder(job.source.path, root)))
        {
          found.push(id)
        }
      }
      if (found.length > 0)
      {
        added.push(...found)
        if (entry === null)
        {
          entry = history.record({ kind: 'add', ids: [...found], tombstone: null }).id
        }
        else
        {
          history.amend(entry, (edit) => (edit.kind === 'add' ? { ...edit, ids: [...edit.ids, ...found] } : edit))
        }
        if (!inRunMode())
        {
          join(found)
        }
      }
      if (scans.some((scan) => scan.status === 'scanning'))
      {
        return false
      }
      for (const scan of scans)
      {
        if (scan.status === 'failed')
        {
          notify({
            tone: 'error',
            title: `Folder scan stopped: ${(scan.error ?? `${scan.root} could not be read`).replace(/\.$/, '')}.`,
            body: `Added ${countOf(scan.added, 'file')} found before the error.`,
            persist: true
          })
        }
      }
      addToast(added, withScans(skipped, scans), entry)
      return true
    }
    if (settle(jobs.getState()))
    {
      return
    }
    const stop = jobs.subscribe((state) =>
    {
      if (settle(state))
      {
        stop()
        watchers.delete(stop)
      }
    })
    watchers.add(stop)
  }

  async function settleAdd(reply: CommandResult<AddResult>, before: readonly JobId[]): Promise<AddOutcome>
  {
    if (!reply.ok)
    {
      notify({ tone: 'error', title: reply.error.message })
      return refused(reply.error)
    }
    const result = reply.value
    const entryId = result.added.length > 0 ? history.record({ kind: 'add', ids: [...result.added], tombstone: null }).id : null
    await applied(reply.seq)
    if (!inRunMode())
    {
      view.getState().selectAdded(result.added)
    }
    const skipped = skippedOf(result)
    if (result.scanIds.length === 0)
    {
      addToast(result.added, skipped, entryId)
    }
    else
    {
      followScans(result.scanIds, new Set([...before, ...result.added]), [...result.added], skipped, entryId)
    }
    return { status: 'done', value: result, seq: reply.seq, entryId }
  }

  /** Adds files and folders: one jobs:add with the "New files get" recipe unless another is given. */
  async function addPaths(paths: readonly string[], options: AddOptions = {}): Promise<AddOutcome>
  {
    const before = [...jobs.getState().order]
    const reply = await call(() => api.add({
      paths: [...paths],
      recipe: options.recipe ?? null,
      origin: options.origin ?? 'files',
      after: options.after ?? null,
      recursive: options.recursive ?? includeSubfolders(),
      allowSecondJobs: options.allowSecondJobs ?? false,
      force: options.force ?? false
    }))
    return settleAdd(reply, before)
  }

  /** Ctrl+V: main reads the clipboard's file list first, then its text as paths. */
  async function pasteFiles(): Promise<AddOutcome>
  {
    const before = [...jobs.getState().order]
    const reply = await call(() => api.pasteFiles({ recipe: null, recursive: includeSubfolders() }))
    if (reply.ok && reply.value.source === 'empty')
    {
      notify({ tone: 'neutral', title: 'The clipboard has no files or file paths.' })
      return { status: 'empty' }
    }
    return settleAdd(reply, before)
  }

  let editMark = 0
  let lastEdit: { label: string; ids: ReadonlySet<JobId> | null; mark: number } | null = null

  /** Remembers the user's latest plan-input edit, so a stale Start can name it. */
  function noteEdit(label: string, ids: Iterable<JobId> | null): void
  {
    editMark += 1
    lastEdit = { label, ids: ids === null ? null : new Set(ids), mark: editMark }
  }

  function undoAction(entryId: number | null): BatchToastAction[]
  {
    return entryId === null ? [] : [{ label: 'Undo', run: () => void undo(entryId) }]
  }

  function refusedToast(error: CommandError): Refused
  {
    notify({ tone: 'error', title: error.message })
    return refused(error)
  }

  /**
   * Sets recipes on jobs not in a batch, one assignment per job, as one command and one undo entry. Queued,
   * running, and finished jobs keep their recipes. An applied preset or an operation change confirms with a toast;
   * a field edit does not.
   */
  async function assignRecipes(assignments: ReadonlyArray<{ jobId: JobId; recipe: Recipe }>, options: AssignOptions = {}): Promise<EditOutcome<PerJob>>
  {
    const state = jobs.getState()
    const editable = assignments.filter((entry) =>
    {
      const jobState = state.jobs[entry.jobId]?.state
      return jobState === 'pending' || (options.retryDraft === true && jobState !== undefined && FINISHED_STATES.has(jobState))
    })
    if (editable.length === 0)
    {
      return nothingToDo('Queued, running, and finished jobs keep their settings.')
    }
    const before = new Map(editable.map((entry) => [entry.jobId, state.jobs[entry.jobId].recipe]))
    const reply = await call(() => api.assignRecipe({ assignments: editable.map((entry) => ({ jobId: entry.jobId, recipe: entry.recipe })) }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const appliedIds = new Set(reply.value.applied)
    const changes: RecipeChange[] = editable
      .filter((entry) => appliedIds.has(entry.jobId))
      .map((entry) => ({ jobId: entry.jobId, before: before.get(entry.jobId) as Recipe, after: entry.recipe }))
    const entryId = changes.length > 0 ? history.record({ kind: 'recipe', changes }).id : null
    if (changes.length > 0)
    {
      noteEdit(options.field ?? 'Recipe', reply.value.applied)
      const toast = options.toast ?? null
      const jobsText = countOf(changes.length, 'job')
      if (toast !== null)
      {
        notify({
          tone: 'success',
          title: toast.kind === 'applied' ? `Applied ${toast.preset} to ${jobsText}.` : `Changed ${jobsText} to ${toast.label}.`,
          body: toast.kind === 'applied' && toast.note ? toast.note : undefined,
          actions: undoAction(entryId)
        })
      }
    }
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Duplicate job, or a second job per source with a chosen recipe; the new jobs follow their originals and become the selection. */
  async function duplicate(ids: readonly JobId[], options: { recipe?: Recipe | null; preset?: string } = {}): Promise<EditOutcome<PerJob & { created: JobId[] }>>
  {
    const reply = await call(() => api.duplicate({ ids: [...ids], recipe: options.recipe ?? null }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const created = reply.value.created
    const entryId = created.length > 0 ? history.record({ kind: 'duplicate', ids: [...created], tombstone: null }).id : null
    await applied(reply.seq)
    if (created.length > 0)
    {
      selectRows(created)
      const jobsText = countOf(created.length, 'job')
      notify({
        tone: 'success',
        title: options.preset === undefined ? `Duplicated ${jobsText}.` : `Added ${jobsText} with ${options.preset}.`,
        actions: undoAction(entryId)
      })
    }
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Removes jobs; main keeps them as a tombstone, so Undo restores them with their numbers and positions. */
  async function remove(ids: readonly JobId[]): Promise<EditOutcome<PerJob & { tombstone: string | null }>>
  {
    const reply = await call(() => api.remove({ ids: [...ids] }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const { applied: removed, tombstone } = reply.value
    const entryId = removed.length > 0 && tombstone !== null ? history.record({ kind: 'remove', ids: [...removed], tombstone }).id : null
    if (removed.length > 0)
    {
      noteEdit('Queue', removed)
      notify({ tone: 'neutral', title: `Removed ${countOf(removed.length, 'job')}.`, actions: undoAction(entryId) })
    }
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Moves jobs, in their relative order, before another job or to the end. */
  async function reorder(ids: readonly JobId[], before: JobId | null): Promise<EditOutcome<PerJob>>
  {
    const previous = [...jobs.getState().order]
    const reply = await call(() => api.reorder({ ids: [...ids], before }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const moved = reply.value.applied
    const entryId = moved.length > 0 ? history.record({ kind: 'reorder', ids: [...moved], before, previous }).id : null
    if (moved.length > 0)
    {
      noteEdit('Queue order', moved)
    }
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Move up, Move down, Move to top (Run next), and Move to bottom. */
  async function move(ids: readonly JobId[], where: MoveTarget): Promise<EditOutcome<PerJob>>
  {
    const target = moveBefore(jobs.getState(), ids, where)
    if (target === null)
    {
      return nothingToDo('Nothing to move.')
    }
    return reorder(target.ids, target.before)
  }

  /** Clear done, Clear finished, or Remove jobs not in a batch; jobs that need attention always stay. */
  async function clear(scope: ClearScope): Promise<EditOutcome<{ removed: number; kept: number; tombstone: string | null }>>
  {
    const reply = await call(() => api.clear({ scope }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const { removed, kept, tombstone } = reply.value
    const ids = scope.kind === 'ids' ? [...scope.ids] : []
    const entryId = removed > 0 && tombstone !== null ? history.record({ kind: 'clear', ids, count: removed, tombstone }).id : null
    const stay = kept > 0 ? attentionStays(kept) : undefined
    if (removed > 0)
    {
      notify({ tone: 'neutral', title: `Cleared ${countOf(removed, 'job')}.`, body: stay, actions: undoAction(entryId) })
    }
    else if (stay !== undefined)
    {
      notify({ tone: 'warning', title: stay })
    }
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Changes the output settings; refused while a batch has queued or running jobs. */
  async function setPolicy(policy: PolicyInput): Promise<EditOutcome<{ policy: BatchPolicy; demoted: JobId[] }>>
  {
    const previous = jobs.getState().policy
    const reply = await call(() => api.setPolicy({ policy }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const entryId = previous === null ? null : history.record({ kind: 'policy', before: policyInput(previous), after: policyInput(reply.value.policy) }).id
    noteEdit('Output settings', null)
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  let liveCancel: (() => void) | null = null
  let liveDeferred = false
  let generation = 0
  let inFlight: { generation: number; purpose: 'live' | 'review'; mark: number } | null = null
  let latestReport: PreflightReport | null = null

  /** The jobs the Review session covers: its subset, or every job not in a batch. */
  function sessionScope(): JobId[] | 'pending'
  {
    const subset = view.getState().review.subset
    return subset === null ? 'pending' : subset.map((id) => id as JobId)
  }

  /** The live plan covers the subset while Review shows one, else every job not in a batch. */
  function liveScope(): JobId[] | 'pending'
  {
    return view.getState().mode === 'review' ? sessionScope() : 'pending'
  }

  function scopeSize(ids: JobId[] | 'pending'): number
  {
    const state = jobs.getState()
    return ids === 'pending' ? state.order.filter((id) => state.jobs[id]?.state === 'pending').length : ids.length
  }

  /**
   * Asks main to plan jobs. A newer request supersedes an older one, whose reply is then ignored. A report for the
   * Review session's scope goes to the session, which keeps the acknowledgment while the counts hold.
   */
  async function preflight(ids: JobId[] | 'pending', purpose: 'live' | 'review'): Promise<PreflightOutcome>
  {
    generation += 1
    const flight = { generation, purpose, mark: editMark }
    inFlight = flight
    const reply = await call(() => api.preflight({ ids }))
    if (inFlight === flight)
    {
      inFlight = null
    }
    if (flight.generation !== generation || (!reply.ok && reply.error.code === 'superseded'))
    {
      return { status: 'superseded' }
    }
    if (liveDeferred)
    {
      liveDeferred = false
      scheduleLive()
    }
    if (!reply.ok)
    {
      return refused(reply.error)
    }
    const report = reply.value
    latestReport = report
    const state = view.getState()
    if (sameScope(ids, state.review.subset))
    {
      const notice = state.receiveReport({ reportId: report.preflightId, originalsAffected: report.counts.originalsAffected, overwrites: report.counts.overwrites })
      if (notice !== null)
      {
        announce(notice)
      }
      if (lastEdit !== null && lastEdit.mark <= flight.mark)
      {
        lastEdit = null
      }
    }
    return { status: 'done', value: report, seq: reply.seq }
  }

  function scheduleLive(): void
  {
    liveCancel?.()
    liveCancel = schedule(runLive, LIVE_PREFLIGHT_DELAY_MS)
  }

  function runLive(): void
  {
    liveCancel = null
    if (jobs.getState().status !== 'hydrated')
    {
      return
    }
    if (inFlight !== null && inFlight.purpose === 'review')
    {
      liveDeferred = true
      return
    }
    const ids = liveScope()
    if (scopeSize(ids) > 0)
    {
      void preflight(ids, 'live')
    }
  }

  const stopPlanWatch = jobs.subscribe((state, previous) =>
  {
    if (state.status === 'hydrated' && previous.status === 'hydrated' && planInputsChanged(previous, state))
    {
      scheduleLive()
    }
  })

  /** The window regained focus: sources may have changed, so plan the pending jobs now. */
  function windowFocused(): void
  {
    liveCancel?.()
    runLive()
  }

  /** Normalize and Gain jobs in the session that have no measurement and none on its way. */
  function unmeasured(): JobId[]
  {
    const state = jobs.getState()
    const scope = sessionScope()
    return (scope === 'pending' ? state.order : scope).filter((id) =>
    {
      const job = state.jobs[id]
      return job !== undefined && job.state === 'pending' && (job.recipe.kind === 'normalize' || job.recipe.kind === 'boost')
        && job.analysis === null && !job.previewed && job.audioPlan === null
    })
  }

  /** Measures unmeasured loudness jobs when Review opens, unless Settings turned it off; results never make the report stale. */
  async function measureForReview(): Promise<Outcome<PerJob> | null>
  {
    if (jobs.getState().settings?.measureOnReview === false)
    {
      return null
    }
    const ids = unmeasured()
    if (ids.length === 0)
    {
      return null
    }
    const reply = await call(() => api.analyze({ ids }))
    return reply.ok ? { status: 'done', value: reply.value, seq: reply.seq } : refused(reply.error)
  }

  /** "Stop measuring". */
  async function stopMeasuring(): Promise<Outcome<PerJob>>
  {
    const reply = await call(() => api.cancelAnalyze({ ids: 'all' }))
    return reply.ok ? { status: 'done', value: reply.value, seq: reply.seq } : refused(reply.error)
  }

  /** The full preflight of the Review session's jobs. */
  function refreshReview(): Promise<PreflightOutcome>
  {
    return preflight(sessionScope(), 'review')
  }

  /**
   * Commit before acting: sends the focused field's draft and waits until main has applied it. An invalid draft
   * refuses the action; the field keeps focus and shows its error.
   */
  async function commitFirst(): Promise<{ status: 'ready' } | InvalidDraft>
  {
    const draft = await drafts.commit()
    if (draft.status === 'invalid')
    {
      announce(`Fix ${draft.field} first.`)
      return { status: 'invalid-draft', field: draft.field }
    }
    if (draft.status === 'committed')
    {
      if (draft.field !== undefined)
      {
        noteEdit(draft.field, draft.ids ?? null)
      }
      await applied(draft.seq)
    }
    return { status: 'ready' }
  }

  /** Opens Review: the brass carries the Queue selection, the tab and Ctrl+2 do not. Measures, then refreshes the plan. */
  async function openReview(options: { fromQueue?: boolean } = {}): Promise<PreflightOutcome | InvalidDraft>
  {
    const commit = await commitFirst()
    if (commit.status === 'invalid-draft')
    {
      return commit
    }
    const state = view.getState()
    if (options.fromQueue ?? true)
    {
      state.openReviewFromQueue(selectOrderedJobs(jobs.getState()))
    }
    else
    {
      state.setMode('review')
    }
    void measureForReview()
    return refreshReview()
  }

  /** "Back to all": the session covers every job not in a batch again. */
  function backToAll(): Promise<PreflightOutcome>
  {
    view.getState().setReviewSubset(null)
    return refreshReview()
  }

  function checking(): StartOutcome
  {
    const progress = jobs.getState().preflight
    const reason = progress !== null && progress.total > 0
      ? `Checking ${progress.done.toLocaleString('en-US')} of ${countOf(progress.total, 'job')}.`
      : `Checking ${countOf(scopeSize(sessionScope()), 'job')}.`
    return { status: 'not-ready', reason }
  }

  /** Why Start cannot be sent yet, or null when it can. */
  function startBlocker(): StartOutcome | null
  {
    const session = view.getState().review
    if (inFlight !== null && inFlight.purpose === 'review')
    {
      return checking()
    }
    if (session.reportId === null)
    {
      void refreshReview()
      return checking()
    }
    const report = latestReport
    if (report !== null && report.preflightId === session.reportId && report.counts.ready === 0 && report.counts.willSkip === 0)
    {
      const blocked = report.counts.blocked
      return { status: 'not-ready', reason: blocked === 0 ? 'Nothing can run.' : `Nothing can run: ${countOf(blocked, 'job')} ${blocked === 1 ? 'is' : 'are'} blocked.` }
    }
    if (reviewAwaitsAcknowledgment(session))
    {
      announce('Start waits for the acknowledgment.')
      return { status: 'needs-acknowledgment', notice: session.notice }
    }
    return null
  }

  /** Names a stale plan: the user's own edit by its field, anything else by its sources. */
  function staleReason(changed: readonly JobId[]): string
  {
    const n = changed.length
    const edit = lastEdit
    const own = edit !== null && (edit.ids === null || changed.some((id) => edit.ids?.has(id)))
    if (own && edit !== null)
    {
      return `${edit.label} changed for ${countOf(n, 'job')}. Review ${n === 1 ? 'it' : 'them'}, then Start again.`
    }
    if (n === 0)
    {
      return 'The output changed since this review. Review it, then Start again.'
    }
    return n === 1 ? '1 source changed since this review.' : `${countOf(n, 'source')} changed since this review.`
  }

  function runIsLive(): boolean
  {
    const status = jobs.getState().run?.status
    return status === 'running' || status === 'pausing' || status === 'paused'
  }

  function startRefused(error: CommandError): StartOutcome
  {
    if (error.code === 'plan-stale')
    {
      const changed = error.details !== null && 'changed' in error.details ? [...error.details.changed] : []
      const reason = staleReason(changed)
      announce(reason)
      void refreshReview()
      return { status: 'stale', changed, reason }
    }
    if (error.code === 'confirmation-required' && error.details !== null && 'preflightId' in error.details)
    {
      const { preflightId, originalsAffected, overwrites } = error.details
      const notice = view.getState().receiveReport({ reportId: preflightId, originalsAffected, overwrites })
      announce(notice ?? 'Start waits for the acknowledgment.')
      return { status: 'needs-acknowledgment', notice }
    }
    announce(error.message)
    return refused(error)
  }

  /** Sends Start with the session's latest report id and, when it is destructive, the report's own counts. */
  async function sendStart(): Promise<StartOutcome>
  {
    const session = view.getState().review
    const preflightId = session.reportId ?? ''
    const ack: Ack | null = reviewNeedsAcknowledgment(session) && session.counts !== null
      ? { preflightId, originalsAffected: session.counts.originalsAffected, overwrites: session.counts.overwrites }
      : null
    const appending = runIsLive()
    const reply = await call(() => api.start({ preflightId, ack, resume: false }))
    if (!reply.ok)
    {
      return startRefused(reply.error)
    }
    const result = reply.value
    await applied(reply.seq)
    view.getState().openRunAfterStart()
    lastEdit = null
    if (!result.repeated)
    {
      const label = formatRunLabel(result.runId)
      const jobsText = countOf(result.queued.length, 'job')
      const skipped = result.skipped.length
      notify(appending
        ? { tone: 'success', title: `Appended ${jobsText} to ${label}.` }
        : {
          tone: 'success',
          title: `${label} started: ${jobsText}.`,
          body: skipped === 0 ? undefined : skipped === 1 ? '1 skipped because its output exists.' : `${skipped.toLocaleString('en-US')} skipped because their output exists.`
        })
    }
    return { status: 'started', runId: result.runId, queued: result.queued, skipped: result.skipped, blocked: result.blocked, appended: appending }
  }

  let starting = false

  async function guarded(task: () => Promise<StartOutcome>): Promise<StartOutcome>
  {
    if (starting)
    {
      return { status: 'busy' }
    }
    starting = true
    try
    {
      return await task()
    }
    finally
    {
      starting = false
    }
  }

  /** Start: commits the field draft, then starts the reviewed jobs; further presses are ignored until it answers. */
  function start(): Promise<StartOutcome>
  {
    return guarded(async () =>
    {
      const commit = await commitFirst()
      if (commit.status === 'invalid-draft')
      {
        return commit
      }
      return startBlocker() ?? sendStart()
    })
  }

  /** "Start only the {k} selected jobs": plans exactly those, then starts them, asking for their own acknowledgment. */
  function startSelected(ids: readonly JobId[]): Promise<StartOutcome>
  {
    return guarded(async () =>
    {
      const commit = await commitFirst()
      if (commit.status === 'invalid-draft')
      {
        return commit
      }
      view.getState().setReviewSubset(ids)
      const planned = await preflight([...ids], 'review')
      if (planned.status === 'superseded')
      {
        return checking()
      }
      if (planned.status === 'refused')
      {
        return planned
      }
      return startBlocker() ?? sendStart()
    })
  }

  /** "Append {n} jobs to Batch {b}": a fresh preflight of the waiting jobs, then Start, which appends to the run. */
  function append(): Promise<StartOutcome>
  {
    return guarded(async () =>
    {
      const commit = await commitFirst()
      if (commit.status === 'invalid-draft')
      {
        return commit
      }
      const planned = await refreshReview()
      if (planned.status === 'superseded')
      {
        return checking()
      }
      if (planned.status === 'refused')
      {
        return planned
      }
      return startBlocker() ?? sendStart()
    })
  }

  function runLabel(): string
  {
    const runId = jobs.getState().run?.runId ?? null
    return runId === null ? 'the batch' : formatRunLabel(runId)
  }

  function inStates(ids: readonly JobId[], states: ReadonlySet<JobState>): JobId[]
  {
    const state = jobs.getState()
    return ids.filter((id) =>
    {
      const job = state.jobs[id]
      return job !== undefined && states.has(job.state)
    })
  }

  /** One job by its catalog number, several by their count. */
  function jobsText(ids: readonly JobId[]): string
  {
    return ids.length === 1 ? ids[0] : countOf(ids.length, 'job')
  }

  /** Says why jobs a command could not change were left as they were. */
  function reportRefusals(result: PerJob): void
  {
    const count = result.refused.length
    if (count === 0)
    {
      return
    }
    const first = result.refused[0].message
    announce(count === 1 ? first : `${countOf(count, 'job')} were not changed. ${first}`)
  }

  let pauseWatch: (() => void) | null = null

  /** Announces the pause once it settles; a resume, a cancel, or the run ending stops the watch. */
  function watchPause(label: string): void
  {
    pauseWatch?.()
    const settled = (state: JobsState): boolean =>
    {
      const status = state.run?.status ?? 'idle'
      if (status === 'paused')
      {
        announce(`${label} paused.`)
        return true
      }
      return status !== 'pausing' && status !== 'running'
    }
    if (settled(jobs.getState()))
    {
      return
    }
    const stopWatch = (): void =>
    {
      stop()
      watchers.delete(stopWatch)
      if (pauseWatch === stopWatch)
      {
        pauseWatch = null
      }
    }
    const stop = jobs.subscribe((state) =>
    {
      if (settled(state))
      {
        stopWatch()
      }
    })
    pauseWatch = stopWatch
    watchers.add(stopWatch)
  }

  /**
   * Pause holds the queue: no new job starts and running jobs finish. "Pause now" stops analyzing and encoding jobs,
   * which restart from the beginning. Every press is announced at once and again when the pause settles.
   */
  async function pause(mode: PauseMode = 'finish-running'): Promise<Outcome<RunState>>
  {
    const label = runLabel()
    const counts = jobs.getState().run?.counts
    const restarting = counts === undefined ? 0 : counts.analyzing + counts.encoding
    const finishing = counts === undefined ? 0 : restarting + counts.verifying + counts.finalizing
    const reply = await call(() => api.pause({ mode }))
    if (!reply.ok)
    {
      announce(reply.error.message)
      return refused(reply.error)
    }
    if (mode === 'stop-running' && restarting > 0)
    {
      announce(`Pausing ${label}. ${countOf(restarting, 'running job')} ${restarting === 1 ? 'restarts' : 'restart'} from the beginning.`)
    }
    else if (mode === 'finish-running' && finishing > 0)
    {
      announce(`Pausing ${label}. ${countOf(finishing, 'running job')} ${finishing === 1 ? 'finishes' : 'finish'} first.`)
    }
    else
    {
      announce(`Pausing ${label}.`)
    }
    await applied(reply.seq)
    if (reply.value.status === 'paused')
    {
      pauseWatch?.()
      announce(`${label} paused.`)
    }
    else
    {
      watchPause(label)
    }
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /**
   * Resume continues the batch, requeued jobs first. A batch restored after a relaunch that replaces originals
   * waits for its banner's acknowledgment, which the restored run's own counts back.
   */
  async function resume(options: { acknowledged?: boolean } = {}): Promise<ResumeOutcome>
  {
    const commit = await commitFirst()
    if (commit.status === 'invalid-draft')
    {
      return commit
    }
    const run = jobs.getState().run
    const label = runLabel()
    const needsAck = run?.needsAck ?? null
    if (needsAck !== null && options.acknowledged !== true)
    {
      announce('Resume waits for the acknowledgment.')
      return { status: 'needs-acknowledgment' }
    }
    const ack: Ack | null = needsAck === null ? null : { preflightId: run?.runId ?? '', ...needsAck }
    const reply = await call(() => api.resume({ ack }))
    if (!reply.ok)
    {
      if (reply.error.code === 'confirmation-required')
      {
        announce('Resume waits for the acknowledgment.')
        return { status: 'needs-acknowledgment' }
      }
      announce(reply.error.message)
      return refused(reply.error)
    }
    pauseWatch?.()
    await applied(reply.seq)
    announce(`${label} resumed.`)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** Ctrl+P: pauses a running batch, resumes a pausing or paused one, and says so when no batch runs. */
  async function togglePause(): Promise<Outcome<RunState> | ResumeOutcome>
  {
    const status = jobs.getState().run?.status ?? 'idle'
    if (status === 'running')
    {
      return pause('finish-running')
    }
    if (status === 'pausing' || status === 'paused')
    {
      return resume()
    }
    announce('No batch is running.')
    return nothingToDo('No batch is running.')
  }

  /** Cancel run, after its inline confirmation: running jobs stop, queued jobs are canceled, finished jobs keep their outputs. */
  async function cancelRun(): Promise<Outcome<{ canceled: number }>>
  {
    const label = runLabel()
    const reply = await call(() => api.cancelRun({}))
    if (!reply.ok)
    {
      announce(reply.error.message)
      return refused(reply.error)
    }
    pauseWatch?.()
    announce(`Canceling ${label}.`)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  function retryAction(ids: readonly JobId[]): BatchToastAction
  {
    return { label: 'Retry', run: () => void retry(ids) }
  }

  /** Cancel job: running jobs only; queued jobs in the selection stay queued. */
  async function cancelJobs(ids: readonly JobId[]): Promise<Outcome<PerJob>>
  {
    const running = inStates(ids, RUNNING_STATES)
    if (running.length === 0)
    {
      return nothingToDo('Only running jobs can be canceled.')
    }
    const reply = await call(() => api.cancel({ ids: running }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const canceled = reply.value.applied
    if (canceled.length > 0)
    {
      notify({
        tone: 'neutral',
        title: `Canceled ${jobsText(canceled)}.`,
        body: canceled.length === 1 ? 'Retry runs it later.' : 'Retry runs them later.',
        actions: [retryAction(canceled)]
      })
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** Skip: queued jobs end as Skipped; Retry is the way back, so skips are not on the undo stack. */
  async function skip(ids: readonly JobId[]): Promise<Outcome<PerJob>>
  {
    const queued = inStates(ids, QUEUED_STATES)
    if (queued.length === 0)
    {
      return nothingToDo('Only queued jobs can be skipped.')
    }
    const reply = await call(() => api.skip({ ids: queued }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const skipped = reply.value.applied
    if (skipped.length > 0)
    {
      notify({
        tone: 'neutral',
        title: skipped.length === 1 ? `Skipped ${skipped[0]}. Retry runs it later.` : `Skipped ${countOf(skipped.length, 'job')}. Retry runs them later.`,
        actions: [retryAction(skipped)]
      })
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** Take out of the batch: queued jobs return to the queue as Ready, which is how a queued job is edited during a run. */
  async function takeOut(ids: readonly JobId[]): Promise<Outcome<PerJob>>
  {
    const queued = inStates(ids, QUEUED_STATES)
    if (queued.length === 0)
    {
      return nothingToDo('Only queued jobs can be taken out of the batch.')
    }
    const label = runLabel()
    const reply = await call(() => api.unqueue({ ids: queued }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const out = reply.value.applied
    if (out.length > 0)
    {
      notify({
        tone: 'neutral',
        title: out.length === 1 ? `Took ${out[0]} out of ${label}. It waits in the queue.` : `Took ${countOf(out.length, 'job')} out of ${label}. They wait in the queue.`,
        actions: [{ label: 'Review', run: () => void openReview({ fromQueue: false }) }]
      })
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /**
   * Retry: main re-plans each job and runs it only when the plan matches the attempt being retried; a changed plan
   * waits in the queue for Review. A destructive retry first asks for the acknowledgment, whose counts main returns.
   */
  async function retry(ids: readonly JobId[] | 'failed', options: { recipe?: Recipe | null; ack?: Ack | null } = {}): Promise<RetryOutcome>
  {
    const commit = await commitFirst()
    if (commit.status === 'invalid-draft')
    {
      return commit
    }
    const reply = await call(() => api.retry({ ids: ids === 'failed' ? 'failed' : [...ids], recipe: options.recipe ?? null, ack: options.ack ?? null, start: true }))
    if (!reply.ok)
    {
      const details = reply.error.details
      if (reply.error.code === 'confirmation-required' && details !== null && 'preflightId' in details)
      {
        announce('Retry waits for the acknowledgment.')
        return { status: 'needs-acknowledgment', ack: { preflightId: details.preflightId, originalsAffected: details.originalsAffected, overwrites: details.overwrites } }
      }
      return refusedToast(reply.error)
    }
    await applied(reply.seq)
    const { queued, changed } = reply.value
    if (changed.length > 0)
    {
      notify({
        tone: 'warning',
        title: changed.length === 1 ? '1 job waits for review: its output changed.' : `${countOf(changed.length, 'job')} wait for review: their outputs changed.`,
        actions: [{ label: 'Review', run: () => void openReview({ fromQueue: false }) }]
      })
    }
    if (queued.length > 0)
    {
      announce(`Retrying ${jobsText(queued)}.`)
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** How many of the held jobs' outputs would displace a file when placed as planned. */
  function displacedCount(ids: readonly JobId[]): number
  {
    const state = jobs.getState()
    return ids.filter((id) => (state.jobs[id]?.hold?.displaces ?? null) !== null).length
  }

  /**
   * Keep output (as planned), or Keep under a new name. A planned placement that displaces a file asks for its
   * inline confirmation first; the confirmed count is the one main checks.
   */
  async function keepOutput(ids: readonly JobId[], options: { placement?: 'planned' | 'renamed'; confirmed?: boolean } = {}): Promise<DecisionOutcome>
  {
    const held = inStates(ids, HELD_STATES)
    if (held.length === 0)
    {
      return nothingToDo('Only jobs that need a decision have an output to keep.')
    }
    const placement = options.placement ?? 'planned'
    const displaces = placement === 'planned' ? displacedCount(held) : 0
    if (displaces > 0 && options.confirmed !== true)
    {
      return { status: 'needs-confirmation', displaces }
    }
    const reply = await call(() => api.keepOutput({ ids: held, placement, confirm: displaces > 0 ? { displaces } : null }))
    if (!reply.ok)
    {
      if (reply.error.code === 'confirmation-required')
      {
        return { status: 'needs-confirmation', displaces }
      }
      return refusedToast(reply.error)
    }
    await applied(reply.seq)
    const kept = reply.value.applied
    if (kept.length > 0)
    {
      const what = kept.length === 1 ? `the output of ${kept[0]}` : countOf(kept.length, 'output')
      const renamed = kept.length === 1 ? ' under a new name' : ' under new names'
      announce(`Kept ${what}${placement === 'renamed' ? renamed : ''}.`)
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** Discard output, after its inline confirmation: the waiting output is deleted; the original and any existing file stay. */
  async function discardOutput(ids: readonly JobId[]): Promise<Outcome<PerJob>>
  {
    const held = inStates(ids, HELD_STATES)
    if (held.length === 0)
    {
      return nothingToDo('Only jobs that need a decision have an output to discard.')
    }
    const reply = await call(() => api.discardOutput({ ids: held }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    await applied(reply.seq)
    const discarded = reply.value.applied
    if (discarded.length > 0)
    {
      announce(`Discarded ${discarded.length === 1 ? `the output of ${discarded[0]}` : countOf(discarded.length, 'output')}.`)
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  function decisionsLeft(count: number): string
  {
    return `${countOf(count, 'job')} still ${count === 1 ? 'needs' : 'need'} a decision.`
  }

  async function sendAcknowledge(targets: JobId[], decisions: number): Promise<Outcome<PerJob>>
  {
    if (targets.length === 0)
    {
      const message = decisions > 0 ? decisionsLeft(decisions) : 'Nothing to acknowledge.'
      announce(message)
      return nothingToDo(message)
    }
    const reply = await call(() => api.acknowledge({ ids: targets }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    await applied(reply.seq)
    const count = reply.value.applied.length
    if (count > 0)
    {
      notify({ tone: 'success', title: `Acknowledged ${countOf(count, 'job')}.`, body: decisions > 0 ? decisionsLeft(decisions) : undefined })
    }
    reportRefusals(reply.value)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  /** Acknowledge: clears the held state of jobs that need attention and changes nothing else; a decision is not acknowledged. */
  function acknowledge(ids: readonly JobId[]): Promise<Outcome<PerJob>>
  {
    const state = jobs.getState()
    const subjects = ids.map((id) => state.jobs[id]).filter((job) => job !== undefined)
    const targets = subjects.filter((job) => needsAttention(job) && !needsDecision(job)).map((job) => job.id)
    return sendAcknowledge(targets, subjects.filter(needsDecision).length)
  }

  /** Acknowledge all: every acknowledgeable job of the batch (every batch for null); jobs that need a decision are skipped. */
  function acknowledgeAll(runId: RunId | null): Promise<Outcome<PerJob>>
  {
    const state = jobs.getState()
    const subjects = state.order.map((id) => state.jobs[id]).filter((job) => job !== undefined && (runId === null || job.runId === runId))
    const targets = subjects.filter((job) => needsAttention(job) && !needsDecision(job)).map((job) => job.id)
    return sendAcknowledge(targets, subjects.filter(needsDecision).length)
  }

  /** Shows jobs in the list on show, so a toast's "Show" lands on them. */
  function showJobs(ids: readonly JobId[]): void
  {
    const state = view.getState()
    if (state.mode === 'queue')
    {
      selectRows(ids)
      return
    }
    if (state.mode !== 'history' && ids.length > 0)
    {
      state.select(state.mode, { type: 'selectAll', ids })
    }
  }

  /**
   * Delete acts on each selected job by its state: removes jobs not in a batch, skips queued jobs (several only after
   * the confirmation), clears finished jobs, and never stops a running job or clears a job that needs attention.
   */
  async function deleteJobs(ids: readonly JobId[], options: { confirmed?: boolean } = {}): Promise<DeleteOutcome>
  {
    if (view.getState().mode === 'history')
    {
      announce('History is read-only.')
      return nothingToDo('History is read-only.')
    }
    const plan = planDelete(jobs.getState(), ids)
    if (plan.skip.length > 1 && options.confirmed !== true)
    {
      return { status: 'needs-confirmation', plan }
    }
    if (plan.remove.length > 0)
    {
      await remove(plan.remove)
    }
    if (plan.skip.length > 0)
    {
      await skip(plan.skip)
    }
    if (plan.clear.length > 0)
    {
      await clear({ kind: 'ids', ids: plan.clear })
    }
    if (plan.running.length > 0)
    {
      notify({ tone: 'neutral', title: 'Running jobs are not stopped by Delete.', body: 'Use Cancel job (Shift+Delete).' })
    }
    if (plan.attention.length > 0)
    {
      const attention = [...plan.attention]
      notify({ tone: 'warning', title: attentionStays(attention.length), actions: [{ label: 'Show', run: () => showJobs(attention) }] })
    }
    return { status: 'done', plan }
  }

  /**
   * Any other command, settled into an outcome with no rejection: reads (a job's detail, its log, History's pages)
   * and commands with nothing to confirm, such as Measure now, Locate, Relink, Probe again, and Show in folder.
   */
  async function send<K extends JobCommandName>(name: K, req: JobCommandRequest<K>): Promise<Outcome<JobCommandResponse<K>>>
  {
    const command = api[name] as (request: JobCommandRequest<K>) => Promise<CommandResult<JobCommandResponse<K>>>
    const reply = await call(() => command(req))
    return reply.ok ? { status: 'done', value: reply.value, seq: reply.seq } : refused(reply.error)
  }

  /** Stop scan: jobs the scan already added stay. */
  async function cancelScan(scanId: string): Promise<Outcome<null>>
  {
    const reply = await call(() => api.cancelScan({ scanId }))
    return reply.ok ? { status: 'done', value: null, seq: reply.seq } : refused(reply.error)
  }

  /** Export report: main's save dialog; the toast offers "Show in folder". A canceled dialog says nothing. */
  async function exportReport(scope: { runId: RunId } | { ids: JobId[] }, format: 'csv' | 'json'): Promise<Outcome<{ path: string } | { canceled: true }>>
  {
    const reply = await call(() => api.exportReport({ scope, format }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const result = reply.value
    if ('path' in result)
    {
      const reveal = deps.revealPath
      notify({
        tone: 'success',
        title: `Report saved: ${result.path}.`,
        actions: reveal === undefined ? [] : [{ label: 'Show in folder', run: () => reveal(result.path) }]
      })
    }
    return { status: 'done', value: result, seq: reply.seq }
  }

  let searchGeneration = 0

  /** History search by file name, path, or catalog number; a newer search supersedes an older one. */
  async function searchHistory(
    query: string,
    options: { limit?: number; before?: { runId: RunId; jobId: JobId } | null } = {}
  ): Promise<Outcome<JobCommandResponse<'searchRuns'>> | { status: 'superseded' }>
  {
    searchGeneration += 1
    const mine = searchGeneration
    const reply = await call(() => api.searchRuns({ query: query.trim(), limit: options.limit ?? HISTORY_SEARCH_LIMIT, before: options.before ?? null }))
    if (mine !== searchGeneration)
    {
      return { status: 'superseded' }
    }
    return reply.ok ? { status: 'done', value: reply.value, seq: reply.seq } : refused(reply.error)
  }

  /**
   * Rerun returned, Rerun all, or chosen jobs of a kept batch: new jobs with new catalog numbers that wait for Review.
   * Sources no longer at their paths and paths that now hold the job's own output are reported, not added.
   */
  async function rerun(runId: RunId, jobIds: readonly JobId[] | 'all' | 'returned', force: boolean = false): Promise<EditOutcome<JobCommandResponse<'rerun'>>>
  {
    const reply = await call(() => api.rerun({ runId, jobIds: typeof jobIds === 'string' ? jobIds : [...jobIds], force }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const { added, missing, holdsOutput } = reply.value
    const entryId = added.length > 0 ? history.record({ kind: 'add', ids: [...added], tombstone: null }).id : null
    await applied(reply.seq)
    const label = formatRunLabel(runId)
    const body: string[] = []
    if (missing.length > 0)
    {
      body.push(missing.length === 1
        ? '1 source is no longer at its path; it was not added.'
        : `${countOf(missing.length, 'source')} are no longer at their paths; they were not added.`)
    }
    if (holdsOutput.length === 1)
    {
      const [one] = holdsOutput
      body.push(`${one.jobId} replaced its original; rerunning would process its output again.`)
      if (one.originalTrashed)
      {
        body.push(`The original may still be in ${binOf(one.path)}.`)
      }
    }
    else if (holdsOutput.length > 1)
    {
      body.push(`${countOf(holdsOutput.length, 'path')} now hold outputs of the jobs they would rerun; they were not added.`)
    }
    const actions: BatchToastAction[] = []
    if (missing.length > 0)
    {
      actions.push({
        label: 'Show',
        run: () => notify({ tone: 'neutral', title: `No longer at their paths: ${missing.length.toLocaleString('en-US')}`, body: missing.map((entry) => entry.path).join('; ') })
      })
    }
    if (holdsOutput.length > 0)
    {
      actions.push({ label: 'Add anyway', run: () => void rerun(runId, holdsOutput.map((entry) => entry.jobId), true) })
    }
    notify({
      tone: added.length > 0 ? 'success' : 'warning',
      title: added.length > 0 ? `Added ${countOf(added.length, 'job')} to rerun ${label}.` : `No jobs were added to rerun ${label}.`,
      body: body.length > 0 ? body.join(' ') : undefined,
      actions
    })
    return { status: 'done', value: reply.value, seq: reply.seq, entryId }
  }

  /** Delete from history, after its inline confirmation; outputs stay on disk. An opened batch that is deleted closes. */
  async function deleteRuns(runIds: readonly RunId[] | 'all'): Promise<Outcome<{ deleted: number }>>
  {
    const reply = await call(() => api.deleteRuns({ runIds: runIds === 'all' ? 'all' : [...runIds] }))
    if (!reply.ok)
    {
      return refusedToast(reply.error)
    }
    const state = view.getState()
    const open = state.history.openRunId
    if (open !== null && (runIds === 'all' || runIds.some((id) => id === open)))
    {
      state.closeHistoryBatch()
    }
    const deleted = reply.value.deleted
    announce(runIds !== 'all' && runIds.length === 1 && deleted === 1
      ? `Deleted ${formatRunLabel(runIds[0])} from history.`
      : `Deleted ${countOf(deleted, 'batch', 'batches')} from history.`)
    return { status: 'done', value: reply.value, seq: reply.seq }
  }

  function reportUndo(outcome: UndoOutcome, direction: 'undo' | 'redo'): void
  {
    if (outcome.status === 'empty')
    {
      announce(direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.')
      return
    }
    if (outcome.status === 'refused')
    {
      notify({ tone: 'warning', title: outcome.message })
      return
    }
    noteEdit('Queue', null)
    announce(`${direction === 'undo' ? 'Undid' : 'Redid'} ${outcome.label}.`)
    if (outcome.refusal !== null)
    {
      notify({ tone: 'warning', title: outcome.refusal })
    }
  }

  /** Ctrl+Z, or a toast's Undo for its own edit. */
  async function undo(entryId?: number): Promise<UndoOutcome>
  {
    const outcome = await history.undo(entryId)
    reportUndo(outcome, 'undo')
    return outcome
  }

  /** Ctrl+Y or Ctrl+Shift+Z. */
  async function redo(): Promise<UndoOutcome>
  {
    const outcome = await history.redo()
    reportUndo(outcome, 'redo')
    return outcome
  }

  function dispose(): void
  {
    stopPlanWatch()
    liveCancel?.()
    liveCancel = null
    for (const stop of [...watchers])
    {
      stop()
    }
    watchers.clear()
  }

  return {
    addPaths,
    pasteFiles,
    showSkipped,
    assignRecipes,
    duplicate,
    remove,
    reorder,
    move,
    clear,
    setPolicy,
    notePlanInputChange: scheduleLive,
    windowFocused,
    openReview,
    refreshReview,
    backToAll,
    measureForReview,
    stopMeasuring,
    start,
    startSelected,
    append,
    pause,
    resume,
    togglePause,
    cancelRun,
    cancelJobs,
    skip,
    takeOut,
    retry,
    keepOutput,
    discardOutput,
    acknowledge,
    acknowledgeAll,
    deleteJobs,
    send,
    cancelScan,
    exportReport,
    searchHistory,
    rerun,
    deleteRuns,
    undo,
    redo,
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    subscribeUndo: (listener: () => void) => history.subscribe(listener),
    registerDraftCommitter: (committer: DraftCommitter) => drafts.register(committer),
    dispose
  }
}

/** The Batch view's commands. */
export type BatchActions = ReturnType<typeof createBatchActions>
