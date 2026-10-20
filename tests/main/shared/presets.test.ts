/**
 * The built-in Convert, Compress, and Extract catalogs: every preset is a valid whole recipe, ids are unique across
 * every operation, every number and codec a label names is the value that runs, channel words match the channel rule,
 * the nine new-install pins and each operation's default preset resolve, and the facts the earlier preset tables
 * pinned (ids, labels, channel counts, codecs, bitrates) are restated against the new catalog.
 */
import { describe, it, expect } from 'vitest'
import {
  BUILTIN_PRESETS,
  COMPRESS_PRESETS,
  CONVERT_PRESETS,
  DEFAULT_PINS,
  DEFAULT_PRESETS,
  EXTRACT_PRESETS,
  LEGACY_PRESET_IDS,
  MEDIA_CATALOGS,
  PRESET_GROUPS,
  USER_PRESET_GROUP,
  applyDefaultPreset,
  applyPreset,
  findPreset,
  migratePresetId,
  presetLookup,
  type BuiltinPreset
} from '../../../src/shared/jobs/presets'
import { validateRecipe } from '../../../src/shared/jobs/validate'
import { audioCodecLabel, describeRecipe, isEdited, recipeLabel, videoEncoderLabel } from '../../../src/shared/jobs/describe'
import { applicability, factsFromSummary } from '../../../src/shared/jobs/applicability'
import { OPERATIONS, type CompressRecipe, type ConvertRecipe, type ExtractRecipe, type Operation, type Recipe } from '../../../src/shared/jobs/recipes'
import type { UserPreset } from '../../../src/shared/jobs/types'
import { GAIN_PRESETS, LOUDNESS_PRESETS, NIGHT_DYNAMICS, applyLoudnessPreset } from '../../../src/shared/audio/presets'
import type { EncoderPolicy, NormalizeRecipe } from '../../../src/shared/audio/types'

const MEDIA: readonly BuiltinPreset[] = [...CONVERT_PRESETS, ...COMPRESS_PRESETS, ...EXTRACT_PRESETS]
const SOURCE: EncoderPolicy = { kind: 'same-as-source' }

type Claim = [RegExp, (recipe: Recipe, match: RegExpMatchArray) => boolean]

function audioOut(recipe: Recipe): { codec: string; kbpsPerPair: number | null } | null
{
  const out = recipe.kind === 'extract' ? (recipe.mode === 'audio' ? recipe.audio : null) : recipe.kind === 'convert' || recipe.kind === 'compress' ? recipe.audio : null
  return out !== null && out.kind === 'codec' ? out : null
}

function channelRule(recipe: Recipe): string
{
  return recipe.kind === 'convert' || (recipe.kind === 'extract' && recipe.mode === 'audio') ? recipe.channels : 'keep'
}

/** The stream bitrate a label states: half the pair for mono, the 5.1 total for AC-3, else the pair. */
function statedKbps(recipe: Recipe): number | null
{
  const out = audioOut(recipe)
  if (out === null || out.kbpsPerPair === null)
  {
    return null
  }
  if (channelRule(recipe) === 'mono')
  {
    return out.kbpsPerPair / 2
  }
  return out.codec === 'ac3' ? Math.round(out.kbpsPerPair * 3) : out.kbpsPerPair
}

function videoOf(recipe: Recipe): { encoder: string; kbps: number | null; fit: { maxWidth: number | null; maxHeight: number | null } | null; fps: number | null; pixelFormat: string } | null
{
  if (recipe.kind === 'convert' && recipe.video !== null)
  {
    return { encoder: recipe.video.encoder, kbps: recipe.video.bitrateKbps, fit: recipe.video.fit, fps: recipe.video.fps, pixelFormat: recipe.video.pixelFormat }
  }
  if (recipe.kind === 'compress')
  {
    return { encoder: recipe.encoder, kbps: null, fit: recipe.fit, fps: null, pixelFormat: recipe.pixelFormat }
  }
  if (recipe.kind === 'extract' && recipe.mode === 'video')
  {
    return { encoder: recipe.reencode?.encoder ?? 'copy', kbps: null, fit: null, fps: null, pixelFormat: 'source' }
  }
  return null
}

function containerOf(recipe: Recipe): string | null
{
  if (recipe.kind === 'convert' || recipe.kind === 'compress')
  {
    return recipe.container
  }
  return recipe.kind === 'extract' && (recipe.mode === 'audio' || recipe.mode === 'video') ? recipe.container : null
}

const encodes = (encoder: string) => (recipe: Recipe): boolean => videoOf(recipe)?.encoder === encoder
const audioCodec = (codec: string) => (recipe: Recipe): boolean => audioOut(recipe)?.codec === codec
const container = (name: string) => (recipe: Recipe): boolean => containerOf(recipe) === name

