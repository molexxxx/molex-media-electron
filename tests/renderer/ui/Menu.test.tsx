/**
 * Menu: the menu button contract (trigger ARIA synced with the popover, arrows with wrap, Home and End,
 * typeahead, activation with focus return), disabled items that stay reachable and show their reason as
 * text, check and radio items, groups, and one level of submenus.
 */
import React, { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../../../src/renderer/src/ui/Button'
import { PlatformProvider } from '../../../src/renderer/src/ui/Kbd'
import { Menu, type MenuEntry, type MenuProps } from '../../../src/renderer/src/ui/Menu'

afterEach(() =>
{
  cleanup()
})

const REASON = 'Nothing has finished yet.'

function basicItems(): { items: MenuEntry[], add: ReturnType<typeof vi.fn>, duplicate: ReturnType<typeof vi.fn>, clear: ReturnType<typeof vi.fn>, remove: ReturnType<typeof vi.fn> }
{
  const add = vi.fn()
  const duplicate = vi.fn()
  const clear = vi.fn()
  const remove = vi.fn()
  return {
    items: [
      { id: 'add', label: 'Add files', shortcut: 'Mod+O', onSelect: add },
      { id: 'duplicate', label: 'Duplicate', description: 'Copies the recipe too', onSelect: duplicate },
      'separator',
      { id: 'clear', label: 'Clear finished', disabled: true, disabledReason: REASON, onSelect: clear },
      { id: 'remove', label: 'Remove', danger: true, onSelect: remove }
    ],
    add,
    duplicate,
    clear,
    remove
  }
}

function renderMenu(items: MenuEntry[], props: Partial<MenuProps> = {}): HTMLElement
{
  render(
    <PlatformProvider platform="win32">
      <Menu label="Queue actions" trigger={<button type="button">Actions</button>} items={items} {...props} />
      <button type="button">After</button>
    </PlatformProvider>
  )
  return screen.getByRole('button', { name: 'Actions' })
}

function menuOf(trigger: HTMLElement): HTMLElement
{
  const menu = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
  expect(menu).not.toBeNull()
  return menu as HTMLElement
}

function focused(): Element | null
{
  return document.activeElement
}

function key(target: Element | null, name: string, init: Record<string, unknown> = {}): void
{
  fireEvent.keyDown(target as Element, { key: name, ...init })
}

describe('Menu trigger', () =>
{
  it('is a menu button whose aria-expanded is false, then true while open', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    const menu = menuOf(trigger)
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(menu).toHaveAttribute('role', 'menu')
    expect(menu).toHaveAttribute('popover', 'auto')
    expect(menu).toHaveAttribute('aria-label', 'Queue actions')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    key(trigger, 'ArrowDown')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    key(focused(), 'Escape')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the popover when it opens and renders no items while closed', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    const menu = menuOf(trigger)
    const show = vi.spyOn(menu, 'showPopover')
    expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0)
    key(trigger, 'ArrowDown')
    expect(show).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('menuitem', { hidden: true })).toHaveLength(4)
    expect(screen.getByRole('separator', { hidden: true })).toBeInTheDocument()
  })

  it('opens on the first item with ArrowDown, Enter, and Space', () =>
  {
    for (const name of ['ArrowDown', 'Enter', ' '])
    {
      const { items } = basicItems()
      const trigger = renderMenu(items)
      key(trigger, name)
      expect(focused()).toHaveAccessibleName('Add files')
      cleanup()
    }
  })

  it('opens on the last item with ArrowUp', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowUp')
    expect(focused()).toHaveAccessibleName('Remove')
  })

  it('leaves modified keys and keys another handler consumed alone', () =>
  {
    const { items } = basicItems()
    const consume = vi.fn((event: React.KeyboardEvent) =>
    {
      if (event.key === 'Enter')
      {
        event.preventDefault()
      }
    })
    render(<Menu label="Queue actions" trigger={<button type="button" onKeyDown={consume}>Actions</button>} items={items} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    key(trigger, 'ArrowDown', { altKey: true })
    key(trigger, 'Enter')
    key(trigger, 'x')
    expect(consume).toHaveBeenCalledTimes(3)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on a click and focuses the first item; a pointer click while open closes it', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(focused()).toHaveAccessibleName('Add files')
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger, { detail: 1 })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger, { detail: 1 })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('a click without a pointer toggles from the current state', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the trigger handlers and ref, and skips opening when its click handler prevents it', () =>
  {
    const { items } = basicItems()
    const ref = createRef<HTMLButtonElement>()
    const onClick = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const onPointerDown = vi.fn()
    render(
      <Menu
        label="Queue actions"
        trigger={<button ref={ref} type="button" className="own" style={{ color: 'inherit' }} onClick={onClick} onPointerDown={onPointerDown}>Actions</button>}
        items={items}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Actions' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(ref.current).toBe(trigger)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveClass('own')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('wires a Button trigger and assigns a callback ref', () =>
  {
    const { items } = basicItems()
    const ref = vi.fn()
    render(<Menu label="Add" trigger={<Button ref={ref}>Add</Button>} items={items} />)
    const trigger = screen.getByRole('button', { name: 'Add' })
    expect(ref).toHaveBeenCalledWith(trigger)
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    key(trigger, 'ArrowDown')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('syncs aria-expanded when the platform closes the popover', () =>
  {
    const { items } = basicItems()
    const onOpenChange = vi.fn()
    const trigger = renderMenu(items, { onOpenChange })
    key(trigger, 'ArrowDown')
    const menu = menuOf(trigger)
    act(() =>
    {
      menu.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open', oldState: 'closed' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    act(() =>
    {
      menu.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed', oldState: 'open' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    act(() =>
    {
      menu.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed', oldState: 'closed' }))
    })
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })
})

describe('Menu keyboard', () =>
{
  it('moves with Up and Down and wraps at both ends', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowUp')
    expect(focused()).toHaveAccessibleName('Remove')
    key(focused(), 'ArrowDown')
    expect(focused()).toHaveAccessibleName('Add files')
    key(focused(), 'ArrowDown')
    expect(focused()).toHaveAccessibleName('Duplicate')
  })

  it('jumps with Home and End', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'End')
    expect(focused()).toHaveAccessibleName('Remove')
    key(focused(), 'Home')
    expect(focused()).toHaveAccessibleName('Add files')
  })

  it('moves to the next item starting with a typed letter, wrapping, and ignores letters that match nothing', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'r')
    expect(focused()).toHaveAccessibleName('Remove')
    key(focused(), 'A')
    expect(focused()).toHaveAccessibleName('Add files')
    key(focused(), 'c')
    expect(focused()).toHaveAccessibleName('Clear finished')
    key(focused(), 'z')
    expect(focused()).toHaveAccessibleName('Clear finished')
    key(focused(), 'F2')
    expect(focused()).toHaveAccessibleName('Clear finished')
  })

  it('Enter activates, closes, and returns focus to the trigger', () =>
  {
    const { items, duplicate } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    key(focused(), 'Enter')
    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(trigger)
    expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0)
  })

  it('Space activates too, and a click activates the clicked item', () =>
  {
    const { items, add, remove } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), ' ')
    expect(add).toHaveBeenCalledTimes(1)
    key(trigger, 'ArrowDown')
    fireEvent.click(screen.getByRole('menuitem', { hidden: true, name: 'Remove' }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(focused()).toBe(trigger)
  })

  it('Escape closes and returns focus to the trigger', () =>
  {
    const { items, add } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const menu = menuOf(trigger)
    const hide = vi.spyOn(menu, 'hidePopover')
    key(focused(), 'Escape')
    expect(hide).toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(trigger)
    expect(add).not.toHaveBeenCalled()
  })

  it('Tab closes without pulling focus back', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const item = focused()
    key(item, 'Tab')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).not.toBe(trigger)
  })

  it('ignores keys with Ctrl, Alt, or Meta held and keys another handler consumed', () =>
  {
    const { items, add } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown', { ctrlKey: true })
    key(focused(), 'Enter', { altKey: true })
    expect(focused()).toHaveAccessibleName('Add files')
    const item = focused() as HTMLElement
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    event.preventDefault()
    act(() =>
    {
      item.dispatchEvent(event)
    })
    expect(add).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes when focus leaves the menu', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    act(() =>
    {
      screen.getByRole('button', { name: 'After' }).focus()
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('moves focus to an item under the pointer, but not for touch', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const remove = screen.getByRole('menuitem', { hidden: true, name: 'Remove' })
    fireEvent.pointerMove(remove, { pointerType: 'touch' })
    expect(focused()).toHaveAccessibleName('Add files')
    fireEvent.pointerMove(remove)
    expect(focused()).toBe(remove)
    fireEvent.pointerMove(remove)
    expect(focused()).toBe(remove)
  })
})

