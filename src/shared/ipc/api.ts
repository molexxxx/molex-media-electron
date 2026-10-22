/**
 * The typed bridge between the renderer and main: everything the preload exposes on `window.api`. The preload
 * implements it and the renderer's `Window` declares it, so both sides compile against the same type.
 */

import type { JobsApi } from '../jobs/contract'
import type { StageId } from '../jobs/types'
import type { PlayerMedia, PlayRoute } from '../player/media'

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
export type FfmpegSelfTestId =
  | 'chain-flac-s16' | 'chain-opus-51side' | 'chain-aac-mono' | 'meter-dual-mono' | 'meter-surround' | 'soxr' | 'encoders'

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
    /** The first failing test that disables the pipeline; soxr and meter-surround never appear here. */
    failedTest: FfmpegSelfTestId | null
    results: Record<FfmpegSelfTestId, boolean> | null
    testedAt: number | null
    durationMs: number | null
  }
  refusal: string | null
  pin:
  {
    /** The FFmpeg release pinned for this platform, which can differ from other platforms'. */
    version: string
    /** True when the bundled build is one of this app's pinned builds. */
    matches: boolean
    /** True when the build in use, or the one found, is not this app's pinned build, so the tested one can replace it. */
    offerInstall: boolean
    installLabel: string
  }
  /** An FFmpeg on PATH that passes every required check but is not used until someone chooses it in setup. */
  pathBuild?: { version: string; ffmpegPath: string } | null
}

/** Why an FFmpeg download or install stopped, so setup can name the problem and the way out. */
export type SetupProblemKind =
  | 'offline' | 'stalled' | 'unavailable' | 'server' | 'checksum' | 'disk-full' | 'no-access' | 'rejected' | 'unknown'

/** A stopped download or install: its kind, the HTTP status when a server answered, and the original message. */
export interface SetupProblem
{
  kind: SetupProblemKind
  status: number | null
  detail: string
}

/** The answer of `ffmpeg:installPinned`: the build information after the attempt, and the error when it failed. */
export type FfmpegInstallResult =
  | { ok: true; info: FfmpegInfo }
  | { ok: false; error: string; info: FfmpegInfo; problem?: SetupProblem }

/** One progress report of the FFmpeg install, as `onDownloadProgress` delivers it. */
export interface FfmpegDownloadProgress
{
  stage: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error'
  message: string
  percent: number
  detail?: string
  /** Bytes received so far, while downloading. */
  received?: number
  /** Bytes of the whole download, while downloading. */
  total?: number
}

/** The tested build this computer would download: its size and who publishes it. */
export interface FfmpegDownloadFacts
{
  bytes: number
  publisher: string
  host: string
}

/** Why a chosen folder's FFmpeg was not used. */
export type FfmpegFolderRefusal = 'missing' | 'not-running' | 'minimum' | 'self-test'

/** The answer of `ffmpeg:adoptFolder`: the build information once adopted, or why the folder was refused. */
export type FfmpegFolderResult =
  | { status: 'adopted'; info: FfmpegInfo }
  | { status: 'refused'; folder: string; reason: FfmpegFolderRefusal; version: string | null; failedTest: FfmpegSelfTestId | null }

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

/** Where the yt-dlp in use comes from: the copy molexMedia downloads and updates, or one found on PATH that another tool manages. */
export type YtDlpSource = 'app' | 'system'

/** Why a yt-dlp check, download, or update stopped. */
export type YtDlpProblem =
  | 'offline' | 'rate-limited' | 'server' | 'no-build' | 'checksum' | 'signature' | 'not-starting' | 'in-use' | 'disk' | 'unknown'

/** What the yt-dlp updater is doing. `updated` and `up-to-date` follow a check made since the app started. */
export type YtDlpUpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
    kind: 'updating'
    /** Downloading the release, verifying its checksum, signature, and that it starts, or waiting for yt-dlp to stop running before the swap. */
    phase: 'downloading' | 'verifying' | 'waiting'
    version: string
    receivedBytes: number
    totalBytes: number | null
  }
  | { kind: 'up-to-date' }
  | { kind: 'updated'; from: string | null; to: string }
  | { kind: 'failed'; problem: YtDlpProblem; reason: string; at: number }

