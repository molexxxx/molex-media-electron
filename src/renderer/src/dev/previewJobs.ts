/**
 * An in-memory jobs API for the development preview of the Batch page. It imitates the engine through the shared
 * contract, state machine, applicability rules, and presets over sample media, so the page can be clicked through
 * before the engine exists: events carry one gap-free seq, a subscribe flushes pending events before it builds the
 * snapshot, and commands outside the preview's flow answer with a typed error. Development only.
 */
import { stageLabel, type AudioStage } from '../../../shared/audio/events'
import { renderMessage } from '../../../shared/audio/messages'
import { applicabilityIssues, factsFromSummary } from '../../../shared/jobs/applicability'
import { JOB_CHANNELS } from '../../../shared/jobs/contract'
import type
{
  AddResult,
  ClearScope,
  CommandErrorCode,
  CommandIssue,
  CommandResult,
  JobCommandName,
  JobCommandRequest,
  JobCommandResponse,
  JobEvent,
  JobEventBatch,
  JobRefusalCode,
  JobsApi,
  PerJob,
  RunSearchMatch,
  Validated
} from '../../../shared/jobs/contract'
import { formatCatalog, formatRunId, formatRunLabel, type JobId, type RunId } from '../../../shared/jobs/ids'
import { applyDefaultPreset, DEFAULT_PINS, findPreset, presetLookup } from '../../../shared/jobs/presets'
import { audioOutLabel, recipeLabel, sameRecipeValues, videoEncoderLabel } from '../../../shared/jobs/describe'
import type { Operation, Recipe } from '../../../shared/jobs/recipes'
import
{
  commandApplicability,
  IN_RUN_STATES,
  runTransitionFor,
  transitionFor,
  type JobTrigger,
  type MatrixCommand,
  type RunTransition
} from '../../../shared/jobs/states'
import { pathSeparator, renderTemplate, stemOf, templateDate, templateValues } from '../../../shared/jobs/template'
import { DEFAULT_TEMPLATES, JOB_STATES, TERMINAL_STATES } from '../../../shared/jobs/types'
import type
{
  AbortIntent,
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  EngineSnapshot,
  HistoryRecord,
  JobCounts,
  JobError,
  JobErrorSummary,
  JobHold,
  JobPatch,
  JobProgress,
  JobStage,
  JobState,
  JobPlan,
  JobView,
  OutputPlan,
  PauseMode,
  PlanIssue,
  PreflightReport,
  PresetState,
  RecentFolder,
  RecipeOutcome,
  ResultStamp,
  RunIndexEntry,
  RunProgress,
  RunSettings,
  RunState,
  ScanState,
  SourceRef,
  StateReason,
  UserPreset,
  WorkersState
} from '../../../shared/jobs/types'
import { REQUEST_VALIDATORS } from '../../../shared/jobs/validate'
import
{
  baseName,
  folderSamples,
  isFolderPath,
  isSamplePath,
  PREVIEW_SAMPLES,
  sampleFacts,
  sampleSource,
  subdirOf,
  type SampleFacts
} from './previewMedia'

