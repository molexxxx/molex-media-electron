/**
 * @module main/ipc/config
 * @description IPC handlers for configuration persistence and URL history.
 *
 * Main-owned keys never cross these channels: every config returned to the
 * renderer and every partial it saves passes through `stripMainOwned`.
 */

import { ipcMain } from 'electron'
import {
  loadConfig,
  saveConfig,
  getConfig,
  getUrlHistory,
  removeUrlHistory,
  clearUrlHistory,
  stripMainOwned,
  type AppConfig,
  type RendererConfig
} from '../config'

/** Called after a `config:save` with the saved config and the fields the renderer sent. */
export type ConfigSavedListener = (config: AppConfig, saved: Partial<RendererConfig>) => void

const savedListeners = new Set<ConfigSavedListener>()

/** Run `listener` after every `config:save`, such as applying a new interface size; returns the unsubscribe. */
export function onConfigSaved(listener: ConfigSavedListener): () => void {
  savedListeners.add(listener)
  return () => {
    savedListeners.delete(listener)
  }
}

/** Register config and URL-history IPC handlers. */
export function registerConfigIPC(): void {
  ipcMain.handle('config:load', async () => {
    return stripMainOwned(await loadConfig())
  })

  ipcMain.handle('config:save', async (_, partial) => {
    const accepted: Partial<RendererConfig> = stripMainOwned(partial ?? {})
    const config = await saveConfig(accepted)
    for (const listener of savedListeners) listener(config, accepted)
    return stripMainOwned(config)
  })

  ipcMain.handle('config:get', async () => {
    return stripMainOwned(await getConfig())
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
