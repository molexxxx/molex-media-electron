import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  QUIT_BUTTONS,
  THROUGHPUT_HELP,
  TOOLTIP_MAX,
  TRAY_LABELS,
  autoPauseNotification,
  closedToTrayNotification,
  engineBusy,
  firstReturnedNotification,
  idleQuitDue,
  nextQuitWhenIdle,
  quitChoiceEffect,
  quitDecision,
  quitPrompt,
  runEndedNotification,
  shouldNotifyClosedToTray,
  shouldNotifyFirstReturned,
  systemEndingPlan,
  updateWaitingText,
  type QuitState,
  formatBytes,
  formatElapsed,
  formatThroughput,
  formatTimeLeft,
  keepAwake,
  runTally,
  runTimeLeftText,
  taskbarProgress,
  trayMenu,
  trayRefreshDelay,
  trayStatus,
  trayTooltip,
  type StatusInput
} from '../../../src/main/jobs/status'
import { formatCatalog, formatRunId } from '../../../src/shared/jobs/ids'
import type { JobCounts, JobState, RunStatus } from '../../../src/shared/jobs/types'

const RUN = formatRunId(31)

function counts(values: Partial<Record<JobState, number>> = {}): JobCounts
{
  return {
    pending: 0,
    queued: 0,
    analyzing: 0,
    encoding: 0,
    verifying: 0,
    finalizing: 0,
    held: 0,
    done: 0,
    failed: 0,
    canceled: 0,
    skipped: 0,
    interrupted: 0,
    ...values
  }
}

function input(overrides: {
  status?: RunStatus
  runId?: StatusInput['run']['runId']
  counts?: JobCounts
  percent?: number
  etaSec?: number | null
  quitWhenIdle?: boolean
  runAttention?: number
  attention?: number
} = {}): StatusInput
{
  return {
    run: {
      status: overrides.status ?? 'running',
      runId: overrides.runId === undefined ? RUN : overrides.runId,
      counts: overrides.counts ?? counts({ done: 11, failed: 1, encoding: 3, queued: 65 }),
      quitWhenIdle: overrides.quitWhenIdle ?? false,
      progress: { percent: overrides.percent ?? 42.7, etaSec: overrides.etaSec === undefined ? 14 * 60 : overrides.etaSec }
    },
    runAttention: overrides.runAttention ?? 1,
    attention: overrides.attention ?? 1
  }
}

describe('words', () =>
{
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1000, '1 KB'],
    [1530, '1.5 KB'],
    [312_000_000, '312 MB'],
    [21_400_000_000, '21.4 GB'],
    [999_600, '1 MB'],
    [99_960_000, '100 MB'],
    [2_000_000_000_000_000_000, '2000 PB'],
    [-5, '0 B'],
    [Number.NaN, '0 B']
  ])('formats %d bytes as %s', (bytes, text) =>
  {
    expect(formatBytes(bytes)).toBe(text)
  })

  it.each([
    [0, '0 s'],
    [38_000, '38 s'],
    [59_600, '1 min'],
    [42 * 60_000, '42 min'],
    [65 * 60_000, '1 h 5 min'],
    [120 * 60_000, '2 h'],
    [Number.NaN, '0 s']
  ])('formats %d ms of elapsed time as %s', (ms, text) =>
  {
    expect(formatElapsed(ms)).toBe(text)
  })

  it.each([
    [0, 'less than a minute left'],
    [59, 'less than a minute left'],
    [18 * 60 + 10, 'about 18 min left'],
    [80 * 60, 'about 1 h 20 min left'],
    [3 * 3600, 'about 3 h left'],
    [-3, 'less than a minute left']
  ])('words %d seconds left as %s', (seconds, text) =>
  {
    expect(formatTimeLeft(seconds)).toBe(text)
  })

  it('shows time left only while running and estimates until a figure exists', () =>
  {
    expect(runTimeLeftText({ status: 'running', progress: { etaSec: null } })).toBe('Estimating time left')
    expect(runTimeLeftText({ status: 'running', progress: { etaSec: 30 } })).toBe('less than a minute left')
    expect(runTimeLeftText({ status: 'running', progress: { etaSec: 1080 } })).toBe('about 18 min left')
    for (const status of ['idle', 'pausing', 'paused', 'canceling'] as RunStatus[])
    {
      expect(runTimeLeftText({ status, progress: { etaSec: 1080 } })).toBeNull()
    }
  })

  it.each([
    [3.4, '3.4x realtime'],
    [0.05, '0.05x realtime'],
    [12.25, '12.3x realtime'],
    [140.4, '140x realtime']
  ])('writes a throughput of %d as %s', (value, text) =>
  {
    expect(formatThroughput(value)).toBe(text)
  })

  it('has no throughput figure without a positive rate', () =>
  {
    expect(formatThroughput(null)).toBeNull()
    expect(formatThroughput(0)).toBeNull()
    expect(formatThroughput(Number.NaN)).toBeNull()
    expect(THROUGHPUT_HELP).toBe('Media seconds processed per second of wall time, across all workers.')
  })
})

