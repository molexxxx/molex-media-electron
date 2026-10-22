/**
 * The Normalize and Gain runner. It wraps the audio job pieces: the static plan, the analysis (a cached or shared one
 * when the engine has it, the album's for a group member), the gain plans, and the encode with verification. Audio
 * events become stage, progress, and measurement reports; an audio failure becomes a JobError; every output is a
 * work path from ctx.output that is checked to be absent right before each spawn.
 */
import type { AudioAnalysis, AudioEvent, AudioFailure, AudioJobResult, AudioStage, StaticJobPlan, StaticStreamPlan, StreamMeasurement } from '../../../shared/audio/events'
import { MAX_ENCODE_PASSES, stageLabel } from '../../../shared/audio/events'
import { renderMessage } from '../../../shared/audio/messages'
import type { MessageRef } from '../../../shared/audio/messages'
import type { AudioJobInput, BoostRecipe, GainPlan, MediaFacts, NormalizeRecipe, Refusal, RefusalCode } from '../../../shared/audio/types'
import type { JobId } from '../../../shared/jobs/ids'
import type {
  AlbumSummary, JobError, JobErrorCode, JobMeasurement, JobPlan, JobWarning, PlanIssue, PlanIssueCode, StageId, Verification
} from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import { formatDb } from '../../ffmpeg/audio/chains'
import { codecOfEncoder } from '../../ffmpeg/audio/containers'
import { compressorStage } from '../../ffmpeg/audio/dynamics'
import type { BuildCapabilities } from '../../ffmpeg/audio/encoders'
import {
  analysisKey, analyzeAudioJob, buildEncodeArgs, encodeAudioJob, encoderChoices, measureSpecFor, planAudioJob, planStatic
} from '../../ffmpeg/audio/job'
import type { AudioJobDeps } from '../../ffmpeg/audio/job'
import { execArgv } from '../../ffmpeg/exec'
import type { Exec } from '../../ffmpeg/exec'
import type { MeasurementCache } from '../deps'
import { COMMAND_PREFIX, ERROR_TAIL_BYTES, quoteForDisplay, tailAtLineBoundary } from '../log'
import { ffmpegCause, OUTPUT_PLACEHOLDER } from './convert'
import type { JobRunner, PlanInput, RunContext, RunnableJob, RunnerPlan, RunOutcome } from './types'

type AudioRecipe = NormalizeRecipe | BoostRecipe

/** The planned command's gain, set by the measurement. */
export const GAIN_PLACEHOLDER = '{gain}'

/** The planned command's compressor threshold, anchored to the measured loudness. */
export const THRESHOLD_PLACEHOLDER = '{threshold}'

/** The loudness the placeholder chain is built with; the value never reaches the displayed command. */
const SENTINEL_LUFS = -23

/** The engine's analysis tasks as a run sees them: a cached or running analysis of the job, and a store for its own. */
export interface SharedAnalyses
{
  /** The cached analysis under the key, or the result of the job's running task; null when the job measures itself. */
  forJob(jobId: JobId, key: string, signal: AbortSignal): Promise<AudioAnalysis | null>
  store(analysis: AudioAnalysis): void
}

/** What the audio runner needs beyond its context; every path it touches is a work path from ctx.output. */
export interface AudioRunnerDeps
{
  platform: Platform
  /** The FFmpeg build id; part of the measurement cache key. */
  buildId(): string
  exists(file: string): Promise<boolean>
  remove(file: string): Promise<void>
  size(file: string): Promise<number>
  analyses?: SharedAnalyses | null
}

/** The fields of a JobError a runner decides; the rest come from the job and the clock. */
export interface ErrorFields
{
  code: JobErrorCode
  short: string
  message: string
  stage: StageId
  cause?: JobError['cause']
  encodePass?: number | null
  exitCode?: number | null
  exitName?: string | null
  signal?: string | null
  stderrTail?: string
  argv?: readonly string[] | null
}

/** A stage's label as the row shows it: 'Encode', 'Re-encode (correction)', ... */
export function audioStageLabel(stage: AudioStage, encodePass: 1 | 2 | null): string
{
  return renderMessage(stageLabel(stage, encodePass), { minus: 'hyphen' })
}

/** Renders message refs for a log line or an error message, joined by spaces. */
export function renderMessages(refs: readonly MessageRef[]): string
{
  return refs.map((ref) => renderMessage(ref, { minus: 'hyphen' })).join(' ')
}

