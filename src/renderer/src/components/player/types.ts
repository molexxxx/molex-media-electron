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

export const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'webm', 'mp4']

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
