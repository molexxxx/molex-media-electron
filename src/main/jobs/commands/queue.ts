/**
 * The queue-editing commands: adding files and folders (picked, dropped, pasted, or scanned), the recent folders,
 * remove and restore, reorder, recipe assignment, duplicates, and pointing jobs at moved sources. Every per-job
 * refusal follows the applicability matrix and never throws, and no command here queues a job: every job reaches
 * the queue through a reviewed Start.
 */

import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { AddResult, CommandError, CommandResult, JobCommandMap, JobRefusal, JobRefusalCode, PerJob } from '../../../shared/jobs/contract'
import { isMediaPath } from '../../../shared/jobs/extensions'
import type { JobId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import { commandApplicability, commandInstead, type MatrixCommand } from '../../../shared/jobs/states'
import type { Job, JobPlan, RecentFolder, ScanState, SourceRef } from '../../../shared/jobs/types'
import { validateRecipe } from '../../../shared/jobs/validate'
import type { Platform } from '../../../shared/text/platform'
import { planIsCurrent, type EngineCore } from '../core'
import type { FileStat } from '../deps'
import { pathKey as namingPathKey } from '../naming'
import { probeFailure, type JobProbeQueue } from '../probe-queue'
import type { NewJob } from '../queue'
import { createScanner, type ScanDeps, type ScanFs, type Scanner, type ScannedFile } from '../scan'
import type { Replan } from '../scheduler'
import type { Tombstones } from '../tombstones'

/** How many recent folders the engine keeps. */
export const RECENT_FOLDER_LIMIT = 8

/** What the clipboard holds for a paste: the platform's file list, and its plain text. */
export interface ClipboardContent
{
  files: string[]
  text: string
}

/** What the queue commands are built from. */
export interface QueueCommandsDeps
{
  core: EngineCore
  tombstones: Pick<Tombstones, 'record' | 'take'>
  probes: Pick<JobProbeQueue, 'probeSource' | 'invalidate'>
  /** Plans one job against the current policy and capabilities; null when the plan is blocked. */
  replan: Replan
  stat(path: string): Promise<FileStat | null>
  platform: Platform
  /** True when the file matches an output recorded in a kept history record or held by the queue. */
  isPreviousOutput(file: { path: string; size: number; mtimeMs: number }): boolean
  /** Reads the clipboard; the host reads the platform's file-drop formats and the text. */
  readClipboard(): ClipboardContent | Promise<ClipboardContent>
  /** Comparison key of a path; defaults to the naming module's key. */
  pathKey?: (path: string) => string
  /** Builds the scanner over the queue's hooks; defaults to `createScanner`. */
  createScanner?: (hooks: ScanDeps) => Scanner
  scanFs?: ScanFs
  yieldTurn?: () => Promise<void>
  /** Writes the recent folders to the `jobs` config key. */
  persistRecentFolders?(folders: RecentFolder[]): void | Promise<void>
  /** Keeps the recipes `assignRecipe` and `duplicate` applied, in order, as the recent presets. */
  recordRecent?(recipes: Recipe[]): void
  quitting?(): boolean
}

/** The queue-editing command names. */
export type QueueCommandName =
  | 'add' | 'pasteFiles' | 'cancelScan' | 'forgetFolder' | 'clearRecentFolders' | 'remove' | 'restore' | 'reorder'
  | 'assignRecipe' | 'duplicate' | 'locate' | 'relink' | 'reprobe'

/** One handler per queue command, the scanner they start, and a wait for their background probes. */
export type QueueCommands =
  { [K in QueueCommandName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }
  & {
    readonly scanner: Scanner
    /** Resolves once every probe and re-plan the commands started has settled. */
    settled(): Promise<void>
  }

type Refused = { ok: false; error: CommandError }

/** The matrix commands of this module; none of them has a no-op cell. */
type QueueMatrixCommand = Extract<MatrixCommand, 'remove' | 'reorder' | 'assignRecipe' | 'duplicate' | 'locate' | 'relink' | 'reprobe'>

interface ScanContext
{
  recipe: Recipe
  origin: SourceRef['origin']
  after: JobId | null
  folder: string
}

const WAITING_STATES = new Set<Job['state']>(['pending', 'queued'])

const DESTRUCTIVE_RANK: Readonly<Record<JobPlan['output']['resolution'], number>> =
{
  'place': 0,
  'skip': 0,
  'rename': 0,
  'overwrite': 1,
  'replace-original': 2
}

const INSTEAD_TEXT: Readonly<Partial<Record<MatrixCommand, string>>> =
{
  duplicate: 'Use Duplicate instead.',
  retry: 'Use Retry instead.',
  discardOutput: 'Use Discard output instead.'
}

function refuse(code: CommandError['code'], message: string): Refused
{
  return { ok: false, error: { code, message, issues: [], details: null } }
}

function ok<T>(value: T, seq: number): CommandResult<T>
{
  return { ok: true, value, seq }
}

/** A path with surrounding spaces and one pair of matching quotes removed, as Explorer's "Copy as path" writes it. */
export function cleanPath(raw: string): string
{
  let text = raw.trim()
  while (text.length >= 2 && (text[0] === '"' || text[0] === '\'') && text[text.length - 1] === text[0])
  {
    text = text.slice(1, -1).trim()
  }
  return text
}

/** The paths in pasted text: one per line, cleaned, blank lines dropped. */
export function textPaths(text: string): string[]
{
  return text.split(/\r?\n/).map(cleanPath).filter((line) => line.length > 0)
}

/** The page's words for a per-job refusal. */
export function refusalMessage(code: JobRefusalCode, job: Readonly<Job> | null, id: JobId): string
{
  switch (code)
  {
    case 'not-found':
      return `${id} is not in the queue.`
    case 'job-running':
      return `${id} is running.`
    case 'job-finalizing':
      return `${id} is being placed.`
    case 'job-held':
      return `${id} is waiting for a decision on its output.`
    case 'job-terminal':
      return `${id} has finished.`
    case 'not-movable':
      return `${id} cannot be moved: only waiting jobs move.`
    case 'needs-attention':
      return `${id} needs attention. Acknowledge it before removing it.`
    case 'source-not-found':
      return `No file was found for ${id}.`
    default:
      return `${id} cannot be changed while it is ${job === null ? 'gone' : job.state}.`
  }
}

/** One refusal for a job, naming the command the matrix offers instead. */
export function matrixRefusal(command: MatrixCommand, job: Readonly<Job>, code: JobRefusalCode): JobRefusal
{
  const instead = commandInstead(command, job)
  const hint = instead === null ? undefined : INSTEAD_TEXT[instead]
  const message = refusalMessage(code, job, job.id)
  return { jobId: job.id, code, message: hint === undefined ? message : `${message} ${hint}` }
}

/** Whether a new plan replaces or overwrites more than the plan it replaces. */
export function moreDestructive(next: Readonly<JobPlan>, before: Readonly<JobPlan> | null): boolean
{
  const rank = (plan: Readonly<JobPlan> | null): number => plan === null ? 0 : DESTRUCTIVE_RANK[plan.output.resolution]
  return rank(next) > rank(before)
}

/** Builds the queue-editing commands over the engine core. */
export function createQueueCommands(deps: QueueCommandsDeps): QueueCommands
{
  const { core } = deps
  const paths = deps.platform === 'win32' ? win32 : posix
  const keyOf = deps.pathKey ?? ((path: string): string => namingPathKey(path, deps.platform))
  const contexts = new Map<string, ScanContext>()
  const background = new Set<Promise<void>>()
  let nextScanId: string | null = null
  let waitingIndex: Map<string, JobId[]> | null = null

  function seq(): number
  {
    return core.bus.flush()
  }

  function track(work: Promise<void>): Promise<void>
  {
    const settled = work.catch((err: unknown) => core.log.warn(`A queue command's background work failed: ${String(err)}`))
    background.add(settled)
    void settled.finally(() => background.delete(settled))
    return settled
  }

  /** The waiting jobs by path key; built once per turn, and kept current by this module's own adds. */
  function waiting(): Map<string, JobId[]>
  {
    if (waitingIndex === null)
    {
      const index = new Map<string, JobId[]>()
      for (const job of core.queue.jobs())
      {
        if (WAITING_STATES.has(job.state))
        {
          const key = keyOf(job.source.path)
          index.set(key, [...(index.get(key) ?? []), job.id])
        }
      }
      waitingIndex = index
      queueMicrotask(() =>
      {
        waitingIndex = null
      })
    }
    return waitingIndex
  }

  function noteAdded(jobs: ReadonlyArray<Readonly<Job>>): void
  {
    if (waitingIndex === null)
    {
      return
    }
    for (const job of jobs)
    {
      const key = keyOf(job.source.path)
      waitingIndex.set(key, [...(waitingIndex.get(key) ?? []), job.id])
    }
  }

  function sourceOf(path: string, stat: { size: number; mtimeMs: number }, origin: SourceRef['origin'], subdir: string): SourceRef
  {
    const name = paths.basename(path)
    return { path, name, ext: paths.extname(name).toLowerCase(), dir: paths.dirname(path), size: stat.size, mtimeMs: stat.mtimeMs, origin, subdir }
  }

  function outputFolder(): string | null
  {
    const destination = core.globals().policy.destination
    return destination.mode === 'folder' ? destination.folder : null
  }

  function capacity(): number
  {
    return Math.max(0, core.globals().limits.maxJobs - core.queue.size)
  }

  const scanHooks: ScanDeps =
  {
    platform: deps.platform,
    fs: deps.scanFs,
    yieldTurn: deps.yieldTurn,
    pathKey: keyOf,
    id: () => nextScanId ?? randomUUID(),
    capacity,
    isWaiting: (path) => waiting().has(keyOf(path)),
    isPreviousOutput: (file) => deps.isPreviousOutput(file),
    onFiles: (files, scan) => addScanned(files, scan),
    onProgress: (scan) => scanProgress(scan)
  }

  const scanner = (deps.createScanner ?? createScanner)(scanHooks)

  function addScanned(files: ScannedFile[], scan: ScanState): void
  {
    const context = contexts.get(scan.scanId)
    if (context === undefined || files.length === 0)
    {
      return
    }
    const inits: NewJob[] = files.map((file) => ({ source: sourceOf(file.path, file, context.origin, file.subdir), recipe: context.recipe }))
    const added = core.add(inits, context.after)
    if (added === null)
    {
      core.log.warn(`No catalog number was free for ${files.length} files of the scan of ${scan.root}`)
      return
    }
    noteAdded(added)
    context.after = added[added.length - 1].id
    probeInBackground(added.map((job) => job.id))
  }

  function scanProgress(scan: ScanState): void
  {
    core.upsertScan(scan)
    const context = contexts.get(scan.scanId)
    if (context !== undefined && scan.status !== 'scanning')
    {
      contexts.delete(scan.scanId)
      const key = keyOf(context.folder)
      const folders = core.globals().recentFolders
      if (folders.some((folder) => keyOf(folder.path) === key))
      {
        saveFolders(folders.map((folder) => keyOf(folder.path) === key ? { ...folder, files: scan.added } : folder))
      }
    }
  }

  function saveFolders(folders: RecentFolder[]): void
  {
    core.setRecentFolders(folders)
    if (deps.persistRecentFolders !== undefined)
    {
      void track(Promise.resolve().then(() => deps.persistRecentFolders?.(folders)))
    }
  }

  function recordFolder(folder: string): void
  {
    const key = keyOf(folder)
    const entry: RecentFolder = { path: folder, name: paths.basename(folder) || folder, files: 0, addedAt: core.now() }
    const rest = core.globals().recentFolders.filter((existing) => keyOf(existing.path) !== key)
    saveFolders([entry, ...rest].slice(0, RECENT_FOLDER_LIMIT))
  }

  function startScan(folder: string, context: Omit<ScanContext, 'folder'>, options: { recursive: boolean; allowSecondJobs: boolean; force: boolean }): string
  {
    const scanId = randomUUID()
    contexts.set(scanId, { ...context, folder })
    nextScanId = scanId
    try
    {
      scanner.start(folder, { recursive: options.recursive, outputFolder: outputFolder(), allowSecondJobs: options.allowSecondJobs, force: options.force })
    }
    finally
    {
      nextScanId = null
    }
    recordFolder(folder)
    return scanId
  }

  function probeInBackground(ids: JobId[]): void
  {
    if (ids.length > 0)
    {
      void track(Promise.all(ids.map((id) => probeOne(id))).then(() => undefined))
    }
  }

  /** Probes a job's source and stores its summary; a failure leaves the job pending for the planner to block. */
  async function probeOne(id: JobId): Promise<void>
  {
    const job = core.queue.get(id)
    if (job === undefined)
    {
      return
    }
    const path = job.source.path
    try
    {
      const probed = await deps.probes.probeSource(path)
      const current = core.queue.get(id)
      if (current === undefined || current.source.path !== path)
      {
        return
      }
      if (probed.size !== current.source.size || probed.mtimeMs !== current.source.mtimeMs)
      {
        core.update(id, { probe: 'ok', media: probed.summary, source: { ...current.source, size: probed.size, mtimeMs: probed.mtimeMs } }, { inputs: true })
        return
      }
      core.update(id, { probe: 'ok', media: probed.summary })
    }
    catch (err)
    {
      const failure = probeFailure(err)
      const current = core.queue.get(id)
      if (failure.code !== 'canceled' && current !== undefined && current.source.path === path)
      {
        core.update(id, { probe: 'failed', media: null })
      }
    }
  }

  /** Answers each distinct id by the matrix: the jobs the command applies to, and the refusals of the rest. */
  function select(command: QueueMatrixCommand, ids: readonly JobId[]): { jobs: Array<Readonly<Job>>; refused: JobRefusal[] }
  {
    const jobs: Array<Readonly<Job>> = []
    const refused: JobRefusal[] = []
    for (const id of new Set(ids))
    {
      const job = core.queue.get(id)
      if (job === undefined)
      {
        refused.push({ jobId: id, code: 'not-found', message: refusalMessage('not-found', null, id) })
        continue
      }
      const answer = commandApplicability(command, job)
      if (answer === 'ok')
      {
        jobs.push(job)
      }
      else
      {
        refused.push(matrixRefusal(command, job, answer as JobRefusalCode))
      }
    }
    return { jobs, refused }
  }

  /**
   * Plans a waiting job again in place. A pending job takes the new plan; a queued job keeps its place unless the new
   * plan is blocked or more destructive, which demotes it to pending (T5). A job that changed meanwhile is left alone.
   */
  async function replanOne(id: JobId): Promise<void>
  {
    const job = core.queue.get(id)
    if (job === undefined || !WAITING_STATES.has(job.state))
    {
      return
    }
    const { inputsRev, state } = job
    const before = job.plan
    let next: JobPlan | null
    try
    {
      next = await deps.replan(job)
    }
    catch (err)
    {
      core.log.warn(`Could not work out the output of ${id} again: ${String(err)}`)
      next = null
    }
    const current = core.queue.get(id)
    if (current === undefined || current.state !== state || current.inputsRev !== inputsRev)
    {
      return
    }
    if (state === 'pending')
    {
      core.update(id, { plan: next })
      return
    }
    core.releaseClaim(id)
    if (next === null)
    {
      core.transition(id, ['queued'], 'demote', { reason: 'plan-blocked', change: { plan: null } })
    }
    else if (moreDestructive(next, before))
    {
      core.transition(id, ['queued'], 'demote', { reason: 'destructive-scope', change: { plan: next } })
    }
    else
    {
      core.update(id, { plan: next })
    }
  }

  /** Probes the jobs again when asked, then plans them again in place. */
  async function refresh(ids: readonly JobId[], probe: boolean): Promise<void>
  {
    await Promise.all(ids.map(async (id) =>
    {
      if (probe)
      {
        await probeOne(id)
      }
      await replanOne(id)
    }))
  }

  async function remove(req: JobCommandMap['remove']['req']): Promise<CommandResult<JobCommandMap['remove']['res']>>
  {
    const { jobs, refused } = select('remove', req.ids)
    const applied = jobs.map((job) => job.id)
    const tombstone = core.batch(() =>
    {
      for (const id of applied)
      {
        core.releaseClaim(id)
      }
      return deps.tombstones.record('remove', core.remove(applied))
    })
    return ok({ applied, refused, tombstone }, seq())
  }

  async function restore(req: JobCommandMap['restore']['req']): Promise<CommandResult<PerJob>>
  {
    const taken = deps.tombstones.take(req.tombstone)
    if (!taken.ok)
    {
      return refuse('restore-expired', taken.message)
    }
    const applied = core.restore(taken.tombstone.entries)
    const back = new Set(applied)
    const refused: JobRefusal[] = taken.tombstone.entries
      .filter((entry) => !back.has(entry.job.id))
      .map((entry) => ({ jobId: entry.job.id, code: 'duplicate', message: `${entry.job.id} is already in the queue.` }))
    const { policy, capabilities } = core.globals()
    const stale = applied.filter((id) =>
    {
      const job = core.queue.get(id)
      return job !== undefined && job.state === 'pending' && !planIsCurrent(job, policy.rev, capabilities.rev)
    })
    await refresh(stale, false)
    return ok({ applied, refused }, seq())
  }

  async function reorder(req: JobCommandMap['reorder']['req']): Promise<CommandResult<PerJob>>
  {
    const { jobs, refused } = select('reorder', req.ids)
    if (jobs.length === 0)
    {
      return ok({ applied: [], refused }, seq())
    }
    const moved = core.reorder(jobs.map((job) => job.id), req.before)
    if (moved === null)
    {
      return refuse('not-found', `${String(req.before)} is not in the queue.`)
    }
    return ok({ applied: moved.applied, refused: [...refused, ...moved.refused] }, seq())
  }

  async function assignRecipe(req: JobCommandMap['assignRecipe']['req']): Promise<CommandResult<PerJob>>
  {
    const applied: JobId[] = []
    const refused: JobRefusal[] = []
    const recipes: Recipe[] = []
    const queued: JobId[] = []
    const seen = new Set<JobId>()
    core.batch(() =>
    {
      for (const { jobId, recipe: proposed } of req.assignments)
      {
        if (seen.has(jobId))
        {
          continue
        }
        seen.add(jobId)
        const { jobs, refused: refusals } = select('assignRecipe', [jobId])
        if (refusals.length > 0)
        {
          refused.push(...refusals)
          continue
        }
        const checked = validateRecipe(proposed)
        if (!checked.ok)
        {
          refused.push({ jobId, code: 'invalid-recipe', message: `The settings for ${jobId} are not valid.` })
          continue
        }
        const job = jobs[0]
        const recipe = checked.value
        if (job.state === 'pending')
        {
          core.update(jobId, { recipe, plan: null }, { inputs: true })
        }
        else if (job.state === 'queued')
        {
          core.releaseClaim(jobId)
          core.update(jobId, { recipe }, { inputs: true })
          queued.push(jobId)
        }
        else
        {
          core.transition(jobId, [job.state], 'edit-retry', { change: { plan: null, runId: null } })
          core.update(jobId, { recipe }, { inputs: true })
        }
        applied.push(jobId)
        recipes.push(recipe)
      }
    })
    if (recipes.length > 0)
    {
      deps.recordRecent?.(recipes)
    }
    await refresh(queued, false)
    return ok({ applied, refused }, seq())
  }

  async function duplicate(req: JobCommandMap['duplicate']['req']): Promise<CommandResult<JobCommandMap['duplicate']['res']>>
  {
    let recipe: Recipe | null = null
    if (req.recipe !== null)
    {
      const checked = validateRecipe(req.recipe)
      if (!checked.ok)
      {
        return { ok: false, error: { code: 'invalid-payload', message: 'The settings are not valid.', issues: checked.issues, details: null } }
      }
      recipe = checked.value
    }
    const { jobs, refused } = select('duplicate', req.ids)
    if (jobs.length > capacity())
    {
      return refuse('queue-full', `The queue holds at most ${core.globals().limits.maxJobs} jobs.`)
    }
    const applied: JobId[] = []
    const created: JobId[] = []
    const unprobed: JobId[] = []
    for (const job of jobs)
    {
      const added = core.add([{ source: { ...job.source }, recipe: recipe ?? job.recipe }], job.id)
      if (added === null)
      {
        refused.push({ jobId: job.id, code: 'blocked', message: 'No catalog number could be reserved. Try again.' })
        continue
      }
      noteAdded(added)
      const twin = added[0].id
      if (job.probe === 'ok')
      {
        core.update(twin, { probe: 'ok', media: job.media })
      }
      else
      {
        unprobed.push(twin)
      }
      applied.push(job.id)
      created.push(twin)
    }
    if (recipe !== null && created.length > 0)
    {
      deps.recordRecent?.(created.map(() => recipe))
    }
    probeInBackground(unprobed)
    return ok({ applied, refused, created }, seq())
  }

  function isUnder(dir: string, path: string): boolean
  {
    const root = keyOf(dir)
    const separator = deps.platform === 'win32' ? '\\' : '/'
    return keyOf(path).startsWith(root.endsWith(separator) ? root : `${root}${separator}`)
  }

  /** Points a waiting job at another file: a new source identity, so `inputsRev` + 1 and no dispatch until it lands. */
  function pointAt(job: Readonly<Job>, path: string, stat: FileStat): void
  {
    core.releaseClaim(job.id)
    core.update(job.id, { source: sourceOf(path, stat, job.source.origin, job.source.subdir), probe: 'pending', media: null }, { inputs: true })
  }

  /** The other waiting jobs whose sources in `dir` are missing. */
  async function missingIn(dir: string, except: JobId): Promise<JobId[]>
  {
    const key = keyOf(dir)
    const candidates = core.queue.jobs()
      .filter((job) => job.id !== except && keyOf(job.source.dir) === key && commandApplicability('relink', job) === 'ok')
    const stats = await Promise.all(candidates.map((job) => deps.stat(job.source.path)))
    return candidates.filter((_, index) => stats[index] === null).map((job) => job.id)
  }

  async function locate(req: JobCommandMap['locate']['req']): Promise<CommandResult<JobCommandMap['locate']['res']>>
  {
    const path = cleanPath(req.path)
    const stat = paths.isAbsolute(path) ? await deps.stat(path) : null
    const { jobs, refused } = select('locate', [req.jobId])
    if (jobs.length === 0)
    {
      return ok({ applied: [], refused, relinkable: null }, seq())
    }
    const job = jobs[0]
    if (stat === null || !stat.isFile)
    {
      return ok({ applied: [], refused: [{ jobId: job.id, code: 'source-not-found', message: `No file was found at ${path}.` }], relinkable: null }, seq())
    }
    const fromDir = job.source.dir
    const toDir = paths.dirname(path)
    pointAt(job, path, stat)
    await refresh([job.id], true)
    let relinkable: JobCommandMap['locate']['res']['relinkable'] = null
    if (keyOf(fromDir) !== keyOf(toDir))
    {
      const ids = await missingIn(fromDir, job.id)
      relinkable = ids.length > 0 ? { fromDir, toDir, ids } : null
    }
    return ok({ applied: [job.id], refused: [], relinkable }, seq())
  }

  async function relink(req: JobCommandMap['relink']['req']): Promise<CommandResult<PerJob>>
  {
    const fromDir = cleanPath(req.fromDir)
    const toDir = cleanPath(req.toDir)
    if (!paths.isAbsolute(fromDir) || !paths.isAbsolute(toDir))
    {
      return refuse('invalid-payload', 'Both folders must be full paths.')
    }
    let candidates: readonly JobId[]
    if (req.ids === 'missing')
    {
      const under = core.queue.jobs().filter((job) => isUnder(fromDir, job.source.path) && commandApplicability('relink', job) === 'ok')
      const stats = await Promise.all(under.map((job) => deps.stat(job.source.path)))
      candidates = under.filter((_, index) => stats[index] === null).map((job) => job.id)
    }
    else
    {
      candidates = req.ids
    }
    const targets = new Map<JobId, { from: string; path: string; stat: FileStat | null }>()
    await Promise.all([...new Set(candidates)].map(async (id) =>
    {
      const job = core.queue.get(id)
      if (job !== undefined && isUnder(fromDir, job.source.path))
      {
        const path = paths.join(toDir, paths.relative(fromDir, job.source.path))
        targets.set(id, { from: job.source.path, path, stat: await deps.stat(path) })
      }
    }))
    const { jobs, refused } = select('relink', candidates)
    const applied: JobId[] = []
    for (const job of jobs)
    {
      const target = targets.get(job.id)
      if (target === undefined || target.from !== job.source.path)
      {
        refused.push({ jobId: job.id, code: 'source-not-found', message: `The file of ${job.id} is not in ${fromDir}.` })
      }
      else if (target.stat === null || !target.stat.isFile)
      {
        refused.push({ jobId: job.id, code: 'source-not-found', message: `No file was found at ${target.path}.` })
      }
      else
      {
        pointAt(job, target.path, target.stat)
        applied.push(job.id)
      }
    }
    await refresh(applied, true)
    return ok({ applied, refused }, seq())
  }

  async function reprobe(req: JobCommandMap['reprobe']['req']): Promise<CommandResult<PerJob>>
  {
    const { jobs, refused } = select('reprobe', req.ids)
    const applied = jobs.map((job) => job.id)
    for (const job of jobs)
    {
      deps.probes.invalidate(job.source.path)
      core.releaseClaim(job.id)
      core.update(job.id, { probe: 'pending' }, { inputs: true })
    }
    await refresh(applied, true)
    return ok({ applied, refused }, seq())
  }

  async function add(req: JobCommandMap['add']['req']): Promise<CommandResult<AddResult>>
  {
    if (deps.quitting?.() === true)
    {
      return refuse('shutting-down', 'molexMedia is quitting.')
    }
    if (capacity() === 0)
    {
      return refuse('queue-full', `The queue holds at most ${core.globals().limits.maxJobs} jobs.`)
    }
    let recipe = core.globals().defaultRecipe
    if (req.recipe !== null)
    {
      const checked = validateRecipe(req.recipe)
      if (!checked.ok)
      {
        return { ok: false, error: { code: 'invalid-payload', message: 'The settings are not valid.', issues: checked.issues, details: null } }
      }
      recipe = checked.value
    }
    const result: AddResult = { added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [] }
    const seen = new Set<string>()
    const files: Array<{ path: string; stat: FileStat }> = []
    const folders: string[] = []
    for (const raw of req.paths)
    {
      const path = cleanPath(raw)
      if (path.length === 0 || !paths.isAbsolute(path))
      {
        result.refused.push({ path: raw, code: 'invalid-path', message: `Not a full path: ${raw}` })
        continue
      }
      const key = keyOf(path)
      if (seen.has(key))
      {
        continue
      }
      seen.add(key)
      const stat = await deps.stat(path)
      if (stat === null)
      {
        result.refused.push({ path, code: 'source-not-found', message: `No file or folder at ${path}` })
      }
      else if (stat.isDirectory)
      {
        folders.push(path)
      }
      else if (!stat.isFile)
      {
        result.refused.push({ path, code: 'not-a-file', message: `Not a file: ${path}` })
      }
      else if (req.origin !== 'files' && !isMediaPath(path))
      {
        result.refused.push({ path, code: 'unsupported', message: `Not a media file molexMedia reads: ${path}` })
      }
      else
      {
        files.push({ path, stat })
      }
    }
    const admitted: NewJob[] = []
    const index = waiting()
    for (const file of files)
    {
      const existing = index.get(keyOf(file.path))
      if (existing !== undefined && !req.allowSecondJobs)
      {
        result.duplicates.paths.push(file.path)
        result.duplicates.jobIds.push(...existing)
        continue
      }
      if (!req.force && deps.isPreviousOutput({ path: file.path, size: file.stat.size, mtimeMs: file.stat.mtimeMs }))
      {
        result.previousOutputs.push(file.path)
        continue
      }
      admitted.push({ source: sourceOf(file.path, file.stat, req.origin, ''), recipe })
    }
    const room = capacity()
    for (const over of admitted.splice(room))
    {
      result.refused.push({ path: over.source.path, code: 'queue-full', message: `The queue is full: ${over.source.path}` })
    }
    let after = req.after
    if (admitted.length > 0)
    {
      const added = core.add(admitted, after)
      if (added === null)
      {
        return refuse('io-error', 'No catalog number could be reserved. Try again.')
      }
      noteAdded(added)
      result.added = added.map((job) => job.id)
      after = result.added[result.added.length - 1]
      probeInBackground(result.added)
    }
    const origin: SourceRef['origin'] = req.origin === 'drop' ? 'drop' : 'folder'
    for (const folder of folders)
    {
      result.scanIds.push(startScan(folder, { recipe, origin, after }, req))
    }
    return ok(result, seq())
  }

  async function pasteFiles(req: JobCommandMap['pasteFiles']['req']): Promise<CommandResult<JobCommandMap['pasteFiles']['res']>>
  {
    let content: ClipboardContent
    try
    {
      content = await deps.readClipboard()
    }
    catch (err)
    {
      core.log.warn(`The clipboard could not be read: ${String(err)}`)
      content = { files: [], text: '' }
    }
    const listed = content.files.map(cleanPath).filter((path) => path.length > 0)
    const source = listed.length > 0 ? 'file-list' : textPaths(content.text).length > 0 ? 'text' : 'empty'
    if (source === 'empty')
    {
      return ok({ added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [], source }, seq())
    }
    const result = await add({
      paths: source === 'file-list' ? listed : textPaths(content.text),
      recipe: req.recipe,
      origin: 'files',
      after: null,
      recursive: req.recursive,
      allowSecondJobs: false,
      force: false
    })
    return result.ok ? ok({ ...result.value, source }, result.seq) : result
  }

  async function cancelScan(req: JobCommandMap['cancelScan']['req']): Promise<CommandResult<null>>
  {
    if (scanner.cancel(req.scanId))
    {
      return ok(null, seq())
    }
    return scanner.get(req.scanId) === null
      ? refuse('not-found', 'That folder scan is not known.')
      : refuse('invalid-state', 'That folder scan has already ended.')
  }

  async function forgetFolder(req: JobCommandMap['forgetFolder']['req']): Promise<CommandResult<null>>
  {
    const key = keyOf(cleanPath(req.path))
    const folders = core.globals().recentFolders
    const rest = folders.filter((folder) => keyOf(folder.path) !== key)
    if (rest.length !== folders.length)
    {
      saveFolders(rest)
    }
    return ok(null, seq())
  }

  async function clearRecentFolders(): Promise<CommandResult<null>>
  {
    if (core.globals().recentFolders.length > 0)
    {
      saveFolders([])
    }
    return ok(null, seq())
  }

  return {
    scanner,
    add,
    pasteFiles,
    cancelScan,
    forgetFolder,
    clearRecentFolders,
    remove,
    restore,
    reorder,
    assignRecipe,
    duplicate,
    locate,
    relink,
    reprobe,
    async settled()
    {
      while (background.size > 0)
      {
        await Promise.all([...background])
      }
    }
  }
}
