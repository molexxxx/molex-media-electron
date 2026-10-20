/**
 * The engine's files on real temp folders: snapshots with their `.tmp` and `.bak` fallbacks, journal segments replayed
 * by line number, compactions interrupted at every step, the write queue with group commit and its drop limit, counter
 * blocks, schema migrations, and the synchronous session-end append.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceIO, Timers } from '../../../src/main/jobs/deps'
import {
  COUNTER_BLOCK,
  createNodePersistenceIO,
  JobStore,
  jobsPaths,
  jsonLine,
  migrate,
  parseJsonLines,
  PERSISTENCE_SCHEMA,
  readJson,
  readJsonLines,
  readVersioned,
  rewriteJsonLines,
  STORE_LIMITS,
  writeJsonAtomic,
  writeVersioned
} from '../../../src/main/jobs/persistence'
import type { JobStoreOptions, LoadedState, Migrations, PersistenceAlert } from '../../../src/main/jobs/persistence'

type Op = keyof PersistenceIO

interface Call
{
  op: Op
  path: string
  text?: string
}

/** The real IO with every call recorded; `hook` runs first and may throw to fail the call or freeze it forever. */
interface TestIO extends PersistenceIO
{
  calls: Call[]
  hook: ((op: Op, path: string) => void | 'freeze' | Promise<void>) | null
  /** Resolves once no call is in flight. */
  idle(): Promise<void>
  /** The recorded calls of one kind, as `op path` strings. */
  ops(...kinds: Op[]): string[]
  clear(): void
}

interface ManualTimers extends Timers
{
  /** Runs every timer due within `ms` in time order, letting file work settle around each. */
  advance(ms: number): Promise<void>
  /** The delays of the armed timers. */
  delays(): number[]
}

interface Body
{
  jobs: Record<string, string>
  order: string[]
  fins: string[]
}

type Entry =
  | { type: 'job'; id: string; state: string; ratio?: number }
  | { type: 'order'; order: string[] }
  | { type: 'fin'; id: string; step: string }
  | { type: 'session-end' }

interface Harness
{
  dir: string
  io: TestIO
  timers: ManualTimers
  log: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  alerts: PersistenceAlert[]
  body: Body
  idle: { value: boolean }
  writable: ReturnType<typeof vi.fn>
  store: JobStore<Body, Entry>
}

const START = Date.UTC(2026, 9, 17, 12, 0, 0)

let root = ''

beforeEach(() =>
{
  root = mkdtempSync(join(tmpdir(), 'molex-persistence-'))
})

afterEach(() =>
{
  rmSync(root, { recursive: true, force: true })
})

function fsError(code: string): NodeJS.ErrnoException
{
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  err.code = code
  return err
}

function codeOf(err: unknown): string | undefined
{
  return (err as NodeJS.ErrnoException | undefined)?.code
}

async function macrotask(): Promise<void>
{
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function testIO(dir: string): TestIO
{
  const base = createNodePersistenceIO()
  const running = new Set<Promise<unknown>>()
  const rel = (path: string): string => relative(dir, path).split(sep).join('/') || '.'
  const io: TestIO = {
    calls: [],
    hook: null,
    async idle()
    {
      for (let turn = 0; turn < 1000; turn++)
      {
        if (running.size > 0)
        {
          await Promise.allSettled([...running])
        }
        await macrotask()
        if (running.size === 0)
        {
          return
        }
      }
      throw new Error('file work never settled')
    },
    ops(...kinds)
    {
      return io.calls
        .filter((call) => kinds.length === 0 || kinds.includes(call.op))
        .map((call) => (call.op === 'rename' ? `rename ${call.path} > ${call.text}` : `${call.op} ${call.path}`))
    },
    clear()
    {
      io.calls = []
    },
    append: (path, text) => run('append', path, () => base.append(path, text), text),
    appendSync(path, text)
    {
      io.calls.push({ op: 'appendSync', path: rel(path), text })
      if (io.hook?.('appendSync', path) === 'freeze')
      {
        throw new Error('appendSync cannot freeze')
      }
      base.appendSync(path, text)
    },
    fsync: (path) => run('fsync', path, () => base.fsync(path)),
    writeAtomic: (path, text) => run('writeAtomic', path, () => base.writeAtomic(path, text), text),
    read: (path) => run('read', path, () => base.read(path)),
    list: (path) => run('list', path, () => base.list(path)),
    rename: (from, to) => run('rename', from, () => base.rename(from, to), rel(to)),
    unlink: (path) => run('unlink', path, () => base.unlink(path)),
    mkdir: (path) => run('mkdir', path, () => base.mkdir(path))
  }
  function run<T>(op: Op, path: string, call: () => Promise<T>, text?: string): Promise<T>
  {
    io.calls.push(text === undefined ? { op, path: rel(path) } : { op, path: rel(path), text })
    let verdict: void | 'freeze' | Promise<void>
    try
    {
      verdict = io.hook?.(op, path)
    }
    catch (err)
    {
      return Promise.reject(err)
    }
    if (verdict === 'freeze')
    {
      return new Promise<T>(() => undefined)
    }
    const start = (): Promise<T> =>
    {
      const promise = call()
      const done = (): void =>
      {
        running.delete(promise)
      }
      running.add(promise)
      promise.then(done, done)
      return promise
    }
    return verdict instanceof Promise ? verdict.then(start) : start()
  }
  return io
}

function manualTimers(io: TestIO): ManualTimers
{
  let now = START
  let seq = 0
  const armed = new Map<number, { at: number; fn: () => void }>()
  const timers: ManualTimers = {
    now: () => now,
    setTimeout(fn, ms)
    {
      seq += 1
      armed.set(seq, { at: now + ms, fn })
      return seq
    },
    clearTimeout(handle)
    {
      armed.delete(handle as number)
    },
    sleep: (ms) => new Promise<void>((resolve) =>
    {
      timers.setTimeout(resolve, ms)
    }),
    async advance(ms)
    {
      const until = now + ms
      for (;;)
      {
        await io.idle()
        const next = [...armed.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (next === undefined)
        {
          break
        }
        armed.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = until
      await io.idle()
    },
    delays: () => [...armed.values()].map((timer) => timer.at - now).sort((a, b) => a - b)
  }
  return timers
}

function deferred(): { promise: Promise<void>; resolve(): void }
{
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) =>
  {
    resolve = done
  })
  return { promise, resolve }
}

function emptyBody(): Body
{
  return { jobs: {}, order: [], fins: [] }
}

function apply(body: Body, entry: Entry): void
{
  switch (entry.type)
  {
    case 'job':
      body.jobs[entry.id] = entry.state
      break
    case 'order':
      body.order = [...entry.order]
      break
    case 'fin':
      body.fins.push(`${entry.id}:${entry.step}`)
      break
    default:
      break
  }
}

/** The state a loaded store's engine would rebuild: the snapshot body with every replayed line on top. */
function rebuild(loaded: LoadedState<Body, Entry>): Body
{
  const body: Body = loaded.body === null ? emptyBody() : JSON.parse(JSON.stringify(loaded.body)) as Body
  for (const line of loaded.lines)
  {
    apply(body, line)
  }
  return body
}

function open(dir: string, over: Partial<JobStoreOptions<Body>> = {}): Harness
{
  const io = testIO(dir)
  const timers = manualTimers(io)
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const alerts: PersistenceAlert[] = []
  const body = emptyBody()
  const idle = { value: true }
  const writable = vi.fn()
  const store = new JobStore<Body, Entry>({
    io,
    dir,
    platform: 'win32',
    timers,
    log,
    pid: 4242,
    snapshot: () => JSON.parse(JSON.stringify(body)) as Body,
    isIdle: () => idle.value,
    onAlert: (alert) => alerts.push(alert),
    onWritable: writable,
    ...over
  })
  return { dir, io, timers, log, alerts, body, idle, writable, store }
}

/** Appends an entry and applies it to the in-memory state, as the engine does. */
function record(h: Harness, entry: Entry): number
{
  apply(h.body, entry)
  return h.store.append(entry)
}

function job(id: string, state: string): Entry
{
  return { type: 'job', id, state }
}

/** Stops a store dead: every later file call of its IO hangs, as a killed process leaves it. */
function crash(h: Harness): void
{
  h.io.hook = () => 'freeze'
}

function jobsDir(): string
{
  return join(root, 'jobs')
}

function file(...parts: string[]): string
{
  return readFileSync(join(jobsDir(), ...parts), 'utf8')
}

function journalNames(name = 'journal'): string[]
{
  const dir = join(jobsDir(), name)
  return existsSync(dir) ? readdirSync(dir).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)) : []
}

function segmentLines(name: string, folder = 'journal'): Array<Record<string, unknown>>
{
  return parseJsonLines(file(folder, name)).values as Array<Record<string, unknown>>
}

