/**
 * The preflight planner: per job, the source checks, the container decision, the output path from the template,
 * the runner's static plan, and the GPU choice; then the batch rules (replace, collisions, reserved paths, the
 * conflict rule against the disk), the destination folders, the volumes with their free space and bins, the album
 * rules, and the report. Every read goes through `PlannerIO`, every per-job plan through `runner.plan`, and every
 * message is final display text. Measurements are never plan inputs.
 */

import type { MediaFacts, OutputCodec } from '../../shared/audio/types'
import { codecLabel } from '../../shared/audio/messages'
import { applicabilityIssues, factsFromProbe, outputChannels } from '../../shared/jobs/applicability'
import { audioCodecLabel, containerLabel, videoEncoderLabel } from '../../shared/jobs/describe'
import type { JobId } from '../../shared/jobs/ids'
import { compressContainer, VIDEO_CODEC_IDS, videoCodecName, videoEncoderFit } from '../../shared/jobs/muxing'
import type { MuxBuild } from '../../shared/jobs/muxing'
import { VIDEO_ENCODERS } from '../../shared/jobs/recipes'
import type { AudioOut, Recipe, VideoEncoder } from '../../shared/jobs/recipes'
import { renderTemplate, stemOf, templateValues } from '../../shared/jobs/template'
import type {
  BatchPolicy, CapabilitySummary, JobPlan, OutputPlan, PlanFix, PlanIssue, PlanIssueCode, PlanSummary, PreflightReport,
  SourceRef, VideoPlan, VolumeReport, WorkersState
} from '../../shared/jobs/types'
import { binPhrase } from '../../shared/text/platform'
import type { Platform } from '../../shared/text/platform'
import { canonicalAudioContainer, containerFor, VIDEO_FALLBACK_CONTAINER } from '../ffmpeg/audio/containers'
import { chooseEncoder } from '../ffmpeg/audio/encoders'
import type { BuildCapabilities } from '../ffmpeg/audio/encoders'
import type { FileStat, PlannerIO, VolumeInfo } from './deps'
import { displacedPath, exceedsPathLimit, numberedName, partOutputName, pathApi, pathKey, RENAME_FIRST, RENAME_LAST, workDirPath } from './naming'
import type { JobRunner, RunnerPlan } from './runners/types'
import { trashTooSmall, volumeKey as rootKey, volumeLabel, volumeRoot, volumeStatus } from './volumes'

/** The probe a job's plan is made from; the engine waits for the probe queue before it plans. */
export type ProbeOutcome =
  | { status: 'ok'; facts: MediaFacts }
  | { status: 'failed'; reason: string }
  | { status: 'pending' }

/** A job this report plans, in queue order. */
export interface PlanJob
{
  id: JobId
  inputsRev: number
  source: SourceRef
  recipe: Recipe
  probe: ProbeOutcome
}

/** A non-terminal job outside this report: its source, and the final path its plan reserves while queued, active, or held. */
export interface OtherJob
{
  id: JobId
  sourcePath: string
  reservedPath: string | null
}

/** An album group with every member still in the queue, inside this report or not. */
export interface AlbumGroup
{
  groupId: string
  jobIds: readonly JobId[]
}

/** What the planner knows of FFmpeg and the machine. */
export interface PlannerCapabilities
{
  summary: CapabilitySummary
  build: BuildCapabilities
  /** The minimum FFmpeg version as messages name it ("5.1"). */
  minimumVersion: string
}

/** Everything one preflight plans from, captured when it starts. */
export interface PreflightInput
{
  preflightId: string
  createdAt: number
  platform: Platform
  policy: BatchPolicy
  capabilities: PlannerCapabilities
  jobs: readonly PlanJob[]
  others: readonly OtherJob[]
  albums: readonly AlbumGroup[]
  limits: WorkersState['limits']
  /** The {date} value: the run's start date, or today's in previews. */
  date: string
}

/** One runner per recipe kind. */
export type RunnerSet = { readonly [K in Recipe['kind']]: JobRunner<Extract<Recipe, { kind: K }>> }

/** The planner's reads and the runners it asks for static plans. */
export interface PlannerDeps
{
  io: PlannerIO
  runners: RunnerSet
  /** The key volumes are grouped by, such as `VolumeRegistry.key`; defaults to the volume root of the path. */
  volumeKey?: (path: string) => Promise<string>
}

/** A report and the row summary of every job it covers. */
export interface PreflightResult
{
  report: PreflightReport
  summaries: Array<{ jobId: JobId; summary: PlanSummary }>
}

type ReportEntry = PreflightReport['jobs'][number]

/** How much more a normalize or gain job may write than its output while a corrective encode holds two outputs. */
export const CORRECTIVE_FACTOR = 2

const SEVERITY_RANK: Readonly<Record<PlanIssue['severity'], number>> = { error: 0, warning: 1, info: 2 }

const EXAMPLE_FOLDERS: Readonly<Record<Platform, string>> = { win32: 'D:\\Exports', darwin: '/Users/you/Exports', linux: '/home/you/Exports' }

const GPU_NAMES: Readonly<Record<string, string>> = { nvidia: 'NVENC', intel: 'Quick Sync', amd: 'AMF' }
const GPU_SUFFIXES: Readonly<Record<string, string>> = { nvidia: 'nvenc', intel: 'qsv', amd: 'amf' }
const GPU_CODECS: Readonly<Record<string, { prefix: string; label: string }>> =
{
  libx264: { prefix: 'h264', label: 'H.264' },
  libx265: { prefix: 'hevc', label: 'HEVC' }
}

const AUDIO_ENCODERS: Readonly<Record<OutputCodec, string>> =
{
  aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', flac: 'flac', alac: 'alac', ac3: 'ac3', eac3: 'eac3', pcm: 'pcm_s16le', wmav2: 'wmav2'
}
const AUDIO_FIX_ORDER: readonly OutputCodec[] = ['aac', 'opus', 'mp3', 'vorbis', 'ac3', 'flac', 'wmav2']
const VIDEO_ALTERNATIVES: readonly string[] = ['mp4', 'mov', 'mkv', 'webm', 'ogv', 'avi']
const SUBTITLE_MUXERS: Readonly<Record<string, string>> = { srt: 'srt', vtt: 'webvtt', ass: 'ass' }
/** Muxers of video containers the audio container table has no row for; FFmpeg names them by these. */
const VIDEO_ONLY_MUXERS: Readonly<Record<string, string>> = { flv: 'flv', ogv: 'ogv', mpg: 'mpeg', mpeg: 'mpeg', vob: 'vob', f4v: 'f4v', '3gp': '3gp' }

/** Builds a plan issue. */
export function planIssue(code: PlanIssueCode, severity: PlanIssue['severity'], message: string, field: PlanIssue['field'], fix: PlanFix | null = null): PlanIssue
{
  return { code, severity, message, field, fix }
}

/** One issue per fix, all with the same code and message, so the page shows every fix beside one reason; none gives one issue without a fix. */
export function withFixes(code: PlanIssueCode, severity: PlanIssue['severity'], message: string, field: PlanIssue['field'], fixes: readonly PlanFix[]): PlanIssue[]
{
  return fixes.length === 0 ? [planIssue(code, severity, message, field)] : fixes.map((fix) => planIssue(code, severity, message, field, fix))
}

/** A byte count as the report states it, in decimal units: "9.4 GB", "41 GB", "512 KB". */
export function formatSize(bytes: number): string
{
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < units.length - 1)
  {
    value /= 1000
    unit += 1
  }
  if (unit === 0)
  {
    return `${Math.round(value)} bytes`
  }
  const shown = value < 9.95 ? (Math.round(value * 10) / 10).toString() : Math.round(value).toString()
  return `${shown} ${units[unit]}`
}

