import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import { ariaKeyShortcuts, Kbd, splitChord, usePlatform } from './Kbd'
import { Popover, type PopoverProps } from './Popover'

/** One choice of a {@link Combobox}. */
export interface ComboboxOption
{
  id: string
  label: string
  /** Secondary text under the label. */
  description?: string
  /** A chord such as "Alt+6", drawn as keycaps and set as `aria-keyshortcuts`. */
  shortcut?: string
  /** Keeps the option reachable by the arrows, so a footer can explain it, but ignores choosing it. */
  disabled?: boolean
}

/** A captioned section of options, exposed as `role="group"` named by its caption. */
export interface ComboboxGroup
{
  id: string
  label: string
  options: ComboboxOption[]
}

/** What chose an option: `shift` is true for Shift+Enter and Shift+click. */
export interface ComboboxModifiers
{
  shift: boolean
}

/** Props for {@link Combobox}. */
export interface ComboboxProps
{
  /** The button that opens the picker; focus returns to it when the picker closes. */
  trigger: PopoverProps['trigger']
  /** Names the input, the list, and the popover. */
  label: string
  groups: ComboboxGroup[]
  /** Whether an option matches the typed query, which arrives trimmed; an empty query shows every option. */
  filter: (query: string, option: ComboboxOption) => boolean
  onChoose: (id: string, modifiers: ComboboxModifiers) => void
  /** Live text under the list, such as the applicability note; a function receives the highlighted option. */
  footer?: ReactNode | ((active: ComboboxOption | null) => ReactNode)
  /** Shown in place of the list when nothing matches. */
  emptyText: string
  placeholder?: string
  placement?: PopoverProps['placement']
  onOpenChange?: (open: boolean) => void
  /** Classes for the popover box, such as a width. */
  className?: string
}

interface ComboboxEntry
{
  key: string
  domId: string
  option: ComboboxOption
}

interface ComboboxSection
{
  group: ComboboxGroup
  captionId: string
  entries: ComboboxEntry[]
}

/** A press anywhere in the picker but the input keeps focus in the input, so the keys keep working. */
function keepInputFocus(event: MouseEvent<HTMLDivElement>): void
{
  if (!(event.target instanceof HTMLInputElement))
  {
    event.preventDefault()
  }
}

interface OptionRowProps
{
  entry: ComboboxEntry
  active: boolean
  onChoose: (shift: boolean) => void
  onHover: () => void
}

