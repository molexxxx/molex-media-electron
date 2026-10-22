/**
 * @module main/config
 * @description Persistent application configuration and URL history management.
 *
 * Reads and writes `config.json` from the Electron user-data directory.
 * Provides typed accessors for all configuration fields (normalization
 * targets, codec settings, worker count, output preferences) and manages
 * the YouTube URL history with add / remove / clear / get operations.
 *
 * The `ffmpeg`, `jobs`, and `ytdlp` keys are main-owned: only the bootstrap,
 * the job engine, and the yt-dlp updater write them, and the renderer's
 * config channels never carry them (`stripMainOwned`). The top-level `ffmpegPath` and `ffprobePath`
 * mirror the `ffmpeg` block for older readers; no save writes them directly.
 * There are no global loudness settings: every job carries its own recipe and
 * "New files" is the one default. `loadConfig` derives `jobs` from the legacy
 * keys where it is absent; an upgrade carries the old global loudness and
 * codec settings into the "Earlier default" user preset, which new files then
 * get. The legacy keys stay readable for the processors that still use them.
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { BuildSource, FfmpegConfig, SelfTestId, SelfTestRecord } from './ffmpeg/build'
import { AUDIO_LIMITS } from '../shared/audio/limits'
import { applyLoudnessPreset, DEFAULT_LOUDNESS_PRESET } from '../shared/audio/presets'
import type { EncoderPolicy, NormalizeRecipe, OutputCodec } from '../shared/audio/types'
import { EARLIER_DEFAULT_PRESET } from '../shared/jobs/presets'
import type { Recipe } from '../shared/jobs/recipes'
import { DEFAULT_TEMPLATES, RUN_ALERT_KINDS, type BatchPolicy, type Destination, type RecentFolder, type RunAlertKind, type RunSettings } from '../shared/jobs/types'
import { REQUEST_VALIDATORS, validateRecipe, WORKER_LIMITS } from '../shared/jobs/validate'
import type { YtDlpProblem } from '../shared/ipc/api'

export interface UrlHistoryEntry {
  url: string
  title: string
  trackCount: number
  addedAt: number
}

/** The main-owned `ytdlp` key, written only by the yt-dlp updater, which validates it on read. */
export interface YtDlpConfig {
  /** When a check last reached GitHub, in epoch milliseconds. */
  lastCheckAt: number | null
  /** The app-managed binary's version, with the size and modification time it was read at. */
  installed: { version: string; size: number; mtimeMs: number } | null
  /** The last check or update that failed, until one succeeds. */
  lastFailure: { problem: YtDlpProblem; at: number } | null
}

/** The main-owned `jobs` key; the default policy is never replace originals. */
export interface JobsConfig {
  settings: RunSettings
  policy: BatchPolicy
  /** What "New files get" applies. */
  defaultRecipe: Recipe
  recentFolders: RecentFolder[]
  /** Alerts a migration owes the engine; {@link takeJobsAlerts} hands each out once. */
  pendingAlerts: RunAlertKind[]
}

export interface AppConfig {
  version: string
  /** Legacy loudness target; an upgrade carries it, with the legacy codec keys, into the "Earlier default" preset. */
  normalization: {
    I: number
    TP: number
    LRA: number
  }
  audioCodec: string
  fallbackCodec: string
  audioBitrate: string
  maxWorkers: number
  logDir: string
  /** Mirror of `ffmpeg.ffmpegPath`; read-only. */
  ffmpegPath: string
  /** Mirror of `ffmpeg.ffprobePath`; read-only. */
  ffprobePath: string
  /** Main-owned: the FFmpeg build in use and its cached self-test, or null before one is found. */
  ffmpeg: FfmpegConfig | null
  theme: 'dark' | 'light'
  outputDirectory: string
  afterProcessing: 'replace' | 'keep-both'
  confirmReplace: boolean
  preserveSubtitles: boolean
  preserveMetadata: boolean
  showNotifications: boolean
  minimizeToTray: boolean
  showTrayNotification: boolean
  autoUpdate: boolean

