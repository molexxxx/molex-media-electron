/**
 * The first-run setup's pure pieces: stages, the size and source line, the found-build note, the download rate and
 * readouts, the plain words for every stopped download and refused folder, and the FFmpeg step reducer.
 */
import { describe, expect, it } from 'vitest'
import type { FfmpegInfo, SetupProblem, SetupProblemKind } from '../../../src/shared/ipc/api'
import
{
  RATE_WINDOW_MS,
  STAGE_WORDS,
  addSample,
  folderOf,
  downloadReadouts,
  failedTestIn,
  ffmpegSourceLine,
  ffmpegStep,
  foundLine,
  hostLabel,
  offerLine,
  problemOfError,
  problemWords,
  rateOf,
  rateText,
  refusalWords,
  sourceWords,
  stageOf,
  toolNames,
  versionWords,
  ytDlpLine,
  type FfmpegStep
} from '../../../src/renderer/src/components/setup/setupFlow'
import type { YtDlpStatus } from '../../../src/shared/ipc/api'

function ytdlp(overrides: Partial<YtDlpStatus> = {}): YtDlpStatus
{
  return {
    installed: true,
    version: '2026.08.19',
    source: 'app',
    path: 'C:\\Users\\you\\AppData\\Roaming\\molexMedia\\ytdlp-bin\\yt-dlp.exe',
    autoUpdate: true,
    useSystem: false,
    onPath: null,
    lastCheckAt: null,
    latest: null,
    state: { kind: 'idle' },
    ...overrides
  }
}

const ALL_PASSED = { 'chain-flac-s16': true, 'chain-opus-51side': true, 'chain-aac-mono': true, 'meter-dual-mono': true, 'meter-surround': true, 'soxr': true, 'encoders': true }

function info(overrides: Partial<FfmpegInfo> = {}): FfmpegInfo
{
  return {
    found: true,
    usable: true,
    version: '9.0.2',
    versionString: 'n9.0.2-17-g2a571b6068',
    source: 'bundled',
    ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
    ffprobePath: 'C:\\ffmpeg\\ffprobe.exe',
    libsoxr: true,
    meetsMinimum: true,
    selfTest: { status: 'passed', failedTest: null, results: ALL_PASSED, testedAt: null, durationMs: null },
    refusal: null,
    pin: { version: '9.0.2', matches: true, offerInstall: false, installLabel: 'Install FFmpeg 9.0.x (tested with this version)' },
    ...overrides
  }
}

function problem(kind: SetupProblemKind, status: number | null = null, detail = ''): SetupProblem
{
  return { kind, status, detail }
}

describe('install stages', () =>
{
  it('reads each bootstrap stage as the stage the user sees', () =>
  {
    expect(stageOf({ stage: 'checking', message: '' })).toBe('checking')
    expect(stageOf({ stage: 'downloading', message: 'Downloading FFmpeg 9.0.2...' })).toBe('downloading')
    expect(stageOf({ stage: 'extracting', message: 'Extracting FFmpeg binaries...' })).toBe('unpacking')
    expect(stageOf({ stage: 'extracting', message: 'Installing FFmpeg...' })).toBe('installing')
    expect(stageOf({ stage: 'verifying', message: '' })).toBe('testing')
    expect(stageOf({ stage: 'complete', message: '' })).toBe('testing')
    expect(stageOf({ stage: 'error', message: '' })).toBe('downloading')
    expect(STAGE_WORDS.testing).toBe('Running the self-test')
  })
})

