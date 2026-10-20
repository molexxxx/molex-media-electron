import { describe, it, expect, vi } from 'vitest'
import {
  AlbumTasks,
  albumMeasurement,
  albumSummary,
  type AlbumMemberAnalysis,
  type AlbumOutcome
} from '../../../src/main/jobs/album'
import { countOccupancy, dispatchCandidates, selectDispatch, type QueuedJob } from '../../../src/main/jobs/dispatch'
import type { AudioAnalysis, StreamMeasurement } from '../../../src/shared/audio/events'
import type { GainPlan, MediaFacts, PlanReason } from '../../../src/shared/audio/types'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { AlbumPlan } from '../../../src/main/ffmpeg/audio/plan'

const id = (n: number): JobId => `J${String(n).padStart(4, '0')}` as JobId
const GROUP = 'album-1'

function stream(audioIndex: number, integrated: number): StreamMeasurement
{
  return {
    audioIndex,
    layout: 'stereo',
    channels: 2,
    sampleRate: 48000,
    stats: { integratedLufs: integrated } as unknown as StreamMeasurement['stats'],
    loudnessToDialogueLu: null
  }
}

function analysis(jobId: JobId, integrated = -20): AudioAnalysis
{
  return {
    cacheKey: `key-${jobId}`,
    facts: {} as MediaFacts,
    source: [stream(0, integrated)],
    afterDynamics: null,
    measuredAt: 1000
  }
}

function gain(audioIndex: number, gainDb: number): GainPlan
{
  return { audioIndex, gainDb } as unknown as GainPlan
}

function albumPlan(members: readonly AlbumMemberAnalysis[]): AlbumPlan
{
  return {
    anchorJobId: members[0].jobId,
    anchorLufs: -12,
    gainDb: -2,
    reason: 'album' as unknown as PlanReason,
    plans: members.map((member) => ({ jobId: member.jobId, plan: gain(0, -2) }))
  }
}

