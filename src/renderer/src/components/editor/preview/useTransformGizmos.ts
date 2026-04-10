/**
 * @module editor/preview/useTransformGizmos
 * Interactive move/scale/rotate/anchor handles for the spatial canvas.
 *
 * Handles:
 * - Move: drag anywhere inside the clip rectangle
 * - Scale: 4 corner handles + 4 edge midpoint handles (Shift = uniform)
 * - Rotate: circular handle above the top-center
 * - Anchor: crosshair at the anchor position
 *
 * Uses affine matrix inversion for hit-testing rotated bounding boxes.
 */
import { useCallback, useRef } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { ClipTransform, MediaSource, Resolution, TimelineClip } from '../types'
import { defaultTransform } from '../types'
import { resolveTransform } from '../shared/interpolation'
import {
  buildClipMatrix,
  getClipCorners,
  hitTestClip,
  inverse,
  transformPoint
} from './transformMath'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HandleType = 'move' | 'scale-tl' | 'scale-tr' | 'scale-br' | 'scale-bl'
  | 'scale-t' | 'scale-r' | 'scale-b' | 'scale-l' | 'rotate' | 'anchor'

interface DragState {
  handle: HandleType
  startMouseX: number
  startMouseY: number
  startTransform: ClipTransform
  shiftHeld: boolean
}

interface GizmoConfig {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  selectedClip?: { clip: TimelineClip; source: MediaSource }
  resolution: Resolution
  scaleFactorX: number
  scaleFactorY: number
}

