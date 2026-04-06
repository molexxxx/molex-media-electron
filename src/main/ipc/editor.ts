/**
 * @module main/ipc/editor
 * @description IPC handlers for the media editor (cut, merge, probe, remux).
 */

import { ipcMain } from 'electron'
import { probeMedia } from '../ffmpeg/probe'
import { cutMedia, mergeMedia, remuxMedia, type CutOptions } from '../ffmpeg/processor'

/** Register editor IPC handlers. */
export function registerEditorIPC(): void {
  ipcMain.handle('editor:cut', async (_, filePath: string, inPoint: number, outPoint: number, options?: CutOptions) => {
    return cutMedia(filePath, inPoint, outPoint, options)
  })

  ipcMain.handle('editor:merge', async (_, segments: { path: string; inPoint: number; outPoint: number }[], options?: CutOptions) => {
    return mergeMedia(segments, options)
  })

  ipcMain.handle('editor:probeDetailed', async (_, filePath: string) => {
    return probeMedia(filePath)
  })

  ipcMain.handle('editor:remux', async (_, filePath: string, options: {
    keepStreams: number[]
    metadata?: Record<string, string>
    dispositions?: Record<number, Record<string, number>>
  }) => {
    return remuxMedia(filePath, options)
  })
}
