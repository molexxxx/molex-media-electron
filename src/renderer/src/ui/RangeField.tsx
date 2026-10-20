import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from 'react'
import { cx } from './cx'
import { FieldCaption, hintIdFor } from './FieldCaption'
import { NumberField, STEP_COMMIT_DELAY_MS, type CommitDraftResult, type NumberFieldHandle } from './NumberField'
import { Slider, type SliderCommitSource } from './Slider'
import { VisuallyHidden } from './VisuallyHidden'

/** The words that, after the caption, name the number field apart from the slider. */
export const EXACT_VALUE_LABEL = 'exact value'

/** The handle a RangeField's `ref` receives. */
export interface RangeFieldHandle
{
  /**
   * Sends a pending slider key step and then the field's draft, as {@link NumberFieldHandle.commitDraft}
   * does: `committed` once either was sent (and a promise `onCommit` returned settled), `invalid` when the
   * typed draft cannot be read (the field shows its error and takes focus), and `unchanged` otherwise.
   */
  commitDraft(): Promise<CommitDraftResult>
  /** Focuses the slider. */
  focus(): void
}

/** Props for {@link RangeField}. */
export interface RangeFieldProps
{
  /** The sentence-case caption, which names the slider and, with "exact value", the number field. */
  label: string
  /** A note after the caption that both controls reference, such as a range or why the value is fixed. */
  hint?: string
  /** The committed value; null while the selected jobs disagree. */
  value: number | null
  /** Receives one value per gesture. Returning a promise keeps the sent value shown until it settles. */
  onCommit(value: number): void | PromiseLike<unknown>
  min: number
  max: number
  step: number
  /** The PageUp and PageDown step of both controls. */
  bigStep?: number
  /** Decimals the field shows and commits; by default those of `step`. */
  decimals?: number
  /** A unit drawn inside the field's frame, such as "LUFS". */
  unit?: string
  /** The spoken value of both controls, always with its unit, such as "−16.0 LUFS" or "CRF 23". */
  valueText(value: number): string
  /** Where the hollow thumb rests while the value is mixed; the midpoint by default. */
  mixedValue?: number
  /** Further descriptions for both controls, such as the distinct values behind "Mixed". */
  describedBy?: string
  /** The field's size: `md` is 32 px tall, `sm` 28 px. */
  size?: 'sm' | 'md'
  disabled?: boolean
  error?: string
  /** The slider's id, which the caption's `for` names. */
  id?: string
  /** Classes for the outer box; set `--ui-slider-ground` here when the field sits on a ground other than panel. */
  className?: string
  ref?: Ref<RangeFieldHandle>
}

interface Live
{
  value: number
  /** The value prop the gesture started from; a new value prop retires the live value. */
  base: number | null
}

interface Settled
{
  result: CommitDraftResult
  promise?: PromiseLike<unknown>
}

