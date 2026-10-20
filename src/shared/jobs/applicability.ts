/**
 * The stream rules that block or annotate giving a recipe to a source, judged from what the probe found: a real video
 * stream (cover art never counts), the audio streams and their channels, and the subtitle streams. The planner
 * reports them as plan issues, and the recipe picker, the pinned-key toast, and the inspector's consequence notes
 * count them, so a note and a plan can never disagree.
 */
import { renderMessage } from '../audio/messages'
import type { MediaFacts, OutputCodec } from '../audio/types'
import { recipeOperationName } from './describe'
import type { ChannelRule, Recipe, StreamPick } from './recipes'
import type { MediaSummary, PlanFix, PlanIssue } from './types'

/** What the stream rules read of a probed source; a row's summary and the full probe both provide it. */
export interface StreamFacts
{
  /** A real video stream: cover art never counts. */
  video: boolean
  audio: ReadonlyArray<{ channels: number; language: string | null; isDefault: boolean }>
  /** Every subtitle stream, or null when only their count is known, as in a row's summary. */
  subtitles: ReadonlyArray<{ codec: string; bitmap: boolean; language: string | null }> | null
  subtitleCount: number
}

/** A row's summary whose audio streams may carry their default disposition; the stream rules count it when present. */
type SummaryStreams = Omit<MediaSummary, 'audio'> &
{
  audio: ReadonlyArray<MediaSummary['audio'][number] & { isDefault?: boolean }>
}

/** The stream facts of a row's summary; its video is the real video stream, never cover art. */
export function factsFromSummary(media: SummaryStreams): StreamFacts
{
  return {
    video: media.video !== null,
    audio: media.audio.map((stream) => ({ channels: stream.channels, language: stream.language, isDefault: stream.isDefault === true })),
    subtitles: null,
    subtitleCount: media.subtitles
  }
}

/** The stream facts of a full probe. */
export function factsFromProbe(facts: MediaFacts): StreamFacts
{
  return {
    video: facts.video.some((stream) => !stream.cover),
    audio: facts.audio.map((stream) => ({ channels: stream.channels, language: stream.language, isDefault: stream.disposition.default === 1 })),
    subtitles: facts.subtitles.map((stream) => ({ codec: stream.codecName, bitmap: stream.bitmap, language: stream.language })),
    subtitleCount: facts.subtitles.length
  }
}

/** The most channels each output codec holds; null for no limit. */
export const CODEC_MAX_CHANNELS: Readonly<Record<OutputCodec, number | null>> =
{
  aac: 8,
  mp3: 2,
  opus: 8,
  vorbis: 8,
  flac: 8,
  alac: 6,
  ac3: 6,
  eac3: 6,
  pcm: null,
  wmav2: 2
}

/** Containers that hold one audio stream: the default stream is kept (else the first) and the rest are dropped. */
export const SINGLE_AUDIO_CONTAINERS: readonly string[] = ['mp3', 'flac', 'wav', 'aiff', 'aif', 'ac3', 'eac3']

/** One rule a recipe meets on a source, with the values its sentence and the picker's counts need. */
export type Applicability =
  | { code: 'no-video-stream'; severity: 'error'; operation: string }
  | { code: 'no-audio-stream'; severity: 'error'; operation: string }
  | { code: 'audio-only-output'; severity: 'info' }
  | { code: 'stream-not-found'; severity: 'error'; kind: 'audio' | 'subtitle'; streams: number; pick: StreamPick }
  | { code: 'subtitle-bitmap'; severity: 'error'; stream: number; codec: string; format: string; firstText: number | null }
  | { code: 'too-many-channels'; severity: 'error'; codec: OutputCodec; maxChannels: number; channels: number; audioIndex: number }

function needsVideo(recipe: Recipe): boolean
{
  return recipe.kind === 'compress' || (recipe.kind === 'extract' && (recipe.mode === 'video' || recipe.mode === 'gif' || recipe.mode === 'frames'))
}

/** A Convert whose output is audio only (no video encode, or no real video in the source) writes nothing without audio. */
function needsAudio(recipe: Recipe, media: StreamFacts): boolean
{
  if (recipe.kind === 'convert')
  {
    return recipe.video === null || !media.video
  }
  return recipe.kind === 'normalize' || recipe.kind === 'boost' || (recipe.kind === 'extract' && recipe.mode === 'audio')
}

function sameLanguage(stream: string | null, wanted: string): boolean
{
  if (stream === null)
  {
    return false
  }
  const a = stream.toLowerCase()
  const b = wanted.toLowerCase()
  return a === b || a.split('-')[0] === b || b.split('-')[0] === a
}