describe('runTally', () =>
{
  it('counts held and terminal jobs as finished and leaves pending jobs out', () =>
  {
    expect(runTally(counts({ pending: 4, queued: 5, analyzing: 1, encoding: 2, verifying: 1, finalizing: 1, held: 1, done: 6, failed: 1, canceled: 1, skipped: 1, interrupted: 1 })))
      .toEqual({ total: 21, finished: 11, active: 5, queued: 5 })
  })
})

describe('trayTooltip', () =>
{
  it('describes a running batch in the 7.18 words', () =>
  {
    expect(trayTooltip(input())).toBe('molexMedia: Batch 31, 42%, 12 of 80 finished, 1 needs attention, about 14 min left')
  })

  it('pluralizes the attention count and leaves out parts that are absent', () =>
  {
    expect(trayTooltip(input({ runAttention: 2 }))).toBe('molexMedia: Batch 31, 42%, 12 of 80 finished, 2 need attention, about 14 min left')
    expect(trayTooltip(input({ runAttention: 0, etaSec: null }))).toBe('molexMedia: Batch 31, 42%, 12 of 80 finished')
  })

  it('groups large counts', () =>
  {
    const text = trayTooltip(input({ counts: counts({ done: 1200, queued: 8800 }), runAttention: 0 }))
    expect(text).toBe('molexMedia: Batch 31, 42%, 1,200 of 10,000 finished, about 14 min left')
  })

  it('never rounds a running batch up to 100%', () =>
  {
    expect(trayTooltip(input({ percent: 99.9, runAttention: 0, etaSec: null }))).toBe('molexMedia: Batch 31, 99%, 12 of 80 finished')
    expect(trayTooltip(input({ percent: Number.NaN, runAttention: 0, etaSec: null }))).toBe('molexMedia: Batch 31, 0%, 12 of 80 finished')
  })

  it('drops parts from the end to fit 127 characters, the attention count last', () =>
  {
    const big = 10 ** 40
    const long = input({ counts: counts({ done: big, queued: big }), runAttention: 3, etaSec: 999_999_999 })
    const text = trayTooltip(long)
    expect(text.length).toBeLessThanOrEqual(TOOLTIP_MAX)
    expect(text).toContain('3 need attention')
    expect(text).not.toContain('left')
    expect(text).not.toContain('finished')
  })

  it('drops only the time left when that is enough', () =>
  {
    const many = 10 ** 15
    const text = trayTooltip(input({ counts: counts({ done: many, queued: many }), runAttention: 12_345, etaSec: 10 ** 9 }))
    expect(text).toBe('molexMedia: Batch 31, 42%, 1,000,000,000,000,000 of 2,000,000,000,000,000 finished, 12,345 need attention')
    expect(text.length).toBeLessThanOrEqual(TOOLTIP_MAX)
  })

  it('drops the attention count too when even it does not fit', () =>
  {
    expect(trayTooltip(input({ runAttention: 10 ** 120, etaSec: null }))).toBe('molexMedia: Batch 31')
  })

  it('cuts a tooltip without parts to drop at 127 characters', () =>
  {
    const text = trayTooltip(input({ status: 'idle', runId: null, attention: 10 ** 120 }))
    expect(text.length).toBe(TOOLTIP_MAX)
    expect(text.endsWith('…')).toBe(true)
    expect(text.startsWith('molexMedia: 1,000,000')).toBe(true)
  })

  it('names a paused, pausing, or canceling batch', () =>
  {
    expect(trayTooltip(input({ status: 'paused' }))).toBe('molexMedia: Batch 31 paused')
    expect(trayTooltip(input({ status: 'pausing' }))).toBe('molexMedia: Batch 31 pausing')
    expect(trayTooltip(input({ status: 'canceling' }))).toBe('molexMedia: Batch 31 canceling')
  })

  it('says when the app quits after the current jobs', () =>
  {
    expect(trayTooltip(input({ status: 'pausing', quitWhenIdle: true }))).toBe('molexMedia: Batch 31, quitting when current jobs finish')
  })

  it('counts jobs that need attention when no run is active', () =>
  {
    expect(trayTooltip(input({ status: 'idle', runId: null, attention: 2 }))).toBe('molexMedia: 2 jobs need attention')
    expect(trayTooltip(input({ status: 'idle', runId: RUN, attention: 1 }))).toBe('molexMedia: 1 job needs attention')
    expect(trayTooltip(input({ status: 'idle', runId: null, attention: 0 }))).toBe(APP_NAME)
  })
})

