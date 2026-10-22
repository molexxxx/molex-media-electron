/**
 * The visualization palette: color parsing, token reads, and the mixing, shading, and ring helpers every
 * draw function colors with.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PALETTE_TOKENS,
  css,
  mix,
  parseColor,
  readVizPalette,
  ringColor,
  shade,
  tokenColor,
  tone,
  toneRgb,
  type Rgb,
  type VizPalette
} from '@renderer/visualizations/palette'
import type { TokenName } from '@renderer/ui/tokens'

const GRAY: Rgb = [128, 128, 128]

const TOKENS: Record<string, string> = {
  '--color-sunken': '#08090a',
  '--color-viz-1': '#66d2ff',
  '--color-viz-2': '#e8ebf0',
  '--color-viz-3': '#5fd68a',
  '--color-accent': '#4fc3f7',
  '--color-accent-ink': '#66d2ff',
  '--color-ink': '#eceef1',
  '--color-ink-2': '#babfc8',
  '--color-ink-3': '#9096a1'
}

function reader(map: Record<string, string>): (name: TokenName) => string
{
  return (name) => map[name] ?? ''
}

function testPalette(): VizPalette
{
  const ground: Rgb = [0, 0, 0]
  const a: Rgb = [100, 0, 0]
  const b: Rgb = [0, 100, 0]
  const c: Rgb = [0, 0, 100]
  return {
    ground,
    viz1: a,
    viz2: c,
    viz3: b,
    accent: a,
    accentInk: a,
    ink: [200, 200, 200],
    ink2: [150, 150, 150],
    ink3: [120, 120, 120],
    ring: [a, b, c]
  }
}

function close(actual: Rgb, expected: readonly number[]): void
{
  expect(actual).toHaveLength(3)
  actual.forEach((channel, i) => expect(channel).toBeCloseTo(expected[i], 6))
}

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('parseColor', () =>
{
  it('reads 3, 6, and 8 digit hex in either case, ignoring the alpha pair', () =>
  {
    expect(parseColor('#abc')).toEqual([170, 187, 204])
    expect(parseColor('#4fc3f7')).toEqual([79, 195, 247])
    expect(parseColor('#4FC3F7')).toEqual([79, 195, 247])
    expect(parseColor('#4fc3f780')).toEqual([79, 195, 247])
    expect(parseColor('  #08090a\n')).toEqual([8, 9, 10])
  })

  it('reads the comma and space forms of the rgb functions, rounding and clamping channels', () =>
  {
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual([10, 20, 30])
    expect(parseColor('rgb(1 2 3)')).toEqual([1, 2, 3])
    expect(parseColor('rgb(4 5 6 / 50%)')).toEqual([4, 5, 6])
    expect(parseColor('RGB(7, 8, 9)')).toEqual([7, 8, 9])
    expect(parseColor('rgb(300, 12.6, 0.4)')).toEqual([255, 13, 0])
  })

  it('returns null for anything else', () =>
  {
    for (const value of ['', 'red', 'transparent', '#12', '#1234', '#12345', '#1234567', '#ggg', 'hsl(0 0% 0%)', 'rgb()', 'rgb(1, 2)', 'color-mix(in oklab, red, blue)'])
    {
      expect(parseColor(value), value).toBeNull()
    }
  })
})

describe('tokenColor', () =>
{
  it('parses the value the reader returns', () =>
  {
    expect(tokenColor('--color-viz-3', reader(TOKENS))).toEqual([95, 214, 138])
    expect(tokenColor('--x', () => 'rgb(1, 2, 3)')).toEqual([1, 2, 3])
  })

  it('gives the neutral gray for an empty value', () =>
  {
    expect(tokenColor('--color-missing', reader(TOKENS))).toEqual(GRAY)
  })

  it('passes the token name to the reader', () =>
  {
    const read = vi.fn(() => '#ffffff')
    tokenColor('--color-ink', read)
    expect(read).toHaveBeenCalledWith('--color-ink')
  })

  it('reads from the document when no reader is given', () =>
  {
    document.documentElement.style.setProperty('--viz-probe', '#102030')
    try
    {
      expect(tokenColor('--viz-probe')).toEqual([16, 32, 48])
    }
    finally
    {
      document.documentElement.style.removeProperty('--viz-probe')
    }
    expect(tokenColor('--viz-probe-unset')).toEqual(GRAY)
  })
})

describe('tokenColor through the canvas', () =>
{
  async function freshPalette(): Promise<typeof import('@renderer/visualizations/palette')>
  {
    vi.resetModules()
    return import('@renderer/visualizations/palette')
  }

  /** A 2D context whose fillStyle normalizes the values it knows and keeps its last value for the rest, as canvas does. */
  function probeContext(known: Record<string, string>): CanvasRenderingContext2D
  {
    let fill = '#000000'
    return {
      get fillStyle(): string
      {
        return fill
      },
      set fillStyle(value: string)
      {
        if (value in known)
        {
          fill = known[value]
        }
      }
    } as unknown as CanvasRenderingContext2D
  }

  it('resolves values the parser cannot read, such as color-mix, through a canvas', async () =>
  {
    const probe = probeContext({ transparent: 'rgba(0, 0, 0, 0)', 'color-mix(in oklab, red, blue)': '#8c0080' })
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => probe as never)
    const palette = await freshPalette()
    expect(palette.tokenColor('--x', () => 'color-mix(in oklab, red, blue)')).toEqual([140, 0, 128])
    expect(palette.tokenColor('--x', () => 'not a color')).toEqual(GRAY)
    expect(palette.tokenColor('--x', () => 'color-mix(in oklab, red, blue)')).toEqual([140, 0, 128])
    expect(getContext).toHaveBeenCalledTimes(1)
  })

  it('gives the neutral gray when the canvas has no 2D context', async () =>
  {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    const palette = await freshPalette()
    expect(palette.tokenColor('--x', () => 'color-mix(in oklab, red, blue)')).toEqual(GRAY)
  })

  it('gives the neutral gray when creating the canvas throws', async () =>
  {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
    {
      throw new Error('no canvas')
    })
    const palette = await freshPalette()
    expect(palette.tokenColor('--x', () => 'color-mix(in oklab, red, blue)')).toEqual(GRAY)
  })
})