function OptionRow({ entry, active, onChoose, onHover }: OptionRowProps): ReactElement
{
  const platform = usePlatform()
  const { option, domId } = entry
  const keys = option.shortcut ? splitChord(option.shortcut) : null
  const descriptionId = option.description ? `${domId}-description` : undefined

  return (
    <div
      id={domId}
      role="option"
      aria-selected={active}
      aria-disabled={option.disabled || undefined}
      aria-labelledby={`${domId}-label`}
      aria-describedby={descriptionId}
      aria-keyshortcuts={keys ? ariaKeyShortcuts(keys, platform) : undefined}
      data-highlighted={active || undefined}
      className={cx(
        'flex min-h-7 cursor-default items-start gap-2 rounded-sm px-2 py-1 text-control',
        active && 'bg-wash-hover',
        option.disabled ? 'text-ink-disabled' : 'text-ink'
      )}
      onClick={(event) => onChoose(event.shiftKey)}
      onPointerMove={onHover}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${domId}-label`}>{option.label}</span>
        {option.description && <span id={descriptionId} className="text-label text-ink-3">{option.description}</span>}
      </span>
      {keys && (
        <span aria-hidden="true" className="ms-4 flex h-5 shrink-0 items-center">
          <Kbd keys={keys} />
        </span>
      )}
    </div>
  )
}

/**
 * The APG combobox with a grouped listbox popup, inside a Popover opened by `trigger`, for filtering a long
 * list. DOM focus stays in the input while `aria-activedescendant` names the highlighted option, which starts
 * on the first enabled match. Typing filters every group; Up and Down move across groups and wrap; Enter
 * chooses and Shift+Enter chooses with `shift`; Escape closes and returns focus to the trigger. Disabled
 * options stay reachable so the footer can explain them, and choosing one does nothing.
 */
export function Combobox({
  trigger,
  label,
  groups,
  filter,
  onChoose,
  footer,
  emptyText,
  placeholder,
  placement,
  onOpenChange,
  className
}: ComboboxProps): ReactElement
{
  const baseId = useId()
  const listId = `${baseId}-listbox`
  const footerId = `${baseId}-footer`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const sections = useMemo((): ComboboxSection[] =>
  {
    const needle = query.trim()
    return groups
      .map((group, groupIndex) => ({
        group,
        captionId: `${baseId}-group-${groupIndex}`,
        entries: group.options.flatMap((option, optionIndex) =>
        {
          const key = `${groupIndex}-${optionIndex}`
          return needle && !filter(needle, option) ? [] : [{ key, domId: `${baseId}-option-${key}`, option }]
        })
      }))
      .filter((section) => section.entries.length > 0)
  }, [groups, filter, query, baseId])

  const entries = sections.flatMap((section) => section.entries)
  const active = entries.find((entry) => entry.key === activeKey) ?? entries.find((entry) => !entry.option.disabled) ?? entries[0] ?? null
  const expanded = open && entries.length > 0
  const footerNode = typeof footer === 'function' ? footer(active?.option ?? null) : footer

  const handleOpenChange = (next: boolean): void =>
  {
    setOpen(next)
    if (!next)
    {
      setQuery('')
      setActiveKey(null)
    }
    onOpenChange?.(next)
  }

  const choose = (option: ComboboxOption, shift: boolean, close: () => void): void =>
  {
    if (option.disabled)
    {
      return
    }
    close()
    onChoose(option.id, { shift })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, close: () => void): void =>
  {
    if (event.altKey || event.ctrlKey || event.metaKey || !active)
    {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    {
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = entries[(entries.indexOf(active) + step + entries.length) % entries.length]
      setActiveKey(next.key)
      document.getElementById(next.domId)?.scrollIntoView({ block: 'nearest' })
    }
    else if (event.key === 'Enter')
    {
      choose(active.option, event.shiftKey, close)
    }
    else
    {
      return
    }
    event.preventDefault()
  }

  return (
    <Popover
      trigger={trigger}
      label={label}
      placement={placement}
      onOpenChange={handleOpenChange}
      className={cx('w-80', className)}
    >
      {(close) => (
        <div className="flex flex-col gap-2" onMouseDown={keepInputFocus}>
          <span className="relative flex">
            <span className="pointer-events-none absolute inset-y-0 inset-s-2 flex items-center text-ink-3">
              <Icon name="action.search" />
            </span>
            <input
              type="text"
              role="combobox"
              aria-label={label}
              aria-expanded={expanded}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={expanded && active ? active.domId : undefined}
              aria-describedby={footer === undefined ? undefined : footerId}
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={placeholder}
              className="h-(--size-control-md) w-full min-w-0 rounded-sm border border-line-control bg-sunken ps-8 pe-2 text-control text-ink transition-colors duration-fast ease-out placeholder:text-ink-3 hover:border-line-control-hover"
              onChange={(event) =>
              {
                setQuery(event.target.value)
                setActiveKey(null)
              }}
              onKeyDown={(event) => handleKeyDown(event, close)}
            />
          </span>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            hidden={entries.length === 0}
            className="ui-overlay-scroll -mx-1 max-h-72 overflow-y-auto"
          >
            {sections.map(({ group, captionId, entries: groupEntries }) => (
              <div key={group.id} role="group" aria-labelledby={captionId}>
                <div id={captionId} aria-hidden="true" className="px-2 pt-1.5 pb-0.5 type-caption text-ink-3">{group.label}</div>
                {groupEntries.map((entry) => (
                  <OptionRow
                    key={entry.option.id}
                    entry={entry}
                    active={entry === active}
                    onChoose={(shift) => choose(entry.option, shift, close)}
                    onHover={() => setActiveKey(entry.key)}
                  />
                ))}
              </div>
            ))}
          </div>
          <div role="status">
            {entries.length === 0 && <p className="px-1 py-1.5 text-control text-ink-3">{emptyText}</p>}
          </div>
          {footer !== undefined && (
            <div id={footerId} aria-live="polite" className="border-t border-line pt-2 text-label text-ink-2">
              {footerNode}
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}
