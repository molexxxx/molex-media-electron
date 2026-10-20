/**
 * The engine's composition root: one `createJobEngine(deps)` builds the core, the scheduler, the command modules, and
 * recovery over injected seams, with no module globals and no real time. `init` loads and recovers before any command
 * is accepted, so the first snapshot is already recovered.
 */

import { join } from 'node:path'
import { findLoudnessPreset } from '../../shared/audio/presets'
import type { CommandError, CommandResult, JobCommandName, JobCommandRequest, JobCommandResponse } from '../../shared/jobs/contract'
import { describeRecipe } from '../../shared/jobs/describe'
import { formatRunId, parseRunId, type JobId, type RunId } from '../../shared/jobs/ids'
import { presetLookup, presetSeed } from '../../shared/jobs/presets'
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  type BatchPolicy,
  type BatchSummary,
  type CapabilitySummary,
  type EngineSnapshot,
  type FrozenPolicy,
  type HistoryRecord,
  type Job,
  type JobErrorCode,
  type JobMeasurement,
  type JobPlan,
  type JobResult,
  type JobState,
  type JobWarning,
  type PreflightReport,
  type ResultStamp,
  type RunAlert,
  type RunSettings,
  type RunState,
  type WorkersState
} from '../../shared/jobs/types'
import type { JobsConfig } from '../config'
import { worstOutcome } from '../ffmpeg/audio/job'
import type { TimerHandle } from '../timers'
import { AlbumTasks, type AlbumTaskDeps } from './album'
import { AnalysisTasks, type AnalysisTaskDeps } from './analysis'
import { createJobEventBus, type DraftEvent, type JobEventBus } from './bus'
import type { CommandContext, CommandTarget } from './command-gate'
import { createHistoryCommands, type CommandOrigin, type HistoryCommands } from './commands/history'
import { createJobCommands, keepMode, type JobCommands } from './commands/jobs'
import { createPlanCommands, createPlanSummaries, type PlanCommands } from './commands/plan'
import { createPresetCommands, openPresetStore, type PresetCommands } from './commands/presets'
import { createQueueCommands, type ClipboardContent, type QueueCommands } from './commands/queue'
import { createReportStore, createRunCommands, localDateOf, type RunCommands } from './commands/run'
import { createEngineCore, idleRun, persistedJob, replayJournal, type CoreStateBody, type EngineCore, type QuitInputs, type RunEnding } from './core'
import type { JobEngineDeps, PlannerIO } from './deps'
import { workerLimits } from './dispatch'
import { createFinalizer, type FinalizeResult, type Finalizer, type KeptWarning } from './finalize'
import { createTrash, type TrashWrapper } from './fsops'
import { GpuBudget, type GpuVendor } from './gpu-budget'
import { buildBatchSummary, buildHistoryRecord, isRecordState, RunHistory, type HistoryFs } from './history'
import type { AttemptRing, EngineLogger } from './log'
import { pathKey } from './naming'
import { COUNTER_BLOCK, JobStore, jobsPaths, type JournalEntry, type PersistenceAlert, type StoreLimits } from './persistence'
import { planPreflight, type AlbumGroup, type PlanJob, type PlannerCapabilities, type PreflightInput, type ProbeOutcome, type RunnerSet } from './planner'
import { defaultPresetState, type PresetStore } from './presets-store'
import type { JobProbeQueue } from './probe-queue'
import { JobQueue, type JobChange } from './queue'
import { recoverEngine, type RecoveredPlacement, type Recovery } from './recovery'
import { createRunProgressFeed, type RunProgressFeed } from './run-progress'
import { audioWarnings } from './runners/audio'
import type { OutputArtifact } from './runners/types'
import type { ScanFs } from './scan'
import { createScheduler, engineError, RECHECK_MS, type ResultInput, type Scheduler } from './scheduler'
import { firstReturnedNotification, runEndedNotification, shouldNotifyFirstReturned } from './status'
import { Tombstones } from './tombstones'
import { REACHABLE_TIMEOUT_MS, volumeLabel, type VolumeRegistry } from './volumes'
import { WorkDirRegistry, type WorkDirEntry, type WorkDirFiles } from './workdirs'

/** Failures that an unreachable source volume explains better than the process did. */
const OFFLINE_CODES: ReadonlySet<JobErrorCode> = new Set<JobErrorCode>(['ffmpeg-failed', 'decode-errors', 'probe-failed', 'source-missing', 'measure-failed'])

function isTerminal(state: JobState): boolean
{
  return TERMINAL_STATES.includes(state)
}

/** How the engine stops: a quit writes the final state, a session end appends synchronously and never compacts. */
export type ShutdownMode = 'quit' | 'session-end'

/** The `jobs` config key as the engine reads and writes it. */
export interface EngineConfig
{
  /** The key as stored when the engine starts, migrated. */
  jobs: JobsConfig
  /** Writes part of the key. */
  persist(change: Partial<Omit<JobsConfig, 'pendingAlerts'>>): Promise<void>
}

/** The parts of the engine a runner set is built over, such as the analysis tasks the audio runners share. */
export interface EngineParts
{
  analyses: AnalysisTasks
}

/** The host's file manager, clipboard, and dialogs, as the commands use them. */
export interface EngineShell
{
  showItemInFolder(path: string): void
  readClipboard(): ClipboardContent | Promise<ClipboardContent>
  /** The report save dialog parented to the sender's window; null when it is canceled. */
  chooseSavePath(defaultPath: string, origin: CommandOrigin): Promise<string | null>
  exists(path: string): Promise<boolean>
  /** An attempt log file's text; null when it cannot be read. */
  readLog(path: string): Promise<string | null>
}

/** The audio analysis that previews and album groups run. */
export interface EngineAudio
{
  analyze: AnalysisTaskDeps['analyze']
  plan: AnalysisTaskDeps['plan']
  albumPlan: AlbumTaskDeps['plan']
}

/** Everything the composition root takes: the engine seams plus what its command modules and stores need. */
export interface EngineDeps extends Omit<JobEngineDeps, 'probe' | 'runners'>
{
  /** The runners, or a builder that receives the engine parts they share. */
  runners: RunnerSet | ((parts: EngineParts) => RunnerSet)
  probe: JobProbeQueue
  /** The session's volume registry: keys, roots, kinds, and Recycle Bins. */
  volumes: VolumeRegistry
  config: EngineConfig
  /** The capability summary the engine starts with. */
  capabilities: CapabilitySummary
  /** What the planner knows of FFmpeg beyond the summary. */
  plannerCapabilities(): Pick<PlannerCapabilities, 'build' | 'minimumVersion'>
  audio: EngineAudio
  shell: EngineShell
  historyFs: HistoryFs
  /** The marker files of work folders; the registry's Node default when absent. */
  workDirFiles?: WorkDirFiles
  /** The folder reads of scans; Node's when absent. */
  scanFs?: ScanFs
  /** Logical cores, for the automatic worker count. */
  cores: number
  pid: number
  appVersion: string
  /** A plain stat for the recovery reachability checks. */
  stat(path: string): Promise<unknown>
  storeLimits?: Partial<StoreLimits>
}

