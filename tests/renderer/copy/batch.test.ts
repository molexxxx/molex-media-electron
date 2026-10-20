/**
 * The batch page's shared words: number and unit formats with U+2212, catalog and batch names, platform words and
 * keys, every status word of the table with its compact word and held flag, every stamp form, and the toasts and
 * announcements that several regions word the same way.
 */
import { describe, it, expect } from 'vitest'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { JobId, RunId } from '../../../src/shared/jobs/ids'
import { needsAttention } from '../../../src/shared/jobs/states'
import { JOB_WARNING_CODES, type JobStage, type JobView, type JobWarningCode, type PlanSummary, type ResultStamp, type StageId } from '../../../src/shared/jobs/types'
import
{
  ACTION_LABELS,
  ANNOUNCEMENTS,
  ESTIMATING_TIME_LEFT,
  HEADER_TOOLTIPS,
  INSPECTOR_TAB_NAMES,
  MINUS_SIGN,
  MODE_NAMES,
  PAGE_NAME,
  REGION_NAMES,
  RUN_TAB_UNAVAILABLE,
  STARTING_LABEL,
  TOAST_TITLES,
  WARNING_PRIORITY,
  WARNING_WORDS,
  acknowledgeFirstReason,
  acknowledgeRestoredReason,
  acknowledgedAnnouncement,
  acknowledgedToast,
  actionTooltip,
  addedAnnouncement,
  appendLabel,
  appendedToast,
  attemptLabel,
  attentionStays,
  batchFinishedToast,
  batchLabel,
  batchStartedTitle,
  batchStartedToast,
  byteUnit,
  checkingReason,
  clearedToast,
  copiedToast,
  countOf,
  deleteAttentionToast,
  deleteRunningToast,
  duplicatedToast,
  etaSpan,
  filesAddedToast,
  filterHidAnnouncement,
  finishedAnnouncement,
  finishedOf,
  fixFieldFirst,
  formatBytes,
  formatClock,
  formatCount,
  formatDay,
  formatDeviation,
  formatDuration,
  formatElapsed,
  formatGain,
  formatLoudness,
  formatLoudnessRange,
  formatPercent,
  formatSamplePeak,
  formatSizeChange,
  formatSpeed,
  formatTarget,
  formatThroughput,
  formatTimeLeft,
  formatTimeOfDay,
  formatTolerance,
  formatTruePeak,
  heldWarningAnnouncement,
  jobCanceledToast,
  jobReturned,
  jobReturnedToast,
  jobsRemovedToast,
  jobsReturned,
  jobsReturnedToast,
  jobsSkippedToast,
  joinList,
  keys,
  leadingWarning,
  movedAnnouncement,
  needAttention,
  needAttentionTooltip,
  nothingRunnableReason,
  operationChangedToast,
  pageTitle,
  pauseNowLabel,
  pauseTooltip,
  pausedAnnouncement,
  pausingAnnouncement,
  presetSavedToast,
  probeFailedToast,
  probedAnnouncement,
  probingReason,
  progressDigest,
  recipeAppliedToast,
  reportSavedToast,
  rerunLabel,
  rerunToast,
  resumedAnnouncement,
  retryPlanChangedToast,
  retryReturnedLabel,
  revealLabel,
  reviewLabel,
  reviewNewLabel,
  reviewOpenedAnnouncement,
  scanStoppedToast,
  screenMessage,
  secondJobsToast,
  selectedAnnouncement,
  skippedGroupToast,
  sortAnnouncement,
  stampWords,
  startLabel,
  startSelectedLabel,
  startSelectedTooltip,
  statusWords,
  takenOutToast,
  timeLeftSentence,
  undidAnnouncement,
  undoStartedToast,
  verbFor,
  warningWord,
  type StatusContext
} from '../../../src/renderer/src/copy/batch'

const AT = 1_760_000_000_000
const R31 = 'R-0031' as RunId
const MM139 = 'MM-0139' as JobId
const MM142 = 'MM-0142' as JobId
const WIN: StatusContext = { platform: 'win32' }
const MAC: StatusContext = { platform: 'darwin' }

const CONVERT =
{
  kind: 'convert',
  presetId: 'mp4-h264',
  userPreset: null,
  container: 'mp4',
  video: { encoder: 'libx264', bitrateKbps: 5000, fit: null, fps: null, pixelFormat: 'yuv420p' },
  audio: { kind: 'copy' },
  channels: 'keep',
  subtitles: 'keep'
} as unknown as JobView['recipe']

const COMPRESS = { ...CONVERT, kind: 'compress' } as unknown as JobView['recipe']
const EXTRACT = { ...CONVERT, kind: 'extract' } as unknown as JobView['recipe']
const APPLE = applyLoudnessPreset('apple-podcasts', { kind: 'same-as-source' })
const R128 = applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' })
const LOUDER = applyGainPreset('louder', { kind: 'same-as-source' })

function plan(over: Partial<PlanSummary> = {}): PlanSummary
{
  return {
    status: 'ready',
    current: true,
    finalName: 'a.mp4',
    relativePath: 'a.mp4',
    container: 'mp4',
    resolution: 'place',
    encoderLabel: 'x264',
    errors: 0,
    warnings: 0,
    firstIssue: null,
    ...over
  }
}

function view(over: Partial<JobView> = {}): JobView
{
  return {
    id: MM142,
    seq: 142,
    rev: 1,
    inputsRev: 1,
    source: { path: 'D:\\Rips\\a.mkv', name: 'a.mkv', ext: 'mkv', dir: 'D:\\Rips', size: 1_400_000_000, mtimeMs: AT, origin: 'files', subdir: '' },
    recipe: CONVERT,
    recipeLabel: 'MP4, x264',
    state: 'pending',
    reason: 'user',
    attempt: 1,
    restarts: 0,
    abort: null,
    stage: null,
    progress: null,
    media: null,
    probe: 'ok',
    plan: plan(),
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
    addedAt: AT,
    startedAt: null,
    endedAt: null,
    albumGroupId: null,
    ...over
  }
}

function stage(id: StageId, pass = 1, passes = 1): JobStage
{
  return { id, pass, passes, label: id, startedAt: AT }
}

function stamp(over: Partial<ResultStamp> = {}): ResultStamp
{
  return {
    verdict: 'verified',
    outputName: 'a.mp4',
    container: 'mp4',
    inputBytes: 1_400_000_000,
    outputBytes: 412_000_000,
    durationSec: 2300,
    decode: 'full',
    audioStreams: 0,
    verdictStream: null,
    loudness: null,
    truePeak: null,
    size: null,
    frames: null,
    cues: null,
    placement: 'new',
    warnings: 0,
    ...over
  }
}

