/**
 * The scheduler over a real engine core with a fake runner scripted per stage and manual timers: claims taken in the
 * selection turn and counted in the budgets, the dispatch checks and their one synchronous commit, pause in both
 * modes, cancel in every active state, the commit between a runner's result and placement, GPU requeues, album and
 * analysis tasks, and the disk-full requeue.
 */
import { describe, it, expect, vi } from 'vitest'
import { createEngineCore, type CoreJournal, type CoreJournalEntry } from '../../../src/main/jobs/core'
import { createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { GpuBudget } from '../../../src/main/jobs/gpu-budget'
import {
  createScheduler,
  engineError,
  executionPlan,
  isDiskFull,
  RECHECK_MS,
  STUCK_CHILD_MS,
  POSIX_KILL_GRACE_MS,
  type SchedulerAlbums,
  type SchedulerAnalysis,
  type SchedulerDeps,
  type SchedulerWorkDirs
} from '../../../src/main/jobs/scheduler'
import type { FileStat, JobLogger, VolumeSpace } from '../../../src/main/jobs/deps'
import type { FinalizeResult, PlacementRequest } from '../../../src/main/jobs/finalize'
import type { RunContext, RunnableJob, RunOutcome } from '../../../src/main/jobs/runners/types'
import type { WorkDirEntry, WorkDirRequest, SweepReport } from '../../../src/main/jobs/workdirs'
import type { AlbumClaim } from '../../../src/main/jobs/album'
import type { Exec, ExecOptions, ExecResult } from '../../../src/main/ffmpeg/exec'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type {
  BatchPolicy,
  CapabilitySummary,
  Job,
  JobError,
  JobMeasurement,
  JobPlan,
  JobResult,
  RunSettings,
  SourceRef,
  Verification,
  WorkersState
} from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

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
  ffmpeg: { ready: true, version: 'n9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
  encoders: ['aac', 'libx264', 'h264_nvenc'],
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 8,
  platform: 'win32'
}

const WORKERS: WorkersState =
{
  setting: { mode: 'fixed', count: 2 },
  limits: { total: 2, videoCpu: 2, gpu: 2 },
  active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
}

const RUN: RunId = formatRunId(1)

const GB = 1e9

const VERIFIED: Verification = { verdict: 'verified', encodePasses: 1, audio: null, media: null, messages: [] }

function recipe(): Recipe
{
  return applyPreset('mp4-h264', OUTPUT) as Recipe
}

function source(name: string): SourceRef
{
  return { path: `C:\\media\\${name}`, name, ext: '.mp4', dir: 'C:\\media', size: 1000, mtimeMs: 1700000000000, origin: 'files', subdir: '' }
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

function journal(): CoreJournal & { fail: boolean }
{
  let n = 0
  const j = {
    fail: false,
    append: (): number => ++n,
    appendDurable: (entries: readonly CoreJournalEntry[]): Promise<number[]> => (j.fail ? Promise.reject(new Error('EIO')) : Promise.resolve(entries.map(() => ++n)))
  }
  return j
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

interface PlanOptions
{
  dest?: string
  reserve?: number
  class?: JobPlan['class']
  gpu?: boolean
  fallback?: boolean
  resolution?: JobPlan['output']['resolution']
  fingerprint?: string
}

function planFor(job: Readonly<Job>, o: PlanOptions = {}): JobPlan
{
  const video = o.gpu === true
    ? { encoder: 'h264_nvenc', gpu: 'nvenc', lossless: 'not-requested' as const, passes: 1 as const, filters: [], notes: [], cpuFallback: o.fallback === false ? null : { encoder: 'libx264', gpu: null, lossless: 'not-requested' as const, passes: 1 as const, filters: [], notes: [] } }
    : null
  return {
    basis: { inputsRev: job.inputsRev, policyRev: POLICY.rev, capabilitiesRev: CAPS.rev },
    fingerprint: o.fingerprint ?? 'fp-1',
    source: { path: job.source.path, size: job.source.size, mtimeMs: job.source.mtimeMs },
    output: { kind: 'file', finalPath: `${o.dest ?? 'D:\\out'}\\${job.source.name}`, container: 'mp4', muxer: 'mp4', containerChanged: null, conflict: 'none', resolution: o.resolution ?? 'place', renamedTo: null, displaces: null },
    streams: { kept: [], dropped: [], chapters: 'none' },
    video,
    audio: [],
    class: o.class ?? (o.gpu === true ? 'video-gpu' : 'video-cpu'),
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }],
    estimate: { outputBytes: o.reserve ?? 1000, reserveBytes: o.reserve ?? 1000, workSec: 1, confidence: 'high' },
    album: null,
    command: null
  }
}

interface Run
{
  job: RunnableJob
  ctx: RunContext
  resolve(outcome: RunOutcome): void
  reject(err: unknown): void
}

function output(ctx: RunContext, verification: Verification = VERIFIED): RunOutcome
{
  return {
    kind: 'output',
    artifact: { kind: 'file', path: ctx.output('mp4', 1), container: 'mp4', bytes: 10, durationSec: 1, encoder: { video: 'libx264', audio: [] } },
    verification,
    measurement: null,
    notes: []
  }
}

function failure(over: Partial<JobError>): RunOutcome
{
  return { kind: 'failed', error: engineError('ffmpeg-failed', 'FFmpeg failed', 'encode', 1, 0, over) }
}

interface SetupOptions
{
  jobs?: number
  workers?: number
  plan?: PlanOptions | ((index: number) => PlanOptions)
  policy?: Partial<BatchPolicy>
  albums?: SchedulerAlbums
  analysis?: SchedulerAnalysis
  platform?: 'win32' | 'linux'
  noFfmpeg?: boolean
}

function setup(options: SetupOptions = {})
{
  const timers = createManualTimers(1_000)
  const log = fakeLog()
  const bus = createJobEventBus({ timers, log })
  const emit = vi.spyOn(bus, 'emit')
  const queue = new JobQueue({ numbers: numbers(), now: () => timers.now() })
  const policy = { ...POLICY, ...options.policy }
  const core = createEngineCore({
    queue,
    bus,
    journal: journal(),
    log,
    now: () => timers.now(),
    state: {
      policy,
      settings: { ...SETTINGS, workers: { mode: 'fixed', count: options.workers ?? 2 } },
      defaultRecipe: recipe(),
      capabilities: CAPS,
      workers: WORKERS,
      presets: { user: [], pins: {}, recent: [] },
      recentFolders: []
    },
    summarize: (run) => ({ runId: run.runId }) as never
  })
  const added = core.add(Array.from({ length: options.jobs ?? 1 }, (_, i) => ({ source: source(`file-${i + 1}.mp4`), recipe: recipe() }))) ?? []
  const ids = added.map((job) => job.id)
  ids.forEach((id, index) =>
  {
    const o = typeof options.plan === 'function' ? options.plan(index) : options.plan
    core.update(id, { plan: planFor(core.queue.get(id) as Job, o), probe: 'ok' })
  })

  const stats = new Map<string, FileStat | null | Promise<FileStat | null>>()
  const unreachable = new Set<string>()
  const free = new Map<string, number>()
  const planner = {
    stat: vi.fn(async (p: string): Promise<FileStat | null> =>
    {
      if (stats.has(p))
      {
        return stats.get(p) as FileStat | null
      }
      if (p.startsWith('C:\\media\\'))
      {
        return { size: 1000, mtimeMs: 1700000000000, isFile: true, isDirectory: false, dev: '1', ino: '1' }
      }
      return null
    }),
    statfs: vi.fn(async (p: string): Promise<VolumeSpace> => ({ freeBytes: free.get(p.slice(0, 3).toLowerCase()) ?? 1e15, totalBytes: 2e15 })),
    reachable: vi.fn(async (p: string): Promise<boolean> => !unreachable.has(p))
  }

  const created: WorkDirRequest[] = []
  const sweeps: Array<{ only: (e: WorkDirEntry) => boolean; protect: (e: WorkDirEntry) => boolean }> = []
  const highest = new Map<JobId, number>()
  let sweepResult: (entries: WorkDirRequest[]) => SweepReport = () => ({ results: [], deleted: 0, pending: 0, kept: 0 })
  let createStatus: 'created' | 'storage-failed' = 'created'
  const workdirs: SchedulerWorkDirs = {
    create: vi.fn(async (request: WorkDirRequest) =>
    {
      created.push(request)
      highest.set(request.jobId, Math.max(highest.get(request.jobId) ?? 0, request.execution))
      const p = `${request.finalPath.slice(0, request.finalPath.lastIndexOf('\\'))}\\.molex-${request.jobId}-a${request.attempt}-x${request.execution}`
      if (createStatus === 'storage-failed')
      {
        return { status: 'storage-failed' as const, path: p, error: new Error('ENOSPC: no space left on device') }
      }
      return { status: 'created' as const, path: p, entry: { path: p, jobId: request.jobId, attempt: request.attempt, execution: request.execution, token: request.token as string, at: 0 } }
    }),
    sweep: vi.fn(async (protect: (e: WorkDirEntry) => boolean, only?: (e: WorkDirEntry) => boolean) =>
    {
      sweeps.push({ protect, only: only ?? (() => true) })
      return sweepResult(created)
    }),
    nextExecution: (jobId: JobId, recorded: number) => Math.max(recorded, highest.get(jobId) ?? 0) + 1
  }

  const runs: Run[] = []
  const runner = {
    kind: 'convert',
    plan: () =>
    {
      throw new Error('not planned here')
    },
    run: vi.fn((job: RunnableJob, ctx: RunContext) =>
    {
      const d = deferred<RunOutcome>()
      runs.push({ job, ctx, resolve: d.resolve, reject: d.reject })
      return d.promise
    })
  }
  const runners = new Proxy({}, { get: () => runner }) as SchedulerDeps['runners']

  const spawned: number[] = []
  const exec: Exec = {
    run: vi.fn((_args: readonly string[], o: ExecOptions) =>
    {
      o.onSpawn?.(4321)
      spawned.push(4321)
      return Promise.resolve({ code: 0, signal: null, aborted: o.signal.aborted } as unknown as ExecResult)
    })
  } as unknown as Exec

  const budget = new GpuBudget({ timers, setting: SETTINGS.gpuSessions, vendor: 'nvenc', onChange: () => scheduler.trigger('gpu-freed') })
  const albums: SchedulerAlbums = options.albums ?? {
    waitingOf: () => undefined,
    claim: (): AlbumClaim => ({ kind: 'none' }),
    memberLeft: vi.fn(),
    pause: vi.fn(),
    cancelRun: vi.fn(),
    slots: () => []
  }
  const analysisRunning: JobId[] = []
  const analysis: SchedulerAnalysis = options.analysis ?? {
    pending: () => [],
    running: () => analysisRunning,
    slots: () => [],
    start: () => false,
    cancel: vi.fn(() => true),
    claimed: vi.fn(),
    pause: vi.fn(),
    quitNow: vi.fn(),
    resume: vi.fn()
  }
  const placements: PlacementRequest[] = []
  let placeWith: (request: PlacementRequest) => Promise<FinalizeResult> = async (request) => ({
    status: 'done', finalPath: request.output.finalPath, placement: { kind: 'new' }, warnings: [], previous: null, copied: false, workDirRemoved: true
  })
  const finalizer = {
    place: vi.fn((request: PlacementRequest) =>
    {
      placements.push(request)
      return placeWith(request)
    })
  }
  const notify = vi.fn()
  const setPriority = vi.fn()
  const replan = vi.fn(async (job: Readonly<Job>): Promise<JobPlan | null> => planFor(job))
  let token = 0
  const deps: SchedulerDeps = {
    core,
    timers,
    ids: { token: () => `t${++token}` },
    platform: options.platform ?? 'win32',
    runners,
    planner,
    volumes: { root: async (p) => p.slice(0, 3), key: async (p) => p.slice(0, 3).toLowerCase() },
    userDataVolume: 'c:\\',
    workdirs,
    budget,
    albums,
    analysis,
    finalizer,
    ffmpeg: { current: () => (options.noFfmpeg === true ? null : { exec, caps: {} as never, rev: 1 }) },
    probe: { probe: vi.fn(async () => ({}) as never) },
    cache: { get: () => null, set: vi.fn() },
    cores: 8,
    setPriority,
    replan,
    result: (input) => ({ outputPath: input.placed.finalPath, warnings: input.warnings, notes: input.notes }) as unknown as JobResult,
    notify,
    log
  }
  const scheduler = createScheduler(deps)

  function start(list: readonly JobId[] = ids): void
  {
    core.batch(() =>
    {
      for (const id of list)
      {
        core.transition(id, ['pending'], 'start', { change: { runId: RUN } })
      }
      core.startRun(RUN)
    })
    scheduler.trigger('queued')
  }

  const job = (id: JobId): Readonly<Job> => core.queue.get(id) as Readonly<Job>
  const runOf = (id: JobId, nth = 0): Run => runs.filter((r) => r.job.id === id)[nth]
  const drafts = (): DraftEvent[] => emit.mock.calls.map((call) => call[0])
  const flush = (): Promise<void> => timers.flush()
  const warnings = (): string[] => log.lines.filter((l) => l.level === 'warn').map((l) => l.message)
  return {
    core, scheduler, timers, ids, runs, planner, albums, analysis, analysisRunning, runnerRun: runner.run, stats, unreachable, free, created, sweeps, workdirs, budget, finalizer, placements, notify, setPriority, replan, exec, spawned,
    start, job, runOf, drafts, flush, warnings, log,
    setPlace: (fn: typeof placeWith) =>
    {
      placeWith = fn
    },
    setSweep: (fn: typeof sweepResult) =>
    {
      sweepResult = fn
    },
    setCreate: (status: typeof createStatus) =>
    {
      createStatus = status
    }
  }
}

type Ctx = ReturnType<typeof setup>

/** Moves a running job through its stages by the runner's own reports. */
function toStage(ctx: Ctx, id: JobId, stage: 'encode' | 'verify', nth = 0): void
{
  const run = ctx.runOf(id, nth)
  if (stage === 'encode' || ctx.job(id).state === 'analyzing')
  {
    run.ctx.stage({ id: 'encode', pass: 1, passes: 1, label: 'Encoding' })
  }
  if (stage === 'verify')
  {
    run.ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' })
  }
}

describe('dispatch', () =>
{
  it('claims in the selection turn, runs the checks, and commits T6 with the frozen policy and a new execution', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 2 })
    ctx.start()
    await ctx.flush()
    expect(ctx.runs.map((r) => r.job.id)).toEqual(ctx.ids.slice(0, 2))
    const first = ctx.job(ctx.ids[0])
    expect(first.state).toBe('analyzing')
    expect(first.execution).toBe(1)
    expect(first.policy).toMatchObject({ rev: 1, conflict: 'rename', frozenAt: 1_000, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(first.workDir).toBe(`D:\\out\\.molex-${ctx.ids[0]}-a1-x1`)
    expect(ctx.job(ctx.ids[2]).state).toBe('queued')
    expect(ctx.core.run().workers.active.total).toBe(2)
  })

  it('never selects a job whose checks are pending again and counts it in the budgets', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 2 })
    const gate = deferred<FileStat | null>()
    for (let i = 1; i <= 3; i++)
    {
      ctx.stats.set(`C:\\media\\file-${i}.mp4`, gate.promise)
    }
    ctx.start()
    ctx.scheduler.trigger('queued')
    ctx.scheduler.trigger('workers')
    await ctx.flush()
    ctx.scheduler.trigger('claim-released')
    await ctx.flush()
    expect(ctx.scheduler.checking()).toEqual(ctx.ids.slice(0, 2))
    expect(ctx.core.claims()).toEqual(ctx.ids.slice(0, 2))
    expect(ctx.planner.stat).toHaveBeenCalledTimes(2)
    expect(ctx.core.run().workers.active).toMatchObject({ total: 2, starting: 2 })
    gate.resolve({ size: 1000, mtimeMs: 1700000000000, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    await ctx.flush()
    expect(ctx.runs).toHaveLength(2)
    expect(ctx.scheduler.checking()).toEqual([])
  })

  it('voids the claim when a command changes the job during the checks; the commit only frees the slot', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const gate = deferred<FileStat | null>()
    ctx.stats.set('C:\\media\\file-1.mp4', gate.promise)
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    ctx.core.update(id, { recipe: recipe() }, { inputs: true })
    gate.resolve({ size: 1000, mtimeMs: 1700000000000, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    await ctx.flush()
    expect(ctx.job(id).state).toBe('queued')
    expect(ctx.core.isClaimed(id)).toBe(false)
    expect(ctx.runs).toHaveLength(0)
    expect(ctx.created).toHaveLength(0)
    expect(ctx.scheduler.checking()).toEqual([])
  })

  it('voids the claim of a job canceled during the checks', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const gate = deferred<boolean>()
    ctx.planner.reachable.mockImplementationOnce(() => gate.promise)
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    ctx.core.transition(id, ['queued'], 'cancel')
    gate.resolve(true)
    await ctx.flush()
    expect(ctx.job(id).state).toBe('canceled')
    expect(ctx.runs).toHaveLength(0)
  })

  it('runs a job whose source changed with an equal fingerprint and ends it with the source-changed warning', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.stats.set('C:\\media\\file-1.mp4', { size: 2000, mtimeMs: 1700000000500, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    ctx.replan.mockImplementation(async (job) => ({ ...planFor(job), source: { path: job.source.path, size: 2000, mtimeMs: 1700000000500 } }))
    const before = ctx.job(id).inputsRev
    ctx.start()
    await ctx.flush()
    expect(ctx.job(id).inputsRev).toBe(before + 1)
    expect(ctx.job(id).state).toBe('analyzing')
    const run = ctx.runOf(id)
    toStage(ctx, id, 'verify')
    run.resolve(output(run.ctx))
    await ctx.flush()
    expect(ctx.job(id).state).toBe('done')
    expect(ctx.job(id).warnings.map((w) => w.code)).toEqual(['source-changed'])
  })

  it('returns a job whose re-plan differs or is blocked to pending with source-changed', async () =>
  {
    const ctx = setup({ jobs: 2 })
    ctx.stats.set('C:\\media\\file-1.mp4', { size: 2000, mtimeMs: 1, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    ctx.stats.set('C:\\media\\file-2.mp4', { size: 3000, mtimeMs: 1, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    ctx.replan.mockImplementation(async (job) => (job.source.name === 'file-1.mp4' ? planFor(job, { fingerprint: 'fp-2' }) : null))
    ctx.start()
    await ctx.flush()
    for (const id of ctx.ids)
    {
      expect(ctx.job(id)).toMatchObject({ state: 'pending', reason: 'source-changed' })
    }
    expect(ctx.job(ctx.ids[0]).plan?.fingerprint).toBe('fp-2')
    expect(ctx.runs).toHaveLength(0)
  })

  it('fails a job whose source is missing on a reachable volume', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.stats.set('C:\\media\\file-1.mp4', null)
    ctx.start()
    await ctx.flush()
    expect(ctx.job(id)).toMatchObject({ state: 'failed' })
    expect(ctx.job(id).error).toMatchObject({ code: 'source-missing', short: 'Source missing' })
  })

  it('holds a job whose source volume is offline and checks it again after 60 s', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.stats.set('C:\\media\\file-1.mp4', null)
    ctx.unreachable.add('C:\\')
    ctx.start()
    await ctx.flush()
    expect(ctx.job(id)).toMatchObject({ state: 'queued', waiting: 'volume-offline', waitingOn: 'C:' })
    expect(ctx.core.alerts().map((a) => a.kind)).toContain('volume-offline')
    expect(ctx.core.isClaimed(id)).toBe(false)
    ctx.stats.delete('C:\\media\\file-1.mp4')
    ctx.unreachable.clear()
    await ctx.timers.advance(RECHECK_MS)
    await ctx.flush()
    expect(ctx.job(id).state).toBe('analyzing')
    expect(ctx.job(id).waiting).toBeNull()
  })

  it('auto-pauses with destination-unavailable when the destination does not answer, keeping the job queued', async () =>
  {
    const ctx = setup({ jobs: 2 })
    ctx.unreachable.add('D:\\out')
    ctx.start()
    await ctx.flush()
    for (const id of ctx.ids)
    {
      expect(ctx.job(id).state).toBe('queued')
    }
    expect(ctx.core.run()).toMatchObject({ status: 'paused', pause: { mode: 'finish-running', reason: 'destination-unavailable' } })
    expect(ctx.core.alerts()).toEqual([expect.objectContaining({ kind: 'destination-unavailable', path: 'D:\\out' })])
    expect(ctx.notify).toHaveBeenCalledTimes(1)
    ctx.unreachable.clear()
    ctx.core.resumeRun()
    await ctx.flush()
    expect(ctx.runs).toHaveLength(2)
  })

  it('skips a job whose destination exists under the skip rule (T7)', async () =>
  {
    const ctx = setup({ jobs: 1, policy: { conflict: 'skip' } })
    const [id] = ctx.ids
    ctx.stats.set('D:\\out\\file-1.mp4', { size: 1, mtimeMs: 1, isFile: true, isDirectory: false, dev: '2', ino: '2' })
    ctx.start()
    await ctx.flush()
    expect(ctx.job(id)).toMatchObject({ state: 'skipped', reason: 'output-exists' })
  })

  it('holds back the tenth of sixteen 5 GB jobs on 50 GB free by committed bytes', async () =>
  {
    const ctx = setup({ jobs: 16, workers: 16, plan: { reserve: 5 * GB, class: 'audio' } })
    ctx.free.set('d:\\', 50 * GB)
    ctx.start()
    await ctx.flush()
    expect(ctx.runs).toHaveLength(9)
    const tenth = ctx.job(ctx.ids[9])
    expect(tenth).toMatchObject({ state: 'queued', waiting: 'disk-space', waitingOn: 'D:' })
    expect(ctx.core.run().status).toBe('running')
    const run = ctx.runOf(ctx.ids[0])
    toStage(ctx, ctx.ids[0], 'verify')
    run.resolve(output(run.ctx))
    await ctx.flush()
    expect(ctx.runs).toHaveLength(10)
  })

  it('auto-pauses with disk-space when a volume is short and nothing on it is active', async () =>
  {
    const ctx = setup({ jobs: 1, plan: { reserve: 5 * GB } })
    ctx.free.set('d:\\', 1 * GB)
    ctx.start()
    await ctx.flush()
    expect(ctx.job(ctx.ids[0]).waiting).toBe('disk-space')
    expect(ctx.core.run()).toMatchObject({ status: 'paused', pause: { reason: 'disk-space' } })
    expect(ctx.core.alerts().map((a) => a.kind)).toEqual(['disk-space'])
    expect(ctx.notify).toHaveBeenCalled()
  })

  it('auto-pauses with storage when the work folder cannot be registered, keeping the job queued', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.setCreate('storage-failed')
    ctx.start()
    await ctx.flush()
    expect(ctx.job(ctx.ids[0]).state).toBe('queued')
    expect(ctx.core.run().pause?.reason).toBe('storage')
    expect(ctx.core.alerts().map((a) => a.kind)).toEqual(['storage-error'])
  })

  it('auto-pauses with ffmpeg-unavailable when no build is available', async () =>
  {
    const ctx = setup({ jobs: 1, noFfmpeg: true })
    ctx.start()
    await ctx.flush()
    expect(ctx.core.run().pause?.reason).toBe('ffmpeg-unavailable')
    expect(ctx.runs).toHaveLength(0)
  })

  it('releases the claim when a check throws', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.planner.statfs.mockRejectedValueOnce(new Error('boom'))
    ctx.start()
    await ctx.flush()
    expect(ctx.core.isClaimed(ctx.ids[0])).toBe(false)
    expect(ctx.log.lines.some((l) => l.level === 'error' && l.message.includes('boom'))).toBe(true)
  })

  it('gives every FFmpeg child the configured priority through the spawn hook', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const run = ctx.runs[0]
    await run.ctx.exec.run(['-version'], { stop: 'kill' } as ExecOptions)
    expect(ctx.setPriority).toHaveBeenCalledWith(4321, 'below-normal')
    expect(ctx.exec.run).toHaveBeenCalledWith(['-version'], expect.objectContaining({ signal: run.ctx.signal }))
  })
})

