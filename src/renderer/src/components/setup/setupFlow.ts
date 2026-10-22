/**
 * @module components/setup/setupFlow
 * @description The first-run setup's words and the pure pieces behind them: what each component needs, the
 * download readouts and their rate, the plain words for a stopped download or a refused folder, and the flow's
 * state as one reducer.
 */
import type {
  FfmpegDownloadFacts,
  FfmpegDownloadProgress,
  FfmpegFolderRefusal,
  FfmpegInfo,
  FfmpegSelfTestId,
  SetupProblem,
  YtDlpStatus
} from '../../../../shared/ipc/api'
import { megabytes } from '../../../../shared/jobs/describe'
import { SELF_TEST_LABELS } from '../settings/tabs/AudioSettings'

/** The setup's words. */
export const SETUP_WORDS = {
  title: 'Welcome to molexMedia',
  pitch: 'molexMedia normalizes loudness and converts, compresses, and trims audio and video, one file or a whole folder at a time.',
  needsHeading: 'What molexMedia needs',
  ffmpeg: 'FFmpeg',
  ffmpegPurpose: 'Reads, measures, and writes every file. molexMedia cannot start a job without it.',
  ffmpegCheck: 'Checked against the SHA-256 molexMedia ships with, then self-tested.',
  ytdlp: 'yt-dlp',
  ytdlpPurpose: 'Opens links from YouTube and other sites in the Player.',
  ytdlpWhen: 'Downloads from the yt-dlp project on GitHub the first time you open a link, and molexMedia keeps it up to date.',
  folderNote: 'Both go into molexMedia\'s own data folder. Nothing else on your computer changes.',
  license: 'FFmpeg is licensed under the LGPL or GPL, yt-dlp under the Unlicense.',
  required: 'Required',
  whenNeeded: 'When you open a link',
  download: 'Download FFmpeg',
  downloading: 'Downloading',
  retry: 'Retry download',
  useExisting: 'Use an FFmpeg already on this computer',
  useFound: 'Use the FFmpeg on this computer',
  chooseFolder: 'Choose a folder',
  chooseAnother: 'Choose another folder',
  checkingFolder: 'Checking FFmpeg',
  details: 'Details',
  doneTitle: 'molexMedia is ready',
  openBatch: 'Open Batch',
  openDashboard: 'Open Dashboard',
  installedBy: 'Installed by molexMedia',
  chosenByYou: 'Chosen by you',
  onPath: 'Found on PATH',
  ytdlpLater: 'Downloads the first time you open a link',
  checkingStart: 'Looking for FFmpeg',
  verified: 'Download verified: the SHA-256 matches.'
} as const

/** Where an install stands, from the bootstrap's stages. */
export type InstallStage = 'checking' | 'downloading' | 'unpacking' | 'installing' | 'testing'

/** The word for an install stage. */
export const STAGE_WORDS: Readonly<Record<InstallStage, string>> =
{
  checking: 'Looking for an earlier download',
  downloading: 'Downloading',
  unpacking: 'Unpacking',
  installing: 'Installing',
  testing: 'Running the self-test'
}

/** The install stage a progress report stands for; the bootstrap reports unpacking and installing as one stage. */
export function stageOf(progress: Pick<FfmpegDownloadProgress, 'stage' | 'message'>): InstallStage
{
  switch (progress.stage)
  {
    case 'checking':
      return 'checking'
    case 'extracting':
      return /install/i.test(progress.message) ? 'installing' : 'unpacking'
    case 'verifying':
    case 'complete':
      return 'testing'
    default:
      return 'downloading'
  }
}

/** A host as people name it: github.com reads GitHub. */
export function hostLabel(host: string): string
{
  return host === 'github.com' ? 'GitHub' : host
}

/** The size and source line of the FFmpeg row: "About 194 MB from BtbN FFmpeg Builds on GitHub." */
export function ffmpegSourceLine(facts: FfmpegDownloadFacts | null): string | null
{
  if (facts === null)
  {
    return null
  }
  const where = facts.publisher === facts.host ? `from ${facts.host}` : `from ${facts.publisher} on ${hostLabel(facts.host)}`
  return `About ${megabytes(facts.bytes)} ${where}.`
}

