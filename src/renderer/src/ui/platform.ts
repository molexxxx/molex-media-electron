/**
 * The one place primitives touch top-layer and media platform APIs, so tests can shim them. Open state
 * lives in React; nothing here queries `:popover-open`, which jsdom's selector engine cannot parse.
 */
import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** Rethrows anything but the InvalidStateError a platform call raises for a request it already satisfies. */
function ignoreSettledState(run: () => void): void
{
  try
  {
    run()
  }
  catch (error)
  {
    if (!(error instanceof DOMException && error.name === 'InvalidStateError'))
    {
      throw error
    }
  }
}

/** Opens a dialog as a modal in the top layer; a no-op while it is open or outside the document. */
export function showModal(dialog: HTMLDialogElement): void
{
  if (dialog.open || !dialog.isConnected)
  {
    return
  }
  dialog.showModal()
}

/** Closes a dialog, passing `returnValue` on; a no-op while it is closed. */
export function closeDialog(dialog: HTMLDialogElement, returnValue?: string): void
{
  if (!dialog.open)
  {
    return
  }
  dialog.close(returnValue)
}

/** Shows a popover element; a no-op outside the document or when it already shows. */
export function showPopover(element: HTMLElement): void
{
  if (!element.isConnected)
  {
    return
  }
  ignoreSettledState(() => element.showPopover())
}

/** Hides a popover element; a no-op outside the document or when it is already hidden. */
export function hidePopover(element: HTMLElement): void
{
  if (!element.isConnected)
  {
    return
  }
  ignoreSettledState(() => element.hidePopover())
}

/** True when the system asks for reduced motion (on Windows, the animation effects setting). */
export function prefersReducedMotion(): boolean
{
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** Calls `listener` when the reduced-motion preference changes; returns the unsubscribe function. */
export function subscribeReducedMotion(listener: () => void): () => void
{
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** The reduced-motion preference, kept current while the component is mounted. */
export function useReducedMotion(): boolean
{
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion)
}

/** Runs `callback` on the next animation frame; returns a function that cancels it. */
export function nextFrame(callback: () => void): () => void
{
  const id = window.requestAnimationFrame(() => callback())
  return () => window.cancelAnimationFrame(id)
}
