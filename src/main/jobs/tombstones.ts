/**
 * Removed and cleared jobs kept in memory for `jobs:restore`. Each remove or clear that takes jobs out of the queue
 * leaves one tombstone with their records, numbers, and queue positions. A tombstone can be restored once, for
 * 10 minutes or until 50 later remove and clear operations have pushed it out, whichever comes first; a restart ends
 * the window because nothing here is written to disk.
 */
import { randomUUID } from 'node:crypto'
import type { JobRefusal, PerJob } from '../../shared/jobs/contract'
import type { TimerHandle, Timers } from '../timers'
import type { JobQueue, RemovedJob } from './queue'

/** How long, and for how many remove and clear operations, a tombstone can be restored. */
export const TOMBSTONE_LIMITS = { ttlMs: 10 * 60 * 1000, operations: 50 } as const

/** The refusal for an expired, pushed out, already restored, or unknown tombstone. */
export const RESTORE_EXPIRED_MESSAGE = 'Cannot undo: removed jobs can be restored for 10 minutes.'

/** The operation that took the jobs out of the queue. */
export type TombstoneKind = 'remove' | 'clear'

/** One remove or clear operation's jobs, each with where it stood. */
export interface Tombstone
{
  id: string
  kind: TombstoneKind
  /** When the operation happened, on the timers' clock. */
  at: number
  entries: RemovedJob[]
}

/** What the tombstones need from the engine. */
export interface TombstoneDeps
{
  timers: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>
}

/** A refusal of a tombstone that can no longer be restored. */
export interface RestoreExpired
{
  ok: false
  code: 'restore-expired'
  message: string
}

/** A tombstone taken for restoring, or why it cannot be. */
export type TakeResult = { ok: true; tombstone: Tombstone } | RestoreExpired

/** The per-job outcome of putting a tombstone back into the queue, or why it cannot be. */
export type RestoreResult = { ok: true; value: PerJob } | RestoreExpired

interface Kept
{
  tombstone: Tombstone
  timer: TimerHandle
}

/** The tombstones of the last remove and clear operations, oldest first. */
export class Tombstones
{
  private readonly timers: TombstoneDeps['timers']
  private readonly kept = new Map<string, Kept>()
  private readonly session = randomUUID()
  private issued = 0

  constructor(deps: TombstoneDeps)
  {
    this.timers = deps.timers
  }

  /** How many tombstones are kept. */
  get size(): number
  {
    return this.kept.size
  }

  /**
   * Keeps the jobs one operation took out of the queue and returns the new tombstone's id, unique across sessions.
   * Null, with nothing kept, when the operation removed no job. Once more than 50 are kept the oldest is dropped.
   */
  record(kind: TombstoneKind, entries: readonly RemovedJob[]): string | null
  {
    if (entries.length === 0)
    {
      return null
    }
    this.issued += 1
    const id = `${this.session}-${this.issued}`
    const tombstone: Tombstone = { id, kind, at: this.timers.now(), entries: [...entries] }
    const timer = this.timers.setTimeout(() => this.drop(id), TOMBSTONE_LIMITS.ttlMs)
    this.kept.set(id, { tombstone, timer })
    for (const oldest of [...this.kept.keys()].slice(0, Math.max(0, this.kept.size - TOMBSTONE_LIMITS.operations)))
    {
      this.drop(oldest)
    }
    return id
  }

  /** Whether a tombstone can still be restored. */
  has(id: string): boolean
  {
    return this.live(id) !== null
  }

  /** A tombstone that can still be restored, without taking it, or null. */
  peek(id: string): Readonly<Tombstone> | null
  {
    return this.live(id)
  }

  /** Takes a tombstone for restoring, so it can be restored once; any id that names no live tombstone is refused. */
  take(id: string): TakeResult
  {
    const tombstone = this.live(id)
    if (tombstone === null)
    {
      return { ok: false, code: 'restore-expired', message: RESTORE_EXPIRED_MESSAGE }
    }
    this.drop(id)
    return { ok: true, tombstone }
  }

  /**
   * Takes a tombstone and puts its jobs back into the queue with their records, numbers, and positions. `applied`
   * lists the restored jobs in queue order; a job whose number is in the queue again is refused as a duplicate.
   */
  restore(queue: Pick<JobQueue, 'restore'>, id: string): RestoreResult
  {
    const taken = this.take(id)
    if (!taken.ok)
    {
      return taken
    }
    const applied = queue.restore(taken.tombstone.entries)
    const back = new Set(applied)
    const refused: JobRefusal[] = taken.tombstone.entries
      .filter((entry) => !back.has(entry.job.id))
      .map((entry) => ({ jobId: entry.job.id, code: 'duplicate', message: `${entry.job.id} is already in the queue.` }))
    return { ok: true, value: { applied, refused } }
  }

  /** Drops every tombstone and its timer, at shutdown. */
  dispose(): void
  {
    for (const id of [...this.kept.keys()])
    {
      this.drop(id)
    }
  }

  private live(id: string): Tombstone | null
  {
    const kept = this.kept.get(id)
    if (kept === undefined)
    {
      return null
    }
    if (this.timers.now() - kept.tombstone.at >= TOMBSTONE_LIMITS.ttlMs)
    {
      this.drop(id)
      return null
    }
    return kept.tombstone
  }

  private drop(id: string): void
  {
    const kept = this.kept.get(id)
    if (kept !== undefined)
    {
      this.timers.clearTimeout(kept.timer)
      this.kept.delete(id)
    }
  }
}