describe('trayStatus and trayMenu', () =>
{
  it('offers pause and cancel while running', () =>
  {
    const status = trayStatus(input())
    expect(status).toEqual({
      tooltip: 'molexMedia: Batch 31, 42%, 12 of 80 finished, 1 needs attention, about 14 min left',
      statusLine: 'Batch 31: 12 of 80 finished',
      runControl: 'pause',
      canCancel: true
    })
    expect(trayMenu(status)).toEqual([
      { type: 'status', label: 'Batch 31: 12 of 80 finished' },
      { type: 'item', action: 'pause', label: 'Pause batch' },
      { type: 'item', action: 'cancel', label: 'Cancel batch…' },
      { type: 'separator' },
      { type: 'item', action: 'show', label: 'Show molexMedia' },
      { type: 'separator' },
      { type: 'item', action: 'batch', label: 'Batch' },
      { type: 'item', action: 'editor', label: 'Editor' },
      { type: 'item', action: 'player', label: 'Player' },
      { type: 'item', action: 'logs', label: 'Logs' },
      { type: 'separator' },
      { type: 'item', action: 'quit', label: 'Quit' }
    ])
  })

  it('offers resume while pausing or paused', () =>
  {
    for (const status of ['pausing', 'paused'] as RunStatus[])
    {
      const tray = trayStatus(input({ status }))
      expect(tray.runControl).toBe('resume')
      expect(tray.canCancel).toBe(true)
      expect(trayMenu(tray)[1]).toEqual({ type: 'item', action: 'resume', label: TRAY_LABELS.resume })
    }
  })

  it('offers no run controls while canceling', () =>
  {
    const tray = trayStatus(input({ status: 'canceling' }))
    expect(tray).toMatchObject({ statusLine: 'Batch 31: 12 of 80 finished', runControl: null, canCancel: false })
    expect(trayMenu(tray).slice(0, 3)).toEqual([
      { type: 'status', label: 'Batch 31: 12 of 80 finished' },
      { type: 'separator' },
      { type: 'item', action: 'show', label: 'Show molexMedia' }
    ])
  })

  it('shows only the app items when no run is active', () =>
  {
    const tray = trayStatus(input({ status: 'idle', runId: null, attention: 0 }))
    expect(tray).toEqual({ tooltip: 'molexMedia', statusLine: null, runControl: null, canCancel: false })
    expect(trayMenu(tray).map((item) => (item.type === 'item' ? item.label : item.type))).toEqual([
      'Show molexMedia', 'separator', 'Batch', 'Editor', 'Player', 'Logs', 'separator', 'Quit'
    ])
  })
})

describe('trayRefreshDelay', () =>
{
  const running = trayStatus(input())
  const later = trayStatus(input({ percent: 50 }))

  it('renders the first status and run status changes at once', () =>
  {
    expect(trayRefreshDelay(null, { status: 'running', tray: running }, 0)).toBe(0)
    expect(trayRefreshDelay({ status: 'running', tray: running, at: 1000 }, { status: 'paused', tray: running }, 1200)).toBe(0)
  })

  it('skips an unchanged status', () =>
  {
    expect(trayRefreshDelay({ status: 'running', tray: running, at: 0 }, { status: 'running', tray: { ...running } }, 5000)).toBeNull()
  })

  it('updates at most once per second', () =>
  {
    expect(trayRefreshDelay({ status: 'running', tray: running, at: 1000 }, { status: 'running', tray: later }, 1400)).toBe(600)
    expect(trayRefreshDelay({ status: 'running', tray: running, at: 1000 }, { status: 'running', tray: later }, 2000)).toBe(0)
    expect(trayRefreshDelay({ status: 'running', tray: running, at: 1000 }, { status: 'running', tray: { ...running, canCancel: false } }, 9000)).toBe(0)
  })
})

