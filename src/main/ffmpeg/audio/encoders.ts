/**
 * The encoder of one output audio stream: the same-as-source table, chosen codecs, bitrate ladders and
 * floors, and the channel, layout, and sample-rate limits measured on the 2022 and 9.0.2 builds. An
 * experimental encoder is never chosen and -strict is never emitted. Pure; the build's encoder list
 * arrives as BuildCapabilities.
 */
import type { AudioFacts, EncoderChoice, EncoderNote, EncoderPolicy, OutputCodec, PinFormat } from '../../../shared/audio/types'
import { canonicalAudioContainer, containerFor, PCM_BE_ENCODERS, PCM_LE_ENCODERS, VIDEO_FALLBACK_CONTAINER } from './containers'
import type { ContainerSpec } from './containers'
import { kbpsPerPair } from './ceilings'

export type { EncoderChoice, EncoderNote }

/** What one FFmpeg build offers: every encoder it lists, the ones flagged experimental, and whether it has libsoxr. */
export interface BuildCapabilities { encoders: ReadonlySet<string>; experimental: ReadonlySet<string>; soxr: boolean }

/** The stream an encoder must write: channels and named layout after any downmix, and the lowest rate the preset accepts. */
export interface EncoderOutput
{
  channels: number
  layout: string
  minSampleRate: number | null
  /** True when the output keeps a video stream, so a container change goes to .mkv instead of an audio container. */
  video?: boolean
}

/** Why no encoder can write a stream as asked. */
export type EncoderRefusal = 'too-many-channels' | 'layout-unsupported' | 'no-encoder' | 'container-cannot-hold'

/** The decision for one stream; a refusal names the encoder it tried and that encoder's channel limit, when known. */
export type EncoderDecision =
  | { ok: true; choice: EncoderChoice; container: string; containerChanged: boolean }
  | { ok: false; reason: EncoderRefusal; encoder: string | null; maxChannels: number | null }

/** A figure per channel pair, or the stereo and surround figures AC-3 and E-AC-3 state per stream. */
type Figure = number | { upToStereo: number; surround: number }

interface BitrateRule
{
  /** kb/s per stream, or per channel pair when perPair is set. */
  steps: readonly number[]
  perPair: boolean
  floor: Figure
  /** The rate for a source whose bitrate is unknown. */
  fallback: Figure
  /** The bitstream takes only the ladder's rates, so a chosen rate moves up to the next step. */
  discrete: boolean
  /** Lower maxima at low sample rates: [rate, kb/s] applies below rate. */
  lowRateCaps: ReadonlyArray<readonly [number, number]>
}

/** The limits of one encoder. */
export interface EncoderLimits
{
  /** Null when the encoder takes any channel count. */
  maxChannels: number | null
  /** The layouts that encode and decode unchanged on both builds; null when every named layout does. */
  layouts: readonly string[] | null
  /** Layouts relabeled to an equivalent the encoder accepts. */
  remap: Readonly<Record<string, string>>
  /** The sample rates it writes, ascending; null when any rate up to maxRate is written. */
  rates: readonly number[] | null
  maxRate: number | null
  /** Null for lossless encoders, which take no -b:a. */
  bitrate: BitrateRule | null
}

const SIDE_TO_BACK: Readonly<Record<string, string>> = { '5.1(side)': '5.1', '5.0(side)': '5.0', 'quad(side)': 'quad' }
const MONO_STEREO: readonly string[] = ['mono', 'stereo']
const VORBIS_ORDER: readonly string[] = ['mono', 'stereo', '3.0', 'quad', '5.0', '5.1', '6.1', '7.1']
const PAIR_LADDER: readonly number[] = [128, 160, 192, 224, 256, 320]
const AC3_RATES: readonly number[] = [32000, 44100, 48000]
const SURROUND_FLOOR: Figure = { upToStereo: 192, surround: 384 }

