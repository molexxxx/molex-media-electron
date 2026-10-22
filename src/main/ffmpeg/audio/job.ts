/**
 * The audio job in four separately callable pieces: the pure static plan, the analysis (probe, downmix-metadata
 * read, pass A, and pass B after dynamics), the pure gain plans, and the encode with verification and at most one
 * corrective pass. Every piece resolves; only a programming error throws.
 */
import type {
  AudioAnalysis, AudioEvent, AudioFailure, AudioJobResult, AudioStage, CorrectionReason, StaticJobPlan, StaticStreamPlan, StreamMeasurement
} from '../../../shared/audio/events'
import { MAX_ENCODE_PASSES } from '../../../shared/audio/events'
import { validateAudioRecipe } from '../../../shared/audio/limits'
import type { MessageRef } from '../../../shared/audio/messages'
import { findLoudnessPreset } from '../../../shared/audio/presets'
import type {
  AudioFacts, AudioJobInput, AudioOutput, BoostRecipe, GainPlan, MediaFacts, NormalizeRecipe, Outcome, PlanNote, Refusal, RefusalCode,
  StreamVerdict, VerifiedStream
} from '../../../shared/audio/types'
import { execArgv, exitName, signedExitCode } from '../exec'
import type { Exec, ExecResult, FfmpegProgress } from '../exec'
import { isLosslessEncoder, presetMaxFor, resolveCeiling } from './ceilings'
import { encodeParts, filterComplex, meterOutputArgs, meterPrefix } from './chains'
import type { ChainSpec, FilterPart } from './chains'
import { codecOfEncoder, containerFor } from './containers'
import { buildDownmixProbeArgs, DOWNMIX_LAYOUTS, DOWNMIX_LEVEL_CODECS, downmixStage, LAYOUT_CHANNELS, parseDownmixInfo } from './downmix'
import type { DownmixLevels } from './downmix'
import { compressorStage } from './dynamics'
import { chooseEncoder } from './encoders'
import type { BuildCapabilities, EncoderDecision } from './encoders'
import { isVideoFile, toMediaFacts } from './facts'
import type { ProbeJson } from './facts'
import { annex3Stage, buildMeasureArgs, classify, measureKey, parseEbur128Blocks, streamBlock } from './measure'
import type { MeasureSpec } from './measure'
import { planBoost, planNormalize, shortFormApplies, toleranceLu } from './plan'
import { audioToKeep, planStreams } from './streams'
import type { StreamPolicy } from './streams'
import { better, buildVerifyArgs, correctedPlan, isDecodeError, judge, MAX_DECODE_ERRORS, parseVerify } from './verify'
import type { VerifySpec } from './verify'

/** What the audio job needs from the engine; every path it writes comes from output(). */
export interface AudioJobDeps
{
  exec: Exec
  /** Config-free; kills ffprobe on abort. */
  probe(path: string, signal: AbortSignal): Promise<ProbeJson>
  caps: BuildCapabilities
  /** The FFmpeg build id; part of the measurement cache key. */
  buildId: string
  /** A .part path in the execution's work folder. */
  output(ext: string, encodePass: 1 | 2): string
  /** Called only with paths from output(). */
  fs: { remove(path: string): Promise<void>; size(path: string): Promise<number> }
  emit(e: AudioEvent): void
  log(entry: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: Readonly<Record<string, string | number | boolean | null>> }): void
  now(): number
}

/** The stream policy of audio jobs: subtitles, global tags, and cover art are kept wherever the container allows. */
export const AUDIO_STREAM_POLICY: StreamPolicy = { keepSubtitles: true, keepGlobalTags: true, keepCoverArt: true }

type AudioRecipe = NormalizeRecipe | BoostRecipe

interface StreamDecision
{
  a: AudioFacts
  decision: EncoderDecision | null
  refusal: RefusalCode | null
}

/** The channels and layout a stream is measured and written with: duplicated mono or a stereo downmix for normalize. */
export function outputShape(a: AudioFacts, recipe: AudioRecipe): { channels: number; layout: string | null }
{
  if (recipe.kind === 'normalize')
  {
    if (recipe.monoToStereo && a.channels === 1)
    {
      return { channels: 2, layout: 'stereo' }
    }
    if (recipe.downmix !== null && a.channels > 2)
    {
      return { channels: 2, layout: 'stereo' }
    }
  }
  return { channels: a.channels, layout: a.layout }
}

function layoutRefusal(a: AudioFacts, recipe: AudioRecipe, layout: string | null): RefusalCode | null
{
  if (layout === null || a.layout === null)
  {
    return 'layout-unsupported'
  }
  if (recipe.kind === 'normalize' && recipe.downmix !== null && a.channels > 2 && !DOWNMIX_LAYOUTS.includes(a.layout))
  {
    return 'layout-unsupported'
  }
  const weights = annex3Stage(layout, Object.hasOwn(LAYOUT_CHANNELS, layout) ? LAYOUT_CHANNELS[layout] : [])
  return weights.ok ? null : 'layout-unsupported'
}

function decide(facts: MediaFacts, recipe: AudioRecipe, caps: BuildCapabilities, container: string): StreamDecision[]
{
  const video = isVideoFile(facts)
  return audioToKeep(facts, containerFor(container)).map((a) =>
  {
    const shape = outputShape(a, recipe)
    const refusal = layoutRefusal(a, recipe, shape.layout)
    if (refusal !== null || shape.layout === null)
    {
      return { a, decision: null, refusal: refusal ?? 'layout-unsupported' }
    }
    const out = { channels: shape.channels, layout: shape.layout, minSampleRate: minSampleRateFor(recipe), video }
    const decision = chooseEncoder(a, recipe.output, container, out, caps)
    return { a, decision, refusal: decision.ok ? null : decision.reason }
  })
}

/** The lowest output rate a recipe's preset accepts (Apple Podcasts: 44.1 kHz); null for boost and presets without one. */
export function minSampleRateFor(recipe: AudioRecipe): number | null
{
  return recipe.kind === 'normalize' ? (findLoudnessPreset(recipe.presetId)?.minSampleRate ?? null) : null
}

