/**
 * @module main/ipc/helpers
 * @description Shared IPC utilities: safe broadcast, batch state tracking,
 * tray progress updates, and desktop notifications.
 */

import { BrowserWindow, Notification, app, nativeImage } from 'electron'
import * as path from 'path'
import { getConfig } from '../config'
import { type ProcessingTask } from '../ffmpeg/processor'
import { updateTrayProgress } from '../tray'
import { logger } from '../logger'

/* ------------------------------------------------------------------ */
/*  Active abort controllers                                           */
/* ------------------------------------------------------------------ */

/** Map of batch-id → AbortController for in-flight batches. */
export const activeTasks = new Map<string, AbortController>()

/* ------------------------------------------------------------------ */
/*  Batch progress tracking                                            */
/* ------------------------------------------------------------------ */

let batchTotal = 0
let batchDone = 0

/**
 * Task-progress callback that forwards updates to all renderer windows
 * and keeps the system-tray progress indicator in sync.
 */
export function onTaskProgressWithTray(task: ProcessingTask): void {
  sendToAll('process:task-progress', task)
  if (task.status === 'complete' || task.status === 'error' || task.status === 'cancelled') {
    batchDone++
  }
  const label = task.status === 'processing' || task.status === 'analyzing' || task.status === 'finalizing'
    ? `${task.fileName} — ${task.progress}%`
    : ''
  updateTrayProgress(batchTotal, batchDone, label)
}

/** Reset counters and initialise the tray progress for a new batch. */
export function startBatch(tasks: ProcessingTask[]): void {
  batchTotal = tasks.length
  batchDone = 0
  updateTrayProgress(batchTotal, 0, 'Starting...')
}

/** Clear batch counters and hide tray progress. */
export function endBatch(): void {
  batchTotal = 0
  batchDone = 0
  updateTrayProgress(0, 0, '')
}

/**
 * Show a desktop notification summarising batch results (if the
 * user has notifications enabled in settings).
 */
export async function notifyBatchComplete(results: ProcessingTask[]): Promise<void> {
  const config = await getConfig()
  if (!config.showNotifications) {
    logger.info('Desktop notifications disabled in settings — skipping')
    return
  }

  if (!Notification.isSupported()) {
    logger.warn('Desktop notifications not supported on this platform')
    return
  }

  const succeeded = results.filter((t) => t.status === 'complete').length
  const failed = results.filter((t) => t.status === 'error').length
  const total = results.length

  let body: string
  if (failed === 0) {
    body = `All ${total} file${total === 1 ? '' : 's'} processed successfully.`
  } else {
    body = `${succeeded} of ${total} succeeded, ${failed} failed.`
  }

  try {
    const iconPath = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources'), 'icon.png')
    const notification = new Notification({
      title: 'molexMedia — Batch Complete',
      body,
      icon: nativeImage.createFromPath(iconPath)
    })
    notification.show()
    logger.info(`Desktop notification shown: ${body}`)
  } catch (err: any) {
    logger.error(`Failed to show desktop notification: ${err.message}`)
  }
}

/* ------------------------------------------------------------------ */
/*  Broadcast helper                                                   */
/* ------------------------------------------------------------------ */

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
