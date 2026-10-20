/**
 * Startup recovery of the job engine. Runs once the store is loaded and before any command is served: settles the
 * jobs a crash, quit, or session end left mid-flight, rolls finalizing jobs forward or back by their placement
 * journal, checks held outputs, removes journaled reservations that still carry their identity, and starts the
 * work-folder sweep. Every step checks the disk first and records its result before the next, so a crash during
 * recovery reruns safely. Paths on volumes that do not answer are never judged missing, and nothing outside work
 * folders is touched except the engine's own reservations and the files its placement journal moved.
 */

import type { JobId } from '../../shared/jobs/ids'
import type { Job, JobError, JobHold, JobState, Placement, RunAlert, TrashOutcome } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { Timers } from '../timers'
import type { EngineCore, TransitionResult } from './core'
import type { JobChange } from './queue'
import type { FileIdentity, FsOps, JobLogger } from './deps'
import type { KeptWarning, PlacementEntry, PlacementJournal, PlacementStep } from './finalize'
import { KEPT_BY_POLICY, renameBase } from './finalize'
import type { TrashResult, TrashWrapper } from './fsops'
import { errorCode, sameReservation } from './fsops'
import { pathApi, pathKey, samePath } from './naming'
import type { JournalEntry, SessionInfo } from './persistence'
import type { SweepReport, WorkDirEntry, WorkDirRegistry } from './workdirs'
import type { VolumeRegistry } from './volumes'
import type { Reachability } from './volumes'
import { checkRoots, createReachability, REACHABLE_TIMEOUT_MS, volumeLabel } from './volumes'

/** Why jobs that were running when the last session ended are interrupted. */
export type InterruptReason = 'crash' | 'quit' | 'session-end'

/** A placement journal line as replayed: the step with the job and execution it belongs to. */
export type PlacementLine = PlacementEntry

/** One placement of one execution: its `begin` line and every line after it, in journal order. */
export interface PlacementSegment
{
  jobId: JobId
  execution: number
  begin: Extract<PlacementStep, { step: 'begin' }>
  steps: PlacementStep[]
}

/** A placement recovery completed, for the engine to turn into the result T32 records. */
export interface RecoveredPlacement
{
  finalPath: string
  placement: Placement
  warnings: KeptWarning[]
  /** The file a new-extension replacement displaced at its new name, when there was one. */
  previous: TrashOutcome | null
  /** Whether recovery found the placement complete or finished it itself. */
  completedBy: 'journal' | 'recovery'
}

/** What recovery decided for one finalizing job from its last placement step. */
export type PlacementVerdict =
  | { action: 'done'; placed: RecoveredPlacement }
  | { action: 'hold'; reason: 'interrupted-finalize' | 'file-locked'; message: string; outputPath: string; keepRenamed: boolean }

/** What recovery needs from the engine and the host. */
export interface RecoveryDeps
{
  core: Pick<EngineCore, 'queue' | 'transition' | 'update' | 'interruptActive' | 'run' | 'pauseRun' | 'setNeedsAck' | 'settle' | 'raiseAlert' | 'clearAlert' | 'globals' | 'now'>
  platform: Platform
  fs: Pick<FsOps, 'identity' | 'rename' | 'unlink'>
  trash: TrashWrapper
  volumes: Pick<VolumeRegistry, 'root' | 'isNetwork'>
  /** A plain stat; recovery bounds every call with its own timeout. */
  stat(path: string): Promise<unknown>
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>
  /** Where recovery writes the placement lines of the steps it runs itself, durable before each step. */
  journal: PlacementJournal
  /** Resolves once every journal line appended so far is on disk. */
  flush(): Promise<unknown>
  /** The change T32 records when recovery places a job: the result and warnings the engine builds for T23. */
  placed(job: Readonly<Job>, placed: RecoveredPlacement): JobChange
  registry: Pick<WorkDirRegistry, 'sweep'>
  /** writes `session.json` and compacts the store. */
  compact(): Promise<unknown>
  log: Pick<JobLogger, 'info' | 'warn'>
  /** Defaults to `REACHABLE_TIMEOUT_MS`. */
  reachTimeoutMs?: number
}

/** What `load` found: the replayed journal lines and the session before this one. */
export interface RecoveryInput
{
  /** Every journal line after the snapshot, in `n` order. */
  lines: readonly JournalEntry[]
  previous: SessionInfo | null
}

/** A volume that did not answer, with the jobs whose checks wait for it. */
export interface OfflineVolume
{
  root: string
  label: string
  jobIds: JobId[]
}

/** What one recovery pass did. */
export interface RecoveryReport
{
  reason: InterruptReason
  interrupted: JobId[]
  placed: JobId[]
  held: JobId[]
  /** Held jobs failed because their output is gone from a reachable volume (T33). */
  missing: JobId[]
  /** Reservations deleted because they still had their journaled identity. */
  reservationsDeleted: string[]
  offline: OfflineVolume[]
  /** Whether a restored run was paused with reason `restored`. */
  pausedRun: boolean
  alerts: RunAlert[]
  /** The background sweep of the work-folder registry. */
  sweep: Promise<SweepReport | null>
}

/** A recovered engine: the report and the checks to rerun once an offline volume answers. */
export interface Recovery
{
  report: RecoveryReport
  /** Jobs whose checks wait for an offline volume. */
  deferred(): JobId[]
  /**
   * Reruns the checks of deferred jobs (all of them, or `jobIds`): on `run:resume`, on a held-output command for the
   * job, and when the volume answers again. Returns the jobs whose checks ran.
   */
  recheck(jobIds?: readonly JobId[]): Promise<JobId[]>
}