function joinWords(words: readonly string[]): string
{
  if (words.length <= 1)
  {
    return words.join('')
  }
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

/** The planner's sentences, in the words the Review page shows verbatim. */
export const planText =
{
  sourceMissing: (path: string): string => `The file is no longer at ${path}.`,
  sourceUnreadable: (name: string, reason: string): string => `molexMedia cannot read ${name}: ${reason}.`,
  sourceChanged: (name: string): string => `${name} changed after Review; review it again before it runs.`,
  notMedia: (name: string): string => `${name} has no audio or video streams.`,
  probeFailed: (name: string, reason: string): string => `Could not read the streams of ${name}: ${reason}.`,
  invalidRecipe: (name: string, reason: string): string => `molexMedia cannot plan ${name}: ${reason}.`,
  destinationInvalid: (platform: Platform): string => `The output folder must be a full path, like ${EXAMPLE_FOLDERS[platform]}.`,
  destinationNotWritable: (folder: string, reason: string): string => `molexMedia cannot write to ${folder}: ${reason}.`,
  pathLong: (length: number): string => `The output path is ${length} characters; some programs cannot open paths over 260.`,
  outputSkipped: (name: string): string => `${name} exists; it will be skipped (rule: skip).`,
  outputRenamed: (name: string, renamed: string): string => `${name} exists; this job writes ${renamed}.`,
  outputTrashed: (name: string, bin: string): string => `${name} exists; it goes to ${bin} after this output verifies.`,
  outputKept: (name: string, kept: string): string => `${name} exists; it is renamed to ${kept} after this output verifies.`,
  collision: (first: string, later: string, name: string): string => `${first} and ${later} would both write ${name}.`,
  sameAsSource: (): string => 'This output would overwrite its own source.',
  overwritesAnotherSource: (other: string): string => `This output would overwrite the source of ${other}.`,
  pendingOutput: (other: string): string => `Run ${other} first; chained jobs are not supported.`,
  renameExhausted: (name: string): string => `Every numbered name for ${name} up to (9999) is taken.`,
  replaceExtension: (oldName: string, newName: string): string => `${oldName} will be replaced by ${newName}.`,
  extractNeverReplaces: (): string => 'Extract jobs never replace originals; this one writes beside its source.',
  replaceOnePerSource: (): string => 'Two jobs on one source cannot both replace it.',
  noRecycleBin: (volume: string): string =>
    `${volume} has no Recycle Bin. Originals replaced there stay beside their outputs as name (original).ext, and replaced files as name (previous).ext.`,
  trashTooSmall: (drive: string, room: number, need: number, what: 'originals' | 'both' | 'existing'): string =>
  {
    const files = what === 'originals' ? 'originals' : what === 'both' ? 'originals and existing files' : 'existing files'
    return `The Recycle Bin on ${drive} has room for about ${formatSize(room)}. Replacing ${formatSize(need)} of ${files} would make Windows permanently delete older Recycle Bin items, including originals from this batch.`
  },
  trashUnreadable: (drive: string, need: number): string =>
    `molexMedia cannot read how much room the Recycle Bin on ${drive} has, and this batch would send ${formatSize(need)} there, more than 5 percent of the drive.`,
  ffmpegRequired: (minimum: string, found: string | null): string => `FFmpeg ${minimum} or newer is required; found ${found ?? 'none'}.`,
  selfTestFailed: (version: string | null): string => `${version === null ? 'FFmpeg' : `FFmpeg ${version}`} failed its self-test; repair it in Settings.`,
  encoderMissing: (encoder: string): string => `This FFmpeg has no ${encoder} encoder.`,
  gpuMissing: (): string => 'GPU encoding is required, but no GPU encoder was found.',
  gpuCannotEncode: (gpu: string, codec: string): string => `${gpu} cannot encode ${codec}; GPU encoding is required for this batch.`,
  gpuNotUsed: (codec: string, cpu: string): string => `No GPU encoder for ${codec}; this job uses ${cpu}.`,
  gpuLossless: (gpu: string, cpu: string): string => `${gpu} cannot encode lossless; this job uses ${cpu}.`,
  gpuLosslessRequired: (gpu: string): string => `${gpu} cannot encode lossless; GPU encoding is required for this batch.`,
  gpuDowngrade: (changes: readonly string[]): string => `On the GPU, ${changes.length > 1 ? `${changes.slice(0, -1).join(', ')} and ${changes[changes.length - 1]}` : changes[0]}.`,
  losslessUnsupported: (): string => 'SVT-AV1 has no lossless mode.',
  tuneUnsupported: (tune: string): string => `x265 has no ${tune} tune; choose another tune or none.`,
  containerCannotHold: (container: string, codec: string, alternatives: readonly string[]): string =>
    `${containerLabel(container)} cannot hold ${codec}; choose ${joinWords(alternatives.map(containerLabel))}.`,
  noMuxer: (container: string): string => `FFmpeg cannot write ${containerLabel(container)} files.`,
  containerChanged: (codec: string, from: string, to: string): string => `${codec} cannot be stored in .${from}; the output is .${to}.`,
  diskSpace: (need: number, drive: string, free: number): string => `About ${formatSize(need)} to write to ${drive}, ${formatSize(free)} free.`,
  albumMismatch: (): string => 'Album members must share a target and output layout.',
  albumIncomplete: (group: string, total: number, here: number): string =>
    `Album ${group} has ${total} tracks; ${here} ${here === 1 ? 'is' : 'are'} in this start. Start all ${total}, or take the others out of the album.`
}

function videoPlanKey(plan: VideoPlan | null): unknown
{
  return plan === null ? null : [plan.encoder, plan.gpu, plan.lossless, plan.passes, plan.filters]
}

/**
 * The canonical string of what neither a source change at dispatch nor a retry may change silently: the final path,
 * resolution, displaced path, container, muxer, the encoders with the CPU fallback, the stream plan, and the class.
 */
export function planFingerprint(plan: Omit<JobPlan, 'fingerprint'>): string
{
  return JSON.stringify({
    path: plan.output.finalPath,
    kind: plan.output.kind,
    resolution: plan.output.resolution,
    displaces: plan.output.displaces,
    container: plan.output.container,
    muxer: plan.output.muxer,
    video: plan.video === null ? null : videoPlanKey(plan.video),
    fallback: plan.video === null ? null : videoPlanKey(plan.video.cpuFallback),
    audio: plan.audio.map((a) => [a.audioIndex, a.encoder, a.bitrateKbps, a.outputLayout, a.outputRate]),
    streams: plan.streams,
    class: plan.class
  })
}

function gpuEncoderLabel(encoder: string): string | null
{
  const match = /^(h264|hevc)_(nvenc|qsv|amf)$/.exec(encoder)
  if (match === null)
  {
    return null
  }
  const vendor = Object.keys(GPU_SUFFIXES).find((key) => GPU_SUFFIXES[key] === match[2]) as string
  return `${GPU_NAMES[vendor]} ${match[1] === 'h264' ? 'H.264' : 'HEVC'}`
}

/** The encoder that will run, in the page's short form: "x264 2-pass", "NVENC H.264", "AAC 256k", "PCM 24-bit", "copy". */
export function encoderLabel(plan: Pick<JobPlan, 'video' | 'audio' | 'class' | 'output'>): string
{
  const video = plan.video
  if (video !== null && video.encoder !== 'copy')
  {
    const name = (VIDEO_ENCODERS as readonly string[]).includes(video.encoder)
      ? videoEncoderLabel(video.encoder as VideoEncoder)
      : gpuEncoderLabel(video.encoder) ?? video.encoder
    return video.passes === 2 ? `${name} 2-pass` : name
  }
  const first = plan.audio[0]
  if (first !== undefined)
  {
    if (first.bitrateKbps !== null)
    {
      return `${codecLabel(first.encoder)} ${first.bitrateKbps}k`
    }
    return first.bitsPerSample !== null ? `${codecLabel(first.encoder)} ${first.bitsPerSample}-bit` : codecLabel(first.encoder)
  }
  if (plan.class === 'copy' || video !== null)
  {
    return 'copy'
  }
  return containerLabel(plan.output.container)
}

function distinctBySeverity(issues: readonly PlanIssue[], severity: PlanIssue['severity']): number
{
  return new Set(issues.filter((issue) => issue.severity === severity).map((issue) => `${issue.code}\n${issue.message}`)).size
}

/** A job's most severe issue: the first error, else the first warning, else the first note. */
export function firstIssue(issues: readonly PlanIssue[]): PlanIssue | null
{
  let best: PlanIssue | null = null
  for (const issue of issues)
  {
    if (best === null || SEVERITY_RANK[issue.severity] < SEVERITY_RANK[best.severity])
    {
      best = issue
    }
  }
  return best
}

/**
 * What a row prints of its report entry: the final name, the path relative to `base` (the destination folder, or
 * the source's folder), the encoder label, the counts of distinct errors and warnings, and the most severe issue.
 */
export function planSummary(entry: ReportEntry, base: string | null, platform: Platform): PlanSummary
{
  const paths = pathApi(platform)
  const plan = entry.plan
  const top = firstIssue(entry.issues)
  const finalPath = plan?.output.finalPath ?? ''
  return {
    status: entry.status,
    current: true,
    finalName: finalPath === '' ? '' : paths.basename(finalPath),
    relativePath: finalPath === '' ? '' : base === null ? paths.basename(finalPath) : paths.relative(base, finalPath),
    container: plan?.output.container ?? '',
    resolution: plan?.output.resolution ?? 'place',
    encoderLabel: plan === null ? '' : encoderLabel(plan),
    errors: distinctBySeverity(entry.issues, 'error'),
    warnings: distinctBySeverity(entry.issues, 'warning'),
    firstIssue: top === null ? null : { code: top.code, severity: top.severity, message: top.message }
  }
}

/**
 * The space a job keeps free while it runs: its output estimate, doubled for normalize and gain because a corrective
 * encode can briefly hold two outputs; the source size stands in when the output cannot be estimated.
 */
export function reserveBytes(kind: Recipe['kind'], outputBytes: number | null, sourceBytes: number): number
{
  const base = outputBytes !== null && Number.isFinite(outputBytes) ? Math.max(0, outputBytes) : Math.max(0, sourceBytes)
  return Math.ceil(kind === 'normalize' || kind === 'boost' ? base * CORRECTIVE_FACTOR : base)
}

/** The jobs a fix applies to: every job for a batch fix, else exactly the jobs whose issues carry it. */
export function fixTargets(report: Pick<PreflightReport, 'jobs'>, fix: PlanFix): JobId[]
{
  if (fix.scope === 'batch')
  {
    return report.jobs.map((entry) => entry.jobId)
  }
  const wanted = JSON.stringify(fix)
  return report.jobs.filter((entry) => entry.issues.some((issue) => issue.fix !== null && JSON.stringify(issue.fix) === wanted)).map((entry) => entry.jobId)
}

/** The container an output is written in, its muxer, and why it moved from the one asked for. */
export interface ContainerDecision
{
  kind: 'file' | 'folder'
  container: string
  muxer: string
  changed: { from: string; reason: string } | null
  issues: PlanIssue[]
}

/** The FFmpeg muxer for an output extension: the container table's, else FFmpeg's name for a video or subtitle format; null when none. */
export function muxerFor(container: string): string | null
{
  const row = containerFor(container)
  if (row.muxer !== null)
  {
    return row.muxer
  }
  if (Object.hasOwn(VIDEO_ONLY_MUXERS, row.name))
  {
    return VIDEO_ONLY_MUXERS[row.name]
  }
  return Object.hasOwn(SUBTITLE_MUXERS, row.name) ? SUBTITLE_MUXERS[row.name] : null
}

function extensionOf(value: string): string
{
  return value.replace(/^\./, '').toLowerCase()
}

function realVideo(facts: MediaFacts): MediaFacts['video']
{
  return facts.video.filter((stream) => !stream.cover)
}

function encoderUsable(encoder: string, caps: BuildCapabilities): boolean
{
  return caps.encoders.has(encoder) && !caps.experimental.has(encoder)
}

function holdsAudio(container: string, codec: OutputCodec): boolean
{
  const encoders = containerFor(container).audioEncoders
  return codec === 'pcm' ? [...encoders].some((encoder) => encoder.startsWith('pcm_')) : encoders.has(AUDIO_ENCODERS[codec])
}

function videoAlternatives(current: string, holds: (container: string) => boolean): string[]
{
  const first = VIDEO_ALTERNATIVES.find((container) => container !== current && container !== VIDEO_FALLBACK_CONTAINER && holds(container))
  return first === undefined ? [VIDEO_FALLBACK_CONTAINER] : [first, VIDEO_FALLBACK_CONTAINER]
}

function setContainer(container: string): PlanFix
{
  return { kind: 'set-container', container, scope: 'jobs' }
}

function audioCodecFix(container: string, out: AudioOut, caps: BuildCapabilities): PlanFix | null
{
  const kbpsPerPair = out.kind === 'codec' ? out.kbpsPerPair : null
  const codec = AUDIO_FIX_ORDER.find((candidate) => holdsAudio(container, candidate) && encoderUsable(AUDIO_ENCODERS[candidate], caps))
  if (codec === undefined)
  {
    return null
  }
  return { kind: 'patch-recipe', label: `Use ${audioCodecLabel(codec)} audio`, patch: { field: 'audio', value: { kind: 'codec', codec, kbpsPerPair } }, scope: 'jobs' }
}

function copiedEncoder(codec: string): VideoEncoder | undefined
{
  return VIDEO_ENCODERS.find((candidate) => VIDEO_CODEC_IDS[candidate] === codec.toLowerCase())
}

/** The fit of a video encode or copy in a container, as blocking issues naming the containers that would hold it. */
function videoFitIssues(container: string, encoders: readonly VideoEncoder[], audio: OutputCodec | null, build: MuxBuild): PlanIssue[]
{
  const issues: PlanIssue[] = []
  for (const encoder of encoders)
  {
    const fit = videoEncoderFit(encoder, container, build)
    if (fit === null || fit.ok)
    {
      continue
    }
    const alternatives = videoAlternatives(container, (candidate) =>
      (videoEncoderFit(encoder, candidate, build)?.ok ?? false) && (audio === null || holdsAudio(candidate, audio)))
    const message = fit.status === 'no-muxer' ? planText.noMuxer(container) : planText.containerCannotHold(container, videoCodecName(encoder), alternatives)
    issues.push(planIssue('container-cannot-hold', 'error', message, 'container', setContainer(VIDEO_FALLBACK_CONTAINER)))
  }
  return issues
}

/** The encoders that write the copied video streams the table knows. */
function copiedEncoders(facts: MediaFacts): VideoEncoder[]
{
  return realVideo(facts).map((stream) => copiedEncoder(stream.codecName)).filter((encoder): encoder is VideoEncoder => encoder !== undefined)
}

/** Whether the audio container table has a row for the container; outside it the audio fit cannot be judged, so it is not refused. */
function judgesAudio(container: string): boolean
{
  return containerFor(container).muxer !== null
}

/**
 * A chosen audio codec the output container cannot hold, as blocking issues with the container and codec fixes.
 * `video` lists the encoders of a video output, whose alternatives must hold the video too; null for audio only.
 */
function audioFitIssues(container: string, out: AudioOut, facts: MediaFacts, video: readonly VideoEncoder[] | null, caps: BuildCapabilities, build: MuxBuild): PlanIssue[]
{
  if (out.kind !== 'codec' || facts.audio.length === 0 || !judgesAudio(container) || holdsAudio(container, out.codec))
  {
    return []
  }
  const encoder = AUDIO_ENCODERS[out.codec]
  const holdsVideo = (candidate: string): boolean => (video ?? []).every((e) => videoEncoderFit(e, candidate, build)?.ok ?? false)
  const alternatives = video !== null
    ? videoAlternatives(container, (candidate) => holdsAudio(candidate, out.codec) && holdsVideo(candidate))
    : [...new Set([canonicalAudioContainer(encoder), 'mka'])].filter((candidate) => candidate !== container)
  const message = planText.containerCannotHold(container, audioCodecLabel(out.codec), alternatives)
  const fixes: PlanFix[] = [setContainer(video !== null ? VIDEO_FALLBACK_CONTAINER : alternatives[0])]
  const codecFix = audioCodecFix(container, out, caps)
  if (codecFix !== null)
  {
    fixes.push(codecFix)
  }
  return withFixes('container-cannot-hold', 'error', message, 'container', fixes)
}

function encoderIssues(encoder: VideoEncoder, caps: BuildCapabilities, patchable: boolean): PlanIssue[]
{
  if (encoderUsable(encoder, caps))
  {
    return []
  }
  const alternative = (['libx264', 'libx265', 'libvpx-vp9'] as const).find((candidate) => candidate !== encoder && encoderUsable(candidate, caps))
  const fix: PlanFix | null = alternative === undefined || !patchable
    ? null
    : { kind: 'patch-recipe', label: `Use ${videoEncoderLabel(alternative)}`, patch: { field: 'video-encoder', value: alternative }, scope: 'jobs' }
  return [planIssue('encoder-missing', 'error', planText.encoderMissing(encoder), 'encoder', fix)]
}

function decided(container: string, issues: PlanIssue[], changed: ContainerDecision['changed'] = null, kind: ContainerDecision['kind'] = 'file'): ContainerDecision
{
  const muxer = kind === 'folder' ? 'image2' : muxerFor(container)
  if (muxer === null)
  {
    const blocked = planIssue('container-cannot-hold', 'error', planText.noMuxer(container), 'container', setContainer(VIDEO_FALLBACK_CONTAINER))
    return { kind, container, muxer: container, changed, issues: [...issues, blocked] }
  }
  return { kind, container, muxer, changed, issues }
}

function audioJobContainer(recipe: Extract<Recipe, { kind: 'normalize' | 'boost' }>, facts: MediaFacts, from: string, caps: BuildCapabilities): ContainerDecision
{
  const video = realVideo(facts).length > 0
  for (const a of facts.audio)
  {
    const channels = outputChannels(recipe, a.channels)
    const layout = channels === a.channels ? a.layout ?? '' : channels === 1 ? 'mono' : 'stereo'
    const decision = chooseEncoder(a, recipe.output, from, { channels, layout, minSampleRate: null, video }, caps)
    if (decision.ok && decision.containerChanged)
    {
      const reason = planText.containerChanged(codecLabel(decision.choice.encoder), from, decision.container)
      return decided(decision.container, [planIssue('container-changed', 'info', reason, 'container')], { from, reason })
    }
  }
  return decided(from, [])
}

function compressDecision(recipe: Extract<Recipe, { kind: 'compress' }>, facts: MediaFacts, from: string, caps: BuildCapabilities, build: MuxBuild): ContainerDecision
{
  const issues = encoderIssues(recipe.encoder, caps, false)
  const audio = recipe.audio.kind === 'codec' && facts.audio.length > 0 ? recipe.audio.codec : null
  if (recipe.container !== 'source')
  {
    const container = extensionOf(recipe.container)
    issues.push(...videoFitIssues(container, [recipe.encoder], audio, build), ...audioFitIssues(container, recipe.audio, facts, [recipe.encoder], caps, build))
    return decided(container, issues)
  }
  let container = compressContainer(from, recipe.encoder, build)
  let codec = videoCodecName(recipe.encoder)
  if (container === from && audio !== null && judgesAudio(from) && !holdsAudio(from, audio))
  {
    container = VIDEO_FALLBACK_CONTAINER
    codec = audioCodecLabel(audio)
  }
  if (container === from)
  {
    return decided(from, issues)
  }
  const reason = planText.containerChanged(codec, from, container)
  return decided(container, [...issues, planIssue('container-changed', 'info', reason, 'container')], { from, reason })
}

function extractDecision(recipe: Extract<Recipe, { kind: 'extract' }>, facts: MediaFacts, caps: BuildCapabilities, build: MuxBuild): ContainerDecision
{
  switch (recipe.mode)
  {
    case 'audio':
    {
      const container = extensionOf(recipe.container)
      return decided(container, audioFitIssues(container, recipe.audio, facts, null, caps, build))
    }
    case 'video':
    {
      const container = extensionOf(recipe.container)
      if (recipe.reencode !== null)
      {
        const encoder = recipe.reencode.encoder
        return decided(container, [...encoderIssues(encoder, caps, false), ...videoFitIssues(container, [encoder], null, build)])
      }
      return decided(container, videoFitIssues(container, copiedEncoders(facts), null, build))
    }
    case 'gif':
      return decided('gif', [])
    case 'frames':
      return decided(recipe.format, [], null, 'folder')
    default:
      return decided(recipe.format, [])
  }
}

/**
 * The output container of a job and the capability checks that decide it: Normalize and Gain keep the source
 * container unless the chosen audio encoder needs another (a note); Convert writes the container the user picked and
 * blocks, with fixes, when it cannot hold the video or audio; Compress keeps the source container when it holds the
 * encode and otherwise moves to .mkv with a note; Extract writes its mode's format, frames into a folder.
 */
export function decideContainer(recipe: Recipe, source: SourceRef, facts: MediaFacts, caps: BuildCapabilities, build: MuxBuild): ContainerDecision
{
  const from = extensionOf(facts.container !== '' ? facts.container : source.ext)
  switch (recipe.kind)
  {
    case 'normalize':
    case 'boost':
      return audioJobContainer(recipe, facts, from, caps)
    case 'convert':
    {
      const container = extensionOf(recipe.container)
      const video = recipe.video
      const issues: PlanIssue[] = video !== null && video.encoder !== 'copy' ? encoderIssues(video.encoder, caps, true) : []
      const encoders = video !== null && realVideo(facts).length > 0 ? (video.encoder === 'copy' ? copiedEncoders(facts) : [video.encoder]) : null
      if (encoders !== null)
      {
        const audio = recipe.audio.kind === 'codec' && facts.audio.length > 0 ? recipe.audio.codec : null
        issues.push(...videoFitIssues(container, encoders, audio, build))
      }
      issues.push(...audioFitIssues(container, recipe.audio, facts, encoders, caps, build))
      return decided(container, issues)
    }
    case 'compress':
      return compressDecision(recipe, facts, from, caps, build)
    default:
      return extractDecision(recipe, facts, caps, build)
  }
}

/** The checks of the FFmpeg install that block every job: present, at or above the minimum, and its self-test passed. */
export function ffmpegIssues(capabilities: PlannerCapabilities): PlanIssue[]
{
  const ffmpeg = capabilities.summary.ffmpeg
  if (!ffmpeg.ready)
  {
    return [planIssue('ffmpeg-unavailable', 'error', planText.ffmpegRequired(capabilities.minimumVersion, ffmpeg.version), 'encoder')]
  }
  if (!ffmpeg.meetsMinimum)
  {
    return [planIssue('ffmpeg-below-minimum', 'error', planText.ffmpegRequired(capabilities.minimumVersion, ffmpeg.version), 'encoder')]
  }
  return ffmpeg.selfTest === 'failed' ? [planIssue('self-test-failed', 'error', planText.selfTestFailed(ffmpeg.version), 'encoder')] : []
}

/** A video plan moved to the GPU, or kept on the CPU, with the notes the policy calls for. */
export interface GpuOutcome
{
  video: JobPlan['video']
  class: JobPlan['class']
  issues: PlanIssue[]
}

function gpuChanges(recipe: Recipe, cpu: VideoPlan): string[]
{
  const changes: string[] = []
  if (cpu.passes === 2)
  {
    changes.push('two-pass runs as one pass')
  }
  if (recipe.kind === 'compress')
  {
    if (recipe.target.mode === 'crf')
    {
      changes.push(`CRF ${recipe.target.crf} becomes QP ${recipe.target.crf}`)
    }
    else if (recipe.target.mode === 'quality')
    {
      changes.push(`the ${recipe.target.tier} quality setting becomes a constant QP`)
    }
    if (recipe.tune !== null)
    {
      changes.push(`the ${recipe.tune} tune is not used`)
    }
  }
  const pixelFormat = recipe.kind === 'compress' ? recipe.pixelFormat : recipe.kind === 'convert' ? recipe.video?.pixelFormat ?? 'source' : 'source'
  if (pixelFormat !== 'source')
  {
    changes.push(`the ${pixelFormat} pixel format is not kept`)
  }
  return changes
}

function codecWord(encoder: string): string
{
  if (Object.hasOwn(GPU_CODECS, encoder))
  {
    return GPU_CODECS[encoder].label
  }
  return (VIDEO_ENCODERS as readonly string[]).includes(encoder) ? videoCodecName(encoder as VideoEncoder) : encoder
}

/**
 * The GPU choice for a runner's CPU video plan under the batch's GPU policy. `require` blocks a codec without a GPU
 * encoder, a machine without one, and lossless; `auto` keeps the CPU encoder with a note in those cases, and a GPU
 * plan under `auto` carries the CPU plan as the fallback that runs if the GPU encoder fails to start. Two-pass, CRF,
 * tune, and pixel format changes on the GPU are listed as one warning.
 */
export function planGpu(recipe: Recipe, plan: Pick<RunnerPlan, 'video' | 'class'>, policy: BatchPolicy['gpu'], gpu: CapabilitySummary['gpu']): GpuOutcome
{
  const cpu = plan.video
  if (policy === 'off' || cpu === null || plan.class !== 'video-cpu' || cpu.encoder === 'copy')
  {
    return { video: cpu, class: plan.class, issues: [] }
  }
  const vendor = gpu.status === 'ready' && gpu.vendor !== null ? gpu.vendor : null
  const name = vendor === null ? null : GPU_NAMES[vendor]
  const encoder = vendor !== null && Object.hasOwn(GPU_CODECS, cpu.encoder) ? `${GPU_CODECS[cpu.encoder].prefix}_${GPU_SUFFIXES[vendor]}` : null
  const fallback: VideoPlan = { encoder: cpu.encoder, gpu: null, lossless: cpu.lossless, passes: cpu.passes, filters: cpu.filters, notes: cpu.notes }
  const onCpu = { ...fallback, cpuFallback: null }
  const toAuto: PlanFix = { kind: 'set-gpu', gpu: 'auto', scope: 'batch' }
  const toOff: PlanFix = { kind: 'set-gpu', gpu: 'off', scope: 'batch' }
  if (encoder === null || !gpu.encoders.includes(encoder))
  {
    if (policy === 'require')
    {
      const message = name === null || gpu.encoders.length === 0 ? planText.gpuMissing() : planText.gpuCannotEncode(name, codecWord(cpu.encoder))
      return { video: onCpu, class: plan.class, issues: [planIssue('gpu-unavailable', 'error', message, 'encoder', toAuto)] }
    }
    return { video: onCpu, class: plan.class, issues: [planIssue('gpu-unavailable', 'info', planText.gpuNotUsed(codecWord(cpu.encoder), cpu.encoder), 'encoder')] }
  }
  const gpuName = name as string
  if (cpu.lossless !== 'not-requested')
  {
    return policy === 'require'
      ? { video: onCpu, class: plan.class, issues: [planIssue('gpu-unavailable', 'error', planText.gpuLosslessRequired(gpuName), 'encoder', toAuto)] }
      : { video: onCpu, class: plan.class, issues: [planIssue('gpu-downgrade', 'warning', planText.gpuLossless(gpuName, cpu.encoder), 'encoder', toOff)] }
  }
  const changes = gpuChanges(recipe, cpu)
  const video = {
    encoder,
    gpu: gpuName,
    lossless: 'not-requested' as const,
    passes: 1 as const,
    filters: cpu.filters.filter((filter) => !filter.startsWith('format=')),
    notes: changes,
    cpuFallback: policy === 'auto' ? fallback : null
  }
  const issues = changes.length === 0 ? [] : [planIssue('gpu-downgrade', 'warning', planText.gpuDowngrade(changes), 'encoder', toOff)]
  return { video, class: 'video-gpu', issues }
}

/** The codes the planner reports itself; a runner issue with one of them is dropped when the planner reported it for the job. */
const PLANNER_CODES: ReadonlySet<PlanIssueCode> = new Set<PlanIssueCode>([
  'container-cannot-hold', 'encoder-missing', 'container-changed', 'no-audio-stream', 'no-video-stream', 'audio-only-output',
  'stream-not-found', 'subtitle-bitmap', 'too-many-channels', 'gpu-unavailable', 'gpu-downgrade', 'lossless-unsupported', 'tune-unsupported'
])

const REENCODE_FIX: PlanFix = { kind: 'patch-recipe', label: 'Re-encode video', patch: { field: 'extract-reencode', value: { encoder: 'libx264', crf: 18 } }, scope: 'jobs' }
const REMOVE_FIX: PlanFix = { kind: 'remove', scope: 'jobs' }

/** Runner issues beside the planner's: a code the planner already reported for the job is not repeated, and a stream-copy trim gets its re-encode fix. */
export function mergeRunnerIssues(planner: readonly PlanIssue[], runner: readonly PlanIssue[]): PlanIssue[]
{
  const reported = new Set(planner.map((issue) => issue.code))
  return runner
    .filter((issue) => !(PLANNER_CODES.has(issue.code) && reported.has(issue.code)))
    .map((issue) => (issue.code === 'keyframe-trim' && issue.fix === null ? { ...issue, fix: REENCODE_FIX } : issue))
}

/** The checks of encoder settings the build cannot honor: SVT-AV1 has no lossless mode, and x265 has no film tune. */
export function encoderSettingIssues(recipe: Recipe): PlanIssue[]
{
  if (recipe.kind !== 'compress')
  {
    return []
  }
  const issues: PlanIssue[] = []
  if (recipe.encoder === 'libsvtav1' && recipe.target.mode === 'quality' && recipe.target.tier === 'lossless')
  {
    const fix: PlanFix = { kind: 'patch-recipe', label: 'Use x265 lossless', patch: { field: 'compress-target', value: { mode: 'quality', tier: 'lossless' }, encoder: 'libx265' }, scope: 'jobs' }
    issues.push(planIssue('lossless-unsupported', 'error', planText.losslessUnsupported(), 'encoder', fix))
  }
  if (recipe.encoder === 'libx265' && recipe.tune === 'film')
  {
    issues.push(planIssue('tune-unsupported', 'error', planText.tuneUnsupported(recipe.tune), 'encoder'))
  }
  return issues
}

type StatRead = { kind: 'found'; stat: FileStat } | { kind: 'missing' } | { kind: 'error'; reason: string }

function reasonOf(err: unknown): string
{
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/[.\s]+$/, '')
}