function refusalMessage(code: RefusalCode, a: AudioFacts | null, decision: EncoderDecision | null, container: string): MessageRef
{
  const failed = decision !== null && !decision.ok ? decision : null
  if (code === 'too-many-channels')
  {
    return { key: 'too-many-channels', params: { codec: failed?.encoder ?? a?.codecName ?? null, n: failed?.maxChannels ?? null, m: a?.channels ?? null } }
  }
  const what = a === null ? code : `${a.codecName} ${a.layout ?? `${a.channels} channels`}`
  return { key: 'dropped', params: { n: a === null ? 0 : 1, kind: 'audio', ext: container, codecs: what } }
}

/** A file-level refusal, before any stream is planned. */
export function fileRefusal(code: RefusalCode, container: string): Refusal
{
  return { audioIndex: null, code, message: refusalMessage(code, null, null, container) }
}

function sourceCodec(facts: MediaFacts, index: number): string
{
  const streams: Array<{ streamIndex: number; codecName?: string; filename?: string | null }> =
    [...facts.video, ...facts.audio, ...facts.subtitles, ...facts.attachments, ...facts.data]
  const found = streams.find((s) => s.streamIndex === index)
  return found?.codecName ?? found?.filename ?? 'unknown'
}

/** The pure static plan: container decision, encoder and ceiling per stream, stream map, refusals, and notes. */
export function planStatic(facts: MediaFacts, recipe: AudioRecipe, caps: BuildCapabilities, output: AudioJobInput['output']): StaticJobPlan
{
  let container = output.container
  let decisions = decide(facts, recipe, caps, container)
  const moved = decisions.find((d) => d.decision !== null && d.decision.ok && d.decision.container !== container)
  if (moved !== undefined && moved.decision !== null && moved.decision.ok)
  {
    container = moved.decision.container
    decisions = decide(facts, recipe, caps, container)
  }
  const refusals: Refusal[] = facts.audio.length === 0 ? [fileRefusal('no-audio', container)] : []
  const streams: StaticStreamPlan[] = []
  const outputs: AudioOutput[] = []
  const notes: PlanNote[] = []
  const containerChanged = container !== output.container
  const presetMax = recipe.kind === 'normalize' ? presetMaxFor(recipe.target, recipe.target.integratedLufs) : recipe.maxTruePeakDbtp
  for (const d of decisions)
  {
    if (d.decision === null || !d.decision.ok)
    {
      const code = d.refusal ?? 'no-encoder'
      refusals.push({ audioIndex: d.a.audioIndex, code, message: refusalMessage(code, d.a, d.decision, container) })
      continue
    }
    const choice = d.decision.choice
    const ceiling = resolveCeiling(choice.encoder, choice.kbpsPerPair, presetMax)
    const streamNotes = containerChanged && !choice.notes.includes('container-changed') ? [...choice.notes, 'container-changed' as const] : choice.notes
    streams.push({
      audioIndex: d.a.audioIndex, encoder: choice.encoder, bitrateKbps: choice.bitrateKbps, outputLayout: choice.layout,
      outputRate: choice.sampleRate, ceiling, notes: streamNotes
    })
    outputs.push({ audioIndex: d.a.audioIndex, outIndex: outputs.length, label: `[a${outputs.length}]`, choice })
    for (const note of streamNotes)
    {
      const message = noteMessage(note, d.a, choice.encoder, choice.layout, choice.sampleRate, recipe.presetId, output.container, container)
      if (message === null || (message.key === 'container-changed' && notes.some((n) => n.message.key === 'container-changed')))
      {
        continue
      }
      notes.push({ audioIndex: message.key === 'container-changed' ? null : d.a.audioIndex, message })
    }
  }
  const streamPlan = planStreams(facts, containerFor(container), outputs, AUDIO_STREAM_POLICY)
  const kinds = [...new Set(streamPlan.dropped.map((drop) => drop.kind))]
  for (const kind of kinds)
  {
    const dropped = streamPlan.dropped.filter((drop) => drop.kind === kind)
    const codecs = [...new Set(dropped.map((drop) => sourceCodec(facts, drop.source)))].join(', ')
    notes.push({ audioIndex: null, message: { key: 'dropped', params: { n: dropped.length, kind, ext: container, codecs } } })
  }
  if (streamPlan.chapters === 'dropped')
  {
    notes.push({ audioIndex: null, message: { key: 'chapters-dropped', params: { ext: container, n: facts.chapters } } })
  }
  return { container, containerChanged, streams, streamPlan, refusals, notes }
}

function noteMessage(note: string, a: AudioFacts, encoder: string, layout: string, rate: number, preset: string,
  requested: string, container: string): MessageRef | null
{
  switch (note)
  {
    case 'container-changed':
      return { key: 'container-changed', params: { codec: codecOfEncoder(encoder), ext: requested, newExt: container } }
    case 'layout-remapped':
      return { key: 'layout-remapped', params: { from: a.layout, to: layout, codec: encoder } }
    case 'rate-raised':
      return { key: 'rate-raised', params: { from: a.sampleRate, to: rate, preset } }
    case 'no-source-encoder':
      return { key: 'no-encoder', params: { source: a.codecName, codec: encoder } }
    default:
      return null
  }
}

/** Input options of every source decode: level-tagged info logging, -n for the work-folder output, a deep probe. */
const ENCODE_INPUT_ARGS = ['-loglevel', 'level+info', '-n', '-analyzeduration', '200M', '-probesize', '200M']

const PRE_ENCODE_PEAK = /^\[astats@p(\d+) @ [0-9A-Fa-fx]+\] (?:\[info\] )?Peak level dB: (\S+)$/
const NUMBER = /^-?\d+(?:\.\d+)?$/

/** Collects a run's stderr lines with the decode errors bounded: the first 20 are kept, every one is counted. */
interface LineSink
{
  lines: string[]
  errors: string[]
  errorCount: number
  push(line: string): void
}

function lineSink(): LineSink
{
  const sink: LineSink = {
    lines: [],
    errors: [],
    errorCount: 0,
    push(line: string): void
    {
      if (!isDecodeError(line))
      {
        sink.lines.push(line)
        return
      }
      sink.errorCount++
      if (sink.errors.length < MAX_DECODE_ERRORS)
      {
        sink.errors.push(line)
        sink.lines.push(line)
      }
    }
  }
  return sink
}

type RunEnd =
  | { kind: 'ok'; result: ExecResult }
  | { kind: 'canceled' }
  | { kind: 'failed'; failure: AudioFailure }

interface PassContext
{
  job: AudioJobInput
  deps: AudioJobDeps
  signal: AbortSignal
  durationSec: number | null
}

