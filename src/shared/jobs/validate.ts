/**
 * Runtime validators for every jobs command request and for every recipe, hand-written so main never trusts a
 * payload's shape: each returns the normalized request, or one issue per problem with its JSON path. Paths are trimmed
 * of spaces and surrounding quotes before the absolute-path check, so a path copied as text with quotes works.
 */
import { AUDIO_LIMITS, OUTPUT_CODECS, validateAudioRecipe } from '../audio/limits'
import type { Platform } from '../text/platform'
import { REVEAL_TARGETS, type Ack, type ClearScope, type CommandIssue, type JobCommandMap, type JobCommandName, type Validated } from './contract'
import { isJobId, isRunId, type JobId, type RunId } from './ids'
import { CRF_RANGES, EXTRACT_SAMPLE_RATES, JOB_LIMITS, type Range } from './limits'
import { VIDEO_ENCODERS, type Recipe, type VideoEncoder } from './recipes'
import { CONFLICT_RULES, PAUSE_MODES, type BatchPolicy, type Destination, type RunSettings } from './types'

/** The most jobs the queue holds; id lists, path lists, and counts stop there. */
export const MAX_REQUEST_ITEMS = 10_000

/** The longest path a request may carry, in characters: the Windows extended-length limit. */
export const MAX_PATH_LENGTH = 32_767

/** The most records one history page or search reply holds. */
export const MAX_PAGE = 500

/** The longest naming template, in characters. */
export const MAX_TEMPLATE_LENGTH = 1_024

/** The longest id or token a request names: client, scan, alert, preflight, tombstone, and preset ids. */
export const MAX_TOKEN_LENGTH = 200

/** The longest search query, in characters. */
export const MAX_QUERY_LENGTH = MAX_PATH_LENGTH

/** A user preset name's length after trimming. */
export const PRESET_NAME_LENGTH = { min: 1, max: 60 } as const

/** Fixed worker and GPU session counts. */
export const WORKER_LIMITS = { workers: { min: 1, max: 64 }, gpuSessions: { min: 1, max: 16 } } as const

/** The keys a recipe can be pinned to. */
export const PIN_KEYS = { min: 1, max: 9 } as const

const RECIPE_KINDS = ['normalize', 'boost', 'convert', 'compress', 'extract']
const PIXEL_FORMATS = ['source', 'yuv420p', 'yuv420p10le']
const CHANNEL_RULES = ['keep', 'stereo', 'mono']
const FIT_MODES = ['fit', 'pad', 'crop']
const SPEEDS = ['veryfast', 'fast', 'medium', 'slow', 'veryslow']
const TUNES = [null, 'film', 'animation', 'grain', 'fastdecode', 'zerolatency']
const QUALITY_TIERS = ['lossless', 'high', 'medium', 'low']
const DITHERS = ['sierra2_4a', 'bayer', 'floyd_steinberg', 'none']
const FRAME_FORMATS = ['png', 'jpg', 'webp']
const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass']
const REENCODERS = ['libx264', 'libvpx-vp9']
const CONTAINER_PATTERN = /^[a-z0-9]{1,8}$/
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const COUNT: Range = { min: 0, max: MAX_REQUEST_ITEMS }
const PAGE: Range = { min: 1, max: MAX_PAGE }
const ATTEMPT: Range = { min: 1, max: null }

type Fields = Record<string, unknown>

type Variants = Readonly<Record<string, readonly string[]>>

function isFields(value: unknown): value is Fields
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function join(path: string, key: string): string
{
  if (!path)
  {
    return key
  }
  return key ? `${path}.${key}` : path
}

function describeRange(range: Range, whole: boolean, unit: string): string
{
  const what = whole ? 'a whole number' : 'a number'
  const suffix = unit ? ` ${unit}` : ''
  return range.max === null ? `Must be ${what} of ${range.min}${suffix} or more.` : `Must be ${what} from ${range.min} to ${range.max}${suffix}.`
}

function listWords(values: readonly unknown[]): string
{
  return values.map((value) => (value === null ? 'null' : String(value))).join(', ')
}

