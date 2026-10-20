/**
 * @module main/index
 * @description Electron main process entry point.
 *
 * Orchestrates app lifecycle events (ready, activate, window-all-closed,
 * before-quit), starts the job engine after the single-instance lock and
 * before IPC registration and window creation, guards every quit while the
 * engine is busy, and wires together the protocol, tray, updater, and window
 * sub-modules. Every quit decision and every word comes from `jobs/status`.
 */

import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, type MenuItemConstructorOptions } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerIPC, checkFfmpeg, createEngineRuntime, type EngineRuntime, type JobsIPC } from './ipc'
import { hostPlatform } from './ipc/jobs-host'
import { onConfigSaved } from './ipc/config'
import { loadConfig, getConfigSync } from './config'
import { installCrashHandlers, logger } from './logger'
import { killAllProcesses } from './ffmpeg/runner'
import { cleanupPlaybackTemp } from './ffmpeg/playback'
import { cleanupAudioCache } from './ytdlp'
import { initFFmpegDir } from './ytdlp/binary'
import { registerMediaScheme, registerMediaHandler } from './protocol'
import { cancelBatchPrompt, createTray, destroyTray, renderEngineTray, setEngineTray, setTrayCallbacks } from './tray'
import { initUpdater } from './updater'
import { createJobEngine, type JobEngine } from './jobs/engine'
import {
  closedToTrayNotification,
  idleQuitDue,
  quitChoiceEffect,
  quitDecision,
  quitPrompt,
  shouldNotifyClosedToTray,
  systemEndingPlan,
  type QuitState,
  type SystemEndingPlan,
  type TrayAction
} from './jobs/status'
import type { CommandContext } from './jobs/command-gate'
import type { RunId } from '../shared/jobs/ids'
import {
  applyInterfaceScale,
  closeMainToTray,
  createWindow,
  getMainWindow,
  isAppQuitting,
  registerGlobalIPC,
  setMainWindowHooks,
  setQuitting,
  showMainWindow,
  showPopout,
  type MainWindowHooks
} from './windows'

// Re-export for IPC helpers (they import updateTrayProgress from here)
export { updateTrayProgress } from './tray'

type QuitChoice = Parameters<typeof quitChoiceEffect>[0]

/** Commands the lifecycle and the tray send come from no window. */
const MAIN_CONTEXT: CommandContext = { senderId: -1 }

/** How long a quit dialog waits for a recreated main window to show before it opens anyway. */
const SHOW_WAIT_MS = 3000

let engine: JobEngine | null = null
let runtime: EngineRuntime | null = null

/** The quit guard's state beside the quitting flag in windows.ts. */
const guard: { confirmed: boolean; systemEnding: boolean; dialog: AbortController | null; shutdown: QuitState['shutdown'] } = {
  confirmed: false,
  systemEnding: false,
  dialog: null,
  shutdown: 'none'
}
let shutdownDone: Promise<void> | null = null
let closedToTrayRun: RunId | null = null
let idleQuitRequested = false

// Uncaught exceptions and unhandled rejections reach the log before anything else runs
installCrashHandlers()

// Register media:// as a privileged scheme BEFORE app is ready
registerMediaScheme()

// Suppress Chromium GPU disk cache errors (harmless but noisy)
app.commandLine.appendSwitch('disk-cache-size', '0')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// Allow autoplay without user gesture (needed for popout player resume)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// --- Single instance lock -----------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function quitState(): QuitState {
  return {
    platform: hostPlatform(),
    busy: engine?.isBusy() ?? false,
    confirmed: guard.confirmed,
    systemEnding: guard.systemEnding,
    dialogOpen: guard.dialog !== null,
    quitting: isAppQuitting(),
    minimizeToTray: getConfigSync().minimizeToTray === true,
    shutdown: guard.shutdown
  }
}

/** Every quit goes through `before-quit`, where the guard asks and the shutdown runs. */
function requestQuit(): void {
  setQuitting(true)
  app.quit()
}

/** The engine's idle quit after "Quit when current jobs finish": already confirmed, so no dialog. */
function idleQuit(): void {
  guard.confirmed = true
  requestQuit()
}

function activeRunId(): RunId | null {
  if (!engine) return null
  const inputs = engine.quitInputs()
  return inputs.status === 'idle' ? null : inputs.runId
}

function engineBusy(): boolean {
  return engine?.isBusy() ?? false
}

