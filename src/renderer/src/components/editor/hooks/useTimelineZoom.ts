/**
 * @module editor/hooks/useTimelineZoom
 * Timeline zoom/scroll management and coordinate conversion helpers.
 * Includes touch gesture support: pinch to zoom, two-finger scroll.
 */
import { useCallback, useMemo, useRef } from 'react'
import { useEditorStore } from '../../../stores/editorStore'

const MIN_ZOOM = 2 // px per second (fully zoomed out)
const MAX_ZOOM = 500 // px per second (fully zoomed in)

export interface TimelineCoords {
  zoom: number
  scrollX: number
  scrollY: number
  frameRate: number
  /** Convert a timeline frame to screen pixels (relative to timeline container left). */
  frameToPixel: (frame: number) => number
  /** Convert screen pixels (relative to timeline container left) to a timeline frame. */
  pixelToFrame: (px: number) => number
  /** Handle Ctrl+Scroll zoom centred on pointer X. */
  handleWheelZoom: (e: React.WheelEvent, containerLeft: number) => void
  /** Plain horizontal scroll. */
  handleWheelScroll: (e: React.WheelEvent) => void
  /** Programmatic zoom helpers. */
  zoomIn: () => void
  zoomOut: () => void
  fitToView: (totalFrames: number, containerWidth: number) => void
  /** Touch gesture handler for pinch-to-zoom and two-finger scroll. Attach to onTouchStart. */
  handleTouchStart: (e: React.TouchEvent, containerLeft: number) => void
}

export function useTimelineZoom(): TimelineCoords {
  const zoom = useEditorStore((s) => s.zoom)
  const scrollX = useEditorStore((s) => s.scrollX)
  const scrollY = useEditorStore((s) => s.scrollY)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const setZoom = useEditorStore((s) => s.setZoom)
  const setScroll = useEditorStore((s) => s.setScroll)

  // Touch gesture state
  const touchRef = useRef<{ startDist: number; startZoom: number; startScrollX: number; startScrollY: number; startMidX: number; startMidY: number } | null>(null)

  // zoom is "pixels per second of media"
  // so for a given frame: px = (frame / frameRate) * zoom - scrollX_px
  // scrollX is stored in frames.

  const frameToPixel = useCallback(
    (frame: number): number => {
      return ((frame - scrollX) / frameRate) * zoom
    },
    [zoom, scrollX, frameRate]
  )

  const pixelToFrame = useCallback(
    (px: number): number => {
      return Math.round((px / zoom) * frameRate + scrollX)
    },
    [zoom, scrollX, frameRate]
  )

  const handleWheelZoom = useCallback(
    (e: React.WheelEvent, containerLeft: number) => {
      const pointerX = e.clientX - containerLeft
      // Frame under pointer before zoom
      const frameBefore = (pointerX / zoom) * frameRate + scrollX
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
      // Adjust scroll so the same frame stays under pointer
      const newScrollX = frameBefore - (pointerX / newZoom) * frameRate
      setZoom(newZoom)
      setScroll(Math.max(0, newScrollX), scrollY)
    },
    [zoom, scrollX, scrollY, frameRate, setZoom, setScroll]
  )

  const handleWheelScroll = useCallback(
    (e: React.WheelEvent) => {
      if (e.shiftKey) {
        // Vertical scroll
        setScroll(scrollX, Math.max(0, scrollY + e.deltaY))
      } else {
        // Horizontal scroll: delta in frames
        const frameDelta = (e.deltaY / zoom) * frameRate * 3
        setScroll(Math.max(0, scrollX + frameDelta), scrollY)
      }
    },
    [scrollX, scrollY, zoom, frameRate, setScroll]
  )

  const zoomIn = useCallback(() => {
    setZoom(Math.min(MAX_ZOOM, zoom * 1.25))
  }, [zoom, setZoom])

  const zoomOut = useCallback(() => {
    setZoom(Math.max(MIN_ZOOM, zoom / 1.25))
  }, [zoom, setZoom])

  const fitToView = useCallback(
    (totalFrames: number, containerWidth: number) => {
      if (totalFrames <= 0 || containerWidth <= 0) return
      const durationSec = totalFrames / frameRate
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, containerWidth / durationSec))
      setZoom(newZoom)
      setScroll(0, scrollY)
    },
    [frameRate, scrollY, setZoom, setScroll]
  )

  // Pinch-to-zoom and two-finger scroll for touch devices
  const handleTouchStart = useCallback(
    (e: React.TouchEvent, containerLeft: number) => {
      if (e.touches.length < 2) return

      const t0 = e.touches[0]
      const t1 = e.touches[1]
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
      const midX = (t0.clientX + t1.clientX) / 2 - containerLeft
      const midY = (t0.clientY + t1.clientY) / 2

      const currentZoom = useEditorStore.getState().zoom
      const currentScrollX = useEditorStore.getState().scrollX
      const currentScrollY = useEditorStore.getState().scrollY

      touchRef.current = {
        startDist: dist,
        startZoom: currentZoom,
        startScrollX: currentScrollX,
        startScrollY: currentScrollY,
        startMidX: midX,
        startMidY: midY
      }

      const onTouchMove = (ev: TouchEvent): void => {
        ev.preventDefault()
        if (ev.touches.length < 2 || !touchRef.current) return
        const a = ev.touches[0]
        const b = ev.touches[1]
        const newDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
        const newMidX = (a.clientX + b.clientX) / 2 - containerLeft
        const newMidY = (a.clientY + b.clientY) / 2

        // Pinch zoom
        const scale = newDist / touchRef.current.startDist
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, touchRef.current.startZoom * scale))

        // Adjust scroll to keep pinch center stable
        const frameBefore = (touchRef.current.startMidX / touchRef.current.startZoom) * frameRate + touchRef.current.startScrollX
        const newScrollX = frameBefore - (newMidX / newZoom) * frameRate

        // Two-finger vertical scroll offset
        const deltaY = newMidY - touchRef.current.startMidY

        setZoom(newZoom)
        setScroll(Math.max(0, newScrollX), Math.max(0, touchRef.current.startScrollY - deltaY))
      }

      const onTouchEnd = (): void => {
        touchRef.current = null
        window.removeEventListener('touchmove', onTouchMove)
        window.removeEventListener('touchend', onTouchEnd)
      }

      window.addEventListener('touchmove', onTouchMove, { passive: false })
      window.addEventListener('touchend', onTouchEnd)
    },
    [frameRate, setZoom, setScroll]
  )

  return useMemo(
    () => ({
      zoom,
      scrollX,
      scrollY,
      frameRate,
      frameToPixel,
      pixelToFrame,
      handleWheelZoom,
      handleWheelScroll,
      zoomIn,
      zoomOut,
      fitToView,
      handleTouchStart
    }),
    [zoom, scrollX, scrollY, frameRate, frameToPixel, pixelToFrame, handleWheelZoom, handleWheelScroll, zoomIn, zoomOut, fitToView, handleTouchStart]
  )
}
