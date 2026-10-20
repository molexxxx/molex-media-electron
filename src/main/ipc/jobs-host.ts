/**
 * The Electron side of the job engine: the renderer location the command gate trusts, window lookup, parented
 * dialogs, the clipboard file list, notifications, taskbar progress, power save, the tray bridge, the cached FFmpeg
 * build, and the factory that builds the engine's real dependencies. Nothing here starts the engine.
 */

import { app, BrowserWindow, clipboard, dialog, nativeImage, Notification, powerSaveBlocker, shell, webContents } from 'electron'
import type { FileFilter, WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { execFile } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { AudioAnalysis, StaticJobPlan } from '../../shared/audio/events'
import type { BoostRecipe, NormalizeRecipe } from '../../shared/audio/types'
import type { JobCommandName } from '../../shared/jobs/contract'
import { MEDIA_EXTENSIONS } from '../../shared/jobs/extensions'
import type { CapabilitySummary, JobView, RecentFolder, RunAlertKind, RunSettings } from '../../shared/jobs/types'
import { toPlatform, type Platform } from '../../shared/text/platform'
import { getConfig, getFFmpegBinDir, getFFmpegRoot, saveFfmpegConfig, saveJobsConfig, takeJobsAlerts, type JobsConfig } from '../config'
import { analyzeAudioJob, planAudioJob, planStatic } from '../ffmpeg/audio/job'
import { containerFor } from '../ffmpeg/audio/containers'
import type { BuildCapabilities } from '../ffmpeg/audio/encoders'
import { planAlbum, type AlbumMember } from '../ffmpeg/audio/plan'
import { downloadFFmpeg, inspectBuild, type BootstrapProgress } from '../ffmpeg/bootstrap'
import {
  cachedSelfTest, configBlock, discoveryCandidates, displayVersion, parsePin, pinKey, pinnedVersion, pipelineRefusal, selectAssets, selfTestFailure, SELF_TEST_REV,
  type BinaryIdentity, type BuildCandidate, type BuildSource, type FfmpegBuildInfo, type PinnedBuilds, type SelfTestId, type SelfTestRecord
} from '../ffmpeg/build'
import { createExec, type Exec } from '../ffmpeg/exec'
import { detectGpuSummary, resetGpuDetection, type GpuMode, type GpuSummary } from '../ffmpeg/gpu'
import pinJson from '../ffmpeg/pinned-builds.json'
import { createProbe, type Probe } from '../ffmpeg/probe'
import type { ClipboardContent } from '../jobs/commands/queue'
import type { EventSender, JobLogger, JobsHost, QuitChoice, TrayStatus } from '../jobs/deps'
import type { EngineAudio, EngineDeps, EngineParts, EngineShell, JobEngine } from '../jobs/engine'
import { createFsOps } from '../jobs/fsops'
import { createNodeHistoryFs } from '../jobs/history'
import { createNodePersistenceIO } from '../jobs/persistence'
import { surroundMeterIssues } from '../jobs/planner'
import { createPlannerIO, createVolumeQueries } from '../jobs/planner-io'
import { createProbeQueue } from '../jobs/probe-queue'
import { audioInput, createBoostRunner, createNormalizeRunner, endingText, expectedKey, measurementOf, renderMessages } from '../jobs/runners/audio'
import { createCompressRunner } from '../jobs/runners/compress'
import { createConvertRunner, pathExists } from '../jobs/runners/convert'
import { createExtractRunner, makeFrameFolder } from '../jobs/runners/extract'
import { QUIT_BUTTONS } from '../jobs/status'
import { rendererLocationFrom, type RendererLocation } from '../jobs/trust'
import { createVolumeRegistry } from '../jobs/volumes'
import { createNodeWorkDirFiles } from '../jobs/workdirs'
import { logger } from '../logger'
import { realTimers } from '../timers'
import { initFFmpegDir } from '../ytdlp/binary'
import { rememberBuild } from './system'

/** The platform the engine plans for. */
export function hostPlatform(): Platform
{
  return toPlatform(process.platform)
}

/** The packaged renderer page, as a file URL. */
export function rendererIndexUrl(mainDir: string = __dirname): string
{
  return pathToFileURL(path.join(mainDir, '../renderer/index.html')).href
}

/** The renderer the command gate trusts: the dev server in development, the packaged index.html otherwise. */
export function jobsRendererLocation(): RendererLocation
{
  return rendererLocationFrom(is.dev ? process.env['ELECTRON_RENDERER_URL'] : null, rendererIndexUrl())
}

/** Whether a window shows the popout player rather than the main shell. */
export function isPopoutUrl(url: string): boolean
{
  try
  {
    return new URL(url).hash === '#popout'
  }
  catch
  {
    return false
  }
}

/** The main window: the first live window that is not the popout player. */
export function findMainWindow(): BrowserWindow | null
{
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !isPopoutUrl(w.webContents.getURL())) ?? null
}

/** The window that sent an invoke; null when it is gone. */
export function parentWindowOf(sender: WebContents | null | undefined): BrowserWindow | null
{
  if (!sender || sender.isDestroyed())
  {
    return null
  }
  const win = BrowserWindow.fromWebContents(sender)
  return win && !win.isDestroyed() ? win : null
}

let dialogOpen = false

/**
 * Runs one native picker at a time. While one is open, another request answers `fallback` at once, so a second
 * picker never opens behind the first.
 */
