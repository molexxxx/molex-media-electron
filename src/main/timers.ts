/**
 * The clock and scheduling seam. Everything in the main process that waits (the job engine, its file operation
 * retries, and the FFmpeg exec wrapper) takes a `Timers`, so tests drive every wait with a manual scheduler
 * instead of real time.
 */

/** The opaque handle `Timers.setTimeout` returns. */
export type TimerHandle = unknown

/** A clock plus one-shot timers. */
export interface Timers
{
  /** Milliseconds since the Unix epoch. */
  now(): number
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  /**
   * Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. It never rejects, so a caller checks
   * `signal.aborted` after the await.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** `Timers.sleep` built on a `setTimeout` and `clearTimeout` pair, shared by every `Timers` implementation. */
export function sleepOn(timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>, ms: number, signal?: AbortSignal): Promise<void>
{
  return new Promise((resolve) =>
  {
    if (signal?.aborted)
    {
      resolve()
      return
    }
    const onAbort = (): void =>
    {
      timers.clearTimeout(handle)
      resolve()
    }
    const handle = timers.setTimeout(() =>
    {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The real clock and the platform's timers. */
export const realTimers: Timers =
{
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  sleep: (ms, signal) => sleepOn(realTimers, ms, signal)
}
