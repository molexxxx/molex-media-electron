/**
 * Guards the development preview's in-memory jobs API: it is a complete JobsApi, it hydrates the jobs store through
 * startJobsSync with gap-free events, it walks jobs through the shared state machine, and nothing outside the dev
 * folder imports it.
 */
import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { JOB_COMMAND_NAMES } from '../../../src/shared/jobs/contract'
import type { CommandResult, JobEvent, JobEventBatch, JobsApi } from '../../../src/shared/jobs/contract'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import { applyDefaultPreset, CONVERT_PRESETS, DEFAULT_PINS, EXTRACT_PRESETS } from '../../../src/shared/jobs/presets'
import type { Recipe } from '../../../src/shared/jobs/recipes'
import { JOB_TRANSITIONS } from '../../../src/shared/jobs/states'
import type { JobState, RunState } from '../../../src/shared/jobs/types'
import { createJobsStore, startJobsSync } from '../../../src/renderer/src/stores/jobs'
import { createPreviewJobsApi, notInPreview, PROBE_MS, TICK_MS } from '../../../src/renderer/src/dev/previewJobs'
import type { PreviewClock } from '../../../src/renderer/src/dev/previewJobs'
import
{
  baseName,
  folderOf,
  folderSamples,
  isFolderPath,
  isSamplePath,
  PREVIEW_SAMPLES,
  sampleFacts,
  sampleSource,
  subdirOf
} from '../../../src/renderer/src/dev/previewMedia'

interface ManualClock extends PreviewClock
{
  advance: (ms: number) => void
  pending: () => number
}

function manualClock(start = Date.UTC(2026, 9, 16, 12)): ManualClock
{
  let now = start
  let id = 0
  let timers: Array<{ at: number; id: number; fn: () => void }> = []
  return {
    now: () => now,
    schedule: (fn, ms) =>
    {
      id += 1
      const timer = { at: now + ms, id, fn }
      timers.push(timer)
      return () =>
      {
        timers = timers.filter((entry) => entry !== timer)
      }
    },
    advance: (ms) =>
    {
      const end = now + ms
      for (;;)
      {
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const next = timers[0]
        if (!next || next.at > end)
        {
          break
        }
        timers.shift()
        now = next.at
        next.fn()
      }
      now = end
    },
    pending: () => timers.length
  }
}

