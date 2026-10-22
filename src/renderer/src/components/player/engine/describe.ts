/**
 * The player's words for media: the short facts under a track's title, how a file is being played, and the Media
 * information sections, each a plain sentence first with the technical values folded under it.
 */

import { audioTracks, codecName, isImageSubtitle, pictureStream, type PictureReason, type PlayerMedia, type PlayerStream, type PlayRoute, type SoundPlan } from '../../../../../shared/player/media'
import { getExt, type Track } from '../types'

const SEP = ' · '

let languageNames: Intl.DisplayNames | null | undefined

/** A language code in words ("English" for eng); null when unknown or undetermined. */
export function languageName(code: string | null): string | null
{
  if (code === null || code === '' || code === 'und')
  {
    return null
  }
  if (languageNames === undefined)
  {
    try
    {
      languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
    }
    catch
    {
      languageNames = null
    }
  }
  try
  {
    return languageNames?.of(code) ?? code
  }
  catch
  {
    return code
  }
}

const CONTAINER_NAMES: Readonly<Record<string, string>> =
{
  mov: 'MP4',
  mp4: 'MP4',
  matroska: 'Matroska',
  webm: 'WebM',
  mpegts: 'MPEG transport stream',
  mpeg: 'MPEG program stream',
  avi: 'AVI',
  asf: 'Windows Media',
  flv: 'Flash video',
  ogg: 'Ogg',
  wav: 'WAV',
  mp3: 'MP3',
  flac: 'FLAC',
  aac: 'AAC',
  aiff: 'AIFF',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  dts: 'DTS',
  ape: 'Monkey\'s Audio',
  wv: 'WavPack'
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined
{
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** A container's plain name from ffprobe's format name; a WebM file reads as WebM, not Matroska. */
export function containerName(formatName: string, path = ''): string
{
  const first = formatName.split(',')[0]?.trim() ?? ''
  if (first === 'matroska' && getExt(path) === 'webm')
  {
    return 'WebM'
  }
  return own(CONTAINER_NAMES, first) ?? (first === '' ? 'Unknown container' : first.toUpperCase())
}

/** A channel count and layout in words: mono, stereo, 5.1, 7.1, or "6 channels". */
export function channelWords(channels: number | null, layout: string | null): string
{
  const base = layout?.replace(/\((?:side|back|wide)\)$/, '') ?? null
  if (base === 'mono' || channels === 1)
  {
    return 'mono'
  }
  if (base === 'stereo' || (base === null && channels === 2))
  {
    return 'stereo'
  }
  if (base !== null && /^\d\.\d(?:\.\d)?$/.test(base))
  {
    return base
  }
  return channels === null ? 'unknown channels' : `${channels} channels`
}

function size(width: number | null, height: number | null): string | null
{
  return width !== null && height !== null ? `${width} × ${height}` : null
}

function rate(fps: number | null): string | null
{
  if (fps === null)
  {
    return null
  }
  return `${Math.round(fps * 100) / 100} fps`
}

function kilohertz(hz: number | null): string | null
{
  return hz === null ? null : `${Math.round(hz / 100) / 10} kHz`
}

function bitRateWords(bps: number | null): string | null
{
  if (bps === null || bps <= 0)
  {
    return null
  }
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`
}

function bytesWords(bytes: number | null): string | null
{
  if (bytes === null || bytes <= 0)
  {
    return null
  }
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1)
  {
    value /= 1000
    unit += 1
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`
}

function secondsWords(seconds: number | null): string | null
{
  if (seconds === null || !Number.isFinite(seconds))
  {
    return null
  }
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  if (h > 0)
  {
    return `${h} h ${m} min`
  }
  return m > 0 ? `${m} min ${s} s` : `${s} s`
}

function joined(parts: ReadonlyArray<string | null | undefined>): string
{
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(SEP)
}

/** A picture stream in one line: "H.264 · 1920 × 1080 · 29.97 fps · HDR (PQ)". */
export function pictureLine(stream: PlayerStream): string
{
  const hdr = stream.hdr === 'pq' ? 'HDR (PQ)' : stream.hdr === 'hlg' ? 'HDR (HLG)' : null
  return joined([codecName(stream.codec), size(stream.width, stream.height), rate(stream.frameRate), hdr])
}

/** An audio stream in one line: "Dolby Digital (AC-3) · 5.1 · 48 kHz · German". */
export function soundLine(stream: PlayerStream): string
{
  return joined([codecName(stream.codec), channelWords(stream.channels, stream.layout), kilohertz(stream.sampleRate), languageName(stream.language)])
}

/** A subtitle stream in one line: "SubRip (SRT) · English". */
export function subtitleLine(stream: PlayerStream): string
{
  return joined([codecName(stream.codec), languageName(stream.language)])
}

/** An audio track's menu name: its title, else its language, else "Track N", then its codec and channels. */
export function audioTrackName(stream: PlayerStream, position: number): string
{
  const name = stream.title ?? languageName(stream.language) ?? `Track ${position + 1}`
  return `${name} (${codecName(stream.codec)}, ${channelWords(stream.channels, stream.layout)})`
}

/** A subtitle track's menu name: its title, else its language, else "Subtitles N"; picture subtitles say so. */
export function subtitleTrackName(stream: PlayerStream, position: number): string
{
  const language = languageName(stream.language)
  const name = stream.title !== null
    ? language !== null && !stream.title.includes(language) ? `${stream.title} (${language})` : stream.title
    : language ?? `Subtitles ${position + 1}`
  return isImageSubtitle(stream.codec) ? `${name}, picture` : name
}

function hostOf(url: string): string
{
  try
  {
    return new URL(url).hostname.replace(/^www\./, '')
  }
  catch
  {
    return url
  }
}

/** The short facts under a track's title: the container and the streams for a probed file, else where it comes from. */
export function trackFacts(track: Track, audioIndex = track.audioIndex ?? 0): string
{
  if (track.videoUrl !== undefined)
  {
    const host = hostOf(track.videoUrl)
    const youtube = host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com'
    if (track.live === true)
    {
      return youtube ? 'YouTube live stream' : `Live stream from ${host}`
    }
    return youtube ? 'YouTube link' : `Link from ${host}`
  }
  if (track.filePath === undefined)
  {
    return track.isBlob ? 'Dropped file' : `Web address on ${hostOf(track.src)}`
  }
  const media = track.media
  if (!media)
  {
    const ext = getExt(track.name)
    return ext === '' ? 'Local file' : `${ext.toUpperCase()} file`
  }
  const picture = pictureStream(media.streams)
  const sound = audioTracks(media.streams)[audioIndex] ?? null
  return joined([
    containerName(media.container, media.path),
    picture === null ? null : joined([codecName(picture.codec), size(picture.width, picture.height)]),
    sound === null ? 'No sound' : `${codecName(sound.codec)} ${channelWords(sound.channels, sound.layout)}`
  ])
}

const ROUTE_NAMES: Readonly<Record<PlayRoute, string>> = { direct: 'Direct', remux: 'Repackaged', convert: 'Decoded by FFmpeg' }

/** A route's plain name: Direct, Repackaged, or Decoded by FFmpeg. */
export function routeName(route: PlayRoute): string
{
  return ROUTE_NAMES[route]
}

const ENCODER_NAMES: Readonly<Record<string, string>> =
{
  h264_nvenc: 'the NVIDIA hardware encoder',
  h264_qsv: 'Intel Quick Sync',
  h264_amf: 'the AMD hardware encoder',
  libx264: 'the x264 software encoder',
  libopus: 'the Opus encoder'
}

/** An encoder in words with its FFmpeg name: "the NVIDIA hardware encoder (h264_nvenc)". */
export function encoderName(encoder: string): string
{
  const words = Object.hasOwn(ENCODER_NAMES, encoder) ? ENCODER_NAMES[encoder] : null
  return words === null ? encoder : `${words} (${encoder})`
}

const PICTURE_REASONS: Readonly<Record<PictureReason, (codec: string, container: string) => string>> =
{
  container: (_codec, container) => `repackaged into Matroska without changing the picture, because Chromium does not read ${container} files`,
  codec: (codec) => `decoded by FFmpeg, because Chromium has no decoder for ${codec}`,
  machine: (codec) => `decoded by FFmpeg, because Chromium on this computer cannot decode this ${codec} stream`,
  subtitles: () => 'decoded by FFmpeg to show image subtitles'
}

/** How the picture plays, as a sentence, naming the encoder that hands a decoded picture to Chromium. */
export function pictureRouteSentence(media: PlayerMedia, shown: boolean, encoder: string | null = null): string | null
{
  const plan = media.picture
  if (plan === null)
  {
    return null
  }
  if (!shown)
  {
    return 'Picture: hidden while the visualization shows.'
  }
  if (plan.route === 'direct' || plan.reason === null)
  {
    return 'Picture: plays directly in Chromium.'
  }
  const stream = media.streams.find((candidate) => candidate.index === plan.streamIndex)
  const how = `Picture: ${PICTURE_REASONS[plan.reason](codecName(stream?.codec ?? 'unknown'), containerName(media.container, media.path))}.`
  return plan.route === 'convert' && encoder !== null ? `${how} It reaches the screen as H.264 through ${encoderName(encoder)}.` : how
}

/** How the chosen sound track plays, as a sentence. */
export function soundRouteSentence(media: PlayerMedia, audioIndex: number): string
{
  const plan: SoundPlan | undefined = media.sound[audioIndex]
  if (plan === undefined)
  {
    return 'Sound: this file has no sound.'
  }
  if (plan.route === 'direct')
  {
    return 'Sound: plays directly in Chromium.'
  }
  if (plan.route === 'remux')
  {
    return 'Sound: repackaged out of the file without re-encoding.'
  }
  const stream = media.streams.find((candidate) => candidate.index === plan.streamIndex)
  const from = stream === undefined ? 'its codec' : `${codecName(stream.codec)} ${channelWords(stream.channels, stream.layout)}`
  const to = plan.remappedTo === null ? 'Opus' : `Opus ${channelWords(null, plan.remappedTo)}`
  return `Sound: decoded by FFmpeg from ${from}, because Chromium has no decoder for it, and handed over as ${to} through ${encoderName('libopus')}.`
}

/** A short note for the transport while FFmpeg decodes: "Picture and sound decoded by FFmpeg". */
export function decodeNote(media: PlayerMedia | null | undefined, audioIndex: number, pictureShown: boolean): string | null
{
  if (!media)
  {
    return null
  }
  const picture = pictureShown && media.picture !== null && media.picture.route === 'convert'
  const sound = media.sound[audioIndex]?.route === 'convert'
  if (picture && sound)
  {
    return 'Picture and sound decoded by FFmpeg'
  }
  if (picture)
  {
    return 'Picture decoded by FFmpeg'
  }
  return sound ? 'Sound decoded by FFmpeg' : null
}

/** One technical value of the Media information view. */
export interface InfoRow
{
  term: string
  value: string
}

/** One part of the Media information view: a plain summary, then the technical values. */
export interface InfoSection
{
  id: string
  title: string
  summary: string
  rows: InfoRow[]
}

function rows(entries: ReadonlyArray<readonly [string, string | number | null | undefined]>): InfoRow[]
{
  return entries
    .filter((entry): entry is readonly [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([term, value]) => ({ term, value: typeof value === 'number' ? value.toLocaleString('en-US') : value }))
}

const KIND_TITLES: Readonly<Record<string, string>> = { video: 'Video', cover: 'Cover art', audio: 'Audio', subtitle: 'Subtitles', data: 'Data' }

function streamSection(stream: PlayerStream, ordinal: number, count: number): InfoSection
{
  const base = KIND_TITLES[stream.kind]
  const title = count > 1 ? `${base} ${ordinal + 1}` : base
  const summary = stream.kind === 'video' || stream.kind === 'cover'
    ? pictureLine(stream)
    : stream.kind === 'audio' ? soundLine(stream) : stream.kind === 'subtitle' ? subtitleLine(stream) : codecName(stream.codec)
  const language = languageName(stream.language)
  return {
    id: `stream-${stream.index}`,
    title,
    summary,
    rows: rows([
      ['Codec', `${codecName(stream.codec)} (${stream.codec})`],
      ['Profile', stream.profile],
      ['Title', stream.title],
      ['Language', stream.language === null ? null : language === null || language === stream.language ? stream.language : `${language} (${stream.language})`],
      ['Resolution', size(stream.width, stream.height)],
      ['Frame rate', stream.frameRate === null ? null : `${Math.round(stream.frameRate * 1000) / 1000} fps`],
      ['Pixel format', stream.pixelFormat],
      ['Color primaries', stream.colorPrimaries],
      ['Color transfer', stream.colorTransfer],
      ['Color matrix', stream.colorSpace],
      ['HDR', stream.hdr === 'pq' ? 'PQ (HDR10)' : stream.hdr === 'hlg' ? 'HLG' : null],
      ['Sample rate', stream.sampleRate === null ? null : `${stream.sampleRate.toLocaleString('en-US')} Hz`],
      ['Channels', stream.channels === null ? null : stream.layout === null ? String(stream.channels) : `${stream.channels} (${stream.layout})`],
      ['Bit depth', stream.bitDepth === null ? null : `${stream.bitDepth} bit`],
      ['Bit rate', stream.bitRate === null ? null : `${Math.round(stream.bitRate / 1000).toLocaleString('en-US')} kb/s`],
      ['Default track', stream.isDefault ? 'Yes' : null],
      ['Stream index', `#${stream.index}`]
    ])
  }
}

/** How a file is being played as technical values: each path and the encoder FFmpeg hands decoded streams over with. */
export function routeRows(media: PlayerMedia, audioIndex: number, pictureShown: boolean, encoder: string | null): InfoRow[]
{
  const sound = media.sound[audioIndex]
  return rows([
    ['Picture path', media.picture === null ? null : pictureShown ? routeName(media.picture.route) : 'Not shown'],
    ['Picture encoder', media.picture?.route === 'convert' && pictureShown ? encoder ?? 'Chosen when the picture starts' : null],
    ['Sound path', sound === undefined ? null : routeName(sound.route)],
    ['Sound encoder', sound?.route === 'convert' ? 'libopus' : null]
  ])
}

/** The Media information view of a probed file: how it plays, the file, then each stream in file order. */
export function mediaInfo(media: PlayerMedia, audioIndex: number, pictureShown: boolean, encoder: string | null = null): { playing: string[], routes: InfoRow[], sections: InfoSection[] }
{
  const playing = [pictureRouteSentence(media, pictureShown, encoder), soundRouteSentence(media, audioIndex)].filter((line): line is string => line !== null)
  const file: InfoSection = {
    id: 'file',
    title: 'File',
    summary: joined([containerName(media.container, media.path), secondsWords(media.duration), bitRateWords(media.bitRate), bytesWords(media.size)]),
    rows: rows([
      ['Container', media.containerName === null ? media.container : `${media.containerName} (${media.container})`],
      ['Duration', media.duration === null ? null : `${media.duration.toFixed(3)} s`],
      ['Start time', media.startTime === 0 ? null : `${media.startTime.toFixed(3)} s`],
      ['Overall bit rate', media.bitRate === null ? null : `${Math.round(media.bitRate / 1000).toLocaleString('en-US')} kb/s`],
      ['Size', media.size === null ? null : `${media.size.toLocaleString('en-US')} bytes`],
      ['Path', media.path]
    ])
  }
  const counts = new Map<string, number>()
  for (const stream of media.streams)
  {
    counts.set(stream.kind, (counts.get(stream.kind) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const sections = media.streams.map((stream) =>
  {
    const ordinal = seen.get(stream.kind) ?? 0
    seen.set(stream.kind, ordinal + 1)
    return streamSection(stream, ordinal, counts.get(stream.kind) ?? 1)
  })
  return { playing, routes: routeRows(media, audioIndex, pictureShown, encoder), sections: [file, ...sections] }
}