/** A path with surrounding spaces and one pair of matching surrounding quotes removed. */
export function normalizePath(text: string): string
{
  const trimmed = text.trim()
  const first = trimmed.charAt(0)
  if (trimmed.length >= 2 && (first === '"' || first === '\'') && trimmed.charAt(trimmed.length - 1) === first)
  {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Whether a path is absolute on a platform: a drive path (C:\ or C:/) or a UNC path on win32, a path from / on darwin
 * and linux. With no platform, a path absolute on any of them passes.
 */
export function isAbsolutePath(path: string, platform: Platform | null): boolean
{
  const windows = /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path)
  const posix = path.startsWith('/')
  if (platform === 'win32')
  {
    return windows
  }
  return platform === null ? windows || posix : posix
}

/**
 * The first folder of an absolute Windows path that names a device (CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9)
 * once Windows drops its trailing dots and spaces, or null. The drive, or the server and share, are not folders.
 */
export function reservedFolderName(path: string): string | null
{
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  for (const part of parts.slice(/^[A-Za-z]:/.test(path) ? 1 : 2))
  {
    const name = part.replace(/[. ]+$/, '')
    if (DEVICE_NAME.test(name))
    {
      return name
    }
  }
  return null
}

/** Reads fields and collects one issue per problem; what it returns is meaningful only when it found none. */
class Reader
{
  readonly issues: CommandIssue[] = []

  constructor(readonly platform: Platform | null)
  {
  }

  add(path: string, message: string): void
  {
    this.issues.push({ path, message })
  }

  result<T>(value: T): Validated<T>
  {
    return this.issues.length === 0 ? { ok: true, value } : { ok: false, issues: this.issues }
  }

  /** Flags keys outside the shape; returns the object, or null after flagging a value that is not one. */
  object(value: unknown, path: string, keys: readonly string[], what: string): Fields | null
  {
    if (!isFields(value))
    {
      this.add(path, `Must be ${what}.`)
      return null
    }
    for (const key of Object.keys(value))
    {
      if (!keys.includes(key))
      {
        this.add(join(path, key), 'Unknown field.')
      }
    }
    return value
  }

  /** An object whose tag field picks its shape; an unknown tag is its one issue. */
  variant(value: unknown, path: string, tagKey: string, variants: Variants, what: string): { tag: string; fields: Fields } | null
  {
    if (!isFields(value))
    {
      this.add(path, `Must be ${what}.`)
      return null
    }
    const tag = value[tagKey]
    if (typeof tag !== 'string' || !Object.hasOwn(variants, tag))
    {
      this.add(join(path, tagKey), `Must be one of: ${Object.keys(variants).join(', ')}.`)
      return null
    }
    this.object(value, path, variants[tag], what)
    return { tag, fields: value }
  }

  bool(fields: Fields, path: string, key: string): boolean
  {
    const value = fields[key]
    if (typeof value !== 'boolean')
    {
      this.add(join(path, key), 'Must be true or false.')
    }
    return value as boolean
  }

  oneOf<T>(fields: Fields, path: string, key: string, values: readonly T[]): T
  {
    const value = fields[key]
    if (!values.includes(value as T))
    {
      this.add(join(path, key), `Must be one of: ${listWords(values)}.`)
    }
    return value as T
  }

  number(fields: Fields, path: string, key: string, range: Range, unit = ''): number
  {
    const value = fields[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || (range.max !== null && value > range.max))
    {
      this.add(join(path, key), describeRange(range, false, unit))
    }
    return value as number
  }

  whole(fields: Fields, path: string, key: string, range: Range, unit = ''): number
  {
    const value = fields[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < range.min || (range.max !== null && value > range.max))
    {
      this.add(join(path, key), describeRange(range, true, unit))
    }
    return value as number
  }

  token(fields: Fields, path: string, key: string): string
  {
    const value = fields[key]
    if (typeof value !== 'string' || value === '' || value.length > MAX_TOKEN_LENGTH)
    {
      this.add(join(path, key), `Must be a non-empty string of at most ${MAX_TOKEN_LENGTH} characters.`)
    }
    return value as string
  }

  jobId(fields: Fields, path: string, key: string): JobId
  {
    const value = fields[key]
    if (!isJobId(value))
    {
      this.add(join(path, key), 'Must be a catalog number such as MM-0142.')
    }
    return value as JobId
  }

  runId(fields: Fields, path: string, key: string): RunId
  {
    const value = fields[key]
    if (!isRunId(value))
    {
      this.add(join(path, key), 'Must be a run id such as R-0031.')
    }
    return value as RunId
  }

  /**
   * A list of 1 to MAX_REQUEST_ITEMS items, each read as the field named by its index; the item's issues move under
   * the list's path with the index in brackets. An empty or oversized list is one issue. Items are read by index
   * because structured clone keeps holes in a sparse list, and a hole must read as a missing item.
   */
  list<T>(fields: Fields, path: string, key: string, what: string, read: (item: Fields, index: string) => T): T[]
  {
    const items = fields[key]
    const at = join(path, key)
    if (!Array.isArray(items))
    {
      this.add(at, `Must be a list of ${what}.`)
      return []
    }
    if (items.length === 0 || items.length > MAX_REQUEST_ITEMS)
    {
      this.add(at, `Must list 1 to ${MAX_REQUEST_ITEMS} ${what}.`)
      return []
    }
    const values: T[] = []
    for (let position = 0; position < items.length; position++)
    {
      const index = String(position)
      const before = this.issues.length
      values.push(read({ [index]: items[position] }, index))
      for (let i = before; i < this.issues.length; i++)
      {
        const issue = this.issues[i]
        this.issues[i] = { path: `${at}[${index}]${issue.path.slice(index.length)}`, message: issue.message }
      }
    }
    return values
  }

  /** A list of catalog numbers, with repeats dropped. */
  jobIds(fields: Fields, path: string, key: string): JobId[]
  {
    return [...new Set(this.list(fields, path, key, 'catalog numbers', (item, index) => this.jobId(item, '', index)))]
  }

  /** A list of catalog numbers, or one of the words the command accepts in its place. */
  jobIdsOr<W extends string>(fields: Fields, path: string, key: string, words: readonly W[]): JobId[] | W
  {
    const value = fields[key]
    if (typeof value === 'string' && (words as readonly string[]).includes(value))
    {
      return value as W
    }
    if (!Array.isArray(value))
    {
      this.add(join(path, key), `Must be a list of catalog numbers or one of: ${listWords(words)}.`)
      return []
    }
    return this.jobIds(fields, path, key)
  }

  /** An absolute path, trimmed of spaces and surrounding quotes. */
  path(fields: Fields, path: string, key: string): string
  {
    const value = fields[key]
    const at = join(path, key)
    if (typeof value !== 'string')
    {
      this.add(at, 'Must be an absolute path.')
      return ''
    }
    const normalized = normalizePath(value)
    if (normalized.includes('\0'))
    {
      this.add(at, 'Must not contain a NUL character.')
    }
    else if (normalized.length > MAX_PATH_LENGTH)
    {
      this.add(at, `Must be at most ${MAX_PATH_LENGTH} characters.`)
    }
    else if (!isAbsolutePath(normalized, this.platform))
    {
      this.add(at, 'Must be an absolute path.')
    }
    return normalized
  }

  /** A destination folder: an absolute path whose folders name no Windows device when it is a Windows path. */
  folder(fields: Fields, path: string, key: string): string
  {
    const before = this.issues.length
    const folder = this.path(fields, path, key)
    const windows = this.platform === 'win32' || (this.platform === null && isAbsolutePath(folder, 'win32'))
    const reserved = windows && this.issues.length === before ? reservedFolderName(folder) : null
    if (reserved !== null)
    {
      this.add(join(path, key), `Must not contain a folder named ${reserved}; Windows reserves that name for a device.`)
    }
    return folder
  }

  /** A preset name, trimmed, of 1 to 60 characters. */
  name(fields: Fields, path: string, key: string): string
  {
    const value = fields[key]
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed.length < PRESET_NAME_LENGTH.min || trimmed.length > PRESET_NAME_LENGTH.max)
    {
      this.add(join(path, key), `Must be a name of ${PRESET_NAME_LENGTH.min} to ${PRESET_NAME_LENGTH.max} characters.`)
    }
    return trimmed
  }

  /** Null, or what the reader reads. */
  nullable<T>(fields: Fields, key: string, read: () => T): T | null
  {
    return fields[key] === null ? null : read()
  }

  ack(fields: Fields, key: string): Ack | null
  {
    return this.nullable(fields, key, () =>
    {
      const ack = this.object(fields[key], key, ['preflightId', 'originalsAffected', 'overwrites'], 'null or an acknowledgment')
      if (!ack)
      {
        return null
      }
      return {
        preflightId: this.token(ack, key, 'preflightId'),
        originalsAffected: this.whole(ack, key, 'originalsAffected', COUNT),
        overwrites: this.whole(ack, key, 'overwrites', COUNT)
      }
    })
  }

  recipe(value: unknown, path: string): Recipe
  {
    if (!isFields(value))
    {
      this.add(path, 'Must be a recipe.')
    }
    else if (value.kind === 'normalize' || value.kind === 'boost')
    {
      for (const issue of validateAudioRecipe(value))
      {
        this.add(join(path, issue.path), issue.message)
      }
    }
    else if (value.kind === 'convert')
    {
      checkConvert(this, value, path)
    }
    else if (value.kind === 'compress')
    {
      checkCompress(this, value, path)
    }
    else if (value.kind === 'extract')
    {
      checkExtract(this, value, path)
    }
    else
    {
      this.add(join(path, 'kind'), `Must be one of: ${listWords(RECIPE_KINDS)}.`)
    }
    return value as Recipe
  }

  recipeField(fields: Fields, path: string, key: string): Recipe
  {
    return this.recipe(fields[key], join(path, key))
  }
}

function checkPresetRefs(r: Reader, recipe: Fields, path: string): void
{
  if (recipe.presetId !== null)
  {
    r.token(recipe, path, 'presetId')
  }
  if (recipe.userPreset === null)
  {
    return
  }
  const at = join(path, 'userPreset')
  const ref = r.object(recipe.userPreset, at, ['id', 'name'], 'null or a user preset reference')
  if (ref)
  {
    r.token(ref, at, 'id')
    if (typeof ref.name !== 'string' || ref.name.length > PRESET_NAME_LENGTH.max)
    {
      r.add(join(at, 'name'), `Must be a name of at most ${PRESET_NAME_LENGTH.max} characters.`)
    }
  }
}

function checkContainer(r: Reader, fields: Fields, path: string, orSource: boolean): void
{
  const value = fields.container
  const extension = typeof value === 'string' && value !== 'source' && CONTAINER_PATTERN.test(value)
  if (!extension && !(orSource && value === 'source'))
  {
    r.add(join(path, 'container'), orSource ? 'Must be source or a container extension such as mkv.' : 'Must be a container extension such as mp4.')
  }
}

const AUDIO_OUT: Variants = { 'copy': ['kind'], 'same-as-source': ['kind'], 'codec': ['kind', 'codec', 'kbpsPerPair'] }

/** Checks a video operation's audio output; true when it copies the audio. */
function checkAudioOut(r: Reader, fields: Fields, path: string): boolean
{
  const at = join(path, 'audio')
  const out = r.variant(fields.audio, at, 'kind', AUDIO_OUT, 'an audio output')
  if (out?.tag === 'codec')
  {
    r.oneOf(out.fields, at, 'codec', OUTPUT_CODECS)
    if (out.fields.kbpsPerPair !== null)
    {
      r.number(out.fields, at, 'kbpsPerPair', AUDIO_LIMITS.kbpsPerPair, 'kb/s')
    }
  }
  return out?.tag === 'copy'
}

function checkChannels(r: Reader, fields: Fields, path: string, copied: boolean): void
{
  const channels = r.oneOf(fields, path, 'channels', CHANNEL_RULES)
  if (copied && channels !== 'keep' && CHANNEL_RULES.includes(channels))
  {
    r.add(join(path, 'channels'), 'Must be keep when the audio is copied.')
  }
}