/** The timers the preview runs on: window timers by default, a manual clock in tests. */
export interface PreviewClock
{
  now: () => number
  /** Runs fn after ms and returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void
}

/** How a preview starts. */
export interface PreviewJobsOptions
{
  clock?: PreviewClock
  /** Queue the sample set, already probed; true by default. */
  samples?: boolean
}

/** The probing time of one added file. */
export const PROBE_MS = 300

/** The interval of progress events while jobs run. */
export const TICK_MS = 250

/** Files probed at the same time. */
export const PROBE_CONCURRENCY = 3

/** Worker slots of the preview's imaginary machine. */
export const PREVIEW_WORKERS = 3

type EventBody = { [T in JobEvent['type']]: Omit<Extract<JobEvent, { type: T }>, 'seq' | 'at'> }[JobEvent['type']]

type Listener = (batch: JobEventBatch) => void

interface PreviewJob
{
  view: JobView
  facts: SampleFacts
  /** The output its latest review planned; null until a review, and again after a recipe change. */
  output: PlannedOutput | null
}

const WINDOW_CLOCK: PreviewClock =
{
  now: () => Date.now(),
  schedule: (fn, ms) =>
  {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
}

/** The error every command outside the preview's flow answers with. */
export function notInPreview(name: JobCommandName): CommandResult<never>
{
  return failure('invalid-state', `${JOB_CHANNELS[name]} is not available in the preview.`)
}

function failure(code: CommandErrorCode, message: string, issues: CommandIssue[] = []): CommandResult<never>
{
  return { ok: false, error: { code, message, issues, details: null } }
}

function zeroCounts(): JobCounts
{
  return Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as JobCounts
}

const REFUSALS: Readonly<Partial<Record<JobRefusalCode, string>>> =
{
  'not-found': 'is not in the queue',
  'job-running': 'is running',
  'job-finalizing': 'is placing its output',
  'job-held': 'waits for a decision',
  'job-terminal': 'has finished',
  'not-started': 'has not started',
  'not-queued': 'is not queued',
  'not-retryable': 'has nothing to retry',
  'not-movable': 'can no longer move',
  'needs-attention': 'needs attention first'
}

function refusal(jobId: JobId, code: JobRefusalCode, detail?: string): { jobId: JobId; code: JobRefusalCode; message: string }
{
  return { jobId, code, message: detail ?? `${jobId} ${REFUSALS[code] ?? 'cannot do that now'}.` }
}

const MAX_RECENT_RECIPES = 5

const MAX_RECENT_FOLDERS = 10

/** The version the preview reports for FFmpeg and the app. */
const PREVIEW_VERSION = 'preview'

type SimStage = 'probe' | 'measure' | 'encode' | 'verify' | 'place'

type PinKey = keyof PresetState['pins']

type NormalizeRecipe = Extract<Recipe, { kind: 'normalize' }>

interface Step
{
  state: JobState
  stage: SimStage
  passes: number
  ticks: number
  from: number
  to: number
}

interface Work
{
  steps: Step[]
  step: number
  pass: number
  tick: number
  startedAt: number
  /** An abort the next tick settles, as a child process exits after its kill. */
  abort: { trigger: AbortIntent; reason: StateReason } | null
}

interface RunRecord
{
  record: HistoryRecord
  stamp: ResultStamp | null
}

interface PastRun
{
  entry: RunIndexEntry
  summary: BatchSummary
  records: RunRecord[]
}

interface PlannedOutput
{
  name: string
  path: string
  relativePath: string
  container: string
  kind: OutputPlan['kind']
  issues: PlanIssue[]
}

const MEDIA_SEC_PER_TICK = 150

const MIN_ENCODE_TICKS = 6

const MAX_ENCODE_TICKS = 40

const NEXT_TRIGGER: Readonly<Record<SimStage, JobTrigger>> =
{
  probe: 'measured',
  measure: 'measured',
  encode: 'encoded',
  verify: 'verified',
  place: 'placed'
}

const AUDIO_STAGES: Readonly<Partial<Record<SimStage, AudioStage>>> =
{
  probe: 'probe',
  measure: 'measure',
  encode: 'encode',
  verify: 'verify'
}

const STAGE_WORDS: Readonly<Record<SimStage, string>> =
{
  probe: 'Probe',
  measure: 'Measure',
  encode: 'Encode',
  verify: 'Verify',
  place: 'Place output'
}

const OUTPUT_RATIO: Readonly<Record<Operation, number>> =
{
  normalize: 1,
  boost: 1,
  convert: 0.8,
  compress: 0.35,
  extract: 0.08
}

const CODEC_CONTAINERS: Readonly<Record<string, string>> =
{
  aac: 'm4a',
  alac: 'm4a',
  mp3: 'mp3',
  opus: 'opus',
  vorbis: 'ogg',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3'
}

const LOSSLESS_CONTAINERS: readonly string[] = ['flac', 'wav', 'aiff', 'aif']

const RUNNING_STATES: readonly JobState[] = ['analyzing', 'encoding', 'verifying']

/** What FFmpeg 9.0.2 printed while decoding a damaged MP3 (it still exited 0); the damaged sample fails its verify with it. */
const DAMAGED_STDERR = [
  '[mp3float @ 00000171b752da80] [error] Header missing',
  '[aist#0:0/mp3 @ 00000171b752bc00] [dec:mp3float @ 00000171b752b000] [error] Error submitting packet to decoder: Invalid data found when processing input'
].join('\n')

function round1(value: number): number
{
  return Math.round(value * 10) / 10
}

/** A number with U+2212 for its minus sign, as the page prints negative values. */
function signed(value: number): string
{
  return value < 0 ? `−${Math.abs(value).toFixed(1)}` : value.toFixed(1)
}

function isAudioOp(recipe: Recipe): boolean
{
  return recipe.kind === 'normalize' || recipe.kind === 'boost'
}

function codecContainer(codec: string): string
{
  return CODEC_CONTAINERS[codec] ?? (codec.startsWith('pcm') ? 'wav' : codec)
}

/** The extension of a recipe's output for a source extension. */
function outputExtension(recipe: Recipe, sourceExt: string): string
{
  switch (recipe.kind)
  {
    case 'normalize':
    case 'boost':
      return recipe.output.kind === 'codec' ? codecContainer(recipe.output.codec) : sourceExt
    case 'convert':
      return recipe.container
    case 'compress':
      return recipe.container === 'source' ? sourceExt : recipe.container
    case 'extract':
      return recipe.mode === 'gif' ? 'gif' : recipe.mode === 'frames' || recipe.mode === 'subtitles' ? recipe.format : recipe.container
  }
}

/** The encoder a row's plan names, in the page's short form. */
function encoderLabelOf(recipe: Recipe): string
{
  switch (recipe.kind)
  {
    case 'normalize':
    case 'boost':
      return audioOutLabel(recipe.output)
    case 'convert':
      if (recipe.video === null)
      {
        return audioOutLabel(recipe.audio, recipe.channels)
      }
      return recipe.video.encoder === 'copy' ? 'copy' : videoEncoderLabel(recipe.video.encoder)
    case 'compress':
      return recipe.target.mode === 'size' && recipe.target.twoPass ? `${videoEncoderLabel(recipe.encoder)} 2-pass` : videoEncoderLabel(recipe.encoder)
    case 'extract':
      if (recipe.mode === 'audio')
      {
        return audioOutLabel(recipe.audio, recipe.channels)
      }
      if (recipe.mode === 'video')
      {
        return recipe.reencode === null ? 'copy' : videoEncoderLabel(recipe.reencode.encoder)
      }
      return recipe.mode === 'gif' ? 'GIF' : recipe.format.toUpperCase()
  }
}

/** The bytes a job's output reaches: a size target lands at 97 percent of it, other operations follow the source. */
/** The plan a Review report holds for a ready job: where it writes and what it reads, with no streams or command. */
function previewPlan(view: JobView, output: PlannedOutput, resolution: OutputPlan['resolution'], basis: JobPlan['basis']): JobPlan
{
  return {
    basis,
    fingerprint: `${view.id}:${view.inputsRev}`,
    source: { path: view.source.path, size: view.source.size, mtimeMs: view.source.mtimeMs },
    output:
    {
      kind: output.kind,
      finalPath: output.path,
      container: output.container,
      muxer: output.container,
      containerChanged: null,
      conflict: resolution === 'rename' ? 'collides' : 'none',
      resolution,
      renamedTo: resolution === 'rename' ? output.name : null,
      displaces: null
    },
    streams: { kept: [], dropped: [], chapters: 'none' },
    video: null,
    audio: [],
    class: view.recipe.kind === 'normalize' || view.recipe.kind === 'boost' ? 'audio' : 'video-cpu',
    stages: [],
    estimate: { outputBytes: outputBytesOf(view), reserveBytes: 0, workSec: null, confidence: 'low' },
    album: null,
    command: null
  }
}

function outputBytesOf(view: JobView): number
{
  const recipe = view.recipe
  if (recipe.kind === 'compress' && recipe.target.mode === 'size')
  {
    return Math.round(recipe.target.targetBytes * 0.97)
  }
  return Math.round(view.source.size * OUTPUT_RATIO[recipe.kind])
}

/** The steps an attempt runs, one per active state, with the ticks each pass takes and its share of the job percent. */
function stepsFor(recipe: Recipe, durationSec: number): Step[]
{
  const measures = recipe.kind === 'normalize'
  const passes = recipe.kind === 'compress' && recipe.target.mode === 'size' && recipe.target.twoPass ? 2 : 1
  const encodeTicks = Math.min(MAX_ENCODE_TICKS, Math.max(MIN_ENCODE_TICKS, Math.round(durationSec / MEDIA_SEC_PER_TICK)))
  return [
    { state: 'analyzing', stage: measures ? 'measure' : 'probe', passes: 1, ticks: measures ? 4 : 2, from: 0, to: 10 },
    { state: 'encoding', stage: 'encode', passes, ticks: Math.max(3, Math.round(encodeTicks / passes)), from: 10, to: 85 },
    { state: 'verifying', stage: 'verify', passes: 1, ticks: isAudioOp(recipe) ? 3 : 4, from: 85, to: 97 },
    { state: 'finalizing', stage: 'place', passes: 1, ticks: 1, from: 97, to: 100 }
  ]
}

/** The stage a step runs; audio jobs take the audio stage labels. */
function stageOf(recipe: Recipe, step: Step, pass: number, now: number): JobStage
{
  const audio = AUDIO_STAGES[step.stage]
  const word = isAudioOp(recipe) && audio !== undefined ? renderMessage(stageLabel(audio, null), { minus: 'unicode' }) : STAGE_WORDS[step.stage]
  return { id: step.stage, pass, passes: step.passes, label: step.passes > 1 ? `${word}, pass ${pass} of ${step.passes}` : word, startedAt: now }
}

/** The ticks a job has left from its current step, pass, and tick. */
function remainingTicks(work: Pick<Work, 'steps' | 'step' | 'pass' | 'tick'>): number
{
  const step = work.steps[work.step]
  const later = work.steps.slice(work.step + 1).reduce((sum, next) => sum + next.ticks * next.passes, 0)
  return (step.passes - work.pass) * step.ticks + (step.ticks - work.tick) + later
}

function emptyProgress(): RunProgress
{
  return { percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 }
}

function durationOf(job: PreviewJob): number
{
  return job.facts.media.durationSec ?? 0
}

/** A job's progress at its current step, pass, and tick. */
function progressOf(work: Work, durationSec: number, outputBytes: number, now: number): JobProgress
{
  const step = work.steps[work.step]
  const share = (work.pass - 1 + work.tick / step.ticks) / step.passes
  const encoding = step.state === 'encoding'
  const remaining = remainingTicks(work)
  return {
    stage: step.stage,
    pass: work.pass,
    passes: step.passes,
    percent: round1(step.from + (step.to - step.from) * share),
    stagePercent: round1(work.tick / step.ticks * 100),
    speed: encoding && work.tick > 0 ? round1(durationSec / (step.ticks * TICK_MS / 1000)) : null,
    etaSec: work.tick > 0 ? Math.ceil(remaining * TICK_MS / 1000) : null,
    outTimeSec: encoding ? round1(durationSec * share) : null,
    durationSec,
    bytesWritten: encoding ? Math.round(outputBytes * share) : null,
    elapsedMs: now - work.startedAt
  }
}

/** A measured offset from the target that a job's catalog number fixes, -0.4 to +0.4 LU. */
function offsetOf(seq: number): number
{
  return ((seq * 7) % 9 - 4) / 10
}

/** The stamp of a verified output; an outside-tolerance verdict lands 3.8 LU below its target. */
function stampFor(view: JobView, verdict: 'verified' | 'outside-tolerance', outputName: string, container: string): ResultStamp
{
  const recipe = view.recipe
  const checkClass = LOSSLESS_CONTAINERS.includes(container) ? 'lossless' : 'lossy'
  const offset = verdict === 'outside-tolerance' ? -3.8 : offsetOf(view.seq)
  let loudness: ResultStamp['loudness'] = null
  let truePeak: ResultStamp['truePeak'] = null
  if (recipe.kind === 'normalize')
  {
    const target = recipe.target
    loudness =
    {
      lufs: round1(target.integratedLufs + offset),
      unit: target.unit,
      reference: 'target',
      referenceLufs: target.integratedLufs,
      deviation: offset,
      deviationUnit: 'LU',
      check: target.toleranceLu ?? 1,
      checkClass,
      status: verdict === 'outside-tolerance' ? 'below' : 'within'
    }
    truePeak = { dbtp: round1(target.maxTruePeakDbtp - 0.4), preEncodeDbtp: round1(target.maxTruePeakDbtp - 0.6), limitDbtp: target.maxTruePeakDbtp, status: 'within' }
  }
  else if (recipe.kind === 'boost')
  {
    loudness =
    {
      lufs: round1(-18 + recipe.gainDb + offset),
      unit: 'LUFS',
      reference: 'target',
      referenceLufs: null,
      deviation: null,
      deviationUnit: 'LU',
      check: 1,
      checkClass,
      status: 'not-checked'
    }
    truePeak = { dbtp: round1(recipe.maxTruePeakDbtp - 0.3), preEncodeDbtp: null, limitDbtp: recipe.maxTruePeakDbtp, status: 'within' }
  }
  const audioOp = isAudioOp(recipe)
  return {
    verdict,
    outputName,
    container,
    inputBytes: view.source.size,
    outputBytes: outputBytesOf(view),
    durationSec: view.media?.durationSec ?? null,
    decode: audioOp ? 'full' : 'sampled',
    audioStreams: view.media?.audio.length ?? 0,
    verdictStream: audioOp ? 0 : null,
    loudness,
    truePeak,
    size: recipe.kind === 'compress' && recipe.target.mode === 'size' ? { targetBytes: recipe.target.targetBytes, status: 'within' } : null,
    frames: recipe.kind === 'extract' && recipe.mode === 'frames' ? 24 : null,
    cues: recipe.kind === 'extract' && recipe.mode === 'subtitles' ? 412 : null,
    placement: 'new',
    warnings: 0
  }
}

/** The failure of the damaged sample: its verify decode found errors. */
function damagedError(view: JobView, at: number): JobError
{
  return {
    code: 'decode-errors',
    short: 'Decode errors',
    cause: null,
    message: `${view.source.name} decoded with errors: the source is damaged (Header missing, Invalid data found when processing input).`,
    stage: 'verify',
    attempt: view.attempt,
    encodePass: 1,
    exitCode: 0,
    exitName: null,
    signal: null,
    stderrTail: DAMAGED_STDERR,
    command: null,
    fsError: null,
    hint: 'Replace the source with an undamaged copy, then retry.',
    at
  }
}

/** The loudness outcome of one Normalize recipe across its jobs' stamps. */
function loudnessOutcome(recipe: NormalizeRecipe, stamps: readonly ResultStamp[]): RecipeOutcome['loudness']
{
  const measured = stamps.flatMap((stamp) => stamp.loudness === null ? [] : [stamp.loudness])
  const peaks = stamps.flatMap((stamp) => stamp.truePeak === null ? [] : [stamp.truePeak.dbtp])
  const levels = measured.map((entry) => entry.lufs)
  const checks: NonNullable<RecipeOutcome['loudness']>['checks'] = []
  for (const entry of measured)
  {
    const found = checks.find((check) => check.checkClass === entry.checkClass)
    const within = entry.status === 'within' ? 1 : 0
    if (found)
    {
      found.jobs += 1
      found.within += within
    }
    else
    {
      checks.push({ checkClass: entry.checkClass, check: entry.check, jobs: 1, within })
    }
  }
  return {
    unit: recipe.target.unit,
    targetLufs: recipe.target.integratedLufs,
    deviationUnit: 'LU',
    checks,
    minLufs: levels.length > 0 ? Math.min(...levels) : null,
    maxLufs: levels.length > 0 ? Math.max(...levels) : null,
    streams: measured.length,
    maxTruePeakDbtp: peaks.length > 0 ? Math.max(...peaks) : null,
    limitedJobs: 0,
    maxLimitingDb: null,
    reachableLevels: []
  }
}

/** Each recipe's outcomes in a run, grouped by recipe label in the order the records first name them. */
function recipeOutcomes(entries: readonly RunRecord[]): RecipeOutcome[]
{
  const groups = new Map<string, RunRecord[]>()
  for (const entry of entries)
  {
    groups.set(entry.record.recipeLabel, [...(groups.get(entry.record.recipeLabel) ?? []), entry])
  }
  return [...groups].map(([label, group]) =>
  {
    const recipe = group[0].record.recipe
    const placed = group.filter((entry) => entry.record.state === 'done')
    const stamps = group.flatMap((entry) => entry.stamp === null ? [] : [entry.stamp])
    return {
      op: recipe.kind,
      label,
      presetId: recipe.presetId,
      userPresetId: recipe.userPreset?.id ?? null,
      jobs: group.length,
      verified: placed.length,
      reachable: 0,
      outsideTolerance: 0,
      returned: group.filter((entry) => entry.record.state === 'failed' || entry.record.state === 'held').length,
      loudness: recipe.kind === 'normalize' ? loudnessOutcome(recipe, stamps) : null,
      size: recipe.kind === 'compress' && recipe.target.mode === 'size' ? { targetBytes: recipe.target.targetBytes, jobs: group.length, within: placed.length } : null
    }
  })
}

/** The history state an abort ends a job in. */
const ABORT_ENDS: Readonly<Record<'cancel' | 'skip', HistoryRecord['state']>> =
{
  cancel: 'canceled',
  skip: 'skipped'
}

/** The drive or root of a path, the volume a preflight reports. */
function volumeOf(path: string): string
{
  return /^[A-Za-z]:/.exec(path)?.[0].toUpperCase() ?? '/'
}

/** What the preview reports for every volume it writes to. */
const PREVIEW_VOLUME_BYTES = 2_000_000_000_000

const PREVIEW_FREE_BYTES = 412_000_000_000

/** An output numbered " (2)", " (3)", and so on, past every path the review already gave out. */
function numbered(output: PlannedOutput, taken: ReadonlyMap<string, JobId>): PlannedOutput
{
  const suffix = output.kind === 'file' ? `.${output.container}` : ''
  const withNumber = (value: string, n: number): string => `${value.slice(0, value.length - suffix.length)} (${n})${suffix}`
  let n = 2
  while (taken.has(withNumber(output.path, n).toLowerCase()))
  {
    n += 1
  }
  return { ...output, name: withNumber(output.name, n), path: withNumber(output.path, n), relativePath: withNumber(output.relativePath, n) }
}

/** Pins a preset to a key, or clears the key; unpinned names the preset the key held when that changes. */
function pinTo(pins: PresetState['pins'], key: number, presetId: string | null): { pins: PresetState['pins']; unpinned: string | null }
{
  const slot = String(key) as PinKey
  const before = pins[slot] ?? null
  const next = { ...pins }
  if (presetId === null)
  {
    delete next[slot]
  }
  else
  {
    next[slot] = presetId
  }
  return { pins: next, unpinned: before === presetId ? null : before }
}

class PreviewEngine
{
  readonly clock: PreviewClock
  seq = 0
  private outbox: JobEvent[] = []
  private flushQueued = false
  private readonly listeners = new Set<Listener>()
  private readonly clients = new Set<string>()
  readonly jobs = new Map<JobId, PreviewJob>()
  order: JobId[] = []
  private catalog = 0
  policy: BatchPolicy =
  {
    rev: 1,
    destination: { mode: 'next-to-source' },
    template: DEFAULT_TEMPLATES['next-to-source'],
    conflict: 'rename',
    displaced: 'trash',
    gpu: 'auto'
  }
  settings: RunSettings =
  {
    workers: { mode: 'auto' },
    gpuSessions: { mode: 'auto' },
    priority: 'below-normal',
    keepAwake: true,
    verifyVideo: 'sampled',
    notify: { completion: true, firstFailure: true },
    measureOnReview: false,
    includeSubfolders: true
  }
  defaultRecipe: Recipe = applyDefaultPreset('normalize', { kind: 'same-as-source' })
  presets: PresetState = { user: [], pins: { ...DEFAULT_PINS }, recent: [] }
  recentFolders: RecentFolder[] = []
  scans: ScanState[] = []
  readonly capabilities: CapabilitySummary =
  {
    rev: 1,
    ffmpeg: { ready: true, version: PREVIEW_VERSION, source: 'bundled', meetsMinimum: true, selfTest: 'passed', soxr: true },
    encoders: ['aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le', 'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'prores_ks', 'ffv1', 'gif', 'png', 'mjpeg', 'libwebp'],
    gpu: { status: 'ready', vendor: null, name: null, encoders: [] },
    cpuCount: 8,
    platform: 'win32'
  }
  run: RunState
  readonly history: PastRun[] = []
  private readonly work = new Map<JobId, Work>()
  private readonly reports = new Map<string, PreflightReport>()
  private readonly starts = new Map<string, JobCommandResponse<'start'>>()
  private runRecords: RunRecord[] = []
  private runCount = 0
  private preflightCount = 0
  private presetCount = 0
  private ticking = false
  private announcedWorkers = ''

  constructor(options: PreviewJobsOptions)
  {
    this.clock = options.clock ?? WINDOW_CLOCK
    this.run =
    {
      status: 'idle',
      runId: null,
      startedAt: null,
      pause: null,
      counts: zeroCounts(),
      progress: { percent: 0, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: 0, elapsedMs: 0 },
      workers: this.workers(),
      quitWhenIdle: false,
      needsAck: null
    }
    if (options.samples !== false)
    {
      for (const path of PREVIEW_SAMPLES)
      {
        const job = this.createJob(sampleSource(path, 'files'), this.defaultRecipe)
        job.view = { ...job.view, probe: 'ok', media: structuredClone(job.facts.media) }
        this.jobs.set(job.view.id, job)
        this.order.push(job.view.id)
      }
      this.run = { ...this.run, counts: this.counts() }
    }
    this.announcedWorkers = JSON.stringify(this.run.workers.active)
  }

  /** Registers an event listener; batches reach listeners while a client is subscribed. */
  listen(listener: Listener): () => void
  {
    this.listeners.add(listener)
    return () =>
    {
      this.listeners.delete(listener)
    }
  }

  emit(body: EventBody): void
  {
    this.seq += 1
    this.outbox.push({ ...body, seq: this.seq, at: this.clock.now() } as JobEvent)
    if (!this.flushQueued)
    {
      this.flushQueued = true
      queueMicrotask(() => this.flush())
    }
  }

  flush(): void
  {
    this.flushQueued = false
    if (this.outbox.length === 0)
    {
      return
    }
    const batch: JobEventBatch = structuredClone({ events: this.outbox })
    this.outbox = []
    if (this.clients.size === 0)
    {
      return
    }
    for (const listener of [...this.listeners])
    {
      listener(batch)
    }
  }

  subscribe(clientId: string): EngineSnapshot
  {
    this.flush()
    this.clients.add(clientId)
    return this.snapshot()
  }

  unsubscribe(clientId: string): null
  {
    this.clients.delete(clientId)
    return null
  }

  snapshot(): EngineSnapshot
  {
    return structuredClone({
      schema: 1,
      seq: this.seq,
      run: this.run,
      policy: this.policy,
      settings: this.settings,
      defaultRecipe: this.defaultRecipe,
      order: this.order,
      jobs: this.order.map((id) => (this.jobs.get(id) as PreviewJob).view),
      capabilities: this.capabilities,
      scans: this.scans,
      alerts: [],
      presets: this.presets,
      recentFolders: this.recentFolders,
      limits: { maxJobs: 5000 }
    })
  }

  label(recipe: Recipe): string
  {
    return recipeLabel(recipe, presetLookup(this.presets.user))
  }

  createJob(source: SourceRef, recipe: Recipe): PreviewJob
  {
    this.catalog += 1
    const copy = structuredClone(recipe)
    const view: JobView =
    {
      id: formatCatalog(this.catalog),
      seq: this.catalog,
      rev: 1,
      inputsRev: 1,
      source,
      recipe: copy,
      recipeLabel: this.label(copy),
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
      addedAt: this.clock.now(),
      startedAt: null,
      endedAt: null,
      albumGroupId: copy.kind === 'normalize' ? copy.albumGroupId : null
    }
    return { view, facts: sampleFacts(source.path), output: null }
  }

  /** Worker slots and what the active jobs take of them. */
  workers(): WorkersState
  {
    let videoCpu = 0
    let analysis = 0
    for (const id of this.work.keys())
    {
      const view = this.view(id)
      videoCpu += isAudioOp(view.recipe) ? 0 : 1
      analysis += view.state === 'analyzing' ? 1 : 0
    }
    return {
      setting: this.settings.workers,
      limits: { total: PREVIEW_WORKERS, videoCpu: PREVIEW_WORKERS, gpu: 0 },
      active: { total: this.work.size, videoCpu, gpu: 0, analysis, starting: 0 }
    }
  }

  view(id: JobId): JobView
  {
    return (this.jobs.get(id) as PreviewJob).view
  }

  /** Jobs per state across the whole queue. */
  counts(): JobCounts
  {
    const counts = zeroCounts()
    for (const job of this.jobs.values())
    {
      counts[job.view.state] += 1
    }
    return counts
  }

  /** Changes a row and announces the patch. */
  update(job: PreviewJob, patch: JobPatch): void
  {
    job.view = { ...job.view, ...patch, rev: job.view.rev + 1 }
    this.emit({ type: 'job.updated', jobId: job.view.id, rev: job.view.rev, patch })
  }

  /**
   * Applies a trigger through the shared transition table; false when the trigger does not apply in the job's
   * state. The reason is the given one when the table allows it, else the table's default.
   */
  transition(job: PreviewJob, trigger: JobTrigger, patch: JobPatch = {}, reason: StateReason | null = null): boolean
  {
    const entry = transitionFor(job.view, trigger)
    if (entry === null)
    {
      return false
    }
    if (entry.to === 'removed')
    {
      this.jobs.delete(job.view.id)
      this.order = this.order.filter((id) => id !== job.view.id)
      this.emit({ type: 'job.removed', jobId: job.view.id })
      return true
    }
    const from = job.view.state
    const why = reason !== null && entry.reasons.includes(reason) ? reason : entry.reasons[0]
    job.view = { ...job.view, ...patch, state: entry.to, reason: why, rev: job.view.rev + 1 }
    this.emit({ type: 'job.state', jobId: job.view.id, rev: job.view.rev, from, to: entry.to, attempt: job.view.attempt, reason: why, patch })
    return true
  }

  /** Runs a per-job command on every job the shared matrix allows and reports the rest. */
  perJob(ids: readonly JobId[], command: MatrixCommand, apply: (job: PreviewJob) => void): PerJob
  {
    const result: PerJob = { applied: [], refused: [] }
    for (const id of ids)
    {
      const job = this.jobs.get(id)
      if (!job)
      {
        result.refused.push(refusal(id, 'not-found'))
        continue
      }
      const answer = commandApplicability(command, job.view)
      if (answer === 'ok')
      {
        apply(job)
        result.applied.push(id)
      }
      else if (answer !== 'no-op')
      {
        result.refused.push(refusal(id, answer))
      }
    }
    return result
  }

  findByPath(path: string): JobId | null
  {
    const wanted = path.toLowerCase()
    return this.order.find((id) => (this.jobs.get(id) as PreviewJob).view.source.path.toLowerCase() === wanted) ?? null
  }

  private probeQueue: JobId[] = []
  private probing = 0

  private pumpProbes(): void
  {
    while (this.probing < PROBE_CONCURRENCY && this.probeQueue.length > 0)
    {
      const id = this.probeQueue.shift() as JobId
      this.probing += 1
      this.clock.schedule(() =>
      {
        this.probing -= 1
        const job = this.jobs.get(id)
        if (job && job.view.probe === 'pending')
        {
          this.update(job, { probe: 'ok', media: structuredClone(job.facts.media) })
        }
        this.pumpProbes()
      }, PROBE_MS)
    }
  }

  /** Adds one job after a job (null appends it) and starts its probe. */
  addJob(source: SourceRef, recipe: Recipe, after: JobId | null): JobId
  {
    const job = this.createJob(source, recipe)
    const id = job.view.id
    this.jobs.set(id, job)
    const index = after === null ? -1 : this.order.indexOf(after)
    if (index === -1)
    {
      this.order.push(id)
    }
    else
    {
      this.order.splice(index + 1, 0, id)
    }
    this.emit({ type: 'job.added', job: job.view, after: index === -1 ? null : after })
    this.probeQueue.push(id)
    this.pumpProbes()
    return id
  }

  private scanCount = 0

  private putScan(scan: ScanState): void
  {
    this.scans = [...this.scans.filter((entry) => entry.scanId !== scan.scanId), scan]
    this.emit({ type: 'scan.progress', scan })
  }

  /** Scans a folder: its files arrive as jobs after one probe interval, and the folder joins the recent list. */
  scan(folder: string, recipe: Recipe, recursive: boolean): string
  {
    this.scanCount += 1
    const scanId = `scan-${this.scanCount}`
    const started: ScanState =
    {
      scanId,
      root: folder,
      status: 'scanning',
      error: null,
      visited: 0,
      added: 0,
      excluded: { links: 0, unreadable: 0, workFiles: 0, unsupported: 0, overLimit: 0, outputFolder: 0, previousOutputs: 0, duplicates: 0 }
    }
    this.putScan(started)
    this.clock.schedule(() =>
    {
      const found = folderSamples(folder, recursive)
      let added = 0
      for (const path of found)
      {
        if (this.findByPath(path) === null)
        {
          this.addJob(sampleSource(path, 'folder', subdirOf(folder, path)), recipe, null)
          added += 1
        }
      }
      this.putScan({ ...started, status: 'done', visited: found.length, added, excluded: { ...started.excluded, duplicates: found.length - added } })
      const recent: RecentFolder = { path: folder, name: baseName(folder), files: found.length, addedAt: this.clock.now() }
      this.recentFolders = [recent, ...this.recentFolders.filter((entry) => entry.path !== folder)].slice(0, MAX_RECENT_FOLDERS)
      this.emit({ type: 'folders.changed', recentFolders: this.recentFolders })
    }, PROBE_MS)
    return scanId
  }

  add(req: JobCommandRequest<'add'>): AddResult
  {
    const recipe = req.recipe ?? this.defaultRecipe
    const result: AddResult = { added: [], duplicates: { paths: [], jobIds: [] }, previousOutputs: [], refused: [], scanIds: [] }
    let after = req.after !== null && this.jobs.has(req.after) ? req.after : null
    for (const path of req.paths)
    {
      if (isFolderPath(path))
      {
        result.scanIds.push(this.scan(path, recipe, req.recursive))
        continue
      }
      if (!isSamplePath(path))
      {
        result.refused.push({ path, code: 'not-media', message: `${baseName(path)} is not a media file molexMedia opens.` })
        continue
      }
      const existing = this.findByPath(path)
      if (existing !== null && !req.allowSecondJobs)
      {
        result.duplicates.paths.push(path)
        result.duplicates.jobIds.push(existing)
        continue
      }
      const id = this.addJob(sampleSource(path, req.origin), recipe, after)
      result.added.push(id)
      after = after === null ? null : id
    }
    return result
  }

  /** Removes jobs the shared matrix allows; a run left with nothing to do completes. */
  remove(ids: readonly JobId[]): PerJob & { tombstone: string | null }
  {
    const result = this.perJob(ids, 'remove', (job) => this.transition(job, 'remove'))
    this.settleRun()
    return { ...result, tombstone: null }
  }

  reorder(ids: readonly JobId[], before: JobId | null): PerJob
  {
    const result = this.perJob(ids, 'reorder', () => undefined)
    if (result.applied.length === 0)
    {
      return result
    }
    const moving = new Set(result.applied)
    const start = before === null ? -1 : this.order.indexOf(before)
    const anchor = start === -1 ? undefined : this.order.slice(start).find((id) => !moving.has(id))
    const rest = this.order.filter((id) => !moving.has(id))
    const index = anchor === undefined ? rest.length : rest.indexOf(anchor)
    this.order = [...rest.slice(0, index), ...result.applied, ...rest.slice(index)]
    this.emit({ type: 'queue.order', order: [...this.order] })
    return result
  }

  assignRecipe(assignments: JobCommandRequest<'assignRecipe'>['assignments']): PerJob
  {
    const result: PerJob = { applied: [], refused: [] }
    for (const { jobId, recipe } of assignments)
    {
      const outcome = this.perJob([jobId], 'assignRecipe', (job) =>
      {
        this.update(job, this.recipePatch(job, recipe))
      })
      result.applied.push(...outcome.applied)
      result.refused.push(...outcome.refused)
    }
    if (result.applied.length > 0)
    {
      this.rememberRecipe(assignments[assignments.length - 1].recipe)
    }
    return result
  }

  /** The patch that gives a job a copy of a recipe; its plan no longer holds. */
  private recipePatch(job: PreviewJob, recipe: Recipe): JobPatch
  {
    const copy = structuredClone(recipe)
    job.output = null
    return {
      recipe: copy,
      recipeLabel: this.label(copy),
      inputsRev: job.view.inputsRev + 1,
      plan: null,
      albumGroupId: copy.kind === 'normalize' ? copy.albumGroupId : null
    }
  }

  /** Gives files added from now on this recipe; jobs already queued keep theirs. */
  setDefaultRecipe(recipe: Recipe): null
  {
    this.defaultRecipe = structuredClone(recipe)
    this.emit({ type: 'defaultRecipe.changed', recipe: structuredClone(recipe) })
    return null
  }

  private rememberRecipe(recipe: Recipe): void
  {
    const recent = [structuredClone(recipe), ...this.presets.recent.filter((entry) => !sameRecipeValues(entry, recipe))]
    this.presets = { ...this.presets, recent: recent.slice(0, MAX_RECENT_RECIPES) }
    this.emit({ type: 'presets.changed', presets: this.presets })
  }

  /** The output a job writes: the policy's template rendered by the shared renderer, beside its source. */
  outputOf(view: JobView): PlannedOutput
  {
    const recipe = view.recipe
    const container = outputExtension(recipe, view.source.ext)
    const kind: OutputPlan['kind'] = recipe.kind === 'extract' && recipe.mode === 'frames' ? 'folder' : 'file'
    const values = templateValues({
      catalog: view.id,
      stem: stemOf(view.source.name),
      ext: view.source.ext,
      subdir: view.source.subdir,
      recipe,
      date: templateDate(this.clock.now())
    })
    const rendered = renderTemplate(this.policy.template, values, this.capabilities.platform)
    const separator = pathSeparator(this.capabilities.platform)
    const relativePath = kind === 'folder' ? rendered.relativePath : `${rendered.relativePath}.${container}`
    return {
      name: rendered.segments[rendered.segments.length - 1] + (kind === 'folder' ? '' : `.${container}`),
      path: `${view.source.dir}${separator}${relativePath}`,
      relativePath,
      container,
      kind,
      issues: rendered.issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message, field: 'naming', fix: null }))
    }
  }

