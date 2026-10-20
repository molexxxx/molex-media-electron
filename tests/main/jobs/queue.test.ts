import { describe, it, expect } from 'vitest'
import { JobQueue, canonicalJson, type CatalogNumbers, type NewJob } from '../../../src/main/jobs/queue'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { JOB_STATES, type Job, type JobState, type SourceRef } from '../../../src/shared/jobs/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { JobId } from '../../../src/shared/jobs/ids'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

function recipe(id = 'mp4-h264'): Recipe
{
  return applyPreset(id, OUTPUT) as Recipe
}

function source(name: string, size = 1000): SourceRef
{
  return { path: `C:\\media\\${name}`, name, ext: '.mp4', dir: 'C:\\media', size, mtimeMs: 1700000000000, origin: 'files', subdir: '' }
}

function init(name: string): NewJob
{
  return { source: source(name), recipe: recipe() }
}

interface FakeNumbers extends CatalogNumbers
{
  next: number
  reserved: number
}

function numbers(start = 1, block = 100): FakeNumbers
{
  const fake: FakeNumbers =
  {
    next: start,
    reserved: start + block - 1,
    available: () => Math.max(0, fake.reserved - fake.next + 1),
    take: () => (fake.next <= fake.reserved ? fake.next++ : null)
  }
  return fake
}

function queueOf(count: number, options: { now?: number; block?: number } = {}): { queue: JobQueue; ids: JobId[]; numbers: FakeNumbers }
{
  const source = numbers(1, options.block ?? 100)
  const queue = new JobQueue({ numbers: source, now: () => options.now ?? 5000 })
  const created = queue.add(Array.from({ length: count }, (_, index) => init(`file-${index + 1}.mp4`))) ?? []
  return { queue, ids: created.map((job) => job.id), numbers: source }
}

function recount(jobs: readonly Readonly<Job>[]): Record<JobState, number>
{
  const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<JobState, number>
  for (const job of jobs)
  {
    counts[job.state] += 1
  }
  return counts
}

describe('canonicalJson', () =>
{
  it('gives equal text for equal data in any key order', () =>
  {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }))
      .toBe(canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
    expect(canonicalJson('text')).toBe('"text"')
  })
})

describe('JobQueue.add', () =>
{
  it('creates pending jobs on attempt 1 with rev and inputsRev at 1', () =>
  {
    const { queue, ids } = queueOf(1, { now: 1234 })
    const job = queue.get(ids[0]) as Job
    expect(job).toMatchObject({
      id: 'MM-0001', seq: 1, rev: 1, inputsRev: 1, state: 'pending', reason: 'user', attempt: 1, restarts: 0,
      execution: 0, probe: 'pending', plan: null, acknowledged: false, runId: null, rerunOf: null, addedAt: 1234
    })
    expect(job.attempts).toEqual([])
    expect(job.warnings).toEqual([])
  })

  it('gives jobs created in one millisecond distinct numbers in creation order', () =>
  {
    const { queue, ids } = queueOf(5, { now: 42 })
    expect(ids).toEqual(['MM-0001', 'MM-0002', 'MM-0003', 'MM-0004', 'MM-0005'])
    expect(new Set(queue.jobs().map((job) => job.seq)).size).toBe(5)
    expect(queue.jobs().every((job) => job.addedAt === 42)).toBe(true)
    const more = queue.add([init('again.mp4')]) as Job[]
    expect(more[0].id).toBe('MM-0006')
  })

  it('appends at the end, or after a given job', () =>
  {
    const { queue, ids } = queueOf(3)
    const [x] = queue.add([init('x.mp4')], ids[0]) as Job[]
    expect(queue.order()).toEqual([ids[0], x.id, ids[1], ids[2]])
    const [y, z] = queue.add([init('y.mp4'), init('z.mp4')], ids[2]) as Job[]
    expect(queue.order()).toEqual([ids[0], x.id, ids[1], ids[2], y.id, z.id])
    const [w] = queue.add([init('w.mp4')], 'MM-9999' as JobId) as Job[]
    expect(queue.order().at(-1)).toBe(w.id)
    expect(queue.indexOf(x.id)).toBe(1)
    expect(queue.size).toBe(7)
  })

  it('creates nothing when the reserved block holds too few numbers', () =>
  {
    const { queue, numbers: source } = queueOf(2, { block: 3 })
    const revision = queue.orderRev
    expect(queue.add([init('a.mp4'), init('b.mp4')])).toBeNull()
    expect(queue.size).toBe(2)
    expect(queue.orderRev).toBe(revision)
    expect(source.next).toBe(3)
    expect(queue.add([init('c.mp4')])?.map((job) => job.id)).toEqual(['MM-0003'])
  })

  it('never reissues a number a job in the queue already has', () =>
  {
    const source = numbers(1)
    const queue = new JobQueue({ numbers: source, now: () => 0 })
    queue.add([init('a.mp4'), init('b.mp4')])
    source.next = 1
    expect(queue.add([init('c.mp4')])?.map((job) => job.id)).toEqual(['MM-0003'])
  })

  it('creates nothing when the block runs out while skipping used numbers', () =>
  {
    const source = numbers(1, 3)
    const queue = new JobQueue({ numbers: source, now: () => 0 })
    queue.add([init('a.mp4'), init('b.mp4')])
    source.next = 2
    expect(queue.add([init('c.mp4'), init('d.mp4')])).toBeNull()
    expect(queue.size).toBe(2)
  })

  it('accepts an empty add without changing the order', () =>
  {
    const { queue } = queueOf(1)
    const revision = queue.orderRev
    expect(queue.add([])).toEqual([])
    expect(queue.orderRev).toBe(revision)
  })

  it('keeps the rerun origin of a new job', () =>
  {
    const { queue } = queueOf(0)
    const origin = { runId: 'R-0003', jobId: 'MM-0007' } as Job['rerunOf']
    const [job] = queue.add([{ ...init('a.mp4'), rerunOf: origin }]) as Job[]
    expect(job.rerunOf).toEqual(origin)
  })
})

