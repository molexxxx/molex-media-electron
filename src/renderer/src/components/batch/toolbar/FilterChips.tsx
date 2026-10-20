/**
 * The active filters as chips that name what they keep, each with a remove button named "Remove filter {label}",
 * followed by the toolbar's counts. Where the toolbar may wrap, every chip shows; on one line, the chips that do
 * not fit give way to "+{n} filters", which opens the Filter menu.
 */
import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx, IconButton } from '../../../ui'
import type { BatchFilter } from '../../../stores/batchFilters'

/** One chip: the filter and the text that names what it keeps. */
export interface FilterChip
{
  filter: BatchFilter
  label: string
}

/** The gap between chips, in px; it matches the row's gap-1. */
export const CHIP_GAP_PX = 4

/** The remove button's name: "Remove filter Audio only". */
export function removeFilterLabel(label: string): string
{
  return `Remove filter ${label}`
}

/** The overflow trigger's text: "+3 filters". */
export function moreFiltersLabel(count: number): string
{
  return `+${count} ${count === 1 ? 'filter' : 'filters'}`
}

/**
 * How many chips show on one line: all of them when they fit, otherwise as many as leave room for the overflow
 * trigger. Widths of zero (nothing measured yet) fit.
 */
export function chipsThatFit(widths: readonly number[], available: number, overflowWidth: number, gap: number = CHIP_GAP_PX): number
{
  const total = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0)
  if (total <= available || widths.every((width) => width === 0))
  {
    return widths.length
  }
  let used = 0
  let fit = 0
  for (const width of widths)
  {
    const next = used + (fit > 0 ? gap : 0) + width
    if (next + gap + overflowWidth > available)
    {
      break
    }
    used = next
    fit += 1
  }
  return fit
}

/** A stable key for a chip. */
export function chipKey(filter: BatchFilter): string
{
  return `${filter.facet}:${filter.value}`
}

/** Props of FilterChips. */
export interface FilterChipsProps
{
  chips: readonly FilterChip[]
  onRemove(filter: BatchFilter): void
  /** Every chip shows and the row wraps; otherwise the chips that do not fit give way to the overflow trigger. */
  wrap: boolean
  /** The "+{n} filters" trigger of the Filter menu, given its text. */
  renderOverflow(label: string, hidden: number): ReactNode
  /** The counts after the chips ("Showing 12 of 40 · 8 selected"); null shows none. */
  counts?: string | null
  /** Takes focus when the last chip is removed, such as the Filter menu's trigger. */
  onEmptied?(): void
  className?: string
}

const CHIP_CLASS = 'inline-flex h-6 max-w-60 shrink-0 items-center gap-0.5 rounded-sm border border-line bg-raised pl-2 text-label text-ink'

/** The chips and counts after the Filter menu. */
export function FilterChips({ chips, onRemove, wrap, renderOverflow, counts = null, onEmptied, className }: FilterChipsProps): React.JSX.Element | null
{
  const rowRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const countsRef = useRef<HTMLParagraphElement>(null)
  const focusAfter = useRef<number | null>(null)
  const [room, setRoom] = useState(0)
  const [widths, setWidths] = useState<{ chips: number[]; overflow: number }>({ chips: [], overflow: 0 })

  const labels = chips.map((chip) => chip.label).join('\n')
  useLayoutEffect(() =>
  {
    const ghost = ghostRef.current
    if (wrap || ghost === null)
    {
      return
    }
    const parts = Array.from(ghost.children) as HTMLElement[]
    const overflow = parts.pop()
    setWidths({ chips: parts.map((part) => part.getBoundingClientRect().width), overflow: overflow?.getBoundingClientRect().width ?? 0 })
  }, [labels, wrap])

  useLayoutEffect(() =>
  {
    const row = rowRef.current
    if (wrap || row === null)
    {
      return
    }
    const measure = (): void =>
    {
      const countsWidth = countsRef.current?.getBoundingClientRect().width ?? 0
      setRoom(Math.max(0, row.getBoundingClientRect().width - (countsWidth > 0 ? countsWidth + CHIP_GAP_PX : 0)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined')
    {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [wrap, counts])

  const measured = widths.chips.length === chips.length && widths.chips.some((width) => width > 0)
  const shown = wrap || !measured ? chips.length : chipsThatFit(widths.chips, room, widths.overflow)
  const hidden = chips.length - shown

  useLayoutEffect(() =>
  {
    const index = focusAfter.current
    if (index === null)
    {
      return
    }
    focusAfter.current = null
    const row = rowRef.current
    const buttons = row === null ? [] : Array.from(row.querySelectorAll<HTMLElement>('[data-chip-remove]'))
    const target = buttons[Math.min(index, buttons.length - 1)] ?? row?.querySelector<HTMLElement>('[data-chip-overflow] button') ?? null
    if (target !== null)
    {
      target.focus()
      return
    }
    onEmptied?.()
  })

  if (chips.length === 0 && counts === null)
  {
    return null
  }

  return (
    <div
      ref={rowRef}
      data-filter-chips=""
      data-wrap={wrap ? '' : undefined}
      className={cx(
        'relative flex min-w-0 items-center gap-1',
        wrap ? 'min-w-60 flex-[1_1_15rem] flex-wrap gap-y-2 py-1' : 'flex-1 flex-nowrap overflow-hidden',
        className
      )}
    >
      {chips.length > 0
        ? (
          <ul aria-label="Active filters" className={cx('flex min-w-0 items-center gap-1', wrap ? 'flex-wrap gap-y-2' : 'flex-nowrap')}>
            {chips.slice(0, shown).map((chip, index) => (
              <li key={chipKey(chip.filter)} className={CHIP_CLASS}>
                <span data-chip-label="" className="truncate">{chip.label}</span>
                <IconButton
                  icon="action.close"
                  size="sm"
                  label={removeFilterLabel(chip.label)}
                  data-chip-remove=""
                  onClick={() =>
                  {
                    focusAfter.current = index
                    onRemove(chip.filter)
                  }}
                />
              </li>
            ))}
          </ul>
          )
        : null}
      {hidden > 0
        ? <span data-chip-overflow="" className="flex shrink-0 items-center">{renderOverflow(moreFiltersLabel(hidden), hidden)}</span>
        : null}
      {counts !== null
        ? <p ref={countsRef} className="ml-1 shrink-0 whitespace-nowrap text-label tabular-nums text-ink-2">{counts}</p>
        : null}
      {!wrap && chips.length > 0
        ? (
          <div ref={ghostRef} aria-hidden="true" data-chip-ghost="" className="pointer-events-none invisible absolute top-0 left-0 flex gap-1">
            {chips.map((chip) => (
              <span key={chipKey(chip.filter)} className={cx(CHIP_CLASS, 'pr-0')}>
                <span className="truncate">{chip.label}</span>
                <span className="size-6 shrink-0" />
              </span>
            ))}
            <span data-chip-ghost-overflow="" className="inline-flex h-6 shrink-0 items-center px-2 text-label">{moreFiltersLabel(chips.length)}</span>
          </div>
          )
        : null}
    </div>
  )
}
