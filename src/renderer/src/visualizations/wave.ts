/**
 * @module visualizations/wave
 * @description Oscilloscope-style waveform visualizer with mirror reflection,
 * amplitude-scaled displacement, and beat-reactive glow.
 */

import type { AudioFeatures } from './types'

/**
 * Draw a time-domain waveform centred on the canvas with a soft fill, stroke,
 * and mirrored reflection underneath.
 *
 * Amplitude scaling is proportional to {@link AudioFeatures.overall} so the
 * waveform gracefully scales from a flat line when silent to full-height
 * oscillation at peak loudness.
 *
 * @param ctx   - 2D canvas rendering context.
 * @param time  - Time-domain byte data from {@link AnalyserNode.getByteTimeDomainData}.
 * @param W     - Canvas width in CSS pixels.
 * @param H     - Canvas height in CSS pixels.
 * @param audio - Pre-computed {@link AudioFeatures} for the current frame.
 */
export function drawWave(
  ctx: CanvasRenderingContext2D,
  time: Uint8Array,
  W: number,
  H: number,
  audio: AudioFeatures
): void {
  const cy = H / 2
  const sliceW = W / time.length
  const loudness = audio.overall

  if (loudness < 0.01) return

  const ampScale = 0.25 + loudness * 0.9

  ctx.beginPath()
  ctx.moveTo(0, cy)
  for (let i = 0; i < time.length; i++) {
    const v = ((time[i] - 128) / 128) * ampScale
    const y = cy + v * cy
    ctx.lineTo(i * sliceW, y)
  }
  ctx.lineTo(W, cy)
  ctx.closePath()

  const fillAlpha = Math.min(1, loudness * 0.45)
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, `rgba(59, 130, 246, ${fillAlpha * 0.1})`)
  grad.addColorStop(0.5, `rgba(139, 92, 246, ${fillAlpha * 0.18})`)
  grad.addColorStop(1, `rgba(59, 130, 246, ${fillAlpha * 0.1})`)
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  for (let i = 0; i < time.length; i++) {
    const v = ((time[i] - 128) / 128) * ampScale
    const y = cy + v * cy
    i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sliceW, y)
  }
  ctx.strokeStyle = `rgba(139, 92, 246, ${0.35 + loudness * 0.4 + audio.beat * 0.1})`
  ctx.lineWidth = 1.5 + loudness * 1.5 + audio.beat * 1
  ctx.shadowColor = `rgba(139, 92, 246, ${0.15 + loudness * 0.3 + audio.beat * 0.2})`
  ctx.shadowBlur = 4 + loudness * 8 + audio.beat * 10
  ctx.stroke()
  ctx.shadowBlur = 0

  // Mirror reflection - only when loud enough
  if (loudness > 0.2) {
    ctx.beginPath()
    for (let i = 0; i < time.length; i++) {
      const v = ((time[i] - 128) / 128) * ampScale
      const y = cy - v * cy
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sliceW, y)
    }
    ctx.strokeStyle = `rgba(139, 92, 246, ${0.06 + loudness * 0.1})`
    ctx.lineWidth = 1 + loudness * 0.6
    ctx.stroke()
  }
}