const STEP_NAMES: ReadonlySet<string> = new Set(['begin', 'reserve', 'displace', 'place', 'copy', 'rollback', 'trash', 'done'])

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlacementLine(line: unknown): line is PlacementLine
{
  return isRecord(line) && line.type === 'placement' && typeof line.jobId === 'string' && typeof line.execution === 'number' &&
    typeof line.step === 'string' && STEP_NAMES.has(line.step)
}

function stepOf(line: PlacementLine): PlacementStep
{
  const { type: _type, jobId: _jobId, execution: _execution, ...step } = line
  return step as PlacementStep
}

/**
 * The reason running jobs are interrupted: the last `quit` or `session-end` interruption journaled by the session
 * before, else `quit` after a clean exit, else `crash`.
 */
export function interruptReason(input: RecoveryInput): InterruptReason
{
  for (let i = input.lines.length - 1; i >= 0; i -= 1)
  {
    const line: unknown = input.lines[i]
    if (isRecord(line) && line.type === 'job.state' && line.to === 'interrupted' && (line.reason === 'quit' || line.reason === 'session-end'))
    {
      return line.reason
    }
  }
  return input.previous?.cleanExit === true ? 'quit' : 'crash'
}

/** The key placement segments are grouped by. */
export function segmentKey(jobId: JobId, execution: number): string
{
  return `${jobId}#${execution}`
}

/** Every placement in the journal, grouped by job and execution; a T26 placement starts a new segment with its `begin`. */
export function placementSegments(lines: readonly JournalEntry[]): Map<string, PlacementSegment[]>
{
  const segments = new Map<string, PlacementSegment[]>()
  for (const line of lines)
  {
    if (!isPlacementLine(line))
    {
      continue
    }
    const key = segmentKey(line.jobId, line.execution)
    const list = segments.get(key) ?? []
    const step = stepOf(line)
    if (step.step === 'begin')
    {
      list.push({ jobId: line.jobId, execution: line.execution, begin: step, steps: [step] })
      segments.set(key, list)
    }
    else if (list.length > 0)
    {
      list[list.length - 1].steps.push(step)
    }
  }
  return segments
}

/** Whether a placement ended with its `done` line. */
export function isFinished(segment: PlacementSegment): boolean
{
  return segment.steps.some((s) => s.step === 'done')
}

/** Every path a placement's lines name, in the order they appear. */
export function segmentPaths(segment: PlacementSegment): string[]
{
  const out: string[] = []
  const add = (path: string): void =>
  {
    if (!out.includes(path))
    {
      out.push(path)
    }
  }
  for (const s of segment.steps)
  {
    switch (s.step)
    {
      case 'begin':
        add(s.output)
        add(s.finalPath)
        add(s.source)
        break
      case 'reserve':
      case 'trash':
        add(s.path)
        break
      case 'done':
        add(s.finalPath)
        break
      default:
        add(s.from)
        add(s.to)
    }
  }
  return out
}

/** Errors that prove a folder's volume answered even though the folder itself is gone. */
const GONE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/** Path checks that ask a path's volume root and parent folder to answer a stat in time, cached for one pass. */
export class VolumeCheck
{
  private readonly roots = new Map<string, boolean>()
  private readonly folders = new Map<string, boolean>()
  private readonly rootReach: Reachability
  private readonly folderReach: Reachability
  private readonly timeoutMs: number

  constructor(private readonly d: Pick<RecoveryDeps, 'volumes' | 'stat' | 'timers' | 'platform' | 'reachTimeoutMs'>)
  {
    this.timeoutMs = d.reachTimeoutMs ?? REACHABLE_TIMEOUT_MS
    this.rootReach = createReachability({ stat: d.stat, timers: d.timers })
    this.folderReach = createReachability({
      stat: async (path) =>
      {
        try
        {
          await d.stat(path)
        }
        catch (err)
        {
          if (!GONE_CODES.has(errorCode(err) ?? ''))
          {
            throw err
          }
        }
      },
      timers: d.timers
    })
  }

  /** Forgets every answer, so a recheck asks the volumes again. */
  reset(): void
  {
    this.roots.clear()
    this.folders.clear()
  }

  /** The roots of the volumes holding `paths` that do not answer: local roots together, network roots one at a time. */
  async offline(paths: readonly string[]): Promise<string[]>
  {
    const located: Array<{ path: string; root: string; network: boolean }> = []
    for (const path of paths)
    {
      located.push({ path, root: await this.d.volumes.root(path), network: await this.d.volumes.isNetwork(path) })
    }
    const unchecked = new Map<string, { root: string; network: boolean }>()
    for (const l of located)
    {
      if (!this.roots.has(l.root))
      {
        unchecked.set(l.root, { root: l.root, network: l.network })
      }
    }
    for (const [root, ok] of await checkRoots([...unchecked.values()], this.rootReach, this.timeoutMs))
    {
      this.roots.set(root, ok)
    }
    const down = new Set<string>()
    const p = pathApi(this.d.platform)
    const folderChecks: Array<{ root: string; folder: string; network: boolean }> = []
    for (const l of located)
    {
      if (this.roots.get(l.root) !== true)
      {
        down.add(l.root)
      }
      else
      {
        folderChecks.push({ root: l.root, folder: p.dirname(l.path), network: l.network })
      }
    }
    const ask = async (c: { root: string; folder: string }): Promise<void> =>
    {
      let ok = this.folders.get(c.folder)
      if (ok === undefined)
      {
        ok = await this.folderReach.reachable(c.folder, this.timeoutMs)
        this.folders.set(c.folder, ok)
      }
      if (!ok)
      {
        down.add(c.root)
      }
    }
    const local = Promise.all(folderChecks.filter((c) => !c.network).map(ask))
    for (const c of folderChecks.filter((n) => n.network))
    {
      await ask(c)
    }
    await local
    return [...down]
  }
}

