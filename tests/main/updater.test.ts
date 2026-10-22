/**
 * The updater's startup check: it runs after the delay while `autoUpdate` is on, stays away while Settings turned
 * it off, and on Linux only reports the manual status, whatever the setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const autoUpdater = {
  on: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowDowngrade: true,
  disableWebInstaller: true,
  forceDevUpdateConfig: false,
  logger: {}
}
const sendToAll = vi.fn()
const config = { autoUpdate: true }

vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: vi.fn() } }))
vi.mock('../../src/main/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../../src/main/ipc/helpers', () => ({ sendToAll: (...args: unknown[]) => sendToAll(...args) }))
vi.mock('../../src/main/jobs/status', () => ({ APP_NAME: 'molexMedia', updateWaitingText: (runId: string) => `waiting for ${runId}` }))
vi.mock('../../src/main/config', () => ({ getConfigSync: () => config }))

const { initUpdater, STARTUP_CHECK_DELAY_MS } = await import('../../src/main/updater')

const options = {
  busy: () => ({ busy: false, runId: null }),
  beforeInstall: async () => undefined
}

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void
{
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() =>
{
  vi.useFakeTimers()
  config.autoUpdate = true
  setPlatform('win32')
})

afterEach(() =>
{
  vi.useRealTimers()
  vi.clearAllMocks()
  setPlatform(realPlatform)
})

describe('the startup check', () =>
{
  it('runs after the delay while automatic updates are on', async () =>
  {
    await initUpdater(options)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('stays away while Settings turned automatic updates off', async () =>
  {
    config.autoUpdate = false
    await initUpdater(options)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS * 2)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(sendToAll).not.toHaveBeenCalled()
  })

  it('reports a Linux install as updated by hand, whatever the setting', async () =>
  {
    setPlatform('linux')
    config.autoUpdate = false
    await initUpdater(options)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(sendToAll).toHaveBeenCalledWith('updater:status', { status: 'manual' })
  })

  it('swallows a failed startup check so the owner can retry from Settings', async () =>
  {
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    await initUpdater(options)
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(sendToAll).not.toHaveBeenCalledWith('updater:status', expect.objectContaining({ status: 'error' }))
  })
})