function errorText(err: unknown): string
{
  return err instanceof Error ? err.message : String(err)
}

/** The failure of one FFmpeg run, with the signed exit code and its name, the full command, and the stderr tail. */
export function runFailure(stage: AudioStage, encodePass: 1 | 2 | null, args: readonly string[], r: ExecResult | null,
  error: unknown = null, decode: { errors: string[]; count: number } = { errors: [], count: 0 }): AudioFailure
{
  const code = r === null ? null : signedExitCode(r.code)
  const refusedAtZero = r !== null && code === 0 && r.outputRefused
  return {
    stage,
    encodePass,
    exitCode: code,
    exitName: refusedAtZero ? 'EEXIST' : (exitName(code) ?? r?.exitName ?? null),
    signal: r?.signal ?? null,
    argv: execArgv(args, 'kill'),
    stderrTail: r?.stderrTail ?? (error === null ? '' : errorText(error)),
    decodeErrors: decode.errors,
    decodeErrorCount: decode.count
  }
}

/** The progress payload of one -progress block: fraction of the duration clamped to 0..1, null while it is unknown. */
export function progressEvent(jobId: string, stage: AudioStage, encodePass: 1 | 2 | null, p: FfmpegProgress,
  durationSec: number | null): AudioEvent
{
  const fraction = durationSec === null || durationSec <= 0 || p.outTimeSec === null
    ? null
    : Math.min(1, Math.max(0, p.outTimeSec / durationSec))
  const speed = p.speed === null || p.speed <= 0 ? null : p.speed
  return { type: 'audio.progress', jobId, stage, encodePass, fraction, outTimeSec: p.outTimeSec, speed, bytes: p.totalSize }
}

function emitStage(ctx: PassContext, stage: AudioStage, encodePass: 1 | 2 | null): void
{
  ctx.deps.emit({ type: 'audio.stage', jobId: ctx.job.jobId, stage, encodePass, maxEncodePasses: MAX_ENCODE_PASSES })
}

/** One FFmpeg run under the kill stop: canceled on abort, failed on a spawn error, a non-zero exit, a refused output, or a stop. */
async function runOnce(ctx: PassContext, stage: AudioStage, encodePass: 1 | 2 | null, args: string[],
  onLine: (line: string) => void, progress: boolean): Promise<RunEnd>
{
  if (ctx.signal.aborted)
  {
    return { kind: 'canceled' }
  }
  let result: ExecResult
  try
  {
    result = await ctx.deps.exec.run(args, {
      signal: ctx.signal,
      stop: 'kill',
      ...(ctx.durationSec === null ? {} : { durationSec: ctx.durationSec }),
      ...(progress ? { onProgress: (p: FfmpegProgress) => ctx.deps.emit(progressEvent(ctx.job.jobId, stage, encodePass, p, ctx.durationSec)) } : {}),
      onStderrLine: onLine
    })
  }
  catch (err)
  {
    if (ctx.signal.aborted)
    {
      return { kind: 'canceled' }
    }
    ctx.deps.log({ level: 'error', message: 'FFmpeg did not start', data: { jobId: ctx.job.jobId, stage, error: errorText(err) } })
    return { kind: 'failed', failure: runFailure(stage, encodePass, args, null, err) }
  }
  if (ctx.signal.aborted || result.aborted)
  {
    return { kind: 'canceled' }
  }
  const code = signedExitCode(result.code)
  if (code !== 0 || result.outputRefused || result.stopped !== 'none')
  {
    ctx.deps.log({ level: 'error', message: 'FFmpeg run failed', data: { jobId: ctx.job.jobId, stage, encodePass, code, signal: result.signal } })
    return { kind: 'failed', failure: runFailure(stage, encodePass, args, result) }
  }
  ctx.deps.log({ level: 'debug', message: 'FFmpeg run finished', data: { jobId: ctx.job.jobId, stage, encodePass, ms: result.ms } })
  return { kind: 'ok', result }
}

function channelsOf(layout: string | null): readonly string[]
{
  return layout !== null && Object.hasOwn(LAYOUT_CHANNELS, layout) ? LAYOUT_CHANNELS[layout] : []
}

function sourceStream(facts: MediaFacts, audioIndex: number): AudioFacts
{
  const a = facts.audio.find((s) => s.audioIndex === audioIndex)
  if (a === undefined)
  {
    throw new Error(`Audio stream ${audioIndex} is not in the facts`)
  }
  return a
}

function streamDuration(facts: MediaFacts, a: AudioFacts): number
{
  return a.durationSec ?? facts.durationSec
}

function knownDuration(facts: MediaFacts): number | null
{
  return Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null
}

/** Whether a stream is downmixed to stereo by its recipe. */
function downmixOf(a: AudioFacts, recipe: AudioRecipe): NormalizeRecipe['downmix']
{
  return recipe.kind === 'normalize' && a.channels > 2 ? recipe.downmix : null
}

/** How a stream is measured: the meter prefix, the mono policy, the Annex 3 weights, short-form and dialogue branches. */
export function measureSpecFor(facts: MediaFacts, a: AudioFacts, recipe: AudioRecipe, levels: DownmixLevels | null,
  dynamics: string | null): MeasureSpec
{
  const shape = outputShape(a, recipe)
  const layout = shape.layout ?? a.layout ?? ''
  const pre = meterPrefix({
    inputLayout: a.layout ?? layout,
    monoToStereo: recipe.kind === 'normalize' && recipe.monoToStereo && a.channels === 1,
    downmix: downmixOf(a, recipe),
    downmixLevels: levels,
    dynamics
  })
  const weights = annex3Stage(layout, channelsOf(layout))
  const channels = channelsOf(layout)
  return {
    audioIndex: a.audioIndex,
    pre,
    dualMono: shape.channels === 1 && recipe.mono === 'two-speakers',
    weights: weights.ok ? weights.stage : null,
    shortTerm: recipe.kind === 'normalize' && shortFormApplies(recipe.shortForm, streamDuration(facts, a)),
    dialogue: recipe.kind === 'normalize' && recipe.cinematic && channels.includes('FC') && channels.length >= 5
  }
}

