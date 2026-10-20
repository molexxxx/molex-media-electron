/**
 * The engine's files under `<userData>/jobs/`: the state snapshot with its `.tmp` and `.bak` fallbacks, numbered
 * journal segments replayed by line number, the session marker, and the helpers the history, preset, and work-folder
 * modules write through. Every line and snapshot passes through `toWire` before it is written, and nothing here does
 * synchronous file I/O except the session-end append.
 */

import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { JobId, RunId } from '../../shared/jobs/ids'
import type { RunAlertKind } from '../../shared/jobs/types'
import { toWire } from '../../shared/jobs/wire'
import type { JobEngineDeps, JobLogger, PersistenceIO, TimerHandle, Timers } from './deps'

/** The schema of `state.json`, every history line, and `presets.json`. */
export const PERSISTENCE_SCHEMA = 1

/** Catalog and run numbers are reserved in blocks of this many. */
export const COUNTER_BLOCK = 100

const MIB = 1024 * 1024

/** The timings and sizes of the write discipline. */
export interface StoreLimits
{
  /** Buffered lines are appended as one batch this often. */
  flushMs: number
  /** Lines that could not be written are retried this often. */
  writeRetryMs: number
  /** A failed compaction is retried after this long. */
  compactRetryMs: number
  /** Past `softBytes`, the journal compacts once no line has arrived for this long. */
  quietMs: number
  /** The journal compacts this long after a run completes, if the engine is idle by then. */
  afterRunMs: number
  softBytes: number
  /** Past this size the journal compacts at once. */
  hardBytes: number
  /** Past this many pending bytes the write queue is dropped and the next write is a full compaction. */
  queueLimitBytes: number
}

/** The limits the engine runs with. */
export const STORE_LIMITS: Readonly<StoreLimits> =
{
  flushMs: 250,
  writeRetryMs: 5000,
  compactRetryMs: 60000,
  quietMs: 2000,
  afterRunMs: 30000,
  softBytes: 4 * MIB,
  hardBytes: 32 * MIB,
  queueLimitBytes: 64 * MIB
}

/** Every file the engine keeps under `<userData>/jobs/`. */
export interface JobsPaths
{
  dir: string
  state: string
  journal: string
  workdirs: string
  session: string
  runs: string
  runsIndex: string
  logs: string
  presets: string
  /** `runs/<RunId>.jsonl`. */
  history(runId: RunId): string
  /** `logs/<RunId>/<JobId>-a<n>.log`. */
  attemptLog(runId: RunId, jobId: JobId, attempt: number): string
}

/** The layout of `<userData>/jobs/`, passed as `dir`. */
export function jobsPaths(dir: string): JobsPaths
{
  const runs = join(dir, 'runs')
  const logs = join(dir, 'logs')
  return {
    dir,
    state: join(dir, 'state.json'),
    journal: join(dir, 'journal'),
    workdirs: join(dir, 'workdirs.jsonl'),
    session: join(dir, 'session.json'),
    runs,
    runsIndex: join(runs, 'index.json'),
    logs,
    presets: join(dir, 'presets.json'),
    history: (runId) => join(runs, `${runId}.jsonl`),
    attemptLog: (runId, jobId, attempt) => join(logs, runId, `${jobId}-a${attempt}.log`)
  }
}

interface Layout
{
  /** `state`, or `state.v1` while a newer version's files are left untouched. */
  stem: string
  state: string
  tmp: string
  bak: string
  journal: string
}

function layoutOf(dir: string, suffix: '' | '.v1'): Layout
{
  const state = join(dir, `state${suffix}.json`)
  return { stem: `state${suffix}`, state, tmp: `${state}.tmp`, bak: `${state}.bak`, journal: join(dir, `journal${suffix}`) }
}

function codeOf(err: unknown): string | null
{
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : null
}

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number
{
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * The real `PersistenceIO` over `node:fs`. `fsync` of a folder works on POSIX only; Windows refuses it, so the store
 * never asks there.
 */
export function createNodePersistenceIO(): PersistenceIO
{
  return {
    append: (path, text) => appendFile(path, text, 'utf8'),
    appendSync: (path, text) => appendFileSync(path, text, 'utf8'),
    async fsync(path)
    {
      const handle = await open(path, 'r+').catch((err: unknown) =>
      {
        if (codeOf(err) === 'EISDIR')
        {
          return open(path, 'r')
        }
        throw err
      })
      try
      {
        await handle.sync()
      }
      finally
      {
        await handle.close()
      }
    },
    async writeAtomic(path, text)
    {
      const tmp = `${path}.tmp`
      const handle = await open(tmp, 'w')
      try
      {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      }
      finally
      {
        await handle.close()
      }
      await rename(tmp, path)
    },
    async read(path)
    {
      try
      {
        return await readFile(path, 'utf8')
      }
      catch (err)
      {
        if (codeOf(err) === 'ENOENT')
        {
          return null
        }
        throw err
      }
    },
    async list(dir)
    {
      try
      {
        return await readdir(dir)
      }
      catch (err)
      {
        if (codeOf(err) === 'ENOENT')
        {
          return []
        }
        throw err
      }
    },
    rename: (from, to) => rename(from, to),
    unlink: (path) => unlink(path),
    async mkdir(path)
    {
      await mkdir(path, { recursive: true })
    }
  }
}

/** One JSON line: the value through `toWire`, then a newline. */
export function jsonLine(value: unknown): string
{
  return `${JSON.stringify(toWire(value))}\n`
}

/** Parsed JSON lines. */
export interface JsonLines
{
  values: unknown[]
  /** Unparsable lines before the last one. */
  skipped: number
  /** The last line did not parse, as a crash in the middle of an append leaves it. */
  torn: boolean
}

/** Parses JSON lines, skipping blank lines and lines that do not parse. */
export function parseJsonLines(text: string): JsonLines
{
  const values: unknown[] = []
  const lines = text.split('\n')
  let skipped = 0
  let torn = false
  lines.forEach((raw, index) =>
  {
    const line = raw.trim()
    if (line === '')
    {
      return
    }
    try
    {
      values.push(JSON.parse(line))
    }
    catch
    {
      if (index === lines.length - 1)
      {
        torn = true
      }
      else
      {
        skipped += 1
      }
    }
  })
  return { values, skipped, torn }
}

/** Reads a JSON lines file; a missing file has no lines. */
export async function readJsonLines(io: PersistenceIO, path: string): Promise<JsonLines>
{
  return parseJsonLines((await io.read(path)) ?? '')
}

/** Replaces a JSON lines file atomically, as the work-folder registry is rewritten with its live entries at startup. */
export function rewriteJsonLines(io: PersistenceIO, path: string, values: readonly unknown[]): Promise<void>
{
  return io.writeAtomic(path, values.map(jsonLine).join(''))
}

/** Writes a JSON file atomically. */
export function writeJsonAtomic(io: PersistenceIO, path: string, value: unknown): Promise<void>
{
  return io.writeAtomic(path, JSON.stringify(toWire(value)))
}

/** A JSON file as read. */
export type JsonRead =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string }

