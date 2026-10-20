/**
 * The scheduler: the dispatch loop over the engine core, the claim and its dispatch checks, one execution per
 * dispatched job with its runner and context, the stage to state mapping, aborts, requeues, and the commit to
 * finalizing. Runners never set states; everything that moves a job goes through the core.
 */

import type { JobId, RunId } from '../../shared/jobs/ids'
import { STAGE_STATES } from '../../shared/jobs/states'
import {
  ACTIVE_STATES,
  type FrozenPolicy,
  type Job,
  type JobError,
  type JobErrorCode,
  type JobPlan,
  type JobProgress,
  type JobStage,
  type JobWarning,
  type PauseMode,
  type PauseReason,
  type RunAlert,
  type StageId,
  type StateReason,
  type WorkersState
} from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { AlbumClaim, AlbumOutcome } from './album'
import type { AnalysisOutcome } from './analysis'
import { RUNNING_STATES, type EngineCore } from './core'
import type { FfmpegTools, HostNotification, JobLogger, MeasurementCache, PlannerIO, ProbeQueue, Timers } from './deps'
import { withSpawnHook } from './deps'
import { countOccupancy, dispatchCandidates, planDispatch, workerLimits, workersActive, type JobClass, type QueuedJob, type Slot } from './dispatch'
import type { FinalizeResult, Finalizer } from './finalize'
import { plannedMode } from './finalize'
import type { GpuBudget, GpuJobLease } from './gpu-budget'
import { pathApi, partOutputPath } from './naming'
import type { RunnerSet } from './planner'
import { correctionStages, createJobProgress, createSpeedBook, progressStages, type JobProgressTracker } from './progress'
import type { OutputArtifact, RunContext, RunnableJob, RunOutcome } from './runners/types'
import { committedBytes, fitsOnVolume, volumeLabel, volumeMargin, type VolumeCommitment } from './volumes'
import type { WorkDirCreated, WorkDirEntry, WorkDirRequest, SweepReport } from './workdirs'

/** How long a destination's volume root and folder have to answer before the run pauses. */
export const DESTINATION_TIMEOUT_MS = 5_000

/** How often offline volumes and short volumes are checked again. */
export const RECHECK_MS = 60_000

/** How long after the final kill a job settles without its child's `close`. */
export const STUCK_CHILD_MS = 10_000

/** The POSIX exec's grace between SIGTERM and SIGKILL, after which the stuck-child limit starts. */
export const POSIX_KILL_GRACE_MS = 3_000

/** What asks for a dispatch turn; every trigger in one turn coalesces into one microtask. */
export type DispatchTrigger =
  | 'left-active'
  | 'claim-released'
  | 'queued'
  | 'replanned'
  | 'workers'
  | 'resume'
  | 'gpu-freed'
  | 'album'
  | 'analysis'
  | 'recheck'

/** The album tasks the scheduler drives. */
export interface SchedulerAlbums
{
  waitingOf(jobId: JobId): 'album' | null | undefined
  claim(jobId: JobId): AlbumClaim
  memberLeft(jobId: JobId): void
  pause(mode: PauseMode): void
  cancelRun(): void
  slots(): Slot[]
}

/** The analysis tasks the scheduler drives. */
export interface SchedulerAnalysis
{
  pending(): JobId[]
  running(): JobId[]
  slots(): Slot[]
  start(jobId: JobId): boolean
  cancel(jobId: JobId): boolean
  claimed(jobId: JobId): void
  pause(mode: PauseMode): void
  quitNow(): void
  resume(): void
}

/** The work folder registry as the scheduler uses it. */
export interface SchedulerWorkDirs
{
  create(request: WorkDirRequest): Promise<WorkDirCreated>
  sweep(protect: (entry: WorkDirEntry) => boolean, only?: (entry: WorkDirEntry) => boolean): Promise<SweepReport>
  nextExecution(jobId: JobId, recorded: number): number
}

/** Volume keys and roots, from the session's volume registry. */
export interface SchedulerVolumes
{
  root(path: string): Promise<string>
  key(path: string): Promise<string>
}

/** What a done job's result is built from. */
export interface ResultInput
{
  job: Readonly<Job>
  artifact: OutputArtifact
  placed: Extract<FinalizeResult, { status: 'done' }>
  warnings: JobWarning[]
  notes: string[]
  elapsedMs: number
}

/** A dispatch re-plan after a source change: the new plan, or null when it is blocked. */
export type Replan = (job: Readonly<Job>) => Promise<JobPlan | null>

/** What the scheduler is built from. */
export interface SchedulerDeps
{
  core: EngineCore
  timers: Timers
  ids: { token(): string }
  platform: Platform
  runners: RunnerSet
  planner: Pick<PlannerIO, 'stat' | 'statfs' | 'reachable'>
  volumes: SchedulerVolumes
  /** The key of the volume that holds userData, which keeps a larger margin. */
  userDataVolume: string
  workdirs: SchedulerWorkDirs
  budget: GpuBudget
  albums: SchedulerAlbums
  analysis: SchedulerAnalysis
  finalizer: Finalizer
  ffmpeg: FfmpegTools
  probe: Pick<ProbeQueue, 'probe'>
  cache: MeasurementCache
  /** Logical cores, for the automatic worker count. */
  cores: number
  setPriority(pid: number, priority: 'below-normal' | 'normal'): void
  replan: Replan
  result(input: ResultInput): NonNullable<Job['result']>
  notify?(notification: HostNotification): void
  log: JobLogger
}

/** The dispatch loop and the executions it runs. */
export interface Scheduler
{
  /** Requests a dispatch turn; triggers in one turn coalesce into one microtask. */
  trigger(reason: DispatchTrigger): void
  /** The jobs whose dispatch checks are running under a claim. */
  checking(): JobId[]
  /** The jobs with a running execution. */
  running(): JobId[]
  /** The volume key a claimed or active job writes to. */
  volumeOf(jobId: JobId): string | null
  /** Media seconds a running execution has processed across its stages; null when the job has none. */
  mediaSecDone(jobId: JobId): number | null
  /** Handles an album task's end; the album tasks' `onSettled`. */
  albumSettled(outcome: AlbumOutcome): void
  /** Handles an analysis task's end; the analysis tasks' `onSettled`. */
  analysisSettled(outcome: AnalysisOutcome): void
  /** Quit now: dispatch stops for good, claims are voided, and every child is stopped. */
  quitNow(): void
  dispose(): void
}

