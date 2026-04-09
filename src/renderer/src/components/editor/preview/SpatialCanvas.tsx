/**
 * @module editor/preview/SpatialCanvas
 * HTML Canvas 2D composited preview rendering all visible video tracks
 * with per-clip spatial transforms applied.
 *
 * Rendering pipeline (bottom track to top):
 * 1. Clear canvas to black
 * 2. For each video track (ascending index = bottom to top):
 *    - Find clip under playhead
 *    - Compute interpolated transform at current frame
 *    - Apply canvas transforms: translate → rotate → scale (around anchor)
 *    - Set globalAlpha for opacity
 *    - Set globalCompositeOperation for blend mode
 *    - Draw the video frame
 * 3. Draw selection gizmos for selected clip (delegated to useTransformGizmos)
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { BlendMode, TimelineClip, MediaSource } from '../types'
import { defaultTransform } from '../types'
import { resolveTransform } from '../shared/interpolation'
import { buildClipMatrix } from './transformMath'
import { useTransformGizmos } from './useTransformGizmos'

// ---------------------------------------------------------------------------
// Canvas ↔ BlendMode mapping
// ---------------------------------------------------------------------------

const CANVAS_BLEND_MAP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'lighter',
  difference: 'difference'
}

// ---------------------------------------------------------------------------
// Clip hit at playhead
// ---------------------------------------------------------------------------

interface VisibleClip {
  clip: TimelineClip
  source: MediaSource
  trackIndex: number
}

function collectVisibleClips(
  timeline: { tracks: { id: string; type: string; index: number; muted: boolean; visible?: boolean }[]; clips: TimelineClip[] },
  currentFrame: number,
  sources: MediaSource[]
): VisibleClip[] {
  const videoTracks = timeline.tracks
    .filter((t) => t.type === 'video' && !t.muted && t.visible !== false)
    .sort((a, b) => a.index - b.index) // ascending: lowest index = bottom

  const result: VisibleClip[] = []

  for (const track of videoTracks) {
    for (const clip of timeline.clips) {
      if (clip.trackId !== track.id || clip.muted) continue
      const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
      if (currentFrame >= clip.timelineStart && currentFrame < clip.timelineStart + dur) {
        const source = sources.find((s) => s.id === clip.sourceId)
        if (source) {
          result.push({ clip, source, trackIndex: track.index })
        }
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// SpatialCanvas component
// ---------------------------------------------------------------------------

export interface SpatialCanvasProps {
  /** Map of source ID → video element (or image element) for frame extraction */
  videoElements: Map<string, HTMLVideoElement>
  /** Canvas width in CSS px (matches output resolution scaling for preview) */
  width: number
  /** Canvas height in CSS px */
  height: number
}

export function SpatialCanvas({ videoElements, width, height }: SpatialCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const resolution = useEditorStore((s) => s.project.resolution)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)

  const visibleClips = useMemo(
    () => collectVisibleClips(timeline, currentFrame, sources),
    [timeline, currentFrame, sources]
  )

  // Scaling factor from output resolution to canvas CSS size
  const scaleFactorX = width / resolution.width
  const scaleFactorY = height / resolution.height

  // The selected clip (for gizmos)
  const selectedClip = useMemo(() => {
    if (selectedClipIds.length !== 1) return undefined
    return visibleClips.find((vc) => vc.clip.id === selectedClipIds[0])
  }, [selectedClipIds, visibleClips])

  // Gizmos hook
  const gizmos = useTransformGizmos({
    canvasRef,
    selectedClip: selectedClip
      ? { clip: selectedClip.clip, source: selectedClip.source }
      : undefined,
    resolution,
    scaleFactorX,
    scaleFactorY
  })

  // Render frame
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear to black
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Scale to preview size
    ctx.save()
    ctx.scale(scaleFactorX, scaleFactorY)

    // Render clips bottom-to-top
    for (const { clip, source } of visibleClips) {
      const frameOffset = currentFrame - clip.timelineStart
      const defT = defaultTransform(source.width, source.height, resolution.width, resolution.height)
      const transform = resolveTransform(clip, frameOffset, defT)

      const blendMode = clip.blendMode ?? 'normal'
      const mat = buildClipMatrix(transform, source.width, source.height)

      ctx.save()

      // Set blend mode
      ctx.globalCompositeOperation = CANVAS_BLEND_MAP[blendMode]

      // Set opacity
      ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity))

      // Apply affine matrix: [a, b, c, d, tx, ty]
      ctx.setTransform(
        mat[0] * scaleFactorX,
        mat[1] * scaleFactorX,
        mat[2] * scaleFactorY,
        mat[3] * scaleFactorY,
        mat[4] * scaleFactorX,
        mat[5] * scaleFactorY
      )

      // Draw video frame
      const videoEl = videoElements.get(clip.sourceId)
      if (videoEl && videoEl.readyState >= 2) {
        try {
          ctx.drawImage(videoEl, 0, 0, source.width, source.height)
        } catch {
          // Video frame not ready — draw placeholder
          ctx.fillStyle = '#333'
          ctx.fillRect(0, 0, source.width, source.height)
        }
      } else {
        // Placeholder for missing video
        ctx.fillStyle = '#222'
        ctx.fillRect(0, 0, source.width, source.height)
        ctx.fillStyle = '#666'
        ctx.font = '14px sans-serif'
        ctx.fillText(clip.name, 10, source.height / 2)
      }

      ctx.restore()
    }

    ctx.restore()

    // Draw gizmos on top (in canvas pixel space)
    if (selectedClip) {
      const frameOffset = currentFrame - selectedClip.clip.timelineStart
      const defT = defaultTransform(
        selectedClip.source.width,
        selectedClip.source.height,
        resolution.width,
        resolution.height
      )
      const transform = resolveTransform(selectedClip.clip, frameOffset, defT)
      gizmos.drawGizmos(ctx, transform, selectedClip.source.width, selectedClip.source.height)
    }
  }, [
    visibleClips,
    currentFrame,
    resolution,
    scaleFactorX,
    scaleFactorY,
    videoElements,
    selectedClip,
    gizmos
  ])

  // Render on frame changes
  useEffect(() => {
    renderFrame()
  }, [renderFrame])

  // RAF loop during playback
  useEffect(() => {
    if (!isPlaying) return
    let rafId: number
    const tick = (): void => {
      renderFrame()
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, renderFrame])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="bg-black"
      style={{ width, height }}
      onMouseDown={gizmos.onMouseDown}
      onMouseMove={gizmos.onMouseMove}
      onMouseUp={gizmos.onMouseUp}
    />
  )
}