/** No application menu on Windows and Linux; on macOS the app menu with Quit and the Edit roles text fields need. */
function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** FFmpeg check, engine runtime, engine init and recovery, then the late bindings; null when the engine cannot start. */
async function startEngine(): Promise<JobsIPC | null> {
  try {
    await checkFfmpeg()
  } catch (err) {
    logger.warn(`FFmpeg check failed at startup: ${errorText(err)}`)
  }
  let built: EngineRuntime | null = null
  try {
    built = await createEngineRuntime({ mainWindow: getMainWindow, showMainWindow, quit: idleQuit })
    const created = createJobEngine(built.deps)
    logger.info('Job engine: loading and recovering the queue')
    await created.init()
    logger.info('Job engine: queue recovered')
    await built.attach(created)
    runtime = built
    engine = created
    return { engine: created, host: built.host }
  } catch (err) {
    logger.error(`The job engine could not start: ${errorText(err)}`)
    built?.dispose()
    return null
  }
}

function step(name: string, run: () => void): void {
  try {
    run()
  } catch (err) {
    logger.error(`Shutdown step ${name} failed: ${errorText(err)}`)
  }
}

/**
 * The async shutdown before the real quit, with or without a dialog: the engine stops its jobs, flushes and compacts
 * the journal, and records a clean exit; then the tray goes, the child processes end, and the log is flushed.
 */
function runShutdown(): Promise<void> {
  if (shutdownDone) return shutdownDone
  guard.shutdown = 'running'
  shutdownDone = (async () => {
    logger.info(engineBusy() ? 'Quitting now: stopping the jobs in progress' : 'Shutting down')
    try {
      await engine?.shutdown('quit')
    } catch (err) {
      logger.error(`The job engine did not shut down cleanly: ${errorText(err)}`)
    }
    step('runtime', () => runtime?.dispose())
    step('tray', destroyTray)
    step('processes', killAllProcesses)
    step('playback', cleanupPlaybackTemp)
    step('log', () => logger.flush())
    guard.shutdown = 'done'
  })()
  return shutdownDone
}

