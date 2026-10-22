import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import { cx } from './cx'
import { FieldMessage, MIXED_LABEL } from './NumberField'

/** What set a committed value: a pointer press or drag, or the keyboard (assistive technology counts as keys). */
export type SliderCommitSource = 'pointer' | 'keyboard'

/** Props for {@link Slider}. */
export interface SliderProps
{
  value: number
  /** Each live value while the thumb moves. */
  onInput?(value: number): void
  /** The committed value: once on pointer release, once per key step (a paired field debounces those). */
  onChange(value: number, source: SliderCommitSource): void
  min: number
  max: number
  step: number
  /** The PageUp and PageDown step; without it the platform moves a tenth of the range. */
  bigStep?: number
  /** The arrow key step, such as five seconds on a seek bar whose step is one; without it the arrows move by `step`. */
  keyStep?: number
  label?: string
  labelledBy?: string
  describedBy?: string
  /** The spoken value, always with its unit, such as "−16.0 LUFS" or "CRF 23". */
  valueText(value: number): string
  /** The selected jobs disagree: no fill, a hollow thumb, and "Mixed" spoken, until the thumb moves. */
  mixed?: boolean
  disabled?: boolean
  error?: string
  id?: string
  /** Classes for the outer box; set `--ui-slider-ground` here when the slider sits on a ground other than panel. */
  className?: string
  ref?: Ref<HTMLInputElement>
}

interface Moved
{
  value: number
  /** The value prop the move started from; a new value prop retires the move. */
  base: number
}

function clamp(value: number, min: number, max: number): number
{
  return Math.min(max, Math.max(min, value))
}

function placesOf(step: number): number
{
  const dot = String(step).indexOf('.')
  return dot === -1 ? 0 : String(step).length - dot - 1
}

/**
 * The native range input, whose visible thumb is the real control. It shows a moved thumb at once, even
 * before the value prop catches up, and reports live values through `onInput` and committed ones through
 * `onChange` with their source, so a paired field can send one command per gesture.
 */
export function Slider({
  value,
  onInput,
  onChange,
  min,
  max,
  step,
  bigStep,
  keyStep,
  label,
  labelledBy,
  describedBy,
  valueText,
  mixed = false,
  disabled,
  error,
  id,
  className,
  ref
}: SliderProps): ReactElement
{
  const inputRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<SliderCommitSource>('keyboard')
  const commitRef = useRef(onChange)
  const [moved, setMoved] = useState<Moved | null>(null)
  const errorId = useId()

  const current = moved !== null && moved.base === value ? moved : null
  if (moved !== null && current === null)
  {
    setMoved(null)
  }
  const shown = current?.value ?? value
  const showMixed = mixed && current === null
  const fill = max > min ? Number(((clamp(shown, min, max) - min) / (max - min) * 100).toFixed(2)) : 0

  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, [])

  useLayoutEffect(() =>
  {
    commitRef.current = onChange
  })

  useEffect(() =>
  {
    const input = inputRef.current as HTMLInputElement
    const handleCommit = (): void =>
    {
      commitRef.current(Number(input.value), sourceRef.current)
    }
    input.addEventListener('change', handleCommit)
    return () =>
    {
      input.removeEventListener('change', handleCommit)
    }
  }, [])

  const move = (next: number): void =>
  {
    setMoved({ value: next, base: value })
    onInput?.(next)
  }

  const handleInput = (event: FormEvent<HTMLInputElement>): void =>
  {
    move(Number(event.currentTarget.value))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void =>
  {
    sourceRef.current = 'keyboard'
    const page = event.key === 'PageUp' ? 1 : event.key === 'PageDown' ? -1 : 0
    const arrow = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
    const amount = page !== 0 ? bigStep : arrow !== 0 ? keyStep : undefined
    if (amount === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    {
      return
    }
    event.preventDefault()
    const next = Number(clamp(shown + (page || arrow) * amount, min, max).toFixed(placesOf(step)))
    if (next !== shown)
    {
      move(next)
      onChange(next, 'keyboard')
    }
  }

  const handlePointerDown = (): void =>
  {
    sourceRef.current = 'pointer'
  }

  return (
    <span className={cx('flex flex-col gap-1', className)}>
      <input
        ref={inputRef}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={cx(describedBy, error && errorId) || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-valuetext={showMixed ? MIXED_LABEL : valueText(shown)}
        data-mixed={showMixed || undefined}
        className="ui-slider"
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
      />
      {error && <FieldMessage id={errorId}>{error}</FieldMessage>}
    </span>
  )
}
