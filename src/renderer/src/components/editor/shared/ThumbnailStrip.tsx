/**
 * @module editor/shared/ThumbnailStrip
 * Frame thumbnail strip using batch extraction and canvas rendering.
 *
 * Extracts all frames for a source in one batch IPC call,
 * caches the base64 strings per filePath, and picks the nearest frame
 * for each canvas slot - zoom / resize never triggers new FFmpeg calls.
 */
import React, { useEffect, useRef, useCallback, useState } from 'react'

/** Per-source cached strip metadata (interval + frame count) */
const stripMeta = new Map<string, { interval: number; count: number }>()
/** Dedup concurrent IPC requests for the same source */
const stripRequests = new Map<string, Promise<void>>()
/** Pre-decoded Image objects per source (decoded once, reused for drawing) */
const imageCache = new Map<string, (HTMLImageElement | null)[]>()

interface ThumbnailStripProps {
  filePath: string
  durationSeconds: number
  width: number
  height: number
  numThumbnails?: number
  rangeStart?: number
  rangeEnd?: number
  className?: string
}

export function ThumbnailStrip({
  filePath,
  durationSeconds,
  width,
  height,
  numThumbnails,
  rangeStart = 0,
  rangeEnd = 1,
  className = ''
}: ThumbnailStripProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(() => imageCache.has(filePath))

  // -- Fetch the full strip once per source ----------------------
  useEffect(() => {
    if (!filePath || durationSeconds <= 0) return
    let cancelled = false

    // Already decoded
    if (imageCache.has(filePath)) {
      setReady(true)
      return
    }

    // Kick off IPC (deduped)
    if (!stripRequests.has(filePath)) {
      const req = (async () => {
        try {
          const result = await window.api.extractThumbnailStrip(filePath, durationSeconds)
          if (!result?.success || !result.frames) return

          // Decode frames into Image elements sequentially (no GPU pressure)
          const images: (HTMLImageElement | null)[] = []
          for (const dataUrl of result.frames) {
            if (!dataUrl) { images.push(null); continue }
            try {
              const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const el = new Image()
                el.onload = () => resolve(el)
                el.onerror = reject
                el.src = dataUrl
              })
              images.push(img)
            } catch {
              images.push(null)
            }
          }
          imageCache.set(filePath, images)
          // Store lightweight metadata, base64 strings are now GC-eligible
          stripMeta.set(filePath, { interval: result.interval, count: result.frames.length })
        } catch { /* extraction failed */ }
      })().finally(() => stripRequests.delete(filePath))
      stripRequests.set(filePath, req)
    }

    stripRequests.get(filePath)!.then(() => {
      if (!cancelled) setReady(imageCache.has(filePath))
    })

    return () => { cancelled = true }
  }, [filePath, durationSeconds])

  // -- Canvas render - picks nearest cached frame per slot -------
  const renderToCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const meta = stripMeta.get(filePath)
    const images = imageCache.get(filePath)
    if (!canvas || !meta || !images || images.length === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#0f1320'
    ctx.fillRect(0, 0, width, height)

    const spacing = 60
    const count = numThumbnails ?? Math.max(2, Math.min(40, Math.floor(width / spacing)))
    const thumbWidth = width / count
    const rangeDuration = (rangeEnd - rangeStart) * durationSeconds
    const startSec = rangeStart * durationSeconds

    for (let i = 0; i < count; i++) {
      const timeSec = startSec + (i / Math.max(1, count - 1)) * rangeDuration
      const frameIdx = Math.min(
        meta.count - 1,
        Math.max(0, Math.round(timeSec / meta.interval))
      )
      const img = images[frameIdx]
      if (!img) continue

      const srcAspect = img.naturalWidth / img.naturalHeight
      const slotAspect = thumbWidth / height
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight
      if (srcAspect > slotAspect) {
        sw = img.naturalHeight * slotAspect
        sx = (img.naturalWidth - sw) / 2
      } else {
        sh = img.naturalWidth / slotAspect
        sy = (img.naturalHeight - sh) / 2
      }
      ctx.drawImage(img, sx, sy, sw, sh, i * thumbWidth, 0, thumbWidth, height)
    }
  }, [filePath, durationSeconds, width, height, numThumbnails, rangeStart, rangeEnd])

  useEffect(() => {
    if (ready) renderToCanvas()
  }, [ready, renderToCanvas])

  if (!ready) {
    return (
      <div
        className={`flex items-center justify-center bg-surface-800/50 ${className}`}
        style={{ width, height }}
      >
        <div className="w-4 h-4 border-2 border-accent-500/40 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className={`rounded-sm ${className}`}
      style={{ width, height }}
    />
  )
}

/** Invalidate the cache for a specific file or all files. */
export function clearThumbnailCache(filePath?: string): void {
  if (filePath) {
    stripMeta.delete(filePath)
    imageCache.delete(filePath)
  } else {
    stripMeta.clear()
    imageCache.clear()
  }
}
