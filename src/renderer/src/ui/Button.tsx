import type { ComponentPropsWithRef, MouseEvent, ReactElement, ReactNode } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName, IconSize } from './icons'
import { Tooltip } from './Tooltip'

/** Visual role. `primary` is the one next action of a view region; `danger` names a destructive act. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** `md` is 32 px tall with control text; `sm` is 24 px tall with label text. */
export type ButtonSize = 'sm' | 'md'

/** Props for {@link Button}: the native button attributes plus the variant, size, icon, and state props. */
export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'>
{
  children: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** A registry key drawn before the label in the label color, at the size's icon step. */
  icon?: IconName
  /** A registry key drawn after the label. */
  iconEnd?: IconName
  /** Keeps the variant's look, swaps the label for `loadingLabel` with a spinner, and ignores activation. */
  loading?: boolean
  loadingLabel?: string
  /** Keeps the button focusable with `aria-disabled`, ignores activation, and describes it with this reason, also shown as its tooltip. */
  unavailableReason?: string
}

const BASE = 'inline-flex items-center justify-center whitespace-nowrap rounded-sm border transition-colors duration-fast ease-out'

const SIZES: Record<ButtonSize, { box: string, gap: string, glyph: IconSize }> = {
  md: { box: 'h-(--size-control-md) px-3 text-control', gap: 'gap-1.5', glyph: 'md' },
  sm: { box: 'h-(--size-control-sm) px-2 text-label', gap: 'gap-1', glyph: 'sm' }
}

const REST: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-brass text-on-brass',
  secondary: 'border-line-strong bg-raised text-ink',
  ghost: 'border-transparent bg-transparent text-ink-2',
  danger: 'border-error-fill bg-raised text-error'
}

const FEEDBACK: Record<ButtonVariant, string> = {
  primary: 'hover:bg-brass-hover active:bg-brass-pressed active:inset-shadow-2xs/20',
  secondary: 'hover:bg-raised-hover active:bg-panel',
  ghost: 'hover:bg-wash-hover hover:text-ink active:bg-wash-pressed active:text-ink',
  danger: 'hover:bg-danger-hover active:bg-danger-pressed'
}

const UNAVAILABLE: Record<ButtonVariant, string> = {
  primary: 'border-line bg-raised text-ink-disabled',
  secondary: 'border-line bg-transparent text-ink-disabled',
  ghost: 'border-transparent bg-transparent text-ink-disabled',
  danger: 'border-line bg-transparent text-ink-disabled'
}

const STACKED_ROW = 'col-start-1 row-start-1 inline-flex items-center justify-center'

/**
 * Text button on the native element. When `unavailableReason` is set it wins over `disabled`, so the
 * button stays in the tab order and can explain itself: the reason is its description and its tooltip,
 * which renders inside the button so the button stays a single element in its parent's layout. A button
 * that may load renders both labels in one grid cell, so its width never jumps when the label changes.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  loading,
  loadingLabel,
  unavailableReason,
  disabled,
  type = 'button',
  className,
  onClick,
  ref,
  'aria-describedby': ariaDescribedBy,
  ...rest
}: ButtonProps): ReactElement
{
  const unavailable = Boolean(unavailableReason)
  const nativeDisabled = Boolean(disabled) && !unavailable
  const busy = Boolean(loading)
  const interactive = !nativeDisabled && !unavailable && !busy
  const { box, gap, glyph } = SIZES[size]
  const weight = variant === 'primary' ? 'font-semibold' : size === 'sm' ? 'font-medium' : null
  const look = nativeDisabled || unavailable ? UNAVAILABLE[variant] : REST[variant]

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void =>
  {
    if (!interactive)
    {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  const label = (
    <>
      {icon && <Icon name={icon} size={glyph} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={glyph} />}
    </>
  )

  const body = loading === undefined && loadingLabel === undefined
    ? label
    : (
      <span className="grid">
        <span aria-hidden={busy || undefined} className={cx(STACKED_ROW, gap, busy && 'invisible')}>
          {label}
        </span>
        <span aria-hidden={busy ? undefined : true} className={cx(STACKED_ROW, gap, !busy && 'invisible')}>
          <Icon name="status.active" size={glyph} spin={busy} />
          {loadingLabel ?? children}
        </span>
      </span>
    )

  return (
    <Tooltip content={unavailableReason ?? ''} inside>
      <button
        {...rest}
        ref={ref}
        type={type}
        disabled={nativeDisabled}
        aria-disabled={unavailable || undefined}
        aria-busy={busy || undefined}
        aria-describedby={ariaDescribedBy}
        data-variant={variant}
        data-size={size}
        className={cx(BASE, box, gap, weight, look, interactive && FEEDBACK[variant], className)}
        onClick={handleClick}
      >
        {body}
      </button>
    </Tooltip>
  )
}
