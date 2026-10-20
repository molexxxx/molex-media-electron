/**
 * The planner's reads on real folders: file and volume stats, the write probe, volume kinds and bins through the
 * session's volume registry, and reachability. Local reads share a bounded number of slots; reads on a network share
 * run one at a time per share root, so a share that stops answering holds one request instead of the planner.
 */

import { randomBytes } from 'node:crypto'
import type { BigIntStats, StatsFs } from 'node:fs'
import * as fsp from 'node:fs/promises'
import type { Platform } from '../../shared/text/platform'
import type { Timers } from '../timers'
import type { FileStat, JobLogger, PlannerIO, VolumeInfo, VolumeSpace } from './deps'
import { CLEANUP_BUDGET_MS, errorCode, msFromNs, runProcess, withLockRetries } from './fsops'
import type { ProcessRunner } from './fsops'
import { pathApi } from './naming'
import { createReachability, powershellArgs, powershellPath, WINDOWS_VOLUME_SCRIPT } from './volumes'
import type { VolumeQueries, VolumeRegistry } from './volumes'

/** How many local reads run at once, so a large plan leaves libuv threads to the journal and the encoders' pipes. */
export const PLANNER_IO_CONCURRENCY = 3
/** How long the drive query or the mount listing may run. */
export const VOLUME_QUERY_TIMEOUT_MS = 15000
/** The name prefix of the empty file `probeWrite` creates and deletes. */
export const PROBE_FILE_PREFIX = '.molex-probe-'
/** The mount table Linux keeps for the calling process. */
export const LINUX_MOUNTS_PATH = '/proc/self/mounts'
/** The macOS mount listing. */
export const MAC_MOUNT_PATH = '/sbin/mount'

const PROBE_NAME_ATTEMPTS = 3
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(err: unknown): boolean
{
  return MISSING_CODES.has(errorCode(err) ?? '')
}

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function ignore(): undefined
{
  return undefined
}

/** Runs tasks with at most `max` running at once, in the order they arrive. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T>
{
  const slots = Math.max(1, Math.floor(max))
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> =>
  {
    if (active < slots)
    {
      active++
    }
    else
    {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try
    {
      return await task()
    }
    finally
    {
      const next = waiting.shift()
      if (next)
      {
        next()
      }
      else
      {
        active--
      }
    }
  }
}

/** Runs tasks one at a time per key; a failure does not stop the tasks queued behind it. */
export function createLanes(): <T>(key: string, task: () => Promise<T>) => Promise<T>
{
  const tails = new Map<string, Promise<void>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> =>
  {
    const run = (tails.get(key) ?? Promise.resolve()).then(task)
    const tail = run.then(ignore, ignore)
    tails.set(key, tail)
    void tail.then(() =>
    {
      if (tails.get(key) === tail)
      {
        tails.delete(key)
      }
    })
    return run
  }
}

