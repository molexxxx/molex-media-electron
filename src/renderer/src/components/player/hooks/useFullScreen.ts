/**
 * Full screen for the Player, the way a media player does it: the window goes full screen through main, whose
 * enter and leave events are the one source of truth (so the state is right however it was entered or left), the
 * shell hides and the stage fills the window, and the toolbar and transport fade away with the pointer after a
 * short still spell, coming back on movement or a key.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '../../../stores/appStore'

/** How long the pointer stays still before the controls and the cursor hide, in ms. */
export const HIDE_AFTER_MS = 2000

/** What the hook reads and does. */
export interface FullScreenState
{
  on: boolean
  /** True while the controls are hidden in full screen. */
  idle: boolean
  toggle(): void
  exit(): void
}

/** The window's full screen state, kept by main and mirrored in the app store, and the controls' idle state. */
export function useFullScreen(root: RefObject<HTMLElement | null>, hideAfterMs: number = HIDE_AFTER_MS): FullScreenState
{
  const on = useAppStore((state) => state.fullscreen)
  const setStore = useAppStore((state) => state.setFullscreen)
  const [idle, setIdle] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() =>
  {
    let alive = true
    void window.api.isFullScreen?.().then((value) =>
    {
      if (alive)
      {
        setStore(value)
      }
    }).catch(() => undefined)
    const stop = window.api.onFullScreenChanged?.((value) => setStore(value))
    return () =>
    {
      alive = false
      stop?.()
    }
  }, [setStore])

  useEffect(() =>
  {
    const element = root.current
    if (!on || element === null)
    {
      setIdle(false)
      return undefined
    }
    const arm = (): void =>
    {
      if (timer.current !== null)
      {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => setIdle(true), hideAfterMs)
    }
    const wake = (): void =>
    {
      setIdle(false)
      arm()
    }
    const hold = (): void =>
    {
      if (timer.current !== null)
      {
        clearTimeout(timer.current)
        timer.current = null
      }
      setIdle(false)
    }
    arm()
    element.addEventListener('pointermove', wake)
    element.addEventListener('pointerdown', wake)
    element.ownerDocument.addEventListener('keydown', wake)
    element.addEventListener('focusin', hold)
    return () =>
    {
      if (timer.current !== null)
      {
        clearTimeout(timer.current)
        timer.current = null
      }
      element.removeEventListener('pointermove', wake)
      element.removeEventListener('pointerdown', wake)
      element.ownerDocument.removeEventListener('keydown', wake)
      element.removeEventListener('focusin', hold)
    }
  }, [on, root, hideAfterMs])

  const set = useCallback((value: boolean): void =>
  {
    void window.api.setFullScreen?.(value).then((reported) => setStore(reported)).catch(() => undefined)
  }, [setStore])

  const toggle = useCallback((): void => set(!on), [on, set])
  const exit = useCallback((): void => set(false), [set])

  return { on, idle, toggle, exit }
}