/** Reads and parses a JSON file; a file that cannot be read or parsed is reported as corrupt. */
export async function readJson(io: PersistenceIO, path: string): Promise<JsonRead>
{
  try
  {
    const text = await io.read(path)
    return text === null ? { status: 'missing' } : { status: 'ok', value: JSON.parse(text) }
  }
  catch (err)
  {
    return { status: 'corrupt', reason: messageOf(err) }
  }
}

/** One schema step: takes a stored object at version `v` and returns it at `v + 1`. */
export type Migration = (file: Record<string, unknown>) => Record<string, unknown>

/** Migration steps keyed by the version each starts from. */
export type Migrations = Readonly<Record<number, Migration>>

/** Steps for `state.json`; empty while schema 1 is the only version. */
export const STATE_MIGRATIONS: Migrations = {}

/** Steps for `presets.json`. */
export const PRESETS_MIGRATIONS: Migrations = {}

/** Steps for history lines. */
export const HISTORY_MIGRATIONS: Migrations = {}

/** A stored object brought to the current schema, or why it could not be. */
export type Migrated =
  | { status: 'ok'; file: Record<string, unknown> }
  | { status: 'newer'; schema: number }
  | { status: 'invalid'; reason: string }

/**
 * Brings a stored object to `target` through pure per-version steps. A newer schema is reported and never changed,
 * so a downgrade leaves a newer file intact.
 */
export function migrate(value: unknown, migrations: Migrations, target: number = PERSISTENCE_SCHEMA): Migrated
{
  if (!isRecord(value))
  {
    return { status: 'invalid', reason: 'not an object' }
  }
  const schema = value.schema
  if (!isCount(schema) || schema < 1)
  {
    return { status: 'invalid', reason: 'no schema version' }
  }
  if (schema > target)
  {
    return { status: 'newer', schema }
  }
  let file = value
  for (let version = schema; version < target; version++)
  {
    const step = migrations[version] as Migration | undefined
    if (step === undefined)
    {
      return { status: 'invalid', reason: `no migration from schema ${version}` }
    }
    file = { ...step(file), schema: version + 1 }
  }
  return { status: 'ok', file }
}

/** A versioned file as read. */
export type VersionedRead =
  | { status: 'ok'; value: Record<string, unknown> }
  | { status: 'missing' }
  | { status: 'newer'; schema: number }
  | { status: 'corrupt'; reason: string }

/** Reads a file that carries `schema` and migrates it; a newer or unreadable file is reported and left as it is. */
export async function readVersioned(io: PersistenceIO, path: string, migrations: Migrations): Promise<VersionedRead>
{
  const read = await readJson(io, path)
  if (read.status !== 'ok')
  {
    return read
  }
  const migrated = migrate(read.value, migrations)
  switch (migrated.status)
  {
    case 'ok':
      return { status: 'ok', value: migrated.file }
    case 'newer':
      return migrated
    default:
      return { status: 'corrupt', reason: migrated.reason }
  }
}

/** Writes a versioned file atomically with the current schema. */
export function writeVersioned(io: PersistenceIO, path: string, value: object): Promise<void>
{
  return writeJsonAtomic(io, path, { ...value, schema: PERSISTENCE_SCHEMA })
}

/** The two numbering sequences reserved in blocks. */
export type CounterKind = 'catalog' | 'run'

/** The highest number reserved per sequence. */
export interface CounterMarks
{
  catalog: number
  run: number
}

/** A journal entry before it is numbered; `type` tags it, and the type `counter` belongs to the store. */
export interface JournalEntry
{
  type: string
}

/** A journal entry with its global, gap-free line number. */
export type JournalLine<E extends JournalEntry = JournalEntry> = E & { n: number }

interface CounterLine
{
  n: number
  type: 'counter'
  counter: CounterKind
  reserved: number
}

/** `session.json`. */
export interface SessionInfo
{
  pid: number
  startedAt: number
  cleanExit: boolean
}

/** A storage problem for the engine to raise as a run alert. */
export interface PersistenceAlert
{
  kind: Extract<RunAlertKind, 'disk-space' | 'storage-error' | 'queue-recovered'>
  cause: 'write-failed' | 'compaction-failed' | 'queue-dropped' | 'corrupt-state' | 'newer-schema'
  /** The file system error code, when a write failed. */
  code: string | null
  /** The names of the files moved aside, for `corrupt-state`. */
  movedAside: string[]
}

/** What the store needs from the engine and the host. */
export interface JobStoreOptions<S extends object>
{
  io: PersistenceIO
  /** `<userData>/jobs`. */
  dir: string
  platform: JobEngineDeps['platform']
  timers: Timers
  log: Pick<JobLogger, 'debug' | 'info' | 'warn' | 'error'>
  pid: number
  /**
   * The state body of `state.json` (policy, default recipe, run, order, jobs), built in one synchronous turn and
   * reflecting every line appended so far. It must not carry the header keys `schema`, `lastN`, `savedAt`, `counters`.
   */
  snapshot(): S
  /** Whether no run is active; the after-run compaction runs only then. */
  isIdle(): boolean
  onAlert(alert: PersistenceAlert): void
  /** Called when a write succeeds after failures, so work held for storage can proceed. */
  onWritable?(): void
  migrations?: Migrations
  limits?: Partial<StoreLimits>
}

