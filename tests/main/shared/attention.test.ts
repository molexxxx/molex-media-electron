/**
 * Attention: which jobs stay lit until someone acknowledges or decides them, and how many there are in one batch or
 * in the whole queue. The header button, the sidebar, the tray, the taskbar, the Needs attention filter, and the held
 * status label all count this one set.
 */
import { describe, it, expect } from 'vitest'
import {
  attentionCount,
  commandApplicability,
  needsAttention,
  needsDecision,
  type CommandSubject
} from '../../../src/shared/jobs/states'
import { JOB_STATES, JOB_WARNING_CODES, type JobHold, type JobState, type JobWarningCode } from '../../../src/shared/jobs/types'
import type { RunId } from '../../../src/shared/jobs/ids'

interface Subject extends CommandSubject
{
  hold: JobHold['reason'] | null
}

function job(state: JobState, over: Partial<Subject> = {}): Subject
{
  return { state, warnings: [], acknowledged: false, analysis: null, hold: null, ...over }
}

function warned(code: JobWarningCode, over: Partial<Subject> = {}): Subject
{
  return job('done', { warnings: [{ code }], ...over })
}

/** Every status word of the table and whether it is held until acknowledged or decided. */
const STATUS_WORDS: Array<[string, Subject, boolean]> = [
  ['Probing', job('pending'), false],
  ['Ready', job('pending'), false],
  ['Ready, attempt 2', job('pending'), false],
  ['Plan changed', job('pending'), false],
  ['Queued', job('queued'), false],
  ['Waiting for album', job('queued'), false],
  ['Probing (running)', job('analyzing'), false],
  ['Measuring', job('analyzing'), false],
  ['Encoding', job('encoding'), false],
  ['Re-encoding (correction)', job('encoding'), false],
  ['Verifying', job('verifying'), false],
  ['Saving', job('finalizing'), false],
  ['Moving original to the Recycle Bin', job('finalizing'), false],
  ['Waiting for file access', job('finalizing'), false],
  ['Needs a decision', job('held', { hold: 'outside-tolerance' }), true],
  ['File appeared, needs a decision', job('held', { hold: 'destination-appeared' }), true],
  ['File in use, needs a decision', job('held', { hold: 'file-locked' }), true],
  ['Interrupted while saving', job('held', { hold: 'interrupted-finalize' }), true],
  ['Verified', job('done'), false],
  ['Done', job('done'), false],
  ['Verified, reachable level', job('done'), false],
  ['Below target', warned('below-target-unpreviewed'), true],
  ['Outside tolerance', warned('outside-tolerance-placed'), true],
  ['Larger than the source', warned('larger-than-source'), true],
  ['Peak over after encoding', warned('decoded-overshoot'), true],
  ['Original kept', warned('original-kept'), true],
  ['Previous file kept', warned('previous-kept'), true],
  ['Ran on the CPU', warned('ran-on-cpu'), true],
  ['Source changed', warned('source-changed'), true],
  ['Failed', job('failed'), true],
  ['Canceled', job('canceled'), false],
  ['Skipped', job('skipped'), false],
  ['Skipped, file exists', job('skipped'), false],
  ['Interrupted', job('interrupted'), true]
]

describe('needsAttention', () =>
{
  it.each(STATUS_WORDS)('"%s" is held exactly when the table says so', (_word, subject, held) =>
  {
    expect(needsAttention(subject)).toBe(held)
  })

  it('holds failed, interrupted, and done-with-warnings jobs until acknowledged', () =>
  {
    for (const subject of [job('failed'), job('interrupted'), ...JOB_WARNING_CODES.map((code) => warned(code))])
    {
      expect(needsAttention(subject), subject.state).toBe(true)
      expect(needsAttention({ ...subject, acknowledged: true }), subject.state).toBe(false)
    }
  })

  it('holds every held job, acknowledged or not', () =>
  {
    for (const hold of ['outside-tolerance', 'destination-appeared', 'file-locked', 'storage-unavailable', 'interrupted-finalize'] as const)
    {
      expect(needsAttention(job('held', { hold }))).toBe(true)
      expect(needsAttention(job('held', { hold, acknowledged: true }))).toBe(true)
    }
  })

  it('never holds a waiting, active, canceled, skipped, or clean done job', () =>
  {
    for (const state of ['pending', 'queued', 'analyzing', 'encoding', 'verifying', 'finalizing', 'canceled', 'skipped', 'done'] as const)
    {
      expect(needsAttention(job(state)), state).toBe(false)
      expect(needsAttention(job(state, { acknowledged: true })), state).toBe(false)
    }
  })

  it('names only held jobs as waiting for a decision', () =>
  {
    for (const state of JOB_STATES)
    {
      expect(needsDecision(job(state)), state).toBe(state === 'held')
    }
  })
})

