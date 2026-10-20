/**
 * What the engine shows outside the window, as text and decisions: the tray tooltip and menu, the taskbar progress,
 * OS notifications, and the quit guard. `tray.ts` and the Electron host only render what these return.
 */

import { formatRunLabel, type JobId, type RunId } from '../../shared/jobs/ids'
import {
  ACTIVE_STATES,
  TERMINAL_STATES,
  type BatchSummary,
  type JobCounts,
  type PauseMode,
  type PauseReason,
  type RunProgress,
  type RunState,
  type RunStatus
} from '../../shared/jobs/types'
import type { Platform } from '../../shared/text/platform'
import type { HostNotification, QuitChoice, TrayStatus } from './deps'

/** The app's name as every OS surface writes it. */
export const APP_NAME = 'molexMedia'

/** Windows keeps 127 characters of a tray tooltip. */
export const TOOLTIP_MAX = 127

/** The tray updates at most this often, and at once when the run status changes. */
export const TRAY_REFRESH_MS = 1000

const NUMBER = new Intl.NumberFormat('en-US')

function count(n: number): string
{
  return NUMBER.format(n)
}

function jobsWord(n: number): string
{
  return `${count(n)} ${n === 1 ? 'job' : 'jobs'}`
}

function finite(n: number, fallback = 0): number
{
  return Number.isFinite(n) ? n : fallback
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/** Bytes in decimal units as the page writes them: "312 MB", "21.4 GB". */
export function formatBytes(bytes: number): string
{
  const value = Math.max(0, finite(bytes))
  if (value < 1000)
  {
    return `${Math.round(value)} B`
  }
  let scaled = value / 1000
  let unit = 0
  while (scaled >= 999.5 && unit < BYTE_UNITS.length - 1)
  {
    scaled /= 1000
    unit += 1
  }
  const text = scaled < 99.95 ? scaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(scaled))
  return `${text} ${BYTE_UNITS[unit]}`
}