interface Deferred<T>
{
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T>
{
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) =>
  {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async (): Promise<void> =>
{
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function harness(plan: (members: readonly AlbumMemberAnalysis[]) => AlbumPlan = albumPlan)
{
  const outcomes: AlbumOutcome[] = []
  const calls: Array<{ jobId: JobId; signal: AbortSignal; result: Deferred<AudioAnalysis> }> = []
  let running = 0
  let peak = 0
  const analyze = vi.fn((jobId: JobId, signal: AbortSignal) =>
  {
    const result = deferred<AudioAnalysis>()
    running += 1
    peak = Math.max(peak, running)
    calls.push({ jobId, signal, result })
    return result.promise.finally(() =>
    {
      running -= 1
    })
  })
  const planSpy = vi.fn(plan)
  const tasks = new AlbumTasks({ analyze, plan: planSpy, onSettled: (outcome) => outcomes.push(outcome) })
  const finish = async (index: number, value?: AudioAnalysis): Promise<void> =>
  {
    await flush()
    calls[index].result.resolve(value ?? analysis(calls[index].jobId))
    await flush()
  }
  return { tasks, outcomes, calls, analyze, planSpy, finish, peak: (): number => peak }
}

const members = [id(1), id(2), id(3)]

describe('album task lifecycle', () =>
{
  it('starts in the first claimed member slot and holds every member', async () =>
  {
    const { tasks, calls } = harness()
    tasks.register(GROUP, members)
    expect(tasks.waitingOf(id(2))).toBeNull()
    expect(tasks.claim(id(2))).toEqual({ kind: 'started', groupId: GROUP, waiting: members })
    expect(tasks.phase(GROUP)).toBe('measuring')
    expect(tasks.slots()).toEqual([{ kind: 'album', class: 'audio' }])
    for (const member of members) expect(tasks.waitingOf(member)).toBe('album')
    expect(tasks.claim(id(3))).toEqual({ kind: 'waiting', groupId: GROUP })
    expect(calls).toHaveLength(0)
    await flush()
    expect(calls.map((call) => call.jobId)).toEqual([id(1)])
  })

  it('analyzes every member one at a time, then plans over all of them', async () =>
  {
    const { tasks, calls, finish, planSpy, outcomes, peak } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    await finish(0)
    await finish(1)
    expect(planSpy).not.toHaveBeenCalled()
    await finish(2)
    expect(peak()).toBe(1)
    expect(calls.map((call) => call.jobId)).toEqual(members)
    expect(planSpy.mock.calls[0][0].map((member) => member.jobId)).toEqual(members)
    const summary = { groupId: GROUP, members: 3, anchorJobId: id(1), anchorLufs: -12, gainDb: -2, reason: 'album' }
    expect(outcomes).toEqual([{ kind: 'planned', groupId: GROUP, summary, ready: members }])
    expect(tasks.phase(GROUP)).toBe('planned')
    expect(tasks.summary(GROUP)).toEqual(summary)
    expect(tasks.slots()).toEqual([])
    expect(tasks.waitingOf(id(2))).toBeNull()
  })

  it('gives each member its plan from the album plan and the group summary', async () =>
  {
    const { tasks, finish } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    for (let i = 0; i < 3; i++) await finish(i)
    const claim = tasks.claim(id(2))
    expect(claim.kind).toBe('ready')
    if (claim.kind !== 'ready') return
    expect(claim.handle.groupId).toBe(GROUP)
    expect(claim.handle.members).toBe(3)
    const measurement = await claim.handle.measurement(new AbortController().signal)
    expect(measurement).toMatchObject({
      pass: 'source',
      measuredAt: 1000,
      album: { groupId: GROUP, anchorJobId: id(1), gainDb: -2 },
      streams: [{ measurement: { audioIndex: 0 }, plan: { audioIndex: 0, gainDb: -2 } }]
    })
  })

  it('never deadlocks with one worker: members wait without holding the slot', async () =>
  {
    const { tasks, finish } = harness()
    tasks.register(GROUP, members)
    const queue: QueuedJob[] = members.map((member) => ({
      id: member,
      state: 'queued',
      inputsRev: 0,
      waiting: null,
      plan: { basis: { inputsRev: 0, policyRev: 0, capabilitiesRev: 0 }, class: 'audio' }
    }))
    const limits = { total: 1, videoCpu: 1, gpu: 0 }
    const pick = (): JobId[] => selectDispatch(
      dispatchCandidates(queue, { policyRev: 0, capabilitiesRev: 0, claimed: new Set(), waitingOf: (job) => tasks.waitingOf(job.id) }),
      countOccupancy(tasks.slots()),
      limits
    )
    expect(pick()).toEqual([id(1)])
    expect(tasks.claim(id(1)).kind).toBe('started')
    expect(pick()).toEqual([])
    for (let i = 0; i < 3; i++) await finish(i)
    expect(pick()).toEqual([id(1)])
    expect(tasks.claim(id(1)).kind).toBe('ready')
  })

  it('answers a claim outside every group with none', () =>
  {
    const { tasks } = harness()
    expect(tasks.claim(id(9))).toEqual({ kind: 'none' })
    expect(tasks.waitingOf(id(9))).toBeUndefined()
    expect(tasks.handle(id(9))).toBeNull()
    expect(tasks.groupOf(id(9))).toBeNull()
    expect(tasks.phase('missing')).toBeNull()
    expect(tasks.summary('missing')).toBeNull()
  })
})

describe('album task table', () =>
{
  it('continues when a member leaves while another is queued', async () =>
  {
    const { tasks, calls, finish, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    tasks.memberLeft(id(2))
    expect(calls).toHaveLength(0)
    for (let i = 0; i < 3; i++) await finish(i)
    expect(calls.map((call) => call.jobId)).toEqual(members)
    expect(outcomes).toEqual([expect.objectContaining({ kind: 'planned', ready: [id(1), id(3)] })])
    expect(outcomes[0].kind === 'planned' && outcomes[0].summary.members).toBe(3)
  })

  it('aborts when no member remains', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    await flush()
    for (const member of members) tasks.memberLeft(member)
    expect(calls[0].signal.aborted).toBe(true)
    expect(outcomes).toEqual([{ kind: 'aborted', groupId: GROUP }])
    expect(tasks.slots()).toEqual([])
    expect(tasks.phase(GROUP)).toBeNull()
    calls[0].result.resolve(analysis(id(1)))
    await flush()
    expect(outcomes).toHaveLength(1)
  })

  it('drops an idle group silently when every member leaves', () =>
  {
    const { tasks, outcomes } = harness()
    tasks.register(GROUP, [id(1)])
    tasks.memberLeft(id(1))
    tasks.memberLeft(id(1))
    expect(tasks.phase(GROUP)).toBeNull()
    expect(outcomes).toEqual([])
  })

  it('keeps a planned group when members leave', async () =>
  {
    const { tasks, finish } = harness()
    tasks.register(GROUP, [id(1)])
    tasks.claim(id(1))
    await finish(0)
    tasks.memberLeft(id(1))
    expect(tasks.phase(GROUP)).toBe('planned')
  })

  it('runs to completion through "Pause"', async () =>
  {
    const { tasks, finish, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    tasks.pause('finish-running')
    for (let i = 0; i < 3; i++) await finish(i)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['planned'])
  })

  it('stops and discards through "Pause now", and runs again on resume', async () =>
  {
    const { tasks, calls, finish, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    await finish(0)
    tasks.pause('stop-running')
    expect(calls[1].signal.aborted).toBe(true)
    expect(outcomes).toEqual([{ kind: 'stopped', groupId: GROUP, waiting: members }])
    expect(tasks.phase(GROUP)).toBe('idle')
    expect(tasks.slots()).toEqual([])
    expect(tasks.waitingOf(id(1))).toBeNull()
    calls[1].result.resolve(analysis(id(2)))
    await flush()
    expect(outcomes).toHaveLength(1)
    expect(tasks.claim(id(3)).kind).toBe('started')
    for (let i = 2; i < 5; i++) await finish(i)
    expect(calls.slice(2).map((call) => call.jobId)).toEqual(members)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['stopped', 'planned'])
  })

  it('stops through quit now and leaves idle and planned groups alone', async () =>
  {
    const { tasks, finish, outcomes } = harness()
    tasks.register('done', [id(7)])
    tasks.claim(id(7))
    await finish(0)
    tasks.register('idle', [id(8)])
    tasks.stopAll()
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['planned'])
    expect(tasks.phase('done')).toBe('planned')
    expect(tasks.phase('idle')).toBe('idle')
  })

  it('cancels the members when the run is canceled', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.register('other', [id(5)])
    tasks.claim(id(1))
    await flush()
    tasks.cancelRun()
    expect(calls[0].signal.aborted).toBe(true)
    expect(outcomes).toEqual([{ kind: 'canceled', groupId: GROUP, cancel: members }])
    expect(tasks.phase(GROUP)).toBeNull()
    expect(tasks.phase('other')).toBeNull()
    expect(tasks.groupOf(id(1))).toBeNull()
  })

  it('fails every queued member when an analysis fails or is refused', async () =>
  {
    const { tasks, calls, outcomes, planSpy } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    tasks.memberLeft(id(3))
    await flush()
    const error = new Error('refused')
    calls[0].result.reject(error)
    await flush()
    expect(planSpy).not.toHaveBeenCalled()
    expect(outcomes).toEqual([{ kind: 'failed', groupId: GROUP, code: 'album-measure-failed', fail: [id(1), id(2)], error }])
    expect(tasks.phase(GROUP)).toBe('failed')
    expect(tasks.claim(id(2))).toEqual({ kind: 'failed', groupId: GROUP })
    expect(tasks.waitingOf(id(2))).toBeNull()
    tasks.memberLeft(id(2))
    expect(tasks.phase(GROUP)).toBe('failed')
  })

  it('fails the group when the album plan throws', async () =>
  {
    const { tasks, finish, outcomes } = harness(() =>
    {
      throw new Error('mismatch')
    })
    tasks.register(GROUP, [id(1)])
    tasks.claim(id(1))
    await finish(0)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['failed'])
  })

  it('keeps nothing across a crash, and a restored group runs again', async () =>
  {
    const { tasks, calls, finish, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    await flush()
    tasks.clear()
    expect(calls[0].signal.aborted).toBe(true)
    expect(tasks.phase(GROUP)).toBeNull()
    expect(outcomes).toEqual([])
    tasks.register(GROUP, members)
    expect(tasks.claim(id(2)).kind).toBe('started')
    for (let i = 1; i < 4; i++) await finish(i)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['planned'])
  })
})

