/**
 * Codec-aware true-peak ceilings. Every row of the codec ceiling table with its class and basis, every rate
 * boundary per channel pair (127/128, 159/160, 191/192, and Opus 63/64) for every lossy encoder, the per-pair
 * arithmetic for multichannel streams, and the selection of C, L, the pre-encode gate, and the decoded limit,
 * including Spotify's lower maximum for outputs louder than -14.0 LUFS.
 */
import { describe, it, expect } from 'vitest'
import {
  CEILING_BANDS, LIMITER_MARGIN_DB, codecCeiling, isLosslessEncoder, kbpsPerPair, presetMaxFor, resolveCeiling
} from '../../../src/main/ffmpeg/audio/ceilings'
import type { CeilingBasis, CeilingReason, OutputClass } from '../../../src/main/ffmpeg/audio/ceilings'
import { findLoudnessPreset } from '../../../src/shared/audio/presets'
import type { LoudnessTarget } from '../../../src/shared/audio/types'

/** Every row of the table: the codec ceiling, the class, and the kind of evidence behind the number. */
const ROWS: Readonly<Record<CeilingReason, readonly [number | null, OutputClass, CeilingBasis]>> =
{
  'lossless': [null, 'lossless', 'standard'],
  'ac3-high': [-2, 'broadcast-lossy', 'standard'],
  'ac3-low': [-2, 'broadcast-lossy', 'standard'],
  'eac3-high': [-2, 'broadcast-lossy', 'measured'],
  'eac3-low': [-2.5, 'broadcast-lossy', 'measured'],
  'mp2': [-2, 'broadcast-lossy', 'standard'],
  'mp2-low': [-3, 'broadcast-lossy', 'extrapolated'],
  'aac-high': [-2, 'lossy-high', 'measured'],
  'aac-low': [-3, 'lossy-low', 'measured'],
  'mp3-high': [-2, 'lossy-high', 'measured'],
  'mp3-low': [-3, 'lossy-low', 'extrapolated'],
  'opus-high': [-2, 'lossy-high', 'measured'],
  'opus-mid': [-3, 'lossy-low', 'measured'],
  'opus-low': [-4, 'lossy-low', 'extrapolated'],
  'vorbis-high': [-2, 'lossy-high', 'measured'],
  'vorbis-low': [-3, 'lossy-low', 'measured'],
  'wma-high': [-2, 'lossy-high', 'measured'],
  'wma-low': [-3, 'lossy-low', 'measured'],
  'other-lossy': [-3, 'lossy-low', 'extrapolated']
}

const BOUNDARY_RATES = [127, 128, 159, 160, 191, 192] as const

/** The row each lossy encoder takes at 127, 128, 159, 160, 191, and 192 kbps per channel pair. */
const BOUNDARIES: Readonly<Record<string, readonly CeilingReason[]>> =
{
  ac3: ['ac3-low', 'ac3-low', 'ac3-low', 'ac3-low', 'ac3-low', 'ac3-high'],
  eac3: ['eac3-low', 'eac3-low', 'eac3-low', 'eac3-low', 'eac3-low', 'eac3-high'],
  mp2: ['mp2-low', 'mp2', 'mp2', 'mp2', 'mp2', 'mp2'],
  aac: ['aac-low', 'aac-low', 'aac-low', 'aac-low', 'aac-low', 'aac-high'],
  libmp3lame: ['mp3-low', 'mp3-high', 'mp3-high', 'mp3-high', 'mp3-high', 'mp3-high'],
  libopus: ['opus-mid', 'opus-mid', 'opus-mid', 'opus-high', 'opus-high', 'opus-high'],
  libvorbis: ['vorbis-low', 'vorbis-low', 'vorbis-low', 'vorbis-low', 'vorbis-low', 'vorbis-high'],
  wmav2: ['wma-low', 'wma-low', 'wma-low', 'wma-high', 'wma-high', 'wma-high']
}

function row(reason: CeilingReason): { dbtp: number | null; cls: OutputClass; reason: CeilingReason; basis: CeilingBasis }
{
  const [dbtp, cls, basis] = ROWS[reason]
  return { dbtp, cls, reason, basis }
}

function target(over: Partial<LoudnessTarget> = {}): LoudnessTarget
{
  return { integratedLufs: -16, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: null, unit: 'LUFS', ...over }
}

