/**
 * Selectors over the jobs store for rows, the run header, the sidebar, and the dashboard. Row selectors return the
 * stored values, so a row subscribed to its own job re-renders only when that job changes. Derived selectors are
 * memoized on the store fields they read, as useSyncExternalStore requires, and keep returning the same object while
 * a recomputed result is equal to it, so a progress batch re-renders no header, sidebar, or dashboard whose numbers
 * it leaves as they were; the factories cache one selector per argument, so calling them inline is safe. Every
 * attention count comes from attentionCount, so the header, the sidebar, and the filters count the same set.
 */
import { parseCatalog, parseRunId, type JobId, type RunId } from '../../../shared/jobs/ids'
import { attentionCount, needsAttention, STATE_GROUPS, type StateGroup } from '../../../shared/jobs/states'
import
{
  ACTIVE_STATES,
  JOB_STATES,
  type JobCounts,
  type JobMeasurement,
  type JobProgress,
  type JobStage,
  type JobState,
  type JobView,
  type RunState,
  type RunStatus,
  type Verification
} from '../../../shared/jobs/types'
import type { JobsState } from './jobs'

/** A selector over the jobs store. */
export type JobsSelector<T> = (state: JobsState) => T

type Jobs = JobsState['jobs']

const FACTORY_CACHE_LIMIT = 64

function memoize<A extends readonly unknown[], R>(compute: (...inputs: A) => R, same: (previous: R, next: R) => boolean = Object.is): (...inputs: A) => R
{
  let last: { inputs: A; value: R } | null = null
  return (...inputs: A): R =>
  {
    const previous = last
    if (previous !== null && inputs.every((input, index) => Object.is(input, previous.inputs[index])))
    {
      return previous.value
    }
    const computed = compute(...inputs)
    const value = previous !== null && same(previous.value, computed) ? previous.value : computed
    last = { inputs, value }
    return value
  }
}

function sameItems<T>(previous: readonly T[], next: readonly T[]): boolean
{
  return previous.length === next.length && previous.every((item, index) => Object.is(item, next[index]))
}

function sameFields<T extends object>(previous: T, next: T): boolean
{
  return (Object.keys(next) as Array<keyof T>).every((key) => Object.is(previous[key], next[key]))
}

function perArgument<K, T>(make: (key: K) => JobsSelector<T>): (key: K) => JobsSelector<T>
{
  const cache = new Map<K, JobsSelector<T>>()
  return (key: K): JobsSelector<T> =>
  {
    let selector = cache.get(key)
    if (selector === undefined)
    {
      if (cache.size >= FACTORY_CACHE_LIMIT)
      {
        cache.clear()
      }
      selector = make(key)
      cache.set(key, selector)
    }
    return selector
  }
}

function jobOf(state: JobsState, id: JobId): JobView | null
{
  return Object.hasOwn(state.jobs, id) ? state.jobs[id] : null
}

function emptyCounts(): JobCounts
{
  const counts = {} as JobCounts
  for (const state of JOB_STATES)
  {
    counts[state] = 0
  }
  return counts
}

/** Whether the store is live, connecting, resyncing, retrying, or not syncing. */
export const selectSyncStatus: JobsSelector<JobsState['status']> = (state) => state.status

/** Whether a snapshot has been applied, so the rows and settings are the engine's. */
export const selectHydrated: JobsSelector<boolean> = (state) => state.hydrations > 0

/** The run as the header shows it; null before the first snapshot. */
export const selectRun: JobsSelector<RunState | null> = (state) => state.run

/** The run's status; idle before the first snapshot. */
export const selectRunStatus: JobsSelector<RunStatus> = (state) => state.run?.status ?? 'idle'

/** The current run's id; null when no run is open. */
export const selectRunId: JobsSelector<RunId | null> = (state) => state.run?.runId ?? null