function decimalsOf(step: number): number
{
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

function restingValue(min: number, max: number, step: number): number
{
  const steps = Math.round((max - min) / 2 / step)
  return Number(Math.min(max, min + steps * step).toFixed(decimalsOf(step)))
}

function isThenable(value: unknown): value is PromiseLike<unknown>
{
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * A FieldCaption, a Slider, and a NumberField sharing one value, so one gesture is one commit however many
 * jobs it sets: a drag updates the field live and commits once on pointer release, slider key steps commit
 * once {@link STEP_COMMIT_DELAY_MS} after the last key (or when the slider loses focus), and typing commits
 * on Enter or blur. A null value shows a hollow thumb without fill and "Mixed" in both controls; a drag or a
 * committed number then sets every selected job.
 */
export function RangeField({
  label,
  hint,
  value,
  onCommit,
  min,
  max,
  step,
  bigStep,
  decimals,
  unit,
  valueText,
  mixedValue,
  describedBy,
  size = 'md',
  disabled,
  error,
  id,
  className,
  ref
}: RangeFieldProps): ReactElement
{
  const baseId = useId()
  const sliderId = id ?? `${baseId}-slider`
  const captionId = `${baseId}-caption`
  const exactId = `${baseId}-exact`
  const hintId = hintIdFor(sliderId)
  const sliderRef = useRef<HTMLInputElement>(null)
  const fieldRef = useRef<NumberFieldHandle>(null)
  const [live, setLive] = useState<Live | null>(null)
  const pendingRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tokenRef = useRef(0)
  const latestRef = useRef({ value, onCommit })

  const current = live !== null && live.base === value ? live.value : null
  if (live !== null && current === null)
  {
    setLive(null)
  }
  const mixed = value === null && current === null
  const shown = current ?? value ?? mixedValue ?? restingValue(min, max, step)
  const described = cx(hint && hintId, describedBy) || undefined

  useLayoutEffect(() =>
  {
    latestRef.current = { value, onCommit }
  })

  const commit = (next: number): Settled =>
  {
    const latest = latestRef.current
    if (next === latest.value)
    {
      setLive(null)
      return { result: 'unchanged' }
    }
    const outcome = latest.onCommit(next)
    if (!isThenable(outcome))
    {
      setLive(null)
      return { result: 'committed' }
    }
    const token = ++tokenRef.current
    const done = (): void =>
    {
      if (tokenRef.current === token)
      {
        setLive(null)
      }
    }
    outcome.then(done, done)
    return { result: 'committed', promise: outcome }
  }

  const flush = (): Settled =>
  {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    const pending = pendingRef.current
    pendingRef.current = null
    return pending === null ? { result: 'unchanged' } : commit(pending)
  }

  const flushRef = useRef(flush)
  useLayoutEffect(() =>
  {
    flushRef.current = flush
  })

  useEffect(() =>
  {
    return () =>
    {
      flushRef.current()
    }
  }, [])

  useImperativeHandle(ref, () => ({
    commitDraft: async (): Promise<CommitDraftResult> =>
    {
      const slider = flushRef.current()
      const field = await fieldRef.current?.commitDraft() ?? 'unchanged'
      await slider.promise
      if (field === 'invalid')
      {
        return 'invalid'
      }
      return slider.result === 'committed' || field === 'committed' ? 'committed' : 'unchanged'
    },
    focus: (): void =>
    {
      sliderRef.current?.focus()
    }
  }), [])

  const handleInput = (next: number): void =>
  {
    tokenRef.current++
    setLive({ value: next, base: value })
  }

  const handleSliderCommit = (next: number, source: SliderCommitSource): void =>
  {
    if (source === 'pointer')
    {
      pendingRef.current = next
      flush()
      return
    }
    pendingRef.current = next
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() =>
    {
      timerRef.current = undefined
      flushRef.current()
    }, STEP_COMMIT_DELAY_MS)
  }

  return (
    <div className={cx('flex flex-col', className)}>
      <FieldCaption htmlFor={sliderId} id={captionId} hint={hint} hintId={hintId}>{label}</FieldCaption>
      <div className="flex items-start gap-3">
        <div className={cx('min-w-0 flex-1', size === 'md' ? 'pt-1' : 'pt-0.5')} onBlur={() => flush()}>
          <Slider
            ref={sliderRef}
            id={sliderId}
            value={shown}
            min={min}
            max={max}
            step={step}
            bigStep={bigStep}
            labelledBy={captionId}
            describedBy={described}
            valueText={valueText}
            mixed={mixed}
            disabled={disabled}
            error={error}
            onInput={handleInput}
            onChange={handleSliderCommit}
          />
        </div>
        <NumberField
          ref={fieldRef}
          value={current ?? value}
          onCommit={onCommit}
          step={step}
          min={min}
          max={max}
          bigStep={bigStep}
          decimals={decimals}
          unit={unit}
          valueText={valueText}
          labelledBy={`${captionId} ${exactId}`}
          describedBy={described}
          size={size}
          disabled={disabled}
          error={error}
          className={cx('shrink-0', error && '[&>[data-tone]]:hidden')}
        />
        <VisuallyHidden id={exactId}>{EXACT_VALUE_LABEL}</VisuallyHidden>
      </div>
    </div>
  )
}
