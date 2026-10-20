/**
 * The renderer's jobs store: the window is a projection of the engine's snapshot plus every sequenced event after
 * it. Guards the snapshot merge with buffered events, duplicate and gap handling with resync, one store update per
 * batch, the disposed-reply guard (React's double effect), retries, the reducer's idempotent upserts and row
 * identity, the row and header selectors, and per-row subscriptions that re-render only the row that changed.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import type { CommandResult, JobEvent } from '../../src/shared/jobs/contract'
import type { JobId, RunId } from '../../src/shared/jobs/ids'
import { attentionCount } from '../../src/shared/jobs/states'
import type
{
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  EngineSnapshot,
  JobCounts,
  JobMeasurement,
  JobPatch,
  JobProgress,
  JobStage,
  JobState,
  JobView,
  RunAlert,
  RunSettings,
  RunState,
  ScanState,
  Verification
} from '../../src/shared/jobs/types'
import {
  MAX_BUFFERED_EVENTS,
  clearFocusRequest,
  createJobsStore,
  fromSnapshot,
  initialJobsState,
  reduceEvents,
  retryDelayMs,
  startJobsSync,
  useJobsStore,
  whenApplied,
  type JobsState,
  type JobsSyncDeps
} from '../../src/renderer/src/stores/jobs'
import {
  selectActiveJobs,
  selectAlerts,
  selectAttentionCount,
  selectAttentionIds,
  selectCapabilities,
  selectCompleted,
  selectDefaultRecipe,
  selectFocusRequest,
  selectGroupCounts,
  selectHydrated,
  selectJob,
  selectJobCount,
  selectJobMeasurement,
  selectJobNeedsAttention,
  selectJobProgress,
  selectJobStage,
  selectJobState,
  selectJobVerification,
  selectLatestRunId,
  selectOrder,
  selectOrderedJobs,
  selectPendingSummary,
  selectPolicy,
  selectPreflight,
  selectPresets,
  selectQueueFull,
  selectRecentFolders,
  selectRecentSettled,
  selectRun,
  selectRunId,
  selectRunJobs,
  selectRunPercent,
  selectRunStatus,
  selectScans,
  selectSettings,
  selectStateCounts,
  selectSyncStatus,
  selectWorkers
} from '../../src/renderer/src/stores/jobsSelectors'
import { useJobs, windowJobsApi } from '../../src/renderer/src/hooks/useJobs'

const AT = 1_760_000_000_000
const R30 = 'R-0030' as RunId
const R31 = 'R-0031' as RunId

function id(n: number): JobId
{
  return `MM-${String(n).padStart(4, '0')}` as JobId
}

function counts(over: Partial<JobCounts> = {}): JobCounts
{
  return {
    pending: 0, queued: 0, analyzing: 0, encoding: 0, verifying: 0, finalizing: 0,
    held: 0, done: 0, failed: 0, canceled: 0, skipped: 0, interrupted: 0, ...over
  }
}

function runState(over: Partial<RunState> = {}): RunState
{
  return {
    status: 'idle',
    runId: null,
    startedAt: null,
    pause: null,
    counts: counts(),
    progress: { percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 },
    workers:
    {
      setting: { mode: 'auto' },
      limits: { total: 16, videoCpu: 2, gpu: 4 },
      active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
    },
    quitWhenIdle: false,
    needsAck: null,
    ...over
  }
}

const RECIPE =
{
  kind: 'convert',
  presetId: 'mp4-h264',
  userPreset: null,
  container: 'mp4',
  video: { encoder: 'libx264', bitrateKbps: 5000, fit: null, fps: null, pixelFormat: 'yuv420p' },
  audio: { kind: 'copy' },
  channels: 'keep',
  subtitles: 'keep'
} as const

const POLICY: BatchPolicy =
{
  rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'auto'
}

const SETTINGS: RunSettings =
{
  workers: { mode: 'auto' },
  gpuSessions: { mode: 'auto' },
  priority: 'normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: true,
  includeSubfolders: true
}

const CAPABILITIES: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: '9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
  encoders: ['aac', 'libx264'],
  gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
  cpuCount: 16,
  platform: 'win32'
}

const MEASUREMENT = { pass: 'source', measuredAt: AT, streams: [], album: null, messages: [] } as unknown as JobMeasurement
const VERIFICATION = { verdict: 'verified', encodePasses: 1, audio: null, media: null, messages: [] } as unknown as Verification
const SUMMARY = { runId: R31, endedBy: 'completed' } as unknown as BatchSummary

function job(n: number, over: Partial<JobView> = {}): JobView
{
  return {
    id: id(n),
    seq: n,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Media\\clip-${n}.mkv`, name: `clip-${n}.mkv`, ext: 'mkv', dir: 'D:\\Media', size: 1_000_000 * n, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE as unknown as JobView['recipe'],
    recipeLabel: 'MP4 H.264',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'pending',
    plan: null,
    audioPlan: null,
    stamp: null,
    error: null,
    warnings: [],
    hold: null,
    waiting: null,
    waitingOn: null,
    analysis: null,
    previewed: false,
    acknowledged: false,
    runId: null,
    rerunOf: null,
    addedAt: AT + n,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function snapshot(over: Partial<EngineSnapshot> = {}): EngineSnapshot
{
  const jobs = over.jobs ?? []
  return {
    schema: 1,
    seq: 0,
    run: runState(),
    policy: POLICY,
    settings: SETTINGS,
    defaultRecipe: RECIPE as unknown as EngineSnapshot['defaultRecipe'],
    order: jobs.map((view) => view.id),
    jobs,
    capabilities: CAPABILITIES,
    scans: [],
    alerts: [],
    presets: { user: [], pins: {}, recent: [] },
    recentFolders: [],
    limits: { maxJobs: 10_000 },
    ...over
  }
}

function stage(over: Partial<JobStage> = {}): JobStage
{
  return { id: 'encode', pass: 1, passes: 1, label: 'Encode', startedAt: AT, ...over }
}

function progress(over: Partial<JobProgress> = {}): JobProgress
{
  return {
    stage: 'encode', pass: 1, passes: 1, percent: 10, stagePercent: 10, speed: 2, etaSec: 30,
    outTimeSec: 5, durationSec: 60, bytesWritten: 1000, elapsedMs: 2000, ...over
  }
}

function scan(scanId: string, visited: number): ScanState
{
  return {
    scanId, root: 'D:\\Rips', status: 'scanning', error: null, visited, added: visited,
    excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 }
  }
}

function alert(alertId: string, message: string): RunAlert
{
  return {
    id: alertId, kind: 'disk-space', severity: 'warning', message, at: AT, volume: 'D:', path: null, jobIds: [], counts: null, dismissible: true
  }
}

const ev =
{
  added: (seq: number, view: JobView, after: JobId | null = null): JobEvent => ({ type: 'job.added', seq, at: AT, job: view, after }),
  removed: (seq: number, jobId: JobId): JobEvent => ({ type: 'job.removed', seq, at: AT, jobId }),
  order: (seq: number, order: JobId[]): JobEvent => ({ type: 'queue.order', seq, at: AT, order }),
  updated: (seq: number, jobId: JobId, rev: number, patch: JobPatch): JobEvent => ({ type: 'job.updated', seq, at: AT, jobId, rev, patch }),
  state: (seq: number, jobId: JobId, rev: number, from: JobState, to: JobState, attempt: number, patch: JobPatch = {}): JobEvent =>
    ({ type: 'job.state', seq, at: AT, jobId, rev, from, to, attempt, reason: 'engine', patch }),
  stage: (seq: number, jobId: JobId, rev: number, next: JobStage): JobEvent => ({ type: 'job.stage', seq, at: AT, jobId, rev, stage: next }),
  progress: (seq: number, jobId: JobId, next: JobProgress): JobEvent => ({ type: 'job.progress', seq, at: AT, jobId, progress: next }),
  measured: (seq: number, jobId: JobId, rev: number): JobEvent => ({ type: 'job.measured', seq, at: AT, jobId, rev, measurement: MEASUREMENT }),
  verified: (seq: number, jobId: JobId, rev: number): JobEvent => ({ type: 'job.verified', seq, at: AT, jobId, rev, verification: VERIFICATION }),
  run: (seq: number, run: RunState): JobEvent => ({ type: 'run.state', seq, at: AT, run }),
  runProgress: (seq: number, percent: number): JobEvent =>
    ({ type: 'run.progress', seq, at: AT, progress: { percent, etaSec: 60, mediaSecPerSec: 3.4, aggregateSpeed: 3.4, bytesWritten: 10, elapsedMs: 1000 } })
}

interface PendingReply
{
  clientId: string
  resolve: (result: CommandResult<EngineSnapshot>) => void
  reject: (reason: unknown) => void
}

async function flush(): Promise<void>
{
  await Promise.resolve()
  await Promise.resolve()
}

function fakeApi()
{
  const listeners = new Set<(batch: unknown) => void>()
  const replies: PendingReply[] = []
  const calls: string[] = []
  const api =
  {
    onEvents: vi.fn((listener: (batch: unknown) => void) =>
    {
      calls.push('onEvents')
      listeners.add(listener)
      return () =>
      {
        listeners.delete(listener)
      }
    }),
    subscribe: vi.fn((req: { clientId: string }) =>
    {
      calls.push(`subscribe ${req.clientId}`)
      return new Promise<CommandResult<EngineSnapshot>>((resolve, reject) =>
      {
        replies.push({ clientId: req.clientId, resolve, reject })
      })
    }),
    unsubscribe: vi.fn(async (req: { clientId: string }) =>
    {
      calls.push(`unsubscribe ${req.clientId}`)
      return { ok: true as const, value: null, seq: 0 }
    })
  }
  return {
    api,
    replies,
    calls,
    listeners,
    emit(...events: JobEvent[]): void
    {
      for (const listener of [...listeners])
      {
        listener({ events })
      }
    },
    raw(batch: unknown): void
    {
      for (const listener of [...listeners])
      {
        listener(batch)
      }
    },
    async reply(index: number, value: EngineSnapshot): Promise<void>
    {
      replies[index].resolve({ ok: true, value, seq: value.seq })
      await flush()
    },
    async refuse(index: number, message: string): Promise<void>
    {
      replies[index].resolve({ ok: false, error: { code: 'internal', message, issues: [], details: null } })
      await flush()
    },
    async fail(index: number, reason: unknown): Promise<void>
    {
      replies[index].reject(reason)
      await flush()
    }
  }
}

function manualTimers()
{
  const tasks: Array<{ fn: () => void; ms: number; canceled: boolean }> = []
  const schedule = vi.fn((fn: () => void, ms: number) =>
  {
    const task = { fn, ms, canceled: false }
    tasks.push(task)
    return () =>
    {
      task.canceled = true
    }
  })
  return { schedule, tasks }
}

function started(over: Partial<JobsSyncDeps> = {})
{
  const store = createJobsStore()
  const fake = fakeApi()
  const timers = manualTimers()
  let serial = 0
  const dispose = startJobsSync({
    api: fake.api,
    store,
    clientId: () =>
    {
      serial += 1
      return `client-${serial}`
    },
    schedule: timers.schedule,
    ...over
  })
  return { store, fake, timers, dispose }
}

function countUpdates(store: StoreApi<JobsState>): () => number
{
  let updates = 0
  store.subscribe(() =>
  {
    updates += 1
  })
  return () => updates
}

function hydrated(value: EngineSnapshot): JobsState
{
  return fromSnapshot(value, initialJobsState())
}

const encoding: Partial<JobView> = { state: 'encoding', stage: stage(), runId: R31 }

beforeEach(() =>
{
  useJobsStore.setState(useJobsStore.getInitialState(), true)
})

afterEach(() =>
{
  cleanup()
  delete (window as { api?: unknown }).api
})

describe('fromSnapshot', () =>
{
  it('replaces every field the snapshot carries and keeps its queue order', () =>
  {
    const value = snapshot({
      seq: 40,
      jobs: [job(1), job(2), job(3)],
      order: [id(3), id(1), id(2)],
      run: runState({ status: 'running', runId: R31 }),
      scans: [scan('s1', 4)],
      alerts: [alert('a1', 'D: is nearly full.')],
      recentFolders: [{ path: 'D:\\Rips', name: 'Rips', files: 12, addedAt: AT }]
    })
    const state = hydrated(value)
    expect(state.seq).toBe(40)
    expect(state.status).toBe('hydrated')
    expect(state.error).toBeNull()
    expect(state.hydrations).toBe(1)
    expect(state.order).toEqual([id(3), id(1), id(2)])
    expect(state.jobs[id(2)]).toBe(value.jobs[1])
    expect(state.run).toBe(value.run)
    expect(state.policy).toBe(POLICY)
    expect(state.settings).toBe(SETTINGS)
    expect(state.defaultRecipe).toBe(value.defaultRecipe)
    expect(state.capabilities).toBe(CAPABILITIES)
    expect(state.limits).toEqual({ maxJobs: 10_000 })
    expect(state.scans).toBe(value.scans)
    expect(state.alerts).toBe(value.alerts)
    expect(state.presets).toBe(value.presets)
    expect(state.recentFolders).toBe(value.recentFolders)
  })

  it('drops unknown and repeated ids from the order and appends the jobs it leaves out', () =>
  {
    const state = hydrated(snapshot({ jobs: [job(1), job(2), job(3)], order: [id(2), id(99), id(2)] }))
    expect(state.order).toEqual([id(2), id(1), id(3)])
  })

  it('keeps the completed run and an unhandled focus request, and drops the per-job results', () =>
  {
    const previous: JobsState = {
      ...initialJobsState(),
      status: 'error',
      error: 'The engine is starting.',
      hydrations: 2,
      completed: SUMMARY,
      focus: { jobId: id(1), runId: null, seq: 9 },
      measurements: { [id(1)]: MEASUREMENT } as JobsState['measurements'],
      verifications: { [id(1)]: VERIFICATION } as JobsState['verifications'],
      preflight: { preflightId: 'p1', done: 2, total: 5 }
    }
    const state = fromSnapshot(snapshot({ jobs: [job(1)] }), previous)
    expect(state.hydrations).toBe(3)
    expect(state.status).toBe('hydrated')
    expect(state.error).toBeNull()
    expect(state.completed).toBe(SUMMARY)
    expect(state.focus).toBe(previous.focus)
    expect(state.measurements).toEqual({})
    expect(state.verifications).toEqual({})
    expect(state.preflight).toBeNull()
  })
})

describe('reduceEvents', () =>
{
  const base = hydrated(snapshot({ seq: 10, jobs: [job(1), job(2), job(3)], run: runState({ status: 'running', runId: R31 }) }))

  it('returns the same state for an empty batch and advances seq to the last event otherwise', () =>
  {
    expect(reduceEvents(base, [])).toBe(base)
    const next = reduceEvents(base, [ev.progress(11, id(1), progress()), ev.progress(12, id(2), progress())])
    expect(next.seq).toBe(12)
    expect(base.seq).toBe(10)
  })

  it('appends an added job when after is null or unknown and inserts it after a known job', () =>
  {
    const next = reduceEvents(base, [
      ev.added(11, job(4)),
      ev.added(12, job(5), id(1)),
      ev.added(13, job(6), id(99)),
      ev.added(14, job(7), id(6))
    ])
    expect(next.order).toEqual([id(1), id(5), id(2), id(3), id(4), id(6), id(7)])
    expect(next.jobs[id(5)].id).toBe(id(5))
    expect(base.order).toEqual([id(1), id(2), id(3)])
    expect(Object.keys(base.jobs)).toHaveLength(3)
  })

  it('replaces a known job in place when it is added again', () =>
  {
    const replacement = job(2, { rev: 5, recipeLabel: 'WAV 24-bit' })
    const next = reduceEvents(base, [ev.added(11, replacement, id(3))])
    expect(next.order).toEqual([id(1), id(2), id(3)])
    expect(next.jobs[id(2)]).toBe(replacement)
    expect(next.jobs[id(1)]).toBe(base.jobs[id(1)])
  })

  it('removes a job with its results and ignores the removal of an unknown job', () =>
  {
    const measured = reduceEvents(base, [ev.measured(11, id(2), 1), ev.verified(12, id(2), 1)])
    const next = reduceEvents(measured, [ev.removed(13, id(2)), ev.removed(14, id(99))])
    expect(next.order).toEqual([id(1), id(3)])
    expect(Object.hasOwn(next.jobs, id(2))).toBe(false)
    expect(next.measurements).toEqual({})
    expect(next.verifications).toEqual({})
    expect(Object.hasOwn(measured.jobs, id(2))).toBe(true)
    const untouched = reduceEvents(base, [ev.removed(11, id(99))])
    expect(untouched.jobs).toBe(base.jobs)
    expect(untouched.order).toBe(base.order)
  })

  it('removes a job that is missing from the order without touching the order', () =>
  {
    const odd: JobsState = { ...base, order: [id(1)] }
    const next = reduceEvents(odd, [ev.removed(11, id(3))])
    expect(Object.hasOwn(next.jobs, id(3))).toBe(false)
    expect(next.order).toEqual([id(1)])
  })

  it('reorders the queue, dropping unknown and repeated ids and keeping the jobs it leaves out', () =>
  {
    const next = reduceEvents(base, [ev.order(11, [id(3), id(1), id(99), id(3)])])
    expect(next.order).toEqual([id(3), id(1), id(2)])
    expect(next.jobs).toBe(base.jobs)
  })

  it('merges a patch, takes the event rev, and never changes the id or seq', () =>
  {
    const patch = { recipeLabel: 'AAC 256k', id: id(77), seq: 77, rev: 2 } as unknown as JobPatch
    const next = reduceEvents(base, [ev.updated(11, id(1), 4, patch), ev.updated(12, id(99), 4, { recipeLabel: 'x' })])
    expect(next.jobs[id(1)]).toMatchObject({ id: id(1), seq: 1, rev: 4, recipeLabel: 'AAC 256k' })
    expect(next.jobs[id(2)]).toBe(base.jobs[id(2)])
    expect(Object.hasOwn(next.jobs, id(99))).toBe(false)
  })

  it('applies a state change with its patch and drops the results of an earlier attempt', () =>
  {
    const measured = reduceEvents(base, [ev.measured(11, id(1), 1), ev.verified(12, id(1), 1), ev.measured(13, id(2), 1)])
    const queued = reduceEvents(measured, [ev.state(14, id(1), 2, 'pending', 'queued', 1, { runId: R31 })])
    expect(queued.jobs[id(1)]).toMatchObject({ state: 'queued', attempt: 1, reason: 'engine', rev: 2, runId: R31 })
    expect(queued.measurements[id(1)]).toBe(MEASUREMENT)
    const retried = reduceEvents(queued, [
      ev.state(15, id(1), 3, 'queued', 'failed', 1),
      ev.state(16, id(1), 4, 'failed', 'queued', 2),
      ev.state(17, id(99), 1, 'pending', 'queued', 1)
    ])
    expect(retried.jobs[id(1)]).toMatchObject({ state: 'queued', attempt: 2, rev: 4 })
    expect(Object.hasOwn(retried.measurements, id(1))).toBe(false)
    expect(Object.hasOwn(retried.verifications, id(1))).toBe(false)
    expect(retried.measurements[id(2)]).toBe(MEASUREMENT)
  })

  it('keeps progress only while it belongs to the new stage and pass', () =>
  {
    const running = reduceEvents(base, [
      ev.state(11, id(1), 2, 'queued', 'analyzing', 1, { stage: stage({ id: 'measure', label: 'Measure' }), progress: progress({ stage: 'measure' }) }),
      ev.state(12, id(2), 2, 'queued', 'encoding', 1, { stage: stage(), progress: progress() })
    ])
    const next = reduceEvents(running, [
      ev.stage(13, id(1), 3, stage()),
      ev.stage(14, id(2), 3, stage({ label: 'Encode, 2-pass' })),
      ev.stage(15, id(3), 2, stage())
    ])
    expect(next.jobs[id(1)].progress).toBeNull()
    expect(next.jobs[id(1)].stage?.id).toBe('encode')
    expect(next.jobs[id(2)].progress).toBe(running.jobs[id(2)].progress)
    expect(next.jobs[id(3)].progress).toBeNull()
    const secondPass = reduceEvents(next, [ev.stage(16, id(2), 4, stage({ pass: 2, passes: 2 }))])
    expect(secondPass.jobs[id(2)].progress).toBeNull()
    expect(secondPass.jobs[id(2)].rev).toBe(4)
  })

  it('drops the progress of the stage a state change leaves when its patch carries no progress', () =>
  {
    const running = reduceEvents(base, [
      ev.state(11, id(1), 2, 'queued', 'encoding', 1, { stage: stage(), progress: progress({ percent: 80 }) }),
      ev.state(12, id(2), 2, 'queued', 'encoding', 1, { stage: stage(), progress: progress({ percent: 30 }) }),
      ev.state(13, id(3), 2, 'queued', 'encoding', 1, { stage: stage(), progress: progress({ percent: 55 }) })
    ])
    const verify = stage({ id: 'verify', label: 'Verify' })
    const requeued = { ...ev.state(15, id(2), 3, 'encoding', 'queued', 1, { stage: null }), reason: 'requeued-pause' } as JobEvent
    const next = reduceEvents(running, [
      ev.state(14, id(1), 3, 'encoding', 'verifying', 1, { stage: verify }),
      requeued,
      ev.state(16, id(3), 3, 'encoding', 'held', 1)
    ])
    expect(next.jobs[id(1)]).toMatchObject({ state: 'verifying', stage: verify, progress: null })
    expect(next.jobs[id(2)]).toMatchObject({ state: 'queued', reason: 'requeued-pause', stage: null, progress: null })
    expect(next.jobs[id(3)].state).toBe('held')
    expect(next.jobs[id(3)].stage).toBe(running.jobs[id(3)].stage)
    expect(next.jobs[id(3)].progress).toBe(running.jobs[id(3)].progress)
  })

  it('sets progress on one job and leaves every other job and the order as they were', () =>
  {
    const value = progress({ percent: 42 })
    const next = reduceEvents(base, [ev.progress(11, id(2), value), ev.progress(12, id(99), value)])
    expect(next.jobs[id(2)].progress).toBe(value)
    expect(next.jobs[id(1)]).toBe(base.jobs[id(1)])
    expect(next.jobs[id(3)]).toBe(base.jobs[id(3)])
    expect(next.order).toBe(base.order)
    expect(next.run).toBe(base.run)
  })

  it('keeps measurements and verifications per job and moves the row rev only when it changes', () =>
  {
    const next = reduceEvents(base, [
      ev.measured(11, id(1), 1),
      ev.verified(12, id(2), 3),
      ev.measured(13, id(99), 2),
      ev.verified(14, id(99), 2),
      ev.verified(15, id(3), 1)
    ])
    expect(next.measurements[id(1)]).toBe(MEASUREMENT)
    expect(next.verifications[id(2)]).toBe(VERIFICATION)
    expect(next.jobs[id(1)]).toBe(base.jobs[id(1)])
    expect(next.jobs[id(2)]).not.toBe(base.jobs[id(2)])
    expect(next.jobs[id(2)].rev).toBe(3)
    expect(Object.keys(next.measurements)).toEqual([id(1)])
    expect(Object.keys(next.verifications)).toEqual([id(2), id(3)])
    expect(base.verifications).toEqual({})
  })

  it('applies run, workers, and completion events', () =>
  {
    const run = runState({ status: 'pausing', runId: R31 })
    const workers = { ...runState().workers, active: { total: 6, videoCpu: 1, gpu: 2, analysis: 0, starting: 1 } }
    const next = reduceEvents(base, [
      ev.run(11, run),
      ev.runProgress(12, 46),
      { type: 'workers.changed', seq: 13, at: AT, workers },
      { type: 'run.completed', seq: 14, at: AT, summary: SUMMARY }
    ])
    expect(next.run?.status).toBe('pausing')
    expect(next.run?.progress.percent).toBe(46)
    expect(next.run?.workers).toBe(workers)
    expect(next.run?.counts).toBe(run.counts)
    expect(next.completed).toBe(SUMMARY)
  })

  it('ignores run progress and workers before any run state exists', () =>
  {
    const next = reduceEvents(initialJobsState(), [ev.runProgress(1, 5), { type: 'workers.changed', seq: 2, at: AT, workers: runState().workers }])
    expect(next.run).toBeNull()
    expect(next.seq).toBe(2)
  })

  it('upserts alerts and scans and clears an alert by id', () =>
  {
    const next = reduceEvents(base, [
      { type: 'run.alert', seq: 11, at: AT, alert: alert('a1', 'D: has 1.2 GB free.') },
      { type: 'run.alert', seq: 12, at: AT, alert: alert('a2', 'NVENC refused a session.') },
      { type: 'run.alert', seq: 13, at: AT, alert: alert('a1', 'D: has 0.8 GB free.') },
      { type: 'scan.progress', seq: 14, at: AT, scan: scan('s1', 10) },
      { type: 'scan.progress', seq: 15, at: AT, scan: scan('s2', 3) },
      { type: 'scan.progress', seq: 16, at: AT, scan: scan('s1', 25) }
    ])
    expect(next.alerts.map((item) => [item.id, item.message])).toEqual([['a1', 'D: has 0.8 GB free.'], ['a2', 'NVENC refused a session.']])
    expect(next.scans.map((item) => [item.scanId, item.visited])).toEqual([['s1', 25], ['s2', 3]])
    const cleared = reduceEvents(next, [{ type: 'run.alertCleared', seq: 17, at: AT, alertId: 'a1' }])
    expect(cleared.alerts.map((item) => item.id)).toEqual(['a2'])
    const unknown = reduceEvents(cleared, [{ type: 'run.alertCleared', seq: 18, at: AT, alertId: 'a9' }])
    expect(unknown.alerts).toBe(cleared.alerts)
  })

  it('replaces settings, policy, capabilities, presets, recent folders, and the default recipe, and records preflight progress and focus', () =>
  {
    const settings = { ...SETTINGS, keepAwake: false }
    const policy = { ...POLICY, rev: 2, conflict: 'skip' as const }
    const capabilities = { ...CAPABILITIES, rev: 2 }
    const presets = { user: [], pins: { 1: 'streaming' }, recent: [] }
    const recentFolders = [{ path: 'E:\\Shows', name: 'Shows', files: 40, addedAt: AT }]
    const defaultRecipe = { ...RECIPE } as unknown as EngineSnapshot['defaultRecipe']
    const next = reduceEvents(base, [
      { type: 'settings.changed', seq: 11, at: AT, settings },
      { type: 'policy.changed', seq: 12, at: AT, policy },
      { type: 'capabilities.changed', seq: 13, at: AT, capabilities },
      { type: 'presets.changed', seq: 14, at: AT, presets },
      { type: 'folders.changed', seq: 15, at: AT, recentFolders },
      { type: 'preflight.progress', seq: 16, at: AT, preflightId: 'p7', done: 3, total: 12 },
      { type: 'ui.focus', seq: 17, at: AT, jobId: id(2), runId: R31 },
      { type: 'defaultRecipe.changed', seq: 18, at: AT, recipe: defaultRecipe }
    ])
    expect(next.settings).toBe(settings)
    expect(next.policy).toBe(policy)
    expect(next.capabilities).toBe(capabilities)
    expect(next.presets).toBe(presets)
    expect(next.recentFolders).toBe(recentFolders)
    expect(next.preflight).toEqual({ preflightId: 'p7', done: 3, total: 12 })
    expect(next.focus).toEqual({ jobId: id(2), runId: R31, seq: 17 })
    expect(next.defaultRecipe).toBe(defaultRecipe)
  })

  it('ignores an event type it does not know but still moves seq', () =>
  {
    const next = reduceEvents(base, [{ type: 'job.renamed', seq: 11, at: AT } as unknown as JobEvent])
    expect(next.seq).toBe(11)
    expect(next.jobs).toBe(base.jobs)
    expect(next.order).toBe(base.order)
  })
})

describe('startJobsSync', () =>
{
  it('listens to events before it subscribes', () =>
  {
    const { store, fake, dispose } = started()
    expect(fake.calls).toEqual(['onEvents', 'subscribe client-1'])
    expect(store.getState().status).toBe('connecting')
    dispose()
  })

  it('hydrates from the snapshot plus the buffered events after its seq, in one store update', async () =>
  {
    const { store, fake, dispose } = started()
    fake.emit(ev.progress(9, id(1), progress({ percent: 1 })), ev.progress(10, id(1), progress({ percent: 2 })))
    fake.emit(ev.progress(11, id(1), progress({ percent: 3 })), ev.added(12, job(2)))
    const updates = countUpdates(store)
    expect(store.getState().hydrations).toBe(0)
    await fake.reply(0, snapshot({ seq: 10, jobs: [job(1, encoding)] }))
    const state = store.getState()
    expect(updates()).toBe(1)
    expect(state.status).toBe('hydrated')
    expect(state.seq).toBe(12)
    expect(state.jobs[id(1)].progress?.percent).toBe(3)
    expect(state.order).toEqual([id(1), id(2)])
    dispose()
  })

  it('ignores duplicates once hydrated and applies only the events after the last seq', async () =>
  {
    const { store, fake, dispose } = started()
    await fake.reply(0, snapshot({ seq: 12, jobs: [job(1, encoding)] }))
    const before = store.getState()
    const updates = countUpdates(store)
    fake.emit(ev.progress(11, id(1), progress({ percent: 7 })), ev.progress(12, id(1), progress({ percent: 8 })))
    expect(updates()).toBe(0)
    expect(store.getState()).toBe(before)
    fake.emit(ev.progress(12, id(1), progress({ percent: 8 })), ev.progress(13, id(1), progress({ percent: 9 })))
    expect(updates()).toBe(1)
    expect(store.getState().seq).toBe(13)
    expect(store.getState().jobs[id(1)].progress?.percent).toBe(9)
    dispose()
  })

  it('applies each batch with one store update', async () =>
  {
    const { store, fake, dispose } = started()
    await fake.reply(0, snapshot({ seq: 20, jobs: [job(1, encoding), job(2, encoding), job(3)] }))
    const updates = countUpdates(store)
    fake.emit(
      ev.progress(21, id(1), progress({ percent: 30 })),
      ev.progress(22, id(2), progress({ percent: 60 })),
      ev.runProgress(23, 45),
      ev.updated(24, id(3), 2, { probe: 'ok' }),
      ev.added(25, job(4))
    )
    expect(updates()).toBe(1)
    const state = store.getState()
    expect(state.seq).toBe(25)
    expect(state.run?.progress.percent).toBe(45)
    expect(state.jobs[id(3)].probe).toBe('ok')
    expect(state.order).toEqual([id(1), id(2), id(3), id(4)])
    fake.emit(ev.progress(26, id(1), progress({ percent: 31 })))
    expect(updates()).toBe(2)
    dispose()
  })

  it('resyncs from a new snapshot on a gap and keeps the last consistent state visible meanwhile', async () =>
  {
    const { store, fake, dispose } = started()
    await fake.reply(0, snapshot({ seq: 12, jobs: [job(1, encoding), job(2, encoding)] }))
    const updates = countUpdates(store)
    fake.emit(
      ev.progress(13, id(1), progress({ percent: 20 })),
      ev.progress(15, id(2), progress({ percent: 30 })),
      ev.progress(16, id(1), progress({ percent: 25 }))
    )
    expect(updates()).toBe(1)
    const resyncing = store.getState()
    expect(resyncing.status).toBe('resyncing')
    expect(resyncing.seq).toBe(13)
    expect(resyncing.jobs[id(1)].progress?.percent).toBe(20)
    expect(resyncing.jobs[id(2)].progress).toBeNull()
    expect(resyncing.order).toEqual([id(1), id(2)])
    expect(fake.api.subscribe).toHaveBeenLastCalledWith({ clientId: 'client-2' })
    fake.emit(ev.progress(17, id(2), progress({ percent: 35 })))
    expect(updates()).toBe(1)
    await fake.reply(1, snapshot({
      seq: 16,
      jobs: [job(1, { ...encoding, progress: progress({ percent: 25 }) }), job(2, { ...encoding, progress: progress({ percent: 30 }) })]
    }))
    const state = store.getState()
    expect(updates()).toBe(2)
    expect(state.status).toBe('hydrated')
    expect(state.hydrations).toBe(2)
    expect(state.seq).toBe(17)
    expect(state.jobs[id(1)].progress?.percent).toBe(25)
    expect(state.jobs[id(2)].progress?.percent).toBe(35)
    dispose()
  })

  it('resyncs when the first buffered event after the snapshot leaves a gap', async () =>
  {
    const { store, fake, dispose } = started()
    fake.emit(ev.added(12, job(2)))
    await fake.reply(0, snapshot({ seq: 10, jobs: [job(1)] }))
    expect(store.getState().status).toBe('resyncing')
    expect(store.getState().order).toEqual([id(1)])
    expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
    await fake.reply(1, snapshot({ seq: 12, jobs: [job(1), job(2)] }))
    expect(store.getState().status).toBe('hydrated')
    expect(store.getState().order).toEqual([id(1), id(2)])
    dispose()
  })

  it('backs off when gaps repeat and resubscribes at once again after a clean batch', async () =>
  {
    const { store, fake, timers, dispose } = started()
    fake.emit(ev.added(12, job(2)))
    await fake.reply(0, snapshot({ seq: 10, jobs: [job(1)] }))
    expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
    fake.emit(ev.added(15, job(3)))
    await fake.reply(1, snapshot({ seq: 13, jobs: [job(1), job(2)] }))
    expect(store.getState().status).toBe('resyncing')
    expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
    expect(timers.tasks.map((task) => task.ms)).toEqual([retryDelayMs(1)])
    timers.tasks[0].fn()
    expect(fake.api.subscribe).toHaveBeenCalledTimes(3)
    await fake.reply(2, snapshot({ seq: 15, jobs: [job(1), job(2), job(3)] }))
    expect(store.getState().status).toBe('hydrated')
    fake.emit(ev.progress(16, id(1), progress()))
    fake.emit(ev.progress(18, id(1), progress()))
    expect(store.getState().status).toBe('resyncing')
    expect(fake.api.subscribe).toHaveBeenCalledTimes(4)
    expect(timers.tasks).toHaveLength(1)
    dispose()
  })

  it('retries a refused or failed subscribe with backoff and clears the error once hydrated', async () =>
  {
    const { store, fake, timers, dispose } = started()
    await fake.refuse(0, 'The engine is starting.')
    expect(store.getState()).toMatchObject({ status: 'error', error: 'The engine is starting.' })
    expect(timers.tasks.map((task) => task.ms)).toEqual([500])
    timers.tasks[0].fn()
    expect(store.getState().status).toBe('connecting')
    expect(fake.api.subscribe).toHaveBeenLastCalledWith({ clientId: 'client-2' })
    await fake.fail(1, new Error('The window lost its connection.'))
    expect(store.getState()).toMatchObject({ status: 'error', error: 'The window lost its connection.' })
    expect(timers.tasks.map((task) => task.ms)).toEqual([500, 1000])
    timers.tasks[1].fn()
    await fake.reply(2, snapshot({ seq: 4, jobs: [job(1)] }))
    expect(store.getState()).toMatchObject({ status: 'hydrated', error: null, hydrations: 1 })
    dispose()
  })

  it('keeps the rows while a resync fails and resyncs again on the retry', async () =>
  {
    const { store, fake, timers, dispose } = started()
    await fake.reply(0, snapshot({ seq: 3, jobs: [job(1)] }))
    fake.emit(ev.added(5, job(2)))
    await fake.fail(1, 'closed')
    expect(store.getState()).toMatchObject({ status: 'error', error: 'closed', hydrations: 1 })
    expect(store.getState().order).toEqual([id(1)])
    timers.tasks[0].fn()
    expect(store.getState().status).toBe('resyncing')
    await fake.reply(2, snapshot({ seq: 5, jobs: [job(1), job(2)] }))
    expect(store.getState()).toMatchObject({ status: 'hydrated', hydrations: 2 })
    dispose()
  })

  it('treats a subscribe that throws as a failed attempt', () =>
  {
    const throwing = fakeApi()
    throwing.api.subscribe.mockImplementation(() =>
    {
      throw new Error('No handler registered for jobs:subscribe')
    })
    const { store, timers, dispose } = started({ api: throwing.api })
    expect(store.getState()).toMatchObject({ status: 'error', error: 'No handler registered for jobs:subscribe' })
    expect(timers.tasks).toHaveLength(1)
    dispose()
    expect(timers.tasks[0].canceled).toBe(true)
  })

  it('ignores a reply that arrives after dispose and unsubscribes the client id it used', async () =>
  {
    const { store, fake, dispose } = started()
    dispose()
    expect(fake.listeners.size).toBe(0)
    expect(fake.api.unsubscribe).toHaveBeenCalledWith({ clientId: 'client-1' })
    expect(store.getState().status).toBe('idle')
    await fake.reply(0, snapshot({ seq: 5, jobs: [job(1)] }))
    expect(store.getState().hydrations).toBe(0)
    expect(store.getState().order).toEqual([])
    dispose()
    expect(fake.api.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('ignores a failure that arrives after dispose', async () =>
  {
    const { store, fake, timers, dispose } = started()
    dispose()
    await fake.fail(0, new Error('closed'))
    expect(store.getState().status).toBe('idle')
    expect(timers.tasks).toHaveLength(0)
  })

  it('cancels a scheduled retry on dispose and swallows a failed unsubscribe', async () =>
  {
    const { fake, timers, dispose } = started()
    fake.api.unsubscribe.mockImplementation(async () =>
    {
      throw new Error('closed')
    })
    await fake.refuse(0, 'busy')
    dispose()
    await flush()
    expect(timers.tasks[0].canceled).toBe(true)
  })

  it('ignores batches without an events list', async () =>
  {
    const { store, fake, dispose } = started()
    await fake.reply(0, snapshot({ seq: 2, jobs: [job(1)] }))
    const before = store.getState()
    fake.raw(undefined)
    fake.raw({})
    fake.raw({ events: 'none' })
    expect(store.getState()).toBe(before)
    dispose()
  })

  it('keeps only the newest buffered events while a snapshot is on its way', async () =>
  {
    const { store, fake, dispose } = started()
    const events: JobEvent[] = []
    for (let seq = 1; seq <= MAX_BUFFERED_EVENTS + 5; seq += 1)
    {
      events.push(ev.runProgress(seq, seq % 100))
    }
    fake.emit(...events.slice(0, 10))
    fake.emit(...events.slice(10))
    await fake.reply(0, snapshot({ seq: 0 }))
    expect(store.getState().status).toBe('resyncing')
    await fake.reply(1, snapshot({ seq: 5 }))
    expect(store.getState().status).toBe('hydrated')
    expect(store.getState().seq).toBe(MAX_BUFFERED_EVENTS + 5)
    dispose()
  })

  it('falls back to the window store, timers, and client ids', async () =>
  {
    vi.useFakeTimers()
    try
    {
      const fake = fakeApi()
      const dispose = startJobsSync({ api: fake.api })
      expect(useJobsStore.getState().status).toBe('connecting')
      expect(fake.replies[0].clientId).toMatch(/^window-\d+-[a-z0-9]*$/)
      await fake.refuse(0, 'The engine is starting.')
      vi.advanceTimersByTime(retryDelayMs(1) - 1)
      expect(fake.api.subscribe).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
      expect(fake.replies[1].clientId).not.toBe(fake.replies[0].clientId)
      await fake.refuse(1, 'Still starting.')
      dispose()
      vi.advanceTimersByTime(60_000)
      expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('doubles the retry wait from half a second up to 15 seconds', () =>
  {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([500, 500, 1000, 2000, 4000, 8000, 15_000, 15_000])
  })
})

describe('whenApplied and clearFocusRequest', () =>
{
  it('resolves once the store has applied the seq a command reply names', async () =>
  {
    const store = createJobsStore()
    let resolved = false
    const pending = whenApplied(3, store).then(() =>
    {
      resolved = true
    })
    store.setState({ seq: 2 })
    await flush()
    expect(resolved).toBe(false)
    store.setState({ seq: 4 })
    await pending
    expect(resolved).toBe(true)
    await expect(whenApplied(4, store)).resolves.toBeUndefined()
    await expect(whenApplied(0)).resolves.toBeUndefined()
  })

  it('clears only the focus request it names', () =>
  {
    const store = createJobsStore()
    store.setState({ focus: { jobId: id(1), runId: null, seq: 7 } })
    clearFocusRequest(6, store)
    expect(store.getState().focus?.seq).toBe(7)
    clearFocusRequest(7, store)
    expect(store.getState().focus).toBeNull()
    useJobsStore.setState({ focus: { jobId: null, runId: R31, seq: 9 } })
    clearFocusRequest(9)
    expect(useJobsStore.getState().focus).toBeNull()
  })
})

describe('jobsSelectors', () =>
{
  const jobs = [
    job(1, { probe: 'pending' }),
    job(2, { probe: 'ok', media: { durationSec: 120 } as JobView['media'], plan: { status: 'ready', current: true, warnings: 2 } as JobView['plan'] }),
    job(3, { probe: 'failed', media: { durationSec: null } as JobView['media'], plan: { status: 'blocked', current: true, warnings: 0 } as JobView['plan'] }),
    job(4, { probe: 'ok', media: { durationSec: 30 } as JobView['media'], plan: { status: 'will-skip', current: false, warnings: 1 } as JobView['plan'] }),
    job(5, { state: 'queued', runId: R31 }),
    job(6, { ...encoding, progress: progress({ percent: 40 }) }),
    job(7, { state: 'held', runId: R31 }),
    job(8, { state: 'done', runId: R31, warnings: [{ code: 'ran-on-cpu', short: 'Ran on CPU', message: 'x' }], endedAt: AT + 5 }),
    job(9, { state: 'failed', runId: R31, acknowledged: true, endedAt: AT + 9 }),
    job(10, { state: 'done', runId: R30, endedAt: AT + 9 }),
    job(11, { state: 'canceled', runId: R30, endedAt: AT + 1 }),
    job(12, { probe: 'ok', media: { durationSec: 10 } as JobView['media'], plan: { status: 'ready', current: true, warnings: 0 } as JobView['plan'] })
  ]
  const order = [id(6), id(5), id(1), id(2), id(3), id(4), id(7), id(8), id(9), id(10), id(11), id(12)]
  const base = hydrated(snapshot({ seq: 30, jobs, order, run: runState({ status: 'running', runId: R31, progress: { ...runState().progress, percent: 46 } }) }))

  it('returns the stored fields', () =>
  {
    expect(selectSyncStatus(base)).toBe('hydrated')
    expect(selectHydrated(base)).toBe(true)
    expect(selectHydrated(initialJobsState())).toBe(false)
    expect(selectRun(base)).toBe(base.run)
    expect(selectWorkers(base)).toBe(base.run?.workers)
    expect(selectPolicy(base)).toBe(POLICY)
    expect(selectSettings(base)).toBe(SETTINGS)
    expect(selectDefaultRecipe(base)).toBe(base.defaultRecipe)
    expect(selectCapabilities(base)).toBe(CAPABILITIES)
    expect(selectAlerts(base)).toBe(base.alerts)
    expect(selectScans(base)).toBe(base.scans)
    expect(selectPresets(base)).toBe(base.presets)
    expect(selectRecentFolders(base)).toBe(base.recentFolders)
    expect(selectCompleted(base)).toBeNull()
    expect(selectPreflight(base)).toBeNull()
    expect(selectFocusRequest(base)).toBeNull()
    expect(selectOrder(base)).toBe(base.order)
    expect(selectJobCount(base)).toBe(12)
  })

  it('reads the run with defaults before the first snapshot', () =>
  {
    const empty = initialJobsState()
    expect(selectRunStatus(base)).toBe('running')
    expect(selectRunStatus(empty)).toBe('idle')
    expect(selectRunId(base)).toBe(R31)
    expect(selectRunId(empty)).toBeNull()
    expect(selectWorkers(empty)).toBeNull()
    expect(selectRunPercent(base)).toBe(46)
    expect(selectRunPercent(empty)).toBeNull()
    expect(selectRunPercent({ ...base, run: runState({ progress: { ...runState().progress, percent: 100 } }) })).toBeNull()
  })

  it('tells when the queue is full', () =>
  {
    expect(selectQueueFull(base)).toBe(false)
    expect(selectQueueFull({ ...base, limits: { maxJobs: 12 } })).toBe(true)
    expect(selectQueueFull(initialJobsState())).toBe(false)
  })

  it('selects one row and its parts, and null for a job that is gone', () =>
  {
    const measured = reduceEvents(base, [ev.measured(31, id(6), 1), ev.verified(32, id(6), 1)])
    expect(selectJob(id(6))(measured)).toBe(measured.jobs[id(6)])
    expect(selectJobState(id(6))(measured)).toBe('encoding')
    expect(selectJobStage(id(6))(measured)).toBe(measured.jobs[id(6)].stage)
    expect(selectJobProgress(id(6))(measured)?.percent).toBe(40)
    expect(selectJobMeasurement(id(6))(measured)).toBe(MEASUREMENT)
    expect(selectJobVerification(id(6))(measured)).toBe(VERIFICATION)
    expect(selectJob(id(99))(measured)).toBeNull()
    expect(selectJobState(id(99))(measured)).toBeNull()
    expect(selectJobStage(id(99))(measured)).toBeNull()
    expect(selectJobProgress(id(99))(measured)).toBeNull()
    expect(selectJobMeasurement(id(5))(measured)).toBeNull()
    expect(selectJobVerification(id(5))(measured)).toBeNull()
  })

  it('tells which rows need attention with the shared rule', () =>
  {
    expect(selectJobNeedsAttention(id(7))(base)).toBe(true)
    expect(selectJobNeedsAttention(id(8))(base)).toBe(true)
    expect(selectJobNeedsAttention(id(9))(base)).toBe(false)
    expect(selectJobNeedsAttention(id(10))(base)).toBe(false)
    expect(selectJobNeedsAttention(id(99))(base)).toBe(false)
  })

  it('lists jobs in queue order and the active ones, memoized until the jobs change', () =>
  {
    const ordered = selectOrderedJobs(base)
    expect(ordered.map((view) => view.id)).toEqual(order)
    expect(selectOrderedJobs(base)).toBe(ordered)
    expect(selectActiveJobs(base).map((view) => view.id)).toEqual([id(6)])
    const next = reduceEvents(base, [ev.progress(31, id(6), progress({ percent: 41 }))])
    expect(selectOrderedJobs(next)).not.toBe(ordered)
    expect(selectOrderedJobs(next)[0].progress?.percent).toBe(41)
  })

  it('counts jobs per state and per state group', () =>
  {
    const stateCounts = selectStateCounts(base)
    expect(stateCounts).toEqual(counts({ pending: 5, queued: 1, encoding: 1, held: 1, done: 2, failed: 1, canceled: 1 }))
    expect(selectStateCounts(base)).toBe(stateCounts)
    expect(selectGroupCounts(base)).toEqual({ waiting: 6, active: 1, decision: 1, terminal: 4 })
    expect(selectGroupCounts(base)).toBe(selectGroupCounts(base))
  })

  it('sums the pending jobs for the header', () =>
  {
    const summary = selectPendingSummary(base)
    expect(summary).toEqual({
      jobs: 5,
      bytes: (1 + 2 + 3 + 4 + 12) * 1_000_000,
      mediaSec: 160,
      unknownDuration: 2,
      probing: 1,
      unreadable: 1,
      blocked: 1,
      withWarnings: 1,
      willSkip: 1,
      planning: 2
    })
    expect(selectPendingSummary(base)).toBe(summary)
  })

  it('counts one run\'s jobs and its attention with attentionCount', () =>
  {
    const run = selectRunJobs(R31)(base)
    expect(run).toMatchObject({ runId: R31, total: 5, settled: 3, attention: 2 })
    expect(run.counts).toEqual(counts({ queued: 1, held: 1, done: 1, failed: 1, encoding: 1 }))
    expect(selectRunJobs(R31)).toBe(selectRunJobs(R31))
    expect(selectRunJobs(R31)(base)).toBe(run)
    expect(selectRunJobs(R30)(base)).toMatchObject({ total: 2, settled: 2, attention: 0 })
  })

  it('counts and lists the jobs that need attention per run and across the queue', () =>
  {
    expect(selectAttentionCount(R31)(base)).toBe(2)
    expect(selectAttentionCount(null)(base)).toBe(attentionCount(Object.values(base.jobs), null))
    expect(selectAttentionCount(R30)(base)).toBe(0)
    expect(selectAttentionIds(R31)(base)).toEqual([id(7), id(8)])
    expect(selectAttentionIds(null)(base)).toEqual([id(7), id(8)])
    expect(selectAttentionIds(null)(base)).toBe(selectAttentionIds(null)(base))
    const acknowledged = reduceEvents(base, [ev.updated(31, id(8), 2, { acknowledged: true })])
    expect(selectAttentionCount(R31)(acknowledged)).toBe(1)
    expect(selectAttentionIds(R31)(acknowledged)).toEqual([id(7)])
  })

  it('lists the latest ended jobs, newest first, with ties by catalog number', () =>
  {
    expect(selectRecentSettled(6)(base).map((view) => view.id)).toEqual([id(10), id(9), id(8), id(11)])
    expect(selectRecentSettled(2)(base).map((view) => view.id)).toEqual([id(10), id(9)])
  })

  it('picks the same latest ended jobs as a full sort, whatever the queue order', () =>
  {
    const ended = Array.from({ length: 40 }, (_, index) => job(index + 1, { state: 'done', endedAt: AT + ((index * 7) % 13) }))
    const state = hydrated(snapshot({ jobs: ended }))
    const newest = [...ended].sort((a, b) => (b.endedAt as number) - (a.endedAt as number) || b.seq - a.seq)
    expect(selectRecentSettled(5)(state).map((view) => view.id)).toEqual(newest.slice(0, 5).map((view) => view.id))
    expect(selectRecentSettled(0)(state)).toEqual([])
  })

  it('keeps each derived result while a batch leaves it equal and replaces it once it changes', () =>
  {
    const read = (state: JobsState) => ({
      active: selectActiveJobs(state),
      states: selectStateCounts(state),
      groups: selectGroupCounts(state),
      pending: selectPendingSummary(state),
      run: selectRunJobs(R31)(state),
      attention: selectAttentionIds(R31)(state),
      everywhere: selectAttentionIds(null)(state),
      recent: selectRecentSettled(2)(state)
    })
    const before = read(base)
    const ticked = reduceEvents(base, [ev.progress(31, id(6), progress({ percent: 41 }))])
    const afterTick = read(ticked)
    expect(ticked.jobs).not.toBe(base.jobs)
    for (const key of ['states', 'groups', 'pending', 'run', 'attention', 'everywhere', 'recent'] as const)
    {
      expect(afterTick[key]).toBe(before[key])
    }
    expect(afterTick.active).toEqual([ticked.jobs[id(6)]])
    expect(afterTick.active).not.toBe(before.active)

    const relabeled = reduceEvents(ticked, [ev.updated(32, id(12), 2, { recipeLabel: 'AAC 256k' })])
    expect(read(relabeled).active).toBe(afterTick.active)
    expect(read(relabeled).pending).toBe(before.pending)

    const verifying = reduceEvents(relabeled, [ev.state(33, id(6), 3, 'encoding', 'verifying', 1)])
    const afterVerify = read(verifying)
    expect(afterVerify.states).not.toBe(before.states)
    expect(afterVerify.groups).toBe(before.groups)
    expect(afterVerify.run).not.toBe(before.run)
    expect(afterVerify.run).toMatchObject({ total: 5, settled: 3, attention: 2 })
    expect(afterVerify.run.counts).toMatchObject({ encoding: 0, verifying: 1 })
    expect(afterVerify.attention).toBe(before.attention)

    const held = reduceEvents(verifying, [ev.updated(34, id(8), 2, { acknowledged: true }), ev.state(35, id(5), 2, 'queued', 'held', 1)])
    const afterHold = read(held)
    expect(afterHold.attention).toEqual([id(5), id(7)])
    expect(afterHold.run).toMatchObject({ total: 5, settled: 4, attention: 2 })
    expect(afterHold.groups).toEqual({ waiting: 5, active: 1, decision: 2, terminal: 4 })

    const finished = reduceEvents(held, [ev.state(36, id(12), 2, 'pending', 'done', 1, { endedAt: AT + 20 })])
    const afterDone = read(finished)
    expect(afterDone.recent.map((view) => view.id)).toEqual([id(12), id(10)])
    expect(afterDone.pending.jobs).toBe(before.pending.jobs - 1)
    expect(afterDone.everywhere).toBe(afterHold.everywhere)
    expect(afterDone.run).toBe(afterHold.run)
  })

  it('names the current run, else the latest run a job belongs to', () =>
  {
    expect(selectLatestRunId(base)).toBe(R31)
    const idle = { ...base, run: runState() }
    expect(selectLatestRunId(idle)).toBe(R31)
    const odd = reduceEvents(idle, [ev.added(31, job(13, { runId: 'Batch 40' as RunId })), ev.added(32, job(14, { runId: 'R-0029' as RunId }))])
    expect(selectLatestRunId(odd)).toBe(R31)
    expect(selectLatestRunId(initialJobsState())).toBeNull()
    expect(selectLatestRunId(hydrated(snapshot({ jobs: [job(1)] })))).toBeNull()
  })

  it('caches one selector per argument and starts over past its limit', () =>
  {
    const first = selectRecentSettled(1)
    expect(selectRecentSettled(1)).toBe(first)
    for (let limit = 2; limit <= 80; limit += 1)
    {
      selectRecentSettled(limit)
    }
    expect(selectRecentSettled(1)).not.toBe(first)
  })
})

describe('row subscriptions', () =>
{
  it('re-renders only the subscribers of the job an event changed', async () =>
  {
    const fake = fakeApi()
    const dispose = startJobsSync({ api: fake.api, store: useJobsStore, clientId: () => 'client-1' })
    await act(async () =>
    {
      await fake.reply(0, snapshot({ seq: 5, jobs: [job(1, encoding), job(2, encoding), job(3)] }))
    })
    const renders = new Map<string, number>()
    const count = (key: string): void =>
    {
      renders.set(key, (renders.get(key) ?? 0) + 1)
    }
    function Row(props: { jobId: JobId }): React.ReactElement
    {
      const view = useJobsStore(selectJob(props.jobId))
      count(props.jobId)
      return React.createElement('li', null, `${props.jobId} ${view?.progress?.percent ?? 0}`)
    }
    function StatusCell(props: { jobId: JobId }): React.ReactElement
    {
      const state = useJobsStore(selectJobState(props.jobId))
      count(`status ${props.jobId}`)
      return React.createElement('span', null, `${props.jobId} is ${state}`)
    }
    const MemoRow = React.memo(Row)
    const MemoStatusCell = React.memo(StatusCell)
    function Table(): React.ReactElement
    {
      const ids = useJobsStore(selectOrder)
      count('table')
      return React.createElement('ul', null, ids.map((jobId) => React.createElement(React.Fragment, { key: jobId },
        React.createElement(MemoRow, { jobId }),
        React.createElement(MemoStatusCell, { jobId }))))
    }
    function Panel(props: { name: string; select: (state: JobsState) => unknown }): React.ReactElement
    {
      useJobsStore(props.select)
      count(props.name)
      return React.createElement('p', null, props.name)
    }
    const panels = {
      header: selectRunJobs(R31),
      dashboard: selectGroupCounts,
      waiting: selectPendingSummary,
      states: selectStateCounts,
      attention: selectAttentionIds(null),
      recent: selectRecentSettled(6)
    }
    function Screen(): React.ReactElement
    {
      return React.createElement('main', null,
        Object.entries(panels).map(([name, select]) => React.createElement(Panel, { key: name, name, select })),
        React.createElement(Table))
    }
    const panelRenders = (): Record<string, number | undefined> =>
      Object.fromEntries(Object.keys(panels).map((name) => [name, renders.get(name)]))
    const view = render(React.createElement(Screen))
    act(() =>
    {
      fake.emit(ev.progress(6, id(1), progress({ percent: 42 })))
    })
    expect(view.getByText(`${id(1)} 42`)).toBeInTheDocument()
    expect(renders.get(id(1))).toBe(2)
    expect(renders.get(id(2))).toBe(1)
    expect(renders.get(id(3))).toBe(1)
    expect(renders.get(`status ${id(1)}`)).toBe(1)
    expect(renders.get('table')).toBe(1)
    expect(panelRenders()).toEqual({ header: 1, dashboard: 1, waiting: 1, states: 1, attention: 1, recent: 1 })
    act(() =>
    {
      fake.emit(ev.state(7, id(2), 2, 'encoding', 'verifying', 1))
    })
    expect(view.getByText(`${id(2)} is verifying`)).toBeInTheDocument()
    expect(renders.get(id(2))).toBe(2)
    expect(renders.get(`status ${id(2)}`)).toBe(2)
    expect(renders.get(id(1))).toBe(2)
    expect(renders.get(`status ${id(1)}`)).toBe(1)
    expect(renders.get('table')).toBe(1)
    expect(panelRenders()).toEqual({ header: 2, dashboard: 1, waiting: 1, states: 2, attention: 1, recent: 1 })
    act(() =>
    {
      fake.emit(ev.added(8, job(4)))
    })
    expect(renders.get('table')).toBe(2)
    expect(renders.get(id(4))).toBe(1)
    expect(renders.get(id(1))).toBe(2)
    expect(renders.get(id(2))).toBe(2)
    expect(panelRenders()).toEqual({ header: 2, dashboard: 2, waiting: 2, states: 3, attention: 1, recent: 1 })
    act(() =>
    {
      dispose()
    })
  })
})

describe('useJobs', () =>
{
  it('subscribes once per effect run and ignores the reply of the run React cleaned up', async () =>
  {
    const fake = fakeApi()
    const { unmount } = renderHook(() => useJobs(fake.api), { reactStrictMode: true })
    expect(fake.api.subscribe).toHaveBeenCalledTimes(2)
    const [first, second] = fake.replies
    expect(first.clientId).not.toBe(second.clientId)
    expect(fake.api.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fake.api.unsubscribe).toHaveBeenCalledWith({ clientId: first.clientId })
    expect(fake.listeners.size).toBe(1)
    await act(async () =>
    {
      await fake.reply(0, snapshot({ seq: 3, jobs: [job(1)] }))
    })
    expect(useJobsStore.getState().hydrations).toBe(0)
    await act(async () =>
    {
      await fake.reply(1, snapshot({ seq: 4, jobs: [job(2)] }))
    })
    expect(useJobsStore.getState()).toMatchObject({ status: 'hydrated', hydrations: 1, seq: 4, order: [id(2)] })
    unmount()
    expect(fake.listeners.size).toBe(0)
    expect(fake.api.unsubscribe).toHaveBeenLastCalledWith({ clientId: second.clientId })
    expect(useJobsStore.getState().status).toBe('idle')
  })

  it('uses the preload jobs surface when no api is passed', () =>
  {
    const fake = fakeApi()
    Object.defineProperty(window, 'api', { value: { jobs: fake.api }, configurable: true, writable: true })
    expect(windowJobsApi()).toBe(fake.api)
    const { unmount } = renderHook(() => useJobs())
    expect(fake.api.subscribe).toHaveBeenCalledTimes(1)
    expect(useJobsStore.getState().status).toBe('connecting')
    unmount()
    expect(useJobsStore.getState().status).toBe('idle')
  })

  it('does nothing while the preload exposes no jobs surface', () =>
  {
    expect(windowJobsApi()).toBeNull()
    Object.defineProperty(window, 'api', { value: {}, configurable: true, writable: true })
    expect(windowJobsApi()).toBeNull()
    const { unmount } = renderHook(() => useJobs())
    expect(useJobsStore.getState().status).toBe('idle')
    unmount()
  })

  it('stays unsubscribed when passed null, even while the preload exposes a jobs surface', () =>
  {
    const fake = fakeApi()
    Object.defineProperty(window, 'api', { value: { jobs: fake.api }, configurable: true, writable: true })
    const { unmount } = renderHook(() => useJobs(null))
    expect(fake.api.onEvents).not.toHaveBeenCalled()
    expect(fake.api.subscribe).not.toHaveBeenCalled()
    expect(useJobsStore.getState().status).toBe('idle')
    unmount()
    expect(fake.api.unsubscribe).not.toHaveBeenCalled()
  })
})
