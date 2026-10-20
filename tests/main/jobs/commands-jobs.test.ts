/**
 * The per-job commands over a real engine core: cancel, skip, unqueue, retry, keep and discard of a held output,
 * acknowledge, clear, the attempt log, and reveal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEngineCore, type CoreJournal, type CoreJournalEntry, type RunRecord } from '../../../src/main/jobs/core'
import { createJobEventBus } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers, type RemovedJob } from '../../../src/main/jobs/queue'
import { attemptOutcome, createJobCommands, jobRefusalMessage, keepMode, logLines, type JobCommandsDeps } from '../../../src/main/jobs/commands/jobs'
import { engineError } from '../../../src/main/jobs/scheduler'
import type { JobLogger } from '../../../src/main/jobs/deps'
import { createAttemptRing, type AttemptRing } from '../../../src/main/jobs/log'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { CommandError, JobRefusalCode } from '../../../src/shared/jobs/contract'
import type {
  BatchPolicy,
  CapabilitySummary,
  HistoryRecord,
  HistoryRef,
  Job,
  JobHold,
  JobPlan,
  JobResult,
  JobWarning,
  OutputPlan,
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
  setting: { mode: 'fixed', count: 2 },
  limits: { total: 2, videoCpu: 2, gpu: 2 },
  active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
}

const MTIME = 1700000000000

const PLACED_OUTSIDE: JobWarning = { code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'The output was placed outside tolerance.' }

const LARGER: JobWarning = { code: 'larger-than-source', short: 'Larger', message: 'The output is larger than its source.' }

function recipe(): Recipe
{
  return applyPreset('mp4-h264', OUTPUT) as Recipe
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

function planFor(job: Readonly<Job>, fingerprint = 'fp-1', output: Partial<OutputPlan> = {}): JobPlan
{
  return {
    basis: { inputsRev: job.inputsRev, policyRev: POLICY.rev, capabilitiesRev: CAPS.rev },
    fingerprint,
    source: { path: job.source.path, size: job.source.size, mtimeMs: job.source.mtimeMs },
    output: { kind: 'file', finalPath: `D:\\out\\${job.source.name}`, container: 'mp4', muxer: 'mp4', containerChanged: null, conflict: 'none', resolution: 'place', renamedTo: null, displaces: null, ...output },
    streams: { kept: [], dropped: [], chapters: 'none' },
    video: null,
    audio: [],
    class: 'video-cpu',
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }],
    estimate: { outputBytes: 1000, reserveBytes: 1000, workSec: 1, confidence: 'high' },
    album: null,
    command: null
  }
}

interface SetupOptions
{
  jobs?: number
  run?: RunRecord
}

function setup(options: SetupOptions = {})
{
  const timers = createManualTimers(new Date(2026, 9, 18, 12).getTime())
  const log = fakeLog()
  const bus = createJobEventBus({ timers, log })
  const emit = vi.spyOn(bus, 'emit')
  const queue = new JobQueue({ numbers: numbers(), now: () => timers.now() })
  const core = createEngineCore({
    queue,
    bus,
    journal: journal(),
    log,
    now: () => timers.now(),
    state: {
      policy: POLICY,
      settings: SETTINGS,
      defaultRecipe: recipe(),
      capabilities: CAPS,
      workers: WORKERS,
      presets: { user: [], pins: {}, recent: [] },
      recentFolders: [],
      run: options.run
    },
    summarize: (run) => ({ runId: run.runId }) as never
  })
  const added = core.add(Array.from({ length: options.jobs ?? 3 }, (_, i) => ({ source: source(`file-${i + 1}.mp4`), recipe: recipe() }))) ?? []
  const ids = added.map((job) => job.id)
  let runSeq = 0
  let reportSeq = 0
  const replans = new Map<JobId, RetryPlan>()
  const logs = new Map<string, string>()
  const present = new Set<string>()
  const preflight = vi.fn(async (jobs: ReadonlyArray<Readonly<Job>>, _options: { existing: ReadonlyMap<JobId, string> }): Promise<PreflightReport> =>
  {
    return {
      preflightId: `pf-${++reportSeq}`,
      createdAt: timers.now(),
      policyRev: POLICY.rev,
      capabilitiesRev: CAPS.rev,
      jobs: jobs.map((target) =>
      {
        const current = core.queue.get(target.id) as Job
        const replan = replans.get(target.id) ?? {}
        const status = replan.status ?? 'ready'
        return {
          jobId: target.id,
          inputsRev: replan.inputsRev ?? current.inputsRev,
          status,
          plan: status === 'blocked' ? null : planFor(current, replan.fingerprint ?? current.plan?.fingerprint ?? 'fp-1', replan.output),
          issues: []
        }
      }),
      counts: { jobs: jobs.length, ready: 0, blocked: 0, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0 },
      volumes: [],
      collisions: [],
      blocking: [],
      warnings: [],
      limits: WORKERS.limits
    }
  })
  const deps = {
    core,
    scheduler: { trigger: vi.fn() },
    albums: { memberLeft: vi.fn() },
    preflight,
    binCheck: vi.fn(async (_plans: readonly JobPlan[]): Promise<CommandError | null> => null),
    releaseWorkDir: vi.fn((_jobId: JobId, _workDir: string): Promise<void> => new Promise<void>(() => undefined)),
    nextRunId: vi.fn((): RunId => formatRunId(++runSeq)),
    history: { recordDecision: vi.fn(async (record: HistoryRecord): Promise<HistoryRef> => ({ runId: record.runId, offset: 10, length: 20 })) },
    place: vi.fn((_jobId: JobId, _placement: 'planned' | 'renamed'): void => undefined),
    tombstones: { record: vi.fn((_kind: 'clear', entries: readonly RemovedJob[]): string | null => entries.length > 0 ? 'tomb-1' : null) },
    ring: vi.fn((_jobId: JobId): AttemptRing | null => null),
    readLog: vi.fn(async (path: string): Promise<string | null> => logs.get(path) ?? null),
    exists: vi.fn(async (path: string): Promise<boolean> => present.has(path)),
    showItemInFolder: vi.fn(),
    logsDir: 'C:\\logs',
    quitting: vi.fn(() => false)
  } satisfies JobCommandsDeps
  const commands = createJobCommands(deps)

  function job(id: JobId): Readonly<Job>
  {
    return core.queue.get(id) as Readonly<Job>
  }

  function openRun(): RunId
  {
    const run = core.run()
    return core.startRun(run.status === 'idle' ? formatRunId(++runSeq) : run.runId as RunId) as RunId
  }

  /** Queues pending jobs in the open run, or a new one. */
  function queueJobs(...targets: JobId[]): RunId
  {
    return core.batch(() =>
    {
      const runId = openRun()
      for (const id of targets)
      {
        core.transition(id, ['pending'], 'start', { change: { plan: planFor(job(id)), runId } })
      }
      return runId
    })
  }

  function dispatch(id: JobId): void
  {
    core.transition(id, ['queued'], 'dispatch')
  }

  function toVerifying(id: JobId): void
  {
    queueJobs(id)
    dispatch(id)
    core.transition(id, ['analyzing'], 'measured')
    core.transition(id, ['encoding'], 'encoded')
  }

  function fail(id: JobId): void
  {
    queueJobs(id)
    dispatch(id)
    core.transition(id, ['analyzing'], 'fail', { change: { error: engineError('internal', 'It broke.', 'probe', job(id).attempt, timers.now()) } })
  }

  function result(id: JobId, warnings: JobWarning[]): JobResult
  {
    return {
      outputPath: `D:\\out\\${job(id).source.name}`,
      outputKind: 'file',
      container: 'mp4',
      inputBytes: 1000,
      outputBytes: 900,
      durationSec: 1,
      elapsedMs: 10,
      encoder: { video: 'libx264', audio: [] },
      placement: { kind: 'new' },
      stamp: {} as JobResult['stamp'],
      warnings,
      notes: []
    }
  }

  function finish(id: JobId, warnings: JobWarning[] = [], placement: JobResult['placement'] = { kind: 'new' }): void
  {
    toVerifying(id)
    core.transition(id, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    core.transition(id, ['finalizing'], 'placed', { change: { result: { ...result(id, warnings), placement }, warnings } })
  }

  function hold(id: JobId, overrides: Partial<JobHold> = {}): void
  {
    toVerifying(id)
    const held: JobHold = {
      reason: 'outside-tolerance',
      message: 'The output is outside tolerance.',
      outputPath: `C:\\work\\${id}\\out.mp4`,
      displaces: `D:\\out\\${job(id).source.name}`,
      actions: ['keep', 'keep-renamed', 'discard', 'retry'],
      since: timers.now(),
      ...overrides
    }
    core.transition(id, ['verifying'], 'hold', { change: { hold: held, workDir: `C:\\work\\${id}` } })
  }

  return { timers, log, bus, emit, queue, core, ids, deps, commands, replans, logs, present, job, queueJobs, dispatch, fail, finish, hold, toVerifying }
}