/** What `load` found on disk. */
export interface LoadedState<S, E extends JournalEntry>
{
  /** The file the snapshot came from; 'none' when there was no snapshot to read. */
  source: 'state' | 'tmp' | 'bak' | 'none'
  /** The snapshot's state body; null when the queue starts from nothing. */
  body: S | null
  /** The snapshot's `lastN`; every line in `lines` comes after it. */
  snapshotN: number
  savedAt: number | null
  /** Every journal line after the snapshot, in `n` order, with duplicates, gaps, and counter lines left out. */
  lines: Array<JournalLine<E>>
  /** Ranges of line numbers missing from the journal. */
  gaps: Array<{ from: number; to: number }>
  /** The reserved marks from the snapshot and every counter line found. */
  counters: CounterMarks
  /** The session before this one; null on a first start. */
  previous: SessionInfo | null
  /** The files on disk belong to a newer version and were left untouched; this session uses `state.v1.json`. */
  newer: boolean
  /** The names of the files moved aside because no snapshot was readable. */
  movedAside: string[]
}

/** The write queue's health. */
export interface StoreHealth
{
  /** False while writes fail or the dropped queue waits for its full compaction. */
  writable: boolean
  /** Bytes of lines not yet written. */
  pendingBytes: number
  /** Bytes of journal lines after the newest snapshot. */
  journalBytes: number
  newer: boolean
}

interface Waiter
{
  resolve(): void
  reject(err: unknown): void
}

interface AppendItem
{
  kind: 'append'
  path: string
  text: string
  bytes: number
  written: boolean
  /** Resolved once written; rejected only when the queue is dropped. */
  waiters: Waiter[]
}

/** A barrier: every line queued before it is synced before its waiters resolve. */
interface SyncItem
{
  kind: 'sync'
  waiters: Waiter[]
}

type QueueItem = AppendItem | SyncItem

interface Segment
{
  path: string
  first: number
  /** The last line number it holds or will hold. */
  last: number
}

interface LoadedSegment extends Segment
{
  lines: JournalLine[]
  bytes: number
}

interface CounterState
{
  next: number
  /** Numbers up to here are durably reserved and may be issued. */
  reserved: number
  /** The highest block end given a line, durable or not; the snapshot records it. */
  mark: number
  pending: Promise<void> | null
}

interface Present
{
  state: boolean
  tmp: boolean
  bak: boolean
}

type SnapshotRead =
  | { kind: 'ok'; source: 'state' | 'tmp' | 'bak'; file: Record<string, unknown>; present: Present }
  | { kind: 'newer'; schema: number; present: Present }
  | { kind: 'none'; present: Present }

const SNAPSHOT_SOURCES = ['state', 'tmp', 'bak'] as const
const TIMER_NAMES = ['flushTimer', 'quietTimer', 'afterRunTimer', 'compactTimer', 'retryTimer'] as const
const COUNTER_KINDS: readonly CounterKind[] = ['catalog', 'run']
const HEADER_KEYS = new Set(['schema', 'lastN', 'savedAt', 'counters'])
const SEGMENT_NAME = /^(\d+)\.jsonl$/

function isJournalLine(value: unknown): value is JournalLine
{
  return isRecord(value) && isCount(value.n) && value.n >= 1 && typeof value.type === 'string'
}

function isCounterLine(line: JournalLine): line is JournalLine & CounterLine
{
  const counter = (line as Partial<CounterLine>).counter
  return line.type === 'counter' && (counter === 'catalog' || counter === 'run') && isCount((line as Partial<CounterLine>).reserved)
}

function readMarks(value: unknown): CounterMarks
{
  const marks: CounterMarks = { catalog: 0, run: 0 }
  if (isRecord(value))
  {
    for (const kind of COUNTER_KINDS)
    {
      const mark = value[kind]
      if (isCount(mark))
      {
        marks[kind] = mark
      }
    }
  }
  return marks
}

function parseSnapshot(text: string, migrations: Migrations): Migrated
{
  let value: unknown
  try
  {
    value = JSON.parse(text)
  }
  catch
  {
    return { status: 'invalid', reason: 'incomplete JSON' }
  }
  const migrated = migrate(value, migrations)
  if (migrated.status === 'ok' && !isCount(migrated.file.lastN))
  {
    return { status: 'invalid', reason: 'no line number' }
  }
  return migrated
}

function parseSession(text: string | null): SessionInfo | null
{
  if (text === null)
  {
    return null
  }
  try
  {
    const value: unknown = JSON.parse(text)
    if (isRecord(value) && typeof value.pid === 'number' && typeof value.startedAt === 'number' && typeof value.cleanExit === 'boolean')
    {
      return { pid: value.pid, startedAt: value.startedAt, cleanExit: value.cleanExit }
    }
  }
  catch
  {
    return null
  }
  return null
}

function bodyOf(file: Record<string, unknown>): Record<string, unknown>
{
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(file))
  {
    if (!HEADER_KEYS.has(key))
    {
      body[key] = value
    }
  }
  return body
}

function alertKind(code: string | null): 'disk-space' | 'storage-error'
{
  return code === 'ENOSPC' ? 'disk-space' : 'storage-error'
}

function resolveAll(waiters: readonly Waiter[]): void
{
  for (const waiter of waiters)
  {
    waiter.resolve()
  }
}

function rejectAll(waiters: readonly Waiter[], err: unknown): void
{
  for (const waiter of waiters)
  {
    waiter.reject(err)
  }
}

/** Lines after `after`, in `n` order, each line number once. */
function orderAfter(lines: readonly JournalLine[], after: number): JournalLine[]
{
  const sorted = lines.filter((line) => line.n > after).sort((a, b) => a.n - b.n)
  return sorted.filter((line, index) => index === 0 || sorted[index - 1].n !== line.n)
}

function findGaps(lines: readonly JournalLine[], after: number): Array<{ from: number; to: number }>
{
  const gaps: Array<{ from: number; to: number }> = []
  let expected = after + 1
  for (const line of lines)
  {
    if (line.n > expected)
    {
      gaps.push({ from: expected, to: line.n - 1 })
    }
    expected = line.n + 1
  }
  return gaps
}

/**
 * The engine's persistence: a snapshot plus a segmented journal with a global, gap-free line number; a write queue
 * that appends in batches every 250 ms, group-commits durable lines, and retries failed writes; counters reserved in
 * blocks; compaction; and the loader with its fallbacks.
 */