describe('album registration and handles', () =>
{
  it('replaces a group registered again and discards its running task', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.register(GROUP, members)
    tasks.claim(id(1))
    await flush()
    tasks.register(GROUP, [id(1), id(1), id(2)])
    expect(calls[0].signal.aborted).toBe(true)
    expect(tasks.phase(GROUP)).toBe('idle')
    expect(tasks.groupOf(id(3))).toBeNull()
    expect(outcomes).toEqual([])
    tasks.register('empty', [])
    expect(tasks.phase('empty')).toBeNull()
  })

  it('moves a member registered into another group', () =>
  {
    const { tasks } = harness()
    tasks.register('a', [id(1), id(2)])
    tasks.register('b', [id(2), id(3)])
    expect(tasks.groupOf(id(2))).toBe('b')
    tasks.memberLeft(id(1))
    expect(tasks.phase('a')).toBeNull()
    expect(tasks.groupOf(id(2))).toBe('b')
  })

  it('lets a handle wait for the plan, and an abort answer null', async () =>
  {
    const { tasks, finish } = harness()
    tasks.register(GROUP, [id(1), id(2)])
    tasks.claim(id(1))
    const handle = tasks.handle(id(2))!
    const waiting = handle.measurement(new AbortController().signal)
    const controller = new AbortController()
    const aborted = handle.measurement(controller.signal)
    controller.abort()
    expect(await aborted).toBeNull()
    expect(await handle.measurement(controller.signal)).toBeNull()
    await finish(0)
    await finish(1)
    expect((await waiting)?.album?.groupId).toBe(GROUP)
  })

  it('answers null from a handle whose group stopped or failed', async () =>
  {
    const { tasks, calls } = harness()
    tasks.register(GROUP, [id(1)])
    tasks.claim(id(1))
    const handle = tasks.handle(id(1))!
    const waiting = handle.measurement(new AbortController().signal)
    await flush()
    calls[0].result.reject(new Error('decode'))
    expect(await waiting).toBeNull()
    expect(await handle.measurement(new AbortController().signal)).toBeNull()
  })

  it('answers null from a waiting handle when its group is dropped', async () =>
  {
    const { tasks } = harness()
    tasks.register(GROUP, [id(1)])
    tasks.claim(id(1))
    const waiting = tasks.handle(id(1))!.measurement(new AbortController().signal)
    tasks.cancelRun()
    expect(await waiting).toBeNull()
  })
})

describe('albumMeasurement', () =>
{
  it('plans only the stream the album plan names', () =>
  {
    const source = { ...analysis(id(1)), source: [stream(0, -20), stream(1, -18)] }
    const plan: AlbumPlan = { anchorJobId: id(1), anchorLufs: -18, gainDb: -4, reason: 'album' as unknown as PlanReason, plans: [{ jobId: id(1), plan: gain(1, -4) }] }
    const summary = albumSummary(GROUP, 1, plan)
    const measurement = albumMeasurement(id(1), source, plan, summary)
    expect(measurement.streams.map((entry) => entry.plan?.gainDb ?? null)).toEqual([null, -4])
    expect(albumMeasurement(id(2), source, plan, summary).streams.every((entry) => entry.plan === null)).toBe(true)
    expect(measurement.messages).toEqual([])
  })
})
