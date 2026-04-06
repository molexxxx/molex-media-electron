/**
 * @module main/config
 * @description Persistent application configuration and URL history management.
 *
 * Reads and writes `config.json` from the Electron user-data directory.
 * Provides typed accessors for all configuration fields (normalization
 * targets, codec settings, worker count, output preferences) and manages
 * the YouTube URL history with add / remove / clear / get operations.
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

export interface UrlHistoryEntry {
  url: string
  title: string
  trackCount: number
  addedAt: number
}

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
  showTrayNotification: boolean
  autoUpdate: boolean

  ytdlpBrowser: string
  urlHistory: UrlHistoryEntry[]
  popoutSize: { width: number; height: number }
}

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.vob', '.3gp', '.mts', '.m2ts', '.divx', '.f4v', '.ogv', '.rm', '.rmvb', '.asf']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.wma', '.aac', '.opus', '.ac3', '.eac3', '.dts', '.amr', '.ape', '.wv']

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
  minimizeToTray: true,
  showTrayNotification: true,
  autoUpdate: true,

  ytdlpBrowser: '',
  urlHistory: [],
  popoutSize: { width: 420, height: 560 }
}

let Store: any

/**
 * Lazily imports and instantiates the electron-store backed by
 * {@link DEFAULT_CONFIG} defaults.
 * @returns The shared electron-store instance.
 */
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

/**
 * Loads the full configuration from disk, merging stored values over
 * {@link DEFAULT_CONFIG}. Auto-detects `maxWorkers` from CPU count
 * when the stored value is zero or negative.
 * @returns The merged application configuration.
 */
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

/**
 * Persists a partial configuration update to disk and reloads the
 * full configuration so the in-memory cache stays current.
 * @param partial - Key/value pairs to merge into the stored config.
 * @returns The reloaded configuration after saving.
 */
export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const store = await getStore()
  for (const [key, val] of Object.entries(partial)) {
    store.set(key, val)
  }
  cachedConfig = null
  return loadConfig()
}

/**
 * Returns the cached configuration, loading from disk on first call.
 * @returns The current application configuration.
 */
export async function getConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig
  return loadConfig()
}

/**
 * Returns the cached configuration synchronously. Falls back to
 * {@link DEFAULT_CONFIG} if {@link loadConfig} has not been called yet.
 */
export function getConfigSync(): AppConfig {
  return cachedConfig || DEFAULT_CONFIG
}

/** Returns the Electron user-data directory (platform-specific). */
export function getUserDataPath(): string {
  return app.getPath('userData')
}

/** Returns the directory where downloaded FFmpeg binaries are stored. */
export function getFFmpegBinDir(): string {
  return path.join(getUserDataPath(), 'ffmpeg-bin')
}

/**
 * Returns the log directory path, creating it if it does not exist.
 * @returns Absolute path to the log directory.
 */
export function getLogDir(): string {
  const dir = path.join(getUserDataPath(), 'logs')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

const MAX_URL_HISTORY = 50

/**
 * Adds a URL to the history (or moves it to the front if it already
 * exists). The list is capped at {@link MAX_URL_HISTORY} entries.
 * @param entry - URL, title, and track count to record.
 * @returns The updated history array.
 */
export async function addUrlHistory(entry: Omit<UrlHistoryEntry, 'addedAt'>): Promise<UrlHistoryEntry[]> {
  const config = await getConfig()
  const history = config.urlHistory.filter((h) => h.url !== entry.url)
  const newEntry: UrlHistoryEntry = { ...entry, addedAt: Date.now() }
  history.unshift(newEntry)
  if (history.length > MAX_URL_HISTORY) history.length = MAX_URL_HISTORY
  await saveConfig({ urlHistory: history })
  return history
}

/** Returns the saved URL history array. */
export async function getUrlHistory(): Promise<UrlHistoryEntry[]> {
  const config = await getConfig()
  return config.urlHistory
}

/**
 * Removes a single URL from the history by exact match.
 * @param url - The URL string to remove.
 * @returns The updated history array.
 */
export async function removeUrlHistory(url: string): Promise<UrlHistoryEntry[]> {
  const config = await getConfig()
  const history = config.urlHistory.filter((h) => h.url !== url)
  await saveConfig({ urlHistory: history })
  return history
}

/** Removes all entries from the URL history. */
export async function clearUrlHistory(): Promise<void> {
  await saveConfig({ urlHistory: [] })
}

export { DEFAULT_CONFIG, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS }
