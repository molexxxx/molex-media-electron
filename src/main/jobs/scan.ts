/**
 * Asynchronous folder scans for `jobs:add`. A scan walks one folder in chunks, yielding between them, and hands the
 * media files it admits to the engine as it finds them. It never follows links, counts what it skips, and stops on
 * cancel, on the queue limit's last free place, or with `failed` when the scanned folder goes away.
 */

import { randomUUID } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isMediaPath } from '../../shared/jobs/extensions'
import type { ScanState } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'

/** The most jobs the queue holds; a scan admits files only while the queue has room. */
export const QUEUE_LIMIT = 10_000

/** Directory entries a scan reads before it delivers what it found and yields the turn. */
export const SCAN_CHUNK = 256

/** Work folders and partial outputs the engine creates beside a user's files. */
const WORK_NAME = /^\.molex-.*\.partial$/i

const ACCESS_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM'])

/** One directory entry, as `fs.Dirent` reports it. */
export interface ScanDirent
{
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** What a scan reads of a path. */
export interface ScanStats
{
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

/** The file system a scan reads; `realScanFs` in the app, a wrapper that injects errors in tests. */
export interface ScanFs
{
  opendir(path: string): Promise<AsyncIterable<ScanDirent>>
  stat(path: string): Promise<ScanStats>
}

/** The node:fs/promises scan file system. */
export const realScanFs: ScanFs =
{
  opendir: (path) => opendir(path, { bufferSize: 64 }),
  stat: (path) => stat(path)
}

/** A media file a scan admitted. */
export interface ScannedFile
{
  path: string
  size: number
  mtimeMs: number
  /** The folder below the scanned root, '' for a file directly in it. */
  subdir: string
}

/** What a scan asks the engine while it walks. */
export interface ScanDeps
{
  platform: Platform
  fs?: ScanFs
  id?: () => string
  /** Free places in the queue right now. */
  capacity(): number
  /** True when a pending or queued job already has this path, whatever its recipe. */
  isWaiting(path: string): boolean
  /** True when the file matches a recorded or held output by path, size, and modification time. */
  isPreviousOutput(file: { path: string; size: number; mtimeMs: number }): boolean
  /** Adds one chunk of admitted files as jobs, in the same turn as their classification. */
  onFiles(files: ScannedFile[], scan: ScanState): void | Promise<void>
  onProgress(scan: ScanState): void
  /** Comparison key of a path; defaults to case-folded on win32 and darwin. */
  pathKey?: (path: string) => string
  /** Yields the turn between chunks; defaults to `setImmediate`. */
  yieldTurn?: () => Promise<void>
  chunkSize?: number
}

/** The options of one scan. */
export interface ScanOptions
{
  recursive: boolean
  /** The current destination folder; skipped when it lies inside the scanned tree. */
  outputFolder: string | null
  allowSecondJobs: boolean
  force: boolean
  signal?: AbortSignal
}

/** A running or finished scan. */
export interface ScanHandle
{
  scanId: string
  state(): ScanState
  cancel(): void
  /** Resolves with the final state; never rejects. */
  done: Promise<ScanState>
}

/** The scans of one engine, by id. */
export interface Scanner
{
  start(root: string, options: ScanOptions): ScanHandle
  /** Cancels a running scan; false when no such scan is running. */
  cancel(scanId: string): boolean
  get(scanId: string): ScanState | null
  /** Running scans, oldest first. */
  running(): ScanState[]
}

/** A new scan state for `root`. */
export function emptyScanState(scanId: string, root: string): ScanState
{
  return {
    scanId,
    root,
    status: 'scanning',
    error: null,
    visited: 0,
    added: 0,
    excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 }
  }
}

/** A copy safe to hand to listeners, which may keep it. */
export function copyScanState(state: ScanState): ScanState
{
  return { ...state, excluded: { ...state.excluded } }
}

/** True for the engine's work folders and partial outputs, `.molex-*.partial`. */
export function isWorkName(name: string): boolean
{
  return WORK_NAME.test(name)
}

/** The default comparison key of a path: resolved (which drops a trailing separator), case-folded on win32 and darwin. */
export function defaultPathKey(platform: Platform): (path: string) => string
{
  const api = platform === 'win32' ? win32 : posix
  return (path) =>
  {
    const resolved = api.resolve(path)
    return platform === 'linux' ? resolved : resolved.normalize('NFC').toLowerCase()
  }
}

function errorCode(err: unknown): string
{
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function defaultYield(): Promise<void>
{
  return new Promise((resolve) => setImmediate(resolve))
}

interface Walk
{
  root: string
  state: ScanState
  options: ScanOptions
  deps: ScanDeps
  fs: ScanFs
  api: typeof win32
  key: (path: string) => string
  outputKey: string | null
  signal: AbortSignal
  chunk: number
  yieldTurn: () => Promise<void>
  candidates: string[]
  entries: number
}

function stopped(walk: Walk): boolean
{
  return walk.signal.aborted || walk.state.status !== 'scanning'
}

function fail(walk: Walk, error: string): void
{
  if (walk.state.status === 'scanning')
  {
    walk.state.status = 'failed'
    walk.state.error = error
  }
}

function rootError(root: string, err: unknown): string
{
  return ACCESS_CODES.has(errorCode(err)) ? `${root} could not be read (access denied).` : `${root} is not available.`
}

async function rootAvailable(walk: Walk): Promise<boolean>
{
  try
  {
    return (await walk.fs.stat(walk.root)).isDirectory()
  }
  catch
  {
    return false
  }
}

/** Counts a folder that could not be read, or fails the scan when the scanned folder itself went away. */
async function unreadable(walk: Walk, err: unknown): Promise<void>
{
  if (!ACCESS_CODES.has(errorCode(err)) && !(await rootAvailable(walk)))
  {
    fail(walk, `${walk.root} is no longer available.`)
    return
  }
  walk.state.excluded.unreadable++
}

function subdirOf(walk: Walk, path: string): string
{
  const rel = walk.api.relative(walk.root, walk.api.dirname(path))
  return rel === '.' ? '' : rel
}

/** Admits one chunk of media paths: duplicates by path, previous outputs by identity, then the queue's free places. */
async function admit(walk: Walk, paths: string[]): Promise<void>
{
  const { deps, options, state } = walk
  if (deps.capacity() <= 0)
  {
    for (const path of paths)
    {
      if (!options.allowSecondJobs && deps.isWaiting(path)) state.excluded.duplicates++
      else state.excluded.overLimit++
    }
    return
  }
  const stats = await Promise.all(paths.map((path) => walk.fs.stat(path).catch(() => null)))
  if (stopped(walk)) return
  const files: ScannedFile[] = []
  let room = deps.capacity()
  for (let i = 0; i < paths.length; i++)
  {
    const path = paths[i]
    const info = stats[i]
    if (info === null || !info.isFile()) continue
    if (!options.allowSecondJobs && deps.isWaiting(path))
    {
      state.excluded.duplicates++
      continue
    }
    if (!options.force && deps.isPreviousOutput({ path, size: info.size, mtimeMs: info.mtimeMs }))
    {
      state.excluded.previousOutputs++
      continue
    }
    if (room <= 0)
    {
      state.excluded.overLimit++
      continue
    }
    room--
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs, subdir: subdirOf(walk, path) })
  }
  if (files.length === 0) return
  state.added += files.length
  await deps.onFiles(files, copyScanState(state))
}

