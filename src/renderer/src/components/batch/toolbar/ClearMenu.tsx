/**
 * The Clear menu: "Clear done ({n})", "Clear finished ({n})", and "Remove jobs not in a batch ({n})", each with
 * the count it removes and Undo through the queue edit. Jobs that need attention (unacknowledged returns and
 * warnings, and decisions) are never counted or cleared; each scope says how many of them stay. Clear never
 * resets recipes or settings, and records stay in History.
 */
import React, { type Ref } from 'react'
import { Button, Menu, type MenuActionItem, type MenuSubmenuItem } from '../../../ui'
import type { ClearScope } from '../../../../../shared/jobs/contract'
import type { JobId } from '../../../../../shared/jobs/ids'
import { needsAttention, STATE_GROUPS } from '../../../../../shared/jobs/states'
import type { JobView } from '../../../../../shared/jobs/types'
import { attentionStays } from '../../../stores/batchActions'
import { formatCount } from '../../../stores/batchFilters'

/** The trigger's text and the menu's name. */
export const CLEAR_LABEL = 'Clear'

/** Why a scope, or the whole menu, is unavailable. */
export const NOTHING_TO_CLEAR = 'Nothing to clear.'

/** What each scope removes, and how many jobs that need attention it leaves. */
export interface ClearCounts
{
  /** Verified jobs and acknowledged warnings. */
  done: number
  /** Done jobs with warnings nobody acknowledged yet. */
  doneKept: number
  /** Done jobs plus canceled, skipped, and acknowledged returned jobs. */
  finished: number
  /** Finished jobs and decisions that need attention. */
  finishedKept: number
  /** The jobs not in a batch, in queue order. */
  pending: JobId[]
}

/** The counts of the three scopes over jobs in queue order. */
export function clearCounts(jobs: Iterable<JobView>): ClearCounts
{
  const counts: ClearCounts = { done: 0, doneKept: 0, finished: 0, finishedKept: 0, pending: [] }
  for (const job of jobs)
  {
    if (job.state === 'pending')
    {
      counts.pending.push(job.id)
      continue
    }
    const group = STATE_GROUPS[job.state]
    if (group !== 'terminal' && group !== 'decision')
    {
      continue
    }
    const stays = needsAttention(job)
    if (stays)
    {
      counts.finishedKept += 1
      counts.doneKept += job.state === 'done' ? 1 : 0
      continue
    }
    counts.finished += 1
    counts.done += job.state === 'done' ? 1 : 0
  }
  return counts
}

/** Whether any scope removes a job. */
export function canClear(counts: ClearCounts): boolean
{
  return counts.finished > 0 || counts.pending.length > 0
}

function scopeItem(id: string, label: string, count: number, kept: number, onSelect: () => void): MenuActionItem
{
  const text = `${label} (${formatCount(count)})`
  const stays = kept > 0 ? attentionStays(kept) : null
  if (count === 0)
  {
    return { id, label: text, disabled: true, disabledReason: stays === null ? NOTHING_TO_CLEAR : `${NOTHING_TO_CLEAR} ${stays}`, onSelect }
  }
  return stays === null ? { id, label: text, onSelect } : { id, label: text, description: stays, onSelect }
}

/** The menu's items: the two finished scopes, then the jobs not in a batch. */
export function clearMenuEntries(counts: ClearCounts, onClear: (scope: ClearScope) => void): MenuActionItem[]
{
  return [
    scopeItem('clear-done', 'Clear done', counts.done, counts.doneKept, () => onClear({ kind: 'done' })),
    scopeItem('clear-finished', 'Clear finished', counts.finished, counts.finishedKept, () => onClear({ kind: 'finished' })),
    scopeItem('clear-pending', 'Remove jobs not in a batch', counts.pending.length, 0, () => onClear({ kind: 'ids', ids: [...counts.pending] }))
  ]
}

/** Clear as a submenu, for the batch overflow menu while the view is too narrow for the toolbar's button. */
export function clearSubmenu(counts: ClearCounts, onClear: (scope: ClearScope) => void): MenuSubmenuItem
{
  const available = canClear(counts)
  return {
    kind: 'submenu',
    id: 'clear',
    label: CLEAR_LABEL,
    icon: 'action.clearFinished',
    ...(available ? {} : { disabled: true, disabledReason: NOTHING_TO_CLEAR }),
    items: clearMenuEntries(counts, onClear)
  }
}

/** Props of ClearMenu. */
export interface ClearMenuProps
{
  counts: ClearCounts
  onClear(scope: ClearScope): void
  triggerRef?: Ref<HTMLButtonElement>
  className?: string
}

/** The toolbar's Clear menu button; unavailable, with its reason, while no scope removes anything. */
export function ClearMenu({ counts, onClear, triggerRef, className }: ClearMenuProps): React.JSX.Element
{
  const trigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      icon="action.clearFinished"
      iconEnd="action.openMenu"
      unavailableReason={canClear(counts) ? undefined : NOTHING_TO_CLEAR}
      className={className}
    >
      {CLEAR_LABEL}
    </Button>
  )
  return <Menu trigger={trigger} label={CLEAR_LABEL} items={clearMenuEntries(counts, onClear)} align="end" />
}
