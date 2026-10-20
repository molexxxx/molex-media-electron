/**
 * The run's progress feed: one `createRunProgress` per run, updated once per turn after the events that move its
 * jobs or its status, and written to `RunState.progress` through `core.setRunProgress`. Each run job weighs its
 * planned media work; finished jobs count in full and running jobs by their attempt's percent.
 */

import type { JobId, RunId } from '../../shared/jobs/ids'
import { ACTIVE_STATES, type Job, type JobPlan, type RunProgress } from '../../shared/jobs/types'
import type { DraftEvent } from './bus'
import type { EngineCore } from './core'
import { createRunProgress, progressStages, weightedMediaSec, type RunJobInput, type RunProgressTracker } from './progress'

/** What the feed reads and writes. */
export interface RunProgressFeedDeps
{
  core: Pick<EngineCore, 'queue' | 'run' | 'now' | 'setRunProgress'>
  /** Media seconds a running execution has processed across its stages; null when the job has none. */
  mediaSecDone(jobId: JobId): number | null
}

/** The run's progress as the engine keeps it current. */
export interface RunProgressFeed
{
  /** Schedules an update after an event that can move the run's progress; other events are ignored. */
  observe(event: DraftEvent): void
  /** Computes the run's progress now and publishes it while a run is open. */
  update(): RunProgress | null
}

const MOVES: ReadonlySet<DraftEvent['type']> = new Set<DraftEvent['type']>([
  'job.added', 'job.removed', 'job.updated', 'job.state', 'job.stage', 'job.progress', 'run.state'
])

/** A job's planned work in weighted media seconds: its plan's stages over its source's span; null while unknown. */
export function plannedWork(job: Pick<Job, 'plan' | 'media'>): number | null
{
  return job.plan === null ? null : weightedMediaSec(progressStages(job.plan, job.media?.durationSec ?? null))
}

/** A run job as the run's progress weighs it; a finalizing job has done all its media work and only places it. */
export function runJobInput(job: Readonly<Job>, work: number | null, mediaSecDone: number | null): RunJobInput
{
  const active = ACTIVE_STATES.includes(job.state)
  const done = job.state === 'done'
  return {
    id: job.id,
    state: job.state,
    work,
    percent: job.state === 'finalizing' ? 100 : active ? job.progress?.percent ?? null : null,
    mediaSecDone: active ? mediaSecDone : null,
    speed: active ? job.progress?.speed ?? null : null,
    bytesWritten: done ? job.result?.outputBytes ?? null : active ? job.progress?.bytesWritten ?? null : null,
    execution: job.execution
  }
}

/** Builds the feed and schedules a first update, so a run restored at startup shows its progress before any event. */
export function createRunProgressFeed(deps: RunProgressFeedDeps): RunProgressFeed
{
  const { core } = deps
  const works = new WeakMap<JobPlan, number | null>()
  let tracker: RunProgressTracker | null = null
  let trackedRun: RunId | null = null
  let scheduled = false

  const workOf = (job: Readonly<Job>): number | null =>
  {
    const plan = job.plan
    if (plan === null)
    {
      return null
    }
    if (!works.has(plan))
    {
      works.set(plan, plannedWork(job))
    }
    return works.get(plan) ?? null
  }

  const update = (): RunProgress | null =>
  {
    scheduled = false
    const run = core.run()
    if (run.status === 'idle' || run.runId === null)
    {
      tracker = null
      trackedRun = null
      return null
    }
    const at = core.now()
    if (tracker === null || trackedRun !== run.runId)
    {
      tracker = createRunProgress({ startedAt: at })
      trackedRun = run.runId
    }
    const jobs: RunJobInput[] = []
    for (const job of core.queue.jobs())
    {
      if (job.runId === run.runId)
      {
        jobs.push(runJobInput(job, workOf(job), ACTIVE_STATES.includes(job.state) ? deps.mediaSecDone(job.id) : null))
      }
    }
    const progress = tracker.update({ status: run.status, jobs }, at)
    core.setRunProgress(progress)
    return progress
  }

  const schedule = (): void =>
  {
    if (!scheduled)
    {
      scheduled = true
      queueMicrotask(update)
    }
  }

  schedule()

  return {
    observe(event: DraftEvent): void
    {
      if (MOVES.has(event.type))
      {
        schedule()
      }
    },
    update
  }
}
