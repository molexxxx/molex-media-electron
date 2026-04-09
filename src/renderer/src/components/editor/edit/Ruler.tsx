/**
 * @module editor/edit/Ruler
 * Canvas-based time ruler with adaptive tick spacing based on zoom level.
 * Click to move playhead.
 */
import React, { useRef, useEffect, useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import { formatTimecode } from '../shared/TimeDisplay'

interface RulerProps {
  coords: TimelineCoords
  width: number
  headerWidth: number
}

// Preferred interval steps (seconds): try to keep labels readable
const STEP_CANDIDATES = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

function chooseStep(zoom: number): { major: number; minor: number } {
  // Roughly >=80px between major labels
  const minPxBetween = 80
  for (const s of STEP_CANDIDATES) {
    if (s * zoom >= minPxBetween) {
      return { major: s, minor: s / 5 || s }
    }
  }
  return { major: 600, minor: 120 }
}

export function Ruler({ coords, width, headerWidth }: RulerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { frameRate, zoom, scrollX } = coords
  const seek = useEditorStore((s) => s.seek)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = 28 * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, 28)

    const { major, minor } = chooseStep(zoom)
    const startSec = (scrollX / frameRate)
    const endSec = startSec + width / zoom
    const firstMajor = Math.floor(startSec / major) * major
    const firstMinor = Math.floor(startSec / minor) * minor

    // Minor ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    for (let t = firstMinor; t <= endSec + minor; t += minor) {
      const px = (t - startSec) * zoom
      if (px < 0) continue
      ctx.beginPath()
      ctx.moveTo(px, 20)
      ctx.lineTo(px, 28)
      ctx.stroke()
    }

    // Major ticks + labels
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'top'
    for (let t = firstMajor; t <= endSec + major; t += major) {
      const px = (t - startSec) * zoom
      if (px < -60) continue
      ctx.beginPath()
      ctx.moveTo(px, 12)
      ctx.lineTo(px, 28)
      ctx.stroke()

      const frame = Math.round(t * frameRate)
      const label = formatTimecode(frame, frameRate)
      ctx.fillText(label, px + 3, 1)
    }
  }, [width, zoom, scrollX, frameRate])

  useEffect(() => {
    draw()
  }, [draw])

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = e.clientX - rect.left
      const frame = coords.pixelToFrame(px)
      seek(Math.max(0, frame))
    },
    [coords, seek]
  )

  return (
    <div className="flex h-7 border-b border-white/5 bg-surface-900/60">
      <div style={{ width: headerWidth, minWidth: headerWidth }} className="border-r border-white/5 flex-shrink-0" />
      <canvas
        ref={canvasRef}
        className="cursor-pointer"
        style={{ width, height: 28 }}
        onClick={handleClick}
      />
    </div>
  )
}
