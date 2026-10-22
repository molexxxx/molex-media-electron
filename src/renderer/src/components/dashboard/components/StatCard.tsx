/**
 * @module components/dashboard/DisplayWindow
 * @description The Dashboard's display window: the queue's four readouts, the Batch header's state sentence and
 * run meter for this moment, the way into Batch, and a footer strip the page fills with the machine's readiness.
 */
import React from 'react'
import type { RunId } from '../../../../../shared/jobs/ids'
import { batchLabel, needAttention, PART_SEPARATOR } from '../../../copy/batch'
import { useAppStore } from '../../../stores/appStore'
import { consequenceLine, headerSubject, selectHeaderFacts, stateSentence, type AttentionButton, type ConsequenceLine as ConsequenceModel, type HeaderSubject, type HeaderView } from '../../../stores/batchHeader'
import { modeRows, useBatchView } from '../../../stores/batchView'
import { selectGroupCounts, selectLatestRunId, selectRunJobs } from '../../../stores/jobsSelectors'
import { useJobsStore, type JobsState } from '../../../stores/jobs'
import { Button, cx, usePlatform } from '../../../ui'
import { attentionFilters } from '../../batch/header/RunHeader'
import { ConsequenceLine } from '../../batch/header/ConsequenceLine'
import { StateSentence } from '../../batch/header/StateSentence'

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

/** The window's accessible name. */
export const WINDOW_LABEL = 'Queue'

/** The button that leaves for Batch. */
export const OPEN_BATCH_LABEL = 'Open Batch'

/** The consequence lines the window shows: the run's meter and what a finished batch did; never the output policy. */
export function windowConsequence(line: ConsequenceModel | null): ConsequenceModel | null
{
  return line !== null && line.kind !== 'policy' ? line : null
}

/** The legend printed before the sentence: the batch it describes, nothing while the queue is only waiting. */
export function windowLegend(subject: HeaderSubject, runId: RunId | null): string | null
{
  return (subject === 'run' || subject === 'finished') && runId !== null ? batchLabel(runId) : null
}

/**
 * Opens Batch in Run mode filtered to the batch's jobs that need attention, as the Batch header's own button does.
 * The page selects nothing; the user picks the row.
 */
export function showAttentionInBatch(attention: AttentionButton, showBatch: () => void): void
{
  const view = useBatchView.getState()
  view.markRunAvailable()
  view.setMode('run')
  view.setFilters('run', { chips: attentionFilters(attention.runId), search: '' }, modeRows('run', useJobsStore.getState()))
  showBatch()
}

/** Props for {@link DisplayWindow}. */
export interface DisplayWindowProps
{
  /** The strip under the hairline at the window's foot: FFmpeg, GPU, CPU, memory, and platform. */
  footer?: React.ReactNode
}

const COUNT = new Intl.NumberFormat('en-US')

function Readout({ label, value, lit = false, tone }: { label: string; value: number; lit?: boolean; tone?: 'warning' }): React.JSX.Element
{
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="type-legend text-accent-ink">{label}</dt>
      <dd
        data-stat={label}
        className={cx(
          'font-display text-[2rem] leading-9 font-semibold tabular-nums',
          lit ? 'type-readout' : tone === 'warning' ? 'text-warning' : value === 0 ? 'text-ink-3' : 'text-ink'
        )}
      >
        {COUNT.format(value)}
      </dd>
    </div>
  )
}

/** Waiting, Active, Done, and Need attention, read from the jobs store. */
function Readouts(): React.JSX.Element
{
  const waiting = useJobsStore(selectWaitingCount)
  const active = useJobsStore(selectActiveCount)
  const done = useJobsStore(selectBatchDoneCount)
  const attention = useJobsStore(selectBatchAttentionCount)
  return (
    <dl aria-label="Counts" className="flex shrink-0 flex-wrap items-start gap-x-8 gap-y-3">
      <Readout label="Waiting" value={waiting} />
      <Readout label="Active" value={active} lit={active > 0} />
      <Readout label="Done" value={done} />
      <Readout label="Need attention" value={attention} tone={attention > 0 ? 'warning' : undefined} />
    </dl>
  )
}

const selectAlerts = (state: JobsState): JobsState['alerts'] => state.alerts
const selectPolicy = (state: JobsState): JobsState['policy'] => state.policy
const selectRun = (state: JobsState): JobsState['run'] => state.run
const selectCompleted = (state: JobsState): JobsState['completed'] => state.completed

/**
 * The display window: the readouts bank, then the sentence the Batch header would show at this moment with its
 * attention button, the run meter while a batch runs, and the outcome after one. Zero counts recede, Active lights,
 * and a count that needs attention takes the warning ink; the sentence sheds its parts to fit the width it has.
 */
export function DisplayWindow({ footer }: DisplayWindowProps = {}): React.JSX.Element
{
  const platform = usePlatform()
  const setView = useAppStore((s) => s.setView)
  const facts = useJobsStore(selectHeaderFacts)
  const run = useJobsStore(selectRun)
  const alerts = useJobsStore(selectAlerts)
  const policy = useJobsStore(selectPolicy)
  const completed = useJobsStore(selectCompleted)
  const descriptionId = `${React.useId()}-sentence`

  const view = React.useMemo<HeaderView>(() => ({ mode: 'queue', platform, summary: completed }), [platform, completed])
  const subject = headerSubject(facts, view)
  const sentence = React.useMemo(() => stateSentence(facts, view, run, alerts, policy), [facts, view, run, alerts, policy])
  const consequence = windowConsequence(consequenceLine(facts, view, run, policy))
  const legend = windowLegend(subject, facts.batch?.runId ?? null)
  const attention: AttentionButton | null = facts.batch !== null && facts.batch.attention > 0
    ? {
      runId: facts.batch.runId,
      count: facts.batch.attention,
      label: needAttention(facts.batch.attention),
      tooltip: `Show the jobs of ${batchLabel(facts.batch.runId)} that need attention`
    }
    : null
  const showBatch = (): void => setView('batch')

  return (
    <section
      aria-label={WINDOW_LABEL}
      aria-describedby={descriptionId}
      data-subject={subject}
      className="flex min-w-0 flex-col gap-4 rounded-sm bg-sunken px-5 py-4 shadow-well"
    >
      <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:gap-8">
      <Readouts />
      <div className="flex min-w-0 flex-1 items-center gap-4 border-t border-line pt-4 xl:border-t-0 xl:border-s xl:ps-8 xl:pt-0">
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <div className="flex h-6 min-w-0 items-center gap-3">
            {legend !== null && (
              <span data-part="legend" className="shrink-0 whitespace-nowrap type-legend text-accent-ink">
                {legend}
                <span className="sr-only">{PART_SEPARATOR}</span>
              </span>
            )}
            <StateSentence
              sentence={sentence}
              attention={attention}
              onShowAttention={(button) => showAttentionInBatch(button, showBatch)}
              descriptionId={descriptionId}
            />
          </div>
          {consequence !== null && (
            <div className="flex h-5 min-w-0 items-center">
              <ConsequenceLine line={consequence} batchName={legend ?? 'Batch'} />
            </div>
          )}
        </div>
        <Button variant="ghost" iconEnd="action.next" className="shrink-0" onClick={showBatch}>{OPEN_BATCH_LABEL}</Button>
      </div>
      </div>
      {footer !== undefined && <div data-part="footer" className="border-t border-line pt-3">{footer}</div>}
    </section>
  )
}
