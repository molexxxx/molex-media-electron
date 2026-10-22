import { describe, it, expect, inject, beforeAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExec } from '../../src/main/ffmpeg/exec'
import { realTimers } from '../../src/main/timers'
import { encodeParts, exportLimiterTail, filterComplex, meterOutputArgs } from '../../src/main/ffmpeg/audio/chains'
import type { ChainOutput, ChainSpec } from '../../src/main/ffmpeg/audio/chains'
import { compressorStage, NIGHT } from '../../src/main/ffmpeg/audio/dynamics'
import { resolveCeiling } from '../../src/main/ffmpeg/audio/ceilings'
import { LAYOUT_CHANNELS } from '../../src/main/ffmpeg/audio/downmix'

const golden = inject('golden')
const enabled = !golden.skip && golden.meetsMinimum && (golden.only === null || golden.only.includes('G16'))

/** One graph run: lavfi inputs, a filter graph, the output encoder into the null muxer, and the meter output, if any. */
interface ChainCase
{
  name: string
  inputs: string[]
  graph: string
  encoder: string
  codecArgs: string[]
  /** The second output that drains the meter branch [p0], or empty. */
  outputs: string[]
}

interface ChainRun
{
  name: string
  encoder: string
  code: number | null
  stopped: string
  skipped: string | null
  errors: string[]
  ms: number
}

/** A tone per channel at a distinct frequency, so a wrong channel map changes the signal. */
function tone(layout: string, rate: number, seconds = 2, amplitude = 0.25): string
{
  const channels = LAYOUT_CHANNELS[layout]
  const exprs = channels.map((_, i) => `${amplitude}*sin(2*PI*${200 + 150 * i}*t)`).join('|')
  return `aevalsrc=exprs='${exprs}':s=${rate}:d=${seconds}:c=${layout}`
}

function out(sampleRate: number, layout: string, pin: ChainOutput['pin'], encoder?: string): ChainOutput
{
  return encoder === undefined ? { sampleRate, layout, pin } : { sampleRate, layout, pin, encoder }
}

function spec(inputLayout: string, processRate: number, output: ChainOutput, o: Partial<ChainSpec> = {}): ChainSpec
{
  return {
    inputLayout,
    processRate,
    monoToStereo: false,
    downmix: null,
    downmixLevels: null,
    dynamics: null,
    highpassHz: 0,
    gainDb: 3,
    limiterCeilingDbtp: -1.5,
    out: output,
    preEncodeMeter: null,
    ...o
  }
}

function production(name: string, inputLayout: string, rate: number, s: ChainSpec, encoder: string, codecArgs: string[] = []): ChainCase
{
  return {
    name, inputs: [tone(inputLayout, rate)], graph: filterComplex(encodeParts(s, '0:a:0', 0)), encoder, codecArgs,
    outputs: meterOutputArgs(s.preEncodeMeter === null ? [] : [0])
  }
}

const AC3_LEVELS = { centerLoRo: 0.594604, surroundLoRo: 0.5, preferred: 'unknown' as const }
const meter: 'soxr' | 'swr' = golden.soxr ? 'soxr' : 'swr'

