/**
 * First-run setup: what molexMedia does and needs, the tested FFmpeg download with its lit readouts, every stopped
 * download with Retry, a folder already on this computer adopted or refused, the done screen's ways out, and the
 * keyboard paths (Enter runs the one primary action, Escape returns to it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { FfmpegDownloadProgress, FfmpegFolderResult, FfmpegInfo, FfmpegInstallResult, YtDlpStatus } from '../../../src/shared/ipc/api'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import SetupWizard, { doneLine } from '../../../src/renderer/src/components/setup/SetupWizard'
import { StartupCheck } from '../../../src/renderer/src/components/setup/StartupCheck'
import { SETUP_WORDS } from '../../../src/renderer/src/components/setup/setupFlow'

const ALL_PASSED = { 'chain-flac-s16': true, 'chain-opus-51side': true, 'chain-aac-mono': true, 'meter-dual-mono': true, 'meter-surround': true, 'soxr': true, 'encoders': true }

function info(overrides: Partial<FfmpegInfo> = {}): FfmpegInfo
{
  return {
    found: true,
    usable: true,
    version: '9.0.2',
    versionString: 'n9.0.2-17-g2a571b6068',
    source: 'bundled',
    ffmpegPath: 'C:\\Users\\you\\AppData\\Roaming\\molexMedia\\ffmpeg\\btbn-n9.0.2-17-g2a571b6068\\ffmpeg.exe',
    ffprobePath: 'C:\\Users\\you\\AppData\\Roaming\\molexMedia\\ffmpeg\\btbn-n9.0.2-17-g2a571b6068\\ffprobe.exe',
    libsoxr: true,
    meetsMinimum: true,
    selfTest: { status: 'passed', failedTest: null, results: ALL_PASSED, testedAt: new Date(2026, 9, 20, 11, 2).getTime(), durationMs: 1400 },
    refusal: null,
    pin: { version: '9.0.2', matches: true, offerInstall: false, installLabel: 'Install FFmpeg 9.0.x (tested with this version)' },
    ...overrides
  }
}

const MISSING = info({
  found: false,
  usable: false,
  version: null,
  versionString: null,
  source: null,
  ffmpegPath: null,
  ffprobePath: null,
  selfTest: { status: null, failedTest: null, results: null, testedAt: null, durationMs: null }
})

const FACTS = { bytes: 194_034_585, publisher: 'BtbN FFmpeg Builds', host: 'github.com' }

const YTDLP: YtDlpStatus = {
  installed: true,
  version: '2026.08.19',
  source: 'app',
  path: 'C:\\Users\\you\\AppData\\Roaming\\molexMedia\\ytdlp-bin\\yt-dlp.exe',
  autoUpdate: true,
  useSystem: false,
  onPath: null,
  lastCheckAt: null,
  latest: null,
  state: { kind: 'idle' }
}

const YTDLP_LINE = 'yt-dlp 2026.08.19, installed and kept up to date by molexMedia'

interface FakeApi
{
  getFFmpegInfo: ReturnType<typeof vi.fn>
  getFFmpegDownloadFacts?: ReturnType<typeof vi.fn>
  installPinnedFFmpeg: ReturnType<typeof vi.fn>
  onDownloadProgress: ReturnType<typeof vi.fn>
  chooseFFmpegFolder?: ReturnType<typeof vi.fn>
  adoptFFmpegFolder?: ReturnType<typeof vi.fn>
  getYtDlpStatus?: ReturnType<typeof vi.fn>
  onYtDlpStatus?: ReturnType<typeof vi.fn>
  loadConfig: ReturnType<typeof vi.fn>
  progress: ((p: FfmpegDownloadProgress) => void) | null
  unsubscribe: ReturnType<typeof vi.fn>
  ytdlp: ((status: YtDlpStatus) => void) | null
  unsubscribeYtdlp: ReturnType<typeof vi.fn>
}

let api: FakeApi

function stub(first: FfmpegInfo = MISSING): FakeApi
{
  const fake: FakeApi = {
    getFFmpegInfo: vi.fn(async () => first),
    getFFmpegDownloadFacts: vi.fn(async () => FACTS),
    installPinnedFFmpeg: vi.fn(),
    onDownloadProgress: vi.fn(),
    chooseFFmpegFolder: vi.fn(async () => null),
    adoptFFmpegFolder: vi.fn(),
    getYtDlpStatus: vi.fn(async () => YTDLP),
    onYtDlpStatus: vi.fn(),
    loadConfig: vi.fn(async () => ({ outputDirectory: 'D:\\Exports' })),
    progress: null,
    unsubscribe: vi.fn(),
    ytdlp: null,
    unsubscribeYtdlp: vi.fn()
  }
  fake.onDownloadProgress.mockImplementation((cb: FakeApi['progress']) =>
  {
    fake.progress = cb
    return fake.unsubscribe
  })
  fake.onYtDlpStatus!.mockImplementation((cb: FakeApi['ytdlp']) =>
  {
    fake.ytdlp = cb
    return fake.unsubscribeYtdlp
  })
  vi.stubGlobal('api', fake)
  return fake
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
{
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((yes, no) =>
  {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function shown(): Promise<void>
{
  render(<SetupWizard />)
  await screen.findByText('About 194 MB from BtbN FFmpeg Builds on GitHub. ' + SETUP_WORDS.ffmpegCheck)
}

function primary(name: string | RegExp = SETUP_WORDS.download): HTMLElement
{
  return screen.getByRole('button', { name })
}

async function press(name: string | RegExp): Promise<void>
{
  await act(async () =>
  {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

beforeEach(() =>
{
  useAppStore.setState({ showSetup: true, downloadProgress: null, ffmpegReady: false, ffmpegVersion: '', currentView: 'dashboard', viewHistory: [] })
})

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SetupWizard, before anything runs', () =>
{
  it('says what molexMedia does, what it needs and why, from where, how large, and how it is checked', async () =>
  {
    api = stub()
    await shown()
    expect(screen.getByRole('heading', { level: 1, name: SETUP_WORDS.title })).toBeInTheDocument()
    expect(screen.getByText(SETUP_WORDS.pitch)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: SETUP_WORDS.needsHeading })).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('FFmpeg')).toBeInTheDocument()
    expect(within(rows[0]).getByText('9.0.2')).toBeInTheDocument()
    expect(within(rows[0]).getByText(SETUP_WORDS.required)).toBeInTheDocument()
    expect(within(rows[0]).getByText(SETUP_WORDS.ffmpegPurpose)).toBeInTheDocument()
    expect(within(rows[1]).getByText('yt-dlp')).toBeInTheDocument()
    expect(within(rows[1]).getByText(SETUP_WORDS.ytdlpWhen)).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/SHA-256/)).toBeNull()
    expect(screen.getByText(`${SETUP_WORDS.folderNote} ${SETUP_WORDS.license}`)).toBeInTheDocument()
  })

  it('offers one primary action, focused, and the folder of an FFmpeg already on this computer', async () =>
  {
    api = stub()
    await shown()
    expect(primary()).toHaveFocus()
    expect(screen.getByRole('button', { name: SETUP_WORDS.useExisting })).toBeInTheDocument()
    expect(document.querySelectorAll('.bg-accent')).toHaveLength(1)
  })

  it('reads without the size line when main has no download facts', async () =>
  {
    api = stub()
    delete api.getFFmpegDownloadFacts
    render(<SetupWizard />)
    expect(await screen.findByText('9.0.2')).toBeInTheDocument()
    expect(screen.getByText(SETUP_WORDS.ffmpegCheck)).toBeInTheDocument()
  })

  it('notes a build on this computer that molexMedia cannot use', async () =>
  {
    api = stub(info({ usable: false, meetsMinimum: false, version: '4.4.2', source: 'path', refusal: 'FFmpeg 5.1 or newer is required; found 4.4.2' }))
    await shown()
    expect(screen.getByText('This computer has FFmpeg 4.4.2, which is older than 5.1, the oldest version molexMedia supports.')).toBeInTheDocument()
  })

  it('still renders when the build information cannot be read', async () =>
  {
    api = stub()
    api.getFFmpegInfo.mockRejectedValueOnce(new Error('no handler'))
    api.getFFmpegDownloadFacts!.mockRejectedValueOnce(new Error('no handler'))
    render(<SetupWizard />)
    await act(async () => undefined)
    expect(primary()).toBeInTheDocument()
    expect(screen.getByText(SETUP_WORDS.ffmpegCheck)).toBeInTheDocument()
  })
})

describe('SetupWizard, downloading', () =>
{
  it('shows the stage, the lit percent, size, and speed, the verified checksum, then the done screen', async () =>
  {
    api = stub()
    const install = deferred<FfmpegInstallResult>()
    api.installPinnedFFmpeg.mockReturnValueOnce(install.promise)
    const now = vi.spyOn(performance, 'now')
    await shown()
    await press(SETUP_WORDS.download)
    expect(api.onDownloadProgress).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: SETUP_WORDS.downloading })).toBeInTheDocument()
    expect(screen.getByText(SETUP_WORDS.useExisting).closest('button')).toHaveAttribute('aria-disabled', 'true')

    now.mockReturnValue(1000)
    act(() => api.progress!({ stage: 'downloading', message: 'Downloading', percent: 10, received: 19_400_000, total: 194_034_585 }))
    now.mockReturnValue(3000)
    act(() => api.progress!({ stage: 'downloading', message: 'Downloading', percent: 20, received: 38_800_000, total: 194_034_585 }))
    const bar = screen.getByRole('progressbar', { name: 'Downloading FFmpeg' })
    expect(bar).toHaveAttribute('aria-valuenow', '20')
    expect(bar).toHaveAttribute('aria-valuetext', '20 percent, 38.8 MB of 194 MB, 9.7 megabytes per second')
    expect(document.querySelector('[data-readout="percent"]')).toHaveTextContent('20%')
    expect(document.querySelector('[data-readout="size"]')).toHaveTextContent('38.8of 194 MB')
    expect(document.querySelector('[data-readout="speed"]')).toHaveTextContent('9.7MB/s')
    expect(document.querySelectorAll('.type-readout')).toHaveLength(3)

    act(() => api.progress!({ stage: 'extracting', message: 'Extracting FFmpeg binaries...', percent: 50 }))
    expect(screen.getByRole('progressbar', { name: 'Unpacking FFmpeg' })).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText(SETUP_WORDS.verified)).toBeInTheDocument()
    act(() => api.progress!({ stage: 'verifying', message: 'Verifying', percent: 90 }))
    expect(screen.getByText('Running the self-test.')).toBeInTheDocument()

    await act(async () =>
    {
      install.resolve({ ok: true, info: info() })
    })
    expect(api.unsubscribe).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { level: 1, name: SETUP_WORDS.doneTitle })).toBeInTheDocument()
    expect(screen.getByText('FFmpeg 9.0.2 is installed and passed its self-test.')).toBeInTheDocument()
    expect(screen.getByText('Installed by molexMedia')).toBeInTheDocument()
    expect(screen.getByText('Passed')).toBeInTheDocument()
    expect(screen.getByText('Oct 20, 11:02, in 1.4 s')).toBeInTheDocument()
    expect(screen.getByText(YTDLP_LINE)).toBeInTheDocument()
    expect(useAppStore.getState().ffmpegReady).toBe(true)
    expect(useAppStore.getState().ffmpegVersion).toBe('9.0.2')
    expect(api.loadConfig).toHaveBeenCalled()
    expect(useAppStore.getState().config).toEqual({ outputDirectory: 'D:\\Exports' })
    expect(primary(SETUP_WORDS.openBatch)).toHaveFocus()
  })

  it('opens Batch or the Dashboard from the done screen', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValue({ ok: true, info: info() })
    await shown()
    await press(SETUP_WORDS.download)
    await press(SETUP_WORDS.openBatch)
    expect(useAppStore.getState()).toMatchObject({ currentView: 'batch', showSetup: false, downloadProgress: null })

    cleanup()
    useAppStore.setState({ showSetup: true, currentView: 'player' })
    await shown()
    await press(SETUP_WORDS.download)
    await press(SETUP_WORDS.openDashboard)
    expect(useAppStore.getState()).toMatchObject({ currentView: 'dashboard', showSetup: false })
  })

  it('warns on the done screen when the build measures surround loudness wrong', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: true, info: info({ selfTest: { ...info().selfTest, results: { ...ALL_PASSED, 'meter-surround': false } } }) })
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByText(/measures surround loudness incorrectly/)).toBeInTheDocument()
  })

  it('states the yt-dlp copy from the status, follows its changes, and stops listening on unmount', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: true, info: info() })
    await shown()
    expect(api.getYtDlpStatus).toHaveBeenCalledOnce()
    expect(api.onYtDlpStatus).toHaveBeenCalledOnce()
    await press(SETUP_WORDS.download)
    expect(screen.getByText(YTDLP_LINE)).toBeInTheDocument()
    act(() => api.ytdlp!({ ...YTDLP, state: { kind: 'updating', phase: 'downloading', version: '2026.09.01', receivedBytes: 1, totalBytes: 2 } }))
    expect(screen.getByText('Downloading yt-dlp 2026.09.01 now')).toBeInTheDocument()
    act(() => api.ytdlp!({ ...YTDLP, version: '2026.09.01', source: 'system', path: 'C:\\Tools\\yt-dlp.exe', autoUpdate: false }))
    expect(screen.getByText('yt-dlp 2026.09.01, found on this computer')).toBeInTheDocument()
    cleanup()
    expect(api.unsubscribeYtdlp).toHaveBeenCalledOnce()
  })

  it('says yt-dlp comes with the first link when nothing is installed or the status cannot be read', async () =>
  {
    api = stub()
    api.getYtDlpStatus!.mockResolvedValueOnce({ ...YTDLP, installed: false, version: null, source: null, path: null })
    api.installPinnedFFmpeg.mockResolvedValue({ ok: true, info: info() })
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByText(SETUP_WORDS.ytdlpLater)).toBeInTheDocument()

    cleanup()
    useAppStore.setState({ showSetup: true })
    api = stub()
    delete api.getYtDlpStatus
    delete api.onYtDlpStatus
    api.installPinnedFFmpeg.mockResolvedValue({ ok: true, info: info() })
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByText(SETUP_WORDS.ytdlpLater)).toBeInTheDocument()
  })

  it('reaches the done screen when the config cannot be reloaded', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: true, info: info() })
    api.loadConfig.mockRejectedValueOnce(new Error('gone'))
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByRole('heading', { level: 1, name: SETUP_WORDS.doneTitle })).toBeInTheDocument()
  })
})

describe('SetupWizard, a stopped download', () =>
{
  it('names the problem and the way out, folds the original message, and retries', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({
      ok: false,
      error: 'getaddrinfo ENOTFOUND github.com',
      info: MISSING,
      problem: { kind: 'offline', status: null, detail: 'getaddrinfo ENOTFOUND github.com' }
    })
    await shown()
    await press(SETUP_WORDS.download)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('molexMedia could not reach the download server')
    expect(alert).toHaveTextContent('Check your internet connection, then retry.')
    expect(screen.getByText('Not installed')).toBeInTheDocument()
    expect(api.unsubscribe).toHaveBeenCalledOnce()

    const details = screen.getByRole('button', { name: SETUP_WORDS.details })
    const raw = screen.getByText('getaddrinfo ENOTFOUND github.com')
    expect(raw).not.toBeVisible()
    fireEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    expect(raw).toBeVisible()

    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: true, info: info() })
    expect(primary(SETUP_WORDS.retry)).toBeInTheDocument()
    await press(SETUP_WORDS.retry)
    expect(api.installPinnedFFmpeg).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { level: 1, name: SETUP_WORDS.doneTitle })).toBeInTheDocument()
  })

  it('reads a failure main did not classify, and a thrown call, as setup stopped', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: false, error: 'Something odd', info: MISSING })
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByRole('alert')).toHaveTextContent('Setup stopped')
    expect(screen.getByText('Something odd')).toBeInTheDocument()

    api.installPinnedFFmpeg.mockRejectedValueOnce(new Error('No handler registered'))
    await press(SETUP_WORDS.retry)
    expect(screen.getByRole('alert')).toHaveTextContent('Setup stopped')
    expect(screen.getByText('No handler registered')).toBeInTheDocument()
  })

  it('names the damaged download, the full disk, and the removed build', async () =>
  {
    api = stub()
    await shown()
    for (const [kind, title] of [['checksum', 'The download was damaged'], ['disk-full', 'The disk is full'], ['unavailable', 'The tested FFmpeg build cannot be downloaded']] as const)
    {
      api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: false, error: kind, info: MISSING, problem: { kind, status: null, detail: kind } })
      await press(/Download FFmpeg|Retry download/)
      expect(screen.getByRole('alert')).toHaveTextContent(title)
    }
  })

  it('refuses an installed build that did not pass, naming its failed test', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({
      ok: true,
      info: info({ usable: false, refusal: 'FFmpeg failed the chain-flac-s16 self-test', selfTest: { ...info().selfTest, status: 'failed', failedTest: 'chain-flac-s16' } })
    })
    await shown()
    await press(SETUP_WORDS.download)
    expect(screen.getByRole('alert')).toHaveTextContent('The downloaded FFmpeg did not pass its checks')
    expect(screen.getByRole('alert')).toHaveTextContent('Failed test: Stereo limiter chain to 16-bit FLAC.')
    expect(useAppStore.getState().ffmpegReady).toBe(false)
  })

  it('ignores a second start while one runs', async () =>
  {
    api = stub()
    const install = deferred<FfmpegInstallResult>()
    api.installPinnedFFmpeg.mockReturnValueOnce(install.promise)
    await shown()
    await press(SETUP_WORDS.download)
    await press(SETUP_WORDS.downloading)
    await press(SETUP_WORDS.useExisting)
    expect(api.installPinnedFFmpeg).toHaveBeenCalledOnce()
    expect(api.chooseFFmpegFolder).not.toHaveBeenCalled()
    await act(async () =>
    {
      install.resolve({ ok: true, info: info() })
    })
  })
})

describe('SetupWizard, an FFmpeg already on this computer', () =>
{
  it('does nothing when the folder picker is canceled', async () =>
  {
    api = stub()
    await shown()
    await press(SETUP_WORDS.useExisting)
    expect(api.chooseFFmpegFolder).toHaveBeenCalledOnce()
    expect(api.adoptFFmpegFolder).not.toHaveBeenCalled()
    expect(screen.getByText(SETUP_WORDS.required)).toBeInTheDocument()
  })

  it('self-tests the chosen folder, then opens the done screen with the chosen build', async () =>
  {
    api = stub()
    const check = deferred<FfmpegFolderResult>()
    api.chooseFFmpegFolder!.mockResolvedValueOnce('D:\\Tools\\ffmpeg')
    api.adoptFFmpegFolder!.mockReturnValueOnce(check.promise)
    await shown()
    await press(SETUP_WORDS.useExisting)
    expect(api.adoptFFmpegFolder).toHaveBeenCalledWith('D:\\Tools\\ffmpeg')
    expect(screen.getByRole('progressbar', { name: 'Checking FFmpeg' })).toBeInTheDocument()
    expect(screen.getByText('D:\\Tools\\ffmpeg')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SETUP_WORDS.checkingFolder })).toBeInTheDocument()
    expect(primary()).toHaveAttribute('aria-disabled', 'true')
    await press(SETUP_WORDS.download)
    expect(api.installPinnedFFmpeg).not.toHaveBeenCalled()

    await act(async () =>
    {
      check.resolve({ status: 'adopted', info: info({ version: '8.0.1', source: 'custom' }) })
    })
    expect(screen.getByText('molexMedia will use FFmpeg 8.0.1, which passed its self-test.')).toBeInTheDocument()
    expect(screen.getByText('Chosen by you')).toBeInTheDocument()
    expect(useAppStore.getState().ffmpegVersion).toBe('8.0.1')
  })

  it('explains a refused folder and offers another', async () =>
  {
    api = stub()
    api.chooseFFmpegFolder!.mockResolvedValue('D:\\Old')
    api.adoptFFmpegFolder!.mockResolvedValueOnce({ status: 'refused', folder: 'D:\\Old', reason: 'minimum', version: '4.4.2', failedTest: null })
    await shown()
    await press(SETUP_WORDS.useExisting)
    expect(screen.getByRole('alert')).toHaveTextContent('FFmpeg 4.4.2 is too old')
    expect(screen.getByRole('alert')).toHaveTextContent('D:\\Old')
    expect(screen.getByText('Not used')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: SETUP_WORDS.details })).toBeNull()

    api.adoptFFmpegFolder!.mockResolvedValueOnce({ status: 'refused', folder: 'D:\\Old', reason: 'self-test', version: '7.0', failedTest: 'encoders' })
    await press(SETUP_WORDS.chooseAnother)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed test: Required encoders.')

    api.adoptFFmpegFolder!.mockRejectedValueOnce(new Error('No handler registered'))
    await press(SETUP_WORDS.chooseAnother)
    expect(screen.getByRole('alert')).toHaveTextContent('Setup stopped')
  })

  it('offers a passing FFmpeg on PATH as the choice, adopting its folder without a picker', async () =>
  {
    api = stub({ ...MISSING, pathBuild: { version: '2022-10-13-git-9e8a327e68-full_build-www.gyan.dev', ffmpegPath: 'C:\\ffmpeg\\bin\\ffmpeg.exe' } })
    api.adoptFFmpegFolder!.mockResolvedValueOnce({ status: 'adopted', info: info({ version: '2022-10-13-git-9e8a327e68-full_build-www.gyan.dev', source: 'custom' }) })
    await shown()
    expect(screen.getByText('An FFmpeg development build from 2022-10-13 is already on this computer, in C:\\ffmpeg\\bin. It passed the self-test, and molexMedia uses it only if you choose it.')).toBeInTheDocument()
    expect(primary()).toHaveFocus()
    expect(screen.queryByRole('button', { name: SETUP_WORDS.useExisting })).toBeNull()
    await press(SETUP_WORDS.chooseFolder)
    expect(api.chooseFFmpegFolder).toHaveBeenCalledOnce()
    await press(SETUP_WORDS.useFound)
    expect(api.chooseFFmpegFolder).toHaveBeenCalledOnce()
    expect(api.adoptFFmpegFolder).toHaveBeenCalledWith('C:\\ffmpeg\\bin')
    expect(screen.getByRole('heading', { level: 1, name: SETUP_WORDS.doneTitle })).toBeInTheDocument()
  })

  it('offers no folder path on a preload without it', async () =>
  {
    api = stub()
    delete api.chooseFFmpegFolder
    await shown()
    await press(SETUP_WORDS.useExisting)
    expect(screen.getByText(SETUP_WORDS.required)).toBeInTheDocument()
  })
})

describe('SetupWizard, keyboard', () =>
{
  it('runs the primary action on Enter from the page, and only once from the focused button', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockReturnValue(new Promise(() => undefined))
    await shown()
    await act(async () =>
    {
      fireEvent.keyDown(document.body, { key: 'Enter' })
    })
    expect(api.installPinnedFFmpeg).toHaveBeenCalledOnce()
    await act(async () =>
    {
      fireEvent.keyDown(primary(SETUP_WORDS.downloading), { key: 'Enter' })
    })
    expect(api.installPinnedFFmpeg).toHaveBeenCalledOnce()
  })

  it('leaves Enter alone with a modifier or while a dialog is open', async () =>
  {
    api = stub()
    await shown()
    await act(async () =>
    {
      fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true })
    })
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.append(dialog)
    await act(async () =>
    {
      fireEvent.keyDown(document.body, { key: 'Enter' })
    })
    dialog.remove()
    expect(api.installPinnedFFmpeg).not.toHaveBeenCalled()
  })

  it('returns focus to the primary action and folds the details on Escape', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: false, error: 'x', info: MISSING, problem: { kind: 'stalled', status: null, detail: 'The download stalled' } })
    await shown()
    await press(SETUP_WORDS.download)
    const details = screen.getByRole('button', { name: SETUP_WORDS.details })
    fireEvent.click(details)
    details.focus()
    act(() =>
    {
      fireEvent.keyDown(details, { key: 'Escape' })
    })
    expect(primary(SETUP_WORDS.retry)).toHaveFocus()
    expect(details).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens Batch on Enter from the done screen', async () =>
  {
    api = stub()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: true, info: info() })
    await shown()
    await press(SETUP_WORDS.download)
    await act(async () =>
    {
      fireEvent.keyDown(document.body, { key: 'Enter' })
    })
    expect(useAppStore.getState()).toMatchObject({ currentView: 'batch', showSetup: false })
  })
})

describe('setup lines', () =>
{
  it('words the done line by where the build came from', () =>
  {
    expect(doneLine({ version: '9.0.2', source: 'bundled' })).toBe('FFmpeg 9.0.2 is installed and passed its self-test.')
    expect(doneLine({ version: null, source: 'path' })).toBe('molexMedia will use FFmpeg, which passed its self-test.')
  })

  it('shows startup looking for FFmpeg with a working bar', () =>
  {
    render(<StartupCheck />)
    expect(screen.getByText(`${SETUP_WORDS.checkingStart}.`)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: SETUP_WORDS.checkingStart })).not.toHaveAttribute('aria-valuenow')
  })
})
