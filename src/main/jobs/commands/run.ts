/**
 * The run commands: Start of a reviewed report, pause, resume, cancel, the worker and run settings, and the run's
 * alerts. Start runs exactly the reviewed plan, is idempotent per report, and needs the destructive counts repeated.
 */

import type { Ack, CommandError, CommandResult, JobCommandMap } from '../../../shared/jobs/contract'
import type { JobId, RunId } from '../../../shared/jobs/ids'
import type { BatchPolicy, JobPlan, PreflightReport, RunSettings, RunState, RunStatus, WorkersState } from '../../../shared/jobs/types'
import { RUNNING_STATES, type EngineCore } from '../core'
import type { FileStat } from '../deps'
import { workerLimits } from '../dispatch'
import type { Scheduler } from '../scheduler'

/** How many reports the engine keeps for Start. */
export const KEPT_REPORTS = 4

/** How many paths Start stats at once. */
export const START_STAT_CONCURRENCY = 16

/** The reply of a successful Start. */
export type StartResult = JobCommandMap['start']['res']

/** A kept report with the `{date}` value its plans used and its first successful Start. */
export interface StoredReport
{
  report: PreflightReport
  date: string
  started: StartResult | null
}

/** The last reports a preflight produced, newest last. */
export interface ReportStore
{
  /** Keeps a report; the oldest beyond the limit is forgotten. */
  remember(report: PreflightReport, date: string): void
  get(preflightId: string): StoredReport | null
  /** Stores the first successful Start of a kept report. */
  started(preflightId: string, result: StartResult): void
}

/** Builds the store of the last `limit` reports. */
export function createReportStore(limit = KEPT_REPORTS): ReportStore
{
  const reports = new Map<string, StoredReport>()
  return {
    remember(report, date)
    {
      reports.delete(report.preflightId)
      reports.set(report.preflightId, { report, date, started: null })
      while (reports.size > Math.max(1, limit))
      {
        reports.delete(reports.keys().next().value as string)
      }
    },
    get: (preflightId) => reports.get(preflightId) ?? null,
    started(preflightId, result)
    {
      const stored = reports.get(preflightId)
      if (stored !== undefined && stored.started === null)
      {
        stored.started = result
      }
    }
  }
}