function lossless(maxChannels: number | null, layouts: readonly string[] | null = null, remap: Readonly<Record<string, string>> = {}): EncoderLimits
{
  return { maxChannels, layouts, remap, rates: null, maxRate: null, bitrate: null }
}

function lossy(maxChannels: number, layouts: readonly string[], remap: Readonly<Record<string, string>>, rates: readonly number[] | null,
  maxRate: number | null, bitrate: BitrateRule): EncoderLimits
{
  return { maxChannels, layouts, remap, rates, maxRate, bitrate }
}

function ladder(steps: readonly number[], perPair: boolean, floor: Figure, fallback: Figure, discrete = false,
  lowRateCaps: ReadonlyArray<readonly [number, number]> = []): BitrateRule
{
  return { steps, perPair, floor, fallback, discrete, lowRateCaps }
}

/**
 * The limits per encoder. Layout lists hold what round-tripped on both builds: AAC writes other layouts
 * with a program config element that 2022 decodes as unknown, libopus refuses any layout outside the
 * Vorbis order, libvorbis relabels others to the Vorbis order, ALAC, AC-3, E-AC-3, MP3, and MP2 convert
 * others silently, and TTA keeps only the channel count. libvorbis ABR fails above 48 kHz and at 22.05 kHz
 * from 192k, LAME lowers MPEG-2 and 2.5 rates to 160k and 64k, and MP2 refuses 192k and up below 32 kHz.
 */
export const ENCODER_LIMITS: Readonly<Record<string, EncoderLimits>> =
{
  aac: lossy(8, ['mono', 'stereo', '2.1', '3.0', '3.0(back)', '4.0', 'quad', '5.0', '5.1', '7.1'], SIDE_TO_BACK,
    [7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000], null,
    ladder([96, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640], false, 128, 256)),
  libopus: lossy(8, VORBIS_ORDER, SIDE_TO_BACK, [48000], null,
    ladder([64, 96, 128, 160, 192, 224, 256, 320, 384, 448, 510], false, 96, 160)),
  libvorbis: lossy(8, VORBIS_ORDER, SIDE_TO_BACK, AC3_RATES, null, ladder(PAIR_LADDER, true, 128, 192)),
  libmp3lame: lossy(2, MONO_STEREO, {}, [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000], null,
    ladder(PAIR_LADDER, true, 128, 320, true, [[16000, 64], [32000, 160]])),
  mp2: lossy(2, MONO_STEREO, {}, AC3_RATES, null, ladder([128, 160, 192, 224, 256, 320, 384], true, 192, 256, true)),
  ac3: lossy(6, ['mono', 'stereo', '2.1', '3.0', '3.0(back)', '3.1', '4.0', '4.1', 'quad', 'quad(side)', '5.0', '5.0(side)', '5.1', '5.1(side)'], {},
    AC3_RATES, null, ladder([192, 224, 256, 320, 384, 448, 512, 576, 640], false, SURROUND_FLOOR, { upToStereo: 192, surround: 448 }, true)),
  eac3: lossy(6, ['mono', 'stereo', '2.1', '3.0', '3.0(back)', '3.1', '4.0', '4.1', 'quad', 'quad(side)', '5.0', '5.0(side)', '5.1', '5.1(side)'], {},
    AC3_RATES, null, ladder([192, 224, 256, 320, 384, 448, 512, 576, 640, 768, 1024], false, SURROUND_FLOOR, { upToStereo: 256, surround: 640 })),
  wmav2: lossy(2, MONO_STEREO, {}, null, 48000, ladder([128, 160, 192], true, 128, 192)),
  flac: lossless(8),
  alac: lossless(6, ['mono', 'stereo', '3.0', '4.0', '5.0', '5.1'], { '5.1(side)': '5.1', '5.0(side)': '5.0' }),
  wavpack: lossless(8),
  tta: lossless(8, ['mono', 'stereo', '2.1', 'quad', '5.1', '6.1(back)', '7.1(wide-side)'], { '5.1(side)': '5.1' })
}

