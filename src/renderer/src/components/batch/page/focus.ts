import { useEffect, useRef, type RefObject } from 'react'
import { useAppStore } from '../../../stores/appStore'
import type { View } from '../../../stores/types'

/** An element, or a getter evaluated only when focus reaches it in a chain. */
export type FocusTarget = HTMLElement | null | undefined | (() => HTMLElement | null | undefined)

/** The places of the Batch view that focus can land on, read lazily so each lookup sees the current page. */
export interface FocusTargets
{
  /** A job's row in the visible table. */
  row(id: string): HTMLElement | null
  /** The row that holds the visible table's selection focus. */
  focusedRow(): HTMLElement | null
  /** The visible table's grid element. */
  table(): HTMLElement | null
  /** The header's primary slot, one element that relabels Review, Start, Append, Resume, and Retry. */
  actionSlot(): HTMLElement | null
  /** The header's run-controls slot that holds Pause and Cancel run. */
  runControls(): HTMLElement | null
  /** The summary slot's heading. */
  summaryHeading(): HTMLElement | null
  /** The first field of the inspector's current tab. */
  inspectorField(): HTMLElement | null
  /** The inspector's tab list. */
  inspectorTabs(): HTMLElement | null
  /** The empty state's or toolbar's Add files button. */
  addFiles(): HTMLElement | null
  /** The acknowledgment checkbox that gates the primary action. */
  acknowledgment(): HTMLElement | null
  /** The view root, the last resort, so focus never falls to the document body. */
  view(): HTMLElement | null
}

/** A moment of the page that moves focus, with the facts its destination needs. */
export type FocusMoment =
  | { kind: 'open-view'; lastRow: string | null; queueEmpty: boolean }
  | { kind: 'added'; firstId: string | null }
  | { kind: 'rows-arrived'; firstId: string }
  | { kind: 'removed'; order: readonly string[]; removed: readonly string[]; focused: string | null }
  | { kind: 'stay' }
  | { kind: 'inspector-field' }
  | { kind: 'row'; id: string | null }
  | { kind: 'acknowledgment' }
  | { kind: 'action-slot' }
  | { kind: 'confirm-closed'; opener: HTMLElement | null }
  | { kind: 'acknowledged-inspector'; nextId: string | null }
  | { kind: 'summary-heading' }
  | { kind: 'group-emptied'; nextButton: HTMLElement | null }
  | { kind: 'trigger'; trigger: HTMLElement | null }

function hiddenByStyle(element: Element): boolean
{
  if (!(element instanceof HTMLElement))
  {
    return false
  }
  if (element.style.display === 'none' || element.style.visibility === 'hidden')
  {
    return true
  }
  const view = element.ownerDocument.defaultView
  if (view === null)
  {
    return false
  }
  const style = view.getComputedStyle(element)
  return style.display === 'none' || style.visibility === 'hidden'
}

/**
 * True while an element is in the document and shown: not inside a `hidden` or `inert` ancestor, and no ancestor
 * is styled out with `display: none`, which is how the shell hides the views it keeps mounted.
 */
export function isShown(element: Element | null | undefined): element is HTMLElement
{
  if (element === null || element === undefined || !element.isConnected)
  {
    return false
  }
  for (let node: Element | null = element; node !== null; node = node.parentElement)
  {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert') || hiddenByStyle(node))
    {
      return false
    }
  }
  return true
}

/** True when an element can take focus now: shown, enabled, and not removed. */
export function canFocus(element: Element | null | undefined): element is HTMLElement
{
  return isShown(element) && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true'
}

/** True when focus has fallen to nothing: the document body, the root element, or no element at all. */
export function focusIsLost(doc: Document = document): boolean
{
  const active = doc.activeElement
  return active === null || active === doc.body || active === doc.documentElement
}

function resolveTarget(target: FocusTarget): HTMLElement | null
{
  const element = typeof target === 'function' ? target() : target
  return element ?? null
}

/** Focuses the first target that can take focus and keeps it; returns the element focused, or null. */
export function focusFirst(targets: readonly FocusTarget[]): HTMLElement | null
{
  for (const target of targets)
  {
    const element = resolveTarget(target)
    if (!canFocus(element))
    {
      continue
    }
    element.focus()
    if (element.ownerDocument.activeElement === element)
    {
      return element
    }
  }
  return null
}

/**
 * The row focus moves to when rows leave the table: the focused row itself while it stays, else the next remaining
 * row after it, else the previous one at the end; null when no row remains. A focused row outside `order` reads
 * as the first removed row.
 */
export function nearestRemaining(order: readonly string[], removed: readonly string[], focused: string | null): string | null
{
  const gone = new Set(removed)
  if (focused !== null && order.includes(focused) && !gone.has(focused))
  {
    return focused
  }
  const anchorId = focused !== null && order.includes(focused) ? focused : order.find((id) => gone.has(id))
  const anchor = anchorId === undefined ? -1 : order.indexOf(anchorId)
  if (anchor < 0)
  {
    return order.find((id) => !gone.has(id)) ?? null
  }
  for (let index = anchor + 1; index < order.length; index += 1)
  {
    if (!gone.has(order[index]))
    {
      return order[index]
    }
  }
  for (let index = anchor - 1; index >= 0; index -= 1)
  {
    if (!gone.has(order[index]))
    {
      return order[index]
    }
  }
  return null
}

/**
 * Where focus goes at a moment, in order of preference. Every chain ends on the table's focused row, the grid, and
 * the view root, so a control that removes itself never leaves focus on the document body.
 */
