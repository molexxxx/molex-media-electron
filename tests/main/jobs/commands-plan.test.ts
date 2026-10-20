/**
 * The plan commands over a real engine core: the batch policy, the default recipe, the preflight with its per-job
 * cache, re-stat, supersession, and row summaries, the re-plan of queued jobs, and the analysis requests.
 */

import { describe, it, expect, vi } from 'vitest'
import { createEngineCore, planIsCurrent, type CoreJournal, type CoreJournalEntry } from '../../../src/main/jobs/core'
import { createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { createReportStore } from '../../../src/main/jobs/commands/run'
import {
  createPlanCommands, createPlanSummaries, moreDestructive, RunnerPlanCache, PREFLIGHT_STAT_CONCURRENCY, type PlanCommandsDeps
} from '../../../src/main/jobs/commands/plan'
import { AnalysisTasks, type AnalysisContext } from '../../../src/main/jobs/analysis'
import { countOccupancy, selectAnalysis } from '../../../src/main/jobs/dispatch'
import type { FileStat, JobLogger, PlannerIO } from '../../../src/main/jobs/deps'
import type { PlannerDeps, PreflightInput, PreflightResult, ProbeOutcome, RunnerSet } from '../../../src/main/jobs/planner'
import type { RunnerPlan } from '../../../src/main/jobs/runners/types'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { formatRunId, type JobId } from '../../../src/shared/jobs/ids'
import type { AudioAnalysis } from '../../../src/shared/audio/events'
import type { EncoderPolicy, MediaFacts } from '../../../src/shared/audio/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type {
  BatchPolicy,
  CapabilitySummary,
  Job,
  JobMeasurement,
  JobPlan,
  OutputPlan,
  PlanSummary,
  PreflightReport,
  RunSettings,
  SourceRef,
  WorkersState
} from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'folder', folder: 'D:\\out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

const SETTINGS: RunSettings =
{
  workers: { mode: 'fixed', count: 2 },
  gpuSessions: { mode: 'fixed', count: 4 },
  priority: 'below-normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: false,
  includeSubfolders: true
}

const CAPS: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: 'n9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true, surroundMeter: true },
  encoders: ['aac', 'libx264'],
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 8,
  platform: 'win32'
}

const WORKERS: WorkersState =
{
  setting: { mode: 'fixed', count: 4 },
  limits: { total: 4, videoCpu: 4, gpu: 0 },
  active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
}

const MTIME = 1700000000000

const FACTS = { container: 'mp4', durationSec: 10 } as unknown as MediaFacts

const PREVIEW: JobMeasurement = { pass: 'preview', measuredAt: 0, streams: [], album: null, messages: [] }

function convert(): Recipe
{
  return applyPreset('mp4-h264', OUTPUT) as Recipe
}

function normalize(): Recipe
{
  return applyPreset('spotify', OUTPUT) as Recipe
}

function source(name: string): SourceRef
{
  return { path: `C:\\media\\${name}`, name, ext: '.mp4', dir: 'C:\\media', size: 1000, mtimeMs: MTIME, origin: 'files', subdir: '' }
}

function numbers(): CatalogNumbers
{
  let next = 1
  return { available: () => 1000 - next, take: () => next++ }
}

function fakeLog(): JobLogger & { lines: Array<{ level: string; message: string }> }
{
  const lines: Array<{ level: string; message: string }> = []
  const at = (level: string) => (message: string): void =>
  {
    lines.push({ level, message })
  }
  const log = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), ffmpeg: at('ffmpeg'), child: () => log }
  return log
}

function journal(): CoreJournal
{
  let n = 0
  return {
    append: (): number => ++n,
    appendDurable: (entries: readonly CoreJournalEntry[]): Promise<number[]> => Promise.resolve(entries.map(() => ++n))
  }
}

function fileStat(size = 1000, mtimeMs = MTIME): FileStat
{
  return { size, mtimeMs, isFile: true, isDirectory: false, dev: '1', ino: '1' }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void }
{
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) =>
  {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runnerPlan(): RunnerPlan
{
  return {
    command: null,
    streams: { kept: [], dropped: [], chapters: 'none' },
    video: null,
    audio: [],
    class: 'video-cpu',
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }],
    estimate: { outputBytes: 1000, workSec: 1, confidence: 'high' },
    issues: []
  }
}

function fakeRunners(): RunnerSet & { calls: () => number }
{
  const plan = vi.fn(() => runnerPlan())
  const runner = (kind: Recipe['kind']) => ({ kind, plan, run: vi.fn() })
  return {
    normalize: runner('normalize'),
    boost: runner('boost'),
    convert: runner('convert'),
    compress: runner('compress'),
    extract: runner('extract'),
    calls: () => plan.mock.calls.length
  } as unknown as RunnerSet & { calls: () => number }
}

function summaryOf(plan: JobPlan | null, status: PlanSummary['status']): PlanSummary
{
  const finalName = plan?.output.finalPath.split('\\').pop() ?? ''
  return {
    status,
    current: true,
    finalName,
    relativePath: finalName,
    container: plan?.output.container ?? '',
    resolution: plan?.output.resolution ?? 'place',
    encoderLabel: 'x264 1-pass',
    errors: status === 'blocked' ? 1 : 0,
    warnings: 0,
    firstIssue: null
  }
}

