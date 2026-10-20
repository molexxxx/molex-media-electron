import { describe, it, expect, vi } from 'vitest'
import {
  basicPlanSummary,
  createEngineCore,
  idleProgress,
  idleRun,
  persistedJob,
  planIsCurrent,
  replayJournal,
  toJobView,
  viewPatch,
  type CoreJournal,
  type CoreJournalEntry,
  type EngineCore,
  type EngineCoreOptions,
  type RunEnding,
  type RunRecord
} from '../../../src/main/jobs/core'
import { createJobEventBus, type DraftEvent } from '../../../src/main/jobs/bus'
import { attemptLogPath, createAttemptRing, DETAIL_TAIL_BYTES, tailAtLineBoundary } from '../../../src/main/jobs/log'
import { JobQueue, type CatalogNumbers, type NewJob } from '../../../src/main/jobs/queue'
import type { EventSender, JobLogger } from '../../../src/main/jobs/deps'
import { applyPreset } from '../../../src/shared/jobs/presets'
import { assertWireSafe } from '../../../src/shared/jobs/wire'
import { formatRunId, type JobId, type RunId } from '../../../src/shared/jobs/ids'
import type { EncoderPolicy, MediaFacts } from '../../../src/shared/audio/types'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import type { JobEvent } from '../../../src/shared/jobs/contract'
import { STATE_GROUPS } from '../../../src/shared/jobs/states'
import type {
  AttemptRecord,
  AudioPlanCell,
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  EngineSnapshot,
  HistoryRecord,
  Job,
  JobCounts,
  JobError,
  JobHold,
  JobMeasurement,
  JobPlan,
  JobProgress,
  JobResult,
  JobStage,
  JobView,
  JobWarning,
  ResultStamp,
  RunAlert,
  RunSettings,
  ScanState,
  SourceRef,
  StageId,
  Verification,
  WorkersState
} from '../../../src/shared/jobs/types'
import { createManualTimers } from '../helpers/manual-timers'

const OUTPUT = { kind: 'same-as-source' } as EncoderPolicy

function recipe(id = 'mp4-h264'): Recipe
{
  return applyPreset(id, OUTPUT) as Recipe
}

function source(name: string): SourceRef
{
  return { path: `C:\\media\\${name}`, name, ext: '.mp4', dir: 'C:\\media', size: 1000, mtimeMs: 1700000000000, origin: 'files', subdir: '' }
}

function init(name: string): NewJob
{
  return { source: source(name), recipe: recipe() }
}

function numbers(start = 1, block = 100): CatalogNumbers
{
  let next = start
  const last = start + block - 1
  return {
    available: () => Math.max(0, last - next + 1),
    take: () => (next <= last ? next++ : null)
  }
}

const POLICY: BatchPolicy = { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto' }

const SETTINGS: RunSettings =
{
  workers: { mode: 'auto' },
  gpuSessions: { mode: 'auto' },
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
  encoders: ['aac', 'libx264'],
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 8,
  platform: 'win32'
}

const WORKERS: WorkersState =
{
  setting: { mode: 'auto' },
  limits: { total: 4, videoCpu: 2, gpu: 0 },
  active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
}

const RUN: RunId = formatRunId(1)

interface LogLine
{
  level: string
  message: string
}

function fakeLog(): JobLogger & { lines: LogLine[] }
{
  const lines: LogLine[] = []
  const at = (level: string) => (message: string): void =>
  {
    lines.push({ level, message })
  }
  const log = { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), ffmpeg: at('ffmpeg'), child: () => log }
  return log
}

interface FakeJournal extends CoreJournal
{
  lines: CoreJournalEntry[]
  durable: CoreJournalEntry[][]
  fail: boolean
  settle(): void
}

function fakeJournal(): FakeJournal
{
  let n = 0
  const waiting: Array<() => void> = []
  const journal: FakeJournal =
  {
    lines: [],
    durable: [],
    fail: false,
    append(entry)
    {
      journal.lines.push(entry)
      n += 1
      return n
    },
    appendDurable(entries)
    {
      journal.lines.push(...entries)
      journal.durable.push([...entries])
      if (journal.fail)
      {
        return Promise.reject(new Error('EIO: i/o error, write'))
      }
      return new Promise((resolve) =>
      {
        waiting.push(() => resolve(entries.map(() => ++n)))
      })
    },
    settle()
    {
      for (const done of waiting.splice(0))
      {
        done()
      }
    }
  }
  return journal
}

function fakeSender(id = 1): EventSender & { events: JobEvent[] }
{
  const events: JobEvent[] = []
  return {
    id,
    events,
    send: (_channel, batch) =>
    {
      events.push(...batch.events)
    },
    isDestroyed: () => false,
    onNavigate: () => () => undefined,
    onDestroyed: () => () => undefined
  }
}

function summaryOf(run: RunEnding): BatchSummary
{
  return { runId: run.runId, startedAt: run.startedAt, endedAt: run.endedAt, endedBy: run.endedBy, jobs: run.jobs.length } as unknown as BatchSummary
}

interface SetupOptions
{
  jobs?: number
  run?: RunRecord
  views?: EngineCoreOptions['views']
  detail?: EngineCoreOptions['detail']
  block?: number
  summarize?: EngineCoreOptions['summarize']
}

function setup(options: SetupOptions = {})
{
  const timers = createManualTimers(1_000)
  const log = fakeLog()
  const journal = fakeJournal()
  const bus = createJobEventBus({ timers, log })
  const emit = vi.spyOn(bus, 'emit')
  const queue = new JobQueue({ numbers: numbers(1, options.block ?? 100), now: () => timers.now() })
  const summaries: RunEnding[] = []
  const core = createEngineCore({
    queue,
    bus,
    journal,
    log,
    now: () => timers.now(),
    state: { policy: POLICY, settings: SETTINGS, defaultRecipe: recipe(), capabilities: CAPS, workers: WORKERS, presets: { user: [], pins: {}, recent: [] }, recentFolders: [], run: options.run },
    summarize: options.summarize ?? ((run) =>
    {
      summaries.push(run)
      return summaryOf(run)
    }),
    views: options.views,
    detail: options.detail
  })
  const ids = (core.add(Array.from({ length: options.jobs ?? 0 }, (_, index) => init(`file-${index + 1}.mp4`))) ?? []).map((job) => job.id)
  const drafts = (): DraftEvent[] => emit.mock.calls.map((call) => call[0])
  const mark = (): number => emit.mock.calls.length
  const since = (from: number): DraftEvent[] => drafts().slice(from)
  const warnings = (): string[] => log.lines.filter((line) => line.level === 'warn').map((line) => line.message)
  return { core, queue, bus, journal, log, timers, summaries, ids, drafts, mark, since, warnings }
}

type Setup = ReturnType<typeof setup>

function stageOf(id: StageId, pass = 1, passes = 1): JobStage
{
  return { id, pass, passes, label: `${id} ${pass} of ${passes}`, startedAt: 1_000 }
}

function progressOf(stage: StageId, percent: number): JobProgress
{
  return { stage, pass: 1, passes: 1, percent, stagePercent: percent, speed: 2, etaSec: 5, outTimeSec: 1, durationSec: 10, bytesWritten: 512, elapsedMs: 40 }
}

function startAll(core: EngineCore, ids: readonly JobId[], runId: RunId = RUN): void
{
  core.batch(() =>
  {
    for (const id of ids)
    {
      core.transition(id, ['pending'], 'start', { change: { runId } })
    }
    core.startRun(runId)
  })
}

function toEncoding(core: EngineCore, id: JobId): void
{
  core.transition(id, ['queued'], 'dispatch', { stage: stageOf('probe') })
  core.transition(id, ['analyzing'], 'measured', { stage: stageOf('encode') })
}

function toVerifying(core: EngineCore, id: JobId): void
{
  toEncoding(core, id)
  core.transition(id, ['encoding'], 'encoded', { stage: stageOf('verify') })
}

function finish(core: EngineCore, id: JobId): void
{
  core.transition(id, ['verifying'], 'verified', { stage: stageOf('place') })
  core.transition(id, ['finalizing'], 'placed')
}

function toFinished(core: EngineCore, id: JobId): void
{
  toVerifying(core, id)
  finish(core, id)
}

function typesOf(events: readonly DraftEvent[], jobId?: JobId): string[]
{
  return events
    .filter((event) => jobId === undefined || ('jobId' in event && event.jobId === jobId) || (event.type === 'job.added' && event.job.id === jobId))
    .map((event) => event.type)
}

function expectWireSafe(ctx: Setup): void
{
  for (const event of ctx.drafts())
  {
    assertWireSafe(event)
  }
  for (const line of ctx.journal.lines)
  {
    assertWireSafe(line)
  }
}

