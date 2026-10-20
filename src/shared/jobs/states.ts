/**
 * The per-job state machine: the transition table T1 to T34 keyed by trigger, the run status transitions, the state
 * each stage runs in, the answer every per-job command gives in every state, and the attention rules that every count,
 * filter, and held label reads. Pure tables and functions; the engine applies them and the page displays them.
 */
import type { JobCommandName, JobRefusalCode } from './contract'
import type { RunId } from './ids'
import type { JobState, JobWarningCode, RunStatus, StageId, StateReason } from './types'

/** What moves a job from one state to the next. */
export const JOB_TRIGGERS = [
  'add', 'start', 'output-exists', 'remove', 'unqueue', 'demote', 'dispatch', 'skip', 'cancel', 'fail',
  'measured', 'requeue', 'next-pass', 'encoded', 'correct', 'verified', 'hold', 'placed', 'keep', 'discard',
  'retry', 'retry-changed', 'edit-retry', 'interrupt', 'recover-placed', 'recover-hold', 'recover-missing'
] as const

/** A trigger of the transition table. */
export type JobTrigger = typeof JOB_TRIGGERS[number]

/** Every transition id of the table, T1 to T34. */
export const TRANSITION_IDS = [
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17',
  'T18', 'T19', 'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32', 'T33', 'T34'
] as const

/** A transition's id. */
export type TransitionId = typeof TRANSITION_IDS[number]

/** Who causes a transition. */
export type TransitionActor = 'user' | 'engine'

/** A transition's source state; none for a job that does not exist yet. */
export type TransitionFrom = JobState | 'none'

/** A transition's target; removed for a job that leaves the queue. */
export type TransitionTo = JobState | 'removed'

/** One trigger of one row of the transition table. */
export interface JobTransition
{
  id: TransitionId
  trigger: JobTrigger
  from: readonly TransitionFrom[]
  /** Done jobs qualify as well when they carry this warning. */
  doneWith: JobWarningCode | null
  to: TransitionTo
  actors: readonly TransitionActor[]
  /** The reasons the new state may carry, the default first; none for a removal, which emits job.removed. */
  reasons: readonly StateReason[]
  /** False only for the next encode pass, which emits job.stage and changes neither the state nor rev. */
  changesState: boolean
  /** Committed after a durable journal line: the move to finalizing and every hold. */
  durable: boolean
}

const RUNNING: readonly JobState[] = ['analyzing', 'encoding', 'verifying']
const FINISHED: readonly JobState[] = ['failed', 'canceled', 'skipped', 'interrupted']
const ENDED: readonly JobState[] = ['done', 'failed', 'canceled', 'skipped', 'interrupted']

function row(
  id: TransitionId,
  trigger: JobTrigger,
  from: readonly TransitionFrom[],
  to: TransitionTo,
  actors: readonly TransitionActor[],
  reasons: readonly StateReason[],
  extra: Partial<Pick<JobTransition, 'doneWith' | 'changesState'>> = {}
): JobTransition
{
  return {
    id,
    trigger,
    from,
    doneWith: extra.doneWith ?? null,
    to,
    actors,
    reasons,
    changesState: extra.changesState ?? true,
    durable: to === 'finalizing' || to === 'held'
  }
}

const RETRY_DONE = { doneWith: 'outside-tolerance-placed' } as const

