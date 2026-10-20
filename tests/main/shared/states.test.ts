/**
 * The per-job state machine: every (state, trigger) pair against the transition table T1 to T34, the run status
 * table, the stage-to-state map, and every (command, state) cell of the applicability matrix, so the engine and the
 * page can never disagree about what a job may do next.
 */
import { describe, it, expect } from 'vitest'
import {
  IN_RUN_STATES,
  JOB_TRANSITIONS,
  JOB_TRIGGERS,
  MATRIX_COMMANDS,
  RUN_TRANSITIONS,
  RUN_TRIGGERS,
  STAGE_STATES,
  STATE_GROUPS,
  TRANSITION_IDS,
  commandApplicability,
  commandInstead,
  runTransitionFor,
  transitionFor,
  type CommandAnswer,
  type CommandSubject,
  type JobTrigger,
  type MatrixCommand,
  type RunTrigger,
  type TransitionId
} from '../../../src/shared/jobs/states'
import { ACTIVE_STATES, JOB_STATES, TERMINAL_STATES, type JobState, type JobWarningCode, type RunStatus } from '../../../src/shared/jobs/types'
import { JOB_COMMAND_NAMES, JOB_REFUSAL_CODES } from '../../../src/shared/jobs/contract'

type SubjectKey = JobState | 'none' | 'done+outside-tolerance-placed' | 'done+original-kept'

const OTP = 'done+outside-tolerance-placed'
const RUNNING = ['analyzing', 'encoding', 'verifying']
const FINISHED = ['failed', 'canceled', 'skipped', 'interrupted']

