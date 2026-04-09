/**
 * @module stores/appStore
 * @description Central Zustand store for all application state.
 *
 * State domains: navigation, FFmpeg readiness, configuration, file list,
 * batch processing, statistics, logs, and system information.
 *
 * Types, interfaces, and presets are defined in {@link stores/types}.
 */

import { create } from 'zustand'
import type {
  View, Operation, AppConfig, FileItem, ProcessingTask, LogEntry,
  ConvertOptions, ExtractOptions, CompressOptions, SystemInfo, NormalizeOptions
} from './types'

export type { View, Operation, Preset, AppConfig, FileItem, ProcessingTask, LogEntry, ConvertOptions, ExtractOptions, CompressOptions, SystemInfo, NormalizeOptions } from './types'
export { BUILTIN_PRESETS } from './types'

interface AppState {
  // Navigation
  currentView: View
  viewHistory: View[]
  setView: (view: View) => void
  goBack: () => void

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
  reorderFiles: (fromIndex: number, toIndex: number) => void
  updateFileOperation: (path: string, operation: Operation, options?: Partial<FileItem>) => void

  // Processing
  operation: Operation
  boostPercent: number
  selectedPreset: string | null
  normalizeOptions: NormalizeOptions
  convertOptions: ConvertOptions
  extractOptions: ExtractOptions
  compressOptions: CompressOptions
  setOperation: (op: Operation) => void
  setBoostPercent: (pct: number) => void
  setSelectedPreset: (id: string | null) => void
  setNormalizeOptions: (opts: Partial<NormalizeOptions>) => void
  setConvertOptions: (opts: Partial<ConvertOptions>) => void
  setExtractOptions: (opts: Partial<ExtractOptions>) => void
  setCompressOptions: (opts: Partial<CompressOptions>) => void
  batchOutputDir: string
  setBatchOutputDir: (dir: string) => void

  tasks: ProcessingTask[]
  activeBatchId: string | null
  isProcessing: boolean
  setTasks: (tasks: ProcessingTask[]) => void
  updateTask: (task: ProcessingTask) => void
  setActiveBatch: (id: string | null) => void
  setIsProcessing: (processing: boolean) => void
  isPaused: boolean
  setIsPaused: (paused: boolean) => void
  clearTasks: () => void
  resetBatch: () => void
  batchWorkers: number
  setBatchWorkers: (n: number) => void
  activeWorkerCount: number
  setActiveWorkerCount: (n: number) => void

  // Stats
  totalProcessed: number
  totalErrors: number
  incrementProcessed: () => void
  incrementErrors: () => void

  // Logs
  logs: LogEntry[]
  addLog: (entry: LogEntry) => void
  clearLogs: () => void
  lastSeenErrorCount: number

  // System
  systemInfo: SystemInfo | null
  setSystemInfo: (info: SystemInfo) => void

  // Setup wizard
  showSetup: boolean
  setShowSetup: (show: boolean) => void

  // Download progress
  downloadProgress: { stage: string; message: string; percent: number } | null
  setDownloadProgress: (progress: { stage: string; message: string; percent: number } | null) => void

  // Sidebar
  sidebarCollapsed: boolean
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void

