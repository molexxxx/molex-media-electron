import { describe, expect, it, vi } from 'vitest'
import { BUS_TIMING, createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import type { EventSender } from '../../../src/main/jobs/deps'
import { JOB_EVENT_CHANNEL, type JobEvent, type JobEventBatch } from '../../../src/shared/jobs/contract'
import { formatCatalog, type JobId } from '../../../src/shared/jobs/ids'
import { assertWireSafe } from '../../../src/shared/jobs/wire'
import { createManualTimers, type ManualTimers } from '../helpers/manual-timers'

const A = formatCatalog(1)
const B = formatCatalog(2)
const C = formatCatalog(3)

type Navigation = { isMainFrame: boolean; isSameDocument: boolean }

interface Received
{
  at: number
  batch: JobEventBatch
}

function fakeSender(id: number, timers: ManualTimers, options: { keepListeners?: boolean } = {})
{
  const received: Received[] = []
  const navigation = new Set<(nav: Navigation) => void>()
  const destroyedListeners = new Set<() => void>()
  let destroyed = false
  let failure: Error | null = null
  const sender: EventSender =
  {
    id,
    send: vi.fn((channel: string, batch: JobEventBatch) =>
    {
      if (failure)
      {
        throw failure
      }
      expect(channel).toBe(JOB_EVENT_CHANNEL)
      assertWireSafe(batch)
      received.push({ at: timers.now(), batch: structuredClone(batch) })
    }),
    isDestroyed: () => destroyed,
    onNavigate: (listener) =>
    {
      navigation.add(listener)
      return () =>
      {
        if (!options.keepListeners)
        {
          navigation.delete(listener)
        }
      }
    },
    onDestroyed: (listener) =>
    {
      destroyedListeners.add(listener)
      return () =>
      {
        if (!options.keepListeners)
        {
          destroyedListeners.delete(listener)
        }
      }
    }
  }
  return {
    sender,
    received,
    events: (): JobEvent[] => received.flatMap((r) => r.batch.events),
    navigate: (nav: Navigation): void => [...navigation].forEach((listener) => listener(nav)),
    destroy: (): void =>
    {
      destroyed = true
      for (const listener of [...destroyedListeners])
      {
        listener()
      }
    },
    markDestroyed: (): void =>
    {
      destroyed = true
    },
    failWith: (err: Error): void =>
    {
      failure = err
    },
    listeners: (): number => navigation.size + destroyedListeners.size
  }
}

function setup(start = 0)
{
  const timers = createManualTimers(start)
  const log = { warn: vi.fn() }
  const bus = createJobEventBus({ timers, log })
  const to = (ms: number): Promise<void> => timers.advance(ms - timers.now())
  const client = (id: number, clientId = `client-${id}`, options?: { keepListeners?: boolean }) =>
  {
    const fake = fakeSender(id, timers, options)
    bus.subscribe(fake.sender, clientId, (seq) => seq)
    return fake
  }
  return { timers, log, bus, to, client }
}

const draft = (event: Record<string, unknown>): DraftEvent => event as unknown as DraftEvent
const progress = (jobId: JobId, percent: number, stage = 'encode', extra: Record<string, unknown> = {}): DraftEvent =>
  draft({ type: 'job.progress', jobId, progress: { stage, pass: 1, passes: 1, percent, ...extra } })
const stage = (jobId: JobId, id: string): DraftEvent =>
  draft({ type: 'job.stage', jobId, rev: 2, stage: { id, pass: 1, passes: 1, label: id, startedAt: 0 } })
const state = (jobId: JobId, from: string, to: string): DraftEvent =>
  draft({ type: 'job.state', jobId, rev: 3, from, to, attempt: 1, reason: null, patch: {} })
const updated = (jobId: JobId, patch: Record<string, unknown> = {}): DraftEvent => draft({ type: 'job.updated', jobId, rev: 1, patch })
const focus = (): DraftEvent => draft({ type: 'ui.focus', jobId: null, runId: null })
const percentOf = (event: JobEvent): number | null => event.type === 'job.progress' ? event.progress.percent : null
const describeEvent = (event: JobEvent): string =>
  event.type === 'job.progress'
    ? `progress ${event.jobId} ${event.progress.stage} ${event.progress.percent}`
    : `${event.type}${'jobId' in event && event.jobId ? ` ${event.jobId}` : ''}`

describe('event bus sequence numbers', () =>
{
  it('assigns one gap-free seq across immediate, coalesced, and capped flushes', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    for (let i = 0; i < 40; i += 1)
    {
      bus.emit(progress(A, i))
      bus.emit(progress(B, i))
      if (i % 3 === 0)
      {
        bus.emit(updated(C, { step: i }))
      }
      if (i === 20)
      {
        for (let k = 0; k < BUS_TIMING.maxBatch; k += 1)
        {
          bus.emit(updated(C, { k }))
        }
      }
      await to((i + 1) * 37)
    }
    await to(5000)
    const seqs = first.events().map((event) => event.seq)
    expect(seqs.length).toBeGreaterThan(BUS_TIMING.maxBatch)
    expect(seqs).toEqual(seqs.map((_seq, index) => index + 1))
    expect(bus.lastSeq()).toBe(seqs.length)
    for (const { batch } of first.received)
    {
      const inBatch = batch.events.map((event) => event.seq)
      expect(inBatch).toEqual([...inBatch].sort((x, y) => x - y))
    }
  })

  it('numbers events that no window receives, so a later snapshot starts after them', async () =>
  {
    const { bus, to, timers } = setup()
    bus.emit(updated(A))
    bus.emit(progress(A, 5))
    await to(BUS_TIMING.progressMs)
    expect(bus.lastSeq()).toBe(2)
    const late = fakeSender(9, timers)
    expect(bus.subscribe(late.sender, 'late', (seq) => ({ seq }))).toEqual({ seq: 2 })
    bus.emit(updated(B))
    expect(bus.flush()).toBe(3)
    expect(late.events().map((event) => event.seq)).toEqual([3])
  })

  it('flush sends what is due at once and returns the last seq', () =>
  {
    const { bus, client } = setup()
    expect(bus.flush()).toBe(0)
    const first = client(1)
    bus.emit(updated(A))
    bus.emit(state(A, 'queued', 'analyzing'))
    expect(bus.flush()).toBe(2)
    expect(first.events().map((event) => event.type)).toEqual(['job.updated', 'job.state'])
    expect(bus.flush()).toBe(2)
    expect(first.received).toHaveLength(1)
  })

  it('stamps at from the bus clock unless the event carries one', () =>
  {
    const { bus, client } = setup(1000)
    const first = client(1)
    bus.emit(updated(A))
    bus.emit(draft({ type: 'job.updated', jobId: B, rev: 1, patch: {}, at: 5 }))
    bus.flush()
    expect(first.events().map((event) => event.at)).toEqual([1000, 5])
  })
})

