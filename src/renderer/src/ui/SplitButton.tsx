import type { ReactElement } from 'react'
import { Button, type ButtonProps } from './Button'
import { cx } from './cx'
import { IconButton, type IconButtonVariant } from './IconButton'
import { Menu, type MenuEntry } from './Menu'

/** Props for {@link SplitButton}: every Button prop for the main part, plus the related actions behind the chevron. */
export interface SplitButtonProps extends ButtonProps
{
  /** The related actions, such as "Start only the 8 selected jobs". */
  items: MenuEntry[]
  /** The main action's name inside the chevron's name "More {action} options", such as "start". */
  actionName: string
  /** Disables the chevron while none of the related actions apply. */
  menuDisabled?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

/**
 * A Button joined to a chevron IconButton that opens a Menu of related actions. The two parts share a height
 * and are one Tab stop each. The main part takes every Button prop, so `loading` and `unavailableReason` behave
 * exactly as on a Button; the chevron follows its variant, except that it is never primary while the main part
 * is disabled or unavailable.
 */
export function SplitButton({
  items,
  actionName,
  menuDisabled,
  onMenuOpenChange,
  variant = 'secondary',
  size = 'md',
  className,
  ...buttonProps
}: SplitButtonProps): ReactElement
{
  const mainDisabled = Boolean(buttonProps.disabled) || Boolean(buttonProps.unavailableReason)
  const chevronVariant: IconButtonVariant = variant === 'primary' && mainDisabled ? 'secondary' : variant
  const name = `More ${actionName} options`

  return (
    <span className="inline-flex shrink-0 items-stretch gap-px">
      <Button {...buttonProps} variant={variant} size={size} className={cx('rounded-e-none', className)} />
      <Menu
        label={name}
        items={items}
        align="end"
        onOpenChange={onMenuOpenChange}
        trigger={<IconButton label={name} icon="action.openMenu" size={size} variant={chevronVariant} disabled={menuDisabled} className="rounded-s-none" />}
      />
    </span>
  )
}
