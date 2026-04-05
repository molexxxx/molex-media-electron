import { create } from 'zustand'

export type View = 'dashboard' | 'queue' | 'processing' | 'player' | 'settings' | 'logs'
export type Operation = 'normalize' | 'boost' | 'convert' | 'extract' | 'compress'

export interface Preset {
  id: string
  name: string
  description: string
  category: 'streaming' | 'broadcast' | 'podcast' | 'music' | 'video' | 'custom'
  normalization: { I: number; TP: number; LRA: number }
  audioCodec: string
  audioBitrate: string
  videoCodec?: string
  videoBitrate?: string
}

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'youtube', name: 'YouTube', description: 'Optimized for YouTube uploads', category: 'streaming', normalization: { I: -14, TP: -1, LRA: 11 }, audioCodec: 'aac', audioBitrate: '256k', videoCodec: 'copy', videoBitrate: '' },
  { id: 'spotify', name: 'Spotify', description: 'Spotify loudness target (-14 LUFS)', category: 'streaming', normalization: { I: -14, TP: -1, LRA: 9 }, audioCodec: 'aac', audioBitrate: '320k' },
  { id: 'apple-music', name: 'Apple Music', description: 'Apple Music / iTunes standard', category: 'streaming', normalization: { I: -16, TP: -1, LRA: 12 }, audioCodec: 'aac', audioBitrate: '256k' },
  { id: 'podcast', name: 'Podcast', description: 'Spoken word optimized (-16 LUFS)', category: 'podcast', normalization: { I: -16, TP: -1.5, LRA: 8 }, audioCodec: 'aac', audioBitrate: '128k' },
  { id: 'broadcast', name: 'Broadcast TV', description: 'EBU R128 broadcast standard', category: 'broadcast', normalization: { I: -23, TP: -1, LRA: 15 }, audioCodec: 'ac3', audioBitrate: '448k' },
  { id: 'cinema', name: 'Cinema / Film', description: 'Theatrical mix standard', category: 'broadcast', normalization: { I: -24, TP: -2, LRA: 20 }, audioCodec: 'eac3', audioBitrate: '640k' },
  { id: 'plex', name: 'Plex / Home Media', description: 'Optimal for Plex, Emby, Jellyfin streaming', category: 'streaming', normalization: { I: -18, TP: -1.5, LRA: 13 }, audioCodec: 'aac', audioBitrate: '320k', videoCodec: 'copy', videoBitrate: '' },
  { id: 'tiktok', name: 'TikTok / Reels', description: 'Short form social media', category: 'streaming', normalization: { I: -14, TP: -1, LRA: 7 }, audioCodec: 'aac', audioBitrate: '192k' },
  { id: 'cd', name: 'CD Master', description: 'CD mastering standard', category: 'music', normalization: { I: -9, TP: -0.3, LRA: 8 }, audioCodec: 'flac', audioBitrate: '0' },
]

export interface ConvertOptions {
  outputFormat: string
  videoCodec: string
  audioCodec: string
  videoBitrate: string
  audioBitrate: string
  resolution: string
  framerate: string
}

export interface ExtractOptions {
  outputFormat: string
  streamIndex: number
}

export interface CompressOptions {
  targetSizeMB: number
  quality: 'low' | 'medium' | 'high' | 'lossless'
}

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
  width?: number
  height?: number
}

export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: Operation
  boostPercent?: number
  preset?: string
  status: 'queued' | 'analyzing' | 'processing' | 'finalizing' | 'complete' | 'error' | 'cancelled'
  progress: number
  message: string
  startedAt?: number
  completedAt?: number
  error?: string
  inputSize?: number
  outputSize?: number
  outputPath?: string
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

  // Processing
  operation: Operation
  boostPercent: number
  selectedPreset: string | null
  convertOptions: ConvertOptions
  extractOptions: ExtractOptions
  compressOptions: CompressOptions
  setOperation: (op: Operation) => void
  setBoostPercent: (pct: number) => void
  setSelectedPreset: (id: string | null) => void
  setConvertOptions: (opts: Partial<ConvertOptions>) => void
  setExtractOptions: (opts: Partial<ExtractOptions>) => void
  setCompressOptions: (opts: Partial<CompressOptions>) => void

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
  viewHistory: [],
  setView: (view) => set((s) => ({
    currentView: view,
    viewHistory: s.currentView !== view ? [...s.viewHistory.slice(-19), s.currentView] : s.viewHistory
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
  selectedPreset: null,
  convertOptions: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' },
  extractOptions: { outputFormat: 'mp3', streamIndex: 0 },
  compressOptions: { targetSizeMB: 0, quality: 'high' },
  setOperation: (op) => set({ operation: op }),
  setBoostPercent: (pct) => set({ boostPercent: pct }),
  setSelectedPreset: (id) => set({ selectedPreset: id }),
  setConvertOptions: (opts) => set((s) => ({ convertOptions: { ...s.convertOptions, ...opts } })),
  setExtractOptions: (opts) => set((s) => ({ extractOptions: { ...s.extractOptions, ...opts } })),
  setCompressOptions: (opts) => set((s) => ({ compressOptions: { ...s.compressOptions, ...opts } })),

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