/** The transition table written out by hand: one line per trigger of each row. */
const TABLE: Array<{ id: TransitionId; trigger: JobTrigger; from: string[]; to: string; actors: string[]; reasons: string[] }> = [
  { id: 'T1', trigger: 'add', from: ['none'], to: 'pending', actors: ['user'], reasons: ['user'] },
  { id: 'T2', trigger: 'start', from: ['pending'], to: 'queued', actors: ['user'], reasons: ['user'] },
  { id: 'T3', trigger: 'output-exists', from: ['pending'], to: 'skipped', actors: ['engine'], reasons: ['output-exists'] },
  { id: 'T4', trigger: 'remove', from: ['pending'], to: 'removed', actors: ['user'], reasons: [] },
  { id: 'T5', trigger: 'unqueue', from: ['queued'], to: 'pending', actors: ['user'], reasons: ['user'] },
  { id: 'T5', trigger: 'demote', from: ['queued'], to: 'pending', actors: ['engine'], reasons: ['plan-blocked', 'destructive-scope', 'source-changed'] },
  { id: 'T6', trigger: 'dispatch', from: ['queued'], to: 'analyzing', actors: ['engine'], reasons: ['dispatch'] },
  { id: 'T7', trigger: 'skip', from: ['queued'], to: 'skipped', actors: ['user'], reasons: ['user'] },
  { id: 'T7', trigger: 'output-exists', from: ['queued'], to: 'skipped', actors: ['engine'], reasons: ['output-exists'] },
  { id: 'T8', trigger: 'cancel', from: ['queued'], to: 'canceled', actors: ['user'], reasons: ['user', 'run-canceled'] },
  { id: 'T9', trigger: 'remove', from: ['queued'], to: 'removed', actors: ['user'], reasons: [] },
  { id: 'T10', trigger: 'fail', from: ['queued'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T11', trigger: 'measured', from: ['analyzing'], to: 'encoding', actors: ['engine'], reasons: ['engine'] },
  { id: 'T12', trigger: 'fail', from: ['analyzing'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T13', trigger: 'requeue', from: RUNNING, to: 'queued', actors: ['user', 'engine'], reasons: ['requeued-pause', 'requeued-gpu', 'requeued-cpu', 'requeued-disk'] },
  { id: 'T14', trigger: 'cancel', from: RUNNING, to: 'canceled', actors: ['user'], reasons: ['user', 'run-canceled'] },
  { id: 'T15', trigger: 'skip', from: RUNNING, to: 'skipped', actors: ['user'], reasons: ['user'] },
  { id: 'T16', trigger: 'next-pass', from: ['encoding'], to: 'encoding', actors: ['engine'], reasons: [] },
  { id: 'T17', trigger: 'encoded', from: ['encoding'], to: 'verifying', actors: ['engine'], reasons: ['engine'] },
  { id: 'T18', trigger: 'fail', from: ['encoding'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T19', trigger: 'correct', from: ['verifying'], to: 'encoding', actors: ['engine'], reasons: ['engine'] },
  { id: 'T20', trigger: 'verified', from: ['verifying'], to: 'finalizing', actors: ['engine'], reasons: ['engine'] },
  { id: 'T21', trigger: 'hold', from: ['verifying'], to: 'held', actors: ['engine'], reasons: ['outside-tolerance'] },
  { id: 'T22', trigger: 'fail', from: ['verifying'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T23', trigger: 'placed', from: ['finalizing'], to: 'done', actors: ['engine'], reasons: ['engine'] },
  { id: 'T24', trigger: 'hold', from: ['finalizing'], to: 'held', actors: ['engine'], reasons: ['destination-appeared', 'file-locked', 'storage-unavailable'] },
  { id: 'T25', trigger: 'fail', from: ['finalizing'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T26', trigger: 'keep', from: ['held'], to: 'finalizing', actors: ['user', 'engine'], reasons: ['user', 'engine'] },
  { id: 'T27', trigger: 'discard', from: ['held'], to: 'canceled', actors: ['user'], reasons: ['output-discarded'] },
  { id: 'T28', trigger: 'retry', from: ['held'], to: 'queued', actors: ['user'], reasons: ['user'] },
  { id: 'T28', trigger: 'retry-changed', from: ['held'], to: 'pending', actors: ['user'], reasons: ['plan-blocked', 'plan-changed'] },
  { id: 'T29', trigger: 'retry', from: [...FINISHED, OTP], to: 'queued', actors: ['user'], reasons: ['user'] },
  { id: 'T30', trigger: 'retry-changed', from: [...FINISHED, OTP], to: 'pending', actors: ['user'], reasons: ['plan-blocked', 'plan-changed'] },
  { id: 'T30', trigger: 'edit-retry', from: [...FINISHED, OTP], to: 'pending', actors: ['user'], reasons: ['user'] },
  { id: 'T31', trigger: 'interrupt', from: RUNNING, to: 'interrupted', actors: ['engine'], reasons: ['crash', 'quit', 'session-end'] },
  { id: 'T32', trigger: 'recover-placed', from: ['finalizing'], to: 'done', actors: ['engine'], reasons: ['engine'] },
  { id: 'T32', trigger: 'recover-hold', from: ['finalizing'], to: 'held', actors: ['engine'], reasons: ['interrupted-finalize', 'file-locked'] },
  { id: 'T33', trigger: 'recover-missing', from: ['held'], to: 'failed', actors: ['engine'], reasons: ['engine'] },
  { id: 'T34', trigger: 'remove', from: ['done', ...FINISHED], to: 'removed', actors: ['user'], reasons: [] }
]

const SUBJECT_KEYS: SubjectKey[] = ['none', ...JOB_STATES, OTP, 'done+original-kept']

function subjectOf(key: SubjectKey): { state: JobState; warnings: Array<{ code: JobWarningCode }> } | null
{
  if (key === 'none')
  {
    return null
  }
  if (key === OTP)
  {
    return { state: 'done', warnings: [{ code: 'outside-tolerance-placed' }] }
  }
  if (key === 'done+original-kept')
  {
    return { state: 'done', warnings: [{ code: 'original-kept' }] }
  }
  return { state: key, warnings: [] }
}

function tableMatches(from: string[], key: SubjectKey): boolean
{
  if (from.includes(key))
  {
    return true
  }
  return (key === OTP || key === 'done+original-kept') && from.includes('done')
}

describe('the transition table', () =>
{
  it('has every row T1 to T34 and nothing else', () =>
  {
    expect(new Set(JOB_TRANSITIONS.map((entry) => entry.id))).toEqual(new Set(TRANSITION_IDS))
    expect(TRANSITION_IDS).toHaveLength(34)
    expect(new Set(JOB_TRANSITIONS.map((entry) => entry.trigger))).toEqual(new Set(JOB_TRIGGERS))
  })

  it('matches the table row by row: sources, target, actors, and reasons', () =>
  {
    expect(JOB_TRANSITIONS).toHaveLength(TABLE.length)
    TABLE.forEach((expected, index) =>
    {
      const entry = JOB_TRANSITIONS[index]
      const from = [...entry.from, ...(entry.doneWith === null ? [] : [`done+${entry.doneWith}`])]
      expect({ id: entry.id, trigger: entry.trigger, from, to: entry.to, actors: entry.actors, reasons: entry.reasons }, expected.id).toEqual(expected)
    })
  })

  it.each(SUBJECT_KEYS)('answers every trigger from %s exactly as the table says', (key) =>
  {
    for (const trigger of JOB_TRIGGERS)
    {
      const expected = TABLE.filter((line) => line.trigger === trigger && tableMatches(line.from, key))
      expect(expected.length, `${key} ${trigger}`).toBeLessThanOrEqual(1)
      const actual = transitionFor(subjectOf(key), trigger)
      if (expected.length === 0)
      {
        expect(actual, `${key} ${trigger}`).toBeNull()
      }
      else
      {
        expect({ id: actual?.id, to: actual?.to }, `${key} ${trigger}`).toEqual({ id: expected[0].id, to: expected[0].to })
      }
    }
  })

  it('gives no engine transition to a terminal state', () =>
  {
    for (const state of TERMINAL_STATES)
    {
      for (const subject of [{ state, warnings: [] }, { state, warnings: [{ code: 'outside-tolerance-placed' as const }] }])
      {
        for (const trigger of JOB_TRIGGERS)
        {
          const entry = transitionFor(subject, trigger)
          if (entry !== null)
          {
            expect(entry.actors, `${state} ${trigger}`).toEqual(['user'])
          }
        }
      }
    }
  })

  it('leaves a terminal job only through retry, edit and retry, or removal', () =>
  {
    const left = new Set<JobTrigger>()
    for (const state of TERMINAL_STATES)
    {
      for (const trigger of JOB_TRIGGERS)
      {
        if (transitionFor({ state, warnings: [{ code: 'outside-tolerance-placed' }] }, trigger) !== null)
        {
          left.add(trigger)
        }
      }
    }
    expect([...left].sort()).toEqual(['edit-retry', 'remove', 'retry', 'retry-changed'])
  })

  it('retries a done job only when it was placed outside tolerance', () =>
  {
    for (const trigger of ['retry', 'retry-changed', 'edit-retry'] as const)
    {
      expect(transitionFor({ state: 'done', warnings: [] }, trigger)).toBeNull()
      expect(transitionFor({ state: 'done', warnings: [{ code: 'larger-than-source' }] }, trigger)).toBeNull()
      expect(transitionFor({ state: 'done', warnings: [{ code: 'ran-on-cpu' }, { code: 'outside-tolerance-placed' }] }, trigger)?.to)
        .toBe(trigger === 'retry' ? 'queued' : 'pending')
    }
  })

  it('creates a job only through add', () =>
  {
    for (const trigger of JOB_TRIGGERS)
    {
      expect(transitionFor(null, trigger)?.id ?? null, trigger).toBe(trigger === 'add' ? 'T1' : null)
    }
  })

  it('journals the move to finalizing and every hold durably, and nothing else', () =>
  {
    const durable = JOB_TRANSITIONS.filter((entry) => entry.durable).map((entry) => `${entry.id} ${entry.trigger}`)
    expect(durable).toEqual(['T20 verified', 'T21 hold', 'T24 hold', 'T26 keep', 'T32 recover-hold'])
  })

  it('treats the next encode pass as a stage, not a state change', () =>
  {
    expect(JOB_TRANSITIONS.filter((entry) => !entry.changesState).map((entry) => entry.id)).toEqual(['T16'])
    const pass = transitionFor({ state: 'encoding', warnings: [] }, 'next-pass')
    expect(pass?.to).toBe('encoding')
    expect(pass?.reasons).toEqual([])
  })

  it('lets each trigger reach exactly one target state', () =>
  {
    for (const trigger of JOB_TRIGGERS)
    {
      const targets = new Set(JOB_TRANSITIONS.filter((entry) => entry.trigger === trigger).map((entry) => entry.to))
      expect(targets.size, trigger).toBe(1)
    }
  })

  it('removes jobs through T4, T9, and T34 only, and none of them while active or held', () =>
  {
    for (const state of [...ACTIVE_STATES, 'held'] as const)
    {
      expect(transitionFor({ state, warnings: [] }, 'remove'), state).toBeNull()
    }
    expect(JOB_TRANSITIONS.filter((entry) => entry.to === 'removed').map((entry) => entry.id)).toEqual(['T4', 'T9', 'T34'])
  })
})

const RUN_STATUSES: RunStatus[] = ['idle', 'running', 'pausing', 'paused', 'canceling']

/** The run table written out by hand: [from, trigger, active jobs or null for either, to, how an idle run ended]. */
const RUN_TABLE: Array<[RunStatus[], RunTrigger, boolean | null, RunStatus, 'completed' | 'canceled' | null]> = [
  [['idle'], 'start', null, 'running', null],
  [['running'], 'pause', true, 'pausing', null],
  [['running'], 'pause', false, 'paused', null],
  [['pausing'], 'settled', null, 'paused', null],
  [['pausing', 'paused'], 'resume', null, 'running', null],
  [['running', 'pausing', 'paused'], 'cancel', null, 'canceling', null],
  [['canceling'], 'settled', null, 'idle', 'canceled'],
  [['running', 'pausing', 'paused'], 'drained', null, 'idle', 'completed']
]

describe('the run status table', () =>
{
  it('has every row of the run table', () =>
  {
    expect(RUN_TRANSITIONS.map((entry) => [entry.from, entry.trigger, entry.active, entry.to, entry.endedBy])).toEqual(RUN_TABLE)
  })

  it.each(RUN_STATUSES)('answers every trigger from %s, with and without active jobs', (status) =>
  {
    for (const trigger of RUN_TRIGGERS)
    {
      for (const active of [0, 3])
      {
        const expected = RUN_TABLE.find(([from, t, needs]) => from.includes(status) && t === trigger && (needs === null || needs === active > 0))
        const actual = runTransitionFor(status, trigger, active)
        expect(actual?.to ?? null, `${status} ${trigger} ${active}`).toBe(expected?.[3] ?? null)
        expect(actual?.endedBy ?? null, `${status} ${trigger} ${active}`).toBe(expected?.[4] ?? null)
      }
    }
  })

  it('pauses into pausing while jobs are active and straight to paused otherwise', () =>
  {
    expect(runTransitionFor('running', 'pause', 1)?.to).toBe('pausing')
    expect(runTransitionFor('running', 'pause', 0)?.to).toBe('paused')
    expect(runTransitionFor('paused', 'pause', 0)).toBeNull()
    expect(runTransitionFor('idle', 'resume', 0)).toBeNull()
    expect(runTransitionFor('canceling', 'resume', 0)).toBeNull()
  })

  it('ends a run only through drained (completed) or a settled cancel (canceled)', () =>
  {
    const toIdle = RUN_TRANSITIONS.filter((entry) => entry.to === 'idle')
    expect(toIdle.map((entry) => [entry.trigger, entry.endedBy])).toEqual([['settled', 'canceled'], ['drained', 'completed']])
  })
})

describe('states and stages', () =>
{
  it('maps every stage to the state it runs in', () =>
  {
    expect(STAGE_STATES).toEqual({
      'probe': 'analyzing',
      'measure': 'analyzing',
      'measure-dynamics': 'analyzing',
      'measure-album': 'analyzing',
      'encode': 'encoding',
      'verify': 'verifying',
      'place': 'finalizing',
      'trash': 'finalizing',
      'wait-lock': 'finalizing'
    })
    for (const state of Object.values(STAGE_STATES))
    {
      expect(ACTIVE_STATES).toContain(state)
    }
  })

  it('groups the states into waiting, active, decision, and terminal', () =>
  {
    const groups = (group: string): JobState[] => JOB_STATES.filter((state) => STATE_GROUPS[state] === group)
    expect(groups('waiting')).toEqual(['pending', 'queued'])
    expect(groups('active')).toEqual([...ACTIVE_STATES])
    expect(groups('decision')).toEqual(['held'])
    expect(groups('terminal')).toEqual([...TERMINAL_STATES])
  })

  it('counts queued and active jobs as in the run, and nothing else', () =>
  {
    expect(IN_RUN_STATES).toEqual(['queued', ...ACTIVE_STATES])
  })
})

type Column = 'pending' | 'queued' | 'running' | 'finalizing' | 'held' | 'done' | 'finished'
type Expect = CommandAnswer | ((job: CommandSubject) => CommandAnswer)

const placedOutside = (job: CommandSubject): boolean => job.warnings.some((warning) => warning.code === 'outside-tolerance-placed')
const attention = (job: CommandSubject): boolean =>
  job.state === 'held' || (!job.acknowledged && (job.state === 'failed' || job.state === 'interrupted' || (job.state === 'done' && job.warnings.length > 0)))

/** The applicability matrix written out by hand, column by column: pending, queued, running, finalizing, held, done, and finished. */
const MATRIX_TABLE: Record<MatrixCommand, Expect[]> =
{
  remove: ['ok', 'ok', 'job-running', 'job-finalizing', 'job-held', (job) => attention(job) ? 'needs-attention' : 'ok', (job) => attention(job) ? 'needs-attention' : 'ok'],
  reorder: ['ok', 'ok', 'not-movable', 'not-movable', 'not-movable', 'not-movable', 'not-movable'],
  assignRecipe: ['ok', 'ok', 'job-running', 'job-finalizing', 'job-held', (job) => placedOutside(job) ? 'ok' : 'job-terminal', 'ok'],
  duplicate: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  start: ['ok', 'no-op', 'no-op', 'no-op', 'job-held', 'not-retryable', 'not-retryable'],
  unqueue: ['not-queued', 'ok', 'job-running', 'job-finalizing', 'not-queued', 'not-queued', 'not-queued'],
  cancel: ['not-started', 'ok', 'ok', 'job-finalizing', 'job-held', 'job-terminal', 'job-terminal'],
  skip: ['not-started', 'ok', 'ok', 'job-finalizing', 'job-held', 'job-terminal', 'job-terminal'],
  retry: ['not-retryable', 'not-retryable', 'job-running', 'job-finalizing', 'ok', (job) => placedOutside(job) ? 'ok' : 'not-retryable', 'ok'],
  keepOutput: ['not-held', 'not-held', 'not-held', 'not-held', 'ok', 'not-held', 'not-held'],
  discardOutput: ['not-held', 'not-held', 'not-held', 'not-held', 'ok', 'not-held', 'not-held'],
  acknowledge: ['no-op', 'no-op', 'no-op', 'no-op', 'needs-decision', (job) => attention(job) ? 'ok' : 'no-op', (job) => attention(job) ? 'ok' : 'no-op'],
  cancelAnalyze: [(job) => job.analysis === null ? 'not-analyzing' : 'ok', (job) => job.analysis === null ? 'not-analyzing' : 'ok',
    'not-analyzing', 'not-analyzing', 'not-analyzing', 'not-analyzing', 'not-analyzing'],
  locate: ['ok', 'ok', 'job-running', 'job-finalizing', 'job-held', 'job-terminal', 'job-terminal'],
  relink: ['ok', 'ok', 'job-running', 'job-finalizing', 'job-held', 'job-terminal', 'job-terminal'],
  reprobe: ['ok', 'ok', 'job-running', 'job-finalizing', 'job-held', 'job-terminal', 'job-terminal']
}

const COLUMN_ORDER: Column[] = ['pending', 'queued', 'running', 'finalizing', 'held', 'done', 'finished']

function columnOf(state: JobState): Column
{
  if (RUNNING.includes(state))
  {
    return 'running'
  }
  if (FINISHED.includes(state))
  {
    return 'finished'
  }
  return state as Column
}

function job(state: JobState, over: Partial<CommandSubject> = {}): CommandSubject
{
  return { state, warnings: [], acknowledged: false, analysis: null, ...over }
}

const WARNED = [{ code: 'original-kept' as const }]
const PLACED_OUTSIDE = [{ code: 'outside-tolerance-placed' as const }]

/** Every state, with every variant a conditional cell reads. */
const SUBJECTS: Array<[string, CommandSubject]> = [
  ...JOB_STATES.map((state): [string, CommandSubject] => [state, job(state)]),
  ...JOB_STATES.map((state): [string, CommandSubject] => [`${state}, acknowledged`, job(state, { acknowledged: true })]),
  ['pending, analysis queued', job('pending', { analysis: 'queued' })],
  ['queued, analysis running', job('queued', { analysis: 'running' })],
  ['done with a warning', job('done', { warnings: WARNED })],
  ['done with a warning, acknowledged', job('done', { warnings: WARNED, acknowledged: true })],
  ['done placed outside tolerance', job('done', { warnings: PLACED_OUTSIDE })],
  ['done placed outside tolerance, acknowledged', job('done', { warnings: PLACED_OUTSIDE, acknowledged: true })]
]

describe('command applicability', () =>
{
  it('covers the matrix commands, all of them channels', () =>
  {
    for (const command of MATRIX_COMMANDS)
    {
      expect(JOB_COMMAND_NAMES).toContain(command)
    }
    expect(Object.keys(MATRIX_TABLE).sort()).toEqual([...MATRIX_COMMANDS].sort())
  })

  it.each(MATRIX_COMMANDS)('answers %s for every state as the matrix says', (command) =>
  {
    for (const [name, subject] of SUBJECTS)
    {
      const cell = MATRIX_TABLE[command][COLUMN_ORDER.indexOf(columnOf(subject.state))]
      const expected = typeof cell === 'function' ? cell(subject) : cell
      expect(commandApplicability(command, subject), `${command}: ${name}`).toBe(expected)
    }
  })

  it('answers only ok, no-op, or a refusal code the contract knows', () =>
  {
    for (const command of MATRIX_COMMANDS)
    {
      for (const [, subject] of SUBJECTS)
      {
        const answer = commandApplicability(command, subject)
        expect(answer === 'ok' || answer === 'no-op' || (JOB_REFUSAL_CODES as readonly string[]).includes(answer)).toBe(true)
      }
    }
  })

  it('answers a claimed job as a queued one, whatever it waits for', () =>
  {
    const queued = job('queued')
    for (const waiting of [null, 'album', 'gpu-session', 'disk-space', 'volume-offline'] as const)
    {
      const claimed = { ...queued, waiting, waitingOn: waiting === 'volume-offline' ? 'D:' : null, reason: 'requeued-pause' as const }
      for (const command of MATRIX_COMMANDS)
      {
        expect(commandApplicability(command, claimed), `${command} ${waiting}`).toBe(commandApplicability(command, queued))
      }
    }
  })

  it('agrees with the transition table wherever a command causes a transition', () =>
  {
    const pairs: Array<[MatrixCommand, JobTrigger[]]> = [
      ['remove', ['remove']],
      ['start', ['start']],
      ['unqueue', ['unqueue']],
      ['cancel', ['cancel']],
      ['skip', ['skip']],
      ['retry', ['retry', 'retry-changed']],
      ['keepOutput', ['keep']],
      ['discardOutput', ['discard']]
    ]
    for (const [command, triggers] of pairs)
    {
      for (const [name, subject] of SUBJECTS)
      {
        const applies = commandApplicability(command, subject) === 'ok'
        for (const trigger of triggers)
        {
          expect(transitionFor(subject, trigger) !== null, `${command} ${trigger}: ${name}`).toBe(applies || (command === 'remove' && commandApplicability(command, subject) === 'needs-attention'))
        }
      }
    }
  })

  it('edits a finished job into a new attempt only where edit and retry exists', () =>
  {
    for (const [name, subject] of SUBJECTS)
    {
      const finished = subject.state === 'done' || FINISHED.includes(subject.state)
      if (finished)
      {
        expect(transitionFor(subject, 'edit-retry') !== null, name).toBe(commandApplicability('assignRecipe', subject) === 'ok')
      }
    }
  })

  it('names the command to use instead where the matrix does', () =>
  {
    expect(commandInstead('assignRecipe', job('done'))).toBe('duplicate')
    expect(commandInstead('retry', job('done'))).toBe('duplicate')
    expect(commandInstead('retry', job('done', { warnings: PLACED_OUTSIDE }))).toBeNull()
    expect(commandInstead('start', job('failed'))).toBe('retry')
    expect(commandInstead('start', job('done'))).toBeNull()
    expect(commandInstead('cancel', job('held'))).toBe('discardOutput')
    expect(commandInstead('skip', job('held'))).toBeNull()
    for (const command of ['locate', 'relink', 'reprobe'] as const)
    {
      expect(commandInstead(command, job('interrupted'))).toBe('retry')
      expect(commandInstead(command, job('done'))).toBeNull()
      expect(commandInstead(command, job('pending'))).toBeNull()
    }
    expect(commandInstead('acknowledge', job('pending'))).toBeNull()
    expect(commandInstead('unqueue', job('pending'))).toBeNull()
  })
})
