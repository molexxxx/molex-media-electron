import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type AriaAttributes, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { formatKeys } from '../../../shared/text/platform'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { ariaKeyShortcuts, splitChord, usePlatform } from './Kbd'
import { hidePopover, showPopover } from './platform'
import { Tooltip } from './Tooltip'

interface MenuItemBase
{
  /** Unique among its siblings. */
  id: string
  label: string
  /** Secondary text under the label. */
  description?: string
  icon?: IconName
  /** A chord such as "Mod+D", shown as mono text and set as `aria-keyshortcuts`. */
  shortcut?: string
  /** Keeps the item in arrow navigation and typeahead but ignores activation. */
  disabled?: boolean
  /** Why the item is disabled, shown as secondary text under the label and as its tooltip. */
  disabledReason?: string
  danger?: boolean
}

/** An item that runs `onSelect` and closes the menu. */
export interface MenuActionItem extends MenuItemBase
{
  kind?: 'action'
  onSelect: () => void
}

/** A check item; `onSelect` flips `checked`. */
export interface MenuCheckboxItem extends MenuItemBase
{
  kind: 'checkbox'
  checked: boolean
  onSelect: () => void
}

/** One choice of the radio set named `group`; `onSelect` chooses it. */
export interface MenuRadioItem extends MenuItemBase
{
  kind: 'radio'
  group: string
  checked: boolean
  onSelect: () => void
}

/** An item a submenu can hold. */
export type MenuLeafItem = MenuActionItem | MenuCheckboxItem | MenuRadioItem

/** An item that opens a submenu of leaf items; submenus nest one level only. */
export interface MenuSubmenuItem extends Omit<MenuItemBase, 'shortcut'>
{
  kind: 'submenu'
  items: Array<MenuEntry<MenuLeafItem>>
}

/** Any menu item. */
export type MenuItem = MenuLeafItem | MenuSubmenuItem

/** Items under a shared name, exposed as `role="group"` with the name as its label. */
export interface MenuGroup<T extends MenuItem = MenuItem>
{
  group: string
  items: T[]
}

/** One entry of a menu: an item, a separator, or a group of items. */
export type MenuEntry<T extends MenuItem = MenuItem> = T | 'separator' | MenuGroup<T>

/** The props a menu merges into its trigger; the trigger's own handlers and ref still run. */
export interface MenuTriggerProps
{
  ref?: Ref<HTMLElement>
  className?: string
  style?: CSSProperties
  'aria-haspopup'?: AriaAttributes['aria-haspopup']
  'aria-expanded'?: boolean
  'aria-controls'?: string
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void
}

/** Props for {@link Menu}. */
export interface MenuProps
{
  /** The menu button, a Button or IconButton. */
  trigger: ReactElement<MenuTriggerProps>
  items: MenuEntry[]
  /** The menu's accessible name. */
  label: string
  /** The trigger edge the menu lines up with. */
  align?: 'start' | 'end'
  /** Checkbox and radio items toggle and keep the menu open, as in a filter list. */
  filterList?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

const MENU_CLASS = 'ui-popover ui-overlay-scroll min-w-[max(11rem,anchor-size(width))] max-w-80 rounded-md border border-line-strong bg-overlay p-1 text-ink shadow-overlay'

function assignRef<T>(ref: Ref<T> | undefined, value: T): void
{
  if (typeof ref === 'function')
  {
    ref(value)
  }
  else if (ref)
  {
    ref.current = value
  }
}

function anchorFor(id: string): string
{
  return `--menu-${id.replace(/[^\w-]/g, '')}`
}

/** The items of one menu level, leaving out those of a nested submenu. */
function itemsOf(menu: HTMLElement): HTMLElement[]
{
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => item.closest('[role="menu"]') === menu)
}

function isGroup<T extends MenuItem>(entry: MenuEntry<T>): entry is MenuGroup<T>
{
  return typeof entry !== 'string' && !('id' in entry)
}

function isCheckable(item: MenuItem): item is MenuCheckboxItem | MenuRadioItem
{
  return item.kind === 'checkbox' || item.kind === 'radio'
}

function itemRole(item: MenuItem): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'
{
  if (item.kind === 'checkbox')
  {
    return 'menuitemcheckbox'
  }
  return item.kind === 'radio' ? 'menuitemradio' : 'menuitem'
}

/** The next item after `index`, wrapping, whose label starts with `key`. */
function typeaheadMatch(items: HTMLElement[], index: number, key: string): HTMLElement | undefined
{
  const wanted = key.toLocaleLowerCase()
  for (let step = 1; step <= items.length; step++)
  {
    const candidate = items[(index + step) % items.length]
    const text = candidate.querySelector('[data-part="label"]')?.textContent?.trim().toLocaleLowerCase() ?? ''
    if (text.startsWith(wanted))
    {
      return candidate
    }
  }
  return undefined
}

