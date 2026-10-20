/**
 * The built-in Convert, Compress, and Extract presets as whole recipes with ids, labels, and groups; the preset each
 * operation starts from; the keys pinned on a new install; and one lookup across these catalogs, the loudness and gain
 * presets, and the user's presets. Descriptions come from describeRecipe, so preset copy can never disagree with
 * what runs, and no label names a platform or a brand.
 */
import { DEFAULT_LOUDNESS_PRESET, GAIN_PRESETS, LOUDNESS_PRESETS, applyGainPreset, applyLoudnessPreset, type GainPresetId, type PresetId } from '../audio/presets'
import type { EncoderPolicy, OutputCodec } from '../audio/types'
import { describeRecipe, type PresetLookup } from './describe'
import type { AudioOut, ChannelRule, CompressRecipe, ConvertRecipe, ExtractRecipe, FrameFit, Operation, PixelFormat, Recipe, VideoEncoder } from './recipes'
import type { PresetState, UserPreset } from './types'

/** A built-in preset: a whole recipe with its id, label, group, and the description its values give. */
export interface BuiltinPreset<R extends Recipe = Recipe>
{
  id: string
  label: string
  group: string
  description: string
  recipe: R
}

function preset<R extends Recipe>(id: string, label: string, group: string, recipe: R): BuiltinPreset<R>
{
  return { id, label, group, description: describeRecipe(recipe), recipe }
}

const NO_PRESET = { userPreset: null }

function codec(name: OutputCodec, kbpsPerPair: number | null = null): AudioOut
{
  return { kind: 'codec', codec: name, kbpsPerPair }
}

function fit(maxWidth: number | null, maxHeight: number | null, mode: FrameFit['mode'] = 'fit'): FrameFit
{
  return { maxWidth, maxHeight, mode }
}

/** The per-pair bitrate whose 5.1 stream total is the given rate, for AC-3 and E-AC-3. */
function surroundTotal(kbps: number): number
{
  return kbps / 3
}

interface VideoValues
{
  encoder: VideoEncoder | 'copy'
  kbps?: number | null
  fit?: FrameFit | null
  fps?: number | null
  pixelFormat?: PixelFormat
}

function convert(id: string, label: string, group: string, container: string, video: VideoValues | null, audio: AudioOut,
  channels: ChannelRule = 'keep'): BuiltinPreset<ConvertRecipe>
{
  return preset(id, label, group, {
    kind: 'convert',
    presetId: id,
    ...NO_PRESET,
    container,
    video: video === null
      ? null
      : { encoder: video.encoder, bitrateKbps: video.kbps ?? null, fit: video.fit ?? null, fps: video.fps ?? null, pixelFormat: video.pixelFormat ?? 'yuv420p' },
    audio,
    channels,
    subtitles: 'keep'
  })
}

function aac(kbps: number): AudioOut
{
  return codec('aac', kbps)
}

