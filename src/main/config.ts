import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

export interface AppConfig {
  version: string
  normalization: {
    I: number
    TP: number
    LRA: number
  }
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

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.wma', '.aac', '.opus']

const DEFAULT_CONFIG: AppConfig = {
  version: '3.0.0',
  normalization: {
    I: -16.0,
    TP: -1.5,
    LRA: 11.0
  },
  audioCodec: 'inherit',
  fallbackCodec: 'ac3',
  audioBitrate: '256k',
  supportedExtensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
  maxWorkers: 0,
  logDir: 'logs',
  tempSuffix: '_temp_processing',
  ffmpegPath: '',
  ffprobePath: '',
  theme: 'dark',
  outputDirectory: '',
  overwriteOriginal: true,
  preserveSubtitles: true,
  preserveMetadata: true,
  showNotifications: true,
  minimizeToTray: false,
  autoUpdate: true
}

let Store: any

async function getStore(): Promise<any> {
  if (!Store) {
    const mod = await import('electron-store')
    Store = mod.default
  }
  return new Store({
    name: 'molex-media-config',
    defaults: DEFAULT_CONFIG
  })
}

let cachedConfig: AppConfig | null = null

export async function loadConfig(): Promise<AppConfig> {
  const store = await getStore()
  cachedConfig = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]) {
    const val = store.get(key)
    if (val !== undefined) {
      ;(cachedConfig as any)[key] = val
    }
  }
  if (cachedConfig.maxWorkers <= 0) {
    const os = await import('os')
    cachedConfig.maxWorkers = Math.max(1, os.cpus().length)
  }
  return cachedConfig
}

export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const store = await getStore()
  for (const [key, val] of Object.entries(partial)) {
    store.set(key, val)
  }
  cachedConfig = null
  return loadConfig()
}

export async function getConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig
  return loadConfig()
}

export function getConfigSync(): AppConfig {
  return cachedConfig || DEFAULT_CONFIG
}

export function getUserDataPath(): string {
  return app.getPath('userData')
}

export function getFFmpegBinDir(): string {
  return path.join(getUserDataPath(), 'ffmpeg-bin')
}

export function getLogDir(): string {
  const dir = path.join(getUserDataPath(), 'logs')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

export { DEFAULT_CONFIG, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS }
