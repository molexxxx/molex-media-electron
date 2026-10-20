/**
 * The job engine's seams. One engine instance takes every dependency through `JobEngineDeps`, so it runs in the
 * node test project with no module globals and no real time. Nothing under `src/main/jobs/` imports electron; the
 * Electron side arrives as a `JobsHost` and as `EventSender` adapters over webContents.
 */

import type { MediaFacts } from '../../shared/audio/types'
import type { JobCommandName, JobEventBatch } from '../../shared/jobs/contract'
import type { JobId, RunId } from '../../shared/jobs/ids'
import type { Recipe } from '../../shared/jobs/recipes'
import type { JobMeasurement, RunSettings, TrashAvailability, VolumeKind } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { BuildCapabilities } from '../ffmpeg/audio/encoders'
import type { Exec, ExecOptions } from '../ffmpeg/exec'
import type { TimerHandle, Timers } from '../timers'
import type { JobRunner } from './runners/types'
import type { RendererLocation } from './trust'

export type { TimerHandle, Timers }

/** Everything the engine needs from outside, injected once. */
export interface JobEngineDeps
{
  timers: Timers
  ids: { token(): string; preflightId(): string }
  platform: Platform
  paths: { userData: string }
  runners: { [K in Recipe['kind']]: JobRunner<Extract<Recipe, { kind: K }>> }
  planner: PlannerIO
  probe: ProbeQueue
  fs: FsOps
  trash(path: string): Promise<void>
  store: PersistenceIO
  host: JobsHost
  log: JobLogger
  ffmpeg: FfmpegTools
  /** Sets a child process's scheduling priority; it may throw, so callers go through `withSpawnHook`. */
  setPriority(pid: number, priority: RunSettings['priority']): void
}

/** The FFmpeg build the engine runs. */
export interface FfmpegTools
{
  /** The exec, the build's capabilities, and their revision; null while no binary is available. */
  current(): { exec: Exec; caps: BuildCapabilities; rev: number } | null
}

/** A logger with levels and child context; job loggers also keep each attempt's log. */
export interface JobLogger
{
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** One line a child process wrote to stderr. */
  ffmpeg(line: string): void
  child(context: { jobId?: JobId; runId?: RunId; attempt?: number }): JobLogger
}

/** A file's metadata as the planner reads it. */
export interface FileStat
{
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
  /** The volume and file ids as exact decimal strings: NTFS file ids exceed 2^53, where a number rounds. */
  dev: string
  ino: string
}

/** Free and total bytes of the volume that holds a path. */
export interface VolumeSpace
{
  freeBytes: number
  totalBytes: number
}

/** A volume's kind and Recycle Bin, cached per volume for the session. */
export interface VolumeInfo
{
  kind: VolumeKind
  trash: TrashAvailability
  /** The room left in the volume's bin; null outside Windows and when unreadable. */
  trashBytesFree: number | null
  volumeBytes: number | null
}

/** The planner's file system reads, with bounded concurrency and one request at a time per network share root. */
export interface PlannerIO
{
  /** Null when nothing is at the path. */
  stat(path: string): Promise<FileStat | null>
  statfs(path: string): Promise<VolumeSpace>
  /** Creates and deletes a probe file in `dir`, because an access check misses folder permissions on Windows. */
  probeWrite(dir: string): Promise<boolean>
  volumeInfo(path: string): Promise<VolumeInfo>
  /** Whether a volume root answers within `timeoutMs`. */
  reachable(root: string, timeoutMs: number): Promise<boolean>
}

/** What identifies a reserved or placed file, so a later step can tell it still holds the same file. */
export interface FileIdentity
{
  /** Exact decimal strings from bigint stats, as in FileStat. */
  dev: string
  ino: string
  size: number
  mtimeMs: number
}

/** The engine's file writes; errors carry the Node error code (`EBUSY`, `EPERM`, `ENOSPC`, `EXDEV`, `EEXIST`). */
export interface FsOps
{
  rename(from: string, to: string): Promise<void>
  /** Creates an empty file only if nothing is at the path, and returns its identity. */
  reserve(path: string): Promise<FileIdentity>
  /** Null when nothing is at the path. */
  identity(path: string): Promise<FileIdentity | null>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** Removes a work folder and everything in it. */
  removeTree(path: string): Promise<void>
  /** Marks a work folder hidden; a no-op outside Windows. */
  setHidden(path: string): Promise<void>
  /** The cross-volume fallback: copies, then hashes both sides. */
  copyFile(from: string, to: string): Promise<void>
  hash(path: string): Promise<string>
}

