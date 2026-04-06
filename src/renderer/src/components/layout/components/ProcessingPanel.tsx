/**
 * @module components/layout/ProcessingPanel
 * @description Collapsible sidebar panel showing batch processing progress, pause/cancel controls.
 */

import React, { useState, useCallback } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { STATUS_COLORS, STATUS_LABELS } from '../../shared/constants'

export function ProcessingPanel({ collapsed }: { collapsed?: boolean }): React.JSX.Element {
  const { tasks, isProcessing, isPaused, activeBatchId, clearTasks } = useAppStore()
  const [showProcessing, setShowProcessing] = useState(false)

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

  if (collapsed) {
    return (
      <div className="mt-auto border-t border-white/5 flex flex-col items-center py-2 gap-1">
        <div className={`w-2 h-2 rounded-full ${
          isProcessing ? 'bg-amber-400 animate-pulse' : total > 0 && errors > 0 ? 'bg-red-400' : 'bg-emerald-400'
        }`} title={
          isProcessing
            ? isPaused ? 'Paused' : `Processing ${completed}/${total} (${overallProgress}%)`
            : total > 0
              ? `${completed} done${errors > 0 ? `, ${errors} failed` : ''}`
              : 'Ready'
        } />
        {isProcessing && (
          <span className="text-[8px] font-mono text-surface-500">{overallProgress}%</span>
        )}
      </div>
    )
  }

  return (
    <div className="mt-auto border-t border-white/5">
      {/* Toggle button */}
      <button
        onClick={() => setShowProcessing((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors ${
          showProcessing ? 'bg-surface-800/50' : 'hover:bg-surface-800/30'
        }`}
      >
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isProcessing ? 'bg-amber-400 animate-pulse' : total > 0 && errors > 0 ? 'bg-red-400' : 'bg-emerald-400'
        }`} />
        <span className="text-2xs font-medium text-surface-400 flex-1 text-left">
          {isProcessing
            ? isPaused ? 'Paused' : `Processing ${completed}/${total}`
            : total > 0
              ? `${completed} done${errors > 0 ? `, ${errors} failed` : ''}`
              : 'Ready'
          }
        </span>
        {isProcessing && (
          <span className="text-2xs font-mono text-surface-500">{overallProgress}%</span>
        )}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`text-surface-600 transition-transform ${showProcessing ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Progress bar (always visible when processing) */}
      {isProcessing && !showProcessing && (
        <div className="px-3 pb-2">
          <div className="w-full h-1 bg-surface-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-accent-600 to-accent-400 rounded-full transition-all duration-500"
              style={{ width: `${overallProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Expanded panel */}
      {showProcessing && (
        <div className="max-h-[280px] flex flex-col border-t border-white/5">
          {/* Controls */}
          {(isProcessing || total > 0) && (
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/5">
              {isProcessing && (
                <>
                  <button
                    onClick={handlePauseResume}
                    className={`px-2 py-0.5 text-2xs font-medium rounded transition-colors ${
                      isPaused ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-amber-400 hover:bg-amber-500/10'
                    }`}
                  >
                    {isPaused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    onClick={handleCancel}
                    className="px-2 py-0.5 text-2xs font-medium text-red-400 hover:bg-red-500/10 rounded transition-colors"
                  >
                    Cancel
                  </button>
                </>
              )}
              {!isProcessing && total > 0 && (
                <button
                  onClick={clearTasks}
                  className="px-2 py-0.5 text-2xs font-medium text-surface-400 hover:text-surface-200 hover:bg-surface-700/50 rounded transition-colors"
                >
                  Clear
                </button>
              )}
              {isProcessing && (
                <span className="ml-auto text-2xs font-mono text-surface-500">{overallProgress}%</span>
              )}
            </div>
          )}

          {/* Overall progress bar */}
          {total > 0 && (
            <div className="px-3 pt-2 pb-1">
              <div className="w-full h-1 bg-surface-800 rounded-full overflow-hidden">
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
          <div className="flex-1 overflow-y-auto scrollbar-thin px-1 py-1">
            {total === 0 ? (
              <div className="flex items-center justify-center py-6">
                <p className="text-2xs text-surface-600">No tasks</p>
              </div>
            ) : (
              tasks.map((task) => {
                const colors = STATUS_COLORS[task.status] || STATUS_COLORS.queued
                return (
                  <div
                    key={task.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-surface-800/30 transition-colors group"
                  >
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`} />
                    <span className="text-2xs text-surface-300 flex-1 truncate">{task.fileName}</span>
                    <span className={`text-[9px] font-semibold uppercase tracking-wider shrink-0 ${colors.text}`}>
                      {task.status === 'processing' || task.status === 'analyzing' || task.status === 'finalizing'
                        ? `${task.progress}%`
                        : STATUS_LABELS[task.status]
                      }
                    </span>
                    {task.status === 'complete' && (
                      <button
                        onClick={() => window.api.showInFolder(task.filePath)}
                        className="text-[9px] text-accent-400 hover:text-accent-300 font-medium opacity-0 group-hover:opacity-100 transition-all shrink-0"
                      >
                        Show
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