/** A found build the pipeline refused, as one line for the FFmpeg row, or null when none was found. */
export function foundLine(info: Pick<FfmpegInfo, 'found' | 'usable' | 'version' | 'meetsMinimum' | 'selfTest'> | null): string | null
{
  if (info === null || !info.found || info.usable)
  {
    return null
  }
  const version = info.version ?? 'an unknown version'
  if (!info.meetsMinimum)
  {
    return `This computer has FFmpeg ${version}, which is older than 5.1, the oldest version molexMedia supports.`
  }
  const failed = info.selfTest.failedTest
  return failed === null
    ? `This computer has FFmpeg ${version}, but it did not pass the self-test.`
    : `This computer has FFmpeg ${version}, but it failed a self-test: ${SELF_TEST_LABELS[failed]}.`
}

/** The folder a file is in, for Windows and POSIX paths alike. */
export function folderOf(filePath: string): string
{
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut <= 0 ? filePath : filePath.slice(0, cut)
}

/** A version as a sentence names it: "FFmpeg 7.1", or "an FFmpeg development build from 2022-10-13" for a dated git build. */
export function versionWords(version: string): string
{
  const dated = /^(\d{4}-\d{2}-\d{2})-git/.exec(version)
  return dated === null ? `FFmpeg ${version}` : `an FFmpeg development build from ${dated[1]}`
}

