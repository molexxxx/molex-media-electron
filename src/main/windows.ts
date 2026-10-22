/**
 * @module main/windows
 * @description Browser window management - main window, popout player,
 * and global IPC handlers for window controls and player state transfer.
 */

import { app, BrowserWindow, dialog, shell, ipcMain, Menu } from 'electron'
import * as path from 'path'
import { is } from '@electron-toolkit/utils'
import { getConfigSync, saveConfig, getConfig, clampInterfaceScale } from './config'
import { logger } from './logger'
import { GROUND_HEX } from './theme'

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null
let popoutWindow: BrowserWindow | null = null
let pendingNavigate: string | null = null
let pendingPlayerState: any = null
const rendererReloads: number[] = []

/** Set by app lifecycle; `true` when the app is actually shutting down. */
export let isQuitting = false

/** Mark the app as quitting (called from tray / lifecycle hooks). */
export function setQuitting(value: boolean): void {
  isQuitting = value
}

/** The quitting flag, read at call time. */
export function isAppQuitting(): boolean {
  return isQuitting
}

/** The main window's smallest size: half of a 1280 DIP work area, so half-screen Snap keeps working. */
export const MAIN_MIN_SIZE = { width: 640, height: 480 } as const

/** A gone renderer reloads after this delay, at most `MAX_RENDERER_RELOADS` times per `RELOAD_WINDOW_MS`. */
export const RELOAD_DELAY_MS = 1000
export const MAX_RENDERER_RELOADS = 3
export const RELOAD_WINDOW_MS = 60_000

/**
 * Whether a gone renderer may reload by itself: fewer than three reloads in the last minute.
 * Drops entries older than the window from `history`.
 */
export function mayReloadRenderer(history: number[], now: number): boolean {
  while (history.length > 0 && now - history[0] >= RELOAD_WINDOW_MS) history.shift()
  return history.length < MAX_RENDERER_RELOADS
}

/** The lifecycle's handlers for the main window, installed before the window is created. */
export interface MainWindowHooks {
  /** The main window's close handler; it decides whether the close goes ahead. */
  close(event: Electron.Event, win: BrowserWindow): void
  /** Windows ends the session (shutdown, restart, or logout); `before-quit` is not emitted then. */
  sessionEnd(win: BrowserWindow): void
  /** A close hid the window to the tray. */
  hiddenToTray(win: BrowserWindow): void
}

let hooks: MainWindowHooks | null = null

/** Install the lifecycle's main window handlers; every main window created afterwards uses them. */
export function setMainWindowHooks(next: MainWindowHooks | null): void {
  hooks = next
}

/** The main window, or null when it is closed. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/** The zoom factor for an interface size in percent, clamped to the setting's range. */
export function zoomFactorOf(interfaceScale: unknown): number {
  return clampInterfaceScale(interfaceScale) / 100
}

function applyZoom(win: BrowserWindow | null, interfaceScale: unknown): void {
  if (!win || win.isDestroyed()) return
  win.webContents.setZoomFactor(zoomFactorOf(interfaceScale))
}

/** Whether each window was maximized when it went full screen, so leaving restores that state. */
const maximizedBeforeFullScreen = new Map<number, boolean>()

/** Tells a window's page each time the window enters or leaves full screen. */
function reportFullScreen(win: BrowserWindow): void {
  const report = (on: boolean) => (): void => {
    if (!win.isDestroyed()) win.webContents.send('window:fullscreen-changed', on)
  }
  win.on('enter-full-screen', report(true))
  win.on('leave-full-screen', report(false))
}

/** Apply the interface size to the main window and the popout; the stored setting when none is given. */
export function applyInterfaceScale(interfaceScale: unknown = getConfigSync().interfaceScale): void {
  applyZoom(mainWindow, interfaceScale)
  applyZoom(popoutWindow, interfaceScale)
}

/** Hide the main window to the tray after a close. */
export function hideMainToTray(): void {
  const win = getMainWindow()
  if (!win) return
  win.hide()
  hooks?.hiddenToTray(win)
}

/**
 * A close with minimize to tray on: the renderer's close modal asks first while it is enabled and the renderer is
 * alive; otherwise the window hides at once.
 */
export function closeMainToTray(): void {
  const win = getMainWindow()
  if (!win) return
  if (getConfigSync().showTrayNotification !== false && !win.webContents.isCrashed()) {
    win.webContents.send('close:confirm')
    return
  }
  hideMainToTray()
}

function onRendererGone(win: BrowserWindow, reason: string): void {
  logger.error(`The window's page stopped (${reason})`)
  const now = Date.now()
  if (mayReloadRenderer(rendererReloads, now)) {
    rendererReloads.push(now)
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, RELOAD_DELAY_MS)
    return
  }
  void dialog.showMessageBox(win, {
    type: 'error',
    message: 'The molexMedia window stopped working.',
    detail: `It was reloaded ${MAX_RENDERER_RELOADS} times in the last minute. Jobs keep running in the background.`,
    buttons: ['Reload', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }).then(({ response }) => {
    if (response === 1) {
      app.quit()
      return
    }
    rendererReloads.length = 0
    if (!win.isDestroyed()) win.webContents.reload()
  }, (err) => logger.error(`Could not offer a reload: ${err instanceof Error ? err.message : String(err)}`))
}

/* ------------------------------------------------------------------ */
/*  Main window                                                        */
/* ------------------------------------------------------------------ */

/** Create the main application window. */
export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1657,
    height: 1061,
    minWidth: MAIN_MIN_SIZE.width,
    minHeight: MAIN_MIN_SIZE.height,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: GROUND_HEX,
    icon: path.join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const win = mainWindow

  win.on('ready-to-show', () => {
    win.show()
  })

  // The quit guard decides; without it a close goes ahead
  win.on('close', (e) => {
    hooks?.close(e, win)
  })

  win.on('session-end', () => {
    hooks?.sessionEnd(win)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    if (isQuitting || details.reason === 'clean-exit' || win.isDestroyed()) return
    onRendererGone(win, details.reason)
  })

  reportFullScreen(win)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    applyZoom(win, getConfigSync().interfaceScale)
    if (pendingNavigate && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('navigate', pendingNavigate)
      pendingNavigate = null
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    if (isQuitting && popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close()
    }
    mainWindow = null
  })
}

/**
 * Show (or create) the main window and optionally navigate to a view.
 *
 * @param navigateTo - Optional view to navigate to (e.g. `"player"`, `"editor"`).
 */
export function showMainWindow(navigateTo?: string): void {
  if (navigateTo) pendingNavigate = navigateTo

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.setAlwaysOnTop(true)
  mainWindow.setAlwaysOnTop(false)
  mainWindow.focus()

  if (pendingNavigate) {
    mainWindow.webContents.send('navigate', pendingNavigate)
    pendingNavigate = null
  }
}

/* ------------------------------------------------------------------ */
/*  Popout player                                                      */
/* ------------------------------------------------------------------ */

/** Create (or focus) the popout player window. */
export function createPopoutWindow(): void {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus()
    return
  }

  const cfg = getConfigSync()
  const { width, height } = cfg.popoutSize || { width: 420, height: 560 }

  popoutWindow = new BrowserWindow({
    width,
    height,
    minWidth: 300,
    minHeight: 360,
    frame: false,
    titleBarStyle: 'hidden',
    alwaysOnTop: true,
    backgroundColor: GROUND_HEX,
    icon: path.join(__dirname, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    popoutWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#popout')
  } else {
    popoutWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'popout' })
  }

  const popout = popoutWindow
  reportFullScreen(popout)
  popoutWindow.webContents.on('did-finish-load', () => {
    applyZoom(popout, getConfigSync().interfaceScale)
    // Send state eagerly; the popout also pulls via player:getPendingState
    // in case this fires before React registers its listener.
    if (pendingPlayerState && popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.webContents.send('player:receiveState', pendingPlayerState)
    }
  })

  popoutWindow.on('closed', () => {
    popoutWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (pendingPlayerState) {
        mainWindow.webContents.send('player:receiveState', pendingPlayerState)
        pendingPlayerState = null
      }
      mainWindow.webContents.send('player:popout-closed')
    }
  })
}

/**
 * Show the popout player, creating it if necessary.
 * If player state is provided it will be forwarded once the window loads.
 */
export function showPopout(playerState?: any): void {
  if (playerState) pendingPlayerState = playerState
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    if (playerState) popoutWindow.webContents.send('player:receiveState', playerState)
    popoutWindow.focus()
    return
  }
  createPopoutWindow()
}

/* ------------------------------------------------------------------ */
/*  Global IPC (window controls + popout player)                       */
/* ------------------------------------------------------------------ */

/** Register window-control and popout-player IPC handlers. */
export function registerGlobalIPC(): void {
  // Window controls
  ipcMain.on('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.on('window:maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  // Full screen for the window that asks; the window reports each change back to its own page
  ipcMain.handle('window:setFullScreen', (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    if (on === true) {
      if (!win.isFullScreen()) maximizedBeforeFullScreen.set(win.id, win.isMaximized())
      win.setFullScreen(true)
    } else {
      win.setFullScreen(false)
      if (maximizedBeforeFullScreen.get(win.id) === true && !win.isMaximized()) win.maximize()
      maximizedBeforeFullScreen.delete(win.id)
    }
    return win.isFullScreen()
  })
  ipcMain.handle('window:isFullScreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return !!win && !win.isDestroyed() && win.isFullScreen()
  })

  // Close confirmation response from renderer
  ipcMain.on('close:response', (_event, action: 'minimize' | 'quit', dontAskAgain: boolean) => {
    if (dontAskAgain) {
      saveConfig({ showTrayNotification: false })
    }
    if (action === 'quit') {
      isQuitting = true
      app.quit()
      return
    }
    hideMainToTray()
  })

  // Popout player
  ipcMain.handle('player:popout', (_event, playerState?: any) => {
    showPopout(playerState)
  })

  // Closes the pop-out, which hands its state back, and brings the main window forward on the Player
  ipcMain.handle('player:returnToApp', () => {
    if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.close()
    showMainWindow('player')
  })

  ipcMain.handle('player:isPopout', () => {
    return popoutWindow !== null && !popoutWindow.isDestroyed()
  })

  // Pull-based state transfer: popout calls this after React mounts
  // to get any pending state that may have arrived before the listener.
  ipcMain.handle('player:getPendingState', () => {
    const state = pendingPlayerState
    pendingPlayerState = null
    return state
  })

  ipcMain.on('player:returnState', (_event, playerState: any) => {
    pendingPlayerState = playerState
  })

  ipcMain.handle('player:togglePin', () => {
    if (!popoutWindow || popoutWindow.isDestroyed()) return false
    const pinned = !popoutWindow.isAlwaysOnTop()
    popoutWindow.setAlwaysOnTop(pinned)
    return pinned
  })

  ipcMain.handle('player:isPinned', () => {
    if (!popoutWindow || popoutWindow.isDestroyed()) return false
    return popoutWindow.isAlwaysOnTop()
  })

  ipcMain.handle('player:resize', async (_event, width: number, height: number, save?: boolean) => {
    if (!popoutWindow || popoutWindow.isDestroyed()) return
    popoutWindow.setSize(width, height, true)
    popoutWindow.center()
    if (save) {
      await saveConfig({ popoutSize: { width, height } })
    }
  })

  ipcMain.handle('player:getSize', async () => {
    const cfg = await getConfig()
    return cfg.popoutSize || { width: 420, height: 560 }
  })

  // Text field context menu
  ipcMain.on('context-menu:text', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const menu = Menu.buildFromTemplate([
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    ])
    menu.popup({ window: win })
  })
}
