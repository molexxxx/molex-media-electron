/**
 * @module editor/inspect/report
 * Reads ffprobe's JSON report into the facts Inspect lists: a plain value first, the technical value beside it.
 * The same facts make the plain-text report the Copy menu writes.
 */
import { formatBitRate, formatFileSize, formatFrameRate, formatLength, formatPreciseLength, formatSampleRate } from '../shared/format'
import { channelsName, codecName, containerName, flagWords, languageName } from './describe'

/** One stream as ffprobe reports it; every field is optional because ffprobe leaves out what it does not know. */
export interface ReportStream
{
  index: number
  codec_type?: string
  codec_name?: string
  codec_long_name?: string
  profile?: string
  level?: number
  width?: number
  height?: number
  sample_aspect_ratio?: string
  display_aspect_ratio?: string
  pix_fmt?: string
  color_range?: string
  color_space?: string
  color_transfer?: string
  color_primaries?: string
  field_order?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  bit_rate?: string
  nb_frames?: string
  duration?: string
  bits_per_raw_sample?: string
  bits_per_sample?: number
  sample_fmt?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  disposition?: Record<string, number>
  tags?: Record<string, string>
  side_data_list?: Array<Record<string, unknown>>
}

/** ffprobe's whole report. */
export interface ProbeReport
{
  streams: ReportStream[]
  format: {
    filename?: string
    format_name?: string
    format_long_name?: string
    start_time?: string
    duration?: string
    size?: string
    bit_rate?: string
    tags?: Record<string, string>
  }
  chapters: unknown[]
}

/** One line of a list: what it is, its plain value, and the technical value when it adds anything. */
export interface Fact
{
  name: string
  value: string
  detail?: string | null
}

/** The report from ffprobe's JSON text, or null when it is not a report. */
export function parseReport(text: string): ProbeReport | null
{
  try
  {
    const data = JSON.parse(text) as Partial<ProbeReport>
    if (!data || typeof data !== 'object')
    {
      return null
    }
    return {
      streams: Array.isArray(data.streams) ? data.streams.filter((s) => s && typeof s === 'object') : [],
      format: data.format && typeof data.format === 'object' ? data.format : {},
      chapters: Array.isArray(data.chapters) ? data.chapters : []
    }
  }
  catch
  {
    return null
  }
}

/** A report made from the app's own probe when ffprobe's report cannot be read; it carries fewer fields. */
export function reportFromProbe(info: {
  videoStreams: ReportStream[]
  audioStreams: ReportStream[]
  subtitleStreams: ReportStream[]
  dataStreams: ReportStream[]
  format: ProbeReport['format']
}): ProbeReport
{
  const typed = (streams: ReportStream[], type: string): ReportStream[] => streams.map((s) => ({ ...s, codec_type: s.codec_type ?? type }))
  const streams = [
    ...typed(info.videoStreams, 'video'),
    ...typed(info.audioStreams, 'audio'),
    ...typed(info.subtitleStreams, 'subtitle'),
    ...typed(info.dataStreams, 'data')
  ].sort((a, b) => a.index - b.index)
  return { streams, format: info.format, chapters: [] }
}

/** True for a stream that is a picture shown with the audio, such as cover art. */
export function isCoverArt(stream: ReportStream): boolean
{
  return stream.codec_type === 'video' && stream.disposition?.attached_pic === 1
}

/** The stream's kind in words: Video, Cover art, Audio, Subtitles, Data, Attachment. */
export function streamTitle(stream: ReportStream): string
{
  if (isCoverArt(stream))
  {
    return 'Cover art'
  }
  switch (stream.codec_type)
  {
    case 'video':
      return 'Video'
    case 'audio':
      return 'Audio'
    case 'subtitle':
      return 'Subtitles'
    case 'attachment':
      return 'Attachment'
    default:
      return 'Data'
  }
}

/** True when the file has a moving picture, so keyframes mean something. */
export function hasVideo(report: ProbeReport): boolean
{
  return report.streams.some((s) => s.codec_type === 'video' && !isCoverArt(s))
}

