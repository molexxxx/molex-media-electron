/**
 * @module editor/inspect/TransformInspector
 * Numeric input panel for per-clip spatial transforms.
 *
 * Displays Position (x,y), Scale (x,y + uniform lock), Rotation,
 * Anchor Point, Opacity, and Blend Mode with keyframe toggle ◆.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type {
  ClipTransform,
  BlendMode,
  TimelineClip
} from '../types'
import { defaultTransform } from '../types'
import { resolveTransform } from '../shared/interpolation'

// ---------------------------------------------------------------------------
// Blend mode options
// ---------------------------------------------------------------------------

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'add', label: 'Add' },
  { value: 'difference', label: 'Difference' }
]

// ---------------------------------------------------------------------------
// Numeric field component
// ---------------------------------------------------------------------------

interface NumericFieldProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
  hasKeyframe?: boolean
  onToggleKeyframe?: () => void
}

function NumericField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
  hasKeyframe,
  onToggleKeyframe
}: NumericFieldProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const displayValue = suffix === '%' ? (value * 100).toFixed(1) : value.toFixed(1)

  const handleCommit = useCallback((): void => {
    setEditing(false)
    let parsed = parseFloat(editValue)
    if (isNaN(parsed)) return
    if (suffix === '%') parsed /= 100
    if (min != null) parsed = Math.max(min, parsed)
    if (max != null) parsed = Math.min(max, parsed)
    onChange(parsed)
  }, [editValue, min, max, onChange, suffix])

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (editing) return
      e.preventDefault()
      const startX = e.clientX
      const startValue = value

      const onMove = (ev: MouseEvent): void => {
        const delta = (ev.clientX - startX) * step
        let newVal = startValue + delta
        if (min != null) newVal = Math.max(min, newVal)
        if (max != null) newVal = Math.min(max, newVal)
        onChange(newVal)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [editing, value, step, min, max, onChange]
  )

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-zinc-400 w-6 shrink-0 select-none">{label}</span>
      {editing ? (
        <input
          type="text"
          className="w-16 bg-zinc-800 text-zinc-200 text-xs px-1 py-0.5 rounded border border-zinc-600 outline-none focus:border-blue-500"
          value={editValue}
          autoFocus
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCommit()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span
          className="w-16 text-xs text-zinc-200 bg-zinc-800/60 px-1 py-0.5 rounded cursor-ew-resize select-none text-center tabular-nums"
          onDoubleClick={() => {
            setEditValue(displayValue)
            setEditing(true)
          }}
          onMouseDown={handleDragStart}
        >
          {displayValue}
          {suffix}
        </span>
      )}
      {onToggleKeyframe && (
        <button
          className={`text-xs px-0.5 ${hasKeyframe ? 'text-yellow-400' : 'text-zinc-600'} hover:text-yellow-300`}
          onClick={onToggleKeyframe}
          title={hasKeyframe ? 'Remove keyframe' : 'Add keyframe'}
        >
          ◆
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TransformInspector
// ---------------------------------------------------------------------------

export function TransformInspector(): React.JSX.Element | null {
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const resolution = useEditorStore((s) => s.project.resolution)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const setClipTransform = useEditorStore((s) => s.setClipTransform)
  const addKeyframe = useEditorStore((s) => s.addKeyframe)
  const removeKeyframe = useEditorStore((s) => s.removeKeyframe)
  const setClipBlendMode = useEditorStore((s) => s.setClipBlendMode)

  const [uniformScale, setUniformScale] = useState(true)

  const clip: TimelineClip | undefined = useMemo(
    () =>
      selectedClipIds.length === 1
        ? timeline.clips.find((c) => c.id === selectedClipIds[0])
        : undefined,
    [selectedClipIds, timeline.clips]
  )

  const source = useMemo(
    () => (clip ? sources.find((s) => s.id === clip.sourceId) : undefined),
    [clip, sources]
  )

  const defT = useMemo(
    () =>
      source
        ? defaultTransform(source.width, source.height, resolution.width, resolution.height)
        : {
            x: resolution.width / 2,
            y: resolution.height / 2,
            scaleX: 1,
            scaleY: 1,
            rotation: 0,
            anchorX: 0.5,
            anchorY: 0.5,
            opacity: 1
          },
    [source, resolution]
  )

  // Current frame offset within clip
  const frameOffset = clip ? currentFrame - clip.timelineStart : 0

  // Resolved transform at current frame
  const transform = useMemo(
    () => (clip ? resolveTransform(clip, frameOffset, defT) : defT),
    [clip, frameOffset, defT]
  )

  // Does a keyframe exist at the current frame offset?
  const hasKeyframeAtFrame = useMemo(
    () => (clip?.keyframes ?? []).some((k) => k.frame === frameOffset),
    [clip, frameOffset]
  )

  if (!clip) {
    return (
      <div className="p-3 text-xs text-zinc-500 italic">
        Select a clip to edit its transform properties.
      </div>
    )
  }

  const clipId = clip.id

  const updateTransform = (partial: Partial<ClipTransform>): void => {
    setClipTransform(clipId, partial)
  }

  const handleScaleX = (val: number): void => {
    if (uniformScale) {
      const ratio = transform.scaleX !== 0 ? val / transform.scaleX : 1
      updateTransform({ scaleX: val, scaleY: transform.scaleY * ratio })
    } else {
      updateTransform({ scaleX: val })
    }
  }

  const handleScaleY = (val: number): void => {
    if (uniformScale) {
      const ratio = transform.scaleY !== 0 ? val / transform.scaleY : 1
      updateTransform({ scaleY: val, scaleX: transform.scaleX * ratio })
    } else {
      updateTransform({ scaleY: val })
    }
  }

  const toggleKeyframe = (): void => {
    if (hasKeyframeAtFrame) {
      removeKeyframe(clipId, frameOffset)
    } else {
      addKeyframe(clipId, frameOffset, transform)
    }
  }

  const handleReset = (): void => {
    setClipTransform(clipId, defT)
  }

  return (
    <div className="p-3 space-y-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-zinc-300 font-medium text-sm">Transform</span>
        <button
          className={`text-xs px-1 ${hasKeyframeAtFrame ? 'text-yellow-400' : 'text-zinc-600'} hover:text-yellow-300`}
          onClick={toggleKeyframe}
          title={hasKeyframeAtFrame ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
        >
          ◆ {hasKeyframeAtFrame ? 'Remove' : 'Add'} Keyframe
        </button>
      </div>

      {/* Position */}
      <div>
        <div className="text-zinc-400 mb-1">Position</div>
        <div className="flex gap-3">
          <NumericField
            label="X"
            value={transform.x}
            step={1}
            onChange={(v) => updateTransform({ x: v })}
            hasKeyframe={hasKeyframeAtFrame}
            onToggleKeyframe={toggleKeyframe}
          />
          <NumericField
            label="Y"
            value={transform.y}
            step={1}
            onChange={(v) => updateTransform({ y: v })}
          />
        </div>
      </div>

      {/* Scale */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-zinc-400">Scale</span>
          <label className="flex items-center gap-1 text-zinc-500 cursor-pointer">
            <input
              type="checkbox"
              checked={uniformScale}
              onChange={(e) => setUniformScale(e.target.checked)}
              className="w-3 h-3 accent-blue-500"
            />
            Uniform
          </label>
        </div>
        <div className="flex gap-3">
          <NumericField
            label="X"
            value={transform.scaleX}
            min={0.01}
            max={10}
            step={0.01}
            suffix="%"
            onChange={handleScaleX}
          />
          <NumericField
            label="Y"
            value={transform.scaleY}
            min={0.01}
            max={10}
            step={0.01}
            suffix="%"
            onChange={handleScaleY}
          />
        </div>
      </div>

      {/* Rotation */}
      <div>
        <div className="text-zinc-400 mb-1">Rotation</div>
        <NumericField
          label="°"
          value={transform.rotation}
          min={-360}
          max={360}
          step={0.5}
          onChange={(v) => updateTransform({ rotation: v })}
        />
      </div>

      {/* Anchor */}
      <div>
        <div className="text-zinc-400 mb-1">Anchor Point</div>
        <div className="flex gap-3">
          <NumericField
            label="X"
            value={transform.anchorX}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => updateTransform({ anchorX: v })}
          />
          <NumericField
            label="Y"
            value={transform.anchorY}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => updateTransform({ anchorY: v })}
          />
        </div>
      </div>

      {/* Opacity */}
      <div>
        <div className="text-zinc-400 mb-1">Opacity</div>
        <div className="flex items-center gap-2">
          <NumericField
            label=""
            value={transform.opacity}
            min={0}
            max={1}
            step={0.01}
            suffix="%"
            onChange={(v) => updateTransform({ opacity: v })}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={transform.opacity}
            onChange={(e) => updateTransform({ opacity: parseFloat(e.target.value) })}
            className="flex-1 h-1 accent-blue-500"
          />
        </div>
      </div>

      {/* Blend Mode */}
      <div>
        <div className="text-zinc-400 mb-1">Blend Mode</div>
        <select
          value={clip.blendMode ?? 'normal'}
          onChange={(e) => setClipBlendMode(clipId, e.target.value as BlendMode)}
          className="w-full bg-zinc-800 text-zinc-200 text-xs px-2 py-1 rounded border border-zinc-600 outline-none focus:border-blue-500"
        >
          {BLEND_MODES.map((bm) => (
            <option key={bm.value} value={bm.value}>
              {bm.label}
            </option>
          ))}
        </select>
      </div>

      {/* Keyframe count info */}
      {clip.keyframes && clip.keyframes.length > 0 && (
        <div className="text-zinc-500 text-[10px]">
          {clip.keyframes.length} keyframe{clip.keyframes.length !== 1 ? 's' : ''}
        </div>
      )}

      {/* Reset */}
      <button
        onClick={handleReset}
        className="w-full text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition-colors"
      >
        Reset Transform
      </button>
    </div>
  )
}
