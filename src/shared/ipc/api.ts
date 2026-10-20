/**
 * The typed bridge between the renderer and main: everything the preload exposes on `window.api`. The preload
 * implements it and the renderer's `Window` declares it, so both sides compile against the same type.
 */

import type { JobsApi } from '../jobs/contract'
import type { StageId } from '../jobs/types'

/** A file-type filter of a save dialog. */
export interface DialogFilter
{
  name: string
  extensions: string[]
}

/** The severity of one log line. */
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'

/** One line of main's log buffer as it crosses IPC. */
export interface LogEntry
{
  /** Monotonic for the life of the main process; a clear never reuses an id. */
  id: number
  timestamp: string
  level: LogLevel
  message: string
  details?: string
  jobId?: string
  runId?: string
  attempt?: number
  stage?: StageId
  kind?: 'message' | 'cmd' | 'stderr' | 'event'
}

/** Which buffered log entries to return; every field narrows the result. */
export interface LogQuery
{
  /** Only entries with a greater id. */
  afterId?: number
  jobId?: string
  runId?: string
}

/** Where an FFmpeg build was found. */
export type FfmpegBuildSource = 'bundled' | 'path' | 'custom'

/** One self-test run against an FFmpeg build. */
export type FfmpegSelfTestId = 'chain-flac-s16' | 'chain-opus-51side' | 'chain-aac-mono' | 'meter-dual-mono' | 'soxr' | 'encoders'

/** The Settings FFmpeg section's data, as `ffmpeg:info` answers it. */
export interface FfmpegInfo
{
  found: boolean
  usable: boolean
  version: string | null
  versionString: string | null
  source: FfmpegBuildSource | null
  ffmpegPath: string | null
  ffprobePath: string | null
  libsoxr: boolean
  meetsMinimum: boolean
  selfTest:
  {
    status: 'passed' | 'failed' | 'not-run' | null
    /** The first failing test that disables the pipeline. */
    failedTest: FfmpegSelfTestId | null
    results: Record<FfmpegSelfTestId, boolean> | null
    testedAt: number | null
    durationMs: number | null
  }
  refusal: string | null
  pin:
  {
    version: string
    /** True when the bundled build is one of this app's pinned builds. */
    matches: boolean
    /** True when a bundled build differs from the pin. */
    offerInstall: boolean
    installLabel: string
  }
}

/** The answer of `ffmpeg:installPinned`: the build information after the attempt, and the error when it failed. */
export type FfmpegInstallResult =
  | { ok: true; info: FfmpegInfo }
  | { ok: false; error: string; info: FfmpegInfo }

/** A worker count change as the old batch processor reports it. */
export interface WorkerStatus
{
  target: number
  active: number
}

/** A browser yt-dlp can read cookies from. */
export interface CookieBrowser
{
  name: string
  label: string
}

/** The exported cookie file's state. */
export interface CookieInfo
{
  exists: boolean
  age: number | null
  browser: string
}

/** One queued file of the old batch processor. */
export interface LegacyTaskSpec
{
  filePath: string
  operation: string
  outputDir?: string
  boostPercent?: number
  normalizeOptions?: any
  convertOptions?: any
  extractOptions?: any
  compressOptions?: any
}

/** Options of an editor cut. */
export interface CutOptions
{
  mode?: 'fast' | 'precise'
  outputFormat?: string
  gifOptions?:
  {
    loop?: boolean
    loopCount?: number
    fps?: number
    width?: number
    dither?: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
    bayerScale?: number
    highQuality?: boolean
    reverse?: boolean
    boomerang?: boolean
  }
  videoOptions?: { codec?: string; crf?: number; preset?: string; maxHeight?: number; audioBitrate?: string }
}

/** One segment of an editor merge. */
export interface MergeSegment
{
  path: string
  inPoint: number
  outPoint: number
  audioReplacement?: { path: string; offset: number; trimIn: number; trimOut: number }
}

/** The answer of `editor:thumbnailStrip`. */
export type ThumbnailStripResult =
  | { success: true; interval: number; frames: string[] }
  | { success: false; error: string }

/** A URL the user resolved before. */
export interface UrlHistoryEntry
{
  url: string
  title: string
  trackCount: number
  addedAt: number
}

/** One zoom step in Chromium zoom levels, the step of the zoom menu roles. */
export const ZOOM_LEVEL_STEP = 0.5

