import { useId, type ReactElement, type ReactNode } from 'react'
import { formatNumber } from '../../../../../shared/audio/messages'
import type { JobId } from '../../../../../shared/jobs/ids'
import type { BatchSummary, JobView, RecipeOutcome } from '../../../../../shared/jobs/types'
import { formatBytes, formatCount, formatLoudness, formatTolerance, formatTruePeak } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import type { JobFilter } from './RecipeProgressList'

/** The table's column headings. */
export const OUTCOME_COLUMNS = ['Operation', 'Jobs', 'Check', 'Within tolerance', 'Integrated range', 'Highest true peak', 'Limiting applied'] as const

/** The table's caption. */
export const OUTCOME_CAPTION = 'Results by operation'

/** The words a cell shows for a value the recipe never measured. */
export const NOT_MEASURED = 'Not measured'

/** The words the limiting cell shows when no job was limited. */
export const NO_LIMITING = 'None'

/** One recipe's row: the counts it shows and the jobs each count filters to. */
export interface OutcomeRow
{
  outcome: RecipeOutcome
  jobs: JobFilter
  within: { count: number; filter: JobFilter } | null
  limited: { count: number; filter: JobFilter } | null
}

function limitedJob(job: JobView): boolean
{
  return job.audioPlan?.some((cell) => cell.limitingDb > 0) ?? false
}

function withinJob(job: JobView, outcome: RecipeOutcome): boolean
{
  if (outcome.loudness !== null)
  {
    return job.stamp?.loudness?.status === 'within'
  }
  return job.stamp?.size?.status === 'within'
}

/**
 * The rows of a finished batch, one per recipe outcome. Counts come from the summary; each filter lists the jobs of
 * the run that the count counts: the recipe's jobs, those verified within their check, and those with peak limiting.
 */
export function outcomeRows(summary: BatchSummary, jobs: readonly JobView[]): OutcomeRow[]
{
  return summary.recipes.map((outcome) =>
  {
    const own = jobs.filter((job) => job.runId === summary.runId && job.recipeLabel === outcome.label)
    const ids = (keep: (job: JobView) => boolean): JobId[] => own.filter(keep).map((job) => job.id)
    const loudness = outcome.loudness
    const withinCount = loudness !== null
      ? loudness.checks.reduce((sum, check) => sum + check.within, 0)
      : outcome.size?.within ?? null
    return {
      outcome,
      jobs: { label: outcome.label, ids: ids(() => true) },
      within: withinCount === null
        ? null
        : { count: withinCount, filter: { label: `${outcome.label}, within tolerance`, ids: ids((job) => withinJob(job, outcome)) } },
      limited: loudness === null
        ? null
        : { count: loudness.limitedJobs, filter: { label: `${outcome.label}, peak limiting applied`, ids: ids(limitedJob) } }
    }
  })
}

/** The check cell: "±0.5 dB lossless, ±1.0 dB lossy", "At or under 25 MB", or "Not checked". */
export function checkCell(outcome: RecipeOutcome): string
{
  const loudness = outcome.loudness
  if (loudness !== null && loudness.checks.length > 0)
  {
    return loudness.checks
      .map((check) => `${formatTolerance(check.check, loudness.deviationUnit)} ${check.checkClass}`)
      .join(', ')
  }
  if (outcome.size !== null)
  {
    return `At or under ${formatBytes(outcome.size.targetBytes)}`
  }
  return 'Not checked'
}

/** The integrated range cell: "−16.2 to −15.9 LKFS". */
export function rangeCell(outcome: RecipeOutcome): string
{
  const loudness = outcome.loudness
  if (loudness === null || loudness.minLufs === null || loudness.maxLufs === null)
  {
    return NOT_MEASURED
  }
  if (loudness.minLufs === loudness.maxLufs)
  {
    return formatLoudness(loudness.minLufs, loudness.unit)
  }
  return `${formatNumber(loudness.minLufs, 'level', 'unicode')} to ${formatLoudness(loudness.maxLufs, loudness.unit)}`
}

