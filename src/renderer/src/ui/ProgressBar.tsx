import type { ReactElement } from 'react'
import { cx } from './cx'
import { useReducedMotion } from './platform'

/** Props for {@link ProgressBar}. */
export interface ProgressBarProps
{
  /** Progress from 0 to 1; leave it undefined while the amount of work is unknown. */
  value?: number
  /** The accessible name, for example "Encoding MM-0141". */
  label: string
  /** The spoken value, for example "46 percent, pass 1 of 2"; defaults to the percent. */
  valueText?: string
  /** `sm` draws a 4 px bar and `md` a 6 px bar inside the frame. */
  size?: 'sm' | 'md'
  /** `error` holds the fill where it stopped, in the error fill; `meter` lights it amber in segments for the run meter. */
  tone?: 'default' | 'error' | 'meter'
  /** Prints the percent after the bar; rows that already print it in a cell pass false. */
  showValue?: boolean
  className?: string
}

/** The word a static indeterminate bar shows when motion is reduced. */
export const PROGRESS_WORKING_LABEL = 'Working'

/**
 * A neutral progress bar inside a framed sunken track; status words carry the state, so the fill never
 * changes hue except to freeze in the error fill. Without a value it shows a traveling segment, or a
 * static hatch and the word "Working" under reduced motion. Its percent rounds down like every other
 * progress readout, so it never reads 100 before the work is done.
 */
export function ProgressBar({
  value,
  label,
  valueText,
  size = 'md',
  tone = 'default',
  showValue = true,
  className
}: ProgressBarProps): ReactElement
{
  const reducedMotion = useReducedMotion()
  const indeterminate = value === undefined || Number.isNaN(value)
  const fraction = indeterminate ? 0 : Math.min(1, Math.max(0, value))
  const percent = Math.floor(fraction * 100 + 1e-9)
  const spoken = valueText ?? (indeterminate ? PROGRESS_WORKING_LABEL : `${percent} percent`)
  const still = indeterminate && reducedMotion

  return (
    <div className={cx('flex min-w-0 items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent}
        aria-valuetext={spoken}
        data-size={size}
        data-tone={tone}
        data-indeterminate={indeterminate || undefined}
        data-static={still || undefined}
        className={cx(
          'ui-progress relative box-content min-w-0 flex-1 overflow-hidden rounded-xs border border-line-control bg-sunken',
          size === 'sm' ? 'h-1' : 'h-1.5'
        )}
      >
        <div
          className={cx(
            'ui-progress-fill h-full',
            !still && (tone === 'error' ? 'bg-error-fill' : tone === 'meter' ? 'bg-amber' : 'bg-ink-2'),
            !indeterminate && 'w-full origin-left transition-transform duration-base ease-out'
          )}
          style={indeterminate ? undefined : { transform: `scaleX(${fraction})` }}
        />
      </div>
      {showValue && (!indeterminate || still) && (
        <span aria-hidden="true" className="min-w-[4ch] shrink-0 text-end text-label text-ink-2 tabular-nums">
          {indeterminate ? PROGRESS_WORKING_LABEL : `${percent}%`}
        </span>
      )}
    </div>
  )
}
