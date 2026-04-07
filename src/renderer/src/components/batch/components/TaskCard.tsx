/**
 * @module components/batch/TaskCard
 * @description Progress card showing status, file name, and elapsed time for a single processing task.
 */

import React from 'react'
import { ProcessingTask } from '../../../stores/types'
import { STATUS_COLORS_FULL, STATUS_LABELS } from '../../shared/constants'

interface TaskCardProps {
  task: ProcessingTask
}

export function TaskCard({ task }: TaskCardProps): React.JSX.Element {
  const colors = STATUS_COLORS_FULL[task.status] || STATUS_COLORS_FULL.queued

  return (
    <div className={`rounded-xl p-4 ${colors.bg} border border-white/[0.03] transition-all`}>
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`} />
        <span className="text-sm font-medium text-surface-200 flex-1 truncate">{task.fileName}</span>
        <span className={`text-2xs font-semibold uppercase tracking-wider ${colors.text}`}>
          {STATUS_LABELS[task.status]}
        </span>
        {task.status === 'complete' && (
          <button
            onClick={() => window.api.showInFolder(task.outputPath || task.filePath)}
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
}
