/**
 * @module main/updater
 * @description Auto-update lifecycle powered by electron-updater.
 *
 * Uses GitHub Releases as the update source.  Respects the `autoUpdate`
 * config flag — when disabled, updates are only checked on explicit user
 * request via IPC.  All update events are forwarded to every renderer
 * window so the UI can show progress / prompts.
 */

import { autoUpdater } from 'electron-updater'
import { app, ipcMain } from 'electron'
import { logger } from './logger'
import { getConfig } from './config'
import { sendToAll } from './ipc/helpers'

/** Initialise the updater: wire events, register IPC, optionally auto-check. */
export async function initUpdater(): Promise<void> {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null // we handle logging ourselves

  // In dev mode, use dev-app-update.yml so checkForUpdates doesn't hang
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  // --- Forward events to renderer ---
  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates…')
    sendToAll('updater:status', { status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: v${info.version}`)
    sendToAll('updater:status', { status: 'available', version: info.version, releaseNotes: info.releaseNotes })
  })

  autoUpdater.on('update-not-available', (info) => {
    logger.info(`App is up to date (v${info.version})`)
    sendToAll('updater:status', { status: 'up-to-date', version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToAll('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`Update downloaded: v${info.version}`)
    sendToAll('updater:status', { status: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    logger.error(`Update error: ${err.message}`)
    sendToAll('updater:status', { status: 'error', error: err.message })
  })

  // --- IPC handlers ---
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

  // --- Auto-check on startup if enabled ---
  const config = await getConfig()
  if (config.autoUpdate) {
    // Small delay so the window is ready to receive events
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5_000)
  }
}
