/**
 * @module components/player/components/PlaylistPanel
 * @description Collapsible playlist sidebar with drag-to-reorder, now-playing
 * indicator, and per-track controls.
 */

import React, { useCallback, useState } from 'react'
import type { Track } from '../types'

interface PlaylistPanelProps {
  playlist: Track[]
  trackIdx: number
  playing: boolean
  vertical?: boolean
  onPlayTrack: (idx: number) => void
  onRemoveTrack: (idx: number) => void
  onMoveTrack: (from: number, to: number) => void
  onClearPlaylist: () => void
}

export function PlaylistPanel({
  playlist, trackIdx, playing, vertical, onPlayTrack, onRemoveTrack, onMoveTrack, onClearPlaylist
}: PlaylistPanelProps): React.JSX.Element {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  const handleDragStart = useCallback((idx: number) => setDragIdx(idx), [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    setDragOverIdx(idx)
  }, [])

  const handleDrop = useCallback((idx: number) => {
    if (dragIdx !== null && dragIdx !== idx) onMoveTrack(dragIdx, idx)
    setDragIdx(null)
    setDragOverIdx(null)
  }, [dragIdx, onMoveTrack])

  const handleDragEnd = useCallback(() => {
    setDragIdx(null)
    setDragOverIdx(null)
  }, [])

  return (
    <div className={`${vertical ? 'w-full max-h-48' : 'w-72'} shrink-0 flex flex-col glass rounded-2xl border border-white/5 overflow-hidden`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <span className="text-sm font-semibold text-white">Playlist</span>
        <div className="flex items-center gap-1">
          {playlist.length > 0 && (
            <button
              onClick={onClearPlaylist}
              className="text-2xs text-surface-500 hover:text-red-400 transition-colors px-1"
              title="Clear all"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {playlist.length === 0 ? (
          <div className="flex items-center justify-center h-full text-surface-500 text-xs p-4 text-center">
            <div>
              <p className="mb-2">No tracks yet</p>
              <p className="text-surface-600 text-2xs">Drop files, browse, or paste URLs</p>
            </div>
          </div>
        ) : (
          <div className="p-1">
            {playlist.map((t, idx) => (
              <div
                key={t.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  idx === trackIdx
                    ? 'bg-accent-600/20 text-accent-300'
                    : 'text-surface-300 hover:bg-surface-800/50 hover:text-white'
                } ${dragOverIdx === idx && dragIdx !== idx ? 'border-t-2 border-accent-500' : ''} ${dragIdx === idx ? 'opacity-40' : ''}`}
                onClick={() => onPlayTrack(idx)}
              >
                <span className="w-5 text-center shrink-0 cursor-grab active:cursor-grabbing" title="Drag to reorder">
                  {idx === trackIdx && playing ? (
                    <span className="inline-flex gap-0.5 items-end h-3">
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '60%' }} />
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '100%', animationDelay: '0.15s' }} />
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '40%', animationDelay: '0.3s' }} />
                    </span>
                  ) : (
                    <span className="text-2xs text-surface-600">{idx + 1}</span>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{t.name}</p>
                  {t.videoUrl && <p className="text-2xs text-red-400/60 truncate">YouTube</p>}
                  {!t.isBlob && !t.videoUrl && t.src && <p className="text-2xs text-surface-600 truncate">{t.src}</p>}
                </div>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-all">
                  <button
                    onClick={(e) => { e.stopPropagation(); if (idx > 0) onMoveTrack(idx, idx - 1) }}
                    className={`text-surface-500 hover:text-white transition-colors ${idx === 0 ? 'invisible' : ''}`}
                    title="Move up"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (idx < playlist.length - 1) onMoveTrack(idx, idx + 1) }}
                    className={`text-surface-500 hover:text-white transition-colors ${idx === playlist.length - 1 ? 'invisible' : ''}`}
                    title="Move down"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveTrack(idx) }}
                    className="text-surface-500 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
