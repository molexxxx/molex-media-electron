/**
 * The player's model of a media file: its streams as ffprobe reported them, in the shape the Media information view
 * reads, and how each stream reaches Chromium: played as it is, remuxed into a container Chromium reads, or converted
 * for playback. Every type is plain data that survives structured clone.
 */

/** What a stream is; a video stream marked as an attached picture is cover art. */
export type StreamKind = 'video' | 'cover' | 'audio' | 'subtitle' | 'data'

/** One stream of a file, with only what the player shows or decides on. */
export interface PlayerStream
{
  /** The ffprobe absolute stream index. */
  index: number
  kind: StreamKind
  /** The FFmpeg codec name, such as `h264` or `ac3`. */
  codec: string
  profile: string | null
  /** The codec level as ffprobe prints it, such as 41 for H.264 level 4.1 or 120 for HEVC level 4; null when unset. */
  level: number | null
  language: string | null
  title: string | null
  isDefault: boolean
  bitRate: number | null
  sampleRate: number | null
  channels: number | null
  layout: string | null
  bitDepth: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  pixelFormat: string | null
  colorTransfer: string | null
  colorPrimaries: string | null
  colorSpace: string | null
  hdr: 'pq' | 'hlg' | null
}

/**
 * How a stream reaches Chromium: played as it is, repackaged into a container Chromium reads without touching the
 * stream, or decoded by FFmpeg and handed to Chromium in a form it decodes.
 */
export type PlayRoute = 'direct' | 'remux' | 'convert'

/**
 * Why a picture is not played directly: its container is not one Chromium reads (repackaged), Chromium has no decoder
 * for its codec, this computer cannot decode this stream although Chromium knows the codec, or a picture subtitle is
 * drawn onto it (all three decoded by FFmpeg).
 */
export type PictureReason = 'container' | 'codec' | 'machine' | 'subtitles'

/** What this renderer answered for a picture stream: it decodes it, it has no decoder for the codec, or not here. */
export type DecodeVerdict = 'decodes' | 'no-decoder' | 'not-here'

/** How the picture plays. A repackage copies it into Matroska; FFmpeg decodes anything else from the seek point on. */
export interface PicturePlan
{
  route: PlayRoute
  streamIndex: number
  reason: PictureReason | null
  /** The picture subtitle stream FFmpeg draws onto the picture; absent when none is. */
  subtitleIndex?: number
}

/** How one audio track plays: as it is, copied into a container, or converted to `target`. */
export interface SoundPlan
{
  route: PlayRoute
  /** N in 0:a:N. */
  audioIndex: number
  streamIndex: number
  /** The codec the track is converted to, such as `opus`; null unless converted. */
  target: string | null
  /** The layout written when the converter relabels one, such as 5.1 for 5.1(side); null otherwise. */
  remappedTo: string | null
}

/** A probed file and how the player plays it. */
export interface PlayerMedia
{
  path: string
  /** ffprobe's format name, such as `matroska,webm`. */
  container: string
  containerName: string | null
  duration: number | null
  startTime: number
  bitRate: number | null
  size: number | null
  streams: PlayerStream[]
  /** Null for a file without a picture (cover art is not one), and until the renderer has asked its decoder. */
  picture: PicturePlan | null
  /** One plan per audio track, in 0:a order. */
  sound: SoundPlan[]
}

/** The ffprobe format names of the containers Chromium reads from a file. */
export const CHROMIUM_CONTAINERS: ReadonlySet<string> = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'])

/** The audio codecs Chromium decodes, which the player copies rather than converts. */
export const CHROMIUM_AUDIO_CODECS: ReadonlySet<string> = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'])

/** Text subtitle codecs FFmpeg turns into WebVTT; bitmap subtitles (PGS, DVD, DVB) cannot be. */
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

/** Picture subtitle codecs: bitmaps FFmpeg draws onto the decoded picture. */
export const IMAGE_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'])

/** True when ffprobe's format name lists a container Chromium reads. */
export function containerPlays(formatName: string): boolean
{
  return formatName.split(',').some((name) => CHROMIUM_CONTAINERS.has(name.trim()))
}

/** True for a text subtitle codec. */
export function isTextSubtitle(codec: string): boolean
{
  return TEXT_SUBTITLE_CODECS.has(codec)
}

/** The picture the player shows: the default video stream, else the first; cover art never counts. */
export function pictureStream(streams: readonly PlayerStream[]): PlayerStream | null
{
  const pictures = streams.filter((stream) => stream.kind === 'video')
  return pictures.find((stream) => stream.isDefault) ?? pictures[0] ?? null
}