/** Every claim a label can make, and the value that must back it. */
const CLAIMS: Claim[] = [
  [/(\d+)k\b/, (recipe, match) => statedKbps(recipe) === Number(match[1])],
  [/about ([\d.]+) Mb\/s/, (recipe, match) =>
  {
    const total = (videoOf(recipe)?.kbps ?? 0) + (audioOut(recipe)?.kbpsPerPair ?? 0)
    return Number((total / 1000).toFixed(1)) === Number(match[1])
  }],
  [/(\d+)x(\d+)/, (recipe, match) => videoOf(recipe)?.fit?.maxWidth === Number(match[1]) && videoOf(recipe)?.fit?.maxHeight === Number(match[2])],
  [/(\d+)p\b/, (recipe, match) => videoOf(recipe)?.fit?.maxHeight === Number(match[1])],
  [/\b4K\b/, (recipe) => videoOf(recipe)?.fit?.maxHeight === 2160],
  [/(\d+) fps/, (recipe, match) => videoOf(recipe)?.fps === Number(match[1])],
  [/CRF (\d+)/, (recipe, match) =>
    (recipe.kind === 'compress' && recipe.target.mode === 'crf' && recipe.target.crf === Number(match[1])) ||
    (recipe.kind === 'extract' && recipe.mode === 'video' && recipe.reencode?.crf === Number(match[1]))],
  [/Target (\d+) MB/, (recipe, match) => recipe.kind === 'compress' && recipe.target.mode === 'size' && recipe.target.targetBytes === Number(match[1]) * 1_000_000],
  [/(\d+) px wide/, (recipe, match) => recipe.kind === 'extract' && recipe.mode === 'gif' && recipe.width === Number(match[1])],
  [/(\d+) Evenly Spaced/, (recipe, match) => recipe.kind === 'extract' && recipe.mode === 'frames' && recipe.sampling.by === 'count' && recipe.sampling.count === Number(match[1])],
  [/Every (\d+) Seconds?/, (recipe, match) => recipe.kind === 'extract' && recipe.mode === 'frames' && recipe.sampling.by === 'interval' && recipe.sampling.seconds === Number(match[1])],
  [/Thumbnail/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'frames' && recipe.sampling.by === 'thumbnail'],
  [/([\d.]+) kHz/, (recipe, match) => recipe.kind === 'extract' && recipe.mode === 'audio' && recipe.sampleRate === Number(match[1]) * 1000],
  [/\bmono\b/, (recipe) => channelRule(recipe) === 'mono'],
  [/5\.1/, (recipe) => channelRule(recipe) === 'keep' && (audioOut(recipe)?.codec === 'ac3' || audioOut(recipe)?.codec === 'eac3')],
  [/10-bit/, (recipe) => videoOf(recipe)?.pixelFormat === 'yuv420p10le'],
  [/H\.264|x264/, encodes('libx264')],
  [/HEVC|x265/, encodes('libx265')],
  [/AV1/, encodes('libaom-av1')],
  [/VP9/, encodes('libvpx-vp9')],
  [/ProRes/, encodes('prores_ks')],
  [/FFV1/, encodes('ffv1')],
  [/MPEG-2/, encodes('mpeg2video')],
  [/\(copy\)/, encodes('copy')],
  [/fast decode/, (recipe) => recipe.kind === 'compress' && recipe.tune === 'fastdecode'],
  [/Animation/, (recipe) => recipe.kind === 'compress' && recipe.tune === 'animation'],
  [/Film Grain/, (recipe) => recipe.kind === 'compress' && recipe.tune === 'grain'],
  [/AAC/, audioCodec('aac')],
  [/Opus/, audioCodec('opus')],
  [/FLAC/, audioCodec('flac')],
  [/ALAC/, audioCodec('alac')],
  [/PCM/, audioCodec('pcm')],
  [/MP3/, audioCodec('mp3')],
  [/AC-3/, audioCodec('ac3')],
  [/Lossless/, (recipe) => audioOut(recipe)?.codec === 'flac' || audioOut(recipe)?.codec === 'alac' || videoOf(recipe)?.encoder === 'ffv1'],
  [/MP4/, container('mp4')],
  [/MKV/, container('mkv')],
  [/MOV/, container('mov')],
  [/WebM/, container('webm')],
  [/M4A/, container('m4a')],
  [/Ogg/, container('ogg')],
  [/WAV/, container('wav')],
  [/\(TS\)/, container('ts')],
  [/Silent Video/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'video'],
  [/GIF/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'gif'],
  [/to SRT/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'subtitles' && recipe.format === 'srt'],
  [/to WebVTT/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'subtitles' && recipe.format === 'vtt'],
  [/to ASS/, (recipe) => recipe.kind === 'extract' && recipe.mode === 'subtitles' && recipe.format === 'ass']
]

