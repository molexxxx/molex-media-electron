import { useState, type ReactElement, type ReactNode } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'
import { IconButton } from './IconButton'
import type { IconName } from './icons'

/** A banner's tone, which picks its wash, frame, icon, and role. */
export type BannerTone = 'info' | 'success' | 'warning' | 'error'

/** Props for {@link Banner}. */
export interface BannerProps
{
  tone: BannerTone
  /** The first sentence, in ink; the children then read as secondary text. */
  title?: string
  children: ReactNode
  /** Controls laid out under the text, usually sm Buttons. */
  actions?: ReactNode
  /** Shows the Dismiss control; it is called after the banner hides itself. */
  onDismiss?: () => void
  /** A notice that stays until dismissed or resolved: it always offers Dismiss and carries `data-held`. */
  held?: boolean
  /** Overrides the role; pass `status` when the same event is already spoken elsewhere, such as through the toast region. */
  role?: 'status' | 'alert'
  className?: string
}

const TONE_ICON: Record<BannerTone, IconName> = {
  info: 'action.info',
  success: 'status.done',
  warning: 'status.warning',
  error: 'status.failed'
}

const TONE_LOOK: Record<BannerTone, { ground: string, ink: string }> = {
  info: { ground: 'bg-wash-running inset-ring-running/45', ink: 'text-running' },
  success: { ground: 'bg-wash-verified inset-ring-verified/45', ink: 'text-verified' },
  warning: { ground: 'bg-wash-warning inset-ring-warning/45', ink: 'text-warning' },
  error: { ground: 'bg-wash-error inset-ring-error-fill/45', ink: 'text-error' }
}

/**
 * An in-flow notice on its tone's wash, framed by a faint inset line, with no side stripe. Info, success,
 * and warning banners are statuses; an error banner that appears after the document has loaded is an alert,
 * so a notice already present at launch is not read out over the page. Dismiss hides the banner and calls
 * `onDismiss`; a held banner always offers Dismiss and stays until then, or until its owner removes it once
 * the condition is resolved. Give each notice its own key, since a dismissed banner stays hidden.
 */
export function Banner({ tone, title, children, actions, onDismiss, held = false, role, className }: BannerProps): ReactElement | null
{
  const [afterLoad] = useState(() => document.readyState === 'complete')
  const [dismissed, setDismissed] = useState(false)
  if (dismissed)
  {
    return null
  }
  const look = TONE_LOOK[tone]
  const dismiss = (): void =>
  {
    setDismissed(true)
    onDismiss?.()
  }
  return (
    <div
      role={role ?? (tone === 'error' && afterLoad ? 'alert' : 'status')}
      data-tone={tone}
      data-held={held ? '' : undefined}
      className={cx('flex items-start gap-2 rounded-sm px-2.5 py-2 inset-ring', look.ground, className)}
    >
      <Icon name={TONE_ICON[tone]} size="md" className={cx('mt-0.5 shrink-0', look.ink)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="text-body font-semibold text-ink">{title}</p> : null}
        <div className={title ? 'text-label text-ink-2' : 'text-body text-ink'}>{children}</div>
        {actions ? <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div> : null}
      </div>
      {held || onDismiss
        ? <IconButton size="sm" icon="action.close" label="Dismiss" className="-me-1 -mt-0.5" onClick={dismiss} />
        : null}
    </div>
  )
}