/** The `{date}` token's value at a time: the local calendar date. */
export function localDateOf(at: number): string
{
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** What the run commands are built from. */
export interface RunCommandsDeps
{
  core: EngineCore
  scheduler: Pick<Scheduler, 'trigger'>
  reports: ReportStore
  stat(path: string): Promise<FileStat | null>
  /** A new run id; called only when a Start begins a run. */
  nextRunId(): RunId
  /** The persisted default policy a Replace run returns to when it ends. */
  savedPolicy(): Omit<BatchPolicy, 'rev'>
  /** Writes the run settings to the `jobs` config key. */
  persistSettings(settings: RunSettings): Promise<void>
  gpu: { limit(): number; configure(setting: RunSettings['gpuSessions']): void }
  /** Logical cores, for the automatic worker count. */
  cores: number
  showItemInFolder(path: string): void
  keepAwake?(enabled: boolean): void
  quitting?(): boolean
}

/** The run command names. */
export type RunCommandName = 'start' | 'pause' | 'resume' | 'cancelRun' | 'setWorkers' | 'setSettings' | 'dismissAlert' | 'revealAlert'

/** One handler per run command; `dispose` stops the policy reset at run end. */
export type RunCommands =
  { [K in RunCommandName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }
  & { dispose(): void }

type Refused = { ok: false; error: CommandError }

type ReportEntry = PreflightReport['jobs'][number]

function refuse(code: CommandError['code'], message: string, details: CommandError['details'] = null): Refused
{
  return { ok: false, error: { code, message, issues: [], details } }
}

function stale(changed: JobId[]): Refused
{
  return refuse('plan-stale', 'Something changed since this review. Review the batch again before starting.', { changed })
}

function ackMatches(ack: Ack | null, preflightId: string, counts: { originalsAffected: number; overwrites: number }): boolean
{
  if (ack === null)
  {
    return counts.originalsAffected === 0 && counts.overwrites === 0
  }
  return ack.preflightId === preflightId && ack.originalsAffected === counts.originalsAffected && ack.overwrites === counts.overwrites
}

function samePath(a: string, b: string, platform: string): boolean
{
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
}

/** Whether the plan was made with its final path present: an overwrite, a skip, or a replace onto the source. */
function expectsOutput(plan: JobPlan, platform: string): boolean
{
  if (plan.output.renamedTo !== null)
  {
    return false
  }
  return plan.output.conflict === 'exists' || samePath(plan.output.finalPath, plan.source.path, platform)
}

async function pooled<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>
{
  let next = 0
  const worker = async (): Promise<void> =>
  {
    while (next < items.length)
    {
      const item = items[next++] as T
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

/** Builds the run commands over the engine core. */
export function createRunCommands(deps: RunCommandsDeps): RunCommands
{
  const { core } = deps
  const inflight = new Map<string, Promise<CommandResult<StartResult>>>()

  function ok<T>(value: T): CommandResult<T>
  {
    return { ok: true, value, seq: core.bus.flush() }
  }

  /** The date the Start's plans place under: the open run's start date, else today. */
  function startDate(): string
  {
    const run = core.run()
    return localDateOf(run.status !== 'idle' && run.startedAt !== null ? run.startedAt : core.now())
  }

  /** The jobs whose state, inputs, or plan basis no longer match the report. */
  function changedNow(stored: StoredReport): JobId[]
  {
    const { report } = stored
    const g = core.globals()
    const basisChanged = report.policyRev !== g.policy.rev || report.capabilitiesRev !== g.capabilities.rev ||
      (g.policy.template.includes('{date}') && g.policy.destination.mode !== 'replace-originals' && stored.date !== startDate())
    const changed: JobId[] = []
    for (const entry of report.jobs)
    {
      if (entry.status === 'blocked')
      {
        continue
      }
      const job = core.queue.get(entry.jobId)
      if (basisChanged || job === undefined || job === null || job.state !== 'pending' || job.inputsRev !== entry.inputsRev || entry.plan === null)
      {
        changed.push(entry.jobId)
      }
    }
    return changed
  }

  /** The jobs whose source or final path changed on disk since the report. */
  async function changedOnDisk(report: PreflightReport): Promise<JobId[]>
  {
    const platform = core.globals().capabilities.platform
    const changed = new Set<JobId>()
    const checks: Array<{ entry: ReportEntry; plan: JobPlan }> = []
    for (const entry of report.jobs)
    {
      if (entry.status !== 'blocked' && entry.plan !== null)
      {
        checks.push({ entry, plan: entry.plan })
      }
    }
    await pooled(checks, START_STAT_CONCURRENCY, async ({ entry, plan }) =>
    {
      const [source, output] = await Promise.all([deps.stat(plan.source.path).catch(() => null), deps.stat(plan.output.finalPath).catch(() => null)])
      const sourceChanged = source === null || source.size !== plan.source.size || source.mtimeMs !== plan.source.mtimeMs
      if (sourceChanged || (output !== null) !== expectsOutput(plan, platform))
      {
        changed.add(entry.jobId)
      }
    })
    return report.jobs.map((entry) => entry.jobId).filter((id) => changed.has(id))
  }

  function commit(stored: StoredReport, resume: boolean): StartResult | null
  {
    return core.batch(() =>
    {
      const run = core.run()
      const runId = core.startRun(run.status === 'idle' ? deps.nextRunId() : run.runId as RunId)
      if (runId === null)
      {
        return null
      }
      const queued: JobId[] = []
      const skipped: JobId[] = []
      const blocked: JobId[] = []
      for (const entry of stored.report.jobs)
      {
        if (entry.status === 'blocked')
        {
          if (core.queue.get(entry.jobId)?.state === 'pending')
          {
            blocked.push(entry.jobId)
          }
          continue
        }
        const change = { plan: entry.plan, runId }
        const moved = entry.status === 'ready'
          ? core.transition(entry.jobId, ['pending'], 'start', { change })
          : core.transition(entry.jobId, ['pending'], 'output-exists', { change })
        if (moved.applied)
        {
          (entry.status === 'ready' ? queued : skipped).push(entry.jobId)
        }
      }
      if (resume)
      {
        core.resumeRun()
      }
      core.setQuitWhenIdle(false)
      return { runId, queued, skipped, blocked, repeated: false }
    })
  }

  async function startOnce(req: JobCommandMap['start']['req']): Promise<CommandResult<StartResult>>
  {
    const stored = deps.reports.get(req.preflightId)
    if (stored === null)
    {
      return refuse('plan-stale', 'This review is no longer available. Review the batch again before starting.', { changed: [] })
    }
    if (stored.started !== null)
    {
      return ok({ ...stored.started, repeated: true })
    }
    if (deps.quitting?.() === true)
    {
      return refuse('shutting-down', 'molexMedia is quitting, so no new run can start.')
    }
    if (core.run().status === 'canceling')
    {
      return refuse('invalid-state', 'The current run is still canceling. Start again once it has stopped.')
    }
    const { report } = stored
    if (!report.jobs.some((entry) => entry.status !== 'blocked'))
    {
      return refuse('invalid-state', 'Nothing in this review is ready to start.')
    }
    const before = changedNow(stored)
    if (before.length > 0)
    {
      return stale(before)
    }
    const onDisk = await changedOnDisk(report)
    const after = changedNow(stored)
    const changed = report.jobs.map((entry) => entry.jobId).filter((id) => onDisk.includes(id) || after.includes(id))
    if (changed.length > 0)
    {
      return stale(changed)
    }
    if (!ackMatches(req.ack, report.preflightId, report.counts))
    {
      return refuse('confirmation-required', 'Confirm the originals this run replaces and the files it overwrites before starting.', {
        preflightId: report.preflightId,
        originalsAffected: report.counts.originalsAffected,
        overwrites: report.counts.overwrites
      })
    }
    if (core.run().status === 'canceling')
    {
      return refuse('invalid-state', 'The current run is still canceling. Start again once it has stopped.')
    }
    const result = commit(stored, req.resume)
    if (result === null)
    {
      return refuse('invalid-state', 'The run could not start. Review the batch again.')
    }
    deps.reports.started(report.preflightId, result)
    deps.scheduler.trigger('queued')
    return ok(result)
  }

  async function start(req: JobCommandMap['start']['req']): Promise<CommandResult<StartResult>>
  {
    const pending = inflight.get(req.preflightId)
    if (pending !== undefined)
    {
      await pending
      return start(req)
    }
    const attempt = startOnce(req)
    inflight.set(req.preflightId, attempt)
    try
    {
      return await attempt
    }
    finally
    {
      inflight.delete(req.preflightId)
    }
  }

  async function pause(req: JobCommandMap['pause']['req']): Promise<CommandResult<RunState>>
  {
    const status = core.run().status
    if (status !== 'running' && status !== 'pausing')
    {
      return refuse('invalid-state', status === 'paused' ? 'The run is already paused.' : 'There is no running batch to pause.')
    }
    core.pauseRun(req.mode, 'user')
    return ok(core.run())
  }

  async function resume(req: JobCommandMap['resume']['req']): Promise<CommandResult<RunState>>
  {
    const run = core.run()
    if (run.status !== 'paused' && run.status !== 'pausing')
    {
      return refuse('invalid-state', 'There is no paused batch to resume.')
    }
    const acknowledged = run.needsAck !== null
    if (run.needsAck !== null && !ackMatches(req.ack, run.runId ?? '', run.needsAck))
    {
      return refuse('confirmation-required', 'Confirm the originals this restored run replaces before resuming.', {
        preflightId: run.runId ?? '',
        originalsAffected: run.needsAck.originalsAffected,
        overwrites: run.needsAck.overwrites
      })
    }
    core.resumeRun({ acknowledged })
    deps.scheduler.trigger('resume')
    return ok(core.run())
  }

  async function cancelRun(): Promise<CommandResult<{ canceled: number }>>
  {
    const status = core.run().status
    if (status === 'idle')
    {
      return refuse('invalid-state', 'There is no run to cancel.')
    }
    if (status === 'canceling')
    {
      return ok({ canceled: 0 })
    }
    let canceled = 0
    for (const job of core.queue.jobs())
    {
      if (job.state === 'queued' || RUNNING_STATES.includes(job.state))
      {
        canceled += 1
      }
    }
    core.cancelRun()
    return ok({ canceled })
  }

  async function saveSettings(next: RunSettings): Promise<Refused | null>
  {
    try
    {
      await deps.persistSettings(next)
      return null
    }
    catch (err)
    {
      core.log.warn(`Could not save the run settings: ${err instanceof Error ? err.message : String(err)}`)
      return refuse('io-error', 'molexMedia could not save the run settings. Nothing was changed.')
    }
  }

  async function setWorkers(req: JobCommandMap['setWorkers']['req']): Promise<CommandResult<WorkersState>>
  {
    const current = core.globals().settings
    const next: RunSettings = { ...current, workers: req.workers, gpuSessions: req.gpuSessions ?? current.gpuSessions }
    const failed = await saveSettings(next)
    if (failed !== null)
    {
      return failed
    }
    if (req.gpuSessions !== null && JSON.stringify(req.gpuSessions) !== JSON.stringify(current.gpuSessions))
    {
      deps.gpu.configure(req.gpuSessions)
    }
    core.setSettings(next)
    const workers: WorkersState = {
      setting: next.workers,
      limits: workerLimits(next.workers, deps.cores, deps.gpu.limit()),
      active: { ...core.run().workers.active }
    }
    core.setWorkers(workers)
    deps.scheduler.trigger('workers')
    return ok(workers)
  }

  async function setSettings(req: JobCommandMap['setSettings']['req']): Promise<CommandResult<RunSettings>>
  {
    const current = core.globals().settings
    const next: RunSettings = { ...current, ...definedSettings(req.settings) }
    const failed = await saveSettings(next)
    if (failed !== null)
    {
      return failed
    }
    core.setSettings(next)
    if (next.keepAwake !== current.keepAwake)
    {
      deps.keepAwake?.(next.keepAwake)
    }
    return ok(next)
  }

  async function dismissAlert(req: JobCommandMap['dismissAlert']['req']): Promise<CommandResult<null>>
  {
    const alert = core.alerts().find((entry) => entry.id === req.alertId)
    if (alert === undefined)
    {
      return refuse('not-found', 'That notice is no longer shown.')
    }
    if (!alert.dismissible)
    {
      return refuse('invalid-state', 'This notice stays until its cause is resolved.')
    }
    core.clearAlert(alert.id)
    return ok(null)
  }

  async function revealAlert(req: JobCommandMap['revealAlert']['req']): Promise<CommandResult<null>>
  {
    const alert = core.alerts().find((entry) => entry.id === req.alertId)
    if (alert === undefined)
    {
      return refuse('not-found', 'That notice is no longer shown.')
    }
    if (alert.path === null)
    {
      return refuse('invalid-state', 'This notice has no file or folder to show.')
    }
    deps.showItemInFolder(alert.path)
    return ok(null)
  }

  let lastStatus: RunStatus = core.run().status
  const unsubscribe = core.onRunState((run) =>
  {
    const before = lastStatus
    lastStatus = run.status
    if (run.status !== 'idle' || before === 'idle')
    {
      return
    }
    const policy = core.globals().policy
    if (policy.destination.mode !== 'replace-originals')
    {
      return
    }
    const saved = deps.savedPolicy()
    if (saved.destination.mode === 'replace-originals')
    {
      core.log.warn('The saved default policy replaces originals, so the queue policy was left as it is')
      return
    }
    core.setPolicy({ ...saved, rev: policy.rev + 1 })
  })

  return {
    start,
    pause,
    resume,
    cancelRun,
    setWorkers,
    setSettings,
    dismissAlert,
    revealAlert,
    dispose: unsubscribe
  }
}

function definedSettings(partial: JobCommandMap['setSettings']['req']['settings']): Partial<RunSettings>
{
  const out: Partial<RunSettings> = {}
  for (const [key, value] of Object.entries(partial))
  {
    if (value !== undefined)
    {
      (out as Record<string, unknown>)[key] = value
    }
  }
  return out
}
