import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { formatDb, limiterStages, pinStages } from '../../src/main/ffmpeg/audio/chains'
import { ANALYSIS_RATE, decodeAnalysis, imd, smpteSource, spectrum } from './distortion'
import { createOracle } from './oracle'

const golden = inject('golden')
const ready = !golden.skip && golden.meetsMinimum && (golden.only === null || golden.only.includes('G11'))

const exec = createExec(golden.ffmpeg, { timers: realTimers })
const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
const outDir = join(golden.outDir || '.', 'limiter')

/** The limit setting L: a -2.5 dBTP ceiling less the 0.5 dB limiter margin. */
const LIMIT_DB = -3
/** The SMPTE source peak (linear), so the gain below drives the limiter 6 dB over L. */
const SOURCE_PEAK = 0.5
const REDUCTION_DB = 6
const GAIN_DB = LIMIT_DB + REDUCTION_DB - 20 * Math.log10(SOURCE_PEAK)

interface LimiterReading
{
  lowHz: number
  sourceImdDb: number
  imdDb: number
  truePeakDbtp: number
  truePeakMethod: string
  samplePeakDb: number
}

const readings: LimiterReading[] = []

async function ff(args: readonly string[]): Promise<void>
{
  const lines: string[] = []
  const r = await exec.run(['-loglevel', 'level+error', ...args], { signal: new AbortController().signal, stop: 'kill', onStderrLine: (line) => lines.push(line) })
  if (r.code !== 0 || r.stopped !== 'none')
  {
    throw new Error(`ffmpeg exited with ${r.code}: ${lines.slice(-4).join(' | ')}`)
  }
}

/** The limiter chain under test: float, the gain, the production limiter stages at L, and the 48 kHz pin. */
function chain(): string[]
{
  return [
    'aformat=sample_fmts=dbl',
    `volume=${formatDb(GAIN_DB)}:precision=double`,
    ...limiterStages(LIMIT_DB, ANALYSIS_RATE),
    ...pinStages({ sampleRate: ANALYSIS_RATE, layout: 'stereo', pin: 'encoder' })
  ]
}

async function limited(lowHz: number): Promise<{ source: string; file: string }>
{
  const source = join(outDir, `smpte-${lowHz}.wav`)
  const file = join(outDir, `smpte-${lowHz}-limited.wav`)
  await ff(['-y', '-f', 'lavfi', '-i', smpteSource({ lowHz, peak: SOURCE_PEAK, seconds: 4 }), '-c:a', 'pcm_f32le', source])
  await ff(['-y', '-i', source, '-filter_complex', `[0:a:0]${chain().join(',')}[a]`, '-map', '[a]', '-c:a', 'pcm_f32le', file])
  return { source, file }
}

describe.skipIf(!ready)('G11 limiter on real FFmpeg', () =>
{
  beforeAll(async () =>
  {
    await mkdir(outDir, { recursive: true })
  })

  afterAll(async () =>
  {
    if (readings.length === 0) return
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-limiter.json`),
      JSON.stringify({ limitDb: LIMIT_DB, gainDb: GAIN_DB, chain: chain(), readings }, null, 2))
  })

  it('runs the production limiter stages with the oversampler at 192 kHz', () =>
  {
    expect(limiterStages(LIMIT_DB, ANALYSIS_RATE)).toEqual([
      'aresample=192000',
      'alimiter=limit=-3.00dB:attack=20:release=200:level=disabled:latency=1'
    ])
  })

  it.each([60, 30])('keeps SMPTE IMD at or below -50 dB with %d Hz plus 7 kHz at 6 dB of gain reduction', async (lowHz) =>
  {
    const { source, file } = await limited(lowHz)
    const sourceImdDb = imd(spectrum(await decodeAnalysis(golden.ffmpeg, source)), { lowHz })
    const imdDb = imd(spectrum(await decodeAnalysis(golden.ffmpeg, file)), { lowHz })
    const tp = await oracle.truePeak(file)
    const stats = await oracle.sampleStats(file)
    readings.push({ lowHz, sourceImdDb, imdDb, truePeakDbtp: tp.dbtp, truePeakMethod: tp.method, samplePeakDb: stats.peakDb })

    expect(sourceImdDb).toBeLessThan(-80)
    expect(imdDb).toBeLessThanOrEqual(-50)
    expect(tp.dbtp).toBeLessThanOrEqual(LIMIT_DB + 0.3)
    expect(stats.over0dBFS).toBe(0)
    expect(stats.peakDb).toBeGreaterThan(LIMIT_DB - 1)
    expect(stats.peakDb - (20 * Math.log10(SOURCE_PEAK) + GAIN_DB)).toBeLessThanOrEqual(-(REDUCTION_DB - 1))
  })
})
