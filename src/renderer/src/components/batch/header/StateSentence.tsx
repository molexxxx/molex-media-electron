import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type Ref } from 'react'
import { PART_SEPARATOR } from '../../../copy/batch'
import
{
  fitSentence,
  SHED_LEVELS,
  sentenceText,
  shedSentence,
  type AttentionButton,
  type SentencePart,
  type ShedLevel,
  type StateSentence as SentenceModel
} from '../../../stores/batchHeader'
import { Button } from '../../../ui/Button'
import { StatusLabel } from '../../../ui/StatusLabel'
import { Tooltip } from '../../../ui/Tooltip'

/** Props for {@link StateSentence}. */
export interface StateSentenceProps
{
  sentence: SentenceModel
  /** The batch's jobs that need attention; drawn as the button at the end of the sentence. */
  attention: AttentionButton | null
  onShowAttention: (attention: AttentionButton) => void
  /** The shedding step the view width forces at least; below 700 px of view only counts and problems stay. */
  minLevel?: ShedLevel
  /** The id of the full sentence, which the header names as its accessible description. */
  descriptionId: string
  attentionRef?: Ref<HTMLButtonElement>
}

interface PartsViewProps
{
  parts: readonly SentencePart[]
  attention: AttentionButton | null
  probe: boolean
  onShowAttention?: (attention: AttentionButton) => void
  attentionRef?: Ref<HTMLButtonElement>
  fullText?: string
}

const LEADING_VALUE = /^([+−-]?\d[\d.,:]*(?:\s(?:B|KB|MB|GB|TB|h|min|s)\b)?)\s+(.+)$|^([+−-]?\d[\d.,:]*\s(?:B|KB|MB|GB|TB))$/u

/** A part's lit value and its quieter unit: "12 jobs" reads 12 in amber, then jobs; text without a leading number stays whole. */
export function readoutOf(text: string): { value: string, unit: string } | null
{
  const match = LEADING_VALUE.exec(text)
  if (match === null)
  {
    return null
  }
  return match[3] !== undefined ? { value: match[3], unit: '' } : { value: match[1], unit: match[2] }
}

function wordOf(part: SentencePart): ReactElement | string
{
  if (part.tone === 'warning')
  {
    return <StatusLabel status="warning" label={part.text} size="md" />
  }
  const readout = readoutOf(part.text)
  if (readout === null)
  {
    return <span className="text-section text-ink-2">{part.text}</span>
  }
  const alarm = part.kind === 'blocked'
  return (
    <span className="whitespace-nowrap" data-readout={part.kind}>
      <span className={alarm ? 'font-display text-[1.125rem] leading-6 font-semibold tabular-nums text-error' : 'type-readout text-[1.125rem] leading-6 font-semibold'}>{readout.value}</span>
      {readout.unit !== '' && <>{' '}<span className="ms-0.5 text-label text-ink-3">{readout.unit}</span></>}
    </span>
  )
}

function PartsView({ parts, attention, probe, onShowAttention, attentionRef, fullText = '' }: PartsViewProps): ReactElement
{
  const words = parts.filter((part) => part.kind !== 'attention')
  const flagged = parts.find((part) => part.kind === 'attention') ?? null
  const button = flagged !== null && attention !== null
    ? (
      <Button
        ref={attentionRef}
        size="sm"
        variant="ghost"
        className="shrink-0"
        data-slot={probe ? undefined : 'attention'}
        onClick={() => onShowAttention?.(attention)}
      >
        <StatusLabel status="failed" label={flagged.text} />
      </Button>
    )
    : null
  const text = (
    <span className="flex min-w-0 items-baseline gap-5 overflow-hidden">
      {words.map((part, index) => (
        <Fragment key={`${part.kind}-${index}`}>
          {index > 0 && <span className="sr-only">{PART_SEPARATOR}</span>}
          {wordOf(part)}
        </Fragment>
      ))}
      {button !== null && words.length > 0 && <span className="sr-only">{PART_SEPARATOR}</span>}
    </span>
  )
  if (probe)
  {
    return <>{text}{button}</>
  }
  return (
    <>
      <Tooltip content={fullText}>{text}</Tooltip>
      {button !== null && attention !== null && <Tooltip content={attention.tooltip}>{button}</Tooltip>}
    </>
  )
}

interface Step
{
  level: ShedLevel
  parts: SentencePart[]
  text: string
}

function distinctSteps(sentence: SentenceModel): Step[]
{
  const steps: Step[] = []
  for (const level of SHED_LEVELS)
  {
    const parts = shedSentence(sentence, level)
    const text = sentenceText(parts)
    if (!steps.some((step) => step.text === text))
    {
      steps.push({ level, parts, text })
    }
  }
  return steps
}

/**
 * The state sentence of row 1. It sheds the media time, then the size, then shortens the problems until it fits
 * beside the controls, so row 1 never wraps; blocked, warning, and need-attention parts are never dropped. The full
 * sentence stays in the tooltip and in the hidden description the header points at. Plain text, not live.
 */
export function StateSentence({ sentence, attention, onShowAttention, minLevel = 0, descriptionId, attentionRef }: StateSentenceProps): ReactElement
{
  const [level, setLevel] = useState<ShedLevel>(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const probesRef = useRef<HTMLDivElement>(null)
  const latest = useRef(sentence)
  const steps = useMemo(() => distinctSteps(sentence), [sentence])

  useLayoutEffect(() =>
  {
    latest.current = sentence
  })

  const measure = useCallback((): void =>
  {
    const box = boxRef.current
    const probes = probesRef.current
    if (box === null || probes === null)
    {
      return
    }
    const available = box.clientWidth
    if (available <= 0)
    {
      return
    }
    const widths = new Map<string, number>()
    for (const probe of Array.from(probes.children))
    {
      if (probe instanceof HTMLElement)
      {
        widths.set(probe.dataset.probeText ?? '', probe.getBoundingClientRect().width)
      }
    }
    setLevel(fitSentence(latest.current, (text) => (widths.get(text) ?? 0) <= available).level)
  }, [])

  useLayoutEffect(() =>
  {
    measure()
  }, [measure, sentence.full, attention?.label, minLevel])

  useEffect(() =>
  {
    const box = boxRef.current
    if (box === null)
    {
      return
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    observer?.observe(box)
    let live = true
    void document.fonts?.ready.then(() =>
    {
      if (live)
      {
        measure()
      }
    })
    return () =>
    {
      live = false
      observer?.disconnect()
    }
  }, [measure])

  const shown = Math.max(level, minLevel) as ShedLevel
  const parts = shedSentence(sentence, shown)
  const shed = sentenceText(parts) !== sentence.full

  return (
    <div
      ref={boxRef}
      className="relative flex min-w-0 flex-1 items-center gap-4 overflow-hidden whitespace-nowrap text-body text-ink"
      data-sentence=""
      data-shed-level={shown}
    >
      <PartsView
        parts={parts}
        attention={attention}
        probe={false}
        onShowAttention={onShowAttention}
        attentionRef={attentionRef}
        fullText={shed ? sentence.full : ''}
      />
      <span id={descriptionId} hidden>{sentence.full}</span>
      <div ref={probesRef} aria-hidden inert className="pointer-events-none invisible absolute start-0 top-0 flex w-max flex-col">
        {steps.map((step) => (
          <div key={step.level} data-probe-text={step.text} className="flex w-max items-center gap-4">
            <PartsView parts={step.parts} attention={attention} probe />
          </div>
        ))}
      </div>
    </div>
  )
}