describe('codecCeiling', () =>
{
  for (const encoder of ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'pcm_s16be', 'pcm_f32be', 'flac', 'alac', 'wavpack', 'tta'])
  {
    it(`gives ${encoder} no codec ceiling at any rate`, () =>
    {
      expect(codecCeiling(encoder, null)).toEqual(row('lossless'))
      expect(codecCeiling(encoder, 1411.2)).toEqual(row('lossless'))
      expect(isLosslessEncoder(encoder)).toBe(true)
    })
  }

  for (const [encoder, reasons] of Object.entries(BOUNDARIES))
  {
    it(`switches ${encoder} rows at the per-pair boundaries`, () =>
    {
      BOUNDARY_RATES.forEach((rate, n) =>
      {
        expect(codecCeiling(encoder, rate), `${encoder} ${rate}k`).toEqual(row(reasons[n]))
      })
      expect(isLosslessEncoder(encoder)).toBe(false)
    })
  }

  it('drops Opus under 64k per pair to its extrapolated row', () =>
  {
    expect(codecCeiling('libopus', 64)).toEqual(row('opus-mid'))
    expect(codecCeiling('libopus', 63)).toEqual(row('opus-low'))
    expect(codecCeiling('libopus', 63.99)).toEqual(row('opus-low'))
    expect(codecCeiling('libopus', 510)).toEqual(row('opus-high'))
  })

  it('keeps fractional rates on the side of the boundary they fall', () =>
  {
    expect(codecCeiling('aac', 191.99)).toEqual(row('aac-low'))
    expect(codecCeiling('ac3', 191.999)).toEqual(row('ac3-low'))
    expect(codecCeiling('libmp3lame', 127.5)).toEqual(row('mp3-low'))
    expect(codecCeiling('wmav2', 159.9)).toEqual(row('wma-low'))
  })

  it('takes the lowest row of a lossy encoder whose rate is unknown', () =>
  {
    expect(codecCeiling('aac', null)).toEqual(row('aac-low'))
    expect(codecCeiling('libopus', null)).toEqual(row('opus-low'))
    expect(codecCeiling('ac3', null)).toEqual(row('ac3-low'))
    expect(codecCeiling('eac3', null)).toEqual(row('eac3-low'))
    expect(codecCeiling('mp2', null)).toEqual(row('mp2-low'))
    expect(codecCeiling('wmav2', null)).toEqual(row('wma-low'))
    expect(codecCeiling('aac', Number.NaN)).toEqual(row('aac-low'))
    expect(codecCeiling('libopus', -1)).toEqual(row('opus-low'))
  })

  it('gives encoders the table does not name the extrapolated -3.0 dBTP row', () =>
  {
    for (const encoder of ['wmav1', 'libfdk_aac', 'dca', 'opus', 'vorbis', 'pcm', 'constructor', 'toString'])
    {
      expect(codecCeiling(encoder, 320), encoder).toEqual(row('other-lossy'))
      expect(codecCeiling(encoder, null), encoder).toEqual(row('other-lossy'))
    }
  })

  it('returns a copy, so a caller cannot change the table', () =>
  {
    const first = codecCeiling('flac', null)
    first.dbtp = 5
    expect(codecCeiling('flac', null).dbtp).toBeNull()
    const lossy = codecCeiling('wmav1', null)
    lossy.dbtp = 5
    expect(codecCeiling('wmav1', null).dbtp).toBe(-3)
  })

  it('lists the bands of every lossy encoder from the highest rate down to 0', () =>
  {
    expect(Object.keys(CEILING_BANDS).sort()).toEqual(Object.keys(BOUNDARIES).sort())
    for (const [encoder, bands] of Object.entries(CEILING_BANDS))
    {
      const floors = bands.map((band) => band.minKbpsPerPair)
      expect(floors, encoder).toEqual([...floors].sort((a, b) => b - a))
      expect(floors[floors.length - 1], encoder).toBe(0)
      for (const band of bands)
      {
        expect({ dbtp: band.dbtp, cls: band.cls, reason: band.reason, basis: band.basis }, `${encoder} ${band.reason}`).toEqual(row(band.reason))
      }
    }
  })
})

describe('kbpsPerPair', () =>
{
  it('scales a stream bitrate to one channel pair', () =>
  {
    expect(kbpsPerPair(384, 6)).toBe(128)
    expect(kbpsPerPair(640, 6)).toBeCloseTo(213.333, 3)
    expect(kbpsPerPair(448, 6)).toBeCloseTo(149.333, 3)
    expect(kbpsPerPair(192, 2)).toBe(192)
    expect(kbpsPerPair(64, 1)).toBe(128)
    expect(kbpsPerPair(512, 8)).toBe(128)
  })

  it('has no rate without a bitrate or channels', () =>
  {
    expect(kbpsPerPair(null, 2)).toBeNull()
    expect(kbpsPerPair(192, 0)).toBeNull()
  })

  it('places multichannel streams by their rate per pair', () =>
  {
    expect(codecCeiling('aac', kbpsPerPair(384, 6))).toEqual(row('aac-low'))
    expect(codecCeiling('aac', kbpsPerPair(576, 6))).toEqual(row('aac-high'))
    expect(codecCeiling('ac3', kbpsPerPair(640, 6))).toEqual(row('ac3-high'))
    expect(codecCeiling('ac3', kbpsPerPair(448, 6))).toEqual(row('ac3-low'))
    expect(codecCeiling('eac3', kbpsPerPair(384, 6))).toEqual(row('eac3-low'))
    expect(codecCeiling('eac3', kbpsPerPair(1024, 6))).toEqual(row('eac3-high'))
    expect(codecCeiling('libopus', kbpsPerPair(384, 6))).toEqual(row('opus-mid'))
    expect(codecCeiling('libopus', kbpsPerPair(480, 6))).toEqual(row('opus-high'))
    expect(codecCeiling('libmp3lame', kbpsPerPair(64, 1))).toEqual(row('mp3-high'))
  })
})