describe('the catalogs', () =>
{
  it('hold 28 Convert, 11 Compress, and 18 Extract presets in their groups', () =>
  {
    const groups = (presets: readonly BuiltinPreset[]): Record<string, number> =>
      presets.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.group]: (counts[entry.group] ?? 0) + 1 }), {})
    expect(groups(CONVERT_PRESETS)).toEqual({ 'General': 4, 'Web': 8, 'Devices': 3, 'Production': 5, 'Audio only': 8 })
    expect(groups(COMPRESS_PRESETS)).toEqual({ Archive: 2, Web: 5, Mobile: 1, Special: 2, Modern: 1 })
    expect(groups(EXTRACT_PRESETS)).toEqual({ Audio: 6, Video: 2, GIF: 3, Frames: 4, Subtitles: 3 })
    expect(Object.keys(groups(CONVERT_PRESETS))).toEqual(PRESET_GROUPS.convert)
    expect(Object.keys(groups(COMPRESS_PRESETS))).toEqual(PRESET_GROUPS.compress)
    expect(Object.keys(groups(EXTRACT_PRESETS))).toEqual(PRESET_GROUPS.extract)
    expect(MEDIA_CATALOGS).toEqual({ convert: CONVERT_PRESETS, compress: COMPRESS_PRESETS, extract: EXTRACT_PRESETS })
  })

  it.each(MEDIA.map((entry) => [entry.id, entry] as const))('%s is a valid whole recipe that names itself', (id, entry) =>
  {
    expect(validateRecipe(entry.recipe)).toEqual({ ok: true, value: entry.recipe })
    expect(entry.recipe.presetId).toBe(id)
    expect(entry.recipe.userPreset).toBeNull()
    expect(entry.label).not.toBe('')
    expect(entry.description).toBe(describeRecipe(entry.recipe))
  })

  it('keeps every id unique across every operation, loudness and gain presets included', () =>
  {
    const ids = BUILTIN_PRESETS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(LOUDNESS_PRESETS.length - 1 + GAIN_PRESETS.length + MEDIA.length)
    expect(ids).not.toContain('custom')
  })

  it('describes Web 1080p from its values', () =>
  {
    expect(COMPRESS_PRESETS.find((entry) => entry.id === 'web-1080p')?.description).toBe('x264 CRF 23, max 1080p, AAC 192k')
  })

  it.each(MEDIA.map((entry) => [entry.label, entry] as const))('every claim of "%s" is a value that runs', (label, entry) =>
  {
    const matched = CLAIMS.filter(([pattern]) => pattern.test(label))
    expect(matched.length, label).toBeGreaterThan(0)
    for (const [pattern, holds] of matched)
    {
      for (const match of label.matchAll(new RegExp(pattern.source, 'g')))
      {
        expect(holds(entry.recipe, match), `${label}: ${match[0]}`).toBe(true)
      }
    }
  })

  it('names no platform, service, or brand, and uses no glyphs', () =>
  {
    const banned = /discord|nitro|youtube|tiktok|reels|instagram|twitter|telegram|apple|iphone|android|chromecast|email|social|spotify/i
    for (const entry of MEDIA)
    {
      for (const text of [entry.id, entry.label, entry.group, entry.description])
      {
        expect(banned.test(text), text).toBe(false)
        expect(/^[\x20-\x7e]*$/.test(text), text).toBe(true)
      }
    }
  })

  it('names the size presets by size: Target 25 MB and Target 500 MB, in bytes', () =>
  {
    const sized = COMPRESS_PRESETS.filter((entry) => entry.recipe.target.mode === 'size')
    expect(sized.map((entry) => [entry.id, entry.label, entry.recipe.target])).toEqual([
      ['target-25mb', 'Target 25 MB', { mode: 'size', targetBytes: 25_000_000, twoPass: true }],
      ['target-500mb', 'Target 500 MB', { mode: 'size', targetBytes: 500_000_000, twoPass: true }]
    ])
  })

  it('sets the channels the labels name: Podcast and Audiobook mono, AC-3 Surround keeps 5.1', () =>
  {
    const channels = (id: string): string => channelRule((findCatalogPreset(id) as BuiltinPreset).recipe)
    expect(channels('podcast-mp3')).toBe('mono')
    expect(channels('audiobook')).toBe('mono')
    expect(channels('audio-podcast')).toBe('mono')
    expect(channels('ac3-surr')).toBe('keep')
    expect(describeRecipe((findCatalogPreset('ac3-surr') as BuiltinPreset).recipe)).toBe('AC-3 448k at 5.1, audio only')
    const forced = MEDIA.filter((entry) => channelRule(entry.recipe) !== 'keep').map((entry) => entry.id)
    expect(forced).toEqual(['podcast-mp3', 'audiobook', 'audio-podcast'])
  })

  it('uses only x265 tunes that exist: grain or none on Archival and HQ Master, never film', () =>
  {
    const x265 = COMPRESS_PRESETS.filter((entry) => entry.recipe.encoder === 'libx265')
    expect(x265.map((entry) => [entry.id, entry.recipe.tune])).toEqual([
      ['archival', 'grain'], ['master', null], ['animation', 'animation'], ['film-grain', 'grain']
    ])
    for (const entry of COMPRESS_PRESETS)
    {
      const tunes = entry.recipe.encoder === 'libx264' ? ['film', 'animation', 'grain', 'fastdecode', 'zerolatency'] : ['animation', 'grain', 'fastdecode', 'zerolatency']
      expect(entry.recipe.tune === null || tunes.includes(entry.recipe.tune), entry.id).toBe(true)
    }
  })

  it('encodes video in every Compress preset: the audio-only presets moved to Convert', () =>
  {
    expect(COMPRESS_PRESETS.every((entry) => entry.recipe.target.mode !== 'quality' || entry.recipe.target.tier !== 'lossless')).toBe(true)
    expect(LEGACY_PRESET_IDS.compress['audio-flac']).toEqual({ op: 'convert', id: 'flac' })
    expect(LEGACY_PRESET_IDS.compress['audio-aac']).toEqual({ op: 'convert', id: 'aac-m4a' })
    expect(findCatalogPreset('flac')?.group).toBe('Audio only')
    expect(findCatalogPreset('aac-m4a')?.group).toBe('Audio only')
  })

  it('states each CRF that runs, never a quality tier', () =>
  {
    expect(COMPRESS_PRESETS.map((entry) => [entry.id, entry.recipe.target.mode === 'crf' ? entry.recipe.target.crf : entry.recipe.target.mode])).toEqual([
      ['archival', 22], ['master', 22], ['web-1080p', 23], ['web-720p', 28], ['target-25mb', 'size'], ['target-500mb', 'size'],
      ['x264-master', 18], ['mobile', 23], ['animation', 28], ['film-grain', 22], ['av1-streaming', 28]
    ])
  })

  it('keeps WMA output possible for .wma, .wmv, and .asf with wmav2 at two channels', () =>
  {
    for (const target of ['wma', 'wmv', 'asf'])
    {
      const recipe: ConvertRecipe = {
        kind: 'convert', presetId: null, userPreset: null, container: target, video: target === 'wma' ? null : { encoder: 'wmv2', bitrateKbps: 2000, fit: null, fps: null, pixelFormat: 'yuv420p' },
        audio: { kind: 'codec', codec: 'wmav2', kbpsPerPair: 192 }, channels: 'keep', subtitles: 'keep'
      }
      expect(validateRecipe(recipe).ok, target).toBe(true)
      expect(applicability(recipe, { video: true, audio: [{ channels: 6, language: null, isDefault: true }], subtitles: [], subtitleCount: 0 })
        .map((rule) => rule.code)).toEqual(['too-many-channels'])
    }
    expect(audioCodecLabel('wmav2')).toBe('WMA')
  })
})

