import { describe, it, expect } from 'vitest'
import {
  DISPATCH_HOLDS,
  EMPTY_OCCUPANCY,
  JOB_CLASSES,
  MAX_ANALYSIS_TASKS,
  countOccupancy,
  dispatchCandidates,
  occupy,
  planDispatch,
  planIsCurrent,
  selectAnalysis,
  selectDispatch,
  workerLimits,
  workersActive,
  type CandidateContext,
  type DispatchCandidate,
  type JobClass,
  type Occupancy,
  type QueuedJob,
  type Slot,
  type WorkerLimits
} from '../../../src/main/jobs/dispatch'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { Job } from '../../../src/shared/jobs/types'

const id = (n: number): JobId => `J${String(n).padStart(4, '0')}` as JobId

function candidate(n: number, jobClass: JobClass, waiting: Job['waiting'] = null): DispatchCandidate
{
  return { id: id(n), class: jobClass, waiting }
}

function queued(n: number, overrides: Partial<QueuedJob> = {}): QueuedJob
{
  return {
    id: id(n),
    state: 'queued',
    inputsRev: 1,
    waiting: null,
    plan: { basis: { inputsRev: 1, policyRev: 3, capabilitiesRev: 7 }, class: 'audio' },
    ...overrides
  }
}

const context = (overrides: Partial<CandidateContext> = {}): CandidateContext => ({
  policyRev: 3,
  capabilitiesRev: 7,
  claimed: new Set<JobId>(),
  ...overrides
})

const limits = (total: number, videoCpu: number, gpu: number): WorkerLimits => ({ total, videoCpu, gpu })

function occupancyOf(slots: Slot[]): Occupancy
{
  return countOccupancy(slots)
}

describe('workerLimits', () =>
{
  it('gives auto every logical core, an eighth of them for CPU video, and the GPU budget', () =>
  {
    expect(workerLimits({ mode: 'auto' }, 16, 4)).toEqual({ total: 16, videoCpu: 2, gpu: 4 })
    expect(workerLimits({ mode: 'auto' }, 4, 2)).toEqual({ total: 4, videoCpu: 1, gpu: 2 })
    expect(workerLimits({ mode: 'auto' }, 0, 2)).toEqual({ total: 1, videoCpu: 1, gpu: 2 })
  })

  it('gives a fixed count to every class, the GPU capped by its budget', () =>
  {
    expect(workerLimits({ mode: 'fixed', count: 6 }, 16, 4)).toEqual({ total: 6, videoCpu: 6, gpu: 4 })
    expect(workerLimits({ mode: 'fixed', count: 3 }, 16, 4)).toEqual({ total: 3, videoCpu: 3, gpu: 3 })
  })

  it('clamps a fixed count to 1 through 64 and a budget to zero or more', () =>
  {
    expect(workerLimits({ mode: 'fixed', count: 0 }, 16, 4)).toEqual({ total: 1, videoCpu: 1, gpu: 1 })
    expect(workerLimits({ mode: 'fixed', count: 500 }, 16, 16)).toEqual({ total: 64, videoCpu: 64, gpu: 16 })
    expect(workerLimits({ mode: 'auto' }, 8, -1).gpu).toBe(0)
  })
})

describe('occupancy', () =>
{
  it('counts every slot in its class and in the total', () =>
  {
    const occupancy = occupancyOf([
      { kind: 'job', class: 'audio' },
      { kind: 'job', class: 'copy' },
      { kind: 'job', class: 'video-cpu' },
      { kind: 'claim', class: 'video-gpu' },
      { kind: 'album', class: 'audio' },
      { kind: 'analysis', class: 'audio' }
    ])
    expect(occupancy).toEqual({ total: 6, audio: 3, copy: 1, videoCpu: 1, gpu: 1, analysis: 1, starting: 1 })
  })

  it('reports claims in starting and the class totals in WorkersState.active', () =>
  {
    const occupancy = occupancyOf([{ kind: 'claim', class: 'audio' }, { kind: 'claim', class: 'video-cpu' }])
    expect(workersActive(occupancy)).toEqual({ total: 2, videoCpu: 1, gpu: 0, analysis: 0, starting: 2 })
  })

  it('leaves the input untouched', () =>
  {
    const next = occupy(EMPTY_OCCUPANCY, { kind: 'job', class: 'copy' })
    expect(EMPTY_OCCUPANCY.total).toBe(0)
    expect(next.copy).toBe(1)
    expect(JOB_CLASSES).toEqual(['audio', 'copy', 'video-cpu', 'video-gpu'])
  })
})

