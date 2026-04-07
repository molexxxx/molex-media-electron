import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { PresetIcon } from './PresetIcons'
import type { ConvertPreset, PresetCategory } from '../presets'

export function PresetDropdown({ categories, activeId, onSelect }: {
  categories: PresetCategory[]
  activeId: string
  onSelect: (preset: ConvertPreset) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const updatePos = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left })
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    updatePos()
    const handler = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (panelRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, updatePos])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // Reposition on scroll/resize while open
  useEffect(() => {
    if (!open) return
    const onScroll = () => updatePos()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, updatePos])

  const all = categories.flatMap((c) => c.presets)
  const active = all.find((p) => p.id === activeId)

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-1.5 text-xs text-white hover:border-surface-600 focus:outline-none focus:border-accent-500 transition-colors min-w-[220px]"
      >
        {active ? (
          <>
            <PresetIcon name={active.icon} size={14} className="text-accent-400" />
            <span className="truncate">{active.label}</span>
          </>
        ) : (
          <span className="text-surface-400">Custom</span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`ml-auto text-surface-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown panel — rendered via portal to escape overflow-hidden */}
      {open && pos && createPortal(
        <div ref={panelRef} className="fixed z-[9999] w-[340px] max-h-[400px] overflow-y-auto rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl animate-fade-in" style={{ top: pos.top, left: pos.left }}>
          {/* Custom option */}
          <button
            onClick={() => { onSelect({ id: '', label: 'Custom', description: '', icon: '', options: {} }); setOpen(false) }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors ${
              !activeId ? 'bg-accent-600/15 text-accent-300' : 'text-surface-400 hover:bg-surface-800/60 hover:text-surface-200'
            }`}
          >
            <span className="w-4 h-4 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </span>
            <span>Custom</span>
          </button>

          {categories.map((cat) => (
            <div key={cat.label}>
              {/* Category header */}
              <div className="px-3 py-1.5 text-2xs font-semibold text-surface-500 uppercase tracking-wider bg-surface-800/30 border-t border-surface-700/30">
                {cat.label}
              </div>
              {cat.presets.map((p) => {
                const isActive = p.id === activeId
                return (
                  <button
                    key={p.id}
                    onClick={() => { onSelect(p); setOpen(false) }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors group ${
                      isActive
                        ? 'bg-accent-600/15 text-white'
                        : 'text-surface-300 hover:bg-surface-800/60 hover:text-white'
                    }`}
                  >
                    <PresetIcon
                      name={p.icon}
                      size={14}
                      className={isActive ? 'text-accent-400' : 'text-surface-500 group-hover:text-accent-400/70'}
                    />
                    <span className="font-medium truncate">{p.label}</span>
                    <span className={`ml-auto text-2xs truncate max-w-[140px] ${
                      isActive ? 'text-accent-400/60' : 'text-surface-600 group-hover:text-surface-500'
                    }`}>
                      {p.description}
                    </span>
                    {isActive && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-accent-400 shrink-0">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
