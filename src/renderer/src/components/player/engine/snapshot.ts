/**
 * The player's state as it moves between the main window and the pop-out: the playlist without per-process URLs,
 * the playing track and position, and the session choices. Reading accepts the shape earlier versions sent.
 */

import type { VisMode } from '../../../visualizations/types'
import type { PictureQuality, SoundQuality } from './links'
import type { RepeatMode } from './queue'
import type { Track } from '../types'

/** What the stage shows while the source has a picture. */
export type StageView = 'video' | 'visualization'

/** Everything the other window needs to carry on playing. */
export interface PlayerSnapshot
{
  playlist: Track[]
  currentId: string | null
  currentTime: number
  playing: boolean
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  visMode: VisMode
  view: StageView
  soundQuality: SoundQuality
  pictureQuality: PictureQuality
  subtitleIndex: number | null
}

const VIS_MODES: readonly VisMode[] = ['dmt', 'space', 'milkdrop', 'plasma', 'bars', 'wave', 'horizon', 'rain']

/** The playlist as another process can use it: blob and proxy URLs are per process, so they are cleared. */
export function portableTracks(tracks: readonly Track[]): Track[]
{
  return tracks.map((track) => ({ ...track, src: track.isBlob || track.videoUrl !== undefined || track.filePath !== undefined ? '' : track.src }))
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T
{
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

function finite(value: unknown, fallback: number): number
{
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Reads a snapshot from the other window, filling anything missing; null when it carries no playlist. */
export function readSnapshot(raw: unknown): PlayerSnapshot | null
{
  if (typeof raw !== 'object' || raw === null)
  {
    return null
  }
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.playlist))
  {
    return null
  }
  const playlist = portableTracks((value.playlist as Track[]).filter((track) => typeof track?.id === 'string' && typeof track?.name === 'string'))
  const legacyIndex = typeof value.trackIdx === 'number' ? value.trackIdx : -1
  const currentId = typeof value.currentId === 'string' && playlist.some((track) => track.id === value.currentId)
    ? value.currentId
    : legacyIndex >= 0 && legacyIndex < playlist.length ? playlist[legacyIndex].id : null
  return {
    playlist,
    currentId,
    currentTime: Math.max(0, finite(value.currentTime, 0)),
    playing: value.playing !== false,
    volume: Math.min(1, Math.max(0, finite(value.volume, 0.8))),
    muted: value.muted === true,
    shuffle: value.shuffle === true,
    repeat: pick(value.repeat, ['off', 'all', 'one'] as const, 'off'),
    visMode: pick(value.visMode, VIS_MODES, 'dmt'),
    view: pick(value.view, ['video', 'visualization'] as const, 'video'),
    soundQuality: pick(value.soundQuality ?? value.audioQuality, ['best', 'good', 'low'] as const, 'best'),
    pictureQuality: pick(value.pictureQuality, ['auto', '1080p', '720p', '480p'] as const, 'auto'),
    subtitleIndex: typeof value.subtitleIndex === 'number' ? value.subtitleIndex : null
  }
}
