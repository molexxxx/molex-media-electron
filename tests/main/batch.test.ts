import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all operation handlers
const mockNormalize = vi.fn()
const mockBoost = vi.fn()
const mockConvert = vi.fn()
const mockExtract = vi.fn()
const mockCompress = vi.fn()

vi.mock('../../src/main/ffmpeg/processor/normalize', () => ({
  normalizeFile: (...a: any[]) => mockNormalize(...a)
}))
vi.mock('../../src/main/ffmpeg/processor/boost', () => ({
  boostFile: (...a: any[]) => mockBoost(...a)
}))
vi.mock('../../src/main/ffmpeg/processor/convert', () => ({
  convertFile: (...a: any[]) => mockConvert(...a)
}))
vi.mock('../../src/main/ffmpeg/processor/extract', () => ({
  extractAudio: (...a: any[]) => mockExtract(...a)
}))
vi.mock('../../src/main/ffmpeg/processor/compress', () => ({
  compressFile: (...a: any[]) => mockCompress(...a)
}))
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

import { processBatch, pauseProcessing, resumeProcessing, getIsPaused } from '../../src/main/ffmpeg/processor/batch'
import type { ProcessingTask } from '../../src/main/ffmpeg/processor/types'

function makeTask(id: string, op: ProcessingTask['operation']): ProcessingTask {
  return {
    id,
    filePath: `/${id}.mp3`,
    fileName: `${id}.mp3`,
    operation: op,
    status: 'queued',
    progress: 0,
    message: ''
  }
}

describe('processBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset pause state
    resumeProcessing()

    // Default: each handler returns the task with status complete
    for (const fn of [mockNormalize, mockBoost, mockConvert, mockExtract, mockCompress]) {
      fn.mockImplementation(async (task: ProcessingTask) => {
        task.status = 'complete'
        task.progress = 100
        return task
      })
    }
  })

  it('dispatches normalize tasks to normalizeFile', async () => {
    const tasks = [makeTask('t1', 'normalize')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)
    expect(mockNormalize).toHaveBeenCalledTimes(1)
  })

  it('dispatches boost tasks to boostFile', async () => {
    const tasks = [makeTask('t1', 'boost')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)
    expect(mockBoost).toHaveBeenCalledTimes(1)
  })

  it('dispatches convert tasks to convertFile', async () => {
    const tasks = [makeTask('t1', 'convert')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)
    expect(mockConvert).toHaveBeenCalledTimes(1)
  })

  it('dispatches extract tasks to extractAudio', async () => {
    const tasks = [makeTask('t1', 'extract')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)
    expect(mockExtract).toHaveBeenCalledTimes(1)
  })

  it('dispatches compress tasks to compressFile', async () => {
    const tasks = [makeTask('t1', 'compress')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)
    expect(mockCompress).toHaveBeenCalledTimes(1)
  })

  it('processes multiple tasks concurrently', async () => {
    const tasks = [
      makeTask('t1', 'normalize'),
      makeTask('t2', 'normalize'),
      makeTask('t3', 'normalize')
    ]
    const onProgress = vi.fn()
    const results = await processBatch(tasks, 2, onProgress)
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'complete')).toBe(true)
  })

  it('limits concurrency to task count', async () => {
    const tasks = [makeTask('t1', 'normalize')]
    const onProgress = vi.fn()
    await processBatch(tasks, 10, onProgress)
    // Should only create 1 worker (min of concurrency and task count)
    expect(mockNormalize).toHaveBeenCalledTimes(1)
  })

  it('stops processing when aborted', async () => {
    const abort = new AbortController()
    let callCount = 0

    mockNormalize.mockImplementation(async (task: ProcessingTask) => {
      callCount++
      if (callCount === 1) abort.abort()
      task.status = 'complete'
      return task
    })

    const tasks = [
      makeTask('t1', 'normalize'),
      makeTask('t2', 'normalize'),
      makeTask('t3', 'normalize')
    ]
    const onProgress = vi.fn()
    const results = await processBatch(tasks, 1, onProgress, abort)

    // Should stop after first task triggers abort
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('resets pause state after batch completes', async () => {
    pauseProcessing()
    expect(getIsPaused()).toBe(true)

    // Immediately resume so batch can proceed
    resumeProcessing()

    const tasks = [makeTask('t1', 'normalize')]
    const onProgress = vi.fn()
    await processBatch(tasks, 1, onProgress)

    expect(getIsPaused()).toBe(false)
  })

  it('invokes onProgress for each task', async () => {
    const tasks = [makeTask('t1', 'normalize'), makeTask('t2', 'boost')]
    const onProgress = vi.fn()
    await processBatch(tasks, 2, onProgress)

    // At minimum, each task gets 1 progress update (queued message) + handler updates
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('errors on unknown operations instead of falling through', async () => {
    const task = makeTask('t1', 'normalize')
    ;(task as any).operation = 'unknown_op'
    const onProgress = vi.fn()
    const results = await processBatch([task], 1, onProgress)
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('Unknown operation')
    expect(mockNormalize).not.toHaveBeenCalled()
  })

  it('pauses and resumes during batch processing', async () => {
    let taskIndex = 0
    mockNormalize.mockImplementation(async (task: ProcessingTask) => {
      taskIndex++
      if (taskIndex === 1) {
        // Pause, then resume on next tick so the second task can proceed
        pauseProcessing()
        queueMicrotask(() => resumeProcessing())
      }
      task.status = 'complete'
      task.progress = 100
      return task
    })

    const tasks = [makeTask('t1', 'normalize'), makeTask('t2', 'normalize')]
    const onProgress = vi.fn()
    const results = await processBatch(tasks, 1, onProgress)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'complete')).toBe(true)
  })

  it('waits when paused at batch start and resumes', async () => {
    pauseProcessing()
    const batchPromise = processBatch([makeTask('t1', 'normalize')], 1, vi.fn())
    resumeProcessing()
    const results = await batchPromise
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('complete')
  })

  it('handles abort while paused', async () => {
    const abort = new AbortController()
    pauseProcessing()
    const batchPromise = processBatch([makeTask('t1', 'normalize'), makeTask('t2', 'normalize')], 1, vi.fn(), abort)
    abort.abort()
    resumeProcessing()
    const results = await batchPromise
    expect(results.length).toBeLessThanOrEqual(1)
  })
})