/** The Convert presets, in the order the picker groups them. */
export const CONVERT_PRESETS: readonly BuiltinPreset<ConvertRecipe>[] =
[
  convert('mp4-h264', 'MP4 (H.264/AAC)', 'General', 'mp4', { encoder: 'libx264', kbps: 5000 }, aac(256)),
  convert('mkv-hevc', 'MKV (HEVC/AAC)', 'General', 'mkv', { encoder: 'libx265', kbps: 5000 }, aac(256)),
  convert('webm-vp9', 'WebM (VP9/Opus)', 'General', 'webm', { encoder: 'libvpx-vp9', kbps: 2500 }, codec('opus', 192)),
  convert('mp3-320', 'MP3 320k', 'General', 'mp3', null, codec('mp3', 320)),
  convert('mp4-720p-1500k', 'MP4 720p 30 fps, about 1.6 Mb/s', 'Web', 'mp4', { encoder: 'libx264', kbps: 1500, fit: fit(1280, 720), fps: 30 }, aac(128)),
  convert('mp4-10000k', 'MP4, about 10.3 Mb/s', 'Web', 'mp4', { encoder: 'libx264', kbps: 10000 }, aac(256)),
  convert('mp4-vertical-4000k', 'MP4 1080x1920 30 fps, about 4.2 Mb/s', 'Web', 'mp4',
    { encoder: 'libx264', kbps: 4000, fit: fit(1080, 1920, 'pad'), fps: 30 }, aac(192)),
  convert('mp4-vertical-3500k', 'MP4 1080x1920 30 fps, about 3.6 Mb/s', 'Web', 'mp4',
    { encoder: 'libx264', kbps: 3500, fit: fit(1080, 1920, 'pad'), fps: 30 }, aac(128)),
  convert('mp4-720p-2500k', 'MP4 720p 30 fps, about 2.6 Mb/s', 'Web', 'mp4', { encoder: 'libx264', kbps: 2500, fit: fit(1280, 720), fps: 30 }, aac(128)),
  convert('720p-web', '720p Web', 'Web', 'mp4', { encoder: 'libx264', kbps: 2500, fit: fit(1280, 720), fps: 30 }, aac(192)),
  convert('mp4-480p-500k', 'MP4 480p 24 fps, about 0.6 Mb/s', 'Web', 'mp4', { encoder: 'libx264', kbps: 500, fit: fit(854, 480), fps: 24 }, aac(96)),
  convert('mp4-hevc-1080p', 'MP4 HEVC 1080p, about 4.2 Mb/s', 'Web', 'mp4', { encoder: 'libx265', kbps: 4000, fit: fit(1920, 1080) }, aac(192)),
  convert('mov-h264', 'MOV (H.264/AAC)', 'Devices', 'mov', { encoder: 'libx264', kbps: 8000 }, aac(256)),
  convert('mp4-4000k', 'MP4, about 4.2 Mb/s', 'Devices', 'mp4', { encoder: 'libx264', kbps: 4000 }, aac(192)),
  convert('mp4-1080p-5000k', 'MP4 1080p, about 5.3 Mb/s', 'Devices', 'mp4', { encoder: 'libx264', kbps: 5000, fit: fit(1920, 1080) }, aac(256)),
  convert('mp4-av1', 'MP4 (AV1/Opus)', 'Production', 'mp4', { encoder: 'libaom-av1', kbps: 2500 }, codec('opus', 192)),
  convert('mov-prores', 'ProRes (Editing)', 'Production', 'mov', { encoder: 'prores_ks', pixelFormat: 'source' }, codec('pcm')),
  convert('mkv-ffv1', 'FFV1 Lossless', 'Production', 'mkv', { encoder: 'ffv1', pixelFormat: 'source' }, codec('flac')),
  convert('4k-archive', '4K Archive (HEVC/FLAC)', 'Production', 'mkv', { encoder: 'libx265', kbps: 25000, fit: fit(3840, 2160), pixelFormat: 'source' }, codec('flac')),
  convert('ts-mpeg2', 'MPEG-2 Broadcast (TS)', 'Production', 'ts', { encoder: 'mpeg2video', kbps: 8000 }, codec('ac3', 192)),
  convert('wav-pcm', 'WAV (PCM)', 'Audio only', 'wav', null, codec('pcm')),
  convert('flac', 'FLAC Lossless', 'Audio only', 'flac', null, codec('flac')),
  convert('alac', 'ALAC Lossless (M4A)', 'Audio only', 'm4a', null, codec('alac')),
  convert('aac-m4a', 'M4A AAC 256k', 'Audio only', 'm4a', null, aac(256)),
  convert('opus-128', 'Opus 128k (Ogg)', 'Audio only', 'ogg', null, codec('opus', 128)),
  convert('podcast-mp3', 'Podcast MP3 96k mono', 'Audio only', 'mp3', null, codec('mp3', 192), 'mono'),
  convert('audiobook', 'Audiobook M4A 96k mono', 'Audio only', 'm4a', null, aac(192), 'mono'),
  convert('ac3-surr', 'AC-3 Surround 448k at 5.1', 'Audio only', 'ac3', null, codec('ac3', surroundTotal(448)))
]