/** A planner over the injected reads and runners: one final-path stat and one runner plan per probed job. */
async function fakePlan(input: PreflightInput, deps: PlannerDeps): Promise<PreflightResult>
{
  const jobs: PreflightReport['jobs'] = []
  for (const job of input.jobs)
  {
    if (job.probe.status !== 'ok')
    {
      jobs.push({ jobId: job.id, inputsRev: job.inputsRev, status: 'blocked', plan: null, issues: [] })
      continue
    }
    const replace = input.policy.destination.mode === 'replace-originals'
    const folder = input.policy.destination.mode === 'folder' ? input.policy.destination.folder : job.source.dir
    const finalPath = replace ? job.source.path : `${folder}\\${job.source.name}`
    await deps.io.stat(finalPath)
    const output: OutputPlan = {
      kind: 'file', finalPath, container: 'mp4', muxer: 'mp4', containerChanged: null, conflict: replace ? 'exists' : 'none',
      resolution: replace ? 'replace-original' : 'place', renamedTo: null, displaces: replace ? job.source.path : null
    }
    const planned = deps.runners[job.recipe.kind].plan({ recipe: job.recipe as never, source: job.source, facts: job.probe.facts, caps: input.capabilities.build, output, platform: input.platform })
    const plan: JobPlan = {
      basis: { inputsRev: job.inputsRev, policyRev: input.policy.rev, capabilitiesRev: input.capabilities.summary.rev },
      fingerprint: `fp:${finalPath}:${output.resolution}`,
      source: { path: job.source.path, size: job.source.size, mtimeMs: job.source.mtimeMs },
      output,
      streams: planned.streams,
      video: planned.video,
      audio: planned.audio,
      class: planned.class,
      stages: planned.stages,
      estimate: { ...planned.estimate, reserveBytes: 1000 },
      album: null,
      command: planned.command
    }
    jobs.push({ jobId: job.id, inputsRev: job.inputsRev, status: 'ready', plan, issues: [] })
  }
  const report: PreflightReport = {
    preflightId: input.preflightId,
    createdAt: input.createdAt,
    policyRev: input.policy.rev,
    capabilitiesRev: input.capabilities.summary.rev,
    jobs,
    counts: { jobs: jobs.length, ready: jobs.filter((entry) => entry.status === 'ready').length, blocked: jobs.filter((entry) => entry.status === 'blocked').length, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0 },
    volumes: [],
    collisions: [],
    blocking: [],
    warnings: [],
    limits: input.limits
  }
  return { report, summaries: jobs.map((entry) => ({ jobId: entry.jobId, summary: summaryOf(entry.plan, entry.status) })) }
}

interface SetupOptions
{
  jobs?: number
  recipe?: () => Recipe
  quitting?: boolean
  plan?: PlanCommandsDeps['plan']
}

