/**
 * @module visualizations/space
 * @description **Space** - Milky Way galaxy vortex with layered nebula clouds,
 * a pulsing galactic core, spiral-arm star distribution, and differential
 * orbital rotation. Audio-reactive: bass drives core pulse and warp, mids
 * control nebula shimmer, treble triggers cross-flares on bright stars.
 */

import type { AudioFeatures, SpaceState } from './types'
import { css, mix, shade, tone, type Rgb, type VizPalette } from './palette'

let beatKick = 0
let smoothBass = 0
let smoothOverall = 0

function starTint(palette: VizPalette, white: Rgb, hue: number, saturation: number): Rgb
{
  return mix(white, palette.viz1, ((hue - 195) / 85) * (saturation / 100))
}

/**
 * Render one frame of the Space visualization.
 *
 * @param ctx     - Canvas 2D context sized to the visualizer viewport.
 * @param _freq   - Frequency-domain data (`AnalyserNode.getByteFrequencyData`), unused by this mode.
 * @param _time   - Time-domain data (`AnalyserNode.getByteTimeDomainData`), unused by this mode.
 * @param W       - Canvas width in CSS pixels.
 * @param H       - Canvas height in CSS pixels.
 * @param state   - Mutable {@link SpaceState} persisted across frames.
 * @param audio   - Pre-computed {@link AudioFeatures} for this frame.
 * @param palette - The token colors to draw with, from `readVizPalette`.
 */
