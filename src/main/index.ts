/**
 * @module main/index
 * @description Electron main process entry point.
 *
 * Orchestrates app lifecycle events (ready, activate, window-all-closed,
 * before-quit), registers IPC handlers, and wires together the protocol,
 * tray, and window sub-modules.
 */

import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIPC } from './ipc'
import { loadConfig } from './config'
import { logger } from './logger'
import { killAllProcesses } from './ffmpeg/runner'
import { cleanupPlaybackTemp } from './ffmpeg/playback'
import { cleanupAudioCache } from './ytdlp'
import { initFFmpegDir } from './ytdlp/binary'
import { registerMediaScheme, registerMediaHandler } from './protocol'
import { createTray, destroyTray, hasTray, setTrayCallbacks } from './tray'
import { initUpdater } from './updater'
import {
  createWindow,
  showMainWindow,
  showPopout,
  registerGlobalIPC,
  isQuitting,
  setQuitting
} from './windows'

// Re-export for IPC helpers (they import updateTrayProgress from here)
export { updateTrayProgress } from './tray'

// Register media:// as a privileged scheme BEFORE app is ready
registerMediaScheme()

// Suppress Chromium GPU disk cache errors (harmless but noisy)
app.commandLine.appendSwitch('disk-cache-size', '0')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Allow autoplay without user gesture (needed for popout player resume)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// --- Single instance lock -----------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

app.whenReady().then(async () => {
  logger.init()
  logger.info('molexMedia starting up...')

  registerMediaHandler()

  electronApp.setAppUserModelId('com.molex.media')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await loadConfig()
  await initFFmpegDir()
  registerIPC()
  registerGlobalIPC()

  // Wire tray callbacks (avoids circular dependency tray ↔ windows)
  setTrayCallbacks({
    showMainWindow,
    showPopout: () => showPopout(),
    quit: () => { setQuitting(true); app.quit() }
  })
  createTray()

  cleanupAudioCache()
  createWindow()
  await initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (hasTray() && !isQuitting) return
  killAllProcesses()
  destroyTray()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  setQuitting(true)
  killAllProcesses()
  cleanupPlaybackTemp()
  destroyTray()
})
