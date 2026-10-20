import { useId, useImperativeHandle, useLayoutEffect, useRef, type ChangeEvent, type ComponentPropsWithRef, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { FieldMessage } from './NumberField'
import { Tooltip } from './Tooltip'

/** Props for {@link Checkbox}: the native checkbox attributes plus the label, mixed, error, and reason props. */
export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'children' | 'className' | 'aria-describedby' | 'aria-disabled' | 'aria-invalid'>
{
  /** The label row's content, which names the box. */
  children: ReactNode
  /** The mixed state: activating it checks the box, as the platform clears the flag. */
  indeterminate?: boolean
  describedBy?: string
  error?: string
  /** Keeps the box focusable with `aria-disabled`, ignores activation, and shows this reason under the label and as the row's tooltip. */
  unavailableReason?: string
  /** Classes for the outer box that holds the label row and its messages. */
  className?: string
}

/**
 * A native checkbox drawn at 16 px inside its own label row of at least 24 px, which is its target and
 * its name. `indeterminate` is the mixed state of inspector booleans, and it holds until the prop drops
 * it, so a commit that has not landed never shows one job's value. When `unavailableReason` is set it
 * wins over `disabled`, so the box stays in the tab order and can explain itself, inline and in the row's
 * tooltip; React reports a change from a click even when the click is canceled, so `onChange` is held back too.
 */
export function Checkbox({
  children,
  indeterminate = false,
  describedBy,
  error,
  unavailableReason,
  disabled,
  className,
  onClick,
  onChange,
  ref,
  ...rest
}: CheckboxProps): ReactElement
{
  const inputRef = useRef<HTMLInputElement>(null)
  const reasonId = useId()
  const errorId = useId()
  const unavailable = Boolean(unavailableReason)
  const nativeDisabled = Boolean(disabled) && !unavailable

  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, [])

  useLayoutEffect(() =>
  {
    (inputRef.current as HTMLInputElement).indeterminate = indeterminate
  })

  const handleClick = (event: MouseEvent<HTMLInputElement>): void =>
  {
    if (unavailable)
    {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void =>
  {
    if (unavailable)
    {
      return
    }
    onChange?.(event)
    if (indeterminate)
    {
      event.currentTarget.indeterminate = true
    }
  }

  return (
    <span className={cx('inline-flex flex-col items-start', className)}>
      <Tooltip content={unavailableReason ?? ''} mode="label" placement="end">
        <label
          className={cx(
            'inline-flex min-h-(--size-target-min) items-center gap-2 text-body',
            nativeDisabled || unavailable ? 'text-ink-disabled' : 'text-ink'
          )}
        >
          <input
            {...rest}
            ref={inputRef}
            type="checkbox"
            disabled={nativeDisabled}
            aria-disabled={unavailable || undefined}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={cx(describedBy, unavailable && reasonId, error && errorId) || undefined}
            className="ui-checkbox"
            onClick={handleClick}
            onChange={handleChange}
          />
          <span className="min-w-0">{children}</span>
        </label>
      </Tooltip>
      {unavailable && <span id={reasonId} className="ps-6 text-label text-ink-3">{unavailableReason}</span>}
      {error && <FieldMessage id={errorId} bounded={false} className="ps-6">{error}</FieldMessage>}
    </span>
  )
}