describe('execution', () =>
{
  it('maps stage reports to states and commits T20 then T23 through placement', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.start()
    await ctx.flush()
    const run = ctx.runOf(id)
    expect(run.job.policy.rev).toBe(1)
    run.ctx.stage({ id: 'measure', pass: 1, passes: 1, label: 'Measuring' })
    expect(ctx.job(id)).toMatchObject({ state: 'analyzing', stage: { id: 'measure' } })
    run.ctx.stage({ id: 'encode', pass: 1, passes: 2, label: 'Encoding 1 of 2' })
    expect(ctx.job(id).state).toBe('encoding')
    run.ctx.progress({ outTimeSec: 5, durationSec: 10, speed: 2, bytes: 100 })
    expect(ctx.job(id).progress).toMatchObject({ stage: 'encode', stagePercent: 50, etaSec: 2.5, bytesWritten: 100 })
    run.ctx.progress({ outTimeSec: null, durationSec: 0, speed: 0, bytes: null })
    expect(ctx.job(id).progress).toMatchObject({ stagePercent: null, speed: null, etaSec: null })
    run.ctx.stage({ id: 'encode', pass: 2, passes: 2, label: 'Encoding 2 of 2' })
    expect(ctx.job(id).stage).toMatchObject({ id: 'encode', pass: 2 })
    run.ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' })
    expect(ctx.job(id).state).toBe('verifying')
    run.ctx.stage({ id: 'place', pass: 1, passes: 1, label: 'Placing' })
    expect(ctx.warnings().some((w) => w.includes('Ignored stage place'))).toBe(true)
    expect(run.ctx.output('mp4', 1).startsWith(run.ctx.workDir)).toBe(true)
    expect(run.ctx.outputFolder('frames')).toBe(`${run.ctx.workDir}\\frames`)
    expect(run.ctx.now()).toBe(1_000)
    await run.ctx.probe('C:\\media\\file-1.mp4')
    run.ctx.measured({ pass: 'source', measuredAt: 1, streams: [], album: null, messages: [] } as JobMeasurement)
    expect(ctx.job(id).measurement).toMatchObject({ pass: 'source' })
    run.resolve(output(run.ctx))
    await ctx.flush()
    expect(ctx.job(id).state).toBe('done')
    expect(ctx.placements[0]).toMatchObject({ jobId: id, execution: 1, transition: 'T20', verdict: 'verified', workDir: run.ctx.workDir })
    expect(ctx.placements[0].isReserved?.('D:\\out\\file-1.mp4')).toBe(false)
    expect(ctx.core.run().status).toBe('idle')
    run.ctx.measured({ pass: 'source', measuredAt: 2, streams: [], album: null, messages: [] } as JobMeasurement)
    run.ctx.progress({ outTimeSec: 1, durationSec: 1, speed: 1, bytes: 1 })
    expect(ctx.job(id).measurement?.measuredAt).toBe(1)
  })

  it('walks a runner that reports no stages through to verifying before the commit', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.start()
    await ctx.flush()
    const run = ctx.runOf(id)
    run.resolve({ ...output(run.ctx), measurement: { pass: 'source', measuredAt: 1, streams: [], album: null, messages: [] } } as RunOutcome)
    await ctx.flush()
    expect(ctx.job(id).state).toBe('done')
    expect(ctx.job(id).measurement).not.toBeNull()
    expect(ctx.job(id).verification?.verdict).toBe('verified')
  })

  it('holds an outside-tolerance output that would overwrite (T21) and fails a failed verdict (T22)', async () =>
  {
    const ctx = setup({ jobs: 2, plan: { resolution: 'overwrite' } })
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    toStage(ctx, a, 'verify')
    toStage(ctx, b, 'verify')
    ctx.runOf(a).resolve(output(ctx.runOf(a).ctx, { ...VERIFIED, verdict: 'outside-tolerance' }))
    ctx.runOf(b).resolve(output(ctx.runOf(b).ctx, { ...VERIFIED, verdict: 'failed' }))
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'held', hold: { reason: 'outside-tolerance' } })
    expect(ctx.job(b)).toMatchObject({ state: 'failed', error: { code: 'output-unreadable' } })
  })

  it('maps placement holds to T24 and a throwing placement to T25', async () =>
  {
    const ctx = setup({ jobs: 2 })
    ctx.setPlace(async (request) =>
    {
      if (request.source.endsWith('file-1.mp4'))
      {
        return { status: 'held', reason: 'destination-appeared', message: 'It appeared', outputPath: request.outputPath, displaces: null, code: null }
      }
      throw new Error('EPERM')
    })
    ctx.start()
    await ctx.flush()
    for (const id of ctx.ids)
    {
      toStage(ctx, id, 'verify')
      ctx.runOf(id).resolve(output(ctx.runOf(id).ctx))
    }
    await ctx.flush()
    expect(ctx.job(ctx.ids[0])).toMatchObject({ state: 'held', hold: { reason: 'destination-appeared', actions: ['keep-renamed', 'discard', 'retry'] } })
    expect(ctx.job(ctx.ids[1])).toMatchObject({ state: 'failed', error: { code: 'internal', stage: 'place' } })
  })

  it('records kept warnings, shows the wait-lock stage, and protects a finalizing folder from the sweep', async () =>
  {
    const ctx = setup({ jobs: 2, workers: 2 })
    const [id, other] = ctx.ids
    const gate = deferred<FinalizeResult>()
    ctx.setPlace(() => gate.promise)
    ctx.start()
    await ctx.flush()
    const run = ctx.runOf(id)
    toStage(ctx, id, 'verify')
    run.resolve(output(run.ctx))
    await ctx.flush()
    expect(ctx.job(id).state).toBe('finalizing')
    expect(ctx.core.recordAbort(id, 'cancel')).toBe(false)
    ctx.placements[0].onWaitLock?.('D:\\out\\file-1.mp4')
    expect(ctx.job(id).stage?.id).toBe('wait-lock')
    expect(ctx.placements[0].isReserved?.('D:\\out\\file-2.mp4')).toBe(true)
    ctx.core.recordAbort(other, 'cancel')
    ctx.runOf(other).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.sweeps.length).toBeGreaterThan(0)
    const protect = ctx.sweeps[ctx.sweeps.length - 1].protect
    expect(protect({ path: ctx.job(id).workDir as string, jobId: id, attempt: 1, execution: 1, token: 'none', at: 0 })).toBe(true)
    expect(protect({ path: 'D:\out\.molex-old', jobId: other, attempt: 1, execution: 1, token: 'none', at: 0 })).toBe(false)
    gate.resolve({ status: 'done', finalPath: 'D:\\out\\file-1.mp4', placement: { kind: 'new' }, warnings: ['original-kept', 'previous-kept'], previous: null, copied: false, workDirRemoved: true })
    await ctx.flush()
    expect(ctx.job(id).warnings.map((w) => w.code)).toEqual(['original-kept', 'previous-kept'])
  })

  it('holds placement with storage-unavailable when the move to finalizing is not durable', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.start()
    await ctx.flush()
    const run = ctx.runOf(id)
    toStage(ctx, id, 'verify')
    const original = ctx.core.transition
    ctx.core.transition = ((jobId, from, trig, opts) =>
    {
      const result = original(jobId, from, trig, opts)
      return trig === 'verified' && result.applied ? { ...result, durable: Promise.resolve(false) } : result
    }) as typeof original
    run.resolve(output(run.ctx))
    await ctx.flush()
    expect(ctx.job(id)).toMatchObject({ state: 'held', hold: { reason: 'storage-unavailable', actions: ['keep', 'discard', 'retry'] } })
    expect(ctx.finalizer.place).not.toHaveBeenCalled()
  })

  it('fails a job whose runner reports a failure, stops without an abort, or rejects', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 3 })
    ctx.start()
    await ctx.flush()
    const [a, b, c] = ctx.ids
    toStage(ctx, b, 'encode')
    ctx.runOf(b).resolve(failure({ code: 'ffmpeg-failed', stage: 'encode' }))
    ctx.runOf(a).resolve({ kind: 'aborted' })
    ctx.runOf(c).reject(new Error('kaboom'))
    await ctx.flush()
    expect(ctx.job(b)).toMatchObject({ state: 'failed', error: { code: 'ffmpeg-failed' } })
    expect(ctx.job(a)).toMatchObject({ state: 'failed', error: { code: 'internal' } })
    expect(ctx.job(c)).toMatchObject({ state: 'failed', error: { code: 'internal' } })
    expect(ctx.job(c).error?.message).toContain('kaboom')
  })

  it('fails a job whose runner throws synchronously', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    const runner = ctx.runnerRun
    runner.mockImplementationOnce(() =>
    {
      throw new Error('sync')
    })
    await ctx.flush()
    expect(ctx.job(ctx.ids[0])).toMatchObject({ state: 'failed', error: { code: 'internal' } })
  })
})

