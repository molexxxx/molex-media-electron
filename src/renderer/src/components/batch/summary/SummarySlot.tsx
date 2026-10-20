import { useImperativeHandle, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import type { StoreApi } from 'zustand'
import { useStore } from 'zustand'
import type { BatchSummary } from '../../../../../shared/jobs/types'
import { PART_SEPARATOR, formatCount } from '../../../copy/batch'
import { useBatchView, type BatchViewState } from '../../../stores/batchView'
import { Button } from '../../../ui/Button'
import { confirmFirstText, needsAcknowledgment } from './AcknowledgmentCheck'
import { FinishedSummary, outcomeCounts, type FinishedSummaryProps } from './FinishedSummary'
import { ReviewSummary, reviewAcknowledgmentFacts, type ReviewSummaryProps } from './ReviewSummary'
import { RunNotices, type RunNoticesProps } from './RunNotices'

/** The slot's cap on the parts that can grow: issue groups in Review, recipe lines and reason groups after a run. */
export const SUMMARY_LINE_CAP = 6

/** Review shows this many issue groups before "Show {n} more issues". */
export const REVIEW_GROUP_LIMIT = 3

/** What the slot says, by situation. */
export type SummarySituation =
  | { kind: 'review', props: Omit<ReviewSummaryProps, 'acknowledgment' | 'collapsed' | 'headingRef' | 'groupLimit'> }
  | { kind: 'run', props: RunNoticesProps }
  | { kind: 'finished', props: Omit<FinishedSummaryProps, 'limit'> }
  | { kind: 'none' }

/** What the keyboard map asks of the slot. */
export interface SummarySlotHandle
{
  /**
   * Ctrl+Enter refused because the acknowledgment holds Start: expands a hidden slot, focuses the checkbox, and
   * returns what to announce ("Confirm that 20 originals go to the Recycle Bin on D: first."). Null when the
   * acknowledgment does not hold the brass action.
   */
  focusAcknowledgment: () => string | null
}

/** Props for {@link SummarySlot}. */
export interface SummarySlotProps
{
  situation: SummarySituation
  /** Notices that stay until resolved (FFmpeg not ready, an interrupted or restored batch, a scan), shown first. */
  notices?: ReactNode
  /** The view store whose Review session holds the report id, the counts, and the acknowledgment. */
  store?: StoreApi<BatchViewState>
  ref?: Ref<SummarySlotHandle>
}

/** A finished batch's outcome counts on one line, for the hidden slot: "19 verified · 2 returned · 1 canceled". */
export function finishedCountLine(counts: BatchSummary['counts']): string
{
  return outcomeCounts(counts).map((count) => `${formatCount(count.value)} ${count.word}`).join(PART_SEPARATOR)
}

function isEmpty(node: ReactNode): boolean
{
  return node === null || node === undefined || node === false || (Array.isArray(node) && node.every(isEmpty))
}

/**
 * The summary slot under the run header. It says the Review summary in Review, the run notices during a run, and
 * the finished summary after one, after any notice that must stay until resolved, and collapses to nothing when it
 * has nothing to say. "Hide summary" keeps the count line and, in Review, the acknowledgment whenever the report
 * calls for it, so the checkbox that gates Start is never hidden. The acknowledgment reads the view store's Review
 * session, whose counts are the ones Start sends.
 */
export function SummarySlot({ situation, notices = null, store = useBatchView, ref }: SummarySlotProps): ReactElement | null
{
  const review = useStore(store, (state) => state.review)
  const [hidden, setHidden] = useState(false)
  const ackRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useImperativeHandle(ref, () => ({
    focusAcknowledgment: (): string | null =>
    {
      if (situation.kind !== 'review')
      {
        return null
      }
      const { report, policy, platform } = situation.props
      const facts = reviewAcknowledgmentFacts(report, review.counts, policy.displaced === 'keep', platform)
      if (!needsAcknowledgment(facts) || review.acknowledged)
      {
        return null
      }
      setHidden(false)
      ackRef.current?.focus()
      return confirmFirstText(facts)
    }
  }), [situation, review])

  if (situation.kind === 'none' && isEmpty(notices))
  {
    return null
  }

  const collapsible = situation.kind === 'review' || situation.kind === 'finished'

  return (
    <div data-summary-slot={situation.kind} data-hidden={hidden ? 'true' : undefined} className="flex flex-col gap-3">
      {notices}
      {collapsible
        ? (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {situation.kind === 'review'
                ? (
                  <ReviewSummary
                    {...situation.props}
                    collapsed={hidden}
                    groupLimit={Math.min(REVIEW_GROUP_LIMIT, SUMMARY_LINE_CAP)}
                    headingRef={headingRef}
                    acknowledgment={{
                      checked: review.acknowledged,
                      notice: review.notice,
                      counts: review.counts,
                      onChange: (checked) => store.getState().setAcknowledged(checked),
                      ref: ackRef
                    }}
                  />
                )
                : hidden
                  ? <p data-line="finished-counts" className="text-body text-ink tabular-nums">{finishedCountLine(situation.props.summary.counts)}</p>
                  : <FinishedSummary {...situation.props} limit={SUMMARY_LINE_CAP} />}
            </div>
            <Button size="sm" variant="ghost" aria-expanded={!hidden} onClick={() => setHidden(!hidden)}>
              {hidden ? 'Show summary' : 'Hide summary'}
            </Button>
          </div>
        )
        : null}
      {situation.kind === 'run' ? <RunNotices {...situation.props} /> : null}
    </div>
  )
}
