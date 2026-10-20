/**
 * The job domain shared by the engine, the preload, and the renderer: jobs and their states, stages, progress,
 * measurements, verification, results, errors, holds, the batch policy, run state and summaries, history records,
 * the per-job plan and the preflight report, row views, the selected job's detail, and the snapshot a window
 * receives when it subscribes. Every type is plain data that survives structured clone and JSON.
 */
import type { StaticStreamPlan, StreamMeasurement } from '../audio/events'
import type { MessageRef } from '../audio/messages'
import type { GainMode, GainPlan, LoudnessUnit, MeasureStatus, MediaFacts, Outcome, PlanReason, StreamVerdict, VerifiedStream } from '../audio/types'
import type { Platform } from '../text/platform'
import type { JobId, RunId } from './ids'
import type { AudioOut, ChannelRule, CompressTarget, Operation, Recipe, StreamPick, VideoEncoder } from './recipes'

/** Every job state, in lifecycle order. */
export const JOB_STATES = [
  'pending', 'queued',
  'analyzing', 'encoding', 'verifying', 'finalizing',
  'held',
  'done', 'failed', 'canceled', 'skipped', 'interrupted'
] as const

/** A job's state. */
export type JobState = typeof JOB_STATES[number]

/** States in which a job holds a worker slot. */
export const ACTIVE_STATES: readonly JobState[] = ['analyzing', 'encoding', 'verifying', 'finalizing']

/** States a job leaves only through a user command. */
export const TERMINAL_STATES: readonly JobState[] = ['done', 'failed', 'canceled', 'skipped', 'interrupted']

/** Why a job entered its state. */
export type StateReason =
  | 'user' | 'dispatch' | 'engine' | 'run-canceled' | 'output-exists' | 'destination-appeared'
  | 'requeued-pause' | 'requeued-gpu' | 'requeued-cpu' | 'requeued-disk'
  | 'plan-blocked' | 'destructive-scope' | 'source-changed' | 'plan-changed'
  | 'outside-tolerance' | 'file-locked' | 'storage-unavailable' | 'output-discarded' | 'interrupted-finalize'
  | 'quit' | 'crash' | 'session-end' | 'restored'

/** The pending abort of an active job, from the command until the child has exited. */
export type AbortIntent = 'cancel' | 'skip' | 'requeue'

/** A stage of a job's work. */
export type StageId =
  | 'probe' | 'measure' | 'measure-dynamics' | 'measure-album'
  | 'encode' | 'verify' | 'place' | 'trash' | 'wait-lock'

/** The stage a job is in; label is what the row shows (audio jobs use the audio stage labels). */
export interface JobStage
{
  id: StageId
  pass: number
  passes: number
  label: string
  startedAt: number
}

/** A job's progress; percent never decreases within an attempt. */
export interface JobProgress
{
  stage: StageId
  pass: number
  passes: number
  percent: number
  stagePercent: number | null
  /** FFmpeg's realtime multiple; null for N/A and 0x. */
  speed: number | null
  etaSec: number | null
  outTimeSec: number | null
  /** The media span this pass processes: the trimmed range for Extract. */
  durationSec: number | null
  bytesWritten: number | null
  elapsedMs: number
}

/** A job's source file. */
export interface SourceRef
{
  path: string
  name: string
  ext: string
  dir: string
  size: number
  mtimeMs: number
  origin: 'files' | 'folder' | 'drop'
  /** The folder below the scanned root, for the {subdir} token; '' for files added directly. */
  subdir: string
}

/** What a row shows of a probed source. */
export interface MediaSummary
{
  container: string
  durationSec: number | null
  video: { codec: string; width: number; height: number; rotation: number; fps: number | null } | null
  audio: Array<{ codec: string; channels: number; layout: string | null; sampleRate: number; bitsPerSample: number | null; bitrateKbps: number | null; language: string | null; isDefault: boolean }>
  subtitles: number
  attachments: number
  chapters: number
  cover: boolean
}

