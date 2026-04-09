/**
 * @module main/ffmpeg/processor
 * @description Barrel re-export for the processing pipeline.
 *
 * All imports that previously pointed at `ffmpeg/processor` continue to
 * work unchanged — this module re-exports every public symbol from the
 * decomposed sub-modules.
 */

// Types & helpers
export {
  type ProcessingTask,
  type ConvertOptions,
  type ExtractOptions,
  type CompressOptions,
  type TaskProgressCallback,
  channelLayout,
  stripMolexTag,
  createTempPath,
  cleanupTemp,
  formatElapsed,
  findMediaFiles,
  safeRename,
  ensureDir,
  validateOutput
} from './types'

// Operations
export { normalizeFile } from './normalize'
export { boostFile } from './boost'
export { convertFile } from './convert'
export { extractAudio } from './extract'
export { compressFile } from './compress'

// Batch processing
export { processBatch, pauseProcessing, resumeProcessing, getIsPaused } from './batch'

// Editor operations — removed during NLE rebuild (Phase 0)
