/**
 * The event bus: one global, gap-free `seq` assigned at flush time, progress coalesced per job and stream, every
 * other event flushed within 50 ms, and one registration per subscribed webContents. Every batch passes through
 * `toWire` before it is sent.
 */

import { JOB_EVENT_CHANNEL, type JobEvent, type JobEventBatch } from '../../shared/jobs/contract'
import type { JobId } from '../../shared/jobs/ids'
import { toWire } from '../../shared/jobs/wire'
import type { TimerHandle, Timers } from '../timers'
import type { EventSender, JobLogger } from './deps'

/** An event before the bus numbers it; `at` defaults to the bus clock. */
export type DraftEvent = JobEvent extends infer E ? (E extends JobEvent ? Omit<E, 'seq' | 'at'> & { at?: number } : never) : never

/** The bus intervals and the batch cap. */
export const BUS_TIMING =
{
  flushMs: 50,
  progressMs: 250,
  runProgressMs: 500,
  maxBatch: 500
} as const

/** The engine's view of the bus. */
export interface JobEventBus
{
  /** Queues an event in the caller's turn; its seq is assigned when it is sent. */
  emit(event: DraftEvent): void
  /** Sends every event that is due now and returns the last seq sent, which a command reply carries. */
  flush(): number
  lastSeq(): number
  /**
   * Sends every pending event to the current subscribers, builds the snapshot at the resulting seq, and registers
   * the sender under `clientId`, replacing its earlier registration, all in one turn.
   */
  subscribe<S>(sender: EventSender, clientId: string, build: (seq: number) => S): S
  /** Removes the sender's registration only when it still carries `clientId`. */
  unsubscribe(senderId: number, clientId: string): boolean
  registrations(): Array<{ senderId: number; clientId: string }>
  dispose(): void
}

export interface JobEventBusDeps
{
  timers: Timers
  log: Pick<JobLogger, 'warn'>
}

interface Entry
{
  event: DraftEvent
  at: number
  key: string | null
  interval: number
  live: boolean
  /** Sent at the next flush whatever the interval: a new stage's starting progress, or progress a completion must follow. */
  fresh: boolean
}

interface Registration
{
  sender: EventSender
  clientId: string
  release: Array<() => void>
}

function coalescing(event: DraftEvent): { key: string; interval: number } | null
{
  switch (event.type)
  {
    case 'job.progress':
      return { key: `job:${event.jobId}`, interval: BUS_TIMING.progressMs }
    case 'run.progress':
      return { key: 'run', interval: BUS_TIMING.runProgressMs }
    case 'scan.progress':
      return { key: `scan:${event.scan.scanId}`, interval: BUS_TIMING.progressMs }
    case 'preflight.progress':
      return { key: `preflight:${event.preflightId}`, interval: BUS_TIMING.progressMs }
    default:
      return null
  }
}

function resetJob(event: DraftEvent): { jobId: JobId; startsStage: boolean } | null
{
  switch (event.type)
  {
    case 'job.state':
    case 'job.stage':
      return { jobId: event.jobId, startsStage: true }
    case 'job.added':
      return { jobId: event.job.id, startsStage: true }
    case 'job.removed':
      return { jobId: event.jobId, startsStage: false }
    default:
      return null
  }
}

