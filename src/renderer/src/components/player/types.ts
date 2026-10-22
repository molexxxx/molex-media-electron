/**
 * @module components/player/types
 * @description The player's track model, the media extensions it takes, and time formatting.
 */

import type { PlayerMedia } from '../../../../shared/player/media'

/** One playlist entry: a local file, a link resolved through yt-dlp, a direct web address, or a dropped blob. */
export interface Track
{
  id: string
  name: string
  /** The resolved sound URL, cached once known; empty until then. */
  src: string
  isBlob: boolean
  /** The page address yt-dlp resolves, for a link track. */
  videoUrl?: string
  filePath?: string
  /** Seconds, once a probe, yt-dlp, or the media element knows it. */
  duration?: number | null
  /** The probe and play plan of a local file; null when the probe failed, undefined before it ran. */
  media?: PlayerMedia | null
  /** The chosen audio track, N in 0:a:N; 0 by default. */
  audioIndex?: number
  /** True once yt-dlp has said the link is live. */
  live?: boolean
}

/** Every extension the player accepts from a drop, the file picker, or a folder. */
export const MEDIA_EXTS = [
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'ac3', 'eac3', 'dts', 'mka', 'aiff', 'aif', 'ape', 'wv',
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'asf', 'vob',
  'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv'
]

/** Extensions Chromium can natively decode in audio and video elements. */
export const BROWSER_NATIVE_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'opus', 'webm', 'aac', 'm4a',
  'mp4', 'mov', 'm4v', 'ogv', '3gp'
])

/** Video container extensions, as opposed to audio-only ones. */
export const VIDEO_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'asf', 'vob',
  'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv'
])

/** The lowercased extension of a file name or path. */
export function getExt(name: string): string
{
  return name.split('.').pop()?.toLowerCase() || ''
}

/**
 * Audio extensions the player serves without extraction. Every other file plays its sound through extraction,
 * and a seek far into an extracted file re-extracts from the seek point.
 */
export const DIRECT_AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'opus', 'aac', 'm4a'
])

const YT_REGEX = /(?:youtube\.com|youtu\.be)\//i

/** True for a YouTube address. */
export function isYouTubeUrl(url: string): boolean
{
  return YT_REGEX.test(url)
}

/** Seconds as m:ss, or h:mm:ss from an hour on; anything not a finite non-negative number reads 0:00. */
export function formatTime(sec: number): string
{
  if (!isFinite(sec) || sec < 0)
  {
    return '0:00'
  }
  const whole = Math.floor(sec)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A file's name from its path, with either separator. */
export function fileNameOf(path: string): string
{
  return path.split(/[\\/]/).pop() || path
}

/** True when a path's extension is one the player takes. */
export function isMediaPath(path: string): boolean
{
  return MEDIA_EXTS.includes(getExt(fileNameOf(path)))
}

let trackCounter = 0

/** A fresh playlist id. */
export function newTrackId(): string
{
  trackCounter += 1
  return `t-${Date.now().toString(36)}-${trackCounter}`
}

/** A playlist entry for a local file. */
export function trackFromPath(path: string): Track
{
  return { id: newTrackId(), name: fileNameOf(path), src: '', isBlob: false, filePath: path }
}

/** A playlist entry for a direct web address of a media file; its name is the decoded last path segment. */
export function trackFromAddress(url: string): Track
{
  const last = url.split('/').pop()?.split(/[?#]/)[0] || url
  let name = last
  try
  {
    name = decodeURIComponent(last)
  }
  catch
  {
    name = last
  }
  return { id: newTrackId(), name, src: url, isBlob: false }
}

/** The total of the known durations, and whether any track's length is still unknown; a live stream has none to learn. */
export function totalDuration(tracks: readonly Track[]): { seconds: number, complete: boolean }
{
  let seconds = 0
  let complete = true
  for (const track of tracks)
  {
    if (track.live === true)
    {
      continue
    }
    if (typeof track.duration === 'number' && Number.isFinite(track.duration))
    {
      seconds += track.duration
    }
    else
    {
      complete = false
    }
  }
  return { seconds, complete }
}
