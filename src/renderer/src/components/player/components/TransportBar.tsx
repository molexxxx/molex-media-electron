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
  onVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
}

export function TransportBar({
  track, playing, currentTime, duration, volume, shuffle, repeat,
  playlistLength, onTogglePlay, onPlayNext, onPlayPrev, onSeek,
  onVolumeChange, onToggleShuffle, onCycleRepeat
}: TransportBarProps): React.JSX.Element {
  return (
    <div className="shrink-0 glass rounded-xl px-5 py-4 space-y-3">
      {/* Seek bar */}
      <div className="flex items-center gap-3">
        <span className="text-2xs text-surface-500 font-mono w-10 text-right">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={onSeek}
          className="flex-1 h-1 accent-accent-500 cursor-pointer"
          style={{ accentColor: 'var(--tw-accent-500, #8b5cf6)' }}
        />
        <span className="text-2xs text-surface-500 font-mono w-10">{formatTime(duration)}</span>
      </div>
      {/* Buttons row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Shuffle */}
          <button
            onClick={onToggleShuffle}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              shuffle ? 'text-accent-400 bg-accent-600/20' : 'text-surface-500 hover:text-surface-300'
            }`}
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
            className="w-8 h-8 rounded-lg flex items-center justify-center text-surface-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="5" width="3" height="14" rx="1" /><polygon points="21,5 10,12 21,19" /></svg>
          </button>
          {/* Play/Pause */}
          <button
            onClick={onTogglePlay}
            disabled={!track}
            className="w-10 h-10 rounded-full bg-accent-600 hover:bg-accent-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center text-white transition-all shadow-glow hover:shadow-glow-lg"
          >
            {playing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
            )}
          </button>
          {/* Next */}
          <button
            onClick={onPlayNext}
            disabled={playlistLength === 0}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-surface-400 hover:text-white disabled:opacity-30 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,5 14,12 3,19" /><rect x="18" y="5" width="3" height="14" rx="1" /></svg>
          </button>
          {/* Repeat */}
          <button
            onClick={onCycleRepeat}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors relative ${
              repeat !== 'off' ? 'text-accent-400 bg-accent-600/20' : 'text-surface-500 hover:text-surface-300'
            }`}
            title={`Repeat: ${repeat}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {repeat === 'one' && (
              <span className="absolute -top-0.5 -right-0.5 text-[8px] font-bold text-accent-400">1</span>
            )}
          </button>
          {/* Track name */}
          {track && (
            <span className="text-xs text-surface-300 font-medium truncate max-w-[200px] ml-1">{track.name}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-500">
            <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={onVolumeChange}
            className="w-20 h-1 accent-surface-400 cursor-pointer"
          />
        </div>
      </div>
    </div>
  )
}