describe('pause', () =>
{
  it('finish-running: pausing while jobs run, then paused, and nothing new starts', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 1 })
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    expect(ctx.core.pauseRun('finish-running', 'user')).toBe(true)
    expect(ctx.core.run().status).toBe('pausing')
    expect(ctx.albums.pause).toHaveBeenCalledWith('finish-running')
    toStage(ctx, a, 'verify')
    ctx.runOf(a).resolve(output(ctx.runOf(a).ctx))
    await ctx.flush()
    expect(ctx.job(a).state).toBe('done')
    expect(ctx.core.run().status).toBe('paused')
    expect(ctx.job(b).state).toBe('queued')
    expect(ctx.runs).toHaveLength(1)
    ctx.core.resumeRun()
    await ctx.flush()
    expect(ctx.analysis.resume).toHaveBeenCalled()
    expect(ctx.runOf(b)).toBeDefined()
  })

  it('stop-running: requeues at the head with the same attempt, restarts + 1, and a new execution folder', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 2 })
    ctx.setSweep(() => new Promise(() => undefined) as never)
    ctx.start()
    await ctx.flush()
    const [a, b, c] = ctx.ids
    toStage(ctx, b, 'encode')
    const oldFolder = ctx.job(a).workDir as string
    ctx.core.pauseRun('stop-running', 'user')
    expect(ctx.job(a).abort).toBe('requeue')
    expect(ctx.runOf(a).ctx.signal.aborted).toBe(true)
    expect(ctx.runOf(b).ctx.signal.aborted).toBe(true)
    expect(ctx.core.run().status).toBe('pausing')
    ctx.runOf(a).resolve({ kind: 'aborted' })
    ctx.runOf(b).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'queued', reason: 'requeued-pause', attempt: 1, restarts: 1, abort: null })
    expect(ctx.job(b)).toMatchObject({ state: 'queued', reason: 'requeued-pause', attempt: 1, restarts: 1 })
    expect(ctx.core.queue.order().indexOf(c)).toBe(2)
    expect(ctx.core.run().status).toBe('paused')
    expect(ctx.sweeps.some((s) => s.only({ path: oldFolder, jobId: a, attempt: 1, execution: 1, token: 't1', at: 0 }))).toBe(true)
    ctx.core.resumeRun()
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'analyzing', execution: 2 })
    expect(ctx.job(a).workDir).not.toBe(oldFolder)
    expect(ctx.job(a).workDir).toContain('-x2')
  })

  it('pause now during a verify finishes the verify and turns a corrective encode into a requeue', async () =>
  {
    const ctx = setup({ jobs: 2, workers: 2 })
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    toStage(ctx, a, 'verify')
    toStage(ctx, b, 'verify')
    ctx.core.pauseRun('stop-running', 'user')
    expect(ctx.job(a).abort).toBeNull()
    expect(ctx.job(b).abort).toBeNull()
    expect(ctx.core.run().status).toBe('pausing')
    ctx.runOf(a).ctx.stage({ id: 'encode', pass: 2, passes: 2, label: 'Corrective encode' })
    expect(ctx.job(a)).toMatchObject({ state: 'verifying', abort: 'requeue' })
    ctx.runOf(a).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'queued', reason: 'requeued-pause', restarts: 1 })
    expect(ctx.core.run().status).toBe('pausing')
    ctx.runOf(b).resolve(output(ctx.runOf(b).ctx))
    await ctx.flush()
    expect(ctx.job(b).state).toBe('done')
    expect(ctx.core.run().status).toBe('paused')
  })

  it('a corrective encode outside pause now moves verifying back to encoding (T19)', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    toStage(ctx, id, 'verify')
    ctx.runOf(id).ctx.stage({ id: 'encode', pass: 2, passes: 2, label: 'Corrective encode' })
    expect(ctx.job(id)).toMatchObject({ state: 'encoding', stage: { pass: 2 } })
  })

  it('voids claims when the run pauses during the checks', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const gate = deferred<FileStat | null>()
    ctx.stats.set('C:\\media\\file-1.mp4', gate.promise)
    ctx.start()
    await ctx.flush()
    ctx.core.pauseRun('finish-running', 'user')
    gate.resolve({ size: 1000, mtimeMs: 1700000000000, isFile: true, isDirectory: false, dev: '1', ino: '1' })
    await ctx.flush()
    expect(ctx.job(ctx.ids[0]).state).toBe('queued')
    expect(ctx.core.run().status).toBe('paused')
    expect(ctx.runs).toHaveLength(0)
  })
})

