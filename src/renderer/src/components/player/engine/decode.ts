/**
 * What this computer's Chromium decodes, asked at runtime with the stream's exact codec string, never assumed from a
 * codec name: H.264, HEVC, VP8, VP9, and AV1 strings are built from the probe's profile, level, and bit depth, and
 * MediaCapabilities answers for that size and frame rate, with canPlayType as the fallback.
 */

import type { DecodeVerdict, PlayerStream } from '../../../../../shared/player/media'

/** A codec string and the container type to ask about it in. */
export interface CodecQuery
{
  contentType: string
}

function hex2(value: number): string
{
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).toUpperCase().padStart(2, '0')
}

function pad2(value: number): string
{
  return String(Math.max(0, Math.round(value))).padStart(2, '0')
}

const H264_PROFILES: Readonly<Record<string, readonly [number, number]>> =
{
  'Baseline': [0x42, 0x00],
  'Constrained Baseline': [0x42, 0xE0],
  'Main': [0x4D, 0x00],
  'Extended': [0x58, 0x00],
  'High': [0x64, 0x00],
  'Constrained High': [0x64, 0x0C],
  'Progressive High': [0x64, 0x08],
  'High 10': [0x6E, 0x00],
  'High 10 Intra': [0x6E, 0x10],
  'High 4:2:2': [0x7A, 0x00],
  'High 4:2:2 Intra': [0x7A, 0x10],
  'High 4:4:4 Predictive': [0xF4, 0x00],
  'High 4:4:4 Intra': [0xF4, 0x10]
}

const HEVC_PROFILES: Readonly<Record<string, readonly [number, string]>> =
{
  'Main': [1, '6'],
  'Main 10': [2, '4'],
  'Main Still Picture': [3, '2'],
  'Rext': [4, '10']
}

/** Bits per sample from the probe, else from the pixel format, else 8. */
export function depthOf(stream: Pick<PlayerStream, 'bitDepth' | 'pixelFormat'>): number
{
  if (stream.bitDepth !== null && stream.bitDepth > 0)
  {
    return stream.bitDepth
  }
  const match = stream.pixelFormat === null ? null : /p(\d{2})(?:le|be)$/.exec(stream.pixelFormat)
  return match ? Number(match[1]) : 8
}

function vp9Level(height: number | null): number
{
  if (height === null || height <= 1080)
  {
    return 40
  }
  return height <= 2160 ? 51 : 61
}

/** The MIME type and exact codec string Chromium is asked about; null for codecs no Chromium decodes. */
export function codecQueryFor(stream: Pick<PlayerStream, 'codec' | 'profile' | 'level' | 'bitDepth' | 'pixelFormat' | 'height'>): CodecQuery | null
{
  switch (stream.codec)
  {
    case 'h264':
    {
      const [profile, constraint] = H264_PROFILES[stream.profile ?? 'High'] ?? H264_PROFILES.High
      return { contentType: `video/mp4; codecs="avc1.${hex2(profile)}${hex2(constraint)}${hex2(stream.level ?? 40)}"` }
    }
    case 'hevc':
    {
      const fallback = depthOf(stream) > 8 ? HEVC_PROFILES['Main 10'] : HEVC_PROFILES.Main
      const [profile, compatibility] = (stream.profile !== null && Object.hasOwn(HEVC_PROFILES, stream.profile)) ? HEVC_PROFILES[stream.profile] : fallback
      return { contentType: `video/mp4; codecs="hvc1.${profile}.${compatibility}.L${stream.level ?? 120}.B0"` }
    }
    case 'vp8':
      return { contentType: 'video/webm; codecs="vp8"' }
    case 'vp9':
    {
      const profile = /(\d)/.exec(stream.profile ?? '')?.[1] ?? (depthOf(stream) > 8 ? '2' : '0')
      return { contentType: `video/mp4; codecs="vp09.${pad2(Number(profile))}.${pad2(vp9Level(stream.height))}.${pad2(depthOf(stream))}"` }
    }
    case 'av1':
    {
      const profile = stream.profile === 'High' ? 1 : stream.profile === 'Professional' ? 2 : 0
      return { contentType: `video/mp4; codecs="av01.${profile}.${pad2(stream.level ?? 8)}M.${pad2(depthOf(stream))}"` }
    }
    default:
      return null
  }
}

/** What the decoder is asked: a content type and the stream's size, rate, and bit rate. */
export interface DecodeQuestion
{
  contentType: string
  width: number
  height: number
  framerate: number
  bitrate: number
}

/** Asks MediaCapabilities, and canPlayType when it cannot answer. */
export async function askDecoder(question: DecodeQuestion): Promise<boolean>
{
  try
  {
    const capabilities = navigator.mediaCapabilities
    if (capabilities?.decodingInfo)
    {
      const info = await capabilities.decodingInfo({
        type: 'file',
        video: { contentType: question.contentType, width: question.width, height: question.height, framerate: question.framerate, bitrate: question.bitrate }
      })
      return info.supported
    }
  }
  catch
  {
    // Fall through to canPlayType.
  }
  try
  {
    return document.createElement('video').canPlayType(question.contentType) === 'probably'
  }
  catch
  {
    return false
  }
}

/** This renderer's answer for a picture stream: it decodes it, no Chromium has a decoder for it, or this one cannot. */
export async function pictureVerdict(stream: PlayerStream, ask: (question: DecodeQuestion) => Promise<boolean> = askDecoder): Promise<DecodeVerdict>
{
  const query = codecQueryFor(stream)
  if (query === null)
  {
    return 'no-decoder'
  }
  const decodes = await ask({
    contentType: query.contentType,
    width: stream.width ?? 1920,
    height: stream.height ?? 1080,
    framerate: stream.frameRate ?? 30,
    bitrate: stream.bitRate ?? 8_000_000
  })
  return decodes ? 'decodes' : 'not-here'
}
