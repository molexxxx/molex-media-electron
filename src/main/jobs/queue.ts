/**
 * The engine's ordered job store: every job by catalog number in queue order, the rev and inputsRev bookkeeping,
 * counts per state kept in step with every change, moves of waiting jobs, and the in-memory output reservations
 * that keep two queued, active, or held jobs from writing the same path.
 */
import type { JobRefusal } from '../../shared/jobs/contract'
import { formatCatalog, type JobId } from '../../shared/jobs/ids'
import type { Recipe } from '../../shared/jobs/recipes'
import { JOB_STATES, type Job, type JobCounts, type JobState, type SourceRef } from '../../shared/jobs/types'

/** The states in which a job may be moved. */
export const MOVABLE_STATES: readonly JobState[] = ['pending', 'queued']

/** The states whose output paths stay reserved in memory. */
export const RESERVING_STATES: readonly JobState[] = ['queued', 'analyzing', 'encoding', 'verifying', 'finalizing', 'held']

/** A move of the selected jobs in queue order; the moved jobs keep their relative order and end up together. */
export type QueueMove = 'up' | 'down' | 'top' | 'bottom' | 'run-next'

/** The source of catalog numbers: the durably reserved block of the catalog sequence. */
export interface CatalogNumbers
{
  /** How many numbers can be issued before another block must be reserved. */
  available(): number
  /** The next reserved number, or null when the block is used up. */
  take(): number | null
}

/** What the queue needs from the engine. */
export interface QueueDeps
{
  numbers: CatalogNumbers
  /** Milliseconds since the Unix epoch. */
  now(): number
}

/** What a new job starts from; everything else starts empty, pending, and on attempt 1. */
export interface NewJob
{
  source: SourceRef
  recipe: Recipe
  rerunOf?: Job['rerunOf']
}

/** The fields a change may set; id and seq never change, and the queue keeps rev and inputsRev. */
export type JobChange = Partial<Omit<Job, 'id' | 'seq' | 'rev' | 'inputsRev'>>

/** A job taken out of the queue with where it stood, so a restore can put it back. */
export interface RemovedJob
{
  job: Job
  /** Its index in the order before the removal. */
  index: number
  /** The nearest job above it that stayed in the queue, or null when none did. */
  after: JobId | null
}

/** The per-job outcome of a move. */
export interface MoveResult
{
  applied: JobId[]
  refused: JobRefusal[]
  /** Whether the order changed. */
  changed: boolean
}

/** Another job's claim on an output path key. */
export interface ReservationConflict
{
  key: string
  holder: JobId
}

/** A reservation: every key claimed, or none and why. */
export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'not-reserving' | 'conflict'; conflicts: ReservationConflict[] }

/** A JSON text with object keys sorted, so equal plain data gives equal text whatever its key order. */
export function canonicalJson(value: unknown): string
{
  return JSON.stringify(value, (_key, item: unknown) =>
  {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
    {
      return item
    }
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(item).sort())
    {
      sorted[key] = (item as Record<string, unknown>)[key]
    }
    return sorted
  })
}

function emptyCounts(): JobCounts
{
  return Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as JobCounts
}

function newJob(seq: number, init: NewJob, now: number): Job
{
  return {
    id: formatCatalog(seq),
    seq,
    rev: 1,
    inputsRev: 1,
    source: init.source,
    recipe: init.recipe,
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    execution: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'pending',
    plan: null,
    policy: null,
    measurement: null,
    verification: null,
    result: null,
    error: null,
    hold: null,
    attempts: [],
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    warnings: [],
    acknowledged: false,
    runId: null,
    rerunOf: init.rerunOf ?? null,
    addedAt: now,
    startedAt: null,
    endedAt: null,
    workDir: null,
    history: null
  }
}

/** Jobs in queue order with their revisions, counts per state, and output reservations. */
export class JobQueue
{
  private readonly deps: QueueDeps
  private readonly records = new Map<JobId, Job>()
  private ids: JobId[] = []
  private readonly tally: JobCounts = emptyCounts()
  private readonly holders = new Map<string, JobId>()
  private readonly claims = new Map<JobId, string[]>()
  private revision = 0