function checkFit(r: Reader, fields: Fields, path: string): void
{
  if (fields.fit === null)
  {
    return
  }
  const at = join(path, 'fit')
  const fit = r.object(fields.fit, at, ['maxWidth', 'maxHeight', 'mode'], 'null or a frame size cap')
  if (!fit)
  {
    return
  }
  if (fit.maxWidth === null && fit.maxHeight === null)
  {
    r.add(at, 'Must set a maximum width, a maximum height, or both.')
  }
  if (fit.maxWidth !== null)
  {
    r.whole(fit, at, 'maxWidth', JOB_LIMITS.frameSize, 'px')
  }
  if (fit.maxHeight !== null)
  {
    r.whole(fit, at, 'maxHeight', JOB_LIMITS.frameSize, 'px')
  }
  r.oneOf(fit, at, 'mode', FIT_MODES)
}

function checkRange(r: Reader, fields: Fields, path: string): void
{
  if (fields.range === null)
  {
    return
  }
  const at = join(path, 'range')
  const range = r.object(fields.range, at, ['startSec', 'durationSec'], 'null or a time range')
  if (range)
  {
    r.number(range, at, 'startSec', JOB_LIMITS.rangeStartSec, 's')
    if (range.durationSec !== null)
    {
      r.number(range, at, 'durationSec', JOB_LIMITS.rangeDurationSec, 's')
    }
  }
}

const STREAM_PICKS: Variants = { default: ['by'], ordinal: ['by', 'ordinal'], language: ['by', 'language'] }

function checkStream(r: Reader, fields: Fields, path: string): void
{
  const at = join(path, 'stream')
  const pick = r.variant(fields.stream, at, 'by', STREAM_PICKS, 'a stream choice')
  if (pick?.tag === 'ordinal')
  {
    r.whole(pick.fields, at, 'ordinal', JOB_LIMITS.streamOrdinal)
  }
  else if (pick?.tag === 'language' && (typeof pick.fields.language !== 'string' || !LANGUAGE_PATTERN.test(pick.fields.language)))
  {
    r.add(join(at, 'language'), 'Must be a language tag such as eng or en-US.')
  }
}

function checkCrf(r: Reader, fields: Fields, path: string, encoder: unknown): void
{
  if (typeof encoder !== 'string' || !Object.hasOwn(CRF_RANGES, encoder))
  {
    return
  }
  const range = CRF_RANGES[encoder as VideoEncoder]
  if (range === null)
  {
    r.add(join(path, 'crf'), 'This encoder has no CRF; choose a quality tier or a size target.')
    return
  }
  r.whole(fields, path, 'crf', range)
}

const CONVERT_KEYS = ['kind', 'presetId', 'userPreset', 'container', 'video', 'audio', 'channels', 'subtitles']
const CONVERT_VIDEO_KEYS = ['encoder', 'bitrateKbps', 'fit', 'fps', 'pixelFormat']

function checkConvertVideo(r: Reader, recipe: Fields, path: string): void
{
  const at = join(path, 'video')
  const video = r.object(recipe.video, at, CONVERT_VIDEO_KEYS, 'null or a video encode')
  if (!video)
  {
    return
  }
  const encoder = r.oneOf(video, at, 'encoder', [...VIDEO_ENCODERS, 'copy'])
  const pixelFormat = r.oneOf(video, at, 'pixelFormat', PIXEL_FORMATS)
  if (encoder === 'copy')
  {
    for (const key of ['bitrateKbps', 'fit', 'fps'])
    {
      if (video[key] !== null)
      {
        r.add(join(at, key), 'Must be null when the video is copied.')
      }
    }
    if (pixelFormat !== 'source' && PIXEL_FORMATS.includes(pixelFormat))
    {
      r.add(join(at, 'pixelFormat'), 'Must be source when the video is copied.')
    }
    return
  }
  if (video.bitrateKbps !== null)
  {
    r.whole(video, at, 'bitrateKbps', JOB_LIMITS.videoBitrateKbps, 'kb/s')
  }
  checkFit(r, video, at)
  if (video.fps !== null)
  {
    r.number(video, at, 'fps', JOB_LIMITS.fps, 'fps')
  }
}

function checkConvert(r: Reader, recipe: Fields, path: string): void
{
  r.object(recipe, path, CONVERT_KEYS, 'a convert recipe')
  checkPresetRefs(r, recipe, path)
  checkContainer(r, recipe, path, false)
  if (recipe.video !== null)
  {
    checkConvertVideo(r, recipe, path)
  }
  const copied = checkAudioOut(r, recipe, path)
  checkChannels(r, recipe, path, copied)
  r.oneOf(recipe, path, 'subtitles', ['keep', 'drop'])
}

const COMPRESS_KEYS = ['kind', 'presetId', 'userPreset', 'target', 'encoder', 'speed', 'pixelFormat', 'tune', 'fit', 'audio', 'container']
const COMPRESS_TARGETS: Variants = { quality: ['mode', 'tier'], crf: ['mode', 'crf'], size: ['mode', 'targetBytes', 'twoPass'] }