/** The yt-dlp section's data, as `ytdlp:status` and `ytdlp:status-changed` carry it. */
export interface YtDlpStatus
{
  installed: boolean
  /** The version the binary reports, or null when it is missing or does not start. */
  version: string | null
  source: YtDlpSource | null
  path: string | null
  /** The "Update yt-dlp automatically" setting; it never applies to a copy on PATH. */
  autoUpdate: boolean
  /** The "Use the yt-dlp found on this computer" setting; off means the app's own copy, installed when missing. */
  useSystem: boolean
  /** The copy found on PATH, whether or not it is in use, so the choice above is informed. */
  onPath: { path: string; version: string | null } | null
  /** When a check last reached GitHub, in epoch milliseconds. */
  lastCheckAt: number | null
  /** The newest stable release a check found this session, with the download size for this computer when known. */
  latest: { version: string; bytes: number | null } | null
  state: YtDlpUpdateState
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

/** The answer of `editor:thumbnailStrip`. */
export type ThumbnailStripResult =
  | { success: true; interval: number; frames: string[] }
  | { success: false; error: string }

/** The answer of `editor:keyframes`: the first video stream's keyframe times in seconds. */
export type KeyframeTimesResult =
  | { success: true; times: number[] }
  | { success: false; error: string }

/** The answer of `editor:probeReport`: ffprobe's JSON report of the file's format, streams, and chapters, as printed. */
export type ProbeReportResult =
  | { success: true; report: string }
  | { success: false; error: string }

/** A URL the user resolved before. */
export interface UrlHistoryEntry
{
  url: string
  title: string
  trackCount: number
  addedAt: number
}

/** Where the player's picture comes from: a URL, whether FFmpeg decodes it while it plays, the source time it starts at, and the encoder FFmpeg hands it over with. */
export interface PictureSource
{
  url: string
  live: boolean
  offset: number
  /** The encoder of a picture FFmpeg decodes, such as h264_nvenc or libx264; null when Chromium reads the stream itself. */
  encoder: string | null
}

/** How a picture FFmpeg decodes is sized and encoded: the display in physical pixels, the frame rate, and software only after a hardware failure. */
export interface PictureOptions
{
  width?: number
  height?: number
  fps?: number | null
  software?: boolean
}

/** A link's picture, served by the local server: a progressive file, a video-only DASH stream, or a merged download. */
export interface LinkPicture
{
  kind: 'progressive' | 'dash' | 'download'
  url: string
  width: number | null
  height: number | null
  codec: string
  fps: number | null
  /** True when the picture's file carries sound too; the player keeps it muted and follows the sound element. */
  hasSound: boolean
}

/** Where getting a link's picture stands: asking yt-dlp, or downloading a merged file with a percent. */
export interface LinkProgress
{
  pageUrl: string
  stage: 'resolving' | 'downloading'
  percent: number | null
}

/** A video codec family the renderer's Chromium decodes. */
export type VideoCodecFamily = 'avc1' | 'vp9' | 'av01'

/** What each player channel answers with when it succeeds. */
export interface PlayerPayloads
{
  media: PlayerMedia
  url: string
  picture: PictureSource
  vtt: string
  link: LinkPicture
}

/** A player channel's answer: its payload under its own key, or the error message. */
export type PlayerResult<K extends keyof PlayerPayloads> = ({ ok: true } & { [P in K]: PlayerPayloads[P] }) | { ok: false; error: string }

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
  onDownloadProgress: (cb: (progress: FfmpegDownloadProgress) => void) => () => void
  /** The size and publisher of the tested build for this computer, or null when the pin has none for it. */
  getFFmpegDownloadFacts: () => Promise<FfmpegDownloadFacts | null>
  /** Opens a folder picker for an FFmpeg already on this computer; null when it is canceled. */
  chooseFFmpegFolder: () => Promise<string | null>
  /** Self-tests the FFmpeg in a folder, or its bin folder, and adopts it when jobs can run on it. */
  adoptFFmpegFolder: (folder: string) => Promise<FfmpegFolderResult>

