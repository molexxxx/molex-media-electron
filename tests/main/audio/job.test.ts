/**
 * The audio job pieces with a scripted fake Exec that replays stderr and -progress output recorded per pass on the
 * pinned 9.0.2 build (tests/main/fixtures/ffmpeg/job): pass order, argv, events, the one correction and the better
 * pass, written paths, aborts at every stage, refusals, failures with signed exit codes, and the progress replay
 * through the engine's progress tracker.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  analysisKey, analyzeAudioJob, buildEncodeArgs, correctedMessage, correctionReasons, encodeAudioJob, encoderChoices, fileRefusal,
  measureSpecFor, minSampleRateFor, outputShape, planAudioJob, planStatic, progressEvent, runAudioJob, runFailure, worstOutcome
} from '../../../src/main/ffmpeg/audio/job'
import type { AudioJobDeps } from '../../../src/main/ffmpeg/audio/job'
import { containerFor } from '../../../src/main/ffmpeg/audio/containers'
import { toMediaFacts } from '../../../src/main/ffmpeg/audio/facts'
import type { ProbeJson } from '../../../src/main/ffmpeg/audio/facts'
import { execArgv, exitName, normalizeLines, parseProgressBlock, signedExitCode } from '../../../src/main/ffmpeg/exec'
import type { Exec, ExecOptions, ExecResult } from '../../../src/main/ffmpeg/exec'
import { createJobProgress, createSpeedBook } from '../../../src/main/jobs/progress'
import type { PlannedStage } from '../../../src/main/jobs/progress'
import type { AudioEvent, AudioJobResult } from '../../../src/shared/audio/events'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { AudioJobInput, BoostRecipe, MediaFacts, NormalizeRecipe, StreamVerdict } from '../../../src/shared/audio/types'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'job')
const RECORDED = path.join(FIXTURES, '9.0.2')

interface RunRecord { name: string; tool: string; argv: string[]; code: number | null; signal: string | null; stdout?: string | null; stderr?: string | null }

const RUNS = (JSON.parse(fs.readFileSync(path.join(RECORDED, 'runs.json'), 'utf8')) as { runs: RunRecord[] }).runs

function record(name: string): RunRecord & { stderrText: string; stdoutText: string }
{
  const run = RUNS.find((r) => r.name === name)
  if (run === undefined)
  {
    throw new Error(`No recorded run ${name}`)
  }
  const read = (file: string | null | undefined): string => (file === undefined || file === null ? '' : fs.readFileSync(path.join(RECORDED, file), 'utf8'))
  return { ...run, stderrText: read(run.stderr), stdoutText: read(run.stdout) }
}

const PREFIX = execArgv([], 'kill')

/** The recorded argv after exec's prefix. */
function recordedArgs(name: string, rename: Record<string, string> = {}): string[]
{
  return record(name).argv.slice(PREFIX.length).map((a) => rename[a] ?? a)
}

function probeJson(name: string): ProbeJson
{
  return JSON.parse(record(name).stdoutText) as ProbeJson
}

const CAPS = {
  encoders: new Set(['aac', 'ac3', 'eac3', 'flac', 'alac', 'libopus', 'libvorbis', 'libmp3lame', 'mp2', 'wmav2', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']),
  experimental: new Set<string>(),
  soxr: true
}

type Step =
  | { fixture?: string; stderr?: string; code?: number | null; outputRefused?: boolean; stopped?: ExecResult['stopped']; abort?: AbortController }
  | { throws: Error; abort?: AbortController }

interface FakeExec extends Exec
{
  calls: string[][]
}

function progressBlocks(stdout: string): string[]
{
  return normalizeLines(stdout).split(/(?<=progress=(?:continue|end)\n)/).filter((b) => b.trim() !== '')
}

/** Replays one scripted step per run: stderr lines, then -progress blocks, then the result. */
function fakeExec(steps: Step[]): FakeExec
{
  const calls: string[][] = []
  let next = 0
  return {
    calls,
    async run(args: readonly string[], o: ExecOptions): Promise<ExecResult>
    {
      calls.push([...args])
      const step = steps[next++]
      if (step === undefined)
      {
        throw new Error(`Unscripted run: ${args.join(' ')}`)
      }
      if ('throws' in step)
      {
        step.abort?.abort()
        throw step.throws
      }
      const rec = step.fixture === undefined ? null : record(step.fixture)
      const stderr = step.stderr ?? rec?.stderrText ?? ''
      for (const line of normalizeLines(stderr).split('\n'))
      {
        o.onStderrLine?.(line)
      }
      for (const block of progressBlocks(rec?.stdoutText ?? ''))
      {
        const p = parseProgressBlock(block)
        if (p !== null)
        {
          o.onProgress?.(p)
        }
      }
      if (step.abort !== undefined)
      {
        step.abort.abort()
        return { code: null, exitName: null, signal: 'SIGTERM', aborted: true, stopped: 'killed', outputRefused: false, stderrTail: '', ms: 1 }
      }
      const code = step.code === undefined ? (rec?.code ?? 0) : step.code
      return {
        code, exitName: exitName(code), signal: null, aborted: false, stopped: step.stopped ?? 'none', outputRefused: step.outputRefused ?? false,
        stderrTail: normalizeLines(stderr).slice(-2048), ms: 1
      }
    }
  }
}

interface Harness
{
  deps: AudioJobDeps
  events: AudioEvent[]
  outputs: string[]
  removed: string[]
  logs: Array<{ level: string; message: string }>
  probes: string[]
}

function harness(exec: Exec, options: { probe?: string; size?: (p: string) => Promise<number>; remove?: (p: string) => Promise<void>; caps?: typeof CAPS } = {}): Harness
{
  const h: Harness = { deps: null as unknown as AudioJobDeps, events: [], outputs: [], removed: [], logs: [], probes: [] }
  h.deps = {
    exec,
    probe: async (p, signal) =>
    {
      h.probes.push(p)
      if (signal.aborted)
      {
        throw new Error('aborted')
      }
      return probeJson(options.probe ?? 'music-probe')
    },
    caps: options.caps ?? CAPS,
    buildId: 'n9.0.2',
    output: (ext, pass) =>
    {
      const p = `OUT/${pass}.${ext}.part`
      h.outputs.push(p)
      return p
    },
    fs: {
      remove: async (p) =>
      {
        h.removed.push(p)
        await options.remove?.(p)
      },
      size: options.size ?? (async () => 131032)
    },
    emit: (e) => h.events.push(e),
    log: (entry) => h.logs.push(entry),
    now: () => 1700
  }
  return h
}

const EBU_AAC = applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 })
const EBU_SAME = applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' })
const NIGHT = applyLoudnessPreset('night', { kind: 'same-as-source' })
const DOWNMIX: NormalizeRecipe = { ...EBU_SAME, downmix: 'standard' }