  gpuAcceleration: 'off' | 'auto' | 'nvenc' | 'qsv' | 'amf'
  ytdlpBrowser: string
  /** Checks for a new yt-dlp once a day and installs it; never applies to a copy on PATH. */
  ytdlpAutoUpdate: boolean
  /** Runs the yt-dlp found on PATH instead of the app's own copy; off by default, so the copy in use is the one that updates. */
  ytdlpUseSystem: boolean
  /** Main-owned: when yt-dlp was last checked, the installed copy's version, and the last failure. */
  ytdlp: YtDlpConfig
  urlHistory: UrlHistoryEntry[]
  popoutSize: { width: number; height: number }
  sidebarCollapsed: boolean
  /** Main-owned: run settings, the default policy and recipe, and recent folders. */
  jobs: JobsConfig
  /** Interface size in percent, clamped to {@link INTERFACE_SCALE} on load. */
  interfaceScale: number
  /** Speaks batch progress at most every 30 seconds. */
  announceProgress: boolean
}

/** Keys only the main process writes; the renderer's config channels never carry them. */
export const MAIN_OWNED_KEYS = ['ffmpeg', 'jobs', 'ytdlp'] as const

export type MainOwnedKey = typeof MAIN_OWNED_KEYS[number]

/** Top-level keys that mirror the `ffmpeg` block; saves never write them. */
export const READ_ONLY_MIRRORS = ['ffmpegPath', 'ffprobePath'] as const

/** The configuration as the renderer sees it. */
export type RendererConfig = Omit<AppConfig, MainOwnedKey>

/** Keys earlier versions stored that nothing reads; loads remove them and saves never write them. */
export const DROPPED_KEYS = ['tempSuffix', 'supportedExtensions'] as const

/** The interface size range and default, in percent. */
export const INTERFACE_SCALE = { min: 90, max: 200, default: 100 } as const

/** Most recent folders the `jobs` key keeps. */
export const MAX_RECENT_FOLDERS = 8

const SAME_AS_SOURCE: EncoderPolicy = { kind: 'same-as-source' }

const LEGACY_TARGET = { I: -16.0, TP: -1.5 }

/** Run settings a new install starts with; upgrades derive workers and notifications from the legacy keys. */
export const DEFAULT_RUN_SETTINGS: RunSettings = {
  workers: { mode: 'auto' },
  gpuSessions: { mode: 'auto' },
  priority: 'below-normal',
  keepAwake: true,
  verifyVideo: 'full',
  notify: { completion: true, firstFailure: true },
  measureOnReview: true,
  includeSubfolders: true
}

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
  maxWorkers: 0,
  logDir: 'logs',
  ffmpegPath: '',
  ffprobePath: '',
  ffmpeg: null,
  theme: 'dark',
  outputDirectory: '',
  afterProcessing: 'keep-both',
  confirmReplace: true,
  preserveSubtitles: true,
  preserveMetadata: true,
  showNotifications: true,
  minimizeToTray: true,
  showTrayNotification: true,
  autoUpdate: true,

  gpuAcceleration: 'off',
  ytdlpBrowser: '',
  ytdlpAutoUpdate: true,
  ytdlpUseSystem: false,
  ytdlp: { lastCheckAt: null, installed: null, lastFailure: null },
  urlHistory: [],
  popoutSize: { width: 420, height: 560 },
  sidebarCollapsed: false,
  jobs: {
    settings: DEFAULT_RUN_SETTINGS,
    policy: { rev: 0, destination: { mode: 'next-to-source' }, template: DEFAULT_TEMPLATES['next-to-source'], conflict: 'rename', displaced: 'trash', gpu: 'off' },
    defaultRecipe: applyLoudnessPreset(DEFAULT_LOUDNESS_PRESET, SAME_AS_SOURCE),
    recentFolders: [],
    pendingAlerts: []
  },
  interfaceScale: INTERFACE_SCALE.default,
  announceProgress: false
}

/** Keys a migration derives; they stay out of the store's defaults, so a missing one reads as absent. */
const MIGRATED_KEYS = ['jobs'] as const

const STORE_DEFAULTS: Partial<AppConfig> = Object.fromEntries(
  Object.entries(DEFAULT_CONFIG).filter(([key]) => !(MIGRATED_KEYS as readonly string[]).includes(key))
)