function loudness(over: Partial<NonNullable<ResultStamp['loudness']>> = {}): NonNullable<ResultStamp['loudness']>
{
  return {
    lufs: -16,
    unit: 'LKFS',
    reference: 'target',
    referenceLufs: -16,
    deviation: 0,
    deviationUnit: 'dB',
    check: 1,
    checkClass: 'lossy',
    status: 'within',
    ...over
  }
}

function warning(code: JobWarningCode): JobView['warnings'][number]
{
  return { code, short: WARNING_WORDS[code].label, message: 'message' }
}

describe('numbers and units', () =>
{
  it('counts with grouping and words that follow the count', () =>
  {
    expect(formatCount(1204)).toBe('1,204')
    expect(formatCount(Number.NaN)).toBe('?')
    expect(countOf(1, 'job')).toBe('1 job')
    expect(countOf(2, 'job')).toBe('2 jobs')
    expect(countOf(0, 'job')).toBe('0 jobs')
    expect(countOf(10_000, 'job')).toBe('10,000 jobs')
    expect(countOf(2, 'match', 'matches')).toBe('2 matches')
    expect(verbFor(1, 'needs', 'need')).toBe('needs')
    expect(verbFor(3, 'needs', 'need')).toBe('need')
    expect(joinList(['a'])).toBe('a')
    expect(joinList(['a', 'b'])).toBe('a and b')
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c')
  })

  it('prints sizes in decimal units, one decimal below 100 and whole above', () =>
  {
    expect(formatBytes(312_000_000)).toBe('312 MB')
    expect(formatBytes(35_600_000_000)).toBe('35.6 GB')
    expect(formatBytes(25_000_000)).toBe('25 MB')
    expect(formatBytes(24_100_000)).toBe('24.1 MB')
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(999_960)).toBe('1 MB')
    expect(formatBytes(400_000, 'MB')).toBe('0.4 MB')
    expect(formatBytes(5_000_000_000_000_000)).toBe('5000 TB')
    expect(formatBytes(-1)).toBe('?')
    expect(formatBytes(Number.NaN)).toBe('?')
    expect(byteUnit(25_400_000)).toBe('MB')
    expect(byteUnit(0)).toBe('B')
  })

  it('prints progress, size changes, durations, clocks, and times of day', () =>
  {
    expect(formatPercent(46.7)).toBe('46%')
    expect(formatPercent(99.9)).toBe('99%')
    expect(formatPercent(120)).toBe('100%')
    expect(formatPercent(-3)).toBe('0%')
    expect(formatPercent(Number.NaN)).toBe('?')
    expect(formatSizeChange(412_000_000, 1_400_000_000)).toBe(`${MINUS_SIGN}71%`)
    expect(formatSizeChange(1_600_000_000, 1_430_000_000)).toBe('+12%')
    expect(formatSizeChange(100, 100)).toBe('0%')
    expect(formatSizeChange(100, 0)).toBe('?')
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(2530)).toBe('42 min 10 s')
    expect(formatDuration(3120)).toBe('52 min')
    expect(formatDuration(36_120)).toBe('10 h 2 min')
    expect(formatDuration(36_000)).toBe('10 h')
    expect(formatDuration(-1)).toBe('?')
    expect(formatElapsed(2_530_000)).toBe('42 min 10 s')
    expect(formatClock(8)).toBe('0:08')
    expect(formatClock(252)).toBe('4:12')
    expect(formatClock(2300)).toBe('38:20')
    expect(formatClock(7164)).toBe('1:59:24')
    expect(formatClock(Number.NaN)).toBe('?')
    expect(formatTimeOfDay(new Date(2026, 9, 16, 13, 40).getTime())).toBe('13:40')
    expect(formatTimeOfDay(new Date(2026, 9, 16, 9, 5).getTime())).toBe('09:05')
    expect(formatDay(new Date(2026, 9, 14, 22, 10).getTime())).toBe('Oct 14')
  })

  it('words the time left and the throughput', () =>
  {
    expect(etaSpan(1080)).toBe('18 min')
    expect(etaSpan(3900)).toBe('1 h 5 min')
    expect(etaSpan(7200)).toBe('2 h')
    expect(etaSpan(30)).toBeNull()
    expect(etaSpan(Number.NaN)).toBeNull()
    expect(formatTimeLeft(1080)).toBe('about 18 min left')
    expect(formatTimeLeft(42)).toBe('less than a minute left')
    expect(timeLeftSentence(1080)).toBe('About 18 min left.')
    expect(timeLeftSentence(10)).toBe('Less than a minute left.')
    expect(ESTIMATING_TIME_LEFT).toBe('Estimating time left')
    expect(formatSpeed(6.2)).toBe('6.2x')
    expect(formatSpeed(Number.NaN)).toBe('?')
    expect(formatThroughput(3.4)).toBe('3.4x realtime')
  })

  it('prints loudness values with the preset words and U+2212', () =>
  {
    expect(formatLoudness(-16, 'LKFS')).toBe(`${MINUS_SIGN}16.0 LKFS`)
    expect(formatTarget(-16, 'LKFS', 'apple-podcasts')).toBe(`${MINUS_SIGN}16 LKFS`)
    expect(formatTarget(-23, 'LUFS', 'ebu-r128')).toBe(`${MINUS_SIGN}23.0 LUFS`)
    expect(formatTarget(-18, 'LKFS', 'apple-podcasts')).toBe(`${MINUS_SIGN}18.0 LKFS`)
    expect(formatTarget(-18, 'LUFS', null)).toBe(`${MINUS_SIGN}18.0 LUFS`)
    expect(formatTruePeak(-1.6)).toBe(`${MINUS_SIGN}1.6 dBTP`)
    expect(formatTruePeak(0.4)).toBe('+0.4 dBTP')
    expect(formatSamplePeak(-0.3)).toBe(`${MINUS_SIGN}0.3 dBFS`)
    expect(formatGain(5.5)).toBe('+5.5 dB')
    expect(formatGain(-2.1)).toBe(`${MINUS_SIGN}2.1 dB`)
    expect(formatDeviation(1.2, 'LU')).toBe('+1.2 LU')
    expect(formatDeviation(-0.7, 'dB')).toBe(`${MINUS_SIGN}0.7 dB`)
    expect(formatTolerance(1, 'dB')).toBe('\u00b11.0 dB')
    expect(formatLoudnessRange(15.8)).toBe('15.8 LU')
    for (const text of [formatLoudness(-16, 'LUFS'), formatTruePeak(-1), formatGain(-2), formatDeviation(-1, 'LU')])
    {
      expect(text).not.toContain('-')
    }
  })

  it('renders audio messages for the screen with U+2212', () =>
  {
    const text = screenMessage({ key: 'measured', params: { I: -20.9, LRA: 15.8, TP: -7.1, unit: 'LUFS' } })
    expect(text).toBe(`${MINUS_SIGN}20.9 LUFS integrated, 15.8 LU range, ${MINUS_SIGN}7.1 dBTP true peak.`)
  })
})