function join(...parts: Array<string | number | null | undefined | false>): string | null
{
  const kept = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '').map(String)
  return kept.length > 0 ? kept.join(' · ') : null
}

/** The codec level in its usual form: H.264 41 reads 4.1, HEVC 93 reads 3.1. */
export function levelWords(codec: string | undefined, level: number | undefined): string | null
{
  if (level === undefined || level < 0)
  {
    return null
  }
  if (codec === 'h264')
  {
    return (level / 10).toFixed(1)
  }
  if (codec === 'hevc')
  {
    return (level / 30).toFixed(1)
  }
  return String(level)
}

/** The bit depth of a picture: the raw sample size, else what the pixel format says. */
export function videoBitDepth(stream: Pick<ReportStream, 'bits_per_raw_sample' | 'pix_fmt'>): number | null
{
  const raw = parseInt(stream.bits_per_raw_sample ?? '', 10)
  if (Number.isFinite(raw) && raw > 0)
  {
    return raw
  }
  const match = /p(\d{2})(?:le|be)?$/.exec(stream.pix_fmt ?? '')
  if (match)
  {
    return Number(match[1])
  }
  return stream.pix_fmt ? 8 : null
}

/** Chroma subsampling in words from the pixel format: "4:2:0", "4:4:4", "RGB". */
export function chromaWords(pixFmt: string | undefined): string | null
{
  if (!pixFmt)
  {
    return null
  }
  if (/^yuvj?420|^nv12|^p010/.test(pixFmt))
  {
    return '4:2:0'
  }
  if (/^yuvj?422/.test(pixFmt))
  {
    return '4:2:2'
  }
  if (/^yuvj?444/.test(pixFmt))
  {
    return '4:4:4'
  }
  if (/^(?:rgb|bgr|gbr|argb|abgr|rgba|bgra)/.test(pixFmt))
  {
    return 'RGB'
  }
  if (/^gray/.test(pixFmt))
  {
    return 'Grayscale'
  }
  return null
}

const PRIMARIES: Readonly<Record<string, string>> = {
  bt709: 'BT.709',
  bt2020: 'BT.2020',
  bt2020nc: 'BT.2020',
  bt2020c: 'BT.2020 (constant luminance)',
  smpte170m: 'BT.601 (NTSC)',
  bt470bg: 'BT.601 (PAL)',
  smpte432: 'Display P3',
  smpte431: 'DCI-P3'
}

/** The color standard and range in words, or null when ffprobe did not report them. */
export function colorWords(stream: ReportStream): string | null
{
  const standard = PRIMARIES[stream.color_primaries ?? ''] ?? PRIMARIES[stream.color_space ?? '']
  const range = stream.color_range === 'tv' ? 'limited range' : stream.color_range === 'pc' ? 'full range' : null
  if (!standard && !range)
  {
    return null
  }
  return [standard, range].filter(Boolean).join(', ')
}

/** HDR in words: "HDR10 (PQ)", "HLG", "Dolby Vision", or "SDR" when a known SDR transfer is set; null when unknown. */
export function dynamicRangeWords(stream: ReportStream): string | null
{
  const sideTypes = (stream.side_data_list ?? []).map((side) => String(side.side_data_type ?? ''))
  if (sideTypes.some((type) => /dovi|dolby vision/i.test(type)))
  {
    return 'Dolby Vision'
  }
  switch (stream.color_transfer)
  {
    case 'smpte2084':
      return 'HDR10 (PQ)'
    case 'arib-std-b67':
      return 'HLG'
    case undefined:
    case '':
    case 'unknown':
      return null
    default:
      return 'SDR'
  }
}

/** The mastering and content light levels HDR side data carries, in nits; null when absent. */
export function lightLevelWords(stream: ReportStream): string | null
{
  const parts: string[] = []
  for (const side of stream.side_data_list ?? [])
  {
    const type = String(side.side_data_type ?? '')
    if (/content light level/i.test(type) && typeof side.max_content === 'number')
    {
      parts.push(`content peak ${side.max_content} nits`)
    }
    if (/mastering display/i.test(type) && typeof side.max_luminance === 'string')
    {
      const [num, den] = side.max_luminance.split('/').map(Number)
      if (den > 0)
      {
        parts.push(`mastered to ${Math.round(num / den)} nits`)
      }
    }
  }
  return parts.length > 0 ? parts.join(', ') : null
}

