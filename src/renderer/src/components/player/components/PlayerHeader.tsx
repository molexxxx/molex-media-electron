/**
 * @module components/player/components/PlayerHeader
 * @description Header bar with track info and control buttons for the media player.
 */

import React from 'react'
import type { VisMode, AudioQuality } from '../../../visualizations'
import { VIS_LABELS, QUALITY_LABELS } from '../../../visualizations'

interface PlayerHeaderProps {
  track: { name: string } | null
  popout: boolean
  isPoppedOut: boolean
  visMode: VisMode
  audioQuality: AudioQuality
  showPlaylist: boolean
  playlistLength: number
  fullscreen: boolean
  onCycleQuality: () => void
  onCycleVisMode: () => void
  onTogglePlaylist: () => void
  onToggleUrlInput: () => void
  onToggleFullscreen: () => void
  onPopout: () => void
  onFileSelect: () => void
}

export function PlayerHeader({
  track, popout, isPoppedOut, visMode, audioQuality, showPlaylist,
  playlistLength, fullscreen, onCycleQuality, onCycleVisMode, onTogglePlaylist,
  onToggleUrlInput, onToggleFullscreen, onPopout, onFileSelect
}: PlayerHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between shrink-0">
      <div className="min-w-0">
        {!popout && <h1 className="text-2xl font-bold text-white">Media Player</h1>}
        <p className={`text-surface-400 truncate ${popout ? 'text-xs font-medium' : 'text-sm mt-0.5'}`}>
          {track ? track.name : 'Drop audio files, add URLs, or browse'}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onCycleQuality}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-800 border border-surface-600 text-surface-300 hover:text-white hover:border-accent-500 transition-colors"
          title={`Audio quality: ${QUALITY_LABELS[audioQuality]}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5 mr-1">
            <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            {audioQuality !== 'low' && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
          </svg>
          {QUALITY_LABELS[audioQuality]}
        </button>
        <button
          onClick={onCycleVisMode}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-800 border border-surface-600 text-surface-300 hover:text-white hover:border-accent-500 transition-colors"
        >
          {VIS_LABELS[visMode]}
        </button>
        <button
          onClick={onTogglePlaylist}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            showPlaylist ? 'bg-accent-600/20 border-accent-500 text-accent-300' : 'bg-surface-800 border-surface-600 text-surface-300 hover:text-white hover:border-accent-500'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5 mr-1">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          {playlistLength > 0 ? `${playlistLength}` : 'Playlist'}
        </button>
        <button
          onClick={onToggleUrlInput}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-800 border border-surface-600 text-surface-300 hover:text-white hover:border-accent-500 transition-colors"
          title="Add from URL"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </button>
        <button
          onClick={onToggleFullscreen}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            fullscreen ? 'bg-accent-600/20 border-accent-500 text-accent-300' : 'bg-surface-800 border-surface-600 text-surface-300 hover:text-white hover:border-accent-500'
          }`}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
        >
          {fullscreen ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5">
              <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
        {!popout && !isPoppedOut && (
          <button
            onClick={onPopout}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-800 border border-surface-600 text-surface-300 hover:text-white hover:border-accent-500 transition-colors"
            title="Pop out player"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5">
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
        )}
        <button
          onClick={onFileSelect}
          className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg transition-all"
        >
          Add Files
        </button>
      </div>
    </div>
  )
}