const BUILD_SOURCES: readonly BuildSource[] = ['bundled', 'path', 'custom']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSelfTestRecord(value: unknown): SelfTestRecord | null {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.results) || typeof value.rev !== 'number') return null
  const { path: file, size, mtimeMs } = value.identity
  if (typeof file !== 'string' || typeof size !== 'number' || typeof mtimeMs !== 'number') return null
  const results: Partial<Record<SelfTestId, boolean>> = {}
  for (const [id, passed] of Object.entries(value.results)) {
    if (typeof passed !== 'boolean') return null
    results[id as SelfTestId] = passed
  }
  return { identity: { path: file, size, mtimeMs }, rev: value.rev, results: results as Record<SelfTestId, boolean> }
}

/**
 * Validates a stored `ffmpeg` block. Returns null when its source or paths
 * are unusable; a malformed self-test record reads as null, so the test runs again.
 */
export function readFfmpegConfig(value: unknown): FfmpegConfig | null {
  if (!isRecord(value)) return null
  const { source, buildId, ffmpegPath, ffprobePath } = value
  if (!BUILD_SOURCES.includes(source as BuildSource)) return null
  if (typeof ffmpegPath !== 'string' || ffmpegPath === '' || typeof ffprobePath !== 'string') return null
  if (buildId !== null && typeof buildId !== 'string') return null
  return { source: source as BuildSource, buildId, ffmpegPath, ffprobePath, selfTest: readSelfTestRecord(value.selfTest) }
}

function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Builds the `ffmpeg` block from what is stored. A valid block is kept as it
 * is; without one, the top-level paths of older versions become a block (a
 * binary under one of `bundledRoots` is the app's own install, anything else
 * was found on PATH). `changed` says whether the store needs the result
 * written back, so running it again on its own output changes nothing.
 */
export function migrateFfmpegConfig(
  stored: { ffmpeg?: unknown; ffmpegPath?: unknown; ffprobePath?: unknown },
  bundledRoots: readonly string[]
): { block: FfmpegConfig | null; changed: boolean } {
  const existing = readFfmpegConfig(stored.ffmpeg)
  if (existing) {
    return { block: existing, changed: JSON.stringify(existing) !== JSON.stringify(stored.ffmpeg) }
  }
  if (typeof stored.ffmpegPath === 'string' && stored.ffmpegPath !== '') {
    const ffmpegPath = stored.ffmpegPath
    const source: BuildSource = bundledRoots.some((root) => isInside(ffmpegPath, root)) ? 'bundled' : 'path'
    const ffprobePath = typeof stored.ffprobePath === 'string' ? stored.ffprobePath : ''
    return { block: { source, buildId: null, ffmpegPath, ffprobePath, selfTest: null }, changed: true }
  }
  return { block: null, changed: stored.ffmpeg !== null && stored.ffmpeg !== undefined }
}

/**
 * Removes the main-owned keys from a config or a partial save. The renderer's
 * config channels apply it to what they return and to what they receive;
 * anything that is not a plain object reads as an empty partial.
 */
export function stripMainOwned<T extends object>(config: T): Omit<T, MainOwnedKey> {
  if (!isRecord(config)) return {} as Omit<T, MainOwnedKey>
  const out: Record<string, unknown> = { ...config }
  for (const key of MAIN_OWNED_KEYS) delete out[key]
  return out as Omit<T, MainOwnedKey>
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Clamps a stored interface size to {@link INTERFACE_SCALE}; anything that is not a number reads as the default. */
export function clampInterfaceScale(value: unknown): number {
  return clamp(finiteOr(value, INTERFACE_SCALE.default), INTERFACE_SCALE)
}

const LOSSLESS_CODECS: readonly OutputCodec[] = ['flac', 'alac', 'pcm']

const LEGACY_CODECS: Record<string, OutputCodec | 'same-as-source'> = {
  '': 'same-as-source',
  inherit: 'same-as-source',
  copy: 'same-as-source',
  aac: 'aac',
  libfdk_aac: 'aac',
  mp3: 'mp3',
  libmp3lame: 'mp3',
  opus: 'opus',
  libopus: 'opus',
  vorbis: 'vorbis',
  libvorbis: 'vorbis',
  flac: 'flac',
  alac: 'alac',
  ac3: 'ac3',
  eac3: 'eac3'
}

function legacyCodec(value: unknown): OutputCodec | 'same-as-source' | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  if (name.startsWith('pcm')) return 'pcm'
  return Object.prototype.hasOwnProperty.call(LEGACY_CODECS, name) ? LEGACY_CODECS[name] : null
}

