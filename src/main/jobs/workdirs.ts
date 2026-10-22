/**
 * The registry of execution work folders. Every folder is recorded durably in `workdirs.jsonl` before it exists, and
 * the sweeper deletes only registered folders whose execution has ended and whose marker carries the registered token.
 */

import * as fsp from 'node:fs/promises'
import type { JobId } from '../../shared/jobs/ids'
import type { Platform } from '../../shared/text/platform'
import type { Timers } from '../timers'
import type { FsOps, JobLogger, PersistenceIO } from './deps'
import { CLEANUP_BUDGET_MS, CLEANUP_CODES, LOCK_CODES, errorCode, withLockRetries } from './fsops'
import { markerPath, pathApi, pathKey, workDirPath } from './naming'
import { parseJsonLines, rewriteJsonLines } from './persistence'

/** A registered work folder, as its `create` line records it. */
export interface WorkDirEntry
{
  path: string
  jobId: JobId
  attempt: number
  execution: number
  /** A random 64-bit hex string, also written into the folder's marker. */
  token: string
  at: number
}

/** A registry line: a folder about to be created, or one deleted. */
export type WorkDirLine =
  | ({ op: 'create' } & WorkDirEntry)
  | { op: 'deleted'; path: string }

/** The marker `job.json` inside a work folder. */
export interface WorkDirMarker
{
  jobId: JobId
  attempt: number
  execution: number
  token: string
  source: string
  finalPath: string
  createdAt: number
}

/** The file access the registry needs inside user folders, besides `FsOps`. */
export interface WorkDirFiles
{
  /** Null when nothing is at the path. */
  readText(path: string): Promise<string | null>
  /** Writes a new file; fails when something is already at the path. */
  writeNew(path: string, text: string): Promise<void>
  /** What is at a path. */
  kind(path: string): Promise<'dir' | 'other' | 'missing'>
  list(dir: string): Promise<string[]>
  /** Removes an empty folder; fails when it is not empty. */
  removeEmpty(dir: string): Promise<void>
}

/** Appends registry lines; `JobStore.appendLines` resolves a durable append only after the fsync. */
export interface RegistryWriter
{
  appendLines(path: string, values: readonly unknown[], durable?: boolean): Promise<void>
}