/** Chromium's page zoom factor limits. */
export const ZOOM_FACTOR_MIN = 0.25
export const ZOOM_FACTOR_MAX = 5

/** The Chromium zoom level of a zoom factor: each level scales by 1.2. */
export function zoomLevelOf(factor: number): number
{
  return Math.log(factor) / Math.log(1.2)
}

/** A zoom factor kept inside Chromium's limits; anything not a positive finite number is 1. */
export function clampZoomFactor(factor: number): number
{
  if (!Number.isFinite(factor) || factor <= 0)
  {
    return 1
  }
  return Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, factor))
}

/** The zoom level one step in (1) or out (-1) from `level`, kept inside Chromium's zoom factor limits. */
export function steppedZoomLevel(level: number, direction: 1 | -1): number
{
  const from = Number.isFinite(level) ? level : 0
  const next = from + direction * ZOOM_LEVEL_STEP
  return Math.min(zoomLevelOf(ZOOM_FACTOR_MAX), Math.max(zoomLevelOf(ZOOM_FACTOR_MIN), next))
}

/** Everything the preload exposes on `window.api`. */
export interface WindowApi
{
  loadConfig: () => Promise<any>
  saveConfig: (partial: any) => Promise<any>
  getConfig: () => Promise<any>

  checkFFmpeg: () => Promise<{ found: boolean; version?: string; ffmpeg?: string; ffprobe?: string }>
  downloadFFmpeg: () => Promise<{ success: boolean; version?: string; error?: string; ffmpeg?: string; ffprobe?: string }>
  getFFmpegVersion: () => Promise<string>
  /** Version, source, libsoxr, minimum, self-test results, and the pinned build of the FFmpeg in use. */
  getFFmpegInfo: () => Promise<FfmpegInfo>
  /** Runs the self-test again on the current build and answers the refreshed information. */
  rerunFFmpegSelfTest: () => Promise<FfmpegInfo>
  /** Installs the tested build; progress arrives through `onDownloadProgress`. */
  installPinnedFFmpeg: () => Promise<FfmpegInstallResult>
  onDownloadProgress: (cb: (progress: any) => void) => () => void

  openFiles: () => Promise<string[]>
  openDirectory: () => Promise<string | null>
  selectOutputDir: () => Promise<string | null>
  selectSavePath: (defaultName: string, filters: DialogFilter[]) => Promise<string | null>
  scanDirectory: (dirPath: string) => Promise<{ path: string; name: string; size: number; ext: string }[]>
  probeFile: (filePath: string) => Promise<any>

  getFilePath: (file: File) => string
  registerLocalFile: (filePath: string) => Promise<string>
  seekLocalFile: (filePath: string, seekTime: number) => Promise<string>
  clearPlaybackCache: (filePath: string) => Promise<void>
  readFileBuffer: (filePath: string) => Promise<ArrayBuffer>
  getKnownFolders: () => Promise<{ name: string; path: string; icon: string }[]>
  browseDirectory: (dirPath: string) => Promise<{ success: boolean; entries: { name: string; path: string; isDirectory: boolean; size: number; ext: string }[]; parentPath: string; error?: string }>

  popoutPlayer: (state?: any) => Promise<void>
  isPopout: () => Promise<boolean>
  togglePin: () => Promise<boolean>
  isPinned: () => Promise<boolean>
  resizePopout: (width: number, height: number, save?: boolean) => Promise<void>
  getPopoutSize: () => Promise<{ width: number; height: number }>
  returnPlayerState: (state: any) => void
  onPopoutClosed: (cb: () => void) => () => void
  onReceivePlayerState: (cb: (state: any) => void) => () => void
  getPlayerState: () => Promise<any>

  normalize: (filePaths: string[], normalizeOptions?: { I: number; TP: number; LRA: number }, outputDir?: string) => Promise<any>
  boost: (filePaths: string[], percent: number, outputDir?: string) => Promise<any>
  convert: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
  extract: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
  compress: (filePaths: string[], options: any, outputDir?: string) => Promise<any>
  startBatchQueue: (taskSpecs: LegacyTaskSpec[], maxWorkers?: number) => Promise<any>
  cancelBatch: (batchId: string) => Promise<boolean>
  cancelAll: () => Promise<boolean>
  getActiveCount: () => Promise<number>
  pauseProcessing: () => Promise<void>
  resumeProcessing: () => Promise<void>
  getIsPaused: () => Promise<boolean>
  setWorkers: (count: number) => Promise<number>
  getWorkerStatus: () => Promise<WorkerStatus>
  onWorkerStatus: (cb: (status: WorkerStatus) => void) => () => void
  onPaused: (cb: () => void) => () => void
  onResumed: (cb: () => void) => () => void
  onBatchStarted: (cb: (data: any) => void) => () => void
  onTaskProgress: (cb: (task: any) => void) => () => void
  onBatchComplete: (cb: (data: any) => void) => () => void

  cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: CutOptions) => Promise<any>
  mergeMedia: (segments: MergeSegment[], options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; fps?: number; width?: number } }) => Promise<any>
  probeDetailed: (filePath: string) => Promise<any>
  remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => Promise<{ success: boolean; outputPath?: string; error?: string }>
  replaceAudio: (videoPath: string, audioPath: string, options?: { outputDir?: string; audioOffset?: number; inPoint?: number; outPoint?: number }) => Promise<any>
  createPreview: (filePath: string) => Promise<{ success: boolean; previewUrl?: string; data?: string; error?: string }>
  createAudioPreview: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
  exportTimeline: (request: any) => Promise<{ success: boolean; outputPath?: string; error?: string }>
  cancelExport: () => Promise<{ success: boolean; error?: string }>
  extractThumbnail: (filePath: string, timeSec: number) => Promise<{ success: boolean; data?: string; error?: string }>
  extractThumbnailStrip: (filePath: string, durationSeconds: number) => Promise<ThumbnailStripResult>
  extractWaveform: (filePath: string, numSamples?: number) => Promise<{ success: boolean; data?: number[]; error?: string }>
  onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => () => void

  resolvePlaylist: (url: string) => Promise<{ success: boolean; entries: any[]; error?: string }>
  getStreamUrl: (videoUrl: string, quality?: string) => Promise<{ success: boolean; mediaUrl?: string; title?: string; duration?: number | null; error?: string }>
  getInstalledBrowsers: () => Promise<CookieBrowser[]>
  setCookieBrowser: (browserName: string) => Promise<{ success: boolean; error?: string | null }>
  clearCookies: () => Promise<{ success: boolean }>
  getCookieInfo: () => Promise<CookieInfo>

  /** The buffered log entries matching the query; with no query, the whole buffer. */
  getLogBuffer: (query?: LogQuery) => Promise<LogEntry[]>
  clearLogs: () => Promise<void>
  openLogDir: () => Promise<void>
  /** New log entries in batches, at most one batch every 100 ms. */
  onLogEntries: (cb: (entries: LogEntry[]) => void) => () => void

  getSystemInfo: () => Promise<any>
  getGpuInfo: () => Promise<{ mode: string; label: string; vendor: string; pending: boolean; gpuModel: string | null }>
  getGpuUsage: () => Promise<{ usage: number | null }>
  showInFolder: (filePath: string) => Promise<void>
  openExternal: (url: string) => Promise<void>

  getUrlHistory: () => Promise<UrlHistoryEntry[]>
  removeUrlHistory: (url: string) => Promise<UrlHistoryEntry[]>
  clearUrlHistory: () => Promise<void>

  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  showTextContextMenu: () => void
  onCloseConfirm: (cb: () => void) => () => void
  closeConfirmResponse: (action: 'minimize' | 'quit', dontAskAgain: boolean) => void
  onNavigate: (cb: (view: string) => void) => () => void
  /** Zooms this window's page one step in; answers the new zoom factor. */
  zoomIn: () => number
  /** Zooms this window's page one step out; answers the new zoom factor. */
  zoomOut: () => number
  /** Sets this window's page zoom (1 is 100 percent), kept inside Chromium's limits; answers the factor applied. */
  setZoomFactor: (factor: number) => number
  getZoomFactor: () => number

  checkForUpdates: () => Promise<{ success: boolean; version?: string; error?: string }>
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>
  installUpdate: () => Promise<void>
  getUpdaterStatus: () => Promise<{ status: string; version?: string; error?: string; percent?: number }>
  onUpdaterStatus: (cb: (status: any) => void) => () => void

  /** The job engine: one method per `JOB_CHANNELS` command, and `onEvents` for `jobs:event`. */
  jobs: JobsApi
}