interface CompressValues
{
  target: CompressRecipe['target']
  encoder: VideoEncoder
  speed?: CompressRecipe['speed']
  pixelFormat?: PixelFormat
  tune?: CompressRecipe['tune']
  maxHeight?: number
  audio: AudioOut
}

function compress(id: string, label: string, group: string, values: CompressValues): BuiltinPreset<CompressRecipe>
{
  return preset(id, label, group, {
    kind: 'compress',
    presetId: id,
    ...NO_PRESET,
    target: values.target,
    encoder: values.encoder,
    speed: values.speed ?? 'medium',
    pixelFormat: values.pixelFormat ?? 'yuv420p',
    tune: values.tune ?? null,
    fit: values.maxHeight === undefined ? null : fit(null, values.maxHeight),
    audio: values.audio,
    container: 'source'
  })
}

function crf(value: number): CompressRecipe['target']
{
  return { mode: 'crf', crf: value }
}

/** A two-pass size target in the page's megabytes (1 MB is 1,000,000 bytes). */
function size(megabytes: number): CompressRecipe['target']
{
  return { mode: 'size', targetBytes: megabytes * 1_000_000, twoPass: true }
}

/** The Compress presets, in the order the picker groups them; each CRF is the one that runs. */
export const COMPRESS_PRESETS: readonly BuiltinPreset<CompressRecipe>[] =
[
  compress('archival', 'Archival (x265 10-bit)', 'Archive',
    { target: crf(22), encoder: 'libx265', speed: 'slow', pixelFormat: 'yuv420p10le', tune: 'grain', audio: aac(320) }),
  compress('master', 'HQ Master (x265)', 'Archive', { target: crf(22), encoder: 'libx265', speed: 'slow', audio: aac(256) }),
  compress('web-1080p', 'Web 1080p', 'Web', { target: crf(23), encoder: 'libx264', maxHeight: 1080, audio: aac(192) }),
  compress('web-720p', 'Web 720p Compact', 'Web', { target: crf(28), encoder: 'libx264', speed: 'fast', maxHeight: 720, audio: aac(128) }),
  compress('target-25mb', 'Target 25 MB', 'Web', { target: size(25), encoder: 'libx264', maxHeight: 720, audio: aac(96) }),
  compress('target-500mb', 'Target 500 MB', 'Web', { target: size(500), encoder: 'libx264', maxHeight: 1080, audio: aac(192) }),
  compress('x264-master', 'Upload Master (x264 CRF 18)', 'Web', { target: crf(18), encoder: 'libx264', speed: 'slow', tune: 'film', audio: aac(384) }),
  compress('mobile', 'Mobile Friendly (fast decode)', 'Mobile', { target: crf(23), encoder: 'libx264', tune: 'fastdecode', maxHeight: 1080, audio: aac(128) }),
  compress('animation', 'Animation (x265)', 'Special', { target: crf(28), encoder: 'libx265', tune: 'animation', audio: aac(192) }),
  compress('film-grain', 'Film Grain Preserve (x265 10-bit)', 'Special',
    { target: crf(22), encoder: 'libx265', speed: 'slow', pixelFormat: 'yuv420p10le', tune: 'grain', audio: aac(256) }),
  compress('av1-streaming', 'AV1 Streaming', 'Modern', { target: crf(28), encoder: 'libaom-av1', maxHeight: 1080, audio: codec('opus', 96) })
]

type ExtractFields = ExtractRecipe extends infer R ? (R extends ExtractRecipe ? Omit<R, 'kind' | 'presetId' | 'userPreset'> : never) : never

function extract(id: string, label: string, group: string, fields: ExtractFields): BuiltinPreset<ExtractRecipe>
{
  return preset<ExtractRecipe>(id, label, group, { kind: 'extract', presetId: id, ...NO_PRESET, ...fields })
}

const DEFAULT_STREAM = { by: 'default' } as const