/** The production encode chains: every pin, the remaps, downmixes, mono rules, dynamics, meters, and rates. */
const PRODUCTION: ChainCase[] = [
  production('flac s16 dither 44.1k', 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 's16-dither')), 'flac'),
  production('flac s32 44.1k', 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 's32')), 'flac'),
  production('flac s32 96k to 48k', 'stereo', 96000, spec('stereo', 96000, out(48000, 'stereo', 's32')), 'flac'),
  production('flac s32 192k without oversampler', 'stereo', 192000, spec('stereo', 192000, out(192000, 'stereo', 's32')), 'flac'),
  production('alac s16', 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 's16-dither', 'alac')), 'alac'),
  production('alac s32', 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 's32', 'alac')), 'alac'),
  production('pcm s16 48k', 'stereo', 48000, spec('stereo', 48000, out(48000, 'stereo', 's16-dither'), { gainDb: -6 }), 'pcm_s16le'),
  production('pcm s24 48k', 'stereo', 48000, spec('stereo', 48000, out(48000, 'stereo', 's32')), 'pcm_s24le'),
  production('pcm f32 encoder pin', 'stereo', 48000, spec('stereo', 48000, out(48000, 'stereo', 'encoder')), 'pcm_f32le'),
  production('mono duplicated to flac', 'mono', 44100, spec('mono', 44100, out(44100, 'stereo', 's16-dither'), { monoToStereo: true }), 'flac'),
  production('mono one channel to flac', 'mono', 44100, spec('mono', 44100, out(44100, 'mono', 's16-dither')), 'flac'),
  production('mono 32k to aac', 'mono', 32000, spec('mono', 32000, out(32000, 'mono', 'encoder'), { preEncodeMeter: 'swr' }), 'aac',
    ['-b:a', '96k', '-aac_coder', 'fast']),
  production('mono duplicated to mp3', 'mono', 44100,
    spec('mono', 44100, out(44100, 'stereo', 'encoder'), { monoToStereo: true, preEncodeMeter: 'swr' }), 'libmp3lame', ['-b:a', '192k']),
  production(`aac ${meter} meter`, 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 'encoder'), { preEncodeMeter: meter }), 'aac',
    ['-b:a', '256k', '-aac_coder', 'fast']),
  production('aac swr meter', 'stereo', 48000, spec('stereo', 48000, out(48000, 'stereo', 'encoder'), { preEncodeMeter: 'swr' }), 'aac',
    ['-b:a', '256k', '-aac_coder', 'fast']),
  production('mp3 swr meter', 'stereo', 44100, spec('stereo', 44100, out(44100, 'stereo', 'encoder'), { preEncodeMeter: 'swr' }), 'libmp3lame',
    ['-b:a', '320k']),
  production('opus 5.1(side) remapped to 5.1', '5.1(side)', 48000,
    spec('5.1(side)', 48000, out(48000, '5.1', 'encoder'), { preEncodeMeter: 'swr' }), 'libopus', ['-b:a', '384k']),
  production('aac 5.1(side) remapped to 5.1', '5.1(side)', 48000,
    spec('5.1(side)', 48000, out(48000, '5.1', 'encoder'), { preEncodeMeter: 'swr' }), 'aac', ['-b:a', '384k', '-aac_coder', 'fast']),
  production('ac3 5.1(side)', '5.1(side)', 48000, spec('5.1(side)', 48000, out(48000, '5.1(side)', 'encoder'), { preEncodeMeter: 'swr' }), 'ac3',
    ['-b:a', '448k']),
  production('eac3 5.1(side)', '5.1(side)', 48000, spec('5.1(side)', 48000, out(48000, '5.1(side)', 'encoder')), 'eac3', ['-b:a', '640k']),
  production('5.1(side) standard downmix to flac', '5.1(side)', 48000,
    spec('5.1(side)', 48000, out(48000, 'stereo', 's16-dither'), { downmix: 'standard' }), 'flac'),
  production('5.1(side) dialog downmix to aac', '5.1(side)', 48000,
    spec('5.1(side)', 48000, out(48000, 'stereo', 'encoder'), { downmix: 'dialog', preEncodeMeter: 'swr' }), 'aac', ['-b:a', '256k', '-aac_coder', 'fast']),
  production('5.1(side) stream levels downmix to mp3', '5.1(side)', 48000,
    spec('5.1(side)', 48000, out(48000, 'stereo', 'encoder'), { downmix: 'standard', downmixLevels: AC3_LEVELS, preEncodeMeter: 'swr' }), 'libmp3lame',
    ['-b:a', '320k']),
  production('7.1 standard downmix to flac', '7.1', 48000, spec('7.1', 48000, out(48000, 'stereo', 's32'), { downmix: 'standard' }), 'flac'),
  production('7.1 kept in flac', '7.1', 48000, spec('7.1', 48000, out(48000, '7.1', 's32')), 'flac'),
  production('night compressor to aac', 'stereo', 48000,
    spec('stereo', 48000, out(48000, 'stereo', 'encoder'), { dynamics: compressorStage(NIGHT, -20), preEncodeMeter: 'swr' }), 'aac',
    ['-b:a', '256k', '-aac_coder', 'fast']),
  production('high-pass to vorbis', 'stereo', 48000, spec('stereo', 48000, out(48000, 'stereo', 'encoder'), { highpassHz: 80 }), 'libvorbis',
    ['-b:a', '192k']),
  {
    name: 'timeline export tail after amix',
    inputs: [tone('stereo', 48000), tone('stereo', 48000)],
    graph: `[0:a][1:a]amix=inputs=2:normalize=0,volume=2,${exportLimiterTail(resolveCeiling('aac', 128, -1), 48000, 'stereo').join(',')}[a0]`,
    encoder: 'aac',
    codecArgs: ['-b:a', '256k', '-aac_coder', 'fast'],
    outputs: []
  }
]

