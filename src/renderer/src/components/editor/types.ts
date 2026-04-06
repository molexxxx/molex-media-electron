/**
 * @module components/editor/types
 * @description Shared types, constants, and utilities for the media editor.
 */

export interface Clip {
  id: string
  name: string
  path: string
  objectUrl: string
  duration: number
  isVideo: boolean
  inPoint: number
  outPoint: number
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00.0'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 10)
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`
}

export type CutMode = 'fast' | 'precise'

export const OUTPUT_FORMATS = {
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'ts'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']
}

export const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus']
export const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'ts']
export const ALL_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

export const DISPOSITION_FLAGS = [
  'default', 'dub', 'original', 'comment', 'lyrics',
  'karaoke', 'forced', 'hearing_impaired', 'visual_impaired', 'descriptions'
]
