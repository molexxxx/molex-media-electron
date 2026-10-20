/**
 * Places a verified output by the frozen plan's resolution: a new file or folder, an overwrite through a displaced
 * `(previous)` name, or a replaced original through an `(original)` name or from its own path. Each step re-checks
 * the disk and is journaled before it runs, names are claimed by exclusive reservations whose identity is journaled,
 * and a displaced file leaves only through the trash or stays beside the output.
 */

import type { JobId } from '../../shared/jobs/ids'
import type { BatchPolicy, OutputPlan, Placement, TrashOutcome, Verdict } from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { Timers } from '../timers'
import type { FileIdentity, FsOps, JobLogger } from './deps'
import { errorCode, LOCK_CODES, sameReservation, withLockRetries } from './fsops'
import type { TrashResult, TrashWrapper } from './fsops'
import { nextFreeDisplacedPath, nextRenamedPath, pathApi, pathKey, samePath, splitName } from './naming'
import type { DisplacedKind } from './naming'

/** The transition a placement starts with: a verified output (T20) or a held one placed again (T26). */
export type PlacementTransition = 'T20' | 'T26'

/**
 * The flow a placement takes: a new file (A), a frames folder (B), an overwrite (C), a replaced original with the
 * same extension (D) or with a new one (E).
 */
export type PlacementFlow = 'file' | 'folder' | 'overwrite' | 'replace-same-ext' | 'replace-new-ext'

/** A placement journal step. Each is durable before its step runs; `reserve` records the claim it just made. */
export type PlacementStep =
  | {
    step: 'begin'
    transition: PlacementTransition
    verdict: Verdict | null
    mode: Placement['kind'] | null
    flow: PlacementFlow
    finalPath: string
    output: string
    source: string
  }
  | { step: 'reserve'; path: string; role: 'final' | 'displaced' | 'copy'; identity: FileIdentity }
  | { step: 'displace'; from: string; to: string; identity: FileIdentity | null }
  | { step: 'place'; from: string; to: string }
  | { step: 'copy'; from: string; to: string }
  | { step: 'rollback'; from: string; to: string }
  | { step: 'trash'; path: string; role: DisplacedKind }
  | { step: 'done'; finalPath: string; placement: Placement }

/** A placement journal line before the store numbers it. */
export type PlacementEntry = { type: 'placement'; jobId: JobId; execution: number } & PlacementStep

/** Where placement lines go: `durable` resolves once the lines are on disk and rejects when they cannot be. */
export interface PlacementJournal
{
  durable(entries: readonly PlacementEntry[]): Promise<unknown>
}

/** What placement needs from the engine. */
export interface FinalizeDeps
{
  platform: Platform
  timers: Timers
  fs: FsOps
  trash: TrashWrapper
  journal: PlacementJournal
  /** Deletes the work folder through the registry (T23); false when it went to the pending list instead. */
  removeWorkDir(workDir: string): Promise<boolean>
  log: Pick<JobLogger, 'info' | 'warn'>
}

/** One job's placement, from its frozen plan and policy. */
export interface PlacementRequest
{
  jobId: JobId
  execution: number
  transition: PlacementTransition
  verdict: Verdict | null
  output: Pick<OutputPlan, 'kind' | 'finalPath' | 'resolution' | 'renamedTo'>
  policy: Pick<BatchPolicy, 'conflict' | 'displaced'>
  source: string
  /** The verified output inside the work folder: the `.part` file, or the frames folder. */
  outputPath: string
  workDir: string
  /** Whether another queued, active, or held job holds a path, so the rename rule skips it. */
  isReserved?(path: string): boolean
  /** Called once a lock wait passes 2 s, with the path, so the job shows the `wait-lock` stage. */
  onWaitLock?(path: string): void
}

/** Why a placement holds its verified output. */
export type PlacementHoldReason = 'destination-appeared' | 'file-locked' | 'storage-unavailable'

/** The warning a done job keeps when a displaced file stayed beside its output unplanned. */
export type KeptWarning = 'original-kept' | 'previous-kept'

/** How a placement ended. */
export type FinalizeResult =
  | {
    status: 'done'
    finalPath: string
    placement: Placement
    warnings: KeptWarning[]
    /** The file a new-extension replacement overwrote at its new name, when there was one. */
    previous: TrashOutcome | null
    /** Whether the output crossed volumes and was copied and hashed instead of renamed. */
    copied: boolean
    /** False when the work folder went to the registry's pending list. */
    workDirRemoved: boolean
  }
  | {
    status: 'held'
    reason: PlacementHoldReason
    message: string
    /** Where the verified output is now. */
    outputPath: string
    /** The file the output would displace, when it displaces one. */
    displaces: string | null
    code: string | null
  }

