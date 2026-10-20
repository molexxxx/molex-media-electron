import { useId, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { FieldMessage } from './NumberField'

/** A value a radio option can carry. */
export type RadioValue = string | number | boolean

/** One option of a {@link RadioList}. */
export interface RadioOption<T extends RadioValue>
{
  value: T
  label: string
  /** The consequence of the choice, shown under the label and read through `aria-describedby`. */
  description?: string
  /** Skipped by the arrow keys and drawn in disabled ink. */
  disabled?: boolean
  /** Why the option is disabled, shown under it and read through `aria-describedby`. */
  disabledReason?: string
  /** One field that belongs to the option, enabled only while the option is checked and reached by Tab after the group. */
  field?: ReactNode
}

/** Props for {@link RadioList}. */
export interface RadioListProps<T extends RadioValue>
{
  /** The checked value; null while the selected jobs disagree, which checks no option. */
  value: T | null
  onChange(value: T): void
  options: ReadonlyArray<RadioOption<T>>
  /** The FieldCaption id that names the group. */
  labelledBy: string
  /** Descriptions for the group, such as the caption's hint id (which reads "Mixed" while mixed). */
  describedBy?: string
  error?: string
  disabled?: boolean
  /** Classes for the outer box that holds the group and its message. */
  className?: string
}

/**
 * A vertical radio group for choices whose consequences need a sentence. Each option is a native radio in
 * its own label row of at least 24 px, with its description linked through `aria-describedby`, and may own
 * one nested field that is enabled only while the option is checked. The keyboard is the APG radio group:
 * one Tab stop, Up and Down (and Left and Right) move and check with wrap, skipping disabled options. A null
 * value checks nothing and leaves the first enabled option tabbable.
 */
export function RadioList<T extends RadioValue>({
  value,
  onChange,
  options,
  labelledBy,
  describedBy,
  error,
  disabled = false,
  className
}: RadioListProps<T>): ReactElement
{
  const baseId = useId()
  const errorId = `${baseId}-error`
  const inputsRef = useRef<Array<HTMLInputElement | null>>([])
  const enabled = options.map((option) => !disabled && !option.disabled)
  const checkedIndex = value === null ? -1 : options.findIndex((option) => option.value === value)
  const tabIndexAt = checkedIndex !== -1 && enabled[checkedIndex] ? checkedIndex : enabled.indexOf(true)

  const choose = (index: number): void =>
  {
    inputsRef.current[index]?.focus()
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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number): void =>
  {
    if (event.altKey || event.ctrlKey || event.metaKey)
    {
      return
    }
    let target: number
    switch (event.key)
    {
      case 'ArrowDown':
      case 'ArrowRight':
        target = nextEnabled(index, 1)
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        target = nextEnabled(index, -1)
        break
      default:
        return
    }
    event.preventDefault()
    choose(target)
  }

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-describedby={cx(describedBy, error && errorId) || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-disabled={disabled || undefined}
        className="flex flex-col gap-1"
      >
        {options.map((option, index) =>
        {
          const checked = index === checkedIndex
          const descriptionId = option.description ? `${baseId}-description-${index}` : undefined
          const reasonId = option.disabled && option.disabledReason ? `${baseId}-reason-${index}` : undefined
          return (
            <div key={String(option.value)} className="flex flex-col">
              <label
                className={cx(
                  'inline-flex min-h-(--size-target-min) items-center gap-2 self-start text-body',
                  enabled[index] ? 'text-ink' : 'text-ink-disabled'
                )}
              >
                <input
                  ref={(element) =>
                  {
                    inputsRef.current[index] = element
                  }}
                  type="radio"
                  name={baseId}
                  value={String(option.value)}
                  checked={checked}
                  disabled={!enabled[index]}
                  tabIndex={index === tabIndexAt ? 0 : -1}
                  aria-invalid={Boolean(error) || undefined}
                  aria-describedby={cx(descriptionId, reasonId) || undefined}
                  className="ui-radio"
                  onChange={() => choose(index)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                />
                <span className="min-w-0">{option.label}</span>
              </label>
              {descriptionId && (
                <span id={descriptionId} className={cx('ps-6 text-label', enabled[index] ? 'text-ink-2' : 'text-ink-disabled')}>
                  {option.description}
                </span>
              )}
              {reasonId && <span id={reasonId} className="ps-6 text-label text-ink-3">{option.disabledReason}</span>}
              {option.field !== undefined && (
                <fieldset disabled={!checked || !enabled[index]} className="min-w-0 ps-6 pt-1">
                  {option.field}
                </fieldset>
              )}
            </div>
          )
        })}
      </div>
      {error && <FieldMessage id={errorId} bounded={false}>{error}</FieldMessage>}
    </div>
  )
}