function setup(options: SetupOptions = {})
{
  const timers = createManualTimers(new Date(2026, 9, 18, 12).getTime())
  const log = fakeLog()
  const bus = createJobEventBus({ timers, log })
  const emit = vi.spyOn(bus, 'emit')
  const queue = new JobQueue({ numbers: numbers(), now: () => timers.now() })
  const summaries = createPlanSummaries()
  const core = createEngineCore({
    queue,
    bus,
    journal: journal(),
    log,
    now: () => timers.now(),
    state: {
      policy: POLICY,
      settings: SETTINGS,
      defaultRecipe: convert(),
      capabilities: CAPS,
      workers: WORKERS,
      presets: { user: [], pins: {}, recent: [] },
      recentFolders: []
    },
    summarize: (run) => ({ runId: run.runId }) as never,
    views: { planSummary: summaries.planSummary }
  })
  const recipe = options.recipe ?? convert
  const added = core.add(Array.from({ length: options.jobs ?? 3 }, (_, i) => ({ source: source(`file-${i + 1}.mp4`), recipe: recipe() }))) ?? []
  const ids = added.map((job) => job.id)

  const files = new Map<string, FileStat | null | Promise<FileStat | null>>()
  const stat = vi.fn(async (path: string): Promise<FileStat | null> =>
  {
    if (files.has(path))
    {
      return await (files.get(path) as FileStat | null | Promise<FileStat | null>)
    }
    return path.startsWith('C:\\media\\') ? fileStat() : null
  })
  const io: PlannerIO = {
    stat,
    statfs: vi.fn(async () => ({ total: 1e12, free: 1e11 }) as never),
    probeWrite: vi.fn(async () => true),
    volumeInfo: vi.fn(async () => ({}) as never),
    reachable: vi.fn(async () => true)
  }
  const runners = fakeRunners()
  const probes = new Map<JobId, ProbeOutcome | Promise<ProbeOutcome>>()
  const probe = vi.fn(async (job: Readonly<Job>): Promise<ProbeOutcome> => await (probes.get(job.id) ?? { status: 'ok', facts: FACTS }))

  const measured = new Map<JobId, ReturnType<typeof deferred<AudioAnalysis>>>()
  const settled = vi.fn()
  const analysis = new AnalysisTasks({
    analyze: (jobId: JobId, context: AnalysisContext) =>
    {
      const next = deferred<AudioAnalysis>()
      measured.set(jobId, next)
      context.signal.addEventListener('abort', () => next.reject(new Error('aborted')))
      return next.promise
    },
    plan: () => PREVIEW,
    onSettled: settled
  })
  const trigger = vi.fn((reason: string) =>
  {
    if (reason !== 'analysis')
    {
      return
    }
    for (const id of selectAnalysis(analysis.pending(), countOccupancy(analysis.slots()), WORKERS.limits))
    {
      if (analysis.start(id))
      {
        core.update(id, { analysis: 'running' })
      }
    }
  })
  let idSeq = 0
  const reports = createReportStore()
  const deps = {
    core,
    scheduler: { trigger },
    reports,
    summaries,
    planner: { io, runners },
    capabilities: () => ({ build: {} as never, minimumVersion: '5.1' }),
    probe,
    analysis,
    platform: 'win32',
    newId: () => `pf-${++idSeq}`,
    persistPolicy: vi.fn(async (_policy: Omit<BatchPolicy, 'rev'>): Promise<void> => undefined),
    persistDefaultRecipe: vi.fn(async (_recipe: Recipe): Promise<void> => undefined),
    log,
    quitting: vi.fn(() => options.quitting ?? false),
    plan: options.plan ?? fakePlan
  } satisfies PlanCommandsDeps
  const commands = createPlanCommands(deps)

  function events<T extends DraftEvent['type']>(type: T): Array<Extract<DraftEvent, { type: T }>>
  {
    return emit.mock.calls.map((call) => call[0]).filter((event): event is Extract<DraftEvent, { type: T }> => event.type === type)
  }

  const job = (id: JobId): Readonly<Job> => core.queue.get(id) as Job

  /** Queues jobs with a current plan in a running run. */
  async function queueAll(list: JobId[] = ids): Promise<void>
  {
    const result = await commands.preflight({ ids: list })
    expect(result.ok).toBe(true)
    core.batch(() =>
    {
      core.startRun(formatRunId(1))
      for (const id of list)
      {
        core.transition(id, ['pending'], 'start', { change: { plan: job(id).plan } })
      }
    })
  }

  return { timers, log, core, ids, files, stat, io, runners, probes, probe, analysis, measured, settled, trigger, reports, summaries, deps, commands, events, job, emit, queueAll }
}

describe('setPolicy', () =>
{
  it('increments the revision, emits the change, and saves a non-replace policy as the default', async () =>
  {
    const ctx = setup()
    const { rev: _rev, ...next } = { ...POLICY, conflict: 'overwrite' as const }
    const result = await ctx.commands.setPolicy({ policy: next })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.policy.rev).toBe(2)
    expect(result.value.demoted).toEqual([])
    expect(ctx.core.globals().policy).toEqual({ ...next, rev: 2 })
    expect(ctx.events('policy.changed')).toHaveLength(1)
    expect(ctx.deps.persistPolicy).toHaveBeenCalledWith(next)
  })

  it('never saves replace originals as the default', async () =>
  {
    const ctx = setup()
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY, destination: { mode: 'replace-originals' } } })
    expect(result.ok).toBe(true)
    expect(ctx.core.globals().policy.destination.mode).toBe('replace-originals')
    expect(ctx.deps.persistPolicy).not.toHaveBeenCalled()
  })

  it('leaves the revision alone for the same policy', async () =>
  {
    const ctx = setup()
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY } })
    expect(result.ok && result.value.policy.rev).toBe(1)
    expect(ctx.events('policy.changed')).toHaveLength(0)
  })

  it('is refused with invalid-state while the run has queued jobs', async () =>
  {
    const ctx = setup()
    await ctx.queueAll([ctx.ids[0] as JobId])
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY, conflict: 'skip' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-state')
    expect(ctx.core.globals().policy.rev).toBe(1)
  })

  it('is refused with invalid-state while a job is active', async () =>
  {
    const ctx = setup()
    await ctx.queueAll([ctx.ids[0] as JobId])
    ctx.core.claim(ctx.ids[0] as JobId)
    ctx.core.transition(ctx.ids[0] as JobId, ['queued'], 'dispatch')
    ctx.core.releaseClaim(ctx.ids[0] as JobId)
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY, conflict: 'skip' } })
    expect(!result.ok && result.error.code).toBe('invalid-state')
  })

  it('is refused while quitting', async () =>
  {
    const ctx = setup({ quitting: true })
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY, conflict: 'skip' } })
    expect(!result.ok && result.error.code).toBe('shutting-down')
  })

  it('keeps the new policy when saving it fails', async () =>
  {
    const ctx = setup()
    ctx.deps.persistPolicy.mockRejectedValueOnce(new Error('disk full'))
    const result = await ctx.commands.setPolicy({ policy: { ...POLICY, conflict: 'skip' } })
    expect(result.ok).toBe(true)
    expect(ctx.core.globals().policy.conflict).toBe('skip')
    expect(ctx.log.lines.some((line) => line.level === 'warn' && line.message.includes('disk full'))).toBe(true)
  })
})

