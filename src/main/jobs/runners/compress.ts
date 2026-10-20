/**
 * The Compress runner: re-encodes the picture at a quality tier, a CRF, or a size target, keeps every stream the
 * container holds through an explicit map, and writes only inside the execution's work folder, two-pass statistics
 * included.
 */

import { promises as fsp } from 'fs'
import * as path from 'path'
import type { MediaFacts } from '../../../shared/audio/types'
import { videoCodecName, videoEncoderFit } from '../../../shared/jobs/muxing'
import type { CompressRecipe, CompressTarget, FrameFit, VideoEncoder } from '../../../shared/jobs/recipes'
import type { JobError, JobErrorCode, MediaSummary, OutputPlan, PlanIssue, SourceRef, StageId } from '../../../shared/jobs/types'
import type { Platform } from '../../../shared/text/platform'
import { filterComplex } from '../../ffmpeg/audio/chains'
import { containerFor } from '../../ffmpeg/audio/containers'
import type { ContainerSpec } from '../../ffmpeg/audio/containers'
import type { BuildCapabilities } from '../../ffmpeg/audio/encoders'
import { planStreams } from '../../ffmpeg/audio/streams'
import type { StreamPlan } from '../../ffmpeg/audio/streams'
import { execArgv } from '../../ffmpeg/exec'
import type { ExecResult } from '../../ffmpeg/exec'
import { COMMAND_PREFIX, ERROR_TAIL_BYTES, quoteForDisplay, tailAtLineBoundary } from '../log'
import { EVEN_SIZE_ENCODERS, OUTPUT_PLACEHOLDER, ffmpegCause, planConvertAudio, plannedCounts, streamIssues, videoFilters } from './convert'
import type { ConvertAudio } from './convert'
import { execEnding } from './types'
import type { JobRunner, PlanInput, RunContext, RunnableJob, RunnerPlan, RunOutcome } from './types'
import { toVerification, verificationError, verifyMedia } from './verify-media'
import type { VerifyFiles } from './verify-media'

/** The CRF of each quality tier, per encoder that takes a CRF. */
export const CRF_TIERS: Readonly<Partial<Record<VideoEncoder, Readonly<Record<'high' | 'medium' | 'low', number>>>>> =
{
  'libx264': { high: 18, medium: 23, low: 28 },
  'libx265': { high: 22, medium: 28, low: 33 },
  'libvpx-vp9': { high: 24, medium: 31, low: 38 },
  'libaom-av1': { high: 22, medium: 28, low: 35 },
  'libsvtav1': { high: 24, medium: 30, low: 36 }
}

/** The fixed quantizer of each quality tier for the encoders without a CRF; Theora counts up, the others down. */
const QSCALE_TIERS: Readonly<Partial<Record<VideoEncoder, Readonly<Record<'high' | 'medium' | 'low', number>>>>> =
{
  'mpeg2video': { high: 2, medium: 4, low: 8 },
  'mpeg4': { high: 2, medium: 4, low: 8 },
  'wmv2': { high: 2, medium: 4, low: 8 },
  'libtheora': { high: 8, medium: 6, low: 4 }
}

/** The ProRes profile of each quality tier: HQ, standard, and LT. */
const PRORES_TIERS: Readonly<Record<'high' | 'medium' | 'low', number>> = { high: 3, medium: 2, low: 1 }

/** The highest CRF each encoder accepts; SVT-AV1 starts at 1. */
const CRF_RANGE: Readonly<Partial<Record<VideoEncoder, readonly [number, number]>>> =
{
  'libx264': [0, 51],
  'libx265': [0, 51],
  'libvpx-vp9': [0, 63],
  'libaom-av1': [0, 63],
  'libsvtav1': [1, 63]
}

/** Encoders that write every frame without loss whatever the setting. */
const ALWAYS_LOSSLESS: ReadonlySet<string> = new Set(['ffv1', 'utvideo'])

/** How lossless an encoder can be asked to be: bit-exact, or not at all. */
export type LosslessMode = 'exact' | 'none'

/**
 * Each encoder's own lossless switch for video output stream `k`. `-crf 0` is lossless only for libx264 and
 * libaom-av1 (with `-b:v 0`); x265 needs `lossless=1`, VP9 `-lossless 1`, FFV1 and UT Video always are, and SVT-AV1,
 * ProRes, the MPEG family, Theora, and WMV2 have no lossless mode.
 */
export function losslessArgs(encoder: string, k: number): { args: string[]; mode: LosslessMode }
{
  switch (encoder)
  {
    case 'libx264':
      return { args: [`-crf:v:${k}`, '0'], mode: 'exact' }
    case 'libaom-av1':
      return { args: [`-crf:v:${k}`, '0', `-b:v:${k}`, '0'], mode: 'exact' }
    case 'libx265':
      return { args: [`-x265-params:v:${k}`, 'lossless=1'], mode: 'exact' }
    case 'libvpx-vp9':
      return { args: [`-lossless:v:${k}`, '1'], mode: 'exact' }
    default:
      return { args: [], mode: ALWAYS_LOSSLESS.has(encoder) ? 'exact' : 'none' }
  }
}