/** Places verified outputs. */
export interface Finalizer
{
  place(request: PlacementRequest): Promise<FinalizeResult>
}

/** The reason a displaced file kept by the frozen policy records. */
export const KEPT_BY_POLICY = 'kept by policy'

/** Codes that say the destination volume, not a lock, stopped a step. */
export const STORAGE_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EROFS'])

const CLAIM_LOST = 'ECLAIMLOST'

class PlacementHold extends Error
{
  constructor(readonly reason: PlacementHoldReason, message: string, readonly code: string | null)
  {
    super(message)
  }
}

interface Claim
{
  path: string
  identity: FileIdentity
}

interface Placed
{
  finalPath: string
  placement: Placement
  copied: boolean
}

function detail(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

function claimLost(path: string): NodeJS.ErrnoException
{
  return Object.assign(new Error(`${path} changed after molexMedia reserved it`), { code: CLAIM_LOST })
}

/** The flow the frozen plan's resolution takes, never the current policy's. */
export function chooseFlow(output: Pick<OutputPlan, 'kind' | 'finalPath' | 'resolution'>, source: string, platform: Platform): PlacementFlow
{
  if (output.kind === 'folder')
  {
    return 'folder'
  }
  if (output.resolution === 'replace-original')
  {
    return samePath(output.finalPath, source, platform) ? 'replace-same-ext' : 'replace-new-ext'
  }
  return output.resolution === 'overwrite' ? 'overwrite' : 'file'
}

/** The name a planned rename numbered: `song (2).wav` back to `song.wav`; other names stay as they are. */
export function renameBase(path: string, platform: Platform): string
{
  const p = pathApi(platform)
  const { stem, ext } = splitName(p.basename(path))
  const match = / \(\d+\)$/.exec(stem)
  return match === null ? path : p.join(p.dirname(path), `${stem.slice(0, match.index)}${ext}`)
}

/** The second work name, in the final folder, that a cross-volume copy is written to before its rename. */
export function copyTargetPath(finalPath: string, workDir: string, outputPath: string, platform: Platform): string
{
  const p = pathApi(platform)
  return p.join(p.dirname(finalPath), `${p.basename(workDir)}-${p.basename(outputPath)}`)
}

/** The placement kind the `begin` line records. */
export function plannedMode(resolution: OutputPlan['resolution']): Placement['kind'] | null
{
  switch (resolution)
  {
    case 'place':
      return 'new'
    case 'rename':
      return 'renamed'
    case 'overwrite':
      return 'overwrote'
    case 'replace-original':
      return 'replaced-original'
    default:
      return null
  }
}

class PlacementRun
{
  private readonly taken = new Set<string>()
  private readonly warnings: KeptWarning[] = []

  constructor(private readonly d: FinalizeDeps, private readonly r: PlacementRequest)
  {
  }

  async run(): Promise<FinalizeResult>
  {
    const { output, source } = this.r
    const flow = chooseFlow(output, source, this.d.platform)
    try
    {
      await this.write({
        step: 'begin',
        transition: this.r.transition,
        verdict: this.r.verdict,
        mode: plannedMode(output.resolution),
        flow,
        finalPath: output.finalPath,
        output: this.r.outputPath,
        source
      })
      return await this.flow(flow)
    }
    catch (err)
    {
      if (!(err instanceof PlacementHold))
      {
        throw err
      }
      return {
        status: 'held',
        reason: err.reason,
        message: err.message,
        outputPath: this.r.outputPath,
        displaces: output.resolution === 'overwrite' || output.resolution === 'replace-original' ? this.displaces() : null,
        code: err.code
      }
    }
  }

  private async flow(flow: PlacementFlow): Promise<FinalizeResult>
  {
    const { finalPath } = this.r.output
    switch (flow)
    {
      case 'folder':
        return this.finish(await this.placeFolder(finalPath), null)
      case 'overwrite':
        return this.finish(await this.overwrite(finalPath), null)
      case 'replace-same-ext':
      {
        const displaced = await this.displace(this.r.source, 'original')
        if (displaced === null)
        {
          return this.finish(await this.placeFile(this.r.source), null)
        }
        return this.finish({ finalPath: displaced.finalPath, copied: displaced.copied, placement: { kind: 'replaced-original', original: displaced.outcome } }, null)
      }
      case 'replace-new-ext':
      {
        const placed = await this.placeFile(finalPath, (target) => this.overwrite(target))
        const original = await this.dispose(this.r.source, 'original')
        const previous = placed.placement.kind === 'overwrote' ? placed.placement.previous : null
        return this.finish({ ...placed, placement: { kind: 'replaced-original', original } }, previous)
      }
      default:
        return this.finish(await this.placeFile(finalPath, (target) => this.overwrite(target)), null)
    }
  }

  private displaces(): string
  {
    return this.r.output.resolution === 'replace-original' ? this.r.source : this.r.output.finalPath
  }

  private async write(step: PlacementStep): Promise<void>
  {
    try
    {
      await this.d.journal.durable([{ type: 'placement', jobId: this.r.jobId, execution: this.r.execution, ...step }])
    }
    catch (err)
    {
      this.d.log.warn(`Could not save the ${step.step} step of ${this.r.jobId}: ${detail(err)}`)
      throw new PlacementHold(
        'storage-unavailable',
        'molexMedia could not save the next placement step to disk, so it did not run. The output stays ready and is placed once saving works again.',
        errorCode(err)
      )
    }
  }

  private retry<T>(op: () => Promise<T>, path: string): Promise<T>
  {
    const onWaitLock = this.r.onWaitLock
    return withLockRetries(op, { timers: this.d.timers, onWaiting: onWaitLock ? (): void => onWaitLock(path) : undefined })
  }

  private isTaken(candidate: string): boolean
  {
    return this.taken.has(pathKey(candidate, this.d.platform)) || (this.r.isReserved?.(candidate) ?? false)
  }

  private toHold(err: unknown, path: string): PlacementHold
  {
    if (err instanceof PlacementHold)
    {
      return err
    }
    const code = errorCode(err)
    if (code !== null && LOCK_CODES.has(code))
    {
      return new PlacementHold('file-locked', `${path} is open in another program, so the output was not placed. It stays ready to place.`, code)
    }
    if (code !== null && STORAGE_CODES.has(code))
    {
      const message = code === 'ENOSPC'
        ? `The drive holding ${path} is full, so the output was not placed. It stays ready and is placed once there is room.`
        : `The drive holding ${path} reported ${code}, so the output was not placed. It stays ready to place.`
      return new PlacementHold('storage-unavailable', message, code)
    }
    if (code === CLAIM_LOST || code === 'EEXIST')
    {
      return new PlacementHold('destination-appeared', `A file appeared at ${path} after the plan, so the output was not placed. It stays ready to place.`, code)
    }
    return new PlacementHold('file-locked', `${path} could not be changed (${detail(err)}), so the output was not placed. It stays ready to place.`, code)
  }

  /** Claims `path` exclusively; null when a file is already there. The claim's identity is durable before it is used. */
  private async reserve(path: string, role: 'final' | 'displaced'): Promise<Claim | null>
  {
    let identity: FileIdentity
    try
    {
      identity = await this.retry(() => this.d.fs.reserve(path), path)
    }
    catch (err)
    {
      if (errorCode(err) === 'EEXIST')
      {
        this.taken.add(pathKey(path, this.d.platform))
        return null
      }
      throw this.toHold(err, path)
    }
    const claim = { path, identity }
    try
    {
      await this.write({ step: 'reserve', path, role, identity })
    }
    catch (err)
    {
      await this.release(claim)
      throw err
    }
    return claim
  }

  /** Deletes an empty reservation, only while the file at its path still has the reservation's identity. */
  private async release(claim: Claim): Promise<void>
  {
    try
    {
      if (sameReservation(claim.identity, await this.d.fs.identity(claim.path)))
      {
        await this.d.fs.unlink(claim.path)
      }
    }
    catch (err)
    {
      this.d.log.warn(`Could not remove the reservation ${claim.path}: ${detail(err)}`)
    }
  }

  /** Fails with `CLAIM_LOST` when the file at a claimed path is no longer the untouched reservation. */
  private async ensure(claim: Claim): Promise<void>
  {
    if (!sameReservation(claim.identity, await this.d.fs.identity(claim.path)))
    {
      throw claimLost(claim.path)
    }
  }

  /** The template's path behind the plan's name, which run-time renames count from. */
  private base(): string
  {
    const { finalPath, renamedTo } = this.r.output
    return renamedTo === null ? finalPath : renameBase(finalPath, this.d.platform)
  }

  /** The next name under the rename rule, counted from the template's name. */
  private renamed(): string
  {
    const next = nextRenamedPath(this.base(), (candidate) => this.isTaken(candidate), this.d.platform)
    if (next === null)
    {
      throw new PlacementHold('destination-appeared', `Every numbered name for ${this.base()} is taken, so the output was not placed.`, 'EEXIST')
    }
    return next.path
  }

  /** Renames the output over a claim, re-checking the claim before every attempt; a cross-volume move copies instead. */
  private async moveOutput(claim: Claim): Promise<boolean>
  {
    const from = this.r.outputPath
    await this.write({ step: 'place', from, to: claim.path })
    try
    {
      await this.retry(async () =>
      {
        await this.ensure(claim)
        await this.d.fs.rename(from, claim.path)
      }, claim.path)
      return false
    }
    catch (err)
    {
      if (errorCode(err) !== 'EXDEV')
      {
        throw err
      }
    }
    await this.copyOver(claim)
    return true
  }

  /**
   * The cross-volume fallback: a copy streamed and hashed into a second work name beside the claim, its identity
   * journaled as the engine's own, then a same-folder rename over the claim.
   */
  private async copyOver(claim: Claim): Promise<void>
  {
    const from = this.r.outputPath
    const copy = copyTargetPath(claim.path, this.r.workDir, from, this.d.platform)
    this.d.log.warn(`Unexpected cross-volume move from ${from} to ${claim.path}; copying it instead`)
    await this.write({ step: 'copy', from, to: copy })
    try
    {
      await this.d.fs.copyFile(from, copy)
    }
    catch (err)
    {
      throw this.toHold(err, claim.path)
    }
    const identity = await this.d.fs.identity(copy)
    if (identity === null)
    {
      throw this.toHold(Object.assign(new Error(`The copy at ${copy} is missing`), { code: 'ENOENT' }), claim.path)
    }
    const copied = { path: copy, identity }
    try
    {
      await this.write({ step: 'reserve', path: copy, role: 'copy', identity })
      await this.retry(async () =>
      {
        await this.ensure(claim)
        await this.d.fs.rename(copy, claim.path)
      }, claim.path)
    }
    catch (err)
    {
      await this.release(copied)
      throw err
    }
  }

  /**
   * Flow A: claims the path, then places the output over the claim. A file that appeared since the plan takes the
   * next free name under the rename rule and holds the job under the skip rule; the overwrite rule hands it to
   * `onTaken`, which flow A alone does not have.
   */
  private async placeFile(planned: string, onTaken?: (target: string) => Promise<Placed>): Promise<Placed>
  {
    let target = planned
    for (;;)
    {
      const claim = await this.reserve(target, 'final')
      if (claim !== null)
      {
        try
        {
          const copied = await this.moveOutput(claim)
          const renamed = this.r.output.renamedTo !== null || !samePath(target, this.r.output.finalPath, this.d.platform)
          const placement: Placement = renamed ? { kind: 'renamed', planned: this.base() } : { kind: 'new' }
          return { finalPath: target, placement, copied }
        }
        catch (err)
        {
          await this.release(claim)
          if (errorCode(err) !== CLAIM_LOST)
          {
            throw this.toHold(err, target)
          }
          this.taken.add(pathKey(target, this.d.platform))
        }
      }
      const rule = this.r.policy.conflict
      if (rule === 'overwrite' && onTaken)
      {
        return onTaken(target)
      }
      if (rule !== 'rename')
      {
        throw this.toHold(Object.assign(new Error(`${target} exists`), { code: 'EEXIST' }), target)
      }
      target = this.renamed()
    }
  }

  /** Flow C at `target`; when the file to overwrite has gone since the plan, flow A places the output there. */
  private async overwrite(target: string): Promise<Placed>
  {
    const displaced = await this.displace(target, 'previous')
    if (displaced === null)
    {
      return this.placeFile(target)
    }
    return { finalPath: displaced.finalPath, copied: displaced.copied, placement: { kind: 'overwrote', previous: displaced.outcome } }
  }

  /** Claims the first free displaced name beside `target`: `(previous)`, then `(previous 2)`, and so on. */
  private async reserveDisplaced(target: string, kind: DisplacedKind): Promise<Claim>
  {
    for (;;)
    {
      const next = nextFreeDisplacedPath(target, kind, (candidate) => this.isTaken(candidate), this.d.platform)
      if (next === null)
      {
        throw new PlacementHold('destination-appeared', `Every displaced name for ${target} is taken, so the output was not placed.`, 'EEXIST')
      }
      const claim = await this.reserve(next.path, 'displaced')
      if (claim !== null)
      {
        return claim
      }
    }
  }

  /**
   * Flows C and D: renames the file at `target` to a claimed displaced name, claims `target` and places the output
   * over the claim, then trashes or keeps the displaced file. A failed placement renames the displaced file back.
   * Null when nothing is at `target` any more, so there is nothing to displace.
   */
  private async displace(target: string, kind: DisplacedKind): Promise<{ finalPath: string; copied: boolean; outcome: TrashOutcome } | null>
  {
    const parked = await this.reserveDisplaced(target, kind)
    let existing: FileIdentity | null
    try
    {
      existing = await this.d.fs.identity(target)
      if (existing !== null)
      {
        await this.write({ step: 'displace', from: target, to: parked.path, identity: existing })
        await this.retry(async () =>
        {
          await this.ensure(parked)
          await this.d.fs.rename(target, parked.path)
        }, target)
      }
    }
    catch (err)
    {
      await this.release(parked)
      throw this.toHold(err, target)
    }
    if (existing === null)
    {
      await this.release(parked)
      return null
    }
    let claim: Claim | null
    try
    {
      claim = await this.reserve(target, 'final')
    }
    catch (err)
    {
      throw await this.rollback(parked.path, target, null, err)
    }
    if (claim === null)
    {
      throw new PlacementHold(
        'destination-appeared',
        `A file appeared at ${target} while the output was being placed. The file that was there is kept as ${parked.path}, and the output stays ready to place.`,
        'EEXIST'
      )
    }
    let copied: boolean
    try
    {
      copied = await this.moveOutput(claim)
    }
    catch (err)
    {
      throw await this.rollback(parked.path, target, claim, err)
    }
    return { finalPath: target, copied, outcome: await this.dispose(parked.path, kind) }
  }

  /**
   * Renames a displaced file back to its own name, over the engine's claim there when it has one, and returns the
   * hold to raise. The rollback runs even when its line cannot be saved, since it only restores the user's name.
   */
  private async rollback(parked: string, target: string, claim: Claim | null, cause: unknown, folder = false): Promise<PlacementHold>
  {
    const hold = this.toHold(cause, target)
    try
    {
      await this.write({ step: 'rollback', from: parked, to: target })
    }
    catch
    {
      this.d.log.warn(`Renaming ${parked} back to ${target} before its rollback line is saved`)
    }
    try
    {
      await this.retry(async () =>
      {
        if (claim !== null)
        {
          await this.ensure(claim)
        }
        else if (!folder && await this.d.fs.identity(target) !== null)
        {
          throw claimLost(target)
        }
        await (folder ? this.renameFolder(parked, target) : this.d.fs.rename(parked, target))
      }, target)
      return hold
    }
    catch (err)
    {
      this.d.log.warn(`Could not rename ${parked} back to ${target}: ${detail(err)}`)
      if (claim !== null)
      {
        await this.release(claim)
      }
      return new PlacementHold(
        hold.reason,
        `The output could not be placed at ${target}, and the file moved aside to ${parked} could not be moved back. Both are kept and nothing was deleted.`,
        hold.code
      )
    }
  }

  /** The trash step: the frozen policy's keep skips it, and a refusal or a full bin keeps the file with a warning. */
  private async dispose(path: string, kind: DisplacedKind): Promise<TrashOutcome>
  {
    if (this.r.policy.displaced === 'keep')
    {
      return { status: 'kept', path, reason: KEPT_BY_POLICY }
    }
    const warning: KeptWarning = kind === 'original' ? 'original-kept' : 'previous-kept'
    let result: TrashResult
    try
    {
      await this.write({ step: 'trash', path, role: kind })
      result = await this.d.trash.trash(path)
    }
    catch (err)
    {
      const reason = err instanceof PlacementHold
        ? 'molexMedia could not save this step to disk, so the file stays where it is.'
        : `The file could not be moved to the bin: ${detail(err)}`
      result = { status: 'kept', reason: 'refused', message: reason }
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

  /** Renames a folder, reporting a folder that is already at the destination as `EEXIST` rather than a lock. */
  private async renameFolder(from: string, to: string): Promise<void>
  {
    try
    {
      await this.d.fs.rename(from, to)
    }
    catch (err)
    {
      const code = errorCode(err)
      if ((code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY' || code === 'EEXIST') && await this.d.fs.identity(to) !== null)
      {
        throw Object.assign(new Error(`${to} exists`), { code: 'EEXIST' })
      }
      throw err
    }
  }

  /**
   * Flow B: the frames folder is renamed out of the work folder once the final folder is checked absent. Renaming
   * onto an existing folder fails (`EPERM` on Windows, `ENOTEMPTY` on POSIX), so a race cannot clobber one.
   */
  private async placeFolder(planned: string, overwrite = true): Promise<Placed>
  {
    let target = planned
    for (;;)
    {
      try
      {
        if (await this.d.fs.identity(target) === null)
        {
          await this.write({ step: 'place', from: this.r.outputPath, to: target })
          await this.retry(() => this.renameFolder(this.r.outputPath, target), target)
          const renamed = this.r.output.renamedTo !== null || !samePath(target, this.r.output.finalPath, this.d.platform)
          return { finalPath: target, placement: renamed ? { kind: 'renamed', planned: this.base() } : { kind: 'new' }, copied: false }
        }
      }
      catch (err)
      {
        if (errorCode(err) !== 'EEXIST')
        {
          throw this.toHold(err, target)
        }
      }
      this.taken.add(pathKey(target, this.d.platform))
      const rule = this.r.policy.conflict
      if (rule === 'overwrite' && overwrite)
      {
        return this.overwriteFolder(target)
      }
      if (rule !== 'rename')
      {
        throw this.toHold(Object.assign(new Error(`${target} exists`), { code: 'EEXIST' }), target)
      }
      target = this.renamed()
    }
  }

  /** Flow C for a frames folder: the existing folder moves to a free displaced name and the output takes its place. */
  private async overwriteFolder(target: string): Promise<Placed>
  {
    let parked: string | null = null
    try
    {
      for (;;)
      {
        const next = nextFreeDisplacedPath(target, 'previous', (candidate) => this.isTaken(candidate), this.d.platform)
        if (next === null)
        {
          throw new PlacementHold('destination-appeared', `Every displaced name for ${target} is taken, so the output was not placed.`, 'EEXIST')
        }
        this.taken.add(pathKey(next.path, this.d.platform))
        if (await this.d.fs.identity(next.path) !== null)
        {
          continue
        }
        const existing = await this.d.fs.identity(target)
        if (existing === null)
        {
          return await this.placeFolder(target, false)
        }
        await this.write({ step: 'displace', from: target, to: next.path, identity: existing })
        try
        {
          await this.retry(() => this.renameFolder(target, next.path), target)
          parked = next.path
          break
        }
        catch (err)
        {
          if (errorCode(err) !== 'EEXIST')
          {
            throw err
          }
        }
      }
    }
    catch (err)
    {
      throw this.toHold(err, target)
    }
    try
    {
      await this.write({ step: 'place', from: this.r.outputPath, to: target })
      await this.retry(() => this.renameFolder(this.r.outputPath, target), target)
    }
    catch (err)
    {
      throw await this.rollback(parked, target, null, err, true)
    }
    return { finalPath: target, copied: false, placement: { kind: 'overwrote', previous: await this.dispose(parked, 'previous') } }
  }

  private async finish(placed: Placed, previous: TrashOutcome | null): Promise<FinalizeResult>
  {
    try
    {
      await this.write({ step: 'done', finalPath: placed.finalPath, placement: placed.placement })
    }
    catch
    {
      this.d.log.warn(`The done step of ${this.r.jobId} waits in the write queue`)
    }
    let workDirRemoved = false
    try
    {
      workDirRemoved = await this.d.removeWorkDir(this.r.workDir)
    }
    catch (err)
    {
      this.d.log.warn(`Could not remove ${this.r.workDir}: ${detail(err)}`)
    }
    return {
      status: 'done',
      finalPath: placed.finalPath,
      placement: placed.placement,
      warnings: [...this.warnings],
      previous,
      copied: placed.copied,
      workDirRemoved
    }
  }
}

/** The placement engine over injected file operations, trash, journal, and timers. */
export function createFinalizer(deps: FinalizeDeps): Finalizer
{
  return {
    place: (request) => new PlacementRun(deps, request).run()
  }
}