/** The transition table: one entry per trigger of each row T1 to T34. */
export const JOB_TRANSITIONS: readonly JobTransition[] = [
  row('T1', 'add', ['none'], 'pending', ['user'], ['user']),
  row('T2', 'start', ['pending'], 'queued', ['user'], ['user']),
  row('T3', 'output-exists', ['pending'], 'skipped', ['engine'], ['output-exists']),
  row('T4', 'remove', ['pending'], 'removed', ['user'], []),
  row('T5', 'unqueue', ['queued'], 'pending', ['user'], ['user']),
  row('T5', 'demote', ['queued'], 'pending', ['engine'], ['plan-blocked', 'destructive-scope', 'source-changed']),
  row('T6', 'dispatch', ['queued'], 'analyzing', ['engine'], ['dispatch']),
  row('T7', 'skip', ['queued'], 'skipped', ['user'], ['user']),
  row('T7', 'output-exists', ['queued'], 'skipped', ['engine'], ['output-exists']),
  row('T8', 'cancel', ['queued'], 'canceled', ['user'], ['user', 'run-canceled']),
  row('T9', 'remove', ['queued'], 'removed', ['user'], []),
  row('T10', 'fail', ['queued'], 'failed', ['engine'], ['engine']),
  row('T11', 'measured', ['analyzing'], 'encoding', ['engine'], ['engine']),
  row('T12', 'fail', ['analyzing'], 'failed', ['engine'], ['engine']),
  row('T13', 'requeue', RUNNING, 'queued', ['user', 'engine'], ['requeued-pause', 'requeued-gpu', 'requeued-cpu', 'requeued-disk']),
  row('T14', 'cancel', RUNNING, 'canceled', ['user'], ['user', 'run-canceled']),
  row('T15', 'skip', RUNNING, 'skipped', ['user'], ['user']),
  row('T16', 'next-pass', ['encoding'], 'encoding', ['engine'], [], { changesState: false }),
  row('T17', 'encoded', ['encoding'], 'verifying', ['engine'], ['engine']),
  row('T18', 'fail', ['encoding'], 'failed', ['engine'], ['engine']),
  row('T19', 'correct', ['verifying'], 'encoding', ['engine'], ['engine']),
  row('T20', 'verified', ['verifying'], 'finalizing', ['engine'], ['engine']),
  row('T21', 'hold', ['verifying'], 'held', ['engine'], ['outside-tolerance']),
  row('T22', 'fail', ['verifying'], 'failed', ['engine'], ['engine']),
  row('T23', 'placed', ['finalizing'], 'done', ['engine'], ['engine']),
  row('T24', 'hold', ['finalizing'], 'held', ['engine'], ['destination-appeared', 'file-locked', 'storage-unavailable']),
  row('T25', 'fail', ['finalizing'], 'failed', ['engine'], ['engine']),
  row('T26', 'keep', ['held'], 'finalizing', ['user', 'engine'], ['user', 'engine']),
  row('T27', 'discard', ['held'], 'canceled', ['user'], ['output-discarded']),
  row('T28', 'retry', ['held'], 'queued', ['user'], ['user']),
  row('T28', 'retry-changed', ['held'], 'pending', ['user'], ['plan-blocked', 'plan-changed']),
  row('T29', 'retry', FINISHED, 'queued', ['user'], ['user'], RETRY_DONE),
  row('T30', 'retry-changed', FINISHED, 'pending', ['user'], ['plan-blocked', 'plan-changed'], RETRY_DONE),
  row('T30', 'edit-retry', FINISHED, 'pending', ['user'], ['user'], RETRY_DONE),
  row('T31', 'interrupt', RUNNING, 'interrupted', ['engine'], ['crash', 'quit', 'session-end']),
  row('T32', 'recover-placed', ['finalizing'], 'done', ['engine'], ['engine']),
  row('T32', 'recover-hold', ['finalizing'], 'held', ['engine'], ['interrupted-finalize', 'file-locked']),
  row('T33', 'recover-missing', ['held'], 'failed', ['engine'], ['engine']),
  row('T34', 'remove', ENDED, 'removed', ['user'], [])
]

/** The fields the state rules read from a job; a Job and a JobView both carry them. */
export interface StateSubject
{
  state: JobState
  warnings: ReadonlyArray<{ code: JobWarningCode }>
}

function hasWarning(job: StateSubject, code: JobWarningCode): boolean
{
  return job.warnings.some((warning) => warning.code === code)
}