export function drawSpace(
  ctx: CanvasRenderingContext2D,
  _freq: Uint8Array,
  _time: Uint8Array,
  W: number,
  H: number,
  state: SpaceState,
  audio: AudioFeatures,
  palette: VizPalette
): void
{
  const cx = W * 0.5
  const cy = H * 0.5
  const diag = Math.sqrt(W * W + H * H) * 0.5

  const bass    = audio.bass + audio.sub * 0.5
  const mid     = audio.mid
  const high    = audio.treble
  const overall = audio.overall

  smoothBass += (bass - smoothBass) * 0.18
  smoothOverall += (overall - smoothOverall) * 0.18

  if (audio.isBeat && audio.beat > 0.2)
  {
    beatKick = Math.min(1, beatKick + 0.35)
  }
  beatKick *= 0.92

  const targetWarp = 0.001 + smoothBass * 0.035 + smoothOverall * 0.018 + beatKick * 0.035
  state.warpSpeed += (targetWarp - state.warpSpeed) * 0.22

  state.rotation += 0.0003 + mid * 0.001 + beatKick * 0.002
  state.nebulaPhase += 0.0004 + smoothBass * 0.001
  state.coreGlow += ((0.6 + smoothBass * 0.4 + beatKick * 0.5) - state.coreGlow) * 0.12

  const now = Date.now() * 0.001

  ctx.fillStyle = css(palette.ground)
  ctx.fillRect(0, 0, W, H)

  ctx.save()
  ctx.translate(cx, cy)

  ctx.save()
  ctx.globalCompositeOperation = 'screen'

  const nebulae = [
    { a: state.nebulaPhase * 0.7,          turn: 0,   rx: 0.8,  ry: 0.38, al: 0.06 + bass * 0.04 },
    { a: -state.nebulaPhase * 0.5 + 1.2,   turn: 310, rx: 0.6,  ry: 0.32, al: 0.05 + mid * 0.03 },
    { a: state.nebulaPhase * 0.3 + 2.5,    turn: 50,  rx: 0.65, ry: 0.28, al: 0.04 + high * 0.03 },
    { a: -state.nebulaPhase * 0.9 + 4.0,   turn: 290, rx: 0.5,  ry: 0.24, al: 0.035 + bass * 0.025 },
    { a: state.nebulaPhase * 0.4 + 5.5,    turn: 80,  rx: 0.45, ry: 0.20, al: 0.025 + mid * 0.02 }
  ]
  for (const n of nebulae)
  {
    ctx.save()
    ctx.rotate(n.a)
    ctx.scale(diag * n.rx, diag * n.ry)
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, tone(palette, n.turn, 50, n.al * 1.6 + beatKick * 0.03))
    g.addColorStop(0.25, tone(palette, n.turn + 12, 35, n.al))
    g.addColorStop(0.55, tone(palette, n.turn + 25, 22, n.al * 0.4))
    g.addColorStop(1, 'transparent')
    ctx.fillStyle = g
    ctx.fillRect(-1.2, -1.2, 2.4, 2.4)
    ctx.restore()
  }
  ctx.restore()

  const coreR = diag * (0.12 + bass * 0.06 + beatKick * 0.05)

  const co = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 3.5)
  co.addColorStop(0, css(shade(palette, palette.accent, 60), state.coreGlow * 0.14))
  co.addColorStop(0.15, css(shade(palette, palette.accent, 45), state.coreGlow * 0.08))
  co.addColorStop(0.4, css(shade(palette, palette.accent, 30), state.coreGlow * 0.03))
  co.addColorStop(1, 'transparent')
  ctx.fillStyle = co
  ctx.beginPath()
  ctx.arc(0, 0, coreR * 3.5, 0, Math.PI * 2)
  ctx.fill()

  const ci = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR)
  ci.addColorStop(0, css(shade(palette, palette.accentInk, 92), state.coreGlow * 0.30))
  ci.addColorStop(0.12, css(shade(palette, palette.accentInk, 72), state.coreGlow * 0.18))
  ci.addColorStop(0.4, css(palette.accent, state.coreGlow * 0.07))
  ci.addColorStop(1, 'transparent')
  ctx.fillStyle = ci
  ctx.beginPath()
  ctx.arc(0, 0, coreR, 0, Math.PI * 2)
  ctx.fill()

  const cosR = Math.cos(state.rotation)
  const sinR = Math.sin(state.rotation)
  const fov  = Math.max(W, H) * 0.5
  const globalSat = 20 + bass * 35 + mid * 15
  const warmShift = mid * 15
  const sparkle = mix(palette.viz2, palette.viz1, 0.2)

  for (let i = 0; i < state.stars.length; i++)
  {
    const star = state.stars[i]
    const tier = i % 3

    const orbitSpeed = (0.0003 + star.speed * 0.5) * (1 + smoothBass * 0.8 + beatKick * 1.5)
    let radius = Math.sqrt(star.x * star.x + star.y * star.y)
    let angle  = Math.atan2(star.y, star.x)

    angle  += orbitSpeed / (0.3 + radius * 0.7)
    radius += 0.00005 * (1 + smoothOverall * 0.5)

    star.x = Math.cos(angle) * radius
    star.y = Math.sin(angle) * radius

    const prevZ = star.z

    const tierMul = tier === 0 ? 0.06 + smoothOverall * 0.10
                  : tier === 1 ? 0.18 + smoothBass * 0.22
                  :              0.40 + smoothBass * 0.48
    star.z -= state.warpSpeed * tierMul + star.speed * (0.12 + smoothBass * 0.28 + smoothOverall * 0.15)

    if (star.z <= 0.002 || radius > 1.8)
    {
      const armIdx  = Math.floor(Math.random() * 4)
      const armBase = armIdx * Math.PI * 0.5
      const newR    = 0.08 + Math.random() * 1.3
      const spiralA = armBase + newR * Math.PI * 2.5 + (Math.random() - 0.5) * 0.7
      star.x = Math.cos(spiralA) * newR
      star.y = Math.sin(spiralA) * newR
      star.z = 0.8 + Math.random() * 0.2
      star.brightness = 0.4 + Math.random() * 0.6
      star.baseSize = tier === 0 ? 0.3 + Math.random() * 0.6
                    : tier === 1 ? 0.5 + Math.random() * 1.2
                    :              0.8 + Math.random() * 2.0
      continue
    }

    const s  = fov / star.z
    const rx = star.x * s / fov
    const ry = star.y * s / fov
    const sx = (rx * cosR - ry * sinR) * fov
    const sy = (rx * sinR + ry * cosR) * fov

    if (Math.abs(sx) > cx + 30 || Math.abs(sy) > cy + 30)
    {
      continue
    }

    const closeness = 1 - star.z
    const twinkle   = 0.65 + 0.35 * Math.sin(now * (2.5 + (i % 37) * 0.15) + i * 1.73)

    if (tier === 0 && star.z > 0.55)
    {
      const a = closeness * star.brightness * twinkle * (0.3 + overall * 0.4)
      if (a < 0.015)
      {
        continue
      }
      const hue = (star.hue + warmShift) % 360
      const sz  = star.baseSize * (0.6 + closeness * 0.4)
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(sz, 0.5), 0, Math.PI * 2)
      ctx.fillStyle = css(starTint(palette, palette.ink2, hue, globalSat * 0.6), a)
      ctx.fill()
      continue
    }

    const size  = star.baseSize * (0.5 + closeness * 1.0 + bass * 0.3)
    const alpha = closeness * star.brightness * twinkle * (0.5 + overall * 0.5)
    if (alpha < 0.01)
    {
      continue
    }

    const hue = (star.hue + warmShift) % 360
    const lit = 75 + closeness * 18 + high * 10
    const color = shade(palette, starTint(palette, palette.viz2, hue, globalSat), lit)

    const ps  = fov / prevZ
    const prx = star.x * ps / fov
    const pry = star.y * ps / fov
    const psx = (prx * cosR - pry * sinR) * fov
    const psy = (prx * sinR + pry * cosR) * fov
    const ddx = sx - psx
    const ddy = sy - psy
    const streakLen = Math.sqrt(ddx * ddx + ddy * ddy)

    if (streakLen > 1.5)
    {
      ctx.beginPath()
      ctx.moveTo(psx, psy)
      ctx.lineTo(sx, sy)
      ctx.strokeStyle = css(color, alpha * Math.min(streakLen / 40, 0.85))
      ctx.lineWidth = size * 0.4 + closeness * 0.3
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(sx, sy, size, 0, Math.PI * 2)
    ctx.fillStyle = css(color, alpha)
    ctx.fill()

    if (size > 1.5 && alpha > 0.20)
    {
      const glowR = size * (2.5 + bass * 1.5)
      const gg = ctx.createRadialGradient(sx, sy, size * 0.3, sx, sy, glowR)
      gg.addColorStop(0, css(shade(palette, starTint(palette, palette.viz2, hue, globalSat + 10), lit), alpha * 0.18))
      gg.addColorStop(1, 'transparent')
      ctx.fillStyle = gg
      ctx.beginPath()
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
      ctx.fill()
    }

    if (closeness > 0.55 && star.brightness > 0.5 && high > 0.2 && size > 1.8)
    {
      const flareLen = size * (3 + high * 8)
      const fAlpha   = alpha * 0.07 + high * 0.05
      ctx.strokeStyle = css(shade(palette, starTint(palette, palette.viz2, hue, globalSat + 20), lit + 15), fAlpha)
      ctx.lineWidth = 0.5 + size * 0.12
      ctx.beginPath()
      ctx.moveTo(sx - flareLen, sy)
      ctx.lineTo(sx + flareLen, sy)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(sx, sy - flareLen)
      ctx.lineTo(sx, sy + flareLen)
      ctx.stroke()
    }

    if (twinkle > 0.92 && closeness > 0.3 && star.brightness > 0.5)
    {
      ctx.beginPath()
      ctx.arc(sx, sy, size * 2.5, 0, Math.PI * 2)
      ctx.fillStyle = css(sparkle, 0.12 + high * 0.15)
      ctx.fill()
    }
  }

  if (beatKick > 0.06)
  {
    const vR = Math.max(cx, cy) * 1.2
    const vg = ctx.createRadialGradient(0, 0, vR * 0.3, 0, 0, vR)
    vg.addColorStop(0, 'transparent')
    vg.addColorStop(0.6, 'transparent')
    vg.addColorStop(1, css(shade(palette, palette.accent, 22), beatKick * 0.18))
    ctx.fillStyle = vg
    ctx.fillRect(-cx, -cy, W, H)
  }

  ctx.restore()
}