  openFiles: () => Promise<string[]>
  openDirectory: () => Promise<string | null>
  selectOutputDir: () => Promise<string | null>
  selectSavePath: (defaultName: string, filters: DialogFilter[]) => Promise<string | null>

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
  /** Closes the pop-out, which hands its state back, and shows the main window on the Player. */
  returnPlayerToApp: () => Promise<void>
  /** Probes a file and plans how the player plays each audio track; the renderer plans the picture with its own decoder. */
  inspectMedia: (filePath: string) => Promise<PlayerResult<'media'>>
  /** One audio track as a URL the audio element plays: the file itself on the direct route, else extracted, from `seekTime` on when given. */
  getSoundUrl: (filePath: string, audioIndex: number, seekTime: number | null, route?: PlayRoute) => Promise<PlayerResult<'url'>>
  /** The picture as it is, repackaged, or decoded by FFmpeg from `seekTime` on, as the plan's route says. */
  getPictureUrl: (filePath: string, streamIndex: number, route: PlayRoute, seekTime: number, options?: PictureOptions) => Promise<PlayerResult<'picture'>>
  /** One text subtitle stream as WebVTT. */
  getSubtitles: (filePath: string, streamIndex: number) => Promise<PlayerResult<'vtt'>>
  /** A link's picture no taller than `maxHeight`, in a codec family the renderer named; a download when no direct stream qualifies. */
  getLinkPicture: (pageUrl: string, maxHeight: number, codecs: VideoCodecFamily[], options?: { download?: boolean }) => Promise<PlayerResult<'link'>>
  /** Progress of getting a link's picture, while a download runs. */
  onLinkProgress: (cb: (progress: LinkProgress) => void) => () => void

  cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: CutOptions) => Promise<any>
  probeDetailed: (filePath: string) => Promise<any>
  remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => Promise<{ success: boolean; outputPath?: string; error?: string }>
  createPreview: (filePath: string) => Promise<{ success: boolean; previewUrl?: string; data?: string; error?: string }>
  createAudioPreview: (filePath: string) => Promise<{ success: boolean; data?: string; error?: string }>
  exportTimeline: (request: any) => Promise<{ success: boolean; outputPath?: string; error?: string }>
  cancelExport: () => Promise<{ success: boolean; error?: string }>
  extractThumbnail: (filePath: string, timeSec: number) => Promise<{ success: boolean; data?: string; error?: string }>
  extractThumbnailStrip: (filePath: string, durationSeconds: number) => Promise<ThumbnailStripResult>
  keyframeTimes: (filePath: string) => Promise<KeyframeTimesResult>
  probeReport: (filePath: string) => Promise<ProbeReportResult>
  extractWaveform: (filePath: string, numSamples?: number) => Promise<{ success: boolean; data?: number[]; error?: string }>
  onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => () => void

  resolvePlaylist: (url: string) => Promise<{ success: boolean; entries: any[]; error?: string }>
  /** A link's sound as a URL the audio element plays: the best direct stream proxied, or, with `download`, the whole track fetched into the cache first. */
  getStreamUrl: (videoUrl: string, quality?: string, options?: { download?: boolean }) => Promise<{ success: boolean; mediaUrl?: string; title?: string; duration?: number | null; downloaded?: boolean; error?: string }>
  getInstalledBrowsers: () => Promise<CookieBrowser[]>
  setCookieBrowser: (browserName: string) => Promise<{ success: boolean; error?: string | null }>
  clearCookies: () => Promise<{ success: boolean }>
  getCookieInfo: () => Promise<CookieInfo>
  /** The yt-dlp in use, where it comes from, and what its updater is doing. */
  getYtDlpStatus: () => Promise<YtDlpStatus>
  /**
   * Checks for a newer yt-dlp now and installs it, or the first copy when none is installed; a copy on PATH is
   * never changed. With `install: false` it only looks up the latest release and its size. Answers the status after.
   */
  checkYtDlpUpdates: (options?: { install?: boolean }) => Promise<YtDlpStatus>
  /** Every change of the yt-dlp status, including download progress. */
  onYtDlpStatus: (cb: (status: YtDlpStatus) => void) => () => void

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
  /** Puts this window in or out of full screen; answers the state the window reports. */
  setFullScreen: (on: boolean) => Promise<boolean>
  isFullScreen: () => Promise<boolean>
  /** Each change of this window's full screen state, from the window itself. */
  onFullScreenChanged: (cb: (on: boolean) => void) => () => void
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
