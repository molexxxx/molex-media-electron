import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type Ref,
  type RefObject,
  type TransitionEvent
} from 'react'
import { flushSync } from 'react-dom'
import { Button } from './Button'
import { cx } from './cx'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import type { IconName } from './icons'
import { ANNOUNCE_COALESCE_MS, useAnnounce, type Announce } from './LiveRegion'
import { nextFrame, useReducedMotion } from './platform'

/** A toast's tone, which picks its icon, its ink, and how long it stays. */
export type ToastTone = 'info' | 'success' | 'warning' | 'error'

/** The live region that speaks a toast; `assertive` is kept for run-blocking errors. */
export type ToastAnnounce = 'polite' | 'assertive' | 'none'

/** A button on a toast. Activating it leaves the toast up; its handler may dismiss it. */
export interface ToastAction
{
  label: string
  onAction(): void
}

/** What {@link ToastApi.show} puts on screen. */
export interface ToastOptions
{
  tone: ToastTone
  /** One sentence; it is also the text the region speaks. */
  title: string
  body?: string
  actions?: ToastAction[]
  /** The job the toast is about, exposed as `data-job-id`. */
  jobId?: string
  /** Coalesces repeats: a show with the key of a shown toast updates that toast, such as `returned:<runId>`. */
  key?: string
  /** `polite` by default. */
  announce?: ToastAnnounce
}

/** The parts of a shown toast that {@link ToastApi.update} changes in place. */
export type ToastPatch = Partial<Pick<ToastOptions, 'title' | 'body' | 'actions'>>

/** A toast in the stack. */
export interface ToastRecord extends ToastOptions
{
  id: string
  /** Creation order, newest highest. */
  seq: number
  /** Counts updates; each one restarts the toast's dismiss timer. */
  revision: number
}

/** Shows, updates, and dismisses toasts from anywhere in the renderer. */
export interface ToastApi
{
  /** Shows a toast, or updates the shown toast with the same `key`, and returns its id. */
  show(options: ToastOptions): string
  /** Changes a shown toast's title, body, or actions in place; a new title speaks again at most every {@link TOAST_REANNOUNCE_MS}. */
  update(id: string, patch: ToastPatch): void
  dismiss(id: string): void
}

/** Info and success toasts dismiss after this long. */
export const TOAST_INFO_MS = 6000

/** Warning toasts dismiss after this long. */
export const TOAST_WARNING_MS = 10_000

/** Toasts drawn at once; older ones fold into a "+N more" line. */
export const TOAST_VISIBLE_LIMIT = 3

/** An updated toast speaks its new title at most this often, so a burst of returns reads as one sentence. */
export const TOAST_REANNOUNCE_MS = 5000

type LiveChannel = 'polite' | 'assertive'
type Speak = (channel: LiveChannel, text: string) => void

let stack: readonly ToastRecord[] = []
let lastSeq = 0
let speaker: Speak | null = null
const listeners = new Set<() => void>()
const spokenAt = new Map<string, number>()
const respeakTimers = new Map<string, ReturnType<typeof setTimeout>>()

function subscribe(listener: () => void): () => void
{
  listeners.add(listener)
  return () =>
  {
    listeners.delete(listener)
  }
}

function getStack(): readonly ToastRecord[]
{
  return stack
}

function getCount(): number
{
  return stack.length
}

function commit(next: readonly ToastRecord[]): void
{
  stack = next
  for (const listener of [...listeners])
  {
    listener()
  }
}

function speak(toast: ToastRecord): void
{
  const channel = toast.announce ?? 'polite'
  if (channel === 'none')
  {
    return
  }
  spokenAt.set(toast.id, Date.now())
  speaker?.(channel, toast.title)
}

