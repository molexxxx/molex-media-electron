/**
 * The engine's file writes on real folders: lock retries on the injected timers, exclusive reservations with the
 * identity of the file they create, the cross-volume copy with its hash check, the hidden work folder, and the trash
 * wrapper that classifies refusals.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, win32 } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Platform } from '../../shared/text/platform'
import type { TimerHandle, Timers } from '../timers'
import type { FileIdentity, FsOps, JobLogger } from './deps'
import { isWorkDirName } from './naming'
import { binFullReason, volumeLabel } from './volumes'
import type { VolumeRegistry } from './volumes'

/** The first waits between lock retries; after them every wait is `LOCK_STEADY_MS`. */
export const LOCK_SCHEDULE_MS: readonly number[] = [50, 100, 200, 400, 800, 1600]
export const LOCK_STEADY_MS = 2000
/** How long reserve, displace, place, rollback, and the Windows trash keep retrying. */
export const LOCK_BUDGET_MS = 30000
/** After this long waiting on a lock, the job shows the `wait-lock` stage with the path. */
export const WAIT_LOCK_AFTER_MS = 2000
/** How long a work-folder delete retries before it goes to the pending list. */
export const CLEANUP_BUDGET_MS = 5000
/** The wait before the one retry of a trash refused on macOS or Linux. */
export const POSIX_TRASH_RETRY_MS = 1000
/** The chunk size of the cross-volume copy and of hashing. */
export const COPY_CHUNK_BYTES = 1024 * 1024
/** Codes a file another program holds open produces. */
export const LOCK_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])
/** Codes a work-folder delete retries. */
export const CLEANUP_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** The Node error code of a failure, or null. */
export function errorCode(err: unknown): string | null
{
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** The wait before retry number `retry` (0 for the first). */
export function lockDelay(retry: number): number
{
  return LOCK_SCHEDULE_MS[retry] ?? LOCK_STEADY_MS
}

/** How `withLockRetries` waits. */
export interface RetryOptions
{
  timers: Timers
  /** Defaults to `LOCK_BUDGET_MS`. */
  budgetMs?: number
  /** Codes worth another attempt; defaults to `LOCK_CODES`. */
  codes?: ReadonlySet<string>
  /** Overrides `codes` when a failure is classified by more than its code. */
  retryable?: (err: unknown) => boolean
  /** Called once when the wait passes `waitNoticeMs`, so the job can show `wait-lock` with the path. */
  onWaiting?: () => void
  /** Defaults to `WAIT_LOCK_AFTER_MS`. */
  waitNoticeMs?: number
  /** Called before each wait, for the job log. */
  onRetry?: (err: unknown, retry: number, delayMs: number) => void
  /** Stops waiting; the last failure is thrown. */
  signal?: AbortSignal
}

/**
 * Runs `op` until it succeeds, a failure is not worth retrying, or the budget is spent: waits of 50, 100, 200, 400,
 * 800, and 1600 ms, then every 2000 ms, the last wait cut to land on the budget. Throws the last failure.
 */
export async function withLockRetries<T>(op: () => Promise<T>, options: RetryOptions): Promise<T>
{
  const { timers } = options
  const budget = options.budgetMs ?? LOCK_BUDGET_MS
  const codes = options.codes ?? LOCK_CODES
  const retryable = options.retryable ?? ((err: unknown): boolean => codes.has(errorCode(err) ?? ''))
  const start = timers.now()
  let notice: TimerHandle | null = null
  let retry = 0
  try
  {
    for (;;)
    {
      try
      {
        return await op()
      }
      catch (err)
      {
        const remaining = budget - (timers.now() - start)
        if (!retryable(err) || remaining <= 0 || options.signal?.aborted)
        {
          throw err
        }
        const onWaiting = options.onWaiting
        if (notice === null && onWaiting)
        {
          const due = (options.waitNoticeMs ?? WAIT_LOCK_AFTER_MS) - (timers.now() - start)
          notice = timers.setTimeout(() => onWaiting(), Math.max(0, due))
        }
        const delay = Math.min(lockDelay(retry), remaining)
        options.onRetry?.(err, retry, delay)
        retry++
        await timers.sleep(delay, options.signal)
        if (options.signal?.aborted)
        {
          throw err
        }
      }
    }
  }
  finally
  {
    if (notice !== null)
    {
      timers.clearTimeout(notice)
    }
  }
}

/** A finished child process. */
export interface ProcessResult
{
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a program without a shell and without a window. */
export type ProcessRunner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<ProcessResult>

/** The real runner: `execFile` with no shell, `windowsHide`, a timeout, and the exit code resolved rather than thrown. */
export const runProcess: ProcessRunner = (file, args, options) =>
{
  return new Promise((resolve, reject) =>
  {
    execFile(file, [...args], { shell: false, windowsHide: true, timeout: options.timeoutMs, maxBuffer: COPY_CHUNK_BYTES, encoding: 'utf8' }, (err, stdout, stderr) =>
    {
      const code = (err as { code?: unknown } | null)?.code
      if (err && typeof code !== 'number')
      {
        reject(err)
        return
      }
      resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr })
    })
  })
}