/** The measurement cache key: measure.ts's key over the pass A measure settings, plus the dynamics settings when the recipe has them. */
export function analysisKey(job: AudioJobInput, buildId: string, specs: readonly MeasureSpec[]): string
{
  const key = measureKey(job, buildId, specs)
  const dynamics = job.recipe.kind === 'normalize' ? job.recipe.dynamics : null
  return dynamics === null ? key : JSON.stringify([key, dynamics])
}

function needsDownmixLevels(a: AudioFacts, recipe: AudioRecipe): boolean
{
  return downmixOf(a, recipe) !== null && DOWNMIX_LEVEL_CODECS.has(a.codecName)
}

/** Reads the downmix side data of every stream that is downmixed and whose codec carries it (AC-3, E-AC-3). */
async function readDownmixLevels(ctx: PassContext, facts: MediaFacts, plan: StaticJobPlan, stage: AudioStage,
  encodePass: 1 | 2 | null): Promise<{ kind: 'ok'; levels: Map<number, DownmixLevels | null> } | Exclude<RunEnd, { kind: 'ok' }>>
{
  const levels = new Map<number, DownmixLevels | null>()
  for (const s of plan.streams)
  {
    const a = sourceStream(facts, s.audioIndex)
    if (!needsDownmixLevels(a, ctx.job.recipe))
    {
      continue
    }
    const lines: string[] = []
    const end = await runOnce(ctx, stage, encodePass, buildDownmixProbeArgs(ctx.job.sourcePath, a.audioIndex), (line) => lines.push(line), false)
    if (end.kind !== 'ok')
    {
      return end
    }
    levels.set(a.audioIndex, parseDownmixInfo(lines.join('\n')))
  }
  return { kind: 'ok', levels }
}

/** The downmix and mono notes of a job, from the coefficients each downmixed stream takes. */
function chainNotes(facts: MediaFacts, plan: StaticJobPlan, recipe: AudioRecipe, levels: ReadonlyMap<number, DownmixLevels | null>): PlanNote[]
{
  const notes: PlanNote[] = []
  for (const s of plan.streams)
  {
    const a = sourceStream(facts, s.audioIndex)
    const mode = downmixOf(a, recipe)
    if (recipe.kind === 'normalize' && recipe.monoToStereo && a.channels === 1)
    {
      notes.push({ audioIndex: a.audioIndex, message: { key: 'mono-duplicated', params: {} } })
    }
    if (mode === null || a.layout === null)
    {
      continue
    }
    const level = levels.get(a.audioIndex) ?? null
    const stage = downmixStage(mode, a.layout, level)
    if (stage === null)
    {
      continue
    }
    const keys = { 'stream-metadata': 'downmix-metadata', 'bs775': 'downmix-bs775', 'bs775-extended': 'downmix-bs775-extended', 'dialog': 'downmix-dialog' } as const
    const params: Record<string, string | number | null> = stage.coefficients === 'stream-metadata' && level !== null
      ? { layout: a.layout, c: toDb(level.centerLoRo), s: toDb(level.surroundLoRo) }
      : { layout: a.layout }
    notes.push({ audioIndex: a.audioIndex, message: { key: keys[stage.coefficients], params } })
  }
  return notes
}

function toDb(linear: number): number | null
{
  return linear > 0 ? Math.round(2000 * Math.log10(linear)) / 100 : null
}

/** One measure pass over every stream of the job, parsed into a StreamMeasurement per spec. */
async function measurePass(ctx: PassContext, facts: MediaFacts, stage: 'measure' | 'measure-dynamics', specs: MeasureSpec[]):
  Promise<{ kind: 'ok'; streams: StreamMeasurement[] } | Exclude<RunEnd, { kind: 'ok' }>>
{
  const sink = lineSink()
  const args = buildMeasureArgs(ctx.job.sourcePath, specs)
  const end = await runOnce(ctx, stage, null, args, (line) => sink.push(line), true)
  if (end.kind !== 'ok')
  {
    return end
  }
  const blocks = parseEbur128Blocks(sink.lines.join('\n'))
  if (specs.some((spec) => streamBlock(blocks, spec) === undefined))
  {
    ctx.deps.log({ level: 'error', message: 'Measure printed no Summary', data: { jobId: ctx.job.jobId, stage } })
    return { kind: 'failed', failure: runFailure(stage, null, args, end.result) }
  }
  const streams = specs.map((spec) =>
  {
    const a = sourceStream(facts, spec.audioIndex)
    const shape = outputShape(a, ctx.job.recipe)
    const dialogue = spec.dialogue ? blocks.get(`d${spec.audioIndex}`) : undefined
    const stats = classify(streamBlock(blocks, spec), streamDuration(facts, a), spec.dualMono, dialogue, spec.weights !== null)
    const toDialogue = stats.integratedLufs !== null && stats.dialogueLufs !== null
      ? Math.round((stats.integratedLufs - stats.dialogueLufs) * 100) / 100
      : null
    return { audioIndex: a.audioIndex, layout: shape.layout ?? a.layout ?? '', channels: shape.channels, sampleRate: a.sampleRate, stats, loudnessToDialogueLu: toDialogue }
  })
  ctx.deps.emit({ type: 'audio.measured', jobId: ctx.job.jobId, pass: stage === 'measure' ? 'source' : 'after-dynamics', streams })
  return { kind: 'ok', streams }
}

function endedResult(outcome: 'refused' | 'canceled' | 'failed', container: string, extra: Partial<AudioJobResult> = {}): AudioJobResult
{
  return {
    outcome, outputPath: null, encodePasses: 0, streams: [], container, dropped: [], refusals: [], failure: null, messages: [], ...extra
  }
}

function refusedResult(plan: Pick<StaticJobPlan, 'container' | 'refusals'> & Partial<StaticJobPlan>): AudioJobResult
{
  return endedResult('refused', plan.container, {
    dropped: plan.streamPlan?.dropped ?? [],
    refusals: plan.refusals,
    messages: plan.refusals.map((r) => r.message)
  })
}

/** Downmix levels read during an analysis, reused by the encode of the same analysis in this process. */
const ANALYSIS_LEVELS = new WeakMap<AudioAnalysis, ReadonlyMap<number, DownmixLevels | null>>()

/**
 * The analysis: validates the recipe again, probes when the input has no facts, plans statically (a refusal ends
 * here, with nothing spawned after the probe), reads downmix metadata, runs pass A, and pass B after dynamics.
 */
