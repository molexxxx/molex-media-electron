/**
 * The run commands over a real engine core: Start of a reviewed report, pause, resume, cancel, the worker and run
 * settings, alerts, and the policy a Replace run returns to.
 */

import { describe, it, expect, vi } from 'vitest'
import { createEngineCore, type CoreJournal, type CoreJournalEntry, type RunRecord } from '../../../src/main/jobs/core'
import { createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import { JobQueue, type CatalogNumbers } from '../../../src/main/jobs/queue'
import { createReportStore, createRunCommands, localDateOf, KEPT_REPORTS, type RunCommandsDeps, type StartResult } from '../../../src/main/jobs/commands/run'
import type { FileStat, JobLogger } from '../../../src/main/jobs/deps'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { EncoderPolicy } from '../../../src/shared/audio/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { Ack } from '../../../src/shared/jobs/contract'
import type {
  BatchPolicy,
  CapabilitySummary,
  Job,
  JobMeasurement,
  JobPlan,
  OutputPlan,
  PreflightReport,
  RunAlert,
  RunSettings,
  SourceRef,
  WorkersState
} from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'folder', folder: 'D:\\out' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

const REPLACE: BatchPolicy = { ...POLICY, destination: { mode: 'replace-originals' } }

const SAVED: Omit<BatchPolicy, 'rev'> = { destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

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

const PREVIEW: JobMeasurement = { pass: 'preview', measuredAt: 0, streams: [], album: null, messages: [] }

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

function fileStat(size = 1000, mtimeMs = MTIME): FileStat
{
  return { size, mtimeMs, isFile: true, isDirectory: false, dev: '1', ino: '1' }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void }
{
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) =>
  {
    resolve = res
  })
  return { promise, resolve }
}