describe('cancel', () =>
{
  it.each(['analyzing', 'encoding', 'verifying'] as const)('cancels in %s with the abort emitted before the state change', async (state) =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    if (state !== 'analyzing')
    {
      toStage(ctx, id, state === 'encoding' ? 'encode' : 'verify')
    }
    expect(ctx.job(id).state).toBe(state)
    const from = ctx.drafts().length
    expect(ctx.core.recordAbort(id, 'cancel')).toBe(true)
    expect(ctx.runOf(id).ctx.signal.aborted).toBe(true)
    ctx.runOf(id).ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'late' })
    ctx.runOf(id).resolve({ kind: 'aborted' })
    await ctx.flush()
    const events = ctx.drafts().slice(from).filter((e) => 'jobId' in e && e.jobId === id)
    const abortAt = events.findIndex((e) => e.type === 'job.updated' && (e.patch as { abort?: unknown }).abort === 'cancel')
    const stateAt = events.findIndex((e) => e.type === 'job.state' && e.to === 'canceled')
    expect(abortAt).toBeGreaterThanOrEqual(0)
    expect(stateAt).toBeGreaterThan(abortAt)
    expect(ctx.job(id)).toMatchObject({ state: 'canceled', abort: null })
  })

  it('skips a running job (T15)', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    ctx.core.recordAbort(id, 'skip')
    ctx.runOf(id).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.job(id).state).toBe('skipped')
    expect(ctx.albums.memberLeft).toHaveBeenCalledWith(id)
  })

  it('discards a runner result that arrives in the turn after the cancel ran', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    toStage(ctx, id, 'verify')
    ctx.core.recordAbort(id, 'cancel')
    ctx.runOf(id).resolve(output(ctx.runOf(id).ctx))
    await ctx.flush()
    expect(ctx.job(id).state).toBe('canceled')
    expect(ctx.finalizer.place).not.toHaveBeenCalled()
  })

  it('refuses a cancel once the result committed T20', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    toStage(ctx, id, 'verify')
    ctx.runOf(id).resolve(output(ctx.runOf(id).ctx))
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.job(id).state).toBe('finalizing')
    expect(ctx.core.recordAbort(id, 'cancel')).toBe(false)
    await ctx.flush()
    expect(ctx.job(id).state).toBe('done')
  })

  it('settles a job whose child does not close 10 s after the kill and reports the folder as cleanup-pending', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.setSweep((entries) => ({ results: entries.map((e) => ({ path: 'D:\\out\\.molex-stuck', jobId: e.jobId, token: e.token as string, outcome: 'pending' as const, code: 'EBUSY' })), deleted: 0, pending: 1, kept: 0 }))
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    ctx.core.recordAbort(id, 'cancel')
    await ctx.timers.advance(STUCK_CHILD_MS - 1)
    expect(ctx.job(id).state).toBe('analyzing')
    await ctx.timers.advance(1)
    await ctx.flush()
    expect(ctx.job(id).state).toBe('canceled')
    expect(ctx.core.alerts()).toEqual([expect.objectContaining({ kind: 'cleanup-pending', path: 'D:\\out\\.molex-stuck' })])
    ctx.runOf(id).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.job(id).state).toBe('canceled')
  })

  it('waits the POSIX kill grace on top of the stuck-child limit', async () =>
  {
    const ctx = setup({ jobs: 1, platform: 'linux' })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    ctx.core.recordAbort(id, 'cancel')
    await ctx.timers.advance(STUCK_CHILD_MS)
    expect(ctx.job(id).state).toBe('analyzing')
    await ctx.timers.advance(POSIX_KILL_GRACE_MS)
    expect(ctx.job(id).state).toBe('canceled')
  })

  it('cancels the run: queued jobs at once, running jobs once their children exit, analysis and album tasks stopped', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 2 })
    ctx.start()
    await ctx.flush()
    const [a, b, c] = ctx.ids
    ctx.analysisRunning.push(c)
    ctx.core.cancelRun()
    expect(ctx.job(c).state).toBe('canceled')
    expect(ctx.albums.cancelRun).toHaveBeenCalled()
    expect(ctx.analysis.cancel).toHaveBeenCalledWith(c)
    ctx.runOf(a).resolve({ kind: 'aborted' })
    ctx.runOf(b).resolve(output(ctx.runOf(b).ctx))
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'canceled', reason: 'run-canceled' })
    expect(ctx.job(b)).toMatchObject({ state: 'canceled', reason: 'run-canceled' })
    expect(ctx.core.run().status).toBe('idle')
  })

  it('quit now voids claims and stops every child, and dispatches nothing after', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 2 })
    const gate = deferred<FileStat | null>()
    ctx.stats.set('C:\\media\\file-2.mp4', gate.promise)
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    ctx.scheduler.quitNow()
    expect(ctx.core.isClaimed(b)).toBe(false)
    expect(ctx.runOf(a).ctx.signal.aborted).toBe(true)
    expect(ctx.analysis.quitNow).toHaveBeenCalled()
    ctx.core.interruptActive('quit')
    ctx.runOf(a).resolve({ kind: 'aborted' })
    gate.resolve(null)
    await ctx.flush()
    expect(ctx.job(a).state).toBe('interrupted')
    expect(ctx.job(b).state).toBe('queued')
    ctx.scheduler.trigger('queued')
    await ctx.flush()
    expect(ctx.runs).toHaveLength(1)
    ctx.scheduler.dispose()
  })
})

