/**
 * @module components/player/types
 * @description Shared types and constants for the media player.
 */

export interface Track {
  id: string
  name: string
  src: string
  isBlob: boolean
  videoUrl?: string
  filePath?: string
}

export const MEDIA_EXTS = [
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus',
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v',
  'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv'
]

/** Extensions Chromium can natively decode in <audio>/<video> elements */
export const BROWSER_NATIVE_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'opus', 'webm', 'aac', 'm4a',
  'mp4', 'mov', 'm4v', 'ogv', '3gp'
])

/** Video container extensions (as opposed to audio-only) */
export const VIDEO_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v',
  'ts', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv'
])

/** Get file extension from a filename */
export function getExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

/**
 * Audio extensions the player serves directly without FFmpeg extraction.
 * Files NOT in this set go through extraction; seeking on those extracted
 * files may fail, requiring seek-extraction (re-extract from a time offset).
 */
export const DIRECT_AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'flac', 'opus', 'aac', 'm4a'
])

const YT_REGEX = /(?:youtube\.com|youtu\.be)\//i

export function isYouTubeUrl(url: string): boolean {
  return YT_REGEX.test(url)
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