const VP9_CPU_USED: Readonly<Record<CompressRecipe['speed'], string>> = { veryslow: '0', slow: '1', medium: '2', fast: '4', veryfast: '5' }
const AOM_CPU_USED: Readonly<Record<CompressRecipe['speed'], string>> = { veryslow: '1', slow: '2', medium: '4', fast: '6', veryfast: '8' }
const SVT_PRESET: Readonly<Record<CompressRecipe['speed'], string>> = { veryslow: '2', slow: '4', medium: '6', fast: '8', veryfast: '10' }

/** The speed arguments of video output stream `k`: x264 and x265 presets, VP9 and AV1 cpu-used, SVT-AV1 presets. */
export function speedArgs(encoder: string, speed: CompressRecipe['speed'], k: number): string[]
{
  switch (encoder)
  {
    case 'libx264':
    case 'libx265':
      return [`-preset:v:${k}`, speed]
    case 'libvpx-vp9':
      return [`-cpu-used:v:${k}`, VP9_CPU_USED[speed]]
    case 'libaom-av1':
      return [`-cpu-used:v:${k}`, AOM_CPU_USED[speed]]
    case 'libsvtav1':
      return [`-preset:v:${k}`, SVT_PRESET[speed]]
    default:
      return []
  }
}

/** The tunes each encoder accepts; x265 has no film tune, and the other encoders take none. */
export const ENCODER_TUNES: Readonly<Partial<Record<VideoEncoder, ReadonlySet<NonNullable<CompressRecipe['tune']>>>>> =
{
  'libx264': new Set(['film', 'animation', 'grain', 'fastdecode', 'zerolatency']),
  'libx265': new Set(['animation', 'grain', 'fastdecode', 'zerolatency'])
}

/** Whether an encoder takes a tune. */
export function acceptsTune(encoder: VideoEncoder, tune: NonNullable<CompressRecipe['tune']>): boolean
{
  return ENCODER_TUNES[encoder]?.has(tune) ?? false
}

/** A CRF clamped to what the encoder accepts. */
export function clampCrf(encoder: VideoEncoder, crf: number): number
{
  const [low, high] = CRF_RANGE[encoder] ?? [0, 51]
  return Math.max(low, Math.min(high, Math.round(crf)))
}

/** The quality a tier or CRF target asks of a CPU encoder, as video output stream `k`'s arguments. */
export function qualityArgs(encoder: VideoEncoder, target: Exclude<CompressTarget, { mode: 'size' }>, k: number): string[]
{
  if (target.mode === 'quality' && target.tier === 'lossless')
  {
    return losslessArgs(encoder, k).args
  }
  const crfTiers = CRF_TIERS[encoder]
  if (crfTiers !== undefined)
  {
    const crf = target.mode === 'crf' ? clampCrf(encoder, target.crf) : crfTiers[target.tier as 'high' | 'medium' | 'low']
    return [`-crf:v:${k}`, String(crf), ...(encoder === 'libvpx-vp9' || encoder === 'libaom-av1' ? [`-b:v:${k}`, '0'] : [])]
  }
  const tier = target.mode === 'quality' ? target.tier as 'high' | 'medium' | 'low' : crfTier(target.crf)
  const qscale = QSCALE_TIERS[encoder]
  if (qscale !== undefined)
  {
    return [`-q:v:${k}`, String(qscale[tier])]
  }
  if (encoder === 'prores_ks')
  {
    return [`-profile:v:${k}`, String(PRORES_TIERS[tier])]
  }
  return []
}

/** The tier a CRF stands for on an encoder without one, read on the x264 scale. */
function crfTier(crf: number): 'high' | 'medium' | 'low'
{
  return crf <= 20 ? 'high' : crf <= 25 ? 'medium' : 'low'
}

/** The share of a size target the encode is budgeted at, so a normal encode lands under the target. */
export const SIZE_BUDGET = 0.97

/** The lowest video bitrate a size target may leave, in bits per second; a smaller target is refused. */
export const MIN_VIDEO_BPS = 100_000

/** What a size target leaves for the picture. */
export interface SizeBudget
{
  /** The bytes the encode aims at: SIZE_BUDGET of the target. */
  budgetBytes: number
  /** The video bitrate in bits per second after the audio streams take theirs. */
  videoBps: number
  /** The smallest target, in whole megabytes, that leaves MIN_VIDEO_BPS. */
  minTargetBytes: number
  ok: boolean
}

/**
 * The video bitrate of a size target: SIZE_BUDGET of the target over the duration, less every written audio
 * stream's bitrate. A target that leaves less than MIN_VIDEO_BPS is not ok, with the smallest target that works.
 */
export function sizeBudget(targetBytes: number, durationSec: number, audioBps: number): SizeBudget
{
  const budgetBytes = Math.floor(targetBytes * SIZE_BUDGET)
  const videoBps = Math.floor((budgetBytes * 8) / durationSec - audioBps)
  const minBytes = ((MIN_VIDEO_BPS + audioBps) * durationSec) / 8 / SIZE_BUDGET
  return { budgetBytes, videoBps, minTargetBytes: Math.ceil(minBytes / 1_000_000) * 1_000_000, ok: videoBps >= MIN_VIDEO_BPS }
}

/** The rate control of a size target for video output stream `k`: the budgeted bitrate with a capped peak. */
export function bitrateArgs(videoBps: number, k: number): string[]
{
  return [`-b:v:${k}`, String(videoBps), `-maxrate:v:${k}`, String(videoBps * 2), `-bufsize:v:${k}`, String(videoBps * 4)]
}

/**
 * The two-pass statistics prefix of one execution: inside its work folder and named by the job, so two jobs on one
 * source, and two passes of one job, never share or miss a log.
 */
export function passLogPrefix(workDir: string, jobId: string): string
{
  return path.join(workDir, `passlog-${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}`)
}

/** Appends the stream specifier of video output stream `k` to every option of an option and value list. */
function forStream(args: readonly string[], k: number): string[]
{
  return args.map((arg, i) => (i % 2 === 0 ? `${arg}:v:${k}` : arg))
}

/**
 * The constant-quantizer arguments of a hardware encoder: NVENC constqp with -qp, QSV global_quality, and AMF cqp
 * with all three frame types set, since any left at -1 is the encoder's choice.
 */
export function gpuQualityArgs(encoder: string, qp: number, k: number): string[]
{
  const q = String(qp)
  if (encoder.endsWith('_nvenc'))
  {
    return forStream(['-rc', 'constqp', '-qp', q], k)
  }
  if (encoder.endsWith('_qsv'))
  {
    return forStream(['-global_quality', q], k)
  }
  if (encoder.endsWith('_amf'))
  {
    return forStream(['-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-qp_b', q], k)
  }
  return forStream(['-qp', q], k)
}

/** The quantizer a hardware encoder runs a CRF or tier target at: the CRF itself, or the encoder's tier CRF. */
export function gpuQp(encoder: VideoEncoder, target: Exclude<CompressTarget, { mode: 'size' }>): number
{
  if (target.mode === 'crf')
  {
    return clampCrf(encoder, target.crf)
  }
  const tiers = CRF_TIERS[encoder] ?? { high: 18, medium: 23, low: 28 }
  return tiers[target.tier === 'lossless' ? 'high' : target.tier]
}

/** What one Compress command is built from. */
export interface CompressCommandInput
{
  source: string
  facts: MediaFacts
  recipe: CompressRecipe
  container: ContainerSpec
  /** The muxer the plan chose, passed as -f. */
  muxer: string
  audio: readonly ConvertAudio[]
  /** A leased hardware encoder that writes the picture in place of the recipe's encoder; null for the CPU. */
  gpuEncoder: string | null
  /** The budgeted video bitrate of a size target in bits per second; null for quality and CRF targets. */
  videoBps: number | null
  /** The two-pass statistics prefix; null for one pass. */
  passLog: string | null
  output: string
}

/** The picture a Compress re-encodes. */
export interface CompressVideo
{
  encoder: string
  filters: string[]
  lossless: LosslessMode | 'not-requested'
  tune: string | null
}

/** A Compress command: one argument list per pass, the stream plan it maps, and the picture it encodes. */
export interface CompressCommand
{
  /** Pass 1 into the null muxer and then the encode for two passes; the encode alone for one. */
  passes: string[][]
  streams: StreamPlan
  /** Null when the output holds no picture. */
  video: CompressVideo | null
  /** For two passes, each picture's output index in pass 1 and in the encode, whose statistics names must agree. */
  passIndices: Array<{ pass1: number; encode: number }>
}

const INPUT_ARGS = ['-n', '-analyzeduration', '200M', '-probesize', '200M', '-i']

function withoutVideoCopy(codecArgs: readonly string[]): string[]
{
  const index = codecArgs.findIndex((arg, i) => arg === '-c:v' && codecArgs[i + 1] === 'copy')
  return index === -1 ? [...codecArgs] : [...codecArgs.slice(0, index), ...codecArgs.slice(index + 2)]
}

/** Whether a target asks for lossless output. */
export function isLossless(target: CompressTarget): boolean
{
  return target.mode === 'quality' && target.tier === 'lossless'
}

/**
 * The encoder arguments of one re-encoded picture as video output stream `k`: the encoder, its speed, the size
 * budget or the quality, the filter chain, the tune where the encoder has it, and the pass. A hardware encoder takes
 * a constant quantizer or the bitrate, and no speed or tune.
 */
function pictureArgs(input: CompressCommandInput, video: CompressVideo, k: number, pass: 1 | 2 | null): string[]
{
  const { recipe, videoBps } = input
  const target = recipe.target
  const gpu = video.encoder !== recipe.encoder
  let rate: string[] = []
  if (videoBps !== null)
  {
    rate = bitrateArgs(videoBps, k)
  }
  else if (target.mode !== 'size')
  {
    rate = gpu ? gpuQualityArgs(video.encoder, gpuQp(recipe.encoder, target), k) : qualityArgs(recipe.encoder, target, k)
  }
  const args = [`-c:v:${k}`, video.encoder, ...(gpu ? [] : speedArgs(video.encoder, recipe.speed, k)), ...rate]
  if (video.filters.length > 0)
  {
    args.push(`-filter:v:${k}`, video.filters.join(','))
  }
  if (video.tune !== null)
  {
    args.push(`-tune:v:${k}`, video.tune)
  }
  if (pass !== null && input.passLog !== null)
  {
    args.push(`-pass:v:${k}`, String(pass), `-passlogfile:v:${k}`, input.passLog)
  }
  return args
}