/** Where a terminal job's record line sits in its run's history file. */
export interface HistoryRef
{
  runId: RunId
  offset: number
  length: number
}

/** One earlier attempt of a job. */
export interface AttemptRecord
{
  attempt: number
  runId: RunId | null
  recipe: Recipe
  state: 'done' | 'failed' | 'canceled' | 'skipped' | 'interrupted'
  startedAt: number | null
  endedAt: number
  verdict: Verdict | null
  errorCode: JobErrorCode | null
}

/** The engine's record of one job. A catalog number names it everywhere; a retry keeps it and increments attempt. */
export interface Job
{
  id: JobId
  seq: number
  /** Increments on every change to the record. */
  rev: number
  /** Increments only when something a plan depends on changes: the recipe or the source identity. */
  inputsRev: number
  source: SourceRef
  recipe: Recipe
  state: JobState
  reason: StateReason
  attempt: number
  /** Requeues of the same attempt (pause now, a GPU session error, the CPU fallback, a full disk). */
  restarts: number
  /** Executions across attempts and restarts; names the execution's work folder. */
  execution: number
  abort: AbortIntent | null
  stage: JobStage | null
  progress: JobProgress | null
  media: MediaSummary | null
  probe: 'pending' | 'ok' | 'failed'
  plan: JobPlan | null
  policy: FrozenPolicy | null
  measurement: JobMeasurement | null
  verification: Verification | null
  result: JobResult | null
  error: JobError | null
  hold: JobHold | null
  attempts: AttemptRecord[]
  waiting: 'album' | 'gpu-session' | 'disk-space' | 'volume-offline' | null
  /** What a waiting job waits for in the page's words: the volume for volume-offline and disk-space. */
  waitingOn: string | null
  analysis: 'queued' | 'running' | null
  /** The gain plan the job runs with was measured before its Start. */
  previewed: boolean
  warnings: JobWarning[]
  acknowledged: boolean
  runId: RunId | null
  rerunOf: { runId: RunId; jobId: JobId } | null
  addedAt: number
  startedAt: number | null
  endedAt: number | null
  workDir: string | null
  history: HistoryRef | null
}

/** One album group's loudest-track anchor and the gain every member shares. */
export interface AlbumSummary
{
  groupId: string
  members: number
  anchorJobId: JobId
  anchorLufs: number
  gainDb: number
  reason: PlanReason
}

/** A measurement with the gain plans it led to; 'preview' marks one taken before the run. */
export interface JobMeasurement
{
  pass: 'source' | 'after-dynamics' | 'preview'
  measuredAt: number
  streams: Array<{ measurement: StreamMeasurement; plan: GainPlan | null }>
  album: AlbumSummary | null
  messages: MessageRef[]
}

/** A verified outcome, the audio module's outcome words for every operation. */
export type Verdict = Outcome

/** Verification of a Convert, Compress, or Extract output. */
export interface MediaVerification
{
  decode: 'full' | 'sampled'
  /** The first 20 decode-error lines. */
  decodeErrors: string[]
  decodeErrorCount: number
  durationSec: number | null
  expectedDurationSec: number | null
  duration: 'within' | 'outside' | 'not-checked'
  streams: { video: number; audio: number; subtitle: number; attachment: number }
  streamMatch: boolean
  size: { bytes: number; targetBytes: number | null; status: 'within' | 'over' | 'not-checked' }
  frames: number | null
  cues: number | null
}

/** The verified output values and the verdict: per audio stream, or per file for media operations. */
export interface Verification
{
  verdict: Verdict
  encodePasses: number
  audio: Array<{ verified: VerifiedStream | null; verdict: StreamVerdict }> | null
  media: MediaVerification | null
  messages: MessageRef[]
}

/** Every warning a done job keeps lit until acknowledged. */
export const JOB_WARNING_CODES = [
  'original-kept', 'previous-kept', 'ran-on-cpu', 'source-changed',
  'below-target-unpreviewed', 'outside-tolerance-placed', 'larger-than-source', 'decoded-overshoot'
] as const

