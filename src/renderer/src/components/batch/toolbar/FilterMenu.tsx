/**
 * The Filter menu: check items grouped Type, Channels, Container, Folder, Operation, Recipe, Status, and Batch,
 * each with the number of rows it keeps, then "Clear filters". Items toggle and keep the menu open.
 */
import React, { type ReactElement, type Ref } from 'react'
import { Button, IconButton, Menu, type MenuEntry, type MenuTriggerProps } from '../../../ui'
import { formatCount, type BatchFilter, type FilterMenuGroup, type FilterOption } from '../../../stores/batchFilters'
import { chipKey } from './FilterChips'

/** The trigger's text and the menu's name. */
export const FILTER_LABEL = 'Filter'

/** The last item, which removes every chip. */
export const CLEAR_FILTERS_LABEL = 'Clear filters'

/** Why "Clear filters" is unavailable. */
export const NO_FILTERS_REASON = 'No filters are set.'

/** A check item's text: the value with the number of rows it keeps, "Audio only (12)". */
export function filterOptionLabel(option: FilterOption): string
{
  return `${option.label} (${formatCount(option.count)})`
}

/** The trigger's name while chips are set: "Filter, 3 set". */
export function filterTriggerLabel(active: number): string
{
  return active > 0 ? `${FILTER_LABEL}, ${formatCount(active)} set` : FILTER_LABEL
}

/** The menu's entries: one group of check items per facet that has options, then "Clear filters". */
export function filterMenuEntries(
  groups: readonly FilterMenuGroup[],
  active: number,
  onToggle: (filter: BatchFilter) => void,
  onClear: () => void
): MenuEntry[]
{
  const entries: MenuEntry[] = groups
    .filter((group) => group.options.length > 0)
    .map((group) => ({
      group: group.label,
      items: group.options.map((option) => ({
        kind: 'checkbox' as const,
        id: chipKey(option.filter),
        label: filterOptionLabel(option),
        checked: option.checked,
        onSelect: () => onToggle(option.filter)
      }))
    }))
  entries.push('separator', active === 0
    ? { id: 'clear-filters', label: CLEAR_FILTERS_LABEL, disabled: true, disabledReason: NO_FILTERS_REASON, onSelect: onClear }
    : { id: 'clear-filters', label: CLEAR_FILTERS_LABEL, onSelect: onClear })
  return entries
}

/** Props of FilterMenu. */
export interface FilterMenuProps
{
  /** The menu's groups for the list's rows and chips (batchFilters' filterMenu). */
  groups: readonly FilterMenuGroup[]
  /** How many chips are set. */
  active: number
  onToggle(filter: BatchFilter): void
  onClear(): void
  /** Replaces the "Filter" button, as "+{n} filters" does. */
  trigger?: ReactElement<MenuTriggerProps>
  /** Draws the trigger as an icon button, keeping its name. */
  iconOnly?: boolean
  /** Shows the number of chips on the trigger, where the chips themselves are out of view. */
  showCount?: boolean
  /** Classes of the trigger's text, such as a container query that keeps it for assistive technology only. */
  labelClassName?: string
  triggerRef?: Ref<HTMLButtonElement>
  onOpenChange?(open: boolean): void
}

/** The Filter menu button. */
export function FilterMenu({
  groups,
  active,
  onToggle,
  onClear,
  trigger,
  iconOnly = false,
  showCount = false,
  labelClassName,
  triggerRef,
  onOpenChange
}: FilterMenuProps): React.JSX.Element
{
  const counted = showCount && active > 0
  const button = trigger ?? (iconOnly
    ? <IconButton ref={triggerRef} icon="action.filter" label={filterTriggerLabel(counted ? active : 0)} />
    : (
      <Button
        ref={triggerRef}
        variant="ghost"
        icon="action.filter"
        iconEnd="action.openMenu"
        aria-label={counted ? filterTriggerLabel(active) : undefined}
      >
        <span className={labelClassName}>{FILTER_LABEL}</span>
        {counted ? <span className="ml-1 text-label tabular-nums text-mark">{formatCount(active)}</span> : null}
      </Button>
      ))
  return (
    <Menu
      trigger={button}
      label={FILTER_LABEL}
      items={filterMenuEntries(groups, active, onToggle, onClear)}
      filterList
      onOpenChange={onOpenChange}
    />
  )
}
