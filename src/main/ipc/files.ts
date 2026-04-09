/**
 * @module main/ipc/files
 * @description IPC handlers for FFmpeg setup, file dialogs, directory
 * scanning, and media probing.
 */

import { ipcMain, dialog, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { saveConfig, getConfig } from '../config'
import { logger } from '../logger'
import { findSystemFFmpeg, downloadFFmpeg, getFFmpegVersion, type BootstrapProgress } from '../ffmpeg/bootstrap'
import { probeMedia } from '../ffmpeg/probe'
import { findMediaFiles } from '../ffmpeg/processor'
import { initFFmpegDir } from '../ytdlp/binary'
import { registerPreviewFile } from '../protocol'
import { prepareForPlayback, prepareForPlaybackAt, clearPlaybackCacheFor } from '../ffmpeg/playback'
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

  ipcMain.handle('dialog:selectSavePath', async (_, defaultName: string, filters: { name: string; extensions: string[] }[]) => {
    const config = await getConfig()
    const defaultDir = config.outputDirectory || ''
    const defaultPath = defaultDir ? path.join(defaultDir, defaultName) : defaultName
    const result = await dialog.showSaveDialog({
      title: 'Export As',
      defaultPath,
      filters
    })
    return result.canceled ? null : result.filePath || null
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

  // --- Read local file as buffer for blob URL creation ---
  ipcMain.handle('files:readFileBuffer', async (_, filePath: string) => {
    return fs.readFileSync(filePath)
  })

  // --- Register local file for media:// protocol access ---
  // Non-native formats are extracted to a browser-compatible temp file first.
  ipcMain.handle('files:registerLocalFile', async (_, filePath: string) => {
    const playbackPath = await prepareForPlayback(filePath)
    const token = registerPreviewFile(playbackPath)
    return `media://${token}`
  })

  // --- Clear extraction cache for a file (retry after playback error) ---
  ipcMain.handle('files:clearPlaybackCache', async (_, filePath: string) => {
    clearPlaybackCacheFor(filePath)
  })

  // --- Seek-extract: re-extract audio starting at a specific time offset ---
  // Used when seeking deep into large extracted files where normal byte-range
  // seeking doesn't work reliably.
  ipcMain.handle('files:seekLocalFile', async (_, filePath: string, seekTime: number) => {
    const playbackPath = await prepareForPlaybackAt(filePath, seekTime)
    const token = registerPreviewFile(playbackPath)
    return `media://${token}`
  })

  // --- Known folder locations (My Music, My Videos, etc.) ---
  ipcMain.handle('files:knownFolders', async () => {
    const folders: { name: string; path: string; icon: string }[] = []
    const tryAdd = (name: string, key: string, icon: string): void => {
      try {
        const p = app.getPath(key as any)
        if (p && fs.existsSync(p)) folders.push({ name, path: p, icon })
      } catch { /* not available */ }
    }
    tryAdd('Desktop', 'desktop', 'desktop')
    tryAdd('Documents', 'documents', 'documents')
    tryAdd('Downloads', 'downloads', 'downloads')
    tryAdd('Music', 'music', 'music')
    tryAdd('Videos', 'videos', 'video')
    tryAdd('Pictures', 'pictures', 'picture')
    tryAdd('Home', 'home', 'home')

    // Add drive roots on Windows
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`
        try {
          if (fs.existsSync(drive)) folders.push({ name: `${letter}: Drive`, path: drive, icon: 'drive' })
        } catch { /* skip */ }
      }
    } else {
      folders.push({ name: '/', path: '/', icon: 'drive' })
    }
    return folders
  })

  // --- Browse directory contents ---
  ipcMain.handle('files:browse', async (_, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      const results: { name: string; path: string; isDirectory: boolean; size: number; ext: string }[] = []
      for (const entry of entries) {
        // Skip hidden files/dirs
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(dirPath, entry.name)
        const isDir = entry.isDirectory()
        let size = 0
        let ext = ''
        if (!isDir) {
          try {
            const stat = await fs.promises.stat(fullPath)
            size = stat.size
          } catch { /* skip unreadable */ }
          ext = path.extname(entry.name).toLowerCase()
        }
        results.push({ name: entry.name, path: fullPath, isDirectory: isDir, size, ext })
      }
      // Sort: directories first, then files, both alphabetical
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
      return { success: true, entries: results, parentPath: path.dirname(dirPath) }
    } catch (err: any) {
      return { success: false, entries: [], parentPath: dirPath, error: err.message }
    }
  })
}
