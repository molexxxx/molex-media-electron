/**
 * @module components/logs/logApi
 * @description What the Logs view calls in main, and those calls through the preload bridge.
 */

import type { LogEntry } from '../../stores/types'
import type { JobId } from '../../../../shared/jobs/ids'
import type { CommandResult, JobCommandResponse } from '../../../../shared/jobs/contract'

/** A job's complete FFmpeg output as `jobs:log` returns it. */
export type JobLogResult = JobCommandResponse<'log'>

/** What the Logs view calls in main. */
export interface LogViewerApi
{
  /** Buffered entries; the query narrows them in main. */
  getLogBuffer: (query?: { afterId?: number } & Partial<{ jobId: string, runId: string }>) => Promise<LogEntry[]>
  clearLogs: () => Promise<void>
  openLogDir: () => Promise<void>
  showInFolder: (filePath: string) => Promise<void>
  /** `jobs:log`; absent until the window exposes the jobs API. */
  jobLog?: (req: { jobId: JobId, attempt: number | null }) => Promise<CommandResult<JobLogResult>>
}

interface WindowLogApi
{
  getLogBuffer: LogViewerApi['getLogBuffer']
  clearLogs: LogViewerApi['clearLogs']
  openLogDir: LogViewerApi['openLogDir']
  showInFolder: LogViewerApi['showInFolder']
  jobs?: { log?: LogViewerApi['jobLog'] }
}

/** The Logs view's calls through the preload bridge. */
export function windowLogApi(): LogViewerApi
{
  const api = window.api as unknown as WindowLogApi
  const jobLog = api.jobs?.log
  return {
    getLogBuffer: (query) => api.getLogBuffer(query),
    clearLogs: () => api.clearLogs(),
    openLogDir: () => api.openLogDir(),
    showInFolder: (filePath) => api.showInFolder(filePath),
    jobLog: jobLog ? (req) => jobLog(req) : undefined
  }
}

/** Writes text to the system clipboard; false when the clipboard refuses. */
export async function writeClipboard(text: string): Promise<boolean>
{
  try
  {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch
  {
    return false
  }
}
