/**
 * @module main/ipc/files
 * @description IPC handlers for FFmpeg setup and build information, file
 * dialogs, and local file playback for the Player.
 */

import { ipcMain, dialog, app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getConfig } from '../config'
import { logger } from '../logger'
import { getFFmpegVersion, type BootstrapProgress } from '../ffmpeg/bootstrap'
import { startPreviewServer, registerPreviewPath } from '../preview-server'
import { prepareForPlayback, prepareForPlaybackAt, clearPlaybackCacheFor } from '../ffmpeg/playback'
import { sendToAll } from './helpers'
import {
  checkFfmpeg, exclusiveDialog, ffmpegInfo, installPinnedFfmpeg, mediaFileFilters, mostRecentFolder, notePickedFolder, parentWindowOf,
  rerunSelfTest, type FfmpegBuildState
} from './jobs-host'

/** The old setup answer for a build state: found with its version and paths, or not found. */
function checkReply(state: FfmpegBuildState): { found: true; version: string; ffmpeg: string; ffprobe: string } | { found: false } {
  if (!state.adopted || !state.info) return { found: false }
  return { found: true, version: state.info.versionString || 'unknown', ffmpeg: state.info.ffmpegPath, ffprobe: state.info.ffprobePath }
}

/** Register FFmpeg setup, file dialog, and probe IPC handlers. */
export function registerFilesIPC(): void {
  // --- FFmpeg Setup ---
  ipcMain.handle('ffmpeg:check', async () => checkReply(await checkFfmpeg()))

  ipcMain.handle('ffmpeg:download', async () => {
    try {
      const state = await installPinnedFfmpeg((progress: BootstrapProgress) => {
        sendToAll('ffmpeg:download-progress', progress)
      })
      const reply = checkReply(state)
      if (!reply.found) throw new Error(state.refusal ?? 'The installed FFmpeg could not be used')
      return { success: true, version: reply.version, ffmpeg: reply.ffmpeg, ffprobe: reply.ffprobe }
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

  ipcMain.handle('ffmpeg:info', async () => ffmpegInfo())

  ipcMain.handle('ffmpeg:selfTest', async () => {
    await rerunSelfTest()
    return ffmpegInfo()
  })

  ipcMain.handle('ffmpeg:installPinned', async (event) => {
    try {
      await installPinnedFfmpeg((progress: BootstrapProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('ffmpeg:download-progress', progress)
      })
      return { ok: true, info: ffmpegInfo() }
    } catch (err: any) {
      logger.error(`Installing the tested FFmpeg build failed: ${err.message}`)
      return { ok: false, error: err.message, info: ffmpegInfo() }
    }
  })

  // --- File Dialogs (parented to the calling window, one at a time) ---
  ipcMain.handle('dialog:openFiles', async (event) =>
    exclusiveDialog<string[]>([], async () => {
      const win = parentWindowOf(event.sender)
      if (!win) return []
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: mediaFileFilters()
      })
      if (result.filePaths[0]) notePickedFolder(path.dirname(result.filePaths[0]))
      return result.filePaths
    }))

  ipcMain.handle('dialog:openDirectory', async (event) =>
    exclusiveDialog<string | null>(null, async () => {
      const win = parentWindowOf(event.sender)
      if (!win) return null
      const config = await getConfig()
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        defaultPath: mostRecentFolder(config.jobs.recentFolders)
      })
      const picked = result.filePaths[0] || null
      notePickedFolder(picked)
      return picked
    }))

  ipcMain.handle('dialog:selectOutputDir', async (event) =>
    exclusiveDialog<string | null>(null, async () => {
      const win = parentWindowOf(event.sender)
      if (!win) return null
      const config = await getConfig()
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Output Folder',
        defaultPath: config.outputDirectory || undefined
      })
      return result.filePaths[0] || null
    }))

  ipcMain.handle('dialog:selectSavePath', async (event, defaultName: string, filters: { name: string; extensions: string[] }[]) =>
    exclusiveDialog<string | null>(null, async () => {
      const win = parentWindowOf(event.sender)
      if (!win) return null
      const config = await getConfig()
      const defaultDir = config.outputDirectory || ''
      const defaultPath = defaultDir ? path.join(defaultDir, defaultName) : defaultName
      const result = await dialog.showSaveDialog(win, {
        title: 'Export As',
        defaultPath,
        filters
      })
      return result.canceled ? null : result.filePath || null
    }))

  // --- Read local file as buffer for blob URL creation ---
  ipcMain.handle('files:readFileBuffer', async (_, filePath: string) => {
    return fs.readFileSync(filePath)
  })

  // --- Register local file for HTTP server playback ---
  // Non-native formats are extracted to a browser-compatible temp file first.
  ipcMain.handle('files:registerLocalFile', async (_, filePath: string) => {
    const playbackPath = await prepareForPlayback(filePath)
    const baseUrl = await startPreviewServer()
    const token = registerPreviewPath(playbackPath)
    return `${baseUrl}/${token}`
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
    const baseUrl = await startPreviewServer()
    const token = registerPreviewPath(playbackPath)
    return `${baseUrl}/${token}`
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
