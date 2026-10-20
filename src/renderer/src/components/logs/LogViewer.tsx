/**
 * @module components/logs/LogViewer
 * @description Filterable, searchable log viewer with auto-scroll.
 *
 * Displays application log entries with level-based color coding
 * (info, warn, error, success, ffmpeg). Supports free-text search,
 * level filter tabs, auto-scroll with scroll-position detection,
 * and actions to open the log directory or clear the log buffer.
 * "Show log" narrows the view to one job or batch, read from main's
 * buffer, and a job's complete FFmpeg output opens beside its lines.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useAppStore, type LogEntry, type LogFilter } from '../../stores/appStore'
import { Button, CapsText, IconButton } from '../../ui'
import { formatRunLabel, type JobId, type RunId } from '../../../../shared/jobs/ids'
import type { CommandResult, JobCommandResponse } from '../../../../shared/jobs/contract'

/** The words of the job and batch filter and the full output panel. */
export const LOG_FILTER_WORDS = {
  filteredTo: 'Filtered to',
  clear: 'Show all entries',
  fullOutput: 'Full FFmpeg output',
  showOutput: 'Show output',
  hideOutput: 'Hide output',
  reading: 'Reading the output',
  emptyOutput: 'FFmpeg printed nothing for this job.',
  unavailable: 'The full output cannot be read in this window.',
  failed: 'The full output could not be read.',
  truncated: 'This is the end of the output; the log file holds all of it.',
  tryAgain: 'Try again',
  copy: 'Copy output',
  copied: 'Copied',
  showFile: 'Show in folder'
} as const

/** A job's complete FFmpeg output as `jobs:log` returns it. */
export type JobLogResult = JobCommandResponse<'log'>

/** What the Logs view calls in main. */
export interface LogViewerApi {
  /** Buffered entries; the query narrows them in main. */
  getLogBuffer: (query?: { afterId?: number } & Partial<{ jobId: string; runId: string }>) => Promise<LogEntry[]>
  clearLogs: () => Promise<void>
  openLogDir: () => Promise<void>
  showInFolder: (filePath: string) => Promise<void>
  /** `jobs:log`; absent until the window exposes the jobs API. */
  jobLog?: (req: { jobId: JobId; attempt: number | null }) => Promise<CommandResult<JobLogResult>>
}

interface WindowLogApi {
  getLogBuffer: LogViewerApi['getLogBuffer']
  clearLogs: LogViewerApi['clearLogs']
  openLogDir: LogViewerApi['openLogDir']
  showInFolder: LogViewerApi['showInFolder']
  jobs?: { log?: LogViewerApi['jobLog'] }
}

/** The Logs view's calls through the preload bridge. */
export function windowLogApi(): LogViewerApi {
  const api = window.api as unknown as WindowLogApi
  const jobLog = api.jobs?.log
  return {
    getLogBuffer: (query) => api.getLogBuffer(query),
    clearLogs: () => api.clearLogs(),
    openLogDir: () => api.openLogDir(),
    showInFolder: (filePath) => api.showInFolder(filePath),
    jobLog: jobLog ? (req) => jobLog(req) : undefined
  }
}

/** The chip text of a filter: the catalog number for a job, the batch label for a run. */
export function logFilterLabel(filter: LogFilter): string {
  return 'jobId' in filter ? filter.jobId : formatRunLabel(filter.runId as RunId)
}

/** Whether an entry belongs to the job or run a filter names; every entry matches no filter. */
export function matchesLogFilter(entry: LogEntry, filter: LogFilter | null): boolean {
  if (filter === null) return true
  return 'jobId' in filter ? entry.jobId === filter.jobId : entry.runId === filter.runId
}

/**
 * The entries a filtered view shows: what main returned for the filter, then the live entries that arrived after its
 * newest line. Without a fetched list, the live entries that match.
 */
