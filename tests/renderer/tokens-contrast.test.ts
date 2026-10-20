/**
 * Color token contrast. Parses tokens.css, composites every wash and opaque mix the way Chromium paints it
 * (source-over in gamma-encoded sRGB, each channel rounded half up to 8 bits), and holds every pair the
 * stacking model generates to its WCAG 2.x floor. Also keeps the main process window paint equal to the
 * ground token, keeps data series and status inks apart under color vision deficiencies (Machado, Oliveira,
 * and Fernandes 2009 at severity 1.0 in linear RGB, OKLab distance x100), and keeps the legacy remap legible.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUND_HEX } from '../../src/main/theme'
import {
  CAPTION_INK,
  EXEMPTIONS,
  LEGACY_FILLS,
  LEGACY_TEXT,
  LEGACY_TEXT_FLOOR,
  SEPARATIONS,
  exemptionFor,
  generatePairs,
  stateSurfaces,
  type Surface
} from './tokens/contrast-model'

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/renderer/src/styles')

/** Opaque alpha in basis points; alpha is kept as an integer so rounding stays exact. */
const OPAQUE = 10000

interface Rgba
{
  r: number
  g: number
  b: number
  a: number
}

type Resolve = (name: string) => Rgba
type Vision = 'normal' | 'protan' | 'deutan' | 'tritan'
type Lab = [number, number, number]

const MACHADO: Record<Exclude<Vision, 'normal'>, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
}

function readStyles(file: string): string
{
  return fs.readFileSync(path.join(STYLES, file), 'utf8')
}

/** Every `--color-*` declaration in a stylesheet, keyed by token name; a repeated name is an error. */
function colorDeclarations(css: string): Map<string, string>
{
  const out = new Map<string, string>()
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g))
  {
    if (out.has(m[1])) throw new Error(`--color-${m[1]} is declared twice`)
    out.set(m[1], m[2].replace(/\s+/g, ' ').trim())
  }
  return out
}

function percentToAlpha(text: string): number
{
  const value = Number(text)
  if (!(value >= 0 && value <= 100)) throw new Error(`percentage out of range: ${text}`)
  return Math.round(value * 100)
}

function requireOpaque(color: Rgba, what: string): Rgba
{
  if (color.a !== OPAQUE) throw new Error(`${what} must be opaque`)
  return color
}

/** Source-over of `top` on an opaque `bottom`, per channel, rounded half up to 8 bits. */
function composite(top: Rgba, bottom: Rgba): Rgba
{
  requireOpaque(bottom, 'a composite base')
  const blend = (t: number, b: number): number => Math.floor((2 * (t * top.a + b * (OPAQUE - top.a)) + OPAQUE) / (2 * OPAQUE))
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a: OPAQUE }
}

function parseColor(value: string, resolve: Resolve): Rgba
{
  let m = /^#([0-9a-f]{6})$/i.exec(value)
  if (m)
  {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: OPAQUE }
  }
  m = /^var\(--color-([a-z0-9-]+)\)$/.exec(value)
  if (m) return resolve(m[1])
  m = /^color-mix\(in oklab, var\(--color-([a-z0-9-]+)\) (\d+(?:\.\d+)?)%, transparent\)$/.exec(value)
  if (m) return { ...requireOpaque(resolve(m[1]), `--color-${m[1]}`), a: percentToAlpha(m[2]) }
  m = /^color-mix\(in srgb, var\(--color-([a-z0-9-]+)\) (\d+(?:\.\d+)?)%, var\(--color-([a-z0-9-]+)\)\)$/.exec(value)
  if (m)
  {
    const top = { ...requireOpaque(resolve(m[1]), `--color-${m[1]}`), a: percentToAlpha(m[2]) }
    return composite(top, requireOpaque(resolve(m[3]), `--color-${m[3]}`))
  }
  m = /^rgb\((\d{1,3}) (\d{1,3}) (\d{1,3}) \/ (\d*\.?\d+)\)$/.exec(value)
  if (m)
  {
    const [r, g, b, alpha] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if ([r, g, b].some((c) => c > 255) || alpha > 1) throw new Error(`rgb() out of range: ${value}`)
    return { r, g, b, a: Math.round(alpha * OPAQUE) }
  }
  throw new Error(`unsupported color value "${value}"`)
}

/** Resolves token names to colors, following `var()` references; unknown forms and cycles throw. */
function createResolver(declarations: Map<string, string>): Resolve
{
  const cache = new Map<string, Rgba>()
  const pending = new Set<string>()
  const resolve: Resolve = (name) =>
  {
    const known = cache.get(name)
    if (known) return known
    const value = declarations.get(name)
    if (value === undefined) throw new Error(`--color-${name} is not declared`)
    if (pending.has(name)) throw new Error(`--color-${name} refers to itself`)
    pending.add(name)
    try
    {
      const color = parseColor(value, resolve)
      cache.set(name, color)
      return color
    }
    finally
    {
      pending.delete(name)
    }
  }
  return resolve
}

