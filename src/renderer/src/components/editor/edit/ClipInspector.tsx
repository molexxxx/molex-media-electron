/**
 * @module editor/edit/ClipInspector
 * Inline controls for the selected clip: volume slider, pan slider, speed, mute toggle.
 * Appears in the status bar area when exactly one clip is selected.
 */
import React, { useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineClip } from '../types'

interface ClipInspectorProps {
  clip: TimelineClip
}

/** Themed inline slider matching the player/transport style. */
function InlineSlider({ value, min, max, step, width, onChange, accentColor = 'accent' }: {
  value: number; min: number; max: number; step: number; width: string
  onChange: (v: number) => void; accentColor?: 'accent' | 'surface'
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  const fillCls = accentColor === 'accent' ? 'bg-accent-500/70 group-hover:bg-accent-400' : 'bg-surface-300'
  const thumbCls = accentColor === 'accent'
    ? 'bg-accent-400 border-accent-600 shadow-accent-500/30'
    : 'bg-surface-200 border-surface-400 shadow-black/20'
  return (
    <div className={`group relative flex items-center h-3.5 cursor-pointer ${width}`}>
      <div className="absolute left-0 right-0 h-[3px] rounded-full bg-white/[0.08]" />
      <div className={`absolute left-0 h-[3px] rounded-full ${fillCls} transition-colors`} style={{ width: `${pct}%` }} />
      <div
        className={`absolute w-2 h-2 rounded-full ${thumbCls} border opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none -translate-x-1/2`}
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

export function ClipInspector({ clip }: ClipInspectorProps): React.JSX.Element {
  const setClipVolume = useEditorStore((s) => s.setClipVolume)
  const setClipPan = useEditorStore((s) => s.setClipPan)
  const toggleClipMuted = useEditorStore((s) => s.toggleClipMuted)

  const handleVolume = useCallback(
    (v: number) => setClipVolume(clip.id, v),
    [clip.id, setClipVolume]
  )

  const handlePan = useCallback(
    (v: number) => setClipPan(clip.id, v),
    [clip.id, setClipPan]
  )

  const handleMuteToggle = useCallback(() => {
    toggleClipMuted(clip.id)
  }, [clip.id, toggleClipMuted])

  const volPercent = Math.round(clip.volume * 100)
  const panLabel = clip.pan === 0 ? 'C' : clip.pan < 0 ? `L${Math.round(-clip.pan * 100)}` : `R${Math.round(clip.pan * 100)}`

  return (
    <div className="flex items-center gap-3 text-[10px] text-surface-400">
      {/* Mute + Volume */}
      <div className="flex items-center gap-1.5" title="Clip volume (0-200%)">
        <button
          type="button"
          onClick={handleMuteToggle}
          className={`flex-shrink-0 ${clip.muted ? 'text-yellow-400' : 'text-surface-500 hover:text-surface-300'} transition-colors`}
          title={clip.muted ? 'Unmute clip' : 'Mute clip'}
        >
          {clip.muted ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12A4.5 4.5 0 0014 16.32V14.97a3 3 0 000-5.94V7.68A4.5 4.5 0 0016.5 12zM19 12a7 7 0 00-5-6.71v1.55a5.5 5.5 0 010 10.32v1.55A7 7 0 0019 12z" opacity="0.3" />
              <path d="M3 9v6h4l5 5V4L7 9H3z" />
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0012 8.14v7.72A4.48 4.48 0 0016.5 12z" />
            </svg>
          )}
        </button>
        <InlineSlider value={clip.volume} min={0} max={2} step={0.01} width="w-14" onChange={handleVolume} />
        <span className="w-8 text-right tabular-nums">{volPercent}%</span>
      </div>

      {/* Pan */}
      <div className="flex items-center gap-1.5" title="Stereo pan (L100 – C – R100)">
        <button
          type="button"
          onClick={() => handlePan(0)}
          className="text-surface-500 hover:text-surface-200 transition-colors cursor-pointer"
          title="Reset pan to center"
        >
          {panLabel}
        </button>
        <InlineSlider value={clip.pan} min={-1} max={1} step={0.01} width="w-12" onChange={handlePan} accentColor="surface" />
      </div>

      {/* Speed indicator (read-only for now) */}
      {clip.speed !== 1 && (
        <span title="Playback speed" className="text-surface-500">
          {clip.speed.toFixed(2)}×
        </span>
      )}
    </div>
  )
}
