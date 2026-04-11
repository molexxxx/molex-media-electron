/**
 * @module visualizations/rain
 * @description **Rain** – Matrix-style digital rain with per-strand audio mapping.
 *
 * Each column is randomly assigned one of six frequency bands (sub → treble).
 * That band drives the column's speed, trail length, mutation rate, glow, and
 * colour tint - so bass strands are slow, heavy, and teal; mid strands pulse
 * with vocals and snare; treble strands are fast, thin, white-hot.  Beats
 * ripple outward from centre, and each band gets its own beat sensitivity.
 * Two depth layers (foreground / background) add parallax.
 */

import type { AudioFeatures, RainBand, RainState } from './types'

/* -- glyph set -------------------------------------------- */

const GLYPHS =
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ' +
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'ΔΣΩΨξΦΠ<>{}|/:=+*^~'

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
}

/* -- band palette ----------------------------------------- */
// Each band gets a distinct colour character so you can *see* what
// part of the music each strand is reacting to.

const BANDS: RainBand[] = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'treble']

interface BandStyle {
  /** Head RGB */
  headR: number; headG: number; headB: number
  /** Trail base green, blue offsets */
  trailG: number; trailB: number
  /** Base speed multiplier */
  baseSpeed: number
  /** Base trail length */
  baseTrail: number
  /** Shadow / glow hue string */
  glow: string
}

const BAND_STYLES: Record<RainBand, BandStyle> = {
  sub:     { headR: 140, headG: 255, headB: 255, trailG: 100, trailB: 120, baseSpeed: 0.20, baseTrail: 20, glow: '60, 200, 240' },
  bass:    { headR: 160, headG: 255, headB: 230, trailG: 120, trailB: 90,  baseSpeed: 0.30, baseTrail: 18, glow: '70, 240, 180' },
  lowMid:  { headR: 180, headG: 255, headB: 210, trailG: 140, trailB: 60,  baseSpeed: 0.45, baseTrail: 14, glow: '80, 255, 140' },
  mid:     { headR: 210, headG: 255, headB: 200, trailG: 180, trailB: 50,  baseSpeed: 0.55, baseTrail: 12, glow: '100, 255, 120' },
  highMid: { headR: 230, headG: 255, headB: 220, trailG: 200, trailB: 40,  baseSpeed: 0.70, baseTrail: 10, glow: '160, 255, 140' },
  treble:  { headR: 245, headG: 255, headB: 250, trailG: 230, trailB: 60,  baseSpeed: 0.90, baseTrail: 8,  glow: '220, 255, 210' }
}

function pickBand(): RainBand {
  return BANDS[Math.floor(Math.random() * BANDS.length)]
}

function bandEnergy(band: RainBand, a: AudioFeatures): number {
  return a[band]
}

/* -- module-level smoothed values ------------------------- */

let beatPulse = 0
const bandPulse: Record<RainBand, number> = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 }

/* -- renderer --------------------------------------------- */

