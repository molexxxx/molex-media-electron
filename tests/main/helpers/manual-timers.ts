/**
 * A manual scheduler that implements `Timers` for tests. Time moves only through `advance`, which runs every due
 * callback in time order and lets pending promise callbacks settle between them, so a 30 s budget runs in
 * milliseconds and no test needs real sleeps or Vitest fake timers.
 */
import { sleepOn } from '../../../src/main/timers'
import type { TimerHandle, Timers } from '../../../src/main/timers'

interface Entry
{
  readonly id: number
  readonly at: number
  readonly fn: () => void
}

/** `Timers` plus the controls a test drives it with. */
export interface ManualTimers extends Timers
{
  /** Moves the clock forward by `ms`, running due callbacks in time order and settling promises between them. */
  advance(ms: number): Promise<void>
  /** Lets every pending promise callback settle without moving the clock. */
  flush(): Promise<void>
  /** How many callbacks are scheduled. */
  pending(): number
  /** When the next callback is due, or null when none is scheduled. */
  next(): number | null
  /** Advances until nothing is scheduled; throws after `limit` callbacks, so a timer that keeps rescheduling fails loudly. */
  runAll(limit?: number): Promise<void>
}

function settle(): Promise<void>
{
  return new Promise((resolve) =>
  {
    if (typeof setImmediate === 'function')
    {
      setImmediate(resolve)
    }
    else
    {
      setTimeout(resolve, 0)
    }
  })
}

const MAX_CALLBACKS_AT_ONE_TIME = 10000

/** A manual scheduler whose clock starts at `start` milliseconds. */
export function createManualTimers(start = 0): ManualTimers
{
  let clock = start
  let lastId = 0
  const entries: Entry[] = []

  async function runNext(): Promise<void>
  {
    const entry = entries.shift() as Entry
    clock = entry.at
    entry.fn()
    await settle()
  }

  function schedule(fn: () => void, ms: number): TimerHandle
  {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0
    const entry: Entry = { id: ++lastId, at: clock + delay, fn }
    const index = entries.findIndex((e) => e.at > entry.at)
    if (index === -1)
    {
      entries.push(entry)
    }
    else
    {
      entries.splice(index, 0, entry)
    }
    return entry.id
  }

  function cancel(handle: TimerHandle): void
  {
    const index = entries.findIndex((e) => e.id === handle)
    if (index !== -1)
    {
      entries.splice(index, 1)
    }
  }

  const timers: ManualTimers =
  {
    now: () => clock,
    setTimeout: schedule,
    clearTimeout: cancel,
    sleep: (ms, signal) => sleepOn(timers, ms, signal),
    async advance(ms)
    {
      if (!Number.isFinite(ms) || ms < 0)
      {
        throw new RangeError(`advance takes a finite number of milliseconds of 0 or more, not ${ms}`)
      }
      const target = clock + ms
      await settle()
      let sameTime = 0
      while (entries.length > 0 && entries[0].at <= target)
      {
        sameTime = entries[0].at === clock ? sameTime + 1 : 1
        if (sameTime > MAX_CALLBACKS_AT_ONE_TIME)
        {
          throw new Error(`advance stopped after ${MAX_CALLBACKS_AT_ONE_TIME} callbacks at ${clock} ms; a zero-delay timer keeps rescheduling itself`)
        }
        await runNext()
      }
      clock = target
    },
    flush: settle,
    pending: () => entries.length,
    next: () => (entries.length > 0 ? entries[0].at : null),
    async runAll(limit = 1000)
    {
      await settle()
      let ran = 0
      while (entries.length > 0)
      {
        if (++ran > limit)
        {
          throw new Error(`runAll stopped after ${limit} callbacks; a timer keeps rescheduling itself`)
        }
        await runNext()
      }
    }
  }
  return timers
}
