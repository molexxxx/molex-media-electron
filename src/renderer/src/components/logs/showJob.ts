/**
 * @module components/logs/showJob
 * @description Opens Batch on the job a log line names: its row in the list that holds it, or, once the job has left
 * the lists, its batch in History (or a History search for its number when the line names no batch).
 */

import { useAppStore } from '../../stores/appStore'
import { modeRows, useBatchView, type BatchMode } from '../../stores/batchView'
import { useJobsStore } from '../../stores/jobs'

/** Where "Show job" landed. */
export type ShowJobPlace = 'list' | 'history'

/**
 * Shows a job in Batch. A job still in the lists is selected in the current list when that list holds it, else in
 * Queue, which holds every job; Batch then moves focus to its row as it shows.
 */
export function showJobInBatch(jobId: string, runId?: string): ShowJobPlace
{
  const jobs = useJobsStore.getState()
  const view = useBatchView.getState()
  const app = useAppStore.getState()
  if (Object.hasOwn(jobs.jobs, jobId))
  {
    const holds = (mode: BatchMode): boolean => modeRows(mode, jobs).some((job) => job.id === jobId)
    const mode: BatchMode = view.mode !== 'history' && holds(view.mode) ? view.mode : 'queue'
    view.setMode(mode)
    view.select(mode, { type: 'click', id: jobId })
    app.setView('batch')
    return 'list'
  }
  if (runId !== undefined)
  {
    view.openHistoryBatch(runId, jobId)
  }
  else
  {
    view.setMode('history')
    view.setHistoryQuery(jobId)
  }
  app.setView('batch')
  return 'history'
}
