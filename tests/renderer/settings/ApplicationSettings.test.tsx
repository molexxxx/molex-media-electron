/**
 * Settings, Application: the Updates section with its startup switch, the version row's check, download, and
 * install actions and their plain-word status; the Window switches (`minimizeToTray`, `showTrayNotification`,
 * `sidebarCollapsed`); Accessibility with Interface size (`interfaceScale`) and the progress digest
 * (`announceProgress`); the YouTube cookies browser choice with its close-the-browser confirmation and the saved
 * cookies row; the project page; and the reset behind an inline confirmation.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  APPLICATION_WORDS,
  ApplicationSettings,
  AUTO_BROWSER,
  INTERFACE_SIZES,
  PROJECT_URL,
  agoWords,
  browserLabel,
  cookiesLine,
  installRefusal,
  interfaceSizeOptions,
  updateLine
} from '../../../src/renderer/src/components/settings/tabs/ApplicationSettings'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import type { AppConfig } from '../../../src/renderer/src/stores/types'

const BROWSERS = [{ name: 'chrome', label: 'Google Chrome' }, { name: 'firefox', label: 'Firefox' }]
const HOUR_MS = 60 * 60 * 1000

interface FakeApi
{
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  installUpdate: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  getInstalledBrowsers: ReturnType<typeof vi.fn>
  getCookieInfo: ReturnType<typeof vi.fn>
  setCookieBrowser: ReturnType<typeof vi.fn>
  clearCookies: ReturnType<typeof vi.fn>
  getYtDlpStatus: ReturnType<typeof vi.fn>
  checkYtDlpUpdates: ReturnType<typeof vi.fn>
  onYtDlpStatus: ReturnType<typeof vi.fn>
}

let api: FakeApi

function config(overrides: Partial<AppConfig> = {}): AppConfig
{
  return {
    autoUpdate: true,
    minimizeToTray: true,
    showTrayNotification: true,
    sidebarCollapsed: false,
    showNotifications: true,
    ffmpegPath: '',
    ffprobePath: '',
    ytdlpBrowser: '',
    ytdlpAutoUpdate: true,
    ytdlpUseSystem: false,
    interfaceScale: 100,
    announceProgress: false,
    ...overrides
  } as AppConfig
}

function renderTab(overrides: Partial<AppConfig> = {}, partial = false): { onUpdate: ReturnType<typeof vi.fn>; onReset: ReturnType<typeof vi.fn> }
{
  const onUpdate = vi.fn()
  const onReset = vi.fn()
  const value = config(overrides)
  if (partial)
  {
    delete (value as Partial<AppConfig>).interfaceScale
    delete (value as Partial<AppConfig>).announceProgress
    delete (value as Partial<AppConfig>).sidebarCollapsed
  }
  render(<ApplicationSettings config={value} onUpdate={onUpdate} onResetDefaults={onReset} />)
  return { onUpdate, onReset }
}

function region(name: string): HTMLElement
{
  return screen.getByRole('region', { name })
}

function setUpdate(state: Partial<ReturnType<typeof useAppStore.getState>>): void
{
  act(() => useAppStore.setState(state))
}

beforeEach(() =>
{
  api = {
    checkForUpdates: vi.fn(async () => ({ success: true })),
    downloadUpdate: vi.fn(async () => ({ success: true })),
    installUpdate: vi.fn(async () => ({ ok: true })),
    openExternal: vi.fn(async () => undefined),
    getInstalledBrowsers: vi.fn(async () => BROWSERS),
    getCookieInfo: vi.fn(async () => ({ exists: false, age: null, browser: '' })),
    setCookieBrowser: vi.fn(async () => ({ success: true })),
    clearCookies: vi.fn(async () => ({ success: true })),
    getYtDlpStatus: vi.fn(() => new Promise(() => undefined)),
    checkYtDlpUpdates: vi.fn(),
    onYtDlpStatus: vi.fn(() => () => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  useAppStore.setState({ updateStatus: 'idle', updateVersion: null, updateError: null, updateDownloadPercent: 0, sidebarCollapsed: false })
})

afterEach(() =>
{
  delete (window as unknown as { api?: unknown }).api
})

describe('the words', () =>
{
  it('offers 90, 100, 110, 125, 150, 175, and 200 percent, keeping a stored size outside the list', () =>
  {
    expect([...INTERFACE_SIZES]).toEqual([90, 100, 110, 125, 150, 175, 200])
    expect(interfaceSizeOptions(100).map((o) => o.label)).toEqual(['90%', '100%', '110%', '125%', '150%', '175%', '200%'])
    expect(interfaceSizeOptions(130).map((o) => o.value)).toEqual(['90', '100', '110', '125', '130', '150', '175', '200'])
    expect(interfaceSizeOptions(Number.NaN)).toHaveLength(7)
  })

  it('reports each update status in plain words, and nothing while idle, checking, or downloading', () =>
  {
    expect(updateLine('up-to-date', '2.3.1')).toBe(APPLICATION_WORDS.latest)
    expect(updateLine('available', '2.4.0')).toBe('molexMedia 2.4.0 is available.')
    expect(updateLine('available', null)).toBe(APPLICATION_WORDS.available)
    expect(updateLine('downloaded', '2.4.0')).toBe(APPLICATION_WORDS.ready)
    expect(updateLine('manual', null)).toBe(APPLICATION_WORDS.manual)
    for (const status of ['idle', 'checking', 'downloading', 'error'] as const)
    {
      expect(updateLine(status, '2.4.0')).toBeNull()
    }
  })

  it('reads the message of an install the updater held back, and nothing from one that went ahead', () =>
  {
    expect(installRefusal({ ok: false, reason: 'batch-running', message: 'An update is ready. It installs when the current jobs finish.', whenIdle: false }))
      .toBe('An update is ready. It installs when the current jobs finish.')
    expect(installRefusal({ ok: true })).toBeNull()
    expect(installRefusal(undefined)).toBeNull()
    expect(installRefusal({ ok: false })).toBeNull()
  })

  it('says how long ago in minutes, hours, or days', () =>
  {
    expect(agoWords(null)).toBe('some time ago')
    expect(agoWords(-5)).toBe('some time ago')
    expect(agoWords(20_000)).toBe('less than a minute ago')
    expect(agoWords(60_000)).toBe('1 minute ago')
    expect(agoWords(12 * 60_000)).toBe('12 minutes ago')
    expect(agoWords(3 * HOUR_MS + 5 * 60_000)).toBe('3 hours ago')
    expect(agoWords(49 * HOUR_MS)).toBe('2 days ago')
  })

  it('describes the saved cookies, naming the browser by its label when known', () =>
  {
    expect(cookiesLine(null, BROWSERS)).toBe(APPLICATION_WORDS.none)
    expect(cookiesLine({ exists: false, age: null, browser: '' }, BROWSERS)).toBe(APPLICATION_WORDS.none)
    expect(cookiesLine({ exists: true, age: 3 * HOUR_MS, browser: 'chrome' }, BROWSERS)).toBe('Exported 3 hours ago from Google Chrome. Exported again after 7 days.')
    expect(cookiesLine({ exists: true, age: 3 * HOUR_MS, browser: 'brave' }, BROWSERS)).toBe('Exported 3 hours ago from brave. Exported again after 7 days.')
    expect(cookiesLine({ exists: true, age: null, browser: '' }, [])).toBe('Exported some time ago. Exported again after 7 days.')
    expect(browserLabel(BROWSERS, 'firefox')).toBe('Firefox')
    expect(browserLabel([], 'firefox')).toBe('firefox')
  })
})

describe('the sections', () =>
{
  it('shows each section under a legend, with the yt-dlp section under Updates and no Paths or Notifications', () =>
  {
    renderTab()
    const legends = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(legends).toEqual(['Updates', 'yt-dlp', 'Window', 'Accessibility', 'YouTube cookies', 'About', 'Defaults'])
    for (const heading of screen.getAllByRole('heading', { level: 2 }))
    {
      expect(heading).toHaveClass('type-legend', 'text-accent-ink')
    }
    expect(screen.queryByText(/Paths|FFprobe|Notifications|Window Behavior/)).toBeNull()
  })
})

describe('Updates', () =>
{
  it('writes autoUpdate from the startup switch and names the version that runs', () =>
  {
    const { onUpdate } = renderTab()
    const startup = within(region('Updates')).getByRole('switch', { name: APPLICATION_WORDS.autoLabel })
    expect(startup).toHaveAttribute('aria-checked', 'true')
    expect(startup).toHaveAccessibleDescription(APPLICATION_WORDS.autoHint)
    fireEvent.click(startup)
    expect(onUpdate).toHaveBeenCalledWith('autoUpdate', false)
    expect(within(region('Updates')).getByText('molexMedia 0.0.0-test')).toBeInTheDocument()
  })

  it('checks for updates, showing Checking while the updater answers', async () =>
  {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.check }))
    expect(useAppStore.getState().updateStatus).toBe('checking')
    expect(screen.getByRole('button', { name: APPLICATION_WORDS.checking })).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names a failed check and leaves a manual answer to the broadcast status', async () =>
  {
    api.checkForUpdates.mockResolvedValueOnce({ success: false, error: 'molexMedia could not reach GitHub.' })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.check }))
    expect(await screen.findByRole('alert')).toHaveTextContent('molexMedia could not reach GitHub.')
    expect(useAppStore.getState().updateStatus).toBe('error')

    api.checkForUpdates.mockResolvedValueOnce({ success: false, manual: true })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.check }))
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledTimes(2))
    expect(useAppStore.getState().updateStatus).toBe('checking')
  })

  it('says you have the latest version, and offers the download when one is available', async () =>
  {
    renderTab()
    setUpdate({ updateStatus: 'up-to-date', updateVersion: '0.0.0-test' })
    expect(within(region('Updates')).getByText(APPLICATION_WORDS.latest)).toBeInTheDocument()

    setUpdate({ updateStatus: 'available', updateVersion: '2.4.0' })
    expect(within(region('Updates')).getByText('molexMedia 2.4.0 is available.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download 2.4.0' }))
    await waitFor(() => expect(api.downloadUpdate).toHaveBeenCalledTimes(1))
  })

  it('shows the download as a progress bar, then Install and restart, and the message of an install held back', async () =>
  {
    renderTab()
    setUpdate({ updateStatus: 'downloading', updateVersion: '2.4.0', updateDownloadPercent: 40 })
    expect(screen.getByRole('progressbar', { name: 'Downloading molexMedia 2.4.0' })).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByRole('button', { name: APPLICATION_WORDS.downloading })).toHaveAttribute('aria-busy', 'true')

    setUpdate({ updateStatus: 'downloaded', updateVersion: '2.4.0' })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(within(region('Updates')).getByText(APPLICATION_WORDS.ready)).toBeInTheDocument()
    api.installUpdate.mockResolvedValueOnce({ ok: false, reason: 'batch-running', message: 'An update is ready. It installs when the current jobs finish.', whenIdle: false })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.install }))
    expect(await within(region('Updates')).findByText('An update is ready. It installs when the current jobs finish.')).toBeInTheDocument()
    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('names a download that did not finish', async () =>
  {
    api.downloadUpdate.mockResolvedValueOnce({ success: false })
    renderTab()
    setUpdate({ updateStatus: 'available', updateVersion: '2.4.0' })
    fireEvent.click(screen.getByRole('button', { name: 'Download 2.4.0' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(APPLICATION_WORDS.downloadFailed)
  })
})

describe('Window', () =>
{
  it('turns the close confirmation off with the tray, and hides its row while the tray is off', () =>
  {
    const { onUpdate } = renderTab()
    const window = region('Window')
    expect(within(window).getByRole('switch', { name: APPLICATION_WORDS.askLabel })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(window).getByRole('switch', { name: APPLICATION_WORDS.trayLabel }))
    expect(onUpdate).toHaveBeenCalledWith('minimizeToTray', false)
    expect(onUpdate).toHaveBeenCalledWith('showTrayNotification', false)
  })

  it('leaves the close confirmation alone when the tray turns on, and shows no confirmation row while it is off', () =>
  {
    const { onUpdate } = renderTab({ minimizeToTray: false, showTrayNotification: false })
    const window = region('Window')
    expect(within(window).queryByRole('switch', { name: APPLICATION_WORDS.askLabel })).toBeNull()
    fireEvent.click(within(window).getByRole('switch', { name: APPLICATION_WORDS.trayLabel }))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith('minimizeToTray', true)
  })

  it('writes showTrayNotification and sidebarCollapsed, collapsing the sidebar at once', () =>
  {
    const { onUpdate } = renderTab({}, true)
    const window = region('Window')
    fireEvent.click(within(window).getByRole('switch', { name: APPLICATION_WORDS.askLabel }))
    expect(onUpdate).toHaveBeenCalledWith('showTrayNotification', false)
    const sidebar = within(window).getByRole('switch', { name: APPLICATION_WORDS.sidebarLabel })
    expect(sidebar).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sidebar)
    expect(onUpdate).toHaveBeenCalledWith('sidebarCollapsed', true)
    expect(useAppStore.getState().sidebarCollapsed).toBe(true)
  })
})

describe('Accessibility', () =>
{
  it('shows the Interface size setting and writes interfaceScale in percent', () =>
  {
    const { onUpdate } = renderTab({ interfaceScale: 125 })
    const size = within(region('Accessibility')).getByRole('combobox', { name: 'Interface size' }) as HTMLSelectElement
    expect(size.value).toBe('125')
    expect(size).toHaveAccessibleDescription(/Ctrl\+0 returns to this size/)
    fireEvent.change(size, { target: { value: '175' } })
    expect(onUpdate).toHaveBeenCalledWith('interfaceScale', 175)
  })

  it('offers the progress digest switch, off by default, and writes announceProgress', () =>
  {
    const { onUpdate } = renderTab({}, true)
    const digest = within(region('Accessibility')).getByRole('switch', { name: APPLICATION_WORDS.announceLabel })
    expect(digest).toHaveAttribute('aria-checked', 'false')
    expect(digest).toHaveAccessibleDescription(/focus is in Batch/)
    fireEvent.click(digest)
    expect(onUpdate).toHaveBeenCalledWith('announceProgress', true)
    expect((within(region('Accessibility')).getByRole('combobox', { name: 'Interface size' }) as HTMLSelectElement).value).toBe('100')
  })

  it('shows the digest on when the config has it on and turns it off', () =>
  {
    const { onUpdate } = renderTab({ announceProgress: true })
    const digest = within(region('Accessibility')).getByRole('switch', { name: APPLICATION_WORDS.announceLabel })
    expect(digest).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(digest)
    expect(onUpdate).toHaveBeenCalledWith('announceProgress', false)
  })
})

describe('YouTube cookies', () =>
{
  async function browserSelect(): Promise<HTMLSelectElement>
  {
    await screen.findByRole('option', { name: 'Google Chrome' })
    return within(region('YouTube cookies')).getByRole('combobox', { name: 'Browser' }) as HTMLSelectElement
  }

  it('lists the installed browsers after Detect automatically, and writes an empty browser for it', async () =>
  {
    const { onUpdate } = renderTab({ ytdlpBrowser: 'firefox' })
    const select = await browserSelect()
    expect(select.value).toBe('firefox')
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([APPLICATION_WORDS.autoDetect, 'Google Chrome', 'Firefox'])
    fireEvent.change(select, { target: { value: AUTO_BROWSER } })
    expect(onUpdate).toHaveBeenCalledWith('ytdlpBrowser', '')
    expect(api.setCookieBrowser).not.toHaveBeenCalled()
  })

  it('asks to close the browser first, and Cancel changes nothing', async () =>
  {
    const { onUpdate } = renderTab()
    const select = await browserSelect()
    fireEvent.change(select, { target: { value: 'chrome' } })
    expect(screen.getByText(/Close Google Chrome, then continue/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.cancel }))
    expect(screen.queryByText(/Close Google Chrome/)).toBeNull()
    expect(api.setCookieBrowser).not.toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('exports the cookies on Continue, saves the browser, and rereads the saved cookies', async () =>
  {
    api.getCookieInfo.mockResolvedValueOnce({ exists: false, age: null, browser: '' }).mockResolvedValueOnce({ exists: true, age: 30_000, browser: 'chrome' })
    const { onUpdate } = renderTab()
    const select = await browserSelect()
    fireEvent.change(select, { target: { value: 'chrome' } })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.continue }))
    expect(screen.getByText('Exporting cookies from Google Chrome.')).toBeInTheDocument()
    expect(select).toBeDisabled()
    expect(await screen.findByText(APPLICATION_WORDS.exported)).toBeInTheDocument()
    expect(api.setCookieBrowser).toHaveBeenCalledWith('chrome')
    expect(onUpdate).toHaveBeenCalledWith('ytdlpBrowser', 'chrome')
    expect(await screen.findByText('Exported less than a minute ago from Google Chrome. Exported again after 7 days.')).toBeInTheDocument()
  })

  it('names an export that failed, from the answer or from a throw', async () =>
  {
    api.setCookieBrowser.mockResolvedValueOnce({ success: false, error: 'Firefox is still running.' })
    renderTab()
    const select = await browserSelect()
    fireEvent.change(select, { target: { value: 'firefox' } })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.continue }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Firefox is still running.')

    api.setCookieBrowser.mockRejectedValueOnce(new Error('no handler'))
    fireEvent.change(select, { target: { value: 'chrome' } })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.continue }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no handler'))

    api.setCookieBrowser.mockResolvedValueOnce({ success: false })
    fireEvent.change(select, { target: { value: 'chrome' } })
    fireEvent.click(screen.getByRole('button', { name: APPLICATION_WORDS.continue }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(APPLICATION_WORDS.exportFailed))
  })

  it('clears the saved cookies and the browser choice, and disables Clear while there are none', async () =>
  {
    api.getCookieInfo.mockResolvedValue({ exists: true, age: 2 * 24 * HOUR_MS, browser: 'firefox' })
    const { onUpdate } = renderTab({ ytdlpBrowser: 'firefox' })
    expect(await screen.findByText('Exported 2 days ago from Firefox. Exported again after 7 days.')).toBeInTheDocument()
    const clear = screen.getByRole('button', { name: APPLICATION_WORDS.clear })
    expect(clear).toBeEnabled()
    fireEvent.click(clear)
    await waitFor(() => expect(api.clearCookies).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith('ytdlpBrowser', '')
    expect(await screen.findByText(APPLICATION_WORDS.none)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: APPLICATION_WORDS.clear })).toBeDisabled()
  })
})

describe('About and Defaults', () =>
{
  it('opens the project page', () =>
  {
    renderTab()
    fireEvent.click(within(region('About')).getByRole('button', { name: APPLICATION_WORDS.openGitHub }))
    expect(api.openExternal).toHaveBeenCalledWith(PROJECT_URL)
  })

  it('resets only after the inline confirmation, and Keep leaves everything', () =>
  {
    const { onReset } = renderTab()
    const defaults = region('Defaults')
    fireEvent.click(within(defaults).getByRole('button', { name: APPLICATION_WORDS.reset }))
    expect(within(defaults).getByText(APPLICATION_WORDS.resetQuestion)).toBeInTheDocument()
    fireEvent.click(within(defaults).getByRole('button', { name: APPLICATION_WORDS.keep }))
    expect(onReset).not.toHaveBeenCalled()
    fireEvent.click(within(defaults).getByRole('button', { name: APPLICATION_WORDS.reset }))
    fireEvent.click(within(defaults).getByRole('button', { name: APPLICATION_WORDS.resetConfirm }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(within(defaults).getByRole('button', { name: APPLICATION_WORDS.reset })).toBeInTheDocument()
  })
})
