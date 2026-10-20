import type { ReactElement } from 'react'
import { cx } from './cx'
import { VisuallyHidden } from './VisuallyHidden'

/** Props for {@link CatalogNumber}. */
export interface CatalogNumberProps
{
  /** The job's id, such as "MM-0141". */
  value: string
  /** `sm` for a table cell, `display` for a heading. */
  size?: 'sm' | 'display'
  selected?: boolean
  className?: string
}

/** The digits a job id shows, without its prefix or leading zeros: "MM-0141" reads "141". */
export function jobNumber(value: string): string
{
  const digits = value.slice(value.indexOf('-') + 1)
  return digits.replace(/^0+(?=\d)/, '')
}

/**
 * A job's number as a quiet tabular figure; screen readers and copying get the full id. The display size is the
 * same number as a heading would set it.
 */
export function CatalogNumber({ value, size = 'sm', selected = false, className }: CatalogNumberProps): ReactElement
{
  return (
    <span
      data-size={size}
      data-selected={selected || undefined}
      className={cx(
        'ui-catalog-number whitespace-nowrap tabular-nums',
        size === 'display' ? 'text-section text-ink-2' : cx('text-label', selected ? 'text-ink-2' : 'text-ink-3'),
        className
      )}
    >
      <span aria-hidden="true">{jobNumber(value)}</span>
      <VisuallyHidden>{value}</VisuallyHidden>
    </span>
  )
}