/** A done job's warning code. */
export type JobWarningCode = typeof JOB_WARNING_CODES[number]

/** A warning with its short reason and its sentence. */
export interface JobWarning
{
  code: JobWarningCode
  short: string
  message: string
}

/** What happened to a file an output displaced. */
export type TrashOutcome =
  | { status: 'trashed' }
  | { status: 'kept'; path: string; reason: string }

/** How an output was placed. */
export type Placement =
  | { kind: 'new' }
  | { kind: 'renamed'; planned: string }
  | { kind: 'overwrote'; previous: TrashOutcome }
  | { kind: 'replaced-original'; original: TrashOutcome }

/** Exactly what a row stamp prints; it exists only when a verification ran, so it never shows a planned value. */
export interface ResultStamp
{
  verdict: Verdict
  outputName: string
  container: string
  inputBytes: number
  outputBytes: number
  durationSec: number | null
  decode: 'full' | 'sampled' | null
  audioStreams: number
  /** The audio stream that set the verdict, the worst one. */
  verdictStream: number | null
  loudness:
  {
    lufs: number
    unit: LoudnessUnit
    reference: 'target' | 'reachable'
    referenceLufs: number | null
    deviation: number | null
    deviationUnit: 'LU' | 'dB'
    /** The job's own app check. */
    check: number
    checkClass: 'lossless' | 'lossy'
    status: 'within' | 'below' | 'above' | 'not-checked'
  } | null
  /** dbtp is the decoded output's true peak; preEncodeDbtp is the value the preset's maximum is judged on. */
  truePeak: { dbtp: number; preEncodeDbtp: number | null; limitDbtp: number; status: 'within' | 'over' } | null
  size: { targetBytes: number; status: 'within' | 'over' } | null
  frames: number | null
  cues: number | null
  placement: Placement['kind']
  warnings: number
}

/** A finished job's output and how it got there. */
export interface JobResult
{
  outputPath: string
  outputKind: 'file' | 'folder'
  container: string
  inputBytes: number
  outputBytes: number
  durationSec: number | null
  elapsedMs: number
  encoder: { video: string | null; audio: string[] }
  placement: Placement
  stamp: ResultStamp
  warnings: JobWarning[]
  notes: string[]
}

/** Every job error code. */
export const JOB_ERROR_CODES = [
  'ffmpeg-failed', 'ffmpeg-unavailable', 'probe-failed', 'not-media', 'source-missing', 'source-offline',
  'plan-refused', 'measure-failed', 'decode-errors', 'output-unreadable', 'disk-full', 'permission-denied',
  'destination-missing', 'file-locked', 'gpu-session-limit', 'gpu-init-failed', 'album-measure-failed',
  'held-output-missing', 'internal'
] as const

/** Why a job failed. */
export type JobErrorCode = typeof JOB_ERROR_CODES[number]

/** A job's failure with what the failure stamp needs to explain and repeat it. */
export interface JobError
{
  code: JobErrorCode
  /** The two-to-three-word reason stamps, toasts, and reason groups print. */
  short: string
  /** The category an ffmpeg-failed error was classified into. */
  cause: 'decode' | 'encoder' | 'muxer' | 'other' | null
  /** The cause first. */
  message: string
  stage: StageId
  attempt: number
  encodePass: number | null
  /** Signed. */
  exitCode: number | null
  exitName: string | null
  signal: string | null
  /** The last 2 KiB of the failing process, cut at a line boundary. */
  stderrTail: string
  command: { argv: string[]; display: string } | null
  fsError: { code: string; syscall: string; path: string } | null
  hint: string | null
  at: number
}