export function mergeLogEntries(fetched: readonly LogEntry[] | null, live: readonly LogEntry[], filter: LogFilter | null): LogEntry[] {
  const matching = live.filter((entry) => matchesLogFilter(entry, filter))
  if (fetched === null) return matching
  let lastId = 0
  for (const entry of fetched) {
    if (entry.id !== undefined && entry.id > lastId) lastId = entry.id
  }
  return [...fetched, ...matching.filter((entry) => entry.id !== undefined && entry.id > lastId)]
}

/** The level tab and search narrowing, applied after the job or run filter. */
export function visibleLogEntries(entries: readonly LogEntry[], level: Filter, search: string): LogEntry[] {
  const needle = search.toLowerCase()
  return entries.filter((log) => {
    if (level !== 'all' && log.level !== level) return false
    if (needle && !log.message.toLowerCase().includes(needle)) return false
    return true
  })
}

const LEVEL_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  info: { color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'INF' },
  warn: { color: 'text-amber-400', bg: 'bg-amber-500/10', label: 'WRN' },
  error: { color: 'text-red-400', bg: 'bg-red-500/10', label: 'ERR' },
  success: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'OK' },
  debug: { color: 'text-surface-500', bg: 'bg-surface-700/30', label: 'DBG' },
  ffmpeg: { color: 'text-purple-400', bg: 'bg-purple-500/10', label: 'FF' }
}

type Filter = 'all' | 'info' | 'warn' | 'error' | 'success' | 'ffmpeg'

/** Props for {@link LogViewer}. */
export interface LogViewerProps {
  /** The calls into main; the preload bridge by default. */
  api?: LogViewerApi
}

