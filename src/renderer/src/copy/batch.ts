/**
 * Words the batch page's regions share: number and unit formats, catalog and batch names, platform words and keys,
 * status words, stamp words, warning words, the action labels, toasts, and announcements. A toast, a row, the
 * inspector, and an announcement that state one fact read it here, so they never word it two ways. Numerals on
 * screen use U+2212 for minus; data, logs, and reports keep the ASCII hyphen-minus. Sentences main builds (plan
 * issues, job errors) arrive final and are quoted verbatim.
 */
import { formatNumber, renderMessage, type MessageRef } from '../../../shared/audio/messages'
import { findLoudnessPreset, presetName } from '../../../shared/audio/presets'
import type { LoudnessUnit } from '../../../shared/audio/types'
import { containerLabel } from '../../../shared/jobs/describe'
import { formatRunLabel, type JobId, type RunId } from '../../../shared/jobs/ids'
import { needsAttention } from '../../../shared/jobs/states'
import type { JobView, JobWarningCode, ResultStamp } from '../../../shared/jobs/types'
import { binPhrase, formatKeys, platformWords, type Platform } from '../../../shared/text/platform'

/** The minus sign numerals on screen use. */
export const MINUS_SIGN = '\u2212'

/** The separator between the parts of a sentence that lists facts. */
export const PART_SEPARATOR = ' · '

/** Renders an audio message for the screen, with U+2212 in its numerals. */
export function screenMessage(ref: MessageRef): string
{
  return renderMessage(ref, { minus: 'unicode' })
}

/** A count with digit grouping: "1,204". */
export function formatCount(n: number): string
{
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?'
}