function checkCompress(r: Reader, recipe: Fields, path: string): void
{
  r.object(recipe, path, COMPRESS_KEYS, 'a compress recipe')
  checkPresetRefs(r, recipe, path)
  const encoder = r.oneOf(recipe, path, 'encoder', VIDEO_ENCODERS)
  const at = join(path, 'target')
  const target = r.variant(recipe.target, at, 'mode', COMPRESS_TARGETS, 'a quality, CRF, or size target')
  if (target?.tag === 'quality')
  {
    r.oneOf(target.fields, at, 'tier', QUALITY_TIERS)
  }
  else if (target?.tag === 'crf')
  {
    checkCrf(r, target.fields, at, encoder)
  }
  else if (target?.tag === 'size')
  {
    r.whole(target.fields, at, 'targetBytes', JOB_LIMITS.targetBytes, 'bytes')
    r.bool(target.fields, at, 'twoPass')
  }
  r.oneOf(recipe, path, 'speed', SPEEDS)
  r.oneOf(recipe, path, 'pixelFormat', PIXEL_FORMATS)
  r.oneOf(recipe, path, 'tune', TUNES)
  checkFit(r, recipe, path)
  checkAudioOut(r, recipe, path)
  checkContainer(r, recipe, path, true)
}

const EXTRACT_BASE = ['kind', 'presetId', 'userPreset', 'mode']
const EXTRACT_MODES: Variants =
{
  audio: [...EXTRACT_BASE, 'stream', 'audio', 'container', 'sampleRate', 'channels', 'range'],
  video: [...EXTRACT_BASE, 'container', 'reencode', 'range'],
  gif: [...EXTRACT_BASE, 'fps', 'width', 'dither', 'plays', 'range'],
  frames: [...EXTRACT_BASE, 'sampling', 'format', 'jpgQuality', 'range'],
  subtitles: [...EXTRACT_BASE, 'stream', 'format']
}
const SAMPLINGS: Variants = { interval: ['by', 'seconds'], fps: ['by', 'fps'], count: ['by', 'count'], thumbnail: ['by'] }

function checkExtractAudio(r: Reader, recipe: Fields, path: string): void
{
  checkStream(r, recipe, path)
  const copied = checkAudioOut(r, recipe, path)
  checkContainer(r, recipe, path, false)
  const sampleRate = r.oneOf(recipe, path, 'sampleRate', [null, ...EXTRACT_SAMPLE_RATES])
  if (copied && sampleRate !== null && EXTRACT_SAMPLE_RATES.includes(sampleRate))
  {
    r.add(join(path, 'sampleRate'), 'Must be null when the audio is copied.')
  }
  checkChannels(r, recipe, path, copied)
  checkRange(r, recipe, path)
}

function checkExtractVideo(r: Reader, recipe: Fields, path: string): void
{
  checkContainer(r, recipe, path, false)
  if (recipe.reencode !== null)
  {
    const at = join(path, 'reencode')
    const reencode = r.object(recipe.reencode, at, ['encoder', 'crf'], 'null or a re-encode')
    if (reencode)
    {
      checkCrf(r, reencode, at, r.oneOf(reencode, at, 'encoder', REENCODERS))
    }
  }
  checkRange(r, recipe, path)
}

function checkExtractGif(r: Reader, recipe: Fields, path: string): void
{
  r.number(recipe, path, 'fps', JOB_LIMITS.gifFps, 'fps')
  if (recipe.width !== null)
  {
    r.whole(recipe, path, 'width', JOB_LIMITS.gifWidth, 'px')
  }
  r.oneOf(recipe, path, 'dither', DITHERS)
  if (recipe.plays !== 'infinite')
  {
    r.whole(recipe, path, 'plays', JOB_LIMITS.gifPlays)
  }
  checkRange(r, recipe, path)
}

function checkExtractFrames(r: Reader, recipe: Fields, path: string): void
{
  const at = join(path, 'sampling')
  const sampling = r.variant(recipe.sampling, at, 'by', SAMPLINGS, 'a frame sampling')
  if (sampling?.tag === 'interval')
  {
    r.number(sampling.fields, at, 'seconds', JOB_LIMITS.frameIntervalSec, 's')
  }
  else if (sampling?.tag === 'fps')
  {
    r.number(sampling.fields, at, 'fps', JOB_LIMITS.frameFps, 'fps')
  }
  else if (sampling?.tag === 'count')
  {
    r.whole(sampling.fields, at, 'count', JOB_LIMITS.frameCount)
  }
  const format = r.oneOf(recipe, path, 'format', FRAME_FORMATS)
  if (recipe.jpgQuality !== null && format === 'jpg')
  {
    r.whole(recipe, path, 'jpgQuality', JOB_LIMITS.jpgQuality)
  }
  else if (recipe.jpgQuality !== null && FRAME_FORMATS.includes(format))
  {
    r.add(join(path, 'jpgQuality'), 'Must be null unless the format is jpg.')
  }
  checkRange(r, recipe, path)
}

function checkExtract(r: Reader, recipe: Fields, path: string): void
{
  const extract = r.variant(recipe, path, 'mode', EXTRACT_MODES, 'an extract recipe')
  if (!extract)
  {
    return
  }
  checkPresetRefs(r, recipe, path)
  if (extract.tag === 'audio')
  {
    checkExtractAudio(r, recipe, path)
  }
  else if (extract.tag === 'video')
  {
    checkExtractVideo(r, recipe, path)
  }
  else if (extract.tag === 'gif')
  {
    checkExtractGif(r, recipe, path)
  }
  else if (extract.tag === 'frames')
  {
    checkExtractFrames(r, recipe, path)
  }
  else
  {
    checkStream(r, recipe, path)
    r.oneOf(recipe, path, 'format', SUBTITLE_FORMATS)
  }
}