describe('what FFmpeg needs', () =>
{
  it('names the size, publisher, and host', () =>
  {
    expect(hostLabel('github.com')).toBe('GitHub')
    expect(hostLabel('ffmpeg.martin-riedl.de')).toBe('ffmpeg.martin-riedl.de')
    expect(ffmpegSourceLine({ bytes: 194_034_585, publisher: 'BtbN FFmpeg Builds', host: 'github.com' })).toBe('About 194 MB from BtbN FFmpeg Builds on GitHub.')
    expect(ffmpegSourceLine({ bytes: 41_200_000, publisher: 'Martin Riedl', host: 'ffmpeg.martin-riedl.de' })).toBe('About 41.2 MB from Martin Riedl on ffmpeg.martin-riedl.de.')
    expect(ffmpegSourceLine({ bytes: 1_000_000, publisher: 'example.org', host: 'example.org' })).toBe('About 1 MB from example.org.')
    expect(ffmpegSourceLine(null)).toBeNull()
  })

  it('notes a build on this computer that was refused, and nothing otherwise', () =>
  {
    expect(foundLine(null)).toBeNull()
    expect(foundLine(info())).toBeNull()
    expect(foundLine(info({ found: false, usable: false }))).toBeNull()
    expect(foundLine(info({ usable: false, meetsMinimum: false, version: '4.4.2' }))).toBe('This computer has FFmpeg 4.4.2, which is older than 5.1, the oldest version molexMedia supports.')
    expect(foundLine(info({ usable: false, meetsMinimum: false, version: null }))).toContain('an unknown version')
    expect(foundLine(info({ usable: false, selfTest: { ...info().selfTest, status: 'failed', failedTest: 'encoders' } }))).toBe('This computer has FFmpeg 9.0.2, but it failed a self-test: Required encoders.')
    expect(foundLine(info({ usable: false }))).toBe('This computer has FFmpeg 9.0.2, but it did not pass the self-test.')
  })
})

describe('a build on PATH', () =>
{
  it('names its folder, its version, and that it waits to be chosen', () =>
  {
    expect(folderOf('C:\\ffmpeg\\bin\\ffmpeg.exe')).toBe('C:\\ffmpeg\\bin')
    expect(folderOf('/usr/local/bin/ffmpeg')).toBe('/usr/local/bin')
    expect(folderOf('ffmpeg')).toBe('ffmpeg')
    expect(versionWords('7.1')).toBe('FFmpeg 7.1')
    expect(versionWords('2022-10-13-git-9e8a327e68-full_build-www.gyan.dev')).toBe('an FFmpeg development build from 2022-10-13')
    expect(offerLine({ version: '7.1', ffmpegPath: '/opt/ffmpeg/ffmpeg' })).toBe('FFmpeg 7.1 is already on this computer, in /opt/ffmpeg. It passed the self-test, and molexMedia uses it only if you choose it.')
  })
})

describe('download rate and readouts', () =>
{
  it('keeps the samples inside the window and starts over when the count falls', () =>
  {
    let samples = addSample([], { at: 0, received: 0 })
    samples = addSample(samples, { at: 1000, received: 1_000_000 })
    samples = addSample(samples, { at: RATE_WINDOW_MS + 500, received: 4_000_000 })
    expect(samples.map((s) => s.at)).toEqual([1000, RATE_WINDOW_MS + 500])
    expect(addSample(samples, { at: 5000, received: 10 })).toEqual([{ at: 5000, received: 10 }])
  })

  it('measures bytes per second once the samples span half a second', () =>
  {
    expect(rateOf([])).toBeNull()
    expect(rateOf([{ at: 0, received: 0 }, { at: 400, received: 1_000_000 }])).toBeNull()
    expect(rateOf([{ at: 0, received: 0 }, { at: 2000, received: 18_800_000 }])).toBe(9_400_000)
  })

  it('writes megabytes per second, and kilobytes under a tenth of a megabyte', () =>
  {
    expect(rateText(9_400_000)).toEqual({ value: '9.4', unit: 'MB/s' })
    expect(rateText(640_000)).toEqual({ value: '0.6', unit: 'MB/s' })
    expect(rateText(64_400)).toEqual({ value: '64', unit: 'KB/s' })
    expect(rateText(-5)).toEqual({ value: '0', unit: 'KB/s' })
  })

  it('lights percent, size, and speed as they become known', () =>
  {
    expect(downloadReadouts({ percent: 0, received: null, total: null, rate: null })).toEqual([{ key: 'percent', value: '0%', unit: '', spoken: '0 percent' }])
    const all = downloadReadouts({ percent: 37.9, received: 72_140_000, total: 194_034_585, rate: 9_400_000 })
    expect(all.map((r) => [r.value, r.unit])).toEqual([['37%', ''], ['72.1', 'of 194 MB'], ['9.4', 'MB/s']])
    expect(all.map((r) => r.spoken)).toEqual(['37 percent', '72.1 MB of 194 MB', '9.4 megabytes per second'])
    expect(downloadReadouts({ percent: 140, received: 300, total: 200, rate: 50_000 }).map((r) => r.value)).toEqual(['100%', '0', '50'])
    expect(downloadReadouts({ percent: 140, received: 300, total: 200, rate: 50_000 })[2].spoken).toBe('50 kilobytes per second')
    expect(downloadReadouts({ percent: -3, received: 5, total: 0, rate: null })).toHaveLength(1)
  })
})

