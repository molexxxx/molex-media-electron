/**
 * @module editor/inspect/KeyframeView
 * Where the file's video keyframes fall, measured by FFprobe on request: how many there are, the usual and the
 * longest gap, and a strip with a mark at each one. Lossless trims start at a keyframe, so the gaps say how
 * close a lossless cut can land.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Button } from '../../../ui/Button'
import { FieldMessage } from '../../../ui/NumberField'
import { ProgressBar } from '../../../ui/ProgressBar'
import { useCanvasPalette } from '../shared/canvasPalette'
import { formatLength } from '../shared/format'
import { keyframeSummary, secondsWords } from './describe'
import { FactList, useCopy } from './StreamInfo'
import type { Fact } from './report'

/** The strip's height in px. */
export const KEYFRAME_STRIP_HEIGHT = 32

type Analysis =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ready', times: number[] }
  | { state: 'failed', error: string }

function KeyframeStrip({ times, durationSeconds }: { times: number[], durationSeconds: number }): ReactElement
{
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const palette = useCanvasPalette()

  useEffect(() =>
  {
    const element = wrapRef.current
    if (!element)
    {
      return
    }
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() =>
  {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || width <= 0)
    {
      return
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = KEYFRAME_STRIP_HEIGHT * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, KEYFRAME_STRIP_HEIGHT)
    const span = Math.max(durationSeconds, times[times.length - 1] ?? 0, 0.001)
    ctx.fillStyle = palette.waveform
    for (const time of times)
    {
      const x = Math.min(width - 1, Math.round((time / span) * (width - 1)))
      ctx.fillRect(x, 4, 1, KEYFRAME_STRIP_HEIGHT - 8)
    }
  }, [times, durationSeconds, width, palette])

  return (
    <div className="flex flex-col gap-1">
      <div ref={wrapRef} className="overflow-hidden rounded-sm bg-sunken shadow-well" style={{ height: KEYFRAME_STRIP_HEIGHT }}>
        <canvas ref={canvasRef} aria-hidden="true" className="block" style={{ width, height: KEYFRAME_STRIP_HEIGHT }} />
      </div>
      <div className="flex justify-between text-label tabular-nums text-ink-3" aria-hidden="true">
        <span>0:00</span>
        <span>{formatLength(durationSeconds)}</span>
      </div>
    </div>
  )
}

function summaryFacts(summary: { count: number, average: number | null, longest: number | null }): Fact[]
{
  const facts: Fact[] = [{ name: 'Keyframes', value: String(summary.count) }]
  if (summary.average !== null)
  {
    facts.push({ name: 'Usual gap', value: secondsWords(summary.average) })
  }
  if (summary.longest !== null)
  {
    facts.push({ name: 'Longest gap', value: secondsWords(summary.longest) })
  }
  return facts
}

/** Props of {@link KeyframeView}. */
export interface KeyframeViewProps
{
  filePath: string
  durationSeconds: number
}

/** The keyframe section. */
export function KeyframeView({ filePath, durationSeconds }: KeyframeViewProps): ReactElement
{
  const headingId = useId()
  const [analysis, setAnalysis] = useState<Analysis>({ state: 'idle' })
  const { copied, copy } = useCopy()

  useEffect(() =>
  {
    setAnalysis({ state: 'idle' })
  }, [filePath])

  const analyze = async (): Promise<void> =>
  {
    setAnalysis({ state: 'running' })
    try
    {
      const result = await window.api.keyframeTimes(filePath)
      setAnalysis(result.success ? { state: 'ready', times: result.times } : { state: 'failed', error: result.error })
    }
    catch (caught)
    {
      setAnalysis({ state: 'failed', error: caught instanceof Error ? caught.message : String(caught) })
    }
  }

  const summary = analysis.state === 'ready' ? keyframeSummary(analysis.times, durationSeconds) : null

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="type-legend text-accent-ink">Keyframes</h2>
        {analysis.state !== 'running' && (
          <Button size="sm" variant={analysis.state === 'ready' ? 'ghost' : 'secondary'} onClick={() => void analyze()}>
            {analysis.state === 'ready' ? 'Find again' : 'Find keyframes'}
          </Button>
        )}
      </div>
      <p className="max-w-[65ch] text-label text-ink-3">
        A lossless trim starts at a keyframe, so the gaps between keyframes set how close a lossless cut can land.
      </p>
      {analysis.state === 'running' && <ProgressBar label="Finding keyframes" size="sm" showValue={false} />}
      {analysis.state === 'failed' && (
        <FieldMessage id={`${headingId}-error`} tone="error">{`Could not read the keyframes: ${analysis.error}. Check that the file has a video stream and try again.`}</FieldMessage>
      )}
      {analysis.state === 'ready' && summary !== null && (
        summary.count === 0
          ? <p className="text-body text-ink-2">FFprobe found no keyframes in the first video stream.</p>
          : (
              <>
                <FactList facts={summaryFacts(summary)} label="Keyframe summary" scope="keyframes" copied={copied} onCopy={copy} />
                <KeyframeStrip times={analysis.times} durationSeconds={durationSeconds} />
              </>
            )
      )}
    </section>
  )
}
