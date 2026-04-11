/**
 * @module visualizations/space
 * @description **Space** – Milky Way galaxy vortex with layered nebula clouds,
 * a pulsing galactic core, spiral-arm star distribution, and differential
 * orbital rotation.  Audio-reactive: bass drives core pulse and warp, mids
 * control nebula shimmer, treble triggers cross-flares on bright stars.
 */

import type { AudioFeatures, SpaceState } from './types'

let beatKick = 0
let smoothBass = 0
let smoothOverall = 0

export function drawSpace(
  ctx: CanvasRenderingContext2D,
  _freq: Uint8Array,
  _time: Uint8Array,
  W: number,
  H: number,
  state: SpaceState,
  audio: AudioFeatures
): void {
  const cx = W * 0.5
  const cy = H * 0.5
  const diag = Math.sqrt(W * W + H * H) * 0.5

  const bass    = audio.bass + audio.sub * 0.5
  const mid     = audio.mid
  const high    = audio.treble
  const overall = audio.overall

  /* smooth audio followers - eliminates frame-to-frame jitter */
  smoothBass += (bass - smoothBass) * 0.18
  smoothOverall += (overall - smoothOverall) * 0.18

  if (audio.isBeat && audio.beat > 0.2) beatKick = Math.min(1, beatKick + 0.35)
  beatKick *= 0.92

  /* warp speed - faster lerp so it tracks the music closely */
  const targetWarp = 0.001 + smoothBass * 0.035 + smoothOverall * 0.018 + beatKick * 0.035
  state.warpSpeed += (targetWarp - state.warpSpeed) * 0.22

  state.rotation += 0.0003 + mid * 0.001 + beatKick * 0.002
  state.nebulaPhase += 0.0004 + smoothBass * 0.001
  state.coreGlow += ((0.6 + smoothBass * 0.4 + beatKick * 0.5) - state.coreGlow) * 0.12

  const now = Date.now() * 0.001

  /* -- background -------------------------------------------- */
  ctx.fillStyle = '#000004'
  ctx.fillRect(0, 0, W, H)

  ctx.save()
  ctx.translate(cx, cy)

  /* -- nebula clouds (screen-blended elliptical gradients) -- */
  ctx.save()
  ctx.globalCompositeOperation = 'screen'

  const nebulae = [
    { a: state.nebulaPhase * 0.7,          h: 270, s: 60, rx: 0.8,  ry: 0.38, al: 0.06 + bass * 0.04 },
    { a: -state.nebulaPhase * 0.5 + 1.2,   h: 220, s: 50, rx: 0.6,  ry: 0.32, al: 0.05 + mid * 0.03 },
    { a: state.nebulaPhase * 0.3 + 2.5,    h: 320, s: 45, rx: 0.65, ry: 0.28, al: 0.04 + high * 0.03 },
    { a: -state.nebulaPhase * 0.9 + 4.0,   h: 200, s: 55, rx: 0.5,  ry: 0.24, al: 0.035 + bass * 0.025 },
    { a: state.nebulaPhase * 0.4 + 5.5,    h: 350, s: 35, rx: 0.45, ry: 0.20, al: 0.025 + mid * 0.02 },
  ]
  for (const n of nebulae) {
    ctx.save()
    ctx.rotate(n.a)
    ctx.scale(diag * n.rx, diag * n.ry)
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0,   `hsla(${n.h}, ${n.s}%, 50%, ${n.al * 1.6 + beatKick * 0.03})`)
    g.addColorStop(0.25, `hsla(${n.h + 12}, ${n.s - 8}%, 35%, ${n.al})`)
    g.addColorStop(0.55, `hsla(${n.h + 25}, ${n.s - 18}%, 22%, ${n.al * 0.4})`)
    g.addColorStop(1,   'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(-1.2, -1.2, 2.4, 2.4)
    ctx.restore()
  }
  ctx.restore()

  /* -- galactic core ----------------------------------------- */
  const coreR = diag * (0.12 + bass * 0.06 + beatKick * 0.05)

  /* outer haze */
  const co = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 3.5)
  co.addColorStop(0,   `hsla(275, 55%, 60%, ${state.coreGlow * 0.14})`)
  co.addColorStop(0.15, `hsla(265, 50%, 45%, ${state.coreGlow * 0.08})`)
  co.addColorStop(0.4, `hsla(250, 40%, 30%, ${state.coreGlow * 0.03})`)
  co.addColorStop(1,   'rgba(0,0,0,0)')
  ctx.fillStyle = co
  ctx.beginPath()
  ctx.arc(0, 0, coreR * 3.5, 0, Math.PI * 2)
  ctx.fill()

  /* inner bright core */
  const ci = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR)
  ci.addColorStop(0,   `hsla(268, 35%, 92%, ${state.coreGlow * 0.30})`)
  ci.addColorStop(0.12, `hsla(265, 50%, 72%, ${state.coreGlow * 0.18})`)
  ci.addColorStop(0.4, `hsla(260, 60%, 50%, ${state.coreGlow * 0.07})`)
  ci.addColorStop(1,   'rgba(0,0,0,0)')
  ctx.fillStyle = ci
  ctx.beginPath()
  ctx.arc(0, 0, coreR, 0, Math.PI * 2)
  ctx.fill()

  /* -- stars (spiral orbit) ---------------------------------- */
  const cosR = Math.cos(state.rotation)
  const sinR = Math.sin(state.rotation)
  const fov  = Math.max(W, H) * 0.5
  const globalSat = 20 + bass * 35 + mid * 15
  const warmShift = mid * 15

  for (let i = 0; i < state.stars.length; i++) {
    const star = state.stars[i]
    const tier = i % 3

    /* -- spiral orbital motion -- */
    const orbitSpeed = (0.0003 + star.speed * 0.5) * (1 + smoothBass * 0.8 + beatKick * 1.5)
    let radius = Math.sqrt(star.x * star.x + star.y * star.y)
    let angle  = Math.atan2(star.y, star.x)

    /* differential rotation: inner stars faster */
    angle  += orbitSpeed / (0.3 + radius * 0.7)
    radius += 0.00005 * (1 + smoothOverall * 0.5)

    star.x = Math.cos(angle) * radius
    star.y = Math.sin(angle) * radius

    const prevZ = star.z

    const tierMul = tier === 0 ? 0.06 + smoothOverall * 0.10
                  : tier === 1 ? 0.18 + smoothBass * 0.22
                  :              0.40 + smoothBass * 0.48
    star.z -= state.warpSpeed * tierMul + star.speed * (0.12 + smoothBass * 0.28 + smoothOverall * 0.15)

    /* respawn on a spiral arm */
    if (star.z <= 0.002 || radius > 1.8) {
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

    /* project to screen */
    const s  = fov / star.z
    const rx = star.x * s / fov
    const ry = star.y * s / fov
    const sx = (rx * cosR - ry * sinR) * fov
    const sy = (rx * sinR + ry * cosR) * fov

    if (Math.abs(sx) > cx + 30 || Math.abs(sy) > cy + 30) continue

    const closeness = 1 - star.z
    const twinkle   = 0.65 + 0.35 * Math.sin(now * (2.5 + (i % 37) * 0.15) + i * 1.73)

    /* far pinpoints */
    if (tier === 0 && star.z > 0.55) {
      const a = closeness * star.brightness * twinkle * (0.3 + overall * 0.4)
      if (a < 0.015) continue
      const hue = (star.hue + warmShift) % 360
      const sz  = star.baseSize * (0.6 + closeness * 0.4)
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(sz, 0.5), 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${hue}, ${globalSat * 0.6}%, 88%, ${a})`
      ctx.fill()
      continue
    }

    const size  = star.baseSize * (0.5 + closeness * 1.0 + bass * 0.3)
    const alpha = closeness * star.brightness * twinkle * (0.5 + overall * 0.5)
    if (alpha < 0.01) continue

    const hue = (star.hue + warmShift) % 360
    const lit = 75 + closeness * 18 + high * 10

    /* streak from previous position */
    const ps  = fov / prevZ
    const prx = star.x * ps / fov
    const pry = star.y * ps / fov
    const psx = (prx * cosR - pry * sinR) * fov
    const psy = (prx * sinR + pry * cosR) * fov
    const ddx = sx - psx
    const ddy = sy - psy
    const streakLen = Math.sqrt(ddx * ddx + ddy * ddy)

    if (streakLen > 1.5) {
      ctx.beginPath()
      ctx.moveTo(psx, psy)
      ctx.lineTo(sx, sy)
      ctx.strokeStyle = `hsla(${hue}, ${globalSat}%, ${lit}%, ${alpha * Math.min(streakLen / 40, 0.85)})`
      ctx.lineWidth = size * 0.4 + closeness * 0.3
      ctx.stroke()
    }

    /* star dot */
    ctx.beginPath()
    ctx.arc(sx, sy, size, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${hue}, ${globalSat}%, ${lit}%, ${alpha})`
    ctx.fill()

    /* soft glow halo (only bright / close stars) */
    if (size > 1.5 && alpha > 0.20) {
      const glowR = size * (2.5 + bass * 1.5)
      const gg = ctx.createRadialGradient(sx, sy, size * 0.3, sx, sy, glowR)
      gg.addColorStop(0, `hsla(${hue}, ${globalSat + 10}%, ${lit}%, ${alpha * 0.18})`)
      gg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gg
      ctx.beginPath()
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
      ctx.fill()
    }

    /* cross-flare on treble */
    if (closeness > 0.55 && star.brightness > 0.5 && high > 0.2 && size > 1.8) {
      const flareLen = size * (3 + high * 8)
      const fAlpha   = alpha * 0.07 + high * 0.05
      ctx.strokeStyle = `hsla(${hue}, ${globalSat + 20}%, ${lit + 15}%, ${fAlpha})`
      ctx.lineWidth = 0.5 + size * 0.12
      ctx.beginPath(); ctx.moveTo(sx - flareLen, sy); ctx.lineTo(sx + flareLen, sy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(sx, sy - flareLen); ctx.lineTo(sx, sy + flareLen); ctx.stroke()
    }

    /* sparkle */
    if (twinkle > 0.92 && closeness > 0.3 && star.brightness > 0.5) {
      ctx.beginPath()
      ctx.arc(sx, sy, size * 2.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(220, 230, 255, ${0.12 + high * 0.15})`
      ctx.fill()
    }
  }

  /* -- beat vignette ----------------------------------------- */
  if (beatKick > 0.06) {
    const vR = Math.max(cx, cy) * 1.2
    const vg = ctx.createRadialGradient(0, 0, vR * 0.3, 0, 0, vR)
    vg.addColorStop(0,  'rgba(0,0,0,0)')
    vg.addColorStop(0.6, 'rgba(0,0,0,0)')
    vg.addColorStop(1, `rgba(45, 15, 90, ${beatKick * 0.18})`)
    ctx.fillStyle = vg
    ctx.fillRect(-cx, -cy, W, H)
  }

  ctx.restore()
}
