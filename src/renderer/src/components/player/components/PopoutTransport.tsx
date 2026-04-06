/**
 * @module components/player/components/PopoutTransport
 * @description Compact transport controls designed specifically for the popout
 * player window. Shows track name, seek bar, playback controls, and volume
 * in a minimal condensed layout.
 */

import React from 'react'
import type { Track } from '../types'
import { formatTime } from '../types'
import type { VisMode } from '../../../visualizations'
import { VIS_LABELS } from '../../../visualizations'

interface PopoutTransportProps {
  track: Track | null
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  visMode: VisMode
  showPlaylist: boolean
  playlistLength: number
  onTogglePlay: () => void
  onPlayNext: () => void
  onPlayPrev: () => void
  onSeek: (e: React.ChangeEvent<HTMLInputElement>) => void
  onVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
  onCycleVisMode: () => void
  onTogglePlaylist: () => void
  onFileSelect: () => void
}

export function PopoutTransport({
  track, playing, currentTime, duration, volume, shuffle, repeat,
  visMode, showPlaylist, playlistLength, onTogglePlay, onPlayNext,
  onPlayPrev, onSeek, onVolumeChange, onToggleShuffle, onCycleRepeat,
  onCycleVisMode, onTogglePlaylist, onFileSelect
}: PopoutTransportProps): React.JSX.Element {
  return (
    <div className="shrink-0 space-y-1 px-1 pb-0.5">
      {/* Track name + vis + add */}
      <div className="flex items-center gap-1.5 min-w-0">
        {track && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-accent-400 shrink-0">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        )}
        <span className="flex-1 text-[11px] text-surface-300 font-medium truncate min-w-0">
          {track ? track.name : 'No track loaded'}
        </span>
        <button
          onClick={onCycleVisMode}
          className="shrink-0 px-1.5 py-0.5 text-[9px] font-medium rounded bg-surface-800/60 text-surface-500 hover:text-surface-200 transition-colors"
          title={`Visualization: ${VIS_LABELS[visMode]}`}
        >
          {VIS_LABELS[visMode]}
        </button>
        <button
          onClick={onFileSelect}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded bg-surface-800/60 text-surface-500 hover:text-surface-200 transition-colors"
          title="Add files"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Seek bar */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] text-surface-500 font-mono w-7 text-right select-none">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={onSeek}
          className="flex-1 h-0.5 accent-accent-500 cursor-pointer"
          style={{ accentColor: 'var(--tw-accent-500, #8b5cf6)' }}
        />
        <span className="text-[9px] text-surface-500 font-mono w-7 select-none">{formatTime(duration)}</span>
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          {/* Shuffle */}
          <button
            onClick={onToggleShuffle}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              shuffle ? 'text-accent-400' : 'text-surface-500 hover:text-surface-300'
            }`}
            title="Shuffle"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </button>
          {/* Prev */}
          <button
            onClick={onPlayPrev}
            disabled={playlistLength === 0}
            className="w-6 h-6 rounded flex items-center justify-center text-surface-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14" rx="1" /><polygon points="21,5 10,12 21,19" /></svg>
          </button>
          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            disabled={!track}
            className="w-8 h-8 rounded-full bg-accent-600 hover:bg-accent-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-white transition-all shadow-glow"
          >
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
            )}
          </button>
          {/* Next */}
          <button
            onClick={onPlayNext}
            disabled={playlistLength === 0}
            className="w-6 h-6 rounded flex items-center justify-center text-surface-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,5 14,12 3,19" /><rect x="18" y="5" width="3" height="14" rx="1" /></svg>
          </button>
          {/* Repeat */}
          <button
            onClick={onCycleRepeat}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors relative ${
              repeat !== 'off' ? 'text-accent-400' : 'text-surface-500 hover:text-surface-300'
            }`}
            title={`Repeat: ${repeat}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {repeat === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold text-accent-400">1</span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* Volume */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-surface-500 shrink-0">
            <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={onVolumeChange}
            className="w-14 h-0.5 accent-surface-400 cursor-pointer"
          />
          {/* Playlist */}
          <button
            onClick={onTogglePlaylist}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              showPlaylist ? 'text-accent-400' : 'text-surface-500 hover:text-surface-300'
            }`}
            title="Playlist"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
