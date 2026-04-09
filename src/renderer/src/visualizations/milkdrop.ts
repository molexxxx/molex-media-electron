/**
 * @module visualizations/milkdrop
 * @description **Milkdrop** - Winamp-inspired feedback-loop visualization.
 *
 * Emulates the classic Milkdrop aesthetic with a zoom-and-rotate feedback
 * loop drawn from an off-screen canvas, a morphing waveform scope that
 * cycles through five presets (horizontal, circular, Lissajous, spiral,
 * figure-8), particle bursts on high energy, and a frequency bars ring.
 */

import type { AudioFeatures, MilkdropState } from './types'

/**
 * Render one frame of the Milkdrop visualization.
 *
 * @param ctx   - Canvas 2D context sized to the visualizer viewport.
 * @param freq  - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time  - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W     - Canvas width in CSS pixels.
 * @param H     - Canvas height in CSS pixels.
 * @param state - Mutable {@link MilkdropState} persisted across frames.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
export function drawMilkdrop(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  state: MilkdropState,
  audio: AudioFeatures
): void {
  const t = Date.now() * 0.001
  const cx = W / 2
  const cy = H / 2

  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const overall = audio.overall

  state.morphT += 0.004 + mid * 0.015 + bass * 0.008 + audio.beat * 0.05
  state.rot += 0.0015 + bass * 0.008 + mid * 0.004 + audio.beat * 0.015
  state.zoom = 1.01 + bass * 0.04 + overall * 0.02 + audio.beat * 0.06
  state.hueShift = (state.hueShift + 0.3 + overall * 1.5 + bass * 0.8 + audio.beat * 5) % 360

  // -- Feedback loop (zoom + rotate previous frame) --
  if (!state.feedbackCanvas) {
    state.feedbackCanvas = document.createElement('canvas')
    state.feedbackCtx = state.feedbackCanvas.getContext('2d')
  }
  const fb = state.feedbackCanvas!
  const fbCtx = state.feedbackCtx!
  fb.width = W
  fb.height = H

  fbCtx.drawImage(ctx.canvas, 0, 0, W, H)

  ctx.fillStyle = `rgba(5, 2, 15, ${0.03 + (1 - overall) * 0.03})`
  ctx.fillRect(0, 0, W, H)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(Math.sin(state.rot) * (0.01 + bass * 0.015))
  ctx.scale(state.zoom, state.zoom)
  ctx.translate(-cx, -cy)
  ctx.globalAlpha = 0.92 + overall * 0.06
  ctx.drawImage(fb, 0, 0, W, H)
  ctx.globalAlpha = 1
  ctx.restore()

  // -- Morphing waveform scope --
  const presetIdx = Math.floor(state.morphT / 6) % 5
  ctx.save()
  ctx.translate(cx, cy)

  for (let layer = 0; layer < 3; layer++) {
    const preset = (presetIdx + layer) % 5
    const layerHue = (state.hueShift + layer * 120) % 360
    const alpha = 0.6 - layer * 0.15

    ctx.beginPath()
    const points = 256
    for (let i = 0; i < points; i++) {
      const p = i / points
      const ti = Math.floor(p * time.length)
      const v = (time[ti] - 128) / 128
      const fi = Math.floor(p * 256)
      const fv = (freq[fi] || 0) / 255

      let x = 0, y = 0

      switch (preset) {
        case 0: // Horizontal oscilloscope
          x = (p - 0.5) * W * 0.9
          y = v * cy * (0.6 + bass * 0.6) * (1 + fv * 0.8)
          break
        case 1: // Circular scope
          { const angle = p * Math.PI * 2 + state.rot
          const r = Math.min(W, H) * (0.2 + overall * 0.15) * (1 + v * 0.5)
          x = Math.cos(angle) * r
          y = Math.sin(angle) * r }
          break
        case 2: // Lissajous
          { const lx = Math.sin(p * Math.PI * 4 + t + v * (2 + bass * 3))
          const ly = Math.cos(p * Math.PI * 6 + t * 0.7 + v * (1.5 + mid * 2))
          x = lx * W * (0.3 + overall * 0.15) * (0.5 + fv * 0.8)
          y = ly * H * (0.3 + overall * 0.15) * (0.5 + fv * 0.8) }
          break
        case 3: // Spiral
          { const sAngle = p * Math.PI * (6 + bass * 4) + state.rot * 3
          const sR = p * Math.min(W, H) * (0.35 + overall * 0.15) * (0.5 + v * 0.4)
          x = Math.cos(sAngle) * sR
          y = Math.sin(sAngle) * sR }
          break
        case 4: // Figure-8 / infinity
          { const iAngle = p * Math.PI * 2
          const cr = Math.min(W, H) * (0.2 + overall * 0.12) * (0.7 + v * 0.4)
          x = Math.sin(iAngle) * cr * (1 + bass * 0.5)
          y = Math.sin(iAngle * 2) * cr * (0.5 + mid * 0.3) }
          break
      }

      const cos = Math.cos(state.rot * 0.5 + layer * 0.3)
      const sin = Math.sin(state.rot * 0.5 + layer * 0.3)
      const rx = x * cos - y * sin
      const ry = x * sin + y * cos

      i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry)
    }

    ctx.strokeStyle = `hsla(${layerHue}, 95%, 68%, ${alpha + overall * 0.15})`
    ctx.lineWidth = (2 - layer * 0.3) + overall * 1.5
    ctx.shadowColor = `hsla(${layerHue}, 100%, 60%, ${alpha * 0.5 + bass * 0.3})`
    ctx.shadowBlur = 12 + bass * 25 + overall * 10
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  // -- Particle burst on energy --
  if (overall > 0.3 || audio.beat > 0.5) {
    const burstCount = Math.floor(overall * 8 + bass * 5 + audio.beat * 10)
    for (let i = 0; i < burstCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * Math.min(W, H) * (0.3 + overall * 0.3)
      const bx = Math.cos(angle) * dist
      const by = Math.sin(angle) * dist
      const bSize = Math.random() * (1.5 + bass * 2) + 0.5
      const bHue = (state.hueShift + Math.random() * 90) % 360
      ctx.beginPath()
      ctx.arc(bx, by, bSize, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${bHue}, 100%, 75%, ${0.3 + overall * 0.5})`
      ctx.shadowColor = `hsla(${bHue}, 100%, 60%, 0.3)`
      ctx.shadowBlur = 6
      ctx.fill()
      ctx.shadowBlur = 0
    }
  }

  // -- Frequency bars ring --
  const ringR = Math.min(W, H) * (0.35 + overall * 0.06)
  const barCount = 64
  for (let i = 0; i < barCount; i++) {
    const angle = (i / barCount) * Math.PI * 2 + state.rot
    const fi = Math.floor((i / barCount) * 256)
    const fv = (freq[fi] || 0) / 255
    const barLen = fv * (50 + bass * 40) + 3
    const x1 = Math.cos(angle) * ringR
    const y1 = Math.sin(angle) * ringR
    const x2 = Math.cos(angle) * (ringR + barLen)
    const y2 = Math.sin(angle) * (ringR + barLen)
    const bHue = (state.hueShift + (i / barCount) * 180) % 360
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.strokeStyle = `hsla(${bHue}, 85%, 65%, ${0.2 + fv * 0.5 + overall * 0.15})`
    ctx.lineWidth = 2.5 + fv * 2
    ctx.stroke()
  }

  ctx.restore()
}
