/**
 * @module visualizations/dmt
 * @description **DMT** – Full-canvas psychedelic feedback animation.
 *
 * Uses a zoom-rotate feedback loop on the trail canvas to create an
 * infinitely recursive, screen-filling warp effect.  New content is
 * painted each frame (color washes, warp rays, flowing rivers, plasma
 * blobs) and then fed back through the warp, building up organic,
 * ever-evolving patterns across the entire canvas.
 *
 * No spinning circles or concentric geometry - the entire canvas IS
 * the animation.
 */

import type { AudioFeatures, DMTState } from './types'

export function drawDMT(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  time: Uint8Array,
  W: number,
  H: number,
  state: DMTState,
  audio: AudioFeatures
): void {
  const t = Date.now() * 0.001
  const cx = W / 2
  const cy = H / 2
  const diag = Math.sqrt(W * W + H * H)

  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const overall = audio.overall

  // ---- State evolution ----
  state.hueBase = (state.hueBase + 0.6 + bass * 2 + audio.beat * 15) % 360
  state.tunnelDepth += 1.0 + mid * 3 + audio.beat * 6
  state.kaleidoAngle += 0.008 + bass * 0.015 + audio.beat * 0.06
  state.wingPhase += 0.04 + mid * 0.06

  // Beat shockwaves
  if (audio.isBeat && audio.beat > 0.2) {
    state.shockwaves.push({ radius: 0, alpha: 1.0, hue: state.hueBase })
  }

  // ============================================================
  // FEEDBACK WARP - the core of the whole effect.
  // Copy current canvas to the offscreen trail buffer, then draw
  // it back slightly zoomed + rotated.  This makes every painted
  // element echo infinitely inward, creating full-canvas recursive
  // psychedelia.
  // ============================================================
  if (!state.trailCanvas) {
    state.trailCanvas = document.createElement('canvas')
    state.trailCanvas.width = W
    state.trailCanvas.height = H
    state.trailCtx = state.trailCanvas.getContext('2d')
  }
  if (state.trailCanvas.width !== W || state.trailCanvas.height !== H) {
    state.trailCanvas.width = W
    state.trailCanvas.height = H
    state.trailCtx = state.trailCanvas.getContext('2d')
  }

  const tc = state.trailCtx!
  const trail = state.trailCanvas

  // Snapshot current canvas into the trail buffer
  tc.clearRect(0, 0, W, H)
  tc.drawImage(ctx.canvas, 0, 0)

  // Dim the main canvas slightly (controls trail length)
  ctx.fillStyle = `rgba(0, 0, 0, ${0.06 + (1 - overall) * 0.06})`
  ctx.fillRect(0, 0, W, H)

  // Draw the snapshot back, zoomed + rotated around center.
  // The zoom pulls everything toward center → infinite tunnel.
  // The rotation creates spiraling patterns.
  const zoomAmt = 1.012 + bass * 0.018 + audio.beat * 0.03
  const rotAmt = Math.sin(t * 0.3) * 0.003 + state.kaleidoAngle * 0.003
    + audio.beat * 0.008 * Math.sin(t)

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rotAmt)
  ctx.scale(zoomAmt, zoomAmt)
  ctx.translate(-cx, -cy)
  ctx.globalAlpha = 0.92 + overall * 0.06
  ctx.drawImage(trail, 0, 0)
  ctx.globalAlpha = 1
  ctx.restore()

  // Subtle hue-shift overlay on the feedback (makes colors cycle over time)
  ctx.globalCompositeOperation = 'overlay'
  ctx.fillStyle = `hsla(${state.hueBase}, 100%, 50%, ${0.01 + audio.beat * 0.02})`
  ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'

  // ============================================================
  // WARP RAYS - radial streaks rushing from center to edges.
  // Gives the "hyperspace warp" / rushing-toward-you feeling.
  // These fill the canvas from center outward.
  // ============================================================
  {
    const rayCount = 48 + Math.floor(bass * 24)
    for (let i = 0; i < rayCount; i++) {
      const angle = (i / rayCount) * Math.PI * 2 + state.kaleidoAngle * 0.5
        + Math.sin(t * 0.5 + i * 0.7) * 0.08

      // Frequency data drives ray length and brightness
      const fi = Math.floor((i / rayCount) * freq.length * 0.6)
      const energy = (freq[fi] || 0) / 255

      const innerR = 20 + bass * 30 + audio.beat * 40
      const outerR = innerR + diag * 0.35 * (0.3 + energy * 0.7 + mid * 0.3)
      const rayAlpha = 0.03 + energy * 0.12 + audio.beat * 0.06

      if (rayAlpha < 0.01) continue

      const hue = (state.hueBase + i * (360 / rayCount) + t * 20) % 360

      // Tapered ray using a gradient along the stroke
      const x1 = cx + Math.cos(angle) * innerR
      const y1 = cy + Math.sin(angle) * innerR
      const x2 = cx + Math.cos(angle) * outerR
      const y2 = cy + Math.sin(angle) * outerR

      const grad = ctx.createLinearGradient(x1, y1, x2, y2)
      grad.addColorStop(0, `hsla(${hue}, 100%, 70%, ${rayAlpha})`)
      grad.addColorStop(0.6, `hsla(${(hue + 30) % 360}, 90%, 55%, ${rayAlpha * 0.5})`)
      grad.addColorStop(1, `hsla(${(hue + 60) % 360}, 80%, 40%, 0)`)

      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.strokeStyle = grad
      ctx.lineWidth = 1 + energy * 4 + audio.beat * 3
      ctx.stroke()
    }
  }

  // ============================================================
  // FLOWING COLOR RIVERS - wide bezier curves that sweep across
  // the full canvas, edge to edge.  They drift and undulate.
  // ============================================================
  {
    const riverCount = 6 + Math.floor(mid * 4)
    for (let i = 0; i < riverCount; i++) {
      const phase = t * (0.15 + i * 0.04) + i * 2.1
      const yBase = (Math.sin(phase) * 0.5 + 0.5) * H

      // Start and end at canvas edges
      const x0 = -20
      const y0 = yBase + Math.sin(t * 0.7 + i * 1.3) * H * 0.2
      const x3 = W + 20
      const y3 = yBase + Math.cos(t * 0.5 + i * 0.9) * H * 0.2

      // Control points that warp with audio
      const cp1x = W * 0.25 + Math.sin(t * 0.4 + i) * W * 0.15
      const cp1y = y0 + Math.sin(t * 0.6 + i * 2) * H * (0.15 + bass * 0.15)
      const cp2x = W * 0.75 + Math.cos(t * 0.35 + i * 1.5) * W * 0.15
      const cp2y = y3 + Math.cos(t * 0.55 + i * 1.8) * H * (0.15 + mid * 0.15)

      const fi = Math.floor((i / riverCount) * freq.length * 0.5)
      const energy = (freq[fi] || 0) / 255
      const hue = (state.hueBase + i * (360 / riverCount) + t * 10) % 360
      const alpha = 0.04 + energy * 0.15 + overall * 0.06

      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x3, y3)
      ctx.strokeStyle = `hsla(${hue}, 90%, 60%, ${alpha})`
      ctx.lineWidth = 3 + energy * 12 + bass * 8 + audio.beat * 6
      ctx.shadowColor = `hsla(${hue}, 100%, 65%, ${alpha * 0.6})`
      ctx.shadowBlur = 15 + energy * 20
      ctx.stroke()
      ctx.shadowBlur = 0
    }
  }

  // ============================================================
  // PLASMA BLOBS - large soft glowing regions that drift across
  // the canvas, painting broad swaths of color that the feedback
  // loop will recursively zoom into.
  // ============================================================
  {
    const blobCount = 5 + Math.floor(overall * 3)
    for (let i = 0; i < blobCount; i++) {
      const phase1 = t * (0.2 + i * 0.07) + i * 3.7
      const phase2 = t * (0.15 + i * 0.05) + i * 2.3
      const bx = cx + Math.sin(phase1) * W * 0.4
      const by = cy + Math.cos(phase2) * H * 0.4
      const blobR = 40 + Math.sin(t * 0.8 + i * 1.1) * 20
        + bass * 50 + audio.beat * 60

      const fi = Math.floor((i / blobCount) * freq.length * 0.4)
      const energy = (freq[fi] || 0) / 255
      const hue = (state.hueBase + i * 72 + t * 15) % 360
      const alpha = 0.06 + energy * 0.15 + audio.beat * 0.08

      const grad = ctx.createRadialGradient(bx, by, 0, bx, by, blobR)
      grad.addColorStop(0, `hsla(${hue}, 100%, 70%, ${alpha})`)
      grad.addColorStop(0.4, `hsla(${(hue + 40) % 360}, 85%, 50%, ${alpha * 0.5})`)
      grad.addColorStop(1, 'transparent')
      ctx.fillStyle = grad
      ctx.fillRect(bx - blobR, by - blobR, blobR * 2, blobR * 2)
    }
  }

  // ============================================================
  // WAVEFORM MEMBRANE - time-domain data drawn as a flowing
  // membrane across the full canvas width (not a circle).
  // ============================================================
  {
    const membraneY = cy
    const amp = H * (0.15 + bass * 0.15 + audio.beat * 0.1)
    const step = Math.max(1, Math.floor(time.length / W))

    for (let pass = 0; pass < 3; pass++) {
      const hue = (state.hueBase + pass * 120 + t * 8) % 360
      const yOff = Math.sin(t * 0.4 + pass * 2) * H * 0.08
      const alpha = 0.08 + overall * 0.12 + audio.beat * 0.08

      ctx.beginPath()
      for (let x = 0; x <= W; x += 2) {
        const ti = Math.min(time.length - 1, x * step)
        const v = (time[ti] - 128) / 128
        const waveY = membraneY + yOff + v * amp
          + Math.sin(x * 0.01 + t * 2 + pass) * 8
        x === 0 ? ctx.moveTo(x, waveY) : ctx.lineTo(x, waveY)
      }
      ctx.strokeStyle = `hsla(${hue}, 85%, 65%, ${alpha})`
      ctx.lineWidth = 2 + bass * 3 + audio.beat * 2
      ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${alpha * 0.4})`
      ctx.shadowBlur = 8 + bass * 10
      ctx.stroke()
      ctx.shadowBlur = 0
    }
  }

  // ============================================================
  // PARTICLE FIELD - particles that fly outward from center
  // toward the edges (not orbiting in circles).
  // ============================================================
  for (const p of state.particles) {
    // Particles fly outward radially, reset when they leave the canvas
    const speed = (0.5 + p.layer * 0.4) * (2 + bass * 3 + audio.beat * 5)
    p.radius += p.speed * speed * 0.008

    // Reset when outside canvas
    if (p.radius > 1.2) {
      p.radius = 0.01 + Math.random() * 0.05
      p.angle += Math.random() * 0.3 - 0.15
    }

    const fi = Math.floor(Math.abs(p.angle / (Math.PI * 2)) * 256) % freq.length
    const energy = (freq[fi] || 0) / 255

    // Radial position from center to edge
    const dist = p.radius * diag * 0.55
    const px = cx + Math.cos(p.angle) * dist
    const py = cy + Math.sin(p.angle) * dist

    // Size grows as particle moves outward (perspective)
    const sizeScale = 0.3 + p.radius * 2
    const size = p.size * sizeScale * (0.6 + energy * 0.8)
    const hue = (state.hueBase + p.hueOff + t * 30) % 360
    const alpha = p.brightness * (0.15 + energy * 0.5) * Math.min(1, p.radius * 4)
      * Math.max(0, 1 - p.radius * 0.8)

    if (alpha < 0.01 || size < 0.3) continue

    ctx.beginPath()
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${hue}, 100%, 75%, ${alpha})`
    ctx.fill()

    // Motion trail
    if (energy > 0.3 && dist > 30) {
      const tailLen = 4 + energy * 12
      const tx = px - Math.cos(p.angle) * tailLen
      const ty = py - Math.sin(p.angle) * tailLen
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(tx, ty)
      ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${alpha * 0.4})`
      ctx.lineWidth = size * 0.6
      ctx.stroke()
    }
  }

  // ============================================================
  // BEAT FLASH - full-screen color wash on strong beats
  // ============================================================
  if (audio.isBeat && audio.beat > 0.3) {
    const flashHue = state.hueBase
    ctx.fillStyle = `hsla(${flashHue}, 100%, 70%, ${audio.beat * 0.08})`
    ctx.fillRect(0, 0, W, H)
  }

  // ============================================================
  // SHOCKWAVES - expanding rings from center on beats
  // ============================================================
  for (let i = state.shockwaves.length - 1; i >= 0; i--) {
    const sw = state.shockwaves[i]
    sw.radius += 8 + overall * 12 + audio.beat * 6
    sw.alpha *= 0.93
    if (sw.alpha < 0.01 || sw.radius > diag) {
      state.shockwaves.splice(i, 1)
      continue
    }
    ctx.beginPath()
    ctx.arc(cx, cy, sw.radius, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${sw.hue}, 100%, 75%, ${sw.alpha * 0.4})`
    ctx.lineWidth = 3 + sw.alpha * 6
    ctx.stroke()
  }

  // ============================================================
  // CENTER GLOW - subtle hot core that feeds the feedback loop
  // ============================================================
  {
    const coreR = 30 + bass * 40 + audio.beat * 50
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR)
    grad.addColorStop(0, `hsla(${state.hueBase}, 100%, 90%, ${0.15 + audio.beat * 0.15})`)
    grad.addColorStop(0.3, `hsla(${(state.hueBase + 30) % 360}, 95%, 60%, ${0.08 + overall * 0.06})`)
    grad.addColorStop(1, 'transparent')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
    ctx.fill()
  }

  // Update orbs (keep state consistent even though we're not drawing them as circles)
  for (const orb of state.orbs) {
    orb.pulse += 0.03
    orb.x += orb.vx
    orb.y += orb.vy
    if (Math.abs(orb.x) > 0.5) orb.vx *= -0.8
    if (Math.abs(orb.y) > 0.5) orb.vy *= -0.8
  }

  // Update eyes (keep state consistent)
  for (const eye of state.eyes) {
    eye.angle += eye.speed * 0.5
    eye.blinkPhase += 0.02
    eye.pupilPhase += 0.01
  }
}
