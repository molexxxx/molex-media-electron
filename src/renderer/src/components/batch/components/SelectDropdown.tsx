import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

type Items = (SelectOption | SelectGroup)[]

function isGroup(item: SelectOption | SelectGroup): item is SelectGroup {
  return 'options' in item
}

export function SelectDropdown({ value, onChange, items, className }: {
  value: string
  onChange: (value: string) => void
  items: Items
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  // Flatten all options for display lookup
  const allOptions: SelectOption[] = []
  for (const item of items) {
    if (isGroup(item)) allOptions.push(...item.options)
    else allOptions.push(item)
  }
  const activeLabel = allOptions.find((o) => o.value === value)?.label ?? value

  // Position the portal panel relative to the trigger button
  const updatePos = useCallback(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 200) })
  }, [])

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

  const select = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  const renderOption = (o: SelectOption) => {
    const isActive = o.value === value
    return (
      <button
        key={o.value}
        onClick={() => select(o.value)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors ${
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
  }

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-surface-900/80 border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs text-surface-200 hover:border-white/[0.12] focus:outline-none focus:border-accent-500/50 transition-colors"
      >
        <span className="truncate flex-1 text-left">{activeLabel}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-surface-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[9999] max-h-[320px] overflow-y-auto rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl animate-fade-in"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {items.map((item, i) => {
            if (isGroup(item)) {
              return (
                <div key={item.label}>
                  <div className="px-3 py-1.5 text-2xs font-semibold text-surface-500 uppercase tracking-wider bg-surface-800/30 border-t border-surface-700/30">
                    {item.label}
                  </div>
                  {item.options.map(renderOption)}
                </div>
              )
            }
            return <React.Fragment key={`opt-${i}`}>{renderOption(item)}</React.Fragment>
          })}
        </div>,
        document.body
      )}
    </div>
  )
}