describe('selectDispatch', () =>
{
  it('fills the total in queue order', () =>
  {
    const picked = selectDispatch([candidate(1, 'audio'), candidate(2, 'copy'), candidate(3, 'audio')], EMPTY_OCCUPANCY, limits(2, 1, 1))
    expect(picked).toEqual([id(1), id(2)])
  })

  it('applies the CPU video and GPU class limits', () =>
  {
    const candidates = [
      candidate(1, 'video-cpu'),
      candidate(2, 'video-cpu'),
      candidate(3, 'video-gpu'),
      candidate(4, 'video-gpu'),
      candidate(5, 'video-gpu')
    ]
    expect(selectDispatch(candidates, EMPTY_OCCUPANCY, limits(16, 1, 2))).toEqual([id(1), id(3), id(4)])
  })

  it('does not let a class held at its limit block other classes', () =>
  {
    const occupancy = occupancyOf([{ kind: 'job', class: 'video-gpu' }, { kind: 'job', class: 'video-cpu' }])
    const candidates = [candidate(1, 'video-gpu'), candidate(2, 'video-cpu'), candidate(3, 'audio'), candidate(4, 'copy')]
    expect(selectDispatch(candidates, occupancy, limits(8, 1, 1))).toEqual([id(3), id(4)])
  })

  it('keeps each class first in, first out', () =>
  {
    const candidates = [candidate(1, 'video-cpu'), candidate(2, 'audio'), candidate(3, 'video-cpu'), candidate(4, 'video-cpu')]
    expect(selectDispatch(candidates, EMPTY_OCCUPANCY, limits(8, 2, 0))).toEqual([id(1), id(2), id(3)])
  })

  it('skips held jobs and picks the next of the same class', () =>
  {
    const candidates = [
      candidate(1, 'audio', 'album'),
      candidate(2, 'audio', 'disk-space'),
      candidate(3, 'copy', 'volume-offline'),
      candidate(4, 'audio'),
      candidate(5, 'copy')
    ]
    expect(selectDispatch(candidates, EMPTY_OCCUPANCY, limits(8, 1, 1))).toEqual([id(4), id(5)])
    expect([...DISPATCH_HOLDS].sort()).toEqual(['album', 'disk-space', 'volume-offline'])
  })

  it('treats a job waiting for a GPU session as a candidate when a session is free', () =>
  {
    expect(selectDispatch([candidate(1, 'video-gpu', 'gpu-session')], EMPTY_OCCUPANCY, limits(4, 1, 1))).toEqual([id(1)])
    expect(selectDispatch([candidate(1, 'video-gpu', 'gpu-session')], EMPTY_OCCUPANCY, limits(4, 1, 0))).toEqual([])
  })

  it('counts claims and album and analysis tasks against the total', () =>
  {
    const occupancy = occupancyOf([
      { kind: 'claim', class: 'audio' },
      { kind: 'album', class: 'audio' },
      { kind: 'analysis', class: 'audio' }
    ])
    expect(selectDispatch([candidate(1, 'audio'), candidate(2, 'audio')], occupancy, limits(4, 1, 1))).toEqual([id(1)])
    expect(selectDispatch([candidate(1, 'audio')], occupancy, limits(3, 1, 1))).toEqual([])
  })

  it('counts a claimed GPU job against the GPU limit', () =>
  {
    const occupancy = occupancyOf([{ kind: 'claim', class: 'video-gpu' }])
    expect(selectDispatch([candidate(2, 'video-gpu')], occupancy, limits(4, 1, 1))).toEqual([])
  })

  it('never picks one job twice', () =>
  {
    expect(selectDispatch([candidate(1, 'audio'), candidate(1, 'audio')], EMPTY_OCCUPANCY, limits(4, 1, 1))).toEqual([id(1)])
  })

  it('picks nothing when the total is already full', () =>
  {
    const occupancy = occupancyOf([{ kind: 'job', class: 'copy' }])
    expect(selectDispatch([candidate(1, 'audio')], occupancy, limits(1, 1, 1))).toEqual([])
  })

  it('never starts more than the total over consecutive turns', () =>
  {
    const queue = Array.from({ length: 10 }, (_, i) => queued(i + 1))
    const claimed = new Set<JobId>()
    let occupancy: Occupancy = { ...EMPTY_OCCUPANCY }
    for (let turn = 0; turn < 3; turn++)
    {
      const picked = selectDispatch(dispatchCandidates(queue, context({ claimed })), occupancy, limits(4, 1, 1))
      for (const job of picked)
      {
        claimed.add(job)
        occupancy = occupy(occupancy, { kind: 'claim', class: 'audio' })
      }
    }
    expect([...claimed]).toEqual([id(1), id(2), id(3), id(4)])
    expect(occupancy.starting).toBe(4)
  })
})