  constructor(deps: QueueDeps)
  {
    this.deps = deps
  }

  /** How many jobs the queue holds. */
  get size(): number
  {
    return this.ids.length
  }

  /** Increments on every change to the order. */
  get orderRev(): number
  {
    return this.revision
  }

  /** Whether a job is in the queue. */
  has(id: JobId): boolean
  {
    return this.records.has(id)
  }

  /** A job's record; change it only through `update`, which keeps the revisions, counts, and reservations. */
  get(id: JobId): Readonly<Job> | undefined
  {
    return this.records.get(id)
  }

  /** A job's index in the order, or -1. */
  indexOf(id: JobId): number
  {
    return this.ids.indexOf(id)
  }

  /** The job ids in queue order. */
  order(): JobId[]
  {
    return [...this.ids]
  }

  /** The jobs in queue order. */
  jobs(): Readonly<Job>[]
  {
    return this.ids.map((id) => this.records.get(id) as Job)
  }

  /** Jobs per state. */
  counts(): JobCounts
  {
    return { ...this.tally }
  }

  /** How many jobs are in a state. */
  count(state: JobState): number
  {
    return this.tally[state]
  }

  /**
   * Creates pending jobs with the next catalog numbers and puts them, in the given order, after `after` (or at the
   * end when it is null or not in the queue). Numbers come from the reserved block, never from the clock, so jobs
   * created in one millisecond get distinct numbers. Null, with nothing created, when the block holds too few.
   */
  add(inits: readonly NewJob[], after: JobId | null = null): Readonly<Job>[] | null
  {
    if (this.deps.numbers.available() < inits.length)
    {
      return null
    }
    const now = this.deps.now()
    const created: Job[] = []
    for (const init of inits)
    {
      const seq = this.nextNumber()
      if (seq === null)
      {
        return null
      }
      created.push(newJob(seq, init, now))
    }
    if (created.length === 0)
    {
      return []
    }
    const anchor = after === null ? -1 : this.ids.indexOf(after)
    const at = anchor === -1 ? this.ids.length : anchor + 1
    this.ids.splice(at, 0, ...created.map((job) => job.id))
    for (const job of created)
    {
      this.records.set(job.id, job)
      this.tally[job.state] += 1
    }
    this.revision += 1
    return created
  }

  /**
   * Applies a change and increments rev when any field changed. inputsRev increments when the recipe or the source
   * changed in value, or when `inputs` asks for it (a queued job's new recipe must void its claim in the same turn).
   * A job that leaves the reserving states gives up its reservations. Null for a job not in the queue.
   */
  update(id: JobId, change: JobChange, options: { inputs?: boolean } = {}): Readonly<Job> | null
  {
    const job = this.records.get(id)
    if (!job)
    {
      return null
    }
    const keys = (Object.keys(change) as Array<keyof JobChange>)
      .filter((key) => change[key] !== undefined && !Object.is(job[key], change[key]))
    const inputs = options.inputs === true ||
      keys.some((key) => (key === 'recipe' || key === 'source') && canonicalJson(job[key]) !== canonicalJson(change[key]))
    if (keys.length === 0 && !inputs)
    {
      return job
    }
    const previous = job.state
    const target = job as unknown as Record<string, unknown>
    for (const key of keys)
    {
      target[key] = change[key]
    }
    job.rev += 1
    if (inputs)
    {
      job.inputsRev += 1
    }
    if (job.state !== previous)
    {
      this.tally[previous] -= 1
      this.tally[job.state] += 1
      if (!RESERVING_STATES.includes(job.state))
      {
        this.release(id)
      }
    }
    return job
  }