export function drawRain(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  _time: Uint8Array,
  W: number,
  H: number,
  state: RainState,
  audio: AudioFeatures
): void {
  state.t += 0.016

  /* -- per-band pulses -- */
  if (audio.isBeat && audio.beat > 0.25) beatPulse = Math.min(1, beatPulse + 0.6)
  beatPulse *= 0.92
  for (const b of BANDS) {
    const e = bandEnergy(b, audio)
    if (e > 0.5) bandPulse[b] = Math.min(1, bandPulse[b] + e * 0.35)
    bandPulse[b] *= 0.88
  }

  /* -- background fade -- */
  const fadeAlpha = 0.06 + (1 - audio.overall) * 0.06
  ctx.fillStyle = `rgba(0, 3, 1, ${fadeAlpha})`
  ctx.fillRect(0, 0, W, H)

  if (beatPulse > 0.05) {
    ctx.fillStyle = `rgba(0, 60, 25, ${beatPulse * 0.12})`
    ctx.fillRect(0, 0, W, H)
  }

  /* -- grid -- */
  const fontSize = state.fontSize
  const cols = Math.floor(W / fontSize)
  const rows = Math.floor(H / fontSize)
  const halfCols = cols * 0.5

  /* -- ensure every column is populated -- */
  if (state.columns.length !== cols) {
    state.columns = Array.from({ length: cols }, (_, i) => {
      const existing = state.columns[i]
      if (existing) return { ...existing, active: true }
      return {
        y: Math.random() * rows * -1,
        speed: 0.25 + Math.random() * 0.75,
        chars: Array.from({ length: rows + 12 }, () => randomGlyph()),
        mutateTimer: 0,
        brightness: 0.5 + Math.random() * 0.5,
        active: true,
        band: pickBand(),
        hueOff: (Math.random() - 0.5) * 30
      }
    })
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  for (let col = 0; col < cols; col++) {
    const stream = state.columns[col]
    if (!stream) continue

    if (!stream.active) {
      stream.active = true
      stream.y = -2 - Math.random() * 10
    }

    const band = stream.band
    const style = BAND_STYLES[band]
    const energy = bandEnergy(band, audio)
    const bPulse = bandPulse[band]

    /* frequency-bin local energy (per-column shimmer) */
    const fi = Math.floor((col / cols) * freq.length * 0.8)
    const localE = (freq[Math.min(fi, freq.length - 1)] || 0) / 255

    /* -- depth layer (parallax) -- */
    const isBg = col % 3 === 0
    const layerScale = isBg ? 0.55 : 1
    const layerAlphaMul = isBg ? 0.45 : 1
    const layerFont = isBg ? Math.max(8, fontSize - 3) : fontSize

    /* -- speed: driven by the column's own band -- */
    const speedMod = (style.baseSpeed + energy * 2.0 + localE * 0.6 + audio.overall * 0.2) * layerScale
    stream.y += stream.speed * speedMod

    /* -- mutation rate: own band energy + flux for transient excitement -- */
    stream.mutateTimer += 0.016
    const mutateThresh = 0.10 - energy * 0.06 - audio.flux * 0.02
    if (stream.mutateTimer > mutateThresh) {
      stream.mutateTimer = 0
      const count = 1 + Math.floor(energy * 3 + localE * 2)
      for (let m = 0; m < count; m++) {
        const idx = Math.floor(Math.random() * stream.chars.length)
        stream.chars[idx] = randomGlyph()
      }
    }

    /* -- ripple + band pulse boost -- */
    const colDist = Math.abs(col - halfCols) / halfCols
    const rippleBoost = beatPulse * Math.max(0, 1 - colDist * 1.6) * 0.4 + bPulse * 0.3

    /* -- draw stream -- */
    const headY = Math.floor(stream.y)
    const trailLen = Math.floor((style.baseTrail + energy * 20 + localE * 8) * layerScale)
    const x = col * fontSize + fontSize * 0.5

    for (let row = headY; row > headY - trailLen && row >= 0; row--) {
      if (row >= rows + 5) continue

      const charIdx = ((row % stream.chars.length) + stream.chars.length) % stream.chars.length
      const char = stream.chars[charIdx]
      const distFromHead = headY - row
      const fadeT = distFromHead / trailLen

      if (distFromHead === 0) {
        /* -- HEAD: band-tinted, glowing -- */
        const headAlpha = Math.min(1, (0.65 + energy * 0.35 + rippleBoost) * layerAlphaMul)
        ctx.font = `bold ${layerFont}px monospace`
        ctx.fillStyle = `rgba(${style.headR}, ${style.headG}, ${style.headB}, ${headAlpha})`
        ctx.shadowColor = `rgba(${style.glow}, ${0.7 + energy * 0.3})`
        ctx.shadowBlur = 6 + energy * 14 + rippleBoost * 16
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      } else if (distFromHead <= 3) {
        /* -- near-head: bright, band-coloured glow -- */
        const nearAlpha = Math.min(1, (0.55 + energy * 0.3 + rippleBoost) * (1 - fadeT * 0.2) * layerAlphaMul)
        ctx.font = `bold ${layerFont}px monospace`
        const nr = Math.floor(style.headR * 0.4)
        const ng = Math.floor(style.headG * 0.95)
        const nb = Math.floor(style.headB * 0.55)
        ctx.fillStyle = `rgba(${nr}, ${ng}, ${nb}, ${nearAlpha})`
        if (energy > 0.35) {
          ctx.shadowColor = `rgba(${style.glow}, ${energy * 0.35})`
          ctx.shadowBlur = 4 + energy * 8
        }
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      } else {
        /* -- TRAIL: fading, band-tinted -- */
        const trailAlpha = (0.3 + energy * 0.4 + rippleBoost * 0.6) * (1 - fadeT) * stream.brightness * layerAlphaMul
        if (trailAlpha < 0.02) continue
        const g = Math.floor(style.trailG + (1 - fadeT) * (255 - style.trailG) * 0.5)
        const b = Math.floor(style.trailB * (1 - fadeT * 0.6))
        const r = Math.floor((style.headR - 100) * 0.15 * (1 - fadeT))
        ctx.font = `${layerFont}px monospace`
        ctx.fillStyle = `rgba(${Math.max(0, r)}, ${g}, ${b}, ${trailAlpha})`
        ctx.fillText(char, x, row * fontSize)
      }

      /* -- sparkle: own band energy + treble boost -- */
      const sparkleChance = energy * 0.025 + audio.treble * 0.015 + localE * 0.01
      if (sparkleChance > 0.01 && Math.random() < sparkleChance) {
        ctx.fillStyle = `rgba(220, 255, 235, ${0.3 + energy * 0.5})`
        ctx.shadowColor = `rgba(${style.glow}, 0.7)`
        ctx.shadowBlur = 8
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      }
    }

    /* -- reset when past bottom - re-roll band for variety -- */
    if (headY - trailLen > rows + 5) {
      stream.y = -2 - Math.random() * 18
      stream.speed = 0.25 + Math.random() * 0.75
      stream.brightness = 0.5 + Math.random() * 0.5
      stream.band = pickBand()
      stream.hueOff = (Math.random() - 0.5) * 30
    }
  }

  /* -- scanline overlay (subtle CRT feel) -- */
  ctx.fillStyle = 'rgba(0,0,0,0.025)'
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1)
  }
}
