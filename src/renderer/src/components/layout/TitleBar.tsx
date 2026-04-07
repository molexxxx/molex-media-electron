/**
 * @module components/layout/TitleBar
 * @description Custom Electron window title bar.
 *
 * Renders the drag-region header with the app logo, version badge,
 * a processing-status indicator dot, and frameless window controls
 * (minimize / maximize / close) that call into the Electron main process.
 */

import React from 'react'
import { useAppStore } from '../../stores/appStore'

export default function TitleBar(): React.JSX.Element {
  const { isProcessing } = useAppStore()

  return (
    <div className="drag-region h-10 flex items-center justify-between bg-surface-950/80 border-b border-white/5 px-4 shrink-0">
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-amber-400 pulse-ring' : 'bg-accent-500'}`} />
        <span className="text-xs font-semibold tracking-widest uppercase text-surface-300">
          molex<span className="text-accent-400">Media</span>
        </span>
        <span className="text-2xs text-surface-500 font-mono">v{__APP_VERSION__}</span>
      </div>

      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={() => window.api.windowMinimize?.()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-surface-700/50 transition-colors"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor" className="text-surface-400">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={() => window.api.windowMaximize?.()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-surface-700/50 transition-colors"
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" className="text-surface-400" strokeWidth="1.2">
            <rect x="0.5" y="0.5" width="8" height="8" rx="1" />
          </svg>
        </button>
        <button
          onClick={() => window.api.windowClose?.()}
          className="w-8 h-6 flex items-center justify-center rounded hover:bg-red-500/80 transition-colors group"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" className="text-surface-400 group-hover:text-white" strokeWidth="1.3">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  )
}