/** The engine as the IPC layer and the app lifecycle see it. */
export interface JobEngine extends CommandTarget
{
  /** Loads, recovers, and opens the stores; commands before it resolves are refused. */
  init(): Promise<void>
  command<K extends JobCommandName>(name: K, req: JobCommandRequest<K>, ctx: CommandContext): Promise<CommandResult<JobCommandResponse<K>>>
  snapshot(): EngineSnapshot
  isBusy(): boolean
  /** Replaces the capability summary and re-plans queued jobs it left stale. */
  setCapabilities(capabilities: CapabilitySummary): Promise<void>
  /** What the quit guard and its dialog read. */
  quitInputs(): QuitInputs
  /** The quit dialog's "Quit when idle"; the host quits once the run is over and nothing is active. */
  setQuitWhenIdle(value: boolean): void
  /** Selects a job or run in the batch view after a notification click (`ui.focus`). */
  focus(jobId: JobId | null, runId: RunId | null): void
  shutdown(mode: ShutdownMode): Promise<void>
  /** Writes `state.json` now and compacts the journal. */
  persistNow(reason: string): Promise<void>
}

/** A refused command with no details. */
export function engineRefusal(code: CommandError['code'], message: string): { ok: false; error: CommandError }
{
  return { ok: false, error: { code, message, issues: [], details: null } }
}

