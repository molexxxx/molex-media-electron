/**
 * @module stores/types
 * @description Shared TypeScript types, interfaces, and built-in presets
 * used across the application state layer and UI components.
 */

export type View = 'dashboard' | 'batch' | 'editor' | 'player' | 'settings' | 'logs'
export type Operation = 'normalize' | 'boost' | 'convert' | 'extract' | 'compress'

export interface NormalizeOptions {
  I: number
  TP: number
  LRA: number
}

export interface Preset {
  id: string
  name: string
  description: string
  normalization: NormalizeOptions
  audioCodec: string
  audioBitrate: string
}

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'defaults', name: 'Defaults', description: 'Uses your global normalization settings', normalization: { I: -16, TP: -1.5, LRA: 11 }, audioCodec: 'inherit', audioBitrate: '256k' },
  { id: 'dialogue', name: 'Dialogue', description: 'Speech / podcast (-16 LUFS, tight LRA)', normalization: { I: -16, TP: -1.5, LRA: 8 }, audioCodec: 'aac', audioBitrate: '128k' },
  { id: 'music', name: 'Music', description: 'Streaming platforms (-14 LUFS)', normalization: { I: -14, TP: -1, LRA: 11 }, audioCodec: 'aac', audioBitrate: '320k' },
  { id: 'broadcast', name: 'Broadcast', description: 'EBU R128 / ATSC A/85 (-23 LUFS)', normalization: { I: -23, TP: -1, LRA: 15 }, audioCodec: 'ac3', audioBitrate: '448k' },
  { id: 'cinema', name: 'Cinema', description: 'Film / theatrical mix (-24 LUFS)', normalization: { I: -24, TP: -2, LRA: 20 }, audioCodec: 'eac3', audioBitrate: '640k' },
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
  audioBitrate?: string
  sampleRate?: string
  channels?: string
}

export interface CompressOptions {
  targetSizeMB: number
  quality: 'low' | 'medium' | 'high' | 'lossless'
  videoCodec?: string
  speed?: string
  audioBitrate?: string
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
  normalizeOptions?: NormalizeOptions
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
  showTrayNotification: boolean
  autoUpdate: boolean
  ytdlpBrowser: string
  sidebarCollapsed: boolean
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
