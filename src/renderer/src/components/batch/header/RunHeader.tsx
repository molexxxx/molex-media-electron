import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode, type RefObject } from 'react'
import type { RunId } from '../../../../../shared/jobs/ids'
import { ACTION_LABELS, batchLabel, countOf, formatDuration, REGION_NAMES, verbFor, type ActionKind } from '../../../copy/batch'
import type { BatchFilter } from '../../../stores/batchFilters'
import type { AttentionButton, BatchFacts, HeaderAction, HeaderModel } from '../../../stores/batchHeader'
import { Button } from '../../../ui/Button'
import { InlineConfirm } from '../../../ui/InlineConfirm'
import type { MenuEntry } from '../../../ui/Menu'
import { Tooltip } from '../../../ui/Tooltip'
import { ActionSlot, PAUSE_NOW_LABEL, RunControlsSlot } from './ActionSlot'
import { AfterRunActions, BatchOverflowMenu, type AfterRunActionsProps, type ReportFormat } from './BatchOverflowMenu'
import { ConsequenceLine } from './ConsequenceLine'
import { StateSentence } from './StateSentence'

/** Work that "Pause now" may discard without asking first, in seconds. */
export const PAUSE_NOW_CONFIRM_AFTER_SEC = 30

/** View widths at which the run header changes, in px. */
export const HEADER_WIDTHS =
{
  /** From here up, Output and Workers show their values and the after-run actions sit in row 1. */
  full: 1000,
  /** Below this, Output and Workers move into the overflow menu and the sentence keeps counts and problems only. */
  controls: 700
} as const

/** How a pause treats running jobs: they finish, or they stop now and restart later. */
export type PauseMode = 'finish-running' | 'stop-running'

/** What the attention button asks the page to do: apply these filters to Run and focus the first job they show. */
export interface AttentionRequest
{
  runId: RunId
  count: number
  /** "Needs attention" and "In Batch {b}", so the rows shown are exactly the jobs the button counts. */
  filters: BatchFilter[]
}

/** What the header passes to the Output and Workers triggers the page renders. */
export interface HeaderControl
{
  /** The full label, or the bare word on a narrow view. */
  label: string
  tooltip: string
  /** Output is locked while the batch has queued or running jobs. */
  locked: boolean
}

/** The filters the attention button applies: "Needs attention" and "In Batch {b}". */
export function attentionFilters(runId: RunId): BatchFilter[]
{
  return [{ facet: 'status', value: 'attention' }, { facet: 'batch', value: runId }]
}

/** "Cancel Batch 31? 3 jobs in progress stop and their partial files are deleted. 12 queued jobs are canceled. ..." */
export function cancelRunQuestion(runId: RunId, active: number, queued: number): string
{
  const parts = [`Cancel ${batchLabel(runId)}?`]
  if (active > 0)
  {
    const files = active === 1 ? 'its partial file is deleted' : 'their partial files are deleted'
    parts.push(`${countOf(active, 'job')} in progress ${verbFor(active, 'stops', 'stop')} and ${files}.`)
  }
  if (queued > 0)
  {
    parts.push(`${countOf(queued, 'queued job')} ${verbFor(queued, 'is', 'are')} canceled.`)
  }
  parts.push('Finished jobs keep their outputs.')
  return parts.join(' ')
}

/** "Pause now? 3 running jobs restart from the beginning; 52 min of encoding is discarded." */
export function pauseNowQuestion(running: number, discardedSec: number): string
{
  return `Pause now? ${countOf(running, 'running job')} ${verbFor(running, 'restarts', 'restart')} from the beginning; ${formatDuration(discardedSec)} of encoding is discarded.`
}