describe('gpu', () =>
{
  it('a session error lowers the budget, raises an alert, requeues once, and fails the second time', async () =>
  {
    const ctx = setup({ jobs: 2, workers: 4, plan: { gpu: true } })
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    expect(ctx.runOf(a).ctx.gpu?.encoder).toBe('h264_nvenc')
    toStage(ctx, a, 'encode')
    toStage(ctx, b, 'encode')
    ctx.runOf(b).resolve(failure({ stderrTail: '[h264_nvenc] OpenEncodeSessionEx failed: out of memory' }))
    await ctx.flush()
    expect(ctx.job(b)).toMatchObject({ state: 'queued', reason: 'requeued-gpu', restarts: 1, attempt: 1 })
    expect(ctx.budget.limit).toBe(1)
    expect(ctx.core.alerts()).toEqual([expect.objectContaining({ kind: 'gpu-sessions', message: expect.stringContaining('limited to 1') })])
    toStage(ctx, a, 'verify')
    ctx.runOf(a).resolve(output(ctx.runOf(a).ctx))
    await ctx.flush()
    expect(ctx.job(b)).toMatchObject({ state: 'analyzing', execution: 2 })
    toStage(ctx, b, 'encode', 1)
    ctx.runOf(b, 1).resolve(failure({ stderrTail: 'OpenEncodeSessionEx failed' }))
    await ctx.flush()
    expect(ctx.job(b)).toMatchObject({ state: 'failed', error: { code: 'gpu-session-limit', hint: expect.stringContaining('GPU') } })
  })

  it('an init failure under auto requeues on the CPU fallback as video-cpu in a new folder and ends with ran-on-cpu', async () =>
  {
    const ctx = setup({ jobs: 1, plan: { gpu: true } })
    ctx.start()
    await ctx.flush()
    const [id] = ctx.ids
    const first = ctx.runOf(id)
    toStage(ctx, id, 'encode')
    first.resolve(failure({ stderrTail: '[h264_qsv] Error creating a MFX session: -9.' }))
    await ctx.flush()
    expect(ctx.drafts().some((e) => e.type === 'job.state' && e.jobId === id && e.reason === 'requeued-cpu')).toBe(true)
    const second = ctx.runOf(id, 1)
    expect(second.job.plan.class).toBe('video-cpu')
    expect(second.job.plan.video?.encoder).toBe('libx264')
    expect(second.ctx.gpu).toBeNull()
    expect(second.ctx.workDir).not.toBe(first.ctx.workDir)
    expect(ctx.job(id).restarts).toBe(1)
    toStage(ctx, id, 'verify', 1)
    second.resolve(output(second.ctx))
    await ctx.flush()
    expect(ctx.job(id).state).toBe('done')
    expect(ctx.job(id).warnings).toEqual([expect.objectContaining({ code: 'ran-on-cpu', message: 'GPU encoding failed to start; encoded with libx264.' })])
  })

  it('an init failure without a fallback fails with gpu-init-failed, and other failures fail as reported', async () =>
  {
    const ctx = setup({ jobs: 2, plan: { gpu: true, fallback: false } })
    ctx.start()
    await ctx.flush()
    const [a, b] = ctx.ids
    ctx.runOf(a).resolve(failure({ stderrTail: 'AMF failed to initialise' }))
    ctx.runOf(b).resolve(failure({ stderrTail: 'Invalid argument' }))
    await ctx.flush()
    expect(ctx.job(a).error).toMatchObject({ code: 'gpu-init-failed', short: 'GPU failed to start' })
    expect(ctx.job(b).error).toMatchObject({ code: 'ffmpeg-failed' })
  })

  it('executionPlan keeps a plan without a fallback or off the CPU unchanged', () =>
  {
    const job = { inputsRev: 1, source: source('x.mp4') } as Job
    const gpu = planFor(job, { gpu: true })
    expect(executionPlan(gpu, false)).toBe(gpu)
    const cpu = planFor(job)
    expect(executionPlan(cpu, true)).toBe(cpu)
    expect(executionPlan(gpu, true)).toMatchObject({ class: 'video-cpu', video: { encoder: 'libx264', cpuFallback: null } })
  })
})