function settled(): Promise<void>
{
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Advances the clock one tick at a time until no timer is left, then lets the events flush. */
async function finish(clock: ManualClock, limitMs = 600_000): Promise<void>
{
  for (let spent = 0; clock.pending() > 0 && spent < limitMs; spent += TICK_MS)
  {
    clock.advance(TICK_MS)
  }
  await settled()
}

function ofType<T extends JobEvent['type']>(events: readonly JobEvent[], type: T): Array<Extract<JobEvent, { type: T }>>
{
  return events.filter((event): event is Extract<JobEvent, { type: T }> => event.type === type)
}

function statesOf(events: readonly JobEvent[], jobId: string): JobState[]
{
  return ofType(events, 'job.state').filter((event) => event.jobId === jobId).map((event) => event.to)
}

const FILM = 'MM-0001' as JobId
const SILENT = 'MM-0010' as JobId
const DAMAGED = 'MM-0011' as JobId
const QUIET = 'MM-0012' as JobId
const PLACED: JobState[] = ['queued', 'analyzing', 'encoding', 'verifying', 'finalizing', 'done']
const PODCAST = 'MM-0002' as JobId
const DRONE = 'MM-0008' as JobId
const CONVERT = applyDefaultPreset('convert', { kind: 'same-as-source' })

function addRequest(paths: string[], extra: Partial<Parameters<JobsApi['add']>[0]> = {}): Parameters<JobsApi['add']>[0]
{
  return { paths, recipe: null, origin: 'files', after: null, recursive: false, allowSecondJobs: false, force: false, ...extra }
}

function lastRun(events: readonly JobEvent[]): RunState
{
  const runs = ofType(events, 'run.state')
  return runs[runs.length - 1].run
}

/** The run statuses the run.state events announced, each change once. */
function statuses(events: readonly JobEvent[]): string[]
{
  return ofType(events, 'run.state').map((event) => event.run.status).filter((status, index, all) => index === 0 || all[index - 1] !== status)
}

async function startAll(api: JobsApi): Promise<string>
{
  const report = value(await api.preflight({ ids: 'pending' }))
  value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
  return report.preflightId
}

function value<T>(result: CommandResult<T>): T
{
  if (!result.ok)
  {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

interface Harness
{
  api: JobsApi
  clock: ManualClock
  events: JobEvent[]
}

async function harness(samples = true): Promise<Harness>
{
  const clock = manualClock()
  const api = createPreviewJobsApi({ clock, samples })
  const events: JobEvent[] = []
  api.onEvents((batch: JobEventBatch) =>
  {
    events.push(...batch.events)
  })
  value(await api.subscribe({ clientId: 'test' }))
  return { api, clock, events }
}

describe('createPreviewJobsApi', () =>
{
  it('is a complete jobs API: one method per command and onEvents', () =>
  {
    const api = createPreviewJobsApi({ clock: manualClock() })
    for (const name of JOB_COMMAND_NAMES)
    {
      expect(typeof api[name]).toBe('function')
    }
    expect(typeof api.onEvents).toBe('function')
  })

  it('answers commands outside the preview with a typed error', async () =>
  {
    const api = createPreviewJobsApi({ clock: manualClock() })
    const result = await api.log({ jobId: 'MM-0001' as JobId, attempt: null })
    expect(result).toEqual(notInPreview('log'))
    expect(result.ok).toBe(false)
    if (!result.ok)
    {
      expect(result.error.code).toBe('invalid-state')
      expect(result.error.message).toBe('jobs:log is not available in the preview.')
    }
  })

  it('starts with the sample set probed in the snapshot', async () =>
  {
    const api = createPreviewJobsApi({ clock: manualClock() })
    const snapshot = value(await api.subscribe({ clientId: 'a' }))
    expect(snapshot.schema).toBe(1)
    expect(snapshot.seq).toBe(0)
    expect(snapshot.jobs.map((job) => job.source.path)).toEqual(PREVIEW_SAMPLES)
    expect(snapshot.order).toEqual(snapshot.jobs.map((job) => job.id))
    expect(snapshot.jobs.every((job) => job.probe === 'ok' && job.media !== null && job.state === 'pending')).toBe(true)
    expect(snapshot.jobs[0].id).toBe('MM-0001')
    expect(snapshot.run.status).toBe('idle')
    expect(snapshot.run.counts.pending).toBe(PREVIEW_SAMPLES.length)
  })

  it('can start empty', async () =>
  {
    const { api } = await harness(false)
    const snapshot = value(await api.subscribe({ clientId: 'b' }))
    expect(snapshot.jobs).toEqual([])
  })

  it('gives files added next the default recipe it is sent and announces it', async () =>
  {
    const { api, events } = await harness(false)
    value(await api.setDefaultRecipe({ recipe: CONVERT }))
    expect(ofType(events, 'defaultRecipe.changed').pop()?.recipe).toEqual(CONVERT)
    value(await api.add(addRequest(['D:/Media/clip.mp4'])))
    expect(ofType(events, 'job.added').pop()?.job.recipe).toEqual(CONVERT)
    const snapshot = value(await api.subscribe({ clientId: 'b' }))
    expect(snapshot.defaultRecipe).toEqual(CONVERT)
  })

  it('hydrates the jobs store through startJobsSync', async () =>
  {
    const clock = manualClock()
    const api = createPreviewJobsApi({ clock })
    const store = createJobsStore()
    const stop = startJobsSync({ api, store, clientId: () => 'sync', schedule: clock.schedule })
    await settled()
    const state = store.getState()
    expect(state.status).toBe('hydrated')
    expect(state.hydrations).toBe(1)
    expect(state.order).toHaveLength(PREVIEW_SAMPLES.length)
    stop()
    expect(store.getState().status).toBe('idle')
  })

  it('runs a whole batch through the shared state machine with gap-free seq, and the store follows without a resync', async () =>
  {
    const clock = manualClock()
    const t0 = clock.now()
    const api = createPreviewJobsApi({ clock })
    const store = createJobsStore()
    const events: JobEvent[] = []
    api.onEvents((batch) =>
    {
      events.push(...batch.events)
    })
    const stop = startJobsSync({ api, store, clientId: () => 'sync', schedule: clock.schedule })
    await settled()
    const report = value(await api.preflight({ ids: 'pending' }))
    expect(report.counts).toMatchObject({ jobs: 12, ready: 11, blocked: 1, renames: 0 })
    expect(report.jobs.find((entry) => entry.jobId === SILENT)).toMatchObject({ status: 'blocked', plan: null })
    const ready = report.jobs.filter((entry) => entry.status === 'ready')
    expect(ready.every((entry) => entry.plan !== null && entry.plan.output.finalPath !== '' && entry.plan.output.resolution === 'place')).toBe(true)
    const started = value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    expect(started).toMatchObject({ runId: 'R-0001', blocked: [SILENT], repeated: false })
    expect(started.queued).toHaveLength(11)
    await finish(clock)

    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    for (const event of ofType(events, 'job.state'))
    {
      expect(JOB_TRANSITIONS.some((row) => row.from.includes(event.from) && row.to === event.to)).toBe(true)
    }
    expect(statesOf(events, FILM)).toEqual(PLACED)
    expect(statesOf(events, SILENT)).toEqual([])
    expect(statesOf(events, DAMAGED)).toEqual(['queued', 'analyzing', 'encoding', 'verifying', 'failed'])
    expect(statesOf(events, QUIET)).toEqual(['queued', 'analyzing', 'encoding', 'verifying', 'held'])
    const progress = ofType(events, 'job.progress')
    expect(progress.length).toBeGreaterThan(50)
    expect(progress.every((event) => (event.at - t0) % TICK_MS === 0)).toBe(true)
    expect(events[events.length - 1].type).toBe('run.completed')
    const summary = ofType(events, 'run.completed')[0].summary
    expect(summary.counts).toMatchObject({ total: 11, done: 9, verified: 9, failed: 1, held: 1, returned: 2 })
    expect(summary.failures).toEqual([expect.objectContaining({ jobId: DAMAGED, code: 'decode-errors' })])

    const state = store.getState()
    expect(state.status).toBe('hydrated')
    expect(state.hydrations).toBe(1)
    expect(state.seq).toBe(events.length)
    expect(state.completed).toEqual(summary)
    expect(state.run?.status).toBe('idle')
    expect(state.jobs[DAMAGED].error?.code).toBe('decode-errors')
    expect(state.jobs[QUIET].hold?.reason).toBe('outside-tolerance')
    const fresh = value(await api.subscribe({ clientId: 'check' }))
    expect(state.order).toEqual(fresh.order)
    expect(fresh.jobs.map((job) => state.jobs[job.id])).toEqual(fresh.jobs)
    stop()
  })

  it('acknowledges a failed job, and keeps or discards a held output', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    await finish(clock)
    const acknowledged = value(await api.acknowledge({ ids: [DAMAGED, PODCAST] }))
    expect(acknowledged.applied).toEqual([DAMAGED])
    expect(ofType(events, 'job.updated').filter((event) => event.jobId === DAMAGED).pop()?.patch).toEqual({ acknowledged: true })
    const kept = value(await api.keepOutput({ ids: [QUIET], placement: 'planned', confirm: null }))
    expect(kept.applied).toEqual([QUIET])
    expect(statesOf(events, QUIET).slice(-3)).toEqual(['held', 'finalizing', 'done'])
    const again = value(await api.discardOutput({ ids: [QUIET] }))
    expect(again.applied).toEqual([])
  })

  it('discards a held output, which ends canceled', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    await finish(clock)
    const discarded = value(await api.discardOutput({ ids: [QUIET] }))
    expect(discarded.applied).toEqual([QUIET])
    expect(statesOf(events, QUIET).slice(-2)).toEqual(['held', 'canceled'])
  })

  it('adds files with about 300 ms of probing each, three at a time, and refuses what it cannot open', async () =>
  {
    const { api, clock, events } = await harness(false)
    const paths = ['E:\\Takes\\Take 1.wav', 'E:\\Takes\\Take 2.ogg', 'E:\\Takes\\Take 3.aiff', 'E:\\Takes\\Take 4.mp4']
    const added = value(await api.add(addRequest([...paths, 'E:\\Takes\\notes.txt'])))
    expect(added.added).toEqual(['MM-0001', 'MM-0002', 'MM-0003', 'MM-0004'])
    expect(added.refused).toEqual([expect.objectContaining({ path: 'E:\\Takes\\notes.txt', code: 'not-media' })])
    await settled()
    expect(ofType(events, 'job.added').map((event) => event.job.probe)).toEqual(['pending', 'pending', 'pending', 'pending'])
    const probed = (): number => ofType(events, 'job.updated').filter((event) => event.patch.probe === 'ok').length
    clock.advance(PROBE_MS - 1)
    await settled()
    expect(probed()).toBe(0)
    clock.advance(1)
    await settled()
    expect(probed()).toBe(3)
    clock.advance(PROBE_MS)
    await settled()
    expect(probed()).toBe(4)
    const media = ofType(events, 'job.updated').filter((event) => event.patch.probe === 'ok').map((event) => event.patch.media)
    expect(media.map((entry) => entry?.audio[0]?.codec)).toEqual(['pcm_s24le', 'vorbis', 'pcm_s16be', 'aac'])
    expect(media[3]?.video?.codec).toBe('h264')

    const again = value(await api.add(addRequest([paths[0]], { origin: 'drop' })))
    expect(again.added).toEqual([])
    expect(again.duplicates).toEqual({ paths: [paths[0]], jobIds: ['MM-0001'] })
    const second = value(await api.add(addRequest([paths[0], paths[1]], { after: 'MM-0001' as JobId, allowSecondJobs: true })))
    expect(second.added).toEqual(['MM-0005', 'MM-0006'])
    const snapshot = value(await api.subscribe({ clientId: 'order' }))
    expect(snapshot.order).toEqual(['MM-0001', 'MM-0005', 'MM-0006', 'MM-0002', 'MM-0003', 'MM-0004'])
  })

  it('scans a folder: its files arrive after one probe interval and the folder joins the recent list', async () =>
  {
    const { api, clock, events } = await harness(false)
    const result = value(await api.add(addRequest(['E:\\Live\\Harbor Session'], { origin: 'folder', recursive: true })))
    expect(result.scanIds).toEqual(['scan-1'])
    expect(result.added).toEqual([])
    await settled()
    expect(ofType(events, 'scan.progress').map((event) => event.scan.status)).toEqual(['scanning'])
    clock.advance(PROBE_MS)
    await settled()
    expect(ofType(events, 'scan.progress')[1].scan).toMatchObject({ scanId: 'scan-1', status: 'done', visited: 4, added: 4 })
    expect(ofType(events, 'job.added').map((event) => event.job.source.name)).toEqual([
      '01 Harbor Session.flac', '02 Harbor Session.flac', '03 Harbor Session.flac', '04 Harbor Session.flac'
    ])
    expect(ofType(events, 'job.added')[0].job.source).toMatchObject({ origin: 'folder', subdir: '' })
    expect(ofType(events, 'folders.changed')[0].recentFolders).toEqual([
      expect.objectContaining({ path: 'E:\\Live\\Harbor Session', name: 'Harbor Session', files: 4 })
    ])

    value(await api.add(addRequest(['D:\\Media'], { origin: 'folder', recursive: true })))
    value(await api.add(addRequest(['E:\\Live\\Harbor Session'], { origin: 'folder', recursive: true })))
    clock.advance(PROBE_MS)
    await settled()
    const scans = ofType(events, 'scan.progress').filter((event) => event.scan.status === 'done').map((event) => event.scan)
    expect(scans[1]).toMatchObject({ visited: PREVIEW_SAMPLES.length, added: PREVIEW_SAMPLES.length })
    expect(scans[2]).toMatchObject({ visited: 4, added: 0, excluded: expect.objectContaining({ duplicates: 4 }) })
    const album = ofType(events, 'job.added').find((event) => event.job.source.name === '01 Departure.flac')
    expect(album?.job.source.subdir).toBe('Music\\Night Ferry')
    const folders = ofType(events, 'folders.changed')
    expect(folders[folders.length - 1].recentFolders.map((folder) => folder.path)).toEqual(['E:\\Live\\Harbor Session', 'D:\\Media'])
  })

  it('removes and reorders waiting jobs as the shared matrix allows', async () =>
  {
    const { api, events } = await harness()
    const removed = value(await api.remove({ ids: [FILM, 'MM-0099' as JobId] }))
    expect(removed).toEqual({ applied: [FILM], refused: [expect.objectContaining({ jobId: 'MM-0099', code: 'not-found' })], tombstone: null })
    const moved = value(await api.reorder({ ids: [QUIET, DAMAGED], before: PODCAST }))
    expect(moved.applied).toEqual([QUIET, DAMAGED])
    const last = value(await api.reorder({ ids: [PODCAST], before: null }))
    expect(last.applied).toEqual([PODCAST])
    const nothing = await api.reorder({ ids: ['MM-0099' as JobId], before: null })
    expect(nothing.ok && nothing.seq).toBe(0)
    await settled()
    expect(ofType(events, 'job.removed').map((event) => event.jobId)).toEqual([FILM])
    const orders = ofType(events, 'queue.order').map((event) => event.order)
    expect(orders).toHaveLength(2)
    expect(orders[0].slice(0, 3)).toEqual([QUIET, DAMAGED, PODCAST])
    expect(orders[1][orders[1].length - 1]).toBe(PODCAST)
  })

  it('assigns a recipe to one job or a selection and remembers it', async () =>
  {
    const { api, events } = await harness()
    const assignments = [{ jobId: FILM, recipe: CONVERT }, { jobId: PODCAST, recipe: CONVERT }, { jobId: 'MM-0099' as JobId, recipe: CONVERT }]
    const result = value(await api.assignRecipe({ assignments }))
    expect(result.applied).toEqual([FILM, PODCAST])
    expect(result.refused.map((entry) => entry.code)).toEqual(['not-found'])
    await settled()
    const updates = ofType(events, 'job.updated')
    expect(updates.map((event) => [event.jobId, event.patch.recipe?.kind, event.patch.inputsRev])).toEqual([[FILM, 'convert', 2], [PODCAST, 'convert', 2]])
    expect(updates[0].patch.recipeLabel).toEqual(expect.any(String))
    expect(ofType(events, 'presets.changed')[0].presets.recent).toEqual([CONVERT])
  })

  it('answers an invalid request with the shared validator issues', async () =>
  {
    const { api } = await harness()
    const result = await api.assignRecipe({ assignments: [{ jobId: FILM, recipe: { kind: 'transcode' } as unknown as Recipe }] })
    expect(result.ok).toBe(false)
    if (!result.ok)
    {
      expect(result.error.code).toBe('invalid-payload')
      expect(result.error.message).toBe('The jobs:assignRecipe request is not valid.')
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  it('pauses after running jobs finish, then resumes and completes', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    clock.advance(TICK_MS)
    const pausing = value(await api.pause({ mode: 'finish-running' }))
    expect(pausing).toMatchObject({ status: 'pausing', pause: { mode: 'finish-running', reason: 'user' } })
    await finish(clock)
    expect(lastRun(events).status).toBe('paused')
    const paused = value(await api.subscribe({ clientId: 'paused' }))
    expect(paused.jobs.filter((job) => job.state === 'done').map((job) => job.id)).toEqual([FILM, PODCAST, 'MM-0003'])
    expect(paused.jobs.filter((job) => job.state === 'queued')).toHaveLength(8)
    expect(paused.run.workers.active.total).toBe(0)
    const twice = await api.pause({ mode: 'finish-running' })
    expect(twice.ok).toBe(false)
    const running = value(await api.resume({ ack: null }))
    expect(running).toMatchObject({ status: 'running', pause: null })
    await finish(clock)
    expect(statuses(events)).toEqual(['running', 'pausing', 'paused', 'running', 'idle'])
    expect(ofType(events, 'run.completed')[0].summary.counts).toMatchObject({ total: 11, done: 9 })
  })

  it('pauses now: running jobs return to the queue once their abort settles', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    clock.advance(TICK_MS * 2)
    value(await api.pause({ mode: 'finish-running' }))
    const now = value(await api.pause({ mode: 'stop-running' }))
    expect(now).toMatchObject({ status: 'pausing', pause: { mode: 'stop-running' } })
    await settled()
    const aborts = ofType(events, 'job.updated').filter((event) => event.patch.abort === 'requeue')
    expect(aborts.map((event) => event.jobId)).toEqual([FILM, PODCAST, 'MM-0003'])
    await finish(clock)
    const requeued = ofType(events, 'job.state').filter((event) => event.reason === 'requeued-pause')
    expect(requeued.map((event) => [event.jobId, event.from, event.to])).toEqual([
      [FILM, 'analyzing', 'queued'], [PODCAST, 'analyzing', 'queued'], ['MM-0003', 'analyzing', 'queued']
    ])
    expect(requeued[0].patch).toMatchObject({ abort: null, stage: null, progress: null, restarts: 1 })
    expect(lastRun(events).status).toBe('paused')
    const later = await api.pause({ mode: 'stop-running' })
    expect(later.ok).toBe(false)
    value(await api.resume({ ack: null }))
    await finish(clock)
    expect(statesOf(events, FILM)).toEqual(['queued', 'analyzing', 'queued', 'analyzing', 'encoding', 'verifying', 'finalizing', 'done'])
    expect(lastRun(events).status).toBe('idle')
  })

  it('pauses at once when nothing is active and refuses run commands that do not apply', async () =>
  {
    const { api, clock, events } = await harness()
    for (const result of [await api.pause({ mode: 'finish-running' }), await api.resume({ ack: null }), await api.cancelRun({})])
    {
      expect(result.ok ? null : result.error.code).toBe('invalid-state')
    }
    const report = value(await api.preflight({ ids: [FILM] }))
    value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    value(await api.pause({ mode: 'stop-running' }))
    clock.advance(TICK_MS)
    await settled()
    expect(lastRun(events).status).toBe('paused')
    const canceled = value(await api.cancelRun({}))
    expect(canceled.canceled).toBe(1)
    await settled()
    expect(statuses(events)).toEqual(['running', 'pausing', 'paused', 'canceling', 'idle'])
    expect(ofType(events, 'run.completed')[0].summary).toMatchObject({ endedBy: 'canceled', counts: expect.objectContaining({ total: 1, canceled: 1 }) })
    expect(clock.pending()).toBe(0)
  })

  it('cancels the run: queued jobs at once, running jobs when their abort settles', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    clock.advance(TICK_MS)
    const result = value(await api.cancelRun({}))
    expect(result.canceled).toBe(11)
    await settled()
    expect(ofType(events, 'job.state').filter((event) => event.to === 'canceled')).toHaveLength(8)
    expect(lastRun(events).status).toBe('canceling')
    await finish(clock)
    const canceled = ofType(events, 'job.state').filter((event) => event.to === 'canceled')
    expect(canceled).toHaveLength(11)
    expect(canceled.every((event) => event.reason === 'run-canceled')).toBe(true)
    const summary = ofType(events, 'run.completed')[0].summary
    expect(summary).toMatchObject({ endedBy: 'canceled', counts: expect.objectContaining({ total: 11, canceled: 11, done: 0 }) })
    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('cancels or skips one job: queued jobs at once, running jobs when their abort settles', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    clock.advance(TICK_MS)
    const canceled = value(await api.cancel({ ids: [FILM, SILENT] }))
    expect(canceled.applied).toEqual([FILM])
    expect(canceled.refused).toEqual([expect.objectContaining({ jobId: SILENT, code: 'not-started' })])
    const skipped = value(await api.skip({ ids: [PODCAST, DAMAGED] }))
    expect(skipped.applied).toEqual([PODCAST, DAMAGED])
    await settled()
    const intents = ofType(events, 'job.updated').filter((event) => event.patch.abort !== undefined)
    expect(intents.map((event) => [event.jobId, event.patch.abort])).toEqual([[FILM, 'cancel'], [PODCAST, 'skip']])
    expect(statesOf(events, DAMAGED)).toEqual(['queued', 'skipped'])
    clock.advance(TICK_MS)
    await settled()
    expect(statesOf(events, FILM)).toEqual(['queued', 'analyzing', 'canceled'])
    expect(statesOf(events, PODCAST)).toEqual(['queued', 'analyzing', 'skipped'])
    await finish(clock)
    expect(ofType(events, 'run.completed')[0].summary.counts).toMatchObject({ total: 11, canceled: 1, skipped: 2, done: 7, held: 1, failed: 0 })
  })

  it('completes a paused run once its waiting jobs are skipped', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    value(await api.pause({ mode: 'stop-running' }))
    await finish(clock)
    const waiting = value(await api.subscribe({ clientId: 'waiting' })).jobs.filter((job) => job.state === 'queued').map((job) => job.id)
    expect(waiting).toHaveLength(11)
    value(await api.skip({ ids: waiting }))
    await settled()
    expect(statuses(events)).toEqual(['running', 'pausing', 'paused', 'idle'])
    expect(ofType(events, 'run.completed')[0].summary).toMatchObject({ endedBy: 'completed', counts: expect.objectContaining({ skipped: 11 }) })
  })

  it('completes a paused run once its waiting jobs are removed, and explains a pause it cannot take', async () =>
  {
    const { api, clock, events } = await harness()
    const report = value(await api.preflight({ ids: [FILM, PODCAST] }))
    value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    value(await api.pause({ mode: 'stop-running' }))
    await finish(clock)
    const again = await api.pause({ mode: 'stop-running' })
    expect(again.ok ? null : again.error.message).toBe('The batch cannot pause now.')
    value(await api.remove({ ids: [FILM, PODCAST] }))
    await settled()
    expect(statuses(events)).toEqual(['running', 'pausing', 'paused', 'idle'])
    expect(ofType(events, 'run.completed')[0].summary.counts.total).toBe(0)
    expect(events[events.length - 1].type).toBe('run.completed')
  })

  it('retries failed jobs into a new run or the open one, and held jobs back to pending', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    await finish(clock)
    const again = value(await api.retry({ ids: 'failed', recipe: null, ack: null, start: true }))
    expect(again).toMatchObject({ applied: [DAMAGED], refused: [], queued: [DAMAGED], pending: [], changed: [], runId: 'R-0002' })
    await finish(clock)
    expect(statesOf(events, DAMAGED).slice(5)).toEqual(['queued', 'analyzing', 'encoding', 'verifying', 'failed'])
    expect(ofType(events, 'run.completed')[1].summary.counts).toMatchObject({ total: 1, failed: 1 })

    const held = value(await api.retry({ ids: [QUIET, FILM], recipe: null, ack: null, start: false }))
    expect(held.pending).toEqual([QUIET])
    expect(held.refused).toEqual([expect.objectContaining({ jobId: FILM, code: 'not-retryable' })])
    await settled()
    const pending = ofType(events, 'job.state').filter((event) => event.jobId === QUIET).pop()
    expect(pending).toMatchObject({ from: 'held', to: 'pending', reason: 'plan-changed', patch: expect.objectContaining({ attempt: 2, hold: null, stamp: null, runId: null }) })

    const edited = value(await api.retry({ ids: [DAMAGED], recipe: CONVERT, ack: null, start: true }))
    expect(edited).toMatchObject({ pending: [DAMAGED], queued: [], runId: null })
    await settled()
    const changed = ofType(events, 'job.state').filter((event) => event.jobId === DAMAGED).pop()
    expect(changed).toMatchObject({ from: 'failed', to: 'pending', reason: 'user', patch: expect.objectContaining({ attempt: 3, inputsRev: 2 }) })
    expect(changed?.patch.recipe?.kind).toBe('convert')

    const report = value(await api.preflight({ ids: [DAMAGED, SILENT] }))
    expect(report.counts).toMatchObject({ ready: 1, blocked: 1 })
    value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    const none = value(await api.retry({ ids: [FILM], recipe: null, ack: null, start: true }))
    expect(none).toMatchObject({ applied: [], queued: [], runId: null })
    value(await api.cancelRun({}))
    const canceling = await api.retry({ ids: 'failed', recipe: null, ack: null, start: true })
    expect(canceling.ok ? null : canceling.error.code).toBe('invalid-state')
    await finish(clock)
  })

  it('retries into the open run when one is running', async () =>
  {
    const { api, clock, events } = await harness()
    const first = value(await api.preflight({ ids: [DAMAGED] }))
    value(await api.start({ preflightId: first.preflightId, ack: null, resume: false }))
    await finish(clock)
    const second = value(await api.preflight({ ids: [FILM] }))
    const run = value(await api.start({ preflightId: second.preflightId, ack: null, resume: false }))
    const joined = value(await api.retry({ ids: 'failed', recipe: null, ack: null, start: true }))
    expect(joined).toMatchObject({ queued: [DAMAGED], runId: run.runId })
    await finish(clock)
    expect(ofType(events, 'run.completed')[1].summary).toMatchObject({ runId: run.runId, counts: expect.objectContaining({ total: 2, done: 1, failed: 1 }) })
  })

  it('clears finished jobs; jobs that need attention stay', async () =>
  {
    const { api, clock, events } = await harness()
    await startAll(api)
    value(await api.skip({ ids: ['MM-0009' as JobId] }))
    await finish(clock)
    expect(value(await api.clear({ scope: { kind: 'done' } }))).toEqual({ removed: 8, kept: 0, tombstone: null })
    expect(value(await api.clear({ scope: { kind: 'finished' } }))).toEqual({ removed: 1, kept: 1, tombstone: null })
    expect(value(await api.clear({ scope: { kind: 'ids', ids: [DAMAGED, SILENT, QUIET] } }))).toEqual({ removed: 0, kept: 1, tombstone: null })
    await settled()
    expect(ofType(events, 'job.removed')).toHaveLength(9)
    const snapshot = value(await api.subscribe({ clientId: 'left' }))
    expect(snapshot.jobs.map((job) => [job.id, job.state])).toEqual([[SILENT, 'pending'], [DAMAGED, 'failed'], [QUIET, 'held']])
  })

  it('lists, opens, and searches the history', async () =>
  {
    const { api, clock } = await harness()
    await startAll(api)
    await finish(clock)
    value(await api.retry({ ids: 'failed', recipe: null, ack: null, start: true }))
    await finish(clock)

    const page = value(await api.listRuns({ before: null, limit: 1 }))
    expect(page.runs.map((run) => run.runId)).toEqual(['R-0002'])
    expect(page.more).toBe(true)
    expect(page.usage).toMatchObject({ runs: 2, logBytes: 0 })
    expect(page.runs[0]).toMatchObject({ endedBy: 'completed', counts: expect.objectContaining({ total: 1, failed: 1 }) })
    const older = value(await api.listRuns({ before: 'R-0002' as RunId, limit: 10 }))
    expect(older).toMatchObject({ runs: [expect.objectContaining({ runId: 'R-0001' })], more: false })
    expect(value(await api.listRuns({ before: 'R-0099' as RunId, limit: 10 })).runs).toEqual([])

    const run = value(await api.getRun({ runId: 'R-0001' as RunId, offset: 9, limit: 5 }))
    expect(run.total).toBe(11)
    expect(run.records.map((record) => record.state).sort()).toEqual(['failed', 'held'])
    const failed = run.records.find((record) => record.jobId === DAMAGED)
    expect(failed).toMatchObject({ attempt: 1, output: null, error: expect.objectContaining({ code: 'decode-errors', exitCode: 0 }) })
    expect(run.summary?.recipes).toHaveLength(1)
    expect(run.summary?.recipes[0]).toMatchObject({ op: 'normalize', jobs: 11, verified: 9, returned: 2 })
    expect(run.summary?.recipes[0].loudness?.checks.reduce((sum, check) => sum + check.jobs, 0)).toBe(10)
    const missing = await api.getRun({ runId: 'R-0099' as RunId, offset: 0, limit: 5 })
    expect(missing.ok ? null : missing.error).toMatchObject({ code: 'not-found', message: 'Batch 99 is not in the history.' })

    const found = value(await api.searchRuns({ query: 'field notes 141', limit: 1, before: null }))
    expect(found.matches).toEqual([expect.objectContaining({ runId: 'R-0002', jobId: DAMAGED, attempt: 2, state: 'failed', verdict: null, stamp: null })])
    expect(found).toMatchObject({ runs: 2, more: true })
    const next = value(await api.searchRuns({ query: 'field notes 141', limit: 5, before: { runId: 'R-0002' as RunId, jobId: DAMAGED } }))
    expect(next.matches.map((match) => match.runId)).toEqual(['R-0001'])
    expect(next.more).toBe(false)
    const film = value(await api.searchRuns({ query: 'HARBOR', limit: 5, before: null }))
    expect(film.matches[0]).toMatchObject({ jobId: FILM, sourceName: 'Harbor Lights (2019).mkv', state: 'done', verdict: 'verified' })
    expect(film.matches[0].stamp?.outputName).toBe('Harbor Lights (2019)-normalize.mkv')
    const blank = await api.searchRuns({ query: ' ', limit: 5, before: null })
    expect(blank.ok ? null : blank.error.issues).toEqual([expect.objectContaining({ path: 'query' })])
  })

  it('saves, renames, and removes user presets, and pins presets to keys', async () =>
  {
    const { api, events } = await harness()
    const saved = value(await api.savePreset({ id: null, name: 'Archive copy', recipe: CONVERT, pin: 9 }))
    expect(saved.preset).toMatchObject({ id: 'user-1', name: 'Archive copy' })
    expect(saved.unpinned).toBe(DEFAULT_PINS['9'] ?? null)
    const clash = await api.savePreset({ id: null, name: 'archive COPY', recipe: CONVERT, pin: null })
    expect(clash.ok ? null : clash.error).toMatchObject({ code: 'invalid-payload', issues: [expect.objectContaining({ path: 'name' })] })
    const unknown = await api.savePreset({ id: 'user-7', name: 'Lost', recipe: CONVERT, pin: null })
    expect(unknown.ok ? null : unknown.error.code).toBe('not-found')
    const recipe = { ...CONVERT, userPreset: { id: 'user-1', name: 'Archive copy' } }
    const updated = value(await api.savePreset({ id: 'user-1', name: 'Archive copy', recipe, pin: null }))
    expect(updated).toMatchObject({ preset: { id: 'user-1', recipe }, unpinned: null })
    value(await api.assignRecipe({ assignments: [{ jobId: FILM, recipe }] }))
    const second = value(await api.savePreset({ id: null, name: 'Second', recipe: CONVERT, pin: null }))
    expect(second.preset.id).toBe('user-2')

    const renamed = value(await api.renamePreset({ id: 'user-1', name: 'Archive master' }))
    expect(renamed).toMatchObject({ id: 'user-1', name: 'Archive master' })
    const taken = await api.renamePreset({ id: 'user-2', name: 'Archive Master' })
    expect(taken.ok ? null : taken.error.code).toBe('invalid-payload')
    const gone = await api.renamePreset({ id: 'user-9', name: 'Other' })
    expect(gone.ok ? null : gone.error.code).toBe('not-found')

    expect(value(await api.setPin({ key: 2, presetId: 'user-1' }))).toEqual({ unpinned: DEFAULT_PINS['2'] ?? null })
    expect(value(await api.setPin({ key: 2, presetId: 'user-1' }))).toEqual({ unpinned: null })
    const nowhere = await api.setPin({ key: 3, presetId: 'user-9' })
    expect(nowhere.ok ? null : nowhere.error.code).toBe('not-found')
    expect(value(await api.setPin({ key: 4, presetId: null }))).toEqual({ unpinned: DEFAULT_PINS['4'] ?? null })

    await settled()
    const before = ofType(events, 'job.updated').filter((event) => event.jobId === FILM).length
    expect(value(await api.removePreset({ id: 'user-1' }))).toBeNull()
    const missing = await api.removePreset({ id: 'user-1' })
    expect(missing.ok ? null : missing.error.code).toBe('not-found')
    await settled()
    const presets = ofType(events, 'presets.changed').pop()?.presets
    expect(presets?.user.map((preset) => preset.id)).toEqual(['user-2'])
    expect(Object.values(presets?.pins ?? {})).not.toContain('user-1')
    expect(presets?.pins['4']).toBeUndefined()
    const relabeled = ofType(events, 'job.updated').filter((event) => event.jobId === FILM).slice(before)
    expect(relabeled).toHaveLength(1)
    expect(relabeled[0].patch.recipeLabel).toEqual(expect.any(String))
  })

  it('runs a two-pass size target with a stage event per pass and reports the size outcome', async () =>
  {
    const { api, clock, events } = await harness()
    const base = applyDefaultPreset('compress', { kind: 'same-as-source' })
    const recipe = { ...base, target: { mode: 'size', targetBytes: 50_000_000, twoPass: true } } as Recipe
    value(await api.assignRecipe({ assignments: [{ jobId: DRONE, recipe }] }))
    const report = value(await api.preflight({ ids: [DRONE] }))
    expect(report.jobs[0]).toMatchObject({ jobId: DRONE, status: 'ready' })
    expect(report.volumes).toEqual([expect.objectContaining({ volume: 'D:', estimatedBytes: 48_500_000, status: 'ok' })])
    value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    await finish(clock)
    const stages = ofType(events, 'job.stage').filter((event) => event.jobId === DRONE)
    expect(stages.map((event) => [event.stage.id, event.stage.pass, event.stage.passes])).toEqual([['encode', 2, 2]])
    const plan = ofType(events, 'job.updated').find((event) => event.jobId === DRONE && event.patch.plan)?.patch.plan
    expect(plan?.encoderLabel).toMatch(/2-pass$/)
    const summary = ofType(events, 'run.completed')[0].summary
    expect(summary.recipes[0]).toMatchObject({ op: 'compress', size: { targetBytes: 50_000_000, jobs: 1, within: 1 }, loudness: null })
    expect(summary.bytes.output).toBe(48_500_000)
  })

  it('numbers outputs that collide within a review', async () =>
  {
    const { api, events } = await harness()
    const copies = value(await api.add(addRequest([PREVIEW_SAMPLES[1], PREVIEW_SAMPLES[1]], { allowSecondJobs: true })))
    expect(copies.added).toEqual(['MM-0013', 'MM-0014'])
    const report = value(await api.preflight({ ids: [PODCAST, ...copies.added] }))
    expect(report.counts).toMatchObject({ jobs: 3, ready: 3, renames: 2, warnings: 2 })
    expect(report.collisions).toEqual([{ finalPath: 'D:\\Media\\Podcasts\\Field Notes 142-normalize.mp3', jobIds: [PODCAST, ...copies.added], resolution: 'renamed' }])
    expect(report.warnings.map((issue) => issue.code)).toEqual(['intra-batch-collision', 'intra-batch-collision'])
    await settled()
    const plans = ofType(events, 'job.updated').flatMap((event) => event.patch.plan ? [event.patch.plan] : [])
    expect(plans.map((plan) => [plan.finalName, plan.resolution])).toEqual([
      ['Field Notes 142-normalize.mp3', 'place'],
      ['Field Notes 142-normalize (2).mp3', 'rename'],
      ['Field Notes 142-normalize (3).mp3', 'rename']
    ])
    expect(plans[2].firstIssue).toMatchObject({ code: 'intra-batch-collision', severity: 'warning' })
  })

  it('refuses a start it cannot honor, repeats one it already did, and appends to an open run', async () =>
  {
    const { api, clock } = await harness()
    const unknown = await api.start({ preflightId: 'preflight-9', ack: null, resume: false })
    expect(unknown.ok ? null : unknown.error.code).toBe('not-found')
    const blocked = value(await api.preflight({ ids: [SILENT] }))
    expect(blocked.blocking.map((issue) => issue.severity)).toEqual(['error'])
    const nothing = await api.start({ preflightId: blocked.preflightId, ack: null, resume: false })
    expect(nothing.ok ? null : nothing.error.code).toBe('invalid-state')
    const stale = value(await api.preflight({ ids: [FILM, PODCAST] }))
    value(await api.assignRecipe({ assignments: [{ jobId: FILM, recipe: CONVERT }] }))
    const refused = await api.start({ preflightId: stale.preflightId, ack: null, resume: false })
    expect(refused.ok ? null : refused.error).toMatchObject({ code: 'plan-stale', details: { changed: [FILM] } })

    const fresh = value(await api.preflight({ ids: [FILM] }))
    const first = value(await api.start({ preflightId: fresh.preflightId, ack: null, resume: false }))
    const repeat = value(await api.start({ preflightId: fresh.preflightId, ack: null, resume: false }))
    expect(repeat).toEqual({ ...first, repeated: true })
    const more = value(await api.preflight({ ids: [PODCAST] }))
    const appended = value(await api.start({ preflightId: more.preflightId, ack: null, resume: false }))
    expect(appended).toMatchObject({ runId: first.runId, queued: [PODCAST] })
    value(await api.cancelRun({}))
    const late = value(await api.preflight({ ids: ['MM-0003' as JobId] }))
    const canceling = await api.start({ preflightId: late.preflightId, ack: null, resume: false })
    expect(canceling.ok ? null : canceling.error.code).toBe('invalid-state')
    await finish(clock)
  })

  it('runs every operation to a verified stamp named by its planned output', async () =>
  {
    const { api, clock } = await harness()
    const extract = (mode: string): Recipe => (EXTRACT_PRESETS.find((preset) => preset.recipe.mode === mode) as { recipe: Recipe }).recipe
    const assignments = [
      { jobId: PODCAST, recipe: applyDefaultPreset('boost', { kind: 'same-as-source' }) },
      { jobId: FILM, recipe: extract('subtitles') },
      { jobId: DRONE, recipe: extract('frames') },
      { jobId: 'MM-0009' as JobId, recipe: extract('gif') },
      { jobId: 'MM-0003' as JobId, recipe: extract('audio') },
      { jobId: 'MM-0007' as JobId, recipe: (CONVERT_PRESETS.find((preset) => preset.recipe.video === null) as { recipe: Recipe }).recipe }
    ]
    value(await api.assignRecipe({ assignments }))
    const ids = assignments.map((entry) => entry.jobId)
    const report = value(await api.preflight({ ids }))
    expect(report.counts).toMatchObject({ jobs: 6, ready: 6, blocked: 0 })
    value(await api.start({ preflightId: report.preflightId, ack: null, resume: false }))
    await finish(clock)
    const jobs = value(await api.subscribe({ clientId: 'ops' })).jobs.filter((job) => ids.includes(job.id))
    for (const job of jobs)
    {
      expect(job.state).toBe('done')
      expect(job.stamp).toMatchObject({ verdict: 'verified', outputName: job.plan?.finalName, container: job.plan?.container })
    }
    const byId = Object.fromEntries(jobs.map((job) => [job.id, job]))
    expect(byId[DRONE].plan?.finalName).not.toMatch(/\.\w+$/)
    expect(byId[DRONE].stamp?.frames).toBe(24)
    expect(byId[FILM].stamp?.cues).toBe(412)
    expect(byId[PODCAST].stamp?.loudness).toMatchObject({ status: 'not-checked', referenceLufs: null })
    expect(byId[PODCAST].stamp?.truePeak?.status).toBe('within')
    expect(byId['MM-0009'].plan?.container).toBe('gif')
  })

  it('runs on window timers when no clock is given', async () =>
  {
    vi.useFakeTimers()
    try
    {
      const api = createPreviewJobsApi({ samples: false })
      value(await api.subscribe({ clientId: 'timers' }))
      value(await api.add(addRequest(['E:\\Takes\\Take 1.wav'])))
      await vi.advanceTimersByTimeAsync(PROBE_MS)
      const snapshot = value(await api.subscribe({ clientId: 'timers-2' }))
      expect(snapshot.jobs[0]).toMatchObject({ probe: 'ok', addedAt: Date.now() - PROBE_MS })
    }
    finally
    {
      vi.useRealTimers()
    }
  })

  it('reports an unexpected throw as an internal error', async () =>
  {
    const clock = manualClock()
    const api = createPreviewJobsApi({ clock })
    clock.now = () =>
    {
      throw new Error('clock stopped')
    }
    const result = await api.remove({ ids: [FILM] })
    expect(result.ok ? null : result.error).toMatchObject({ code: 'internal', message: 'clock stopped' })
  })
})

