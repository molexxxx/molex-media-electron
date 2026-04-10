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
  const recent = tasks.slice(-6).reverse()
  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/[0.05] px-4 py-3">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-surface-500 mb-2">Recent Activity</h3>
      <div className="flex items-center gap-3 overflow-x-auto">
        {recent.map((task) => (
          <div key={task.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.04] shrink-0">
            <StatusDot status={task.status} />
            <span className="text-2xs text-surface-500 font-mono uppercase">{task.operation}</span>
            <span className="text-xs text-surface-300 truncate max-w-[180px]">{task.fileName}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
