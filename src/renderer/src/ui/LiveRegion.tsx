import { createContext, useCallback, useContext, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { nextFrame } from './platform'

/** Speaks a message through the nearest {@link LiveRegion}. */
export type Announce = (text: string) => void

/** Messages closer together than this coalesce, and the last one wins. */
export const ANNOUNCE_COALESCE_MS = 500

const AnnounceContext = createContext<Announce>(() => {})

/**
 * The polite live region of one view root, empty at mount, with {@link useAnnounce} for its descendants.
 * An announcement clears the region and sets the text on the next frame, so a repeated message is spoken
 * again; messages within {@link ANNOUNCE_COALESCE_MS} of the last one spoken wait and coalesce. A view
 * hidden with `display: none` takes its region out of the accessibility tree, so a hidden view never speaks.
 */
export function LiveRegion({ children }: { children?: ReactNode }): ReactElement
{
  const regionRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef('')
  const lastSpokenRef = useRef(Number.NEGATIVE_INFINITY)
  const scheduledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelFrameRef = useRef<(() => void) | undefined>(undefined)

  useEffect(() =>
  {
    return () =>
    {
      clearTimeout(timerRef.current)
      cancelFrameRef.current?.()
    }
  }, [])

  const announce = useCallback<Announce>((text) =>
  {
    const region = regionRef.current
    if (!region)
    {
      return
    }
    pendingRef.current = text
    if (scheduledRef.current)
    {
      return
    }
    scheduledRef.current = true
    region.textContent = ''
    const speak = (): void =>
    {
      cancelFrameRef.current = nextFrame(() =>
      {
        scheduledRef.current = false
        lastSpokenRef.current = Date.now()
        region.textContent = pendingRef.current
      })
    }
    const wait = lastSpokenRef.current + ANNOUNCE_COALESCE_MS - Date.now()
    if (wait > 0)
    {
      timerRef.current = setTimeout(speak, wait)
    }
    else
    {
      speak()
    }
  }, [])

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div ref={regionRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only select-none" />
    </AnnounceContext.Provider>
  )
}

/** The announce function of the nearest {@link LiveRegion}; outside one it does nothing. */
export function useAnnounce(): Announce
{
  return useContext(AnnounceContext)
}
