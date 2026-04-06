/**
 * @module main/ipc/files
 * @description IPC handlers for FFmpeg setup, file dialogs, directory
 * scanning, and media probing.
 */

import { ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { saveConfig, getConfig } from '../config'
import { logger } from '../logger'
import { findSystemFFmpeg, downloadFFmpeg, getFFmpegVersion, type BootstrapProgress } from '../ffmpeg/bootstrap'
import { probeMedia } from '../ffmpeg/probe'
import { findMediaFiles } from '../ffmpeg/processor'
import { initFFmpegDir } from '../ytdlp/binary'
import { sendToAll } from './helpers'

/** Register FFmpeg setup, file dialog, and probe IPC handlers. */
export function registerFilesIPC(): void {
  // --- FFmpeg Setup ---
  ipcMain.handle('ffmpeg:check', async () => {
    const paths = await findSystemFFmpeg()
    if (paths) {
      const version = await getFFmpegVersion(paths.ffmpeg)
      await saveConfig({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe })
      await initFFmpegDir()
      return { found: true, version, ...paths }
    }
    return { found: false }
  })

  ipcMain.handle('ffmpeg:download', async () => {
    try {
      const paths = await downloadFFmpeg((progress: BootstrapProgress) => {
        sendToAll('ffmpeg:download-progress', progress)
      })
      const version = await getFFmpegVersion(paths.ffmpeg)
      await saveConfig({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe })
      await initFFmpegDir()
      return { success: true, version, ...paths }
    } catch (err: any) {
      logger.error(`FFmpeg download failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('ffmpeg:version', async () => {
    const config = await getConfig()
    if (!config.ffmpegPath) return 'Not installed'
    return getFFmpegVersion(config.ffmpegPath)
  })

  // --- File Dialogs ---
  ipcMain.handle('dialog:openFiles', async () => {
    const config = await getConfig()
    const exts = config.supportedExtensions.map((e) => e.replace('.', ''))
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media Files', extensions: exts },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.filePaths
  })

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.filePaths[0] || null
  })

  ipcMain.handle('dialog:selectOutputDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Output Directory'
    })
    return result.filePaths[0] || null
  })

  // --- Directory scanning ---
  ipcMain.handle('files:scanDirectory', async (_, dirPath: string) => {
    const config = await getConfig()
    const files = findMediaFiles(dirPath, config.supportedExtensions)
    return files.map((f) => ({
      path: f,
      name: path.basename(f),
      size: fs.statSync(f).size,
      ext: path.extname(f).toLowerCase()
    }))
  })

  // --- Media probing ---
  ipcMain.handle('files:probe', async (_, filePath: string) => {
    return probeMedia(filePath)
  })
}
