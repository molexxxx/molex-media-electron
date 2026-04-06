/**
 * @module components/dashboard/StatCard
 * @description Compact statistic card showing a label, value, and optional subtitle.
 */

import React from 'react'

export function StatCard({ label, value, sub, color }: {
  label: string
  value: string | number
  sub?: string
  color: string
}): React.JSX.Element {
  return (
    <div className="glass rounded-xl p-3 flex flex-col gap-0.5">
      <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-2xs text-surface-500">{sub}</span>}
    </div>
  )
}