interface RetryPlan
{
  status?: 'ready' | 'blocked' | 'will-skip'
  fingerprint?: string
  inputsRev?: number
  output?: Partial<OutputPlan>
}

function codes(refused: Array<{ code: JobRefusalCode }>): JobRefusalCode[]
{
  return refused.map((entry) => entry.code)
}

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('jobRefusalMessage', () =>
{
  it('words every refusal code these commands give', () =>
  {
    const all: JobRefusalCode[] = ['not-found', 'job-running', 'job-finalizing', 'job-held', 'needs-decision', 'job-terminal', 'not-started', 'not-queued', 'not-held', 'not-retryable', 'needs-attention', 'blocked', 'duplicate']
    for (const code of all)
    {
      const message = jobRefusalMessage(code, 'B0001' as JobId)
      expect(message).toContain('B0001')
      expect(message).not.toMatch(/\u2014/)
    }
  })
})

describe('cancel and skip', () =>
{
  it('cancels a queued job at once (T8) and tells the album tasks the member left', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.queueJobs(a)
    const res = await t.commands.cancel({ ids: [a] })
    expect(res.ok && res.value).toEqual({ applied: [a], refused: [] })
    expect(t.job(a).state).toBe('canceled')
    expect(t.job(a).reason).toBe('user')
    expect(t.deps.albums.memberLeft).toHaveBeenCalledWith(a)
    expect(t.deps.scheduler.trigger).toHaveBeenCalled()
  })

  it('skips a queued job at once (T7)', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.queueJobs(a)
    const res = await t.commands.skip({ ids: [a] })
    expect(res.ok && res.value.applied).toEqual([a])
    expect(t.job(a).state).toBe('skipped')
  })

  it('records the abort of a running job and applies it once the child exits (T14, T15)', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.queueJobs(a, b)
    t.dispatch(a)
    t.dispatch(b)
    const canceled = await t.commands.cancel({ ids: [a] })
    const skipped = await t.commands.skip({ ids: [b] })
    expect(canceled.ok && canceled.value.applied).toEqual([a])
    expect(skipped.ok && skipped.value.applied).toEqual([b])
    expect(t.job(a).state).toBe('analyzing')
    expect(t.job(a).abort).toBe('cancel')
    expect(t.job(b).abort).toBe('skip')
    t.core.settleAbort(a)
    t.core.settleAbort(b)
    expect(t.job(a).state).toBe('canceled')
    expect(t.job(b).state).toBe('skipped')
    expect(t.deps.albums.memberLeft).not.toHaveBeenCalled()
  })

  it('refuses per job by the matrix, once per id, naming the command to use instead', async () =>
  {
    const t = setup({ jobs: 3 })
    const [a, b, c] = t.ids as [JobId, JobId, JobId]
    t.fail(b)
    t.hold(c)
    const res = await t.commands.cancel({ ids: [a, a, b, c, 'B9999' as JobId] })
    expect(res.ok).toBe(true)
    if (!res.ok)
    {
      return
    }
    expect(res.value.applied).toEqual([])
    expect(codes(res.value.refused)).toEqual(['not-started', 'job-terminal', 'job-held', 'not-found'])
    expect(res.value.refused[2]?.message).toContain('Use Discard output instead.')
    const skip = await t.commands.skip({ ids: [c] })
    expect(skip.ok && codes(skip.value.refused)).toEqual(['job-held'])
  })

  it('refuses a finalizing job', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.toVerifying(a)
    t.core.transition(a, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    const res = await t.commands.cancel({ ids: [a] })
    expect(res.ok && codes(res.value.refused)).toEqual(['job-finalizing'])
  })
})