describe('JobQueue.update', () =>
{
  it('increments rev on every change and leaves an unchanged record alone', () =>
  {
    const { queue, ids } = queueOf(1)
    expect(queue.update(ids[0], { probe: 'ok' })?.rev).toBe(2)
    expect(queue.update(ids[0], { probe: 'ok' })?.rev).toBe(2)
    expect(queue.update(ids[0], { probe: undefined, acknowledged: true })?.rev).toBe(3)
    expect(queue.get(ids[0])?.inputsRev).toBe(1)
  })

  it('increments inputsRev only when the recipe or the source changes in value', () =>
  {
    const { queue, ids } = queueOf(1)
    const id = ids[0]
    const same = JSON.parse(JSON.stringify(queue.get(id)?.recipe)) as Recipe
    expect(queue.update(id, { recipe: same })).toMatchObject({ rev: 2, inputsRev: 1 })
    expect(queue.update(id, { recipe: recipe('web-1080p') })).toMatchObject({ rev: 3, inputsRev: 2 })
    expect(queue.update(id, { source: source('file-1.mp4', 2000) })).toMatchObject({ rev: 4, inputsRev: 3 })
    expect(queue.update(id, { source: source('file-1.mp4', 2000) })).toMatchObject({ rev: 5, inputsRev: 3 })
  })

  it('increments inputsRev when asked, even without another change', () =>
  {
    const { queue, ids } = queueOf(1)
    expect(queue.update(ids[0], {}, { inputs: true })).toMatchObject({ rev: 2, inputsRev: 2 })
  })

  it('returns null for a job not in the queue', () =>
  {
    const { queue } = queueOf(1)
    expect(queue.update('MM-0404' as JobId, { probe: 'ok' })).toBeNull()
  })
})