function matchesFrom(entry: JobTransition, job: StateSubject | null): boolean
{
  if (job === null)
  {
    return entry.from.includes('none')
  }
  if (entry.from.includes(job.state))
  {
    return true
  }
  return job.state === 'done' && entry.doneWith !== null && hasWarning(job, entry.doneWith)
}

/**
 * The transition a trigger causes for a job (null for a job that does not exist yet), or null when the trigger does
 * not apply in the job's state; the engine logs and ignores such a call and never throws it into a runner.
 */
export function transitionFor(job: StateSubject | null, trigger: JobTrigger): JobTransition | null
{
  return JOB_TRANSITIONS.find((entry) => entry.trigger === trigger && matchesFrom(entry, job)) ?? null
}

/** What moves the run from one status to the next. */
export const RUN_TRIGGERS = ['start', 'pause', 'settled', 'resume', 'cancel', 'drained'] as const

/** A trigger of the run status table. */
export type RunTrigger = typeof RUN_TRIGGERS[number]

/** One row of the run status table; a run.state event announces each. */
export interface RunTransition
{
  trigger: RunTrigger
  from: readonly RunStatus[]
  to: RunStatus
  /** For a pause: whether the run has active jobs; null when that does not matter. */
  active: boolean | null
  /** How a run that goes idle ended, announced by run.completed. */
  endedBy: 'completed' | 'canceled' | null
}

/**
 * The run status table. A pause covers run:pause in either mode and the automatic pauses (disk space, the engine's
 * storage, FFmpeg unavailable); settled means the last active job has left the active states; drained means the run
 * has no queued and no active jobs, which takes precedence over settled.
 */
export const RUN_TRANSITIONS: readonly RunTransition[] = [
  { trigger: 'start', from: ['idle'], to: 'running', active: null, endedBy: null },
  { trigger: 'pause', from: ['running'], to: 'pausing', active: true, endedBy: null },
  { trigger: 'pause', from: ['running'], to: 'paused', active: false, endedBy: null },
  { trigger: 'settled', from: ['pausing'], to: 'paused', active: null, endedBy: null },
  { trigger: 'resume', from: ['pausing', 'paused'], to: 'running', active: null, endedBy: null },
  { trigger: 'cancel', from: ['running', 'pausing', 'paused'], to: 'canceling', active: null, endedBy: null },
  { trigger: 'settled', from: ['canceling'], to: 'idle', active: null, endedBy: 'canceled' },
  { trigger: 'drained', from: ['running', 'pausing', 'paused'], to: 'idle', active: null, endedBy: 'completed' }
]

/** The run transition a trigger causes from a status, given the number of active jobs; null when none applies. */
export function runTransitionFor(status: RunStatus, trigger: RunTrigger, activeJobs: number): RunTransition | null
{
  return RUN_TRANSITIONS.find((entry) => entry.trigger === trigger && entry.from.includes(status) &&
    (entry.active === null || entry.active === activeJobs > 0)) ?? null
}

/** The state a job is in while it runs each stage. */
export const STAGE_STATES: Readonly<Record<StageId, JobState>> =
{
  'probe': 'analyzing',
  'measure': 'analyzing',
  'measure-dynamics': 'analyzing',
  'measure-album': 'analyzing',
  'encode': 'encoding',
  'verify': 'verifying',
  'place': 'finalizing',
  'trash': 'finalizing',
  'wait-lock': 'finalizing'
}

/** The group of a state: waiting for a run, active in a worker slot, waiting for a decision, or ended. */
export type StateGroup = 'waiting' | 'active' | 'decision' | 'terminal'

/** Each state's group. */
export const STATE_GROUPS: Readonly<Record<JobState, StateGroup>> =
{
  'pending': 'waiting',
  'queued': 'waiting',
  'analyzing': 'active',
  'encoding': 'active',
  'verifying': 'active',
  'finalizing': 'active',
  'held': 'decision',
  'done': 'terminal',
  'failed': 'terminal',
  'canceled': 'terminal',
  'skipped': 'terminal',
  'interrupted': 'terminal'
}

