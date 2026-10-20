/**
 * Album tasks. One group task per album runs every member's analysis, one at a time, then the pure album plan, so each
 * member encodes with the gain the group shares. The task takes the slot of the first member selected for dispatch,
 * and members wait for the plan without holding slots. The audio functions arrive through injection.
 */

import type { AudioAnalysis } from '../../shared/audio/events'
import type { JobId } from '../../shared/jobs/ids'
import type { AlbumSummary, JobMeasurement, PauseMode } from '../../shared/jobs/types'
import type { AlbumPlan } from '../ffmpeg/audio/plan'
import type { AlbumHandle } from './deps'
import type { Slot } from './dispatch'

/** One member's analysis, as the album plan takes it. */
export interface AlbumMemberAnalysis
{
  jobId: JobId
  analysis: AudioAnalysis
}

/** How a group task ended. */
export type AlbumOutcome =
  /** The plan exists; the members in `ready` are dispatchable again. */
  | { kind: 'planned'; groupId: string; summary: AlbumSummary; ready: JobId[] }
  /** A member's analysis failed or was refused; every member in `fail` fails with `album-measure-failed`. */
  | { kind: 'failed'; groupId: string; code: 'album-measure-failed'; fail: JobId[]; error: unknown }
  /** No member remains queued. */
  | { kind: 'aborted'; groupId: string }
  /** Stopped by "Pause now" or quit now; the members stay queued and waiting, and resume runs the task again. */
  | { kind: 'stopped'; groupId: string; waiting: JobId[] }
  /** The run was canceled; the members in `cancel` are canceled. */
  | { kind: 'canceled'; groupId: string; cancel: JobId[] }

/** What a dispatch claim on a job means for its album group. */
export type AlbumClaim =
  /** Not an album member: the job starts as usual. */
  | { kind: 'none' }
  /** The claim's slot passed to the group task; every member in `waiting` waits for the album plan. */
  | { kind: 'started'; groupId: string; waiting: JobId[] }
  /** The group task is running: release the claim, the member waits. */
  | { kind: 'waiting'; groupId: string }
  /** The plan exists: the member starts with its handle. */
  | { kind: 'ready'; groupId: string; handle: AlbumHandle }
  /** The group failed its measure; the member cannot run. */
  | { kind: 'failed'; groupId: string }

/** Where a group stands. */
export type AlbumPhase = 'idle' | 'measuring' | 'planned' | 'failed'

/** What album tasks are built with. */
export interface AlbumTaskDeps
{
  /** Runs or reuses one member's analysis; rejects when it fails or is refused, and stops when the signal aborts. */
  analyze(jobId: JobId, signal: AbortSignal): Promise<AudioAnalysis>
  /** The pure album plan over every member's analysis, in member order. */
  plan(members: readonly AlbumMemberAnalysis[]): AlbumPlan
  /** Reports a group task's end, so dispatch runs again. */
  onSettled(outcome: AlbumOutcome): void
}

interface Group
{
  id: string
  members: JobId[]
  queued: Set<JobId>
  phase: AlbumPhase
  controller: AbortController | null
  analyses: Map<JobId, AudioAnalysis>
  plan: AlbumPlan | null
  summary: AlbumSummary | null
  waiters: Set<() => void>
}

/** A member's measurement from the album task: its own pass A, its plan from the album plan, and the group summary. */
export function albumMeasurement(
  jobId: JobId,
  analysis: AudioAnalysis,
  plan: AlbumPlan,
  summary: AlbumSummary
): JobMeasurement
{
  const own = plan.plans.find((entry) => entry.jobId === jobId)?.plan ?? null
  return {
    pass: 'source',
    measuredAt: analysis.measuredAt,
    streams: analysis.source.map((measurement) => ({
      measurement,
      plan: own !== null && own.audioIndex === measurement.audioIndex ? own : null
    })),
    album: summary,
    messages: []
  }
}

