/**
 * @module components/layout/PopoutShell
 * @description Borderless popout window shell wrapping the media player with pin/close controls.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { MediaPlayer } from '../../player'

export function PopoutShell(): React.JSX.Element {
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    window.api.isPinned?.().then(setPinned)
  }, [])

  const togglePin = useCallback(async () => {
    const newVal = await window.api.togglePin()
    setPinned(newVal)
  }, [])

  return (
    <div className="h-full flex flex-col bg-surface-950">
      <div className="drag-region h-8 flex items-center justify-between bg-surface-950/90 border-b border-white/5 px-3 shrink-0">
        <div className="flex items-center gap-2 no-drag">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-500" />
          <span className="text-[10px] font-semibold tracking-widest uppercase text-surface-400">
            molex<span className="text-accent-400">Media</span>
          </span>
        </div>
        <div className="flex items-center gap-0.5 no-drag">
          <button
            onClick={togglePin}
            className={`w-7 h-5 flex items-center justify-center rounded transition-colors ${
              pinned ? 'text-accent-400 bg-accent-600/20' : 'text-surface-500 hover:bg-surface-700/50'
            }`}
            title={pinned ? 'Unpin from top' : 'Pin on top'}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M9 4v6l-2 4v2h10v-2l-2-4V4" /><line x1="12" y1="16" x2="12" y2="22" /><line x1="8" y1="4" x2="16" y2="4" />
            </svg>
          </button>
          <button onClick={() => window.api.windowMinimize?.()} className="w-7 h-5 flex items-center justify-center rounded hover:bg-surface-700/50 transition-colors">
            <svg width="8" height="1" viewBox="0 0 10 1" fill="currentColor" className="text-surface-400"><rect width="10" height="1" /></svg>
          </button>
          <button onClick={() => window.api.windowClose?.()} className="w-7 h-5 flex items-center justify-center rounded hover:bg-red-500/80 transition-colors group">
            <svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" className="text-surface-400 group-hover:text-white" strokeWidth="1.3">
              <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      </div>
      <main className="flex-1 overflow-auto p-4">
        <MediaPlayer popout />
      </main>
    </div>
  )
}