describe('names, platform words, and keys', () =>
{
  it('names batches, attempts, and reruns by their catalog numbers', () =>
  {
    expect(batchLabel(R31)).toBe('Batch 31')
    expect(pageTitle(R31)).toBe('Batch 31')
    expect(pageTitle(null)).toBe(PAGE_NAME)
    expect(attemptLabel(2)).toBe('attempt 2')
    expect(rerunLabel('MM-0131' as JobId)).toBe('rerun of MM-0131')
    expect(MODE_NAMES).toEqual({ queue: 'Queue', review: 'Review', run: 'Run', history: 'History' })
    expect(INSPECTOR_TAB_NAMES).toEqual({ recipe: 'Settings', plan: 'Output', result: 'Result' })
    expect(REGION_NAMES.header).toBe('Batch status and controls')
    expect(RUN_TAB_UNAVAILABLE).toBe('Starts when you press Start.')
  })

  it('writes keys and the reveal command for each platform', () =>
  {
    expect(keys('Mod+Enter', 'win32')).toBe('Ctrl+Enter')
    expect(keys('Mod+Enter', 'darwin')).toBe('Cmd+Enter')
    expect(keys('Mod+Enter', 'linux')).toBe('Ctrl+Enter')
    expect(keys('F8', 'darwin')).toBe('fn+F8')
    expect(keys('Shift+Delete', 'darwin')).toBe('Cmd+Delete')
    expect(revealLabel('win32')).toBe('Show in folder')
    expect(revealLabel('darwin')).toBe('Show in Finder')
  })
})

describe('header words shared with the summary slot, the tray, and announcements', () =>
{
  it('counts finished jobs and jobs that need attention', () =>
  {
    expect(finishedOf(10, 22)).toBe('10 of 22 finished')
    expect(needAttention(1)).toBe('1 needs attention')
    expect(needAttention(2)).toBe('2 need attention')
    expect(needAttentionTooltip(R31, 'win32')).toBe('Show the jobs of Batch 31 that need attention (F8 steps through them)')
    expect(needAttentionTooltip(R31, 'darwin')).toBe('Show the jobs of Batch 31 that need attention (fn+F8 steps through them)')
  })

  it('labels the next actions with their counts and consequences', () =>
  {
    expect(reviewLabel(24)).toBe('Review 24 jobs')
    expect(reviewLabel(1)).toBe('Review 1 job')
    expect(reviewNewLabel(3)).toBe('Review 3 new jobs')
    expect(reviewNewLabel(1)).toBe('Review 1 new job')
    expect(startLabel(21)).toBe('Start 21 jobs')
    expect(startLabel(1)).toBe('Start 1 job')
    expect(startLabel(8, { subset: true, originals: 0, overwrites: 0 })).toBe('Start 8 selected jobs')
    expect(startLabel(21, { subset: false, originals: 20, overwrites: 0 })).toBe('Start 21 jobs, replace 20 originals')
    expect(startLabel(21, { subset: false, originals: 0, overwrites: 3 })).toBe('Start 21 jobs, replace 3 files')
    expect(startLabel(21, { subset: false, originals: 20, overwrites: 3 })).toBe('Start 21 jobs, replace 20 originals and 3 files')
    expect(startSelectedLabel(8)).toBe('Start only the 8 selected jobs')
    expect(appendLabel(3, R31)).toBe('Append 3 jobs to Batch 31')
    expect(retryReturnedLabel(2)).toBe('Retry 2 returned')
    expect(pauseNowLabel(3)).toBe('Pause now: 3 running jobs restart from the beginning')
    expect(pauseNowLabel(1)).toBe('Pause now: 1 running job restarts from the beginning')
    expect(STARTING_LABEL).toBe('Starting\u2026')
    expect(ACTION_LABELS.resume).toBe('Resume')
  })

  it('names each action\'s shortcut for the platform', () =>
  {
    expect(actionTooltip('review', 'win32')).toBe('Review (Ctrl+Enter)')
    expect(actionTooltip('review-new', 'win32')).toBe('Review (Ctrl+Enter)')
    expect(actionTooltip('start', 'darwin')).toBe('Start (Cmd+Enter)')
    expect(actionTooltip('append', 'win32')).toBe('Append (Ctrl+Enter)')
    expect(actionTooltip('resume', 'win32')).toBe('Resume (Ctrl+P)')
    expect(actionTooltip('resume', 'darwin')).toBe('Resume (Cmd+P)')
    expect(actionTooltip('retry-returned', 'win32')).toBe('Retry (Ctrl+Enter). Each job keeps its catalog number.')
    expect(actionTooltip('add-files', 'win32')).toBe('Add files (Ctrl+O)')
    expect(pauseTooltip('win32')).toBe('Pause (Ctrl+P). Jobs already running finish first.')
    expect(startSelectedTooltip('win32')).toBe('Ctrl+Shift+Enter')
    expect(HEADER_TOOLTIPS.reviewDisabled).toBe('Add files to review them.')
  })

  it('gives the reasons a disabled Start or Resume states beside it', () =>
  {
    expect(probingReason(92, 212)).toBe('Probing 92 of 212 files.')
    expect(checkingReason(412, 1000)).toBe('Checking 412 of 1,000 jobs.')
    expect(nothingRunnableReason(2)).toBe('Nothing can run: 2 jobs are blocked.')
    expect(nothingRunnableReason(1)).toBe('Nothing can run: 1 job is blocked.')
    expect(nothingRunnableReason(0)).toBe('Nothing can run.')
    expect(acknowledgeFirstReason('win32')).toBe('Confirm the Recycle Bin step in the summary first.')
    expect(acknowledgeFirstReason('darwin')).toBe('Confirm the Trash step in the summary first.')
    expect(acknowledgeRestoredReason('linux')).toBe('Confirm the Trash step in the banner first.')
    expect(fixFieldFirst('Target, integrated')).toBe('Fix Target, integrated first.')
  })
})