function job(recipe: AudioJobInput['recipe'], overrides: Partial<AudioJobInput> = {}): AudioJobInput
{
  return {
    jobId: 'j1', sourcePath: 'IN/music.flac', sourceSize: 537000, sourceMtimeMs: 1000, recipe, facts: null,
    output: { container: 'm4a', muxer: containerFor('m4a').muxer as string }, ...overrides
  }
}

function surroundJob(recipe: AudioJobInput['recipe']): AudioJobInput
{
  return job(recipe, {
    sourcePath: 'IN/surround.mkv', facts: toMediaFacts(probeJson('surround-probe'), 'IN/surround.mkv'),
    output: { container: 'mkv', muxer: 'matroska' }
  })
}

const MUSIC_FACTS = (): MediaFacts => toMediaFacts(probeJson('music-probe'), 'IN/music.flac')

const kinds = (calls: string[][]): string[] => calls.map((args) =>
  args.some((a) => a.includes('ashowinfo')) ? 'downmix'
    : args.some((a) => a.includes('acompressor') && a.includes('ebur128@m')) ? 'measure-dynamics'
      : args.some((a) => a.includes('ebur128@m')) ? 'measure'
        : args.some((a) => a.includes('ebur128@v') || a.includes('astats@s')) ? 'verify' : 'encode')

const order = (events: AudioEvent[]): string[] => events.filter((e) => e.type !== 'audio.progress').map((e) =>
  e.type === 'audio.stage' ? `stage:${e.stage}:${e.encodePass ?? '-'}` : e.type === 'audio.verified' ? `verified:${e.encodePass}` : e.type)

describe('runAudioJob on the recorded music job', () =>
{
  const steps = (): Step[] => [
    { fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }
  ]

  it('runs measure, encode, verify, then one correction, with the argv recorded on the real binary', async () =>
  {
    const exec = fakeExec(steps())
    const h = harness(exec)
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(kinds(exec.calls)).toEqual(['measure', 'encode', 'verify', 'encode', 'verify'])
    expect(exec.calls[0]).toEqual(recordedArgs('music-measure'))
    expect(exec.calls[1]).toEqual(recordedArgs('music-encode', { 'OUT/music-pass1.m4a.part': 'OUT/1.m4a.part' }))
    expect(exec.calls[2]).toEqual(recordedArgs('music-verify', { 'IN/music-pass1.m4a': 'OUT/1.m4a.part' }))
    expect(exec.calls[3]).toEqual(recordedArgs('music-encode-2', { 'OUT/music-pass2.m4a.part': 'OUT/2.m4a.part' }))
    expect(exec.calls[4]).toEqual(recordedArgs('music-verify-2', { 'IN/music-pass2.m4a': 'OUT/2.m4a.part' }))
    expect(result.outcome).toBe('verified')
    expect(result.encodePasses).toBe(2)
    expect(result.outputPath).toBe('OUT/2.m4a.part')
    expect(h.removed).toEqual(['OUT/1.m4a.part'])
    expect(result.streams[0].before.stats.integratedLufs).toBe(-25.2)
    expect(result.streams[0].after?.integratedLufs).toBe(-23)
    expect(result.streams[0].verdict.encodePasses).toBe(2)
    expect(result.messages.map((m) => m.key)).toContain('corrected')
    expect(result.failure).toBeNull()
  })

  it('emits the stage, plan, measurement, verification, and correction events in order', async () =>
  {
    const h = harness(fakeExec(steps()))
    await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(order(h.events)).toEqual([
      'stage:probe:-', 'audio.static-plan', 'stage:measure:-', 'audio.measured', 'audio.planned',
      'stage:encode:1', 'stage:verify:1', 'verified:1', 'audio.correcting', 'stage:encode:2', 'stage:verify:2', 'verified:2'
    ])
    expect(h.events.every((e) => e.jobId === 'j1')).toBe(true)
    const correcting = h.events.find((e) => e.type === 'audio.correcting')
    expect(correcting).toMatchObject({ reasons: ['loudness-off'] })
    const progress = h.events.filter((e) => e.type === 'audio.progress')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((e) => e.type === 'audio.progress' && e.fraction !== null && e.fraction >= 0 && e.fraction <= 1)).toBe(true)
  })

  it('writes only paths from deps.output and touches the file system only through them', async () =>
  {
    const exec = fakeExec(steps())
    const sized: string[] = []
    const h = harness(exec, { size: async (p) => { sized.push(p); return 1000 } })
    await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    const written = exec.calls.filter((args) => kinds([args])[0] === 'encode').map((args) => args[args.length - 1])
    expect(written).toEqual(h.outputs)
    expect([...sized, ...h.removed].every((p) => h.outputs.includes(p))).toBe(true)
  })

  it('keeps the first pass when the correction measures further off, and removes the second', async () =>
  {
    const h = harness(fakeExec([
      { fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify-quiet' }, { fixture: 'music-encode-hot' }, { fixture: 'music-verify-hot' }
    ]))
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(result.outputPath).toBe('OUT/1.m4a.part')
    expect(h.removed).toEqual(['OUT/2.m4a.part'])
    expect(result.outcome).toBe('outside-tolerance')
    expect(result.encodePasses).toBe(2)
    expect(result.streams[0].verdict.encodePasses).toBe(1)
    expect(result.messages.find((m) => m.key === 'kept-first')?.params.dev2).toBeGreaterThan(9)
  })

  it('takes at most one correction even when the second pass is still off', async () =>
  {
    const exec = fakeExec([
      { fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify-quiet' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-quiet' }
    ])
    const h = harness(exec)
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(exec.calls).toHaveLength(5)
    expect(h.events.filter((e) => e.type === 'audio.correcting')).toHaveLength(1)
    expect(result.outcome).toBe('outside-tolerance')
    expect(h.removed).toHaveLength(1)
  })
})