function planFor(job: Readonly<Job>, policyRev: number, output: Partial<OutputPlan> = {}): JobPlan
{
  return {
    basis: { inputsRev: job.inputsRev, policyRev, capabilitiesRev: CAPS.rev },
    fingerprint: 'fp-1',
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

interface EntryOptions
{
  id: JobId
  status?: 'ready' | 'blocked' | 'will-skip'
  output?: Partial<OutputPlan>
}

interface SetupOptions
{
  jobs?: number
  policy?: BatchPolicy
  run?: RunRecord
  saved?: Omit<BatchPolicy, 'rev'>
}

let reportSeq = 0

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
      policy: options.policy ?? POLICY,
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

  const files = new Map<string, FileStat | null | Promise<FileStat | null>>()
  const stat = vi.fn(async (path: string): Promise<FileStat | null> =>
  {
    if (files.has(path))
    {
      return files.get(path) as FileStat | null
    }
    return path.startsWith('C:\\media\\') ? fileStat() : null
  })
  let runSeq = 0
  const reports = createReportStore()
  const deps = {
    core,
    scheduler: { trigger: vi.fn() },
    reports,
    stat,
    nextRunId: vi.fn((): RunId => formatRunId(++runSeq)),
    savedPolicy: vi.fn(() => options.saved ?? SAVED),
    persistSettings: vi.fn(async (_settings: RunSettings): Promise<void> => undefined),
    gpu: { limit: vi.fn(() => 3), configure: vi.fn() },
    cores: 8,
    showItemInFolder: vi.fn(),
    keepAwake: vi.fn(),
    quitting: vi.fn(() => false)
  } satisfies RunCommandsDeps
  const commands = createRunCommands(deps)

  function report(entries: EntryOptions[], counts: Partial<PreflightReport['counts']> = {}, date = localDateOf(timers.now())): PreflightReport
  {
    const policyRev = core.globals().policy.rev
    const built: PreflightReport = {
      preflightId: `pf-${++reportSeq}`,
      createdAt: timers.now(),
      policyRev,
      capabilitiesRev: core.globals().capabilities.rev,
      jobs: entries.map((entry) =>
      {
        const job = core.queue.get(entry.id) as Job
        const status = entry.status ?? 'ready'
        return { jobId: entry.id, inputsRev: job.inputsRev, status, plan: status === 'blocked' ? null : planFor(job, policyRev, entry.output), issues: [] }
      }),
      counts: { jobs: entries.length, ready: 0, blocked: 0, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0, ...counts },
      volumes: [],
      collisions: [],
      blocking: [],
      warnings: [],
      limits: WORKERS.limits
    }
    reports.remember(built, date)
    return built
  }

  function start(preflightId: string, ack: Ack | null = null, resume = false)
  {
    return commands.start({ preflightId, ack, resume })
  }

  function events<T extends DraftEvent['type']>(type: T): Array<Extract<DraftEvent, { type: T }>>
  {
    return emit.mock.calls.map((call) => call[0]).filter((event): event is Extract<DraftEvent, { type: T }> => event.type === type)
  }

  const job = (id: JobId): Readonly<Job> => core.queue.get(id) as Job

  return { timers, log, core, ids, files, stat, deps, commands, report, start, events, job, emit }
}

type Ctx = ReturnType<typeof setup>

async function startAll(ctx: Ctx, ids: JobId[] = ctx.ids): Promise<StartResult>
{
  const result = await ctx.start(ctx.report(ids.map((id) => ({ id }))).preflightId)
  if (!result.ok)
  {
    throw new Error(result.error.message)
  }
  return result.value
}

function dispatch(ctx: Ctx, id: JobId): void
{
  expect(ctx.core.transition(id, ['queued'], 'dispatch').applied).toBe(true)
}

describe('createReportStore', () =>
{
  it('keeps the last four reports and forgets the oldest', () =>
  {
    const store = createReportStore()
    const reportOf = (id: string): PreflightReport => ({ preflightId: id } as PreflightReport)
    for (let i = 1; i <= KEPT_REPORTS + 1; i++)
    {
      store.remember(reportOf(`r${i}`), '2026-10-18')
    }
    expect(store.get('r1')).toBeNull()
    expect(store.get('r2')?.report.preflightId).toBe('r2')
    expect(store.get(`r${KEPT_REPORTS + 1}`)?.date).toBe('2026-10-18')
  })

  it('stores only the first successful Start of a kept report', () =>
  {
    const store = createReportStore(1)
    store.remember({ preflightId: 'a' } as PreflightReport, 'd')
    const first = { runId: formatRunId(1), queued: [], skipped: [], blocked: [], repeated: false }
    store.started('a', first)
    store.started('a', { ...first, runId: formatRunId(2) })
    store.started('missing', first)
    expect(store.get('a')?.started).toBe(first)
    store.remember({ preflightId: 'b' } as PreflightReport, 'd')
    expect(store.get('a')).toBeNull()
  })

  it('formats the local date', () =>
  {
    expect(localDateOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
  })
})

describe('run:start', () =>
{
  it('queues the ready jobs of the report, leaves blocked jobs pending, and starts a run', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    ctx.core.setQuitWhenIdle(true)
    const report = ctx.report([{ id: a }, { id: b }, { id: c, status: 'blocked' }])
    const result = await ctx.start(report.preflightId)
    expect(result).toMatchObject({ ok: true, value: { runId: formatRunId(1), queued: [a, b], skipped: [], blocked: [c], repeated: false } })
    expect(ctx.job(a).state).toBe('queued')
    expect(ctx.job(a).runId).toBe(formatRunId(1))
    expect(ctx.job(a).plan).toEqual(report.jobs[0]?.plan)
    expect(ctx.job(c).state).toBe('pending')
    expect(ctx.core.run()).toMatchObject({ status: 'running', runId: formatRunId(1), quitWhenIdle: false })
    expect(ctx.deps.scheduler.trigger).toHaveBeenCalledWith('queued')
  })

  it('skips will-skip jobs by the skip rule', async () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids as [JobId, JobId]
    const existing = 'D:\\out\\file-2.mp4'
    ctx.files.set(existing, fileStat())
    const report = ctx.report([{ id: a }, { id: b, status: 'will-skip', output: { conflict: 'exists', resolution: 'skip' } }])
    const result = await ctx.start(report.preflightId)
    expect(result).toMatchObject({ ok: true, value: { queued: [a], skipped: [b] } })
    expect(ctx.job(b)).toMatchObject({ state: 'skipped', reason: 'output-exists' })
  })

  it('returns the first result with repeated true and changes nothing on a repeat', async () =>
  {
    const ctx = setup()
    const report = ctx.report(ctx.ids.map((id) => ({ id })))
    const first = await ctx.start(report.preflightId)
    const emitted = ctx.emit.mock.calls.length
    const again = await ctx.start(report.preflightId)
    expect(first.ok && again.ok).toBe(true)
    if (first.ok && again.ok)
    {
      expect(again.value).toEqual({ ...first.value, repeated: true })
    }
    expect(ctx.emit.mock.calls.length).toBe(emitted)
    expect(ctx.deps.nextRunId).toHaveBeenCalledTimes(1)
    expect(ctx.deps.scheduler.trigger).toHaveBeenCalledTimes(1)
  })

  it('answers a double click with one Start and one repeat', async () =>
  {
    const ctx = setup()
    const report = ctx.report(ctx.ids.map((id) => ({ id })))
    const [one, two] = await Promise.all([ctx.start(report.preflightId), ctx.start(report.preflightId)])
    expect(one).toMatchObject({ ok: true, value: { repeated: false, queued: ctx.ids } })
    expect(two).toMatchObject({ ok: true, value: { repeated: true, queued: ctx.ids } })
    expect(ctx.deps.nextRunId).toHaveBeenCalledTimes(1)
  })

  it('refuses a report it no longer keeps', async () =>
  {
    const ctx = setup()
    const result = await ctx.start('pf-unknown')
    expect(result).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [] } } })
  })

  it('returns plan-stale with the job whose inputs changed, and checks again on a repeat', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    const report = ctx.report([{ id: a }, { id: b }, { id: c }])
    ctx.core.update(b, { recipe: { ...recipe() } }, { inputs: true })
    const result = await ctx.start(report.preflightId)
    expect(result).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [b] } } })
    expect(ctx.job(a).state).toBe('pending')
    expect(ctx.core.run().status).toBe('idle')
    const again = await ctx.start(report.preflightId)
    expect(again).toMatchObject({ ok: false, error: { code: 'plan-stale' } })
  })

  it('returns plan-stale for every job when the policy or capabilities rev moved', async () =>
  {
    const ctx = setup()
    const policyReport = ctx.report(ctx.ids.map((id) => ({ id })))
    ctx.core.setPolicy({ ...POLICY, rev: 2 })
    expect(await ctx.start(policyReport.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: ctx.ids } } })
    const capsReport = ctx.report(ctx.ids.map((id) => ({ id })))
    ctx.core.setCapabilities({ ...CAPS, rev: 2 })
    expect(await ctx.start(capsReport.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: ctx.ids } } })
  })

  it('returns plan-stale when a source changed size, modification time, or went missing', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    const report = ctx.report(ctx.ids.map((id) => ({ id })))
    ctx.files.set(ctx.job(a).source.path, fileStat(2000))
    ctx.files.set(ctx.job(b).source.path, fileStat(1000, MTIME + 1))
    ctx.files.set(ctx.job(c).source.path, null)
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [a, b, c] } } })
  })

  it('treats a failing stat as a missing file', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids as [JobId]
    const report = ctx.report([{ id: a }])
    ctx.stat.mockRejectedValueOnce(new Error('EBUSY'))
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [a] } } })
  })

  it('returns plan-stale when a final path appeared or an overwritten file disappeared', async () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    const report = ctx.report([
      { id: a },
      { id: b, output: { conflict: 'exists', resolution: 'overwrite', displaces: 'D:\\out\\file-2.mp4' } },
      { id: c, output: { conflict: 'exists', resolution: 'rename', finalPath: 'D:\\out\\file-3 (2).mp4', renamedTo: 'D:\\out\\file-3 (2).mp4' } }
    ])
    ctx.files.set('D:\\out\\file-1.mp4', fileStat())
    ctx.files.set('D:\\out\\file-3 (2).mp4', fileStat())
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [a, b, c] } } })
  })

  it('accepts a replace onto the source path, which exists by design', async () =>
  {
    const ctx = setup({ jobs: 2, policy: REPLACE })
    const [a, b] = ctx.ids as [JobId, JobId]
    const report = ctx.report([
      { id: a, output: { finalPath: 'c:\\MEDIA\\file-1.mp4', resolution: 'replace-original', displaces: 'C:\\media\\file-1.mp4' } },
      { id: b, output: { finalPath: 'C:\\media\\file-2.mkv', resolution: 'replace-original', displaces: 'C:\\media\\file-2.mp4' } }
    ], { originalsAffected: 2 })
    ctx.files.set('c:\\MEDIA\\file-1.mp4', fileStat())
    ctx.files.set('C:\\media\\file-2.mkv', null)
    const ack = { preflightId: report.preflightId, originalsAffected: 2, overwrites: 0 }
    expect(await ctx.start(report.preflightId, ack)).toMatchObject({ ok: true, value: { queued: [a, b] } })
  })

  it('compares paths exactly on Linux', async () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.core.setCapabilities({ ...CAPS, platform: 'linux' })
    const [a] = ctx.ids as [JobId]
    const report = ctx.report([{ id: a, output: { finalPath: 'C:\\MEDIA\\file-1.mp4' } }])
    ctx.files.set('C:\\MEDIA\\file-1.mp4', fileStat())
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [a] } } })
  })

  it('returns plan-stale when the {date} value changed since the report', async () =>
  {
    const ctx = setup({ policy: { ...POLICY, template: '{name}-{date}' } })
    const report = ctx.report(ctx.ids.map((id) => ({ id })), {}, '2026-10-17')
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: ctx.ids } } })
    const current = ctx.report(ctx.ids.map((id) => ({ id })))
    expect(await ctx.start(current.preflightId)).toMatchObject({ ok: true })
  })

  it('places appended jobs under the open run\'s start date', async () =>
  {
    const ctx = setup({ jobs: 2, policy: { ...POLICY, template: '{name}-{date}' } })
    const [a, b] = ctx.ids as [JobId, JobId]
    const startedOn = localDateOf(ctx.timers.now())
    await startAll(ctx, [a])
    dispatch(ctx, a)
    await ctx.timers.advance(24 * 60 * 60 * 1000)
    const report = ctx.report([{ id: b }], {}, startedOn)
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: true, value: { runId: formatRunId(1), queued: [b] } })
  })

  it('returns plan-stale for a removed job and for a job that left pending', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    const report = ctx.report([{ id: a }, { id: b }, { id: c }])
    ctx.core.remove([a])
    ctx.core.transition(b, ['pending'], 'start')
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [a, b] } } })
  })

  it('returns plan-stale when the inputs change while the files are checked', async () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids as [JobId, JobId]
    const report = ctx.report([{ id: a }, { id: b }])
    const gate = deferred<FileStat | null>()
    ctx.files.set(ctx.job(a).source.path, gate.promise)
    const pending = ctx.start(report.preflightId)
    await ctx.timers.flush()
    ctx.core.update(b, { recipe: { ...recipe() } }, { inputs: true })
    gate.resolve(fileStat())
    expect(await pending).toMatchObject({ ok: false, error: { code: 'plan-stale', details: { changed: [b] } } })
    expect(ctx.job(a).state).toBe('pending')
  })

  it('succeeds while 15 preview measurements land between the report and Start', async () =>
  {
    const ctx = setup({ jobs: 5 })
    const report = ctx.report(ctx.ids.map((id) => ({ id })))
    const revs = ctx.ids.map((id) => ctx.job(id).rev)
    for (let i = 0; i < 15; i++)
    {
      const id = ctx.ids[i % ctx.ids.length] as JobId
      ctx.core.update(id, { analysis: 'running' })
      expect(ctx.core.measured(id, { ...PREVIEW, measuredAt: i })).not.toBeNull()
    }
    expect(ctx.ids.every((id, i) => ctx.job(id).rev > (revs[i] as number))).toBe(true)
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: true, value: { queued: ctx.ids } })
  })

  it('needs the destructive counts repeated with matching numbers', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids as [JobId]
    ctx.files.set('D:\\out\\file-1.mp4', fileStat())
    const report = ctx.report([{ id: a, output: { conflict: 'exists', resolution: 'overwrite' } }], { overwrites: 1 })
    const details = { preflightId: report.preflightId, originalsAffected: 0, overwrites: 1 }
    expect(await ctx.start(report.preflightId)).toMatchObject({ ok: false, error: { code: 'confirmation-required', details } })
    expect(await ctx.start(report.preflightId, { ...details, overwrites: 2 })).toMatchObject({ ok: false, error: { code: 'confirmation-required' } })
    expect(await ctx.start(report.preflightId, { ...details, preflightId: 'pf-other' })).toMatchObject({ ok: false, error: { code: 'confirmation-required' } })
    expect(ctx.job(a).state).toBe('pending')
    expect(await ctx.start(report.preflightId, details)).toMatchObject({ ok: true, value: { queued: [a] } })
  })

  it('refuses an acknowledgment of counts the report does not have', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const report = ctx.report([{ id: ctx.ids[0] as JobId }])
    const result = await ctx.start(report.preflightId, { preflightId: report.preflightId, originalsAffected: 1, overwrites: 0 })
    expect(result).toMatchObject({ ok: false, error: { code: 'confirmation-required', details: { originalsAffected: 0, overwrites: 0 } } })
  })

  it('appends to the open run at the tail', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await startAll(ctx, [a])
    dispatch(ctx, a)
    const appended = await startAll(ctx, [b, c])
    expect(appended).toMatchObject({ runId: formatRunId(1), queued: [b, c] })
    expect(ctx.deps.nextRunId).toHaveBeenCalledTimes(1)
    expect(ctx.core.queue.jobs().filter((job) => job.state === 'queued').map((job) => job.id)).toEqual([b, c])
  })

  it('resumes a paused run only when asked', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await startAll(ctx, [a])
    expect((await ctx.commands.pause({ mode: 'finish-running' })).ok).toBe(true)
    expect(ctx.core.run().status).toBe('paused')
    await startAll(ctx, [b])
    expect(ctx.core.run().status).toBe('paused')
    const report = ctx.report([{ id: c }])
    expect(await ctx.start(report.preflightId, null, true)).toMatchObject({ ok: true, value: { runId: formatRunId(1), queued: [c] } })
    expect(ctx.core.run().status).toBe('running')
  })

  it('refuses while quitting, while the run cancels, and when nothing can start', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    ctx.deps.quitting.mockReturnValueOnce(true)
    expect(await ctx.start(ctx.report([{ id: a }]).preflightId)).toMatchObject({ ok: false, error: { code: 'shutting-down' } })
    expect(await ctx.start(ctx.report([{ id: a, status: 'blocked' }]).preflightId)).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    await startAll(ctx, [a])
    dispatch(ctx, a)
    await ctx.commands.cancelRun({})
    expect(ctx.core.run().status).toBe('canceling')
    expect(await ctx.start(ctx.report([{ id: b }]).preflightId)).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(ctx.job(c).state).toBe('pending')
  })

  it('refuses when the run starts canceling while the files are checked', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await startAll(ctx, [a])
    dispatch(ctx, a)
    const report = ctx.report([{ id: b }])
    const gate = deferred<FileStat | null>()
    ctx.files.set(ctx.job(b).source.path, gate.promise)
    const pending = ctx.start(report.preflightId)
    await ctx.timers.flush()
    await ctx.commands.cancelRun({})
    gate.resolve(fileStat())
    expect(await pending).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(ctx.job(b).state).toBe('pending')
  })

  it('refuses when the core will not open the run', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    ctx.files.set('D:\\out\\file-1.mp4', fileStat())
    const skipOnly = ctx.report([{ id: a, status: 'will-skip', output: { conflict: 'exists', resolution: 'skip' } }])
    expect(await ctx.start(skipOnly.preflightId)).toMatchObject({ ok: true, value: { runId: formatRunId(1), skipped: [a] } })
    expect(ctx.core.run().status).toBe('idle')
    ctx.deps.nextRunId.mockReturnValueOnce(formatRunId(1))
    const refused = await ctx.start(ctx.report([{ id: b }]).preflightId)
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(ctx.job(b).state).toBe('pending')
  })
})