/**
 * The FFmpeg arguments of a Compress, after exec's own prefix. The encode is -n, the source, the audio graph, an
 * explicit map of every kept stream in source order, per-stream codecs with cover art copied beside the re-encoded
 * picture, the muxer, and the output. Pass 1 of two maps only the re-encoded pictures and writes to the null muxer
 * through `-`, so no platform null device is named. A hardware encoder runs one pass with the source pixel format,
 * and a lossless target keeps the CPU encoder.
 */
export function buildCompressArgs(input: CompressCommandInput): CompressCommand
{
  const { recipe, facts } = input
  const streams = planStreams(facts, input.container, input.audio.map((a) => a.output), {
    keepSubtitles: true,
    keepGlobalTags: true,
    keepCoverArt: true
  })
  const parts = input.audio.flatMap((a) => (a.part === null ? [] : [a.part]))
  const graph = parts.length === 0 ? [] : ['-filter_complex', filterComplex(parts)]
  const head = [...INPUT_ARGS, input.source]
  const tail = ['-f', input.muxer, input.output]
  const kept = streams.kept.filter((s) => s.kind === 'video' || s.kind === 'cover')
  const pictures = kept.flatMap((s) => (s.kind === 'video' ? [s.source] : []))
  if (pictures.length === 0)
  {
    return { passes: [[...head, ...graph, ...streams.mapArgs, ...streams.codecArgs, ...streams.metadataArgs, ...tail]], streams, video: null, passIndices: [] }
  }
  const lossless = isLossless(recipe.target)
  const encoder = input.gpuEncoder !== null && !lossless ? input.gpuEncoder : recipe.encoder
  const gpu = encoder !== recipe.encoder
  const video: CompressVideo =
  {
    encoder,
    filters: videoFilters({ fit: recipe.fit, fps: null, pixelFormat: gpu ? 'source' : recipe.pixelFormat }, gpu ? null : recipe.encoder),
    lossless: lossless ? losslessArgs(encoder, 0).mode : 'not-requested',
    tune: !gpu && recipe.tune !== null && acceptsTune(recipe.encoder, recipe.tune) ? recipe.tune : null
  }
  const twoPass = input.passLog !== null && !gpu
  const videoArgs = kept.flatMap((s, k) => (s.kind === 'cover' ? [`-c:v:${k}`, 'copy'] : pictureArgs(input, video, k, twoPass ? 2 : null)))
  const encode = [...head, ...graph, ...streams.mapArgs, ...videoArgs, ...withoutVideoCopy(streams.codecArgs), ...streams.metadataArgs, ...tail]
  if (!twoPass)
  {
    return { passes: [encode], streams, video, passIndices: [] }
  }
  const firstPass = [
    ...head,
    ...pictures.flatMap((source) => ['-map', `0:${source}`]),
    ...pictures.flatMap((_, k) => pictureArgs(input, video, k, 1)),
    '-f', 'null', '-'
  ]
  const passIndices = pictures.map((source, k) => ({ pass1: k, encode: streams.kept.findIndex((s) => s.kind === 'video' && s.source === source) }))
  return { passes: [firstPass, encode], streams, video, passIndices }
}

/** The encoders whose two passes were measured on both builds; any other runs one pass. */
export const TWO_PASS_ENCODERS: ReadonlySet<string> = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'mpeg4'])

/** Encoders that take no rate control, so a size target means nothing to them. */
const UNRATED: ReadonlySet<string> = new Set(['prores_ks', 'ffv1', 'utvideo'])

/** The bitrate a copied or lossless audio stream is budgeted at when neither the source nor the encoder states one. */
export const UNKNOWN_AUDIO_BPS = 256_000

/** The placeholder a planned two-pass command shows for the statistics prefix inside the execution folder. */
export const PASSLOG_PLACEHOLDER = '{passlog}'

/** The picture as the source stores it; the rotation is the display matrix's, in degrees. */
export type PictureFacts = Pick<NonNullable<MediaSummary['video']>, 'width' | 'height' | 'rotation'>

/** The picture's size as displayed: a quarter or three-quarter turn swaps the stored width and height. */
export function displayedSize(p: PictureFacts): { width: number; height: number }
{
  const turn = ((Math.round(p.rotation / 90) % 4) + 4) % 4
  return turn % 2 === 1 ? { width: p.height, height: p.width } : { width: p.width, height: p.height }
}

/**
 * The size a Compress writes for a displayed picture: the FrameFit's result, which caps the picture as displayed and
 * always writes even sizes, or the size cropped to even for the encoders that refuse odd sizes, or the size itself.
 */