export function focusChain(moment: FocusMoment, targets: FocusTargets): FocusTarget[]
{
  const fallback: FocusTarget[] = [() => targets.focusedRow(), () => targets.table(), () => targets.view()]
  const rowOf = (id: string | null): FocusTarget => () => id === null ? null : targets.row(id)
  switch (moment.kind)
  {
    case 'open-view':
      return moment.queueEmpty
        ? [() => targets.addFiles(), ...fallback]
        : [rowOf(moment.lastRow), ...fallback, () => targets.addFiles()]
    case 'added':
      return [rowOf(moment.firstId), ...fallback]
    case 'rows-arrived':
      return [rowOf(moment.firstId), ...fallback]
    case 'removed':
      return [rowOf(nearestRemaining(moment.order, moment.removed, moment.focused)), ...fallback]
    case 'stay':
      return [() => document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null, ...fallback]
    case 'inspector-field':
      return [() => targets.inspectorField(), () => targets.inspectorTabs(), ...fallback]
    case 'row':
      return [rowOf(moment.id), ...fallback]
    case 'acknowledgment':
      return [() => targets.acknowledgment(), () => targets.actionSlot(), ...fallback]
    case 'action-slot':
      return [() => targets.actionSlot(), () => targets.runControls(), ...fallback]
    case 'confirm-closed':
      return [moment.opener, () => targets.actionSlot(), () => targets.runControls(), ...fallback]
    case 'acknowledged-inspector':
      return [rowOf(moment.nextId), () => targets.inspectorTabs(), ...fallback]
    case 'summary-heading':
      return [() => targets.summaryHeading(), ...fallback]
    case 'group-emptied':
      return [moment.nextButton, () => targets.summaryHeading(), ...fallback]
    case 'trigger':
      return [moment.trigger, ...fallback]
    default:
      return fallback
  }
}

/** Moves focus to a moment's destination; returns the element that took focus, or null. */
export function moveFocus(moment: FocusMoment, targets: FocusTargets): HTMLElement | null
{
  return focusFirst(focusChain(moment, targets))
}

/** The F6 region an element sits in, read from the nearest `data-region` ancestor. */
export function regionOf(element: Element | null): string | null
{
  return element?.closest<HTMLElement>('[data-region]')?.dataset.region ?? null
}

/**
 * Where focus goes when the focused control removed itself, by the region it was in: the header's stable action
 * slots, the summary heading, or the inspector's tab list, and then the table's focused row.
 */
export function rescueChain(region: string | null, targets: FocusTargets): FocusTarget[]
{
  const fallback: FocusTarget[] = [() => targets.focusedRow(), () => targets.table(), () => targets.view()]
  switch (region)
  {
    case 'header':
      return [() => targets.actionSlot(), () => targets.runControls(), ...fallback]
    case 'summary':
      return [() => targets.summaryHeading(), ...fallback]
    case 'inspector':
      return [() => targets.inspectorTabs(), ...fallback]
    default:
      return fallback
  }
}

/** What the rescue saw when the focused control went away. */
export interface LostFocus
{
  element: HTMLElement
  region: string | null
}

/**
 * Keeps focus off the document body inside a view: when the focused element is removed, hidden, or disabled and
 * focus falls to the body, focus moves to the destination `chain` names for it (by default {@link rescueChain}).
 * A deliberate blur, such as a click on empty space or the window losing focus, is left alone.
 */
export function useFocusRescue(
  rootRef: RefObject<HTMLElement | null>,
  targets: FocusTargets,
  chain: (lost: LostFocus, targets: FocusTargets) => FocusTarget[] = (lost, all) => rescueChain(lost.region, all)
): void
{
  const latest = useRef({ targets, chain })
  latest.current = { targets, chain }
  useEffect(() =>
  {
    const root = rootRef.current
    if (root === null)
    {
      return undefined
    }
    let last: LostFocus | null = null
    const rescue = (): void =>
    {
      if (last === null || canFocus(last.element) || !focusIsLost(root.ownerDocument))
      {
        return
      }
      const lost = last
      last = null
      if (isShown(root))
      {
        focusFirst(latest.current.chain(lost, latest.current.targets))
      }
    }
    const onFocusIn = (event: FocusEvent): void =>
    {
      if (event.target instanceof HTMLElement)
      {
        last = { element: event.target, region: regionOf(event.target) }
      }
    }
    const onFocusOut = (event: FocusEvent): void =>
    {
      const element = event.target
      if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget))
      {
        last = null
        return
      }
      if (event.relatedTarget !== null || !(element instanceof HTMLElement))
      {
        return
      }
      queueMicrotask(() =>
      {
        if (last?.element === element && canFocus(element))
        {
          last = null
        }
        else
        {
          rescue()
        }
      })
    }
    const observer = new MutationObserver(rescue)
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'inert'] })
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)
    return () =>
    {
      observer.disconnect()
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
    }
  }, [rootRef])
}

/**
 * Moves focus into a view the shell keeps mounted each time the shell shows it,
 * unless focus is already inside the view, as after a notification click landed on a job.
 */
export function useFocusOnShow(view: View, rootRef: RefObject<HTMLElement | null>, moment: () => FocusMoment, targets: FocusTargets): void
{
  const latest = useRef({ moment, targets })
  latest.current = { moment, targets }
  useEffect(() =>
  {
    let frame = 0
    const unsubscribe = useAppStore.subscribe((next, previous) =>
    {
      if (next.currentView !== view || previous.currentView === view)
      {
        return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
      {
        const root = rootRef.current
        if (root !== null && isShown(root) && !root.contains(root.ownerDocument.activeElement))
        {
          moveFocus(latest.current.moment(), latest.current.targets)
        }
      })
    })
    return () =>
    {
      cancelAnimationFrame(frame)
      unsubscribe()
    }
  }, [rootRef, view])
}
