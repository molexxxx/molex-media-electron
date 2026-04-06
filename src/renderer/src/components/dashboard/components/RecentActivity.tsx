/**
 * @module components/dashboard/RecentActivity
 * @description Scrollable list of recent processing tasks with status indicators.
 */

import React from 'react'
import type { ProcessingTask } from '../../../stores/types'

function StatusDot({ status }: { status: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    complete: 'bg-emerald-400',
    error: 'bg-red-400',
    processing: 'bg-amber-400 animate-pulse',
    analyzing: 'bg-blue-400 animate-pulse',
    queued: 'bg-surface-500',
    cancelled: 'bg-surface-500',
    finalizing: 'bg-cyan-400 animate-pulse'
  }
  return <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[status] || 'bg-surface-500'}`} />
}

export function RecentActivity({ tasks }: { tasks: ProcessingTask[] }): React.JSX.Element {
  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500">Recent Activity</h3>
      </div>
      <div className="space-y-1.5">
        {tasks.slice(-5).reverse().map((task) => (
          <div key={task.id} className="flex items-center gap-3 py-1.5">
            <StatusDot status={task.status} />
            <span className="text-xs text-surface-500 font-mono w-16 shrink-0">{task.operation}</span>
            <span className="text-sm text-surface-300 flex-1 truncate">{task.fileName}</span>
            <span className="text-2xs text-surface-500 font-mono">{task.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
