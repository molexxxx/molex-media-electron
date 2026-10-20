/**
 * Labels derived from recipe values, never from preset copy: the operation's name as users read it, the {op} word,
 * a recipe's description ("x264 CRF 23, max 1080p, AAC 192k"), the Recipe cell's label, the {preset} slug, and
 * whether a recipe differs from the preset it came from. The table, the picker, the inspector, the plans, and the
 * reports all read these, so a label always says what runs.
 */
import { formatNumber } from '../audio/messages'
import { findLoudnessPreset } from '../audio/presets'
import type { BoostRecipe, NormalizeRecipe, OutputCodec } from '../audio/types'
import type { AudioOut, ChannelRule, CompressRecipe, ConvertRecipe, ExtractRecipe, FrameFit, FrameSampling, Operation, Recipe, StreamPick, TimeRange, VideoEncoder } from './recipes'

const OPERATION_LABELS: Readonly<Record<Operation, string>> =
{
  normalize: 'Normalize',
  boost: 'Gain',
  convert: 'Convert',
  compress: 'Compress',
  extract: 'Extract'
}

/** An operation's name as users read it; the code's boost is Gain. */
export function operationLabel(op: Operation): string
{
  return OPERATION_LABELS[op]
}

/** An operation's word in file names, the {op} token: normalize, gain, convert, compress, or extract. */
export function operationWord(op: Operation): string
{
  return OPERATION_LABELS[op].toLowerCase()
}

const EXTRACT_NAMES: Readonly<Record<ExtractRecipe['mode'], string>> =
{
  audio: 'Extract audio',
  video: 'Extract video',
  gif: 'GIF',
  frames: 'Frames',
  subtitles: 'Extract subtitles'
}

/** What a recipe does, as a sentence names it: Extract names its mode ("Extract audio", "GIF", "Frames"). */
export function recipeOperationName(recipe: Recipe): string
{
  return recipe.kind === 'extract' ? EXTRACT_NAMES[recipe.mode] : operationLabel(recipe.kind)
}

const VIDEO_ENCODER_LABELS: Readonly<Record<VideoEncoder, string>> =
{
  'libx264': 'x264',
  'libx265': 'x265',
  'libvpx-vp9': 'VP9',
  'libaom-av1': 'AOM AV1',
  'libsvtav1': 'SVT-AV1',
  'prores_ks': 'ProRes',
  'ffv1': 'FFV1',
  'utvideo': 'UT Video',
  'mpeg2video': 'MPEG-2',
  'mpeg4': 'MPEG-4',
  'libtheora': 'Theora',
  'wmv2': 'WMV2'
}

/** A video encoder's short name ("x264", "SVT-AV1"). */
export function videoEncoderLabel(encoder: VideoEncoder): string
{
  return VIDEO_ENCODER_LABELS[encoder]
}

const CONTAINER_LABELS: Readonly<Record<string, string>> =
{
  webm: 'WebM', ogg: 'Ogg', oga: 'Ogg', opus: 'Opus', ac3: 'AC-3', eac3: 'E-AC-3', source: 'the source container'
}

/** A container's name from its extension ("MP4", "WebM"). */
export function containerLabel(container: string): string
{
  return Object.hasOwn(CONTAINER_LABELS, container) ? CONTAINER_LABELS[container] : container.toUpperCase()
}

const FORMAT_EXTENSIONS: Readonly<Record<string, readonly string[]>> =
{
  mov: ['mov', 'qt'],
  mp4: ['mp4', 'm4v'],
  m4a: ['m4a', 'm4b'],
  '3gp': ['3gp'],
  '3g2': ['3g2'],
  mj2: ['mj2'],
  matroska: ['mkv', 'mka', 'mks', 'mk3d'],
  webm: ['webm'],
  ogg: ['ogg', 'oga', 'ogv', 'opus', 'spx'],
  mpegts: ['ts', 'm2ts', 'mts'],
  mpeg: ['mpg', 'mpeg'],
  asf: ['asf', 'wmv', 'wma'],
  aiff: ['aiff', 'aif', 'aifc'],
  wav: ['wav', 'wave']
}

function formatExtensions(name: string): readonly string[]
{
  return Object.hasOwn(FORMAT_EXTENSIONS, name) ? FORMAT_EXTENSIONS[name] : [name]
}

