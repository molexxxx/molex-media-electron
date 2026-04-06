/**
 * @module components/editor/ClipSidebar
 * @description Sidebar listing loaded clips with add/remove controls and active clip selection.
 */

import React from 'react'
import type { Clip } from '../types'
import { formatTime } from '../types'

interface ClipSidebarProps {
  clips: Clip[]
  activeIdx: number
  processing: boolean
  onSetActiveIdx: (idx: number) => void
  onRemoveClip: (idx: number) => void
  onMerge: () => void
}

export function ClipSidebar({ clips, activeIdx, processing, onSetActiveIdx, onRemoveClip, onMerge }: ClipSidebarProps): React.JSX.Element {
  return (
    <div className="w-52 shrink-0 glass rounded-xl p-3 flex flex-col gap-2 overflow-auto">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">Clips ({clips.length})</span>
        {clips.length >= 2 && (
          <button
            onClick={onMerge}
            disabled={processing}
            className="text-2xs font-semibold text-accent-400 hover:text-accent-300 disabled:opacity-40 transition-colors"
          >
            Merge All
          </button>
        )}
      </div>
      {clips.map((c, i) => (
        <button
          key={c.id}
          onClick={() => onSetActiveIdx(i)}
          className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
            i === activeIdx
              ? 'bg-accent-500/15 text-accent-300 border border-accent-500/20'
              : 'text-surface-300 hover:bg-surface-700/50 border border-transparent'
          }`}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="truncate font-medium">{c.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveClip(i) }}
              className="text-surface-500 hover:text-red-400 transition-colors shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="text-2xs text-surface-500 mt-0.5 font-mono">
            {formatTime(c.inPoint)} → {formatTime(c.outPoint)}
          </div>
        </button>
      ))}
    </div>
  )
}
