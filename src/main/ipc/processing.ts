/**
 * @module main/ipc/processing
 * @description IPC handlers for batch processing operations.
 *
 * Each handler creates a typed task array, registers an AbortController,
 * and delegates to {@link processBatch}. A shared helper eliminates
 * duplication across the five supported operations: normalize, boost,
 * convert, extract, and compress.
 */

import { ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getConfig } from '../config'
import { logger } from '../logger'
import {
  processBatch,
  pauseProcessing,
  resumeProcessing,
  getIsPaused,
  setMaxWorkers,
  getActiveWorkerCount,
  getTargetWorkers,
  type ProcessingTask
} from '../ffmpeg/processor'
import { killAllProcesses, getActiveProcessCount } from '../ffmpeg/runner'
import {
  activeTasks,
  onTaskProgressWithTray,
  startBatch,
  endBatch,
  notifyBatchComplete,
  sendToAll
} from './helpers'

/* ------------------------------------------------------------------ */
/*  Generic batch launcher                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a batch of tasks from file paths, run them through the
 * concurrent processor, and handle lifecycle events (start / complete /
 * tray progress / notifications).
 *
 * @param filePaths  - Files to process.
 * @param operation  - Processing operation to apply.
 * @param extras     - Additional per-task fields (boostPercent, convertOptions, etc.).
 */
async function runBatchOperation(
  filePaths: string[],
  operation: ProcessingTask['operation'],
  extras: Partial<ProcessingTask> = {}
): Promise<{ batchId: string; results: ProcessingTask[] }> {
  // Validate inputs
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('No files provided for processing')
  }

  const validOps: ProcessingTask['operation'][] = ['normalize', 'boost', 'convert', 'extract', 'compress']
  if (!validOps.includes(operation)) {
    throw new Error(`Invalid operation: ${operation}`)
  }

  // Filter out empty/non-existent paths upfront
  const validPaths = filePaths.filter((f) => {
    if (!f || typeof f !== 'string') return false
    try { return fs.existsSync(f) } catch { return false }
  })
  if (validPaths.length === 0) {
    throw new Error('None of the provided files exist')
  }

  const config = await getConfig()
  const tasks: ProcessingTask[] = validPaths.map((f, i) => ({
    id: `task-${Date.now()}-${i}`,
    filePath: f,
    fileName: path.basename(f),
    operation,
    status: 'queued' as const,
    progress: 0,
    message: 'Waiting...',
    ...extras
  }))

  const abort = new AbortController()
  const batchId = `batch-${Date.now()}`
  activeTasks.set(batchId, abort)

  startBatch(tasks)
  sendToAll('process:batch-started', { batchId, tasks })

  try {
    const results = await processBatch(tasks, config.maxWorkers, onTaskProgressWithTray, abort)
    await notifyBatchComplete(results)
    sendToAll('process:batch-complete', { batchId, results })
    return { batchId, results }
  } finally {
    activeTasks.delete(batchId)
    endBatch()
  }
}

/* ------------------------------------------------------------------ */
/*  Handler registration                                               */
/* ------------------------------------------------------------------ */