interface Claim
{
  inputsRev: number
  token: string | null
  workDir: string | null
  volume: string | null
}

interface Execution
{
  jobId: JobId
  controller: AbortController
  workDir: string
  execution: number
  token: string
  lease: GpuJobLease | null
  startedAt: number
  done: boolean
  stuck: unknown
  /** The attempt's percent across its planned stages, which never drops while the execution runs. */
  progress: JobProgressTracker
  /** The source's media span, which a correction's stages process again. */
  durationSec: number | null
}

type Decision =
  | { kind: 'start'; workDir: string; execution: number; token: string }
  | { kind: 'void' }
  | { kind: 'release' }
  | { kind: 'output-exists' }
  | { kind: 'source-missing' }
  | { kind: 'demote'; plan: JobPlan | null }
  | { kind: 'wait'; waiting: 'volume-offline' | 'disk-space'; volume: string; label: string }
  | { kind: 'pause'; reason: PauseReason; alert: Omit<RunAlert, 'at'>; notification: Omit<HostNotification, 'focus'> | null }

const SOURCE_CHANGED: JobWarning =
{
  code: 'source-changed',
  short: 'Source changed',
  message: 'The source changed after review; the job ran on the new file with the same plan.'
}

const KEPT_WARNINGS: Readonly<Record<'original-kept' | 'previous-kept', JobWarning>> =
{
  'original-kept': { code: 'original-kept', short: 'Original kept', message: 'The original could not go to the Recycle Bin, so it was kept beside the output.' },
  'previous-kept': { code: 'previous-kept', short: 'Previous kept', message: 'The previous output could not go to the Recycle Bin, so it was kept beside the new one.' }
}

const ERROR_SHORT: Partial<Record<JobErrorCode, string>> =
{
  'source-missing': 'Source missing',
  'album-measure-failed': 'Album measure failed',
  'disk-full': 'Disk full',
  'gpu-session-limit': 'GPU sessions full',
  'gpu-init-failed': 'GPU failed to start',
  'internal': 'Internal error'
}

