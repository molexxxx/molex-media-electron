import { useId, type ReactElement } from 'react'
import { cx } from './cx'
import { VisuallyHidden } from './VisuallyHidden'

/** The word `required` adds to the hint. */
export const REQUIRED_LABEL = '(required)'

/** Props for {@link FieldCaption}. */
export interface FieldCaptionProps
{
  /** The single control this caption labels; the caption renders as its `<label>`. */
  htmlFor?: string
  /** The caption's own id, for a group or a second control that names itself with `aria-labelledby`. */
  id?: string
  /** The sentence-case caption, which is also the control's accessible name. */
  children: string
  /** A short note after the caption, such as a range, a unit, or "Mixed". */
  hint?: string
  /** The hint's id, which the paired control adds to its `aria-describedby`; by default `${htmlFor ?? id}-hint`. */
  hintId?: string
  required?: boolean
  className?: string
}

/** Caption metrics without the uppercase transform, which would reach the hidden sentence-case copy. */
const CAPTION = 'text-ink-2'

/** The id {@link FieldCaption} gives its hint unless `hintId` is set. */
export function hintIdFor(base: string): string
{
  return `${base}-hint`
}

/**
 * The typed label above a field: 11 px uppercase mono in secondary ink, 6 px above its control. The
 * uppercase copy is generated content on an `aria-hidden` span, and a visually hidden sentence-case copy
 * is the only text in the caption, so the control's name reads "Batch size" rather than spelled-out
 * capitals, by `<label for>` and by `aria-labelledby` alike. The hint follows in label type and normal
 * case, with an id the paired control references.
 */
export function FieldCaption({ htmlFor, id, children, hint, hintId, required = false, className }: FieldCaptionProps): ReactElement
{
  const fallbackId = useId()
  const resolvedHintId = hintId ?? hintIdFor(htmlFor ?? id ?? fallbackId)
  const described = Boolean(hint) || required
  const text = (
    <>
      <span aria-hidden="true" data-caption={children} className="type-caption before:content-[attr(data-caption)]" />
      <VisuallyHidden>{children}</VisuallyHidden>
    </>
  )

  return (
    <span className={cx('flex flex-wrap items-baseline gap-x-2 pb-1.5', className)}>
      {htmlFor === undefined
        ? <span id={id} className={CAPTION}>{text}</span>
        : <label htmlFor={htmlFor} id={id} className={CAPTION}>{text}</label>}
      {described && (
        <span id={resolvedHintId} className="text-label text-ink-3">
          {cx(hint, required && REQUIRED_LABEL)}
        </span>
      )}
    </span>
  )
}
