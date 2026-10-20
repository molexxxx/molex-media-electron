/**
 * The run header's derivations: the brass precedence over every state of its table, Start's disabled reasons and
 * Ctrl+Enter, the title and the state sentence per state with its shedding order, the attention count of one batch,
 * the consequence line before, during, and after a run, the run controls, and the Output and Workers labels.
 */
import { describe, it, expect } from 'vitest'
import type { JobId, RunId } from '../../src/shared/jobs/ids'
import { attentionCount } from '../../src/shared/jobs/states'
import type
{
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  JobCounts,
  JobView,
  PlanSummary,
  PreflightReport,
  RunAlert,
  RunState,
  ScanState
} from '../../src/shared/jobs/types'
import { initialJobsState, type JobsState } from '../../src/renderer/src/stores/jobs'
import
{
  SHED_LEVELS,
  consequenceLine,
  ctrlEnter,
  deriveHeader,
  fitSentence,
  headerSubject,
  headerTitle,
  newJobsWaiting,
  nextAction,
  outcomeSentence,
  outputButton,
  policySentence,
  runControls,
  selectHeaderFacts,
  sentenceText,
  shedSentence,
  slotAction,
  stateSentence,
  workersButton,
  type HeaderFacts,
  type HeaderView,
  type ReviewSession
} from '../../src/renderer/src/stores/batchHeader'

const AT = new Date(2026, 9, 16, 13, 40).getTime()
const R30 = 'R-0030' as RunId
const R31 = 'R-0031' as RunId
const M = '\u2212'

const RECIPE = { kind: 'convert', presetId: 'mp4-h264' } as unknown as JobView['recipe']
const EXTRACT = { kind: 'extract', mode: 'audio' } as unknown as JobView['recipe']

let seq = 0

function plan(over: Partial<PlanSummary> = {}): PlanSummary
{
  return {
    status: 'ready',
    current: true,
    finalName: 'a.mp4',
    relativePath: 'a.mp4',
    container: 'mp4',
    resolution: 'place',
    encoderLabel: 'x264',
    errors: 0,
    warnings: 0,
    firstIssue: null,
    ...over
  }
}