function speakAgain(toast: ToastRecord): void
{
  if (respeakTimers.has(toast.id))
  {
    return
  }
  const wait = (spokenAt.get(toast.id) ?? Number.NEGATIVE_INFINITY) + TOAST_REANNOUNCE_MS - Date.now()
  if (wait <= 0)
  {
    speak(toast)
    return
  }
  respeakTimers.set(toast.id, setTimeout(() =>
  {
    respeakTimers.delete(toast.id)
    const current = stack.find((item) => item.id === toast.id)
    if (current)
    {
      speak(current)
    }
  }, wait))
}

function forget(id: string): void
{
  clearTimeout(respeakTimers.get(id))
  respeakTimers.delete(id)
  spokenAt.delete(id)
}

function show(options: ToastOptions): string
{
  const existing = options.key === undefined ? undefined : stack.find((toast) => toast.key === options.key)
  if (existing)
  {
    const next: ToastRecord = { ...options, id: existing.id, seq: existing.seq, revision: existing.revision + 1 }
    commit(stack.map((toast) => (toast.id === existing.id ? next : toast)))
    if (next.title !== existing.title)
    {
      speakAgain(next)
    }
    return existing.id
  }
  lastSeq += 1
  const toast: ToastRecord = { ...options, id: `toast-${lastSeq}`, seq: lastSeq, revision: 0 }
  commit([...stack, toast])
  speak(toast)
  return toast.id
}

function update(id: string, patch: ToastPatch): void
{
  const existing = stack.find((toast) => toast.id === id)
  if (!existing)
  {
    return
  }
  const next: ToastRecord = { ...existing, ...patch, revision: existing.revision + 1 }
  commit(stack.map((toast) => (toast.id === id ? next : toast)))
  if (next.title !== existing.title)
  {
    speakAgain(next)
  }
}

function dismiss(id: string): void
{
  if (!stack.some((toast) => toast.id === id))
  {
    return
  }
  forget(id)
  commit(stack.filter((toast) => toast.id !== id))
}

/** The toast functions for code outside components, such as IPC listeners; the same object {@link useToast} returns. */
export const toast: ToastApi = { show, update, dismiss }

/** The toast functions. The stack lives outside React, so any view can show a toast in the shell's one region. */
export function useToast(): ToastApi
{
  return toast
}

/** The number of toasts in the stack; the shell's F6 cycle skips the region while it is 0. */
export function useToastCount(): number
{
  return useSyncExternalStore(subscribe, getCount)
}

/** Removes every toast and drops pending announcements. */
export function clearToasts(): void
{
  for (const timer of respeakTimers.values())
  {
    clearTimeout(timer)
  }
  respeakTimers.clear()
  spokenAt.clear()
  commit([])
}

/**
 * How long a toast stays, or null when it persists until dismissed: errors persist; warnings and toasts with
 * actions, such as Undo, which Ctrl+Z also reaches, stay for the longer warning time.
 */
export function toastLifetime(toast: Pick<ToastOptions, 'tone' | 'actions'>): number | null
{
  if (toast.tone === 'error')
  {
    return null
  }
  return toast.tone === 'warning' || (toast.actions?.length ?? 0) > 0 ? TOAST_WARNING_MS : TOAST_INFO_MS
}

interface Speaker
{
  say(text: string): void
  cancel(): void
}

/** Speaks through one live region element: clears it, then sets the text a frame later; texts within the coalescing window join. */
function createSpeaker(element: HTMLElement): Speaker
{
  let pending: string[] = []
  let scheduled = false
  let lastSpokenAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelFrame: (() => void) | undefined
  const flush = (): void =>
  {
    cancelFrame = nextFrame(() =>
    {
      scheduled = false
      lastSpokenAt = Date.now()
      element.textContent = pending.join(' ')
      pending = []
    })
  }
  return {
    say(text)
    {
      if (!pending.includes(text))
      {
        pending.push(text)
      }
      if (scheduled)
      {
        return
      }
      scheduled = true
      element.textContent = ''
      const wait = lastSpokenAt + ANNOUNCE_COALESCE_MS - Date.now()
      if (wait > 0)
      {
        timer = setTimeout(flush, wait)
      }
      else
      {
        flush()
      }
    },
    cancel()
    {
      clearTimeout(timer)
      cancelFrame?.()
      pending = []
      scheduled = false
    }
  }
}

