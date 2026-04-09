/**
 * @module editor/edit/Toolbar
 * Edit mode toolbar: tool selection, edit type buttons, snap toggle, zoom controls.
 * Touch-friendly with tooltips and responsive layout.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { EditTool } from '../types'
import { ShortcutsModal } from './ShortcutsModal'

const TOOLS: { id: EditTool; label: string; shortcut: string; icon: string; tooltip: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'V', icon: '↖', tooltip: 'Select & move clips (V)' },
  { id: 'trim', label: 'Trim', shortcut: 'T', icon: '⌇', tooltip: 'Trim clip edges (T)' },
  { id: 'razor', label: 'Razor', shortcut: 'B', icon: '✂', tooltip: 'Split clips at cursor (B)' }
]

interface ToolbarProps {
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToView: () => void
}

export function Toolbar({ onZoomIn, onZoomOut, onFitToView }: ToolbarProps): React.JSX.Element {
  const activeTool = useEditorStore((s) => s.activeTool)
  const setActiveTool = useEditorStore((s) => s.setActiveTool)
  const snapEnabled = useEditorStore((s) => s.snapEnabled)
  const setSnapEnabled = useEditorStore((s) => s.setSnapEnabled)
  const zoom = useEditorStore((s) => s.zoom)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Global ? key to toggle shortcuts modal
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === '?' && useEditorStore.getState().mode === 'edit') {
        e.preventDefault()
        setShortcutsOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const selectedSourceId = useEditorStore((s) => s.selectedSourceId)

  const doEdit = useCallback(
    (type: 'insert' | 'overwrite' | 'append' | 'placeOnTop') => {
      const state = useEditorStore.getState()
      const sourceId = state.selectedSourceId || state.clipMode.sourceId
      if (!sourceId) return
      const source = state.sources.find((s) => s.id === sourceId)
      if (!source) return

      // Use clip mode in/out if the source matches, otherwise full source
      const inOut: [number, number] =
        state.clipMode.sourceId === sourceId
          ? [state.clipMode.inPoint, state.clipMode.outPoint]
          : [0, source.duration]

      const trackId =
        state.selectedTrackId || state.timeline.tracks.find((t) => t.type === 'video')?.id
      if (!trackId && type !== 'placeOnTop') return

      switch (type) {
        case 'insert':
          state.insertClip(sourceId, inOut, state.playback.currentFrame, trackId!)
          break
        case 'overwrite':
          state.overwriteClip(sourceId, inOut, state.playback.currentFrame, trackId!)
          break
        case 'append':
          state.appendClip(sourceId, inOut, trackId!)
          break
        case 'placeOnTop':
          state.placeOnTop(sourceId, inOut, state.playback.currentFrame)
          break
      }
    },
    []
  )

  const hasSource = !!(selectedSourceId || useEditorStore.getState().clipMode.sourceId)

  return (
    <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 border-b border-white/5 bg-surface-900/60 overflow-x-auto">
      {/* Tools */}
      <div className="flex gap-0.5">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`px-2 py-1.5 text-[11px] rounded transition-all min-h-[32px] min-w-[32px] flex items-center justify-center gap-1 ${
              activeTool === tool.id
                ? 'bg-accent-500/20 text-accent-200 font-medium'
                : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04]'
            }`}
            title={tool.tooltip}
          >
            <span>{tool.icon}</span>
            <span className="hidden sm:inline">{tool.label}</span>
          </button>
        ))}
      </div>

      <div className="w-px h-4 bg-white/10 flex-shrink-0" />

      {/* Edit operations - hidden on very small screens */}
      <div className="hidden sm:flex gap-0.5">
        {[
          { type: 'insert' as const, label: 'Insert', tooltip: 'Insert edit - push right (,)' },
          { type: 'overwrite' as const, label: 'Overwrite', tooltip: 'Overwrite edit - replace (.)' },
          { type: 'append' as const, label: 'Append', tooltip: 'Append to end of timeline' },
          { type: 'placeOnTop' as const, label: 'On Top', tooltip: 'Place on next track above' }
        ].map((op) => (
          <button
            key={op.type}
            onClick={() => doEdit(op.type)}
            disabled={!hasSource}
            className="px-1.5 py-1 text-[10px] rounded text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] disabled:opacity-30 disabled:pointer-events-none transition-all min-h-[28px]"
            title={op.tooltip}
          >
            {op.label}
          </button>
        ))}
      </div>

      <div className="w-px h-4 bg-white/10 flex-shrink-0 hidden sm:block" />

      {/* Snap */}
      <button
        onClick={() => setSnapEnabled(!snapEnabled)}
        className={`px-2 py-1.5 text-[11px] rounded transition-all min-h-[32px] ${
          snapEnabled
            ? 'bg-blue-500/20 text-blue-300 font-medium'
            : 'text-surface-500 hover:text-surface-300'
        }`}
        title={`Toggle snapping (N) - ${snapEnabled ? 'ON' : 'OFF'}`}
      >
        <span className="hidden sm:inline">Snap </span>
        {snapEnabled ? '✓' : '✗'}
      </button>

      <div className="w-px h-4 bg-white/10 flex-shrink-0" />

      {/* Zoom controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onZoomOut}
          className="text-surface-400 hover:text-surface-200 text-[11px] px-1.5 min-h-[28px] min-w-[28px] flex items-center justify-center"
          title="Zoom out (Ctrl+-)"
        >
          −
        </button>
        <span className="text-[10px] text-surface-500 min-w-[36px] text-center tabular-nums hidden sm:inline">
          {Math.round(zoom)}px/s
        </span>
        <button
          onClick={onZoomIn}
          className="text-surface-400 hover:text-surface-200 text-[11px] px-1.5 min-h-[28px] min-w-[28px] flex items-center justify-center"
          title="Zoom in (Ctrl+=)"
        >
          +
        </button>
        <button
          onClick={onFitToView}
          className="text-surface-400 hover:text-surface-200 text-[11px] px-1.5 min-h-[28px]"
          title="Fit timeline to view (Ctrl+0)"
        >
          Fit
        </button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Shortcut hints */}
      <div className="hidden lg:flex items-center gap-3 text-[10px] text-surface-500/70 mr-1 select-none">
        {[
          { keys: ['Shift', 'Scroll'], action: 'pan' },
          { keys: ['Ctrl', 'Scroll'], action: 'zoom' },
          { keys: ['S'], action: 'split' },
          { keys: ['Space'], action: 'play' }
        ].map(({ keys, action }) => (
          <span key={action} className="flex items-center gap-1">
            {keys.map((k) => (
              <kbd
                key={k}
                className="inline-flex items-center justify-center px-1 py-px rounded text-[9px] font-mono leading-tight bg-white/[0.05] border border-white/[0.08] text-surface-400 min-w-[16px] text-center"
              >
                {k}
              </kbd>
            ))}
            <span className="text-surface-600">{action}</span>
          </span>
        ))}
      </div>

      {/* Shortcuts modal button */}
      <button
        onClick={() => setShortcutsOpen(true)}
        className="text-surface-500 hover:text-surface-300 hover:bg-white/[0.06] p-1 rounded transition-all flex items-center justify-center"
        title="Keyboard shortcuts (?)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="4" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="3.5" y="6.5" width="2" height="1.5" rx="0.3" fill="currentColor" opacity="0.5" />
          <rect x="7" y="6.5" width="2" height="1.5" rx="0.3" fill="currentColor" opacity="0.5" />
          <rect x="10.5" y="6.5" width="2" height="1.5" rx="0.3" fill="currentColor" opacity="0.5" />
          <rect x="5" y="9.5" width="6" height="1.5" rx="0.3" fill="currentColor" opacity="0.5" />
        </svg>
      </button>

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  )
}