/** Every PCM encoder takes any channel count, layout, and rate. */
const PCM_LIMITS: EncoderLimits = lossless(null)

function limitsOf(encoder: string): EncoderLimits
{
  return Object.hasOwn(ENCODER_LIMITS, encoder) ? ENCODER_LIMITS[encoder] : PCM_LIMITS
}

/** E-AC-3 rate for DTS core, ES, and HRA sources. */
const DTS_EAC3_KBPS = 640

const CODEC_ENCODERS: Readonly<Record<Exclude<OutputCodec, 'pcm'>, string>> =
{
  aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', flac: 'flac', alac: 'alac', ac3: 'ac3', eac3: 'eac3', wmav2: 'wmav2'
}

const OWN_ENCODERS: Readonly<Record<string, string>> =
{
  aac: 'aac', mp3: 'libmp3lame', mp2: 'mp2', opus: 'libopus', vorbis: 'libvorbis', ac3: 'ac3', eac3: 'eac3', wmav1: 'wmav2', wmav2: 'wmav2',
  flac: 'flac', alac: 'alac', wavpack: 'wavpack', tta: 'tta'
}

const LOSSLESS_CODECS: ReadonlySet<string> = new Set([
  'flac', 'alac', 'wavpack', 'tta', 'ape', 'wmalossless', 'tak', 'truehd', 'mlp', 'shorten', 'mp4als', 'ralf', 'osq'
])

const PLANNER_PCM: ReadonlySet<string> = new Set([...PCM_LE_ENCODERS, ...PCM_BE_ENCODERS])
const LOSSY_FALLBACK: readonly string[] = ['aac', 'libopus']
const UNNAMED_LAYOUT = /^(|unknown|\d+ channels)$/

function usable(encoder: string, caps: BuildCapabilities): boolean
{
  return caps.encoders.has(encoder) && !caps.experimental.has(encoder)
}

function isMp4Family(spec: ContainerSpec): boolean
{
  return spec.muxer === 'mp4' || spec.muxer === 'ipod' || spec.muxer === 'mov'
}

function isDtsHdMa(profile: string | null): boolean
{
  return profile !== null && profile.startsWith('DTS-HD MA')
}

/** True when the source codec is lossless: PCM, FLAC, ALAC, WavPack, TTA, Monkey's Audio, and the others without loss. */
export function isLosslessSource(a: AudioFacts): boolean
{
  const codec = a.codecName.toLowerCase()
  return codec.startsWith('pcm_') || LOSSLESS_CODECS.has(codec) || (codec === 'dts' && isDtsHdMa(a.profile))
}

const PCM_TYPE = /^pcm_(u8|s8|s16|s24|s32|f32|f64)/

/** The bit depth a lossless output keeps: the source's own, 24 for float and DTS sources, and 16 for other lossy ones. */
function sourceBits(a: AudioFacts): number
{
  const codec = a.codecName.toLowerCase()
  const pcm = PCM_TYPE.exec(codec)
  if (pcm !== null)
  {
    const type = pcm[1]
    return type.startsWith('f') ? 24 : type.endsWith('8') ? 8 : Number(type.slice(1))
  }
  if (codec === 'dts')
  {
    return a.bitsPerRawSample ?? 24
  }
  if (!isLosslessSource(a))
  {
    return 16
  }
  if (a.bitsPerRawSample !== null)
  {
    return a.bitsPerRawSample
  }
  return /^(u8|s16)p?$/.test(a.sampleFmt ?? '') ? 16 : 24
}

function isFloatSource(a: AudioFacts): boolean
{
  const codec = a.codecName.toLowerCase()
  return /^pcm_f(32|64)/.test(codec) || (codec === 'wavpack' && /^flt|^dbl/.test(a.sampleFmt ?? ''))
}

