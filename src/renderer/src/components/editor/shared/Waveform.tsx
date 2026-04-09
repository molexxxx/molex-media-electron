/**
 * @module editor/shared/Waveform
 * Audio waveform visualization with IPC data fetching and canvas rendering + caching.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react'

/** In-memory cache: filePath+samples → peaks array */
const waveformCache = new Map<string, number[]>()

interface WaveformProps {
  /** Absolute file path for the audio source */
  filePath: string
  /** Number of peak samples to request (default 800) */
  numSamples?: number
  /** Canvas width in CSS pixels */
  width: number
  /** Canvas height in CSS pixels */
  height: number
  /** Waveform color */
  color?: string
  /** Background color (transparent if omitted) */
  bgColor?: string
  /** Optional: normalized 0-1 range to render (for clip sub-range) */
  rangeStart?: number
  /** Optional: normalized 0-1 range end */
  rangeEnd?: number
  className?: string
}

export function Waveform({
  filePath,
  numSamples = 800,
  width,
  height,
  color = 'rgba(124, 58, 237, 0.6)',
  bgColor,
  rangeStart = 0,
  rangeEnd = 1,
  className = ''
}: WaveformProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [error, setError] = useState(false)

  // Fetch waveform data via IPC with caching
  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    const cacheKey = `${filePath}:${numSamples}`

    if (waveformCache.has(cacheKey)) {
      setPeaks(waveformCache.get(cacheKey)!)
      return
    }

    setError(false)
    window.api
      .extractWaveform(filePath, numSamples)
      .then((result) => {
        if (cancelled) return
        if (result?.success && result.data) {
          waveformCache.set(cacheKey, result.data)
          setPeaks(result.data)
        } else {
          setError(true)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })

    return () => {
      cancelled = true
    }
  }, [filePath, numSamples])

  // Render peaks to canvas
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || peaks.length === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)

    // Clear
    if (bgColor) {
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, width, height)
    } else {
      ctx.clearRect(0, 0, width, height)
    }

    // Select range of peaks
    const startIdx = Math.floor(rangeStart * peaks.length)
    const endIdx = Math.ceil(rangeEnd * peaks.length)
    const rangePeaks = peaks.slice(startIdx, endIdx)
    if (rangePeaks.length === 0) return

    const barWidth = width / rangePeaks.length
    const midY = height / 2

    ctx.fillStyle = color

    for (let i = 0; i < rangePeaks.length; i++) {
      const peak = rangePeaks[i]
      const barH = Math.max(1, peak * midY)
      const x = i * barWidth
      ctx.fillRect(x, midY - barH, Math.max(1, barWidth - 0.5), barH * 2)
    }
  }, [peaks, width, height, color, bgColor, rangeStart, rangeEnd])

  useEffect(() => {
    render()
  }, [render])

  if (error) {
    return (
      <div
        className={`flex items-center justify-center text-surface-600 text-2xs ${className}`}
        style={{ width, height }}
      >
        No audio
      </div>
    )
  }

  if (!peaks) {
    return (
      <div
        className={`flex items-center justify-center ${className}`}
        style={{ width, height }}
      >
        <div className="w-4 h-4 border-2 border-accent-500/40 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height }}
    />
  )
}

/** Invalidate the cache for a specific file or all files. */
export function clearWaveformCache(filePath?: string): void {
  if (filePath) {
    for (const key of waveformCache.keys()) {
      if (key.startsWith(filePath + ':')) waveformCache.delete(key)
    }
  } else {
    waveformCache.clear()
  }
}