/** The cheapest way to show a file's picture, given what this renderer answered for its picture stream. */
export function planPicture(streams: readonly PlayerStream[], container: string, verdict: DecodeVerdict): PicturePlan | null
{
  const stream = pictureStream(streams)
  if (stream === null)
  {
    return null
  }
  if (verdict !== 'decodes')
  {
    return { route: 'convert', streamIndex: stream.index, reason: verdict === 'no-decoder' ? 'codec' : 'machine' }
  }
  if (!containerPlays(container))
  {
    return { route: 'remux', streamIndex: stream.index, reason: 'container' }
  }
  return { route: 'direct', streamIndex: stream.index, reason: null }
}

/** A probed file with its picture plan as the chosen subtitle makes it. */
export function mediaWithSubtitles(media: PlayerMedia, subtitleIndex: number | null): PlayerMedia
{
  const picture = pictureWithSubtitles(media.picture, media.streams, subtitleIndex)
  return picture === media.picture ? media : { ...media, picture }
}

/** A file's audio tracks in 0:a order. */
export function audioTracks(streams: readonly PlayerStream[]): PlayerStream[]
{
  return streams.filter((stream) => stream.kind === 'audio')
}

/** A file's text subtitle tracks, shown as text over the stage. */
export function textSubtitles(streams: readonly PlayerStream[]): PlayerStream[]
{
  return streams.filter((stream) => stream.kind === 'subtitle' && isTextSubtitle(stream.codec))
}

/** True for a picture subtitle codec. */
export function isImageSubtitle(codec: string): boolean
{
  return IMAGE_SUBTITLE_CODECS.has(codec)
}

/** A file's picture subtitle tracks, drawn onto the picture by FFmpeg. */
export function imageSubtitles(streams: readonly PlayerStream[]): PlayerStream[]
{
  return streams.filter((stream) => stream.kind === 'subtitle' && isImageSubtitle(stream.codec))
}

/** Every subtitle track the player can show, text or picture, in file order. */
export function shownSubtitles(streams: readonly PlayerStream[]): PlayerStream[]
{
  return streams.filter((stream) => stream.kind === 'subtitle' && (isTextSubtitle(stream.codec) || isImageSubtitle(stream.codec)))
}

/**
 * The picture plan with the chosen subtitle: a picture subtitle is drawn by FFmpeg, so the picture moves to the
 * decode route whatever its own plan; a text subtitle or none leaves the cheapest plan as it is.
 */
export function pictureWithSubtitles(plan: PicturePlan | null, streams: readonly PlayerStream[], subtitleIndex: number | null): PicturePlan | null
{
  if (plan === null || subtitleIndex === null)
  {
    return plan
  }
  const chosen = streams.find((stream) => stream.index === subtitleIndex && stream.kind === 'subtitle')
  if (chosen === undefined || !isImageSubtitle(chosen.codec))
  {
    return plan
  }
  return { route: 'convert', streamIndex: plan.streamIndex, reason: 'subtitles', subtitleIndex }
}