/** Reads a legacy bitrate ('256k', '256', or bits per second) as kb/s within the per-pair limits; null when unreadable. */
function legacyKbps(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(k)?\s*$/i.exec(text)
  if (!match) return null
  const amount = Number(match[1])
  const kbps = match[2] || amount < 10000 ? amount : amount / 1000
  if (kbps <= 0) return null
  return Math.round(clamp(kbps, AUDIO_LIMITS.kbpsPerPair))
}

/**
 * The output policy the legacy `audioCodec`, `fallbackCodec`, and `audioBitrate`
 * meant. A codec Normalize no longer offers (DTS, WMA) falls back to
 * `fallbackCodec`, and then to the source's own codec.
 */
export function legacyEncoderPolicy(audioCodec: unknown, fallbackCodec: unknown, audioBitrate: unknown): EncoderPolicy {
  const primary = legacyCodec(audioCodec)
  const codec = primary ?? legacyCodec(fallbackCodec) ?? 'same-as-source'
  if (codec === 'same-as-source') return { kind: 'same-as-source' }
  return { kind: 'codec', codec, kbpsPerPair: LOSSLESS_CODECS.includes(codec) ? null : legacyKbps(audioBitrate) }
}

/**
 * The Custom recipe a legacy `normalization { I, TP, LRA }` meant: I clamped to
 * the integrated range, TP to the true-peak range, LRA dropped. Unreadable
 * values read as the legacy defaults the old processors ran with.
 */
export function legacyCustomRecipe(normalization: unknown, output: EncoderPolicy): NormalizeRecipe {
  const legacy = isRecord(normalization) ? normalization : {}
  const recipe = applyLoudnessPreset('custom', output)
  recipe.target.integratedLufs = clamp(finiteOr(legacy.I, LEGACY_TARGET.I), AUDIO_LIMITS.integratedLufs)
  recipe.target.maxTruePeakDbtp = clamp(finiteOr(legacy.TP, LEGACY_TARGET.TP), AUDIO_LIMITS.maxTruePeakDbtp)
  return recipe
}

/**
 * The recipe new files get on the first start of this version. A new install gets the default loudness preset.
 * An upgrade gets the old global settings as the "Earlier default" user preset, so what the owner set keeps
 * applying and stays editable and removable like any preset.
 */
export function firstDefaultRecipe(stored: Pick<LegacyJobsKeys, 'normalization' | 'audioCodec' | 'fallbackCodec' | 'audioBitrate'>, upgrade: boolean): Recipe {
  if (!upgrade) {
    return applyLoudnessPreset(DEFAULT_LOUDNESS_PRESET, SAME_AS_SOURCE)
  }
  const output = legacyEncoderPolicy(stored.audioCodec, stored.fallbackCodec, stored.audioBitrate)
  return { ...legacyCustomRecipe(stored.normalization, output), userPreset: { ...EARLIER_DEFAULT_PRESET } }
}

type CountSetting = RunSettings['workers']

function readCount(value: unknown, range: { min: number; max: number }): CountSetting | null {
  if (!isRecord(value)) return null
  if (value.mode === 'auto') return value as CountSetting
  const count = value.count
  if (value.mode !== 'fixed' || typeof count !== 'number' || !Number.isInteger(count) || count < range.min || count > range.max) return null
  return value as CountSetting
}

function readOneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return options.includes(value as T) ? value as T : null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Equal to the CPU count (or the old automatic 0) becomes Auto; any other count stays fixed. */
export function legacyWorkers(maxWorkers: unknown, cpuCount: number): CountSetting {
  if (typeof maxWorkers !== 'number' || !Number.isFinite(maxWorkers)) return { mode: 'auto' }
  const count = Math.floor(maxWorkers)
  if (count <= 0 || count === cpuCount) return { mode: 'auto' }
  return { mode: 'fixed', count: clamp(count, WORKER_LIMITS.workers) }
}

