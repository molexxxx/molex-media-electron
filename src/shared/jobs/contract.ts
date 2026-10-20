/**
 * The jobs IPC contract between the engine in main, the preload, and the renderer: channel names, the command map
 * with every request and result, the event union on the one event channel, the result envelope, and the error and
 * refusal codes. The preload builds JobsApi from JOB_CHANNELS and main registers the same list, so the exposed surface
 * is exactly the command list.
 */
import type { JobId, RunId } from './ids'
import type { Recipe } from './recipes'
import type
{
  BatchPolicy,
  BatchSummary,
  CapabilitySummary,
  EngineSnapshot,
  HistoryRecord,
  JobDetail,
  JobMeasurement,
  JobPatch,
  JobProgress,
  JobStage,
  JobState,
  JobView,
  PauseMode,
  PreflightReport,
  PresetState,
  RecentFolder,
  ResultStamp,
  RunAlert,
  RunIndexEntry,
  RunProgress,
  RunSettings,
  RunState,
  ScanState,
  SourceRef,
  StateReason,
  UserPreset,
  Verdict,
  Verification,
  WorkersState
} from './types'

/** The channel of every command; jobs:, run:, runs:, and presets: commands only. */
export const JOB_CHANNELS =
{
  subscribe: 'jobs:subscribe',
  unsubscribe: 'jobs:unsubscribe',
  get: 'jobs:get',
  add: 'jobs:add',
  pasteFiles: 'jobs:pasteFiles',
  cancelScan: 'jobs:cancelScan',
  forgetFolder: 'jobs:forgetFolder',
  clearRecentFolders: 'jobs:clearRecentFolders',
  remove: 'jobs:remove',
  restore: 'jobs:restore',
  reorder: 'jobs:reorder',
  assignRecipe: 'jobs:assignRecipe',
  duplicate: 'jobs:duplicate',
  locate: 'jobs:locate',
  relink: 'jobs:relink',
  reprobe: 'jobs:reprobe',
  setPolicy: 'jobs:setPolicy',
  setDefaultRecipe: 'jobs:setDefaultRecipe',
  preflight: 'jobs:preflight',
  analyze: 'jobs:analyze',
  cancelAnalyze: 'jobs:cancelAnalyze',
  start: 'run:start',
  pause: 'run:pause',
  resume: 'run:resume',
  cancelRun: 'run:cancel',
  setWorkers: 'run:setWorkers',
  setSettings: 'run:setSettings',
  dismissAlert: 'run:dismissAlert',
  revealAlert: 'run:revealAlert',
  cancel: 'jobs:cancel',
  skip: 'jobs:skip',
  unqueue: 'jobs:unqueue',
  retry: 'jobs:retry',
  keepOutput: 'jobs:keepOutput',
  discardOutput: 'jobs:discardOutput',
  acknowledge: 'jobs:acknowledge',
  clear: 'jobs:clear',
  log: 'jobs:log',
  reveal: 'jobs:reveal',
  exportReport: 'jobs:exportReport',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  searchRuns: 'runs:search',
  rerun: 'runs:rerun',
  deleteRuns: 'runs:delete',
  revealRecord: 'runs:reveal',
  savePreset: 'presets:save',
  renamePreset: 'presets:rename',
  removePreset: 'presets:remove',
  setPin: 'presets:setPin'
} as const

/** The one channel events travel on, as JobEventBatch messages to subscribed windows only. */
export const JOB_EVENT_CHANNEL = 'jobs:event'

/** Every command name, in the order of JOB_CHANNELS. */
export const JOB_COMMAND_NAMES = Object.keys(JOB_CHANNELS) as JobCommandName[]

/** The destructive counts a Start, a destructive retry, or a resume of a restored replace run must repeat. */
export interface Ack
{
  preflightId: string
  originalsAffected: number
  overwrites: number
}

/** Every reason a command refuses one job. */
export const JOB_REFUSAL_CODES = [
  'not-found', 'job-running', 'job-finalizing', 'job-held', 'job-terminal', 'not-started', 'not-queued',
  'not-held', 'not-retryable', 'not-movable', 'needs-decision', 'needs-attention', 'blocked', 'invalid-recipe',
  'duplicate', 'not-analyzing', 'source-not-found'
] as const

/** Why a command refused one job. */
export type JobRefusalCode = typeof JOB_REFUSAL_CODES[number]

/** One job a command did not apply to. */
export interface JobRefusal
{
  jobId: JobId
  code: JobRefusalCode
  message: string
}

/** A command over many jobs applies to every job it can and reports the rest. */
export interface PerJob
{
  applied: JobId[]
  refused: JobRefusal[]
}

/** What Clear removes. */
export type ClearScope =
  | { kind: 'done' }
  | { kind: 'finished' }
  | { kind: 'ids'; ids: JobId[] }

/** Every file a reveal command can show. */
export const REVEAL_TARGETS = ['source', 'output', 'held-output', 'kept-original', 'log'] as const

/** A file a reveal command shows; never an arbitrary path. */
export type RevealTarget = typeof REVEAL_TARGETS[number]

/** What an add did: new jobs, duplicates and earlier outputs set aside, refused paths, and started scans. */
export interface AddResult
{
  added: JobId[]
  duplicates: { paths: string[]; jobIds: JobId[] }
  previousOutputs: string[]
  refused: Array<{ path: string; code: string; message: string }>
  scanIds: string[]
}

/** A history match for search. */
export interface RunSearchMatch
{
  runId: RunId
  jobId: JobId
  attempt: number
  sourceName: string
  sourcePath: string
  state: HistoryRecord['state']
  verdict: Verdict | null
  endedAt: number
  stamp: ResultStamp | null
}

/** Every command's request and result. One request object per command; replies are CommandResult envelopes. */
export interface JobCommandMap
{
  subscribe: { req: { clientId: string }; res: EngineSnapshot }
  unsubscribe: { req: { clientId: string }; res: null }
  get: { req: { jobId: JobId }; res: JobDetail }
  add:
  {
    req: { paths: string[]; recipe: Recipe | null; origin: SourceRef['origin']; after: JobId | null; recursive: boolean; allowSecondJobs: boolean; force: boolean }
    res: AddResult
  }
  pasteFiles: { req: { recipe: Recipe | null; recursive: boolean }; res: AddResult & { source: 'file-list' | 'text' | 'empty' } }
  cancelScan: { req: { scanId: string }; res: null }
  forgetFolder: { req: { path: string }; res: null }
  clearRecentFolders: { req: Record<string, never>; res: null }
  remove: { req: { ids: JobId[] }; res: PerJob & { tombstone: string | null } }
  restore: { req: { tombstone: string }; res: PerJob }
  reorder: { req: { ids: JobId[]; before: JobId | null }; res: PerJob }
  assignRecipe: { req: { assignments: Array<{ jobId: JobId; recipe: Recipe }> }; res: PerJob }
  duplicate: { req: { ids: JobId[]; recipe: Recipe | null }; res: PerJob & { created: JobId[] } }
  locate: { req: { jobId: JobId; path: string }; res: PerJob & { relinkable: { fromDir: string; toDir: string; ids: JobId[] } | null } }
  relink: { req: { fromDir: string; toDir: string; ids: JobId[] | 'missing' }; res: PerJob }
  reprobe: { req: { ids: JobId[] }; res: PerJob }
  setPolicy: { req: { policy: Omit<BatchPolicy, 'rev'> }; res: { policy: BatchPolicy; demoted: JobId[] } }
  setDefaultRecipe: { req: { recipe: Recipe }; res: null }
  preflight: { req: { ids: JobId[] | 'pending' }; res: PreflightReport }
  analyze: { req: { ids: JobId[] }; res: PerJob }
  cancelAnalyze: { req: { ids: JobId[] | 'all' }; res: PerJob }
  start:
  {
    req: { preflightId: string; ack: Ack | null; resume: boolean }
    res: { runId: RunId; queued: JobId[]; skipped: JobId[]; blocked: JobId[]; repeated: boolean }
  }
  pause: { req: { mode: PauseMode }; res: RunState }
  resume: { req: { ack: Ack | null }; res: RunState }
  cancelRun: { req: Record<string, never>; res: { canceled: number } }
  setWorkers: { req: { workers: RunSettings['workers']; gpuSessions: RunSettings['gpuSessions'] | null }; res: WorkersState }
  setSettings:
  {
    req: { settings: Partial<Pick<RunSettings, 'priority' | 'keepAwake' | 'verifyVideo' | 'notify' | 'measureOnReview' | 'includeSubfolders'>> }
    res: RunSettings
  }
  dismissAlert: { req: { alertId: string }; res: null }
  revealAlert: { req: { alertId: string }; res: null }
  cancel: { req: { ids: JobId[] }; res: PerJob }
  skip: { req: { ids: JobId[] }; res: PerJob }
  unqueue: { req: { ids: JobId[] }; res: PerJob }
  retry:
  {
    req: { ids: JobId[] | 'failed'; recipe: Recipe | null; ack: Ack | null; start: boolean }
    res: PerJob & { queued: JobId[]; pending: JobId[]; changed: JobId[]; runId: RunId | null }
  }
  keepOutput: { req: { ids: JobId[]; placement: 'planned' | 'renamed'; confirm: { displaces: number } | null }; res: PerJob }
  discardOutput: { req: { ids: JobId[] }; res: PerJob }
  acknowledge: { req: { ids: JobId[] }; res: PerJob }
  clear: { req: { scope: ClearScope }; res: { removed: number; kept: number; tombstone: string | null } }
  log: { req: { jobId: JobId; attempt: number | null }; res: { lines: string[]; truncated: boolean; file: string | null } }
  reveal: { req: { jobId: JobId; target: RevealTarget }; res: null }
  exportReport: { req: { scope: { runId: RunId } | { ids: JobId[] }; format: 'csv' | 'json' }; res: { path: string } | { canceled: true } }
  listRuns:
  {
    req: { before: RunId | null; limit: number }
    res: { runs: RunIndexEntry[]; more: boolean; usage: { runs: number; historyBytes: number; logBytes: number } }
  }
  getRun: { req: { runId: RunId; offset: number; limit: number }; res: { summary: BatchSummary | null; records: HistoryRecord[]; total: number } }
  searchRuns:
  {
    req: { query: string; limit: number; before: { runId: RunId; jobId: JobId } | null }
    res: { matches: RunSearchMatch[]; runs: number; more: boolean }
  }
  rerun:
  {
    req: { runId: RunId; jobIds: JobId[] | 'all' | 'returned'; force: boolean }
    res: { added: JobId[]; missing: Array<{ jobId: JobId; path: string }>; holdsOutput: Array<{ jobId: JobId; path: string; originalTrashed: boolean }> }
  }
  deleteRuns: { req: { runIds: RunId[] | 'all' }; res: { deleted: number } }
  revealRecord: { req: { runId: RunId; jobId: JobId; attempt: number; target: RevealTarget }; res: null }
  savePreset: { req: { id: string | null; name: string; recipe: Recipe; pin: number | null }; res: { preset: UserPreset; unpinned: string | null } }
  renamePreset: { req: { id: string; name: string }; res: UserPreset }
  removePreset: { req: { id: string }; res: null }
  setPin: { req: { key: number; presetId: string | null }; res: { unpinned: string | null } }
}

/** A command's name. */
export type JobCommandName = keyof JobCommandMap

/** A command's request. */
export type JobCommandRequest<K extends JobCommandName> = JobCommandMap[K]['req']

/** A command's result. */
export type JobCommandResponse<K extends JobCommandName> = JobCommandMap[K]['res']

/** Every reason a whole command is refused. */
export const COMMAND_ERROR_CODES = [
  'invalid-payload', 'untrusted-sender', 'not-found', 'invalid-state', 'plan-stale',
  'confirmation-required', 'queue-full', 'superseded', 'shutting-down', 'io-error', 'restore-expired', 'internal'
] as const

/** Why a whole command was refused. */
export type CommandErrorCode = typeof COMMAND_ERROR_CODES[number]

/** One problem with a request, at its JSON path. */
export interface CommandIssue
{
  path: string
  message: string
}

/** A refused command: every payload issue, and the counts or job ids the page needs to act. */
export interface CommandError
{
  code: CommandErrorCode
  message: string
  issues: CommandIssue[]
  details: { preflightId: string; originalsAffected: number; overwrites: number } | { changed: JobId[] } | null
}

/** Every reply; expected outcomes never reject. seq is the last event the command caused, 0 if none. */
export type CommandResult<T> =
  | { ok: true; value: T; seq: number }
  | { ok: false; error: CommandError }

/** A runtime validator's answer for a request or a recipe. */
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; issues: CommandIssue[] }

/** Every event on the event channel; events are idempotent upserts ordered by one gap-free seq. */
export type JobEvent =
  | { type: 'job.added'; seq: number; at: number; job: JobView; after: JobId | null }
  | { type: 'job.removed'; seq: number; at: number; jobId: JobId }
  | { type: 'queue.order'; seq: number; at: number; order: JobId[] }
  | { type: 'job.updated'; seq: number; at: number; jobId: JobId; rev: number; patch: JobPatch }
  | { type: 'job.state'; seq: number; at: number; jobId: JobId; rev: number; from: JobState; to: JobState; attempt: number; reason: StateReason; patch: JobPatch }
  | { type: 'job.stage'; seq: number; at: number; jobId: JobId; rev: number; stage: JobStage }
  | { type: 'job.progress'; seq: number; at: number; jobId: JobId; progress: JobProgress }
  | { type: 'job.measured'; seq: number; at: number; jobId: JobId; rev: number; measurement: JobMeasurement }
  | { type: 'job.verified'; seq: number; at: number; jobId: JobId; rev: number; verification: Verification }
  | { type: 'run.state'; seq: number; at: number; run: RunState }
  | { type: 'run.progress'; seq: number; at: number; progress: RunProgress }
  | { type: 'run.completed'; seq: number; at: number; summary: BatchSummary }
  | { type: 'run.alert'; seq: number; at: number; alert: RunAlert }
  | { type: 'run.alertCleared'; seq: number; at: number; alertId: string }
  | { type: 'workers.changed'; seq: number; at: number; workers: WorkersState }
  | { type: 'settings.changed'; seq: number; at: number; settings: RunSettings }
  | { type: 'policy.changed'; seq: number; at: number; policy: BatchPolicy }
  | { type: 'capabilities.changed'; seq: number; at: number; capabilities: CapabilitySummary }
  | { type: 'scan.progress'; seq: number; at: number; scan: ScanState }
  | { type: 'preflight.progress'; seq: number; at: number; preflightId: string; done: number; total: number }
  | { type: 'presets.changed'; seq: number; at: number; presets: PresetState }
  | { type: 'defaultRecipe.changed'; seq: number; at: number; recipe: Recipe }
  | { type: 'folders.changed'; seq: number; at: number; recentFolders: RecentFolder[] }
  | { type: 'ui.focus'; seq: number; at: number; jobId: JobId | null; runId: RunId | null }

/** An event's type. */
export type JobEventType = JobEvent['type']

/** Every event type, in the order of the union. */
export const JOB_EVENT_TYPES = [
  'job.added', 'job.removed', 'queue.order', 'job.updated', 'job.state', 'job.stage', 'job.progress', 'job.measured', 'job.verified',
  'run.state', 'run.progress', 'run.completed', 'run.alert', 'run.alertCleared', 'workers.changed', 'settings.changed', 'policy.changed',
  'capabilities.changed', 'scan.progress', 'preflight.progress', 'presets.changed', 'defaultRecipe.changed', 'folders.changed', 'ui.focus'
] as const satisfies readonly JobEventType[]

/** One message on the event channel. */
export interface JobEventBatch
{
  events: JobEvent[]
}

/** The preload's surface: one method per command resolving to its envelope, and onEvents returning an unsubscribe. */
export type JobsApi =
  { [K in JobCommandName]: (req: JobCommandMap[K]['req']) => Promise<CommandResult<JobCommandMap[K]['res']>> }
  & { onEvents(cb: (batch: JobEventBatch) => void): () => void }

/** Whether a string is one of the command channels. */
export function isJobChannel(channel: string): boolean
{
  return JOB_COMMAND_NAMES.some((name) => JOB_CHANNELS[name] === channel)
}