  /**
   * Takes jobs out of the queue and returns them in queue order with where each stood, for a tombstone. Their
   * reservations are released; ids not in the queue are ignored.
   */
  remove(ids: readonly JobId[]): RemovedJob[]
  {
    const doomed = new Set(ids.filter((id) => this.records.has(id)))
    if (doomed.size === 0)
    {
      return []
    }
    const removed: RemovedJob[] = []
    const kept: JobId[] = []
    this.ids.forEach((id, index) =>
    {
      if (doomed.has(id))
      {
        removed.push({ job: this.records.get(id) as Job, index, after: kept.length > 0 ? kept[kept.length - 1] : null })
      }
      else
      {
        kept.push(id)
      }
    })
    for (const entry of removed)
    {
      this.records.delete(entry.job.id)
      this.tally[entry.job.state] -= 1
      this.release(entry.job.id)
    }
    this.ids = kept
    this.revision += 1
    return removed
  }

  /**
   * Puts removed jobs back with their records and numbers. Each run of jobs removed together returns, in its old
   * order, after the job that stood above it, at the top when none did, or at its old index when that job is gone.
   * A job whose number is in the queue again is skipped, and the rest of its run follows it. Returns the ids restored,
   * in queue order of restoring.
   */
  restore(entries: readonly RemovedJob[]): JobId[]
  {
    const sorted = [...entries].sort((a, b) => a.index - b.index)
    const restored: JobId[] = []
    let previous: RemovedJob | null = null
    for (const entry of sorted)
    {
      const id = entry.job.id
      if (this.records.has(id))
      {
        previous = entry
        continue
      }
      let at: number
      if (previous !== null && previous.after === entry.after)
      {
        at = this.ids.indexOf(previous.job.id) + 1
      }
      else if (entry.after === null)
      {
        at = 0
      }
      else
      {
        const anchor = this.ids.indexOf(entry.after)
        at = anchor === -1 ? Math.min(entry.index, this.ids.length) : anchor + 1
      }
      this.ids.splice(at, 0, id)
      this.records.set(id, entry.job)
      this.tally[entry.job.state] += 1
      restored.push(id)
      previous = entry
    }
    if (restored.length > 0)
    {
      this.revision += 1
    }
    return restored
  }

  /**
   * Moves pending and queued jobs, in their relative order, before `before` or to the end (`jobs:reorder`); other
   * jobs are refused and stay where they are. When `before` is itself moved, the first job below it that is not moved
   * takes its place. Null when `before` is not in the queue.
   */
  reorder(ids: readonly JobId[], before: JobId | null): MoveResult | null
  {
    if (before !== null && !this.records.has(before))
    {
      return null
    }
    const { moving, result } = this.selection(ids)
    let anchor = before
    if (anchor !== null && moving.has(anchor))
    {
      anchor = this.ids.slice(this.ids.indexOf(anchor)).find((id) => !moving.has(id)) ?? null
    }
    result.changed = this.place(moving, anchor)
    return result
  }

  /**
   * Moves pending and queued jobs together, in their relative order: up past the job above the first of them, down
   * past the job below the last of them, to the top, to the bottom, or ahead of every other pending or queued job
   * (run next), which dispatches queued jobs before the rest. Other jobs are refused and stay where they are.
   */
  move(ids: readonly JobId[], kind: QueueMove): MoveResult
  {
    const { moving, result } = this.selection(ids)
    if (moving.size === 0)
    {
      return result
    }
    const others = this.ids.filter((id) => !moving.has(id))
    const first = this.ids.findIndex((id) => moving.has(id))
    const last = this.ids.length - 1 - [...this.ids].reverse().findIndex((id) => moving.has(id))
    let anchor: JobId | null | undefined
    switch (kind)
    {
      case 'up':
        anchor = this.ids.slice(0, first).filter((id) => !moving.has(id)).at(-1) ?? others[0]
        break
      case 'down':
      {
        const below = this.ids.slice(last + 1).find((id) => !moving.has(id))
        anchor = below === undefined ? null : others[others.indexOf(below) + 1] ?? null
        break
      }
      case 'top':
        anchor = others[0]
        break
      case 'bottom':
        anchor = null
        break
      default:
        anchor = others.find((id) => MOVABLE_STATES.includes((this.records.get(id) as Job).state))
    }
    if (anchor !== undefined)
    {
      result.changed = this.place(moving, anchor)
    }
    return result
  }