function findCatalogPreset(id: string): BuiltinPreset | undefined
{
  return MEDIA.find((entry) => entry.id === id)
}

describe('pins and defaults', () =>
{
  it('pins the nine new-install presets to Alt+1 through Alt+9', () =>
  {
    const pinned = Object.entries(DEFAULT_PINS).map(([key, id]) =>
    {
      const info = findPreset(id as string)
      return `${key} ${info?.op} ${info?.label}`
    })
    expect(pinned).toEqual([
      '1 normalize EBU R 128',
      '2 normalize Podcast (Apple Podcasts)',
      '3 normalize Music streaming (Spotify reference)',
      '4 boost Gentle lift',
      '5 convert MP4 (H.264/AAC)',
      '6 compress Web 1080p',
      '7 extract MP3 320k',
      '8 convert FLAC Lossless',
      '9 extract Subtitles to SRT'
    ])
  })

  it('starts every operation from a preset that resolves', () =>
  {
    expect(DEFAULT_PRESETS.normalize).toBe('streaming-r128s2')
    const starts: Record<string, string> = {
      normalize: DEFAULT_PRESETS.normalize,
      boost: DEFAULT_PRESETS.boost,
      convert: DEFAULT_PRESETS.convert,
      compress: DEFAULT_PRESETS.compress,
      extract: DEFAULT_PRESETS.extract
    }
    for (const op of OPERATIONS)
    {
      expect(findPreset(starts[op])?.op, op).toBe(op)
      expect(applyPreset(starts[op], SOURCE)?.kind, op).toBe(op)
    }
    expect(Object.keys(starts).sort()).toEqual([...OPERATIONS].sort())
    expect([DEFAULT_PRESETS.boost, DEFAULT_PRESETS.convert, DEFAULT_PRESETS.compress, DEFAULT_PRESETS.extract])
      .toEqual(['gentle-lift', 'mp4-h264', 'web-1080p', 'audio-mp3-320'])
  })

  it('builds the whole starting recipe of every operation from its default preset', () =>
  {
    const mp3: EncoderPolicy = { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 }
    for (const op of OPERATIONS)
    {
      const recipe = applyDefaultPreset(op, mp3)
      expect(recipe.kind, op).toBe(op)
      expect(validateRecipe(recipe), op).toEqual({ ok: true, value: recipe })
      expect(isEdited(recipe, presetLookup()), op).toBe(false)
    }
    expect(applyDefaultPreset('normalize', mp3)).toEqual(applyLoudnessPreset('streaming-r128s2', mp3))
    expect(applyDefaultPreset('boost', mp3)).toEqual(applyPreset('gentle-lift', mp3))
    expect(applyDefaultPreset('convert', SOURCE)).toEqual(applyPreset('mp4-h264', SOURCE))
  })

  it('keeps Custom loudness a starting point, not a preset of its own', () =>
  {
    const aac: EncoderPolicy = { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }
    expect(applyPreset('custom', aac)).toBeNull()
    const custom = applyLoudnessPreset('custom', aac) as NormalizeRecipe
    expect(custom).toMatchObject({ presetId: 'custom', userPreset: null, output: aac })
    expect(validateRecipe(custom)).toEqual({ ok: true, value: custom })
    expect(recipeLabel(custom, presetLookup())).toBe('Normalize · Custom')
  })

  it('groups loudness presets as standards or not, gain presets as app presets', () =>
  {
    expect(findPreset('ebu-r128')?.group).toBe('Standards')
    expect(findPreset('night')?.group).toBe('App presets')
    expect(findPreset('louder')?.group).toBe('App presets')
    expect(PRESET_GROUPS.normalize).toEqual(['Standards', 'App presets', 'Custom'])
    expect(PRESET_GROUPS.boost).toEqual(['App presets', 'Custom'])
  })
})

