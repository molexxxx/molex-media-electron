import type { ReactElement } from 'react'
import { cx } from './cx'
import { VisuallyHidden } from './VisuallyHidden'

/** Props for {@link CapsText}. `children` is the sentence-case text; `className` styles the visible uppercase copy. */
export interface CapsTextProps
{
  children: string
  className?: string
}

/**
 * Uppercase text whose accessible name stays sentence case: Chromium exposes CSS-transformed text to
 * assistive technology, so the uppercase copy is hidden and a visually hidden copy carries the name.
 */
export function CapsText({ children, className }: CapsTextProps): ReactElement
{
  return (
    <>
      <span aria-hidden="true" className={cx('uppercase', className)}>{children}</span>
      <VisuallyHidden>{children}</VisuallyHidden>
    </>
  )
}
