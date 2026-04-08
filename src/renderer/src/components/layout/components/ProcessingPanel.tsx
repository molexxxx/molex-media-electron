/**
 * @module components/layout/ProcessingPanel
 * @description Collapsible sidebar panel showing batch processing progress, pause/cancel controls,
 * and system info popover. Designed to work in both expanded and collapsed sidebar modes.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { STATUS_COLORS, STATUS_LABELS } from '../../shared/constants'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatPlatform(platform?: string, arch?: string): string {
  const names: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return `${names[platform || ''] || platform || '—'} ${arch || ''}`
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '—'
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

const OP_ICONS: Record<string, React.JSX.Element> = {
  normalize: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/></svg>,
  convert: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>,
  boost: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>,
  compress: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M4 14.899A7 7 0 1115.71 8h1.79a4.5 4.5 0 012.5 8.242"/><path d="M12 12v9"/></svg>,
  extract: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
}

/* ------------------------------------------------------------------ */
/*  System Info Popover                                                */
/* ------------------------------------------------------------------ */

function InfoRow({ label, value, ok }: { label: string; value: string; ok?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 min-w-0">
      <span className="text-surface-500 text-xs shrink-0">{label}</span>
      <span className={`font-mono text-xs truncate ${ok === true ? 'text-emerald-400' : ok === false ? 'text-red-400' : 'text-surface-300'}`}>
        {value}
      </span>
    </div>
  )
}

