/**
 * The compressor anchored to the program: its threshold is the measured integrated loudness plus an offset, so
 * the same setting acts alike on quiet and loud sources. It has no makeup gain; the linear gain planned from the
 * second measurement sets the level.
 */
import { formatDb } from './chains'
import { NIGHT_DYNAMICS } from '../../../shared/audio/presets'
import type { DynamicsSpec } from '../../../shared/audio/types'

export type { DynamicsSpec }

/** Clear dialogue, an app preset built on EBU R 128 s2. */
export const NIGHT: DynamicsSpec = NIGHT_DYNAMICS

/** acompressor's option ranges (`ffmpeg -h filter=acompressor`, 2022 and 9.0.2); the threshold 0.000976563 to 1 in dB. */
export const ACOMPRESSOR_RANGES =
{
  thresholdDb: { min: -60.2, max: 0 },
  ratio: { min: 1, max: 20 },
  attackMs: { min: 0.01, max: 2000 },
  releaseMs: { min: 0.01, max: 9000 }
} as const

/** The knee in dB, FFmpeg's default written out so the stage reads the same on every build. */
export const COMPRESSOR_KNEE = 2.8284

/** acompressor with RMS detection, linked on the loudest channel, threshold anchored and clamped to the option range. */
export function compressorStage(d: DynamicsSpec, measuredLufs: number): string
{
  const anchored = measuredLufs + d.thresholdOffsetDb
  const threshold = Number.isNaN(anchored) ? ACOMPRESSOR_RANGES.thresholdDb.max : clamp(anchored, ACOMPRESSOR_RANGES.thresholdDb)
  const ratio = clamp(d.ratio, ACOMPRESSOR_RANGES.ratio)
  const attack = clamp(d.attackMs, ACOMPRESSOR_RANGES.attackMs)
  const release = clamp(d.releaseMs, ACOMPRESSOR_RANGES.releaseMs)
  return `acompressor=threshold=${formatDb(threshold)}:ratio=${ratio}:attack=${attack}:release=${release}` +
    `:knee=${COMPRESSOR_KNEE}:detection=rms:link=maximum`
}

function clamp(value: number, range: { min: number; max: number }): number
{
  return Math.min(range.max, Math.max(range.min, value))
}