describe('JobQueue.remove and restore', () =>
{
  it('removes jobs with their positions and the job that stayed above each', () =>
  {
    const { queue, ids } = queueOf(6)
    const revision = queue.orderRev
    const removed = queue.remove([ids[4], ids[1], ids[2], 'MM-0404' as JobId])
    expect(removed.map((entry) => [entry.job.id, entry.index, entry.after])).toEqual([
      [ids[1], 1, ids[0]],
      [ids[2], 2, ids[0]],
      [ids[4], 4, ids[3]]
    ])
    expect(queue.order()).toEqual([ids[0], ids[3], ids[5]])
    expect(queue.has(ids[1])).toBe(false)
    expect(queue.count('pending')).toBe(3)
    expect(queue.orderRev).toBe(revision + 1)
    expect(queue.remove(['MM-0404' as JobId])).toEqual([])
    expect(queue.orderRev).toBe(revision + 1)
  })

  it('restores jobs with their numbers, records, and positions', () =>
  {
    const { queue, ids } = queueOf(6)
    queue.update(ids[2], { state: 'done', acknowledged: true })
    const removed = queue.remove([ids[0], ids[2], ids[3], ids[5]])
    expect(removed[0].after).toBeNull()
    expect(queue.restore(removed)).toEqual([ids[0], ids[2], ids[3], ids[5]])
    expect(queue.order()).toEqual(ids)
    expect(queue.get(ids[2])).toMatchObject({ id: ids[2], seq: 3, state: 'done', acknowledged: true })
    expect(queue.counts()).toEqual(recount(queue.jobs()))
  })

  it('puts a run back after its job when the queue changed meanwhile', () =>
  {
    const { queue, ids } = queueOf(5)
    const removed = queue.remove([ids[2], ids[3]])
    queue.move([ids[1]], 'bottom')
    expect(queue.order()).toEqual([ids[0], ids[4], ids[1]])
    queue.restore(removed)
    expect(queue.order()).toEqual([ids[0], ids[4], ids[1], ids[2], ids[3]])
  })

  it('falls back to the old index when the job above is gone', () =>
  {
    const { queue, ids } = queueOf(5)
    const first = queue.remove([ids[1]])
    const second = queue.remove([ids[2]])
    expect(second[0].after).toBe(ids[0])
    queue.remove([ids[0]])
    queue.restore(second)
    expect(queue.order()).toEqual([ids[3], ids[2], ids[4]])
    queue.restore(first)
    expect(queue.order()).toEqual([ids[3], ids[1], ids[2], ids[4]])
  })

  it('skips a job whose number is in the queue again', () =>
  {
    const { queue, ids } = queueOf(3)
    const removed = queue.remove([ids[1]])
    queue.restore(removed)
    const revision = queue.orderRev
    expect(queue.restore(removed)).toEqual([])
    expect(queue.orderRev).toBe(revision)
    expect(queue.size).toBe(3)
  })

  it('puts the rest of a run after a job of it that is already back', () =>
  {
    const { queue, ids } = queueOf(5)
    const removed = queue.remove([ids[1], ids[2], ids[3]])
    queue.restore([removed[0]])
    expect(queue.restore(removed)).toEqual([ids[2], ids[3]])
    expect(queue.order()).toEqual(ids)
  })
})