describe('unqueue', () =>
{
  it('moves a queued job back to pending (T5) and refuses the others', async () =>
  {
    const t = setup()
    const [a, b, c] = t.ids as [JobId, JobId, JobId]
    t.queueJobs(a, b)
    t.dispatch(b)
    const res = await t.commands.unqueue({ ids: [a, b, c] })
    expect(res.ok && res.value.applied).toEqual([a])
    expect(res.ok && codes(res.value.refused)).toEqual(['job-running', 'not-queued'])
    expect(t.job(a).state).toBe('pending')
    expect(t.job(a).reason).toBe('user')
    expect(t.deps.albums.memberLeft).toHaveBeenCalledWith(a)
  })

  it('voids a dispatch claim on the job it unqueues', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.queueJobs(a)
    expect(t.core.claim(a)).toBe(true)
    await t.commands.unqueue({ ids: [a] })
    expect(t.core.isClaimed(a)).toBe(false)
    expect(t.core.run().status).toBe('idle')
  })

  it('does not trigger dispatch when nothing left the queue', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    await t.commands.unqueue({ ids: [a] })
    expect(t.deps.scheduler.trigger).not.toHaveBeenCalled()
  })
})

describe('acknowledge', () =>
{
  it('accepts exactly the jobs that need attention and refuses held ones with needs-decision', async () =>
  {
    const t = setup({ jobs: 6 })
    const [failed, warned, clean, held, pending, interrupted] = t.ids as [JobId, JobId, JobId, JobId, JobId, JobId]
    t.fail(failed)
    t.finish(warned, [LARGER])
    t.finish(clean)
    t.hold(held)
    t.queueJobs(interrupted)
    t.dispatch(interrupted)
    t.core.interruptActive('crash')
    const res = await t.commands.acknowledge({ ids: [failed, warned, clean, held, pending, interrupted] })
    expect(res.ok).toBe(true)
    if (!res.ok)
    {
      return
    }
    expect(res.value.applied).toEqual([failed, warned, interrupted])
    expect(codes(res.value.refused)).toEqual(['needs-decision'])
    expect(t.job(failed).acknowledged).toBe(true)
    expect(t.job(warned).acknowledged).toBe(true)
    expect(t.job(clean).acknowledged).toBe(false)
    expect(t.job(held).acknowledged).toBe(false)
    expect(t.job(pending).acknowledged).toBe(false)
    const again = await t.commands.acknowledge({ ids: [failed] })
    expect(again.ok && again.value).toEqual({ applied: [], refused: [] })
  })
})

