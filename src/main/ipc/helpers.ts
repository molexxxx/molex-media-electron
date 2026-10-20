/**
 * @module main/ipc/helpers
 * @description Shared IPC utilities: safe broadcast to every open window.
 */

import { BrowserWindow } from 'electron'

/**
 * Send an IPC message to every open BrowserWindow.
 * Silently skips destroyed windows.
 */
export function sendToAll(channel: string, ...args: any[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    } catch { /* window may be closing */ }
  }
}