/** Delivers what the walk found since the last chunk, reports progress, and yields the turn. */
async function flush(walk: Walk): Promise<void>
{
  walk.entries = 0
  const paths = walk.candidates.splice(0)
  if (paths.length > 0) await admit(walk, paths)
  if (stopped(walk)) return
  walk.deps.onProgress(copyScanState(walk.state))
  await walk.yieldTurn()
}

function visit(walk: Walk, dir: string, entry: ScanDirent, subdirs: string[]): void
{
  const { state } = walk
  if (entry.isSymbolicLink())
  {
    state.excluded.links++
    return
  }
  if (isWorkName(entry.name))
  {
    state.excluded.workFiles++
    return
  }
  const path = walk.api.join(dir, entry.name)
  if (entry.isDirectory())
  {
    if (walk.outputKey !== null && walk.key(path) === walk.outputKey) state.excluded.outputFolder++
    else if (walk.options.recursive) subdirs.push(path)
    return
  }
  if (!entry.isFile()) return
  state.visited++
  if (isMediaPath(path)) walk.candidates.push(path)
  else state.excluded.unsupported++
}

/** Reads one folder in chunks and pushes its subfolders, in listed order, for the walk to visit next. */
async function readDir(walk: Walk, dir: string, stack: string[]): Promise<void>
{
  let handle: AsyncIterable<ScanDirent>
  try
  {
    handle = await walk.fs.opendir(dir)
  }
  catch (err)
  {
    if (dir === walk.root) fail(walk, rootError(walk.root, err))
    else await unreadable(walk, err)
    return
  }
  const subdirs: string[] = []
  try
  {
    for await (const entry of handle)
    {
      if (stopped(walk)) return
      visit(walk, dir, entry, subdirs)
      walk.entries++
      if (walk.entries >= walk.chunk) await flush(walk)
    }
  }
  catch (err)
  {
    if (dir === walk.root) fail(walk, `${walk.root} is no longer available.`)
    else await unreadable(walk, err)
    return
  }
  for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i])
}

