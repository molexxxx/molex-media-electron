/**
 * Analysis tasks and the analysis cache. A task measures a pending or queued normalize or boost job before the run, so
 * the Review step shows measured loudness, planned gain, and predicted limiting; it runs probe, static plan, measure,
 * and gain plan, never an encode. Analyses are cached under their measure key for the session, so the run's measure
 * stage reuses them. Tasks and the cache are not persisted. The audio functions arrive through injection.
 */

import type { AudioAnalysis } from '../../shared/audio/events'
import type { JobId } from '../../shared/jobs/ids'
import type { JobMeasurement, PauseMode } from '../../shared/jobs/types'
import type { Slot } from './dispatch'

/** Most analyses the cache keeps; the least recently used goes first. */
export const ANALYSIS_CACHE_LIMIT = 2000

/** Analyses by measure key, least recently used dropped past the limit. */
export class AnalysisCache
{
  private readonly entries = new Map<string, AudioAnalysis>()
  private readonly limit: number

  constructor(limit = ANALYSIS_CACHE_LIMIT)
  {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get size(): number
  {
    return this.entries.size
  }

  /** The analysis under the key, or null; a hit counts as a use. */
  get(key: string): AudioAnalysis | null
  {
    const analysis = this.entries.get(key)
    if (analysis === undefined) return null
    this.entries.delete(key)
    this.entries.set(key, analysis)
    return analysis
  }

  /** Keeps an analysis under its own cache key. */
  set(analysis: AudioAnalysis): void
  {
    this.entries.delete(analysis.cacheKey)
    this.entries.set(analysis.cacheKey, analysis)
    while (this.entries.size > this.limit)
    {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }

  delete(key: string): void
  {
    this.entries.delete(key)
  }

  clear(): void
  {
    this.entries.clear()
  }
}

/** What an analysis run gets besides the job: its abort signal and a read of the cache by measure key. */
export interface AnalysisContext
{
  signal: AbortSignal
  /** The cached analysis under a measure key, so a hit skips the measure. */
  cached(key: string): AudioAnalysis | null
}

/** What analysis tasks are built with. */
export interface AnalysisTaskDeps
{
  /** Probe, static plan, and measure (the audio module's analyzeAudioJob); rejects on a failure or refusal. */
  analyze(jobId: JobId, context: AnalysisContext): Promise<AudioAnalysis>
  /** The gain plan over an analysis as the Review step shows it (planAudioJob, no encode). */
  plan(jobId: JobId, analysis: AudioAnalysis): JobMeasurement
  /** Reports a task's end, so its result lands on the job and dispatch runs again. */
  onSettled(outcome: AnalysisOutcome): void
}

/** How an analysis task ended; a canceled task reports nothing. */
export type AnalysisOutcome =
  /** The measurement lands as `job.measured` with pass 'preview'. */
  | { kind: 'measured'; jobId: JobId; measurement: JobMeasurement; analysis: AudioAnalysis }
  | { kind: 'failed'; jobId: JobId; error: unknown }
  /** Stopped by "Pause now" or quit now; resume restarts the request. */
  | { kind: 'stopped'; jobId: JobId }

/** Where a job's analysis request stands. */
export type AnalysisState = 'pending' | 'running' | 'stopped'

interface Task
{
  jobId: JobId
  state: AnalysisState
  controller: AbortController | null
  waiters: Set<(analysis: AudioAnalysis | null) => void>
}

/** The analysis requests of the session, the tasks they run, and the cache their results land in. */
export class AnalysisTasks
{
  /** Analyses by measure key, shared with the run's measure stage and album tasks. */
  readonly cache: AnalysisCache
  private readonly deps: AnalysisTaskDeps
  private readonly tasks = new Map<JobId, Task>()
  private readonly direct = new Map<JobId, Promise<AudioAnalysis>>()
  private paused = false

  constructor(deps: AnalysisTaskDeps, cache: AnalysisCache = new AnalysisCache())
  {
    this.deps = deps
    this.cache = cache
  }

  /** `jobs:analyze`: one request per job at a time; answers the jobs that got a new request. */
  request(jobIds: readonly JobId[]): JobId[]
  {
    const accepted: JobId[] = []
    for (const jobId of jobIds)
    {
      if (this.tasks.has(jobId) || this.direct.has(jobId)) continue
      this.tasks.set(jobId, { jobId, state: 'pending', controller: null, waiters: new Set() })
      accepted.push(jobId)
    }
    return accepted
  }

  /** The job's request state, or null. */
  state(jobId: JobId): AnalysisState | null
  {
    return this.tasks.get(jobId)?.state ?? null
  }

  /** Requests waiting for a slot, in request order; none while the run is pausing or paused. */
  pending(): JobId[]
  {
    if (this.paused) return []
    const pending: JobId[] = []
    for (const task of this.tasks.values()) if (task.state === 'pending') pending.push(task.jobId)
    return pending
  }

  /** Running tasks, in request order. */
  running(): JobId[]
  {
    const running: JobId[] = []
    for (const task of this.tasks.values()) if (task.state === 'running') running.push(task.jobId)
    return running
  }

  /** One audio slot per running task. */
  slots(): Slot[]
  {
    return this.running().map(() => ({ kind: 'analysis', class: 'audio' }))
  }

  /** Starts a pending request in a slot dispatch chose; false when the job has none or the run is paused. */
  start(jobId: JobId): boolean
  {
    const task = this.tasks.get(jobId)
    if (task === undefined || task.state !== 'pending' || this.paused) return false
    const controller = new AbortController()
    task.state = 'running'
    task.controller = controller
    void this.run(task, controller)
    return true
  }

  /**
   * Aborts the job's task: the child is killed, nothing is cached, and the request is dropped. Used by
   * `jobs:cancelAnalyze`, `jobs:remove`, `jobs:cancel`, a change to the measured part of the recipe, and `run:cancel`.
   */
  cancel(jobId: JobId): boolean
  {
    const task = this.tasks.get(jobId)
    if (task === undefined) return false
    this.tasks.delete(jobId)
    task.controller?.abort()
    task.controller = null
    this.wake(task, null)
    return true
  }

  /** A dispatch claim took the job: a request still waiting for a slot is dropped, a running one is kept. */
  claimed(jobId: JobId): void
  {
    if (this.tasks.get(jobId)?.state !== 'running') this.cancel(jobId)
  }

  /** "Pause" starts no new tasks; "Pause now" also stops the running ones, which resume restarts. */
  pause(mode: PauseMode): void
  {
    this.paused = true
    if (mode === 'finish-running') return
    for (const task of [...this.tasks.values()])
    {
      if (task.state !== 'running') continue
      task.controller?.abort()
      task.controller = null
      task.state = 'stopped'
      this.wake(task, null)
      this.deps.onSettled({ kind: 'stopped', jobId: task.jobId })
    }
  }

  /** Quit now stops running tasks as "Pause now" does. */
  quitNow(): void
  {
    this.pause('stop-running')
  }

  /** Starts tasks again and puts stopped requests back in line. */
  resume(): void
  {
    this.paused = false
    for (const task of this.tasks.values()) if (task.state === 'stopped') task.state = 'pending'
  }

  /**
   * A dispatched job's measure stage: the cached analysis under its key, or the result of the job's running task, so
   * the job keeps one child and is measured once; null when the job measures itself.
   */
  forJob(jobId: JobId, key: string, signal: AbortSignal): Promise<AudioAnalysis | null>
  {
    const cached = this.cache.get(key)
    if (cached !== null) return Promise.resolve(cached)
    const task = this.tasks.get(jobId)
    if (task === undefined) return Promise.resolve(null)
    if (task.state !== 'running')
    {
      this.cancel(jobId)
      return Promise.resolve(null)
    }
    return this.wait(task, signal).then((analysis) => (analysis !== null && analysis.cacheKey === key ? analysis : null))
  }

  /**
   * An album member's analysis: the result of its running task, or a run in the caller's slot that reads the cache
   * first and fills it after. Rejects when the analysis fails or is refused.
   */
  async obtain(jobId: JobId, signal: AbortSignal): Promise<AudioAnalysis>
  {
    const task = this.tasks.get(jobId)
    if (task?.state === 'running')
    {
      const shared = await this.wait(task, signal)
      if (shared !== null) return shared
    }
    else if (task !== undefined)
    {
      this.cancel(jobId)
    }
    const run = this.deps.analyze(jobId, { signal, cached: (key) => this.cache.get(key) })
    this.direct.set(jobId, run)
    try
    {
      const analysis = await run
      if (!signal.aborted) this.cache.set(analysis)
      return analysis
    }
    finally
    {
      if (this.direct.get(jobId) === run) this.direct.delete(jobId)
    }
  }

  /** Keeps an analysis a job's own measure stage produced. */
  store(analysis: AudioAnalysis): void
  {
    this.cache.set(analysis)
  }

  /** Drops every task and the cache; recovery starts empty. */
  clear(): void
  {
    for (const jobId of [...this.tasks.keys()]) this.cancel(jobId)
    this.cache.clear()
    this.paused = false
  }

  private wait(task: Task, signal: AbortSignal): Promise<AudioAnalysis | null>
  {
    if (signal.aborted) return Promise.resolve(null)
    return new Promise((resolve) =>
    {
      const done = (analysis: AudioAnalysis | null): void =>
      {
        task.waiters.delete(done)
        signal.removeEventListener('abort', aborted)
        resolve(analysis)
      }
      const aborted = (): void => done(null)
      task.waiters.add(done)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private wake(task: Task, analysis: AudioAnalysis | null): void
  {
    for (const waiter of [...task.waiters]) waiter(analysis)
    task.waiters.clear()
  }

  private async run(task: Task, controller: AbortController): Promise<void>
  {
    const live = (): boolean => task.controller === controller && this.tasks.get(task.jobId) === task
    try
    {
      const analysis = await this.deps.analyze(task.jobId, { signal: controller.signal, cached: (key) => this.cache.get(key) })
      if (!live()) return
      this.cache.set(analysis)
      const measurement: JobMeasurement = { ...this.deps.plan(task.jobId, analysis), pass: 'preview' }
      this.tasks.delete(task.jobId)
      this.wake(task, analysis)
      this.deps.onSettled({ kind: 'measured', jobId: task.jobId, measurement, analysis })
    }
    catch (error)
    {
      if (!live()) return
      this.tasks.delete(task.jobId)
      this.wake(task, null)
      this.deps.onSettled({ kind: 'failed', jobId: task.jobId, error })
    }
  }
}
