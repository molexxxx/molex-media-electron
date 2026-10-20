/**
 * Progress math: stage weights, a job's percent that never drops within an attempt, job and run time left, and the
 * run's throughput over the last 30 seconds. Pure arithmetic over injected timestamps; nothing here reads a clock.
 */

import type { JobId } from '../../shared/jobs/ids'
import type { JobPlan, JobProgress, JobState, RunProgress, RunStatus, StageId } from '../../shared/jobs/types'

/** A stage of a job's plan as progress weighs it. */
export interface PlannedStage
{
  id: StageId
  pass: number
  passes: number
  /** Media seconds the stage processes; null or 0 while unknown. */
  durationSec: number | null
  /** A pass of a two-pass video encode, whose first pass weighs 1 instead of 2. */
  twoPass?: boolean
  /** A verify that decodes samples rather than the whole output. */
  sampled?: boolean
}

/**
 * A stage's weight in its job's percent and in the run's weighted media time: measure 1, measure-dynamics 1, encode 2
 * per pass (1 then 2 for two-pass), verify 1 for a full decode and 0.25 for a sampled one, and 0 for the rest.
 */
export function stageWeight(stage: Pick<PlannedStage, 'id' | 'pass' | 'twoPass' | 'sampled'>): number
{
  switch (stage.id)
  {
    case 'measure':
    case 'measure-dynamics':
    case 'measure-album':
      return 1
    case 'encode':
      return stage.twoPass === true && stage.pass === 1 ? 1 : 2
    case 'verify':
      return stage.sampled === true ? 0.25 : 1
    default:
      return 0
  }
}

/** The weights of a plan's stages in all. */
export function planWeight(stages: ReadonlyArray<Pick<PlannedStage, 'id' | 'pass' | 'twoPass' | 'sampled'>>): number
{
  return stages.reduce((sum, stage) => sum + stageWeight(stage), 0)
}

/** FFmpeg's realtime multiple, or null for `N/A`, the `0x` a lookahead encoder reports, and anything not positive. */
export function normalizeSpeed(speed: number | null | undefined): number | null
{
  return typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : null
}

/** Reads `-progress` speed text: `2.5x` is 2.5; `N/A` and `0x` are null. */
export function parseSpeed(text: string | null | undefined): number | null
{
  const match = /^\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*x\s*$/i.exec(text ?? '')
  return match ? normalizeSpeed(Number(match[1])) : null
}

function span(durationSec: number | null | undefined): number | null
{
  return typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
}

function finiteOrNull(value: number | null | undefined): number | null
{
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, low: number, high: number): number
{
  return Math.min(high, Math.max(low, value))
}

/** The speeds observed this session per job class and stage, which time the stages a job has not started yet. */
export interface SpeedBook
{
  observe(jobClass: string, stage: StageId, speed: number): void
  /** The mean speed observed for the class and stage, 1 until one is observed. */
  speed(jobClass: string, stage: StageId): number
}

/** A session's speed book. */
export function createSpeedBook(): SpeedBook
{
  const seen = new Map<string, { sum: number; count: number }>()
  const key = (jobClass: string, stage: StageId): string => `${jobClass}/${stage}`
  return {
    observe(jobClass: string, stage: StageId, speed: number): void
    {
      const value = normalizeSpeed(speed)
      if (value === null)
      {
        return
      }
      const entry = seen.get(key(jobClass, stage)) ?? { sum: 0, count: 0 }
      entry.sum += value
      entry.count += 1
      seen.set(key(jobClass, stage), entry)
    },
    speed(jobClass: string, stage: StageId): number
    {
      const entry = seen.get(key(jobClass, stage))
      return entry ? entry.sum / entry.count : 1
    }
  }
}

/** One progress report from the running stage. */
export interface StageSample
{
  outTimeSec: number | null
  speed: number | null
  bytesWritten: number | null
  /** The span `-progress` revealed, when the plan did not know it. */
  durationSec?: number | null
}