function migrateRunSettings(value: unknown, stored: LegacyJobsKeys, cpuCount: number): RunSettings {
  const existing = isRecord(value) ? value : {}
  const notify = isRecord(existing.notify) ? existing.notify : {}
  const legacyNotify = readBool(stored.showNotifications) ?? DEFAULT_RUN_SETTINGS.notify.completion
  const defaults = DEFAULT_RUN_SETTINGS
  return {
    ...existing,
    workers: readCount(existing.workers, WORKER_LIMITS.workers) ?? legacyWorkers(stored.maxWorkers, cpuCount),
    gpuSessions: readCount(existing.gpuSessions, WORKER_LIMITS.gpuSessions) ?? { ...defaults.gpuSessions },
    priority: readOneOf(existing.priority, ['below-normal', 'normal'] as const) ?? defaults.priority,
    keepAwake: readBool(existing.keepAwake) ?? defaults.keepAwake,
    verifyVideo: readOneOf(existing.verifyVideo, ['full', 'sampled'] as const) ?? defaults.verifyVideo,
    notify: {
      ...notify,
      completion: readBool(notify.completion) ?? legacyNotify,
      firstFailure: readBool(notify.firstFailure) ?? legacyNotify
    },
    measureOnReview: readBool(existing.measureOnReview) ?? defaults.measureOnReview,
    includeSubfolders: readBool(existing.includeSubfolders) ?? defaults.includeSubfolders
  }
}

/** A stored default policy, when it is whole, valid, and not replace originals (which is never a persisted default). */
function readPolicy(value: unknown): BatchPolicy | null {
  if (!isRecord(value)) return null
  const { rev, ...policy } = value
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return null
  if (isRecord(policy.destination) && policy.destination.mode === 'replace-originals') return null
  return REQUEST_VALIDATORS.setPolicy({ policy }).ok ? value as unknown as BatchPolicy : null
}

function policyFor(destination: Destination, gpuAcceleration: unknown): BatchPolicy {
  return {
    rev: 0,
    destination,
    template: destination.mode === 'folder' ? DEFAULT_TEMPLATES.folder : DEFAULT_TEMPLATES['next-to-source'],
    conflict: 'rename',
    displaced: 'trash',
    gpu: gpuAcceleration === undefined || gpuAcceleration === 'off' ? 'off' : 'auto'
  }
}

/**
 * The default policy the legacy keys meant: Replace becomes next to source,
 * otherwise the old output folder (or `defaultFolder` when none was set), and
 * next to source when no folder is usable.
 */
export function legacyPolicy(stored: LegacyJobsKeys, defaultFolder: string): BatchPolicy {
  const nextToSource = policyFor({ mode: 'next-to-source' }, stored.gpuAcceleration)
  if (stored.afterProcessing === 'replace') return nextToSource
  const folders = [stored.outputDirectory, defaultFolder].filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '')
  for (const folder of folders) {
    const policy = policyFor({ mode: 'folder', folder }, stored.gpuAcceleration)
    if (readPolicy(policy)) return policy
  }
  return nextToSource
}

function readRecipe(value: unknown): Recipe | null {
  return validateRecipe(value).ok ? value as Recipe : null
}

function readRecentFolder(value: unknown): value is RecentFolder {
  if (!isRecord(value)) return false
  const { path: folder, name, files, addedAt } = value
  return typeof folder === 'string' && folder !== '' && typeof name === 'string' &&
    typeof files === 'number' && Number.isInteger(files) && files >= 0 && typeof addedAt === 'number' && Number.isFinite(addedAt)
}

function readRecentFolders(value: unknown): RecentFolder[] | null {
  if (!Array.isArray(value)) return null
  const folders = value.filter(readRecentFolder)
  return folders.length === value.length && folders.length <= MAX_RECENT_FOLDERS ? value : folders.slice(0, MAX_RECENT_FOLDERS)
}

function readAlerts(value: unknown): RunAlertKind[] | null {
  if (!Array.isArray(value)) return null
  const kinds = value.filter((kind): kind is RunAlertKind => RUN_ALERT_KINDS.includes(kind))
  return kinds.length === value.length ? value : [...new Set(kinds)]
}

/** The legacy keys the jobs migration reads, as stored. */
export interface LegacyJobsKeys {
  jobs?: unknown
  afterProcessing?: unknown
  outputDirectory?: unknown
  confirmReplace?: unknown
  maxWorkers?: unknown
  gpuAcceleration?: unknown
  showNotifications?: unknown
  normalization?: unknown
  audioCodec?: unknown
  fallbackCodec?: unknown
  audioBitrate?: unknown
}

