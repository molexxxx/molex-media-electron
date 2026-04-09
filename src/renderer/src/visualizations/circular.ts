/**
 * @module visualizations/circular
 * @description **Gravity** - gravitational lens visualization.
 *
 * Concentric frequency-warped rings surround a glowing singularity core.
 * Orbiting particle streams follow elliptical paths with eccentricity
 * driven by bass energy, while energy filaments (curved spokes) connect
 * high-energy regions. A time-domain gravitational wave ripple ring and
 * bass shockwaves complete the scene.
 */

import type { AudioFeatures } from './types'

/**
 * Render one frame of the Gravity visualization.
 *
 * @param ctx  - Canvas 2D context sized to the visualizer viewport.
 * @param freq - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W    - Canvas width in CSS pixels.
 * @param H    - Canvas height in CSS pixels.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
export function drawCircular(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  audio: AudioFeatures
): void {
  const cx = W / 2
  const cy = H / 2
  const loudness = audio.overall
  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const high = audio.treble
  const t = Date.now() * 0.001
  const minDim = Math.min(W, H)

  if (loudness < 0.01) return

  // Gravitational lens distortion field - concentric rings that warp with frequency
  const ringCount = 8
  for (let r = 0; r < ringCount; r++) {
    const baseRadius = minDim * (0.06 + r * 0.045) * (1 + bass * 0.15)
    const points = 120
    const angleStep = (Math.PI * 2) / points

    ctx.beginPath()
    for (let i = 0; i < points; i++) {
      const angle = i * angleStep + t * (0.15 - r * 0.015) + r * 0.3
      const fi = Math.floor(((i + r * 15) % points / points) * freq.length * 0.4)
      const v = (freq[fi] || 0) / 255
      const warp = v * minDim * 0.02 * (1 + bass * 0.8) * (1 - r / ringCount * 0.5)
      const radius = baseRadius + warp
      const x = cx + Math.cos(angle) * radius
      const y = cy + Math.sin(angle) * radius
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()

    const ringProgress = r / ringCount
    const hue = 240 + ringProgress * 40 + bass * 20 + high * 10
    const alpha = (0.08 + loudness * 0.15 - ringProgress * 0.02) * (1 + audio.beat * 0.3)
    ctx.strokeStyle = `hsla(${hue}, 70%, ${50 + ringProgress * 20}%, ${alpha})`
    ctx.lineWidth = 1 + (1 - ringProgress) * loudness * 1.5
    ctx.stroke()
  }

  // Particle streams - orbiting fragments pulled by gravity
  const particleCount = 60
  for (let i = 0; i < particleCount; i++) {
    const seed = i * 137.508
    const orbitR = minDim * (0.08 + (i / particleCount) * 0.35) * (1 + bass * 0.1)
    const speed = 0.3 + (1 - i / particleCount) * 0.8
    const angle = seed + t * speed + Math.sin(t * 0.3 + i) * mid * 0.5
    const fi = Math.floor((i / particleCount) * freq.length * 0.5)
    const energy = (freq[fi] || 0) / 255

    const eccentricity = 0.15 + bass * 0.2
    const pR = orbitR * (1 - eccentricity * Math.cos(angle * 2 + t * 0.2))
    const px = cx + Math.cos(angle) * pR
    const py = cy + Math.sin(angle) * pR

    const pSize = 1 + energy * 3 + audio.beat * 1.5
    const pAlpha = 0.15 + energy * 0.5 + audio.beat * 0.2
    const hue = 220 + energy * 60

    ctx.beginPath()
    ctx.arc(px, py, pSize, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${hue}, 80%, 70%, ${pAlpha})`
    ctx.fill()

    if (energy > 0.4) {
      ctx.beginPath()
      ctx.arc(px, py, pSize * 3, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${energy * 0.06})`
      ctx.fill()
    }
  }

  // Energy filaments - connecting nearby high-energy particles
  const filamentAngles = 12
  for (let i = 0; i < filamentAngles; i++) {
    const baseAngle = (i / filamentAngles) * Math.PI * 2 + t * 0.1
    const fi = Math.floor((i / filamentAngles) * freq.length * 0.3)
    const energy = (freq[fi] || 0) / 255
    if (energy < 0.3) continue

    const innerR = minDim * 0.06
    const outerR = minDim * (0.15 + energy * 0.2 + bass * 0.08)
    const wobble = Math.sin(t * 2 + i * 1.5) * mid * 8

    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(baseAngle) * innerR, cy + Math.sin(baseAngle) * innerR)
    const cpR = (innerR + outerR) * 0.5
    const cpAngle = baseAngle + 0.15 * (i % 2 === 0 ? 1 : -1)
    ctx.quadraticCurveTo(
      cx + Math.cos(cpAngle) * cpR + wobble,
      cy + Math.sin(cpAngle) * cpR + wobble,
      cx + Math.cos(baseAngle) * outerR,
      cy + Math.sin(baseAngle) * outerR
    )
    ctx.strokeStyle = `hsla(${260 + energy * 30}, 80%, 60%, ${energy * 0.2 + audio.beat * 0.1})`
    ctx.lineWidth = 0.5 + energy * 1.5
    ctx.stroke()
  }

  // Time-domain gravitational wave - ripple ring
  const waveR = minDim * (0.12 + loudness * 0.08)
  ctx.beginPath()
  const wavePoints = 90
  for (let i = 0; i < wavePoints; i++) {
    const angle = (i / wavePoints) * Math.PI * 2
    const ti = Math.floor((i / wavePoints) * time.length)
    const v = (time[ti] - 128) / 128
    const pR = waveR + v * minDim * 0.03 * (1 + loudness * 0.8)
    const x = cx + Math.cos(angle) * pR
    const y = cy + Math.sin(angle) * pR
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.strokeStyle = `hsla(200, 90%, 70%, ${0.15 + loudness * 0.2})`
  ctx.lineWidth = 1 + loudness * 0.8
  ctx.shadowColor = `hsla(200, 90%, 60%, ${0.1 + loudness * 0.15})`
  ctx.shadowBlur = 3 + loudness * 5
  ctx.stroke()
  ctx.shadowBlur = 0

  // Central singularity
  const coreR = 4 + bass * 8 + audio.beat * 5
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3)
  coreGrad.addColorStop(0, `hsla(270, 90%, 80%, ${0.6 + bass * 0.3})`)
  coreGrad.addColorStop(0.3, `hsla(250, 80%, 50%, ${0.3 + loudness * 0.3})`)
  coreGrad.addColorStop(0.6, `hsla(230, 70%, 30%, ${0.1 + loudness * 0.1})`)
  coreGrad.addColorStop(1, 'transparent')
  ctx.beginPath()
  ctx.arc(cx, cy, coreR * 3, 0, Math.PI * 2)
  ctx.fillStyle = coreGrad
  ctx.fill()

  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.fillStyle = `hsla(270, 95%, 90%, ${0.5 + audio.beat * 0.3})`
  ctx.shadowColor = `hsla(270, 100%, 70%, ${0.4 + bass * 0.4})`
  ctx.shadowBlur = 8 + bass * 15 + audio.beat * 10
  ctx.fill()
  ctx.shadowBlur = 0

  // Bass shockwaves
  if (audio.beat > 0.3) {
    const shock1 = minDim * (0.15 + audio.beat * 0.2)
    ctx.beginPath()
    ctx.arc(cx, cy, shock1, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(260, 80%, 65%, ${audio.beat * 0.15})`
    ctx.lineWidth = 1 + audio.beat * 1.5
    ctx.stroke()

    if (audio.beat > 0.6) {
      ctx.beginPath()
      ctx.arc(cx, cy, shock1 * 1.4, 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(240, 70%, 55%, ${audio.beat * 0.08})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
}