describe('status words', () =>
{
  const cases: Array<[string, Partial<JobView>, StatusContext, [string, string, string]]> =
  [
    ['a waiting job in Run mode', {}, { platform: 'win32', inRunMode: true }, ['pending', 'Not in this batch', 'Not in batch']],
    ['a probe running', { probe: 'pending', plan: null }, WIN, ['probing', 'Probing', 'Probing']],
    ['a missing source', { plan: plan({ status: 'blocked', firstIssue: { code: 'source-missing', severity: 'error', message: 'm' } }) }, WIN, ['missing', 'Source missing', 'Missing']],
    ['not media', { plan: plan({ status: 'blocked', firstIssue: { code: 'not-media', severity: 'error', message: 'm' } }) }, WIN, ['blocked', 'Not media', 'Not media']],
    ['a failed probe', { probe: 'failed', plan: null }, WIN, ['blocked', 'Unreadable', 'Unreadable']],
    ['an unreadable source', { plan: plan({ status: 'blocked', firstIssue: { code: 'source-unreadable', severity: 'error', message: 'm' } }) }, WIN, ['blocked', 'Unreadable', 'Unreadable']],
    ['no plan yet', { plan: null }, WIN, ['pending', 'Checking', 'Checking']],
    ['a plan pending over 600 ms', { plan: plan({ current: false }) }, { platform: 'win32', checking: true }, ['pending', 'Checking', 'Checking']],
    ['a plan pending under 600 ms keeps its word', { plan: plan({ current: false }) }, WIN, ['ready', 'Ready', 'Ready']],
    ['a blocked plan', { plan: plan({ status: 'blocked' }) }, WIN, ['blocked', 'Blocked', 'Blocked']],
    ['a changed plan after a retry', { reason: 'plan-changed' }, WIN, ['warning', 'Output changed', 'Output changed']],
    ['a source changed at dispatch', { reason: 'source-changed' }, WIN, ['warning', 'Output changed', 'Output changed']],
    ['a job that will skip', { plan: plan({ status: 'will-skip' }) }, WIN, ['will-skip', 'Will skip', 'Will skip']],
    ['one warning', { plan: plan({ warnings: 1 }) }, WIN, ['warning', '1 warning', '1 warning']],
    ['several warnings', { plan: plan({ warnings: 3 }) }, WIN, ['warning', '3 warnings', '3 warnings']],
    ['a second attempt', { attempt: 2 }, WIN, ['ready', 'Ready, attempt 2', 'Ready']],
    ['ready', {}, WIN, ['ready', 'Ready', 'Ready']],
    ['queued', { state: 'queued' }, WIN, ['queued', 'Queued', 'Queued']],
    ['waiting for its album', { state: 'queued', waiting: 'album' }, WIN, ['waiting', 'Waiting for album', 'Waiting']],
    ['waiting for a GPU session', { state: 'queued', waiting: 'gpu-session' }, WIN, ['waiting', 'Waiting for GPU', 'Waiting']],
    ['waiting for disk space', { state: 'queued', waiting: 'disk-space', waitingOn: 'D:' }, WIN, ['waiting', 'Waiting for space', 'Waiting']],
    ['waiting for its volume', { state: 'queued', waiting: 'volume-offline', waitingOn: 'D:' }, WIN, ['waiting', 'Waiting for D:', 'Waiting']],
    ['waiting for an unnamed volume', { state: 'queued', waiting: 'volume-offline' }, WIN, ['waiting', 'Waiting for its volume', 'Waiting']],
    ['probing in a run', { state: 'analyzing', stage: stage('probe') }, WIN, ['analyzing', 'Probing', 'Probing']],
    ['measuring', { state: 'analyzing', stage: stage('measure') }, WIN, ['analyzing', 'Measuring', 'Measuring']],
    ['measuring after dynamics', { state: 'analyzing', stage: stage('measure-dynamics') }, WIN, ['analyzing', 'Measuring after dynamics', 'Measuring']],
    ['measuring the album', { state: 'analyzing', stage: stage('measure-album') }, WIN, ['analyzing', 'Measuring album', 'Album']],
    ['encoding', { state: 'encoding', stage: stage('encode') }, WIN, ['encoding', 'Encoding', 'Encoding']],
    ['encoding with no stage yet', { state: 'encoding' }, WIN, ['encoding', 'Encoding', 'Encoding']],
    ['two-pass video', { state: 'encoding', stage: stage('encode', 1, 2) }, WIN, ['encoding', 'Encoding, pass 1 of 2', 'Encoding 1/2']],
    ['the corrective audio encode', { state: 'encoding', recipe: R128, stage: stage('encode', 2, 2) }, WIN, ['encoding', 'Re-encoding (correction)', 'Re-encoding']],
    ['a gain encode', { state: 'encoding', recipe: LOUDER, stage: stage('encode') }, WIN, ['encoding', 'Encoding', 'Encoding']],
    ['verifying', { state: 'verifying', stage: stage('verify') }, WIN, ['verifying', 'Verifying', 'Verifying']],
    ['saving', { state: 'finalizing', stage: stage('place') }, WIN, ['finalizing', 'Saving', 'Saving']],
    ['moving an original to the bin', { state: 'finalizing', stage: stage('trash'), plan: plan({ resolution: 'replace-original' }) }, WIN, ['finalizing', 'Moving original to the Recycle Bin', 'To Recycle Bin']],
    ['moving an old file to the bin', { state: 'finalizing', stage: stage('trash'), plan: plan({ resolution: 'overwrite' }) }, WIN, ['finalizing', 'Moving old file to the Recycle Bin', 'To Recycle Bin']],
    ['moving an original to the Trash', { state: 'finalizing', stage: stage('trash'), plan: plan({ resolution: 'replace-original' }) }, MAC, ['finalizing', 'Moving original to the Trash', 'To Trash']],
    ['waiting for a lock', { state: 'finalizing', stage: stage('wait-lock') }, WIN, ['wait-lock', 'Waiting for file access', 'File in use']],
    ['a stop requested in main', { state: 'encoding', abort: 'cancel', stage: stage('encode') }, WIN, ['stopping', 'Stopping', 'Stopping']],
    ['a stop requested here', { state: 'encoding', stage: stage('encode') }, { platform: 'win32', stopping: true }, ['stopping', 'Stopping', 'Stopping']],
    ['outside tolerance with something to replace', { state: 'held', hold: { reason: 'outside-tolerance', message: 'm', outputPath: 'o', displaces: 'd', actions: [], since: AT } }, WIN, ['decision', 'Needs a decision', 'Decide']],
    ['a file appeared', { state: 'held', hold: { reason: 'destination-appeared', message: 'm', outputPath: 'o', displaces: null, actions: [], since: AT } }, WIN, ['decision', 'File appeared, needs a decision', 'Decide']],
    ['a file locked', { state: 'held', hold: { reason: 'file-locked', message: 'm', outputPath: 'o', displaces: null, actions: [], since: AT } }, WIN, ['decision', 'File in use, needs a decision', 'Decide']],
    ['interrupted while saving', { state: 'held', hold: { reason: 'interrupted-finalize', message: 'm', outputPath: 'o', displaces: null, actions: [], since: AT } }, WIN, ['decision', 'Interrupted while saving', 'Decide']],
    ['held while storage is unavailable', { state: 'held', hold: { reason: 'storage-unavailable', message: 'm', outputPath: 'o', displaces: null, actions: [], since: AT } }, WIN, ['decision', 'Needs a decision', 'Decide']],
    ['verified', { state: 'done', stamp: stamp() }, WIN, ['verified', 'Verified', 'Verified']],
    ['done without a verify stage', { state: 'done' }, WIN, ['done', 'Done', 'Done']],
    ['verified at the reachable level', { state: 'done', stamp: stamp({ verdict: 'verified-below-target' }) }, WIN, ['verified', 'Verified, reachable level', 'Reachable level']],
    ['failed', { state: 'failed' }, WIN, ['failed', 'Failed', 'Failed']],
    ['canceled', { state: 'canceled', reason: 'user' }, WIN, ['canceled', 'Canceled', 'Canceled']],
    ['skipped by the user', { state: 'skipped', reason: 'user' }, WIN, ['skipped', 'Skipped', 'Skipped']],
    ['skipped by the rule', { state: 'skipped', reason: 'output-exists' }, WIN, ['skipped', 'Skipped, file exists', 'Skipped']],
    ['interrupted', { state: 'interrupted', reason: 'crash' }, WIN, ['failed', 'Interrupted', 'Interrupted']]
  ]

  it.each(cases)('words %s', (_name, over, context, [status, label, compact]) =>
  {
    const job = view(over)
    const words = statusWords(job, context)
    expect(words.status).toBe(status)
    expect(words.label).toBe(label)
    expect(words.compact).toBe(compact)
    expect(words.held).toBe(needsAttention(job))
  })

  it('words every done warning, held until acknowledged and keeping its word after', () =>
  {
    const expected: Record<JobWarningCode, [string, string, string]> =
    {
      'outside-tolerance-placed': ['returned', 'Outside tolerance', 'Off target'],
      'decoded-overshoot': ['warning', 'Peak over after encoding', 'Peak over'],
      'below-target-unpreviewed': ['warning', 'Below target', 'Below target'],
      'larger-than-source': ['warning', 'Larger than the source', 'Larger'],
      'original-kept': ['warning', 'Original kept', 'Original kept'],
      'previous-kept': ['warning', 'Previous file kept', 'Previous kept'],
      'ran-on-cpu': ['warning', 'Ran on the CPU', 'Ran on CPU'],
      'source-changed': ['warning', 'Source changed', 'Source changed']
    }
    expect([...WARNING_PRIORITY].sort()).toEqual([...JOB_WARNING_CODES].sort())
    for (const code of JOB_WARNING_CODES)
    {
      const [status, label, compact] = expected[code]
      const held = statusWords(view({ state: 'done', stamp: stamp(), warnings: [warning(code)] }), WIN)
      expect([held.status, held.label, held.compact, held.held]).toEqual([status, label, compact, true])
      expect(held.tooltip).toBe(`${label}. Not acknowledged.`)
      const acknowledged = statusWords(view({ state: 'done', stamp: stamp(), warnings: [warning(code)], acknowledged: true }), WIN)
      expect([acknowledged.label, acknowledged.held]).toEqual([label, false])
      expect(warningWord(code)).toBe(label)
    }
  })

  it('shows the most severe warning first', () =>
  {
    expect(leadingWarning(['ran-on-cpu', 'outside-tolerance-placed'])).toBe('outside-tolerance-placed')
    expect(leadingWarning(['source-changed', 'original-kept'])).toBe('original-kept')
    expect(leadingWarning([])).toBeNull()
    const words = statusWords(view({ state: 'done', stamp: stamp(), warnings: [warning('ran-on-cpu'), warning('larger-than-source')] }), WIN)
    expect(words.label).toBe('Larger than the source')
  })

  it('puts the full word in the tooltip when held or compact, and nothing otherwise', () =>
  {
    expect(statusWords(view(), WIN).tooltip).toBeNull()
    expect(statusWords(view({ state: 'queued', waiting: 'album' }), WIN).tooltip).toBe('Waiting for album')
    expect(statusWords(view({ state: 'failed' }), WIN).tooltip).toBe('Failed. Not acknowledged.')
    expect(statusWords(view({ state: 'failed', acknowledged: true }), WIN).tooltip).toBeNull()
    expect(statusWords(view({ state: 'interrupted' }), WIN).held).toBe(true)
  })
})

