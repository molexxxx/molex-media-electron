/**
 * @module components/player/components/UrlInputBar
 * @description URL input with resolve button and collapsible history list.
 */

import React from 'react'

interface UrlHistoryEntry {
  url: string
  title: string
  trackCount: number
  addedAt: number
}

interface UrlInputBarProps {
  urlInput: string
  resolving: boolean
  showHistory: boolean
  urlHistory: UrlHistoryEntry[]
  onUrlChange: (value: string) => void
  onAddUrl: () => void
  onToggleHistory: () => void
  onLoadHistory: () => void
  onLoadFromHistory: (url: string) => void
  onRemoveFromHistory: (url: string) => void
}

export function UrlInputBar({
  urlInput, resolving, showHistory, urlHistory,
  onUrlChange, onAddUrl, onToggleHistory, onLoadHistory,
  onLoadFromHistory, onRemoveFromHistory
}: UrlInputBarProps): React.JSX.Element {
  return (
    <div className="shrink-0 space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={urlInput}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAddUrl()}
          placeholder="Paste YouTube playlist, video URL, or direct audio link..."
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface-800 border border-surface-600 text-white placeholder-surface-500 focus:border-accent-500 focus:outline-none transition-colors"
          autoFocus
        />
        <button
          onClick={() => { onToggleHistory(); if (!showHistory) onLoadHistory() }}
          className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
            showHistory ? 'bg-accent-600/20 border-accent-500 text-accent-300' : 'bg-surface-800 border-surface-600 text-surface-300 hover:text-white hover:border-accent-500'
          }`}
          title="URL History"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline -mt-0.5">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
        <button
          onClick={onAddUrl}
          disabled={resolving}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-accent-500/15 hover:bg-accent-500/25 disabled:opacity-50 text-accent-300 border border-accent-500/20 hover:border-accent-500/30 transition-colors"
        >
          {resolving ? 'Resolving...' : 'Add'}
        </button>
      </div>
      {showHistory && urlHistory.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg bg-surface-800 border border-surface-600 scrollbar-thin">
          {urlHistory.map((h) => (
            <div
              key={h.url}
              className="group flex items-center gap-2 px-3 py-2 hover:bg-surface-700/50 cursor-pointer transition-colors"
              onClick={() => onLoadFromHistory(h.url)}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs text-surface-200 truncate">{h.title}</p>
                <p className="text-2xs text-surface-500 truncate">{h.trackCount} track{h.trackCount !== 1 ? 's' : ''} · {new Date(h.addedAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onRemoveFromHistory(h.url) }}
                className="opacity-0 group-hover:opacity-100 text-surface-500 hover:text-red-400 transition-all shrink-0"
                title="Remove from history"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {showHistory && urlHistory.length === 0 && (
        <div className="px-3 py-4 text-center text-xs text-surface-500 rounded-lg bg-surface-800 border border-surface-600">
          No history yet — resolved playlists will appear here
        </div>
      )}
    </div>
  )
}