describe('acknowledgment', () =>
{
  it.each(STATUS_WORDS.filter(([, , held]) => held))('"%s" is acknowledgeable or resolved by a decision', (_word, subject) =>
  {
    const acknowledgeable = commandApplicability('acknowledge', subject) === 'ok'
    const decided = needsDecision(subject) &&
      commandApplicability('keepOutput', subject) === 'ok' &&
      commandApplicability('discardOutput', subject) === 'ok' &&
      commandApplicability('retry', subject) === 'ok'
    expect(acknowledgeable !== decided).toBe(true)
    if (acknowledgeable)
    {
      expect(needsAttention({ ...subject, acknowledged: true })).toBe(false)
    }
    else
    {
      expect(commandApplicability('acknowledge', subject)).toBe('needs-decision')
    }
  })

  it('accepts exactly the jobs that need attention, except a decision', () =>
  {
    const subjects = [
      ...JOB_STATES.flatMap((state) => [job(state), job(state, { acknowledged: true })]),
      ...JOB_WARNING_CODES.flatMap((code) => [warned(code), warned(code, { acknowledged: true })])
    ]
    for (const subject of subjects)
    {
      const accepted = commandApplicability('acknowledge', subject) === 'ok'
      expect(accepted, `${subject.state} ${subject.acknowledged}`).toBe(needsAttention(subject) && !needsDecision(subject))
    }
  })

  it('refuses to remove a job that needs attention and removes it once acknowledged', () =>
  {
    for (const subject of [job('failed'), job('interrupted'), warned('ran-on-cpu')])
    {
      expect(commandApplicability('remove', subject)).toBe('needs-attention')
      expect(commandApplicability('remove', { ...subject, acknowledged: true })).toBe('ok')
    }
    expect(commandApplicability('remove', job('held'))).toBe('job-held')
  })
})

describe('attentionCount', () =>
{
  const r31 = 'R-0031' as RunId
  const r32 = 'R-0032' as RunId

  function inRun(subject: Subject, runId: RunId | null): Subject & { runId: RunId | null }
  {
    return { ...subject, runId }
  }

  const queue = [
    inRun(job('failed'), r31),
    inRun(job('failed', { acknowledged: true }), r31),
    inRun(job('held', { hold: 'outside-tolerance', acknowledged: true }), r31),
    inRun(warned('original-kept'), r31),
    inRun(job('done'), r31),
    inRun(job('canceled'), r31),
    inRun(job('interrupted'), r32),
    inRun(job('encoding'), r32),
    inRun(job('queued'), r32),
    inRun(job('pending'), null)
  ]

  it('counts one run', () =>
  {
    expect(attentionCount(queue, r31)).toBe(3)
    expect(attentionCount(queue, r32)).toBe(1)
    expect(attentionCount(queue, 'R-0099' as RunId)).toBe(0)
  })

  it('counts the whole queue when no run is given', () =>
  {
    expect(attentionCount(queue, null)).toBe(4)
    expect(attentionCount([], null)).toBe(0)
  })

  it('counts any iterable of jobs, such as the values of a map', () =>
  {
    const byId = new Map(queue.map((subject, index) => [`MM-${String(index).padStart(4, '0')}`, subject]))
    expect(attentionCount(byId.values(), null)).toBe(4)
    expect(attentionCount(byId.values(), r31)).toBe(3)
  })

  it('drops a job from the count when it is acknowledged, but never a held one', () =>
  {
    const acknowledged = queue.map((subject) => ({ ...subject, acknowledged: true }))
    expect(attentionCount(acknowledged, null)).toBe(1)
  })
})