describe('retry', () =>
{
  it('queues a job whose new plan matches the retried attempt and starts a run when none runs (T29)', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    expect(t.core.run().status).toBe('idle')
    const before = { ...t.job(a) }
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok).toBe(true)
    if (!res.ok)
    {
      return
    }
    expect(res.value).toMatchObject({ applied: [a], refused: [], queued: [a], pending: [], changed: [] })
    expect(res.value.runId).toBe(t.core.run().runId)
    expect(res.value.runId).not.toBe(before.runId)
    const after = t.job(a)
    expect(after.state).toBe('queued')
    expect(after.attempt).toBe(before.attempt + 1)
    expect(after.acknowledged).toBe(false)
    expect(after.error).toBeNull()
    expect(after.attempts).toEqual([expect.objectContaining({ attempt: before.attempt, state: 'failed', errorCode: 'internal', runId: before.runId })])
    expect(t.core.run().status).toBe('running')
    expect(t.deps.scheduler.trigger).toHaveBeenCalledWith('queued')
  })

  it('joins the running batch instead of starting a new one', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    const runId = t.queueJobs(b)
    t.dispatch(b)
    t.fail(a)
    expect(t.core.run().runId).toBe(runId)
    const calls = t.deps.nextRunId.mock.calls.length
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value.runId).toBe(runId)
    expect(t.job(a).runId).toBe(runId)
    expect(t.deps.nextRunId.mock.calls.length).toBe(calls)
  })

  it('returns a changed plan in changed and leaves the job pending with plan-changed (T30)', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    t.replans.set(a, { fingerprint: 'fp-2' })
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value).toMatchObject({ queued: [], pending: [a], changed: [a], runId: null })
    expect(t.job(a).state).toBe('pending')
    expect(t.job(a).reason).toBe('plan-changed')
    expect(t.job(a).attempt).toBe(2)
    expect(t.job(a).plan?.fingerprint).toBe('fp-2')
    expect(t.job(a).runId).toBeNull()
    expect(t.core.run().status).toBe('idle')
  })

  it('treats a changed basis and a skip under the conflict rule as changed', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.fail(b)
    t.replans.set(a, { status: 'will-skip' })
    t.replans.set(b, { inputsRev: 99 })
    const res = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: true })
    expect(res.ok && res.value.changed).toEqual([a, b])
  })

  it('leaves a blocked plan pending with plan-blocked', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    t.replans.set(a, { status: 'blocked' })
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value).toMatchObject({ pending: [a], changed: [] })
    expect(t.job(a).reason).toBe('plan-blocked')
    expect(t.job(a).plan).toBeNull()
  })

  it('retries a done job placed outside tolerance as attempt + 1, its output counted as an existing file', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.finish(a, [PLACED_OUTSIDE])
    t.finish(b)
    const output = t.job(a).result?.outputPath as string
    const res = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: true })
    expect(res.ok).toBe(true)
    if (!res.ok)
    {
      return
    }
    expect(res.value.queued).toEqual([a])
    expect(codes(res.value.refused)).toEqual(['not-retryable'])
    expect(res.value.refused[0]?.message).toContain('Use Duplicate instead.')
    const [jobs, options] = t.deps.preflight.mock.calls[0] as [Array<Readonly<Job>>, { existing: ReadonlyMap<JobId, string> }]
    expect(jobs.map((job) => job.id)).toEqual([a])
    expect([...options.existing]).toEqual([[a, output]])
    expect(t.job(a).attempt).toBe(2)
    expect(t.job(a).warnings).toEqual([])
    expect(t.job(a).result).toBeNull()
    expect(t.job(a).attempts[0]).toMatchObject({ attempt: 1, state: 'done' })
  })

  it('names every failed and interrupted job and every done job placed outside tolerance for failed', async () =>
  {
    const t = setup({ jobs: 6 })
    const [failed, interrupted, outside, clean, canceled, held] = t.ids as [JobId, JobId, JobId, JobId, JobId, JobId]
    t.fail(failed)
    t.queueJobs(interrupted)
    t.dispatch(interrupted)
    t.core.interruptActive('crash')
    t.core.settle()
    t.finish(outside, [PLACED_OUTSIDE])
    t.finish(clean)
    t.queueJobs(canceled)
    await t.commands.cancel({ ids: [canceled] })
    t.hold(held)
    const res = await t.commands.retry({ ids: 'failed', recipe: null, ack: null, start: true })
    expect(res.ok && res.value.queued).toEqual([failed, interrupted, outside])
  })

  it('does nothing when no listed job can be retried', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value).toEqual({ applied: [], refused: [expect.objectContaining({ code: 'not-retryable' })], queued: [], pending: [], changed: [], runId: null })
    expect(t.deps.preflight).not.toHaveBeenCalled()
  })

  it('refuses a running job and a finalizing one', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.queueJobs(a)
    t.dispatch(a)
    t.toVerifying(b)
    t.core.transition(b, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    const res = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: true })
    expect(res.ok && codes(res.value.refused)).toEqual(['job-running', 'job-finalizing'])
  })

  it('needs the destructive counts repeated, then passes the bin check', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.fail(b)
    t.replans.set(a, { output: { conflict: 'exists', resolution: 'overwrite' } })
    t.replans.set(b, { output: { resolution: 'replace-original' } })
    const first = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: true })
    expect(first.ok).toBe(false)
    if (first.ok)
    {
      return
    }
    expect(first.error.code).toBe('confirmation-required')
    expect(first.error.details).toEqual({ preflightId: 'pf-1', originalsAffected: 1, overwrites: 1 })
    expect(t.job(a).state).toBe('failed')
    const wrong = await t.commands.retry({ ids: [a, b], recipe: null, ack: { preflightId: 'pf-1', originalsAffected: 1, overwrites: 0 }, start: true })
    expect(!wrong.ok && wrong.error.code).toBe('confirmation-required')
    const unknown = await t.commands.retry({ ids: [a, b], recipe: null, ack: { preflightId: 'pf-404', originalsAffected: 1, overwrites: 1 }, start: true })
    expect(!unknown.ok && unknown.error.code).toBe('confirmation-required')
    const confirmed = await t.commands.retry({ ids: [a, b], recipe: null, ack: { preflightId: 'pf-2', originalsAffected: 1, overwrites: 1 }, start: true })
    expect(confirmed.ok && confirmed.value.queued).toEqual([a, b])
    expect(t.deps.binCheck).toHaveBeenCalledTimes(1)
    expect((t.deps.binCheck.mock.calls[0]?.[0] ?? []).map((plan) => plan.output.resolution)).toEqual(['overwrite', 'replace-original'])
  })

  it('refuses the whole retry when the bin check fails', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    t.replans.set(a, { output: { resolution: 'replace-original' } })
    const first = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    const preflightId = !first.ok ? (first.error.details as { preflightId: string }).preflightId : ''
    const error: CommandError = { code: 'invalid-state', message: 'The Recycle Bin is not available.', issues: [], details: null }
    t.deps.binCheck.mockResolvedValueOnce(error)
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: { preflightId, originalsAffected: 1, overwrites: 0 }, start: true })
    expect(res).toEqual({ ok: false, error })
    expect(t.job(a).state).toBe('failed')
  })

  it('keeps only the latest retry confirmations', async () =>
  {
    const t = setup({ jobs: 6 })
    const ids = t.ids as JobId[]
    for (const id of ids)
    {
      t.fail(id)
      t.replans.set(id, { output: { resolution: 'overwrite' } })
    }
    for (const id of ids)
    {
      await t.commands.retry({ ids: [id], recipe: null, ack: null, start: true })
    }
    const first = ids[0] as JobId
    const res = await t.commands.retry({ ids: [first], recipe: null, ack: { preflightId: 'pf-1', originalsAffected: 0, overwrites: 1 }, start: true })
    expect(!res.ok && res.error.code).toBe('confirmation-required')
  })

  it('retries a held job while its work folder cannot be deleted yet (T28), recording the decision of a completed run', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    const heldRun = t.job(a).runId
    expect(t.core.run().status).toBe('idle')
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value.queued).toEqual([a])
    expect(t.job(a).state).toBe('queued')
    expect(t.job(a).hold).toBeNull()
    expect(t.job(a).workDir).toBeNull()
    expect(t.job(a).attempts[0]).toMatchObject({ state: 'canceled', attempt: 1 })
    expect(t.deps.releaseWorkDir).toHaveBeenCalledWith(a, `C:\\work\\${a}`)
    expect(t.deps.history.recordDecision).toHaveBeenCalledTimes(1)
    const record = t.deps.history.recordDecision.mock.calls[0]?.[0] as HistoryRecord
    expect(record).toMatchObject({ runId: heldRun, jobId: a, attempt: 1, state: 'canceled' })
    expect(record.logFile).toContain(`${a}-a1.log`)
    await Promise.resolve()
    expect(t.job(a).history).toBeNull()
  })

  it('moves a held job with a changed plan to pending and still releases its folder', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    t.replans.set(a, { fingerprint: 'fp-9' })
    t.deps.releaseWorkDir.mockImplementationOnce(() => Promise.reject(new Error('EBUSY')))
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(res.ok && res.value.changed).toEqual([a])
    expect(t.job(a).state).toBe('pending')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.log.lines.some((line) => line.message.includes('not deleted yet'))).toBe(true)
  })

  it('does not record a decision for a held job of the open run', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.queueJobs(b)
    t.dispatch(b)
    t.hold(a)
    expect(t.core.run().status).toBe('running')
    await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(t.deps.history.recordDecision).not.toHaveBeenCalled()
  })

  it('without start, joins an open run, or waits for Start when none runs', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.hold(b)
    const res = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: false })
    expect(res.ok).toBe(true)
    if (!res.ok)
    {
      return
    }
    expect(res.value).toMatchObject({ queued: [], pending: [a], changed: [], runId: null })
    expect(codes(res.value.refused)).toEqual(['blocked'])
    expect(t.job(a).state).toBe('pending')
    expect(t.job(a).reason).toBe('user')
    expect(t.job(a).plan?.fingerprint).toBe('fp-1')
    expect(t.job(b).state).toBe('held')
    expect(t.core.run().status).toBe('idle')
  })

  it('with new settings, every job waits for Review with them', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.hold(b)
    const inputsRev = t.job(a).inputsRev
    const next = { ...recipe(), label: 'Edited' } as unknown as Recipe
    const res = await t.commands.retry({ ids: [a, b], recipe: next, ack: null, start: true })
    expect(res.ok && res.value).toMatchObject({ applied: [a, b], queued: [], pending: [a, b], changed: [], runId: null })
    expect(t.job(a).state).toBe('pending')
    expect(t.job(a).recipe).toEqual(next)
    expect(t.job(a).inputsRev).toBe(inputsRev + 1)
    expect(t.job(b).reason).toBe('plan-changed')
    expect(t.deps.releaseWorkDir).toHaveBeenCalledWith(b, `C:\\work\\${b}`)
    expect(t.deps.preflight).not.toHaveBeenCalled()
  })

  it('refuses while quitting, while the run cancels, and when the review fails', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.deps.quitting.mockReturnValueOnce(true)
    const quitting = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(!quitting.ok && quitting.error.code).toBe('shutting-down')
    t.deps.preflight.mockRejectedValueOnce(new Error('disk gone'))
    const failed = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(!failed.ok && failed.error.code).toBe('internal')
    t.queueJobs(b)
    t.dispatch(b)
    t.core.cancelRun()
    expect(t.core.run().status).toBe('canceling')
    const canceling = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(!canceling.ok && canceling.error.code).toBe('invalid-state')
    expect(t.job(a).state).toBe('failed')
  })

  it('refuses the run cancel that began during the review', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.queueJobs(b)
    t.dispatch(b)
    t.fail(a)
    t.deps.preflight.mockImplementationOnce(async (jobs) =>
    {
      t.core.cancelRun()
      return { preflightId: 'pf-x', jobs: jobs.map((job) => ({ jobId: job.id, inputsRev: job.inputsRev, status: 'ready', plan: planFor(job), issues: [] })) } as unknown as PreflightReport
    })
    const res = await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    expect(!res.ok && res.error.code).toBe('invalid-state')
  })

  it('answers a job that changed during the review by its new state', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.fail(a)
    t.fail(b)
    t.deps.preflight.mockImplementationOnce(async (jobs) =>
    {
      t.core.remove([a])
      t.core.transition(b, ['failed'], 'edit-retry', { reason: 'user' })
      return { preflightId: 'pf-x', jobs: jobs.map((job) => ({ jobId: job.id, inputsRev: job.inputsRev, status: 'ready', plan: planFor(job), issues: [] })) } as unknown as PreflightReport
    })
    const res = await t.commands.retry({ ids: [a, b], recipe: null, ack: null, start: true })
    expect(res.ok && codes(res.value.refused)).toEqual(['not-found', 'not-retryable'])
  })
})

