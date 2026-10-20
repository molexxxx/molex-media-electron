import { describe, it, expect, inject, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { meterPrefix } from '../../src/main/ffmpeg/audio/chains'
import { buildDownmixProbeArgs, downmixStage, monoFoldStage, parseDownmixInfo } from '../../src/main/ffmpeg/audio/downmix'
import type { DownmixLevels } from '../../src/main/ffmpeg/audio/downmix'
import { renderMessage } from '../../src/shared/audio/messages'
import { createOracle } from './oracle'

const golden = inject('golden')
const wanted = (id: string): boolean => golden.only === null || golden.only.includes(id)
const ready = !golden.skip && golden.meetsMinimum

const exec = createExec(golden.ffmpeg, { timers: realTimers })
const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
const outDir = join(golden.outDir || '.', 'downmix')

/** Gain of the BS.1770 surround weighting (1.41) that a 5.1 reading applies to SL and SR. */
const SURROUND_WEIGHT_DB = 10 * Math.log10(1.41)
/** A BS.775-4 surround coefficient of 1/sqrt(2) into each stereo channel. */
const SURROUND_COEFFICIENT_DB = 20 * Math.log10(Math.SQRT1_2)

/** Runs ffmpeg through the app's exec and rejects on a non-zero exit, with the last stderr lines. */
async function ff(args: readonly string[]): Promise<string[]>
{
  const lines: string[] = []
  const r = await exec.run(['-loglevel', 'level+info', ...args], { signal: new AbortController().signal, stop: 'kill', onStderrLine: (line) => lines.push(line) })
  if (r.code !== 0 || r.stopped !== 'none')
  {
    throw new Error(`ffmpeg exited with ${r.code}: ${lines.slice(-4).join(' | ')}`)
  }
  return lines
}

/** Runs one filter chain on audio stream 0 into 32-bit float WAV, no gain. */
async function render(input: string[], stages: readonly string[], name: string): Promise<string>
{
  const file = join(outDir, name)
  await ff(['-y', ...input, '-filter_complex', `[0:a:0]${stages.join(',')}[a]`, '-map', '[a]', '-c:a', 'pcm_f32le', file])
  return file
}

async function levelsOf(file: string): Promise<DownmixLevels | null>
{
  return parseDownmixInfo((await ff(buildDownmixProbeArgs(file, 0))).join('\n'))
}

function integrated(r: { integratedPrecise: number | null; integrated: number }): number
{
  return r.integratedPrecise ?? r.integrated
}

function flatFactor(stats: Record<string, number>): number
{
  const key = Object.keys(stats).find((k) => /^flat.factor$/i.test(k))
  if (key === undefined) throw new Error(`astats printed no flat factor: ${Object.keys(stats).join(', ')}`)
  return stats[key]
}

/** Measured values, written to the report folder for the per-build record. */
const measured: Record<string, number | string | null> = {}

beforeAll(async () =>
{
  if (ready) await mkdir(outDir, { recursive: true })
})

afterAll(async () =>
{
  if (!ready || Object.keys(measured).length === 0) return
  await mkdir(golden.reportDir, { recursive: true })
  await writeFile(join(golden.reportDir, `${golden.buildId}-downmix.json`), JSON.stringify(measured, null, 2))
})

describe.skipIf(!ready || !wanted('G10'))('G10 downmix on real FFmpeg', () =>
{
  it('downmixes surround-only 5.1(side) by BS.775-4 to I_in - 1.49 - 3.01 dB', async () =>
  {
    const source = golden.corpus['surround_only51side.wav']
    expect(source).toBeTruthy()
    const layout = (await oracle.audioStream(source)).layout
    expect(layout).toBe('5.1(side)')
    expect(await levelsOf(source)).toBeNull()
    expect(downmixStage('standard', '5.1(side)', null)?.coefficients).toBe('bs775')

    const stages = meterPrefix({ inputLayout: '5.1(side)', monoToStereo: false, downmix: 'standard', downmixLevels: null, dynamics: null })
    const file = await render(['-i', source], stages, 'surround-only-stereo.wav')
    const out = await oracle.audioStream(file)
    expect(out.channels).toBe(2)
    const before = integrated(await oracle.loudness(source))
    const after = integrated(await oracle.loudness(file))
    const stats = await oracle.sampleStats(file)
    expect(stats.peakDb).toBeGreaterThan(-60)
    Object.assign(measured, { surroundOnlyIn: before, surroundOnlyOut: after, surroundOnlyExpected: before - SURROUND_WEIGHT_DB + SURROUND_COEFFICIENT_DB })
    expect(after).toBeGreaterThan(-70)
    expect(Math.abs(after - (before - SURROUND_WEIGHT_DB + SURROUND_COEFFICIENT_DB))).toBeLessThanOrEqual(0.5)
  })

  it('downmixes coherent 16-bit 5.1 without a flat run (flat factor 0)', async () =>
  {
    const source = golden.corpus['coherent51_s16.wav']
    expect(source).toBeTruthy()
    const a = await oracle.audioStream(source)
    const stages = meterPrefix({ inputLayout: a.layout ?? '5.1', monoToStereo: false, downmix: 'standard', downmixLevels: null, dynamics: null })
    const file = await render(['-i', source], stages, 'coherent-stereo.wav')
    const stats = await oracle.astats(file)
    Object.assign(measured, { coherentFlatFactor: flatFactor(stats), coherentPeakDb: (await oracle.sampleStats(file)).peakDb })
    expect(flatFactor(stats)).toBe(0)
    expect((await oracle.sampleStats(file)).peakDb).toBeGreaterThan(-60)
  })

  it('folds a correlated stereo pair to mono with its sample peak kept within 0.01 dB', async () =>
  {
    const tone = `aevalsrc=exprs='0.5*sin(2*PI*997*t)|0.5*sin(2*PI*997*t)':s=48000:d=3:c=stereo`
    const source = await render(['-f', 'lavfi', '-i', tone], ['aformat=sample_fmts=flt'], 'correlated-source.wav')
    const fold = monoFoldStage('stereo', null)
    expect(fold?.coefficients).toBe('fold')
    const file = await render(['-i', source], fold?.stages ?? [], 'correlated-mono.wav')
    const before = await oracle.sampleStats(source)
    const after = await oracle.sampleStats(file)
    Object.assign(measured, { correlatedPeakIn: before.peakDb, correlatedPeakOut: after.peakDb })
    expect(after.channels).toBe(1)
    expect(Math.abs(after.peakDb - before.peakDb)).toBeLessThanOrEqual(0.01)
  })

  it('folds uncorrelated stereo noise to mono about 3 dB lower in power', async () =>
  {
    const noise = (seed: number): string[] => ['-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.25:seed=${seed}:duration=5:sample_rate=48000`]
    const source = join(outDir, 'uncorrelated-source.wav')
    await ff(['-y', ...noise(11), ...noise(29), '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]', '-map', '[a]', '-c:a', 'pcm_f32le', source])
    const fold = monoFoldStage('stereo', null)
    const file = await render(['-i', source], fold?.stages ?? [], 'uncorrelated-mono.wav')
    const before = await oracle.sampleStats(source)
    const after = await oracle.sampleStats(file)
    Object.assign(measured, { uncorrelatedRmsIn: before.rmsDb, uncorrelatedRmsOut: after.rmsDb })
    expect(before.maxChannelDifference).toBeGreaterThan(0)
    expect(after.rmsDb - before.rmsDb).toBeCloseTo(-3.01, 0)
    expect(Math.abs(after.rmsDb - before.rmsDb + 3.01)).toBeLessThanOrEqual(0.2)
  })
})

describe.skipIf(!ready || !wanted('G17'))('G17 downmix determinism on real FFmpeg', () =>
{
  const source = golden.corpus['surround51side.mkv']
  let levels: DownmixLevels | null = null
  let decoded = ''

  beforeAll(async () =>
  {
    if (!source) return
    levels = await levelsOf(source)
    decoded = join(outDir, 'ac3-decoded.wav')
    await ff(['-y', '-i', source, '-map', '0:a:0', '-c:a', 'pcm_f32le', decoded])
  })

  it('reads the AC-3 encoder default levels, center 0.594604 and surround 0.500000', async () =>
  {
    expect(source).toBeTruthy()
    const a = await oracle.audioStream(source)
    expect(a.codec).toBe('ac3')
    expect(a.layout).toBe('5.1(side)')
    expect(levels).not.toBeNull()
    expect(levels?.centerLoRo.toFixed(6)).toBe('0.594604')
    expect(levels?.surroundLoRo.toFixed(6)).toBe('0.500000')
  })

  it('gives the same pan downmix on the AC-3 stream and on its PCM decode, which carries no side data', async () =>
  {
    expect(await levelsOf(decoded)).toBeNull()
    const stage = downmixStage('standard', '5.1(side)', levels)
    expect(stage).not.toBeNull()
    const filter = `aformat=sample_fmts=dbl,${stage?.stage}`
    const coded = integrated(await oracle.loudness(source, { filter }))
    const pcm = integrated(await oracle.loudness(decoded, { filter }))
    Object.assign(measured, { panOnAc3: coded, panOnPcm: pcm, center: levels?.centerLoRo ?? null, surround: levels?.surroundLoRo ?? null })
    expect(Number.isFinite(coded)).toBe(true)
    expect(Math.abs(coded - pcm)).toBeLessThanOrEqual(0.05)
  })

  it('chooses the stream levels for the downmix and says so', () =>
  {
    const chosen = downmixStage('standard', '5.1(side)', levels)
    const standard = downmixStage('standard', '5.1(side)', null)
    expect(chosen?.coefficients).toBe('stream-metadata')
    expect(chosen?.stage).not.toBe(standard?.stage)
    expect(chosen?.stage).toContain('0.594604')
    const db = (linear: number): number => Math.round(2000 * Math.log10(linear)) / 100
    const message = renderMessage({ key: 'downmix-metadata', params: { layout: '5.1(side)', c: db(levels?.centerLoRo ?? 0), s: db(levels?.surroundLoRo ?? 0) } },
      { minus: 'hyphen' })
    measured.message = message
    expect(message).toContain("the stream's own downmix levels")
    expect(message).toMatch(/center -4\.5\d? dB/)
    expect(message).toMatch(/surrounds -6(\.0\d?)? dB/)
  })
})
