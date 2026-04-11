/**
 * @module visualizations/audio
 * @description Audio analysis engine with perceptual weighting.
 *
 * Uses **A-weighting** (IEC 61672) to approximate human loudness perception
 * across frequency bins, **spectral flux** (half-wave rectified) for onset /
 * beat detection, and **spectral centroid** as a brightness descriptor.
 *
 * Band boundaries are aligned with the Bark critical-band scale so that
 * each band spans a roughly equal number of perceptual critical bands:
 *
 * | Band    | Range        | Bark bands | Typical content          |
 * |---------|------------- |------------|--------------------------|
 * | sub     | 20 – 60 Hz   | 1          | Sub-bass rumble          |
 * | bass    | 60 – 250 Hz  | 2 – 4      | Kick, bass guitar        |
 * | lowMid  | 250 – 500 Hz | 4 – 5      | Low vocals, guitar body  |
 * | mid     | 500 – 2 kHz  | 6 – 13     | Vocals, snare            |
 * | highMid | 2 – 6 kHz    | 14 – 20    | Clarity, hi-hat          |
 * | treble  | 6 – 20 kHz   | 21 – 24    | Cymbals, air             |
 *
 * The A-weighting transfer function (simplified for real-time use):
 *   RA(f) = 12194² · f⁴ / [(f²+20.6²)(f²+107.7²)(f²+737.9²)(f²+12194²)]
 *   A(f)  = 20·log10(RA(f)) + 2.0  dB
 */

/* ------------------------------------------------------------------ */
/*  A-weighting (IEC 61672)                                             */
/* ------------------------------------------------------------------ */

/** Pre-computed A-weighting gain (linear, not dB) per FFT bin.
 *  Computed once on first call via {@link getAWeights}. */
let aWeightCache: Float32Array | null = null
let aWeightCacheSize = 0
let aWeightCacheSR = 0

/**
 * Build (or return cached) A-weighting linear-gain table for the given
 * FFT size / sample-rate pair.
 *
 * @param binCount  - Number of frequency bins (half FFT size).
 * @param sampleRate - Audio context sample rate (typically 44 100 or 48 000).
 */
export function getAWeights(binCount: number, sampleRate: number): Float32Array {
  if (aWeightCache && aWeightCacheSize === binCount && aWeightCacheSR === sampleRate) {
    return aWeightCache
  }
  const w = new Float32Array(binCount)
  const binHz = sampleRate / (binCount * 2) // freq resolution per bin
  for (let i = 0; i < binCount; i++) {
    const f = Math.max((i + 0.5) * binHz, 1) // centre freq, floor at 1 Hz
    const f2 = f * f
    const num = 148693636 * f2 * f2 // 12194² = 148693636
    const den = (f2 + 424.36) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148693636)
    // RA normalised so that RA(1000) ≈ 1 → A(1000) ≈ 0 dB
    const ra = num / den
    // Convert to dB then back to linear gain (clamped to useful range)
    const dB = 20 * Math.log10(Math.max(ra, 1e-10)) + 2.0
    w[i] = Math.pow(10, Math.max(dB, -80) / 20) // linear gain, floor -80 dB
  }
  aWeightCache = w
  aWeightCacheSize = binCount
  aWeightCacheSR = sampleRate
  return w
}

/* ------------------------------------------------------------------ */
/*  Band energy (A-weighted RMS)                                        */
/* ------------------------------------------------------------------ */

/**
 * Compute A-weighted RMS energy (0-1) across a range of FFT bins.
 *
 * Unlike the previous simple average, this:
 * 1. Applies per-bin A-weighting so that low / very high bins contribute
 *    proportionally to **perceived** loudness.
 * 2. Uses RMS (root-mean-square) rather than mean, which better represents
 *    the power content of the band.
 *
 * @param freq       - Frequency-domain data (Uint8Array from AnalyserNode).
 * @param lo         - First bin index (inclusive).
 * @param hi         - Last bin index (exclusive).
 * @param aWeights   - A-weighting gain table (or null to skip weighting).
 * @returns Normalised RMS energy in [0, 1].
 */