/** The states of a job that belongs to the current run; a run completes once none of its jobs is in one. */
export const IN_RUN_STATES: readonly JobState[] = ['queued', 'analyzing', 'encoding', 'verifying', 'finalizing']

/** The fields the attention rules read; a Job and a JobView both carry them. */
export interface AttentionSubject extends StateSubject
{
  acknowledged: boolean
}

/**
 * Whether a job needs attention: failed, interrupted, and done-with-warnings jobs that are not acknowledged, and
 * every held job. Every count, filter, and held label of the page, the tray, and the taskbar reads this.
 */
export function needsAttention(job: AttentionSubject): boolean
{
  if (job.state === 'held')
  {
    return true
  }
  if (job.acknowledged)
  {
    return false
  }
  return job.state === 'failed' || job.state === 'interrupted' || (job.state === 'done' && job.warnings.length > 0)
}

/** Whether a job waits for a decision (keep, discard, or retry) that only a decision resolves. */
export function needsDecision(job: { state: JobState }): boolean
{
  return job.state === 'held'
}

/** The jobs that need attention in one run, or in the whole queue when runId is null. */
export function attentionCount(jobs: Iterable<AttentionSubject & { runId: RunId | null }>, runId: RunId | null): number
{
  let count = 0
  for (const job of jobs)
  {
    if ((runId === null || job.runId === runId) && needsAttention(job))
    {
      count += 1
    }
  }
  return count
}

/** The per-job commands of the applicability matrix; relink follows locate. */
export const MATRIX_COMMANDS = [
  'remove', 'reorder', 'assignRecipe', 'duplicate', 'start', 'unqueue', 'cancel', 'skip', 'retry',
  'keepOutput', 'discardOutput', 'acknowledge', 'cancelAnalyze', 'locate', 'relink', 'reprobe'
] as const satisfies readonly JobCommandName[]

/** A per-job command of the matrix. */
export type MatrixCommand = typeof MATRIX_COMMANDS[number]

/** How a command answers one job: it applies, it leaves the job alone without refusing it, or it refuses with a code. */
export type CommandAnswer = 'ok' | 'no-op' | JobRefusalCode

/** The fields the matrix reads; a Job and a JobView both carry them. */
export interface CommandSubject extends AttentionSubject
{
  analysis: 'queued' | 'running' | null
}

type Column = 'pending' | 'queued' | 'running' | 'finalizing' | 'held' | 'done' | 'finished'

type Cell = CommandAnswer | ((job: CommandSubject) => CommandAnswer)

const COLUMNS: Readonly<Record<JobState, Column>> =
{
  'pending': 'pending',
  'queued': 'queued',
  'analyzing': 'running',
  'encoding': 'running',
  'verifying': 'running',
  'finalizing': 'finalizing',
  'held': 'held',
  'done': 'done',
  'failed': 'finished',
  'canceled': 'finished',
  'skipped': 'finished',
  'interrupted': 'finished'
}

const unlessAttention: Cell = (job) => needsAttention(job) ? 'needs-attention' : 'ok'
const whenAttention: Cell = (job) => needsAttention(job) ? 'ok' : 'no-op'
const whenAnalysis: Cell = (job) => job.analysis === null ? 'not-analyzing' : 'ok'

function whenPlacedOutside(refusal: JobRefusalCode): Cell
{
  return (job) => hasWarning(job, 'outside-tolerance-placed') ? 'ok' : refusal
}

const PROBE_AGAIN: Readonly<Record<Column, Cell>> =
{
  pending: 'ok', queued: 'ok', running: 'job-running', finalizing: 'job-finalizing', held: 'job-held', done: 'job-terminal', finished: 'job-terminal'
}