describe('setDefaultRecipe', () =>
{
  it('replaces and saves the default, which only future adds copy', async () =>
  {
    const ctx = setup()
    const before = ctx.job(ctx.ids[0] as JobId).recipe
    const result = await ctx.commands.setDefaultRecipe({ recipe: normalize() })
    expect(result.ok).toBe(true)
    expect(ctx.core.globals().defaultRecipe.kind).toBe('normalize')
    expect(ctx.deps.persistDefaultRecipe).toHaveBeenCalledWith(normalize())
    expect(ctx.events('defaultRecipe.changed')).toHaveLength(1)
    expect(ctx.job(ctx.ids[0] as JobId).recipe).toEqual(before)
  })

  it('keeps the default when saving it fails', async () =>
  {
    const ctx = setup()
    ctx.deps.persistDefaultRecipe.mockRejectedValueOnce(new Error('locked'))
    const result = await ctx.commands.setDefaultRecipe({ recipe: normalize() })
    expect(result.ok).toBe(true)
    expect(ctx.core.globals().defaultRecipe.kind).toBe('normalize')
    expect(ctx.log.lines.some((line) => line.message.includes('locked'))).toBe(true)
  })
})

describe('preflight', () =>
{
  it('writes each pending job\'s plan summary through job.updated and keeps the report for Start', async () =>
  {
    const ctx = setup()
    const result = await ctx.commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value
    expect(report.jobs.map((entry) => entry.jobId)).toEqual(ctx.ids)
    for (const id of ctx.ids)
    {
      expect(ctx.job(id).plan?.basis).toEqual({ inputsRev: ctx.job(id).inputsRev, policyRev: 1, capabilitiesRev: 1 })
      const view = ctx.core.view(id)
      expect(view?.plan?.encoderLabel).toBe('x264 1-pass')
      expect(view?.plan?.current).toBe(true)
      expect(ctx.summaries.get(id)?.finalName).toBe(ctx.job(id).source.name)
    }
    const updated = ctx.events('job.updated').filter((event) => 'plan' in event.patch)
    expect(updated.map((event) => event.jobId)).toEqual(ctx.ids)
    expect(ctx.reports.get(report.preflightId)?.date).toBe('2026-10-18')
    const progress = ctx.events('preflight.progress')
    expect(progress.at(-1)).toMatchObject({ preflightId: report.preflightId, done: 3, total: 3 })
  })

  it('re-plans only jobs whose inputs changed, and writes no row for an unchanged plan', async () =>
  {
    const ctx = setup()
    await ctx.commands.preflight({ ids: 'pending' })
    expect(ctx.runners.calls()).toBe(3)
    ctx.emit.mockClear()
    const again = await ctx.commands.preflight({ ids: 'pending' })
    expect(again.ok).toBe(true)
    expect(ctx.runners.calls()).toBe(3)
    expect(ctx.events('job.updated')).toHaveLength(0)
    const first = ctx.ids[0] as JobId
    ctx.core.update(first, { recipe: applyPreset('mov-h264', OUTPUT) as Recipe, plan: null }, { inputs: true })
    const third = await ctx.commands.preflight({ ids: 'pending' })
    expect(third.ok).toBe(true)
    expect(ctx.runners.calls()).toBe(4)
    expect(planIsCurrent(ctx.job(first), 1, 1)).toBe(true)
  })

  it('re-stats every covered source, and a changed size gives the job a new identity before it is planned', async () =>
  {
    const ctx = setup()
    await ctx.commands.preflight({ ids: 'pending' })
    const second = ctx.ids[1] as JobId
    const before = ctx.job(second).inputsRev
    ctx.stat.mockClear()
    ctx.files.set(ctx.job(second).source.path, fileStat(2000))
    const result = await ctx.commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    const sourceStats = ctx.stat.mock.calls.filter(([path]) => path.startsWith('C:\\media\\'))
    expect(sourceStats).toHaveLength(3)
    expect(ctx.job(second).inputsRev).toBe(before + 1)
    expect(ctx.job(second).source.size).toBe(2000)
    expect(ctx.job(second).plan?.source.size).toBe(2000)
    expect(ctx.runners.calls()).toBe(4)
  })

  it('leaves a missing source to the planner', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const id = ctx.ids[0] as JobId
    ctx.files.set(ctx.job(id).source.path, null)
    const result = await ctx.commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    expect(ctx.job(id).inputsRev).toBe(1)
  })

  it('plans named jobs, skipping running and unknown ones, and writes plans into pending jobs only', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await ctx.queueAll([a])
    const plan = ctx.job(a).plan
    ctx.files.set(ctx.job(a).source.path, fileStat(3000))
    const result = await ctx.commands.preflight({ ids: [a, b, 'J-9999' as JobId] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.jobs.map((entry) => entry.jobId)).toEqual([a, b])
    expect(result.value.jobs[0]?.plan?.source.size).toBe(3000)
    expect(ctx.job(a).plan).toEqual(plan)
    expect(ctx.job(a).inputsRev).toBe(1)
    expect(ctx.job(c).plan).toBeNull()
    ctx.core.claim(a)
    ctx.core.transition(a, ['queued'], 'dispatch')
    const running = await ctx.commands.preflight({ ids: [a] })
    expect(running.ok && running.value.jobs).toEqual([])
  })

  it('takes the run\'s start date while a run is open', async () =>
  {
    const ctx = setup()
    await ctx.queueAll([ctx.ids[0] as JobId])
    ctx.timers.advance(3 * 24 * 3600 * 1000)
    const result = await ctx.commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ctx.reports.get(result.value.preflightId)?.date).toBe('2026-10-18')
  })

  it('blocks a job whose probe failed or threw, and clears its earlier plan', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await ctx.commands.preflight({ ids: 'pending' })
    ctx.core.update(a, { recipe: applyPreset('mov-h264', OUTPUT) as Recipe }, { inputs: true })
    ctx.probes.set(a, { status: 'failed', reason: 'not media' })
    ctx.probes.set(b, Promise.reject(new Error('probe crashed')))
    const result = await ctx.commands.preflight({ ids: [a, b] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.jobs.map((entry) => entry.status)).toEqual(['blocked', 'blocked'])
    expect(ctx.job(a).plan).toBeNull()
    expect(ctx.core.view(a)?.plan).toBeNull()
  })

  it('is superseded by a newer request while it waits for probes', async () =>
  {
    const ctx = setup()
    const slow = deferred<ProbeOutcome>()
    ctx.probes.set(ctx.ids[0] as JobId, slow.promise)
    const older = ctx.commands.preflight({ ids: 'pending' })
    await vi.waitFor(() => expect(ctx.probe).toHaveBeenCalled())
    ctx.probes.delete(ctx.ids[0] as JobId)
    const newer = await ctx.commands.preflight({ ids: 'pending' })
    slow.resolve({ status: 'ok', facts: FACTS })
    const first = await older
    expect(!first.ok && first.error.code).toBe('superseded')
    expect(newer.ok).toBe(true)
    if (!newer.ok) return
    expect(ctx.reports.get(newer.value.preflightId)).not.toBeNull()
    expect(ctx.reports.get('pf-1')).toBeNull()
  })

  it('stops a superseded preflight at its next read inside the planner', async () =>
  {
    const ctx = setup()
    const gate = deferred<void>()
    let calls = 0
    const commands = createPlanCommands({
      ...ctx.deps,
      plan: async (input, deps) =>
      {
        calls += 1
        if (calls === 1)
        {
          await gate.promise
        }
        return fakePlan(input, deps)
      }
    })
    const older = commands.preflight({ ids: 'pending' })
    await vi.waitFor(() => expect(calls).toBe(1))
    const newer = await commands.preflight({ ids: 'pending' })
    gate.resolve()
    const first = await older
    expect(!first.ok && first.error.code).toBe('superseded')
    expect(newer.ok).toBe(true)
  })

  it('stops a superseded preflight at its next job in the runners', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const gate = deferred<void>()
    let calls = 0
    const commands = createPlanCommands({
      ...ctx.deps,
      plan: async (input, deps) =>
      {
        calls += 1
        const job = input.jobs[0]
        if (calls === 1 && job !== undefined && job.probe.status === 'ok')
        {
          await gate.promise
          deps.runners.convert.plan({ recipe: job.recipe as never, source: job.source, facts: job.probe.facts, caps: input.capabilities.build, output: {} as OutputPlan, platform: input.platform })
        }
        return fakePlan(input, deps)
      }
    })
    const older = commands.preflight({ ids: 'pending' })
    await vi.waitFor(() => expect(calls).toBe(1))
    await commands.preflight({ ids: 'pending' })
    gate.resolve()
    const first = await older
    expect(!first.ok && first.error.code).toBe('superseded')
  })

  it('does not write a plan whose job changed while it was planned', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const id = ctx.ids[0] as JobId
    const gate = deferred<void>()
    let entered = false
    const commands = createPlanCommands({
      ...ctx.deps,
      plan: async (input, deps) =>
      {
        entered = true
        await gate.promise
        return fakePlan(input, deps)
      }
    })
    const pending = commands.preflight({ ids: 'pending' })
    await vi.waitFor(() => expect(entered).toBe(true))
    ctx.core.update(id, { recipe: applyPreset('mov-h264', OUTPUT) as Recipe }, { inputs: true })
    gate.resolve()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(ctx.job(id).plan).toBeNull()
  })

  it('answers internal when the planner fails, and shutting-down once disposed or quitting', async () =>
  {
    const ctx = setup({
      plan: async () =>
      {
        throw new Error('boom')
      }
    })
    const failed = await ctx.commands.preflight({ ids: 'pending' })
    expect(!failed.ok && failed.error.code).toBe('internal')
    expect(ctx.log.lines.some((line) => line.level === 'error' && line.message.includes('boom'))).toBe(true)
    ctx.commands.dispose()
    const closed = await ctx.commands.preflight({ ids: 'pending' })
    expect(!closed.ok && closed.error.code).toBe('shutting-down')
    const quitting = setup({ quitting: true })
    const refused = await quitting.commands.preflight({ ids: 'pending' })
    expect(!refused.ok && refused.error.code).toBe('shutting-down')
  })

  it('ends an in-flight preflight as superseded when disposed', async () =>
  {
    const ctx = setup()
    const slow = deferred<ProbeOutcome>()
    ctx.probes.set(ctx.ids[0] as JobId, slow.promise)
    const pending = ctx.commands.preflight({ ids: 'pending' })
    await vi.waitFor(() => expect(ctx.probe).toHaveBeenCalled())
    ctx.commands.dispose()
    slow.resolve({ status: 'ok', facts: FACTS })
    const result = await pending
    expect(!result.ok && result.error.code).toBe('superseded')
  })

  it('groups the source re-stat by the planner\'s volume key', async () =>
  {
    const ctx = setup()
    const volumeKey = vi.fn(async (path: string) =>
    {
      if (path.endsWith('file-3.mp4'))
      {
        throw new Error('offline')
      }
      return 'vol-1'
    })
    const commands = createPlanCommands({ ...ctx.deps, planner: { ...ctx.deps.planner, volumeKey } })
    const result = await commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    expect(volumeKey).toHaveBeenCalledTimes(3)
    expect(PREFLIGHT_STAT_CONCURRENCY).toBe(16)
  })
})