/** A JobError of this job's attempt at the given time. */
export function jobError(job: Pick<RunnableJob, 'attempt'>, platform: Platform, at: number, e: ErrorFields): JobError
{
  const argv = e.argv ?? null
  return {
    code: e.code,
    short: e.short,
    cause: e.cause ?? null,
    message: e.message,
    stage: e.stage,
    attempt: job.attempt,
    encodePass: e.encodePass ?? null,
    exitCode: e.exitCode ?? null,
    exitName: e.exitName ?? null,
    signal: e.signal ?? null,
    stderrTail: tailAtLineBoundary(e.stderrTail ?? '', ERROR_TAIL_BYTES),
    command: argv === null ? null : { argv: [...argv], display: quoteForDisplay(['ffmpeg', ...argv], platform) },
    fsError: null,
    hint: null,
    at
  }
}

/** A refused job: nothing ran after the probe, and the message is the refusals' own sentences. */
export function refusalError(job: Pick<RunnableJob, 'attempt'>, platform: Platform, at: number, refusals: readonly Refusal[]): JobError
{
  const message = refusals.length > 0 ? renderMessages(refusals.map((r) => r.message)) : 'The job cannot run with these settings.'
  return jobError(job, platform, at, { code: 'plan-refused', short: 'Output refused', message, stage: 'probe' })
}

function lastLine(text: string): string | null
{
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return lines.length > 0 ? lines[lines.length - 1] : null
}

/** How a process ended, for a message: the signed exit code and its name, or the signal. */
export function endingText(f: Pick<AudioFailure, 'exitCode' | 'exitName' | 'signal'>): string
{
  if (f.exitCode !== null)
  {
    return f.exitName === null ? `exit code ${f.exitCode}` : `exit code ${f.exitCode} (${f.exitName})`
  }
  return f.signal === null ? 'no exit code' : `signal ${f.signal}`
}

const STAGE_TEXT: Readonly<Record<AudioStage, string>> = {
  'probe': 'The probe',
  'measure': 'The measure pass',
  'measure-dynamics': 'The measure pass after dynamics',
  'encode': 'The encode',
  'verify': 'The verify pass'
}

/**
 * The JobError of an audio failure: the stage, pass, signed exit code and name, signal, full command, stderr tail,
 * and decode errors. A spawn failure has neither a code nor a signal; an EEXIST at code 0 is -n refusing a work file.
 */
export function failureError(job: Pick<RunnableJob, 'attempt'>, platform: Platform, at: number, f: AudioFailure): JobError
{
  const base = {
    stage: f.stage as StageId,
    encodePass: f.encodePass,
    exitCode: f.exitCode,
    exitName: f.exitName,
    signal: f.signal,
    stderrTail: f.stderrTail,
    argv: f.argv.length > 0 ? f.argv : null
  }
  const pass = f.encodePass === 2 ? ' (correction)' : ''
  if (f.exitCode === null && f.signal === null)
  {
    const reason = lastLine(f.stderrTail) ?? 'it did not start'
    return f.stage === 'probe'
      ? jobError(job, platform, at, { ...base, code: 'probe-failed', short: 'Probe failed', message: `The source could not be read: ${reason}` })
      : jobError(job, platform, at, { ...base, code: 'ffmpeg-unavailable', short: 'FFmpeg unavailable', message: `FFmpeg could not be started: ${reason}` })
  }
  if (f.exitCode === 0 && f.exitName === 'EEXIST')
  {
    const file = writtenFile(f.argv) ?? 'the work file'
    return jobError(job, platform, at, { ...base, code: 'internal', short: 'Work file exists', message: `FFmpeg found the work file ${file} already there and wrote nothing.` })
  }
  if (f.decodeErrorCount > 0)
  {
    const first = f.decodeErrors[0] ?? lastLine(f.stderrTail) ?? 'decode errors'
    const count = f.decodeErrorCount === 1 ? '1 decode error' : `${f.decodeErrorCount} decode errors`
    return jobError(job, platform, at, { ...base, code: 'decode-errors', short: 'Decode errors', cause: 'decode', message: `The output does not decode cleanly (${count}): ${first}` })
  }
  const detail = lastLine(f.stderrTail)
  const sentence = `${STAGE_TEXT[f.stage]}${pass} ended with ${endingText(f)}.${detail === null ? '' : ` ${detail}`}`
  if (f.stage === 'measure' || f.stage === 'measure-dynamics')
  {
    return jobError(job, platform, at, { ...base, code: 'measure-failed', short: 'Measure failed', cause: ffmpegCause(f.stderrTail), message: sentence })
  }
  const short = f.stage === 'probe' ? 'Probe failed' : f.stage === 'verify' ? 'Verify failed' : 'Encode failed'
  const code: JobErrorCode = f.stage === 'probe' ? 'probe-failed' : 'ffmpeg-failed'
  return jobError(job, platform, at, { ...base, code, short, cause: ffmpegCause(f.stderrTail), message: sentence })
}

