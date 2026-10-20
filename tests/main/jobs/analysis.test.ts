import { describe, it, expect, vi } from 'vitest'
import {
  ANALYSIS_CACHE_LIMIT,
  AnalysisCache,
  AnalysisTasks,
  type AnalysisContext,
  type AnalysisOutcome
} from '../../../src/main/jobs/analysis'
import { AlbumTasks } from '../../../src/main/jobs/album'
import { EMPTY_OCCUPANCY, countOccupancy, planDispatch } from '../../../src/main/jobs/dispatch'
import { measureKey, type MeasureSpec } from '../../../src/main/ffmpeg/audio/measure'
import type { AudioAnalysis } from '../../../src/shared/audio/events'
import type { MediaFacts, PlanReason } from '../../../src/shared/audio/types'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { JobMeasurement } from '../../../src/shared/jobs/types'

type AudioJobInput = Parameters<typeof measureKey>[0]

const id = (n: number): JobId => `J${String(n).padStart(4, '0')}` as JobId

function analysis(key: string, measuredAt = 1000): AudioAnalysis
{
  return { cacheKey: key, facts: {} as MediaFacts, source: [], afterDynamics: null, measuredAt }
}

function measurement(): JobMeasurement
{
  return { pass: 'source', measuredAt: 1000, streams: [], album: null, messages: [] }
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

const keyOf = (jobId: JobId): string => `key-${jobId}`

function harness()
{
  const outcomes: AnalysisOutcome[] = []
  const calls: Array<{ jobId: JobId; context: AnalysisContext; result: Deferred<AudioAnalysis> }> = []
  const analyze = vi.fn((jobId: JobId, context: AnalysisContext) =>
  {
    const result = deferred<AudioAnalysis>()
    calls.push({ jobId, context, result })
    return result.promise
  })
  const plan = vi.fn((_jobId: JobId, _analysis: AudioAnalysis) => measurement())
  const tasks = new AnalysisTasks({ analyze, plan, onSettled: (outcome) => outcomes.push(outcome) })
  const finish = async (index: number): Promise<void> =>
  {
    calls[index].result.resolve(analysis(keyOf(calls[index].jobId)))
    await flush()
  }
  return { tasks, outcomes, calls, analyze, plan, finish }
}

describe('AnalysisCache', () =>
{
  it('keeps analyses by their measure key', () =>
  {
    const cache = new AnalysisCache()
    cache.set(analysis('a'))
    expect(cache.get('a')?.cacheKey).toBe('a')
    expect(cache.get('b')).toBeNull()
    cache.delete('a')
    expect(cache.size).toBe(0)
    expect(ANALYSIS_CACHE_LIMIT).toBe(2000)
  })

  it('drops the least recently used entry past its limit', () =>
  {
    const cache = new AnalysisCache(2)
    cache.set(analysis('a'))
    cache.set(analysis('b'))
    cache.get('a')
    cache.set(analysis('c'))
    expect(cache.get('b')).toBeNull()
    expect(cache.get('a')).not.toBeNull()
    cache.set(analysis('c', 2000))
    expect(cache.size).toBe(2)
    expect(cache.get('c')?.measuredAt).toBe(2000)
    expect(new AnalysisCache(0).size).toBe(0)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  describe('under measureKey', () =>
  {
    const specs = [{ audioIndex: 0, pre: [], dualMono: false, weights: 'anull', shortTerm: false, dialogue: false }] as unknown as MeasureSpec[]
    const job = (overrides: Record<string, unknown> = {}): AudioJobInput =>
      ({ sourcePath: 'C:/stems/drums.wav', sourceSize: 4096, sourceMtimeMs: 1700000000000, ...overrides }) as unknown as AudioJobInput

    it('keeps two files with identical size and modification time apart', () =>
    {
      const cache = new AnalysisCache()
      const drums = measureKey(job(), 'n9.0.2', specs)
      const bass = measureKey(job({ sourcePath: 'C:/stems/bass.wav' }), 'n9.0.2', specs)
      cache.set(analysis(drums))
      cache.set(analysis(bass))
      expect(cache.size).toBe(2)
    })

    it('misses after an FFmpeg build change', () =>
    {
      const cache = new AnalysisCache()
      cache.set(analysis(measureKey(job(), 'n9.0.2', specs)))
      expect(cache.get(measureKey(job(), '2022-10-13', specs))).toBeNull()
    })

    it('hits after an output codec change', () =>
    {
      const cache = new AnalysisCache()
      cache.set(analysis(measureKey(job({ codec: 'aac' }), 'n9.0.2', specs)))
      expect(cache.get(measureKey(job({ codec: 'libopus' }), 'n9.0.2', specs))).not.toBeNull()
    })
  })
})

describe('analysis requests', () =>
{
  it('keeps one request per job at a time, in request order', () =>
  {
    const { tasks } = harness()
    expect(tasks.request([id(1), id(2)])).toEqual([id(1), id(2)])
    expect(tasks.request([id(2), id(3)])).toEqual([id(3)])
    expect(tasks.pending()).toEqual([id(1), id(2), id(3)])
    expect(tasks.state(id(1))).toBe('pending')
    expect(tasks.state(id(9))).toBeNull()
  })

  it('runs in spare slots, at most two at a time', () =>
  {
    const { tasks } = harness()
    tasks.request([id(1), id(2), id(3)])
    const limits = { total: 16, videoCpu: 2, gpu: 4 }
    const first = planDispatch([], tasks.pending(), countOccupancy(tasks.slots()), limits)
    expect(first.analysis).toEqual([id(1), id(2)])
    for (const jobId of first.analysis) expect(tasks.start(jobId)).toBe(true)
    expect(tasks.slots()).toEqual([{ kind: 'analysis', class: 'audio' }, { kind: 'analysis', class: 'audio' }])
    expect(planDispatch([], tasks.pending(), countOccupancy(tasks.slots()), limits).analysis).toEqual([])
    expect(tasks.running()).toEqual([id(1), id(2)])
    expect(tasks.pending()).toEqual([id(3)])
  })

  it('takes slots only after queued jobs', () =>
  {
    const { tasks } = harness()
    tasks.request([id(5)])
    const queued = [{ id: id(1), class: 'audio' as const, waiting: null }]
    expect(planDispatch(queued, tasks.pending(), EMPTY_OCCUPANCY, { total: 1, videoCpu: 1, gpu: 0 })).toEqual({ jobs: [id(1)], analysis: [] })
  })

  it('refuses to start a job without a pending request', () =>
  {
    const { tasks } = harness()
    expect(tasks.start(id(1))).toBe(false)
    tasks.request([id(1)])
    expect(tasks.start(id(1))).toBe(true)
    expect(tasks.start(id(1))).toBe(false)
  })

  it('measures, caches, and lands a preview measurement', async () =>
  {
    const { tasks, calls, outcomes, plan, finish } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    expect(calls[0].jobId).toBe(id(1))
    await finish(0)
    expect(plan).toHaveBeenCalledWith(id(1), expect.objectContaining({ cacheKey: keyOf(id(1)) }))
    expect(outcomes).toEqual([{ kind: 'measured', jobId: id(1), measurement: { ...measurement(), pass: 'preview' }, analysis: analysis(keyOf(id(1))) }])
    expect(tasks.cache.get(keyOf(id(1)))).not.toBeNull()
    expect(tasks.state(id(1))).toBeNull()
    expect(tasks.slots()).toEqual([])
  })

  it('offers the cache to the analysis, so a hit skips the measure', async () =>
  {
    const { tasks, calls } = harness()
    tasks.store(analysis('known'))
    tasks.request([id(1)])
    tasks.start(id(1))
    expect(calls[0].context.cached('known')?.cacheKey).toBe('known')
    expect(calls[0].context.cached('other')).toBeNull()
  })

  it('reports a failed analysis and caches nothing', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    const error = new Error('refused')
    calls[0].result.reject(error)
    await flush()
    expect(outcomes).toEqual([{ kind: 'failed', jobId: id(1), error }])
    expect(tasks.cache.size).toBe(0)
    expect(tasks.state(id(1))).toBeNull()
  })

  it('reports a failed gain plan but keeps the analysis', async () =>
  {
    const { tasks, plan, outcomes, finish } = harness()
    plan.mockImplementationOnce(() =>
    {
      throw new Error('plan')
    })
    tasks.request([id(1)])
    tasks.start(id(1))
    await finish(0)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['failed'])
    expect(tasks.cache.size).toBe(1)
  })
})

describe('analysis aborts', () =>
{
  it('kills the child, caches nothing, and drops the request on cancel', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.request([id(1), id(2)])
    tasks.start(id(1))
    expect(tasks.cancel(id(1))).toBe(true)
    expect(tasks.cancel(id(2))).toBe(true)
    expect(tasks.cancel(id(3))).toBe(false)
    expect(calls[0].context.signal.aborted).toBe(true)
    calls[0].result.resolve(analysis(keyOf(id(1))))
    await flush()
    expect(outcomes).toEqual([])
    expect(tasks.cache.size).toBe(0)
    expect(tasks.pending()).toEqual([])
    expect(tasks.slots()).toEqual([])
  })

  it('ignores a failure that arrives after a cancel', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    tasks.cancel(id(1))
    calls[0].result.reject(new Error('killed'))
    await flush()
    expect(outcomes).toEqual([])
  })

  it('lets running tasks finish through "Pause" and starts no new ones', async () =>
  {
    const { tasks, outcomes, finish } = harness()
    tasks.request([id(1), id(2)])
    tasks.start(id(1))
    tasks.pause('finish-running')
    expect(tasks.pending()).toEqual([])
    expect(tasks.start(id(2))).toBe(false)
    await finish(0)
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['measured'])
    tasks.request([id(3)])
    expect(tasks.pending()).toEqual([])
    tasks.resume()
    expect(tasks.pending()).toEqual([id(2), id(3)])
  })

  it('stops running tasks through "Pause now" and restarts them on resume', async () =>
  {
    const { tasks, calls, outcomes } = harness()
    tasks.request([id(1), id(2)])
    tasks.start(id(1))
    tasks.pause('stop-running')
    expect(calls[0].context.signal.aborted).toBe(true)
    expect(outcomes).toEqual([{ kind: 'stopped', jobId: id(1) }])
    expect(tasks.state(id(1))).toBe('stopped')
    expect(tasks.slots()).toEqual([])
    calls[0].result.resolve(analysis(keyOf(id(1))))
    await flush()
    expect(tasks.cache.size).toBe(0)
    tasks.resume()
    expect(tasks.pending()).toEqual([id(1), id(2)])
    expect(tasks.start(id(1))).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('stops running tasks on quit now', () =>
  {
    const { tasks, calls } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    tasks.quitNow()
    expect(calls[0].context.signal.aborted).toBe(true)
    expect(tasks.state(id(1))).toBe('stopped')
  })

  it('keeps nothing across recovery', async () =>
  {
    const { tasks, calls } = harness()
    tasks.store(analysis('known'))
    tasks.request([id(1), id(2)])
    tasks.start(id(1))
    tasks.pause('finish-running')
    tasks.clear()
    expect(calls[0].context.signal.aborted).toBe(true)
    expect(tasks.cache.size).toBe(0)
    expect(tasks.state(id(2))).toBeNull()
    tasks.request([id(3)])
    expect(tasks.pending()).toEqual([id(3)])
  })
})

