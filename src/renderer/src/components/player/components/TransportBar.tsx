/**
 * @module components/player/components/TransportBar
 * @description Playback transport controls — seek bar, play/pause, prev/next,
 * shuffle, repeat, volume, and now-playing indicator.
 */

import React from 'react'
import type { Track } from '../types'
import { formatTime } from '../types'

interface TransportBarProps {
  track: Track | null
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
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
}

export function TransportBar({
  track, playing, currentTime, duration, volume, shuffle, repeat,
  playlistLength, onTogglePlay, onPlayNext, onPlayPrev, onSeek, onSeekStart, onSeekEnd,
  onVolumeChange, onToggleShuffle, onCycleRepeat
}: TransportBarProps): React.JSX.Element {
  const seekPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const volPct = volume * 100

  return (
    <div className="shrink-0 rounded-xl px-4 py-3 space-y-2"
      style={{ background: 'rgba(15, 19, 32, 0.65)', backdropFilter: 'blur(24px)', borderTop: '1px solid rgba(255,255,255,0.04)' }}
    >
      {/* Seek bar */}
      <div className="flex items-center gap-2.5 group/seek">
        <span className="text-2xs text-surface-500 font-mono w-9 text-right select-none tabular-nums">{formatTime(currentTime)}</span>
        <div className="relative flex-1 flex items-center h-5 cursor-pointer group/bar">
          {/* Track background */}
          <div className="absolute left-0 right-0 h-1 rounded-full bg-white/8 group-hover/bar:h-1.5 transition-all" />
          {/* Filled portion */}
          <div
            className="absolute left-0 h-1 rounded-full bg-accent-500 group-hover/bar:h-1.5 transition-all"
            style={{ width: `${seekPct}%` }}
          />
          {/* Thumb */}
          <div
            className="absolute w-3 h-3 rounded-full bg-accent-400 border-2 border-accent-300 shadow-lg shadow-accent-500/30 pointer-events-none transition-opacity opacity-0 group-hover/bar:opacity-100"
            style={{ left: `calc(${seekPct}% - 6px)` }}
          />
          {/* Hidden native input */}
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
        <span className="text-2xs text-surface-500 font-mono w-9 select-none tabular-nums">{formatTime(duration)}</span>
      </div>

      {/* Controls row */}
      <div className="flex items-center">
        {/* Track name — left */}
        <div className="flex-1 min-w-0 pr-3">
          {track ? (
            <span className="text-xs text-surface-300 font-medium truncate block">{track.name}</span>
          ) : (
            <span className="text-xs text-surface-600 italic">No track loaded</span>
          )}
        </div>

        {/* Centered transport */}
        <div className="flex items-center gap-1.5">
          {/* Shuffle */}
          <button
            onClick={onToggleShuffle}
            className={`transport-btn w-8 h-8 ${shuffle ? 'transport-btn-active' : ''}`}
            title="Shuffle"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
          </button>
          {/* Prev */}
          <button
            onClick={onPlayPrev}
            disabled={playlistLength === 0}
            className="transport-btn w-8 h-8"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14" rx="1" /><polygon points="21,5 10,12 21,19" /></svg>
          </button>
          {/* Play / Pause */}
          <button
            onClick={onTogglePlay}
            disabled={!track}
            className="play-btn w-10 h-10 rounded-full flex items-center justify-center text-white cursor-pointer"
          >
            {playing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20" /></svg>
            )}
          </button>
          {/* Next */}
          <button
            onClick={onPlayNext}
            disabled={playlistLength === 0}
            className="transport-btn w-8 h-8"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,5 14,12 3,19" /><rect x="18" y="5" width="3" height="14" rx="1" /></svg>
          </button>
          {/* Repeat */}
          <button
            onClick={onCycleRepeat}
            className={`transport-btn w-8 h-8 relative ${repeat !== 'off' ? 'transport-btn-active' : ''}`}
            title={`Repeat: ${repeat}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {repeat === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold text-accent-300">1</span>
            )}
          </button>
        </div>

        {/* Volume — right */}
        <div className="flex-1 flex items-center justify-end gap-2 pl-3 group/vol">
          <button
            className="transport-btn w-7 h-7"
            onClick={() => {
              const fakeEvent = { target: { value: volume > 0 ? '0' : '0.7' } } as React.ChangeEvent<HTMLInputElement>
              onVolumeChange(fakeEvent)
            }}
            title={volume > 0 ? 'Mute' : 'Unmute'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor" stroke="none" />
              {volume > 0 && volume <= 0.5 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
              {volume > 0.5 && (
                <>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </>
              )}
              {volume === 0 && (
                <>
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </>
              )}
            </svg>
          </button>
          <div className="relative flex items-center w-20 h-4 cursor-pointer group/vol">
            {/* Track background */}
            <div className="absolute left-0 right-0 h-1 rounded-full bg-white/10" />
            {/* Filled portion */}
            <div
              className="absolute left-0 h-1 rounded-full bg-surface-300"
              style={{ width: `${volPct}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute w-2.5 h-2.5 rounded-full bg-surface-200 border border-surface-100 shadow pointer-events-none transition-opacity opacity-0 group-hover/vol:opacity-100"
              style={{ left: `calc(${volPct}% - 5px)` }}
            />
            {/* Hidden native input */}
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
        </div>
      </div>
    </div>
  )
}