describe('measurements and reports', () =>
{
  it('a preview measurement changes rev, never inputsRev, and never invalidates a report or a plan', async () =>
  {
    const ctx = setup({ recipe: normalize })
    const id = ctx.ids[0] as JobId
    const result = await ctx.commands.preflight({ ids: 'pending' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { rev, inputsRev } = ctx.job(id)
    ctx.core.measured(id, { ...PREVIEW, measuredAt: 5 })
    expect(ctx.job(id).rev).toBeGreaterThan(rev)
    expect(ctx.job(id).inputsRev).toBe(inputsRev)
    expect(ctx.reports.get(result.value.preflightId)?.report).toBe(result.value)
    expect(planIsCurrent(ctx.job(id), 1, 1)).toBe(true)
    expect(ctx.core.view(id)?.plan?.current).toBe(true)
    const calls = ctx.runners.calls()
    ctx.emit.mockClear()
    await ctx.commands.preflight({ ids: 'pending' })
    expect(ctx.runners.calls()).toBe(calls)
    expect(ctx.events('job.updated')).toHaveLength(0)
  })

  it('keeps the last four reports through the shared store', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const made: string[] = []
    for (let i = 0; i < 5; i += 1)
    {
      const result = await ctx.commands.preflight({ ids: 'pending' })
      if (result.ok) made.push(result.value.preflightId)
    }
    expect(made).toHaveLength(5)
    expect(ctx.reports.get(made[0] as string)).toBeNull()
    expect(made.slice(1).every((id) => ctx.reports.get(id) !== null)).toBe(true)
  })
})

describe('re-planning queued jobs', () =>
{
  const REPLACE: BatchPolicy = { ...POLICY, rev: 2, destination: { mode: 'replace-originals' } }

  it('a switch to replace makes queued jobs non-dispatchable until each is demoted for its wider scope', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await ctx.queueAll([a, b])
    ctx.core.setPolicy(REPLACE)
    expect(planIsCurrent(ctx.job(a), 2, 1)).toBe(false)
    expect(ctx.core.view(a)?.plan?.current).toBe(false)
    const result = await ctx.commands.replanQueued()
    expect(result).toEqual({ replanned: [], demoted: [a, b] })
    expect(ctx.job(a).state).toBe('pending')
    expect(ctx.job(a).reason).toBe('destructive-scope')
    expect(ctx.job(a).plan?.output.resolution).toBe('replace-original')
    expect(ctx.trigger).toHaveBeenCalledWith('replanned')
  })

  it('keeps a queued job in place with its new plan when it displaces nothing more', async () =>
  {
    const ctx = setup()
    const [a] = ctx.ids as [JobId]
    await ctx.queueAll([a])
    ctx.core.setPolicy({ ...POLICY, rev: 2, destination: { mode: 'folder', folder: 'E:\\exports' } })
    const result = await ctx.commands.replanQueued()
    expect(result).toEqual({ replanned: [a], demoted: [] })
    expect(ctx.job(a).state).toBe('queued')
    expect(planIsCurrent(ctx.job(a), 2, 1)).toBe(true)
    expect(ctx.job(a).plan?.output.finalPath).toBe('E:\\exports\\file-1.mp4')
    expect(ctx.core.view(a)?.plan?.encoderLabel).toBe('x264 1-pass')
  })

  it('demotes a queued job whose new plan is blocked or cannot be made', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await ctx.queueAll([a, b])
    ctx.core.setCapabilities({ ...CAPS, rev: 2 })
    ctx.probes.set(a, { status: 'failed', reason: 'gone' })
    ctx.deps.planner.io.stat = vi.fn(async () =>
    {
      throw new Error('unreachable')
    })
    const commands = createPlanCommands({
      ...ctx.deps,
      plan: async (input, deps) =>
      {
        if (input.jobs[0]?.id === b)
        {
          throw new Error('planner down')
        }
        return fakePlan(input, deps)
      }
    })
    const result = await commands.replanQueued()
    expect(result.demoted).toEqual([a, b])
    expect(ctx.job(a).reason).toBe('plan-blocked')
    expect(ctx.job(b).reason).toBe('plan-blocked')
    expect(ctx.log.lines.some((line) => line.message.includes('planner down'))).toBe(true)
  })

  it('leaves current, claimed, and changed jobs alone', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await ctx.queueAll([a, b, c])
    const untouched = await ctx.commands.replanQueued()
    expect(untouched).toEqual({ replanned: [], demoted: [] })
    expect(ctx.trigger).not.toHaveBeenCalledWith('replanned')
    ctx.core.setPolicy(REPLACE)
    ctx.core.claim(a)
    const gate = deferred<void>()
    const commands = createPlanCommands({
      ...ctx.deps,
      plan: async (input, deps) =>
      {
        await gate.promise
        return fakePlan(input, deps)
      }
    })
    const pending = commands.replanQueued()
    await vi.waitFor(() => expect(ctx.probe).toHaveBeenCalledWith(expect.objectContaining({ id: b })))
    ctx.core.update(b, { source: { ...ctx.job(b).source, size: 5 } }, { inputs: true })
    gate.resolve()
    const result = await pending
    expect(result.demoted).toEqual([c])
    expect(ctx.job(a).state).toBe('queued')
    expect(ctx.job(b).state).toBe('queued')
  })

  it('replan answers one job\'s plan against the current policy, or null when blocked', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    const plan = await ctx.commands.replan(ctx.job(a))
    expect(plan?.output.finalPath).toBe('D:\\out\\file-1.mp4')
    expect(plan?.basis).toEqual({ inputsRev: 1, policyRev: 1, capabilitiesRev: 1 })
    ctx.probes.set(b, { status: 'failed', reason: 'gone' })
    expect(await ctx.commands.replan(ctx.job(b))).toBeNull()
  })
})

