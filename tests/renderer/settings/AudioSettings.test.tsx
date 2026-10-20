/**
 * Settings, FFmpeg: the build facts from ffmpeg:info, the self-test result and time, Re-run self-test through
 * ffmpeg:selfTest, and Install the tested build through ffmpeg:installPinned only when the bundled build differs from
 * the pin or none was found. No loudness or encoding value is offered.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FfmpegInfo, FfmpegInstallResult } from '../../../src/shared/ipc/api'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import
{
  FFMPEG_WORDS,
  FfmpegSettings,
  SELF_TEST_LABELS,
  minimumLine,
  offersInstall,
  selfTestResult,
  sourceLabel,
  surroundMeterNote,
  testedWhen
} from '../../../src/renderer/src/components/settings/tabs/AudioSettings'
import SetupWizard, { SETUP_WORDS, pinBytes, selfTestLine, setupLine } from '../../../src/renderer/src/components/setup/SetupWizard'

const TESTED_AT = new Date(2026, 9, 20, 11, 2).getTime()

const ALL_PASSED = { 'chain-flac-s16': true, 'chain-opus-51side': true, 'chain-aac-mono': true, 'meter-dual-mono': true, 'meter-surround': true, 'soxr': true, 'encoders': true }

const SURROUND_NOTE = 'This build measures surround loudness incorrectly, so Normalize and Gain do not run on surround files. Stereo and mono files are not affected.'

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
    selfTest: { status: 'passed', failedTest: null, results: ALL_PASSED, testedAt: TESTED_AT, durationMs: 1400 },
    refusal: null,
    pin: { version: '9.0.2', matches: true, offerInstall: false, installLabel: 'Install FFmpeg 9.0.x (tested with this version)' },
    ...overrides
  }
}

interface FakeApi
{
  getFFmpegInfo: ReturnType<typeof vi.fn>
  rerunFFmpegSelfTest: ReturnType<typeof vi.fn>
  installPinnedFFmpeg: ReturnType<typeof vi.fn>
  onDownloadProgress: ReturnType<typeof vi.fn>
  saveConfig: ReturnType<typeof vi.fn>
  progress: ((p: { stage?: string; message?: string; percent?: number }) => void) | null
  unsubscribe: ReturnType<typeof vi.fn>
}

let api: FakeApi

function fakeApi(first: FfmpegInfo): FakeApi
{
  const fake: FakeApi = {
    getFFmpegInfo: vi.fn(async () => first),
    rerunFFmpegSelfTest: vi.fn(async () => first),
    installPinnedFFmpeg: vi.fn(),
    onDownloadProgress: vi.fn(),
    saveConfig: vi.fn(),
    progress: null,
    unsubscribe: vi.fn()
  }
  fake.onDownloadProgress.mockImplementation((cb: FakeApi['progress']) =>
  {
    fake.progress = cb
    return fake.unsubscribe
  })
  return fake
}

async function renderSection(first: FfmpegInfo = info()): Promise<void>
{
  api = fakeApi(first)
  vi.stubGlobal('api', api)
  render(<FfmpegSettings />)
  await waitFor(() => expect(screen.queryByText(FFMPEG_WORDS.loading)).toBeNull())
}

beforeEach(() =>
{
  useAppStore.setState({ ffmpegReady: false, ffmpegVersion: '' })
})

afterEach(() =>
{
  cleanup()
  vi.unstubAllGlobals()
})

describe('FFmpeg section helpers', () =>
{
  it('names each source in plain words', () =>
  {
    expect(sourceLabel('bundled')).toBe('Installed by molexMedia')
    expect(sourceLabel('path')).toBe('Found on PATH')
    expect(sourceLabel('custom')).toBe('Chosen by you')
    expect(sourceLabel(null)).toBe(FFMPEG_WORDS.notFound)
  })

  it('writes when the self-test ran and how long it took', () =>
  {
    expect(testedWhen(TESTED_AT, 1400)).toBe('Oct 20, 11:02, in 1.4 s')
    expect(testedWhen(TESTED_AT, null)).toBe('Oct 20, 11:02')
    expect(testedWhen(null, 1400)).toBeNull()
  })

  it('reads the self-test result, naming the failing test', () =>
  {
    expect(selfTestResult(info().selfTest)).toEqual({ tone: 'passed', text: 'Passed' })
    expect(selfTestResult({ ...info().selfTest, status: 'failed', failedTest: 'soxr' })).toEqual({ tone: 'failed', text: `Failed: ${SELF_TEST_LABELS.soxr}` })
    expect(selfTestResult({ ...info().selfTest, status: 'failed', failedTest: null }).text).toBe('Failed')
    expect(selfTestResult({ ...info().selfTest, status: 'not-run' }).text).toBe('Not run')
    expect(selfTestResult({ ...info().selfTest, status: null }).tone).toBe('not-run')
  })

  it('explains a surround meter that misreads only when the self-test ran', () =>
  {
    const misreads = { ...info().selfTest, results: { ...ALL_PASSED, 'meter-surround': false } }
    expect(SELF_TEST_LABELS['meter-surround']).toBe('Surround loudness meter')
    expect(surroundMeterNote(info().selfTest)).toBeNull()
    expect(surroundMeterNote(misreads)).toBe(SURROUND_NOTE)
    expect(surroundMeterNote({ ...misreads, status: 'failed', failedTest: 'encoders' })).toBe(SURROUND_NOTE)
    expect(surroundMeterNote({ ...misreads, status: 'not-run' })).toBeNull()
    expect(surroundMeterNote({ ...misreads, status: null })).toBeNull()
    expect(surroundMeterNote({ ...misreads, results: null })).toBeNull()
  })

  it('says whether the minimum is met', () =>
  {
    expect(minimumLine(info())).toBe(FFMPEG_WORDS.met)
    expect(minimumLine(info({ meetsMinimum: false }))).toBe('Below the minimum version')
    expect(minimumLine(info({ found: false }))).toBe(FFMPEG_WORDS.notFound)
  })

  it('offers the tested build only when the bundled build differs from the pin or none was found', () =>
  {
    expect(offersInstall(info())).toBe(false)
    expect(offersInstall(info({ pin: { ...info().pin, matches: false, offerInstall: true } }))).toBe(true)
    expect(offersInstall(info({ found: false }))).toBe(true)
    expect(offersInstall(info({ source: 'path', pin: { ...info().pin, matches: false, offerInstall: false } }))).toBe(false)
  })
})

describe('FfmpegSettings', () =>
{
  it('shows the version, source, location, libsoxr, minimum, and the self-test result with its time', async () =>
  {
    await renderSection()
    expect(api.getFFmpegInfo).toHaveBeenCalledTimes(1)
    expect(screen.getByText('9.0.2')).toBeInTheDocument()
    expect(screen.getByText('Installed by molexMedia')).toBeInTheDocument()
    expect(screen.getByText(/btbn-n9\.0\.2-17-g2a571b6068\\ffmpeg\.exe/)).toBeInTheDocument()
    expect(screen.getByText(FFMPEG_WORDS.soxr).nextSibling).toHaveTextContent(FFMPEG_WORDS.yes)
    expect(screen.getByText(FFMPEG_WORDS.minimum).nextSibling).toHaveTextContent(FFMPEG_WORDS.met)
    expect(screen.getByText('Passed')).toBeInTheDocument()
    expect(screen.getByText('Oct 20, 11:02, in 1.4 s')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Install FFmpeg/ })).toBeNull()
  })

  it('folds each test result under its toggle', async () =>
  {
    await renderSection(info({ selfTest: { ...info().selfTest, status: 'failed', failedTest: 'soxr', results: { ...ALL_PASSED, soxr: false } } }))
    expect(screen.getByText(`Failed: ${SELF_TEST_LABELS.soxr}`)).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: FFMPEG_WORDS.details })
    const list = document.getElementById(toggle.getAttribute('aria-controls') as string) as HTMLElement
    expect(list).not.toBeVisible()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(list).toBeVisible()
    expect(list).toHaveTextContent(`${SELF_TEST_LABELS.soxr}failed`)
    expect(list).toHaveTextContent(`${SELF_TEST_LABELS.encoders}passed`)
  })

  it('lists the surround meter with the other tests and explains its failure beside a passed self-test', async () =>
  {
    await renderSection(info({ selfTest: { ...info().selfTest, results: { ...ALL_PASSED, 'meter-surround': false } } }))
    expect(screen.getByText('Passed')).toBeInTheDocument()
    expect(screen.getByText(SURROUND_NOTE)).toBeInTheDocument()
    expect(screen.queryByText(/FFmpeg is not ready/)).toBeNull()
    const toggle = screen.getByRole('button', { name: FFMPEG_WORDS.details })
    fireEvent.click(toggle)
    const list = document.getElementById(toggle.getAttribute('aria-controls') as string) as HTMLElement
    expect(list).toHaveTextContent(`${SELF_TEST_LABELS['meter-surround']}failed`)
    expect(list).toHaveTextContent(`${SELF_TEST_LABELS['meter-dual-mono']}passed`)
    expect(list.querySelectorAll('li')).toHaveLength(Object.keys(ALL_PASSED).length)
  })

  it('shows no surround note when the surround meter passed', async () =>
  {
    await renderSection()
    expect(screen.queryByText(SURROUND_NOTE)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: FFMPEG_WORDS.details }))
    expect(screen.getByText(SELF_TEST_LABELS['meter-surround']).nextSibling).toHaveTextContent('passed')
  })

  it('re-runs the self-test through ffmpeg:selfTest and shows the new result', async () =>
  {
    await renderSection(info({ selfTest: { status: 'not-run', failedTest: null, results: null, testedAt: null, durationMs: null } }))
    expect(screen.getByText('Not run')).toBeInTheDocument()
    api.rerunFFmpegSelfTest.mockResolvedValueOnce(info())
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: FFMPEG_WORDS.rerun }))
    })
    expect(api.rerunFFmpegSelfTest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Passed')).toBeInTheDocument()
    expect(screen.getByText('Self-test passed.')).toBeInTheDocument()
    expect(useAppStore.getState().ffmpegReady).toBe(true)
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('reports a self-test that could not run', async () =>
  {
    await renderSection()
    api.rerunFFmpegSelfTest.mockRejectedValueOnce(new Error('spawn failed'))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: FFMPEG_WORDS.rerun }))
    })
    expect(screen.getByText(FFMPEG_WORDS.unreadable)).toBeInTheDocument()
  })

  it('states why FFmpeg is not ready', async () =>
  {
    await renderSection(info({ usable: false, meetsMinimum: false, refusal: 'FFmpeg 4.4 is below the minimum version 5.1' }))
    expect(screen.getByText('FFmpeg is not ready: FFmpeg 4.4 is below the minimum version 5.1. Jobs cannot start.')).toBeInTheDocument()
    expect(screen.getByText('Below the minimum version')).toBeInTheDocument()
  })

  it('installs the tested build through ffmpeg:installPinned with progress when the bundled build differs from the pin', async () =>
  {
    const older = info({ version: '8.0.1', pin: { version: '9.0.2', matches: false, offerInstall: true, installLabel: 'Install FFmpeg 9.0.x (tested with this version)' } })
    await renderSection(older)
    let finish: (result: FfmpegInstallResult) => void = () => undefined
    api.installPinnedFFmpeg.mockReturnValueOnce(new Promise<FfmpegInstallResult>((resolve) =>
    {
      finish = resolve
    }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Install FFmpeg 9.0.x (tested with this version)' }))
    })
    expect(api.installPinnedFFmpeg).toHaveBeenCalledTimes(1)
    act(() => api.progress?.({ stage: 'download', message: 'Downloading FFmpeg', percent: 40 }))
    expect(screen.getByRole('progressbar', { name: 'Downloading FFmpeg' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: FFMPEG_WORDS.rerun })).toBeDisabled()
    await act(async () =>
    {
      finish({ ok: true, info: info() })
    })
    expect(api.unsubscribe).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('9.0.2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Install FFmpeg/ })).toBeNull()
    expect(screen.getByText('Installed FFmpeg 9.0.2. Self-test passed.')).toBeInTheDocument()
  })

  it('shows the error of a failed install and keeps the offer', async () =>
  {
    const missing = info({ found: false, usable: false, version: null, versionString: null, source: null, ffmpegPath: null, ffprobePath: null, libsoxr: false, meetsMinimum: false, selfTest: { status: null, failedTest: null, results: null, testedAt: null, durationMs: null } })
    await renderSection(missing)
    expect(screen.getAllByText(FFMPEG_WORDS.notFound).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: FFMPEG_WORDS.rerun })).toBeDisabled()
    api.installPinnedFFmpeg.mockResolvedValueOnce({ ok: false, error: 'Download did not match the expected checksum', info: missing })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: /Install FFmpeg/ }))
    })
    expect(screen.getByText('Download did not match the expected checksum')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Install FFmpeg/ })).toBeEnabled()
    api.installPinnedFFmpeg.mockRejectedValueOnce(new Error('Network unreachable'))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: /Install FFmpeg/ }))
    })
    expect(screen.getByText('Network unreachable')).toBeInTheDocument()
  })

  it('says the build could not be read when ffmpeg:info fails or the preload is missing', async () =>
  {
    api = fakeApi(info())
    api.getFFmpegInfo.mockRejectedValueOnce(new Error('no handler'))
    vi.stubGlobal('api', api)
    render(<FfmpegSettings />)
    expect(await screen.findByText(FFMPEG_WORDS.unreadable)).toBeInTheDocument()
    cleanup()
    vi.stubGlobal('api', undefined)
    render(<FfmpegSettings />)
    expect(screen.getByText(FFMPEG_WORDS.unreadable)).toBeInTheDocument()
  })

  it('offers no loudness or codec field anywhere in the section', async () =>
  {
    api = fakeApi(info())
    vi.stubGlobal('api', api)
    const { container } = render(<FfmpegSettings />)
    expect(await screen.findByText('Installed by molexMedia')).toBeInTheDocument()
    expect(container.querySelectorAll('input, select, [role="spinbutton"], [role="slider"]')).toHaveLength(0)
    expect(screen.queryByText(/Integrated|True peak|Loudness range|Bitrate|Codec|LUFS/i)).toBeNull()
  })
})

describe('SetupWizard', () =>
{
  interface WizardApi
  {
    getFFmpegInfo: ReturnType<typeof vi.fn>
    downloadFFmpeg: ReturnType<typeof vi.fn>
    checkFFmpeg: ReturnType<typeof vi.fn>
    loadConfig: ReturnType<typeof vi.fn>
  }

  let wizard: WizardApi

  function stubWizard(first: FfmpegInfo | Error): void
  {
    wizard = {
      getFFmpegInfo: vi.fn(async () =>
      {
        if (first instanceof Error)
        {
          throw first
        }
        return first
      }),
      downloadFFmpeg: vi.fn(),
      checkFFmpeg: vi.fn(async () => ({ found: false })),
      loadConfig: vi.fn(async () => ({ outputDir: 'D:\\Exports' }))
    }
    vi.stubGlobal('api', wizard)
  }

  const MISSING = info({ found: false, usable: false, version: null, source: null, selfTest: { status: null, failedTest: null, results: null, testedAt: null, durationMs: null } })

  beforeEach(() =>
  {
    useAppStore.setState({ showSetup: true, downloadProgress: null })
  })

  it('writes the consequence line with the version and size when known', () =>
  {
    expect(setupLine('9.0.2', 194_034_585)).toBe('Downloads FFmpeg 9.0.2, about 194 MB, and checks its SHA-256.')
    expect(setupLine('9.0.2', null)).toBe('Downloads FFmpeg 9.0.2 and checks its SHA-256.')
    expect(setupLine(null, null)).toBe('Downloads FFmpeg and checks its SHA-256.')
  })

  it('reads the download size from the build information when it carries one', () =>
  {
    expect(pinBytes(info().pin)).toBeNull()
    expect(pinBytes({ ...info().pin, downloadBytes: 194_034_585 } as FfmpegInfo['pin'])).toBe(194_034_585)
  })

  it('writes the self-test line with its time', () =>
  {
    expect(selfTestLine(info())).toEqual({ tone: 'passed', text: 'Self-test passed, Oct 20, 11:02, in 1.4 s.' })
    expect(selfTestLine(MISSING)).toEqual({ tone: 'not-run', text: 'Self-test not run.' })
    expect(selfTestLine(info({ selfTest: { ...info().selfTest, status: 'failed', failedTest: 'encoders' } })).text).toBe(`Self-test failed: ${SELF_TEST_LABELS.encoders}, Oct 20, 11:02, in 1.4 s.`)
  })

  it('states the version, size, and checksum before the download, with the same steps and buttons', async () =>
  {
    stubWizard({ ...MISSING, pin: { ...MISSING.pin, downloadBytes: 194_034_585 } as FfmpegInfo['pin'] })
    render(<SetupWizard />)
    expect(await screen.findByText('Downloads FFmpeg 9.0.2, about 194 MB, and checks its SHA-256.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SETUP_WORDS.download })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SETUP_WORDS.have })).toBeInTheDocument()
  })

  it('downloads, then shows the build and its self-test result', async () =>
  {
    stubWizard(MISSING)
    let finish: (value: unknown) => void = () => undefined
    wizard.downloadFFmpeg.mockReturnValueOnce(new Promise((resolve) =>
    {
      finish = resolve
    }))
    render(<SetupWizard />)
    await screen.findByText('Downloads FFmpeg 9.0.2 and checks its SHA-256.')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.download }))
    })
    expect(screen.getByRole('progressbar', { name: SETUP_WORDS.settingUp })).toBeInTheDocument()
    act(() => useAppStore.setState({ downloadProgress: { stage: 'download', message: 'Downloading FFmpeg', percent: 30 } }))
    expect(screen.getByRole('progressbar', { name: 'Downloading FFmpeg' })).toBeInTheDocument()
    wizard.getFFmpegInfo.mockResolvedValueOnce(info())
    await act(async () =>
    {
      finish({ success: true, version: 'n9.0.2-17-g2a571b6068' })
    })
    expect(screen.getByText(`${SETUP_WORDS.doneTitle}: 9.0.2`)).toBeInTheDocument()
    expect(screen.getByText('Self-test passed, Oct 20, 11:02, in 1.4 s.')).toBeInTheDocument()
    expect(useAppStore.getState().ffmpegReady).toBe(true)
    expect(useAppStore.getState().ffmpegVersion).toBe('9.0.2')
    fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.start }))
    expect(useAppStore.getState().showSetup).toBe(false)
  })

  it('shows why a ready build cannot run jobs', async () =>
  {
    stubWizard(MISSING)
    wizard.downloadFFmpeg.mockResolvedValueOnce({ success: true, version: 'n9.0.2' })
    render(<SetupWizard />)
    await screen.findByText('Downloads FFmpeg 9.0.2 and checks its SHA-256.')
    wizard.getFFmpegInfo.mockResolvedValueOnce(info({ selfTest: { ...info().selfTest, status: 'failed', failedTest: 'soxr' }, refusal: 'the self-test failed' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.download }))
    })
    expect(screen.getByText(/Self-test failed: SoX resampler/)).toBeInTheDocument()
    expect(screen.getByText('FFmpeg is not ready: the self-test failed. Jobs cannot start.')).toBeInTheDocument()
  })

  it('shows a failed download with Retry and I have it', async () =>
  {
    stubWizard(new Error('no handler'))
    wizard.downloadFFmpeg.mockResolvedValueOnce({ success: false, error: 'Download did not match the expected checksum' })
    render(<SetupWizard />)
    expect(screen.getByText('Downloads FFmpeg and checks its SHA-256.')).toBeInTheDocument()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.download }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Download did not match the expected checksum')
    expect(screen.getByRole('button', { name: SETUP_WORDS.have })).toBeInTheDocument()
    wizard.downloadFFmpeg.mockResolvedValueOnce({ success: false })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.retry }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(SETUP_WORDS.unknownError)
    wizard.downloadFFmpeg.mockRejectedValueOnce(new Error('Network unreachable'))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.retry }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable')
  })

  it('closes on I have it only when FFmpeg is found', async () =>
  {
    stubWizard(MISSING)
    render(<SetupWizard />)
    await screen.findByText('Downloads FFmpeg 9.0.2 and checks its SHA-256.')
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.have }))
    })
    expect(useAppStore.getState().showSetup).toBe(true)
    wizard.checkFFmpeg.mockResolvedValueOnce({ found: true, version: 'n8.0.1' })
    wizard.getFFmpegInfo.mockResolvedValueOnce(info({ version: '8.0.1', source: 'path' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.have }))
    })
    expect(useAppStore.getState().showSetup).toBe(false)
    expect(useAppStore.getState().ffmpegVersion).toBe('8.0.1')
    expect(wizard.loadConfig).toHaveBeenCalled()
  })
})
