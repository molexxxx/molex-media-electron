/**
 * @module components/layout/PopoutShell
 * @description Minimal popout window shell wrapping the media player with
 * pin/close controls and size presets.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MediaPlayer } from '../../player'

const SIZE_PRESETS = [
  { label: 'Small', w: 360, h: 480 },
  { label: 'Medium', w: 420, h: 560 },
  { label: 'Large', w: 560, h: 680 }
] as const

export function PopoutShell(): React.JSX.Element {
  const [pinned, setPinned] = useState(true)
  const [showSizeMenu, setShowSizeMenu] = useState(false)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.isPinned?.().then(setPinned)
    // Determine active preset from saved size
    window.api.getPopoutSize?.().then(({ width, height }) => {
      const match = SIZE_PRESETS.find(p => p.w === width && p.h === height)
      setActivePreset(match ? match.label : 'Custom')
    })
  }, [])

  // Close menu on outside click
  useEffect(() => {
    if (!showSizeMenu) return
    const onClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowSizeMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showSizeMenu])

  const togglePin = useCallback(async () => {
    const newVal = await window.api.togglePin()
    setPinned(newVal)
  }, [])

  const applyPreset = useCallback(async (label: string, w: number, h: number) => {
    await window.api.resizePopout(w, h, true)
    setActivePreset(label)
    setShowSizeMenu(false)
  }, [])

  const saveCurrentSize = useCallback(async () => {
    // Save whatever the current window size is as custom
    const [width, height] = await new Promise<[number, number]>((resolve) => {
      // Get current bounds from the window itself
      const w = window.outerWidth
      const h = window.outerHeight
      resolve([w, h])
    })
    await window.api.resizePopout(width, height, true)
    setActivePreset('Custom')
    setShowSizeMenu(false)
  }, [])

  return (
    <div className="h-full flex flex-col bg-surface-950">
      {/* Title bar */}
      <div className="drag-region h-8 flex items-center justify-between bg-surface-950/90 border-b border-white/5 px-3 shrink-0">
        <div className="flex items-center gap-2 no-drag">
          <div className="w-1.5 h-1.5 rounded-full bg-accent-500" />
          <span className="text-[10px] font-semibold tracking-widest uppercase text-surface-400">
            molex<span className="text-accent-400">Media</span>
          </span>
        </div>
        <div className="flex items-center gap-0.5 no-drag">
          {/* Size preset button */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowSizeMenu(v => !v)}
              className={`h-5 px-1.5 flex items-center gap-1 rounded text-[9px] font-medium transition-colors ${
                showSizeMenu ? 'text-accent-400 bg-accent-600/20' : 'text-surface-500 hover:bg-surface-700/50'
              }`}
              title="Window size"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18M3 9h18" />
              </svg>
              <span>{activePreset || 'Size'}</span>
            </button>
            {showSizeMenu && (
              <div className="absolute right-0 top-6 z-50 w-36 py-1 rounded-lg bg-surface-800 border border-surface-600 shadow-xl">
                {SIZE_PRESETS.map(({ label, w, h }) => (
                  <button
                    key={label}
                    onClick={() => applyPreset(label, w, h)}
                    className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center justify-between transition-colors ${
                      activePreset === label
                        ? 'text-accent-300 bg-accent-600/15'
                        : 'text-surface-300 hover:bg-surface-700/50'
                    }`}
                  >
                    <span>{label}</span>
                    <span className="text-surface-500 text-[9px]">{w}×{h}</span>
                  </button>
                ))}
                <div className="border-t border-white/5 mt-1 pt-1">
                  <button
                    onClick={saveCurrentSize}
                    className={`w-full px-3 py-1.5 text-left text-[11px] flex items-center justify-between transition-colors ${
                      activePreset === 'Custom'
                        ? 'text-accent-300 bg-accent-600/15'
                        : 'text-surface-300 hover:bg-surface-700/50'
                    }`}
                  >
                    <span>Save Current</span>
                    <span className="text-surface-500 text-[9px]">Custom</span>
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Pin */}
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
          {/* Minimize */}
          <button onClick={() => window.api.windowMinimize?.()} className="w-7 h-5 flex items-center justify-center rounded hover:bg-surface-700/50 transition-colors">
            <svg width="8" height="1" viewBox="0 0 10 1" fill="currentColor" className="text-surface-400"><rect width="10" height="1" /></svg>
          </button>
          {/* Close */}
          <button onClick={() => window.api.windowClose?.()} className="w-7 h-5 flex items-center justify-center rounded hover:bg-red-500/80 transition-colors group">
            <svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" className="text-surface-400 group-hover:text-white" strokeWidth="1.3">
              <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
            </svg>
          </button>
        </div>
      </div>
      {/* Player */}
      <main className="flex-1 overflow-hidden px-2 pt-1.5 pb-2">
        <MediaPlayer popout />
      </main>
    </div>
  )
}
