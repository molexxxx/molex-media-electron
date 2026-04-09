/**
 * @module main/ipc/system
 * @description IPC handlers for system information, log access, and
 * shell operations.
 */

import { ipcMain, shell } from 'electron'
import * as os from 'os'
import { getConfig, getLogDir } from '../config'
import { logger, type LogEntry } from '../logger'
import { getFFmpegVersion } from '../ffmpeg/bootstrap'
import { sendToAll } from './helpers'

/** Register system-info, logging, and shell IPC handlers. */
export function registerSystemIPC(): void {
  // --- Logging ---
  ipcMain.handle('logs:getBuffer', () => {
    return logger.getBuffer()
  })

  ipcMain.handle('logs:clear', () => {
    logger.clearBuffer()
  })

  ipcMain.handle('logs:openDir', async () => {
    const logDir = getLogDir()
    shell.openPath(logDir)
  })

  // Log streaming - forward every log entry to all renderer windows
  logger.onLog((entry: LogEntry) => {
    try {
      sendToAll('logs:entry', entry)
    } catch { /* best-effort */ }
  })

  // --- System Info ---
  ipcMain.handle('system:info', async () => {
    const config = await getConfig()
    let ffmpegVersion = 'Not installed'
    if (config.ffmpegPath) {
      ffmpegVersion = await getFFmpegVersion(config.ffmpegPath)
    }
    return {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      ffmpegVersion,
      appVersion: config.version
    }
  })

  ipcMain.handle('shell:openPath', async (_, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url)
    }
  })
}