function writeSegment(name: string, lines: readonly unknown[], tail = '', folder = 'journal'): void
{
  mkdirSync(join(jobsDir(), folder), { recursive: true })
  writeFileSync(join(jobsDir(), folder, name), lines.map((line) => `${JSON.stringify(line)}\n`).join('') + tail)
}

function writeSnapshot(name: string, lastN: number, body: Body, extra: Record<string, unknown> = {}): void
{
  mkdirSync(jobsDir(), { recursive: true })
  writeFileSync(join(jobsDir(), name), JSON.stringify({ schema: PERSISTENCE_SCHEMA, lastN, savedAt: START, counters: { catalog: 0, run: 0 }, ...body, ...extra }))
}

describe('createNodePersistenceIO', () =>
{
  it('appends, reads, lists, renames, and unlinks real files', async () =>
  {
    const io = createNodePersistenceIO()
    const nested = join(root, 'a', 'b')
    await io.mkdir(nested)
    await io.mkdir(nested)
    const path = join(nested, 'lines.jsonl')
    await io.append(path, 'one\n')
    await io.append(path, 'two\n')
    expect(await io.read(path)).toBe('one\ntwo\n')
    expect(await io.list(nested)).toEqual(['lines.jsonl'])
    await io.rename(path, join(nested, 'moved.jsonl'))
    expect(await io.read(path)).toBeNull()
    await io.unlink(join(nested, 'moved.jsonl'))
    expect(await io.list(nested)).toEqual([])
  })

  it('reads a missing file as null and a missing folder as empty, and rethrows other errors', async () =>
  {
    const io = createNodePersistenceIO()
    expect(await io.read(join(root, 'none.json'))).toBeNull()
    expect(await io.list(join(root, 'none'))).toEqual([])
    writeFileSync(join(root, 'plain.txt'), 'x')
    await expect(io.read(root)).rejects.toMatchObject({ code: expect.any(String) })
    await expect(io.list(join(root, 'plain.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(io.unlink(join(root, 'none.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('appends synchronously, so the text is on disk when the call returns', () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'end.jsonl')
    io.appendSync(path, 'a\n')
    io.appendSync(path, 'b\n')
    expect(readFileSync(path, 'utf8')).toBe('a\nb\n')
  })

  it('syncs a file and a folder, and rejects a missing file', async () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'synced.json')
    writeFileSync(path, '{}')
    await expect(io.fsync(path)).resolves.toBeUndefined()
    await expect(io.fsync(root)).resolves.toBeUndefined()
    await expect(io.fsync(join(root, 'none.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes atomically through a synced temporary file it leaves no trace of', async () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'presets.json')
    await io.writeAtomic(path, 'first')
    await io.writeAtomic(path, 'second')
    expect(readFileSync(path, 'utf8')).toBe('second')
    expect(readdirSync(root)).toEqual(['presets.json'])
  })
})

describe('JSON line and file helpers', () =>
{
  it('passes every line through toWire, so non-finite numbers and holes become null', () =>
  {
    expect(jsonLine({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: undefined, d: [1, undefined], e: 'x' })).toBe('{"a":null,"b":null,"c":null,"d":[1,null],"e":"x"}\n')
  })

  it('parses lines, skipping blanks, counting unreadable lines, and flagging a torn last line', () =>
  {
    expect(parseJsonLines('{"a":1}\n\n{"a":2}\n')).toEqual({ values: [{ a: 1 }, { a: 2 }], skipped: 0, torn: false })
    expect(parseJsonLines('{"a":1}\nnot json\n{"a":2}\n{"a":')).toEqual({ values: [{ a: 1 }, { a: 2 }], skipped: 1, torn: true })
    expect(parseJsonLines('')).toEqual({ values: [], skipped: 0, torn: false })
  })

  it('reads a missing lines file as empty and rewrites one atomically', async () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'workdirs.jsonl')
    expect(await readJsonLines(io, path)).toEqual({ values: [], skipped: 0, torn: false })
    await io.append(path, 'stale\n')
    await rewriteJsonLines(io, path, [{ token: 'a', size: Number.NaN }, { token: 'b' }])
    expect(readFileSync(path, 'utf8')).toBe('{"token":"a","size":null}\n{"token":"b"}\n')
    expect((await readJsonLines(io, path)).values).toEqual([{ token: 'a', size: null }, { token: 'b' }])
  })

  it('writes JSON atomically through toWire and reads it back as ok, missing, or corrupt', async () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'index.json')
    expect(await readJson(io, path)).toEqual({ status: 'missing' })
    await writeJsonAtomic(io, path, [{ runId: 'R-0001', ratio: Number.NaN }])
    expect(await readJson(io, path)).toEqual({ status: 'ok', value: [{ runId: 'R-0001', ratio: null }] })
    writeFileSync(path, '[{"runId":')
    expect(await readJson(io, path)).toMatchObject({ status: 'corrupt', reason: expect.any(String) })
    expect(await readJson(io, root)).toMatchObject({ status: 'corrupt' })
  })

  it('lays out every file under the jobs folder', () =>
  {
    const paths = jobsPaths(join(root, 'jobs'))
    expect(relative(root, paths.state)).toBe(join('jobs', 'state.json'))
    expect(relative(root, paths.journal)).toBe(join('jobs', 'journal'))
    expect(relative(root, paths.workdirs)).toBe(join('jobs', 'workdirs.jsonl'))
    expect(relative(root, paths.session)).toBe(join('jobs', 'session.json'))
    expect(relative(root, paths.runsIndex)).toBe(join('jobs', 'runs', 'index.json'))
    expect(relative(root, paths.presets)).toBe(join('jobs', 'presets.json'))
    expect(relative(root, paths.history('R-0031' as never))).toBe(join('jobs', 'runs', 'R-0031.jsonl'))
    expect(relative(root, paths.attemptLog('R-0031' as never, 'MM-0142' as never, 2))).toBe(join('jobs', 'logs', 'R-0031', 'MM-0142-a2.log'))
  })
})

describe('schema migrations', () =>
{
  const steps: Migrations = {
    1: (file) => ({ ...file, renamed: file.old, old: undefined }),
    2: (file) => ({ ...file, added: true })
  }

  it('applies pure steps in order up to the target and never changes the input', () =>
  {
    const input = { schema: 1, old: 'value' }
    const result = migrate(input, steps, 3)
    expect(result).toEqual({ status: 'ok', file: { schema: 3, renamed: 'value', old: undefined, added: true } })
    expect(input).toEqual({ schema: 1, old: 'value' })
    expect(migrate({ schema: 2, renamed: 'v' }, steps, 3)).toEqual({ status: 'ok', file: { schema: 3, renamed: 'v', added: true } })
  })

  it('leaves the current schema as it is', () =>
  {
    const file = { schema: PERSISTENCE_SCHEMA, a: 1 }
    expect(migrate(file, {})).toEqual({ status: 'ok', file })
  })

  it('reports a newer schema without touching it', () =>
  {
    expect(migrate({ schema: PERSISTENCE_SCHEMA + 1 }, {})).toEqual({ status: 'newer', schema: PERSISTENCE_SCHEMA + 1 })
  })

  it('refuses values that are not versioned objects or that no step can bring forward', () =>
  {
    expect(migrate(null, {})).toEqual({ status: 'invalid', reason: 'not an object' })
    expect(migrate([1], {})).toEqual({ status: 'invalid', reason: 'not an object' })
    expect(migrate({ jobs: [] }, {})).toEqual({ status: 'invalid', reason: 'no schema version' })
    expect(migrate({ schema: 0 }, {})).toEqual({ status: 'invalid', reason: 'no schema version' })
    expect(migrate({ schema: 1.5 }, {})).toEqual({ status: 'invalid', reason: 'no schema version' })
    expect(migrate({ schema: 1 }, {}, 2)).toEqual({ status: 'invalid', reason: 'no migration from schema 1' })
  })

  it('reads and writes versioned files such as presets.json', async () =>
  {
    const io = createNodePersistenceIO()
    const path = join(root, 'presets.json')
    expect(await readVersioned(io, path, {})).toEqual({ status: 'missing' })
    await writeVersioned(io, path, { user: [], pins: { a: 'b' }, recent: [], gain: Number.NaN })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ user: [], pins: { a: 'b' }, recent: [], gain: null, schema: 1 })
    expect(await readVersioned(io, path, {})).toEqual({ status: 'ok', value: { user: [], pins: { a: 'b' }, recent: [], gain: null, schema: 1 } })
    writeFileSync(path, JSON.stringify({ schema: 9, user: [] }))
    expect(await readVersioned(io, path, {})).toEqual({ status: 'newer', schema: 9 })
    expect(readFileSync(path, 'utf8')).toBe('{"schema":9,"user":[]}')
    writeFileSync(path, JSON.stringify({ user: [] }))
    expect(await readVersioned(io, path, {})).toEqual({ status: 'corrupt', reason: 'no schema version' })
    writeFileSync(path, '{"schema":1,')
    expect(await readVersioned(io, path, {})).toMatchObject({ status: 'corrupt' })
  })
})

