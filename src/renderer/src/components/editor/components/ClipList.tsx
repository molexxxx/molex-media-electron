/**
 * @module components/editor/ClipList
 * @description Responsive clip list with per-clip loading indicators and merge action.
 * Desktop: vertical sidebar. Tablet/mobile: horizontal scrollable strip.
 */

import React from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime } from '../types'

interface ClipListProps {
  onMerge: () => void
}

export function ClipList({ onMerge }: ClipListProps): React.JSX.Element {
  const { clips, activeIdx, processing, setActiveIdx, removeClip, canMerge } = useEditorStore()

  return (
    <div className="lg:w-52 shrink-0 glass rounded-xl p-3 flex flex-col gap-2 overflow-auto max-h-48 lg:max-h-none">
      <div className="flex items-center justify-between mb-1">
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
      <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto pb-1 lg:pb-0">
        {clips.map((c, i) => (
          <button
            key={c.id}
            onClick={() => setActiveIdx(i)}
            className={`min-w-35 lg:min-w-0 w-full text-left px-3 py-2 rounded-lg text-xs transition-all shrink-0 lg:shrink ${
              i === activeIdx
                ? 'bg-accent-500/15 text-accent-300 border border-accent-500/20'
                : 'text-surface-300 hover:bg-surface-700/50 border border-transparent'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1.5 min-w-0">
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
              <button
                onClick={(e) => { e.stopPropagation(); removeClip(i) }}
                className="text-surface-500 hover:text-red-400 transition-colors shrink-0"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="text-2xs text-surface-500 mt-0.5 font-mono">
              {c.loadingState === 'probing' && 'Probing…'}
              {c.loadingState === 'transcoding' && 'Preparing preview…'}
              {c.loadingState === 'error' && 'Failed to load'}
              {c.loadingState === 'ready' && `${formatTime(c.inPoint)} → ${formatTime(c.outPoint)}`}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