describe('JobQueue moves', () =>
{
  it('moves a job up and down one place', () =>
  {
    const { queue, ids } = queueOf(6)
    expect(queue.move([ids[2]], 'up')).toEqual({ applied: [ids[2]], refused: [], changed: true })
    expect(queue.order()).toEqual([ids[0], ids[2], ids[1], ids[3], ids[4], ids[5]])
    expect(queue.move([ids[2]], 'down').changed).toBe(true)
    expect(queue.order()).toEqual(ids)
  })

  it('gathers a scattered selection when it moves up or down', () =>
  {
    const up = queueOf(6)
    up.queue.move([up.ids[3], up.ids[1]], 'up')
    expect(up.queue.order()).toEqual([up.ids[1], up.ids[3], up.ids[0], up.ids[2], up.ids[4], up.ids[5]])
    const down = queueOf(6)
    down.queue.move([down.ids[1], down.ids[3]], 'down')
    expect(down.queue.order()).toEqual([down.ids[0], down.ids[2], down.ids[4], down.ids[1], down.ids[3], down.ids[5]])
  })

  it('moves jobs to the top and the bottom', () =>
  {
    const { queue, ids } = queueOf(6)
    queue.move([ids[4]], 'top')
    expect(queue.order()).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3], ids[5]])
    queue.move([ids[4], ids[0]], 'bottom')
    expect(queue.order()).toEqual([ids[1], ids[2], ids[3], ids[5], ids[4], ids[0]])
  })

  it('runs a job next: ahead of every other pending or queued job, below the running and finished ones', () =>
  {
    const { queue, ids } = queueOf(6)
    queue.update(ids[0], { state: 'done' })
    queue.update(ids[1], { state: 'encoding' })
    queue.update(ids[2], { state: 'queued' })
    queue.update(ids[3], { state: 'queued' })
    queue.update(ids[5], { state: 'queued' })
    queue.move([ids[5]], 'run-next')
    expect(queue.order()).toEqual([ids[0], ids[1], ids[5], ids[2], ids[3], ids[4]])
    queue.move([ids[4]], 'top')
    expect(queue.order()).toEqual([ids[4], ids[0], ids[1], ids[5], ids[2], ids[3]])
  })

  it('moves only pending and queued jobs and refuses the rest', () =>
  {
    const { queue, ids } = queueOf(6)
    queue.update(ids[0], { state: 'done' })
    queue.update(ids[1], { state: 'encoding' })
    queue.update(ids[2], { state: 'queued' })
    const result = queue.move([ids[0], ids[1], 'MM-0404' as JobId, ids[2], ids[2]], 'bottom')
    expect(result.applied).toEqual([ids[2]])
    expect(result.refused.map((refusal) => [refusal.jobId, refusal.code])).toEqual([
      [ids[0], 'not-movable'],
      [ids[1], 'not-movable'],
      ['MM-0404', 'not-found']
    ])
    expect(result.refused.every((refusal) => refusal.message.length > 0)).toBe(true)
    expect(queue.order()).toEqual([ids[0], ids[1], ids[3], ids[4], ids[5], ids[2]])
    for (const state of ['analyzing', 'verifying', 'finalizing', 'held', 'failed', 'canceled', 'skipped', 'interrupted'] as const)
    {
      queue.update(ids[3], { state })
      expect(queue.move([ids[3]], 'top').refused[0]?.code).toBe('not-movable')
    }
  })

  it('reports no change, and keeps orderRev, when a move changes nothing', () =>
  {
    const { queue, ids } = queueOf(4)
    const revision = queue.orderRev
    expect(queue.move([ids[0]], 'up').changed).toBe(false)
    expect(queue.move([ids[0], ids[1]], 'top').changed).toBe(false)
    expect(queue.move([ids[3]], 'down').changed).toBe(false)
    expect(queue.move([ids[3]], 'bottom').changed).toBe(false)
    expect(queue.move(ids, 'top').changed).toBe(false)
    expect(queue.move(ids, 'up').changed).toBe(false)
    expect(queue.move(['MM-0404' as JobId], 'top')).toMatchObject({ applied: [], changed: false })
    expect(queue.orderRev).toBe(revision)
  })

  it('runs nothing next when no other job waits', () =>
  {
    const { queue, ids } = queueOf(3)
    queue.update(ids[0], { state: 'done' })
    queue.update(ids[1], { state: 'done' })
    expect(queue.move([ids[2]], 'run-next').changed).toBe(false)
    expect(queue.order()).toEqual(ids)
  })

  it('reorders before a job or to the end, keeping relative order', () =>
  {
    const { queue, ids } = queueOf(6)
    expect(queue.reorder([ids[4], ids[1]], ids[0])).toMatchObject({ applied: [ids[1], ids[4]], changed: true })
    expect(queue.order()).toEqual([ids[1], ids[4], ids[0], ids[2], ids[3], ids[5]])
    queue.reorder([ids[1]], null)
    expect(queue.order()).toEqual([ids[4], ids[0], ids[2], ids[3], ids[5], ids[1]])
    expect(queue.reorder([ids[0]], 'MM-0404' as JobId)).toBeNull()
  })

  it('reorders before the next unmoved job when the anchor is itself moved', () =>
  {
    const { queue, ids } = queueOf(6)
    queue.reorder([ids[5], ids[2]], ids[2])
    expect(queue.order()).toEqual([ids[0], ids[1], ids[2], ids[5], ids[3], ids[4]])
    queue.reorder([ids[4]], ids[4])
    expect(queue.order()).toEqual([ids[0], ids[1], ids[2], ids[5], ids[3], ids[4]])
  })

  it('refuses a reorder of jobs that are not waiting or queued', () =>
  {
    const { queue, ids } = queueOf(3)
    queue.update(ids[2], { state: 'failed' })
    const result = queue.reorder([ids[2]], ids[0])
    expect(result).toMatchObject({ applied: [], changed: false })
    expect(result?.refused[0]?.code).toBe('not-movable')
    expect(queue.order()).toEqual(ids)
  })
})