describe('transition', () =>
{
  it('applies a row from an expected state with one rev, one job.state, and one journal line', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    const before = ctx.queue.get(id)!.rev
    const from = ctx.mark()
    const lines = ctx.journal.lines.length
    const result = ctx.core.transition(id, ['pending'], 'start', { change: { runId: RUN } })
    expect(result.applied).toBe(true)
    expect(ctx.queue.get(id)!.rev).toBe(before + 1)
    const events = ctx.since(from)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'job.state', jobId: id, from: 'pending', to: 'queued', attempt: 1, reason: 'user', rev: before + 1 })
    expect(events[0].type === 'job.state' && events[0].patch).toEqual({ runId: RUN })
    expect(ctx.journal.lines.slice(lines)).toEqual([expect.objectContaining({ type: 'job.state', jobId: id, transition: 'T2', from: 'pending', to: 'queued', rev: before + 1 })])
    expectWireSafe(ctx)
  })

  it('logs and ignores a call from an unexpected state, an unknown job, a missing row, or a foreign reason', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    const from = ctx.mark()
    const lines = ctx.journal.lines.length
    expect(ctx.core.transition(id, ['queued'], 'unqueue')).toEqual({ applied: false, job: ctx.queue.get(id) })
    expect(ctx.core.transition('MM-9999' as JobId, ['pending'], 'start')).toEqual({ applied: false, job: null })
    expect(ctx.core.transition(id, ['pending'], 'encoded').applied).toBe(false)
    expect(ctx.core.transition(id, ['pending'], 'remove').applied).toBe(false)
    expect(ctx.core.transition(id, ['pending'], 'start', { reason: 'crash' }).applied).toBe(false)
    expect(ctx.since(from)).toEqual([])
    expect(ctx.journal.lines.length).toBe(lines)
    expect(ctx.queue.get(id)!.state).toBe('pending')
    expect(ctx.warnings()).toHaveLength(5)
    expect(ctx.warnings()[0]).toContain('pending is not one of queued')
  })

  it('refuses the next encode pass, which is a stage and not a state change', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toEncoding(ctx.core, id)
    expect(ctx.core.transition(id, ['encoding'], 'next-pass').applied).toBe(false)
  })

  it('refuses a stage that does not run in the target state', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    expect(ctx.core.transition(id, ['queued'], 'dispatch', { stage: stageOf('verify') }).applied).toBe(false)
    expect(ctx.warnings().pop()).toContain('stage verify does not run in analyzing')
  })

  it('sets what the table prescribes: execution and start time at dispatch, restarts on a requeue, a new attempt on retry', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    await ctx.timers.advance(500)
    ctx.core.transition(id, ['queued'], 'dispatch')
    expect(ctx.queue.get(id)).toMatchObject({ state: 'analyzing', execution: 1, startedAt: 1_500, stage: null })
    ctx.core.transition(id, ['analyzing'], 'requeue', { reason: 'requeued-gpu' })
    expect(ctx.queue.get(id)).toMatchObject({ state: 'queued', restarts: 1, attempt: 1, reason: 'requeued-gpu' })
    ctx.core.transition(id, ['queued'], 'dispatch')
    expect(ctx.queue.get(id)).toMatchObject({ execution: 2, startedAt: 1_500 })
    ctx.core.transition(id, ['analyzing'], 'fail', { change: { acknowledged: true } })
    expect(ctx.queue.get(id)).toMatchObject({ state: 'failed', endedAt: 1_500 })
    ctx.core.transition(id, ['failed'], 'retry', { change: { runId: RUN } })
    expect(ctx.queue.get(id)).toMatchObject({ state: 'queued', attempt: 2, restarts: 0, acknowledged: false, startedAt: null, endedAt: null })
  })

  it('puts the new stage and its starting progress in the patch and clears them outside the active states', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    const from = ctx.mark()
    ctx.core.transition(id, ['queued'], 'dispatch', { stage: stageOf('probe'), progress: progressOf('probe', 0) })
    const [state] = ctx.since(from)
    expect(state.type === 'job.state' && state.patch).toMatchObject({ stage: stageOf('probe'), progress: progressOf('probe', 0) })
    ctx.core.transition(id, ['analyzing'], 'fail')
    expect(ctx.queue.get(id)).toMatchObject({ stage: null, progress: null })
  })

  it('journals the move to finalizing and every hold durably, and resolves once the line is fsynced', async () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, a)
    toVerifying(ctx.core, b)
    expect(ctx.journal.durable).toEqual([])
    const verified = ctx.core.transition(a, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    const held = ctx.core.transition(b, ['verifying'], 'hold', { change: { hold: null } })
    expect(ctx.journal.durable.map((lines) => lines.map((line) => line.type === 'job.state' && line.transition))).toEqual([['T20'], ['T21']])
    expect(ctx.journal.durable[0][0]).toMatchObject({ begin: { verdict: 'verified', mode: 'new' } })
    expect(ctx.journal.durable[1][0]).toMatchObject({ begin: null, reason: 'outside-tolerance' })
    let done = false
    if (verified.applied)
    {
      void verified.durable.then(() =>
      {
        done = true
      })
    }
    await Promise.resolve()
    expect(done).toBe(false)
    ctx.journal.settle()
    expect(verified.applied && await verified.durable).toBe(true)
    expect(held.applied && await held.durable).toBe(true)
    expect(done).toBe(true)
  })

  it('reports a durable line that could not be written', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, id)
    ctx.journal.fail = true
    const result = ctx.core.transition(id, ['verifying'], 'verified')
    expect(result.applied && await result.durable).toBe(false)
    expect(ctx.log.lines.some((line) => line.level === 'error' && line.message.includes('durable'))).toBe(true)
  })

  it('applies a transition whose journal line cannot be written and reports it, never throwing', async () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, b)
    ctx.journal.append = () =>
    {
      throw new Error('ENOSPC: no space left on device, write')
    }
    ctx.journal.appendDurable = () =>
    {
      throw new Error('EIO: i/o error, fsync')
    }
    const from = ctx.mark()
    const result = ctx.core.transition(a, ['queued'], 'skip')
    expect(result.applied && await result.durable).toBe(false)
    const placed = ctx.core.transition(b, ['verifying'], 'verified')
    expect(placed.applied && await placed.durable).toBe(false)
    expect(typesOf(ctx.since(from), a)).toEqual(['job.state'])
    expect(ctx.queue.get(b)!.state).toBe('finalizing')
    expect(ctx.log.lines.filter((line) => line.level === 'error').map((line) => line.message)).toEqual([
      'Could not journal job.state: ENOSPC: no space left on device, write',
      `Could not make T20 for ${b} durable: EIO: i/o error, fsync`
    ])
  })

  it('falls back to the basic row parts when a builder throws', () =>
  {
    const ctx = setup({ jobs: 1, views: {
      planSummary: () =>
      {
        throw new Error('no encoder')
      },
      audioPlan: () =>
      {
        throw new Error('no gain plan')
      }
    } })
    const [id] = ctx.ids
    const job = ctx.core.update(id, { plan: planFor(ctx.queue.get(id)!) })!
    expect(ctx.core.view(id)).toMatchObject({ plan: basicPlanSummary(job.plan!, true), audioPlan: null })
    expect(ctx.log.lines.filter((line) => line.level === 'error').map((line) => line.message)).toContain(`Could not summarize the plan of ${id}: no encoder`)
    expect(ctx.log.lines.filter((line) => line.level === 'error').map((line) => line.message)).toContain(`Could not build the audio plan of ${id}: no gain plan`)
  })

  it('clears the hold when a job leaves held, and the end time while it is placed again', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    const hold = { code: 'outside-tolerance', message: 'Outside tolerance.' } as unknown as JobHold
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, id)
    ctx.core.transition(id, ['verifying'], 'hold', { change: { hold } })
    expect(ctx.queue.get(id)).toMatchObject({ state: 'held', hold, endedAt: 1_000 })
    const from = ctx.mark()
    ctx.core.transition(id, ['held'], 'keep', { change: { acknowledged: true }, begin: { verdict: 'outside-tolerance', mode: 'new' } })
    expect(ctx.queue.get(id)).toMatchObject({ state: 'finalizing', hold: null, endedAt: null, acknowledged: true })
    expect(ctx.since(from)[0]).toMatchObject({ type: 'job.state', patch: { hold: null, endedAt: null, acknowledged: true } })
  })

  it('starts a retried attempt without the outcome of the one before it', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    const attempt = { attempt: 1, state: 'done' } as unknown as AttemptRecord
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, id)
    ctx.core.verified(id, VERIFICATION)
    ctx.core.transition(id, ['verifying'], 'verified')
    ctx.core.transition(id, ['finalizing'], 'placed', { change: { result: RESULT, warnings: [{ code: 'outside-tolerance-placed' } as unknown as JobWarning] } })
    const retried = ctx.core.transition(id, ['done'], 'retry-changed', { reason: 'plan-changed', change: { attempts: [attempt] } })
    expect(retried.applied).toBe(true)
    expect(ctx.queue.get(id)).toMatchObject({ state: 'pending', reason: 'plan-changed', attempt: 2, error: null, hold: null, result: null, verification: null, warnings: [], attempts: [attempt] })
    expect(ctx.core.view(id)!.stamp).toBeNull()
  })

  it('resolves a line that need not be durable at once', async () =>
  {
    const ctx = setup({ jobs: 1 })
    const result = ctx.core.transition(ctx.ids[0], ['pending'], 'start')
    expect(result.applied && await result.durable).toBe(true)
    expect(ctx.journal.durable).toEqual([])
  })
})

describe('stage and progress', () =>
{
  it('starts a stage with job.stage and its starting progress, without a rev change', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(id, ['queued'], 'dispatch')
    const rev = ctx.queue.get(id)!.rev
    const from = ctx.mark()
    expect(ctx.core.stage(id, stageOf('probe'), progressOf('probe', 0))).toBe(true)
    expect(ctx.since(from)).toEqual([
      { type: 'job.stage', jobId: id, rev, stage: stageOf('probe') },
      { type: 'job.progress', jobId: id, progress: progressOf('probe', 0) }
    ])
    expect(ctx.queue.get(id)).toMatchObject({ rev, stage: stageOf('probe'), progress: progressOf('probe', 0) })
  })

  it('moves to the next encode pass with job.stage only (T16)', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toEncoding(ctx.core, id)
    const rev = ctx.queue.get(id)!.rev
    const from = ctx.mark()
    expect(ctx.core.stage(id, stageOf('encode', 2, 2))).toBe(true)
    expect(typesOf(ctx.since(from))).toEqual(['job.stage'])
    expect(ctx.queue.get(id)).toMatchObject({ rev, state: 'encoding', stage: stageOf('encode', 2, 2), progress: null })
  })

  it('refuses a stage of another state or of an unknown job', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    expect(ctx.core.stage(id, stageOf('probe'))).toBe(false)
    expect(ctx.core.stage('MM-9999' as JobId, stageOf('probe'))).toBe(false)
    expect(ctx.warnings()).toEqual([expect.stringContaining('does not run in pending'), expect.stringContaining('no such job')])
  })

  it('keeps progress only for the current stage', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(id, ['queued'], 'dispatch', { stage: stageOf('probe') })
    const from = ctx.mark()
    expect(ctx.core.progress(id, progressOf('probe', 40))).toBe(true)
    expect(ctx.core.progress(id, progressOf('encode', 50))).toBe(false)
    expect(ctx.core.progress('MM-9999' as JobId, progressOf('probe', 50))).toBe(false)
    expect(ctx.since(from)).toEqual([{ type: 'job.progress', jobId: id, progress: progressOf('probe', 40) }])
    expect(ctx.queue.get(id)!.progress).toEqual(progressOf('probe', 40))
  })
})

function runStates(events: readonly DraftEvent[]): string[]
{
  return events.flatMap((event) => (event.type === 'run.state' ? [event.run.status] : []))
}

function completions(events: readonly DraftEvent[]): DraftEvent[]
{
  return events.filter((event) => event.type === 'run.completed')
}

