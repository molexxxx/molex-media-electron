/**
 * @module main/windows
 * @description Browser window management — main window, popout player,
 * and global IPC handlers for window controls and player state transfer.
 */

import { BrowserWindow, shell, ipcMain, Menu } from 'electron'
import * as path from 'path'
import { is } from '@electron-toolkit/utils'
import { getConfigSync, saveConfig, getConfig } from './config'

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let mainWindow: BrowserWindow | null = null
let popoutWindow: BrowserWindow | null = null
let pendingNavigate: string | null = null
let pendingPlayerState: any = null

/** Set by app lifecycle; `true` when the app is actually shutting down. */
export let isQuitting = false

/** Mark the app as quitting (called from tray / lifecycle hooks). */
export function setQuitting(value: boolean): void {
  isQuitting = value
}

/* ------------------------------------------------------------------ */
/*  Main window                                                        */
/* ------------------------------------------------------------------ */

/** Create the main application window. */
export function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 380,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#080b14',
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../../build/icon.ico')
      : path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Minimize to tray on close (instead of quitting)
  mainWindow.on('close', (e) => {
    if (isQuitting) return

    const config = getConfigSync()

    if (!config.minimizeToTray) {
      isQuitting = true
      return
    }

    e.preventDefault()

    if (config.showTrayNotification !== false) {
      mainWindow?.webContents.send('close:confirm')
      return
    }

    mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-finish-load', () => {
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
    backgroundColor: '#080b14',
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../../build/icon.ico')
      : path.join(__dirname, '../../resources/icon.png'),
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

  popoutWindow.webContents.on('did-finish-load', () => {
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

  // Close confirmation response from renderer
  ipcMain.on('close:response', (_event, action: 'minimize' | 'quit', dontAskAgain: boolean) => {
    if (dontAskAgain) {
      saveConfig({ showTrayNotification: false })
    }
    if (action === 'quit') {
      isQuitting = true
      const { app } = require('electron')
      app.quit()
      return
    }
    mainWindow?.hide()
  })

  // Popout player
  ipcMain.handle('player:popout', (_event, playerState?: any) => {
    showPopout(playerState)
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