  /**
   * Replaces the queue with loaded jobs at startup: in `order` first, then any job it misses by catalog number; ids
   * in `order` without a record are dropped. Reservations start empty; the engine claims them again as it re-plans.
   */
  hydrate(jobs: readonly Job[], order: readonly JobId[]): void
  {
    this.records.clear()
    this.holders.clear()
    this.claims.clear()
    Object.assign(this.tally, emptyCounts())
    for (const job of jobs)
    {
      if (!this.records.has(job.id))
      {
        this.records.set(job.id, job)
        this.tally[job.state] += 1
      }
    }
    const listed = new Set<JobId>()
    for (const id of order)
    {
      if (this.records.has(id))
      {
        listed.add(id)
      }
    }
    const rest = [...this.records.values()].filter((job) => !listed.has(job.id)).sort((a, b) => a.seq - b.seq)
    this.ids = [...listed, ...rest.map((job) => job.id)]
    this.revision += 1
  }

  /**
   * Claims output path keys (as `pathKey` gives them) for a queued, active, or held job, replacing its earlier
   * claims. All or nothing: a key another job holds refuses the whole claim. A job claims only while it is in a
   * reserving state, so set the state first.
   */
  reserve(id: JobId, keys: readonly string[]): ReserveResult
  {
    const job = this.records.get(id)
    if (!job)
    {
      return { ok: false, reason: 'not-found', conflicts: [] }
    }
    if (!RESERVING_STATES.includes(job.state))
    {
      return { ok: false, reason: 'not-reserving', conflicts: [] }
    }
    const wanted = [...new Set(keys)]
    const conflicts: ReservationConflict[] = []
    for (const key of wanted)
    {
      const holder = this.holders.get(key)
      if (holder !== undefined && holder !== id)
      {
        conflicts.push({ key, holder })
      }
    }
    if (conflicts.length > 0)
    {
      return { ok: false, reason: 'conflict', conflicts }
    }
    this.release(id)
    for (const key of wanted)
    {
      this.holders.set(key, id)
    }
    if (wanted.length > 0)
    {
      this.claims.set(id, wanted)
    }
    return { ok: true }
  }

  /** The job holding an output path key, or null. */
  holderOf(key: string): JobId | null
  {
    return this.holders.get(key) ?? null
  }

  /** The output path keys a job holds. */
  reservedBy(id: JobId): string[]
  {
    return [...(this.claims.get(id) ?? [])]
  }

  /** Gives up a job's reservations and returns their keys. */
  release(id: JobId): string[]
  {
    const keys = this.claims.get(id) ?? []
    for (const key of keys)
    {
      this.holders.delete(key)
    }
    this.claims.delete(id)
    return keys
  }

  private selection(ids: readonly JobId[]): { moving: Set<JobId>; result: MoveResult }
  {
    const moving = new Set<JobId>()
    const refused: JobRefusal[] = []
    for (const id of new Set(ids))
    {
      const job = this.records.get(id)
      if (!job)
      {
        refused.push({ jobId: id, code: 'not-found', message: `${id} is not in the queue.` })
      }
      else if (!MOVABLE_STATES.includes(job.state))
      {
        refused.push({ jobId: id, code: 'not-movable', message: `${id} can be moved only while it is waiting or queued.` })
      }
      else
      {
        moving.add(id)
      }
    }
    return { moving, result: { applied: this.ids.filter((id) => moving.has(id)), refused, changed: false } }
  }

  private place(moving: ReadonlySet<JobId>, anchor: JobId | null): boolean
  {
    const moved = this.ids.filter((id) => moving.has(id))
    const rest = this.ids.filter((id) => !moving.has(id))
    const at = anchor === null ? rest.length : rest.indexOf(anchor)
    const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)]
    if (next.every((id, index) => id === this.ids[index]))
    {
      return false
    }
    this.ids = next
    this.revision += 1
    return true
  }

  private nextNumber(): number | null
  {
    for (;;)
    {
      const seq = this.deps.numbers.take()
      if (seq === null || !this.records.has(formatCatalog(seq)))
      {
        return seq
      }
    }
  }
}