describe('dynamics and downmix passes', () =>
{
  it('measures after the compressor for night listening, before planning, and plans on pass B (D8)', async () =>
  {
    const exec = fakeExec([{ fixture: 'night-measure' }, { fixture: 'night-measure-dynamics' }, { fixture: 'night-encode' }, { fixture: 'night-verify' }])
    const h = harness(exec)
    const result = await runAudioJob(surroundJob(NIGHT), h.deps, new AbortController().signal)
    expect(kinds(exec.calls)).toEqual(['measure', 'measure-dynamics', 'encode', 'verify'])
    expect(exec.calls.slice(0, 3)).toEqual([
      recordedArgs('night-measure'), recordedArgs('night-measure-dynamics'),
      recordedArgs('night-encode', { 'OUT/night-pass1.mkv.part': 'OUT/1.mkv.part' })
    ])
    expect(exec.calls[3]).toEqual(recordedArgs('night-verify', { 'IN/night-pass1.mkv': 'OUT/1.mkv.part' }))
    expect(order(h.events)).toEqual([
      'audio.static-plan', 'stage:measure:-', 'audio.measured', 'stage:measure-dynamics:-', 'audio.measured', 'audio.planned',
      'stage:encode:1', 'stage:verify:1', 'verified:1'
    ])
    const measured = h.events.flatMap((e) => (e.type === 'audio.measured' ? [e] : []))
    expect(measured.map((e) => e.pass)).toEqual(['source', 'after-dynamics'])
    expect(measured[0].streams[0].stats.integratedLufs).toBe(-21)
    expect(measured[1].streams[0].stats.integratedLufs).toBe(-21.7)
    expect(result.streams[0].plan.gainDb).toBeCloseTo(3.7, 6)
    expect(result.streams[0].before.stats.integratedLufs).toBe(-21)
    expect(result.outcome).toBe('verified')
    expect(result.encodePasses).toBe(1)
    expect(result.messages.map((m) => m.key)).toContain('night')
  })

  it('reads the downmix levels first and reuses them for the encode of the same analysis', async () =>
  {
    const exec = fakeExec([{ fixture: 'downmix-downmix' }, { fixture: 'downmix-measure' }, { fixture: 'downmix-encode' }, { fixture: 'downmix-verify' }])
    const h = harness(exec)
    const result = await runAudioJob(surroundJob(DOWNMIX), h.deps, new AbortController().signal)
    expect(kinds(exec.calls)).toEqual(['downmix', 'measure', 'encode', 'verify'])
    expect(exec.calls.slice(0, 2)).toEqual([recordedArgs('downmix-downmix'), recordedArgs('downmix-measure')])
    expect(exec.calls[2]).toEqual(recordedArgs('downmix-encode', { 'OUT/downmix-pass1.mkv.part': 'OUT/1.mkv.part' }))
    expect(result.outcome).toBe('verified')
    const note = result.messages.find((m) => m.key === 'downmix-metadata')
    expect(note?.params).toEqual({ layout: '5.1(side)', c: -4.52, s: -6.02 })
  })

  it('reads the downmix levels again when the analysis came from the cache', async () =>
  {
    const first = harness(fakeExec([{ fixture: 'downmix-downmix' }, { fixture: 'downmix-measure' }]))
    const input = surroundJob(DOWNMIX)
    const analyzed = await analyzeAudioJob(input, first.deps, new AbortController().signal)
    if (analyzed.kind !== 'analysis')
    {
      throw new Error('analysis ended')
    }
    const cached = JSON.parse(JSON.stringify(analyzed.analysis)) as typeof analyzed.analysis
    const exec = fakeExec([{ fixture: 'downmix-downmix' }, { fixture: 'downmix-encode' }, { fixture: 'downmix-verify' }])
    const h = harness(exec)
    const plan = planStatic(cached.facts, input.recipe, CAPS, input.output)
    const result = await encodeAudioJob(input, plan, cached, planAudioJob(cached, plan, input.recipe), h.deps, new AbortController().signal)
    expect(kinds(exec.calls)).toEqual(['downmix', 'encode', 'verify'])
    expect(exec.calls[1]).toEqual(recordedArgs('downmix-encode', { 'OUT/downmix-pass1.mkv.part': 'OUT/1.mkv.part' }))
    expect(result.outcome).toBe('verified')
  })

  it('ends a failed or aborted downmix read like any other run', async () =>
  {
    const failed = harness(fakeExec([{ fixture: 'downmix-downmix', code: 1 }]))
    const result = await runAudioJob(surroundJob(DOWNMIX), failed.deps, new AbortController().signal)
    expect(result.outcome).toBe('failed')
    expect(result.failure?.stage).toBe('measure')
    const controller = new AbortController()
    const input = surroundJob(DOWNMIX)
    const cachedRun = harness(fakeExec([{ fixture: 'downmix-downmix' }, { fixture: 'downmix-measure' }]))
    const analyzed = await analyzeAudioJob(input, cachedRun.deps, new AbortController().signal)
    if (analyzed.kind !== 'analysis')
    {
      throw new Error('analysis ended')
    }
    const cached = JSON.parse(JSON.stringify(analyzed.analysis)) as typeof analyzed.analysis
    const plan = planStatic(cached.facts, input.recipe, CAPS, input.output)
    const h = harness(fakeExec([{ fixture: 'downmix-downmix', abort: controller }]))
    const canceled = await encodeAudioJob(input, plan, cached, planAudioJob(cached, plan, input.recipe), h.deps, controller.signal)
    expect(canceled.outcome).toBe('canceled')
    expect(canceled.encodePasses).toBe(0)
  })
})