describe('run state', () =>
{
  it('starts a run from idle with its id and lets later jobs join it', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    const from = ctx.mark()
    ctx.core.batch(() =>
    {
      ctx.core.transition(a, ['pending'], 'start', { change: { runId: RUN } })
      expect(ctx.core.startRun(RUN)).toBe(RUN)
    })
    expect(ctx.core.run()).toMatchObject({ status: 'running', runId: RUN, startedAt: 1_000, pause: null, quitWhenIdle: false })
    expect(ctx.core.run().counts).toMatchObject({ pending: 1, queued: 1 })
    expect(runStates(ctx.since(from))).toEqual(['running'])
    expect(ctx.journal.lines.filter((line) => line.type === 'run').pop()).toEqual({ type: 'run', run: { status: 'running', runId: RUN, startedAt: 1_000, pause: null, needsAck: null, interruptions: 0 } })
    expect(ctx.core.startRun(formatRunId(2))).toBe(RUN)
    ctx.core.transition(b, ['pending'], 'start', { change: { runId: RUN } })
    expect(ctx.core.run().runId).toBe(RUN)
  })

  it('pauses finish-running: pausing while jobs are active, paused when the last one leaves', () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toEncoding(ctx.core, a)
    ctx.core.transition(b, ['queued'], 'dispatch')
    const from = ctx.mark()
    expect(ctx.core.pauseRun('finish-running', 'user')).toBe(true)
    expect(ctx.core.run()).toMatchObject({ status: 'pausing', pause: { mode: 'finish-running', reason: 'user', since: 1_000 } })
    expect(ctx.queue.get(a)!.abort).toBeNull()
    ctx.core.transition(b, ['analyzing'], 'fail')
    expect(ctx.core.run().status).toBe('pausing')
    toFinished(ctx.core, a)
    expect(ctx.core.run().status).toBe('paused')
    expect(runStates(ctx.since(from))).toEqual(['pausing', 'paused'])
    expect(completions(ctx.since(from))).toEqual([])
  })

  it('pauses straight to paused with no active jobs, and a second pause changes nothing', () =>
  {
    const ctx = setup({ jobs: 1 })
    startAll(ctx.core, ctx.ids)
    expect(ctx.core.pauseRun('finish-running', 'disk-space')).toBe(true)
    const from = ctx.mark()
    expect(ctx.core.run()).toMatchObject({ status: 'paused', pause: { mode: 'finish-running', reason: 'disk-space' } })
    expect(ctx.core.pauseRun('finish-running', 'user')).toBe(true)
    expect(ctx.since(from)).toEqual([])
  })

  it('refuses a pause of an idle or canceling run', () =>
  {
    const ctx = setup({ jobs: 1 })
    expect(ctx.core.pauseRun('finish-running', 'user')).toBe(false)
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(ctx.ids[0], ['queued'], 'dispatch')
    ctx.core.cancelRun()
    expect(ctx.core.pauseRun('stop-running', 'user')).toBe(false)
    expect(ctx.warnings().filter((line) => line.startsWith('Ignored a pause'))).toEqual(['Ignored a pause: the run is idle', 'Ignored a pause: the run is canceling'])
  })

  it('pauses stop-running: requeues analyzing and encoding jobs to the head with the attempt unchanged and restarts + 1', () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b, c] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch', { stage: stageOf('probe') })
    toEncoding(ctx.core, b)
    const stopped: string[] = []
    ctx.core.onAbort((id, intent) => stopped.push(`${id} ${intent}`))
    const from = ctx.mark()
    expect(ctx.core.pauseRun('stop-running', 'user')).toBe(true)
    expect(stopped).toEqual([`${a} requeue`, `${b} requeue`])
    expect(ctx.since(from).filter((event) => event.type === 'job.updated')).toEqual([
      expect.objectContaining({ jobId: a, patch: { abort: 'requeue' } }),
      expect.objectContaining({ jobId: b, patch: { abort: 'requeue' } })
    ])
    expect(ctx.core.run().status).toBe('pausing')
    expect(ctx.core.settleAbort(a).applied).toBe(true)
    expect(ctx.core.run().status).toBe('pausing')
    expect(ctx.core.settleAbort(b).applied).toBe(true)
    for (const id of [a, b])
    {
      expect(ctx.queue.get(id)).toMatchObject({ state: 'queued', reason: 'requeued-pause', attempt: 1, restarts: 1, abort: null, stage: null })
    }
    const order = ctx.queue.order()
    expect(order.indexOf(c)).toBeGreaterThan(Math.max(order.indexOf(a), order.indexOf(b)))
    expect(ctx.core.run().status).toBe('paused')
    expect(runStates(ctx.since(from))).toEqual(['pausing', 'paused'])
  })

  it('turns a finish-running pause into stop-running when pause now follows', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toEncoding(ctx.core, a)
    ctx.core.pauseRun('finish-running', 'user')
    expect(ctx.queue.get(a)!.abort).toBeNull()
    expect(ctx.core.pauseRun('stop-running', 'user')).toBe(true)
    expect(ctx.core.run().pause).toMatchObject({ mode: 'stop-running', reason: 'user' })
    expect(ctx.queue.get(a)!.abort).toBe('requeue')
    expect(ctx.core.pauseRun('stop-running', 'user')).toBe(true)
    expect(ctx.core.pauseRun('finish-running', 'user')).toBe(true)
    expect(ctx.core.run().pause!.mode).toBe('stop-running')
  })

  it('keeps the run pausing during a verify under pause now until no job is active', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, a)
    ctx.core.pauseRun('stop-running', 'user')
    expect(ctx.queue.get(a)!.abort).toBeNull()
    expect(ctx.core.run().status).toBe('pausing')
    ctx.core.verified(a, { verdict: 'outside-tolerance' } as unknown as Verification)
    expect(ctx.core.run().status).toBe('pausing')
    ctx.core.transition(a, ['verifying'], 'requeue', { reason: 'requeued-pause' })
    expect(ctx.queue.get(a)).toMatchObject({ state: 'queued', restarts: 1, attempt: 1 })
    expect(ctx.queue.order()[0]).toBe(a)
    expect(ctx.core.run().status).toBe('paused')
  })

  it('resumes a pausing or paused run, clearing the pause and quitWhenIdle', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    expect(ctx.core.resumeRun()).toBe(false)
    ctx.core.transition(a, ['queued'], 'dispatch')
    ctx.core.pauseRun('finish-running', 'user')
    ctx.core.setQuitWhenIdle(true)
    expect(ctx.core.run().quitWhenIdle).toBe(true)
    const from = ctx.mark()
    expect(ctx.core.resumeRun()).toBe(true)
    expect(ctx.core.run()).toMatchObject({ status: 'running', pause: null, quitWhenIdle: false })
    expect(runStates(ctx.since(from))).toEqual(['running'])
    ctx.core.pauseRun('finish-running', 'user')
    ctx.core.transition(a, ['analyzing'], 'fail')
    expect(ctx.core.run().status).toBe('paused')
    expect(ctx.core.resumeRun()).toBe(true)
    expect(ctx.core.run().status).toBe('running')
  })

  it('resumes a run whose restored replace policy needs acknowledgment only when acknowledged', () =>
  {
    const ctx = setup({ jobs: 1, run: { status: 'paused', runId: RUN, startedAt: 500, pause: { mode: 'finish-running', reason: 'restored', since: 500 }, needsAck: { originalsAffected: 3, overwrites: 1 }, interruptions: 1 } })
    ctx.core.transition(ctx.ids[0], ['pending'], 'start', { change: { runId: RUN } })
    ctx.core.setQuitWhenIdle(true)
    expect(ctx.core.resumeRun()).toBe(false)
    expect(ctx.core.run()).toMatchObject({ status: 'paused', needsAck: { originalsAffected: 3, overwrites: 1 }, quitWhenIdle: false })
    expect(ctx.warnings().pop()).toContain('needs acknowledgment')
    expect(ctx.core.resumeRun({ acknowledged: true })).toBe(true)
    expect(ctx.core.run()).toMatchObject({ status: 'running', needsAck: null, pause: null, runId: RUN, startedAt: 500 })
  })

  it('sets and clears needsAck with a run.state', () =>
  {
    const ctx = setup()
    const from = ctx.mark()
    ctx.core.setNeedsAck({ originalsAffected: 2, overwrites: 0 })
    expect(ctx.core.run().needsAck).toEqual({ originalsAffected: 2, overwrites: 0 })
    ctx.core.setNeedsAck(null)
    expect(runStates(ctx.since(from))).toEqual(['idle', 'idle'])
    ctx.core.setQuitWhenIdle(false)
    expect(runStates(ctx.since(from))).toHaveLength(2)
  })

  it('cancels the run: queued jobs at once, running jobs after their children exit, finalizing jobs finish', () =>
  {
    const ctx = setup({ jobs: 5 })
    const [a, b, c, d, e] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    toEncoding(ctx.core, b)
    toVerifying(ctx.core, c)
    toVerifying(ctx.core, d)
    ctx.core.transition(d, ['verifying'], 'verified')
    const from = ctx.mark()
    expect(ctx.core.cancelRun()).toBe(true)
    expect(ctx.core.run()).toMatchObject({ status: 'canceling', pause: null })
    expect(ctx.queue.get(e)).toMatchObject({ state: 'canceled', reason: 'run-canceled' })
    for (const id of [a, b, c])
    {
      expect(ctx.queue.get(id)!.abort).toBe('cancel')
    }
    expect(ctx.queue.get(d)).toMatchObject({ state: 'finalizing', abort: null })
    for (const id of [a, b, c])
    {
      expect(ctx.core.settleAbort(id)).toMatchObject({ applied: true, job: { state: 'canceled', reason: 'run-canceled' } })
    }
    expect(ctx.core.run().status).toBe('canceling')
    expect(completions(ctx.since(from))).toEqual([])
    ctx.core.transition(d, ['finalizing'], 'placed')
    expect(ctx.core.run()).toMatchObject({ status: 'idle', runId: null })
    expect(runStates(ctx.since(from))).toEqual(['canceling', 'idle'])
    expect(completions(ctx.since(from))).toEqual([{ type: 'run.completed', summary: expect.objectContaining({ runId: RUN, endedBy: 'canceled', jobs: 5 }) }])
    expect(ctx.core.cancelRun()).toBe(false)
  })

  it('cancels a paused run without a resume', () =>
  {
    const ctx = setup({ jobs: 2 })
    startAll(ctx.core, ctx.ids)
    ctx.core.pauseRun('finish-running', 'user')
    expect(ctx.core.run().status).toBe('paused')
    const from = ctx.mark()
    ctx.core.cancelRun()
    expect(runStates(ctx.since(from))).toEqual(['canceling', 'idle'])
    expect(ctx.ids.map((id) => ctx.queue.get(id)!.state)).toEqual(['canceled', 'canceled'])
    expect(ctx.summaries).toEqual([expect.objectContaining({ runId: RUN, endedBy: 'canceled' })])
  })

  it('cancels a pausing run whose jobs carry a recorded requeue', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toEncoding(ctx.core, a)
    ctx.core.pauseRun('stop-running', 'user')
    expect(ctx.queue.get(a)!.abort).toBe('requeue')
    ctx.core.cancelRun()
    expect(ctx.queue.get(a)!.abort).toBe('cancel')
    ctx.core.settleAbort(a)
    expect(ctx.queue.get(a)).toMatchObject({ state: 'canceled', reason: 'run-canceled', restarts: 0 })
    expect(ctx.core.run().status).toBe('idle')
    expect(ctx.summaries).toHaveLength(1)
  })

  it('completes exactly once, after the last job leaves the queued and active states', async () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b, c] = ctx.ids
    startAll(ctx.core, ctx.ids)
    await ctx.timers.advance(250)
    toFinished(ctx.core, a)
    toVerifying(ctx.core, b)
    ctx.core.transition(b, ['verifying'], 'hold')
    const from = ctx.mark()
    toFinished(ctx.core, c)
    expect(ctx.core.run()).toMatchObject({ status: 'idle', runId: null, startedAt: null, progress: { percent: 0 } })
    ctx.core.settle()
    ctx.core.settle()
    expect(completions(ctx.since(from))).toHaveLength(1)
    expect(ctx.summaries).toEqual([expect.objectContaining({ runId: RUN, startedAt: 1_000, endedAt: 1_250, endedBy: 'completed', interruptions: 0 })])
    expect(ctx.summaries[0].jobs.map((job) => job.state)).toEqual(['done', 'held', 'done'])
    const events = ctx.drafts()
    const last = events.findIndex((event) => event.type === 'run.completed')
    expect(events.slice(0, last).filter((event) => event.type === 'job.state').length).toBeGreaterThan(0)
    expect(events.slice(last + 1).filter((event) => 'jobId' in event)).toEqual([])
  })

  it('emits only job events for a decision on a held job after its run completed', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, a)
    ctx.core.transition(a, ['verifying'], 'hold')
    expect(ctx.core.run().status).toBe('idle')
    const from = ctx.mark()
    ctx.core.transition(a, ['held'], 'keep', { begin: { verdict: 'outside-tolerance', mode: 'new' } })
    expect(ctx.core.isBusy()).toBe(true)
    ctx.core.transition(a, ['finalizing'], 'placed')
    expect(typesOf(ctx.since(from))).toEqual(['job.state', 'job.state'])
    expect(ctx.summaries).toHaveLength(1)
    expect(ctx.queue.get(a)).toMatchObject({ state: 'done', runId: RUN })
  })

  it('refuses to start a completed run id again, and any start while canceling', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    startAll(ctx.core, [a])
    ctx.core.transition(a, ['queued'], 'skip')
    expect(ctx.core.run().status).toBe('idle')
    ctx.core.transition(b, ['pending'], 'start', { change: { runId: RUN } })
    expect(ctx.core.startRun(RUN)).toBeNull()
    expect(ctx.warnings().pop()).toBe(`Refused to start ${RUN}: it has completed`)
    const next = formatRunId(2)
    expect(ctx.core.startRun(next)).toBe(next)
    ctx.core.transition(b, ['queued'], 'dispatch')
    ctx.core.cancelRun()
    expect(ctx.core.startRun(formatRunId(3))).toBeNull()
    expect(ctx.warnings().pop()).toBe(`Refused to start ${formatRunId(3)}: ${next} is canceling`)
    ctx.core.setQuitWhenIdle(true)
    const from = ctx.mark()
    expect(ctx.core.startRun(formatRunId(3))).toBeNull()
    expect(ctx.core.run().quitWhenIdle).toBe(false)
    expect(runStates(ctx.since(from))).toEqual(['canceling'])
  })

  it('clears quitWhenIdle when a start joins the current run', () =>
  {
    const ctx = setup({ jobs: 2 })
    startAll(ctx.core, [ctx.ids[0]])
    ctx.core.setQuitWhenIdle(true)
    expect(ctx.core.startRun(formatRunId(2))).toBe(RUN)
    expect(ctx.core.run().quitWhenIdle).toBe(false)
  })

  it('completes a run whose last queued job is removed or released', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    startAll(ctx.core, ctx.ids)
    expect(ctx.core.claim(a)).toBe(true)
    expect(ctx.core.claim(a)).toBe(false)
    expect(ctx.core.claim('MM-9999' as JobId)).toBe(false)
    ctx.core.remove([b])
    expect(ctx.core.run().status).toBe('running')
    ctx.core.transition(a, ['queued'], 'unqueue')
    expect(ctx.core.isClaimed(a)).toBe(false)
    expect(ctx.core.run().status).toBe('idle')
    expect(ctx.summaries).toHaveLength(1)
  })

  it('holds the run while a dispatch claim is open and settles when it is released', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.claim(a)
    expect(ctx.core.claims()).toEqual([a])
    expect(ctx.core.activeCount()).toBe(1)
    ctx.core.pauseRun('finish-running', 'user')
    expect(ctx.core.run().status).toBe('pausing')
    expect(ctx.core.releaseClaim(a)).toBe(true)
    expect(ctx.core.releaseClaim(a)).toBe(false)
    expect(ctx.core.run().status).toBe('paused')
  })

  it('logs a summary that cannot be built and still goes idle', () =>
  {
    const ctx = setup({ jobs: 1, summarize: () =>
    {
      throw new Error('no history')
    } })
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(ctx.ids[0], ['queued'], 'skip')
    expect(ctx.core.run().status).toBe('idle')
    expect(completions(ctx.drafts())).toEqual([])
    expect(ctx.log.lines.some((line) => line.level === 'error' && line.message === `Could not summarize ${RUN}: no history`)).toBe(true)
  })

  it('notifies run listeners and survives one that throws', () =>
  {
    const ctx = setup({ jobs: 1 })
    const seen: string[] = []
    const off = ctx.core.onRunState((run) => seen.push(run.status))
    ctx.core.onRunState(() =>
    {
      throw new Error('tray gone')
    })
    startAll(ctx.core, ctx.ids)
    off()
    ctx.core.pauseRun('finish-running', 'user')
    expect(seen).toEqual(['running'])
    expect(ctx.log.lines.filter((line) => line.level === 'error').map((line) => line.message)).toContain('A listener failed: tray gone')
  })
})