export async function analyzeAudioJob(job: AudioJobInput, deps: AudioJobDeps, signal: AbortSignal):
  Promise<{ kind: 'analysis'; analysis: AudioAnalysis } | { kind: 'ended'; result: AudioJobResult }>
{
  const ended = (result: AudioJobResult): { kind: 'ended'; result: AudioJobResult } => ({ kind: 'ended', result })
  const issues = validateAudioRecipe(job.recipe)
  if (issues.length > 0)
  {
    deps.log({ level: 'warn', message: 'Audio recipe refused', data: { jobId: job.jobId, issues: issues.map((i) => `${i.path}: ${i.message}`).join('; ') } })
    return ended(refusedResult({ container: job.output.container, refusals: [fileRefusal('invalid-recipe', job.output.container)] }))
  }
  const ctx: PassContext = { job, deps, signal, durationSec: job.facts === null ? null : knownDuration(job.facts) }
  if (signal.aborted)
  {
    return ended(endedResult('canceled', job.output.container))
  }
  let facts = job.facts
  if (facts === null)
  {
    emitStage(ctx, 'probe', null)
    let probed: ProbeJson
    try
    {
      probed = await deps.probe(job.sourcePath, signal)
    }
    catch (err)
    {
      if (signal.aborted)
      {
        return ended(endedResult('canceled', job.output.container))
      }
      deps.log({ level: 'error', message: 'Probe failed', data: { jobId: job.jobId, error: errorText(err) } })
      return ended(endedResult('failed', job.output.container, { failure: { ...runFailure('probe', null, [], null, err), argv: [] } }))
    }
    if (signal.aborted)
    {
      return ended(endedResult('canceled', job.output.container))
    }
    facts = toMediaFacts(probed, job.sourcePath)
    ctx.durationSec = knownDuration(facts)
  }
  const plan = planStatic(facts, job.recipe, deps.caps, job.output)
  deps.emit({
    type: 'audio.static-plan', jobId: job.jobId, streams: plan.streams, refusals: plan.refusals, container: plan.container,
    containerChanged: plan.containerChanged, dropped: plan.streamPlan.dropped
  })
  if (plan.refusals.length > 0)
  {
    return ended(refusedResult(plan))
  }
  emitStage(ctx, 'measure', null)
  const read = await readDownmixLevels(ctx, facts, plan, 'measure', null)
  if (read.kind !== 'ok')
  {
    return ended(abandoned(read, plan.container))
  }
  const sources = plan.streams.map((s) => sourceStream(facts, s.audioIndex))
  const specsA = sources.map((a) => measureSpecFor(facts, a, job.recipe, read.levels.get(a.audioIndex) ?? null, null))
  const passA = await measurePass(ctx, facts, 'measure', specsA)
  if (passA.kind !== 'ok')
  {
    return ended(abandoned(passA, plan.container))
  }
  let afterDynamics: StreamMeasurement[] | null = null
  const dynamics = job.recipe.kind === 'normalize' ? job.recipe.dynamics : null
  if (dynamics !== null)
  {
    const specsB = passA.streams.flatMap((m) =>
    {
      const anchored = dynamicsStage(job.recipe, m)
      return anchored === null ? [] : [measureSpecFor(facts, sourceStream(facts, m.audioIndex), job.recipe, read.levels.get(m.audioIndex) ?? null, anchored)]
    })
    if (specsB.length > 0)
    {
      emitStage(ctx, 'measure-dynamics', null)
      const passB = await measurePass(ctx, facts, 'measure-dynamics', specsB)
      if (passB.kind !== 'ok')
      {
        return ended(abandoned(passB, plan.container))
      }
      afterDynamics = passA.streams.map((m) => passB.streams.find((b) => b.audioIndex === m.audioIndex) ?? m)
    }
  }
  const analysis: AudioAnalysis = {
    cacheKey: analysisKey(job, deps.buildId, specsA),
    facts,
    source: passA.streams,
    afterDynamics,
    measuredAt: deps.now()
  }
  ANALYSIS_LEVELS.set(analysis, read.levels)
  return { kind: 'analysis', analysis }
}

/** The compressor stage of a measured stream, anchored to its pass A loudness; null without dynamics or a measurement. */
function dynamicsStage(recipe: AudioRecipe, source: StreamMeasurement | undefined): string | null
{
  if (recipe.kind !== 'normalize' || recipe.dynamics === null || source === undefined)
  {
    return null
  }
  const lufs = source.stats.integratedLufs
  return source.stats.status === 'measured' && lufs !== null ? compressorStage(recipe.dynamics, lufs) : null
}

function abandoned(end: Exclude<RunEnd, { kind: 'ok' }>, container: string, extra: Partial<AudioJobResult> = {}): AudioJobResult
{
  return end.kind === 'canceled' ? endedResult('canceled', container, extra) : endedResult('failed', container, { ...extra, failure: end.failure })
}

/** The gain plan of every stream: planNormalize or planBoost on the measurement after dynamics, else pass A. */
export function planAudioJob(analysis: AudioAnalysis, staticPlan: StaticJobPlan, recipe: AudioRecipe): GainPlan[]
{
  const measured = analysis.afterDynamics ?? analysis.source
  return staticPlan.streams.map((s) =>
  {
    const m = measured.find((x) => x.audioIndex === s.audioIndex)
    if (m === undefined)
    {
      throw new Error(`Audio stream ${s.audioIndex} has no measurement`)
    }
    if (recipe.kind === 'boost')
    {
      return planBoost(m.stats, recipe, s.ceiling, s.audioIndex)
    }
    return planNormalize(m.stats, recipe, s.ceiling, s.audioIndex, streamDuration(analysis.facts, sourceStream(analysis.facts, s.audioIndex)))
  })
}

interface EncodeLayout
{
  args: string[]
  /** Per output stream k: its verify settings without the pre-encode peak, and whether the encode metered that peak. */
  verify: Array<{ spec: Omit<VerifySpec, 'preEncodeTruePeakDbtp'>; metered: boolean }>
}

/** What one encode argv is built from. */
export interface EncodeInputs
{
  job: AudioJobInput
  facts: MediaFacts
  staticPlan: StaticJobPlan
  analysis: AudioAnalysis
  levels: ReadonlyMap<number, DownmixLevels | null>
  choices: ReadonlyMap<number, NonNullable<AudioOutput['choice']>>
  caps: BuildCapabilities
}

