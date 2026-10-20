/**
 * The per-job commands of a run: cancel, skip, unqueue, retry, the decisions on a held output, acknowledge, clear,
 * and the attempt log and reveal targets. Every command answers each job by the shared applicability matrix and
 * changes engine state only through the core.
 */

import type { Ack, CommandError, CommandResult, JobCommandMap, JobRefusal, JobRefusalCode, PerJob } from '../../../shared/jobs/contract'
import { describeRecipe } from '../../../shared/jobs/describe'
import type { JobId, RunId } from '../../../shared/jobs/ids'
import { commandApplicability, commandInstead, needsAttention, type MatrixCommand } from '../../../shared/jobs/states'
import type { AttemptRecord, HistoryRecord, HistoryRef, Job, JobPlan, JobState, Placement, PreflightReport } from '../../../shared/jobs/types'
import { RUNNING_STATES, type EngineCore } from '../core'
import { buildHistoryRecord } from '../history'
import { attemptLogMode, attemptLogPath, COMMAND_PREFIX, type AttemptOutcome, type AttemptRing } from '../log'
import type { JobChange, RemovedJob } from '../queue'
import type { SchedulerAlbums, Scheduler } from '../scheduler'

/** How many retry confirmations the engine keeps for a repeated retry. */
export const KEPT_RETRY_CONFIRMATIONS = 4

/** What the job commands are built from. */
export interface JobCommandsDeps
{
  core: EngineCore
  scheduler: Pick<Scheduler, 'trigger'>
  albums: Pick<SchedulerAlbums, 'memberLeft'>
  /**
   * The internal preflight of a retry over exactly these jobs, with their current settings and the current policy.
   * `existing` names each job's placed output that counts as an existing file under the conflict rule.
   */
  preflight(jobs: ReadonlyArray<Readonly<Job>>, options: { existing: ReadonlyMap<JobId, string> }): Promise<PreflightReport>
  /** The bin check of the files these plans displace; an error refuses the command. */
  binCheck?(plans: readonly JobPlan[]): Promise<CommandError | null>
  /** Hands a held job's work folder to the registry, which deletes it and retries while a file in it is open. */
  releaseWorkDir(jobId: JobId, workDir: string): Promise<void> | void
  /** A new run id; called only when a retry starts a run. */
  nextRunId(): RunId
  /** Where decisions on held jobs of a completed run are recorded. */
  history?: { recordDecision(record: HistoryRecord): Promise<HistoryRef> }
  /** Runs the placement of a held output once it moved to finalizing (T26). */
  place(jobId: JobId, placement: 'planned' | 'renamed'): void
  /** Keeps cleared jobs for `jobs:restore`. */
  tombstones: { record(kind: 'clear', entries: readonly RemovedJob[]): string | null }
  /** The output of the job's current attempt while it is still in memory. */
  ring?(jobId: JobId): AttemptRing | null
  /** An attempt log file's text; null when it cannot be read. */
  readLog(path: string): Promise<string | null>
  /** Whether a file or folder exists, for reveal. */
  exists(path: string): Promise<boolean>
  showItemInFolder(path: string): void
  /** The folder that holds `<RunId>/<JobId>-a<n>.log`. */
  logsDir: string
  quitting?(): boolean
}

/** The job command names. */
export type JobCommandsName = 'cancel' | 'skip' | 'unqueue' | 'retry' | 'keepOutput' | 'discardOutput' | 'acknowledge' | 'clear' | 'log' | 'reveal'

/** The reply of a retry. */
export type RetryResult = JobCommandMap['retry']['res']