describe('JobStore basics', () =>
{
  it('round-trips the state through a snapshot and the journal lines after it', async () =>
  {
    const a = open(jobsDir())
    expect(await a.store.load()).toEqual({
      source: 'none',
      body: null,
      snapshotN: 0,
      savedAt: null,
      lines: [],
      gaps: [],
      counters: { catalog: 0, run: 0 },
      previous: null,
      newer: false,
      movedAside: []
    })
    record(a, job('MM-0001', 'pending'))
    record(a, job('MM-0002', 'pending'))
    record(a, { type: 'order', order: ['MM-0001', 'MM-0002'] })
    expect(await a.store.compact()).toBe(true)
    record(a, job('MM-0001', 'queued'))
    record(a, { type: 'fin', id: 'MM-0001', step: 'begin' })
    await a.store.flush()
    crash(a)

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded.source).toBe('state')
    expect(loaded.snapshotN).toBe(3)
    expect(loaded.savedAt).toBe(START)
    expect(loaded.lines.map((line) => line.n)).toEqual([4, 5])
    expect(loaded.lines[1]).toEqual({ n: 5, type: 'fin', id: 'MM-0001', step: 'begin' })
    expect(rebuild(loaded)).toEqual(a.body)
    expect(loaded.previous).toEqual({ pid: 4242, startedAt: START, cleanExit: false })
    expect(b.store.lastN).toBe(5)
    expect(b.store.append(job('MM-0002', 'queued'))).toBe(6)
  })

  it('closes with a final snapshot, records a clean exit, and refuses work afterwards', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    expect(JSON.parse(file('session.json'))).toEqual({ pid: 4242, startedAt: START, cleanExit: false })
    record(a, job('MM-0001', 'done'))
    expect(await a.store.close()).toBe(true)
    expect(JSON.parse(file('session.json'))).toEqual({ pid: 4242, startedAt: START, cleanExit: true })
    expect(JSON.parse(file('state.json'))).toEqual({
      schema: 1,
      lastN: 1,
      savedAt: START,
      counters: { catalog: 0, run: 0 },
      jobs: { 'MM-0001': 'done' },
      order: [],
      fins: []
    })
    expect(a.store.append(job('MM-0002', 'pending'))).toBe(1)
    expect(a.log.warn).toHaveBeenCalledWith('Dropped a job line after the job store closed')
    await expect(a.store.appendDurable([job('MM-0002', 'held')])).rejects.toThrow('closed')
    await expect(a.store.appendLines(a.store.paths.workdirs, [{ op: 'create' }])).rejects.toThrow('closed')
    await expect(a.store.reserve('catalog')).rejects.toThrow('closed')
    expect(await a.store.compact()).toBe(false)
    expect(await a.store.close()).toBe(false)
    a.store.runCompleted()
    expect(a.timers.delays()).toEqual([])

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded.previous).toEqual({ pid: 4242, startedAt: START, cleanExit: true })
    expect(loaded.lines).toEqual([])
    expect(rebuild(loaded)).toEqual({ jobs: { 'MM-0001': 'done' }, order: [], fins: [] })
  })

  it('refuses to append before loading and to load twice', async () =>
  {
    const a = open(jobsDir())
    expect(() => a.store.append(job('MM-0001', 'pending'))).toThrow('Load the job store before appending')
    expect(await a.store.compact()).toBe(false)
    expect(await a.store.close()).toBe(false)
    a.store.sessionEnd([job('MM-0001', 'interrupted')])
    expect(a.io.ops('appendSync')).toEqual([])
    await a.store.load()
    await expect(a.store.load()).rejects.toThrow('already loaded')
  })

  it('reports a session file it cannot read or parse as no previous session', async () =>
  {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(join(jobsDir(), 'session.json'), '{"pid":1,')
    expect((await open(jobsDir()).store.load()).previous).toBeNull()
    writeFileSync(join(jobsDir(), 'session.json'), '{"pid":"one","startedAt":1,"cleanExit":true}')
    expect((await open(jobsDir()).store.load()).previous).toBeNull()
    const c = open(jobsDir())
    c.io.hook = (op, path) =>
    {
      if (op === 'read' && path.endsWith('session.json'))
      {
        throw fsError('EACCES')
      }
    }
    expect((await c.store.load()).previous).toBeNull()
    expect(c.log.warn).toHaveBeenCalledWith('Could not read session.json: EACCES: simulated')
  })

  it('keeps going when session.json cannot be written', async () =>
  {
    const a = open(jobsDir())
    a.io.hook = (op) =>
    {
      if (op === 'writeAtomic')
      {
        throw fsError('EPERM')
      }
    }
    await a.store.load()
    expect(a.log.warn).toHaveBeenCalledWith('Could not write session.json: EPERM: simulated')
    record(a, job('MM-0001', 'done'))
    expect(await a.store.close()).toBe(false)
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(true)
  })
})

describe('JobStore write queue', () =>
{
  it('appends buffered lines as one batch 250 ms after the first, without an fsync', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.clear()
    expect(record(a, job('MM-0001', 'pending'))).toBe(1)
    expect(record(a, job('MM-0002', 'pending'))).toBe(2)
    expect(a.store.lastN).toBe(2)
    expect(a.store.health).toEqual({ writable: true, pendingBytes: expect.any(Number), journalBytes: expect.any(Number), newer: false })
    expect(a.store.health.pendingBytes).toBeGreaterThan(0)
    await a.timers.advance(249)
    expect(a.io.ops()).toEqual([])
    await a.timers.advance(1)
    expect(a.io.ops()).toEqual(['append journal/1.jsonl'])
    expect(segmentLines('1.jsonl')).toEqual([
      { n: 1, type: 'job', id: 'MM-0001', state: 'pending' },
      { n: 2, type: 'job', id: 'MM-0002', state: 'pending' }
    ])
    expect(a.store.health.pendingBytes).toBe(0)
  })

  it('writes a durable line with every buffered line before it and resolves only after the fsync', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.clear()
    record(a, job('MM-0001', 'queued'))
    record(a, job('MM-0002', 'queued'))
    const gate = deferred()
    a.io.hook = (op) => (op === 'fsync' ? gate.promise : undefined)
    let done = false
    const durable = a.store.appendDurable([{ type: 'fin', id: 'MM-0001', step: 'begin' }]).then((ns) =>
    {
      done = true
      return ns
    })
    await a.io.idle()
    expect(a.io.ops()).toEqual(['append journal/1.jsonl', 'fsync journal/1.jsonl'])
    expect(parseJsonLines(a.io.calls[0].text ?? '').values.map((line) => (line as { n: number }).n)).toEqual([1, 2, 3])
    expect(done).toBe(false)
    gate.resolve()
    expect(await durable).toEqual([3])
    expect(a.timers.delays()).toEqual([])
  })

  it('group-commits durable lines from the same moment into one write and one fsync', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.clear()
    const gate = deferred()
    a.io.hook = (op) => (op === 'fsync' ? gate.promise : undefined)
    const first = Array.from({ length: 16 }, (_, index) => a.store.appendDurable([{ type: 'fin', id: `MM-${index + 1}`, step: 'place' }]))
    await a.io.idle()
    const second = Array.from({ length: 4 }, (_, index) => a.store.appendDurable([{ type: 'fin', id: `MM-${index + 1}`, step: 'done' }]))
    await a.io.idle()
    expect(a.io.ops('append', 'fsync')).toEqual(['append journal/1.jsonl', 'fsync journal/1.jsonl'])
    gate.resolve()
    expect(await Promise.all(first)).toEqual(Array.from({ length: 16 }, (_, index) => [index + 1]))
    expect(await Promise.all(second)).toEqual(Array.from({ length: 4 }, (_, index) => [index + 17]))
    expect(a.io.ops('append', 'fsync')).toEqual(['append journal/1.jsonl', 'fsync journal/1.jsonl', 'append journal/1.jsonl', 'fsync journal/1.jsonl'])
    expect(segmentLines('1.jsonl').map((line) => line.n)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it('appends to other files through the queue; a durable append syncs every file written before it', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    a.io.clear()
    await a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record', schema: 1, ratio: Number.NaN }])
    expect(a.io.ops()).toEqual(['append runs/R-0001.jsonl'])
    expect(file('runs', 'R-0001.jsonl')).toBe('{"type":"record","schema":1,"ratio":null}\n')
    await a.store.appendLines(a.store.paths.workdirs, [{ op: 'create', token: 'a' }, { op: 'create', token: 'b' }], true)
    expect(a.io.ops()).toEqual(['append runs/R-0001.jsonl', 'append workdirs.jsonl', 'fsync runs/R-0001.jsonl', 'fsync workdirs.jsonl'])
    expect(file('workdirs.jsonl')).toBe('{"op":"create","token":"a"}\n{"op":"create","token":"b"}\n')
  })

  it('writes consecutive batches for one file in one append while an earlier write is in flight', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    a.io.clear()
    const gate = deferred()
    a.io.hook = (op, path) => (op === 'append' && path.endsWith('R-0001.jsonl') ? gate.promise : undefined)
    const history = a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record' }])
    record(a, job('MM-0001', 'queued'))
    await a.timers.advance(250)
    record(a, job('MM-0002', 'queued'))
    await a.timers.advance(250)
    record(a, job('MM-0003', 'queued'))
    const flushed = a.store.flush()
    gate.resolve()
    await history
    await flushed
    expect(a.io.ops('append')).toEqual(['append runs/R-0001.jsonl', 'append journal/1.jsonl'])
    expect(segmentLines('1.jsonl').map((line) => line.n)).toEqual([1, 2, 3])
  })

  it('creates a missing folder for an append once and writes the lines', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.clear()
    await a.store.appendLines(a.store.paths.history('R-0002' as never), [{ type: 'summary' }])
    expect(a.io.ops()).toEqual(['append runs/R-0002.jsonl', 'mkdir runs', 'append runs/R-0002.jsonl'])
    expect(file('runs', 'R-0002.jsonl')).toBe('{"type":"summary"}\n')
    expect(a.alerts).toEqual([])
  })

  it('syncs nothing for a file deleted after its write, as pruning a run leaves it', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    await a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record' }])
    rmSync(a.store.paths.history('R-0001' as never))
    a.io.clear()
    expect(await a.store.appendDurable([{ type: 'fin', id: 'a', step: 'begin' }])).toEqual([1])
    expect(a.io.ops()).toEqual(['append journal/1.jsonl', 'fsync runs/R-0001.jsonl', 'fsync journal/1.jsonl'])
    expect(a.alerts).toEqual([])
  })
})

