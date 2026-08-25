/**
 * @module stores/taskSettings
 * @description Resolves the settings a queued file will actually be
 * processed with.
 *
 * Files are stamped with the panel's settings when they are added to the
 * queue. That snapshot is only a starting point: until a file is edited
 * individually, it should keep tracking the live operation panel. Without
 * this resolution step, changing the boost slider (or the operation, or a
 * preset) after files were added had no effect on the run - the queue
 * dispatched the values captured at add time instead, so a user who added
 * files and then asked for +100 % got the default +10 %.
 *
 * A file becomes "customized" the moment it is edited through the inline
 * settings editor (directly, or via "Apply to all"). From then on its own
 * values win, and the panel no longer overrides it.
 */

import type {
  FileItem,
  Operation,
  BoostOptions,
  NormalizeOptions,
  ConvertOptions,
  ExtractOptions,
  CompressOptions
} from './types'

/** The live operation-panel state a non-customized file follows. */
export interface GlobalOperationSettings {
  operation: Operation
  boostPercent: number
  boostOptions: BoostOptions
  normalizeOptions: NormalizeOptions
  convertOptions: ConvertOptions
  extractOptions: ExtractOptions
  compressOptions: CompressOptions
  selectedPreset?: string | null
  selectedBoostPreset?: string | null
  selectedConvertPreset?: string | null
  selectedExtractPreset?: string | null
  selectedCompressPreset?: string | null
}

/** Effective settings for one queued file. */
export interface ResolvedFileSettings {
  operation: Operation
  boostPercent: number
  boostOptions: BoostOptions
  normalizeOptions: NormalizeOptions
  convertOptions: ConvertOptions
  extractOptions: ExtractOptions
  compressOptions: CompressOptions
  selectedPreset: string | null
  selectedBoostPreset: string | null
  selectedConvertPreset: string | null
  selectedExtractPreset: string | null
  selectedCompressPreset: string | null
}

/**
 * True when this file carries its own settings and should ignore later
 * changes made in the operation panel.
 */
export function isCustomized(file: FileItem): boolean {
  return file.customized === true
}

/**
 * Resolve the settings a file will be processed with.
 *
 * A customized file uses its own stamped values, falling back to the
 * globals only for options it never captured. An untouched file follows
 * the live panel state so what the user sees is what runs.
 */
export function resolveFileSettings(
  file: FileItem,
  globals: GlobalOperationSettings
): ResolvedFileSettings {
  if (!isCustomized(file)) {
    return {
      operation: globals.operation,
      boostPercent: globals.boostPercent,
      boostOptions: globals.boostOptions,
      normalizeOptions: globals.normalizeOptions,
      convertOptions: globals.convertOptions,
      extractOptions: globals.extractOptions,
      compressOptions: globals.compressOptions,
      selectedPreset: globals.selectedPreset ?? null,
      selectedBoostPreset: globals.selectedBoostPreset ?? null,
      selectedConvertPreset: globals.selectedConvertPreset ?? null,
      selectedExtractPreset: globals.selectedExtractPreset ?? null,
      selectedCompressPreset: globals.selectedCompressPreset ?? null
    }
  }

  return {
    operation: file.operation ?? globals.operation,
    boostPercent: typeof file.boostPercent === 'number' ? file.boostPercent : globals.boostPercent,
    boostOptions: file.boostOptions ?? globals.boostOptions,
    normalizeOptions: file.normalizeOptions ?? globals.normalizeOptions,
    convertOptions: file.convertOptions ?? globals.convertOptions,
    extractOptions: file.extractOptions ?? globals.extractOptions,
    compressOptions: file.compressOptions ?? globals.compressOptions,
    selectedPreset: file.selectedPreset ?? globals.selectedPreset ?? null,
    selectedBoostPreset: file.selectedBoostPreset ?? globals.selectedBoostPreset ?? null,
    selectedConvertPreset: file.selectedConvertPreset ?? globals.selectedConvertPreset ?? null,
    selectedExtractPreset: file.selectedExtractPreset ?? globals.selectedExtractPreset ?? null,
    selectedCompressPreset: file.selectedCompressPreset ?? globals.selectedCompressPreset ?? null
  }
}

/** The task payload shape sent over IPC for one queued file. */
export interface TaskSpec {
  filePath: string
  operation: Operation
  outputDir?: string
  boostPercent?: number
  boostOptions?: BoostOptions
  normalizeOptions?: NormalizeOptions
  convertOptions?: ConvertOptions
  extractOptions?: ExtractOptions
  compressOptions?: CompressOptions
}

/**
 * Build the IPC task spec for a queued file.
 *
 * Only the options the chosen operation actually consumes are attached,
 * so an unrelated stale option can never reach the main process.
 */
export function buildTaskSpec(
  file: FileItem,
  globals: GlobalOperationSettings,
  outputDir?: string
): TaskSpec {
  const resolved = resolveFileSettings(file, globals)
  const spec: TaskSpec = {
    filePath: file.path,
    operation: resolved.operation,
    outputDir
  }

  switch (resolved.operation) {
    case 'boost':
      // boostOptions.percent is what the advanced panel edits; it is the
      // authority whenever the two have drifted apart.
      spec.boostPercent = typeof resolved.boostOptions?.percent === 'number'
        ? resolved.boostOptions.percent
        : resolved.boostPercent
      spec.boostOptions = resolved.boostOptions
      break
    case 'normalize':
      spec.normalizeOptions = resolved.normalizeOptions
      break
    case 'convert':
      spec.convertOptions = resolved.convertOptions
      break
    case 'extract':
      spec.extractOptions = resolved.extractOptions
      break
    case 'compress':
      spec.compressOptions = resolved.compressOptions
      break
  }

  return spec
}
