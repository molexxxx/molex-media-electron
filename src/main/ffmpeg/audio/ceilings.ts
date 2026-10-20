/**
 * Codec-aware true-peak ceilings. C = min(preset maximum, codec ceiling) and the limiter runs at
 * L = C - LIMITER_MARGIN_DB. The preset maximum is judged on the true peak before encoding; the decoded
 * true peak is the app's codec-overshoot check against C for lossless outputs and the preset maximum
 * for lossy ones.
 */
import type { Ceiling, CeilingReason, LoudnessTarget, OutputClass } from '../../../shared/audio/types'

export type { Ceiling, CeilingReason, OutputClass }

/** The limiter runs this far under the ceiling C. */
export const LIMITER_MARGIN_DB = 0.5

/** Where a codec ceiling comes from: a number a cited standard states, an app value from measurement, or an extrapolation. */
export type CeilingBasis = Ceiling['basis']

/** One row of the codec ceiling table. */
export interface CodecCeiling
{
  /** Null for lossless outputs, which take the preset maximum. */
  dbtp: number | null
  cls: OutputClass
  reason: CeilingReason
  basis: CeilingBasis
}

/** A band of an encoder's rows: it applies at or above minKbpsPerPair. */
export interface CeilingBand extends CodecCeiling
{
  minKbpsPerPair: number
}

const LOSSLESS: CodecCeiling = { dbtp: null, cls: 'lossless', reason: 'lossless', basis: 'standard' }
const OTHER_LOSSY: CodecCeiling = { dbtp: -3, cls: 'lossy-low', reason: 'other-lossy', basis: 'extrapolated' }
const LOSSLESS_ENCODERS: ReadonlySet<string> = new Set(['flac', 'alac', 'wavpack', 'tta'])

function band(minKbpsPerPair: number, dbtp: number, cls: OutputClass, reason: CeilingReason, basis: CeilingBasis): CeilingBand
{
  return { minKbpsPerPair, dbtp, cls, reason, basis }
}

/**
 * The lossy rows of the codec ceiling table per encoder, highest band first, keyed by the rate per
 * channel pair. AC-3 and MPEG-1 Layer II take EBU Tech 3343 section 11.2.3's -2 dBTP; the measured rows
 * keep the worst decoded peak of the evidence under -1.0 dBTP; the extrapolated rows were not measured.
 */
export const CEILING_BANDS: Readonly<Record<string, readonly CeilingBand[]>> =
{
  ac3: [band(192, -2, 'broadcast-lossy', 'ac3-high', 'standard'), band(0, -2, 'broadcast-lossy', 'ac3-low', 'standard')],
  eac3: [band(192, -2, 'broadcast-lossy', 'eac3-high', 'measured'), band(0, -2.5, 'broadcast-lossy', 'eac3-low', 'measured')],
  mp2: [band(128, -2, 'broadcast-lossy', 'mp2', 'standard'), band(0, -3, 'broadcast-lossy', 'mp2-low', 'extrapolated')],
  aac: [band(192, -2, 'lossy-high', 'aac-high', 'measured'), band(0, -3, 'lossy-low', 'aac-low', 'measured')],
  libmp3lame: [band(128, -2, 'lossy-high', 'mp3-high', 'measured'), band(0, -3, 'lossy-low', 'mp3-low', 'extrapolated')],
  libopus: [
    band(160, -2, 'lossy-high', 'opus-high', 'measured'),
    band(64, -3, 'lossy-low', 'opus-mid', 'measured'),
    band(0, -4, 'lossy-low', 'opus-low', 'extrapolated')
  ],
  libvorbis: [band(192, -2, 'lossy-high', 'vorbis-high', 'measured'), band(0, -3, 'lossy-low', 'vorbis-low', 'measured')],
  wmav2: [band(160, -2, 'lossy-high', 'wma-high', 'measured'), band(0, -3, 'lossy-low', 'wma-low', 'measured')]
}

/** True for the encoders whose output is lossless: every PCM encoder, flac, alac, wavpack, and tta. */
export function isLosslessEncoder(encoder: string): boolean
{
  return encoder.startsWith('pcm_') || LOSSLESS_ENCODERS.has(encoder)
}

/** The bitrate per channel pair: a 5.1 stream at 384k is 128k per pair, a mono stream at 64k is 128k. */
export function kbpsPerPair(bitrateKbps: number | null, channels: number): number | null
{
  if (bitrateKbps === null || channels < 1)
  {
    return null
  }
  return bitrateKbps * 2 / channels
}

/**
 * The codec ceiling row of an encoder at a rate per channel pair. A lossy encoder with an unknown rate
 * takes its lowest band; an encoder the table does not name takes the extrapolated -3.0 dBTP row.
 */
export function codecCeiling(encoder: string, perPair: number | null): CodecCeiling
{
  if (isLosslessEncoder(encoder))
  {
    return { ...LOSSLESS }
  }
  const bands = Object.hasOwn(CEILING_BANDS, encoder) ? CEILING_BANDS[encoder] : null
  if (bands === null)
  {
    return { ...OTHER_LOSSY }
  }
  const rate = perPair ?? 0
  const row = bands.find((candidate) => rate >= candidate.minKbpsPerPair) ?? bands[bands.length - 1]
  return { dbtp: row.dbtp, cls: row.cls, reason: row.reason, basis: row.basis }
}

/** The ceiling of one output stream under a preset's maximum true peak. */
export function resolveCeiling(encoder: string, perPair: number | null, presetMaxDbtp: number): Ceiling
{
  const codec = codecCeiling(encoder, perPair)
  const ceilingDbtp = codec.dbtp === null ? presetMaxDbtp : Math.min(presetMaxDbtp, codec.dbtp)
  return {
    presetMaxDbtp,
    codecCeilingDbtp: codec.dbtp,
    ceilingDbtp,
    limiterCeilingDbtp: ceilingDbtp - LIMITER_MARGIN_DB,
    gateDbtp: presetMaxDbtp,
    decodedLimitDbtp: codec.cls === 'lossless' ? ceilingDbtp : presetMaxDbtp,
    outputClass: codec.cls,
    reason: codec.reason,
    basis: codec.basis
  }
}

/**
 * The preset's maximum true peak for an output at a loudness: the lower louderMax maximum when the
 * target names one and the level is above its threshold (Spotify: above -14.0 LUFS, -2.0 dBTP), else
 * the target's own maximum. The planner passes its predicted level, verification the one-decimal
 * measured value.
 */
export function presetMaxFor(target: LoudnessTarget, levelLufs: number | null): number
{
  const louder = target.louderMax
  return louder !== null && levelLufs !== null && levelLufs > louder.aboveLufs ? louder.maxTruePeakDbtp : target.maxTruePeakDbtp
}
