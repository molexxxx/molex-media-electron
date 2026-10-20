/**
 * The jobs IPC contract at runtime: one unique, prefixed channel per command, the one event channel, the event type
 * list, and the code lists the validators and the page read. The compile-time half (every command has a request
 * and a result, JobsApi has one method per command plus onEvents) is checked by both typechecks.
 */
import { describe, it, expect } from 'vitest'
import {
  COMMAND_ERROR_CODES,
  JOB_CHANNELS,
  JOB_COMMAND_NAMES,
  JOB_EVENT_CHANNEL,
  JOB_EVENT_TYPES,
  JOB_REFUSAL_CODES,
  REVEAL_TARGETS,
  isJobChannel
} from '../../../src/shared/jobs/contract'
import {
  ACTIVE_STATES,
  CONFLICT_RULES,
  DEFAULT_TEMPLATES,
  JOB_ERROR_CODES,
  JOB_STATES,
  JOB_WARNING_CODES,
  PAUSE_MODES,
  PLAN_ISSUE_CODES,
  RUN_ALERT_KINDS,
  TEMPLATE_TOKENS,
  TERMINAL_STATES
} from '../../../src/shared/jobs/types'

const channels = Object.values(JOB_CHANNELS)

describe('JOB_CHANNELS', () =>
{
  it('gives every command a unique channel', () =>
  {
    expect(new Set(channels).size).toBe(channels.length)
    expect(channels).toHaveLength(50)
  })

  it('uses only the jobs:, run:, runs:, and presets: prefixes', () =>
  {
    for (const channel of channels)
    {
      expect(channel, channel).toMatch(/^(?:jobs|run|runs|presets):[A-Za-z]+$/)
    }
  })

  it('names the commands in channel order', () =>
  {
    expect(JOB_COMMAND_NAMES).toEqual(Object.keys(JOB_CHANNELS))
    expect(JOB_COMMAND_NAMES.map((name) => JOB_CHANNELS[name])).toEqual(channels)
  })

  it('keeps run, history, and preset commands under their own prefixes', () =>
  {
    expect(JOB_CHANNELS.start).toBe('run:start')
    expect(JOB_CHANNELS.cancelRun).toBe('run:cancel')
    expect(JOB_CHANNELS.listRuns).toBe('runs:list')
    expect(JOB_CHANNELS.revealRecord).toBe('runs:reveal')
    expect(JOB_CHANNELS.setPin).toBe('presets:setPin')
    expect(JOB_CHANNELS.subscribe).toBe('jobs:subscribe')
  })

  it('has no preset export or import channel', () =>
  {
    expect(channels).not.toContain('presets:export')
    expect(channels).not.toContain('presets:import')
  })

  it('includes the restore, locate, relink, reprobe, paste, recent-folder, analysis, alert, search, rerun, delete, rename, and pin commands', () =>
  {
    for (const channel of ['jobs:restore', 'jobs:locate', 'jobs:relink', 'jobs:reprobe', 'jobs:pasteFiles', 'jobs:forgetFolder',
      'jobs:clearRecentFolders', 'jobs:cancelAnalyze', 'run:dismissAlert', 'run:revealAlert', 'runs:search', 'runs:rerun',
      'runs:delete', 'presets:rename', 'presets:setPin'])
    {
      expect(channels, channel).toContain(channel)
    }
  })
})

describe('the event channel', () =>
{
  it('is jobs:event and no command uses it', () =>
  {
    expect(JOB_EVENT_CHANNEL).toBe('jobs:event')
    expect(channels).not.toContain(JOB_EVENT_CHANNEL)
  })

  it('lists every event type once', () =>
  {
    expect(new Set(JOB_EVENT_TYPES).size).toBe(JOB_EVENT_TYPES.length)
    expect(JOB_EVENT_TYPES).toHaveLength(24)
    expect(JOB_EVENT_TYPES).toEqual(expect.arrayContaining(['run.alertCleared', 'presets.changed', 'defaultRecipe.changed', 'folders.changed', 'ui.focus']))
  })
})

describe('isJobChannel', () =>
{
  it('accepts command channels only', () =>
  {
    for (const channel of channels)
    {
      expect(isJobChannel(channel), channel).toBe(true)
    }
    for (const other of ['jobs:event', 'process:batch-queue', 'jobs:Subscribe', 'presets:export', ''])
    {
      expect(isJobChannel(other), other).toBe(false)
    }
  })
})

describe('code lists', () =>
{
  it('lists twelve job states, split into active and terminal ones', () =>
  {
    expect(JOB_STATES).toHaveLength(12)
    expect(ACTIVE_STATES).toEqual(['analyzing', 'encoding', 'verifying', 'finalizing'])
    expect(TERMINAL_STATES).toEqual(['done', 'failed', 'canceled', 'skipped', 'interrupted'])
    expect(ACTIVE_STATES.filter((state) => TERMINAL_STATES.includes(state))).toEqual([])
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES])
    {
      expect(JOB_STATES).toContain(state)
    }
  })

  it('lists the eight warnings a done job keeps lit', () =>
  {
    expect(JOB_WARNING_CODES).toEqual(['original-kept', 'previous-kept', 'ran-on-cpu', 'source-changed',
      'below-target-unpreviewed', 'outside-tolerance-placed', 'larger-than-source', 'decoded-overshoot'])
  })

  it('lists the alert kinds the restored, destination, and migration banners need', () =>
  {
    expect(RUN_ALERT_KINDS).toEqual(expect.arrayContaining(['restored-queue', 'destination-unavailable', 'replace-migrated', 'restored-run', 'volume-offline']))
    expect(new Set(RUN_ALERT_KINDS).size).toBe(RUN_ALERT_KINDS.length)
  })

  it('lists the plan issues the page groups, with no duplicates', () =>
  {
    expect(new Set(PLAN_ISSUE_CODES).size).toBe(PLAN_ISSUE_CODES.length)
    for (const code of ['album-incomplete', 'no-video-stream', 'audio-only-output', 'subtitle-bitmap', 'no-audio-stream', 'keyframe-trim',
      'trash-too-small', 'no-recycle-bin', 'layout-remapped', 'streams-dropped'])
    {
      expect(PLAN_ISSUE_CODES, code).toContain(code)
    }
  })

  it('lists error, refusal, and command codes with no duplicates', () =>
  {
    for (const list of [JOB_ERROR_CODES, JOB_REFUSAL_CODES, COMMAND_ERROR_CODES])
    {
      expect(new Set(list).size).toBe(list.length)
    }
    expect(JOB_ERROR_CODES).toContain('source-offline')
    expect(JOB_REFUSAL_CODES).toEqual(expect.arrayContaining(['needs-attention', 'needs-decision', 'invalid-recipe']))
    expect(COMMAND_ERROR_CODES).toEqual(expect.arrayContaining(['invalid-payload', 'untrusted-sender', 'plan-stale', 'confirmation-required', 'restore-expired']))
  })

  it('lists the policy and request values the validators accept', () =>
  {
    expect(CONFLICT_RULES).toEqual(['skip', 'rename', 'overwrite'])
    expect(PAUSE_MODES).toEqual(['finish-running', 'stop-running'])
    expect(REVEAL_TARGETS).toEqual(['source', 'output', 'held-output', 'kept-original', 'log'])
    expect(TEMPLATE_TOKENS).toEqual(['name', 'ext', 'op', 'preset', 'catalog', 'date', 'subdir'])
    expect(DEFAULT_TEMPLATES).toEqual({ 'folder': '{name}', 'next-to-source': '{name}-{op}' })
  })
})