function fileName(path: string): string
{
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/** The warnings a done job keeps beyond the placement's: audio verification messages and a larger output. */
export function outcomeWarnings(job: Pick<Job, 'recipe' | 'source'>, input: Pick<ResultInput, 'artifact'> & { verification: ResultInput['job']['verification'] }): JobWarning[]
{
  const warnings: JobWarning[] = []
  if ((job.recipe.kind === 'normalize' || job.recipe.kind === 'boost') && input.verification !== null)
  {
    warnings.push(...audioWarnings(input.verification))
  }
  if (input.verification?.verdict === 'outside-tolerance')
  {
    warnings.push({ code: 'outside-tolerance-placed', short: 'Outside tolerance', message: 'The output was placed although its check is outside the tolerance.' })
  }
  if (job.recipe.kind === 'compress' && input.artifact.bytes > job.source.size)
  {
    warnings.push({ code: 'larger-than-source', short: 'Larger than source', message: 'The output is larger than the source.' })
  }
  return warnings
}

/** The stamp fields a Normalize or Gain job takes from its verdict stream. */
export type AudioStampFields = Pick<ResultStamp, 'verdictStream' | 'loudness' | 'truePeak'>

const NO_AUDIO_STAMP: AudioStampFields = { verdictStream: null, loudness: null, truePeak: null }

/**
 * The verdict stream's loudness and true peak, the worst stream as `worstOutcome` ranks them, so the row stamp, the
 * summary's checks, and the strip plot read the values Verify judged. The check class comes from the stream's
 * ceiling, and the deviation unit from the preset as the Verify messages word it. All null for other operations.
 */
export function audioStampFields(job: Pick<Job, 'recipe' | 'measurement' | 'plan'>, verification: Job['verification']): AudioStampFields
{
  const recipe = job.recipe
  const audio = verification?.audio ?? []
  if ((recipe.kind !== 'normalize' && recipe.kind !== 'boost') || audio.length === 0)
  {
    return NO_AUDIO_STAMP
  }
  const worst = worstOutcome(audio.map((stream) => stream.verdict))
  const { verdict, verified } = audio.find((stream) => stream.verdict.outcome === worst) ?? audio[0]
  const index = verdict.audioIndex
  const ceiling = job.measurement?.streams.find((stream) => stream.plan?.audioIndex === index)?.plan?.ceiling ??
    job.plan?.audio.find((stream) => stream.audioIndex === index)?.ceiling ?? null
  const lufs = verified?.integratedLufs ?? null
  const dbtp = verified?.truePeakDbtp ?? null
  const normalize = recipe.kind === 'normalize'
  return {
    verdictStream: index,
    loudness: lufs === null
      ? null
      : {
        lufs,
        unit: normalize ? recipe.target.unit : 'LUFS',
        reference: verdict.loudness.reference,
        referenceLufs: verdict.loudness.referenceLufs,
        deviation: verdict.loudness.deviationLu,
        deviationUnit: normalize ? findLoudnessPreset(recipe.presetId)?.deviationUnit ?? 'LU' : 'LU',
        check: verdict.loudness.toleranceLu,
        checkClass: ceiling?.outputClass === 'lossless' ? 'lossless' : 'lossy',
        status: verdict.loudness.status
      },
    truePeak: dbtp === null
      ? null
      : {
        dbtp,
        preEncodeDbtp: verified?.preEncodeTruePeakDbtp ?? null,
        limitDbtp: verdict.truePeak.gateDbtp,
        status: verdict.truePeak.status === 'over' ? 'over' : 'within'
      }
  }
}

/** A done job's result and row stamp from its artifact, verification, and placement. */
export function buildJobResult(input: ResultInput): JobResult
{
  const { job, artifact, placed, notes, elapsedMs } = input
  const verification = job.verification
  const extra = outcomeWarnings(job, { artifact, verification })
  const warnings = [...input.warnings, ...extra.filter((w) => !input.warnings.some((have) => have.code === w.code))]
  const media = verification?.media ?? null
  const stamp: ResultStamp = {
    verdict: verification?.verdict ?? 'verified',
    outputName: fileName(placed.finalPath),
    container: artifact.container,
    inputBytes: job.source.size,
    outputBytes: artifact.bytes,
    durationSec: artifact.durationSec,
    decode: media?.decode ?? (verification?.audio ? 'full' : null),
    audioStreams: verification?.audio?.length ?? artifact.encoder.audio.length,
    ...audioStampFields(job, verification),
    size: media !== null && media.size.targetBytes !== null && media.size.status !== 'not-checked'
      ? { targetBytes: media.size.targetBytes, status: media.size.status }
      : null,
    frames: media?.frames ?? null,
    cues: media?.cues ?? null,
    placement: placed.placement.kind,
    warnings: warnings.length
  }
  return {
    outputPath: placed.finalPath,
    outputKind: artifact.kind,
    container: artifact.container,
    inputBytes: job.source.size,
    outputBytes: artifact.bytes,
    durationSec: artifact.durationSec,
    elapsedMs,
    encoder: artifact.encoder,
    placement: placed.placement,
    stamp,
    warnings,
    notes
  }
}

/** What the engine builds in `init`, once the state is loaded. */
interface Parts
{
  core: EngineCore
  registry: WorkDirRegistry
  recovery: Recovery
  scheduler: Scheduler
  budget: GpuBudget
  albums: AlbumTasks
  analyses: AnalysisTasks
  runners: RunnerSet
  trash: TrashWrapper
  finalizer: Finalizer
  history: RunHistory
  presets: PresetStore
  tombstones: Tombstones
  queueCommands: QueueCommands
  planCommands: PlanCommands
  runCommands: RunCommands
  jobCommands: JobCommands
  historyCommands: HistoryCommands
  presetCommands: PresetCommands
  progress: RunProgressFeed
}

/** The GPU budget's encoder family for the detected vendor. */
export function gpuVendor(capabilities: Pick<CapabilitySummary, 'gpu'>): GpuVendor | null
{
  switch (capabilities.gpu.vendor)
  {
    case 'nvidia':
      return 'nvenc'
    case 'intel':
      return 'qsv'
    case 'amd':
      return 'amf'
    default:
      return null
  }
}

/** The state a first start or an unreadable snapshot begins from: the `jobs` config key and an empty queue. */
export function initialBody(jobs: Pick<JobsConfig, 'policy' | 'defaultRecipe'>): CoreStateBody
{
  return { policy: jobs.policy, defaultRecipe: jobs.defaultRecipe, run: idleRun(), order: [], jobs: [] }
}

/** A persistence problem as the run alert the page shows. */
export function persistenceRunAlert(alert: PersistenceAlert, at: number): RunAlert
{
  const messages: Readonly<Record<PersistenceAlert['cause'], string>> =
  {
    'write-failed': `The queue could not be saved${alert.code === null ? '' : ` (${alert.code})`}. Work that needs a saved step waits until saving works again.`,
    'compaction-failed': 'The queue file could not be compacted. molexMedia keeps trying.',
    'queue-dropped': 'Unsaved queue changes grew too large and were dropped; the next save writes the whole queue.',
    'corrupt-state': 'The saved queue could not be read, so it was set aside and the queue starts empty.',
    'newer-schema': 'The queue was saved by a newer version of molexMedia. This version keeps its own queue file beside it.'
  }
  return {
    id: `persistence:${alert.cause}`,
    kind: alert.kind,
    severity: alert.cause === 'newer-schema' ? 'info' : alert.cause === 'corrupt-state' || alert.cause === 'compaction-failed' ? 'warning' : 'error',
    message: messages[alert.cause],
    volume: null,
    path: alert.movedAside[0] ?? null,
    jobIds: [],
    counts: null,
    dismissible: alert.cause !== 'write-failed',
    at
  }
}

/** The idle worker state for a setting. */
export function idleWorkers(setting: RunSettings['workers'], cores: number, gpuLimit: number): WorkersState
{
  return {
    setting,
    limits: workerLimits(setting, cores, gpuLimit),
    active: { total: 0, videoCpu: 0, gpu: 0, analysis: 0, starting: 0 }
  }
}

/** Album groups by the group id their plans carry, members in queue order. */
export function albumGroupsOf(jobs: ReadonlyArray<Readonly<Job>>): AlbumGroup[]
{
  const groups = new Map<string, JobId[]>()
  for (const job of jobs)
  {
    const groupId = job.plan?.album?.groupId ?? null
    if (groupId !== null && !isTerminal(job.state))
    {
      groups.set(groupId, [...(groups.get(groupId) ?? []), job.id])
    }
  }
  return [...groups].map(([groupId, jobIds]) => ({ groupId, jobIds }))
}

/** Builds one engine over its seams. */
export function createJobEngine(deps: EngineDeps): JobEngine
{
  const { timers, platform, log, host } = deps
  const now = (): number => timers.now()
  const dir = join(deps.paths.userData, 'jobs')
  const paths = jobsPaths(dir)
  let jobsConfig: JobsConfig = deps.config.jobs
  let parts: Parts | null = null
  let starting: Promise<void> | null = null
  let quitting = false
  let ended = false
  let pendingBody: CoreStateBody = initialBody(jobsConfig)
  const earlyAlerts: RunAlert[] = []
  const summaries = createPlanSummaries()
  const reports = createReportStore()
  const measurements = new Map<string, JobMeasurement>()
  const heldOutputs = new Map<JobId, string>()
  let catalogTopUp: Promise<void> | null = null
  let runTopUp: Promise<void> | null = null
  let lastRunSeq = 0
  let historyRun: RunId | null = null
  let historyChain: Promise<unknown> = Promise.resolve()
  let sweepQueued = false
  let recheckTimer: TimerHandle | null = null
  let notifiedFailure: RunId | null = null

  const innerBus = createJobEventBus({ timers, log })
  const bus: JobEventBus =
  {
    emit(event)
    {
      innerBus.emit(event)
      observe(event)
    },
    flush: () => innerBus.flush(),
    lastSeq: () => innerBus.lastSeq(),
    subscribe: (sender, clientId, build) => innerBus.subscribe(sender, clientId, build),
    unsubscribe: (senderId, clientId) => innerBus.unsubscribe(senderId, clientId),
    registrations: () => innerBus.registrations(),
    dispose: () => innerBus.dispose()
  }

  const store = new JobStore<CoreStateBody, JournalEntry>({
    io: deps.store,
    dir,
    platform,
    timers,
    log,
    pid: deps.pid,
    snapshot: () => (parts === null ? pendingBody : parts.core.persisted()),
    isIdle: () => parts === null || !parts.core.isBusy(),
    onAlert: (alert) => raise(persistenceRunAlert(alert, now())),
    onWritable: () => writable(),
    limits: deps.storeLimits
  })

  const queue = new JobQueue({
    numbers: {
      available: () => store.available('catalog'),
      take: () =>
      {
        const value = store.take('catalog')
        if (store.available('catalog') < COUNTER_BLOCK / 2)
        {
          topUpCatalog()
        }
        return value
      }
    },
    now
  })

  function errorText(err: unknown): string
  {
    return err instanceof Error ? err.message : String(err)
  }

  function need(): Parts
  {
    if (parts === null)
    {
      throw new Error('The job engine is not initialized.')
    }
    return parts
  }

  function raise(alert: RunAlert): void
  {
    if (parts === null)
    {
      earlyAlerts.push(alert)
      return
    }
    parts.core.raiseAlert(alert)
  }

  function topUpCatalog(): void
  {
    if (catalogTopUp !== null || ended)
    {
      return
    }
    catalogTopUp = store.reserve('catalog', COUNTER_BLOCK)
      .catch((err) => log.warn(`No catalog numbers could be reserved: ${errorText(err)}`))
      .finally(() =>
      {
        catalogTopUp = null
      })
  }

  function topUpRuns(): void
  {
    if (runTopUp !== null || ended)
    {
      return
    }
    runTopUp = store.reserve('run', 1)
      .catch((err) => log.warn(`No run numbers could be reserved: ${errorText(err)}`))
      .finally(() =>
      {
        runTopUp = null
      })
  }

  /** The next run id: the reserved block first, else one past the highest seen, so a start never waits on storage. */
  function nextRunId(): RunId
  {
    const taken = store.take('run')
    const seq = taken ?? lastRunSeq + 1
    if (taken === null)
    {
      log.warn(`Run ${formatRunId(seq)} was numbered without a reserved block.`)
      store.observe('run', seq)
    }
    lastRunSeq = Math.max(lastRunSeq, seq)
    topUpRuns()
    return formatRunId(seq)
  }

  function observeRun(runId: RunId | null | undefined): void
  {
    const seq = runId === null || runId === undefined ? null : parseRunId(runId)
    if (seq !== null)
    {
      store.observe('run', seq)
      lastRunSeq = Math.max(lastRunSeq, seq)
    }
  }

  function persist(change: Partial<Omit<JobsConfig, 'pendingAlerts'>>): Promise<void>
  {
    jobsConfig = { ...jobsConfig, ...change }
    return deps.config.persist(change)
  }

  /** Protects the work folders of active and held executions and of claims whose checks are running. */
  function protectEntry(entry: WorkDirEntry): boolean
  {
    const core = parts?.core
    const job = core?.queue.get(entry.jobId)
    if (core === undefined || job === undefined)
    {
      return false
    }
    if (core.isClaimed(job.id))
    {
      return entry.execution >= job.execution
    }
    return (ACTIVE_STATES.includes(job.state) || job.state === 'held') && entry.execution === job.execution
  }

  function scheduleSweep(): void
  {
    if (sweepQueued || parts === null || ended)
    {
      return
    }
    sweepQueued = true
    queueMicrotask(() =>
    {
      sweepQueued = false
      if (parts !== null && !ended)
      {
        void parts.registry.sweep(protectEntry).catch((err) => log.warn(`The work folder sweep failed: ${errorText(err)}`))
      }
    })
  }

  async function removeWorkDir(workDir: string): Promise<boolean>
  {
    const report = await need().registry.sweep(() => false, (entry) => entry.path === workDir)
    return report.pending === 0
  }

  function recipeLabel(job: Readonly<Job>): string
  {
    return job.recipe.userPreset?.name ?? describeRecipe(job.recipe)
  }

  function recordOf(job: Readonly<Job>): HistoryRecord
  {
    const logFile = job.runId === null ? null : paths.attemptLog(job.runId, job.id, job.attempt)
    return buildHistoryRecord(persistedJob(job), { recipeLabel: recipeLabel(job), logFile, endedAt: job.endedAt ?? now() })
  }

  function chainHistory<T>(step: () => Promise<T>): Promise<T>
  {
    const next = historyChain.then(step)
    historyChain = next.catch((err) => log.warn(`Run history could not be written: ${errorText(err)}`))
    return next
  }

  function appendRecord(id: JobId): void
  {
    const history = parts?.history
    const job = parts?.core.queue.get(id)
    if (history === undefined || job === undefined)
    {
      return
    }
    const record = recordOf(job)
    void chainHistory(async () =>
    {
      const ref = await history.appendRecord(record)
      const live = parts?.core.queue.get(id)
      if (live !== undefined && live.attempt === record.attempt)
      {
        parts?.core.update(id, { history: ref })
      }
    })
  }

  /** Records a decision on a held job whose run already completed, and rewrites that run's index entry. */
  function recordDecision(id: JobId): void
  {
    const history = parts?.history
    const job = parts?.core.queue.get(id)
    if (history === undefined || job === undefined)
    {
      return
    }
    const record = recordOf(job)
    void chainHistory(async () =>
    {
      const ref = await history.recordDecision(record)
      if (parts?.core.queue.get(id)?.attempt === record.attempt)
      {
        parts?.core.update(id, { history: ref })
      }
    })
  }

  /** Lands what other modules owe a job event: history records, held outputs, warnings, sweeps, and notifications. */
  function observe(event: DraftEvent): void
  {
    if (parts === null)
    {
      return
    }
    parts.progress.observe(event)
    if (event.type === 'job.removed')
    {
      summaries.forget(event.jobId)
      heldOutputs.delete(event.jobId)
      measurements.delete(event.jobId)
      scheduleSweep()
      return
    }
    if (event.type === 'run.state')
    {
      onRunState(event.run)
      return
    }
    if (event.type !== 'job.state')
    {
      return
    }
    const job = parts.core.queue.get(event.jobId)
    if (job === undefined)
    {
      return
    }
    if (event.to === 'held' && job.hold !== null)
    {
      heldOutputs.set(job.id, job.hold.outputPath)
    }
    if (event.to === 'done')
    {
      heldOutputs.delete(job.id)
      queueMicrotask(() => mergeWarnings(job.id))
    }
    if (isRecordState(event.to) && event.to !== 'held' && job.runId !== null && job.runId === historyRun)
    {
      appendRecord(job.id)
    }
    if (event.to === 'failed')
    {
      notifyFirstFailure(job)
      queueMicrotask(() =>
      {
        void sourceOffline(job.id)
      })
    }
    if (!ACTIVE_STATES.includes(event.to))
    {
      scheduleSweep()
    }
  }

  /** Names a failure whose source volume no longer answers `source-offline`, since the decode error may be the connection. */
  async function sourceOffline(id: JobId): Promise<void>
  {
    const job = parts?.core.queue.get(id)
    if (job === undefined || job.error === null || !OFFLINE_CODES.has(job.error.code))
    {
      return
    }
    const root = await deps.volumes.root(job.source.path).catch(() => null)
    const reachable = root === null ? true : await deps.planner.reachable(root, REACHABLE_TIMEOUT_MS).catch(() => false)
    const live = parts?.core.queue.get(id)
    if (reachable || root === null || live === undefined || live.state !== 'failed' || live.attempt !== job.attempt || live.error === null)
    {
      return
    }
    parts?.core.update(id, {
      error: {
        ...live.error,
        code: 'source-offline',
        short: 'Source offline',
        message: `${volumeLabel(root, platform)} did not answer after the failure, so the source may have gone offline: ${live.error.message}`,
        hint: 'Reconnect the volume, then retry.'
      }
    })
  }

  /** Copies the result's outcome warnings, such as an audio overshoot, onto the done job's own warnings. */
  function mergeWarnings(id: JobId): void
  {
    const job = parts?.core.queue.get(id)
    if (job === undefined || job.state !== 'done' || job.result === null)
    {
      return
    }
    const missing = job.result.warnings.filter((w) => !job.warnings.some((have) => have.code === w.code))
    if (missing.length > 0)
    {
      parts?.core.update(id, { warnings: [...job.warnings, ...missing] })
    }
  }

  function notifyFirstFailure(job: Readonly<Job>): void
  {
    const settings = parts?.core.globals().settings
    if (settings === undefined || job.runId === null || notifiedFailure === job.runId || !settings.notify.firstFailure)
    {
      return
    }
    if (shouldNotifyFirstReturned({ enabled: true, alreadyNotified: false, window: host.mainWindow() }))
    {
      notifiedFailure = job.runId
      host.notify(firstReturnedNotification({ id: job.id, runId: job.runId, fileName: job.source.name }, job.error?.short ?? 'Failed'))
    }
  }

  function onRunState(run: RunState): void
  {
    deps.probe.setRunning(run.status === 'running' || run.status === 'pausing')
    if (run.runId !== null && run.runId !== historyRun && run.status !== 'idle')
    {
      const runId = run.runId
      const startedAt = run.startedAt ?? now()
      historyRun = runId
      observeRun(runId)
      parts?.budget.runStarted()
      void chainHistory(() => need().history.startRun(runId, startedAt))
    }
    if (run.status === 'idle' && run.quitWhenIdle && parts !== null && !parts.core.isBusy() && !quitting)
    {
      host.quit()
    }
  }

  /** Builds the summary at completion from every job the run touched, and closes the run in history. */
  function summarize(ending: RunEnding): BatchSummary
  {
    const records = ending.jobs.filter((job) => isRecordState(job.state)).map((job) => recordOf(job))
    const capabilities = parts?.core.globals().capabilities ?? deps.capabilities
    const policy = (ending.jobs.find((job) => job.policy !== null)?.policy ?? frozenNow()) as FrozenPolicy
    const summary = buildBatchSummary({
      runId: ending.runId,
      startedAt: ending.startedAt,
      endedAt: ending.endedAt,
      endedBy: ending.endedBy,
      interruptions: ending.interruptions,
      policy,
      ffmpeg: { version: capabilities.ffmpeg.version ?? 'unknown', source: capabilities.ffmpeg.source ?? 'path' },
      appVersion: deps.appVersion
    }, records)
    const held = ending.jobs.filter((job) => job.state === 'held').map((job) => job.id)
    queueMicrotask(() => completeRun(summary, held))
    return summary
  }

  function frozenNow(): FrozenPolicy
  {
    const policy = parts?.core.globals().policy ?? jobsConfig.policy
    return { ...policy, frozenAt: now(), date: localDateOf(now()) }
  }

  function completeRun(summary: BatchSummary, held: JobId[]): void
  {
    for (const id of held)
    {
      appendRecord(id)
    }
    if (historyRun === summary.runId)
    {
      historyRun = null
    }
    void chainHistory(() => need().history.completeRun(summary))
    store.runCompleted()
    const settings = parts?.core.globals().settings
    if (settings?.notify.completion === true)
    {
      host.notify(runEndedNotification(summary))
    }
  }

  function writable(): void
  {
    const core = parts?.core
    if (core === undefined)
    {
      return
    }
    for (const alert of core.alerts())
    {
      if (alert.id === 'persistence:write-failed')
      {
        core.clearAlert(alert.id)
      }
    }
    for (const job of core.queue.jobs())
    {
      if (job.state === 'held' && job.hold?.reason === 'storage-unavailable')
      {
        const outputPath = job.hold.outputPath
        const moved = core.transition(job.id, ['held'], 'keep', { reason: 'engine', begin: { verdict: job.verification?.verdict ?? null, mode: keepMode(job, 'planned') } })
        if (moved.applied)
        {
          heldOutputs.set(job.id, outputPath)
          void placeHeld(job.id, 'planned')
        }
      }
    }
    topUpCatalog()
  }

  function artifactOf(job: Readonly<Job>, outputPath: string, bytes: number): OutputArtifact
  {
    const plan = job.plan as JobPlan
    return {
      kind: plan.output.kind,
      path: outputPath,
      container: plan.output.container,
      bytes,
      durationSec: job.media?.durationSec ?? null,
      encoder: { video: plan.video?.encoder ?? null, audio: plan.audio.map((stream) => stream.encoder) }
    }
  }

  /** Places a held output that moved to finalizing (T26), from the job's frozen plan and its work folder. */
  async function placeHeld(id: JobId, placement: 'planned' | 'renamed'): Promise<void>
  {
    const { core, finalizer } = need()
    const job = core.queue.get(id)
    if (job === undefined || job.state !== 'finalizing' || job.plan === null || job.policy === null || job.workDir === null)
    {
      return
    }
    const outputPath = heldOutputs.get(id) ?? job.hold?.outputPath ?? null
    if (outputPath === null)
    {
      core.transition(id, ['finalizing'], 'fail', { change: { error: engineError('held-output-missing', 'The held output is no longer known.', 'place', job.attempt, now()) } })
      return
    }
    const output = placement === 'renamed' ? { ...job.plan.output, resolution: 'rename' as const, renamedTo: null } : job.plan.output
    const startedAt = now()
    let placed: FinalizeResult
    try
    {
      placed = await finalizer.place({
        jobId: id,
        execution: job.execution,
        transition: 'T26',
        verdict: job.verification?.verdict ?? null,
        output,
        policy: job.policy,
        source: job.source.path,
        outputPath,
        workDir: job.workDir,
        isReserved: (target) => core.queue.jobs().some((other) => other.id !== id && other.plan !== null && (other.state === 'queued' || other.state === 'held' || ACTIVE_STATES.includes(other.state)) &&
          (other.plan.output.finalPath === target || other.plan.output.renamedTo === target)),
        onWaitLock: () => core.stage(id, { id: 'wait-lock', pass: 1, passes: 1, label: 'Waiting for a locked file', startedAt: now() })
      })
    }
    catch (err)
    {
      core.transition(id, ['finalizing'], 'fail', { change: { error: engineError('internal', `Placement failed: ${errorText(err)}`, 'place', job.attempt, now()) } })
      return
    }
    if (placed.status === 'held')
    {
      const actions: Array<'keep' | 'keep-renamed' | 'discard' | 'retry'> = placed.reason === 'destination-appeared' ? ['keep-renamed', 'discard', 'retry'] : ['keep', 'discard', 'retry']
      core.transition(id, ['finalizing'], 'hold', {
        reason: placed.reason,
        change: { hold: { reason: placed.reason, message: placed.message, outputPath: placed.outputPath, displaces: placed.displaces, actions, since: now() } }
      })
      return
    }
    const stat = await deps.planner.stat(placed.finalPath).catch(() => null)
    const current = core.queue.get(id) as Readonly<Job>
    const warnings = keptWarnings(placed.warnings)
    const result = buildJobResult({ job: current, artifact: artifactOf(current, placed.finalPath, stat?.size ?? 0), placed, warnings, notes: [], elapsedMs: now() - startedAt })
    const moved = core.transition(id, ['finalizing'], 'placed', { change: { result, warnings: result.warnings } })
    if (moved.applied && current.runId !== historyRun)
    {
      recordDecision(id)
    }
  }

  function keptWarnings(codes: readonly KeptWarning[]): JobWarning[]
  {
    return codes.map((code) => (code === 'original-kept'
      ? { code, short: 'Original kept', message: 'The original could not go to the Recycle Bin, so it was kept beside the output.' }
      : { code, short: 'Previous kept', message: 'The previous output could not go to the Recycle Bin, so it was kept beside the new one.' }))
  }

  /** The change T32 records for a placement recovery found complete or finished itself. */
  function recoveredChange(job: Readonly<Job>, placed: RecoveredPlacement): JobChange
  {
    const warnings = keptWarnings(placed.warnings)
    if (job.plan === null)
    {
      return { warnings }
    }
    const result = buildJobResult({
      job,
      artifact: artifactOf(job, placed.finalPath, job.result?.outputBytes ?? 0),
      placed: { status: 'done', finalPath: placed.finalPath, placement: placed.placement, warnings: placed.warnings, previous: placed.previous, copied: false, workDirRemoved: false },
      warnings,
      notes: [],
      elapsedMs: 0
    })
    return { result, warnings: result.warnings }
  }

  async function probeOutcome(job: Readonly<Job>): Promise<ProbeOutcome>
  {
    try
    {
      return { status: 'ok', facts: await deps.probe.probe(job.source.path) }
    }
    catch (err)
    {
      return { status: 'failed', reason: errorText(err) }
    }
  }

  /** The internal preflight of a retry: exactly these jobs, their current settings, and the current policy. */
  async function retryPreflight(jobs: ReadonlyArray<Readonly<Job>>, options: { existing: ReadonlyMap<JobId, string> }): Promise<PreflightReport>
  {
    const { core, runners } = need()
    const globals = core.globals()
    const covered = new Set(jobs.map((job) => job.id))
    const planJobs: PlanJob[] = await Promise.all(jobs.map(async (job) => ({ id: job.id, inputsRev: job.inputsRev, source: job.source, recipe: job.recipe, probe: await probeOutcome(job) })))
    const existing = new Set(options.existing.values())
    const io: PlannerIO = existing.size === 0 ? deps.planner : {
      ...deps.planner,
      stat: async (path) => (await deps.planner.stat(path)) ?? (existing.has(path) ? { size: 0, mtimeMs: 0, isFile: true, isDirectory: false, dev: '0', ino: '0' } : null)
    }
    const input: PreflightInput = {
      preflightId: deps.ids.preflightId(),
      createdAt: now(),
      platform,
      policy: globals.policy,
      capabilities: { ...deps.plannerCapabilities(), summary: globals.capabilities },
      jobs: planJobs,
      others: core.queue.jobs().filter((job) => !covered.has(job.id) && !isTerminal(job.state))
        .map((job) => ({ id: job.id, sourcePath: job.source.path, reservedPath: job.plan === null ? null : job.plan.output.renamedTo ?? job.plan.output.finalPath })),
      albums: albumGroupsOf(core.queue.jobs()),
      limits: globals.workers.limits,
      date: localDateOf(now())
    }
    return (await planPreflight(input, { io, runners, volumeKey: (path) => deps.volumes.key(path) })).report
  }

  /** True when a file matches the output of a done job in the queue, so scans skip it. */
  function isPreviousOutput(file: { path: string; size: number; mtimeMs: number }): boolean
  {
    const key = pathKey(file.path, platform)
    return (parts?.core.queue.jobs() ?? []).some((job) => job.state === 'done' && job.result !== null &&
      pathKey(job.result.outputPath, platform) === key && job.result.outputBytes === file.size)
  }

  function ringOf(id: JobId): AttemptRing | null
  {
    const job = parts?.core.queue.get(id)
    const engineLog = log as Partial<EngineLogger>
    if (job === undefined || engineLog.ring === undefined || typeof engineLog.child !== 'function')
    {
      return null
    }
    return (log as EngineLogger).child({ jobId: id, runId: job.runId ?? undefined, attempt: job.attempt }).ring
  }

  function startRechecks(): void
  {
    if (recheckTimer !== null || ended || parts === null || parts.recovery.deferred().length === 0)
    {
      return
    }
    recheckTimer = timers.setTimeout(() =>
    {
      recheckTimer = null
      void recheck().finally(() => startRechecks())
    }, RECHECK_MS)
  }

  async function recheck(ids?: readonly JobId[]): Promise<void>
  {
    const recovery = parts?.recovery
    if (recovery === undefined || recovery.deferred().length === 0)
    {
      return
    }
    const wanted = ids === undefined ? undefined : ids.filter((id) => recovery.deferred().includes(id))
    if (wanted !== undefined && wanted.length === 0)
    {
      return
    }
    try
    {
      await recovery.recheck(wanted)
    }
    catch (err)
    {
      log.warn(`The recovery checks could not run again: ${errorText(err)}`)
    }
  }

  async function start(): Promise<void>
  {
    const loaded = await store.load()
    const empty = loaded.body === null
    const body = replayJournal(loaded.body ?? initialBody(jobsConfig), loaded.lines)
    pendingBody = body
    for (const job of body.jobs)
    {
      store.observe('catalog', job.seq)
      observeRun(job.runId)
    }
    observeRun(body.run.runId)
    queue.hydrate(body.jobs, body.order)
    const settings = jobsConfig.settings
    const budget = new GpuBudget({ timers, setting: settings.gpuSessions, vendor: gpuVendor(deps.capabilities), onChange: () => parts?.scheduler.trigger('gpu-freed') })
    const core = createEngineCore({
      queue,
      bus,
      journal: store,
      log,
      now,
      state: {
        policy: body.policy,
        settings,
        defaultRecipe: body.defaultRecipe,
        capabilities: deps.capabilities,
        workers: idleWorkers(settings.workers, deps.cores, budget.limit),
        presets: defaultPresetState(),
        recentFolders: jobsConfig.recentFolders,
        run: body.run,
        alerts: earlyAlerts.splice(0)
      },
      summarize,
      views: { planSummary: summaries.planSummary },
      detail: {
        ring: ringOf,
        history: (job) => (job.history === null || parts === null ? Promise.resolve(null) : parts.history.readRecord(job.history)),
        readLog: (path) => deps.shell.readLog(path),
        logsDir: paths.logs
      }
    })

    const registry = new WorkDirRegistry({ path: paths.workdirs, platform, io: deps.store, writer: store, fs: deps.fs, files: deps.workDirFiles, timers, ids: deps.ids, log })
    const workdirs = await registry.load({ emptyStart: empty && loaded.movedAside.length > 0, knownJob: (id) => queue.has(id) })
    if (workdirs.kept.length > 0)
    {
      log.info(`Kept ${workdirs.kept.length} work folders for this session after the queue could not be read.`)
    }
    const trash = createTrash({
      platform,
      timers,
      trash: deps.trash,
      volumes: deps.volumes,
      sizeOf: async (path) => (await deps.planner.stat(path).catch(() => null))?.size ?? null,
      log
    })
    const recovery = await recoverEngine({
      core,
      platform,
      fs: deps.fs,
      trash,
      volumes: deps.volumes,
      stat: deps.stat,
      timers,
      journal: { durable: (entries) => store.appendDurable(entries as unknown as JournalEntry[]) },
      flush: () => store.flush(),
      placed: recoveredChange,
      registry,
      compact: () => store.compact(),
      log
    }, { lines: loaded.lines, previous: loaded.previous })
    void recovery.report.sweep.then((report) =>
    {
      if (report !== null)
      {
        log.info(`Startup sweep: ${report.deleted} work folders deleted, ${report.pending} pending, ${report.kept} kept.`)
      }
    })

    const analyses = new AnalysisTasks({ analyze: deps.audio.analyze, plan: deps.audio.plan, onSettled: (outcome) => parts?.scheduler.analysisSettled(outcome) })
    const albums = new AlbumTasks({ analyze: (jobId, signal) => analyses.obtain(jobId, signal), plan: deps.audio.albumPlan, onSettled: (outcome) => parts?.scheduler.albumSettled(outcome) })
    const runners = typeof deps.runners === 'function' ? deps.runners({ analyses }) : deps.runners
    const finalizer = createFinalizer({
      platform,
      timers,
      fs: deps.fs,
      trash,
      journal: { durable: (entries) => store.appendDurable(entries as unknown as JournalEntry[]) },
      removeWorkDir,
      log
    })
    let planCommands: PlanCommands | null = null
    const scheduler = createScheduler({
      core,
      timers,
      ids: deps.ids,
      platform,
      runners,
      planner: deps.planner,
      volumes: deps.volumes,
      userDataVolume: await deps.volumes.key(deps.paths.userData),
      workdirs: registry,
      budget,
      albums,
      analysis: analyses,
      finalizer,
      ffmpeg: deps.ffmpeg,
      probe: deps.probe,
      cache: { get: (key) => measurements.get(key) ?? null, set: (key, measurement) => measurements.set(key, measurement) },
      cores: deps.cores,
      setPriority: (pid, priority) => deps.setPriority(pid, priority),
      replan: (job) => (planCommands === null ? Promise.resolve(null) : planCommands.replan(job)),
      result: buildJobResult,
      notify: (notification) => host.notify(notification),
      log
    })
    const progress = createRunProgressFeed({ core, mediaSecDone: (id) => scheduler.mediaSecDone(id) })

    const history = new RunHistory({ io: deps.store, fs: deps.historyFs, paths, store, openRun: () => historyRun })
    const tombstones = new Tombstones({ timers })
    const opened = await openPresetStore({ io: deps.store, path: paths.presets, now, seed: presetSeed(jobsConfig, now()), core })
    const presets = opened.store
    const presetCommands = createPresetCommands({ core, store: presets })
    planCommands = createPlanCommands({
      core,
      scheduler,
      reports,
      summaries,
      planner: { io: deps.planner, runners, volumeKey: (path) => deps.volumes.key(path) },
      capabilities: () => deps.plannerCapabilities(),
      probe: probeOutcome,
      albums: () => albumGroupsOf(core.queue.jobs()),
      analysis: analyses,
      platform,
      newId: () => deps.ids.preflightId(),
      persistPolicy: (policy) => persist({ policy: { ...policy, rev: core.globals().policy.rev } }),
      persistDefaultRecipe: (recipe) => persist({ defaultRecipe: recipe }),
      log,
      quitting: () => quitting
    })
    const queueCommands = createQueueCommands({
      core,
      tombstones,
      probes: deps.probe,
      replan: (job) => (planCommands as PlanCommands).replan(job),
      stat: (path) => deps.planner.stat(path),
      platform,
      isPreviousOutput,
      readClipboard: () => deps.shell.readClipboard(),
      scanFs: deps.scanFs,
      persistRecentFolders: (folders) => persist({ recentFolders: folders }),
      recordRecent: (recipes) => presetCommands.recordRecent(recipes),
      quitting: () => quitting
    })
    const runCommands = createRunCommands({
      core,
      scheduler,
      reports,
      stat: (path) => deps.planner.stat(path),
      nextRunId,
      savedPolicy: () => withoutRev(jobsConfig.policy),
      persistSettings: (next) => persist({ settings: next }),
      gpu: { limit: () => budget.limit, configure: (setting) => budget.configure(setting, gpuVendor(core.globals().capabilities)) },
      cores: deps.cores,
      showItemInFolder: (path) => deps.shell.showItemInFolder(path),
      keepAwake: (on) => host.setKeepAwake(on),
      quitting: () => quitting
    })
    const jobCommands = createJobCommands({
      core,
      scheduler,
      albums,
      preflight: retryPreflight,
      releaseWorkDir: (_jobId, workDir) =>
      {
        void removeWorkDir(workDir).catch((err) => log.warn(`The work folder ${workDir} could not be released: ${errorText(err)}`))
      },
      nextRunId,
      history: { recordDecision: (record) => chainHistory(() => history.recordDecision(record)) },
      place: (jobId, placement) =>
      {
        void placeHeld(jobId, placement)
      },
      tombstones,
      ring: ringOf,
      readLog: (path) => deps.shell.readLog(path),
      exists: (path) => deps.shell.exists(path),
      showItemInFolder: (path) => deps.shell.showItemInFolder(path),
      logsDir: paths.logs,
      quitting: () => quitting
    })
    const historyCommands = createHistoryCommands({
      core,
      history,
      paths,
      platform,
      stat: (path) => deps.planner.stat(path),
      presetLookup: () => presetLookup(presets.users()),
      chooseSavePath: (defaultPath, origin) => deps.shell.chooseSavePath(defaultPath, origin),
      probe: (ids) =>
      {
        void queueCommands.reprobe({ ids })
      },
      showItemInFolder: (path) => deps.shell.showItemInFolder(path),
      quitting: () => quitting,
      now
    })

    parts = {
      core, registry, recovery, scheduler, budget, albums, analyses, runners, trash, finalizer, history, presets, tombstones,
      queueCommands, planCommands, runCommands, jobCommands, historyCommands, presetCommands, progress
    }
    for (const job of queue.jobs())
    {
      if (job.state === 'held' && job.hold !== null)
      {
        heldOutputs.set(job.id, job.hold.outputPath)
      }
    }
    const run = core.run()
    if (run.status !== 'idle' && run.runId !== null)
    {
      historyRun = run.runId
    }
    const loadedHistory = await history.load()
    for (const entry of history.entries())
    {
      observeRun(entry.runId)
    }
    log.info(`Run history ${loadedHistory.status} with ${loadedHistory.runs} runs.`)
    void history.prune().catch((err) => log.warn(`Run history could not be pruned: ${errorText(err)}`))
    await Promise.all([
      store.reserve('catalog', COUNTER_BLOCK).catch((err) => log.warn(`No catalog numbers could be reserved: ${errorText(err)}`)),
      store.reserve('run', 1).catch((err) => log.warn(`No run numbers could be reserved: ${errorText(err)}`))
    ])
    startRechecks()
    scheduler.trigger('recheck')
  }

  function withoutRev(policy: BatchPolicy): Omit<BatchPolicy, 'rev'>
  {
    const { rev: _rev, ...rest } = policy
    return rest
  }

  function init(): Promise<void>
  {
    starting ??= start()
    return starting
  }

  /** Makes `count` catalog numbers available before a command that adds jobs; a failure leaves the refusal to the command. */
  async function reserveCatalog(count: number): Promise<void>
  {
    if (store.available('catalog') >= count)
    {
      return
    }
    await store.reserve('catalog', Math.max(1, count)).catch((err) => log.warn(`No catalog numbers could be reserved: ${errorText(err)}`))
  }

  function handlersOf(p: Parts): Handlers
  {
    const { core, queueCommands: queueCmd, planCommands: planCmd, runCommands: runCmd, jobCommands: jobCmd, historyCommands: historyCmd, presetCommands: presetCmd } = p
    const queued = <T>(result: CommandResult<T>): CommandResult<T> =>
    {
      if (result.ok)
      {
        p.scheduler.trigger('queued')
      }
      return result
    }
    return {
      subscribe: async (req, ctx) =>
      {
        const sender = host.sender(ctx.senderId)
        if (sender === null)
        {
          return engineRefusal('not-found', 'The window that asked is gone.')
        }
        const snapshot = core.subscribe(sender, req.clientId)
        return { ok: true, value: snapshot, seq: snapshot.seq }
      },
      unsubscribe: async (req, ctx) =>
      {
        core.unsubscribe(ctx.senderId, req.clientId)
        return { ok: true, value: null, seq: 0 }
      },
      get: async (req) =>
      {
        const detail = await core.get(req.jobId)
        return detail === null ? engineRefusal('not-found', 'That job is no longer in the queue.') : { ok: true, value: detail, seq: 0 }
      },
      add: async (req) =>
      {
        await reserveCatalog(req.paths.length)
        return queued(await queueCmd.add(req))
      },
      pasteFiles: async (req) =>
      {
        await reserveCatalog(1)
        return queued(await queueCmd.pasteFiles(req))
      },
      cancelScan: (req) => queueCmd.cancelScan(req),
      forgetFolder: (req) => queueCmd.forgetFolder(req),
      clearRecentFolders: (req) => queueCmd.clearRecentFolders(req),
      remove: (req) => queueCmd.remove(req),
      restore: async (req) => queued(await queueCmd.restore(req)),
      reorder: (req) => queueCmd.reorder(req),
      assignRecipe: async (req) => queued(await queueCmd.assignRecipe(req)),
      duplicate: async (req) =>
      {
        await reserveCatalog(req.ids.length)
        return queued(await queueCmd.duplicate(req))
      },
      locate: async (req) => queued(await queueCmd.locate(req)),
      relink: async (req) => queued(await queueCmd.relink(req)),
      reprobe: (req) => queueCmd.reprobe(req),
      setPolicy: (req) => planCmd.setPolicy(req),
      setDefaultRecipe: (req) => planCmd.setDefaultRecipe(req),
      preflight: (req) => planCmd.preflight(req),
      analyze: (req) => planCmd.analyze(req),
      cancelAnalyze: (req) => planCmd.cancelAnalyze(req),
      start: (req) => runCmd.start(req),
      pause: (req) => runCmd.pause(req),
      resume: async (req) =>
      {
        await recheck()
        return runCmd.resume(req)
      },
      cancelRun: (req) => runCmd.cancelRun(req),
      setWorkers: (req) => runCmd.setWorkers(req),
      setSettings: (req) => runCmd.setSettings(req),
      dismissAlert: (req) => runCmd.dismissAlert(req),
      revealAlert: (req) => runCmd.revealAlert(req),
      cancel: (req) => jobCmd.cancel(req),
      skip: (req) => jobCmd.skip(req),
      unqueue: (req) => jobCmd.unqueue(req),
      retry: async (req) =>
      {
        await recheck(Array.isArray(req.ids) ? req.ids : [])
        return jobCmd.retry(req)
      },
      keepOutput: async (req) =>
      {
        await recheck(req.ids)
        return jobCmd.keepOutput(req)
      },
      discardOutput: async (req) =>
      {
        await recheck(req.ids)
        return jobCmd.discardOutput(req)
      },
      acknowledge: (req) => jobCmd.acknowledge(req),
      clear: (req) => jobCmd.clear(req),
      log: (req) => jobCmd.log(req),
      reveal: (req) => jobCmd.reveal(req),
      exportReport: (req, ctx) => historyCmd.exportReport(req, { senderId: ctx.senderId }),
      listRuns: (req) => historyCmd.listRuns(req),
      getRun: (req) => historyCmd.getRun(req),
      searchRuns: (req) => historyCmd.searchRuns(req),
      rerun: async (req) =>
      {
        await reserveCatalog(Array.isArray(req.jobIds) ? req.jobIds.length : COUNTER_BLOCK)
        return historyCmd.rerun(req)
      },
      deleteRuns: (req) => historyCmd.deleteRuns(req),
      revealRecord: (req) => historyCmd.revealRecord(req),
      savePreset: (req) => presetCmd.savePreset(req),
      renamePreset: (req) => presetCmd.renamePreset(req),
      removePreset: (req) => presetCmd.removePreset(req),
      setPin: (req) => presetCmd.setPin(req)
    }
  }

  let handlers: Handlers | null = null

  async function command<K extends JobCommandName>(name: K, req: JobCommandRequest<K>, ctx: CommandContext): Promise<CommandResult<JobCommandResponse<K>>>
  {
    if (starting !== null && parts === null)
    {
      await starting.catch(() => undefined)
    }
    if (ended || quitting)
    {
      return engineRefusal('shutting-down', 'molexMedia is closing.')
    }
    if (parts === null)
    {
      return engineRefusal('internal', 'molexMedia is still starting.')
    }
    handlers ??= handlersOf(parts)
    const handler = handlers[name] as (req: JobCommandRequest<K>, ctx: CommandContext) => Promise<CommandResult<JobCommandResponse<K>>>
    return handler(req, ctx)
  }

  async function setCapabilities(capabilities: CapabilitySummary): Promise<void>
  {
    const p = need()
    p.core.setCapabilities(capabilities)
    p.budget.configure(p.core.globals().settings.gpuSessions, gpuVendor(capabilities))
    await p.planCommands.replanQueued()
    p.scheduler.trigger('replanned')
  }

  async function shutdown(mode: ShutdownMode): Promise<void>
  {
    if (ended)
    {
      return
    }
    quitting = true
    if (recheckTimer !== null)
    {
      timers.clearTimeout(recheckTimer)
      recheckTimer = null
    }
    const p = parts
    if (p === null)
    {
      ended = true
      return
    }
    p.scheduler.quitNow()
    if (mode === 'session-end')
    {
      store.sessionEnd(p.core.interruptActive('session-end', { capture: true }))
      ended = true
      return
    }
    p.core.interruptActive('quit')
    await Promise.all([p.queueCommands.settled(), p.presetCommands.settled(), historyChain]).catch((err) => log.warn(`Shutdown did not settle: ${errorText(err)}`))
    p.planCommands.dispose()
    p.runCommands.dispose()
    p.scheduler.dispose()
    p.budget.dispose()
    p.tombstones.dispose()
    ended = true
    await store.close()
    bus.dispose()
  }

  return {
    init,
    command,
    snapshot: () =>
    {
      const { core } = need()
      return core.snapshot(bus.flush())
    },
    isBusy: () => parts?.core.isBusy() ?? false,
    setCapabilities,
    quitInputs: () => need().core.quitInputs(),
    setQuitWhenIdle: (value) => need().core.setQuitWhenIdle(value),
    focus: (jobId, runId) => need().core.focus(jobId, runId),
    shutdown,
    persistNow: async (reason) =>
    {
      log.info(`Saving the queue: ${reason}`)
      await store.compact()
    }
  }
}

/** One handler per command name, each with the request and the sender. */
type Handlers = { [K in JobCommandName]: (req: JobCommandRequest<K>, ctx: CommandContext) => Promise<CommandResult<JobCommandResponse<K>>> }
