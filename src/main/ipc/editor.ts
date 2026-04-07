/**
 * @module main/ipc/editor
 * @description IPC handlers for the media editor (cut, merge, probe, remux).
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { ipcMain } from 'electron'
import { probeMedia } from '../ffmpeg/probe'
import { cutMedia, mergeMedia, remuxMedia, replaceAudio, type CutOptions, type ProcessingTask } from '../ffmpeg/processor'
import { runCommand } from '../ffmpeg/runner'
import { getConfig } from '../config'
import { logger } from '../logger'
import { registerPreviewFile } from '../protocol'
import { sendToAll } from './helpers'

/**
 * Create a ProcessingTask for an editor operation so the sidebar
 * progress panel can track it alongside batch operations.
 */
function createEditorTask(filePath: string, label: string): ProcessingTask {
  return {
    id: `editor-${Date.now()}`,
    filePath,
    fileName: label,
    operation: 'convert',
    status: 'processing',
    progress: 0,
    message: 'Starting export...',
    startedAt: Date.now()
  }
}

/** Register editor IPC handlers. */
export function registerEditorIPC(): void {
  ipcMain.handle('editor:cut', async (_, filePath: string, inPoint: number, outPoint: number, options?: CutOptions) => {
    const task = createEditorTask(filePath, `${path.basename(filePath)} (export)`)
    sendToAll('process:batch-started', { batchId: task.id, tasks: [task] })

    const result = await cutMedia(filePath, inPoint, outPoint, options, (progress) => {
      task.progress = progress.percent
      task.message = progress.message
      task.status = progress.percent >= 100 ? 'finalizing' : 'processing'
      sendToAll('process:task-progress', task)
      sendToAll('editor:progress', progress)
    })

    task.status = result.success ? 'complete' : 'error'
    task.progress = result.success ? 100 : task.progress
    task.message = result.success ? 'Export complete' : (result.error || 'Export failed')
    task.completedAt = Date.now()
    task.error = result.success ? undefined : result.error
    task.outputPath = result.outputPath
    sendToAll('process:task-progress', task)
    sendToAll('process:batch-complete', { batchId: task.id, results: [task] })

    return result
  })

  ipcMain.handle('editor:merge', async (_, segments: { path: string; inPoint: number; outPoint: number; audioReplacement?: { path: string; offset: number; trimIn: number; trimOut: number } }[], options?: CutOptions) => {
    const label = segments.length === 1 ? 'Export' : `Merge ${segments.length} segments`
    const task = createEditorTask(segments[0]?.path || '', label)
    sendToAll('process:batch-started', { batchId: task.id, tasks: [task] })

    const result = await mergeMedia(segments, options, (progress) => {
      task.progress = progress.percent
      task.message = progress.message
      task.status = progress.percent >= 100 ? 'finalizing' : 'processing'
      sendToAll('process:task-progress', task)
      sendToAll('editor:progress', progress)
    })

    task.status = result.success ? 'complete' : 'error'
    task.progress = result.success ? 100 : task.progress
    task.message = result.success ? 'Merge complete' : (result.error || 'Merge failed')
    task.completedAt = Date.now()
    task.error = result.success ? undefined : result.error
    task.outputPath = result.outputPath
    sendToAll('process:task-progress', task)
    sendToAll('process:batch-complete', { batchId: task.id, results: [task] })

    return result
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

  ipcMain.handle('editor:createPreview', async (_, filePath: string) => {
    const config = await getConfig()
    if (!config.ffmpegPath) return { success: false, error: 'FFmpeg not found' }

    const previewDir = path.join(os.tmpdir(), 'molex-previews')
    fs.mkdirSync(previewDir, { recursive: true })

    const hash = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const previewPath = path.join(previewDir, `preview-${hash}.mp4`)

    const args = [
      '-i', filePath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', previewPath
    ]

    try {
      const { promise } = runCommand(config.ffmpegPath, args)
      const result = await promise
      if (result.code !== 0) {
        logger.error(`Preview transcode failed: ${result.stderr.slice(-200)}`)
        return { success: false, error: 'Transcode failed' }
      }
      const token = registerPreviewFile(previewPath)
      return { success: true, previewUrl: `media://${token}` }
    } catch (err: any) {
      logger.error(`Preview transcode error: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('editor:replaceAudio', async (_, videoPath: string, audioPath: string, options?: { outputDir?: string; audioOffset?: number; inPoint?: number; outPoint?: number }) => {
    const task = createEditorTask(videoPath, `${path.basename(videoPath)} (replace audio)`)
    sendToAll('process:batch-started', { batchId: task.id, tasks: [task] })

    const result = await replaceAudio(videoPath, audioPath, options, (progress) => {
      task.progress = progress.percent
      task.message = progress.message
      task.status = progress.percent >= 100 ? 'finalizing' : 'processing'
      sendToAll('process:task-progress', task)
      sendToAll('editor:progress', progress)
    })

    task.status = result.success ? 'complete' : 'error'
    task.progress = result.success ? 100 : task.progress
    task.message = result.success ? 'Audio replaced' : (result.error || 'Replace audio failed')
    task.completedAt = Date.now()
    task.error = result.success ? undefined : result.error
    task.outputPath = result.outputPath
    sendToAll('process:task-progress', task)
    sendToAll('process:batch-complete', { batchId: task.id, results: [task] })

    return result
  })
}