function whenMainWindowShows(): Promise<void> {
  const win = getMainWindow()
  if (!win || win.isVisible()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SHOW_WAIT_MS)
    win.once('show', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function checkIdleQuit(): void {
  if (!engine || idleQuitRequested || guard.shutdown !== 'none') return
  const inputs = engine.quitInputs()
  if (!idleQuitDue({ quitWhenIdle: inputs.quitWhenIdle, active: inputs.active, claimed: 0 })) return
  idleQuitRequested = true
  logger.info('The current jobs finished; quitting as asked')
  idleQuit()
}

async function applyQuitChoice(choice: QuitChoice): Promise<void> {
  const effect = quitChoiceEffect(choice)
  logger.info(`Quit dialog: ${choice}`)
  if (effect.quitNow) {
    guard.confirmed = true
    requestQuit()
    return
  }
  if (!engine) return
  if (effect.pause !== null) {
    const result = await engine.command('pause', { mode: effect.pause }, MAIN_CONTEXT)
    if (!result.ok) logger.warn(`Could not pause the batch before quitting: ${result.error.message}`)
  }
  engine.setQuitWhenIdle(effect.quitWhenIdle)
  checkIdleQuit()
}

/** The quit dialog, parented to the visible main window; an open dialog closes through its signal. */
async function askQuit(): Promise<void> {
  if (!engine || !runtime || guard.dialog) return
  const controller = new AbortController()
  guard.dialog = controller
  let choice: QuitChoice = 'keep-running'
  try {
    await whenMainWindowShows()
    choice = controller.signal.aborted
      ? 'keep-running'
      : await runtime.host.askQuit(quitPrompt(engine.quitInputs()), controller.signal)
  } catch (err) {
    logger.error(`The quit dialog failed: ${errorText(err)}`)
  } finally {
    guard.dialog = null
  }
  if (guard.systemEnding) return
  await applyQuitChoice(choice)
}

/** The OS ends the session: never wait on the dialog; persist at once on Windows, delay and quit elsewhere. */
function endSystemSession(plan: SystemEndingPlan): void {
  guard.systemEnding = true
  logger.info('The system is ending the session')
  if (plan.closeDialog) guard.dialog?.abort()
  if (plan.persistNow && engine) {
    void engine.shutdown('session-end').catch((err) => logger.error(`Could not save the queue at session end: ${errorText(err)}`))
    logger.flush()
  }
  if (plan.shutdown) {
    void runShutdown().then(() => app.quit())
  }
}

async function trayAction(action: TrayAction): Promise<void> {
  switch (action) {
    case 'show':
      showMainWindow()
      return
    case 'batch':
    case 'editor':
    case 'player':
    case 'logs':
      showMainWindow(action)
      return
    case 'quit':
      requestQuit()
      return
    default:
      break
  }
  if (!engine || !runtime) return
  if (action === 'pause' || action === 'resume') {
    const result = action === 'pause'
      ? await engine.command('pause', { mode: 'finish-running' }, MAIN_CONTEXT)
      : await engine.command('resume', { ack: null }, MAIN_CONTEXT)
    if (!result.ok) {
      logger.warn(`Tray ${action} refused: ${result.error.message}`)
      showMainWindow('batch')
    }
    return
  }
  const inputs = engine.quitInputs()
  if (inputs.runId === null) return
  const confirmed = await runtime.host.confirmCancelBatch(cancelBatchPrompt(inputs.runId, inputs.active, inputs.queued))
  if (!confirmed) return
  const result = await engine.command('cancelRun', {}, MAIN_CONTEXT)
  if (!result.ok) logger.warn(`Tray cancel refused: ${result.error.message}`)
}

const mainWindowHooks: MainWindowHooks = {
  close(event) {
    const decision = quitDecision(quitState(), 'window-close')
    switch (decision.action) {
      case 'close':
        if (decision.markQuitting) setQuitting(true)
        return
      case 'hide':
        event.preventDefault()
        closeMainToTray()
        return
      case 'ask':
        event.preventDefault()
        void askQuit()
        return
      default:
        event.preventDefault()
    }
  },
  sessionEnd() {
    const plan = systemEndingPlan('session-end', hostPlatform())
    if (plan) endSystemSession(plan)
  },
  hiddenToTray() {
    const runId = activeRunId()
    if (!runtime || runId === null || !shouldNotifyClosedToTray(runId, closedToTrayRun)) return
    closedToTrayRun = runId
    runtime.host.notify(closedToTrayNotification(runId))
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return

  logger.init()
  logger.info('molexMedia starting up...')

  registerMediaHandler()

  electronApp.setAppUserModelId('com.molex.media')

  // The UI is dark only; this also darkens the native text-field and tray menus
  nativeTheme.themeSource = 'dark'

  installApplicationMenu()

  // zoom: true lets the zoom keys reach the page, which owns interface zoom
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window, { zoom: true })
  })

  await loadConfig()
  await initFFmpegDir()

  const jobs = await startEngine()
  registerIPC(jobs ?? undefined)
  registerGlobalIPC()
  logger.info(jobs ? 'IPC registered with the job channels' : 'IPC registered without the job channels')

  onConfigSaved((config, saved) => {
    if ('interfaceScale' in saved) applyInterfaceScale(config.interfaceScale)
  })
  setMainWindowHooks(mainWindowHooks)

  // Wire tray callbacks (avoids circular dependency tray ↔ windows)
  setTrayCallbacks({
    showMainWindow,
    showPopout: () => showPopout(),
    quit: requestQuit
  })
  setEngineTray({
    busy: engineBusy,
    act: (action) => {
      void trayAction(action).catch((err) => logger.error(`Tray ${action} failed: ${errorText(err)}`))
    }
  })
  createTray()
  runtime?.host.bindTray((status) => {
    renderEngineTray(status)
    checkIdleQuit()
  })

  cleanupAudioCache()
  createWindow()
  logger.info('Main window created')

  await initUpdater({
    busy: () => ({ busy: engineBusy(), runId: activeRunId() }),
    beforeInstall: async () => {
      guard.confirmed = true
      await runShutdown()
      setQuitting(true)
    }
  })

  // The typings omit the event the docs describe; preventDefault on it delays the system shutdown
  const onShutdown = (event: Electron.Event): void => {
    const plan = systemEndingPlan('shutdown', hostPlatform())
    if (!plan) return
    if (plan.delayShutdown) event.preventDefault()
    endSystemSession(plan)
  }
  powerMonitor.on('shutdown', onShutdown as () => void)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The tray and the child processes stay until before-quit, after the guard has passed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (!gotSingleInstanceLock) return
  const decision = quitDecision(quitState(), 'before-quit')
  switch (decision.action) {
    case 'proceed':
      setQuitting(true)
      return
    case 'ask':
      event.preventDefault()
      if (decision.resetQuitting) setQuitting(false)
      if (decision.showWindow) showMainWindow()
      void askQuit()
      return
    case 'shutdown':
      event.preventDefault()
      void runShutdown().then(() => app.quit())
      return
    default:
      event.preventDefault()
  }
})