type Reserve = Extract<PlacementStep, { step: 'reserve' }>
type Displace = Extract<PlacementStep, { step: 'displace' }>
type Place = Extract<PlacementStep, { step: 'place' }>

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** The paths a placement's lines name, listed for a message. */
function listPaths(paths: readonly string[]): string
{
  return paths.join(', ')
}

/** What settling a placement may do: roll forward and back (startup), or only roll back (a recheck of a held job). */
export interface SettleOptions
{
  forward: boolean
  /** False when a finished placement's displaced file sits on a volume that did not answer, so it is not read. */
  inspect?: boolean
}

/**
 * Settles one unfinished placement by its last journaled step: every step reads the disk first, renames only files
 * the journal moved, deletes only reservations that still have their journaled identity, and writes the `trash` and
 * `done` lines of the steps it runs before running them. Paths must be on volumes that answered.
 */
export class PlacementCheck
{
  private readonly claims: Reserve[]
  private readonly displaces: Displace[]
  private readonly place: Place | null
  private readonly copyClaim: Reserve | null
  private readonly warnings: KeptWarning[] = []
  /** Reservations this check deleted. */
  readonly deleted: string[] = []

  constructor(
    private readonly d: Pick<RecoveryDeps, 'fs' | 'trash' | 'journal' | 'log' | 'platform'>,
    private readonly segment: PlacementSegment,
    private readonly displaced: 'trash' | 'keep'
  )
  {
    const steps = segment.steps
    this.claims = steps.filter((s): s is Reserve => s.step === 'reserve')
    this.displaces = steps.filter((s): s is Displace => s.step === 'displace')
    const places = steps.filter((s): s is Place => s.step === 'place')
    this.place = places.length > 0 ? places[places.length - 1] : null
    const placeAt = this.place === null ? -1 : steps.lastIndexOf(this.place)
    const copies = steps.filter((s, i): s is Reserve => s.step === 'reserve' && s.role === 'copy' && i > placeAt)
    this.copyClaim = copies.length > 0 ? copies[copies.length - 1] : null
  }

  private get last(): PlacementStep
  {
    return this.segment.steps[this.segment.steps.length - 1]
  }

  private same(a: string, b: string): boolean
  {
    return samePath(a, b, this.d.platform)
  }

  private async present(path: string): Promise<boolean>
  {
    return (await this.d.fs.identity(path)) !== null
  }

  /** Whether the file at `path` is one of this placement's untouched reservations. */
  private isOwnClaim(path: string, current: FileIdentity | null): boolean
  {
    return this.claims.some((c) => this.same(c.path, path) && sameReservation(c.identity, current))
  }

  private async write(step: PlacementStep): Promise<void>
  {
    const { jobId, execution } = this.segment
    await this.d.journal.durable([{ type: 'placement', jobId, execution, ...step }])
  }

  /** The table's decision for this placement, with its disk actions done. */
  async settle(options: SettleOptions = { forward: true }): Promise<PlacementVerdict>
  {
    const done = this.segment.steps.find((s): s is Extract<PlacementStep, { step: 'done' }> => s.step === 'done')
    if (done !== undefined)
    {
      return this.finished(done, options.inspect !== false)
    }
    const { begin } = this.segment
    const outputInWork = await this.present(begin.output)
    if (this.place !== null && await this.atFinal(this.place, outputInWork))
    {
      return options.forward ? this.forward(this.place) : this.placedElsewhere(this.place.to)
    }
    if (!outputInWork)
    {
      return this.ambiguous()
    }
    return this.backward(this.last.step === 'rollback' ? 'file-locked' : 'interrupted-finalize')
  }

  /** Whether the output reached the final path: renamed out of the work folder, or its journaled copy renamed there. */
  private async atFinal(place: Place, outputInWork: boolean): Promise<boolean>
  {
    const current = await this.d.fs.identity(place.to)
    if (this.copyClaim !== null)
    {
      return sameReservation(this.copyClaim.identity, current)
    }
    return !outputInWork && current !== null && !this.isOwnClaim(place.to, current)
  }

  private hold(reason: 'interrupted-finalize' | 'file-locked', message: string, keepRenamed = false): PlacementVerdict
  {
    return { action: 'hold', reason, message, outputPath: this.segment.begin.output, keepRenamed }
  }

  /** The `any` row: nothing is where the journal says, so nothing is moved or deleted. */
  private ambiguous(): PlacementVerdict
  {
    return this.hold(
      'interrupted-finalize',
      `molexMedia could not tell where the output and the original file are after the last session ended, so nothing was moved or deleted. Check these paths: ${listPaths(segmentPaths(this.segment))}.`
    )
  }