describe('readVizPalette', () =>
{
  it('reads every role from its token and builds the ring from viz-1, viz-3, then viz-2', () =>
  {
    const palette = readVizPalette(reader(TOKENS))
    expect(palette.ground).toEqual([8, 9, 10])
    expect(palette.viz1).toEqual([102, 210, 255])
    expect(palette.viz2).toEqual([232, 235, 240])
    expect(palette.viz3).toEqual([95, 214, 138])
    expect(palette.accent).toEqual([79, 195, 247])
    expect(palette.accentInk).toEqual([102, 210, 255])
    expect(palette.ink).toEqual([236, 238, 241])
    expect(palette.ink2).toEqual([186, 191, 200])
    expect(palette.ink3).toEqual([144, 150, 161])
    expect(palette.ring).toEqual([palette.viz1, palette.viz3, palette.viz2])
  })

  it('reads exactly the tokens it names', () =>
  {
    const read = vi.fn(reader(TOKENS))
    readVizPalette(read)
    expect(read.mock.calls.map(([name]) => name).sort()).toEqual(Object.values(PALETTE_TOKENS).sort())
  })

  it('falls back to the neutral gray for every role when the tokens are unset', () =>
  {
    const palette = readVizPalette(() => '')
    for (const role of Object.keys(PALETTE_TOKENS) as Array<keyof typeof PALETTE_TOKENS>)
    {
      expect(palette[role], role).toEqual(GRAY)
    }
  })
})

