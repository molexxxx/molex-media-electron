/**
 * The engine core: the queue and the run, every job transition through the shared table, the events each mutation
 * enqueues in its own turn, the journal lines that persist them, and the snapshot a window hydrates from. Dispatch,
 * the commands, and the composition take an `EngineCore` and change engine state only through it.
 */

import type { MediaFacts } from '../../shared/audio/types'
import { describeRecipe } from '../../shared/jobs/describe'
import type { JobId, RunId } from '../../shared/jobs/ids'
import type { Recipe } from '../../shared/jobs/recipes'
import { runTransitionFor, STAGE_STATES, STATE_GROUPS, transitionFor, type JobTransition, type JobTrigger, type TransitionId } from '../../shared/jobs/states'
import {
  ACTIVE_STATES,
  type AbortIntent,
  type AudioPlanCell,
  type BatchPolicy,
  type BatchSummary,
  type CapabilitySummary,
  type EngineSnapshot,
  type HistoryRecord,
  type Job,
  type JobDetail,
  type JobMeasurement,
  type JobPatch,
  type JobPlan,
  type JobProgress,
  type JobStage,
  type JobState,
  type JobView,
  type PauseMode,
  type PauseReason,
  type Placement,
  type PlanSummary,
  type PresetState,
  type RecentFolder,
  type RunAlert,
  type RunProgress,
  type RunSettings,
  type RunState,
  type RunStatus,
  type ScanState,
  type StateReason,
  type Verdict,
  type Verification,
  type WorkersState
} from '../../shared/jobs/types'
import { toWire } from '../../shared/jobs/wire'
import type { DraftEvent, JobEventBus } from './bus'
import type { EventSender, JobLogger } from './deps'
import { attemptLogPath, DETAIL_TAIL_BYTES, tailAtLineBoundary, type AttemptRing } from './log'
import { canonicalJson, type JobChange, type JobQueue, type MoveResult, type NewJob, type QueueMove, type RemovedJob } from './queue'

/** The queue's cap; `queue-full` beyond it. */
export const MAX_JOBS = 10_000

/** The states in which a job runs a child process; an abort intent applies only here. */
export const RUNNING_STATES: readonly JobState[] = ['analyzing', 'encoding', 'verifying']

/** The run's persisted part; `RunState` adds the counts, progress, workers, and `quitWhenIdle`. */
export interface RunRecord
{
  status: RunStatus
  runId: RunId | null
  startedAt: number | null
  pause: RunState['pause']
  needsAck: RunState['needsAck']
  /** How often a quit or crash interrupted the run. */
  interruptions: number
}

/** The first line of a placement, journaled with the move to finalizing (T20, T26). */
export interface PlacementBegin
{
  verdict: Verdict | null
  mode: Placement['kind'] | null
}

/** A journal line the core writes; the store numbers it. Every value is plain data that `toWire` left unchanged. */
export type CoreJournalEntry =
  | {
    type: 'job.state'
    jobId: JobId
    transition: TransitionId
    from: JobState
    to: JobState
    reason: StateReason
    attempt: number
    rev: number
    inputsRev: number
    change: JobChange
    begin: PlacementBegin | null
  }
  | { type: 'job.change'; jobId: JobId; rev: number; inputsRev: number; change: JobChange }
  | { type: 'job.add'; after: JobId | null; jobs: Job[] }
  | { type: 'job.remove'; ids: JobId[] }
  | { type: 'job.restore'; jobs: Job[]; order: JobId[] }
  | { type: 'queue.order'; order: JobId[] }
  | { type: 'run'; run: RunRecord }
  | { type: 'policy'; policy: BatchPolicy }
  | { type: 'default-recipe'; recipe: Recipe }

/** Every journal entry type the core writes and replays. */
export const CORE_ENTRY_TYPES: ReadonlyArray<CoreJournalEntry['type']> =
  ['job.state', 'job.change', 'job.add', 'job.remove', 'job.restore', 'queue.order', 'run', 'policy', 'default-recipe']

/** The state body of `state.json`: what the store saves and the journal replays onto. */
export interface CoreStateBody
{
  policy: BatchPolicy
  defaultRecipe: Recipe
  run: RunRecord
  order: JobId[]
  /** In queue order, with the volatile stage and progress cleared. */
  jobs: Job[]
}

/** The journal the core appends to; a `JobStore` satisfies it. */
export interface CoreJournal
{
  append(entry: CoreJournalEntry): number
  /** Resolves once the entries are fsynced, after every buffered line before them. */
  appendDurable(entries: readonly CoreJournalEntry[]): Promise<number[]>
}

/** The parts of a row that the planner and the audio plan build. */
export interface ViewBuilders
{
  /** The Review columns of a plan; `current` is whether the plan still matches its basis. */
  planSummary(plan: JobPlan, current: boolean, job: Readonly<Job>): PlanSummary
  /** One cell per audio stream from the latest gain plans; null until measured. */
  audioPlan(job: Readonly<Job>): AudioPlanCell[] | null
}

/** Where `get` reads a job's detail from beyond its record. */
export interface DetailSources
{
  /** The output of an attempt still in memory. */
  ring?(id: JobId): AttemptRing | null
  /** The history record of a job whose detail left memory. */
  history?(job: Readonly<Job>): Promise<HistoryRecord | null>
  /** An attempt log file's text; null when it cannot be read. */
  readLog?(path: string): Promise<string | null>
  /** The folder that holds `<RunId>/<JobId>-a<n>.log`. */
  logsDir?: string
  /** The probe's full facts for the source, when cached. */
  media?(job: Readonly<Job>): MediaFacts | null
}

/** A finished run, for its summary. */
export interface RunEnding
{
  runId: RunId
  startedAt: number
  endedAt: number
  endedBy: 'completed' | 'canceled'
  interruptions: number
  /** The jobs that carry the run's id, in queue order. */
  jobs: Array<Readonly<Job>>
}

/** The engine-wide state the core starts from; a restored run arrives as `run`. */
export interface CoreInitialState
{
  policy: BatchPolicy
  settings: RunSettings
  defaultRecipe: Recipe
  capabilities: CapabilitySummary
  workers: WorkersState
  presets: PresetState
  recentFolders: RecentFolder[]
  run?: RunRecord
  alerts?: RunAlert[]
  maxJobs?: number
}