describe('event bus coalescing', () =>
{
  it('coalesces progress to one event per job per 250 ms tick, latest wins, in one message', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 1))
    await to(10)
    bus.emit(progress(A, 2))
    await to(100)
    bus.emit(progress(A, 3))
    bus.emit(progress(B, 7))
    await to(249)
    expect(first.received).toHaveLength(0)
    await to(250)
    expect(first.received).toHaveLength(1)
    expect(first.events().map(describeEvent)).toEqual([`progress ${A} encode 3`, `progress ${B} encode 7`])

    await to(260)
    bus.emit(progress(A, 4))
    await to(300)
    bus.emit(progress(A, 5))
    await to(509)
    expect(first.received).toHaveLength(1)
    await to(510)
    expect(first.received[1].batch.events.map(percentOf)).toEqual([5])
  })

  it('carries due progress of other jobs with an immediate flush and holds progress sent less than 250 ms ago', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 1))
    bus.emit(progress(B, 1))
    await to(250)
    bus.emit(progress(A, 2))
    await to(300)
    bus.emit(progress(A, 3))
    bus.emit(focus())
    await to(350)
    expect(first.received[1].batch.events.map(describeEvent)).toEqual(['ui.focus'])
    await to(500)
    expect(first.received[2].batch.events.map(describeEvent)).toEqual([`progress ${A} encode 3`])

    await to(800)
    bus.emit(progress(B, 2))
    bus.emit(focus())
    await to(850)
    expect(first.received[3].batch.events.map(describeEvent)).toEqual([`progress ${B} encode 2`, 'ui.focus'])
  })

  it('never sends two progress events for one job within 250 ms and always delivers the last value', async () =>
  {
    const { bus, to, client, timers } = setup()
    const first = client(1)
    for (let t = 0; t <= 3000; t += 10)
    {
      await to(t)
      bus.emit(progress(A, t))
      if (t % 70 === 0)
      {
        bus.emit(updated(B, { t }))
      }
    }
    await timers.runAll()
    const sent = first.received.flatMap((r) => r.batch.events.filter((event) => event.type === 'job.progress').map((event) => ({ at: r.at, event })))
    for (let i = 1; i < sent.length; i += 1)
    {
      expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(BUS_TIMING.progressMs)
    }
    expect(percentOf(sent[sent.length - 1].event)).toBe(3000)
  })

  it('limits run progress to one per 500 ms on the 250 ms tick', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    const run = (done: number): DraftEvent => draft({ type: 'run.progress', progress: { done } })
    bus.emit(run(1))
    await to(260)
    bus.emit(run(2))
    await to(510)
    const times = (): number[] => first.received.filter((r) => r.batch.events.some((event) => event.type === 'run.progress')).map((r) => r.at)
    expect(times()).toEqual([250])
    await to(759)
    expect(times()).toEqual([250])
    await to(760)
    expect(times()).toEqual([250, 760])
  })

  it('sends pending run progress before the run completes', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(draft({ type: 'run.progress', progress: { done: 1 } }))
    await to(250)
    await to(300)
    bus.emit(draft({ type: 'run.progress', progress: { done: 2 } }))
    bus.emit(draft({ type: 'run.completed', summary: { runId: 'R-1' } }))
    await to(350)
    expect(first.received[1].batch.events.map((event) => event.type)).toEqual(['run.progress', 'run.completed'])
    await to(2000)
    expect(first.received).toHaveLength(2)
    bus.emit(draft({ type: 'run.completed', summary: { runId: 'R-2' } }))
    await to(2050)
    expect(first.received[2].batch.events.map((event) => event.type)).toEqual(['run.completed'])
  })

  it('treats a stream idle for longer than its interval as never sent', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 1))
    await to(250)
    await to(1000)
    bus.emit(updated(B))
    await to(1050)
    bus.emit(progress(A, 2))
    bus.emit(updated(B))
    await to(1100)
    expect(first.received.map((r) => [r.at, r.batch.events.map(describeEvent)])).toEqual([
      [250, [`progress ${A} encode 1`]],
      [1050, [`job.updated ${B}`]],
      [1100, [`progress ${A} encode 2`, `job.updated ${B}`]]
    ])
  })

  it('coalesces scan and preflight progress per scan and per preflight', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    const scan = (scanId: string, visited: number): DraftEvent => draft({ type: 'scan.progress', scan: { scanId, visited } })
    bus.emit(scan('s1', 1))
    bus.emit(scan('s2', 1))
    bus.emit(scan('s1', 2))
    bus.emit(draft({ type: 'preflight.progress', preflightId: 'p1', done: 1, total: 9 }))
    bus.emit(draft({ type: 'preflight.progress', preflightId: 'p1', done: 4, total: 9 }))
    await to(250)
    expect(first.events().map((event) =>
      event.type === 'scan.progress' ? `${event.scan.scanId}:${event.scan.visited}` : event.type === 'preflight.progress' ? `p:${event.done}` : event.type))
      .toEqual(['s2:1', 's1:2', 'p:4'])
  })

  it('sends workers.changed only when a value changes', () =>
  {
    const { bus, client } = setup()
    const first = client(1)
    const workers = (active: number): DraftEvent => draft({ type: 'workers.changed', workers: { active, limit: 4 } })
    bus.emit(workers(1))
    bus.emit(workers(1))
    bus.emit(workers(2))
    bus.emit(workers(2))
    bus.flush()
    expect(first.events().map((event) => event.type === 'workers.changed' ? event.workers : null)).toEqual([{ active: 1, limit: 4 }, { active: 2, limit: 4 }])
  })
})

