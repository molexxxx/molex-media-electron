/**
 * @module main/ipc/ytdlp-updates
 * @description IPC for the yt-dlp updater: its status, the check action, and every status change pushed to the
 * windows. Saving either yt-dlp setting announces the status again and runs a check when one is due.
 */

import { ipcMain } from 'electron'
import { onConfigSaved } from './config'
import { sendToAll } from './helpers'
import { ytDlpUpdater } from '../ytdlp/updater'

/** Reads the check options from the renderer; only a literal `install: false` skips the install. */
function readCheckOptions(value: unknown): { install: boolean }
{
  const install = typeof value === 'object' && value !== null && (value as { install?: unknown }).install === false ? false : true
  return { install }
}

/** Register the yt-dlp status and update channels. */
export function registerYtDlpUpdateIPC(): void
{
  const updater = ytDlpUpdater()
  ipcMain.handle('ytdlp:status', () => updater.status())
  ipcMain.handle('ytdlp:checkUpdates', (_event, options: unknown) => updater.check(readCheckOptions(options)))
  updater.onStatus((status) => sendToAll('ytdlp:status-changed', status))
  onConfigSaved((_config, saved) =>
  {
    if ('ytdlpAutoUpdate' in saved || 'ytdlpUseSystem' in saved)
    {
      updater.settingsChanged()
    }
  })
}
