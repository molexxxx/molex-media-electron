/**
 * The planning commands: the batch policy, the default recipe, the preflight that plans jobs and writes each row's
 * plan summary, and the analysis requests the Review step measures with. A preflight snapshots its inputs, plans
 * without holding the engine, and commits through a short step that checks each job's inputs again, so short commands
 * never wait behind it. Measurements are never plan inputs.
 */

import type { CommandError, CommandResult, JobCommandMap, JobRefusal, PerJob } from '../../../shared/jobs/contract'
import type { JobId } from '../../../shared/jobs/ids'
import type { Recipe } from '../../../shared/jobs/recipes'
import {
  ACTIVE_STATES, TERMINAL_STATES, type BatchPolicy, type Job, type JobPlan, type JobState, type OutputPlan, type PlanSummary,
  type PreflightReport, type SourceRef
} from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import type { AnalysisTasks } from '../analysis'
import { basicPlanSummary, planIsCurrent, type EngineCore } from '../core'
import type { FileStat, JobLogger, PlannerIO } from '../deps'
import {
  planPreflight, type AlbumGroup, type OtherJob, type PlanJob, type PlannerCapabilities, type PlannerDeps, type PreflightInput,
  type PreflightResult, type ProbeOutcome, type RunnerSet
} from '../planner'
import { canonicalJson } from '../queue'
import type { JobRunner, PlanInput, RunnerPlan } from '../runners/types'
import type { Scheduler } from '../scheduler'
import { volumeRoot } from '../volumes'
import { localDateOf, type ReportStore } from './run'

/** How many sources one volume's re-stat runs at once. */
export const PREFLIGHT_STAT_CONCURRENCY = 16

/** The recipe kinds an analysis request measures. */
export const ANALYZABLE_KINDS: ReadonlyArray<Recipe['kind']> = ['normalize', 'boost']

/** Thrown inside a preflight that a newer request replaced, so it stops at its next job or read. */
class Superseded extends Error
{
  constructor()
  {
    super('superseded')
  }
}

const DESTRUCTIVE_RANK: Readonly<Record<OutputPlan['resolution'], number>> =
  { place: 0, skip: 0, rename: 0, overwrite: 1, 'replace-original': 2 }

/** The plan commands' names. */
export type PlanCommandName = 'setPolicy' | 'setDefaultRecipe' | 'preflight' | 'analyze' | 'cancelAnalyze'

type Refused = { ok: false; error: CommandError }

/** The plan a row last showed, and the one before it, so a row update can tell them apart. */
const KEPT_SUMMARIES = 2

/** The rows' plan summaries as the planner built them, the core's `planSummary` view builder. */
export interface PlanSummaries
{
  /** Keeps the summary the planner built for a job's plan. */
  remember(jobId: JobId, plan: JobPlan, summary: PlanSummary): void
  /** The latest summary kept for a job, or null. */
  get(jobId: JobId): PlanSummary | null
  forget(jobId: JobId): void
  /** The Review columns of a job's plan: the planner's summary for that plan, else the plan's own columns. */
  planSummary(plan: JobPlan, current: boolean, job: Readonly<Job>): PlanSummary
}

function planKey(plan: JobPlan): string
{
  const { basis, output } = plan
  return `${basis.inputsRev}:${basis.policyRev}:${basis.capabilitiesRev}:${plan.fingerprint}:${output.finalPath}:${output.renamedTo ?? ''}`
}

/** Builds the store of planner summaries the rows read through the core's view builder. */
export function createPlanSummaries(): PlanSummaries
{
  const kept = new Map<JobId, Array<{ key: string; summary: PlanSummary }>>()
  return {
    remember(jobId, plan, summary)
    {
      const key = planKey(plan)
      const list = (kept.get(jobId) ?? []).filter((entry) => entry.key !== key)
      list.unshift({ key, summary })
      kept.set(jobId, list.slice(0, KEPT_SUMMARIES))
    },
    get: (jobId) => kept.get(jobId)?.[0]?.summary ?? null,
    forget(jobId)
    {
      kept.delete(jobId)
    },
    planSummary(plan, current, job)
    {
      const key = planKey(plan)
      const found = kept.get(job.id)?.find((entry) => entry.key === key)
      return found === undefined ? basicPlanSummary(plan, current) : { ...found.summary, current }
    }
  }
}

