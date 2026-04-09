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
/*  Dynamic worker pool                                                */
/* ------------------------------------------------------------------ */

let targetWorkers = 0
let activeWorkerCount = 0

/** Update the target number of concurrent workers mid-batch. */
export function setMaxWorkers(n: number): void {
  targetWorkers = Math.max(1, n)
  // If more workers are needed and a batch is in flight, spawnWorker is called below
  if (batchState && activeWorkerCount < targetWorkers) {
    while (activeWorkerCount < targetWorkers && batchState.index < batchState.total) {
      spawnWorker(batchState)
    }
  }
  logger.info(`Target workers set to ${targetWorkers} (active: ${activeWorkerCount})`)
}

/** Return the number of currently running worker loops. */
export function getActiveWorkerCount(): number {
  return activeWorkerCount
}

/** Return the current target concurrency. */
export function getTargetWorkers(): number {
  return targetWorkers
}

/* ------------------------------------------------------------------ */
/*  Batch state (shared across workers for a single batch)             */
/* ------------------------------------------------------------------ */

interface BatchState {
  tasks: ProcessingTask[]
  results: ProcessingTask[]
  index: number
  total: number
  onProgress: TaskProgressCallback
  abortSignal?: AbortController
  workerPromises: Promise<void>[]
}

let batchState: BatchState | null = null

/* ------------------------------------------------------------------ */
/*  Worker & dispatcher                                                */
/* ------------------------------------------------------------------ */

async function runWorker(state: BatchState): Promise<void> {
  activeWorkerCount++
  try {
    while (state.index < state.total) {
      // Self-terminate if over target
      if (activeWorkerCount > targetWorkers) {
        return
      }

      if (state.abortSignal?.signal.aborted) break

      // Wait if paused
      if (pausePromise) {
        await pausePromise
      }
      if (state.abortSignal?.signal.aborted) break

      const i = state.index++
      const task = state.tasks[i]
      task.message = `Queued (${i + 1}/${state.total})`
      state.onProgress(task)

      let result: ProcessingTask
      if (task.operation === 'normalize') {
        result = await normalizeFile(task, state.onProgress, state.abortSignal)
      } else if (task.operation === 'boost') {
        result = await boostFile(task, state.onProgress, state.abortSignal)
      } else if (task.operation === 'convert') {
        result = await convertFile(task, state.onProgress, state.abortSignal)
      } else if (task.operation === 'extract') {
        result = await extractAudio(task, state.onProgress, state.abortSignal)
      } else if (task.operation === 'compress') {
        result = await compressFile(task, state.onProgress, state.abortSignal)
      } else {
        task.status = 'error'
        task.error = `Unknown operation: ${task.operation}`
        task.message = `Error: unknown operation "${task.operation}"`
        task.completedAt = Date.now()
        state.onProgress(task)
        result = task
      }
      state.results.push(result)
    }
  } finally {
    activeWorkerCount--
  }
}

function spawnWorker(state: BatchState): void {
  const p = runWorker(state)
  state.workerPromises.push(p)
}

/* ------------------------------------------------------------------ */
/*  Batch runner                                                       */
/* ------------------------------------------------------------------ */

/**
 * Process an array of tasks using a dynamic concurrent worker pool.
 *
 * Each worker pulls the next task from the shared queue and dispatches
 * it to the matching operation handler. Workers honour pause state and
 * abort signals between tasks. Worker count can be adjusted mid-batch
 * via {@link setMaxWorkers}.
 *
 * @param tasks          - Ordered list of tasks to process.
 * @param maxConcurrency - Initial maximum number of simultaneous FFmpeg processes.
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
  const total = tasks.length
  targetWorkers = Math.min(maxConcurrency, total)

  const state: BatchState = {
    tasks,
    results: [],
    index: 0,
    total,
    onProgress,
    abortSignal,
    workerPromises: []
  }

  batchState = state

  logger.info(`Starting batch: ${total} files, ${targetWorkers} concurrent workers`)

  // Spawn initial workers
  const initialCount = Math.min(targetWorkers, total)
  for (let i = 0; i < initialCount; i++) {
    spawnWorker(state)
  }

  await Promise.all(state.workerPromises)

  batchState = null

  // Reset pause state when batch ends
  isPaused = false
  pauseResolve = null
  pausePromise = null

  const succeeded = state.results.filter((r) => r.status === 'complete').length
  const failed = state.results.filter((r) => r.status === 'error').length
  logger.info(`Batch complete: ${succeeded} succeeded, ${failed} failed, ${total - succeeded - failed} other`)

  return state.results
}