/**
 * The stream a pick resolves to, as its index among the streams of its kind: an ordinal counts from 1, a language
 * takes the first stream in it, and the default takes the stream marked default, else the first. Null when none
 * matches.
 */
export function resolvePick(streams: ReadonlyArray<{ language: string | null; isDefault?: boolean }>, pick: StreamPick): number | null
{
  if (pick.by === 'ordinal')
  {
    return pick.ordinal <= streams.length ? pick.ordinal - 1 : null
  }
  if (pick.by === 'language')
  {
    const index = streams.findIndex((stream) => sameLanguage(stream.language, pick.language))
    return index < 0 ? null : index
  }
  if (streams.length === 0)
  {
    return null
  }
  return Math.max(0, streams.findIndex((stream) => stream.isDefault === true))
}

function ruleChannels(rule: ChannelRule, channels: number): number
{
  if (rule === 'mono')
  {
    return 1
  }
  return rule === 'stereo' ? Math.min(channels, 2) : channels
}

/** The channels an audio stream has after the recipe's downmix or channel rule. */
export function outputChannels(recipe: Recipe, channels: number): number
{
  if (recipe.kind === 'normalize')
  {
    if (recipe.downmix !== null)
    {
      return Math.min(channels, 2)
    }
    return recipe.monoToStereo && channels === 1 ? 2 : channels
  }
  if (recipe.kind === 'convert' || (recipe.kind === 'extract' && recipe.mode === 'audio'))
  {
    return ruleChannels(recipe.channels, channels)
  }
  return channels
}

function outputCodec(recipe: Recipe): OutputCodec | null
{
  const out = recipe.kind === 'normalize' || recipe.kind === 'boost'
    ? recipe.output
    : recipe.kind === 'extract' ? (recipe.mode === 'audio' ? recipe.audio : null) : recipe.audio
  return out !== null && out.kind === 'codec' ? out.codec : null
}

/** The audio streams a recipe encodes, as indexes among the source's audio streams. */
function encodedStreams(recipe: Recipe, media: StreamFacts): number[]
{
  if (recipe.kind === 'extract')
  {
    const picked = recipe.mode === 'audio' ? resolvePick(media.audio, recipe.stream) : null
    return picked === null ? [] : [picked]
  }
  if (recipe.kind === 'convert' && SINGLE_AUDIO_CONTAINERS.includes(recipe.container))
  {
    const kept = resolvePick(media.audio, { by: 'default' })
    return kept === null ? [] : [kept]
  }
  return media.audio.map((_, index) => index)
}

function channelRules(recipe: Recipe, media: StreamFacts): Applicability[]
{
  const codec = outputCodec(recipe)
  const max = codec === null ? null : CODEC_MAX_CHANNELS[codec]
  if (codec === null || max === null)
  {
    return []
  }
  return encodedStreams(recipe, media).flatMap((audioIndex): Applicability[] =>
  {
    const channels = outputChannels(recipe, media.audio[audioIndex].channels)
    return channels > max ? [{ code: 'too-many-channels', severity: 'error', codec, maxChannels: max, channels, audioIndex }] : []
  })
}

function subtitleRules(recipe: Extract<Recipe, { kind: 'extract'; mode: 'subtitles' }>, media: StreamFacts): Applicability[]
{
  const pick = recipe.stream
  const notFound: Applicability = { code: 'stream-not-found', severity: 'error', kind: 'subtitle', streams: media.subtitleCount, pick }
  if (media.subtitles === null)
  {
    const missing = media.subtitleCount === 0 || (pick.by === 'ordinal' && pick.ordinal > media.subtitleCount)
    return missing ? [notFound] : []
  }
  const index = resolvePick(media.subtitles, pick)
  if (index === null)
  {
    return [notFound]
  }
  const stream = media.subtitles[index]
  if (!stream.bitmap)
  {
    return []
  }
  const firstText = media.subtitles.findIndex((candidate) => !candidate.bitmap)
  return [{
    code: 'subtitle-bitmap',
    severity: 'error',
    stream: index + 1,
    codec: stream.codec,
    format: recipe.format,
    firstText: firstText < 0 ? null : firstText + 1
  }]
}

