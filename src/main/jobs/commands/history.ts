/**
 * The history commands: the run list with its storage usage, one run's records in pages, search across kept runs,
 * rerun of recorded jobs as new pending jobs, deletion from history, reveal of a recorded file, and the CSV or JSON
 * report written through a save dialog. Reads go through the run history; new jobs go through the core.
 */

import { posix, win32 } from 'node:path'
import type { CommandError, CommandResult, JobCommandMap, RevealTarget } from '../../../shared/jobs/contract'
import type { PresetLookup } from '../../../shared/jobs/describe'
import { formatRunLabel, isJobId, isRunId, type JobId, type RunId } from '../../../shared/jobs/ids'
import type { HistoryRecord, SourceRef } from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import type { EngineCore } from '../core'
import type { FileStat } from '../deps'
import { RUN_PAGE_LIMIT, type RunHistory } from '../history'
import type { JobsPaths } from '../persistence'
import type { NewJob } from '../queue'

/** The history command names. */
export type HistoryCommandName = 'exportReport' | 'listRuns' | 'getRun' | 'searchRuns' | 'rerun' | 'deleteRuns' | 'revealRecord'

/** Who sent a command, so a dialog can be parented to the sender's window. */
export interface CommandOrigin
{
  senderId: number | null
}

/** What the history commands are built from. */
export interface HistoryCommandsDeps
{
  core: Pick<EngineCore, 'add' | 'bus' | 'globals' | 'log' | 'queue' | 'run'>
  history: Pick<RunHistory, 'entries' | 'list' | 'get' | 'search' | 'rerunCheck' | 'delete' | 'readRun' | 'reportRows' | 'exportReport'>
  paths: Pick<JobsPaths, 'attemptLog'>
  platform: Platform
  stat(path: string): Promise<FileStat | null>
  /** The lookup that names user presets in a report. */
  presetLookup(): PresetLookup
  /** Shows the save dialog parented to the sender's window at the default path; null when it is canceled. */
  chooseSavePath(defaultPath: string, origin: CommandOrigin): Promise<string | null>
  /** Probes the sources of new pending jobs in the background. */
  probe(ids: JobId[]): void
  /** Shows a file the engine knows in the system file manager. */
  showItemInFolder(path: string): void
  quitting?(): boolean
  now?: () => number
}