const TONE_ICON: Record<ToastTone, IconName> = {
  info: 'action.info',
  success: 'status.done',
  warning: 'status.warning',
  error: 'status.failed'
}

const TONE_INK: Record<ToastTone, string> = {
  info: 'text-running',
  success: 'text-verified',
  warning: 'text-warning',
  error: 'text-error'
}

interface ToastItemProps
{
  toast: ToastRecord
  leaving: boolean
  onClose(id: string): void
  onLeft(id: string): void
}

/** Dismisses a toast when its lifetime runs out, counting only while unpaused; an update starts it over. */
function ToastClock({ toast, paused }: { toast: ToastRecord, paused: boolean }): null
{
  const lifetime = toastLifetime(toast)
  const remainingRef = useRef(lifetime)

  useEffect(() =>
  {
    remainingRef.current = lifetime
  }, [lifetime, toast.revision])

  useEffect(() =>
  {
    const remaining = remainingRef.current
    if (remaining === null || paused)
    {
      return
    }
    const startedAt = Date.now()
    const timer = setTimeout(() => dismiss(toast.id), remaining)
    return () =>
    {
      clearTimeout(timer)
      remainingRef.current = remaining - (Date.now() - startedAt)
    }
  }, [lifetime, paused, toast.id, toast.revision])

  return null
}

function ToastItem({ toast, leaving, onClose, onLeft }: ToastItemProps): ReactElement
{
  const titleId = useId()
  const bodyId = useId()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void =>
  {
    if (event.key !== 'Escape' || event.defaultPrevented)
    {
      return
    }
    event.preventDefault()
    onClose(toast.id)
  }

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void =>
  {
    if (leaving && event.target === event.currentTarget)
    {
      onLeft(toast.id)
    }
  }

  const actions = toast.actions ?? []
  return (
    <div
      role="group"
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={toast.body ? bodyId : undefined}
      aria-hidden={leaving || undefined}
      inert={leaving}
      data-toast-id={toast.id}
      data-tone={toast.tone}
      data-job-id={toast.jobId}
      data-leaving={leaving ? '' : undefined}
      onKeyDown={onKeyDown}
      onTransitionEnd={onTransitionEnd}
      className="ui-toast pointer-events-auto flex items-start gap-2 rounded-md border border-line-strong bg-overlay px-3 py-2.5 shadow-overlay"
    >
      <Icon name={TONE_ICON[toast.tone]} size="md" className={cx('mt-0.5 shrink-0', TONE_INK[toast.tone])} />
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-body font-semibold text-ink">{toast.title}</p>
        {toast.body ? <p id={bodyId} className="mt-0.5 text-label text-ink-2">{toast.body}</p> : null}
        {actions.length > 0
          ? (
              <div className="-ms-2 mt-1.5 flex flex-wrap gap-1">
                {actions.map((action, index) => (
                  <Button key={`${index}:${action.label}`} size="sm" variant="ghost" onClick={() => action.onAction()}>
                    {action.label}
                  </Button>
                ))}
              </div>
            )
          : null}
      </div>
      <IconButton size="sm" icon="action.close" label="Dismiss notification" className="-me-1.5 -mt-0.5" onClick={() => onClose(toast.id)} />
    </div>
  )
}

/** Where the stack sits in the work area: along the bottom, against the inline start or end. */
export interface ToastAnchor
{
  /** The side the stack hugs; `start` by default. */
  side?: 'start' | 'end'
  /** Distance from that side in pixels; 16 by default. */
  inset?: number
  /** Distance from the bottom in pixels; 16 by default. */
  bottom?: number
}

/** Props for {@link ToastRegion}. */
export interface ToastRegionProps
{
  /** A view's placement inside the work area, never over a docked inspector or the run header's actions. */
  anchor?: ToastAnchor
  /** Opens Logs from the "+N more" line; without it the line is plain text. */
  onShowMore?: () => void
  /** The region element, for the shell's F6 cycle; focusing it focuses the newest toast. */
  ref?: Ref<HTMLDivElement>
}