describe('abort contract', () =>
{
  it('cancels before anything runs', async () =>
  {
    const controller = new AbortController()
    controller.abort()
    const exec = fakeExec([])
    const h = harness(exec)
    const result = await runAudioJob(job(EBU_AAC), h.deps, controller.signal)
    expect(result.outcome).toBe('canceled')
    expect(h.probes).toEqual([])
    expect(exec.calls).toEqual([])
  })

  it('cancels during the probe without spawning FFmpeg', async () =>
  {
    const controller = new AbortController()
    const exec = fakeExec([])
    const h = harness(exec)
    h.deps.probe = async () =>
    {
      controller.abort()
      throw new Error('ffprobe killed')
    }
    const result = await runAudioJob(job(EBU_AAC), h.deps, controller.signal)
    expect(result).toMatchObject({ outcome: 'canceled', encodePasses: 0, outputPath: null })
    expect(exec.calls).toEqual([])
  })

  it('cancels when the abort lands as the probe resolves', async () =>
  {
    const controller = new AbortController()
    const h = harness(fakeExec([]))
    h.deps.probe = async () =>
    {
      controller.abort()
      return probeJson('music-probe')
    }
    expect((await runAudioJob(job(EBU_AAC), h.deps, controller.signal)).outcome).toBe('canceled')
  })

  it('cancels during measure and during measure after dynamics with nothing to remove', async () =>
  {
    for (const steps of [
      (c: AbortController): Step[] => [{ fixture: 'night-measure', abort: c }],
      (c: AbortController): Step[] => [{ fixture: 'night-measure' }, { fixture: 'night-measure-dynamics', abort: c }]
    ])
    {
      const controller = new AbortController()
      const h = harness(fakeExec(steps(controller)))
      const result = await runAudioJob(surroundJob(NIGHT), h.deps, controller.signal)
      expect(result.outcome).toBe('canceled')
      expect(result.encodePasses).toBe(0)
      expect(h.outputs).toEqual([])
      expect(h.removed).toEqual([])
    }
  })

  it('cancels during encode and during verify and removes the pass output', async () =>
  {
    for (const abortAt of [1, 2])
    {
      const controller = new AbortController()
      const steps: Step[] = [{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }]
      steps[abortAt] = { ...steps[abortAt], abort: controller }
      const h = harness(fakeExec(steps))
      const result = await runAudioJob(job(EBU_AAC), h.deps, controller.signal)
      expect(result).toMatchObject({ outcome: 'canceled', outputPath: null, encodePasses: 1 })
      expect(h.removed).toEqual(['OUT/1.m4a.part'])
    }
  })

  it('cancels during the corrective encode and verify and removes both pass outputs', async () =>
  {
    for (const abortAt of [3, 4])
    {
      const controller = new AbortController()
      const steps: Step[] = [{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }]
      steps[abortAt] = { ...steps[abortAt], abort: controller }
      const h = harness(fakeExec(steps))
      const result = await runAudioJob(job(EBU_AAC), h.deps, controller.signal)
      expect(result).toMatchObject({ outcome: 'canceled', outputPath: null, encodePasses: 2 })
      expect(h.removed).toEqual(['OUT/1.m4a.part', 'OUT/2.m4a.part'])
    }
  })

  it('cancels during the size check after an encode and when the abort lands as the loser is removed', async () =>
  {
    const controller = new AbortController()
    const h = harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }]), { size: async () => { controller.abort(); return 10 } })
    const result = await runAudioJob(job(EBU_AAC), h.deps, controller.signal)
    expect(result.outcome).toBe('canceled')
    expect(h.removed).toEqual(['OUT/1.m4a.part'])
    const late = new AbortController()
    const steps: Step[] = [{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }]
    const h2 = harness(fakeExec(steps), { remove: async () => late.abort() })
    const ended = await runAudioJob(job(EBU_AAC), h2.deps, late.signal)
    expect(ended.outcome).toBe('canceled')
    expect(h2.removed).toEqual(['OUT/1.m4a.part', 'OUT/2.m4a.part'])
  })

  it('cancels a spawn failure that follows an abort', async () =>
  {
    const controller = new AbortController()
    const h = harness(fakeExec([{ throws: new Error('spawn EPERM'), abort: controller }]))
    expect((await runAudioJob(job(EBU_AAC), h.deps, controller.signal)).outcome).toBe('canceled')
  })

  it('treats an aborted encode as canceled when the encode starts after the abort', async () =>
  {
    const controller = new AbortController()
    const h = harness(fakeExec([{ fixture: 'music-measure' }]))
    const input = job(EBU_AAC)
    const analyzed = await analyzeAudioJob(input, h.deps, new AbortController().signal)
    if (analyzed.kind !== 'analysis')
    {
      throw new Error('analysis ended')
    }
    controller.abort()
    const plan = planStatic(analyzed.analysis.facts, input.recipe, CAPS, input.output)
    const result = await encodeAudioJob(input, plan, analyzed.analysis, planAudioJob(analyzed.analysis, plan, input.recipe), h.deps, controller.signal)
    expect(result).toMatchObject({ outcome: 'canceled', encodePasses: 0 })
  })
})