describe('event bus stage changes', () =>
{
  it('drops pending progress when the stage changes', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 40, 'encode'))
    await to(100)
    bus.emit(stage(A, 'verify'))
    await to(150)
    expect(first.events().map(describeEvent)).toEqual([`job.stage ${A}`])
    await to(1000)
    expect(first.events()).toHaveLength(1)
  })

  it('drops pending progress on a state change and on removal', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 90))
    bus.emit(progress(B, 30))
    await to(10)
    bus.emit(state(A, 'encoding', 'verifying'))
    bus.emit(draft({ type: 'job.removed', jobId: B }))
    await to(1000)
    expect(first.events().map(describeEvent)).toEqual([`job.state ${A}`, `job.removed ${B}`])
  })

  it('sends the new stage\'s starting progress with the stage event', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 10, 'encode'))
    await to(250)
    await to(300)
    bus.emit(stage(A, 'verify'))
    bus.emit(progress(A, 0, 'verify'))
    await to(350)
    expect(first.received[1].batch.events.map(describeEvent)).toEqual([`job.stage ${A}`, `progress ${A} verify 0`])
    bus.emit(draft({ type: 'job.added', job: { id: B }, after: null }))
    bus.emit(progress(B, 0, 'probe'))
    await to(400)
    expect(first.received[2].batch.events.map(describeEvent)).toEqual(['job.added', `progress ${B} probe 0`])
  })
})

