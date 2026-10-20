/**
 * Which video encoder each output container holds, measured on a real FFmpeg binary for every recipe encoder against
 * every video extension the app opens (scripts/measure-muxers.mjs). A pair is ok only when the encode exits 0, the
 * file probes as the encoder's codec, and a full decode is clean. The pinned build is the default; the legacy 2022
 * build differs in five cells.
 */
import { containerLabel } from './describe'
import { VIDEO_EXTENSIONS } from './extensions'
import { VIDEO_ENCODERS, type VideoEncoder } from './recipes'

/**
 * How a container takes an encoder's output: ok; refused (the muxer rejects it); unreadable (the encode exits 0, but
 * the file probes as another codec or fails to decode); no-muxer (FFmpeg cannot write the extension at all).
 */
export type MuxStatus = 'ok' | 'refused' | 'unreadable' | 'no-muxer'

/** The FFmpeg build an answer is for: the pinned build, or the legacy 2022-10-13 build below the minimum. */
export type MuxBuild = 'pinned' | 'legacy'

/** Every build the table holds, the default first. */
export const MUX_BUILDS: readonly MuxBuild[] = ['pinned', 'legacy']

/** One measured pair. */
export interface MuxCell
{
  status: MuxStatus
  /** FFmpeg's reason for a refusal or a missing muxer, or what the written file reads back as; '' when ok. */
  message: string
}

/** Whether a container holds an encoder's output, with the sentence a field or plan shows when it does not. */
export interface VideoEncoderFit extends MuxCell
{
  ok: boolean
  /** "MP4 cannot hold Theora."; null when ok. */
  reason: string | null
}

/** The codec each encoder writes, as FFmpeg and ffprobe name it. */
export const VIDEO_CODEC_IDS: Readonly<Record<VideoEncoder, string>> =
{
  'libx264': 'h264',
  'libx265': 'hevc',
  'libvpx-vp9': 'vp9',
  'libaom-av1': 'av1',
  'libsvtav1': 'av1',
  'prores_ks': 'prores',
  'ffv1': 'ffv1',
  'utvideo': 'utvideo',
  'mpeg2video': 'mpeg2video',
  'mpeg4': 'mpeg4',
  'libtheora': 'theora',
  'wmv2': 'wmv2'
}

const VIDEO_CODEC_NAMES: Readonly<Record<VideoEncoder, string>> =
{
  'libx264': 'H.264',
  'libx265': 'HEVC',
  'libvpx-vp9': 'VP9',
  'libaom-av1': 'AV1',
  'libsvtav1': 'AV1',
  'prores_ks': 'ProRes',
  'ffv1': 'FFV1',
  'utvideo': 'UT Video',
  'mpeg2video': 'MPEG-2',
  'mpeg4': 'MPEG-4',
  'libtheora': 'Theora',
  'wmv2': 'WMV2'
}

/** The codec an encoder writes, as a user reads it ("H.264", "Theora"). */
export function videoCodecName(encoder: VideoEncoder): string
{
  return VIDEO_CODEC_NAMES[encoder]
}

interface Outcome
{
  status: MuxStatus
  /** FFmpeg's text, per build where the builds word it differently; {codec} is the codec id, {ext} the extension. */
  message: string | Readonly<Record<MuxBuild, string>>
}