/** The file system calls planner IO makes; the real ones are `node:fs/promises`. */
export interface PlannerFs
{
  stat(path: string): Promise<BigIntStats>
  lstat(path: string): Promise<BigIntStats>
  statfs(path: string): Promise<StatsFs>
  /** Creates an empty file only if nothing is at the path, then closes it. */
  create(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** Planner IO's calls over `node:fs/promises`. */
export const nodePlannerFs: PlannerFs = {
  stat: (path) => fsp.stat(path, { bigint: true }),
  lstat: (path) => fsp.lstat(path, { bigint: true }),
  statfs: (path) => fsp.statfs(path),
  async create(path: string): Promise<void>
  {
    const handle = await fsp.open(path, 'wx')
    await handle.close()
  },
  unlink: (path) => fsp.unlink(path)
}

/**
 * A stat as the planner reads it: size and modification time equal those of a plain `fs.stat`, so source identities
 * compare across modules, and the volume and file ids stay exact.
 */
export function toFileStat(stats: BigIntStats): FileStat
{
  return {
    size: Number(stats.size),
    mtimeMs: msFromNs(stats.mtimeNs),
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    dev: stats.dev.toString(),
    ino: stats.ino.toString()
  }
}

/** What `createPlannerIO` needs. */
export interface PlannerIOOptions
{
  platform: Platform
  timers: Timers
  /** The session's registry, shared with the trash wrapper so a volume marked without a bin stays that way for both. */
  volumes: VolumeRegistry
  /** Defaults to `nodePlannerFs`. */
  fs?: PlannerFs
  /** How many local reads run at once; defaults to `PLANNER_IO_CONCURRENCY`. */
  concurrency?: number
  /** Names the probe file; defaults to 64 random bits in hex. */
  token?: () => string
  log?: Pick<JobLogger, 'warn'>
}

/**
 * `PlannerIO` over the file system. `stat` reads a link itself only when its target is missing, so a dangling link
 * still takes its name; `statfs` of a folder that does not exist yet reads the nearest folder that does; `probeWrite`
 * creates an empty file with `wx` and deletes it on the cleanup schedule. Reachability is never queued behind local
 * reads, and on a network share it waits its turn in the share's lane, so a hung share answers `false` in time.
 */
export function createPlannerIO(options: PlannerIOOptions): PlannerIO
{
  const { timers, volumes } = options
  const fs = options.fs ?? nodePlannerFs
  const paths = pathApi(options.platform)
  const token = options.token ?? ((): string => randomBytes(8).toString('hex'))
  const limit = createLimiter(options.concurrency ?? PLANNER_IO_CONCURRENCY)
  const lanes = createLanes()

  async function schedule<T>(path: string, task: () => Promise<T>, bounded: boolean): Promise<T>
  {
    if (await volumes.isNetwork(path))
    {
      return lanes(await volumes.key(path), task)
    }
    return bounded ? limit(task) : task()
  }

  const reach = createReachability({ stat: (path) => schedule(path, () => fs.stat(path), false), timers })

  async function readStat(path: string): Promise<FileStat | null>
  {
    let link: BigIntStats
    try
    {
      link = await fs.lstat(path)
    }
    catch (err)
    {
      if (isMissing(err))
      {
        return null
      }
      throw err
    }
    if (!link.isSymbolicLink())
    {
      return toFileStat(link)
    }
    try
    {
      return toFileStat(await fs.stat(path))
    }
    catch (err)
    {
      if (isMissing(err))
      {
        return toFileStat(link)
      }
      throw err
    }
  }

  async function readSpace(path: string): Promise<VolumeSpace>
  {
    let target = path
    for (;;)
    {
      try
      {
        const space = await fs.statfs(target)
        return { freeBytes: space.bavail * space.bsize, totalBytes: space.blocks * space.bsize }
      }
      catch (err)
      {
        const parent = paths.dirname(target)
        if (!isMissing(err) || parent === target)
        {
          throw err
        }
        target = parent
      }
    }
  }

  async function removeProbe(probe: string): Promise<void>
  {
    try
    {
      await withLockRetries(() => fs.unlink(probe), { timers, budgetMs: CLEANUP_BUDGET_MS })
    }
    catch (err)
    {
      if (!isMissing(err))
      {
        options.log?.warn(`Could not remove the write check ${probe}: ${messageOf(err)}`)
      }
    }
  }

  async function writeProbe(dir: string): Promise<boolean>
  {
    for (let attempt = 0; attempt < PROBE_NAME_ATTEMPTS; attempt++)
    {
      const probe = paths.join(dir, `${PROBE_FILE_PREFIX}${token()}.tmp`)
      try
      {
        await fs.create(probe)
      }
      catch (err)
      {
        if (errorCode(err) === 'EEXIST')
        {
          continue
        }
        return false
      }
      await removeProbe(probe)
      return true
    }
    return false
  }

  return {
    stat: (path) => schedule(path, () => readStat(path), true),
    statfs: (path) => schedule(path, () => readSpace(path), true),
    probeWrite: (dir) => schedule(dir, () => writeProbe(dir), true),
    volumeInfo: (path): Promise<VolumeInfo> => volumes.info(path),
    reachable: (root, timeoutMs) => reach.reachable(root, timeoutMs)
  }
}

/** What the real volume queries need. */
export interface VolumeQueryOptions
{
  platform: Platform
  /** Spawns PowerShell or `mount` without a shell; defaults to `runProcess`. */
  run?: ProcessRunner
  /** `%SystemRoot%`, where Windows PowerShell lives. */
  systemRoot?: string
  /** Reads the Linux mount table; defaults to a UTF-8 `readFile`. */
  readText?: (path: string) => Promise<string>
  /** Defaults to `VOLUME_QUERY_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** The queries behind a volume registry: the one-shot PowerShell drive query on Windows, the mount table elsewhere. */
export function createVolumeQueries(options: VolumeQueryOptions): VolumeQueries
{
  const run = options.run ?? runProcess
  const readText = options.readText ?? ((path: string): Promise<string> => fsp.readFile(path, 'utf8'))
  const timeoutMs = options.timeoutMs ?? VOLUME_QUERY_TIMEOUT_MS

  return {
    async windows(): Promise<string>
    {
      const result = await run(powershellPath(options.systemRoot), powershellArgs(WINDOWS_VOLUME_SCRIPT), { timeoutMs })
      if (result.code !== 0)
      {
        const detail = result.stderr.trim()
        throw new Error(`PowerShell exited with ${result.code}${detail ? `: ${detail}` : ''}`)
      }
      return result.stdout
    },

    async mounts(): Promise<string | null>
    {
      try
      {
        if (options.platform === 'linux')
        {
          return await readText(LINUX_MOUNTS_PATH)
        }
        if (options.platform === 'darwin')
        {
          const result = await run(MAC_MOUNT_PATH, [], { timeoutMs })
          return result.code === 0 ? result.stdout : null
        }
        return null
      }
      catch
      {
        return null
      }
    }
  }
}