export async function exclusiveDialog<T>(fallback: T, open: () => Promise<T>): Promise<T>
{
  if (dialogOpen)
  {
    return fallback
  }
  dialogOpen = true
  try
  {
    return await open()
  }
  finally
  {
    dialogOpen = false
  }
}

/** The open dialog's filters: the shared media extension list, then every file. */
export function mediaFileFilters(): FileFilter[]
{
  return [
    { name: 'Media files', extensions: [...MEDIA_EXTENSIONS] },
    { name: 'All files', extensions: ['*'] }
  ]
}

let lastPickedFolder: string | null = null

/** Remembers a folder the user picked, for the next folder picker. */
export function notePickedFolder(folder: string | null | undefined): void
{
  if (folder)
  {
    lastPickedFolder = folder
  }
}

/** Where the folder picker opens: the most recently added folder, else the last folder picked this session. */
export function mostRecentFolder(recent: readonly RecentFolder[], picked: string | null = lastPickedFolder): string | undefined
{
  const newest = [...recent].sort((a, b) => b.addedAt - a.addedAt)[0]
  return newest?.path ?? picked ?? undefined
}

/** The paths of a `text/uri-list` or GNOME copied-files payload; comments, the copy verb, and other schemes are skipped. */
export function uriListPaths(text: string, platform: Platform): string[]
{
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('file://')).flatMap((l) =>
  {
    try
    {
      return [fileURLToPath(l, { windows: platform === 'win32' })]
    }
    catch
    {
      return []
    }
  })
}

/** The paths of a macOS `NSFilenamesPboardType` property list. */
export function plistPaths(xml: string): string[]
{
  const decode = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => decode(m[1])).filter(Boolean)
}

