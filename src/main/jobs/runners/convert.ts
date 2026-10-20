/**
 * The Convert runner. Video is copied or re-encoded with the recipe's FrameFit, frame rate, and pixel format;
 * every audio stream the container keeps is copied or encoded through the shared encoder, container, and stream
 * planners, with channels folded only by the standard downmix or the mono fold and every encoded stream pinned to
 * its encoder's rate, layout, and sample format. The output goes to the execution's work folder with an explicit
 * muxer and is verified there; placing it is the engine's.
 */

import { promises as fsp } from 'fs'
import type { AudioFacts, AudioOutput, EncoderPolicy, MediaFacts, OutputCodec } from '../../../shared/audio/types'
import { audioCodecLabel, containerLabel } from '../../../shared/jobs/describe'
import { codecFit, videoCodecName, videoEncoderFit } from '../../../shared/jobs/muxing'
import type { ChannelRule, ConvertRecipe, FrameFit, VideoEncoder } from '../../../shared/jobs/recipes'
import type { JobError, JobErrorCode, OutputPlan, PlanIssue, StageId } from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import { filterComplex, meterPrefix, pinStages } from '../../ffmpeg/audio/chains'
import type { FilterPart } from '../../ffmpeg/audio/chains'
import { containerFor } from '../../ffmpeg/audio/containers'
import type { ContainerSpec } from '../../ffmpeg/audio/containers'
import { DOWNMIX_LEVEL_CODECS, buildDownmixProbeArgs, downmixStage, monoFoldStage, parseDownmixInfo } from '../../ffmpeg/audio/downmix'
import type { DownmixLevels } from '../../ffmpeg/audio/downmix'
import { chooseEncoder } from '../../ffmpeg/audio/encoders'
import type { BuildCapabilities, EncoderRefusal } from '../../ffmpeg/audio/encoders'
import { audioToKeep, planStreams } from '../../ffmpeg/audio/streams'
import type { DropReason, StreamKind, StreamPlan } from '../../ffmpeg/audio/streams'
import { execArgv } from '../../ffmpeg/exec'
import type { ExecResult } from '../../ffmpeg/exec'
import { COMMAND_PREFIX, ERROR_TAIL_BYTES, quoteForDisplay, tailAtLineBoundary } from '../log'
import { execEnding } from './types'
import type { JobRunner, PlanInput, RunContext, RunnableJob, RunnerPlan, RunOutcome } from './types'
import { toVerification, verificationError, verifyMedia } from './verify-media'
import type { StreamCounts, VerifyFiles } from './verify-media'

/** The placeholder the planned command shows for the output path. */
export const OUTPUT_PLACEHOLDER = '{output}'

function even(value: number): number
{
  return Math.max(2, value - (value % 2))
}

function scaleBy(factor: string): string
{
  return `scale=w='trunc(iw*sar*${factor}/2)*2':h='trunc(ih*${factor}/2)*2'`
}

/**
 * The filters that apply a FrameFit to the picture as displayed: they run after FFmpeg's autorotation, measure the
 * width in square pixels (iw*sar), never scale up, keep the display aspect, and write even sizes with square
 * pixels. `fit` caps the picture inside the box; `pad` also pads it, centered, to the even box size; `crop` fills
 * the box and crops the overflow, centered. With one cap set, pad and crop act as fit.
 */
export function frameFitFilters(fit: FrameFit): string[]
{
  const { maxWidth, maxHeight } = fit
  if (maxWidth === null && maxHeight === null)
  {
    return []
  }
  const widthRatio = maxWidth === null ? null : `${maxWidth}/(iw*sar)`
  const heightRatio = maxHeight === null ? null : `${maxHeight}/ih`
  if (widthRatio === null || heightRatio === null || maxWidth === null || maxHeight === null)
  {
    return [scaleBy(`min(1,${widthRatio ?? heightRatio})`), 'setsar=1']
  }
  if (fit.mode === 'crop')
  {
    return [
      scaleBy(`min(1,max(${widthRatio},${heightRatio}))`),
      'setsar=1',
      `crop=w='min(${even(maxWidth)},iw)':h='min(${even(maxHeight)},ih)'`
    ]
  }
  const filters = [scaleBy(`min(1,min(${widthRatio},${heightRatio}))`), 'setsar=1']
  if (fit.mode === 'pad')
  {
    filters.push(`pad=${even(maxWidth)}:${even(maxHeight)}:(ow-iw)/2:(oh-ih)/2`)
  }
  return filters
}