describe('analysis requests', () =>
{
  it('requests normalize and boost jobs, and dispatch runs at most two in spare slots', async () =>
  {
    const ctx = setup({ recipe: normalize, jobs: 4 })
    const result = await ctx.commands.analyze({ ids: ctx.ids })
    expect(result.ok && result.value).toEqual({ applied: ctx.ids, refused: [] })
    expect(ctx.trigger).toHaveBeenCalledWith('analysis')
    expect(ctx.analysis.running()).toHaveLength(2)
    expect(ctx.ids.map((id) => ctx.job(id).analysis)).toEqual(['running', 'running', 'queued', 'queued'])
    expect(ctx.job(ctx.ids[0] as JobId).inputsRev).toBe(1)
    const again = await ctx.commands.analyze({ ids: [ctx.ids[0] as JobId] })
    expect(again.ok && again.value.applied).toEqual([ctx.ids[0]])
  })

  it('refuses unknown jobs, other operations, and jobs that are running, held, or finished', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const video = ctx.ids[0] as JobId
    const added = ctx.core.add(Array.from({ length: 4 }, (_, i) => ({ source: source(`song-${i}.mp4`), recipe: normalize() }))) ?? []
    const [running, finalizing, held, done] = added.map((job) => job.id) as [JobId, JobId, JobId, JobId]
    await ctx.queueAll([running, finalizing, held, done])
    for (const id of [running, finalizing, held, done])
    {
      ctx.core.claim(id)
      ctx.core.transition(id, ['queued'], 'dispatch')
      ctx.core.releaseClaim(id)
    }
    const live = (id: JobId) => ctx.core.queue.get(id) as Job
    ;(live(finalizing) as { state: string }).state = 'finalizing'
    ;(live(held) as { state: string }).state = 'held'
    ;(live(done) as { state: string }).state = 'done'
    const result = await ctx.commands.analyze({ ids: [video, 'J-404' as JobId, running, finalizing, held, done] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toEqual([])
    expect(result.value.refused.map((refusal) => refusal.code)).toEqual(['invalid-recipe', 'not-found', 'job-running', 'job-finalizing', 'job-held', 'job-terminal'])
    expect(ctx.trigger).not.toHaveBeenCalledWith('analysis')
  })

  it('is refused while quitting', async () =>
  {
    const ctx = setup({ quitting: true, recipe: normalize })
    const result = await ctx.commands.analyze({ ids: ctx.ids })
    expect(!result.ok && result.error.code).toBe('shutting-down')
  })

  it('cancelAnalyze aborts a running task, clears the row, and caches nothing', async () =>
  {
    const ctx = setup({ recipe: normalize, jobs: 3 })
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await ctx.commands.analyze({ ids: [a, b, c] })
    const task = ctx.measured.get(a)
    expect(task).toBeDefined()
    const result = await ctx.commands.cancelAnalyze({ ids: [a] })
    expect(result.ok && result.value).toEqual({ applied: [a], refused: [] })
    expect(ctx.job(a).analysis).toBeNull()
    expect(ctx.analysis.state(a)).toBeNull()
    task?.resolve({ cacheKey: 'k-a' } as AudioAnalysis)
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.analysis.cache.size).toBe(0)
    expect(ctx.settled).not.toHaveBeenCalled()
    expect(ctx.job(c).analysis).toBe('running')
  })

  it('cancelAnalyze with all drops every request, and refuses jobs with none', async () =>
  {
    const ctx = setup({ recipe: normalize, jobs: 4 })
    const [a, b, c, d] = ctx.ids as [JobId, JobId, JobId, JobId]
    await ctx.commands.analyze({ ids: [a, b, c] })
    const all = await ctx.commands.cancelAnalyze({ ids: 'all' })
    expect(all.ok && all.value.applied).toEqual([a, b, c])
    expect(ctx.analysis.running()).toEqual([])
    expect(ctx.analysis.pending()).toEqual([])
    const none = await ctx.commands.cancelAnalyze({ ids: [d, 'J-404' as JobId] })
    expect(none.ok && none.value.refused.map((refusal) => refusal.code)).toEqual(['not-analyzing', 'not-found'])
    ctx.trigger.mockClear()
    const empty = await ctx.commands.cancelAnalyze({ ids: 'all' })
    expect(empty.ok && empty.value).toEqual({ applied: [], refused: [] })
    expect(ctx.trigger).not.toHaveBeenCalled()
  })

  it('cancelAnalyze clears a row whose task already left the analysis tasks', async () =>
  {
    const ctx = setup({ recipe: normalize, jobs: 1 })
    const id = ctx.ids[0] as JobId
    ctx.core.update(id, { analysis: 'queued' })
    const result = await ctx.commands.cancelAnalyze({ ids: [id] })
    expect(result.ok && result.value.applied).toEqual([id])
    expect(ctx.job(id).analysis).toBeNull()
  })
})