/** The offer line for a passing build on PATH that is not used until chosen. */
export function offerLine(offer: { version: string; ffmpegPath: string }): string
{
  const what = versionWords(offer.version)
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} is already on this computer, in ${folderOf(offer.ffmpegPath)}. It passed the self-test, and molexMedia uses it only if you choose it.`
}

/** One sample of a download: when it was taken and how many bytes had arrived. */
export interface RateSample
{
  at: number
  received: number
}

/** How far back the download rate looks. */
export const RATE_WINDOW_MS = 3000

/** The samples to keep after a new one: the new one and those inside the rate window; a smaller count starts over. */
export function addSample(samples: readonly RateSample[], next: RateSample): RateSample[]
{
  const last = samples[samples.length - 1]
  if (last !== undefined && next.received < last.received)
  {
    return [next]
  }
  return [...samples.filter((sample) => next.at - sample.at <= RATE_WINDOW_MS), next]
}

/** Bytes per second across the samples, or null until they span half a second. */
export function rateOf(samples: readonly RateSample[]): number | null
{
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || last.at - first.at < 500)
  {
    return null
  }
  return ((last.received - first.received) * 1000) / (last.at - first.at)
}

/** One lit readout: its value, the quieter unit after it, and the whole as spoken. */
export interface Readout
{
  key: 'percent' | 'size' | 'speed'
  value: string
  unit: string
  spoken: string
}

function decimalMegabytes(bytes: number): string
{
  return String(Number((bytes / 1_000_000).toFixed(1)))
}

/** A download rate: "9.4 MB/s", or "640 KB/s" under a tenth of a megabyte per second. */
export function rateText(bytesPerSecond: number): { value: string; unit: string }
{
  if (bytesPerSecond < 100_000)
  {
    return { value: String(Math.max(0, Math.round(bytesPerSecond / 1000))), unit: 'KB/s' }
  }
  return { value: (bytesPerSecond / 1_000_000).toFixed(1), unit: 'MB/s' }
}

/** The readouts under a download's bar: percent, size so far of the whole, and speed once it is known. */
export function downloadReadouts(o: { percent: number; received: number | null; total: number | null; rate: number | null }): Readout[]
{
  const percent = Math.max(0, Math.min(100, Math.floor(o.percent)))
  const out: Readout[] = [{ key: 'percent', value: `${percent}%`, unit: '', spoken: `${percent} percent` }]
  if (o.received !== null && o.total !== null && o.total > 0)
  {
    const unit = `of ${megabytes(o.total)}`
    out.push({ key: 'size', value: decimalMegabytes(Math.min(o.received, o.total)), unit, spoken: `${megabytes(Math.min(o.received, o.total))} ${unit}` })
  }
  if (o.rate !== null)
  {
    const rate = rateText(o.rate)
    out.push({ key: 'speed', value: rate.value, unit: rate.unit, spoken: `${rate.value} ${rate.unit === 'MB/s' ? 'megabytes' : 'kilobytes'} per second` })
  }
  return out
}

/** A problem's words: the title names it, the body gives the way out. */
export interface ProblemWords
{
  title: string
  body: string
}

/** The self-test a refusal or error message names, such as chain-flac-s16 in "FFmpeg failed the chain-flac-s16 self-test". */
export function failedTestIn(text: string): FfmpegSelfTestId | null
{
  const id = /failed the (\S+) self-test/.exec(text)?.[1]
  return id !== undefined && id in SELF_TEST_LABELS ? id as FfmpegSelfTestId : null
}

/** Why the FFmpeg download or install stopped, in plain words. */
export function problemWords(problem: SetupProblem): ProblemWords
{
  switch (problem.kind)
  {
    case 'offline':
      return { title: 'molexMedia could not reach the download server', body: 'Check your internet connection, then retry.' }
    case 'stalled':
      return { title: 'The download stopped responding', body: 'Nothing arrived for a minute. Check your connection, then retry.' }
    case 'unavailable':
      return {
        title: 'The tested FFmpeg build cannot be downloaded',
        body: 'Its download is no longer available. Use an FFmpeg 5.1 or newer that is already on this computer, or update molexMedia.'
      }
    case 'server':
      return {
        title: 'The download server returned an error',
        body: problem.status === null ? 'Retry in a few minutes.' : `It answered with status ${problem.status}. Retry in a few minutes.`
      }
    case 'checksum':
      return { title: 'The download was damaged', body: 'It did not match the SHA-256 molexMedia expects, so it was deleted. Retry the download.' }
    case 'disk-full':
      return { title: 'The disk is full', body: 'Free some space on your system drive, then retry.' }
    case 'no-access':
      return {
        title: 'molexMedia could not write its FFmpeg folder',
        body: 'Another program may be using it, or your account cannot write there. Close other copies of molexMedia, then retry.'
      }
    case 'rejected':
    {
      const failed = failedTestIn(problem.detail)
      return {
        title: 'The downloaded FFmpeg did not pass its checks',
        body: failed === null
          ? 'Retry the download, or use an FFmpeg already on this computer.'
          : `Failed test: ${SELF_TEST_LABELS[failed]}. Retry the download, or use an FFmpeg already on this computer.`
      }
    }
    default:
      return { title: 'Setup stopped', body: 'Retry the download, or use an FFmpeg already on this computer.' }
  }
}

/** The file names of both tools on a platform: "ffmpeg.exe and ffprobe.exe" on Windows. */
export function toolNames(platform: string): string
{
  return platform === 'win32' ? 'ffmpeg.exe and ffprobe.exe' : 'ffmpeg and ffprobe'
}

/** Why a chosen folder was not used, in plain words. */
export function refusalWords(o: { reason: FfmpegFolderRefusal; version: string | null; failedTest: FfmpegSelfTestId | null }, platform: string): ProblemWords
{
  switch (o.reason)
  {
    case 'missing':
      return {
        title: 'That folder has no FFmpeg',
        body: `molexMedia looks for ${toolNames(platform)} in the folder you choose and in its bin folder.`
      }
    case 'not-running':
      return { title: 'The FFmpeg in that folder does not start', body: 'It may be damaged, or built for another kind of computer. Choose another folder, or download FFmpeg.' }
    case 'minimum':
      return {
        title: `FFmpeg ${o.version ?? 'in that folder'} is too old`,
        body: 'molexMedia needs FFmpeg 5.1 or newer. Choose a newer one, or download the tested build.'
      }
    default:
      return {
        title: 'The FFmpeg in that folder failed its self-test',
        body: o.failedTest === null
          ? 'Jobs would fail with it, so molexMedia did not use it. Choose another folder, or download the tested build.'
          : `Failed test: ${SELF_TEST_LABELS[o.failedTest]}. Jobs would fail with it, so choose another folder, or download the tested build.`
      }
  }
}

/** Where the FFmpeg component stands. */
export type FfmpegStep =
  | { kind: 'idle' }
  | { kind: 'installing'; stage: InstallStage; percent: number; received: number | null; total: number | null; verified: boolean; samples: RateSample[] }
  | { kind: 'failed'; problem: SetupProblem }
  | { kind: 'checking-folder'; folder: string }
  | { kind: 'refused'; folder: string; reason: FfmpegFolderRefusal; version: string | null; failedTest: FfmpegSelfTestId | null }
  | { kind: 'ready'; info: FfmpegInfo }

/** What changes the FFmpeg component. */
export type FfmpegAction =
  | { type: 'install' }
  | { type: 'progress'; progress: FfmpegDownloadProgress; at: number }
  | { type: 'fail'; problem: SetupProblem }
  | { type: 'check-folder'; folder: string }
  | { type: 'refuse'; folder: string; reason: FfmpegFolderRefusal; version: string | null; failedTest: FfmpegSelfTestId | null }
  | { type: 'ready'; info: FfmpegInfo }

/**
 * The next FFmpeg step. Progress counts only during an install, never returns it to its first check or out of the
 * self-test, and marks the download verified once it moves past downloading, since the bootstrap unpacks nothing
 * before the SHA-256 matches.
 */
export function ffmpegStep(step: FfmpegStep, action: FfmpegAction): FfmpegStep
{
  switch (action.type)
  {
    case 'install':
      return { kind: 'installing', stage: 'checking', percent: 0, received: null, total: null, verified: false, samples: [] }
    case 'progress':
    {
      if (step.kind !== 'installing')
      {
        return step
      }
      const stage = stageOf(action.progress)
      if ((stage === 'checking' && step.stage !== 'checking') || (step.stage === 'testing' && stage !== 'testing'))
      {
        return step
      }
      if (stage !== 'downloading')
      {
        return { ...step, stage, verified: step.verified || step.stage === 'downloading' }
      }
      const received = typeof action.progress.received === 'number' ? action.progress.received : null
      const total = typeof action.progress.total === 'number' ? action.progress.total : null
      return {
        ...step,
        stage,
        percent: action.progress.percent,
        received,
        total,
        samples: received === null ? step.samples : addSample(step.samples, { at: action.at, received })
      }
    }
    case 'fail':
      return { kind: 'failed', problem: action.problem }
    case 'check-folder':
      return { kind: 'checking-folder', folder: action.folder }
    case 'refuse':
      return { kind: 'refused', folder: action.folder, reason: action.reason, version: action.version, failedTest: action.failedTest }
    case 'ready':
      return { kind: 'ready', info: action.info }
  }
}

/** The problem a failed install reply or a thrown call stands for, when main sent none. */
export function problemOfError(error: unknown): SetupProblem
{
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return { kind: 'unknown', status: null, detail }
}

/**
 * The yt-dlp fact of the done screen: the copy in use and who keeps it current, the download in progress, or that it
 * arrives with the first link when nothing is installed or the status is unknown.
 */
export function ytDlpLine(status: YtDlpStatus | null): string
{
  if (status === null)
  {
    return SETUP_WORDS.ytdlpLater
  }
  if (status.state.kind === 'updating')
  {
    return `Downloading yt-dlp ${status.state.version} now`
  }
  if (!status.installed || status.source === null)
  {
    return SETUP_WORDS.ytdlpLater
  }
  const name = status.version === null ? 'yt-dlp' : `yt-dlp ${status.version}`
  if (status.source === 'system')
  {
    return `${name}, found on this computer`
  }
  return status.autoUpdate ? `${name}, installed and kept up to date by molexMedia` : `${name}, installed by molexMedia`
}

/** Where an adopted build came from, as the done screen says it. */
export function sourceWords(source: FfmpegInfo['source']): string
{
  switch (source)
  {
    case 'bundled':
      return SETUP_WORDS.installedBy
    case 'custom':
      return SETUP_WORDS.chosenByYou
    case 'path':
      return SETUP_WORDS.onPath
    default:
      return ''
  }
}