describe('JobStore loader', () =>
{
  const body = (): Body => ({ jobs: { a: 'pending', b: 'pending' }, order: ['a', 'b'], fins: [] })

  it('replays every line after the snapshot from all segments in n order, each once', async () =>
  {
    writeSnapshot('state.json', 4, body())
    writeSegment('1.jsonl', [1, 2, 3, 4].map((n) => ({ n, type: 'job', id: 'a', state: 'pending' })))
    writeSegment('5.jsonl', [
      { n: 5, type: 'job', id: 'a', state: 'queued' },
      { n: 6, type: 'counter', counter: 'catalog', reserved: 200 },
      { n: 8, type: 'fin', id: 'a', step: 'begin' }
    ])
    writeSegment('7.jsonl', [
      { n: 7, type: 'job', id: 'b', state: 'queued' },
      { n: 8, type: 'fin', id: 'a', step: 'begin' },
      { n: 9, type: 'fin', id: 'a', step: 'done' },
      { n: 10, type: 'counter', counter: 'run', reserved: 100 }
    ])
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded.source).toBe('state')
    expect(loaded.lines.map((line) => line.n)).toEqual([5, 7, 8, 9])
    expect(loaded.gaps).toEqual([])
    expect(loaded.counters).toEqual({ catalog: 200, run: 100 })
    expect(rebuild(loaded)).toEqual({ jobs: { a: 'queued', b: 'queued' }, order: ['a', 'b'], fins: ['a:begin', 'a:done'] })
    expect(a.store.lastN).toBe(10)
    expect(a.store.health.journalBytes).toBeGreaterThan(0)
    record(a, job('a', 'done'))
    await a.store.flush()
    expect(journalNames()).toEqual(['1.jsonl', '5.jsonl', '7.jsonl', '11.jsonl'])
    expect(segmentLines('11.jsonl')).toEqual([{ n: 11, type: 'job', id: 'a', state: 'done' }])
  })

  it('logs a gap in the line numbers and replays the lines after it', async () =>
  {
    writeSegment('1.jsonl', [
      { n: 1, type: 'job', id: 'a', state: 'pending' },
      { n: 2, type: 'job', id: 'a', state: 'queued' },
      { n: 5, type: 'job', id: 'a', state: 'active' },
      { n: 6, type: 'job', id: 'a', state: 'done' }
    ])
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded.gaps).toEqual([{ from: 3, to: 4 }])
    expect(loaded.lines.map((line) => line.n)).toEqual([1, 2, 5, 6])
    expect(a.log.warn).toHaveBeenCalledWith('Journal lines 3 to 4 are missing; replay continues after them')
    expect(rebuild(loaded).jobs).toEqual({ a: 'done' })
  })

  it('ignores torn last lines and starts the next line of a torn segment on its own line', async () =>
  {
    writeSegment('1.jsonl', [{ n: 1, type: 'job', id: 'a', state: 'pending' }, { n: 2, type: 'job', id: 'a', state: 'queued' }], '{"n":3,"type":"jo')
    writeSegment('3.jsonl', [], '{"n":3,"ty')
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded.lines.map((line) => line.n)).toEqual([1, 2])
    expect(a.log.info).toHaveBeenCalledWith('Ignored a torn last line in journal segment 1.jsonl')
    expect(a.log.info).toHaveBeenCalledWith('Ignored a torn last line in journal segment 3.jsonl')
    record(a, job('a', 'active'))
    await a.store.flush()
    expect(file('journal', '3.jsonl')).toBe('{"n":3,"ty\n{"n":3,"type":"job","id":"a","state":"active"}\n')
    crash(a)
    const b = open(jobsDir())
    const again = await b.store.load()
    expect(again.lines.map((line) => line.n)).toEqual([1, 2, 3])
    expect(b.log.warn).toHaveBeenCalledWith('Skipped 1 unreadable lines in journal segment 3.jsonl')
    expect(rebuild(again).jobs).toEqual({ a: 'active' })
  })

  it('skips lines that parse but are not journal lines', async () =>
  {
    writeSegment('1.jsonl', [{ n: 1, type: 'job', id: 'a', state: 'pending' }, { type: 'job' }, { n: 0, type: 'job' }, { n: 2, kind: 'job' }, [1], { n: 2, type: 'counter', counter: 'other', reserved: 5 }])
    writeSegment('notes.txt', ['ignored'])
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded.lines.map((line) => line.n)).toEqual([1, 2])
    expect(loaded.counters).toEqual({ catalog: 0, run: 0 })
    expect(a.log.warn).toHaveBeenCalledWith('Skipped 4 unreadable lines in journal segment 1.jsonl')
  })

  it('falls back to a complete .tmp when state.json is missing or torn', async () =>
  {
    writeSnapshot('state.json.tmp', 2, body())
    writeSnapshot('state.json.bak', 1, { jobs: { a: 'old' }, order: [], fins: [] })
    writeSegment('1.jsonl', [1, 2, 3].map((n) => ({ n, type: 'job', id: 'b', state: `s${n}` })))
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded).toMatchObject({ source: 'tmp', snapshotN: 2 })
    expect(loaded.lines.map((line) => line.n)).toEqual([3])
    expect(rebuild(loaded).jobs).toEqual({ a: 'pending', b: 's3' })

    writeFileSync(join(jobsDir(), 'state.json'), '{"schema":1,"lastN":9,"jobs":')
    const b = open(jobsDir())
    expect(await b.store.load()).toMatchObject({ source: 'tmp', snapshotN: 2 })
    expect(b.log.warn).toHaveBeenCalledWith('Skipped state.json: incomplete JSON')
  })

  it('falls back to .bak when neither state.json nor .tmp is complete and valid', async () =>
  {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(join(jobsDir(), 'state.json'), JSON.stringify({ schema: 1, jobs: {} }))
    writeFileSync(join(jobsDir(), 'state.json.tmp'), '{"schema":1,"la')
    writeSnapshot('state.json.bak', 1, body())
    writeSegment('1.jsonl', [1, 2].map((n) => ({ n, type: 'job', id: 'b', state: `s${n}` })))
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded).toMatchObject({ source: 'bak', snapshotN: 1, movedAside: [] })
    expect(rebuild(loaded).jobs).toEqual({ a: 'pending', b: 's2' })
    expect(a.log.warn).toHaveBeenCalledWith('Skipped state.json: no line number')
    expect(a.log.warn).toHaveBeenCalledWith('Skipped state.json.tmp: incomplete JSON')
    expect(a.alerts).toEqual([])
  })

  it('treats a snapshot it cannot read as present and falls back past it', async () =>
  {
    writeSnapshot('state.json', 3, body())
    writeSnapshot('state.json.bak', 1, { jobs: { a: 'old' }, order: [], fins: [] })
    const a = open(jobsDir())
    a.io.hook = (op, path) =>
    {
      if (op === 'read' && path.endsWith('state.json'))
      {
        throw fsError('EBUSY')
      }
    }
    expect(await a.store.load()).toMatchObject({ source: 'bak', snapshotN: 1 })
    expect(a.log.warn).toHaveBeenCalledWith('Could not read state.json: EBUSY: simulated')
  })

  it('moves unreadable snapshots and the journal aside with queue-recovered and starts empty', async () =>
  {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(join(jobsDir(), 'state.json'), 'garbage')
    writeFileSync(join(jobsDir(), 'state.json.tmp'), '{"sch')
    writeFileSync(join(jobsDir(), 'state.json.bak'), '[]')
    writeSegment('1.jsonl', [{ n: 1, type: 'counter', counter: 'catalog', reserved: 200 }, { n: 2, type: 'job', id: 'a', state: 'pending' }, { n: 3, type: 'job', id: 'a', state: 'queued' }])
    const a = open(jobsDir())
    const loaded = await a.store.load()
    const stamp = '2026-10-17T12-00-00-000Z'
    const moved = [`state.corrupt-${stamp}.json`, `state.corrupt-${stamp}.tmp.json`, `state.corrupt-${stamp}.bak.json`, `journal.corrupt-${stamp}`]
    expect(loaded).toMatchObject({ source: 'none', body: null, lines: [], gaps: [], movedAside: moved })
    expect(loaded.counters).toEqual({ catalog: 200, run: 0 })
    expect(a.alerts).toEqual([{ kind: 'queue-recovered', cause: 'corrupt-state', code: null, movedAside: moved }])
    expect(a.log.error).toHaveBeenCalledWith(`No queue snapshot was readable; moved aside ${moved.join(', ')} and starting with an empty queue`)
    expect(readdirSync(jobsDir()).sort()).toEqual([...moved, 'journal', 'session.json'].sort())
    expect(readFileSync(join(jobsDir(), moved[0]), 'utf8')).toBe('garbage')
    expect(a.store.lastN).toBe(3)
    expect(await a.store.issue('catalog')).toBe(201)
    record(a, job('b', 'pending'))
    await a.store.flush()
    expect(journalNames()).toEqual(['4.jsonl'])
    expect(segmentLines('4.jsonl').map((line) => line.type)).toEqual(['counter', 'job'])
  })

  it('keeps starting when a corrupt file cannot be moved aside', async () =>
  {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(join(jobsDir(), 'state.json'), 'garbage')
    const a = open(jobsDir())
    a.io.hook = (op) =>
    {
      if (op === 'rename')
      {
        throw fsError('EPERM')
      }
    }
    const loaded = await a.store.load()
    expect(loaded.movedAside).toEqual([])
    expect(a.log.warn).toHaveBeenCalledWith('Could not move state.json aside: EPERM: simulated')
    expect(a.log.error).toHaveBeenCalledWith('No queue snapshot was readable; moved aside nothing and starting with an empty queue')
    expect(a.alerts).toEqual([{ kind: 'queue-recovered', cause: 'corrupt-state', code: null, movedAside: [] }])
  })

  it('leaves a newer schema untouched, saves to state.v1.json, and replaces it only when discarded', async () =>
  {
    mkdirSync(jobsDir(), { recursive: true })
    const newer = JSON.stringify({ schema: PERSISTENCE_SCHEMA + 1, lastN: 2, jobs: { x: 'future' } })
    writeFileSync(join(jobsDir(), 'state.json'), newer)
    writeSegment('1.jsonl', [{ n: 1, type: 'job', id: 'x', state: 'future' }, { n: 2, type: 'job', id: 'x', state: 'future' }])
    const a = open(jobsDir())
    const loaded = await a.store.load()
    expect(loaded).toMatchObject({ source: 'none', body: null, lines: [], newer: true, movedAside: [] })
    expect(a.alerts).toEqual([{ kind: 'queue-recovered', cause: 'newer-schema', code: null, movedAside: [] }])
    expect(a.store.health.newer).toBe(true)
    record(a, job('MM-0001', 'pending'))
    expect(await a.store.compact()).toBe(true)
    expect(file('state.json')).toBe(newer)
    expect(journalNames()).toEqual(['1.jsonl'])
    expect(JSON.parse(file('state.v1.json'))).toMatchObject({ schema: 1, lastN: 1, jobs: { 'MM-0001': 'pending' } })
    expect(journalNames('journal.v1')).toEqual(['1.jsonl'])
    crash(a)

    const b = open(jobsDir())
    const again = await b.store.load()
    expect(again).toMatchObject({ source: 'state', snapshotN: 1, newer: true })
    Object.assign(b.body, rebuild(again))
    expect(b.body.jobs).toEqual({ 'MM-0001': 'pending' })
    record(b, job('MM-0001', 'queued'))
    expect(await b.store.discardNewer()).toBe(true)
    expect(JSON.parse(file('state.json'))).toMatchObject({ schema: 1, lastN: 2, jobs: { 'MM-0001': 'queued' } })
    expect(existsSync(join(jobsDir(), 'state.v1.json'))).toBe(false)
    expect(journalNames()).toEqual([])
    expect(journalNames('journal.v1')).toEqual([])
    expect(b.store.health.newer).toBe(false)
    expect(await b.store.discardNewer()).toBe(false)
    record(b, job('MM-0001', 'active'))
    await b.store.flush()
    crash(b)

    const c = open(jobsDir())
    const last = await c.store.load()
    expect(last).toMatchObject({ source: 'state', snapshotN: 2, newer: false })
    expect(rebuild(last).jobs).toEqual({ 'MM-0001': 'active' })
    expect(c.alerts).toEqual([])
  })
})

