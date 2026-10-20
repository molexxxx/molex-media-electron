/**
 * @module hooks/useF6Region
 * @description Registry behind the shell's F6 cycle: the rail, then the
 * regions the visible view registers in order (one work-area stop when it
 * registers none), then notifications when that region is not empty.
 * Nothing here binds a key; the shell calls {@link focusNextRegion}.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useAppStore } from '../stores/appStore'
import type { View } from '../stores/types'

/** A named region a view offers to the F6 cycle. */
export interface F6Region
{
  name: string
  ref: RefObject<HTMLElement | null>
}

/** The shell's own stops around a view's regions. */
export type ShellStopKind = 'rail' | 'work' | 'notifications'

/** Overrides for how a shell stop is entered and when it counts. */
export interface ShellStopOptions
{
  /** Moves focus into the stop, for example onto the newest toast. */
  focus?: (element: HTMLElement) => void
  /** Reports an empty notifications region, which the cycle then skips. */
  isEmpty?: (element: HTMLElement) => boolean
}

/** One stop of the F6 cycle. */
export interface F6Stop
{
  id: string
  kind: ShellStopKind | 'region'
  element: HTMLElement
  view?: View
  name?: string
}

/** F6 moves to the next stop and Shift+F6 to the previous one. */
export type F6Direction = 'next' | 'previous'

interface ViewEntry
{
  view: View
  read: () => readonly F6Region[]
}

interface ShellEntry
{
  element: HTMLElement
  read: () => ShellStopOptions
}

/** Landmarks that stand in for a shell stop nobody registered. */
const SHELL_LANDMARKS: Record<ShellStopKind, string> = {
  rail: 'nav',
  work: 'main',
  notifications: '[role="region"][aria-label="Notifications"]'
}

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]'

const viewEntries = new Set<ViewEntry>()
const shellEntries = new Map<ShellStopKind, ShellEntry>()

function displayed(element: HTMLElement): boolean
{
  if (typeof element.checkVisibility === 'function')
  {
    return element.checkVisibility()
  }
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
  {
    if (getComputedStyle(node).display === 'none')
    {
      return false
    }
  }
  return true
}

function usable(element: HTMLElement | null | undefined): element is HTMLElement
{
  return !!element && element.isConnected && element.closest('[hidden], [inert]') === null && displayed(element)
}

function documentOrder(a: HTMLElement, b: HTMLElement): number
{
  if (a === b)
  {
    return 0
  }
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
}

function shellElement(kind: ShellStopKind): HTMLElement | null
{
  const entry = shellEntries.get(kind)
  if (entry)
  {
    return usable(entry.element) ? entry.element : null
  }
  const landmark = document.querySelector<HTMLElement>(SHELL_LANDMARKS[kind])
  return usable(landmark) ? landmark : null
}

function shellOptions(kind: ShellStopKind): ShellStopOptions
{
  return shellEntries.get(kind)?.read() ?? {}
}

function viewRegions(view: View): F6Stop[]
{
  const groups: F6Stop[][] = []
  for (const entry of viewEntries)
  {
    if (entry.view !== view)
    {
      continue
    }
    const group: F6Stop[] = []
    for (const region of entry.read())
    {
      const element = region.ref.current
      if (usable(element))
      {
        group.push({ id: `${view}:${region.name}`, kind: 'region', element, view, name: region.name })
      }
    }
    if (group.length > 0)
    {
      groups.push(group)
    }
  }
  groups.sort((a, b) => documentOrder(a[0].element, b[0].element))
  return groups.flat()
}

function isEmptyRegion(element: HTMLElement): boolean
{
  const check = shellOptions('notifications').isEmpty
  return check ? check(element) : element.querySelector(FOCUSABLE) === null
}

/** Registers a view's regions in order; returns the function that removes them. */
export function registerF6Regions(view: View, regions: readonly F6Region[] | (() => readonly F6Region[])): () => void
{
  const entry: ViewEntry = { view, read: typeof regions === 'function' ? regions : () => regions }
  viewEntries.add(entry)
  return () =>
  {
    viewEntries.delete(entry)
  }
}

/**
 * Registers the element behind a shell stop in place of its landmark
 * (`nav`, `main`, or the Notifications region); returns the function that
 * removes it.
 */
export function registerShellStop(
  kind: ShellStopKind,
  element: HTMLElement,
  options: ShellStopOptions | (() => ShellStopOptions) = {}
): () => void
{
  const entry: ShellEntry = { element, read: typeof options === 'function' ? options : () => options }
  shellEntries.set(kind, entry)
  return () =>
  {
    if (shellEntries.get(kind) === entry)
    {
      shellEntries.delete(kind)
    }
  }
}

/**
 * The stops of the F6 cycle in order: the rail, the visible view's regions
 * (or one work-area stop when it registers none), then notifications when
 * that region is not empty.
 */