/** A verified output waiting in its work folder for a decision. */
export interface JobHold
{
  reason: 'outside-tolerance' | 'destination-appeared' | 'file-locked' | 'storage-unavailable' | 'interrupted-finalize'
  message: string
  outputPath: string
  displaces: string | null
  actions: Array<'keep' | 'keep-renamed' | 'discard' | 'retry'>
  since: number
}

/** What happens when an output's path already holds a file. */
export type ConflictRule = 'skip' | 'rename' | 'overwrite'

/** Every conflict rule. */
export const CONFLICT_RULES: readonly ConflictRule[] = ['skip', 'rename', 'overwrite']

/** Where outputs go. */
export type Destination =
  | { mode: 'folder'; folder: string }
  | { mode: 'next-to-source' }
  | { mode: 'replace-originals' }

/** The queue's output policy; it changes outputs, so a job freezes the one its plan saw. */
export interface BatchPolicy
{
  rev: number
  destination: Destination
  template: string
  conflict: ConflictRule
  /** What happens to a file an output displaces: the OS bin, or kept beside the output. */
  displaced: 'trash' | 'keep'
  gpu: 'off' | 'auto' | 'require'
}

/** The policy a job froze at dispatch; date is the run's start date, the value of {date}. */
export interface FrozenPolicy extends BatchPolicy
{
  frozenAt: number
  date: string
}

/** The tokens a naming template may use. */
export const TEMPLATE_TOKENS = ['name', 'ext', 'op', 'preset', 'catalog', 'date', 'subdir'] as const

/** The template a destination starts with. */
export const DEFAULT_TEMPLATES = { 'folder': '{name}', 'next-to-source': '{name}-{op}' } as const

/** Settings that do not change outputs and are read live. */
export interface RunSettings
{
  workers: { mode: 'auto' } | { mode: 'fixed'; count: number }
  gpuSessions: { mode: 'auto' } | { mode: 'fixed'; count: number }
  priority: 'below-normal' | 'normal'
  keepAwake: boolean
  verifyVideo: 'full' | 'sampled'
  notify: { completion: boolean; firstFailure: boolean }
  /** "Measure loudness when Review opens". */
  measureOnReview: boolean
  /** The Add menu's "Include subfolders". */
  includeSubfolders: boolean
}

/** The run's status. */
export type RunStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'canceling'

/** How a pause treats running jobs. */
export type PauseMode = 'finish-running' | 'stop-running'

/** Every pause mode. */
export const PAUSE_MODES: readonly PauseMode[] = ['finish-running', 'stop-running']

/** Why the run paused. */
export type PauseReason = 'user' | 'disk-space' | 'storage' | 'destination-unavailable' | 'ffmpeg-unavailable' | 'restored' | 'quit-pending'

/** Jobs per state. */
export type JobCounts = Record<JobState, number>

/** The run's progress; percent is work-weighted and can fall when jobs are appended. */
export interface RunProgress
{
  percent: number
  etaSec: number | null
  mediaSecPerSec: number | null
  aggregateSpeed: number | null
  bytesWritten: number
  elapsedMs: number
}

/** Worker slots: the setting, the limits, and what is taken (starting counts dispatch claims). */
export interface WorkersState
{
  setting: RunSettings['workers']
  limits: { total: number; videoCpu: number; gpu: number }
  active: { total: number; videoCpu: number; gpu: number; analysis: number; starting: number }
}

/** The run as the header shows it. */
export interface RunState
{
  status: RunStatus
  runId: RunId | null
  startedAt: number | null
  pause: { mode: PauseMode; reason: PauseReason; since: number } | null
  counts: JobCounts
  progress: RunProgress
  workers: WorkersState
  quitWhenIdle: boolean
  needsAck: { originalsAffected: number; overwrites: number } | null
}