/** Every stream rule a recipe meets on a source, blocking ones first. */
export function applicability(recipe: Recipe, media: StreamFacts): Applicability[]
{
  const operation = recipeOperationName(recipe)
  if (needsVideo(recipe) && !media.video)
  {
    return [{ code: 'no-video-stream', severity: 'error', operation }]
  }
  if (needsAudio(recipe, media) && media.audio.length === 0)
  {
    return [{ code: 'no-audio-stream', severity: 'error', operation }]
  }
  const rules: Applicability[] = []
  if (recipe.kind === 'extract' && recipe.mode === 'audio' && resolvePick(media.audio, recipe.stream) === null)
  {
    rules.push({ code: 'stream-not-found', severity: 'error', kind: 'audio', streams: media.audio.length, pick: recipe.stream })
  }
  if (recipe.kind === 'extract' && recipe.mode === 'subtitles')
  {
    rules.push(...subtitleRules(recipe, media))
  }
  rules.push(...channelRules(recipe, media))
  if (recipe.kind === 'convert' && recipe.video !== null && !media.video)
  {
    rules.push({ code: 'audio-only-output', severity: 'info' })
  }
  return rules
}

const SUBTITLE_FORMATS: Readonly<Record<string, string>> = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' }

function streamsWord(count: number, kind: string): string
{
  return count === 0 ? `no ${kind} streams` : `${count} ${kind} ${count === 1 ? 'stream' : 'streams'}`
}

/** The sentence a rule reads for one source, named by its file name. */
export function applicabilityMessage(rule: Applicability, name: string): string
{
  switch (rule.code)
  {
    case 'no-video-stream':
      return `${rule.operation} needs a video stream; ${name} has none. Cover art does not count.`
    case 'no-audio-stream':
      return `${rule.operation} needs an audio stream; ${name} has none.`
    case 'audio-only-output':
      return `${name} has no video; the output is audio only.`
    case 'stream-not-found':
      if (rule.pick.by === 'language')
      {
        return `${name} has no ${rule.kind} stream in ${rule.pick.language}.`
      }
      return rule.pick.by === 'ordinal'
        ? `${name} has ${streamsWord(rule.streams, rule.kind)}; the recipe asks for stream ${rule.pick.ordinal}.`
        : `${name} has ${streamsWord(rule.streams, rule.kind)}.`
    case 'subtitle-bitmap':
      return `Stream ${rule.stream} of ${name} is a bitmap subtitle (${rule.codec}); it cannot become ${SUBTITLE_FORMATS[rule.format] ?? rule.format.toUpperCase()}.`
    default:
      return renderMessage({ key: 'too-many-channels', params: { codec: rule.codec, n: rule.maxChannels, m: rule.channels } }, { minus: 'hyphen' })
  }
}

function channelFix(recipe: Recipe, rule: Extract<Applicability, { code: 'too-many-channels' }>): PlanFix | null
{
  if (recipe.kind === 'convert' || (recipe.kind === 'extract' && recipe.mode === 'audio'))
  {
    return { kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'channels', value: 'stereo' }, scope: 'jobs' }
  }
  if (recipe.kind === 'normalize')
  {
    return { kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' }
  }
  if (recipe.kind === 'compress' && recipe.audio.kind === 'codec' && rule.channels <= (CODEC_MAX_CHANNELS.aac as number))
  {
    return { kind: 'patch-recipe', label: 'Use AAC audio', patch: { field: 'audio', value: { kind: 'codec', codec: 'aac', kbpsPerPair: recipe.audio.kbpsPerPair } }, scope: 'jobs' }
  }
  return null
}

function fixFor(recipe: Recipe, rule: Applicability): PlanFix | null
{
  switch (rule.code)
  {
    case 'no-video-stream':
    case 'no-audio-stream':
      return { kind: 'remove', scope: 'jobs' }
    case 'stream-not-found':
      return rule.streams > 0
        ? { kind: 'patch-recipe', label: 'Use the default stream', patch: { field: 'stream', value: { by: 'default' } }, scope: 'jobs' }
        : { kind: 'remove', scope: 'jobs' }
    case 'subtitle-bitmap':
      return rule.firstText === null
        ? { kind: 'remove', scope: 'jobs' }
        : { kind: 'patch-recipe', label: 'Use the first text subtitle', patch: { field: 'stream', value: { by: 'ordinal', ordinal: rule.firstText } }, scope: 'jobs' }
    case 'too-many-channels':
      return channelFix(recipe, rule)
    default:
      return null
  }
}

/** The rules as plan issues for one source, with their sentences and fixes, as the planner reports them. */
export function applicabilityIssues(recipe: Recipe, media: StreamFacts, name: string): PlanIssue[]
{
  return applicability(recipe, media).map((rule) => ({
    code: rule.code,
    severity: rule.severity,
    message: applicabilityMessage(rule, name),
    field: rule.code === 'too-many-channels' ? 'encoder' : 'streams',
    fix: fixFor(recipe, rule)
  }))
}