/** Encoders that refuse odd frame sizes for subsampled pictures. */
export const EVEN_SIZE_ENCODERS: ReadonlySet<string> = new Set(['libx264', 'libx265', 'libsvtav1'])

/** Crops at most one pixel from the right and bottom edges so both dimensions are even; a no-op on even pictures. */
export const EVEN_CROP = "crop=w='trunc(iw/2)*2':h='trunc(ih/2)*2':x=0:y=0"

/**
 * The video filter chain of a re-encode: the FrameFit, then the frame rate, then the pixel format unless it is the
 * source's. Without a FrameFit, which always writes even sizes, an encoder that refuses odd sizes gets EVEN_CROP.
 */
export function videoFilters(video: { fit: FrameFit | null; fps: number | null; pixelFormat: string }, encoder: string | null = null): string[]
{
  const fit = video.fit === null ? [] : frameFitFilters(video.fit)
  return [
    ...(fit.length === 0 && encoder !== null && EVEN_SIZE_ENCODERS.has(encoder) ? [EVEN_CROP] : fit),
    ...(video.fps === null ? [] : [`fps=${video.fps}`]),
    ...(video.pixelFormat === 'source' ? [] : [`format=${video.pixelFormat}`])
  ]
}

/**
 * The quality each encoder runs at when the recipe names no bitrate, written out so the command states it: the
 * encoders' own CRF defaults for x264, x265, and SVT-AV1, constant quality for VP9 and AV1 (whose bitrate default
 * is a low target), and a fixed quantizer for the MPEG family, Theora, and WMV2. ProRes, FFV1, and UT Video take
 * no rate control.
 */
const QUALITY_DEFAULTS: Readonly<Record<VideoEncoder, ReadonlyArray<readonly [string, string]>>> =
{
  'libx264': [['crf', '23']],
  'libx265': [['crf', '28']],
  'libvpx-vp9': [['crf', '31'], ['b', '0']],
  'libaom-av1': [['crf', '32'], ['b', '0']],
  'libsvtav1': [['crf', '35']],
  'prores_ks': [],
  'ffv1': [],
  'utvideo': [],
  'mpeg2video': [['q', '3']],
  'mpeg4': [['q', '3']],
  'libtheora': [['q', '7']],
  'wmv2': [['q', '3']]
}

/** Encoders that write every frame without loss, so a bitrate means nothing to them. */
const UNRATED: ReadonlySet<string> = new Set(['prores_ks', 'ffv1', 'utvideo'])

/**
 * The encoder arguments of video output stream `k`: the encoder, then the recipe's bitrate, or the encoder's
 * quality default when the recipe names none. Every option carries the stream specifier, so cover art copied
 * beside the picture keeps its own codec.
 */
export function videoEncoderArgs(encoder: VideoEncoder, bitrateKbps: number | null, k: number): string[]
{
  const args = [`-c:v:${k}`, encoder]
  if (UNRATED.has(encoder))
  {
    return args
  }
  if (bitrateKbps !== null)
  {
    return [...args, `-b:v:${k}`, `${bitrateKbps}k`]
  }
  return [...args, ...QUALITY_DEFAULTS[encoder].flatMap(([option, value]) => [`-${option}:v:${k}`, value])]
}

/** One kept audio stream of the output: how it is written, and the graph part that filters it when it is encoded. */
export interface ConvertAudio
{
  source: AudioFacts
  output: AudioOutput
  /** Null for a copied stream. */
  part: FilterPart | null
  /** Where the downmix or fold coefficients came from; null when the channels are kept. */
  coefficients: string | null
  /** An AC-3 or E-AC-3 stream folded to fewer channels, whose own downmix levels are read before the encode. */
  readsLevels: boolean
}

/** The only containers a WMA stream is written to; Matroska accepts it, but Convert keeps WMA in its own family. */
export const WMA_CONTAINERS: ReadonlySet<string> = new Set(['wma', 'wmv', 'asf'])

const OUTPUT_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm', 'wmav2'])
const ENCODER_CODECS: Readonly<Record<string, OutputCodec>> = { libmp3lame: 'mp3', libopus: 'opus', libvorbis: 'vorbis', wmav1: 'wmav2' }

