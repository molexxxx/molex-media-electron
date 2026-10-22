/**
 * @module preload/index
 * @description Electron preload script - secure bridge between renderer and main.
 *
 * Exposes a curated `window.api` object to the renderer via
 * `contextBridge.exposeInMainWorld`, typed as `WindowApi` so the renderer
 * and this file compile against the same contract. Each method is a thin
 * wrapper around `ipcRenderer.invoke`, `ipcRenderer.send`, or
 * `ipcRenderer.on`; the `jobs` section is generated from `JOB_CHANNELS`.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from 'electron'
import { JOB_CHANNELS, JOB_EVENT_CHANNEL, type JobEventBatch, type JobsApi } from '../shared/jobs/contract'
import { clampZoomFactor, steppedZoomLevel, type LogEntry, type LogQuery, type LinkProgress, type LinkStreamRequest, type PictureOptions, type VideoCodecFamily, type WindowApi, type YtDlpStatus } from '../shared/ipc/api'
import type { PlayRoute } from '../shared/player/media'

/** One wrapper per job command, each invoking its channel with the request object, plus the event subscription. */
function buildJobsApi(): JobsApi {
  const commands = Object.fromEntries(
    Object.entries(JOB_CHANNELS).map(([name, channel]) => [name, (req: unknown) => ipcRenderer.invoke(channel, req)])
  )
  const onEvents = (cb: (batch: JobEventBatch) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, batch: JobEventBatch): void => cb(batch)
    ipcRenderer.on(JOB_EVENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(JOB_EVENT_CHANNEL, listener)
  }
  return { ...commands, onEvents } as JobsApi
}

/** Applies a zoom level to this window's page and answers the resulting zoom factor. */
function applyZoomLevel(level: number): number {
  webFrame.setZoomLevel(level)
  return webFrame.getZoomFactor()
}

