/**
 * @module components/dashboard/ToolKey
 * @description One key of a Dashboard key strip: a glyph, a printed name, a line of detail, and the action it runs.
 */
import React from 'react'
import { cx, Icon, type IconName } from '../../../ui'

/** Props for {@link ToolKey}. */
export interface ToolKeyProps
{
  icon: IconName
  /** The printed name, "Normalize". */
  title: string
  /** The secondary line: the preset new files start with, or what the tool opens. */
  detail: string
  /** The accessible name when it says more than the printed one: "Add files with Normalize…". */
  name?: string
  onActivate: () => void
  /** Keeps the key focusable and ignores activation while a picker is open. */
  busy?: boolean
}

/** A key in a hairline-divided strip: the glyph above the name, an instant hover fill, and an inset focus ring. */
export function ToolKey({ icon, title, detail, name, onActivate, busy = false }: ToolKeyProps): React.JSX.Element
{
  return (
    <li className="min-w-0 bg-panel">
      <button
        type="button"
        aria-label={name}
        aria-disabled={busy || undefined}
        data-focus="inset"
        onClick={busy ? undefined : onActivate}
        className={cx(
          'flex h-full min-h-22 w-full flex-col items-start justify-start gap-3 p-3 text-start',
          busy ? 'cursor-default' : 'hover:bg-wash-hover active:bg-wash-pressed'
        )}
      >
        <Icon name={icon} size="lg" className="text-ink-2" />
        <span className="flex w-full min-w-0 flex-col">
          <span className="truncate text-body font-semibold text-ink">{title}</span>
          <span className="line-clamp-2 text-label text-ink-3" title={detail}>{detail}</span>
        </span>
      </button>
    </li>
  )
}

/** Props for {@link KeyStrip}. */
export interface KeyStripProps
{
  children: React.ReactNode
  /** The column template, such as `grid-cols-5`. */
  className?: string
}

/** The framed strip the keys sit in; the hairline grid between keys is the strip's own ground showing through. */
export function KeyStrip({ children, className }: KeyStripProps): React.JSX.Element
{
  return <ul className={cx('grid gap-px overflow-hidden rounded-sm border border-line bg-line', className)}>{children}</ul>
}