/** The name people read for an audio encoder or codec: libmp3lame is MP3, pcm_s16le is PCM. */
export function audioEncoderLabel(encoder: string): string
{
  if (Object.hasOwn(ENCODER_CODECS, encoder))
  {
    return audioCodecLabel(ENCODER_CODECS[encoder])
  }
  if (encoder.startsWith('pcm_'))
  {
    return audioCodecLabel('pcm')
  }
  return OUTPUT_CODECS.has(encoder) ? audioCodecLabel(encoder as OutputCodec) : encoder.toUpperCase()
}

function channelIssue(code: EncoderRefusal | 'layout-unsupported', message: string): PlanIssue
{
  const codes: Readonly<Record<EncoderRefusal, PlanIssue['code']>> =
  {
    'too-many-channels': 'too-many-channels',
    'layout-unsupported': 'layout-unsupported',
    'no-encoder': 'encoder-missing',
    'container-cannot-hold': 'container-cannot-hold'
  }
  return { code: codes[code], severity: 'error', message, field: code === 'no-encoder' ? 'encoder' : code === 'container-cannot-hold' ? 'container' : 'streams', fix: null }
}

function refusalMessage(refusal: EncoderRefusal, encoder: string | null, maxChannels: number | null, channels: number, n: number, container: string): string
{
  const label = encoder === null ? 'The chosen codec' : audioEncoderLabel(encoder)
  switch (refusal)
  {
    case 'too-many-channels':
      return `${label} holds at most ${maxChannels ?? 2} channels; audio stream ${n} has ${channels}.`
    case 'no-encoder':
      return `This FFmpeg build has no encoder for audio stream ${n}${encoder === null ? '' : ` (${label})`}.`
    case 'container-cannot-hold':
      return `${containerLabel(container)} cannot hold ${label} audio.`
    default:
      return `Audio stream ${n} has a channel layout ${label} cannot write.`
  }
}

/**
 * The channel stages of one encoded stream under the channel rule: the standard stereo downmix for more than two
 * channels, the mono fold for two or more, or nothing. Null when the layout has no downmix.
 */
export function channelStages(rule: ChannelRule, a: AudioFacts, levels: DownmixLevels | null):
  { stages: string[]; channels: number; layout: string; coefficients: string | null } | null
{
  const layout = a.layout ?? ''
  if (rule === 'stereo' && a.channels > 2)
  {
    const downmix = downmixStage('standard', layout, levels)
    if (downmix === null)
    {
      return null
    }
    const stages = meterPrefix({ inputLayout: layout, monoToStereo: false, downmix: 'standard', downmixLevels: levels, dynamics: null })
    return { stages, channels: 2, layout: 'stereo', coefficients: downmix.coefficients }
  }
  if (rule === 'mono' && a.channels >= 2)
  {
    const fold = monoFoldStage(layout, levels)
    return fold === null ? null : { stages: fold.stages, channels: 1, layout: 'mono', coefficients: fold.coefficients }
  }
  return { stages: [], channels: a.channels, layout, coefficients: null }
}

/**
 * The audio streams of a Convert output: the ones the container keeps, each copied, or encoded through
 * chooseEncoder with its channels folded only by channelStages and its rate, layout, and sample format pinned by
 * pinStages, so FFmpeg never converts channels on its own. `levels` holds the downmix levels read from AC-3 and
 * E-AC-3 streams; a stream without an entry takes BS.775-4.
 */
