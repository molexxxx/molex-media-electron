/**
 * The Extract runner. One stream or a section of the source is written on its own: an audio stream picked from
 * the probe, the picture without its audio, a palette GIF, a folder of still frames, or a text subtitle stream.
 * Every trim is measured against the span it takes, so progress, the expected duration, and the frame count read
 * that span; frame folders escape the image sequence pattern; and every output is verified in the work folder
 * before the engine places it.
 */

import { promises as fsp } from 'fs'
import type { AudioFacts, EncoderPolicy, MediaFacts } from '../../../shared/audio/types'
import { factsFromProbe, resolvePick } from '../../../shared/jobs/applicability'
import { containerLabel } from '../../../shared/jobs/describe'
import type { ExtractRecipe, FrameSampling, TimeRange } from '../../../shared/jobs/recipes'
import type { JobError, JobErrorCode, OutputPlan, PlanIssue, StageId } from '../../../shared/jobs/types'
import { formatTimecode } from '../../../shared/jobs/time'
import type { Platform } from '../../../shared/text/platform'
import { filterComplex, pinStages } from '../../ffmpeg/audio/chains'
import { codecOfEncoder, containerFor } from '../../ffmpeg/audio/containers'
import type { ContainerSpec } from '../../ffmpeg/audio/containers'
import { DOWNMIX_LEVEL_CODECS, buildDownmixProbeArgs, downmixStage, parseDownmixInfo } from '../../ffmpeg/audio/downmix'
import type { DownmixLevels } from '../../ffmpeg/audio/downmix'
import { chooseEncoder, encoderArgs } from '../../ffmpeg/audio/encoders'
import type { BuildCapabilities, EncoderChoice, EncoderRefusal } from '../../ffmpeg/audio/encoders'
import { execArgv } from '../../ffmpeg/exec'
import type { ExecResult } from '../../ffmpeg/exec'
import { COMMAND_PREFIX, ERROR_TAIL_BYTES, quoteForDisplay, tailAtLineBoundary } from '../log'
import { OUTPUT_PLACEHOLDER, WMA_CONTAINERS, audioEncoderLabel, channelStages, ffmpegCause, levelsPlaceholder, videoFilters } from './convert'
import { execEnding } from './types'
import type { JobRunner, PlanInput, RunContext, RunnableJob, RunnerPlan, RunOutcome } from './types'
import { toVerification, verificationError, verifyMedia } from './verify-media'
import type { DurationExpectation, StreamCounts, SubtitleFormat, VerifyFiles, VerifyTarget } from './verify-media'

/** The most plays a GIF records: its loop field holds at most 65535 repeats. */
export const GIF_MAX_PLAYS = 65536

/** The image sequence pattern of a frame folder, without its extension. */
export const FRAME_PATTERN = 'frame_%06d'

/** Seconds as FFmpeg reads them, to the millisecond. */
export function secondsArg(sec: number): string
{
  return String(Math.round(sec * 1000) / 1000)
}

function knownDuration(sec: number | null): number | null
{
  return sec !== null && Number.isFinite(sec) && sec > 0 ? sec : null
}

/**
 * The span an Extract takes from its source: the range's duration, cut to what remains after its start when the
 * source duration is known; else what remains after the start; else the whole source. Null when the span is
 * unknown or the start lies past the end, never zero or negative.
 */
export function extractSpan(range: TimeRange | null, sourceSec: number | null): number | null
{
  const total = knownDuration(sourceSec)
  const start = range === null ? 0 : Math.max(0, range.startSec)
  const remaining = total === null ? null : total - start
  if (remaining !== null && remaining <= 0)
  {
    return null
  }
  const explicit = range === null ? null : knownDuration(range.durationSec)
  if (explicit !== null)
  {
    return remaining === null ? explicit : Math.min(explicit, remaining)
  }
  return remaining
}

/** The input options of a range, placed before -i so the seek is an input seek: -ss for a start, -t for a duration. */
export function rangeArgs(range: TimeRange | null): string[]
{
  if (range === null)
  {
    return []
  }
  const args: string[] = []
  if (range.startSec > 0)
  {
    args.push('-ss', secondsArg(range.startSec))
  }
  if (range.durationSec !== null && range.durationSec > 0)
  {
    args.push('-t', secondsArg(range.durationSec))
  }
  return args
}

function clampPlays(plays: number): number
{
  return Number.isFinite(plays) ? Math.min(GIF_MAX_PLAYS, Math.max(1, Math.round(plays))) : 1
}

/** The GIF muxer's -loop value: 0 repeats forever, -1 plays once, and N plays repeat N - 1 times. */
export function gifLoopArg(plays: 'infinite' | number): number
{
  if (plays === 'infinite')
  {
    return 0
  }
  const n = clampPlays(plays)
  return n === 1 ? -1 : n - 1
}

/** How a GIF's plays read: "Forever", "Play once", or "Play 3 times". */
export function gifPlaysLabel(plays: 'infinite' | number): string
{
  if (plays === 'infinite')
  {
    return 'Forever'
  }
  const n = clampPlays(plays)
  return n === 1 ? 'Play once' : `Play ${n} times`
}

/** Escapes a path for the image2 muxer, which reads % as the start of a sequence number: each literal % becomes %%. */
export function escapeImagePattern(file: string): string
{
  return file.replace(/%/g, '%%')
}

/** Joins a name to a folder with the folder's own separator, so a Windows path stays a Windows path on any host. */
export function joinInside(folder: string, name: string): string
{
  if (folder.endsWith('/') || folder.endsWith('\\'))
  {
    return `${folder}${name}`
  }
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return `${folder}${sep}${name}`
}

/** The output pattern of a frame folder: the escaped folder and frame_%06d with the format's extension. */
export function framePattern(folder: string, format: string): string
{
  return joinInside(escapeImagePattern(folder), `${FRAME_PATTERN}.${format}`)
}

