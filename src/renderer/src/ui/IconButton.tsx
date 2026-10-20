import type { ComponentPropsWithRef, ReactElement } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import type { IconName, IconSize } from './icons'
import { ariaKeyShortcuts, splitChord, usePlatform } from './Kbd'
import { Tooltip } from './Tooltip'

/** `sm` 24 px, `md` 32 px, `lg` 40 px square; `caption` is the 46 x 40 px window caption button. */
export type IconButtonSize = 'sm' | 'md' | 'lg' | 'caption'

/** Visual role, as Button; `primary` only for a view's main action, such as the player's Play. */
export type IconButtonVariant = 'ghost' | 'secondary' | 'danger' | 'primary'

/** Props for {@link IconButton}: the native button attributes plus the name, glyph, and state props. */
export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label' | 'aria-pressed' | 'aria-keyshortcuts'>
{
  /** The accessible name, repeated by the tooltip; it must not be empty. */
  label: string
  icon: IconName
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** A toggle's state; leave it undefined for a plain action. */
  pressed?: boolean
  /** A chord such as "Mod+P", exposed as `aria-keyshortcuts` and drawn in the tooltip. */
  shortcut?: string
  /** Shows the label and shortcut on hover and keyboard focus. */
  tooltip?: boolean
}

const BASE = 'ui-icon-button inline-flex shrink-0 items-center justify-center border transition-colors duration-fast ease-out'

const SIZES: Record<IconButtonSize, { box: string, glyph: IconSize }> = {
  sm: { box: 'size-(--size-control-sm) rounded-sm', glyph: 'sm' },
  md: { box: 'size-(--size-control-md) rounded-sm', glyph: 'md' },
  lg: { box: 'size-10 rounded-sm', glyph: 'lg' },
  caption: { box: 'h-(--size-titlebar) w-11.5 rounded-none', glyph: 'md' }
}

const REST: Record<IconButtonVariant, string> = {
  ghost: 'border-transparent bg-transparent text-ink-2',
  secondary: 'border-line-strong bg-raised text-ink',
  danger: 'border-error-fill bg-raised text-error',
  primary: 'border-transparent bg-accent text-on-accent'
}

const FEEDBACK: Record<IconButtonVariant, string> = {
  ghost: 'hover:bg-wash-hover hover:text-ink active:bg-wash-pressed active:text-ink',
  secondary: 'hover:bg-raised-hover active:bg-panel',
  danger: 'hover:bg-danger-hover active:bg-danger-pressed',
  primary: 'hover:bg-accent-hover active:bg-accent-pressed active:inset-shadow-2xs/20'
}

const DISABLED: Record<IconButtonVariant, string> = {
  ghost: 'border-transparent bg-transparent text-ink-disabled',
  secondary: 'border-line bg-transparent text-ink-disabled',
  danger: 'border-line bg-transparent text-ink-disabled',
  primary: 'border-line bg-raised text-ink-disabled'
}

const PRESSED = 'border-line-control bg-raised text-ink'
const WINDOW_CLOSE = { rest: REST.ghost, feedback: 'hover:bg-error-fill hover:text-ink active:bg-error-fill active:text-ink' }

/**
 * A glyph-only button on the native element, named by `label`. The tooltip repeats the label and shortcut
 * for sighted users and stays out of the accessibility tree, so the name is announced once. A pressed toggle
 * draws a neutral raised fill inside a control frame, never primary. The caption size fills the title bar at
 * the window's edge, so it rings inward, and its danger variant is the window's Close.
 */
export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  pressed,
  shortcut,
  tooltip = true,
  disabled,
  type = 'button',
  className,
  ...rest
}: IconButtonProps): ReactElement
{
  const platform = usePlatform()
  if (import.meta.env.DEV && !label.trim())
  {
    throw new Error('IconButton needs a label that names its action.')
  }
  const { box, glyph } = SIZES[size]
  const windowClose = size === 'caption' && variant === 'danger'
  const idle = windowClose ? WINDOW_CLOSE.rest : REST[variant]
  const look = disabled ? DISABLED[variant] : pressed ? PRESSED : idle
  const feedback = disabled ? null : windowClose ? WINDOW_CLOSE.feedback : FEEDBACK[variant]

  return (
    <Tooltip content={tooltip ? label : ''} mode="label" shortcut={shortcut}>
      <button
        {...rest}
        type={type}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut ? ariaKeyShortcuts(splitChord(shortcut), platform) : undefined}
        data-variant={variant}
        data-size={size}
        data-focus={size === 'caption' ? 'inset' : undefined}
        className={cx(BASE, box, look, feedback, className)}
      >
        <Icon name={icon} size={glyph} />
      </button>
    </Tooltip>
  )
}
