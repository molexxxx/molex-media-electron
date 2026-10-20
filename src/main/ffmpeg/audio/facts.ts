/**
 * Probed media facts: the subset of ffprobe's JSON that the audio planners read, turned into plain
 * MediaFacts. Pure; the probe itself runs elsewhere.
 */
import type { AudioFacts, MediaFacts } from '../../../shared/audio/types'
import { extensionOf } from '../../../shared/jobs/extensions'

export type { AudioFacts, MediaFacts }

/**
 * The layout guessed for a stream whose layout was probed as unknown, by channel count: FFmpeg's own
 * default for that count (av_channel_layout_default), kept only where the channel order has one
 * reading. 3, 5, and 7 channels have several (2.1 or 3.0, 5.0 or 4.1, 6.1 or 7.0), so they stay null.
 */
export const DEFAULT_LAYOUT: Readonly<Record<number, string>> = { 1: 'mono', 2: 'stereo', 4: '4.0', 6: '5.1', 8: '7.1' }

/** One stream of `ffprobe -v error -show_streams -show_format -show_chapters -of json`. */
export interface ProbeStream
{
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  channels?: number
  channel_layout?: string
  sample_rate?: string
  sample_fmt?: string
  bits_per_raw_sample?: string
  bit_rate?: string
  duration?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
}

/** The subset of `ffprobe -v error -show_streams -show_format -show_chapters -of json` the planners read. */
export interface ProbeJson
{
  streams: ProbeStream[]
  format: { format_name: string; duration?: string; tags?: Record<string, string> }
  chapters?: Array<{ id: number; start_time: string; end_time: string; tags?: Record<string, string> }>
}

const BITMAP_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub'
])

const UNSPECIFIED_LAYOUT = /^\d+ channels$/

/** True when a subtitle codec carries rendered bitmaps rather than text; FFmpeg cannot turn one into the other. */
export function isBitmapSubtitle(codecName: string): boolean
{
  return BITMAP_SUBTITLE_CODECS.has(codecName.toLowerCase())
}

/**
 * The layout of an audio stream. A probed name stands as given; a layout probed as unknown (omitted,
 * 'unknown', or FFmpeg's bare 'N channels') takes DEFAULT_LAYOUT for its count, or null when the count
 * has no default, and filtered processing of such a stream is refused with a reason.
 */
export function resolveLayout(channels: number, probed: string | undefined): { layout: string | null; guessed: boolean }
{
  if (probed !== undefined && probed !== '' && probed !== 'unknown' && !UNSPECIFIED_LAYOUT.test(probed))
  {
    return { layout: probed, guessed: false }
  }
  const layout = Object.hasOwn(DEFAULT_LAYOUT, channels) ? DEFAULT_LAYOUT[channels] : null
  return { layout, guessed: layout !== null }
}

/** True when the file has a video stream that is not cover art. */
export function isVideoFile(facts: MediaFacts): boolean
{
  return facts.video.some((stream) => !stream.cover)
}

function tag(tags: Record<string, string> | undefined, key: string): string | null
{
  if (tags === undefined)
  {
    return null
  }
  const found = Object.keys(tags).find((name) => name.toLowerCase() === key)
  return found === undefined ? null : tags[found]
}

function positive(value: string | number | undefined): number | null
{
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : null
}

function nonNegative(value: string | undefined): number | null
{
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

const CLOCK_DURATION = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/

/** Seconds from a Matroska DURATION tag (HH:MM:SS.nnnnnnnnn); Matroska streams carry no stream duration of their own. */
function clockSeconds(value: string | null): number | null
{
  const match = value === null ? null : CLOCK_DURATION.exec(value.trim())
  return match === null ? null : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function isMovFamily(formatName: string): boolean
{
  return formatName.split(',').some((name) => name === 'mov' || name === 'mp4')
}

function audioFacts(stream: ProbeStream, audioIndex: number, movFamily: boolean): AudioFacts
{
  const channels = positive(stream.channels) ?? 0
  const { layout, guessed } = resolveLayout(channels, stream.channel_layout)
  return {
    audioIndex,
    streamIndex: stream.index,
    codecName: stream.codec_name ?? 'unknown',
    profile: stream.profile ?? null,
    channels,
    layout,
    layoutGuessed: guessed,
    sampleRate: positive(stream.sample_rate) ?? 0,
    sampleFmt: stream.sample_fmt ?? null,
    bitsPerRawSample: positive(stream.bits_per_raw_sample),
    bitRate: positive(stream.bit_rate),
    durationSec: nonNegative(stream.duration) ?? clockSeconds(tag(stream.tags, 'duration')),
    language: tag(stream.tags, 'language'),
    title: tag(stream.tags, 'title') ?? (movFamily ? tag(stream.tags, 'name') : null),
    disposition: { ...(stream.disposition ?? {}) }
  }
}

function fileDuration(probe: ProbeJson): number
{
  const format = nonNegative(probe.format?.duration)
  if (format !== null)
  {
    return format
  }
  const streams = (probe.streams ?? []).map((stream) => nonNegative(stream.duration)).filter((d): d is number => d !== null)
  return streams.length > 0 ? Math.max(...streams) : 0
}

/**
 * MediaFacts from one probe. Streams keep source order within each kind; cover art (attached_pic) is a
 * video stream marked cover and never makes the file a video file; attachments, data streams, and
 * streams of unknown type are kept as facts so the stream plan can report them.
 */
export function toMediaFacts(probe: ProbeJson, path: string): MediaFacts
{
  const formatName = probe.format?.format_name ?? ''
  const movFamily = isMovFamily(formatName)
  const facts: MediaFacts = {
    path,
    container: extensionOf(path),
    formatName,
    durationSec: fileDuration(probe),
    audio: [],
    video: [],
    subtitles: [],
    attachments: [],
    data: [],
    chapters: probe.chapters?.length ?? 0
  }
  for (const stream of probe.streams ?? [])
  {
    const codecName = stream.codec_name ?? 'unknown'
    switch (stream.codec_type)
    {
      case 'audio':
        facts.audio.push(audioFacts(stream, facts.audio.length, movFamily))
        break
      case 'video':
        facts.video.push({ streamIndex: stream.index, codecName, cover: stream.disposition?.attached_pic === 1 })
        break
      case 'subtitle':
        facts.subtitles.push({
          streamIndex: stream.index,
          subIndex: facts.subtitles.length,
          codecName,
          bitmap: isBitmapSubtitle(codecName),
          language: tag(stream.tags, 'language')
        })
        break
      case 'attachment':
        facts.attachments.push({ streamIndex: stream.index, filename: tag(stream.tags, 'filename'), mimetype: tag(stream.tags, 'mimetype') })
        break
      default:
        facts.data.push({ streamIndex: stream.index, codecName })
    }
  }
  return facts
}