/** How the processed signal is pinned for an encoder: dithered 16-bit, 32-bit integer, or the encoder's own format. */
function pinFor(encoder: string, a: AudioFacts): PinFormat
{
  if (encoder.startsWith('pcm_'))
  {
    return /^pcm_(f|u8)/.test(encoder) ? 'encoder' : encoder.startsWith('pcm_s16') ? 's16-dither' : 's32'
  }
  if (encoder === 'wavpack' && isFloatSource(a))
  {
    return 'encoder'
  }
  if (encoder === 'flac' || encoder === 'alac' || encoder === 'wavpack' || encoder === 'tta')
  {
    return sourceBits(a) <= 16 ? 's16-dither' : 's32'
  }
  return 'encoder'
}

/** The PCM encoder for a chosen 'pcm' output: the source's sample type, little-endian unless only big-endian fits. */
function pcmEncoder(a: AudioFacts, spec: ContainerSpec): string
{
  const pcm = PCM_TYPE.exec(a.codecName.toLowerCase())
  const bits = sourceBits(a)
  const type = pcm !== null && pcm[1].startsWith('f') ? 'f32' : pcm !== null && pcm[1] === 'u8' ? 'u8' : bits <= 16 ? 's16' : bits <= 24 ? 's24' : 's32'
  const little = type === 'u8' ? 'pcm_u8' : `pcm_${type}le`
  const big = `pcm_${type === 'u8' ? 's16' : type}be`
  return !spec.audioEncoders.has(little) && spec.audioEncoders.has(big) ? big : little
}

interface Picked
{
  encoder: string
  notes: readonly EncoderNote[]
  /** A bitrate the route fixes instead of the ladder. */
  fixedKbps: number | null
}

interface Route
{
  /** The encoder of the source's own codec family, tried first whatever the container. */
  own: Picked | null
  /** Tried in order when the own encoder is missing; one the container takes is preferred. */
  fallback: readonly string[]
  /** Notes added when the fallback writes the stream. */
  fallbackNotes: readonly EncoderNote[]
}

const KEPT_LOSSLESS: readonly EncoderNote[] = ['no-source-encoder', 'lossless-kept-lossless']
const NO_SOURCE: readonly EncoderNote[] = ['no-source-encoder']

function losslessFallback(spec: ContainerSpec): readonly string[]
{
  return isMp4Family(spec) ? ['alac'] : ['flac', 'alac']
}

function own(encoder: string | null, notes: readonly EncoderNote[] = [], fixedKbps: number | null = null): Picked | null
{
  return encoder === null ? null : { encoder, notes, fixedKbps }
}

/**
 * The same-as-source route of a stream. Multichannel PCM in Matroska becomes FLAC, since Matroska keeps
 * no PCM channel layout; DTS core, ES, and HRA become E-AC-3 at 640k up to 5.1, since the native DTS
 * encoder is experimental.
 */
function inheritRoute(a: AudioFacts, spec: ContainerSpec, channels: number): Route
{
  const codec = a.codecName.toLowerCase()
  const lossless = losslessFallback(spec)
  if (PLANNER_PCM.has(codec))
  {
    return spec.muxer === 'matroska' && channels > 2
      ? { own: null, fallback: lossless, fallbackNotes: ['lossless-kept-lossless'] }
      : { own: own(codec), fallback: lossless, fallbackNotes: KEPT_LOSSLESS }
  }
  if (codec === 'dts' && !isDtsHdMa(a.profile))
  {
    return channels <= 6
      ? { own: own('eac3', NO_SOURCE, DTS_EAC3_KBPS), fallback: LOSSY_FALLBACK, fallbackNotes: NO_SOURCE }
      : { own: null, fallback: lossless, fallbackNotes: NO_SOURCE }
  }
  const encoder = own(Object.hasOwn(OWN_ENCODERS, codec) ? OWN_ENCODERS[codec] : null)
  return isLosslessSource(a)
    ? { own: encoder, fallback: lossless, fallbackNotes: KEPT_LOSSLESS }
    : { own: encoder, fallback: LOSSY_FALLBACK, fallbackNotes: NO_SOURCE }
}