function SystemInfoPopover({ anchorRef, onClose }: { anchorRef: React.RefObject<HTMLElement | null>; onClose: () => void }): React.JSX.Element | null {
  const { systemInfo, ffmpegVersion, config } = useAppStore()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)

  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - rect.top + 8, left: rect.right + 8 })
  }, [anchorRef])

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, anchorRef])

  if (!pos) return null

  return (
    <div
      ref={popoverRef}
      className="fixed z-999 w-72 bg-surface-900/95 backdrop-blur-xl border border-surface-700/60 rounded-xl shadow-2xl shadow-black/40 p-4 animate-fade-in"
      style={{ bottom: pos.bottom, left: pos.left }}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-2">System</h3>
      <div className="space-y-1">
        <InfoRow label="FFmpeg" value={ffmpegVersion || 'Not installed'} ok={!!ffmpegVersion} />
        <InfoRow label="Platform" value={formatPlatform(systemInfo?.platform, systemInfo?.arch)} />
        <InfoRow label="CPU Cores" value={String(systemInfo?.cpus || '—')} />
        <InfoRow label="Workers" value={String(config?.maxWorkers || '—')} />
        <InfoRow label="Audio Codec" value={config?.audioCodec || '—'} />
        <InfoRow label="Bitrate" value={config?.audioBitrate || '—'} />
        <InfoRow
          label="Target LUFS"
          value={config ? `I=${config.normalization.I} TP=${config.normalization.TP} LRA=${config.normalization.LRA}` : '—'}
        />
        <InfoRow
          label="Memory"
          value={systemInfo ? `${formatBytes(systemInfo.freeMemory)} free / ${formatBytes(systemInfo.totalMemory)}` : '—'}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Collapsed Popover — task list panel for collapsed sidebar          */
/* ------------------------------------------------------------------ */

function CollapsedTaskPopover({ anchorRef, onClose }: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}): React.JSX.Element | null {
  const { tasks, isProcessing, isPaused, activeBatchId, clearTasks } = useAppStore()
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)

  const completed = tasks.filter((t) => t.status === 'complete').length
  const errors = tasks.filter((t) => t.status === 'error').length
  const total = tasks.length
  const overallProgress = total > 0 ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / total) : 0

  const handleCancel = useCallback(async () => {
    if (activeBatchId) await window.api.cancelBatch(activeBatchId)
  }, [activeBatchId])

  const handlePauseResume = useCallback(async () => {
    if (isPaused) await window.api.resumeProcessing()
    else await window.api.pauseProcessing()
  }, [isPaused])

  useEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - rect.bottom, left: rect.right + 8 })
  }, [anchorRef])

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey) }
  }, [onClose, anchorRef])

  if (!pos) return null

  return (
    <div
      ref={popoverRef}
      className="fixed z-999 w-72 bg-surface-900/95 backdrop-blur-xl border border-surface-700/60 rounded-xl shadow-2xl shadow-black/40 animate-fade-in"
      style={{ bottom: pos.bottom, left: pos.left }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-surface-300">
            {isProcessing
              ? isPaused ? 'Paused' : `Processing ${completed}/${total}`
              : total > 0 ? `${completed} done${errors > 0 ? `, ${errors} error${errors > 1 ? 's' : ''}` : ''}` : 'Ready'}
          </span>
          {isProcessing && (
            <span className="text-2xs font-mono text-accent-400 tabular-nums">{overallProgress}%</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isProcessing && (
            <>
              <button onClick={handlePauseResume} className={`p-1 rounded-md transition-colors cursor-pointer ${isPaused ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-amber-400 hover:bg-amber-500/10'}`} title={isPaused ? 'Resume' : 'Pause'}>
                {isPaused ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                )}
              </button>
              <button onClick={handleCancel} className="p-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer" title="Cancel">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </>
          )}
          {!isProcessing && total > 0 && (
            <button onClick={clearTasks} className="text-2xs text-surface-500 hover:text-surface-200 transition-colors cursor-pointer">Clear</button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="px-3 pb-2">
          <div className="w-full h-1 bg-surface-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${errors > 0 && !isProcessing ? 'bg-gradient-to-r from-emerald-500 to-red-400' : 'bg-gradient-to-r from-accent-600 to-accent-400'}`}
              style={{ width: `${overallProgress}%` }} />
          </div>
        </div>
      )}

      {/* Task list */}
      <div className="max-h-[240px] overflow-y-auto scrollbar-thin border-t border-white/5">
        {total === 0 ? (
          <div className="flex items-center justify-center py-6"><p className="text-2xs text-surface-600">No tasks yet</p></div>
        ) : (
          <div className="py-1">
            {tasks.map((task) => <TaskRow key={task.id} task={task} />)}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared task row                                                    */
/* ------------------------------------------------------------------ */

function TaskRow({ task }: { task: import('../../../stores/types').ProcessingTask }): React.JSX.Element {
  const colors = STATUS_COLORS[task.status] || STATUS_COLORS.queued
  const isActive = task.status === 'processing' || task.status === 'analyzing' || task.status === 'finalizing'
  const isDone = task.status === 'complete'
  const isFailed = task.status === 'error'

  return (
    <div className={`group flex items-center gap-2 px-3 py-1.5 transition-colors cursor-default ${
      isActive ? 'bg-accent-500/5' : 'hover:bg-surface-800/40'
    }`}>
      {/* Status dot */}
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />

      {/* Operation icon */}
      <span className={`shrink-0 ${colors.text} opacity-60`}>
        {OP_ICONS[task.operation] || null}
      </span>

      {/* File name */}
      <span className="text-2xs text-surface-300 flex-1 truncate">{task.fileName}</span>

      {/* Progress / status */}
      <div className="flex items-center gap-1.5 shrink-0">
        {isActive && (
          <div className="w-12 h-1 bg-surface-800 rounded-full overflow-hidden">
            <div className="h-full bg-accent-500 rounded-full transition-all duration-300" style={{ width: `${task.progress}%` }} />
          </div>
        )}
        <span className={`text-[9px] font-semibold uppercase tracking-wider ${colors.text} tabular-nums`}>
          {isActive ? `${task.progress}%` : STATUS_LABELS[task.status]}
        </span>
      </div>

      {/* Actions on hover */}
      {isDone && (
        <button
          onClick={() => window.api.showInFolder(task.outputPath || task.filePath)}
          className="text-[9px] text-accent-400 hover:text-accent-300 font-medium opacity-0 group-hover:opacity-100 transition-all shrink-0 cursor-pointer"
          title="Show in folder"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        </button>
      )}
      {isFailed && task.error && (
        <span className="text-[8px] text-red-400/60 opacity-0 group-hover:opacity-100 transition-all truncate max-w-[60px]" title={task.error}>
          {task.error}
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ProcessingPanel({ collapsed }: { collapsed?: boolean }): React.JSX.Element {
  const { tasks, isProcessing, isPaused, activeBatchId, clearTasks } = useAppStore()
  const [showProcessing, setShowProcessing] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const dotRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const completed = tasks.filter((t) => t.status === 'complete').length
  const errors = tasks.filter((t) => t.status === 'error').length
  const total = tasks.length
  const overallProgress = total > 0 ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / total) : 0

  const handleCancel = useCallback(async () => {
    if (activeBatchId) await window.api.cancelBatch(activeBatchId)
  }, [activeBatchId])

  const handlePauseResume = useCallback(async () => {
    if (isPaused) await window.api.resumeProcessing()
    else await window.api.pauseProcessing()
  }, [isPaused])

  const toggleInfo = useCallback(() => { setShowInfo((v) => !v); setShowProcessing(false) }, [])
  const closeInfo = useCallback(() => setShowInfo(false), [])

  const dotColor = isProcessing
    ? isPaused ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'
    : total > 0 && errors > 0 ? 'bg-red-400' : 'bg-emerald-400'

  const statusText = isProcessing
    ? isPaused ? 'Paused' : `Processing ${completed}/${total}`
    : total > 0
      ? `${completed} done${errors > 0 ? `, ${errors} error${errors > 1 ? 's' : ''}` : ''}`
      : 'Ready'

  /* ---- SVG progress ring for collapsed mode ---- */
  const ringRadius = 9
  const ringCirc = 2 * Math.PI * ringRadius
  const ringOffset = ringCirc - (overallProgress / 100) * ringCirc

  /* ---- Collapsed sidebar ---- */
  if (collapsed) {
    return (
      <div className="mt-auto border-t border-white/5 flex flex-col items-center py-2.5 gap-1.5">
        {/* Status dot or progress ring */}
        <button
          ref={dotRef}
          onClick={() => { setShowProcessing((v) => !v); setShowInfo(false) }}
          className="relative w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-800/60 transition-colors cursor-pointer group"
          title={statusText}
        >
          {isProcessing ? (
            <>
              <svg width="22" height="22" viewBox="0 0 22 22" className="absolute">
                <circle cx="11" cy="11" r={ringRadius} fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-800" />
                <circle cx="11" cy="11" r={ringRadius} fill="none" stroke="currentColor" strokeWidth="2"
                  strokeDasharray={ringCirc} strokeDashoffset={ringOffset} strokeLinecap="round"
                  className="text-accent-400 transition-all duration-500" transform="rotate(-90 11 11)" />
              </svg>
              <span className="text-[7px] font-bold font-mono text-accent-300 tabular-nums">{overallProgress}</span>
            </>
          ) : (
            <div className={`w-2 h-2 rounded-full ${dotColor} group-hover:scale-125 transition-transform`} />
          )}
        </button>

        {/* System info dot */}
        <button
          onClick={toggleInfo}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-surface-600 hover:text-surface-300 hover:bg-surface-800/60 transition-all cursor-pointer"
          title="System Info"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
          </svg>
        </button>

        {showProcessing && <CollapsedTaskPopover anchorRef={dotRef} onClose={() => setShowProcessing(false)} />}
        {showInfo && <SystemInfoPopover anchorRef={dotRef} onClose={closeInfo} />}
      </div>
    )
  }

  /* ---- Expanded sidebar ---- */
  return (
    <div className="mt-auto border-t border-white/5" ref={panelRef}>
      {/* Status row — clickable to expand */}
      <button
        onClick={() => setShowProcessing((v) => !v)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors group ${
          showProcessing ? 'bg-surface-800/50' : 'hover:bg-surface-800/30'
        }`}
      >
        {/* Status indicator */}
        {isProcessing ? (
          <div className="relative w-5 h-5 shrink-0 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-surface-800" />
              <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeDasharray={2 * Math.PI * 8} strokeDashoffset={(2 * Math.PI * 8) - (overallProgress / 100) * (2 * Math.PI * 8)}
                strokeLinecap="round" className="text-accent-400 transition-all duration-500" transform="rotate(-90 10 10)" />
            </svg>
            <span className="absolute text-[6px] font-bold font-mono text-accent-300 tabular-nums">{overallProgress}</span>
          </div>
        ) : (
          <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor} group-hover:scale-125 transition-transform`} />
        )}

        {/* Status text */}
        <span className="text-2xs font-medium text-surface-400 group-hover:text-surface-200 flex-1 text-left transition-colors truncate">
          {statusText}
        </span>

        {/* Summary badges */}
        {total > 0 && !isProcessing && (
          <div className="flex items-center gap-1">
            {completed > 0 && (
              <span className="text-[9px] font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                {completed}
              </span>
            )}
            {errors > 0 && (
              <span className="text-[9px] font-mono font-semibold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                {errors}
              </span>
            )}
          </div>
        )}

        {/* Chevron */}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`text-surface-600 group-hover:text-surface-400 transition-all shrink-0 ${showProcessing ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* System info popover anchor — use existing dotRef pattern */}
      <button
        ref={dotRef}
        onClick={toggleInfo}
        className="sr-only"
        aria-label="System Info"
      />
      {showInfo && <SystemInfoPopover anchorRef={panelRef} onClose={closeInfo} />}

      {/* Thin progress bar visible when collapsed */}
      {isProcessing && !showProcessing && (
        <div className="px-3 pb-2">
          <div className="w-full h-1 bg-surface-800 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-accent-600 to-accent-400 rounded-full transition-all duration-500"
              style={{ width: `${overallProgress}%` }} />
          </div>
        </div>
      )}

      {/* Expanded task panel */}
      {showProcessing && (
        <div className="max-h-[300px] flex flex-col border-t border-white/5 animate-fade-in">
          {/* Controls bar */}
          {(isProcessing || total > 0) && (
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/5">
              {isProcessing && (
                <>
                  <button
                    onClick={handlePauseResume}
                    className={`flex items-center gap-1 px-2 py-1 text-2xs font-medium rounded-md transition-colors cursor-pointer ${
                      isPaused ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-amber-400 hover:bg-amber-500/10'
                    }`}
                  >
                    {isPaused ? (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
                    ) : (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                    )}
                    {isPaused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={handleCancel}
                    className="flex items-center gap-1 px-2 py-1 text-2xs font-medium text-red-400 hover:bg-red-500/10 rounded-md transition-colors cursor-pointer"
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    Cancel
                  </button>
                </>
              )}
              {!isProcessing && total > 0 && (
                <button
                  onClick={clearTasks}
                  className="flex items-center gap-1 px-2 py-1 text-2xs font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 rounded-md transition-colors cursor-pointer"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  Clear
                </button>
              )}
              <div className="flex-1" />
              {isProcessing && (
                <span className="text-2xs font-mono text-accent-400 tabular-nums font-semibold">{overallProgress}%</span>
              )}
              {total > 0 && (
                <span className="text-[9px] text-surface-500 font-mono">
                  {completed}/{total}
                </span>
              )}
            </div>
          )}

          {/* Overall progress bar */}
          {total > 0 && (
            <div className="px-3 pt-2 pb-1.5">
              <div className="w-full h-1.5 bg-surface-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    errors > 0 && !isProcessing
                      ? 'bg-gradient-to-r from-emerald-500 to-red-400'
                      : 'bg-gradient-to-r from-accent-600 to-accent-400'
                  }`}
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Task list */}
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {total === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-surface-700">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
                <p className="text-2xs text-surface-600">No tasks — start a batch to see progress here</p>
              </div>
            ) : (
              <div className="py-0.5">
                {tasks.map((task) => <TaskRow key={task.id} task={task} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
