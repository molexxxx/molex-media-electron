/**
 * @module stores/types
 * @description Shared TypeScript types of the application store: views,
 * log entries, the renderer's view of the config, and system information.
 */

import type { StageId } from '../../../shared/jobs/types'

export type View = 'dashboard' | 'batch' | 'editor' | 'player' | 'settings' | 'logs'

export interface LogEntry {
  /** Monotonic, stamped by main's logger. */
  id?: number
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'
  message: string
  details?: string
  /** The job a line is about. */
  jobId?: string
  runId?: string
  attempt?: number
  stage?: StageId
  kind?: 'message' | 'cmd' | 'stderr' | 'event'
}

/** Narrows the Logs view to one job or one run. */
export type LogFilter = { jobId: string } | { runId: string }

export interface AppConfig {
  version: string
  audioCodec: string
  audioBitrate: string
  maxWorkers: number
  logDir: string
  ffmpegPath: string
  ffprobePath: string
  theme: 'dark' | 'light'
  showNotifications: boolean
  minimizeToTray: boolean
  showTrayNotification: boolean
  autoUpdate: boolean
  gpuAcceleration: 'off' | 'auto' | 'nvenc' | 'qsv' | 'amf'
  ytdlpBrowser: string
  sidebarCollapsed: boolean
  /** Interface size in percent, 90 to 200; main clamps it on load. */
  interfaceScale: number
  /** Speaks batch progress at most every 30 seconds; defaults to false. */
  announceProgress: boolean
}

export interface SystemInfo {
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