function extractAudio(id: string, label: string, container: string, audio: AudioOut, sampleRate: number | null = null,
  channels: ChannelRule = 'keep'): BuiltinPreset<ExtractRecipe>
{
  return extract(id, label, 'Audio', { mode: 'audio', stream: DEFAULT_STREAM, audio, container, sampleRate, channels, range: null })
}

function gif(id: string, label: string, fps: number, width: number, dither: 'sierra2_4a' | 'bayer'): BuiltinPreset<ExtractRecipe>
{
  return extract(id, label, 'GIF', { mode: 'gif', fps, width, dither, plays: 'infinite', range: null })
}

/** The Extract presets, in the order the picker groups them. */
export const EXTRACT_PRESETS: readonly BuiltinPreset<ExtractRecipe>[] =
[
  extractAudio('audio-mp3-320', 'MP3 320k', 'mp3', codec('mp3', 320)),
  extractAudio('audio-aac-256', 'AAC 256k (M4A)', 'm4a', aac(256)),
  extractAudio('audio-opus-128', 'Opus 128k', 'opus', codec('opus', 128)),
  extractAudio('audio-flac', 'FLAC Lossless', 'flac', codec('flac')),
  extractAudio('audio-wav', 'WAV (PCM)', 'wav', codec('pcm')),
  extractAudio('audio-podcast', 'Podcast MP3 96k mono, 44.1 kHz', 'mp3', codec('mp3', 192), 44100, 'mono'),
  extract('video-silent-copy', 'Silent Video (copy)', 'Video', { mode: 'video', container: 'mp4', reencode: null, range: null }),
  extract('video-silent-h264', 'Silent Video (x264 CRF 20)', 'Video', { mode: 'video', container: 'mp4', reencode: { encoder: 'libx264', crf: 20 }, range: null }),
  gif('gif-720', 'GIF 720 px wide', 15, 720, 'sierra2_4a'),
  gif('gif-480', 'GIF 480 px wide', 12, 480, 'sierra2_4a'),
  gif('gif-360', 'GIF 360 px wide', 10, 360, 'bayer'),
  extract('frames-thumb', 'Single Thumbnail', 'Frames', { mode: 'frames', sampling: { by: 'thumbnail' }, format: 'png', jpgQuality: null, range: null }),
  extract('frames-every-sec', 'Every 1 Second', 'Frames', { mode: 'frames', sampling: { by: 'interval', seconds: 1 }, format: 'png', jpgQuality: null, range: null }),
  extract('frames-every-5sec', 'Every 5 Seconds', 'Frames', { mode: 'frames', sampling: { by: 'interval', seconds: 5 }, format: 'jpg', jpgQuality: 3, range: null }),
  extract('frames-50-even', '50 Evenly Spaced Frames', 'Frames', { mode: 'frames', sampling: { by: 'count', count: 50 }, format: 'jpg', jpgQuality: 4, range: null }),
  extract('subs-srt', 'Subtitles to SRT', 'Subtitles', { mode: 'subtitles', stream: DEFAULT_STREAM, format: 'srt' }),
  extract('subs-vtt', 'Subtitles to WebVTT', 'Subtitles', { mode: 'subtitles', stream: DEFAULT_STREAM, format: 'vtt' }),
  extract('subs-ass', 'Subtitles to ASS', 'Subtitles', { mode: 'subtitles', stream: DEFAULT_STREAM, format: 'ass' })
]

/** The catalog of each media operation. */
export const MEDIA_CATALOGS =
{
  convert: CONVERT_PRESETS,
  compress: COMPRESS_PRESETS,
  extract: EXTRACT_PRESETS
} as const satisfies Readonly<Record<'convert' | 'compress' | 'extract', readonly BuiltinPreset[]>>

/** The groups of each operation's presets, in the order the picker and the preset select show them. */
export const PRESET_GROUPS: Readonly<Record<Operation, readonly string[]>> =
{
  normalize: ['Standards', 'Not a standard', 'Custom'],
  boost: ['App presets', 'Custom'],
  convert: ['General', 'Web', 'Devices', 'Production', 'Audio only'],
  compress: ['Archive', 'Web', 'Mobile', 'Special', 'Modern'],
  extract: ['Audio', 'Video', 'GIF', 'Frames', 'Subtitles']
}

