/** @module editor/MediaEditor - Top-level NLE editor shell with mode tabs. */
import React, { useState, useEffect, useRef } from 'react'
import { useEditorStore } from '../../stores/editorStore'
import type { EditorMode } from './types'
import { ClipEditor } from './clip/ClipEditor'
import { EditEditor } from './edit/EditEditor'
import { InspectEditor } from './inspect/InspectEditor'

/* Clip - trim/cut icon (bracket markers for in/out points) */
const ClipIcon = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v18" />
    <path d="M18 3v18" />
    <path d="M6 8h12" />
    <path d="M6 16h12" />
    <path d="M2 3h4" />
    <path d="M2 21h4" />
    <path d="M18 3h4" />
    <path d="M18 21h4" />
  </svg>
)

/* Timeline - multi-track timeline icon (stacked horizontal bars) */
const TimelineIcon = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3" width="15" height="4" rx="1" />
    <rect x="6" y="10" width="17" height="4" rx="1" />
    <rect x="3" y="17" width="12" height="4" rx="1" />
  </svg>
)

/* Inspect - search / magnify icon */
const InspectIcon = (): React.JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const MODE_TABS: { id: EditorMode; label: string; icon: React.FC; tooltip: string }[] = [
  { id: 'clip', label: 'Trim', icon: ClipIcon, tooltip: 'Quick trim & export' },
  { id: 'edit', label: 'Timeline', icon: TimelineIcon, tooltip: 'Multi-track NLE timeline' },
  { id: 'inspect', label: 'Inspect', icon: InspectIcon, tooltip: 'Media metadata & streams' }
]

export default function MediaEditor(): React.JSX.Element {
  const mode = useEditorStore((s) => s.mode)
  const setMode = useEditorStore((s) => s.setMode)
  const [mounted, setMounted] = useState<Set<EditorMode>>(new Set([mode]))
  const [animating, setAnimating] = useState(false)
  const prevMode = useRef(mode)

  // Lazy-mount modes on first visit, keep them alive after that
  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(mode)) return prev
      return new Set([...prev, mode])
    })
  }, [mode])

  // Smooth mode transition
  useEffect(() => {
    if (prevMode.current !== mode) {
      setAnimating(true)
      prevMode.current = mode
      const timer = setTimeout(() => setAnimating(false), 200)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [mode])

  return (
    <div className="flex flex-col h-full">
      {/* Mode tab bar - responsive: icons-only on small screens */}
      <div className="flex items-center px-2 sm:px-3 py-1 sm:py-1.5 border-b border-white/5">
        <div className="flex gap-0.5">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setMode(tab.id)}
              title={tab.tooltip}
              className={`flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-lg text-xs font-medium transition-all duration-150
                touch:min-h-[44px] touch:min-w-[44px] touch:justify-center
                ${
                  mode === tab.id
                    ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm shadow-accent-500/10'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'
                }`}
            >
              <tab.icon />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Mode content - kept alive once mounted, toggled via display */}
      <div
        className={`flex-1 overflow-hidden transition-opacity duration-200 ${
          animating ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {mounted.has('clip') && (
          <div className="h-full" style={{ display: mode === 'clip' ? 'block' : 'none' }}>
            <ClipEditor />
          </div>
        )}
        {mounted.has('edit') && (
          <div className="h-full flex flex-col" style={{ display: mode === 'edit' ? 'flex' : 'none' }}>
            <EditEditor />
          </div>
        )}
        {mounted.has('inspect') && (
          <div className="h-full" style={{ display: mode === 'inspect' ? 'block' : 'none' }}>
            <InspectEditor />
          </div>
        )}
      </div>
    </div>
  )
}