/** The run's percent while a run is open (the sidebar's "46%"); null when idle. */
export const selectRunPercent: JobsSelector<number | null> = (state) =>
  state.run !== null && state.run.status !== 'idle' ? state.run.progress.percent : null

/** Worker slots: the setting, the limits, and what is taken. */
export const selectWorkers: JobsSelector<RunState['workers'] | null> = (state) => state.run?.workers ?? null

/** The queue's output policy. */
export const selectPolicy: JobsSelector<JobsState['policy']> = (state) => state.policy

/** The run settings read live. */
export const selectSettings: JobsSelector<JobsState['settings']> = (state) => state.settings

/** The recipe new files get. */
export const selectDefaultRecipe: JobsSelector<JobsState['defaultRecipe']> = (state) => state.defaultRecipe

/** What this machine and FFmpeg build can do. */
export const selectCapabilities: JobsSelector<JobsState['capabilities']> = (state) => state.capabilities

/** Banner data, in the order raised. */
export const selectAlerts: JobsSelector<JobsState['alerts']> = (state) => state.alerts

/** Folder scans, running and finished. */
export const selectScans: JobsSelector<JobsState['scans']> = (state) => state.scans

/** User presets, pinned keys, and recent recipes. */
export const selectPresets: JobsSelector<JobsState['presets']> = (state) => state.presets

/** Folders added recently. */
export const selectRecentFolders: JobsSelector<JobsState['recentFolders']> = (state) => state.recentFolders

/** The last run that completed while this window listened. */
export const selectCompleted: JobsSelector<JobsState['completed']> = (state) => state.completed

/** The latest Review check's progress. */
export const selectPreflight: JobsSelector<JobsState['preflight']> = (state) => state.preflight

/** An unhandled request to bring a job or a batch forward. */
export const selectFocusRequest: JobsSelector<JobsState['focus']> = (state) => state.focus

/** Queue order, the order the table shows when it is not sorted. */
export const selectOrder: JobsSelector<readonly JobId[]> = (state) => state.order

/** Jobs in the queue. */
export const selectJobCount: JobsSelector<number> = (state) => state.order.length

/** Whether the queue holds as many jobs as it can. */
export const selectQueueFull: JobsSelector<boolean> = (state) => state.limits !== null && state.order.length >= state.limits.maxJobs

/** One row's job; null once it is removed. */
export function selectJob(id: JobId): JobsSelector<JobView | null>
{
  return (state) => jobOf(state, id)
}

/** One row's state, for cells that change only with it. */
export function selectJobState(id: JobId): JobsSelector<JobState | null>
{
  return (state) => jobOf(state, id)?.state ?? null
}

/** One row's stage. */
export function selectJobStage(id: JobId): JobsSelector<JobStage | null>
{
  return (state) => jobOf(state, id)?.stage ?? null
}

/** One row's progress. */
export function selectJobProgress(id: JobId): JobsSelector<JobProgress | null>
{
  return (state) => jobOf(state, id)?.progress ?? null
}

/** Whether one row needs attention (the held frame and its hidden words). */
export function selectJobNeedsAttention(id: JobId): JobsSelector<boolean>
{
  return (state) =>
  {
    const job = jobOf(state, id)
    return job !== null && needsAttention(job)
  }
}

/** One job's latest measurement since the last snapshot. */
export function selectJobMeasurement(id: JobId): JobsSelector<JobMeasurement | null>
{
  return (state) => Object.hasOwn(state.measurements, id) ? state.measurements[id] : null
}

/** One job's latest verification since the last snapshot. */
export function selectJobVerification(id: JobId): JobsSelector<Verification | null>
{
  return (state) => Object.hasOwn(state.verifications, id) ? state.verifications[id] : null
}

const orderedJobs = memoize((order: readonly JobId[], jobs: Jobs): readonly JobView[] => order.map((id) => jobs[id]))