describe('abort', () =>
{
  it('records a cancel in every running state as job.updated covered by the flushed seq, then applies it once the child exits', () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b, c] = ctx.ids
    const sender = fakeSender()
    ctx.core.subscribe(sender, 'client-1')
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    toEncoding(ctx.core, b)
    toVerifying(ctx.core, c)
    for (const id of [a, b, c])
    {
      const state = ctx.queue.get(id)!.state
      expect(ctx.core.recordAbort(id, 'cancel')).toBe(true)
      const seq = ctx.bus.flush()
      const recorded = sender.events.filter((event) => event.type === 'job.updated' && event.jobId === id && event.patch.abort === 'cancel')
      expect(recorded).toHaveLength(1)
      expect(recorded[0].seq).toBeLessThanOrEqual(seq)
      expect(ctx.queue.get(id)).toMatchObject({ state, abort: 'cancel' })
      const settled = ctx.core.settleAbort(id)
      expect(settled).toMatchObject({ applied: true, job: { state: 'canceled', reason: 'user', abort: null } })
      ctx.bus.flush()
      const change = sender.events.filter((event) => event.type === 'job.state' && event.jobId === id).pop()
      expect(change).toMatchObject({ from: state, to: 'canceled', reason: 'user', patch: { abort: null } })
      expect(change!.seq).toBeGreaterThan(recorded[0].seq)
    }
  })

  it('refuses a cancel during finalizing and on jobs that run no child process', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    expect(ctx.core.recordAbort(b, 'cancel')).toBe(false)
    startAll(ctx.core, ctx.ids)
    toVerifying(ctx.core, a)
    ctx.core.transition(a, ['verifying'], 'verified')
    expect(ctx.core.recordAbort(a, 'cancel')).toBe(false)
    expect(ctx.core.recordAbort('MM-9999' as JobId, 'skip')).toBe(false)
    expect(ctx.warnings().filter((line) => line.includes('runs no child process'))).toHaveLength(3)
  })

  it('lets the recorded abort or an interruption move the job, never a runner result', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    ctx.core.transition(b, ['queued'], 'dispatch')
    ctx.core.recordAbort(a, 'skip')
    expect(ctx.core.transition(a, ['analyzing'], 'measured').applied).toBe(false)
    expect(ctx.warnings().pop()).toContain('the recorded skip settles it first')
    expect(ctx.core.settleAbort(a)).toMatchObject({ applied: true, job: { state: 'skipped', reason: 'user' } })
    ctx.core.recordAbort(b, 'cancel')
    expect(ctx.core.transition(b, ['analyzing'], 'interrupt', { reason: 'quit' })).toMatchObject({ applied: true, job: { state: 'interrupted', abort: null } })
  })

  it('keeps the first cancel or skip, replaces a requeue, and repeats a recorded intent quietly', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [a] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    const stopped: string[] = []
    ctx.core.onAbort((id, intent) => stopped.push(intent))
    const off = ctx.core.onAbort(() =>
    {
      throw new Error('child gone')
    })
    expect(ctx.core.recordAbort(a, 'requeue')).toBe(true)
    expect(ctx.core.recordAbort(a, 'requeue')).toBe(true)
    off()
    expect(ctx.core.recordAbort(a, 'skip')).toBe(true)
    expect(ctx.core.recordAbort(a, 'cancel')).toBe(false)
    expect(ctx.core.recordAbort(a, 'requeue')).toBe(false)
    expect(stopped).toEqual(['requeue', 'skip'])
    expect(ctx.queue.get(a)!.abort).toBe('skip')
    expect(ctx.log.lines.some((line) => line.level === 'error' && line.message === 'A listener failed: child gone')).toBe(true)
  })

  it('ignores a settle with no recorded abort', () =>
  {
    const ctx = setup({ jobs: 1 })
    expect(ctx.core.settleAbort(ctx.ids[0])).toEqual({ applied: false, job: ctx.queue.get(ctx.ids[0]) })
    expect(ctx.core.settleAbort('MM-9999' as JobId)).toEqual({ applied: false, job: null })
    expect(ctx.warnings()).toEqual([`Ignored an abort for ${ctx.ids[0]}: none is recorded`, 'Ignored an abort for MM-9999: none is recorded'])
  })
})