describe('problem words', () =>
{
  it('finds the self-test a message names', () =>
  {
    expect(failedTestIn('FFmpeg failed the chain-flac-s16 self-test')).toBe('chain-flac-s16')
    expect(failedTestIn('FFmpeg failed the made-up self-test')).toBeNull()
    expect(failedTestIn('anything else')).toBeNull()
  })

  it('names each stopped download and its way out', () =>
  {
    expect(problemWords(problem('offline'))).toEqual({ title: 'molexMedia could not reach the download server', body: 'Check your internet connection, then retry.' })
    expect(problemWords(problem('stalled')).title).toBe('The download stopped responding')
    expect(problemWords(problem('unavailable')).body).toContain('update molexMedia')
    expect(problemWords(problem('server', 503)).body).toBe('It answered with status 503. Retry in a few minutes.')
    expect(problemWords(problem('server')).body).toBe('Retry in a few minutes.')
    expect(problemWords(problem('checksum')).title).toBe('The download was damaged')
    expect(problemWords(problem('disk-full')).title).toBe('The disk is full')
    expect(problemWords(problem('no-access')).body).toContain('Close other copies of molexMedia')
    expect(problemWords(problem('rejected', null, 'FFmpeg failed the encoders self-test')).body).toBe('Failed test: Required encoders. Retry the download, or use an FFmpeg already on this computer.')
    expect(problemWords(problem('rejected')).body).toBe('Retry the download, or use an FFmpeg already on this computer.')
    expect(problemWords(problem('unknown')).title).toBe('Setup stopped')
  })

  it('reads a thrown value as an unknown problem with its message', () =>
  {
    expect(problemOfError(new Error('boom'))).toEqual({ kind: 'unknown', status: null, detail: 'boom' })
    expect(problemOfError('text')).toEqual({ kind: 'unknown', status: null, detail: 'text' })
    expect(problemOfError(42)).toEqual({ kind: 'unknown', status: null, detail: '' })
  })

  it('names the tools per platform and each refused folder', () =>
  {
    expect(toolNames('win32')).toBe('ffmpeg.exe and ffprobe.exe')
    expect(toolNames('darwin')).toBe('ffmpeg and ffprobe')
    expect(refusalWords({ reason: 'missing', version: null, failedTest: null }, 'win32').body).toBe('molexMedia looks for ffmpeg.exe and ffprobe.exe in the folder you choose and in its bin folder.')
    expect(refusalWords({ reason: 'not-running', version: null, failedTest: null }, 'linux').title).toBe('The FFmpeg in that folder does not start')
    expect(refusalWords({ reason: 'minimum', version: '4.4.2', failedTest: null }, 'win32').title).toBe('FFmpeg 4.4.2 is too old')
    expect(refusalWords({ reason: 'minimum', version: null, failedTest: null }, 'win32').title).toBe('FFmpeg in that folder is too old')
    expect(refusalWords({ reason: 'self-test', version: '7.1', failedTest: 'chain-aac-mono' }, 'win32').body).toBe('Failed test: Mono limiter chain to AAC. Jobs would fail with it, so choose another folder, or download the tested build.')
    expect(refusalWords({ reason: 'self-test', version: '7.1', failedTest: null }, 'win32').body).toContain('Jobs would fail with it')
  })

  it('states the yt-dlp copy in use, the download under way, or that it comes with the first link', () =>
  {
    expect(ytDlpLine(null)).toBe('Downloads the first time you open a link')
    expect(ytDlpLine(ytdlp({ installed: false, version: null, source: null, path: null }))).toBe('Downloads the first time you open a link')
    expect(ytDlpLine(ytdlp({ source: null }))).toBe('Downloads the first time you open a link')
    expect(ytDlpLine(ytdlp())).toBe('yt-dlp 2026.08.19, installed and kept up to date by molexMedia')
    expect(ytDlpLine(ytdlp({ autoUpdate: false }))).toBe('yt-dlp 2026.08.19, installed by molexMedia')
    expect(ytDlpLine(ytdlp({ source: 'system', path: 'C:\\Tools\\yt-dlp.exe', autoUpdate: false }))).toBe('yt-dlp 2026.08.19, found on this computer')
    expect(ytDlpLine(ytdlp({ source: 'system', version: null }))).toBe('yt-dlp, found on this computer')
    expect(ytDlpLine(ytdlp({ installed: false, version: null, source: null, state: { kind: 'updating', phase: 'downloading', version: '2026.08.19', receivedBytes: 10, totalBytes: 100 } })))
      .toBe('Downloading yt-dlp 2026.08.19 now')
  })

  it('says where an adopted build came from', () =>
  {
    expect(sourceWords('bundled')).toBe('Installed by molexMedia')
    expect(sourceWords('custom')).toBe('Chosen by you')
    expect(sourceWords('path')).toBe('Found on PATH')
    expect(sourceWords(null)).toBe('')
  })
})