/** Every job in queue order. */
export const selectOrderedJobs: JobsSelector<readonly JobView[]> = (state) => orderedJobs(state.order, state.jobs)

const activeJobs = memoize((order: readonly JobId[], jobs: Jobs): readonly JobView[] =>
  order.map((id) => jobs[id]).filter((job) => ACTIVE_STATES.includes(job.state)), sameItems)

/** The jobs holding a worker slot, in queue order. */
export const selectActiveJobs: JobsSelector<readonly JobView[]> = (state) => activeJobs(state.order, state.jobs)

const stateCounts = memoize((jobs: Jobs): Readonly<JobCounts> =>
{
  const counts = emptyCounts()
  for (const job of Object.values(jobs))
  {
    counts[job.state] += 1
  }
  return counts
}, sameFields)

/** Jobs per state across the queue. */
export const selectStateCounts: JobsSelector<Readonly<JobCounts>> = (state) => stateCounts(state.jobs)

const groupCounts = memoize((counts: Readonly<JobCounts>): Readonly<Record<StateGroup, number>> =>
{
  const groups: Record<StateGroup, number> = { waiting: 0, active: 0, decision: 0, terminal: 0 }
  for (const state of JOB_STATES)
  {
    groups[STATE_GROUPS[state]] += counts[state]
  }
  return groups
}, sameFields)

/** Jobs per state group: waiting (pending and queued), active, waiting for a decision, and ended. */
export const selectGroupCounts: JobsSelector<Readonly<Record<StateGroup, number>>> = (state) => groupCounts(stateCounts(state.jobs))

/** What the header says about the jobs not in a batch. */
export interface PendingSummary
{
  /** Pending jobs. */
  jobs: number
  /** Their source bytes. */
  bytes: number
  /** Media seconds of the jobs whose duration is known. */
  mediaSec: number
  /** Jobs whose duration is not known yet. */
  unknownDuration: number
  /** Jobs waiting for their probe. */
  probing: number
  /** Jobs whose probe failed. */
  unreadable: number
  /** Jobs whose plan is blocked. */
  blocked: number
  /** Jobs whose plan carries warnings and is not blocked or skipped. */
  withWarnings: number
  /** Jobs whose plan would skip them. */
  willSkip: number
  /** Jobs with no plan yet, or with a plan being made again. */
  planning: number
}

const pendingSummary = memoize((jobs: Jobs): Readonly<PendingSummary> =>
{
  const summary: PendingSummary =
  {
    jobs: 0, bytes: 0, mediaSec: 0, unknownDuration: 0, probing: 0, unreadable: 0, blocked: 0, withWarnings: 0, willSkip: 0, planning: 0
  }
  for (const job of Object.values(jobs))
  {
    if (job.state !== 'pending')
    {
      continue
    }
    summary.jobs += 1
    summary.bytes += job.source.size
    const duration = job.media?.durationSec ?? null
    if (duration === null)
    {
      summary.unknownDuration += 1
    }
    else
    {
      summary.mediaSec += duration
    }
    if (job.probe === 'pending')
    {
      summary.probing += 1
    }
    else if (job.probe === 'failed')
    {
      summary.unreadable += 1
    }
    const plan = job.plan
    if (plan === null || !plan.current)
    {
      summary.planning += 1
    }
    if (plan?.status === 'blocked')
    {
      summary.blocked += 1
    }
    else if (plan?.status === 'will-skip')
    {
      summary.willSkip += 1
    }
    else if (plan !== null && plan.warnings > 0)
    {
      summary.withWarnings += 1
    }
  }
  return summary
}, sameFields)

/** Counts and totals of the pending jobs, for the header sentence before a run and the new jobs during one. */
export const selectPendingSummary: JobsSelector<Readonly<PendingSummary>> = (state) => pendingSummary(state.jobs)