export default function LogViewer({ api: apiProp }: LogViewerProps = {}): React.JSX.Element {
  const { logs: liveLogs, clearLogs, logFilter, clearLogFilter } = useAppStore()
  const [api] = useState<LogViewerApi>(() => apiProp ?? windowLogApi())
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState<'all' | number | null>(null)
  const [fetched, setFetched] = useState<LogEntry[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFetched(null)
    if (logFilter === null) return
    let disposed = false
    api.getLogBuffer(logFilter).then(
      (entries) => {
        if (!disposed) setFetched(entries.filter((entry) => matchesLogFilter(entry, logFilter)))
      },
      () => { /* the live entries still show */ }
    )
    return () => {
      disposed = true
    }
  }, [api, logFilter])

  const logs = mergeLogEntries(fetched, liveLogs, logFilter)
  const filteredLogs = visibleLogEntries(logs, filter, search)
  const filterLabel = logFilter === null ? null : logFilterLabel(logFilter)

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

  const handleClearFilter = () => {
    clearLogFilter()
    searchRef.current?.focus()
  }

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }, [])

  const handleOpenLogDir = () => {
    void api.openLogDir()
  }

  const handleClear = () => {
    clearLogs()
    setFetched((current) => (current === null ? null : []))
    void api.clearLogs()
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
          <p className="text-xs text-surface-400 mt-0.5 tabular-nums">{logs.length} entries · {filteredLogs.length} visible</p>
          {filterLabel !== null && (
            <div data-part="log-filter" className="mt-2 inline-flex items-center gap-1 rounded-sm border border-line-strong bg-raised pl-2 text-label text-ink-2">
              <span>
                {LOG_FILTER_WORDS.filteredTo} <span className="text-ink tabular-nums">{filterLabel}</span>
              </span>
              <IconButton icon="action.close" label={LOG_FILTER_WORDS.clear} size="sm" variant="ghost" onClick={handleClearFilter} />
            </div>
          )}
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
            className="px-3 py-1.5 text-sm font-medium text-red-400 hover:bg-wash-hover rounded-lg transition-all"
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
                <span className={`ml-1 ${filter === f.id ? 'text-white' : 'text-surface-500'}`}>
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
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs..."
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg pl-8 pr-3 py-1.5 text-sm text-surface-200 placeholder-surface-600 focus:border-accent-500/50 hover:border-white/[0.12] transition-colors"
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

      {logFilter !== null && 'jobId' in logFilter && (
        <FullOutputPanel key={logFilter.jobId} jobId={logFilter.jobId as JobId} api={api} />
      )}

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto font-mono text-xs bg-surface-950/50 rounded-xl border border-white/[0.03] p-1"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-surface-600">
            {logs.length > 0 ? 'No entries match filter' : filterLabel !== null ? `No entries for ${filterLabel} yet` : 'No log entries yet'}
          </div>
        ) : (
          filteredLogs.map((log, i) => (
            <LogLine
              key={log.id ?? `local-${i}`}
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
      <span className="text-surface-300 break-all whitespace-pre-wrap flex-1 select-text">{entry.message}</span>
      <button
        onClick={onCopy}
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-surface-500 hover:text-surface-300 p-0.5"
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

type FullOutputState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean; file: string | null }
  | { status: 'error'; message: string }

/** A job's complete FFmpeg output from `jobs:log`, read when the panel first opens. */
export function FullOutputPanel({ jobId, api }: { jobId: JobId; api: LogViewerApi }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<FullOutputState>({ status: 'idle' })
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const headingId = `${useId()}-heading`
  const bodyId = `${headingId}-body`

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = async (): Promise<void> => {
    if (!api.jobLog) {
      setState({ status: 'error', message: LOG_FILTER_WORDS.unavailable })
      return
    }
    setState({ status: 'loading' })
    let result: CommandResult<JobLogResult>
    try {
      result = await api.jobLog({ jobId, attempt: null })
    } catch {
      result = { ok: false, error: { code: 'internal', message: LOG_FILTER_WORDS.failed, issues: [], details: null } }
    }
    if (!alive.current) return
    if (result.ok) {
      setState({ status: 'ready', text: result.value.lines.join('\n'), truncated: result.value.truncated, file: result.value.file })
    } else {
      setState({ status: 'error', message: result.error.message || LOG_FILTER_WORDS.failed })
    }
  }

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && (state.status === 'idle' || state.status === 'error')) void load()
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => {
      if (alive.current) setCopied(false)
    }, 1500)
  }

  return (
    <div data-part="full-output" className="flex shrink-0 flex-col items-start gap-2">
      <div className="flex items-center gap-3">
        <h2 id={headingId} className="type-legend text-brass">
          <CapsText>{LOG_FILTER_WORDS.fullOutput}</CapsText>
        </h2>
        <Button
          variant="secondary"
          size="sm"
          icon={open ? 'action.collapse' : 'action.expand'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          {open ? LOG_FILTER_WORDS.hideOutput : LOG_FILTER_WORDS.showOutput}
        </Button>
      </div>
      {open && (
        <div id={bodyId} className="flex w-full flex-col items-start gap-2">
          {state.status === 'loading' && (
            <p role="status" className="text-label text-ink-3">{LOG_FILTER_WORDS.reading}</p>
          )}
          {state.status === 'error' && (
            <>
              <p role="alert" className="text-label text-error">{state.message}</p>
              <Button variant="secondary" size="sm" icon="action.retry" onClick={() => { void load() }}>
                {LOG_FILTER_WORDS.tryAgain}
              </Button>
            </>
          )}
          {state.status === 'ready' && (
            <>
              <div
                role="region"
                aria-labelledby={headingId}
                tabIndex={0}
                data-part="full-output-text"
                className="max-h-72 w-full overflow-auto rounded-sm border border-line bg-sunken"
              >
                <pre className="w-max min-w-full select-text px-2.5 py-2 font-mono text-xs leading-normal text-ink-2">
                  {state.text === '' ? <span className="text-ink-3">{LOG_FILTER_WORDS.emptyOutput}</span> : state.text}
                </pre>
              </div>
              {state.truncated && <p className="text-label text-ink-3">{LOG_FILTER_WORDS.truncated}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon="action.copy"
                  disabled={state.text === ''}
                  onClick={() => { void copy(state.text) }}
                >
                  {copied ? LOG_FILTER_WORDS.copied : LOG_FILTER_WORDS.copy}
                </Button>
                {state.file !== null && (
                  <Button variant="ghost" size="sm" icon="action.reveal" onClick={() => { void api.showInFolder(state.file as string) }}>
                    {LOG_FILTER_WORDS.showFile}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