/** The audio job input of a runnable or planned job. */
export function audioInput(jobId: string, source: { path: string; size: number; mtimeMs: number }, recipe: AudioRecipe,
  facts: MediaFacts | null, output: { container: string; muxer: string }): AudioJobInput
{
  return {
    jobId,
    sourcePath: source.path,
    sourceSize: source.size,
    sourceMtimeMs: source.mtimeMs,
    recipe,
    facts,
    output: { container: output.container, muxer: output.muxer }
  }
}

function placeholderMeasurement(facts: MediaFacts, audioIndex: number): StreamMeasurement
{
  const a = facts.audio.find((s) => s.audioIndex === audioIndex)
  return {
    audioIndex,
    layout: a?.layout ?? '',
    channels: a?.channels ?? 0,
    sampleRate: a?.sampleRate ?? 0,
    stats: {
      status: 'measured',
      integratedLufs: SENTINEL_LUFS,
      thresholdLufs: null,
      loudnessRangeLu: null,
      lraStatus: 'not-applicable',
      maxShortTermLufs: null,
      truePeakDbtp: null,
      dialogueLufs: null,
      dualMono: false,
      channelWeights: 'bs1770-annex1'
    },
    loudnessToDialogueLu: null
  }
}

function placeholderPlan(audioIndex: number, ceiling: GainPlan['ceiling']): GainPlan
{
  return {
    audioIndex,
    mode: 'linear',
    reason: 'fits',
    targetLufs: null,
    requestedGainDb: 0,
    gainDb: 0,
    headroomDb: null,
    limitingDb: 0,
    maxLimitingDb: 0,
    predictedLufs: null,
    predictedTruePeakDbtp: null,
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling
  }
}

/**
 * The planned encode for display: the static plan's chains with the gain, the compressor threshold, and the output
 * path as placeholders, behind exec's prefix. Null when the plan is refused.
 */
export function plannedCommand(input: PlanInput<AudioRecipe>, staticPlan: StaticJobPlan): JobPlan['command']
{
  if (staticPlan.refusals.length > 0)
  {
    return null
  }
  const { facts, recipe, caps } = input
  const job = audioInput('plan', input.source, recipe, facts, input.output)
  const analysis: AudioAnalysis = {
    cacheKey: '',
    facts,
    source: staticPlan.streams.map((s) => placeholderMeasurement(facts, s.audioIndex)),
    afterDynamics: null,
    measuredAt: 0
  }
  const plans = staticPlan.streams.map((s) => placeholderPlan(s.audioIndex, s.ceiling))
  const choices = encoderChoices(facts, recipe, caps, staticPlan.container)
  const layout = buildEncodeArgs({ job, facts, staticPlan, analysis, levels: new Map(), choices, caps }, plans, OUTPUT_PLACEHOLDER)
  const gain = `volume=${formatDb(0)}:`
  const dynamics = recipe.kind === 'normalize' && recipe.dynamics !== null ? compressorStage(recipe.dynamics, SENTINEL_LUFS) : null
  const threshold = dynamics === null ? null : dynamics.replace(/^acompressor=threshold=[^:]+/, `acompressor=threshold=${THRESHOLD_PLACEHOLDER}`)
  const args = layout.args.map((arg) =>
  {
    const gained = arg.split(gain).join(`volume=${GAIN_PLACEHOLDER}:`)
    return dynamics === null || threshold === null ? gained : gained.split(dynamics).join(threshold)
  })
  const argv = execArgv(args, 'kill')
  return {
    argv,
    display: quoteForDisplay(['ffmpeg', ...argv], input.platform),
    placeholders: [GAIN_PLACEHOLDER, ...(dynamics === null ? [] : [THRESHOLD_PLACEHOLDER]), OUTPUT_PLACEHOLDER]
  }
}

const REFUSAL_ISSUES: Readonly<Record<RefusalCode, { code: PlanIssueCode; field: PlanIssue['field'] }>> = {
  'no-audio': { code: 'no-audio-stream', field: 'streams' },
  'too-many-channels': { code: 'too-many-channels', field: 'streams' },
  'layout-unsupported': { code: 'layout-unsupported', field: 'streams' },
  'no-encoder': { code: 'encoder-missing', field: 'encoder' },
  'container-cannot-hold': { code: 'container-cannot-hold', field: 'container' },
  'invalid-recipe': { code: 'invalid-recipe', field: 'recipe' },
  'ffmpeg-below-minimum': { code: 'ffmpeg-below-minimum', field: 'encoder' },
  'self-test-failed': { code: 'self-test-failed', field: 'encoder' }
}

