import { describe, expect, it, vi } from 'vitest'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import type { Job, JobPlan, JobProgress, JobState, RunProgress, RunState, RunStatus } from '../../../src/shared/jobs/types'
import type { DraftEvent } from '../../../src/main/jobs/bus'
import { createRunProgressFeed, plannedWork, runJobInput, type RunProgressFeedDeps } from '../../../src/main/jobs/run-progress'

const RUN = 'B-0001' as RunId
const STAGES: JobPlan['stages'] = [{ id: 'probe', passes: 1 }, { id: 'measure', passes: 1 }, { id: 'encode', passes: 2 }, { id: 'verify', passes: 2 }]

function progress(percent: number, extra: Partial<JobProgress> = {}): JobProgress
{
  return { stage: 'encode', pass: 1, passes: 2, percent, stagePercent: null, speed: null, etaSec: null, outTimeSec: null, durationSec: null, bytesWritten: null, elapsedMs: 0, ...extra }
}

function job(n: number, state: JobState, extra: Partial<Job> & { durationSec?: number | null } = {}): Job
{
  const { durationSec = 60, ...rest } = extra
  return {
    id: `MM-${String(n).padStart(4, '0')}` as JobId,
    state,
    runId: state === 'pending' ? null : RUN,
    plan: { stages: STAGES, video: null } as unknown as JobPlan,
    media: { durationSec } as Job['media'],
    progress: null,
    result: null,
    execution: 1,
    ...rest
  } as Job
}

interface Fake
{
  deps: RunProgressFeedDeps
  jobs: Job[]
  published: RunProgress[]
  setRun(status: RunStatus, runId?: RunId | null): void
  advance(ms: number): void
}

function fake(jobs: Job[], status: RunStatus = 'running', mediaSecDone: (id: JobId) => number | null = () => null): Fake
{
  let now = 1_000
  let run: Pick<RunState, 'status' | 'runId'> = { status, runId: status === 'idle' ? null : RUN }
  const published: RunProgress[] = []
  const deps: RunProgressFeedDeps = {
    core: {
      queue: { jobs: () => jobs } as unknown as RunProgressFeedDeps['core']['queue'],
      run: () => run as RunState,
      now: () => now,
      setRunProgress: (p: RunProgress) =>
      {
        published.push(p)
      }
    },
    mediaSecDone
  }
  return {
    deps,
    jobs,
    published,
    setRun: (next, runId = RUN) =>
    {
      run = { status: next, runId: next === 'idle' ? null : runId }
    },
    advance: (ms) =>
    {
      now += ms
    }
  }
}

const turn = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

describe('plannedWork', () =>
{
  it('weighs a job by its plan over its source span, and is null without either', () =>
  {
    expect(plannedWork(job(1, 'queued'))).toBe(240)
    expect(plannedWork(job(1, 'queued', { durationSec: 120 }))).toBe(480)
    expect(plannedWork(job(1, 'queued', { durationSec: null }))).toBeNull()
    expect(plannedWork(job(1, 'queued', { plan: null }))).toBeNull()
    expect(plannedWork({ plan: { stages: STAGES, video: null } as unknown as JobPlan, media: null })).toBeNull()
  })
})

describe('runJobInput', () =>
{
  it('reads a running job by its progress and execution, and a done job by its placed output', () =>
  {
    const running = job(1, 'encoding', { progress: progress(40, { speed: 3, bytesWritten: 500 }), execution: 2 })
    expect(runJobInput(running, 240, 75)).toEqual({ id: running.id, state: 'encoding', work: 240, percent: 40, mediaSecDone: 75, speed: 3, bytesWritten: 500, execution: 2 })
    const done = job(2, 'done', { progress: progress(100), result: { outputBytes: 900 } as Job['result'] })
    expect(runJobInput(done, 240, 10)).toMatchObject({ percent: null, mediaSecDone: null, speed: null, bytesWritten: 900 })
    expect(runJobInput(job(3, 'queued'), null, null)).toMatchObject({ percent: null, bytesWritten: null, work: null })
    expect(runJobInput(job(4, 'analyzing'), 240, null)).toMatchObject({ percent: null, speed: null, bytesWritten: null })
  })

  it('counts a finalizing job as done with its media work, whatever progress it carries', () =>
  {
    expect(runJobInput(job(1, 'finalizing'), 240, 180).percent).toBe(100)
    expect(runJobInput(job(1, 'finalizing', { progress: progress(90, { stage: 'place' }) }), 240, 180).percent).toBe(100)
  })
})

