/**
 * The injected clock and timers: the real implementation, the shared sleep, and the manual scheduler every engine
 * and exec test drives instead of real time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { realTimers, sleepOn } from '../../src/main/timers'
import { createManualTimers } from './helpers/manual-timers'

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('realTimers', () =>
{
  it('reads the system clock', () =>
  {
    const before = Date.now()
    const now = realTimers.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })

  it('schedules and cancels through the platform timers', () =>
  {
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const fn = vi.fn()
    const handle = realTimers.setTimeout(fn, 60000)
    expect(set).toHaveBeenCalledWith(fn, 60000)
    realTimers.clearTimeout(handle)
    expect(clear).toHaveBeenCalledWith(handle)
    expect(fn).not.toHaveBeenCalled()
  })

  it('sleeps on a real timer', async () =>
  {
    await expect(realTimers.sleep(1)).resolves.toBeUndefined()
  })

  it('stops sleeping when the signal aborts and clears the timer', async () =>
  {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const sleeping = realTimers.sleep(60000, controller.signal)
    controller.abort()
    await expect(sleeping).resolves.toBeUndefined()
    expect(clear).toHaveBeenCalledTimes(1)
  })
})

describe('sleepOn', () =>
{
  it('resolves once the time has passed', async () =>
  {
    const timers = createManualTimers()
    const done = vi.fn()
    void sleepOn(timers, 1000).then(done)
    await timers.advance(999)
    expect(done).not.toHaveBeenCalled()
    await timers.advance(1)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('resolves at once for a signal that already aborted, scheduling nothing', async () =>
  {
    const timers = createManualTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(sleepOn(timers, 1000, controller.signal)).resolves.toBeUndefined()
    expect(timers.pending()).toBe(0)
  })

  it('resolves early on abort, never rejects, and cancels its timer', async () =>
  {
    const timers = createManualTimers()
    const controller = new AbortController()
    const done = vi.fn()
    void sleepOn(timers, 30000, controller.signal).then(done)
    await timers.advance(10)
    expect(timers.pending()).toBe(1)
    controller.abort()
    await timers.flush()
    expect(done).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBe(0)
    expect(timers.now()).toBe(10)
  })

  it('drops its abort listener once the time has passed', async () =>
  {
    const timers = createManualTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const sleeping = sleepOn(timers, 50, controller.signal)
    await timers.advance(50)
    await expect(sleeping).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    expect(timers.pending()).toBe(0)
  })
})

describe('manual timers', () =>
{
  it('starts its clock where it is told and moves only through advance', async () =>
  {
    const timers = createManualTimers(5000)
    expect(timers.now()).toBe(5000)
    await timers.advance(250)
    expect(timers.now()).toBe(5250)
    await timers.advance(0)
    expect(timers.now()).toBe(5250)
  })

  it('runs due callbacks in time order, and callbacks due together in the order they were set', async () =>
  {
    const timers = createManualTimers()
    const order: string[] = []
    timers.setTimeout(() => order.push(`c at ${timers.now()}`), 300)
    timers.setTimeout(() => order.push(`a at ${timers.now()}`), 100)
    timers.setTimeout(() => order.push(`b at ${timers.now()}`), 100)
    timers.setTimeout(() => order.push(`d at ${timers.now()}`), 400)
    expect(timers.next()).toBe(100)
    expect(timers.pending()).toBe(4)
    await timers.advance(300)
    expect(order).toEqual(['a at 100', 'b at 100', 'c at 300'])
    expect(timers.pending()).toBe(1)
    expect(timers.next()).toBe(400)
  })

  it('runs callbacks that fall due inside the advanced window, even when set during it', async () =>
  {
    const timers = createManualTimers()
    const order: number[] = []
    timers.setTimeout(() =>
    {
      order.push(timers.now())
      timers.setTimeout(() => order.push(timers.now()), 50)
      timers.setTimeout(() => order.push(timers.now()), 500)
    }, 100)
    await timers.advance(200)
    expect(order).toEqual([100, 150])
    await timers.advance(400)
    expect(order).toEqual([100, 150, 600])
  })

  it('lets promise chains settle between callbacks', async () =>
  {
    const timers = createManualTimers()
    const seen: number[] = []
    const chain = async (): Promise<void> =>
    {
      await timers.sleep(100)
      await Promise.resolve()
      await Promise.resolve()
      seen.push(timers.now())
      await timers.sleep(100)
      seen.push(timers.now())
    }
    const running = chain()
    await timers.advance(250)
    expect(seen).toEqual([100, 200])
    await running
  })

  it('cancels a timer and ignores unknown handles', async () =>
  {
    const timers = createManualTimers()
    const fn = vi.fn()
    const handle = timers.setTimeout(fn, 100)
    timers.clearTimeout('not a handle')
    timers.clearTimeout(handle)
    timers.clearTimeout(handle)
    await timers.advance(1000)
    expect(fn).not.toHaveBeenCalled()
    expect(timers.next()).toBeNull()
  })

  it('treats negative and non-finite delays as zero', async () =>
  {
    const timers = createManualTimers()
    const fn = vi.fn()
    timers.setTimeout(fn, -5)
    timers.setTimeout(fn, Number.NaN)
    expect(timers.next()).toBe(0)
    await timers.advance(0)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('refuses to move the clock backward or by a non-finite amount', async () =>
  {
    const timers = createManualTimers()
    await expect(timers.advance(-1)).rejects.toThrow(RangeError)
    await expect(timers.advance(Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError)
  })

  it('runs everything with runAll, and stops a timer that keeps rescheduling itself', async () =>
  {
    const timers = createManualTimers()
    const fn = vi.fn()
    timers.setTimeout(fn, 10)
    timers.setTimeout(fn, 60000)
    await timers.runAll()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(timers.now()).toBe(60000)

    const tick = (): void =>
    {
      timers.setTimeout(tick, 50)
    }
    tick()
    await expect(timers.runAll(20)).rejects.toThrow('runAll stopped after 20 callbacks')
  })

  it('runs a periodic timer as often as the window allows', async () =>
  {
    const timers = createManualTimers()
    let ticks = 0
    const tick = (): void =>
    {
      ticks++
      timers.setTimeout(tick, 50)
    }
    timers.setTimeout(tick, 50)
    await timers.advance(600000)
    expect(ticks).toBe(12000)
  })

  it('stops a zero-delay timer that keeps rescheduling itself at one instant', async () =>
  {
    const timers = createManualTimers()
    const spin = (): void =>
    {
      timers.setTimeout(spin, 0)
    }
    timers.setTimeout(spin, 10)
    await expect(timers.advance(20)).rejects.toThrow('a zero-delay timer keeps rescheduling itself')
  })
})