/** The persistence layer's file access under `<userData>/jobs/`. */
export interface PersistenceIO
{
  append(path: string, text: string): Promise<void>
  /** The session-end append, which must finish before the process may end. */
  appendSync(path: string, text: string): void
  fsync(path: string): Promise<void>
  /** Writes a temporary file, syncs it, and renames it over `path`. */
  writeAtomic(path: string, text: string): Promise<void>
  /** Null when the file does not exist. */
  read(path: string): Promise<string | null>
  list(dir: string): Promise<string[]>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

/** Bounded, cached, de-duplicated probing. */
export interface ProbeQueue
{
  /** Rejects when the source cannot be probed; cached by path, size, and modification time. */
  probe(path: string, options?: { signal?: AbortSignal }): Promise<MediaFacts>
  /** Lowers concurrency while a run is active. */
  setRunning(running: boolean): void
  invalidate(path: string): void
}

/** A GPU encoder session held for one job. */
export interface GpuLease
{
  /** The hardware encoder, such as h264_nvenc. */
  readonly encoder: string
  /** Classifies a failed run's stderr as a session limit or an initialization failure. */
  classify(stderrTail: string): 'session-limit' | 'init-failed' | null
}

/** One member's view of its album group. */
export interface AlbumHandle
{
  readonly groupId: string
  readonly members: number
  /** Waits for the group's measurement; null when the group failed or the signal aborted. */
  measurement(signal: AbortSignal): Promise<JobMeasurement | null>
}

/** Measurements kept across analysis and runs, keyed by source identity and measurement settings. */
export interface MeasurementCache
{
  get(key: string): JobMeasurement | null
  set(key: string, measurement: JobMeasurement): void
}

/** A renderer the event bus sends to, adapted from a webContents. */
export interface EventSender
{
  readonly id: number
  send(channel: string, batch: JobEventBatch): void
  isDestroyed(): boolean
  /** Reports every committed navigation of the sender's frames, in-page ones included; returns a function that stops reporting. */
  onNavigate(listener: (navigation: { isMainFrame: boolean; isSameDocument: boolean }) => void): () => void
  /** Returns a function that removes the listener. */
  onDestroyed(listener: () => void): () => void
}

/** An OS notification; a click shows the batch view with the job or run in focus. */
export interface HostNotification
{
  title: string
  body: string
  focus: { jobId: JobId | null; runId: RunId | null }
}

/** The tray's tooltip and menu state. */
export interface TrayStatus
{
  tooltip: string
  /** The disabled status line; null when no run is active. */
  statusLine: string | null
  runControl: 'pause' | 'resume' | null
  canCancel: boolean
}

/** The quit dialog's choices. */
export type QuitChoice = 'keep-running' | 'quit-when-idle' | 'quit-now'

/** The Electron side of the engine; the real one lives in the IPC layer and tests pass a recording fake. */
export interface JobsHost
{
  rendererLocation(): RendererLocation
  logUnexpected(name: JobCommandName, err: unknown): void
  /** The registered renderer with this webContents id, or null when it is gone. */
  sender(senderId: number): EventSender | null
  mainWindow(): { visible: boolean; focused: boolean } | null
  showMainWindow(): void
  notify(notification: HostNotification): void
  /** Null removes the taskbar progress. */
  setTaskbarProgress(progress: { fraction: number; mode: 'normal' | 'paused' | 'error' } | null): void
  setKeepAwake(on: boolean): void
  setTrayStatus(status: TrayStatus): void
  /** Resolves `keep-running` when the signal aborts. */
  askQuit(prompt: { message: string; detail: string }, signal?: AbortSignal): Promise<QuitChoice>
  confirmCancelBatch(prompt: { message: string; detail: string }): Promise<boolean>
  quit(): void
}

/**
 * An exec whose every run also calls `hook` with the child's pid. The hook's errors are logged and swallowed, so a
 * priority call on a process that already exited never fails the job; the caller's own `onSpawn` still runs.
 */
export function withSpawnHook(exec: Exec, hook: (pid: number) => void, log: Pick<JobLogger, 'warn'>): Exec
{
  return {
    run(args: readonly string[], o: ExecOptions)
    {
      const onSpawn = (pid: number): void =>
      {
        try
        {
          hook(pid)
        }
        catch (err)
        {
          log.warn(`Could not adjust process ${pid}: ${err instanceof Error ? err.message : String(err)}`)
        }
        o.onSpawn?.(pid)
      }
      return exec.run(args, { ...o, onSpawn })
    }
  }
}