/**
 * Milliseconds exactly as a plain `fs.stat` reports them (seconds times 1000 plus nanoseconds over 1e6), from a
 * bigint nanosecond time; the bigint `mtimeMs` truncates to whole milliseconds and would not compare equal.
 */
export function msFromNs(ns: bigint): number
{
  let sec = ns / 1_000_000_000n
  let nsec = ns % 1_000_000_000n
  if (nsec < 0n)
  {
    sec -= 1n
    nsec += 1_000_000_000n
  }
  return Number(sec) * 1000 + Number(nsec) / 1_000_000
}

/** The identity of a file from bigint stats, with the volume and file ids kept exact as decimal strings. */
export function toIdentity(stats: BigIntStats): FileIdentity
{
  return { dev: stats.dev.toString(), ino: stats.ino.toString(), size: Number(stats.size), mtimeMs: msFromNs(stats.mtimeNs) }
}

/** Whether two identities name the same file: the same volume and file id. */
export function sameFile(a: Pick<FileIdentity, 'dev' | 'ino'>, b: Pick<FileIdentity, 'dev' | 'ino'>): boolean
{
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Whether the file at a reserved path is still the untouched reservation: the same exact file id, and the size and
 * modification time recorded at `reserve`, which a write into the reservation changes.
 */
export function sameReservation(reserved: FileIdentity, current: FileIdentity | null): boolean
{
  return current !== null && sameFile(reserved, current) && current.size === reserved.size && current.mtimeMs === reserved.mtimeMs
}

function codedError(message: string, code: string): NodeJS.ErrnoException
{
  return Object.assign(new Error(message), { code })
}

function ignore(): undefined
{
  return undefined
}

/** What `createFsOps` needs besides the file system. */
export interface FsOpsOptions
{
  platform: Platform
  /** Runs attrib.exe on Windows; defaults to `runProcess`. */
  run?: ProcessRunner
  /** `%SystemRoot%`, where attrib.exe lives. */
  systemRoot?: string
  /** Re-reads a finished copy for the size and hash check; defaults to `hashFile`. */
  verify?: (path: string) => Promise<{ hash: string; bytes: number }>
  log?: Pick<JobLogger, 'warn'>
}

/** The SHA-256 and size of a file, read in 1 MiB chunks. */
export async function hashFile(path: string): Promise<{ hash: string; bytes: number }>
{
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: COPY_CHUNK_BYTES }))
  {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).length
  }
  return { hash: hash.digest('hex'), bytes }
}

async function writeAll(handle: fsp.FileHandle, chunk: Buffer): Promise<void>
{
  let offset = 0
  while (offset < chunk.length)
  {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    offset += bytesWritten
  }
}