/** What the core is built from. */
export interface EngineCoreOptions
{
  queue: JobQueue
  bus: JobEventBus
  journal: CoreJournal
  log: JobLogger
  now(): number
  state: CoreInitialState
  /** Builds the summary `run.completed` carries. */
  summarize(run: RunEnding): BatchSummary
  views?: Partial<ViewBuilders>
  detail?: DetailSources
}

/** What a transition may set besides the state, the reason, and the attempt. */
export interface TransitionOptions
{
  /** The reason the new state carries; it must be one of the row's reasons, and defaults to the row's first. */
  reason?: StateReason
  /** Other fields the new state introduces: the plan, result, error, or hold. */
  change?: JobChange
  /** The new stage's start; an active state without one starts with no stage. */
  stage?: JobStage | null
  /** The new stage's starting progress. */
  progress?: JobProgress | null
  /** The placement's first line, for the move to finalizing. */
  begin?: PlacementBegin
}

/** A command an attempt ran, quoted for display. */
export type CommandRecord = JobDetail['commands'][number]

/** One stage of an attempt with its times. */
export type StageRecord = JobDetail['stages'][number]

/** What the quit guard and its dialog read from the engine. */
export interface QuitInputs
{
  busy: boolean
  status: RunStatus
  runId: RunId | null
  /** Active jobs and dispatch claims. */
  active: number
  /** Queued jobs without a dispatch claim. */
  queued: number
  quitWhenIdle: boolean
}

/** The engine-wide values other modules read. */
export interface CoreGlobals
{
  policy: BatchPolicy
  settings: RunSettings
  defaultRecipe: Recipe
  capabilities: CapabilitySummary
  presets: PresetState
  recentFolders: RecentFolder[]
  workers: WorkersState
  limits: { maxJobs: number }
}

/** A transition's outcome. */
export type TransitionResult =
  | { applied: false; job: Readonly<Job> | null }
  | {
    applied: true
    job: Readonly<Job>
    row: JobTransition
    /** Resolves true once the transition's line is durable, false when it could not be written; true at once for a line that need not be durable. */
    durable: Promise<boolean>
  }

/** A run record with no run. */
export function idleRun(): RunRecord
{
  return { status: 'idle', runId: null, startedAt: null, pause: null, needsAck: null, interruptions: 0 }
}

/** The progress of a run with nothing done yet. */
export function idleProgress(): RunProgress
{
  return { percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 }
}

function lastSegment(path: string): string
{
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** A plan's Review columns from the plan alone, for when no planner builder is given: no encoder label, no issues. */
export function basicPlanSummary(plan: JobPlan, current: boolean): PlanSummary
{
  const finalName = lastSegment(plan.output.renamedTo ?? plan.output.finalPath)
  return {
    status: plan.output.resolution === 'skip' ? 'will-skip' : 'ready',
    current,
    finalName,
    relativePath: finalName,
    container: plan.output.container,
    resolution: plan.output.resolution,
    encoderLabel: plan.class === 'copy' ? 'copy' : '',
    errors: 0,
    warnings: 0,
    firstIssue: null
  }
}

/** What a row reads beyond its job: the revisions a plan must match, and the builders. */
export interface ViewContext
{
  policyRev: number
  capabilitiesRev: number
  builders: ViewBuilders
}

/** Whether a job's plan still matches its inputs, the policy, and the capabilities (invariant 9). */
export function planIsCurrent(job: Readonly<Job>, policyRev: number, capabilitiesRev: number): boolean
{
  const basis = job.plan?.basis
  return basis !== undefined && basis.inputsRev === job.inputsRev && basis.policyRev === policyRev &&
    basis.capabilitiesRev === capabilitiesRev
}

/** A job's row. */
export function toJobView(job: Readonly<Job>, context: ViewContext): JobView
{
  const { error, plan } = job
  return {
    id: job.id,
    seq: job.seq,
    rev: job.rev,
    inputsRev: job.inputsRev,
    source: job.source,
    recipe: job.recipe,
    recipeLabel: describeRecipe(job.recipe),
    state: job.state,
    reason: job.reason,
    attempt: job.attempt,
    restarts: job.restarts,
    abort: job.abort,
    stage: job.stage,
    progress: job.progress,
    media: job.media,
    probe: job.probe,
    plan: plan === null ? null : context.builders.planSummary(plan, planIsCurrent(job, context.policyRev, context.capabilitiesRev), job),
    audioPlan: context.builders.audioPlan(job),
    stamp: job.result?.stamp ?? null,
    error: error === null ? null : { code: error.code, short: error.short, message: error.message, stage: error.stage, at: error.at },
    warnings: job.warnings,
    hold: job.hold,
    waiting: job.waiting,
    waitingOn: job.waitingOn,
    analysis: job.analysis,
    previewed: job.previewed,
    acknowledged: job.acknowledged,
    runId: job.runId,
    rerunOf: job.rerunOf,
    addedAt: job.addedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    albumGroupId: plan?.album?.groupId ?? null
  }
}

function same(a: unknown, b: unknown): boolean
{
  if (Object.is(a, b))
  {
    return true
  }
  return typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && canonicalJson(a) === canonicalJson(b)
}

/** The row fields that differ between two views of a job; `omit` leaves out what the event carries itself. */
export function viewPatch(before: JobView, after: JobView, omit: ReadonlyArray<keyof JobView> = []): JobPatch
{
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(after) as Array<keyof JobView>)
  {
    if (key !== 'id' && key !== 'seq' && !omit.includes(key) && !same(before[key], after[key]))
    {
      patch[key] = after[key]
    }
  }
  return patch as JobPatch
}

/** A job as `state.json` keeps it: the stage and progress are volatile and never journaled. */
export function persistedJob(job: Readonly<Job>): Job
{
  return { ...job, stage: null, progress: null }
}

function isCoreEntry(entry: { type: string }): entry is CoreJournalEntry
{
  return (CORE_ENTRY_TYPES as readonly string[]).includes(entry.type)
}

/**
 * Applies the core's journal lines to a saved state body in line order, skipping other modules' lines. Replaying
 * the lines written after a `persisted()` body gives what `persisted()` returns after the last of them.
 */