const EDGE_PX = 16
const LEAVE_FALLBACK_MS = 400
const LINE = 'pointer-events-auto rounded-md border border-line-strong bg-overlay px-3 py-1.5 text-start text-label text-ink-2 shadow-overlay'

/** Whether the stack covers the center of `target`, by hit-testing that point. */
function coversFocus(region: HTMLElement, target: Element | null): boolean
{
  if (!target || target === document.body || region.contains(target) || typeof document.elementFromPoint !== 'function')
  {
    return false
  }
  const box = target.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return hit !== null && region.contains(hit)
}

/**
 * The shell's one notification stack, mounted once in the work area after the views. It holds the polite
 * status region and the assertive alert region that speak toasts under the announcement policy, draws at
 * most {@link TOAST_VISIBLE_LIMIT} toasts with older ones folded into a "+N more" line, pauses dismiss
 * timers while hovered or focused within, publishes the band it occupies above the work area's bottom edge
 * as `--toast-stack-size` on its parent (0px when empty), and folds into a one-line summary while it would
 * cover the focused control. Focusing the region focuses the newest toast; Escape dismisses the focused
 * toast and moves focus to the next one, or back to where focus was before it entered the region.
 */
export function ToastRegion({ anchor, onShowMore, ref }: ToastRegionProps): ReactElement
{
  const stack = useSyncExternalStore(subscribe, getStack)
  const reducedMotion = useReducedMotion()
  const regionRef = useRef<HTMLDivElement>(null)
  const politeRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [ghosts, setGhosts] = useState<readonly ToastRecord[]>([])
  const [drawnStack, setDrawnStack] = useState(stack)

  if (drawnStack !== stack)
  {
    setDrawnStack(stack)
    const gone = drawnStack.slice(-TOAST_VISIBLE_LIMIT).filter((toast) => !stack.some((item) => item.id === toast.id))
    if (gone.length > 0 && !reducedMotion)
    {
      setGhosts((current) => [...current, ...gone])
    }
  }

  const side = anchor?.side ?? 'start'
  const inset = anchor?.inset ?? EDGE_PX
  const bottom = anchor?.bottom ?? EDGE_PX
  const visible = stack.slice(-TOAST_VISIBLE_LIMIT)
  const visibleKey = visible.map((toast) => toast.id).join(' ')

  useImperativeHandle(ref, () => regionRef.current as HTMLDivElement, [])

  useEffect(() =>
  {
    const speakers: Record<LiveChannel, Speaker> = {
      polite: createSpeaker(politeRef.current as HTMLDivElement),
      assertive: createSpeaker(alertRef.current as HTMLDivElement)
    }
    const speak: Speak = (channel, text) => speakers[channel].say(text)
    speaker = speak
    return () =>
    {
      speakers.polite.cancel()
      speakers.assertive.cancel()
      if (speaker === speak)
      {
        speaker = null
      }
    }
  }, [])

  useEffect(() =>
  {
    const region = regionRef.current as HTMLDivElement
    const host = region.parentElement as HTMLElement
    const publish = (): void =>
    {
      const height = region.getBoundingClientRect().height
      host.style.setProperty('--toast-stack-size', height > 0 ? `${Math.ceil(height + bottom)}px` : '0px')
    }
    publish()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    observer?.observe(region)
    return () =>
    {
      observer?.disconnect()
      host.style.removeProperty('--toast-stack-size')
    }
  }, [bottom])

  useEffect(() =>
  {
    const region = regionRef.current as HTMLDivElement
    const onFocusIn = (event: FocusEvent): void =>
    {
      setCollapsed(coversFocus(region, event.target instanceof Element ? event.target : null))
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  useEffect(() =>
  {
    if (ghosts.length === 0)
    {
      return
    }
    const timer = setTimeout(() => setGhosts([]), LEAVE_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [ghosts])

  useEffect(() =>
  {
    if (!hovered)
    {
      return
    }
    // A toast removed under the pointer never sends pointerleave, so hover ends at the next move outside.
    const region = regionRef.current as HTMLDivElement
    const onMove = (event: PointerEvent): void =>
    {
      if (!(event.target instanceof Node && region.contains(event.target)))
      {
        setHovered(false)
      }
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [hovered])

  const focusNewest = useCallback((exceptId?: string): void =>
  {
    const region = regionRef.current as HTMLDivElement
    const next = getStack().filter((toast) => toast.id !== exceptId).at(-1)
    const target = next ? region.querySelector<HTMLElement>(`[data-toast-id="${next.id}"]`) : returnFocusRef.current
    if (target?.isConnected)
    {
      target.focus()
    }
  }, [])

  useLayoutEffect(() =>
  {
    const region = regionRef.current as HTMLDivElement
    const active = document.activeElement
    if (focusWithin && !(active && region.contains(active) && !active.closest('[data-leaving]')))
    {
      focusNewest()
      setFocusWithin(region.contains(document.activeElement))
    }
  }, [focusWithin, stack, focusNewest])

  useLayoutEffect(() =>
  {
    if (!collapsed && coversFocus(regionRef.current as HTMLDivElement, document.activeElement))
    {
      setCollapsed(true)
    }
  }, [collapsed, visibleKey])

  const onClose = useCallback((id: string): void =>
  {
    if ((regionRef.current as HTMLDivElement).contains(document.activeElement))
    {
      focusNewest(id)
    }
    dismiss(id)
  }, [focusNewest])

  const onLeft = useCallback((id: string): void =>
  {
    setGhosts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const onFocus = (event: ReactFocusEvent<HTMLDivElement>): void =>
  {
    const region = event.currentTarget
    const from = event.relatedTarget
    if (!focusWithin && !(from instanceof Node && region.contains(from)))
    {
      returnFocusRef.current = from instanceof HTMLElement ? from : null
    }
    setFocusWithin(true)
    if (event.target === region)
    {
      flushSync(() => setCollapsed(false))
      focusNewest()
    }
  }

  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void =>
  {
    const to = event.relatedTarget
    if (!(to instanceof Node && event.currentTarget.contains(to)))
    {
      setFocusWithin(false)
    }
  }

  const hiddenCount = stack.length - visible.length
  const drawn = [
    ...visible.map((toast) => ({ toast, leaving: false })),
    ...ghosts.map((toast) => ({ toast, leaving: true }))
  ].sort((a, b) => a.toast.seq - b.toast.seq)
  const style: CSSProperties = {
    [side === 'start' ? 'insetInlineStart' : 'insetInlineEnd']: inset,
    insetBlockEnd: bottom,
    width: `min(360px, 100% - ${inset * 2}px)`
  }
  const folded = collapsed && stack.length > 0

  return (
    <div
      ref={regionRef}
      role="region"
      aria-label="Notifications"
      tabIndex={-1}
      data-empty={stack.length === 0 ? '' : undefined}
      data-collapsed={folded ? '' : undefined}
      style={style}
      className="pointer-events-none absolute z-(--z-index-toast) flex flex-col"
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div ref={politeRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only select-none" />
      <div ref={alertRef} role="alert" aria-atomic="true" className="sr-only select-none" />
      {folded
        ? <p className={LINE}>{`${stack.length} ${stack.length === 1 ? 'notification' : 'notifications'}, F6 to review`}</p>
        : null}
      <div hidden={folded} className={folded ? undefined : 'flex flex-col gap-2'}>
        {hiddenCount > 0 && onShowMore
          ? (
              <button type="button" className={cx(LINE, 'transition-colors duration-fast ease-out hover:text-ink')} aria-label={`+${hiddenCount} more notifications, open Logs`} onClick={onShowMore}>
                {`+${hiddenCount} more`}
              </button>
            )
          : null}
        {hiddenCount > 0 && !onShowMore ? <p className={LINE}>{`+${hiddenCount} more`}</p> : null}
        {drawn.map(({ toast, leaving }) => (
          <ToastItem key={toast.id} toast={toast} leaving={leaving} onClose={onClose} onLeft={onLeft} />
        ))}
      </div>
      {stack.map((toast) => <ToastClock key={toast.id} toast={toast} paused={hovered || focusWithin} />)}
    </div>
  )
}

/** The shortest spacing between two progress digests. */
export const PROGRESS_DIGEST_MS = 30_000

/** Options for {@link createProgressDigest}. */
export interface ProgressDigestOptions
{
  /** Speaks a digest; the batch view passes its LiveRegion's announce. */
  announce: Announce
  /** Whether a digest may speak now, such as while focus is inside the Batch view; always true when omitted. */
  isActive?: () => boolean
  intervalMs?: number
}

/** The opt-in run progress digest. It only schedules and filters; the view supplies the words and the setting. */
export interface ProgressDigest
{
  /** Records the run's counts as a key and the sentence that states them; only a changed key is spoken. */
  report(key: string, text: string): void
  /** Follows the "Announce batch progress every 30 seconds" setting; turning it off cancels the pending digest. */
  setEnabled(enabled: boolean): void
  dispose(): void
}

/**
 * Speaks run progress at most once per interval, only while enabled (off until `setEnabled(true)`), only
 * while `isActive` holds, and only when the counts changed since the last digest; the first report is the
 * baseline. A change waits a full interval, so a burst of finished jobs reads as one sentence with the
 * latest counts.
 */
export function createProgressDigest({ announce, isActive = () => true, intervalMs = PROGRESS_DIGEST_MS }: ProgressDigestOptions): ProgressDigest
{
  let enabled = false
  let latestKey: string | null = null
  let latestText = ''
  let spokenKey: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = (): void =>
  {
    clearTimeout(timer)
    timer = undefined
  }

  const schedule = (): void =>
  {
    if (!enabled || timer !== undefined || latestKey === spokenKey)
    {
      return
    }
    timer = setTimeout(() =>
    {
      timer = undefined
      if (latestKey === spokenKey)
      {
        return
      }
      if (!isActive())
      {
        schedule()
        return
      }
      spokenKey = latestKey
      announce(latestText)
    }, intervalMs)
  }

  return {
    report(key, text)
    {
      if (latestKey === null)
      {
        spokenKey = key
      }
      latestKey = key
      latestText = text
      schedule()
    },
    setEnabled(next)
    {
      enabled = next
      if (enabled)
      {
        schedule()
      }
      else
      {
        stop()
      }
    },
    dispose()
    {
      enabled = false
      stop()
    }
  }
}

/** Options for {@link useProgressDigest}. */
export interface UseProgressDigestOptions
{
  /** The "Announce batch progress every 30 seconds" setting, off by default. */
  enabled: boolean
  /** The view root; a digest speaks only while focus is inside it. */
  scope: RefObject<HTMLElement | null>
  /** The counts the sentence states, such as "10/22"; a digest speaks only after they change. */
  counts: string
  /** The sentence, such as "10 of 22 finished. About 18 min left." */
  text: string
}

/** Runs {@link createProgressDigest} for a view, speaking through the view's LiveRegion. */
export function useProgressDigest({ enabled, scope, counts, text }: UseProgressDigestOptions): void
{
  const announce = useAnnounce()
  const announceRef = useRef(announce)
  const [digest] = useState(() => createProgressDigest({
    announce: (sentence) => announceRef.current(sentence),
    isActive: () =>
    {
      const root = scope.current
      return root !== null && root.contains(document.activeElement)
    }
  }))

  useEffect(() =>
  {
    announceRef.current = announce
  }, [announce])

  useEffect(() =>
  {
    digest.setEnabled(enabled)
    return () => digest.setEnabled(false)
  }, [digest, enabled])

  useEffect(() =>
  {
    digest.report(counts, text)
  }, [digest, counts, text])
}