function isCount(value: unknown): value is number
{
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isText(value: unknown): value is string
{
  return typeof value === 'string' && value !== ''
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A registry line, or null for anything else. */
export function parseWorkDirLine(value: unknown): WorkDirLine | null
{
  if (!isRecord(value) || !isText(value.path))
  {
    return null
  }
  if (value.op === 'deleted')
  {
    return { op: 'deleted', path: value.path }
  }
  if (value.op !== 'create' || !isText(value.jobId) || !isCount(value.attempt) || !isCount(value.execution) ||
    !isText(value.token) || typeof value.at !== 'number' || !Number.isFinite(value.at))
  {
    return null
  }
  return {
    op: 'create',
    path: value.path,
    jobId: value.jobId as JobId,
    attempt: value.attempt,
    execution: value.execution,
    token: value.token,
    at: value.at
  }
}

/** A marker read from its text, or null when the text is not one. */
export function parseMarker(text: string): WorkDirMarker | null
{
  let value: unknown
  try
  {
    value = JSON.parse(text)
  }
  catch
  {
    return null
  }
  if (!isRecord(value) || !isText(value.jobId) || !isCount(value.attempt) || !isCount(value.execution) ||
    !isText(value.token) || typeof value.source !== 'string' || typeof value.finalPath !== 'string' ||
    typeof value.createdAt !== 'number')
  {
    return null
  }
  return {
    jobId: value.jobId as JobId,
    attempt: value.attempt,
    execution: value.execution,
    token: value.token,
    source: value.source,
    finalPath: value.finalPath,
    createdAt: value.createdAt
  }
}

/** The real `WorkDirFiles` over `node:fs`. */
export function createNodeWorkDirFiles(): WorkDirFiles
{
  return {
    async readText(path: string): Promise<string | null>
    {
      try
      {
        return await fsp.readFile(path, 'utf8')
      }
      catch (err)
      {
        if (errorCode(err) === 'ENOENT')
        {
          return null
        }
        throw err
      }
    },

    writeNew: (path, text) => fsp.writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),

    async kind(path: string): Promise<'dir' | 'other' | 'missing'>
    {
      try
      {
        return (await fsp.stat(path)).isDirectory() ? 'dir' : 'other'
      }
      catch (err)
      {
        const code = errorCode(err)
        if (code === 'ENOENT' || code === 'ENOTDIR')
        {
          return 'missing'
        }
        throw err
      }
    },

    list: (dir) => fsp.readdir(dir),

    removeEmpty: (dir) => fsp.rmdir(dir)
  }
}

/** What the registry needs. */
export interface WorkDirRegistryOptions
{
  /** `userData/jobs/workdirs.jsonl`. */
  path: string
  platform: Platform
  /** Reads and rewrites the registry file at startup. */
  io: PersistenceIO
  /** The job store's write queue. */
  writer: RegistryWriter
  fs: Pick<FsOps, 'mkdir' | 'removeTree' | 'setHidden'>
  /** Defaults to `createNodeWorkDirFiles()`. */
  files?: WorkDirFiles
  timers: Timers
  ids: { token(): string }
  log?: Pick<JobLogger, 'info' | 'warn'>
  /** Defaults to `CLEANUP_BUDGET_MS`. */
  cleanupBudgetMs?: number
}

/** How the registry is loaded at startup. */
export interface WorkDirLoadOptions
{
  /** No snapshot was readable, so every registered folder is kept for this session; some may hold verified outputs. */
  emptyStart?: boolean
  /** Jobs that still exist; the rewrite keeps the execution floors of these only. Every floor is kept when absent. */
  knownJob?: (jobId: JobId) => boolean
}

/** The registry as loaded. */
export interface WorkDirLoad
{
  /** Folders registered and not deleted. */
  entries: WorkDirEntry[]
  /** The folders kept for this session after an empty start, for the `queue-recovered` alert. */
  kept: WorkDirEntry[]
  /** The highest execution registered per job, deleted folders included. */
  floors: ReadonlyMap<JobId, number>
  /** Lines that are not registry lines, a torn last line included. */
  skipped: number
  /** Whether the file was rewritten with its live entries. */
  rewritten: boolean
}

/** One execution's work folder to create. */
export interface WorkDirRequest
{
  /** The job's catalog ID, which names the folder. */
  jobId: JobId
  attempt: number
  execution: number
  source: string
  finalPath: string
  /** The execution's token when the caller issued it already, so a claim can protect it; otherwise one is issued. */
  token?: string
}

/** The result of `create`. */
export type WorkDirCreated =
  | { status: 'created'; path: string; entry: WorkDirEntry }
  /** The `create` line is not durable and no folder exists. */
  | { status: 'storage-failed'; path: string; error: unknown }
  /** The line is durable but the folder or its marker could not be made; the sweeper settles what is left. */
  | { status: 'folder-failed'; path: string; error: unknown }

/**
 * What a sweep did with one registered folder: `deleted`; `missing` (already gone, so the entry is dropped);
 * `protected` (active or held); `session` (kept after an empty start); `creating` (its create is in flight);
 * `mismatch` (the marker disagrees or something else is there, never touched); `pending` (deletion failed within the
 * cleanup budget, retried by the next sweep); `unreachable` (the folder or its parent cannot be read now).
 */
export type SweepOutcome = 'deleted' | 'missing' | 'protected' | 'session' | 'creating' | 'mismatch' | 'pending' | 'unreachable'

/** One registered folder in a sweep. */
export interface SweepResult
{
  path: string
  jobId: JobId
  token: string
  outcome: SweepOutcome
  /** The error code behind `pending` or `unreachable`. */
  code: string | null
}

/** A finished sweep. */
export interface SweepReport
{
  results: SweepResult[]
  /** Entries settled: folders deleted and folders found already gone. */
  deleted: number
  pending: number
  /** Folders kept for this session after an empty start. */
  kept: number
}

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function createLine(entry: WorkDirEntry): WorkDirLine
{
  return { op: 'create', ...entry }
}

function entryOf(line: WorkDirEntry): WorkDirEntry
{
  return { path: line.path, jobId: line.jobId, attempt: line.attempt, execution: line.execution, token: line.token, at: line.at }
}

/** The work folders of every execution, known before they exist and deleted only through here. */
export class WorkDirRegistry
{
  private readonly o: WorkDirRegistryOptions
  private readonly files: WorkDirFiles
  private readonly entries = new Map<string, WorkDirEntry>()
  private readonly floors = new Map<JobId, number>()
  private readonly sessionKept = new Set<string>()
  private readonly creating = new Set<string>()
  private readonly pending = new Set<string>()
  private sweeps: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(options: WorkDirRegistryOptions)
  {
    this.o = options
    this.files = options.files ?? createNodeWorkDirFiles()
  }

  private key(path: string): string
  {
    return pathKey(path, this.o.platform)
  }

  /**
   * Reads the registry, rewrites it with its live entries (plus a created and deleted pair for each job whose highest
   * execution was deleted, so the floor survives), and remembers the floors. Call it once, before any `create`.
   */
  async load(options: WorkDirLoadOptions = {}): Promise<WorkDirLoad>
  {
    let text: string | null = null
    let readable = true
    try
    {
      text = await this.o.io.read(this.o.path)
    }
    catch (err)
    {
      readable = false
      this.o.log?.warn(`Could not read the work-folder registry ${this.o.path}: ${messageOf(err)}`)
    }
    const parsed = parseJsonLines(text ?? '')
    let skipped = parsed.skipped + (parsed.torn ? 1 : 0)
    const highest = new Map<JobId, WorkDirEntry>()
    for (const value of parsed.values)
    {
      const line = parseWorkDirLine(value)
      if (line === null)
      {
        skipped += 1
        continue
      }
      const key = this.key(line.path)
      if (line.op === 'deleted')
      {
        this.entries.delete(key)
        continue
      }
      const entry = entryOf(line)
      this.entries.set(key, entry)
      const top = highest.get(entry.jobId)
      if (top === undefined || entry.execution > top.execution)
      {
        highest.set(entry.jobId, entry)
      }
    }

    const values: WorkDirLine[] = []
    for (const [jobId, top] of highest)
    {
      this.floors.set(jobId, top.execution)
      const live = this.entries.get(this.key(top.path))?.token === top.token
      if (!live && (options.knownJob === undefined || options.knownJob(jobId)))
      {
        values.push(createLine(top), { op: 'deleted', path: top.path })
      }
    }
    for (const entry of this.entries.values())
    {
      values.push(createLine(entry))
      if (options.emptyStart)
      {
        this.sessionKept.add(this.key(entry.path))
      }
    }

    let rewritten = false
    if (readable && (text !== null || values.length > 0))
    {
      try
      {
        await rewriteJsonLines(this.o.io, this.o.path, values)
        rewritten = true
      }
      catch (err)
      {
        this.o.log?.warn(`Could not rewrite the work-folder registry ${this.o.path}: ${messageOf(err)}`)
        if (text !== null && text !== '' && !text.endsWith('\n'))
        {
          await this.o.io.append(this.o.path, '\n').catch(() => undefined)
        }
      }
    }
    this.loaded = true
    const entries = [...this.entries.values()]
    return {
      entries,
      kept: entries.filter((entry) => this.sessionKept.has(this.key(entry.path))),
      floors: new Map(this.floors),
      skipped,
      rewritten
    }
  }

  /**
   * Creates the work folder of one execution: the `create` line is appended and fsynced first, then the folder is
   * made, hidden on Windows, and given its marker. A line that cannot be made durable creates no folder, so the
   * caller releases the claim and the job stays queued. Throws when the execution is not above the job's highest.
   */
  async create(request: WorkDirRequest): Promise<WorkDirCreated>
  {
    if (!this.loaded)
    {
      throw new Error('The work-folder registry must be loaded before a folder is created')
    }
    const floor = this.highestExecution(request.jobId)
    if (request.execution <= floor)
    {
      throw new RangeError(`Execution ${request.execution} of ${request.jobId} is not above the registered ${floor}`)
    }
    const { platform } = this.o
    const path = workDirPath(request.finalPath, request.jobId, request.attempt, request.execution, platform)
    const key = this.key(path)
    const entry: WorkDirEntry = {
      path,
      jobId: request.jobId,
      attempt: request.attempt,
      execution: request.execution,
      token: request.token ?? this.o.ids.token(),
      at: this.o.timers.now()
    }
    this.floors.set(request.jobId, request.execution)
    this.creating.add(key)
    try
    {
      try
      {
        await this.o.writer.appendLines(this.o.path, [createLine(entry)], true)
      }
      catch (error)
      {
        this.o.log?.warn(`Could not register the work folder ${path}: ${messageOf(error)}`)
        return { status: 'storage-failed', path, error }
      }
      this.entries.set(key, entry)
      try
      {
        await this.o.fs.mkdir(path)
      }
      catch (error)
      {
        this.o.log?.warn(`Could not create the work folder ${path}: ${messageOf(error)}`)
        return { status: 'folder-failed', path, error }
      }
      if (platform === 'win32')
      {
        await this.o.fs.setHidden(path).catch((err: unknown) => this.o.log?.warn(`Could not hide ${path}: ${messageOf(err)}`))
      }
      const marker: WorkDirMarker = {
        jobId: entry.jobId,
        attempt: entry.attempt,
        execution: entry.execution,
        token: entry.token,
        source: request.source,
        finalPath: request.finalPath,
        createdAt: entry.at
      }
      try
      {
        await this.files.writeNew(markerPath(path, platform), JSON.stringify(marker))
      }
      catch (error)
      {
        this.o.log?.warn(`Could not write the marker of ${path}: ${messageOf(error)}`)
        try
        {
          await this.files.removeEmpty(path)
          await this.forget(entry)
        }
        catch (err)
        {
          this.o.log?.warn(`Could not remove the unmarked work folder ${path}: ${messageOf(err)}`)
        }
        return { status: 'folder-failed', path, error }
      }
      return { status: 'created', path, entry }
    }
    finally
    {
      this.creating.delete(key)
    }
  }

  /**
   * Drops an entry whose folder is gone and writes its `deleted` line before resolving, so no registry write outlives
   * the sweep or create that caused it. The line is not fsynced, since a lost one only repeats a delete.
   */
  private async forget(entry: WorkDirEntry): Promise<void>
  {
    const key = this.key(entry.path)
    if (this.entries.get(key) === entry)
    {
      this.entries.delete(key)
    }
    this.pending.delete(key)
    this.sessionKept.delete(key)
    try
    {
      await this.o.writer.appendLines(this.o.path, [{ op: 'deleted', path: entry.path }])
    }
    catch (err)
    {
      this.o.log?.warn(`Could not record the deletion of ${entry.path}: ${messageOf(err)}`)
    }
  }

  /**
   * Deletes every registered folder whose execution is not protected, that is, neither the current execution of an
   * active job nor the execution of a held job (the caller also protects a claim that already holds its token).
   * `protect` is asked again right before each deletion, and the marker must carry the registered token; a folder
   * that is not registered or whose marker disagrees is never touched. A folder that cannot be deleted within the
   * cleanup budget stays registered and pending for the next sweep. Sweeps run one at a time, so a caller never
   * needs to await one before a command, and a sweep resolves only after its `deleted` lines are written.
   */
  sweep(protect: (entry: WorkDirEntry) => boolean, only?: (entry: WorkDirEntry) => boolean): Promise<SweepReport>
  {
    const run = this.sweeps.then(() => this.runSweep(protect, only))
    this.sweeps = run.then(() => undefined, () => undefined)
    return run
  }

  private async runSweep(protect: (entry: WorkDirEntry) => boolean, only?: (entry: WorkDirEntry) => boolean): Promise<SweepReport>
  {
    const results: SweepResult[] = []
    for (const entry of [...this.entries.values()])
    {
      if (this.entries.get(this.key(entry.path)) !== entry || (only !== undefined && !only(entry)))
      {
        continue
      }
      const { outcome, code } = await this.sweepOne(entry, protect)
      results.push({ path: entry.path, jobId: entry.jobId, token: entry.token, outcome, code })
    }
    const count = (outcome: SweepOutcome): number => results.filter((r) => r.outcome === outcome).length
    return { results, deleted: count('deleted') + count('missing'), pending: count('pending'), kept: count('session') }
  }

  private async sweepOne(entry: WorkDirEntry, protect: (entry: WorkDirEntry) => boolean): Promise<{ outcome: SweepOutcome; code: string | null }>
  {
    const key = this.key(entry.path)
    const settled = (outcome: SweepOutcome, code: string | null = null): { outcome: SweepOutcome; code: string | null } => ({ outcome, code })
    if (this.creating.has(key))
    {
      return settled('creating')
    }
    if (this.sessionKept.has(key))
    {
      return settled('session')
    }
    if (protect(entry))
    {
      return settled('protected')
    }
    let marked: boolean
    try
    {
      const kind = await this.files.kind(entry.path)
      if (kind === 'missing')
      {
        if (await this.files.kind(pathApi(this.o.platform).dirname(entry.path)) !== 'dir')
        {
          return settled('unreachable')
        }
        await this.forget(entry)
        return settled('missing')
      }
      if (kind === 'other')
      {
        return settled('mismatch')
      }
      const text = await this.files.readText(markerPath(entry.path, this.o.platform))
      if (text === null)
      {
        if ((await this.files.list(entry.path)).length > 0)
        {
          return settled('mismatch')
        }
        marked = false
      }
      else
      {
        const marker = parseMarker(text)
        if (marker === null || marker.token !== entry.token || marker.jobId !== entry.jobId)
        {
          return settled('mismatch')
        }
        marked = true
      }
    }
    catch (err)
    {
      return settled('unreachable', errorCode(err))
    }
    if (protect(entry))
    {
      return settled('protected')
    }
    try
    {
      await withLockRetries(
        () => marked ? this.o.fs.removeTree(entry.path) : this.files.removeEmpty(entry.path),
        { timers: this.o.timers, codes: marked ? CLEANUP_CODES : LOCK_CODES, budgetMs: this.o.cleanupBudgetMs ?? CLEANUP_BUDGET_MS }
      )
    }
    catch (err)
    {
      this.pending.add(key)
      this.o.log?.warn(`Could not delete the work folder ${entry.path} yet: ${messageOf(err)}`)
      return settled('pending', errorCode(err))
    }
    await this.forget(entry)
    this.o.log?.info(`Deleted the work folder ${entry.path}`)
    return settled('deleted')
  }

  /** Registered folders the last sweeps could not delete yet, such as one whose output a player still holds open. */
  pendingEntries(): WorkDirEntry[]
  {
    return [...this.pending].flatMap((key) =>
    {
      const entry = this.entries.get(key)
      return entry === undefined ? [] : [entry]
    })
  }

  /** The folders registered and not deleted. */
  list(): WorkDirEntry[]
  {
    return [...this.entries.values()]
  }

  /** The highest execution registered for a job, or 0. */
  highestExecution(jobId: JobId): number
  {
    return this.floors.get(jobId) ?? 0
  }

  /** The next execution of a job: one more than the highest of `recorded` (snapshot and journal) and the registry. */
  nextExecution(jobId: JobId, recorded: number): number
  {
    return Math.max(recorded, this.highestExecution(jobId)) + 1
  }
}