/** The group of a user preset in every list. */
export const USER_PRESET_GROUP = 'Your presets'

/** The preset each operation starts from when the Operation select chooses it. */
export const DEFAULT_PRESETS =
{
  normalize: DEFAULT_LOUDNESS_PRESET,
  boost: 'gentle-lift' as GainPresetId,
  convert: 'mp4-h264',
  compress: 'web-1080p',
  extract: 'audio-mp3-320'
} as const

/**
 * The whole recipe an operation starts from (the Operation select and the Dashboard tiles): its default preset
 * applied with the output policy. There are no global loudness settings; values to reuse live in user presets.
 */
export function applyDefaultPreset(op: Operation, output: EncoderPolicy): Recipe
{
  return applyPreset(DEFAULT_PRESETS[op], output) as Recipe
}

/** The keys pinned on a new install. */
export const DEFAULT_PINS: PresetState['pins'] =
{
  '1': 'ebu-r128',
  '2': 'apple-podcasts',
  '3': 'spotify',
  '4': 'gentle-lift',
  '5': 'mp4-h264',
  '6': 'web-1080p',
  '7': 'audio-mp3-320',
  '8': 'flac',
  '9': 'subs-srt'
}

/** A preset any list can show: built-in or the user's. */
export interface PresetInfo
{
  id: string
  op: Operation
  label: string
  group: string
  user: boolean
}

/** Every built-in preset of every operation, the loudness and gain presets included; Custom is not a preset to look up. */
export const BUILTIN_PRESETS: readonly PresetInfo[] =
[
  ...LOUDNESS_PRESETS.filter((entry) => entry.id !== 'custom')
    .map((entry): PresetInfo => ({ id: entry.id, op: 'normalize', label: entry.label, group: entry.standard ? 'Standards' : 'Not a standard', user: false })),
  ...GAIN_PRESETS.map((entry): PresetInfo => ({ id: entry.id, op: 'boost', label: entry.label, group: 'App presets', user: false })),
  ...(['convert', 'compress', 'extract'] as const).flatMap((op) =>
    MEDIA_CATALOGS[op].map((entry): PresetInfo => ({ id: entry.id, op, label: entry.label, group: entry.group, user: false })))
]

/** A preset by id among the built-in presets and the user's, or null; Custom is not a preset to look up. */
export function findPreset(id: string, users: readonly UserPreset[] = []): PresetInfo | null
{
  const builtin = BUILTIN_PRESETS.find((entry) => entry.id === id)
  if (builtin)
  {
    return builtin
  }
  const user = users.find((entry) => entry.id === id)
  return user ? { id: user.id, op: user.recipe.kind, label: user.name, group: USER_PRESET_GROUP, user: true } : null
}

/**
 * The whole recipe a preset applies: Normalize and Gain presets take the output policy, media presets are copied,
 * and a user preset's recipe names the preset it came from. Null for an id that names no preset.
 */
export function applyPreset(id: string, output: EncoderPolicy, users: readonly UserPreset[] = []): Recipe | null
{
  const info = findPreset(id, users)
  if (info === null)
  {
    return null
  }
  if (info.user)
  {
    const user = users.find((entry) => entry.id === id) as UserPreset
    return { ...structuredClone(user.recipe), userPreset: { id: user.id, name: user.name } }
  }
  if (info.op === 'normalize')
  {
    return applyLoudnessPreset(id as PresetId, output)
  }
  if (info.op === 'boost')
  {
    return applyGainPreset(id as Exclude<GainPresetId, 'custom'>, output)
  }
  const media = (MEDIA_CATALOGS[info.op] as readonly BuiltinPreset[]).find((entry) => entry.id === id) as BuiltinPreset
  return structuredClone(media.recipe)
}

/**
 * The lookup the Recipe cell and the edited marker use: a recipe's user preset when it names one, else its built-in
 * preset of the same operation as applied with the recipe's own output policy. Null for Custom and for presets that
 * are gone.
 */
