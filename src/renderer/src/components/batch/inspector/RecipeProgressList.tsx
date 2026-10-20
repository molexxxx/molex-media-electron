import type { ReactElement } from 'react'
import type { JobId, RunId } from '../../../../../shared/jobs/ids'
import { needsAttention } from '../../../../../shared/jobs/states'
import { TERMINAL_STATES, type JobView } from '../../../../../shared/jobs/types'
import { finishedOf, needAttention } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { ProgressBar } from '../../../ui/ProgressBar'
import { StatusLabel } from '../../../ui/StatusLabel'

/** A filter a count button applies to the job table: exactly the jobs that count counts, and the words its chip shows. */
export interface JobFilter
{
  label: string
  ids: readonly JobId[]
}

/** One recipe's progress in the running batch. */
export interface RecipeProgress
{
  recipe: string
  /** Every job of the recipe in the batch. */
  ids: JobId[]
  finished: number
  /** The jobs of the recipe that need attention. */
  attentionIds: JobId[]
  /** Finished jobs plus the running jobs' own percent, over the recipe's jobs, from 0 to 1. */
  fraction: number
}

/** True once a job has settled; held jobs still wait for a decision. */
export function isFinished(job: Pick<JobView, 'state'>): boolean
{
  return TERMINAL_STATES.includes(job.state)
}

/** The batch's jobs grouped by recipe, in the order each recipe first appears. */
export function recipeProgress(jobs: readonly JobView[], runId: RunId): RecipeProgress[]
{
  const groups = new Map<string, { progress: RecipeProgress; work: number }>()
  for (const job of jobs)
  {
    if (job.runId !== runId)
    {
      continue
    }
    let group = groups.get(job.recipeLabel)
    if (group === undefined)
    {
      group = { progress: { recipe: job.recipeLabel, ids: [], finished: 0, attentionIds: [], fraction: 0 }, work: 0 }
      groups.set(job.recipeLabel, group)
    }
    group.progress.ids.push(job.id)
    if (isFinished(job))
    {
      group.progress.finished += 1
      group.work += 1
    }
    else if (job.progress !== null)
    {
      group.work += Math.min(100, Math.max(0, job.progress.percent)) / 100
    }
    if (needsAttention(job))
    {
      group.progress.attentionIds.push(job.id)
    }
  }
  return [...groups.values()].map(({ progress, work }) => ({ ...progress, fraction: work / progress.ids.length }))
}

/** The filter the finished count applies: every job of the recipe in the batch. */
export function recipeFilter(progress: RecipeProgress): JobFilter
{
  return { label: progress.recipe, ids: progress.ids }
}

/** The filter the attention count applies: the recipe's jobs that need attention. */
export function attentionFilter(progress: RecipeProgress): JobFilter
{
  return { label: `${progress.recipe}, needs attention`, ids: progress.attentionIds }
}

/** Props for {@link RecipeProgressList}. */
export interface RecipeProgressListProps
{
  jobs: readonly JobView[]
  runId: RunId
  onFilter: (filter: JobFilter) => void
  className?: string
}

/** The list's accessible name. */
export const PROGRESS_LIST_LABEL = 'Progress by operation'

/**
 * One line per recipe in the batch with its own progress bar, "9 of 12 finished", and "1 needs attention". Each
 * count is a button that filters the table to the jobs it counts: the recipe's jobs, or those that need attention.
 */
export function RecipeProgressList({ jobs, runId, onFilter, className }: RecipeProgressListProps): ReactElement
{
  const recipes = recipeProgress(jobs, runId)
  return (
    <ul aria-label={PROGRESS_LIST_LABEL} className={cx('flex flex-col gap-3', className)}>
      {recipes.map((progress) =>
      {
        const total = progress.ids.length
        const settled = progress.finished === total
        return (
          <li key={progress.recipe} className="flex flex-col gap-1" data-recipe={progress.recipe}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 flex-1 truncate text-body text-ink" title={progress.recipe}>{progress.recipe}</span>
              {settled && <StatusLabel status="done" label="Finished" />}
              <Button variant="ghost" size="sm" className="tabular-nums" onClick={() => onFilter(recipeFilter(progress))}>
                {finishedOf(progress.finished, total)}
              </Button>
              {progress.attentionIds.length > 0 && (
                <Button variant="ghost" size="sm" className="tabular-nums text-warning" onClick={() => onFilter(attentionFilter(progress))}>
                  {needAttention(progress.attentionIds.length)}
                </Button>
              )}
            </div>
            <ProgressBar value={progress.fraction} label={`${progress.recipe} progress`} size="sm" />
          </li>
        )
      })}
    </ul>
  )
}