describe('refusals', () =>
{
  it('validates the recipe again at the analysis entry and refuses with invalid-recipe', async () =>
  {
    const exec = fakeExec([])
    const h = harness(exec)
    const result = await runAudioJob(job({ ...EBU_AAC, maxLimitingDb: 99 }), h.deps, new AbortController().signal)
    expect(result.outcome).toBe('refused')
    expect(result.refusals.map((r) => r.code)).toEqual(['invalid-recipe'])
    expect(result.encodePasses).toBe(0)
    expect(h.probes).toEqual([])
    expect(exec.calls).toEqual([])
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true)
  })

  it('refuses a stream the output codec cannot hold and spawns nothing after the probe', async () =>
  {
    const exec = fakeExec([])
    const h = harness(exec, { probe: 'surround-probe' })
    const recipe = applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'mp3', kbpsPerPair: 128 })
    const result = await runAudioJob(job(recipe, { sourcePath: 'IN/surround.mkv', output: { container: 'mka', muxer: 'matroska' } }), h.deps, new AbortController().signal)
    expect(h.probes).toEqual(['IN/surround.mkv'])
    expect(exec.calls).toEqual([])
    expect(result).toMatchObject({ outcome: 'refused', outputPath: null, encodePasses: 0, failure: null })
    expect(result.refusals).toEqual([expect.objectContaining({ audioIndex: 0, code: 'too-many-channels' })])
    expect(result.refusals[0].message).toEqual({ key: 'too-many-channels', params: { codec: 'libmp3lame', n: 2, m: 6 } })
    expect(order(h.events)).toEqual(['stage:probe:-', 'audio.static-plan'])
    expect(h.removed).toEqual([])
  })

  it('refuses a file without audio, an unnamed layout, a layout with no downmix, and one the meter cannot weight', () =>
  {
    const facts = MUSIC_FACTS()
    const output = { container: 'mkv', muxer: 'matroska' }
    expect(planStatic({ ...facts, audio: [] }, EBU_SAME, CAPS, output).refusals).toEqual([fileRefusal('no-audio', 'mkv')])
    const unnamed = { ...facts, audio: [{ ...facts.audio[0], channels: 3, layout: null }] }
    expect(planStatic(unnamed, EBU_SAME, CAPS, output).refusals.map((r) => r.code)).toEqual(['layout-unsupported'])
    const wide = { ...facts, audio: [{ ...facts.audio[0], channels: 8, layout: '7.1(wide)' }] }
    expect(planStatic(wide, DOWNMIX, CAPS, output).refusals.map((r) => r.code)).toEqual(['layout-unsupported'])
    const sixteen = { ...facts, audio: [{ ...facts.audio[0], channels: 16, layout: 'hexadecagonal' }] }
    const refused = planStatic(sixteen, EBU_SAME, CAPS, output)
    expect(refused.refusals.map((r) => r.code)).toEqual(['layout-unsupported'])
    expect(refused.refusals[0].message.key).toBe('dropped')
  })

  it('refuses at encode time when handed a refused static plan', async () =>
  {
    const facts = MUSIC_FACTS()
    const plan = planStatic({ ...facts, audio: [] }, EBU_SAME, CAPS, { container: 'mkv', muxer: 'matroska' })
    const exec = fakeExec([])
    const analysis = { cacheKey: 'k', facts, source: [], afterDynamics: null, measuredAt: 0 }
    const result = await encodeAudioJob(job(EBU_SAME), plan, analysis, [], harness(exec).deps, new AbortController().signal)
    expect(result.outcome).toBe('refused')
    expect(exec.calls).toEqual([])
  })
})

describe('failures', () =>
{
  const musicSteps = (encode: Step): Step[] => [{ fixture: 'music-measure' }, encode]

  it('reports the signed exit code and its name for an unsigned 4294967274 exit', async () =>
  {
    const exec = fakeExec(musicSteps({ fixture: 'music-encode', code: 4294967274 }))
    const h = harness(exec)
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'failed', outputPath: null, encodePasses: 1 })
    expect(result.failure).toMatchObject({ stage: 'encode', encodePass: 1, exitCode: -22, exitName: 'EINVAL', signal: null, decodeErrors: [], decodeErrorCount: 0 })
    expect(result.failure?.argv).toEqual(execArgv(exec.calls[1], 'kill'))
    expect(result.failure?.stderrTail).toContain('Output #0, ipod')
    expect(h.removed).toEqual(['OUT/1.m4a.part'])
    expect(signedExitCode(4294967274)).toBe(-22)
  })

  it('fails an output refused at exit 0 as EEXIST, and a stopped run', async () =>
  {
    const refused = await runAudioJob(job(EBU_AAC), harness(fakeExec(musicSteps({ fixture: 'music-encode', code: 0, outputRefused: true }))).deps, new AbortController().signal)
    expect(refused.failure).toMatchObject({ stage: 'encode', exitCode: 0, exitName: 'EEXIST' })
    const stopped = await runAudioJob(job(EBU_AAC), harness(fakeExec(musicSteps({ fixture: 'music-encode', stopped: 'graceful' }))).deps, new AbortController().signal)
    expect(stopped.outcome).toBe('failed')
  })

  it('fails a run that cannot spawn, a failed probe, a failed measure, and a failed verify', async () =>
  {
    const spawn = await runAudioJob(job(EBU_AAC), harness(fakeExec([{ throws: new Error('spawn ENOENT') }])).deps, new AbortController().signal)
    expect(spawn.failure).toMatchObject({ stage: 'measure', exitCode: null, stderrTail: 'spawn ENOENT' })
    const h = harness(fakeExec([]))
    h.deps.probe = async () => { throw new Error('ffprobe exited 1') }
    const probe = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(probe.failure).toMatchObject({ stage: 'probe', argv: [], stderrTail: 'ffprobe exited 1' })
    const measure = await runAudioJob(job(EBU_AAC), harness(fakeExec([{ fixture: 'music-measure', code: 1 }])).deps, new AbortController().signal)
    expect(measure.failure).toMatchObject({ stage: 'measure', encodePass: null, exitCode: 1 })
    const vh = harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify', code: 1 }]))
    const verify = await runAudioJob(job(EBU_AAC), vh.deps, new AbortController().signal)
    expect(verify.failure).toMatchObject({ stage: 'verify', encodePass: 1 })
    expect(vh.removed).toEqual(['OUT/1.m4a.part'])
  })

  it('fails a measure that exits 0 without a Summary for every stream', async () =>
  {
    const truncated = record('music-measure').stderrText.split('[ebur128@m0')[0]
    const exec = fakeExec([{ stderr: truncated }])
    const result = await runAudioJob(job(EBU_AAC), harness(exec).deps, new AbortController().signal)
    expect(result.failure).toMatchObject({ stage: 'measure', exitCode: 0 })
    expect(exec.calls).toHaveLength(1)
  })

  it('fails an empty or unreadable output before verifying it', async () =>
  {
    for (const size of [async () => 0, async () => { throw new Error('ENOENT') }])
    {
      const exec = fakeExec(musicSteps({ fixture: 'music-encode' }))
      const result = await runAudioJob(job(EBU_AAC), harness(exec, { size }).deps, new AbortController().signal)
      expect(result.failure?.stage).toBe('encode')
      expect(exec.calls).toHaveLength(2)
    }
  })

  it('fails on decode errors with the first 20 lines and the exact count', async () =>
  {
    const errors = Array.from({ length: 25 }, (_, i) => `[aac @ 000001af75012000] [error] Prediction is not allowed in AAC-LC (${i}).`)
    const stderr = record('music-verify').stderrText.replace('[astats@s0', `${errors.join('\n')}\n[astats@s0`)
    const h = harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify', stderr }]))
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(result.outcome).toBe('failed')
    expect(result.encodePasses).toBe(1)
    expect(result.failure).toMatchObject({ stage: 'verify', encodePass: 1, exitCode: 0, decodeErrorCount: 25 })
    expect(result.failure?.decodeErrors).toEqual(errors.slice(0, 20))
    expect(result.messages.at(-1)).toEqual({ key: 'decode-errors', params: { error: errors[0] } })
    expect(result.streams[0].verdict.outcome).toBe('failed')
    expect(h.removed).toEqual(['OUT/1.m4a.part'])
  })

  it('keeps the first pass when the corrective encode fails, and logs a failed removal', async () =>
  {
    const h = harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify-quiet' }, { fixture: 'music-encode-2', code: 1 }]), {
      remove: async () => { throw new Error('EBUSY') }
    })
    const result = await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'outside-tolerance', outputPath: 'OUT/1.m4a.part', encodePasses: 2, failure: null })
    expect(h.removed).toEqual(['OUT/2.m4a.part'])
    expect(result.messages.some((m) => m.key === 'kept-first' || m.key === 'corrected')).toBe(false)
    expect(h.logs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'Corrective encode failed; keeping the first encode', 'Could not remove a pass output'
    ])
  })
})