export function f6Order(): F6Stop[]
{
  const stops: F6Stop[] = []
  const rail = shellElement('rail')
  if (rail)
  {
    stops.push({ id: 'rail', kind: 'rail', element: rail })
  }
  const regions = viewRegions(useAppStore.getState().currentView)
  if (regions.length > 0)
  {
    stops.push(...regions)
  }
  else
  {
    const work = shellElement('work')
    if (work)
    {
      stops.push({ id: 'work', kind: 'work', element: work })
    }
  }
  const notifications = shellElement('notifications')
  if (notifications && !isEmptyRegion(notifications))
  {
    stops.push({ id: 'notifications', kind: 'notifications', element: notifications })
  }
  return stops
}

const remembered = new WeakMap<HTMLElement, HTMLElement>()
let lastEntered: HTMLElement | null = null
let origin: HTMLElement | null = null

function activeElement(): HTMLElement | null
{
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body && active.isConnected ? active : null
}

function containingStop(stops: F6Stop[], active: HTMLElement | null): number
{
  let found = -1
  if (!active)
  {
    return found
  }
  stops.forEach((stop, index) =>
  {
    if (stop.element.contains(active) && (found < 0 || stops[found].element.contains(stop.element)))
    {
      found = index
    }
  })
  return found
}

function stopAround(stops: F6Stop[], active: HTMLElement | null, direction: F6Direction): number
{
  if (direction === 'next')
  {
    const after = active ? stops.findIndex((stop) => documentOrder(active, stop.element) < 0) : -1
    return after >= 0 ? after : 0
  }
  for (let index = stops.length - 1; active && index >= 0; index--)
  {
    if (documentOrder(stops[index].element, active) < 0)
    {
      return index
    }
  }
  return stops.length - 1
}

function firstFocusable(container: HTMLElement, selector: string): HTMLElement | null
{
  const candidates = Array.from(container.querySelectorAll<HTMLElement>(selector))
  return candidates.find((candidate) => candidate.tabIndex >= 0 && !candidate.matches(':disabled') && usable(candidate)) ?? null
}

function newestToast(container: HTMLElement): HTMLElement | null
{
  const toasts = Array.from(container.querySelectorAll<HTMLElement>('[tabindex="-1"]')).filter((toast) => usable(toast))
  return toasts.length > 0 ? toasts[toasts.length - 1] : null
}

function entryPoint(stop: F6Stop): HTMLElement
{
  const toast = stop.kind === 'notifications' ? newestToast(stop.element) : null
  if (toast)
  {
    return toast
  }
  const last = remembered.get(stop.element)
  if (last && last !== stop.element && stop.element.contains(last) && usable(last))
  {
    return last
  }
  const target = firstFocusable(stop.element, '[aria-current="page"]') ?? firstFocusable(stop.element, FOCUSABLE)
  if (target)
  {
    return target
  }
  if (!stop.element.hasAttribute('tabindex'))
  {
    stop.element.tabIndex = -1
  }
  return stop.element
}

function enter(stop: F6Stop): void
{
  const custom = stop.kind === 'region' ? undefined : shellOptions(stop.kind).focus
  if (custom)
  {
    custom(stop.element)
    return
  }
  entryPoint(stop).focus()
}

/**
 * Moves focus to the next or previous stop of the F6 cycle, wrapping at
 * either end, and returns the stop entered (null when there is none). A
 * stop is entered at the element last focused in it, else its current page
 * item, else its first focusable element, else the stop itself; the
 * notifications stop is entered at its newest toast.
 */
export function focusNextRegion(direction: F6Direction = 'next'): F6Stop | null
{
  const stops = f6Order()
  if (stops.length === 0)
  {
    return null
  }
  const active = activeElement()
  const index = containingStop(stops, active)
  if (index >= 0 && active && active !== stops[index].element)
  {
    remembered.set(stops[index].element, active)
  }
  if (active !== lastEntered)
  {
    origin = active
  }
  const step = direction === 'next' ? 1 : -1
  const target = index >= 0 ? (index + step + stops.length) % stops.length : stopAround(stops, active, direction)
  const stop = stops[target]
  enter(stop)
  lastEntered = activeElement()
  return stop
}

/**
 * The element that had focus before the current run of F6 presses, while it
 * is still in the document; the notifications region returns focus there
 * when its last toast is dismissed.
 */
export function f6ReturnTarget(): HTMLElement | null
{
  return origin && origin.isConnected ? origin : null
}

/**
 * Registers a view's named regions, in order, while the calling component is
 * mounted. They count only while that view is the visible one.
 */
export function useF6Region(view: View, regions: readonly F6Region[]): void
{
  const latest = useRef(regions)
  useLayoutEffect(() =>
  {
    latest.current = regions
  })
  useEffect(() => registerF6Regions(view, () => latest.current), [view])
}

/** Registers the element behind a shell stop while the calling component is mounted. */
export function useShellStop(kind: ShellStopKind, ref: RefObject<HTMLElement | null>, options: ShellStopOptions = {}): void
{
  const latest = useRef(options)
  useLayoutEffect(() =>
  {
    latest.current = options
  })
  useEffect(() =>
  {
    const element = ref.current
    return element ? registerShellStop(kind, element, () => latest.current) : undefined
  }, [kind, ref])
}