function holds(encoder: string, channels: number): boolean
{
  const max = limitsOf(encoder).maxChannels
  return max === null || channels <= max
}

/** The encoder a route picks, or null when the build has none of its encoders. */
function pickEncoder(route: Route, spec: ContainerSpec, channels: number, caps: BuildCapabilities): Picked | null
{
  if (route.own !== null && usable(route.own.encoder, caps))
  {
    return route.own
  }
  const available = route.fallback.filter((encoder) => usable(encoder, caps))
  const fitting = available.find((encoder) => spec.audioEncoders.has(encoder) && holds(encoder, channels))
  const encoder = fitting ?? available.find((candidate) => holds(candidate, channels)) ?? available[0]
  return encoder === undefined ? null : { encoder, notes: route.fallbackNotes, fixedKbps: null }
}

function figure(value: Figure, channels: number): number
{
  return typeof value === 'number' ? value * channels / 2 : channels <= 2 ? value.upToStereo : value.surround
}

function scaledSteps(rule: BitrateRule, channels: number): number[]
{
  return rule.steps.map((step) => rule.perPair ? step * channels / 2 : step)
}

function stepAtOrAbove(steps: readonly number[], kbps: number): number
{
  return steps.find((step) => step >= kbps) ?? steps[steps.length - 1]
}

function capAtRate(rule: BitrateRule, kbps: number, sampleRate: number): number
{
  const cap = rule.lowRateCaps.find(([below]) => sampleRate < below)
  return cap === undefined ? kbps : Math.min(kbps, cap[1])
}

/** The same-as-source bitrate: the smallest ladder step at or above the source's rate and the floor, scaled to the output channels. */
function inheritKbps(rule: BitrateRule, a: AudioFacts, channels: number): number
{
  const steps = scaledSteps(rule, channels)
  if (a.bitRate === null)
  {
    return stepAtOrAbove(steps, figure(rule.fallback, channels))
  }
  const source = Math.round(a.bitRate / 1000) * (a.channels > 0 ? channels / a.channels : 1)
  return stepAtOrAbove(steps, Math.max(source, figure(rule.floor, channels)))
}

/** A chosen codec's bitrate: the per-pair rate scaled by channel pairs, kept within the ladder. */
function chosenKbps(rule: BitrateRule, perPair: number | null, channels: number): number
{
  const steps = scaledSteps(rule, channels)
  const wanted = perPair === null ? figure(rule.fallback, channels) : Math.round(perPair * channels / 2)
  if (rule.discrete)
  {
    return stepAtOrAbove(steps, wanted)
  }
  return Math.min(Math.max(wanted, steps[0]), steps[steps.length - 1])
}

/** The rate an encoder writes for a wanted rate: the wanted one when allowed, else the next allowed rate up, else the highest. */
function allowedRate(limits: EncoderLimits, wanted: number): number
{
  if (limits.rates !== null)
  {
    return limits.rates.find((rate) => rate >= wanted) ?? limits.rates[limits.rates.length - 1]
  }
  return limits.maxRate === null ? wanted : Math.min(wanted, limits.maxRate)
}

function refuse(reason: EncoderRefusal, encoder: string | null, maxChannels: number | null = null): EncoderDecision
{
  return { ok: false, reason, encoder, maxChannels }
}

/**
 * Chooses the encoder of one output stream. Same-as-source keeps the source's codec family and moves the
 * output to that codec's canonical container (or .mkv for a video file) when the container cannot take
 * it; a chosen codec does the same, except WMA v2, which only .wma, .wmv, and .asf outputs offer. Channel
 * limits apply to the output after any downmix and are never folded silently.
 */