describe('other recipes', () =>
{
  it('boosts in dB with the high-pass and the limiter, judged against the measured level plus the gain', async () =>
  {
    const boost: BoostRecipe = {
      kind: 'boost', presetId: 'custom', userPreset: null, gainDb: 2, highpassHz: 20, maxTruePeakDbtp: -1, maxLimitingDb: 3,
      mono: 'two-speakers', output: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }
    }
    const exec = fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }])
    const result = await runAudioJob(job(boost), harness(exec).deps, new AbortController().signal)
    expect(kinds(exec.calls)).toEqual(['measure', 'encode', 'verify'])
    expect(exec.calls[0].join(' ')).not.toContain('ametadata')
    const graph = exec.calls[1][exec.calls[1].indexOf('-filter_complex') + 1]
    expect(graph).toContain('highpass=f=20:poles=2,volume=2.00dB:precision=double')
    expect(graph).toContain('alimiter=limit=-3.50dB')
    expect(result.streams[0].plan.targetLufs).toBeCloseTo(-23.2, 6)
    expect(result).toMatchObject({ outcome: 'verified', encodePasses: 1 })
  })

  it('boosts with a gain preset', async () =>
  {
    const recipe = applyGainPreset('gentle-lift', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 })
    const exec = fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }])
    const result = await runAudioJob(job(recipe), harness(exec).deps, new AbortController().signal)
    expect(['verified', 'outside-tolerance']).toContain(result.outcome)
    expect(result.streams[0].plan.requestedGainDb).toBe(recipe.gainDb)
  })

  it('copies a silent stream unchanged and only decode-checks it', async () =>
  {
    const silent = record('music-measure').stderrText.replace(/Peak:\s+-?[\d.]+ dBFS/, 'Peak:       -inf dBFS')
    const exec = fakeExec([{ stderr: silent }, { fixture: 'music-encode' }, { fixture: 'music-verify' }])
    const flac = job(EBU_SAME, { output: { container: 'flac', muxer: 'flac' } })
    const result = await runAudioJob(flac, harness(exec).deps, new AbortController().signal)
    expect(exec.calls[1]).not.toContain('-filter_complex')
    expect(exec.calls[1].join(' ')).toContain('-map 0:0 -c:a:0 copy')
    expect(exec.calls[2].join(' ')).toContain('-map 0:a:0')
    expect(result.streams[0].plan.mode).toBe('passthrough')
    expect(result.outcome).toBe('passthrough')
  })

  it('measures with the swresample reference when the build has no soxr and says so', async () =>
  {
    const caps = { ...CAPS, soxr: false }
    const exec = fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }])
    const result = await runAudioJob(job(EBU_AAC), harness(exec, { caps }).deps, new AbortController().signal)
    expect(exec.calls[1].join(' ')).not.toContain('resampler=soxr')
    expect(result.messages.map((m) => m.key)).toContain('meter-swr')
  })
})

describe('progress replay through the engine progress tracker', () =>
{
  it('never lowers percent, never changes maxEncodePasses, and re-enters only into encode pass 2', async () =>
  {
    const h = harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }]))
    await runAudioJob(job(EBU_AAC), h.deps, new AbortController().signal)
    const durationSec = 8
    const stages: PlannedStage[] = [
      { id: 'probe', pass: 1, passes: 1, durationSec: null }, { id: 'measure', pass: 1, passes: 1, durationSec },
      { id: 'encode', pass: 1, passes: 1, durationSec }, { id: 'verify', pass: 1, passes: 1, durationSec }
    ]
    const tracker = createJobProgress({ stages, jobClass: 'audio', speeds: createSpeedBook(), startedAt: 0 })
    const STATE: Record<string, number> = { 'probe': 0, 'measure': 0, 'measure-dynamics': 0, 'encode': 1, 'verify': 2 }
    const percents: number[] = []
    const maxima = new Set<number>()
    const reentries: Array<{ stage: string; encodePass: number | null; afterCorrection: boolean }> = []
    let state = -1
    let corrected = false
    let t = 0
    for (const e of h.events)
    {
      t += 100
      if (e.type === 'audio.stage')
      {
        maxima.add(e.maxEncodePasses)
        if (STATE[e.stage] < state)
        {
          reentries.push({ stage: e.stage, encodePass: e.encodePass, afterCorrection: corrected })
        }
        state = STATE[e.stage]
        percents.push(tracker.start(e.stage, e.encodePass ?? 1, t).percent)
      }
      else if (e.type === 'audio.progress')
      {
        percents.push(tracker.sample({ outTimeSec: e.outTimeSec, speed: e.speed, bytesWritten: e.bytes }, t).percent)
      }
      else if (e.type === 'audio.correcting')
      {
        corrected = true
        percents.push(tracker.extend([{ id: 'encode', pass: 2, passes: 2, durationSec }, { id: 'verify', pass: 2, passes: 2, durationSec }], t).percent)
      }
    }
    percents.push(tracker.finishStage(t).percent)
    expect(percents.every((p, i) => i === 0 || p >= percents[i - 1])).toBe(true)
    expect(percents.at(-1)).toBe(100)
    expect([...maxima]).toEqual([2])
    expect(reentries).toEqual([{ stage: 'encode', encodePass: 2, afterCorrection: true }])
  })
})