/** Scan type in words from the field order. */
export function scanWords(fieldOrder: string | undefined): string | null
{
  switch (fieldOrder)
  {
    case 'progressive':
      return 'Progressive'
    case 'tt':
    case 'tb':
      return 'Interlaced, top field first'
    case 'bb':
    case 'bt':
      return 'Interlaced, bottom field first'
    default:
      return null
  }
}

const SAMPLE_FORMATS: Readonly<Record<string, string>> = {
  u8: '8-bit',
  s16: '16-bit',
  s32: '32-bit',
  s64: '64-bit',
  flt: '32-bit float',
  dbl: '64-bit float'
}

/** A decoded sample format in words: "32-bit float, planar". */
export function sampleFormatWords(sampleFmt: string | undefined): string | null
{
  if (!sampleFmt)
  {
    return null
  }
  const planar = sampleFmt.endsWith('p')
  const base = SAMPLE_FORMATS[planar ? sampleFmt.slice(0, -1) : sampleFmt]
  return base ? `${base}${planar ? ', planar' : ''}` : null
}

function streamLength(stream: ReportStream): string
{
  const direct = parseFloat(stream.duration ?? '')
  if (Number.isFinite(direct))
  {
    return formatLength(direct)
  }
  const tag = Object.entries(stream.tags ?? {}).find(([key]) => /^duration/i.test(key))?.[1]
  const match = tag ? /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/.exec(tag) : null
  return match ? formatLength(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) : ''
}

function frameRateFact(stream: ReportStream): Fact | null
{
  const value = formatFrameRate(stream.avg_frame_rate) || formatFrameRate(stream.r_frame_rate)
  if (!value)
  {
    return null
  }
  const variable = stream.avg_frame_rate && stream.r_frame_rate && stream.avg_frame_rate !== stream.r_frame_rate && formatFrameRate(stream.avg_frame_rate) !== formatFrameRate(stream.r_frame_rate)
  return {
    name: 'Frame rate',
    value: variable ? `${value}, variable` : value,
    detail: variable ? `r ${stream.r_frame_rate} · avg ${stream.avg_frame_rate}` : stream.avg_frame_rate || stream.r_frame_rate
  }
}