  /** A recheck found the output already at its final path; the job stays held there for a decision. */
  private placedElsewhere(finalPath: string): PlacementVerdict
  {
    return {
      action: 'hold',
      reason: 'interrupted-finalize',
      message: `The output is already at ${finalPath}, but the last session ended before its placement was recorded. Nothing else was changed.`,
      outputPath: finalPath,
      keepRenamed: false
    }
  }
  /** Whether settling must read the disk; a finished placement reads it only for a displaced file at a new name. */
  needsDisk(): boolean
  {
    return !isFinished(this.segment) || (this.segment.begin.flow === 'replace-new-ext' && this.displaces.length > 0)
  }

  /** The `done` row: the placement finished before the last session ended. */
  private async finished(done: Extract<PlacementStep, { step: 'done' }>, inspect: boolean): Promise<PlacementVerdict>
  {
    const { placement } = done
    const kept = (outcome: TrashOutcome, warning: KeptWarning): void =>
    {
      if (outcome.status === 'kept' && outcome.reason !== KEPT_BY_POLICY)
      {
        this.warnings.push(warning)
      }
    }
    if (placement.kind === 'overwrote')
    {
      kept(placement.previous, 'previous-kept')
    }
    else if (placement.kind === 'replaced-original')
    {
      kept(placement.original, 'original-kept')
    }
    let previous: TrashOutcome | null = null
    if (inspect && this.segment.begin.flow === 'replace-new-ext' && this.displaces.length > 0)
    {
      const parked = this.displaces[0].to
      if (this.displaced === 'keep')
      {
        previous = { status: 'kept', path: parked, reason: KEPT_BY_POLICY }
      }
      else if (await this.present(parked))
      {
        previous = { status: 'kept', path: parked, reason: 'The file could not be moved to the bin.' }
        this.warnings.push('previous-kept')
      }
      else
      {
        previous = { status: 'trashed' }
      }
    }
    return { action: 'done', placed: { finalPath: done.finalPath, placement, warnings: [...this.warnings], previous, completedBy: 'journal' } }
  }

  /** The placement kind of an output placed without displacing anything. */
  private fresh(finalPath: string): Placement
  {
    const { begin } = this.segment
    if (begin.mode === 'renamed' || !this.same(finalPath, begin.finalPath))
    {
      return { kind: 'renamed', planned: begin.mode === 'renamed' ? renameBase(begin.finalPath, this.d.platform) : begin.finalPath }
    }
    return { kind: 'new' }
  }

  /** Rolls forward a placement whose output reached its final path: the remaining trash steps, then `done`. */
  private async forward(place: Place): Promise<PlacementVerdict>
  {
    const { begin, jobId } = this.segment
    const outcomes: TrashOutcome[] = []
    for (const d of this.displaces)
    {
      outcomes.push(await this.dispose(d.to, begin.flow === 'replace-same-ext' ? 'original' : 'previous'))
    }
    let previous: TrashOutcome | null = null
    let placement: Placement
    if (begin.flow === 'replace-new-ext')
    {
      previous = outcomes.length > 0 ? outcomes[0] : null
      placement = { kind: 'replaced-original', original: await this.dispose(begin.source, 'original') }
    }
    else if (outcomes.length > 0)
    {
      placement = begin.flow === 'replace-same-ext' ? { kind: 'replaced-original', original: outcomes[0] } : { kind: 'overwrote', previous: outcomes[0] }
    }
    else
    {
      placement = this.fresh(place.to)
    }
    try
    {
      await this.write({ step: 'done', finalPath: place.to, placement })
    }
    catch (err)
    {
      this.d.log.warn(`The done step of ${jobId} could not be saved: ${messageOf(err)}`)
    }
    return { action: 'done', placed: { finalPath: place.to, placement, warnings: [...this.warnings], previous, completedBy: 'recovery' } }
  }

  /**
   * The trash step of a displaced file: the frozen policy's keep skips it; a trash that ran before the last step and
   * left the file kept it; the step in flight at the crash, or one never started, runs now.
   */
  private async dispose(path: string, role: 'original' | 'previous'): Promise<TrashOutcome>
  {
    if (this.displaced === 'keep')
    {
      return { status: 'kept', path, reason: KEPT_BY_POLICY }
    }
    const steps = this.segment.steps
    const index = steps.findIndex((s) => s.step === 'trash' && this.same(s.path, path))
    if (!(await this.present(path)))
    {
      return index >= 0 ? { status: 'trashed' } : { status: 'kept', path, reason: `The file was no longer at ${path} when molexMedia checked it.` }
    }
    const warning: KeptWarning = role === 'original' ? 'original-kept' : 'previous-kept'
    if (index >= 0 && index < steps.length - 1)
    {
      this.warnings.push(warning)
      return { status: 'kept', path, reason: 'The file could not be moved to the bin.' }
    }
    let result: TrashResult
    try
    {
      if (index < 0)
      {
        await this.write({ step: 'trash', path, role })
      }
      result = await this.d.trash.trash(path)
    }
    catch (err)
    {
      result = { status: 'kept', reason: 'refused', message: `The file could not be moved to the bin: ${messageOf(err)}` }
    }
    if (result.status === 'trashed')
    {
      return { status: 'trashed' }
    }
    if (result.reason !== 'no-recycle-bin')
    {
      this.warnings.push(warning)
    }
    return { status: 'kept', path, reason: result.message }
  }