  private outputFor(job: PreviewJob): PlannedOutput
  {
    return job.output ?? this.outputOf(job.view)
  }

  /** Opens a run through the shared run table; the caller announces it once its jobs are queued. */
  private openRun(): RunId
  {
    const move = runTransitionFor(this.run.status, 'start', 0) as RunTransition
    this.runCount += 1
    const runId = formatRunId(this.runCount)
    this.runRecords = []
    this.run = { ...this.run, status: move.to, runId, startedAt: this.clock.now(), pause: null, progress: emptyProgress() }
    return runId
  }

  /** Changes the run and announces it with fresh counts and workers. */
  private setRun(patch: Partial<RunState>): void
  {
    this.run = { ...this.run, ...patch, counts: this.counts(), workers: this.workers() }
    this.announcedWorkers = JSON.stringify(this.run.workers.active)
    this.emit({ type: 'run.state', run: this.run })
  }

  /** Fills free worker slots with queued jobs in queue order while the run is running, and keeps the clock ticking. */
  private dispatch(): void
  {
    if (this.run.status === 'running')
    {
      for (const id of this.order)
      {
        if (this.work.size >= PREVIEW_WORKERS)
        {
          break
        }
        const job = this.jobs.get(id) as PreviewJob
        if (job.view.state === 'queued')
        {
          this.begin(job)
        }
      }
    }
    this.announceWorkers()
    if (!this.ticking && this.work.size > 0)
    {
      this.ticking = true
      this.clock.schedule(() => this.tick(), TICK_MS)
    }
  }