async function readStat(io: PlannerIO, path: string): Promise<StatRead>
{
  try
  {
    const stat = await io.stat(path)
    return stat === null ? { kind: 'missing' } : { kind: 'found', stat }
  }
  catch (err)
  {
    return { kind: 'error', reason: reasonOf(err) }
  }
}

/** One job while the report is built. */
interface Draft
{
  job: PlanJob
  issues: PlanIssue[]
  facts: MediaFacts | null
  sourceBytes: number
  sourceOk: boolean
  decision: ContainerDecision | null
  replacing: boolean
  /** The path the template or the replace rule gives, before the batch rules. */
  intended: string | null
  /** The folder the row's relative path starts from. */
  base: string | null
  runner: RunnerPlan | null
  video: JobPlan['video']
  class: JobPlan['class']
  finalPath: string | null
  conflict: OutputPlan['conflict']
  resolution: OutputPlan['resolution']
  renamedTo: string | null
  displaces: string | null
  /** The files this job would send to the bin: the original it replaces and the existing file it overwrites. */
  binFiles: Array<{ path: string; bytes: number; kind: 'original' | 'existing' }>
  reserveBytes: number
  album: JobPlan['album']
}

interface PlanContext
{
  input: PreflightInput
  deps: PlannerDeps
  build: MuxBuild
  global: readonly PlanIssue[]
}