describe('stamps', () =>
{
  it('stamps a verified Normalize job with decoded true peak and its reference in the tooltip', () =>
  {
    const job = view({
      state: 'done',
      recipe: APPLE,
      stamp: stamp({ audioStreams: 1, loudness: loudness(), truePeak: { dbtp: -1.6, preEncodeDbtp: -3.9, limitDbtp: -1, status: 'within' } })
    })
    const words = stampWords(job)
    expect(words?.word).toBe('Verified')
    expect(words?.tone).toBe('verified')
    expect(words?.values).toEqual([{ text: `${MINUS_SIGN}16.0 LKFS`, failing: false }, { text: `${MINUS_SIGN}1.6 dBTP`, failing: false }])
    expect(words?.spoken).toBe(`Verified, ${MINUS_SIGN}16.0 LKFS, ${MINUS_SIGN}1.6 dBTP`)
    expect(words?.tooltip).toBe(`Apple Podcasts: ${MINUS_SIGN}16 LKFS; this app's check \u00b11.0 dB for lossy outputs; limit ${MINUS_SIGN}1.0 dBTP`)
  })

  it('counts further streams and qualifies a reachable level', () =>
  {
    const several = stampWords(view({
      state: 'done',
      recipe: R128,
      stamp: stamp({ audioStreams: 3, loudness: loudness({ lufs: -23, unit: 'LUFS', referenceLufs: -23, deviationUnit: 'LU' }), truePeak: { dbtp: -2.4, preEncodeDbtp: null, limitDbtp: -1, status: 'within' } })
    }))
    expect(several?.values.map((item) => item.text)).toEqual([`${MINUS_SIGN}23.0 LUFS`, `${MINUS_SIGN}2.4 dBTP`, '+2 streams'])
    const reachable = stampWords(view({
      state: 'done',
      recipe: R128,
      stamp: stamp({ verdict: 'verified-below-target', audioStreams: 1, loudness: loudness({ lufs: -19.1, unit: 'LUFS', reference: 'reachable', referenceLufs: -19.1 }), truePeak: { dbtp: -1.5, preEncodeDbtp: -1.5, limitDbtp: -1, status: 'within' } })
    }))
    expect(reachable?.values.map((item) => item.text)).toEqual([`${MINUS_SIGN}19.1 LUFS, reachable`, `${MINUS_SIGN}1.5 dBTP`])
    const twoStreams = stampWords(view({ state: 'done', recipe: R128, stamp: stamp({ audioStreams: 2, loudness: loudness() }) }))
    expect(twoStreams?.values.map((item) => item.text)).toEqual([`${MINUS_SIGN}16.0 LKFS`, '+1 stream'])
  })

  it('stamps a Gain job with the limit only', () =>
  {
    const words = stampWords(view({
      state: 'done',
      recipe: LOUDER,
      stamp: stamp({ audioStreams: 1, loudness: loudness({ lufs: -9.2, unit: 'LUFS', referenceLufs: null, deviation: null, status: 'not-checked' }), truePeak: { dbtp: -1.3, preEncodeDbtp: -1.3, limitDbtp: -1, status: 'within' } })
    }))
    expect(words?.values.map((item) => item.text)).toEqual([`${MINUS_SIGN}9.2 LUFS`, `${MINUS_SIGN}1.3 dBTP`])
    expect(words?.tooltip).toBe(`limit ${MINUS_SIGN}1.0 dBTP`)
  })

  it('stamps media outputs by what Verify counted', () =>
  {
    const text = (over: Partial<JobView>): string[] | undefined => stampWords(view({ state: 'done', ...over }))?.values.map((item) => item.text)
    expect(text({ stamp: stamp() })).toEqual(['MP4 · 38:20'])
    expect(text({ stamp: stamp({ decode: 'sampled' }) })).toEqual(['MP4 · 38:20 · sampled'])
    expect(text({ stamp: stamp({ durationSec: null }) })).toEqual(['MP4'])
    expect(text({ recipe: COMPRESS, stamp: stamp() })).toEqual(['412 MB', `${MINUS_SIGN}71%`])
    expect(text({ recipe: COMPRESS, stamp: stamp({ decode: 'sampled' }) })).toEqual(['412 MB', `${MINUS_SIGN}71% · sampled`])
    expect(text({ recipe: COMPRESS, stamp: stamp({ outputBytes: 1_600_000_000, inputBytes: 1_430_000_000 }) })).toEqual(['1.6 GB', '+12%'])
    expect(text({ recipe: COMPRESS, stamp: stamp({ outputBytes: 24_100_000, size: { targetBytes: 25_000_000, status: 'within' } }) })).toEqual(['24.1 MB of 25 MB'])
    expect(text({ recipe: EXTRACT, stamp: stamp({ container: 'mp3', durationSec: 252 }) })).toEqual(['MP3 · 4:12'])
    expect(text({ recipe: EXTRACT, stamp: stamp({ container: 'gif', durationSec: 8 }) })).toEqual(['GIF · 0:08'])
    expect(text({ recipe: EXTRACT, stamp: stamp({ container: 'png', frames: 50 }) })).toEqual(['50 frames'])
    expect(text({ recipe: EXTRACT, stamp: stamp({ container: 'srt', cues: 412 }) })).toEqual(['SRT · 412 cues'])
    expect(stampWords(view({ state: 'done', recipe: COMPRESS, stamp: stamp({ size: { targetBytes: 25_000_000, status: 'within' } }) }))?.tooltip).toBe('target 25 MB')
    expect(stampWords(view({ state: 'done', stamp: stamp() }))?.tooltip).toBeNull()
  })

  it('stamps a silent stream copied unchanged', () =>
  {
    const words = stampWords(view({ state: 'done', recipe: R128, stamp: stamp({ verdict: 'passthrough' }) }))
    expect(words?.values).toEqual([{ text: 'Silent, copied', failing: false }])
    expect(words?.word).toBe('Verified')
  })

  it('returns failed and interrupted jobs with their short reason', () =>
  {
    const failed = stampWords(view({ state: 'failed', error: { code: 'ffmpeg-failed', short: 'Decode failed', message: 'm', stage: 'encode', at: AT } }))
    expect(failed).toEqual({ tone: 'returned', word: 'Returned', values: [{ text: 'Decode failed', failing: true }], spoken: 'Returned, Decode failed', tooltip: null })
    expect(stampWords(view({ state: 'failed' }))?.values[0].text).toBe('Failed')
    expect(stampWords(view({ state: 'interrupted' }))?.values[0].text).toBe('Interrupted')
  })

  it('returns outputs outside tolerance with the failing values', () =>
  {
    const offLoudness = stampWords(view({
      state: 'done',
      recipe: R128,
      stamp: stamp({ verdict: 'outside-tolerance', audioStreams: 1, loudness: loudness({ lufs: -21.8, unit: 'LUFS', referenceLufs: -23, deviation: 1.2, deviationUnit: 'LU', check: 0.2, checkClass: 'lossless', status: 'above' }) })
    }))
    expect(offLoudness?.word).toBe('Returned')
    expect(offLoudness?.values).toEqual([{ text: `${MINUS_SIGN}21.8 LUFS`, failing: true }, { text: '+1.2 LU', failing: true }])
    expect(offLoudness?.tooltip).toBe(`EBU R 128: ${MINUS_SIGN}23.0 LUFS; this app's check \u00b10.2 LU for lossless outputs`)
    const noDeviation = stampWords(view({ state: 'done', recipe: R128, stamp: stamp({ verdict: 'outside-tolerance', loudness: loudness({ deviation: null, status: 'below' }) }) }))
    expect(noDeviation?.values).toEqual([{ text: `${MINUS_SIGN}16.0 LKFS`, failing: true }])
    const offPeak = stampWords(view({
      state: 'done',
      recipe: R128,
      stamp: stamp({ verdict: 'outside-tolerance', audioStreams: 1, loudness: loudness(), truePeak: { dbtp: -0.2, preEncodeDbtp: -0.4, limitDbtp: -1, status: 'over' } })
    }))
    expect(offPeak?.values).toEqual([{ text: `${MINUS_SIGN}0.4 dBTP over`, failing: true }])
    const decodedOnly = stampWords(view({ state: 'done', recipe: R128, stamp: stamp({ verdict: 'outside-tolerance', truePeak: { dbtp: -0.2, preEncodeDbtp: null, limitDbtp: -1, status: 'over' } }) }))
    expect(decodedOnly?.values[0].text).toBe(`${MINUS_SIGN}0.2 dBTP over`)
    const sizeMissed = stampWords(view({ state: 'done', recipe: COMPRESS, stamp: stamp({ verdict: 'outside-tolerance', outputBytes: 25_400_000, size: { targetBytes: 25_000_000, status: 'over' } }) }))
    expect(sizeMissed?.values).toEqual([{ text: '25.4 MB of 25 MB', failing: true }])
    const unexplained = stampWords(view({ state: 'done', stamp: stamp({ verdict: 'failed' }) }))
    expect(unexplained?.word).toBe('Returned')
    expect(unexplained?.values[0].text).toBe('MP4 · 38:20')
  })

  it('keeps a verified stamp and marks a decoded peak that stayed over', () =>
  {
    const words = stampWords(view({
      state: 'done',
      recipe: R128,
      warnings: [warning('decoded-overshoot')],
      stamp: stamp({ audioStreams: 1, loudness: loudness(), truePeak: { dbtp: -0.6, preEncodeDbtp: -1.2, limitDbtp: -1, status: 'over' } })
    }))
    expect(words?.word).toBe('Verified')
    expect(words?.values[1]).toEqual({ text: `${MINUS_SIGN}0.6 dBTP`, failing: true })
  })

  it('has no stamp before anything was verified', () =>
  {
    expect(stampWords(view())).toBeNull()
    expect(stampWords(view({ state: 'done' }))).toBeNull()
  })
})

