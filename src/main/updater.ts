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
import { logger } from './logger'
import { sendToAll } from './ipc/helpers'

/** Initialise the updater: wire events, register IPC, optionally auto-check. */
export async function initUpdater(): Promise<void> {
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

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  // --- Auto-check on startup (always, regardless of autoUpdate setting) ---
  // Small delay so the window is ready to receive events
  setTimeout(async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Silently fail - user can retry manually
    }
  }, 5_000)
}