/** A job's progress through its planned stages within one attempt. */
export interface JobProgressTracker
{
  /** The weights of every planned stage, corrective stages included. */
  readonly weightTotal: number
  /** Weighted media seconds of every planned stage whose span is known: its weight times its span. */
  readonly work: number
  /** The part of `work` done so far; it rises with the samples and falls only when the span grows. */
  readonly workDone: number
  /** Media seconds processed so far across stages. */
  readonly mediaSecDone: number
  /** The percent last reported; it never decreases. */
  readonly percent: number
  /** A stage starts; a stage still running finishes first, and planned stages passed over count as done. */
  start(stage: StageId, pass: number, at: number): JobProgress
  sample(sample: StageSample, at: number): JobProgress
  finishStage(at: number): JobProgress
  /** Adds stages, such as a corrective encode and its verify; the rest of the range is spread over them. */
  extend(stages: readonly PlannedStage[], at: number): JobProgress
  progress(at: number): JobProgress
}

interface StageEntry extends PlannedStage
{
  weight: number
  done: boolean
}

interface CurrentStage
{
  id: StageId
  pass: number
  passes: number
  durationSec: number | null
  startedAt: number
  finished: boolean
}

function toEntry(stage: PlannedStage): StageEntry
{
  return { ...stage, weight: stageWeight(stage), done: false }
}

/**
 * Tracks one attempt. A stage whose span is unknown or 0 adds nothing until it finishes and then its full weight, so
 * `percent` stays finite; `stagePercent` and `etaSec` are null when they cannot be known. The job's time left is the
 * current stage's remaining media time at its speed plus later stages at the speed this session observed for their
 * class and stage, null until the second sample and while the current speed is unknown.
 */
