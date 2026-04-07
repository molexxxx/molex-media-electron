/**
 * @module visualizations/plasma
 * @description **Plasma** — Winamp-inspired sine-plasma field visualization.
 *
 * Renders a composite sine-plasma at reduced resolution (6× down-scaled),
 * modulated by audio-driven blob positions, frequency data, and a rotating
 * hue base. After up-scaling to the canvas, a circular waveform scope and
 * an inner frequency ring are overlaid in the center.
 */

import type { AudioFeatures, PlasmaState } from './types'

/**
 * Render one frame of the Plasma visualization.
 *
 * @param ctx   - Canvas 2D context sized to the visualizer viewport.
 * @param freq  - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time  - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W     - Canvas width in CSS pixels.
 * @param H     - Canvas height in CSS pixels.
 * @param state - Mutable {@link PlasmaState} persisted across frames.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
export function drawPlasma(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  _time: Uint8Array,
  W: number,
  H: number,
  state: PlasmaState,
  audio: AudioFeatures
): void {
  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const high = audio.treble
  const overall = audio.overall

  state.t += 0.015 + overall * 0.04 + bass * 0.02 + audio.beat * 0.1
  state.hueBase = (state.hueBase + 0.3 + bass * 2.0 + mid * 1.0 + audio.beat * 5) % 360

  // Update blob positions — gentle audio-driven flow
  for (const blob of state.blobs) {
    blob.x += blob.sx * (0.5 + bass * 2.0 + overall * 1.0)
    blob.y += blob.sy * (0.5 + mid * 1.5 + overall * 1.0)
  }

  // Render plasma field at reduced resolution for performance
  const step = 6
  const imgW = Math.ceil(W / step)
  const imgH = Math.ceil(H / step)
  const imgData = ctx.createImageData(imgW, imgH)
  const data = imgData.data

  for (let py = 0; py < imgH; py++) {
    for (let px = 0; px < imgW; px++) {
      const nx = px / imgW
      const ny = py / imgH

      // Composite sine plasma layers — audio modulates frequencies and amplitudes
      let val = 0
      val += Math.sin(nx * (6 + bass * 3) + state.t) * (1 + bass * 0.4)
      val += Math.sin(ny * (5 + mid * 2.5) + state.t * 0.7) * (1 + mid * 0.3)
      val += Math.sin((nx + ny) * (4 + high * 2) + state.t * 1.0) * (1 + overall * 0.25)
      val += Math.sin(Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * (8 + bass * 3) + state.t * 0.5) * (1 + bass * 0.35)
      val += Math.sin(nx * 3 - ny * 4 + state.t * 1.8) * mid * 1.5

      // Add audio-reactive blob influences — stronger ripples
      for (const blob of state.blobs) {
        const bx = (Math.sin(blob.x) + 1) / 2
        const by = (Math.sin(blob.y) + 1) / 2
        const dist = Math.sqrt((nx - bx) ** 2 + (ny - by) ** 2)
        val += Math.sin(dist * (12 + overall * 10) - state.t * 2.5) * (1.5 + bass * 2)
        if (dist < 0.15) val += (0.15 - dist) * 8 * (1 + overall)
      }

      // Frequency modulation — per-column spectral color
      const fi = Math.floor(nx * 256)
      const fv = (freq[fi] || 0) / 255
      val += fv * 3 * Math.sin(ny * (15 + bass * 10) + state.t)
      const fi2 = Math.floor(ny * 256)
      const fv2 = (freq[fi2] || 0) / 255
      val += fv2 * 2 * Math.cos(nx * 12 + state.t * 0.6)

      // Map to color — wider dynamic range
      val = val / 7 + 0.5
      const hue = (state.hueBase + val * 220 + fv * 40) % 360
      const sat = 65 + mid * 35 + fv * 10
      const light = 12 + val * 45 + overall * 20 + fv * 8

      // HSL to RGB (fast approximation)
      const h6 = hue / 60
      const c = (1 - Math.abs(2 * light / 100 - 1)) * sat / 100
      const x = c * (1 - Math.abs(h6 % 2 - 1))
      const m = light / 100 - c / 2
      let r = 0, g = 0, b = 0
      if (h6 < 1) { r = c; g = x }
      else if (h6 < 2) { r = x; g = c }
      else if (h6 < 3) { g = c; b = x }
      else if (h6 < 4) { g = x; b = c }
      else if (h6 < 5) { r = x; b = c }
      else { r = c; b = x }

      const idx = (py * imgW + px) * 4
      data[idx] = (r + m) * 255
      data[idx + 1] = (g + m) * 255
      data[idx + 2] = (b + m) * 255
      data[idx + 3] = 255
    }
  }

  // Scale up plasma to canvas
  const tmpCanvas = document.createElement('canvas')
  tmpCanvas.width = imgW
  tmpCanvas.height = imgH
  const tmpCtx = tmpCanvas.getContext('2d')!
  tmpCtx.putImageData(imgData, 0, 0)

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'medium'
  ctx.drawImage(tmpCanvas, 0, 0, W, H)
}