  /** Rolls back a placement whose output is still in its work folder: displaced files first, then the claims. */
  private async backward(reason: 'interrupted-finalize' | 'file-locked'): Promise<PlacementVerdict>
  {
    const problems: string[] = []
    const restored: string[] = []
    for (const d of [...this.displaces].reverse())
    {
      const outcome = await this.restore(d)
      if (outcome === 'restored')
      {
        restored.push(d.from)
      }
      else if (outcome !== 'in-place')
      {
        problems.push(outcome)
      }
    }
    if (problems.length > 0)
    {
      return this.hold(reason, `${problems.join(' ')} Nothing else was moved or deleted, and the output stays ready in its work folder.`)
    }
    const foreign = await this.releaseClaims()
    if (foreign.length > 0)
    {
      return this.hold(reason, `A file molexMedia did not write is now at ${listPaths(foreign)}, so it was left in place. The output stays ready to place.`, true)
    }
    const back = restored.length > 0 ? ` The file moved aside is back at ${listPaths(restored)}.` : ''
    if (reason === 'file-locked')
    {
      const target = this.displaces.length > 0 ? this.displaces[this.displaces.length - 1].from : this.segment.begin.finalPath
      return this.hold('file-locked', `${target} was open in another program when the last session ended, so the output was not placed.${back} The output stays ready to place.`)
    }
    return this.hold('interrupted-finalize', `The last session ended while this output was being placed.${back === '' ? ' Nothing at the destination was changed.' : back} The output stays ready to place.`)
  }

  /** Renames a displaced file back to its own name, only over this placement's untouched claim there. */
  private async restore(d: Displace): Promise<'restored' | 'in-place' | string>
  {
    const parked = await this.d.fs.identity(d.to)
    const own = await this.d.fs.identity(d.from)
    const isOriginal = (current: FileIdentity | null, path: string): boolean =>
      d.identity !== null ? sameReservation(d.identity, current) : current !== null && !this.isOwnClaim(path, current)
    if (!isOriginal(parked, d.to))
    {
      return isOriginal(own, d.from) ? 'in-place' : `The file that was at ${d.from} is no longer at ${d.from} or ${d.to}.`
    }
    if (own !== null && !this.isOwnClaim(d.from, own))
    {
      return `A file molexMedia did not write is now at ${d.from}, so the file moved aside stays at ${d.to}.`
    }
    try
    {
      await this.d.fs.rename(d.to, d.from)
    }
    catch (err)
    {
      return `The file moved aside to ${d.to} could not be renamed back to ${d.from} (${messageOf(err)}).`
    }
    return 'restored'
  }

  /**
   * Deletes this placement's reservations that still have their journaled identity, and returns the reserved paths
   * that now hold a file molexMedia did not write. Paths the journal moved a displaced file through are not reported.
   */
  async releaseClaims(): Promise<string[]>
  {
    const moved = new Set(this.displaces.flatMap((d) => [pathKey(d.from, this.d.platform), pathKey(d.to, this.d.platform)]))
    const byPath = new Map<string, Reserve[]>()
    for (const c of this.claims)
    {
      const key = pathKey(c.path, this.d.platform)
      byPath.set(key, [...(byPath.get(key) ?? []), c])
    }
    const foreign: string[] = []
    for (const [key, claims] of byPath)
    {
      const path = claims[0].path
      const current = await this.d.fs.identity(path)
      if (claims.some((c) => sameReservation(c.identity, current)))
      {
        try
        {
          await this.d.fs.unlink(path)
          this.deleted.push(path)
        }
        catch (err)
        {
          this.d.log.warn(`Could not remove the reservation ${path}: ${messageOf(err)}`)
        }
      }
      else if (current !== null && !moved.has(key))
      {
        foreign.push(path)
      }
    }
    return foreign
  }
}

const RUNNING_STATES: readonly JobState[] = ['analyzing', 'encoding', 'verifying']
const PROTECTED_STATES: readonly JobState[] = ['analyzing', 'encoding', 'verifying', 'finalizing', 'held']
const SOURCE_CHECKS_AT_ONCE = 16

function plural(n: number, one: string, many = `${one}s`): string
{
  return `${n} ${n === 1 ? one : many}`
}