export function createJobProgress(options: {
  stages: readonly PlannedStage[]
  jobClass: string
  speeds: SpeedBook
  startedAt: number
}): JobProgressTracker
{
  const stages: StageEntry[] = options.stages.map(toEntry)
  let index: number | null = null
  let current: CurrentStage | null = null
  let outTimeSec: number | null = null
  let speed: number | null = null
  let lastSpeed: number | null = null
  let bytesWritten: number | null = null
  let samples = 0
  let reported = 0
  let anchorPercent = 0
  let anchorWeight = 0
  let mediaDone = 0

  const totalWeight = (): number => stages.reduce((sum, entry) => sum + entry.weight, 0)

  /** The running stage's fraction; callers read it only while that stage runs. */
  const currentFraction = (): number =>
  {
    const known = span(current?.durationSec)
    return known === null || outTimeSec === null ? 0 : clamp(outTimeSec / known, 0, 1)
  }

  const doneWeight = (): number =>
  {
    let weight = 0
    for (const entry of stages)
    {
      if (entry.done)
      {
        weight += entry.weight
      }
    }
    if (index !== null && !stages[index].done)
    {
      weight += stages[index].weight * currentFraction()
    }
    return weight
  }

  const computePercent = (): number =>
  {
    if (stages.length > 0 && stages.every((entry) => entry.done))
    {
      return 100
    }
    const remaining = totalWeight() - anchorWeight
    if (remaining <= 0)
    {
      return anchorPercent
    }
    return anchorPercent + ((100 - anchorPercent) * (doneWeight() - anchorWeight)) / remaining
  }

  const refresh = (): number =>
  {
    reported = clamp(Math.max(reported, computePercent()), 0, 100)
    return reported
  }

  const work = (done: boolean): number =>
  {
    let total = 0
    for (let i = 0; i < stages.length; i += 1)
    {
      const known = span(stages[i].durationSec)
      if (known === null)
      {
        continue
      }
      if (!done || stages[i].done)
      {
        total += stages[i].weight * known
      }
      else if (i === index)
      {
        total += stages[i].weight * known * currentFraction()
      }
    }
    return total
  }

  const currentMedia = (): number =>
  {
    if (current === null || current.finished || outTimeSec === null)
    {
      return 0
    }
    const known = span(current.durationSec)
    return clamp(outTimeSec, 0, known ?? Number.POSITIVE_INFINITY)
  }

  const etaSec = (): number | null =>
  {
    if (samples < 2 || speed === null || current === null || current.finished || outTimeSec === null)
    {
      return null
    }
    const known = span(current.durationSec)
    if (known === null)
    {
      return null
    }
    let seconds = Math.max(0, known - outTimeSec) / speed
    for (let i = index === null ? 0 : index + 1; i < stages.length; i += 1)
    {
      const later = stages[i]
      const laterSpan = span(later.durationSec)
      if (!later.done && laterSpan !== null)
      {
        seconds += laterSpan / options.speeds.speed(options.jobClass, later.id)
      }
    }
    return seconds
  }

  const finishCurrent = (at: number): void =>
  {
    if (current === null || current.finished)
    {
      return
    }
    const known = span(current.durationSec)
    mediaDone += known ?? Math.max(0, outTimeSec ?? 0)
    const wallSec = (at - current.startedAt) / 1000
    if (known !== null && wallSec > 0)
    {
      options.speeds.observe(options.jobClass, current.id, known / wallSec)
    }
    else if (lastSpeed !== null)
    {
      options.speeds.observe(options.jobClass, current.id, lastSpeed)
    }
    current.finished = true
    if (index !== null)
    {
      stages[index].done = true
    }
  }

  const findStage = (id: StageId, pass: number): number | null =>
  {
    const from = index === null ? 0 : index + 1
    let sameId: number | null = null
    for (let i = from; i < stages.length; i += 1)
    {
      if (stages[i].done || stages[i].id !== id)
      {
        continue
      }
      if (stages[i].pass === pass)
      {
        return i
      }
      sameId = sameId ?? i
    }
    return sameId
  }

  const progress = (at: number): JobProgress =>
  {
    let stagePercent: number | null = null
    if (current !== null && current.finished)
    {
      stagePercent = 100
    }
    else if (current !== null && outTimeSec !== null && span(current.durationSec) !== null)
    {
      stagePercent = currentFraction() * 100
    }
    return {
      stage: current?.id ?? stages[0]?.id ?? 'probe',
      pass: current?.pass ?? 1,
      passes: current?.passes ?? 1,
      percent: reported,
      stagePercent,
      speed,
      etaSec: etaSec(),
      outTimeSec,
      durationSec: current === null ? null : span(current.durationSec),
      bytesWritten,
      elapsedMs: Math.max(0, at - options.startedAt)
    }
  }

  return {
    get weightTotal()
    {
      return totalWeight()
    },
    get work()
    {
      return work(false)
    },
    get workDone()
    {
      return work(true)
    },
    get mediaSecDone()
    {
      return mediaDone + currentMedia()
    },
    get percent()
    {
      return reported
    },
    start(id: StageId, pass: number, at: number): JobProgress
    {
      finishCurrent(at)
      const found = findStage(id, pass)
      if (found !== null)
      {
        for (let i = index === null ? 0 : index; i < found; i += 1)
        {
          stages[i].done = true
        }
        index = found
        const entry = stages[found]
        current = { id, pass: entry.pass, passes: entry.passes, durationSec: entry.durationSec, startedAt: at, finished: false }
      }
      else
      {
        current = { id, pass, passes: Math.max(1, pass), durationSec: null, startedAt: at, finished: false }
      }
      outTimeSec = null
      speed = null
      lastSpeed = null
      bytesWritten = null
      refresh()
      return progress(at)
    },
    sample(next: StageSample, at: number): JobProgress
    {
      if (current === null || current.finished)
      {
        return progress(at)
      }
      samples += 1
      if (next.durationSec !== undefined && span(next.durationSec) !== null)
      {
        current.durationSec = next.durationSec
        if (index !== null && !stages[index].done)
        {
          stages[index].durationSec = next.durationSec
        }
      }
      const time = finiteOrNull(next.outTimeSec)
      outTimeSec = time === null ? null : Math.max(0, time)
      speed = normalizeSpeed(next.speed)
      lastSpeed = speed ?? lastSpeed
      bytesWritten = finiteOrNull(next.bytesWritten)
      refresh()
      return progress(at)
    },
    finishStage(at: number): JobProgress
    {
      finishCurrent(at)
      refresh()
      return progress(at)
    },
    extend(added: readonly PlannedStage[], at: number): JobProgress
    {
      anchorPercent = refresh()
      anchorWeight = doneWeight()
      stages.push(...added.map(toEntry))
      refresh()
      return progress(at)
    },
    progress
  }
}