describe('quit inputs', () =>
{
  it('is busy with active or claimed jobs, or queued jobs in a running or pausing run', () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b] = ctx.ids
    expect(ctx.core.isBusy()).toBe(false)
    expect(ctx.core.quitInputs()).toEqual({ busy: false, status: 'idle', runId: null, active: 0, queued: 0, quitWhenIdle: false })
    startAll(ctx.core, [a, b])
    expect(ctx.core.quitInputs()).toEqual({ busy: true, status: 'running', runId: RUN, active: 0, queued: 2, quitWhenIdle: false })
    ctx.core.pauseRun('finish-running', 'user')
    expect(ctx.core.isBusy()).toBe(false)
    ctx.core.claim(a)
    expect(ctx.core.quitInputs()).toMatchObject({ busy: true, status: 'paused', active: 1, queued: 1 })
    ctx.core.releaseClaim(a)
    ctx.core.resumeRun()
    ctx.core.transition(a, ['queued'], 'dispatch')
    ctx.core.pauseRun('finish-running', 'user')
    ctx.core.setQuitWhenIdle(true)
    expect(ctx.core.quitInputs()).toEqual({ busy: true, status: 'pausing', runId: RUN, active: 1, queued: 1, quitWhenIdle: true })
  })

  it('marks running jobs interrupted without settling the run, and captures the lines for the session-end write', () =>
  {
    const ctx = setup({ jobs: 4 })
    const [a, b, c, d] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    toEncoding(ctx.core, b)
    toVerifying(ctx.core, c)
    ctx.core.transition(c, ['verifying'], 'verified')
    ctx.core.recordAbort(b, 'cancel')
    const lines = ctx.journal.lines.length
    const from = ctx.mark()
    expect(ctx.core.interruptActive('quit')).toEqual([])
    expect([a, b, c, d].map((id) => ctx.queue.get(id)!.state)).toEqual(['interrupted', 'interrupted', 'finalizing', 'queued'])
    expect(ctx.queue.get(a)).toMatchObject({ reason: 'quit', endedAt: 1_000 })
    expect(ctx.journal.lines.slice(lines).map((line) => line.type === 'job.state' && `${line.jobId} ${line.transition} ${line.reason}`)).toEqual([`${a} T31 quit`, `${b} T31 quit`])
    expect(ctx.core.run()).toMatchObject({ status: 'running', runId: RUN })
    expect(runStates(ctx.since(from))).toEqual([])
    ctx.core.transition(d, ['queued'], 'dispatch')
    const before = ctx.journal.lines.length
    const captured = ctx.core.interruptActive('session-end', { capture: true })
    expect(captured).toEqual([expect.objectContaining({ type: 'job.state', jobId: d, transition: 'T31', reason: 'session-end' })])
    expect(ctx.journal.lines.length).toBe(before)
    captured.forEach((line) => assertWireSafe(line))
    ctx.core.settle()
    expect(ctx.core.run().status).toBe('running')
    ctx.core.transition(c, ['finalizing'], 'placed')
    expect(ctx.core.run().status).toBe('idle')
  })
})

const MEASUREMENT = { passes: [], gainPlans: [] } as unknown as JobMeasurement

const VERIFICATION = { verdict: 'verified', checks: [] } as unknown as Verification

const STAMP = { verdict: 'verified', text: 'Verified' } as unknown as ResultStamp

const RESULT = { stamp: STAMP, outputBytes: 2048 } as unknown as JobResult

const CELL: AudioPlanCell = { audioIndex: 0, mode: 'normalize', gainDb: -3, requestedGainDb: -3, limitingDb: 0, predictedLufs: -16, unit: 'LUFS', status: 'measured' } as unknown as AudioPlanCell

function planFor(job: Readonly<Job>, policyRev = 1, capabilitiesRev = 1): JobPlan
{
  return {
    class: 'video-cpu',
    basis: { inputsRev: job.inputsRev, policyRev, capabilitiesRev },
    output: { finalPath: `C:\\media\\${job.source.name}-out.mp4`, renamedTo: null, container: 'mp4', resolution: 'new' },
    album: null
  } as unknown as JobPlan
}

function countRows(rows: readonly JobView[]): JobCounts
{
  const counts = Object.fromEntries(Object.keys(STATE_GROUPS).map((state) => [state, 0])) as JobCounts
  for (const row of rows)
  {
    counts[row.state] += 1
  }
  return counts
}

function upsert<T>(list: T[], item: T, same: (entry: T) => boolean): T[]
{
  const index = list.findIndex(same)
  return index === -1 ? [...list, item] : list.map((entry, at) => (at === index ? item : entry))
}

/** Applies events to a snapshot the way a window does: strictly after its seq, one seq at a time. */
function rebuild(snapshot: EngineSnapshot, events: readonly JobEvent[]): EngineSnapshot
{
  const state = structuredClone(snapshot)
  const rows = new Map(state.jobs.map((row) => [row.id, row]))
  const row = (id: JobId): JobView =>
  {
    const found = rows.get(id)
    if (found === undefined)
    {
      throw new Error(`no row ${id}`)
    }
    return found
  }
  for (const event of events)
  {
    if (event.seq <= state.seq)
    {
      continue
    }
    expect(event.seq).toBe(state.seq + 1)
    state.seq = event.seq
    switch (event.type)
    {
      case 'job.added':
      {
        rows.set(event.job.id, structuredClone(event.job))
        const order = state.order.filter((id) => id !== event.job.id)
        order.splice(event.after === null ? 0 : order.indexOf(event.after) + 1, 0, event.job.id)
        state.order = order
        break
      }
      case 'job.removed':
        rows.delete(event.jobId)
        state.order = state.order.filter((id) => id !== event.jobId)
        break
      case 'queue.order':
        state.order = [...event.order]
        break
      case 'job.updated':
        Object.assign(row(event.jobId), event.patch, { rev: event.rev })
        break
      case 'job.state':
        Object.assign(row(event.jobId), event.patch, { rev: event.rev, state: event.to, reason: event.reason, attempt: event.attempt })
        break
      case 'job.stage':
        Object.assign(row(event.jobId), { rev: event.rev, stage: event.stage, progress: null })
        break
      case 'job.progress':
        row(event.jobId).progress = event.progress
        break
      case 'job.measured':
      case 'job.verified':
        row(event.jobId).rev = event.rev
        break
      case 'run.state':
        state.run = event.run
        break
      case 'run.progress':
        state.run.progress = event.progress
        break
      case 'workers.changed':
        state.run.workers = event.workers
        break
      case 'settings.changed':
        state.settings = event.settings
        break
      case 'policy.changed':
        state.policy = event.policy
        break
      case 'capabilities.changed':
        state.capabilities = event.capabilities
        break
      case 'scan.progress':
        state.scans = [...state.scans.filter((scan) => scan.scanId !== event.scan.scanId), event.scan]
        break
      case 'run.alert':
        state.alerts = upsert(state.alerts, event.alert, (alert) => alert.id === event.alert.id)
        break
      case 'run.alertCleared':
        state.alerts = state.alerts.filter((alert) => alert.id !== event.alertId)
        break
      case 'presets.changed':
        state.presets = event.presets
        break
      case 'defaultRecipe.changed':
        state.defaultRecipe = event.recipe
        break
      case 'folders.changed':
        state.recentFolders = event.recentFolders
        break
      default:
        break
    }
  }
  state.jobs = state.order.map(row)
  state.run.counts = countRows(state.jobs)
  return state
}

const ALERT: RunAlert =
{
  id: 'alert-1',
  kind: 'disk-space',
  severity: 'warning',
  message: 'D: is full. Free some space, then resume.',
  at: 1_000,
  volume: 'D:',
  path: null,
  jobIds: [],
  counts: null,
  dismissible: true
}

const SCAN: ScanState =
{
  scanId: 'scan-1',
  root: 'C:\\media',
  status: 'scanning',
  error: null,
  visited: 1,
  added: 0,
  excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 }
}