/** A static refusal as the preflight's blocking issue, with the refusal's own sentence. */
export function refusalIssue(refusal: Refusal): PlanIssue
{
  const issue = REFUSAL_ISSUES[refusal.code]
  return { code: issue.code, severity: 'error', message: renderMessage(refusal.message, { minus: 'hyphen' }), field: issue.field, fix: null }
}

/** The stages an audio job runs: probe, measure (and after dynamics), then encode and verify with room for one correction. */
export function plannedStages(recipe: AudioRecipe, album: boolean): JobPlan['stages']
{
  const dynamics = recipe.kind === 'normalize' && recipe.dynamics !== null
  return [
    { id: 'probe', passes: 1 },
    { id: album ? 'measure-album' : 'measure', passes: 1 },
    ...(dynamics && !album ? [{ id: 'measure-dynamics' as const, passes: 1 }] : []),
    { id: 'encode', passes: MAX_ENCODE_PASSES },
    { id: 'verify', passes: MAX_ENCODE_PASSES }
  ]
}

/** The encoded size when every stream has a bitrate and the duration is known; null for lossless or unknown outputs. */
export function estimatedBytes(facts: MediaFacts, staticPlan: StaticJobPlan): number | null
{
  const duration = facts.durationSec
  if (!Number.isFinite(duration) || duration <= 0 || staticPlan.streams.length === 0)
  {
    return null
  }
  let kbps = 0
  for (const s of staticPlan.streams)
  {
    if (s.bitrateKbps === null)
    {
      return null
    }
    kbps += s.bitrateKbps
  }
  return Math.round((kbps * 1000 / 8) * duration)
}

/** The runner's share of the plan: the planned command with placeholders, the stream plan, and the refusals as issues. */
export function planAudio(input: PlanInput<AudioRecipe>, caps: BuildCapabilities = input.caps): RunnerPlan
{
  const staticPlan = planStatic(input.facts, input.recipe, caps, { container: input.output.container, muxer: input.output.muxer })
  const { streamPlan } = staticPlan
  return {
    command: plannedCommand({ ...input, caps }, staticPlan),
    streams: {
      kept: streamPlan.kept.map((k) => ({ ...k })),
      dropped: streamPlan.dropped.map((d) => ({ kind: d.kind, source: d.source, reason: d.reason })),
      chapters: streamPlan.chapters
    },
    video: null,
    audio: staticPlan.streams.map((s) => ({
      ...s,
      bitsPerSample: null,
      messages: staticPlan.notes.filter((n) => n.audioIndex === s.audioIndex).map((n) => n.message)
    })),
    class: 'audio',
    stages: plannedStages(input.recipe, false),
    estimate: { outputBytes: estimatedBytes(input.facts, staticPlan), workSec: null, confidence: 'low' },
    issues: staticPlan.refusals.map(refusalIssue)
  }
}

/** The short reason of the decoded-overshoot warning. */
export const OVERSHOOT_SHORT = 'Codec overshoot'

/** The decoded-overshoot sentence of every stream whose verdict carries the warning, in stream order. */
export function overshootMessages(result: Pick<AudioJobResult, 'streams'>, streams: readonly StaticStreamPlan[], presetId: string): MessageRef[]
{
  return result.streams.flatMap((s) =>
  {
    if (!s.verdict.warnings.includes('decoded-overshoot'))
    {
      return []
    }
    const encoder = streams.find((p) => p.audioIndex === s.verdict.audioIndex)?.encoder ?? null
    return [{
      key: 'decoded-overshoot' as const,
      params: {
        TP: s.after?.truePeakDbtp ?? null,
        codec: encoder === null ? null : codecOfEncoder(encoder),
        over: s.verdict.decoded.overDb,
        lim: s.verdict.decoded.limitDbtp,
        preset: presetId,
        TPpre: s.after?.preEncodeTruePeakDbtp ?? null
      }
    }]
  })
}

/** The warnings a verified audio output keeps lit until acknowledged: decoded-overshoot, with its sentence. */
export function audioWarnings(verification: Pick<Verification, 'messages'>): JobWarning[]
{
  return verification.messages
    .filter((m) => m.key === 'decoded-overshoot')
    .map((m) => ({ code: 'decoded-overshoot', short: OVERSHOOT_SHORT, message: renderMessage(m, { minus: 'hyphen' }) }))
}

