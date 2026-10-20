/**
 * @module components/dashboard/ToolCard
 * @description One row of a Dashboard command list: a glyph, a name, a line of detail, and the action it runs.
 */
import React from 'react'
import { cx, Icon, type IconName } from '../../../ui'

/** Props for {@link ToolRow}. */
export interface ToolRowProps
{
  icon: IconName
  title: string
  /** The secondary line: what the row starts with or opens. */
  detail: string
  onActivate: () => void
  /** Keeps the row focusable and ignores activation while a picker is open. */
  busy?: boolean
}

/** A full-width command row with an instant hover fill; rows stack inside a framed list. */
export function ToolRow({ icon, title, detail, onActivate, busy = false }: ToolRowProps): React.JSX.Element
{
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-disabled={busy || undefined}
        onClick={busy ? undefined : onActivate}
        className={cx(
          'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left',
          busy ? 'cursor-default' : 'hover:bg-wash-hover active:bg-wash-pressed'
        )}
      >
        <Icon name={icon} size="md" className="text-ink-2" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-body text-ink">{title}</span>
          <span className="truncate text-label text-ink-3">{detail}</span>
        </span>
        <Icon name="action.next" size="sm" className="text-ink-3" />
      </button>
    </li>
  )
}
