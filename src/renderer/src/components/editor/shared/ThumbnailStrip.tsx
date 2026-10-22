/**
 * @module editor/shared/ThumbnailStrip
 * A strip of frame thumbnails on a canvas. Every frame of a source is extracted in one IPC call and decoded once,
 * and each slot draws the nearest cached frame, so zooming or resizing never runs FFmpeg again.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasPalette } from './canvasPalette'

/** Per-source strip metadata: the seconds between frames and the frame count. */
const stripMeta = new Map<string, { interval: number, count: number }>()
/** Concurrent requests for one source share one IPC call. */
const stripRequests = new Map<string, Promise<void>>()
/** Decoded frames per source. */
const imageCache = new Map<string, Array<HTMLImageElement | null>>()

interface ThumbnailStripProps
{
  filePath: string
  durationSeconds: number
  width: number
  height: number
  /** Slots to draw; by default one per 60 px. */
  numThumbnails?: number
  /** The start of the part to draw, from 0 to 1 of the file. */
  rangeStart?: number
  /** The end of the part to draw, from 0 to 1 of the file. */
  rangeEnd?: number
  className?: string
}

async function decode(dataUrl: string): Promise<HTMLImageElement | null>
{
  try
  {
    return await new Promise<HTMLImageElement>((resolve, reject) =>
    {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = dataUrl
    })
  }
  catch
  {
    return null
  }
}

function requestStrip(filePath: string, durationSeconds: number): Promise<void>
{
  const pending = stripRequests.get(filePath)
  if (pending)
  {
    return pending
  }
  const request = (async () =>
  {
    try
    {
      const result = await window.api.extractThumbnailStrip(filePath, durationSeconds)
      if (!result?.success || !result.frames)
      {
        return
      }
      const images: Array<HTMLImageElement | null> = []
      for (const dataUrl of result.frames as Array<string | null>)
      {
        images.push(dataUrl ? await decode(dataUrl) : null)
      }
      imageCache.set(filePath, images)
      stripMeta.set(filePath, { interval: result.interval, count: images.length })
    }
    catch
    {
      return
    }
  })().finally(() => stripRequests.delete(filePath))
  stripRequests.set(filePath, request)
  return request
}

/** The strip, or an empty well while its frames load. */
export function ThumbnailStrip({
  filePath,
  durationSeconds,
  width,
  height,
  numThumbnails,
  rangeStart = 0,
  rangeEnd = 1,
  className = ''
}: ThumbnailStripProps): ReactElement
{
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = useCanvasPalette()
  const [ready, setReady] = useState(() => imageCache.has(filePath))

  useEffect(() =>
  {
    if (!filePath || durationSeconds <= 0)
    {
      return
    }
    if (imageCache.has(filePath))
    {
      setReady(true)
      return
    }
    let cancelled = false
    void requestStrip(filePath, durationSeconds).then(() =>
    {
      if (!cancelled)
      {
        setReady(imageCache.has(filePath))
      }
    })
    return () =>
    {
      cancelled = true
    }
  }, [filePath, durationSeconds])

  const draw = useCallback(() =>
  {
    const canvas = canvasRef.current
    const meta = stripMeta.get(filePath)
    const images = imageCache.get(filePath)
    if (!canvas || !meta || !images || images.length === 0)
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
    ctx.fillStyle = palette.ground
    ctx.fillRect(0, 0, width, height)

    const count = numThumbnails ?? Math.max(2, Math.min(40, Math.floor(width / 60)))
    const slotWidth = width / count
    const span = (rangeEnd - rangeStart) * durationSeconds
    const start = rangeStart * durationSeconds
    for (let i = 0; i < count; i++)
    {
      const time = start + (i / Math.max(1, count - 1)) * span
      const index = Math.min(meta.count - 1, Math.max(0, Math.round(time / meta.interval)))
      const image = images[index]
      if (!image)
      {
        continue
      }
      const imageAspect = image.naturalWidth / image.naturalHeight
      const slotAspect = slotWidth / height
      let sx = 0
      let sy = 0
      let sw = image.naturalWidth
      let sh = image.naturalHeight
      if (imageAspect > slotAspect)
      {
        sw = image.naturalHeight * slotAspect
        sx = (image.naturalWidth - sw) / 2
      }
      else
      {
        sh = image.naturalWidth / slotAspect
        sy = (image.naturalHeight - sh) / 2
      }
      ctx.drawImage(image, sx, sy, sw, sh, i * slotWidth, 0, slotWidth, height)
    }
  }, [filePath, durationSeconds, width, height, numThumbnails, rangeStart, rangeEnd, palette])

  useEffect(() =>
  {
    if (ready)
    {
      draw()
    }
  }, [ready, draw])

  if (!ready)
  {
    return <div aria-hidden="true" className={`bg-sunken ${className}`} style={{ width, height }} />
  }

  return <canvas ref={canvasRef} aria-hidden="true" className={className} style={{ width, height }} />
}

/** Drops the cached frames of one file, or of every file. */
export function clearThumbnailCache(filePath?: string): void
{
  if (filePath)
  {
    stripMeta.delete(filePath)
    imageCache.delete(filePath)
  }
  else
  {
    stripMeta.clear()
    imageCache.clear()
  }
}
