/**
 * @module visualizations/rain
 * @description **Rain** - Matrix-style digital rain with per-strand audio mapping.
 *
 * Each column is randomly assigned one of six frequency bands (sub to treble).
 * That band drives the column's speed, trail length, mutation rate, glow, and
 * tint, so bass strands are slow, heavy, and lean toward ice blue; mid strands
 * pulse green with vocals and snare; treble strands are fast, thin, and white.
 * Beats ripple outward from the center, and each band gets its own beat
 * sensitivity. Two depth layers (foreground and background) add parallax.
 */

import type { AudioFeatures, RainBand, RainState } from './types'
import { css, mix, ringColor, shade, type Rgb, type VizPalette } from './palette'

const GLYPHS =
  'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ' +
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'ΔΣΩΨξΦΠ<>{}|/:=+*^~'

function randomGlyph(): string
{
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
}

const BANDS: RainBand[] = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'treble']

interface BandStyle
{
  ringDegrees: number
  tailLight: number
  baseSpeed: number
  baseTrail: number
}

const BAND_STYLES: Record<RainBand, BandStyle> = {
  sub:     { ringDegrees: 60,  tailLight: 23, baseSpeed: 0.20, baseTrail: 20 },
  bass:    { ringDegrees: 85,  tailLight: 28, baseSpeed: 0.30, baseTrail: 18 },
  lowMid:  { ringDegrees: 105, tailLight: 33, baseSpeed: 0.45, baseTrail: 14 },
  mid:     { ringDegrees: 120, tailLight: 42, baseSpeed: 0.55, baseTrail: 12 },
  highMid: { ringDegrees: 165, tailLight: 47, baseSpeed: 0.70, baseTrail: 10 },
  treble:  { ringDegrees: 215, tailLight: 52, baseSpeed: 0.90, baseTrail: 8 }
}

interface BandColors
{
  glow: Rgb
  head: Rgb
  near: Rgb
  trail: Rgb
}

function bandColors(palette: VizPalette, style: BandStyle): BandColors
{
  const glow = ringColor(palette, style.ringDegrees)
  return {
    glow,
    head: shade(palette, glow, 78),
    near: shade(palette, mix(palette.viz3, glow, 0.2), 56),
    trail: mix(palette.viz3, glow, 0.3)
  }
}

function pickBand(): RainBand
{
  return BANDS[Math.floor(Math.random() * BANDS.length)]
}

function bandEnergy(band: RainBand, a: AudioFeatures): number
{
  return a[band]
}

let beatPulse = 0
const bandPulse: Record<RainBand, number> = { sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 }

/**
 * Render one frame of the Rain visualization.
 *
 * @param ctx     - Canvas 2D context sized to the visualizer viewport.
 * @param freq    - Frequency-domain data (`AnalyserNode.getByteFrequencyData`).
 * @param _time   - Time-domain data (`AnalyserNode.getByteTimeDomainData`), unused by this mode.
 * @param W       - Canvas width in CSS pixels.
 * @param H       - Canvas height in CSS pixels.
 * @param state   - Mutable {@link RainState} persisted across frames.
 * @param audio   - Pre-computed {@link AudioFeatures} for this frame.
 * @param palette - The token colors to draw with, from `readVizPalette`.
 */
