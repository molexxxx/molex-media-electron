import { useLayoutEffect, useRef, type ReactElement, type Ref } from 'react'
import { HEADER_TOOLTIPS, pauseNowLabel, STARTING_LABEL, startSelectedLabel } from '../../../copy/batch'
import type { HeaderAction, RunControls } from '../../../stores/batchHeader'
import { Button } from '../../../ui/Button'
import { cx } from '../../../ui/cx'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry } from '../../../ui/Menu'
import { SplitButton } from '../../../ui/SplitButton'
import { StatusLabel } from '../../../ui/StatusLabel'
import { Tooltip } from '../../../ui/Tooltip'

/** The label of the stand-alone Pause now button while a batch is pausing. */
export const PAUSE_NOW_LABEL = 'Pause now'

/** The name of Start's menu button. */
export const START_OPTIONS_LABEL = 'More start options'

/** Props for {@link ActionSlot}. */
export interface ActionSlotProps
{
  action: HeaderAction
  /** Draws the action as the primary button; only the one enabled next action of the moment is primary. */
  primary: boolean
  /** Pending jobs selected in Review, which "Start only the selected jobs" starts. */
  selectedCount?: number
  /** A typed refusal from main for the last Start or Append, written beside the action. */
  refusal?: string | null
  onAction: (action: HeaderAction) => void
  onStartSelected?: () => void
  /** The slot's one stable element, which keeps focus while its label changes. */
  ref?: Ref<HTMLButtonElement>
}

/**
 * The action slot: one button that relabels Review, Start, Append, Review new jobs, Resume, and Retry returned, so
 * focus stays on it while the moment changes. A disabled action is drawn neutral with its reason written beside it;
 * "Starting…" keeps the width of the label it replaces and ignores presses. Start adds its menu of related actions.
 */
export function ActionSlot({ action, primary, selectedCount = 0, refusal = null, onAction, onStartSelected, ref }: ActionSlotProps): ReactElement
{
  const starting = action.blockedBy === 'starting'
  const steadyLabel = useRef(action.label)

  useLayoutEffect(() =>
  {
    if (!starting)
    {
      steadyLabel.current = action.label
    }
  })

  const unavailable = !action.enabled && !starting
  const reason = unavailable ? action.reason : null
  const split = action.kind === 'start'
  const menuDisabled = selectedCount === 0 || starting
  const items: MenuEntry[] = [
    {
      id: 'start-selected',
      label: startSelectedLabel(selectedCount),
      shortcut: 'Mod+Shift+Enter',
      disabled: selectedCount === 0,
      onSelect: () => onStartSelected?.()
    }
  ]

  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-slot="action" data-action={action.kind}>
      {refusal !== null && (
        <span className="min-w-0 truncate" data-part="refusal">
          <StatusLabel status="blocked" label={refusal} />
        </span>
      )}
      {refusal === null && reason !== null && (
        <span aria-hidden className="min-w-0 truncate text-label text-ink-2" data-part="reason">{reason}</span>
      )}
      <span className="inline-flex shrink-0 items-stretch gap-px" data-part="split">
        <Tooltip content={action.enabled ? action.tooltip : ''}>
          <Button
            ref={ref}
            variant={primary ? 'primary' : 'secondary'}
            loading={starting}
            loadingLabel={STARTING_LABEL}
            unavailableReason={unavailable ? reason ?? action.tooltip : undefined}
            className={cx(split && 'rounded-e-none')}
            onClick={() => onAction(action)}
          >
            {starting ? steadyLabel.current : action.label}
          </Button>
        </Tooltip>
        {split && (
          <Menu
            label={START_OPTIONS_LABEL}
            items={items}
            align="end"
            trigger={(
              <IconButton
                label={START_OPTIONS_LABEL}
                icon="action.openMenu"
                variant={primary && !menuDisabled ? 'primary' : 'secondary'}
                disabled={menuDisabled}
                className="rounded-s-none"
              />
            )}
          />
        )}
      </span>
    </span>
  )
}

/** Props for {@link RunControlsSlot}. */
export interface RunControlsSlotProps
{
  controls: RunControls
  pauseRef?: Ref<HTMLButtonElement>
  pauseNowRef?: Ref<HTMLButtonElement>
  cancelRef?: Ref<HTMLButtonElement>
  /** Pause: no new job starts and running jobs finish. */
  onPause: () => void
  /** Pause now: running jobs stop and restart from the beginning; the header asks first over 30 s of work. */
  onPauseNow: () => void
  /** Cancel run: the header asks first. */
  onCancelRun: () => void
}

/**
 * The run controls in their own slot: the Pause split button with "Pause now" in its menu, or "Pause now" alone
 * while the batch is pausing, and Cancel run. Both are secondary; the primary stays with the action slot.
 */
export function RunControlsSlot({ controls, pauseRef, pauseNowRef, cancelRef, onPause, onPauseNow, onCancelRun }: RunControlsSlotProps): ReactElement
{
  const pauseNow = controls.pauseNow
  const items: MenuEntry[] = [
    {
      id: 'pause-now',
      label: pauseNow?.label ?? pauseNowLabel(0),
      description: HEADER_TOOLTIPS.pauseNow,
      disabled: pauseNow === null,
      danger: true,
      onSelect: onPauseNow
    }
  ]

  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-slot="run-controls">
      {controls.pause !== null && (
        <Tooltip content={controls.pause.tooltip}>
          <SplitButton ref={pauseRef} actionName="pause" items={items} menuDisabled={pauseNow === null} data-control="pause" onClick={onPause}>
            {controls.pause.label}
          </SplitButton>
        </Tooltip>
      )}
      {controls.pause === null && pauseNow !== null && (
        <Tooltip content={HEADER_TOOLTIPS.pauseNow}>
          <Button ref={pauseNowRef} data-control="pause-now" onClick={onPauseNow}>{PAUSE_NOW_LABEL}</Button>
        </Tooltip>
      )}
      <Tooltip content={controls.cancel.tooltip}>
        <Button ref={cancelRef} data-control="cancel" onClick={onCancelRun}>{controls.cancel.label}</Button>
      </Tooltip>
    </span>
  )
}