describe('helpers', () =>
{
  function plan(resolution: OutputPlan['resolution']): JobPlan
  {
    return {
      basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 },
      fingerprint: resolution,
      source: { path: 'C:\\a.mp4', size: 1, mtimeMs: 1 },
      output: { kind: 'file', finalPath: 'D:\\a.mp4', container: 'mp4', muxer: 'mp4', containerChanged: null, conflict: 'none', resolution, renamedTo: null, displaces: null },
      streams: { kept: [], dropped: [], chapters: 'none' },
      video: null,
      audio: [],
      class: 'audio',
      stages: [],
      estimate: { outputBytes: null, reserveBytes: 0, workSec: null, confidence: 'low' },
      album: null,
      command: null
    }
  }

  it('moreDestructive ranks overwrite and replace above placing', () =>
  {
    expect(moreDestructive(null, plan('place'))).toBe(false)
    expect(moreDestructive(plan('place'), plan('overwrite'))).toBe(true)
    expect(moreDestructive(plan('overwrite'), plan('replace-original'))).toBe(true)
    expect(moreDestructive(plan('replace-original'), plan('rename'))).toBe(false)
    expect(moreDestructive(plan('skip'), plan('skip'))).toBe(false)
  })

  it('plan summaries answer the planner summary for that plan, else the plan\'s own columns', () =>
  {
    const summaries = createPlanSummaries()
    const job = { id: 'J-1' as JobId } as Job
    const first = plan('place')
    const second = { ...plan('rename'), output: { ...plan('rename').output, renamedTo: 'D:\\a (2).mp4' } }
    expect(summaries.planSummary(first, true, job).encoderLabel).toBe('')
    summaries.remember(job.id, first, { ...summaryOf(first, 'ready'), encoderLabel: 'first' })
    summaries.remember(job.id, second, { ...summaryOf(second, 'ready'), encoderLabel: 'second' })
    summaries.remember(job.id, second, { ...summaryOf(second, 'ready'), encoderLabel: 'second again' })
    expect(summaries.planSummary(first, false, job)).toMatchObject({ encoderLabel: 'first', current: false })
    expect(summaries.planSummary(second, true, job).encoderLabel).toBe('second again')
    expect(summaries.get(job.id)?.encoderLabel).toBe('second again')
    summaries.forget(job.id)
    expect(summaries.get(job.id)).toBeNull()
    expect(summaries.planSummary(second, true, job).finalName).toBe('a (2).mp4')
  })

  it('the runner plan cache keeps only what the last request used and hands out copies', () =>
  {
    const cache = new RunnerPlanCache()
    const runners = fakeRunners()
    const input = { recipe: convert(), source: source('a.mp4'), facts: FACTS, caps: {} as never, output: plan('place').output, platform: 'win32' as const }
    const used = new Map<string, RunnerPlan>()
    const wrapped = cache.wrap(runners, 1, used, () => true)
    const one = wrapped.convert.plan(input as never)
    one.issues.push({} as never)
    const two = wrapped.convert.plan(input as never)
    expect(two.issues).toEqual([])
    expect(runners.calls()).toBe(1)
    cache.commit(used)
    expect(cache.size).toBe(1)
    cache.wrap(runners, 2, new Map(), () => true).convert.plan(input as never)
    expect(runners.calls()).toBe(2)
    expect(() => cache.wrap(runners, 1, new Map(), () => false).convert.plan(input as never)).toThrow()
    void wrapped.convert.run({} as never, {} as never)
    expect(runners.convert.run).toHaveBeenCalled()
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
