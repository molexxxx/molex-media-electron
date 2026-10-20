/**
 * @module stores/appStore
 * @description Central Zustand store for all application state.
 *
 * State domains: navigation, FFmpeg readiness, configuration, logs, system
 * information, setup, the sidebar, and the updater. Batch state lives in the
 * jobs store, fed by the engine.
 *
 * Types are defined in {@link stores/types}.
 */

import { create } from 'zustand'
import type { View, AppConfig, LogEntry, LogFilter, SystemInfo } from './types'

export type { View, AppConfig, LogEntry, LogFilter, SystemInfo } from './types'

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

  // Logs
  logs: LogEntry[]
  addLog: (entry: LogEntry) => void
  /** Appends a batch of entries in one update, with the same trim as {@link addLog}. */
  addLogs: (entries: LogEntry[]) => void
  clearLogs: () => void
  lastSeenErrorCount: number
  logFilter: LogFilter | null
  showLog: (filter: LogFilter | null) => void
  clearLogFilter: () => void

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
  updateStatus: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error' | 'manual'
  updateVersion: string | null
  updateError: string | null
  updateDownloadPercent: number
  setUpdateStatus: (status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error' | 'manual') => void
  setUpdateVersion: (version: string | null) => void
  setUpdateError: (error: string | null) => void
  setUpdateDownloadPercent: (percent: number) => void
}

/** The navigation fields for moving to a view; opening Logs marks its errors seen. */
function navigateTo(s: AppState, view: View): Partial<AppState> {
  return {
    currentView: view,
    viewHistory: s.currentView !== view ? [...s.viewHistory.slice(-19), s.currentView] : s.viewHistory,
    ...(view === 'logs' ? { lastSeenErrorCount: s.logs.filter((l) => l.level === 'error').length } : {})
  }
}

export const useAppStore = create<AppState>((set) => ({
  currentView: 'dashboard',
  viewHistory: [],
  setView: (view) => set((s) => navigateTo(s, view)),
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

  logs: [],
  lastSeenErrorCount: 0,
  addLog: (entry) =>
    set((state) => {
      const logs = [...state.logs, entry]
      return { logs: logs.length > 5000 ? logs.slice(-2500) : logs }
    }),
  addLogs: (entries) =>
    set((state) => {
      if (entries.length === 0) return {}
      const logs = [...state.logs, ...entries]
      return { logs: logs.length > 5000 ? logs.slice(-2500) : logs }
    }),
  clearLogs: () => set({ logs: [], lastSeenErrorCount: 0 }),
  logFilter: null,
  showLog: (filter) => set((s) => ({ ...navigateTo(s, 'logs'), logFilter: filter })),
  clearLogFilter: () => set({ logFilter: null }),

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
