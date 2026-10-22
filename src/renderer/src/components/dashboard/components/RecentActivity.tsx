/**
 * @module components/dashboard/RecentActivity
 * @description The last settled jobs, newest first: catalog number, file, operation, batch, when it ended, and the
 * measured stamp or the status word, with the way into Batch's History.
 */
import React from 'react'
import { operationLabel } from '../../../../../shared/jobs/describe'
import type { JobView } from '../../../../../shared/jobs/types'
import { batchLabel, formatTimeOfDay, stampWords, statusWords } from '../../../copy/batch'
import { useAppStore } from '../../../stores/appStore'
import { useBatchView } from '../../../stores/batchView'
import { selectRecentSettled } from '../../../stores/jobsSelectors'
import { useJobsStore } from '../../../stores/jobs'
import { Button, CatalogNumber, Stamp, StatusLabel, usePlatform, type StatusKey } from '../../../ui'
import { ROW_STAMP_FIT, rowStampTooltip } from '../../batch/table/cells'

/** How many settled jobs the Dashboard lists. */
export const RECENT_LIMIT = 10

/** The button that opens Batch's History. */
export const ALL_BATCHES_LABEL = 'All batches'

const selectRecent = selectRecentSettled(RECENT_LIMIT)

/** Opens Batch in History mode. */
export function showHistoryInBatch(showBatch: () => void): void
{
  useBatchView.getState().setMode('history')
  showBatch()
}

function Result({ job }: { job: JobView }): React.JSX.Element
{
  const platform = usePlatform()
  const words = job.stamp === null ? null : stampWords(job)
  if (words !== null)
  {
    return <Stamp outcome={words.tone} values={words.values} size="sm" tooltip={rowStampTooltip(words)} className={ROW_STAMP_FIT} />
  }
  const status = statusWords(job, { platform })
  const key: StatusKey = status.status === 'canceled' ? 'cancelled' : status.status
  return <StatusLabel status={key} label={status.label} held={status.held} />
}

function RecentRow({ job }: { job: JobView }): React.JSX.Element
{
  const operation = job.recipeLabel === '' ? operationLabel(job.recipe.kind) : `${operationLabel(job.recipe.kind)} · ${job.recipeLabel}`
  return (
    <li
      data-job={job.id}
      className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem_minmax(0,14rem)] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 xl:grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,14rem)_5.5rem_4rem_minmax(0,18rem)]"
    >
      <CatalogNumber value={job.id} />
      <span className="truncate text-body text-ink" title={`${job.source.dir}\\${job.source.name}`}>{job.source.name}</span>
      <span data-part="operation" className="hidden truncate text-label text-ink-3 xl:block" title={operation}>{operation}</span>
      <span data-part="batch" className="hidden truncate text-label text-ink-3 tabular-nums xl:block">{job.runId === null ? '' : batchLabel(job.runId)}</span>
      <span data-part="ended" className="truncate text-label text-ink-3 tabular-nums">{job.endedAt === null ? '' : formatTimeOfDay(job.endedAt)}</span>
      <span className="flex min-w-0 items-center">
        <Result job={job} />
      </span>
    </li>
  )
}

/** The latest settled jobs from the jobs store, or a quiet line when none has ended yet. */
export function RecentActivity(): React.JSX.Element
{
  const recent = useJobsStore(selectRecent)
  const setView = useAppStore((s) => s.setView)
  return (
    <section aria-labelledby="dashboard-recent" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <h2 id="dashboard-recent" className="type-legend text-accent-ink">Recent jobs</h2>
        <Button variant="ghost" size="sm" iconEnd="action.next" onClick={() => showHistoryInBatch(() => setView('batch'))}>{ALL_BATCHES_LABEL}</Button>
      </div>
      {recent.length === 0
        ? <p className="text-body text-ink-3">Finished jobs appear here.</p>
        : (
          <ol className="rounded-sm border border-line bg-panel">
            {recent.map((job) => <RecentRow key={job.id} job={job} />)}
          </ol>
        )}
    </section>
  )
}