function planFor(plans: readonly GainPlan[], audioIndex: number): GainPlan
{
  const plan = plans.find((p) => p.audioIndex === audioIndex)
  if (plan === undefined)
  {
    throw new Error(`Audio stream ${audioIndex} has no gain plan`)
  }
  return plan
}

/** A passthrough stream whose chosen encoder keeps its codec, layout, and rate is copied instead of re-encoded. */
function copies(a: AudioFacts, choice: NonNullable<AudioOutput['choice']>, plan: GainPlan): boolean
{
  return plan.mode === 'passthrough' && codecOfEncoder(choice.encoder) === a.codecName && choice.layout === a.layout &&
    choice.sampleRate === a.sampleRate && choice.channels === a.channels
}

/** The encoder choice of every planned stream under the static plan's container. */
export function encoderChoices(facts: MediaFacts, recipe: AudioRecipe, caps: BuildCapabilities, container: string):
  Map<number, NonNullable<AudioOutput['choice']>>
{
  const choices = new Map<number, NonNullable<AudioOutput['choice']>>()
  for (const d of decide(facts, recipe, caps, container))
  {
    if (d.decision !== null && d.decision.ok)
    {
      choices.set(d.a.audioIndex, d.decision.choice)
    }
  }
  return choices
}

/**
 * The encode argv after exec's prefix: one chain per processed stream (labeled [a<k>], metered on [q<k>] for lossy
 * outputs), the explicit stream map, codec and metadata args, -f with the output container's muxer, and, when any
 * output is metered, a second output that drains the meter branches [p<k>] into the null muxer.
 */
export function buildEncodeArgs(input: EncodeInputs, plans: readonly GainPlan[], outputPath: string): EncodeLayout
{
  const { job, facts, staticPlan, analysis, levels, choices, caps } = input
  const recipe = job.recipe
  const parts: FilterPart[] = []
  const outputs: AudioOutput[] = []
  const verify: EncodeLayout['verify'] = []
  staticPlan.streams.forEach((s, k) =>
  {
    const a = sourceStream(facts, s.audioIndex)
    const choice = choices.get(s.audioIndex)
    if (choice === undefined)
    {
      throw new Error(`Audio stream ${s.audioIndex} has no encoder choice`)
    }
    const plan = planFor(plans, s.audioIndex)
    const weights = annex3Stage(choice.layout, channelsOf(choice.layout))
    const spec = {
      outIndex: k,
      sampleRate: choice.sampleRate,
      dualMono: choice.channels === 1 && recipe.mono === 'two-speakers',
      weights: weights.ok ? weights.stage : null,
      shortTerm: plan.shortTermLimitLufs !== null,
      passthrough: plan.mode === 'passthrough',
      durationSec: streamDuration(facts, a) > 0 ? streamDuration(facts, a) : null
    }
    if (copies(a, choice, plan))
    {
      outputs.push({ audioIndex: a.audioIndex, outIndex: k, label: null, choice: null })
      verify.push({ spec, metered: false })
      return
    }
    const lossy = !isLosslessEncoder(choice.encoder)
    const chain: ChainSpec = {
      inputLayout: a.layout ?? choice.layout,
      processRate: a.sampleRate,
      monoToStereo: recipe.kind === 'normalize' && recipe.monoToStereo && a.channels === 1,
      downmix: downmixOf(a, recipe),
      downmixLevels: levels.get(a.audioIndex) ?? null,
      dynamics: plan.mode === 'passthrough' ? null : dynamicsStage(recipe, analysis.source.find((m) => m.audioIndex === a.audioIndex)),
      highpassHz: recipe.kind === 'boost' ? recipe.highpassHz : 0,
      gainDb: plan.gainDb,
      limiterCeilingDbtp: plan.ceiling.limiterCeilingDbtp,
      out: { sampleRate: choice.sampleRate, layout: choice.layout, pin: choice.pin, encoder: choice.encoder },
      preEncodeMeter: lossy ? (caps.soxr ? 'soxr' : 'swr') : null
    }
    parts.push(...encodeParts(chain, `0:a:${a.audioIndex}`, k))
    outputs.push({ audioIndex: a.audioIndex, outIndex: k, label: `[a${k}]`, choice })
    verify.push({ spec, metered: lossy })
  })
  const container = containerFor(staticPlan.container)
  const streamPlan = planStreams(facts, container, outputs, AUDIO_STREAM_POLICY)
  const muxer = staticPlan.containerChanged ? (container.muxer ?? job.output.muxer) : job.output.muxer
  const args = [
    ...ENCODE_INPUT_ARGS, '-i', job.sourcePath,
    ...(parts.length > 0 ? ['-filter_complex', filterComplex(parts)] : []),
    ...streamPlan.mapArgs, ...streamPlan.codecArgs, ...streamPlan.metadataArgs,
    '-f', muxer, outputPath,
    ...meterOutputArgs(verify.filter((v) => v.metered).map((v) => v.spec.outIndex))
  ]
  return { args, verify }
}

interface PassOutput
{
  encodePass: 1 | 2
  path: string
  plans: GainPlan[]
  verified: Array<VerifiedStream | null>
  verdicts: StreamVerdict[]
  decode: { errors: string[]; count: number }
  verifyArgs: string[]
  verifyResult: ExecResult
}

type PassEnd = { kind: 'done'; pass: PassOutput } | Exclude<RunEnd, { kind: 'ok' }>

function peakNumber(text: string): number | null
{
  return NUMBER.test(text) ? Number(text) : null
}

