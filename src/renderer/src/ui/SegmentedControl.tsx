import { useId, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName } from './icons'
import { FieldMessage } from './NumberField'

/** A value a segment can carry. */
export type SegmentValue = string | number | boolean

/** One segment of a {@link SegmentedControl}. */
export interface SegmentOption<T extends SegmentValue>
{
  value: T
  label: string
  icon?: IconName
  /** Skipped by the arrow keys and drawn in disabled ink. */
  disabled?: boolean
  /** A sentence the segment's `aria-describedby` reads, such as what the choice does. */
  description?: string
}

/** Props for {@link SegmentedControl}. */
export interface SegmentedControlProps<T extends SegmentValue>
{
  /** The checked value; null while the selected jobs disagree, which checks no segment. */
  value: T | null
  onChange(value: T): void
  options: ReadonlyArray<SegmentOption<T>>
  label?: string
  /** The FieldCaption id that names the group. */
  labelledBy?: string
  /** Descriptions for the group, such as the caption's hint id (which reads "Mixed" while mixed). */
  describedBy?: string
  /** `md` is 32 px with 28 px segments, `sm` 28 px with 24 px segments. */
  size?: 'sm' | 'md'
  /** Takes the whole group out of the tab order. */
  disabled?: boolean
  error?: string
  /** Classes for the outer box that holds the group and its message. */
  className?: string
}

const FRAME = {
  md: 'h-(--size-control-md)',
  sm: 'h-7'
} as const

const SEGMENT = {
  md: 'h-7 px-3 text-control',
  sm: 'h-(--size-control-sm) px-2 text-label font-medium'
} as const

/**
 * A row of mutually exclusive choices in one framed well, with the APG radio group keyboard: one Tab stop
 * on the checked segment, arrows that move and check (wrapping, skipping disabled segments), Home and End,
 * and Space to check a focused segment while none is checked. A null value checks nothing and leaves the
 * first enabled segment tabbable.
 */
export function SegmentedControl<T extends SegmentValue>({
  value,
  onChange,
  options,
  label,
  labelledBy,
  describedBy,
  size = 'md',
  disabled = false,
  error,
  className
}: SegmentedControlProps<T>): ReactElement
{
  const baseId = useId()
  const errorId = `${baseId}-error`
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = options.map((option) => !disabled && !option.disabled)
  const checkedIndex = value === null ? -1 : options.findIndex((option) => option.value === value)
  const tabIndexAt = checkedIndex !== -1 && enabled[checkedIndex] ? checkedIndex : enabled.indexOf(true)

  const choose = (index: number): void =>
  {
    buttonsRef.current[index]?.focus()
    if (options[index].value !== value)
    {
      onChange(options[index].value)
    }
  }

  const nextEnabled = (from: number, direction: 1 | -1): number =>
  {
    for (let offset = 1; offset < options.length; offset++)
    {
      const index = (from + direction * offset + options.length) % options.length
      if (enabled[index])
      {
        return index
      }
    }
    return from
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void =>
  {
    if (event.altKey || event.ctrlKey || event.metaKey)
    {
      return
    }
    let target: number
    switch (event.key)
    {
      case 'ArrowRight':
      case 'ArrowDown':
        target = nextEnabled(index, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        target = nextEnabled(index, -1)
        break
      case 'Home':
        target = enabled.indexOf(true)
        break
      case 'End':
        target = enabled.lastIndexOf(true)
        break
      case ' ':
        target = index
        break
      default:
        return
    }
    event.preventDefault()
    choose(target)
  }

  return (
    <span className={cx('inline-flex flex-col items-start gap-1', className)}>
      <span
        role="radiogroup"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={cx(describedBy, error && errorId) || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-disabled={disabled || undefined}
        className={cx(
          'inline-flex items-center gap-0.5 rounded-sm bg-sunken p-0.5 outline -outline-offset-1',
          error ? 'outline-error-fill' : 'outline-line-strong',
          FRAME[size]
        )}
      >
        {options.map((option, index) =>
        {
          const checked = index === checkedIndex
          const descriptionId = option.description ? `${baseId}-description-${index}` : undefined
          return (
            <button
              key={String(option.value)}
              ref={(element) =>
              {
                buttonsRef.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-describedby={descriptionId}
              tabIndex={index === tabIndexAt ? 0 : -1}
              disabled={!enabled[index]}
              className={cx(
                'inline-flex min-w-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xs transition-colors duration-fast ease-out',
                SEGMENT[size],
                checked
                  ? 'bg-raised text-ink inset-ring inset-ring-line-control'
                  : 'text-ink-2 enabled:hover:bg-wash-hover enabled:hover:text-ink enabled:active:bg-wash-pressed',
                'disabled:text-ink-disabled'
              )}
              onClick={() => choose(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {option.icon && <Icon name={option.icon} size={size === 'sm' ? 'sm' : 'md'} />}
              {option.label}
            </button>
          )
        })}
      </span>
      {options.map((option, index) => option.description && (
        <span key={String(option.value)} id={`${baseId}-description-${index}`} hidden>{option.description}</span>
      ))}
      {error && <FieldMessage id={errorId} bounded={false}>{error}</FieldMessage>}
    </span>
  )
}