/** Every shape, enum, and range problem of a recipe, one issue per field; audio ranges come from the audio limits. */
export function validateRecipe(input: unknown): Validated<Recipe>
{
  const reader = new Reader(null)
  return reader.result(reader.recipe(input, ''))
}

/** A validator for every command's request; a command without one does not compile. */
export type RequestValidators = { [K in JobCommandName]: (raw: unknown) => Validated<JobCommandMap[K]['req']> }

type SettingsPatch = JobCommandMap['setSettings']['req']['settings']

const SETTINGS_KEYS = ['priority', 'keepAwake', 'verifyVideo', 'notify', 'measureOnReview', 'includeSubfolders']

function readSettings(r: Reader, fields: Fields): SettingsPatch
{
  const settings = r.object(fields.settings, 'settings', SETTINGS_KEYS, 'a settings object')
  const patch: SettingsPatch = {}
  if (!settings)
  {
    return patch
  }
  if ('priority' in settings)
  {
    patch.priority = r.oneOf(settings, 'settings', 'priority', ['below-normal', 'normal'] as const)
  }
  if ('verifyVideo' in settings)
  {
    patch.verifyVideo = r.oneOf(settings, 'settings', 'verifyVideo', ['full', 'sampled'] as const)
  }
  for (const key of ['keepAwake', 'measureOnReview', 'includeSubfolders'] as const)
  {
    if (key in settings)
    {
      patch[key] = r.bool(settings, 'settings', key)
    }
  }
  if ('notify' in settings)
  {
    const notify = r.object(settings.notify, 'settings.notify', ['completion', 'firstFailure'], 'a notification setting')
    if (notify)
    {
      patch.notify = { completion: r.bool(notify, 'settings.notify', 'completion'), firstFailure: r.bool(notify, 'settings.notify', 'firstFailure') }
    }
  }
  return patch
}

const COUNT_MODES: Variants = { auto: ['mode'], fixed: ['mode', 'count'] }

function readCount(r: Reader, fields: Fields, key: string, range: Range): RunSettings['workers']
{
  const setting = r.variant(fields[key], key, 'mode', COUNT_MODES, 'auto or a fixed count')
  if (setting?.tag === 'fixed')
  {
    return { mode: 'fixed', count: r.whole(setting.fields, key, 'count', range) }
  }
  return { mode: 'auto' }
}

const DESTINATIONS: Variants = { 'folder': ['mode', 'folder'], 'next-to-source': ['mode'], 'replace-originals': ['mode'] }

function readPolicy(r: Reader, fields: Fields): Omit<BatchPolicy, 'rev'>
{
  const policy = r.object(fields.policy, 'policy', ['destination', 'template', 'conflict', 'displaced', 'gpu'], 'a batch policy')
  if (!policy)
  {
    return fields.policy as Omit<BatchPolicy, 'rev'>
  }
  const destination = r.variant(policy.destination, 'policy.destination', 'mode', DESTINATIONS, 'a destination')
  if (typeof policy.template !== 'string' || policy.template.length > MAX_TEMPLATE_LENGTH)
  {
    r.add('policy.template', `Must be a naming template of at most ${MAX_TEMPLATE_LENGTH} characters.`)
  }
  return {
    destination: destination?.tag === 'folder'
      ? { mode: 'folder', folder: r.folder(destination.fields, 'policy.destination', 'folder') }
      : policy.destination as Destination,
    template: policy.template as string,
    conflict: r.oneOf(policy, 'policy', 'conflict', CONFLICT_RULES),
    displaced: r.oneOf(policy, 'policy', 'displaced', ['trash', 'keep'] as const),
    gpu: r.oneOf(policy, 'policy', 'gpu', ['off', 'auto', 'require'] as const)
  }
}

function readAssignments(r: Reader, fields: Fields): JobCommandMap['assignRecipe']['req']['assignments']
{
  const seen = new Set<string>()
  return r.list(fields, '', 'assignments', 'assignments', (item, index) =>
  {
    const assignment = r.object(item[index], index, ['jobId', 'recipe'], 'an assignment')
    if (!assignment)
    {
      return item[index] as { jobId: JobId; recipe: Recipe }
    }
    const jobId = r.jobId(assignment, index, 'jobId')
    if (seen.has(jobId))
    {
      r.add(join(index, 'jobId'), 'Must not assign a recipe to the same job twice.')
    }
    seen.add(jobId)
    return { jobId, recipe: r.recipeField(assignment, index, 'recipe') }
  })
}

const CLEAR_SCOPES: Variants = { done: ['kind'], finished: ['kind'], ids: ['kind', 'ids'] }

function readClearScope(r: Reader, fields: Fields): ClearScope
{
  const scope = r.variant(fields.scope, 'scope', 'kind', CLEAR_SCOPES, 'a clear scope')
  if (scope?.tag === 'ids')
  {
    return { kind: 'ids', ids: r.jobIds(scope.fields, 'scope', 'ids') }
  }
  return fields.scope as ClearScope
}

function readReportScope(r: Reader, fields: Fields): JobCommandMap['exportReport']['req']['scope']
{
  const byRun = isFields(fields.scope) && 'runId' in fields.scope
  const scope = r.object(fields.scope, 'scope', byRun ? ['runId'] : ['ids'], 'a run or a list of jobs')
  if (!scope)
  {
    return fields.scope as { runId: RunId }
  }
  return byRun ? { runId: r.runId(scope, 'scope', 'runId') } : { ids: r.jobIds(scope, 'scope', 'ids') }
}

