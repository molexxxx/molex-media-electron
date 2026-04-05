import { create } from 'zustand'

export type View = 'dashboard' | 'queue' | 'processing' | 'settings' | 'logs'
export type Operation = 'normalize' | 'boost'

export interface FileItem {
  path: string
  name: string
  size: number
  ext: string
  probed?: boolean
  duration?: string
  audioStreams?: number
  videoStreams?: number
  audioCodec?: string
  videoCodec?: string
  channels?: number
  sampleRate?: string
  bitrate?: string
}

export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: Operation
  boostPercent?: number
  status: 'queued' | 'analyzing' | 'processing' | 'finalizing' | 'complete' | 'error' | 'cancelled'
  progress: number
  message: string
  startedAt?: number
  completedAt?: number
  error?: string
  inputSize?: number
  outputSize?: number
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'
  message: string
  details?: string
}

export interface AppConfig {
  version: string
  normalization: { I: number; TP: number; LRA: number }
  audioCodec: string
  fallbackCodec: string
  audioBitrate: string
  supportedExtensions: string[]
  maxWorkers: number
  logDir: string
  tempSuffix: string
  ffmpegPath: string
  ffprobePath: string
  theme: 'dark' | 'light'
  outputDirectory: string
  overwriteOriginal: boolean
  preserveSubtitles: boolean
  preserveMetadata: boolean
  showNotifications: boolean
  minimizeToTray: boolean
  autoUpdate: boolean
}

interface SystemInfo {
  platform: string
  arch: string
  cpus: number
  totalMemory: number
  freeMemory: number
  nodeVersion: string
  electronVersion: string
  ffmpegVersion: string
  appVersion: string
}

interface AppState {
  // Navigation
  currentView: View
  setView: (view: View) => void

  // FFmpeg setup
  ffmpegReady: boolean
  ffmpegVersion: string
  ffmpegChecking: boolean
  setFFmpegReady: (ready: boolean, version?: string) => void
  setFFmpegChecking: (checking: boolean) => void

  // Config
  config: AppConfig | null
  setConfig: (config: AppConfig) => void

  // Files
  files: FileItem[]
  addFiles: (files: FileItem[]) => void
  updateFile: (path: string, data: Partial<FileItem>) => void
  removeFile: (path: string) => void
  clearFiles: () => void

  // Processing
  operation: Operation
  boostPercent: number
  setOperation: (op: Operation) => void
  setBoostPercent: (pct: number) => void

  tasks: ProcessingTask[]
  activeBatchId: string | null
  isProcessing: boolean
  setTasks: (tasks: ProcessingTask[]) => void
  updateTask: (task: ProcessingTask) => void
  setActiveBatch: (id: string | null) => void
  setIsProcessing: (processing: boolean) => void
  clearTasks: () => void

  // Stats
  totalProcessed: number
  totalErrors: number
  incrementProcessed: () => void
  incrementErrors: () => void

  // Logs
  logs: LogEntry[]
  addLog: (entry: LogEntry) => void
  clearLogs: () => void

  // System
  systemInfo: SystemInfo | null
  setSystemInfo: (info: SystemInfo) => void

  // Setup wizard
  showSetup: boolean
  setShowSetup: (show: boolean) => void

  // Download progress
  downloadProgress: { stage: string; message: string; percent: number } | null
  setDownloadProgress: (progress: { stage: string; message: string; percent: number } | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentView: 'dashboard',
  setView: (view) => set({ currentView: view }),

  ffmpegReady: false,
  ffmpegVersion: '',
  ffmpegChecking: true,
  setFFmpegReady: (ready, version) =>
    set({ ffmpegReady: ready, ffmpegVersion: version || '' }),
  setFFmpegChecking: (checking) => set({ ffmpegChecking: checking }),

  config: null,
  setConfig: (config) => set({ config }),

  files: [],
  addFiles: (newFiles) =>
    set((state) => {
      const existingPaths = new Set(state.files.map((f) => f.path))
      const unique = newFiles.filter((f) => !existingPaths.has(f.path))
      return { files: [...state.files, ...unique] }
    }),
  updateFile: (filePath, data) =>
    set((state) => ({
      files: state.files.map((f) => (f.path === filePath ? { ...f, ...data } : f))
    })),
  removeFile: (filePath) =>
    set((state) => ({ files: state.files.filter((f) => f.path !== filePath) })),
  clearFiles: () => set({ files: [] }),

  operation: 'normalize',
  boostPercent: 10,
  setOperation: (op) => set({ operation: op }),
  setBoostPercent: (pct) => set({ boostPercent: pct }),

  tasks: [],
  activeBatchId: null,
  isProcessing: false,
  setTasks: (tasks) => set({ tasks }),
  updateTask: (task) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === task.id ? task : t))
    })),
  setActiveBatch: (id) => set({ activeBatchId: id }),
  setIsProcessing: (processing) => set({ isProcessing: processing }),
  clearTasks: () => set({ tasks: [], activeBatchId: null }),

  totalProcessed: 0,
  totalErrors: 0,
  incrementProcessed: () => set((s) => ({ totalProcessed: s.totalProcessed + 1 })),
  incrementErrors: () => set((s) => ({ totalErrors: s.totalErrors + 1 })),

  logs: [],
  addLog: (entry) =>
    set((state) => {
      const logs = [...state.logs, entry]
      return { logs: logs.length > 5000 ? logs.slice(-2500) : logs }
    }),
  clearLogs: () => set({ logs: [] }),

  systemInfo: null,
  setSystemInfo: (info) => set({ systemInfo: info }),

  showSetup: false,
  setShowSetup: (show) => set({ showSetup: show }),

  downloadProgress: null,
  setDownloadProgress: (progress) => set({ downloadProgress: progress })
}))
