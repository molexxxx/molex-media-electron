/**
 * @module renderer/utils/recentFiles
 * Tiny localStorage-backed registry of recently opened media files.
 * Used by the Media Editor launcher to show a "Recent" row.
 */

const KEY = 'molex.recentMedia.v1'
const MAX = 12

export interface RecentFile {
  filePath: string
  fileName: string
  openedAt: number
  /** Cached on first probe; optional. */
  durationSec?: number
  width?: number
  height?: number
  /** 'video' | 'audio' | 'image' | 'unknown' */
  kind?: string
}

function read(): RecentFile[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.filePath === 'string') : []
  } catch {
    return []
  }
}

function write(list: RecentFile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* quota or disabled — ignore */
  }
}

export function getRecentFiles(): RecentFile[] {
  return read()
}

export function addRecentFile(entry: RecentFile): void {
  const list = read().filter((x) => x.filePath !== entry.filePath)
  list.unshift({ ...entry, openedAt: Date.now() })
  write(list)
  window.dispatchEvent(new CustomEvent('molex:recents-changed'))
}

export function removeRecentFile(filePath: string): void {
  write(read().filter((x) => x.filePath !== filePath))
  window.dispatchEvent(new CustomEvent('molex:recents-changed'))
}

export function clearRecentFiles(): void {
  write([])
  window.dispatchEvent(new CustomEvent('molex:recents-changed'))
}

export function classifyFile(fileName: string, hasVideo: boolean, hasAudio: boolean): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) return 'image'
  if (hasVideo) return 'video'
  if (hasAudio) return 'audio'
  return 'unknown'
}