function readQuery(r: Reader, fields: Fields): string
{
  const query = typeof fields.query === 'string' ? fields.query.trim() : ''
  if (query === '' || query.length > MAX_QUERY_LENGTH)
  {
    r.add('query', `Must be a search of 1 to ${MAX_QUERY_LENGTH} characters.`)
  }
  return query
}

function request<T>(platform: Platform | null, keys: readonly string[], read: (r: Reader, fields: Fields) => T): (raw: unknown) => Validated<T>
{
  return (raw) =>
  {
    const reader = new Reader(platform)
    const fields = reader.object(raw, '', keys, 'a request object')
    return reader.result(fields ? read(reader, fields) : raw as T)
  }
}

/**
 * The request validators for one platform's absolute paths; main builds them once with its own platform. With null,
 * an absolute path of any platform passes.
 */
export function createRequestValidators(platform: Platform | null): RequestValidators
{
  const ids = (r: Reader, f: Fields): { ids: JobId[] } => ({ ids: r.jobIds(f, '', 'ids') })
  const recipeOrNull = (r: Reader, f: Fields): Recipe | null => r.nullable(f, 'recipe', () => r.recipeField(f, '', 'recipe'))
  return {
    subscribe: request(platform, ['clientId'], (r, f) => ({ clientId: r.token(f, '', 'clientId') })),
    unsubscribe: request(platform, ['clientId'], (r, f) => ({ clientId: r.token(f, '', 'clientId') })),
    get: request(platform, ['jobId'], (r, f) => ({ jobId: r.jobId(f, '', 'jobId') })),
    add: request(platform, ['paths', 'recipe', 'origin', 'after', 'recursive', 'allowSecondJobs', 'force'], (r, f) => ({
      paths: r.list(f, '', 'paths', 'absolute paths', (item, index) => r.path(item, '', index)),
      recipe: recipeOrNull(r, f),
      origin: r.oneOf(f, '', 'origin', ['files', 'folder', 'drop'] as const),
      after: r.nullable(f, 'after', () => r.jobId(f, '', 'after')),
      recursive: r.bool(f, '', 'recursive'),
      allowSecondJobs: r.bool(f, '', 'allowSecondJobs'),
      force: r.bool(f, '', 'force')
    })),
    pasteFiles: request(platform, ['recipe', 'recursive'], (r, f) => ({ recipe: recipeOrNull(r, f), recursive: r.bool(f, '', 'recursive') })),
    cancelScan: request(platform, ['scanId'], (r, f) => ({ scanId: r.token(f, '', 'scanId') })),
    forgetFolder: request(platform, ['path'], (r, f) => ({ path: r.path(f, '', 'path') })),
    clearRecentFolders: request(platform, [], () => ({})),
    remove: request(platform, ['ids'], ids),
    restore: request(platform, ['tombstone'], (r, f) => ({ tombstone: r.token(f, '', 'tombstone') })),
    reorder: request(platform, ['ids', 'before'], (r, f) => ({
      ids: r.jobIds(f, '', 'ids'),
      before: r.nullable(f, 'before', () => r.jobId(f, '', 'before'))
    })),
    assignRecipe: request(platform, ['assignments'], (r, f) => ({ assignments: readAssignments(r, f) })),
    duplicate: request(platform, ['ids', 'recipe'], (r, f) => ({ ids: r.jobIds(f, '', 'ids'), recipe: recipeOrNull(r, f) })),
    locate: request(platform, ['jobId', 'path'], (r, f) => ({ jobId: r.jobId(f, '', 'jobId'), path: r.path(f, '', 'path') })),
    relink: request(platform, ['fromDir', 'toDir', 'ids'], (r, f) => ({
      fromDir: r.path(f, '', 'fromDir'),
      toDir: r.path(f, '', 'toDir'),
      ids: r.jobIdsOr(f, '', 'ids', ['missing'] as const)
    })),
    reprobe: request(platform, ['ids'], ids),
    setPolicy: request(platform, ['policy'], (r, f) => ({ policy: readPolicy(r, f) })),
    setDefaultRecipe: request(platform, ['recipe'], (r, f) => ({ recipe: r.recipeField(f, '', 'recipe') })),
    preflight: request(platform, ['ids'], (r, f) => ({ ids: r.jobIdsOr(f, '', 'ids', ['pending'] as const) })),
    analyze: request(platform, ['ids'], ids),
    cancelAnalyze: request(platform, ['ids'], (r, f) => ({ ids: r.jobIdsOr(f, '', 'ids', ['all'] as const) })),
    start: request(platform, ['preflightId', 'ack', 'resume'], (r, f) => ({
      preflightId: r.token(f, '', 'preflightId'),
      ack: r.ack(f, 'ack'),
      resume: r.bool(f, '', 'resume')
    })),
    pause: request(platform, ['mode'], (r, f) => ({ mode: r.oneOf(f, '', 'mode', PAUSE_MODES) })),
    resume: request(platform, ['ack'], (r, f) => ({ ack: r.ack(f, 'ack') })),
    cancelRun: request(platform, [], () => ({})),
    setWorkers: request(platform, ['workers', 'gpuSessions'], (r, f) => ({
      workers: readCount(r, f, 'workers', WORKER_LIMITS.workers),
      gpuSessions: r.nullable(f, 'gpuSessions', () => readCount(r, f, 'gpuSessions', WORKER_LIMITS.gpuSessions))
    })),
    setSettings: request(platform, ['settings'], (r, f) => ({ settings: readSettings(r, f) })),
    dismissAlert: request(platform, ['alertId'], (r, f) => ({ alertId: r.token(f, '', 'alertId') })),
    revealAlert: request(platform, ['alertId'], (r, f) => ({ alertId: r.token(f, '', 'alertId') })),
    cancel: request(platform, ['ids'], ids),
    skip: request(platform, ['ids'], ids),
    unqueue: request(platform, ['ids'], ids),
    retry: request(platform, ['ids', 'recipe', 'ack', 'start'], (r, f) => ({
      ids: r.jobIdsOr(f, '', 'ids', ['failed'] as const),
      recipe: recipeOrNull(r, f),
      ack: r.ack(f, 'ack'),
      start: r.bool(f, '', 'start')
    })),
    keepOutput: request(platform, ['ids', 'placement', 'confirm'], (r, f) => ({
      ids: r.jobIds(f, '', 'ids'),
      placement: r.oneOf(f, '', 'placement', ['planned', 'renamed'] as const),
      confirm: r.nullable(f, 'confirm', () =>
      {
        const confirm = r.object(f.confirm, 'confirm', ['displaces'], 'null or a confirmation')
        return confirm ? { displaces: r.whole(confirm, 'confirm', 'displaces', COUNT) } : null
      })
    })),
    discardOutput: request(platform, ['ids'], ids),
    acknowledge: request(platform, ['ids'], ids),
    clear: request(platform, ['scope'], (r, f) => ({ scope: readClearScope(r, f) })),
    log: request(platform, ['jobId', 'attempt'], (r, f) => ({
      jobId: r.jobId(f, '', 'jobId'),
      attempt: r.nullable(f, 'attempt', () => r.whole(f, '', 'attempt', ATTEMPT))
    })),
    reveal: request(platform, ['jobId', 'target'], (r, f) => ({ jobId: r.jobId(f, '', 'jobId'), target: r.oneOf(f, '', 'target', REVEAL_TARGETS) })),
    exportReport: request(platform, ['scope', 'format'], (r, f) => ({
      scope: readReportScope(r, f),
      format: r.oneOf(f, '', 'format', ['csv', 'json'] as const)
    })),
    listRuns: request(platform, ['before', 'limit'], (r, f) => ({
      before: r.nullable(f, 'before', () => r.runId(f, '', 'before')),
      limit: r.whole(f, '', 'limit', PAGE)
    })),
    getRun: request(platform, ['runId', 'offset', 'limit'], (r, f) => ({
      runId: r.runId(f, '', 'runId'),
      offset: r.whole(f, '', 'offset', { min: 0, max: null }),
      limit: r.whole(f, '', 'limit', PAGE)
    })),
    searchRuns: request(platform, ['query', 'limit', 'before'], (r, f) => ({
      query: readQuery(r, f),
      limit: r.whole(f, '', 'limit', PAGE),
      before: r.nullable(f, 'before', () =>
      {
        const before = r.object(f.before, 'before', ['runId', 'jobId'], 'null or a search position')
        return before ? { runId: r.runId(before, 'before', 'runId'), jobId: r.jobId(before, 'before', 'jobId') } : null
      })
    })),
    rerun: request(platform, ['runId', 'jobIds', 'force'], (r, f) => ({
      runId: r.runId(f, '', 'runId'),
      jobIds: r.jobIdsOr(f, '', 'jobIds', ['all', 'returned'] as const),
      force: r.bool(f, '', 'force')
    })),
    deleteRuns: request(platform, ['runIds'], (r, f) => ({
      runIds: f.runIds === 'all' ? 'all' : [...new Set(r.list(f, '', 'runIds', 'run ids', (item, index) => r.runId(item, '', index)))]
    })),
    revealRecord: request(platform, ['runId', 'jobId', 'attempt', 'target'], (r, f) => ({
      runId: r.runId(f, '', 'runId'),
      jobId: r.jobId(f, '', 'jobId'),
      attempt: r.whole(f, '', 'attempt', ATTEMPT),
      target: r.oneOf(f, '', 'target', REVEAL_TARGETS)
    })),
    savePreset: request(platform, ['id', 'name', 'recipe', 'pin'], (r, f) => ({
      id: r.nullable(f, 'id', () => r.token(f, '', 'id')),
      name: r.name(f, '', 'name'),
      recipe: r.recipeField(f, '', 'recipe'),
      pin: r.nullable(f, 'pin', () => r.whole(f, '', 'pin', PIN_KEYS))
    })),
    renamePreset: request(platform, ['id', 'name'], (r, f) => ({ id: r.token(f, '', 'id'), name: r.name(f, '', 'name') })),
    removePreset: request(platform, ['id'], (r, f) => ({ id: r.token(f, '', 'id') })),
    setPin: request(platform, ['key', 'presetId'], (r, f) => ({
      key: r.whole(f, '', 'key', PIN_KEYS),
      presetId: r.nullable(f, 'presetId', () => r.token(f, '', 'presetId'))
    }))
  }
}

/**
 * The request validators that accept an absolute path of any platform, for checks that hold on every platform such as
 * the contract's parity tests. The command gate must not use them: a root-relative path such as /Exports passes here
 * and resolves against the current drive on Windows, so main builds the gate's validators once with
 * createRequestValidators and its own platform.
 */
export const REQUEST_VALIDATORS: RequestValidators = createRequestValidators(null)