/** One recipe's outcomes in a run, grouped by recipe label. */
export interface RecipeOutcome
{
  op: Operation
  label: string
  presetId: string | null
  userPresetId: string | null
  jobs: number
  verified: number
  reachable: number
  outsideTolerance: number
  returned: number
  loudness:
  {
    unit: LoudnessUnit
    targetLufs: number | null
    deviationUnit: 'LU' | 'dB'
    checks: Array<{ checkClass: 'lossless' | 'lossy'; check: number; jobs: number; within: number }>
    minLufs: number | null
    maxLufs: number | null
    streams: number
    maxTruePeakDbtp: number | null
    limitedJobs: number
    maxLimitingDb: number | null
    reachableLevels: number[]
  } | null
  size: { targetBytes: number; jobs: number; within: number } | null
}

/** A finished run. Counts use the page's words: returned is failed, interrupted, held, and placed outside tolerance. */
export interface BatchSummary
{
  runId: RunId
  startedAt: number
  endedAt: number
  elapsedMs: number
  endedBy: 'completed' | 'canceled'
  interruptions: number
  counts:
  {
    total: number
    done: number
    verified: number
    reachable: number
    outsideTolerance: number
    failed: number
    canceled: number
    skipped: number
    held: number
    interrupted: number
    returned: number
  }
  bytes: { input: number; output: number }
  /** The media duration processed. */
  mediaSec: number
  originals: { trashed: number; kept: number; volumes: Array<{ volume: string; trashed: number }> }
  previous: { trashed: number; kept: number }
  recipes: RecipeOutcome[]
  albums: AlbumSummary[]
  failures: Array<{ jobId: JobId; code: JobErrorCode; short: string; message: string }>
  policy: FrozenPolicy
  ffmpeg: { version: string; source: 'bundled' | 'path' | 'custom' }
  appVersion: string
}

/** A self-contained history line for one job attempt. */
export interface HistoryRecord
{
  type: 'record'
  schema: 1
  runId: RunId
  jobId: JobId
  attempt: number
  op: Operation
  source: { path: string; size: number; mtimeMs: number }
  recipe: Recipe
  recipeLabel: string
  state: 'done' | 'failed' | 'canceled' | 'skipped' | 'interrupted' | 'held'
  startedAt: number | null
  endedAt: number
  output: { path: string; bytes: number; container: string } | null
  placement: Placement | null
  plan: JobPlan | null
  measurement: JobMeasurement | null
  verification: Verification | null
  result: JobResult | null
  error: JobError | null
  warnings: JobWarning[]
  attempts: AttemptRecord[]
  rerunOf: { runId: RunId; jobId: JobId } | null
  logFile: string | null
}

/** A line of a run's history file. */
export type HistoryLine =
  | HistoryRecord
  | { type: 'summary'; schema: 1; summary: BatchSummary }

/** A run in the run index. */
export interface RunIndexEntry
{
  runId: RunId
  startedAt: number
  endedAt: number | null
  endedBy: BatchSummary['endedBy'] | null
  counts: BatchSummary['counts']
  bytes: BatchSummary['bytes']
}

/** Every plan issue code. */
export const PLAN_ISSUE_CODES = [
  'source-missing', 'source-unreadable', 'source-changed', 'not-media', 'probe-failed',
  'no-audio-stream', 'no-video-stream', 'audio-only-output', 'stream-not-found', 'subtitle-bitmap',
  'destination-invalid', 'destination-not-writable',
  'template-unknown-token', 'template-empty', 'template-escapes', 'template-sanitized', 'path-long',
  'output-exists', 'intra-batch-collision', 'same-as-source', 'overwrites-another-source', 'source-is-pending-output',
  'replace-extension-change', 'extract-never-replaces', 'replace-one-job-per-source', 'no-recycle-bin', 'trash-too-small',
  'ffmpeg-unavailable', 'ffmpeg-below-minimum', 'self-test-failed', 'surround-meter-failed', 'encoder-missing', 'gpu-unavailable', 'gpu-downgrade',
  'lossless-unsupported', 'tune-unsupported', 'container-cannot-hold', 'container-changed',
  'layout-remapped', 'layout-unsupported', 'too-many-channels', 'sample-rate-unsupported', 'odd-dimensions', 'keyframe-trim',
  'streams-dropped', 'chapters-dropped', 'disk-tight', 'disk-insufficient', 'album-mismatch', 'album-incomplete', 'invalid-recipe'
] as const