/**
 * Copies `from` to the new name `to` (never over an existing file) in 1 MiB chunks through `pipeline`, hashing on
 * the way, syncs the copy, then compares size and SHA-256 with a re-read of it. A failed copy removes its own file.
 */
async function copyVerified(from: string, to: string, verify: (path: string) => Promise<{ hash: string; bytes: number }>): Promise<void>
{
  const sourceSize = (await fsp.stat(from)).size
  const target = await fsp.open(to, 'wx')
  const hash = createHash('sha256')
  let bytes = 0
  let open = true
  try
  {
    await pipeline(
      createReadStream(from, { highWaterMark: COPY_CHUNK_BYTES }),
      new Writable({
        highWaterMark: COPY_CHUNK_BYTES,
        write(chunk: Buffer, _encoding, done): void
        {
          hash.update(chunk)
          bytes += chunk.length
          writeAll(target, chunk).then(() => done(), done)
        }
      })
    )
    await target.sync()
    open = false
    await target.close()
    const copy = await verify(to)
    if (copy.bytes !== bytes || bytes !== sourceSize || copy.hash !== hash.digest('hex'))
    {
      throw codedError(`The copy of ${from} does not match the source`, 'EIO')
    }
  }
  catch (err)
  {
    if (open)
    {
      await target.close().catch(ignore)
    }
    await fsp.unlink(to).catch(ignore)
    throw err
  }
}

