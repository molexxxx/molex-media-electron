/**
 * @module main/tray
 * @description System tray icon, context menu, and live processing
 * progress display.
 *
 * Two writers until the batch UI switches to the job engine: while the
 * engine is busy the tray renders the engine's status and ignores the old
 * batch path's `updateTrayProgress`; otherwise the old path drives it while
 * it processes, and the engine's idle status shows the rest of the time.
 */

import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import * as path from 'path'
import { trayMenu, type TrayAction } from './jobs/status'
import type { TrayStatus } from './jobs/deps'
import { formatRunLabel, type RunId } from '../shared/jobs/ids'

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let tray: Tray | null = null
let trayProgressTotal = 0
let trayProgressDone = 0
let trayProgressActive = ''
let engineStatus: TrayStatus | null = null
let engineBusy: () => boolean = () => false
let engineAction: (action: TrayAction) => void = () => {}

/** Callbacks injected from index.ts to avoid circular deps. */
let _showMainWindow: (target?: string) => void = () => {}
let _showPopout: () => void = () => {}
let _quit: () => void = () => {}

/**
 * Provide navigation / lifecycle callbacks used by the tray menu.
 * Called once from the app bootstrap.
 */
export function setTrayCallbacks(cbs: {
  showMainWindow: (target?: string) => void
  showPopout: () => void
  quit: () => void
}): void {
  _showMainWindow = cbs.showMainWindow
  _showPopout = cbs.showPopout
  _quit = cbs.quit
}

/** Connect the job engine: whether it is busy, and what its menu items do. */
export function setEngineTray(options: { busy: () => boolean; act: (action: TrayAction) => void }): void {
  engineBusy = options.busy
  engineAction = options.act
}

/** Render the engine's tray status; the job host calls it at most once per second and at once on run status changes. */
export function renderEngineTray(status: TrayStatus): void {
  engineStatus = status
  updateTrayMenu()
}

/** The tray's "Cancel batch…" confirmation text, in the batch page's words. */
export function cancelBatchPrompt(runId: RunId, active: number, queued: number): { message: string; detail: string } {
  const jobs = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`
  const parts: string[] = []
  if (active > 0) {
    const files = active === 1 ? 'its partial file is deleted' : 'their partial files are deleted'
    parts.push(`${jobs(active, 'job')} in progress ${active === 1 ? 'stops' : 'stop'} and ${files}.`)
  }
  if (queued > 0) {
    parts.push(`${jobs(queued, 'queued job')} ${queued === 1 ? 'is' : 'are'} canceled.`)
  }
  parts.push('Finished jobs keep their outputs.')
  return { message: `Cancel ${formatRunLabel(runId)}?`, detail: parts.join(' ') }
}

function engineDrives(): boolean {
  return engineStatus !== null && (engineBusy() || trayProgressTotal === 0)
}

function engineTemplate(status: TrayStatus): MenuItemConstructorOptions[] {
  return trayMenu(status).map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.type === 'status') return { label: item.label, enabled: false }
    const action = item.action
    return { label: item.label, click: () => engineAction(action) }
  })
}

/* ------------------------------------------------------------------ */
/*  Icon                                                               */
/* ------------------------------------------------------------------ */

function getIconPath(): string {
  return path.join(__dirname, '../../resources/icon.png')
}

/* ------------------------------------------------------------------ */
/*  Tray lifecycle                                                     */
/* ------------------------------------------------------------------ */

/** Create the system tray icon and initial context menu. */
export function createTray(): void {
  const iconPath = getIconPath()
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  updateTrayMenu()

  tray.on('double-click', () => {
    _showMainWindow()
  })
}

/** Destroy the tray icon (called during shutdown). */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/** Return `true` if the tray icon exists. */
export function hasTray(): boolean {
  return tray !== null
}

/* ------------------------------------------------------------------ */
/*  Context menu                                                       */
/* ------------------------------------------------------------------ */

function updateTrayMenu(): void {
  if (!tray) return

  if (engineStatus !== null && engineDrives()) {
    tray.setToolTip(engineStatus.tooltip)
    tray.setContextMenu(Menu.buildFromTemplate(engineTemplate(engineStatus)))
    return
  }

  const progressItems: Electron.MenuItemConstructorOptions[] = []
  if (trayProgressTotal > 0) {
    progressItems.push(
      { label: `Processing: ${trayProgressDone}/${trayProgressTotal}`, enabled: false },
      ...(trayProgressActive ? [{ label: trayProgressActive, enabled: false } as Electron.MenuItemConstructorOptions] : []),
      { type: 'separator' as const }
    )
  }

  const tooltip = trayProgressTotal > 0
    ? `molexMedia - Processing ${trayProgressDone}/${trayProgressTotal}`
    : 'molexMedia'
  tray.setToolTip(tooltip)

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show molexMedia', click: () => _showMainWindow() },
    { type: 'separator' },
    ...progressItems,
    { label: 'Pop Out Player', click: () => _showPopout() },
    { label: 'Player', click: () => _showMainWindow('player') },
    { label: 'Editor', click: () => _showMainWindow('editor') },
    { label: 'Processor', click: () => _showMainWindow('batch') },
    { label: 'Logs', click: () => _showMainWindow('logs') },
    { type: 'separator' },
    { label: 'Quit', click: () => _quit() }
  ])

  tray.setContextMenu(contextMenu)
}

/* ------------------------------------------------------------------ */
/*  Live progress                                                      */
/* ------------------------------------------------------------------ */

/**
 * Update the tray tooltip and context menu with live batch progress.
 * Called from the IPC helpers on every task-progress event; ignored while
 * the job engine is busy, so the old path can never clear the engine's status.
 */
export function updateTrayProgress(total: number, done: number, activeLabel: string): void {
  if (engineStatus !== null && engineBusy()) return
  trayProgressTotal = total
  trayProgressDone = done
  trayProgressActive = activeLabel
  updateTrayMenu()
}
