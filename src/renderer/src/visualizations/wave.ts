/**
 * @module visualizations/wave
 * @description Multi-band waveform visualizer with big peaks.
 *
 * Five vertically stacked lanes, each driven by a **different slice of the
 * frequency spectrum** so the shapes are genuinely distinct.  The waveform
 * in each lane is formed by the frequency bins for that band, producing
 * tall dramatic peaks and valleys.  Colour hue shifts along the X-axis
 * (rainbow gradient per lane), brightness and alpha pulse with energy and
 * beats.  Gradient fills give visual weight beneath each wave.
 */

import type { AudioFeatures } from './types'

/* module-level smoothed beat */
let beatPump = 0

/**
 * Draw multi-band frequency waveforms with tall peaks and gradient hues.
 */
export function drawWave(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  audio: AudioFeatures
): void {
  const loudness = audio.overall
  if (loudness < 0.01) return

  /* beat pump */
  if (audio.isBeat && audio.beat > 0.2) beatPump = Math.min(1, beatPump + 0.55)
  beatPump *= 0.88

  /* clear */
  ctx.fillStyle = '#04020a'
  ctx.fillRect(0, 0, W, H)

  /*
   * Each band maps to a frequency range (start..end as fraction of bins).
   * The wave shape is built from the actual freq magnitudes in that slice,
   * interpolated smoothly across the lane width.
   */
  const bands = [
    { energy: audio.sub + audio.bass * 0.3,  start: 0,    end: 0.06, hueA: 0,   hueB: 35,  label: 'sub'     },
    { energy: audio.bass,                     start: 0.04, end: 0.14, hueA: 320, hueB: 360, label: 'bass'    },
    { energy: audio.mid,                      start: 0.10, end: 0.35, hueA: 190, hueB: 240, label: 'mid'     },
    { energy: audio.highMid,                  start: 0.25, end: 0.55, hueA: 100, hueB: 165, label: 'highMid' },
    { energy: audio.treble,                   start: 0.45, end: 0.80, hueA: 260, hueB: 310, label: 'treble'  },
  ]

  const count = bands.length
  const laneH = H / (count + 1)
  const halfLane = laneH * 0.45   // max displacement from centre

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let b = 0; b < count; b++) {
    const band = bands[b]
    const cy = laneH * (b + 1)
    const energy = band.energy

    /* slice freq data for this band */
    const binStart = Math.floor(band.start * freq.length)
    const binEnd   = Math.floor(band.end   * freq.length)
    const binCount = Math.max(1, binEnd - binStart)

    /* amplitude: energy + loudness + beat, scaled to fill the lane */
    const ampMul = (0.5 + energy * 1.2 + loudness * 0.6 + beatPump * 0.7)

    /* number of sample points across the width */
    const numPts = Math.min(W * 0.5, 300)

    /* build points: sample freq bins mapped across width */
    const points: number[] = new Array(numPts)
    let prev = 0
    for (let i = 0; i < numPts; i++) {
      const frac = i / (numPts - 1)
      const bin = binStart + Math.floor(frac * (binCount - 1))
      const v = (freq[Math.min(bin, freq.length - 1)] || 0) / 255

      /* also mix in a bit of time-domain for liveliness */
      const ti = Math.floor(frac * time.length)
      const tv = ((time[ti] || 128) - 128) / 128

      const raw = (v * 0.80 + tv * 0.20) * ampMul
      /* light smoothing so it doesn't jitter too hard */
      prev += (raw - prev) * 0.55
      points[i] = prev
    }

    /* mirror: draw above and below centre for symmetric wave */
    for (let mirror = 0; mirror < 2; mirror++) {
      const dir = mirror === 0 ? -1 : 1
      const pts: { x: number; y: number }[] = []

      for (let i = 0; i < numPts; i++) {
        pts.push({
          x: (i / (numPts - 1)) * W,
          y: cy + dir * points[i] * halfLane
        })
      }

      /* gradient fill from wave to centre */
      ctx.beginPath()
      for (let i = 0; i < pts.length; i++) {
        i === 0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y)
      }
      ctx.lineTo(W, cy)
      ctx.lineTo(0, cy)
      ctx.closePath()

      const grad = ctx.createLinearGradient(0, 0, W, 0)
      const steps = 8
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        const hue = band.hueA + (band.hueB - band.hueA) * t
        const a = (0.08 + energy * 0.10 + beatPump * 0.06) * (mirror === 0 ? 1 : 0.6)
        grad.addColorStop(t, `hsla(${hue % 360}, 90%, 55%, ${a})`)
      }
      ctx.fillStyle = grad
      ctx.fill()

      /* hue-gradient stroke along X */
      /* we draw segments to get the colour shift */
      const lineW = 2.2 + energy * 3 + loudness * 1.2 + beatPump * 1.5
      ctx.lineWidth = mirror === 0 ? lineW : lineW * 0.7
      for (let i = 1; i < pts.length; i++) {
        const t = i / (pts.length - 1)
        const hue = band.hueA + (band.hueB - band.hueA) * t
        const sat = 85 + energy * 15
        const lit = 55 + energy * 20 + beatPump * 15 + points[i] * 20
        const alpha = 0.7 + energy * 0.25 + beatPump * 0.05
        ctx.beginPath()
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
        ctx.lineTo(pts[i].x, pts[i].y)
        ctx.strokeStyle = `hsla(${hue % 360}, ${sat}%, ${Math.min(90, lit)}%, ${Math.min(1, alpha * (mirror === 0 ? 1 : 0.5))})`
        ctx.stroke()
      }

      /* glow pass on primary (top) mirror only */
      if (mirror === 0) {
        ctx.beginPath()
        for (let i = 0; i < pts.length; i++) {
          i === 0 ? ctx.moveTo(pts[i].x, pts[i].y) : ctx.lineTo(pts[i].x, pts[i].y)
        }
        const glowHue = (band.hueA + band.hueB) * 0.5
        ctx.shadowColor = `hsla(${glowHue % 360}, 100%, 65%, ${0.4 + energy * 0.4})`
        ctx.shadowBlur = 6 + energy * 16 + beatPump * 12
        ctx.strokeStyle = `hsla(${glowHue % 360}, 90%, 70%, ${0.2 + energy * 0.15})`
        ctx.lineWidth = lineW * 0.4
        ctx.stroke()
        ctx.shadowBlur = 0
      }
    }
  }
}