describe('taskbarProgress', () =>
{
  it('shows normal progress while running', () =>
  {
    expect(taskbarProgress(input({ percent: 42 }))).toEqual({ fraction: 0.42, mode: 'normal' })
  })

  it('shows the paused state while pausing or paused', () =>
  {
    expect(taskbarProgress(input({ status: 'pausing', percent: 10 }))).toEqual({ fraction: 0.1, mode: 'paused' })
    expect(taskbarProgress(input({ status: 'paused', percent: 10 }))).toEqual({ fraction: 0.1, mode: 'paused' })
  })

  it('shows a full error bar while jobs need attention and no run is active', () =>
  {
    expect(taskbarProgress(input({ status: 'idle', runId: null, attention: 3, percent: 100 }))).toEqual({ fraction: 1, mode: 'error' })
  })

  it('removes the progress otherwise', () =>
  {
    expect(taskbarProgress(input({ status: 'idle', runId: null, attention: 0 }))).toBeNull()
    expect(taskbarProgress(input({ status: 'canceling' }))).toBeNull()
  })

  it('clamps the fraction', () =>
  {
    expect(taskbarProgress(input({ percent: 130 }))?.fraction).toBe(1)
    expect(taskbarProgress(input({ percent: -4 }))?.fraction).toBe(0)
    expect(taskbarProgress(input({ percent: Number.NaN }))?.fraction).toBe(0)
  })
})

describe('keepAwake', () =>
{
  it('keeps the system awake while jobs run and the setting is on', () =>
  {
    expect(keepAwake('running', true)).toBe(true)
    expect(keepAwake('pausing', true)).toBe(true)
    expect(keepAwake('canceling', true)).toBe(true)
    expect(keepAwake('paused', true)).toBe(false)
    expect(keepAwake('idle', true)).toBe(false)
    expect(keepAwake('running', false)).toBe(false)
  })
})

function summary(overrides: {
  endedBy?: 'completed' | 'canceled'
  total?: number
  verified?: number
  returned?: number
  canceled?: number
  skipped?: number
  output?: number
  elapsedMs?: number
} = {})
{
  return {
    runId: RUN,
    endedBy: overrides.endedBy ?? 'completed',
    counts: {
      total: overrides.total ?? 22,
      done: 0,
      verified: overrides.verified ?? 19,
      reachable: 0,
      outsideTolerance: 0,
      failed: 0,
      canceled: overrides.canceled ?? 1,
      skipped: overrides.skipped ?? 0,
      held: 0,
      interrupted: 0,
      returned: overrides.returned ?? 2
    },
    bytes: { input: 50_000_000_000, output: overrides.output ?? 21_400_000_000 },
    elapsedMs: overrides.elapsedMs ?? 42 * 60_000
  }
}

