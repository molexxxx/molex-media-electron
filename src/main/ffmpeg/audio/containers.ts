/**
 * What each output container holds, measured by muxing real files on the 2022 and 9.0.2 builds: the
 * audio encoders it accepts, whether it takes several audio streams, video, subtitles, attachments,
 * cover art, and chapters, and the muxer every encode names with -f.
 */

/** How a source subtitle stream is written into a container: copied, or converted to a text format. */
export type SubtitleAction = 'copy' | 'mov_text' | 'srt' | 'webvtt'

/** The capabilities of one output container. */
export interface ContainerSpec
{
  /** The extension, lowercase and without the dot. */
  name: string
  /** The FFmpeg muxer passed as -f; null for an extension the app never writes. */
  muxer: string | null
  audioEncoders: ReadonlySet<string>
  multiAudio: boolean
  video: boolean
  /** The action for one source subtitle stream, or null when the container cannot carry it. */
  subtitle(codecName: string, bitmap: boolean): SubtitleAction | null
  attachments: boolean
  coverArt: boolean
  chapters: boolean
  /** The audio codecs that carry the chapters; null when any codec does (Ogg writes them only with Opus). */
  chapterCodecs: ReadonlySet<string> | null
}

/** How a container treats subtitle streams. */
export type SubtitleRule = 'none' | 'matroska' | 'mov_text' | 'webvtt' | 'dvb-copy'

/** One row of the capability table, shared by the extensions it names. */
export interface ContainerRow
{
  names: readonly string[]
  muxer: string
  video: boolean
  audioEncoders: readonly string[]
  multiAudio: boolean
  subtitles: SubtitleRule
  attachments: boolean
  coverArt: boolean
  chapters: boolean
  chapterCodecs: readonly string[] | null
}

/** The little-endian and unsigned PCM encoders the planner chooses. */
export const PCM_LE_ENCODERS: readonly string[] = ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']

/** The big-endian PCM encoders the planner chooses. */
export const PCM_BE_ENCODERS: readonly string[] = ['pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be']

const MATROSKA_AUDIO: readonly string[] = [
  ...PCM_LE_ENCODERS, 'pcm_s16be', 'pcm_s24be', 'pcm_s32be',
  'flac', 'alac', 'wavpack', 'tta', 'aac', 'libmp3lame', 'mp2', 'libopus', 'libvorbis', 'ac3', 'eac3', 'wmav2'
]
/** FLAC is left out: the MP4 muxer of FFmpeg 5.1.x refuses it without -strict, which the app never writes. */
const MP4_AUDIO: readonly string[] = ['aac', 'alac', 'libmp3lame', 'ac3', 'eac3', 'libopus']
const TS_AUDIO: readonly string[] = ['aac', 'libmp3lame', 'mp2', 'ac3', 'eac3']
const OGG_AUDIO: readonly string[] = ['libvorbis', 'libopus', 'flac']

function row(names: readonly string[], muxer: string, video: boolean, audioEncoders: readonly string[], multiAudio: boolean,
  subtitles: SubtitleRule, attachments: boolean, coverArt: boolean, chapters: boolean, chapterCodecs: readonly string[] | null = null): ContainerRow
{
  return { names, muxer, video, audioEncoders, multiAudio, subtitles, attachments, coverArt, chapters, chapterCodecs }
}

/**
 * The capability table. PCM in Matroska loses its channel layout, so the planner prefers FLAC there;
 * 32-bit float big-endian PCM is refused by the Matroska muxer. MOV drops attached cover art without
 * an error, and ASF keeps chapters as markers. Ogg writes chapters only into an Opus stream's header.
 */
export const CONTAINER_ROWS: readonly ContainerRow[] =
[
  row(['mkv'], 'matroska', true, MATROSKA_AUDIO, true, 'matroska', true, false, true),
  row(['mka'], 'matroska', false, MATROSKA_AUDIO, true, 'none', true, false, true),
  row(['mp4', 'm4v'], 'mp4', true, MP4_AUDIO, true, 'mov_text', false, true, true),
  row(['mov'], 'mov', true, ['aac', 'alac', 'libmp3lame', 'ac3', ...PCM_LE_ENCODERS, ...PCM_BE_ENCODERS], true, 'mov_text', false, false, true),
  row(['m4a'], 'ipod', false, ['aac', 'alac', 'ac3'], true, 'none', false, true, true),
  row(['webm'], 'webm', true, ['libopus', 'libvorbis'], true, 'webvtt', false, false, true),
  row(['ts', 'm2ts', 'mts'], 'mpegts', true, TS_AUDIO, true, 'dvb-copy', false, false, false),
  row(['avi'], 'avi', true, ['libmp3lame', 'ac3', 'mp2', ...PCM_LE_ENCODERS], true, 'none', false, false, false),
  row(['mp3'], 'mp3', false, ['libmp3lame'], false, 'none', false, true, true),
  row(['flac'], 'flac', false, ['flac'], false, 'none', false, true, false),
  row(['ogg'], 'ogg', false, OGG_AUDIO, true, 'none', false, false, true, ['opus']),
  row(['oga'], 'oga', false, OGG_AUDIO, true, 'none', false, false, true, ['opus']),
  row(['opus'], 'opus', false, ['libopus'], true, 'none', false, false, true),
  row(['wav'], 'wav', false, PCM_LE_ENCODERS, false, 'none', false, false, false),
  row(['aiff', 'aif'], 'aiff', false, PCM_BE_ENCODERS, false, 'none', false, false, false),
  row(['ac3'], 'ac3', false, ['ac3'], false, 'none', false, false, false),
  row(['eac3'], 'eac3', false, ['eac3'], false, 'none', false, false, false),
  row(['wma'], 'asf', false, ['wmav2'], true, 'none', false, false, true),
  row(['asf', 'wmv'], 'asf', true, ['wmav2'], true, 'none', false, false, true),
  row(['aac'], 'adts', false, ['aac'], false, 'none', false, false, false),
  row(['mp2'], 'mp2', false, ['mp2'], false, 'none', false, false, false),
  row(['wv'], 'wv', false, ['wavpack'], false, 'none', false, false, false),
  row(['gif'], 'gif', true, [], false, 'none', false, false, false)
]

