import type { ReactElement } from 'react'
import { Button, Tooltip, type ButtonProps } from '../../../ui'

/** Props for {@link TooltipButton}. */
export interface TooltipButtonProps extends ButtonProps
{
  /** The tooltip text; an empty string renders the button alone. */
  tip: string
}

/**
 * A Button with a Tooltip that forwards every prop, ref included, to the button, so a Popover can use it as
 * its trigger: the popover's handlers and state reach the button, and the tooltip keeps its own.
 */
export function TooltipButton({ tip, ...props }: TooltipButtonProps): ReactElement
{
  return (
    <Tooltip content={tip}>
      <Button {...props} />
    </Tooltip>
  )
}
