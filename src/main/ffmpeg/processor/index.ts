/**
 * @module main/ffmpeg/processor
 * @description Barrel re-export for the processing pipeline.
 *
 * Consolidates all processor sub-modules into a single import surface.
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
export { processBatch, pauseProcessing, resumeProcessing, getIsPaused, setMaxWorkers, getActiveWorkerCount, getTargetWorkers } from './batch'

// Editor operations
export { buildExportCommand, getExportDurationSeconds } from './editor'
export type { ExportRequest, ExportSource, ExportClip, ExportTrack, ExportProject, ExportOutputOptions } from './editor'