describe('Replace runs', () =>
{
  it('return the queue policy to the saved default when the run completes', async () =>
  {
    const ctx = setup({ jobs: 1, policy: REPLACE })
    const [a] = ctx.ids as [JobId]
    await startAll(ctx, [a])
    expect(ctx.core.globals().policy).toEqual(REPLACE)
    ctx.core.transition(a, ['queued'], 'fail')
    expect(ctx.core.run().status).toBe('idle')
    expect(ctx.core.globals().policy).toEqual({ ...SAVED, rev: REPLACE.rev + 1 })
    expect(ctx.events('policy.changed').at(-1)).toMatchObject({ policy: { ...SAVED, rev: 2 } })
  })

  it('return the queue policy to the saved default when the run is canceled', async () =>
  {
    const ctx = setup({ jobs: 2, policy: REPLACE })
    await startAll(ctx)
    expect(await ctx.commands.cancelRun({})).toMatchObject({ ok: true, value: { canceled: 2 } })
    expect(ctx.core.run().status).toBe('idle')
    expect(ctx.core.globals().policy.destination).toEqual(SAVED.destination)
  })

  it('keep a non-replace policy when a run ends', async () =>
  {
    const ctx = setup({ jobs: 1 })
    await startAll(ctx)
    await ctx.commands.cancelRun({})
    expect(ctx.core.globals().policy).toEqual(POLICY)
    expect(ctx.deps.savedPolicy).not.toHaveBeenCalled()
  })

  it('leave the policy when the saved default itself replaces originals', async () =>
  {
    const ctx = setup({ jobs: 1, policy: REPLACE, saved: { ...SAVED, destination: { mode: 'replace-originals' } } })
    await startAll(ctx)
    await ctx.commands.cancelRun({})
    expect(ctx.core.globals().policy).toEqual(REPLACE)
    expect(ctx.log.lines.some((line) => line.level === 'warn' && line.message.includes('saved default'))).toBe(true)
  })

  it('stop resetting once disposed', async () =>
  {
    const ctx = setup({ jobs: 1, policy: REPLACE })
    await startAll(ctx)
    ctx.commands.dispose()
    await ctx.commands.cancelRun({})
    expect(ctx.core.globals().policy).toEqual(REPLACE)
  })
})

