/**
 * @module components/player/components/PlayerHeader
 * @description Header bar with track info and control buttons for the media player.
 */

import React, { useState, useRef, useEffect } from 'react'
import type { VisMode, AudioQuality } from '../../../visualizations'
import { VIS_LABELS, QUALITY_LABELS } from '../../../visualizations'
import { FixedTip as Tip } from '../../shared/ui'

interface PlayerHeaderProps {
  track: { name: string } | null
  popout: boolean
  isPoppedOut: boolean
  visMode: VisMode
  audioQuality: AudioQuality
  showPlaylist: boolean
  playlistLength: number
  onCycleQuality: () => void
  onCycleVisMode: () => void
  onTogglePlaylist: () => void
  onToggleUrlInput: () => void
  onPopout: () => void
  onFileSelect: () => void
  onClearPlaylist?: () => void
}

/* -- Per-visualizer icons ------------------------------------------- */
const VIS_ICONS: Record<VisMode, React.JSX.Element> = {
  dmt: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      {/* Outer diamond / sacred geometry frame */}
      <path d="M12 2 L22 12 L12 22 L2 12 Z" />
      {/* Inner eye shape */}
      <path d="M5 12c3-4 11-4 14 0c-3 4-11 4-14 0z" />
      {/* Iris */}
      <circle cx="12" cy="12" r="2.5" />
      {/* Pupil */}
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  space: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" />
    </svg>
  ),
  milkdrop: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
    </svg>
  ),
  plasma: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  bars: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="14" width="4" height="7" rx="1" /><rect x="10" y="8" width="4" height="13" rx="1" /><rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  ),
  wave: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12c2-3 4-6 6-3s4 6 6 3 4-6 6-3" />
    </svg>
  ),
  circular: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" /><path d="M12 3a14.5 14.5 0 0 0 0 18M12 3a14.5 14.5 0 0 1 0 18M3 12h18" />
    </svg>
  ),
  horizon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 17l3-4 4 2 5-6 4 3 4-4" /><line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  ),
}

export function PlayerHeader({
  track, popout, isPoppedOut, visMode, audioQuality, showPlaylist,
  playlistLength, onCycleQuality, onCycleVisMode, onTogglePlaylist,
  onToggleUrlInput, onPopout, onFileSelect, onClearPlaylist
}: PlayerHeaderProps): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!addOpen) return
    const onClick = (e: MouseEvent): void => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [addOpen])

  const btnCls = 'w-8 h-8 rounded-lg flex items-center justify-center text-surface-400 hover:text-white hover:bg-surface-800 transition-colors'
  const btnActiveCls = 'w-8 h-8 rounded-lg flex items-center justify-center text-accent-300 bg-accent-600/20 transition-colors'

  return (
    <div className="flex items-center gap-2 shrink-0 min-w-0">
      <div className="min-w-0 flex-1">
        {!popout && <h2 className="text-lg font-medium text-surface-200 leading-tight tracking-tight truncate">Media Player</h2>}
        <p className={`text-surface-500 truncate text-xs`} title={track ? track.name : undefined}>
          {track ? track.name : 'Drop files, paste URLs, or browse'}
        </p>
      </div>
      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        {/* Audio quality */}
        <Tip label={`Quality: ${QUALITY_LABELS[audioQuality]}`}>
          <button onClick={onCycleQuality} className={`${btnCls} hidden sm:flex`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              {audioQuality !== 'low' && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
            </svg>
          </button>
        </Tip>

        {/* Visualizer mode — unique icon per mode */}
        <Tip label={VIS_LABELS[visMode]}>
          <button onClick={onCycleVisMode} className={`${btnCls} hidden sm:flex`}>
            {VIS_ICONS[visMode]}
          </button>
        </Tip>

        {/* Playlist toggle */}
        <Tip label={`Playlist${playlistLength > 0 ? ` (${playlistLength})` : ''}`}>
          <button onClick={onTogglePlaylist} className={showPlaylist ? btnActiveCls : btnCls}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </Tip>

        {/* Pop out — separate */}
        {!popout && !isPoppedOut && (
          <Tip label="Pop out">
            <button onClick={onPopout} className={btnCls}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
                <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
            </button>
          </Tip>
        )}

        {/* Add dropdown — combines browse, file select, URL */}
        <div ref={addRef} className="relative">
          <Tip label="Add tracks">
            <button
              onClick={() => setAddOpen((v) => !v)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                addOpen ? 'bg-accent-500/25 text-accent-200 border border-accent-500/30' : 'bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 border border-accent-500/20'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </Tip>
          {addOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl z-50 overflow-hidden animate-fade-in">
              <button
                onClick={() => { setAddOpen(false); onFileSelect() }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-400 shrink-0">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14,2 14,8 20,8" />
                </svg>
                Choose Files
              </button>
              <div className="border-t border-white/[0.06]" />
              <button
                onClick={() => { setAddOpen(false); onToggleUrlInput() }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-400 shrink-0">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                External Link
              </button>
              {onClearPlaylist && playlistLength > 0 && (
                <>
                  <div className="border-t border-white/[0.06]" />
                  <button
                    onClick={() => { setAddOpen(false); onClearPlaylist() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                    Clear Playlist
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