describe('toasts', () =>
{
  const ids = (actions: Array<{ id: string }>): string[] => actions.map((item) => item.id)

  it('words an add with what it skipped', () =>
  {
    const full = filesAddedToast(12, { notMedia: 2, duplicates: 3, outputs: 1 })
    expect(full.title).toBe('Added 12 files.')
    expect(full.body).toBe('Skipped 2 that are not media, 3 already in the queue, and 1 output of earlier batches.')
    expect(ids(full.actions)).toEqual(['select-added', 'show-skipped', 'undo'])
    const one = filesAddedToast(1, { notMedia: 1, duplicates: 0, outputs: 0 })
    expect(one.title).toBe('Added 1 file.')
    expect(one.body).toBe('Skipped 1 that is not media.')
    const clean = filesAddedToast(4, { notMedia: 0, duplicates: 0, outputs: 0 })
    expect(clean.body).toBeNull()
    expect(ids(clean.actions)).toEqual(['select-added', 'undo'])
    expect(skippedGroupToast('duplicates', 3)).toEqual({ title: 'Already in the queue: 3', body: null, actions: [{ id: 'select-them', label: 'Select them' }, { id: 'add-as-second', label: 'Add as second jobs' }] })
    expect(skippedGroupToast('outputs', 1).title).toBe('Outputs of earlier batches: 1')
    expect(ids(skippedGroupToast('outputs', 1).actions)).toEqual(['add-anyway'])
    expect(skippedGroupToast('notMedia', 2)).toEqual({ title: 'Not media: 2', body: null, actions: [] })
    expect(TOAST_TITLES.pasteWithoutFiles).toBe('The clipboard has no files or file paths.')
  })

  it('words queue edits with Undo', () =>
  {
    expect(jobsRemovedToast(3)).toEqual({ title: 'Removed 3 jobs.', body: null, actions: [{ id: 'undo', label: 'Undo' }] })
    expect(recipeAppliedToast('Apple Podcasts', 12).title).toBe('Applied Apple Podcasts to 12 jobs.')
    expect(recipeAppliedToast('Apple Podcasts', 12, { count: 0, reason: 'r' }).body).toBeNull()
    expect(recipeAppliedToast('Compress', 8, { count: 2, reason: 'they have no video stream' }).body).toBe('2 are now blocked: they have no video stream.')
    expect(recipeAppliedToast('Compress', 8, { count: 1, reason: 'it has no video stream' }).body).toBe('1 is now blocked: it has no video stream.')
    expect(operationChangedToast(4, 'Compress', 'Target size').title).toBe('Changed 4 jobs to Compress · Target size.')
    expect(secondJobsToast(3, 'Apple Podcasts').title).toBe('Added 3 jobs with Apple Podcasts.')
    expect(duplicatedToast(1).title).toBe('Duplicated 1 job.')
    expect(clearedToast(19, 2)).toEqual({ title: 'Cleared 19 jobs.', body: '2 jobs that need attention stay until acknowledged.', actions: [{ id: 'undo', label: 'Undo' }] })
    expect(clearedToast(19, 0).body).toBeNull()
    expect(attentionStays(1)).toBe('1 job that needs attention stays until acknowledged.')
    expect(undoStartedToast(3).title).toBe('Cannot undo for 3 jobs that already started.')
    expect(TOAST_TITLES.undoExpired).toBe('Cannot undo: removed jobs can be restored for 10 minutes.')
  })

  it('words a saved preset and the pin it moved with the platform\'s keys', () =>
  {
    expect(presetSavedToast('Late podcasts', null, 'win32')).toEqual({ title: 'Saved preset Late podcasts.', body: null, actions: [] })
    expect(presetSavedToast('Late podcasts', { key: 3, displaced: 'Weekly' }, 'win32').body).toBe('Saved preset Late podcasts on Alt+3. Weekly is no longer pinned.')
    expect(presetSavedToast('Late podcasts', { key: 3, displaced: 'Weekly' }, 'darwin').body).toBe('Saved preset Late podcasts on Option+3. Weekly is no longer pinned.')
  })

  it('words the run\'s moments', () =>
  {
    expect(batchStartedTitle(R31, 21)).toBe('Batch 31 started: 21 jobs.')
    expect(batchStartedToast(R31, 21, 2).body).toBe('2 skipped because their output exists.')
    expect(batchStartedToast(R31, 21, 1).body).toBe('1 skipped because its output exists.')
    expect(batchStartedToast(R31, 21, 0).body).toBeNull()
    expect(appendedToast(3, R31).title).toBe('Appended 3 jobs to Batch 31.')
    expect(jobReturned(MM139, 'Decode failed')).toBe('MM-0139 returned: Decode failed.')
    expect(ids(jobReturnedToast(MM139, 'Decode failed').actions)).toEqual(['show', 'retry'])
    expect(jobsReturned(4, R31)).toBe('4 jobs returned in Batch 31.')
    expect(jobsReturnedToast(4, R31).actions).toEqual([{ id: 'show-returned', label: 'Show returned' }])
    expect(jobCanceledToast('MM-0137' as JobId).title).toBe('Canceled MM-0137.')
    expect(jobsSkippedToast(['MM-0144' as JobId]).title).toBe('Skipped MM-0144. Retry runs it later.')
    expect(jobsSkippedToast(['MM-0144' as JobId, MM142]).title).toBe('Skipped 2 jobs. Retry runs them later.')
    expect(takenOutToast('MM-0144' as JobId, R31).title).toBe('Took MM-0144 out of Batch 31. It waits in the queue.')
    expect(retryPlanChangedToast(3).title).toBe('3 jobs wait for review: their outputs changed.')
    expect(retryPlanChangedToast(1).title).toBe('1 job waits for review: its output changed.')
    expect(acknowledgedToast(3, 1)).toEqual({ title: 'Acknowledged 3 jobs.', body: '1 still needs a decision.', actions: [] })
    expect(acknowledgedToast(3, 2).body).toBe('2 still need a decision.')
    expect(acknowledgedToast(3, 0).body).toBeNull()
    expect(batchFinishedToast(R31, 19, 2).title).toBe('Batch 31 finished: 19 verified, 2 returned.')
  })

  it('names Delete, Cancel job, and the reveal command for the platform', () =>
  {
    expect(deleteRunningToast('win32')).toEqual({ title: 'Running jobs are not stopped by Delete.', body: 'Use Cancel job (Shift+Delete).', actions: [] })
    expect(deleteRunningToast('darwin').body).toBe('Use Cancel job (Cmd+Delete).')
    expect(deleteAttentionToast(2).title).toBe('2 jobs that need attention stay until acknowledged.')
    expect(reportSavedToast('D:\\Exports\\molexMedia Batch 31 report.csv', 'win32')).toEqual({
      title: 'Report saved: D:\\Exports\\molexMedia Batch 31 report.csv.',
      body: null,
      actions: [{ id: 'show-in-folder', label: 'Show in folder' }]
    })
    expect(reportSavedToast('/Volumes/Media/r.csv', 'darwin').actions[0].label).toBe('Show in Finder')
  })

  it('words copies, probes, scans, and reruns', () =>
  {
    expect(copiedToast('command').title).toBe('Copied command.')
    expect(copiedToast('error').title).toBe('Copied error.')
    expect(copiedToast('path').title).toBe('Copied path.')
    expect(copiedToast('output').title).toBe('Copied output.')
    expect(copiedToast('rows', 3).title).toBe('Copied 3 rows.')
    expect(copiedToast('rows').title).toBe('Copied 1 row.')
    expect(probeFailedToast(3)).toEqual({ title: 'Probe failed for 3 files.', body: null, actions: [{ id: 'select', label: 'Select' }] })
    expect(scanStoppedToast('D:\\Rips is no longer available', 120)).toEqual({ title: 'Folder scan stopped: D:\\Rips is no longer available.', body: 'Added 120 files found before the error.', actions: [] })
    const rerun = rerunToast(12, 'R-0029' as RunId, 2, 1)
    expect(rerun.title).toBe('Added 12 jobs to rerun Batch 29.')
    expect(rerun.body).toBe('2 sources are no longer at their paths; they were not added. 1 path now holds an output of the job it would rerun; it was not added.')
    expect(ids(rerun.actions)).toEqual(['show', 'add-anyway'])
    const missingOne = rerunToast(12, 'R-0029' as RunId, 1, 0)
    expect(missingOne.body).toBe('1 source is no longer at its path; it was not added.')
    expect(ids(missingOne.actions)).toEqual(['show'])
    expect(rerunToast(12, 'R-0029' as RunId, 0, 3).body).toBe('3 paths now hold outputs of the jobs they would rerun; they were not added.')
    expect(rerunToast(12, 'R-0029' as RunId, 0, 0).body).toBeNull()
  })
})