  private begin(job: PreviewJob): void
  {
    const now = this.clock.now()
    const work: Work = { steps: stepsFor(job.view.recipe, durationOf(job)), step: 0, pass: 1, tick: 0, startedAt: now, abort: null }
    this.work.set(job.view.id, work)
    this.transition(job, 'dispatch', {
      startedAt: now,
      endedAt: null,
      stage: stageOf(job.view.recipe, work.steps[0], 1, now),
      progress: progressOf(work, durationOf(job), outputBytesOf(job.view), now)
    })
  }

  /** One progress interval: aborts settle, every other active job advances one tick, then the run settles and refills. */
  private tick(): void
  {
    this.ticking = false
    for (const [id, work] of [...this.work])
    {
      const job = this.jobs.get(id) as PreviewJob
      if (work.abort === null)
      {
        this.advance(job, work)
      }
      else
      {
        this.settleAbort(job, work)
      }
    }
    this.announceProgress()
    this.settleRun()
    this.dispatch()
  }

  private advance(job: PreviewJob, work: Work): void
  {
    const step = work.steps[work.step]
    const now = this.clock.now()
    work.tick += 1
    if (work.tick < step.ticks)
    {
      const progress = progressOf(work, durationOf(job), outputBytesOf(job.view), now)
      job.view = { ...job.view, progress }
      this.emit({ type: 'job.progress', jobId: job.view.id, progress })
      return
    }
    if (work.pass < step.passes)
    {
      work.pass += 1
      work.tick = 0
      const stage = stageOf(job.view.recipe, step, work.pass, now)
      job.view = { ...job.view, stage, progress: progressOf(work, durationOf(job), outputBytesOf(job.view), now) }
      this.emit({ type: 'job.stage', jobId: job.view.id, rev: job.view.rev, stage })
      return
    }
    this.finishStep(job, work, now)
  }