describe('dispatchCandidates', () =>
{
  it('lists queued jobs with a plan in queue order', () =>
  {
    const queue = [queued(1), queued(2, { state: 'pending' }), queued(3, { plan: null }), queued(4, { state: 'encoding' }), queued(5)]
    expect(dispatchCandidates(queue, context()).map((c) => c.id)).toEqual([id(1), id(5)])
  })

  it('leaves out claimed jobs', () =>
  {
    expect(dispatchCandidates([queued(1), queued(2)], context({ claimed: new Set([id(1)]) })).map((c) => c.id)).toEqual([id(2)])
  })

  it('takes only jobs whose plan basis is current', () =>
  {
    const stale = [
      queued(1, { inputsRev: 2 }),
      queued(2, { plan: { basis: { inputsRev: 1, policyRev: 2, capabilitiesRev: 7 }, class: 'audio' } }),
      queued(3, { plan: { basis: { inputsRev: 1, policyRev: 3, capabilitiesRev: 6 }, class: 'audio' } }),
      queued(4)
    ]
    expect(dispatchCandidates(stale, context()).map((c) => c.id)).toEqual([id(4)])
    expect(planIsCurrent(queued(1), context())).toBe(true)
    expect(planIsCurrent(queued(1, { plan: null }), context())).toBe(false)
    expect(planIsCurrent(queued(1), context({ policyRev: 4 }))).toBe(false)
  })

  it('carries the waiting reason and keeps waiting jobs in position', () =>
  {
    const queue = [queued(1, { waiting: 'disk-space' }), queued(2), queued(3, { waiting: 'gpu-session' })]
    expect(dispatchCandidates(queue, context())).toEqual([
      { id: id(1), class: 'audio', waiting: 'disk-space' },
      { id: id(2), class: 'audio', waiting: null },
      { id: id(3), class: 'audio', waiting: 'gpu-session' }
    ])
  })

  it('applies class and waiting overrides', () =>
  {
    const gpu = queued(1, { plan: { basis: { inputsRev: 1, policyRev: 3, capabilitiesRev: 7 }, class: 'video-gpu' } })
    const member = queued(2)
    const candidates = dispatchCandidates([gpu, member], context({
      classOf: (job) => (job.id === id(1) ? 'video-cpu' : job.plan!.class),
      waitingOf: (job) => (job.id === id(2) ? 'album' : undefined)
    }))
    expect(candidates).toEqual([
      { id: id(1), class: 'video-cpu', waiting: null },
      { id: id(2), class: 'audio', waiting: 'album' }
    ])
  })

  it('lets an outside hold clear a waiting reason the job record still shows', () =>
  {
    const member = queued(1, { waiting: 'album' })
    expect(dispatchCandidates([member], context({ waitingOf: () => null }))[0].waiting).toBeNull()
    expect(dispatchCandidates([member], context({ waitingOf: () => undefined }))[0].waiting).toBe('album')
  })
})

describe('analysis slots', () =>
{
  it('runs at most two analysis tasks', () =>
  {
    expect(MAX_ANALYSIS_TASKS).toBe(2)
    expect(selectAnalysis([id(1), id(2), id(3)], EMPTY_OCCUPANCY, limits(16, 2, 4))).toEqual([id(1), id(2)])
    const one = occupancyOf([{ kind: 'analysis', class: 'audio' }])
    expect(selectAnalysis([id(2), id(3)], one, limits(16, 2, 4))).toEqual([id(2)])
    const two = occupancyOf([{ kind: 'analysis', class: 'audio' }, { kind: 'analysis', class: 'audio' }])
    expect(selectAnalysis([id(3)], two, limits(16, 2, 4))).toEqual([])
  })

  it('uses only slots the total has left', () =>
  {
    const occupancy = occupancyOf([{ kind: 'job', class: 'audio' }, { kind: 'job', class: 'audio' }])
    expect(selectAnalysis([id(1), id(2)], occupancy, limits(3, 1, 1))).toEqual([id(1)])
    expect(selectAnalysis([id(1), id(1)], EMPTY_OCCUPANCY, limits(3, 1, 1))).toEqual([id(1)])
  })

  it('gives analysis only the slots left after queued jobs', () =>
  {
    const choice = planDispatch([candidate(1, 'audio'), candidate(2, 'audio')], [id(8), id(9)], EMPTY_OCCUPANCY, limits(3, 1, 1))
    expect(choice).toEqual({ jobs: [id(1), id(2)], analysis: [id(8)] })
    const full = planDispatch([candidate(1, 'audio'), candidate(2, 'copy')], [id(8)], EMPTY_OCCUPANCY, limits(2, 1, 1))
    expect(full).toEqual({ jobs: [id(1), id(2)], analysis: [] })
  })

  it('lets analysis use a slot a class limit leaves free', () =>
  {
    const occupancy = occupancyOf([{ kind: 'job', class: 'video-gpu' }])
    const choice = planDispatch([candidate(1, 'video-gpu')], [id(8)], occupancy, limits(4, 1, 1))
    expect(choice).toEqual({ jobs: [], analysis: [id(8)] })
  })

  it('does not start an analysis for a job picked in the same turn', () =>
  {
    const choice = planDispatch([candidate(1, 'audio')], [id(1), id(2)], EMPTY_OCCUPANCY, limits(4, 1, 1))
    expect(choice).toEqual({ jobs: [id(1)], analysis: [id(2)] })
  })
})
