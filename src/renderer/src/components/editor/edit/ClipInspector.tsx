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

export function ClipInspector({ clip }: ClipInspectorProps): React.JSX.Element {
  const setClipVolume = useEditorStore((s) => s.setClipVolume)
  const setClipPan = useEditorStore((s) => s.setClipPan)
  const toggleClipMuted = useEditorStore((s) => s.toggleClipMuted)

  const handleVolume = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setClipVolume(clip.id, parseFloat(e.target.value))
    },
    [clip.id, setClipVolume]
  )

  const handlePan = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setClipPan(clip.id, parseFloat(e.target.value))
    },
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
      <label className="flex items-center gap-1 cursor-default" title="Clip volume (0-200%)">
        <button
          type="button"
          onClick={handleMuteToggle}
          className={`flex-shrink-0 ${clip.muted ? 'text-yellow-400' : 'text-surface-500 hover:text-surface-300'}`}
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
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={clip.volume}
          onChange={handleVolume}
          className="w-14 h-1 accent-accent-400 cursor-pointer"
        />
        <span className="w-8 text-right tabular-nums">{volPercent}%</span>
      </label>

      {/* Pan */}
      <label className="flex items-center gap-1 cursor-default" title="Stereo pan (L100 – C – R100)">
        <span className="text-surface-500">Pan</span>
        <input
          type="range"
          min="-1"
          max="1"
          step="0.01"
          value={clip.pan}
          onChange={handlePan}
          className="w-12 h-1 accent-accent-400 cursor-pointer"
        />
        <span className="w-6 text-right tabular-nums">{panLabel}</span>
      </label>

      {/* Speed indicator (read-only for now) */}
      {clip.speed !== 1 && (
        <span title="Playback speed" className="text-surface-500">
          {clip.speed.toFixed(2)}×
        </span>
      )}
    </div>
  )
}
