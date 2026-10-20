/**
 * @module components/dashboard/RecentActivity
 * @description The last six settled jobs, newest first, with their catalog number and status.
 */
import React from 'react'
import { operationLabel } from '../../../../../shared/jobs/describe'
import type { JobView } from '../../../../../shared/jobs/types'
import { statusWords } from '../../../copy/batch'
import { selectRecentSettled } from '../../../stores/jobsSelectors'
import { useJobsStore } from '../../../stores/jobs'
import { CatalogNumber, StatusLabel, usePlatform, type StatusKey } from '../../../ui'

/** How many settled jobs the Dashboard lists. */
export const RECENT_LIMIT = 6

const selectRecent = selectRecentSettled(RECENT_LIMIT)

function RecentRow({ job }: { job: JobView }): React.JSX.Element
{
  const platform = usePlatform()
  const words = statusWords(job, { platform })
  const status: StatusKey = words.status === 'canceled' ? 'cancelled' : words.status
  return (
    <li
      data-job={job.id}
      className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,14rem)_9rem] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
    >
      <CatalogNumber value={job.id} />
      <span className="truncate text-body text-ink" title={`${job.source.dir}\\${job.source.name}`}>{job.source.name}</span>
      <span className="truncate text-label text-ink-3">
        {operationLabel(job.recipe.kind)}
        {job.recipeLabel !== '' && <span className="text-ink-3"> · {job.recipeLabel}</span>}
      </span>
      <StatusLabel status={status} label={words.label} held={words.held} />
    </li>
  )
}

/** The latest settled jobs from the jobs store, or a quiet line when none has ended yet. */
export function RecentActivity(): React.JSX.Element
{
  const recent = useJobsStore(selectRecent)
  return (
    <section aria-labelledby="dashboard-recent" className="flex min-w-0 flex-col gap-2">
      <h2 id="dashboard-recent" className="type-legend text-brass">Recent jobs</h2>
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