const USER: UserPreset =
{
  id: 'user-1',
  name: 'Late podcasts',
  recipe: { ...applyLoudnessPreset('apple-podcasts', { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }), maxLimitingDb: 2 },
  createdAt: 1,
  updatedAt: 2
}

describe('lookups', () =>
{
  it('finds built-in and user presets, and nothing for Custom or an unknown id', () =>
  {
    expect(findPreset('web-1080p')).toEqual({ id: 'web-1080p', op: 'compress', label: 'Web 1080p', group: 'Web', user: false })
    expect(findPreset('user-1', [USER])).toEqual({ id: 'user-1', op: 'normalize', label: 'Late podcasts', group: USER_PRESET_GROUP, user: true })
    expect(findPreset('custom')).toBeNull()
    expect(findPreset('nope', [USER])).toBeNull()
  })

  it('applies whole recipes: copies of media presets, the output policy for audio presets, the reference for user presets', () =>
  {
    const first = applyPreset('mp4-h264', SOURCE) as ConvertRecipe
    first.audio = { kind: 'copy' }
    expect((applyPreset('mp4-h264', SOURCE) as ConvertRecipe).audio).toEqual({ kind: 'codec', codec: 'aac', kbpsPerPair: 256 })
    expect(applyPreset('ebu-r128', { kind: 'codec', codec: 'flac', kbpsPerPair: null })).toEqual(applyLoudnessPreset('ebu-r128', { kind: 'codec', codec: 'flac', kbpsPerPair: null }))
    expect(applyPreset('louder', SOURCE)).toMatchObject({ kind: 'boost', presetId: 'louder', gainDb: 6, output: SOURCE })
    const user = applyPreset('user-1', SOURCE, [USER])
    expect(user).toEqual({ ...USER.recipe, userPreset: { id: 'user-1', name: 'Late podcasts' } })
    expect(user).not.toBe(USER.recipe)
    expect(applyPreset('custom', SOURCE)).toBeNull()
  })

  it('finds no edit in any freshly applied preset, and one after any change', () =>
  {
    const lookup = presetLookup([USER])
    for (const info of BUILTIN_PRESETS)
    {
      const recipe = applyPreset(info.id, { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }) as Recipe
      expect(isEdited(recipe, lookup), info.id).toBe(false)
      expect(recipeLabel(recipe, lookup), info.id).toBe(`${info.op === 'boost' ? 'Gain' : info.op[0].toUpperCase() + info.op.slice(1)} · ${info.label}`)
    }
    const web = applyPreset('web-1080p', SOURCE) as CompressRecipe
    expect(recipeLabel({ ...web, target: { mode: 'crf', crf: 24 } }, lookup)).toBe('Compress · Web 1080p, edited')
    const ebu = applyPreset('ebu-r128', SOURCE) as Recipe
    expect(isEdited({ ...ebu, output: { kind: 'codec', codec: 'opus', kbpsPerPair: 128 } } as Recipe, lookup)).toBe(false)
    const fromUser = applyPreset('user-1', SOURCE, [USER]) as Recipe
    expect(recipeLabel(fromUser, lookup)).toBe('Normalize · Late podcasts')
    expect(recipeLabel({ ...fromUser, maxLimitingDb: 3 } as Recipe, lookup)).toBe('Normalize · Late podcasts, edited')
    expect(recipeLabel(fromUser, presetLookup([]))).toBe('Normalize · Custom (from deleted preset Late podcasts)')
  })

  it('reads Custom for recipes without a built-in preset of their own operation', () =>
  {
    const lookup = presetLookup()
    const custom = applyLoudnessPreset('custom', SOURCE)
    expect(recipeLabel(custom, lookup)).toBe('Normalize · Custom')
    const convert = { ...(applyPreset('mp4-h264', SOURCE) as ConvertRecipe), presetId: null }
    expect(recipeLabel(convert, lookup)).toBe('Convert · Custom')
    const crossed = { ...(applyPreset('mp4-h264', SOURCE) as ConvertRecipe), presetId: 'web-1080p' }
    expect(recipeLabel(crossed, lookup)).toBe('Convert · Custom')
    expect(recipeLabel({ ...convert, presetId: 'retired-preset' }, lookup)).toBe('Convert · Custom')
  })
})

describe('earlier preset ids', () =>
{
  it('maps every renamed or moved id to a preset that exists', () =>
  {
    for (const op of OPERATIONS)
    {
      for (const [old, next] of Object.entries(LEGACY_PRESET_IDS[op]))
      {
        expect(findPreset(next.id)?.op, `${op} ${old}`).toBe(next.op)
        expect(migratePresetId(op, old)).toEqual(next)
      }
    }
  })

  it('keeps current ids, follows renames, and has nothing for Defaults or an unknown id', () =>
  {
    expect(migratePresetId('convert', 'mp4-h264')).toEqual({ op: 'convert', id: 'mp4-h264' })
    expect(migratePresetId('compress', 'discord-25mb')).toEqual({ op: 'compress', id: 'target-25mb' })
    expect(migratePresetId('compress', 'audio-aac')).toEqual({ op: 'convert', id: 'aac-m4a' })
    expect(migratePresetId('boost', 'maximize')).toEqual({ op: 'boost', id: 'louder' })
    expect(migratePresetId('normalize', 'broadcast')).toEqual({ op: 'normalize', id: 'ebu-r128' })
    expect(migratePresetId('extract', 'gif-hq')).toEqual({ op: 'extract', id: 'gif-720' })
    expect(migratePresetId('normalize', 'defaults')).toBeNull()
    expect(migratePresetId('convert', 'web-1080p')).toBeNull()
    expect(migratePresetId('extract', 'nope')).toBeNull()
  })

  it('never follows a name the tables inherit from Object.prototype', () =>
  {
    for (const op of OPERATIONS)
    {
      for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])
      {
        expect(migratePresetId(op, name), `${op} ${name}`).toBeNull()
      }
    }
    expect(migratePresetId('constructor' as Operation, 'discord')).toBeNull()
    expect(migratePresetId('toString' as Operation, 'toString')).toBeNull()
  })
})