export function planConvertAudio(recipe: Pick<ConvertRecipe, 'audio' | 'channels'>, facts: MediaFacts, container: ContainerSpec,
  caps: BuildCapabilities, levels: ReadonlyMap<number, DownmixLevels | null>, video: boolean): { streams: ConvertAudio[]; issues: PlanIssue[] }
{
  const streams: ConvertAudio[] = []
  const issues: PlanIssue[] = []
  const policy: EncoderPolicy | null = recipe.audio.kind === 'copy' ? null : recipe.audio
  for (const a of audioToKeep(facts, container))
  {
    const k = streams.length
    const n = a.audioIndex + 1
    if (policy === null)
    {
      streams.push({ source: a, output: { audioIndex: a.audioIndex, outIndex: k, label: null, choice: null }, part: null, coefficients: null, readsLevels: false })
      continue
    }
    const folded = channelStages(recipe.channels, a, levels.get(a.audioIndex) ?? null)
    if (folded === null)
    {
      issues.push(channelIssue('layout-unsupported', `Audio stream ${n} has the ${a.layout ?? 'unknown'} layout, which has no ${recipe.channels} downmix.`))
      continue
    }
    const decision = chooseEncoder(a, policy, container.name, { channels: folded.channels, layout: folded.layout, minSampleRate: null, video }, caps)
    if (!decision.ok)
    {
      issues.push(channelIssue(decision.reason, refusalMessage(decision.reason, decision.encoder, decision.maxChannels, folded.channels, n, container.name)))
      continue
    }
    if (decision.containerChanged)
    {
      issues.push(channelIssue('container-cannot-hold', refusalMessage('container-cannot-hold', decision.choice.encoder, null, folded.channels, n, container.name)))
      continue
    }
    const choice = decision.choice
    if (choice.encoder === 'wmav2' && !WMA_CONTAINERS.has(container.name))
    {
      issues.push(channelIssue('container-cannot-hold', refusalMessage('container-cannot-hold', choice.encoder, null, folded.channels, n, container.name)))
      continue
    }
    const stages = [...folded.stages, ...pinStages({ sampleRate: choice.sampleRate, layout: choice.layout, pin: choice.pin, encoder: choice.encoder })]
    streams.push({
      source: a,
      output: { audioIndex: a.audioIndex, outIndex: k, label: `[a${k}]`, choice },
      part: { input: `0:a:${a.audioIndex}`, stages, output: `a${k}` },
      coefficients: folded.coefficients,
      readsLevels: folded.coefficients !== null && a.channels > 2 && DOWNMIX_LEVEL_CODECS.has(a.codecName)
    })
  }
  return { streams, issues }
}

/** What one Convert command is built from. */
export interface ConvertCommandInput
{
  source: string
  facts: MediaFacts
  recipe: ConvertRecipe
  container: ContainerSpec
  /** The muxer the plan chose, passed as -f. */
  muxer: string
  audio: readonly ConvertAudio[]
  /** A leased hardware encoder that writes the picture in place of the recipe's encoder; null for the CPU. */
  gpuEncoder: string | null
  output: string
}

/** A Convert command with the stream plan it maps and the video it encodes. */
export interface ConvertCommand
{
  args: string[]
  streams: StreamPlan
  /** The encoder and filters of every re-encoded picture; null when the video is copied or the output holds none. */
  video: { encoder: string; filters: string[] } | null
}

function withoutVideoCopy(codecArgs: readonly string[]): string[]
{
  const index = codecArgs.findIndex((arg, i) => arg === '-c:v' && codecArgs[i + 1] === 'copy')
  return index === -1 ? [...codecArgs] : [...codecArgs.slice(0, index), ...codecArgs.slice(index + 2)]
}

/**
 * The FFmpeg arguments of a Convert, after exec's own prefix: -n, the source, the audio graph, an explicit map of
 * every kept stream in source order, per-stream codecs, the FrameFit chain of each re-encoded picture, the muxer,
 * and the output. Cover art keeps a copy beside a re-encoded picture, and nothing is left to FFmpeg's automatic
 * stream selection or channel conversion.
 */
export function buildConvertArgs(input: ConvertCommandInput): ConvertCommand
{
  const { recipe, facts } = input
  const streams = planStreams(facts, input.container, input.audio.map((a) => a.output), {
    keepSubtitles: recipe.subtitles === 'keep',
    keepGlobalTags: true,
    keepCoverArt: true
  })
  const parts = input.audio.flatMap((a) => (a.part === null ? [] : [a.part]))
  const graph = parts.length === 0 ? [] : ['-filter_complex', filterComplex(parts)]
  const encode = recipe.video !== null && recipe.video.encoder !== 'copy' ? recipe.video : null
  const kept = streams.kept.filter((s) => s.kind === 'video' || s.kind === 'cover')
  let video: ConvertCommand['video'] = null
  let videoArgs: string[] = []
  if (encode !== null && kept.some((s) => s.kind === 'video'))
  {
    const encoder = input.gpuEncoder ?? encode.encoder
    const filters = input.gpuEncoder === null
      ? videoFilters(encode, encode.encoder)
      : videoFilters({ fit: encode.fit, fps: encode.fps, pixelFormat: 'source' })
    video = { encoder, filters }
    videoArgs = kept.flatMap((s, k) =>
    {
      if (s.kind === 'cover')
      {
        return [`-c:v:${k}`, 'copy']
      }
      const codec = input.gpuEncoder === null
        ? videoEncoderArgs(encode.encoder as VideoEncoder, encode.bitrateKbps, k)
        : [`-c:v:${k}`, input.gpuEncoder, ...(encode.bitrateKbps === null ? [] : [`-b:v:${k}`, `${encode.bitrateKbps}k`])]
      return [...codec, ...(filters.length === 0 ? [] : [`-filter:v:${k}`, filters.join(',')])]
    })
  }
  const codecArgs = video === null ? streams.codecArgs : [...videoArgs, ...withoutVideoCopy(streams.codecArgs)]
  const args = [
    '-n', '-analyzeduration', '200M', '-probesize', '200M', '-i', input.source,
    ...graph, ...streams.mapArgs, ...codecArgs, ...streams.metadataArgs,
    '-f', input.muxer, input.output
  ]
  return { args, streams, video }
}

