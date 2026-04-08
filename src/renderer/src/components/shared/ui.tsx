/**
 * @module components/shared/ui
 * @description Reusable form primitives used across settings tabs and other panels.
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function SettingGroup({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-xl p-3 sm:p-5 space-y-3 sm:space-y-4 bg-white/[0.03] border border-white/[0.06]">
      <h3 className="text-2xs font-semibold uppercase tracking-wider text-surface-500">{title}</h3>
      {children}
    </div>
  )
}

export function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-surface-200 font-medium">{label}</p>
        {description && <p className="text-2xs sm:text-xs text-surface-500 mt-0.5 line-clamp-2">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full transition-all duration-200 flex items-center px-0.5 ${
        checked ? 'bg-accent-500/40 border border-accent-500/50' : 'bg-white/[0.06] border border-white/[0.08]'
      }`}
    >
      <span
        className={`w-4 h-4 rounded-full shadow transition-all duration-200 ${
          checked ? 'translate-x-4 bg-accent-300' : 'bg-surface-300'
        }`}
      />
    </button>
  )
}

export function NumberInput({ value, onChange, min, max, step = 0.1, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string
}): React.JSX.Element {
  return (
    <div className="inline-flex items-center w-[10rem] bg-white/[0.04] border border-white/[0.06] rounded-lg overflow-hidden hover:border-white/[0.12] focus-within:border-accent-500/50 transition-colors">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        className="flex-1 min-w-0 bg-transparent px-2.5 py-1.5 text-sm text-white font-mono text-right focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {unit && <span className="w-14 text-center text-xs text-surface-400 font-medium border-l border-white/[0.06] py-1.5 bg-white/[0.02] shrink-0">{unit}</span>}
    </div>
  )
}

/* ---- Custom dropdown select (replaces native <select>) ---- */

export function Select({ value, onChange, options, compact, disabled, className, title }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]
  compact?: boolean; disabled?: boolean; className?: string; title?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; openUp: boolean } | null>(null)

  const activeLabel = options.find((o) => o.value === value)?.label ?? value

  const updatePos = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const panelHeight = Math.min(options.length * (compact ? 28 : 32) + 8, 280)
    const openUp = spaceBelow < panelHeight && rect.top > panelHeight
    setPos({
      top: openUp ? undefined : rect.bottom + 3,
      bottom: openUp ? window.innerHeight - rect.top + 3 : undefined,
      left: rect.left,
      width: Math.max(rect.width, compact ? 120 : 180),
      openUp
    })
  }, [compact, options.length])

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

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

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

  const select = (v: string) => { onChange(v); setOpen(false) }

  const triggerCls = compact
    ? 'flex items-center gap-1 bg-surface-900/80 border border-white/[0.06] rounded-lg px-1.5 py-0.5 text-2xs hover:border-white/[0.12] transition-colors cursor-pointer'
    : 'flex items-center gap-2 bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-sm hover:border-white/[0.12] transition-colors cursor-pointer min-w-[8rem] sm:min-w-[13rem]'

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        className={`${triggerCls} ${disabled ? 'opacity-50 pointer-events-none' : ''} text-surface-200 focus:outline-none focus:border-accent-500/50`}
      >
        <span className="truncate flex-1 text-left">{activeLabel}</span>
        <svg
          width={compact ? '8' : '10'} height={compact ? '8' : '10'} viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-surface-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[9999] max-h-[280px] overflow-y-auto rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl animate-fade-in"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.width }}
        >
          {options.map((o) => {
            const isActive = o.value === value
            return (
              <button
                key={o.value}
                onClick={() => select(o.value)}
                className={`w-full flex items-center justify-between gap-2 ${compact ? 'px-2.5 py-1 text-2xs' : 'px-3 py-1.5 text-xs'} transition-colors ${
                  isActive
                    ? 'bg-accent-600/15 text-white'
                    : 'text-surface-300 hover:bg-surface-800/60 hover:text-white'
                }`}
              >
                <span className="truncate">{o.label}</span>
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-accent-400 shrink-0">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}

/**
 * Tooltip that uses fixed positioning via a portal so it escapes
 * overflow-hidden / overflow-auto scroll containers.
 */
export function FixedTip({ label, children, position = 'below' }: { label: string; children: ReactNode; position?: 'below' | 'right' }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const show = (): void => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (position === 'right') {
      setPos({ top: rect.top + rect.height / 2, left: rect.right + 8 })
    } else {
      setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 })
    }
  }

  return (
    <div ref={ref} onMouseEnter={show} onMouseLeave={() => setPos(null)} className="relative">
      {children}
      {pos && createPortal(
        <div
          className="fixed px-2 py-1 rounded-md bg-surface-900/95 border border-surface-700/60 text-[10px] text-surface-200 whitespace-nowrap pointer-events-none z-[9999] shadow-lg shadow-black/30 backdrop-blur-sm animate-fade-in"
          style={position === 'right'
            ? { top: pos.top, left: pos.left, transform: 'translateY(-50%)' }
            : { top: pos.top, left: pos.left, transform: 'translateX(-50%)' }
          }
        >
          {label}
        </div>,
        document.body
      )}
    </div>
  )
}
