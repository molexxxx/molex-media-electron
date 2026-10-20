import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { VisuallyHidden } from './VisuallyHidden'

/** A registry key; it fixes the icon and the ink, while the page passes its own words. */
export type StatusKey =
  | 'pending'
  | 'ready'
  | 'probing'
  | 'queued'
  | 'waiting'
  | 'analyzing'
  | 'encoding'
  | 'verifying'
  | 'finalizing'
  | 'wait-lock'
  | 'stopping'
  | 'paused'
  | 'decision'
  | 'done'
  | 'verified'
  | 'warning'
  | 'blocked'
  | 'failed'
  | 'returned'
  | 'will-skip'
  | 'cancelled'
  | 'skipped'
  | 'locked'
  | 'missing'

/** The ink a key draws in; primitives.css maps each `data-status` value to it. */
export type StatusInk = 'ink-2' | 'ink-3' | 'running' | 'warning' | 'error' | 'verified'

/** One registry row. */
export interface StatusEntry
{
  icon: IconName
  ink: StatusInk
  /** The default word. */
  word: string
  /** The default word's short form for a container under 160 px, where it has one. */
  compact?: string
  /** An active stage, whose LoaderCircle rotates while it is in view. */
  spins: boolean
}

/** The hidden suffix of a held label. */
export const NOT_ACKNOWLEDGED = ', not acknowledged'

/** Every status key with its icon, ink, and default word. */
export const STATUS_REGISTRY: Readonly<Record<StatusKey, StatusEntry>> = {
  pending: { icon: 'status.pending', ink: 'ink-3', word: 'Pending', spins: false },
  ready: { icon: 'status.pending', ink: 'ink-2', word: 'Ready', spins: false },
  probing: { icon: 'status.active', ink: 'ink-3', word: 'Probing', spins: true },
  queued: { icon: 'status.queued', ink: 'ink-3', word: 'Queued', spins: false },
  waiting: { icon: 'status.queued', ink: 'ink-2', word: 'Waiting', spins: false },
  analyzing: { icon: 'status.active', ink: 'running', word: 'Analyzing', spins: true },
  encoding: { icon: 'status.active', ink: 'running', word: 'Encoding', spins: true },
  verifying: { icon: 'status.active', ink: 'running', word: 'Verifying', spins: true },
  finalizing: { icon: 'status.active', ink: 'running', word: 'Finalizing', spins: true },
  'wait-lock': { icon: 'status.queued', ink: 'warning', word: 'Waiting for file access', compact: 'File in use', spins: false },
  stopping: { icon: 'status.active', ink: 'ink-2', word: 'Stopping', spins: true },
  paused: { icon: 'status.paused', ink: 'ink-2', word: 'Paused', spins: false },
  decision: { icon: 'status.warning', ink: 'warning', word: 'Needs a decision', compact: 'Decide', spins: false },
  done: { icon: 'status.done', ink: 'verified', word: 'Done', spins: false },
  verified: { icon: 'status.verified', ink: 'verified', word: 'Verified', spins: false },
  warning: { icon: 'status.warning', ink: 'warning', word: 'Warning', spins: false },
  blocked: { icon: 'status.failed', ink: 'error', word: 'Blocked', spins: false },
  failed: { icon: 'status.failed', ink: 'error', word: 'Failed', spins: false },
  returned: { icon: 'status.failed', ink: 'error', word: 'Returned', spins: false },
  'will-skip': { icon: 'status.skipped', ink: 'ink-3', word: 'Will skip', spins: false },
  cancelled: { icon: 'status.canceled', ink: 'ink-3', word: 'Canceled', spins: false },
  skipped: { icon: 'status.skipped', ink: 'ink-3', word: 'Skipped', spins: false },
  locked: { icon: 'status.locked', ink: 'ink-3', word: 'Locked', spins: false },
  missing: { icon: 'status.missing', ink: 'error', word: 'Source missing', compact: 'Missing', spins: false }
}

/** The `data-status` value for a key; the engine's `cancelled` is styled as `canceled`. */
export function statusAttribute(status: StatusKey): string
{
  return status === 'cancelled' ? 'canceled' : status
}