/** What the jobs migration needs from the machine. */
export interface JobsMigrationContext {
  cpuCount: number
  /** `<Videos>/MolexMedia`, or '' when the Videos folder is unavailable. */
  defaultFolder: string
  /** The config file existed before this version first ran, so the legacy keys hold the owner's settings. */
  upgrade: boolean
}

/**
 * Builds the `jobs` key. Fields the engine wrote are kept as they are; only a
 * missing or unusable field is derived from the legacy keys. Deriving the
 * policy from a legacy Replace default queues the `replace-migrated` alert,
 * which {@link takeJobsAlerts} hands out once. `changed` says whether the
 * store needs the result written back.
 */
export function migrateJobsConfig(stored: LegacyJobsKeys, context: JobsMigrationContext): { jobs: JobsConfig; changed: boolean } {
  const existing = isRecord(stored.jobs) ? stored.jobs : {}
  const kept = readPolicy(existing.policy)
  const replaceMigrated = kept === null && stored.afterProcessing === 'replace'
  const jobs = {
    ...existing,
    settings: migrateRunSettings(existing.settings, stored, context.cpuCount),
    policy: kept ?? legacyPolicy(stored, context.defaultFolder),
    defaultRecipe: readRecipe(existing.defaultRecipe) ?? firstDefaultRecipe(stored, context.upgrade),
    recentFolders: readRecentFolders(existing.recentFolders) ?? [],
    pendingAlerts: readAlerts(existing.pendingAlerts) ?? (replaceMigrated ? ['replace-migrated'] : [])
  } as JobsConfig
  return { jobs, changed: JSON.stringify(jobs) !== JSON.stringify(stored.jobs) }
}

let Store: any

const STORE_NAME = 'molex-media-config'

/** Whether the config file existed when this process first opened it; null before then. */
let storeExisted: boolean | null = null

function storeFileExists(): boolean {
  try {
    return fs.existsSync(path.join(getUserDataPath(), `${STORE_NAME}.json`))
  } catch {
    return true
  }
}

/**
 * Lazily imports and instantiates the electron-store backed by
 * {@link DEFAULT_CONFIG} defaults, without the migrated keys. The first call
 * records whether the file existed, which tells a new install from an upgrade.
 * @returns The shared electron-store instance.
 */
async function getStore(): Promise<any> {
  if (!Store) {
    const mod = await import('electron-store')
    Store = mod.default
  }
  if (storeExisted === null) storeExisted = storeFileExists()
  return new Store({
    name: STORE_NAME,
    defaults: STORE_DEFAULTS
  })
}

function defaultOutputFolder(): string {
  try {
    return path.join(app.getPath('videos'), 'MolexMedia')
  } catch {
    return ''
  }
}

let cachedConfig: AppConfig | null = null

/** Folders holding the app's own FFmpeg installs, current and legacy. */
function bundledRoots(): string[] {
  return [getFFmpegRoot(), getFFmpegBinDir()]
}

/**
 * Loads the full configuration from disk, merging stored values over
 * {@link DEFAULT_CONFIG}. Auto-detects `maxWorkers` from CPU count
 * when the stored value is zero or negative.
 * @returns The merged application configuration.
 */
