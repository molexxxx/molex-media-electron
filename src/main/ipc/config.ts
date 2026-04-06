/**
 * @module main/ipc/config
 * @description IPC handlers for configuration persistence and URL history.
 */

import { ipcMain } from 'electron'
import {
  loadConfig,
  saveConfig,
  getConfig,
  getUrlHistory,
  removeUrlHistory,
  clearUrlHistory
} from '../config'

/** Register config and URL-history IPC handlers. */
export function registerConfigIPC(): void {
  ipcMain.handle('config:load', async () => {
    return loadConfig()
  })

  ipcMain.handle('config:save', async (_, partial) => {
    return saveConfig(partial)
  })

  ipcMain.handle('config:get', async () => {
    return getConfig()
  })

  // --- URL History ---
  ipcMain.handle('history:get', async () => {
    return getUrlHistory()
  })

  ipcMain.handle('history:remove', async (_, url: string) => {
    return removeUrlHistory(url)
  })

  ipcMain.handle('history:clear', async () => {
    return clearUrlHistory()
  })
}
