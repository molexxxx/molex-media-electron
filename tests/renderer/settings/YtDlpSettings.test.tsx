/**
 * Settings, Application, yt-dlp: the version and how it stays current in plain words, when it was last checked,
 * the updater's live activity and failures with Try again, Check for updates or Download yt-dlp through
 * ytdlp:checkUpdates, the "Update yt-dlp automatically" switch, and the "Use the yt-dlp found on this computer"
 * switch with the version PATH holds. A copy on PATH in use is reported as managed elsewhere, with no update row.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { YtDlpStatus } from '../../../src/shared/ipc/api'
import
{
  YTDLP_WORDS,
  YtDlpSettings,
  activityLine,
  checkedWhen,
  detailLine,
  failureNotice,
  summaryLine,
  systemRowHint
} from '../../../src/renderer/src/components/settings/tabs/YtDlpSettings'

const NOW = new Date(2026, 9, 20, 15, 30).getTime()
const APP_PATH = 'C:\\Users\\you\\AppData\\Roaming\\molex-media\\ytdlp-bin\\yt-dlp.exe'
const SYSTEM_PATH = 'C:\\Python\\Scripts\\yt-dlp.exe'

function status(overrides: Partial<YtDlpStatus> = {}): YtDlpStatus
{
  return {
    installed: true,
    version: '2026.08.19',
    source: 'app',
    path: APP_PATH,
    autoUpdate: true,
    useSystem: false,
    onPath: null,
    lastCheckAt: new Date(2026, 9, 20, 9, 0).getTime(),
    latest: null,
    state: { kind: 'idle' },
    ...overrides
  }
}

/** The status while the copy on PATH is in use. */
function systemStatus(overrides: Partial<YtDlpStatus> = {}): YtDlpStatus
{
  return status({ source: 'system', path: SYSTEM_PATH, useSystem: true, onPath: { path: SYSTEM_PATH, version: '2026.08.19' }, ...overrides })
}

interface FakeApi
{
  getYtDlpStatus: ReturnType<typeof vi.fn>
  checkYtDlpUpdates: ReturnType<typeof vi.fn>
  onYtDlpStatus: ReturnType<typeof vi.fn>
  push: ((next: YtDlpStatus) => void) | null
  unsubscribe: ReturnType<typeof vi.fn>
}

let api: FakeApi