/** Runs two lines, a compaction, two more lines, then a second compaction that freezes at `step`, two lines after it, and a crash. */
async function crashDuringCompaction(step: string): Promise<{ a: Harness; b: Harness; loaded: LoadedState<Body, Entry> }>
{
  const a = open(jobsDir())
  await a.store.load()
  record(a, job('a', 'pending'))
  record(a, job('b', 'pending'))
  expect(await a.store.compact()).toBe(true)
  record(a, job('a', 'queued'))
  record(a, { type: 'fin', id: 'a', step: 'begin' })
  await a.store.flush()
  a.io.hook = (op, path) =>
  {
    const name = relative(jobsDir(), path).split(sep).join('/')
    return `${op} ${name}` === step ? 'freeze' : undefined
  }
  void a.store.compact()
  await a.io.idle()
  expect(a.io.ops().pop()).toBe(step.startsWith('rename') ? `${step} > ${a.io.calls[a.io.calls.length - 1].text}` : step)
  record(a, job('b', 'queued'))
  record(a, { type: 'fin', id: 'a', step: 'done' })
  await a.store.flush()
  crash(a)
  const b = open(jobsDir())
  const loaded = await b.store.load()
  expect(rebuild(loaded)).toEqual(a.body)
  expect(b.store.lastN).toBe(6)
  return { a, b, loaded }
}