export function replayJournal(body: CoreStateBody, entries: Iterable<{ type: string }>): CoreStateBody
{
  const jobs = new Map<JobId, Job>(body.jobs.map((job) => [job.id, { ...job }]))
  let order = body.order.filter((id) => jobs.has(id))
  let run: RunRecord = { ...body.run }
  let policy = body.policy
  let defaultRecipe = body.defaultRecipe
  for (const entry of entries)
  {
    if (!isCoreEntry(entry))
    {
      continue
    }
    switch (entry.type)
    {
      case 'job.state':
      case 'job.change':
      {
        const job = jobs.get(entry.jobId)
        if (job !== undefined)
        {
          Object.assign(job, entry.change, { rev: entry.rev, inputsRev: entry.inputsRev })
        }
        break
      }
      case 'job.add':
      {
        const added = entry.jobs.filter((job) => !jobs.has(job.id))
        for (const job of added)
        {
          jobs.set(job.id, { ...job })
        }
        const index = entry.after === null ? -1 : order.indexOf(entry.after)
        const at = entry.after === null ? 0 : (index === -1 ? order.length : index + 1)
        order = [...order.slice(0, at), ...added.map((job) => job.id), ...order.slice(at)]
        break
      }
      case 'job.remove':
      {
        const removed = new Set(entry.ids)
        for (const id of removed)
        {
          jobs.delete(id)
        }
        order = order.filter((id) => !removed.has(id))
        break
      }
      case 'job.restore':
        for (const job of entry.jobs)
        {
          jobs.set(job.id, { ...job })
        }
        order = entry.order.filter((id) => jobs.has(id))
        break
      case 'queue.order':
        order = entry.order.filter((id) => jobs.has(id))
        break
      case 'run':
        run = { ...entry.run }
        break
      case 'policy':
        policy = entry.policy
        break
      case 'default-recipe':
        defaultRecipe = entry.recipe
        break
    }
  }
  return { policy, defaultRecipe, run, order, jobs: order.map((id) => jobs.get(id) as Job) }
}

/** The core every engine module takes; engine state changes only through it. */
export interface EngineCore
{
  readonly queue: JobQueue
  readonly bus: JobEventBus
  readonly log: JobLogger
  now(): number
  /**
   * Moves a job by a trigger of the transition table, only when the job is in one of `expectedFrom` and the table has
   * a row for the trigger there; any other call is logged and ignored. One transition increments `rev` once and
   * enqueues exactly one `job.state` in the caller's turn. A job with a recorded abort moves only by that abort or by
   * an interruption, so a runner's result and a cancel never both apply.
   */
  transition(id: JobId, expectedFrom: readonly JobState[], trigger: JobTrigger, options?: TransitionOptions): TransitionResult
  /** Changes a job's other fields with one `job.updated`; the state, reason, stage, and progress are refused here. */
  update(id: JobId, change: JobChange, options?: { inputs?: boolean }): Readonly<Job> | null
  /** Starts a stage of the job's current state with `job.stage`, then its starting progress; `rev` stays. */
  stage(id: JobId, stage: JobStage, progress?: JobProgress | null): boolean
  /** Records progress of the job's current stage; the bus coalesces it. */
  progress(id: JobId, progress: JobProgress): boolean
  /** Stores a measurement with `job.measured`, then the row fields it changes with `job.updated`. */
  measured(id: JobId, measurement: JobMeasurement): Readonly<Job> | null
  /** Stores a verification with `job.verified`. */
  verified(id: JobId, verification: Verification): Readonly<Job> | null
  /** Records a command the job's attempt ran, for its detail. */
  recordCommand(id: JobId, command: CommandRecord): void
  /** Adds pending jobs (T1) with one `job.added` each; null when the catalog block holds too few numbers. */
  add(inits: readonly NewJob[], after?: JobId | null): Array<Readonly<Job>> | null
  /** Takes jobs out with one `job.removed` each and returns them for a tombstone. */
  remove(ids: readonly JobId[]): RemovedJob[]
  /** Puts removed jobs back with one `job.added` each and the new `queue.order`. */
  restore(entries: readonly RemovedJob[]): JobId[]
  reorder(ids: readonly JobId[], before: JobId | null): MoveResult | null
  move(ids: readonly JobId[], kind: QueueMove): MoveResult
  /** Runs a compound change and settles the run once at its end, so a run never completes halfway through it. */
  batch<T>(fn: () => T): T
  /**
   * Records the abort of a job that runs a child process, emitted at once as `job.updated` so the command's reply
   * covers it; it applies after the child exits (`settleAbort`). A cancel or skip replaces a recorded requeue.
   */
  recordAbort(id: JobId, intent: AbortIntent, reason?: StateReason): boolean
  /** Applies a recorded abort once the child has exited: T14, T15, or T13 to the head of the queue. */
  settleAbort(id: JobId, options?: Omit<TransitionOptions, 'reason'>): TransitionResult
  /** Called in the turn an abort is recorded, so the child can be stopped. */
  onAbort(listener: (id: JobId, intent: AbortIntent) => void): () => void
  /** Takes the dispatch claim on a queued job; it counts as active until it is committed or released. */
  claim(id: JobId): boolean
  releaseClaim(id: JobId): boolean
  isClaimed(id: JobId): boolean
  claims(): JobId[]
  run(): RunState
  /** Starts a run from idle, or returns the run that new queued jobs join; null while a run is canceling. */
  startRun(runId: RunId): RunId | null
  /** Pauses the run in either mode; stop-running also records a requeue for every analyzing and encoding job. */
  pauseRun(mode: PauseMode, reason: PauseReason): boolean
  /** Resumes a pausing or paused run and clears `quitWhenIdle`; a restored replace policy needs `acknowledged`. */
  resumeRun(options?: { acknowledged?: boolean }): boolean
  /** Cancels the run: queued jobs at once (T8), running jobs once their children exit (T14); finalizing jobs finish. */
  cancelRun(): boolean
  setQuitWhenIdle(value: boolean): void
  setNeedsAck(value: RunState['needsAck']): void
  /** Moves the run on when its jobs allow it: drained before settled, and completion exactly once. */
  settle(): void
  /**
   * Marks every job that runs a child process interrupted (T31) without settling the run, which keeps its id for
   * the next start. With `capture` the lines are returned instead of appended, for the synchronous session-end write.
   */
  interruptActive(reason: 'quit' | 'crash' | 'session-end', options?: { capture?: boolean }): CoreJournalEntry[]
  /** Jobs in the active states plus dispatch claims. */
  activeCount(): number
  /** Active or claimed jobs, or queued jobs in a running or pausing run. */
  isBusy(): boolean
  quitInputs(): QuitInputs
  onRunState(listener: (run: RunState) => void): () => void
  setRunProgress(progress: RunProgress): void
  setWorkers(workers: WorkersState): void
  globals(): Readonly<CoreGlobals>
  /** Replaces the policy; rows whose plan stops or starts matching it get `job.updated`. */
  setPolicy(policy: BatchPolicy): void
  setSettings(settings: RunSettings): void
  setDefaultRecipe(recipe: Recipe): void
  /** Replaces the capabilities; rows whose plan stops or starts matching them get `job.updated`. */
  setCapabilities(capabilities: CapabilitySummary): void
  setPresets(presets: PresetState): void
  setRecentFolders(folders: RecentFolder[]): void
  upsertScan(scan: ScanState): void
  preflightProgress(preflightId: string, done: number, total: number): void
  raiseAlert(alert: RunAlert): void
  clearAlert(alertId: string): boolean
  alerts(): RunAlert[]
  focus(jobId: JobId | null, runId: RunId | null): void
  view(id: JobId): JobView | null
  snapshot(seq: number): EngineSnapshot
  /** Flushes pending events, builds the snapshot at the last seq, and registers the sender, in one turn. */
  subscribe(sender: EventSender, clientId: string): EngineSnapshot
  unsubscribe(senderId: number, clientId: string): boolean
  /** The selected job's detail, with the last 16 KiB of its attempt log. */
  get(id: JobId): Promise<JobDetail | null>
  /** The state body for `state.json`, built in the caller's turn. */
  persisted(): CoreStateBody
}