function sentenceList(parts: readonly string[]): string
{
  if (parts.length <= 1)
  {
    return parts.join('')
  }
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/** The actions a recovered hold offers; a destination now taken also offers placing under the next free name. */
export function recoveredHoldActions(keepRenamed: boolean): JobHold['actions']
{
  return keepRenamed ? ['keep', 'keep-renamed', 'discard', 'retry'] : ['keep', 'discard', 'retry']
}

/** The T33 error of a held job whose output is gone from a reachable volume. */
export function heldOutputMissing(job: Pick<Job, 'attempt'>, outputPath: string, at: number): JobError
{
  return {
    code: 'held-output-missing',
    short: 'Output missing',
    cause: null,
    message: `The verified output is no longer at ${outputPath}, so there is nothing to place.`,
    stage: 'place',
    attempt: job.attempt,
    encodePass: null,
    exitCode: null,
    exitName: null,
    signal: null,
    stderrTail: '',
    command: null,
    fsError: { code: 'ENOENT', syscall: 'stat', path: outputPath },
    hint: 'Retry the job to make the output again.',
    at
  }
}

/** The `restored-run` alert of a run restored as paused. */
export function restoredRunAlert(counts: { interrupted: number; decisions: number; queued: number }, jobIds: JobId[], at: number): RunAlert
{
  const parts: string[] = []
  if (counts.interrupted > 0)
  {
    parts.push(`${plural(counts.interrupted, 'job')} ${counts.interrupted === 1 ? 'was' : 'were'} interrupted`)
  }
  if (counts.decisions > 0)
  {
    parts.push(`${plural(counts.decisions, 'output')} ${counts.decisions === 1 ? 'waits' : 'wait'} for a decision`)
  }
  if (counts.queued > 0)
  {
    parts.push(`${plural(counts.queued, 'job')} ${counts.queued === 1 ? 'is' : 'are'} still queued`)
  }
  const detail = parts.length > 0 ? `: ${sentenceList(parts)}` : ''
  return {
    id: 'restored-run',
    kind: 'restored-run',
    severity: counts.interrupted + counts.decisions > 0 ? 'warning' : 'info',
    message: `The run was restored after molexMedia restarted and is paused${detail}.`,
    at,
    volume: null,
    path: null,
    jobIds,
    counts: { ...counts, restored: 0, missing: 0 },
    dismissible: true
  }
}

/** The `restored-queue` alert: waiting jobs restored from the last session and their missing sources. */
export function restoredQueueAlert(counts: { restored: number; queued: number; missing: number }, jobIds: JobId[], at: number): RunAlert
{
  const missing = counts.missing > 0
    ? ` ${plural(counts.missing, 'source file')} ${counts.missing === 1 ? 'is' : 'are'} missing.`
    : ''
  return {
    id: 'restored-queue',
    kind: 'restored-queue',
    severity: counts.missing > 0 ? 'warning' : 'info',
    message: `${plural(counts.restored, 'waiting job')} ${counts.restored === 1 ? 'was' : 'were'} restored from the last session.${missing}`,
    at,
    volume: null,
    path: null,
    jobIds,
    counts: { interrupted: 0, decisions: 0, queued: counts.queued, restored: counts.restored, missing: counts.missing },
    dismissible: true
  }
}

/** The id of the `volume-offline` alert for one volume root. */
export function volumeOfflineId(root: string): string
{
  return `volume-offline:${root}`
}

/** The `volume-offline` alert of held outputs and placements on a volume that did not answer at startup. */
export function volumeOfflineAlert(root: string, label: string, jobIds: JobId[], at: number): RunAlert
{
  return {
    id: volumeOfflineId(root),
    kind: 'volume-offline',
    severity: 'warning',
    message: `${label} did not answer, so the held outputs and placements on it are checked again once it does.`,
    at,
    volume: label,
    path: null,
    jobIds,
    counts: null,
    dismissible: false
  }
}

type Deferral = { kind: 'placement'; segment: PlacementSegment } | { kind: 'held' }

class RecoveryPass implements Recovery
{
  private readonly check: VolumeCheck
  private readonly waiting = new Map<JobId, Deferral>()
  private readonly roots = new Map<string, Set<JobId>>()
  private readonly completed = new Set<PlacementSegment>()
  readonly report: RecoveryReport

  constructor(private readonly d: RecoveryDeps, input: RecoveryInput)
  {
    this.check = new VolumeCheck(d)
    this.report = {
      reason: interruptReason(input),
      interrupted: [],
      placed: [],
      held: [],
      missing: [],
      reservationsDeleted: [],
      offline: [],
      pausedRun: false,
      alerts: [],
      sweep: Promise.resolve(null)
    }
  }

  private get queue(): RecoveryDeps['core']['queue']
  {
    return this.d.core.queue
  }

  private jobsIn(states: readonly JobState[]): Array<Readonly<Job>>
  {
    return this.queue.jobs().filter((job) => states.includes(job.state))
  }

  /** Waits until a transition's line, and every line before it, is on disk. */
  private async commit(result: TransitionResult | null): Promise<void>
  {
    try
    {
      if (result !== null && result.applied)
      {
        await result.durable
      }
      await this.d.flush()
    }
    catch (err)
    {
      this.d.log.warn(`A recovery step could not be saved yet: ${messageOf(err)}`)
    }
  }

  private defer(jobId: JobId, deferral: Deferral, roots: readonly string[]): void
  {
    this.waiting.set(jobId, deferral)
    for (const root of roots)
    {
      const jobs = this.roots.get(root) ?? new Set<JobId>()
      jobs.add(jobId)
      this.roots.set(root, jobs)
    }
  }

  private forget(jobId: JobId): void
  {
    this.waiting.delete(jobId)
    for (const [root, jobs] of this.roots)
    {
      jobs.delete(jobId)
      if (jobs.size === 0)
      {
        this.roots.delete(root)
        this.d.core.clearAlert(volumeOfflineId(root))
      }
    }
  }

  private label(root: string): string
  {
    return volumeLabel(root, this.d.platform)
  }

  private holdOf(job: Readonly<Job>, verdict: Extract<PlacementVerdict, { action: 'hold' }>): JobHold
  {
    return {
      reason: verdict.reason,
      message: verdict.message,
      outputPath: verdict.outputPath,
      displaces: job.plan?.output.displaces ?? null,
      actions: recoveredHoldActions(verdict.keepRenamed),
      since: this.d.core.now()
    }
  }

  async run(segments: Map<string, PlacementSegment[]>): Promise<void>
  {
    await this.interrupt()
    for (const job of this.jobsIn(['finalizing']))
    {
      await this.finalizing(job, segments)
    }
    for (const job of this.jobsIn(['held']))
    {
      await this.held(job)
    }
    await this.reservations(segments)
    await this.restore()
    this.report.offline = [...this.roots].map(([root, jobs]) => ({ root, label: this.label(root), jobIds: [...jobs] }))
    for (const volume of this.report.offline)
    {
      this.raise(volumeOfflineAlert(volume.root, volume.label, volume.jobIds, this.d.core.now()))
    }
    this.report.sweep = this.d.registry.sweep((entry) => this.protect(entry)).catch((err: unknown) =>
    {
      this.d.log.warn(`The work-folder sweep failed: ${messageOf(err)}`)
      return null
    })
    if (this.waiting.size === 0)
    {
      try
      {
        await this.d.compact()
      }
      catch (err)
      {
        this.d.log.warn(`Could not compact the queue after recovery: ${messageOf(err)}`)
      }
    }
  }

  private raise(alert: RunAlert): void
  {
    this.d.core.raiseAlert(alert)
    this.report.alerts.push(alert)
  }

  /** T31: jobs that were running are interrupted; their folders are left to the sweeper. */
  private async interrupt(): Promise<void>
  {
    const running = this.jobsIn(RUNNING_STATES).map((job) => job.id)
    if (running.length === 0)
    {
      return
    }
    this.d.core.interruptActive(this.report.reason)
    this.report.interrupted = running.filter((id) => this.queue.get(id)?.state === 'interrupted')
    await this.commit(null)
  }

  /** T32: a finalizing job by the last placement of its execution. */
  private async finalizing(job: Readonly<Job>, segments: Map<string, PlacementSegment[]>): Promise<void>
  {
    const list = segments.get(segmentKey(job.id, job.execution)) ?? []
    const segment = list.length > 0 ? list[list.length - 1] : null
    if (segment === null)
    {
      await this.apply(job, {
        action: 'hold',
        reason: 'interrupted-finalize',
        message: 'The last session ended while this output was being placed, and its placement steps were not found. Nothing was changed, and the work folder is kept.',
        outputPath: job.workDir ?? job.plan?.output.finalPath ?? job.source.path,
        keepRenamed: false
      })
      return
    }
    const check = new PlacementCheck(this.d, segment, job.policy?.displaced ?? 'keep')
    let inspect = true
    if (check.needsDisk())
    {
      const roots = await this.check.offline(segmentPaths(segment))
      if (roots.length > 0 && !isFinished(segment))
      {
        await this.apply(job, {
          action: 'hold',
          reason: 'interrupted-finalize',
          message: `${roots.map((r) => this.label(r)).join(', ')} did not answer when molexMedia started, so this output's placement is checked again once it does. Nothing was changed.`,
          outputPath: segment.begin.output,
          keepRenamed: false
        })
        this.defer(job.id, { kind: 'placement', segment }, roots)
        return
      }
      inspect = roots.length === 0
    }
    const verdict = await check.settle({ forward: true, inspect })
    this.report.reservationsDeleted.push(...check.deleted)
    if (verdict.action === 'done')
    {
      this.completed.add(segment)
    }
    await this.apply(job, verdict)
  }

  private async apply(job: Readonly<Job>, verdict: PlacementVerdict): Promise<void>
  {
    if (verdict.action === 'done')
    {
      const result = this.d.core.transition(job.id, ['finalizing'], 'recover-placed', { change: this.d.placed(job, verdict.placed) })
      if (result.applied)
      {
        this.report.placed.push(job.id)
      }
      await this.commit(result)
      return
    }
    const result = this.d.core.transition(job.id, ['finalizing'], 'recover-hold', { reason: verdict.reason, change: { hold: this.holdOf(job, verdict) } })
    if (result.applied)
    {
      this.report.held.push(job.id)
    }
    await this.commit(result)
  }

  /** T33: a held output gone from a reachable volume fails the job; on an unreachable one the job waits. */
  private async held(job: Readonly<Job>): Promise<void>
  {
    if (job.hold === null || this.waiting.has(job.id))
    {
      return
    }
    const roots = await this.check.offline([job.hold.outputPath])
    if (roots.length > 0)
    {
      this.defer(job.id, { kind: 'held' }, roots)
      return
    }
    await this.heldOutput(job, job.hold)
  }

  private async heldOutput(job: Readonly<Job>, hold: JobHold): Promise<void>
  {
    if ((await this.d.fs.identity(hold.outputPath)) !== null)
    {
      return
    }
    const result = this.d.core.transition(job.id, ['held'], 'recover-missing', {
      change: { hold: null, error: heldOutputMissing(job, hold.outputPath, this.d.core.now()) }
    })
    if (result.applied)
    {
      this.report.missing.push(job.id)
    }
    await this.commit(result)
  }

  /** Deletes the reservations of unfinished placements that still have their journaled identity. */
  private async reservations(segments: Map<string, PlacementSegment[]>): Promise<void>
  {
    const deferred = new Set<PlacementSegment>()
    for (const deferral of this.waiting.values())
    {
      if (deferral.kind === 'placement')
      {
        deferred.add(deferral.segment)
      }
    }
    for (const list of segments.values())
    {
      for (const segment of list)
      {
        const claims = segment.steps.filter((s): s is Reserve => s.step === 'reserve')
        if (claims.length === 0 || isFinished(segment) || this.completed.has(segment) || deferred.has(segment))
        {
          continue
        }
        if ((await this.check.offline(claims.map((c) => c.path))).length > 0)
        {
          continue
        }
        const check = new PlacementCheck(this.d, segment, 'keep')
        await check.releaseClaims()
        this.report.reservationsDeleted.push(...check.deleted)
      }
    }
  }

  /**
   * The restored run is paused with reason `restored`, and a replace policy needs a fresh acknowledgment. Pending
   * jobs keep their settings, order, and catalog numbers; their plans are cleared to be made again.
   */
  private async restore(): Promise<void>
  {
    const { core } = this.d
    for (const job of this.jobsIn(['pending']))
    {
      if (job.plan !== null)
      {
        core.update(job.id, { plan: null })
      }
    }
    const before = core.run()
    if (before.status === 'running' || before.status === 'pausing')
    {
      core.pauseRun('finish-running', 'restored')
    }
    const queued = this.jobsIn(['queued'])
    const run = core.run()
    if (run.status !== 'idle' && run.needsAck === null && queued.length > 0 && core.globals().policy.destination.mode === 'replace-originals')
    {
      core.setNeedsAck({
        originalsAffected: queued.filter((job) => job.plan?.output.resolution === 'replace-original').length,
        overwrites: queued.filter((job) => job.plan?.output.resolution === 'overwrite').length
      })
    }
    core.settle()
    const after = core.run()
    this.report.pausedRun = after.status !== 'idle' && after.pause?.reason === 'restored'
    await this.commit(null)
    const now = core.now()
    if (after.status !== 'idle' && after.runId !== null)
    {
      const inRun = this.queue.jobs().filter((job) => job.runId === after.runId)
      const interrupted = inRun.filter((job) => job.state === 'interrupted' && !job.acknowledged)
      const decisions = inRun.filter((job) => job.state === 'held' && job.hold?.reason === 'interrupted-finalize')
      this.raise(restoredRunAlert(
        { interrupted: interrupted.length, decisions: decisions.length, queued: inRun.filter((job) => job.state === 'queued').length },
        [...interrupted, ...decisions].map((job) => job.id),
        now
      ))
    }
    const waiting = this.jobsIn(['pending', 'queued'])
    if (waiting.length > 0)
    {
      const missing = await this.missingSources(waiting)
      this.raise(restoredQueueAlert(
        { restored: waiting.length, queued: queued.length, missing: missing.length },
        missing.length > 0 ? missing : waiting.map((job) => job.id),
        now
      ))
    }
  }

  /** Waiting jobs whose source is gone from a reachable volume; a source on an unreachable volume is not missing. */
  private async missingSources(jobs: ReadonlyArray<Readonly<Job>>): Promise<JobId[]>
  {
    const missing: JobId[] = []
    for (let i = 0; i < jobs.length; i += SOURCE_CHECKS_AT_ONCE)
    {
      const batch = jobs.slice(i, i + SOURCE_CHECKS_AT_ONCE)
      const gone = await Promise.all(batch.map(async (job) =>
        (await this.check.offline([job.source.path])).length === 0 && (await this.d.fs.identity(job.source.path)) === null))
      batch.forEach((job, n) =>
      {
        if (gone[n])
        {
          missing.push(job.id)
        }
      })
    }
    return missing
  }

  /** The sweep keeps the current execution of a held or active job. */
  private protect(entry: WorkDirEntry): boolean
  {
    const job = this.queue.get(entry.jobId)
    return job !== undefined && job.execution === entry.execution && PROTECTED_STATES.includes(job.state)
  }

  deferred(): JobId[]
  {
    return [...this.waiting.keys()]
  }

  async recheck(jobIds?: readonly JobId[]): Promise<JobId[]>
  {
    this.check.reset()
    const ran: JobId[] = []
    for (const id of jobIds ?? this.deferred())
    {
      const deferral = this.waiting.get(id)
      if (deferral === undefined)
      {
        continue
      }
      const job = this.queue.get(id)
      if (job === undefined || job.state !== 'held' || job.hold === null)
      {
        this.forget(id)
        continue
      }
      const paths = deferral.kind === 'placement' ? segmentPaths(deferral.segment) : [job.hold.outputPath]
      if ((await this.check.offline(paths)).length > 0)
      {
        continue
      }
      let hold: JobHold = job.hold
      if (deferral.kind === 'placement')
      {
        const check = new PlacementCheck(this.d, deferral.segment, job.policy?.displaced ?? 'keep')
        const verdict = await check.settle({ forward: false, inspect: true })
        this.report.reservationsDeleted.push(...check.deleted)
        if (verdict.action === 'hold')
        {
          hold = { ...this.holdOf(job, verdict), since: job.hold.since }
          this.d.core.update(id, { hold })
          await this.commit(null)
        }
      }
      const current = this.queue.get(id)
      if (current !== undefined)
      {
        await this.heldOutput(current, hold)
      }
      this.forget(id)
      ran.push(id)
    }
    return ran
  }
}

/**
 * Recovers the engine after `JobStore.load()` and the registry load, before IPC is registered: every step in order,
 * each written before the next. Returns the report and the checks that wait for offline volumes.
 */
export async function recoverEngine(deps: RecoveryDeps, input: RecoveryInput): Promise<Recovery>
{
  const pass = new RecoveryPass(deps, input)
  await pass.run(placementSegments(input.lines))
  return pass
}