describe('run:pause', () =>
{
  it('finish-running lets running jobs finish and pauses once none is active', async () =>
  {
    const ctx = setup()
    const [a] = ctx.ids as [JobId]
    await startAll(ctx)
    dispatch(ctx, a)
    const result = await ctx.commands.pause({ mode: 'finish-running' })
    expect(result).toMatchObject({ ok: true, value: { status: 'pausing', pause: { mode: 'finish-running', reason: 'user' } } })
    expect(ctx.job(a).abort).toBeNull()
    expect(ctx.job(a).state).toBe('analyzing')
  })

  it('stop-running requeues analyzing and encoding jobs, also from pausing', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await startAll(ctx)
    dispatch(ctx, a)
    dispatch(ctx, b)
    await ctx.commands.pause({ mode: 'finish-running' })
    const now = await ctx.commands.pause({ mode: 'stop-running' })
    expect(now).toMatchObject({ ok: true, value: { status: 'pausing', pause: { mode: 'stop-running' } } })
    expect(ctx.job(a).abort).toBe('requeue')
    expect(ctx.job(b).abort).toBe('requeue')
  })

  it('refuses when no run is running', async () =>
  {
    const ctx = setup()
    expect(await ctx.commands.pause({ mode: 'finish-running' })).toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'There is no running batch to pause.' } })
    await startAll(ctx)
    await ctx.commands.pause({ mode: 'finish-running' })
    expect(await ctx.commands.pause({ mode: 'stop-running' })).toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'The run is already paused.' } })
  })
})