describe('events', () =>
{
  it('emits a normalize job\'s events in the order the run produces them', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    const from = ctx.mark()
    ctx.core.transition(id, ['queued'], 'dispatch')
    ctx.core.stage(id, stageOf('probe'))
    ctx.core.stage(id, stageOf('measure'))
    ctx.core.progress(id, progressOf('measure', 50))
    ctx.core.measured(id, MEASUREMENT)
    ctx.core.transition(id, ['analyzing'], 'measured', { stage: stageOf('encode') })
    ctx.core.progress(id, progressOf('encode', 50))
    ctx.core.transition(id, ['encoding'], 'encoded', { stage: stageOf('verify') })
    ctx.core.verified(id, VERIFICATION)
    ctx.core.transition(id, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    ctx.core.stage(id, stageOf('place'))
    ctx.core.transition(id, ['finalizing'], 'placed', { change: { result: RESULT } })
    const events = ctx.since(from).filter((event) => 'jobId' in event && event.jobId === id)
    expect(events.map((event) => event.type)).toEqual([
      'job.state', 'job.stage', 'job.stage', 'job.progress', 'job.measured', 'job.state', 'job.progress', 'job.state',
      'job.verified', 'job.state', 'job.stage', 'job.state'
    ])
    const states = events.flatMap((event) => (event.type === 'job.state' ? [event] : []))
    expect(states.map((event) => `${event.from}>${event.to}`)).toEqual(['queued>analyzing', 'analyzing>encoding', 'encoding>verifying', 'verifying>finalizing', 'finalizing>done'])
    expect(states.map((event) => event.rev)).toEqual(states.map((_, index) => states[0].rev + index + (index > 0 ? 1 : 0) + (index > 2 ? 1 : 0)))
    expect(states[0]).toMatchObject({ attempt: 1, reason: 'dispatch', patch: { startedAt: 1_000 } })
    expect(states[1].patch).toMatchObject({ stage: stageOf('encode'), progress: null })
    expect(states[4].patch).toMatchObject({ stamp: STAMP, stage: null, endedAt: 1_000 })
    expect(states[3].patch).toEqual({ stage: null })
    expect(typesOf(ctx.since(from)).slice(-2)).toEqual(['run.state', 'run.completed'])
  })

  it('follows a measurement with the row fields it changes', () =>
  {
    const ctx = setup({ jobs: 1, views: { audioPlan: (job) => (job.measurement === null ? null : [CELL]) } })
    const [id] = ctx.ids
    const from = ctx.mark()
    const job = ctx.core.measured(id, MEASUREMENT)
    expect(ctx.since(from)).toEqual([
      { type: 'job.measured', jobId: id, rev: job!.rev, measurement: MEASUREMENT },
      { type: 'job.updated', jobId: id, rev: job!.rev, patch: { audioPlan: [CELL] } }
    ])
    expect(ctx.core.view(id)!.audioPlan).toEqual([CELL])
    expect(ctx.core.measured('MM-9999' as JobId, MEASUREMENT)).toBeNull()
    expect(ctx.core.verified('MM-9999' as JobId, VERIFICATION)).toBeNull()
    expect(ctx.core.view('MM-9999' as JobId)).toBeNull()
  })

  it('rebuilds the same state from a snapshot and the events after its seq', async () =>
  {
    const ctx = setup({ jobs: 4, views: { audioPlan: (job) => (job.measurement === null ? null : [CELL]) } })
    const [a, b, c, d] = ctx.ids
    const first = fakeSender(1)
    const start = ctx.core.subscribe(first, 'client-1')
    expect(start.seq).toBe(ctx.bus.lastSeq())
    ctx.core.update(b, { plan: planFor(ctx.queue.get(b)!) })
    startAll(ctx.core, [a, b, c])
    ctx.core.reorder([c], a)
    ctx.core.transition(a, ['queued'], 'dispatch')
    ctx.core.stage(a, stageOf('probe'), progressOf('probe', 0))
    ctx.core.progress(a, progressOf('probe', 30))
    ctx.core.measured(a, MEASUREMENT)
    ctx.core.transition(a, ['analyzing'], 'measured', { stage: stageOf('encode'), progress: progressOf('encode', 0) })
    ctx.core.progress(a, progressOf('encode', 60))
    ctx.core.setRunProgress({ ...idleProgress(), percent: 20, bytesWritten: 10 })
    const middle = fakeSender(2)
    const mid = ctx.core.subscribe(middle, 'client-2')
    expect(rebuild(start, first.events)).toEqual(mid)
    ctx.core.progress(a, progressOf('encode', 80))
    await ctx.timers.advance(100)
    ctx.core.transition(a, ['encoding'], 'encoded', { stage: stageOf('verify') })
    ctx.core.verified(a, VERIFICATION)
    ctx.core.transition(a, ['verifying'], 'verified', { begin: { verdict: 'verified', mode: 'new' } })
    ctx.core.stage(a, stageOf('place'))
    ctx.core.transition(a, ['finalizing'], 'placed', { change: { result: RESULT } })
    ctx.core.update(d, { previewed: true })
    ctx.core.setPolicy({ ...POLICY, rev: 2 })
    ctx.core.setCapabilities({ ...CAPS, rev: 2 })
    ctx.core.setSettings({ ...SETTINGS, keepAwake: false })
    ctx.core.setWorkers({ ...WORKERS, active: { ...WORKERS.active, total: 1 } })
    ctx.core.setRunProgress({ ...idleProgress(), percent: 40, bytesWritten: 20 })
    ctx.core.raiseAlert(ALERT)
    ctx.core.raiseAlert({ ...ALERT, id: 'alert-2', kind: 'gpu-sessions' })
    ctx.core.raiseAlert({ ...ALERT, message: 'D: is full.' })
    expect(ctx.core.clearAlert('alert-2')).toBe(true)
    expect(ctx.core.clearAlert('alert-2')).toBe(false)
    ctx.core.upsertScan(SCAN)
    ctx.core.upsertScan({ ...SCAN, scanId: 'scan-2' })
    ctx.core.upsertScan({ ...SCAN, visited: 9, status: 'done' })
    ctx.core.setPresets({ user: [], pins: { 1: 'mp4-h264' }, recent: [recipe()] })
    ctx.core.setRecentFolders([{ path: 'C:\\media', name: 'media', files: 4, addedAt: 900 }])
    ctx.core.preflightProgress('preflight-1', 1, 2)
    ctx.core.focus(a, RUN)
    const removed = ctx.core.remove([d])
    ctx.core.restore(removed)
    ctx.core.add([init('late.mp4')], b)
    ctx.core.move([c], 'bottom')
    ctx.core.pauseRun('stop-running', 'user')
    ctx.core.cancelRun()
    const last = fakeSender(3)
    const end = ctx.core.subscribe(last, 'client-3')
    expect(end.run.counts).toEqual(countRows(end.jobs))
    expect(end.alerts.map((alert) => alert.message)).toEqual(['D: is full.'])
    expect(end.scans.map((scan) => `${scan.scanId} ${scan.status}`)).toEqual(['scan-2 scanning', 'scan-1 done'])
    expect(end.jobs.find((job) => job.id === b)!.plan).toMatchObject({ current: false })
    expect(rebuild(start, first.events)).toEqual(end)
    expect(rebuild(mid, middle.events)).toEqual(end)
    expect(first.events[0].seq).toBe(start.seq + 1)
    expect(middle.events[0].seq).toBe(mid.seq + 1)
    expect(ctx.bus.registrations()).toHaveLength(3)
    expect(ctx.core.unsubscribe(2, 'client-2')).toBe(true)
    expect(ctx.core.unsubscribe(2, 'client-2')).toBe(false)
  })

  it('announces a new default recipe to every window and journals it', () =>
  {
    const ctx = setup({ jobs: 1 })
    const from = ctx.mark()
    ctx.core.setDefaultRecipe(recipe('spotify'))
    expect(ctx.since(from)).toEqual([{ type: 'defaultRecipe.changed', recipe: recipe('spotify') }])
    expect(ctx.journal.lines.pop()).toEqual({ type: 'default-recipe', recipe: recipe('spotify') })
    expect(ctx.core.globals().defaultRecipe).toEqual(recipe('spotify'))
  })

  it('emits one row update when a policy or capability change makes a plan current or stale', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    ctx.core.update(a, { plan: planFor(ctx.queue.get(a)!, 2, 1) })
    ctx.core.update(b, { plan: planFor(ctx.queue.get(b)!, 1, 1) })
    expect(ctx.core.view(a)!.plan!.current).toBe(false)
    const from = ctx.mark()
    ctx.core.setPolicy({ ...POLICY, rev: 2 })
    expect(ctx.since(from)).toEqual([
      { type: 'policy.changed', policy: { ...POLICY, rev: 2 } },
      { type: 'job.updated', jobId: a, rev: ctx.queue.get(a)!.rev, patch: { plan: expect.objectContaining({ current: true }) } },
      { type: 'job.updated', jobId: b, rev: ctx.queue.get(b)!.rev, patch: { plan: expect.objectContaining({ current: false }) } }
    ])
    expect(ctx.journal.lines.pop()).toEqual({ type: 'policy', policy: { ...POLICY, rev: 2 } })
    expect(ctx.core.globals()).toMatchObject({ policy: { rev: 2 }, limits: { maxJobs: 10_000 } })
    const next = ctx.mark()
    ctx.core.setCapabilities({ ...CAPS, rev: 2 })
    expect(typesOf(ctx.since(next))).toEqual(['capabilities.changed', 'job.updated'])
  })

  it('keeps every emitted event and journal line wire safe', async () =>
  {
    const ctx = setup({ jobs: 3, views: { audioPlan: (job) => (job.measurement === null ? null : [CELL]) } })
    const [a, b, c] = ctx.ids
    ctx.core.update(a, { plan: planFor(ctx.queue.get(a)!) })
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch', { stage: stageOf('probe'), progress: { ...progressOf('probe', 0), etaSec: Number.NaN } as JobProgress })
    ctx.core.measured(a, { ...MEASUREMENT, extra: undefined } as unknown as JobMeasurement)
    ctx.core.transition(a, ['analyzing'], 'measured', { stage: stageOf('encode') })
    ctx.core.progress(a, { ...progressOf('encode', 10), speed: Number.POSITIVE_INFINITY } as JobProgress)
    ctx.core.transition(a, ['encoding'], 'encoded', { stage: stageOf('verify') })
    ctx.core.verified(a, VERIFICATION)
    ctx.core.transition(a, ['verifying'], 'hold')
    toEncoding(ctx.core, b)
    ctx.core.pauseRun('stop-running', 'user')
    ctx.core.settleAbort(b)
    ctx.core.recordCommand(c, { stage: 'probe', encodePass: null, display: 'ffprobe -i "C:\\media\\file-3.mp4"' })
    ctx.core.cancelRun()
    ctx.core.transition(a, ['held'], 'discard')
    ctx.core.transition(a, ['canceled'], 'retry', { change: { runId: formatRunId(2) } })
    ctx.core.setDefaultRecipe(recipe())
    ctx.core.interruptActive('crash')
    ctx.core.remove([c])
    ctx.journal.settle()
    await ctx.timers.advance(1_000)
    expect(ctx.drafts().length).toBeGreaterThan(20)
    expectWireSafe(ctx)
    const snapshot = ctx.core.snapshot(ctx.bus.lastSeq())
    assertWireSafe(snapshot)
    assertWireSafe(ctx.core.persisted())
    expect(ctx.queue.get(a)!.progress).toBeNull()
  })
})

const ERROR = { code: 'encode-failed', short: 'Encode failed', message: 'FFmpeg exited with code 1.', stage: 'encode', at: 1_000, stderrTail: 'x' } as unknown as JobError

const FACTS = { container: 'mp4', durationSec: 10 } as unknown as MediaFacts

function logText(lines: number): string
{
  return Array.from({ length: lines }, (_, index) => `frame=${index} fps=30 q=28.0 size=${index * 10}kB time=00:00:${String(index % 60).padStart(2, '0')}.00 bitrate=1000.0kbits/s speed=2.0x`).join('\n')
}