/** The highest true peak cell: "−1.6 dBTP". */
export function peakCell(outcome: RecipeOutcome): string
{
  const peak = outcome.loudness?.maxTruePeakDbtp ?? null
  return peak === null ? NOT_MEASURED : formatTruePeak(peak)
}

/** The note after the limiting count: "at most 1.8 dB". */
export function limitingNote(outcome: RecipeOutcome): string | null
{
  const most = outcome.loudness?.maxLimitingDb ?? null
  if (most === null || (outcome.loudness?.limitedJobs ?? 0) === 0)
  {
    return null
  }
  return `at most ${formatNumber(Math.abs(most), 'amount', 'unicode')} dB`
}

const COUNT_BUTTON = '-my-1 tabular-nums'

interface CountProps
{
  text: string
  filter: JobFilter
  onFilter: (filter: JobFilter) => void
}

function Count({ text, filter, onFilter }: CountProps): ReactElement
{
  return (
    <Button variant="ghost" size="sm" className={COUNT_BUTTON} onClick={() => onFilter(filter)}>
      {text}
    </Button>
  )
}

/** Props for {@link OutcomeByRecipeTable}. */
export interface OutcomeByRecipeTableProps
{
  summary: BatchSummary
  jobs: readonly JobView[]
  onFilter: (filter: JobFilter) => void
  className?: string
}

/** One labeled value of an operation's results; a value nothing measured is left out. */
function Fact({ term, children }: { term: string; children: ReactNode }): ReactElement
{
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 tabular-nums text-ink">{children}</dd>
    </>
  )
}

/**
 * The finished batch per operation, one block each so it reads in the inspector's width: the jobs, the check its
 * jobs were held to, how many verified within it, the integrated range, the highest true peak, and how many jobs
 * were peak limited. Values nothing measured are left out; every count filters the table to its jobs.
 */
export function OutcomeByRecipeTable({ summary, jobs, onFilter, className }: OutcomeByRecipeTableProps): ReactElement
{
  const captionId = useId()
  const rows = outcomeRows(summary, jobs)
  const [, jobsTerm, checkTerm, withinTerm, rangeTerm, peakTerm, limitedTerm] = OUTCOME_COLUMNS
  return (
    <section aria-labelledby={captionId} className={cx('flex flex-col gap-2 select-text', className)}>
      <h3 id={captionId} className="type-legend text-brass">{OUTCOME_CAPTION}</h3>
      <ul aria-labelledby={captionId} className="flex flex-col">
        {rows.map((row) =>
        {
          const { outcome } = row
          const note = limitingNote(outcome)
          const range = rangeCell(outcome)
          const peak = peakCell(outcome)
          return (
            <li key={outcome.label} data-recipe={outcome.label} className="flex flex-col gap-1.5 border-t border-line py-3 first:border-t-0 first:pt-1">
              <p className="min-w-0 text-body text-ink">{outcome.label}</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 text-label">
                <Fact term={jobsTerm}>
                  <Count text={formatCount(outcome.jobs)} filter={row.jobs} onFilter={onFilter} />
                </Fact>
                <Fact term={checkTerm}>{checkCell(outcome)}</Fact>
                {row.within !== null && (
                  <Fact term={withinTerm}>
                    {row.within.count === 0
                      ? `0 of ${formatCount(outcome.jobs)}`
                      : <Count text={`${formatCount(row.within.count)} of ${formatCount(outcome.jobs)}`} filter={row.within.filter} onFilter={onFilter} />}
                  </Fact>
                )}
                {range !== NOT_MEASURED && <Fact term={rangeTerm}>{range}</Fact>}
                {peak !== NOT_MEASURED && <Fact term={peakTerm}>{peak}</Fact>}
                {row.limited !== null && (
                  <Fact term={limitedTerm}>
                    {row.limited.count === 0
                      ? NO_LIMITING
                      : (
                        <span className="inline-flex items-baseline gap-1.5">
                          <Count text={formatCount(row.limited.count)} filter={row.limited.filter} onFilter={onFilter} />
                          {note !== null && <span className="text-ink-2">{note}</span>}
                        </span>
                      )}
                  </Fact>
                )}
              </dl>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
