/**
 * Every visualization draws only palette colors: each draw function runs for several frames of silence and
 * of a loud beat against a recording 2D context, and every color it sets (fills, strokes, shadows, gradient
 * stops, and plasma pixels) must be a hex string or `transparent` inside the palette's channel bounds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  css,
  drawBars,
  drawDMT,
  drawHorizon,
  drawMilkdrop,
  drawPlasma,
  drawRain,
  drawSpace,
  drawWave,
  readVizPalette,
  type AudioFeatures,
  type DMTState,
  type MilkdropState,
  type PlasmaState,
  type RainState,
  type SpaceState,
  type VizPalette
} from '@renderer/visualizations'
import * as visualizations from '@renderer/visualizations'

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/

/** Channels kept inside 16..224 so pure white, pure black, and the old saturated violets all fall outside. */
const TOKENS: Record<string, string> = {
  '--color-sunken': '#101418',
  '--color-viz-1': '#40a0e0',
  '--color-viz-2': '#d0d4d8',
  '--color-viz-3': '#50c080',
  '--color-accent': '#3090d0',
  '--color-accent-ink': '#40a0e0',
  '--color-ink': '#dcdee0',
  '--color-ink-2': '#b0b4b8',
  '--color-ink-3': '#808890'
}

const W = 320
const H = 180

class FakeGradient
{
  readonly stops: Array<[number, string]> = []
  private readonly record: (color: unknown) => void

  constructor(record: (color: unknown) => void)
  {
    this.record = record
  }

  addColorStop(offset: number, color: string): void
  {
    this.stops.push([offset, color])
    this.record(color)
  }
}

interface FakeImageData
{
  width: number
  height: number
  data: Uint8ClampedArray
}

/** The drawing calls that only need to be accepted and counted. */
const PLAIN_CALLS = [
  'fillRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'ellipse', 'roundRect',
  'quadraticCurveTo', 'bezierCurveTo', 'stroke', 'fill', 'fillText', 'putImageData', 'drawImage', 'save',
  'restore', 'translate', 'rotate', 'scale', 'setTransform'
] as const

/** A 2D context that records every color it is given and accepts every call the draw functions make. */
class FakeContext
{
  readonly colors: unknown[] = []
  readonly images: FakeImageData[] = []
  readonly calls = new Map<string, number>()
  lineWidth = 1
  shadowBlur = 0
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  font = '12px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  lineCap = 'butt'
  lineJoin = 'miter'
  imageSmoothingEnabled = true
  imageSmoothingQuality = 'low'
  private fillValue: unknown = '#000000'
  private strokeValue: unknown = '#000000'
  private shadowValue: unknown = 'transparent'

  constructor(readonly canvas: HTMLCanvasElement)
  {
    for (const name of PLAIN_CALLS)
    {
      (this as unknown as Record<string, () => void>)[name] = (): void =>
      {
        this.count(name)
      }
    }
  }

  get fillStyle(): unknown
  {
    return this.fillValue
  }

  set fillStyle(value: unknown)
  {
    this.colors.push(value)
    this.fillValue = value
  }

  get strokeStyle(): unknown
  {
    return this.strokeValue
  }

  set strokeStyle(value: unknown)
  {
    this.colors.push(value)
    this.strokeValue = value
  }

  get shadowColor(): unknown
  {
    return this.shadowValue
  }

  set shadowColor(value: unknown)
  {
    this.colors.push(value)
    this.shadowValue = value
  }

  private count(name: string): void
  {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1)
  }

  createLinearGradient(): FakeGradient
  {
    this.count('createLinearGradient')
    return new FakeGradient((color) => this.colors.push(color))
  }

  createRadialGradient(): FakeGradient
  {
    this.count('createRadialGradient')
    return new FakeGradient((color) => this.colors.push(color))
  }

  createImageData(width: number, height: number): FakeImageData
  {
    this.count('createImageData')
    const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    this.images.push(image)
    return image
  }

  getImageData(_x: number, _y: number, width: number, height: number): FakeImageData
  {
    this.count('getImageData')
    return { width, height, data: new Uint8ClampedArray(width * height * 4) }
  }

  measureText(text: string): { width: number }
  {
    this.count('measureText')
    return { width: text.length * 8 }
  }
}

function quiet(): AudioFeatures
{
  return {
    sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
    overall: 0, beat: 0, midBeat: 0, isBeat: false, beatCount: 0,
    centroid: 0, brightness: 0, flux: 0, rms: 0
  }
}

function loud(beatCount: number): AudioFeatures
{
  return {
    sub: 0.85, bass: 0.9, lowMid: 0.7, mid: 0.75, highMid: 0.65, treble: 0.7,
    overall: 0.8, beat: 0.95, midBeat: 0.6, isBeat: true, beatCount,
    centroid: 3200, brightness: 0.55, flux: 0.6, rms: 0.7
  }
}

