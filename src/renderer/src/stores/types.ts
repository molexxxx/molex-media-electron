/**
 * @module stores/types
 * @description Shared TypeScript types, interfaces, and built-in presets
 * used across the application state layer and UI components.
 */

export type View = 'dashboard' | 'batch' | 'editor' | 'player' | 'settings' | 'logs'
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
  showTrayNotification: boolean
  autoUpdate: boolean
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