function install(initial: YtDlpStatus): void
{
  api = {
    getYtDlpStatus: vi.fn(async () => initial),
    checkYtDlpUpdates: vi.fn(async () => initial),
    onYtDlpStatus: vi.fn((cb: (next: YtDlpStatus) => void) =>
    {
      api.push = cb
      return api.unsubscribe
    }),
    push: null,
    unsubscribe: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = api
}

interface Handlers
{
  onAuto: ReturnType<typeof vi.fn>
  onSystem: ReturnType<typeof vi.fn>
}

function renderSection(autoUpdate = true, useSystem = false): Handlers & { view: ReturnType<typeof render> }
{
  const onAuto = vi.fn()
  const onSystem = vi.fn()
  const view = render(<YtDlpSettings autoUpdate={autoUpdate} onAutoUpdateChange={onAuto} useSystem={useSystem} onUseSystemChange={onSystem} />)
  return { onAuto, onSystem, view }
}

beforeEach(() =>
{
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() =>
{
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('the words', () =>
{
  it('says when the last check was in plain days', () =>
  {
    expect(checkedWhen(null, NOW)).toBe('Not checked yet.')
    expect(checkedWhen(new Date(2026, 9, 20, 0, 5).getTime(), NOW)).toBe('Last checked today.')
    expect(checkedWhen(new Date(2026, 9, 19, 23, 50).getTime(), NOW)).toBe('Last checked yesterday.')
    expect(checkedWhen(new Date(2026, 9, 14, 12, 0).getTime(), NOW)).toBe('Last checked Oct 14.')
    expect(checkedWhen(NOW + 60_000, NOW)).toBe('Last checked today.')
  })

  it('names the version and how it stays current', () =>
  {
    expect(summaryLine(status(), true)).toBe('yt-dlp 2026.08.19, updated automatically.')
    expect(summaryLine(status(), false)).toBe('yt-dlp 2026.08.19. Automatic updates are off.')
    expect(summaryLine(systemStatus(), true)).toBe('yt-dlp 2026.08.19, managed outside molexMedia.')
    expect(summaryLine(systemStatus({ version: null }), true)).toBe('yt-dlp, managed outside molexMedia.')
    expect(summaryLine(status({ version: null }), true)).toBe('yt-dlp is installed, but it did not report its version.')
    expect(summaryLine(status({ installed: false, version: null, source: null, path: null }), true)).toBe(YTDLP_WORDS.missing)
  })

  it('explains where a copy on PATH is, what a missing copy downloads, and when the app copy was checked', () =>
  {
    expect(detailLine(systemStatus({ path: '/usr/bin/yt-dlp' }), NOW)).toBe(`Found on PATH at /usr/bin/yt-dlp. ${YTDLP_WORDS.managedHint}`)
    const missing = status({ installed: false, version: null, source: null, path: null })
    expect(detailLine(missing, NOW)).toBe(YTDLP_WORDS.missingHint)
    expect(detailLine({ ...missing, latest: { version: '2026.08.19', bytes: 17_840_399 } }, NOW)).toBe(`${YTDLP_WORDS.missingHint} The download is 17.8 MB.`)
    expect(detailLine(status(), NOW)).toBe('Last checked today.')
    expect(detailLine(status({ version: null }), NOW)).toBe('Last checked today. Check for updates to replace it.')
  })

  it('tells what PATH holds under the switch for it', () =>
  {
    expect(systemRowHint({ onPath: null })).toBe(YTDLP_WORDS.noneOnPath)
    expect(systemRowHint({ onPath: { path: SYSTEM_PATH, version: '2026.07.04' } })).toBe(`Found yt-dlp 2026.07.04 at ${SYSTEM_PATH}. ${YTDLP_WORDS.useSystemNote}`)
    expect(systemRowHint({ onPath: { path: SYSTEM_PATH, version: null } })).toBe(`Found ${SYSTEM_PATH}, but it did not report its version. ${YTDLP_WORDS.useSystemNote}`)
  })

  it('describes each step of the updater', () =>
  {
    const updating = (phase: 'downloading' | 'verifying' | 'waiting') => status({ state: { kind: 'updating', phase, version: '2026.09.01', receivedBytes: 1, totalBytes: 2 } })
    expect(activityLine(status({ state: { kind: 'checking' } }))).toBe(YTDLP_WORDS.checkingLine)
    expect(activityLine(updating('downloading'))).toBe('Downloading yt-dlp 2026.09.01.')
    expect(activityLine(updating('verifying'))).toBe('Verifying yt-dlp 2026.09.01.')
    expect(activityLine(updating('waiting'))).toBe('yt-dlp 2026.09.01 is ready. It takes over as soon as no link is loading.')
    expect(activityLine(status({ state: { kind: 'up-to-date' } }))).toBe(YTDLP_WORDS.upToDate)
    expect(activityLine(status({ state: { kind: 'updated', from: '2026.07.04', to: '2026.08.19' } }))).toBe('Updated from 2026.07.04 to 2026.08.19.')
    expect(activityLine(status({ state: { kind: 'updated', from: null, to: '2026.08.19' } }))).toBe('Installed yt-dlp 2026.08.19.')
    expect(activityLine(status({ latest: { version: '2026.09.01', bytes: null } }))).toBe('yt-dlp 2026.09.01 is available.')
    expect(activityLine(status({ latest: { version: '2026.08.19', bytes: null } }))).toBeNull()
    expect(activityLine(systemStatus({ latest: { version: '2026.09.01', bytes: null } }))).toBeNull()
    expect(activityLine(status({ state: { kind: 'failed', problem: 'offline', reason: 'r', at: 1 } }))).toBeNull()
  })

  it('names a failure and what keeps working, never for a copy on PATH', () =>
  {
    const failed = { kind: 'failed' as const, problem: 'checksum' as const, reason: 'The download did not match.', at: 1 }
    expect(failureNotice(status({ state: failed }))).toEqual({ title: 'yt-dlp did not update', text: 'The download did not match. molexMedia keeps using 2026.08.19.' })
    expect(failureNotice(status({ state: failed, version: null }))).toEqual({ title: 'yt-dlp did not update', text: 'The download did not match.' })
    expect(failureNotice(status({ state: failed, installed: false, version: null, source: null }))).toEqual({ title: 'yt-dlp was not downloaded', text: 'The download did not match.' })
    expect(failureNotice(systemStatus({ state: failed }))).toBeNull()
    expect(failureNotice(status())).toBeNull()
  })
})

describe('YtDlpSettings', () =>
{
  it('shows the app copy, when it was checked, and both switches', async () =>
  {
    install(status())
    const { onAuto, onSystem } = renderSection()
    expect(screen.getByText(YTDLP_WORDS.loading)).toBeInTheDocument()
    expect(await screen.findByText('yt-dlp 2026.08.19, updated automatically.')).toBeInTheDocument()
    expect(screen.getByText('Last checked today.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'yt-dlp' })).toBeInTheDocument()
    const auto = screen.getByRole('switch', { name: YTDLP_WORDS.autoLabel })
    expect(auto).toHaveAttribute('aria-checked', 'true')
    expect(auto).toHaveAccessibleDescription(YTDLP_WORDS.autoHint)
    fireEvent.click(auto)
    expect(onAuto).toHaveBeenCalledWith(false)
    const system = screen.getByRole('switch', { name: YTDLP_WORDS.useSystemLabel })
    expect(system).toHaveAttribute('aria-checked', 'false')
    expect(system).toHaveAccessibleDescription(YTDLP_WORDS.noneOnPath)
    fireEvent.click(system)
    expect(onSystem).toHaveBeenCalledWith(true)
  })

  it('names the version PATH holds while the app copy stays in use', async () =>
  {
    install(status({ onPath: { path: SYSTEM_PATH, version: '2026.07.04' } }))
    renderSection()
    expect(await screen.findByText('yt-dlp 2026.08.19, updated automatically.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: YTDLP_WORDS.useSystemLabel })).toHaveAccessibleDescription(`Found yt-dlp 2026.07.04 at ${SYSTEM_PATH}. ${YTDLP_WORDS.useSystemNote}`)
    expect(screen.getByRole('button', { name: YTDLP_WORDS.check })).toBeInTheDocument()
  })

  it('checks for updates and announces the outcome', async () =>
  {
    install(status())
    api.checkYtDlpUpdates.mockResolvedValue(status({ state: { kind: 'updated', from: '2026.08.19', to: '2026.09.01' }, version: '2026.09.01' }))
    const { view } = renderSection()
    fireEvent.click(await screen.findByRole('button', { name: YTDLP_WORDS.check }))
    await waitFor(() => expect(api.checkYtDlpUpdates).toHaveBeenCalledWith())
    await waitFor(() => expect(screen.getAllByText('Updated from 2026.08.19 to 2026.09.01.')).toHaveLength(2))
    expect(view.container.querySelector('p.sr-only[role="status"]')).toHaveTextContent('Updated from 2026.08.19 to 2026.09.01.')
    expect(screen.getByText('yt-dlp 2026.09.01, updated automatically.')).toBeInTheDocument()
  })

  it('follows the pushed status through download progress, and stops listening when it closes', async () =>
  {
    install(status())
    const { view } = renderSection()
    await screen.findByText('yt-dlp 2026.08.19, updated automatically.')
    act(() => api.push!(status({ state: { kind: 'updating', phase: 'downloading', version: '2026.09.01', receivedBytes: 5, totalBytes: 10 } })))
    const bar = screen.getByRole('progressbar', { name: 'Downloading yt-dlp 2026.09.01' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('button', { name: /Updating/ })).toBeInTheDocument()
    act(() => api.push!(status({ state: { kind: 'updating', phase: 'downloading', version: '2026.09.01', receivedBytes: 5, totalBytes: null } })))
    expect(screen.getByRole('progressbar', { name: 'Downloading yt-dlp 2026.09.01' })).not.toHaveAttribute('aria-valuenow')
    act(() => api.push!(status({ state: { kind: 'updating', phase: 'waiting', version: '2026.09.01', receivedBytes: 10, totalBytes: 10 } })))
    expect(screen.getByText('yt-dlp 2026.09.01 is ready. It takes over as soon as no link is loading.')).toBeInTheDocument()
    view.unmount()
    expect(api.unsubscribe).toHaveBeenCalled()
  })

  it('keeps a pushed status over a slower first read', async () =>
  {
    let answer!: (value: YtDlpStatus) => void
    install(status())
    api.getYtDlpStatus.mockReturnValue(new Promise((resolve) =>
    {
      answer = resolve
    }))
    renderSection()
    act(() => api.push!(status({ state: { kind: 'checking' } })))
    await act(async () => answer(status({ version: '2025.01.01' })))
    expect(screen.getByText(YTDLP_WORDS.checkingLine)).toBeInTheDocument()
    expect(screen.queryByText(/2025\.01\.01/)).toBeNull()
  })

  it('offers the download with its size when yt-dlp is not installed', async () =>
  {
    install(status({ installed: false, version: null, source: null, path: null, latest: { version: '2026.08.19', bytes: 17_840_399 }, lastCheckAt: null }))
    renderSection()
    const download = await screen.findByRole('button', { name: 'Download yt-dlp (17.8 MB)' })
    expect(screen.getByText(YTDLP_WORDS.missing)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: YTDLP_WORDS.autoLabel })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: YTDLP_WORDS.useSystemLabel })).toBeInTheDocument()
    fireEvent.click(download)
    await waitFor(() => expect(api.checkYtDlpUpdates).toHaveBeenCalled())
  })

  it('names a failure, what keeps working, and offers Try again', async () =>
  {
    install(status({ state: { kind: 'failed', problem: 'offline', reason: 'molexMedia could not reach GitHub. Check your internet connection, then try again.', at: 1 } }))
    renderSection(false)
    expect(await screen.findByText('yt-dlp 2026.08.19. Automatic updates are off.')).toBeInTheDocument()
    expect(screen.getByText('yt-dlp did not update')).toBeInTheDocument()
    expect(screen.getByText(/could not reach GitHub.*molexMedia keeps using 2026\.08\.19\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: YTDLP_WORDS.tryAgain }))
    await waitFor(() => expect(api.checkYtDlpUpdates).toHaveBeenCalledTimes(1))
  })

  it('reports a copy on PATH in use as managed elsewhere, with only the switch to stop using it', async () =>
  {
    install(systemStatus())
    const { onSystem } = renderSection(true, true)
    expect(await screen.findByText('yt-dlp 2026.08.19, managed outside molexMedia.')).toBeInTheDocument()
    expect(screen.getByText(/Found on PATH at C:\\Python\\Scripts\\yt-dlp\.exe\./)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('switch', { name: YTDLP_WORDS.autoLabel })).toBeNull()
    const system = screen.getByRole('switch', { name: YTDLP_WORDS.useSystemLabel })
    expect(system).toHaveAttribute('aria-checked', 'true')
    expect(system).toHaveAccessibleDescription(`Found yt-dlp 2026.08.19 at ${SYSTEM_PATH}. ${YTDLP_WORDS.useSystemNote}`)
    fireEvent.click(system)
    expect(onSystem).toHaveBeenCalledWith(false)
  })

  it('says so when the status cannot be read', async () =>
  {
    ;(window as unknown as { api: unknown }).api = { checkForUpdates: vi.fn() }
    renderSection()
    expect(screen.getByText(YTDLP_WORDS.unreadable)).toBeInTheDocument()

    install(status())
    api.getYtDlpStatus.mockRejectedValue(new Error('no handler'))
    renderSection()
    await waitFor(() => expect(screen.getAllByText(YTDLP_WORDS.unreadable)).toHaveLength(2))
  })

  it('reports a check that throws', async () =>
  {
    install(status())
    api.checkYtDlpUpdates.mockRejectedValue(new Error('no handler'))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: YTDLP_WORDS.check }))
    expect(await screen.findByText(YTDLP_WORDS.unreadable)).toBeInTheDocument()
  })
})