/** A plan issue code. */
export type PlanIssueCode = typeof PLAN_ISSUE_CODES[number]

/** One recipe field a fix sets on the jobs whose issue carries it. */
export type RecipePatch =
  | { field: 'audio'; value: AudioOut }
  | { field: 'channels'; value: ChannelRule }
  | { field: 'downmix'; value: 'standard' }
  | { field: 'sampleRate'; value: number }
  | { field: 'video-encoder'; value: VideoEncoder | 'copy' }
  | { field: 'compress-target'; value: CompressTarget; encoder: VideoEncoder }
  | { field: 'extract-reencode'; value: { encoder: 'libx264' | 'libvpx-vp9'; crf: number } }
  | { field: 'stream'; value: StreamPick }

/** A fix the page can apply; batch fixes change the policy, jobs fixes change exactly the jobs whose issue carries them. */
export type PlanFix =
  | { kind: 'set-conflict-rule'; rule: ConflictRule; scope: 'batch' }
  | { kind: 'add-token'; token: '{subdir}' | '{ext}' | '{catalog}'; scope: 'batch' }
  | { kind: 'set-gpu'; gpu: BatchPolicy['gpu']; scope: 'batch' }
  | { kind: 'set-displaced'; displaced: 'keep'; scope: 'batch' }
  | { kind: 'set-destination'; destination: 'next-to-source'; scope: 'batch' }
  | { kind: 'set-container'; container: string; scope: 'jobs' }
  | { kind: 'patch-recipe'; label: string; patch: RecipePatch; scope: 'jobs' }
  | { kind: 'remove'; scope: 'jobs' }

/** A problem the planner found, with its final display text. */
export interface PlanIssue
{
  code: PlanIssueCode
  severity: 'error' | 'warning' | 'info'
  message: string
  field: 'source' | 'destination' | 'naming' | 'recipe' | 'streams' | 'encoder' | 'container' | 'disk' | 'album'
  fix: PlanFix | null
}

/** How a volume is attached. */
export type VolumeKind = 'local' | 'removable' | 'network' | 'unknown'

/** Whether a volume has an OS bin to send displaced files to. */
export type TrashAvailability = 'available' | 'unavailable' | 'unknown'

/** Where an output goes and what it displaces. */
export interface OutputPlan
{
  kind: 'file' | 'folder'
  finalPath: string
  container: string
  /** The FFmpeg muxer passed as -f; image2 for frame folders. */
  muxer: string
  containerChanged: { from: string; reason: string } | null
  conflict: 'none' | 'exists' | 'collides'
  resolution: 'place' | 'skip' | 'rename' | 'overwrite' | 'replace-original'
  renamedTo: string | null
  displaces: string | null
}

/** The video encode of a plan. */
export interface VideoPlan
{
  encoder: string
  gpu: string | null
  lossless: 'exact' | 'none' | 'not-requested'
  passes: 1 | 2
  filters: string[]
  notes: string[]
}

/** A job's full plan, computed against the basis it records. */
export interface JobPlan
{
  basis: { inputsRev: number; policyRev: number; capabilitiesRev: number }
  /** What neither a source change at dispatch nor a retry may change silently. */
  fingerprint: string
  source: { path: string; size: number; mtimeMs: number }
  output: OutputPlan
  streams:
  {
    kept: Array<{ kind: string; source: number; output: number; action: 'copy' | 'encode' | 'convert' }>
    dropped: Array<{ kind: string; source: number; reason: string }>
    chapters: 'kept' | 'dropped' | 'none'
  }
  /** cpuFallback exists only for a GPU plan under GPU auto. */
  video: (VideoPlan & { cpuFallback: VideoPlan | null }) | null
  audio: Array<StaticStreamPlan & { bitsPerSample: number | null; messages: MessageRef[] }>
  class: 'audio' | 'copy' | 'video-cpu' | 'video-gpu'
  stages: Array<{ id: StageId; passes: number }>
  estimate: { outputBytes: number | null; reserveBytes: number; workSec: number | null; confidence: 'low' | 'medium' | 'high' }
  album: { groupId: string; members: number } | null
  /** The planned command, with measurement-dependent values written as placeholders. */
  command: { argv: string[]; display: string; placeholders: string[] } | null
}