describe('keepOutput', () =>
{
  it('needs the displaced count repeated for a planned placement, then passes the bin check (T26)', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    const first = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: null })
    expect(first.ok).toBe(false)
    if (first.ok)
    {
      return
    }
    expect(first.error.code).toBe('confirmation-required')
    expect(first.error.details).toEqual({ preflightId: '', originalsAffected: 0, overwrites: 1 })
    expect(t.job(a).state).toBe('held')
    const wrong = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: { displaces: 2 } })
    expect(!wrong.ok && wrong.error.code).toBe('confirmation-required')
    const res = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    expect(res.ok && res.value).toEqual({ applied: [a], refused: [] })
    expect(t.job(a).state).toBe('finalizing')
    expect(t.job(a).acknowledged).toBe(true)
    expect(t.deps.binCheck).toHaveBeenCalledWith([t.job(a).plan])
    expect(t.deps.place).toHaveBeenCalledWith(a, 'planned')
  })

  it('words the confirmation for several files and counts the originals a replace displaces', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.hold(a)
    t.hold(b)
    t.core.update(b, { plan: planFor(t.job(b), 'fp-1', { resolution: 'replace-original' }) })
    const res = await t.commands.keepOutput({ ids: [a, b], placement: 'planned', confirm: null })
    expect(!res.ok && res.error.message).toContain('2 files')
    expect(!res.ok && res.error.details).toEqual({ preflightId: '', originalsAffected: 1, overwrites: 1 })
  })

  it('keeps under a free name without a confirmation', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    const res = await t.commands.keepOutput({ ids: [a], placement: 'renamed', confirm: null })
    expect(res.ok && res.value.applied).toEqual([a])
    expect(t.deps.place).toHaveBeenCalledWith(a, 'renamed')
    expect(t.deps.binCheck).not.toHaveBeenCalled()
  })

  it('keeps an output that displaces nothing without a confirmation', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a, { displaces: null })
    const res = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: null })
    expect(res.ok && res.value.applied).toEqual([a])
  })

  it('refuses a hold that does not offer the placement, and jobs that are not held', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.hold(a, { actions: ['discard', 'retry'] })
    const res = await t.commands.keepOutput({ ids: [a, b], placement: 'planned', confirm: null })
    expect(res.ok && codes(res.value.refused)).toEqual(['not-held', 'blocked'])
    const renamed = await t.commands.keepOutput({ ids: [a], placement: 'renamed', confirm: null })
    expect(renamed.ok && renamed.value.refused[0]?.message).toContain('free name')
    expect(t.job(a).state).toBe('held')
  })

  it('refuses the keep when the bin check fails', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    const error: CommandError = { code: 'invalid-state', message: 'The Recycle Bin is full.', issues: [], details: null }
    t.deps.binCheck.mockResolvedValueOnce(error)
    const res = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    expect(res).toEqual({ ok: false, error })
    expect(t.job(a).state).toBe('held')
  })

  it('refuses a job that left the hold while the bin check ran', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    t.deps.binCheck.mockImplementationOnce(async () =>
    {
      t.core.transition(a, ['held'], 'discard', { reason: 'output-discarded' })
      return null
    })
    const res = await t.commands.keepOutput({ ids: [a], placement: 'planned', confirm: { displaces: 1 } })
    expect(res.ok && codes(res.value.refused)).toEqual(['not-held'])
    expect(t.deps.place).not.toHaveBeenCalled()
  })
})