/** A probe value as a finite number, or null. */
function numberOf(value: unknown): number | null
{
  if (value === undefined || value === null || value === '' || value === 'N/A')
  {
    return null
  }
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function textOf(value: unknown): string | null
{
  return typeof value === 'string' && value.trim() !== '' && value !== 'unknown' ? value : null
}

/** A rate such as "30000/1001" as frames per second; null for 0/0 or anything unreadable. */
export function parseRate(value: unknown): number | null
{
  if (typeof value !== 'string')
  {
    return numberOf(value)
  }
  const [top, bottom] = value.split('/')
  const n = Number(top)
  const d = bottom === undefined ? 1 : Number(bottom)
  return Number.isFinite(n) && Number.isFinite(d) && d !== 0 && n > 0 ? n / d : null
}

/** HDR transfer from ffprobe's color_transfer: PQ (HDR10, Dolby Vision base) or HLG. */
export function hdrOf(transfer: string | null): 'pq' | 'hlg' | null
{
  if (transfer === 'smpte2084')
  {
    return 'pq'
  }
  return transfer === 'arib-std-b67' ? 'hlg' : null
}

/** Bits per sample from the raw sample bits, else the pixel format's depth (p10, p12), else null. */
function depthOf(raw: Record<string, unknown>): number | null
{
  const bits = numberOf(raw.bits_per_raw_sample) ?? numberOf(raw.bits_per_sample)
  if (bits !== null && bits > 0)
  {
    return bits
  }
  const format = textOf(raw.pix_fmt)
  const match = format === null ? null : /p(\d{2})(?:le|be)$/.exec(format)
  return match ? Number(match[1]) : null
}

function levelOf(value: unknown): number | null
{
  const level = numberOf(value)
  return level !== null && level > 0 ? level : null
}

function kindOf(raw: Record<string, unknown>): StreamKind
{
  const disposition = (raw.disposition ?? {}) as Record<string, unknown>
  switch (raw.codec_type)
  {
    case 'video':
      return disposition.attached_pic === 1 ? 'cover' : 'video'
    case 'audio':
      return 'audio'
    case 'subtitle':
      return 'subtitle'
    default:
      return 'data'
  }
}

/** One raw ffprobe stream in the player's shape. */
export function toPlayerStream(raw: Record<string, unknown>): PlayerStream
{
  const tags = (raw.tags ?? {}) as Record<string, unknown>
  const disposition = (raw.disposition ?? {}) as Record<string, unknown>
  const transfer = textOf(raw.color_transfer)
  return {
    index: numberOf(raw.index) ?? 0,
    kind: kindOf(raw),
    codec: textOf(raw.codec_name) ?? 'unknown',
    profile: textOf(raw.profile),
    level: levelOf(raw.level),
    language: textOf(tags.language),
    title: textOf(tags.title),
    isDefault: disposition.default === 1,
    bitRate: numberOf(raw.bit_rate) ?? numberOf(tags.BPS),
    sampleRate: numberOf(raw.sample_rate),
    channels: numberOf(raw.channels),
    layout: textOf(raw.channel_layout),
    bitDepth: depthOf(raw),
    width: numberOf(raw.width),
    height: numberOf(raw.height),
    frameRate: parseRate(raw.avg_frame_rate) ?? parseRate(raw.r_frame_rate),
    pixelFormat: textOf(raw.pix_fmt),
    colorTransfer: transfer,
    colorPrimaries: textOf(raw.color_primaries),
    colorSpace: textOf(raw.color_space),
    hdr: hdrOf(transfer)
  }
}

/** What ffprobe's JSON writer prints for a file, as plain records. */
export interface RawProbe
{
  streams: ReadonlyArray<Record<string, unknown>>
  format: Record<string, unknown> | null
}

/** A probe in the player's shape, before the sound plans that depend on the build and the picture plan this renderer makes. */
export function summarizeProbe(raw: RawProbe, path: string): Omit<PlayerMedia, 'sound' | 'picture'>
{
  const format = raw.format ?? {}
  return {
    path,
    container: textOf(format.format_name) ?? '',
    containerName: textOf(format.format_long_name),
    duration: numberOf(format.duration),
    startTime: numberOf(format.start_time) ?? 0,
    bitRate: numberOf(format.bit_rate),
    size: numberOf(format.size),
    streams: raw.streams.map(toPlayerStream)
  }
}

const VIDEO_CODEC_NAMES: Readonly<Record<string, string>> =
{
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg1video: 'MPEG-1 video',
  mpeg2video: 'MPEG-2 video',
  mpeg4: 'MPEG-4 Part 2',
  msmpeg4v3: 'Microsoft MPEG-4',
  vc1: 'VC-1',
  wmv1: 'Windows Media Video 7',
  wmv2: 'Windows Media Video 8',
  wmv3: 'Windows Media Video 9',
  prores: 'Apple ProRes',
  dnxhd: 'Avid DNxHD',
  mjpeg: 'Motion JPEG',
  theora: 'Theora',
  ffv1: 'FFV1',
  png: 'PNG image',
  h263: 'H.263',
  flv1: 'Sorenson Spark'
}

const AUDIO_CODEC_NAMES: Readonly<Record<string, string>> =
{
  aac: 'AAC',
  mp3: 'MP3',
  mp2: 'MPEG audio layer 2',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'Apple Lossless',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  wmav1: 'Windows Media Audio',
  wmav2: 'Windows Media Audio',
  wmapro: 'Windows Media Audio Pro',
  wmalossless: 'Windows Media Audio Lossless',
  wavpack: 'WavPack',
  ape: 'Monkey\'s Audio',
  amr_nb: 'AMR narrowband',
  amr_wb: 'AMR wideband'
}

const SUBTITLE_CODEC_NAMES: Readonly<Record<string, string>> =
{
  subrip: 'SubRip (SRT)',
  srt: 'SubRip (SRT)',
  ass: 'Advanced SubStation Alpha',
  ssa: 'SubStation Alpha',
  mov_text: 'MP4 timed text',
  webvtt: 'WebVTT',
  text: 'Plain text',
  hdmv_pgs_subtitle: 'Blu-ray picture subtitles (PGS)',
  dvd_subtitle: 'DVD picture subtitles',
  dvb_subtitle: 'DVB picture subtitles',
  eia_608: 'Closed captions (CEA-608)'
}

/** A codec's plain name for people, such as "Dolby Digital (AC-3)" for `ac3`; unknown names come back as given. */
export function codecName(codec: string): string
{
  if (codec.startsWith('pcm_'))
  {
    return 'PCM (uncompressed)'
  }
  for (const table of [VIDEO_CODEC_NAMES, AUDIO_CODEC_NAMES, SUBTITLE_CODEC_NAMES])
  {
    if (Object.hasOwn(table, codec))
    {
      return table[codec]
    }
  }
  return codec
}