describe('JobStore compaction', () =>
{
  it('saves a snapshot through a synced temporary file and two renames, syncing the folder only on POSIX', async () =>
  {
    for (const platform of ['win32', 'linux'] as const)
    {
      const dir = join(root, platform)
      const a = open(dir, { platform })
      await a.store.load()
      record(a, job('a', 'pending'))
      expect(await a.store.compact()).toBe(true)
      record(a, job('a', 'queued'))
      a.io.clear()
      expect(await a.store.compact()).toBe(true)
      expect(a.io.ops()).toEqual([
        'append journal/2.jsonl',
        'unlink state.json.tmp',
        'append state.json.tmp',
        'fsync state.json.tmp',
        'rename state.json > state.json.bak',
        'rename state.json.tmp > state.json',
        ...(platform === 'linux' ? ['fsync .'] : []),
        'unlink journal/1.jsonl'
      ])
      expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual({
        schema: 1,
        lastN: 2,
        savedAt: START,
        counters: { catalog: 0, run: 0 },
        jobs: { a: 'queued' },
        order: [],
        fins: []
      })
      expect(JSON.parse(readFileSync(join(dir, 'state.json.bak'), 'utf8')).lastN).toBe(1)
      expect(a.log.info).toHaveBeenCalledWith('Saved the queue snapshot through line 2')
    }
  })

  it('reuses the open segment when no line arrived since the last switch', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    expect(await a.store.compact()).toBe(true)
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'queued'))
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'active'))
    await a.store.flush()
    expect(journalNames()).toEqual(['2.jsonl', '3.jsonl'])
    crash(a)
    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 2 })
    expect(rebuild(loaded)).toEqual(a.body)
  })

  it('survives a crash right after the segment switch', async () =>
  {
    const { loaded } = await crashDuringCompaction('unlink state.json.tmp')
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 2 })
    expect(loaded.lines.map((line) => line.n)).toEqual([3, 4, 5, 6])
    expect(journalNames()).toEqual(['1.jsonl', '3.jsonl', '5.jsonl'])
  })

  it('survives a crash after the temporary file was written and synced', async () =>
  {
    const { loaded } = await crashDuringCompaction('rename state.json')
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 2 })
    expect(loaded.lines.map((line) => line.n)).toEqual([3, 4, 5, 6])
    expect(JSON.parse(file('state.json.tmp')).lastN).toBe(4)
  })

  it('survives a crash between the two renames by loading the temporary file', async () =>
  {
    const { b, loaded } = await crashDuringCompaction('rename state.json.tmp')
    expect(loaded).toMatchObject({ source: 'tmp', snapshotN: 4 })
    expect(loaded.lines.map((line) => line.n)).toEqual([5, 6])
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    expect(JSON.parse(file('state.json.bak')).lastN).toBe(2)
    Object.assign(b.body, rebuild(loaded))
    expect(await b.store.compact()).toBe(true)
    expect(JSON.parse(file('state.json')).lastN).toBe(6)
    expect(existsSync(join(jobsDir(), 'state.json.tmp'))).toBe(false)
    expect(journalNames()).toEqual(['1.jsonl', '3.jsonl', '5.jsonl'])
    expect(await b.store.compact()).toBe(true)
    expect(journalNames()).toEqual([])
  })

  it('survives a crash before the old segments were deleted', async () =>
  {
    const { loaded } = await crashDuringCompaction('unlink journal/1.jsonl')
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 4 })
    expect(loaded.lines.map((line) => line.n)).toEqual([5, 6])
    expect(journalNames()).toEqual(['1.jsonl', '3.jsonl', '5.jsonl'])
  })

  it('loads the temporary file when the first compaction stops before its rename', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    a.io.hook = (op, path) => (op === 'rename' && path.endsWith('state.json.tmp') ? 'freeze' : undefined)
    void a.store.compact()
    await a.io.idle()
    record(a, job('a', 'queued'))
    await a.store.flush()
    crash(a)
    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'tmp', snapshotN: 1 })
    expect(rebuild(loaded)).toEqual(a.body)
  })

  it('keeps every file the loader relies on when a compaction fails with ENOSPC, and retries after 60 s', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    const saved = file('state.json')
    record(a, job('a', 'queued'))
    a.io.hook = (op, path) =>
    {
      if (op === 'append' && path.endsWith('state.json.tmp'))
      {
        throw fsError('ENOSPC')
      }
    }
    expect(await a.store.compact()).toBe(false)
    expect(a.alerts).toEqual([{ kind: 'disk-space', cause: 'compaction-failed', code: 'ENOSPC', movedAside: [] }])
    expect(a.log.warn).toHaveBeenCalledWith('Could not save the queue snapshot (ENOSPC); appends continue and the save is retried')
    expect(file('state.json')).toBe(saved)
    record(a, job('a', 'active'))
    await a.store.flush()
    expect(journalNames()).toEqual(['1.jsonl', '2.jsonl', '3.jsonl'])
    expect(a.timers.delays()).toEqual([60000])
    expect(await a.store.compact()).toBe(false)
    expect(a.alerts).toHaveLength(1)
    expect(a.timers.delays()).toEqual([60000])
    expect(a.store.health.writable).toBe(true)

    crash(a)
    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 1 })
    expect(rebuild(loaded)).toEqual(a.body)
  })

  it('retries a failed compaction after 60 s and raises the alert again only after a success', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    a.io.hook = (op) =>
    {
      if (op === 'rename')
      {
        throw fsError('EIO')
      }
    }
    expect(await a.store.compact()).toBe(false)
    expect(a.alerts).toEqual([{ kind: 'storage-error', cause: 'compaction-failed', code: 'EIO', movedAside: [] }])
    a.io.hook = null
    await a.timers.advance(59999)
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    await a.timers.advance(1)
    expect(JSON.parse(file('state.json')).lastN).toBe(1)
    expect(a.timers.delays()).toEqual([])
    a.io.hook = (op) =>
    {
      if (op === 'fsync')
      {
        throw new Error('device gone')
      }
    }
    expect(await a.store.compact()).toBe(false)
    expect(a.alerts).toEqual([
      { kind: 'storage-error', cause: 'compaction-failed', code: 'EIO', movedAside: [] },
      { kind: 'storage-error', cause: 'compaction-failed', code: null, movedAside: [] }
    ])
    expect(a.log.warn).toHaveBeenCalledWith('Could not save the queue snapshot (device gone); appends continue and the save is retried')
  })

  it('keeps the .bak snapshot replayable: segments stay back to it and fin lines after it are never lost', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    record(a, { type: 'fin', id: 'a', step: 'begin' })
    record(a, { type: 'fin', id: 'a', step: 'reserve' })
    expect(await a.store.compact()).toBe(true)
    expect(journalNames()).toEqual(['2.jsonl'])
    record(a, { type: 'fin', id: 'a', step: 'place' })
    expect(await a.store.appendDurable([{ type: 'fin', id: 'a', step: 'done' }])).toEqual([5])
    apply(a.body, { type: 'fin', id: 'a', step: 'done' })
    expect(await a.store.compact()).toBe(true)
    expect(journalNames()).toEqual(['4.jsonl'])
    expect(JSON.parse(file('state.json.bak')).lastN).toBe(3)
    record(a, { type: 'fin', id: 'b', step: 'begin' })
    await a.store.flush()
    crash(a)
    writeFileSync(join(jobsDir(), 'state.json'), '{"schema":1,"lastN":5,"jo')

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'bak', snapshotN: 3 })
    expect(loaded.lines.map((line) => line.n)).toEqual([4, 5, 6])
    expect(rebuild(loaded)).toEqual(a.body)
    expect(rebuild(loaded).fins).toEqual(['a:begin', 'a:reserve', 'a:place', 'a:done', 'b:begin'])
  })

  it('keeps a segment whose lines still wait in the write queue', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    a.io.hook = (op, path) =>
    {
      if (op === 'append' && path.endsWith('2.jsonl'))
      {
        throw fsError('EBUSY')
      }
    }
    record(a, job('a', 'queued'))
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'active'))
    expect(await a.store.compact()).toBe(true)
    expect(JSON.parse(file('state.json.bak')).lastN).toBe(2)
    expect(journalNames()).toEqual([])
    expect(a.alerts).toEqual([{ kind: 'storage-error', cause: 'write-failed', code: 'EBUSY', movedAside: [] }])
    expect(a.store.health.writable).toBe(false)
    a.io.hook = null
    await a.timers.advance(5000)
    expect(a.writable).toHaveBeenCalledTimes(1)
    expect(journalNames()).toEqual(['2.jsonl', '3.jsonl'])
    expect(file('journal', '2.jsonl')).toBe('\n{"n":2,"type":"job","id":"a","state":"queued"}\n')
    expect(await a.store.compact()).toBe(true)
    expect(journalNames()).toEqual([])
  })

  it('keeps a segment it could not delete and tries again at the next compaction', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'queued'))
    a.io.hook = (op) =>
    {
      if (op === 'unlink')
      {
        throw fsError('EBUSY')
      }
    }
    expect(await a.store.compact()).toBe(false)
    a.io.hook = (op, path) =>
    {
      if (op === 'unlink' && path.endsWith('1.jsonl'))
      {
        throw fsError('EBUSY')
      }
    }
    expect(await a.store.compact()).toBe(true)
    expect(a.log.warn).toHaveBeenCalledWith('Could not delete journal segment 1.jsonl: EBUSY: simulated')
    expect(journalNames()).toEqual(['1.jsonl', '2.jsonl'])
    a.io.hook = null
    record(a, job('a', 'active'))
    expect(await a.store.compact()).toBe(true)
    expect(journalNames()).toEqual(['3.jsonl'])
  })

  it('compacts past 4 MiB once no line has arrived for 2 s, and at once past 32 MiB', async () =>
  {
    expect(STORE_LIMITS).toEqual({
      flushMs: 250,
      writeRetryMs: 5000,
      compactRetryMs: 60000,
      quietMs: 2000,
      afterRunMs: 30000,
      softBytes: 4 * 1024 * 1024,
      hardBytes: 32 * 1024 * 1024,
      queueLimitBytes: 64 * 1024 * 1024
    })
    const a = open(jobsDir(), { limits: { softBytes: 300, hardBytes: 1200 } })
    await a.store.load()
    const compact = vi.spyOn(a.store, 'compact')
    while (a.store.health.journalBytes <= 300)
    {
      record(a, job('a', 'x'.repeat(40)))
    }
    expect(a.timers.delays()).toEqual([250, 2000])
    await a.timers.advance(1999)
    record(a, job('b', 'y'))
    await a.timers.advance(1999)
    expect(compact).not.toHaveBeenCalled()
    await a.timers.advance(1)
    expect(compact).toHaveBeenCalledTimes(1)
    expect(JSON.parse(file('state.json')).jobs).toEqual(a.body.jobs)
    expect(a.store.health.journalBytes).toBe(0)
    while (a.store.health.journalBytes <= 1200)
    {
      record(a, job('c', 'z'.repeat(40)))
    }
    expect(a.timers.delays()).toEqual([0, 250])
    await a.timers.advance(0)
    expect(compact).toHaveBeenCalledTimes(2)
    expect(JSON.parse(file('state.json')).lastN).toBe(a.store.lastN)
  })

  it('compacts 30 s after a run completes when the engine is idle by then', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'done'))
    a.idle.value = false
    a.store.runCompleted()
    a.store.runCompleted()
    expect(a.timers.delays()).toEqual([250, 30000])
    await a.timers.advance(30000)
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    a.idle.value = true
    a.store.runCompleted()
    await a.timers.advance(29999)
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    await a.timers.advance(1)
    expect(JSON.parse(file('state.json')).lastN).toBe(1)
  })

  it('reports a state it cannot serialize and keeps the journal', async () =>
  {
    const a = open(jobsDir(), {
      snapshot: () =>
      {
        throw new Error('cycle')
      }
    })
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(false)
    expect(a.log.error).toHaveBeenCalledWith('Could not serialize the queue snapshot: cycle')
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    await a.store.flush()
    expect(segmentLines('1.jsonl')).toEqual([{ n: 1, type: 'job', id: 'a', state: 'pending' }])
    expect(a.store.health.journalBytes).toBeGreaterThan(0)
  })

  it('passes every line and snapshot through toWire before writing', async () =>
  {
    const a = open(jobsDir(), { snapshot: () => ({ jobs: { a: 'x' }, order: [], fins: [], ratio: Number.NaN, gone: undefined, list: [1, Number.NEGATIVE_INFINITY] }) as unknown as Body })
    await a.store.load()
    a.store.append({ type: 'job', id: 'a', state: 'x', ratio: Number.POSITIVE_INFINITY })
    await a.store.appendDurable([{ type: 'job', id: 'a', state: 'y', ratio: Number.NaN }])
    expect(await a.store.compact()).toBe(true)
    expect(segmentLines('1.jsonl')).toEqual([
      { n: 1, type: 'job', id: 'a', state: 'x', ratio: null },
      { n: 2, type: 'job', id: 'a', state: 'y', ratio: null }
    ])
    expect(JSON.parse(file('state.json'))).toEqual({
      schema: 1,
      lastN: 2,
      savedAt: START,
      counters: { catalog: 0, run: 0 },
      jobs: { a: 'x' },
      order: [],
      fins: [],
      ratio: null,
      gone: null,
      list: [1, null]
    })
  })
})

