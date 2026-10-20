import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type ReactElement, type Ref } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import { useAnnounce } from './LiveRegion'

/** What a field shows while the selected jobs disagree, so no one job's value reads as shared. */
export const MIXED_LABEL = 'Mixed'

/** Key steps commit once this many ms pass without another step, so a run of steps is one commit. */
export const STEP_COMMIT_DELAY_MS = 500

/** What {@link NumberFieldHandle.commitDraft} did. */
export type CommitDraftResult = 'committed' | 'invalid' | 'unchanged'

/** The handle a NumberField's `ref` receives. */
export interface NumberFieldHandle
{
  /**
   * Commits a valid typed draft or a pending key step at once, so a primary action never runs with a value
   * the field shows but has not committed. Resolves `committed` once `onCommit` returned (and the promise it
   * returned settled), `invalid` when the draft cannot be read (the field shows its error and takes focus),
   * and `unchanged` otherwise.
   */
  commitDraft(): Promise<CommitDraftResult>
  focus(): void
  readonly input: HTMLInputElement | null
}

/** Props for {@link NumberField}. */
export interface NumberFieldProps
{
  /** The committed value; null while the selected jobs disagree. */
  value: number | null
  /** Receives each committed value once. Returning a promise keeps the committed value shown until it settles. */
  onCommit(value: number): void | PromiseLike<unknown>
  /** The Up and Down step; Shift steps by ten. */
  step: number
  min?: number
  max?: number
  /** The PageUp and PageDown step; ten steps by default. */
  bigStep?: number
  /** Decimals shown and committed; by default those of `step`. */
  decimals?: number
  /** A unit drawn inside the frame and spoken with the value, such as "LUFS". */
  unit?: string
  /** The spoken value; by default the shown number and the unit, such as "−16.0 LUFS". */
  valueText?(value: number): string
  id?: string
  label?: string
  labelledBy?: string
  describedBy?: string
  /** The placeholder and spoken value while `value` is null. */
  nullLabel?: string
  /** `md` is 32 px tall, `sm` 28 px. */
  size?: 'sm' | 'md'
  disabled?: boolean
  error?: string
  /** Classes for the outer box that holds the frame and its message; set the width here. */
  className?: string
  ref?: Ref<NumberFieldHandle>
}

/** Props for {@link FieldMessage}. */
export interface FieldMessageProps
{
  id: string
  /** `error` draws the OctagonX glyph in error ink; `note` is a plain remark in secondary ink. */
  tone?: 'error' | 'note'
  /** Wraps within the width its control sets (the default) instead of widening its box. */
  bounded?: boolean
  className?: string
  children: string
}

interface Edit
{
  /** Text the user typed; null while the field shows a value. */
  draft: string | null
  /** A key-step value waiting for its commit. */
  pending: number | null
  /** A committed value shown until the value prop or the commit's promise catches up. */
  awaiting: number | null
  invalid: boolean
  /** The clamp note and the value it explains; it shows only while that value does. */
  note: { value: number, text: string } | null
}

interface Settled
{
  result: CommitDraftResult
  promise?: PromiseLike<unknown>
}

const CLEAN: Edit = { draft: null, pending: null, awaiting: null, invalid: false, note: null }

const MINUS = '\u2212'

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/

const HEIGHTS = { sm: 'h-7', md: 'h-(--size-control-md)' } as const

const FRAME = [
  'w-full min-w-0 rounded-sm border border-line-control bg-sunken ps-2 pe-2 text-end text-body tabular-nums text-ink',
  'transition-colors duration-fast ease-out',
  'enabled:not-aria-invalid:hover:border-line-control-hover aria-invalid:border-error-fill',
  'disabled:border-line disabled:text-ink-disabled'
].join(' ')

function decimalsOf(step: number): number
{
  const [mantissa, exponent] = String(step).split('e-')
  const dot = mantissa.indexOf('.')
  return (dot === -1 ? 0 : mantissa.length - dot - 1) + (exponent ? Number(exponent) : 0)
}

function roundTo(value: number, places: number): number
{
  return Number(value.toFixed(places))
}

function clamp(value: number, min: number | undefined, max: number | undefined): number
{
  if (max !== undefined && value > max)
  {
    return max
  }
  if (min !== undefined && value < min)
  {
    return min
  }
  return value
}

/** A number with fixed decimals and U+2212 for minus; a negative zero prints as zero. */
function formatNumber(value: number, places: number): string
{
  const text = value.toFixed(places)
  return Number(text) === 0 ? text.replace('-', '') : text.replace('-', MINUS)
}

/** A limit the way a sentence states it: trailing zeros dropped, U+2212 for minus. */
function stated(value: number, places: number): string
{
  return String(roundTo(value, places)).replace('-', MINUS)
}

