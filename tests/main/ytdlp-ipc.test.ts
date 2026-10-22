/**
 * The yt-dlp update channels and the app's updater instance: `ytdlp:status` and `ytdlp:checkUpdates` reach the
 * updater, status changes go to every window, saving the setting announces it, and the app instance reads its
 * setting and stored state from config and its folder from the user data path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as Array<[string, unknown]>
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app') },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => electron.handlers.set(channel, fn) },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => electron.sent.push([channel, payload]) } }]
  }
}))

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }
}))

const config = vi.hoisted(() => ({
  userData: '',
  current: { ytdlpAutoUpdate: true, ytdlpUseSystem: false, ytdlp: { lastCheckAt: 123, installed: null, lastFailure: null } } as Record<string, unknown>,
  saved: [] as unknown[],
  listeners: [] as Array<(config: unknown, saved: Record<string, unknown>) => void>
}))

vi.mock('../../src/main/config', () => ({
  getConfig: async () => config.current,
  saveConfig: async (partial: Record<string, unknown>) =>
  {
    config.saved.push(partial)
    config.current = { ...config.current, ...partial }
    return config.current
  },
  getUserDataPath: () => config.userData
}))

vi.mock('../../src/main/ipc/config', () => ({
  onConfigSaved: (listener: (config: unknown, saved: Record<string, unknown>) => void) => config.listeners.push(listener)
}))

const { registerYtDlpUpdateIPC } = await import('../../src/main/ipc/ytdlp-updates')
const { ytDlpUpdater, startYtDlpUpdates } = await import('../../src/main/ytdlp/updater')

describe('yt-dlp update IPC', () =>
{
  let root: string
  let savedPath: string | undefined

  beforeEach(() =>
  {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-ipc-'))
    config.userData = root
    savedPath = process.env.PATH
    process.env.PATH = path.join(root, 'empty')
  })

  afterEach(() =>
  {
    ytDlpUpdater().stop()
    process.env.PATH = savedPath
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('registers the status and check channels on the app updater', async () =>
  {
    registerYtDlpUpdateIPC()
    expect([...electron.handlers.keys()].sort()).toEqual(['ytdlp:checkUpdates', 'ytdlp:status'])
    expect(ytDlpUpdater()).toBe(ytDlpUpdater())

    const status = await electron.handlers.get('ytdlp:status')!({}) as Record<string, unknown>
    expect(status).toMatchObject({ installed: false, source: null, autoUpdate: true, useSystem: false, onPath: null, lastCheckAt: 123, state: { kind: 'idle' } })

    const check = vi.spyOn(ytDlpUpdater(), 'check').mockResolvedValue(status as never)
    await electron.handlers.get('ytdlp:checkUpdates')!({}, { install: false })
    await electron.handlers.get('ytdlp:checkUpdates')!({}, undefined)
    await electron.handlers.get('ytdlp:checkUpdates')!({}, { install: 'no' })
    expect(check.mock.calls.map((call) => call[0])).toEqual([{ install: false }, { install: true }, { install: true }])
    check.mockRestore()
  })

  it('sends status changes to the windows when the setting is saved', async () =>
  {
    const changed = vi.spyOn(ytDlpUpdater(), 'settingsChanged')
    for (const listener of config.listeners)
    {
      listener({}, { interfaceScale: 110 })
    }
    expect(changed).not.toHaveBeenCalled()
    config.current = { ...config.current, ytdlpAutoUpdate: false }
    for (const listener of config.listeners)
    {
      listener({}, { ytdlpAutoUpdate: false })
    }
    expect(changed).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(electron.sent.some(([channel, payload]) => channel === 'ytdlp:status-changed' && (payload as { autoUpdate: boolean }).autoUpdate === false)).toBe(true))
    config.current = { ...config.current, ytdlpUseSystem: true }
    for (const listener of config.listeners)
    {
      listener({}, { ytdlpUseSystem: true })
    }
    expect(changed).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(electron.sent.some(([channel, payload]) => channel === 'ytdlp:status-changed' && (payload as { useSystem: boolean }).useSystem === true)).toBe(true))
    config.current = { ...config.current, ytdlpUseSystem: false }
    changed.mockRestore()
  })

  it('starts the automatic checks once and finds the app copy in the user data folder', async () =>
  {
    startYtDlpUpdates()
    startYtDlpUpdates()
    const bin = path.join(root, 'ytdlp-bin')
    fs.mkdirSync(bin, { recursive: true })
    const exe = path.join(bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    fs.writeFileSync(exe, 'x')
    const stat = fs.statSync(exe)
    config.current = { ...config.current, ytdlp: { lastCheckAt: 5, installed: { version: '2026.08.19', size: stat.size, mtimeMs: stat.mtimeMs }, lastFailure: null } }
    await expect(ytDlpUpdater().status()).resolves.toMatchObject({ installed: true, source: 'app', path: exe, version: '2026.08.19' })
    await expect(ytDlpUpdater().ensure()).resolves.toBe(exe)
  })
})