describe('run notifications', () =>
{
  const focus = { jobId: null, runId: RUN }

  it('words a finished batch', () =>
  {
    expect(runEndedNotification(summary())).toEqual({
      title: 'Batch 31 finished',
      body: '19 verified, 2 returned, 1 canceled. 21.4 GB written in 42 min.',
      focus
    })
  })

  it('words a batch whose every job verified', () =>
  {
    expect(runEndedNotification(summary({ total: 22, verified: 22, returned: 0, canceled: 0 })).body)
      .toBe('All 22 jobs verified. 21.4 GB written in 42 min.')
    expect(runEndedNotification(summary({ total: 1, verified: 1, returned: 0, canceled: 0, output: 4_200_000, elapsedMs: 38_000 })).body)
      .toBe('1 job verified. 4.2 MB written in 38 s.')
  })

  it('leaves out the parts that are absent', () =>
  {
    expect(runEndedNotification(summary({ verified: 0, returned: 3, canceled: 0, output: 0 })).body).toBe('3 returned.')
    expect(runEndedNotification(summary({ verified: 20, returned: 0, canceled: 0, skipped: 2 })).body)
      .toBe('20 verified, 2 skipped. 21.4 GB written in 42 min.')
    expect(runEndedNotification(summary({ total: 0, verified: 0, returned: 0, canceled: 0, output: 0 })).body).toBe('')
  })

  it('words a canceled batch and counts its canceled jobs', () =>
  {
    expect(runEndedNotification(summary({ endedBy: 'canceled', verified: 10, returned: 0, canceled: 12 }))).toEqual({
      title: 'Batch 31 canceled',
      body: '10 verified, 12 canceled.',
      focus
    })
    expect(runEndedNotification(summary({ endedBy: 'canceled', verified: 0, returned: 1, canceled: 12 })).body).toBe('1 returned, 12 canceled.')
  })

  it('words the first returned job', () =>
  {
    const job = { id: formatCatalog(142), runId: RUN, fileName: 'Episode 12.wav' }
    expect(firstReturnedNotification(job, 'The output stayed 2.3 LU below the target.')).toEqual({
      title: 'MM-0142 returned',
      body: 'Episode 12.wav: The output stayed 2.3 LU below the target.',
      focus: { jobId: job.id, runId: RUN }
    })
  })

  it('notifies the first returned job only when enabled, new, and the window is out of view', () =>
  {
    const shown = { visible: true, focused: true }
    expect(shouldNotifyFirstReturned({ enabled: true, alreadyNotified: false, window: shown })).toBe(false)
    expect(shouldNotifyFirstReturned({ enabled: true, alreadyNotified: false, window: { visible: true, focused: false } })).toBe(true)
    expect(shouldNotifyFirstReturned({ enabled: true, alreadyNotified: false, window: { visible: false, focused: false } })).toBe(true)
    expect(shouldNotifyFirstReturned({ enabled: true, alreadyNotified: false, window: null })).toBe(true)
    expect(shouldNotifyFirstReturned({ enabled: true, alreadyNotified: true, window: null })).toBe(false)
    expect(shouldNotifyFirstReturned({ enabled: false, alreadyNotified: false, window: null })).toBe(false)
  })

  it('words the pauses the engine makes itself', () =>
  {
    expect(autoPauseNotification(RUN, 'disk-space', 'D:')).toEqual({ title: 'Batch 31 paused', body: 'D: is full. Free some space, then resume.', focus })
    expect(autoPauseNotification(RUN, 'destination-unavailable', 'D:\\Exports')?.body).toBe('D:\\Exports is not available. Reconnect it, then resume.')
    expect(autoPauseNotification(RUN, 'disk-space', null)?.body).toBe('The output drive is full. Free some space, then resume.')
    expect(autoPauseNotification(RUN, 'destination-unavailable', null)?.body).toBe('The output folder is not available. Reconnect it, then resume.')
    expect(autoPauseNotification(RUN, 'storage', null)?.body).toBe('molexMedia cannot save its batch records. Check the drive, then resume.')
    expect(autoPauseNotification(RUN, 'ffmpeg-unavailable', null)?.body).toBe('FFmpeg is not available. Check FFmpeg in Settings, then resume.')
  })

  it('stays quiet for pauses the user or a restart made', () =>
  {
    expect(autoPauseNotification(RUN, 'user', null)).toBeNull()
    expect(autoPauseNotification(RUN, 'restored', null)).toBeNull()
    expect(autoPauseNotification(RUN, 'quit-pending', null)).toBeNull()
  })

  it('says once per run that the batch keeps running in the tray', () =>
  {
    expect(closedToTrayNotification(RUN)).toEqual({ title: 'molexMedia keeps running Batch 31 in the tray.', body: '', focus })
    expect(shouldNotifyClosedToTray(RUN, null)).toBe(true)
    expect(shouldNotifyClosedToTray(RUN, RUN)).toBe(false)
    expect(shouldNotifyClosedToTray(formatRunId(32), RUN)).toBe(true)
    expect(shouldNotifyClosedToTray(null, null)).toBe(false)
  })

  it('words an update that waits for the batch', () =>
  {
    expect(updateWaitingText(RUN)).toBe('An update is ready. It installs when Batch 31 finishes.')
  })
})

