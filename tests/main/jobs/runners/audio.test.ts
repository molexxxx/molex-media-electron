/**
 * The audio runner with a scripted fake Exec that replays the passes recorded on the pinned 9.0.2 build
 * (tests/main/fixtures/ffmpeg/job): the planned command with placeholders, stage and progress reports, aborts after
 * every await, work outputs with -f, planted outputs, the decoded-overshoot warning, refusals, and failures.
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  albumAnalysis, audioStageLabel, audioWarnings, cachedAnalysis, createBoostRunner, createNormalizeRunner, endingText, estimatedBytes,
  failureError, GAIN_PLACEHOLDER, jobError, OVERSHOOT_SHORT, planAudio, plannedStages, refusalError, refusalIssue, reportEvent,
  staticPlanChanged, THRESHOLD_PLACEHOLDER
} from '../../../../src/main/jobs/runners/audio'
import type { AudioRunnerDeps, SharedAnalyses } from '../../../../src/main/jobs/runners/audio'
import { containerFor } from '../../../../src/main/ffmpeg/audio/containers'
import { toMediaFacts } from '../../../../src/main/ffmpeg/audio/facts'
import type { ProbeJson } from '../../../../src/main/ffmpeg/audio/facts'
import { planStatic } from '../../../../src/main/ffmpeg/audio/job'
import { exitName, normalizeLines, parseProgressBlock } from '../../../../src/main/ffmpeg/exec'
import type { Exec, ExecOptions, ExecResult } from '../../../../src/main/ffmpeg/exec'
import type { AlbumHandle, JobLogger, MeasurementCache } from '../../../../src/main/jobs/deps'
import { OUTPUT_PLACEHOLDER } from '../../../../src/main/jobs/runners/convert'
import type { PlanInput, RunContext, RunnableJob, RunOutcome } from '../../../../src/main/jobs/runners/types'
import type { AudioAnalysis, AudioFailure } from '../../../../src/shared/audio/events'
import { renderMessage } from '../../../../src/shared/audio/messages'
import { applyGainPreset, applyLoudnessPreset } from '../../../../src/shared/audio/presets'
import type { BoostRecipe, MediaFacts, NormalizeRecipe } from '../../../../src/shared/audio/types'
import type { JobId } from '../../../../src/shared/jobs/ids'
import type { FrozenPolicy, JobMeasurement, JobPlan, OutputPlan, SourceRef } from '../../../../src/shared/jobs/types'

const RECORDED = path.join(__dirname, '..', '..', 'fixtures', 'ffmpeg', 'job', '9.0.2')

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

function probeJson(name: string): ProbeJson
{
  return JSON.parse(record(name).stdoutText) as ProbeJson
}

const CAPS = {
  encoders: new Set(['aac', 'ac3', 'eac3', 'flac', 'alac', 'libopus', 'libvorbis', 'libmp3lame', 'mp2', 'wmav2', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']),
  experimental: new Set<string>(),
  soxr: true
}

const EBU_AAC = applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 })
const EBU_SAME = applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' })
const NIGHT = applyLoudnessPreset('night', { kind: 'same-as-source' })

const MUSIC_PATH = 'IN/music.flac'
const MUSIC_FACTS = (): MediaFacts => toMediaFacts(probeJson('music-probe'), MUSIC_PATH)

const SOURCE: SourceRef = { path: MUSIC_PATH, name: 'music.flac', ext: 'flac', dir: 'IN', size: 537000, mtimeMs: 1000, origin: 'files', subdir: '' }

function outputPlan(container: string, muxer = containerFor(container).muxer as string): OutputPlan
{
  return {
    kind: 'file', finalPath: `OUT/music.${container}`, container, muxer, containerChanged: null, conflict: 'none', resolution: 'place',
    renamedTo: null, displaces: null
  }
}

function planInput(recipe: NormalizeRecipe | BoostRecipe, container = 'm4a', facts: MediaFacts = MUSIC_FACTS()): PlanInput<NormalizeRecipe | BoostRecipe>
{
  return { recipe, source: SOURCE, facts, caps: CAPS, output: outputPlan(container), platform: 'linux' }
}

function failure(overrides: Partial<AudioFailure> = {}): AudioFailure
{
  return {
    stage: 'encode', encodePass: 1, exitCode: -22, exitName: 'EINVAL', signal: null, argv: ['-i', 'IN/a.flac', '-f', 'ipod', 'W/1.m4a.part'],
    stderrTail: 'line one\nCould not write header (incorrect codec parameters ?): Invalid argument\n', decodeErrors: [], decodeErrorCount: 0,
    ...overrides
  }
}

describe('planAudio', () =>
{
  it('shows the gain and the output as placeholders behind exec\'s prefix, with -f and the muxer', () =>
  {
    const plan = planAudio(planInput(EBU_AAC))
    const command = plan.command
    expect(command).not.toBeNull()
    expect(command?.placeholders).toEqual([GAIN_PLACEHOLDER, OUTPUT_PLACEHOLDER])
    const argv = command?.argv ?? []
    expect(argv.slice(0, 2)).toEqual(['-hide_banner', '-nostdin'])
    expect(argv.slice(-8)).toEqual(['-f', 'ipod', OUTPUT_PLACEHOLDER, '-map', '[p0]', '-f', 'null', '-'])
    const graph = argv[argv.indexOf('-filter_complex') + 1]
    expect(graph).toContain(`volume=${GAIN_PLACEHOLDER}:precision=double`)
    expect(graph).not.toMatch(/volume=-?\d/)
    expect(command?.display.startsWith('ffmpeg -hide_banner')).toBe(true)
    expect(plan.class).toBe('audio')
    expect(plan.video).toBeNull()
    expect(plan.issues).toEqual([])
    expect(plan.audio).toHaveLength(1)
    expect(plan.audio[0].encoder).toBe('aac')
    expect(plan.streams.kept.some((k) => k.kind === 'audio')).toBe(true)
    expect(plan.estimate.outputBytes).toBeGreaterThan(0)
    expect(plan.stages.map((s) => s.id)).toEqual(['probe', 'measure', 'encode', 'verify'])
  })

  it('shows the compressor threshold as a placeholder when the recipe has dynamics', () =>
  {
    const plan = planAudio(planInput(NIGHT, 'flac'))
    expect(plan.command?.placeholders).toEqual([GAIN_PLACEHOLDER, THRESHOLD_PLACEHOLDER, OUTPUT_PLACEHOLDER])
    const graph = plan.command?.argv.find((a) => a.includes('acompressor')) ?? ''
    expect(graph).toContain(`acompressor=threshold=${THRESHOLD_PLACEHOLDER}:`)
    expect(plan.stages.map((s) => s.id)).toEqual(['probe', 'measure', 'measure-dynamics', 'encode', 'verify'])
    expect(plan.estimate.outputBytes).toBeNull()
  })

  it('has no command and blocking issues when the static plan refuses', () =>
  {
    const facts: MediaFacts = { ...MUSIC_FACTS(), audio: [] }
    const plan = planAudio(planInput(EBU_SAME, 'flac', facts))
    expect(plan.command).toBeNull()
    expect(plan.issues.length).toBeGreaterThan(0)
    expect(plan.issues[0]).toMatchObject({ code: 'no-audio-stream', severity: 'error', field: 'streams', fix: null })
    expect(plan.issues[0].message.length).toBeGreaterThan(0)
  })

  it('maps every refusal code to a plan issue', () =>
  {
    const codes = ['no-audio', 'too-many-channels', 'layout-unsupported', 'no-encoder', 'container-cannot-hold', 'invalid-recipe', 'ffmpeg-below-minimum', 'self-test-failed'] as const
    for (const code of codes)
    {
      const issue = refusalIssue({ audioIndex: null, code, message: { key: 'measured', params: {} } })
      expect(issue.severity).toBe('error')
    }
    expect(refusalIssue({ audioIndex: 0, code: 'no-encoder', message: { key: 'measured', params: {} } }).code).toBe('encoder-missing')
  })

  it('plans the album stage for a group member', () =>
  {
    expect(plannedStages(NIGHT, true).map((s) => s.id)).toEqual(['probe', 'measure-album', 'encode', 'verify'])
    expect(plannedStages(EBU_SAME, false).find((s) => s.id === 'encode')?.passes).toBe(2)
  })

  it('estimates no size for an unknown duration or a stream without a bitrate', () =>
  {
    const facts = MUSIC_FACTS()
    const staticPlan = planStatic(facts, EBU_AAC, CAPS, { container: 'm4a', muxer: 'ipod' })
    expect(estimatedBytes({ ...facts, durationSec: Number.NaN }, staticPlan)).toBeNull()
    expect(estimatedBytes(facts, { ...staticPlan, streams: [] })).toBeNull()
    expect(estimatedBytes(facts, staticPlan)).toBe(Math.round(staticPlan.streams[0].bitrateKbps as number * 125 * facts.durationSec))
  })
})

describe('errors', () =>
{
  const job = { attempt: 2 }

  it('names a stage with the audio labels', () =>
  {
    expect(audioStageLabel('encode', 1)).toBe('Encode')
    expect(audioStageLabel('encode', 2)).toBe('Re-encode (correction)')
    expect(audioStageLabel('verify', 2)).toBe('Verify (correction)')
    expect(audioStageLabel('measure-dynamics', null)).toBe('Measure after dynamics')
  })

  it('carries the signed exit code, its name, the command, and the stderr tail', () =>
  {
    const e = failureError(job, 'linux', 50, failure())
    expect(e).toMatchObject({ code: 'ffmpeg-failed', short: 'Encode failed', stage: 'encode', attempt: 2, encodePass: 1, exitCode: -22, exitName: 'EINVAL', signal: null, at: 50 })
    expect(e.message).toBe('The encode ended with exit code -22 (EINVAL). Could not write header (incorrect codec parameters ?): Invalid argument')
    expect(e.command?.argv).toEqual(failure().argv)
    expect(e.command?.display).toBe('ffmpeg -i IN/a.flac -f ipod W/1.m4a.part')
    expect(e.stderrTail).toContain('Could not write header')
    expect(e.cause).toBe('muxer')
  })

  it('maps measure, verify, probe, decode, signal, spawn, and refused-output failures', () =>
  {
    expect(failureError(job, 'linux', 1, failure({ stage: 'measure', encodePass: null })).code).toBe('measure-failed')
    expect(failureError(job, 'linux', 1, failure({ stage: 'measure-dynamics', encodePass: null })).short).toBe('Measure failed')
    const verify = failureError(job, 'linux', 1, failure({ stage: 'verify', encodePass: 2, exitCode: 1, exitName: null, stderrTail: '' }))
    expect(verify).toMatchObject({ code: 'ffmpeg-failed', short: 'Verify failed', encodePass: 2 })
    expect(verify.message).toBe('The verify pass (correction) ended with exit code 1.')
    expect(failureError(job, 'linux', 1, failure({ stage: 'probe', exitCode: 1 })).code).toBe('probe-failed')
    const decode = failureError(job, 'linux', 1, failure({ stage: 'verify', exitCode: 0, exitName: null, decodeErrors: ['Invalid data found'], decodeErrorCount: 3 }))
    expect(decode).toMatchObject({ code: 'decode-errors', cause: 'decode' })
    expect(decode.message).toBe('The output does not decode cleanly (3 decode errors): Invalid data found')
    expect(failureError(job, 'linux', 1, failure({ stage: 'verify', exitCode: 0, decodeErrors: [], decodeErrorCount: 1, stderrTail: '' })).message)
      .toBe('The output does not decode cleanly (1 decode error): decode errors')
    const killed = failureError(job, 'linux', 1, failure({ exitCode: null, exitName: null, signal: 'SIGKILL' }))
    expect(killed.message).toContain('ended with signal SIGKILL.')
    expect(killed.signal).toBe('SIGKILL')
    const spawn = failureError(job, 'linux', 1, failure({ exitCode: null, exitName: null, signal: null, argv: [], stderrTail: 'spawn ENOENT' }))
    expect(spawn).toMatchObject({ code: 'ffmpeg-unavailable', message: 'FFmpeg could not be started: spawn ENOENT', command: null })
    const probe = failureError(job, 'linux', 1, failure({ stage: 'probe', exitCode: null, exitName: null, argv: [], stderrTail: '' }))
    expect(probe).toMatchObject({ code: 'probe-failed', message: 'The source could not be read: it did not start' })
    const exists = failureError(job, 'linux', 1, failure({ exitCode: 0, exitName: 'EEXIST' }))
    expect(exists).toMatchObject({ code: 'internal', short: 'Work file exists' })
    expect(exists.message).toContain('W/1.m4a.part')
    expect(failureError(job, 'linux', 1, failure({ exitCode: 0, exitName: 'EEXIST', argv: [] })).message).toContain('the work file')
  })

  it('names how a process ended', () =>
  {
    expect(endingText({ exitCode: -2, exitName: 'ENOENT', signal: null })).toBe('exit code -2 (ENOENT)')
    expect(endingText({ exitCode: null, exitName: null, signal: null })).toBe('no exit code')
  })

  it('fills a refusal with its sentences and a plain error without a command', () =>
  {
    const refused = refusalError(job, 'linux', 9, [{ audioIndex: null, code: 'no-audio', message: { key: 'measured', params: {} } }])
    expect(refused).toMatchObject({ code: 'plan-refused', short: 'Output refused', stage: 'probe', at: 9 })
    expect(refused.message.length).toBeGreaterThan(0)
    expect(refusalError(job, 'linux', 9, []).message).toBe('The job cannot run with these settings.')
    expect(jobError(job, 'win32', 3, { code: 'internal', short: 'x', message: 'y', stage: 'encode' }).command).toBeNull()
  })
})

type Step =
  | { fixture?: string; stderr?: string; code?: number | null; outputRefused?: boolean; abort?: AbortController }
  | { throws: Error }

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
        code, exitName: exitName(code), signal: null, aborted: false, stopped: 'none', outputRefused: step.outputRefused ?? false,
        stderrTail: normalizeLines(stderr).slice(-2048), ms: 1
      }
    }
  }
}

const MUSIC = (): Step[] => [
  { fixture: 'music-measure' }, { fixture: 'music-encode' }, { fixture: 'music-verify' }, { fixture: 'music-encode-2' }, { fixture: 'music-verify-2' }
]

const POLICY: FrozenPolicy = {
  rev: 1, destination: { mode: 'next-to-source' }, template: '{name}-{op}', conflict: 'rename', displaced: 'trash', gpu: 'off', frozenAt: 0, date: '2026-10-19'
}

function runnable(recipe: NormalizeRecipe | BoostRecipe, container = 'm4a', plan: Partial<JobPlan> = {}): RunnableJob<NormalizeRecipe>
{
  const rp = planAudio(planInput(recipe, container))
  return {
    id: 'MM0001' as JobId,
    recipe: recipe as NormalizeRecipe,
    plan: {
      basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 }, fingerprint: 'f', source: { path: SOURCE.path, size: SOURCE.size, mtimeMs: SOURCE.mtimeMs },
      output: outputPlan(container), streams: rp.streams, video: null, audio: rp.audio, class: 'audio', stages: rp.stages,
      estimate: { ...rp.estimate, reserveBytes: 0 }, album: null, command: rp.command, ...plan
    },
    policy: POLICY,
    source: SOURCE,
    attempt: 1
  }
}

interface Options
{
  controller?: AbortController
  album?: AlbumHandle | null
  probe?: (file: string) => Promise<MediaFacts>
  present?: (file: string) => Promise<boolean>
  size?: (file: string, call: number) => Promise<number>
  analyses?: SharedAnalyses | null
  cache?: Map<string, JobMeasurement>
}

interface Harness
{
  ctx: RunContext
  deps: AudioRunnerDeps
  stages: Array<{ id: string; pass: number; passes: number; label: string }>
  progress: Array<{ outTimeSec: number | null; durationSec: number | null }>
  measured: JobMeasurement[]
  logs: string[]
  ffmpeg: string[]
  outputs: string[]
  checked: string[]
  removed: string[]
  cache: Map<string, JobMeasurement>
}

function harness(exec: Exec, o: Options = {}): Harness
{
  const controller = o.controller ?? new AbortController()
  const cache = o.cache ?? new Map<string, JobMeasurement>()
  const h: Harness = {
    ctx: null as unknown as RunContext, deps: null as unknown as AudioRunnerDeps, stages: [], progress: [], measured: [], logs: [], ffmpeg: [],
    outputs: [], checked: [], removed: [], cache
  }
  const log: JobLogger = {
    debug: (m) => h.logs.push(`debug ${m}`),
    info: (m) => h.logs.push(`info ${m}`),
    warn: (m) => h.logs.push(`warn ${m}`),
    error: (m) => h.logs.push(`error ${m}`),
    ffmpeg: (line) => h.ffmpeg.push(line),
    child: () => log
  }
  const measurementCache: MeasurementCache = { get: (key) => cache.get(key) ?? null, set: (key, m) => { cache.set(key, m) } }
  h.ctx = {
    signal: controller.signal,
    exec,
    workDir: 'W',
    execution: 1,
    caps: CAPS,
    gpu: null,
    album: o.album ?? null,
    cache: measurementCache,
    probe: o.probe ?? (async () => MUSIC_FACTS()),
    output: (ext, pass) =>
    {
      const file = `W/out-${pass}.${ext}.part`
      h.outputs.push(file)
      return file
    },
    outputFolder: (name) => `W/${name}`,
    stage: (s) => h.stages.push(s),
    progress: (p) => h.progress.push(p),
    measured: (m) => h.measured.push(m),
    log,
    now: () => 4000
  }
  let sizeCalls = 0
  h.deps = {
    platform: 'linux',
    buildId: () => 'n9.0.2',
    exists: async (file) =>
    {
      h.checked.push(file)
      return o.present === undefined ? false : o.present(file)
    },
    remove: async (file) =>
    {
      h.removed.push(file)
    },
    size: async (file) => (o.size === undefined ? 131032 : o.size(file, ++sizeCalls)),
    analyses: o.analyses ?? null
  }
  return h
}

/** Runs the Normalize runner of a harness. */
function runAudio(h: Harness, job: RunnableJob<NormalizeRecipe>): Promise<RunOutcome>
{
  return createNormalizeRunner(h.deps).run(job, h.ctx)
}

