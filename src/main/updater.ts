/**
 * @module main/updater
 * @description Auto-update lifecycle powered by electron-updater.
 *
 * Uses GitHub Releases as the update source.  Respects the `autoUpdate`
 * config flag - when disabled, updates are only checked on explicit user
 * request via IPC.  All update events are forwarded to every renderer
 * window so the UI can show progress / prompts.
 */

import { autoUpdater } from 'electron-updater'
import { app, ipcMain } from 'electron'
import { getConfigSync } from './config'
import { logger } from './logger'
import { sendToAll } from './ipc/helpers'
import { APP_NAME, updateWaitingText } from './jobs/status'
import type { RunId } from '../shared/jobs/ids'
import type { UpdateInstallResult } from '../shared/ipc/api'

/** How often an install armed for when the engine is idle checks again. */
export const IDLE_INSTALL_POLL_MS = 5_000

/** How long after launch the startup check runs, so the window is ready for its events. */
export const STARTUP_CHECK_DELAY_MS = 5_000

/** What `updater:install` returns: installing, or refused while the engine is busy. */
export type InstallResult = UpdateInstallResult

/** What the updater reads from the app lifecycle. */
export interface UpdaterOptions {
  /** Whether the job engine is busy, and the run that keeps it busy. */
  busy(): { busy: boolean; runId: RunId | null }
  /** The async shutdown that flushes the job journal; it runs before the installer closes the windows. */
  beforeInstall(): Promise<void>
}

/** The notice while a busy engine holds the update back. */
export function waitingText(runId: RunId | null): string {
  return runId === null ? 'An update is ready. It installs when the current jobs finish.' : updateWaitingText(runId)
}

/** Initialize the updater: wire events, register IPC, optionally auto-check. */
export async function initUpdater(options: UpdaterOptions): Promise<void> {
  // electron-updater can only self-update NSIS (Windows) and the zipped .app
  // (macOS, via Squirrel.Mac). The Linux build ships as .deb/.rpm, which are
  // managed by the system package manager and have no in-app update path, so
  // we surface a "manual" status instead of letting checks throw.
  const isLinux = process.platform === 'linux'

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.disableWebInstaller = false
  autoUpdater.logger = null // handle logging ourselves

  // In dev mode, use dev-app-update.yml so checkForUpdates doesn't hang
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  // Cache last status so renderers can query it after reload
  let lastStatus: Record<string, unknown> = { status: 'idle' }
  const broadcast = (payload: Record<string, unknown>): void => {
    lastStatus = payload
    sendToAll('updater:status', payload)
  }

  // --- Forward events to renderer ---
  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates…')
    broadcast({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: v${info.version}`)
    broadcast({ status: 'available', version: info.version, releaseNotes: info.releaseNotes })
  })

  autoUpdater.on('update-not-available', (info) => {
    logger.info(`App is up to date (v${info.version})`)
    broadcast({ status: 'up-to-date', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      status: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`Update downloaded: v${info.version}`)
    broadcast({ status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    logger.error(`Update error: ${err.message}`)
    broadcast({ status: 'error', error: err.message })
  })

  // --- IPC handlers ---
  ipcMain.handle('updater:get-status', () => lastStatus)
  ipcMain.handle('updater:check', async () => {
    if (isLinux) {
      broadcast({ status: 'manual' })
      return { success: false, manual: true }
    }
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Update check timed out')), 15_000)
      )
      const result = await Promise.race([autoUpdater.checkForUpdates(), timeout])
      return { success: true, version: result?.updateInfo?.version }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  let idleInstall: ReturnType<typeof setInterval> | null = null
  let installing = false

  // Electron closes every window before before-quit in this path, so the engine shuts down first
  const install = async (): Promise<InstallResult> => {
    if (installing) return { ok: true }
    installing = true
    try {
      await options.beforeInstall()
      autoUpdater.quitAndInstall(false, true)
      return { ok: true }
    } catch (err: any) {
      installing = false
      logger.error(`Could not install the update: ${err?.message ?? String(err)}`)
      return { ok: false, reason: 'failed', message: `${APP_NAME} could not install the update: ${err?.message ?? String(err)}` }
    }
  }

  const armIdleInstall = (): void => {
    if (idleInstall !== null) return
    idleInstall = setInterval(() => {
      if (options.busy().busy) return
      if (idleInstall !== null) clearInterval(idleInstall)
      idleInstall = null
      logger.info('The batch finished; installing the update')
      void install()
    }, IDLE_INSTALL_POLL_MS)
  }

  ipcMain.handle('updater:install', async (_event, request?: { whenIdle?: boolean }): Promise<InstallResult> => {
    const state = options.busy()
    if (state.busy) {
      const whenIdle = request?.whenIdle === true
      if (whenIdle) armIdleInstall()
      logger.info(`Update install held back: ${waitingText(state.runId)}`)
      return { ok: false, reason: 'batch-running', message: waitingText(state.runId), whenIdle }
    }
    return install()
  })

  // --- Check on startup, unless Settings turned it off; a Linux install always reports manual ---
  setTimeout(async () => {
    if (isLinux) {
      broadcast({ status: 'manual' })
      return
    }
    if (getConfigSync().autoUpdate === false) {
      logger.info('Startup update check skipped: automatic updates are off')
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Silently fail - user can retry manually
    }
  }, STARTUP_CHECK_DELAY_MS)
}
