/**
 * @module components/dashboard/ToolCard
 * @description Animated canvas-backed navigation card used on the dashboard landing page.
 */

import React, { useEffect, useRef, useCallback } from 'react'

type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number, rgb: string) => void

const accentColors: Record<string, { border: string; bg: string; text: string; hoverText: string; hoverBorder: string; glow: string; rgb: string }> = {
  blue:   { border: 'border-blue-500/20',   bg: 'bg-blue-500/10',   text: 'text-blue-400',   hoverText: 'group-hover:text-blue-300',   hoverBorder: 'hover:border-blue-500/30',   glow: 'rgba(59,130,246,0.08)', rgb: '59,130,246' },
  accent: { border: 'border-accent-500/20', bg: 'bg-accent-500/10', text: 'text-accent-400', hoverText: 'group-hover:text-accent-300', hoverBorder: 'hover:border-accent-500/30', glow: 'rgba(139,92,246,0.08)', rgb: '139,92,246' },
}

export function ToolCard({ onClick, accentClass, title, desc, icon, drawBg }: {
  onClick: () => void
  accentClass: string
  title: string
  desc: string
  icon: React.ReactNode
  drawBg: DrawFn
}): React.JSX.Element {
  const c = accentColors[accentClass] || accentColors.blue
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  const animate = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    // Skip rendering when hidden (parent display:none) to avoid corrupting canvas state
    if (rect.width === 0 || rect.height === 0) {
      rafRef.current = requestAnimationFrame(animate)
      return
    }
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
    }
    ctx.clearRect(0, 0, rect.width, rect.height)
    drawBg(ctx, rect.width, rect.height, performance.now() / 1000, c.rgb)
    rafRef.current = requestAnimationFrame(animate)
  }, [drawBg, c.rgb])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [animate])

  return (
    <button
      onClick={onClick}
      className={`rounded-xl text-left group relative overflow-hidden flex flex-col h-full border border-white/[0.06] ${c.hoverBorder} transition-all duration-200`}
      style={{ background: 'rgba(30, 37, 56, 0.4)', backdropFilter: 'blur(12px)' }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-[1]" />
      <div className="relative z-10 flex items-end justify-between flex-1 p-5">
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

/** Editor background: animated timeline waveform with playhead */
export const drawEditorBg: DrawFn = (ctx, w, h, t, rgb) => {
  // Subtle gradient wash
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, `rgba(${rgb},0.03)`)
  grad.addColorStop(0.5, `rgba(${rgb},0.0)`)
  grad.addColorStop(1, `rgba(${rgb},0.02)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  const segments = 80
  const baseY = h * 0.45
  const amp = h * 0.22

  // Main waveform
  ctx.beginPath()
  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * w
    const y = baseY + Math.sin(i * 0.4 + t * 0.8) * amp * Math.sin(i * 0.15 + t * 0.3) * 0.7
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = `rgba(${rgb},0.15)`
  ctx.lineWidth = 2
  ctx.stroke()

  // Mirror waveform
  ctx.beginPath()
  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * w
    const wave = Math.sin(i * 0.4 + t * 0.8) * amp * Math.sin(i * 0.15 + t * 0.3) * 0.7
    if (i === 0) ctx.moveTo(x, 2 * baseY - (baseY + wave))
    else ctx.lineTo(x, 2 * baseY - (baseY + wave))
  }
  ctx.strokeStyle = `rgba(${rgb},0.08)`
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Fill between waveforms
  ctx.beginPath()
  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * w
    const y = baseY + Math.sin(i * 0.4 + t * 0.8) * amp * Math.sin(i * 0.15 + t * 0.3) * 0.7
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  for (let i = segments; i >= 0; i--) {
    const x = (i / segments) * w
    const wave = Math.sin(i * 0.4 + t * 0.8) * amp * Math.sin(i * 0.15 + t * 0.3) * 0.7
    ctx.lineTo(x, 2 * baseY - (baseY + wave))
  }
  ctx.closePath()
  ctx.fillStyle = `rgba(${rgb},0.03)`
  ctx.fill()

  // Timeline grid lines
  for (let i = 0; i < 16; i++) {
    const x = (i / 16) * w + ((t * 10) % (w / 16))
    if (x > w) continue
    ctx.fillStyle = `rgba(${rgb},0.06)`
    ctx.fillRect(x, baseY - amp, 1, amp * 2)
  }

  // Playhead
  const playX = ((t * 20) % w)
  ctx.beginPath()
  ctx.moveTo(playX, h * 0.1)
  ctx.lineTo(playX, h * 0.8)
  ctx.strokeStyle = `rgba(${rgb},0.25)`
  ctx.lineWidth = 2
  ctx.stroke()

  // Playhead triangle
  ctx.beginPath()
  ctx.moveTo(playX - 6, h * 0.1)
  ctx.lineTo(playX + 6, h * 0.1)
  ctx.lineTo(playX, h * 0.1 + 8)
  ctx.closePath()
  ctx.fillStyle = `rgba(${rgb},0.3)`
  ctx.fill()

  // Glow around playhead
  const glowGrad = ctx.createRadialGradient(playX, baseY, 0, playX, baseY, amp)
  glowGrad.addColorStop(0, `rgba(${rgb},0.06)`)
  glowGrad.addColorStop(1, `rgba(${rgb},0.0)`)
  ctx.fillStyle = glowGrad
  ctx.fillRect(playX - amp, baseY - amp, amp * 2, amp * 2)
}

/** Player background: animated equalizer bars with particles */
export const drawPlayerBg: DrawFn = (ctx, w, h, t, rgb) => {
  // Subtle gradient wash
  const grad = ctx.createLinearGradient(0, h, w, 0)
  grad.addColorStop(0, `rgba(${rgb},0.04)`)
  grad.addColorStop(0.5, `rgba(${rgb},0.0)`)
  grad.addColorStop(1, `rgba(${rgb},0.02)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  const barCount = 32
  const gap = 3
  const barWidth = (w - gap * (barCount + 1)) / barCount
  const maxH = h * 0.6
  const baseY = h * 0.8

  for (let i = 0; i < barCount; i++) {
    const x = gap + i * (barWidth + gap)
    const phase1 = Math.sin(t * 1.4 + i * 0.5) * 0.5 + 0.5
    const phase2 = Math.sin(t * 0.8 + i * 0.8 + 1.5) * 0.5 + 0.5
    const envelope = 0.3 + 0.7 * Math.sin((i / barCount) * Math.PI)
    const barH = maxH * (phase1 * 0.6 + phase2 * 0.4) * envelope

    // Bar gradient
    const barGrad = ctx.createLinearGradient(x, baseY - barH, x, baseY)
    barGrad.addColorStop(0, `rgba(${rgb},0.2)`)
    barGrad.addColorStop(1, `rgba(${rgb},0.06)`)
    ctx.fillStyle = barGrad
    ctx.fillRect(x, baseY - barH, barWidth, barH)

    // Cap highlight on top of each bar
    ctx.fillStyle = `rgba(${rgb},0.3)`
    ctx.fillRect(x, baseY - barH, barWidth, 2)

    // Reflection below
    ctx.fillStyle = `rgba(${rgb},0.03)`
    ctx.fillRect(x, baseY + 3, barWidth, barH * 0.25)
  }

  // Floating particles
  for (let i = 0; i < 8; i++) {
    const cx = w * (0.1 + 0.12 * i) + Math.sin(t * 0.6 + i * 2.3) * 20
    const cy = h * 0.25 + Math.cos(t * 0.9 + i * 1.7) * h * 0.15
    const r = 2.5 + Math.sin(t * 1.2 + i) * 1.5
    const alpha = 0.08 + 0.06 * Math.sin(t + i * 0.8)

    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${rgb},${alpha})`
    ctx.fill()

    // Particle glow
    const pGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4)
    pGrad.addColorStop(0, `rgba(${rgb},0.04)`)
    pGrad.addColorStop(1, `rgba(${rgb},0.0)`)
    ctx.fillStyle = pGrad
    ctx.fillRect(cx - r * 4, cy - r * 4, r * 8, r * 8)
  }

  // Baseline
  ctx.beginPath()
  ctx.moveTo(0, baseY)
  ctx.lineTo(w, baseY)
  ctx.strokeStyle = `rgba(${rgb},0.08)`
  ctx.lineWidth = 1
  ctx.stroke()
}