function hoursAndMinutes(minutes: number): string
{
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** A span of wall time as notifications write it: "38 s", "42 min", "1 h 5 min". */
export function formatElapsed(ms: number): string
{
  const seconds = Math.max(0, Math.round(finite(ms) / 1000))
  if (seconds < 60)
  {
    return `${seconds} s`
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : hoursAndMinutes(minutes)
}

/** A run's time left: "about 18 min left", "about 1 h 20 min left", or "less than a minute left". */
export function formatTimeLeft(etaSec: number): string
{
  const seconds = Math.max(0, finite(etaSec))
  if (seconds < 60)
  {
    return 'less than a minute left'
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `about ${minutes} min left` : `about ${hoursAndMinutes(minutes)} left`
}

/** The run header's time left: hidden unless the run is running, and "Estimating time left" until an estimate exists. */
export function runTimeLeftText(run: { status: RunStatus; progress: Pick<RunProgress, 'etaSec'> }): string | null
{
  if (run.status !== 'running')
  {
    return null
  }
  return run.progress.etaSec === null ? 'Estimating time left' : formatTimeLeft(run.progress.etaSec)
}

/** What the throughput figure means, for its tooltip. */
export const THROUGHPUT_HELP = 'Media seconds processed per second of wall time, across all workers.'

/** Throughput as the run header writes it: "3.4x realtime"; null while there is no figure. */
export function formatThroughput(mediaSecPerSec: number | null): string | null
{
  if (mediaSecPerSec === null || !Number.isFinite(mediaSecPerSec) || mediaSecPerSec <= 0)
  {
    return null
  }
  let text: string
  if (mediaSecPerSec < 0.1)
  {
    text = mediaSecPerSec.toFixed(2)
  }
  else if (mediaSecPerSec < 99.95)
  {
    text = mediaSecPerSec.toFixed(1)
  }
  else
  {
    text = String(Math.round(mediaSecPerSec))
  }
  return `${text}x realtime`
}

/** A run's jobs by where they stand; held jobs count as finished and pending jobs are not part of the run. */
export interface RunTally
{
  total: number
  finished: number
  active: number
  queued: number
}

/** Counts a run's jobs from its state counts. */
export function runTally(counts: JobCounts): RunTally
{
  const active = ACTIVE_STATES.reduce((sum, state) => sum + counts[state], 0)
  const finished = TERMINAL_STATES.reduce((sum, state) => sum + counts[state], 0) + counts.held
  const queued = counts.queued
  return { total: finished + active + queued, finished, active, queued }
}

/** What the tray, the taskbar, and the keep-awake decision read. */
export interface StatusInput
{
  run: Pick<RunState, 'status' | 'runId' | 'counts' | 'quitWhenIdle'> & { progress: Pick<RunProgress, 'percent' | 'etaSec'> }
  /** `attentionCount(jobs, run.runId)`: the run's jobs that need attention. */
  runAttention: number
  /** `attentionCount(jobs, null)`: every job that needs attention. */
  attention: number
}

function activeRunId(run: StatusInput['run']): RunId | null
{
  return run.status === 'idle' ? null : run.runId
}

function percentWord(percent: number): string
{
  return `${Math.min(100, Math.max(0, Math.floor(finite(percent))))}%`
}

function attentionWord(n: number, withNoun: boolean): string
{
  const subject = withNoun ? jobsWord(n) : count(n)
  return `${subject} ${n === 1 ? 'needs' : 'need'} attention`
}

function fitTooltip(text: string): string
{
  return text.length <= TOOLTIP_MAX ? text : `${text.slice(0, TOOLTIP_MAX - 1)}…`
}

type TooltipPart = 'percent' | 'finished' | 'attention' | 'eta'

const TOOLTIP_ORDER: readonly TooltipPart[] = ['percent', 'finished', 'attention', 'eta']
const TOOLTIP_DROP_ORDER: readonly TooltipPart[] = ['eta', 'finished', 'percent', 'attention']

function runningTooltip(head: string, parts: Partial<Record<TooltipPart, string>>): string
{
  const kept = new Set(TOOLTIP_ORDER.filter((part) => parts[part] !== undefined))
  const render = (): string => [head, ...TOOLTIP_ORDER.filter((part) => kept.has(part)).map((part) => parts[part])].join(', ')
  for (const part of TOOLTIP_DROP_ORDER)
  {
    if (render().length <= TOOLTIP_MAX)
    {
      break
    }
    kept.delete(part)
  }
  return fitTooltip(render())
}

/**
 * The tray tooltip: "molexMedia: Batch 31, 42%, 12 of 80 finished, 1 needs attention, about 14 min left" while a run
 * runs, shortened to 127 characters by dropping parts from the end with the attention count last; the run paused,
 * pausing, canceling, or quitting when its current jobs finish; "molexMedia: 2 jobs need attention" while any do and
 * no run is active; "molexMedia" otherwise.
 */
export function trayTooltip(input: StatusInput): string
{
  const { run } = input
  const runId = activeRunId(run)
  if (runId === null)
  {
    return input.attention > 0 ? fitTooltip(`${APP_NAME}: ${attentionWord(input.attention, true)}`) : APP_NAME
  }
  const head = `${APP_NAME}: ${formatRunLabel(runId)}`
  if (run.quitWhenIdle)
  {
    return fitTooltip(`${head}, quitting when current jobs finish`)
  }
  if (run.status !== 'running')
  {
    return fitTooltip(`${head} ${run.status}`)
  }
  const tally = runTally(run.counts)
  const timeLeft = runTimeLeftText(run)
  return runningTooltip(head, {
    percent: percentWord(run.progress.percent),
    finished: `${count(tally.finished)} of ${count(tally.total)} finished`,
    attention: input.runAttention > 0 ? attentionWord(input.runAttention, false) : undefined,
    eta: run.progress.etaSec === null || timeLeft === null ? undefined : timeLeft
  })
}

/** The tray's tooltip and its menu's run controls. */
export function trayStatus(input: StatusInput): TrayStatus
{
  const { run } = input
  const runId = activeRunId(run)
  const tally = runTally(run.counts)
  let runControl: TrayStatus['runControl'] = null
  if (runId !== null && run.status === 'running')
  {
    runControl = 'pause'
  }
  else if (runId !== null && (run.status === 'pausing' || run.status === 'paused'))
  {
    runControl = 'resume'
  }
  return {
    tooltip: trayTooltip(input),
    statusLine: runId === null ? null : `${formatRunLabel(runId)}: ${count(tally.finished)} of ${count(tally.total)} finished`,
    runControl,
    canCancel: runId !== null && run.status !== 'canceling'
  }
}

/** A tray menu command. */
export type TrayAction = 'pause' | 'resume' | 'cancel' | 'show' | 'batch' | 'editor' | 'player' | 'logs' | 'quit'

/** The tray menu's words. */
export const TRAY_LABELS: Readonly<Record<TrayAction, string>> = {
  pause: 'Pause batch',
  resume: 'Resume batch',
  cancel: 'Cancel batch…',
  show: `Show ${APP_NAME}`,
  batch: 'Batch',
  editor: 'Editor',
  player: 'Player',
  logs: 'Logs',
  quit: 'Quit'
}

/** One tray menu entry: the disabled status line, a command, or a separator. */
export type TrayMenuItem =
  | { type: 'status'; label: string }
  | { type: 'item'; action: TrayAction; label: string }
  | { type: 'separator' }

function menuItem(action: TrayAction): TrayMenuItem
{
  return { type: 'item', action, label: TRAY_LABELS[action] }
}

/** The tray menu: the run's status line and controls while a run is active, then Show, the views, and Quit. */
export function trayMenu(status: TrayStatus): TrayMenuItem[]
{
  const items: TrayMenuItem[] = []
  if (status.statusLine !== null)
  {
    items.push({ type: 'status', label: status.statusLine })
    if (status.runControl !== null)
    {
      items.push(menuItem(status.runControl))
    }
    if (status.canCancel)
    {
      items.push(menuItem('cancel'))
    }
    items.push({ type: 'separator' })
  }
  items.push(
    menuItem('show'),
    { type: 'separator' },
    menuItem('batch'),
    menuItem('editor'),
    menuItem('player'),
    menuItem('logs'),
    { type: 'separator' },
    menuItem('quit')
  )
  return items
}

function sameTray(a: TrayStatus, b: TrayStatus): boolean
{
  return a.tooltip === b.tooltip && a.statusLine === b.statusLine && a.runControl === b.runControl && a.canCancel === b.canCancel
}

/**
 * When the tray should show `next`: null when nothing changed, 0 now (the first render or a run status change), or
 * the milliseconds left before a once-per-second update is allowed.
 */
export function trayRefreshDelay(
  last: { status: RunStatus; tray: TrayStatus; at: number } | null,
  next: { status: RunStatus; tray: TrayStatus },
  now: number
): number | null
{
  if (last === null || last.status !== next.status)
  {
    return 0
  }
  if (sameTray(last.tray, next.tray))
  {
    return null
  }
  return Math.max(0, last.at + TRAY_REFRESH_MS - now)
}

/** The taskbar's progress state. */
export interface TaskbarProgress
{
  fraction: number
  mode: 'normal' | 'paused' | 'error'
}

/**
 * The taskbar: normal progress while running, paused while pausing or paused, a full error bar while no run is active
 * and jobs need attention, and nothing otherwise.
 */
export function taskbarProgress(input: StatusInput): TaskbarProgress | null
{
  const { run } = input
  const fraction = Math.min(1, Math.max(0, finite(run.progress.percent) / 100))
  if (activeRunId(run) === null)
  {
    return input.attention > 0 ? { fraction: 1, mode: 'error' } : null
  }
  if (run.status === 'running')
  {
    return { fraction, mode: 'normal' }
  }
  if (run.status === 'pausing' || run.status === 'paused')
  {
    return { fraction, mode: 'paused' }
  }
  return null
}

/** Whether to keep the system from suspending: while jobs run, when the keep-awake setting is on. */
export function keepAwake(status: RunStatus, setting: boolean): boolean
{
  return setting && (status === 'running' || status === 'pausing' || status === 'canceling')
}

type OutcomeCounts = Pick<BatchSummary['counts'], 'total' | 'verified' | 'returned' | 'canceled' | 'skipped'>

function outcomeSentence(counts: OutcomeCounts): string
{
  const parts: Array<[number, string]> = [
    [counts.verified, 'verified'],
    [counts.returned, 'returned'],
    [counts.canceled, 'canceled'],
    [counts.skipped, 'skipped']
  ]
  const present = parts.filter(([n]) => n > 0).map(([n, word]) => `${count(n)} ${word}`)
  return present.length > 0 ? `${present.join(', ')}.` : ''
}

/**
 * The notification when a run ends. Completed: "Batch 31 finished", "19 verified, 2 returned, 1 canceled. 21.4 GB
 * written in 42 min." or "All 22 jobs verified. ..."; canceled: "Batch 31 canceled", "10 verified, 12 canceled.".
 * Only the parts present appear.
 */
export function runEndedNotification(summary: Pick<BatchSummary, 'runId' | 'endedBy' | 'counts' | 'bytes' | 'elapsedMs'>): HostNotification
{
  const label = formatRunLabel(summary.runId)
  const focus = { jobId: null, runId: summary.runId }
  const { counts } = summary
  if (summary.endedBy === 'canceled')
  {
    return { title: `${label} canceled`, body: outcomeSentence(counts), focus }
  }
  let outcome = outcomeSentence(counts)
  if (counts.total > 0 && counts.verified === counts.total)
  {
    outcome = counts.total === 1 ? '1 job verified.' : `All ${count(counts.total)} jobs verified.`
  }
  const written = summary.bytes.output > 0 ? `${formatBytes(summary.bytes.output)} written in ${formatElapsed(summary.elapsedMs)}.` : ''
  return { title: `${label} finished`, body: [outcome, written].filter((part) => part !== '').join(' '), focus }
}

/** The notification for a run's first returned job: "MM-0142 returned", "<file name>: <sentence>". */
export function firstReturnedNotification(job: { id: JobId; runId: RunId | null; fileName: string }, sentence: string): HostNotification
{
  return { title: `${job.id} returned`, body: `${job.fileName}: ${sentence}`, focus: { jobId: job.id, runId: job.runId } }
}

/** The first returned job of a run notifies when the setting is on and the main window is hidden or unfocused. */
export function shouldNotifyFirstReturned(input: {
  enabled: boolean
  alreadyNotified: boolean
  window: { visible: boolean; focused: boolean } | null
}): boolean
{
  if (!input.enabled || input.alreadyNotified)
  {
    return false
  }
  return input.window === null || !input.window.visible || !input.window.focused
}

/**
 * The notification when the engine pauses a run itself: "D: is full. Free some space, then resume." or
 * "D:\Exports is not available. Reconnect it, then resume."; null for pauses the user or a restart made.
 */
export function autoPauseNotification(runId: RunId, reason: PauseReason, place: string | null): HostNotification | null
{
  let body: string
  switch (reason)
  {
    case 'disk-space':
      body = `${place ?? 'The output drive'} is full. Free some space, then resume.`
      break
    case 'destination-unavailable':
      body = `${place ?? 'The output folder'} is not available. Reconnect it, then resume.`
      break
    case 'storage':
      body = `${APP_NAME} cannot save its batch records. Check the drive, then resume.`
      break
    case 'ffmpeg-unavailable':
      body = 'FFmpeg is not available. Check FFmpeg in Settings, then resume.'
      break
    default:
      return null
  }
  return { title: `${formatRunLabel(runId)} paused`, body, focus: { jobId: null, runId } }
}

/** The one notification when the window closes to the tray during a run. */
export function closedToTrayNotification(runId: RunId): HostNotification
{
  return { title: `${APP_NAME} keeps running ${formatRunLabel(runId)} in the tray.`, body: '', focus: { jobId: null, runId } }
}

/** Closing to the tray notifies once per run. */
export function shouldNotifyClosedToTray(activeRunId: RunId | null, notifiedRunId: RunId | null): boolean
{
  return activeRunId !== null && activeRunId !== notifiedRunId
}

/** What the update notice says while a run keeps the update from installing. */
export function updateWaitingText(runId: RunId): string
{
  return `An update is ready. It installs when ${formatRunLabel(runId)} finishes.`
}

/** The engine is busy while jobs are active or claimed, or queued in a running or pausing run. */
export function engineBusy(input: { status: RunStatus; active: number; claimed: number; queued: number }): boolean
{
  if (input.active + input.claimed > 0)
  {
    return true
  }
  return input.queued > 0 && (input.status === 'running' || input.status === 'pausing')
}

/** The quit guard's dialog text. */
export interface QuitPrompt
{
  message: string
  detail: string
}

function isAre(n: number): string
{
  return n === 1 ? 'is' : 'are'
}

/**
 * The quit dialog: "Batch 31 is still running." and "3 jobs are in progress and 42 are queued. Quit now stops the jobs
 * in progress; you can retry them the next time you open molexMedia. Queued jobs stay queued."
 */
export function quitPrompt(input: { runId: RunId | null; active: number; queued: number }): QuitPrompt
{
  const message = input.runId === null ? `${APP_NAME} is still running jobs.` : `${formatRunLabel(input.runId)} is still running.`
  const { active, queued } = input
  const sentences: string[] = []
  if (active > 0)
  {
    const queuedPart = queued > 0 ? ` and ${count(queued)} ${isAre(queued)} queued` : ''
    sentences.push(`${jobsWord(active)} ${isAre(active)} in progress${queuedPart}.`)
    sentences.push(active === 1
      ? `Quit now stops the job in progress; you can retry it the next time you open ${APP_NAME}.`
      : `Quit now stops the jobs in progress; you can retry them the next time you open ${APP_NAME}.`)
  }
  else if (queued > 0)
  {
    sentences.push(`${jobsWord(queued)} ${isAre(queued)} queued.`)
  }
  if (queued > 0)
  {
    sentences.push(queued === 1 && active === 0 ? 'It stays queued.' : 'Queued jobs stay queued.')
  }
  return { message, detail: sentences.join(' ') }
}

/** The quit dialog's buttons, in order; the first is the default and the cancel choice. */
export const QUIT_BUTTONS: ReadonlyArray<{ choice: QuitChoice; label: string }> = [
  { choice: 'keep-running', label: 'Keep running' },
  { choice: 'quit-when-idle', label: 'Quit when current jobs finish' },
  { choice: 'quit-now', label: 'Quit now' }
]

/** What a quit dialog choice does to the run. */
export interface QuitChoiceEffect
{
  /** Pause the run this way first; null leaves it as it is. */
  pause: PauseMode | null
  quitWhenIdle: boolean
  /** Run the quit-now shutdown, then quit. */
  quitNow: boolean
}

/** Keep running changes nothing and clears `quitWhenIdle`; quit when idle pauses finish-running; quit now quits. */
export function quitChoiceEffect(choice: QuitChoice): QuitChoiceEffect
{
  switch (choice)
  {
    case 'quit-when-idle':
      return { pause: 'finish-running', quitWhenIdle: true, quitNow: false }
    case 'quit-now':
      return { pause: null, quitWhenIdle: false, quitNow: true }
    default:
      return { pause: null, quitWhenIdle: false, quitNow: false }
  }
}

/** What can change `quitWhenIdle`. */
export type QuitWhenIdleEvent = 'quit-when-idle' | 'keep-running' | 'resume' | 'start' | 'pause' | 'cancel'

/** Only the dialog sets `quitWhenIdle`; resume, start, and Keep running clear it, so an extended run never quits. */
export function nextQuitWhenIdle(current: boolean, event: QuitWhenIdleEvent): boolean
{
  switch (event)
  {
    case 'quit-when-idle':
      return true
    case 'keep-running':
    case 'resume':
    case 'start':
      return false
    default:
      return current
  }
}

/** The app quits by itself once `quitWhenIdle` is set and no job is active or claimed. */
export function idleQuitDue(input: { quitWhenIdle: boolean; active: number; claimed: number }): boolean
{
  return input.quitWhenIdle && input.active + input.claimed === 0
}

/** Where a quit request comes from: the main window's close handler or `before-quit`. */
export type QuitTrigger = 'window-close' | 'before-quit'

/** What the quit guard reads. */
export interface QuitState
{
  platform: Platform
  /** `engine.isBusy()`. */
  busy: boolean
  /** Quit now was chosen, or the idle quit fired. */
  confirmed: boolean
  /** The OS is shutting down, restarting, or logging out. */
  systemEnding: boolean
  /** The guard's dialog is open. */
  dialogOpen: boolean
  /** The app's quitting flag, which the tray's Quit sets before it calls `app.quit()`. */
  quitting: boolean
  minimizeToTray: boolean
  /** The async shutdown that runs before the real quit. */
  shutdown: 'none' | 'running' | 'done'
}

/**
 * What the close handler or `before-quit` does: let the window close (`markQuitting` when that close quits the app),
 * hide it to the tray, ask with the dialog parented to the main window, wait for the dialog or shutdown already in
 * progress, run the shutdown (quit now when busy) and quit again, or let `before-quit` proceed.
 */
export type QuitDecision =
  | { action: 'close'; markQuitting: boolean }
  | { action: 'hide' }
  | { action: 'ask'; resetQuitting: boolean; showWindow: boolean }
  | { action: 'wait' }
  | { action: 'shutdown' }
  | { action: 'proceed' }

/**
 * The quit guard. A window close that would quit the app (minimize to tray off, outside macOS) asks while the engine is
 * busy, in the close handler, while the window still exists; every other quit reaches `before-quit`, which asks the
 * same way, then runs the shutdown once before the real quit. With `systemEnding` set it never asks.
 */
export function quitDecision(state: QuitState, trigger: QuitTrigger): QuitDecision
{
  const mustAsk = state.busy && !state.confirmed && !state.systemEnding
  if (trigger === 'window-close')
  {
    if (state.quitting)
    {
      return { action: 'close', markQuitting: false }
    }
    if (state.minimizeToTray && !state.systemEnding)
    {
      return { action: 'hide' }
    }
    if (state.platform === 'darwin')
    {
      return { action: 'close', markQuitting: false }
    }
    if (mustAsk)
    {
      return state.dialogOpen ? { action: 'wait' } : { action: 'ask', resetQuitting: false, showWindow: false }
    }
    return { action: 'close', markQuitting: true }
  }
  if (state.shutdown === 'done')
  {
    return { action: 'proceed' }
  }
  if (state.shutdown === 'running')
  {
    return { action: 'wait' }
  }
  if (mustAsk)
  {
    return state.dialogOpen ? { action: 'wait' } : { action: 'ask', resetQuitting: true, showWindow: true }
  }
  return { action: 'shutdown' }
}

/** An OS end-of-session signal: the window's `session-end` on Windows, `powerMonitor` `shutdown` on macOS and Linux. */
export type SystemEndEvent = 'session-end' | 'shutdown'

/** What to do when the system ends the session. */
export interface SystemEndingPlan
{
  systemEnding: true
  /** `engine.persistNow('session-end')`: one synchronous journal append that never compacts. */
  persistNow: boolean
  /** `preventDefault()` on the shutdown event, so the app can exit cleanly first. */
  delayShutdown: boolean
  /** Close an open quit dialog through its signal. */
  closeDialog: boolean
  /** Run the quit-now shutdown, then `app.quit()`. */
  shutdown: boolean
}

/**
 * The system shutdown never waits on the dialog. On Windows `before-quit` is not emitted at a shutdown, so
 * `session-end` persists at once; on macOS and Linux `shutdown` delays the system, closes the dialog, and quits.
 * Null for an event the platform does not send.
 */
export function systemEndingPlan(event: SystemEndEvent, platform: Platform): SystemEndingPlan | null
{
  if (event === 'session-end')
  {
    return platform === 'win32'
      ? { systemEnding: true, persistNow: true, delayShutdown: false, closeDialog: true, shutdown: false }
      : null
  }
  return platform === 'win32'
    ? null
    : { systemEnding: true, persistNow: false, delayShutdown: true, closeDialog: true, shutdown: true }
}