const stageNames = (h: Harness): string[] => h.stages.map((s) => `${s.id}:${s.pass}/${s.passes}`)

function expectOutput(outcome: RunOutcome): Extract<RunOutcome, { kind: 'output' }>
{
  if (outcome.kind !== 'output')
  {
    throw new Error(`Expected an output, got ${JSON.stringify(outcome)}`)
  }
  return outcome
}

function expectFailed(outcome: RunOutcome): Extract<RunOutcome, { kind: 'failed' }>
{
  if (outcome.kind !== 'failed')
  {
    throw new Error(`Expected a failure, got ${JSON.stringify(outcome)}`)
  }
  return outcome
}

describe('run on the recorded music job', () =>
{
  it('reports stages, progress, and measurements, and leaves a verified work output for the engine', async () =>
  {
    const h = harness(fakeExec(MUSIC()))
    const outcome = expectOutput(await runAudio(h, runnable(EBU_AAC)))
    expect(stageNames(h)).toEqual(['probe:1/1', 'measure:1/1', 'encode:1/2', 'verify:1/2', 'encode:2/2', 'verify:2/2'])
    expect(h.stages.map((s) => s.label)).toEqual(['Probe', 'Measure', 'Encode', 'Verify', 'Re-encode (correction)', 'Verify (correction)'])
    expect(h.progress.length).toBeGreaterThan(0)
    expect(h.progress.every((p) => p.durationSec === MUSIC_FACTS().durationSec)).toBe(true)
    expect(h.measured[0]).toMatchObject({ pass: 'source', album: null })
    expect(h.measured[0].streams[0].plan).toBeNull()
    expect(h.measured[1].streams[0].plan).not.toBeNull()
    expect(outcome.artifact).toEqual({
      kind: 'file', path: 'W/out-2.m4a.part', container: 'm4a', bytes: 131032, durationSec: MUSIC_FACTS().durationSec, encoder: { video: null, audio: ['aac'] }
    })
    expect(outcome.verification).toMatchObject({ verdict: 'verified', encodePasses: 2, media: null })
    expect(outcome.verification.audio?.[0].verdict.encodePasses).toBe(2)
    expect(outcome.verification.messages.map((m) => m.key)).toContain('corrected')
    expect(outcome.measurement?.streams[0].measurement.stats.integratedLufs).toBe(-25.2)
    expect(outcome.notes).toEqual([])
    expect(h.cache.size).toBe(1)
    expect(h.logs.some((l) => l.startsWith('info > ffmpeg -hide_banner -nostdin'))).toBe(true)
    expect(h.logs.some((l) => l.startsWith('info Correcting: loudness-off'))).toBe(true)
    expect(h.ffmpeg.length).toBeGreaterThan(0)
  })

  it('writes only to work paths from ctx.output, with -f and the muxer, each checked to be absent right before its spawn', async () =>
  {
    const exec = fakeExec(MUSIC())
    const h = harness(exec)
    await runAudio(h, runnable(EBU_AAC))
    const writes = (args: string[]): number => args.findIndex((arg, i) => arg === '-f' && h.outputs.includes(args[i + 2])) + 2
    const encodes = exec.calls.filter((args) => writes(args) >= 2)
    expect(encodes).toHaveLength(2)
    for (const args of encodes)
    {
      const at = writes(args)
      expect(args.slice(at - 2, at)).toEqual(['-f', 'ipod'])
      expect(args[at].startsWith('W/')).toBe(true)
      expect(args.slice(at + 1)).toEqual(['-map', '[p0]', '-f', 'null', '-'])
    }
    expect(h.outputs).toEqual(['W/out-1.m4a.part', 'W/out-2.m4a.part'])
    expect(h.checked).toEqual(h.outputs)
    expect(h.removed).toEqual(['W/out-1.m4a.part'])
  })

  it('runs Gain through the same pieces', async () =>
  {
    const recipe = applyGainPreset('gentle-lift', { kind: 'codec', codec: 'aac', kbpsPerPair: 128 })
    const h = harness(fakeExec(MUSIC()))
    const runner = createBoostRunner(h.deps)
    expect(runner.kind).toBe('boost')
    expect(runner.plan({ ...planInput(recipe), recipe }).command?.placeholders).toContain(GAIN_PLACEHOLDER)
    const job = { ...runnable(recipe), recipe }
    expect((await runner.run(job, h.ctx)).kind).toBe('output')
  })

  it('logs a static plan that differs from the preflight and runs the current one', async () =>
  {
    const h = harness(fakeExec(MUSIC()))
    expect((await runAudio(h, runnable(EBU_AAC, 'm4a', { audio: [] }))).kind).toBe('output')
    expect(h.logs).toContain('warn The audio output differs from the preflight; the run follows the current source')
    expect(staticPlanChanged(runnable(EBU_AAC).plan.audio, runnable(EBU_AAC).plan.audio)).toBe(false)
  })
})