export function outputSize(display: { width: number; height: number }, fit: FrameFit | null, encoder: string): { width: number; height: number }
{
  const even = (value: number): number => Math.max(2, Math.trunc(value / 2) * 2)
  if (fit !== null && (fit.maxWidth !== null || fit.maxHeight !== null))
  {
    const ratios = [fit.maxWidth === null ? null : fit.maxWidth / display.width, fit.maxHeight === null ? null : fit.maxHeight / display.height]
      .filter((r): r is number => r !== null)
    const both = ratios.length === 2
    const k = Math.min(1, both && fit.mode === 'crop' ? Math.max(...ratios) : Math.min(...ratios))
    const width = even(display.width * k)
    const height = even(display.height * k)
    if (both && fit.mode === 'pad')
    {
      return { width: even(fit.maxWidth as number), height: even(fit.maxHeight as number) }
    }
    if (both && fit.mode === 'crop')
    {
      return { width: Math.min(even(fit.maxWidth as number), width), height: Math.min(even(fit.maxHeight as number), height) }
    }
    return { width, height }
  }
  return EVEN_SIZE_ENCODERS.has(encoder) ? { width: even(display.width), height: even(display.height) } : { ...display }
}

function issue(code: PlanIssue['code'], severity: PlanIssue['severity'], message: string, field: PlanIssue['field'], fix: PlanIssue['fix'] = null): PlanIssue
{
  return { code, severity, message, field, fix }
}