/** Props for {@link RunHeader}. */
export interface RunHeaderProps
{
  /** The header of this moment, from `deriveHeader`. */
  header: HeaderModel
  /** The batch the header describes, from `selectHeaderFacts`; names Cancel run's question and the log item. */
  batch: Pick<BatchFacts, 'runId' | 'active' | 'queued'> | null
  /** The batch view's own width; measured from the header when left out. */
  viewWidth?: number
  /** The inspector's width, which checks its item in the overflow menu. */
  inspectorWidth?: number
  /** Pending jobs selected in Review, which "Start only the selected jobs" starts. */
  selectedCount?: number
  /** A typed refusal from main for the last Start or Append (stale plan, acknowledgment needed, FFmpeg not ready). */
  refusal?: string | null
  /** The folders a finished batch wrote to. */
  outputFolders?: readonly string[]
  /** Seconds of analyzing and encoding work "Pause now" would discard, read at the press. */
  discardedWork?: () => number
  /** Renders the Output popover's trigger; a plain button calling `onOutput` when left out. */
  renderOutput?: (control: HeaderControl) => ReactNode
  /** Renders the Workers popover's trigger; a plain button calling `onWorkers` when left out. */
  renderWorkers?: (control: HeaderControl) => ReactNode
  /** Performs the action slot's action: Review, Start, Append, Review new jobs, Resume, or Retry returned. */
  onAction: (action: HeaderAction) => void
  onStartSelected?: () => void
  onPause: (mode: PauseMode) => void
  onCancelRun: () => void
  onShowAttention: (request: AttentionRequest) => void
  onOpenFolder?: (folder: string) => void
  onExportReport?: (runId: RunId, format: ReportFormat) => void
  /** Opens Output from the overflow menu on a narrow view. */
  onOutput?: () => void
  /** Opens Workers from the overflow menu on a narrow view. */
  onWorkers?: () => void
  onShowLog?: (runId: RunId) => void
  onShowShortcuts?: () => void
  onInspectorWidth?: (width: number) => void
  /** Focuses the table's focused row: the last stop when a control removes itself and its slot empties. */
  focusTable?: () => void
  /** Items the page adds to the overflow menu at narrow widths, such as Clear. */
  overflowItems?: readonly MenuEntry[]
}

interface Confirmation
{
  kind: 'cancel' | 'pause-now'
  /** Pause now states the work it discards as measured at the press. */
  question: string | null
  opener: HTMLElement | null
}

interface FocusRecord
{
  element: HTMLElement
  slot: string
}

function isLost(element: HTMLElement): boolean
{
  return !element.isConnected || (element instanceof HTMLButtonElement && element.disabled) || element.closest('[hidden]') !== null
}

function firstUsable(candidates: ReadonlyArray<HTMLElement | null>): HTMLElement | null
{
  return candidates.find((element): element is HTMLElement => element !== null && !isLost(element)) ?? null
}