describe('a dispatched job and its analysis', () =>
{
  it('completes the measure stage at once from the cache', async () =>
  {
    const { tasks, analyze } = harness()
    tasks.store(analysis(keyOf(id(1))))
    expect((await tasks.forJob(id(1), keyOf(id(1)), new AbortController().signal))?.cacheKey).toBe(keyOf(id(1)))
    expect(analyze).not.toHaveBeenCalled()
  })

  it('waits for a running task instead of starting a second child', async () =>
  {
    const { tasks, analyze, finish } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    tasks.claimed(id(1))
    expect(tasks.state(id(1))).toBe('running')
    const shared = tasks.forJob(id(1), keyOf(id(1)), new AbortController().signal)
    await finish(0)
    expect((await shared)?.cacheKey).toBe(keyOf(id(1)))
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('measures itself when the running task measured other settings', async () =>
  {
    const { tasks, finish } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    const shared = tasks.forJob(id(1), 'changed', new AbortController().signal)
    await finish(0)
    expect(await shared).toBeNull()
  })

  it('drops a request still waiting for a slot', async () =>
  {
    const { tasks } = harness()
    tasks.request([id(1), id(2)])
    tasks.claimed(id(1))
    expect(tasks.state(id(1))).toBeNull()
    expect(await tasks.forJob(id(2), keyOf(id(2)), new AbortController().signal)).toBeNull()
    expect(tasks.state(id(2))).toBeNull()
    expect(await tasks.forJob(id(3), keyOf(id(3)), new AbortController().signal)).toBeNull()
  })

  it('stops waiting when its own signal aborts or the task is canceled', async () =>
  {
    const { tasks } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    const controller = new AbortController()
    const waiting = tasks.forJob(id(1), keyOf(id(1)), controller.signal)
    controller.abort()
    expect(await waiting).toBeNull()
    expect(await tasks.forJob(id(1), keyOf(id(1)), controller.signal)).toBeNull()
    const second = tasks.forJob(id(1), keyOf(id(1)), new AbortController().signal)
    tasks.cancel(id(1))
    expect(await second).toBeNull()
  })

  it('stores what the job measured itself', () =>
  {
    const { tasks } = harness()
    tasks.store(analysis('own'))
    expect(tasks.cache.get('own')).not.toBeNull()
  })
})

describe('album members and analysis tasks', () =>
{
  it('reuses a running preview analysis for an album member', async () =>
  {
    const { tasks, analyze, finish } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    const obtained = tasks.obtain(id(1), new AbortController().signal)
    await finish(0)
    expect((await obtained).cacheKey).toBe(keyOf(id(1)))
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('runs in the album slot, reading and filling the cache, and drops a pending request', async () =>
  {
    const { tasks, calls } = harness()
    tasks.request([id(1)])
    const obtained = tasks.obtain(id(1), new AbortController().signal)
    await flush()
    expect(tasks.state(id(1))).toBeNull()
    expect(tasks.request([id(1)])).toEqual([])
    calls[0].result.resolve(analysis('album-key'))
    expect((await obtained).cacheKey).toBe('album-key')
    expect(tasks.cache.get('album-key')).not.toBeNull()
    expect(tasks.request([id(1)])).toEqual([id(1)])
  })

  it('runs again when the shared task ended without a result, and caches nothing after an abort', async () =>
  {
    const { tasks, calls } = harness()
    tasks.request([id(1)])
    tasks.start(id(1))
    const controller = new AbortController()
    const obtained = tasks.obtain(id(1), controller.signal)
    await flush()
    tasks.cancel(id(1))
    await flush()
    expect(calls).toHaveLength(2)
    controller.abort()
    calls[1].result.resolve(analysis('late'))
    expect((await obtained).cacheKey).toBe('late')
    expect(tasks.cache.get('late')).toBeNull()
  })

  it('passes a failure to the album task', async () =>
  {
    const { tasks, calls } = harness()
    const obtained = tasks.obtain(id(1), new AbortController().signal)
    calls[0].result.reject(new Error('decode'))
    await expect(obtained).rejects.toThrow('decode')
    expect(tasks.request([id(1)])).toEqual([id(1)])
  })

  it('wires into an album task as its analyze function', async () =>
  {
    const { tasks, calls } = harness()
    const settled: string[] = []
    const album = new AlbumTasks({
      analyze: (jobId, signal) => tasks.obtain(jobId, signal),
      plan: (members) => ({
        anchorJobId: members[0].jobId,
        anchorLufs: -14,
        gainDb: 0,
        reason: 'album' as unknown as PlanReason,
        plans: []
      }),
      onSettled: (outcome) => settled.push(outcome.kind)
    })
    tasks.store(analysis(keyOf(id(2))))
    album.register('g', [id(1), id(2)])
    album.claim(id(1))
    await flush()
    calls[0].result.resolve(analysis(keyOf(id(1))))
    await flush()
    expect(calls[1].context.cached(keyOf(id(2)))).not.toBeNull()
    calls[1].result.resolve(calls[1].context.cached(keyOf(id(2))) as AudioAnalysis)
    await flush()
    expect(settled).toEqual(['planned'])
  })
})
