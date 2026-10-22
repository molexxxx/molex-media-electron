/**
 * @module editor/shared/Waveform
 * A file's audio peaks drawn on a canvas in the viz tokens. Peaks are fetched once per file and sample count.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasPalette } from './canvasPalette'

/** In-memory cache: path and sample count to peaks. */
const waveformCache = new Map<string, number[]>()

/** Which viz color the peaks take: `neutral` on a neutral ground, `onClip` over a colored clip. */
export type WaveformTone = 'neutral' | 'onClip'

interface WaveformProps
{
  /** Absolute path of the audio source. */
  filePath: string
  /** How many peaks to request; 800 by default. */
  numSamples?: number
  /** Canvas width in CSS pixels. */
  width: number
  /** Canvas height in CSS pixels. */
  height: number
  tone?: WaveformTone
  /** The start of the part to draw, from 0 to 1 of the file. */
  rangeStart?: number
  /** The end of the part to draw, from 0 to 1 of the file. */
  rangeEnd?: number
  className?: string
}

/** The peaks of a file, or the canvas's quiet fallback while they load or when the file has no audio. */
export function Waveform({
  filePath,
  numSamples = 800,
  width,
  height,
  tone = 'neutral',
  rangeStart = 0,
  rangeEnd = 1,
  className = ''
}: WaveformProps): ReactElement
{
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = useCanvasPalette()
  const [peaks, setPeaks] = useState<number[] | null>(() => waveformCache.get(`${filePath}:${numSamples}`) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() =>
  {
    if (!filePath)
    {
      return
    }
    let cancelled = false
    const cacheKey = `${filePath}:${numSamples}`
    const cached = waveformCache.get(cacheKey)
    if (cached)
    {
      setPeaks(cached)
      return
    }
    setFailed(false)
    window.api
      .extractWaveform(filePath, numSamples)
      .then((result) =>
      {
        if (cancelled)
        {
          return
        }
        if (result?.success && result.data)
        {
          waveformCache.set(cacheKey, result.data)
          setPeaks(result.data)
        }
        else
        {
          setFailed(true)
        }
      })
      .catch(() =>
      {
        if (!cancelled)
        {
          setFailed(true)
        }
      })
    return () =>
    {
      cancelled = true
    }
  }, [filePath, numSamples])

  useEffect(() =>
  {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0)
    {
      return
    }
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.max(1, Math.round(height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx)
    {
      return
    }
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)
    const part = peaks.slice(Math.floor(rangeStart * peaks.length), Math.ceil(rangeEnd * peaks.length))
    if (part.length === 0)
    {
      return
    }
    const barWidth = width / part.length
    const middle = height / 2
    ctx.fillStyle = tone === 'onClip' ? palette.waveformOnClip : palette.waveform
    for (let i = 0; i < part.length; i++)
    {
      const reach = Math.max(1, part[i] * middle)
      ctx.fillRect(i * barWidth, middle - reach, Math.max(1, barWidth - 0.5), reach * 2)
    }
  }, [peaks, width, height, tone, rangeStart, rangeEnd, palette])

  if (failed)
  {
    return (
      <div className={`flex items-center justify-center text-label text-ink-3 ${className}`} style={{ width, height }}>
        {height >= 16 ? 'No audio' : null}
      </div>
    )
  }

  if (!peaks)
  {
    return <div aria-hidden="true" className={className} style={{ width, height }} />
  }

  return <canvas ref={canvasRef} aria-hidden="true" className={className} style={{ width, height }} />
}

/** Drops the cached peaks of one file, or of every file. */
export function clearWaveformCache(filePath?: string): void
{
  if (filePath)
  {
    for (const key of waveformCache.keys())
    {
      if (key.startsWith(`${filePath}:`))
      {
        waveformCache.delete(key)
      }
    }
  }
  else
  {
    waveformCache.clear()
  }
}