describe('JobStore counters', () =>
{
  it('reserves blocks of 100 with a durable counter line before issuing any number from them', async () =>
  {
    expect(COUNTER_BLOCK).toBe(100)
    const a = open(jobsDir())
    await a.store.load()
    expect(a.store.available('catalog')).toBe(0)
    expect(a.store.take('catalog')).toBeNull()
    a.io.clear()
    const gate = deferred()
    a.io.hook = (op) => (op === 'fsync' ? gate.promise : undefined)
    const first = a.store.issue('catalog')
    await a.io.idle()
    expect(a.io.ops()).toEqual(['append journal/1.jsonl', 'fsync journal/1.jsonl'])
    expect(a.store.available('catalog')).toBe(0)
    gate.resolve()
    expect(await first).toBe(1)
    expect(segmentLines('1.jsonl')).toEqual([{ n: 1, type: 'counter', counter: 'catalog', reserved: 100 }])
    expect(a.store.available('catalog')).toBe(99)
    expect(await a.store.issueMany('catalog', 99)).toEqual(Array.from({ length: 99 }, (_, index) => index + 2))
    expect(a.store.take('catalog')).toBeNull()
    expect(await a.store.issue('catalog')).toBe(101)
    expect(await a.store.issue('run')).toBe(1)
    expect(segmentLines('1.jsonl').slice(1)).toEqual([
      { n: 2, type: 'counter', counter: 'catalog', reserved: 200 },
      { n: 3, type: 'counter', counter: 'run', reserved: 100 }
    ])
  })

  it('issues many consecutive numbers in one turn and shares one reservation between callers', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    expect(await Promise.all([a.store.issue('catalog'), a.store.issue('catalog'), a.store.issueMany('catalog', 2)])).toEqual([1, 2, [3, 4]])
    const many = await a.store.issueMany('catalog', 250)
    expect(many).toEqual(Array.from({ length: 250 }, (_, index) => index + 5))
    expect(segmentLines('1.jsonl').map((line) => line.reserved)).toEqual([100, 300])
    expect(a.store.available('catalog')).toBe(46)
    await a.store.reserve('catalog', 10)
    expect(segmentLines('1.jsonl')).toHaveLength(2)
  })

  it('skips past a sequence observed in the snapshot, the journal, the run index, or the registry', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    expect(await a.store.issue('catalog')).toBe(1)
    a.store.observe('catalog', 150)
    a.store.observe('catalog', 7)
    a.store.observe('catalog', 1.5)
    expect(a.store.available('catalog')).toBe(0)
    expect(await a.store.issue('catalog')).toBe(151)
    expect(segmentLines('1.jsonl').map((line) => line.reserved)).toEqual([100, 250])
    a.store.observe('run', 12)
    expect(await a.store.issue('run')).toBe(13)
  })

  it('stays monotonic across a simulated crash, and the snapshot keeps the marks once the lines are gone', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    expect(await a.store.issueMany('catalog', 5)).toEqual([1, 2, 3, 4, 5])
    expect(await a.store.issue('run')).toBe(1)
    crash(a)

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded.counters).toEqual({ catalog: 100, run: 100 })
    expect(loaded.lines).toEqual([])
    expect(await b.store.issue('catalog')).toBe(101)
    expect(await b.store.issue('run')).toBe(101)
    expect(await b.store.compact()).toBe(true)
    expect(JSON.parse(file('state.json')).counters).toEqual({ catalog: 200, run: 200 })
    expect(await b.store.compact()).toBe(true)
    expect(journalNames()).toEqual([])
    crash(b)

    const c = open(jobsDir())
    expect((await c.store.load()).counters).toEqual({ catalog: 200, run: 200 })
    expect(await c.store.issue('catalog')).toBe(201)
  })

  it('issues nothing from a block whose counter line could not be made durable', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.hook = (op) =>
    {
      if (op === 'fsync')
      {
        throw fsError('EIO')
      }
    }
    await expect(a.store.issue('catalog')).rejects.toMatchObject({ code: 'EIO' })
    expect(a.store.available('catalog')).toBe(0)
    expect(a.alerts).toEqual([{ kind: 'storage-error', cause: 'write-failed', code: 'EIO', movedAside: [] }])
    a.io.hook = null
    expect(await a.store.issue('catalog')).toBe(1)
    expect(a.writable).toHaveBeenCalledTimes(1)
    expect(segmentLines('1.jsonl').map((line) => line.reserved)).toEqual([100, 100])
    expect(await a.store.compact()).toBe(true)
    expect(JSON.parse(file('state.json')).counters).toEqual({ catalog: 100, run: 0 })
  })
})

