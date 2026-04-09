/**
 * @module visualizations/bars
 * @description Classic frequency bar visualizer with peak-hold indicators,
 * gradient fills, reflections, and beat-reactive colour shifting.
 */

import type { AudioFeatures } from './types'

/**
 * Render a 64-band frequency bar chart with Winamp-style peak dots.
 *
 * Each bar uses exponential bin mapping for perceptually even spacing.
 * Per-bar smoothing provides fluid motion while retaining musicality.
 * Peak dots use gravity decay for a natural fall-off.
 *
 * @param ctx      - 2D canvas rendering context.
 * @param freq     - Raw FFT frequency data (`Uint8Array`).
 * @param smooth   - Per-bar smoothed values (mutated in place each frame).
 * @param peaks    - Per-bar peak heights (mutated via gravity decay).
 * @param peakVel  - Per-bar peak velocity (mutated each frame).
 * @param W        - Canvas width in CSS pixels.
 * @param H        - Canvas height in CSS pixels.
 * @param audio    - Pre-computed {@link AudioFeatures} for the current frame.
 */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  smooth: Float32Array,
  peaks: Float32Array,
  peakVel: Float32Array,
  W: number,
  H: number,
  audio: AudioFeatures
): void {
  const count = 64
  const gap = 2
  const barW = (W - gap * (count - 1)) / count
  const scale = H / 255
  const loudness = audio.overall

  // Beat-reactive color shift
  const beatHue = audio.beat > 0.1 ? 20 + audio.beat * 40 : 0

  for (let i = 0; i < count; i++) {
    const fi = Math.floor(Math.pow(i / count, 1.5) * freq.length * 0.5)
    const raw = freq[fi] || 0
    // Per-bar smoothing: fluid motion without losing musicality
    if (raw > smooth[i]) smooth[i] += (raw - smooth[i]) * 0.4
    else smooth[i] += (raw - smooth[i]) * 0.2
    const h = smooth[i] * scale * 0.85

    // Peak hold with gravity (classic Winamp) - faster gravity so peaks don't linger
    if (h > peaks[i]) {
      peaks[i] = h
      peakVel[i] = 0
    } else {
      peakVel[i] += 0.3
      peaks[i] = Math.max(0, peaks[i] - peakVel[i])
    }

    const x = i * (barW + gap)
    const y = H - h

    // Main bar gradient - shifts warm on beat, dims when quiet
    const barAlpha = Math.min(1, 0.3 + loudness * 1.2)
    const grad = ctx.createLinearGradient(x, H, x, y)
    if (beatHue > 0) {
      grad.addColorStop(0, `hsla(${270 + beatHue}, 80%, 55%, ${barAlpha})`)
      grad.addColorStop(0.5, `hsla(${280 + beatHue}, 75%, 50%, ${barAlpha * 0.8})`)
      grad.addColorStop(1, `hsla(${220 + beatHue}, 70%, 50%, ${barAlpha * 0.55})`)
    } else {
      grad.addColorStop(0, `rgba(139, 92, 246, ${barAlpha})`)
      grad.addColorStop(0.5, `rgba(168, 85, 247, ${barAlpha * 0.8})`)
      grad.addColorStop(1, `rgba(59, 130, 246, ${barAlpha * 0.55})`)
    }

    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x, y, barW, h, [3, 3, 0, 0])
    ctx.fill()

    // Top glow
    ctx.shadowColor = `rgba(139, 92, 246, ${0.3 + audio.beat * 0.4})`
    ctx.shadowBlur = 8 + audio.beat * 12
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.roundRect(x, y, barW, Math.min(h, 4), [3, 3, 0, 0])
    ctx.fill()
    ctx.shadowBlur = 0

    // Peak hold dot
    const peakY = H - peaks[i]
    if (peaks[i] > 2) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.7 + audio.beat * 0.3})`
      ctx.shadowColor = 'rgba(139, 92, 246, 0.6)'
      ctx.shadowBlur = 4
      ctx.fillRect(x, peakY - 2, barW, 2)
      ctx.shadowBlur = 0
    }

    // Reflection
    const reflGrad = ctx.createLinearGradient(x, H, x, H + h * 0.3)
    reflGrad.addColorStop(0, 'rgba(139, 92, 246, 0.12)')
    reflGrad.addColorStop(1, 'rgba(139, 92, 246, 0)')
    ctx.fillStyle = reflGrad
    ctx.fillRect(x, H, barW, h * 0.3)
  }
}