export class JobStore<S extends object, E extends JournalEntry>
{
  readonly paths: JobsPaths
  private readonly o: JobStoreOptions<S>
  private readonly limits: StoreLimits
  private layout: Layout
  private newer = false
  private loaded = false
  private ended = false
  private n = 0
  private startedAt = 0
  private segment: Segment = { path: '', first: 1, last: 0 }
  private segments: Segment[] = []
  /** The line numbers of the valid snapshots known to be at `state.json` and `state.json.bak`. */
  private disk: { state: number | null; bak: number | null } = { state: null, bak: null }
  private buffer: string[] = []
  private bufferBytes = 0
  private journalBytes = 0
  private queue: QueueItem[] = []
  private queueBytes = 0
  private readonly torn = new Set<string>()
  private readonly unsynced = new Set<string>()
  private durableWaiters: Waiter[] = []
  private durableScheduled = false
  private pumping: Promise<void> | null = null
  private failing = false
  private alerted = false
  private lastCode: string | null = null
  private needsFull = false
  private compaction: Promise<boolean> | null = null
  private compactAlerted = false
  private flushTimer: TimerHandle | null = null
  private quietTimer: TimerHandle | null = null
  private afterRunTimer: TimerHandle | null = null
  private compactTimer: TimerHandle | null = null
  private retryTimer: TimerHandle | null = null
  private readonly counters: Record<CounterKind, CounterState> =
  {
    catalog: { next: 1, reserved: 0, mark: 0, pending: null },
    run: { next: 1, reserved: 0, mark: 0, pending: null }
  }

  constructor(options: JobStoreOptions<S>)
  {
    this.o = options
    this.limits = { ...STORE_LIMITS, ...options.limits }
    this.paths = jobsPaths(options.dir)
    this.layout = layoutOf(options.dir, '')
  }

  /** The last line number assigned, buffered lines included. */
  get lastN(): number
  {
    return this.n
  }

  /** The write queue's health. */
  get health(): StoreHealth
  {
    return {
      writable: !this.failing && !this.needsFull,
      pendingBytes: this.queueBytes + this.bufferBytes,
      journalBytes: this.journalBytes,
      newer: this.newer
    }
  }

  /**
   * Reads the snapshot (`state.json`, else a complete and valid `.tmp`, else `.bak`) and every journal line after it
   * from all segments in `n` order, then opens this session's segment and marks the session started. A newer schema
   * is left untouched and this session uses `state.v1.json`; when no snapshot is readable the files are moved aside
   * and the queue starts empty.
   */
  async load(): Promise<LoadedState<S, E>>
  {
    if (this.loaded)
    {
      throw new Error('The job store is already loaded')
    }
    const { io, log } = this.o
    await io.mkdir(this.o.dir)
    const previous = parseSession(await this.readQuietly(this.paths.session))
    let found = await this.readSnapshot(this.layout)
    if (found.kind === 'newer')
    {
      log.warn(`The queue on disk was saved by a newer version (schema ${found.schema}); it is left untouched and this session saves to state.v1.json`)
      this.o.onAlert({ kind: 'queue-recovered', cause: 'newer-schema', code: null, movedAside: [] })
      this.newer = true
      this.layout = layoutOf(this.o.dir, '.v1')
      found = await this.readSnapshot(this.layout)
    }
    await io.mkdir(this.layout.journal)
    const journal = await this.readJournal()
    const all = journal.segments.flatMap((segment) => segment.lines)
    const marks = readMarks(found.kind === 'ok' ? found.file.counters : undefined)
    for (const line of all)
    {
      if (isCounterLine(line))
      {
        marks[line.counter] = Math.max(marks[line.counter], line.reserved)
      }
    }
    const ok = found.kind === 'ok' ? found : null
    const corrupt = ok === null && (found.present.state || found.present.bak)
    let movedAside: string[] = []
    if (corrupt)
    {
      movedAside = await this.moveAside(found.present, journal.segments.length > 0)
      log.error(`No queue snapshot was readable; moved aside ${movedAside.join(', ') || 'nothing'} and starting with an empty queue`)
      this.o.onAlert({ kind: 'queue-recovered', cause: 'corrupt-state', code: null, movedAside })
    }
    const snapshotN = ok === null ? 0 : (ok.file.lastN as number)
    const replay = corrupt ? [] : orderAfter(all, snapshotN)
    const gaps = findGaps(replay, snapshotN)
    for (const gap of gaps)
    {
      log.warn(`Journal lines ${gap.from} to ${gap.to} are missing; replay continues after them`)
    }
    this.n = all.reduce((max, line) => Math.max(max, line.n), snapshotN)
    this.disk = { state: ok?.source === 'state' ? snapshotN : null, bak: ok?.source === 'bak' ? snapshotN : null }
    const first = this.n + 1
    const path = this.segmentPath(first)
    const journalMoved = movedAside.some((name) => name.startsWith(basename(this.layout.journal)))
    this.segments = journalMoved ? [] : journal.segments.filter((segment) => segment.path !== path).map((segment) => ({ path: segment.path, first: segment.first, last: segment.last }))
    this.segment = { path, first, last: this.n }
    if (!journalMoved && journal.names.has(basename(path)))
    {
      this.torn.add(path)
    }
    this.journalBytes = corrupt ? 0 : journal.segments.filter((segment) => segment.last > snapshotN).reduce((sum, segment) => sum + segment.bytes, 0)
    for (const kind of COUNTER_KINDS)
    {
      this.counters[kind] = { next: marks[kind] + 1, reserved: marks[kind], mark: marks[kind], pending: null }
    }
    this.startedAt = this.o.timers.now()
    this.loaded = true
    await this.writeSession(false)
    return {
      source: ok === null ? 'none' : ok.source,
      body: ok === null ? null : (bodyOf(ok.file) as unknown as S),
      snapshotN,
      savedAt: ok !== null && typeof ok.file.savedAt === 'number' ? ok.file.savedAt : null,
      lines: replay.filter((line) => !isCounterLine(line)) as unknown as Array<JournalLine<E>>,
      gaps,
      counters: { ...marks },
      previous,
      newer: this.newer,
      movedAside
    }
  }

  /** Appends a line to the current segment's batch, which is written within 250 ms; returns its line number. */
  append(entry: E): number
  {
    if (this.ended)
    {
      this.o.log.warn(`Dropped a ${entry.type} line after the job store closed`)
      return this.n
    }
    const n = this.push(entry)
    this.armFlush()
    this.considerCompaction()
    return n
  }

  /**
   * Appends lines that must be on disk before the step they guard runs. Every buffered line before them goes in the
   * same write, durable lines from the same moment share one write and one fsync, and the promise resolves after the
   * fsync or rejects when the lines cannot be made durable.
   */
  appendDurable(entries: readonly E[]): Promise<number[]>
  {
    if (this.ended)
    {
      return Promise.reject(new Error('The job store is closed'))
    }
    const ns = entries.map((entry) => this.push(entry))
    this.considerCompaction()
    return this.durable().then(() => ns)
  }