describe('detail', () =>
{
  it('returns the last 16 KiB of the attempt output in memory, with the stages and commands of the latest attempt', async () =>
  {
    const ring = createAttemptRing()
    let target: JobId | null = null
    const ctx = setup({ jobs: 1, detail: { ring: (id) => (id === target ? ring : null), media: () => FACTS } })
    const [id] = ctx.ids
    target = id
    ring.beginProcess('ffmpeg -i "C:\\media\\file-1.mp4" out.mp4')
    ring.push(`${logText(400)}
`)
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(id, ['queued'], 'dispatch', { stage: stageOf('probe') })
    await ctx.timers.advance(100)
    ctx.core.stage(id, { ...stageOf('measure'), startedAt: 1_100 })
    ctx.core.recordCommand(id, { stage: 'measure', encodePass: null, display: 'ffmpeg -i "C:\\media\\file-1.mp4" -af ebur128 -f null -' })
    await ctx.timers.advance(100)
    ctx.core.measured(id, MEASUREMENT)
    ctx.core.transition(id, ['analyzing'], 'measured', { stage: { ...stageOf('encode'), startedAt: 1_200 } })
    ctx.core.recordCommand(id, { stage: 'encode', encodePass: 1, display: 'ffmpeg -i "C:\\media\\file-1.mp4" out.mp4' })
    ctx.core.recordCommand('MM-9999' as JobId, { stage: 'encode', encodePass: 1, display: 'ffmpeg' })
    const detail = await ctx.core.get(id)
    expect(detail).not.toBeNull()
    expect(detail!.view).toEqual(ctx.core.view(id))
    expect(detail).toMatchObject({ plan: null, media: FACTS, measurement: MEASUREMENT, verification: null, result: null, error: null, attempts: [] })
    expect(detail!.stderrTail).toBe(ring.tail(DETAIL_TAIL_BYTES))
    expect(Buffer.byteLength(detail!.stderrTail!, 'utf8')).toBeLessThanOrEqual(DETAIL_TAIL_BYTES)
    expect(Buffer.byteLength(detail!.stderrTail!, 'utf8')).toBeGreaterThan(DETAIL_TAIL_BYTES - 200)
    expect(detail!.stderrTail!.endsWith(`${logText(400).split('\n').pop()!}\n`)).toBe(true)
    expect(detail!.stages).toEqual([
      { id: 'probe', pass: 1, passes: 1, label: 'probe 1 of 1', startedAt: 1_000, endedAt: 1_100, outcome: 'done' },
      { id: 'measure', pass: 1, passes: 1, label: 'measure 1 of 1', startedAt: 1_100, endedAt: 1_200, outcome: 'done' },
      { id: 'encode', pass: 1, passes: 1, label: 'encode 1 of 1', startedAt: 1_200, endedAt: null, outcome: 'active' }
    ])
    expect(detail!.commands.map((command) => command.stage)).toEqual(['measure', 'encode'])
    ctx.core.transition(id, ['encoding'], 'fail', { change: { error: ERROR } })
    const failed = await ctx.core.get(id)
    expect(failed!.stages[2]).toMatchObject({ outcome: 'failed', endedAt: 1_200 })
    expect(failed!.error).toEqual(ERROR)
    expect(failed!.view.error).toEqual({ code: 'encode-failed', short: 'Encode failed', message: 'FFmpeg exited with code 1.', stage: 'encode', at: 1_000 })
    ctx.core.transition(id, ['failed'], 'retry')
    expect(await ctx.core.get(id)).toMatchObject({ stages: [], commands: [] })
  })

  it('reads the attempt log of a started job whose output left memory, cut to its last 16 KiB at a line boundary', async () =>
  {
    const text = logText(600)
    const reads: string[] = []
    const ctx = setup({ jobs: 2, detail: { logsDir: 'C:\\logs', readLog: async (path) =>
    {
      reads.push(path)
      return text
    } } })
    const [a, b] = ctx.ids
    expect((await ctx.core.get(a))!.stderrTail).toBeNull()
    expect(reads).toEqual([])
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(a, ['queued'], 'dispatch')
    const detail = await ctx.core.get(a)
    expect(reads).toEqual([attemptLogPath('C:\\logs', RUN, a, 1)])
    expect(detail!.stderrTail).toBe(tailAtLineBoundary(text, DETAIL_TAIL_BYTES))
    expect(Buffer.byteLength(detail!.stderrTail!, 'utf8')).toBeLessThanOrEqual(DETAIL_TAIL_BYTES)
    expect(text.endsWith(detail!.stderrTail!)).toBe(true)
    expect(text[text.length - detail!.stderrTail!.length - 1]).toBe('\n')
    expect((await ctx.core.get(b))!.stderrTail).toBeNull()
    expect(await ctx.core.get('MM-9999' as JobId)).toBeNull()
  })

  it('returns no tail when the attempt log is missing or cannot be read', async () =>
  {
    let fail = false
    const ctx = setup({ jobs: 1, detail: { logsDir: 'C:\\logs', readLog: async () =>
    {
      if (fail)
      {
        throw new Error('EACCES: permission denied')
      }
      return null
    } } })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(id, ['queued'], 'dispatch')
    expect((await ctx.core.get(id))!.stderrTail).toBeNull()
    fail = true
    expect((await ctx.core.get(id))!.stderrTail).toBeNull()
    expect(ctx.warnings().pop()).toBe(`Could not read the attempt log of ${id}: EACCES: permission denied`)
  })

  it('reads a terminal job\'s detail back from its history record', async () =>
  {
    const plan = { class: 'video-cpu', output: { finalPath: 'C:\\media\\out.mp4' } } as unknown as JobPlan
    const attempt = { attempt: 1, state: 'failed' } as unknown as AttemptRecord
    const record = { plan, measurement: MEASUREMENT, verification: VERIFICATION, result: RESULT, error: ERROR, attempts: [attempt], logFile: 'C:\\logs\\run-1\\x.log' } as unknown as HistoryRecord
    let broken = false
    const reads: string[] = []
    const ctx = setup({ jobs: 2, detail: {
      history: async () =>
      {
        if (broken)
        {
          throw new Error('truncated record')
        }
        return record
      },
      readLog: async (path) =>
      {
        reads.push(path)
        return 'first line\nlast line'
      }
    } })
    const [a, b] = ctx.ids
    ctx.core.update(a, { history: { runId: RUN, offset: 0, length: 512 } })
    const detail = await ctx.core.get(a)
    expect(detail).toMatchObject({ plan, measurement: MEASUREMENT, verification: VERIFICATION, result: RESULT, error: ERROR, attempts: [attempt], stderrTail: 'first line\nlast line' })
    expect(reads).toEqual(['C:\\logs\\run-1\\x.log'])
    expect(await ctx.core.get(b)).toMatchObject({ plan: null, attempts: [], stderrTail: null })
    broken = true
    expect(await ctx.core.get(a)).toMatchObject({ plan: null, measurement: null, attempts: [], stderrTail: null })
    expect(ctx.warnings().pop()).toBe(`Could not read the history record of ${a}: truncated record`)
  })
})

describe('queue changes', () =>
{
  it('changes other fields with one job.updated and refuses the fields only a transition or a stage changes', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    const rev = ctx.queue.get(id)!.rev
    const from = ctx.mark()
    expect(ctx.core.update(id, { previewed: true, rerunOf: undefined })).toMatchObject({ previewed: true, rev: rev + 1 })
    expect(ctx.journal.lines.pop()).toEqual({ type: 'job.change', jobId: id, rev: rev + 1, inputsRev: ctx.queue.get(id)!.inputsRev, change: { previewed: true } })
    expect(ctx.core.update(id, { previewed: true })).toMatchObject({ rev: rev + 1 })
    expect(ctx.core.update(id, { state: 'done' })).toBeNull()
    expect(ctx.core.update(id, { stage: stageOf('probe'), progress: null })).toBeNull()
    expect(ctx.core.update('MM-9999' as JobId, { previewed: false })).toBeNull()
    expect(ctx.since(from)).toEqual([{ type: 'job.updated', jobId: id, rev: rev + 1, patch: { previewed: true } }])
    expect(ctx.warnings()).toEqual([
      `Ignored a change to ${id}: state change only through a transition or a stage`,
      `Ignored a change to ${id}: stage, progress change only through a transition or a stage`,
      'Ignored a change to MM-9999: no such job'
    ])
  })

  it('bumps inputsRev on an input change, which makes the plan stale in the same update', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    ctx.core.update(id, { plan: planFor(ctx.queue.get(id)!) })
    expect(ctx.core.view(id)!.plan!.current).toBe(true)
    const inputsRev = ctx.queue.get(id)!.inputsRev
    const from = ctx.mark()
    ctx.core.update(id, { recipe: recipe('spotify') }, { inputs: true })
    const [event] = ctx.since(from)
    expect(event).toMatchObject({ type: 'job.updated', patch: { inputsRev: inputsRev + 1, plan: expect.objectContaining({ current: false }) } })
  })

  it('adds jobs with one job.added each, chained after their predecessor', () =>
  {
    const ctx = setup({ jobs: 2, block: 4 })
    const [a, b] = ctx.ids
    const from = ctx.mark()
    const added = ctx.core.add([init('x.mp4'), init('y.mp4')], a)!
    expect(ctx.queue.order()).toEqual([a, added[0].id, added[1].id, b])
    expect(ctx.since(from)).toEqual([
      { type: 'job.added', job: ctx.core.view(added[0].id), after: a },
      { type: 'job.added', job: ctx.core.view(added[1].id), after: added[0].id }
    ])
    expect(ctx.journal.lines.pop()).toEqual({ type: 'job.add', after: a, jobs: added.map(persistedJob) })
    expect(ctx.core.add([])).toEqual([])
    expect(ctx.core.add([init('z.mp4')])).toBeNull()
    expect(ctx.warnings().pop()).toBe('Could not add 1 jobs: too few catalog numbers are reserved')
    expect(ctx.since(from)).toHaveLength(2)
  })

  it('removes and restores jobs, a restored head job included', () =>
  {
    const ctx = setup({ jobs: 3 })
    const [a, b, c] = ctx.ids
    expect(ctx.core.remove(['MM-9999' as JobId])).toEqual([])
    expect(ctx.core.restore([])).toEqual([])
    const removed = ctx.core.remove([a, c])
    expect(ctx.queue.order()).toEqual([b])
    const from = ctx.mark()
    expect(ctx.core.restore(removed)).toEqual([a, c])
    expect(ctx.queue.order()).toEqual([a, b, c])
    expect(ctx.since(from)).toEqual([
      { type: 'job.added', job: ctx.core.view(a), after: null },
      { type: 'job.added', job: ctx.core.view(c), after: b },
      { type: 'queue.order', order: [a, b, c] }
    ])
  })

  it('emits queue.order only when a reorder or a move changes the order', () =>
  {
    const ctx = setup({ jobs: 2 })
    const [a, b] = ctx.ids
    const from = ctx.mark()
    expect(ctx.core.move([a], 'top').changed).toBe(false)
    expect(ctx.core.reorder([a], b)?.changed ?? false).toBe(false)
    expect(ctx.core.reorder([b], a)!.changed).toBe(true)
    expect(ctx.since(from)).toEqual([{ type: 'queue.order', order: [b, a] }])
    expect(ctx.journal.lines.pop()).toEqual({ type: 'queue.order', order: [b, a] })
  })

  it('keeps alerts from the start and lists them', () =>
  {
    const timers = createManualTimers(1_000)
    const log = fakeLog()
    const bus = createJobEventBus({ timers, log })
    const core = createEngineCore({
      queue: new JobQueue({ numbers: numbers(), now: () => timers.now() }),
      bus,
      journal: fakeJournal(),
      log,
      now: () => timers.now(),
      state: { policy: POLICY, settings: SETTINGS, defaultRecipe: recipe(), capabilities: CAPS, workers: WORKERS, presets: { user: [], pins: {}, recent: [] }, recentFolders: [], alerts: [ALERT], maxJobs: 50 },
      summarize: summaryOf
    })
    expect(core.alerts()).toEqual([ALERT])
    core.raiseAlert({ ...ALERT, id: 'alert-2' })
    expect(core.alerts().map((alert) => alert.id)).toEqual(['alert-1', 'alert-2'])
    expect(core.snapshot(0)).toMatchObject({ seq: 0, limits: { maxJobs: 50 }, alerts: [ALERT, { ...ALERT, id: 'alert-2' }] })
    expect(core.globals().limits).toEqual({ maxJobs: 50 })
  })
})