type Handler<K extends HistoryCommandName> = (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>>

/** One handler per history command; `exportReport` also takes the sender for its dialog. */
export type HistoryCommands =
  { [K in Exclude<HistoryCommandName, 'exportReport'>]: Handler<K> }
  & {
    exportReport(req: JobCommandMap['exportReport']['req'], origin?: CommandOrigin): Promise<CommandResult<JobCommandMap['exportReport']['res']>>
  }

type Refused = { ok: false; error: CommandError }

const REVEAL_TARGETS: readonly RevealTarget[] = ['source', 'output', 'held-output', 'kept-original', 'log']

function refuse(code: CommandError['code'], message: string, path = ''): Refused
{
  return { ok: false, error: { code, message, issues: path ? [{ path, message }] : [], details: null } }
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** A page size within 1 and the most one reply carries. */
export function pageLimit(limit: number): number
{
  return Number.isFinite(limit) ? Math.min(RUN_PAGE_LIMIT, Math.max(1, Math.floor(limit))) : RUN_PAGE_LIMIT
}

/** The path a reveal target names in a record, or null when the record has no such file. */
export function recordTarget(record: HistoryRecord, attempt: number, target: RevealTarget, paths: Pick<JobsPaths, 'attemptLog'>): string | null
{
  switch (target)
  {
    case 'source':
      return record.source.path
    case 'output':
      return record.state === 'done' ? record.output?.path ?? null : null
    case 'held-output':
      return record.state === 'held' ? record.output?.path ?? null : null
    case 'kept-original':
    {
      const placement = record.placement
      const outcome = placement?.kind === 'replaced-original' ? placement.original : placement?.kind === 'overwrote' ? placement.previous : null
      return outcome?.status === 'kept' ? outcome.path : null
    }
    case 'log':
    {
      if (attempt === record.attempt && record.logFile)
      {
        return record.logFile
      }
      const earlier = record.attempts.find((entry) => entry.attempt === attempt)
      return paths.attemptLog(earlier?.runId ?? record.runId, record.jobId, attempt)
    }
  }
}

/** Builds the history command handlers. */
export function createHistoryCommands(deps: HistoryCommandsDeps): HistoryCommands
{
  const { core, history } = deps
  const paths = deps.platform === 'win32' ? win32 : posix

  function ok<T>(value: T): CommandResult<T>
  {
    return { ok: true, value, seq: core.bus.flush() }
  }

  function known(runId: RunId): boolean
  {
    return history.entries().some((entry) => entry.runId === runId)
  }

  function unknownRun(runId: unknown, path = 'runId'): Refused | null
  {
    if (!isRunId(runId))
    {
      return refuse('invalid-payload', 'Choose a batch from history.', path)
    }
    if (!known(runId))
    {
      return refuse('not-found', `${formatRunLabel(runId)} is no longer in history.`)
    }
    return null
  }

  function sourceOf(path: string, stat: FileStat): SourceRef
  {
    const name = paths.basename(path)
    return { path, name, ext: paths.extname(name).toLowerCase(), dir: paths.dirname(path), size: stat.size, mtimeMs: stat.mtimeMs, origin: 'files', subdir: '' }
  }

  async function listRuns(req: JobCommandMap['listRuns']['req']): Promise<CommandResult<JobCommandMap['listRuns']['res']>>
  {
    if (req.before !== null && !isRunId(req.before))
    {
      return refuse('invalid-payload', 'The page must start after a batch from history.', 'before')
    }
    return ok(await history.list(req.before, pageLimit(req.limit)))
  }

  async function getRun(req: JobCommandMap['getRun']['req']): Promise<CommandResult<JobCommandMap['getRun']['res']>>
  {
    const refused = unknownRun(req.runId)
    if (refused)
    {
      return refused
    }
    if (!Number.isInteger(req.offset) || req.offset < 0)
    {
      return refuse('invalid-payload', 'The page offset must be a whole number of at least 0.', 'offset')
    }
    return ok(await history.get(req.runId, req.offset, pageLimit(req.limit)))
  }

  async function searchRuns(req: JobCommandMap['searchRuns']['req']): Promise<CommandResult<JobCommandMap['searchRuns']['res']>>
  {
    if (typeof req.query !== 'string')
    {
      return refuse('invalid-payload', 'Type a file name, path, or job number to search for.', 'query')
    }
    if (req.before !== null && (!isRunId(req.before.runId) || !isJobId(req.before.jobId)))
    {
      return refuse('invalid-payload', 'The page must start after a match from an earlier page.', 'before')
    }
    return ok(await history.search(req.query.trim(), pageLimit(req.limit), req.before))
  }

  async function rerun(req: JobCommandMap['rerun']['req']): Promise<CommandResult<JobCommandMap['rerun']['res']>>
  {
    if (deps.quitting?.() === true)
    {
      return refuse('shutting-down', 'molexMedia is quitting.')
    }
    const refused = unknownRun(req.runId)
    if (refused)
    {
      return refused
    }
    if (req.jobIds !== 'all' && req.jobIds !== 'returned' && (!Array.isArray(req.jobIds) || !req.jobIds.every(isJobId)))
    {
      return refuse('invalid-payload', 'Choose jobs of this batch to rerun.', 'jobIds')
    }
    const check = await history.rerunCheck(req.runId, req.jobIds, req.force === true)
    const missing = [...check.missing]
    const inits: NewJob[] = []
    for (const entry of check.add)
    {
      const info = await deps.stat(entry.path)
      if (!info || !info.isFile)
      {
        missing.push({ jobId: entry.rerunOf.jobId, path: entry.path })
        continue
      }
      inits.push({ source: sourceOf(entry.path, info), recipe: structuredClone(entry.recipe), rerunOf: { ...entry.rerunOf } })
    }
    const room = Math.max(0, core.globals().limits.maxJobs - core.queue.size)
    if (inits.length > room)
    {
      return refuse('queue-full', `The queue holds at most ${core.globals().limits.maxJobs} jobs.`)
    }
    let added: JobId[] = []
    if (inits.length > 0)
    {
      const jobs = core.add(inits, null)
      if (jobs === null)
      {
        return refuse('io-error', 'No catalog number could be reserved. Try again.')
      }
      added = jobs.map((job) => job.id)
      deps.probe(added)
    }
    return ok({ added, missing, holdsOutput: check.holdsOutput })
  }

  async function deleteRuns(req: JobCommandMap['deleteRuns']['req']): Promise<CommandResult<JobCommandMap['deleteRuns']['res']>>
  {
    if (req.runIds !== 'all')
    {
      if (!Array.isArray(req.runIds) || !req.runIds.every(isRunId))
      {
        return refuse('invalid-payload', 'Choose batches from history to delete.', 'runIds')
      }
      const run = core.run()
      const open = run.status === 'idle' ? null : run.runId
      if (open !== null && req.runIds.includes(open))
      {
        return refuse('invalid-state', `${formatRunLabel(open)} is still open. Delete it from history once it ends.`)
      }
    }
    try
    {
      return ok(await history.delete(req.runIds))
    }
    catch (err)
    {
      return refuse('io-error', `History could not be deleted: ${errorText(err)}`)
    }
  }

  async function revealRecord(req: JobCommandMap['revealRecord']['req']): Promise<CommandResult<null>>
  {
    const refused = unknownRun(req.runId)
    if (refused)
    {
      return refused
    }
    if (!isJobId(req.jobId) || !Number.isInteger(req.attempt) || req.attempt < 1 || !REVEAL_TARGETS.includes(req.target))
    {
      return refuse('invalid-payload', 'Choose a file of a job in this batch to show.')
    }
    const records = (await history.readRun(req.runId)).records.filter((record) => record.jobId === req.jobId)
    const record = records.filter((entry) => entry.attempt === req.attempt).pop()
      ?? (req.target === 'log' ? records.filter((entry) => entry.attempts.some((a) => a.attempt === req.attempt)).pop() : undefined)
    if (!record)
    {
      return refuse('not-found', `${req.jobId} has no attempt ${req.attempt} in ${formatRunLabel(req.runId)}.`)
    }
    const path = recordTarget(record, req.attempt, req.target, deps.paths)
    if (path === null)
    {
      return refuse('not-found', `${req.jobId} has no such file to show.`)
    }
    if (await deps.stat(path) === null)
    {
      return refuse('not-found', `The file is no longer at ${path}.`)
    }
    deps.showItemInFolder(path)
    return ok(null)
  }

  async function exportReport(req: JobCommandMap['exportReport']['req'], origin: CommandOrigin = { senderId: null }): Promise<CommandResult<JobCommandMap['exportReport']['res']>>
  {
    if (req.format !== 'csv' && req.format !== 'json')
    {
      return refuse('invalid-payload', 'Export the report as CSV or JSON.', 'format')
    }
    const scope = req.scope
    if (typeof scope !== 'object' || scope === null)
    {
      return refuse('invalid-payload', 'Choose a batch or jobs to report on.', 'scope')
    }
    if ('runId' in scope)
    {
      const refused = unknownRun(scope.runId, 'scope.runId')
      if (refused)
      {
        return refused
      }
    }
    else if (!Array.isArray(scope.ids) || scope.ids.length === 0 || !scope.ids.every(isJobId))
    {
      return refuse('invalid-payload', 'Choose jobs to report on.', 'scope.ids')
    }
    try
    {
      if ('ids' in scope && (await history.reportRows(scope)).length === 0)
      {
        return refuse('not-found', 'None of these jobs has finished yet, so there is nothing to report.')
      }
      const written = await history.exportReport(scope, req.format, {
        lookup: deps.presetLookup(),
        choose: (defaultPath) => deps.chooseSavePath(defaultPath, origin),
        now: deps.now
      })
      return ok(written)
    }
    catch (err)
    {
      return refuse('io-error', `The report could not be saved: ${errorText(err)}`)
    }
  }

  return { listRuns, getRun, searchRuns, rerun, deleteRuns, revealRecord, exportReport }
}
