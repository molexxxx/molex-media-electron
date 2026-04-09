/**
 * @module visualizations/dmt
 * @description **DMT** - psychedelic divine entity visualization.
 *
 * The most complex visualization, composed of nine layered elements:
 *
 * 1. **Kaleidoscope Sacred Geometry** (background) - five sub-layers of
 *    counter-rotating hexagonal grids, concentric polygon rings, radial
 *    spoke lattices, nested recursive polygons, and a Flower of Life pattern.
 * 2. **Ophanim Rings** - concentric rotating wheels with frequency-driven spokes.
 * 3. **Eyes** - blinking irises orbiting the rings with reactive pupil dilation.
 * 4. **Seraphim Wings** - flowing feather arcs that spread with mid energy.
 * 5. **Kaleidoscope Geometry** - mirrored spiral tendrils radiating outward.
 * 6. **Floating Orbs** - luminous spheres with glow halos drifting gently.
 * 7. **Inner Mandala** - petal-shaped polygon rosettes near the center.
 * 8. **Particles** - depth-layered motes orbiting at multiple speeds.
 * 9. **Waveform Aura / Center Eye / Shockwaves** - a time-domain ring,
 *    an all-seeing iris at the dead center, and expanding beat pulses.
 *
 * All layers persist via a fade-trail for dreamy ghosting.
 */

import type { AudioFeatures, DMTState } from './types'