/** Reads typed text: "-" or U+2212 for minus, spaces ignored, a trailing unit allowed; null when it is not a number. */
function parseNumber(text: string, unit: string | undefined): number | null
{
  let clean = text.replace(/\u2212/g, '-').replace(/\s+/g, '')
  const suffix = unit?.replace(/\s+/g, '').toLowerCase()
  if (suffix && clean.toLowerCase().endsWith(suffix))
  {
    clean = clean.slice(0, -suffix.length)
  }
  if (!NUMBER.test(clean))
  {
    return null
  }
  const value = Number(clean)
  return Number.isFinite(value) ? value : null
}

function rangeMessage(min: number | undefined, max: number | undefined, places: number): string
{
  if (min !== undefined && max !== undefined)
  {
    return `Enter a number from ${stated(min, places)} to ${stated(max, places)}.`
  }
  if (min !== undefined)
  {
    return `Enter a number of ${stated(min, places)} or more.`
  }
  if (max !== undefined)
  {
    return `Enter a number of ${stated(max, places)} or less.`
  }
  return 'Enter a number.'
}

function isThenable(value: unknown): value is PromiseLike<unknown>
{
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * The inline message under a field, referenced by the field's `aria-describedby`. By default it never
 * widens its box: it wraps within the width the control sets.
 */
export function FieldMessage({ id, tone = 'error', bounded = true, className, children }: FieldMessageProps): ReactElement
{
  return (
    <span
      id={id}
      data-tone={tone}
      className={cx('flex items-start gap-1 text-label', bounded && 'w-0 min-w-full', tone === 'error' ? 'text-error' : 'text-ink-2', className)}
    >
      {tone === 'error' && <Icon name="status.failed" size="sm" className="mt-px" />}
      <span className="min-w-0">{children}</span>
    </span>
  )
}

/**
 * A numeric text field with spinbutton semantics. While focused it holds a draft: Enter or blur commits it,
 * Escape reverts it, and an empty, partial, or unreadable entry never commits. Out-of-range input commits
 * the nearest limit with a note; Up and Down step (ten steps with Shift), PageUp and PageDown take the big
 * step, and a run of steps commits once, {@link STEP_COMMIT_DELAY_MS} after the last one. Home and End stay
 * with text editing. A null value reads `nullLabel` ("Mixed") and shows no number.
 */
export function NumberField({
  value,
  onCommit,
  step,
  min,
  max,
  bigStep,
  decimals,
  unit,
  valueText,
  id,
  label,
  labelledBy,
  describedBy,
  nullLabel = MIXED_LABEL,
  size = 'md',
  disabled,
  error,
  className,
  ref
}: NumberFieldProps): ReactElement
{
  const inputRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<Edit>(CLEAN)
  const [edit, setEdit] = useState<Edit>(CLEAN)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusedRef = useRef(false)
  const tokenRef = useRef(0)
  const messageId = useId()
  const announce = useAnnounce()
  const places = decimals ?? decimalsOf(step)

  const update = useCallback((patch: Partial<Edit>): void =>
  {
    editRef.current = { ...editRef.current, ...patch }
    setEdit(editRef.current)
  }, [])

  const commit = (next: number): Settled =>
  {
    if (next === (editRef.current.awaiting ?? value))
    {
      return { result: 'unchanged' }
    }
    const outcome = onCommit(next)
    if (!isThenable(outcome))
    {
      return { result: 'committed' }
    }
    const token = ++tokenRef.current
    update({ awaiting: next })
    const done = (): void =>
    {
      if (tokenRef.current === token && editRef.current.awaiting !== null)
      {
        update({ awaiting: null })
      }
    }
    outcome.then(done, done)
    return { result: 'committed', promise: outcome }
  }

  const settle = (quiet = false): Settled =>
  {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    const current = editRef.current
    if (current.pending !== null)
    {
      update({ pending: null })
      return commit(current.pending)
    }
    if (current.draft === null)
    {
      return { result: 'unchanged' }
    }
    if (current.draft.trim() === '')
    {
      update({ draft: null, invalid: false })
      return { result: 'unchanged' }
    }
    const parsed = parseNumber(current.draft, unit)
    if (parsed === null)
    {
      update({ invalid: true })
      if (!quiet)
      {
        announce(rangeMessage(min, max, places))
      }
      return { result: 'invalid' }
    }
    const entered = roundTo(parsed, places)
    const next = clamp(entered, min, max)
    const note = next === entered
      ? null
      : { value: next, text: `Set to ${formatNumber(next, places)}, the ${entered > next ? 'maximum' : 'minimum'}.` }
    update({ draft: null, invalid: false, note })
    if (note && !quiet)
    {
      announce(note.text)
    }
    return commit(next)
  }

  const settleRef = useRef<(quiet?: boolean) => Settled>(settle)
  useLayoutEffect(() =>
  {
    settleRef.current = settle
  })

  useEffect(() =>
  {
    const current = editRef.current
    const stale = !focusedRef.current && (current.draft !== null || current.invalid)
    if (stale)
    {
      update({ draft: null, invalid: false, awaiting: null })
    }
    else if (current.awaiting !== null)
    {
      update({ awaiting: null })
    }
  }, [value, update])

  useEffect(() =>
  {
    return () =>
    {
      const stepping = timerRef.current !== undefined
      clearTimeout(timerRef.current)
      timerRef.current = undefined
      if (stepping || editRef.current.draft !== null)
      {
        settleRef.current(true)
      }
    }
  }, [])

  useImperativeHandle(ref, () => ({
    commitDraft: async (): Promise<CommitDraftResult> =>
    {
      const settled = settleRef.current()
      if (settled.result === 'invalid')
      {
        inputRef.current?.focus()
      }
      await settled.promise
      return settled.result
    },
    focus: (): void =>
    {
      inputRef.current?.focus()
    },
    get input(): HTMLInputElement | null
    {
      return inputRef.current
    }
  }), [])

  const stepBy = (event: KeyboardEvent<HTMLInputElement>, delta: number): void =>
  {
    const current = editRef.current
    const typed = current.draft === null ? null : parseNumber(current.draft, unit)
    const base = current.pending ?? typed ?? current.awaiting ?? value
    if (base === null)
    {
      return
    }
    event.preventDefault()
    update({ draft: null, pending: clamp(roundTo(base + delta, places), min, max), invalid: false, note: null })
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() =>
    {
      timerRef.current = undefined
      settleRef.current()
    }, STEP_COMMIT_DELAY_MS)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void =>
  {
    const current = editRef.current
    const dirty = current.draft !== null || current.pending !== null || current.invalid
    const modified = event.altKey || event.ctrlKey || event.metaKey
    switch (event.key)
    {
      case 'ArrowUp':
      case 'ArrowDown':
        if (!modified)
        {
          stepBy(event, (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1))
        }
        return
      case 'PageUp':
      case 'PageDown':
        if (!modified)
        {
          stepBy(event, (event.key === 'PageUp' ? 1 : -1) * (bigStep ?? step * 10))
        }
        return
      case 'Enter':
        if (dirty && !modified && !event.shiftKey)
        {
          event.preventDefault()
          settle()
        }
        return
      case 'Escape':
        if (dirty)
        {
          event.preventDefault()
          clearTimeout(timerRef.current)
          timerRef.current = undefined
          update({ draft: null, pending: null, invalid: false, note: null })
        }
        return
    }
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void =>
  {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    update({ draft: event.currentTarget.value, pending: null, invalid: false, note: null })
  }

  const handleFocus = (): void =>
  {
    focusedRef.current = true
  }

  const handleBlur = (): void =>
  {
    focusedRef.current = false
    settle()
  }

  const shown = edit.pending ?? edit.awaiting ?? value
  const text = edit.draft ?? (shown === null ? '' : formatNumber(shown, places))
  const spoken = shown === null
    ? nullLabel
    : valueText ? valueText(shown) : unit ? `${formatNumber(shown, places)} ${unit}` : formatNumber(shown, places)
  const invalidMessage = edit.invalid ? rangeMessage(min, max, places) : null
  const note = edit.note !== null && edit.note.value === shown ? edit.note.text : null
  const message = invalidMessage || error || note
  const invalid = Boolean(invalidMessage || error)
  const widest = Math.max(4, ...[min, max].filter((limit) => limit !== undefined).map((limit) => formatNumber(limit, places).length))
  const style: CSSProperties | undefined = unit ? { paddingInlineEnd: `calc(${unit.length} * 0.6 * var(--text-label) + 14px)` } : undefined

  return (
    <span className={cx('inline-flex flex-col gap-1', className)}>
      <span className="relative flex">
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          autoComplete="off"
          spellCheck={false}
          size={widest + 1}
          value={text}
          placeholder={shown === null ? nullLabel : undefined}
          disabled={disabled}
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={cx(describedBy, message && messageId) || undefined}
          aria-invalid={invalid || undefined}
          aria-valuenow={shown ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuetext={spoken}
          data-size={size}
          className={cx(FRAME, HEIGHTS[size])}
          style={style}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {unit && (
          <span
            aria-hidden="true"
            className={cx('pointer-events-none absolute inset-y-0 inset-e-2 flex items-center text-label', disabled ? 'text-ink-disabled' : 'text-ink-3')}
          >
            {unit}
          </span>
        )}
      </span>
      {message && <FieldMessage id={messageId} tone={invalid ? 'error' : 'note'}>{message}</FieldMessage>}
    </span>
  )
}