  /** Ends a step: the outcome its sample facts name decides verify, and the shared table names the next state. */
  private finishStep(job: PreviewJob, work: Work, now: number): void
  {
    const step = work.steps[work.step]
    if (step.state === 'verifying' && job.facts.outcome === 'fails')
    {
      this.fail(job, damagedError(job.view, now))
      return
    }
    if (step.state === 'verifying' && job.facts.outcome === 'held' && job.view.recipe.kind === 'normalize')
    {
      this.hold(job, job.view.recipe, now)
      return
    }
    if (step.state === 'finalizing')
    {
      this.place(job, now)
      return
    }
    work.step += 1
    work.pass = 1
    work.tick = 0
    this.transition(job, NEXT_TRIGGER[step.stage], {
      stage: stageOf(job.view.recipe, work.steps[work.step], 1, now),
      progress: progressOf(work, durationOf(job), outputBytesOf(job.view), now)
    })
  }

  private fail(job: PreviewJob, error: JobError): void
  {
    this.work.delete(job.view.id)
    const summary: JobErrorSummary = { code: error.code, short: error.short, message: error.message, stage: error.stage, at: error.at }
    this.transition(job, 'fail', { error: summary, stage: null, progress: null, endedAt: error.at })
    this.record(job, 'failed', null, error)
  }

  private hold(job: PreviewJob, recipe: NormalizeRecipe, now: number): void
  {
    this.work.delete(job.view.id)
    const output = this.outputFor(job)
    const stamp = stampFor(job.view, 'outside-tolerance', output.name, output.container)
    const unit = recipe.target.unit
    const measured = (stamp.loudness as NonNullable<ResultStamp['loudness']>).lufs
    const hold: JobHold =
    {
      reason: 'outside-tolerance',
      message: `The output measured ${signed(measured)} ${unit}, outside the tolerance of its ${signed(recipe.target.integratedLufs)} ${unit} target.`,
      outputPath: output.path,
      displaces: null,
      actions: ['keep', 'discard', 'retry'],
      since: now
    }
    this.transition(job, 'hold', { hold, stamp, stage: null, progress: null, endedAt: now }, 'outside-tolerance')
    this.record(job, 'held', stamp, null)
  }

  private place(job: PreviewJob, now: number): void
  {
    this.work.delete(job.view.id)
    const output = this.outputFor(job)
    const stamp = stampFor(job.view, 'verified', output.name, output.container)
    this.transition(job, NEXT_TRIGGER.place, { stamp, stage: null, progress: null, endedAt: now })
    this.record(job, 'done', stamp, null)
  }

  /** Records an abort intent on a running job (a job.updated); the next tick settles it, as a killed child exits. */
  private requestAbort(job: PreviewJob, trigger: AbortIntent, reason: StateReason): void
  {
    (this.work.get(job.view.id) as Work).abort = { trigger, reason }
    this.update(job, { abort: trigger })
  }

  private settleAbort(job: PreviewJob, work: Work): void
  {
    const { trigger, reason } = work.abort as NonNullable<Work['abort']>
    this.work.delete(job.view.id)
    if (trigger === 'requeue')
    {
      this.transition(job, 'requeue', { abort: null, stage: null, progress: null, restarts: job.view.restarts + 1 }, reason)
      return
    }
    this.transition(job, trigger, { abort: null, stage: null, progress: null, endedAt: this.clock.now() }, reason)
    this.record(job, ABORT_ENDS[trigger], null, null)
  }

  /**
   * Applies the shared run table once jobs settle: a run with nothing left drains and completes, a pausing run whose
   * active jobs have left pauses, and a canceling run whose active jobs have left ends.
   */
  private settleRun(): void
  {
    const status = this.run.status
    if (status === 'idle')
    {
      return
    }
    const runId = this.run.runId
    const inRun = [...this.jobs.values()].some((job) => job.view.runId === runId && IN_RUN_STATES.includes(job.view.state))
    if (!inRun && status !== 'canceling')
    {
      this.closeRun(runTransitionFor(status, 'drained', 0) as RunTransition)
      return
    }
    const move = this.work.size === 0 ? runTransitionFor(status, 'settled', 0) : null
    if (move === null)
    {
      return
    }
    if (move.endedBy === null)
    {
      this.setRun({ status: move.to })
      return
    }
    this.closeRun(move)
  }

  /** Ends the run: its summary joins the history, the run goes idle, and run.completed follows its last job event. */
  private closeRun(move: RunTransition): void
  {
    const now = this.clock.now()
    const summary = this.summarize(move.endedBy as BatchSummary['endedBy'], now)
    const entry: RunIndexEntry =
    {
      runId: summary.runId,
      startedAt: summary.startedAt,
      endedAt: now,
      endedBy: summary.endedBy,
      counts: summary.counts,
      bytes: summary.bytes
    }
    this.history.unshift({ entry, summary, records: this.runRecords })
    this.runRecords = []
    this.setRun({
      status: move.to,
      pause: null,
      progress: { percent: 100, etaSec: null, mediaSecPerSec: null, aggregateSpeed: null, bytesWritten: summary.bytes.output, elapsedMs: summary.elapsedMs }
    })
    this.emit({ type: 'run.completed', summary })
  }