/** The name of frame n (from 1) in a frame folder, as the image2 muxer writes it. */
export function frameFileName(n: number, format: string): string
{
  return `frame_${String(n).padStart(6, '0')}.${format}`
}

function issue(code: PlanIssue['code'], severity: PlanIssue['severity'], message: string, field: PlanIssue['field']): PlanIssue
{
  return { code, severity, message, field, fix: null }
}

function clampInt(value: number | null, min: number, max: number, fallback: number): number
{
  const n = value !== null && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

/** How a frame folder is sampled: the fps filter, the input seek of a thumbnail, and the frame count to expect. */
export interface FrameSamplingPlan
{
  /** The fps filter; null for a thumbnail, which takes one frame. */
  filter: string | null
  /** A thumbnail's input seek in seconds; null for a sequence, which reads the range. */
  seekSec: number | null
  /** The frames the output should hold, judged within one; null when the span is unknown. */
  expected: number | null
}

/**
 * The sampling of a frame folder over the span it reads. The fps filter writes round(span x rate) frames, measured on
 * both builds, so an interval of s seconds expects round(span / s), a rate f expects round(span x f), and a count is
 * spaced across the span itself, never the whole source. A thumbnail seeks to the middle of the span. Null when a
 * count meets an unknown span.
 */
export function frameSampling(sampling: FrameSampling, range: TimeRange | null, spanSec: number | null): FrameSamplingPlan | null
{
  const start = range === null ? 0 : Math.max(0, range.startSec)
  switch (sampling.by)
  {
    case 'thumbnail':
      return { filter: null, seekSec: spanSec === null ? start : start + spanSec / 2, expected: 1 }
    case 'fps':
    {
      const fps = Math.max(0.01, Number.isFinite(sampling.fps) ? sampling.fps : 1)
      return { filter: `fps=${fps}`, seekSec: null, expected: spanSec === null ? null : Math.max(1, Math.round(spanSec * fps)) }
    }
    case 'count':
    {
      if (spanSec === null)
      {
        return null
      }
      const count = clampInt(sampling.count, 1, 10000, 25)
      return { filter: `fps=${count / spanSec}`, seekSec: null, expected: count }
    }
    default:
    {
      const seconds = Math.max(0.05, Number.isFinite(sampling.seconds) ? sampling.seconds : 1)
      return { filter: `fps=1/${seconds}`, seekSec: null, expected: spanSec === null ? null : Math.max(1, Math.round(spanSec / seconds)) }
    }
  }
}

/** The image encoder of a frame format: PNG, MJPEG for JPEG, and libwebp. */
export const FRAME_ENCODERS: Readonly<Record<'png' | 'jpg' | 'webp', string>> = { png: 'png', jpg: 'mjpeg', webp: 'libwebp' }

/** The GIF filter graph: the frame rate, an optional width that keeps the aspect, and a two-branch palette, read from the picked picture. */
export function gifGraph(input: string, fps: number, width: number | null, dither: string): string
{
  const rate = clampInt(fps, 1, 60, 12)
  const scale = width === null || !Number.isFinite(width) || width <= 0 ? '' : `scale=${Math.round(width)}:-1:flags=lanczos,`
  return `[${input}]fps=${rate},${scale}split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=${dither}[gif]`
}

/** The encoder arguments of an Extract video re-encode at the recipe's CRF: x264 at the medium preset, VP9 in constant quality. */
export function reencodeArgs(reencode: { encoder: 'libx264' | 'libvpx-vp9'; crf: number }): string[]
{
  if (reencode.encoder === 'libvpx-vp9')
  {
    return ['-c:v:0', 'libvpx-vp9', '-crf', String(clampInt(reencode.crf, 0, 63, 31)), '-b:v:0', '0', '-row-mt', '1']
  }
  return ['-c:v:0', 'libx264', '-crf', String(clampInt(reencode.crf, 0, 51, 20)), '-preset', 'medium']
}

/** The audio stream of an audio Extract: copied, or encoded through chooseEncoder behind its channel and pin stages. */
export interface ExtractAudio
{
  source: AudioFacts
  /** Null for a copy. */
  choice: EncoderChoice | null
  /** The graph stages of an encode; empty for a copy. */
  stages: string[]
  /** Where the downmix or fold coefficients came from; null when the channels are kept. */
  coefficients: string | null
  /** An AC-3 or E-AC-3 stream folded to fewer channels, whose own downmix levels are read before the encode. */
  readsLevels: boolean
}

type AudioRecipe = Extract<ExtractRecipe, { mode: 'audio' }>

/** Whether a container holds a stream copy of an audio codec: one of its encoders writes that codec. */
export function copyFits(a: Pick<AudioFacts, 'codecName'>, container: ContainerSpec): boolean
{
  return [...container.audioEncoders].some((encoder) => codecOfEncoder(encoder) === a.codecName)
}

/** Whether a container takes only PCM, as WAV and AIFF do, so a copy it cannot hold keeps the samples as PCM. */
export function pcmOnly(container: ContainerSpec): boolean
{
  const encoders = [...container.audioEncoders]
  return encoders.length > 0 && encoders.every((encoder) => encoder.startsWith('pcm_'))
}

const REFUSAL_CODES: Readonly<Record<EncoderRefusal, PlanIssue['code']>> =
{
  'too-many-channels': 'too-many-channels',
  'layout-unsupported': 'layout-unsupported',
  'no-encoder': 'encoder-missing',
  'container-cannot-hold': 'container-cannot-hold'
}

function refusalIssue(reason: EncoderRefusal, encoder: string | null, maxChannels: number | null, channels: number, n: number, container: string): PlanIssue
{
  const label = encoder === null ? 'The chosen codec' : audioEncoderLabel(encoder)
  const field: PlanIssue['field'] = reason === 'no-encoder' ? 'encoder' : reason === 'container-cannot-hold' ? 'container' : 'streams'
  switch (reason)
  {
    case 'too-many-channels':
      return issue('too-many-channels', 'error', `${label} holds at most ${maxChannels ?? 2} channels; audio stream ${n} has ${channels}.`, field)
    case 'no-encoder':
      return issue(REFUSAL_CODES[reason], 'error', `This FFmpeg build has no encoder for audio stream ${n}${encoder === null ? '' : ` (${label})`}.`, field)
    case 'container-cannot-hold':
      return issue(REFUSAL_CODES[reason], 'error', `${containerLabel(container)} cannot hold ${label} audio.`, field)
    default:
      return issue(REFUSAL_CODES[reason], 'error', `Audio stream ${n} has a channel layout ${label} cannot write.`, field)
  }
}

/**
 * The picked audio stream as an audio Extract writes it. A copy keeps the stream bit for bit when the container holds
 * its codec; WAV and AIFF, which hold only PCM, take any other codec as PCM at the source's depth. An encode folds
 * channels only by the standard downmix or the mono fold, takes the recipe's rate when it has one, and pins the
 * encoder's rate, layout, and sample format, so a layout the encoder lacks is remapped explicitly and PCM keeps the
 * source's bit depth.
 */
export function planExtractAudio(recipe: Pick<AudioRecipe, 'audio' | 'channels' | 'sampleRate'>, a: AudioFacts, container: ContainerSpec,
  caps: BuildCapabilities, levels: DownmixLevels | null): { audio: ExtractAudio | null; issues: PlanIssue[] }
{
  const n = a.audioIndex + 1
  let policy: EncoderPolicy
  if (recipe.audio.kind === 'copy')
  {
    if (copyFits(a, container))
    {
      return { audio: { source: a, choice: null, stages: [], coefficients: null, readsLevels: false }, issues: [] }
    }
    if (!pcmOnly(container))
    {
      return { audio: null, issues: [issue('container-cannot-hold', 'error', `${containerLabel(container.name)} cannot hold a copy of audio stream ${n} (${a.codecName}).`, 'container')] }
    }
    policy = { kind: 'codec', codec: 'pcm', kbpsPerPair: null }
  }
  else
  {
    policy = recipe.audio
  }
  const folded = channelStages(recipe.channels, a, levels)
  if (folded === null)
  {
    return { audio: null, issues: [issue('layout-unsupported', 'error', `Audio stream ${n} has the ${a.layout ?? 'unknown'} layout, which has no ${recipe.channels} downmix.`, 'streams')] }
  }
  const rate = recipe.sampleRate ?? a.sampleRate
  const decision = chooseEncoder({ ...a, sampleRate: rate }, policy, container.name, { channels: folded.channels, layout: folded.layout, minSampleRate: null, video: false }, caps)
  if (!decision.ok)
  {
    return { audio: null, issues: [refusalIssue(decision.reason, decision.encoder, decision.maxChannels, folded.channels, n, container.name)] }
  }
  const choice = decision.choice
  if (decision.containerChanged || (choice.encoder === 'wmav2' && !WMA_CONTAINERS.has(container.name)))
  {
    return { audio: null, issues: [refusalIssue('container-cannot-hold', choice.encoder, null, folded.channels, n, container.name)] }
  }
  const issues: PlanIssue[] = []
  const label = audioEncoderLabel(choice.encoder)
  if (recipe.sampleRate !== null && choice.sampleRate !== recipe.sampleRate)
  {
    issues.push(issue('sample-rate-unsupported', 'warning', `${label} cannot write ${recipe.sampleRate} Hz; audio stream ${n} is written at ${choice.sampleRate} Hz.`, 'recipe'))
  }
  if (choice.notes.includes('layout-remapped'))
  {
    issues.push(issue('layout-remapped', 'info', `${label} has no ${folded.layout} layout; audio stream ${n} is written as ${choice.layout}.`, 'streams'))
  }
  const stages = [...folded.stages, ...pinStages({ sampleRate: choice.sampleRate, layout: choice.layout, pin: choice.pin, encoder: choice.encoder })]
  const readsLevels = folded.coefficients !== null && a.channels > 2 && DOWNMIX_LEVEL_CODECS.has(a.codecName)
  return { audio: { source: a, choice, stages, coefficients: folded.coefficients, readsLevels }, issues }
}

/** An audio Extract's stages with the pan of a stream whose own levels are read before the encode shown as a placeholder. */
export function withLevelsPlaceholder(audio: ExtractAudio): ExtractAudio
{
  const pan = downmixStage('standard', audio.source.layout ?? '', null)?.stage
  if (!audio.readsLevels || pan === undefined)
  {
    return audio
  }
  return { ...audio, stages: audio.stages.map((stage) => (stage === pan ? levelsPlaceholder(0) : stage)) }
}

/** What one Extract command is built from. */
export interface ExtractCommandInput
{
  source: string
  facts: MediaFacts
  recipe: ExtractRecipe
  /** The container the plan chose, lowercase without the dot. */
  container: string
  /** The muxer the plan chose, passed as -f; image2 for a frame folder. */
  muxer: string
  caps: BuildCapabilities
  /** The work file, or the frame folder. */
  output: string
  /** The downmix levels read from an AC-3 or E-AC-3 stream; null takes ITU-R BS.775-4. */
  levels: DownmixLevels | null
  /** Shows the pan of a stream whose levels are read before the encode as a placeholder, as the plan does. */
  showLevelsPlaceholder: boolean
}

/** How an Extract output is verified, besides its path. */
export type ExtractCheck =
  | { kind: 'media'; streams: StreamCounts; duration: DurationExpectation | null }
  | { kind: 'frames'; extension: string; expectedFrames: number | null }
  | { kind: 'subtitle'; format: SubtitleFormat }

/** An Extract command with its stream plan, its video work, and its verification. */
export interface ExtractCommand
{
  args: string[]
  streams: RunnerPlan['streams']
  video: RunnerPlan['video']
  class: RunnerPlan['class']
  /** The media span the run reads, for progress and the expected duration; null when unknown or a single frame. */
  spanSec: number | null
  check: ExtractCheck
  audio: ExtractAudio | null
}

const INPUT_PROBE = ['-analyzeduration', '200M', '-probesize', '200M']
const NO_COUNTS: StreamCounts = { video: 0, audio: 0, subtitle: 0, attachment: 0 }

function inputArgs(source: string, before: readonly string[]): string[]
{
  return ['-n', ...INPUT_PROBE, ...before, '-i', source]
}

function outputArgs(muxer: string, output: string): string[]
{
  return ['-map_chapters', '-1', '-f', muxer, output]
}

/** Every source stream except the one kept, dropped because the recipe takes one stream. */
function droppedExcept(facts: MediaFacts, kept: number): RunnerPlan['streams']['dropped']
{
  const all: Array<{ kind: string; source: number }> = [
    ...facts.video.map((v) => ({ kind: v.cover ? 'cover' : 'video', source: v.streamIndex })),
    ...facts.audio.map((a) => ({ kind: 'audio', source: a.streamIndex })),
    ...facts.subtitles.map((s) => ({ kind: 'subtitle', source: s.streamIndex })),
    ...facts.attachments.map((s) => ({ kind: 'attachment', source: s.streamIndex })),
    ...facts.data.map((s) => ({ kind: 'data', source: s.streamIndex }))
  ]
  return all
    .filter((s) => s.source !== kept)
    .sort((x, y) => x.source - y.source)
    .map((s) => ({ ...s, reason: 'policy' }))
}

function streamsOf(facts: MediaFacts, kind: string, source: number, action: 'copy' | 'encode' | 'convert'): RunnerPlan['streams']
{
  return { kept: [{ kind, source, output: 0, action }], dropped: droppedExcept(facts, source), chapters: facts.chapters > 0 ? 'dropped' : 'none' }
}

function sourceDuration(facts: MediaFacts): number | null
{
  return knownDuration(Number.isFinite(facts.durationSec) ? facts.durationSec : null)
}

/** The checks of a range against the source: a start at or after the end extracts nothing, so the plan refuses it. */
export function rangeIssues(range: TimeRange | null, facts: MediaFacts): PlanIssue[]
{
  const total = sourceDuration(facts)
  if (range === null || total === null || range.startSec < total)
  {
    return []
  }
  return [issue('invalid-recipe', 'error', `The range starts at ${formatTimecode(range.startSec)}, at or after the end of the source (${formatTimecode(total)}).`, 'recipe')]
}

/** The picture an Extract reads: the first video stream that is not cover art, as its N in 0:v:N. */
export function pictureIndex(facts: MediaFacts): number | null
{
  const index = facts.video.findIndex((v) => !v.cover)
  return index < 0 ? null : index
}

function noPicture(): PlanIssue
{
  return issue('no-video-stream', 'error', 'The source has no video stream to extract from.', 'streams')
}

function keyframeTrim(): PlanIssue
{
  return issue('keyframe-trim', 'warning', 'A stream copy starts at the keyframe at or before the range start, so the output can begin early and run longer than the range.', 'recipe')
}

function durationOf(spanSec: number | null, copiedTrim: boolean): DurationExpectation | null
{
  return spanSec === null ? null : { expectedSec: spanSec, rule: copiedTrim ? 'covers' : 'tolerance' }
}

function hasTrim(range: TimeRange | null): boolean
{
  return range !== null && (range.startSec > 0 || (range.durationSec !== null && range.durationSec > 0))
}

type Built = { command: ExtractCommand | null; issues: PlanIssue[] }

function audioCommand(input: ExtractCommandInput, recipe: AudioRecipe): Built
{
  const { facts } = input
  const index = resolvePick(factsFromProbe(facts).audio, recipe.stream)
  if (index === null)
  {
    const count = facts.audio.length
    return { command: null, issues: [issue('stream-not-found', 'error', `The audio stream the recipe picks is not in this source, which has ${count} audio stream${count === 1 ? '' : 's'}.`, 'streams')] }
  }
  const a = facts.audio[index]
  const planned = planExtractAudio(recipe, a, containerFor(input.container), input.caps, input.levels)
  if (planned.audio === null)
  {
    return { command: null, issues: planned.issues }
  }
  const audio = input.showLevelsPlaceholder ? withLevelsPlaceholder(planned.audio) : planned.audio
  const spanSec = extractSpan(recipe.range, sourceDuration(facts))
  const copy = audio.choice === null
  const codec = audio.choice === null
    ? ['-map', `0:a:${a.audioIndex}`, '-c:a:0', 'copy']
    : ['-filter_complex', filterComplex([{ input: `0:a:${a.audioIndex}`, stages: audio.stages, output: 'a0' }]), '-map', '[a0]', ...encoderArgs(audio.choice, 0)]
  return {
    command: {
      args: [...inputArgs(input.source, rangeArgs(recipe.range)), ...codec, ...outputArgs(input.muxer, input.output)],
      streams: streamsOf(facts, 'audio', a.streamIndex, copy ? 'copy' : 'encode'),
      video: null,
      class: copy ? 'copy' : 'audio',
      spanSec,
      check: { kind: 'media', streams: { ...NO_COUNTS, audio: 1 }, duration: durationOf(spanSec, copy && hasTrim(recipe.range)) },
      audio
    },
    issues: planned.issues
  }
}

function videoCommand(input: ExtractCommandInput, recipe: Extract<ExtractRecipe, { mode: 'video' }>): Built
{
  const { facts } = input
  const v = pictureIndex(facts)
  if (v === null)
  {
    return { command: null, issues: [noPicture()] }
  }
  const spanSec = extractSpan(recipe.range, sourceDuration(facts))
  const reencode = recipe.reencode
  const filters = reencode === null ? [] : videoFilters({ fit: null, fps: null, pixelFormat: 'yuv420p' }, reencode.encoder)
  const codec = reencode === null
    ? ['-c:v:0', 'copy']
    : [...reencodeArgs(reencode), ...(filters.length === 0 ? [] : ['-filter:v:0', filters.join(',')])]
  const copiedTrim = reencode === null && hasTrim(recipe.range)
  return {
    command: {
      args: [...inputArgs(input.source, rangeArgs(recipe.range)), '-map', `0:v:${v}`, ...codec, ...outputArgs(input.muxer, input.output)],
      streams: streamsOf(facts, 'video', facts.video[v].streamIndex, reencode === null ? 'copy' : 'encode'),
      video: reencode === null ? null : { encoder: reencode.encoder, gpu: null, lossless: 'not-requested', passes: 1, filters, notes: [], cpuFallback: null },
      class: reencode === null ? 'copy' : 'video-cpu',
      spanSec,
      check: { kind: 'media', streams: { ...NO_COUNTS, video: 1 }, duration: durationOf(spanSec, copiedTrim) },
      audio: null
    },
    issues: copiedTrim && (recipe.range?.startSec ?? 0) > 0 ? [keyframeTrim()] : []
  }
}

function gifCommand(input: ExtractCommandInput, recipe: Extract<ExtractRecipe, { mode: 'gif' }>): Built
{
  const { facts } = input
  const v = pictureIndex(facts)
  if (v === null)
  {
    return { command: null, issues: [noPicture()] }
  }
  const spanSec = extractSpan(recipe.range, sourceDuration(facts))
  const graph = gifGraph(`0:v:${v}`, recipe.fps, recipe.width, recipe.dither)
  return {
    command: {
      args: [
        ...inputArgs(input.source, rangeArgs(recipe.range)), '-filter_complex', graph, '-map', '[gif]',
        '-loop', String(gifLoopArg(recipe.plays)), ...outputArgs(input.muxer, input.output)
      ],
      streams: streamsOf(facts, 'video', facts.video[v].streamIndex, 'encode'),
      video: { encoder: 'gif', gpu: null, lossless: 'not-requested', passes: 1, filters: [graph], notes: [gifPlaysLabel(recipe.plays)], cpuFallback: null },
      class: 'video-cpu',
      spanSec,
      check: { kind: 'media', streams: { ...NO_COUNTS, video: 1 }, duration: durationOf(spanSec, false) },
      audio: null
    },
    issues: []
  }
}

function framesCommand(input: ExtractCommandInput, recipe: Extract<ExtractRecipe, { mode: 'frames' }>): Built
{
  const { facts } = input
  const v = pictureIndex(facts)
  if (v === null)
  {
    return { command: null, issues: [noPicture()] }
  }
  const spanSec = extractSpan(recipe.range, sourceDuration(facts))
  const sampling = frameSampling(recipe.sampling, recipe.range, spanSec)
  if (sampling === null)
  {
    return { command: null, issues: [issue('invalid-recipe', 'error', 'The source reports no duration, so a frame count cannot be spaced across it.', 'recipe')] }
  }
  const encoder = FRAME_ENCODERS[recipe.format]
  if (!input.caps.encoders.has(encoder))
  {
    return { command: null, issues: [issue('encoder-missing', 'error', `This FFmpeg build has no ${encoder} encoder for ${recipe.format.toUpperCase()} frames.`, 'encoder')] }
  }
  const seek = sampling.seekSec !== null && sampling.seekSec > 0 ? ['-ss', secondsArg(sampling.seekSec)] : []
  const before = sampling.seekSec === null ? rangeArgs(recipe.range) : seek
  const quality = recipe.format === 'jpg' ? ['-q:v:0', String(clampInt(recipe.jpgQuality, 2, 31, 2))] : []
  const select = sampling.filter === null ? ['-frames:v', '1'] : ['-filter:v:0', sampling.filter]
  return {
    command: {
      args: [
        ...inputArgs(input.source, before), '-map', `0:v:${v}`, ...select, '-c:v:0', encoder, ...quality,
        '-f', input.muxer, framePattern(input.output, recipe.format)
      ],
      streams: streamsOf(facts, 'video', facts.video[v].streamIndex, 'encode'),
      video: { encoder, gpu: null, lossless: 'not-requested', passes: 1, filters: sampling.filter === null ? [] : [sampling.filter], notes: [], cpuFallback: null },
      class: 'video-cpu',
      spanSec: sampling.filter === null ? null : spanSec,
      check: { kind: 'frames', extension: recipe.format, expectedFrames: sampling.expected },
      audio: null
    },
    issues: []
  }
}

/** The subtitle encoder and muxer of each text format. */
export const SUBTITLE_OUTPUTS: Readonly<Record<'srt' | 'vtt' | 'ass', { encoder: string; muxer: string }>> =
{
  srt: { encoder: 'srt', muxer: 'srt' },
  vtt: { encoder: 'webvtt', muxer: 'webvtt' },
  ass: { encoder: 'ass', muxer: 'ass' }
}

function subtitleCommand(input: ExtractCommandInput, recipe: Extract<ExtractRecipe, { mode: 'subtitles' }>): Built
{
  const { facts } = input
  const index = resolvePick(factsFromProbe(facts).subtitles ?? [], recipe.stream)
  if (index === null)
  {
    const count = facts.subtitles.length
    return { command: null, issues: [issue('stream-not-found', 'error', `The subtitle stream the recipe picks is not in this source, which has ${count} subtitle stream${count === 1 ? '' : 's'}.`, 'streams')] }
  }
  const s = facts.subtitles[index]
  if (s.bitmap)
  {
    const message = `Subtitle stream ${index + 1} is image-based (${s.codecName}), and FFmpeg converts only text subtitles to ${recipe.format.toUpperCase()}.`
    return { command: null, issues: [issue('subtitle-bitmap', 'error', message, 'streams')] }
  }
  const out = SUBTITLE_OUTPUTS[recipe.format]
  return {
    command: {
      args: [...inputArgs(input.source, []), '-map', `0:s:${index}`, '-c:s:0', out.encoder, ...outputArgs(input.muxer, input.output)],
      streams: streamsOf(facts, 'subtitle', s.streamIndex, 'convert'),
      video: null,
      class: 'copy',
      spanSec: sourceDuration(facts),
      check: { kind: 'subtitle', format: recipe.format },
      audio: null
    },
    issues: []
  }
}

/**
 * The FFmpeg arguments of an Extract, after exec's own prefix, with the stream it keeps, its video work, and how its
 * output is verified. Every stream is mapped explicitly, every range is an input seek, and the command is null when
 * an error issue refuses the job.
 */
export function buildExtractCommand(input: ExtractCommandInput): Built
{
  const { recipe } = input
  const range = recipe.mode === 'subtitles' ? null : recipe.range
  const refused = rangeIssues(range, input.facts)
  if (refused.length > 0)
  {
    return { command: null, issues: refused }
  }
  switch (recipe.mode)
  {
    case 'audio':
      return audioCommand(input, recipe)
    case 'video':
      return videoCommand(input, recipe)
    case 'gif':
      return gifCommand(input, recipe)
    case 'frames':
      return framesCommand(input, recipe)
    default:
      return subtitleCommand(input, recipe)
  }
}

function modeClass(recipe: ExtractRecipe): RunnerPlan['class']
{
  switch (recipe.mode)
  {
    case 'audio':
      return recipe.audio.kind === 'copy' ? 'copy' : 'audio'
    case 'video':
      return recipe.reencode === null ? 'copy' : 'video-cpu'
    case 'subtitles':
      return 'copy'
    default:
      return 'video-cpu'
  }
}

/** The bits per sample of a PCM encoder: 8 for pcm_u8, else the number in its name. */
export function pcmBits(encoder: string): number | null
{
  const match = /^pcm_[suf](\d+)/.exec(encoder)
  return match === null ? null : Number(match[1])
}

/**
 * The size an Extract should write over its span: exact for PCM, the bitrate for a rated encode or a copied stream
 * with a known rate, and the source's share of the span for a copied picture, which counts the dropped streams too
 * and so errs high. Null at low confidence otherwise.
 */
export function extractEstimate(command: ExtractCommand, facts: MediaFacts, sourceBytes: number): RunnerPlan['estimate']
{
  const span = command.spanSec
  const unknown: RunnerPlan['estimate'] = { outputBytes: null, workSec: null, confidence: 'low' }
  if (span === null)
  {
    return unknown
  }
  const audio = command.audio
  if (audio !== null)
  {
    const choice = audio.choice
    if (choice === null)
    {
      return audio.source.bitRate === null ? unknown : { outputBytes: Math.round(audio.source.bitRate / 8 * span), workSec: null, confidence: 'medium' }
    }
    const bits = pcmBits(choice.encoder)
    if (bits !== null)
    {
      return { outputBytes: Math.round(choice.sampleRate * choice.channels * bits / 8 * span), workSec: null, confidence: 'high' }
    }
    return choice.bitrateKbps === null ? unknown : { outputBytes: Math.round(choice.bitrateKbps * 125 * span), workSec: null, confidence: 'medium' }
  }
  const total = sourceDuration(facts)
  const copiedPicture = command.class === 'copy' && command.streams.kept.some((s) => s.kind === 'video')
  if (copiedPicture && total !== null && sourceBytes > 0)
  {
    return { outputBytes: Math.round(sourceBytes * Math.min(1, span / total)), workSec: null, confidence: 'low' }
  }
  return unknown
}

const STAGES: RunnerPlan['stages'] = [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }]

