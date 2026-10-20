/**
 * @module hooks/useAppZoomKeys
 * @description Page zoom from the keyboard in every window: Ctrl+Plus and
 * Ctrl+= zoom in, Ctrl+Minus zooms out (0.5 Chromium levels a step, the
 * preload's step), and Ctrl+0 returns to the Interface size setting. A key
 * another handler already claimed, such as the visible editor timeline's
 * own zoom, is left alone.
 */

import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

/** What a zoom key asks for. */
export type AppZoomCommand = 'in' | 'out' | 'reset'

/** The default Interface size in percent, used before the config has loaded. */
export const DEFAULT_INTERFACE_SCALE = 100

type ZoomKeyEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>

/** The zoom command of a key press (Ctrl, or Cmd on macOS, without Alt), or null for any other key. */
export function appZoomCommand(event: ZoomKeyEvent): AppZoomCommand | null
{
  if (!(event.ctrlKey || event.metaKey) || event.altKey)
  {
    return null
  }
  switch (event.key)
  {
    case '+':
    case '=':
      return 'in'
    case '-':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}

/** The zoom factor of an Interface size in percent; anything unusable is 100 percent. */
export function interfaceZoomFactor(interfaceScale: unknown): number
{
  return typeof interfaceScale === 'number' && Number.isFinite(interfaceScale) && interfaceScale > 0
    ? interfaceScale / 100
    : DEFAULT_INTERFACE_SCALE / 100
}

/**
 * Applies a zoom command to this window's page through the bridge and returns the factor applied.
 * Reset uses `interfaceScale` (percent).
 */
export function applyAppZoom(command: AppZoomCommand, interfaceScale: unknown): number
{
  if (command === 'in')
  {
    return window.api.zoomIn()
  }
  if (command === 'out')
  {
    return window.api.zoomOut()
  }
  return window.api.setZoomFactor(interfaceZoomFactor(interfaceScale))
}

/**
 * Calls `handler` for each keydown that reaches the window unclaimed, after every other keydown listener,
 * returning the function that stops listening. Listeners added to the window by views mounted later
 * would otherwise run after a shell listener added at startup, so the check of `defaultPrevented` waits
 * for them: a capture listener queues one bubble listener per event, which the event invokes last.
 */
export function listenUnclaimedKeys(handler: (event: KeyboardEvent) => void, target: Window = window): () => void
{
  let pending: ((event: Event) => void) | null = null
  const drop = (): void =>
  {
    if (pending)
    {
      target.removeEventListener('keydown', pending)
      pending = null
    }
  }
  const arm = (event: Event): void =>
  {
    drop()
    const late = (next: Event): void =>
    {
      drop()
      if (next === event && !next.defaultPrevented)
      {
        handler(next as KeyboardEvent)
      }
    }
    pending = late
    target.addEventListener('keydown', late)
  }
  target.addEventListener('keydown', arm, true)
  return () =>
  {
    target.removeEventListener('keydown', arm, true)
    drop()
  }
}

/** Binds the zoom keys for this window while the calling component is mounted. */
export function useAppZoomKeys(): void
{
  useEffect(() => listenUnclaimedKeys((event) =>
  {
    const command = appZoomCommand(event)
    if (!command)
    {
      return
    }
    event.preventDefault()
    applyAppZoom(command, useAppStore.getState().config?.interfaceScale)
  }), [])
}