/** Register batch processing and process-control IPC handlers. */
export function registerProcessingIPC(): void {
  // --- Batch operations ---
  ipcMain.handle('process:normalize', async (_, filePaths: string[], normalizeOptions?: any, outputDir?: string) => {
    return runBatchOperation(filePaths, 'normalize', { normalizeOptions: normalizeOptions || undefined, outputDir: outputDir || undefined })
  })

  ipcMain.handle('process:boost', async (_, filePaths: string[], boostPercent: number, outputDir?: string) => {
    const bp = Number(boostPercent)
    if (!Number.isFinite(bp)) throw new Error('Invalid boost percentage')
    return runBatchOperation(filePaths, 'boost', { boostPercent: Math.max(-100, Math.min(1000, bp)), outputDir: outputDir || undefined })
  })

  ipcMain.handle('process:convert', async (_, filePaths: string[], convertOptions: any, outputDir?: string) => {
    return runBatchOperation(filePaths, 'convert', { convertOptions, outputDir: outputDir || undefined })
  })

  ipcMain.handle('process:extract', async (_, filePaths: string[], extractOptions: any, outputDir?: string) => {
    return runBatchOperation(filePaths, 'extract', { extractOptions, outputDir: outputDir || undefined })
  })

  ipcMain.handle('process:compress', async (_, filePaths: string[], compressOptions: any, outputDir?: string) => {
    return runBatchOperation(filePaths, 'compress', { compressOptions, outputDir: outputDir || undefined })
  })

  // --- Mixed-operation batch (per-file operation assignments) ---
  ipcMain.handle('process:batch-queue', async (_, taskSpecs: Array<{
    filePath: string; operation: string; outputDir?: string;
    boostPercent?: number; normalizeOptions?: any; convertOptions?: any; extractOptions?: any; compressOptions?: any
  }>, maxWorkersOverride?: number) => {
    if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) {
      throw new Error('No tasks provided')
    }

    const validOps = new Set(['normalize', 'boost', 'convert', 'extract', 'compress'])
    const config = await getConfig()

    // Filter to valid specs upfront
    const validSpecs = taskSpecs.filter((spec) => {
      if (!spec.filePath || typeof spec.filePath !== 'string') return false
      if (!validOps.has(spec.operation)) return false
      try { return fs.existsSync(spec.filePath) } catch { return false }
    })
    if (validSpecs.length === 0) {
      throw new Error('No valid tasks after validation')
    }

    const tasks: ProcessingTask[] = validSpecs.map((spec, i) => ({
      id: `task-${Date.now()}-${i}`,
      filePath: spec.filePath,
      fileName: path.basename(spec.filePath),
      operation: spec.operation as ProcessingTask['operation'],
      status: 'queued' as const,
      progress: 0,
      message: 'Waiting...',
      boostPercent: spec.boostPercent,
      normalizeOptions: spec.normalizeOptions,
      convertOptions: spec.convertOptions,
      extractOptions: spec.extractOptions,
      compressOptions: spec.compressOptions,
      outputDir: spec.outputDir || undefined
    }))

    const abort = new AbortController()
    const batchId = `batch-${Date.now()}`
    activeTasks.set(batchId, abort)

    startBatch(tasks)
    sendToAll('process:batch-started', { batchId, tasks })

    try {
      const workerCount = (maxWorkersOverride && maxWorkersOverride > 0) ? maxWorkersOverride : config.maxWorkers
      const results = await processBatch(tasks, workerCount, onTaskProgressWithTray, abort)
      await notifyBatchComplete(results)
      sendToAll('process:batch-complete', { batchId, results })
      return { batchId, results }
    } finally {
      activeTasks.delete(batchId)
      endBatch()
    }
  })

  // --- Cancel ---
  ipcMain.handle('process:cancel', async (_, batchId: string) => {
    const abort = activeTasks.get(batchId)
    if (abort) {
      abort.abort()
      killAllProcesses()
      logger.warn(`Batch ${batchId} cancelled by user`)
      return true
    }
    return false
  })

  ipcMain.handle('process:cancelAll', async () => {
    for (const [, abort] of activeTasks) {
      abort.abort()
    }
    killAllProcesses()
    activeTasks.clear()
    endBatch()
    logger.warn('All processing cancelled')
    return true
  })

  ipcMain.handle('process:activeCount', () => {
    return getActiveProcessCount()
  })

  // --- Pause / Resume ---
  ipcMain.handle('process:pause', () => {
    pauseProcessing()
    sendToAll('process:paused')
    logger.info('Processing paused by user')
    return true
  })

  ipcMain.handle('process:resume', () => {
    resumeProcessing()
    sendToAll('process:resumed')
    logger.info('Processing resumed by user')
    return true
  })

  ipcMain.handle('process:isPaused', () => {
    return getIsPaused()
  })

  // --- Dynamic workers ---
  ipcMain.handle('process:setWorkers', (_, count: number) => {
    const n = Number(count)
    if (!Number.isFinite(n) || n < 1) throw new Error('Invalid worker count')
    setMaxWorkers(n)
    sendToAll('process:workerStatus', { target: getTargetWorkers(), active: getActiveWorkerCount() })
    return getActiveWorkerCount()
  })

  ipcMain.handle('process:getWorkerStatus', () => ({
    target: getTargetWorkers(),
    active: getActiveWorkerCount()
  }))
}
