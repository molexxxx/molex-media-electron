/**
 * @module visualizations/space
 * @description **Space** - deep-space warp-field visualization.
 *
 * Features nebula clouds, perspective-projected stars with warp streaks,
 * comets with gradient trails, a central black-hole vortex, an orbiting
 * debris field of frequency-reactive particles, an accretion waveform
 * ring, and bass shockwaves. The scene rotates slowly with mid energy
 * and accelerates warp speed with bass.
 */

import type { AudioFeatures, SpaceState } from './types'

/**
 * Render one frame of the Space visualization.
 *
 * @param ctx   - Canvas 2D context sized to the visualizer viewport.
 * @param freq  - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time  - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W     - Canvas width in CSS pixels.
 * @param H     - Canvas height in CSS pixels.
 * @param state - Mutable {@link SpaceState} persisted across frames.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
export function drawSpace(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  state: SpaceState,
  audio: AudioFeatures
): void {
  const t = Date.now() * 0.001
  const cx = W / 2
  const cy = H / 2

  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const high = audio.treble
  const overall = audio.overall
  const minDim = Math.min(W, H)

  state.warpSpeed += (bass * 0.04 + 0.002 + audio.beat * 0.03 - state.warpSpeed) * 0.08
  state.rotation += 0.0008 + mid * 0.002 + bass * 0.001

  ctx.fillStyle = `rgba(2, 1, 8, ${0.08 + (1 - overall) * 0.06})`
  ctx.fillRect(0, 0, W, H)

  ctx.save()
  ctx.translate(cx, cy)

  // -- Nebula clouds --
  for (const n of state.nebulae) {
    n.phase += 0.002 + overall * 0.006
    const nx = n.x * W * 0.5 + Math.sin(n.phase) * (12 + mid * 15)
    const ny = n.y * H * 0.5 + Math.cos(n.phase * 0.7) * (10 + bass * 12)
    const r = n.radius * minDim * (0.7 + bass * 0.8 + overall * 0.3)
    const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, r)
    const hue = (n.hue + t * 3) % 360
    grad.addColorStop(0, `hsla(${hue}, 70%, 40%, ${0.04 + overall * 0.08 + bass * 0.05})`)
    grad.addColorStop(0.5, `hsla(${hue}, 50%, 25%, ${0.02 + bass * 0.04})`)
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.fillRect(nx - r, ny - r, r * 2, r * 2)
  }

  // -- Stars (warp field) --
  const cosR = Math.cos(state.rotation)
  const sinR = Math.sin(state.rotation)
  for (const star of state.stars) {
    star.z -= state.warpSpeed + star.speed * (0.4 + bass * 1.0 + overall * 0.5)
    if (star.z <= 0.001) {
      star.x = (Math.random() - 0.5) * 2
      star.y = (Math.random() - 0.5) * 2
      star.z = 1
      star.brightness = Math.random()
    }

    const px = star.x / star.z
    const py = star.y / star.z
    const rx = px * cosR - py * sinR
    const ry = px * sinR + py * cosR
    const sx = rx * W * 0.5
    const sy = ry * H * 0.5

    if (Math.abs(sx) > cx || Math.abs(sy) > cy) {
      star.z = 0
      continue
    }

    const size = (1 - star.z) * 2.5 * (1 + high * 0.6)
    const alpha = (1 - star.z) * star.brightness * (0.3 + overall * 0.4)
    const streak = state.warpSpeed > 0.005 ? (1 - star.z) * state.warpSpeed * 60 : 0

    if (streak > 2) {
      const angle = Math.atan2(sy, sx)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx - Math.cos(angle) * streak, sy - Math.sin(angle) * streak)
      ctx.strokeStyle = `hsla(${star.hue}, 60%, 80%, ${alpha * 0.7})`
      ctx.lineWidth = size * 0.4
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(0.4, size), 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${star.hue}, 50%, 88%, ${alpha})`
    ctx.fill()

    if (high > 0.2 && star.brightness > 0.7) {
      ctx.beginPath()
      ctx.arc(sx, sy, size * 2, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${star.hue}, 70%, 80%, ${alpha * 0.08})`
      ctx.fill()
    }
  }

  // -- Comets --
  for (const comet of state.comets) {
    comet.life -= 0.003 + overall * 0.003
    if (comet.life <= 0 || Math.abs(comet.x) > 1.5 || Math.abs(comet.y) > 1.5) {
      const side = Math.floor(Math.random() * 4)
      comet.x = side < 2 ? (side === 0 ? -1.2 : 1.2) : (Math.random() - 0.5) * 2
      comet.y = side >= 2 ? (side === 2 ? -1.2 : 1.2) : (Math.random() - 0.5) * 2
      comet.vx = (Math.random() - 0.5) * (0.02 + bass * 0.02)
      comet.vy = (Math.random() - 0.5) * (0.02 + bass * 0.02)
      comet.life = 1
      comet.hue = 180 + Math.random() * 120
      comet.trail = []
    }

    const cometSpeed = 0.4 + bass * 1.5 + mid * 0.8 + overall * 0.5
    comet.x += comet.vx * cometSpeed
    comet.y += comet.vy * cometSpeed
    const csx = comet.x * W * 0.5
    const csy = comet.y * H * 0.5

    comet.trail.push({ x: csx, y: csy })
    if (comet.trail.length > 30 + Math.floor(bass * 20)) comet.trail.shift()

    if (comet.trail.length > 2) {
      ctx.beginPath()
      ctx.moveTo(comet.trail[0].x, comet.trail[0].y)
      for (let i = 1; i < comet.trail.length; i++) {
        ctx.lineTo(comet.trail[i].x, comet.trail[i].y)
      }
      const tGrad = ctx.createLinearGradient(
        comet.trail[0].x, comet.trail[0].y,
        comet.trail[comet.trail.length - 1].x, comet.trail[comet.trail.length - 1].y
      )
      tGrad.addColorStop(0, 'transparent')
      tGrad.addColorStop(0.6, `hsla(${comet.hue}, 80%, 55%, ${comet.life * overall * 0.3})`)
      tGrad.addColorStop(1, `hsla(${comet.hue}, 90%, 70%, ${comet.life * (0.4 + overall * 0.4)})`)
      ctx.strokeStyle = tGrad
      ctx.lineWidth = 1.5 + mid * 3 + bass * 2
      ctx.stroke()
    }

    const headSize = 2 + bass * 4 + mid * 2
    ctx.beginPath()
    ctx.arc(csx, csy, headSize, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${comet.hue}, 90%, 85%, ${comet.life * (0.6 + overall * 0.3)})`
    ctx.shadowColor = `hsla(${comet.hue}, 100%, 70%, ${0.3 + bass * 0.3})`
    ctx.shadowBlur = 8 + bass * 12
    ctx.fill()
    ctx.shadowBlur = 0
  }

  // -- Central black hole / vortex --
  const bhSize = 10 + bass * 12 + overall * 6
  const bhGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, bhSize * 2.5)
  bhGrad.addColorStop(0, 'rgba(0, 0, 0, 0.95)')
  bhGrad.addColorStop(0.15, `hsla(270, 80%, 20%, ${0.25 + bass * 0.4})`)
  bhGrad.addColorStop(0.4, `hsla(230, 90%, 35%, ${0.12 + overall * 0.2})`)
  bhGrad.addColorStop(0.7, `hsla(200, 70%, 30%, ${0.05 + mid * 0.1})`)
  bhGrad.addColorStop(1, 'transparent')
  ctx.beginPath()
  ctx.arc(0, 0, bhSize * 2.5, 0, Math.PI * 2)
  ctx.fillStyle = bhGrad
  ctx.fill()

  // -- Orbiting debris field - frequency-reactive particle streams --
  for (const d of state.debris) {
    d.angle += d.speed * (1 + bass * 4 + audio.beat * 3 + mid * 1.5)

    const breathe = Math.sin(d.angle * 0.3 + t * 0.5) * 0.15
    const r = d.dist * minDim * 0.5 * (1 + breathe + bass * 0.2 - high * 0.05)

    const tilt = d.angle * 0.02 + d.dist * 3
    const dx = Math.cos(d.angle) * r
    const dy = Math.sin(d.angle) * r * (0.3 + d.dist * 0.3)
    const cosTilt = Math.cos(tilt)
    const sinTilt = Math.sin(tilt)
    const debrisX = dx * cosTilt - dy * sinTilt
    const debrisY = dx * sinTilt + dy * cosTilt

    const fi = Math.floor(((d.angle / (Math.PI * 2)) % 1) * freq.length * 0.5)
    const energy = (freq[fi] || 0) / 255

    const pSize = d.size * (0.8 + energy * 1.5 + audio.beat * 0.8)
    const pAlpha = d.brightness * (0.2 + energy * 0.4 + overall * 0.2)

    ctx.beginPath()
    ctx.arc(debrisX, debrisY, pSize, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${d.hue + energy * 30}, 70%, ${55 + energy * 25}%, ${pAlpha})`
    ctx.fill()

    if (energy > 0.5) {
      ctx.beginPath()
      ctx.arc(debrisX, debrisY, pSize * 3, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${d.hue}, 80%, 50%, ${energy * 0.04})`
      ctx.fill()
    }
  }

  // Accretion waveform ring
  const accR = bhSize * 1.5
  ctx.beginPath()
  for (let i = 0; i < time.length; i += 3) {
    const angle = (i / time.length) * Math.PI * 2 + state.rotation * 2
    const v = (time[i] - 128) / 128
    const r = accR + v * (10 + overall * 18)
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r * 0.35
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = `hsla(210, 90%, 70%, ${0.25 + overall * 0.35})`
  ctx.lineWidth = 1 + overall * 1.5
  ctx.shadowColor = `hsla(210, 100%, 60%, ${0.2 + bass * 0.3})`
  ctx.shadowBlur = 6 + bass * 12
  ctx.stroke()
  ctx.shadowBlur = 0

  // Bass shockwave
  if (audio.beat > 0.4) {
    const shockR = bhSize * (2 + audio.beat * 3)
    ctx.beginPath()
    ctx.arc(0, 0, shockR, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(260, 80%, 60%, ${audio.beat * 0.2})`
    ctx.lineWidth = 1.5 + audio.beat * 2
    ctx.stroke()
  }

  ctx.restore()
}
