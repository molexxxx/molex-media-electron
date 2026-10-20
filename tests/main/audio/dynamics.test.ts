/**
 * The compressor anchored to the program (D8): the threshold is the measured integrated loudness plus the
 * offset, written with a dB suffix and clamped to acompressor's range of 0.000976563 to 1 (-60.2 to 0 dB), with
 * no makeup gain. Both clamp limits ran on 2022 and 9.0.2 with exit 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ACOMPRESSOR_RANGES, COMPRESSOR_KNEE, NIGHT, compressorStage } from '../../../src/main/ffmpeg/audio/dynamics'
import { NIGHT_DYNAMICS } from '../../../src/shared/audio/presets'

const CHAIN_FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'downmix', 'chains')

function options(stage: string): Record<string, string>
{
  return Object.fromEntries(stage.slice('acompressor='.length).split(':').map((pair) => pair.split('=') as [string, string]))
}

function linear(dbText: string): number
{
  return 10 ** (Number(dbText.replace(/dB$/, '')) / 20)
}

describe('NIGHT', () =>
{
  it('is the night listening preset: threshold at the program loudness, 3:1, 25 ms attack, 300 ms release', () =>
  {
    expect(NIGHT).toBe(NIGHT_DYNAMICS)
    expect(NIGHT).toEqual({ thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 300 })
  })
})

describe('compressorStage', () =>
{
  it('writes the documented night stage for a program measured at -22.6 LUFS', () =>
  {
    expect(compressorStage(NIGHT, -22.6)).toBe('acompressor=threshold=-22.60dB:ratio=3:attack=25:release=300:knee=2.8284:detection=rms:link=maximum')
  })

  it.each([
    [-23, 0, '-23.00dB'],
    [-18.04, 0, '-18.04dB'],
    [-20, -4, '-24.00dB'],
    [-30, 6, '-24.00dB'],
    [-14.2, 2.5, '-11.70dB']
  ])('anchors the threshold on the program: %d LUFS with offset %d is %s', (measured, offset, threshold) =>
  {
    expect(options(compressorStage({ ...NIGHT, thresholdOffsetDb: offset }, measured)).threshold).toBe(threshold)
  })

  it.each([
    [-60.2, '-60.20dB'],
    [-60.21, '-60.20dB'],
    [-75, '-60.20dB'],
    [Number.NEGATIVE_INFINITY, '-60.20dB'],
    [0, '0.00dB'],
    [3, '0.00dB'],
    [Number.POSITIVE_INFINITY, '0.00dB'],
    [Number.NaN, '0.00dB']
  ])('clamps a threshold of %d to %s, inside the option range once converted', (measured, threshold) =>
  {
    const written = options(compressorStage(NIGHT, measured)).threshold
    expect(written).toBe(threshold)
    expect(linear(written)).toBeGreaterThanOrEqual(0.000976563)
    expect(linear(written)).toBeLessThanOrEqual(1)
  })

  it('writes the threshold with a dB suffix and has no makeup gain, since linear gain sets the level after it', () =>
  {
    const stage = options(compressorStage(NIGHT, -20))
    expect(stage.threshold).toMatch(/^-?\d+\.\d{2}dB$/)
    expect(stage.makeup).toBeUndefined()
    expect(Object.keys(stage)).toEqual(['threshold', 'ratio', 'attack', 'release', 'knee', 'detection', 'link'])
  })

  it('detects RMS, links on the loudest channel, and writes the knee out', () =>
  {
    const stage = options(compressorStage(NIGHT, -20))
    expect(stage.detection).toBe('rms')
    expect(stage.link).toBe('maximum')
    expect(stage.knee).toBe(String(COMPRESSOR_KNEE))
  })

  it('keeps ratio, attack, and release inside the option ranges', () =>
  {
    const extreme = options(compressorStage({ thresholdOffsetDb: 0, ratio: 50, attackMs: 0.001, releaseMs: 20000 }, -20))
    expect(extreme.ratio).toBe(String(ACOMPRESSOR_RANGES.ratio.max))
    expect(extreme.attack).toBe(String(ACOMPRESSOR_RANGES.attackMs.min))
    expect(extreme.release).toBe(String(ACOMPRESSOR_RANGES.releaseMs.max))
    const low = options(compressorStage({ thresholdOffsetDb: 0, ratio: 0.5, attackMs: 5000, releaseMs: 0 }, -20))
    expect(low.ratio).toBe('1')
    expect(low.attack).toBe('2000')
    expect(low.release).toBe('0.01')
  })

  it('both clamp limits ran on 2022 and 9.0.2 with exit 0', () =>
  {
    for (const build of ['2022-10-13', '9.0.2'])
    {
      const manifest = JSON.parse(fs.readFileSync(path.join(CHAIN_FIXTURES, build, 'runs.json'), 'utf8')) as
        { runs: Array<{ name: string; argv: string[]; code: number }> }
      for (const [name, threshold] of [['night-threshold-floor', '-60.20dB'], ['night-threshold-top', '0.00dB']])
      {
        const run = manifest.runs.find((candidate) => candidate.name === name)
        expect(run?.code, `${build} ${name}`).toBe(0)
        expect(run?.argv.join(' '), `${build} ${name}`).toContain(`acompressor=threshold=${threshold}:`)
      }
    }
  })
})
