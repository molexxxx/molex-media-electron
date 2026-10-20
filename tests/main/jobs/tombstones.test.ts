import { describe, it, expect } from 'vitest'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { RESTORE_EXPIRED_MESSAGE, TOMBSTONE_LIMITS, Tombstones } from '../../../src/main/jobs/tombstones'
import { applyPreset } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { JobId } from '../../../src/shared/jobs/ids'
import type { SourceRef } from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy
const MINUTE = 60 * 1000

function source(name: string): SourceRef
{
  return { path: `C:\\media\\${name}`, name, ext: '.mp4', dir: 'C:\\media', size: 1000, mtimeMs: 1700000000000, origin: 'files', subdir: '' }
}

function numbers(): CatalogNumbers
{
  let next = 1
  return { available: () => 1000 - next + 1, take: () => (next <= 1000 ? next++ : null) }
}

function setup(count = 6): { queue: JobQueue; ids: JobId[]; timers: ReturnType<typeof createManualTimers>; tombstones: Tombstones }
{
  const timers = createManualTimers(1_000_000)
  const queue = new JobQueue({ numbers: numbers(), now: () => timers.now() })
  const recipe = applyPreset('mp4-h264', OUTPUT) as Recipe
  const created = queue.add(Array.from({ length: count }, (_, index) => ({ source: source(`file-${index + 1}.mp4`), recipe }))) ?? []
  return { queue, ids: created.map((job) => job.id), timers, tombstones: new Tombstones({ timers }) }
}