describe('keepMode', () =>
{
  it('names the placement a kept output takes', () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    const job = t.job(a)
    expect(keepMode(job, 'renamed')).toBe('renamed')
    expect(keepMode(job, 'planned')).toBe('overwrote')
    expect(keepMode({ ...job, hold: null }, 'planned')).toBe('new')
    expect(keepMode({ ...job, plan: null, hold: null }, 'planned')).toBe('new')
    expect(keepMode({ ...job, hold: null, plan: planFor(job, 'fp', { resolution: 'rename' }) }, 'planned')).toBe('renamed')
    expect(keepMode({ ...job, plan: planFor(job, 'fp', { resolution: 'replace-original' }) }, 'planned')).toBe('replaced-original')
  })
})

describe('discardOutput', () =>
{
  it('discards a held output while its folder cannot be deleted yet (T27) and records the decision', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.hold(a)
    const res = await t.commands.discardOutput({ ids: [a, b] })
    expect(res.ok && res.value.applied).toEqual([a])
    expect(res.ok && codes(res.value.refused)).toEqual(['not-held'])
    expect(t.job(a).state).toBe('canceled')
    expect(t.job(a).reason).toBe('output-discarded')
    expect(t.job(a).acknowledged).toBe(true)
    expect(t.job(a).workDir).toBeNull()
    expect(t.deps.releaseWorkDir).toHaveBeenCalledWith(a, `C:\\work\\${a}`)
    expect(t.deps.history.recordDecision).toHaveBeenCalledWith(expect.objectContaining({ jobId: a, state: 'canceled' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.job(a).history).toEqual({ runId: t.job(a).runId, offset: 10, length: 20 })
  })

  it('logs a work folder that throws and a decision that cannot be recorded, and still discards', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    t.deps.releaseWorkDir.mockImplementationOnce(() =>
    {
      throw new Error('EBUSY')
    })
    t.deps.history.recordDecision.mockRejectedValueOnce(new Error('disk gone'))
    const res = await t.commands.discardOutput({ ids: [a] })
    expect(res.ok && res.value.applied).toEqual([a])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.log.lines.filter((line) => line.level === 'warn').map((line) => line.message)).toEqual([
      expect.stringContaining('not deleted yet'),
      expect.stringContaining('Could not record the decision')
    ])
    expect(t.job(a).history).toBeNull()
  })

  it('records nothing without a history store, and skips a folder that is already gone', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.hold(a)
    t.core.update(a, { workDir: null })
    const deps = t.deps as Partial<JobCommandsDeps>
    delete deps.history
    const res = await t.commands.discardOutput({ ids: [a] })
    expect(res.ok && res.value.applied).toEqual([a])
    expect(t.deps.releaseWorkDir).not.toHaveBeenCalled()
  })
})