/** The legacy pass-2 tail: dynamic loudnorm (no measured values) followed by a bare aresample to the source rate. */
const LEGACY_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100'
const LEGACY: ChainCase[] = (['pcm_s16le', 'flac', 'aac', 'alac'] as const).map((encoder) => ({
  name: `legacy dynamic loudnorm and bare aresample to ${encoder}`,
  inputs: [tone('stereo', 44100)],
  graph: `[0:a]${LEGACY_FILTER}[a0]`,
  encoder,
  codecArgs: [],
  outputs: []
}))

const exec = createExec(golden.ffmpeg, { timers: realTimers })

async function runCase(c: ChainCase): Promise<ChainRun>
{
  if (!golden.encoders.includes(c.encoder))
  {
    return { name: c.name, encoder: c.encoder, code: null, stopped: 'none', skipped: `${c.encoder} is not in this build`, errors: [], ms: 0 }
  }
  const errors: string[] = []
  const args = ['-loglevel', 'level+error', ...c.inputs.flatMap((input) => ['-f', 'lavfi', '-i', input]),
    '-filter_complex', c.graph, '-map', '[a0]', '-c:a', c.encoder, ...c.codecArgs, '-f', 'null', '-', ...c.outputs]
  const r = await exec.run(args, { signal: new AbortController().signal, stop: 'kill', onStderrLine: (line) => errors.push(line) })
  return { name: c.name, encoder: c.encoder, code: r.code, stopped: r.stopped, skipped: null, errors: errors.filter((line) => line.trim() !== ''), ms: r.ms }
}

async function runAll(cases: readonly ChainCase[], width = 4): Promise<Map<string, ChainRun>>
{
  const results = new Map<string, ChainRun>()
  let next = 0
  const worker = async (): Promise<void> =>
  {
    while (next < cases.length)
    {
      const c = cases[next++]
      results.set(c.name, await runCase(c))
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

describe.skipIf(!enabled)('G16 production chains on real FFmpeg', () =>
{
  let production = new Map<string, ChainRun>()
  let legacy = new Map<string, ChainRun>()

  beforeAll(async () =>
  {
    const started = Date.now()
    production = await runAll(PRODUCTION)
    legacy = await runAll(LEGACY)
    await mkdir(golden.reportDir, { recursive: true })
    await writeFile(join(golden.reportDir, `${golden.buildId}-chains.json`), JSON.stringify({
      versionString: golden.versionString,
      ms: Date.now() - started,
      legacyFilter: LEGACY_FILTER,
      legacy: [...legacy.values()],
      production: [...production.values()]
    }, null, 2))
  })

  it.each(PRODUCTION.map((c) => [c.name, c] as const))('%s exits 0', (name, c) =>
  {
    const run = production.get(name)
    expect(run, name).toBeDefined()
    if (run?.skipped)
    {
      expect(['libvorbis', 'pcm_f32le']).toContain(c.encoder)
      return
    }
    expect({ name, code: run?.code, stopped: run?.stopped, errors: run?.code === 0 ? [] : run?.errors }).toEqual(
      { name, code: 0, stopped: 'none', errors: [] })
  })

  it('records the legacy chain exit per build without asserting it', () =>
  {
    for (const c of LEGACY)
    {
      const run = legacy.get(c.name)
      expect(run, c.name).toBeDefined()
      expect(run?.stopped).toBe('none')
      expect(typeof run?.code === 'number' || run?.skipped !== null).toBe(true)
    }
    console.log(`[G16] ${golden.buildId} legacy exits: ${[...legacy.values()].map((r) => `${r.encoder}=${r.code}`).join(', ')}`)
  })

  it('pins every production chain with aformat and never ends a chain in a bare aresample', () =>
  {
    for (const c of PRODUCTION)
    {
      const main = c.graph.split(';')[0]
      const stages = main.replace(/^\[[^\]]*\]/, '').replace(/\[[^\]]*\](\[[^\]]*\])*$/, '').split(',')
      const last = stages[stages.length - 1].startsWith('asplit') ? stages[stages.length - 2] : stages[stages.length - 1]
      expect(last, c.name).toMatch(/^aformat=/)
      expect(stages.some((stage) => /^aresample(=\d+)?$/.test(stage) && stage === last), c.name).toBe(false)
    }
  })
})
