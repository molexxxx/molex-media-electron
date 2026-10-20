/**
 * The Batch view's mode tabs: Queue with its count, Review, Run, and History. Run stays focusable with
 * aria-disabled until the first batch of the session starts and says why; pressing it then announces the same.
 */
import React from 'react'
import { Tabs, useAnnounce, type TabItem } from '../../../ui'
import { BATCH_MODES, RUN_UNAVAILABLE_ANNOUNCEMENT, RUN_UNAVAILABLE_TOOLTIP, type BatchMode } from '../../../stores/batchView'

/** The id the mode tabs and the table's panel derive their ids from; pass it to the table's TabPanel. */
export const MODE_TABS_ID = 'batch-mode'

/** The tab list's accessible name. */
export const MODE_TABS_LABEL = 'Batch modes'

/** Each mode's tab label. */
export const MODE_LABELS: Readonly<Record<BatchMode, string>> = Object.freeze({
  queue: 'Queue',
  review: 'Review',
  run: 'Run',
  history: 'History'
})

/** The four tabs: Queue carries its count, and Run waits for the first batch of the session. */
export function modeTabItems(runAvailable: boolean, queueCount: number): Array<TabItem<BatchMode>>
{
  return BATCH_MODES.map((mode): TabItem<BatchMode> =>
  {
    if (mode === 'queue')
    {
      return { value: mode, label: MODE_LABELS[mode], count: queueCount }
    }
    if (mode === 'run' && !runAvailable)
    {
      return { value: mode, label: MODE_LABELS[mode], disabled: true, disabledReason: RUN_UNAVAILABLE_TOOLTIP }
    }
    return { value: mode, label: MODE_LABELS[mode] }
  })
}

/** Props of ModeTabs. */
export interface ModeTabsProps
{
  mode: BatchMode
  /** False until the first batch of the session starts, or a restored or interrupted batch is found. */
  runAvailable: boolean
  /** Every job the engine holds. */
  queueCount: number
  onChange(mode: BatchMode): void
  className?: string
}

/** The mode tabs of the one table. */
export function ModeTabs({ mode, runAvailable, queueCount, onChange, className }: ModeTabsProps): React.JSX.Element
{
  const announce = useAnnounce()
  const pressUnavailable = (event: React.MouseEvent<HTMLDivElement>): void =>
  {
    const tab = (event.target as HTMLElement).closest('[role="tab"]')
    if (tab !== null && tab.getAttribute('aria-disabled') === 'true')
    {
      announce(RUN_UNAVAILABLE_ANNOUNCEMENT)
    }
  }
  return (
    <div className="flex shrink-0 items-center" onClickCapture={pressUnavailable}>
      <Tabs
        id={MODE_TABS_ID}
        label={MODE_TABS_LABEL}
        value={mode}
        onChange={onChange}
        tabs={modeTabItems(runAvailable, queueCount)}
        className={className}
      />
    </div>
  )
}
