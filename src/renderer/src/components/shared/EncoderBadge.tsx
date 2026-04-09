import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../stores/appStore'

const GPU_LABELS: Record<string, { label: string; color: string }> = {
  nvenc: { label: 'NVENC', color: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25' },
  qsv:   { label: 'QSV',   color: 'text-blue-400 bg-blue-500/15 border-blue-500/25' },
  amf:   { label: 'AMF',   color: 'text-orange-400 bg-orange-500/15 border-orange-500/25' },
  auto:  { label: 'GPU',   color: 'text-emerald-400 bg-emerald-500/15 border-emerald-500/25' },
}

function Tooltip({ text, anchorRef }: { text: string; anchorRef: React.RefObject<HTMLElement | null> }): React.JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
  }, [anchorRef])

  if (!pos) return null

  return createPortal(
    <div
      className="fixed z-[200] px-2.5 py-1.5 text-2xs text-surface-200 bg-surface-800 border border-surface-600 rounded-lg shadow-xl whitespace-nowrap -translate-x-1/2 -translate-y-full pointer-events-none animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
    >
      {text}
    </div>,
    document.body
  )
}

export function EncoderBadge(): React.JSX.Element {
  const { config } = useAppStore()
  const gpuMode = config?.gpuAcceleration || 'off'
  const isGpu = gpuMode !== 'off'
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  const gpu = GPU_LABELS[gpuMode]

  return (
    <span
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium rounded-md border cursor-default transition-colors ${
        isGpu && gpu
          ? gpu.color
          : 'text-surface-400 bg-surface-800/50 border-surface-700'
      }`}
    >
      {isGpu ? (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h4v4H6z" /><line x1="14" y1="10" x2="18" y2="10" /><line x1="14" y1="14" x2="18" y2="14" />
          </svg>
          {gpu!.label}
        </>
      ) : (
        <>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 8h12M6 12h8M6 16h10" />
          </svg>
          CPU
        </>
      )}
      {hover && (
        <Tooltip
          anchorRef={ref}
          text={isGpu ? `Hardware encoding enabled (${gpu!.label})` : 'Enable GPU encoding in Settings → Processing'}
        />
      )}
    </span>
  )
}
