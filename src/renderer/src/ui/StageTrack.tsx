import { useRef, type ReactElement } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { useInView } from './StatusLabel'
import { VisuallyHidden } from './VisuallyHidden'

/** Where a stage stands. */
export type StageState = 'done' | 'active' | 'pending' | 'failed' | 'skipped'

/** One stage the plan makes visible; stages an operation does not run are left out by the caller. */
export interface Stage
{
  /** The stage id, unique within the track. */
  key: string
  label: string
  state: StageState
  /** A finished stage's duration ("1 min 12 s"), the pass ("pass 1 of 2"), or "corrective". */
  detail?: string
}

/** Props for {@link StageTrack}. */
export interface StageTrackProps
{
  /** The plan's stages in run order: Probe, Measure, Encode, Verify, then Save. */
  stages: readonly Stage[]
  className?: string
}

interface StageLook
{
  icon: IconName
  iconClass: string
  labelClass: string
  detailClass: string
  /** The state as a word; `active` states itself through `aria-current` instead. */
  word?: string
  /** Failed and skipped show their word; done and pending keep it for assistive technology only. */
  wordVisible?: boolean
  wordClass?: string
}

const STAGE_LOOKS: Readonly<Record<StageState, StageLook>> = {
  done: { icon: 'status.done', iconClass: 'text-verified', labelClass: 'text-ink-2', detailClass: 'text-ink-2', word: 'done' },
  active: { icon: 'status.active', iconClass: 'text-running', labelClass: 'font-semibold text-ink', detailClass: 'text-ink-2' },
  pending: { icon: 'status.pending', iconClass: 'text-ink-3', labelClass: 'text-ink-3', detailClass: 'text-ink-3', word: 'pending' },
  failed: { icon: 'status.failed', iconClass: 'text-error', labelClass: 'text-ink', detailClass: 'text-ink-2', word: 'failed', wordVisible: true, wordClass: 'text-error' },
  skipped: { icon: 'status.skipped', iconClass: 'text-ink-3', labelClass: 'text-ink-3', detailClass: 'text-ink-3', word: 'skipped', wordVisible: true, wordClass: 'text-ink-3' }
}

function StageItem({ stage, first, spin }: { stage: Stage, first: boolean, spin: boolean }): ReactElement
{
  const look = STAGE_LOOKS[stage.state]
  const active = stage.state === 'active'
  return (
    <li data-stage={stage.key} data-state={stage.state} aria-current={active ? 'step' : undefined} className="flex flex-col">
      {!first && (
        <span aria-hidden="true" data-part="connector" className="flex w-3.5 justify-center">
          <span className="h-3 w-px bg-line" />
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name={look.icon} size="sm" spin={active && spin} className={look.iconClass} />
        <span className={cx('min-w-0 truncate', look.labelClass)}>{stage.label}</span>
        {look.word !== undefined && (look.wordVisible
          ? (
            <>
              <VisuallyHidden>, </VisuallyHidden>
              <span className={look.wordClass}>{look.word}</span>
            </>
          )
          : <VisuallyHidden>{`, ${look.word}`}</VisuallyHidden>)}
        {stage.detail && (
          <>
            <VisuallyHidden>, </VisuallyHidden>
            <span data-part="detail" className={cx('ms-auto shrink-0 ps-3 tabular-nums', look.detailClass)}>{stage.detail}</span>
          </>
        )}
      </span>
    </li>
  )
}

/**
 * The plan's stages as an ordered list joined by 12 px hairline connectors. Every stage states its state in
 * words: visible "failed" and "skipped", hidden "done" and "pending", and "current step" through
 * `aria-current` on the active stage, whose spinner turns only while the track is in view.
 */
export function StageTrack({ stages, className }: StageTrackProps): ReactElement
{
  const ref = useRef<HTMLOListElement>(null)
  const hasActive = stages.some((stage) => stage.state === 'active')
  const inView = useInView(ref, hasActive)
  return (
    <ol ref={ref} aria-label="Stages" className={cx('ui-stage-track flex flex-col text-label', className)}>
      {stages.map((stage, index) => <StageItem key={stage.key} stage={stage} first={index === 0} spin={inView} />)}
    </ol>
  )
}