describe('clear', () =>
{
  it("clears verified done jobs and acknowledged warnings under 'done', keeping the ones that need attention", async () =>
  {
    const t = setup({ jobs: 4 })
    const [clean, acked, warned, failed] = t.ids as [JobId, JobId, JobId, JobId]
    t.finish(clean)
    t.finish(acked, [LARGER])
    t.finish(warned, [LARGER])
    t.fail(failed)
    await t.commands.acknowledge({ ids: [acked] })
    const res = await t.commands.clear({ scope: { kind: 'done' } })
    expect(res.ok && res.value).toEqual({ removed: 2, kept: 1, tombstone: 'tomb-1' })
    expect(t.core.queue.get(clean)).toBeUndefined()
    expect(t.core.queue.get(acked)).toBeUndefined()
    expect(t.job(warned).state).toBe('done')
    expect(t.job(failed).state).toBe('failed')
    expect(t.deps.tombstones.record).toHaveBeenCalledWith('clear', expect.arrayContaining([expect.objectContaining({ job: expect.objectContaining({ id: clean }) })]))
  })

  it("also clears canceled, skipped, and acknowledged failed jobs under 'finished'", async () =>
  {
    const t = setup({ jobs: 6 })
    const [canceled, skipped, acked, failed, held, pending] = t.ids as [JobId, JobId, JobId, JobId, JobId, JobId]
    t.queueJobs(canceled, skipped)
    await t.commands.cancel({ ids: [canceled] })
    await t.commands.skip({ ids: [skipped] })
    t.fail(acked)
    t.fail(failed)
    await t.commands.acknowledge({ ids: [acked] })
    t.hold(held)
    const res = await t.commands.clear({ scope: { kind: 'finished' } })
    expect(res.ok && res.value).toMatchObject({ removed: 3, kept: 2 })
    expect(t.core.queue.jobs().map((job) => job.id)).toEqual([failed, held, pending])
  })

  it('clears listed jobs by the remove rules and never one that needs attention', async () =>
  {
    const t = setup({ jobs: 5 })
    const [pending, queued, running, failed, done] = t.ids as [JobId, JobId, JobId, JobId, JobId]
    t.finish(done)
    t.fail(failed)
    t.queueJobs(queued, running)
    t.dispatch(running)
    const res = await t.commands.clear({ scope: { kind: 'ids', ids: [pending, queued, running, failed, done] } })
    expect(res.ok && res.value).toMatchObject({ removed: 3, kept: 1 })
    expect(t.core.queue.jobs().map((job) => job.id)).toEqual([running, failed])
    expect(t.deps.albums.memberLeft).toHaveBeenCalledWith(queued)
    expect(t.deps.albums.memberLeft).toHaveBeenCalledTimes(1)
  })

  it('returns no tombstone when nothing was cleared', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    const res = await t.commands.clear({ scope: { kind: 'finished' } })
    expect(res.ok && res.value).toEqual({ removed: 0, kept: 1, tombstone: null })
    expect(t.deps.tombstones.record).not.toHaveBeenCalled()
  })
})

describe('log', () =>
{
  it("reads the current attempt's output from memory while it runs", async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.queueJobs(a)
    t.dispatch(a)
    const ring = createAttemptRing({ totalBytes: 256, headBytes: 64 })
    ring.beginProcess('ffmpeg -i in.mp4 out.mp4')
    ring.push('frame=1\n')
    t.deps.ring.mockReturnValue(ring)
    const res = await t.commands.log({ jobId: a, attempt: null })
    expect(res.ok && res.value).toEqual({ lines: ['> ffmpeg -i in.mp4 out.mp4', 'frame=1'], truncated: false, file: null })
    for (let i = 0; i < 40; i += 1)
    {
      ring.push(`frame=${i} with more output to overflow the ring\n`)
    }
    const full = await t.commands.log({ jobId: a, attempt: 1 })
    expect(full.ok && full.value.truncated).toBe(true)
  })

  it("reads a finished attempt's whole log file", async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    const path = (await import('node:path')).join('C:\\logs', t.job(a).runId as string, `${a}-a1.log`)
    t.logs.set(path, '> ffmpeg -i in.mp4\r\nError opening input\n')
    const res = await t.commands.log({ jobId: a, attempt: null })
    expect(res.ok && res.value).toEqual({ lines: ['> ffmpeg -i in.mp4', 'Error opening input'], truncated: false, file: path })
  })

  it('reads an earlier attempt from its own run and marks a cut tail', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.finish(a, [PLACED_OUTSIDE])
    const firstRun = t.job(a).runId as string
    await t.commands.retry({ ids: [a], recipe: null, ack: null, start: true })
    const path = (await import('node:path')).join('C:\\logs', firstRun, `${a}-a1.log`)
    t.logs.set(path, 'frame=900\nframe=901\n')
    const res = await t.commands.log({ jobId: a, attempt: 1 })
    expect(res.ok && res.value).toEqual({ lines: ['frame=900', 'frame=901'], truncated: true, file: path })
    const missing = await t.commands.log({ jobId: a, attempt: 7 })
    expect(!missing.ok && missing.error.code).toBe('not-found')
  })

  it('returns no lines for a job that has not run, a log that cannot be read, and an unknown job', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    const pending = await t.commands.log({ jobId: a, attempt: null })
    expect(pending.ok && pending.value).toEqual({ lines: [], truncated: false, file: null })
    t.fail(b)
    const unread = await t.commands.log({ jobId: b, attempt: null })
    expect(unread.ok && unread.value).toEqual({ lines: [], truncated: false, file: null })
    t.deps.readLog.mockRejectedValueOnce(new Error('EACCES'))
    const rejected = await t.commands.log({ jobId: b, attempt: 1 })
    expect(rejected.ok && rejected.value.lines).toEqual([])
    const gone = await t.commands.log({ jobId: 'MM-9999' as JobId, attempt: null })
    expect(!gone.ok && gone.error.code).toBe('not-found')
  })
})