const DECIDE: Readonly<Record<Column, Cell>> =
{
  pending: 'not-held', queued: 'not-held', running: 'not-held', finalizing: 'not-held', held: 'ok', done: 'not-held', finished: 'not-held'
}

const MATRIX: Readonly<Record<MatrixCommand, Readonly<Record<Column, Cell>>>> =
{
  remove: { pending: 'ok', queued: 'ok', running: 'job-running', finalizing: 'job-finalizing', held: 'job-held', done: unlessAttention, finished: unlessAttention },
  reorder: { pending: 'ok', queued: 'ok', running: 'not-movable', finalizing: 'not-movable', held: 'not-movable', done: 'not-movable', finished: 'not-movable' },
  assignRecipe: { pending: 'ok', queued: 'ok', running: 'job-running', finalizing: 'job-finalizing', held: 'job-held', done: whenPlacedOutside('job-terminal'), finished: 'ok' },
  duplicate: { pending: 'ok', queued: 'ok', running: 'ok', finalizing: 'ok', held: 'ok', done: 'ok', finished: 'ok' },
  start: { pending: 'ok', queued: 'no-op', running: 'no-op', finalizing: 'no-op', held: 'job-held', done: 'not-retryable', finished: 'not-retryable' },
  unqueue: { pending: 'not-queued', queued: 'ok', running: 'job-running', finalizing: 'job-finalizing', held: 'not-queued', done: 'not-queued', finished: 'not-queued' },
  cancel: { pending: 'not-started', queued: 'ok', running: 'ok', finalizing: 'job-finalizing', held: 'job-held', done: 'job-terminal', finished: 'job-terminal' },
  skip: { pending: 'not-started', queued: 'ok', running: 'ok', finalizing: 'job-finalizing', held: 'job-held', done: 'job-terminal', finished: 'job-terminal' },
  retry: { pending: 'not-retryable', queued: 'not-retryable', running: 'job-running', finalizing: 'job-finalizing', held: 'ok', done: whenPlacedOutside('not-retryable'), finished: 'ok' },
  keepOutput: DECIDE,
  discardOutput: DECIDE,
  acknowledge: { pending: 'no-op', queued: 'no-op', running: 'no-op', finalizing: 'no-op', held: 'needs-decision', done: whenAttention, finished: whenAttention },
  cancelAnalyze: { pending: whenAnalysis, queued: whenAnalysis, running: 'not-analyzing', finalizing: 'not-analyzing', held: 'not-analyzing', done: 'not-analyzing', finished: 'not-analyzing' },
  locate: PROBE_AGAIN,
  relink: PROBE_AGAIN,
  reprobe: PROBE_AGAIN
}

const INSTEAD: Readonly<Partial<Record<MatrixCommand, Partial<Record<Column, MatrixCommand>>>>> =
{
  assignRecipe: { done: 'duplicate' },
  start: { finished: 'retry' },
  cancel: { held: 'discardOutput' },
  retry: { done: 'duplicate' },
  locate: { finished: 'retry' },
  relink: { finished: 'retry' },
  reprobe: { finished: 'retry' }
}

/**
 * How a per-job command answers a job in its state. A job the scheduler has claimed is still queued on the wire and
 * answers as a queued job; a command that changes it voids the claim.
 */
export function commandApplicability(command: MatrixCommand, job: CommandSubject): CommandAnswer
{
  const cell = MATRIX[command][COLUMNS[job.state]]
  return typeof cell === 'function' ? cell(job) : cell
}

/** The command the matrix names instead of one it refuses (Duplicate, Retry, or Discard output); null when none. */
export function commandInstead(command: MatrixCommand, job: CommandSubject): MatrixCommand | null
{
  const answer = commandApplicability(command, job)
  if (answer === 'ok' || answer === 'no-op')
  {
    return null
  }
  return INSTEAD[command]?.[COLUMNS[job.state]] ?? null
}