describe('JobStore write failures', () =>
{
  it('retries failed writes every 5 s with one alert, and reports when writes work again', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    a.io.hook = (op) =>
    {
      if (op === 'append')
      {
        throw fsError('ENOSPC')
      }
    }
    record(a, job('a', 'pending'))
    await a.timers.advance(250)
    expect(a.alerts).toEqual([{ kind: 'disk-space', cause: 'write-failed', code: 'ENOSPC', movedAside: [] }])
    expect(a.log.warn).toHaveBeenCalledWith('Could not write the job files (ENOSPC); retrying every 5 s')
    expect(a.store.health.writable).toBe(false)
    record(a, job('a', 'queued'))
    await a.timers.advance(250)
    expect(a.io.ops('append')).toHaveLength(1)
    await a.timers.advance(4750)
    expect(a.io.ops('append')).toHaveLength(2)
    expect(a.alerts).toHaveLength(1)
    a.io.hook = null
    await a.timers.advance(5000)
    expect(a.writable).toHaveBeenCalledTimes(1)
    expect(a.log.info).toHaveBeenCalledWith('Writes to the job files work again')
    expect(a.store.health).toMatchObject({ writable: true, pendingBytes: 0 })
    expect(file('journal', '1.jsonl').startsWith('\n')).toBe(true)
    expect(segmentLines('1.jsonl').map((line) => line.n)).toEqual([1, 2])
    expect(a.timers.delays()).toEqual([])
  })

  it('drops the write queue past 64 MiB and saves the whole queue with the next successful write', async () =>
  {
    const a = open(jobsDir(), { limits: { softBytes: Number.POSITIVE_INFINITY, hardBytes: Number.POSITIVE_INFINITY } })
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    a.io.hook = (op) =>
    {
      if (op === 'append')
      {
        throw fsError('ENOSPC')
      }
    }
    record(a, job('a', 'pending'))
    await a.timers.advance(250)
    const history = a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record' }]).then(() => 'written', (err: Error) => err.message)
    const big = 'x'.repeat(4 * 1024 * 1024)
    for (let index = 0; index < 15; index++)
    {
      record(a, job(`b${index}`, big))
    }
    await a.timers.advance(250)
    expect(a.store.health.pendingBytes).toBeGreaterThan(60 * 1024 * 1024)
    expect(a.store.health.pendingBytes).toBeLessThan(64 * 1024 * 1024)
    expect(a.alerts).toHaveLength(1)
    record(a, job('b15', big))
    record(a, job('b16', big))
    await a.timers.advance(250)
    expect(a.alerts).toEqual([
      { kind: 'disk-space', cause: 'write-failed', code: 'ENOSPC', movedAside: [] },
      { kind: 'disk-space', cause: 'queue-dropped', code: 'ENOSPC', movedAside: [] }
    ])
    expect(a.log.error).toHaveBeenCalledWith(expect.stringMatching(/^Dropped \d+ bytes of unwritten job lines; the next successful write saves the whole queue$/))
    expect(await history).toBe('The write queue was dropped')
    expect(a.store.health).toMatchObject({ writable: false, pendingBytes: 0 })
    for (const id of Object.keys(a.body.jobs))
    {
      a.body.jobs[id] = 'done'
    }
    record(a, job('c', 'pending'))
    await a.timers.advance(250)
    await expect(a.store.appendDurable([{ type: 'fin', id: 'c', step: 'begin' }])).rejects.toMatchObject({ code: 'ENOSPC' })
    apply(a.body, { type: 'fin', id: 'c', step: 'begin' })
    expect(a.alerts.map((alert) => alert.cause)).toEqual(['write-failed', 'queue-dropped', 'compaction-failed'])
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    expect(journalNames()).toEqual([])

    a.io.hook = null
    await a.timers.advance(5000)
    expect(JSON.parse(file('state.json'))).toMatchObject({ lastN: a.store.lastN, jobs: a.body.jobs, fins: ['c:begin'] })
    expect(a.writable).toHaveBeenCalledTimes(1)
    expect(a.store.health).toMatchObject({ writable: true, pendingBytes: 0 })
    crash(a)
    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'state', snapshotN: a.store.lastN, gaps: [] })
    expect(rebuild(loaded)).toEqual(a.body)
  })

  it('does not record a clean exit when the final writes fail', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    a.io.hook = (op, path) =>
    {
      if (op === 'append' && path.endsWith('R-0001.jsonl'))
      {
        throw fsError('EIO')
      }
    }
    void a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record' }])
    record(a, job('a', 'done'))
    expect(await a.store.close()).toBe(false)
    expect(JSON.parse(file('session.json')).cleanExit).toBe(false)
    expect(JSON.parse(file('state.json')).jobs).toEqual({ a: 'done' })
    expect(a.timers.delays()).toEqual([])
  })
})

describe('JobStore session end', () =>
{
  it('appends the buffered lines and the interrupted marks synchronously and never compacts', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'active'))
    record(a, job('b', 'active'))
    a.io.clear()
    a.store.sessionEnd([job('a', 'interrupted'), job('b', 'interrupted'), { type: 'session-end' }])
    expect(segmentLines('1.jsonl').map((line) => line.n)).toEqual([1, 2, 3, 4, 5])
    expect(a.io.ops()).toEqual(['appendSync journal/1.jsonl'])
    expect(a.timers.delays()).toEqual([])
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    expect(a.store.append(job('c', 'pending'))).toBe(5)
    a.store.sessionEnd([job('a', 'active')])
    expect(await a.store.compact()).toBe(false)
    expect(await a.store.close()).toBe(false)
    expect(a.io.ops()).toEqual(['appendSync journal/1.jsonl'])
    expect(JSON.parse(file('session.json')).cleanExit).toBe(false)

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(rebuild(loaded).jobs).toEqual({ a: 'interrupted', b: 'interrupted' })
    expect(loaded.lines.at(-1)).toEqual({ n: 5, type: 'session-end' })
    expect(loaded.previous?.cleanExit).toBe(false)
  })

  it('abandons a compaction in progress, and the loader replays every line on the older snapshot', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'active'))
    const gate = deferred()
    a.io.hook = (op, path) => (op === 'fsync' && path.endsWith('state.json.tmp') ? gate.promise : undefined)
    const compacted = a.store.compact()
    await a.io.idle()
    const durable = a.store.appendDurable([{ type: 'fin', id: 'a', step: 'begin' }])
    a.store.sessionEnd([job('a', 'interrupted')])
    await expect(durable).rejects.toThrow('The session ended')
    gate.resolve()
    expect(await compacted).toBe(false)
    expect(JSON.parse(file('state.json')).lastN).toBe(1)
    expect(a.io.ops('rename')).toEqual(['rename state.json.tmp > state.json'])

    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'state', snapshotN: 1 })
    expect(loaded.lines.map((line) => line.n)).toEqual([2, 3, 4])
    expect(rebuild(loaded)).toEqual({ jobs: { a: 'interrupted' }, order: [], fins: ['a:begin'] })
  })

  it('stops a compaction between its renames when the session ends there', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    record(a, job('a', 'pending'))
    expect(await a.store.compact()).toBe(true)
    record(a, job('a', 'active'))
    const gate = deferred()
    a.io.hook = (op, path) => (op === 'rename' && path.endsWith('state.json') ? gate.promise : undefined)
    const compacted = a.store.compact()
    await a.io.idle()
    a.store.sessionEnd([job('a', 'interrupted')])
    gate.resolve()
    expect(await compacted).toBe(false)
    expect(existsSync(join(jobsDir(), 'state.json'))).toBe(false)
    const b = open(jobsDir())
    const loaded = await b.store.load()
    expect(loaded).toMatchObject({ source: 'tmp', snapshotN: 2 })
    expect(rebuild(loaded).jobs).toEqual({ a: 'interrupted' })
  })

  it('writes every line at session end even while writes failed past the queue limit', async () =>
  {
    const a = open(jobsDir(), { limits: { queueLimitBytes: 200 } })
    await a.store.load()
    a.io.hook = (op) =>
    {
      if (op === 'append')
      {
        throw fsError('EIO')
      }
    }
    record(a, job('a', 'active'))
    await a.timers.advance(250)
    record(a, job('a', 'x'.repeat(200)))
    a.store.sessionEnd([job('a', 'interrupted')])
    expect(a.alerts.map((alert) => alert.cause)).toEqual(['write-failed'])
    expect(a.io.ops('appendSync')).toEqual(['appendSync journal/1.jsonl'])
    expect(segmentLines('1.jsonl').map((line) => line.n)).toEqual([1, 2, 3])
  })

  it('writes queued lines of other files too and rejects the durable waits it cannot honor', async () =>
  {
    const a = open(jobsDir())
    await a.store.load()
    mkdirSync(a.store.paths.runs, { recursive: true })
    a.io.hook = (op, path) => (op === 'append' && path.endsWith('R-0001.jsonl') ? 'freeze' : undefined)
    const settle = (promise: Promise<void>): Promise<string> => promise.then(() => 'written', (err: Error) => err.message)
    const history = settle(a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record', id: 1 }]))
    const history2 = settle(a.store.appendLines(a.store.paths.history('R-0001' as never), [{ type: 'record', id: 2 }]))
    const created = settle(a.store.appendLines(a.store.paths.workdirs, [{ op: 'create' }], true))
    record(a, job('a', 'active'))
    a.io.hook = (op, path) =>
    {
      if (op === 'appendSync' && path.endsWith(join('journal', '1.jsonl')))
      {
        throw fsError('EIO')
      }
    }
    a.store.sessionEnd([job('a', 'interrupted')])
    expect(await history).toBe('written')
    expect(await history2).toBe('written')
    expect(await created).toBe('The session ended')
    expect(file('runs', 'R-0001.jsonl')).toBe('\n{"type":"record","id":1}\n{"type":"record","id":2}\n')
    expect(file('workdirs.jsonl')).toBe('\n{"op":"create"}\n')
    expect(a.io.ops('appendSync')).toEqual(['appendSync runs/R-0001.jsonl', 'appendSync workdirs.jsonl', 'appendSync journal/1.jsonl'])
    expect(a.log.error).toHaveBeenCalledWith('Could not write the job lines at session end: EIO: simulated')
  })
})
