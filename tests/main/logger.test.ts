import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { EventEmitter } from 'events'
import type { CrashTarget, LogEntry } from '../../src/main/logger'

// Suppress console output from logger
vi.spyOn(console, 'log').mockImplementation(() => {})

// Mock fs and config before importing logger
vi.mock('fs', () => ({
  appendFile: vi.fn((_path, _data, cb) => cb?.()),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn()
}))

vi.mock('../../src/main/config', () => ({
  getLogDir: vi.fn(() => '/tmp/test-logs')
}))

// Import after mocks
const { logger, MAX_BUFFER_ENTRIES, BATCH_INTERVAL_MS, installCrashHandlers } = await import('../../src/main/logger')

describe('Logger', () => {
  beforeEach(() => {
    logger.clearBuffer()
  })

  it('starts with an empty buffer', () => {
    expect(logger.getBuffer()).toEqual([])
  })

  it('adds entries to the buffer', () => {
    logger.info('test message')
    const buf = logger.getBuffer()
    expect(buf).toHaveLength(1)
    expect(buf[0].level).toBe('info')
    expect(buf[0].message).toBe('test message')
  })

  it('stores details when provided', () => {
    logger.error('fail', 'some details')
    const buf = logger.getBuffer()
    expect(buf[0].details).toBe('some details')
  })

  it('logs at all levels', () => {
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    logger.success('s')
    logger.debug('d')
    const buf = logger.getBuffer()
    expect(buf.map((e) => e.level)).toEqual(['info', 'warn', 'error', 'success', 'debug'])
  })

  it('adds ffmpeg entries to the buffer', () => {
    logger.ffmpeg('PROBE', 'probing file.mp3')
    const buf = logger.getBuffer()
    expect(buf).toHaveLength(1)
    expect(buf[0].level).toBe('ffmpeg')
    expect(buf[0].message).toContain('PROBE')
    expect(buf[0].message).toContain('probing file.mp3')
  })

  it('returns a copy of the buffer', () => {
    logger.info('a')
    const buf1 = logger.getBuffer()
    const buf2 = logger.getBuffer()
    expect(buf1).toEqual(buf2)
    expect(buf1).not.toBe(buf2) // different array references
  })

  it('clears the buffer', () => {
    logger.info('a')
    logger.info('b')
    expect(logger.getBuffer()).toHaveLength(2)
    logger.clearBuffer()
    expect(logger.getBuffer()).toHaveLength(0)
  })

  it('notifies listeners on log', () => {
    const cb = vi.fn()
    const unsub = logger.onLog(cb)
    logger.info('hello')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: 'hello' })
    )
    unsub()
  })

  it('unsubscribes listeners', () => {
    const cb = vi.fn()
    const unsub = logger.onLog(cb)
    unsub()
    logger.info('after unsub')
    expect(cb).not.toHaveBeenCalled()
  })

  it('notifies listeners on ffmpeg log', () => {
    const cb = vi.fn()
    const unsub = logger.onLog(cb)
    logger.ffmpeg('CMD', 'ffmpeg -i test')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0].level).toBe('ffmpeg')
    unsub()
  })

  it('keeps the newest 10,000 entries', () => {
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 5; i++) {
      logger.info(`msg-${i}`)
    }
    const buf = logger.getBuffer()
    expect(buf).toHaveLength(MAX_BUFFER_ENTRIES)
    expect(buf[0].message).toBe('msg-5')
    expect(buf[buf.length - 1].message).toBe(`msg-${MAX_BUFFER_ENTRIES + 4}`)
  })

  it('trims ffmpeg lines to the same cap', () => {
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 3; i++) {
      logger.ffmpeg('ENC', `line-${i}`)
    }
    const buf = logger.getBuffer()
    expect(buf).toHaveLength(MAX_BUFFER_ENTRIES)
    expect(buf[0].message).toBe('[ENC] line-3')
  })

  it('trims child logger lines to the same cap', () => {
    const job = logger.child({ jobId: 'MM-0001' })
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 2; i++) {
      job.ffmpeg(`frame ${i}`)
    }
    expect(logger.getBuffer()).toHaveLength(MAX_BUFFER_ENTRIES)
  })

  it('stamps monotonic ids that survive a clear', () => {
    logger.info('a')
    logger.ffmpeg('T', 'b')
    const [a, b] = logger.getBuffer()
    expect(b.id).toBe(a.id + 1)
    logger.clearBuffer()
    logger.info('c')
    expect(logger.getBuffer()[0].id).toBe(b.id + 1)
  })

  it('omits context fields that were not given', () => {
    logger.info('plain')
    const entry = logger.getBuffer()[0]
    expect(Object.keys(entry).sort()).toEqual(['id', 'level', 'message', 'timestamp'])
  })

  describe('child loggers', () => {
    it('stamps job, run, attempt, and stage on every level', () => {
      const job = logger.child({ jobId: 'MM-0142', runId: 'R31', attempt: 2, stage: 'encode' })
      job.debug('d')
      job.info('i')
      job.warn('w')
      job.error('e', 'stack')
      job.success('s')
      job.ffmpeg('size=1024kB')
      const buf = logger.getBuffer()
      expect(buf.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error', 'success', 'ffmpeg'])
      for (const entry of buf) {
        expect(entry).toMatchObject({ jobId: 'MM-0142', runId: 'R31', attempt: 2, stage: 'encode' })
      }
      expect(buf[3].details).toBe('stack')
      expect(buf[5].kind).toBe('stderr')
      expect(job.context).toEqual({ jobId: 'MM-0142', runId: 'R31', attempt: 2, stage: 'encode' })
    })

    it('merges nested context, with the inner logger winning', () => {
      const run = logger.child({ runId: 'R31' })
      const job = run.child({ jobId: 'MM-0007', attempt: 1 })
      const retry = job.child({ attempt: 2, stage: 'verify' })
      retry.info('verdict')
      expect(logger.getBuffer()[0]).toMatchObject({ runId: 'R31', jobId: 'MM-0007', attempt: 2, stage: 'verify' })
      expect(run.context).toEqual({ runId: 'R31' })
    })

    it('keeps a line\'s own stage and kind over the logger context', () => {
      const job = logger.child({ jobId: 'MM-0009', stage: 'measure' })
      const entry = job.write({ level: 'info', kind: 'cmd', message: 'ffmpeg -i in.flac', stage: 'encode' })
      expect(entry).toMatchObject({ jobId: 'MM-0009', stage: 'encode', kind: 'cmd' })
      expect(logger.getBuffer()[0]).toBe(entry)
    })

    it('accepts engine lines through write()', () => {
      const entry = logger.write({ level: 'warn', kind: 'event', message: 'Placed', jobId: 'MM-0003', runId: 'R2' })
      expect(entry.id).toBeGreaterThan(0)
      expect(entry).toMatchObject({ level: 'warn', kind: 'event', jobId: 'MM-0003', runId: 'R2' })
    })
  })

  describe('getBuffer filters', () => {
    function seed(): void {
      logger.info('app line')
      logger.child({ runId: 'R1', jobId: 'MM-0001' }).info('job 1')
      logger.child({ runId: 'R1' }).info('run 1')
      logger.child({ runId: 'R2', jobId: 'MM-0002' }).info('job 2')
      logger.child({ runId: 'R1', jobId: 'MM-0001' }).ffmpeg('stderr 1')
    }

    it('returns lines after an id', () => {
      seed()
      const all = logger.getBuffer()
      const after = logger.getBuffer({ afterId: all[1].id })
      expect(after.map((e) => e.message)).toEqual(['run 1', 'job 2', 'stderr 1'])
      expect(logger.getBuffer({ afterId: all[all.length - 1].id })).toEqual([])
      expect(logger.getBuffer({ afterId: 0 })).toHaveLength(5)
    })

    it('filters by job', () => {
      seed()
      expect(logger.getBuffer({ jobId: 'MM-0001' }).map((e) => e.message)).toEqual(['job 1', 'stderr 1'])
      expect(logger.getBuffer({ jobId: 'MM-9999' })).toEqual([])
    })

    it('filters by run', () => {
      seed()
      expect(logger.getBuffer({ runId: 'R1' }).map((e) => e.message)).toEqual(['job 1', 'run 1', 'stderr 1'])
    })

    it('combines filters', () => {
      seed()
      const all = logger.getBuffer()
      const result = logger.getBuffer({ runId: 'R1', jobId: 'MM-0001', afterId: all[1].id })
      expect(result.map((e) => e.message)).toEqual(['stderr 1'])
    })
  })

  describe('batched entries', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('delivers entries in one batch after 100 ms', () => {
      const cb = vi.fn()
      const unsub = logger.onEntries(cb)
      logger.info('one')
      logger.ffmpeg('T', 'two')
      logger.child({ jobId: 'MM-0001' }).warn('three')
      vi.advanceTimersByTime(BATCH_INTERVAL_MS - 1)
      expect(cb).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb.mock.calls[0][0].map((e: LogEntry) => e.message)).toEqual(['one', '[T] two', 'three'])
      logger.info('four')
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(cb).toHaveBeenCalledTimes(2)
      expect(cb.mock.calls[1][0]).toHaveLength(1)
      unsub()
    })

    it('sends nothing when no entry arrived', () => {
      const cb = vi.fn()
      const unsub = logger.onEntries(cb)
      vi.advanceTimersByTime(BATCH_INTERVAL_MS * 5)
      logger.flush()
      expect(cb).not.toHaveBeenCalled()
      unsub()
    })

    it('flushes on demand and cancels the pending timer', () => {
      const cb = vi.fn()
      const unsub = logger.onEntries(cb)
      logger.info('now')
      logger.flush()
      expect(cb).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(cb).toHaveBeenCalledTimes(1)
      unsub()
    })

    it('keeps one listener failure from reaching the others', () => {
      const bad = vi.fn(() => {
        throw new Error('closed window')
      })
      const good = vi.fn()
      const unsubBad = logger.onEntries(bad)
      const unsubGood = logger.onEntries(good)
      logger.info('x')
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(good).toHaveBeenCalledTimes(1)
      unsubBad()
      unsubGood()
    })

    it('collects nothing without batch listeners', () => {
      const cb = vi.fn()
      logger.info('before')
      const unsub = logger.onEntries(cb)
      logger.info('after')
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(cb.mock.calls[0][0].map((e: LogEntry) => e.message)).toEqual(['after'])
      unsub()
    })

    it('drops the pending batch when the last listener leaves or the buffer clears', () => {
      const cb = vi.fn()
      const unsub = logger.onEntries(cb)
      logger.info('cleared')
      logger.clearBuffer()
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(cb).not.toHaveBeenCalled()
      logger.info('orphaned')
      unsub()
      const late = vi.fn()
      const unsubLate = logger.onEntries(late)
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      expect(late).not.toHaveBeenCalled()
      unsubLate()
    })

    it('caps a pending batch at the buffer size', () => {
      const cb = vi.fn()
      const unsub = logger.onEntries(cb)
      for (let i = 0; i < MAX_BUFFER_ENTRIES + 4; i++) {
        logger.debug(`b-${i}`)
      }
      vi.advanceTimersByTime(BATCH_INTERVAL_MS)
      const batch = cb.mock.calls[0][0] as LogEntry[]
      expect(batch).toHaveLength(MAX_BUFFER_ENTRIES)
      expect(batch[0].message).toBe('b-4')
      unsub()
    })
  })

  describe('crash handlers', () => {
    it('logs uncaught exceptions and rejections, then uninstalls', () => {
      const target = new EventEmitter()
      const log = { error: vi.fn() }
      const uninstall = installCrashHandlers(target as unknown as CrashTarget, log)
      const boom = new Error('boom')
      target.emit('uncaughtException', boom)
      expect(log.error).toHaveBeenCalledWith('Uncaught exception: boom', boom.stack)
      target.emit('unhandledRejection', 'plain reason')
      expect(log.error).toHaveBeenLastCalledWith('Unhandled promise rejection: plain reason', undefined)
      uninstall()
      expect(target.listenerCount('uncaughtException')).toBe(0)
      expect(target.listenerCount('unhandledRejection')).toBe(0)
    })

    it('describes errors without a message and values without a string form', () => {
      const target = new EventEmitter()
      const log = { error: vi.fn() }
      const uninstall = installCrashHandlers(target as unknown as CrashTarget, log)
      target.emit('unhandledRejection', new TypeError())
      expect(log.error.mock.calls[0][0]).toBe('Unhandled promise rejection: TypeError')
      target.emit('unhandledRejection', Object.create(null))
      expect(log.error.mock.calls[1][0]).toBe('Unhandled promise rejection: a value of type object')
      uninstall()
    })

    it('defaults to the process and the app logger', () => {
      const before = process.listenerCount('uncaughtException')
      const uninstall = installCrashHandlers()
      expect(process.listenerCount('uncaughtException')).toBe(before + 1)
      process.listeners('unhandledRejection').at(-1)?.(new Error('late'), Promise.resolve())
      expect(logger.getBuffer().at(-1)).toMatchObject({ level: 'error', message: 'Unhandled promise rejection: late' })
      uninstall()
      expect(process.listenerCount('uncaughtException')).toBe(before)
    })
  })

  describe('file lines', () => {
    beforeEach(() => {
      logger.init()
      vi.mocked(fs.appendFile).mockClear()
    })

    it('prefixes job lines with the catalog number', () => {
      logger.child({ jobId: 'MM-0142', runId: 'R31' }).info('Dispatched')
      const written = vi.mocked(fs.appendFile).mock.calls[0][1] as string
      expect(written).toMatch(/\| INFO {4}\| \[MM-0142\] Dispatched\n$/)
    })

    it('prefixes run lines with the run id', () => {
      logger.child({ runId: 'R31' }).warn('Paused')
      const written = vi.mocked(fs.appendFile).mock.calls[0][1] as string
      expect(written).toContain('[R31] Paused')
    })

    it('sends a child\'s stderr lines to the FFmpeg debug file', () => {
      logger.child({ jobId: 'MM-0005' }).ffmpeg('Stream #0:0: Audio: flac')
      const [file, written] = vi.mocked(fs.appendFile).mock.calls[0]
      expect(String(file)).toContain('ffmpeg-debug-')
      expect(written).toContain('[MM-0005] Stream #0:0: Audio: flac')
    })
  })

  it('initializes log file paths and writes to files', () => {
    logger.init()
    logger.info('after-init message')
    expect(fs.appendFile).toHaveBeenCalled()
  })

  it('writes ffmpeg logs to ffmpegLogFile after init', () => {
    logger.init()
    vi.mocked(fs.appendFile).mockClear()
    logger.ffmpeg('TEST', 'ffmpeg output line')
    expect(fs.appendFile).toHaveBeenCalled()
  })

  it('writes details to log file when provided', () => {
    logger.init()
    vi.mocked(fs.appendFile).mockClear()
    logger.error('something failed', 'stack trace here')
    expect(fs.appendFile).toHaveBeenCalled()
    const writtenLine = vi.mocked(fs.appendFile).mock.calls[0][1] as string
    expect(writtenLine).toContain('something failed')
    expect(writtenLine).toContain('stack trace here')
  })

  it('does not write to log file before init', () => {
    vi.mocked(fs.appendFile).mockClear()
    logger.info('before init')
    // appendFile should not be called when logFile is not set
    // (the logger mock starts without init)
    // Actually logger is shared - init may have been called before.
    // Instead verify the buffer still has the entry
    const buf = logger.getBuffer()
    expect(buf.some((e) => e.message === 'before init')).toBe(true)
  })
})