describe('aborts', () =>
{
  const aborted = { kind: 'aborted' }

  it('returns aborted before anything runs and after the probe resolves or rejects', async () =>
  {
    const before = new AbortController()
    before.abort()
    const idle = harness(fakeExec([]), { controller: before })
    expect(await runAudio(idle, runnable(EBU_AAC))).toEqual(aborted)
    expect(idle.stages).toEqual([])
    for (const reject of [false, true])
    {
      const controller = new AbortController()
      const h = harness(fakeExec([]), {
        controller,
        probe: async () =>
        {
          controller.abort()
          if (reject)
          {
            throw new Error('ffprobe killed')
          }
          return MUSIC_FACTS()
        }
      })
      expect(await runAudio(h, runnable(EBU_AAC))).toEqual(aborted)
    }
  })

  it('returns aborted from every pass: measure, encode, verify, and the correction', async () =>
  {
    for (const abortAt of [0, 1, 2, 3, 4])
    {
      const controller = new AbortController()
      const steps = MUSIC()
      steps[abortAt] = { ...steps[abortAt], abort: controller }
      const h = harness(fakeExec(steps), { controller })
      expect(await runAudio(h, runnable(EBU_AAC))).toEqual(aborted)
    }
  })

  it('returns aborted when the abort lands during the work-file check or the final size read', async () =>
  {
    const checking = new AbortController()
    const exec = fakeExec(MUSIC())
    const h = harness(exec, { controller: checking, present: async () => { checking.abort(); return false } })
    expect(await runAudio(h, runnable(EBU_AAC))).toEqual(aborted)
    expect(exec.calls).toHaveLength(1)
    for (const reject of [false, true])
    {
      const sizing = new AbortController()
      const s = harness(fakeExec(MUSIC()), {
        controller: sizing,
        size: async (_file, call) =>
        {
          if (call === 3)
          {
            sizing.abort()
            if (reject)
            {
              throw new Error('EBUSY')
            }
          }
          return 131032
        }
      })
      expect(await runAudio(s, runnable(EBU_AAC))).toEqual(aborted)
    }
  })

  it('returns aborted while waiting for the album or a shared analysis', async () =>
  {
    const albumAbort = new AbortController()
    const album: AlbumHandle = { groupId: 'g1', members: 2, measurement: async () => { albumAbort.abort(); return null } }
    expect(await runAudio(harness(fakeExec([]), { controller: albumAbort, album }), runnable(EBU_AAC))).toEqual(aborted)
    const sharedAbort = new AbortController()
    const analyses: SharedAnalyses = { forJob: async () => { sharedAbort.abort(); return null }, store: () => undefined }
    expect(await runAudio(harness(fakeExec([]), { controller: sharedAbort, analyses }), runnable(EBU_AAC))).toEqual(aborted)
    const memberAbort = new AbortController()
    const measurement = await plannedMeasurement()
    const member: AlbumHandle = { groupId: 'g1', members: 2, measurement: async () => measurement }
    const memberShared: SharedAnalyses = { forJob: async () => { memberAbort.abort(); return null }, store: () => undefined }
    expect(await runAudio(harness(fakeExec([]), { controller: memberAbort, album: member, analyses: memberShared }), runnable(EBU_AAC))).toEqual(aborted)
  })
})

