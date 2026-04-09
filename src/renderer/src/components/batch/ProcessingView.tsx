/**
 * @module components/batch/ProcessingView
 * @description Full-screen view for active batch processing with task-level progress.
 *
 * Displays overall progress, per-task status with animated progress bars,
 * pause / resume / cancel controls, and drag-and-drop to add more files
 * mid-batch. Uses shared status constants for consistent styling.
 */

import React, { useState, useCallback, useRef } from 'react'
import { useAppStore, FileItem } from '../../stores/appStore'
import { TaskCard } from './components/TaskCard'

export default function ProcessingView(): React.JSX.Element {
  const { tasks, isProcessing, isPaused, activeBatchId, resetBatch, addFiles, setView } = useAppStore()
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const completed = tasks.filter((t) => t.status === 'complete').length
  const errors = tasks.filter((t) => t.status === 'error').length
  const total = tasks.length
  const active = tasks.filter((t) => t.status === 'processing' || t.status === 'analyzing')
  const overallProgress = total > 0 ? Math.round(tasks.reduce((a, t) => a + t.progress, 0) / total) : 0

  const handleCancel = async () => {
    if (activeBatchId) {
      await window.api.cancelBatch(activeBatchId)
    }
  }

  const handlePauseResume = async () => {
    if (isPaused) {
      await window.api.resumeProcessing()
    } else {
      await window.api.pauseProcessing()
    }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setDragOver(false)
    const items: FileItem[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.api.getFilePath(file)
      if (!p) continue
      items.push({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: file.size || 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      })
    }
    if (items.length) {
      addFiles(items)
      setView('batch')
    }
  }, [addFiles, setView])

  return (
    <div
      className="space-y-5 animate-fade-in min-h-full flex flex-col relative"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; setDragOver(true) }}
      onDragLeave={(e) => { e.stopPropagation(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDragOver(false) } }}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-accent-500/[0.06] backdrop-blur-sm rounded-2xl border border-accent-400 pointer-events-none">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full border-2 border-dashed border-accent-400/60 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-300"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <p className="text-accent-300 font-semibold">Drop to add</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium text-surface-200 tracking-tight">Processing</h1>
          <p className="text-sm text-surface-400 mt-0.5">
            {isProcessing
              ? isPaused
                ? `Paused · ${completed}/${total} complete`
                : `${active.length} active · ${completed}/${total} complete`
              : total > 0
                ? `Finished - ${completed} succeeded, ${errors} failed`
                : 'No active tasks'
            }
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isProcessing && (
            <>
              <button
                onClick={handlePauseResume}
                className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                  isPaused
                    ? 'text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20'
                    : 'text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
                }`}
              >
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-1.5 text-sm font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-all"
              >
                Cancel All
              </button>
            </>
          )}
          {!isProcessing && tasks.length > 0 && (
            <button
              onClick={() => { resetBatch(); setView('batch') }}
              className="px-4 py-1.5 text-sm font-medium text-surface-400 hover:text-surface-200 bg-surface-700/50 hover:bg-surface-600/50 rounded-lg transition-all"
            >
              Clear Results
            </button>
          )}
        </div>
      </div>

      {/* Overall progress */}
      {tasks.length > 0 && (
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-surface-500">Overall Progress</span>
            <span className="text-sm font-mono text-surface-300">{overallProgress}%</span>
          </div>
          <div className="w-full h-2 bg-surface-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                errors > 0 && !isProcessing
                  ? 'bg-gradient-to-r from-emerald-500 to-red-400'
                  : 'bg-gradient-to-r from-accent-600 to-accent-400'
              }`}
              style={{ width: `${overallProgress}%` }}
            />
          </div>
          <div className="flex items-center gap-4 mt-2 text-2xs text-surface-500">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {completed} complete
            </span>
            {errors > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400" /> {errors} failed
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-surface-500" /> {total - completed - errors} remaining
            </span>
          </div>
        </div>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-surface-800/50 border border-surface-700/50 flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-surface-500">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </div>
            <p className="text-surface-400 text-sm font-medium">No processing tasks</p>
            <p className="text-surface-600 text-xs mt-1">Add files to the queue and start processing</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  )
}
