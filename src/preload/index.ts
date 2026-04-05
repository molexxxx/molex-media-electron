import { contextBridge, ipcRenderer } from 'electron'
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
  scanDirectory: (dirPath: string) => ipcRenderer.invoke('files:scanDirectory', dirPath),
  probeFile: (filePath: string) => ipcRenderer.invoke('files:probe', filePath),

  // Processing
  normalize: (filePaths: string[]) => ipcRenderer.invoke('process:normalize', filePaths),
  boost: (filePaths: string[], percent: number) => ipcRenderer.invoke('process:boost', filePaths, percent),
  convert: (filePaths: string[], options: any) => ipcRenderer.invoke('process:convert', filePaths, options),
  extract: (filePaths: string[], options: any) => ipcRenderer.invoke('process:extract', filePaths, options),
  compress: (filePaths: string[], options: any) => ipcRenderer.invoke('process:compress', filePaths, options),
  cancelBatch: (batchId: string) => ipcRenderer.invoke('process:cancel', batchId),
  cancelAll: () => ipcRenderer.invoke('process:cancelAll'),
  getActiveCount: () => ipcRenderer.invoke('process:activeCount'),
  pauseProcessing: () => ipcRenderer.invoke('process:pause'),
  resumeProcessing: () => ipcRenderer.invoke('process:resume'),
  getIsPaused: () => ipcRenderer.invoke('process:isPaused'),
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

  // Window controls
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close')
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