describe('announcements', () =>
{
  it('announces adds, probes, Review, and progress', () =>
  {
    expect(addedAnnouncement(12, 12)).toBe('Added 12 files. 12 jobs selected.')
    expect(probedAnnouncement(212, 209, 3)).toBe('Probed 212 files: 209 ready, 3 blocked.')
    expect(reviewOpenedAnnouncement({ ready: 18, warnings: 3, blocked: 1, originalsAffected: 0 })).toBe('Review. 18 ready, 3 with warnings, 1 blocked. Originals not touched.')
    expect(reviewOpenedAnnouncement({ ready: 20, warnings: 0, blocked: 0, originalsAffected: 20 })).toBe('Review. 20 ready, 0 with warnings, 0 blocked. Replaces 20 originals.')
    expect(progressDigest(10, 22, 1080)).toBe('10 of 22 finished. About 18 min left.')
    expect(progressDigest(10, 22, null)).toBe('10 of 22 finished.')
  })

  it('announces the run\'s moments with the batch number', () =>
  {
    expect(heldWarningAnnouncement('MM-0141' as JobId, 'original-kept')).toBe('MM-0141: Original kept.')
    expect(pausingAnnouncement(R31, 3, false)).toBe('Pausing Batch 31. 3 running jobs finish first.')
    expect(pausingAnnouncement(R31, 1, false)).toBe('Pausing Batch 31. 1 running job finishes first.')
    expect(pausingAnnouncement(R31, 3, true)).toBe('Pausing Batch 31 now. 3 running jobs restart when you resume.')
    expect(pausingAnnouncement(R31, 1, true)).toBe('Pausing Batch 31 now. 1 running job restarts when you resume.')
    expect(pausedAnnouncement(R31)).toBe('Batch 31 paused.')
    expect(resumedAnnouncement(R31)).toBe('Batch 31 resumed.')
    expect(finishedAnnouncement(R31, 19, 2, 1)).toBe('Batch 31 finished: 19 verified, 2 returned, 1 canceled.')
  })

  it('announces selection, sorting, filters, moves, and acknowledgments', () =>
  {
    expect(selectedAnnouncement(8)).toBe('8 selected.')
    expect(sortAnnouncement('Size', 'ascending')).toBe('Sorted by Size, ascending.')
    expect(sortAnnouncement('Size', 'descending')).toBe('Sorted by Size, descending.')
    expect(sortAnnouncement('Size', null)).toBe('Back to queue order.')
    expect(filterHidAnnouncement(3)).toBe('3 selected jobs are hidden by the filter and were deselected.')
    expect(filterHidAnnouncement(1)).toBe('1 selected job is hidden by the filter and was deselected.')
    expect(movedAnnouncement('MM-0144' as JobId, 2, 12)).toBe('MM-0144 moved to position 2 of 12.')
    expect(acknowledgedAnnouncement(MM139)).toBe('MM-0139 acknowledged.')
    expect(acknowledgedAnnouncement(MM139, 'MM-0152' as JobId)).toBe('MM-0139 acknowledged. Next: MM-0152.')
    expect(undidAnnouncement('Apply Apple Podcasts')).toBe('Undid: Apply Apple Podcasts.')
    expect(ANNOUNCEMENTS).toEqual({
      nothingToStart: 'Nothing to start.',
      runUnavailable: 'Run starts when you press Start.',
      historyReadOnly: 'History is read-only.',
      backToQueueOrder: 'Back to queue order.'
    })
  })
})