/** File operations over `node:fs`, one attempt each; callers add `withLockRetries` where the schedule applies. */
export function createFsOps(options: FsOpsOptions): FsOps
{
  const run = options.run ?? runProcess
  let copies: Promise<unknown> = Promise.resolve()

  return {
    rename: (from, to) => fsp.rename(from, to),

    async reserve(path: string): Promise<FileIdentity>
    {
      const handle = await fsp.open(path, 'wx')
      try
      {
        return toIdentity(await handle.stat({ bigint: true }))
      }
      catch (err)
      {
        await handle.close().catch(ignore)
        await fsp.unlink(path).catch(ignore)
        throw err
      }
      finally
      {
        await handle.close().catch(ignore)
      }
    },

    async identity(path: string): Promise<FileIdentity | null>
    {
      try
      {
        return toIdentity(await fsp.lstat(path, { bigint: true }))
      }
      catch (err)
      {
        if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR')
        {
          return null
        }
        throw err
      }
    },

    unlink: (path) => fsp.unlink(path),

    async mkdir(path: string): Promise<void>
    {
      await fsp.mkdir(path)
    },

    async removeTree(path: string): Promise<void>
    {
      if (!isWorkDirName(basename(path.replace(/[\\/]+$/, ''))))
      {
        throw codedError(`Only work folders are removed, not ${path}`, 'EINVAL')
      }
      try
      {
        await fsp.rm(path, { recursive: true, force: false })
      }
      catch (err)
      {
        if (errorCode(err) !== 'ENOENT')
        {
          throw err
        }
      }
    },

    async setHidden(path: string): Promise<void>
    {
      if (options.platform !== 'win32')
      {
        return
      }
      const attrib = win32.join(options.systemRoot || 'C:\\Windows', 'System32', 'attrib.exe')
      try
      {
        const result = await run(attrib, ['+h', win32.resolve(path)], { timeoutMs: 10000 })
        if (result.code !== 0)
        {
          options.log?.warn(`Could not hide ${path}: attrib exited with ${result.code} ${result.stdout.trim()} ${result.stderr.trim()}`.trim())
        }
      }
      catch (err)
      {
        options.log?.warn(`Could not hide ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    copyFile(from: string, to: string): Promise<void>
    {
      const copy = copies.then(() => copyVerified(from, to, options.verify ?? hashFile))
      copies = copy.catch(ignore)
      return copy
    },

    async hash(path: string): Promise<string>
    {
      return (await hashFile(path)).hash
    }
  }
}

/** Why the trash wrapper kept a file instead of moving it to the bin. */
export type TrashKeptReason = 'no-recycle-bin' | 'cannot-recycle' | 'bin-full' | 'refused'

/** What happened to a file sent to the trash. */
export type TrashResult =
  | { status: 'trashed' }
  | { status: 'kept'; reason: TrashKeptReason; message: string }

/** Whether a trash rejection is Windows refusing an item that cannot be recycled ("Operation was aborted"). */
export function isAbortedTrash(err: unknown): boolean
{
  return /operation was aborted/i.test(err instanceof Error ? err.message : String(err))
}

/** What the trash wrapper needs. */
export interface TrashOptions
{
  platform: Platform
  timers: Timers
  /** The host's trash, such as Electron's `shell.trashItem`. */
  trash(path: string): Promise<void>
  volumes: Pick<VolumeRegistry, 'root' | 'refreshTrash' | 'markTrashUnavailable'>
  /** The size of a file for the room check; defaults to a stat, null when it cannot be read. */
  sizeOf?(path: string): Promise<number | null>
  log?: Pick<JobLogger, 'warn'>
}

/** Sends displaced files to the bin under the classification rules; it never deletes a file and never throws. */
export interface TrashWrapper
{
  trash(path: string): Promise<TrashResult>
}

async function statSize(path: string): Promise<number | null>
{
  try
  {
    return (await fsp.stat(path)).size
  }
  catch
  {
    return null
  }
}

/**
 * The trash wrapper. A volume without a bin is never called. On Windows the bin's room is read again first, an
 * "Operation was aborted" rejection keeps the file at once and marks the volume for the session, and other rejections
 * (a sharing violation, an access error) retry on the lock schedule for 30 s. On macOS and Linux a rejection gets one
 * retry after 1 s.
 */
export function createTrash(options: TrashOptions): TrashWrapper
{
  const { platform, timers } = options
  const sizeOf = options.sizeOf ?? statSize
  const binWord = platform === 'win32' ? 'Recycle Bin' : 'Trash'

  async function send(target: string): Promise<void>
  {
    if (platform === 'win32')
    {
      await withLockRetries(() => options.trash(target), { timers, retryable: (err) => !isAbortedTrash(err) })
      return
    }
    try
    {
      await options.trash(target)
    }
    catch
    {
      await timers.sleep(POSIX_TRASH_RETRY_MS)
      await options.trash(target)
    }
  }

  return {
    async trash(path: string): Promise<TrashResult>
    {
      const target = platform === 'win32' ? win32.resolve(path) : path
      const label = volumeLabel(await options.volumes.root(target), platform)
      const bin = await options.volumes.refreshTrash(target)
      if (bin.trash === 'unavailable')
      {
        return { status: 'kept', reason: 'no-recycle-bin', message: `${label} has no ${binWord}, so the file stays where it is.` }
      }
      if (platform === 'win32' && bin.trashBytesFree !== null)
      {
        const size = await sizeOf(target)
        if (size !== null && size > bin.trashBytesFree)
        {
          return { status: 'kept', reason: 'bin-full', message: binFullReason(label) }
        }
      }
      try
      {
        await send(target)
        return { status: 'trashed' }
      }
      catch (err)
      {
        const detail = err instanceof Error ? err.message : String(err)
        if (platform === 'win32' && isAbortedTrash(err))
        {
          await options.volumes.markTrashUnavailable(target)
          options.log?.warn(`The Recycle Bin refused ${target}; files displaced on ${label} stay beside their outputs for the rest of the session`)
          return { status: 'kept', reason: 'cannot-recycle', message: `Files on ${label} cannot go to the Recycle Bin, so the file stays where it is.` }
        }
        options.log?.warn(`Could not move ${target} to the ${binWord}: ${detail}`)
        return { status: 'kept', reason: 'refused', message: `The file could not be moved to the ${binWord}: ${detail}` }
      }
    }
  }
}