interface Frame
{
  audio: AudioFeatures
  freq: Uint8Array
  time: Uint8Array
}

function frames(): Frame[]
{
  const silentFreq = new Uint8Array(2048)
  const silentTime = new Uint8Array(4096).fill(128)
  const loudFreq = new Uint8Array(2048).map((_, i) => Math.max(0, 255 - Math.floor(i / 6)))
  const loudTime = new Uint8Array(4096).map((_, i) => 128 + Math.round(110 * Math.sin(i * 0.05)))
  const out: Frame[] = []
  for (let i = 0; i < 3; i++)
  {
    out.push({ audio: quiet(), freq: silentFreq, time: silentTime })
  }
  for (let i = 0; i < 5; i++)
  {
    out.push({ audio: loud(i + 1), freq: loudFreq, time: loudTime })
  }
  out.push({ audio: quiet(), freq: silentFreq, time: silentTime })
  return out
}

function dmtState(): DMTState
{
  return {
    hueBase: 0,
    tunnelDepth: 0,
    particles: Array.from({ length: 120 }, (_, i) => ({
      angle: (i / 120) * Math.PI * 2,
      radius: 0.05 + (i % 10) * 0.08,
      speed: 0.003 + (i % 5) * 0.003,
      hueOff: (i * 37) % 360,
      size: 0.5 + (i % 4) * 0.6,
      layer: i % 3,
      brightness: 0.5 + (i % 2) * 0.5
    })),
    orbs: Array.from({ length: 8 }, (_, i) => ({ x: 0.1 * i - 0.3, y: 0.2, vx: 0.002, vy: -0.002, radius: 10, hue: i * 45, pulse: 0, life: 1 })),
    eyes: Array.from({ length: 6 }, (_, i) => ({ orbitRadius: 0.18 + i * 0.07, angle: i, speed: 0.01, size: 12, pupilPhase: 0, irisHue: i * 60, blinkPhase: 0 })),
    kaleidoAngle: 0,
    wingPhase: 0,
    shockwaves: [],
    trailCanvas: null,
    trailCtx: null
  }
}

function spaceState(): SpaceState
{
  return {
    stars: Array.from({ length: 600 }, (_, i) =>
    {
      const tier = i % 3
      const r = 0.05 + ((i * 0.618) % 1) * 1.3
      const a = (i % 4) * Math.PI * 0.5 + r * Math.PI * 2.5
      return {
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        z: 0.05 + ((i * 0.381) % 1) * 0.95,
        speed: tier === 0 ? 0.0003 : tier === 1 ? 0.001 : 0.003,
        brightness: 0.4 + ((i * 0.27) % 1) * 0.6,
        hue: 195 + ((i * 13) % 70),
        baseSize: tier === 0 ? 0.6 : tier === 1 ? 1.4 : 2.6
      }
    }),
    rotation: 0,
    warpSpeed: 0,
    nebulaPhase: 0,
    coreGlow: 0.5
  }
}

function milkdropState(): MilkdropState
{
  return { waveHistory: [], presetPhase: 0, morphT: 0, rot: 0, zoom: 1, hueShift: 0, feedbackCanvas: null, feedbackCtx: null }
}

function plasmaState(): PlasmaState
{
  return {
    t: 0,
    hueBase: 0,
    blobs: Array.from({ length: 6 }, (_, i) => ({ x: i, y: i * 0.7, sx: 0.008, sy: 0.006, hue: i * 60 }))
  }
}

function rainState(): RainState
{
  return { t: 0, fontSize: 14, columns: [] }
}

type Runner = (ctx: CanvasRenderingContext2D, frame: Frame, palette: VizPalette) => void

function runners(): Record<string, Runner>
{
  const smooth = new Float32Array(128)
  const peaks = new Float32Array(128)
  const peakVel = new Float32Array(128)
  const dmt = dmtState()
  const space = spaceState()
  const milkdrop = milkdropState()
  const plasma = plasmaState()
  const rain = rainState()
  return {
    bars: (ctx, f, p) => drawBars(ctx, f.freq, smooth, peaks, peakVel, W, H, f.audio, p),
    wave: (ctx, f, p) => drawWave(ctx, f.freq, f.time, W, H, f.audio, p),
    horizon: (ctx, f, p) => drawHorizon(ctx, f.freq, f.time, W, H, f.audio, p),
    dmt: (ctx, f, p) => drawDMT(ctx, f.freq, f.time, W, H, dmt, f.audio, p),
    space: (ctx, f, p) => drawSpace(ctx, f.freq, f.time, W, H, space, f.audio, p),
    milkdrop: (ctx, f, p) => drawMilkdrop(ctx, f.freq, f.time, W, H, milkdrop, f.audio, p),
    plasma: (ctx, f, p) => drawPlasma(ctx, f.freq, f.time, W, H, plasma, f.audio, p),
    rain: (ctx, f, p) => drawRain(ctx, f.freq, f.time, W, H, rain, f.audio, p)
  }
}