/** The time constant of the run's throughput average: an interval's weight falls by a factor of e every 30 seconds. */
export const THROUGHPUT_WINDOW_MS = 30_000

/** How long a run tracks progress before it shows a time left; until then the header reads "Estimating time left". */
export const RUN_ETA_DELAY_MS = 15_000

/** A smoothed rate over a cumulative amount, such as weighted media seconds completed per wall second. */
export interface ThroughputWindow
{
  /** The amount per second, null until an observation spans some time. */
  readonly rate: number | null
  /** Records the cumulative amount at a time and returns the rate; a total that falls counts as no progress. */
  observe(total: number, at: number): number | null
  /** Moves the baseline without counting the time since the last observation, as after a pause. */
  rebase(total: number, at: number): void
}

/**
 * An exponentially weighted throughput: each interval's amount and duration decay by `exp(-age / windowMs)` and the
 * rate is their ratio, so a short history reads as the plain average instead of leaning on the first interval.
 */
export function createThroughputWindow(windowMs: number = THROUGHPUT_WINDOW_MS): ThroughputWindow
{
  let amount = 0
  let duration = 0
  let lastTotal: number | null = null
  let lastAt: number | null = null

  const rate = (): number | null => (duration > 0 ? (amount / duration) * 1000 : null)

  return {
    get rate()
    {
      return rate()
    },
    observe(total: number, at: number): number | null
    {
      if (!Number.isFinite(total) || !Number.isFinite(at))
      {
        return rate()
      }
      if (lastTotal === null || lastAt === null)
      {
        lastTotal = total
        lastAt = at
        return rate()
      }
      const elapsed = at - lastAt
      if (elapsed <= 0)
      {
        return rate()
      }
      const decay = Math.exp(-elapsed / windowMs)
      amount = amount * decay + Math.max(0, total - lastTotal)
      duration = duration * decay + elapsed
      lastTotal = total
      lastAt = at
      return rate()
    },
    rebase(total: number, at: number): void
    {
      if (Number.isFinite(total) && Number.isFinite(at))
      {
        lastTotal = total
        lastAt = at
      }
    }
  }
}

/** A plan's weighted media seconds: each stage's weight times its span; null while no weighted stage has a known span. */
export function weightedMediaSec(stages: readonly PlannedStage[]): number | null
{
  let total = 0
  for (const stage of stages)
  {
    const known = span(stage.durationSec)
    if (known !== null)
    {
      total += stageWeight(stage) * known
    }
  }
  return total > 0 ? total : null
}

/**
 * A plan's stages as a job's progress weighs them, each weighted stage over the media span it processes: both passes
 * of a two-pass video encode, and the first pass of every other stage. A later encode pass and its verify are a
 * correction, which joins through `extend` when it starts.
 */
export function progressStages(plan: Pick<JobPlan, 'stages' | 'video'>, durationSec: number | null): PlannedStage[]
{
  const known = span(durationSec)
  const twoPass = plan.video?.passes === 2
  const stages: PlannedStage[] = []
  for (const stage of plan.stages)
  {
    if (stage.id === 'encode' && twoPass)
    {
      stages.push({ id: 'encode', pass: 1, passes: 2, durationSec: known, twoPass: true })
      stages.push({ id: 'encode', pass: 2, passes: 2, durationSec: known, twoPass: true })
      continue
    }
    const entry: PlannedStage = { id: stage.id, pass: 1, passes: 1, durationSec: null }
    stages.push({ ...entry, durationSec: stageWeight(entry) > 0 ? known : null })
  }
  return stages
}