describe('Menu items', () =>
{
  it('keeps a disabled item in arrow navigation with aria-disabled, and Enter on it does not call onSelect', () =>
  {
    const { items, clear } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    key(focused(), 'ArrowDown')
    const item = focused()
    expect(item).toHaveAccessibleName('Clear finished')
    expect(item).toHaveAttribute('aria-disabled', 'true')
    key(item, 'Enter')
    fireEvent.click(item as Element)
    expect(clear).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(focused()).toBe(item)
  })

  it('renders a disabled item\'s reason as visible secondary text and as its tooltip', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const item = screen.getByRole('menuitem', { hidden: true, name: 'Clear finished' })
    expect(item).toHaveAccessibleDescription(REASON)
    const visible = screen.getAllByText(REASON).filter((node) => !node.closest('[role="tooltip"]'))
    expect(visible).toHaveLength(1)
    expect(visible[0]).not.toHaveAttribute('aria-hidden')
    expect(item).toContainElement(visible[0])
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).toHaveTextContent(REASON)
    expect(item).toContainElement(tip)
  })

  it('Escape first hides a disabled item\'s tooltip and keeps the menu open', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'End')
    key(focused(), 'ArrowUp')
    expect(focused()).toHaveAccessibleName('Clear finished')
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).toHaveAttribute('data-open')
    key(focused(), 'Escape')
    expect(tip).not.toHaveAttribute('data-open')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    key(focused(), 'Escape')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('names items by their label and describes them by their description', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const item = screen.getByRole('menuitem', { hidden: true, name: 'Duplicate' })
    expect(item).toHaveAccessibleDescription('Copies the recipe too')
    expect(item).toHaveAttribute('tabindex', '-1')
  })

  it('sets aria-keyshortcuts for a shortcut and shows it as text', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const item = screen.getByRole('menuitem', { hidden: true, name: 'Add files' })
    expect(item).toHaveAttribute('aria-keyshortcuts', 'Control+O')
    expect(screen.getByText('Ctrl+O')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('menuitem', { hidden: true, name: 'Duplicate' })).not.toHaveAttribute('aria-keyshortcuts')
  })

  it('marks danger items', () =>
  {
    const { items } = basicItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    expect(screen.getByRole('menuitem', { hidden: true, name: 'Remove' })).toHaveAttribute('data-danger')
    expect(screen.getByRole('menuitem', { hidden: true, name: 'Add files' })).not.toHaveAttribute('data-danger')
  })

  it('exposes checkbox and radio items with aria-checked inside a labeled group', () =>
  {
    const subfolders = vi.fn()
    const narrow = vi.fn()
    const wide = vi.fn()
    const trigger = renderMenu([
      { id: 'subfolders', kind: 'checkbox', label: 'Include subfolders', checked: true, onSelect: subfolders },
      'separator',
      {
        group: 'Inspector width',
        items: [
          { id: 'narrow', kind: 'radio', group: 'width', label: 'Narrow', checked: false, icon: 'action.expand', onSelect: narrow },
          { id: 'wide', kind: 'radio', group: 'width', label: 'Wide', checked: true, onSelect: wide }
        ]
      }
    ])
    key(trigger, 'ArrowDown')
    const check = screen.getByRole('menuitemcheckbox', { hidden: true, name: 'Include subfolders' })
    expect(check).toHaveAttribute('aria-checked', 'true')
    const group = screen.getByRole('group', { hidden: true, name: 'Inspector width' })
    const radios = screen.getAllByRole('menuitemradio', { hidden: true })
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    radios.forEach((radio) => expect(group).toContainElement(radio))
    key(check, 'End')
    expect(focused()).toBe(radios[1])
    key(focused(), 'ArrowUp')
    key(focused(), 'Enter')
    expect(narrow).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps a filter list open when a check or radio item toggles', () =>
  {
    const subfolders = vi.fn()
    const done = vi.fn()
    const trigger = renderMenu([
      { id: 'subfolders', kind: 'checkbox', label: 'Include subfolders', checked: false, onSelect: subfolders },
      { id: 'sort', kind: 'radio', group: 'sort', label: 'Sort by name', checked: false, onSelect: subfolders },
      { id: 'done', label: 'Done', onSelect: done }
    ], { filterList: true })
    key(trigger, 'ArrowDown')
    const check = focused()
    key(check, ' ')
    key(check, 'ArrowDown')
    key(focused(), 'Enter')
    expect(subfolders).toHaveBeenCalledTimes(2)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    key(focused(), 'ArrowDown')
    key(focused(), 'Enter')
    expect(done).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('handles an empty menu', () =>
  {
    const trigger = renderMenu([])
    key(trigger, 'ArrowDown')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    key(menuOf(trigger), 'ArrowDown')
    key(menuOf(trigger), 'Escape')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})

function submenuItems(): { items: MenuEntry[], loudness: ReturnType<typeof vi.fn>, flac: ReturnType<typeof vi.fn>, sameFolder: ReturnType<typeof vi.fn> }
{
  const loudness = vi.fn()
  const flac = vi.fn()
  const sameFolder = vi.fn()
  return {
    items: [
      { id: 'next', label: 'Run next', onSelect: vi.fn() },
      {
        id: 'recipe',
        kind: 'submenu',
        label: 'Change operation',
        items: [
          { id: 'loudness', label: 'Loudness -14 LUFS', onSelect: loudness },
          'separator',
          { group: 'Formats', items: [{ id: 'flac', label: 'FLAC archive', onSelect: flac }] }
        ]
      },
      { id: 'similar', kind: 'submenu', label: 'Select similar', items: [{ id: 'folder', label: 'Same folder', onSelect: sameFolder }] },
      {
        id: 'pin',
        kind: 'submenu',
        label: 'Pin to number',
        disabled: true,
        disabledReason: 'Pinning takes one job.',
        items: [{ id: 'first', label: 'First', onSelect: vi.fn() }]
      },
      { id: 'remove', label: 'Remove', onSelect: vi.fn() }
    ],
    loudness,
    flac,
    sameFolder
  }
}

function item(name: string): HTMLElement
{
  return screen.getByRole('menuitem', { hidden: true, name })
}

function submenuOf(parent: HTMLElement): HTMLElement
{
  const menu = document.getElementById(parent.getAttribute('aria-controls') ?? '')
  expect(menu).not.toBeNull()
  return menu as HTMLElement
}

function toggle(element: HTMLElement, newState: 'open' | 'closed'): void
{
  act(() =>
  {
    element.dispatchEvent(Object.assign(new Event('toggle'), { newState, oldState: newState === 'open' ? 'closed' : 'open' }))
  })
}

describe('Menu submenus', () =>
{
  it('Right opens a submenu on its first item and Left closes it back to its parent item', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    const parent = item('Change operation')
    expect(focused()).toBe(parent)
    expect(parent).toHaveAttribute('aria-haspopup', 'menu')
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    const submenu = submenuOf(parent)
    expect(submenu).toHaveAttribute('role', 'menu')
    expect(submenu).toHaveAttribute('aria-label', 'Change operation')
    expect(submenu).toHaveAttribute('popover', 'auto')
    expect(menuOf(trigger)).toContainElement(submenu)
    const show = vi.spyOn(submenu, 'showPopover')
    key(parent, 'ArrowRight')
    expect(show).toHaveBeenCalledTimes(1)
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    expect(focused()).toHaveAccessibleName('Loudness -14 LUFS')
    expect(submenu).toContainElement(focused() as HTMLElement)
    key(focused(), 'ArrowLeft')
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(parent)
    expect(screen.queryByRole('menuitem', { hidden: true, name: 'Loudness -14 LUFS' })).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps arrows, Home, End, and typeahead inside the submenu', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    key(focused(), 'ArrowRight')
    key(focused(), 'ArrowDown')
    expect(focused()).toHaveAccessibleName('FLAC archive')
    expect(screen.getByRole('group', { hidden: true, name: 'Formats' })).toContainElement(focused() as HTMLElement)
    key(focused(), 'ArrowDown')
    expect(focused()).toHaveAccessibleName('Loudness -14 LUFS')
    key(focused(), 'End')
    expect(focused()).toHaveAccessibleName('FLAC archive')
    key(focused(), 'Home')
    expect(focused()).toHaveAccessibleName('Loudness -14 LUFS')
    key(focused(), 'r')
    expect(focused()).toHaveAccessibleName('Loudness -14 LUFS')
    key(focused(), 'f')
    expect(focused()).toHaveAccessibleName('FLAC archive')
  })

  it('Escape in a submenu closes only the submenu, then a second Escape closes the menu', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    const parent = item('Change operation')
    key(parent, 'ArrowRight')
    key(focused(), 'Escape')
    expect(parent).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(parent)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    key(focused(), 'Escape')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(trigger)
  })

  it('Enter opens a submenu, and activating an item inside closes every level and returns focus', () =>
  {
    const { items, sameFolder } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 's')
    expect(focused()).toBe(item('Select similar'))
    key(focused(), 'Enter')
    expect(focused()).toHaveAccessibleName('Same folder')
    key(focused(), 'Enter')
    expect(sameFolder).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(trigger)
  })

  it('a click on a submenu item opens it on its first item', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    fireEvent.click(item('Select similar'))
    expect(item('Select similar')).toHaveAttribute('aria-expanded', 'true')
    expect(focused()).toHaveAccessibleName('Same folder')
  })

  it('leaves Right on a plain item and Left in the top menu unconsumed', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    expect(fireEvent.keyDown(focused() as Element, { key: 'ArrowRight' })).toBe(true)
    expect(fireEvent.keyDown(focused() as Element, { key: 'ArrowLeft' })).toBe(true)
    expect(focused()).toHaveAccessibleName('Run next')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not open a disabled submenu item, which still shows its reason', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowUp')
    key(focused(), 'ArrowUp')
    const pin = item('Pin to number')
    expect(focused()).toBe(pin)
    expect(pin).toHaveAttribute('aria-disabled', 'true')
    expect(pin).toHaveAccessibleDescription('Pinning takes one job.')
    key(pin, 'ArrowRight')
    key(pin, 'Enter')
    fireEvent.pointerMove(pin)
    expect(pin).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(pin)
  })

  it('opens a submenu on hover without taking focus into it, and closes it on hover over another item', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const recipe = item('Change operation')
    const similar = item('Select similar')
    fireEvent.pointerMove(recipe)
    expect(recipe).toHaveAttribute('aria-expanded', 'true')
    expect(focused()).toBe(recipe)
    fireEvent.pointerMove(recipe)
    expect(recipe).toHaveAttribute('aria-expanded', 'true')
    const inside = item('Loudness -14 LUFS')
    fireEvent.pointerMove(inside)
    expect(focused()).toBe(inside)
    expect(recipe).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerMove(similar)
    expect(recipe).toHaveAttribute('aria-expanded', 'false')
    expect(similar).toHaveAttribute('aria-expanded', 'true')
    key(similar, 'ArrowRight')
    expect(focused()).toHaveAccessibleName('Same folder')
    fireEvent.pointerMove(item('Remove'))
    expect(similar).toHaveAttribute('aria-expanded', 'false')
    fireEvent.pointerMove(item('Run next'))
    expect(focused()).toHaveAccessibleName('Run next')
  })

  it('syncs its item when the platform closes a submenu, ignoring a stale close of an earlier one', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    const recipe = item('Change operation')
    const similar = item('Select similar')
    fireEvent.pointerMove(recipe)
    fireEvent.pointerMove(similar)
    toggle(submenuOf(recipe), 'closed')
    expect(similar).toHaveAttribute('aria-expanded', 'true')
    toggle(submenuOf(similar), 'open')
    expect(similar).toHaveAttribute('aria-expanded', 'true')
    toggle(submenuOf(similar), 'closed')
    expect(similar).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('Tab in a submenu closes the whole menu', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    key(focused(), 'ArrowRight')
    key(focused(), 'Tab')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('reopens with every submenu closed after the platform closes the menu', () =>
  {
    const { items } = submenuItems()
    const trigger = renderMenu(items)
    key(trigger, 'ArrowDown')
    key(focused(), 'ArrowDown')
    key(focused(), 'ArrowRight')
    toggle(menuOf(trigger), 'closed')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    key(trigger, 'ArrowDown')
    expect(item('Change operation')).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toHaveAccessibleName('Run next')
  })
})