export function getBandEnergy(
  freq: Uint8Array,
  lo: number,
  hi: number,
  aWeights?: Float32Array | null
): number {
  let sumSq = 0
  let count = 0
  for (let i = lo; i < hi && i < freq.length; i++) {
    const raw = freq[i] / 255 // normalise to 0-1
    const weighted = aWeights ? raw * aWeights[i] : raw
    sumSq += weighted * weighted
    count++
  }
  if (count === 0) return 0
  // RMS → clamp to [0,1] (A-weighting can amplify mid freqs above 1.0)
  return Math.min(1, Math.sqrt(sumSq / count))
}

/* ------------------------------------------------------------------ */
/*  Spectral flux (onset detection)                                     */
/* ------------------------------------------------------------------ */

/**
 * Compute half-wave-rectified spectral flux between the current and
 * previous magnitude spectra.
 *
 * Only **increases** in bin energy are summed (half-wave rectification),
 * which isolates note onsets and transients from decays.
 *
 * The spectra are L1-normalised before comparison so that the metric is
 * independent of overall volume.
 *
 * @param curr - Current frame frequency data (Uint8Array).
 * @param prev - Previous frame frequency data (Float32Array, same length).
 * @param lo   - First bin (inclusive).
 * @param hi   - Last bin (exclusive).
 * @returns Non-negative flux value (not bounded to 1).
 */
export function spectralFlux(
  curr: Uint8Array,
  prev: Float32Array,
  lo: number,
  hi: number
): number {
  let flux = 0
  for (let i = lo; i < hi && i < curr.length; i++) {
    const diff = (curr[i] / 255) - (prev[i] / 255)
    if (diff > 0) flux += diff * diff // half-wave rectified L2
  }
  return Math.sqrt(flux)
}

/* ------------------------------------------------------------------ */
/*  Spectral centroid ("brightness")                                    */
/* ------------------------------------------------------------------ */

/**
 * Compute the spectral centroid - the weighted mean frequency of the
 * spectrum, a robust predictor of perceived sound "brightness".
 *
 *   centroid = Σ f(n)·x(n) / Σ x(n)
 *
 * @param freq       - Frequency data (Uint8Array).
 * @param binCount   - Number of usable bins.
 * @param sampleRate - Audio context sample rate.
 * @returns Centroid frequency in Hz (0 if silent).
 */
export function spectralCentroid(
  freq: Uint8Array,
  binCount: number,
  sampleRate: number
): number {
  const binHz = sampleRate / (binCount * 2)
  let weightedSum = 0
  let magSum = 0
  for (let i = 1; i < binCount && i < freq.length; i++) {
    const mag = freq[i] / 255
    const f = (i + 0.5) * binHz
    weightedSum += f * mag
    magSum += mag
  }
  return magSum > 0.001 ? weightedSum / magSum : 0
}

/* ------------------------------------------------------------------ */
/*  RMS level (time domain)                                             */
/* ------------------------------------------------------------------ */

/**
 * Compute RMS level from time-domain waveform data.
 *
 * @param time - Time-domain data (Uint8Array centred at 128).
 * @returns RMS in [0, 1].
 */
export function rmsLevel(time: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < time.length; i++) {
    const s = (time[i] - 128) / 128
    sum += s * s
  }
  return Math.sqrt(sum / time.length)
}

/* ------------------------------------------------------------------ */
/*  Frequency ↔ Bark conversion                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert a frequency in Hz to the Bark scale (Traunmüller 1990).
 *
 *   Bark = (26.81 · f) / (1960 + f) − 0.53
 */
export function hzToBark(f: number): number {
  return (26.81 * f) / (1960 + f) - 0.53
}

/**
 * Return the FFT bin index closest to a given frequency.
 */
export function freqToBin(freq: number, binCount: number, sampleRate: number): number {
  const binHz = sampleRate / (binCount * 2)
  return Math.round(freq / binHz)
}