describe('FFmpeg step', () =>
{
  const idle: FfmpegStep = { kind: 'idle' }

  function installing(): FfmpegStep
  {
    return ffmpegStep(idle, { type: 'install' })
  }

  it('starts an install at the first check and ignores progress outside one', () =>
  {
    expect(installing()).toMatchObject({ kind: 'installing', stage: 'checking', percent: 0, verified: false, samples: [] })
    expect(ffmpegStep(idle, { type: 'progress', progress: { stage: 'downloading', message: '', percent: 5 }, at: 0 })).toBe(idle)
  })

  it('records bytes and samples while downloading, then marks the download verified once it moves on', () =>
  {
    let step = installing()
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'downloading', message: '', percent: 0 }, at: 0 })
    expect(step).toMatchObject({ stage: 'downloading', received: null, total: null, samples: [] })
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'downloading', message: '', percent: 10, received: 19_400_000, total: 194_000_000 }, at: 1000 })
    expect(step).toMatchObject({ stage: 'downloading', percent: 10, received: 19_400_000, total: 194_000_000 })
    expect(step.kind === 'installing' && step.samples).toHaveLength(1)
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'extracting', message: 'Extracting FFmpeg binaries...', percent: 50 }, at: 2000 })
    expect(step).toMatchObject({ stage: 'unpacking', verified: true, percent: 10 })
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'downloading', message: '', percent: 60, received: 120_000_000, total: 194_000_000 }, at: 3000 })
    expect(step).toMatchObject({ stage: 'downloading', percent: 60, verified: true })
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'checking', message: '', percent: 0 }, at: 3500 })
    expect(step).toMatchObject({ stage: 'downloading' })
    step = ffmpegStep(step, { type: 'progress', progress: { stage: 'verifying', message: '', percent: 90 }, at: 4000 })
    expect(step).toMatchObject({ stage: 'testing' })
    expect(ffmpegStep(step, { type: 'progress', progress: { stage: 'extracting', message: 'Installing FFmpeg...', percent: 75 }, at: 4100 })).toBe(step)
  })

  it('reuses an installed build without calling it a verified download', () =>
  {
    const step = ffmpegStep(installing(), { type: 'progress', progress: { stage: 'complete', message: 'FFmpeg is ready!', percent: 100 }, at: 10 })
    expect(step).toMatchObject({ stage: 'testing', verified: false })
  })

  it('moves to a failure, a folder check, a refusal, or ready', () =>
  {
    expect(ffmpegStep(installing(), { type: 'fail', problem: problem('offline') })).toEqual({ kind: 'failed', problem: problem('offline') })
    expect(ffmpegStep(idle, { type: 'check-folder', folder: 'D:\\Tools' })).toEqual({ kind: 'checking-folder', folder: 'D:\\Tools' })
    expect(ffmpegStep(idle, { type: 'refuse', folder: 'D:\\Tools', reason: 'minimum', version: '4.4', failedTest: null }))
      .toEqual({ kind: 'refused', folder: 'D:\\Tools', reason: 'minimum', version: '4.4', failedTest: null })
    expect(ffmpegStep(idle, { type: 'ready', info: info() })).toEqual({ kind: 'ready', info: info() })
  })
})