  /** Adds a history record for a job attempt that ended or was held in the run. */
  private record(job: PreviewJob, state: HistoryRecord['state'], stamp: ResultStamp | null, error: JobError | null): void
  {
    const view = job.view
    const output = state === 'done' ? this.outputFor(job) : null
    this.runRecords.push({
      stamp,
      record:
      {
        type: 'record',
        schema: 1,
        runId: view.runId as RunId,
        jobId: view.id,
        attempt: view.attempt,
        op: view.recipe.kind,
        source: { path: view.source.path, size: view.source.size, mtimeMs: view.source.mtimeMs },
        recipe: view.recipe,
        recipeLabel: view.recipeLabel,
        state,
        startedAt: view.startedAt,
        endedAt: this.clock.now(),
        output: output === null ? null : { path: output.path, bytes: outputBytesOf(view), container: output.container },
        placement: output === null ? null : { kind: 'new' },
        plan: null,
        measurement: null,
        verification: null,
        result: null,
        error,
        warnings: [],
        attempts: [],
        rerunOf: null,
        logFile: null
      }
    })
  }

  /** The run's summary from the latest record of each of its jobs. */
  private summarize(endedBy: BatchSummary['endedBy'], now: number): BatchSummary
  {
    const latest = new Map<JobId, RunRecord>()
    for (const entry of this.runRecords)
    {
      latest.set(entry.record.jobId, entry)
    }
    const entries = [...latest.values()]
    const count = (state: HistoryRecord['state']): number => entries.filter((entry) => entry.record.state === state).length
    const placed = entries.filter((entry) => entry.record.state === 'done')
    const startedAt = this.run.startedAt as number
    return {
      runId: this.run.runId as RunId,
      startedAt,
      endedAt: now,
      elapsedMs: now - startedAt,
      endedBy,
      interruptions: 0,
      counts:
      {
        total: entries.length,
        done: placed.length,
        verified: placed.filter((entry) => entry.stamp?.verdict === 'verified').length,
        reachable: 0,
        outsideTolerance: 0,
        failed: count('failed'),
        canceled: count('canceled'),
        skipped: count('skipped'),
        held: count('held'),
        interrupted: 0,
        returned: count('failed') + count('held')
      },
      bytes:
      {
        input: entries.reduce((sum, entry) => sum + entry.record.source.size, 0),
        output: placed.reduce((sum, entry) => sum + (entry.record.output as NonNullable<HistoryRecord['output']>).bytes, 0)
      },
      mediaSec: round1(placed.reduce((sum, entry) => sum + ((entry.stamp as ResultStamp).durationSec ?? 0), 0)),
      originals: { trashed: 0, kept: 0, volumes: [] },
      previous: { trashed: 0, kept: 0 },
      recipes: recipeOutcomes(entries),
      albums: [],
      failures: entries.flatMap((entry) =>
      {
        const error = entry.record.error
        return error === null ? [] : [{ jobId: entry.record.jobId, code: error.code, short: error.short, message: error.message }]
      }),
      policy: { ...this.policy, frozenAt: startedAt, date: templateDate(startedAt) },
      ffmpeg: { version: PREVIEW_VERSION, source: 'bundled' },
      appVersion: PREVIEW_VERSION
    }
  }

  /** Announces the run's work-weighted progress while a run is open. */
  private announceProgress(): void
  {
    const runId = this.run.runId
    let jobs = 0
    let percent = 0
    let bytes = 0
    let speed = 0
    let remaining = 0
    for (const job of this.jobs.values())
    {
      if (job.view.runId !== runId)
      {
        continue
      }
      jobs += 1
      const work = this.work.get(job.view.id)
      if (work !== undefined)
      {
        const progress = job.view.progress as JobProgress
        percent += progress.percent
        bytes += progress.bytesWritten ?? 0
        speed += progress.speed ?? 0
        remaining += remainingTicks(work)
      }
      else if (job.view.state === 'queued')
      {
        remaining += remainingTicks({ steps: stepsFor(job.view.recipe, durationOf(job)), step: 0, pass: 1, tick: 0 })
      }
      else
      {
        percent += 100
        bytes += job.view.stamp?.outputBytes ?? 0
      }
    }
    const progress: RunProgress =
    {
      percent: round1(percent / Math.max(1, jobs)),
      etaSec: Math.ceil(remaining / PREVIEW_WORKERS * TICK_MS / 1000),
      mediaSecPerSec: speed > 0 ? round1(speed) : null,
      aggregateSpeed: speed > 0 ? round1(speed) : null,
      bytesWritten: bytes,
      elapsedMs: this.clock.now() - (this.run.startedAt as number)
    }
    this.run = { ...this.run, progress }
    this.emit({ type: 'run.progress', progress })
  }

  /** Announces the worker slots when what the active jobs take of them changed. */
  private announceWorkers(): void
  {
    const workers = this.workers()
    const key = JSON.stringify(workers.active)
    if (key !== this.announcedWorkers)
    {
      this.announcedWorkers = key
      this.run = { ...this.run, workers }
      this.emit({ type: 'workers.changed', workers })
    }
  }

  /**
   * Reviews pending jobs: the shared applicability rules give each job's issues, the shared template its output, and
   * outputs that collide within the review are numbered. Each job's row receives its plan summary.
   */
  preflight(ids: JobId[] | 'pending'): PreflightReport
  {
    this.preflightCount += 1
    const preflightId = `preflight-${this.preflightCount}`
    const jobs = (ids === 'pending' ? this.order : ids).flatMap((id) =>
    {
      const job = this.jobs.get(id)
      return job !== undefined && job.view.state === 'pending' ? [job] : []
    })
    const report: PreflightReport =
    {
      preflightId,
      createdAt: this.clock.now(),
      policyRev: this.policy.rev,
      capabilitiesRev: this.capabilities.rev,
      jobs: [],
      counts: { jobs: jobs.length, ready: 0, blocked: 0, willSkip: 0, renames: 0, overwrites: 0, originalsAffected: 0, containerChanges: 0, gpuJobs: 0, cpuFallbacks: 0, warnings: 0 },
      volumes: [],
      collisions: [],
      blocking: [],
      warnings: [],
      limits: this.workers().limits
    }
    const taken = new Map<string, JobId>()
    const volumes = new Map<string, number>()
    for (const job of jobs)
    {
      const view = job.view
      let output = this.outputOf(view)
      const issues = [...applicabilityIssues(view.recipe, factsFromSummary(job.facts.media), view.source.name), ...output.issues]
      const first = taken.get(output.path.toLowerCase())
      if (first !== undefined)
      {
        const renamed = numbered(output, taken)
        issues.push({
          code: 'intra-batch-collision',
          severity: 'warning',
          message: `${first} also writes ${output.name}, so this job writes ${renamed.name}.`,
          field: 'naming',
          fix: null
        })
        const collision = report.collisions.find((entry) => entry.finalPath === output.path)
        if (collision === undefined)
        {
          report.collisions.push({ finalPath: output.path, jobIds: [first, view.id], resolution: 'renamed' })
        }
        else
        {
          collision.jobIds.push(view.id)
        }
        report.counts.renames += 1
        output = renamed
      }
      taken.set(output.path.toLowerCase(), view.id)
      const errors = issues.filter((issue) => issue.severity === 'error')
      const warnings = issues.filter((issue) => issue.severity === 'warning')
      const status = errors.length > 0 ? 'blocked' : 'ready'
      report.counts[status] += 1
      report.counts.warnings += warnings.length
      report.blocking.push(...errors)
      report.warnings.push(...warnings)
      const basis = { inputsRev: view.inputsRev, policyRev: this.policy.rev, capabilitiesRev: this.capabilities.rev }
      const plan = status === 'ready' ? previewPlan(view, output, first === undefined ? 'place' : 'rename', basis) : null
      report.jobs.push({ jobId: view.id, inputsRev: view.inputsRev, status, plan, issues })
      if (status === 'ready')
      {
        const volume = volumeOf(output.path)
        volumes.set(volume, (volumes.get(volume) ?? 0) + outputBytesOf(view))
      }
      const firstIssue = errors[0] ?? warnings[0] ?? issues[0] ?? null
      job.output = output
      this.update(job, {
        plan:
        {
          status,
          current: true,
          finalName: output.name,
          relativePath: output.relativePath,
          container: output.container,
          resolution: first === undefined ? 'place' : 'rename',
          encoderLabel: encoderLabelOf(view.recipe),
          errors: errors.length,
          warnings: warnings.length,
          firstIssue: firstIssue === null ? null : { code: firstIssue.code, severity: firstIssue.severity, message: firstIssue.message }
        }
      })
    }
    report.volumes = [...volumes].map(([volume, estimatedBytes]) => ({
      volume,
      kind: 'local',
      trash: 'available',
      trashBytesFree: null,
      trashBytesNeeded: 0,
      volumeBytes: PREVIEW_VOLUME_BYTES,
      freeBytes: PREVIEW_FREE_BYTES,
      estimatedBytes,
      status: 'ok'
    }))
    this.reports.set(preflightId, report)
    this.emit({ type: 'preflight.progress', preflightId, done: jobs.length, total: jobs.length })
    return report
  }