/** A correction's encode pass and the verify that follows it, over the job's media span. */
export function correctionStages(pass: number, passes: number, durationSec: number | null): PlannedStage[]
{
  const known = span(durationSec)
  return [
    { id: 'encode', pass, passes, durationSec: known },
    { id: 'verify', pass, passes, durationSec: known }
  ]
}

/** A job of the run as the run's progress weighs it; pending jobs are not part of the run and are left out. */
export interface RunJobInput
{
  id: JobId
  state: JobState
  /** The job's weighted media seconds, from `weightedMediaSec` or a tracker's `work`; null or 0 while unknown. */
  work: number | null
  /** The weighted media seconds done in the current attempt, a tracker's `workDone`; `percent` stands in without it. */
  workDone?: number | null
  /** The job's percent within its current attempt. */
  percent?: number | null
  /** Media seconds the current attempt processed across its stages, a tracker's `mediaSecDone`. */
  mediaSecDone?: number | null
  speed?: number | null
  /** Bytes the job wrote: the output so far while it runs, the placed output once done. */
  bytesWritten?: number | null
  /** The job's execution number; a new one counts the job's progress afresh. */
  execution?: number
}

/** What the run's progress reads on each update. */
export interface RunProgressInput
{
  status: RunStatus
  jobs: readonly RunJobInput[]
}

/** The run's progress across updates. */
export interface RunProgressTracker
{
  update(input: RunProgressInput, at: number): RunProgress
}

/** Options of a run's progress. */
export interface RunProgressOptions
{
  /** When the run started, or when an interrupted run was restored. */
  startedAt: number
  /** Time the run had already spent before `startedAt`, for a restored run. */
  elapsedMs?: number
  windowMs?: number
  etaDelayMs?: number
}

const FINISHED_STATES: ReadonlySet<JobState> = new Set<JobState>(['done', 'failed', 'canceled', 'skipped', 'interrupted', 'held'])
const RUNNING_STATES: ReadonlySet<JobState> = new Set<JobState>(['analyzing', 'encoding', 'verifying', 'finalizing'])
const CLOCK_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['running', 'pausing', 'canceling'])

interface JobCounter
{
  execution: number | undefined
  done: number
  mediaSec: number
  /** A done job has counted all its work. */
  settled: boolean
}

interface RunTotals
{
  total: number
  done: number
  members: number
  finished: number
}

function knownWork(work: number | null | undefined): number | null
{
  return span(work)
}

function meanKnownWork(jobs: readonly RunJobInput[]): number
{
  let sum = 0
  let count = 0
  for (const job of jobs)
  {
    const known = job.state === 'pending' ? null : knownWork(job.work)
    if (known !== null)
    {
      sum += known
      count += 1
    }
  }
  return count > 0 ? sum / count : 1
}

function attemptDone(job: RunJobInput, full: number): number
{
  const known = knownWork(job.work)
  const workDone = finiteOrNull(job.workDone)
  if (known !== null && workDone !== null)
  {
    return clamp(workDone, 0, known)
  }
  return (full * clamp(finiteOrNull(job.percent) ?? 0, 0, 100)) / 100
}

/**
 * The run's progress. Percent is weighted media seconds done over the run's total: finished and held jobs count in full,
 * running jobs by the work their attempt has done, and a job of unknown span as the mean of the known ones. Time left
 * divides the remaining weighted media seconds by the weighted throughput, and only while running, after 15 seconds of
 * tracking with some progress. `mediaSecPerSec` is plain media seconds per wall second over the same window. The clock
 * and the throughput stop while paused or idle, and the paused gap never counts.
 */