function job(over: Partial<JobView> = {}): JobView
{
  seq += 1
  const id = `MM-${String(seq).padStart(4, '0')}` as JobId
  return {
    id,
    seq,
    rev: 1,
    inputsRev: 1,
    source: { path: `D:\\Rips\\${id}.mkv`, name: `${id}.mkv`, ext: 'mkv', dir: 'D:\\Rips', size: 1_000_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: RECIPE,
    recipeLabel: 'MP4',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: { container: 'mkv', durationSec: 600, video: null, audio: [], subtitles: 0, attachments: 0, chapters: 0, cover: false },
    probe: 'ok',
    plan: plan(),
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
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function inBatch(state: JobView['state'], over: Partial<JobView> = {}, runId: RunId = R31): JobView
{
  return job({ state, runId, startedAt: AT, endedAt: state === 'done' || state === 'failed' ? AT + 60_000 : null, ...over })
}

function counts(over: Partial<JobCounts> = {}): JobCounts
{
  return {
    pending: 0, queued: 0, analyzing: 0, encoding: 0, verifying: 0, finalizing: 0,
    held: 0, done: 0, failed: 0, canceled: 0, skipped: 0, interrupted: 0, ...over
  }
}

function run(over: Partial<RunState> = {}): RunState
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

function running(over: Partial<RunState> = {}): RunState
{
  return run({ status: 'running', runId: R31, startedAt: AT, ...over })
}

const FOLDER: BatchPolicy =
{
  rev: 1,
  destination: { mode: 'folder', folder: 'D:\\Exports\\Podcasts' },
  template: '{name}',
  conflict: 'rename',
  displaced: 'trash',
  gpu: 'auto'
}

const CAPABILITIES: CapabilitySummary =
{
  rev: 1,
  ffmpeg: { ready: true, version: '9.0.2', source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
  encoders: ['libx264'],
  gpu: { status: 'ready', vendor: 'nvidia', name: 'RTX 4070', encoders: ['h264_nvenc'] },
  cpuCount: 16,
  platform: 'win32'
}

function state(jobs: JobView[], over: Partial<JobsState> = {}): JobsState
{
  const record = {} as Record<JobId, JobView>
  for (const item of jobs)
  {
    record[item.id] = item
  }
  return { ...initialJobsState(), status: 'hydrated', hydrations: 1, run: run(), policy: FOLDER, order: jobs.map((item) => item.id), jobs: record, ...over }
}

function reportCounts(over: Partial<PreflightReport['counts']> = {}): PreflightReport['counts']
{
  return {
    jobs: 22, ready: 21, blocked: 1, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0,
    containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 3, ...over
  }
}

function review(over: Partial<ReviewSession> = {}): ReviewSession
{
  return { counts: reportCounts(), subset: false, acknowledged: false, ...over }
}

const QUEUE: HeaderView = { mode: 'queue', platform: 'win32' }
const REVIEW: HeaderView = { mode: 'review', platform: 'win32', review: review() }

function summary(over: Partial<BatchSummary> = {}): BatchSummary
{
  return {
    runId: R31,
    startedAt: AT,
    endedAt: AT + 2_530_000,
    elapsedMs: 2_530_000,
    endedBy: 'completed',
    interruptions: 0,
    counts: { total: 22, done: 19, verified: 19, reachable: 0, outsideTolerance: 1, failed: 1, canceled: 1, skipped: 0, held: 0, interrupted: 0, returned: 2 },
    bytes: { input: 25_800_000_000, output: 21_400_000_000 },
    mediaSec: 35_340,
    originals: { trashed: 0, kept: 0, volumes: [] },
    previous: { trashed: 0, kept: 0 },
    recipes: [],
    albums: [],
    failures: [],
    policy: { ...FOLDER, frozenAt: AT, date: '2026-10-16' },
    ffmpeg: { version: '9.0.2', source: 'bundled' },
    appVersion: '4.8.0',
    ...over
  }
}

function alert(kind: RunAlert['kind'], over: Partial<RunAlert> = {}): RunAlert
{
  return { id: kind, kind, severity: 'warning', message: 'm', at: AT, volume: null, path: null, jobIds: [], counts: null, dismissible: false, ...over }
}

function facts(jobs: JobView[], over: Partial<JobsState> = {}): HeaderFacts
{
  return selectHeaderFacts(state(jobs, over))
}

describe('header facts', () =>
{
  it('counts the current batch, its attention, the returned jobs, and waiting Extract jobs', () =>
  {
    const jobs = [
      inBatch('done'),
      inBatch('done', { warnings: [{ code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'm' }] }),
      inBatch('failed'),
      inBatch('interrupted'),
      inBatch('canceled', { reason: 'run-canceled' }),
      inBatch('canceled', { reason: 'user' }),
      inBatch('held'),
      inBatch('encoding'),
      inBatch('queued'),
      inBatch('failed', {}, R30),
      job({ recipe: EXTRACT }),
      job({ runId: R31 })
    ]
    const value = facts(jobs, { run: running() })
    expect(value.status).toBe('running')
    expect(value.batch).toMatchObject({ runId: R31, total: 9, settled: 7, active: 1, queued: 1, done: 2, canceled: 2, canceledByRun: 1, attention: 4, startedAt: AT, endedAt: AT + 60_000 })
    expect(value.batch?.attention).toBe(attentionCount(jobs, R31))
    expect(value.returned).toBe(4)
    expect(value.pendingExtract).toBe(1)
    expect(value.pending.jobs).toBe(2)
    expect(value.jobCount).toBe(12)
  })

  it('describes the latest batch after a run and none when only waiting jobs carry its number', () =>
  {
    expect(facts([inBatch('done', {}, R30), inBatch('done')]).batch?.runId).toBe(R31)
    expect(facts([job({ runId: R31 })]).batch).toBeNull()
    expect(facts([], { run: running({ runId: 'R-0032' as RunId }) }).batch).toMatchObject({ runId: 'R-0032', total: 0 })
  })

  it('reads the scan, the queue limit, and returns the same facts for the same store', () =>
  {
    const scan: ScanState = { scanId: 's', root: 'D:\\Rips', status: 'scanning', error: null, visited: 1300, added: 1204, excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 } }
    const store = state([job()], { scans: [{ ...scan, scanId: 'old', status: 'done' }, scan], limits: { maxJobs: 1 } })
    const value = selectHeaderFacts(store)
    expect(value.scan).toBe(scan)
    expect(value.queueFull).toBe(true)
    expect(selectHeaderFacts(store)).toBe(value)
    expect(selectHeaderFacts(state([job()])).queueFull).toBe(false)
  })
})

describe('the one next action', () =>
{
  const waiting = [job(), job()]
  const returned = [inBatch('failed'), inBatch('done')]

  it('puts Resume first while pausing or paused', () =>
  {
    for (const status of ['pausing', 'paused'] as const)
    {
      const value = facts([...waiting, ...returned, inBatch('queued')], { run: running({ status }) })
      const action = nextAction(value, REVIEW)
      expect(action).toMatchObject({ kind: 'resume', label: 'Resume', tooltip: 'Resume (Ctrl+P)', enabled: true, place: 'header' })
    }
  })

  it('holds Resume of a restored Replace batch until its banner is acknowledged', () =>
  {
    const value = facts([inBatch('queued')], { run: running({ status: 'paused' }) })
    expect(nextAction(value, QUEUE, null, true)).toMatchObject({ kind: 'resume', enabled: false, blockedBy: 'acknowledgment', reason: 'Confirm the Recycle Bin step in the banner first.' })
    expect(nextAction(value, { ...QUEUE, restoredAcknowledged: true }, null, true)?.enabled).toBe(true)
  })

  it('offers new jobs during a run: Review them, then Append in Review', () =>
  {
    const value = facts([...waiting, inBatch('encoding')], { run: running() })
    expect(nextAction(value, QUEUE)).toMatchObject({ kind: 'review-new', label: 'Review 2 new jobs', count: 2, enabled: true })
    expect(nextAction(value, { ...QUEUE, mode: 'run' })?.kind).toBe('review-new')
    expect(nextAction(value, { ...REVIEW, review: review({ counts: reportCounts({ jobs: 2, ready: 2, blocked: 0 }) }) }))
      .toMatchObject({ kind: 'append', label: 'Append 2 jobs to Batch 31', tooltip: 'Append (Ctrl+Enter)', enabled: true })
  })

  it('leaves a blocked job outside the batch out of the new jobs and out of the action', () =>
  {
    const blocked = job({ plan: plan({ status: 'blocked' }) })
    const alone = facts([blocked, inBatch('encoding')], { run: running() })
    expect(newJobsWaiting(alone)).toBe(0)
    expect(nextAction(alone, QUEUE)).toBeNull()
    expect(deriveHeader(state([blocked, inBatch('encoding')], { run: running() }), QUEUE).sentence.full).not.toContain('new job')
    const mixed = facts([blocked, job(), inBatch('encoding')], { run: running() })
    expect(newJobsWaiting(mixed)).toBe(1)
    expect(nextAction(mixed, QUEUE)).toMatchObject({ kind: 'review-new', label: 'Review 1 new job', count: 1 })
  })

  it('has none while a run has nothing new, and none while canceling', () =>
  {
    expect(nextAction(facts([inBatch('encoding')], { run: running() }), QUEUE)).toBeNull()
    expect(nextAction(facts([...waiting, inBatch('encoding')], { run: running({ status: 'canceling' }) }), REVIEW)).toBeNull()
    expect(nextAction(facts(waiting, { run: running({ runId: null }) }), QUEUE)).toBeNull()
  })

  it('starts in Review, reviews elsewhere, and prefers either to Retry returned', () =>
  {
    const value = facts([...waiting, ...returned])
    expect(nextAction(value, REVIEW)).toMatchObject({ kind: 'start', label: 'Start 21 jobs', tooltip: 'Start (Ctrl+Enter)', count: 21, enabled: true })
    expect(nextAction(value, QUEUE)).toMatchObject({ kind: 'review', label: 'Review 2 jobs', tooltip: 'Review (Ctrl+Enter)', enabled: true })
    expect(nextAction(value, { ...QUEUE, mode: 'history' })?.kind).toBe('review')
    expect(nextAction(value, { ...QUEUE, mode: 'run' })?.kind).toBe('review')
  })

  it('retries returned jobs once nothing waits, then adds files to an empty queue, then has none', () =>
  {
    expect(nextAction(facts(returned), QUEUE)).toMatchObject({ kind: 'retry-returned', label: 'Retry 1 returned', count: 1, enabled: true })
    expect(nextAction(facts(returned), REVIEW)?.kind).toBe('retry-returned')
    expect(nextAction(facts([]), QUEUE)).toMatchObject({ kind: 'add-files', label: 'Add files', place: 'empty-state', enabled: true })
    expect(nextAction(facts([inBatch('done')]), QUEUE)).toBeNull()
  })

  it('names the shortcut for the platform', () =>
  {
    expect(nextAction(facts(waiting), { ...QUEUE, platform: 'darwin' })?.tooltip).toBe('Review (Cmd+Enter)')
  })
})

describe('Start in Review', () =>
{
  const start = (jobs: JobView[], view: Partial<HeaderView>, preflight: JobsState['preflight'] = null) =>
    nextAction(facts(jobs), { ...REVIEW, ...view }, preflight)

  it('waits for probes, then for the check, then for a report', () =>
  {
    expect(start([job({ probe: 'pending', plan: null }), job()], {})).toMatchObject({ enabled: false, blockedBy: 'probing', reason: 'Probing 1 of 2 files.' })
    expect(start([job()], {}, { preflightId: 'p', done: 412, total: 1000 })).toMatchObject({ enabled: false, blockedBy: 'checking', reason: 'Checking 412 of 1,000 jobs.' })
    expect(start([job()], { review: null })).toMatchObject({ enabled: false, blockedBy: 'checking', reason: 'Checking 0 of 1 job.', label: 'Start 0 jobs' })
    expect(start([job()], {}, { preflightId: 'p', done: 5, total: 5 })?.enabled).toBe(true)
  })

  it('is disabled with its reason when nothing can run', () =>
  {
    expect(start([job()], { review: review({ counts: reportCounts({ ready: 0, blocked: 2 }) }) }))
      .toMatchObject({ enabled: false, blockedBy: 'nothing-runnable', reason: 'Nothing can run: 2 jobs are blocked.' })
  })

  it('waits for the acknowledgment when originals or existing files are affected', () =>
  {
    const destructive = review({ counts: reportCounts({ originalsAffected: 20, overwrites: 3 }) })
    expect(start([job()], { review: destructive })).toMatchObject({
      label: 'Start 21 jobs, replace 20 originals and 3 files',
      enabled: false,
      blockedBy: 'acknowledgment',
      reason: 'Confirm the Recycle Bin step in the summary first.'
    })
    expect(start([job()], { review: { ...destructive, acknowledged: true } })?.enabled).toBe(true)
    expect(start([job()], { platform: 'darwin', review: review({ counts: reportCounts({ overwrites: 3 }) }) })?.reason).toBe('Confirm the Trash step in the summary first.')
  })

  it('refuses while a field draft is invalid, and shows Starting while main answers', () =>
  {
    expect(start([job()], { invalidField: 'Target, integrated' })).toMatchObject({ enabled: false, blockedBy: 'field', reason: 'Fix Target, integrated first.' })
    expect(start([job()], { starting: true })).toMatchObject({ label: 'Starting\u2026', enabled: false, blockedBy: 'starting', reason: null })
  })

  it('names a subset', () =>
  {
    expect(start([job()], { review: review({ subset: true, counts: reportCounts({ jobs: 8, ready: 8 }) }) })?.label).toBe('Start 8 selected jobs')
  })
})

describe('the action slot, the brass, and Ctrl+Enter', () =>
{
  it('shows the next action, a neutral disabled Review, or nothing beside the run controls', () =>
  {
    const empty = facts([])
    expect(slotAction(empty, nextAction(empty, QUEUE))).toMatchObject({ kind: 'review', label: 'Review', enabled: false, tooltip: 'Add files to review them.' })
    const finished = facts([inBatch('done')])
    expect(slotAction(finished, null)?.enabled).toBe(false)
    const busy = facts([inBatch('encoding')], { run: running() })
    expect(slotAction(busy, null)).toBeNull()
    expect(slotAction(facts([inBatch('encoding')], { run: running({ status: 'canceling' }) }), null)).toBeNull()
    const waiting = facts([job()])
    const action = nextAction(waiting, QUEUE)
    expect(slotAction(waiting, action)).toBe(action)
  })

  it('places the brass on the slot, on the empty state, or nowhere', () =>
  {
    expect(deriveHeader(state([job()]), QUEUE).brass).toBe('slot')
    expect(deriveHeader(state([]), QUEUE).brass).toBe('empty-state')
    expect(deriveHeader(state([job()]), { ...REVIEW, review: review({ counts: reportCounts({ ready: 0 }) }) }).brass).toBeNull()
    expect(deriveHeader(state([inBatch('encoding')], { run: running() }), QUEUE).brass).toBeNull()
    expect(deriveHeader(state([inBatch('done')]), QUEUE).brass).toBeNull()
    expect(deriveHeader(state([inBatch('queued')], { run: running({ status: 'paused', needsAck: { originalsAffected: 2, overwrites: 0 } }) }), QUEUE).brass).toBeNull()
  })

  it('performs the action, says why it cannot, ignores presses while starting, or says there is nothing to start', () =>
  {
    const value = facts([job()])
    const review = nextAction(value, QUEUE)
    expect(ctrlEnter(review)).toEqual({ kind: 'perform', action: review })
    const ack = nextAction(value, { ...REVIEW, review: { counts: reportCounts({ originalsAffected: 2 }), subset: false, acknowledged: false } })
    expect(ctrlEnter(ack)).toMatchObject({ kind: 'refuse', focus: 'acknowledgment', announcement: 'Confirm the Recycle Bin step in the summary first.' })
    expect(ctrlEnter(nextAction(value, { ...REVIEW, invalidField: 'Gain' }))).toMatchObject({ kind: 'refuse', focus: 'field', announcement: 'Fix Gain first.' })
    expect(ctrlEnter(nextAction(value, { ...REVIEW, review: null }))).toMatchObject({ kind: 'refuse', focus: null, announcement: 'Checking 0 of 1 job.' })
    expect(ctrlEnter(nextAction(value, { ...REVIEW, starting: true }))).toEqual({ kind: 'ignore' })
    expect(ctrlEnter(null)).toEqual({ kind: 'nothing', announcement: 'Nothing to start.' })
    const reasonless = { ...(review as NonNullable<typeof review>), enabled: false, reason: null, blockedBy: 'checking' as const }
    expect(ctrlEnter(reasonless)).toMatchObject({ kind: 'refuse', announcement: 'Nothing to start.' })
  })
})

describe('title and state sentence', () =>
{
  const text = (jobs: JobView[], over: Partial<JobsState> = {}, view: HeaderView = QUEUE): string => deriveHeader(state(jobs, over), view).sentence.full

  it('reads "Batch" and "No jobs yet" for an empty queue', () =>
  {
    const header = deriveHeader(state([]), QUEUE)
    expect(header.title).toBe('Batch')
    expect(header.subject).toBe('empty')
    expect(header.sentence.full).toBe('No jobs yet')
  })

  it('counts waiting jobs with their size, media time, and problems', () =>
  {
    const jobs = [
      job({ source: { ...job().source, size: 20_000_000_000 }, media: { ...job().media!, durationSec: 18_000 }, plan: plan({ status: 'blocked' }) }),
      job({ source: { ...job().source, size: 15_600_000_000 }, media: { ...job().media!, durationSec: 18_120 }, plan: plan({ warnings: 2 }) })
    ]
    expect(text(jobs)).toBe('2 jobs · 35.6 GB · 10 h 2 min of media · 1 blocked · 1 with warnings')
    expect(text([job({ source: { ...job().source, size: 0 }, media: null })], { limits: { maxJobs: 1 } })).toBe('1 job · queue full')
    expect(deriveHeader(state(jobs), QUEUE).title).toBe('Batch')
  })

  it('reads probing, review, scanning, and starting sentences', () =>
  {
    expect(text([job({ probe: 'pending', plan: null }), job()])).toBe('Probing 1 of 2 files')
    expect(text([job()], {}, REVIEW)).toBe('21 of 22 jobs can run')
    expect(text([job()], {}, { ...REVIEW, review: null })).toBe('1 job · 1 GB · 10 min of media')
    const scan: ScanState = { scanId: 's', root: 'D:\\Rips', status: 'scanning', error: null, visited: 1300, added: 1204, excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 } }
    expect(text([], { scans: [scan] })).toBe('Scanning D:\\Rips · 1,204 files found')
    expect(text([job()], {}, { ...REVIEW, starting: true })).toBe('Starting')
  })

  it('describes a running batch under its number, with new jobs and attention', () =>
  {
    const jobs = [...Array.from({ length: 9 }, () => inBatch('done')), inBatch('failed'), ...Array.from({ length: 12 }, () => inBatch('queued'))]
    const header = deriveHeader(state(jobs, { run: running() }), QUEUE)
    expect(header.title).toBe('Batch 31')
    expect(header.sentence.full).toBe('10 of 22 finished · 1 needs attention')
    expect(header.attention).toEqual({ runId: R31, count: 1, label: '1 needs attention', tooltip: 'Show the jobs of Batch 31 that need attention (F8 steps through them)' })
    expect(text([...jobs, job(), job(), job()], { run: running() })).toBe('10 of 22 finished · 3 new jobs waiting · 1 needs attention')
  })

  it('reads pausing, paused, and canceling', () =>
  {
    const jobs = [inBatch('encoding'), inBatch('encoding'), inBatch('verifying'), ...Array.from({ length: 12 }, () => inBatch('queued'))]
    expect(text(jobs, { run: running({ status: 'pausing' }) })).toBe('Pausing · 3 jobs finishing their current encode')
    expect(text([inBatch('encoding')], { run: running({ status: 'pausing' }) })).toBe('Pausing · 1 job finishing its current encode')
    expect(text(jobs.slice(3), { run: running({ status: 'paused', pause: { mode: 'finish-running', reason: 'user', since: AT } }) })).toBe('Paused · 12 jobs waiting')
    expect(text(jobs.slice(3), { run: running({ status: 'paused', pause: { mode: 'finish-running', reason: 'restored', since: AT } }) })).toBe('Paused · 12 jobs waiting')
    expect(text(jobs, { run: running({ status: 'canceling' }) })).toBe('Canceling · stopping 3 jobs')
  })

  it('names what the app paused for with a warning label', () =>
  {
    const paused = (reason: NonNullable<RunState['pause']>['reason'], over: Partial<JobsState> = {}) =>
      deriveHeader(state([inBatch('queued')], { run: running({ status: 'paused', pause: { mode: 'finish-running', reason, since: AT } }), ...over }), QUEUE).sentence
    const disk = paused('disk-space', { alerts: [alert('disk-space', { volume: 'E:' }), alert('disk-space', { volume: 'D:' })] })
    expect(disk.full).toBe('Paused: D: is full')
    expect(disk.parts[0].tone).toBe('warning')
    expect(paused('disk-space').full).toBe('Paused: the disk is full')
    expect(paused('destination-unavailable', { alerts: [alert('destination-unavailable', { path: 'D:\\Exports' })] }).full).toBe('Paused: D:\\Exports is not available')
    expect(paused('destination-unavailable', { alerts: [alert('destination-unavailable', { volume: 'D:' })] }).full).toBe('Paused: D: is not available')
    expect(paused('destination-unavailable').full).toBe('Paused: D:\\Exports\\Podcasts is not available')
    expect(paused('destination-unavailable', { policy: { ...FOLDER, destination: { mode: 'next-to-source' } } }).full).toBe('Paused: the output folder is not available')
    expect(paused('ffmpeg-unavailable').full).toBe('Paused: FFmpeg is not ready')
    expect(paused('storage').full).toBe('Paused: molexMedia cannot save its queue')
    const pausing = deriveHeader(state([inBatch('encoding')], { run: running({ status: 'pausing', pause: { mode: 'finish-running', reason: 'disk-space', since: AT } }) }), QUEUE)
    expect(pausing.sentence.full).toBe('Paused: the disk is full')
  })

  it('reads a finished batch from its summary, or from its jobs after a reload', () =>
  {
    const jobs = [inBatch('done'), inBatch('failed'), inBatch('failed', { acknowledged: true })]
    const withSummary = deriveHeader(state(jobs), { ...QUEUE, summary: summary() })
    expect(withSummary.title).toBe('Batch 31')
    expect(withSummary.subject).toBe('finished')
    expect(withSummary.sentence.full).toBe('Finished in 42 min 10 s · 1 needs attention')
    expect(text(jobs)).toBe('Finished in 1 min · 1 needs attention')
    expect(text([inBatch('done', { startedAt: null })])).toBe('Finished')
    expect(deriveHeader(state(jobs), { ...QUEUE, summary: summary({ runId: R30 }) }).sentence.full).toBe('Finished in 1 min · 1 needs attention')
  })

  it('reads a canceled batch', () =>
  {
    const jobs = [inBatch('done'), inBatch('canceled', { reason: 'run-canceled', endedAt: AT + 720_000 })]
    expect(text(jobs)).toBe('Canceled after 12 min · 1 verified · 1 canceled')
    expect(deriveHeader(state(jobs), { ...QUEUE, summary: summary({ endedBy: 'canceled', elapsedMs: 720_000, counts: { ...summary().counts, verified: 10, canceled: 12 } }) }).sentence.full)
      .toBe('Canceled after 12 min · 10 verified · 12 canceled')
    expect(text([inBatch('canceled', { reason: 'run-canceled', startedAt: null })])).toBe('Canceled · 0 verified · 1 canceled')
  })

  it('keeps the last batch\'s attention lit while new jobs wait', () =>
  {
    const header = deriveHeader(state([inBatch('failed'), job()]), QUEUE)
    expect(header.title).toBe('Batch')
    expect(header.sentence.full).toBe('1 job · 1 GB · 10 min of media · 1 needs attention')
    expect(header.attention?.count).toBe(1)
  })

  it('counts only jobs of this batch for the attention button', () =>
  {
    const jobs = [inBatch('failed', {}, R30), inBatch('done')]
    const header = deriveHeader(state(jobs), QUEUE)
    expect(header.attention).toBeNull()
    expect(header.sentence.full).toBe('Finished in 1 min')
  })

  it('falls back to a job count when nothing else describes the queue', () =>
  {
    const value = facts([job({ state: 'done', runId: null })])
    expect(headerSubject(value, QUEUE)).toBe('jobs')
    expect(stateSentence(value, QUEUE, null).full).toBe('1 job')
    expect(headerTitle(value, QUEUE)).toBe('Batch')
  })
})

describe('shedding', () =>
{
  const jobs = [
    job({ source: { ...job().source, size: 20_000_000_000 }, media: { ...job().media!, durationSec: 18_000 }, plan: plan({ status: 'blocked' }) }),
    job({ source: { ...job().source, size: 15_600_000_000 }, media: { ...job().media!, durationSec: 18_120 }, plan: plan({ warnings: 2 }) }),
    inBatch('failed')
  ]
  const sentence = deriveHeader(state(jobs), QUEUE).sentence

  it('drops the media time first, then the size, and shortens problems last', () =>
  {
    expect(SHED_LEVELS).toEqual([0, 1, 2, 3])
    expect(sentenceText(shedSentence(sentence, 0))).toBe('2 jobs · 35.6 GB · 10 h 2 min of media · 1 blocked · 1 with warnings · 1 needs attention')
    expect(sentenceText(shedSentence(sentence, 1))).toBe('2 jobs · 35.6 GB · 1 blocked · 1 with warnings · 1 needs attention')
    expect(sentenceText(shedSentence(sentence, 2))).toBe('2 jobs · 1 blocked · 1 with warnings · 1 needs attention')
    expect(sentenceText(shedSentence(sentence, 3))).toBe('2 jobs · 1 blocked · 1 warnings · 1 needs attention')
    for (const level of SHED_LEVELS)
    {
      const kinds = shedSentence(sentence, level).map((item) => item.kind)
      expect(kinds).toEqual(expect.arrayContaining(['blocked', 'warnings', 'attention']))
    }
  })

  it('fits the widest step that fits and keeps the full sentence for the description', () =>
  {
    const fit = (max: number) => fitSentence(sentence, (value) => value.length <= max)
    expect(fit(200).level).toBe(0)
    expect(fit(70).level).toBe(1)
    expect(fit(60).level).toBe(2)
    expect(fit(10)).toMatchObject({ level: 3, text: '2 jobs · 1 blocked · 1 warnings · 1 needs attention' })
    expect(sentence.full).toBe('2 jobs · 35.6 GB · 10 h 2 min of media · 1 blocked · 1 with warnings · 1 needs attention')
    expect(sentenceText(sentence.parts, true)).toBe('2 jobs · 35.6 GB · 10 h 2 min of media · 1 blocked · 1 warnings · 1 needs attention')
  })
})

describe('consequence line', () =>
{
  it('states the output policy before a run', () =>
  {
    expect(policySentence(FOLDER, 'win32')).toEqual({ text: 'Writes to D:\\Exports\\Podcasts as {name} · Renames if the name is taken · Originals are not touched', warning: false })
    expect(policySentence({ ...FOLDER, conflict: 'skip' }, 'win32').text).toBe('Writes to D:\\Exports\\Podcasts as {name} · Skips the job if the name is taken · Originals are not touched')
    expect(policySentence({ ...FOLDER, conflict: 'overwrite' }, 'win32').text)
      .toBe('Writes to D:\\Exports\\Podcasts as {name} · Replaces an existing file after this output verifies; the old one goes to the Recycle Bin · Originals are not touched')
    expect(policySentence({ ...FOLDER, conflict: 'overwrite' }, 'darwin').text).toContain('the old one goes to the Trash')
    expect(policySentence({ ...FOLDER, conflict: 'overwrite', displaced: 'keep' }, 'win32').text).toContain('the old one stays as name (previous).ext')
    expect(policySentence({ ...FOLDER, destination: { mode: 'next-to-source' }, template: '{name}-{op}' }, 'win32').text)
      .toBe('Writes next to each source as {name}-{op} · Renames if the name is taken · Originals are not touched')
  })

  it('turns into a warning under Replace originals', () =>
  {
    const replace: BatchPolicy = { ...FOLDER, destination: { mode: 'replace-originals' } }
    expect(policySentence(replace, 'win32')).toEqual({ text: 'Replaces originals: each output is verified, then its original goes to the Recycle Bin. Ends with this batch.', warning: true })
    expect(policySentence(replace, 'win32', 2).text).toBe('Replaces originals: each output is verified, then its original goes to the Recycle Bin. Ends with this batch. Extract jobs write beside their sources.')
    expect(policySentence({ ...replace, displaced: 'keep' }, 'win32').text)
      .toBe('Replaces originals: each output is verified, then takes its original\'s place; originals stay as name (original).ext. Ends with this batch.')
    const header = deriveHeader(state([job({ recipe: EXTRACT })], { policy: replace }), QUEUE)
    expect(header.consequence).toEqual({ kind: 'policy', text: policySentence(replace, 'win32', 1).text, warning: true })
    expect(deriveHeader(state([], { policy: null }), QUEUE).consequence).toBeNull()
  })

  it('shows progress, time left, and throughput during a run', () =>
  {
    const progress = (over: Partial<RunState['progress']>, status: RunState['status'] = 'running') =>
      consequenceLine(facts([inBatch('encoding')], { run: running({ status }) }), QUEUE, running({ status, progress: { ...run().progress, ...over } }), FOLDER)
    expect(progress({ percent: 46.4, etaSec: 1080, elapsedMs: 600_000, mediaSecPerSec: 3.4 }))
      .toEqual({ kind: 'progress', percent: 46.4, percentText: '46%', status: null, timeLeft: 'about 18 min left', throughput: '3.4x realtime' })
    expect(progress({ etaSec: 1080, elapsedMs: 10_000 })).toMatchObject({ timeLeft: 'Estimating time left', throughput: null })
    expect(progress({ etaSec: null, elapsedMs: 60_000 })).toMatchObject({ timeLeft: 'Estimating time left' })
    expect(progress({ etaSec: 20, elapsedMs: 60_000 })).toMatchObject({ timeLeft: 'less than a minute left' })
    expect(progress({ percent: 46, etaSec: 1080, elapsedMs: 600_000, mediaSecPerSec: 3.4 }, 'paused')).toMatchObject({ status: 'Paused', timeLeft: null, throughput: null, percentText: '46%' })
    expect(progress({ etaSec: 1080, elapsedMs: 600_000 }, 'canceling')).toMatchObject({ status: null, timeLeft: null })
  })

  it('states what happened after a run', () =>
  {
    expect(outcomeSentence(summary(), 'win32')).toBe('Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched')
    expect(outcomeSentence(summary({ policy: { ...summary().policy, destination: { mode: 'next-to-source' } } }), 'win32')).toBe('Started 13:40 · Wrote next to each source · Originals not touched')
    const replaced = summary({ policy: { ...summary().policy, destination: { mode: 'replace-originals' } }, originals: { trashed: 19, kept: 1, volumes: [{ volume: 'D:', trashed: 19 }] } })
    expect(outcomeSentence(replaced, 'win32')).toBe('Started 13:40 · Replaced 20 originals: 19 in the Recycle Bin on D:, 1 kept beside its output')
    expect(outcomeSentence(replaced, 'darwin')).toBe('Started 13:40 · Replaced 20 originals: 19 in the Trash, 1 kept beside its output')
    const volumes = summary({ policy: replaced.policy, originals: { trashed: 21, kept: 3, volumes: [{ volume: 'D:', trashed: 14 }, { volume: 'E:', trashed: 6 }, { volume: 'F:', trashed: 0 }] } })
    expect(outcomeSentence(volumes, 'win32')).toBe('Started 13:40 · Replaced 24 originals: 14 in the Recycle Bin on D:, 6 in the Recycle Bin on E:, 1 in the Recycle Bin, 3 kept beside their outputs')
    const header = deriveHeader(state([inBatch('done')]), { ...QUEUE, summary: summary() })
    expect(header.consequence).toEqual({ kind: 'outcome', text: 'Started 13:40 · Wrote to D:\\Exports\\Podcasts · Originals not touched' })
    expect(deriveHeader(state([inBatch('done')]), QUEUE).consequence).toEqual({ kind: 'outcome', text: 'Started 13:40' })
    expect(deriveHeader(state([inBatch('done', { startedAt: null })]), QUEUE).consequence).toBeNull()
  })
})

describe('run controls, Output, and Workers', () =>
{
  it('offers Pause, Pause now, and Cancel run by run status', () =>
  {
    const controls = (status: RunState['status'], jobs: JobView[], mode: 'finish-running' | 'stop-running' = 'finish-running') =>
    {
      const current = running({ status, pause: status === 'running' ? null : { mode, reason: 'user', since: AT } })
      return runControls(facts(jobs, { run: current }), current, 'win32')
    }
    expect(controls('running', [inBatch('encoding'), inBatch('encoding'), inBatch('queued')])).toEqual({
      pause: { label: 'Pause', tooltip: 'Pause (Ctrl+P). Jobs already running finish first.' },
      pauseNow: { label: 'Pause now: 2 running jobs restart from the beginning', tooltip: 'Stops running jobs now and deletes their partial files. They start over when you resume.', running: 2 },
      cancel: { label: 'Cancel run', tooltip: 'Stops the batch. Finished jobs keep their outputs.' }
    })
    expect(controls('running', [inBatch('queued')])?.pauseNow).toBeNull()
    expect(controls('pausing', [inBatch('encoding')])).toMatchObject({ pause: null, pauseNow: { running: 1 } })
    expect(controls('pausing', [inBatch('encoding')], 'stop-running')?.pauseNow).toBeNull()
    expect(controls('paused', [inBatch('queued')])).toMatchObject({ pause: null, pauseNow: null, cancel: { label: 'Cancel run' } })
    expect(controls('canceling', [inBatch('encoding')])).toBeNull()
    expect(runControls(facts([inBatch('done')]), run(), 'win32')).toBeNull()
  })

  it('locks Output while the batch holds queued or running jobs', () =>
  {
    expect(outputButton(facts([job()]))).toEqual({ label: 'Output', tooltip: 'Where outputs go and how they are named', locked: false })
    expect(outputButton(facts([inBatch('queued'), inBatch('encoding')], { run: running() }))).toMatchObject({ locked: true, tooltip: 'Where outputs go and how they are named' })
    expect(outputButton(facts([inBatch('encoding'), inBatch('encoding'), inBatch('encoding')], { run: running() }))).toMatchObject({ locked: true, tooltip: 'Output unlocks when 3 running jobs finish.' })
    expect(outputButton(facts([inBatch('encoding')], { run: running() })).tooltip).toBe('Output unlocks when 1 running job finishes.')
    expect(outputButton(facts([inBatch('done')], { run: running() })).locked).toBe(false)
  })

  it('labels Workers with the GPU policy before a run and the active count during one', () =>
  {
    expect(workersButton(null, FOLDER, CAPABILITIES)).toEqual({ label: 'Workers', shortLabel: 'Workers', tooltip: 'Workers and GPU encoding' })
    expect(workersButton(run(), FOLDER, CAPABILITIES).label).toBe('16 workers · GPU when allowed')
    expect(workersButton(run(), { ...FOLDER, gpu: 'off' }, CAPABILITIES).label).toBe('16 workers · GPU off')
    expect(workersButton(run(), FOLDER, { ...CAPABILITIES, gpu: { status: 'ready', vendor: null, name: null, encoders: [] } }).label).toBe('16 workers')
    expect(workersButton(run(), FOLDER, { ...CAPABILITIES, gpu: { ...CAPABILITIES.gpu, status: 'detecting' } }).label).toBe('16 workers')
    expect(workersButton(run(), FOLDER, null).label).toBe('16 workers')
    expect(workersButton(run(), null, CAPABILITIES).label).toBe('16 workers · GPU when allowed')
    const one = run({ workers: { ...run().workers, limits: { total: 1, videoCpu: 1, gpu: 0 } } })
    expect(workersButton(one, FOLDER, null).label).toBe('1 worker')
    const busy = running({ workers: { ...run().workers, active: { total: 6, videoCpu: 2, gpu: 1, analysis: 0, starting: 0 } } })
    expect(workersButton(busy, FOLDER, CAPABILITIES).label).toBe('16 workers · 6 active')
  })
})

describe('the whole header', () =>
{
  it('derives every region of the header for a run with new jobs in Review', () =>
  {
    const jobs = [inBatch('encoding'), inBatch('done'), inBatch('failed'), job(), job()]
    const header = deriveHeader(state(jobs, { run: running({ progress: { percent: 46, etaSec: 1080, mediaSecPerSec: 3.4, aggregateSpeed: 5, bytesWritten: 0, elapsedMs: 600_000 } }), capabilities: CAPABILITIES }),
      { ...REVIEW, review: review({ counts: reportCounts({ jobs: 2, ready: 2, blocked: 0 }) }) })
    expect(header).toMatchObject({
      title: 'Batch 31',
      subject: 'run',
      attention: { count: 1 },
      action: { kind: 'append', label: 'Append 2 jobs to Batch 31', enabled: true },
      slot: { kind: 'append' },
      brass: 'slot',
      controls: { pause: { label: 'Pause' }, cancel: { label: 'Cancel run' } },
      consequence: { kind: 'progress', percentText: '46%', timeLeft: 'about 18 min left', throughput: '3.4x realtime' },
      output: { locked: true },
      workers: { label: '16 workers · 0 active' }
    })
    expect(header.sentence.full).toBe(`2 of 3 finished · 2 new jobs waiting · 1 needs attention`)
    expect(header.sentence.full).not.toContain(M)
  })
})
