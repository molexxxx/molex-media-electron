/**
 * The History inspector: one kept batch at a glance (its number at display size, date and duration, counts, sizes,
 * the output it used, the FFmpeg build and molexMedia version it ran on, per-recipe outcomes) and its actions.
 */
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useStore, type StoreApi } from 'zustand'
import type { RunId } from '../../../../../shared/jobs/ids'
import type { BatchPolicy, BatchSummary, Destination, RecipeOutcome } from '../../../../../shared/jobs/types'
import { binPhrase, type Platform } from '../../../../../shared/text/platform'
import { formatCount, formatLoudness, PART_SEPARATOR } from '../../../copy/batch'
import { useAppStore } from '../../../stores/appStore'
import { activeViewKey, useBatchView, type BatchViewState } from '../../../stores/batchView'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import { usePlatform } from '../../../ui/Kbd'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { useBatchActions } from '../BatchActionsContext'
import
{
  batchName,
  deleteFromHistory,
  deleteQuestion,
  FIRST_ROW_REQUEST,
  formatBytes,
  formatElapsed,
  formatWhen,
  historyList,
  runIdOfMatchRow,
  type HistoryListState
} from './HistoryTable'

/** Where the FFmpeg build came from, in the words of the inspector. */
export function ffmpegSourceLabel(source: BatchSummary['ffmpeg']['source']): string
{
  switch (source)
  {
    case 'bundled':
      return 'pinned'
    case 'path':
      return 'PATH'
    default:
      return 'custom'
  }
}

/** "FFmpeg 9.0.2, pinned" for the build a batch ran on. */
export function ffmpegLine(ffmpeg: BatchSummary['ffmpeg']): string
{
  const version = ffmpeg.version.trim() === '' ? 'unknown version' : ffmpeg.version.trim()
  return `FFmpeg ${version}, ${ffmpegSourceLabel(ffmpeg.source)}`
}

/** "molexMedia 4.8.0" for the app version a batch ran on. */
export function appVersionLine(version: string): string
{
  return version.trim() === '' ? 'molexMedia, unknown version' : `molexMedia ${version.trim()}`
}

/** Where a batch wrote its outputs: the folder, "Next to each source", or "Replaced originals". */
export function destinationText(destination: Destination): string
{
  switch (destination.mode)
  {
    case 'folder':
      return destination.folder
    case 'next-to-source':
      return 'Next to each source'
    default:
      return 'Replaced originals'
  }
}

/** What a batch did when an output's name was taken. */
export function conflictText(policy: Pick<BatchPolicy, 'conflict' | 'displaced'>, platform: Platform): string
{
  switch (policy.conflict)
  {
    case 'skip':
      return 'Skipped the job'
    case 'overwrite':
      return policy.displaced === 'keep'
        ? 'Replaced the file; the old one stayed as name (previous).ext'
        : `Replaced the file; the old one went to ${binPhrase(platform)}`
    default:
      return 'Renamed the output'
  }
}

function plural(n: number, one: string, many: string): string
{
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

/** What happened to the originals: "Not touched", or how many went to the bin on which volumes and how many stayed. */
export function originalsText(summary: Pick<BatchSummary, 'policy' | 'originals'>, platform: Platform): string
{
  if (summary.policy.destination.mode !== 'replace-originals')
  {
    return 'Not touched'
  }
  const { trashed, kept, volumes } = summary.originals
  const parts: string[] = []
  if (trashed > 0)
  {
    const named = volumes.filter((volume) => volume.trashed > 0)
    const where = named.length === 1 ? binPhrase(platform, named[0].volume) : binPhrase(platform)
    parts.push(`${plural(trashed, 'original', 'originals')} went to ${where}`)
  }
  if (kept > 0)
  {
    parts.push(`${plural(kept, 'original stayed', 'originals stayed')} as name (original).ext`)
  }
  return parts.length === 0 ? 'None were replaced' : parts.join('; ')
}

/** What happened to files the outputs displaced; null when no output displaced one. */
export function previousText(summary: Pick<BatchSummary, 'previous'>, platform: Platform): string | null
{
  const { trashed, kept } = summary.previous
  const parts: string[] = []
  if (trashed > 0)
  {
    parts.push(`${plural(trashed, 'earlier file', 'earlier files')} went to ${binPhrase(platform)}`)
  }
  if (kept > 0)
  {
    parts.push(`${plural(kept, 'earlier file stayed', 'earlier files stayed')} as name (previous).ext`)
  }
  return parts.length === 0 ? null : parts.join('; ')
}

/** One recipe's outcome: "12 jobs · 10 verified · 2 returned · -18.2 to -15.9 LUFS". */
export function recipeOutcomeText(outcome: RecipeOutcome): string
{
  const parts = [plural(outcome.jobs, 'job', 'jobs'), `${formatCount(outcome.verified)} verified`]
  if (outcome.reachable > 0)
  {
    parts.push(`${formatCount(outcome.reachable)} at the reachable level`)
  }
  parts.push(`${formatCount(outcome.returned)} returned`)
  const loudness = outcome.loudness
  if (loudness !== null && loudness.minLufs !== null && loudness.maxLufs !== null)
  {
    parts.push(loudness.minLufs === loudness.maxLufs
      ? formatLoudness(loudness.minLufs, loudness.unit)
      : `${formatLoudness(loudness.minLufs, loudness.unit).replace(/ \S+$/, '')} to ${formatLoudness(loudness.maxLufs, loudness.unit)}`)
  }
  return parts.join(PART_SEPARATOR)
}

/** The batch the inspector shows: the opened batch, the focused batch row, or the batch of the focused search result. */
export function inspectedRunId(state: Pick<BatchViewState, 'mode' | 'history' | 'views'>): string | null
{
  switch (activeViewKey(state))
  {
    case 'historyBatch':
      return state.history.openRunId
    case 'historyResults':
    {
      const focus = state.views.historyResults.selection.focus
      return focus === null ? null : runIdOfMatchRow(focus)
    }
    case 'history':
      return state.views.history.selection.focus
    default:
      return null
  }
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, string]> }): ReactElement
{
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="type-caption text-ink-3">{term}</dt>
          <dd className="min-w-0 break-words text-label tabular-nums text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Section({ title, children }: { title: string, children: ReactNode }): ReactElement
{
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 id={id} className="type-caption text-ink-2">{title}</h3>
      {children}
    </section>
  )
}

