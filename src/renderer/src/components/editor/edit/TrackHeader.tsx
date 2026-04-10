/**
 * @module editor/edit/TrackHeader
 * Track name + mute/lock/visible toggles.
 */
import React, { useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineTrack } from '../types'

interface TrackHeaderProps {
  track: TimelineTrack
  isSelected: boolean
  onSelect: () => void
}

export function TrackHeader({ track, isSelected, onSelect }: TrackHeaderProps): React.JSX.Element {
  const removeTrack = useEditorStore((s) => s.removeTrack)

  const toggleMute = useCallback(() => {
    useEditorStore.setState((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) =>
          t.id === track.id ? { ...t, muted: !t.muted } : t
        )
      }
    }))
  }, [track.id])

  const toggleLock = useCallback(() => {
    useEditorStore.setState((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) =>
          t.id === track.id ? { ...t, locked: !t.locked } : t
        )
      }
    }))
  }, [track.id])

  const toggleVisible = useCallback(() => {
    useEditorStore.setState((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) =>
          t.id === track.id ? { ...t, visible: !t.visible } : t
        )
      }
    }))
  }, [track.id])

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 border-b border-white/5 select-none cursor-pointer ${
        isSelected ? 'bg-accent-500/10' : 'bg-surface-900/80 hover:bg-white/[0.03]'
      }`}
      style={{ height: track.height }}
      onClick={onSelect}
    >
      <span className="text-[11px] font-semibold text-surface-300 shrink-0">
        {track.name}
      </span>

      <div className="flex items-center gap-0.5 ml-auto shrink-0">
        {/* Visible toggle (video only) */}
        {track.type === 'video' && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleVisible() }}
            className={`w-5 h-5 flex items-center justify-center rounded ${
              track.visible ? 'text-surface-300 hover:text-white' : 'text-surface-600'
            }`}
            title={track.visible ? 'Hide' : 'Show'}
          >
            {track.visible ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>
        )}

        {/* Mute */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleMute() }}
          className={`w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold ${
            track.muted ? 'text-yellow-400 bg-yellow-400/10' : 'text-surface-500 hover:text-surface-300'
          }`}
          title={track.muted ? 'Unmute' : 'Mute'}
        >
          M
        </button>

        {/* Lock */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleLock() }}
          className={`w-5 h-5 flex items-center justify-center rounded ${
            track.locked ? 'text-red-400 bg-red-400/10' : 'text-surface-500 hover:text-surface-300'
          }`}
          title={track.locked ? 'Unlock' : 'Lock'}
        >
          {track.locked ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          )}
        </button>

        {/* Delete */}
        <button
          onClick={(e) => { e.stopPropagation(); if (!track.locked) removeTrack(track.id) }}
          disabled={track.locked}
          className={`w-5 h-5 flex items-center justify-center rounded transition-all ${
            track.locked
              ? 'text-surface-700 cursor-not-allowed opacity-50'
              : isSelected ? 'text-red-400/70 hover:text-red-400 hover:bg-red-400/10' : 'text-surface-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-400/10'
          }`}
          title={track.locked ? 'Unlock track to delete' : 'Remove track'}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