  /** Starts the ready jobs of a review: a new run when idle, or appended to the open run. */
  start(req: JobCommandRequest<'start'>): JobCommandResponse<'start'> | CommandResult<never>
  {
    const earlier = this.starts.get(req.preflightId)
    if (earlier !== undefined)
    {
      return { ...earlier, repeated: true }
    }
    const report = this.reports.get(req.preflightId)
    if (report === undefined)
    {
      return failure('not-found', 'That review is no longer available. Review the queue again.')
    }
    if (this.run.status === 'canceling')
    {
      return failure('invalid-state', 'The batch is canceling. Start again once it has stopped.')
    }
    const changed = report.jobs.flatMap((entry) =>
    {
      const job = this.jobs.get(entry.jobId)
      return job !== undefined && job.view.inputsRev !== entry.inputsRev ? [entry.jobId] : []
    })
    if (changed.length > 0)
    {
      return { ok: false, error: { code: 'plan-stale', message: `${changed.join(', ')} changed after the review. Review again.`, issues: [], details: { changed } } }
    }
    const ready = report.jobs.flatMap((entry) =>
    {
      const job = this.jobs.get(entry.jobId)
      return job !== undefined && entry.status === 'ready' && commandApplicability('start', job.view) === 'ok' ? [job] : []
    })
    if (ready.length === 0)
    {
      return failure('invalid-state', 'No job in this review can run.')
    }
    const runId = this.run.status === 'idle' ? this.openRun() : this.run.runId as RunId
    for (const job of ready)
    {
      this.transition(job, 'start', { runId })
    }
    this.setRun({})
    const result: JobCommandResponse<'start'> =
    {
      runId,
      queued: ready.map((job) => job.view.id),
      skipped: [],
      blocked: report.jobs.filter((entry) => entry.status === 'blocked').map((entry) => entry.jobId),
      repeated: false
    }
    this.starts.set(req.preflightId, result)
    this.dispatch()
    return result
  }

  /** Pauses the run: finish-running lets active jobs finish, stop-running requeues them, as the shared run table says. */
  pause(mode: PauseMode): RunState | CommandResult<never>
  {
    const status = this.run.status
    const move = runTransitionFor(status, 'pause', this.work.size)
    const stopNow = status === 'pausing' && mode === 'stop-running'
    if (move === null && !stopNow)
    {
      return failure('invalid-state', status === 'idle' ? 'No batch is running.' : 'The batch cannot pause now.')
    }
    if (mode === 'stop-running')
    {
      for (const [id, work] of this.work)
      {
        const job = this.jobs.get(id) as PreviewJob
        if (RUNNING_STATES.includes(job.view.state) && work.abort === null)
        {
          this.requestAbort(job, 'requeue', 'requeued-pause')
        }
      }
    }
    this.setRun({ status: move?.to ?? status, pause: { mode, reason: 'user', since: this.clock.now() } })
    return this.run
  }

  resume(): RunState | CommandResult<never>
  {
    const move = runTransitionFor(this.run.status, 'resume', this.work.size)
    if (move === null)
    {
      return failure('invalid-state', 'The batch is not paused.')
    }
    this.setRun({ status: move.to, pause: null })
    this.dispatch()
    return this.run
  }

  /** Cancels the run: queued jobs end at once, running jobs once their abort settles. */
  cancelRun(): JobCommandResponse<'cancelRun'> | CommandResult<never>
  {
    const move = runTransitionFor(this.run.status, 'cancel', this.work.size)
    if (move === null)
    {
      return failure('invalid-state', 'No batch is running.')
    }
    this.run = { ...this.run, status: move.to, pause: null }
    let canceled = 0
    for (const id of this.order)
    {
      const job = this.jobs.get(id) as PreviewJob
      if (job.view.state === 'queued')
      {
        this.transition(job, 'cancel', { endedAt: this.clock.now() }, 'run-canceled')
        this.record(job, 'canceled', null, null)
        canceled += 1
      }
      else if (RUNNING_STATES.includes(job.view.state))
      {
        this.requestAbort(job, 'cancel', 'run-canceled')
        canceled += 1
      }
    }
    this.setRun({})
    this.settleRun()
    return { canceled }
  }

  /** Cancels or skips jobs the shared matrix allows: queued jobs at once, running jobs once their abort settles. */
  stop(ids: readonly JobId[], trigger: 'cancel' | 'skip'): PerJob
  {
    const result = this.perJob(ids, trigger, (job) =>
    {
      if (job.view.state === 'queued')
      {
        this.transition(job, trigger, { endedAt: this.clock.now() }, 'user')
        this.record(job, ABORT_ENDS[trigger], null, null)
      }
      else
      {
        this.requestAbort(job, trigger, 'user')
      }
    })
    this.settleRun()
    return result
  }

  /** Clears the attention of finished jobs the shared matrix allows; they keep their state and stamp. */
  acknowledge(ids: readonly JobId[]): PerJob
  {
    return this.perJob(ids, 'acknowledge', (job) => this.update(job, { acknowledged: true }))
  }

  /** Keeps the output of held jobs: each leaves its hold and is placed, done with the stamp it was held with. */
  keepOutput(ids: readonly JobId[]): PerJob
  {
    return this.perJob(ids, 'keepOutput', (job) =>
    {
      this.transition(job, 'keep', { hold: null }, 'user')
      this.transition(job, 'placed', { endedAt: this.clock.now() })
    })
  }

  /** Discards the output of held jobs, which end canceled with their source untouched. */
  discardOutput(ids: readonly JobId[]): PerJob
  {
    return this.perJob(ids, 'discardOutput', (job) =>
    {
      this.transition(job, 'discard', { hold: null, endedAt: this.clock.now() }, 'output-discarded')
    })
  }

  /**
   * Retries jobs the shared matrix allows. With start and no new recipe they join the open run, or a new one.
   * Otherwise they return to pending, with the new recipe when one is given.
   */
  retry(req: JobCommandRequest<'retry'>): JobCommandResponse<'retry'> | CommandResult<never>
  {
    const ids = req.ids === 'failed' ? this.order.filter((id) => this.view(id).state === 'failed') : req.ids
    const queue = req.start && req.recipe === null
    if (queue && this.run.status === 'canceling')
    {
      return failure('invalid-state', 'The batch is canceling. Retry once it has stopped.')
    }
    const retryable = ids.some((id) =>
    {
      const job = this.jobs.get(id)
      return job !== undefined && commandApplicability('retry', job.view) === 'ok'
    })
    const opened = queue && retryable && this.run.status === 'idle'
    const runId = !queue || !retryable ? null : opened ? this.openRun() : this.run.runId as RunId
    const queued: JobId[] = []
    const pending: JobId[] = []
    const result = this.perJob(ids, 'retry', (job) =>
    {
      const reset: JobPatch =
      {
        attempt: job.view.attempt + 1,
        error: null,
        stamp: null,
        hold: null,
        stage: null,
        progress: null,
        startedAt: null,
        endedAt: null,
        acknowledged: false,
        warnings: []
      }
      if (runId !== null)
      {
        this.transition(job, 'retry', { ...reset, runId })
        queued.push(job.view.id)
        return
      }
      const edit = req.recipe === null ? { plan: null } : this.recipePatch(job, req.recipe)
      const held = job.view.state === 'held'
      this.transition(job, held ? 'retry-changed' : 'edit-retry', { ...reset, ...edit, runId: null }, held ? 'plan-changed' : 'user')
      pending.push(job.view.id)
    })
    if (runId !== null)
    {
      this.setRun({})
      this.dispatch()
    }
    return { ...result, queued, pending, changed: [], runId }
  }

  /** Removes finished jobs in a scope; jobs that need attention stay, as the shared matrix says. */
  clear(scope: ClearScope): JobCommandResponse<'clear'>
  {
    const ids = scope.kind === 'ids' ? scope.ids : this.order
    let removed = 0
    let kept = 0
    for (const id of ids)
    {
      const job = this.jobs.get(id)
      if (job === undefined || !(scope.kind === 'done' ? job.view.state === 'done' : TERMINAL_STATES.includes(job.view.state)))
      {
        continue
      }
      if (commandApplicability('remove', job.view) === 'ok')
      {
        this.transition(job, 'remove')
        removed += 1
      }
      else
      {
        kept += 1
      }
    }
    return { removed, kept, tombstone: null }
  }

  /** The run index, newest first, a page at a time. */
  listRuns(req: JobCommandRequest<'listRuns'>): JobCommandResponse<'listRuns'>
  {
    const index = req.before === null ? -1 : this.history.findIndex((run) => run.entry.runId === req.before)
    const from = req.before !== null && index === -1 ? this.history.length : index + 1
    return {
      runs: this.history.slice(from, from + req.limit).map((run) => run.entry),
      more: from + req.limit < this.history.length,
      usage: { runs: this.history.length, historyBytes: JSON.stringify(this.history).length, logBytes: 0 }
    }
  }

  getRun(req: JobCommandRequest<'getRun'>): JobCommandResponse<'getRun'> | CommandResult<never>
  {
    const run = this.history.find((past) => past.entry.runId === req.runId)
    if (run === undefined)
    {
      return failure('not-found', `${formatRunLabel(req.runId)} is not in the history.`)
    }
    return {
      summary: run.summary,
      records: run.records.slice(req.offset, req.offset + req.limit).map((entry) => entry.record),
      total: run.records.length
    }
  }