describe('quit dialog', () =>
{
  it('uses the 7.18 words', () =>
  {
    expect(quitPrompt({ runId: RUN, active: 3, queued: 42 })).toEqual({
      message: 'Batch 31 is still running.',
      detail: '3 jobs are in progress and 42 are queued. Quit now stops the jobs in progress; you can retry them the next time you open molexMedia. Queued jobs stay queued.'
    })
    expect(QUIT_BUTTONS.map((button) => button.label)).toEqual(['Keep running', 'Quit when current jobs finish', 'Quit now'])
    expect(QUIT_BUTTONS[0].choice).toBe('keep-running')
  })

  it('agrees in number and leaves out absent counts', () =>
  {
    expect(quitPrompt({ runId: RUN, active: 1, queued: 1 }).detail)
      .toBe('1 job is in progress and 1 is queued. Quit now stops the job in progress; you can retry it the next time you open molexMedia. Queued jobs stay queued.')
    expect(quitPrompt({ runId: RUN, active: 2, queued: 0 }).detail)
      .toBe('2 jobs are in progress. Quit now stops the jobs in progress; you can retry them the next time you open molexMedia.')
    expect(quitPrompt({ runId: RUN, active: 0, queued: 5 }).detail).toBe('5 jobs are queued. Queued jobs stay queued.')
    expect(quitPrompt({ runId: RUN, active: 0, queued: 1 }).detail).toBe('1 job is queued. It stays queued.')
    expect(quitPrompt({ runId: null, active: 1, queued: 0 }).message).toBe('molexMedia is still running jobs.')
    expect(quitPrompt({ runId: RUN, active: 0, queued: 0 }).detail).toBe('')
  })

  it('maps each choice to its effect', () =>
  {
    expect(quitChoiceEffect('keep-running')).toEqual({ pause: null, quitWhenIdle: false, quitNow: false })
    expect(quitChoiceEffect('quit-when-idle')).toEqual({ pause: 'finish-running', quitWhenIdle: true, quitNow: false })
    expect(quitChoiceEffect('quit-now')).toEqual({ pause: null, quitWhenIdle: false, quitNow: true })
  })
})

describe('quitWhenIdle', () =>
{
  it('is set only by the dialog and cleared by resume, start, and Keep running', () =>
  {
    expect(nextQuitWhenIdle(false, 'quit-when-idle')).toBe(true)
    expect(nextQuitWhenIdle(true, 'resume')).toBe(false)
    expect(nextQuitWhenIdle(true, 'start')).toBe(false)
    expect(nextQuitWhenIdle(true, 'keep-running')).toBe(false)
    expect(nextQuitWhenIdle(true, 'pause')).toBe(true)
    expect(nextQuitWhenIdle(false, 'cancel')).toBe(false)
  })

  it('quits once no job is active or claimed', () =>
  {
    expect(idleQuitDue({ quitWhenIdle: true, active: 0, claimed: 0 })).toBe(true)
    expect(idleQuitDue({ quitWhenIdle: true, active: 1, claimed: 0 })).toBe(false)
    expect(idleQuitDue({ quitWhenIdle: true, active: 0, claimed: 1 })).toBe(false)
    expect(idleQuitDue({ quitWhenIdle: false, active: 0, claimed: 0 })).toBe(false)
  })
})

describe('engineBusy', () =>
{
  it('is busy with active or claimed jobs, or queued jobs in a running or pausing run', () =>
  {
    expect(engineBusy({ status: 'paused', active: 1, claimed: 0, queued: 0 })).toBe(true)
    expect(engineBusy({ status: 'idle', active: 0, claimed: 1, queued: 0 })).toBe(true)
    expect(engineBusy({ status: 'running', active: 0, claimed: 0, queued: 3 })).toBe(true)
    expect(engineBusy({ status: 'pausing', active: 0, claimed: 0, queued: 3 })).toBe(true)
    expect(engineBusy({ status: 'paused', active: 0, claimed: 0, queued: 3 })).toBe(false)
    expect(engineBusy({ status: 'running', active: 0, claimed: 0, queued: 0 })).toBe(false)
  })
})

function quitState(overrides: Partial<QuitState> = {}): QuitState
{
  return {
    platform: 'win32',
    busy: true,
    confirmed: false,
    systemEnding: false,
    dialogOpen: false,
    quitting: false,
    minimizeToTray: false,
    shutdown: 'none',
    ...overrides
  }
}

