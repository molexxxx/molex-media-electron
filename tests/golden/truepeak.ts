/**
 * An 8x true-peak interpolator for builds without libsoxr, whose `aresample=resampler=soxr` fails. It decodes a
 * stream to f64le PCM and evaluates a Kaiser-windowed sinc (97 taps per phase, beta 12) at seven fractional
 * phases between every pair of samples, plus the samples themselves.
 */
import { spawn } from 'node:child_process'

/** Taps per fractional phase. */
export const TRUE_PEAK_TAPS = 97

/** Oversampling factor: the samples plus seven interpolated phases. */
export const TRUE_PEAK_FACTOR = 8

/** Kaiser window shape parameter. */
export const TRUE_PEAK_BETA = 12

const HALF = (TRUE_PEAK_TAPS - 1) / 2

function besselI0(x: number): number
{
  const half = x / 2
  let sum = 1
  let term = 1
  for (let k = 1; k < 500; k++)
  {
    term *= (half / k) * (half / k)
    sum += term
    if (term < sum * 1e-18) break
  }
  return sum
}

/**
 * The filters of phases 1/8 to 7/8, packed one after another. Tap j of a phase weighs the sample j - 48 places
 * from the sample before the interpolated instant; each phase is scaled to unity gain at DC.
 */
export function phaseFilters(): Float64Array
{
  const span = HALF + 1
  const norm = besselI0(TRUE_PEAK_BETA)
  const out = new Float64Array((TRUE_PEAK_FACTOR - 1) * TRUE_PEAK_TAPS)
  for (let p = 1; p < TRUE_PEAK_FACTOR; p++)
  {
    const frac = p / TRUE_PEAK_FACTOR
    const base = (p - 1) * TRUE_PEAK_TAPS
    let sum = 0
    for (let j = 0; j < TRUE_PEAK_TAPS; j++)
    {
      const t = j - HALF - frac
      const x = Math.PI * t
      const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(x) / x
      const r = t / span
      const w = Math.abs(r) >= 1 ? 0 : besselI0(TRUE_PEAK_BETA * Math.sqrt(1 - r * r)) / norm
      out[base + j] = sinc * w
      sum += out[base + j]
    }
    for (let j = 0; j < TRUE_PEAK_TAPS; j++) out[base + j] /= sum
  }
  return out
}

const FILTERS = phaseFilters()

/** The linear 8x true peak of one channel; samples outside the signal read as zero. */
export function channelTruePeak(samples: Float64Array): number
{
  const n = samples.length
  let peak = 0
  for (let i = 0; i < n; i++)
  {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  const padded = new Float64Array(n + TRUE_PEAK_TAPS)
  padded.set(samples, HALF)
  const phases = TRUE_PEAK_FACTOR - 1
  for (let i = 0; i < n; i++)
  {
    for (let p = 0; p < phases; p++)
    {
      const base = p * TRUE_PEAK_TAPS
      let acc = 0
      for (let j = 0; j < TRUE_PEAK_TAPS; j++) acc += padded[i + j] * FILTERS[base + j]
      const a = acc < 0 ? -acc : acc
      if (a > peak) peak = a
    }
  }
  return peak
}

/** Linear amplitude to dB; zero reads as -Infinity. */
export function toDb(linear: number): number
{
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity
}

/** The 8x true peak of every channel and their maximum, in dBTP. */
export function truePeakDb(channels: readonly Float64Array[]): { dbtp: number; perChannel: number[] }
{
  const perChannel = channels.map((c) => toDb(channelTruePeak(c)))
  return { dbtp: perChannel.reduce((a, b) => Math.max(a, b), -Infinity), perChannel }
}

/** Splits interleaved little-endian f64 PCM into one array per channel; a trailing partial frame is dropped. */
export function deinterleave(bytes: Uint8Array, channels: number): Float64Array[]
{
  const frames = Math.floor(bytes.byteLength / (8 * channels))
  const all = new Float64Array(frames * channels)
  new Uint8Array(all.buffer).set(bytes.subarray(0, frames * channels * 8))
  const out: Float64Array[] = []
  for (let c = 0; c < channels; c++)
  {
    const ch = new Float64Array(frames)
    for (let i = 0; i < frames; i++) ch[i] = all[i * channels + c]
    out.push(ch)
  }
  return out
}

/** What {@link decodeF64} decodes: one audio stream, its channel count, and an optional filter chain. */
export interface DecodeRequest
{
  /** The audio stream index among the input's audio streams (`-map 0:a:<stream>`). */
  stream: number
  /** The channel count of the decoded output, after `filter` when one is given. */
  channels: number
  filter?: string
}

/** Decodes one audio stream to f64le PCM on stdout and returns its channels. Rejects on a non-zero exit. */
export function decodeF64(ffmpeg: string, file: string, request: DecodeRequest): Promise<Float64Array[]>
{
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', `0:a:${request.stream}`]
  if (request.filter) args.push('-af', request.filter)
  args.push('-f', 'f64le', '-c:a', 'pcm_f64le', '-')
  return new Promise((resolve, reject) =>
  {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) =>
    {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) =>
    {
      if (code !== 0)
      {
        reject(new Error(`f64le decode of ${file} exited with ${code}: ${stderr.trim().slice(-500)}`))
        return
      }
      resolve(deinterleave(Buffer.concat(chunks), request.channels))
    })
  })
}

/** Decodes one stream and returns its 8x true peak in dBTP, per channel and overall, with the time taken. */
export async function interpolatedTruePeak(ffmpeg: string, file: string, request: DecodeRequest): Promise<{ dbtp: number; perChannel: number[]; ms: number }>
{
  const started = Date.now()
  const channels = await decodeF64(ffmpeg, file, request)
  return { ...truePeakDb(channels), ms: Date.now() - started }
}
