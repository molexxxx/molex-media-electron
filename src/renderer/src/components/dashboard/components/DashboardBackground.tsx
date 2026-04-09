/**
 * @module components/AmbientBackground
 * @description Animated canvas background - purple ambient glows with small drifting orbs.
 * Memoized and mounted once at root level so it never re-renders across page changes.
 */

import React, { useEffect, useRef, useCallback } from 'react'

interface Orb {
  x: number; y: number; r: number
  dx: number; dy: number
  baseA: number; pulseSpd: number; phase: number
}

function createOrbs(w: number, h: number): Orb[] {
  const orbs: Orb[] = []
  for (let i = 0; i < 14; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = 0.012 + Math.random() * 0.05
    orbs.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 15 + Math.random() * 40,
      dx: Math.cos(angle) * speed,
      dy: Math.sin(angle) * speed,
      baseA: 0.02 + Math.random() * 0.03,
      pulseSpd: 0.08 + Math.random() * 0.25,
      phase: Math.random() * Math.PI * 2
    })
  }
  return orbs
}

export const AmbientBackground = React.memo(function AmbientBackground(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const orbsRef = useRef<Orb[]>([])
  const sizeRef = useRef({ w: 0, h: 0 })

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      rafRef.current = requestAnimationFrame(draw)
      return
    }

    const w = rect.width
    const h = rect.height

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    if (sizeRef.current.w !== w || sizeRef.current.h !== h) {
      sizeRef.current = { w, h }
      orbsRef.current = createOrbs(w, h)
    }

    const t = performance.now() / 1000
    ctx.clearRect(0, 0, w, h)

    // Top-center purple glow
    const topG = ctx.createRadialGradient(w * 0.45, -h * 0.05, 0, w * 0.45, -h * 0.05, Math.max(w, h) * 0.85)
    topG.addColorStop(0, 'rgba(124, 58, 237, 0.16)')
    topG.addColorStop(0.2, 'rgba(124, 58, 237, 0.09)')
    topG.addColorStop(0.5, 'rgba(124, 58, 237, 0.025)')
    topG.addColorStop(1, 'rgba(124, 58, 237, 0)')
    ctx.fillStyle = topG
    ctx.fillRect(0, 0, w, h)

    // Bottom-right glow
    const brG = ctx.createRadialGradient(w * 1.0, h * 1.05, 0, w * 1.0, h * 1.05, Math.max(w, h) * 0.7)
    brG.addColorStop(0, 'rgba(139, 72, 255, 0.09)')
    brG.addColorStop(0.25, 'rgba(124, 58, 237, 0.04)')
    brG.addColorStop(0.55, 'rgba(124, 58, 237, 0.01)')
    brG.addColorStop(1, 'rgba(124, 58, 237, 0)')
    ctx.fillStyle = brG
    ctx.fillRect(0, 0, w, h)

    // Bottom-left accent
    const blG = ctx.createRadialGradient(-w * 0.05, h * 1.0, 0, -w * 0.05, h * 1.0, Math.max(w, h) * 0.5)
    blG.addColorStop(0, 'rgba(124, 58, 237, 0.06)')
    blG.addColorStop(0.3, 'rgba(124, 58, 237, 0.02)')
    blG.addColorStop(1, 'rgba(124, 58, 237, 0)')
    ctx.fillStyle = blG
    ctx.fillRect(0, 0, w, h)

    // Small floating orbs
    for (const orb of orbsRef.current) {
      orb.x += orb.dx
      orb.y += orb.dy
      if (orb.x < -orb.r * 2) orb.x = w + orb.r * 2
      if (orb.x > w + orb.r * 2) orb.x = -orb.r * 2
      if (orb.y < -orb.r * 2) orb.y = h + orb.r * 2
      if (orb.y > h + orb.r * 2) orb.y = -orb.r * 2

      const pulse = 0.5 + 0.5 * Math.sin(t * orb.pulseSpd + orb.phase)
      const a = orb.baseA * pulse
      if (a < 0.004) continue

      ctx.globalAlpha = a
      const g = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, orb.r)
      g.addColorStop(0, 'rgba(160, 120, 255, 1)')
      g.addColorStop(0.5, 'rgba(130, 80, 240, 0.3)')
      g.addColorStop(1, 'rgba(124, 58, 237, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(orb.x, orb.y, orb.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
    />
  )
})