describe('run:resume', () =>
{
  it('resumes a paused or pausing run and clears quitWhenIdle', async () =>
  {
    const ctx = setup()
    const [a] = ctx.ids as [JobId]
    await startAll(ctx)
    dispatch(ctx, a)
    await ctx.commands.pause({ mode: 'finish-running' })
    ctx.core.setQuitWhenIdle(true)
    const result = await ctx.commands.resume({ ack: null })
    expect(result).toMatchObject({ ok: true, value: { status: 'running', pause: null, quitWhenIdle: false } })
    expect(ctx.deps.scheduler.trigger).toHaveBeenCalledWith('resume')
  })

  it('refuses when the run is not paused', async () =>
  {
    const ctx = setup()
    expect(await ctx.commands.resume({ ack: null })).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
  })

  it('needs the restored replace run acknowledged with the run id as the report id', async () =>
  {
    const runId = formatRunId(7)
    const run: RunRecord = {
      status: 'paused',
      runId,
      startedAt: 1,
      pause: { mode: 'finish-running', reason: 'restored', since: 1 },
      needsAck: { originalsAffected: 2, overwrites: 1 },
      interruptions: 1
    }
    const ctx = setup({ jobs: 1, policy: REPLACE, run })
    const [a] = ctx.ids as [JobId]
    ctx.core.transition(a, ['pending'], 'start', { change: { runId } })
    const details = { preflightId: runId, originalsAffected: 2, overwrites: 1 }
    expect(await ctx.commands.resume({ ack: null })).toMatchObject({ ok: false, error: { code: 'confirmation-required', details } })
    expect(await ctx.commands.resume({ ack: { ...details, originalsAffected: 1 } })).toMatchObject({ ok: false, error: { code: 'confirmation-required' } })
    expect(await ctx.commands.resume({ ack: { ...details, preflightId: 'pf-1' } })).toMatchObject({ ok: false, error: { code: 'confirmation-required' } })
    expect(ctx.core.run().status).toBe('paused')
    expect(await ctx.commands.resume({ ack: details })).toMatchObject({ ok: true, value: { status: 'running', needsAck: null } })
  })
})