describe('disk full', () =>
{
  it('the first ENOSPC requeues every analyzing and encoding job on the volume without an attempt; a second fails with disk-full', async () =>
  {
    const ctx = setup({ jobs: 4, workers: 4, plan: (i) => (i === 3 ? { dest: 'E:\\out' } : {}) })
    ctx.start()
    await ctx.flush()
    const [a, b, c, d] = ctx.ids
    toStage(ctx, a, 'encode')
    toStage(ctx, b, 'encode')
    toStage(ctx, d, 'encode')
    ctx.runOf(a).resolve(failure({ stderrTail: 'Error writing trailer: No space left on device' }))
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'queued', reason: 'requeued-disk', attempt: 1, restarts: 1 })
    expect(ctx.job(b).abort).toBe('requeue')
    expect(ctx.job(c).abort).toBe('requeue')
    expect(ctx.job(d).abort).toBeNull()
    expect(ctx.core.run()).toMatchObject({ status: 'pausing', pause: { reason: 'disk-space' } })
    expect(ctx.core.alerts().map((x) => x.kind)).toContain('disk-space')
    ctx.runOf(b).resolve(failure({ fsError: { code: 'ENOSPC', syscall: 'write', path: 'D:\\out\\x' } }))
    ctx.runOf(c).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.job(b)).toMatchObject({ state: 'queued', reason: 'requeued-disk', attempt: 1, restarts: 1 })
    expect(ctx.job(c)).toMatchObject({ state: 'queued', reason: 'requeued-disk', attempt: 1, restarts: 1 })
    toStage(ctx, d, 'verify')
    ctx.runOf(d).resolve(output(ctx.runOf(d).ctx))
    await ctx.flush()
    expect(ctx.job(d).state).toBe('done')
    expect(ctx.core.run().status).toBe('paused')
    ctx.core.resumeRun()
    await ctx.flush()
    toStage(ctx, a, 'encode', 1)
    ctx.runOf(a, 1).resolve(failure({ code: 'disk-full', stderrTail: '' }))
    await ctx.flush()
    expect(ctx.job(a)).toMatchObject({ state: 'failed', error: { code: 'disk-full', short: 'Disk full' } })
  })

  it('isDiskFull reads the code, the Node error, and the FFmpeg line', () =>
  {
    expect(isDiskFull({ code: 'disk-full', stderrTail: '', fsError: null })).toBe(true)
    expect(isDiskFull({ code: 'ffmpeg-failed', stderrTail: 'x', fsError: { code: 'ENOSPC', syscall: 'write', path: 'p' } })).toBe(true)
    expect(isDiskFull({ code: 'ffmpeg-failed', stderrTail: 'No space left on device', fsError: null })).toBe(true)
    expect(isDiskFull({ code: 'ffmpeg-failed', stderrTail: 'Invalid data', fsError: null })).toBe(false)
  })
})