/** The stream counts an output should hold under its stream plan; cover art counts as video, as ffprobe reports it. */
export function plannedCounts(streams: Pick<StreamPlan, 'kept'>): StreamCounts
{
  const counts: StreamCounts = { video: 0, audio: 0, subtitle: 0, attachment: 0 }
  for (const s of streams.kept)
  {
    if (s.kind === 'video' || s.kind === 'cover')
    {
      counts.video += 1
    }
    else if (s.kind === 'audio' || s.kind === 'subtitle' || s.kind === 'attachment')
    {
      counts[s.kind] += 1
    }
  }
  return counts
}

/** The placeholder a planned command shows where a stream's own downmix levels are read before the encode. */
export function levelsPlaceholder(k: number): string
{
  return `{downmix-a${k}}`
}

function withLevelsPlaceholder(a: ConvertAudio): ConvertAudio
{
  const pan = downmixStage('standard', a.source.layout ?? '', null)?.stage
  if (a.part === null || pan === undefined)
  {
    return a
  }
  const placeholder = levelsPlaceholder(a.output.outIndex)
  return { ...a, part: { ...a.part, stages: a.part.stages.map((stage) => (stage === pan ? placeholder : stage)) } }
}

function issue(code: PlanIssue['code'], severity: PlanIssue['severity'], message: string, field: PlanIssue['field']): PlanIssue
{
  return { code, severity, message, field, fix: null }
}

/**
 * The video checks of a Convert: a copied picture must fit the container, and a re-encode needs its encoder in the
 * build and a container that holds its codec, per the measured table. A container without video drops the picture,
 * which the stream issues report.
 */
export function videoIssues(recipe: ConvertRecipe, facts: MediaFacts, container: ContainerSpec, caps: BuildCapabilities): PlanIssue[]
{
  const pictures = facts.video.filter((stream) => !stream.cover)
  if (!container.video || pictures.length === 0)
  {
    return []
  }
  const video = recipe.video
  if (video === null || video.encoder === 'copy')
  {
    return pictures.flatMap((stream) =>
    {
      const fit = codecFit(stream.codecName, container.name)
      return fit === null || fit.ok ? [] : [issue('container-cannot-hold', 'error', fit.reason ?? '', 'container')]
    })
  }
  const issues: PlanIssue[] = []
  if (!caps.encoders.has(video.encoder) || caps.experimental.has(video.encoder))
  {
    issues.push(issue('encoder-missing', 'error', `This FFmpeg build has no ${videoCodecName(video.encoder)} encoder (${video.encoder}).`, 'encoder'))
  }
  const fit = videoEncoderFit(video.encoder, container.name)
  if (fit !== null && !fit.ok)
  {
    issues.push(issue('container-cannot-hold', 'error', fit.reason ?? '', 'container'))
  }
  return issues
}

const KIND_NOUNS: Readonly<Record<StreamKind, string>> =
{
  video: 'video stream',
  cover: 'cover image',
  audio: 'audio stream',
  subtitle: 'subtitle stream',
  attachment: 'attachment',
  data: 'data stream'
}