function hasError(issues: readonly PlanIssue[]): boolean
{
  return issues.some((issue) => issue.severity === 'error')
}

function newDraft(job: PlanJob, global: readonly PlanIssue[]): Draft
{
  return {
    job,
    issues: [...global],
    facts: null,
    sourceBytes: job.source.size,
    sourceOk: false,
    decision: null,
    replacing: false,
    intended: null,
    base: null,
    runner: null,
    video: null,
    class: 'copy',
    finalPath: null,
    conflict: 'none',
    resolution: 'place',
    renamedTo: null,
    displaces: null,
    binFiles: [],
    reserveBytes: 0,
    album: null
  }
}

async function checkSource(draft: Draft, io: PlannerIO): Promise<boolean>
{
  const { source } = draft.job
  const read = await readStat(io, source.path)
  if (read.kind === 'missing')
  {
    draft.issues.push(planIssue('source-missing', 'error', planText.sourceMissing(source.path), 'source', REMOVE_FIX))
    return false
  }
  if (read.kind === 'error' || !read.stat.isFile)
  {
    const reason = read.kind === 'error' ? read.reason : 'it is not a file'
    draft.issues.push(planIssue('source-unreadable', 'error', planText.sourceUnreadable(source.name, reason), 'source', REMOVE_FIX))
    return false
  }
  if (read.stat.size !== source.size || read.stat.mtimeMs !== source.mtimeMs)
  {
    draft.issues.push(planIssue('source-changed', 'warning', planText.sourceChanged(source.name), 'source'))
  }
  draft.sourceBytes = read.stat.size
  return true
}

