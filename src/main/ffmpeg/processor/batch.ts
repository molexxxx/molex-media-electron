/**
 * @module main/ffmpeg/processor/batch
 * @description Concurrent batch processing engine.
 *
 * Manages a pool of worker promises that pull tasks from a shared queue
 * and dispatch them to the appropriate operation handler. Supports
 * mid-batch pause, resume, and cancellation via AbortController.
 */

import { logger } from '../../logger'
import { type ProcessingTask, type TaskProgressCallback } from './types'
import { normalizeFile } from './normalize'
import { boostFile } from './boost'
import { convertFile } from './convert'
import { extractAudio } from './extract'
import { compressFile } from './compress'

/* ------------------------------------------------------------------ */
/*  Pause / resume state                                              */
/* ------------------------------------------------------------------ */

let pauseResolve: (() => void) | null = null
let pausePromise: Promise<void> | null = null
let isPaused = false

/** Pause all running batch workers after their current task completes. */
export function pauseProcessing(): void {
  if (isPaused) return
  isPaused = true
  pausePromise = new Promise<void>((resolve) => {
    pauseResolve = resolve
  })
  logger.info('Processing paused')
}

/** Resume paused batch workers. */
export function resumeProcessing(): void {
  if (!isPaused) return
  isPaused = false
  if (pauseResolve) {
    pauseResolve()
    pauseResolve = null
    pausePromise = null
  }
  logger.info('Processing resumed')
}

/** Return the current paused state. */
export function getIsPaused(): boolean {
  return isPaused
}

/* ------------------------------------------------------------------ */
/*  Batch runner                                                       */
/* ------------------------------------------------------------------ */

/**
 * Process an array of tasks using a concurrent worker pool.
 *
 * Each worker pulls the next task from the shared queue and dispatches
 * it to the matching operation handler. Workers honour pause state and
 * abort signals between tasks.
 *
 * @param tasks          - Ordered list of tasks to process.
 * @param maxConcurrency - Maximum number of simultaneous FFmpeg processes.
 * @param onProgress     - Callback for status / progress updates.
 * @param abortSignal    - Optional abort controller for batch-level cancel.
 * @returns All processed tasks (completed, errored, or cancelled).
 */
export async function processBatch(
  tasks: ProcessingTask[],
  maxConcurrency: number,
  onProgress: TaskProgressCallback,
  abortSignal?: AbortController
): Promise<ProcessingTask[]> {
  const results: ProcessingTask[] = []
  let index = 0
  const total = tasks.length

  logger.info(`Starting batch: ${total} files, ${maxConcurrency} concurrent workers`)

  async function worker(): Promise<void> {
    while (index < total) {
      if (abortSignal?.signal.aborted) break

      // Wait if paused
      if (pausePromise) {
        await pausePromise
      }
      if (abortSignal?.signal.aborted) break

      const i = index++
      const task = tasks[i]
      task.message = `Queued (${i + 1}/${total})`
      onProgress(task)

      let result: ProcessingTask
      if (task.operation === 'normalize') {
        result = await normalizeFile(task, onProgress, abortSignal)
      } else if (task.operation === 'boost') {
        result = await boostFile(task, onProgress, abortSignal)
      } else if (task.operation === 'convert') {
        result = await convertFile(task, onProgress, abortSignal)
      } else if (task.operation === 'extract') {
        result = await extractAudio(task, onProgress, abortSignal)
      } else if (task.operation === 'compress') {
        result = await compressFile(task, onProgress, abortSignal)
      } else {
        task.status = 'error'
        task.error = `Unknown operation: ${task.operation}`
        task.message = `Error: unknown operation "${task.operation}"`
        task.completedAt = Date.now()
        onProgress(task)
        result = task
      }
      results.push(result)
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, total) }, () => worker())
  await Promise.all(workers)

  // Reset pause state when batch ends
  isPaused = false
  pauseResolve = null
  pausePromise = null

  const succeeded = results.filter((r) => r.status === 'complete').length
  const failed = results.filter((r) => r.status === 'error').length
  logger.info(`Batch complete: ${succeeded} succeeded, ${failed} failed, ${total - succeeded - failed} other`)

  return results
}