export function presetLookup(users: readonly UserPreset[] = []): PresetLookup
{
  return (recipe) =>
  {
    if (recipe.userPreset !== null)
    {
      const user = users.find((entry) => entry.id === recipe.userPreset?.id)
      return user ? { label: user.name, recipe: user.recipe } : null
    }
    if (recipe.presetId === null || recipe.presetId === 'custom')
    {
      return null
    }
    const info = BUILTIN_PRESETS.find((entry) => entry.id === recipe.presetId && entry.op === recipe.kind)
    if (!info)
    {
      return null
    }
    const output = recipe.kind === 'normalize' || recipe.kind === 'boost' ? recipe.output : { kind: 'same-as-source' as const }
    return { label: info.label, recipe: applyPreset(info.id, output) as Recipe }
  }
}

/** Earlier preset ids and the preset each one became, per operation; a media preset can move to another operation. */
export const LEGACY_PRESET_IDS: Readonly<Record<Operation, Readonly<Record<string, { op: Operation; id: string }>>>> =
{
  normalize:
  {
    'movie-balance': { op: 'normalize', id: 'film-r128s4' },
    'movie-dialog': { op: 'normalize', id: 'film-r128s4' },
    'movie-latenight': { op: 'normalize', id: 'night' },
    'podcast': { op: 'normalize', id: 'apple-podcasts' },
    'music-streaming': { op: 'normalize', id: 'spotify' },
    'music-album': { op: 'normalize', id: 'streaming-r128s2' },
    'broadcast': { op: 'normalize', id: 'ebu-r128' }
  },
  boost:
  {
    'quiet-rescue': { op: 'boost', id: 'quiet-recording' },
    'maximize': { op: 'boost', id: 'louder' }
  },
  convert:
  {
    'discord': { op: 'convert', id: 'mp4-720p-1500k' },
    'youtube': { op: 'convert', id: 'mp4-10000k' },
    'tiktok': { op: 'convert', id: 'mp4-vertical-4000k' },
    'instagram': { op: 'convert', id: 'mp4-vertical-3500k' },
    'twitter': { op: 'convert', id: 'mp4-720p-2500k' },
    'email-10mb': { op: 'convert', id: 'mp4-480p-500k' },
    'telegram': { op: 'convert', id: 'mp4-hevc-1080p' },
    'apple': { op: 'convert', id: 'mov-h264' },
    'android': { op: 'convert', id: 'mp4-4000k' },
    'chromecast': { op: 'convert', id: 'mp4-1080p-5000k' },
    'wav-24bit': { op: 'convert', id: 'wav-pcm' }
  },
  compress:
  {
    'discord-25mb': { op: 'compress', id: 'target-25mb' },
    'discord-nitro': { op: 'compress', id: 'target-500mb' },
    'youtube-master': { op: 'compress', id: 'x264-master' },
    'audio-flac': { op: 'convert', id: 'flac' },
    'audio-aac': { op: 'convert', id: 'aac-m4a' }
  },
  extract:
  {
    'gif-hq': { op: 'extract', id: 'gif-720' },
    'gif-web': { op: 'extract', id: 'gif-480' },
    'gif-social': { op: 'extract', id: 'gif-360' },
    'frames-scene-50': { op: 'extract', id: 'frames-50-even' }
  }
}

/**
 * The current preset for an id an earlier version stored under an operation: the id itself when that operation still
 * has it, its successor when it was renamed or moved, or null when nothing replaces it (Normalize's "defaults" means
 * the operation's default preset). Stored ids are data, so only the tables' own keys count, never inherited names.
 */
export function migratePresetId(op: Operation, id: string): { op: Operation; id: string } | null
{
  const current = BUILTIN_PRESETS.find((entry) => entry.id === id && entry.op === op)
  if (current)
  {
    return { op, id }
  }
  const legacy = Object.hasOwn(LEGACY_PRESET_IDS, op) ? LEGACY_PRESET_IDS[op] : null
  return legacy !== null && Object.hasOwn(legacy, id) ? legacy[id] : null
}