export async function loadConfig(): Promise<AppConfig> {
  const store = await getStore()
  cachedConfig = { ...DEFAULT_CONFIG }

  // Older versions stored overwriteOriginal as a boolean; afterProcessing replaced it.
  const legacy = store.get('overwriteOriginal')
  if (typeof legacy === 'boolean') {
    const migrated = legacy ? 'replace' : 'keep-both'
    store.set('afterProcessing', migrated)
    store.delete('overwriteOriginal')
  }
  for (const key of DROPPED_KEYS) {
    if (store.get(key) !== undefined) store.delete(key)
  }

  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]) {
    const val = store.get(key)
    if (val !== undefined) {
      ;(cachedConfig as any)[key] = val
    }
  }

  const ffmpeg = migrateFfmpegConfig(
    { ffmpeg: store.get('ffmpeg'), ffmpegPath: store.get('ffmpegPath'), ffprobePath: store.get('ffprobePath') },
    bundledRoots()
  )
  if (ffmpeg.changed) store.set('ffmpeg', ffmpeg.block)
  cachedConfig.ffmpeg = ffmpeg.block
  cachedConfig.ffmpegPath = ffmpeg.block?.ffmpegPath ?? ''
  cachedConfig.ffprobePath = ffmpeg.block?.ffprobePath ?? ''

  const legacyKeys = cachedConfig
  const os = await import('os')
  const cpuCount = os.cpus().length
  const jobs = migrateJobsConfig({
    jobs: store.get('jobs'),
    afterProcessing: legacyKeys.afterProcessing,
    outputDirectory: legacyKeys.outputDirectory,
    confirmReplace: legacyKeys.confirmReplace,
    maxWorkers: legacyKeys.maxWorkers,
    gpuAcceleration: legacyKeys.gpuAcceleration,
    showNotifications: legacyKeys.showNotifications,
    normalization: legacyKeys.normalization,
    audioCodec: legacyKeys.audioCodec,
    fallbackCodec: legacyKeys.fallbackCodec,
    audioBitrate: legacyKeys.audioBitrate
  }, { cpuCount, defaultFolder: defaultOutputFolder(), upgrade: storeExisted !== false })
  if (jobs.changed) store.set('jobs', jobs.jobs)
  cachedConfig.jobs = jobs.jobs

  cachedConfig.interfaceScale = clampInterfaceScale(cachedConfig.interfaceScale)
  cachedConfig.announceProgress = cachedConfig.announceProgress === true

  if (cachedConfig.maxWorkers <= 0) {
    cachedConfig.maxWorkers = Math.max(1, cpuCount)
  }
  if (!cachedConfig.outputDirectory) {
    cachedConfig.outputDirectory = defaultOutputFolder()
  }
  return cachedConfig
}

/**
 * Persists a partial configuration update to disk and reloads the
 * full configuration so the in-memory cache stays current. The
 * `ffmpegPath` and `ffprobePath` mirrors are never written from a
 * partial; an `ffmpeg` block writes them together with itself.
 * @param partial - Key/value pairs to merge into the stored config.
 * @returns The reloaded configuration after saving.
 */
export async function saveConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const store = await getStore()
  for (const [key, val] of Object.entries(partial)) {
    if ((READ_ONLY_MIRRORS as readonly string[]).includes(key)) continue
    if ((DROPPED_KEYS as readonly string[]).includes(key)) continue
    if (key === 'ffmpeg') {
      const block = readFfmpegConfig(val)
      store.set('ffmpeg', block)
      store.set('ffmpegPath', block?.ffmpegPath ?? '')
      store.set('ffprobePath', block?.ffprobePath ?? '')
      continue
    }
    store.set(key, val)
  }
  cachedConfig = null
  return loadConfig()
}

/**
 * Records the FFmpeg build the app uses, with its mirrors. Main only; the
 * renderer's config channels strip this key.
 * @param block - The build, or null to forget it.
 * @returns The reloaded configuration.
 */
export async function saveFfmpegConfig(block: FfmpegConfig | null): Promise<AppConfig> {
  return saveConfig({ ffmpeg: block })
}

/**
 * Merges engine-written fields into the `jobs` key. Main only; the renderer's
 * config channels strip this key.
 * @param patch - The fields to replace.
 * @returns The `jobs` key as reloaded.
 */
export async function saveJobsConfig(patch: Partial<JobsConfig>): Promise<JobsConfig> {
  const config = await getConfig()
  return (await saveConfig({ jobs: { ...config.jobs, ...patch } })).jobs
}

/**
 * Hands out the alerts a migration queued for the engine and clears them, so
 * each is raised once.
 * @returns The queued alert kinds, oldest first.
 */
export async function takeJobsAlerts(): Promise<RunAlertKind[]> {
  const config = await getConfig()
  const alerts = config.jobs.pendingAlerts
  if (alerts.length === 0) return []
  await saveJobsConfig({ pendingAlerts: [] })
  return alerts
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

/** Returns the directory older versions installed FFmpeg into; still read, never written. */
export function getFFmpegBinDir(): string {
  return path.join(getUserDataPath(), 'ffmpeg-bin')
}

/** Returns the directory holding one folder per installed FFmpeg build (`<userData>/ffmpeg/<build id>`). */
export function getFFmpegRoot(): string {
  return path.join(getUserDataPath(), 'ffmpeg')
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

export { DEFAULT_CONFIG }