const ABORT_TRIGGERS: Readonly<Record<AbortIntent, JobTrigger>> = { cancel: 'cancel', skip: 'skip', requeue: 'requeue' }

const ABORT_REASONS: Readonly<Record<AbortIntent, StateReason>> = { cancel: 'user', skip: 'user', requeue: 'requeued-pause' }

const RETRY_TRIGGERS: readonly JobTrigger[] = ['retry', 'retry-changed', 'edit-retry']

const TRANSITION_ONLY: ReadonlyArray<keyof JobChange> = ['state', 'reason', 'stage', 'progress']

const STATE_EVENT_FIELDS: ReadonlyArray<keyof JobView> = ['rev', 'state', 'reason', 'attempt']

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** What a retry resets: a new attempt starts unacknowledged and without the outcome of the one before it. */
function newAttempt(job: Readonly<Job>): JobChange
{
  return {
    attempt: job.attempt + 1,
    restarts: 0,
    acknowledged: false,
    startedAt: null,
    endedAt: null,
    error: null,
    hold: null,
    result: null,
    verification: null,
    warnings: []
  }
}

function defined(change: JobChange): JobChange
{
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(change))
  {
    if (value !== undefined)
    {
      out[key] = value
    }
  }
  return toWire(out) as JobChange
}

function journaled(change: JobChange): JobChange
{
  const out = { ...change }
  delete out.stage
  delete out.progress
  return out
}

function stageOutcome(to: JobState): StageRecord['outcome']
{
  switch (to)
  {
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'skipped':
    case 'interrupted':
    case 'queued':
    case 'pending':
      return 'skipped'
    default:
      return 'done'
  }
}