export function drawRain(
  ctx: CanvasRenderingContext2D,
  freq: Uint8Array,
  _time: Uint8Array,
  W: number,
  H: number,
  state: RainState,
  audio: AudioFeatures,
  palette: VizPalette
): void
{
  state.t += 0.016

  if (audio.isBeat && audio.beat > 0.25)
  {
    beatPulse = Math.min(1, beatPulse + 0.6)
  }
  beatPulse *= 0.92
  for (const b of BANDS)
  {
    const e = bandEnergy(b, audio)
    if (e > 0.5)
    {
      bandPulse[b] = Math.min(1, bandPulse[b] + e * 0.35)
    }
    bandPulse[b] *= 0.88
  }

  const colors = {} as Record<RainBand, BandColors>
  for (const b of BANDS)
  {
    colors[b] = bandColors(palette, BAND_STYLES[b])
  }
  const sparkle = mix(palette.viz2, palette.viz3, 0.25)

  const fadeAlpha = 0.06 + (1 - audio.overall) * 0.06
  ctx.fillStyle = css(palette.ground, fadeAlpha)
  ctx.fillRect(0, 0, W, H)

  if (beatPulse > 0.05)
  {
    ctx.fillStyle = css(shade(palette, palette.viz3, 14), beatPulse * 0.12)
    ctx.fillRect(0, 0, W, H)
  }

  const fontSize = state.fontSize
  const cols = Math.floor(W / fontSize)
  const rows = Math.floor(H / fontSize)
  const halfCols = cols * 0.5

  if (state.columns.length !== cols)
  {
    state.columns = Array.from({ length: cols }, (_, i) =>
    {
      const existing = state.columns[i]
      if (existing)
      {
        return { ...existing, active: true }
      }
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

  for (let col = 0; col < cols; col++)
  {
    const stream = state.columns[col]
    if (!stream)
    {
      continue
    }

    if (!stream.active)
    {
      stream.active = true
      stream.y = -2 - Math.random() * 10
    }

    const band = stream.band
    const style = BAND_STYLES[band]
    const tint = colors[band]
    const energy = bandEnergy(band, audio)
    const bPulse = bandPulse[band]

    const fi = Math.floor((col / cols) * freq.length * 0.8)
    const localE = (freq[Math.min(fi, freq.length - 1)] || 0) / 255

    const isBg = col % 3 === 0
    const layerScale = isBg ? 0.55 : 1
    const layerAlphaMul = isBg ? 0.45 : 1
    const layerFont = isBg ? Math.max(8, fontSize - 3) : fontSize

    const speedMod = (style.baseSpeed + energy * 2.0 + localE * 0.6 + audio.overall * 0.2) * layerScale
    stream.y += stream.speed * speedMod

    stream.mutateTimer += 0.016
    const mutateThresh = 0.10 - energy * 0.06 - audio.flux * 0.02
    if (stream.mutateTimer > mutateThresh)
    {
      stream.mutateTimer = 0
      const count = 1 + Math.floor(energy * 3 + localE * 2)
      for (let m = 0; m < count; m++)
      {
        const idx = Math.floor(Math.random() * stream.chars.length)
        stream.chars[idx] = randomGlyph()
      }
    }

    const colDist = Math.abs(col - halfCols) / halfCols
    const rippleBoost = beatPulse * Math.max(0, 1 - colDist * 1.6) * 0.4 + bPulse * 0.3

    const headY = Math.floor(stream.y)
    const trailLen = Math.floor((style.baseTrail + energy * 20 + localE * 8) * layerScale)
    const x = col * fontSize + fontSize * 0.5

    for (let row = headY; row > headY - trailLen && row >= 0; row--)
    {
      if (row >= rows + 5)
      {
        continue
      }

      const charIdx = ((row % stream.chars.length) + stream.chars.length) % stream.chars.length
      const char = stream.chars[charIdx]
      const distFromHead = headY - row
      const fadeT = distFromHead / trailLen

      if (distFromHead === 0)
      {
        const headAlpha = Math.min(1, (0.65 + energy * 0.35 + rippleBoost) * layerAlphaMul)
        ctx.font = `bold ${layerFont}px monospace`
        ctx.fillStyle = css(tint.head, headAlpha)
        ctx.shadowColor = css(tint.glow, 0.7 + energy * 0.3)
        ctx.shadowBlur = 6 + energy * 14 + rippleBoost * 16
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      }
      else if (distFromHead <= 3)
      {
        const nearAlpha = Math.min(1, (0.55 + energy * 0.3 + rippleBoost) * (1 - fadeT * 0.2) * layerAlphaMul)
        ctx.font = `bold ${layerFont}px monospace`
        ctx.fillStyle = css(tint.near, nearAlpha)
        if (energy > 0.35)
        {
          ctx.shadowColor = css(tint.glow, energy * 0.35)
          ctx.shadowBlur = 4 + energy * 8
        }
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      }
      else
      {
        const trailAlpha = (0.3 + energy * 0.4 + rippleBoost * 0.6) * (1 - fadeT) * stream.brightness * layerAlphaMul
        if (trailAlpha < 0.02)
        {
          continue
        }
        const light = style.tailLight + (1 - fadeT) * (100 - style.tailLight) * 0.2
        ctx.font = `${layerFont}px monospace`
        ctx.fillStyle = css(shade(palette, tint.trail, light), trailAlpha)
        ctx.fillText(char, x, row * fontSize)
      }

      const sparkleChance = energy * 0.025 + audio.treble * 0.015 + localE * 0.01
      if (sparkleChance > 0.01 && Math.random() < sparkleChance)
      {
        ctx.fillStyle = css(sparkle, 0.3 + energy * 0.5)
        ctx.shadowColor = css(tint.glow, 0.7)
        ctx.shadowBlur = 8
        ctx.fillText(char, x, row * fontSize)
        ctx.shadowBlur = 0
      }
    }

    if (headY - trailLen > rows + 5)
    {
      stream.y = -2 - Math.random() * 18
      stream.speed = 0.25 + Math.random() * 0.75
      stream.brightness = 0.5 + Math.random() * 0.5
      stream.band = pickBand()
      stream.hueOff = (Math.random() - 0.5) * 30
    }
  }

  ctx.fillStyle = css(palette.ground, 0.025)
  for (let y = 0; y < H; y += 3)
  {
    ctx.fillRect(0, y, W, 1)
  }
}