describe('restored runs', () =>
{
  it('settles a restored run record that lost its id or start without a summary or a crash', () =>
  {
    const ctx = setup({ run: { status: 'running', runId: null, startedAt: null, pause: null, needsAck: null, interruptions: 0 } })
    ctx.core.settle()
    expect(ctx.core.run().status).toBe('idle')
    expect(ctx.summaries).toEqual([])
    const restored = setup({ run: { status: 'paused', runId: RUN, startedAt: null, pause: { mode: 'finish-running', reason: 'restored', since: 0 }, needsAck: null, interruptions: 2 } })
    restored.core.settle()
    expect(restored.summaries).toEqual([expect.objectContaining({ runId: RUN, startedAt: 1_000, endedAt: 1_000, interruptions: 2, endedBy: 'completed' })])
  })

  it('applies an abort recorded before a restart with the reason of its intent', () =>
  {
    const ctx = setup({ jobs: 1 })
    const [id] = ctx.ids
    startAll(ctx.core, ctx.ids)
    ctx.core.transition(id, ['queued'], 'dispatch')
    ctx.queue.update(id, { abort: 'requeue' })
    expect(ctx.core.settleAbort(id)).toMatchObject({ applied: true, job: { state: 'queued', reason: 'requeued-pause' } })
  })

  it('logs a listener that throws something other than an error', () =>
  {
    const ctx = setup({ jobs: 1 })
    ctx.core.onRunState(() =>
    {
      throw 'gone'
    })
    startAll(ctx.core, ctx.ids)
    expect(ctx.log.lines.some((line) => line.level === 'error' && line.message === 'A listener failed: gone')).toBe(true)
  })

  it('reads attempts kept on the job before the history record', async () =>
  {
    const attempt = { attempt: 1, state: 'failed' } as unknown as AttemptRecord
    const ctx = setup({ jobs: 1, detail: { history: async () => ({ attempts: [] }) as unknown as HistoryRecord } })
    const [id] = ctx.ids
    ctx.core.update(id, { attempts: [attempt], history: { runId: RUN, offset: 0, length: 1 } })
    expect((await ctx.core.get(id))!.attempts).toEqual([attempt])
  })
})

describe('plan summaries', () =>
{
  it('summarizes a plan from the plan alone: the renamed name, a skip, and a copy', () =>
  {
    const plan = { class: 'copy', output: { finalPath: 'C:\\out\\a.mp4', renamedTo: 'C:\\out\\a (2).mp4', container: 'mp4', resolution: 'rename' } } as unknown as JobPlan
    expect(basicPlanSummary(plan, true)).toEqual({ status: 'ready', current: true, finalName: 'a (2).mp4', relativePath: 'a (2).mp4', container: 'mp4', resolution: 'rename', encoderLabel: 'copy', errors: 0, warnings: 0, firstIssue: null })
    const skip = { class: 'audio', output: { finalPath: '/out/b.wav', renamedTo: null, container: 'wav', resolution: 'skip' } } as unknown as JobPlan
    expect(basicPlanSummary(skip, false)).toMatchObject({ status: 'will-skip', current: false, finalName: 'b.wav', encoderLabel: '' })
  })

  it('holds a plan current only while its basis matches the inputs, the policy, and the capabilities', () =>
  {
    const ctx = setup({ jobs: 1 })
    const job = ctx.queue.get(ctx.ids[0])!
    expect(planIsCurrent(job, 1, 1)).toBe(false)
    const planned = { ...job, plan: planFor(job) }
    expect(planIsCurrent(planned, 1, 1)).toBe(true)
    expect(planIsCurrent({ ...planned, inputsRev: job.inputsRev + 1 }, 1, 1)).toBe(false)
    expect(planIsCurrent(planned, 2, 1)).toBe(false)
    expect(planIsCurrent(planned, 1, 2)).toBe(false)
  })

  it('builds a row from a job and patches only the fields that differ', () =>
  {
    const ctx = setup({ jobs: 1 })
    const job = ctx.queue.get(ctx.ids[0])!
    const builders = { planSummary: basicPlanSummary, audioPlan: () => [CELL] }
    const view = toJobView({ ...job, plan: planFor(job), error: ERROR }, { policyRev: 1, capabilitiesRev: 1, builders })
    expect(view).toMatchObject({ id: job.id, state: 'pending', plan: { current: true, finalName: 'file-1.mp4-out.mp4' }, audioPlan: [CELL], stamp: null, albumGroupId: null })
    expect(view.error).toEqual({ code: 'encode-failed', short: 'Encode failed', message: 'FFmpeg exited with code 1.', stage: 'encode', at: 1_000 })
    const changed = { ...view, rev: view.rev + 1, previewed: true, warnings: [...view.warnings], audioPlan: [{ ...CELL }] }
    expect(viewPatch(view, changed)).toEqual({ rev: view.rev + 1, previewed: true })
    expect(viewPatch(view, changed, ['rev'])).toEqual({ previewed: true })
    expect(idleRun()).toEqual({ status: 'idle', runId: null, startedAt: null, pause: null, needsAck: null, interruptions: 0 })
  })
})

describe('journal', () =>
{
  it('replays the lines written after a persisted body to the body persisted after them', () =>
  {
    const ctx = setup({ jobs: 4 })
    const [a, b, c, d] = ctx.ids
    const body = ctx.core.persisted()
    const lines = ctx.journal.lines.length
    ctx.core.update(a, { plan: planFor(ctx.queue.get(a)!) })
    ctx.core.update(b, { previewed: true }, { inputs: true })
    startAll(ctx.core, [a, b, c])
    ctx.core.reorder([c], a)
    ctx.core.transition(a, ['queued'], 'dispatch', { stage: stageOf('probe') })
    ctx.core.measured(a, MEASUREMENT)
    ctx.core.transition(a, ['analyzing'], 'measured', { stage: stageOf('encode') })
    ctx.core.transition(a, ['encoding'], 'requeue', { reason: 'requeued-disk' })
    ctx.core.transition(c, ['queued'], 'dispatch')
    ctx.core.transition(c, ['analyzing'], 'measured')
    ctx.core.transition(c, ['encoding'], 'encoded')
    ctx.core.verified(c, VERIFICATION)
    ctx.core.transition(c, ['verifying'], 'hold')
    const removed = ctx.core.remove([d])
    ctx.core.restore(removed)
    ctx.core.remove([b])
    ctx.core.add([init('late.mp4')], a)
    ctx.core.move([a], 'bottom')
    ctx.core.setPolicy({ ...POLICY, rev: 2 })
    ctx.core.setDefaultRecipe(recipe('spotify'))
    ctx.core.pauseRun('finish-running', 'user')
    ctx.core.transition(a, ['queued'], 'dispatch')
    const captured = ctx.core.interruptActive('session-end', { capture: true })
    const foreign = [{ type: 'workdir.create', token: 'x' }, { type: 'job.state', jobId: 'MM-9999', change: { state: 'done' }, rev: 9, inputsRev: 1 }]
    const replayed = replayJournal(body, [...foreign, ...ctx.journal.lines.slice(lines), ...captured])
    expect(replayed).toEqual(ctx.core.persisted())
    expect(replayed.jobs.map((job) => job.state)).toEqual(ctx.queue.jobs().map((job) => job.state))
    expect(replayed.jobs.every((job) => job.stage === null && job.progress === null)).toBe(true)
    expect(replayed.run).toMatchObject({ status: 'paused', runId: RUN, pause: { mode: 'finish-running', reason: 'user' } })
    expect(replayed.defaultRecipe).toEqual(recipe('spotify'))
  })

  it('places added jobs after a predecessor it no longer knows at the end, and with none at the head', () =>
  {
    const ctx = setup({ jobs: 2 })
    const body = ctx.core.persisted()
    const [first] = ctx.queue.jobs()
    const late = persistedJob({ ...first, id: 'MM-0050' as JobId })
    const head = persistedJob({ ...first, id: 'MM-0051' as JobId })
    const replayed = replayJournal(body, [
      { type: 'job.add', after: 'MM-0040', jobs: [late] },
      { type: 'job.add', after: null, jobs: [head, late] },
      { type: 'queue.order', order: [...body.order, 'MM-0050', 'MM-0051', 'MM-0099'] }
    ] as CoreJournalEntry[])
    expect(replayed.order).toEqual([...body.order, 'MM-0050', 'MM-0051'])
    const restored = replayJournal(body, [{ type: 'job.restore', jobs: [late], order: ['MM-0050', ...body.order, 'MM-0098'] }] as CoreJournalEntry[])
    expect(restored.order).toEqual(['MM-0050', ...body.order])
    expect(replayJournal({ ...body, order: [...body.order, 'MM-0097' as JobId] }, []).order).toEqual(body.order)
  })
})