describe('pure pieces', () =>
{
  it('plans a container change with its note, and keeps the requested container when it fits', () =>
  {
    const facts = MUSIC_FACTS()
    const moved = planStatic(facts, EBU_SAME, CAPS, { container: 'mp3', muxer: 'mp3' })
    expect(moved).toMatchObject({ container: 'flac', containerChanged: true, refusals: [] })
    expect(moved.notes).toEqual([{ audioIndex: null, message: { key: 'container-changed', params: { codec: 'flac', ext: 'mp3', newExt: 'flac' } } }])
    const kept = planStatic(facts, EBU_AAC, CAPS, { container: 'm4a', muxer: 'ipod' })
    expect(kept).toMatchObject({ container: 'm4a', containerChanged: false })
    expect(kept.streams[0]).toMatchObject({ audioIndex: 0, encoder: 'aac', bitrateKbps: 128, outputLayout: 'stereo', outputRate: 44100 })
    expect(kept.streams[0].ceiling.presetMaxDbtp).toBe(EBU_AAC.target.maxTruePeakDbtp)
  })

  it('writes the muxer of the new container after a container change', () =>
  {
    const facts = MUSIC_FACTS()
    const input = job(EBU_SAME, { facts, output: { container: 'mp3', muxer: 'mp3' } })
    const staticPlan = planStatic(facts, EBU_SAME, CAPS, input.output)
    const stats = { status: 'measured' as const, integratedLufs: -25.2, thresholdLufs: -35.2, loudnessRangeLu: null, lraStatus: 'not-applicable' as const, maxShortTermLufs: -25.1, truePeakDbtp: -14.4, dialogueLufs: null, dualMono: false, channelWeights: 'bs1770-annex1' as const }
    const analysis = { cacheKey: 'k', facts, source: [{ audioIndex: 0, layout: 'stereo', channels: 2, sampleRate: 44100, stats, loudnessToDialogueLu: null }], afterDynamics: null, measuredAt: 0 }
    const plans = planAudioJob(analysis, staticPlan, EBU_SAME)
    const layout = buildEncodeArgs({ job: input, facts, staticPlan, analysis, levels: new Map(), choices: encoderChoices(facts, EBU_SAME, CAPS, 'flac'), caps: CAPS }, plans, 'OUT/x')
    expect(layout.args.slice(-3)).toEqual(['-f', 'flac', 'OUT/x'])
    expect(layout.verify[0]).toEqual({ spec: expect.objectContaining({ outIndex: 0, passthrough: false, shortTerm: true }), metered: false })
    expect(() => buildEncodeArgs({ job: input, facts, staticPlan, analysis, levels: new Map(), choices: new Map(), caps: CAPS }, plans, 'OUT/x')).toThrow()
    expect(() => planAudioJob({ ...analysis, source: [] }, staticPlan, EBU_SAME)).toThrow()
  })

  it('notes dropped streams by kind and dropped chapters', () =>
  {
    const facts: MediaFacts = { ...MUSIC_FACTS(), chapters: 2, data: [{ streamIndex: 1, codecName: 'bin_data' }, { streamIndex: 2, codecName: 'bin_data' }] }
    const plan = planStatic(facts, applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'pcm', kbpsPerPair: null }), CAPS, { container: 'wav', muxer: 'wav' })
    expect(plan.notes).toEqual(expect.arrayContaining([
      { audioIndex: null, message: { key: 'dropped', params: { n: 2, kind: 'data', ext: 'wav', codecs: 'bin_data' } } },
      { audioIndex: null, message: { key: 'chapters-dropped', params: { ext: 'wav', n: 2 } } }
    ]))
  })

  it('notes a raised rate, a remapped layout, and a source codec without an encoder', () =>
  {
    const facts = MUSIC_FACTS()
    const apple = applyLoudnessPreset('apple-podcasts', { kind: 'codec', codec: 'mp3', kbpsPerPair: 128 })
    const low = { ...facts, audio: [{ ...facts.audio[0], sampleRate: 32000 }] }
    expect(planStatic(low, apple, CAPS, { container: 'mp3', muxer: 'mp3' }).notes.map((n) => n.message)).toContainEqual(
      { key: 'rate-raised', params: { from: 32000, to: 44100, preset: 'apple-podcasts' } })
    const surround = toMediaFacts(probeJson('surround-probe'), 'IN/surround.mkv')
    const aac = applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 })
    expect(planStatic(surround, aac, CAPS, { container: 'mkv', muxer: 'matroska' }).notes.map((n) => n.message.key)).toContain('layout-remapped')
    const dts = { ...surround, audio: [{ ...surround.audio[0], codecName: 'dts' }] }
    expect(planStatic(dts, EBU_SAME, CAPS, { container: 'mkv', muxer: 'matroska' }).notes.map((n) => n.message.key)).toContain('no-encoder')
  })

  it('shapes duplicated mono and stereo downmixes, and reads the preset minimum rate', () =>
  {
    const a = MUSIC_FACTS().audio[0]
    const mono = { ...a, channels: 1, layout: 'mono' }
    const apple = applyLoudnessPreset('apple-podcasts', { kind: 'same-as-source' })
    expect(outputShape(mono, apple)).toEqual({ channels: 2, layout: 'stereo' })
    expect(outputShape(mono, EBU_SAME)).toEqual({ channels: 1, layout: 'mono' })
    expect(outputShape({ ...a, channels: 6, layout: '5.1(side)' }, DOWNMIX)).toEqual({ channels: 2, layout: 'stereo' })
    expect(minSampleRateFor(apple)).toBe(44100)
    expect(minSampleRateFor(EBU_SAME)).toBeNull()
    expect(minSampleRateFor(applyGainPreset('gentle-lift', { kind: 'same-as-source' }))).toBeNull()
    const facts = MUSIC_FACTS()
    expect(measureSpecFor(facts, mono, apple, null, null)).toMatchObject({ dualMono: false, shortTerm: false, dialogue: false })
    expect(measureSpecFor(facts, mono, { ...EBU_SAME, mono: 'two-speakers' }, null, null).dualMono).toBe(true)
    const surround = toMediaFacts(probeJson('surround-probe'), 'IN/surround.mkv')
    expect(measureSpecFor(surround, surround.audio[0], { ...EBU_SAME, cinematic: true }, null, null).dialogue).toBe(true)
  })

  it('keys the analysis by path, build, and dynamics, not by the output codec', () =>
  {
    const facts = MUSIC_FACTS()
    const specs = [measureSpecFor(facts, facts.audio[0], EBU_AAC, null, null)]
    const base = analysisKey(job(EBU_AAC), 'n9.0.2', specs)
    expect(analysisKey(job(EBU_AAC, { sourcePath: 'IN/other.flac' }), 'n9.0.2', specs)).not.toBe(base)
    expect(analysisKey(job(EBU_AAC), '2022-10-13', specs)).not.toBe(base)
    expect(analysisKey(job(EBU_SAME), 'n9.0.2', specs)).toBe(base)
    expect(analysisKey(job(NIGHT), 'n9.0.2', specs)).not.toBe(analysisKey(job({ ...NIGHT, dynamics: null }), 'n9.0.2', specs))
  })

  it('ranks job outcomes with passthrough below every processed stream', () =>
  {
    const v = (outcome: StreamVerdict['outcome']): StreamVerdict => ({ outcome } as StreamVerdict)
    expect(worstOutcome([])).toBe('passthrough')
    expect(worstOutcome([v('passthrough'), v('verified')])).toBe('verified')
    expect(worstOutcome([v('verified-below-target'), v('outside-tolerance'), v('verified')])).toBe('outside-tolerance')
    expect(worstOutcome([v('failed'), v('outside-tolerance')])).toBe('failed')
  })

  it('names correction reasons and builds the corrected message', () =>
  {
    const verdict = {
      loudness: { status: 'above', deviationLu: 1.4 }, truePeak: { status: 'over', overDb: 0.4 }, decoded: { status: 'over', overDb: 0.6 },
      shortTerm: { status: 'over', maxLufs: -17.5, limitLufs: -18 }, samplePeakOver: true
    } as unknown as StreamVerdict
    expect(correctionReasons(verdict)).toEqual(['true-peak-over', 'sample-overs', 'loudness-off', 'short-term-over'])
    expect(correctedMessage([verdict], 'ebu-r128')).toEqual({
      key: 'corrected', params: { preset: 'ebu-r128', peakOver: 0.4, decodedOver: 0.6, dev: 1.4, shortTermOver: 0.5, overs: 1 }
    })
    const within = { loudness: { status: 'within', deviationLu: 0.1 }, truePeak: { status: 'within', overDb: null }, decoded: { status: 'within', overDb: null }, shortTerm: { status: 'not-checked', maxLufs: null, limitLufs: null }, samplePeakOver: false } as unknown as StreamVerdict
    expect(correctionReasons(within)).toEqual([])
    expect(correctedMessage([within], 'ebu-r128')).toEqual({ key: 'corrected', params: { preset: 'ebu-r128' } })
  })

  it('maps -progress blocks to progress events and fills failures without a result', () =>
  {
    const p = { outTimeSec: 4, speed: 0, totalSize: 10, end: false }
    expect(progressEvent('j', 'encode', 1, p, 8)).toEqual({ type: 'audio.progress', jobId: 'j', stage: 'encode', encodePass: 1, fraction: 0.5, outTimeSec: 4, speed: null, bytes: 10 })
    expect(progressEvent('j', 'measure', null, { ...p, outTimeSec: 9, speed: 2 }, 8)).toMatchObject({ fraction: 1, speed: 2 })
    expect(progressEvent('j', 'measure', null, p, null)).toMatchObject({ fraction: null })
    expect(progressEvent('j', 'measure', null, { ...p, outTimeSec: null }, 8)).toMatchObject({ fraction: null })
    expect(runFailure('encode', 2, ['-i', 'x'], null, 'boom')).toMatchObject({ exitCode: null, exitName: null, stderrTail: 'boom', argv: execArgv(['-i', 'x'], 'kill') })
    expect(runFailure('encode', 2, [], null).stderrTail).toBe('')
  })
})

describe('messages of a finished job', () =>
{
  it('carries only message keys the shared templates know', async () =>
  {
    const { renderMessage } = await import('../../../src/shared/audio/messages')
    const results: AudioJobResult[] = []
    results.push(await runAudioJob(job(EBU_AAC), harness(fakeExec([{ fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }])).deps, new AbortController().signal))
    results.push(await runAudioJob(surroundJob(DOWNMIX), harness(fakeExec([{ fixture: 'downmix-downmix' }, { fixture: 'downmix-measure' }, { fixture: 'downmix-encode' }, { fixture: 'downmix-verify' }])).deps, new AbortController().signal))
    results.push(await runAudioJob(surroundJob(NIGHT), harness(fakeExec([{ fixture: 'night-measure' }, { fixture: 'night-measure-dynamics' }, { fixture: 'night-encode' }, { fixture: 'night-verify' }])).deps, new AbortController().signal))
    const rendered = results.flatMap((r) => r.messages).map((m) => renderMessage(m, { minus: 'hyphen' }))
    expect(rendered.length).toBeGreaterThan(2)
    expect(rendered.every((text) => text.length > 0 && !text.includes('undefined'))).toBe(true)
  })
})
