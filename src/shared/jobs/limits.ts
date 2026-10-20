/**
 * Numeric ranges for the video and extract fields of a recipe, and the size budget of a Compress size target.
 * The validators, the inspector's inputs, and the planner read these, so a value the page accepts is a value
 * the engine accepts. Audio ranges live in src/shared/audio/limits.ts.
 */
import type { VideoEncoder } from './recipes'

/** An inclusive range; max null means no upper bound. */
export interface Range
{
  min: number
  max: number | null
}

/** Whether a value is a finite number inside a range. */
export function inRange(value: unknown, range: Range): value is number
{
  return typeof value === 'number' && Number.isFinite(value) && value >= range.min && (range.max === null || value <= range.max)
}

/** The CRF range of each encoder; null for encoders without a CRF. */
export const CRF_RANGES: Readonly<Record<VideoEncoder, Range | null>> =
{
  'libx264': { min: 0, max: 51 },
  'libx265': { min: 0, max: 51 },
  'libvpx-vp9': { min: 0, max: 63 },
  'libaom-av1': { min: 0, max: 63 },
  'libsvtav1': { min: 0, max: 63 },
  'prores_ks': null,
  'ffv1': null,
  'utvideo': null,
  'mpeg2video': null,
  'mpeg4': null,
  'libtheora': null,
  'wmv2': null
}

/** Ranges of the video and extract fields. */
export const JOB_LIMITS =
{
  /** Compress size target in bytes. */
  targetBytes: { min: 1_000_000, max: null },
  /** Convert video bitrate in kb/s; 100 kb/s is the lowest a size budget plans. */
  videoBitrateKbps: { min: 100, max: 200_000 },
  /** Convert output frame rate. */
  fps: { min: 1, max: 240 },
  /** Maximum width or height of a frame size cap, in pixels. */
  frameSize: { min: 16, max: 7680 },
  /** GIF frame rate. */
  gifFps: { min: 1, max: 60 },
  /** GIF width in pixels; null in the recipe keeps the source width. */
  gifWidth: { min: 1, max: 3840 },
  /** GIF plays; 'infinite' in the recipe loops forever. */
  gifPlays: { min: 1, max: 65536 },
  /** Frames every n seconds. */
  frameIntervalSec: { min: 0.05, max: null },
  /** Frames per second of video. */
  frameFps: { min: 0.01, max: null },
  /** Evenly spaced frames. */
  frameCount: { min: 1, max: 1000 },
  /** JPEG quality: 2 is best, 31 is smallest. */
  jpgQuality: { min: 2, max: 31 },
  /** Time range start. */
  rangeStartSec: { min: 0, max: null },
  /** Time range length; null in the recipe runs to the end. */
  rangeDurationSec: { min: 0.01, max: null },
  /** A stream picked by its ordinal among streams of its kind, counting from 1. */
  streamOrdinal: { min: 1, max: 64 }
} as const satisfies Readonly<Record<string, Range>>

/** Extract output sample rates; null in the recipe keeps the source rate. */
export const EXTRACT_SAMPLE_RATES: readonly number[] = [44100, 48000, 96000]

/** The share of a size target an encode aims at, so a normal encode lands under the target. */
export const SIZE_BUDGET_SHARE = 0.97

/** The lowest video bitrate a size budget plans, in kb/s. */
export const MIN_BUDGET_VIDEO_KBPS = 100

/** The bitrates a Compress size target allows one file. */
export interface SizeBudget
{
  /** The bytes the encode aims at: the target times SIZE_BUDGET_SHARE. */
  budgetBytes: number
  /** Video and audio together, in kb/s. */
  totalKbps: number
  /** What remains for video after the audio, in kb/s, rounded down; 0 when the audio alone uses the budget. */
  videoKbps: number
  /** Every kept audio stream together, in kb/s. */
  audioKbps: number
  /** False when the video would get less than MIN_BUDGET_VIDEO_KBPS: the target is too small for this duration. */
  fits: boolean
}

/**
 * The video and audio bitrates for a size target, from the file's duration and the bitrate of each audio stream the
 * output keeps (kb/s). The video share is rounded down, ignoring floating-point noise under 1e-9 kb/s. Null when the
 * duration or the target is not a positive number.
 */
export function sizeBudget(targetBytes: number, durationSec: number, audio: readonly number[]): SizeBudget | null
{
  if (!(targetBytes > 0) || !Number.isFinite(targetBytes) || !(durationSec > 0) || !Number.isFinite(durationSec))
  {
    return null
  }
  const budgetBytes = targetBytes * SIZE_BUDGET_SHARE
  const totalKbps = (budgetBytes * 8) / durationSec / 1000
  const audioKbps = audio.reduce((sum, kbps) => sum + (Number.isFinite(kbps) && kbps > 0 ? kbps : 0), 0)
  const videoKbps = Math.max(0, Math.floor(totalKbps - audioKbps + 1e-9))
  return { budgetBytes, totalKbps, videoKbps, audioKbps, fits: videoKbps >= MIN_BUDGET_VIDEO_KBPS }
}