/** The planned measurement and the analysis of one recorded music run. */
async function measuredRun(): Promise<{ measurement: JobMeasurement; analysis: AudioAnalysis; cache: Map<string, JobMeasurement> }>
{
  const stored: AudioAnalysis[] = []
  const h = harness(fakeExec(MUSIC()), { analyses: { forJob: async () => null, store: (a) => stored.push(a) } })
  await runAudio(h, runnable(EBU_AAC))
  return { measurement: h.measured[1], analysis: stored[0], cache: h.cache }
}

async function plannedMeasurement(): Promise<JobMeasurement>
{
  return (await measuredRun()).measurement
}

const ENCODE_ONLY = (): Step[] => MUSIC().slice(1)

describe('work files', () =>
{
  it('catches an output planted before the spawn, spawns nothing over it, and never removes it', async () =>
  {
    const exec = fakeExec(MUSIC())
    const h = harness(exec, { present: async (file) => file === 'W/out-1.m4a.part' })
    const { error } = expectFailed(await runAudio(h, runnable(EBU_AAC)))
    expect(error).toMatchObject({ code: 'internal', short: 'Work file exists', stage: 'encode', encodePass: 1 })
    expect(error.message).toBe('The work file W/out-1.m4a.part already exists, so nothing was written over it.')
    expect(exec.calls).toHaveLength(1)
    expect(h.removed).not.toContain('W/out-1.m4a.part')
  })

  it('fails without a spawn when the work file cannot be checked', async () =>
  {
    const exec = fakeExec(MUSIC())
    const h = harness(exec, { present: async () => { throw new Error('EACCES') } })
    const { error } = expectFailed(await runAudio(h, runnable(EBU_AAC)))
    expect(error).toMatchObject({ code: 'internal', short: 'Work file unchecked' })
    expect(error.message).toBe('The work file W/out-1.m4a.part could not be checked before the encode: EACCES')
    expect(exec.calls).toHaveLength(1)
  })

  it('never reads an exit 0 from -n as a fresh write', async () =>
  {
    const steps = MUSIC()
    steps[1] = { fixture: 'music-encode', code: 0, outputRefused: true }
    const { error } = expectFailed(await runAudio(harness(fakeExec(steps)), runnable(EBU_AAC)))
    expect(error).toMatchObject({ code: 'internal', short: 'Work file exists', exitCode: 0, exitName: 'EEXIST' })
    expect(error.message).toBe('FFmpeg found the work file W/out-1.m4a.part already there and wrote nothing.')
  })

  it('fails an output that cannot be read after verification', async () =>
  {
    const h = harness(fakeExec(MUSIC()), { size: async (_file, call) => { if (call === 3) throw new Error('ENOENT'); return 131032 } })
    const { error } = expectFailed(await runAudio(h, runnable(EBU_AAC)))
    expect(error).toMatchObject({ code: 'output-unreadable', short: 'Output unreadable', message: 'The verified output could not be read: ENOENT' })
  })
})