  /** Writes the buffered lines now and waits for the write queue to settle. */
  async flush(): Promise<void>
  {
    this.cut()
    this.pump()
    await this.settled()
  }

  /**
   * Appends JSON lines to a file outside the journal, such as a run's history or the work-folder registry, through
   * the write queue. A durable append resolves after the fsync and rejects when it fails; another resolves once
   * written, is retried with the queue, and rejects only when the queue is dropped.
   */
  appendLines(path: string, values: readonly unknown[], durable = false): Promise<void>
  {
    if (this.ended)
    {
      return Promise.reject(new Error('The job store is closed'))
    }
    const text = values.map(jsonLine).join('')
    return new Promise((resolve, reject) =>
    {
      const waiter: Waiter = { resolve, reject }
      const item: AppendItem = { kind: 'append', path, text, bytes: Buffer.byteLength(text), written: false, waiters: durable ? [] : [waiter] }
      if (durable)
      {
        this.enqueue(item)
        this.enqueue({ kind: 'sync', waiters: [waiter] })
        this.kick()
      }
      else
      {
        this.enqueue(item)
        this.pump()
      }
    })
  }

  /** How many numbers of a sequence can be issued before another block must be reserved. */
  available(kind: CounterKind): number
  {
    const counter = this.counters[kind]
    return Math.max(0, counter.reserved - counter.next + 1)
  }

  /** Issues the next number of the reserved block, or null when the block is used up. */
  take(kind: CounterKind): number | null
  {
    if (this.available(kind) === 0)
    {
      return null
    }
    const counter = this.counters[kind]
    counter.next += 1
    return counter.next - 1
  }

  /**
   * Makes at least `count` numbers available, reserving blocks of 100 with one durable counter line before any number
   * from them is issued; rejects when the line cannot be made durable.
   */
  async reserve(kind: CounterKind, count = 1): Promise<void>
  {
    const counter = this.counters[kind]
    while (this.available(kind) < count)
    {
      if (counter.pending === null)
      {
        counter.pending = this.reserveBlocks(kind, count).finally(() =>
        {
          counter.pending = null
        })
      }
      await counter.pending
    }
  }

  /** Issues one number: the rest of the current block first, then a newly reserved one. */
  async issue(kind: CounterKind): Promise<number>
  {
    for (;;)
    {
      const value = this.take(kind)
      if (value !== null)
      {
        return value
      }
      await this.reserve(kind)
    }
  }

  /** Issues `count` consecutive numbers in one turn, so jobs created together get distinct numbers in order. */
  async issueMany(kind: CounterKind, count: number): Promise<number[]>
  {
    while (this.available(kind) < count)
    {
      await this.reserve(kind, count)
    }
    return Array.from({ length: count }, () => this.take(kind) as number)
  }

  /** Raises the next number past a sequence found in the snapshot, the journal, the run index, or the registry. */
  observe(kind: CounterKind, seq: number): void
  {
    const counter = this.counters[kind]
    if (Number.isInteger(seq) && seq >= counter.next)
    {
      counter.next = seq + 1
    }
  }

  /**
   * Saves a snapshot after any compaction in progress and resolves whether it was saved. In one synchronous turn it
   * reads `lastN`, switches appends to a new segment, and serializes the state; then it writes and syncs
   * `state.json.tmp`, renames `state.json` to `state.json.bak` and the temporary file to `state.json`, syncs the
   * folder on POSIX, and only then deletes the segments the `.bak` snapshot no longer needs.
   */
  async compact(): Promise<boolean>
  {
    while (this.compaction !== null)
    {
      await this.compaction
    }
    if (this.ended || !this.loaded)
    {
      return false
    }
    const run = this.runCompaction().finally(() =>
    {
      this.compaction = null
    })
    this.compaction = run
    return run
  }

  /** Schedules the compaction 30 s after a run completes; it runs if the engine is idle by then. */
  runCompleted(): void
  {
    if (this.ended)
    {
      return
    }
    this.stopTimer('afterRunTimer')
    this.afterRunTimer = this.o.timers.setTimeout(() =>
    {
      this.afterRunTimer = null
      if (this.o.isIdle() && this.compaction === null)
      {
        void this.compact()
      }
    }, this.limits.afterRunMs)
  }

  /**
   * The Windows session-end path, where the process is about to be terminated: appends every unwritten line and
   * `entries` (the interrupted marks) in one synchronous batch, abandons a compaction in progress, and never compacts.
   */
  sessionEnd(entries: readonly E[]): void
  {
    if (this.ended || !this.loaded)
    {
      return
    }
    for (const entry of entries)
    {
      this.push(entry)
    }
    this.ended = true
    this.cut()
    this.stopTimers()
    const closed = new Error('The session ended')
    rejectAll(this.durableWaiters.splice(0), closed)
    const writes: Array<{ path: string; text: string; waiters: Waiter[] }> = []
    for (const item of this.queue)
    {
      if (item.kind === 'sync')
      {
        rejectAll(item.waiters.splice(0), closed)
        continue
      }
      if (item.written)
      {
        continue
      }
      const last = writes[writes.length - 1]
      if (last !== undefined && last.path === item.path)
      {
        last.text += item.text
        last.waiters.push(...item.waiters.splice(0))
      }
      else
      {
        writes.push({ path: item.path, text: item.text, waiters: item.waiters.splice(0) })
      }
    }
    this.queue = []
    this.queueBytes = 0
    for (const write of writes)
    {
      try
      {
        this.o.io.appendSync(write.path, `\n${write.text}`)
        resolveAll(write.waiters)
      }
      catch (err)
      {
        this.o.log.error(`Could not write the job lines at session end: ${messageOf(err)}`)
        rejectAll(write.waiters, err)
      }
    }
  }

  /**
   * The clean shutdown: saves a final snapshot, writes what is queued, and marks the session's exit clean when both
   * worked. Resolves whether the exit was recorded as clean.
   */
  async close(): Promise<boolean>
  {
    if (this.ended || !this.loaded)
    {
      return false
    }
    this.stopTimers()
    const saved = await this.compact()
    this.cut()
    this.pump(true)
    await this.settled()
    const clean = saved && this.queue.length === 0
    this.ended = true
    this.stopTimers()
    rejectAll(this.durableWaiters.splice(0), new Error('The job store is closed'))
    return clean && (await this.writeSession(true))
  }