function probedFacts(draft: Draft): MediaFacts | null
{
  const { probe, source } = draft.job
  if (probe.status !== 'ok')
  {
    const reason = probe.status === 'failed' ? reasonOf(probe.reason) : 'the probe has not finished'
    draft.issues.push(planIssue('probe-failed', 'error', planText.probeFailed(source.name, reason), 'source'))
    return null
  }
  if (probe.facts.audio.length === 0 && probe.facts.video.length === 0)
  {
    draft.issues.push(planIssue('not-media', 'error', planText.notMedia(source.name), 'source', REMOVE_FIX))
    return null
  }
  return probe.facts
}

/** The path a job's output takes before the batch rules: the source path or its new extension in Replace, else the rendered template. */
function intendedPath(draft: Draft, decision: ContainerDecision, ctx: PlanContext): void
{
  const { policy, platform } = ctx.input
  const { source, recipe } = draft.job
  const paths = pathApi(platform)
  const dir = source.dir !== '' ? source.dir : paths.dirname(source.path)
  const destination = policy.destination
  if (destination.mode === 'replace-originals' && recipe.kind !== 'extract')
  {
    draft.replacing = true
    draft.base = dir
    const sameExt = extensionOf(source.ext) === decision.container
    draft.intended = sameExt ? source.path : paths.join(dir, `${stemOf(source.name)}.${decision.container}`)
    if (!sameExt)
    {
      draft.issues.push(planIssue('replace-extension-change', 'warning', planText.replaceExtension(source.name, paths.basename(draft.intended)), 'naming'))
    }
    return
  }
  if (destination.mode === 'replace-originals')
  {
    draft.issues.push(planIssue('extract-never-replaces', 'info', planText.extractNeverReplaces(), 'destination'))
  }
  const base = destination.mode === 'folder' ? destination.folder : dir
  draft.base = base
  if (destination.mode === 'folder' && !paths.isAbsolute(base))
  {
    return
  }
  const values = templateValues({ catalog: draft.job.id, stem: stemOf(source.name), ext: source.ext.replace(/^\./, ''), subdir: source.subdir, recipe, date: ctx.input.date })
  const rendered = renderTemplate(policy.template, values, platform)
  draft.issues.push(...rendered.issues.map((issue) => planIssue(issue.code, issue.severity, issue.message, 'naming')))
  if (!rendered.ok)
  {
    return
  }
  draft.intended = decision.kind === 'folder'
    ? paths.join(base, rendered.relativePath)
    : paths.join(base, `${rendered.relativePath}.${decision.container}`)
}

function runnerFor(runners: RunnerSet, kind: Recipe['kind']): JobRunner<Recipe>
{
  return runners[kind] as unknown as JobRunner<Recipe>
}

/** Per job: the source checks, the probe, the stream rules, the container, the intended path, the runner's plan, and the GPU choice. */
async function draftJob(job: PlanJob, ctx: PlanContext): Promise<Draft>
{
  const draft = newDraft(job, ctx.global)
  const { platform, policy, capabilities } = ctx.input
  draft.sourceOk = await checkSource(draft, ctx.deps.io)
  if (!draft.sourceOk)
  {
    return draft
  }
  const facts = probedFacts(draft)
  if (facts === null)
  {
    return draft
  }
  draft.facts = facts
  const rules = applicabilityIssues(job.recipe, factsFromProbe(facts), job.source.name)
  draft.issues.push(...rules)
  if (hasError(rules))
  {
    return draft
  }
  const decision = decideContainer(job.recipe, job.source, facts, capabilities.build, ctx.build)
  draft.decision = decision
  draft.issues.push(...decision.issues, ...encoderSettingIssues(job.recipe))
  intendedPath(draft, decision, ctx)
  const output: OutputPlan = {
    kind: decision.kind,
    finalPath: draft.intended ?? '',
    container: decision.container,
    muxer: decision.muxer,
    containerChanged: decision.changed,
    conflict: 'none',
    resolution: 'place',
    renamedTo: null,
    displaces: null
  }
  try
  {
    const planned = runnerFor(ctx.deps.runners, job.recipe.kind).plan({ recipe: job.recipe, source: job.source, facts, caps: capabilities.build, output, platform })
    draft.runner = planned
    draft.issues.push(...mergeRunnerIssues(draft.issues, planned.issues))
    const gpu = planGpu(job.recipe, planned, policy.gpu, capabilities.summary.gpu)
    draft.video = gpu.video
    draft.class = gpu.class
    draft.issues.push(...gpu.issues)
    draft.reserveBytes = reserveBytes(job.recipe.kind, planned.estimate.outputBytes, draft.sourceBytes)
  }
  catch (err)
  {
    draft.issues.push(planIssue('invalid-recipe', 'error', planText.invalidRecipe(job.source.name, reasonOf(err)), 'recipe'))
  }
  return draft
}

