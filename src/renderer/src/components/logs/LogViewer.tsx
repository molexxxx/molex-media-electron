/**
 * @module components/logs/LogViewer
 * @description Filterable, searchable log viewer with auto-scroll.
 *
 * Displays application log entries with level-based colour coding
 * (info, warn, error, success, ffmpeg). Supports free-text search,
 * level filter tabs, auto-scroll with scroll-position detection,
 * and actions to open the log directory or clear the log buffer.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore, type LogEntry } from '../../stores/appStore'

const LEVEL_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  info: { color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'INF' },
  warn: { color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'WRN' },
  error: { color: 'text-red-400', bg: 'bg-red-500/10', label: 'ERR' },
  success: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'OK' },
  debug: { color: 'text-surface-500', bg: 'bg-surface-700/30', label: 'DBG' },
  ffmpeg: { color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'FF' }
}

type Filter = 'all' | 'info' | 'warn' | 'error' | 'success' | 'ffmpeg'

export default function LogViewer(): React.JSX.Element {
  const { logs, clearLogs } = useAppStore()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState<'all' | number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredLogs = logs.filter((log) => {
    if (filter !== 'all' && log.level !== filter) return false
    if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      // Defer to next frame so DOM has rendered the new entries
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [logs.length, autoScroll])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }, [])

  const handleOpenLogDir = () => {
    window.api.openLogDir()
  }

  const handleClear = () => {
    clearLogs()
    window.api.clearLogs()
  }

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: logs.length },
    { id: 'info', label: 'Info', count: logs.filter((l) => l.level === 'info').length },
    { id: 'warn', label: 'Warn', count: logs.filter((l) => l.level === 'warn').length },
    { id: 'error', label: 'Error', count: logs.filter((l) => l.level === 'error').length },
    { id: 'success', label: 'Success', count: logs.filter((l) => l.level === 'success').length },
    { id: 'ffmpeg', label: 'FFmpeg', count: logs.filter((l) => l.level === 'ffmpeg').length }
  ]

  return (
    <div className="h-full flex flex-col gap-4 animate-fade-in overflow-hidden">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-xl font-medium text-surface-200 tracking-tight">Logs</h1>
          <p className="text-xs text-surface-400 mt-0.5">{logs.length} entries · {filteredLogs.length} visible</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const text = filteredLogs
                .map((l) => {
                  const time = l.timestamp.split(' ')[1]?.substring(0, 8) || l.timestamp.substring(11, 19)
                  const label = (LEVEL_STYLES[l.level] || LEVEL_STYLES.info).label
                  return `${time}  ${label}  ${l.message}`
                })
                .join('\n')
              navigator.clipboard.writeText(text)
              setCopied('all')
              setTimeout(() => setCopied(null), 1500)
            }}
            className="px-3 py-1.5 text-sm font-medium text-surface-300 hover:text-white bg-surface-900/80 hover:bg-surface-800/80 border border-white/[0.06] hover:border-white/[0.12] rounded-lg transition-all"
          >
            {copied === 'all' ? 'Copied!' : `Copy ${filter !== 'all' ? 'Filtered' : 'All'}`}
          </button>
          <button
            onClick={handleOpenLogDir}
            className="px-3 py-1.5 text-sm font-medium text-surface-300 hover:text-white bg-surface-900/80 hover:bg-surface-800/80 border border-white/[0.06] hover:border-white/[0.12] rounded-lg transition-all"
          >
            Open Log Dir
          </button>
          <button
            onClick={handleClear}
            className="px-3 py-1.5 text-sm font-medium text-red-400/70 hover:text-red-400 rounded-lg transition-all"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
        <div className="flex bg-white/[0.03] border border-white/[0.06] rounded-xl p-1 gap-1 shrink-0 overflow-x-auto">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all whitespace-nowrap ${
                filter === f.id
                  ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              {f.label}
              {f.count > 0 && (
                <span className={`ml-1 ${filter === f.id ? 'text-white/70' : 'text-surface-500'}`}>
                  {f.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex-1 relative min-w-0">
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-500"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs..."
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg pl-8 pr-3 py-1.5 text-sm text-surface-200 placeholder-surface-600 focus:outline-none focus:border-accent-500/50 hover:border-white/[0.12] transition-colors"
            />
          </div>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`shrink-0 px-2.5 py-1.5 text-2xs font-medium rounded-lg transition-all whitespace-nowrap border ${
              autoScroll
                ? 'bg-accent-500/20 text-accent-200 border-accent-500/25'
                : 'text-surface-500 hover:text-surface-300 bg-surface-900/80 border-white/[0.06] hover:border-white/[0.12]'
            }`}
          >
            Auto-scroll {autoScroll ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto font-mono text-xs bg-surface-950/50 rounded-xl border border-white/[0.03] p-1"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-surface-600">
            {logs.length === 0 ? 'No log entries yet' : 'No entries match filter'}
          </div>
        ) : (
          filteredLogs.map((log, i) => (
            <LogLine
              key={i}
              entry={log}
              copied={copied === i}
              onCopy={() => {
                const time = log.timestamp.split(' ')[1]?.substring(0, 8) || log.timestamp.substring(11, 19)
                const label = (LEVEL_STYLES[log.level] || LEVEL_STYLES.info).label
                navigator.clipboard.writeText(`${time}  ${label}  ${log.message}`)
                setCopied(i)
                setTimeout(() => setCopied(null), 1500)
              }}
            />
          ))
        )}
      </div>
    </div>
  )
}

function LogLine({ entry, copied, onCopy }: { entry: LogEntry; copied: boolean; onCopy: () => void }): React.JSX.Element {
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info
  const time = entry.timestamp.split(' ')[1]?.substring(0, 8) || entry.timestamp.substring(11, 19)

  return (
    <div className="flex items-start gap-2 px-2 py-0.5 hover:bg-surface-800/30 rounded transition-colors group leading-relaxed">
      <span className="text-surface-600 shrink-0 w-16">{time}</span>
      <span className={`shrink-0 w-7 text-center font-bold ${style.color}`}>{style.label}</span>
      <span className="text-surface-300 break-all flex-1 select-text">{entry.message}</span>
      <button
        onClick={onCopy}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-surface-500 hover:text-surface-300 p-0.5"
        title="Copy line"
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
    </div>
  )
}