function sourceFiles(dir: string): string[]
{
  return readdirSync(dir).flatMap((name) =>
  {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('preview isolation', () =>
{
  it('is imported only from the dev folder and imports nothing from Node or Electron', () =>
  {
    const renderer = join(process.cwd(), 'src', 'renderer')
    const dev = join(renderer, 'src', 'dev')
    const importers = sourceFiles(renderer)
      .filter((path) => !relative(dev, path).match(/^[^.]/) && /dev\/preview(Jobs|Media)|\.\/preview(Jobs|Media)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(renderer, path))
    expect(importers).toEqual([])
    for (const name of ['previewJobs.ts', 'previewMedia.ts'])
    {
      const text = readFileSync(join(dev, name), 'utf8')
      const specifiers = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1])
      expect(specifiers.length).toBeGreaterThan(0)
      expect(specifiers.filter((specifier) => /^(node:|electron|fs$|path$|os$|child_process$|@electron)/.test(specifier))).toEqual([])
      expect(text).not.toMatch(/\brequire\(|process\.|window\.api/)
    }
  })
})

describe('preview media', () =>
{
  it('chooses facts by extension and name, the same every time', () =>
  {
    const film = sampleFacts(PREVIEW_SAMPLES[0])
    expect(film.media).toMatchObject({ container: 'matroska', subtitles: 3, chapters: 12, video: { codec: 'h264', width: 1920 } })
    expect(film.media.audio.map((stream) => [stream.channels, stream.layout, stream.language])).toEqual([[6, '5.1(side)', 'eng'], [2, 'stereo', 'eng']])
    expect(sampleFacts(PREVIEW_SAMPLES[1]).media.audio[0]).toMatchObject({ codec: 'mp3', channels: 2, bitrateKbps: 128 })
    expect(PREVIEW_SAMPLES.slice(2, 6).map((path) => sampleFacts(path).media.audio[0].codec)).toEqual(['flac', 'flac', 'flac', 'flac'])
    expect(sampleFacts(PREVIEW_SAMPLES[6]).media.audio[0]).toMatchObject({ codec: 'aac', channels: 1, layout: 'mono' })
    expect(sampleFacts(PREVIEW_SAMPLES[7]).media.video).toMatchObject({ codec: 'hevc', width: 3840, height: 2160 })
    expect(sampleFacts(PREVIEW_SAMPLES[8]).media.video?.codec).toBe('vp9')
    expect(sampleFacts(PREVIEW_SAMPLES[9]).media).toMatchObject({ audio: [], video: { codec: 'h264' } })
    expect(sampleFacts('E:\\Cuts\\Teaser.avi').media.audio).toHaveLength(1)
    expect(sampleFacts('E:\\Cuts\\Teaser.wma').media).toMatchObject({ container: 'asf', audio: [expect.objectContaining({ codec: 'wmav2' })] })
    expect(sampleFacts('E:\\Cuts\\Teaser.ape').media).toMatchObject({ container: 'wav', audio: [expect.objectContaining({ bitsPerSample: 24 })] })
    expect(PREVIEW_SAMPLES.map((path) => sampleFacts(path).outcome).filter((outcome) => outcome !== 'verified')).toEqual(['fails', 'held'])
    expect(sampleFacts(PREVIEW_SAMPLES[0])).toEqual(film)
    expect(film.media.durationSec).toBeGreaterThanOrEqual(5400)
  })

  it('treats a path without an extension as a folder and finds the files it holds', () =>
  {
    expect([isFolderPath('E:\\Live\\Set'), isFolderPath('E:\\Live\\Set.v2\\'), isFolderPath('E:\\Live\\a.mp3')]).toEqual([true, true, false])
    expect([isSamplePath('E:\\notes.txt'), isSamplePath('E:\\a.FLAC'), isSamplePath('E:\\a.mkv')]).toEqual([false, true, true])
    expect(folderSamples('D:\\Media\\Music\\Night Ferry', false)).toEqual(PREVIEW_SAMPLES.slice(2, 6))
    expect(folderSamples('D:\\Media\\', true)).toEqual(PREVIEW_SAMPLES)
    expect(folderSamples('D:\\Media', false)).toEqual(['D:\\Media\\01 Media.flac', 'D:\\Media\\02 Media.flac', 'D:\\Media\\03 Media.flac', 'D:\\Media\\04 Media.flac'])
    expect(folderSamples('/home/sam/Live Set/', false)[0]).toBe('/home/sam/Live Set/01 Live Set.flac')
    expect(subdirOf('D:\\Media', PREVIEW_SAMPLES[2])).toBe('Music\\Night Ferry')
    expect(subdirOf('D:\\Media\\Music\\Night Ferry\\', PREVIEW_SAMPLES[2])).toBe('')
    expect([baseName(''), baseName('D:\\'), folderOf('Take.wav')]).toEqual(['', 'D:', ''])
    expect(sampleSource(PREVIEW_SAMPLES[0], 'drop')).toMatchObject({ name: 'Harbor Lights (2019).mkv', ext: 'mkv', dir: 'D:\\Media\\Films', origin: 'drop', subdir: '' })
  })
})
