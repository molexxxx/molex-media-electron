/**
 * The development mount of the Batch view: the new page on the in-memory preview engine, with a strip that switches
 * back to the previous queue view. Only development builds render it.
 */
import React, { useState } from 'react'
import type { JobsApi } from '../../../shared/jobs/contract'
import { BatchPage } from '../components/batch/BatchPage'
import { FileQueue } from '../components/batch'
import { useJobs } from '../hooks/useJobs'
import { CapsText } from '../ui/CapsText'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'
import { createPreviewJobsApi } from './previewJobs'

/** Which Batch view the development build shows: the new page or the previous queue. */
export type PreviewMode = 'page' | 'legacy'

/** The localStorage key that remembers the chosen {@link PreviewMode}. */
export const PREVIEW_MODE_KEY = 'molexMedia.dev.batchView'

const MODE_OPTIONS: ReadonlyArray<SegmentOption<PreviewMode>> =
[
  { value: 'page', label: 'New page' },
  { value: 'legacy', label: 'Old view' }
]

function defaultStorage(): Storage | null
{
  try
  {
    return window.localStorage
  }
  catch
  {
    return null
  }
}

/** The remembered mode; the new page when nothing valid is stored or storage is unavailable. */
export function readPreviewMode(storage: Storage | null = defaultStorage()): PreviewMode
{
  try
  {
    return storage?.getItem(PREVIEW_MODE_KEY) === 'legacy' ? 'legacy' : 'page'
  }
  catch
  {
    return 'page'
  }
}

/** Remembers the mode; a storage that refuses the write leaves the choice for this session only. */
export function writePreviewMode(mode: PreviewMode, storage: Storage | null = defaultStorage()): void
{
  try
  {
    storage?.setItem(PREVIEW_MODE_KEY, mode)
  }
  catch
  {
    return
  }
}

let windowPreview: JobsApi | null = null

/** The window's one preview engine, created on first use so a remount keeps its queue and runs. */
export function previewJobsApi(): JobsApi
{
  windowPreview ??= createPreviewJobsApi()
  return windowPreview
}

/** Forgets the window's preview engine; for tests. */
export function resetPreviewJobsApi(): void
{
  windowPreview = null
}

/** Props of {@link PreviewBatch}. */
export interface PreviewBatchProps
{
  /** The engine the new page runs on; the window's preview engine by default. */
  api?: JobsApi
  /** Where the mode is remembered; the window's localStorage by default. */
  storage?: Storage | null
}

/**
 * The Batch view of a development build. It keeps the jobs store in sync with the preview engine while the new page
 * shows, mounts the toast region the page's confirmations use, and cancels the shell's view padding so the page's
 * regions meet the window edges.
 */
export function PreviewBatch({ api, storage }: PreviewBatchProps): React.JSX.Element
{
  const [engine] = useState<JobsApi>(() => api ?? previewJobsApi())
  const [mode, setMode] = useState<PreviewMode>(() => readPreviewMode(storage))
  useJobs(mode === 'page' ? engine : null)
  const choose = (next: PreviewMode): void =>
  {
    setMode(next)
    writePreviewMode(next, storage)
  }
  return (
    <div data-preview-mode={mode} className="-m-3 flex min-h-0 flex-1 flex-col sm:-m-4 md:-m-6">
      {mode === 'page' ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <BatchPage api={engine} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4 md:p-6">
          <FileQueue />
        </div>
      )}
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-line bg-sunken px-4">
        <p className="min-w-0 truncate text-label text-ink-3">
          <CapsText className="type-legend text-ink-3">Development preview</CapsText>
          <span className="ms-2">
            {mode === 'page' ? 'Sample jobs on an in-memory engine; no file is read or written.' : 'The previous Batch view on the real engine.'}
          </span>
        </p>
        <SegmentedControl value={mode} onChange={choose} options={MODE_OPTIONS} label="Batch view" size="sm" />
      </div>
    </div>
  )
}
