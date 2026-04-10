/**
 * @module editor/inspect/TransformInspector
 * Numeric input panel for per-clip spatial transforms.
 *
 * Displays Position (x,y), Scale (x,y + uniform lock), Rotation,
 * Anchor Point, Opacity, and Blend Mode with keyframe toggle ◆.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Select, Toggle, FixedTip } from '../../shared/ui'
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

const BLEND_OPTIONS = BLEND_MODES.map((bm) => ({ value: bm.value, label: bm.label }))

// ---------------------------------------------------------------------------
// Custom themed slider (matches player/settings style)
// ---------------------------------------------------------------------------

function ThemedSlider({ value, min = 0, max = 1, step = 0.01, onChange }: {
  value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="group relative flex-1 flex items-center h-5 cursor-pointer">
      <div className="absolute left-0 right-0 h-1 rounded-full bg-white/[0.08] group-hover:h-1.5 transition-all" />
      <div className="absolute left-0 h-1 rounded-full bg-accent-500/70 group-hover:h-1.5 group-hover:bg-accent-400 transition-all" style={{ width: `${pct}%` }} />
      <div
        className="absolute w-2.5 h-2.5 rounded-full bg-accent-400 border-2 border-accent-600 shadow-sm shadow-accent-500/30 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -translate-x-1/2"
        style={{ left: `${pct}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
    </div>
  )
}

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
    <div className="flex items-center gap-1 min-w-0">
      {label && <span className="text-2xs text-surface-500 w-4 shrink-0 select-none">{label}</span>}
      {editing ? (
        <input
          type="text"
          className="flex-1 min-w-0 bg-white/[0.04] text-surface-200 text-2xs px-1.5 py-1 rounded-md border border-white/[0.06] outline-none focus:border-accent-500/50 transition-colors font-mono text-center"
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
          className="flex-1 min-w-0 text-2xs text-surface-200 bg-white/[0.04] border border-white/[0.06] hover:border-white/[0.12] px-1.5 py-1 rounded-md cursor-ew-resize select-none text-center tabular-nums font-mono transition-colors"
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
        <FixedTip label={hasKeyframe ? 'Remove keyframe' : 'Add keyframe'}>
          <button
            className={`text-2xs px-0.5 transition-colors ${hasKeyframe ? 'text-amber-400' : 'text-surface-600'} hover:text-amber-300`}
            onClick={onToggleKeyframe}
          >
            ◆
          </button>
        </FixedTip>
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
      <div className="px-3 py-6 text-2xs text-surface-500 italic text-center">
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
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-surface-200 font-medium">Transform</span>
        <div className="flex items-center gap-0.5">
          <FixedTip label={hasKeyframeAtFrame ? 'Remove keyframe' : 'Add keyframe'}>
            <button
              className={`flex items-center justify-center w-6 h-6 rounded-md transition-colors ${
                hasKeyframeAtFrame
                  ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                  : 'text-surface-600 hover:text-amber-300 hover:bg-white/[0.04]'
              }`}
              onClick={toggleKeyframe}
            >
              <span className="text-2xs">◆</span>
            </button>
          </FixedTip>
          <FixedTip label="Reset transform">
            <button
              onClick={handleReset}
              className="flex items-center justify-center w-6 h-6 rounded-md text-surface-500 hover:text-surface-200 hover:bg-white/[0.04] transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M2 2v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3.05 10A6 6 0 1 0 4 4L2 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </FixedTip>
        </div>
      </div>

      {/* Position */}
      <div>
        <div className="text-surface-500 mb-1.5 text-2xs uppercase tracking-wider">Position</div>
        <div className="flex gap-2">
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
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-surface-500 text-2xs uppercase tracking-wider">Scale</span>
          <FixedTip label={uniformScale ? 'Constrained' : 'Independent'}>
            <div className="flex items-center">
              <Toggle checked={uniformScale} onChange={setUniformScale} />
            </div>
          </FixedTip>
        </div>
        <div className="flex gap-2">
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
        <div className="text-surface-500 mb-1.5 text-2xs uppercase tracking-wider">Rotation</div>
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
        <div className="text-surface-500 mb-1.5 text-2xs uppercase tracking-wider">Anchor Point</div>
        <div className="flex gap-2">
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
        <div className="text-surface-500 mb-1.5 text-2xs uppercase tracking-wider">Opacity</div>
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
          <ThemedSlider
            value={transform.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => updateTransform({ opacity: v })}
          />
        </div>
      </div>

      {/* Blend Mode */}
      <div>
        <div className="text-surface-500 mb-1.5 text-2xs uppercase tracking-wider">Blend Mode</div>
        <Select
          value={clip.blendMode ?? 'normal'}
          onChange={(v) => setClipBlendMode(clipId, v as BlendMode)}
          options={BLEND_OPTIONS}
          compact
        />
      </div>

      {/* Keyframe count info */}
      {clip.keyframes && clip.keyframes.length > 0 && (
        <div className="text-surface-500 text-2xs tabular-nums">
          {clip.keyframes.length} keyframe{clip.keyframes.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}
