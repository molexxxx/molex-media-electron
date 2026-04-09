/**
 * @module preload/index
 * @description Electron preload script - secure bridge between renderer and main.
 *
 * Exposes a curated `window.api` object to the renderer via
 * `contextBridge.exposeInMainWorld`. Each method is a thin wrapper
 * around `ipcRenderer.invoke` or `ipcRenderer.on`, providing type-safe
 * access to file operations, FFmpeg processing, configuration, yt-dlp,
 * window controls, and system queries without granting full Node access.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (partial: any) => ipcRenderer.invoke('config:save', partial),
  getConfig: () => ipcRenderer.invoke('config:get'),

  // FFmpeg
  checkFFmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  downloadFFmpeg: () => ipcRenderer.invoke('ffmpeg:download'),
  getFFmpegVersion: () => ipcRenderer.invoke('ffmpeg:version'),
  onDownloadProgress: (cb: (progress: any) => void) => {
    const listener = (_: any, progress: any) => cb(progress)
    ipcRenderer.on('ffmpeg:download-progress', listener)
    return () => ipcRenderer.removeListener('ffmpeg:download-progress', listener)
  },

  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectOutputDir: () => ipcRenderer.invoke('dialog:selectOutputDir'),
  selectSavePath: (defaultName: string, filters: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog:selectSavePath', defaultName, filters),
  scanDirectory: (dirPath: string) => ipcRenderer.invoke('files:scanDirectory', dirPath),
  probeFile: (filePath: string) => ipcRenderer.invoke('files:probe', filePath),

  // Processing
  normalize: (filePaths: string[], normalizeOptions?: any, outputDir?: string) => ipcRenderer.invoke('process:normalize', filePaths, normalizeOptions, outputDir),
  boost: (filePaths: string[], percent: number, outputDir?: string) => ipcRenderer.invoke('process:boost', filePaths, percent, outputDir),
  convert: (filePaths: string[], options: any, outputDir?: string) => ipcRenderer.invoke('process:convert', filePaths, options, outputDir),
  extract: (filePaths: string[], options: any, outputDir?: string) => ipcRenderer.invoke('process:extract', filePaths, options, outputDir),
  compress: (filePaths: string[], options: any, outputDir?: string) => ipcRenderer.invoke('process:compress', filePaths, options, outputDir),
  startBatchQueue: (taskSpecs: any[], maxWorkers?: number) => ipcRenderer.invoke('process:batch-queue', taskSpecs, maxWorkers),
  cancelBatch: (batchId: string) => ipcRenderer.invoke('process:cancel', batchId),
  cancelAll: () => ipcRenderer.invoke('process:cancelAll'),
  getActiveCount: () => ipcRenderer.invoke('process:activeCount'),
  pauseProcessing: () => ipcRenderer.invoke('process:pause'),
  resumeProcessing: () => ipcRenderer.invoke('process:resume'),
  getIsPaused: () => ipcRenderer.invoke('process:isPaused'),
  setWorkers: (count: number) => ipcRenderer.invoke('process:setWorkers', count),
  getWorkerStatus: () => ipcRenderer.invoke('process:getWorkerStatus'),
  onWorkerStatus: (cb: (status: { target: number; active: number }) => void) => {
    const listener = (_: any, status: any) => cb(status)
    ipcRenderer.on('process:workerStatus', listener)
    return () => ipcRenderer.removeListener('process:workerStatus', listener)
  },

  // Editor
  cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => ipcRenderer.invoke('editor:cut', filePath, inPoint, outPoint, options),
  mergeMedia: (segments: { path: string; inPoint: number; outPoint: number; audioReplacement?: { path: string; offset: number; trimIn: number; trimOut: number } }[], options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => ipcRenderer.invoke('editor:merge', segments, options),
  probeDetailed: (filePath: string) => ipcRenderer.invoke('editor:probeDetailed', filePath),
  remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => ipcRenderer.invoke('editor:remux', filePath, options),
  replaceAudio: (videoPath: string, audioPath: string, options?: { outputDir?: string; audioOffset?: number; inPoint?: number; outPoint?: number }) => ipcRenderer.invoke('editor:replaceAudio', videoPath, audioPath, options),
  createPreview: (filePath: string) => ipcRenderer.invoke('editor:createPreview', filePath),
  createAudioPreview: (filePath: string) => ipcRenderer.invoke('editor:createAudioPreview', filePath),
  exportTimeline: (request: any) => ipcRenderer.invoke('editor:export', request),
  cancelExport: () => ipcRenderer.invoke('editor:cancelExport'),
  extractThumbnail: (filePath: string, timeSec: number) => ipcRenderer.invoke('editor:thumbnail', filePath, timeSec),
  extractThumbnailStrip: (filePath: string, durationSeconds: number) => ipcRenderer.invoke('editor:thumbnailStrip', filePath, durationSeconds),
  extractWaveform: (filePath: string, numSamples?: number) => ipcRenderer.invoke('editor:waveform', filePath, numSamples),
  onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => {
    const listener = (_: any, progress: any) => cb(progress)
    ipcRenderer.on('editor:progress', listener)
    return () => ipcRenderer.removeListener('editor:progress', listener)
  },

  // File utilities
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  registerLocalFile: (filePath: string) => ipcRenderer.invoke('files:registerLocalFile', filePath),
  seekLocalFile: (filePath: string, seekTime: number) => ipcRenderer.invoke('files:seekLocalFile', filePath, seekTime),
  clearPlaybackCache: (filePath: string) => ipcRenderer.invoke('files:clearPlaybackCache', filePath),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('files:readFileBuffer', filePath),
  getKnownFolders: () => ipcRenderer.invoke('files:knownFolders'),
  browseDirectory: (dirPath: string) => ipcRenderer.invoke('files:browse', dirPath),

  // Popout player
  popoutPlayer: (state?: any) => ipcRenderer.invoke('player:popout', state),
  isPopout: () => ipcRenderer.invoke('player:isPopout'),
  togglePin: () => ipcRenderer.invoke('player:togglePin'),
  isPinned: () => ipcRenderer.invoke('player:isPinned'),
  resizePopout: (width: number, height: number, save?: boolean) => ipcRenderer.invoke('player:resize', width, height, save),
  getPopoutSize: () => ipcRenderer.invoke('player:getSize'),
  returnPlayerState: (state: any) => ipcRenderer.send('player:returnState', state),
  onPopoutClosed: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('player:popout-closed', listener)
    return () => ipcRenderer.removeListener('player:popout-closed', listener)
  },
  onReceivePlayerState: (cb: (state: any) => void) => {
    const listener = (_: any, state: any) => cb(state)
    ipcRenderer.on('player:receiveState', listener)
    return () => ipcRenderer.removeListener('player:receiveState', listener)
  },
  getPlayerState: () => ipcRenderer.invoke('player:getPendingState'),

  // YouTube / yt-dlp
  resolvePlaylist: (url: string) => ipcRenderer.invoke('ytdlp:resolve', url),
  getStreamUrl: (videoUrl: string, quality?: string) => ipcRenderer.invoke('ytdlp:getStreamUrl', videoUrl, quality),
  getInstalledBrowsers: () => ipcRenderer.invoke('ytdlp:getInstalledBrowsers'),
  setCookieBrowser: (browserName: string) => ipcRenderer.invoke('ytdlp:setBrowser', browserName),
  clearCookies: () => ipcRenderer.invoke('ytdlp:clearCookies'),
  getCookieInfo: () => ipcRenderer.invoke('ytdlp:cookieInfo'),
  onPaused: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('process:paused', listener)
    return () => ipcRenderer.removeListener('process:paused', listener)
  },
  onResumed: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('process:resumed', listener)
    return () => ipcRenderer.removeListener('process:resumed', listener)
  },

  onBatchStarted: (cb: (data: any) => void) => {
    const listener = (_: any, data: any) => cb(data)
    ipcRenderer.on('process:batch-started', listener)
    return () => ipcRenderer.removeListener('process:batch-started', listener)
  },
  onTaskProgress: (cb: (task: any) => void) => {
    const listener = (_: any, task: any) => cb(task)
    ipcRenderer.on('process:task-progress', listener)
    return () => ipcRenderer.removeListener('process:task-progress', listener)
  },
  onBatchComplete: (cb: (data: any) => void) => {
    const listener = (_: any, data: any) => cb(data)
    ipcRenderer.on('process:batch-complete', listener)
    return () => ipcRenderer.removeListener('process:batch-complete', listener)
  },

  // Logs
  getLogBuffer: () => ipcRenderer.invoke('logs:getBuffer'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogDir: () => ipcRenderer.invoke('logs:openDir'),
  onLogEntry: (cb: (entry: any) => void) => {
    const listener = (_: any, entry: any) => cb(entry)
    ipcRenderer.on('logs:entry', listener)
    return () => ipcRenderer.removeListener('logs:entry', listener)
  },

  // System
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // URL History
  getUrlHistory: () => ipcRenderer.invoke('history:get'),
  removeUrlHistory: (url: string) => ipcRenderer.invoke('history:remove', url),
  clearUrlHistory: () => ipcRenderer.invoke('history:clear'),

  // Window controls
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  showTextContextMenu: () => ipcRenderer.send('context-menu:text'),
  onCloseConfirm: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('close:confirm', listener)
    return () => ipcRenderer.removeListener('close:confirm', listener)
  },
  closeConfirmResponse: (action: 'minimize' | 'quit', dontAskAgain: boolean) =>
    ipcRenderer.send('close:response', action, dontAskAgain),

  // Navigation (from tray context menu)
  onNavigate: (cb: (view: string) => void) => {
    const listener = (_: any, view: string) => cb(view)
    ipcRenderer.on('navigate', listener)
    return () => ipcRenderer.removeListener('navigate', listener)
  },

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:get-status'),
  onUpdaterStatus: (cb: (status: any) => void) => {
    const listener = (_: any, status: any) => cb(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as any).electron = electronAPI
  ;(window as any).api = api
}