/** Builds the core over a queue, a bus, and a journal. */
export function createEngineCore(options: EngineCoreOptions): EngineCore
{
  const { queue, bus, journal, log, summarize } = options
  const now = (): number => options.now()
  const planSummary = options.views?.planSummary ?? basicPlanSummary
  const audioPlan = options.views?.audioPlan ?? ((): null => null)
  const builders: ViewBuilders =
  {
    planSummary(plan, current, job)
    {
      try
      {
        return planSummary(plan, current, job)
      }
      catch (err)
      {
        log.error(`Could not summarize the plan of ${job.id}: ${errorText(err)}`)
        return basicPlanSummary(plan, current)
      }
    },
    audioPlan(job)
    {
      try
      {
        return audioPlan(job)
      }
      catch (err)
      {
        log.error(`Could not build the audio plan of ${job.id}: ${errorText(err)}`)
        return null
      }
    }
  }
  const detail = options.detail ?? {}
  const maxJobs = options.state.maxJobs ?? MAX_JOBS
  let policy = options.state.policy
  let settings = options.state.settings
  let defaultRecipe = options.state.defaultRecipe
  let capabilities = options.state.capabilities
  let workers = options.state.workers
  let presets = options.state.presets
  let recentFolders = options.state.recentFolders
  let record: RunRecord = { ...(options.state.run ?? idleRun()) }
  let runProgress = idleProgress()
  let quitWhenIdle = false
  const alertMap = new Map<string, RunAlert>((options.state.alerts ?? []).map((alert) => [alert.id, alert]))
  const scans = new Map<string, ScanState>()
  const claimed = new Set<JobId>()
  const abortReasons = new Map<JobId, StateReason>()
  const stageLog = new Map<JobId, { attempt: number; entries: StageRecord[] }>()
  const commandLog = new Map<JobId, { attempt: number; entries: CommandRecord[] }>()
  const completed = new Set<RunId>()
  const abortListeners = new Set<(id: JobId, intent: AbortIntent) => void>()
  const runListeners = new Set<(run: RunState) => void>()
  let depth = 0
  let quiet = 0
  let held: CoreJournalEntry[] | null = null

  const viewOf = (job: Readonly<Job>): JobView =>
    toJobView(job, { policyRev: policy.rev, capabilitiesRev: capabilities.rev, builders })

  function emit(event: DraftEvent): void
  {
    bus.emit(toWire(event))
  }

  function write(entry: CoreJournalEntry): Promise<boolean>
  {
    const line = toWire(entry)
    if (held !== null)
    {
      held.push(line)
      return Promise.resolve(true)
    }
    try
    {
      return Promise.resolve(journal.append(line) >= 0)
    }
    catch (err)
    {
      log.error(`Could not journal ${entry.type}: ${errorText(err)}`)
      return Promise.resolve(false)
    }
  }

  function writeDurable(entry: Extract<CoreJournalEntry, { type: 'job.state' }>): Promise<boolean>
  {
    let pending: Promise<number[]>
    try
    {
      pending = journal.appendDurable([toWire(entry)])
    }
    catch (err)
    {
      pending = Promise.reject(err)
    }
    return pending.then(() => true, (err: unknown) =>
    {
      log.error(`Could not make ${entry.transition} for ${entry.jobId} durable: ${errorText(err)}`)
      return false
    })
  }

  function notify<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void
  {
    for (const listener of listeners)
    {
      try
      {
        listener(...args)
      }
      catch (err)
      {
        log.error(`A listener failed: ${errorText(err)}`)
      }
    }
  }

  function settleAfter(): void
  {
    if (depth === 0 && quiet === 0)
    {
      settle()
    }
  }

  function batch<T>(fn: () => T): T
  {
    depth += 1
    try
    {
      return fn()
    }
    finally
    {
      depth -= 1
      settleAfter()
    }
  }

  function trackStage(job: Readonly<Job>, stage: JobStage | null, outcome: StageRecord['outcome']): void
  {
    let history = stageLog.get(job.id)
    if (history === undefined || history.attempt !== job.attempt)
    {
      history = { attempt: job.attempt, entries: [] }
      stageLog.set(job.id, history)
    }
    const last = history.entries[history.entries.length - 1]
    if (last !== undefined && last.outcome === 'active')
    {
      last.endedAt = now()
      last.outcome = outcome
    }
    if (stage !== null)
    {
      history.entries.push({ id: stage.id, pass: stage.pass, passes: stage.passes, label: stage.label, startedAt: stage.startedAt, endedAt: null, outcome: 'active' })
    }
  }

  function orderChanged(): void
  {
    const order = queue.order()
    emit({ type: 'queue.order', order })
    void write({ type: 'queue.order', order })
  }

  function ignore(id: JobId, job: Readonly<Job> | undefined, trigger: JobTrigger, why: string): TransitionResult
  {
    log.warn(`Ignored ${trigger} for ${id}: ${why}`)
    return { applied: false, job: job ?? null }
  }

  function automatic(job: Readonly<Job>, trigger: JobTrigger, to: JobState, at: number): JobChange
  {
    const change: JobChange = { abort: null }
    const group = STATE_GROUPS[to]
    if (trigger === 'dispatch')
    {
      change.execution = job.execution + 1
      change.startedAt = job.startedAt ?? at
    }
    else if (trigger === 'requeue')
    {
      change.restarts = job.restarts + 1
    }
    else if (RETRY_TRIGGERS.includes(trigger))
    {
      Object.assign(change, newAttempt(job))
    }
    if (to !== 'held' && job.hold !== null)
    {
      change.hold = null
    }
    if (group === 'terminal' || group === 'decision')
    {
      change.endedAt = at
    }
    else if (job.endedAt !== null)
    {
      change.endedAt = null
    }
    return change
  }

  function transition(id: JobId, expectedFrom: readonly JobState[], trigger: JobTrigger, opts: TransitionOptions = {}): TransitionResult
  {
    const job = queue.get(id)
    if (job === undefined)
    {
      return ignore(id, job, trigger, 'no such job')
    }
    if (!expectedFrom.includes(job.state))
    {
      return ignore(id, job, trigger, `${job.state} is not one of ${expectedFrom.join(', ')}`)
    }
    const row = transitionFor(job, trigger)
    if (row === null || row.to === 'removed' || !row.changesState)
    {
      return ignore(id, job, trigger, `no transition from ${job.state}`)
    }
    const to = row.to as JobState
    const reason = opts.reason ?? row.reasons[0]
    if (!row.reasons.includes(reason))
    {
      return ignore(id, job, trigger, `${reason} is not a reason of ${row.id}`)
    }
    if (job.abort !== null && trigger !== ABORT_TRIGGERS[job.abort] && trigger !== 'interrupt')
    {
      return ignore(id, job, trigger, `the recorded ${job.abort} settles it first`)
    }
    const stage = STATE_GROUPS[to] === 'active' ? (opts.stage ?? null) : null
    if (stage !== null && STAGE_STATES[stage.id] !== to)
    {
      return ignore(id, job, trigger, `stage ${stage.id} does not run in ${to}`)
    }
    const before = viewOf(job)
    const from = job.state
    const change = defined({
      ...automatic(job, trigger, to, now()),
      ...opts.change,
      stage,
      progress: stage === null ? null : (opts.progress ?? null),
      state: to,
      reason
    })
    const next = queue.update(id, change) as Readonly<Job>
    claimed.delete(id)
    abortReasons.delete(id)
    trackStage(next, stage, stageOutcome(to))
    emit({ type: 'job.state', jobId: id, rev: next.rev, from, to, attempt: next.attempt, reason, patch: viewPatch(before, viewOf(next), STATE_EVENT_FIELDS) })
    const entry: Extract<CoreJournalEntry, { type: 'job.state' }> =
    {
      type: 'job.state',
      jobId: id,
      transition: row.id,
      from,
      to,
      reason,
      attempt: next.attempt,
      rev: next.rev,
      inputsRev: next.inputsRev,
      change: journaled(change),
      begin: to === 'finalizing' ? (opts.begin ?? null) : null
    }
    const durable = row.durable && held === null ? writeDurable(entry) : write(entry)
    if (trigger === 'requeue' && queue.move([id], 'run-next').changed)
    {
      orderChanged()
    }
    settleAfter()
    return { applied: true, job: next, row, durable }
  }

  function update(id: JobId, change: JobChange, opts: { inputs?: boolean } = {}): Readonly<Job> | null
  {
    const job = queue.get(id)
    if (job === undefined)
    {
      log.warn(`Ignored a change to ${id}: no such job`)
      return null
    }
    const refused = TRANSITION_ONLY.filter((key) => change[key] !== undefined)
    if (refused.length > 0)
    {
      log.warn(`Ignored a change to ${id}: ${refused.join(', ')} change only through a transition or a stage`)
      return null
    }
    const before = viewOf(job)
    const rev = job.rev
    const clean = defined(change)
    const next = queue.update(id, clean, opts) as Readonly<Job>
    if (next.rev === rev)
    {
      return next
    }
    emit({ type: 'job.updated', jobId: id, rev: next.rev, patch: viewPatch(before, viewOf(next), ['rev']) })
    void write({ type: 'job.change', jobId: id, rev: next.rev, inputsRev: next.inputsRev, change: clean })
    return next
  }

  function stage(id: JobId, next: JobStage, progress: JobProgress | null = null): boolean
  {
    const job = queue.get(id)
    if (job === undefined || STAGE_STATES[next.id] !== job.state)
    {
      log.warn(`Ignored stage ${next.id} for ${id}: ${job === undefined ? 'no such job' : `it does not run in ${job.state}`}`)
      return false
    }
    const live = job as Job
    live.stage = next
    live.progress = progress
    trackStage(job, next, 'done')
    emit({ type: 'job.stage', jobId: id, rev: job.rev, stage: next })
    if (progress !== null)
    {
      emit({ type: 'job.progress', jobId: id, progress })
    }
    return true
  }

  function progress(id: JobId, value: JobProgress): boolean
  {
    const job = queue.get(id)
    if (job === undefined || job.stage === null || job.stage.id !== value.stage)
    {
      log.debug(`Dropped progress for ${id}: it is not in stage ${value.stage}`)
      return false
    }
    (job as Job).progress = value
    emit({ type: 'job.progress', jobId: id, progress: value })
    return true
  }

  function storeResult(id: JobId, change: JobChange, event: (job: Readonly<Job>, clean: JobChange) => DraftEvent): Readonly<Job> | null
  {
    const job = queue.get(id)
    if (job === undefined)
    {
      log.warn(`Ignored a result for ${id}: no such job`)
      return null
    }
    const before = viewOf(job)
    const clean = defined(change)
    const next = queue.update(id, clean) as Readonly<Job>
    emit(event(next, clean))
    const patch = viewPatch(before, viewOf(next), ['rev'])
    if (Object.keys(patch).length > 0)
    {
      emit({ type: 'job.updated', jobId: id, rev: next.rev, patch })
    }
    void write({ type: 'job.change', jobId: id, rev: next.rev, inputsRev: next.inputsRev, change: clean })
    return next
  }

  function measured(id: JobId, measurement: JobMeasurement): Readonly<Job> | null
  {
    return storeResult(id, { measurement }, (job, clean) =>
      ({ type: 'job.measured', jobId: id, rev: job.rev, measurement: clean.measurement as JobMeasurement }))
  }

  function verified(id: JobId, verification: Verification): Readonly<Job> | null
  {
    return storeResult(id, { verification }, (job, clean) =>
      ({ type: 'job.verified', jobId: id, rev: job.rev, verification: clean.verification as Verification }))
  }

  function recordCommand(id: JobId, command: CommandRecord): void
  {
    const job = queue.get(id)
    if (job === undefined)
    {
      return
    }
    let history = commandLog.get(id)
    if (history === undefined || history.attempt !== job.attempt)
    {
      history = { attempt: job.attempt, entries: [] }
      commandLog.set(id, history)
    }
    history.entries.push({ ...command })
  }

  function add(inits: readonly NewJob[], after: JobId | null = null): Array<Readonly<Job>> | null
  {
    const jobs = queue.add(inits, after)
    if (jobs === null)
    {
      log.warn(`Could not add ${inits.length} jobs: too few catalog numbers are reserved`)
      return null
    }
    if (jobs.length === 0)
    {
      return jobs
    }
    const order = queue.order()
    const predecessor = order[order.indexOf(jobs[0].id) - 1] ?? null
    jobs.forEach((job, index) =>
    {
      emit({ type: 'job.added', job: viewOf(job), after: index === 0 ? predecessor : jobs[index - 1].id })
    })
    void write({ type: 'job.add', after: predecessor, jobs: jobs.map(persistedJob) })
    return jobs
  }

  function remove(ids: readonly JobId[]): RemovedJob[]
  {
    const removed = queue.remove(ids)
    if (removed.length === 0)
    {
      return removed
    }
    for (const entry of removed)
    {
      const id = entry.job.id
      claimed.delete(id)
      abortReasons.delete(id)
      stageLog.delete(id)
      commandLog.delete(id)
      emit({ type: 'job.removed', jobId: id })
    }
    void write({ type: 'job.remove', ids: removed.map((entry) => entry.job.id) })
    settleAfter()
    return removed
  }

  function restore(entries: readonly RemovedJob[]): JobId[]
  {
    const ids = queue.restore(entries)
    if (ids.length === 0)
    {
      return ids
    }
    const order = queue.order()
    const restored = ids.map((id) => queue.get(id) as Readonly<Job>)
    for (const job of restored)
    {
      emit({ type: 'job.added', job: viewOf(job), after: order[order.indexOf(job.id) - 1] ?? null })
    }
    emit({ type: 'queue.order', order })
    void write({ type: 'job.restore', jobs: restored.map(persistedJob), order })
    return ids
  }

  function reorder(ids: readonly JobId[], before: JobId | null): MoveResult | null
  {
    const result = queue.reorder(ids, before)
    if (result !== null && result.changed)
    {
      orderChanged()
    }
    return result
  }

  function move(ids: readonly JobId[], kind: QueueMove): MoveResult
  {
    const result = queue.move(ids, kind)
    if (result.changed)
    {
      orderChanged()
    }
    return result
  }

  function recordAbort(id: JobId, intent: AbortIntent, reason: StateReason = ABORT_REASONS[intent]): boolean
  {
    const job = queue.get(id)
    if (job === undefined || !RUNNING_STATES.includes(job.state))
    {
      log.warn(`Ignored ${intent} for ${id}: it runs no child process`)
      return false
    }
    if (job.abort === intent)
    {
      return true
    }
    if (job.abort !== null && (job.abort !== 'requeue' || intent === 'requeue'))
    {
      log.warn(`Ignored ${intent} for ${id}: ${job.abort} is already recorded`)
      return false
    }
    update(id, { abort: intent })
    abortReasons.set(id, reason)
    notify(abortListeners, id, intent)
    return true
  }

  function settleAbort(id: JobId, opts: Omit<TransitionOptions, 'reason'> = {}): TransitionResult
  {
    const job = queue.get(id)
    if (job === undefined || job.abort === null)
    {
      log.warn(`Ignored an abort for ${id}: none is recorded`)
      return { applied: false, job: job ?? null }
    }
    const reason = abortReasons.get(id) ?? ABORT_REASONS[job.abort]
    return transition(id, RUNNING_STATES, ABORT_TRIGGERS[job.abort], { ...opts, reason })
  }

  function claim(id: JobId): boolean
  {
    if (queue.get(id)?.state !== 'queued' || claimed.has(id))
    {
      return false
    }
    claimed.add(id)
    return true
  }

  function releaseClaim(id: JobId): boolean
  {
    if (!claimed.delete(id))
    {
      return false
    }
    settleAfter()
    return true
  }

  function activeCount(): number
  {
    return ACTIVE_STATES.reduce((sum, state) => sum + queue.count(state), 0) + claimed.size
  }

  function runState(): RunState
  {
    return {
      status: record.status,
      runId: record.runId,
      startedAt: record.startedAt,
      pause: record.pause,
      counts: { ...queue.counts() },
      progress: runProgress,
      workers,
      quitWhenIdle,
      needsAck: record.needsAck
    }
  }

  function runChanged(persist: boolean): void
  {
    const run = runState()
    emit({ type: 'run.state', run })
    if (persist)
    {
      void write({ type: 'run', run: { ...record } })
    }
    notify(runListeners, run)
  }

  function complete(endedBy: 'completed' | 'canceled'): void
  {
    const ended = record
    const at = now()
    record = idleRun()
    runProgress = idleProgress()
    runChanged(true)
    const runId = ended.runId
    if (runId === null || completed.has(runId))
    {
      return
    }
    completed.add(runId)
    const jobs = queue.jobs().filter((job) => job.runId === runId)
    try
    {
      const summary = summarize({ runId, startedAt: ended.startedAt ?? at, endedAt: at, endedBy, interruptions: ended.interruptions, jobs })
      emit({ type: 'run.completed', summary })
    }
    catch (err)
    {
      log.error(`Could not summarize ${runId}: ${errorText(err)}`)
    }
  }

  function settle(): void
  {
    if (record.status === 'idle')
    {
      return
    }
    const active = activeCount()
    const drained = queue.count('queued') === 0 && active === 0 ? runTransitionFor(record.status, 'drained', 0) : null
    const row = drained ?? (active === 0 ? runTransitionFor(record.status, 'settled', 0) : null)
    if (row === null)
    {
      return
    }
    if (row.endedBy !== null)
    {
      complete(row.endedBy)
      return
    }
    record = { ...record, status: row.to }
    runChanged(true)
  }

  function startRun(runId: RunId): RunId | null
  {
    const cleared = quitWhenIdle
    quitWhenIdle = false
    const row = runTransitionFor(record.status, 'start', activeCount())
    if (row !== null && !completed.has(runId))
    {
      record = { status: row.to, runId, startedAt: now(), pause: null, needsAck: null, interruptions: 0 }
      runProgress = idleProgress()
      runChanged(true)
      return runId
    }
    if (cleared)
    {
      runChanged(false)
    }
    if (row !== null || record.status === 'canceling')
    {
      log.warn(`Refused to start ${runId}: ${row !== null ? 'it has completed' : `${record.runId} is canceling`}`)
      return null
    }
    return record.runId
  }

  function requeueRunning(): void
  {
    for (const job of queue.jobs())
    {
      if (job.state === 'analyzing' || job.state === 'encoding')
      {
        recordAbort(job.id, 'requeue', 'requeued-pause')
      }
    }
  }

  function pauseRun(mode: PauseMode, reason: PauseReason): boolean
  {
    const row = runTransitionFor(record.status, 'pause', activeCount())
    if (row !== null)
    {
      record = { ...record, status: row.to, pause: { mode, reason, since: now() } }
    }
    else if (record.pause !== null && (record.status === 'pausing' || record.status === 'paused'))
    {
      if (mode !== 'stop-running' || record.pause.mode === 'stop-running')
      {
        return true
      }
      record = { ...record, pause: { ...record.pause, mode } }
    }
    else
    {
      log.warn(`Ignored a pause: the run is ${record.status}`)
      return false
    }
    batch(() =>
    {
      runChanged(true)
      if (mode === 'stop-running')
      {
        requeueRunning()
      }
    })
    return true
  }

  function resumeRun(opts: { acknowledged?: boolean } = {}): boolean
  {
    const row = runTransitionFor(record.status, 'resume', activeCount())
    if (row === null || (record.needsAck !== null && opts.acknowledged !== true))
    {
      log.warn(`Ignored a resume: ${row === null ? `the run is ${record.status}` : 'the restored replace policy needs acknowledgment'}`)
      setQuitWhenIdle(false)
      return false
    }
    record = { ...record, status: row.to, pause: null, needsAck: null }
    quitWhenIdle = false
    batch(() => runChanged(true))
    return true
  }

  function cancelRun(): boolean
  {
    const row = runTransitionFor(record.status, 'cancel', activeCount())
    if (row === null)
    {
      log.warn(`Ignored a cancel: the run is ${record.status}`)
      return false
    }
    record = { ...record, status: row.to, pause: null }
    batch(() =>
    {
      runChanged(true)
      for (const job of queue.jobs())
      {
        if (job.state === 'queued')
        {
          transition(job.id, ['queued'], 'cancel', { reason: 'run-canceled' })
        }
        else if (RUNNING_STATES.includes(job.state))
        {
          recordAbort(job.id, 'cancel', 'run-canceled')
        }
      }
    })
    return true
  }

  function setQuitWhenIdle(value: boolean): void
  {
    if (quitWhenIdle !== value)
    {
      quitWhenIdle = value
      runChanged(false)
    }
  }

  function setNeedsAck(value: RunState['needsAck']): void
  {
    record = { ...record, needsAck: value }
    runChanged(true)
  }

  function interruptActive(reason: 'quit' | 'crash' | 'session-end', opts: { capture?: boolean } = {}): CoreJournalEntry[]
  {
    const lines: CoreJournalEntry[] = []
    held = opts.capture === true ? lines : null
    quiet += 1
    try
    {
      for (const job of queue.jobs())
      {
        if (RUNNING_STATES.includes(job.state))
        {
          transition(job.id, RUNNING_STATES, 'interrupt', { reason })
        }
      }
    }
    finally
    {
      quiet -= 1
      held = null
    }
    return lines
  }

  function isBusy(): boolean
  {
    return activeCount() > 0 || ((record.status === 'running' || record.status === 'pausing') && queue.count('queued') > 0)
  }

  function refreshPlans(change: () => void): void
  {
    const before = new Map<JobId, JobView>()
    for (const job of queue.jobs())
    {
      if (job.plan !== null)
      {
        before.set(job.id, viewOf(job))
      }
    }
    change()
    for (const [id, view] of before)
    {
      const job = queue.get(id) as Readonly<Job>
      const patch = viewPatch(view, viewOf(job), ['rev'])
      if (Object.keys(patch).length > 0)
      {
        emit({ type: 'job.updated', jobId: id, rev: job.rev, patch })
      }
    }
  }

  function snapshot(seq: number): EngineSnapshot
  {
    const built: EngineSnapshot =
    {
      schema: 1,
      seq,
      run: runState(),
      policy,
      settings,
      defaultRecipe,
      order: queue.order(),
      jobs: queue.jobs().map(viewOf),
      capabilities,
      scans: [...scans.values()],
      alerts: [...alertMap.values()],
      presets,
      recentFolders,
      limits: { maxJobs }
    }
    return toWire(built)
  }

  async function stderrTail(job: Readonly<Job>, history: HistoryRecord | null): Promise<string | null>
  {
    const ring = detail.ring?.(job.id) ?? null
    if (ring !== null)
    {
      return ring.tail(DETAIL_TAIL_BYTES)
    }
    const path = history?.logFile ??
      (job.runId !== null && job.startedAt !== null && detail.logsDir !== undefined ? attemptLogPath(detail.logsDir, job.runId, job.id, job.attempt) : null)
    if (path === null || detail.readLog === undefined)
    {
      return null
    }
    try
    {
      const text = await detail.readLog(path)
      return text === null ? null : tailAtLineBoundary(text, DETAIL_TAIL_BYTES)
    }
    catch (err)
    {
      log.warn(`Could not read the attempt log of ${job.id}: ${errorText(err)}`)
      return null
    }
  }

  async function readHistory(job: Readonly<Job>): Promise<HistoryRecord | null>
  {
    if (job.history === null || detail.history === undefined)
    {
      return null
    }
    try
    {
      return await detail.history(job)
    }
    catch (err)
    {
      log.warn(`Could not read the history record of ${job.id}: ${errorText(err)}`)
      return null
    }
  }

  async function get(id: JobId): Promise<JobDetail | null>
  {
    const job = queue.get(id)
    if (job === undefined)
    {
      return null
    }
    const view = viewOf(job)
    const media = detail.media?.(job) ?? null
    const stages = stageLog.get(id)
    const commands = commandLog.get(id)
    const history = await readHistory(job)
    const built: JobDetail =
    {
      view,
      plan: job.plan ?? history?.plan ?? null,
      media,
      measurement: job.measurement ?? history?.measurement ?? null,
      verification: job.verification ?? history?.verification ?? null,
      result: job.result ?? history?.result ?? null,
      error: job.error ?? history?.error ?? null,
      stderrTail: await stderrTail(job, history),
      stages: stages !== undefined && stages.attempt === view.attempt ? stages.entries.map((entry) => ({ ...entry })) : [],
      commands: commands !== undefined && commands.attempt === view.attempt ? commands.entries.map((entry) => ({ ...entry })) : [],
      attempts: job.attempts.length > 0 ? [...job.attempts] : (history?.attempts ?? [])
    }
    return toWire(built)
  }

  return {
    queue,
    bus,
    log,
    now,
    transition,
    update,
    stage,
    progress,
    measured,
    verified,
    recordCommand,
    add,
    remove,
    restore,
    reorder,
    move,
    batch,
    recordAbort,
    settleAbort,
    onAbort(listener)
    {
      abortListeners.add(listener)
      return () => abortListeners.delete(listener)
    },
    claim,
    releaseClaim,
    isClaimed: (id) => claimed.has(id),
    claims: () => [...claimed],
    run: runState,
    startRun,
    pauseRun,
    resumeRun,
    cancelRun,
    setQuitWhenIdle,
    setNeedsAck,
    settle,
    interruptActive,
    activeCount,
    isBusy,
    quitInputs: () => ({
      busy: isBusy(),
      status: record.status,
      runId: record.runId,
      active: activeCount(),
      queued: queue.count('queued') - claimed.size,
      quitWhenIdle
    }),
    onRunState(listener)
    {
      runListeners.add(listener)
      return () => runListeners.delete(listener)
    },
    setRunProgress(next)
    {
      runProgress = next
      emit({ type: 'run.progress', progress: next })
    },
    setWorkers(next)
    {
      workers = next
      emit({ type: 'workers.changed', workers: next })
    },
    globals: () => ({ policy, settings, defaultRecipe, capabilities, presets, recentFolders, workers, limits: { maxJobs } }),
    setPolicy(next)
    {
      refreshPlans(() =>
      {
        policy = next
        emit({ type: 'policy.changed', policy: next })
        void write({ type: 'policy', policy: next })
      })
    },
    setSettings(next)
    {
      settings = next
      emit({ type: 'settings.changed', settings: next })
    },
    setDefaultRecipe(recipe)
    {
      defaultRecipe = recipe
      emit({ type: 'defaultRecipe.changed', recipe })
      void write({ type: 'default-recipe', recipe })
    },
    setCapabilities(next)
    {
      refreshPlans(() =>
      {
        capabilities = next
        emit({ type: 'capabilities.changed', capabilities: next })
      })
    },
    setPresets(next)
    {
      presets = next
      emit({ type: 'presets.changed', presets: next })
    },
    setRecentFolders(next)
    {
      recentFolders = next
      emit({ type: 'folders.changed', recentFolders: next })
    },
    upsertScan(scan)
    {
      scans.delete(scan.scanId)
      scans.set(scan.scanId, scan)
      emit({ type: 'scan.progress', scan })
    },
    preflightProgress(preflightId, done, total)
    {
      emit({ type: 'preflight.progress', preflightId, done, total })
    },
    raiseAlert(alert)
    {
      alertMap.set(alert.id, alert)
      emit({ type: 'run.alert', alert })
    },
    clearAlert(alertId)
    {
      if (!alertMap.delete(alertId))
      {
        return false
      }
      emit({ type: 'run.alertCleared', alertId })
      return true
    },
    alerts: () => [...alertMap.values()],
    focus(jobId, runId)
    {
      emit({ type: 'ui.focus', jobId, runId })
    },
    view(id)
    {
      const job = queue.get(id)
      return job === undefined ? null : viewOf(job)
    },
    snapshot,
    subscribe: (sender, clientId) => bus.subscribe(sender, clientId, snapshot),
    unsubscribe: (senderId, clientId) => bus.unsubscribe(senderId, clientId),
    get,
    persisted()
    {
      const body: CoreStateBody = { policy, defaultRecipe, run: { ...record }, order: queue.order(), jobs: queue.jobs().map(persistedJob) }
      return toWire(body)
    }
  }
}

export type { RunId }
