import type { ReactElement } from 'react'
import type { RunId } from '../../../../../shared/jobs/ids'
import type { RunAlert, ScanState } from '../../../../../shared/jobs/types'
import { batchLabel, countOf, reviewNewLabel, verbFor } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import
{
  NoticeBanner,
  RunBanners,
  reloadWords,
  scanStoppedWords,
  type AlertContext,
  type BannerAction,
  type RestoredAcknowledgment
} from './Banners'

/** "3 new jobs are not in Batch 31." */
export function appendedLine(count: number, runId: RunId): string
{
  return `${countOf(count, 'new job')} ${verbFor(count, 'is', 'are')} not in ${batchLabel(runId)}.`
}

/** Props for {@link AppendedJobsLine}. */
export interface AppendedJobsLineProps
{
  count: number
  runId: RunId
  onReview: () => void
  /** Draws "Review {n} new jobs" in brass; pass false when another control already holds the brass. */
  brass?: boolean
}

/** The line that says jobs added during a run wait outside it, with the control that opens Review on them. */
export function AppendedJobsLine({ count, runId, onReview, brass = true }: AppendedJobsLineProps): ReactElement
{
  return (
    <div data-notice="appended" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="text-body text-ink">{appendedLine(count, runId)}</p>
      <Button size="sm" variant={brass ? 'primary' : 'secondary'} onClick={onReview}>{reviewNewLabel(count)}</Button>
    </div>
  )
}

/** Props for {@link RunNotices}. */
export interface RunNoticesProps
{
  runId: RunId | null
  /** Jobs added during the run that wait outside it. */
  appended?: number
  onReviewAppended?: () => void
  /** Whether the appended line's control is the page's brass action. */
  appendedBrass?: boolean
  alerts?: readonly RunAlert[]
  context?: Omit<AlertContext, 'runId'>
  /** When the window took main's snapshot; only a blocking alert raised after it is read out as an alert. */
  loadedAt?: number
  /** A banner control; the alert is null for the reload and scan notices. */
  onAction: (action: BannerAction, alert: RunAlert | null) => void
  onDismissAlert?: (alert: RunAlert) => void
  /** Under Replace, the restored batch's acknowledgment, carried by the restored-run banner. */
  acknowledgment?: RestoredAcknowledgment | null
  /** Jobs of the batch that need attention when the window reloaded; the notice shows only when it is above zero. */
  reloadAttention?: number | null
  onDismissReload?: () => void
  /** Folder scans; a failed one raises the scan-stopped notice. */
  scans?: readonly ScanState[]
  onDismissScan?: (scan: ScanState) => void
}

/**
 * The summary slot's notices while a batch runs and while its alerts stand: the jobs appended outside the batch,
 * every run alert as a held banner (run-blocking ones first), the one notice after a window reload, and stopped
 * folder scans. It renders nothing when none of them has anything to say.
 */
export function RunNotices({
  runId,
  appended = 0,
  onReviewAppended,
  appendedBrass = true,
  alerts = [],
  context = {},
  loadedAt,
  onAction,
  onDismissAlert,
  acknowledgment = null,
  reloadAttention = null,
  onDismissReload,
  scans = [],
  onDismissScan
}: RunNoticesProps): ReactElement | null
{
  const showAppended = runId !== null && appended > 0
  const showReload = runId !== null && reloadAttention !== null && reloadAttention > 0
  const stopped = scans.filter((scan) => scan.status === 'failed')
  if (!showAppended && alerts.length === 0 && !showReload && stopped.length === 0)
  {
    return null
  }
  return (
    <div data-slot-part="run-notices" className="flex flex-col gap-2">
      {showAppended && runId !== null
        ? <AppendedJobsLine count={appended} runId={runId} brass={appendedBrass} onReview={() => onReviewAppended?.()} />
        : null}
      <RunBanners
        alerts={alerts}
        context={{ ...context, runId }}
        loadedAt={loadedAt}
        onAction={onAction}
        onDismiss={onDismissAlert}
        acknowledgment={acknowledgment}
      />
      {showReload && runId !== null && reloadAttention !== null
        ? (
          <NoticeBanner
            key={`reload-${runId}`}
            words={reloadWords(reloadAttention, runId)}
            onAction={(action) => onAction(action, null)}
            onDismiss={onDismissReload}
          />
        )
        : null}
      {stopped.map((scan) => (
        <NoticeBanner
          key={`scan-${scan.scanId}`}
          words={scanStoppedWords(scan)}
          onAction={(action) => onAction(action, null)}
          onDismiss={onDismissScan ? () => onDismissScan(scan) : undefined}
        />
      ))}
    </div>
  )
}