/** A volume a report writes to or reads from. */
export interface VolumeReport
{
  volume: string
  kind: VolumeKind
  trash: TrashAvailability
  trashBytesFree: number | null
  trashBytesNeeded: number
  volumeBytes: number | null
  freeBytes: number | null
  estimatedBytes: number
  status: 'ok' | 'tight' | 'insufficient' | 'unknown'
}

/** The Review step's report; Start runs exactly the plans it holds. */
export interface PreflightReport
{
  preflightId: string
  createdAt: number
  policyRev: number
  capabilitiesRev: number
  jobs: Array<{ jobId: JobId; inputsRev: number; status: 'ready' | 'blocked' | 'will-skip'; plan: JobPlan | null; issues: PlanIssue[] }>
  counts:
  {
    jobs: number
    ready: number
    blocked: number
    willSkip: number
    renames: number
    overwrites: number
    originalsAffected: number
    containerChanges: number
    gpuJobs: number
    cpuFallbacks: number
    warnings: number
  }
  volumes: VolumeReport[]
  collisions: Array<{ finalPath: string; jobIds: JobId[]; resolution: 'renamed' | 'blocked' }>
  blocking: PlanIssue[]
  warnings: PlanIssue[]
  limits: WorkersState['limits']
}

/** What the Review columns print without fetching the plan. */
export interface PlanSummary
{
  status: 'ready' | 'blocked' | 'will-skip'
  /** False from the turn the plan stops matching its basis until its re-plan commits. */
  current: boolean
  finalName: string
  /** The output path relative to the destination folder, or to the source's folder. */
  relativePath: string
  container: string
  resolution: OutputPlan['resolution']
  /** The encoder that will run, in the page's short form ("AAC 256k", "x264 2-pass", "copy"). */
  encoderLabel: string
  errors: number
  warnings: number
  /** The job's most severe issue. */
  firstIssue: { code: PlanIssueCode; severity: PlanIssue['severity']; message: string } | null
}

/** One audio stream's cell in the Audio plan column. */
export interface AudioPlanCell
{
  audioIndex: number
  mode: GainMode
  gainDb: number
  requestedGainDb: number
  limitingDb: number
  predictedLufs: number | null
  unit: LoudnessUnit
  status: MeasureStatus
}

/** The error a row shows. */
export interface JobErrorSummary
{
  code: JobErrorCode
  short: string
  message: string
  stage: StageId
  at: number
}

/** A row: no stderr and no full plan. */
export interface JobView
{
  id: JobId
  seq: number
  rev: number
  inputsRev: number
  source: SourceRef
  recipe: Recipe
  recipeLabel: string
  state: JobState
  reason: StateReason
  attempt: number
  restarts: number
  abort: AbortIntent | null
  stage: JobStage | null
  progress: JobProgress | null
  media: MediaSummary | null
  probe: Job['probe']
  plan: PlanSummary | null
  /** One cell per audio stream from the latest gain plans; null until measured. */
  audioPlan: AudioPlanCell[] | null
  stamp: ResultStamp | null
  error: JobErrorSummary | null
  warnings: JobWarning[]
  hold: JobHold | null
  waiting: Job['waiting']
  waitingOn: string | null
  analysis: Job['analysis']
  previewed: boolean
  acknowledged: boolean
  runId: RunId | null
  rerunOf: Job['rerunOf']
  addedAt: number
  startedAt: number | null
  endedAt: number | null
  albumGroupId: string | null
}