type Collision = PreflightReport['collisions'][number]

/** The path claims the batch rules check against, keyed by `pathKey`. */
interface Claims
{
  /** Sources of every non-terminal job, in this report or not. */
  sources: Map<string, JobId[]>
  /** Final paths reserved by queued, active, and held jobs outside this report. */
  reserved: Map<string, JobId>
  /** Final paths taken by earlier jobs of this report, in queue order. */
  claimed: Map<string, JobId>
  collisions: Map<string, Collision>
}

function addOwner(map: Map<string, JobId[]>, key: string, id: JobId): void
{
  const owners = map.get(key)
  if (owners === undefined)
  {
    map.set(key, [id])
  }
  else if (!owners.includes(id))
  {
    owners.push(id)
  }
}

/** Replace originals allows one job per source: every Replace job on a shared source is blocked. */
function replaceRules(drafts: readonly Draft[], platform: Platform): void
{
  const bySource = new Map<string, Draft[]>()
  for (const draft of drafts.filter((d) => d.replacing && d.intended !== null))
  {
    const key = pathKey(draft.job.source.path, platform)
    bySource.set(key, [...(bySource.get(key) ?? []), draft])
  }
  for (const group of bySource.values())
  {
    if (group.length > 1)
    {
      for (const draft of group)
      {
        draft.issues.push(planIssue('replace-one-job-per-source', 'error', planText.replaceOnePerSource(), 'destination', REMOVE_FIX))
      }
    }
  }
}

/**
 * A job whose source is the final path a queued, active, or held job outside this report reserved cannot run before
 * it; chained jobs are not supported. A job inside the report never writes over another's source: the conflict rule
 * renames or blocks it first.
 */
function pendingOutputRule(drafts: readonly Draft[], claims: Claims, platform: Platform): void
{
  for (const draft of drafts.filter((d) => d.sourceOk))
  {
    const owner = claims.reserved.get(pathKey(draft.job.source.path, platform))
    if (owner !== undefined && owner !== draft.job.id)
    {
      draft.issues.push(planIssue('source-is-pending-output', 'error', planText.pendingOutput(owner), 'source', REMOVE_FIX))
    }
  }
}

function tokenFixes(draft: Draft, other: Draft | null, template: string): PlanFix[]
{
  const fixes: PlanFix[] = []
  const source = draft.job.source
  if (!template.includes('{subdir}') && (other === null || other.job.source.subdir !== source.subdir || other.job.source.dir !== source.dir))
  {
    fixes.push({ kind: 'add-token', token: '{subdir}', scope: 'batch' })
  }
  if (!template.includes('{ext}') && other !== null && extensionOf(other.job.source.ext) !== extensionOf(source.ext))
  {
    fixes.push({ kind: 'add-token', token: '{ext}', scope: 'batch' })
  }
  if (!template.includes('{catalog}'))
  {
    fixes.push({ kind: 'add-token', token: '{catalog}', scope: 'batch' })
  }
  return fixes
}

interface ResolveContext
{
  ctx: PlanContext
  claims: Claims
  byId: Map<JobId, Draft>
}

/** The first numbered name from (2) that no job's source, reservation, or earlier output claims and nothing occupies on disk. */
async function freeNumberedPath(path: string, rc: ResolveContext): Promise<string | null>
{
  const { platform } = rc.ctx.input
  const paths = pathApi(platform)
  const dir = paths.dirname(path)
  const base = paths.basename(path)
  for (let n = RENAME_FIRST; n <= RENAME_LAST; n++)
  {
    const candidate = paths.join(dir, numberedName(base, n))
    const key = pathKey(candidate, platform)
    if (rc.claims.sources.has(key) || rc.claims.reserved.has(key) || rc.claims.claimed.has(key))
    {
      continue
    }
    const read = await readStat(rc.ctx.deps.io, candidate)
    if (read.kind === 'missing')
    {
      return candidate
    }
  }
  return null
}

function placeAt(draft: Draft, path: string, rc: ResolveContext): void
{
  draft.finalPath = path
  if (draft.replacing)
  {
    draft.resolution = 'replace-original'
    draft.displaces = draft.job.source.path
    if (rc.ctx.input.policy.displaced === 'trash')
    {
      draft.binFiles.push({ path: draft.job.source.path, bytes: draft.sourceBytes, kind: 'original' })
    }
  }
  rc.claims.claimed.set(pathKey(path, rc.ctx.input.platform), draft.job.id)
}

async function renameTo(draft: Draft, path: string, note: (renamedName: string) => PlanIssue[], exhausted: PlanIssueCode, rc: ResolveContext): Promise<void>
{
  const paths = pathApi(rc.ctx.input.platform)
  const renamed = await freeNumberedPath(path, rc)
  if (renamed === null)
  {
    draft.issues.push(planIssue(exhausted, 'error', planText.renameExhausted(paths.basename(path)), 'naming'))
    draft.finalPath = path
    return
  }
  placeAt(draft, renamed, rc)
  draft.renamedTo = renamed
  if (!draft.replacing)
  {
    draft.resolution = 'rename'
  }
  draft.issues.push(...note(paths.basename(renamed)))
}

function overwriteExisting(draft: Draft, path: string, existingBytes: number, rc: ResolveContext): void
{
  const { platform, policy } = rc.ctx.input
  const paths = pathApi(platform)
  const name = paths.basename(path)
  placeAt(draft, path, rc)
  draft.conflict = 'exists'
  if (!draft.replacing)
  {
    draft.resolution = 'overwrite'
    draft.displaces = path
  }
  if (policy.displaced === 'trash')
  {
    draft.binFiles.push({ path, bytes: existingBytes, kind: 'existing' })
    const label = volumeLabel(volumeRoot(path, platform), platform)
    draft.issues.push(planIssue('output-exists', 'warning', planText.outputTrashed(name, binPhrase(platform, label)), 'naming'))
  }
  else
  {
    const kept = paths.basename(displacedPath(path, 'previous', 1, platform))
    draft.issues.push(planIssue('output-exists', 'warning', planText.outputKept(name, kept), 'naming'))
  }
}

function recordCollision(rc: ResolveContext, path: string, first: JobId, later: JobId, renamed: boolean): void
{
  const key = pathKey(path, rc.ctx.input.platform)
  const entry = rc.claims.collisions.get(key) ?? { finalPath: path, jobIds: [first], resolution: renamed ? 'renamed' : 'blocked' }
  if (!entry.jobIds.includes(later))
  {
    entry.jobIds.push(later)
  }
  if (!renamed)
  {
    entry.resolution = 'blocked'
  }
  rc.claims.collisions.set(key, entry)
}

