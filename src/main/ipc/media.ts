/**
 * @module main/ipc/media
 * @description IPC handlers for YouTube / yt-dlp URL resolution and
 * audio stream retrieval.
 */

import { ipcMain } from 'electron'
import { logger } from '../logger'
import { addUrlHistory } from '../config'
import { resolvePlaylist, getAudioStreamUrl, registerStreamUrl, getInstalledBrowsers, setBrowserAndExport, clearCookies, getCookieInfo } from '../ytdlp'

/** Register YouTube / yt-dlp IPC handlers. */
export function registerMediaIPC(): void {
  ipcMain.handle('ytdlp:resolve', async (_, url: string) => {
    try {
      const entries = await resolvePlaylist(url)
      // Save to URL history on success
      if (entries.length > 0) {
        const title = entries.length === 1
          ? entries[0].title
          : `${entries[0].title} (+${entries.length - 1} more)`
        await addUrlHistory({ url, title, trackCount: entries.length })
      }
      return { success: true, entries }
    } catch (err: any) {
      logger.error(`yt-dlp resolve failed: ${err.message}`)
      return { success: false, error: err.message, entries: [] }
    }
  })

  ipcMain.handle('ytdlp:getInstalledBrowsers', () => {
    return getInstalledBrowsers()
  })

  ipcMain.handle('ytdlp:setBrowser', async (_, browserName: string) => {
    try {
      const ok = await setBrowserAndExport(browserName)
      return { success: ok, error: ok ? null : 'Cookie export failed - is the browser closed?' }
    } catch (err: any) {
      logger.error(`setBrowser failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('ytdlp:clearCookies', async () => {
    await clearCookies()
    return { success: true }
  })

  ipcMain.handle('ytdlp:cookieInfo', () => {
    return getCookieInfo()
  })

  ipcMain.handle('ytdlp:getStreamUrl', async (_, videoUrl: string, quality?: string) => {
    try {
      const result = await getAudioStreamUrl(videoUrl, (quality as any) || 'best')
      // Register CDN URL and return a media:// proxy URL for instant streaming
      const token = registerStreamUrl(result.audioUrl)
      return { success: true, mediaUrl: `media://${token}`, title: result.title, duration: result.duration }
    } catch (err: any) {
      logger.error(`yt-dlp stream URL failed: ${err.message}`)
      return { success: false, error: err.message }
    }
  })
}