/** The summary the plan, the report, and every member's measurement name. */
export function albumSummary(groupId: string, members: number, plan: AlbumPlan): AlbumSummary
{
  return {
    groupId,
    members,
    anchorJobId: plan.anchorJobId as JobId,
    anchorLufs: plan.anchorLufs,
    gainDb: plan.gainDb,
    reason: plan.reason
  }
}

/** Every album group of the current run and its group task. */
export class AlbumTasks
{
  private readonly deps: AlbumTaskDeps
  private readonly groups = new Map<string, Group>()
  private readonly memberOf = new Map<JobId, string>()

  constructor(deps: AlbumTaskDeps)
  {
    this.deps = deps
  }

  /**
   * Records a group as one Start started it, members in queue order; recovery registers restored groups again. A
   * group registered again is replaced, and a task it was running is discarded.
   */
  register(groupId: string, members: readonly JobId[]): void
  {
    this.drop(groupId)
    const unique = [...new Set(members)]
    if (unique.length === 0) return
    for (const jobId of unique)
    {
      const previous = this.memberOf.get(jobId)
      if (previous !== undefined) this.groups.get(previous)?.queued.delete(jobId)
      this.memberOf.set(jobId, groupId)
    }
    this.groups.set(groupId, {
      id: groupId,
      members: unique,
      queued: new Set(unique),
      phase: 'idle',
      controller: null,
      analyses: new Map(),
      plan: null,
      summary: null,
      waiters: new Set()
    })
  }

  /** The job's group, or null. */
  groupOf(jobId: JobId): string | null
  {
    return this.memberOf.get(jobId) ?? null
  }

  /** The group's phase, or null for an unknown group. */
  phase(groupId: string): AlbumPhase | null
  {
    return this.groups.get(groupId)?.phase ?? null
  }

  /** The group's summary once its plan exists. */
  summary(groupId: string): AlbumSummary | null
  {
    return this.groups.get(groupId)?.summary ?? null
  }

  /**
   * The hold dispatch applies to a member: 'album' while its group task runs, null otherwise, so a stopped or
   * restored group's members can start the task again; undefined for a job outside every group.
   */
  waitingOf(jobId: JobId): 'album' | null | undefined
  {
    const group = this.groupFor(jobId)
    if (group === null) return undefined
    return group.phase === 'measuring' ? 'album' : null
  }

  /** Answers a dispatch claim on a member; the first claim of an idle group starts its task in that claim's slot. */
  claim(jobId: JobId): AlbumClaim
  {
    const group = this.groupFor(jobId)
    if (group === null) return { kind: 'none' }
    if (group.phase === 'measuring') return { kind: 'waiting', groupId: group.id }
    if (group.phase === 'failed') return { kind: 'failed', groupId: group.id }
    if (group.phase === 'planned') return { kind: 'ready', groupId: group.id, handle: this.handleFor(group, jobId) }
    const controller = new AbortController()
    group.phase = 'measuring'
    group.controller = controller
    group.analyses.clear()
    void Promise.resolve().then(() => this.run(group, controller))
    return { kind: 'started', groupId: group.id, waiting: [...group.queued] }
  }

  /** The member's handle, or null for a job outside every group. */
  handle(jobId: JobId): AlbumHandle | null
  {
    const group = this.groupFor(jobId)
    return group === null ? null : this.handleFor(group, jobId)
  }

  /** A member was canceled, skipped, or removed: the task continues while a member is still queued. */
  memberLeft(jobId: JobId): void
  {
    const group = this.groupFor(jobId)
    if (group === null || !group.queued.delete(jobId)) return
    if (group.queued.size > 0 || group.phase === 'planned' || group.phase === 'failed') return
    const measuring = group.phase === 'measuring'
    this.drop(group.id)
    if (measuring) this.deps.onSettled({ kind: 'aborted', groupId: group.id })
  }

  /** "Pause" lets running tasks finish; "Pause now" stops them. */
  pause(mode: PauseMode): void
  {
    if (mode === 'stop-running') this.stopAll()
  }