describe('facts restated from the earlier preset tables', () =>
{
  const AUDIO_ONLY_CONTAINERS = ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'ac3']
  const VIDEO_CONTAINERS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'flv', 'wmv', 'ogv']

  it('writes audio-only presets to audio containers and video presets to video containers, never both', () =>
  {
    expect(AUDIO_ONLY_CONTAINERS.filter((name) => VIDEO_CONTAINERS.includes(name))).toEqual([])
    for (const entry of CONVERT_PRESETS)
    {
      const list = entry.recipe.video === null ? AUDIO_ONLY_CONTAINERS : VIDEO_CONTAINERS
      expect(list, entry.id).toContain(entry.recipe.container)
    }
  })

  it('pairs every Convert codec with a container that holds it', () =>
  {
    const video: Record<string, string[]> =
    {
      webm: ['libvpx-vp9', 'libaom-av1'],
      mp4: ['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'mpeg4'],
      mov: ['libx264', 'libx265', 'prores_ks', 'mpeg4'],
      mkv: ['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'prores_ks', 'ffv1', 'utvideo', 'mpeg2video', 'mpeg4', 'libtheora'],
      ts: ['libx264', 'libx265', 'mpeg2video', 'mpeg4']
    }
    const audio: Record<string, string[]> =
    {
      webm: ['opus', 'vorbis'], mp4: ['aac', 'alac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'], mov: ['aac', 'alac', 'mp3', 'ac3', 'pcm'],
      mkv: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm'], ts: ['aac', 'mp3', 'ac3', 'eac3'],
      mp3: ['mp3'], flac: ['flac'], wav: ['pcm'], m4a: ['aac', 'alac', 'ac3'], ogg: ['vorbis', 'opus', 'flac'], opus: ['opus'], ac3: ['ac3', 'eac3']
    }
    for (const entry of CONVERT_PRESETS)
    {
      const { container: name, video: v, audio: a } = entry.recipe
      if (v !== null)
      {
        expect(video[name], entry.id).toContain(v.encoder)
      }
      expect(a.kind === 'codec' && audio[name].includes(a.codec), entry.id).toBe(true)
    }
    for (const entry of EXTRACT_PRESETS)
    {
      if (entry.recipe.mode === 'audio' && entry.recipe.audio.kind === 'codec')
      {
        expect(audio[entry.recipe.container], entry.id).toContain(entry.recipe.audio.codec)
      }
    }
  })

  it('keeps the general presets with their codecs and bitrates', () =>
  {
    const facts = CONVERT_PRESETS.filter((entry) => entry.group === 'General').map((entry) =>
    {
      const r = entry.recipe
      return [entry.id, r.container, r.video?.encoder ?? null, r.video?.bitrateKbps ?? null, r.audio.kind === 'codec' ? `${r.audio.codec} ${r.audio.kbpsPerPair}` : r.audio.kind]
    })
    expect(facts).toEqual([
      ['mp4-h264', 'mp4', 'libx264', 5000, 'aac 256'],
      ['mkv-hevc', 'mkv', 'libx265', 5000, 'aac 256'],
      ['webm-vp9', 'webm', 'libvpx-vp9', 2500, 'opus 192'],
      ['mp3-320', 'mp3', null, null, 'mp3 320']
    ])
  })

  it('keeps the web and device presets at their bitrates, sizes, and frame rates, under value-based names', () =>
  {
    const facts = CONVERT_PRESETS.filter((entry) => entry.group === 'Web' || entry.group === 'Devices').map((entry) =>
    {
      const v = entry.recipe.video as NonNullable<ConvertRecipe['video']>
      const fit = v.fit === null ? '' : `${v.fit.maxWidth}x${v.fit.maxHeight} ${v.fit.mode}`
      return [entry.id, entry.recipe.container, v.encoder, v.bitrateKbps, fit, v.fps, entry.recipe.audio.kind === 'codec' ? entry.recipe.audio.kbpsPerPair : null]
    })
    expect(facts).toEqual([
      ['mp4-720p-1500k', 'mp4', 'libx264', 1500, '1280x720 fit', 30, 128],
      ['mp4-10000k', 'mp4', 'libx264', 10000, '', null, 256],
      ['mp4-vertical-4000k', 'mp4', 'libx264', 4000, '1080x1920 pad', 30, 192],
      ['mp4-vertical-3500k', 'mp4', 'libx264', 3500, '1080x1920 pad', 30, 128],
      ['mp4-720p-2500k', 'mp4', 'libx264', 2500, '1280x720 fit', 30, 128],
      ['720p-web', 'mp4', 'libx264', 2500, '1280x720 fit', 30, 192],
      ['mp4-480p-500k', 'mp4', 'libx264', 500, '854x480 fit', 24, 96],
      ['mp4-hevc-1080p', 'mp4', 'libx265', 4000, '1920x1080 fit', null, 192],
      ['mov-h264', 'mov', 'libx264', 8000, '', null, 256],
      ['mp4-4000k', 'mp4', 'libx264', 4000, '', null, 192],
      ['mp4-1080p-5000k', 'mp4', 'libx264', 5000, '1920x1080 fit', null, 256]
    ])
  })

  it('keeps the 480p preset under 5 MB for a minute', () =>
  {
    const entry = findCatalogPreset('mp4-480p-500k') as BuiltinPreset<ConvertRecipe>
    const kbps = (entry.recipe.video?.bitrateKbps ?? 0) + (entry.recipe.audio.kind === 'codec' ? entry.recipe.audio.kbpsPerPair ?? 0 : 0)
    expect((kbps * 1000 / 8) * 60 / 1_000_000).toBeLessThan(5)
  })

  it('keeps the HEVC 1080p and vertical presets at their sizes', () =>
  {
    const hevc = (findCatalogPreset('mp4-hevc-1080p') as BuiltinPreset<ConvertRecipe>).recipe.video
    expect([hevc?.encoder, hevc?.fit]).toEqual(['libx265', { maxWidth: 1920, maxHeight: 1080, mode: 'fit' }])
    const vertical = (findCatalogPreset('mp4-vertical-3500k') as BuiltinPreset<ConvertRecipe>).recipe.video
    expect(vertical?.fit).toEqual({ maxWidth: 1080, maxHeight: 1920, mode: 'pad' })
  })

  it('keeps the production presets with their codecs and audio bitrates per channel pair', () =>
  {
    const facts = CONVERT_PRESETS.filter((entry) => entry.group === 'Production').map((entry) =>
      [entry.id, entry.recipe.container, entry.recipe.video?.encoder, entry.recipe.video?.pixelFormat,
        entry.recipe.audio.kind === 'codec' ? entry.recipe.audio.codec : null, entry.recipe.audio.kind === 'codec' ? entry.recipe.audio.kbpsPerPair : null])
    expect(facts).toEqual([
      ['mp4-av1', 'mp4', 'libaom-av1', 'yuv420p', 'opus', 192],
      ['mov-prores', 'mov', 'prores_ks', 'source', 'pcm', null],
      ['mkv-ffv1', 'mkv', 'ffv1', 'source', 'flac', null],
      ['4k-archive', 'mkv', 'libx265', 'source', 'flac', null],
      ['ts-mpeg2', 'ts', 'mpeg2video', 'yuv420p', 'ac3', 192]
    ])
  })

  it('runs MPEG-2 Broadcast audio at AC-3 192k for stereo and 576k at 5.1, inside the AC-3 range of 192k to 640k', () =>
  {
    const recipe = (findCatalogPreset('ts-mpeg2') as BuiltinPreset<ConvertRecipe>).recipe
    const perPair = recipe.audio.kind === 'codec' ? recipe.audio.kbpsPerPair ?? 0 : 0
    const streamKbps = (channels: number): number => Math.round(perPair * channels / 2)
    expect([streamKbps(2), streamKbps(6)]).toEqual([192, 576])
    expect(streamKbps(2)).toBeGreaterThanOrEqual(192)
    expect(streamKbps(6)).toBeLessThanOrEqual(640)
    expect(describeRecipe(recipe)).toBe('TS, MPEG-2 8000k, AC-3 576k at 5.1')
  })

  it('keeps the audio-only presets with their codecs and stream bitrates', () =>
  {
    const facts = CONVERT_PRESETS.filter((entry) => entry.group === 'Audio only').map((entry) =>
      [entry.id, entry.recipe.container, entry.recipe.audio.kind === 'codec' ? entry.recipe.audio.codec : null, statedKbps(entry.recipe), entry.recipe.channels])
    expect(facts).toEqual([
      ['wav-pcm', 'wav', 'pcm', null, 'keep'],
      ['flac', 'flac', 'flac', null, 'keep'],
      ['alac', 'm4a', 'alac', null, 'keep'],
      ['aac-m4a', 'm4a', 'aac', 256, 'keep'],
      ['opus-128', 'ogg', 'opus', 128, 'keep'],
      ['podcast-mp3', 'mp3', 'mp3', 96, 'mono'],
      ['audiobook', 'm4a', 'aac', 96, 'mono'],
      ['ac3-surr', 'ac3', 'ac3', 448, 'keep']
    ])
  })

  it('keeps the compress presets with their encoders, speeds, sizes, and audio', () =>
  {
    const facts = COMPRESS_PRESETS.map((entry) =>
    {
      const r = entry.recipe
      return [entry.id, r.encoder, r.speed, r.pixelFormat, r.fit?.maxHeight ?? 0, r.audio.kind === 'codec' ? `${r.audio.codec} ${r.audio.kbpsPerPair}` : r.audio.kind]
    })
    expect(facts).toEqual([
      ['archival', 'libx265', 'slow', 'yuv420p10le', 0, 'aac 320'],
      ['master', 'libx265', 'slow', 'yuv420p', 0, 'aac 256'],
      ['web-1080p', 'libx264', 'medium', 'yuv420p', 1080, 'aac 192'],
      ['web-720p', 'libx264', 'fast', 'yuv420p', 720, 'aac 128'],
      ['target-25mb', 'libx264', 'medium', 'yuv420p', 720, 'aac 96'],
      ['target-500mb', 'libx264', 'medium', 'yuv420p', 1080, 'aac 192'],
      ['x264-master', 'libx264', 'slow', 'yuv420p', 0, 'aac 384'],
      ['mobile', 'libx264', 'medium', 'yuv420p', 1080, 'aac 128'],
      ['animation', 'libx265', 'medium', 'yuv420p', 0, 'aac 192'],
      ['film-grain', 'libx265', 'slow', 'yuv420p10le', 0, 'aac 256'],
      ['av1-streaming', 'libaom-av1', 'medium', 'yuv420p', 1080, 'opus 96']
    ])
    expect(COMPRESS_PRESETS.every((entry) => entry.recipe.container === 'source')).toBe(true)
  })

  it('keeps the extract presets with their modes and values', () =>
  {
    const facts = EXTRACT_PRESETS.map((entry) =>
    {
      const r = entry.recipe as ExtractRecipe
      switch (r.mode)
      {
        case 'audio':
          return [entry.id, r.container, r.audio.kind === 'codec' ? r.audio.codec : r.audio.kind, statedKbps(r), r.sampleRate, r.channels]
        case 'video':
          return [entry.id, r.container, r.reencode?.encoder ?? 'copy', r.reencode?.crf ?? null]
        case 'gif':
          return [entry.id, r.fps, r.width, r.dither, r.plays]
        case 'frames':
          return [entry.id, r.format, r.sampling.by, r.sampling.by === 'interval' ? r.sampling.seconds : r.sampling.by === 'count' ? r.sampling.count : null, r.jpgQuality]
        default:
          return [entry.id, r.format, r.stream.by]
      }
    })
    expect(facts).toEqual([
      ['audio-mp3-320', 'mp3', 'mp3', 320, null, 'keep'],
      ['audio-aac-256', 'm4a', 'aac', 256, null, 'keep'],
      ['audio-opus-128', 'opus', 'opus', 128, null, 'keep'],
      ['audio-flac', 'flac', 'flac', null, null, 'keep'],
      ['audio-wav', 'wav', 'pcm', null, null, 'keep'],
      ['audio-podcast', 'mp3', 'mp3', 96, 44100, 'mono'],
      ['video-silent-copy', 'mp4', 'copy', null],
      ['video-silent-h264', 'mp4', 'libx264', 20],
      ['gif-720', 15, 720, 'sierra2_4a', 'infinite'],
      ['gif-480', 12, 480, 'sierra2_4a', 'infinite'],
      ['gif-360', 10, 360, 'bayer', 'infinite'],
      ['frames-thumb', 'png', 'thumbnail', null, null],
      ['frames-every-sec', 'png', 'interval', 1, null],
      ['frames-every-5sec', 'jpg', 'interval', 5, 3],
      ['frames-50-even', 'jpg', 'count', 50, 4],
      ['subs-srt', 'srt', 'default'],
      ['subs-vtt', 'vtt', 'default'],
      ['subs-ass', 'ass', 'default']
    ])
  })

  it('has a name for every codec and encoder any preset uses', () =>
  {
    for (const entry of MEDIA)
    {
      const v = videoOf(entry.recipe)
      if (v !== null && v.encoder !== 'copy')
      {
        expect(videoEncoderLabel(v.encoder as never), entry.id).toMatch(/\S/)
      }
      const a = audioOut(entry.recipe)
      if (a !== null)
      {
        expect(audioCodecLabel(a.codec as never), entry.id).toMatch(/\S/)
      }
    }
  })

  it('keeps loudness targets below 0 LUFS and true peaks at or below 0 dBTP; loudness range is measured, never targeted', () =>
  {
    for (const entry of LOUDNESS_PRESETS)
    {
      expect(entry.target.integratedLufs, entry.id).toBeLessThan(0)
      expect(entry.target.maxTruePeakDbtp, entry.id).toBeLessThanOrEqual(0)
      expect(Object.keys(entry.target), entry.id).not.toContain('loudnessRange')
    }
  })

  it('blocks video presets on a source that only has cover art, so no preset hides that', () =>
  {
    const cover = factsFromSummary({
      container: 'mp3', durationSec: 60, video: null, cover: true, subtitles: 0, attachments: 0, chapters: 0,
      audio: [{ codec: 'mp3', channels: 2, layout: 'stereo', sampleRate: 44100, bitsPerSample: null, bitrateKbps: 320, language: null }]
    })
    const blocked = MEDIA.filter((entry) => applicability(entry.recipe, cover).some((rule) => rule.code === 'no-video-stream')).map((entry) => entry.id)
    expect(blocked).toEqual([
      ...COMPRESS_PRESETS.map((entry) => entry.id),
      'video-silent-copy', 'video-silent-h264', 'gif-720', 'gif-480', 'gif-360', 'frames-thumb', 'frames-every-sec', 'frames-every-5sec', 'frames-50-even'
    ])
  })
})