async function walkTree(walk: Walk): Promise<void>
{
  let rootStats: ScanStats
  try
  {
    rootStats = await walk.fs.stat(walk.root)
  }
  catch (err)
  {
    fail(walk, rootError(walk.root, err))
    return
  }
  if (!rootStats.isDirectory())
  {
    fail(walk, `${walk.root} is not a folder.`)
    return
  }
  const stack = [walk.root]
  while (stack.length > 0 && !stopped(walk))
  {
    await readDir(walk, stack.pop() as string, stack)
  }
  if (!stopped(walk)) await flush(walk)
}

/** Sets the final status and reports it once; a listener that throws cannot change the outcome. */
function settle(walk: Walk): ScanState
{
  if (walk.state.status === 'scanning') walk.state.status = walk.signal.aborted ? 'canceled' : 'done'
  const final = copyScanState(walk.state)
  try
  {
    walk.deps.onProgress(final)
  }
  catch
  {
    return final
  }
  return final
}

/**
 * Starts one scan of `root`. Files are delivered through `deps.onFiles` in chunks as they are found and progress
 * through `deps.onProgress`, whose last call carries the final status; `done` never rejects.
 */
export function startScan(root: string, options: ScanOptions, deps: ScanDeps): ScanHandle
{
  const scanId = (deps.id ?? randomUUID)()
  const api = deps.platform === 'win32' ? win32 : posix
  const key = deps.pathKey ?? defaultPathKey(deps.platform)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const rootKey = key(root)
  const outputKey = options.outputFolder === null ? null : key(options.outputFolder)
  const walk: Walk = {
    root,
    state: emptyScanState(scanId, root),
    options,
    deps,
    fs: deps.fs ?? realScanFs,
    api,
    key,
    outputKey: outputKey === rootKey ? null : outputKey,
    signal: controller.signal,
    chunk: Math.max(1, deps.chunkSize ?? SCAN_CHUNK),
    yieldTurn: deps.yieldTurn ?? defaultYield,
    candidates: [],
    entries: 0
  }
  const done = walkTree(walk)
    .catch((err: unknown) => fail(walk, errorText(err)))
    .then(() =>
    {
      options.signal?.removeEventListener('abort', onAbort)
      return settle(walk)
    })
  return { scanId, state: () => copyScanState(walk.state), cancel: () => controller.abort(), done }
}

/** The scans of one engine: started by `jobs:add`, canceled by `jobs:cancelScan`, listed in the snapshot. */
export function createScanner(deps: ScanDeps, keepFinished = 32): Scanner
{
  const active = new Map<string, ScanHandle>()
  const finished = new Map<string, ScanState>()
  return {
    start(root, options)
    {
      const handle = startScan(root, options, deps)
      active.set(handle.scanId, handle)
      void handle.done.then((final) =>
      {
        active.delete(handle.scanId)
        finished.set(handle.scanId, final)
        if (finished.size > keepFinished) finished.delete(finished.keys().next().value as string)
      })
      return handle
    },
    cancel(scanId)
    {
      const handle = active.get(scanId)
      if (handle === undefined || handle.state().status !== 'scanning') return false
      handle.cancel()
      return true
    },
    get(scanId)
    {
      const handle = active.get(scanId)
      if (handle !== undefined) return handle.state()
      const final = finished.get(scanId)
      return final === undefined ? null : copyScanState(final)
    },
    running()
    {
      return [...active.values()].map((handle) => handle.state())
    }
  }
}