/** A measurement report: the analysis the plans used (after dynamics when it ran) with a plan per stream. */
export function measurementOf(analysis: AudioAnalysis, plans: readonly GainPlan[], album: AlbumSummary | null, messages: readonly MessageRef[]): JobMeasurement
{
  const measured = analysis.afterDynamics ?? analysis.source
  return {
    pass: analysis.afterDynamics === null ? 'source' : 'after-dynamics',
    measuredAt: analysis.measuredAt,
    streams: plans.flatMap((plan) =>
    {
      const measurement = measured.find((m) => m.audioIndex === plan.audioIndex)
      return measurement === undefined ? [] : [{ measurement, plan }]
    }),
    album,
    messages: [...messages]
  }
}

/** The analysis cache key the job's analysis will carry; downmixed AC-3 and E-AC-3 streams key on their read levels, so they miss. */
export function expectedKey(input: AudioJobInput, facts: MediaFacts, staticPlan: StaticJobPlan, buildId: string): string
{
  const meters = staticPlan.streams.flatMap((s) =>
  {
    const a = facts.audio.find((x) => x.audioIndex === s.audioIndex)
    return a === undefined ? [] : [measureSpecFor(facts, a, input.recipe, null, null)]
  })
  return analysisKey(input, buildId, meters)
}

/**
 * An analysis rebuilt from a cached measurement. Only a source measurement of a recipe without dynamics holds every
 * analysis value, so anything else misses.
 */
export function cachedAnalysis(cache: MeasurementCache, key: string, facts: MediaFacts, staticPlan: StaticJobPlan, recipe: AudioRecipe): AudioAnalysis | null
{
  if (recipe.kind === 'normalize' && recipe.dynamics !== null)
  {
    return null
  }
  const m = cache.get(key)
  if (m === null || m.pass === 'after-dynamics')
  {
    return null
  }
  const source = m.streams.map((s) => s.measurement)
  if (!staticPlan.streams.every((s) => source.some((x) => x.audioIndex === s.audioIndex)))
  {
    return null
  }
  return { cacheKey: key, facts, source, afterDynamics: null, measuredAt: m.measuredAt }
}

/** An album member's analysis rebuilt from the album measurement, for when the shared analyses do not hold it. */
export function albumAnalysis(m: JobMeasurement, key: string, facts: MediaFacts): AudioAnalysis
{
  const streams = m.streams.map((s) => s.measurement)
  return { cacheKey: key, facts, source: streams, afterDynamics: m.pass === 'after-dynamics' ? streams : null, measuredAt: m.measuredAt }
}

/** Whether the run's static plan differs from the one the preflight showed, stream by stream. */
export function staticPlanChanged(preflight: JobPlan['audio'], streams: readonly StaticStreamPlan[]): boolean
{
  const shape = (s: StaticStreamPlan): string => `${s.audioIndex}:${s.encoder}:${s.outputLayout}:${s.outputRate}:${s.bitrateKbps ?? ''}`
  return preflight.length !== streams.length || preflight.some((p, k) => shape(p) !== shape(streams[k]))
}

/** Why an encode did not spawn: a work file already at its path, or a check that could not tell. */
export type OutputGuard = { kind: 'planted'; path: string } | { kind: 'unchecked'; path: string; error: string }