/** The facts of one stream, plain values first. */
export function streamFacts(stream: ReportStream): Fact[]
{
  const facts: Array<Fact | null> = []
  const codec: Fact = { name: 'Codec', value: codecName(stream.codec_name), detail: join(stream.codec_name, stream.profile, levelWords(stream.codec_name, stream.level) && `level ${levelWords(stream.codec_name, stream.level)}`) }
  if (stream.codec_type === 'video')
  {
    const depth = videoBitDepth(stream)
    facts.push(
      codec,
      stream.width && stream.height ? { name: 'Picture', value: `${stream.width} × ${stream.height}`, detail: join(stream.display_aspect_ratio && `${stream.display_aspect_ratio} display`, stream.sample_aspect_ratio && stream.sample_aspect_ratio !== '1:1' && `SAR ${stream.sample_aspect_ratio}`) } : null,
      isCoverArt(stream) ? null : frameRateFact(stream),
      depth !== null ? { name: 'Bit depth', value: `${depth}-bit`, detail: join(chromaWords(stream.pix_fmt), stream.pix_fmt) } : null,
      colorWords(stream) ? { name: 'Color', value: colorWords(stream) as string, detail: join(stream.color_primaries, stream.color_space, stream.color_transfer, stream.color_range) } : null,
      dynamicRangeWords(stream) ? { name: 'Dynamic range', value: dynamicRangeWords(stream) as string, detail: join(lightLevelWords(stream), stream.color_transfer) } : null,
      scanWords(stream.field_order) ? { name: 'Scan', value: scanWords(stream.field_order) as string, detail: stream.field_order } : null
    )
  }
  else if (stream.codec_type === 'audio')
  {
    const raw = parseInt(stream.bits_per_raw_sample ?? '', 10)
    const depth = Number.isFinite(raw) && raw > 0 ? raw : (stream.bits_per_sample ?? 0) > 0 ? stream.bits_per_sample : null
    facts.push(
      codec,
      { name: 'Channels', value: channelsName(stream.channels, stream.channel_layout), detail: join(stream.channel_layout, stream.channels && `${stream.channels} ch`) },
      formatSampleRate(stream.sample_rate) ? { name: 'Sample rate', value: formatSampleRate(stream.sample_rate), detail: stream.sample_rate ? `${stream.sample_rate} Hz` : null } : null,
      depth ? { name: 'Bit depth', value: `${depth}-bit`, detail: stream.sample_fmt } : sampleFormatWords(stream.sample_fmt) ? { name: 'Decodes as', value: sampleFormatWords(stream.sample_fmt) as string, detail: stream.sample_fmt } : null
    )
  }
  else
  {
    facts.push({ name: 'Format', value: codecName(stream.codec_name), detail: join(stream.codec_name, stream.codec_long_name) })
  }
  facts.push(
    formatBitRate(stream.bit_rate) ? { name: 'Bit rate', value: formatBitRate(stream.bit_rate), detail: stream.bit_rate ? `${stream.bit_rate} b/s` : null } : null,
    streamLength(stream) ? { name: 'Length', value: streamLength(stream), detail: stream.nb_frames ? `${stream.nb_frames} frames` : null } : null,
    languageName(stream.tags?.language) ? { name: 'Language', value: languageName(stream.tags?.language) as string, detail: stream.tags?.language } : null,
    stream.tags?.title ? { name: 'Title', value: stream.tags.title } : null,
    flagWords(stream.disposition) ? { name: 'Flags', value: flagWords(stream.disposition) as string } : null
  )
  return facts.filter((fact): fact is Fact => fact !== null && fact.value !== '')
}

/** The facts of the file as a whole. */
export function containerFacts(report: ProbeReport, fileName: string): Fact[]
{
  const format = report.format
  const start = parseFloat(format.start_time ?? '')
  const facts: Array<Fact | null> = [
    { name: 'Container', value: containerName(format.format_name, fileName), detail: join(format.format_name, format.format_long_name) },
    { name: 'Length', value: formatLength(parseFloat(format.duration ?? '')), detail: formatPreciseLength(format.duration) },
    { name: 'Size', value: formatFileSize(format.size), detail: format.size ? `${Number(format.size).toLocaleString('en-US')} bytes` : null },
    { name: 'Bit rate', value: formatBitRate(format.bit_rate), detail: format.bit_rate ? `${format.bit_rate} b/s` : null },
    { name: 'Streams', value: String(report.streams.length) },
    Number.isFinite(start) && start > 0 ? { name: 'Starts at', value: `${start.toFixed(3)} s`, detail: format.start_time } : null,
    report.chapters.length > 0 ? { name: 'Chapters', value: String(report.chapters.length) } : null
  ]
  return facts.filter((fact): fact is Fact => fact !== null && fact.value !== '')
}

function factLine(fact: Fact): string
{
  return `${fact.name}: ${fact.value}${fact.detail ? ` (${fact.detail})` : ''}`
}

/** The whole report as plain text, the way the Copy menu writes it. */
export function reportText(report: ProbeReport, fileName: string, filePath: string): string
{
  const lines = [fileName, filePath, '', ...containerFacts(report, fileName).map(factLine)]
  for (const stream of report.streams)
  {
    lines.push('', `${streamTitle(stream)}, stream ${stream.index}`, ...streamFacts(stream).map(factLine))
  }
  const tags = Object.entries(report.format.tags ?? {})
  if (tags.length > 0)
  {
    lines.push('', 'Tags', ...tags.map(([key, value]) => `${key}: ${value}`))
  }
  return lines.join('\n')
}
