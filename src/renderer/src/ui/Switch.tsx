import { useEffect, useId, useImperativeHandle, useRef, type MouseEvent, type ReactElement, type Ref } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import { useAnnounce } from './LiveRegion'

/** The word shown beside a switch while its setting applies. */
export const SWITCH_BUSY_LABEL = 'Applying'

/** Props for {@link Switch}. */
export interface SwitchProps
{
  checked: boolean
  /** Receives the requested state; set `busy` while it applies when that takes a while. */
  onChange(next: boolean): void
  /** Lets a `<label for>` name the switch and make its text a target. */
  id?: string
  label?: string
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
  /** Shows `busyLabel` with a spinner, keeps focus, and ignores clicks until the setting applies. */
  busy?: boolean
  busyLabel?: string
  /** Classes for the outer box that holds the switch and its busy word. */
  className?: string
  ref?: Ref<HTMLButtonElement>
}

/** The switch's accessible name, read when an outcome is announced. */
function nameOf(button: HTMLButtonElement, label: string | undefined, labelledBy: string | undefined): string
{
  if (label)
  {
    return label
  }
  const sources = labelledBy
    ? labelledBy.split(/\s+/).map((id) => document.getElementById(id))
    : Array.from(button.labels)
  return sources.map((node) => node?.textContent?.trim()).filter(Boolean).join(' ')
}

/** Lowers a leading capital for use mid-sentence, leaving acronyms such as "GPU" alone. */
function midSentence(name: string): string
{
  return /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name
}

/**
 * An on and off setting that applies at once and holds one value, on a button with switch semantics whose
 * 32 by 24 px box is the target. A switch has no mixed state, so recipe booleans use Checkbox. When a
 * click starts a `busy` spell, its end is announced through the view's LiveRegion: "Hardware encoding on",
 * or "Could not apply hardware encoding" when the state did not change, with the reason left to the view.
 */
export function Switch({
  checked,
  onChange,
  id,
  label,
  labelledBy,
  describedBy,
  disabled,
  busy = false,
  busyLabel = SWITCH_BUSY_LABEL,
  className,
  ref
}: SwitchProps): ReactElement
{
  const buttonRef = useRef<HTMLButtonElement>(null)
  const requestedRef = useRef<boolean | null>(null)
  const wasBusyRef = useRef(busy)
  const busyId = useId()
  const announce = useAnnounce()

  useImperativeHandle(ref, () => buttonRef.current as HTMLButtonElement, [])

  useEffect(() =>
  {
    const settled = wasBusyRef.current && !busy
    wasBusyRef.current = busy
    const requested = requestedRef.current
    if (busy || requested === null)
    {
      return
    }
    requestedRef.current = null
    if (!settled)
    {
      return
    }
    const name = nameOf(buttonRef.current as HTMLButtonElement, label, labelledBy)
    announce(checked === requested ? `${name} ${checked ? 'on' : 'off'}` : `Could not apply ${midSentence(name)}`)
  }, [busy, checked, label, labelledBy, announce])

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void =>
  {
    if (busy)
    {
      event.preventDefault()
      return
    }
    requestedRef.current = !checked
    onChange(!checked)
  }

  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      {busy && (
        <span id={busyId} className="inline-flex items-center gap-1 text-label text-ink-2">
          <Icon name="status.active" size="sm" spin />
          {busyLabel}
        </span>
      )}
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={cx(describedBy, busy && busyId) || undefined}
        aria-disabled={busy || undefined}
        disabled={disabled}
        className="ui-switch"
        onClick={handleClick}
      >
        <span className="ui-switch-track">
          <span className="ui-switch-knob" />
        </span>
      </button>
    </span>
  )
}