/** A row change; a patch clears a field only by setting it to null. */
export type JobPatch = Partial<Omit<JobView, 'id' | 'seq'>>

/** The selected job's detail. */
export interface JobDetail
{
  view: JobView
  plan: JobPlan | null
  media: MediaFacts | null
  measurement: JobMeasurement | null
  verification: Verification | null
  result: JobResult | null
  error: JobError | null
  /** The last 16 KiB of the attempt log. */
  stderrTail: string | null
  stages: Array<{ id: StageId; pass: number; passes: number; label: string; startedAt: number; endedAt: number | null; outcome: 'done' | 'active' | 'failed' | 'skipped' }>
  commands: Array<{ stage: StageId; encodePass: number | null; display: string }>
  attempts: AttemptRecord[]
}

/** What this machine and FFmpeg build can do. */
export interface CapabilitySummary
{
  rev: number
  ffmpeg:
  {
    ready: boolean
    version: string | null
    source: 'bundled' | 'path' | 'custom' | null
    meetsMinimum: boolean
    selfTest: 'passed' | 'failed' | 'pending' | null
    soxr: boolean
    /** False when the build meters more than two channels wrong, so loudness jobs on surround streams are refused. */
    surroundMeter: boolean
  }
  encoders: string[]
  gpu: { status: 'detecting' | 'ready'; vendor: 'nvidia' | 'intel' | 'amd' | null; name: string | null; encoders: string[] }
  cpuCount: number
  platform: Platform
}

/** A folder scan; failed carries the error that stopped it. */
export interface ScanState
{
  scanId: string
  root: string
  status: 'scanning' | 'done' | 'canceled' | 'failed'
  error: string | null
  visited: number
  added: number
  excluded:
  {
    links: number
    unreadable: number
    workFiles: number
    unsupported: number
    overLimit: number
    outputFolder: number
    previousOutputs: number
    duplicates: number
  }
}

/** Every run alert kind. */
export const RUN_ALERT_KINDS = [
  'disk-space', 'gpu-sessions', 'ffmpeg-unavailable', 'cleanup-pending', 'restored-run', 'restored-queue',
  'volume-offline', 'destination-unavailable', 'queue-recovered', 'storage-error', 'replace-migrated'
] as const

/** A run alert kind. */
export type RunAlertKind = typeof RUN_ALERT_KINDS[number]

/** A banner's data: job ids for Show and Select, counts for the restored banners, a path to reveal, and dismissal. */
export interface RunAlert
{
  id: string
  kind: RunAlertKind
  severity: 'info' | 'warning' | 'error'
  message: string
  at: number
  volume: string | null
  path: string | null
  jobIds: JobId[]
  counts: { interrupted: number; decisions: number; queued: number; restored: number; missing: number } | null
  dismissible: boolean
}

/** A folder added recently. */
export interface RecentFolder
{
  path: string
  name: string
  files: number
  addedAt: number
}

/** A user preset; jobs hold frozen copies, so editing it never changes a job. */
export interface UserPreset
{
  id: string
  name: string
  recipe: Recipe
  createdAt: number
  updatedAt: number
}

/** User presets, the pinned keys 1 to 9 (any preset id, built-in or user), and the recently applied recipes. */
export interface PresetState
{
  user: UserPreset[]
  pins: Partial<Record<'1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9', string>>
  recent: Recipe[]
}

/** Everything a window needs on subscribe; seq is the last event it reflects. */
export interface EngineSnapshot
{
  schema: 1
  seq: number
  run: RunState
  policy: BatchPolicy
  settings: RunSettings
  defaultRecipe: Recipe
  order: JobId[]
  jobs: JobView[]
  capabilities: CapabilitySummary
  scans: ScanState[]
  alerts: RunAlert[]
  presets: PresetState
  recentFolders: RecentFolder[]
  limits: { maxJobs: number }
}