describe('resolveCeiling', () =>
{
  it('runs the limiter half a decibel under the ceiling', () =>
  {
    expect(LIMITER_MARGIN_DB).toBe(0.5)
  })

  it('takes the preset maximum for lossless outputs and checks the decoded peak against it', () =>
  {
    expect(resolveCeiling('flac', null, -1)).toEqual({
      presetMaxDbtp: -1,
      codecCeilingDbtp: null,
      ceilingDbtp: -1,
      limiterCeilingDbtp: -1.5,
      gateDbtp: -1,
      decodedLimitDbtp: -1,
      outputClass: 'lossless',
      reason: 'lossless',
      basis: 'standard'
    })
  })

  it('takes the codec ceiling when it is lower and checks the decoded peak against the preset maximum', () =>
  {
    expect(resolveCeiling('aac', 128, -1)).toEqual({
      presetMaxDbtp: -1,
      codecCeilingDbtp: -3,
      ceilingDbtp: -3,
      limiterCeilingDbtp: -3.5,
      gateDbtp: -1,
      decodedLimitDbtp: -1,
      outputClass: 'lossy-low',
      reason: 'aac-low',
      basis: 'measured'
    })
    const eac3 = resolveCeiling('eac3', kbpsPerPair(384, 6), -1)
    expect([eac3.ceilingDbtp, eac3.limiterCeilingDbtp, eac3.decodedLimitDbtp]).toEqual([-2.5, -3, -1])
  })

  it('takes the preset maximum when it is lower than the codec ceiling', () =>
  {
    const ac3 = resolveCeiling('ac3', kbpsPerPair(448, 6), -2)
    expect([ac3.codecCeilingDbtp, ac3.ceilingDbtp, ac3.limiterCeilingDbtp, ac3.gateDbtp, ac3.decodedLimitDbtp]).toEqual([-2, -2, -2.5, -2, -2])
    const quiet = resolveCeiling('aac', 256, -9)
    expect([quiet.codecCeilingDbtp, quiet.ceilingDbtp, quiet.limiterCeilingDbtp, quiet.gateDbtp, quiet.decodedLimitDbtp]).toEqual([-2, -9, -9.5, -9, -9])
    expect(quiet.outputClass).toBe('lossy-high')
  })

  it('carries the basis of the row it came from', () =>
  {
    expect(resolveCeiling('ac3', 213, -1).basis).toBe('standard')
    expect(resolveCeiling('libopus', 96, -1).basis).toBe('measured')
    expect(resolveCeiling('libopus', 48, -1).basis).toBe('extrapolated')
    expect(resolveCeiling('mp2', 96, -1).basis).toBe('extrapolated')
    expect(resolveCeiling('wmav1', 160, -1).basis).toBe('extrapolated')
  })
})

describe('presetMaxFor', () =>
{
  const spotify = findLoudnessPreset('spotify')?.target as LoudnessTarget

  it('lowers Spotify\'s maximum to -2.0 dBTP only above -14.0 LUFS', () =>
  {
    expect(spotify.louderMax).toEqual({ aboveLufs: -14, maxTruePeakDbtp: -2 })
    expect(presetMaxFor(spotify, -13.9)).toBe(-2)
    expect(presetMaxFor(spotify, -14)).toBe(-1)
    expect(presetMaxFor(spotify, -16)).toBe(-1)
    expect(presetMaxFor(spotify, null)).toBe(-1)
  })

  it('keeps the target\'s own maximum when it names no lower one', () =>
  {
    expect(presetMaxFor(target({ maxTruePeakDbtp: -2 }), -5)).toBe(-2)
  })

  it('feeds the lower maximum into the gate and both limits', () =>
  {
    const opus = resolveCeiling('libopus', 160, presetMaxFor(spotify, -13))
    expect([opus.ceilingDbtp, opus.limiterCeilingDbtp, opus.gateDbtp, opus.decodedLimitDbtp]).toEqual([-2, -2.5, -2, -2])
    const flac = resolveCeiling('flac', null, presetMaxFor(spotify, -13))
    expect([flac.ceilingDbtp, flac.limiterCeilingDbtp, flac.gateDbtp, flac.decodedLimitDbtp]).toEqual([-2, -2.5, -2, -2])
    const quiet = resolveCeiling('libopus', 160, presetMaxFor(spotify, -14))
    expect([quiet.ceilingDbtp, quiet.gateDbtp, quiet.decodedLimitDbtp]).toEqual([-2, -1, -1])
  })
})
