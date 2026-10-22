/**
 * @module visualizations/palette
 * @description The colors every visualization draws with, read from the design tokens: the stage ground, the
 * three visualization tones, the accent in its two tones, and the three ink steps. Art that cycles through hues
 * walks a ring of the visualization tones instead, so every frame stays inside the app's palette.
 */

import { readToken, type TokenName } from '../ui/tokens'

/** A color as red, green, and blue channels from 0 to 255. */
export type Rgb = readonly [number, number, number]

/** The token colors a visualization draws with. */
export interface VizPalette
{
  /** The stage behind every drawing (`--color-sunken`). */
  ground: Rgb
  viz1: Rgb
  viz2: Rgb
  viz3: Rgb
  accent: Rgb
  accentInk: Rgb
  ink: Rgb
  ink2: Rgb
  ink3: Rgb
  /** The ring that hue-driven art walks: viz-1, viz-3, viz-2, then back to viz-1. */
  ring: readonly Rgb[]
}

/** The token each palette role reads. */
export const PALETTE_TOKENS: Readonly<Record<Exclude<keyof VizPalette, 'ring'>, TokenName>> = {
  ground: '--color-sunken',
  viz1: '--color-viz-1',
  viz2: '--color-viz-2',
  viz3: '--color-viz-3',
  accent: '--color-accent',
  accentInk: '--color-accent-ink',
  ink: '--color-ink',
  ink2: '--color-ink-2',
  ink3: '--color-ink-3'
}

/** What a role reads as when its token cannot be read, such as in a test document without the theme. */
const UNREAD: Rgb = [128, 128, 128]

function clampByte(value: number): number
{
  return Math.max(0, Math.min(255, Math.round(value)))
}

function hexByte(value: number): string
{
  return clampByte(value).toString(16).padStart(2, '0')
}

/** Reads `#rgb`, `#rrggbb`, `#rrggbbaa`, and the comma or space forms of the rgb functions; null for anything else. */
export function parseColor(value: string): Rgb | null
{
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)
  if (hex)
  {
    const digits = hex[1].length === 3 ? hex[1].split('').map((d) => d + d).join('') : hex[1].slice(0, 6)
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)]
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text)
  if (fn)
  {
    return [clampByte(Number(fn[1])), clampByte(Number(fn[2])), clampByte(Number(fn[3]))]
  }
  return null
}

let probe: CanvasRenderingContext2D | null | undefined

/** Resolves any CSS color the canvas accepts, such as `color-mix()`, to channels through a 1 x 1 canvas. */
function resolveThroughCanvas(value: string): Rgb | null
{
  if (probe === undefined)
  {
    try
    {
      probe = document.createElement('canvas').getContext('2d')
    }
    catch
    {
      probe = null
    }
  }
  if (!probe)
  {
    return null
  }
  probe.fillStyle = 'transparent'
  const sentinel = String(probe.fillStyle)
  probe.fillStyle = value
  const normalized = String(probe.fillStyle)
  return normalized === sentinel ? null : parseColor(normalized)
}

/** One token's channels: parsed directly, else through the canvas, else the neutral gray. */
export function tokenColor(name: TokenName, read: (name: TokenName) => string = (token) => readToken(token)): Rgb
{
  const value = read(name)
  if (value === '')
  {
    return UNREAD
  }
  return parseColor(value) ?? resolveThroughCanvas(value) ?? UNREAD
}

/** Reads the palette from the document's tokens; call it once per mount, since the tokens do not change while drawing. */
export function readVizPalette(read?: (name: TokenName) => string): VizPalette
{
  const color = (role: keyof typeof PALETTE_TOKENS): Rgb => tokenColor(PALETTE_TOKENS[role], read)
  const viz1 = color('viz1')
  const viz2 = color('viz2')
  const viz3 = color('viz3')
  return {
    ground: color('ground'),
    viz1,
    viz2,
    viz3,
    accent: color('accent'),
    accentInk: color('accentInk'),
    ink: color('ink'),
    ink2: color('ink2'),
    ink3: color('ink3'),
    ring: [viz1, viz3, viz2]
  }
}

/** The color `t` of the way from `a` to `b`, with `t` clamped to 0..1. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb
{
  const k = Math.max(0, Math.min(1, t))
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** A canvas color string, `#rrggbb` when opaque and `#rrggbbaa` otherwise; alpha is clamped to 0..1. */
export function css(color: Rgb, alpha = 1): string
{
  const base = `#${hexByte(color[0])}${hexByte(color[1])}${hexByte(color[2])}`
  const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
  return a >= 1 ? base : `${base}${hexByte(a * 255)}`
}

/** The ring color at `degrees`, which wraps every 360 like a hue, blending between neighboring stops. */
export function ringColor(palette: VizPalette, degrees: number): Rgb
{
  const stops = palette.ring
  const turn = (((Number.isFinite(degrees) ? degrees : 0) % 360) + 360) % 360
  const position = (turn / 360) * stops.length
  const index = Math.floor(position)
  return mix(stops[index % stops.length], stops[(index + 1) % stops.length], position - index)
}

/** Lightens or darkens a color the way HSL lightness would: 50 keeps it, 0 reaches the ground, 100 reaches the ink. */
export function shade(palette: VizPalette, color: Rgb, light: number): Rgb
{
  const l = Math.max(0, Math.min(100, Number.isFinite(light) ? light : 50))
  return l <= 50 ? mix(palette.ground, color, l / 50) : mix(color, palette.ink, (l - 50) / 50)
}

/** The ring color at `degrees` at a lightness from 0 to 100, as channels for pixel buffers. */
export function toneRgb(palette: VizPalette, degrees: number, light = 50): Rgb
{
  return shade(palette, ringColor(palette, degrees), light)
}

/**
 * The palette's stand-in for an hsla color with hue `degrees`: the ring color at `degrees`, shaded to `light`
 * from 0 to 100, at `alpha` from 0 to 1. Saturation has no stand-in, since the ring is the whole range of color.
 */
export function tone(palette: VizPalette, degrees: number, light = 50, alpha = 1): string
{
  return css(toneRgb(palette, degrees, light), alpha)
}