/** One run's jobs still in the queue. */
export interface RunJobs
{
  runId: RunId
  /** Every job of the run. */
  total: number
  /** The run's jobs per state. */
  counts: Readonly<JobCounts>
  /** Jobs that left the working states: held ones and every ended state. */
  settled: number
  /** Jobs that need attention, from attentionCount. */
  attention: number
}

function sameRunJobs(previous: Readonly<RunJobs>, next: Readonly<RunJobs>): boolean
{
  return previous.total === next.total && previous.settled === next.settled && previous.attention === next.attention &&
    sameFields(previous.counts, next.counts)
}

/** The jobs of one run, for "10 of 22 finished · 1 needs attention". */
export const selectRunJobs = perArgument((runId: RunId): JobsSelector<Readonly<RunJobs>> =>
{
  const compute = memoize((jobs: Jobs): Readonly<RunJobs> =>
  {
    const counts = emptyCounts()
    const members: JobView[] = []
    for (const job of Object.values(jobs))
    {
      if (job.runId === runId)
      {
        counts[job.state] += 1
        members.push(job)
      }
    }
    let settled = 0
    for (const state of JOB_STATES)
    {
      if (STATE_GROUPS[state] === 'decision' || STATE_GROUPS[state] === 'terminal')
      {
        settled += counts[state]
      }
    }
    return { runId, total: members.length, counts, settled, attention: attentionCount(members, runId) }
  }, sameRunJobs)
  return (state) => compute(state.jobs)
})

/** How many jobs need attention in one run, or in the whole queue for null (the sidebar, tray, and taskbar). */
export const selectAttentionCount = perArgument((runId: RunId | null): JobsSelector<number> =>
{
  const compute = memoize((jobs: Jobs): number => attentionCount(Object.values(jobs), runId))
  return (state) => compute(state.jobs)
})

/** The jobs that need attention in one run, or in the whole queue for null, in queue order. */
export const selectAttentionIds = perArgument((runId: RunId | null): JobsSelector<readonly JobId[]> =>
{
  const compute = memoize((order: readonly JobId[], jobs: Jobs): readonly JobId[] => order.filter((id) =>
  {
    const job = jobs[id]
    return (runId === null || job.runId === runId) && needsAttention(job)
  }), sameItems)
  return (state) => compute(state.order, state.jobs)
})

function endedFirst(a: JobView, b: JobView): number
{
  return (b.endedAt as number) - (a.endedAt as number) || (parseCatalog(b.id) as number) - (parseCatalog(a.id) as number)
}

/** The latest ended jobs, newest first: done, failed, canceled, skipped, and interrupted. */
export const selectRecentSettled = perArgument((limit: number): JobsSelector<readonly JobView[]> =>
{
  const compute = memoize((jobs: Jobs): readonly JobView[] =>
  {
    const latest: JobView[] = []
    for (const job of Object.values(jobs))
    {
      if (STATE_GROUPS[job.state] !== 'terminal' || job.endedAt === null)
      {
        continue
      }
      let index = latest.length
      while (index > 0 && endedFirst(job, latest[index - 1]) < 0)
      {
        index -= 1
      }
      if (index < limit)
      {
        latest.splice(index, 0, job)
        if (latest.length > limit)
        {
          latest.pop()
        }
      }
    }
    return latest
  }, sameItems)
  return (state) => compute(state.jobs)
})

const latestRunId = memoize((run: RunState | null, jobs: Jobs): RunId | null =>
{
  if (run?.runId)
  {
    return run.runId
  }
  let latest: RunId | null = null
  let latestSeq = -1
  for (const job of Object.values(jobs))
  {
    const seq = job.runId === null ? null : parseRunId(job.runId)
    if (seq !== null && seq > latestSeq)
    {
      latest = job.runId
      latestSeq = seq
    }
  }
  return latest
})

/** The current run, or the latest run any job in the queue belongs to; null when none. */
export const selectLatestRunId: JobsSelector<RunId | null> = (state) => latestRunId(state.run, state.jobs)