/**
 * An Extract's share of its plan: the command with the output, or the frame folder, as a placeholder and the pan of
 * a stream whose downmix levels are read before the encode as another; a refused job keeps its issues and no command.
 */
export function planExtract(input: PlanInput<ExtractRecipe>): RunnerPlan
{
  const { recipe, facts } = input
  const built = buildExtractCommand({
    source: input.source.path, facts, recipe, container: input.output.container, muxer: input.output.muxer, caps: input.caps,
    output: OUTPUT_PLACEHOLDER, levels: null, showLevelsPlaceholder: true
  })
  const command = built.command
  if (command === null)
  {
    return {
      command: null,
      streams: { kept: [], dropped: [], chapters: 'none' },
      video: null,
      audio: [],
      class: modeClass(recipe),
      stages: STAGES,
      estimate: { outputBytes: null, workSec: null, confidence: 'low' },
      issues: built.issues
    }
  }
  const argv = execArgv(command.args, 'kill')
  const placeholders = [OUTPUT_PLACEHOLDER, ...(command.audio?.readsLevels === true ? [levelsPlaceholder(0)] : [])]
  return {
    command: { argv, display: quoteForDisplay(['ffmpeg', ...argv], input.platform), placeholders },
    streams: command.streams,
    video: command.video,
    audio: [],
    class: command.class,
    stages: STAGES,
    estimate: extractEstimate(command, facts, input.source.size),
    issues: built.issues
  }
}