/** One encode pass and its verification; the output path is recorded before the spawn so a stop can remove it. */
async function runPass(ctx: PassContext, input: EncodeInputs, encodePass: 1 | 2, plans: GainPlan[], written: string[]): Promise<PassEnd>
{
  const { deps, signal } = ctx
  const path = deps.output(input.staticPlan.container, encodePass)
  written.push(path)
  const layout = buildEncodeArgs(input, plans, path)
  emitStage(ctx, 'encode', encodePass)
  const peaks = new Map<number, number | null>()
  const encoded = await runOnce(ctx, 'encode', encodePass, layout.args, (line) =>
  {
    const m = PRE_ENCODE_PEAK.exec(line)
    if (m !== null)
    {
      peaks.set(Number(m[1]), peakNumber(m[2]))
    }
  }, true)
  if (encoded.kind !== 'ok')
  {
    return encoded
  }
  let bytes = 0
  try
  {
    bytes = await deps.fs.size(path)
  }
  catch
  {
    bytes = 0
  }
  if (signal.aborted)
  {
    return { kind: 'canceled' }
  }
  if (bytes <= 0)
  {
    deps.log({ level: 'error', message: 'Encode wrote an empty output', data: { jobId: ctx.job.jobId, encodePass } })
    return { kind: 'failed', failure: runFailure('encode', encodePass, layout.args, encoded.result) }
  }
  emitStage(ctx, 'verify', encodePass)
  const specs: VerifySpec[] = layout.verify.map((v) => ({ ...v.spec, preEncodeTruePeakDbtp: v.metered ? (peaks.get(v.spec.outIndex) ?? null) : null }))
  const meter = input.caps.soxr ? 'soxr' : 'swr'
  const verifyArgs = buildVerifyArgs(path, specs, meter)
  const sink = lineSink()
  const checked = await runOnce(ctx, 'verify', encodePass, verifyArgs, (line) => sink.push(line), true)
  if (checked.kind !== 'ok')
  {
    return checked
  }
  const parsed = parseVerify(sink.lines, specs, meter)
  const count = Math.max(parsed.decodeErrorCount, sink.errorCount)
  const recipe = ctx.job.recipe
  const target = recipe.kind === 'normalize' ? recipe.target : null
  const shortTermTolerance = recipe.kind === 'normalize' ? (recipe.shortForm?.rule.toleranceLu ?? 0) : 0
  const verified = input.staticPlan.streams.map((_, k) => parsed.streams.get(k) ?? null)
  const passPlans = input.staticPlan.streams.map((s) => planFor(plans, s.audioIndex))
  const verdicts = passPlans.map((plan, k) =>
    judge(plan, verified[k] ?? undefined, target, toleranceLu(target, plan.ceiling.outputClass), encodePass, count, shortTermTolerance))
  deps.emit({ type: 'audio.verified', jobId: ctx.job.jobId, encodePass, streams: verdicts.map((verdict, k) => ({ verified: verified[k], verdict })) })
  return {
    kind: 'done',
    pass: { encodePass, path, plans: passPlans, verified, verdicts, decode: { errors: sink.errors, count }, verifyArgs, verifyResult: checked.result }
  }
}

const OUTCOME_RANK: Readonly<Record<Outcome, number>> =
  { 'passthrough': 0, 'verified': 1, 'verified-below-target': 2, 'outside-tolerance': 3, 'failed': 4 }

/** A job's outcome: its worst stream's, where a passthrough stream ranks below every processed one. */
export function worstOutcome(verdicts: readonly StreamVerdict[]): Outcome
{
  return verdicts.reduce<Outcome>((worst, v) => (OUTCOME_RANK[v.outcome] > OUTCOME_RANK[worst] ? v.outcome : worst), 'passthrough')
}

/** Why a verdict takes the corrective encode, in the event's words. */
export function correctionReasons(verdict: StreamVerdict): CorrectionReason[]
{
  const reasons: CorrectionReason[] = []
  if (verdict.truePeak.status === 'over' || verdict.decoded.status === 'over')
  {
    reasons.push('true-peak-over')
  }
  if (verdict.samplePeakOver)
  {
    reasons.push('sample-overs')
  }
  if (verdict.loudness.status === 'above' || verdict.loudness.status === 'below')
  {
    reasons.push('loudness-off')
  }
  if (verdict.shortTerm.status === 'over')
  {
    reasons.push('short-term-over')
  }
  return reasons
}

function largest(values: ReadonlyArray<number | null>): number | null
{
  const known = values.filter((v): v is number => v !== null)
  return known.length === 0 ? null : Math.max(...known)
}

function largestDeviation(verdicts: readonly StreamVerdict[]): number | null
{
  let found: number | null = null
  for (const v of verdicts)
  {
    const dev = v.loudness.deviationLu
    if (dev !== null && (found === null || Math.abs(dev) > Math.abs(found)))
    {
      found = dev
    }
  }
  return found
}

/** The 'corrected' message of the first pass's verdicts: every excess that called for the corrective encode. */
export function correctedMessage(verdicts: readonly StreamVerdict[], preset: string): MessageRef
{
  const params: Record<string, number | string | null> = { preset }
  const peakOver = largest(verdicts.map((v) => (v.truePeak.status === 'over' ? v.truePeak.overDb : null)))
  const decodedOver = largest(verdicts.map((v) => (v.decoded.status === 'over' ? v.decoded.overDb : null)))
  const dev = largestDeviation(verdicts.filter((v) => v.loudness.status === 'above' || v.loudness.status === 'below'))
  const shortTermOver = largest(verdicts.map((v) => (v.shortTerm.status === 'over' && v.shortTerm.maxLufs !== null && v.shortTerm.limitLufs !== null
    ? Math.round((v.shortTerm.maxLufs - v.shortTerm.limitLufs) * 100) / 100
    : null)))
  const found: Array<[string, number | null]> = [['peakOver', peakOver], ['decodedOver', decodedOver], ['dev', dev], ['shortTermOver', shortTermOver]]
  for (const [key, value] of found)
  {
    if (value !== null)
    {
      params[key] = value
    }
  }
  if (verdicts.some((v) => v.samplePeakOver))
  {
    params.overs = 1
  }
  return { key: 'corrected', params }
}

async function removeAll(deps: AudioJobDeps, paths: readonly string[]): Promise<void>
{
  for (const path of paths)
  {
    try
    {
      await deps.fs.remove(path)
    }
    catch (err)
    {
      deps.log({ level: 'warn', message: 'Could not remove a pass output', data: { path, error: errorText(err) } })
    }
  }
}

/**
 * Encodes and verifies, with at most one corrective pass: when a verdict calls for a correction every stream is
 * re-encoded with its corrected plan, the better pass is kept, and the other pass's output is removed. On an
 * abort every pass output is removed and the result is canceled.
 */
