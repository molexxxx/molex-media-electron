/**
 * @module editor/inspect/describe
 * Plain names for what FFprobe reports: containers, codecs, channel layouts, languages, and stream flags. The
 * plain name comes first; the technical value stays beside it for those who need it.
 */

const CODECS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'H.265 (HEVC)',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2',
  prores: 'Apple ProRes',
  mjpeg: 'Motion JPEG',
  png: 'PNG',
  gif: 'GIF',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'Apple Lossless',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  pcm_s16le: 'PCM, 16-bit',
  pcm_s24le: 'PCM, 24-bit',
  pcm_s32le: 'PCM, 32-bit',
  pcm_f32le: 'PCM, 32-bit float',
  subrip: 'SubRip text',
  ass: 'Advanced SubStation Alpha',
  webvtt: 'WebVTT text',
  mov_text: 'MP4 timed text',
  hdmv_pgs_subtitle: 'Blu-ray picture subtitles (PGS)',
  dvd_subtitle: 'DVD picture subtitles',
  bin_data: 'Binary data',
  tmcd: 'Timecode'
}

/** A codec's plain name, or its FFprobe name in capitals when it has none here. */
export function codecName(codec: string | undefined): string
{
  if (!codec)
  {
    return 'Unknown'
  }
  return CODECS[codec] ?? codec.toUpperCase()
}

const CONTAINERS_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: 'MP4',
  m4a: 'MPEG-4 audio (M4A)',
  m4v: 'MP4',
  mov: 'QuickTime (MOV)',
  mkv: 'Matroska (MKV)',
  mka: 'Matroska audio (MKA)',
  webm: 'WebM',
  avi: 'AVI',
  wav: 'WAV',
  mp3: 'MP3',
  flac: 'FLAC',
  ogg: 'Ogg',
  opus: 'Ogg Opus',
  ts: 'MPEG transport stream',
  m2ts: 'MPEG transport stream',
  gif: 'GIF'
}

/** The container's plain name from the file's extension, falling back to FFprobe's first format name. */
export function containerName(formatName: string | undefined, fileName: string): string
{
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  const known = CONTAINERS_BY_EXTENSION[extension]
  if (known)
  {
    return known
  }
  const first = formatName?.split(',')[0]
  return first ? first.toUpperCase() : 'Unknown'
}

/** A channel count in words, with the layout when it adds anything: "Stereo", "5.1 surround", "3 channels". */
export function channelsName(channels: number | undefined, layout: string | undefined): string
{
  switch (channels)
  {
    case undefined:
    case 0:
      return 'Unknown'
    case 1:
      return 'Mono'
    case 2:
      return 'Stereo'
    case 6:
      return '5.1 surround'
    case 8:
      return '7.1 surround'
    default:
      return layout ? `${channels} channels (${layout})` : `${channels} channels`
  }
}

const LANGUAGES: Readonly<Record<string, string>> = {
  eng: 'English',
  en: 'English',
  spa: 'Spanish',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  por: 'Portuguese',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  rus: 'Russian',
  dut: 'Dutch',
  nld: 'Dutch',
  swe: 'Swedish',
  pol: 'Polish'
}

/** A language tag in words, or null when it is missing or undetermined. */
export function languageName(code: string | undefined): string | null
{
  if (!code || code === 'und')
  {
    return null
  }
  return LANGUAGES[code.toLowerCase()] ?? code
}

const FLAG_WORDS: Readonly<Record<string, string>> = {
  default: 'Default',
  forced: 'Forced',
  hearing_impaired: 'For the hard of hearing',
  visual_impaired: 'Audio description',
  comment: 'Commentary',
  original: 'Original language',
  dub: 'Dubbed',
  lyrics: 'Lyrics',
  karaoke: 'Karaoke',
  attached_pic: 'Cover art',
  captions: 'Captions',
  descriptions: 'Descriptions'
}

/** The stream's set flags in words: "Default, Forced"; null when none is set. */
export function flagWords(disposition: Record<string, number> | undefined): string | null
{
  if (!disposition)
  {
    return null
  }
  const words = Object.entries(disposition)
    .filter(([, value]) => value === 1)
    .map(([key]) => FLAG_WORDS[key] ?? key.replace(/_/g, ' '))
  return words.length > 0 ? words.join(', ') : null
}

/** What the keyframe times say about cutting: how many, the usual and the longest gap between them. */
export function keyframeSummary(times: readonly number[], durationSeconds: number): { count: number, average: number | null, longest: number | null }
{
  if (times.length === 0)
  {
    return { count: 0, average: null, longest: null }
  }
  const points = [...times]
  if (durationSeconds > points[points.length - 1])
  {
    points.push(durationSeconds)
  }
  let longest = 0
  for (let i = 1; i < points.length; i++)
  {
    longest = Math.max(longest, points[i] - points[i - 1])
  }
  const span = points[points.length - 1] - points[0]
  return {
    count: times.length,
    average: times.length > 1 || span > 0 ? span / Math.max(1, points.length - 1) : null,
    longest: points.length > 1 ? longest : null
  }
}

/** Seconds in plain words for gaps: "0.5 s", "2 s", "1 min 4 s". */
export function secondsWords(seconds: number): string
{
  if (seconds < 60)
  {
    return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))} s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`
}