const MATROSKA_TEXT_COPY: ReadonlySet<string> = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'text'])
const MATROSKA_BITMAP_COPY: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'])

function subtitleAction(rule: SubtitleRule, codecName: string, bitmap: boolean): SubtitleAction | null
{
  switch (rule)
  {
    case 'matroska':
      if (bitmap)
      {
        return MATROSKA_BITMAP_COPY.has(codecName) ? 'copy' : null
      }
      return MATROSKA_TEXT_COPY.has(codecName) ? 'copy' : 'srt'
    case 'mov_text':
      return bitmap ? null : 'mov_text'
    case 'webvtt':
      return bitmap ? null : 'webvtt'
    case 'dvb-copy':
      return codecName === 'dvb_subtitle' ? 'copy' : null
    default:
      return null
  }
}

function toSpec(name: string, source: ContainerRow): ContainerSpec
{
  const rule = source.subtitles
  return {
    name,
    muxer: source.muxer,
    audioEncoders: new Set(source.audioEncoders),
    multiAudio: source.multiAudio,
    video: source.video,
    subtitle: (codecName: string, bitmap: boolean) => subtitleAction(rule, codecName.toLowerCase(), bitmap),
    attachments: source.attachments,
    coverArt: source.coverArt,
    chapters: source.chapters,
    chapterCodecs: source.chapterCodecs === null ? null : new Set(source.chapterCodecs)
  }
}

const BY_NAME: ReadonlyMap<string, ContainerRow> = new Map(CONTAINER_ROWS.flatMap((source) => source.names.map((name) => [name, source] as const)))

function normalize(extension: string): string
{
  return extension.trim().replace(/^\./, '').toLowerCase()
}

/** True when the app has measured the container and writes it. */
export function isKnownContainer(extension: string): boolean
{
  return BY_NAME.has(normalize(extension))
}

/**
 * The capabilities of a container by extension, with or without the dot. An extension the table does
 * not name accepts no audio encoder and carries nothing, so a plan always moves its output to a
 * measured container.
 */
export function containerFor(extension: string): ContainerSpec
{
  const name = normalize(extension)
  const source = BY_NAME.get(name)
  if (source !== undefined)
  {
    return toSpec(name, source)
  }
  return {
    name,
    muxer: null,
    audioEncoders: new Set(),
    multiAudio: false,
    video: false,
    subtitle: () => null,
    attachments: false,
    coverArt: false,
    chapters: false,
    chapterCodecs: null
  }
}

const ENCODER_CODECS: Readonly<Record<string, string>> = { libmp3lame: 'mp3', libopus: 'opus', libvorbis: 'vorbis' }

/** The codec an encoder writes, as ffprobe names it: libopus writes opus, libmp3lame writes mp3. */
export function codecOfEncoder(encoder: string): string
{
  return Object.hasOwn(ENCODER_CODECS, encoder) ? ENCODER_CODECS[encoder] : encoder
}

/** True when the container keeps the source's chapters for output audio streams of these codecs. */
export function keepsChapters(container: ContainerSpec, audioCodecs: readonly string[]): boolean
{
  const carriers = container.chapterCodecs
  return container.chapters && (carriers === null || audioCodecs.some((codec) => carriers.has(codec)))
}

const CANONICAL: Readonly<Record<string, string>> =
{
  aac: 'm4a',
  alac: 'm4a',
  libopus: 'opus',
  libvorbis: 'ogg',
  flac: 'flac',
  libmp3lame: 'mp3',
  ac3: 'ac3',
  eac3: 'mka',
  mp2: 'mp2',
  wmav2: 'wma',
  wavpack: 'wv'
}

/**
 * The audio container an output moves to when its source container cannot take the encoder: AAC and
 * ALAC to m4a, Opus to opus, Vorbis to ogg, FLAC to flac, MP3 to mp3, little-endian PCM to wav and
 * big-endian PCM to aiff, AC-3 to ac3, MP2 to mp2, WMA v2 to wma, WavPack to wv, and E-AC-3 and
 * anything else to mka.
 */
export function canonicalAudioContainer(encoder: string): string
{
  if (Object.hasOwn(CANONICAL, encoder))
  {
    return CANONICAL[encoder]
  }
  if (PCM_BE_ENCODERS.includes(encoder))
  {
    return 'aiff'
  }
  if (encoder.startsWith('pcm_'))
  {
    return 'wav'
  }
  return 'mka'
}

/** The container a video file moves to when its own cannot take the chosen audio encoder. */
export const VIDEO_FALLBACK_CONTAINER = 'mkv'