function useOwnWidth(viewWidth: number | undefined): [RefObject<HTMLElement | null>, number]
{
  const ref = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() =>
  {
    if (viewWidth === undefined && ref.current !== null)
    {
      setWidth(ref.current.clientWidth)
    }
  }, [viewWidth])

  useEffect(() =>
  {
    const element = ref.current
    if (viewWidth !== undefined || element === null || typeof ResizeObserver === 'undefined')
    {
      return
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [viewWidth])

  return [ref, viewWidth ?? (width > 0 ? width : Number.POSITIVE_INFINITY)]
}

/**
 * The run header: row 1 holds the title, the state sentence, Output, Workers, the after-run actions, the action
 * slot, the run controls, and the batch overflow menu, and never wraps; row 2 is the consequence line. The action
 * slot and the run controls each keep one stable focus target, and Cancel run and Pause now ask inline in place of
 * the action area, with focus on "Keep running".
 */
export function RunHeader({
  header,
  batch,
  viewWidth,
  inspectorWidth = 360,
  selectedCount = 0,
  refusal = null,
  outputFolders = [],
  discardedWork,
  renderOutput,
  renderWorkers,
  onAction,
  onStartSelected,
  onPause,
  onCancelRun,
  onShowAttention,
  onOpenFolder,
  onExportReport,
  onOutput,
  onWorkers,
  onShowLog,
  onShowShortcuts,
  onInspectorWidth,
  focusTable,
  overflowItems
}: RunHeaderProps): ReactElement
{
  const descriptionId = `${useId()}-sentence`
  const [rootRef, width] = useOwnWidth(viewWidth)
  const slotRef = useRef<HTMLButtonElement>(null)
  const pauseRef = useRef<HTMLButtonElement>(null)
  const pauseNowRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const overflowRef = useRef<HTMLButtonElement>(null)
  const focusRecord = useRef<FocusRecord | null>(null)
  const previousKind = useRef<ActionKind | null>(header.slot?.kind ?? null)
  const resolving = useRef(false)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)

  const controls = header.controls
  const stale = confirm !== null && (controls === null || (confirm.kind === 'pause-now' && controls.pauseNow === null))
  const open = stale ? null : confirm

  useLayoutEffect(() =>
  {
    if (stale)
    {
      setConfirm(null)
    }
  }, [stale])

  useLayoutEffect(() =>
  {
    const record = focusRecord.current
    const kindBefore = previousKind.current
    previousKind.current = header.slot?.kind ?? null
    if (record === null || !isLost(record.element))
    {
      return
    }
    focusRecord.current = null
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !isLost(active))
    {
      return
    }
    if (record.slot === 'confirm' && resolving.current)
    {
      resolving.current = false
      return
    }
    const runControls = [pauseRef.current, pauseNowRef.current, cancelRef.current]
    let first: Array<HTMLElement | null>
    switch (record.slot)
    {
      case 'action':
        first = kindBefore === 'resume' ? [slotRef.current, ...runControls] : [slotRef.current]
        break
      case 'output':
      case 'workers':
        first = [overflowRef.current]
        break
      default:
        first = [slotRef.current, ...runControls]
    }
    const target = firstUsable(first)
    if (target !== null)
    {
      target.focus()
      return
    }
    if (focusTable !== undefined)
    {
      focusTable()
      return
    }
    firstUsable([...runControls, overflowRef.current])?.focus()
  })

  const handleFocus = (event: FocusEvent<HTMLElement>): void =>
  {
    const slot = event.target.closest<HTMLElement>('[data-slot]')?.dataset.slot
    focusRecord.current = slot === undefined ? null : { element: event.target, slot }
  }

  const handleBlur = (event: FocusEvent<HTMLElement>): void =>
  {
    const element = event.target
    queueMicrotask(() =>
    {
      if (focusRecord.current?.element === element && document.activeElement !== element && !isLost(element))
      {
        focusRecord.current = null
      }
    })
  }

  const fallbackTarget = (): HTMLElement | null =>
  {
    const target = firstUsable([slotRef.current, pauseRef.current, pauseNowRef.current, cancelRef.current])
    if (target === null)
    {
      focusTable?.()
    }
    return target
  }

  const askCancel = (): void =>
  {
    setConfirm({ kind: 'cancel', question: null, opener: cancelRef.current })
  }

  const askPauseNow = (): void =>
  {
    const running = controls?.pauseNow?.running ?? 0
    const seconds = discardedWork?.() ?? 0
    if (seconds > PAUSE_NOW_CONFIRM_AFTER_SEC)
    {
      setConfirm({ kind: 'pause-now', question: pauseNowQuestion(running, seconds), opener: pauseRef.current ?? pauseNowRef.current })
      return
    }
    onPause('stop-running')
  }

  const resolve = (confirmed: boolean): void =>
  {
    const current = open
    resolving.current = true
    setConfirm(null)
    if (!confirmed || current === null)
    {
      return
    }
    if (current.kind === 'cancel')
    {
      onCancelRun()
      return
    }
    onPause('stop-running')
  }

  const showAttention = (attention: AttentionButton): void =>
  {
    onShowAttention({ runId: attention.runId, count: attention.count, filters: attentionFilters(attention.runId) })
  }

  const full = width >= HEADER_WIDTHS.full
  const roomy = width >= HEADER_WIDTHS.controls
  const outputControl: HeaderControl = { label: header.output.label, tooltip: header.output.tooltip, locked: header.output.locked }
  const workersControl: HeaderControl = { label: full ? header.workers.label : header.workers.shortLabel, tooltip: header.workers.tooltip, locked: false }
  const afterRun: AfterRunActionsProps | null = header.subject === 'finished' && batch !== null && onExportReport !== undefined
    ? {
      folders: outputFolders,
      onOpenFolder: (folder) => onOpenFolder?.(folder),
      onExportReport: (format) => onExportReport(batch.runId, format)
    }
    : null
  const question = open === null
    ? null
    : open.question ?? (batch === null ? '' : cancelRunQuestion(batch.runId, batch.active, batch.queued))

  return (
    <section
      ref={rootRef}
      aria-label={REGION_NAMES.header}
      aria-describedby={descriptionId}
      className="flex h-[4.5rem] shrink-0 items-center gap-3 border-b border-line bg-panel px-4"
      data-subject={header.subject}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <h1 className="sr-only">{header.title}</h1>
      <div
        data-part="display"
        className="flex h-13 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-sm bg-sunken px-4 shadow-well"
        hidden={open !== null}
      >
        <div className="flex h-6 min-w-0 items-center">
          <StateSentence
            sentence={header.sentence}
            attention={header.attention}
            onShowAttention={showAttention}
            minLevel={roomy ? 0 : 3}
            descriptionId={descriptionId}
          />
        </div>
        <div className="flex h-4 min-w-0 items-center">
          <ConsequenceLine line={header.consequence} batchName={batch === null ? header.title : batchLabel(batch.runId)} />
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-2" hidden={open !== null}>
        {roomy && (
          <span className="inline-flex shrink-0" data-slot="output">
            {renderOutput !== undefined
              ? renderOutput(outputControl)
              : (
                <Tooltip content={outputControl.tooltip}>
                  <Button iconEnd="action.openMenu" onClick={() => onOutput?.()}>{outputControl.label}</Button>
                </Tooltip>
              )}
          </span>
        )}
        {roomy && (
          <span className="inline-flex shrink-0" data-slot="workers">
            {renderWorkers !== undefined
              ? renderWorkers(workersControl)
              : (
                <Tooltip content={workersControl.tooltip}>
                  <Button iconEnd="action.openMenu" onClick={() => onWorkers?.()}>{workersControl.label}</Button>
                </Tooltip>
              )}
          </span>
        )}
        {full && afterRun !== null && <AfterRunActions {...afterRun} />}
        {header.slot !== null && (
          <ActionSlot
            ref={slotRef}
            action={header.slot}
            primary={header.primary === 'slot'}
            selectedCount={selectedCount}
            refusal={refusal}
            onAction={onAction}
            onStartSelected={onStartSelected}
          />
        )}
        {controls !== null && (
          <RunControlsSlot
            controls={controls}
            pauseRef={pauseRef}
            pauseNowRef={pauseNowRef}
            cancelRef={cancelRef}
            onPause={() => onPause('finish-running')}
            onPauseNow={askPauseNow}
            onCancelRun={askCancel}
          />
        )}
        <BatchOverflowMenu
          ref={overflowRef}
          runId={batch?.runId ?? null}
          inspectorWidth={inspectorWidth}
          narrowControls={roomy ? null : { onOutput: () => onOutput?.(), onWorkers: () => onWorkers?.() }}
          afterRun={full ? null : afterRun}
          extraItems={overflowItems}
          onShowLog={onShowLog}
          onShowShortcuts={onShowShortcuts}
          onInspectorWidth={onInspectorWidth}
        />
      </div>
      {open !== null && question !== null && (
        <div className="flex h-full min-w-0 flex-1 items-center" data-slot="confirm">
          <InlineConfirm
            question={question}
            safeLabel={ACTION_LABELS.keepRunning}
            confirmLabel={open.kind === 'cancel' ? ACTION_LABELS.cancelRun : PAUSE_NOW_LABEL}
            danger
            opener={open.opener}
            fallbackFocus={fallbackTarget}
            onResolve={resolve}
            wrap={false}
          />
        </div>
      )}
    </section>
  )
}