describe('run:cancel', () =>
{
  it('counts queued and running jobs, and repeats harmlessly while canceling', async () =>
  {
    const ctx = setup()
    const [a, b, c] = ctx.ids as [JobId, JobId, JobId]
    await startAll(ctx)
    dispatch(ctx, a)
    expect(await ctx.commands.cancelRun({})).toMatchObject({ ok: true, value: { canceled: 3 } })
    expect(ctx.core.run().status).toBe('canceling')
    expect(ctx.job(a).abort).toBe('cancel')
    expect(ctx.job(b)).toMatchObject({ state: 'canceled', reason: 'run-canceled' })
    expect(ctx.job(c).state).toBe('canceled')
    expect(await ctx.commands.cancelRun({})).toMatchObject({ ok: true, value: { canceled: 0 } })
  })

  it('refuses when no run is open', async () =>
  {
    const ctx = setup()
    expect(await ctx.commands.cancelRun({})).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
  })
})

describe('run:setWorkers', () =>
{
  it('applies a lower limit without stopping running jobs and a higher one at once', async () =>
  {
    const ctx = setup()
    const [a, b] = ctx.ids as [JobId, JobId]
    await startAll(ctx)
    dispatch(ctx, a)
    dispatch(ctx, b)
    const lowered = await ctx.commands.setWorkers({ workers: { mode: 'fixed', count: 1 }, gpuSessions: null })
    expect(lowered).toMatchObject({ ok: true, value: { setting: { mode: 'fixed', count: 1 }, limits: { total: 1, videoCpu: 1, gpu: 1 } } })
    expect(ctx.job(a)).toMatchObject({ state: 'analyzing', abort: null })
    expect(ctx.job(b)).toMatchObject({ state: 'analyzing', abort: null })
    expect(ctx.deps.gpu.configure).not.toHaveBeenCalled()
    const raised = await ctx.commands.setWorkers({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } })
    expect(raised).toMatchObject({ ok: true, value: { setting: { mode: 'auto' }, limits: { total: 8, videoCpu: 1, gpu: 3 } } })
    expect(ctx.deps.gpu.configure).toHaveBeenCalledWith({ mode: 'auto' })
    expect(ctx.deps.scheduler.trigger).toHaveBeenLastCalledWith('workers')
    expect(ctx.core.globals().settings).toMatchObject({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } })
    expect(ctx.deps.persistSettings).toHaveBeenLastCalledWith(expect.objectContaining({ workers: { mode: 'auto' }, gpuSessions: { mode: 'auto' } }))
    expect(ctx.events('workers.changed').at(-1)).toMatchObject({ workers: { setting: { mode: 'auto' } } })
  })

  it('leaves the GPU budget alone when the sessions setting is unchanged', async () =>
  {
    const ctx = setup()
    await ctx.commands.setWorkers({ workers: { mode: 'fixed', count: 3 }, gpuSessions: { mode: 'fixed', count: 4 } })
    expect(ctx.deps.gpu.configure).not.toHaveBeenCalled()
  })

  it('changes nothing when the settings cannot be saved', async () =>
  {
    const ctx = setup()
    ctx.deps.persistSettings.mockRejectedValueOnce(new Error('EPERM'))
    expect(await ctx.commands.setWorkers({ workers: { mode: 'fixed', count: 5 }, gpuSessions: null })).toMatchObject({ ok: false, error: { code: 'io-error' } })
    ctx.deps.persistSettings.mockRejectedValueOnce('disk')
    expect(await ctx.commands.setWorkers({ workers: { mode: 'fixed', count: 5 }, gpuSessions: null })).toMatchObject({ ok: false, error: { code: 'io-error' } })
    expect(ctx.core.globals().settings.workers).toEqual(SETTINGS.workers)
    expect(ctx.deps.scheduler.trigger).not.toHaveBeenCalled()
  })
})