function megabytes(bytes: number): string
{
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`
}

function minutes(sec: number): string
{
  return sec < 90 ? `${Math.round(sec)}-second` : `${Math.round(sec / 60)}-minute`
}

/** The audio bitrate a size target reserves: each encoded stream's bitrate, each copied stream's source rate. */
export function audioBudget(audio: readonly ConvertAudio[]): { bps: number; unknown: number[] }
{
  let bps = 0
  const unknown: number[] = []
  for (const a of audio)
  {
    const kbps = a.output.choice === null ? (a.source.bitRate === null ? null : a.source.bitRate / 1000) : a.output.choice.bitrateKbps
    if (kbps === null)
    {
      unknown.push(a.source.audioIndex)
      bps += UNKNOWN_AUDIO_BPS
      continue
    }
    bps += kbps * 1000
  }
  return { bps, unknown }
}

/** The duration a plan budgets over; null when the source states none. */
function durationOf(facts: MediaFacts): number | null
{
  return Number.isFinite(facts.durationSec) && facts.durationSec > 0 ? facts.durationSec : null
}

/** Whether a source holds a picture the output keeps. */
function hasPicture(facts: MediaFacts, container: ContainerSpec): boolean
{
  return container.video && facts.video.some((v) => !v.cover)
}

/**
 * The checks of a Compress recipe against the source and build: the encoder must be in the build and fit the
 * container per the measured table, a lossless target needs an encoder with a lossless mode, a tune must be one the
 * encoder has, and a size target needs a picture, a rated encoder, a duration, and room for the video once the audio
 * takes its share. The planner's own checks of the same codes take precedence.
 */
export function compressIssues(recipe: CompressRecipe, facts: MediaFacts, container: ContainerSpec, caps: BuildCapabilities, audio: readonly ConvertAudio[]): PlanIssue[]
{
  if (!hasPicture(facts, container))
  {
    return recipe.target.mode === 'size'
      ? [issue('invalid-recipe', 'error', 'A size target sets the video bitrate, and this file keeps no video. Choose a quality instead.', 'recipe')]
      : []
  }
  const issues: PlanIssue[] = []
  const name = videoCodecName(recipe.encoder)
  if (!caps.encoders.has(recipe.encoder) || caps.experimental.has(recipe.encoder))
  {
    issues.push(issue('encoder-missing', 'error', `This FFmpeg build has no ${name} encoder (${recipe.encoder}).`, 'encoder'))
  }
  const fit = videoEncoderFit(recipe.encoder, container.name)
  if (fit !== null && !fit.ok)
  {
    issues.push(issue('container-cannot-hold', 'error', fit.reason ?? '', 'container'))
  }
  if (isLossless(recipe.target) && losslessArgs(recipe.encoder, 0).mode === 'none')
  {
    issues.push(issue('lossless-unsupported', 'error', `${name} (${recipe.encoder}) has no lossless mode, so a lossless target would be lossy.`, 'encoder'))
  }
  if (recipe.tune !== null && !acceptsTune(recipe.encoder, recipe.tune))
  {
    issues.push(ENCODER_TUNES[recipe.encoder] === undefined
      ? issue('tune-unsupported', 'info', `${name} takes no tune, so the ${recipe.tune} tune is not used.`, 'encoder')
      : issue('tune-unsupported', 'error', `${name} has no ${recipe.tune} tune.`, 'encoder'))
  }
  if (recipe.target.mode === 'size')
  {
    issues.push(...sizeIssues(recipe, recipe.target, facts, audio))
  }
  return issues
}

function sizeIssues(recipe: CompressRecipe, target: Extract<CompressTarget, { mode: 'size' }>, facts: MediaFacts, audio: readonly ConvertAudio[]): PlanIssue[]
{
  if (UNRATED.has(recipe.encoder))
  {
    return [issue('invalid-recipe', 'error', `${videoCodecName(recipe.encoder)} takes no bitrate, so it cannot aim at a size. Choose a quality instead.`, 'recipe')]
  }
  const durationSec = durationOf(facts)
  if (durationSec === null)
  {
    return [issue('invalid-recipe', 'error', 'A size target needs the duration, and this file states none. Choose a quality instead.', 'recipe')]
  }
  const reserve = audioBudget(audio)
  const budget = sizeBudget(target.targetBytes, durationSec, reserve.bps)
  if (budget.ok)
  {
    return []
  }
  const value: CompressTarget = { mode: 'size', targetBytes: budget.minTargetBytes, twoPass: target.twoPass }
  return [issue('invalid-recipe', 'error',
    `${megabytes(target.targetBytes)} leaves ${Math.max(0, Math.floor(budget.videoBps / 1000))} kbps for the video of this ${minutes(durationSec)} file once the audio takes ` +
    `${Math.round(reserve.bps / 1000)} kbps; the smallest target that works is ${megabytes(budget.minTargetBytes)}.`,
    'recipe', { kind: 'patch-recipe', label: `Use ${megabytes(budget.minTargetBytes)}`, patch: { field: 'compress-target', value, encoder: recipe.encoder }, scope: 'jobs' })]
}

/** The plan notes of a size target: the budget, and the reserve taken for audio streams that state no bitrate. */
export function budgetNotes(recipe: CompressRecipe, facts: MediaFacts, audio: readonly ConvertAudio[]): string[]
{
  const videoBps = plannedVideoBps(recipe, facts, audio)
  if (recipe.target.mode !== 'size' || videoBps === null)
  {
    return []
  }
  const notes = [`Aims at ${megabytes(Math.floor(recipe.target.targetBytes * SIZE_BUDGET))} of the ${megabytes(recipe.target.targetBytes)} target: video at ${Math.floor(videoBps / 1000)} kbps.`]
  const unknown = audioBudget(audio).unknown
  if (unknown.length > 0)
  {
    notes.push(`Audio stream ${unknown.map((n) => n + 1).join(', ')} states no bitrate, so the budget reserves ${UNKNOWN_AUDIO_BPS / 1000} kbps for each.`)
  }
  return notes
}

/** The odd-size warning and the output size note of a picture whose stored size the planner knows. */
export function pictureNotes(recipe: CompressRecipe, picture: PictureFacts | null, encoder: string): { notes: string[]; issues: PlanIssue[] }
{
  if (picture === null || picture.width <= 0 || picture.height <= 0)
  {
    return { notes: [], issues: [] }
  }
  const display = displayedSize(picture)
  const size = outputSize(display, recipe.fit, encoder)
  const shown = `${display.width}x${display.height}`
  const written = `${size.width}x${size.height}`
  const notes = [written === shown ? `Writes ${written}, the size as displayed.` : `Writes ${written}; the source displays at ${shown}.`]
  const odd = display.width % 2 === 1 || display.height % 2 === 1
  if (odd && (recipe.fit === null || (recipe.fit.maxWidth === null && recipe.fit.maxHeight === null)) && EVEN_SIZE_ENCODERS.has(encoder))
  {
    return {
      notes,
      issues: [issue('odd-dimensions', 'warning', `The ${shown} picture is cropped to ${written}, because ${videoCodecName(encoder as VideoEncoder)} needs even sizes.`, 'encoder')]
    }
  }
  return { notes, issues: [] }
}

/** What the Compress runner reads besides its job and context. */
export interface CompressRunnerDeps
{
  /** Whether a path exists; the output path is checked right before the first spawn. */
  exists(file: string): Promise<boolean>
  /** The decode check's setting when the job verifies. */
  verifyVideo(): 'full' | 'sampled'
  platform: Platform
  /** The stored picture size and rotation the probe summary holds, for the plan's output size; null when unknown. */
  picture?(source: SourceRef): PictureFacts | null
  /** Renames a statistics file inside the work folder; defaults to fs.promises.rename. */
  rename?(from: string, to: string): Promise<void>
  files?: VerifyFiles
}

/** Whether a Compress of these facts runs two passes on the CPU. */
function runsTwoPass(recipe: CompressRecipe, facts: MediaFacts, container: ContainerSpec): boolean
{
  return recipe.target.mode === 'size' && recipe.target.twoPass && hasPicture(facts, container) && TWO_PASS_ENCODERS.has(recipe.encoder)
}

/** The budgeted video bitrate of a size target, or null for a quality target or a budget that cannot be met. */
function plannedVideoBps(recipe: CompressRecipe, facts: MediaFacts, audio: readonly ConvertAudio[]): number | null
{
  const durationSec = durationOf(facts)
  if (recipe.target.mode !== 'size' || durationSec === null)
  {
    return null
  }
  const budget = sizeBudget(recipe.target.targetBytes, durationSec, audioBudget(audio).bps)
  return budget.ok ? budget.videoBps : null
}

/**
 * The Compress runner's plan: the stream plan, the picture's encoder, filters, lossless mode, and passes, the
 * issues, the size estimate, and the command as it will run, with the work path and the statistics prefix as
 * placeholders. A two-pass display shows both commands, one per line.
 */
export function planCompress(input: PlanInput<CompressRecipe>, deps: Pick<CompressRunnerDeps, 'picture'> = {}): RunnerPlan
{
  const { recipe, facts, caps } = input
  const container = containerFor(input.output.container)
  const audio = planConvertAudio({ audio: recipe.audio, channels: 'keep' }, facts, container, caps, new Map(), container.video)
  const twoPass = runsTwoPass(recipe, facts, container)
  const command = buildCompressArgs({
    source: input.source.path, facts, recipe, container, muxer: input.output.muxer, audio: audio.streams, gpuEncoder: null,
    videoBps: plannedVideoBps(recipe, facts, audio.streams), passLog: twoPass ? PASSLOG_PLACEHOLDER : null, output: OUTPUT_PLACEHOLDER
  })
  const argvs = command.passes.map((args) => execArgv(args, 'kill'))
  const issues = [...compressIssues(recipe, facts, container, caps, audio.streams), ...audio.issues, ...streamIssues(command.streams, container)]
  let video: RunnerPlan['video'] = null
  if (command.video !== null)
  {
    const shown = pictureNotes(recipe, deps.picture?.(input.source) ?? null, command.video.encoder)
    issues.push(...shown.issues)
    const notes = [...shown.notes, ...budgetNotes(recipe, facts, audio.streams)]
    if (command.video.lossless === 'exact' && recipe.pixelFormat !== 'source')
    {
      notes.push(`Lossless after the conversion to ${recipe.pixelFormat}; the source pixel format is not kept.`)
    }
    if (recipe.target.mode === 'size' && recipe.target.twoPass && !twoPass)
    {
      notes.push(`${videoCodecName(recipe.encoder)} runs one pass.`)
    }
    video = {
      encoder: command.video.encoder, gpu: null, lossless: command.video.lossless, passes: twoPass ? 2 : 1, filters: command.video.filters, notes, cpuFallback: null
    }
  }
  const encodesAudio = audio.streams.some((a) => a.part !== null)
  return {
    command: {
      argv: argvs[argvs.length - 1],
      display: argvs.map((argv) => quoteForDisplay(['ffmpeg', ...argv], input.platform)).join('\n'),
      placeholders: twoPass ? [OUTPUT_PLACEHOLDER, PASSLOG_PLACEHOLDER] : [OUTPUT_PLACEHOLDER]
    },
    streams: { kept: command.streams.kept, dropped: command.streams.dropped, chapters: command.streams.chapters },
    video,
    audio: [],
    class: command.video !== null ? 'video-cpu' : encodesAudio ? 'audio' : 'copy',
    stages: [{ id: 'probe', passes: 1 }, { id: 'encode', passes: twoPass ? 2 : 1 }, { id: 'verify', passes: 1 }],
    estimate: compressEstimate(recipe, facts, audio.streams, input.source.size),
    issues
  }
}

/** The output size: the budget of a size target, otherwise the source size, both before the run. */
export function compressEstimate(recipe: CompressRecipe, facts: MediaFacts, audio: readonly ConvertAudio[], sourceBytes: number): RunnerPlan['estimate']
{
  const videoBps = plannedVideoBps(recipe, facts, audio)
  if (recipe.target.mode === 'size' && videoBps !== null)
  {
    return { outputBytes: sizeBudget(recipe.target.targetBytes, durationOf(facts) as number, 0).budgetBytes, workSec: null, confidence: 'medium' }
  }
  return { outputBytes: sourceBytes, workSec: null, confidence: 'low' }
}

/** The statistics files FFmpeg writes for one output stream: the log, x264's macroblock tree, and x265's CU tree. */
export function passLogFiles(prefix: string, outputIndex: number): string[]
{
  const log = `${prefix}-${outputIndex}.log`
  return [log, `${log}.mbtree`, `${log}.cutree`]
}

const ABORTED: RunOutcome = { kind: 'aborted' }

function messageOf(error: unknown): string
{
  return error instanceof Error ? error.message : String(error)
}

const CAUSE_TEXT: Readonly<Record<ReturnType<typeof ffmpegCause>, { short: string; lead: string }>> =
{
  encoder: { short: 'Encoder failed', lead: 'The encoder could not start' },
  muxer: { short: 'Container refused', lead: 'The output container refused a stream' },
  decode: { short: 'Source unreadable', lead: 'The source could not be decoded' },
  other: { short: 'FFmpeg failed', lead: 'FFmpeg could not compress this file' }
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

function runError(job: RunnableJob<CompressRecipe>, ctx: RunContext, deps: CompressRunnerDeps, e: ErrorFacts): RunOutcome
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
 * The error a failed pass ends with: a GPU session limit or start failure when the lease recognizes it, a full
 * disk, or FFmpeg's failure classified by its stderr, the cause first, the pass of two, and FFmpeg's last line.
 */
function passFailure(job: RunnableJob<CompressRecipe>, ctx: RunContext, deps: CompressRunnerDeps, result: ExecResult, argv: string[], pass: string): RunOutcome
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
  const ended = result.signal !== null
    ? `FFmpeg was stopped by ${result.signal}`
    : `FFmpeg ended with exit code ${result.code}${result.exitName === null ? '' : ` (${result.exitName})`}`
  return runError(job, ctx, deps, { ...base, code: 'ffmpeg-failed', short: text.short, cause, message: `${text.lead}${pass}: ${lastLine(result.stderrTail) ?? `${ended}.`}` })
}

function displaces(output: OutputPlan): boolean
{
  return output.displaces !== null || output.resolution === 'overwrite' || output.resolution === 'replace-original'
}

/**
 * Moves pass 1's statistics to the names the encode reads when the picture's output index differs between the
 * passes, highest index first so no file is renamed over another; a file a given encoder does not write is skipped.
 */
async function alignPassLogs(prefix: string, indices: CompressCommand['passIndices'], rename: (from: string, to: string) => Promise<void>): Promise<void>
{
  for (const { pass1, encode } of [...indices].reverse())
  {
    if (pass1 === encode)
    {
      continue
    }
    const from = passLogFiles(prefix, pass1)
    const to = passLogFiles(prefix, encode)
    for (let i = 0; i < from.length; i += 1)
    {
      try
      {
        await rename(from[i], to[i])
      }
      catch (error)
      {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        {
          throw error
        }
      }
    }
  }
}

/** Runs one Compress job inside its work folder; placing the verified output is the engine's. */
export async function runCompress(job: RunnableJob<CompressRecipe>, ctx: RunContext, deps: CompressRunnerDeps): Promise<RunOutcome>
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
  const audio = planConvertAudio({ audio: recipe.audio, channels: 'keep' }, facts, container, ctx.caps, new Map(), container.video)
  const refusal = [...compressIssues(recipe, facts, container, ctx.caps, audio.streams), ...audio.issues].find((i) => i.severity === 'error')
  if (refusal !== undefined)
  {
    return runError(job, ctx, deps, { code: 'plan-refused', short: 'Plan refused', stage: 'probe', message: refusal.message })
  }
  const gpuEncoder = ctx.gpu?.encoder ?? null
  const twoPass = runsTwoPass(recipe, facts, container) && gpuEncoder === null
  const output = ctx.output(job.plan.output.container, 1)
  const passLog = twoPass ? passLogPrefix(ctx.workDir, job.id) : null
  const command = buildCompressArgs({
    source: job.source.path, facts, recipe, container, muxer: job.plan.output.muxer, audio: audio.streams, gpuEncoder,
    videoBps: plannedVideoBps(recipe, facts, audio.streams), passLog, output
  })
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
  const durationSec = durationOf(facts)
  const passes = command.passes.length
  for (let p = 0; p < passes; p += 1)
  {
    const args = command.passes[p]
    const argv = execArgv(args, 'kill')
    const label = passes === 1 ? 'Compressing' : p === 0 ? 'Analyzing, pass 1 of 2' : 'Compressing, pass 2 of 2'
    ctx.stage({ id: 'encode', pass: p + 1, passes, label })
    ctx.log.info(`${COMMAND_PREFIX}${quoteForDisplay(['ffmpeg', ...argv], deps.platform)}`)
    let result: ExecResult
    try
    {
      result = await ctx.exec.run(args, {
        signal,
        stop: 'kill',
        ...(durationSec === null ? {} : { durationSec }),
        onProgress: (q) => ctx.progress({ outTimeSec: q.outTimeSec, durationSec, speed: q.speed, bytes: p === passes - 1 ? q.totalSize : null }),
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
      return passFailure(job, ctx, deps, result, argv, passes === 1 ? '' : ` (pass ${p + 1} of 2)`)
    }
    if (p === 0 && passLog !== null)
    {
      try
      {
        await alignPassLogs(passLog, command.passIndices, deps.rename ?? ((from, to) => fsp.rename(from, to)))
      }
      catch (error)
      {
        return runError(job, ctx, deps, { code: 'internal', short: 'Pass log unusable', stage: 'encode', message: `The statistics of pass 1 could not be moved for pass 2: ${messageOf(error)}` })
      }
      if (signal.aborted)
      {
        return ABORTED
      }
    }
  }
  ctx.stage({ id: 'verify', pass: 1, passes: 1, label: 'Verifying' })
  const targetBytes = recipe.target.mode === 'size' && command.video !== null ? recipe.target.targetBytes : null
  const check = await verifyMedia(
    {
      kind: 'media',
      path: output,
      streams: plannedCounts(command.streams),
      duration: durationSec === null ? null : { expectedSec: durationSec, rule: 'tolerance' },
      targetBytes,
      sourceBytes: job.source.size
    },
    { setting: deps.verifyVideo(), displacing: displaces(job.plan.output) },
    {
      exec: ctx.exec,
      signal,
      probe: (file) => ctx.probe(file),
      progress: (q) => ctx.progress(q),
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
  return {
    kind: 'output',
    artifact: {
      kind: 'file',
      path: output,
      container: job.plan.output.container,
      bytes: check.media.size.bytes,
      durationSec: check.media.durationSec,
      encoder: { video: command.video?.encoder ?? null, audio: audio.streams.map((a) => a.output.choice?.encoder ?? 'copy') }
    },
    verification: toVerification(check, 1),
    measurement: null,
    notes: check.largerThanSource ? [`The output is larger than the source (${megabytes(check.media.size.bytes)} from ${megabytes(job.source.size)}).`] : []
  }
}

/** The Compress runner. */
export function createCompressRunner(deps: CompressRunnerDeps): JobRunner<CompressRecipe>
{
  return {
    kind: 'compress',
    plan: (input) => planCompress(input, deps),
    run: (job, ctx) => runCompress(job, ctx, deps)
  }
}