describe('event bus flush timing and batch size', () =>
{
  it('flushes state events within 50 ms of the first one', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(state(A, 'queued', 'analyzing'))
    await to(49)
    expect(first.received).toHaveLength(0)
    await to(50)
    expect(first.received.map((r) => r.at)).toEqual([50])
    await to(100)
    bus.emit(updated(A))
    await to(130)
    bus.emit(updated(B))
    await to(150)
    expect(first.received.map((r) => r.at)).toEqual([50, 150])
    expect(first.received[1].batch.events.map(describeEvent)).toEqual([`job.updated ${A}`, `job.updated ${B}`])
  })

  it('closes a batch at 500 events', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    for (let i = 0; i < 1200; i += 1)
    {
      bus.emit(updated(A, { i }))
    }
    expect(first.received.map((r) => r.batch.events.length)).toEqual([500, 500])
    await to(50)
    expect(first.received.map((r) => r.batch.events.length)).toEqual([500, 500, 200])
    expect(first.events().map((event) => event.seq)).toEqual(Array.from({ length: 1200 }, (_v, i) => i + 1))
  })

  it('splits one flush into messages of at most 500 events', async () =>
  {
    const { bus, to, client } = setup()
    const first = client(1)
    bus.emit(progress(A, 1))
    bus.emit(progress(B, 1))
    bus.emit(progress(C, 1))
    for (let i = 0; i < BUS_TIMING.maxBatch - 1; i += 1)
    {
      bus.emit(updated(A, { i }))
    }
    expect(first.received).toHaveLength(0)
    await to(50)
    expect(first.received.map((r) => r.batch.events.length)).toEqual([500, 2])
    expect(first.received[0].batch.events.slice(0, 3).map((event) => event.type)).toEqual(['job.progress', 'job.progress', 'job.progress'])
  })
})

describe('event bus wire safety', () =>
{
  it('passes every batch through toWire', () =>
  {
    const { bus, client } = setup()
    const first = client(1)
    bus.emit(updated(A, { speed: Number.NaN, eta: Number.POSITIVE_INFINITY, gone: undefined, peaks: [1, Number.NEGATIVE_INFINITY] }))
    bus.emit(progress(B, 5, 'encode', { speed: Number.NaN, etaSec: undefined }))
    bus.flush()
    const [patched, moving] = first.events()
    expect(patched.type === 'job.updated' && patched.patch).toEqual({ speed: null, eta: null, gone: null, peaks: [1, null] })
    expect(moving.type === 'job.progress' && moving.progress).toMatchObject({ speed: null, etaSec: null })
  })
})