export async function encodeAudioJob(job: AudioJobInput, staticPlan: StaticJobPlan, analysis: AudioAnalysis,
  plans: readonly GainPlan[], deps: AudioJobDeps, signal: AbortSignal): Promise<AudioJobResult>
{
  const container = staticPlan.container
  const dropped = staticPlan.streamPlan.dropped
  if (staticPlan.refusals.length > 0)
  {
    return refusedResult(staticPlan)
  }
  const ctx: PassContext = { job, deps, signal, durationSec: knownDuration(analysis.facts) }
  if (signal.aborted)
  {
    return endedResult('canceled', container, { dropped })
  }
  const facts = analysis.facts
  let levels = ANALYSIS_LEVELS.get(analysis)
  if (levels === undefined)
  {
    const read = await readDownmixLevels(ctx, facts, staticPlan, 'encode', 1)
    if (read.kind !== 'ok')
    {
      return abandoned(read, container, { dropped })
    }
    levels = read.levels
  }
  const notes = [...staticPlan.notes, ...chainNotes(facts, staticPlan, job.recipe, levels)]
  const ordered = staticPlan.streams.map((s) => planFor(plans, s.audioIndex))
  deps.emit({ type: 'audio.planned', jobId: job.jobId, plans: ordered, notes })
  const choices = encoderChoices(facts, job.recipe, deps.caps, container)
  const input: EncodeInputs = { job, facts, staticPlan, analysis, levels, choices, caps: deps.caps }
  const written: string[] = []
  const messages: MessageRef[] = [...notes.map((n) => n.message), ...(deps.caps.soxr ? [] : [{ key: 'meter-swr' as const, params: {} }])]
  const first = await runPass(ctx, input, 1, ordered, written)
  if (first.kind !== 'done')
  {
    await removeAll(deps, written)
    return abandoned(first, container, { dropped, encodePasses: 1, messages })
  }
  const policy = job.recipe.kind === 'normalize' ? job.recipe.policy : 'peak-limit'
  const corrected = first.pass.plans.map((plan, k) =>
  {
    const v = first.pass.verified[k]
    return v === null ? null : correctedPlan(plan, first.pass.verdicts[k], v, policy)
  })
  if (worstOutcome(first.pass.verdicts) === 'failed' || corrected.every((c) => c === null))
  {
    return finish(deps, job, staticPlan, analysis, first.pass, 1, messages, written)
  }
  const needing = first.pass.verdicts.filter((_, k) => corrected[k] !== null)
  deps.emit({
    type: 'audio.correcting',
    jobId: job.jobId,
    reasons: [...new Set(needing.flatMap(correctionReasons))],
    adjustments: corrected.flatMap((c) => (c === null ? [] : [{ audioIndex: c.audioIndex, gainDb: c.gainDb, limiterCeilingDbtp: c.ceiling.limiterCeilingDbtp }]))
  })
  deps.log({ level: 'info', message: 'Corrective encode', data: { jobId: job.jobId, streams: needing.length } })
  const second = await runPass(ctx, input, 2, first.pass.plans.map((plan, k) => corrected[k] ?? plan), written)
  if (second.kind === 'canceled')
  {
    await removeAll(deps, written)
    return endedResult('canceled', container, { dropped, encodePasses: 2, messages })
  }
  const keep = second.kind === 'failed' ? 'first' : better(first.pass.verdicts, second.pass.verdicts)
  if (second.kind === 'failed')
  {
    deps.log({ level: 'warn', message: 'Corrective encode failed; keeping the first encode', data: { jobId: job.jobId, code: second.failure.exitCode } })
  }
  const kept = keep === 'second' && second.kind === 'done' ? second.pass : first.pass
  await removeAll(deps, written.filter((path) => path !== kept.path))
  if (signal.aborted)
  {
    await removeAll(deps, [kept.path])
    return endedResult('canceled', container, { dropped, encodePasses: 2, messages })
  }
  const preset = job.recipe.presetId
  if (second.kind === 'done')
  {
    messages.push(keep === 'second'
      ? correctedMessage(first.pass.verdicts, preset)
      : { key: 'kept-first', params: { dev2: largestDeviation(second.pass.verdicts), preset } })
  }
  return finish(deps, job, staticPlan, analysis, kept, 2, messages, [kept.path])
}

/** The result of the kept pass; a failed verification removes its output and fills the failure. */
async function finish(deps: AudioJobDeps, job: AudioJobInput, staticPlan: StaticJobPlan, analysis: AudioAnalysis, pass: PassOutput,
  encodePasses: 1 | 2, messages: MessageRef[], written: readonly string[]): Promise<AudioJobResult>
{
  const outcome = worstOutcome(pass.verdicts)
  const streams = staticPlan.streams.map((s, k) =>
  {
    const before = analysis.source.find((m) => m.audioIndex === s.audioIndex)
    if (before === undefined)
    {
      throw new Error(`Audio stream ${s.audioIndex} has no measurement`)
    }
    return { before, plan: pass.plans[k], after: pass.verified[k], verdict: pass.verdicts[k] }
  })
  const base = { encodePasses, streams, container: staticPlan.container, dropped: staticPlan.streamPlan.dropped, refusals: [] }
  if (outcome === 'failed')
  {
    await removeAll(deps, written)
    const failure = runFailure('verify', pass.encodePass, pass.verifyArgs, pass.verifyResult, null, pass.decode)
    const decodeMessage: MessageRef[] = pass.decode.errors.length > 0 ? [{ key: 'decode-errors', params: { error: pass.decode.errors[0] } }] : []
    deps.log({ level: 'error', message: 'Verification failed', data: { jobId: job.jobId, decodeErrors: pass.decode.count } })
    return { ...base, outcome, outputPath: null, failure, messages: [...messages, ...decodeMessage] }
  }
  const night: MessageRef[] = job.recipe.kind === 'normalize' && job.recipe.presetId === 'night' && streams.length > 0
    ? [{ key: 'night', params: { LRA_in: streams[0].before.stats.loudnessRangeLu, LRA_out: streams[0].after?.loudnessRangeLu ?? null } }]
    : []
  return { ...base, outcome, outputPath: pass.path, failure: null, messages: [...messages, ...night] }
}

/** A job outside an album group: the analysis (with its static plan), the gain plans, then the encode. */
export async function runAudioJob(job: AudioJobInput, deps: AudioJobDeps, signal: AbortSignal): Promise<AudioJobResult>
{
  const analyzed = await analyzeAudioJob(job, deps, signal)
  if (analyzed.kind === 'ended')
  {
    return analyzed.result
  }
  const staticPlan = planStatic(analyzed.analysis.facts, job.recipe, deps.caps, job.output)
  const plans = planAudioJob(analyzed.analysis, staticPlan, job.recipe)
  return encodeAudioJob(job, staticPlan, analyzed.analysis, plans, deps, signal)
}