describe('workers', () =>
{
  it('raising the workers dispatches at once; lowering lets running jobs finish first', async () =>
  {
    const ctx = setup({ jobs: 4, workers: 1 })
    ctx.start()
    await ctx.flush()
    expect(ctx.runs).toHaveLength(1)
    ctx.core.setSettings({ ...SETTINGS, workers: { mode: 'fixed', count: 3 } })
    ctx.scheduler.trigger('workers')
    await ctx.flush()
    expect(ctx.runs).toHaveLength(3)
    expect(ctx.core.run().workers.limits.total).toBe(3)
    ctx.core.setSettings({ ...SETTINGS, workers: { mode: 'fixed', count: 1 } })
    ctx.scheduler.trigger('workers')
    await ctx.flush()
    const [a, b] = ctx.ids
    toStage(ctx, a, 'verify')
    ctx.runOf(a).resolve(output(ctx.runOf(a).ctx))
    await ctx.flush()
    expect(ctx.runs).toHaveLength(3)
    toStage(ctx, b, 'verify')
    ctx.runOf(b).resolve(output(ctx.runOf(b).ctx))
    await ctx.flush()
    expect(ctx.runs).toHaveLength(3)
    expect(ctx.scheduler.running()).toHaveLength(1)
  })

  it('reports the volume a running job writes to', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    expect(ctx.scheduler.volumeOf(ctx.ids[0])).toBe('d:\\')
    expect(ctx.scheduler.volumeOf('nope' as JobId)).toBeNull()
  })
})

