/**
 * @module components/editor/ClipList
 * @description Responsive clip list with per-clip loading indicators, replace-audio
 * action for video clips, and merge controls.
 * Desktop: vertical sidebar. Tablet/mobile: horizontal scrollable strip.
 */

import React from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime } from '../types'

interface ClipListProps {
  onMerge: () => void
  onReplaceAudio: (clipId: string) => void
}

export function ClipList({ onMerge, onReplaceAudio }: ClipListProps): React.JSX.Element {
  const { clips, activeIdx, processing, setActiveIdx, removeClip, canMerge } = useEditorStore()

  return (
    <div className="lg:w-56 shrink-0 glass-panel rounded-2xl p-3 flex flex-col gap-2 overflow-auto max-h-48 lg:max-h-none">
      <div className="flex items-center justify-between pb-2 section-line">
        <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">Clips ({clips.length})</span>
        {canMerge() && (
          <button
            onClick={onMerge}
            disabled={processing}
            className="text-2xs font-semibold text-accent-400 hover:text-accent-300 disabled:opacity-40 transition-colors"
          >
            Merge All
          </button>
        )}
      </div>
      {/* Desktop: vertical list. Mobile/tablet: horizontal scroll */}
      <div className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto pb-1 lg:pb-0">
        {clips.map((c, i) => (
          <button
            key={c.id}
            onClick={() => setActiveIdx(i)}
            className={`group min-w-36 lg:min-w-0 w-full text-left px-3 py-2.5 rounded-xl text-xs transition-all duration-200 shrink-0 lg:shrink relative ${
              i === activeIdx
                ? 'bg-accent-500/10 text-accent-300 border-l-2 border-accent-500 border-y border-r border-y-transparent border-r-transparent'
                : 'text-surface-300 hover:bg-white/[0.03] border-l-2 border-transparent'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-2 min-w-0">
                {c.loadingState !== 'ready' && c.loadingState !== 'error' && (
                  <div className="w-3 h-3 border border-accent-500/30 border-t-accent-400 rounded-full animate-spin shrink-0" />
                )}
                {c.loadingState === 'error' && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0">
                    <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                  </svg>
                )}
                <span className="truncate font-medium">{c.name}</span>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                {c.isVideo && c.loadingState === 'ready' && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onReplaceAudio(c.id) }}
                    className="text-surface-600 hover:text-amber-400 transition-colors cursor-pointer p-0.5"
                    title="Replace audio track"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                    </svg>
                  </span>
                )}
                <span
                  onClick={(e) => { e.stopPropagation(); removeClip(i) }}
                  className="text-surface-600 hover:text-red-400 transition-all cursor-pointer p-0.5"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </span>
              </div>
            </div>
            <div className="text-2xs text-surface-500 mt-1 font-mono">
              {c.loadingState === 'probing' && 'Probing…'}
              {c.loadingState === 'transcoding' && 'Preparing preview…'}
              {c.loadingState === 'error' && 'Failed to load'}
              {c.loadingState === 'ready' && `${formatTime(c.inPoint)} → ${formatTime(c.outPoint)}`}
            </div>
            {c.audioReplacement && (
              <div className="flex items-center gap-1 mt-1">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
                <span className="text-[9px] text-amber-300/70 truncate">{c.audioReplacement.name}</span>
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