/**
 * Render one frame of the DMT visualization.
 *
 * @param ctx   - Canvas 2D context sized to the visualizer viewport.
 * @param freq  - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param time  - Time-domain data (`AnalyserNode.getByteTimeDomainData`).
 * @param W     - Canvas width in CSS pixels.
 * @param H     - Canvas height in CSS pixels.
 * @param state - Mutable {@link DMTState} persisted across frames.
 * @param audio - Pre-computed {@link AudioFeatures} for this frame.
 */
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
  const minDim = Math.min(W, H)

  const bass = audio.bass + audio.sub * 0.5
  const mid = audio.mid
  const highMid = audio.highMid
  const overall = audio.overall

  // Evolving hue - slow drift with beat bursts
  state.hueBase = (state.hueBase + 0.08 + bass * 0.4 + audio.beat * 5) % 360
  state.tunnelDepth += 0.15 + mid * 0.8 + audio.beat * 3
  state.kaleidoAngle += 0.003 + bass * 0.008 + audio.beat * 0.04
  state.wingPhase += 0.02 + mid * 0.04

  // Beat shockwaves
  if (audio.isBeat && audio.beat > 0.25) {
    state.shockwaves.push({ radius: 0, alpha: 0.8, hue: state.hueBase })
  }

  // Fade trail - heavy persistence for dreamy ghosting
  const fadeAlpha = 0.035 + (1 - overall) * 0.035
  ctx.fillStyle = `rgba(3, 1, 12, ${fadeAlpha})`
  ctx.fillRect(0, 0, W, H)

  // Deep background nebula wash
  const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.7)
  bgGrad.addColorStop(0, `hsla(${(state.hueBase + 180) % 360}, 60%, 8%, ${0.02 + overall * 0.02})`)
  bgGrad.addColorStop(0.5, `hsla(${(state.hueBase + 240) % 360}, 50%, 5%, ${0.01 + bass * 0.015})`)
  bgGrad.addColorStop(1, 'transparent')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, W, H)

  const symCount = 8 + Math.floor(bass * 4)
  const angleStep = (Math.PI * 2) / symCount

  ctx.save()
  ctx.translate(cx, cy)

  // -- Background: Kaleidoscope Sacred Geometry --
  {
    const kSegments = symCount * 2
    const treble = audio.treble

    // Layer A: Rotating hexagonal grid with frequency-driven node brightness
    const gridLayers = 6
    const gridSpacing = minDim * (0.05 + mid * 0.015)
    const gridRot = t * 0.12 + state.kaleidoAngle * 0.6
    const gridRot2 = -t * 0.08 + state.kaleidoAngle * 0.3

    // Draw two counter-rotating grids for moiré interference
    for (let pass = 0; pass < 2; pass++) {
      const rot = pass === 0 ? gridRot : gridRot2
      const passAlpha = pass === 0 ? 0.12 + mid * 0.12 : 0.06 + highMid * 0.08

      ctx.save()
      ctx.rotate(rot)

      for (let row = -gridLayers; row <= gridLayers; row++) {
        for (let col = -gridLayers; col <= gridLayers; col++) {
          const hx = (col + (row % 2) * 0.5) * gridSpacing * 1.732
          const hy = row * gridSpacing * 1.5
          const dist = Math.sqrt(hx * hx + hy * hy)
          if (dist > minDim * 0.48) continue

          const distNorm = dist / (minDim * 0.48)
          const fi = Math.floor(distNorm * freq.length * 0.4)
          const energy = (freq[fi] || 0) / 255

          const hexR = gridSpacing * 0.42 * (0.6 + energy * 0.5 + bass * 0.15)
          const hexHue = (state.hueBase + distNorm * 120 + energy * 60) % 360
          const hexAlpha = passAlpha * (1 - distNorm * 0.6) * (0.3 + energy * 0.7)

          if (hexAlpha < 0.01) continue

          ctx.beginPath()
          for (let v = 0; v < 6; v++) {
            const a = v * Math.PI / 3 + t * 0.15 * (pass === 0 ? 1 : -1)
            const vx = hx + Math.cos(a) * hexR
            const vy = hy + Math.sin(a) * hexR
            v === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy)
          }
          ctx.closePath()
          ctx.strokeStyle = `hsla(${hexHue}, 75%, ${50 + energy * 25}%, ${hexAlpha})`
          ctx.lineWidth = 0.4 + energy * 0.8
          ctx.stroke()

          if (energy > 0.4) {
            ctx.beginPath()
            for (let v = 0; v < 3; v++) {
              const a = v * Math.PI * 2 / 3 + t * 0.3
              const vx = hx + Math.cos(a) * hexR * 0.5
              const vy = hy + Math.sin(a) * hexR * 0.5
              v === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy)
            }
            ctx.closePath()
            ctx.strokeStyle = `hsla(${(hexHue + 60) % 360}, 90%, 65%, ${hexAlpha * 0.6})`
            ctx.lineWidth = 0.3 + energy * 0.4
            ctx.stroke()
          }

          if (energy > 0.5 && audio.beat > 0.15) {
            ctx.beginPath()
            ctx.arc(hx, hy, 1 + energy * 2 + audio.beat * 1.5, 0, Math.PI * 2)
            ctx.fillStyle = `hsla(${hexHue}, 100%, 80%, ${energy * 0.25 * (1 + audio.beat)})`
            ctx.fill()
          }
        }
      }

      ctx.restore()
    }

    // Layer B: Kaleidoscope radial web - fine concentric polygon rings
    const webRings = 10
    const webMaxR = minDim * 0.46
    for (let r = 0; r < webRings; r++) {
      const rNorm = (r + 1) / webRings
      const ringR = rNorm * webMaxR * (0.85 + bass * 0.15 + Math.sin(t * 0.4 + r * 0.7) * highMid * 0.08)
      const fi = Math.floor(rNorm * freq.length * 0.35)
      const energy = (freq[fi] || 0) / 255
      const vertices = kSegments
      const ringHue = (state.hueBase + r * 36 + t * 8) % 360
      const ringAlpha = (0.04 + energy * 0.12 + highMid * 0.06) * (0.5 + rNorm * 0.5)

      if (ringAlpha < 0.01) continue

      ctx.beginPath()
      for (let v = 0; v <= vertices; v++) {
        const a = (v / vertices) * Math.PI * 2 + state.kaleidoAngle * (r % 2 === 0 ? 0.5 : -0.3)
        const vfi = Math.floor(((v / vertices) * 0.3 + rNorm * 0.2) * freq.length)
        const vertexWarp = (freq[vfi] || 0) / 255
        const vr = ringR + vertexWarp * minDim * 0.012 * (1 + mid * 1.5)
        const vx = Math.cos(a) * vr
        const vy = Math.sin(a) * vr
        v === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy)
      }
      ctx.strokeStyle = `hsla(${ringHue}, 65%, ${45 + energy * 25}%, ${ringAlpha})`
      ctx.lineWidth = 0.3 + energy * 0.6 + (r === 0 ? 0.3 : 0)
      ctx.stroke()
    }

    // Layer C: Radial spoke lattice - fine lines from center creating star patterns
    const spokeGroups = 3
    for (let g = 0; g < spokeGroups; g++) {
      const groupSpokes = kSegments * (g + 1)
      const groupRot = state.kaleidoAngle * (0.4 + g * 0.25) * (g % 2 === 0 ? 1 : -1) + g * 0.5
      const innerR = minDim * (0.03 + g * 0.06)
      const outerR = minDim * (0.25 + g * 0.08) * (0.7 + mid * 0.3 + highMid * 0.2)

      for (let s = 0; s < groupSpokes; s++) {
        const angle = (s / groupSpokes) * Math.PI * 2 + groupRot
        const sfi = Math.floor((s / groupSpokes) * freq.length * 0.5)
        const energy = (freq[sfi] || 0) / 255

        const spokeAlpha = (0.02 + energy * 0.08 + treble * 0.04) * (1 - g * 0.2)
        if (spokeAlpha < 0.01) continue

        const spokeHue = (state.hueBase + s * (360 / groupSpokes) + g * 60 + t * 5) % 360
        const wobble = Math.sin(t * 1.5 + s * 0.8 + g) * energy * 4

        ctx.beginPath()
        ctx.moveTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR)
        const midAngle = angle + wobble * 0.01
        const midR = (innerR + outerR) * 0.55
        ctx.quadraticCurveTo(
          Math.cos(midAngle) * midR + wobble,
          Math.sin(midAngle) * midR + wobble,
          Math.cos(angle) * outerR * (0.8 + energy * 0.2),
          Math.sin(angle) * outerR * (0.8 + energy * 0.2)
        )
        ctx.strokeStyle = `hsla(${spokeHue}, 70%, ${55 + energy * 20}%, ${spokeAlpha})`
        ctx.lineWidth = 0.3 + energy * 0.5
        ctx.stroke()
      }
    }

    // Layer D: Recursive nested polygons - breathe with bass, rotate with mid
    const nestLevels = 5
    const nestSides = [3, 4, 5, 6, 8]
    for (let n = 0; n < nestLevels; n++) {
      const sides = nestSides[n]
      const nestR = minDim * (0.06 + n * 0.065) * (0.8 + bass * 0.3 + Math.sin(t * 0.6 + n * 1.2) * 0.08)
      const nestRot = t * (0.1 + n * 0.04) * (n % 2 === 0 ? 1 : -1) + state.kaleidoAngle
      const fi = Math.floor((n / nestLevels) * freq.length * 0.25)
      const energy = (freq[fi] || 0) / 255
      const nestHue = (state.hueBase + n * 72 + 30) % 360
      const nestAlpha = 0.06 + energy * 0.15 + mid * 0.06 + audio.beat * 0.08

      ctx.beginPath()
      for (let v = 0; v <= sides; v++) {
        const a = (v / sides) * Math.PI * 2 + nestRot
        const vx = Math.cos(a) * nestR
        const vy = Math.sin(a) * nestR
        v === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy)
      }
      ctx.strokeStyle = `hsla(${nestHue}, 80%, ${50 + energy * 30}%, ${nestAlpha})`
      ctx.lineWidth = 0.5 + energy * 1.0 + bass * 0.3
      ctx.shadowColor = `hsla(${nestHue}, 100%, 60%, ${nestAlpha * 0.4})`
      ctx.shadowBlur = 3 + energy * 5
      ctx.stroke()
      ctx.shadowBlur = 0

      if (energy > 0.3) {
        for (let v = 0; v < sides; v++) {
          const a = (v / sides) * Math.PI * 2 + nestRot
          ctx.beginPath()
          ctx.moveTo(0, 0)
          ctx.lineTo(Math.cos(a) * nestR * 0.95, Math.sin(a) * nestR * 0.95)
          ctx.strokeStyle = `hsla(${nestHue}, 70%, 60%, ${energy * 0.04})`
          ctx.lineWidth = 0.3
          ctx.stroke()
        }
      }
    }

    // Layer E: Flower of Life pattern - overlapping circles at intersections
    const flowerR = minDim * 0.035 * (0.7 + highMid * 0.6 + bass * 0.2)
    const flowerRings = 2
    const flowerHue = (state.hueBase + 150) % 360
    const flowerBaseAlpha = 0.03 + highMid * 0.06 + mid * 0.04

    ctx.beginPath()
    ctx.arc(0, 0, flowerR, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${flowerHue}, 60%, 55%, ${flowerBaseAlpha})`
    ctx.lineWidth = 0.4
    ctx.stroke()

    for (let ring = 1; ring <= flowerRings; ring++) {
      const ringPetals = 6 * ring
      for (let p = 0; p < ringPetals; p++) {
        const a = (p / ringPetals) * Math.PI * 2 + t * 0.05 * (ring % 2 === 0 ? 1 : -1)
        const dist = flowerR * ring * 1.72
        const fx = Math.cos(a) * dist
        const fy = Math.sin(a) * dist

        if (Math.sqrt(fx * fx + fy * fy) > minDim * 0.44) continue

        const pfi = Math.floor((p / ringPetals) * freq.length * 0.3)
        const pEnergy = (freq[pfi] || 0) / 255
        const pAlpha = flowerBaseAlpha * (0.5 + pEnergy * 0.5) * (1 - ring * 0.2)

        ctx.beginPath()
        ctx.arc(fx, fy, flowerR * (0.8 + pEnergy * 0.3), 0, Math.PI * 2)
        ctx.strokeStyle = `hsla(${(flowerHue + pEnergy * 40) % 360}, 65%, ${50 + pEnergy * 20}%, ${pAlpha})`
        ctx.lineWidth = 0.3 + pEnergy * 0.4
        ctx.stroke()
      }
    }
  }

  // -- Layer 1: Ophanim Rings (concentric rotating wheels with eyes) --
  const ringCount = 5
  for (let r = 0; r < ringCount; r++) {
    const baseRadius = minDim * (0.12 + r * 0.08) * (1 + bass * 0.1)
    const ringHue = (state.hueBase + r * 72) % 360
    const rotDir = r % 2 === 0 ? 1 : -1
    const rotSpeed = state.kaleidoAngle * (1 + r * 0.3) * rotDir
    const fi = Math.floor((r / ringCount) * 128)
    const freqPulse = 1 + (freq[fi] || 0) / 255 * 0.15
    const radius = baseRadius * freqPulse
    const ringAlpha = 0.3 + overall * 0.4

    ctx.beginPath()
    ctx.arc(0, 0, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${ringHue}, 70%, 55%, ${ringAlpha * 0.5})`
    ctx.lineWidth = 1.5 + bass * 1
    ctx.shadowColor = `hsla(${ringHue}, 100%, 60%, ${ringAlpha * 0.3})`
    ctx.shadowBlur = 6 + bass * 8
    ctx.stroke()
    ctx.shadowBlur = 0

    const spokeCount = symCount + r * 2
    for (let s = 0; s < spokeCount; s++) {
      const angle = (s / spokeCount) * Math.PI * 2 + rotSpeed
      const sfi = Math.floor((s / spokeCount) * 256)
      const sv = (freq[sfi] || 0) / 255
      const innerR = radius * 0.7
      const outerR = radius * (1 + sv * 0.15)

      ctx.beginPath()
      ctx.moveTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR)
      ctx.lineTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR)
      ctx.strokeStyle = `hsla(${ringHue}, 80%, 65%, ${sv * 0.5 * ringAlpha})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  // -- Layer 2: Eyes on the ophanim rings --
  for (const eye of state.eyes) {
    eye.angle += eye.speed * (0.6 + bass * 0.8 + audio.beat * 1.5)
    eye.blinkPhase += 0.02 + mid * 0.03

    const eR = eye.orbitRadius * minDim
    const ex = Math.cos(eye.angle) * eR
    const ey = Math.sin(eye.angle) * eR
    const blink = Math.max(0, Math.sin(eye.blinkPhase * 0.4))
    if (blink < 0.1) continue

    const eyeSize = eye.size * (0.8 + overall * 0.4 + audio.beat * 0.3)
    const irisHue = (eye.irisHue + state.hueBase * 0.5) % 360

    ctx.save()
    ctx.translate(ex, ey)
    ctx.rotate(eye.angle + Math.PI / 2)
    ctx.scale(1, blink * 0.6)

    const scleraGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, eyeSize)
    scleraGrad.addColorStop(0, `hsla(0, 0%, 95%, ${0.7 + audio.beat * 0.15})`)
    scleraGrad.addColorStop(0.6, `hsla(${irisHue}, 40%, 85%, 0.5)`)
    scleraGrad.addColorStop(1, `hsla(${irisHue}, 60%, 40%, 0)`)
    ctx.beginPath()
    ctx.ellipse(0, 0, eyeSize, eyeSize * 0.55, 0, 0, Math.PI * 2)
    ctx.fillStyle = scleraGrad
    ctx.shadowColor = `hsla(${irisHue}, 100%, 70%, 0.4)`
    ctx.shadowBlur = 10
    ctx.fill()
    ctx.shadowBlur = 0

    const irisR = eyeSize * 0.4
    const pupilLook = Math.sin(eye.pupilPhase + t * 0.7) * irisR * 0.15
    const irisGrad = ctx.createRadialGradient(pupilLook, 0, 0, pupilLook, 0, irisR)
    irisGrad.addColorStop(0, `hsla(${irisHue}, 100%, 20%, 0.95)`)
    irisGrad.addColorStop(0.3, `hsla(${irisHue}, 90%, 50%, 0.9)`)
    irisGrad.addColorStop(0.7, `hsla(${(irisHue + 30) % 360}, 80%, 60%, 0.7)`)
    irisGrad.addColorStop(1, `hsla(${(irisHue + 60) % 360}, 60%, 50%, 0.3)`)
    ctx.beginPath()
    ctx.arc(pupilLook, 0, irisR, 0, Math.PI * 2)
    ctx.fillStyle = irisGrad
    ctx.fill()

    const pupilR = irisR * (0.35 - bass * 0.1)
    ctx.beginPath()
    ctx.arc(pupilLook, 0, Math.max(1, pupilR), 0, Math.PI * 2)
    ctx.fillStyle = `rgba(0, 0, 0, 0.95)`
    ctx.fill()

    ctx.beginPath()
    ctx.arc(pupilLook - irisR * 0.25, -irisR * 0.2, irisR * 0.15, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
    ctx.fill()

    ctx.restore()
    eye.pupilPhase += 0.015
  }

  // -- Layer 3: Seraphim Wings (flowing, feather-like arcs) --
  const wingPairs = 3
  const wingSpread = 0.3 + mid * 0.4 + audio.beat * 0.2
  for (let w = 0; w < wingPairs; w++) {
    const wingAngleBase = (w / wingPairs) * Math.PI * 2 / 3 + state.kaleidoAngle * 0.5
    const wingHue = (state.hueBase + w * 120) % 360
    const featherCount = 12 + Math.floor(highMid * 6)
    const wingLen = minDim * (0.28 + w * 0.05) * (0.7 + overall * 0.4)

    for (let side = -1; side <= 1; side += 2) {
      ctx.save()
      ctx.rotate(wingAngleBase)

      for (let f = 0; f < featherCount; f++) {
        const fp = f / featherCount
        const featherAngle = side * (fp * wingSpread + Math.sin(state.wingPhase + f * 0.3) * 0.08)
        const featherLen = wingLen * (1 - fp * 0.5) * (0.3 + fp * 0.7)
        const fi2 = Math.floor(fp * 256)
        const fv = (freq[fi2] || 0) / 255

        const startR = minDim * 0.06 + fp * minDim * 0.15
        const sx = Math.cos(featherAngle) * startR
        const sy = Math.sin(featherAngle) * startR
        const ex = Math.cos(featherAngle) * (startR + featherLen)
        const ey2 = Math.sin(featherAngle) * (startR + featherLen)

        const cpx = (sx + ex) / 2 + Math.sin(state.wingPhase + f) * fv * 15 * side
        const cpy = (sy + ey2) / 2 + Math.cos(state.wingPhase + f * 0.5) * fv * 10

        const featherAlpha = (0.15 + fv * 0.35) * (1 - fp * 0.4)
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.quadraticCurveTo(cpx, cpy, ex, ey2)
        ctx.strokeStyle = `hsla(${wingHue + fp * 40}, 80%, ${60 + fv * 20}%, ${featherAlpha})`
        ctx.lineWidth = 2.5 - fp * 1.5 + fv * 1.5
        ctx.shadowColor = `hsla(${wingHue}, 100%, 70%, ${featherAlpha * 0.5})`
        ctx.shadowBlur = 6 + fv * 8
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      ctx.restore()
    }
  }

  // -- Layer 4: Kaleidoscope Geometry --
  for (let s = 0; s < symCount; s++) {
    ctx.save()
    ctx.rotate(s * angleStep + state.kaleidoAngle)

    const armLen = minDim * 0.38 * (0.4 + mid * 0.4)
    const segments = 50
    const hue1 = (state.hueBase + s * (360 / symCount)) % 360
    const hue2 = (hue1 + 120) % 360

    // Main tendril
    ctx.beginPath()
    for (let i = 0; i <= segments; i++) {
      const p = i / segments
      const fi2 = Math.floor(p * 256)
      const fv = (freq[fi2] || 0) / 255
      const spiralR = p * armLen
      const spiralAngle = p * Math.PI * 2.5 + t * 0.3 + s * 0.5
      const wave = Math.sin(p * Math.PI * 5 + t * 0.8) * fv * 12
      const x = Math.cos(spiralAngle) * spiralR * 0.15 + p * armLen * 0.85
      const y = Math.sin(spiralAngle) * spiralR * 0.15 + wave
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    const grad = ctx.createLinearGradient(0, 0, armLen, 0)
    grad.addColorStop(0, `hsla(${hue1}, 100%, 70%, 0.6)`)
    grad.addColorStop(0.5, `hsla(${(hue1 + hue2) / 2}, 85%, 60%, 0.4)`)
    grad.addColorStop(1, `hsla(${hue2}, 100%, 70%, 0.05)`)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.2 + highMid * 1.5
    ctx.shadowColor = `hsla(${hue1}, 100%, 70%, 0.3)`
    ctx.shadowBlur = 8
    ctx.stroke()
    ctx.shadowBlur = 0

    // Mirror tendril (kaleidoscope reflection)
    ctx.save()
    ctx.scale(1, -1)
    ctx.beginPath()
    for (let i = 0; i <= segments; i++) {
      const p = i / segments
      const fi2 = Math.floor(p * 256)
      const fv = (freq[fi2] || 0) / 255
      const spiralR = p * armLen
      const spiralAngle = p * Math.PI * 2.5 + t * 0.3 + s * 0.5
      const wave = Math.sin(p * Math.PI * 5 + t * 0.8) * fv * 12
      const x = Math.cos(spiralAngle) * spiralR * 0.15 + p * armLen * 0.85
      const y = Math.sin(spiralAngle) * spiralR * 0.15 + wave
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.strokeStyle = grad
    ctx.lineWidth = 0.8 + highMid * 1
    ctx.globalAlpha = 0.4
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.restore()

    ctx.restore()
  }

  // -- Layer 5: Floating Orbs --
  for (const orb of state.orbs) {
    orb.pulse += 0.03 + bass * 0.05
    orb.x += orb.vx * (1 + audio.beat * 3)
    orb.y += orb.vy * (1 + audio.beat * 3)

    orb.vx += -orb.x * 0.0003 + (Math.random() - 0.5) * 0.0004
    orb.vy += -orb.y * 0.0003 + (Math.random() - 0.5) * 0.0004
    if (Math.abs(orb.x) > 0.5) orb.vx *= -0.5
    if (Math.abs(orb.y) > 0.5) orb.vy *= -0.5

    const ox = orb.x * minDim
    const oy = orb.y * minDim
    const orbPulse = 1 + Math.sin(orb.pulse) * 0.3 + audio.beat * 0.4
    const orbR = orb.radius * orbPulse
    const orbHue = (orb.hue + state.hueBase * 0.3) % 360

    const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, orbR * 3)
    glow.addColorStop(0, `hsla(${orbHue}, 100%, 75%, ${0.15 + overall * 0.15})`)
    glow.addColorStop(0.4, `hsla(${orbHue}, 90%, 55%, ${0.06 + bass * 0.06})`)
    glow.addColorStop(1, 'transparent')
    ctx.fillStyle = glow
    ctx.fillRect(ox - orbR * 3, oy - orbR * 3, orbR * 6, orbR * 6)

    const core = ctx.createRadialGradient(ox, oy, 0, ox, oy, orbR)
    core.addColorStop(0, `hsla(${orbHue}, 100%, 95%, ${0.8 + audio.beat * 0.2})`)
    core.addColorStop(0.5, `hsla(${orbHue}, 90%, 65%, 0.6)`)
    core.addColorStop(1, `hsla(${(orbHue + 40) % 360}, 80%, 50%, 0)`)
    ctx.beginPath()
    ctx.arc(ox, oy, orbR, 0, Math.PI * 2)
    ctx.fillStyle = core
    ctx.shadowColor = `hsla(${orbHue}, 100%, 70%, 0.5)`
    ctx.shadowBlur = 15 + audio.beat * 10
    ctx.fill()
    ctx.shadowBlur = 0
  }

  // -- Layer 6: Inner Mandala --
  const mandalaRings = 4
  for (let r = 0; r < mandalaRings; r++) {
    const radius = 15 + r * 16 * (1 + audio.lowMid * 0.5)
    const hue = (state.hueBase + r * 90 + t * 15) % 360
    const petals = symCount * 2

    ctx.beginPath()
    for (let i = 0; i <= petals * 2; i++) {
      const angle = (i / (petals * 2)) * Math.PI * 2 + t * (0.3 + r * 0.07)
      const fi2 = Math.floor((i / (petals * 2)) * 128)
      const freqPulse = 1 + (freq[fi2] || 0) / 255 * 0.25
      const rr = radius * freqPulse * (i % 2 === 0 ? 1 : 0.55 + audio.treble * 0.35)
      const x = Math.cos(angle) * rr
      const y = Math.sin(angle) * rr
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.strokeStyle = `hsla(${hue}, 80%, 65%, ${0.25 + audio.lowMid * 0.3})`
    ctx.lineWidth = 1
    ctx.shadowColor = `hsla(${hue}, 100%, 70%, 0.25)`
    ctx.shadowBlur = 6
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  // -- Layer 7: Particles (depth-layered) --
  for (const p of state.particles) {
    const layerSpeed = 0.4 + p.layer * 0.3
    p.angle += p.speed * layerSpeed * (0.5 + bass * 0.6 + audio.beat * 1.5)
    const freqIdx = Math.floor(Math.abs(p.angle / (Math.PI * 2)) * 256) % 256
    const fv = (freq[freqIdx] || 0) / 255
    const r = p.radius * minDim * (0.25 + fv * 0.25 + p.layer * 0.05)
    const x = Math.cos(p.angle) * r
    const y = Math.sin(p.angle) * r
    const hue = (state.hueBase + p.hueOff + t * 20) % 360
    const size = p.size * (0.8 + fv * 0.8) * (0.7 + p.layer * 0.15)
    const alpha = p.brightness * (0.3 + fv * 0.5) * (1 - p.layer * 0.15)

    ctx.beginPath()
    ctx.arc(x, y, size, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${hue}, 100%, 75%, ${alpha})`
    ctx.shadowColor = `hsla(${hue}, 100%, 65%, ${alpha * 0.6})`
    ctx.shadowBlur = 8 + p.layer * 3
    ctx.fill()
    ctx.shadowBlur = 0
  }

  // -- Layer 8: Waveform Aura --
  const auraRadius = minDim * 0.42
  ctx.beginPath()
  for (let i = 0; i < time.length; i += 4) {
    const angle = (i / time.length) * Math.PI * 2
    const v = (time[i] - 128) / 128
    const r = auraRadius * (0.85 + v * 0.15)
    const x = Math.cos(angle + t * 0.2) * r
    const y = Math.sin(angle + t * 0.2) * r
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  const auraHue = (state.hueBase + 180) % 360
  ctx.strokeStyle = `hsla(${auraHue}, 70%, 55%, ${0.08 + overall * 0.12})`
  ctx.lineWidth = 1
  ctx.stroke()

  // -- Center Eye (all-seeing, pulses on beat) --
  const eyeR = 8 + bass * 12 + audio.beat * 18
  for (let ring = 3; ring >= 0; ring--) {
    const rr = eyeR * (0.4 + ring * 0.2)
    const ringHue = (state.hueBase + ring * 25) % 360
    ctx.beginPath()
    ctx.arc(0, 0, rr, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${ringHue}, 100%, ${70 - ring * 15}%, ${0.3 + audio.beat * 0.15})`
    ctx.fill()
  }

  const pupilR = eyeR * (0.25 - bass * 0.08)
  ctx.beginPath()
  ctx.arc(0, 0, Math.max(1.5, pupilR), 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)'
  ctx.shadowColor = `hsla(${state.hueBase}, 100%, 80%, ${0.5 + audio.beat * 0.5})`
  ctx.shadowBlur = 20 + audio.beat * 30
  ctx.fill()
  ctx.shadowBlur = 0

  ctx.beginPath()
  ctx.arc(-pupilR * 0.6, -pupilR * 0.5, eyeR * 0.1, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + audio.beat * 0.3})`
  ctx.fill()

  // -- Beat Shockwaves --
  for (let i = state.shockwaves.length - 1; i >= 0; i--) {
    const sw = state.shockwaves[i]
    sw.radius += 4 + overall * 6
    sw.alpha *= 0.96
    if (sw.alpha < 0.01) { state.shockwaves.splice(i, 1); continue }
    ctx.beginPath()
    ctx.arc(0, 0, sw.radius, 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${sw.hue}, 100%, 75%, ${sw.alpha * 0.4})`
    ctx.lineWidth = 2 + sw.alpha * 3
    ctx.stroke()
  }

  ctx.restore()
}
