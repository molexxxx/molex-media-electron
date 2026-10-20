import type { ReactElement, ReactNode } from 'react'
import { LucideProvider } from 'lucide-react'
import { cx } from './cx'
import { ICONS, ICON_SIZES, ICON_STROKE_WIDTH, type IconName, type IconSize } from './icons'

/** Props for {@link Icon}. There is no naming prop: an icon always sits beside a word or inside a named control. */
export interface IconProps
{
  name: IconName
  size?: IconSize
  /** Rotates the glyph for an active stage; reduced motion keeps it still. */
  spin?: boolean
  className?: string
}

/**
 * A registry glyph, hidden from assistive technology and drawn in `currentColor`, so state always needs
 * a word beside it. The line weight comes from {@link IconProvider}.
 */
export function Icon({ name, size = 'md', spin = false, className }: IconProps): ReactElement
{
  const Glyph = ICONS[name]
  return (
    <Glyph
      aria-hidden="true"
      data-icon={name}
      size={ICON_SIZES[size]}
      className={cx('shrink-0', spin && 'motion-safe:animate-spin', className)}
    />
  )
}

/** The app root's icon stroke: one 1.5 px line at every size, for registry icons and direct lucide imports alike. */
export function IconProvider({ children }: { children?: ReactNode }): ReactElement
{
  return (
    <LucideProvider strokeWidth={ICON_STROKE_WIDTH} absoluteStrokeWidth>
      {children}
    </LucideProvider>
  )
}