/** Props for {@link HistoryInspector}. */
export interface HistoryInspectorProps
{
  /** The batch view store; the page's own by default. */
  view?: StoreApi<BatchViewState>
  /** The batch list the table shares; the page's own by default. */
  list?: StoreApi<HistoryListState>
  /** Show log: the Logs section filtered to the batch; opens Logs when omitted. */
  onShowLog?: (runId: string) => void
  className?: string
}

/**
 * The inspector for History: the batch the table shows or focuses, what it used and how it ended, and its actions.
 * Rerun results and refusals come back as the batch actions' toasts, including "Add anyway" for a path that now
 * holds the job's own output.
 */
export function HistoryInspector({ view = useBatchView, list = historyList, onShowLog, className }: HistoryInspectorProps): ReactElement
{
  const actions = useBatchActions()
  const platform = usePlatform()
  const runId = useStore(view, inspectedRunId)
  const opened = useStore(view, (state) => state.history.openRunId)
  const entry = useStore(list, (state) => (runId === null ? null : state.runs.find((run) => run.runId === runId) ?? null))
  const [loaded, setLoaded] = useState<{ runId: string, summary: BatchSummary | null, message: string | null } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'returned' | 'all' | null>(null)
  const confirmed = useRef(false)
  const deleteButton = useRef<HTMLButtonElement>(null)

  useEffect(() =>
  {
    setConfirming(false)
    if (runId === null)
    {
      return
    }
    let live = true
    void actions.send('getRun', { runId: runId as RunId, offset: 0, limit: 1 }).then((outcome) =>
    {
      if (live)
      {
        setLoaded(outcome.status === 'done'
          ? { runId, summary: outcome.value.summary, message: null }
          : { runId, summary: null, message: outcome.message })
      }
    })
    return () =>
    {
      live = false
    }
  }, [actions, runId])

  if (runId === null)
  {
    return (
      <section aria-label="Batch details" className={cx('flex flex-col gap-2 p-4 text-ink-2', className)}>
        <p>Select a batch to see what it used and how it ended.</p>
      </section>
    )
  }

  const current = loaded !== null && loaded.runId === runId ? loaded : null
  const summary = current?.summary ?? null
  const startedAt = summary?.startedAt ?? entry?.startedAt ?? null
  const elapsed = summary?.elapsedMs ?? (entry === null || entry.endedAt === null ? null : entry.endedAt - entry.startedAt)
  const counts = summary?.counts ?? entry?.counts ?? null
  const bytes = summary?.bytes ?? entry?.bytes ?? null
  const when = [formatWhen(startedAt), formatElapsed(elapsed)].filter((part) => part !== '').join(PART_SEPARATOR)
  const returned = counts?.returned ?? 0

  const rerun = (jobIds: 'returned' | 'all'): void =>
  {
    setBusy(jobIds)
    void actions.rerun(runId as RunId, jobIds).finally(() => setBusy(null))
  }

  const openJobs = (): void =>
  {
    view.getState().openHistoryBatch(runId)
    list.setState({ focusRequest: FIRST_ROW_REQUEST })
  }

  const showLog = (): void =>
  {
    if (onShowLog !== undefined)
    {
      onShowLog(runId)
      return
    }
    useAppStore.getState().setView('logs')
  }

  const resolve = (yes: boolean): void =>
  {
    confirmed.current = yes
    setConfirming(false)
    if (yes)
    {
      void deleteFromHistory(runId, { actions, list, view })
    }
  }

  const exportItems: MenuEntry[] =
  [
    { id: 'csv', label: 'CSV', description: 'One row per job, for a spreadsheet', onSelect: () => void actions.exportReport({ runId: runId as RunId }, 'csv') },
    { id: 'json', label: 'JSON', description: 'Every recorded field', onSelect: () => void actions.exportReport({ runId: runId as RunId }, 'json') }
  ]

  return (
    <section aria-label={`${batchName(runId)} details`} className={cx('flex min-w-0 flex-col gap-4 p-4', className)}>
      <header className="flex flex-col gap-1">
        <h2 className="type-display text-ink">{batchName(runId)}</h2>
        {when !== '' && <p className="text-label tabular-nums text-ink-2">{when}</p>}
      </header>

      {counts !== null && (
        <Facts
          rows={[
            ['Jobs', formatCount(counts.total)],
            ['Verified', formatCount(counts.verified)],
            ['Returned', formatCount(counts.returned)],
            ['Canceled', formatCount(counts.canceled)],
            ['Skipped', formatCount(counts.skipped)],
            ...(bytes === null ? [] : [['In', formatBytes(bytes.input)], ['Out', formatBytes(bytes.output)]] as Array<[string, string]>)
          ]}
        />
      )}

      {current === null && <p role="status" className="text-label text-ink-3">Reading the batch summary{'…'}</p>}
      {current !== null && current.message !== null && <p role="status" className="text-label text-error">{current.message}</p>}
      {current !== null && current.message === null && summary === null && (
        <p className="text-label text-ink-2">This batch did not finish, so it has no summary of what it used.</p>
      )}

      {summary !== null && (
        <>
          <Section title="Output used">
            <Facts
              rows={[
                ['Destination', destinationText(summary.policy.destination)],
                ['Names', summary.policy.template],
                ['Name taken', conflictText(summary.policy, platform)],
                ['Originals', originalsText(summary, platform)],
                ...(previousText(summary, platform) === null ? [] : [['Earlier files', previousText(summary, platform) ?? '']] as Array<[string, string]>)
              ]}
            />
          </Section>
          <Section title="Ran on">
            <Facts rows={[['FFmpeg', ffmpegLine(summary.ffmpeg).replace(/^FFmpeg /, '')], ['App', appVersionLine(summary.appVersion)]]} />
          </Section>
          {summary.recipes.length > 0 && (
            <Section title="Operations">
              <ul className="flex flex-col gap-1.5">
                {summary.recipes.map((outcome, index) => (
                  <li key={`${outcome.label}-${index}`} className="flex min-w-0 flex-col">
                    <span className="truncate text-ink">{outcome.label}</span>
                    <span className="text-label tabular-nums text-ink-2">{recipeOutcomeText(outcome)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}

      <div role="group" aria-label={`Actions for ${batchName(runId)}`} className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          variant="secondary"
          aria-keyshortcuts="Enter"
          disabled={opened === runId}
          unavailableReason={opened === runId ? 'These jobs are open.' : undefined}
          onClick={openJobs}
        >
          Open jobs
        </Button>
        <Menu label="Export report" items={exportItems} trigger={<Button size="sm" variant="secondary">Export report</Button>} />
        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'returned'}
          disabled={returned === 0}
          unavailableReason={returned === 0 ? 'No jobs were returned.' : undefined}
          onClick={() => rerun('returned')}
        >
          Rerun returned
        </Button>
        <Button size="sm" variant="secondary" loading={busy === 'all'} onClick={() => rerun('all')}>Rerun all</Button>
        <Button size="sm" variant="ghost" onClick={showLog}>Show log</Button>
        <Button
          ref={deleteButton}
          size="sm"
          variant="danger"
          aria-keyshortcuts="Delete"
          onClick={() =>
          {
            confirmed.current = false
            setConfirming(true)
          }}
        >
          Delete from history
        </Button>
      </div>

      {confirming && (
        <InlineConfirm
          question={deleteQuestion(runId)}
          safeLabel="Keep"
          confirmLabel="Delete"
          danger
          opener={null}
          fallbackFocus={() => (confirmed.current ? null : deleteButton.current)}
          onResolve={resolve}
        />
      )}
    </section>
  )
}