export function chooseEncoder(a: AudioFacts, policy: EncoderPolicy, container: string, out: EncoderOutput,
  caps: BuildCapabilities): EncoderDecision
{
  const spec = containerFor(container)
  if (out.channels < 1 || UNNAMED_LAYOUT.test(out.layout))
  {
    return refuse('layout-unsupported', null)
  }
  let picked: Picked | null
  if (policy.kind === 'codec')
  {
    const encoder = policy.codec === 'pcm' ? pcmEncoder(a, spec) : CODEC_ENCODERS[policy.codec]
    if (!usable(encoder, caps))
    {
      return refuse('no-encoder', encoder)
    }
    picked = { encoder, notes: [], fixedKbps: null }
  }
  else
  {
    picked = pickEncoder(inheritRoute(a, spec, out.channels), spec, out.channels, caps)
    if (picked === null)
    {
      return refuse('no-encoder', null)
    }
  }
  const { encoder } = picked
  const limits = limitsOf(encoder)
  if (limits.maxChannels !== null && out.channels > limits.maxChannels)
  {
    return refuse('too-many-channels', encoder, limits.maxChannels)
  }
  const notes: EncoderNote[] = [...picked.notes]
  let target = spec.name
  if (!spec.audioEncoders.has(encoder))
  {
    target = out.video === true ? VIDEO_FALLBACK_CONTAINER : canonicalAudioContainer(encoder)
    if ((encoder === 'wmav2' && policy.kind === 'codec') || !containerFor(target).audioEncoders.has(encoder))
    {
      return refuse('container-cannot-hold', encoder, limits.maxChannels)
    }
  }
  let layout = out.layout
  if (limits.layouts !== null && !limits.layouts.includes(layout))
  {
    const remapped = Object.hasOwn(limits.remap, layout) ? limits.remap[layout] : null
    if (remapped === null)
    {
      return refuse('layout-unsupported', encoder, limits.maxChannels)
    }
    layout = remapped
    notes.push('layout-remapped')
  }
  const source = a.sampleRate > 0 ? a.sampleRate : 48000
  const wanted = out.minSampleRate !== null && out.minSampleRate > source ? out.minSampleRate : source
  if (wanted !== source)
  {
    notes.push('rate-raised')
  }
  const sampleRate = allowedRate(limits, wanted)
  if (sampleRate !== wanted)
  {
    notes.push('rate-converted')
  }
  let bitrateKbps: number | null = null
  if (limits.bitrate !== null)
  {
    const kbps = picked.fixedKbps ?? (policy.kind === 'codec'
      ? chosenKbps(limits.bitrate, policy.kbpsPerPair, out.channels)
      : inheritKbps(limits.bitrate, a, out.channels))
    bitrateKbps = capAtRate(limits.bitrate, kbps, sampleRate)
  }
  const containerChanged = target !== spec.name
  if (containerChanged)
  {
    notes.push('container-changed')
  }
  return {
    ok: true,
    choice: {
      encoder,
      bitrateKbps,
      kbpsPerPair: kbpsPerPair(bitrateKbps, out.channels),
      sampleRate,
      layout,
      channels: out.channels,
      pin: pinFor(encoder, a),
      extraArgs: encoder === 'aac' ? ['-aac_coder', 'fast'] : [],
      notes
    },
    container: target,
    containerChanged
  }
}

/** The encoder arguments of output audio stream N: -c:a:N, -b:a:N for lossy encoders, and each extra option with :a:N. */
export function encoderArgs(c: EncoderChoice, outIndex: number): string[]
{
  const args = [`-c:a:${outIndex}`, c.encoder]
  if (c.bitrateKbps !== null)
  {
    args.push(`-b:a:${outIndex}`, `${c.bitrateKbps}k`)
  }
  for (let i = 0; i + 1 < c.extraArgs.length; i += 2)
  {
    args.push(`${c.extraArgs[i]}:a:${outIndex}`, c.extraArgs[i + 1])
  }
  return args
}
