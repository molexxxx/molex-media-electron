import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { CapsText } from './CapsText'
import { cx } from './cx'
import { Icon } from './Icon'
import { prefersReducedMotion } from './platform'
import { observeVisibility } from './StatusLabel'
import { Tooltip } from './Tooltip'
import { VisuallyHidden } from './VisuallyHidden'

/** A finished job's measured outcome against its recipe. */
export type StampOutcome = 'verified' | 'returned'

/** One measured value on a stamp. */
export interface StampValue
{
  /** A name set before the value, for the inspector's stamp. */
  label?: string
  /** The value with its qualifier inside it, so a narrow stamp still says what it shows: "-19.1 LUFS, reachable". */
  text: string
  /** Sets the value in error ink. */
  failing?: boolean
}

/** Props for {@link Stamp}. */
export interface StampProps
{
  outcome: StampOutcome
  values: readonly StampValue[]
  /** A returned job's short reason: "True peak -0.4 dBTP over -1.0". */
  reason?: string
  /** sm is 22 px for rows, md is 28 px for the inspector. */
  size?: 'sm' | 'md'
  /** True from the live transition the row observed, see {@link useStampLanding}; the stamp still checks view and budget. */
  landing?: boolean
  /** The reference line shown on hover: "Apple Podcasts: -16 LKFS; this app's check ±1.0 dB for lossy outputs; limit -1.0 dBTP". */
  tooltip?: string
  className?: string
}

/** The most landings allowed inside one {@link STAMP_LANDING_WINDOW_MS} window; later stamps appear settled. */
export const STAMP_LANDING_LIMIT = 4
/** The sliding window of the shared landing budget. */
export const STAMP_LANDING_WINDOW_MS = 500
/** How long a row keeps reporting its live transition, so a stamp that remounts later never lands again. */
export const STAMP_LANDING_EXPIRY_MS = 1000

const LAND_KEYFRAMES = 'stamp-land'
const STAMP_WORDS: Readonly<Record<StampOutcome, string>> = { verified: 'Verified', returned: 'Returned' }

const landings: number[] = []

function claimLanding(now: number): boolean
{
  while (landings.length > 0 && now - landings[0] >= STAMP_LANDING_WINDOW_MS)
  {
    landings.shift()
  }
  if (landings.length >= STAMP_LANDING_LIMIT)
  {
    return false
  }
  landings.push(now)
  return true
}

function reducedMotion(): boolean
{
  return typeof window.matchMedia === 'function' && prefersReducedMotion()
}

function stillAnimating(element: HTMLElement): boolean
{
  return typeof element.getAnimations === 'function' && element.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')
}

type LandingState = 'settled' | 'pending' | 'landing'

/**
 * True once a mounted job leaves an active state, for the row to pass as the Stamp's `landing`. A row that
 * mounts already finished (History, scrolling into view, a reload) never reports one, and the report lapses
 * after {@link STAMP_LANDING_EXPIRY_MS}.
 */
export function useStampLanding(active: boolean): boolean
{
  const [previous, setPrevious] = useState(active)
  const [live, setLive] = useState(false)
  if (previous !== active)
  {
    setPrevious(active)
    setLive(previous && !active)
  }
  useEffect(() =>
  {
    if (!live)
    {
      return undefined
    }
    const timer = window.setTimeout(() => setLive(false), STAMP_LANDING_EXPIRY_MS)
    return () => window.clearTimeout(timer)
  }, [live])
  return live
}

/**
 * A finished job's measured outcome as a double-ruled block: icon, the word "Verified" or "Returned", the
 * values in mono, and for returned jobs the reason. It lands once on a live transition, only in view, never
 * under reduced motion, and within the shared budget of four landings per 500 ms; otherwise it is settled.
 */
export function Stamp({ outcome, values, reason, size = 'sm', landing = false, tooltip, className }: StampProps): ReactElement
{
  const ref = useRef<HTMLSpanElement>(null)
  const [landingState, setLandingState] = useState<LandingState>('settled')
  const stateRef = useRef<LandingState>('settled')
  const visibleRef = useRef<boolean | undefined>(undefined)
  const landingRef = useRef(false)

  const enter = (next: LandingState): void =>
  {
    stateRef.current = next
    setLandingState(next)
  }

  const decide = (visible: boolean): void =>
  {
    enter(visible && !reducedMotion() && claimLanding(performance.now()) ? 'landing' : 'settled')
  }

  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element === null)
    {
      return undefined
    }
    const onAnimationEnd = (event: AnimationEvent): void =>
    {
      if (event.target !== element || stateRef.current !== 'landing')
      {
        return
      }
      if (event.animationName === LAND_KEYFRAMES && stillAnimating(element))
      {
        return
      }
      enter('settled')
    }
    const onAnimationCancel = (event: AnimationEvent): void =>
    {
      if (event.target === element && stateRef.current === 'landing')
      {
        enter('settled')
      }
    }
    element.addEventListener('animationend', onAnimationEnd)
    element.addEventListener('animationcancel', onAnimationCancel)
    const stopObserving = observeVisibility(element, (visible) =>
    {
      visibleRef.current = visible
      if (stateRef.current === 'pending')
      {
        decide(visible)
      }
    })
    return () =>
    {
      element.removeEventListener('animationend', onAnimationEnd)
      element.removeEventListener('animationcancel', onAnimationCancel)
      stopObserving()
    }
  }, [])

  useLayoutEffect(() =>
  {
    const rising = landing && !landingRef.current
    landingRef.current = landing
    if (!rising || stateRef.current !== 'settled' || reducedMotion())
    {
      return
    }
    if (visibleRef.current === undefined)
    {
      enter('pending')
      return
    }
    decide(visibleRef.current)
  }, [landing])

  const stamp = (
    <span
      ref={ref}
      className={cx('ui-stamp text-label', className)}
      data-outcome={outcome}
      data-size={size === 'md' ? 'md' : undefined}
      data-landing={landingState === 'landing' ? '' : undefined}
      style={landingState === 'pending' ? { opacity: 0 } : undefined}
    >
      <Icon name={outcome === 'verified' ? 'status.verified' : 'status.failed'} size="sm" />
      <CapsText className="type-legend">{STAMP_WORDS[outcome]}</CapsText>
      {values.length > 0 && (
        <span data-part="values" className="flex min-w-0 items-center gap-[2ch]">
          {values.map((value, index) => (
            <span key={index} data-part="value" data-failing={value.failing ? '' : undefined}>
              <VisuallyHidden>, </VisuallyHidden>
              {value.label && <span data-part="value-label" className="font-sans text-ink-2">{`${value.label} `}</span>}
              {value.text}
            </span>
          ))}
        </span>
      )}
      {reason && (
        <span data-part="reason">
          <VisuallyHidden>, </VisuallyHidden>
          {reason}
        </span>
      )}
    </span>
  )

  return tooltip ? <Tooltip content={tooltip} inside>{stamp}</Tooltip> : stamp
}