/** Builds the bus on the injected timers; nothing here waits on real time. */
export function createJobEventBus(deps: JobEventBusDeps): JobEventBus
{
  const { timers, log } = deps
  let queue: Entry[] = []
  const pending = new Map<string, Entry>()
  const lastSent = new Map<string, number>()
  const newStage = new Set<JobId>()
  const regs = new Map<number, Registration>()
  let seq = 0
  let immediate = 0
  let flushTimer: TimerHandle | null = null
  let tickTimer: TimerHandle | null = null
  let lastWorkers: string | null = null

  const cancelFlush = (): void =>
  {
    if (flushTimer !== null)
    {
      timers.clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  const cancelTick = (): void =>
  {
    if (tickTimer !== null)
    {
      timers.clearTimeout(tickTimer)
      tickTimer = null
    }
  }

  const release = (reg: Registration): void =>
  {
    for (const stop of reg.release)
    {
      stop()
    }
    reg.release = []
  }

  const drop = (reg: Registration): void =>
  {
    if (regs.get(reg.sender.id) === reg)
    {
      regs.delete(reg.sender.id)
      release(reg)
    }
  }

  const deliver = (reg: Registration, batch: JobEventBatch): void =>
  {
    if (reg.sender.isDestroyed())
    {
      drop(reg)
      return
    }
    try
    {
      reg.sender.send(JOB_EVENT_CHANNEL, batch)
    }
    catch (err)
    {
      log.warn(`Stopped sending job events to window ${reg.sender.id}: ${err instanceof Error ? err.message : String(err)}`)
      drop(reg)
    }
  }

  const send = (events: JobEvent[]): void =>
  {
    for (let i = 0; i < events.length && regs.size > 0; i += BUS_TIMING.maxBatch)
    {
      const batch = toWire<JobEventBatch>({ events: events.slice(i, i + BUS_TIMING.maxBatch) })
      for (const reg of [...regs.values()])
      {
        deliver(reg, batch)
      }
    }
  }

  const prune = (now: number): void =>
  {
    for (const [key, at] of lastSent)
    {
      if (!pending.has(key) && now - at >= BUS_TIMING.runProgressMs)
      {
        lastSent.delete(key)
      }
    }
  }

  const due = (entry: Entry, now: number): boolean =>
  {
    const at = lastSent.get(entry.key as string)
    return entry.fresh || at === undefined || now - at >= entry.interval
  }

  const scheduleTick = (): void =>
  {
    if (tickTimer === null)
    {
      tickTimer = timers.setTimeout(() =>
      {
        tickTimer = null
        flushNow(false)
      }, BUS_TIMING.progressMs)
    }
  }

  const flushNow = (all: boolean): number =>
  {
    cancelFlush()
    const now = timers.now()
    const out: JobEvent[] = []
    const held: Entry[] = []
    for (const entry of queue)
    {
      if (!entry.live)
      {
        continue
      }
      if (entry.key !== null)
      {
        if (!all && !due(entry, now))
        {
          held.push(entry)
          continue
        }
        pending.delete(entry.key)
        lastSent.set(entry.key, now)
      }
      seq += 1
      out.push({ ...entry.event, at: entry.at, seq } as JobEvent)
    }
    queue = held
    immediate = 0
    newStage.clear()
    prune(now)
    if (held.length > 0)
    {
      scheduleTick()
    }
    else
    {
      cancelTick()
    }
    send(out)
    return seq
  }

  const discard = (key: string): void =>
  {
    const entry = pending.get(key)
    if (entry)
    {
      entry.live = false
      pending.delete(key)
    }
  }

  const emit = (event: DraftEvent): void =>
  {
    if (event.type === 'workers.changed')
    {
      const text = JSON.stringify(event.workers)
      if (text === lastWorkers)
      {
        return
      }
      lastWorkers = text
    }
    const reset = resetJob(event)
    if (reset)
    {
      discard(`job:${reset.jobId}`)
      if (reset.startsStage)
      {
        newStage.add(reset.jobId)
      }
      else
      {
        newStage.delete(reset.jobId)
        lastSent.delete(`job:${reset.jobId}`)
      }
    }
    if (event.type === 'run.completed')
    {
      const progress = pending.get('run')
      if (progress)
      {
        progress.fresh = true
      }
    }
    const at = event.at ?? timers.now()
    const rule = coalescing(event)
    if (rule === null)
    {
      queue.push({ event, at, key: null, interval: 0, live: true, fresh: false })
      immediate += 1
      if (immediate >= BUS_TIMING.maxBatch)
      {
        flushNow(false)
      }
      else if (flushTimer === null)
      {
        flushTimer = timers.setTimeout(() =>
        {
          flushTimer = null
          flushNow(false)
        }, BUS_TIMING.flushMs)
      }
      return
    }
    const fresh = event.type === 'job.progress' && newStage.has(event.jobId)
    discard(rule.key)
    const entry: Entry = { event, at, key: rule.key, interval: rule.interval, live: true, fresh }
    queue.push(entry)
    pending.set(rule.key, entry)
    scheduleTick()
  }

  return {
    emit,
    flush: () => flushNow(false),
    lastSeq: () => seq,
    subscribe<S>(sender: EventSender, clientId: string, build: (seq: number) => S): S
    {
      flushNow(true)
      const snapshot = build(seq)
      const existing = regs.get(sender.id)
      if (existing)
      {
        drop(existing)
      }
      if (sender.isDestroyed())
      {
        return snapshot
      }
      const reg: Registration = { sender, clientId, release: [] }
      reg.release.push(sender.onNavigate((navigation) =>
      {
        if (navigation.isMainFrame && !navigation.isSameDocument)
        {
          drop(reg)
        }
      }))
      reg.release.push(sender.onDestroyed(() => drop(reg)))
      regs.set(sender.id, reg)
      return snapshot
    },
    unsubscribe(senderId: number, clientId: string): boolean
    {
      const reg = regs.get(senderId)
      if (!reg || reg.clientId !== clientId)
      {
        return false
      }
      drop(reg)
      return true
    },
    registrations: () => [...regs.values()].map((reg) => ({ senderId: reg.sender.id, clientId: reg.clientId })),
    dispose(): void
    {
      cancelFlush()
      cancelTick()
      for (const reg of [...regs.values()])
      {
        drop(reg)
      }
      queue = []
      pending.clear()
      lastSent.clear()
      newStage.clear()
      immediate = 0
    }
  }
}
