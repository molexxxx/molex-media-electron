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
import { useAppStore, LogEntry } from '../../stores/appStore'

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
  const scrollRef = useRef<HTMLDivElement>(null)

  const filteredLogs = logs.filter((log) => {
    if (filter !== 'all' && log.level !== filter) return false
    if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredLogs.length, autoScroll])

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
    <div className="space-y-4 animate-fade-in h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Logs</h1>
          <p className="text-sm text-surface-400 mt-0.5">{logs.length} entries · {filteredLogs.length} visible</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenLogDir}
            className="px-3 py-1.5 text-sm font-medium text-surface-300 hover:text-white bg-surface-700/50 hover:bg-surface-600/50 rounded-lg transition-all"
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
      <div className="flex items-center gap-3">
        <div className="flex bg-surface-800 rounded-lg p-0.5 gap-0.5">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 text-2xs font-medium rounded-md transition-all ${
                filter === f.id
                  ? 'bg-accent-600 text-white'
                  : 'text-surface-400 hover:text-surface-200'
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

        <div className="flex-1 relative">
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
            className="w-full bg-surface-800 border border-surface-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-surface-600 focus:outline-none focus:border-accent-500 transition-colors"
          />
        </div>

        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`px-2.5 py-1.5 text-2xs font-medium rounded-lg transition-all ${
            autoScroll ? 'bg-accent-600/20 text-accent-300' : 'text-surface-500 hover:text-surface-300 bg-surface-800'
          }`}
        >
          Auto-scroll {autoScroll ? 'ON' : 'OFF'}
        </button>
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
          filteredLogs.map((log, i) => <LogLine key={i} entry={log} />)
        )}
      </div>
    </div>
  )
}

function LogLine({ entry }: { entry: LogEntry }): React.JSX.Element {
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info
  const time = entry.timestamp.split(' ')[1]?.substring(0, 8) || entry.timestamp.substring(11, 19)

  return (
    <div className="flex items-start gap-2 px-2 py-0.5 hover:bg-surface-800/30 rounded transition-colors group leading-relaxed">
      <span className="text-surface-600 shrink-0 w-16">{time}</span>
      <span className={`shrink-0 w-7 text-center font-bold ${style.color}`}>{style.label}</span>
      <span className="text-surface-300 break-all flex-1">{entry.message}</span>
    </div>
  )
}