const OUTCOMES =
{
  'ok': { status: 'ok', message: '' },
  'no-tag': { status: 'refused', message: 'Could not find tag for codec {codec} in stream #0, codec not currently supported in container' },
  'flv-codec': { status: 'refused', message: 'Video codec {codec} not compatible with flv' },
  'flv-strict': { status: 'refused', message: 'Codec {codec} is not supported in the official FLV specification, use vstrict=-1 / -strict -1 to use it anyway.' },
  'mov-mp4': { status: 'refused', message: '{codec} only supported in MP4.' },
  'mov-avif': { status: 'refused', message: '{codec} only supported in MP4 and AVIF.' },
  'webm': { status: 'refused', message: 'Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.' },
  'ogg': { status: 'refused', message: 'Unsupported codec id in stream 0' },
  'asf-header':
  {
    status: 'refused',
    message:
    {
      pinned: 'Could not write header (incorrect codec parameters ?): Invalid argument',
      legacy: 'Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument'
    }
  },
  'as-rv20': { status: 'unreadable', message: 'probes as \'rv20\'' },
  'as-rawvideo': { status: 'unreadable', message: 'probes as \'rawvideo\'' },
  'as-unknown': { status: 'unreadable', message: 'probes as \'unknown\'' },
  'as-nothing': { status: 'unreadable', message: 'probes as \'nothing\'' },
  'as-mp3': { status: 'unreadable', message: 'probes as \'nothing\'; Header missing' },
  'no-muxer':
  {
    status: 'no-muxer',
    message:
    {
      pinned: 'Unable to choose an output format for \'out.{ext}\'; use a standard extension for the filename or specify the format manually.',
      legacy: 'Unable to find a suitable output format for \'out.{ext}\''
    }
  }
} as const satisfies Readonly<Record<string, Outcome>>

type OutcomeId = keyof typeof OUTCOMES

/**
 * The measured outcome per container on the pinned build, one entry per encoder in VIDEO_ENCODERS order: libx264,
 * libx265, libvpx-vp9, libaom-av1, libsvtav1, prores_ks, ffv1, utvideo, mpeg2video, mpeg4, libtheora, wmv2.
 */
