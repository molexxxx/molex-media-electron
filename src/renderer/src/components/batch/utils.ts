/**
 * @module components/batch/utils
 * @description Display formatters and extension helpers for the file queue.
 */

import type { FileItem } from '../../stores/types'

export const formatSize = (bytes: number): string => {
  if (!bytes) return '-'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export const formatDuration = (sec: string | undefined): string => {
  if (!sec) return '-'
  const s = parseFloat(sec)
  if (!s || s <= 0) return '-'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
  return `${m}:${ss.toString().padStart(2, '0')}`
}

export const formatCodecInfo = (file: FileItem): string => {
  const parts: string[] = []
  if (file.videoCodec) {
    let vc = file.videoCodec.toUpperCase()
    if (file.width && file.height) vc += ` ${file.width}x${file.height}`
    parts.push(vc)
  }
  if (file.audioCodec) {
    let ac = file.audioCodec.toUpperCase()
    if (file.channels) ac += ` ${file.channels}ch`
    parts.push(ac)
  }
  return parts.join(' · ') || '-'
}

export const extColor = (ext: string): string => {
  const video = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']
  const lossless = ['.flac', '.wav']
  if (video.includes(ext)) return 'text-blue-400'
  if (lossless.includes(ext)) return 'text-emerald-400'
  return 'text-amber-400'
}

export const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts'])