/** The full word a label shows: the page's `label`, or the key's default word. */
export function statusWord(status: StatusKey, label?: string): string
{
  return label ?? STATUS_REGISTRY[status].word
}

/** The status cell's tooltip text: the full word, with "Not acknowledged." while held. */
export function statusTooltip(word: string, held = false): string
{
  return held ? `${word}. Not acknowledged.` : word
}

/** Props for {@link StatusLabel}. */
export interface StatusLabelProps
{
  status: StatusKey
  /** Replaces the default word, for example "Encoding, pass 1 of 2" or "Waiting for D:". */
  label?: string
  /** The short word shown while the label's container is under 160 px; the accessible text keeps the full word. */
  compactLabel?: string
  /** True only while the job engine's `needsAttention` holds for the job; acknowledging clears it. */
  held?: boolean
  size?: 'sm' | 'md'
  className?: string
}

/**
 * A status as an icon and a word in the key's ink, never color alone. A held label adds the opaque held
 * ground, a 1 px frame, and the hidden ", not acknowledged"; the accessible text never uses the compact word.
 */
export function StatusLabel({ status, label, compactLabel, held = false, size = 'sm', className }: StatusLabelProps): ReactElement
{
  const entry = STATUS_REGISTRY[status]
  const word = statusWord(status, label)
  const compact = compactLabel ?? (label === undefined ? entry.compact : undefined)
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, entry.spins)

  return (
    <span
      ref={ref}
      className={cx('ui-status', size === 'md' ? 'text-body' : 'text-label', className)}
      data-status={statusAttribute(status)}
      data-held={held ? '' : undefined}
    >
      <Icon name={entry.icon} size={size} spin={entry.spins && inView} />
      {compact !== undefined && compact !== word
        ? (
          <>
            <span data-label="full" aria-hidden="true" className="min-w-0 truncate">{word}</span>
            <span data-label="compact" aria-hidden="true" className="min-w-0 truncate">{compact}</span>
            <VisuallyHidden>{word}</VisuallyHidden>
          </>
        )
        : <span data-label="full" className="min-w-0 truncate">{word}</span>}
      {held && <VisuallyHidden>{NOT_ACKNOWLEDGED}</VisuallyHidden>}
    </span>
  )
}

type VisibilityListener = (visible: boolean) => void

const visibilityListeners = new Map<Element, Set<VisibilityListener>>()
let visibilityObserver: IntersectionObserver | undefined

function sharedObserver(): IntersectionObserver | undefined
{
  if (visibilityObserver === undefined && typeof IntersectionObserver === 'function')
  {
    visibilityObserver = new IntersectionObserver((entries) =>
    {
      for (const entry of entries)
      {
        visibilityListeners.get(entry.target)?.forEach((listener) => listener(entry.isIntersecting))
      }
    })
  }
  return visibilityObserver
}

/**
 * Reports whether `element` intersects the viewport, through one IntersectionObserver shared by every
 * label and stamp. Without an observer the element counts as visible at once. Returns the unsubscribe.
 */
export function observeVisibility(element: Element, listener: VisibilityListener): () => void
{
  const observer = sharedObserver()
  if (observer === undefined)
  {
    listener(true)
    return () => undefined
  }
  const listeners = visibilityListeners.get(element) ?? new Set<VisibilityListener>()
  listeners.add(listener)
  visibilityListeners.set(element, listeners)
  observer.observe(element)
  return () =>
  {
    listeners.delete(listener)
    if (listeners.size === 0)
    {
      visibilityListeners.delete(element)
      observer.unobserve(element)
    }
  }
}

/** Whether the element is in view, tracked only while `enabled`; false until the first report. */
export function useInView(ref: RefObject<Element | null>, enabled = true): boolean
{
  const [inView, setInView] = useState(false)
  useEffect(() =>
  {
    const element = ref.current
    if (!enabled || element === null)
    {
      return undefined
    }
    return observeVisibility(element, setInView)
  }, [ref, enabled])
  return inView
}