function messageOf(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/**
 * The file an argv writes: the path of its first `-f <muxer> <path>` output that is not the null muxer. The encode's
 * meter output (`-f null -`) follows the work file, and a measure or verify run only reads a work file through -i,
 * so neither answers here.
 */
export function writtenFile(argv: readonly string[]): string | null
{
  for (let i = 0; i + 2 < argv.length; i++)
  {
    if (argv[i] === '-f' && argv[i + 1] !== 'null' && argv[i + 1] !== 'lavfi')
    {
      return argv[i + 2]
    }
  }
  return null
}

/**
 * The context's exec with the command and stderr in the job log, and every write to a work path from output()
 * checked to be absent right before the spawn; a present or uncheckable path rejects as a spawn failure.
 */
export function guardedExec(ctx: Pick<RunContext, 'exec' | 'log'>, deps: Pick<AudioRunnerDeps, 'exists' | 'platform'>,
  issued: ReadonlySet<string>, guard: { value: OutputGuard | null }): Exec
{
  return {
    async run(args, o)
    {
      const target = writtenFile(args)
      if (target !== null && issued.has(target))
      {
        let present: boolean
        try
        {
          present = await deps.exists(target)
        }
        catch (err)
        {
          guard.value = { kind: 'unchecked', path: target, error: messageOf(err) }
          throw err
        }
        if (present)
        {
          guard.value = { kind: 'planted', path: target }
          throw new Error(`The work file ${target} already exists`)
        }
        if (o.signal.aborted)
        {
          throw new Error('Aborted before the spawn')
        }
      }
      ctx.log.info(`${COMMAND_PREFIX}${quoteForDisplay(['ffmpeg', ...execArgv(args, o.stop)], deps.platform)}`)
      return ctx.exec.run(args, {
        ...o,
        onStderrLine: (line) =>
        {
          ctx.log.ffmpeg(line)
          o.onStderrLine?.(line)
        }
      })
    }
  }
}

/** What a run's reports read while it goes: the analysis and album the plans came from, and the plan notes. */
interface RunState
{
  analysis: AudioAnalysis | null
  album: AlbumSummary | null
  notes: MessageRef[]
  durationSec: number | null
}

/** Maps one audio event to the context's stage, progress, and measurement reports. */
export function reportEvent(e: AudioEvent, ctx: Pick<RunContext, 'stage' | 'progress' | 'measured' | 'log' | 'now'>,
  state: Pick<RunState, 'analysis' | 'album' | 'notes' | 'durationSec'>): void
{
  switch (e.type)
  {
    case 'audio.stage':
      ctx.stage({ id: e.stage, pass: e.encodePass ?? 1, passes: e.encodePass === null ? 1 : e.maxEncodePasses, label: audioStageLabel(e.stage, e.encodePass) })
      return
    case 'audio.progress':
      ctx.progress({ outTimeSec: e.outTimeSec, durationSec: state.durationSec, speed: e.speed, bytes: e.bytes })
      return
    case 'audio.measured':
      ctx.measured({ pass: e.pass, measuredAt: ctx.now(), streams: e.streams.map((measurement) => ({ measurement, plan: null })), album: null, messages: [] })
      return
    case 'audio.planned':
      state.notes = e.notes.map((n) => n.message)
      if (state.analysis !== null)
      {
        ctx.measured(measurementOf(state.analysis, e.plans, state.album, state.notes))
      }
      return
    case 'audio.verified':
      ctx.log.info(`Verified encode ${e.encodePass}: ${e.streams.map((s) => s.verdict.outcome).join(', ')}`)
      return
    case 'audio.correcting':
      ctx.log.info(`Correcting: ${e.reasons.join(', ')}`)
      return
    case 'audio.static-plan':
      return
  }
}

function logText(entry: Parameters<AudioJobDeps['log']>[0]): string
{
  const data = entry.data === undefined ? [] : Object.entries(entry.data).map(([k, v]) => `${k}=${v === null ? 'null' : String(v)}`)
  return data.length === 0 ? entry.message : `${entry.message} (${data.join(', ')})`
}

/** The audio job's deps over the run's context: guarded exec, work paths from ctx.output, events as reports. */
function audioDeps(ctx: RunContext, deps: AudioRunnerDeps, state: RunState, guard: { value: OutputGuard | null }): AudioJobDeps
{
  const issued = new Set<string>()
  return {
    exec: guardedExec(ctx, deps, issued, guard),
    probe: () => Promise.reject(new Error('Audio sources are probed by the engine')),
    caps: ctx.caps,
    buildId: deps.buildId(),
    output: (ext, encodePass) =>
    {
      const file = ctx.output(ext, encodePass)
      issued.add(file)
      return file
    },
    fs: {
      remove: async (file) =>
      {
        if (guard.value?.kind === 'planted' && guard.value.path === file)
        {
          return
        }
        await deps.remove(file)
      },
      size: (file) => deps.size(file)
    },
    emit: (e) => reportEvent(e, ctx, state),
    log: (entry) => ctx.log[entry.level](logText(entry)),
    now: () => ctx.now()
  }
}

const ABORTED: RunOutcome = { kind: 'aborted' }

type Measured = { kind: 'measured'; analysis: AudioAnalysis; plans: GainPlan[]; album: AlbumSummary | null } | { kind: 'outcome'; outcome: RunOutcome }

function knownDuration(facts: MediaFacts): number | null
{
  return Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null
}

function failed(error: JobError): RunOutcome
{
  return { kind: 'failed', error }
}

/**
 * The analysis and plans the encode runs with: an album member's from the album measurement (the shared analysis
 * when the engine holds it), else a shared or cached analysis, else the job's own measure passes.
 */
async function obtainAnalysis(job: RunnableJob<AudioRecipe>, ctx: RunContext, deps: AudioRunnerDeps, input: AudioJobInput,
  facts: MediaFacts, staticPlan: StaticJobPlan, audio: AudioJobDeps): Promise<Measured>
{
  const { signal } = ctx
  const key = expectedKey(input, facts, staticPlan, audio.buildId)
  const measureStage = (): void => ctx.stage({ id: 'measure', pass: 1, passes: 1, label: audioStageLabel('measure', null) })
  const shared = async (): Promise<AudioAnalysis | null> => (deps.analyses ? deps.analyses.forJob(job.id, key, signal) : null)
  if (ctx.album !== null)
  {
    const m = await ctx.album.measurement(signal)
    if (signal.aborted)
    {
      return { kind: 'outcome', outcome: ABORTED }
    }
    const albumFailed = (message: string): Measured => ({
      kind: 'outcome',
      outcome: failed(jobError(job, deps.platform, ctx.now(), { code: 'album-measure-failed', short: 'Album measure failed', stage: 'measure', message }))
    })
    if (m === null)
    {
      return albumFailed('The album could not be measured, so its shared gain is unknown.')
    }
    const plans: GainPlan[] = []
    for (const s of staticPlan.streams)
    {
      const plan = m.streams.find((x) => x.measurement.audioIndex === s.audioIndex)?.plan ?? null
      if (plan === null)
      {
        return albumFailed(`The album measurement has no gain for audio stream ${s.audioIndex}.`)
      }
      plans.push(plan)
    }
    measureStage()
    const analysis = await shared()
    if (signal.aborted)
    {
      return { kind: 'outcome', outcome: ABORTED }
    }
    return { kind: 'measured', analysis: analysis ?? albumAnalysis(m, key, facts), plans, album: m.album }
  }
  const reused = (await shared()) ?? cachedAnalysis(ctx.cache, key, facts, staticPlan, job.recipe)
  if (signal.aborted)
  {
    return { kind: 'outcome', outcome: ABORTED }
  }
  if (reused !== null)
  {
    measureStage()
    return { kind: 'measured', analysis: reused, plans: planAudioJob(reused, staticPlan, job.recipe), album: null }
  }
  const analyzed = await analyzeAudioJob(input, audio, signal)
  if (signal.aborted)
  {
    return { kind: 'outcome', outcome: ABORTED }
  }
  if (analyzed.kind === 'ended')
  {
    return { kind: 'outcome', outcome: endedOutcome(job, ctx, deps, analyzed.result, null) }
  }
  const analysis = analyzed.analysis
  const plans = planAudioJob(analysis, staticPlan, job.recipe)
  deps.analyses?.store(analysis)
  ctx.cache.set(analysis.cacheKey, measurementOf(analysis, plans, null, []))
  return { kind: 'measured', analysis, plans, album: null }
}

/** The outcome of an audio job that produced no output: aborted, refused, or failed. */
function endedOutcome(job: RunnableJob<AudioRecipe>, ctx: RunContext, deps: AudioRunnerDeps, result: AudioJobResult, guard: OutputGuard | null): RunOutcome
{
  const at = ctx.now()
  if (result.outcome === 'canceled')
  {
    return ABORTED
  }
  if (result.outcome === 'refused')
  {
    return failed(refusalError(job, deps.platform, at, result.refusals))
  }
  const pass = { encodePass: result.failure?.encodePass ?? null, argv: result.failure?.argv ?? null }
  if (guard?.kind === 'planted')
  {
    return failed(jobError(job, deps.platform, at, {
      ...pass, code: 'internal', short: 'Work file exists', stage: 'encode', message: `The work file ${guard.path} already exists, so nothing was written over it.`
    }))
  }
  if (guard?.kind === 'unchecked')
  {
    return failed(jobError(job, deps.platform, at, {
      ...pass, code: 'internal', short: 'Work file unchecked', stage: 'encode', message: `The work file ${guard.path} could not be checked before the encode: ${guard.error}`
    }))
  }
  if (result.failure === null)
  {
    const text = renderMessages(result.messages)
    return failed(jobError(job, deps.platform, at, {
      code: 'internal', short: 'Audio job failed', stage: 'encode', message: text === '' ? 'The audio job failed without a failure record.' : text
    }))
  }
  return failed(failureError(job, deps.platform, at, result.failure))
}

/** The verified output for the engine to place, with the verification, the final measurement, and the warnings' sentences. */
async function outputOutcome(job: RunnableJob<AudioRecipe>, ctx: RunContext, deps: AudioRunnerDeps, staticPlan: StaticJobPlan,
  result: AudioJobResult, state: RunState, facts: MediaFacts): Promise<RunOutcome>
{
  const outputPath = result.outputPath
  const outcome = result.outcome
  if (outputPath === null || state.analysis === null || outcome === 'canceled' || outcome === 'refused' || outcome === 'failed')
  {
    return failed(jobError(job, deps.platform, ctx.now(), { code: 'internal', short: 'No output', stage: 'verify', message: 'The audio job ended without an output to place.' }))
  }
  let bytes: number
  try
  {
    bytes = await deps.size(outputPath)
  }
  catch (err)
  {
    if (ctx.signal.aborted)
    {
      return ABORTED
    }
    return failed(jobError(job, deps.platform, ctx.now(), {
      code: 'output-unreadable', short: 'Output unreadable', stage: 'verify', message: `The verified output could not be read: ${messageOf(err)}`
    }))
  }
  if (ctx.signal.aborted)
  {
    return ABORTED
  }
  const overshoot = overshootMessages(result, staticPlan.streams, job.recipe.presetId)
  const verification: Verification = {
    verdict: outcome,
    encodePasses: result.encodePasses,
    audio: result.streams.map((s) => ({ verified: s.after, verdict: s.verdict })),
    media: null,
    messages: [...result.messages, ...overshoot]
  }
  return {
    kind: 'output',
    artifact: {
      kind: 'file',
      path: outputPath,
      container: result.container,
      bytes,
      durationSec: knownDuration(facts),
      encoder: { video: job.plan.streams.kept.some((k) => k.kind === 'video') ? 'copy' : null, audio: staticPlan.streams.map((s) => s.encoder) }
    },
    verification,
    measurement: measurementOf(state.analysis, result.streams.map((s) => s.plan), state.album, state.notes),
    notes: audioWarnings(verification).map((w) => w.message)
  }
}

/** One run: probe, static plan (a refusal ends here), the analysis or the album's, encode and verify, then the outcome. */
export async function runAudio(job: RunnableJob<AudioRecipe>, ctx: RunContext, deps: AudioRunnerDeps): Promise<RunOutcome>
{
  const { signal } = ctx
  if (signal.aborted)
  {
    return ABORTED
  }
  ctx.stage({ id: 'probe', pass: 1, passes: 1, label: audioStageLabel('probe', null) })
  let facts: MediaFacts
  try
  {
    facts = await ctx.probe(job.source.path)
  }
  catch (err)
  {
    if (signal.aborted)
    {
      return ABORTED
    }
    return failed(jobError(job, deps.platform, ctx.now(), { code: 'probe-failed', short: 'Probe failed', stage: 'probe', message: `The source could not be read: ${messageOf(err)}` }))
  }
  if (signal.aborted)
  {
    return ABORTED
  }
  const input = audioInput(job.id, job.source, job.recipe, facts, job.plan.output)
  const staticPlan = planStatic(facts, job.recipe, ctx.caps, input.output)
  if (staticPlan.refusals.length > 0)
  {
    ctx.log.warn(`Refused: ${renderMessages(staticPlan.refusals.map((r) => r.message))}`)
    return failed(refusalError(job, deps.platform, ctx.now(), staticPlan.refusals))
  }
  if (staticPlanChanged(job.plan.audio, staticPlan.streams))
  {
    ctx.log.warn('The audio output differs from the preflight; the run follows the current source')
  }
  const state: RunState = { analysis: null, album: null, notes: [], durationSec: knownDuration(facts) }
  const guard: { value: OutputGuard | null } = { value: null }
  const audio = audioDeps(ctx, deps, state, guard)
  const measured = await obtainAnalysis(job, ctx, deps, input, facts, staticPlan, audio)
  if (measured.kind === 'outcome')
  {
    return measured.outcome
  }
  state.analysis = measured.analysis
  state.album = measured.album
  const result = await encodeAudioJob(input, staticPlan, measured.analysis, measured.plans, audio, signal)
  if (signal.aborted)
  {
    return ABORTED
  }
  if (result.outcome === 'canceled' || result.outcome === 'refused' || result.outcome === 'failed')
  {
    return endedOutcome(job, ctx, deps, result, guard.value)
  }
  return outputOutcome(job, ctx, deps, staticPlan, result, state, facts)
}

/** The Normalize runner. */
export function createNormalizeRunner(deps: AudioRunnerDeps): JobRunner<NormalizeRecipe>
{
  return { kind: 'normalize', plan: (input) => planAudio(input), run: (job, ctx) => runAudio(job, ctx, deps) }
}

/** The Gain runner; it shares every piece with Normalize. */
export function createBoostRunner(deps: AudioRunnerDeps): JobRunner<BoostRecipe>
{
  return { kind: 'boost', plan: (input) => planAudio(input), run: (job, ctx) => runAudio(job, ctx, deps) }
}