/** One handler per job command. */
export type JobCommands =
  { [K in JobCommandsName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }

type Refused = { ok: false; error: CommandError }

const INSTEAD_TEXT: Readonly<Partial<Record<MatrixCommand, string>>> =
{
  duplicate: 'Use Duplicate instead.',
  retry: 'Use Retry instead.',
  discardOutput: 'Use Discard output instead.'
}

/** The page's words for a refusal of one of these commands. */
export function jobRefusalMessage(code: JobRefusalCode, id: JobId): string
{
  switch (code)
  {
    case 'not-found':
      return `${id} is not in the queue.`
    case 'job-running':
      return `${id} is running.`
    case 'job-finalizing':
      return `${id} is placing its output and finishes in a moment.`
    case 'job-held':
    case 'needs-decision':
      return `${id} is waiting for a decision on its output: keep it, discard it, or retry.`
    case 'job-terminal':
      return `${id} has finished.`
    case 'not-started':
      return `${id} has not started. Remove it from the queue instead.`
    case 'not-queued':
      return `${id} is not queued.`
    case 'not-held':
      return `${id} has no output waiting for a decision.`
    case 'not-retryable':
      return `${id} cannot be retried in its current state.`
    case 'needs-attention':
      return `${id} needs attention. Acknowledge it first.`
    case 'blocked':
      return `${id} cannot do that with its held output.`
    default:
      return `${id} cannot be changed in its current state.`
  }
}

function refuse(code: CommandError['code'], message: string, details: CommandError['details'] = null): Refused
{
  return { ok: false, error: { code, message, issues: [], details } }
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** Whether a done job's output was placed outside tolerance, the one done job a retry accepts. */
export function placedOutside(job: Pick<Job, 'warnings'>): boolean
{
  return job.warnings.some((warning) => warning.code === 'outside-tolerance-placed')
}

/** The jobs `'failed'` names: failed and interrupted jobs, and done jobs placed outside tolerance, in queue order. */
export function failedTargets(jobs: Iterable<Readonly<Job>>): JobId[]
{
  const out: JobId[] = []
  for (const job of jobs)
  {
    if (job.state === 'failed' || job.state === 'interrupted' || (job.state === 'done' && placedOutside(job)))
    {
      out.push(job.id)
    }
  }
  return out
}

/** The record of the attempt a retry ends; a held attempt ends with its output discarded. */
export function attemptRecord(job: Readonly<Job>, at: number): AttemptRecord
{
  return {
    attempt: job.attempt,
    runId: job.runId,
    recipe: job.recipe,
    state: job.state === 'held' ? 'canceled' : job.state as AttemptRecord['state'],
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? at,
    verdict: job.verification?.verdict ?? null,
    errorCode: job.error?.code ?? null
  }
}

/** The originals the plans replace and the files they overwrite. */
export function destructiveCounts(plans: readonly JobPlan[]): Pick<Ack, 'originalsAffected' | 'overwrites'>
{
  let originalsAffected = 0
  let overwrites = 0
  for (const plan of plans)
  {
    if (plan.output.resolution === 'replace-original')
    {
      originalsAffected += 1
    }
    else if (plan.output.resolution === 'overwrite')
    {
      overwrites += 1
    }
  }
  return { originalsAffected, overwrites }
}

/** How a kept output is placed: the plan's placement, or a free name when `renamed`. */
export function keepMode(job: Readonly<Job>, placement: 'planned' | 'renamed'): Placement['kind']
{
  if (placement === 'renamed')
  {
    return 'renamed'
  }
  if (job.plan?.output.resolution === 'replace-original')
  {
    return 'replaced-original'
  }
  if (job.hold?.displaces !== null && job.hold?.displaces !== undefined)
  {
    return 'overwrote'
  }
  return job.plan?.output.resolution === 'rename' ? 'renamed' : 'new'
}

const ENDED_STATES: readonly JobState[] = ['done', 'failed', 'canceled', 'skipped', 'interrupted']

/** Whether `jobs:clear` covers a job under a scope by its state; attention and the remove rules are checked apart. */
export function clearCovers(scope: JobCommandMap['clear']['req']['scope'], job: Readonly<Job>): boolean
{
  switch (scope.kind)
  {
    case 'done':
      return job.state === 'done'
    case 'finished':
      return ENDED_STATES.includes(job.state) || job.state === 'held'
    default:
      return scope.ids.includes(job.id)
  }
}

/** How an attempt ended, for the log mode it was written in; null while it has not ended. */
export function attemptOutcome(state: JobState | AttemptRecord['state'], verdict: AttemptRecord['verdict']): AttemptOutcome | null
{
  switch (state)
  {
    case 'done':
      return verdict === 'outside-tolerance' ? 'outside-tolerance' : 'verified'
    case 'failed':
    case 'held':
    case 'interrupted':
    case 'canceled':
    case 'skipped':
      return state
    default:
      return null
  }
}

const OMISSION = /^\[\d+ lines? \(\d+ bytes\) of output omitted\]$/

/** An attempt log's lines, and whether output was dropped: an omission marker, or a tail cut before the first command. */
export function logLines(text: string, outcome: AttemptOutcome | null): { lines: string[]; truncated: boolean }
{
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '')
  {
    lines.pop()
  }
  const cut = outcome !== null && attemptLogMode(outcome) === 'tail' && lines.length > 0 && !(lines[0] as string).startsWith(COMMAND_PREFIX)
  return { lines, truncated: cut || lines.some((line) => OMISSION.test(line)) }
}

type RetryKind = 'queue' | 'blocked' | 'changed'

interface RetryDecision
{
  job: Readonly<Job>
  kind: RetryKind
  plan: JobPlan | null
}

/** How a retry treats a job by its new plan, compared with the plan of the attempt it retries. */
export function retryKind(job: Readonly<Job>, entry: PreflightReport['jobs'][number] | undefined): RetryKind
{
  if (entry === undefined || entry.status === 'blocked' || entry.plan === null)
  {
    return 'blocked'
  }
  if (entry.status !== 'ready' || entry.inputsRev !== job.inputsRev || job.plan === null || entry.plan.fingerprint !== job.plan.fingerprint)
  {
    return 'changed'
  }
  return 'queue'
}

/** Builds the job commands over the engine core. */
export function createJobCommands(deps: JobCommandsDeps): JobCommands
{
  const { core } = deps

  function ok<T>(value: T): CommandResult<T>
  {
    return { ok: true, value, seq: core.bus.flush() }
  }

  function refusal(command: MatrixCommand, id: JobId, code: JobRefusalCode, job: Readonly<Job> | null): JobRefusal
  {
    const instead = job === null ? null : commandInstead(command, job)
    const hint = instead === null ? undefined : INSTEAD_TEXT[instead]
    const message = jobRefusalMessage(code, id)
    return { jobId: id, code, message: hint === undefined ? message : `${message} ${hint}` }
  }

  /** Each listed job once, in the order given, with the matrix's answer for it. */
  function answers(command: MatrixCommand, ids: readonly JobId[], refused: JobRefusal[]): Array<{ job: Readonly<Job>; answer: 'ok' | 'no-op' }>
  {
    const out: Array<{ job: Readonly<Job>; answer: 'ok' | 'no-op' }> = []
    const seen = new Set<JobId>()
    for (const id of ids)
    {
      if (seen.has(id))
      {
        continue
      }
      seen.add(id)
      const job = core.queue.get(id) ?? null
      if (job === null)
      {
        refused.push(refusal(command, id, 'not-found', null))
        continue
      }
      const answer = commandApplicability(command, job)
      if (answer === 'ok' || answer === 'no-op')
      {
        out.push({ job, answer })
      }
      else
      {
        refused.push(refusal(command, id, answer, job))
      }
    }
    return out
  }

  /** Cancel or skip: a queued job at once (T8, T7), a running job once its child exits (T14, T15). */
  function stop(intent: 'cancel' | 'skip', ids: readonly JobId[]): CommandResult<PerJob>
  {
    const refused: JobRefusal[] = []
    const applied: JobId[] = []
    let left = false
    core.batch(() =>
    {
      for (const { job } of answers(intent, ids, refused))
      {
        if (job.state === 'queued')
        {
          if (core.transition(job.id, ['queued'], intent, { reason: 'user' }).applied)
          {
            deps.albums.memberLeft(job.id)
            applied.push(job.id)
            left = true
          }
        }
        else if (RUNNING_STATES.includes(job.state) && core.recordAbort(job.id, intent, 'user'))
        {
          applied.push(job.id)
        }
      }
    })
    if (left)
    {
      deps.scheduler.trigger('left-active')
    }
    return ok({ applied, refused })
  }

  async function cancel(req: JobCommandMap['cancel']['req']): Promise<CommandResult<PerJob>>
  {
    return stop('cancel', req.ids)
  }

  async function skip(req: JobCommandMap['skip']['req']): Promise<CommandResult<PerJob>>
  {
    return stop('skip', req.ids)
  }

  async function unqueue(req: JobCommandMap['unqueue']['req']): Promise<CommandResult<PerJob>>
  {
    const refused: JobRefusal[] = []
    const applied: JobId[] = []
    core.batch(() =>
    {
      for (const { job } of answers('unqueue', req.ids, refused))
      {
        if (core.transition(job.id, ['queued'], 'unqueue', { reason: 'user' }).applied)
        {
          deps.albums.memberLeft(job.id)
          applied.push(job.id)
        }
      }
    })
    if (applied.length > 0)
    {
      deps.scheduler.trigger('left-active')
    }
    return ok({ applied, refused })
  }

  const confirmations = new Map<string, string>()

  function rememberConfirmation(preflightId: string, key: string): void
  {
    confirmations.delete(preflightId)
    confirmations.set(preflightId, key)
    while (confirmations.size > KEPT_RETRY_CONFIRMATIONS)
    {
      confirmations.delete(confirmations.keys().next().value as string)
    }
  }

  /** The open run's id while it runs or is paused, so a decision on a job of another run is recorded on its own. */
  function openRunId(): RunId | null
  {
    const run = core.run()
    return run.status === 'idle' ? null : run.runId
  }

  /** Records a decision on a held job whose run has completed; the job's own record moves to it when `adopt` is set. */
  function recordDecision(job: Readonly<Job>, adopt: boolean): void
  {
    const history = deps.history
    if (history === undefined || job.runId === null || job.runId === openRunId())
    {
      return
    }
    let record: HistoryRecord
    try
    {
      record = buildHistoryRecord(job as Job, {
        recipeLabel: describeRecipe(job.recipe),
        logFile: attemptLogPath(deps.logsDir, job.runId, job.id, job.attempt),
        endedAt: job.endedAt ?? core.now()
      })
    }
    catch (err)
    {
      core.log.warn(`Could not record the decision on ${job.id}: ${errorText(err)}`)
      return
    }
    history.recordDecision(record).then((ref) =>
    {
      const now = core.queue.get(job.id)
      if (adopt && now !== undefined && now !== null && now.attempt === job.attempt && now.state === job.state)
      {
        core.update(job.id, { history: ref })
      }
    }, (err: unknown) =>
    {
      core.log.warn(`Could not record the decision on ${job.id}: ${errorText(err)}`)
    })
  }

  /** Hands a held work folder to the registry without waiting for its deletion. */
  function releaseWorkDir(job: Readonly<Job>): void
  {
    if (job.workDir === null)
    {
      return
    }
    try
    {
      Promise.resolve(deps.releaseWorkDir(job.id, job.workDir)).catch((err: unknown) =>
      {
        core.log.warn(`The work folder of ${job.id} is not deleted yet: ${errorText(err)}`)
      })
    }
    catch (err)
    {
      core.log.warn(`The work folder of ${job.id} is not deleted yet: ${errorText(err)}`)
    }
  }

  function decide(targets: ReadonlyArray<Readonly<Job>>, report: PreflightReport, refused: JobRefusal[]): RetryDecision[]
  {
    const entries = new Map(report.jobs.map((entry) => [entry.jobId, entry]))
    const out: RetryDecision[] = []
    for (const target of targets)
    {
      const job = core.queue.get(target.id) ?? null
      if (job === null)
      {
        refused.push(refusal('retry', target.id, 'not-found', null))
        continue
      }
      const answer = commandApplicability('retry', job)
      if (answer !== 'ok')
      {
        refused.push(refusal('retry', job.id, answer === 'no-op' ? 'not-retryable' : answer, job))
        continue
      }
      const entry = entries.get(job.id)
      out.push({ job, kind: retryKind(job, entry), plan: entry?.plan ?? null })
    }
    return out
  }

  function commitRetry(decisions: readonly RetryDecision[], start: boolean, refused: JobRefusal[]): RetryResult | null
  {
    return core.batch(() =>
    {
      const queued: JobId[] = []
      const pending: JobId[] = []
      const changed: JobId[] = []
      const run = core.run()
      let runId: RunId | null = null
      if (decisions.some((decision) => decision.kind === 'queue') && (start || run.status !== 'idle'))
      {
        runId = core.startRun(run.status === 'idle' ? deps.nextRunId() : run.runId as RunId)
        if (runId === null)
        {
          return null
        }
      }
      const at = core.now()
      for (const { job: live, kind, plan } of decisions)
      {
        const job: Readonly<Job> = { ...live }
        const held = job.state === 'held'
        const change: JobChange = { plan, attempts: [...job.attempts, attemptRecord(job, at)] }
        if (held)
        {
          change.workDir = null
        }
        let moved
        if (kind === 'queue' && runId !== null)
        {
          moved = core.transition(job.id, [job.state], 'retry', { change: { ...change, runId } })
        }
        else if (kind === 'queue' && held)
        {
          refused.push({ jobId: job.id, code: 'blocked', message: `${job.id} keeps its held output until a run starts. Retry it with a run.` })
          continue
        }
        else if (kind === 'queue')
        {
          moved = core.transition(job.id, [job.state], 'edit-retry', { reason: 'user', change: { ...change, runId: null } })
        }
        else
        {
          moved = core.transition(job.id, [job.state], 'retry-changed', { reason: kind === 'blocked' ? 'plan-blocked' : 'plan-changed', change: { ...change, runId: null } })
        }
        if (!moved.applied)
        {
          refused.push(refusal('retry', job.id, 'not-retryable', core.queue.get(job.id) ?? null))
          continue
        }
        if (moved.job.state === 'queued')
        {
          queued.push(job.id)
        }
        else
        {
          pending.push(job.id)
          if (kind === 'changed')
          {
            changed.push(job.id)
          }
        }
        if (held)
        {
          releaseWorkDir(job)
          recordDecision({ ...job, state: 'canceled', reason: 'output-discarded', hold: null, endedAt: at }, false)
        }
      }
      if (queued.length > 0)
      {
        core.setQuitWhenIdle(false)
      }
      return { applied: [...queued, ...pending], refused, queued, pending, changed, runId: queued.length > 0 ? runId : null }
    })
  }

  /** Retry with new settings: every job waits for Review with them (T30, or T28 to pending for a held job). */
  function editRetry(targets: ReadonlyArray<Readonly<Job>>, recipe: NonNullable<JobCommandMap['retry']['req']['recipe']>, refused: JobRefusal[]): RetryResult
  {
    return core.batch(() =>
    {
      const pending: JobId[] = []
      const at = core.now()
      for (const live of targets)
      {
        const job: Readonly<Job> = { ...live }
        const held = job.state === 'held'
        const change: JobChange = { plan: null, runId: null, attempts: [...job.attempts, attemptRecord(job, at)] }
        if (held)
        {
          change.workDir = null
        }
        const moved = held
          ? core.transition(job.id, ['held'], 'retry-changed', { reason: 'plan-changed', change })
          : core.transition(job.id, [job.state], 'edit-retry', { reason: 'user', change })
        if (!moved.applied)
        {
          refused.push(refusal('retry', job.id, 'not-retryable', core.queue.get(job.id) ?? null))
          continue
        }
        core.update(job.id, { recipe }, { inputs: true })
        pending.push(job.id)
        if (held)
        {
          releaseWorkDir(job)
          recordDecision({ ...job, state: 'canceled', reason: 'output-discarded', hold: null, endedAt: at }, false)
        }
      }
      return { applied: pending, refused, queued: [], pending, changed: [], runId: null }
    })
  }

  async function retry(req: JobCommandMap['retry']['req']): Promise<CommandResult<RetryResult>>
  {
    if (deps.quitting?.() === true)
    {
      return refuse('shutting-down', 'molexMedia is quitting, so nothing can be retried now.')
    }
    const refused: JobRefusal[] = []
    const ids = req.ids === 'failed' ? failedTargets(core.queue.jobs()) : req.ids
    const targets = answers('retry', ids, refused).map(({ job }) => job)
    if (targets.length === 0)
    {
      return ok({ applied: [], refused, queued: [], pending: [], changed: [], runId: null })
    }
    if (req.recipe !== null)
    {
      return ok(editRetry(targets, req.recipe, refused))
    }
    if (core.run().status === 'canceling')
    {
      return refuse('invalid-state', 'The current run is still canceling. Retry once it has stopped.')
    }
    const existing = new Map<JobId, string>()
    for (const job of targets)
    {
      if (job.state === 'done' && job.result !== null)
      {
        existing.set(job.id, job.result.outputPath)
      }
    }
    let report: PreflightReport
    try
    {
      report = await deps.preflight(targets, { existing })
    }
    catch (err)
    {
      core.log.warn(`The retry review failed: ${errorText(err)}`)
      return refuse('internal', 'molexMedia could not review the jobs to retry. Nothing was changed.')
    }
    const decisions = decide(targets, report, refused)
    const runs = decisions.filter((decision) => decision.kind === 'queue')
    const plans = runs.map((decision) => decision.plan as JobPlan)
    const counts = destructiveCounts(plans)
    if (counts.originalsAffected > 0 || counts.overwrites > 0)
    {
      const key = runs.map((decision) => decision.job.id).join(',')
      const ack = req.ack
      const confirmed = ack !== null && confirmations.get(ack.preflightId) === key &&
        ack.originalsAffected === counts.originalsAffected && ack.overwrites === counts.overwrites
      if (!confirmed)
      {
        rememberConfirmation(report.preflightId, key)
        return refuse('confirmation-required', 'Confirm the originals this retry replaces and the files it overwrites before retrying.', {
          preflightId: report.preflightId,
          originalsAffected: counts.originalsAffected,
          overwrites: counts.overwrites
        })
      }
      const bin = await deps.binCheck?.(plans.filter((plan) => plan.output.resolution !== 'place' && plan.output.resolution !== 'rename')) ?? null
      if (bin !== null)
      {
        return { ok: false, error: bin }
      }
    }
    if (core.run().status === 'canceling')
    {
      return refuse('invalid-state', 'The current run is still canceling. Retry once it has stopped.')
    }
    const result = commitRetry(decisions, req.start, refused)
    if (result === null)
    {
      return refuse('invalid-state', 'The run could not start. Retry again.')
    }
    if (result.queued.length > 0)
    {
      deps.scheduler.trigger('queued')
    }
    return ok(result)
  }

  async function keepOutput(req: JobCommandMap['keepOutput']['req']): Promise<CommandResult<PerJob>>
  {
    const refused: JobRefusal[] = []
    const action = req.placement === 'planned' ? 'keep' : 'keep-renamed'
    const keeps: Array<Readonly<Job>> = []
    for (const { job } of answers('keepOutput', req.ids, refused))
    {
      if (job.hold?.actions.includes(action) === true)
      {
        keeps.push(job)
      }
      else
      {
        refused.push({ jobId: job.id, code: 'blocked', message: `${job.id} cannot keep its held output ${req.placement === 'planned' ? 'where it was going' : 'under a free name'}.` })
      }
    }
    const displacing = req.placement === 'planned' ? keeps.filter((job) => job.hold?.displaces !== null) : []
    if (displacing.length > 0)
    {
      if (req.confirm?.displaces !== displacing.length)
      {
        const originalsAffected = displacing.filter((job) => job.plan?.output.resolution === 'replace-original').length
        return refuse('confirmation-required', `Confirm the ${displacing.length === 1 ? 'file' : `${displacing.length} files`} this replaces before keeping the output.`, {
          preflightId: '',
          originalsAffected,
          overwrites: displacing.length - originalsAffected
        })
      }
      const plans = displacing.flatMap((job) => job.plan === null ? [] : [job.plan])
      const bin = await deps.binCheck?.(plans) ?? null
      if (bin !== null)
      {
        return { ok: false, error: bin }
      }
    }
    const applied: JobId[] = []
    core.batch(() =>
    {
      for (const job of keeps)
      {
        const begin = { verdict: job.verification?.verdict ?? null, mode: keepMode(job, req.placement) }
        if (core.transition(job.id, ['held'], 'keep', { reason: 'user', change: { acknowledged: true }, begin }).applied)
        {
          applied.push(job.id)
        }
        else
        {
          refused.push(refusal('keepOutput', job.id, 'not-held', core.queue.get(job.id) ?? null))
        }
      }
    })
    for (const id of applied)
    {
      deps.place(id, req.placement)
    }
    return ok({ applied, refused })
  }

  async function discardOutput(req: JobCommandMap['discardOutput']['req']): Promise<CommandResult<PerJob>>
  {
    const refused: JobRefusal[] = []
    const applied: JobId[] = []
    core.batch(() =>
    {
      for (const { job: live } of answers('discardOutput', req.ids, refused))
      {
        const job: Readonly<Job> = { ...live }
        const moved = core.transition(job.id, ['held'], 'discard', { reason: 'output-discarded', change: { acknowledged: true, workDir: null } })
        if (!moved.applied)
        {
          continue
        }
        applied.push(job.id)
        releaseWorkDir(job)
        recordDecision({ ...moved.job }, true)
      }
    })
    return ok({ applied, refused })
  }

  async function clear(req: JobCommandMap['clear']['req']): Promise<CommandResult<JobCommandMap['clear']['res']>>
  {
    let kept = 0
    const ids: JobId[] = []
    for (const job of core.queue.jobs())
    {
      if (!clearCovers(req.scope, job))
      {
        continue
      }
      if (needsAttention(job))
      {
        kept += 1
      }
      else if (commandApplicability('remove', job) === 'ok')
      {
        ids.push(job.id)
      }
    }
    const waiting = new Set(ids.filter((id) => core.queue.get(id)?.state === 'queued'))
    const removed = core.batch(() => core.remove(ids))
    for (const entry of removed)
    {
      if (waiting.has(entry.job.id))
      {
        deps.albums.memberLeft(entry.job.id)
      }
    }
    const tombstone = removed.length > 0 ? deps.tombstones.record('clear', removed) : null
    return ok({ removed: removed.length, kept, tombstone })
  }

  async function log(req: JobCommandMap['log']['req']): Promise<CommandResult<JobCommandMap['log']['res']>>
  {
    const job = core.queue.get(req.jobId) ?? null
    if (job === null)
    {
      return refuse('not-found', jobRefusalMessage('not-found', req.jobId))
    }
    const attempt = req.attempt ?? job.attempt
    const earlier = job.attempts.find((entry) => entry.attempt === attempt)
    if (attempt !== job.attempt && earlier === undefined)
    {
      return refuse('not-found', `${job.id} has no attempt ${attempt}.`)
    }
    if (attempt === job.attempt)
    {
      const ring = deps.ring?.(job.id) ?? null
      if (ring !== null && ring.bytes > 0)
      {
        return ok({ ...logLines(ring.text(), null), truncated: ring.omitted.lines > 0, file: null })
      }
    }
    const runId = earlier === undefined ? job.runId : earlier.runId
    const outcome = earlier === undefined ? attemptOutcome(job.state, job.verification?.verdict ?? null) : attemptOutcome(earlier.state, earlier.verdict)
    if (runId === null || outcome === null)
    {
      return ok({ lines: [], truncated: false, file: null })
    }
    const file = attemptLogPath(deps.logsDir, runId, job.id, attempt)
    const text = await deps.readLog(file).catch(() => null)
    if (text === null)
    {
      return ok({ lines: [], truncated: false, file: null })
    }
    return ok({ ...logLines(text, outcome), file })
  }

  /** The path a reveal target names, from the job record only. */
  function revealPath(job: Readonly<Job>, target: JobCommandMap['reveal']['req']['target']): string | null
  {
    switch (target)
    {
      case 'source':
        return job.source.path
      case 'output':
        return job.result?.outputPath ?? null
      case 'held-output':
        return job.hold?.outputPath ?? null
      case 'kept-original':
      {
        const placement = job.result?.placement
        if (placement?.kind === 'replaced-original' && placement.original.status === 'kept')
        {
          return placement.original.path
        }
        if (placement?.kind === 'overwrote' && placement.previous.status === 'kept')
        {
          return placement.previous.path
        }
        return null
      }
      default:
        return job.runId === null ? null : attemptLogPath(deps.logsDir, job.runId, job.id, job.attempt)
    }
  }

  async function reveal(req: JobCommandMap['reveal']['req']): Promise<CommandResult<null>>
  {
    const job = core.queue.get(req.jobId) ?? null
    if (job === null)
    {
      return refuse('not-found', jobRefusalMessage('not-found', req.jobId))
    }
    const path = revealPath(job, req.target)
    if (path === null)
    {
      return refuse('not-found', `${job.id} has no such file to show.`)
    }
    if (!await deps.exists(path).catch(() => false))
    {
      return refuse('not-found', `That file of ${job.id} is no longer there.`)
    }
    deps.showItemInFolder(path)
    return ok(null)
  }

  async function acknowledge(req: JobCommandMap['acknowledge']['req']): Promise<CommandResult<PerJob>>
  {
    const refused: JobRefusal[] = []
    const applied: JobId[] = []
    for (const { job, answer } of answers('acknowledge', req.ids, refused))
    {
      if (answer === 'ok' && core.update(job.id, { acknowledged: true }) !== null)
      {
        applied.push(job.id)
      }
    }
    return ok({ applied, refused })
  }

  return {
    cancel,
    skip,
    unqueue,
    retry,
    keepOutput,
    discardOutput,
    acknowledge,
    clear,
    log,
    reveal
  }
}