const MODES = Object.keys(runners())

function bounds(palette: VizPalette): Array<[number, number]>
{
  const roles = [palette.ground, palette.viz1, palette.viz2, palette.viz3, palette.accent, palette.accentInk, palette.ink, palette.ink2, palette.ink3]
  return [0, 1, 2].map((c) => [Math.min(...roles.map((r) => r[c])), Math.max(...roles.map((r) => r[c]))])
}

function channels(hex: string): number[]
{
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

let fake: FakeContext
let palette: VizPalette

beforeEach(() =>
{
  palette = readVizPalette((name) => TOKENS[name] ?? '')
  fake = new FakeContext(document.createElement('canvas'))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fake as never)
})

afterEach(() =>
{
  vi.restoreAllMocks()
})

function run(mode: string): FakeContext
{
  const draw = runners()[mode]
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 16))
  for (const frame of frames())
  {
    draw(fake as unknown as CanvasRenderingContext2D, frame, palette)
  }
  return fake
}

describe('visualization colors', () =>
{
  it('exports every draw function and no idle drawing', () =>
  {
    expect(MODES).toEqual(['bars', 'wave', 'horizon', 'dmt', 'space', 'milkdrop', 'plasma', 'rain'])
    expect('drawIdle' in visualizations).toBe(false)
    expect(typeof visualizations.readVizPalette).toBe('function')
    expect(typeof visualizations.tone).toBe('function')
  })

  for (const mode of MODES)
  {
    it(`${mode} sets only hex palette colors, transparent, or gradients`, () =>
    {
      const ctx = run(mode)
      expect(ctx.colors.length + ctx.images.length, `${mode} drew nothing`).toBeGreaterThan(0)
      const box = bounds(palette)
      for (const color of ctx.colors)
      {
        if (color instanceof FakeGradient || color === 'transparent')
        {
          continue
        }
        expect(typeof color, String(color)).toBe('string')
        expect(color as string, mode).toMatch(HEX)
        channels(color as string).forEach((value, c) =>
        {
          expect(value, `${mode} ${String(color)} channel ${c}`).toBeGreaterThanOrEqual(box[c][0])
          expect(value, `${mode} ${String(color)} channel ${c}`).toBeLessThanOrEqual(box[c][1])
        })
      }
    })
  }

  it('plasma writes opaque pixels inside the palette bounds', () =>
  {
    const ctx = run('plasma')
    expect(ctx.images.length).toBe(frames().length)
    const box = bounds(palette)
    for (const image of ctx.images)
    {
      expect(image.width).toBe(Math.ceil(W / 6))
      expect(image.height).toBe(Math.ceil(H / 6))
      for (let i = 0; i < image.data.length; i += 4)
      {
        for (let c = 0; c < 3; c++)
        {
          expect(image.data[i + c]).toBeGreaterThanOrEqual(box[c][0])
          expect(image.data[i + c]).toBeLessThanOrEqual(box[c][1])
        }
        expect(image.data[i + 3]).toBe(255)
      }
    }
    expect(ctx.calls.get('putImageData')).toBe(frames().length)
  })

  it('paints the stage ground behind Space and Wave and fades the feedback modes toward it', () =>
  {
    const ground = css(palette.ground)
    for (const mode of ['space', 'wave'])
    {
      fake = new FakeContext(document.createElement('canvas'))
      expect(run(mode).colors, mode).toContain(ground)
    }
    for (const mode of ['dmt', 'milkdrop', 'rain'])
    {
      fake = new FakeContext(document.createElement('canvas'))
      const fades = run(mode).colors.filter((c) => typeof c === 'string' && c.startsWith(ground) && c.length === 9)
      expect(fades.length, mode).toBeGreaterThan(0)
    }
  })

  it('draws peak dots in viz-2 and quiet bars in the accent', () =>
  {
    const ctx = run('bars')
    const strings = ctx.colors.filter((c): c is string => typeof c === 'string')
    expect(strings.some((c) => c.startsWith(css(palette.viz2)))).toBe(true)
    expect(strings.some((c) => c.startsWith(css(palette.accent)))).toBe(true)
  })

  it('tints the rain from the green viz-3 tone', () =>
  {
    const ctx = run('rain')
    expect(ctx.calls.get('fillText') ?? 0).toBeGreaterThan(0)
    const greenLeaning = ctx.colors
      .filter((c): c is string => typeof c === 'string' && HEX.test(c))
      .map(channels)
      .filter(([r, g, b]) => g > r && g > b)
    expect(greenLeaning.length).toBeGreaterThan(0)
  })
})