export function createRunProgress(options: RunProgressOptions): RunProgressTracker
{
  const weighted = createThroughputWindow(options.windowMs)
  const plain = createThroughputWindow(options.windowMs)
  const etaDelayMs = options.etaDelayMs ?? RUN_ETA_DELAY_MS
  const carried = Math.max(0, finiteOrNull(options.elapsedMs) ?? 0)
  const counters = new Map<JobId, JobCounter>()
  let weightedTotal = 0
  let plainTotal = 0
  let clockMs = 0
  let clockSince: number | null = options.startedAt
  let first = true

  weighted.observe(0, options.startedAt)
  plain.observe(0, options.startedAt)

  const activeMs = (at: number): number => clockMs + (clockSince === null ? 0 : Math.max(0, at - clockSince))

  const count = (job: RunJobInput, processed: number | null): void =>
  {
    const counter = counters.get(job.id)
    if (job.state === 'queued' || job.state === 'pending')
    {
      counters.set(job.id, { execution: job.execution, done: 0, mediaSec: 0, settled: false })
      return
    }
    if (processed === null)
    {
      return
    }
    const media = finiteOrNull(job.mediaSecDone)
    const restarted = counter !== undefined && job.execution !== undefined && counter.execution !== undefined &&
      job.execution !== counter.execution
    const base = counter === undefined || restarted
      ? { execution: job.execution, done: first ? processed : 0, mediaSec: first ? media ?? 0 : 0, settled: false }
      : counter
    if (base.settled)
    {
      return
    }
    weightedTotal += Math.max(0, processed - base.done)
    base.done = processed
    if (media !== null)
    {
      plainTotal += Math.max(0, media - base.mediaSec)
      base.mediaSec = media
    }
    base.execution = job.execution ?? base.execution
    base.settled = job.state === 'done'
    counters.set(job.id, base)
  }

  const weigh = (jobs: readonly RunJobInput[]): RunTotals =>
  {
    const fallback = meanKnownWork(jobs)
    const totals: RunTotals = { total: 0, done: 0, members: 0, finished: 0 }
    const seen = new Set<JobId>()
    for (const job of jobs)
    {
      seen.add(job.id)
      if (job.state === 'pending')
      {
        count(job, null)
        continue
      }
      const full = knownWork(job.work) ?? fallback
      totals.members += 1
      totals.total += full
      if (FINISHED_STATES.has(job.state))
      {
        totals.finished += 1
        totals.done += full
        count(job, job.state === 'done' ? full : null)
      }
      else if (RUNNING_STATES.has(job.state))
      {
        const done = attemptDone(job, full)
        totals.done += done
        count(job, done)
      }
      else
      {
        count(job, null)
      }
    }
    for (const id of [...counters.keys()])
    {
      if (!seen.has(id))
      {
        counters.delete(id)
      }
    }
    return totals
  }

  return {
    update(input: RunProgressInput, at: number): RunProgress
    {
      const clockRuns = CLOCK_STATUSES.has(input.status)
      if (!clockRuns && clockSince !== null)
      {
        clockMs += Math.max(0, at - clockSince)
        clockSince = null
      }
      const resumed = clockRuns && clockSince === null
      if (resumed)
      {
        clockSince = at
      }
      const totals = weigh(input.jobs)
      first = false
      if (resumed)
      {
        weighted.rebase(weightedTotal, at)
        plain.rebase(plainTotal, at)
      }
      else if (clockRuns)
      {
        weighted.observe(weightedTotal, at)
        plain.observe(plainTotal, at)
      }
      let percent = 0
      if (totals.members > 0)
      {
        percent = totals.finished === totals.members ? 100 : clamp((100 * totals.done) / totals.total, 0, 100)
      }
      const rate = weighted.rate
      const etaSec = input.status === 'running' && activeMs(at) >= etaDelayMs && rate !== null && rate > 0
        ? Math.max(0, totals.total - totals.done) / rate
        : null
      let aggregateSpeed: number | null = null
      let bytesWritten = 0
      for (const job of input.jobs)
      {
        if (job.state === 'pending')
        {
          continue
        }
        const jobSpeed = RUNNING_STATES.has(job.state) ? normalizeSpeed(job.speed) : null
        if (jobSpeed !== null)
        {
          aggregateSpeed = (aggregateSpeed ?? 0) + jobSpeed
        }
        bytesWritten += Math.max(0, finiteOrNull(job.bytesWritten) ?? 0)
      }
      return {
        percent,
        etaSec,
        mediaSecPerSec: clockRuns ? plain.rate : null,
        aggregateSpeed,
        bytesWritten,
        elapsedMs: carried + activeMs(at)
      }
    }
  }
}
