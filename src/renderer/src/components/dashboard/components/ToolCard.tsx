/**
 * @module components/dashboard/ToolCard
 * @description Navigation card used on the dashboard landing page.
 */

import React from 'react'

/**
 * @deprecated Tool cards no longer draw an animated background; the values remain only so
 * existing call sites that still pass `drawBg` keep compiling.
 */
export type ToolCardBackground = 'editor' | 'player'

/** @deprecated See {@link ToolCardBackground}. */
export const drawEditorBg: ToolCardBackground = 'editor'

/** @deprecated See {@link ToolCardBackground}. */
export const drawPlayerBg: ToolCardBackground = 'player'

const accentColors: Record<string, { border: string; bg: string; text: string; hoverText: string; hoverBorder: string }> = {
  blue:   { border: 'border-blue-500/20',   bg: 'bg-blue-500/10',   text: 'text-blue-400',   hoverText: 'group-hover:text-blue-300',   hoverBorder: 'hover:border-blue-500/30' },
  accent: { border: 'border-accent-500/20', bg: 'bg-accent-500/10', text: 'text-accent-400', hoverText: 'group-hover:text-accent-300', hoverBorder: 'hover:border-accent-500/30' },
}

/** Dashboard card that opens a tool view. */
export function ToolCard({ onClick, accentClass, title, desc, icon }: {
  onClick: () => void
  accentClass: string
  title: string
  desc: string
  icon: React.ReactNode
  /** @deprecated Ignored; see {@link ToolCardBackground}. */
  drawBg?: ToolCardBackground
}): React.JSX.Element {
  const c = accentColors[accentClass] || accentColors.blue

  return (
    <button
      onClick={onClick}
      className={`rounded-xl text-left group relative overflow-hidden flex flex-col h-full w-full bg-white/[0.03] border border-white/[0.06] ${c.hoverBorder} transition-all duration-300 hover:bg-white/[0.05]`}
    >
      <div className="flex items-end justify-between flex-1 p-5">
        <div className="flex flex-col items-start">
          <div className={`w-12 h-12 rounded-xl border flex items-center justify-center mb-3 ${c.border} ${c.bg} ${c.text}`}>
            {icon}
          </div>
          <h3 className={`text-lg font-bold text-surface-200 ${c.hoverText} transition-colors`}>{title}</h3>
          <p className="text-xs text-surface-500 mt-1 leading-relaxed">{desc}</p>
        </div>
        <svg className={`w-5 h-5 ${c.text} opacity-40 group-hover:opacity-80 group-hover:translate-x-1 transition-all`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  )
}