/** A count and its word, which follows the count: "1 job", "2 jobs", "1 new job". */
export function countOf(n: number, one: string, many: string = `${one}s`): string
{
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** The verb that follows a count: "1 needs", "2 need". */
export function verbFor(n: number, one: string, many: string): string
{
  return n === 1 ? one : many
}

/** "a", "a and b", "a, b, and c". */
export function joinList(items: readonly string[]): string
{
  if (items.length <= 2)
  {
    return items.join(' and ')
  }
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** A decimal size unit: 1 KB is 1,000 bytes, as the page and the file managers count. */
export type ByteUnit = typeof BYTE_UNITS[number]

function scaled(bytes: number, unit: number): number
{
  return bytes / 1000 ** unit
}

function roundedScaled(value: number, unit: number): string
{
  if (unit === 0 || value >= 100)
  {
    return String(Math.round(value))
  }
  return String(Number(value.toFixed(1)))
}

/** The unit a size prints in: the largest one that keeps the printed value under 1,000. */
export function byteUnit(bytes: number): ByteUnit
{
  let unit = 0
  while (unit < BYTE_UNITS.length - 1 && Number(roundedScaled(scaled(Math.abs(bytes), unit), unit)) >= 1000)
  {
    unit += 1
  }
  return BYTE_UNITS[unit]
}

/**
 * A size as the page prints it: one decimal below 100 and whole numbers above, trailing zeros dropped ("312 MB",
 * "35.6 GB", "25 MB"). Pass a unit to print several sizes on one scale ("25.4 MB of 25 MB, over by 0.4 MB").
 */
export function formatBytes(bytes: number, unit: ByteUnit = byteUnit(bytes)): string
{
  if (!Number.isFinite(bytes) || bytes < 0)
  {
    return '?'
  }
  const index = BYTE_UNITS.indexOf(unit)
  return `${roundedScaled(scaled(bytes, index), index)} ${unit}`
}

/** A whole percent for progress, never rounded up to 100 before the work ends: "46%". */
export function formatPercent(percent: number): string
{
  if (!Number.isFinite(percent))
  {
    return '?'
  }
  return `${Math.floor(Math.min(100, Math.max(0, percent)))}%`
}

/** A signed size change against a reference: "\u221217%", "+12%", "0%". */
export function formatSizeChange(bytes: number, reference: number): string
{
  if (!Number.isFinite(bytes) || !Number.isFinite(reference) || reference <= 0)
  {
    return '?'
  }
  const change = Math.round(((bytes - reference) / reference) * 100)
  if (change === 0)
  {
    return '0%'
  }
  return change > 0 ? `+${change}%` : `${MINUS_SIGN}${-change}%`
}

/** A span of time as sentences print it: "45 s", "42 min 10 s", "52 min", "10 h 2 min", "10 h". */
export function formatDuration(totalSec: number): string
{
  if (!Number.isFinite(totalSec) || totalSec < 0)
  {
    return '?'
  }
  const whole = Math.round(totalSec)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours > 0)
  {
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`
  }
  if (minutes > 0)
  {
    return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`
  }
  return `${seconds} s`
}

/** Elapsed milliseconds as a span: "42 min 10 s". */
export function formatElapsed(ms: number): string
{
  return formatDuration(ms / 1000)
}

/** A media duration as a clock, to the second: "0:08", "4:12", "38:20", "1:59:24". */
export function formatClock(totalSec: number): string
{
  if (!Number.isFinite(totalSec) || totalSec < 0)
  {
    return '?'
  }
  const whole = Math.round(totalSec)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = String(whole % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A local time of day on the 24-hour clock: "13:40". */
export function formatTimeOfDay(epochMs: number): string
{
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** A local date as History prints it: "Oct 14". */
export function formatDay(epochMs: number): string
{
  const date = new Date(epochMs)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** The time left as a span rounded to minutes ("18 min", "1 h 5 min"); null under a minute. */
export function etaSpan(etaSec: number): string | null
{
  if (!Number.isFinite(etaSec) || etaSec < 60)
  {
    return null
  }
  const minutes = Math.round(etaSec / 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0)
  {
    return `${minutes} min`
  }
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`
}

/** Shown while the run has less than 15 seconds of throughput to divide by. */
export const ESTIMATING_TIME_LEFT = 'Estimating time left'

/** The header's time left: "about 18 min left", or "less than a minute left" at the end. */
export function formatTimeLeft(etaSec: number): string
{
  const span = etaSpan(etaSec)
  return span === null ? 'less than a minute left' : `about ${span} left`
}

/** The time left as a sentence of its own: "About 18 min left.", "Less than a minute left." */
export function timeLeftSentence(etaSec: number): string
{
  const span = etaSpan(etaSec)
  return span === null ? 'Less than a minute left.' : `About ${span} left.`
}

/** A realtime multiple: "6.2x". */
export function formatSpeed(multiple: number): string
{
  return Number.isFinite(multiple) ? `${multiple.toFixed(1)}x` : '?'
}

/** Run throughput: "3.4x realtime". */
export function formatThroughput(multiple: number): string
{
  return `${formatSpeed(multiple)} realtime`
}

/** Integrated loudness: one decimal and the preset's unit, "\u221216.0 LKFS". */
export function formatLoudness(lufs: number, unit: LoudnessUnit): string
{
  return `${formatNumber(lufs, 'level', 'unicode')} ${unit}`
}

/** A target as its preset's source states it ("\u221216 LKFS" for Apple Podcasts), else with one decimal. */
export function formatTarget(lufs: number, unit: LoudnessUnit, presetId: string | null): string
{
  const preset = presetId === null ? null : findLoudnessPreset(presetId)
  const stated = preset !== null && preset.targetDecimals === 0 && preset.target.integratedLufs === lufs
  return `${formatNumber(lufs, stated ? 'stated' : 'level', 'unicode')} ${unit}`
}

/** True peak: one decimal, "\u22121.6 dBTP". */
export function formatTruePeak(dbtp: number): string
{
  return `${formatNumber(dbtp, 'level', 'unicode')} dBTP`
}

/** Sample peak: "\u22120.3 dBFS". */
export function formatSamplePeak(dbfs: number): string
{
  return `${formatNumber(dbfs, 'level', 'unicode')} dBFS`
}

/** Gain, always signed: "+5.5 dB", "\u22122.1 dB". */
export function formatGain(db: number): string
{
  return `${formatNumber(db, 'gain', 'unicode')} dB`
}

/** A deviation from a reference in the preset's own word, always signed: "+1.2 LU", "\u22120.7 dB". */
export function formatDeviation(value: number, unit: 'LU' | 'dB'): string
{
  return `${formatNumber(value, 'gain', 'unicode')} ${unit}`
}

/** A tolerance or check in the preset's own word: "\u00b11.0 dB". */
export function formatTolerance(value: number, unit: 'LU' | 'dB'): string
{
  return `\u00b1${formatNumber(value, 'amount', 'unicode')} ${unit}`
}

/** Loudness range: "15.8 LU". */
export function formatLoudnessRange(lu: number): string
{
  return `${formatNumber(lu, 'amount', 'unicode')} LU`
}

/** The one name users read for a run: "Batch 31". */
export function batchLabel(runId: RunId): string
{
  return formatRunLabel(runId)
}

/** "attempt 2". */
export function attemptLabel(attempt: number): string
{
  return `attempt ${attempt}`
}

/** The Recipe cell's note on a rerun job: "rerun of MM-0131". */
export function rerunLabel(jobId: JobId): string
{
  return `rerun of ${jobId}`
}

/** A shortcut written for the platform: keys('Mod+Enter', 'darwin') is "Cmd+Enter". */
export function keys(chord: string, platform: Platform): string
{
  return formatKeys(chord.split('+'), platform)
}

/** The command that shows a file in the file manager: "Show in folder", "Show in Finder". */
export function revealLabel(platform: Platform): string
{
  return platformWords(platform).revealLabel
}

/** The page's name in the sidebar, the tray, and the title while no batch is described. */
export const PAGE_NAME = 'Batch'

/** The modes of the one table. */
export const MODE_NAMES = { queue: 'Queue', review: 'Review', run: 'Run', history: 'History' } as const

/** The inspector's tabs. */
export const INSPECTOR_TAB_NAMES = { recipe: 'Settings', plan: 'Output', result: 'Result' } as const

/** The page's landmark and region names; the table is "Batches" in History and "Matching jobs" for a search. */
export const REGION_NAMES =
{
  header: 'Batch status and controls',
  toolbar: 'Queue tools',
  jobs: 'Jobs',
  batches: 'Batches',
  matches: 'Matching jobs',
  inspector: 'Inspector',
  notifications: 'Notifications'
} as const

/** The Run tab's tooltip before the first batch of the session starts. */
export const RUN_TAB_UNAVAILABLE = 'Starts when you press Start.'

/** The title: "Batch 31" while it describes that batch, else "Batch". */
export function pageTitle(runId: RunId | null): string
{
  return runId === null ? PAGE_NAME : batchLabel(runId)
}

/** "10 of 22 finished". */
export function finishedOf(done: number, total: number): string
{
  return `${formatCount(done)} of ${formatCount(total)} finished`
}

/** The attention count and button label: "1 needs attention", "2 need attention". */
export function needAttention(count: number): string
{
  return `${formatCount(count)} ${verbFor(count, 'needs', 'need')} attention`
}

/** The attention button's tooltip. */
export function needAttentionTooltip(runId: RunId, platform: Platform): string
{
  return `Show the jobs of ${batchLabel(runId)} that need attention (${keys('F8', platform)} steps through them)`
}

/** The kinds of the one next action, in precedence order. */
export type ActionKind = 'resume' | 'append' | 'review-new' | 'start' | 'review' | 'retry-returned' | 'add-files'

/** "Review 24 jobs", "Review 1 job". */
export function reviewLabel(count: number): string
{
  return `Review ${countOf(count, 'job')}`
}

/** "Review 3 new jobs". */
export function reviewNewLabel(count: number): string
{
  return `Review ${countOf(count, 'new job')}`
}

/** What Start affects beyond writing new files. */
export interface StartScope
{
  /** Start only the selected jobs. */
  subset: boolean
  originals: number
  overwrites: number
}

function replaceClause(scope: StartScope): string
{
  if (scope.originals > 0 && scope.overwrites > 0)
  {
    return `, replace ${countOf(scope.originals, 'original')} and ${countOf(scope.overwrites, 'file')}`
  }
  if (scope.originals > 0)
  {
    return `, replace ${countOf(scope.originals, 'original')}`
  }
  return scope.overwrites > 0 ? `, replace ${countOf(scope.overwrites, 'file')}` : ''
}

/** "Start 21 jobs", "Start 8 selected jobs", "Start 21 jobs, replace 20 originals and 3 files". */
export function startLabel(count: number, scope: StartScope = { subset: false, originals: 0, overwrites: 0 }): string
{
  return `Start ${countOf(count, scope.subset ? 'selected job' : 'job')}${replaceClause(scope)}`
}

/** Start while main has not answered; the button keeps its width. */
export const STARTING_LABEL = 'Starting\u2026'

/** The Start menu's item: "Start only the 8 selected jobs". */
export function startSelectedLabel(count: number): string
{
  return `Start only the ${countOf(count, 'selected job')}`
}

/** "Append 3 jobs to Batch 31". */
export function appendLabel(count: number, runId: RunId): string
{
  return `Append ${countOf(count, 'job')} to ${batchLabel(runId)}`
}

/** "Retry 2 returned". */
export function retryReturnedLabel(count: number): string
{
  return `Retry ${formatCount(count)} returned`
}

/** Fixed action labels. */
export const ACTION_LABELS =
{
  resume: 'Resume',
  addFiles: 'Add files',
  addFolder: 'Add folder',
  review: 'Review',
  pause: 'Pause',
  cancelRun: 'Cancel run',
  keepRunning: 'Keep running'
} as const

/** "Pause now: 3 running jobs restart from the beginning". */
export function pauseNowLabel(running: number): string
{
  return `Pause now: ${countOf(running, 'running job')} ${verbFor(running, 'restarts', 'restart')} from the beginning`
}

/** The tooltip of the one next action, with its shortcut for the platform. */
export function actionTooltip(kind: ActionKind, platform: Platform): string
{
  const enter = keys('Mod+Enter', platform)
  switch (kind)
  {
    case 'resume':
      return `Resume (${keys('Mod+P', platform)})`
    case 'append':
      return `Append (${enter})`
    case 'start':
      return `Start (${enter})`
    case 'retry-returned':
      return `Retry (${enter}). Each job keeps its catalog number.`
    case 'add-files':
      return `Add files (${keys('Mod+O', platform)})`
    default:
      return `Review (${enter})`
  }
}

/** The tooltips of the run controls. */
export function pauseTooltip(platform: Platform): string
{
  return `Pause (${keys('Mod+P', platform)}). Jobs already running finish first.`
}

/** Fixed tooltips of the header's controls. */
export const HEADER_TOOLTIPS =
{
  pauseNow: 'Stops running jobs now and deletes their partial files. They start over when you resume.',
  cancelRun: 'Stops the batch. Finished jobs keep their outputs.',
  reviewDisabled: 'Add files to review them.',
  output: 'Where outputs go and how they are named',
  workers: 'Workers and GPU encoding',
  throughput: 'Media processed per second of wall time, across all workers',
  timeLeft: 'Based on throughput over the last 30 seconds'
} as const

/** The tooltip of Start only the selected jobs. */
export function startSelectedTooltip(platform: Platform): string
{
  return keys('Mod+Shift+Enter', platform)
}

/** Why Start or Append waits: "Probing 92 of 212 files." */
export function probingReason(probed: number, total: number): string
{
  return `Probing ${formatCount(probed)} of ${countOf(total, 'file')}.`
}

/** Why Start or Append waits: "Checking 412 of 1,000 jobs." */
export function checkingReason(done: number, total: number): string
{
  return `Checking ${formatCount(done)} of ${countOf(total, 'job')}.`
}

/** Why Start cannot run: "Nothing can run: 2 jobs are blocked." */
export function nothingRunnableReason(blocked: number): string
{
  return blocked > 0 ? `Nothing can run: ${countOf(blocked, 'job')} ${verbFor(blocked, 'is', 'are')} blocked.` : 'Nothing can run.'
}

/** Why Start waits for the acknowledgment in the summary. */
export function acknowledgeFirstReason(platform: Platform): string
{
  return `Confirm the ${platformWords(platform).binName} step in the summary first.`
}

/** Why Resume waits for the acknowledgment in a restored batch's banner. */
export function acknowledgeRestoredReason(platform: Platform): string
{
  return `Confirm the ${platformWords(platform).binName} step in the banner first.`
}

/** A primary action refused by a field draft: "Fix Target, integrated first." */
export function fixFieldFirst(field: string): string
{
  return `Fix ${field} first.`
}

/** The StatusLabel keys of the batch page; each fixes an icon and an ink. */
export type StatusKey =
  | 'pending' | 'ready' | 'probing' | 'queued' | 'waiting' | 'analyzing' | 'encoding' | 'verifying' | 'finalizing'
  | 'wait-lock' | 'stopping' | 'paused' | 'decision' | 'done' | 'verified' | 'warning' | 'blocked' | 'failed'
  | 'returned' | 'will-skip' | 'canceled' | 'skipped' | 'locked' | 'missing'

/** A Status cell: the StatusLabel key, the word, the word under 160 px, whether it is held, and its tooltip. */
export interface StatusWords
{
  status: StatusKey
  label: string
  compact: string
  /** Exactly needsAttention(job): the held wash, the frame, and the hidden ", not acknowledged". */
  held: boolean
  /** "{word}. Not acknowledged." when held, the full word when the compact word differs, else null. */
  tooltip: string | null
}

/** Where a status word is shown and what this window knows beyond the job. */
export interface StatusContext
{
  platform: Platform
  /** Run mode shows a waiting job as "Not in this batch". */
  inRunMode?: boolean
  /** The plan has been pending for more than 600 ms. */
  checking?: boolean
  /** This window asked the job to stop and main has not reported the outcome yet. */
  stopping?: boolean
}

interface Word
{
  status: StatusKey
  label: string
  compact?: string
}

/** A done job's warning as the Status cell words it, in the order the cell picks the first. */
export const WARNING_WORDS: Readonly<Record<JobWarningCode, Word>> =
{
  'outside-tolerance-placed': { status: 'returned', label: 'Outside tolerance', compact: 'Off target' },
  'decoded-overshoot': { status: 'warning', label: 'Peak over after encoding', compact: 'Peak over' },
  'below-target-unpreviewed': { status: 'warning', label: 'Below target' },
  'larger-than-source': { status: 'warning', label: 'Larger than the source', compact: 'Larger' },
  'original-kept': { status: 'warning', label: 'Original kept' },
  'previous-kept': { status: 'warning', label: 'Previous file kept', compact: 'Previous kept' },
  'ran-on-cpu': { status: 'warning', label: 'Ran on the CPU', compact: 'Ran on CPU' },
  'source-changed': { status: 'warning', label: 'Source changed' }
}

/** Every warning code in the order the Status cell prefers them. */
export const WARNING_PRIORITY = Object.keys(WARNING_WORDS) as readonly JobWarningCode[]

/** The word of a warning, as the Status cell, the filters, and the announcements say it. */
export function warningWord(code: JobWarningCode): string
{
  return WARNING_WORDS[code].label
}

/** The warning a done job's Status cell shows: the first of its codes in priority order. */
export function leadingWarning(codes: readonly JobWarningCode[]): JobWarningCode | null
{
  return WARNING_PRIORITY.find((code) => codes.includes(code)) ?? null
}

function word(status: StatusKey, label: string, compact?: string): Word
{
  return compact === undefined ? { status, label } : { status, label, compact }
}

function pendingWord(job: JobView, context: StatusContext): Word
{
  if (context.inRunMode)
  {
    return word('pending', 'Not in this batch', 'Not in batch')
  }
  if (job.probe === 'pending')
  {
    return word('probing', 'Probing')
  }
  const plan = job.plan
  const issue = plan?.firstIssue?.code ?? null
  if (issue === 'source-missing')
  {
    return word('missing', 'Source missing', 'Missing')
  }
  if (issue === 'not-media')
  {
    return word('blocked', 'Not media')
  }
  if (job.probe === 'failed' || issue === 'probe-failed' || issue === 'source-unreadable')
  {
    return word('blocked', 'Unreadable')
  }
  if (plan === null || (!plan.current && context.checking === true))
  {
    return word('pending', 'Checking')
  }
  if (plan.status === 'blocked')
  {
    return word('blocked', 'Blocked')
  }
  if (job.reason === 'plan-changed' || job.reason === 'source-changed')
  {
    return word('warning', 'Output changed')
  }
  if (plan.status === 'will-skip')
  {
    return word('will-skip', 'Will skip')
  }
  if (plan.warnings > 0)
  {
    return word('warning', countOf(plan.warnings, 'warning'))
  }
  return job.attempt > 1 ? word('ready', `Ready, ${attemptLabel(job.attempt)}`, 'Ready') : word('ready', 'Ready')
}

function queuedWord(job: JobView): Word
{
  switch (job.waiting)
  {
    case 'album':
      return word('waiting', 'Waiting for album', 'Waiting')
    case 'gpu-session':
      return word('waiting', 'Waiting for GPU', 'Waiting')
    case 'disk-space':
      return word('waiting', 'Waiting for space', 'Waiting')
    case 'volume-offline':
      return word('waiting', `Waiting for ${job.waitingOn ?? 'its volume'}`, 'Waiting')
    default:
      return word('queued', 'Queued')
  }
}

function encodingWord(job: JobView): Word
{
  const stage = job.stage
  const audio = job.recipe.kind === 'normalize' || job.recipe.kind === 'boost'
  if (stage !== null && audio && stage.pass > 1)
  {
    return word('encoding', 'Re-encoding (correction)', 'Re-encoding')
  }
  if (stage !== null && !audio && stage.passes > 1)
  {
    return word('encoding', `Encoding, pass ${stage.pass} of ${stage.passes}`, `Encoding ${stage.pass}/${stage.passes}`)
  }
  return word('encoding', 'Encoding')
}

function activeWord(job: JobView, context: StatusContext): Word
{
  if (job.abort !== null || context.stopping === true)
  {
    return word('stopping', 'Stopping')
  }
  const stage = job.stage?.id ?? null
  switch (job.state)
  {
    case 'analyzing':
      if (stage === 'measure-dynamics')
      {
        return word('analyzing', 'Measuring after dynamics', 'Measuring')
      }
      if (stage === 'measure-album')
      {
        return word('analyzing', 'Measuring album', 'Album')
      }
      return stage === 'measure' ? word('analyzing', 'Measuring') : word('analyzing', 'Probing')
    case 'encoding':
      return encodingWord(job)
    case 'verifying':
      return word('verifying', 'Verifying')
    default:
      if (stage === 'trash')
      {
        const what = job.plan?.resolution === 'overwrite' ? 'old file' : 'original'
        return word('finalizing', `Moving ${what} to ${binPhrase(context.platform)}`, `To ${platformWords(context.platform).binName}`)
      }
      return stage === 'wait-lock' ? word('wait-lock', 'Waiting for file access', 'File in use') : word('finalizing', 'Saving')
  }
}

function heldWord(job: JobView): Word
{
  switch (job.hold?.reason)
  {
    case 'destination-appeared':
      return word('decision', 'File appeared, needs a decision', 'Decide')
    case 'file-locked':
      return word('decision', 'File in use, needs a decision', 'Decide')
    case 'interrupted-finalize':
      return word('decision', 'Interrupted while saving', 'Decide')
    default:
      return word('decision', 'Needs a decision', 'Decide')
  }
}

function doneWord(job: JobView): Word
{
  const warning = leadingWarning(job.warnings.map((item) => item.code))
  if (warning !== null)
  {
    return WARNING_WORDS[warning]
  }
  if (job.stamp === null)
  {
    return word('done', 'Done')
  }
  if (job.stamp.verdict === 'verified-below-target')
  {
    return word('verified', 'Verified, reachable level', 'Reachable level')
  }
  return word('verified', 'Verified')
}

function stateWord(job: JobView, context: StatusContext): Word
{
  switch (job.state)
  {
    case 'pending':
      return pendingWord(job, context)
    case 'queued':
      return queuedWord(job)
    case 'held':
      return heldWord(job)
    case 'done':
      return doneWord(job)
    case 'failed':
      return word('failed', 'Failed')
    case 'canceled':
      return word('canceled', 'Canceled')
    case 'skipped':
      return job.reason === 'output-exists' ? word('skipped', 'Skipped, file exists', 'Skipped') : word('skipped', 'Skipped')
    case 'interrupted':
      return word('failed', 'Interrupted')
    default:
      return activeWord(job, context)
  }
}

/** A job's Status cell, as the row, the inspector header, and History word it. */
export function statusWords(job: JobView, context: StatusContext): StatusWords
{
  const found = stateWord(job, context)
  const compact = found.compact ?? found.label
  const held = needsAttention(job)
  let tooltip: string | null = null
  if (held)
  {
    tooltip = `${found.label}. Not acknowledged.`
  }
  else if (compact !== found.label)
  {
    tooltip = found.label
  }
  return { status: found.status, label: found.label, compact, held, tooltip }
}

/** One value of a stamp; a failing value prints in error ink. */
export interface StampValue
{
  text: string
  failing: boolean
}

/** What a stamp prints and says: its word, its values, the sentence a screen reader hears, and its tooltip. */
export interface StampWords
{
  tone: 'verified' | 'returned'
  word: 'Verified' | 'Returned'
  values: StampValue[]
  /** "Verified, \u221216.0 LKFS, \u22121.6 dBTP". */
  spoken: string
  /** The reference the values were judged against; null when there is none to name. */
  tooltip: string | null
}

function value(text: string, failing = false): StampValue
{
  return { text, failing }
}

function sampled(text: string, stamp: ResultStamp): string
{
  return stamp.decode === 'sampled' ? `${text}${PART_SEPARATOR}sampled` : text
}

function sizeOfTarget(stamp: ResultStamp, size: NonNullable<ResultStamp['size']>): StampValue
{
  const unit = byteUnit(size.targetBytes)
  return value(`${formatBytes(stamp.outputBytes, unit)} of ${formatBytes(size.targetBytes, unit)}`, size.status === 'over')
}

function failedCheckValues(stamp: ResultStamp): StampValue[] | null
{
  const loudness = stamp.loudness
  if (loudness !== null && (loudness.status === 'above' || loudness.status === 'below'))
  {
    const deviation = loudness.deviation === null ? [] : [value(formatDeviation(loudness.deviation, loudness.deviationUnit), true)]
    return [value(formatLoudness(loudness.lufs, loudness.unit), true), ...deviation]
  }
  if (stamp.truePeak !== null && stamp.truePeak.status === 'over')
  {
    return [value(`${formatTruePeak(stamp.truePeak.preEncodeDbtp ?? stamp.truePeak.dbtp)} over`, true)]
  }
  return stamp.size !== null && stamp.size.status === 'over' ? [sizeOfTarget(stamp, stamp.size)] : null
}

function audioValues(stamp: ResultStamp, loudness: NonNullable<ResultStamp['loudness']>): StampValue[]
{
  const level = formatLoudness(loudness.lufs, loudness.unit)
  const values = [value(loudness.reference === 'reachable' ? `${level}, reachable` : level)]
  if (stamp.truePeak !== null)
  {
    values.push(value(formatTruePeak(stamp.truePeak.dbtp), stamp.truePeak.status === 'over'))
  }
  if (stamp.audioStreams > 1)
  {
    values.push(value(`+${countOf(stamp.audioStreams - 1, 'stream')}`))
  }
  return values
}

function mediaValues(job: JobView, stamp: ResultStamp): StampValue[]
{
  if (stamp.size !== null)
  {
    return [sizeOfTarget(stamp, stamp.size)]
  }
  if (stamp.frames !== null)
  {
    return [value(countOf(stamp.frames, 'frame'))]
  }
  if (stamp.cues !== null)
  {
    return [value(`${containerLabel(stamp.container)}${PART_SEPARATOR}${countOf(stamp.cues, 'cue')}`)]
  }
  if (job.recipe.kind === 'compress')
  {
    return [value(formatBytes(stamp.outputBytes)), value(sampled(formatSizeChange(stamp.outputBytes, stamp.inputBytes), stamp))]
  }
  const duration = stamp.durationSec === null ? '' : `${PART_SEPARATOR}${formatClock(stamp.durationSec)}`
  return [value(sampled(`${containerLabel(stamp.container)}${duration}`, stamp))]
}

function measuredValues(job: JobView, stamp: ResultStamp): StampValue[]
{
  return stamp.loudness !== null ? audioValues(stamp, stamp.loudness) : mediaValues(job, stamp)
}

function stampTooltip(job: JobView, stamp: ResultStamp): string | null
{
  const parts: string[] = []
  const loudness = stamp.loudness
  if (loudness !== null && job.recipe.kind === 'normalize' && loudness.referenceLufs !== null)
  {
    parts.push(`${presetName(job.recipe.presetId)}: ${formatTarget(loudness.referenceLufs, loudness.unit, job.recipe.presetId)}`)
  }
  if (loudness !== null && loudness.status !== 'not-checked')
  {
    parts.push(`this app's check ${formatTolerance(loudness.check, loudness.deviationUnit)} for ${loudness.checkClass} outputs`)
  }
  if (stamp.truePeak !== null)
  {
    parts.push(`limit ${formatTruePeak(stamp.truePeak.limitDbtp)}`)
  }
  if (stamp.size !== null)
  {
    parts.push(`target ${formatBytes(stamp.size.targetBytes)}`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}

function stampOf(tone: StampWords['tone'], values: StampValue[], tooltip: string | null): StampWords
{
  const stampWord = tone === 'verified' ? 'Verified' : 'Returned'
  return { tone, word: stampWord, values, spoken: [stampWord, ...values.map((item) => item.text)].join(', '), tooltip }
}

/**
 * A job's stamp as the row, History, and the inspector print it; null while it has nothing measured to show. A failed
 * job's stamp carries main's short reason verbatim, and every value comes from the Verify stage.
 */
export function stampWords(job: JobView): StampWords | null
{
  if (job.state === 'failed')
  {
    return stampOf('returned', [value(job.error?.short ?? 'Failed', true)], null)
  }
  if (job.state === 'interrupted')
  {
    return stampOf('returned', [value('Interrupted', true)], null)
  }
  const stamp = job.stamp
  if (stamp === null)
  {
    return null
  }
  if (stamp.verdict === 'passthrough')
  {
    return stampOf('verified', [value('Silent, copied')], null)
  }
  const tooltip = stampTooltip(job, stamp)
  if (stamp.verdict === 'outside-tolerance' || stamp.verdict === 'failed')
  {
    return stampOf('returned', failedCheckValues(stamp) ?? measuredValues(job, stamp), tooltip)
  }
  return stampOf('verified', measuredValues(job, stamp), tooltip)
}

/** What a toast action does; the caller binds each id to its handler. */
export type ToastActionId =
  | 'select-added' | 'show-skipped' | 'undo' | 'select-them' | 'add-as-second' | 'add-anyway' | 'show' | 'retry'
  | 'show-returned' | 'review' | 'show-in-folder' | 'select'

/** A toast action: its id and its label. */
export interface ToastAction
{
  id: ToastActionId
  label: string
}

/** A toast's words; the region adds the icon, the timers, and the handlers. */
export interface ToastWords
{
  title: string
  body: string | null
  actions: ToastAction[]
}

const TOAST_ACTION_LABELS: Readonly<Record<Exclude<ToastActionId, 'show-in-folder'>, string>> =
{
  'select-added': 'Select added',
  'show-skipped': 'Show skipped',
  'undo': 'Undo',
  'select-them': 'Select them',
  'add-as-second': 'Add as second jobs',
  'add-anyway': 'Add them anyway',
  'show': 'Show',
  'retry': 'Retry',
  'show-returned': 'Show returned',
  'review': 'Review',
  'select': 'Select'
}

function action(id: Exclude<ToastActionId, 'show-in-folder'>): ToastAction
{
  return { id, label: TOAST_ACTION_LABELS[id] }
}

function toast(title: string, body: string | null, actions: ToastAction[] = []): ToastWords
{
  return { title, body, actions }
}

/** What an add left out, by reason. */
export interface AddSkips
{
  notMedia: number
  duplicates: number
  outputs: number
}

/** "Added 12 files." with what it skipped. */
export function filesAddedToast(added: number, skips: AddSkips): ToastWords
{
  const parts: string[] = []
  if (skips.notMedia > 0)
  {
    parts.push(`${formatCount(skips.notMedia)} that ${verbFor(skips.notMedia, 'is', 'are')} not media`)
  }
  if (skips.duplicates > 0)
  {
    parts.push(`${formatCount(skips.duplicates)} already in the queue`)
  }
  if (skips.outputs > 0)
  {
    parts.push(`${countOf(skips.outputs, 'output')} of earlier batches`)
  }
  const body = parts.length > 0 ? `Skipped ${joinList(parts)}.` : null
  const actions = [action('select-added'), ...(body === null ? [] : [action('show-skipped')]), action('undo')]
  return toast(`Added ${countOf(added, 'file')}.`, body, actions)
}

/** One group of the skipped list, with the actions that add those files after all. */
export function skippedGroupToast(kind: keyof AddSkips, count: number): ToastWords
{
  if (kind === 'duplicates')
  {
    return toast(`Already in the queue: ${formatCount(count)}`, null, [action('select-them'), action('add-as-second')])
  }
  if (kind === 'outputs')
  {
    return toast(`Outputs of earlier batches: ${formatCount(count)}`, null, [action('add-anyway')])
  }
  return toast(`Not media: ${formatCount(count)}`, null)
}

/** Fixed toast titles. */
export const TOAST_TITLES =
{
  pasteWithoutFiles: 'The clipboard has no files or file paths.',
  undoExpired: 'Cannot undo: removed jobs can be restored for 10 minutes.'
} as const

/** "Removed 3 jobs." */
export function jobsRemovedToast(count: number): ToastWords
{
  return toast(`Removed ${countOf(count, 'job')}.`, null, [action('undo')])
}

/** "Applied Apple Podcasts to 12 jobs.", and what the change blocked. */
export function recipeAppliedToast(preset: string, count: number, blocked: { count: number; reason: string } | null = null): ToastWords
{
  const body = blocked !== null && blocked.count > 0
    ? `${formatCount(blocked.count)} ${verbFor(blocked.count, 'is', 'are')} now blocked: ${blocked.reason}.`
    : null
  return toast(`Applied ${preset} to ${countOf(count, 'job')}.`, body, [action('undo')])
}

/** "Changed 4 jobs to Compress · Target size." */
export function operationChangedToast(count: number, operation: string, preset: string): ToastWords
{
  return toast(`Changed ${countOf(count, 'job')} to ${operation}${PART_SEPARATOR}${preset}.`, null, [action('undo')])
}

/** "Added 3 jobs with Apple Podcasts." */
export function secondJobsToast(count: number, preset: string): ToastWords
{
  return toast(`Added ${countOf(count, 'job')} with ${preset}.`, null, [action('undo')])
}

/** "Duplicated 2 jobs." */
export function duplicatedToast(count: number): ToastWords
{
  return toast(`Duplicated ${countOf(count, 'job')}.`, null, [action('undo')])
}

/** The jobs Clear and Delete leave in place: "2 jobs that need attention stay until acknowledged." */
export function attentionStays(count: number): string
{
  return `${countOf(count, 'job')} that ${verbFor(count, 'needs', 'need')} attention ${verbFor(count, 'stays', 'stay')} until acknowledged.`
}

/** "Cleared 19 jobs." with the jobs that stayed. */
export function clearedToast(count: number, kept: number): ToastWords
{
  return toast(`Cleared ${countOf(count, 'job')}.`, kept > 0 ? attentionStays(kept) : null, [action('undo')])
}

/** "Saved preset Late podcasts.", and the pin it moved. */
export function presetSavedToast(name: string, pin: { key: number; displaced: string } | null, platform: Platform): ToastWords
{
  const body = pin === null
    ? null
    : `Saved preset ${name} on ${keys(`Alt+${pin.key}`, platform)}. ${pin.displaced} is no longer pinned.`
  return toast(`Saved preset ${name}.`, body)
}

/** "Batch 31 started: 21 jobs." */
export function batchStartedTitle(runId: RunId, count: number): string
{
  return `${batchLabel(runId)} started: ${countOf(count, 'job')}.`
}

/** The Start toast, with the jobs the conflict rule skipped. */
export function batchStartedToast(runId: RunId, count: number, skipped: number): ToastWords
{
  const body = skipped > 0 ? `${formatCount(skipped)} skipped because ${verbFor(skipped, 'its output exists', 'their output exists')}.` : null
  return toast(batchStartedTitle(runId, count), body)
}

/** "Appended 3 jobs to Batch 31." */
export function appendedToast(count: number, runId: RunId): ToastWords
{
  return toast(`Appended ${countOf(count, 'job')} to ${batchLabel(runId)}.`, null)
}

/** "MM-0139 returned: Decode failed." The short reason is main's, verbatim. */
export function jobReturned(jobId: JobId, short: string): string
{
  return `${jobId} returned: ${short}.`
}

/** The toast for one returned job; it persists until dismissed. */
export function jobReturnedToast(jobId: JobId, short: string): ToastWords
{
  return toast(jobReturned(jobId, short), null, [action('show'), action('retry')])
}

/** "4 jobs returned in Batch 31." */
export function jobsReturned(count: number, runId: RunId): string
{
  return `${countOf(count, 'job')} returned in ${batchLabel(runId)}.`
}

/** The toast a burst of returns updates in place. */
export function jobsReturnedToast(count: number, runId: RunId): ToastWords
{
  return toast(jobsReturned(count, runId), null, [action('show-returned')])
}

/** "Canceled MM-0137." */
export function jobCanceledToast(jobId: JobId): ToastWords
{
  return toast(`Canceled ${jobId}.`, null, [action('retry')])
}

/** "Skipped MM-0144. Retry runs it later.", "Skipped 38 jobs. Retry runs them later." */
export function jobsSkippedToast(jobIds: readonly JobId[]): ToastWords
{
  const title = jobIds.length === 1
    ? `Skipped ${jobIds[0]}. Retry runs it later.`
    : `Skipped ${countOf(jobIds.length, 'job')}. Retry runs them later.`
  return toast(title, null, [action('retry')])
}

/** "Took MM-0144 out of Batch 31. It waits in the queue." */
export function takenOutToast(jobId: JobId, runId: RunId): ToastWords
{
  return toast(`Took ${jobId} out of ${batchLabel(runId)}. It waits in the queue.`, null, [action('review')])
}

/** Delete pressed on running jobs. */
export function deleteRunningToast(platform: Platform): ToastWords
{
  return toast(`Running jobs are not stopped by ${keys('Delete', platform)}.`, `Use Cancel job (${keys('Shift+Delete', platform)}).`)
}

/** Delete pressed on jobs that need attention. */
export function deleteAttentionToast(count: number): ToastWords
{
  return toast(attentionStays(count), null, [action('show')])
}

/** "3 jobs wait for review: their outputs changed." */
export function retryPlanChangedToast(count: number): ToastWords
{
  const title = `${countOf(count, 'job')} ${verbFor(count, 'waits', 'wait')} for review: ${verbFor(count, 'its output', 'their outputs')} changed.`
  return toast(title, null, [action('review')])
}

/** "Acknowledged 3 jobs." with the decisions still open. */
export function acknowledgedToast(count: number, decisions: number): ToastWords
{
  const body = decisions > 0 ? `${formatCount(decisions)} still ${verbFor(decisions, 'needs', 'need')} a decision.` : null
  return toast(`Acknowledged ${countOf(count, 'job')}.`, body)
}

/** "Batch 31 finished: 19 verified, 2 returned." */
export function batchFinishedToast(runId: RunId, verified: number, returned: number): ToastWords
{
  return toast(`${batchLabel(runId)} finished: ${formatCount(verified)} verified, ${formatCount(returned)} returned.`, null, [action('show')])
}

/** "Report saved: D:\Exports\molexMedia Batch 31 report.csv." */
export function reportSavedToast(path: string, platform: Platform): ToastWords
{
  return toast(`Report saved: ${path}.`, null, [{ id: 'show-in-folder', label: revealLabel(platform) }])
}

/** What a copy put on the clipboard. */
export type CopiedKind = 'command' | 'error' | 'rows' | 'path' | 'output'

/** "Copied command.", "Copied 3 rows." */
export function copiedToast(kind: CopiedKind, rows = 1): ToastWords
{
  return toast(kind === 'rows' ? `Copied ${countOf(rows, 'row')}.` : `Copied ${kind}.`, null)
}

/** "Probe failed for 3 files." */
export function probeFailedToast(count: number): ToastWords
{
  return toast(`Probe failed for ${countOf(count, 'file')}.`, null, [action('select')])
}

/** "Folder scan stopped: {reason}." with what it added first. */
export function scanStoppedToast(reason: string, added: number): ToastWords
{
  return toast(`Folder scan stopped: ${reason}.`, `Added ${countOf(added, 'file')} found before the error.`)
}

/** "Added 12 jobs to rerun Batch 29.", with the sources it could not add. */
export function rerunToast(count: number, runId: RunId, missing: number, outputs: number): ToastWords
{
  const parts: string[] = []
  if (missing > 0)
  {
    parts.push(`${countOf(missing, 'source')} ${verbFor(missing, 'is', 'are')} no longer at ${verbFor(missing, 'its path', 'their paths')}; ${verbFor(missing, 'it was', 'they were')} not added.`)
  }
  if (outputs > 0)
  {
    parts.push(`${countOf(outputs, 'path')} now ${verbFor(outputs, 'holds an output of the job it', 'hold outputs of the jobs they')} would rerun; ${verbFor(outputs, 'it was', 'they were')} not added.`)
  }
  const actions = [action('show'), ...(outputs > 0 ? [action('add-anyway')] : [])]
  return toast(`Added ${countOf(count, 'job')} to rerun ${batchLabel(runId)}.`, parts.length > 0 ? parts.join(' ') : null, actions)
}

/** "Cannot undo for 3 jobs that already started." */
export function undoStartedToast(count: number): ToastWords
{
  return toast(`Cannot undo for ${countOf(count, 'job')} that already started.`, null)
}

/** Announcements without values. */
export const ANNOUNCEMENTS =
{
  nothingToStart: 'Nothing to start.',
  runUnavailable: 'Run starts when you press Start.',
  historyReadOnly: 'History is read-only.',
  backToQueueOrder: 'Back to queue order.'
} as const

/** "Added 12 files. 12 jobs selected." */
export function addedAnnouncement(files: number, selected: number): string
{
  return `Added ${countOf(files, 'file')}. ${countOf(selected, 'job')} selected.`
}

/** "Probed 212 files: 209 ready, 3 blocked." */
export function probedAnnouncement(files: number, ready: number, blocked: number): string
{
  return `Probed ${countOf(files, 'file')}: ${formatCount(ready)} ready, ${formatCount(blocked)} blocked.`
}

/** "Review. 18 ready, 3 with warnings, 1 blocked. Originals not touched." */
export function reviewOpenedAnnouncement(counts: { ready: number; warnings: number; blocked: number; originalsAffected: number }): string
{
  const originals = counts.originalsAffected > 0 ? `Replaces ${countOf(counts.originalsAffected, 'original')}.` : 'Originals not touched.'
  return `Review. ${formatCount(counts.ready)} ready, ${formatCount(counts.warnings)} with warnings, ${formatCount(counts.blocked)} blocked. ${originals}`
}

/** The opt-in progress digest: "10 of 22 finished. About 18 min left." */
export function progressDigest(done: number, total: number, etaSec: number | null): string
{
  return etaSec === null ? `${finishedOf(done, total)}.` : `${finishedOf(done, total)}. ${timeLeftSentence(etaSec)}`
}

/** A new held warning: "MM-0141: Original kept." */
export function heldWarningAnnouncement(jobId: JobId, code: JobWarningCode): string
{
  return `${jobId}: ${warningWord(code)}.`
}

/** "Pausing Batch 31. 3 running jobs finish first." or, for Pause now, that they restart. */
export function pausingAnnouncement(runId: RunId, running: number, now: boolean): string
{
  const jobs = countOf(running, 'running job')
  return now
    ? `Pausing ${batchLabel(runId)} now. ${jobs} ${verbFor(running, 'restarts', 'restart')} when you resume.`
    : `Pausing ${batchLabel(runId)}. ${jobs} ${verbFor(running, 'finishes', 'finish')} first.`
}

/** "Batch 31 paused." */
export function pausedAnnouncement(runId: RunId): string
{
  return `${batchLabel(runId)} paused.`
}

/** "Batch 31 resumed." */
export function resumedAnnouncement(runId: RunId): string
{
  return `${batchLabel(runId)} resumed.`
}

/** "Batch 31 finished: 19 verified, 2 returned, 1 canceled." */
export function finishedAnnouncement(runId: RunId, verified: number, returned: number, canceled: number): string
{
  return `${batchLabel(runId)} finished: ${formatCount(verified)} verified, ${formatCount(returned)} returned, ${formatCount(canceled)} canceled.`
}

/** "8 selected." */
export function selectedAnnouncement(count: number): string
{
  return `${formatCount(count)} selected.`
}

/** "Sorted by Size, ascending.", or "Back to queue order." */
export function sortAnnouncement(column: string, direction: 'ascending' | 'descending' | null): string
{
  return direction === null ? ANNOUNCEMENTS.backToQueueOrder : `Sorted by ${column}, ${direction}.`
}

/** "3 selected jobs are hidden by the filter and were deselected." */
export function filterHidAnnouncement(count: number): string
{
  return `${countOf(count, 'selected job')} ${verbFor(count, 'is', 'are')} hidden by the filter and ${verbFor(count, 'was', 'were')} deselected.`
}

/** "MM-0144 moved to position 2 of 12." */
export function movedAnnouncement(jobId: JobId, position: number, total: number): string
{
  return `${jobId} moved to position ${formatCount(position)} of ${formatCount(total)}.`
}

/** "MM-0139 acknowledged." with the next job the inspector moves to. */
export function acknowledgedAnnouncement(jobId: JobId, next: JobId | null = null): string
{
  return next === null ? `${jobId} acknowledged.` : `${jobId} acknowledged. Next: ${next}.`
}

/** "Undid: Apply Apple Podcasts." */
export function undidAnnouncement(actionName: string): string
{
  return `Undid: ${actionName}.`
}
