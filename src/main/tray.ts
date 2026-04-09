/**
 * @module main/tray
 * @description System tray icon, context menu, and live processing
 * progress display.
 */

import { Tray, Menu, nativeImage } from 'electron'
import * as path from 'path'

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let tray: Tray | null = null
let trayProgressTotal = 0
let trayProgressDone = 0
let trayProgressActive = ''

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
    { label: 'Batch', click: () => _showMainWindow('batch') },
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
 * Called from the IPC helpers on every task-progress event.
 */
export function updateTrayProgress(total: number, done: number, activeLabel: string): void {
  trayProgressTotal = total
  trayProgressDone = done
  trayProgressActive = activeLabel
  updateTrayMenu()
}
