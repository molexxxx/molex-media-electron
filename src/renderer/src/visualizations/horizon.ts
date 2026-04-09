/**
 * @module visualizations/horizon
 * @description **Horizon** - retro terrain scanner visualization.
 *
 * A synthwave-inspired landscape with layered mountain ridges driven by
 * frequency data, a perspective grid that scrolls with bass energy,
 * twinkling stars, a horizon glow, aurora curtains between layers,
 * fog/mist depth, snow-capped peaks, and beat-triggered ridge pulses.
 */

import type { AudioFeatures } from './types'

/**
 * Render one frame of the Horizon visualization.
 *
 * @param ctx  - Canvas 2D context sized to the visualizer viewport.
 * @param freq - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W    - Canvas width in CSS pixels.
 * @param H    - Canvas height in CSS pixels.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
export function drawHorizon(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  audio: AudioFeatures
): void {
  const t = Date.now() * 0.001
  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const high = audio.treble
  const loudness = audio.overall
  const vanishY = H * 0.35

  // Sky gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, vanishY)
  skyGrad.addColorStop(0, `hsla(240, 40%, ${4 + loudness * 3}%, 1)`)
  skyGrad.addColorStop(0.6, `hsla(260, 50%, ${6 + bass * 5}%, 1)`)
  skyGrad.addColorStop(1, `hsla(270, 60%, ${10 + loudness * 8}%, 1)`)
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, vanishY + 1)

  // Stars in sky
  for (let i = 0; i < 60; i++) {
    const seed = i * 97.31
    const sx = ((seed * 0.618) % 1) * W
    const sy = ((seed * 0.381) % 1) * vanishY * 0.85
    const twinkle = Math.sin(t * (1.5 + (i % 7) * 0.3) + seed) * 0.5 + 0.5
    const alpha = 0.15 + twinkle * 0.25 + high * 0.15
    const size = 0.5 + twinkle * 0.8
    ctx.beginPath()
    ctx.arc(sx, sy, size, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(200, 210, 255, ${alpha})`
    ctx.fill()
  }

  // Aurora curtains - undulating colour bands in the sky driven by mid/high
  for (let a = 0; a < 3; a++) {
    const auroraY = vanishY * (0.15 + a * 0.2)
    const auroraH = vanishY * 0.18
    const hue = 140 + a * 60 + Math.sin(t * 0.3 + a) * 20
    ctx.beginPath()
    ctx.moveTo(0, auroraY + auroraH)
    for (let x = 0; x <= W; x += 4) {
      const wave = Math.sin(x * 0.008 + t * (0.4 + a * 0.15) + a * 2) * auroraH * 0.5 +
                   Math.sin(x * 0.015 + t * 0.2 + a * 5) * auroraH * 0.25
      ctx.lineTo(x, auroraY + wave)
    }
    ctx.lineTo(W, auroraY + auroraH)
    ctx.closePath()
    const auroraAlpha = (0.02 + mid * 0.04 + high * 0.03) * (0.6 + Math.sin(t * 0.5 + a * 1.5) * 0.4)
    ctx.fillStyle = `hsla(${hue}, 80%, 55%, ${auroraAlpha})`
    ctx.fill()
  }

  // Horizon glow - bass reactive
  const glowGrad = ctx.createRadialGradient(W / 2, vanishY, 0, W / 2, vanishY, W * 0.5)
  const glowHue = 260 + bass * 30 + Math.sin(t * 0.5) * 10
  glowGrad.addColorStop(0, `hsla(${glowHue}, 90%, 50%, ${0.15 + bass * 0.2 + audio.beat * 0.15})`)
  glowGrad.addColorStop(0.3, `hsla(${glowHue}, 70%, 35%, ${0.06 + loudness * 0.08})`)
  glowGrad.addColorStop(1, 'transparent')
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, vanishY * 0.3, W, vanishY * 1.4)

  // Terrain layers - each mountain ridge mapped to a distinct audio band.
  // Back-to-front: treble → highMid → mid → lowMid → bass → sub+bass.
  // Front layers have stronger reactivity and amplitude scaling.
  const bandMap: { band: number; gain: number; hueShift: number; freqLo: number; freqHi: number }[] = [
    { band: audio.treble,  gain: 0.35, hueShift: 0,  freqLo: 0.60, freqHi: 0.80 },
    { band: audio.highMid, gain: 0.50, hueShift: 4,  freqLo: 0.45, freqHi: 0.65 },
    { band: audio.mid,     gain: 0.70, hueShift: 8,  freqLo: 0.30, freqHi: 0.50 },
    { band: audio.lowMid,  gain: 0.90, hueShift: 12, freqLo: 0.18, freqHi: 0.38 },
    { band: audio.bass,    gain: 1.15, hueShift: 18, freqLo: 0.08, freqHi: 0.22 },
    { band: audio.sub + audio.bass * 0.5, gain: 1.40, hueShift: 24, freqLo: 0.0, freqHi: 0.12 },
  ]
  const layers = bandMap.length

  // Pre-compute ridge paths for reuse (fill, glow, snow)
  const ridgePaths: { x: number; y: number }[][] = []

  for (let layer = 0; layer < layers; layer++) {
    const { band, gain, hueShift, freqLo, freqHi } = bandMap[layer]
    const depth = layer / layers
    const yBase = vanishY + (H - vanishY) * (depth * 0.7 + 0.05)
    const segments = 80
    const segW = W / segments

    const freqStart = Math.floor(freqLo * freq.length)
    const freqRange = Math.max(1, Math.floor((freqHi - freqLo) * freq.length))

    // Per-layer reactivity
    const react = 0.4 + band * gain + loudness * 0.3

    // Beat pulse ripple - energy wave that travels along the ridge on beats
    const beatPhase = (t * 3.0 + layer * 0.4) % (Math.PI * 2)
    const beatBoost = audio.isBeat ? 0.25 : 0

    // Build path points
    const points: { x: number; y: number }[] = []
    for (let i = 0; i <= segments; i++) {
      const x = i * segW
      const fi = freqStart + Math.floor((i / segments) * freqRange)
      const v = (freq[Math.min(fi, freq.length - 1)] || 0) / 255

      const noiseVal = Math.sin(i * 0.3 + layer * 2 + t * (0.2 + layer * 0.05)) * 0.3 +
                       Math.sin(i * 0.7 + layer * 5 + t * 0.1) * 0.15 +
                       Math.sin(i * 1.3 + layer * 8) * 0.1

      // Ripple: a travelling sine wave across the ridge, strongest on beat
      const ripple = Math.sin(i * 0.15 - beatPhase) * beatBoost * (H - vanishY) * 0.08

      const terrainH = (v * 0.6 + noiseVal * 0.4 + 0.1) *
                        (H - vanishY) * (0.1 + depth * 0.25) * react + ripple

      points.push({ x, y: yBase - terrainH })
    }
    ridgePaths.push(points)

    // Fill mountain body
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (const p of points) ctx.lineTo(p.x, p.y)
    ctx.lineTo(W, H)
    ctx.closePath()

    const layerHue = 250 + hueShift + band * 15
    const layerLight = 6 + depth * 8 + band * 6
    const layerAlpha = 0.5 + depth * 0.4
    ctx.fillStyle = `hsla(${layerHue}, ${40 + depth * 20}%, ${layerLight}%, ${layerAlpha})`
    ctx.fill()

    // Inner vertical streaks - face detail that reacts to the band
    if (depth > 0.3) {
      const streakCount = 12 + Math.floor(depth * 10)
      for (let s = 0; s < streakCount; s++) {
        const si = Math.floor((s / streakCount) * segments)
        const p = points[Math.min(si, points.length - 1)]
        const streakH = (yBase - p.y) * (0.3 + band * 0.4)
        if (streakH < 3) continue
        const sx = p.x + Math.sin(s * 7.7 + layer * 3) * segW * 0.3
        ctx.beginPath()
        ctx.moveTo(sx, p.y + 2)
        ctx.lineTo(sx, p.y + streakH)
        ctx.strokeStyle = `hsla(${layerHue + 10}, 50%, ${layerLight + 10}%, ${0.04 + band * 0.06})`
        ctx.lineWidth = 0.6 + depth * 0.8
        ctx.stroke()
      }
    }

    // Ridge line glow on closer layers
    if (depth > 0.3) {
      ctx.beginPath()
      for (let i = 0; i < points.length; i++) {
        i === 0 ? ctx.moveTo(points[i].x, points[i].y) : ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = `hsla(${layerHue + 20}, 70%, ${35 + band * 25}%, ${0.1 + depth * 0.15 + band * 0.15})`
      ctx.lineWidth = 0.8 + (depth - 0.3) * 2
      ctx.stroke()
    }

    // Inter-layer fog/mist - semi-transparent gradient between layers
    if (layer > 0 && layer < layers - 1) {
      const fogY = yBase - (H - vanishY) * depth * 0.05
      const fogH = (H - vanishY) * 0.06
      const fogGrad = ctx.createLinearGradient(0, fogY - fogH, 0, fogY + fogH)
      fogGrad.addColorStop(0, 'transparent')
      fogGrad.addColorStop(0.5, `hsla(${layerHue + 30}, 40%, 40%, ${0.03 + loudness * 0.03})`)
      fogGrad.addColorStop(1, 'transparent')
      ctx.fillStyle = fogGrad
      ctx.fillRect(0, fogY - fogH, W, fogH * 2)
    }
  }

  // Grid lines on the ground plane - retro perspective grid
  const gridRows = 16
  const gridCols = 20
  const groundY = vanishY
  const scrollOffset = (t * 40 * (0.5 + bass * 1.5)) % (H / gridRows * 2)

  ctx.globalAlpha = 0.15 + loudness * 0.15
  for (let i = 0; i < gridRows; i++) {
    const progress = (i / gridRows + scrollOffset / H) % 1
    const y = groundY + progress * progress * (H - groundY) * 1.1
    if (y > H) continue

    const lineAlpha = (1 - progress) * 0.3 + progress * 0.8
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.strokeStyle = `hsla(270, 70%, 50%, ${lineAlpha * (0.15 + loudness * 0.1)})`
    ctx.lineWidth = 0.5 + (1 - progress) * 0.5
    ctx.stroke()
  }

  for (let i = -gridCols / 2; i <= gridCols / 2; i++) {
    const x = W / 2 + i * (W / gridCols)
    ctx.beginPath()
    ctx.moveTo(W / 2, groundY)
    ctx.lineTo(x, H + 10)
    ctx.strokeStyle = `hsla(260, 60%, 45%, ${0.1 + loudness * 0.06})`
    ctx.lineWidth = 0.5
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Waveform overlay near the horizon
  const waveY = vanishY + 4
  ctx.beginPath()
  for (let i = 0; i < time.length; i++) {
    const x = (i / time.length) * W
    const v = (time[i] - 128) / 128
    const y = waveY + v * 15 * (0.5 + loudness * 1.5)
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.strokeStyle = `hsla(280, 90%, 70%, ${0.2 + loudness * 0.3})`
  ctx.lineWidth = 1 + loudness
  ctx.shadowColor = `hsla(280, 100%, 60%, ${0.2 + bass * 0.3})`
  ctx.shadowBlur = 4 + bass * 8
  ctx.stroke()
  ctx.shadowBlur = 0
}