function dropReason(reason: DropReason, label: string): string
{
  switch (reason)
  {
    case 'container-no-video':
      return `${label} holds no video`
    case 'container-one-audio':
      return `${label} holds one audio stream`
    case 'subtitle-unsupported':
      return `${label} cannot hold these subtitles`
    case 'bitmap-subtitle':
      return `${label} cannot hold bitmap subtitles`
    case 'attachments-unsupported':
      return `${label} cannot hold attachments`
    case 'cover-unsupported':
      return `${label} cannot hold cover art`
    case 'data-stream':
      return 'data streams are not kept'
    default:
      return 'the recipe drops them'
  }
}

/**
 * The info issues of a stream plan: every dropped stream, grouped by kind and reason, and dropped chapters. An
 * audio stream left out because its own encode was refused is not repeated here; its refusal already blocks the job.
 */
export function streamIssues(streams: Pick<StreamPlan, 'dropped' | 'chapters'>, container: ContainerSpec): PlanIssue[]
{
  const label = containerLabel(container.name)
  const groups = new Map<string, { kind: StreamKind; reason: DropReason; count: number }>()
  for (const d of streams.dropped)
  {
    if (d.kind === 'audio' && d.reason === 'policy')
    {
      continue
    }
    const key = `${d.kind} ${d.reason}`
    const group = groups.get(key) ?? { kind: d.kind, reason: d.reason, count: 0 }
    group.count += 1
    groups.set(key, group)
  }
  const issues = [...groups.values()].map((g) =>
    issue('streams-dropped', 'info', `${g.count} ${KIND_NOUNS[g.kind]}${g.count === 1 ? '' : 's'} dropped: ${dropReason(g.reason, label)}.`, 'streams'))
  if (streams.chapters === 'dropped')
  {
    issues.push(issue('chapters-dropped', 'info', `${label} cannot hold chapters, so they are dropped.`, 'streams'))
  }
  return issues
}

/** The video plan shown before the run: the encoder and filters of a re-encode, 'copy', or null without a picture. */
export function convertVideoPlan(command: ConvertCommand): RunnerPlan['video']
{
  if (!command.streams.kept.some((s) => s.kind === 'video'))
  {
    return null
  }
  const video = command.video ?? { encoder: 'copy', filters: [] }
  return { encoder: video.encoder, gpu: null, lossless: 'not-requested', passes: 1, filters: video.filters, notes: [], cpuFallback: null }
}

/**
 * The output size as bitrate times duration when every kept stream has a known rate (a copied stream its source
 * rate, a re-encoded picture the recipe's bitrate), else the source size with low confidence.
 */
export function convertEstimate(recipe: ConvertRecipe, facts: MediaFacts, command: ConvertCommand, audio: readonly ConvertAudio[], sourceBytes: number):
  RunnerPlan['estimate']
{
  const durationSec = Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null
  const picture = command.streams.kept.some((s) => s.kind === 'video')
  const bitrate = recipe.video?.bitrateKbps ?? null
  const videoKbps = !picture ? 0 : command.video !== null && bitrate !== null && !UNRATED.has(command.video.encoder) ? bitrate : null
  const audioKbps = audio.map((a) => (a.output.choice === null ? (a.source.bitRate === null ? null : a.source.bitRate / 1000) : a.output.choice.bitrateKbps))
  if (durationSec === null || videoKbps === null || audioKbps.some((kbps) => kbps === null))
  {
    return { outputBytes: sourceBytes, workSec: null, confidence: 'low' }
  }
  const kbps = audioKbps.reduce<number>((sum, value) => sum + (value ?? 0), videoKbps)
  return { outputBytes: Math.round(kbps * 125 * durationSec), workSec: null, confidence: 'medium' }
}

/**
 * The Convert runner's plan: the stream plan, video and audio decisions, issues, and the command as it will run,
 * with the work path and any downmix levels read at run time written as placeholders.
 */
