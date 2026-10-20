import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { runExportJob, type ExportDeps, type ExportVerification } from '../../src/main/ffmpeg/processor/export'
import { buildExportCommand, exportCeiling, type ExportOutputOptions, type ExportRequest } from '../../src/main/ffmpeg/processor/editor'
import { createOracle } from './oracle'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const golden = inject('golden')
const ready = !golden.skip && golden.meetsMinimum && (golden.only === null || golden.only.includes('G14'))

const exec = createExec(golden.ffmpeg, { timers: realTimers })
const oracle = createOracle({ ffmpeg: golden.ffmpeg, ffprobe: golden.ffprobe, soxr: golden.soxr })
const outDir = join(golden.outDir || '.', 'export')
const SOURCE = 'music4410.flac'
const SECONDS = 8
const FPS = 30

/** The app and oracle true-peak meters agree within this when they differ (swr against the interpolator, G3). */
const METER_SPREAD_DB = 0.55

interface ExportCase
{
  id: string
  output: Pick<ExportOutputOptions, 'format' | 'audioCodec'> & Partial<ExportOutputOptions>
  ext: string
  limit: string
}

const CASES: readonly ExportCase[] = [
  { id: 'aac-192k', output: { format: 'mp4', audioCodec: 'aac', audioBitrate: '192k' }, ext: 'm4a', limit: 'alimiter=limit=-2.50dB' },
  { id: 'pcm-s16', output: { format: 'wav', audioCodec: 'pcm_s16le' }, ext: 'wav', limit: 'alimiter=limit=-1.50dB' }
]

interface ExportReading
{
  id: string
  appTruePeakDbtp: number | null
  oracleTruePeakDbtp: number
  oracleMethod: string
  samplePeakDb: number
  integratedLufs: number | null
  outcome: ExportVerification['outcome']
}

const readings: ExportReading[] = []

/** Two audio tracks over the same music: the first clip at volume 2 (+6 dB), summed by amix at full level. */
function twoTrackMix(c: ExportCase): ExportRequest
{
  const clip = { sourceId: 's1', timelineStart: 0, sourceIn: 0, sourceOut: SECONDS * FPS, muted: false, pan: 0, speed: 1 }
  return {
    project: { frameRate: FPS, sampleRate: 48000, resolution: { width: 1280, height: 720 } },
    sources: [{ id: 's1', filePath: golden.corpus[SOURCE], frameRate: FPS, width: 0, height: 0, audioChannels: 2, audioSampleRate: 44100, durationSeconds: SECONDS }],
    tracks: [
      { id: 'a1', type: 'audio', name: 'A1', index: 0, muted: false, visible: true },
      { id: 'a2', type: 'audio', name: 'A2', index: 1, muted: false, visible: true }
    ],
    clips: [{ ...clip, id: 'c1', trackId: 'a1', volume: 2 }, { ...clip, id: 'c2', trackId: 'a2', volume: 1 }],
    output: { filePath: join(outDir, `mix-${c.id}.${c.ext}`), videoCodec: 'libx264', ...c.output }
  }
}

function deps(c: ExportCase, logs: string[]): ExportDeps
{
  return {
    exec,
    output: (ext) => join(outDir, `mix-${c.id}.${ext}`),
    fs: { remove: (p) => rm(p, { force: true }), size: async (p) => (await stat(p)).size },
    log: (entry) => { logs.push(`${entry.level}: ${entry.message} ${JSON.stringify(entry.data ?? {})}`) },
    meter: golden.soxr ? 'soxr' : 'swr'
  }
}

describe.skipIf(!ready)('G14 timeline export on real FFmpeg', () =>
{
  beforeAll(async () =>
  {
    await mkdir(outDir, { recursive: true })
  })

  afterAll(async () =>
  {
    if (readings.length === 0) return
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-export.json`), JSON.stringify({ source: SOURCE, seconds: SECONDS, readings }, null, 2))
  })

  it.each(CASES)('exports a two-track mix at volume 2 as $id under the gate, with a verify verdict', async (c) =>
  {
    const request = twoTrackMix(c)
    const args = await buildExportCommand(request)
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(new RegExp(`normalize=0\\[\\w+\\];\\[\\w+\\]aformat=sample_fmts=dbl,aresample=192000,${c.limit}:`))

    const logs: string[] = []
    const result = await runExportJob(request, deps(c, logs), new AbortController().signal)
    expect(result.status, logs.join('\n')).toBe('done')
    if (result.status !== 'done' || result.verification === null)
    {
      throw new Error(`no verification: ${logs.join(' | ')}`)
    }
    const v = result.verification
    const gate = exportCeiling(request.output).gateDbtp
    const tp = await oracle.truePeak(result.outputPath)
    const stats = await oracle.sampleStats(result.outputPath)
    const decode = await oracle.decodeCheck(result.outputPath)
    readings.push({
      id: c.id,
      appTruePeakDbtp: v.truePeakDbtp,
      oracleTruePeakDbtp: tp.dbtp,
      oracleMethod: tp.method,
      samplePeakDb: stats.peakDb,
      integratedLufs: v.integratedLufs,
      outcome: v.outcome
    })

    expect(v.outcome, JSON.stringify({ v, oracle: tp, stats: stats.peakDb })).toBe('verified')
    expect(v.decodeErrorCount).toBe(0)
    expect(v.truePeakDbtp).not.toBeNull()
    expect(v.integratedLufs).not.toBeNull()
    expect(Math.max(v.truePeakDbtp ?? Infinity, tp.dbtp)).toBeLessThanOrEqual(gate)
    expect(Math.abs((v.truePeakDbtp ?? Infinity) - tp.dbtp)).toBeLessThanOrEqual(METER_SPREAD_DB)
    expect(stats.over0dBFS).toBe(0)
    expect(decode.errors).toEqual([])
  })
})