  // Updater
  updateStatus: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error'
  updateVersion: string | null
  updateError: string | null
  updateDownloadPercent: number
  setUpdateStatus: (status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error') => void
  setUpdateVersion: (version: string | null) => void
  setUpdateError: (error: string | null) => void
  setUpdateDownloadPercent: (percent: number) => void
}

export const useAppStore = create<AppState>((set) => ({
  currentView: 'dashboard',
  viewHistory: [],
  setView: (view) => set((s) => ({
    currentView: view,
    viewHistory: s.currentView !== view ? [...s.viewHistory.slice(-19), s.currentView] : s.viewHistory,
    ...(view === 'logs' ? { lastSeenErrorCount: s.logs.filter((l) => l.level === 'error').length } : {})
  })),
  goBack: () => set((s) => {
    if (s.viewHistory.length === 0) return {}
    const prev = s.viewHistory[s.viewHistory.length - 1]
    return { currentView: prev, viewHistory: s.viewHistory.slice(0, -1) }
  }),

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
      const DONE_STATUSES = new Set(['complete', 'error', 'cancelled'])
      const existingByPath = new Map(state.files.map((f) => [f.path, f]))
      const readdPaths = new Set<string>()
      const unique = newFiles.filter((f) => {
        const existing = existingByPath.get(f.path)
        if (!existing) return true
        // If the existing file's task is finished, allow re-add
        const task = state.tasks.find((t) => t.filePath === f.path)
        if (task && DONE_STATUSES.has(task.status)) {
          readdPaths.add(f.path)
          return true
        }
        // If no task yet (never processed) and file is in queue, treat as finished
        if (!task) {
          readdPaths.add(f.path)
          return true
        }
        return false
      })
      // Remove old entries and stale tasks for re-added files
      const files = readdPaths.size > 0
        ? state.files.filter((f) => !readdPaths.has(f.path))
        : state.files
      const tasks = readdPaths.size > 0
        ? state.tasks.filter((t) => !readdPaths.has(t.filePath))
        : state.tasks
      // Stamp each new file with the currently selected operation + options
      const stamped = unique.map((f) => ({
        ...f,
        operation: f.operation || state.operation,
        ...(f.operation ? {} : {
          boostPercent: state.boostPercent,
          selectedPreset: state.selectedPreset,
          normalizeOptions: { ...state.normalizeOptions },
          convertOptions: { ...state.convertOptions },
          extractOptions: { ...state.extractOptions },
          compressOptions: { ...state.compressOptions },
        })
      }))
      return { files: [...files, ...stamped], tasks }
    }),
  updateFile: (filePath, data) =>
    set((state) => ({
      files: state.files.map((f) => (f.path === filePath ? { ...f, ...data } : f))
    })),
  removeFile: (filePath) =>
    set((state) => ({ files: state.files.filter((f) => f.path !== filePath) })),
  clearFiles: () => set({ files: [] }),
  reorderFiles: (fromIndex, toIndex) =>
    set((state) => {
      const files = [...state.files]
      const [item] = files.splice(fromIndex, 1)
      files.splice(toIndex, 0, item)
      return { files }
    }),
  updateFileOperation: (filePath, operation, options) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.path === filePath ? { ...f, operation, ...options } : f
      )
    })),

  operation: 'convert',
  boostPercent: 10,
  selectedPreset: 'defaults',
  normalizeOptions: { I: -16, TP: -1.5, LRA: 11 },
  convertOptions: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' },
  extractOptions: { outputFormat: 'mp3', streamIndex: 0, audioBitrate: '', sampleRate: '', channels: '' },
  compressOptions: { targetSizeMB: 0, quality: 'high', videoCodec: 'libx264', speed: 'slow', audioBitrate: '256k' },
  setOperation: (op) => set({ operation: op }),
  setBoostPercent: (pct) => set({ boostPercent: pct }),
  setSelectedPreset: (id) => set({ selectedPreset: id }),
  setNormalizeOptions: (opts) => set((s) => ({ normalizeOptions: { ...s.normalizeOptions, ...opts } })),
  setConvertOptions: (opts) => set((s) => ({ convertOptions: { ...s.convertOptions, ...opts } })),
  setExtractOptions: (opts) => set((s) => ({ extractOptions: { ...s.extractOptions, ...opts } })),
  setCompressOptions: (opts) => set((s) => ({ compressOptions: { ...s.compressOptions, ...opts } })),
  batchOutputDir: '',
  setBatchOutputDir: (dir) => set({ batchOutputDir: dir }),

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
  isPaused: false,
  setIsPaused: (paused) => set({ isPaused: paused }),
  clearTasks: () => set({ tasks: [], activeBatchId: null, isPaused: false }),
  batchWorkers: 0,
  setBatchWorkers: (n) => set({ batchWorkers: n }),
  activeWorkerCount: 0,
  setActiveWorkerCount: (n) => set({ activeWorkerCount: n }),

  resetBatch: () => set({
    files: [], tasks: [], activeBatchId: null, isProcessing: false, isPaused: false,
    batchWorkers: 0, activeWorkerCount: 0,
    operation: 'convert', boostPercent: 10, selectedPreset: 'defaults', batchOutputDir: '',
    normalizeOptions: { I: -16, TP: -1.5, LRA: 11 },
    convertOptions: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' },
    extractOptions: { outputFormat: 'mp3', streamIndex: 0 },
    compressOptions: { targetSizeMB: 0, quality: 'high', videoCodec: 'libx264', speed: 'slow', audioBitrate: '256k' }
  }),

  totalProcessed: 0,
  totalErrors: 0,
  incrementProcessed: () => set((s) => ({ totalProcessed: s.totalProcessed + 1 })),
  incrementErrors: () => set((s) => ({ totalErrors: s.totalErrors + 1 })),

  logs: [],
  lastSeenErrorCount: 0,
  addLog: (entry) =>
    set((state) => {
      const logs = [...state.logs, entry]
      return { logs: logs.length > 5000 ? logs.slice(-2500) : logs }
    }),
  clearLogs: () => set({ logs: [], lastSeenErrorCount: 0 }),

  systemInfo: null,
  setSystemInfo: (info) => set({ systemInfo: info }),

  showSetup: false,
  setShowSetup: (show) => set({ showSetup: show }),

  downloadProgress: null,
  setDownloadProgress: (progress) => set({ downloadProgress: progress }),

  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => {
    set((s) => ({
      sidebarCollapsed: collapsed,
      config: s.config ? { ...s.config, sidebarCollapsed: collapsed } : s.config
    }))
    window.api?.saveConfig({ sidebarCollapsed: collapsed }).catch(() => {})
  },
  toggleSidebar: () => set((s) => {
    const next = !s.sidebarCollapsed
    window.api?.saveConfig({ sidebarCollapsed: next }).catch(() => {})
    return {
      sidebarCollapsed: next,
      config: s.config ? { ...s.config, sidebarCollapsed: next } : s.config
    }
  }),

  updateStatus: 'idle',
  updateVersion: null,
  updateError: null,
  updateDownloadPercent: 0,
  setUpdateStatus: (status) => set({ updateStatus: status }),
  setUpdateVersion: (version) => set({ updateVersion: version }),
  setUpdateError: (error) => set({ updateError: error }),
  setUpdateDownloadPercent: (percent) => set({ updateDownloadPercent: percent })
}))