  /**
   * Discards the newer version's queue files once the user chooses so in Settings: deletes them, saves this session's
   * state as `state.json`, and removes the `state.v1.json` files. Resolves whether the state was saved.
   */
  async discardNewer(): Promise<boolean>
  {
    if (!this.newer || this.ended)
    {
      return false
    }
    const normal = layoutOf(this.o.dir, '')
    const v1 = this.layout
    for (const path of [normal.state, normal.tmp, normal.bak])
    {
      await this.removeIfPresent(path)
    }
    for (const name of await this.o.io.list(normal.journal))
    {
      if (SEGMENT_NAME.test(name))
      {
        await this.removeIfPresent(join(normal.journal, name))
      }
    }
    await this.o.io.mkdir(normal.journal)
    while (this.compaction !== null)
    {
      await this.compaction
    }
    this.newer = false
    this.layout = normal
    this.disk = { state: null, bak: null }
    if (!(await this.compact()))
    {
      return false
    }
    await this.settled()
    const stale = this.segments.filter((segment) => dirname(segment.path) === v1.journal)
    for (const segment of stale)
    {
      await this.removeIfPresent(segment.path)
      this.forget(segment.path)
    }
    this.segments = this.segments.filter((segment) => !stale.includes(segment))
    for (const path of [v1.state, v1.tmp, v1.bak])
    {
      await this.removeIfPresent(path)
    }
    return true
  }

  private segmentPath(first: number): string
  {
    return join(this.layout.journal, `${first}.jsonl`)
  }

  private push(entry: JournalEntry): number
  {
    if (!this.loaded)
    {
      throw new Error('Load the job store before appending')
    }
    const text = jsonLine({ n: this.n + 1, ...entry })
    const bytes = Buffer.byteLength(text)
    this.n += 1
    this.buffer.push(text)
    this.bufferBytes += bytes
    this.journalBytes += bytes
    this.segment.last = this.n
    return this.n
  }

  private armFlush(): void
  {
    if (this.flushTimer === null)
    {
      this.flushTimer = this.o.timers.setTimeout(() =>
      {
        this.flushTimer = null
        this.cut()
        this.pump()
      }, this.limits.flushMs)
    }
  }

  private stopTimer(name: 'flushTimer' | 'quietTimer' | 'afterRunTimer' | 'compactTimer' | 'retryTimer'): void
  {
    const handle = this[name]
    if (handle !== null)
    {
      this.o.timers.clearTimeout(handle)
      this[name] = null
    }
  }

  /** Moves the buffered lines into the write queue as one batch for the current segment. */
  private cut(): void
  {
    this.stopTimer('flushTimer')
    if (this.buffer.length === 0)
    {
      return
    }
    const item: AppendItem = { kind: 'append', path: this.segment.path, text: this.buffer.join(''), bytes: this.bufferBytes, written: false, waiters: [] }
    this.buffer = []
    this.bufferBytes = 0
    this.enqueue(item)
  }

  private enqueue(item: QueueItem): void
  {
    this.queue.push(item)
    if (item.kind === 'append')
    {
      this.queueBytes += item.bytes
    }
    if (this.failing && !this.ended && this.pumping === null && this.queueBytes + this.bufferBytes > this.limits.queueLimitBytes)
    {
      this.dropQueue()
    }
  }

  private durable(): Promise<void>
  {
    return new Promise((resolve, reject) =>
    {
      this.durableWaiters.push({ resolve, reject })
      if (this.durableScheduled)
      {
        return
      }
      this.durableScheduled = true
      queueMicrotask(() =>
      {
        this.durableScheduled = false
        const waiters = this.durableWaiters.splice(0)
        if (this.ended)
        {
          rejectAll(waiters, new Error('The job store is closed'))
          return
        }
        this.cut()
        this.enqueue({ kind: 'sync', waiters })
        this.kick()
      })
    })
  }

  /** Attempts the pending writes now: the full compaction when the queue was dropped, else a write pass. */
  private kick(): void
  {
    if (this.needsFull)
    {
      if (this.compaction === null)
      {
        void this.compact()
      }
      return
    }
    this.pump(true)
  }

  /** Starts a write pass unless one is running; while writes fail, only a retry or a durable request forces one. */
  private pump(force = false): void
  {
    if (this.ended || this.pumping !== null || this.needsFull || this.queue.length === 0 || (this.failing && !force))
    {
      return
    }
    this.pumping = this.pass().finally(() =>
    {
      this.pumping = null
      this.pump()
    })
  }

  private async settled(): Promise<void>
  {
    while (this.pumping !== null)
    {
      await this.pumping
    }
  }

  /**
   * Writes everything queued when the pass starts: consecutive batches for one file in one append, then one fsync of
   * every written file when the pass holds a durable barrier.
   */
  private async pass(): Promise<void>
  {
    const items = this.queue.slice()
    const groups: AppendItem[][] = []
    for (const item of items)
    {
      if (item.kind !== 'append' || item.written)
      {
        continue
      }
      const last = groups[groups.length - 1]
      if (last !== undefined && last[0].path === item.path)
      {
        last.push(item)
      }
      else
      {
        groups.push([item])
      }
    }
    try
    {
      for (const group of groups)
      {
        await this.writeGroup(group)
      }
      if (items.some((item) => item.kind === 'sync'))
      {
        for (const path of [...this.unsynced])
        {
          await this.syncFile(path)
          this.unsynced.delete(path)
        }
      }
    }
    catch (err)
    {
      this.passFailed(err)
      return
    }
    const done = new Set<QueueItem>(items)
    this.queue = this.queue.filter((item) => !done.has(item))
    for (const item of items)
    {
      resolveAll(item.waiters.splice(0))
    }
    this.recovered()
  }

  private async writeGroup(group: AppendItem[]): Promise<void>
  {
    const path = group[0].path
    const text = group.map((item) => item.text).join('')
    try
    {
      await this.appendCreating(path, this.torn.has(path) ? `\n${text}` : text)
    }
    catch (err)
    {
      this.torn.add(path)
      throw err
    }
    this.torn.delete(path)
    this.unsynced.add(path)
    for (const item of group)
    {
      item.written = true
      this.queueBytes -= item.bytes
      resolveAll(item.waiters.splice(0))
    }
  }