export function planConvert(input: PlanInput<ConvertRecipe>): RunnerPlan
{
  const { recipe, facts, caps } = input
  const container = containerFor(input.output.container)
  const audio = planConvertAudio(recipe, facts, container, caps, new Map(), container.video)
  const shown = audio.streams.map((a) => (a.readsLevels ? withLevelsPlaceholder(a) : a))
  const command = buildConvertArgs({
    source: input.source.path, facts, recipe, container, muxer: input.output.muxer, audio: shown, gpuEncoder: null, output: OUTPUT_PLACEHOLDER
  })
  const argv = execArgv(command.args, 'kill')
  const placeholders = [OUTPUT_PLACEHOLDER, ...shown.filter((a) => a.readsLevels).map((a) => levelsPlaceholder(a.output.outIndex))]
  const encodesAudio = audio.streams.some((a) => a.part !== null)
  return {
    command: { argv, display: quoteForDisplay(['ffmpeg', ...argv], input.platform), placeholders },
    streams: { kept: command.streams.kept, dropped: command.streams.dropped, chapters: command.streams.chapters },
    video: convertVideoPlan(command),
    audio: [],
    class: command.video !== null ? 'video-cpu' : encodesAudio ? 'audio' : 'copy',
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }],
    estimate: convertEstimate(recipe, facts, command, audio.streams, input.source.size),
    issues: [...videoIssues(recipe, facts, container, caps), ...audio.issues, ...streamIssues(command.streams, container)]
  }
}

/** What the Convert runner reads besides its job and context. */
export interface ConvertRunnerDeps
{
  /** Whether a path exists; the output path is checked right before the spawn. */
  exists(file: string): Promise<boolean>
  /** The decode check's setting when the job verifies. */
  verifyVideo(): 'full' | 'sampled'
  platform: Platform
  files?: VerifyFiles
}