describe('JobQueue reservations', () =>
{
  it('claims output keys for queued, active, and held jobs only', () =>
  {
    const { queue, ids } = queueOf(2)
    expect(queue.reserve(ids[0], ['c:\\out\\a.mp4'])).toEqual({ ok: false, reason: 'not-reserving', conflicts: [] })
    expect(queue.reserve('MM-0404' as JobId, ['k'])).toEqual({ ok: false, reason: 'not-found', conflicts: [] })
    for (const state of ['queued', 'analyzing', 'encoding', 'verifying', 'finalizing', 'held'] as const)
    {
      queue.update(ids[0], { state })
      expect(queue.reserve(ids[0], ['c:\\out\\a.mp4']).ok).toBe(true)
      expect(queue.holderOf('c:\\out\\a.mp4')).toBe(ids[0])
    }
  })

  it('refuses a key another job holds, all or nothing', () =>
  {
    const { queue, ids } = queueOf(2)
    queue.update(ids[0], { state: 'queued' })
    queue.update(ids[1], { state: 'queued' })
    queue.reserve(ids[0], ['a', 'b'])
    expect(queue.reserve(ids[1], ['c', 'b', 'a'])).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ key: 'b', holder: ids[0] }, { key: 'a', holder: ids[0] }]
    })
    expect(queue.holderOf('c')).toBeNull()
    expect(queue.reservedBy(ids[1])).toEqual([])
  })

  it('replaces a job\'s claims and releases them on demand', () =>
  {
    const { queue, ids } = queueOf(1)
    queue.update(ids[0], { state: 'queued' })
    queue.reserve(ids[0], ['a', 'b', 'a'])
    expect(queue.reservedBy(ids[0])).toEqual(['a', 'b'])
    queue.reserve(ids[0], ['b', 'c'])
    expect(queue.reservedBy(ids[0])).toEqual(['b', 'c'])
    expect(queue.holderOf('a')).toBeNull()
    expect(queue.release(ids[0])).toEqual(['b', 'c'])
    expect(queue.holderOf('b')).toBeNull()
    queue.reserve(ids[0], [])
    expect(queue.reservedBy(ids[0])).toEqual([])
  })

  it('releases a job\'s claims when it leaves the reserving states or the queue', () =>
  {
    const { queue, ids } = queueOf(3)
    for (const id of ids)
    {
      queue.update(id, { state: 'queued' })
      queue.reserve(id, [`key-${id}`])
    }
    queue.update(ids[0], { state: 'encoding' })
    expect(queue.holderOf(`key-${ids[0]}`)).toBe(ids[0])
    queue.update(ids[0], { state: 'done' })
    expect(queue.holderOf(`key-${ids[0]}`)).toBeNull()
    queue.update(ids[1], { state: 'pending' })
    expect(queue.holderOf(`key-${ids[1]}`)).toBeNull()
    queue.remove([ids[2]])
    expect(queue.holderOf(`key-${ids[2]}`)).toBeNull()
  })
})

describe('JobQueue.hydrate', () =>
{
  it('loads jobs in the stored order, then the rest by number, and rebuilds the counts', () =>
  {
    const { queue: source, ids } = queueOf(4)
    source.update(ids[3], { state: 'held' })
    const jobs = source.jobs().map((job) => structuredClone(job) as Job)
    const target = new JobQueue({ numbers: numbers(10), now: () => 0 })
    target.add([init('stale.mp4')])
    target.hydrate([...jobs, jobs[0]], [ids[2], 'MM-0999' as JobId, ids[0]])
    expect(target.order()).toEqual([ids[2], ids[0], ids[1], ids[3]])
    expect(target.has('MM-0010' as JobId)).toBe(false)
    expect(target.counts()).toEqual(recount(target.jobs()))
    expect(target.count('held')).toBe(1)
  })
})

describe('JobQueue counts', () =>
{
  it('keeps counts per state in step with every change', () =>
  {
    const { queue, ids } = queueOf(4)
    expect(queue.count('pending')).toBe(4)
    queue.update(ids[0], { state: 'queued' })
    queue.update(ids[1], { state: 'queued' })
    queue.update(ids[1], { state: 'encoding' })
    queue.update(ids[2], { state: 'done' })
    expect(queue.counts()).toEqual(recount(queue.jobs()))
    expect(queue.counts()).toMatchObject({ pending: 1, queued: 1, encoding: 1, done: 1, failed: 0 })
    const counts = queue.counts()
    counts.pending = 99
    expect(queue.count('pending')).toBe(1)
  })
})