describe('album', () =>
{
  function albumStub(states: { phase: 'idle' | 'measuring' | 'planned' | 'failed' }, members: () => JobId[])
  {
    const stub: SchedulerAlbums & { claims: JobId[] } = {
      claims: [],
      waitingOf: (id) => (members().includes(id) && states.phase === 'measuring' ? 'album' : undefined),
      claim: (id): AlbumClaim =>
      {
        stub.claims.push(id)
        if (!members().includes(id)) return { kind: 'none' }
        if (states.phase === 'idle')
        {
          states.phase = 'measuring'
          return { kind: 'started', groupId: 'g1', waiting: members() }
        }
        if (states.phase === 'measuring') return { kind: 'waiting', groupId: 'g1' }
        if (states.phase === 'failed') return { kind: 'failed', groupId: 'g1' }
        return { kind: 'ready', groupId: 'g1', handle: { groupId: 'g1', members: members().length, measurement: async () => null } }
      },
      memberLeft: vi.fn(),
      pause: vi.fn(),
      cancelRun: vi.fn(),
      slots: () => (states.phase === 'measuring' ? [{ kind: 'album', class: 'audio' }] : [])
    }
    return stub
  }

  it('passes the first member slot to the album task with one worker, then runs the members with their handle', async () =>
  {
    const states = { phase: 'idle' as 'idle' | 'measuring' | 'planned' | 'failed' }
    let members: JobId[] = []
    const albums = albumStub(states, () => members)
    const ctx = setup({ jobs: 2, workers: 1, albums, plan: { class: 'audio' } })
    members = ctx.ids
    ctx.start()
    await ctx.flush()
    expect(ctx.runs).toHaveLength(0)
    for (const id of ctx.ids)
    {
      expect(ctx.job(id)).toMatchObject({ state: 'queued', waiting: 'album' })
    }
    expect(ctx.core.claims()).toEqual([])
    states.phase = 'planned'
    ctx.scheduler.albumSettled({ kind: 'planned', groupId: 'g1', summary: {} as never, ready: ctx.ids })
    await ctx.flush()
    expect(ctx.job(ctx.ids[1]).waiting).toBeNull()
    expect(ctx.runs).toHaveLength(1)
    expect(ctx.runs[0].ctx.album?.groupId).toBe('g1')
  })

  it('a member claimed while the task measures waits, and a failed measure fails every queued member', async () =>
  {
    const states = { phase: 'measuring' as 'idle' | 'measuring' | 'planned' | 'failed' }
    let members: JobId[] = []
    const albums = albumStub(states, () => members)
    albums.waitingOf = () => undefined
    const ctx = setup({ jobs: 3, workers: 2, albums, plan: { class: 'audio' } })
    members = ctx.ids.slice(0, 2)
    ctx.start()
    await ctx.flush()
    expect(ctx.job(ctx.ids[0]).waiting).toBe('album')
    states.phase = 'failed'
    ctx.scheduler.albumSettled({ kind: 'failed', groupId: 'g1', code: 'album-measure-failed', fail: ctx.ids.slice(0, 2), error: new Error('decode') })
    await ctx.flush()
    expect(ctx.job(ctx.ids[0])).toMatchObject({ state: 'failed', error: { code: 'album-measure-failed', short: 'Album measure failed' } })
    expect(ctx.job(ctx.ids[1])).toMatchObject({ state: 'failed', error: { code: 'album-measure-failed' } })
    ctx.scheduler.albumSettled({ kind: 'aborted', groupId: 'g1' })
    ctx.scheduler.albumSettled({ kind: 'stopped', groupId: 'g1', waiting: [] })
    await ctx.flush()
  })

  it('a canceled album task cancels its queued members', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.core.batch(() =>
    {
      ctx.core.transition(ctx.ids[0], ['pending'], 'start', { change: { runId: RUN } })
      ctx.core.startRun(RUN)
    })
    ctx.scheduler.albumSettled({ kind: 'canceled', groupId: 'g1', cancel: [ctx.ids[0]] })
    expect(ctx.job(ctx.ids[0])).toMatchObject({ state: 'canceled', reason: 'run-canceled' })
  })
})

describe('analysis', () =>
{
  it('starts analysis tasks in the slots left after queued jobs and lands their results', async () =>
  {
    const pending: JobId[] = []
    const started: JobId[] = []
    const analysis: SchedulerAnalysis = {
      pending: () => pending.filter((id) => !started.includes(id)),
      running: () => started,
      slots: () => started.map(() => ({ kind: 'analysis' as const, class: 'audio' as const })),
      start: (id) =>
      {
        started.push(id)
        return true
      },
      cancel: vi.fn(() => true),
      claimed: vi.fn(),
      pause: vi.fn(),
      quitNow: vi.fn(),
      resume: vi.fn()
    }
    const ctx = setup({ jobs: 3, workers: 3, analysis })
    pending.push(ctx.ids[1], ctx.ids[2])
    ctx.scheduler.trigger('analysis')
    await ctx.flush()
    expect(started).toEqual([ctx.ids[1], ctx.ids[2]])
    expect(ctx.job(ctx.ids[1]).analysis).toBe('running')
    const measurement = { pass: 'preview', measuredAt: 5, streams: [], album: null, messages: [] } as JobMeasurement
    ctx.scheduler.analysisSettled({ kind: 'measured', jobId: ctx.ids[1], measurement, analysis: {} as never })
    ctx.scheduler.analysisSettled({ kind: 'failed', jobId: ctx.ids[2], error: new Error('bad') })
    ctx.scheduler.analysisSettled({ kind: 'stopped', jobId: ctx.ids[0] })
    ctx.scheduler.analysisSettled({ kind: 'stopped', jobId: 'gone' as JobId })
    expect(ctx.job(ctx.ids[1])).toMatchObject({ analysis: null, measurement: { pass: 'preview' } })
    expect(ctx.job(ctx.ids[2]).analysis).toBeNull()
    expect(ctx.job(ctx.ids[0]).analysis).toBe('queued')
    ctx.start([ctx.ids[0]])
    await ctx.flush()
    expect(analysis.claimed).toHaveBeenCalledWith(ctx.ids[0])
  })

  it('pause now stops the analysis tasks', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.start()
    await ctx.flush()
    ctx.core.pauseRun('stop-running', 'user')
    expect(ctx.analysis.pause).toHaveBeenCalledWith('stop-running')
  })
})

describe('rechecks', () =>
{
  it('a job leaving a short volume releases the jobs waiting for space there', async () =>
  {
    const ctx = setup({ jobs: 3, workers: 3, plan: { reserve: 5 * GB } })
    ctx.free.set('d:\\', 8 * GB)
    ctx.start()
    await ctx.flush()
    expect(ctx.runs).toHaveLength(1)
    const waiting = ctx.ids.slice(1).map((id) => ctx.job(id).waiting)
    expect(waiting).toEqual(['disk-space', 'disk-space'])
    expect(ctx.core.run().status).toBe('running')
    ctx.core.recordAbort(ctx.ids[0], 'cancel')
    ctx.runOf(ctx.ids[0]).resolve({ kind: 'aborted' })
    await ctx.flush()
    expect(ctx.runs).toHaveLength(2)
  })

  it('a run started from idle resets the GPU budget', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const spy = vi.spyOn(ctx.budget, 'runStarted')
    ctx.start()
    await ctx.flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