function extensionOf(path: string): string
{
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * A probed file's container name. The probe's format name can be a list of every format one demuxer reads
 * ("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"), so the file's extension picks the name when the list covers
 * it ("M4A", "WebM"); otherwise the first format names it ("MOV", "MKV").
 */
export function sourceContainerLabel(format: string, path: string = ''): string
{
  const names = format.toLowerCase().split(',').map((name) => name.trim()).filter((name) => name !== '')
  if (names.length === 0)
  {
    return ''
  }
  const extension = extensionOf(path)
  if (extension !== '' && names.some((name) => formatExtensions(name).includes(extension)))
  {
    return containerLabel(extension)
  }
  return containerLabel(formatExtensions(names[0])[0])
}

const AUDIO_CODEC_LABELS: Readonly<Record<OutputCodec, string>> =
{
  aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC', ac3: 'AC-3', eac3: 'E-AC-3', pcm: 'PCM', wmav2: 'WMA'
}

/** An output codec's name ("AAC", "AC-3", "PCM"). */
export function audioCodecLabel(codec: OutputCodec): string
{
  return AUDIO_CODEC_LABELS[codec]
}

const LOSSLESS_CODECS: readonly OutputCodec[] = ['flac', 'alac', 'pcm']
const SURROUND_CODECS: readonly OutputCodec[] = ['ac3', 'eac3']

function kbps(value: number): string
{
  return `${Math.round(value)}k`
}

/**
 * An audio output with its bitrate. A bitrate is per channel pair, so mono reads half of it and stereo all of it;
 * kept layouts read the stereo figure, except AC-3 and E-AC-3, which read their 5.1 stream total.
 */
export function audioOutLabel(out: AudioOut, channels: ChannelRule = 'keep'): string
{
  if (out.kind === 'copy')
  {
    return 'audio copied'
  }
  const layout = channels === 'keep' ? '' : ` ${channels}`
  if (out.kind === 'same-as-source')
  {
    return `source audio codec${layout}`
  }
  const name = audioCodecLabel(out.codec)
  if (out.kbpsPerPair === null || LOSSLESS_CODECS.includes(out.codec))
  {
    return `${name}${layout}`
  }
  if (channels === 'mono')
  {
    return `${name} ${kbps(out.kbpsPerPair / 2)} mono`
  }
  if (channels === 'keep' && SURROUND_CODECS.includes(out.codec))
  {
    return `${name} ${kbps(out.kbpsPerPair * 3)} at 5.1`
  }
  return `${name} ${kbps(out.kbpsPerPair)}${layout}`
}

/** A frame size cap: "max 1080p" for a height, "max 1280 px wide" for a width, "max 1920x1080" for both. */
export function fitLabel(fit: FrameFit): string
{
  const size = fit.maxWidth !== null && fit.maxHeight !== null
    ? `max ${fit.maxWidth}x${fit.maxHeight}`
    : fit.maxHeight !== null ? `max ${fit.maxHeight}p` : `max ${fit.maxWidth} px wide`
  const mode = fit.mode === 'pad' ? ', padded' : fit.mode === 'crop' ? ', cropped' : ''
  return `${size}${mode}`
}

/** Rounds to whole milliseconds before splitting, so 59.9996 s carries into the minutes and reads 1:00, never 0:60. */
function clock(totalSec: number): string
{
  const totalMs = Math.round(totalSec * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const restMs = totalMs % 60_000
  const fraction = restMs % 1000
  const ss = `${String(Math.floor(restMs / 1000)).padStart(2, '0')}${fraction === 0 ? '' : `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`}`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/** A time range: "0:10 to 0:40", or "from 1:30" when it runs to the end. */
export function rangeLabel(range: TimeRange): string
{
  return range.durationSec === null
    ? `from ${clock(range.startSec)}`
    : `${clock(range.startSec)} to ${clock(range.startSec + range.durationSec)}`
}

function streamLabel(pick: StreamPick, kind: string): string | null
{
  if (pick.by === 'ordinal')
  {
    return `${kind} stream ${pick.ordinal}`
  }
  return pick.by === 'language' ? `${pick.language} ${kind}` : null
}

/** A file size in the page's megabytes (1 MB is 1,000,000 bytes). */
export function megabytes(bytes: number): string
{
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`
}

function parts(...items: Array<string | null | false>): string
{
  return items.filter((item): item is string => typeof item === 'string' && item !== '').join(', ')
}

/** The target as the audio messages print it: a zero-decimal preset's own figure as stated ("-16"), else one decimal. */
function targetText(recipe: NormalizeRecipe): string
{
  const value = recipe.target.integratedLufs
  const preset = findLoudnessPreset(recipe.presetId)
  return formatNumber(value, preset !== null && preset.targetDecimals === 0 && value === preset.target.integratedLufs ? 'stated' : 'level')
}

function describeNormalize(recipe: NormalizeRecipe): string
{
  const { target } = recipe
  return parts(
    `${targetText(recipe)} ${target.unit}`,
    `true peak ${formatNumber(target.maxTruePeakDbtp, 'amount')} dBTP`,
    recipe.policy === 'peak-limit' && `peak limiting up to ${formatNumber(recipe.maxLimitingDb, 'amount')} dB`,
    recipe.policy === 'reduce-dynamics' && 'dynamics reduced first',
    recipe.downmix === 'standard' && 'downmix to stereo',
    recipe.downmix === 'dialog' && 'stereo with dialog emphasis',
    recipe.output.kind === 'codec' && audioOutLabel(recipe.output)
  )
}

function describeBoost(recipe: BoostRecipe): string
{
  return parts(
    `${formatNumber(recipe.gainDb, 'gain')} dB`,
    recipe.highpassHz > 0 && `high-pass ${recipe.highpassHz} Hz`,
    `true peak ${formatNumber(recipe.maxTruePeakDbtp, 'amount')} dBTP`,
    recipe.output.kind === 'codec' && audioOutLabel(recipe.output)
  )
}

function containerUnlessNamed(container: string, audio: string): string | null
{
  const label = containerLabel(container)
  return audio.startsWith(`${label} `) || audio === label ? null : label
}

function describeConvert(recipe: ConvertRecipe): string
{
  const audio = audioOutLabel(recipe.audio, recipe.channels)
  const video = recipe.video
  if (video === null)
  {
    return parts(containerUnlessNamed(recipe.container, audio), audio, 'audio only', recipe.subtitles === 'drop' && 'subtitles dropped')
  }
  const copied = video.encoder === 'copy'
  return parts(
    containerLabel(recipe.container),
    copied ? 'video copied' : `${videoEncoderLabel(video.encoder as VideoEncoder)}${video.bitrateKbps === null ? '' : ` ${kbps(video.bitrateKbps)}`}`,
    !copied && video.fit !== null && fitLabel(video.fit),
    !copied && video.fps !== null && `${video.fps} fps`,
    video.pixelFormat === 'yuv420p10le' && '10-bit',
    audio,
    recipe.subtitles === 'drop' && 'subtitles dropped'
  )
}

const QUALITY_WORDS: Readonly<Record<string, string>> = { lossless: 'lossless', high: 'high quality', medium: 'medium quality', low: 'low quality' }

function describeCompress(recipe: CompressRecipe): string
{
  const { target } = recipe
  const aim = target.mode === 'quality'
    ? QUALITY_WORDS[target.tier]
    : target.mode === 'crf' ? `CRF ${target.crf}` : `target ${megabytes(target.targetBytes)}${target.twoPass ? ', 2-pass' : ''}`
  return parts(
    `${videoEncoderLabel(recipe.encoder)} ${aim}`,
    recipe.fit && fitLabel(recipe.fit),
    recipe.speed !== 'medium' && recipe.speed,
    recipe.tune !== null && `tune ${recipe.tune}`,
    recipe.pixelFormat === 'yuv420p10le' && '10-bit',
    recipe.audio.kind !== 'copy' && audioOutLabel(recipe.audio),
    recipe.container !== 'source' && containerLabel(recipe.container)
  )
}

const SUBTITLE_LABELS: Readonly<Record<string, string>> = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' }
const FRAME_LABELS: Readonly<Record<string, string>> = { png: 'PNG', jpg: 'JPEG', webp: 'WebP' }

function samplingLabel(sampling: FrameSampling): string
{
  switch (sampling.by)
  {
    case 'interval':
      return `a frame every ${sampling.seconds} s`
    case 'fps':
      return `${sampling.fps} frames per second`
    case 'count':
      return `${sampling.count} frames, evenly spaced`
    default:
      return 'one representative frame'
  }
}

const DITHER_LABELS: Readonly<Record<string, string>> = { bayer: 'Bayer dither', floyd_steinberg: 'Floyd-Steinberg dither', none: 'no dither' }

function playsLabel(plays: 'infinite' | number): string
{
  if (plays === 'infinite')
  {
    return 'loops'
  }
  return plays === 1 ? 'plays once' : `plays ${plays} times`
}

function describeExtract(recipe: ExtractRecipe): string
{
  switch (recipe.mode)
  {
    case 'audio':
    {
      const audio = audioOutLabel(recipe.audio, recipe.channels)
      return parts(
        containerUnlessNamed(recipe.container, audio),
        audio,
        recipe.sampleRate !== null && `${formatNumber(recipe.sampleRate, 'khz')} kHz`,
        streamLabel(recipe.stream, 'audio'),
        recipe.range && rangeLabel(recipe.range)
      )
    }
    case 'video':
      return parts(
        containerLabel(recipe.container),
        recipe.reencode === null ? 'video copied' : `${videoEncoderLabel(recipe.reencode.encoder)} CRF ${recipe.reencode.crf}`,
        recipe.range && rangeLabel(recipe.range)
      )
    case 'gif':
      return parts(
        `GIF ${recipe.fps} fps`,
        recipe.width !== null && `${recipe.width} px wide`,
        recipe.dither !== 'sierra2_4a' && DITHER_LABELS[recipe.dither],
        playsLabel(recipe.plays),
        recipe.range && rangeLabel(recipe.range)
      )
    case 'frames':
      return parts(
        `${FRAME_LABELS[recipe.format]} frames`,
        samplingLabel(recipe.sampling),
        recipe.jpgQuality !== null && `quality ${recipe.jpgQuality}`,
        recipe.range && rangeLabel(recipe.range)
      )
    default:
      return parts(`${SUBTITLE_LABELS[recipe.format]} subtitles`, streamLabel(recipe.stream, 'subtitle'))
  }
}

/** A recipe's values in one line ("x264 CRF 23, max 1080p, AAC 192k"; "-16 LKFS, true peak -1.0 dBTP"). */
export function describeRecipe(recipe: Recipe): string
{
  switch (recipe.kind)
  {
    case 'normalize':
      return describeNormalize(recipe)
    case 'boost':
      return describeBoost(recipe)
    case 'convert':
      return describeConvert(recipe)
    case 'compress':
      return describeCompress(recipe)
    default:
      return describeExtract(recipe)
  }
}

/**
 * The preset a recipe came from: its label and its whole recipe as applied to this recipe (for Normalize, with the
 * recipe's own output policy). Null when the recipe names no preset, names Custom, or names a preset that is gone.
 */
export type PresetLookup = (recipe: Recipe) => { label: string; recipe: Recipe } | null

const IDENTITY_KEYS = new Set(['presetId', 'userPreset', 'albumGroupId'])

function sameValue(a: unknown, b: unknown): boolean
{
  if (a === b)
  {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
  {
    return false
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

/** Whether two recipes run the same, whatever preset, user preset, or album group they name. */
export function sameRecipeValues(a: Recipe, b: Recipe): boolean
{
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => !IDENTITY_KEYS.has(key)))
  return [...keys].every((key) => sameValue(left[key], right[key]))
}

/** Whether a recipe's values differ from the preset it came from; false when it names no preset. */
export function isEdited(recipe: Recipe, lookup: PresetLookup): boolean
{
  const preset = lookup(recipe)
  return preset !== null && !sameRecipeValues(recipe, preset.recipe)
}

/** The preset part of the Recipe cell: the user preset's name as applied, the built-in label, or Custom. */
export function presetLabel(recipe: Recipe, lookup: PresetLookup): string
{
  const preset = lookup(recipe)
  if (recipe.userPreset !== null)
  {
    return preset === null ? `Custom (from deleted preset ${recipe.userPreset.name})` : recipe.userPreset.name
  }
  return preset?.label ?? 'Custom'
}

/** The Recipe cell: "Normalize · Streaming (EBU R 128 s2)", with ", edited" when it differs from its preset. */
export function recipeLabel(recipe: Recipe, lookup: PresetLookup): string
{
  return `${operationLabel(recipe.kind)} · ${presetLabel(recipe, lookup)}${isEdited(recipe, lookup) ? ', edited' : ''}`
}

function foldLatin(char: string): string
{
  const base = char.normalize('NFD').charAt(0)
  return /[A-Za-z]/.test(base) ? base : char
}

/** A name as a file-name slug: lowercase letters and digits joined by hyphens, accents dropped from Latin letters. */
export function slugify(name: string): string
{
  return [...name.normalize('NFC')].map(foldLatin).join('').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
}

/** The {preset} token: the user preset's name as a slug, else the built-in preset id, else custom. */
export function presetSlug(recipe: Recipe): string
{
  if (recipe.userPreset !== null)
  {
    return slugify(recipe.userPreset.name) || 'custom'
  }
  return recipe.presetId === null || recipe.presetId === 'custom' ? 'custom' : recipe.presetId
}