describe('event bus registrations', () =>
{
  it('keeps one registration per webContents and replaces it on a new subscribe', () =>
  {
    const { bus, client, timers } = setup()
    const first = client(1, 'a')
    expect(first.listeners()).toBe(2)
    bus.subscribe(first.sender, 'b', () => null)
    expect(bus.registrations()).toEqual([{ senderId: 1, clientId: 'b' }])
    expect(first.listeners()).toBe(2)
    bus.emit(updated(A))
    bus.flush()
    expect(first.received).toHaveLength(1)
    const second = fakeSender(2, timers)
    bus.subscribe(second.sender, 'c', () => null)
    expect(bus.registrations()).toEqual([{ senderId: 1, clientId: 'b' }, { senderId: 2, clientId: 'c' }])
  })

  it('flushes pending events to existing windows before it builds the snapshot', () =>
  {
    const { bus, client, timers } = setup()
    const first = client(1)
    bus.emit(updated(A))
    bus.emit(progress(B, 5))
    const second = fakeSender(2, timers)
    const snapshot = bus.subscribe(second.sender, 'b', (seq) => ({ seq }))
    expect(snapshot).toEqual({ seq: 2 })
    expect(first.events().map((event) => event.seq)).toEqual([1, 2])
    expect(second.received).toHaveLength(0)
    bus.emit(updated(C))
    bus.flush()
    expect(first.events().map((event) => event.seq)).toEqual([1, 2, 3])
    expect(second.events().map((event) => event.seq)).toEqual([3])
  })

  it('drops a registration on a cross-document main-frame navigation only', () =>
  {
    const { bus, client } = setup()
    const first = client(1)
    first.navigate({ isMainFrame: true, isSameDocument: true })
    first.navigate({ isMainFrame: false, isSameDocument: false })
    expect(bus.registrations()).toHaveLength(1)
    first.navigate({ isMainFrame: true, isSameDocument: false })
    expect(bus.registrations()).toEqual([])
    expect(first.listeners()).toBe(0)
    bus.emit(updated(A))
    bus.flush()
    expect(first.received).toHaveLength(0)
  })

  it('ignores a stale unsubscribe and removes the registration it names', () =>
  {
    const { bus, client } = setup()
    const first = client(1, 'a')
    bus.subscribe(first.sender, 'b', () => null)
    expect(bus.unsubscribe(1, 'a')).toBe(false)
    expect(bus.unsubscribe(2, 'b')).toBe(false)
    expect(bus.registrations()).toEqual([{ senderId: 1, clientId: 'b' }])
    expect(bus.unsubscribe(1, 'b')).toBe(true)
    expect(bus.registrations()).toEqual([])
    expect(first.listeners()).toBe(0)
  })

  it('survives the subscribe, unsubscribe, subscribe sequence of a double effect', () =>
  {
    const { bus, timers } = setup()
    const page = fakeSender(1, timers)
    bus.subscribe(page.sender, 'first', () => null)
    expect(bus.unsubscribe(1, 'first')).toBe(true)
    bus.subscribe(page.sender, 'second', () => null)
    expect(bus.registrations()).toEqual([{ senderId: 1, clientId: 'second' }])
    expect(page.listeners()).toBe(2)
  })

  it('keeps the new registration when a replaced one reports late', () =>
  {
    const { bus, client } = setup()
    const first = client(1, 'a', { keepListeners: true })
    bus.subscribe(first.sender, 'b', () => null)
    first.destroy()
    expect(bus.registrations()).toEqual([])
    const again = client(2, 'c', { keepListeners: true })
    bus.subscribe(again.sender, 'd', () => null)
    again.navigate({ isMainFrame: true, isSameDocument: false })
    expect(bus.registrations()).toEqual([])
    expect(bus.unsubscribe(2, 'd')).toBe(false)
  })

  it('drops a destroyed window, and a window whose send throws, without disturbing others', () =>
  {
    const { bus, client, log } = setup()
    const gone = client(1)
    const failing = client(2)
    const healthy = client(3)
    gone.destroy()
    expect(bus.registrations().map((reg) => reg.senderId)).toEqual([2, 3])
    failing.failWith(new Error('Object has been destroyed'))
    bus.emit(updated(A))
    bus.flush()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('window 2: Object has been destroyed'))
    expect(bus.registrations().map((reg) => reg.senderId)).toEqual([3])
    expect(healthy.received).toHaveLength(1)

    healthy.markDestroyed()
    bus.emit(updated(B))
    bus.flush()
    expect(healthy.received).toHaveLength(1)
    expect(bus.registrations()).toEqual([])

    const thrower = client(4)
    thrower.failWith('closed' as unknown as Error)
    bus.emit(updated(C))
    bus.flush()
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('window 4: closed'))
  })

  it('returns the snapshot without registering a destroyed window', () =>
  {
    const { bus, timers } = setup()
    const page = fakeSender(1, timers)
    page.markDestroyed()
    expect(bus.subscribe(page.sender, 'a', (seq) => seq)).toBe(0)
    expect(bus.registrations()).toEqual([])
    expect(page.listeners()).toBe(0)
  })

  it('dispose stops every timer and registration', () =>
  {
    const { bus, client, timers } = setup()
    const first = client(1)
    bus.emit(updated(A))
    bus.emit(progress(B, 1))
    expect(timers.pending()).toBe(2)
    bus.dispose()
    expect(timers.pending()).toBe(0)
    expect(bus.registrations()).toEqual([])
    expect(first.listeners()).toBe(0)
    expect(bus.flush()).toBe(0)
    expect(first.received).toHaveLength(0)
  })
})