describe('verdicts and failures', () =>
{
  it('turns a decoded-overshoot verdict into the warning with its sentence', async () =>
  {
    const steps = MUSIC()
    const hot = record('music-verify-2').stderrText.replace(/(\[astats@t0 [^\n]*Peak level dB: )-12\.078144/, '$1-0.400000')
    expect(hot).not.toBe(record('music-verify-2').stderrText)
    steps[4] = { fixture: 'music-verify-2', stderr: hot }
    const outcome = expectOutput(await runAudio(harness(fakeExec(steps)), runnable(EBU_AAC)))
    const ref = outcome.verification.messages.find((m) => m.key === 'decoded-overshoot')
    expect(ref?.params).toMatchObject({ codec: 'aac', preset: 'ebu-r128', lim: -1 })
    expect(outcome.verification.audio?.[0].verdict.warnings).toEqual(['decoded-overshoot'])
    const sentence = renderMessage(ref ?? { key: 'measured', params: {} }, { minus: 'hyphen' })
    expect(sentence).toContain('even after one corrective encode')
    expect(outcome.notes).toEqual([sentence])
    expect(audioWarnings(outcome.verification)).toEqual([{ code: 'decoded-overshoot', short: OVERSHOOT_SHORT, message: sentence }])
  })

  it('fails a refused job with its refusal sentences and spawns nothing', async () =>
  {
    const exec = fakeExec([])
    const h = harness(exec, { probe: async () => ({ ...MUSIC_FACTS(), audio: [] }) })
    const { error } = expectFailed(await runAudio(h, runnable(EBU_SAME, 'flac')))
    const refusals = planStatic({ ...MUSIC_FACTS(), audio: [] }, EBU_SAME, CAPS, { container: 'flac', muxer: 'flac' }).refusals
    expect(error).toMatchObject({ code: 'plan-refused', short: 'Output refused', stage: 'probe', command: null })
    expect(error.message).toBe(refusals.map((r) => renderMessage(r.message, { minus: 'hyphen' })).join(' '))
    expect(exec.calls).toEqual([])
    expect(stageNames(h)).toEqual(['probe:1/1'])
  })

  it('fails a recipe the analysis refuses before anything spawns', async () =>
  {
    const invalid: NormalizeRecipe = { ...EBU_AAC, target: { ...EBU_AAC.target, integratedLufs: 40 } }
    const exec = fakeExec([])
    const { error } = expectFailed(await runAudio(harness(exec), runnable(invalid)))
    expect(error.code).toBe('plan-refused')
    expect(error.message.length).toBeGreaterThan(0)
    expect(exec.calls).toEqual([])
  })

  it('carries a signed exit code and its name into the JobError', async () =>
  {
    const steps = MUSIC()
    steps[1] = { fixture: 'music-encode', code: 4294967274 }
    const exec = fakeExec(steps)
    const { error } = expectFailed(await runAudio(harness(exec), runnable(EBU_AAC)))
    expect(error).toMatchObject({ code: 'ffmpeg-failed', short: 'Encode failed', stage: 'encode', encodePass: 1, exitCode: -22, exitName: 'EINVAL', attempt: 1, at: 4000 })
    expect(error.message).toContain('ended with exit code -22 (EINVAL).')
    expect(error.command?.argv.slice(-8)).toEqual(['-f', 'ipod', 'W/out-1.m4a.part', '-map', '[p0]', '-f', 'null', '-'])
    expect(error.command?.argv.slice(0, 2)).toEqual(['-hide_banner', '-nostdin'])
    expect(error.stderrTail).toContain('Output #0, ipod')
  })

  it('fails a probe, a spawn, and a measure with their own codes', async () =>
  {
    const probe = expectFailed(await runAudio(harness(fakeExec([]), { probe: async () => { throw new Error('not media') } }), runnable(EBU_AAC)))
    expect(probe.error).toMatchObject({ code: 'probe-failed', message: 'The source could not be read: not media' })
    const spawn = expectFailed(await runAudio(harness(fakeExec([{ throws: new Error('spawn ENOENT') }])), runnable(EBU_AAC)))
    expect(spawn.error).toMatchObject({ code: 'ffmpeg-unavailable', stage: 'measure', message: 'FFmpeg could not be started: spawn ENOENT' })
    const measure = expectFailed(await runAudio(harness(fakeExec([{ fixture: 'music-measure', code: 1 }])), runnable(EBU_AAC)))
    expect(measure.error).toMatchObject({ code: 'measure-failed', stage: 'measure', exitCode: 1 })
  })
})

describe('measurements from elsewhere', () =>
{
  it('runs an album member on the album plan without a measure pass and names the album', async () =>
  {
    const measurement = await plannedMeasurement()
    const summary = { groupId: 'g1', members: 2, anchorJobId: 'MM0002' as JobId, anchorLufs: -20, gainDb: measurement.streams[0].plan?.gainDb ?? 0, reason: 'fits' as const }
    const album: AlbumHandle = { groupId: 'g1', members: 2, measurement: async () => ({ ...measurement, album: summary }) }
    const exec = fakeExec(ENCODE_ONLY())
    const h = harness(exec, { album })
    const outcome = expectOutput(await runAudio(h, runnable(EBU_AAC)))
    expect(exec.calls.every((args) => !args.join(' ').includes('ebur128@m'))).toBe(true)
    expect(stageNames(h).slice(0, 3)).toEqual(['probe:1/1', 'measure:1/1', 'encode:1/2'])
    expect(outcome.measurement?.album).toEqual(summary)
    expect(h.measured[0].album).toEqual(summary)
  })

  it('fails an album member when the album has no measurement or no gain for a stream', async () =>
  {
    const none: AlbumHandle = { groupId: 'g1', members: 2, measurement: async () => null }
    const empty = expectFailed(await runAudio(harness(fakeExec([]), { album: none }), runnable(EBU_AAC)))
    expect(empty.error).toMatchObject({ code: 'album-measure-failed', short: 'Album measure failed', stage: 'measure' })
    const measurement = await plannedMeasurement()
    const planless: AlbumHandle = {
      groupId: 'g1', members: 2, measurement: async () => ({ ...measurement, streams: measurement.streams.map((s) => ({ ...s, plan: null })) })
    }
    const missing = expectFailed(await runAudio(harness(fakeExec([]), { album: planless }), runnable(EBU_AAC)))
    expect(missing.error.message).toBe('The album measurement has no gain for audio stream 0.')
  })

  it('reuses a shared analysis for an album member and for a job whose task measured it', async () =>
  {
    const { measurement, analysis } = await measuredRun()
    const forJob: string[] = []
    const analyses: SharedAnalyses = { forJob: async (_id, key) => { forJob.push(key); return analysis }, store: () => undefined }
    const album: AlbumHandle = { groupId: 'g1', members: 2, measurement: async () => measurement }
    const member = harness(fakeExec(ENCODE_ONLY()), { album, analyses })
    expect((await runAudio(member, runnable(EBU_AAC))).kind).toBe('output')
    const solo = harness(fakeExec(ENCODE_ONLY()), { analyses })
    expect((await runAudio(solo, runnable(EBU_AAC))).kind).toBe('output')
    expect(stageNames(solo).slice(0, 2)).toEqual(['probe:1/1', 'measure:1/1'])
    expect(forJob).toEqual([analysis.cacheKey, analysis.cacheKey])
  })

  it('reuses a cached measurement without dynamics and misses everything else', async () =>
  {
    const { cache, analysis } = await measuredRun()
    const exec = fakeExec(ENCODE_ONLY())
    expect((await runAudio(harness(exec, { cache }), runnable(EBU_AAC))).kind).toBe('output')
    expect(exec.calls).toHaveLength(4)
    const facts = MUSIC_FACTS()
    const staticPlan = planStatic(facts, EBU_AAC, CAPS, { container: 'm4a', muxer: 'ipod' })
    const store: MeasurementCache = { get: (key) => cache.get(key) ?? null, set: () => undefined }
    const key = analysis.cacheKey
    expect(cachedAnalysis(store, key, facts, staticPlan, EBU_AAC)?.source).toEqual(analysis.source)
    expect(cachedAnalysis(store, key, facts, staticPlan, NIGHT)).toBeNull()
    expect(cachedAnalysis(store, 'other', facts, staticPlan, EBU_AAC)).toBeNull()
    const after: MeasurementCache = { get: () => ({ ...(cache.get(key) as JobMeasurement), pass: 'after-dynamics' }), set: () => undefined }
    expect(cachedAnalysis(after, key, facts, staticPlan, EBU_AAC)).toBeNull()
    const streamless: MeasurementCache = { get: () => ({ ...(cache.get(key) as JobMeasurement), streams: [] }), set: () => undefined }
    expect(cachedAnalysis(streamless, key, facts, staticPlan, EBU_AAC)).toBeNull()
  })

  it('rebuilds an album analysis after dynamics, and reports a plan only once an analysis exists', async () =>
  {
    const measurement = await plannedMeasurement()
    const rebuilt = albumAnalysis({ ...measurement, pass: 'after-dynamics' }, 'k', MUSIC_FACTS())
    expect(rebuilt.afterDynamics).toEqual(rebuilt.source)
    expect(albumAnalysis(measurement, 'k', MUSIC_FACTS()).afterDynamics).toBeNull()
    const h = harness(fakeExec([]))
    const state = { analysis: null, album: null, notes: [], durationSec: null }
    reportEvent({ type: 'audio.planned', jobId: 'j', plans: [], notes: [{ audioIndex: 0, message: { key: 'measured', params: {} } }] }, h.ctx, state)
    reportEvent({ type: 'audio.static-plan', jobId: 'j', streams: [], refusals: [], container: 'm4a', containerChanged: false, dropped: [] }, h.ctx, state)
    expect(h.measured).toEqual([])
    expect(state.notes).toHaveLength(1)
  })
})
