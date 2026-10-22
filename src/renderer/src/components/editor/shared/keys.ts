/**
 * @module editor/shared/keys
 * Which keys a focused control keeps for itself, so the editor's transport and editing keys never fight a field,
 * a slider, a menu, or a grid that has focus.
 */

const ACTIVATING_ROLES = new Set(['button', 'checkbox', 'switch', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'row', 'gridcell', 'link'])

const NAVIGATING_ROLES = new Set(['slider', 'spinbutton', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'row', 'gridcell', 'separator', 'listbox', 'grid', 'tree', 'treeitem'])

const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

const COMPOSITES = '[role="grid"], [role="menu"], [role="radiogroup"], [role="tablist"], [role="listbox"], [role="dialog"]'

/** True while the user types in a field. */
export function isTypingTarget(target: EventTarget | null): boolean
{
  if (!(target instanceof HTMLElement))
  {
    return false
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
}

/** True when the focused element uses `key` itself: typing, pressing a button, moving a slider, or moving in a menu or grid. */
export function ownsKey(target: EventTarget | null, key: string): boolean
{
  if (isTypingTarget(target))
  {
    return true
  }
  if (!(target instanceof HTMLElement))
  {
    return false
  }
  const role = target.getAttribute('role') ?? ''
  if (key === ' ' || key === 'Enter')
  {
    return target.tagName === 'BUTTON' || target.tagName === 'A' || ACTIVATING_ROLES.has(role)
  }
  if (NAVIGATION_KEYS.has(key))
  {
    return NAVIGATING_ROLES.has(role) || target.closest(COMPOSITES) !== null
  }
  return false
}

/** True while a modal dialog is open, which owns every key. */
export function modalOpen(): boolean
{
  return document.querySelector('dialog[open]') !== null
}