/** Whether a path exists, over `fs.promises`; anything but ENOENT counts as present, so nothing is written over it. */
export async function pathExists(file: string): Promise<boolean>
{
  try
  {
    await fsp.lstat(file)
    return true
  }
  catch (error)
  {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

const ABORTED: RunOutcome = { kind: 'aborted' }
const MAX_LEVEL_LINES = 400

function messageOf(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

/** The category of a failed FFmpeg run, read from its stderr. */
export function ffmpegCause(stderr: string): 'decode' | 'encoder' | 'muxer' | 'other'
{
  if (/Error while opening encoder|Error initializing output stream|Unknown encoder|Error setting encoder|Cannot open \S+ encoder/i.test(stderr))
  {
    return 'encoder'
  }
  if (/Could not write header|not currently supported in container|Error writing trailer|Error opening output|muxing/i.test(stderr))
  {
    return 'muxer'
  }
  if (/Error while decoding|Invalid data found when processing input|Error during demuxing|decode_slice/i.test(stderr))
  {
    return 'decode'
  }
  return 'other'
}

const CAUSE_TEXT: Readonly<Record<ReturnType<typeof ffmpegCause>, { short: string; lead: string }>> =
{
  encoder: { short: 'Encoder failed', lead: 'The encoder could not start' },
  muxer: { short: 'Container refused', lead: 'The output container refused a stream' },
  decode: { short: 'Source unreadable', lead: 'The source could not be decoded' },
  other: { short: 'FFmpeg failed', lead: 'FFmpeg could not convert this file' }
}

function lastLine(text: string): string | null
{
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? null : lines[lines.length - 1]
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

function runError(job: RunnableJob<ConvertRecipe>, ctx: RunContext, deps: ConvertRunnerDeps, e: ErrorFacts): RunOutcome
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

/**
 * The error a failed encode ends with: a GPU session limit or start failure when the lease recognizes it, a full
 * disk, or FFmpeg's failure classified by its stderr, the cause first and FFmpeg's last line after it.
 */
function encodeFailure(job: RunnableJob<ConvertRecipe>, ctx: RunContext, deps: ConvertRunnerDeps, result: ExecResult, argv: string[]): RunOutcome
{
  const base = { stage: 'encode' as const, result, argv }
  const gpu = ctx.gpu?.classify(result.stderrTail) ?? null
  if (gpu === 'session-limit')
  {
    return runError(job, ctx, deps, { ...base, code: 'gpu-session-limit', short: 'GPU sessions full', message: 'The GPU has no free encoder session.' })
  }
  if (gpu === 'init-failed')
  {
    return runError(job, ctx, deps, { ...base, code: 'gpu-init-failed', short: 'GPU failed to start', message: `The ${ctx.gpu?.encoder ?? 'GPU'} encoder could not start.` })
  }
  if (/No space left on device/i.test(result.stderrTail))
  {
    return runError(job, ctx, deps, { ...base, code: 'disk-full', short: 'Disk full', message: 'The destination disk filled up during the encode.' })
  }
  const cause = ffmpegCause(result.stderrTail)
  const text = CAUSE_TEXT[cause]
  const last = lastLine(result.stderrTail)
  const ended = result.signal !== null
    ? `FFmpeg was stopped by ${result.signal}`
    : `FFmpeg ended with exit code ${result.code}${result.exitName === null ? '' : ` (${result.exitName})`}`
  return runError(job, ctx, deps, { ...base, code: 'ffmpeg-failed', short: text.short, cause, message: `${text.lead}: ${last ?? `${ended}.`}` })
}

/**
 * Reads the downmix levels of the AC-3 and E-AC-3 streams the output folds; a stream whose read fails or carries
 * none takes BS.775-4. Null when the signal aborted.
 */
async function readLevels(streams: readonly ConvertAudio[], source: string, ctx: RunContext): Promise<Map<number, DownmixLevels | null> | null>
{
  const levels = new Map<number, DownmixLevels | null>()
  for (const a of streams)
  {
    const lines: string[] = []
    const n = a.source.audioIndex
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
        return null
      }
      ctx.log.warn(`Reading the downmix levels of audio stream ${n + 1} failed (${messageOf(error)}); it takes ITU-R BS.775-4.`)
      levels.set(n, null)
      continue
    }
    if (result.aborted || ctx.signal.aborted)
    {
      return null
    }
    levels.set(n, execEnding(result).kind === 'completed' ? parseDownmixInfo(lines.join('\n')) : null)
  }
  return levels
}

function displaces(output: OutputPlan): boolean
{
  return output.displaces !== null || output.resolution === 'overwrite' || output.resolution === 'replace-original'
}

/** Runs one Convert job inside its work folder; placing the verified output is the engine's. */
export async function runConvert(job: RunnableJob<ConvertRecipe>, ctx: RunContext, deps: ConvertRunnerDeps): Promise<RunOutcome>
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
  const container = containerFor(job.plan.output.container)
  const first = planConvertAudio(recipe, facts, container, ctx.caps, new Map(), container.video)
  const levels = await readLevels(first.streams.filter((a) => a.readsLevels), job.source.path, ctx)
  if (levels === null || signal.aborted)
  {
    return ABORTED
  }
  const planned = levels.size === 0 ? first : planConvertAudio(recipe, facts, container, ctx.caps, levels, container.video)
  const refusal = [...videoIssues(recipe, facts, container, ctx.caps), ...planned.issues].find((i) => i.severity === 'error')
  if (refusal !== undefined)
  {
    return runError(job, ctx, deps, { code: 'plan-refused', short: 'Plan refused', stage: 'probe', message: refusal.message })
  }
  const output = ctx.output(job.plan.output.container, 1)
  const command = buildConvertArgs({
    source: job.source.path, facts, recipe, container, muxer: job.plan.output.muxer, audio: planned.streams, gpuEncoder: ctx.gpu?.encoder ?? null, output
  })
  const argv = execArgv(command.args, 'kill')
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
  ctx.stage({ id: 'encode', pass: 1, passes: 1, label: 'Converting' })
  ctx.log.info(`${COMMAND_PREFIX}${quoteForDisplay(['ffmpeg', ...argv], deps.platform)}`)
  const durationSec = Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null
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
    {
      kind: 'media',
      path: output,
      streams: plannedCounts(command.streams),
      duration: durationSec === null ? null : { expectedSec: durationSec, rule: 'tolerance' },
      targetBytes: null,
      sourceBytes: null
    },
    { setting: deps.verifyVideo(), displacing: displaces(job.plan.output) },
    {
      exec: ctx.exec,
      signal,
      probe: (file) => ctx.probe(file),
      progress: (p) => ctx.progress(p),
      ...(deps.files === undefined ? {} : { files: deps.files })
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
  const picture = command.streams.kept.some((s) => s.kind === 'video')
  return {
    kind: 'output',
    artifact: {
      kind: 'file',
      path: output,
      container: job.plan.output.container,
      bytes: check.media.size.bytes,
      durationSec: check.media.durationSec,
      encoder: { video: command.video?.encoder ?? (picture ? 'copy' : null), audio: planned.streams.map((a) => a.output.choice?.encoder ?? 'copy') }
    },
    verification: toVerification(check, 1),
    measurement: null,
    notes: []
  }
}

/** The Convert runner. */
export function createConvertRunner(deps: ConvertRunnerDeps): JobRunner<ConvertRecipe>
{
  return {
    kind: 'convert',
    plan: planConvert,
    run: (job, ctx) => runConvert(job, ctx, deps)
  }
}
