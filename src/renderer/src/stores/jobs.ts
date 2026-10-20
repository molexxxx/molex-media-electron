/**
 * The window's projection of the job engine. Main owns every job; this store holds the snapshot jobs:subscribe
 * returns plus every jobs:event applied after it, strictly in seq order, so nothing about a job lives only here.
 * The sync listens before it subscribes, drops duplicates, resyncs from a new snapshot on any gap, and applies each
 * batch with one store update, so a batch costs one render pass.
 */
import { create, createStore, type StoreApi } from 'zustand'
import type { CommandResult, JobEvent, JobEventBatch, JobsApi } from '../../../shared/jobs/contract'
import type { JobId, RunId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import type
{
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  EngineSnapshot,
  JobMeasurement,
  JobProgress,
  JobStage,
  JobView,
  PresetState,
  RecentFolder,
  RunAlert,
  RunSettings,
  RunState,
  ScanState,
  Verification
} from '../../../shared/jobs/types'

/**
 * How far the store is in step with the engine: not syncing, waiting for the first snapshot, live, showing the last
 * consistent state while a new snapshot is on its way after a gap, or retrying a failed subscribe.
 */
export type JobsSyncStatus = 'idle' | 'connecting' | 'hydrated' | 'resyncing' | 'error'

/** A request from main to bring a job or a batch forward, raised by a notification click. */
export interface FocusRequest
{
  jobId: JobId | null
  runId: RunId | null
  /** The event's seq, so two requests for the same job stay distinct. */
  seq: number
}

/** The progress of the latest Review check. */
export interface PreflightProgress
{
  preflightId: string
  done: number
  total: number
}

/** The engine as this window sees it: the snapshot's fields plus every event applied after it. */
export interface JobsState
{
  /** The last event applied; the snapshot's seq right after a hydration. */
  readonly seq: number
  readonly status: JobsSyncStatus
  /** Why the last subscribe failed. */
  readonly error: string | null
  /** Snapshots applied in this window: 0 before the first, then one more per resync. */
  readonly hydrations: number
  readonly run: RunState | null
  readonly policy: BatchPolicy | null
  readonly settings: RunSettings | null
  readonly defaultRecipe: Recipe | null
  readonly capabilities: CapabilitySummary | null
  readonly limits: EngineSnapshot['limits'] | null
  /** Queue order; always exactly the ids in jobs. */
  readonly order: readonly JobId[]
  readonly jobs: Readonly<Record<JobId, JobView>>
  /** The latest measurement each job reported since the last snapshot; jobs:get returns the full record. */
  readonly measurements: Readonly<Record<JobId, JobMeasurement>>
  /** The latest verification each job reported since the last snapshot. */
  readonly verifications: Readonly<Record<JobId, Verification>>
  readonly scans: readonly ScanState[]
  readonly alerts: readonly RunAlert[]
  readonly presets: PresetState | null
  readonly recentFolders: readonly RecentFolder[]
  /** The last run that completed while this window listened; a snapshot does not carry it, so it survives resyncs. */
  readonly completed: BatchSummary | null
  readonly preflight: PreflightProgress | null
  /** A focus request not yet handled; it survives resyncs. */
  readonly focus: FocusRequest | null
}

/** The part of the preload's jobs surface the sync uses. */
export type JobsSyncApi = Pick<JobsApi, 'subscribe' | 'unsubscribe' | 'onEvents'>

/** What a sync needs; everything but the api has a default. */
export interface JobsSyncDeps
{
  api: JobsSyncApi
  /** The window's store by default. */
  store?: StoreApi<JobsState>
  /** A fresh client id for each subscribe. */
  clientId?: () => string
  /** Runs fn after ms and returns a cancel; window timers by default. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** Buffered events kept while a snapshot is on its way; older ones are covered by the snapshot. */
export const MAX_BUFFERED_EVENTS = 20_000

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** A state with nothing hydrated. */
export function initialJobsState(): JobsState
{
  return {
    seq: 0,
    status: 'idle',
    error: null,
    hydrations: 0,
    run: null,
    policy: null,
    settings: null,
    defaultRecipe: null,
    capabilities: null,
    limits: null,
    order: [],
    jobs: {} as Record<JobId, JobView>,
    measurements: {} as Record<JobId, JobMeasurement>,
    verifications: {} as Record<JobId, Verification>,
    scans: [],
    alerts: [],
    presets: null,
    recentFolders: [],
    completed: null,
    preflight: null,
    focus: null
  }
}

/** A jobs store of its own, apart from the window's, for tests. */
export function createJobsStore(): StoreApi<JobsState>
{
  return createStore<JobsState>(() => initialJobsState())
}

/** The window's jobs store; useJobs keeps it in step with the engine. */
export const useJobsStore = create<JobsState>(() => initialJobsState())

function hasEntry(entries: Readonly<Record<JobId, unknown>>, id: JobId): boolean
{
  return Object.hasOwn(entries, id)
}

function normalizeOrder(proposed: readonly JobId[], jobs: Readonly<Record<JobId, JobView>>, rest: readonly JobId[]): JobId[]
{
  const order: JobId[] = []
  const seen = new Set<JobId>()
  for (const ids of [proposed, rest])
  {
    for (const id of ids)
    {
      if (hasEntry(jobs, id) && !seen.has(id))
      {
        seen.add(id)
        order.push(id)
      }
    }
  }
  return order
}

/**
 * The state a snapshot gives: every field the snapshot carries replaced, its order reduced to known jobs with any
 * unlisted job appended, and the per-job measurements and verifications dropped (jobs:get has them). The last
 * completed run and an unhandled focus request survive, because no snapshot carries them.
 */
export function fromSnapshot(snapshot: EngineSnapshot, previous: JobsState): JobsState
{
  const jobs = {} as Record<JobId, JobView>
  for (const job of snapshot.jobs)
  {
    jobs[job.id] = job
  }
  return {
    seq: snapshot.seq,
    status: 'hydrated',
    error: null,
    hydrations: previous.hydrations + 1,
    run: snapshot.run,
    policy: snapshot.policy,
    settings: snapshot.settings,
    defaultRecipe: snapshot.defaultRecipe,
    capabilities: snapshot.capabilities,
    limits: snapshot.limits,
    order: normalizeOrder(snapshot.order, jobs, snapshot.jobs.map((job) => job.id)),
    jobs,
    measurements: {} as Record<JobId, JobMeasurement>,
    verifications: {} as Record<JobId, Verification>,
    scans: snapshot.scans,
    alerts: snapshot.alerts,
    presets: snapshot.presets,
    recentFolders: snapshot.recentFolders,
    completed: previous.completed,
    preflight: null,
    focus: previous.focus
  }
}

class BatchDraft
{
  readonly state: Mutable<JobsState>
  private ownJobs = false
  private ownOrder = false
  private ownMeasurements = false
  private ownVerifications = false

  constructor(base: JobsState)
  {
    this.state = { ...base }
  }

  job(id: JobId): JobView | null
  {
    return hasEntry(this.state.jobs, id) ? this.state.jobs[id] : null
  }

  jobs(): Record<JobId, JobView>
  {
    if (!this.ownJobs)
    {
      this.state.jobs = { ...this.state.jobs }
      this.ownJobs = true
    }
    return this.state.jobs as Record<JobId, JobView>
  }

  order(): JobId[]
  {
    if (!this.ownOrder)
    {
      this.state.order = [...this.state.order]
      this.ownOrder = true
    }
    return this.state.order as JobId[]
  }

  replaceOrder(order: JobId[]): void
  {
    this.state.order = order
    this.ownOrder = true
  }

  measurements(): Record<JobId, JobMeasurement>
  {
    if (!this.ownMeasurements)
    {
      this.state.measurements = { ...this.state.measurements }
      this.ownMeasurements = true
    }
    return this.state.measurements as Record<JobId, JobMeasurement>
  }

  verifications(): Record<JobId, Verification>
  {
    if (!this.ownVerifications)
    {
      this.state.verifications = { ...this.state.verifications }
      this.ownVerifications = true
    }
    return this.state.verifications as Record<JobId, Verification>
  }
}

function updateJob(draft: BatchDraft, id: JobId, change: (job: JobView) => JobView): void
{
  const job = draft.job(id)
  if (job !== null)
  {
    draft.jobs()[id] = change(job)
  }
}

function forgetResults(draft: BatchDraft, id: JobId): void
{
  if (hasEntry(draft.state.measurements, id))
  {
    delete draft.measurements()[id]
  }
  if (hasEntry(draft.state.verifications, id))
  {
    delete draft.verifications()[id]
  }
}

function addJob(draft: BatchDraft, job: JobView, after: JobId | null): void
{
  const known = draft.job(job.id) !== null
  draft.jobs()[job.id] = job
  if (known)
  {
    return
  }
  const order = draft.order()
  const index = after === null ? -1 : order.lastIndexOf(after)
  if (index === -1)
  {
    order.push(job.id)
  }
  else
  {
    order.splice(index + 1, 0, job.id)
  }
}

function removeJob(draft: BatchDraft, id: JobId): void
{
  if (draft.job(id) === null)
  {
    return
  }
  delete draft.jobs()[id]
  const order = draft.order()
  const index = order.indexOf(id)
  if (index !== -1)
  {
    order.splice(index, 1)
  }
  forgetResults(draft, id)
}

function progressInStage(progress: JobProgress | null, stage: JobStage): JobProgress | null
{
  return progress !== null && progress.stage === stage.id && progress.pass === stage.pass ? progress : null
}

function changeState(draft: BatchDraft, event: Extract<JobEvent, { type: 'job.state' }>): void
{
  const job = draft.job(event.jobId)
  if (job === null)
  {
    return
  }
  if (event.attempt !== job.attempt)
  {
    forgetResults(draft, job.id)
  }
  const next: JobView = {
    ...job,
    ...event.patch,
    id: job.id,
    seq: job.seq,
    state: event.to,
    attempt: event.attempt,
    reason: event.reason,
    rev: event.rev
  }
  if (!Object.hasOwn(event.patch, 'progress'))
  {
    next.progress = next.stage === null ? null : progressInStage(job.progress, next.stage)
  }
  draft.jobs()[job.id] = next
}

function recordResult(draft: BatchDraft, id: JobId, rev: number, record: (id: JobId) => void): void
{
  const job = draft.job(id)
  if (job === null)
  {
    return
  }
  record(id)
  if (job.rev !== rev)
  {
    draft.jobs()[id] = { ...job, rev }
  }
}

function upsert<T>(items: readonly T[], item: T, matches: (candidate: T) => boolean): readonly T[]
{
  const index = items.findIndex(matches)
  if (index === -1)
  {
    return [...items, item]
  }
  const next = items.slice()
  next[index] = item
  return next
}

function without<T>(items: readonly T[], matches: (candidate: T) => boolean): readonly T[]
{
  const index = items.findIndex(matches)
  return index === -1 ? items : [...items.slice(0, index), ...items.slice(index + 1)]
}

function applyEvent(draft: BatchDraft, event: JobEvent): void
{
  const state = draft.state
  switch (event.type)
  {
    case 'job.added':
      addJob(draft, event.job, event.after)
      break
    case 'job.removed':
      removeJob(draft, event.jobId)
      break
    case 'queue.order':
      draft.replaceOrder(normalizeOrder(event.order, state.jobs, state.order))
      break
    case 'job.updated':
      updateJob(draft, event.jobId, (job) => ({ ...job, ...event.patch, id: job.id, seq: job.seq, rev: event.rev }))
      break
    case 'job.state':
      changeState(draft, event)
      break
    case 'job.stage':
      updateJob(draft, event.jobId, (job) => ({ ...job, stage: event.stage, progress: progressInStage(job.progress, event.stage), rev: event.rev }))
      break
    case 'job.progress':
      updateJob(draft, event.jobId, (job) => ({ ...job, progress: event.progress }))
      break
    case 'job.measured':
      recordResult(draft, event.jobId, event.rev, (id) =>
      {
        draft.measurements()[id] = event.measurement
      })
      break
    case 'job.verified':
      recordResult(draft, event.jobId, event.rev, (id) =>
      {
        draft.verifications()[id] = event.verification
      })
      break
    case 'run.state':
      state.run = event.run
      break
    case 'run.progress':
      state.run = state.run === null ? null : { ...state.run, progress: event.progress }
      break
    case 'workers.changed':
      state.run = state.run === null ? null : { ...state.run, workers: event.workers }
      break
    case 'run.completed':
      state.completed = event.summary
      break
    case 'run.alert':
      state.alerts = upsert(state.alerts, event.alert, (alert) => alert.id === event.alert.id)
      break
    case 'run.alertCleared':
      state.alerts = without(state.alerts, (alert) => alert.id === event.alertId)
      break
    case 'settings.changed':
      state.settings = event.settings
      break
    case 'policy.changed':
      state.policy = event.policy
      break
    case 'capabilities.changed':
      state.capabilities = event.capabilities
      break
    case 'scan.progress':
      state.scans = upsert(state.scans, event.scan, (scan) => scan.scanId === event.scan.scanId)
      break
    case 'preflight.progress':
      state.preflight = { preflightId: event.preflightId, done: event.done, total: event.total }
      break
    case 'defaultRecipe.changed':
      state.defaultRecipe = event.recipe
      break
    case 'presets.changed':
      state.presets = event.presets
      break
    case 'folders.changed':
      state.recentFolders = event.recentFolders
      break
    case 'ui.focus':
      state.focus = { jobId: event.jobId, runId: event.runId, seq: event.seq }
      break
  }
}

/**
 * Applies events in order and returns the next state, leaving every untouched job, the order, and the other fields
 * as the same objects, so per-row subscribers of other jobs never re-render. Events are idempotent upserts:
 * job.added for a known id replaces the row in place, otherwise inserts it after `after` (at the end when after is
 * null or unknown); a removal or patch of an unknown job changes nothing. A job.stage, and a job.state whose patch
 * carries no progress, keep the row's progress only while it belongs to the row's stage and pass, so a row never
 * shows the numbers of a stage it left; a new attempt drops the job's measurement and verification. Sequencing is the
 * sync's job.
 */
export function reduceEvents(state: JobsState, events: readonly JobEvent[]): JobsState
{
  if (events.length === 0)
  {
    return state
  }
  const draft = new BatchDraft(state)
  for (const event of events)
  {
    applyEvent(draft, event)
  }
  draft.state.seq = Math.max(state.seq, events[events.length - 1].seq)
  return draft.state
}

/** The wait before retry n of a subscribe: 0.5 s, doubling to at most 15 s. */
export function retryDelayMs(attempt: number): number
{
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 15_000)
}

let clientSerial = 0

function defaultClientId(): string
{
  clientSerial += 1
  return `window-${clientSerial}-${Math.random().toString(36).slice(2, 10)}`
}

function scheduleWithTimers(fn: () => void, ms: number): () => void
{
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

function messageOf(reason: unknown): string
{
  return reason instanceof Error ? reason.message : String(reason)
}

function eventsOf(batch: JobEventBatch): readonly JobEvent[]
{
  return Array.isArray(batch?.events) ? batch.events : []
}

/** The events that continue seq without a gap, and the events from the first gap on; duplicates are dropped. */
function contiguous(events: readonly JobEvent[], seq: number): { next: JobEvent[]; rest: JobEvent[] | null }
{
  const next: JobEvent[] = []
  let last = seq
  for (let index = 0; index < events.length; index += 1)
  {
    const event = events[index]
    if (event.seq <= last)
    {
      continue
    }
    if (event.seq !== last + 1)
    {
      return { next, rest: events.slice(index) }
    }
    next.push(event)
    last = event.seq
  }
  return { next, rest: null }
}

/**
 * Keeps a store in step with the engine until the returned dispose is called. It registers the event listener
 * first and buffers batches, then subscribes with a fresh client id; the reply replaces the store with the snapshot
 * and the buffered events after its seq in one update. After that each event applies only when its seq is one more
 * than the last; a lower seq is a duplicate and is ignored, a higher one is a gap that keeps the last consistent
 * state visible, buffers again, and subscribes anew. A failed subscribe retries with backoff, and repeated gaps back
 * off the same way. A reply that arrives after dispose is ignored; dispose stops listening and unsubscribes the
 * client id it last used, which main matches, so a late unsubscribe never removes a newer registration.
 */
export function startJobsSync(deps: JobsSyncDeps): () => void
{
  const api = deps.api
  const store = deps.store ?? useJobsStore
  const nextClientId = deps.clientId ?? defaultClientId
  const schedule = deps.schedule ?? scheduleWithTimers
  let disposed = false
  let live = false
  let buffer: JobEvent[] = []
  let clientId = ''
  let failures = 0
  let gaps = 0
  let cancelWait: (() => void) | null = null

  const stopEvents = api.onEvents((batch) =>
  {
    const events = eventsOf(batch)
    if (live)
    {
      applyLive(events)
      return
    }
    for (const event of events)
    {
      buffer.push(event)
    }
    if (buffer.length > MAX_BUFFERED_EVENTS)
    {
      buffer = buffer.slice(buffer.length - MAX_BUFFERED_EVENTS)
    }
  })

  function later(attempt: number): void
  {
    cancelWait = schedule(() =>
    {
      cancelWait = null
      subscribe()
    }, retryDelayMs(attempt))
  }

  function fail(reason: unknown): void
  {
    failures += 1
    store.setState({ status: 'error', error: messageOf(reason) })
    later(failures)
  }

  function resyncAfterGap(rest: JobEvent[], applied: JobsState): void
  {
    live = false
    buffer = rest
    store.setState({ ...applied, status: 'resyncing' }, true)
    gaps += 1
    if (gaps === 1)
    {
      subscribe()
    }
    else
    {
      later(gaps - 1)
    }
  }

  function applyLive(events: readonly JobEvent[]): void
  {
    const state = store.getState()
    const { next, rest } = contiguous(events, state.seq)
    if (rest !== null)
    {
      resyncAfterGap(rest, reduceEvents(state, next))
      return
    }
    if (next.length > 0)
    {
      gaps = 0
      store.setState(reduceEvents(state, next), true)
    }
  }

  function hydrate(snapshot: EngineSnapshot): void
  {
    failures = 0
    const base = fromSnapshot(snapshot, store.getState())
    const { next, rest } = contiguous(buffer, snapshot.seq)
    buffer = []
    if (rest !== null)
    {
      resyncAfterGap(rest, reduceEvents(base, next))
      return
    }
    live = true
    store.setState(reduceEvents(base, next), true)
  }

  function settle(result: CommandResult<EngineSnapshot>): void
  {
    if (disposed)
    {
      return
    }
    if (result.ok)
    {
      hydrate(result.value)
    }
    else
    {
      fail(result.error.message)
    }
  }

  function subscribe(): void
  {
    clientId = nextClientId()
    const status: JobsSyncStatus = store.getState().hydrations > 0 ? 'resyncing' : 'connecting'
    if (store.getState().status !== status)
    {
      store.setState({ status })
    }
    let reply: Promise<CommandResult<EngineSnapshot>>
    try
    {
      reply = api.subscribe({ clientId })
    }
    catch (err)
    {
      fail(err)
      return
    }
    reply.then(settle, (err: unknown) =>
    {
      if (!disposed)
      {
        fail(err)
      }
    })
  }

  subscribe()

  return () =>
  {
    if (disposed)
    {
      return
    }
    disposed = true
    stopEvents()
    cancelWait?.()
    cancelWait = null
    buffer = []
    api.unsubscribe({ clientId }).catch(() => undefined)
    store.setState({ status: 'idle' })
  }
}

/** Resolves once the store has applied seq, the last event a command reply names, so a pending state can clear. */
export function whenApplied(seq: number, store: StoreApi<JobsState> = useJobsStore): Promise<void>
{
  if (store.getState().seq >= seq)
  {
    return Promise.resolve()
  }
  return new Promise((resolve) =>
  {
    const stop = store.subscribe((state) =>
    {
      if (state.seq >= seq)
      {
        stop()
        resolve()
      }
    })
  })
}

/** Marks the focus request with this seq handled; a newer request stays. */
export function clearFocusRequest(seq: number, store: StoreApi<JobsState> = useJobsStore): void
{
  if (store.getState().focus?.seq === seq)
  {
    store.setState({ focus: null })
  }
}