describe('logLines and attemptOutcome', () =>
{
  it('marks an omission and a tail cut before the first command', () =>
  {
    expect(logLines('> ffmpeg\n[3 lines (120 bytes) of output omitted]\nend\n', 'failed')).toEqual({ lines: ['> ffmpeg', '[3 lines (120 bytes) of output omitted]', 'end'], truncated: true })
    expect(logLines('> ffmpeg\nend', 'verified')).toEqual({ lines: ['> ffmpeg', 'end'], truncated: false })
    expect(logLines('middle\nend', 'canceled').truncated).toBe(true)
    expect(logLines('middle\nend', 'failed').truncated).toBe(false)
    expect(logLines('', 'skipped')).toEqual({ lines: [], truncated: false })
  })

  it('maps every state to the outcome its log was written for', () =>
  {
    expect(attemptOutcome('done', 'outside-tolerance')).toBe('outside-tolerance')
    expect(attemptOutcome('done', 'verified')).toBe('verified')
    expect(attemptOutcome('held', null)).toBe('held')
    expect(attemptOutcome('interrupted', null)).toBe('interrupted')
    expect(attemptOutcome('pending', null)).toBeNull()
    expect(attemptOutcome('encoding', null)).toBeNull()
  })
})

describe('reveal', () =>
{
  it('shows the source, the output, the held output, and the log from the job record', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.finish(a)
    t.hold(b)
    const pathModule = await import('node:path')
    const log = pathModule.join('C:\\logs', t.job(a).runId as string, `${a}-a1.log`)
    for (const path of [t.job(a).source.path, t.job(a).result?.outputPath as string, t.job(b).hold?.outputPath as string, log])
    {
      t.present.add(path)
    }
    for (const [jobId, target] of [[a, 'source'], [a, 'output'], [b, 'held-output'], [a, 'log']] as const)
    {
      const res = await t.commands.reveal({ jobId, target })
      expect(res.ok).toBe(true)
    }
    expect(t.deps.showItemInFolder.mock.calls.map((call) => call[0])).toEqual([t.job(a).source.path, t.job(a).result?.outputPath, t.job(b).hold?.outputPath, log])
  })

  it('shows a kept original or a kept previous output', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.finish(a, [], { kind: 'replaced-original', original: { status: 'kept', path: 'C:\\media\\file-1.original.mp4', reason: 'no bin' } })
    t.finish(b, [], { kind: 'overwrote', previous: { status: 'kept', path: 'D:\\out\\file-2.previous.mp4', reason: 'no bin' } })
    t.present.add('C:\\media\\file-1.original.mp4')
    t.present.add('D:\\out\\file-2.previous.mp4')
    expect((await t.commands.reveal({ jobId: a, target: 'kept-original' })).ok).toBe(true)
    expect((await t.commands.reveal({ jobId: b, target: 'kept-original' })).ok).toBe(true)
    expect(t.deps.showItemInFolder).toHaveBeenCalledTimes(2)
  })

  it('refuses a target the record does not name, a file that is gone, and an unknown job', async () =>
  {
    const t = setup()
    const [a, b] = t.ids as [JobId, JobId]
    t.finish(b, [], { kind: 'replaced-original', original: { status: 'trashed' } })
    for (const [jobId, target] of [[a, 'output'], [a, 'held-output'], [a, 'kept-original'], [a, 'log'], [b, 'kept-original']] as const)
    {
      const res = await t.commands.reveal({ jobId, target })
      expect(!res.ok && res.error.code).toBe('not-found')
    }
    const gone = await t.commands.reveal({ jobId: a, target: 'source' })
    expect(!gone.ok && gone.error.message).toContain('no longer there')
    t.deps.exists.mockRejectedValueOnce(new Error('EPERM'))
    const failed = await t.commands.reveal({ jobId: a, target: 'source' })
    expect(failed.ok).toBe(false)
    const unknown = await t.commands.reveal({ jobId: 'MM-9999' as JobId, target: 'source' })
    expect(!unknown.ok && unknown.error.code).toBe('not-found')
    expect(t.deps.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('acknowledgment', () =>
{
  it('changes through no read, get, view, snapshot, log, or reveal path', async () =>
  {
    const t = setup()
    const [a] = t.ids as [JobId]
    t.fail(a)
    t.present.add(t.job(a).source.path)
    await t.core.get(a)
    t.core.view(a)
    t.core.snapshot(0)
    t.core.focus(a, null)
    await t.commands.log({ jobId: a, attempt: null })
    await t.commands.reveal({ jobId: a, target: 'source' })
    await t.commands.clear({ scope: { kind: 'finished' } })
    expect(t.job(a).acknowledged).toBe(false)
  })
})