/** The opaque color a surface paints; a layer may also be a Tailwind alpha modifier such as `white/5`. */
function paint(surface: Surface, resolve: Resolve): Rgba
{
  const base = requireOpaque(resolve(surface.base), surface.base)
  if (!surface.layer) return base
  const modifier = /^([a-z0-9-]+)\/(\d+)$/.exec(surface.layer)
  const layer = modifier
    ? { ...requireOpaque(resolve(modifier[1]), modifier[1]), a: percentToAlpha(modifier[2]) }
    : resolve(surface.layer)
  return composite(layer, base)
}

function toHex({ r, g, b }: Rgba): string
{
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
}

function linear(channel: number): number
{
  const s = channel / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance({ r, g, b }: Rgba): number
{
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: Rgba, b: Rgba): number
{
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function oklab([r, g, b]: number[]): Lab
{
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ]
}

function simulate(color: Rgba, vision: Vision): Lab
{
  const v = [linear(color.r), linear(color.g), linear(color.b)]
  if (vision === 'normal') return oklab(v)
  return oklab(MACHADO[vision].map((row) => Math.min(1, Math.max(0, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]))))
}

function separation(a: Rgba, b: Rgba, vision: Vision): number
{
  const [p, q] = [simulate(a, vision), simulate(b, vision)]
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

const tokens = colorDeclarations(readStyles('tokens.css'))
const resolve = createResolver(tokens)

describe('color tokens', () =>
{
  it('declares every color token in a form the model can composite', () =>
  {
    expect(tokens.size).toBeGreaterThan(50)
    for (const name of tokens.keys())
    {
      expect(() => resolve(name), `--color-${name}`).not.toThrow()
    }
  })

  it('paints the window ground in main with the ground token', () =>
  {
    expect(tokens.get('ground')).toBe(GROUND_HEX)
    expect(toHex(resolve('ground'))).toBe(GROUND_HEX)
  })

  it('reproduces the label grounds and state composites as they are painted', () =>
  {
    const tokenColors: Record<string, string> = {
      'held-warning': '#2e1c13',
      'held-error': '#2c1515',
      'stamp-verified': '#191c17',
      'stamp-returned': '#1f1211',
      'danger-hover': '#3c2423',
      'danger-pressed': '#472626'
    }
    for (const [name, expected] of Object.entries(tokenColors))
    {
      expect(toHex(resolve(name)), name).toBe(expected)
    }

    const composites: Array<[base: string, layer: string, expected: string]> = [
      ['ground', 'wash-hover', '#191817'],
      ['ground', 'wash-pressed', '#201f1d'],
      ['ground', 'wash-selected', '#291f12'],
      ['ground', 'wash-selected-hover', '#322615'],
      ['panel', 'wash-hover', '#201f1d'],
      ['panel', 'wash-selected', '#2f2619'],
      ['panel', 'wash-selected-hover', '#382c1b'],
      ['rail', 'wash-hover', '#251d17'],
      ['rail', 'wash-selected', '#332412'],
      ['overlay', 'wash-hover', '#2b2927'],
      ['ground', 'text-selection', '#563f1e'],
      ['panel', 'text-selection', '#5b4423'],
      ['sunken', 'text-selection', '#523b1a'],
      ['overlay', 'text-selection', '#644c2a'],
      ['sunken', 'viz-band', '#161514'],
      ['ground', 'wash-warning', '#251811'],
      ['ground', 'wash-error', '#241313'],
      ['ground', 'wash-running', '#191d20'],
      ['ground', 'wash-verified', '#1c2019'],
      ['panel', 'wash-warning', '#2b1e17'],
      ['panel', 'wash-error', '#2a1919'],
      ['panel', 'wash-running', '#202327'],
      ['panel', 'wash-verified', '#222720']
    ]
    for (const [base, layer, expected] of composites)
    {
      expect(toHex(paint({ name: `${base} + ${layer}`, base, layer }, resolve)), `${base} + ${layer}`).toBe(expected)
    }
  })

  it('keeps every generated pair at or above its floor', () =>
  {
    const failures: string[] = []
    let measured = 0
    for (const pair of generatePairs())
    {
      if (pair.floor === null || exemptionFor(pair)) continue
      const ratio = contrast(requireOpaque(resolve(pair.fg), pair.fg), paint(pair.bg, resolve))
      measured++
      if (ratio < pair.floor)
      {
        failures.push(`${pair.fg} on ${pair.bg.name} (${pair.role}): ${ratio.toFixed(3)} is below ${pair.floor}`)
      }
    }
    expect(measured).toBeGreaterThan(300)
    expect(failures).toEqual([])
  })

  it('measures disabled ink on every ground and state without holding it to a floor', () =>
  {
    const disabled = generatePairs().filter((p) => p.fg === 'ink-disabled')
    expect(disabled).toHaveLength(stateSurfaces().length)
    expect(disabled.every((p) => p.floor === null)).toBe(true)
    for (const pair of disabled)
    {
      expect(contrast(resolve(pair.fg), paint(pair.bg, resolve))).toBeGreaterThan(2)
    }
  })

  it('holds every control boundary to its floor, with no exemption', () =>
  {
    const exempt = generatePairs().filter((p) => exemptionFor(p))
    expect(exempt).toEqual([])
  })

  it('covers every token with a generated pair or a documented exemption', () =>
  {
    const covered = new Set<string>()
    const visit = (name: string): void =>
    {
      if (covered.has(name)) return
      covered.add(name)
      for (const m of (tokens.get(name) ?? '').matchAll(/var\(--color-([a-z0-9-]+)\)/g)) visit(m[1])
    }
    for (const pair of generatePairs())
    {
      visit(pair.fg)
      visit(pair.bg.base)
      if (pair.bg.layer) visit(pair.bg.layer)
    }
    for (const exemption of EXEMPTIONS)
    {
      expect(exemption.reason.length).toBeGreaterThan(20)
      for (const name of exemption.tokens)
      {
        expect(tokens.has(name), `exempt token --color-${name} is declared`).toBe(true)
        covered.add(name)
      }
    }
    expect([...tokens.keys()].filter((name) => !covered.has(name))).toEqual([])
  })

  it('keeps the caption ink at 7:1 on every ground and state', () =>
  {
    for (const surface of stateSurfaces())
    {
      const ratio = contrast(resolve(CAPTION_INK.token), paint(surface, resolve))
      expect(ratio, surface.name).toBeGreaterThanOrEqual(CAPTION_INK.floor)
    }
  })

  it('keeps data series and status inks apart for every vision type', () =>
  {
    for (const { a, b, ...floors } of SEPARATIONS)
    {
      for (const [vision, floor] of Object.entries(floors) as Array<[Vision, number]>)
      {
        expect(separation(resolve(a), resolve(b), vision), `${a} vs ${b}, ${vision}`).toBeGreaterThanOrEqual(floor)
      }
    }
  })
})

describe('color token parser', () =>
{
  it('rejects a value form it cannot composite, also behind an alias', () =>
  {
    const r = createResolver(new Map([['x', 'oklch(0.5 0.1 120)'], ['y', 'var(--color-x)'], ['z', 'hsl(0 0% 50%)']]))
    expect(() => r('x')).toThrow(/unsupported color value/)
    expect(() => r('y')).toThrow(/unsupported color value/)
    expect(() => r('z')).toThrow(/unsupported color value/)
  })

  it('rejects unknown, circular, and translucent references where an opaque color is required', () =>
  {
    const r = createResolver(new Map([
      ['loop', 'var(--color-loop)'],
      ['missing', 'var(--color-nowhere)'],
      ['wash', 'color-mix(in oklab, #ffffff 10%, transparent)'],
      ['glass', 'rgb(1 2 3 / 0.5)'],
      ['double', 'color-mix(in oklab, var(--color-glass) 10%, transparent)'],
      ['range', 'rgb(300 0 0 / 1)']
    ]))
    expect(() => r('loop')).toThrow(/refers to itself/)
    expect(() => r('missing')).toThrow(/not declared/)
    expect(() => r('wash')).toThrow(/unsupported color value/)
    expect(() => r('double')).toThrow(/must be opaque/)
    expect(() => r('range')).toThrow(/out of range/)
    expect(r('glass')).toEqual({ r: 1, g: 2, b: 3, a: 5000 })
  })

  it('rejects a token declared twice', () =>
  {
    expect(() => colorDeclarations(':root { --color-a: #000000; --color-a: #ffffff; }')).toThrow(/declared twice/)
  })

  it('ignores declarations inside comments and normalizes whitespace and line endings', () =>
  {
    const parsed = colorDeclarations('/* --color-ghost: #000000; */\r\n  --color-mix:\r\n    color-mix(in oklab,  var(--color-a) 5%,\ttransparent);\r\n')
    expect([...parsed]).toEqual([['mix', 'color-mix(in oklab, var(--color-a) 5%, transparent)']])
  })
})

describe('legacy remap', () =>
{
  const legacy = colorDeclarations(readStyles('legacy-remap.css'))
  const resolveLegacy = createResolver(new Map([...tokens, ...legacy]))

  it('points every remapped legacy color at a token or an opaque value', () =>
  {
    expect([...legacy.keys()].filter((name) => tokens.has(name))).toEqual([])
    for (const name of legacy.keys())
    {
      expect(resolveLegacy(name).a, `--color-${name}`).toBe(OPAQUE)
    }
  })

  it('keeps every legacy text step legible on the legacy fills that carry text', () =>
  {
    const failures: string[] = []
    for (const text of LEGACY_TEXT)
    {
      for (const fill of LEGACY_FILLS)
      {
        const ratio = contrast(resolveLegacy(text), paint(fill, resolveLegacy))
        if (ratio < LEGACY_TEXT_FLOOR) failures.push(`${text} on ${fill.name}: ${ratio.toFixed(3)}`)
      }
    }
    expect(failures).toEqual([])
  })
})
