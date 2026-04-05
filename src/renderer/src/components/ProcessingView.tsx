import { useState, useCallback } from 'react'
import { useAppStore, FileItem } from '../stores/appStore'

export default function ProcessingView(): JSX.Element {
  const { tasks, isProcessing, isPaused, activeBatchId, clearTasks, addFiles, setView } = useAppStore()
  const [dragOver, setDragOver] = useState(false)

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
    setDragOver(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      paths.push((file as File & { path: string }).path)
    }
    if (paths.length) {
      const items: FileItem[] = paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      }))
      addFiles(items)
      setView('queue')
    }
  }, [addFiles, setView])

  const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
    queued: { bg: 'bg-surface-700/30', text: 'text-surface-400', dot: 'bg-surface-500' },
    analyzing: { bg: 'bg-blue-500/10', text: 'text-blue-300', dot: 'bg-blue-400 animate-pulse' },
    processing: { bg: 'bg-amber-500/10', text: 'text-amber-300', dot: 'bg-amber-400 animate-pulse' },
    finalizing: { bg: 'bg-cyan-500/10', text: 'text-cyan-300', dot: 'bg-cyan-400 animate-pulse' },
    complete: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', dot: 'bg-emerald-400' },
    error: { bg: 'bg-red-500/10', text: 'text-red-300', dot: 'bg-red-400' },
    cancelled: { bg: 'bg-surface-700/30', text: 'text-surface-400', dot: 'bg-surface-500' }
  }

  const statusLabel: Record<string, string> = {
    queued: 'Queued',
    analyzing: 'Analyzing',
    processing: 'Encoding',
    finalizing: 'Finalizing',
    complete: 'Done',
    error: 'Failed',
    cancelled: 'Cancelled'
  }

  return (
    <div
      className="space-y-5 animate-fade-in h-full flex flex-col relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm rounded-xl border-2 border-dashed border-accent-400/40">
          <p className="text-accent-300 font-semibold">Drop files to add to queue</p>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Processing</h1>
          <p className="text-sm text-surface-400 mt-0.5">
            {isProcessing
              ? isPaused
                ? `Paused · ${completed}/${total} complete`
                : `${active.length} active · ${completed}/${total} complete`
              : total > 0
                ? `Finished — ${completed} succeeded, ${errors} failed`
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
              onClick={clearTasks}
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
          {tasks.map((task) => {
            const colors = statusColors[task.status] || statusColors.queued
            return (
              <div key={task.id} className={`rounded-xl p-4 ${colors.bg} border border-white/[0.03] transition-all`}>
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`} />
                  <span className="text-sm font-medium text-surface-200 flex-1 truncate">{task.fileName}</span>
                  <span className={`text-2xs font-semibold uppercase tracking-wider ${colors.text}`}>
                    {statusLabel[task.status]}
                  </span>
                  {task.status === 'complete' && (
                    <button
                      onClick={() => window.api.showInFolder(task.filePath)}
                      className="text-2xs text-accent-400 hover:text-accent-300 font-medium transition-colors"
                    >
                      Show
                    </button>
                  )}
                </div>

                {(task.status === 'processing' || task.status === 'analyzing' || task.status === 'finalizing') && (
                  <div className="mb-2">
                    <div className="w-full h-1.5 bg-surface-800/50 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-accent-600 to-accent-400 rounded-full transition-all duration-300"
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="text-xs text-surface-500 truncate">{task.message}</span>
                  {task.progress > 0 && task.status !== 'complete' && (
                    <span className="text-2xs font-mono text-surface-500 shrink-0 ml-2">{task.progress}%</span>
                  )}
                </div>

                {task.error && (
                  <div className="mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                    <p className="text-xs text-red-300 font-mono">{task.error}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
