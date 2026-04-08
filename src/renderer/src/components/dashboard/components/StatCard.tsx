/**
 * @module components/dashboard/StatBar
 * @description Compact inline status bar replacing individual stat cards.
 */

import React from 'react'

interface Stat {
  label: string
  value: string | number
  color: string
  dotColor: string
}

export function StatBar({ stats }: { stats: Stat[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 sm:gap-5">
      {stats.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5 sm:gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${s.dotColor}`} />
          <span className={`text-xs sm:text-sm font-bold tabular-nums ${s.color}`}>{s.value}</span>
          <span className="text-2xs text-surface-500 uppercase tracking-wider font-medium">{s.label}</span>
        </div>
      ))}
    </div>
  )
}
