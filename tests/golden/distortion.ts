/**
 * FFT spectrum, THD, and SMPTE intermodulation distortion for the limiter scenarios, read from decoded f64le
 * PCM: a 65,536-point Blackman-Harris spectrum of one channel resampled to 48 kHz.
 */
import { decodeF64 } from './truepeak'

/** The analysis rate every decode is resampled to. */
export const ANALYSIS_RATE = 48000

/** The default transform length. */
export const FFT_SIZE = 65536

/** An in-place radix-2 FFT; the length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void
{
  const n = re.length
  for (let i = 1, j = 0; i < n; i++)
  {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j)
    {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1)
  {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len)
    {
      let cr = 1
      let ci = 0
      for (let j = 0; j < half; j++)
      {
        const a = i + j
        const b = a + half
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr
        im[b] = im[a] - vi
        re[a] += vr
        im[a] += vi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** A one-sided power spectrum. */
export interface Spectrum
{
  power: Float64Array
  binHz: number
}

/** The Blackman-Harris windowed power spectrum of the first `size` samples; a short input is zero padded. */
export function spectrum(samples: Float64Array, sampleRate = ANALYSIS_RATE, size = FFT_SIZE): Spectrum
{
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const a0 = 0.35875
  const a1 = 0.48829
  const a2 = 0.14128
  const a3 = 0.01168
  for (let i = 0; i < size; i++)
  {
    const x = i < samples.length ? samples[i] : 0
    const w = a0 - a1 * Math.cos(2 * Math.PI * i / (size - 1)) + a2 * Math.cos(4 * Math.PI * i / (size - 1)) - a3 * Math.cos(6 * Math.PI * i / (size - 1))
    re[i] = x * w
  }
  fft(re, im)
  const power = new Float64Array(size / 2)
  for (let k = 0; k < size / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k]
  return { power, binHz: sampleRate / size }
}

/** The power in the bins within `half` bins of a frequency. */
export function band(s: Spectrum, hz: number, half = 5): number
{
  const k = Math.round(hz / s.binHz)
  let sum = 0
  for (let i = Math.max(0, k - half); i <= Math.min(s.power.length - 1, k + half); i++) sum += s.power[i]
  return sum
}

/** Harmonics 2 to 10 against the fundamental, and everything from 20 Hz to 20 kHz but the fundamental, in dB. */
export function thd(s: Spectrum, f0: number): { thdDb: number; thdnDb: number }
{
  const fund = band(s, f0)
  let harm = 0
  for (let h = 2; h <= 10; h++) harm += band(s, f0 * h)
  let total = 0
  for (let k = Math.round(20 / s.binHz); k < Math.round(20000 / s.binHz); k++) total += s.power[k]
  return { thdDb: 10 * Math.log10(harm / fund), thdnDb: 10 * Math.log10((total - fund) / fund) }
}

/** SMPTE IMD in dB: the sidebands at the carrier plus and minus 1 to 4 times the low tone, against the carrier. */
export function imd(s: Spectrum, o: { carrierHz?: number; lowHz?: number } = {}): number
{
  const carrierHz = o.carrierHz ?? 7000
  const lowHz = o.lowHz ?? 60
  const carrier = band(s, carrierHz)
  let side = 0
  for (let n = 1; n <= 4; n++) side += band(s, carrierHz + lowHz * n, 3) + band(s, carrierHz - lowHz * n, 3)
  return 10 * Math.log10(side / carrier)
}

/** The lavfi source of a 4:1 SMPTE test signal (low tone plus 7 kHz) at the given peak amplitude. */
export function smpteSource(o: { lowHz?: number; peak?: number; seconds?: number } = {}): string
{
  const peak = o.peak ?? 1
  return `aevalsrc=exprs='${(0.8 * peak).toFixed(6)}*sin(2*PI*${o.lowHz ?? 60}*t)+${(0.2 * peak).toFixed(6)}*sin(2*PI*7000*t)'` +
    `:s=${ANALYSIS_RATE}:d=${o.seconds ?? 4}:c=stereo`
}

/** Decodes channel 0 of an audio stream from `startSec` on, resampled to 48 kHz, for {@link spectrum}. */
export function decodeAnalysis(ffmpeg: string, file: string, o: { stream?: number; startSec?: number } = {}): Promise<Float64Array>
{
  const filter = `atrim=start=${o.startSec ?? 1},pan=mono|c0=c0,aresample=${ANALYSIS_RATE}`
  return decodeF64(ffmpeg, file, { stream: o.stream ?? 0, channels: 1, filter }).then((channels) => channels[0])
}