describe('mix', () =>
{
  it('blends linearly and clamps the amount to 0..1', () =>
  {
    const a: Rgb = [0, 100, 200]
    const b: Rgb = [100, 200, 0]
    expect(mix(a, b, 0)).toEqual([0, 100, 200])
    expect(mix(a, b, 1)).toEqual([100, 200, 0])
    expect(mix(a, b, 0.25)).toEqual([25, 125, 150])
    expect(mix(a, b, -2)).toEqual([0, 100, 200])
    expect(mix(a, b, 5)).toEqual([100, 200, 0])
  })
})

describe('css', () =>
{
  it('gives #rrggbb when opaque, rounding and clamping channels', () =>
  {
    expect(css([79, 195, 247])).toBe('#4fc3f7')
    expect(css([79, 195, 247], 1)).toBe('#4fc3f7')
    expect(css([79, 195, 247], 2)).toBe('#4fc3f7')
    expect(css([300, -5, 12.6])).toBe('#ff000d')
  })

  it('gives #rrggbbaa below full alpha, clamping alpha and reading NaN as zero', () =>
  {
    expect(css([79, 195, 247], 0.5)).toBe('#4fc3f780')
    expect(css([79, 195, 247], 0)).toBe('#4fc3f700')
    expect(css([79, 195, 247], -1)).toBe('#4fc3f700')
    expect(css([79, 195, 247], Number.NaN)).toBe('#4fc3f700')
    expect(css([0, 0, 0], 0.025)).toBe('#00000006')
  })
})

describe('ringColor', () =>
{
  const palette = testPalette()

  it('lands on each stop at its third of the turn and blends between neighbors', () =>
  {
    close(ringColor(palette, 0), [100, 0, 0])
    close(ringColor(palette, 120), [0, 100, 0])
    close(ringColor(palette, 240), [0, 0, 100])
    close(ringColor(palette, 60), [50, 50, 0])
    close(ringColor(palette, 300), [50, 0, 50])
  })

  it('wraps every 360 degrees, including negative turns', () =>
  {
    close(ringColor(palette, 360), [100, 0, 0])
    close(ringColor(palette, 720), [100, 0, 0])
    close(ringColor(palette, 480), [0, 100, 0])
    close(ringColor(palette, -120), [0, 0, 100])
    close(ringColor(palette, -60), [50, 0, 50])
  })

  it('reads a non-finite turn as zero', () =>
  {
    close(ringColor(palette, Number.NaN), [100, 0, 0])
    close(ringColor(palette, Number.POSITIVE_INFINITY), [100, 0, 0])
  })
})

describe('shade', () =>
{
  const palette = testPalette()
  const color: Rgb = [100, 50, 0]

  it('reaches the ground at 0, keeps the color at 50, and reaches the ink at 100', () =>
  {
    close(shade(palette, color, 0), [0, 0, 0])
    close(shade(palette, color, 50), [100, 50, 0])
    close(shade(palette, color, 100), [200, 200, 200])
    close(shade(palette, color, 25), [50, 25, 0])
    close(shade(palette, color, 75), [150, 125, 100])
  })

  it('clamps the lightness and reads a non-finite one as 50', () =>
  {
    close(shade(palette, color, -20), [0, 0, 0])
    close(shade(palette, color, 140), [200, 200, 200])
    close(shade(palette, color, Number.NaN), [100, 50, 0])
  })
})

describe('tone and toneRgb', () =>
{
  const palette = testPalette()

  it('shades the ring color at a turn, at lightness 50 by default', () =>
  {
    close(toneRgb(palette, 120), [0, 100, 0])
    close(toneRgb(palette, 120, 25), [0, 50, 0])
    close(toneRgb(palette, 0, 100), [200, 200, 200])
  })

  it('formats the shaded ring color at an alpha', () =>
  {
    expect(tone(palette, 0)).toBe('#640000')
    expect(tone(palette, 240, 0)).toBe('#000000')
    expect(tone(palette, 120, 100, 0.5)).toBe('#c8c8c880')
    expect(tone(palette, 360 + 60, 50, 1)).toBe('#323200')
  })
})
