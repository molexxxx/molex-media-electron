import React from 'react'
import type { JobView } from '../../../../../shared/jobs/types'
import { footerText, splitSelection, type FieldState } from '../../../stores/recipeFields'
import { cx } from '../../../ui'

/**
 * The footer's sentences: which selected jobs an edit changes, then each value the locked jobs keep where it differs
 * from the field ("4 locked jobs keep -14.0 LUFS."). Empty for an empty selection, and when every job is locked,
 * since the Settings tab states the lock once.
 */
export function scopeLines(jobs: readonly JobView[], fields: ReadonlyArray<Pick<FieldState, 'lockedNote'>> = []): string[]
{
  if (jobs.length === 0)
  {
    return []
  }
  const { editable, locked } = splitSelection(jobs)
  if (editable.length === 0)
  {
    return []
  }
  const kept = fields.map((field) => field.lockedNote).filter((note): note is string => note !== null)
  return [footerText(editable.length, locked.length), ...new Set(kept)]
}

export interface ScopeFooterProps
{
  /** The selected jobs. */
  jobs: readonly JobView[]
  /** The Recipe tab's fields, whose locked notes the footer lists. */
  fields?: ReadonlyArray<Pick<FieldState, 'lockedNote'>>
  className?: string
}

/** The inspector footer: the scope of what an edit touches and the values the locked jobs keep. */
export function ScopeFooter({ jobs, fields = [], className }: ScopeFooterProps): React.JSX.Element | null
{
  const lines = scopeLines(jobs, fields)
  if (lines.length === 0)
  {
    return null
  }
  return (
    <footer className={cx('flex flex-col gap-0.5 border-t border-line px-4 py-2 text-label text-ink-2', className)}>
      {lines.map((line, index) => (
        <p key={line} className={index === 0 ? undefined : 'text-ink-3'}>{line}</p>
      ))}
    </footer>
  )
}