function refuse(code: CommandError['code'], message: string): Refused
{
  return { ok: false, error: { code, message, issues: [], details: null } }
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** Whether two policies differ in anything but their revision. */
function samePolicy(a: Omit<BatchPolicy, 'rev'>, b: Omit<BatchPolicy, 'rev'>): boolean
{
  const strip = ({ destination, template, conflict, displaced, gpu }: Omit<BatchPolicy, 'rev'>): Omit<BatchPolicy, 'rev'> =>
    ({ destination, template, conflict, displaced, gpu })
  return canonicalJson(strip(a)) === canonicalJson(strip(b))
}

function isActive(state: JobState): boolean
{
  return ACTIVE_STATES.includes(state)
}

function isTerminal(state: JobState): boolean
{
  return TERMINAL_STATES.includes(state)
}

/** Whether a new plan displaces more than the one it replaces: an overwrite or a replaced original it did not have. */
export function moreDestructive(before: JobPlan | null, next: JobPlan): boolean
{
  const rank = (plan: JobPlan | null): number => (plan === null ? 0 : DESTRUCTIVE_RANK[plan.output.resolution])
  return rank(next) > rank(before)
}

/** The final path a queued, active, or held job's plan reserves; null when it places nothing. */
function reservedPath(job: Readonly<Job>): string | null
{
  const { plan } = job
  if (plan === null || plan.output.resolution === 'skip' || !(job.state === 'queued' || job.state === 'held' || isActive(job.state)))
  {
    return null
  }
  return plan.output.renamedTo ?? plan.output.finalPath
}

async function pooled<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>
{
  let next = 0
  const worker = async (): Promise<void> =>
  {
    while (next < items.length)
    {
      await fn(items[next++] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

/** The planner's reads, each refused once the preflight is no longer live. */
function guardedIo(io: PlannerIO, live: () => boolean): PlannerIO
{
  const check = (): void =>
  {
    if (!live())
    {
      throw new Superseded()
    }
  }
  return {
    stat: (path) =>
    {
      check()
      return io.stat(path)
    },
    statfs: (path) =>
    {
      check()
      return io.statfs(path)
    },
    probeWrite: (dir) =>
    {
      check()
      return io.probeWrite(dir)
    },
    volumeInfo: (path) =>
    {
      check()
      return io.volumeInfo(path)
    },
    reachable: (root, timeoutMs) =>
    {
      check()
      return io.reachable(root, timeoutMs)
    }
  }
}

/**
 * Static plans by everything they are made from: the recipe, the source identity, the probe's facts, the planned
 * output, the platform, and the capabilities revision. A job whose inputs did not change reuses its plan.
 */
export class RunnerPlanCache
{
  private kept = new Map<string, RunnerPlan>()

  get size(): number
  {
    return this.kept.size
  }

  /** Runners that answer from the cache and record what a request used; a dead request stops at its next job. */
  wrap(runners: RunnerSet, capabilitiesRev: number, used: Map<string, RunnerPlan>, live: () => boolean): RunnerSet
  {
    const plan = <R extends Recipe>(runner: JobRunner<R>, input: PlanInput<R>): RunnerPlan =>
    {
      if (!live())
      {
        throw new Superseded()
      }
      const { recipe, source, facts, output, platform } = input
      const key = `${capabilitiesRev}|${canonicalJson({ recipe, source, facts, output, platform })}`
      const hit = used.get(key) ?? this.kept.get(key)
      if (hit !== undefined)
      {
        used.set(key, hit)
        return structuredClone(hit)
      }
      const planned = runner.plan(input)
      used.set(key, structuredClone(planned))
      return planned
    }
    const wrap = <R extends Recipe>(runner: JobRunner<R>): JobRunner<R> =>
      ({ kind: runner.kind, plan: (input) => plan(runner, input), run: (job, ctx) => runner.run(job, ctx) })
    return {
      normalize: wrap(runners.normalize),
      boost: wrap(runners.boost),
      convert: wrap(runners.convert),
      compress: wrap(runners.compress),
      extract: wrap(runners.extract)
    }
  }

  /** Keeps exactly the plans the last complete request used. */
  commit(used: Map<string, RunnerPlan>): void
  {
    this.kept = new Map(used)
  }

  clear(): void
  {
    this.kept.clear()
  }
}

/** What the plan commands are built from. */
export interface PlanCommandsDeps
{
  core: EngineCore
  scheduler: Pick<Scheduler, 'trigger'>
  /** The report store Start reads, shared with the run commands. */
  reports: ReportStore
  summaries: PlanSummaries
  /** The planner's reads and runners; `volumeKey` also groups the source re-stat per volume. */
  planner: PlannerDeps
  /** What the planner knows of FFmpeg beyond the capability summary the core holds. */
  capabilities(): Pick<PlannerCapabilities, 'build' | 'minimumVersion'>
  /** Waits for the bounded probe queue on a job and answers its probe. */
  probe(job: Readonly<Job>): Promise<ProbeOutcome>
  /** Album groups with every member still in the queue. */
  albums?(): AlbumGroup[]
  analysis: Pick<AnalysisTasks, 'request' | 'cancel' | 'state'>
  platform: Platform
  /** A new preflight id. */
  newId(): string
  /** Writes a non-replace policy as the persisted default in the `jobs` config key. */
  persistPolicy(policy: Omit<BatchPolicy, 'rev'>): Promise<void>
  /** Writes the default recipe to the `jobs` config key. */
  persistDefaultRecipe(recipe: Recipe): Promise<void>
  log: JobLogger
  quitting?(): boolean
  /** The planner itself; `planPreflight` unless replaced. */
  plan?(input: PreflightInput, deps: PlannerDeps): Promise<PreflightResult>
}

/** One handler per plan command, the re-plan of a single job, and the re-plan of queued jobs a change left stale. */
export type PlanCommands =
  { [K in PlanCommandName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }
  & {
    /** The scheduler's re-plan of one job against the current policy and capabilities; null when it is blocked. */
    replan(job: Readonly<Job>): Promise<JobPlan | null>
    /**
     * Re-plans every queued job whose plan no longer matches the policy or the capabilities. Such a job is not
     * dispatchable until then; it keeps its place with the new plan, or returns to pending (T5) when the new plan is
     * blocked or displaces more.
     */
    replanQueued(): Promise<{ replanned: JobId[]; demoted: JobId[] }>
    dispose(): void
  }

/** Builds the plan commands over the engine core. */
export function createPlanCommands(deps: PlanCommandsDeps): PlanCommands
{
  const { core, log } = deps

  function ok<T>(value: T): CommandResult<T>
  {
    return { ok: true, value, seq: core.bus.flush() }
  }

  function quitting(): boolean
  {
    return deps.quitting?.() ?? false
  }

  /** Whether the run holds jobs the current policy was reviewed for: queued, claimed, or active. */
  function runHoldsJobs(): boolean
  {
    return core.activeCount() > 0 || core.queue.count('queued') > 0 || ACTIVE_STATES.some((state) => core.queue.count(state) > 0)
  }

  async function setPolicy(req: JobCommandMap['setPolicy']['req']): Promise<CommandResult<JobCommandMap['setPolicy']['res']>>
  {
    if (quitting())
    {
      return refuse('shutting-down', 'molexMedia is closing.')
    }
    if (runHoldsJobs())
    {
      return refuse('invalid-state', 'Output settings are locked while the batch runs. They can change once the run ends.')
    }
    const current = core.globals().policy
    if (samePolicy(current, req.policy))
    {
      return ok({ policy: current, demoted: [] })
    }
    const policy: BatchPolicy = { ...req.policy, rev: current.rev + 1 }
    core.setPolicy(policy)
    const result = ok({ policy, demoted: [] as JobId[] })
    if (policy.destination.mode !== 'replace-originals')
    {
      const { rev: _rev, ...saved } = policy
      try
      {
        await deps.persistPolicy(saved)
      }
      catch (err)
      {
        log.warn(`The batch policy could not be saved as the default: ${errorText(err)}`)
      }
    }
    return result
  }

  async function setDefaultRecipe(req: JobCommandMap['setDefaultRecipe']['req']): Promise<CommandResult<null>>
  {
    core.setDefaultRecipe(req.recipe)
    const result = ok(null)
    try
    {
      await deps.persistDefaultRecipe(req.recipe)
    }
    catch (err)
    {
      log.warn(`The default operation settings could not be saved: ${errorText(err)}`)
    }
    return result
  }

  const runnerPlans = new RunnerPlanCache()
  const planner = deps.plan ?? planPreflight
  let generation = 0
  let disposed = false

  /** The jobs a request covers, in queue order: pending ones, or the named jobs that are not running or held. */
  function coveredJobs(ids: JobId[] | 'pending'): Array<Readonly<Job>>
  {
    if (ids === 'pending')
    {
      return core.queue.jobs().filter((job) => job.state === 'pending')
    }
    const wanted = new Set(ids)
    return core.queue.jobs().filter((job) => wanted.has(job.id) && plannable(job))
  }

  function plannable(job: Readonly<Job>): boolean
  {
    return !isActive(job.state) && job.state !== 'held'
  }

  async function volumeOf(path: string): Promise<string>
  {
    try
    {
      return deps.planner.volumeKey === undefined ? volumeRoot(path, deps.platform) : await deps.planner.volumeKey(path)
    }
    catch
    {
      return volumeRoot(path, deps.platform)
    }
  }

  /**
   * One stat per covered source, grouped per volume. A pending job whose size or modification time changed gets a
   * new source identity (`inputsRev` + 1); for other jobs the fresh values go to the planner only.
   */
  async function restat(jobs: ReadonlyArray<Readonly<Job>>, io: PlannerIO): Promise<Map<JobId, FileStat | null>>
  {
    const stats = new Map<JobId, FileStat | null>()
    const groups = new Map<string, Array<Readonly<Job>>>()
    for (const job of jobs)
    {
      const key = await volumeOf(job.source.path)
      groups.set(key, [...(groups.get(key) ?? []), job])
    }
    await Promise.all([...groups.values()].map((group) => pooled(group, PREFLIGHT_STAT_CONCURRENCY, async (job) =>
    {
      stats.set(job.id, await io.stat(job.source.path))
    })))
    for (const job of jobs)
    {
      const stat = stats.get(job.id) ?? null
      const live = core.queue.get(job.id)
      if (stat === null || live === undefined || live.state !== 'pending' || live.source.path !== job.source.path)
      {
        continue
      }
      if (stat.size !== live.source.size || stat.mtimeMs !== live.source.mtimeMs)
      {
        core.update(live.id, { source: { ...live.source, size: stat.size, mtimeMs: stat.mtimeMs } }, { inputs: true })
      }
    }
    return stats
  }

  async function probeOf(job: Readonly<Job>): Promise<ProbeOutcome>
  {
    try
    {
      return await deps.probe(job)
    }
    catch (err)
    {
      return { status: 'failed', reason: errorText(err) }
    }
  }

  function freshSource(job: Readonly<Job>, stat: FileStat | null | undefined): SourceRef
  {
    if (stat === null || stat === undefined || (stat.size === job.source.size && stat.mtimeMs === job.source.mtimeMs))
    {
      return job.source
    }
    return { ...job.source, size: stat.size, mtimeMs: stat.mtimeMs }
  }

  /** The `{date}` value: the open run's start date, else today's. */
  function runDate(): string
  {
    const run = core.run()
    return run.status !== 'idle' && run.startedAt !== null ? localDateOf(run.startedAt) : localDateOf(core.now())
  }

  function buildInput(preflightId: string, jobs: PlanJob[]): PreflightInput
  {
    const globals = core.globals()
    const covered = new Set(jobs.map((job) => job.id))
    const others: OtherJob[] = core.queue.jobs()
      .filter((job) => !covered.has(job.id) && !isTerminal(job.state))
      .map((job) => ({ id: job.id, sourcePath: job.source.path, reservedPath: reservedPath(job) }))
    return {
      preflightId,
      createdAt: core.now(),
      platform: deps.platform,
      policy: globals.policy,
      capabilities: { ...deps.capabilities(), summary: globals.capabilities },
      jobs,
      others,
      albums: deps.albums?.() ?? [],
      limits: globals.workers.limits,
      date: runDate()
    }
  }

  async function runPlanner(input: PreflightInput, used: Map<string, RunnerPlan>, live: () => boolean): Promise<PreflightResult>
  {
    const runners = runnerPlans.wrap(deps.planner.runners, input.capabilities.summary.rev, used, live)
    return planner(input, { ...deps.planner, io: guardedIo(deps.planner.io, live), runners })
  }

  /** The short step: each covered pending job whose inputs still match gets its plan and row summary. */
  function commit(result: PreflightResult): void
  {
    const summaries = new Map(result.summaries.map((entry) => [entry.jobId, entry.summary]))
    for (const entry of result.report.jobs)
    {
      const job = core.queue.get(entry.jobId)
      if (job === undefined || job.state !== 'pending' || job.inputsRev !== entry.inputsRev)
      {
        continue
      }
      const summary = summaries.get(entry.jobId)
      if (entry.plan !== null && summary !== undefined)
      {
        deps.summaries.remember(job.id, entry.plan, summary)
      }
      if (canonicalJson(job.plan) !== canonicalJson(entry.plan))
      {
        core.update(job.id, { plan: entry.plan })
      }
    }
  }

  async function preflight(req: JobCommandMap['preflight']['req']): Promise<CommandResult<PreflightReport>>
  {
    if (quitting() || disposed)
    {
      return refuse('shutting-down', 'molexMedia is closing.')
    }
    const token = ++generation
    const live = (): boolean => token === generation && !disposed
    const preflightId = deps.newId()
    const superseded = (): Refused => refuse('superseded', 'A newer review replaced this one.')
    try
    {
      const io = guardedIo(deps.planner.io, live)
      const first = coveredJobs(req.ids)
      const total = first.length
      core.preflightProgress(preflightId, 0, total)
      const stats = await restat(first, io)
      if (!live())
      {
        return superseded()
      }
      let done = 0
      const probes = new Map<JobId, ProbeOutcome>()
      await Promise.all(first.map(async (job) =>
      {
        const outcome = await probeOf(job)
        probes.set(job.id, outcome)
        if (live())
        {
          core.preflightProgress(preflightId, ++done, total)
        }
      }))
      if (!live())
      {
        return superseded()
      }
      const jobs: PlanJob[] = []
      for (const before of first)
      {
        const job = core.queue.get(before.id)
        if (job === undefined || !plannable(job))
        {
          continue
        }
        const probe = probes.get(job.id) ?? { status: 'pending' }
        jobs.push({ id: job.id, inputsRev: job.inputsRev, source: freshSource(job, stats.get(job.id)), recipe: job.recipe, probe })
      }
      const input = buildInput(preflightId, jobs)
      const used = new Map<string, RunnerPlan>()
      const result = await runPlanner(input, used, live)
      if (!live())
      {
        return superseded()
      }
      runnerPlans.commit(used)
      commit(result)
      deps.reports.remember(result.report, input.date)
      core.preflightProgress(preflightId, total, total)
      return ok(result.report)
    }
    catch (err)
    {
      if (err instanceof Superseded || !live())
      {
        return superseded()
      }
      log.error(`Preflight ${preflightId} failed: ${errorText(err)}`)
      return refuse('internal', `The outputs could not be checked: ${errorText(err)}`)
    }
  }

  /** One job planned alone against the current policy and capabilities, with every other job's paths reserved. */
  async function replanJob(job: Readonly<Job>): Promise<{ plan: JobPlan | null; summary: PlanSummary | null }>
  {
    const probe = await probeOf(job)
    const stat = await deps.planner.io.stat(job.source.path).catch(() => null)
    const input = buildInput(deps.newId(), [{ id: job.id, inputsRev: job.inputsRev, source: freshSource(job, stat), recipe: job.recipe, probe }])
    const result = await runPlanner(input, new Map(), () => !disposed)
    const entry = result.report.jobs.find((candidate) => candidate.jobId === job.id)
    if (entry === undefined || entry.status === 'blocked' || entry.plan === null)
    {
      return { plan: null, summary: null }
    }
    return { plan: entry.plan, summary: result.summaries.find((candidate) => candidate.jobId === job.id)?.summary ?? null }
  }

  async function replan(job: Readonly<Job>): Promise<JobPlan | null>
  {
    return (await replanJob(job)).plan
  }

  async function replanQueued(): Promise<{ replanned: JobId[]; demoted: JobId[] }>
  {
    const replanned: JobId[] = []
    const demoted: JobId[] = []
    const { policy, capabilities } = core.globals()
    const stale = core.queue.jobs().filter((job) =>
      job.state === 'queued' && !core.isClaimed(job.id) && !planIsCurrent(job, policy.rev, capabilities.rev))
    for (const job of stale)
    {
      const inputsRev = job.inputsRev
      let next: { plan: JobPlan | null; summary: PlanSummary | null } = { plan: null, summary: null }
      try
      {
        next = await replanJob(job)
      }
      catch (err)
      {
        log.warn(`The output of ${job.id} could not be checked again: ${errorText(err)}`)
      }
      const live = core.queue.get(job.id)
      if (disposed || live === undefined || live.state !== 'queued' || live.inputsRev !== inputsRev || core.isClaimed(job.id))
      {
        continue
      }
      if (next.plan !== null && !moreDestructive(live.plan, next.plan))
      {
        if (next.summary !== null)
        {
          deps.summaries.remember(job.id, next.plan, next.summary)
        }
        core.update(job.id, { plan: next.plan })
        replanned.push(job.id)
        continue
      }
      const reason = next.plan === null ? 'plan-blocked' : 'destructive-scope'
      if (core.transition(job.id, ['queued'], 'demote', { reason, change: { plan: next.plan } }).applied)
      {
        demoted.push(job.id)
      }
    }
    if (replanned.length > 0 || demoted.length > 0)
    {
      deps.scheduler.trigger('replanned')
    }
    return { replanned, demoted }
  }

  function analyzeRefusal(jobId: JobId): JobRefusal | null
  {
    const job = core.queue.get(jobId)
    if (job === undefined)
    {
      return { jobId, code: 'not-found', message: 'This job is no longer in the queue.' }
    }
    if (!ANALYZABLE_KINDS.includes(job.recipe.kind))
    {
      return { jobId, code: 'invalid-recipe', message: 'Only Normalize and Boost jobs measure loudness before the run.' }
    }
    if (job.state === 'pending' || job.state === 'queued')
    {
      return null
    }
    if (job.state === 'finalizing')
    {
      return { jobId, code: 'job-finalizing', message: 'This job is placing its output.' }
    }
    if (isActive(job.state))
    {
      return { jobId, code: 'job-running', message: 'This job is running.' }
    }
    if (job.state === 'held')
    {
      return { jobId, code: 'job-held', message: 'This job\'s output waits for a decision.' }
    }
    return { jobId, code: 'job-terminal', message: 'This job has finished.' }
  }

  async function analyze(req: JobCommandMap['analyze']['req']): Promise<CommandResult<PerJob>>
  {
    if (quitting() || disposed)
    {
      return refuse('shutting-down', 'molexMedia is closing.')
    }
    const refused: JobRefusal[] = []
    const allowed: JobId[] = []
    for (const jobId of new Set(req.ids))
    {
      const refusal = analyzeRefusal(jobId)
      if (refusal === null)
      {
        allowed.push(jobId)
      }
      else
      {
        refused.push(refusal)
      }
    }
    const accepted = deps.analysis.request(allowed)
    for (const jobId of accepted)
    {
      core.update(jobId, { analysis: 'queued' })
    }
    if (accepted.length > 0)
    {
      deps.scheduler.trigger('analysis')
    }
    return ok({ applied: allowed, refused })
  }

  async function cancelAnalyze(req: JobCommandMap['cancelAnalyze']['req']): Promise<CommandResult<PerJob>>
  {
    const ids = req.ids === 'all'
      ? core.queue.jobs().filter((job) => job.analysis !== null || deps.analysis.state(job.id) !== null).map((job) => job.id)
      : [...new Set(req.ids)]
    const applied: JobId[] = []
    const refused: JobRefusal[] = []
    for (const jobId of ids)
    {
      const job = core.queue.get(jobId)
      if (job === undefined)
      {
        refused.push({ jobId, code: 'not-found', message: 'This job is no longer in the queue.' })
        continue
      }
      const requested = deps.analysis.cancel(jobId)
      if (!requested && job.analysis === null)
      {
        refused.push({ jobId, code: 'not-analyzing', message: 'This job is not being measured.' })
        continue
      }
      if (job.analysis !== null)
      {
        core.update(jobId, { analysis: null })
      }
      applied.push(jobId)
    }
    if (applied.length > 0)
    {
      deps.scheduler.trigger('analysis')
    }
    return ok({ applied, refused })
  }

  return {
    setPolicy,
    setDefaultRecipe,
    preflight,
    analyze,
    cancelAnalyze,
    replan,
    replanQueued,
    dispose(): void
    {
      disposed = true
      generation += 1
      runnerPlans.clear()
    }
  }
}