describe('Tombstones.record', () =>
{
  it('keeps nothing and names no tombstone when an operation removed no job', () =>
  {
    const { tombstones, timers } = setup()
    expect(tombstones.record('remove', [])).toBeNull()
    expect(tombstones.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('names each tombstone with a distinct id and keeps the operation kind and time', () =>
  {
    const { queue, ids, tombstones, timers } = setup()
    const first = tombstones.record('remove', queue.remove([ids[0]])) as string
    const second = tombstones.record('clear', queue.remove([ids[1], ids[2]])) as string
    expect(first).not.toBe(second)
    expect(tombstones.size).toBe(2)
    expect(tombstones.peek(first)).toMatchObject({ id: first, kind: 'remove', at: 1_000_000 })
    expect(tombstones.peek(second)?.entries.map((entry) => entry.job.id)).toEqual([ids[1], ids[2]])
    expect(tombstones.has(second)).toBe(true)
    expect(timers.pending()).toBe(2)
  })

  it('gives ids that differ between sessions', () =>
  {
    const a = setup()
    const b = setup()
    const one = a.tombstones.record('remove', a.queue.remove([a.ids[0]]))
    const other = b.tombstones.record('remove', b.queue.remove([b.ids[0]]))
    expect(one).not.toBe(other)
  })
})

describe('Tombstones.restore', () =>
{
  it('restores removed jobs within 10 minutes with their numbers, records, and positions', async () =>
  {
    const { queue, ids, timers, tombstones } = setup()
    const before = queue.jobs().map((job) => ({ ...job }))
    queue.update(ids[3], { acknowledged: true, warnings: [] })
    const kept = queue.get(ids[3])
    const id = tombstones.record('remove', queue.remove([ids[1], ids[3], ids[4]])) as string
    expect(queue.order()).toEqual([ids[0], ids[2], ids[5]])
    await timers.advance(TOMBSTONE_LIMITS.ttlMs - 1)
    const result = tombstones.restore(queue, id)
    expect(result).toEqual({ ok: true, value: { applied: [ids[1], ids[3], ids[4]], refused: [] } })
    expect(queue.order()).toEqual(ids)
    expect(queue.get(ids[3])).toBe(kept)
    expect(queue.get(ids[3])?.acknowledged).toBe(true)
    expect(queue.jobs().map((job) => job.seq)).toEqual(before.map((job) => job.seq))
    expect(queue.get(ids[1])?.recipe).toEqual(before[1].recipe)
    expect(tombstones.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })

  it('restores cleared jobs the same way', () =>
  {
    const { queue, ids, tombstones } = setup(3)
    const id = tombstones.record('clear', queue.remove(ids)) as string
    expect(queue.size).toBe(0)
    expect(tombstones.restore(queue, id)).toEqual({ ok: true, value: { applied: ids, refused: [] } })
    expect(queue.order()).toEqual(ids)
  })

  it('refuses a tombstone after 10 minutes with restore-expired', async () =>
  {
    const { queue, ids, timers, tombstones } = setup()
    const id = tombstones.record('remove', queue.remove([ids[0]])) as string
    await timers.advance(TOMBSTONE_LIMITS.ttlMs)
    expect(tombstones.size).toBe(0)
    expect(tombstones.has(id)).toBe(false)
    expect(tombstones.restore(queue, id)).toEqual({ ok: false, code: 'restore-expired', message: RESTORE_EXPIRED_MESSAGE })
    expect(queue.has(ids[0])).toBe(false)
  })

  it('treats a tombstone as expired at 10 minutes even before its timer runs', () =>
  {
    let now = 0
    const timers = { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined }
    const queue = new JobQueue({ numbers: numbers(), now: () => now })
    const recipe = applyPreset('mp4-h264', OUTPUT) as Recipe
    const [job] = queue.add([{ source: source('a.mp4'), recipe }]) ?? []
    const tombstones = new Tombstones({ timers })
    const id = tombstones.record('remove', queue.remove([job.id])) as string
    now = 10 * MINUTE - 1
    expect(tombstones.peek(id)).not.toBeNull()
    now = 10 * MINUTE
    expect(tombstones.peek(id)).toBeNull()
    expect(tombstones.size).toBe(0)
    expect(tombstones.take(id)).toMatchObject({ ok: false, code: 'restore-expired' })
  })

  it('keeps a tombstone through 49 later operations and drops it at the 50th', () =>
  {
    const { queue, ids, timers, tombstones } = setup(60)
    const first = tombstones.record('remove', queue.remove([ids[0]])) as string
    const later: string[] = []
    for (let index = 1; index < TOMBSTONE_LIMITS.operations; index += 1)
    {
      later.push(tombstones.record(index % 2 === 0 ? 'clear' : 'remove', queue.remove([ids[index]])) as string)
    }
    expect(tombstones.size).toBe(50)
    expect(tombstones.has(first)).toBe(true)
    later.push(tombstones.record('remove', queue.remove([ids[50]])) as string)
    expect(tombstones.size).toBe(50)
    expect(timers.pending()).toBe(50)
    expect(tombstones.restore(queue, first)).toMatchObject({ ok: false, code: 'restore-expired' })
    expect(tombstones.restore(queue, later[0])).toEqual({ ok: true, value: { applied: [ids[1]], refused: [] } })
    expect(queue.order().slice(0, 2)).toEqual([ids[1], ids[51]])
  })

  it('restores a tombstone only once', () =>
  {
    const { queue, ids, tombstones } = setup()
    const id = tombstones.record('remove', queue.remove([ids[2]])) as string
    expect(tombstones.restore(queue, id).ok).toBe(true)
    expect(tombstones.restore(queue, id)).toMatchObject({ ok: false, code: 'restore-expired' })
  })

  it('refuses an unknown tombstone with restore-expired', () =>
  {
    const { queue, tombstones } = setup()
    expect(tombstones.restore(queue, 'nothing')).toEqual({ ok: false, code: 'restore-expired', message: RESTORE_EXPIRED_MESSAGE })
    expect(tombstones.has('nothing')).toBe(false)
    expect(tombstones.peek('nothing')).toBeNull()
  })

  it('refuses a job whose number is in the queue again as a duplicate', () =>
  {
    const { queue, ids, tombstones } = setup()
    const entries = queue.remove([ids[1], ids[2]])
    const id = tombstones.record('remove', entries) as string
    queue.restore([entries[0]])
    const result = tombstones.restore(queue, id)
    expect(result).toEqual({
      ok: true,
      value: { applied: [ids[2]], refused: [{ jobId: ids[1], code: 'duplicate', message: `${ids[1]} is already in the queue.` }] }
    })
    expect(queue.order()).toEqual(ids)
  })
})

describe('Tombstones.take and dispose', () =>
{
  it('takes a tombstone with its entries and cancels its timer', () =>
  {
    const { queue, ids, timers, tombstones } = setup()
    const id = tombstones.record('clear', queue.remove([ids[4]])) as string
    const taken = tombstones.take(id)
    expect(taken.ok && taken.tombstone.entries.map((entry) => entry.job.id)).toEqual([ids[4]])
    expect(timers.pending()).toBe(0)
    expect(tombstones.size).toBe(0)
  })

  it('drops every tombstone and timer at shutdown', () =>
  {
    const { queue, ids, timers, tombstones } = setup()
    tombstones.record('remove', queue.remove([ids[0]]))
    tombstones.record('clear', queue.remove([ids[1]]))
    tombstones.dispose()
    expect(tombstones.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })
})