/** The conflict rule for one job, in queue order: its own source, another job's source, a claimed path, an existing file, or a free path. */
async function resolveOutput(draft: Draft, existing: StatRead | null, rc: ResolveContext): Promise<void>
{
  const { platform, policy } = rc.ctx.input
  const paths = pathApi(platform)
  const path = draft.intended as string
  const key = pathKey(path, platform)
  const name = paths.basename(path)
  const rule = policy.conflict
  const own = pathKey(draft.job.source.path, platform)
  const id = draft.job.id
  if (draft.replacing && key === own)
  {
    placeAt(draft, draft.job.source.path, rc)
    return
  }
  if (key === own)
  {
    if (rule === 'rename')
    {
      return renameTo(draft, path, (renamed) => [planIssue('same-as-source', 'info', `${planText.sameAsSource()} This job writes ${renamed}.`, 'naming')], 'same-as-source', rc)
    }
    draft.finalPath = path
    draft.issues.push(planIssue('same-as-source', 'error', planText.sameAsSource(), 'naming'))
    return
  }
  const sourceOwner = (rc.claims.sources.get(key) ?? []).find((owner) => owner !== id)
  if (sourceOwner !== undefined)
  {
    const message = planText.overwritesAnotherSource(sourceOwner)
    if (rule === 'rename')
    {
      return renameTo(draft, path, (renamed) => [planIssue('overwrites-another-source', 'info', `${message} This job writes ${renamed}.`, 'naming')], 'overwrites-another-source', rc)
    }
    draft.finalPath = path
    draft.issues.push(planIssue('overwrites-another-source', 'error', message, 'naming'))
    return
  }
  const holder = rc.claims.claimed.get(key) ?? rc.claims.reserved.get(key)
  if (holder !== undefined)
  {
    const message = planText.collision(holder, id, name)
    const fixes = tokenFixes(draft, rc.byId.get(holder) ?? null, policy.template)
    recordCollision(rc, path, holder, id, rule === 'rename')
    draft.conflict = 'collides'
    if (rule === 'rename')
    {
      return renameTo(draft, path, () => withFixes('intra-batch-collision', 'info', message, 'naming', fixes), 'intra-batch-collision', rc)
    }
    draft.finalPath = path
    draft.issues.push(...withFixes('intra-batch-collision', 'error', message, 'naming', [{ kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' }, ...fixes]))
    return
  }
  if (existing !== null && existing.kind === 'found')
  {
    draft.conflict = 'exists'
    if (rule === 'skip')
    {
      draft.finalPath = path
      draft.resolution = 'skip'
      draft.issues.push(planIssue('output-exists', 'info', planText.outputSkipped(name), 'naming', { kind: 'set-conflict-rule', rule: 'rename', scope: 'batch' }))
      return
    }
    if (rule === 'rename')
    {
      return renameTo(draft, path, (renamed) => [planIssue('output-exists', 'info', planText.outputRenamed(name, renamed), 'naming')], 'output-exists', rc)
    }
    overwriteExisting(draft, path, existing.stat.size, rc)
    return
  }
  if (existing !== null && existing.kind === 'error')
  {
    draft.finalPath = path
    draft.issues.push(planIssue('destination-not-writable', 'error', planText.destinationNotWritable(paths.dirname(path), existing.reason), 'destination'))
    return
  }
  placeAt(draft, path, rc)
}

/** The output path checks once the final path is known: a path or work path past the Windows limit is a warning. */
function pathLengthIssues(draft: Draft, platform: Platform): PlanIssue[]
{
  if (draft.finalPath === null || draft.decision === null)
  {
    return []
  }
  const paths = pathApi(platform)
  const work = paths.join(workDirPath(draft.finalPath, draft.job.id, 1, 1, platform), partOutputName(1, draft.decision.container))
  const longest = work.length > draft.finalPath.length ? work : draft.finalPath
  return exceedsPathLimit(longest, platform) ? [planIssue('path-long', 'warning', planText.pathLong(longest.length), 'naming')] : []
}

function writes(draft: Draft): boolean
{
  return draft.finalPath !== null && draft.resolution !== 'skip' && !hasError(draft.issues)
}

/** Why a folder cannot take new files, or null when the nearest folder that exists passes a real write probe. */
async function folderProblem(folder: string, io: PlannerIO, platform: Platform): Promise<string | null>
{
  const paths = pathApi(platform)
  let current = folder
  for (;;)
  {
    const read = await readStat(io, current)
    if (read.kind === 'error')
    {
      return read.reason
    }
    if (read.kind === 'found')
    {
      if (!read.stat.isDirectory)
      {
        return `${current} is a file, not a folder`
      }
      try
      {
        return await io.probeWrite(current) ? null : 'new files cannot be created there'
      }
      catch (err)
      {
        return reasonOf(err)
      }
    }
    const parent = paths.dirname(current)
    if (parent === current)
    {
      return 'the drive is not available'
    }
    current = parent
  }
}

/** Every distinct output folder, once: it exists or the nearest folder above it is writable. */
async function destinationRules(drafts: readonly Draft[], ctx: PlanContext): Promise<void>
{
  const { platform } = ctx.input
  const paths = pathApi(platform)
  const folders = new Map<string, { folder: string; drafts: Draft[] }>()
  for (const draft of drafts.filter(writes))
  {
    const folder = paths.dirname(draft.finalPath as string)
    const key = pathKey(folder, platform)
    const entry = folders.get(key) ?? { folder, drafts: [] }
    entry.drafts.push(draft)
    folders.set(key, entry)
  }
  await Promise.all([...folders.values()].map(async (entry) =>
  {
    const problem = await folderProblem(entry.folder, ctx.deps.io, platform)
    if (problem !== null)
    {
      for (const draft of entry.drafts)
      {
        draft.issues.push(planIssue('destination-not-writable', 'error', planText.destinationNotWritable(entry.folder, problem), 'destination'))
      }
    }
  }))
}

/** One volume a report reads from or writes to, while the report is built. */
interface VolumeDraft
{
  root: string
  label: string
  path: string
  info: VolumeInfo
  freeBytes: number | null
  volumeBytes: number | null
  destination: boolean
  writers: Draft[]
  /** The jobs that send files to this volume's bin, with the bytes each sends. */
  bin: Array<{ draft: Draft; bytes: number; kind: 'original' | 'existing' }>
  estimatedBytes: number
  trashBytesNeeded: number
  status: VolumeReport['status']
}

const UNKNOWN_VOLUME: VolumeInfo = { kind: 'unknown', trash: 'unknown', trashBytesFree: null, volumeBytes: null }

async function collectVolumes(drafts: readonly Draft[], ctx: PlanContext): Promise<VolumeDraft[]>
{
  const { platform } = ctx.input
  const keyOf = ctx.deps.volumeKey ?? ((path: string): Promise<string> => Promise.resolve(rootKey(path, platform)))
  const volumes = new Map<string, VolumeDraft>()
  const volumeFor = async (path: string): Promise<VolumeDraft> =>
  {
    const key = await keyOf(path)
    const known = volumes.get(key)
    if (known !== undefined)
    {
      return known
    }
    const root = volumeRoot(path, platform)
    const created: VolumeDraft = {
      root, label: volumeLabel(root, platform), path, info: UNKNOWN_VOLUME, freeBytes: null, volumeBytes: null, destination: false,
      writers: [], bin: [], estimatedBytes: 0, trashBytesNeeded: 0, status: 'unknown'
    }
    volumes.set(key, created)
    return created
  }
  for (const draft of drafts.filter((d) => d.sourceOk))
  {
    await volumeFor(draft.job.source.path)
    if (draft.finalPath !== null)
    {
      const volume = await volumeFor(draft.finalPath)
      volume.destination = true
      if (writes(draft))
      {
        volume.writers.push(draft)
      }
    }
    if (writes(draft))
    {
      for (const file of draft.binFiles)
      {
        (await volumeFor(file.path)).bin.push({ draft, bytes: file.bytes, kind: file.kind })
      }
    }
  }
  const paths = pathApi(platform)
  await Promise.all([...volumes.values()].map(async (volume) =>
  {
    volume.info = await ctx.deps.io.volumeInfo(volume.path).catch(() => UNKNOWN_VOLUME)
    if (volume.destination)
    {
      const folder = volume.writers.length > 0 ? paths.dirname(volume.writers[0].finalPath as string) : paths.dirname(volume.path)
      const space = await ctx.deps.io.statfs(folder).catch(() => null)
      volume.freeBytes = space?.freeBytes ?? null
      volume.volumeBytes = volume.info.volumeBytes ?? space?.totalBytes ?? null
    }
    else
    {
      volume.volumeBytes = volume.info.volumeBytes
    }
  }))
  return [...volumes.values()]
}

/** Per destination volume: the jobs' reserves against its free space; one job past the free space is blocked, a sum past 80 percent is tight. */
function diskRules(volume: VolumeDraft): void
{
  const estimates = volume.writers.map((draft) => draft.reserveBytes)
  volume.estimatedBytes = estimates.reduce((sum, bytes) => sum + bytes, 0)
  volume.status = volume.destination ? volumeStatus(estimates, volume.freeBytes) : 'unknown'
  const free = volume.freeBytes
  if (free === null || (volume.status !== 'tight' && volume.status !== 'insufficient'))
  {
    return
  }
  const fitting = volume.writers.filter((draft) => draft.reserveBytes <= free)
  for (const draft of volume.writers.filter((d) => d.reserveBytes > free))
  {
    draft.issues.push(planIssue('disk-insufficient', 'error', planText.diskSpace(draft.reserveBytes, volume.label, free), 'disk'))
  }
  const sum = fitting.reduce((total, draft) => total + draft.reserveBytes, 0)
  if (volumeStatus(fitting.map((draft) => draft.reserveBytes), free) === 'tight')
  {
    for (const draft of fitting)
    {
      draft.issues.push(planIssue('disk-tight', 'warning', planText.diskSpace(sum, volume.label, free), 'disk'))
    }
  }
}

/** Per volume bin: no bin is a warning (files are kept instead); a Windows bin without room for what this report sends there blocks those jobs. */
function trashRules(volume: VolumeDraft, ctx: PlanContext): void
{
  const { platform, policy } = ctx.input
  const senders = volume.bin.filter((entry) => !hasError(entry.draft.issues))
  if (policy.displaced !== 'trash' || senders.length === 0)
  {
    return
  }
  const drafts = [...new Set(senders.map((entry) => entry.draft))]
  if (volume.info.trash === 'unavailable')
  {
    for (const draft of drafts)
    {
      draft.issues.push(planIssue('no-recycle-bin', 'warning', planText.noRecycleBin(volume.label), 'destination'))
    }
    return
  }
  volume.trashBytesNeeded = senders.reduce((sum, entry) => sum + entry.bytes, 0)
  const info = { trash: volume.info.trash, trashBytesFree: volume.info.trashBytesFree, volumeBytes: volume.volumeBytes }
  if (!trashTooSmall(volume.trashBytesNeeded, info, platform))
  {
    return
  }
  const originals = senders.some((entry) => entry.kind === 'original')
  const existing = senders.some((entry) => entry.kind === 'existing')
  const what = originals && existing ? 'both' : originals ? 'originals' : 'existing'
  const message = volume.info.trashBytesFree === null
    ? planText.trashUnreadable(volume.label, volume.trashBytesNeeded)
    : planText.trashTooSmall(volume.label, volume.info.trashBytesFree, volume.trashBytesNeeded, what)
  const fixes: PlanFix[] = [{ kind: 'set-displaced', displaced: 'keep', scope: 'batch' }, { kind: 'set-destination', destination: 'next-to-source', scope: 'batch' }]
  for (const draft of drafts)
  {
    draft.issues.push(...withFixes('trash-too-small', 'error', message, 'destination', fixes))
  }
}

function albumKey(recipe: Extract<Recipe, { kind: 'normalize' }>): string
{
  return JSON.stringify([recipe.target, recipe.policy, recipe.maxLimitingDb, recipe.mono, recipe.monoToStereo, recipe.downmix, recipe.output])
}

/** Album members share a target, policy, and output layout, and a Start includes every member still in the queue. */
function albumRules(drafts: readonly Draft[], albums: readonly AlbumGroup[]): void
{
  const groups = new Map<string, Array<{ draft: Draft; recipe: Extract<Recipe, { kind: 'normalize' }> }>>()
  for (const draft of drafts)
  {
    const recipe = draft.job.recipe
    if (recipe.kind === 'normalize' && recipe.albumGroupId !== null)
    {
      groups.set(recipe.albumGroupId, [...(groups.get(recipe.albumGroupId) ?? []), { draft, recipe }])
    }
  }
  for (const [groupId, members] of groups)
  {
    const queued = albums.find((album) => album.groupId === groupId)?.jobIds.length ?? members.length
    const total = Math.max(queued, members.length)
    const mismatch = new Set(members.map((member) => albumKey(member.recipe))).size > 1
    for (const { draft } of members)
    {
      draft.album = { groupId, members: total }
      if (mismatch)
      {
        draft.issues.push(planIssue('album-mismatch', 'error', planText.albumMismatch(), 'album'))
      }
      if (members.length < total)
      {
        draft.issues.push(planIssue('album-incomplete', 'error', planText.albumIncomplete(groupId, total, members.length), 'album'))
      }
    }
  }
}

function buildPlan(draft: Draft, ctx: PlanContext): JobPlan | null
{
  const runner = draft.runner
  const decision = draft.decision
  if (runner === null || decision === null || draft.finalPath === null)
  {
    return null
  }
  const { policy, capabilities } = ctx.input
  const outputBytes = runner.estimate.outputBytes
  const plan: Omit<JobPlan, 'fingerprint'> = {
    basis: { inputsRev: draft.job.inputsRev, policyRev: policy.rev, capabilitiesRev: capabilities.summary.rev },
    source: { path: draft.job.source.path, size: draft.job.source.size, mtimeMs: draft.job.source.mtimeMs },
    output: {
      kind: decision.kind,
      finalPath: draft.finalPath,
      container: decision.container,
      muxer: decision.muxer,
      containerChanged: decision.changed,
      conflict: draft.conflict,
      resolution: draft.resolution,
      renamedTo: draft.renamedTo,
      displaces: draft.displaces
    },
    streams: runner.streams,
    video: draft.video,
    audio: runner.audio,
    class: draft.class,
    stages: runner.stages,
    estimate: { outputBytes, reserveBytes: draft.reserveBytes, workSec: runner.estimate.workSec, confidence: outputBytes === null ? 'low' : runner.estimate.confidence },
    album: draft.album,
    command: runner.command
  }
  return { ...plan, fingerprint: planFingerprint(plan) }
}

function issueKey(issue: PlanIssue): string
{
  return `${issue.code}\n${issue.message}\n${JSON.stringify(issue.fix)}`
}

function distinctIssues(entries: readonly ReportEntry[], severity: PlanIssue['severity']): PlanIssue[]
{
  const seen = new Map<string, PlanIssue>()
  for (const issue of entries.flatMap((entry) => entry.issues).filter((i) => i.severity === severity))
  {
    if (!seen.has(issueKey(issue)))
    {
      seen.set(issueKey(issue), issue)
    }
  }
  return [...seen.values()]
}

/** The report's counts; `warnings` counts the ready jobs that carry a warning, so ready minus warnings is the clean count. */
export function reportCounts(entries: readonly ReportEntry[]): PreflightReport['counts']
{
  const ready = entries.filter((entry) => entry.status === 'ready')
  const plans = ready.map((entry) => entry.plan).filter((plan): plan is JobPlan => plan !== null)
  return {
    jobs: entries.length,
    ready: ready.length,
    blocked: entries.filter((entry) => entry.status === 'blocked').length,
    willSkip: entries.filter((entry) => entry.status === 'will-skip').length,
    renames: plans.filter((plan) => plan.output.renamedTo !== null).length,
    overwrites: plans.filter((plan) => plan.output.conflict === 'exists' && (plan.output.resolution === 'overwrite' || plan.output.resolution === 'replace-original')).length,
    originalsAffected: plans.filter((plan) => plan.output.resolution === 'replace-original').length,
    containerChanges: plans.filter((plan) => plan.output.containerChanged !== null).length,
    gpuJobs: plans.filter((plan) => plan.class === 'video-gpu').length,
    cpuFallbacks: plans.filter((plan) => plan.video?.cpuFallback != null).length,
    warnings: ready.filter((entry) => entry.issues.some((issue) => issue.severity === 'warning')).length
  }
}

/**
 * Plans one preflight: every job's plan and issues, the batch rules in queue order, the destination folders, the
 * volumes with their space and bins, the album rules, and the counts. Each job's status is `blocked` with an error,
 * `will-skip` when the skip rule meets an existing file, and `ready` otherwise; a job keeps its plan while blocked
 * when one could be made, so Review can show what it would do.
 */
export async function planPreflight(input: PreflightInput, deps: PlannerDeps): Promise<PreflightResult>
{
  const { platform, policy } = input
  const global = [...ffmpegIssues(input.capabilities)]
  if (policy.destination.mode === 'folder' && !pathApi(platform).isAbsolute(policy.destination.folder))
  {
    global.push(planIssue('destination-invalid', 'error', planText.destinationInvalid(platform), 'destination'))
  }
  const ctx: PlanContext = { input, deps, build: input.capabilities.summary.ffmpeg.meetsMinimum ? 'pinned' : 'legacy', global }
  const drafts = await Promise.all(input.jobs.map((job) => draftJob(job, ctx)))
  const claims: Claims = { sources: new Map(), reserved: new Map(), claimed: new Map(), collisions: new Map() }
  for (const draft of drafts)
  {
    addOwner(claims.sources, pathKey(draft.job.source.path, platform), draft.job.id)
  }
  for (const other of input.others)
  {
    addOwner(claims.sources, pathKey(other.sourcePath, platform), other.id)
    if (other.reservedPath !== null)
    {
      claims.reserved.set(pathKey(other.reservedPath, platform), other.id)
    }
  }
  replaceRules(drafts, platform)
  pendingOutputRule(drafts, claims, platform)
  const candidates = drafts.map((draft) => draft.intended !== null && !hasError(draft.issues))
  const existing = await Promise.all(drafts.map((draft, index) => (candidates[index] ? readStat(deps.io, draft.intended as string) : Promise.resolve(null))))
  const rc: ResolveContext = { ctx, claims, byId: new Map(drafts.map((draft) => [draft.job.id, draft])) }
  for (const [index, draft] of drafts.entries())
  {
    if (candidates[index])
    {
      await resolveOutput(draft, existing[index], rc)
      draft.issues.push(...pathLengthIssues(draft, platform))
    }
    else
    {
      draft.finalPath = draft.intended
    }
  }
  await destinationRules(drafts, ctx)
  albumRules(drafts, input.albums)
  const volumes = await collectVolumes(drafts, ctx)
  for (const volume of volumes)
  {
    diskRules(volume)
  }
  for (const volume of volumes)
  {
    trashRules(volume, ctx)
  }
  const entries: ReportEntry[] = drafts.map((draft) => ({
    jobId: draft.job.id,
    inputsRev: draft.job.inputsRev,
    status: hasError(draft.issues) ? 'blocked' : draft.resolution === 'skip' ? 'will-skip' : 'ready',
    plan: buildPlan(draft, ctx),
    issues: draft.issues
  }))
  const report: PreflightReport = {
    preflightId: input.preflightId,
    createdAt: input.createdAt,
    policyRev: policy.rev,
    capabilitiesRev: input.capabilities.summary.rev,
    jobs: entries,
    counts: reportCounts(entries),
    volumes: volumes.map((volume) => ({
      volume: volume.label,
      kind: volume.info.kind,
      trash: volume.info.trash,
      trashBytesFree: volume.info.trashBytesFree,
      trashBytesNeeded: volume.trashBytesNeeded,
      volumeBytes: volume.volumeBytes,
      freeBytes: volume.freeBytes,
      estimatedBytes: volume.estimatedBytes,
      status: volume.status
    })),
    collisions: [...claims.collisions.values()],
    blocking: distinctIssues(entries, 'error'),
    warnings: distinctIssues(entries, 'warning'),
    limits: input.limits
  }
  const summaries = entries.map((entry, index) => ({ jobId: entry.jobId, summary: planSummary(entry, drafts[index].base, platform) }))
  return { report, summaries }
}