interface SubmenuLink
{
  id: string
  anchor: string
  open: boolean
}

interface MenuRowProps
{
  item: MenuItem
  domId: string
  /** Draws the leading slot, so labels line up when any sibling has a check or an icon. */
  leading: boolean
  submenu?: SubmenuLink
  onActivate: () => void
  onHover: (event: PointerEvent<HTMLButtonElement>) => void
}

function MenuRow({ item, domId, leading, submenu, onActivate, onHover }: MenuRowProps): ReactElement
{
  const platform = usePlatform()
  const checkable = isCheckable(item)
  const reason = item.disabled && item.disabledReason ? item.disabledReason : undefined
  const keys = item.kind !== 'submenu' && item.shortcut ? splitChord(item.shortcut) : null
  const labelId = `${domId}-label`
  const descriptionId = item.description ? `${domId}-description` : undefined
  const reasonId = reason ? `${domId}-reason` : undefined
  const iconInk = item.disabled || item.danger ? undefined : 'text-ink-2'

  const row = (
    <button
      type="button"
      id={domId}
      role={itemRole(item)}
      tabIndex={-1}
      aria-labelledby={labelId}
      aria-describedby={cx(descriptionId, reasonId) || undefined}
      aria-disabled={item.disabled || undefined}
      aria-checked={checkable ? item.checked : undefined}
      aria-keyshortcuts={keys ? ariaKeyShortcuts(keys, platform) : undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? submenu.open : undefined}
      aria-controls={submenu?.id}
      data-danger={item.danger || undefined}
      style={submenu ? { anchorName: submenu.anchor } : undefined}
      className={cx(
        'flex min-h-7 w-full cursor-default items-start gap-2 rounded-sm px-2 py-1 text-start text-control focus:bg-wash-hover aria-expanded:bg-wash-hover',
        item.disabled ? 'text-ink-disabled' : item.danger ? 'text-error' : 'text-ink'
      )}
      onClick={onActivate}
      onPointerMove={onHover}
    >
      {leading && (
        <span className={cx('flex h-5 w-4 shrink-0 items-center justify-center', iconInk)}>
          {checkable ? item.checked && <Icon name="action.acknowledge" /> : item.icon && <Icon name={item.icon} />}
        </span>
      )}
      {checkable && item.icon && (
        <span className={cx('flex h-5 shrink-0 items-center', iconInk)}>
          <Icon name={item.icon} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={labelId} data-part="label">{item.label}</span>
        {item.description && <span id={descriptionId} className="text-label text-ink-3">{item.description}</span>}
        {reason && <span id={reasonId} className="text-label text-ink-3">{reason}</span>}
      </span>
      {keys && <span aria-hidden="true" className={cx('ms-6 shrink-0 text-label leading-5 tabular-nums', !item.disabled && 'text-ink-3')}>{formatKeys(keys, platform)}</span>}
      {submenu && (
        <span className={cx('flex h-5 shrink-0 items-center', iconInk)}>
          <Icon name="action.expand" />
        </span>
      )}
    </button>
  )

  return reason ? <Tooltip content={reason} mode="label" placement="end" inside>{row}</Tooltip> : row
}

/** What opened a submenu: the DOM id of its item, and whether focus moves to its first item. */
interface SubmenuState
{
  parent: string
  focus: boolean
}

interface SubmenuProps
{
  id: string
  label: string
  anchor: string
  /** The open request, or null while closed. */
  request: SubmenuState | null
  onDismiss: () => void
  children?: ReactNode
}

/** An auto popover nested inside its parent menu's popover, so showing it keeps the parent open. */
function Submenu({ id, label, anchor, request, onDismiss, children }: SubmenuProps): ReactElement
{
  const ref = useRef<HTMLDivElement>(null)
  const dismissRef = useRef(onDismiss)

  useLayoutEffect(() =>
  {
    dismissRef.current = onDismiss
  })

  useLayoutEffect(() =>
  {
    const menu = ref.current as HTMLDivElement
    if (!request)
    {
      hidePopover(menu)
      return
    }
    showPopover(menu)
    if (request.focus)
    {
      itemsOf(menu)[0]?.focus()
    }
  }, [request])

  useEffect(() =>
  {
    const menu = ref.current as HTMLDivElement
    const onToggle = (event: Event): void =>
    {
      if ((event as ToggleEvent).newState === 'closed')
      {
        dismissRef.current()
      }
    }
    menu.addEventListener('toggle', onToggle)
    return () => menu.removeEventListener('toggle', onToggle)
  }, [])

  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role="menu"
      aria-label={label}
      data-placement="end"
      className={MENU_CLASS}
      style={{ positionAnchor: anchor, positionArea: 'inline-end span-block-end' }}
    >
      {children}
    </div>
  )
}

/**
 * An APG menu button: the trigger gets `aria-haspopup="menu"`, `aria-controls`, and an `aria-expanded` that
 * follows the popover's `toggle` event, and the menu is an auto popover of `menuitem`, `menuitemcheckbox`, and
 * `menuitemradio` buttons, with separators and labeled groups. Enter, Space, or Down opens it on the first
 * item and Up on the last; Up and Down wrap, Home and End jump, and a letter moves to the next item it
 * starts. Enter and Space activate, close, and return focus to the trigger, except that check and radio
 * items stay open in a `filterList`. Escape closes and returns focus; Tab closes and moves on. Disabled items
 * stay reachable, carry `aria-disabled`, and show their reason as text and as a tooltip.
 */
export function Menu({ trigger, items, label, align = 'start', filterList = false, onOpenChange, className }: MenuProps): ReactElement
{
  const baseId = useId()
  const menuId = `${baseId}menu`
  const anchorName = anchorFor(menuId)
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<SubmenuState | null>(null)
  const openRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const pointerOpen = useRef<boolean | null>(null)
  const openOn = useRef<'first' | 'last'>('first')
  const changeRef = useRef(onOpenChange)

  useLayoutEffect(() =>
  {
    changeRef.current = onOpenChange
  })

  const setShown = (next: boolean): void =>
  {
    if (openRef.current === next)
    {
      return
    }
    openRef.current = next
    setOpen(next)
    if (!next)
    {
      setSub(null)
    }
    changeRef.current?.(next)
  }

  const closeSub = (refocus: boolean): void =>
  {
    if (refocus && sub)
    {
      document.getElementById(sub.parent)?.focus()
    }
    setSub(null)
  }

  const show = (on: 'first' | 'last'): void =>
  {
    openOn.current = on
    setShown(true)
  }

  const close = (restoreFocus: boolean): void =>
  {
    hidePopover(menuRef.current as HTMLDivElement)
    setShown(false)
    if (restoreFocus)
    {
      triggerRef.current?.focus()
    }
  }

  useLayoutEffect(() =>
  {
    const menu = menuRef.current as HTMLDivElement
    if (!open)
    {
      return
    }
    showPopover(menu)
    const list = itemsOf(menu)
    const target = openOn.current === 'last' ? list[list.length - 1] : list[0]
    target?.focus()
  }, [open])

  useEffect(() =>
  {
    const menu = menuRef.current as HTMLDivElement
    const onToggle = (event: Event): void =>
    {
      if ((event as ToggleEvent).newState === 'closed')
      {
        setShown(false)
      }
    }
    menu.addEventListener('toggle', onToggle)
    return () => menu.removeEventListener('toggle', onToggle)
  }, [])

  const activate = (item: MenuItem, domId: string): void =>
  {
    if (item.disabled)
    {
      return
    }
    if (item.kind === 'submenu')
    {
      setSub({ parent: domId, focus: true })
      return
    }
    if (!(filterList && isCheckable(item)))
    {
      close(true)
    }
    item.onSelect()
  }

  const hover = (event: PointerEvent<HTMLButtonElement>, item: MenuItem, domId: string, nested: boolean): void =>
  {
    if (event.pointerType === 'touch')
    {
      return
    }
    const row = event.currentTarget
    if (document.activeElement !== row)
    {
      row.focus()
    }
    if (nested)
    {
      return
    }
    if (item.kind === 'submenu' && !item.disabled)
    {
      if (sub?.parent !== domId)
      {
        setSub({ parent: domId, focus: false })
      }
    }
    else if (sub)
    {
      setSub(null)
    }
  }

  const renderItem = (item: MenuItem, domId: string, leading: boolean, nested: boolean): ReactElement =>
  {
    const row = (link?: SubmenuLink): ReactElement => (
      <MenuRow
        key={item.id}
        item={item}
        domId={domId}
        leading={leading}
        submenu={link}
        onActivate={() => activate(item, domId)}
        onHover={(event) => hover(event, item, domId, nested)}
      />
    )
    if (item.kind !== 'submenu')
    {
      return row()
    }
    const link = { id: `${domId}-menu`, anchor: anchorFor(domId), open: sub?.parent === domId }
    return (
      <div key={item.id} role="none">
        {row(link)}
        <Submenu
          id={link.id}
          label={item.label}
          anchor={link.anchor}
          request={link.open ? sub : null}
          onDismiss={() => setSub((current) => current?.parent === domId ? null : current)}
        >
          {link.open && renderEntries(item.items, domId, true)}
        </Submenu>
      </div>
    )
  }

  const renderEntries = (entries: MenuEntry[], prefix: string, nested: boolean): ReactNode[] =>
  {
    const leading = entries
      .flatMap((entry) => entry === 'separator' ? [] : isGroup(entry) ? entry.items : [entry])
      .some((item) => isCheckable(item) || Boolean(item.icon))
    return entries.map((entry, index) =>
    {
      const domId = `${prefix}-${index}`
      if (entry === 'separator')
      {
        return <div key={`separator-${index}`} role="separator" className="mx-1 my-1 border-t border-line" />
      }
      if (isGroup(entry))
      {
        return (
          <div key={`group-${index}`} role="group" aria-label={entry.group}>
            <div aria-hidden="true" className="px-2 pt-1.5 pb-0.5 type-caption text-ink-3">{entry.group}</div>
            {entry.items.map((item, inner) => renderItem(item, `${domId}-${inner}`, leading, nested))}
          </div>
        )
      }
      return renderItem(entry, domId, leading, nested)
    })
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.defaultPrevented)
    {
      return
    }
    const target = event.target as HTMLElement
    const list = target.closest<HTMLElement>('[role="menu"]') ?? event.currentTarget
    if (event.key === 'Tab')
    {
      close(false)
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey)
    {
      return
    }
    const nested = list !== event.currentTarget
    const entries = itemsOf(list)
    const index = entries.indexOf(target)
    const focusAt = (position: number): void =>
    {
      entries[(position + entries.length) % entries.length]?.focus()
    }
    switch (event.key)
    {
      case 'ArrowDown':
        focusAt(index + 1)
        break
      case 'ArrowUp':
        focusAt(index < 0 ? -1 : index - 1)
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(-1)
        break
      case 'Enter':
      case ' ':
        entries[index]?.click()
        break
      case 'ArrowRight':
        if (nested || target.getAttribute('aria-haspopup') !== 'menu')
        {
          return
        }
        target.click()
        break
      case 'ArrowLeft':
        if (!nested)
        {
          return
        }
        closeSub(true)
        break
      case 'Escape':
        if (nested)
        {
          closeSub(true)
        }
        else
        {
          close(true)
        }
        break
      default:
      {
        const match = event.key.length === 1 ? typeaheadMatch(entries, index, event.key) : undefined
        if (!match)
        {
          return
        }
        match.focus()
      }
    }
    event.preventDefault()
  }

  const onMenuBlur = (event: FocusEvent<HTMLDivElement>): void =>
  {
    const next = event.relatedTarget
    if (openRef.current && next instanceof Node && !event.currentTarget.contains(next))
    {
      close(false)
    }
  }

  const props = trigger.props
  const button = cloneElement(trigger, {
    ref: (node: HTMLElement | null) =>
    {
      triggerRef.current = node
      assignRef(props.ref, node)
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': menuId,
    className: cx(props.className, 'aria-expanded:bg-raised'),
    style: { ...props.style, anchorName: cx(props.style?.anchorName && `${props.style.anchorName},`, anchorName) },
    onPointerDown: (event: PointerEvent<HTMLElement>) =>
    {
      props.onPointerDown?.(event)
      pointerOpen.current = openRef.current
    },
    onClick: (event: MouseEvent<HTMLElement>) =>
    {
      props.onClick?.(event)
      const wasOpen = event.detail === 0 ? openRef.current : pointerOpen.current ?? openRef.current
      pointerOpen.current = null
      if (event.defaultPrevented)
      {
        return
      }
      if (wasOpen)
      {
        close(false)
      }
      else
      {
        show('first')
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) =>
    {
      props.onKeyDown?.(event)
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
      {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')
      {
        event.preventDefault()
        show('first')
      }
      else if (event.key === 'ArrowUp')
      {
        event.preventDefault()
        show('last')
      }
    }
  })

  return (
    <>
      {button}
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        role="menu"
        aria-label={label}
        data-placement="bottom"
        className={cx(MENU_CLASS, className)}
        style={{ positionAnchor: anchorName, positionArea: align === 'end' ? 'block-end span-inline-start' : 'block-end span-inline-end' }}
        onKeyDown={onMenuKeyDown}
        onBlur={onMenuBlur}
      >
        {open && renderEntries(items, baseId, false)}
      </div>
    </>
  )
}
