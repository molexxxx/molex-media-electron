/**
 * @module visualizations/audio
 * @description Audio analysis utilities for the visualization engine.
 *
 * Provides {@link getBandEnergy} for extracting energy from a frequency bin
 * range, used to populate {@link AudioFeatures} each animation frame.
 */

/**
 * Compute the average energy (0-1) across a range of FFT bins.
 *
 * @param freq - Raw frequency-domain data from {@link AnalyserNode.getByteFrequencyData}.
 * @param lo   - First bin index (inclusive).
 * @param hi   - Last bin index (exclusive).
 * @returns Normalised average energy in `[0, 1]`.
 */
export function getBandEnergy(freq: Uint8Array, lo: number, hi: number): number {
  let sum = 0
  let count = 0
  for (let i = lo; i < hi && i < freq.length; i++) {
    sum += freq[i]
    count++
  }
  return count > 0 ? sum / count / 255 : 0
}