  /** Appends, creating the file's folder when it is missing, as a pruned run folder leaves it. */
  private async appendCreating(path: string, text: string): Promise<void>
  {
    try
    {
      await this.o.io.append(path, text)
    }
    catch (err)
    {
      if (codeOf(err) !== 'ENOENT')
      {
        throw err
      }
      await this.o.io.mkdir(dirname(path))
      await this.o.io.append(path, text)
    }
  }

  /** Syncs a written file; one deleted since its write, as a pruned history file is, has nothing left to sync. */
  private async syncFile(path: string): Promise<void>
  {
    try
    {
      await this.o.io.fsync(path)
    }
    catch (err)
    {
      if (codeOf(err) !== 'ENOENT')
      {
        throw err
      }
    }
  }

  private passFailed(err: unknown): void
  {
    const code = codeOf(err)
    const first = !this.failing
    this.failing = true
    this.lastCode = code
    if (first)
    {
      this.o.log.warn(`Could not write the job files (${code ?? messageOf(err)}); retrying every ${this.limits.writeRetryMs / 1000} s`)
    }
    if (!this.alerted)
    {
      this.alerted = true
      this.o.onAlert({ kind: alertKind(code), cause: 'write-failed', code, movedAside: [] })
    }
    this.failDurable(err)
    if (this.queueBytes + this.bufferBytes > this.limits.queueLimitBytes)
    {
      this.dropQueue()
    }
    this.armRetry()
  }

  /** Rejects every durable barrier in the queue, since its lines cannot be synced now; the lines stay queued. */
  private failDurable(err: unknown): void
  {
    for (const item of this.queue)
    {
      if (item.kind === 'sync')
      {
        rejectAll(item.waiters.splice(0), err)
      }
    }
  }

  /** Drops every unwritten line; the in-memory state is complete, so the next successful write is a full compaction. */
  private dropQueue(): void
  {
    const bytes = this.queueBytes + this.bufferBytes
    const dropped = new Error('The write queue was dropped')
    for (const item of this.queue)
    {
      rejectAll(item.waiters.splice(0), dropped)
    }
    rejectAll(this.durableWaiters.splice(0), dropped)
    this.queue = []
    this.queueBytes = 0
    this.buffer = []
    this.bufferBytes = 0
    this.needsFull = true
    this.o.log.error(`Dropped ${bytes} bytes of unwritten job lines; the next successful write saves the whole queue`)
    this.o.onAlert({ kind: alertKind(this.lastCode), cause: 'queue-dropped', code: this.lastCode, movedAside: [] })
  }

  private recovered(): void
  {
    if (!this.failing)
    {
      return
    }
    this.failing = false
    this.alerted = false
    this.stopTimer('retryTimer')
    this.o.log.info('Writes to the job files work again')
    this.o.onWritable?.()
  }

  private armRetry(): void
  {
    if (this.retryTimer === null && !this.ended)
    {
      this.retryTimer = this.o.timers.setTimeout(() =>
      {
        this.retryTimer = null
        this.kick()
      }, this.limits.writeRetryMs)
    }
  }

  private stopTimers(): void
  {
    for (const name of TIMER_NAMES)
    {
      this.stopTimer(name)
    }
  }

  /** Every line is a state event: past 32 MiB the journal compacts at once, past 4 MiB after 2 s without a line. */
  private considerCompaction(): void
  {
    if (this.ended || this.compaction !== null || this.compactTimer !== null || this.failing || this.needsFull)
    {
      return
    }
    if (this.journalBytes > this.limits.hardBytes)
    {
      this.stopTimer('quietTimer')
      this.compactTimer = this.o.timers.setTimeout(() =>
      {
        this.compactTimer = null
        void this.compact()
      }, 0)
      return
    }
    if (this.journalBytes > this.limits.softBytes)
    {
      this.stopTimer('quietTimer')
      this.quietTimer = this.o.timers.setTimeout(() =>
      {
        this.quietTimer = null
        if (this.compaction === null)
        {
          void this.compact()
        }
      }, this.limits.quietMs)
    }
  }

  private marks(): CounterMarks
  {
    return { catalog: this.counters.catalog.mark, run: this.counters.run.mark }
  }

  private async reserveBlocks(kind: CounterKind, count: number): Promise<void>
  {
    if (this.ended)
    {
      throw new Error('The job store is closed')
    }
    const counter = this.counters[kind]
    const from = Math.max(counter.next, counter.reserved + 1)
    const blocks = Math.ceil(Math.max(1, count - this.available(kind)) / COUNTER_BLOCK)
    const end = from + blocks * COUNTER_BLOCK - 1
    counter.mark = Math.max(counter.mark, end)
    const entry = { type: 'counter', counter: kind, reserved: end }
    this.push(entry)
    await this.durable()
    counter.reserved = Math.max(counter.reserved, end)
  }

  private async runCompaction(): Promise<boolean>
  {
    this.stopTimer('quietTimer')
    this.stopTimer('compactTimer')
    this.stopTimer('afterRunTimer')
    const lastN = this.n
    this.cut()
    if (this.segment.last >= this.segment.first || dirname(this.segment.path) !== this.layout.journal)
    {
      this.segments.push(this.segment)
      this.segment = { path: this.segmentPath(lastN + 1), first: lastN + 1, last: lastN }
    }
    const switched = this.journalBytes
    this.journalBytes = 0
    let text: string
    try
    {
      text = JSON.stringify(toWire({ schema: PERSISTENCE_SCHEMA, lastN, savedAt: this.o.timers.now(), counters: this.marks(), ...this.o.snapshot() }))
    }
    catch (err)
    {
      this.journalBytes += switched
      this.o.log.error(`Could not serialize the queue snapshot: ${messageOf(err)}`)
      return false
    }
    this.pump()
    const { io } = this.o
    const layout = this.layout
    try
    {
      await this.removeIfPresent(layout.tmp)
      await io.append(layout.tmp, text)
      await io.fsync(layout.tmp)
      if (this.ended)
      {
        return false
      }
      if (this.disk.state !== null)
      {
        await io.rename(layout.state, layout.bak)
        this.disk.bak = this.disk.state
        this.disk.state = null
      }
      if (this.ended)
      {
        return false
      }
      await io.rename(layout.tmp, layout.state)
      this.disk.state = lastN
      if (this.o.platform !== 'win32')
      {
        await io.fsync(this.o.dir)
      }
    }
    catch (err)
    {
      this.journalBytes += switched
      this.compactionFailed(err)
      return false
    }
    await this.deleteSegments()
    this.compactAlerted = false
    this.o.log.info(`Saved the queue snapshot through line ${lastN}`)
    if (this.needsFull)
    {
      this.needsFull = false
      this.recovered()
    }
    this.pump()
    return true
  }

