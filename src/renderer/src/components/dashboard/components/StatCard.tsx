/**
 * @module components/dashboard/StatBar
 * @description The Dashboard's display window: what waits, what runs, and how the current or last batch ended.
 */
import React from 'react'
import { selectGroupCounts, selectLatestRunId, selectRunJobs } from '../../../stores/jobsSelectors'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { cx } from '../../../ui'

/** Jobs waiting for a run: pending and queued. */
export const selectWaitingCount = (state: JobsState): number => selectGroupCounts(state).waiting

/** Jobs in a worker slot: analyzing through finalizing. */
export const selectActiveCount = (state: JobsState): number => selectGroupCounts(state).active

/** Done jobs of the current or last batch; zero when no job belongs to a batch. */
export function selectBatchDoneCount(state: JobsState): number
{
  const runId = selectLatestRunId(state)
  return runId === null ? 0 : selectRunJobs(runId)(state).counts.done
}

/** Jobs of the current or last batch that need attention; zero when no job belongs to a batch. */
export function selectBatchAttentionCount(state: JobsState): number
{
  const runId = selectLatestRunId(state)
  return runId === null ? 0 : selectRunJobs(runId)(state).attention
}

const COUNT = new Intl.NumberFormat('en-US')

function Readout({ label, value, lit = false, tone }: { label: string; value: number; lit?: boolean; tone?: 'warning' }): React.JSX.Element
{
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="type-legend text-brass">{label}</dt>
      <dd
        data-stat={label}
        className={cx(
          'text-section tabular-nums',
          lit ? 'type-readout' : tone === 'warning' ? 'text-warning' : 'text-ink'
        )}
      >
        {COUNT.format(value)}
      </dd>
    </div>
  )
}

/** Waiting, Active, Done, and Need attention, read from the jobs store. */
export function StatBar(): React.JSX.Element
{
  const waiting = useJobsStore(selectWaitingCount)
  const active = useJobsStore(selectActiveCount)
  const done = useJobsStore(selectBatchDoneCount)
  const attention = useJobsStore(selectBatchAttentionCount)
  return (
    <dl
      aria-label="Queue"
      className="flex items-start gap-6 rounded-sm bg-sunken px-4 py-2.5 shadow-well"
    >
      <Readout label="Waiting" value={waiting} />
      <Readout label="Active" value={active} lit={active > 0} />
      <Readout label="Done" value={done} />
      <Readout label="Need attention" value={attention} tone={attention > 0 ? 'warning' : undefined} />
    </dl>
  )
}