const HANDLE_SIZE = 8
const ROTATE_OFFSET = 30 // px above top-center

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTransformGizmos(config: GizmoConfig) {
  const dragRef = useRef<DragState | null>(null)
  const setClipTransform = useEditorStore((s) => s.setClipTransform)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)

  const { canvasRef, selectedClip, resolution, scaleFactorX, scaleFactorY } = config

  // Get current transform for the selected clip
  const getTransform = useCallback((): ClipTransform | null => {
    if (!selectedClip) return null
    const { clip, source } = selectedClip
    const frameOffset = currentFrame - clip.timelineStart
    const defT = defaultTransform(source.width, source.height, resolution.width, resolution.height)
    return resolveTransform(clip, frameOffset, defT)
  }, [selectedClip, currentFrame, resolution])

  // Convert canvas pixel coords to output coordinate space
  const canvasToOutput = useCallback(
    (cx: number, cy: number): [number, number] => {
      return [cx / scaleFactorX, cy / scaleFactorY]
    },
    [scaleFactorX, scaleFactorY]
  )

  // Hit test handles. Returns the handle type or null.
  const hitTestHandles = useCallback(
    (canvasX: number, canvasY: number): HandleType | null => {
      if (!selectedClip) return null
      const t = getTransform()
      if (!t) return null

      const { source } = selectedClip
      const [ox, oy] = canvasToOutput(canvasX, canvasY)

      // Get corners in output space
      const corners = getClipCorners(t, source.width, source.height)
      const hs = HANDLE_SIZE / scaleFactorX // handle size in output px

      // Rotate handle: above top-center
      const topMidX = (corners[0][0] + corners[1][0]) / 2
      const topMidY = (corners[0][1] + corners[1][1]) / 2
      const rotOffset = ROTATE_OFFSET / scaleFactorY
      const rad = (t.rotation * Math.PI) / 180
      const rotX = topMidX - Math.sin(rad) * rotOffset
      const rotY = topMidY - Math.cos(rad) * rotOffset
      if (Math.abs(ox - rotX) < hs && Math.abs(oy - rotY) < hs) return 'rotate'

      // Anchor handle
      const mat = buildClipMatrix(t, source.width, source.height)
      const [ancX, ancY] = transformPoint(mat, t.anchorX * source.width, t.anchorY * source.height)
      if (Math.abs(ox - ancX) < hs && Math.abs(oy - ancY) < hs) return 'anchor'

      // Corner handles
      const cornerNames: HandleType[] = ['scale-tl', 'scale-tr', 'scale-br', 'scale-bl']
      for (let i = 0; i < 4; i++) {
        if (Math.abs(ox - corners[i][0]) < hs && Math.abs(oy - corners[i][1]) < hs) {
          return cornerNames[i]
        }
      }

      // Edge midpoint handles
      const edgeNames: HandleType[] = ['scale-t', 'scale-r', 'scale-b', 'scale-l']
      const edges = [
        [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
        [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
        [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
        [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2]
      ]
      for (let i = 0; i < 4; i++) {
        if (Math.abs(ox - edges[i][0]) < hs && Math.abs(oy - edges[i][1]) < hs) {
          return edgeNames[i]
        }
      }

      // Move: inside clip rect
      if (hitTestClip(t, source.width, source.height, ox, oy)) {
        return 'move'
      }

      return null
    },
    [selectedClip, getTransform, canvasToOutput, scaleFactorX, scaleFactorY]
  )

  // Perform transform update for a drag event (works with window-level MouseEvent)
  const applyDrag = useCallback(
    (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || !selectedClip) return

      const dx = (e.clientX - drag.startMouseX) / scaleFactorX
      const dy = (e.clientY - drag.startMouseY) / scaleFactorY
      const { source } = selectedClip
      const clipId = selectedClip.clip.id
      const st = drag.startTransform
      const shiftKey = e.shiftKey || drag.shiftHeld

      switch (drag.handle) {
        case 'move':
          setClipTransform(clipId, {
            x: st.x + dx,
            y: st.y + dy
          })
          break

        case 'rotate': {
          const cx = st.x
          const cy = st.y
          const canvas = canvasRef.current
          if (!canvas) break
          const rect = canvas.getBoundingClientRect()
          const [mx, my] = canvasToOutput(
            e.clientX - rect.left,
            e.clientY - rect.top
          )
          let angle = Math.atan2(mx - cx, -(my - cy)) * (180 / Math.PI)
          if (shiftKey) angle = Math.round(angle / 15) * 15
          setClipTransform(clipId, { rotation: angle })
          break
        }

        case 'anchor': {
          const mat = buildClipMatrix(st, source.width, source.height)
          const inv = inverse(mat)
          const canvas = canvasRef.current
          if (!canvas) break
          const rect = canvas.getBoundingClientRect()
          const [ox, oy] = canvasToOutput(e.clientX - rect.left, e.clientY - rect.top)
          const [lx, ly] = transformPoint(inv, ox, oy)
          setClipTransform(clipId, {
            anchorX: Math.max(0, Math.min(1, lx / source.width)),
            anchorY: Math.max(0, Math.min(1, ly / source.height))
          })
          break
        }

        default: {
          const handle = drag.handle
          let dsx = 0
          let dsy = 0

          if (handle.includes('r') || handle === 'scale-tr' || handle === 'scale-br') {
            dsx = dx / (source.width * st.scaleX) * st.scaleX
          }
          if (handle.includes('l') || handle === 'scale-tl' || handle === 'scale-bl') {
            dsx = -dx / (source.width * st.scaleX) * st.scaleX
          }
          if (handle.includes('b') || handle === 'scale-br' || handle === 'scale-bl') {
            dsy = dy / (source.height * st.scaleY) * st.scaleY
          }
          if (handle.includes('t') || handle === 'scale-tl' || handle === 'scale-tr') {
            dsy = -dy / (source.height * st.scaleY) * st.scaleY
          }

          let newScaleX = Math.max(0.01, st.scaleX + dsx)
          let newScaleY = Math.max(0.01, st.scaleY + dsy)

          if (shiftKey || handle.includes('-t') && handle.includes('-') && handle.length > 7) {
            if (handle.includes('l') || handle.includes('r') || handle.includes('t') || handle.includes('b')) {
              if (handle.length > 7) {
                const avgScale = (newScaleX / st.scaleX + newScaleY / st.scaleY) / 2
                newScaleX = st.scaleX * avgScale
                newScaleY = st.scaleY * avgScale
              }
            }
          }

          if (shiftKey) {
            const avgScale = (newScaleX / st.scaleX + newScaleY / st.scaleY) / 2
            newScaleX = st.scaleX * avgScale
            newScaleY = st.scaleY * avgScale
          }

          setClipTransform(clipId, { scaleX: newScaleX, scaleY: newScaleY })
          break
        }
      }
    },
    [selectedClip, canvasRef, scaleFactorX, scaleFactorY, setClipTransform, canvasToOutput]
  )

  // Mouse handlers
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!selectedClip) return
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      const handle = hitTestHandles(cx, cy)
      if (!handle) return

      const t = getTransform()
      if (!t) return

      e.preventDefault()
      e.stopPropagation()

      dragRef.current = {
        handle,
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startTransform: { ...t },
        shiftHeld: e.shiftKey
      }

      const onWindowMove = (ev: MouseEvent): void => {
        applyDrag(ev)
      }

      const onWindowUp = (): void => {
        dragRef.current = null
        canvas.style.cursor = 'default'
        window.removeEventListener('mousemove', onWindowMove)
        window.removeEventListener('mouseup', onWindowUp)
      }

      window.addEventListener('mousemove', onWindowMove)
      window.addEventListener('mouseup', onWindowUp)
    },
    [selectedClip, canvasRef, hitTestHandles, getTransform, applyDrag]
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Only handle cursor updates — drag is handled by window listeners
      if (dragRef.current) return

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const handle = hitTestHandles(e.clientX - rect.left, e.clientY - rect.top)
      canvas.style.cursor = handle
        ? handle === 'move'
          ? 'move'
          : handle === 'rotate'
            ? 'crosshair'
            : handle === 'anchor'
              ? 'cell'
              : handle.startsWith('scale-t') || handle.startsWith('scale-b')
                ? 'ns-resize'
                : handle === 'scale-l' || handle === 'scale-r'
                  ? 'ew-resize'
                  : 'nwse-resize'
        : 'default'
    },
    [canvasRef, hitTestHandles]
  )

  const onMouseUp = useCallback(() => {
    dragRef.current = null
  }, [])

  // Draw gizmo overlays on the canvas context
  const drawGizmos = useCallback(
    (ctx: CanvasRenderingContext2D, t: ClipTransform, sourceW: number, sourceH: number) => {
      const corners = getClipCorners(t, sourceW, sourceH)

      ctx.save()
      ctx.scale(scaleFactorX, scaleFactorY)

      // Bounding box outline
      ctx.strokeStyle = '#3b82f6'
      ctx.lineWidth = 1.5 / scaleFactorX
      ctx.beginPath()
      ctx.moveTo(corners[0][0], corners[0][1])
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1])
      ctx.closePath()
      ctx.stroke()

      const hs = HANDLE_SIZE / (2 * scaleFactorX)

      // Corner handles (white squares)
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#3b82f6'
      ctx.lineWidth = 1 / scaleFactorX
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2)
        ctx.strokeRect(cx - hs, cy - hs, hs * 2, hs * 2)
      }

      // Edge midpoint handles (smaller)
      const ehs = hs * 0.7
      const midpoints = [
        [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2],
        [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
        [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2],
        [(corners[3][0] + corners[0][0]) / 2, (corners[3][1] + corners[0][1]) / 2]
      ]
      for (const [mx, my] of midpoints) {
        ctx.fillRect(mx - ehs, my - ehs, ehs * 2, ehs * 2)
        ctx.strokeRect(mx - ehs, my - ehs, ehs * 2, ehs * 2)
      }

      // Rotation handle (circle above top-center)
      const topMidX = midpoints[0][0]
      const topMidY = midpoints[0][1]
      const rotOffset = ROTATE_OFFSET / scaleFactorY
      const rad = (t.rotation * Math.PI) / 180
      const rotX = topMidX - Math.sin(rad) * rotOffset
      const rotY = topMidY - Math.cos(rad) * rotOffset

      // Line from top-center to rotate handle
      ctx.strokeStyle = '#3b82f6'
      ctx.lineWidth = 1 / scaleFactorX
      ctx.beginPath()
      ctx.moveTo(topMidX, topMidY)
      ctx.lineTo(rotX, rotY)
      ctx.stroke()

      // Rotate circle
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#3b82f6'
      ctx.beginPath()
      ctx.arc(rotX, rotY, hs, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      // Anchor crosshair
      const mat = buildClipMatrix(t, sourceW, sourceH)
      const [ancX, ancY] = transformPoint(mat, t.anchorX * sourceW, t.anchorY * sourceH)
      const cs = hs * 1.5
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 1.5 / scaleFactorX
      ctx.beginPath()
      ctx.moveTo(ancX - cs, ancY)
      ctx.lineTo(ancX + cs, ancY)
      ctx.moveTo(ancX, ancY - cs)
      ctx.lineTo(ancX, ancY + cs)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(ancX, ancY, cs * 0.5, 0, Math.PI * 2)
      ctx.stroke()

      ctx.restore()
    },
    [scaleFactorX, scaleFactorY]
  )

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    drawGizmos
  }
}