  /** History records whose source path contains the query, newest run first, a page at a time. */
  searchRuns(req: JobCommandRequest<'searchRuns'>): JobCommandResponse<'searchRuns'>
  {
    const needle = req.query.toLowerCase()
    const all: RunSearchMatch[] = this.history.flatMap((run) => run.records
      .filter((entry) => entry.record.source.path.toLowerCase().includes(needle))
      .map((entry) => ({
        runId: entry.record.runId,
        jobId: entry.record.jobId,
        attempt: entry.record.attempt,
        sourceName: baseName(entry.record.source.path),
        sourcePath: entry.record.source.path,
        state: entry.record.state,
        verdict: entry.stamp?.verdict ?? null,
        endedAt: entry.record.endedAt,
        stamp: entry.stamp
      })))
    const before = req.before
    const from = before === null ? 0 : all.findIndex((match) => match.runId === before.runId && match.jobId === before.jobId) + 1
    return {
      matches: all.slice(from, from + req.limit),
      runs: new Set(all.map((match) => match.runId)).size,
      more: from + req.limit < all.length
    }
  }

  /** Saves a new user preset or replaces one, and pins it when asked. */
  savePreset(req: JobCommandRequest<'savePreset'>): JobCommandResponse<'savePreset'> | CommandResult<never>
  {
    const existing = this.presets.user.find((preset) => preset.id === req.id)
    if (req.id !== null && existing === undefined)
    {
      return failure('not-found', 'That preset no longer exists.')
    }
    if (this.nameTaken(req.name, req.id))
    {
      return failure('invalid-payload', 'Another preset has that name.', [{ path: 'name', message: `A preset named ${req.name} already exists.` }])
    }
    const now = this.clock.now()
    const recipe = structuredClone(req.recipe)
    let preset: UserPreset
    if (existing === undefined)
    {
      this.presetCount += 1
      preset = { id: `user-${this.presetCount}`, name: req.name, recipe, createdAt: now, updatedAt: now }
    }
    else
    {
      preset = { ...existing, name: req.name, recipe, updatedAt: now }
    }
    const user = existing === undefined ? [...this.presets.user, preset] : this.presets.user.map((entry) => entry.id === preset.id ? preset : entry)
    const pinned = req.pin === null ? { pins: this.presets.pins, unpinned: null } : pinTo(this.presets.pins, req.pin, preset.id)
    this.setPresets({ ...this.presets, user, pins: pinned.pins })
    return { preset, unpinned: pinned.unpinned }
  }

  renamePreset(req: JobCommandRequest<'renamePreset'>): JobCommandResponse<'renamePreset'> | CommandResult<never>
  {
    const existing = this.presets.user.find((preset) => preset.id === req.id)
    if (existing === undefined)
    {
      return failure('not-found', 'That preset no longer exists.')
    }
    if (this.nameTaken(req.name, req.id))
    {
      return failure('invalid-payload', 'Another preset has that name.', [{ path: 'name', message: `A preset named ${req.name} already exists.` }])
    }
    const preset: UserPreset = { ...existing, name: req.name, updatedAt: this.clock.now() }
    this.setPresets({ ...this.presets, user: this.presets.user.map((entry) => entry.id === preset.id ? preset : entry) })
    return preset
  }

  /** Removes a user preset and its pins; jobs keep their copies and read as from a deleted preset. */
  removePreset(req: JobCommandRequest<'removePreset'>): null | CommandResult<never>
  {
    if (!this.presets.user.some((preset) => preset.id === req.id))
    {
      return failure('not-found', 'That preset no longer exists.')
    }
    const pins = Object.fromEntries(Object.entries(this.presets.pins).filter(([, id]) => id !== req.id)) as PresetState['pins']
    this.setPresets({ ...this.presets, user: this.presets.user.filter((preset) => preset.id !== req.id), pins })
    return null
  }

  /** Pins a built-in or user preset to a key, or clears the key. */
  setPin(req: JobCommandRequest<'setPin'>): JobCommandResponse<'setPin'> | CommandResult<never>
  {
    if (req.presetId !== null && findPreset(req.presetId, this.presets.user) === null)
    {
      return failure('not-found', 'That preset does not exist.')
    }
    const pinned = pinTo(this.presets.pins, req.key, req.presetId)
    this.setPresets({ ...this.presets, pins: pinned.pins })
    return { unpinned: pinned.unpinned }
  }

  private nameTaken(name: string, id: string | null): boolean
  {
    const wanted = name.toLowerCase()
    return this.presets.user.some((preset) => preset.id !== id && preset.name.toLowerCase() === wanted)
  }

  /** Announces the presets; rows whose user preset changed name or went away read their new label. */
  private setPresets(presets: PresetState): void
  {
    this.presets = presets
    this.emit({ type: 'presets.changed', presets })
    for (const id of this.order)
    {
      const job = this.jobs.get(id) as PreviewJob
      const label = this.label(job.view.recipe)
      if (label !== job.view.recipeLabel)
      {
        this.update(job, { recipeLabel: label })
      }
    }
  }
}

type Outcome<K extends JobCommandName> = JobCommandResponse<K> | CommandResult<never>

function isFailure(value: unknown): value is CommandResult<never>
{
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok: unknown }).ok === false
}

/**
 * Handles one command as the IPC wrapper does: the shared request validator first, then the handler, whose value is
 * cloned like a structured-clone reply and carries the last event it caused. Anything thrown becomes internal.
 */
function command<K extends JobCommandName>(engine: PreviewEngine, name: K, raw: JobCommandRequest<K>, run: (req: JobCommandRequest<K>) => Outcome<K>): Promise<CommandResult<JobCommandResponse<K>>>
{
  const checked = REQUEST_VALIDATORS[name](raw) as Validated<JobCommandRequest<K>>
  if (!checked.ok)
  {
    return Promise.resolve(failure('invalid-payload', `The ${JOB_CHANNELS[name]} request is not valid.`, checked.issues))
  }
  const before = engine.seq
  try
  {
    const value = run(checked.value)
    if (isFailure(value))
    {
      return Promise.resolve(value)
    }
    return Promise.resolve({ ok: true, value: structuredClone(value), seq: engine.seq > before ? engine.seq : 0 })
  }
  catch (err)
  {
    return Promise.resolve(failure('internal', err instanceof Error ? err.message : String(err)))
  }
}

/**
 * A complete jobs API backed by an in-memory engine with sample media, for the Batch page in development before the
 * engine exists. Pass it to useJobs or startJobsSync like the preload's api. Commands outside the page's flow answer
 * with a typed error.
 */
export function createPreviewJobsApi(options: PreviewJobsOptions = {}): JobsApi
{
  const engine = new PreviewEngine(options)
  const on = <K extends JobCommandName>(name: K, run: (req: JobCommandRequest<K>) => Outcome<K>) =>
    (req: JobCommandRequest<K>): Promise<CommandResult<JobCommandResponse<K>>> => command(engine, name, req, run)
  const off = (name: JobCommandName) => (): Promise<CommandResult<never>> => Promise.resolve(notInPreview(name))
  return {
    subscribe: on('subscribe', (req) => engine.subscribe(req.clientId)),
    unsubscribe: on('unsubscribe', (req) => engine.unsubscribe(req.clientId)),
    get: off('get'),
    add: on('add', (req) => engine.add(req)),
    pasteFiles: off('pasteFiles'),
    cancelScan: off('cancelScan'),
    forgetFolder: off('forgetFolder'),
    clearRecentFolders: off('clearRecentFolders'),
    remove: on('remove', (req) => engine.remove(req.ids)),
    restore: off('restore'),
    reorder: on('reorder', (req) => engine.reorder(req.ids, req.before)),
    assignRecipe: on('assignRecipe', (req) => engine.assignRecipe(req.assignments)),
    duplicate: off('duplicate'),
    locate: off('locate'),
    relink: off('relink'),
    reprobe: off('reprobe'),
    setPolicy: off('setPolicy'),
    setDefaultRecipe: on('setDefaultRecipe', (req) => engine.setDefaultRecipe(req.recipe)),
    preflight: on('preflight', (req) => engine.preflight(req.ids)),
    analyze: off('analyze'),
    cancelAnalyze: off('cancelAnalyze'),
    start: on('start', (req) => engine.start(req)),
    pause: on('pause', (req) => engine.pause(req.mode)),
    resume: on('resume', () => engine.resume()),
    cancelRun: on('cancelRun', () => engine.cancelRun()),
    setWorkers: off('setWorkers'),
    setSettings: off('setSettings'),
    dismissAlert: off('dismissAlert'),
    revealAlert: off('revealAlert'),
    cancel: on('cancel', (req) => engine.stop(req.ids, 'cancel')),
    skip: on('skip', (req) => engine.stop(req.ids, 'skip')),
    unqueue: off('unqueue'),
    retry: on('retry', (req) => engine.retry(req)),
    keepOutput: on('keepOutput', (req) => engine.keepOutput(req.ids)),
    discardOutput: on('discardOutput', (req) => engine.discardOutput(req.ids)),
    acknowledge: on('acknowledge', (req) => engine.acknowledge(req.ids)),
    clear: on('clear', (req) => engine.clear(req.scope)),
    log: off('log'),
    reveal: off('reveal'),
    exportReport: off('exportReport'),
    listRuns: on('listRuns', (req) => engine.listRuns(req)),
    getRun: on('getRun', (req) => engine.getRun(req)),
    searchRuns: on('searchRuns', (req) => engine.searchRuns(req)),
    rerun: off('rerun'),
    deleteRuns: off('deleteRuns'),
    revealRecord: off('revealRecord'),
    savePreset: on('savePreset', (req) => engine.savePreset(req)),
    renamePreset: on('renamePreset', (req) => engine.renamePreset(req)),
    removePreset: on('removePreset', (req) => engine.removePreset(req)),
    setPin: on('setPin', (req) => engine.setPin(req)),
    onEvents: (cb) => engine.listen(cb)
  }
}