const PINNED: Readonly<Record<string, readonly OutcomeId[]>> =
{
  mp4: ['ok', 'ok', 'ok', 'ok', 'ok', 'no-tag', 'ok', 'no-tag', 'ok', 'ok', 'no-tag', 'no-tag'],
  mkv: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  avi: ['ok', 'as-rawvideo', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  mov: ['ok', 'ok', 'mov-mp4', 'mov-avif', 'mov-avif', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  flv: ['ok', 'ok', 'ok', 'ok', 'ok', 'flv-codec', 'flv-codec', 'flv-codec', 'flv-codec', 'flv-strict', 'flv-codec', 'flv-codec'],
  wmv: ['ok', 'asf-header', 'ok', 'ok', 'ok', 'as-unknown', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  webm: ['webm', 'webm', 'ok', 'ok', 'ok', 'webm', 'webm', 'webm', 'webm', 'webm', 'webm', 'webm'],
  m4v: ['ok', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'ok', 'no-tag', 'no-tag'],
  mpg: ['ok', 'ok', 'as-mp3', 'as-unknown', 'as-unknown', 'as-unknown', 'as-mp3', 'as-mp3', 'ok', 'ok', 'as-mp3', 'as-unknown'],
  mpeg: ['ok', 'ok', 'as-mp3', 'as-unknown', 'as-unknown', 'as-unknown', 'as-mp3', 'as-mp3', 'ok', 'ok', 'as-mp3', 'as-unknown'],
  ts: ['ok', 'ok', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'ok', 'ok', 'as-nothing', 'as-nothing'],
  vob: ['ok', 'ok', 'as-mp3', 'as-unknown', 'as-unknown', 'as-unknown', 'as-mp3', 'as-mp3', 'ok', 'ok', 'as-mp3', 'as-unknown'],
  '3gp': ['ok', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'ok', 'no-tag', 'no-tag'],
  mts: ['ok', 'ok', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'ok', 'ok', 'as-nothing', 'as-nothing'],
  m2ts: ['ok', 'ok', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'as-nothing', 'ok', 'ok', 'as-nothing', 'as-nothing'],
  divx: ['no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer'],
  f4v: ['ok', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag', 'no-tag'],
  ogv: ['ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ogg', 'ok', 'ogg'],
  rm: ['as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20', 'as-rv20'],
  rmvb: ['no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer', 'no-muxer'],
  asf: ['ok', 'asf-header', 'ok', 'ok', 'ok', 'as-unknown', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']
}

/** The pairs the legacy build refuses although the pinned build holds them. */
const LEGACY_CHANGES: ReadonlyArray<readonly [VideoEncoder, string, OutcomeId]> =
[
  ['ffv1', 'mp4', 'no-tag'],
  ['libx265', 'flv', 'flv-codec'],
  ['libvpx-vp9', 'flv', 'flv-codec'],
  ['libaom-av1', 'flv', 'flv-codec'],
  ['libsvtav1', 'flv', 'flv-codec']
]

function cellOf(id: OutcomeId, encoder: VideoEncoder, ext: string, build: MuxBuild): MuxCell
{
  const outcome: Outcome = OUTCOMES[id]
  const text = typeof outcome.message === 'string' ? outcome.message : outcome.message[build]
  return { status: outcome.status, message: text.replace('{codec}', VIDEO_CODEC_IDS[encoder]).replace('{ext}', ext) }
}

function buildTable(build: MuxBuild): Readonly<Record<VideoEncoder, Readonly<Record<string, MuxCell>>>>
{
  const changes = build === 'legacy' ? LEGACY_CHANGES : []
  return Object.fromEntries(VIDEO_ENCODERS.map((encoder, column) => [
    encoder,
    Object.fromEntries(VIDEO_EXTENSIONS.map((ext) =>
    {
      const change = changes.find(([changed, container]) => changed === encoder && container === ext)
      return [ext, cellOf(change === undefined ? PINNED[ext][column] : change[2], encoder, ext, build)]
    }))
  ])) as Record<VideoEncoder, Record<string, MuxCell>>
}

/** The measured table: build, then encoder, then container extension. */
export const MUX_TABLE: Readonly<Record<MuxBuild, Readonly<Record<VideoEncoder, Readonly<Record<string, MuxCell>>>>>> =
{
  pinned: buildTable('pinned'),
  legacy: buildTable('legacy')
}

function extensionKey(container: string): string
{
  return container.replace(/^\./, '').toLowerCase()
}

/** The measured pair for a container extension, with or without its dot; null for a container the table does not hold. */
export function muxCell(encoder: VideoEncoder, container: string, build: MuxBuild = 'pinned'): MuxCell | null
{
  const row = MUX_TABLE[build][encoder]
  const ext = extensionKey(container)
  return Object.hasOwn(row, ext) ? row[ext] : null
}

/**
 * Whether a container holds an encoder's output on a build, the pinned build unless the legacy build is asked for.
 * Null for a container the table does not hold, such as an audio-only extension.
 */
export function videoEncoderFit(encoder: VideoEncoder, container: string, build: MuxBuild = 'pinned'): VideoEncoderFit | null
{
  const cell = muxCell(encoder, container, build)
  if (cell === null)
  {
    return null
  }
  const label = containerLabel(extensionKey(container))
  const reason = cell.status === 'ok'
    ? null
    : cell.status === 'no-muxer' ? `FFmpeg cannot write ${label} files.` : `${label} cannot hold ${videoCodecName(encoder)}.`
  return { ...cell, ok: cell.status === 'ok', reason }
}

/** The fit of a copied stream, judged by the encoder that writes its codec; null for a codec or container the table lacks. */
export function codecFit(codec: string, container: string, build: MuxBuild = 'pinned'): VideoEncoderFit | null
{
  const encoder = VIDEO_ENCODERS.find((candidate) => VIDEO_CODEC_IDS[candidate] === codec.toLowerCase())
  return encoder === undefined ? null : videoEncoderFit(encoder, container, build)
}

/** The extension a Compress output takes: the source's when it holds the encoder on the build, otherwise mkv, which holds every encoder. */
export function compressContainer(source: string, encoder: VideoEncoder, build: MuxBuild = 'pinned'): string
{
  const fit = videoEncoderFit(encoder, source, build)
  return fit !== null && fit.ok ? extensionKey(source) : 'mkv'
}