describe('quitDecision for the close handler', () =>
{
  it('asks in the close handler while busy, with the window still open', () =>
  {
    expect(quitDecision(quitState(), 'window-close')).toEqual({ action: 'ask', resetQuitting: false, showWindow: false })
    expect(quitDecision(quitState({ platform: 'linux' }), 'window-close')).toEqual({ action: 'ask', resetQuitting: false, showWindow: false })
  })

  it('waits while the dialog is already open', () =>
  {
    expect(quitDecision(quitState({ dialogOpen: true }), 'window-close')).toEqual({ action: 'wait' })
  })

  it('closes and marks the app quitting when idle or confirmed', () =>
  {
    expect(quitDecision(quitState({ busy: false }), 'window-close')).toEqual({ action: 'close', markQuitting: true })
    expect(quitDecision(quitState({ confirmed: true }), 'window-close')).toEqual({ action: 'close', markQuitting: true })
  })

  it('lets the close go ahead when the app is already quitting', () =>
  {
    expect(quitDecision(quitState({ quitting: true }), 'window-close')).toEqual({ action: 'close', markQuitting: false })
  })

  it('hides to the tray when minimize to tray is on', () =>
  {
    expect(quitDecision(quitState({ minimizeToTray: true }), 'window-close')).toEqual({ action: 'hide' })
    expect(quitDecision(quitState({ minimizeToTray: true, platform: 'darwin' }), 'window-close')).toEqual({ action: 'hide' })
  })

  it('never quits on a macOS window close', () =>
  {
    expect(quitDecision(quitState({ platform: 'darwin' }), 'window-close')).toEqual({ action: 'close', markQuitting: false })
  })

  it('never asks while the system ends the session', () =>
  {
    expect(quitDecision(quitState({ systemEnding: true }), 'window-close')).toEqual({ action: 'close', markQuitting: true })
    expect(quitDecision(quitState({ systemEnding: true, minimizeToTray: true }), 'window-close')).toEqual({ action: 'close', markQuitting: true })
  })
})

describe('quitDecision for before-quit', () =>
{
  it('asks while busy, resetting the quitting flag and showing the main window', () =>
  {
    expect(quitDecision(quitState({ quitting: true }), 'before-quit')).toEqual({ action: 'ask', resetQuitting: true, showWindow: true })
    expect(quitDecision(quitState({ platform: 'darwin' }), 'before-quit')).toEqual({ action: 'ask', resetQuitting: true, showWindow: true })
  })

  it('waits for an open dialog or a running shutdown', () =>
  {
    expect(quitDecision(quitState({ dialogOpen: true }), 'before-quit')).toEqual({ action: 'wait' })
    expect(quitDecision(quitState({ confirmed: true, shutdown: 'running' }), 'before-quit')).toEqual({ action: 'wait' })
  })

  it('runs the shutdown once before the real quit, busy or not', () =>
  {
    expect(quitDecision(quitState({ confirmed: true }), 'before-quit')).toEqual({ action: 'shutdown' })
    expect(quitDecision(quitState({ busy: false }), 'before-quit')).toEqual({ action: 'shutdown' })
    expect(quitDecision(quitState({ busy: false, shutdown: 'done' }), 'before-quit')).toEqual({ action: 'proceed' })
  })

  it('never asks while the system ends the session', () =>
  {
    expect(quitDecision(quitState({ systemEnding: true }), 'before-quit')).toEqual({ action: 'shutdown' })
    expect(quitDecision(quitState({ systemEnding: true, shutdown: 'done' }), 'before-quit')).toEqual({ action: 'proceed' })
  })
})

describe('systemEndingPlan', () =>
{
  it('persists at once on a Windows session end without delaying it', () =>
  {
    expect(systemEndingPlan('session-end', 'win32')).toEqual({ systemEnding: true, persistNow: true, delayShutdown: false, closeDialog: true, shutdown: false })
  })

  it('delays a macOS or Linux shutdown, closes the dialog, and quits', () =>
  {
    for (const platform of ['darwin', 'linux'] as const)
    {
      expect(systemEndingPlan('shutdown', platform)).toEqual({ systemEnding: true, persistNow: false, delayShutdown: true, closeDialog: true, shutdown: true })
    }
  })

  it('ignores events a platform does not send', () =>
  {
    expect(systemEndingPlan('session-end', 'darwin')).toBeNull()
    expect(systemEndingPlan('session-end', 'linux')).toBeNull()
    expect(systemEndingPlan('shutdown', 'win32')).toBeNull()
  })
})