const api: WindowApi = {
  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (partial: any) => ipcRenderer.invoke('config:save', partial),
  getConfig: () => ipcRenderer.invoke('config:get'),

  // FFmpeg
  checkFFmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
  downloadFFmpeg: () => ipcRenderer.invoke('ffmpeg:download'),
  getFFmpegVersion: () => ipcRenderer.invoke('ffmpeg:version'),
  getFFmpegInfo: () => ipcRenderer.invoke('ffmpeg:info'),
  rerunFFmpegSelfTest: () => ipcRenderer.invoke('ffmpeg:selfTest'),
  installPinnedFFmpeg: () => ipcRenderer.invoke('ffmpeg:installPinned'),
  onDownloadProgress: (cb: (progress: any) => void) => {
    const listener = (_: any, progress: any) => cb(progress)
    ipcRenderer.on('ffmpeg:download-progress', listener)
    return () => ipcRenderer.removeListener('ffmpeg:download-progress', listener)
  },
  getFFmpegDownloadFacts: () => ipcRenderer.invoke('ffmpeg:downloadFacts'),
  chooseFFmpegFolder: () => ipcRenderer.invoke('ffmpeg:chooseFolder'),
  adoptFFmpegFolder: (folder: string) => ipcRenderer.invoke('ffmpeg:adoptFolder', folder),

  // File dialogs
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectOutputDir: () => ipcRenderer.invoke('dialog:selectOutputDir'),
  selectSavePath: (defaultName: string, filters: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('dialog:selectSavePath', defaultName, filters),

  // Editor
  cutMedia: (filePath: string, inPoint: number, outPoint: number, options?: { mode?: 'fast' | 'precise'; outputFormat?: string; gifOptions?: { loop?: boolean; loopCount?: number; fps?: number; width?: number; dither?: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'; bayerScale?: number; highQuality?: boolean; reverse?: boolean; boomerang?: boolean }; videoOptions?: { codec?: string; crf?: number; preset?: string; maxHeight?: number; audioBitrate?: string } }) => ipcRenderer.invoke('editor:cut', filePath, inPoint, outPoint, options),
  probeDetailed: (filePath: string) => ipcRenderer.invoke('editor:probeDetailed', filePath),
  remuxMedia: (filePath: string, options: { keepStreams: number[]; metadata?: Record<string, string>; dispositions?: Record<number, Record<string, number>> }) => ipcRenderer.invoke('editor:remux', filePath, options),
  createPreview: (filePath: string) => ipcRenderer.invoke('editor:createPreview', filePath),
  createAudioPreview: (filePath: string) => ipcRenderer.invoke('editor:createAudioPreview', filePath),
  exportTimeline: (request: any) => ipcRenderer.invoke('editor:export', request),
  cancelExport: () => ipcRenderer.invoke('editor:cancelExport'),
  extractThumbnail: (filePath: string, timeSec: number) => ipcRenderer.invoke('editor:thumbnail', filePath, timeSec),
  extractThumbnailStrip: (filePath: string, durationSeconds: number) => ipcRenderer.invoke('editor:thumbnailStrip', filePath, durationSeconds),
  keyframeTimes: (filePath: string) => ipcRenderer.invoke('editor:keyframes', filePath),
  probeReport: (filePath: string) => ipcRenderer.invoke('editor:probeReport', filePath),
  extractWaveform: (filePath: string, numSamples?: number) => ipcRenderer.invoke('editor:waveform', filePath, numSamples),
  onEditorProgress: (cb: (progress: { percent: number; message: string }) => void) => {
    const listener = (_: any, progress: any) => cb(progress)
    ipcRenderer.on('editor:progress', listener)
    return () => ipcRenderer.removeListener('editor:progress', listener)
  },

  // File utilities
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  registerLocalFile: (filePath: string) => ipcRenderer.invoke('files:registerLocalFile', filePath),
  seekLocalFile: (filePath: string, seekTime: number) => ipcRenderer.invoke('files:seekLocalFile', filePath, seekTime),
  clearPlaybackCache: (filePath: string) => ipcRenderer.invoke('files:clearPlaybackCache', filePath),
  readFileBuffer: (filePath: string) => ipcRenderer.invoke('files:readFileBuffer', filePath),
  getKnownFolders: () => ipcRenderer.invoke('files:knownFolders'),
  browseDirectory: (dirPath: string) => ipcRenderer.invoke('files:browse', dirPath),

  // Popout player
  popoutPlayer: (state?: any) => ipcRenderer.invoke('player:popout', state),
  isPopout: () => ipcRenderer.invoke('player:isPopout'),
  togglePin: () => ipcRenderer.invoke('player:togglePin'),
  isPinned: () => ipcRenderer.invoke('player:isPinned'),
  resizePopout: (width: number, height: number, save?: boolean) => ipcRenderer.invoke('player:resize', width, height, save),
  getPopoutSize: () => ipcRenderer.invoke('player:getSize'),
  returnPlayerState: (state: any) => ipcRenderer.send('player:returnState', state),
  onPopoutClosed: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('player:popout-closed', listener)
    return () => ipcRenderer.removeListener('player:popout-closed', listener)
  },
  onReceivePlayerState: (cb: (state: any) => void) => {
    const listener = (_: any, state: any) => cb(state)
    ipcRenderer.on('player:receiveState', listener)
    return () => ipcRenderer.removeListener('player:receiveState', listener)
  },
  getPlayerState: () => ipcRenderer.invoke('player:getPendingState'),
  returnPlayerToApp: () => ipcRenderer.invoke('player:returnToApp'),
  inspectMedia: (filePath: string) => ipcRenderer.invoke('player:inspect', filePath),
  getSoundUrl: (filePath: string, audioIndex: number, seekTime: number | null, route?: PlayRoute) => ipcRenderer.invoke('player:soundUrl', filePath, audioIndex, seekTime, route),
  getPictureUrl: (filePath: string, streamIndex: number, route: PlayRoute, seekTime: number, options?: PictureOptions) => ipcRenderer.invoke('player:pictureUrl', filePath, streamIndex, route, seekTime, options),
  getSubtitles: (filePath: string, streamIndex: number) => ipcRenderer.invoke('player:subtitles', filePath, streamIndex),
  getLinkPicture: (pageUrl: string, maxHeight: number, codecs: VideoCodecFamily[], options?: { download?: boolean }) => ipcRenderer.invoke('player:linkPicture', pageUrl, maxHeight, codecs, options),
  onLinkProgress: (cb: (progress: LinkProgress) => void) => {
    const listener = (_: IpcRendererEvent, progress: LinkProgress) => cb(progress)
    ipcRenderer.on('player:linkProgress', listener)
    return () => ipcRenderer.removeListener('player:linkProgress', listener)
  },
  getLinkStream: (pageUrl: string, request: LinkStreamRequest) => ipcRenderer.invoke('player:linkStream', pageUrl, request),

  // YouTube / yt-dlp
  resolvePlaylist: (url: string) => ipcRenderer.invoke('ytdlp:resolve', url),
  getStreamUrl: (videoUrl: string, quality?: string, options?: { download?: boolean }) => ipcRenderer.invoke('ytdlp:getStreamUrl', videoUrl, quality, options),
  getInstalledBrowsers: () => ipcRenderer.invoke('ytdlp:getInstalledBrowsers'),
  setCookieBrowser: (browserName: string) => ipcRenderer.invoke('ytdlp:setBrowser', browserName),
  clearCookies: () => ipcRenderer.invoke('ytdlp:clearCookies'),
  getCookieInfo: () => ipcRenderer.invoke('ytdlp:cookieInfo'),
  getYtDlpStatus: () => ipcRenderer.invoke('ytdlp:status'),
  checkYtDlpUpdates: (options?: { install?: boolean }) => ipcRenderer.invoke('ytdlp:checkUpdates', options),
  onYtDlpStatus: (cb: (status: YtDlpStatus) => void) => {
    const listener = (_: IpcRendererEvent, status: YtDlpStatus) => cb(status)
    ipcRenderer.on('ytdlp:status-changed', listener)
    return () => ipcRenderer.removeListener('ytdlp:status-changed', listener)
  },

  // Logs
  getLogBuffer: (query?: LogQuery) => ipcRenderer.invoke('logs:getBuffer', query),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogDir: () => ipcRenderer.invoke('logs:openDir'),
  onLogEntries: (cb: (entries: LogEntry[]) => void) => {
    const listener = (_: IpcRendererEvent, entries: LogEntry[]) => cb(entries)
    ipcRenderer.on('logs:entries', listener)
    return () => ipcRenderer.removeListener('logs:entries', listener)
  },

  // System
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  getGpuInfo: () => ipcRenderer.invoke('system:gpu'),
  getGpuUsage: () => ipcRenderer.invoke('system:gpuUsage'),
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // URL History
  getUrlHistory: () => ipcRenderer.invoke('history:get'),
  removeUrlHistory: (url: string) => ipcRenderer.invoke('history:remove', url),
  clearUrlHistory: () => ipcRenderer.invoke('history:clear'),

  // Window controls
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  setFullScreen: (on: boolean) => ipcRenderer.invoke('window:setFullScreen', on),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  onFullScreenChanged: (cb: (on: boolean) => void) => {
    const listener = (_: IpcRendererEvent, on: boolean) => cb(on)
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
  },
  showTextContextMenu: () => ipcRenderer.send('context-menu:text'),
  onCloseConfirm: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('close:confirm', listener)
    return () => ipcRenderer.removeListener('close:confirm', listener)
  },
  closeConfirmResponse: (action: 'minimize' | 'quit', dontAskAgain: boolean) =>
    ipcRenderer.send('close:response', action, dontAskAgain),

  // Navigation (from tray context menu)
  onNavigate: (cb: (view: string) => void) => {
    const listener = (_: any, view: string) => cb(view)
    ipcRenderer.on('navigate', listener)
    return () => ipcRenderer.removeListener('navigate', listener)
  },

  // Page zoom, in the zoom menu roles' steps
  zoomIn: () => applyZoomLevel(steppedZoomLevel(webFrame.getZoomLevel(), 1)),
  zoomOut: () => applyZoomLevel(steppedZoomLevel(webFrame.getZoomLevel(), -1)),
  setZoomFactor: (factor: number) => {
    webFrame.setZoomFactor(clampZoomFactor(factor))
    return webFrame.getZoomFactor()
  },
  getZoomFactor: () => webFrame.getZoomFactor(),

  // Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:get-status'),
  onUpdaterStatus: (cb: (status: any) => void) => {
    const listener = (_: any, status: any) => cb(status)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },

  // Job engine
  jobs: buildJobsApi()
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { api: WindowApi }).api = api
}