  private compactionFailed(err: unknown): void
  {
    const code = codeOf(err)
    this.o.log.warn(`Could not save the queue snapshot (${code ?? messageOf(err)}); appends continue and the save is retried`)
    if (!this.compactAlerted)
    {
      this.compactAlerted = true
      this.o.onAlert({ kind: alertKind(code), cause: 'compaction-failed', code, movedAside: [] })
    }
    if (this.ended)
    {
      return
    }
    if (this.needsFull)
    {
      this.lastCode = code
      this.failing = true
      this.failDurable(err)
      this.armRetry()
      return
    }
    this.compactTimer = this.o.timers.setTimeout(() =>
    {
      this.compactTimer = null
      void this.compact()
    }, this.limits.compactRetryMs)
  }

  /** Deletes the segments whose last line the `.bak` snapshot already holds; none while the `.bak` is unknown. */
  private async deleteSegments(): Promise<void>
  {
    const keep = this.disk.bak
    if (keep === null)
    {
      return
    }
    const busy = new Set(this.queue.map((item) => (item.kind === 'append' ? item.path : '')))
    const kept: Segment[] = []
    for (const segment of this.segments)
    {
      if (segment.last > keep || busy.has(segment.path) || this.ended)
      {
        kept.push(segment)
        continue
      }
      try
      {
        await this.removeIfPresent(segment.path)
        this.forget(segment.path)
      }
      catch (err)
      {
        this.o.log.warn(`Could not delete journal segment ${basename(segment.path)}: ${messageOf(err)}`)
        kept.push(segment)
      }
    }
    this.segments = kept
  }

  /** Drops a deleted file from the sync and torn-line bookkeeping, so a later barrier never syncs a missing file. */
  private forget(path: string): void
  {
    this.unsynced.delete(path)
    this.torn.delete(path)
  }

  private async removeIfPresent(path: string): Promise<void>
  {
    try
    {
      await this.o.io.unlink(path)
    }
    catch (err)
    {
      if (codeOf(err) !== 'ENOENT')
      {
        throw err
      }
    }
  }

  private async readQuietly(path: string): Promise<string | null>
  {
    try
    {
      return await this.o.io.read(path)
    }
    catch (err)
    {
      this.o.log.warn(`Could not read ${basename(path)}: ${messageOf(err)}`)
      return null
    }
  }

  private async readSnapshot(layout: Layout): Promise<SnapshotRead>
  {
    const present: Present = { state: false, tmp: false, bak: false }
    for (const source of SNAPSHOT_SOURCES)
    {
      const path = layout[source]
      let text: string | null
      try
      {
        text = await this.o.io.read(path)
      }
      catch (err)
      {
        present[source] = true
        this.o.log.warn(`Could not read ${basename(path)}: ${messageOf(err)}`)
        continue
      }
      if (text === null)
      {
        continue
      }
      present[source] = true
      const parsed = parseSnapshot(text, this.o.migrations ?? STATE_MIGRATIONS)
      if (parsed.status === 'ok')
      {
        return { kind: 'ok', source, file: parsed.file, present }
      }
      if (parsed.status === 'newer' && !this.newer)
      {
        return { kind: 'newer', schema: parsed.schema, present }
      }
      this.o.log.warn(`Skipped ${basename(path)}: ${parsed.status === 'newer' ? `schema ${parsed.schema}` : parsed.reason}`)
    }
    return { kind: 'none', present }
  }

  private async readJournal(): Promise<{ segments: LoadedSegment[]; names: Set<string> }>
  {
    const dir = this.layout.journal
    const names = await this.o.io.list(dir)
    const segments: LoadedSegment[] = []
    for (const name of names)
    {
      const match = SEGMENT_NAME.exec(name)
      if (match === null)
      {
        continue
      }
      const path = join(dir, name)
      const text = (await this.readQuietly(path)) ?? ''
      const parsed = parseJsonLines(text)
      const lines = parsed.values.filter(isJournalLine)
      const bad = parsed.skipped + parsed.values.length - lines.length
      if (parsed.torn)
      {
        this.o.log.info(`Ignored a torn last line in journal segment ${name}`)
      }
      if (bad > 0)
      {
        this.o.log.warn(`Skipped ${bad} unreadable lines in journal segment ${name}`)
      }
      const first = Number(match[1])
      const last = lines.reduce((max, line) => Math.max(max, line.n), first - 1)
      segments.push({ path, first, last, lines, bytes: Buffer.byteLength(text) })
    }
    segments.sort((a, b) => a.first - b.first)
    return { segments, names: new Set(names) }
  }

  private async moveAside(present: Present, journal: boolean): Promise<string[]>
  {
    const stamp = new Date(this.o.timers.now()).toISOString().replace(/[:.]/g, '-')
    const { stem } = this.layout
    const moves: Array<[string, string]> = []
    if (present.state)
    {
      moves.push([this.layout.state, `${stem}.corrupt-${stamp}.json`])
    }
    if (present.tmp)
    {
      moves.push([this.layout.tmp, `${stem}.corrupt-${stamp}.tmp.json`])
    }
    if (present.bak)
    {
      moves.push([this.layout.bak, `${stem}.corrupt-${stamp}.bak.json`])
    }
    if (journal)
    {
      moves.push([this.layout.journal, `${basename(this.layout.journal)}.corrupt-${stamp}`])
    }
    const moved: string[] = []
    for (const [from, name] of moves)
    {
      try
      {
        await this.o.io.rename(from, join(this.o.dir, name))
        moved.push(name)
      }
      catch (err)
      {
        this.o.log.warn(`Could not move ${basename(from)} aside: ${messageOf(err)}`)
      }
    }
    await this.o.io.mkdir(this.layout.journal)
    return moved
  }

  private async writeSession(cleanExit: boolean): Promise<boolean>
  {
    try
    {
      await writeJsonAtomic(this.o.io, this.paths.session, { pid: this.o.pid, startedAt: this.startedAt, cleanExit })
      return true
    }
    catch (err)
    {
      this.o.log.warn(`Could not write session.json: ${messageOf(err)}`)
      return false
    }
  }
}
