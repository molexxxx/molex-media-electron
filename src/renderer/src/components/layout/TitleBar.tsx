/**
 * @module components/layout/TitleBar
 * @description Custom Electron window title bar.
 *
 * Renders the walnut drag-region header with the wordmark, version, a status lamp with its word while
 * processing, and Windows-style caption buttons (minimize / maximize / close) that call into the Electron
 * main process.
 */

import React from 'react'
import { useAppStore } from '../../stores/appStore'

const CAPTION_BUTTON = 'w-11.5 h-10 flex items-center justify-center text-ink-2 hover:bg-wash-hover hover:text-ink active:bg-wash-pressed'

export default function TitleBar(): React.JSX.Element {
  const { isProcessing, isPaused } = useAppStore()
  const status = isProcessing ? (isPaused ? 'Paused' : 'Processing') : null
  const lamp = isProcessing
    ? isPaused
      ? 'bg-ink-3'
      : 'bg-amber shadow-[0_0_6px_var(--color-amber)]'
    : 'bg-walnut-500'

  return (
    <div className="drag-region h-10 flex items-center justify-between bg-rail border-b border-rail-edge ps-4 shrink-0">
      <div className="flex items-center gap-2.5">
        <div aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${lamp}`} />
        <span className="text-label font-semibold text-ink">
          molex<span className="text-walnut-ink">Media</span>
        </span>
        <span className="text-label text-ink-3 tabular-nums">{__APP_VERSION__}</span>
        {status && (
          <span className={`text-label ${isPaused ? 'text-ink-3' : 'text-amber'}`}>{status}</span>
        )}
      </div>

      <div className="flex items-stretch self-stretch no-drag">
        <button
          onClick={() => window.api.windowMinimize?.()}
          aria-label="Minimize"
          className={CAPTION_BUTTON}
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={() => window.api.windowMaximize?.()}
          aria-label="Maximize"
          className={CAPTION_BUTTON}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
          </svg>
        </button>
        <button
          onClick={() => window.api.windowClose?.()}
          aria-label="Close"
          className="w-11.5 h-10 flex items-center justify-center text-ink-2 hover:bg-error-fill hover:text-ink active:bg-danger-pressed"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
