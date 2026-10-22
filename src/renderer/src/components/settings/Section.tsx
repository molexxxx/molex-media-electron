/**
 * The frames the Settings tabs share: a section with its legend and one explanatory line, and a row with the
 * label and hint at the left and the control, its messages, and its error at the right.
 */
import type { ReactElement, ReactNode } from 'react'

/** Props for {@link Section}. */
export interface SectionProps
{
  /** The legend's id, which names the section. */
  id: string
  title: string
  lead?: ReactNode
  children: ReactNode
}

/** A settings section: the legend, its lead, and the rows under them, separated from the section above by a line. */
export function Section({ id, title, lead, children }: SectionProps): ReactElement
{
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <h2 id={id} className="type-legend text-accent-ink">{title}</h2>
      {lead !== undefined && <div className="text-label text-ink-2">{lead}</div>}
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/** Props for {@link Row}. */
export interface RowProps
{
  /** The label's id, which names a group control through `labelledBy`; the hint takes `${id}-hint`. */
  id: string
  label: string
  /** Names a single control through `<label for>`. */
  htmlFor?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
}

/** One setting: its label and hint in the first column, the control and what it reports in the second. */
export function Row({ id, label, htmlFor, hint, error, children }: RowProps): ReactElement
{
  return (
    <div className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor === undefined
          ? <span id={id} className="text-body text-ink">{label}</span>
          : <label id={id} htmlFor={htmlFor} className="text-body text-ink">{label}</label>}
        {hint !== undefined && <p id={`${id}-hint`} className="text-label text-ink-3">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {error !== undefined && <p role="alert" className="text-label text-error">{error}</p>}
      </div>
    </div>
  )
}
