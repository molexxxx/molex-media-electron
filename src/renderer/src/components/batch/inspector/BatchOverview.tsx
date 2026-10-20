import { useId, type ReactElement, type ReactNode } from 'react'
import type { JobId, RunId } from '../../../../../shared/jobs/ids'
import { ACTIVE_STATES, type BatchSummary, type JobState, type JobView, type RunState, type WorkersState } from '../../../../../shared/jobs/types'
import { PART_SEPARATOR, countOf, formatCount, formatPercent } from '../../../copy/batch'
import { cx } from '../../../ui/cx'
import { CatalogNumber } from '../../../ui/CatalogNumber'
import { StatusLabel, type StatusKey } from '../../../ui/StatusLabel'
import { LoudnessPlot, loudnessPoints } from './LoudnessPlot'
import { OutcomeByRecipeTable } from './OutcomeByRecipeTable'
import { RecipeProgressList, type JobFilter } from './RecipeProgressList'

/** Which batch view the inspector shows with nothing selected. */
export type OverviewPhase = 'before' | 'running' | 'after'

/** The most running jobs "Running now" lists. */
export const RUNNING_NOW_LIMIT = 8

/** The overview's words. */
export const OVERVIEW_WORDS = {
  label: 'Batch overview',
  intro: 'Select jobs to change their settings, preview their output, and read their result. With nothing selected, this panel follows the whole batch.',
  output: 'Output',
  newFiles: 'New files',
  progress: 'Progress by operation',
  runningNow: 'Running now',
  noneRunning: 'No jobs are running.',
  workers: 'Workers',
  outcome: 'Results by operation',
  loudness: 'Loudness'
} as const

/** Before any batch, while one runs, or after one, from the run state and the last summary. */
export function overviewPhase(run: Pick<RunState, 'status' | 'runId'>, summary: BatchSummary | null): OverviewPhase
{
  if (run.runId !== null && run.status !== 'idle')
  {
    return 'running'
  }
  return summary === null ? 'before' : 'after'
}

/** "6 of 16 workers busy · 2 CPU video encodes · 1 GPU encode". */
export function workersLine(workers: WorkersState): string
{
  const parts = [`${formatCount(workers.active.total)} of ${countOf(workers.limits.total, 'worker')} busy`]
  if (workers.active.videoCpu > 0)
  {
    parts.push(countOf(workers.active.videoCpu, 'CPU video encode'))
  }
  if (workers.active.gpu > 0)
  {
    parts.push(countOf(workers.active.gpu, 'GPU encode'))
  }
  return parts.join(PART_SEPARATOR)
}

/** The running jobs of the batch, at most {@link RUNNING_NOW_LIMIT}, and how many more there are. */
export function runningNow(jobs: readonly JobView[], runId: RunId): { shown: JobView[]; more: number }
{
  const running = jobs.filter((job) => job.runId === runId && ACTIVE_STATES.includes(job.state))
  return { shown: running.slice(0, RUNNING_NOW_LIMIT), more: Math.max(0, running.length - RUNNING_NOW_LIMIT) }
}

const ACTIVE_STATUS: Partial<Record<JobState, StatusKey>> = {
  analyzing: 'analyzing',
  encoding: 'encoding',
  verifying: 'verifying',
  finalizing: 'finalizing'
}

const CAPTION = 'type-legend text-accent-ink'

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement
{
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className={CAPTION}>{title}</h3>
      {children}
    </section>
  )
}

interface RunningNowProps
{
  jobs: readonly JobView[]
  runId: RunId
  onFocusJob: (id: JobId) => void
}

function RunningNow({ jobs, runId, onFocusJob }: RunningNowProps): ReactElement
{
  const { shown, more } = runningNow(jobs, runId)
  if (shown.length === 0)
  {
    return <p className="text-body text-ink-3">{OVERVIEW_WORDS.noneRunning}</p>
  }
  return (
    <ul aria-label={OVERVIEW_WORDS.runningNow} className="flex flex-col">
      {shown.map((job) => (
        <li key={job.id}>
          <button
            type="button"
            onClick={() => onFocusJob(job.id)}
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-xs px-1 py-1 text-left hover:bg-wash-hover active:bg-wash-pressed"
          >
            <CatalogNumber value={job.id} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-body text-ink" title={job.source.name}>{job.source.name}</span>
              <StatusLabel status={ACTIVE_STATUS[job.state] ?? 'encoding'} label={job.stage?.label} />
            </span>
            <span className="tabular-nums text-label text-ink">{formatPercent(job.progress?.percent ?? 0)}</span>
          </button>
        </li>
      ))}
      {more > 0 && <li className="px-1 pt-1 text-label text-ink-3">{`and ${formatCount(more)} more`}</li>}
    </ul>
  )
}

/** Props for {@link BatchOverview}. */
export interface BatchOverviewProps
{
  jobs: readonly JobView[]
  run: RunState
  /** The last finished batch, while its jobs are on the page. */
  summary: BatchSummary | null
  /** The output policy as a sentence, as the run header's consequence line states it. */
  outputPolicy: string
  /** The recipe new files get, for example "Normalize · Apple Podcasts". */
  newFilesRecipe: string
  /** Source integrated loudness per job, from the jobs' measurements, for the strip plot's hollow marks. */
  sourceLoudness?: ReadonlyMap<JobId, number>
  /** Filters the job table to exactly the jobs a count counts. */
  onFilter: (filter: JobFilter) => void
  /** Moves focus to a job's row. */
  onFocusJob: (id: JobId) => void
  className?: string
}

/**
 * The inspector with nothing selected. Before a batch: what the inspector does, the output policy, and the recipe
 * new files get. During one: progress by recipe, the jobs running now, and the workers in use. After one: outcomes
 * by recipe and the loudness strip plot with its data table.
 */
export function BatchOverview({
  jobs,
  run,
  summary,
  outputPolicy,
  newFilesRecipe,
  sourceLoudness,
  onFilter,
  onFocusJob,
  className
}: BatchOverviewProps): ReactElement
{
  const phase = overviewPhase(run, summary)
  return (
    <div aria-label={OVERVIEW_WORDS.label} role="group" data-phase={phase} className={cx('flex flex-col gap-5 select-text', className)}>
      {phase === 'before' && (
        <>
          <Section title={OVERVIEW_WORDS.output}>
            <p className="text-body text-ink">{outputPolicy}</p>
          </Section>
          <Section title={OVERVIEW_WORDS.newFiles}>
            <p className="text-body text-ink">{newFilesRecipe}</p>
          </Section>
        </>
      )}
      {phase === 'running' && run.runId !== null && (
        <>
          <Section title={OVERVIEW_WORDS.progress}>
            <RecipeProgressList jobs={jobs} runId={run.runId} onFilter={onFilter} />
          </Section>
          <Section title={OVERVIEW_WORDS.runningNow}>
            <RunningNow jobs={jobs} runId={run.runId} onFocusJob={onFocusJob} />
          </Section>
          <Section title={OVERVIEW_WORDS.workers}>
            <p className="tabular-nums text-label text-ink-2">{workersLine(run.workers)}</p>
          </Section>
        </>
      )}
      {phase === 'after' && summary !== null && (
        <>
          <OutcomeByRecipeTable summary={summary} jobs={jobs} onFilter={onFilter} />
          <Section title={OVERVIEW_WORDS.loudness}>
            <LoudnessPlot points={loudnessPoints(jobs, summary, sourceLoudness)} onSelectJob={onFocusJob} />
          </Section>
        </>
      )}
    </div>
  )
}