describe('run:setSettings', () =>
{
  it('merges, saves, and announces the settings, applying keep-awake at once', async () =>
  {
    const ctx = setup()
    const result = await ctx.commands.setSettings({ settings: { priority: 'normal', keepAwake: false, notify: { completion: false, firstFailure: true }, verifyVideo: undefined } })
    expect(result).toMatchObject({ ok: true, value: { ...SETTINGS, priority: 'normal', keepAwake: false, notify: { completion: false, firstFailure: true } } })
    expect(ctx.deps.keepAwake).toHaveBeenCalledWith(false)
    expect(ctx.core.globals().settings.verifyVideo).toBe('full')
    expect(ctx.events('settings.changed').at(-1)).toMatchObject({ settings: { priority: 'normal' } })
    await ctx.commands.setSettings({ settings: { measureOnReview: true } })
    expect(ctx.deps.keepAwake).toHaveBeenCalledTimes(1)
  })

  it('changes nothing when the settings cannot be saved', async () =>
  {
    const ctx = setup()
    ctx.deps.persistSettings.mockRejectedValueOnce(new Error('EPERM'))
    expect(await ctx.commands.setSettings({ settings: { keepAwake: false } })).toMatchObject({ ok: false, error: { code: 'io-error' } })
    expect(ctx.core.globals().settings.keepAwake).toBe(true)
    expect(ctx.deps.keepAwake).not.toHaveBeenCalled()
  })
})

