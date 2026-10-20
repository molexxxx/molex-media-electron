import type { ComponentPropsWithRef, ReactElement } from 'react'
import { cx } from './cx'

/** Props for {@link VisuallyHidden}: any span attribute, so an `id` can feed `aria-describedby`. */
export type VisuallyHiddenProps = ComponentPropsWithRef<'span'>

/**
 * Text for assistive technology only, clipped to a 1 px box. It is not selectable, so copying the
 * visible text next to it never doubles the words.
 */
export function VisuallyHidden({ className, ...rest }: VisuallyHiddenProps): ReactElement
{
  return <span {...rest} className={cx('sr-only select-none', className)} />
}