describe('createRunProgressFeed', () =>
{
  it('publishes nothing while no run is open', async () =>
  {
    const f = fake([job(1, 'done'), job(2, 'pending')], 'idle')
    const feed = createRunProgressFeed(f.deps)
    await turn()
    expect(feed.update()).toBeNull()
    expect(f.published).toEqual([])
  })

  it('counts finished jobs in full and running jobs by their percent', () =>
  {
    const f = fake([
      job(1, 'done'),
      job(2, 'done'),
      job(3, 'encoding', { progress: progress(40) }),
      job(4, 'queued'),
      job(5, 'queued'),
      job(6, 'queued')
    ])
    const feed = createRunProgressFeed(f.deps)
    expect(feed.update()?.percent).toBeCloseTo(40, 6)
    expect(f.published.at(-1)?.percent).toBeCloseTo(40, 6)
  })

  it('counts failed, canceled, skipped, held, and finalizing jobs in full and leaves out pending jobs and other runs', () =>
  {
    const f = fake([
      job(1, 'failed'),
      job(2, 'canceled'),
      job(3, 'skipped'),
      job(4, 'held'),
      job(5, 'finalizing'),
      job(6, 'queued'),
      job(7, 'pending'),
      job(8, 'done', { runId: 'B-0000' as RunId })
    ])
    const feed = createRunProgressFeed(f.deps)
    expect(feed.update()?.percent).toBeCloseTo((5 / 6) * 100, 6)
  })

  it('weighs each job by its planned media work', () =>
  {
    const f = fake([job(1, 'done', { durationSec: 60 }), job(2, 'queued', { durationSec: 180 })])
    const feed = createRunProgressFeed(f.deps)
    expect(feed.update()?.percent).toBeCloseTo(25, 6)
    const unplanned = fake([job(1, 'done', { durationSec: 60 }), job(2, 'queued', { plan: null })])
    expect(createRunProgressFeed(unplanned.deps).update()?.percent).toBeCloseTo(50, 6)
  })

  it('reads 100 once every job of the run has finished', () =>
  {
    const f = fake([job(1, 'done'), job(2, 'done', { durationSec: null })])
    expect(createRunProgressFeed(f.deps).update()?.percent).toBe(100)
  })

  it('schedules a first update when built, so a run restored at startup shows its progress before any event', async () =>
  {
    const f = fake([job(1, 'done'), job(2, 'queued')], 'paused')
    createRunProgressFeed(f.deps)
    expect(f.published).toEqual([])
    await turn()
    expect(f.published).toHaveLength(1)
    expect(f.published[0].percent).toBeCloseTo(50, 6)
    expect(f.published[0].etaSec).toBeNull()
  })

  it('updates once per turn after the events that move the run and ignores the rest', async () =>
  {
    const f = fake([job(1, 'encoding', { progress: progress(10) }), job(2, 'queued')])
    const feed = createRunProgressFeed(f.deps)
    await turn()
    f.published.length = 0
    const events: DraftEvent[] = [
      { type: 'run.progress', progress: f.published[0] as never },
      { type: 'workers.changed', workers: {} as never },
      { type: 'scan.progress', scan: {} as never }
    ]
    for (const event of events)
    {
      feed.observe(event)
    }
    await turn()
    expect(f.published).toEqual([])
    f.jobs[0] = { ...f.jobs[0], progress: progress(50) }
    feed.observe({ type: 'job.progress', jobId: f.jobs[0].id, progress: progress(30) })
    feed.observe({ type: 'job.progress', jobId: f.jobs[0].id, progress: progress(50) })
    feed.observe({ type: 'job.stage', jobId: f.jobs[0].id, rev: 2, stage: { id: 'verify', pass: 1, passes: 2, label: 'Verifying', startedAt: 0 } })
    await turn()
    expect(f.published).toHaveLength(1)
    expect(f.published[0].percent).toBeCloseTo(25, 6)
    for (const type of ['job.added', 'job.removed', 'job.updated', 'job.state', 'run.state'] as const)
    {
      feed.observe({ type } as DraftEvent)
      await turn()
    }
    expect(f.published).toHaveLength(6)
  })

  it('stops while idle and starts the clock afresh for the next run', async () =>
  {
    const f = fake([job(1, 'encoding', { progress: progress(50) })])
    const feed = createRunProgressFeed(f.deps)
    expect(feed.update()?.elapsedMs).toBe(0)
    f.advance(20_000)
    expect(feed.update()?.elapsedMs).toBe(20_000)
    f.setRun('idle')
    expect(feed.update()).toBeNull()
    f.setRun('running', 'B-0002' as RunId)
    f.jobs[0] = { ...f.jobs[0], runId: 'B-0002' as RunId }
    expect(feed.update()).toMatchObject({ elapsedMs: 0, percent: 50 })
    f.advance(5_000)
    expect(feed.update()?.elapsedMs).toBe(5_000)
    f.setRun('running', 'B-0003' as RunId)
    expect(feed.update()).toMatchObject({ elapsedMs: 0, percent: 0 })
  })

  it('reads media throughput from the running executions only', () =>
  {
    const mediaSecDone = vi.fn((id: JobId) => (id === 'MM-0001' ? 30 : null))
    const f = fake([job(1, 'encoding', { progress: progress(25, { speed: 2 }) }), job(2, 'done'), job(3, 'queued')], 'running', mediaSecDone)
    const feed = createRunProgressFeed(f.deps)
    feed.update()
    f.advance(10_000)
    mediaSecDone.mockImplementation((id: JobId) => (id === 'MM-0001' ? 50 : null))
    const later = feed.update()
    expect(later?.mediaSecPerSec).toBeCloseTo(2, 6)
    expect(later?.aggregateSpeed).toBe(2)
    expect(mediaSecDone).toHaveBeenCalledWith('MM-0001')
    expect(mediaSecDone).not.toHaveBeenCalledWith('MM-0002')
    expect(mediaSecDone).not.toHaveBeenCalledWith('MM-0003')
  })
})