/** The lines of the Windows file-drop list query, one full path per line. */
export function dropListPaths(stdout: string): string[]
{
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** The first path of a Windows `FileNameW` buffer, which holds only the first file of a copied list. */
export function fileNameWPath(buffer: Buffer): string | null
{
  const text = buffer.toString('utf16le').replace(/\0[\s\S]*$/, '')
  return text.length > 0 ? text : null
}

/** The PowerShell query that prints the Windows clipboard's whole file-drop list as UTF-8, one path per line. */
export const DROP_LIST_SCRIPT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'

/** What the clipboard reader reads through; Electron's clipboard and a child process in the app. */
export interface ClipboardSource
{
  formats(): string[]
  read(format: string): string
  readBuffer(format: string): Buffer
  readText(): string
  /** The Windows file-drop list query's output; rejects when PowerShell cannot run. */
  windowsDropList(): Promise<string>
}

/**
 * The clipboard as the paste command reads it: the platform's file list first, then text. Electron exposes only
 * the first file of a Windows file-drop list (`FileNameW`), so Windows reads the whole list through PowerShell and
 * falls back to that first file when the query fails.
 */
export async function readClipboardContent(platform: Platform, source: ClipboardSource): Promise<ClipboardContent>
{
  const text = source.readText()
  const formats = source.formats()
  if (platform === 'win32')
  {
    if (!formats.includes('text/uri-list'))
    {
      return { files: [], text }
    }
    try
    {
      return { files: dropListPaths(await source.windowsDropList()), text }
    }
    catch (err)
    {
      logger.warn(`Could not read the copied file list: ${err instanceof Error ? err.message : String(err)}`)
      const first = fileNameWPath(source.readBuffer('FileNameW'))
      return { files: first === null ? [] : [first], text }
    }
  }
  if (platform === 'darwin')
  {
    const listed = plistPaths(source.read('NSFilenamesPboardType'))
    if (listed.length > 0)
    {
      return { files: listed, text }
    }
    return { files: uriListPaths(source.read('public.file-url'), platform), text }
  }
  const uris = uriListPaths(source.read('text/uri-list'), platform)
  return { files: uris.length > 0 ? uris : uriListPaths(source.read('x-special/gnome-copied-files'), platform), text }
}

/** Runs a program without a shell and hidden, resolving its stdout; rejects on a spawn failure, a nonzero exit, or the timeout. */
export function runHidden(file: string, args: readonly string[], timeoutMs: number): Promise<string>
{
  return new Promise((resolve, reject) =>
  {
    execFile(file, [...args], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
    {
      if (err)
      {
        reject(err)
        return
      }
      resolve(stdout)
    })
  })
}

/** The Windows PowerShell executable under `%SystemRoot%`. */
export function windowsPowerShell(systemRoot: string | undefined = process.env['SystemRoot']): string
{
  return path.win32.join(systemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Electron's clipboard, with the Windows file-drop list read through PowerShell. */
export function electronClipboard(): ClipboardSource
{
  return {
    formats: () => clipboard.availableFormats(),
    read: (format) => clipboard.read(format),
    readBuffer: (format) => clipboard.readBuffer(format),
    readText: () => clipboard.readText(),
    windowsDropList: () => runHidden(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-STA', '-Command', DROP_LIST_SCRIPT], 10000)
  }
}

/** Logs an engine command that threw; the gate already answered it with `internal`. */
export function logUnexpected(name: JobCommandName, err: unknown): void
{
  const detail = err instanceof Error ? err.stack ?? err.message : String(err)
  logger.error(`Job command ${name} failed unexpectedly`, detail)
}

/** The app icon notifications show; inside the app archive when packaged, beside the repository in development. */
export function appIconPath(mainDir: string = __dirname): string
{
  return path.join(mainDir, '../../resources/icon.png')
}

/** The event bus's view of one webContents: sends while it lives, and reports its navigations and its end. */
export function webContentsSender(contents: WebContents): EventSender
{
  return {
    id: contents.id,
    send: (channel, batch) =>
    {
      if (!contents.isDestroyed())
      {
        contents.send(channel, batch)
      }
    },
    isDestroyed: () => contents.isDestroyed(),
    onNavigate: (listener) =>
    {
      const crossDocument = (_e: unknown, _url: string, _code: number, _status: string, isMainFrame: boolean): void =>
        listener({ isMainFrame, isSameDocument: false })
      const inPage = (_e: unknown, _url: string, isMainFrame: boolean): void => listener({ isMainFrame, isSameDocument: true })
      contents.on('did-frame-navigate', crossDocument)
      contents.on('did-navigate-in-page', inPage)
      return () =>
      {
        contents.removeListener('did-frame-navigate', crossDocument)
        contents.removeListener('did-navigate-in-page', inPage)
      }
    },
    onDestroyed: (listener) =>
    {
      contents.once('destroyed', listener)
      return () => contents.removeListener('destroyed', listener)
    }
  }
}

/** How the quit dialog's answer maps to a choice; an aborted or unknown answer keeps running. */
export function quitChoiceOf(response: number, aborted: boolean): QuitChoice
{
  return aborted ? 'keep-running' : QUIT_BUTTONS[response]?.choice ?? 'keep-running'
}

/** The cancel confirmation's buttons; the first is the default and the cancel choice. */
export const CANCEL_BATCH_BUTTONS: readonly string[] = ['Keep running', 'Cancel batch']

/** The view a notification click opens. */
export const BATCH_VIEW = 'batch'

/** What the host is built over; the defaults are the app's own windows and quit. */
export interface ElectronJobsHostOptions
{
  mainWindow?: () => BrowserWindow | null
  /** Shows or recreates the main window, optionally on a view. */
  showMainWindow?: (view?: string) => void
  quit?: () => void
}

/** The real host, plus the late bindings the app wires once the engine and the tray exist. */
export interface ElectronJobsHost extends JobsHost
{
  /** The engine a notification click focuses. */
  attach(engine: Pick<JobEngine, 'focus'>): void
  /** The tray renderer; the last status is replayed to a renderer bound later. */
  bindTray(render: ((status: TrayStatus) => void) | null): void
  lastTrayStatus(): TrayStatus | null
}

/** The Electron host the engine reports to: notifications, taskbar progress, power save, the tray, and the quit dialogs. */
export function createElectronJobsHost(options: ElectronJobsHostOptions = {}): ElectronJobsHost
{
  const mainWindow = options.mainWindow ?? findMainWindow
  const showMain = options.showMainWindow ?? ((): void =>
  {
    const win = mainWindow()
    win?.show()
    win?.focus()
  })
  let engine: Pick<JobEngine, 'focus'> | null = null
  let tray: ((status: TrayStatus) => void) | null = null
  let trayStatus: TrayStatus | null = null
  let blocker: number | null = null
  const shown = new Set<Notification>()

  const parentForDialog = (): BrowserWindow | null =>
  {
    const win = mainWindow()
    if (win && win.isVisible())
    {
      return win
    }
    showMain()
    return mainWindow()
  }

  return {
    rendererLocation: jobsRendererLocation,
    logUnexpected,
    sender(senderId)
    {
      const contents = webContents.fromId(senderId)
      return contents && !contents.isDestroyed() ? webContentsSender(contents) : null
    },
    mainWindow()
    {
      const win = mainWindow()
      return win ? { visible: win.isVisible(), focused: win.isFocused() } : null
    },
    showMainWindow: () => showMain(),
    notify(notification)
    {
      if (!Notification.isSupported())
      {
        return
      }
      try
      {
        const n = new Notification({ title: notification.title, body: notification.body, icon: nativeImage.createFromPath(appIconPath()) })
        shown.add(n)
        n.on('click', () =>
        {
          shown.delete(n)
          showMain(BATCH_VIEW)
          engine?.focus(notification.focus.jobId, notification.focus.runId)
        })
        n.on('close', () => shown.delete(n))
        n.show()
      }
      catch (err)
      {
        logger.warn(`Could not show a notification: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    setTaskbarProgress(progress)
    {
      const win = mainWindow()
      if (!win)
      {
        return
      }
      if (progress === null)
      {
        win.setProgressBar(-1)
        return
      }
      win.setProgressBar(progress.mode === 'error' ? 1 : Math.min(1, Math.max(0, progress.fraction)), { mode: progress.mode })
    },
    setKeepAwake(on)
    {
      if (on && blocker === null)
      {
        blocker = powerSaveBlocker.start('prevent-app-suspension')
      }
      else if (!on && blocker !== null)
      {
        if (powerSaveBlocker.isStarted(blocker))
        {
          powerSaveBlocker.stop(blocker)
        }
        blocker = null
      }
    },
    setTrayStatus(status)
    {
      trayStatus = status
      tray?.(status)
    },
    async askQuit(prompt, signal)
    {
      const win = parentForDialog()
      if (!win || signal?.aborted)
      {
        return 'keep-running'
      }
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        message: prompt.message,
        detail: prompt.detail,
        buttons: QUIT_BUTTONS.map((b) => b.label),
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal
      })
      return quitChoiceOf(result.response, signal?.aborted ?? false)
    },
    async confirmCancelBatch(prompt)
    {
      const win = parentForDialog()
      if (!win)
      {
        return false
      }
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        message: prompt.message,
        detail: prompt.detail,
        buttons: [...CANCEL_BATCH_BUTTONS],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
    },
    quit: () => (options.quit ?? (() => app.quit()))(),
    attach(next)
    {
      engine = next
    },
    bindTray(render)
    {
      tray = render
      if (render && trayStatus)
      {
        render(trayStatus)
      }
    },
    lastTrayStatus: () => trayStatus
  }
}

/** The build the app inspected last: the adopted one, or the first refused one when none passed. */
export interface FfmpegBuildState
{
  info: FfmpegBuildInfo | null
  candidate: BuildCandidate | null
  /** True when the pipeline runs on this build. */
  adopted: boolean
  /** Why the pipeline cannot run on this build; null when it can or no build was found. */
  refusal: string | null
  /** When this session last ran the self-test on the build, and how long the run took; null when it came from the cache. */
  testedAt: number | null
  testMs: number | null
  /** Bumped whenever the build or its self-test results change. */
  rev: number
}

/** What `ffmpeg:info` answers: the Settings FFmpeg section's data. */
export interface FfmpegInfo
{
  found: boolean
  usable: boolean
  version: string | null
  versionString: string | null
  source: BuildSource | null
  ffmpegPath: string | null
  ffprobePath: string | null
  libsoxr: boolean
  meetsMinimum: boolean
  selfTest:
  {
    status: 'passed' | 'failed' | 'not-run' | null
    /** The first failing test that disables the pipeline; soxr and meter-surround only narrow what runs and never appear here. */
    failedTest: SelfTestId | null
    results: Record<SelfTestId, boolean> | null
    testedAt: number | null
    durationMs: number | null
  }
  refusal: string | null
  pin:
  {
    version: string
    /** True when the bundled build is one of this app's pinned builds. */
    matches: boolean
    /** True when a bundled build differs from the pin; PATH and custom builds are never offered a replacement. */
    offerInstall: boolean
    installLabel: string
  }
}

const SELF_TEST_MEMO = new Map<string, Record<SelfTestId, boolean>>()
let buildState: FfmpegBuildState = { info: null, candidate: null, adopted: false, refusal: null, testedAt: null, testMs: null, rev: 0 }
const buildListeners = new Set<(state: FfmpegBuildState) => void>()

function identityKey(identity: BinaryIdentity): string
{
  return `${identity.path}|${identity.size}|${identity.mtimeMs}`
}

async function identityOf(file: string): Promise<BinaryIdentity | null>
{
  try
  {
    const st = await fs.promises.stat(file)
    return st.isFile() ? { path: file, size: st.size, mtimeMs: st.mtimeMs } : null
  }
  catch
  {
    return null
  }
}

async function folderNames(dir: string): Promise<string[]>
{
  try
  {
    return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  }
  catch
  {
    return []
  }
}

/** This app's pinned FFmpeg builds. */
export function pinnedBuilds(): PinnedBuilds
{
  return parsePin(pinJson)
}

/** The install folder names of this platform's pinned builds. */
export function pinnedBuildIds(pin: PinnedBuilds, platform: NodeJS.Platform, arch: string): string[]
{
  const assets = selectAssets(pin, platform, arch)
  return assets ? [assets.primary[0]?.build, assets.fallback[0]?.build].filter((id): id is string => typeof id === 'string') : []
}

/** The Settings offer for a pinned version, as "Install FFmpeg 9.0.x (tested with this version)". */
export function installLabel(version: string): string
{
  const [major, minor] = version.split('.')
  return `Install FFmpeg ${major}.${minor ?? '0'}.x (tested with this version)`
}

/** The `ffmpeg:info` answer for a build state, the FFmpeg release pinned for this platform, and its build ids. */
export function ffmpegInfoOf(state: FfmpegBuildState, version: string, pinnedIds: readonly string[]): FfmpegInfo
{
  const info = state.info
  const bundled = state.candidate?.source === 'bundled'
  const matches = bundled && state.candidate?.buildId != null && pinnedIds.includes(state.candidate.buildId)
  const failedTest = info && info.meetsMinimum ? selfTestFailure(info.selfTest) : null
  const ran = info !== null && info.meetsMinimum
  return {
    found: info !== null,
    usable: state.adopted,
    version: info ? displayVersion(info.versionString) : null,
    versionString: info?.versionString ?? null,
    source: state.candidate?.source ?? null,
    ffmpegPath: info?.ffmpegPath ?? null,
    ffprobePath: info?.ffprobePath ?? null,
    libsoxr: info?.soxr ?? false,
    meetsMinimum: info?.meetsMinimum ?? false,
    selfTest: {
      status: info === null ? null : !ran ? 'not-run' : failedTest === null ? 'passed' : 'failed',
      failedTest,
      results: info ? { ...info.selfTest } : null,
      testedAt: state.testedAt,
      durationMs: state.testMs
    },
    refusal: state.refusal,
    pin: { version, matches, offerInstall: bundled && !matches, installLabel: installLabel(version) }
  }
}

/** The current build state. */
export function currentBuildState(): FfmpegBuildState
{
  return buildState
}

/** Reports every later build change; returns a function that stops reporting. */
export function onBuildChange(listener: (state: FfmpegBuildState) => void): () => void
{
  buildListeners.add(listener)
  return () => buildListeners.delete(listener)
}

function setBuildState(next: Omit<FfmpegBuildState, 'rev'>): FfmpegBuildState
{
  buildState = { ...next, rev: buildState.rev + 1 }
  for (const listener of buildListeners)
  {
    try
    {
      listener(buildState)
    }
    catch (err)
    {
      logger.warn(`A build change listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return buildState
}

interface Inspected
{
  candidate: BuildCandidate
  info: FfmpegBuildInfo
  ran: boolean
  ms: number | null
}

/**
 * Inspects one candidate, running the self-test only when neither the config's record nor this session's memo
 * holds results for the binary's identity (path, size, modification time); `force` always runs it.
 */
async function inspectCandidate(candidate: BuildCandidate, configured: SelfTestRecord | null, force: boolean): Promise<Inspected | null>
{
  const identity = await identityOf(candidate.ffmpegPath)
  if (!identity)
  {
    return null
  }
  const memo = SELF_TEST_MEMO.get(identityKey(identity))
  const record: SelfTestRecord | null = force
    ? null
    : cachedSelfTest(configured, identity) ? configured : memo ? { identity, rev: SELF_TEST_REV, results: memo } : null
  const started = Date.now()
  const info = await inspectBuild(candidate, record)
  if (!info)
  {
    return null
  }
  const ran = record === null && info.meetsMinimum
  if (ran)
  {
    SELF_TEST_MEMO.set(identityKey(info.identity), { ...info.selfTest })
  }
  return { candidate, info, ran, ms: ran ? Date.now() - started : null }
}

/** Records an accepted build in config with its self-test, points yt-dlp and GPU detection at it, and caches its version. */
async function adoptBuild(candidate: BuildCandidate, info: FfmpegBuildInfo): Promise<void>
{
  const block = configBlock(candidate, info)
  const config = await getConfig()
  if (JSON.stringify(config.ffmpeg) !== JSON.stringify(block))
  {
    await saveFfmpegConfig(block)
    resetGpuDetection()
  }
  await initFFmpegDir()
  rememberBuild(info)
}

function stateOf(found: Inspected | null, adopted: boolean): Omit<FfmpegBuildState, 'rev'>
{
  const previous = buildState
  const same = found !== null && previous.info !== null && identityKey(previous.info.identity) === identityKey(found.info.identity)
  return {
    info: found?.info ?? null,
    candidate: found?.candidate ?? null,
    adopted,
    refusal: found ? pipelineRefusal(found.info) : null,
    testedAt: found?.ran ? Date.now() : same ? previous.testedAt : null,
    testMs: found?.ran ? found.ms : same ? previous.testMs : null
  }
}

/**
 * The `ffmpeg:check` path: tries the configured build, this pin's installed folders, the older install folder,
 * then PATH, and adopts the first one the pipeline can run on. Each binary identity runs the self-test once: a
 * passing result is cached in the `ffmpeg` config block, a failing one for the session. When none passes, the first
 * build found stays inspected but not adopted, so its failing test disables the pipeline by name. Build checks,
 * self-test runs, and installs run one at a time.
 */
export function checkFfmpeg(): Promise<FfmpegBuildState>
{
  return serialBuild(check)
}

/** `ffmpeg:selfTest`: runs the self-test again on the inspected build; a pass is cached, a failure disables the pipeline. */
export function rerunSelfTest(): Promise<FfmpegBuildState>
{
  return serialBuild(rerun)
}

/** `ffmpeg:installPinned` and `ffmpeg:download`: installs the pinned build through the bootstrap, then adopts it. */
export function installPinnedFfmpeg(onProgress: (progress: BootstrapProgress) => void): Promise<FfmpegBuildState>
{
  return serialBuild(async () =>
  {
    await downloadFFmpeg(onProgress)
    return check()
  })
}

let buildChain: Promise<unknown> = Promise.resolve()

function serialBuild<T>(task: () => Promise<T>): Promise<T>
{
  const run = buildChain.then(task, task)
  buildChain = run.catch(() => undefined)
  return run
}

async function check(): Promise<FfmpegBuildState>
{
  const config = await getConfig()
  const root = getFFmpegRoot()
  const candidates = discoveryCandidates({
    configured: config.ffmpeg,
    pin: pinnedBuilds(),
    platform: process.platform,
    arch: process.arch,
    root,
    installed: await folderNames(root),
    legacyDir: getFFmpegBinDir(),
    envPath: process.env['PATH']
  })
  let first: Inspected | null = null
  for (const candidate of candidates)
  {
    const found = await inspectCandidate(candidate, config.ffmpeg?.selfTest ?? null, false)
    if (!found)
    {
      continue
    }
    first ??= found
    const refusal = pipelineRefusal(found.info)
    if (refusal)
    {
      logger.warn(`Skipping FFmpeg at ${candidate.ffmpegPath}: ${refusal}`)
      continue
    }
    await adoptBuild(candidate, found.info)
    logger.success(`Using FFmpeg ${displayVersion(found.info.versionString)} (${candidate.source}) at ${candidate.ffmpegPath}`)
    return setBuildState(stateOf(found, true))
  }
  return setBuildState(stateOf(first, false))
}

async function rerun(): Promise<FfmpegBuildState>
{
  const candidate = buildState.candidate
  if (!candidate)
  {
    return check()
  }
  const found = await inspectCandidate(candidate, null, true)
  if (!found)
  {
    return check()
  }
  const refusal = pipelineRefusal(found.info)
  if (refusal === null)
  {
    await adoptBuild(candidate, found.info)
  }
  else
  {
    logger.warn(`FFmpeg at ${candidate.ffmpegPath} failed its self-test: ${refusal}`)
  }
  return setBuildState(stateOf(found, refusal === null))
}

/** The `ffmpeg:info` answer for the current build. */
export function ffmpegInfo(): FfmpegInfo
{
  const pin = pinnedBuilds()
  return ffmpegInfoOf(buildState, pinnedVersion(pin, pinKey(process.platform, process.arch)), pinnedBuildIds(pin, process.platform, process.arch))
}

/** The minimum FFmpeg version as plan messages name it. */
export const MINIMUM_FFMPEG_VERSION = '5.1'

/** A build with no encoders, for the planner while no FFmpeg is available. */
export const NO_BUILD: BuildCapabilities = { encoders: new Set(), experimental: new Set(), soxr: false }

/** What the engine knows of a build: its encoders, the experimental ones it never picks, and the soxr meter. */
export function buildCapabilitiesOf(info: Pick<FfmpegBuildInfo, 'encoders' | 'experimental' | 'soxr'> | null): BuildCapabilities
{
  return info ? { encoders: info.encoders, experimental: info.experimental, soxr: info.soxr } : NO_BUILD
}

/**
 * The capability summary for a build state and GPU detection. A failing self-test leaves the binary ready but
 * marks the self-test failed, which blocks every job in the plan; soxr false only switches the meters to swr, and
 * surroundMeter false only blocks loudness jobs that meter more than two channels.
 */
export function capabilitySummary(o: { build: FfmpegBuildState; gpu: GpuSummary | null; rev: number; cores: number; platform: Platform }): CapabilitySummary
{
  const info = o.build.info
  const failed = info && info.meetsMinimum ? selfTestFailure(info.selfTest) : null
  return {
    rev: o.rev,
    ffmpeg: {
      ready: info !== null,
      version: info ? displayVersion(info.versionString) : null,
      source: o.build.candidate?.source ?? null,
      meetsMinimum: info?.meetsMinimum ?? false,
      selfTest: info === null ? null : !info.meetsMinimum ? 'pending' : failed === null ? 'passed' : 'failed',
      soxr: info?.soxr ?? false,
      surroundMeter: info?.surroundMeter ?? false
    },
    encoders: info ? [...info.encoders].filter((e) => !info.experimental.has(e)).sort() : [],
    gpu: o.gpu === null
      ? { status: 'detecting', vendor: null, name: null, encoders: [] }
      : { status: 'ready', vendor: o.gpu.vendor, name: o.gpu.name, encoders: [...o.gpu.encoders] },
    cpuCount: o.cores,
    platform: o.platform
  }
}

/** The GPU mode detection runs in: the configured vendor when one is forced, else automatic. */
export function detectionMode(setting: GpuMode | undefined): GpuMode
{
  return setting === 'nvenc' || setting === 'qsv' || setting === 'amf' ? setting : 'auto'
}

/** The OS priority value of a run's priority setting. */
export function osPriority(priority: RunSettings['priority']): number
{
  return priority === 'below-normal' ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL
}

/** The id the audio measurement cache keys on: the build's source and version string. */
export function buildIdOf(info: Pick<FfmpegBuildInfo, 'source' | 'versionString'> | null): string
{
  return info ? `${info.source}:${info.versionString}` : 'none'
}

/** The report save dialog's filters, the default path's own format first. */
export function reportFilters(defaultPath: string): FileFilter[]
{
  const csv = { name: 'CSV report', extensions: ['csv'] }
  const json = { name: 'JSON report', extensions: ['json'] }
  return path.extname(defaultPath).toLowerCase() === '.json' ? [json, csv] : [csv, json]
}

/** The output a preview analysis plans for: the job's planned container, else the source's own. */
export function analysisOutput(view: Pick<JobView, 'plan' | 'source'>): { container: string; muxer: string }
{
  const target = containerFor(view.plan?.container ?? view.source.ext)
  return { container: target.name, muxer: target.muxer ?? target.name }
}

/** One album member as the album plan reads it: the first planned stream's measurement and ceiling. */
export function albumMemberOf(jobId: string, analysis: AudioAnalysis, staticPlan: StaticJobPlan): AlbumMember
{
  const stream = staticPlan.streams[0]
  if (stream === undefined)
  {
    throw new Error(`Job ${jobId} has no audio stream to measure`)
  }
  const measured = (analysis.afterDynamics ?? analysis.source).find((m) => m.audioIndex === stream.audioIndex)
  if (measured === undefined)
  {
    throw new Error(`Audio stream ${stream.audioIndex} of job ${jobId} has no measurement`)
  }
  return { jobId, stats: measured.stats, ceiling: stream.ceiling, audioIndex: stream.audioIndex }
}

/** What the app wires once the engine exists: the deps it was built with, the host, and the late bindings. */
export interface EngineRuntime
{
  deps: EngineDeps
  host: ElectronJobsHost
  /**
   * Binds the engine the host, the preview analysis, and capability updates use, and hands it the current summary.
   * Call it once `init` has resolved: the engine reads `deps.capabilities` when it initializes and refuses
   * `setCapabilities` before, so a change in between arrives here.
   */
  attach(engine: JobEngine): Promise<void>
  /** Recomputes the capability summary and hands it to the attached engine. */
  refreshCapabilities(): Promise<void>
  /** The run alerts a config migration queued, handed out once. */
  takeAlerts(): Promise<RunAlertKind[]>
  dispose(): void
}

/**
 * Builds the engine's real dependencies over Electron and Node: the runners, planner IO, file operations, the
 * persistence IO under `<userData>/jobs`, the trash, the probe queue, the logger, the clipboard, and the dialogs.
 * It reads the `jobs` config key and the current FFmpeg build, and never starts the engine; run `checkFfmpeg` first
 * so the first summary carries the build.
 */
export async function createEngineRuntime(options: ElectronJobsHostOptions = {}): Promise<EngineRuntime>
{
  const platform = hostPlatform()
  const timers = realTimers
  const host = createElectronJobsHost(options)
  const log: JobLogger = logger.child({})
  const config = await getConfig()
  let jobs: JobsConfig = config.jobs
  const gpuSetting = detectionMode(config.gpuAcceleration)
  const cores = os.availableParallelism()
  let engine: JobEngine | null = null
  let gpu: GpuSummary | null = null
  let gpuFor: string | null = null
  let capabilitiesRev = 1
  let exec: { path: string; exec: Exec } | null = null
  const audioPlans = new Map<string, { recipe: NormalizeRecipe | BoostRecipe; staticPlan: StaticJobPlan }>()

  const volumes = createVolumeRegistry({ platform, queries: createVolumeQueries({ platform }), log: (m) => log.warn(m) })
  const planner = createPlannerIO({ platform, timers, volumes, log })
  const probe: Probe = (file, signal) =>
  {
    const info = currentBuildState().info
    return info ? createProbe(info.ffprobePath)(file, signal) : Promise.reject(new Error('FFmpeg is not available'))
  }
  const probes = createProbeQueue({ probe, stat: (file) => fs.promises.stat(file), timers, platform })

  const current = (): { exec: Exec; caps: BuildCapabilities; rev: number } | null =>
  {
    const state = currentBuildState()
    if (!state.info)
    {
      return null
    }
    if (exec?.path !== state.info.ffmpegPath)
    {
      exec = { path: state.info.ffmpegPath, exec: createExec(state.info.ffmpegPath, { timers }) }
    }
    return { exec: exec.exec, caps: buildCapabilitiesOf(state.info), rev: state.rev }
  }
  const buildId = (): string => buildIdOf(currentBuildState().info)
  const summary = (): CapabilitySummary => capabilitySummary({ build: currentBuildState(), gpu, rev: capabilitiesRev, cores, platform })

  const refreshCapabilities = async (): Promise<void> =>
  {
    capabilitiesRev += 1
    if (engine)
    {
      await engine.setCapabilities(summary())
    }
  }

  const detectGpu = (): void =>
  {
    const info = currentBuildState().info
    const key = info?.ffmpegPath ?? null
    if (key === gpuFor && gpu !== null)
    {
      return
    }
    gpuFor = key
    gpu = null
    if (!info)
    {
      gpu = { vendor: null, name: null, encoders: [] }
      return
    }
    void detectGpuSummary(info.ffmpegPath, gpuSetting).then((found) =>
    {
      if (gpuFor === key)
      {
        gpu = found
        void refreshCapabilities().catch((err) => log.warn(`Could not update capabilities: ${String(err)}`))
      }
    }, (err) => log.warn(`GPU detection failed: ${err instanceof Error ? err.message : String(err)}`))
  }
  const stopBuildWatch = onBuildChange(() =>
  {
    detectGpu()
    void refreshCapabilities().catch((err) => log.warn(`Could not update capabilities: ${String(err)}`))
  })
  detectGpu()

  const verifyVideo = (): RunSettings['verifyVideo'] => jobs.settings.verifyVideo
  const audioDeps = (parts: EngineParts): Parameters<typeof createNormalizeRunner>[0] => ({
    platform,
    buildId,
    exists: pathExists,
    remove: (file) => fs.promises.rm(file, { force: true }),
    size: async (file) => (await fs.promises.stat(file)).size,
    analyses: parts.analyses
  })

  const analyze: EngineAudio['analyze'] = async (jobId, context) =>
  {
    const view = engine?.snapshot().jobs.find((j) => j.id === jobId)
    if (!view)
    {
      throw new Error(`Job ${jobId} is not in the queue`)
    }
    const recipe = view.recipe
    if (recipe.kind !== 'normalize' && recipe.kind !== 'boost')
    {
      throw new Error(`Job ${jobId} does not measure loudness`)
    }
    const tools = current()
    const info = currentBuildState().info
    if (!tools || !info)
    {
      throw new Error('FFmpeg is not available')
    }
    const facts = await probes.probe(view.source.path, { signal: context.signal })
    const output = analysisOutput(view)
    const staticPlan = planStatic(facts, recipe, tools.caps, output)
    if (staticPlan.refusals.length > 0)
    {
      throw new Error(renderMessages(staticPlan.refusals.map((r) => r.message)))
    }
    const surround = surroundMeterIssues(recipe, facts, staticPlan.container, summary().ffmpeg)
    if (surround.length > 0)
    {
      throw new Error(surround[0].message)
    }
    audioPlans.set(jobId, { recipe, staticPlan })
    const input = audioInput(jobId, view.source, recipe, facts, output)
    const hit = context.cached(expectedKey(input, facts, staticPlan, buildId()))
    if (hit)
    {
      return hit
    }
    const ended = await analyzeAudioJob(input, {
      exec: tools.exec,
      probe: () => Promise.reject(new Error('Preview sources are probed by the engine')),
      caps: tools.caps,
      buildId: buildId(),
      output: () =>
      {
        throw new Error('A preview analysis writes no output')
      },
      fs: { remove: (file) => fs.promises.rm(file, { force: true }), size: async (file) => (await fs.promises.stat(file)).size },
      emit: () => undefined,
      log: (entry) => log[entry.level](entry.message),
      now: () => Date.now()
    }, context.signal)
    if (ended.kind === 'analysis')
    {
      return ended.analysis
    }
    const r = ended.result
    throw new Error(r.failure ? `Measuring failed: ${endingText(r.failure)}` : r.refusals.length > 0 ? renderMessages(r.refusals.map((x) => x.message)) : `Measuring ended: ${r.outcome}`)
  }

  const plannedAudio = (jobId: string): { recipe: NormalizeRecipe | BoostRecipe; staticPlan: StaticJobPlan } =>
  {
    const planned = audioPlans.get(jobId)
    if (!planned)
    {
      throw new Error(`Job ${jobId} has no analysis plan`)
    }
    return planned
  }

  const chooseSavePath: EngineShell['chooseSavePath'] = (defaultPath, origin) =>
    exclusiveDialog<string | null>(null, async () =>
    {
      const contents = origin.senderId === null ? null : webContents.fromId(origin.senderId) ?? null
      const win = parentWindowOf(contents)
      const box = { title: 'Export report', defaultPath, filters: reportFilters(defaultPath) }
      const result = win ? await dialog.showSaveDialog(win, box) : await dialog.showSaveDialog(box)
      return result.canceled || !result.filePath ? null : result.filePath
    })

  const deps: EngineDeps = {
    timers,
    ids: { token: () => randomBytes(8).toString('hex'), preflightId: () => randomUUID() },
    platform,
    paths: { userData: app.getPath('userData') },
    runners: (parts) => ({
      normalize: createNormalizeRunner(audioDeps(parts)),
      boost: createBoostRunner(audioDeps(parts)),
      convert: createConvertRunner({ exists: pathExists, verifyVideo, platform }),
      compress: createCompressRunner({ exists: pathExists, verifyVideo, platform }),
      extract: createExtractRunner({ exists: pathExists, makeFolder: makeFrameFolder, verifyVideo, platform })
    }),
    planner,
    probe: probes,
    fs: createFsOps({ platform, log }),
    trash: (file) => shell.trashItem(path.normalize(file)),
    store: createNodePersistenceIO(),
    host,
    log,
    ffmpeg: { current },
    setPriority: (pid, priority) =>
    {
      try
      {
        os.setPriority(pid, osPriority(priority))
      }
      catch (err)
      {
        log.warn(`Could not set the priority of process ${pid}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    volumes,
    config: {
      jobs,
      persist: async (change) =>
      {
        jobs = await saveJobsConfig(change)
      }
    },
    get capabilities(): CapabilitySummary
    {
      return summary()
    },
    plannerCapabilities: () => ({ build: current()?.caps ?? NO_BUILD, minimumVersion: MINIMUM_FFMPEG_VERSION }),
    audio: {
      analyze,
      plan: (jobId, analysis) =>
      {
        const planned = plannedAudio(jobId)
        return measurementOf(analysis, planAudioJob(analysis, planned.staticPlan, planned.recipe), null, [])
      },
      albumPlan: (members) =>
      {
        const recipe = plannedAudio(members[0]?.jobId ?? '').recipe
        if (recipe.kind !== 'normalize')
        {
          throw new Error('Only Normalize jobs form album groups')
        }
        return planAlbum(members.map((m) => albumMemberOf(m.jobId, m.analysis, plannedAudio(m.jobId).staticPlan)), recipe)
      }
    },
    shell: {
      showItemInFolder: (file) => shell.showItemInFolder(path.normalize(file)),
      readClipboard: () => readClipboardContent(platform, electronClipboard()),
      chooseSavePath,
      exists: pathExists,
      readLog: async (file) =>
      {
        try
        {
          return await fs.promises.readFile(file, 'utf8')
        }
        catch
        {
          return null
        }
      }
    },
    historyFs: createNodeHistoryFs(),
    workDirFiles: createNodeWorkDirFiles(),
    cores,
    pid: process.pid,
    appVersion: app.getVersion(),
    stat: (file) => fs.promises.stat(file)
  }

  return {
    deps,
    host,
    attach(next)
    {
      engine = next
      host.attach(next)
      return refreshCapabilities()
    },
    refreshCapabilities,
    takeAlerts: () => takeJobsAlerts(),
    dispose()
    {
      stopBuildWatch()
      host.setKeepAwake(false)
      engine = null
    }
  }
}