/** What the Extract runner reads besides its job and context. */
export interface ExtractRunnerDeps
{
  /** Whether a path exists; the work file or frame folder is checked right before the spawn. */
  exists(file: string): Promise<boolean>
  /** Creates a frame folder that does not exist yet; the image2 muxer creates none. */
  makeFolder(folder: string): Promise<void>
  /** The decode check's setting when the job verifies. */
  verifyVideo(): 'full' | 'sampled'
  platform: Platform
  files?: VerifyFiles
}

/** Creates one frame folder over `fs.promises`, failing when it already exists. */
export async function makeFrameFolder(folder: string): Promise<void>
{
  await fsp.mkdir(folder)
}

const ABORTED: RunOutcome = { kind: 'aborted' }
const MAX_LEVEL_LINES = 400

function messageOf(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

interface ErrorFacts
{
  code: JobErrorCode
  short: string
  message: string
  stage: StageId
  cause?: JobError['cause']
  result?: ExecResult
  argv?: string[]
}

function runError(job: RunnableJob<ExtractRecipe>, ctx: RunContext, deps: ExtractRunnerDeps, e: ErrorFacts): RunOutcome
{
  const error: JobError =
  {
    code: e.code,
    short: e.short,
    cause: e.cause ?? null,
    message: e.message,
    stage: e.stage,
    attempt: job.attempt,
    encodePass: e.stage === 'encode' ? 1 : null,
    exitCode: e.result?.code ?? null,
    exitName: e.result?.exitName ?? null,
    signal: e.result?.signal ?? null,
    stderrTail: e.result === undefined ? '' : tailAtLineBoundary(e.result.stderrTail, ERROR_TAIL_BYTES),
    command: e.argv === undefined ? null : { argv: e.argv, display: quoteForDisplay(['ffmpeg', ...e.argv], deps.platform) },
    fsError: null,
    hint: null,
    at: ctx.now()
  }
  return { kind: 'failed', error }
}

const CAUSE_TEXT: Readonly<Record<ReturnType<typeof ffmpegCause>, { short: string; lead: string }>> =
{
  encoder: { short: 'Encoder failed', lead: 'The encoder could not start' },
  muxer: { short: 'Container refused', lead: 'The output container refused the stream' },
  decode: { short: 'Source unreadable', lead: 'The source could not be decoded' },
  other: { short: 'FFmpeg failed', lead: 'FFmpeg could not extract from this file' }
}

function lastLine(text: string): string | null
{
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? null : lines[lines.length - 1]
}

/** The error a failed extraction ends with: a full disk, or FFmpeg's failure classified by its stderr, the cause first. */
function encodeFailure(job: RunnableJob<ExtractRecipe>, ctx: RunContext, deps: ExtractRunnerDeps, result: ExecResult, argv: string[]): RunOutcome
{
  const base = { stage: 'encode' as const, result, argv }
  if (/No space left on device/i.test(result.stderrTail))
  {
    return runError(job, ctx, deps, { ...base, code: 'disk-full', short: 'Disk full', message: 'The destination disk filled up during the extraction.' })
  }
  const cause = ffmpegCause(result.stderrTail)
  const text = CAUSE_TEXT[cause]
  const ended = result.signal !== null
    ? `FFmpeg was stopped by ${result.signal}`
    : `FFmpeg ended with exit code ${result.code}${result.exitName === null ? '' : ` (${result.exitName})`}`
  return runError(job, ctx, deps, { ...base, code: 'ffmpeg-failed', short: text.short, cause, message: `${text.lead}: ${lastLine(result.stderrTail) ?? `${ended}.`}` })
}

/** Reads the downmix levels of the AC-3 or E-AC-3 stream an audio Extract folds; null takes BS.775-4, undefined is an abort. */
async function readLevels(audio: ExtractAudio, source: string, ctx: RunContext): Promise<DownmixLevels | null | undefined>
{
  const lines: string[] = []
  const n = audio.source.audioIndex
  let result: ExecResult
  try
  {
    result = await ctx.exec.run(buildDownmixProbeArgs(source, n), {
      signal: ctx.signal,
      stop: 'kill',
      onStderrLine: (line) =>
      {
        if (lines.length < MAX_LEVEL_LINES)
        {
          lines.push(line)
        }
      }
    })
  }
  catch (error)
  {
    if (ctx.signal.aborted)
    {
      return undefined
    }
    ctx.log.warn(`Reading the downmix levels of audio stream ${n + 1} failed (${messageOf(error)}); it takes ITU-R BS.775-4.`)
    return null
  }
  if (result.aborted || ctx.signal.aborted)
  {
    return undefined
  }
  return execEnding(result).kind === 'completed' ? parseDownmixInfo(lines.join('\n')) : null
}

function displaces(output: OutputPlan): boolean
{
  return output.displaces !== null || output.resolution === 'overwrite' || output.resolution === 'replace-original'
}

/** The last segment of a path, with either separator. */
export function baseName(file: string): string
{
  const parts = file.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? file : parts[parts.length - 1]
}

const ENCODE_LABELS: Readonly<Record<ExtractRecipe['mode'], string>> =
{
  audio: 'Extracting audio',
  video: 'Extracting video',
  gif: 'Rendering the GIF',
  frames: 'Writing frames',
  subtitles: 'Converting subtitles'
}

function verifyTarget(check: ExtractCheck, path: string): VerifyTarget
{
  switch (check.kind)
  {
    case 'frames':
      return { kind: 'frames', path, extension: check.extension, expectedFrames: check.expectedFrames }
    case 'subtitle':
      return { kind: 'subtitle', path, format: check.format }
    default:
      return { kind: 'media', path, streams: check.streams, duration: check.duration, targetBytes: null, sourceBytes: null }
  }
}

/** Prepares the frame folder: an empty folder the engine made is used as it is, one with files in it is never written into. */
async function prepareFolder(folder: string, deps: ExtractRunnerDeps, files: VerifyFiles): Promise<'ready' | 'not-empty' | Error>
{
  try
  {
    if (await deps.exists(folder))
    {
      return (await files.list(folder)).length === 0 ? 'ready' : 'not-empty'
    }
    await deps.makeFolder(folder)
    return 'ready'
  }
  catch (error)
  {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** Runs one Extract job inside its work folder; placing the verified file or frame folder is the engine's. */
export async function runExtract(job: RunnableJob<ExtractRecipe>, ctx: RunContext, deps: ExtractRunnerDeps): Promise<RunOutcome>
{
  const { signal } = ctx
  if (signal.aborted)
  {
    return ABORTED
  }
  ctx.stage({ id: 'probe', pass: 1, passes: 1, label: 'Reading the source' })
  let facts: MediaFacts
  try
  {
    facts = await ctx.probe(job.source.path)
  }
  catch (error)
  {
    return signal.aborted
      ? ABORTED
      : runError(job, ctx, deps, { code: 'probe-failed', short: 'Probe failed', stage: 'probe', message: `The source could not be read: ${messageOf(error)}` })
  }
  if (signal.aborted)
  {
    return ABORTED
  }
  const { recipe } = job
  const folder = recipe.mode === 'frames'
  const output = folder ? ctx.outputFolder(baseName(job.plan.output.finalPath)) : ctx.output(job.plan.output.container, 1)
  const input = {
    source: job.source.path, facts, recipe, container: job.plan.output.container, muxer: job.plan.output.muxer, caps: ctx.caps,
    output, levels: null, showLevelsPlaceholder: false
  }
  let built = buildExtractCommand(input)
  if (built.command?.audio?.readsLevels === true)
  {
    const levels = await readLevels(built.command.audio, job.source.path, ctx)
    if (levels === undefined || signal.aborted)
    {
      return ABORTED
    }
    built = buildExtractCommand({ ...input, levels })
  }
  const command = built.command
  if (command === null)
  {
    const refusal = built.issues.find((i) => i.severity === 'error')
    return runError(job, ctx, deps, { code: 'plan-refused', short: 'Plan refused', stage: 'probe', message: refusal?.message ?? 'The recipe cannot run on this source.' })
  }
  const argv = execArgv(command.args, 'kill')
  const files = deps.files
  if (folder)
  {
    const prepared = await prepareFolder(output, deps, files ?? { size: async () => 0, text: async () => '', list: async (f) => (await fsp.readdir(f)).map((name) => ({ name, bytes: 0 })) })
    if (signal.aborted)
    {
      return ABORTED
    }
    if (prepared instanceof Error)
    {
      return runError(job, ctx, deps, { code: 'internal', short: 'Work folder failed', stage: 'encode', message: `The frame folder ${output} could not be made: ${prepared.message}` })
    }
    if (prepared === 'not-empty')
    {
      return runError(job, ctx, deps, { code: 'internal', short: 'Work folder in use', stage: 'encode', message: `The frame folder ${output} already holds files, so nothing was written into it.` })
    }
  }
  else
  {
    let present: boolean
    try
    {
      present = await deps.exists(output)
    }
    catch
    {
      present = true
    }
    if (signal.aborted)
    {
      return ABORTED
    }
    if (present)
    {
      return runError(job, ctx, deps, { code: 'internal', short: 'Work file exists', stage: 'encode', message: `The work file ${output} already exists, so nothing was written over it.` })
    }
  }
  ctx.stage({ id: 'encode', pass: 1, passes: 1, label: ENCODE_LABELS[recipe.mode] })
  ctx.log.info(`${COMMAND_PREFIX}${quoteForDisplay(['ffmpeg', ...argv], deps.platform)}`)
  const durationSec = command.spanSec
  let result: ExecResult
  try
  {
    result = await ctx.exec.run(command.args, {
      signal,
      stop: 'kill',
      ...(durationSec === null ? {} : { durationSec }),
      onProgress: (p) => ctx.progress({ outTimeSec: p.outTimeSec, durationSec, speed: p.speed, bytes: p.totalSize }),
      onStderrLine: (line) => ctx.log.ffmpeg(line)
    })
  }
  catch (error)
  {
    return signal.aborted
      ? ABORTED
      : runError(job, ctx, deps, { code: 'ffmpeg-unavailable', short: 'FFmpeg unavailable', stage: 'encode', message: `FFmpeg could not be started: ${messageOf(error)}`, argv })
  }
  const ending = execEnding(result)
  if (ending.kind === 'aborted' || signal.aborted)
  {
    return ABORTED
  }
  if (ending.kind === 'output-exists')
  {
    return runError(job, ctx, deps, { code: 'internal', short: 'Work file exists', stage: 'encode', message: `FFmpeg found the work file ${output} already there and wrote nothing.`, result, argv })
  }
  if (ending.kind === 'failed')
  {
    return encodeFailure(job, ctx, deps, result, argv)
  }
  ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' })
  const check = await verifyMedia(
    verifyTarget(command.check, output),
    { setting: deps.verifyVideo(), displacing: displaces(job.plan.output) },
    {
      exec: ctx.exec,
      signal,
      probe: (file) => ctx.probe(file),
      progress: (p) => ctx.progress(p),
      ...(files === undefined ? {} : { files })
    }
  )
  if (check.kind === 'aborted')
  {
    return ABORTED
  }
  if (check.verdict === 'failed')
  {
    return { kind: 'failed', error: verificationError(check, { attempt: job.attempt, encodePass: 1, at: ctx.now(), platform: deps.platform }) }
  }
  const frames = check.media.frames
  const cues = check.media.cues
  const notes = frames !== null
    ? [`${frames} frame${frames === 1 ? '' : 's'} written.`]
    : cues !== null ? [`${cues} cue${cues === 1 ? '' : 's'} written.`] : []
  const copiedPicture = recipe.mode === 'video' && recipe.reencode === null
  return {
    kind: 'output',
    artifact: {
      kind: folder ? 'folder' : 'file',
      path: output,
      container: job.plan.output.container,
      bytes: check.media.size.bytes,
      durationSec: check.media.durationSec,
      encoder: {
        video: command.video?.encoder ?? (copiedPicture ? 'copy' : null),
        audio: command.audio === null ? [] : [command.audio.choice?.encoder ?? 'copy']
      }
    },
    verification: toVerification(check, 1),
    measurement: null,
    notes
  }
}

/** The Extract runner. */
export function createExtractRunner(deps: ExtractRunnerDeps): JobRunner<ExtractRecipe>
{
  return {
    kind: 'extract',
    plan: planExtract,
    run: (job, ctx) => runExtract(job, ctx, deps)
  }
}
