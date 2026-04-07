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
  onSeekStart: () => void
  onSeekEnd: (e: React.ChangeEvent<HTMLInputElement> | React.MouseEvent | React.TouchEvent) => void
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
  onPlayPrev, onSeek, onSeekStart, onSeekEnd, onVolumeChange, onToggleShuffle, onCycleRepeat,
  onCycleVisMode, onTogglePlaylist, onFileSelect
}: PopoutTransportProps): React.JSX.Element {
  const seekPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const volPct = volume * 100

  return (
    <div className="shrink-0 space-y-1 px-1.5 pb-1">
      {/* Track name + vis + add */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="flex-1 text-xs text-surface-300 font-medium truncate min-w-0">
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
      <div className="flex items-center gap-2 group/seek">
        <span className="text-[9px] text-surface-500 font-mono w-7 text-right select-none tabular-nums">{formatTime(currentTime)}</span>
        <div className="relative flex-1 flex items-center h-4 cursor-pointer group/bar">
          <div className="absolute left-0 right-0 h-1 rounded-full bg-white/8 group-hover/bar:h-1.5 transition-all" />
          <div
            className="absolute left-0 h-1 rounded-full bg-accent-500 group-hover/bar:h-1.5 transition-all"
            style={{ width: `${seekPct}%` }}
          />
          <div
            className="absolute w-2.5 h-2.5 rounded-full bg-accent-400 border-2 border-accent-300 shadow-lg shadow-accent-500/30 pointer-events-none transition-opacity opacity-0 group-hover/bar:opacity-100"
            style={{ left: `calc(${seekPct}% - 5px)` }}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={onSeek}
            onMouseDown={onSeekStart}
            onMouseUp={onSeekEnd}
            onTouchStart={onSeekStart}
            onTouchEnd={onSeekEnd}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>
        <span className="text-[9px] text-surface-500 font-mono w-7 select-none tabular-nums">{formatTime(duration)}</span>
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          {/* Shuffle */}
          <button
            onClick={onToggleShuffle}
            className={`transport-btn w-6 h-6 ${shuffle ? 'transport-btn-active' : ''}`}
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
            className="transport-btn w-6 h-6"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14" rx="1" /><polygon points="21,5 10,12 21,19" /></svg>
          </button>
          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            disabled={!track}
            className="play-btn w-8 h-8 rounded-full flex items-center justify-center text-white cursor-pointer"
          >
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20" /></svg>
            )}
          </button>
          {/* Next */}
          <button
            onClick={onPlayNext}
            disabled={playlistLength === 0}
            className="transport-btn w-6 h-6"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,5 14,12 3,19" /><rect x="18" y="5" width="3" height="14" rx="1" /></svg>
          </button>
          {/* Repeat */}
          <button
            onClick={onCycleRepeat}
            className={`transport-btn w-6 h-6 relative ${repeat !== 'off' ? 'transport-btn-active' : ''}`}
            title={`Repeat: ${repeat}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {repeat === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold text-accent-300">1</span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* Volume */}
          <button
            className="transport-btn w-5 h-5"
            onClick={() => {
              const fakeEvent = { target: { value: volume > 0 ? '0' : '0.7' } } as React.ChangeEvent<HTMLInputElement>
              onVolumeChange(fakeEvent)
            }}
            title={volume > 0 ? 'Mute' : 'Unmute'}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
              <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" stroke="none" />
              {volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
              {volume === 0 && (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              )}
            </svg>
          </button>
          <div className="relative flex items-center w-14 h-3 cursor-pointer group/vol">
            <div className="absolute left-0 right-0 h-0.75 rounded-full bg-white/10" />
            <div
              className="absolute left-0 h-0.75 rounded-full bg-surface-300"
              style={{ width: `${volPct}%` }}
            />
            <div
              className="absolute w-2 h-2 rounded-full bg-surface-200 border border-surface-100 shadow pointer-events-none transition-opacity opacity-0 group-hover/vol:opacity-100"
              style={{ left: `calc(${volPct}% - 4px)` }}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={onVolumeChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          {/* Playlist */}
          <button
            onClick={onTogglePlaylist}
            className={`transport-btn w-6 h-6 ${showPlaylist ? 'transport-btn-active' : ''}`}
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