const ERROR_HINTS: Partial<Record<JobErrorCode, string>> =
{
  'gpu-session-limit': 'Lower GPU encodes in the run settings, or set GPU to off.',
  'gpu-init-failed': 'Set GPU to auto to fall back to the CPU, or set GPU to off.',
  'disk-full': 'Free space on the destination volume, then retry.'
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function localDate(at: number): string
{
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A job error the engine raises itself, without a process behind it. */
export function engineError(code: JobErrorCode, message: string, stage: StageId, attempt: number, at: number, base: Partial<JobError> = {}): JobError
{
  return {
    code,
    short: ERROR_SHORT[code] ?? code,
    cause: null,
    message,
    stage,
    attempt,
    encodePass: null,
    exitCode: null,
    exitName: null,
    signal: null,
    stderrTail: '',
    command: null,
    fsError: null,
    hint: ERROR_HINTS[code] ?? null,
    ...base,
    at
  }
}

/** Whether a failure is the destination volume running out of space. */
export function isDiskFull(error: Pick<JobError, 'code' | 'stderrTail' | 'fsError'>): boolean
{
  return error.code === 'disk-full' || error.fsError?.code === 'ENOSPC' || /No space left on device|ENOSPC/.test(error.stderrTail)
}

/** The plan an execution runs: the CPU fallback replaces the GPU encoder once the budget moved the job to the CPU. */
export function executionPlan(plan: JobPlan, onCpu: boolean): JobPlan
{
  const fallback = plan.video?.cpuFallback ?? null
  if (!onCpu || plan.video === null || fallback === null)
  {
    return plan
  }
  return { ...plan, class: 'video-cpu', video: { ...fallback, cpuFallback: null } }
}

/** Builds the scheduler over an engine core. */
export function createScheduler(deps: SchedulerDeps): Scheduler
{
  const { core, timers, platform, budget, albums, analysis, log } = deps
  const path = pathApi(platform)
  const claims = new Map<JobId, Claim>()
  const executions = new Map<JobId, Execution>()
  const volumes = new Map<JobId, string>()
  const diskHits = new Map<JobId, number>()
  const changedSources = new Set<JobId>()
  const ranOnCpu = new Set<JobId>()
  const waits = new Map<JobId, string>()
  const speeds = createSpeedBook()
  const unsubscribe: Array<() => void> = []
  let scheduled = false
  let quitting = false
  let disposed = false
  let recheckTimer: unknown = null
  let lastRun: { runId: RunId | null; status: string; mode: PauseMode | null }
  let lastWorkers = ''

  function trigger(): void
  {
    if (scheduled || disposed)
    {
      return
    }
    scheduled = true
    queueMicrotask(dispatchTurn)
  }

  function classOf(job: QueuedJob): JobClass
  {
    return budget.onCpu(job.id) && job.plan?.class === 'video-gpu' ? 'video-cpu' : (job.plan as JobPlan).class
  }

  function slots(): Slot[]
  {
    const taken: Slot[] = []
    for (const job of core.queue.jobs())
    {
      if (ACTIVE_STATES.includes(job.state) && job.plan !== null)
      {
        taken.push({ kind: 'job', class: classOf(job) })
      }
      else if (job.state === 'queued' && core.isClaimed(job.id) && job.plan !== null)
      {
        taken.push({ kind: 'claim', class: classOf(job) })
      }
    }
    return [...taken, ...albums.slots(), ...analysis.slots()]
  }

  function publishWorkers(): void
  {
    const g = core.globals()
    const occupancy = countOccupancy(slots())
    const workers: WorkersState = { setting: g.settings.workers, limits: workerLimits(g.settings.workers, deps.cores, budget.limit), active: workersActive(occupancy) }
    const key = JSON.stringify(workers)
    if (key !== lastWorkers)
    {
      lastWorkers = key
      core.setWorkers(workers)
    }
  }

  function dispatchTurn(): void
  {
    scheduled = false
    if (quitting || disposed)
    {
      return
    }
    const run = core.run()
    const g = core.globals()
    const claimed = new Set(core.claims())
    const queued: QueuedJob[] = []
    if (run.status === 'running')
    {
      for (const job of core.queue.jobs())
      {
        if (job.state === 'queued')
        {
          queued.push(job)
        }
      }
    }
    const candidates = dispatchCandidates(queued, {
      policyRev: g.policy.rev,
      capabilitiesRev: g.capabilities.rev,
      claimed,
      classOf,
      waitingOf: (job) => albums.waitingOf(job.id)
    })
    const analysisOpen = run.status === 'running' || run.status === 'idle'
    const limits = workerLimits(g.settings.workers, deps.cores, budget.limit)
    const choice = planDispatch(candidates, analysisOpen ? analysis.pending() : [], countOccupancy(slots()), limits)
    for (const id of choice.jobs)
    {
      take(id)
    }
    for (const id of choice.analysis)
    {
      if (analysis.start(id) && core.queue.get(id) !== undefined)
      {
        core.update(id, { analysis: 'running' })
      }
    }
    publishWorkers()
  }

  function take(id: JobId): void
  {
    const job = core.queue.get(id)
    if (job === undefined || job.plan === null || !core.claim(id))
    {
      return
    }
    analysis.claimed(id)
    if (classOf(job) === 'video-gpu' && job.plan.video !== null)
    {
      budget.lease(id, job.plan.video.encoder)
    }
    const album = albums.claim(id)
    if (album.kind === 'started' || album.kind === 'waiting')
    {
      freeSlot(id)
      const members = album.kind === 'started' ? album.waiting : [id]
      for (const member of members)
      {
        if (core.queue.get(member)?.state === 'queued')
        {
          core.update(member, { waiting: 'album' })
        }
      }
      trigger()
      return
    }
    if (album.kind === 'failed')
    {
      budget.release(id)
      core.transition(id, ['queued'], 'fail', { change: { error: engineError('album-measure-failed', 'Album measure failed: the group could not be measured.', 'measure-album', job.attempt, timers.now()) } })
      return
    }
    const claim: Claim = { inputsRev: job.inputsRev, token: null, workDir: null, volume: null }
    claims.set(id, claim)
    void checkClaim(id, claim).then(
      (decision) => commit(id, claim, decision, album.kind === 'ready' ? album : null),
      (err: unknown) =>
      {
        log.error(`Dispatch checks for ${id} failed: ${errorText(err)}`)
        commit(id, claim, { kind: 'release' }, null)
      }
    )
  }

  function claimValid(id: JobId, claim: Claim): boolean
  {
    const job = core.queue.get(id)
    if (quitting || disposed || job === undefined || job.state !== 'queued' || !core.isClaimed(id) || claims.get(id) !== claim)
    {
      return false
    }
    const g = core.globals()
    const basis = job.plan?.basis
    return core.run().status === 'running' &&
      job.inputsRev === claim.inputsRev &&
      basis !== undefined &&
      basis.inputsRev === job.inputsRev &&
      basis.policyRev === g.policy.rev &&
      basis.capabilitiesRev === g.capabilities.rev
  }

  function freeSlot(id: JobId): void
  {
    budget.release(id)
    if (!executions.has(id))
    {
      volumes.delete(id)
    }
    if (core.releaseClaim(id))
    {
      trigger()
    }
  }

  function commitments(): VolumeCommitment[]
  {
    const out: VolumeCommitment[] = []
    for (const [jobId, volume] of volumes)
    {
      const job = core.queue.get(jobId)
      if (job?.plan)
      {
        out.push({ jobId, volume, reserveBytes: job.plan.estimate.reserveBytes, bytesWritten: job.progress?.bytesWritten ?? null })
      }
    }
    return out
  }

  async function checkSource(id: JobId, claim: Claim): Promise<Decision | null>
  {
    const job = core.queue.get(id) as Readonly<Job>
    const plan = job.plan as JobPlan
    const stat = await deps.planner.stat(job.source.path)
    if (!claimValid(id, claim))
    {
      return { kind: 'void' }
    }
    if (stat === null)
    {
      const root = await deps.volumes.root(job.source.path)
      const reachable = await deps.planner.reachable(root, DESTINATION_TIMEOUT_MS) &&
        await deps.planner.reachable(path.dirname(job.source.path), DESTINATION_TIMEOUT_MS)
      if (!claimValid(id, claim))
      {
        return { kind: 'void' }
      }
      if (reachable)
      {
        return { kind: 'source-missing' }
      }
      return { kind: 'wait', waiting: 'volume-offline', volume: await deps.volumes.key(job.source.path), label: volumeLabel(root, platform) }
    }
    if (stat.size === plan.source.size && stat.mtimeMs === plan.source.mtimeMs)
    {
      return null
    }
    const changed = core.update(id, { source: { ...job.source, size: stat.size, mtimeMs: stat.mtimeMs } }, { inputs: true })
    if (changed === null)
    {
      return { kind: 'void' }
    }
    claim.inputsRev = changed.inputsRev
    deps.log.info(`The source of ${id} changed after review; planning it again`)
    const next = await deps.replan(changed)
    if (!claimValidExceptBasis(id, claim))
    {
      return { kind: 'void' }
    }
    if (next === null || next.fingerprint !== plan.fingerprint)
    {
      return { kind: 'demote', plan: next }
    }
    core.update(id, { plan: next })
    changedSources.add(id)
    return claimValid(id, claim) ? null : { kind: 'void' }
  }

  function claimValidExceptBasis(id: JobId, claim: Claim): boolean
  {
    const job = core.queue.get(id)
    return !quitting && !disposed && job !== undefined && job.state === 'queued' && core.isClaimed(id) &&
      claims.get(id) === claim && core.run().status === 'running' && job.inputsRev === claim.inputsRev
  }

  async function checkDestination(id: JobId, claim: Claim): Promise<Decision | null>
  {
    const job = core.queue.get(id) as Readonly<Job>
    const finalPath = (job.plan as JobPlan).output.finalPath
    const folder = path.dirname(finalPath)
    if (folder === path.dirname(job.source.path))
    {
      return null
    }
    const root = await deps.volumes.root(finalPath)
    const reachable = await deps.planner.reachable(root, DESTINATION_TIMEOUT_MS) && await deps.planner.reachable(folder, DESTINATION_TIMEOUT_MS)
    if (!claimValid(id, claim))
    {
      return { kind: 'void' }
    }
    if (reachable)
    {
      return null
    }
    return {
      kind: 'pause',
      reason: 'destination-unavailable',
      alert: {
        id: `destination-unavailable:${folder}`,
        kind: 'destination-unavailable',
        severity: 'warning',
        message: `The run paused: ${folder} does not answer. Reconnect the drive or share, then resume.`,
        volume: volumeLabel(root, platform),
        path: folder,
        jobIds: [id],
        counts: null,
        dismissible: false
      },
      notification: { title: 'molexMedia paused the run', body: `${folder} does not answer. Reconnect it, then resume.` }
    }
  }

  async function checkSpace(id: JobId, claim: Claim): Promise<Decision | null>
  {
    const job = core.queue.get(id) as Readonly<Job>
    const plan = job.plan as JobPlan
    const finalPath = plan.output.finalPath
    if (core.globals().policy.conflict === 'skip')
    {
      const existing = await deps.planner.stat(finalPath)
      if (!claimValid(id, claim))
      {
        return { kind: 'void' }
      }
      if (existing !== null)
      {
        return { kind: 'output-exists' }
      }
    }
    const volume = await deps.volumes.key(finalPath)
    claim.volume = volume
    const space = await deps.planner.statfs(finalPath)
    if (!claimValid(id, claim))
    {
      return { kind: 'void' }
    }
    const fits = fitsOnVolume({
      freeBytes: space.freeBytes,
      committedBytes: committedBytes(commitments(), volume, id),
      reserveBytes: plan.estimate.reserveBytes,
      marginBytes: volumeMargin(volume, deps.userDataVolume)
    })
    if (fits)
    {
      volumes.set(id, volume)
      return null
    }
    return { kind: 'wait', waiting: 'disk-space', volume, label: volumeLabel(await deps.volumes.root(finalPath), platform) }
  }

  async function checkClaim(id: JobId, claim: Claim): Promise<Decision>
  {
    for (const check of [checkSource, checkDestination, checkSpace])
    {
      const decision = await check(id, claim)
      if (decision !== null)
      {
        return decision
      }
    }
    if (deps.ffmpeg.current() === null)
    {
      return {
        kind: 'pause',
        reason: 'ffmpeg-unavailable',
        alert: { id: 'ffmpeg-unavailable', kind: 'ffmpeg-unavailable', severity: 'error', message: 'The run paused: FFmpeg is not available.', volume: null, path: null, jobIds: [], counts: null, dismissible: false },
        notification: null
      }
    }
    const job = core.queue.get(id) as Readonly<Job>
    const execution = deps.workdirs.nextExecution(id, job.execution)
    const token = deps.ids.token()
    claim.token = token
    const created = await deps.workdirs.create({ jobId: id, attempt: job.attempt, execution, source: job.source.path, finalPath: (job.plan as JobPlan).output.finalPath, token })
    if (created.status !== 'created')
    {
      log.error(`No work folder for ${id}: ${errorText(created.error)}`)
      return {
        kind: 'pause',
        reason: 'storage',
        alert: { id: 'storage-error', kind: 'storage-error', severity: 'error', message: `The run paused: molexMedia could not create a work folder (${errorText(created.error)}).`, volume: null, path: created.path, jobIds: [id], counts: null, dismissible: false },
        notification: null
      }
    }
    claim.workDir = created.path
    return { kind: 'start', workDir: created.path, execution, token }
  }

  function commit(id: JobId, claim: Claim, decision: Decision, album: Extract<AlbumClaim, { kind: 'ready' }> | null): void
  {
    const valid = decision.kind === 'demote' ? claimValidExceptBasis(id, claim) : decision.kind !== 'void' && claimValid(id, claim)
    claims.delete(id)
    if (!valid)
    {
      freeSlot(id)
      sweepFor(id)
      return
    }
    const job = core.queue.get(id) as Readonly<Job>
    switch (decision.kind)
    {
      case 'start':
        start(id, decision, album)
        return
      case 'output-exists':
        budget.release(id)
        volumes.delete(id)
        core.transition(id, ['queued'], 'output-exists', { reason: 'output-exists' })
        return
      case 'source-missing':
        budget.release(id)
        volumes.delete(id)
        core.transition(id, ['queued'], 'fail', { change: { error: engineError('source-missing', `The source is missing: ${job.source.path}`, 'probe', job.attempt, timers.now()) } })
        return
      case 'demote':
        budget.release(id)
        volumes.delete(id)
        core.transition(id, ['queued'], 'demote', { reason: 'source-changed', change: decision.plan === null ? {} : { plan: decision.plan } })
        return
      case 'wait':
        hold(id, decision)
        return
      case 'pause':
        freeSlot(id)
        autoPause(decision.reason, decision.alert, decision.notification, id)
        return
      default:
        freeSlot(id)
    }
  }

  function hold(id: JobId, decision: Extract<Decision, { kind: 'wait' }>): void
  {
    core.update(id, { waiting: decision.waiting, waitingOn: decision.label })
    waits.set(id, decision.volume)
    freeSlot(id)
    scheduleRecheck()
    if (decision.waiting === 'volume-offline')
    {
      core.raiseAlert({
        id: `volume-offline:${decision.volume}`,
        kind: 'volume-offline',
        severity: 'warning',
        message: `${decision.label} is offline; its jobs wait until it answers again.`,
        at: timers.now(),
        volume: decision.label,
        path: null,
        jobIds: [...waits].filter(([, volume]) => volume === decision.volume).map(([jobId]) => jobId),
        counts: null,
        dismissible: true
      })
      return
    }
    if (!volumeBusy(decision.volume))
    {
      const job = core.queue.get(id) as Readonly<Job>
      autoPause('disk-space', {
        id: `disk-space:${decision.volume}`,
        kind: 'disk-space',
        severity: 'error',
        message: `The run paused: ${decision.label} is too full for the next job, which needs about ${Math.ceil((job.plan?.estimate.reserveBytes ?? 0) / 1e6)} MB.`,
        volume: decision.label,
        path: null,
        jobIds: [id],
        counts: null,
        dismissible: false
      }, { title: 'molexMedia paused the run', body: `${decision.label} is full. Free some space, then resume.` }, id)
    }
  }

  function volumeBusy(volume: string): boolean
  {
    for (const [jobId, key] of volumes)
    {
      if (key === volume && (executions.has(jobId) || claims.has(jobId)))
      {
        return true
      }
    }
    return false
  }

  function autoPause(reason: PauseReason, alert: Omit<RunAlert, 'at'>, notification: Omit<HostNotification, 'focus'> | null, jobId: JobId | null): void
  {
    if (core.run().status === 'running')
    {
      core.pauseRun('finish-running', reason)
    }
    core.raiseAlert({ ...alert, at: timers.now() })
    if (notification !== null)
    {
      deps.notify?.({ ...notification, focus: { jobId, runId: core.run().runId } })
    }
  }

  function scheduleRecheck(): void
  {
    if (recheckTimer !== null || disposed)
    {
      return
    }
    recheckTimer = timers.setTimeout(() =>
    {
      recheckTimer = null
      recheck(null)
    }, RECHECK_MS)
  }

  /** Releases waiting jobs so dispatch checks them again: every one, or those on one volume. */
  function recheck(volume: string | null): void
  {
    let released = false
    for (const [jobId, key] of [...waits])
    {
      if (volume !== null && key !== volume)
      {
        continue
      }
      waits.delete(jobId)
      const job = core.queue.get(jobId)
      if (job !== undefined && (job.waiting === 'disk-space' || job.waiting === 'volume-offline'))
      {
        core.update(jobId, { waiting: null, waitingOn: null })
        released = true
      }
    }
    if (released)
    {
      trigger()
    }
    if (waits.size > 0)
    {
      scheduleRecheck()
    }
  }

  function protect(entry: WorkDirEntry): boolean
  {
    for (const execution of executions.values())
    {
      if (execution.token === entry.token && !execution.done)
      {
        return true
      }
    }
    for (const claim of claims.values())
    {
      if (claim.token === entry.token)
      {
        return true
      }
    }
    const job = core.queue.get(entry.jobId)
    return job !== undefined && (job.state === 'held' || job.state === 'finalizing') && job.workDir === entry.path
  }

  function sweepFor(id: JobId): void
  {
    void deps.workdirs.sweep(protect, (entry) => entry.jobId === id).then(
      (report) =>
      {
        const stuck = report.results.filter((result) => result.outcome === 'pending')
        if (stuck.length > 0)
        {
          core.raiseAlert({
            id: `cleanup-pending:${id}`,
            kind: 'cleanup-pending',
            severity: 'info',
            message: `molexMedia could not delete a work folder yet and will try again: ${stuck[0].path}`,
            at: timers.now(),
            volume: null,
            path: stuck[0].path,
            jobIds: [id],
            counts: null,
            dismissible: true
          })
        }
      },
      (err: unknown) => log.warn(`Work folder cleanup for ${id} failed: ${errorText(err)}`)
    )
  }

  function stageOf(update: { id: StageId; pass: number; passes: number; label: string }): JobStage
  {
    return { id: update.id, pass: update.pass, passes: update.passes, label: update.label, startedAt: timers.now() }
  }

  function start(id: JobId, decision: Extract<Decision, { kind: 'start' }>, album: Extract<AlbumClaim, { kind: 'ready' }> | null): void
  {
    const at = timers.now()
    const policy: FrozenPolicy = { ...core.globals().policy, frozenAt: at, date: localDate(at) }
    const result = core.transition(id, ['queued'], 'dispatch', {
      stage: stageOf({ id: 'probe', pass: 1, passes: 1, label: 'Probing' }),
      change: { policy, execution: decision.execution, workDir: decision.workDir, waiting: null, waitingOn: null }
    })
    if (!result.applied)
    {
      freeSlot(id)
      sweepFor(id)
      return
    }
    const onCpu = budget.onCpu(id)
    const durationSec = result.job.media?.durationSec ?? null
    const plan = result.job.plan === null ? null : executionPlan(result.job.plan, onCpu)
    const execution: Execution = {
      jobId: id,
      controller: new AbortController(),
      workDir: decision.workDir,
      execution: decision.execution,
      token: decision.token,
      lease: onCpu ? null : budget.leaseOf(id),
      startedAt: at,
      done: false,
      stuck: null,
      progress: createJobProgress({ stages: plan === null ? [] : progressStages(plan, durationSec), jobClass: plan?.class ?? 'audio', speeds, startedAt: at }),
      durationSec
    }
    executions.set(id, execution)
    if (onCpu)
    {
      ranOnCpu.add(id)
    }
    launch(result.job, execution, album?.handle ?? null)
  }

  function launch(job: Readonly<Job>, execution: Execution, album: RunContext['album']): void
  {
    const id = job.id
    const tools = deps.ffmpeg.current()
    if (tools === null)
    {
      settle(execution, { kind: 'failed', error: engineError('ffmpeg-unavailable', 'FFmpeg is not available.', 'probe', job.attempt, timers.now()) })
      return
    }
    const signal = execution.controller.signal
    const jobLog = log.child({ jobId: id, runId: job.runId ?? undefined, attempt: job.attempt })
    const priority = core.globals().settings.priority
    const hooked = withSpawnHook(tools.exec, (pid) => deps.setPriority(pid, priority), jobLog)
    const ctx: RunContext = {
      signal,
      exec: { run: (args, options) => hooked.run(args, { ...options, signal: options.signal ?? signal }) },
      workDir: execution.workDir,
      execution: execution.execution,
      caps: tools.caps,
      gpu: execution.lease,
      album,
      cache: deps.cache,
      probe: (target) => deps.probe.probe(target, { signal }),
      output: (ext, encodePass) => partOutputPath(execution.workDir, encodePass, ext, platform),
      outputFolder: (name) => path.join(execution.workDir, name),
      stage: (update) => reportStage(execution, update),
      progress: (p) => reportProgress(execution, p),
      measured: (m) =>
      {
        if (!execution.done)
        {
          core.measured(id, m)
        }
      },
      log: jobLog,
      now: () => timers.now()
    }
    const runnable: RunnableJob = {
      id,
      recipe: job.recipe,
      plan: executionPlan(job.plan as JobPlan, budget.onCpu(id)),
      policy: job.policy as FrozenPolicy,
      source: job.source,
      attempt: job.attempt
    }
    const runner = deps.runners[job.recipe.kind] as unknown as { run(job: RunnableJob, ctx: RunContext): Promise<RunOutcome> }
    let pending: Promise<RunOutcome>
    try
    {
      pending = Promise.resolve(runner.run(runnable, ctx))
    }
    catch (err)
    {
      pending = Promise.reject(err)
    }
    pending.then(
      (outcome) => settle(execution, outcome),
      (err: unknown) => settle(execution, { kind: 'failed', error: engineError('internal', `The runner failed: ${errorText(err)}`, core.queue.get(id)?.stage?.id ?? 'probe', job.attempt, timers.now()) })
    )
  }

  function reportStage(execution: Execution, update: { id: StageId; pass: number; passes: number; label: string }): void
  {
    const id = execution.jobId
    const job = core.queue.get(id)
    if (execution.done || job === undefined || job.abort !== null || execution.controller.signal.aborted)
    {
      return
    }
    const target = STAGE_STATES[update.id]
    if (update.id === 'encode')
    {
      execution.lease?.encoding()
    }
    if (target === job.state)
    {
      core.stage(id, stageOf(update), startProgress(execution, update))
      return
    }
    if (job.state === 'analyzing' && target === 'encoding')
    {
      core.transition(id, ['analyzing'], 'measured', { stage: stageOf(update), progress: startProgress(execution, update) })
    }
    else if (job.state === 'encoding' && target === 'verifying')
    {
      core.transition(id, ['encoding'], 'encoded', { stage: stageOf(update), progress: startProgress(execution, update) })
    }
    else if (job.state === 'verifying' && target === 'encoding')
    {
      if (core.run().pause?.mode === 'stop-running')
      {
        core.recordAbort(id, 'requeue', 'requeued-pause')
        return
      }
      execution.progress.extend(correctionStages(update.pass, update.passes, execution.durationSec), timers.now())
      core.transition(id, ['verifying'], 'correct', { stage: stageOf(update), progress: startProgress(execution, update) })
    }
    else
    {
      log.warn(`Ignored stage ${update.id} for ${id} in ${job.state}`)
    }
  }

  /** The progress a stage starts with: the attempt's percent so far and nothing of the new stage yet. */
  function startProgress(execution: Execution, update: { id: StageId; pass: number; passes: number }): JobProgress
  {
    const tracked = execution.progress.start(update.id, update.pass, timers.now())
    return {
      stage: update.id,
      pass: update.pass,
      passes: update.passes,
      percent: tracked.percent,
      stagePercent: null,
      speed: null,
      etaSec: null,
      outTimeSec: null,
      durationSec: tracked.durationSec,
      bytesWritten: null,
      elapsedMs: 0
    }
  }

  function reportProgress(execution: Execution, p: { outTimeSec: number | null; durationSec: number | null; speed: number | null; bytes: number | null }): void
  {
    const job = core.queue.get(execution.jobId)
    if (execution.done || job === undefined || job.stage === null)
    {
      return
    }
    const span = p.durationSec !== null && p.durationSec > 0 ? p.durationSec : null
    const stagePercent = span !== null && p.outTimeSec !== null ? Math.min(100, Math.max(0, (p.outTimeSec / span) * 100)) : null
    const speed = p.speed !== null && p.speed > 0 ? p.speed : null
    const etaSec = span !== null && p.outTimeSec !== null && speed !== null ? Math.max(0, (span - p.outTimeSec) / speed) : null
    const tracked = execution.progress.sample({ outTimeSec: p.outTimeSec, speed, bytesWritten: p.bytes, durationSec: p.durationSec }, timers.now())
    core.progress(execution.jobId, {
      stage: job.stage.id,
      pass: job.stage.pass,
      passes: job.stage.passes,
      percent: tracked.percent,
      stagePercent,
      speed,
      etaSec,
      outTimeSec: p.outTimeSec,
      durationSec: p.durationSec,
      bytesWritten: p.bytes,
      elapsedMs: Math.max(0, timers.now() - job.stage.startedAt)
    })
  }

  function onAbort(id: JobId): void
  {
    const execution = executions.get(id)
    if (execution === undefined || execution.done)
    {
      return
    }
    execution.controller.abort()
    if (execution.stuck === null)
    {
      const limit = STUCK_CHILD_MS + (platform === 'win32' ? 0 : POSIX_KILL_GRACE_MS)
      execution.stuck = timers.setTimeout(() =>
      {
        execution.stuck = null
        if (!execution.done)
        {
          log.warn(`The child of ${id} did not close ${limit / 1000} s after it was stopped; settling the job without it`)
          settle(execution, { kind: 'aborted' })
        }
      }, limit)
    }
  }

  function leave(execution: Execution): void
  {
    const id = execution.jobId
    execution.done = true
    if (execution.stuck !== null)
    {
      timers.clearTimeout(execution.stuck)
      execution.stuck = null
    }
    executions.delete(id)
    budget.release(id)
    const volume = volumes.get(id)
    volumes.delete(id)
    const job = core.queue.get(id)
    if (job === undefined || (job.state !== 'held' && job.state !== 'finalizing'))
    {
      sweepFor(id)
    }
    if (job === undefined || job.state === 'canceled' || job.state === 'skipped' || job.state === 'failed')
    {
      albums.memberLeft(id)
    }
    if (volume !== undefined)
    {
      recheck(volume)
    }
    trigger()
  }

  /** The synchronous commit point: a runner's result, checked against the abort intent in the turn it arrives. */
  function settle(execution: Execution, outcome: RunOutcome): void
  {
    if (execution.done)
    {
      return
    }
    const id = execution.jobId
    const job = core.queue.get(id)
    if (job === undefined || !RUNNING_STATES.includes(job.state))
    {
      leave(execution)
      return
    }
    if (job.abort !== null)
    {
      core.settleAbort(id)
      leave(execution)
      return
    }
    if (outcome.kind === 'aborted')
    {
      fail(execution, engineError('internal', 'The job stopped without being canceled.', job.stage?.id ?? 'probe', job.attempt, timers.now()))
      return
    }
    if (outcome.kind === 'failed')
    {
      failed(execution, job, outcome.error)
      return
    }
    verified(execution, job, outcome)
  }

  function fail(execution: Execution, error: JobError): void
  {
    const job = core.queue.get(execution.jobId) as Readonly<Job>
    core.transition(execution.jobId, ACTIVE_STATES, 'fail', { change: { error: { ...error, attempt: job.attempt } } })
    leave(execution)
  }

  function requeue(execution: Execution, reason: StateReason): void
  {
    core.transition(execution.jobId, RUNNING_STATES, 'requeue', { reason })
    leave(execution)
  }

  function failed(execution: Execution, job: Readonly<Job>, error: JobError): void
  {
    const id = execution.jobId
    if (execution.lease !== null)
    {
      const decision = budget.reportFailure(id, error.stderrTail, job.plan?.video?.cpuFallback != null)
      if (decision?.action === 'requeue-gpu')
      {
        core.raiseAlert({
          id: 'gpu-sessions',
          kind: 'gpu-sessions',
          severity: 'warning',
          message: `The GPU refused an encoder session; GPU encodes are limited to ${decision.limit} for now.`,
          at: timers.now(),
          volume: null,
          path: null,
          jobIds: [id],
          counts: null,
          dismissible: true
        })
        requeue(execution, 'requeued-gpu')
        return
      }
      if (decision?.action === 'requeue-cpu')
      {
        requeue(execution, 'requeued-cpu')
        return
      }
      if (decision?.action === 'fail')
      {
        const message = decision.code === 'gpu-session-limit'
          ? 'The GPU refused an encoder session again.'
          : 'GPU encoding failed to start.'
        fail(execution, engineError(decision.code, message, error.stage, job.attempt, timers.now(), { ...error, code: decision.code, short: ERROR_SHORT[decision.code] as string, message, hint: ERROR_HINTS[decision.code] ?? null }))
        return
      }
    }
    if (isDiskFull(error))
    {
      diskFull(execution, job, error)
      return
    }
    fail(execution, error)
  }

  function diskFull(execution: Execution, job: Readonly<Job>, error: JobError): void
  {
    const id = execution.jobId
    if (diskHits.get(id) === job.attempt)
    {
      fail(execution, { ...error, code: 'disk-full', short: ERROR_SHORT['disk-full'] as string, hint: ERROR_HINTS['disk-full'] ?? null })
      return
    }
    diskHits.set(id, job.attempt)
    const volume = volumes.get(id) ?? null
    core.batch(() =>
    {
      requeue(execution, 'requeued-disk')
      for (const other of [...executions.values()])
      {
        const state = core.queue.get(other.jobId)?.state
        if (volume !== null && volumes.get(other.jobId) === volume && (state === 'analyzing' || state === 'encoding'))
        {
          core.recordAbort(other.jobId, 'requeue', 'requeued-disk')
        }
      }
    })
    const label = job.waitingOn ?? (job.plan === null ? 'the destination' : path.dirname(job.plan.output.finalPath))
    autoPause('disk-space', {
      id: `disk-space:${volume ?? label}`,
      kind: 'disk-space',
      severity: 'error',
      message: `The run paused: the destination volume of ${label} ran out of space. Jobs writing there start again on resume.`,
      volume,
      path: null,
      jobIds: [id],
      counts: null,
      dismissible: false
    }, { title: 'molexMedia paused the run', body: 'A destination volume is full. Free some space, then resume.' }, id)
  }

  function warningsOf(id: JobId, job: Readonly<Job>, kept: ReadonlyArray<'original-kept' | 'previous-kept'>): JobWarning[]
  {
    const out: JobWarning[] = [...job.warnings]
    const add = (warning: JobWarning): void =>
    {
      if (!out.some((w) => w.code === warning.code))
      {
        out.push(warning)
      }
    }
    if (changedSources.has(id))
    {
      add(SOURCE_CHANGED)
    }
    if (ranOnCpu.has(id))
    {
      const encoder = job.plan?.video?.cpuFallback?.encoder ?? 'the CPU encoder'
      add({ code: 'ran-on-cpu', short: 'Ran on CPU', message: `GPU encoding failed to start; encoded with ${encoder}.` })
    }
    for (const code of kept)
    {
      add(KEPT_WARNINGS[code])
    }
    return out
  }

  function verified(execution: Execution, job: Readonly<Job>, outcome: Extract<RunOutcome, { kind: 'output' }>): void
  {
    const id = execution.jobId
    if (job.state === 'analyzing')
    {
      core.transition(id, ['analyzing'], 'measured', { stage: stageOf({ id: 'encode', pass: 1, passes: 1, label: 'Encoding' }) })
    }
    if (core.queue.get(id)?.state === 'encoding')
    {
      core.transition(id, ['encoding'], 'encoded', { stage: stageOf({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' }) })
    }
    if (outcome.measurement !== null && job.measurement === null)
    {
      core.measured(id, outcome.measurement)
    }
    core.verified(id, outcome.verification)
    const current = core.queue.get(id) as Readonly<Job>
    const plan = current.plan as JobPlan
    const verdict = outcome.verification.verdict
    const destructive = plan.output.resolution === 'overwrite' || plan.output.resolution === 'replace-original'
    if (verdict === 'failed')
    {
      fail(execution, engineError('output-unreadable', 'The output did not pass verification.', 'verify', current.attempt, timers.now()))
      return
    }
    if (verdict === 'outside-tolerance' && destructive)
    {
      const held = core.transition(id, ['verifying'], 'hold', {
        reason: 'outside-tolerance',
        change: {
          hold: { reason: 'outside-tolerance', message: 'The output is outside the tolerance and would replace an existing file.', outputPath: outcome.artifact.path, displaces: plan.output.displaces, actions: ['keep', 'discard', 'retry'], since: timers.now() }
        }
      })
      finishHeld(execution, held)
      return
    }
    const begun = core.transition(id, ['verifying'], 'verified', {
      stage: stageOf({ id: 'place', pass: 1, passes: 1, label: 'Placing' }),
      progress: startProgress(execution, { id: 'place', pass: 1, passes: 1 }),
      begin: { verdict, mode: plannedMode(plan.output.resolution) }
    })
    if (!begun.applied)
    {
      fail(execution, engineError('internal', 'The verified output could not move to placement.', 'verify', current.attempt, timers.now()))
      return
    }
    void place(execution, outcome, begun.durable)
  }

  function finishHeld(execution: Execution, result: ReturnType<EngineCore['transition']>): void
  {
    if (result.applied)
    {
      void result.durable.then((ok) =>
      {
        if (!ok)
        {
          log.warn(`The hold of ${execution.jobId} is not durable yet`)
        }
      })
    }
    leave(execution)
  }

  function holdPlacement(execution: Execution, reason: 'destination-appeared' | 'file-locked' | 'storage-unavailable', message: string, outputPath: string, displaces: string | null): void
  {
    const actions: Array<'keep' | 'keep-renamed' | 'discard' | 'retry'> = reason === 'destination-appeared' ? ['keep-renamed', 'discard', 'retry'] : ['keep', 'discard', 'retry']
    const held = core.transition(execution.jobId, ['finalizing'], 'hold', {
      reason,
      change: { hold: { reason, message, outputPath, displaces, actions, since: timers.now() } }
    })
    finishHeld(execution, held)
  }

  function reservedBy(id: JobId): (target: string) => boolean
  {
    return (target) =>
    {
      for (const job of core.queue.jobs())
      {
        if (job.id !== id && job.plan !== null && (job.state === 'queued' || job.state === 'held' || ACTIVE_STATES.includes(job.state)) &&
          (job.plan.output.finalPath === target || job.plan.output.renamedTo === target))
        {
          return true
        }
      }
      return false
    }
  }

  async function place(execution: Execution, outcome: Extract<RunOutcome, { kind: 'output' }>, durable: Promise<boolean>): Promise<void>
  {
    const id = execution.jobId
    const ok = await durable
    const job = core.queue.get(id)
    if (job === undefined || job.state !== 'finalizing')
    {
      leave(execution)
      return
    }
    const plan = job.plan as JobPlan
    if (!ok)
    {
      holdPlacement(execution, 'storage-unavailable', 'molexMedia could not save the placement step; the verified output waits.', outcome.artifact.path, plan.output.displaces)
      return
    }
    let placed: FinalizeResult
    try
    {
      placed = await deps.finalizer.place({
        jobId: id,
        execution: execution.execution,
        transition: 'T20',
        verdict: outcome.verification.verdict,
        output: plan.output,
        policy: job.policy as FrozenPolicy,
        source: job.source.path,
        outputPath: outcome.artifact.path,
        workDir: execution.workDir,
        isReserved: reservedBy(id),
        onWaitLock: () => core.stage(id, stageOf({ id: 'wait-lock', pass: 1, passes: 1, label: 'Waiting for a locked file' }))
      })
    }
    catch (err)
    {
      fail(execution, engineError('internal', `Placement failed: ${errorText(err)}`, 'place', job.attempt, timers.now()))
      return
    }
    if (placed.status === 'held')
    {
      holdPlacement(execution, placed.reason, placed.message, placed.outputPath, placed.displaces)
      return
    }
    const current = core.queue.get(id) as Readonly<Job>
    const warnings = warningsOf(id, current, placed.warnings)
    const result = deps.result({ job: current, artifact: outcome.artifact, placed, warnings, notes: outcome.notes, elapsedMs: timers.now() - execution.startedAt })
    core.transition(id, ['finalizing'], 'placed', { change: { result, warnings } })
    changedSources.delete(id)
    ranOnCpu.delete(id)
    diskHits.delete(id)
    leave(execution)
  }

  function albumSettled(outcome: AlbumOutcome): void
  {
    core.batch(() =>
    {
      if (outcome.kind === 'planned')
      {
        for (const id of outcome.ready)
        {
          if (core.queue.get(id)?.waiting === 'album')
          {
            core.update(id, { waiting: null, waitingOn: null })
          }
        }
      }
      else if (outcome.kind === 'failed')
      {
        for (const id of outcome.fail)
        {
          const job = core.queue.get(id)
          if (job?.state === 'queued' && !core.isClaimed(id))
          {
            core.transition(id, ['queued'], 'fail', {
              change: { waiting: null, waitingOn: null, error: engineError('album-measure-failed', `Album measure failed: ${errorText(outcome.error)}`, 'measure-album', job.attempt, timers.now()) }
            })
          }
        }
      }
      else if (outcome.kind === 'canceled')
      {
        for (const id of outcome.cancel)
        {
          if (core.queue.get(id)?.state === 'queued')
          {
            core.transition(id, ['queued'], 'cancel', { reason: 'run-canceled' })
          }
        }
      }
    })
    trigger()
  }

  function analysisSettled(outcome: AnalysisOutcome): void
  {
    const job = core.queue.get(outcome.jobId)
    if (job !== undefined)
    {
      if (outcome.kind === 'measured')
      {
        core.measured(outcome.jobId, outcome.measurement)
      }
      else if (outcome.kind === 'failed')
      {
        log.warn(`The analysis of ${outcome.jobId} failed: ${errorText(outcome.error)}`)
      }
      core.update(outcome.jobId, { analysis: outcome.kind === 'stopped' ? 'queued' : null })
    }
    trigger()
  }

  function quitNow(): void
  {
    quitting = true
    for (const id of [...claims.keys()])
    {
      claims.delete(id)
      freeSlot(id)
    }
    albums.pause('stop-running')
    analysis.quitNow()
    for (const execution of executions.values())
    {
      execution.controller.abort()
    }
  }

  function runChanged(run: ReturnType<EngineCore['run']>): void
  {
    const before = lastRun
    const mode = run.pause?.mode ?? null
    lastRun = { runId: run.runId, status: run.status, mode }
    if (run.status === 'running' && before.runId !== run.runId && run.runId !== null)
    {
      budget.runStarted()
    }
    if ((run.status === 'pausing' || run.status === 'paused') && mode !== null && mode !== before.mode)
    {
      albums.pause(mode)
      analysis.pause(mode)
    }
    if (run.status === 'canceling' && before.status !== 'canceling')
    {
      albums.cancelRun()
      for (const id of [...analysis.running(), ...analysis.pending()])
      {
        if (core.queue.get(id)?.runId === run.runId)
        {
          analysis.cancel(id)
        }
      }
    }
    if (run.status === 'running' && before.status !== 'running')
    {
      if (before.status === 'pausing' || before.status === 'paused')
      {
        analysis.resume()
      }
      recheck(null)
      trigger()
    }
    if (run.status === 'idle' && before.status !== 'idle')
    {
      trigger()
    }
  }

  unsubscribe.push(core.onAbort((id) => onAbort(id)))
  unsubscribe.push(core.onRunState((run) => runChanged(run)))
  const initial = core.run()
  lastRun = { runId: initial.runId, status: initial.status, mode: initial.pause?.mode ?? null }

  return {
    trigger,
    checking: () => [...claims.keys()],
    running: () => [...executions.keys()].filter((id) => !(executions.get(id) as Execution).done),
    volumeOf: (jobId) => volumes.get(jobId) ?? null,
    mediaSecDone(jobId: JobId): number | null
    {
      const execution = executions.get(jobId)
      return execution === undefined || execution.done ? null : execution.progress.mediaSecDone
    },
    albumSettled,
    analysisSettled,
    quitNow,
    dispose(): void
    {
      disposed = true
      for (const off of unsubscribe)
      {
        off()
      }
      if (recheckTimer !== null)
      {
        timers.clearTimeout(recheckTimer)
      }
    }
  }
}