  /** Stops and discards every running task ("Pause now", quit now); the members stay queued and waiting. */
  stopAll(): void
  {
    for (const group of [...this.groups.values()])
    {
      if (group.phase !== 'measuring') continue
      this.halt(group)
      group.phase = 'idle'
      this.deps.onSettled({ kind: 'stopped', groupId: group.id, waiting: [...group.queued] })
    }
  }

  /** The run was canceled: running tasks stop, their queued members are canceled, and every group is dropped. */
  cancelRun(): void
  {
    for (const group of [...this.groups.values()])
    {
      const measuring = group.phase === 'measuring'
      const cancel = [...group.queued]
      this.drop(group.id)
      if (measuring) this.deps.onSettled({ kind: 'canceled', groupId: group.id, cancel })
    }
  }

  /** Drops every group without reporting; tasks are not persisted, so recovery starts empty. */
  clear(): void
  {
    for (const groupId of [...this.groups.keys()]) this.drop(groupId)
  }

  /** One audio slot per running group task. */
  slots(): Slot[]
  {
    const slots: Slot[] = []
    for (const group of this.groups.values()) if (group.phase === 'measuring') slots.push({ kind: 'album', class: 'audio' })
    return slots
  }

  private groupFor(jobId: JobId): Group | null
  {
    const groupId = this.memberOf.get(jobId)
    return groupId === undefined ? null : this.groups.get(groupId) ?? null
  }

  private drop(groupId: string): void
  {
    const group = this.groups.get(groupId)
    if (group === undefined) return
    this.halt(group)
    this.groups.delete(groupId)
    for (const jobId of group.members) if (this.memberOf.get(jobId) === groupId) this.memberOf.delete(jobId)
    this.wake(group)
  }

  private halt(group: Group): void
  {
    group.controller?.abort()
    group.controller = null
    group.analyses.clear()
  }

  private wake(group: Group): void
  {
    for (const waiter of [...group.waiters]) waiter()
  }

  private async run(group: Group, controller: AbortController): Promise<void>
  {
    const live = (): boolean => group.controller === controller
    try
    {
      for (const jobId of group.members)
      {
        if (!live()) return
        const analysis = await this.deps.analyze(jobId, controller.signal)
        if (!live()) return
        group.analyses.set(jobId, analysis)
      }
      const plan = this.deps.plan(group.members.map((jobId) => ({ jobId, analysis: group.analyses.get(jobId) as AudioAnalysis })))
      const summary = albumSummary(group.id, group.members.length, plan)
      group.plan = plan
      group.summary = summary
      group.phase = 'planned'
      group.controller = null
      this.wake(group)
      this.deps.onSettled({ kind: 'planned', groupId: group.id, summary, ready: [...group.queued] })
    }
    catch (error)
    {
      if (!live()) return
      group.phase = 'failed'
      group.controller = null
      this.wake(group)
      this.deps.onSettled({ kind: 'failed', groupId: group.id, code: 'album-measure-failed', fail: [...group.queued], error })
    }
  }

  private handleFor(group: Group, jobId: JobId): AlbumHandle
  {
    return {
      groupId: group.id,
      members: group.members.length,
      measurement: (signal) => this.measurementOf(group, jobId, signal)
    }
  }

  private measurementOf(group: Group, jobId: JobId, signal: AbortSignal): Promise<JobMeasurement | null>
  {
    const ready = (): JobMeasurement | null =>
    {
      const analysis = group.analyses.get(jobId)
      if (signal.aborted || group.phase !== 'planned' || analysis === undefined) return null
      return albumMeasurement(jobId, analysis, group.plan as AlbumPlan, group.summary as AlbumSummary)
    }
    if (group.phase !== 'measuring' || signal.aborted) return Promise.resolve(ready())
    return new Promise((resolve) =>
    {
      const settle = (): void =>
      {
        group.waiters.delete(settle)
        signal.removeEventListener('abort', settle)
        resolve(ready())
      }
      group.waiters.add(settle)
      signal.addEventListener('abort', settle, { once: true })
    })
  }
}
