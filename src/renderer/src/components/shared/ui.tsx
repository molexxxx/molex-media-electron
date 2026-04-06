/**
 * @module components/shared/ui
 * @description Reusable form primitives used across settings tabs and other panels.
 */

import React from 'react'

export function SettingGroup({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="glass rounded-xl p-5 space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500">{title}</h3>
      {children}
    </div>
  )
}

export function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <p className="text-sm text-surface-200 font-medium">{label}</p>
        {description && <p className="text-xs text-surface-500 mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full transition-colors duration-200 relative ${
        checked ? 'bg-accent-600' : 'bg-surface-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}

export function NumberInput({ value, onChange, min, max, step = 0.1, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        className="w-20 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500 transition-colors"
      />
      {unit && <span className="text-xs text-surface-500">{unit}</span>}
    </div>
  )
}

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-accent-500 transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
