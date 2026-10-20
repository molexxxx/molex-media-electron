import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { HEADER_TOOLTIPS, PART_SEPARATOR } from '../../../copy/batch'
import type { ConsequenceLine as ConsequenceModel } from '../../../stores/batchHeader'
import { ProgressBar } from '../../../ui/ProgressBar'
import { StatusLabel } from '../../../ui/StatusLabel'
import { Tooltip } from '../../../ui/Tooltip'

/** Props for {@link ConsequenceLine}. */
export interface ConsequenceLineProps
{
  line: ConsequenceModel | null
  /** The batch the progress belongs to, such as "Batch 31", which names the bar. */
  batchName: string
}

function useOverflowing(text: string): [RefObject<HTMLSpanElement | null>, boolean]
{
  const ref = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() =>
  {
    const element = ref.current
    if (element !== null)
    {
      setOverflowing(element.scrollWidth > element.clientWidth)
    }
  }, [text])

  useEffect(() =>
  {
    const element = ref.current
    if (element === null || typeof ResizeObserver === 'undefined')
    {
      return
    }
    const observer = new ResizeObserver(() => setOverflowing(element.scrollWidth > element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, overflowing]
}

function SentenceText({ text, warning }: { text: string; warning: boolean }): ReactElement
{
  const [ref, overflowing] = useOverflowing(text)
  return (
    <Tooltip content={overflowing ? text : ''}>
      <span ref={ref} className="block min-w-0 truncate text-label text-ink-3">
        {warning ? <StatusLabel status="warning" label={text} size="md" /> : text}
      </span>
    </Tooltip>
  )
}

function spokenPercent(percent: number): string
{
  return `${Math.floor(Math.min(100, Math.max(0, percent)))} percent`
}

/**
 * Row 2 of the run header: the output policy as a sentence before a run (a warning StatusLabel under Replace
 * originals), the batch's progress bar with time left and throughput during one, and what happened after one.
 */
export function ConsequenceLine({ line, batchName }: ConsequenceLineProps): ReactElement | null
{
  if (line === null)
  {
    return null
  }
  if (line.kind === 'progress')
  {
    const spoken = [spokenPercent(line.percent), line.status, line.timeLeft, line.throughput].filter((value) => value !== null).join(', ')
    return (
      <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap text-label text-ink-3" data-consequence="progress">
        <ProgressBar
          value={Math.min(1, Math.max(0, line.percent / 100))}
          label={`${batchName} progress`}
          valueText={spoken}
          size="md"
          tone="meter"
          showValue={false}
          className="w-80 max-w-[45%] shrink-0"
        />
        <span className="type-readout text-label font-semibold">{line.percentText}</span>
        {line.status !== null && <StatusLabel status="paused" label={line.status} size="md" />}
        <span className="min-w-0 truncate">
          {line.timeLeft !== null && (
            <Tooltip content={HEADER_TOOLTIPS.timeLeft}>
              <span data-part="time-left">{line.timeLeft}</span>
            </Tooltip>
          )}
          {line.timeLeft !== null && line.throughput !== null && PART_SEPARATOR}
          {line.throughput !== null && (
            <Tooltip content={HEADER_TOOLTIPS.throughput}>
              <span data-part="throughput">{line.throughput}</span>
            </Tooltip>
          )}
        </span>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center" data-consequence={line.kind === 'policy' && line.warning ? 'warning' : line.kind}>
      <SentenceText text={line.text} warning={line.kind === 'policy' && line.warning} />
    </div>
  )
}
