import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { loadConfig, saveConfig, getConfig, getLogDir } from './config'
import { logger, LogEntry } from './logger'
import { findSystemFFmpeg, downloadFFmpeg, getFFmpegVersion, BootstrapProgress } from './ffmpeg/bootstrap'
import { probeMedia } from './ffmpeg/probe'
import {
  processBatch,
  findMediaFiles,
  pauseProcessing,
  resumeProcessing,
  getIsPaused,
  ProcessingTask
} from './ffmpeg/processor'
import { killAllProcesses, getActiveProcessCount } from './ffmpeg/runner'

const activeTasks = new Map<string, AbortController>()

export function registerIPC(mainWindow: BrowserWindow): void {
  // ─── Config ───────────────────────────────────
  ipcMain.handle('config:load', async () => {
    return loadConfig()
  })

  ipcMain.handle('config:save', async (_, partial) => {
    return saveConfig(partial)
  })

  ipcMain.handle('config:get', async () => {
    return getConfig()
  })

  // ─── FFmpeg Setup ─────────────────────────────
  ipcMain.handle('ffmpeg:check', async () => {
    const paths = await findSystemFFmpeg()
    if (paths) {
      const version = await getFFmpegVersion(paths.ffmpeg)
      await saveConfig({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe })
      return { found: true, version, ...paths }
    }
    return { found: false }
  })

  ipcMain.handle('ffmpeg:download', async () => {
    try {
      const paths = await downloadFFmpeg((progress: BootstrapProgress) => {
        mainWindow.webContents.send('ffmpeg:download-progress', progress)
      })
      const version = await getFFmpegVersion(paths.ffmpeg)
      await saveConfig({ ffmpegPath: paths.ffmpeg, ffprobePath: paths.ffprobe })
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

  // ─── File Operations ──────────────────────────
  ipcMain.handle('dialog:openFiles', async () => {
    const config = await getConfig()
    const exts = config.supportedExtensions.map((e) => e.replace('.', ''))
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media Files', extensions: exts },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.filePaths
  })

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return result.filePaths[0] || null
  })

  ipcMain.handle('dialog:selectOutputDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Output Directory'
    })
    return result.filePaths[0] || null
  })

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

  ipcMain.handle('files:probe', async (_, filePath: string) => {
    return probeMedia(filePath)
  })

  // ─── Processing ───────────────────────────────
  ipcMain.handle('process:normalize', async (_, filePaths: string[]) => {
    const config = await getConfig()
    const tasks: ProcessingTask[] = filePaths.map((f, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: f,
      fileName: path.basename(f),
      operation: 'normalize',
      status: 'queued',
      progress: 0,
      message: 'Waiting...'
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    const onProgress = (task: ProcessingTask): void => {
      mainWindow.webContents.send('process:task-progress', task)
    }

    mainWindow.webContents.send('process:batch-started', { batchId, tasks })

    try {
      const results = await processBatch(tasks, config.maxWorkers, onProgress, abort)
      mainWindow.webContents.send('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
    }
  })

  ipcMain.handle('process:boost', async (_, filePaths: string[], boostPercent: number) => {
    const config = await getConfig()
    const tasks: ProcessingTask[] = filePaths.map((f, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: f,
      fileName: path.basename(f),
      operation: 'boost',
      boostPercent,
      status: 'queued',
      progress: 0,
      message: 'Waiting...'
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    const onProgress = (task: ProcessingTask): void => {
      mainWindow.webContents.send('process:task-progress', task)
    }

    mainWindow.webContents.send('process:batch-started', { batchId, tasks })

    try {
      const results = await processBatch(tasks, config.maxWorkers, onProgress, abort)
      mainWindow.webContents.send('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
    }
  })

  ipcMain.handle('process:convert', async (_, filePaths: string[], convertOptions: any) => {
    const config = await getConfig()
    const tasks: ProcessingTask[] = filePaths.map((f, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: f,
      fileName: path.basename(f),
      operation: 'convert' as const,
      convertOptions,
      status: 'queued' as const,
      progress: 0,
      message: 'Waiting...'
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    const onProgress = (task: ProcessingTask): void => {
      mainWindow.webContents.send('process:task-progress', task)
    }

    mainWindow.webContents.send('process:batch-started', { batchId, tasks })

    try {
      const results = await processBatch(tasks, config.maxWorkers, onProgress, abort)
      mainWindow.webContents.send('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
    }
  })

  ipcMain.handle('process:extract', async (_, filePaths: string[], extractOptions: any) => {
    const config = await getConfig()
    const tasks: ProcessingTask[] = filePaths.map((f, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: f,
      fileName: path.basename(f),
      operation: 'extract' as const,
      extractOptions,
      status: 'queued' as const,
      progress: 0,
      message: 'Waiting...'
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    const onProgress = (task: ProcessingTask): void => {
      mainWindow.webContents.send('process:task-progress', task)
    }

    mainWindow.webContents.send('process:batch-started', { batchId, tasks })

    try {
      const results = await processBatch(tasks, config.maxWorkers, onProgress, abort)
      mainWindow.webContents.send('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
    }
  })

  ipcMain.handle('process:compress', async (_, filePaths: string[], compressOptions: any) => {
    const config = await getConfig()
    const tasks: ProcessingTask[] = filePaths.map((f, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: f,
      fileName: path.basename(f),
      operation: 'compress' as const,
      compressOptions,
      status: 'queued' as const,
      progress: 0,
      message: 'Waiting...'
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    const onProgress = (task: ProcessingTask): void => {
      mainWindow.webContents.send('process:task-progress', task)
    }

    mainWindow.webContents.send('process:batch-started', { batchId, tasks })

    try {
      const results = await processBatch(tasks, config.maxWorkers, onProgress, abort)
      mainWindow.webContents.send('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
    }
  })

  ipcMain.handle('process:cancel', async (_, batchId: string) => {
    const abort = activeTasks.get(batchId)
    if (abort) {
      abort.abort()
      killAllProcesses()
      logger.warn(`Batch ${batchId} cancelled by user`)
      return true
    }
    return false
  })

  ipcMain.handle('process:cancelAll', async () => {
    for (const [, abort] of activeTasks) {
      abort.abort()
    }
    killAllProcesses()
    activeTasks.clear()
    logger.warn('All processing cancelled')
    return true
  })

  ipcMain.handle('process:activeCount', () => {
    return getActiveProcessCount()
  })

  ipcMain.handle('process:pause', () => {
    pauseProcessing()
    mainWindow.webContents.send('process:paused')
    logger.info('Processing paused by user')
    return true
  })

  ipcMain.handle('process:resume', () => {
    resumeProcessing()
    mainWindow.webContents.send('process:resumed')
    logger.info('Processing resumed by user')
    return true
  })

  ipcMain.handle('process:isPaused', () => {
    return getIsPaused()
  })

  // ─── Logging ──────────────────────────────────
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

  // Log streaming
  logger.onLog((entry: LogEntry) => {
    try {
      mainWindow.webContents.send('logs:entry', entry)
    } catch {}
  })

  // ─── System Info ──────────────────────────────
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
}