describe('run alerts', () =>
{
  function alert(over: Partial<RunAlert>): RunAlert
  {
    return { id: 'a1', kind: 'cleanup-pending', severity: 'info', message: 'Work folders await cleanup.', at: 0, volume: null, path: null, jobIds: [], counts: null, dismissible: true, ...over }
  }

  it('dismisses a dismissible alert with run.alertCleared', async () =>
  {
    const ctx = setup()
    ctx.core.raiseAlert(alert({}))
    expect(await ctx.commands.dismissAlert({ alertId: 'a1' })).toMatchObject({ ok: true, value: null })
    expect(ctx.core.alerts()).toEqual([])
    expect(ctx.events('run.alertCleared')).toMatchObject([{ alertId: 'a1' }])
  })

  it('keeps an alert that is not dismissible and refuses an unknown one', async () =>
  {
    const ctx = setup()
    ctx.core.raiseAlert(alert({ dismissible: false }))
    expect(await ctx.commands.dismissAlert({ alertId: 'a1' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(ctx.core.alerts()).toHaveLength(1)
    expect(await ctx.commands.dismissAlert({ alertId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('reveals the path an alert carries', async () =>
  {
    const ctx = setup()
    ctx.core.raiseAlert(alert({ id: 'q', kind: 'queue-recovered', path: 'C:\\data\\jobs\\state.corrupt.json' }))
    ctx.core.raiseAlert(alert({ id: 'n' }))
    expect(await ctx.commands.revealAlert({ alertId: 'q' })).toMatchObject({ ok: true })
    expect(ctx.deps.showItemInFolder).toHaveBeenCalledWith('C:\\data\\jobs\\state.corrupt.json')
    expect(await ctx.commands.revealAlert({ alertId: 'n' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(await ctx.commands.revealAlert({ alertId: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect(ctx.deps.showItemInFolder).toHaveBeenCalledTimes(1)
    expect(ctx.core.alerts()).toHaveLength(2)
  })
})
