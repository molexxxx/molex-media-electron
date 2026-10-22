/**
 * Playlist order: the next or previous track with shuffle and repeat, and reordering by the grid's move commands and
 * pointer drops. Tracks are named by id, so the playing track stays itself through every reorder.
 */

import { moveGridRows, type GridMoveTo } from '../../../ui/DataGrid'
import type { Track } from '../types'

/** How the playlist repeats. */
export type RepeatMode = 'off' | 'all' | 'one'

/** The next repeat mode in the button's cycle: off, all, one. */
export function nextRepeat(mode: RepeatMode): RepeatMode
{
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
}

/**
 * The track after (or before) `currentId`. Shuffle picks any other track at random; in order, the list wraps. With
 * no current track the first (or last) plays. Null for an empty list.
 */
export function stepTrack(ids: readonly string[], currentId: string | null, direction: 1 | -1, shuffle: boolean, random: () => number = Math.random): string | null
{
  if (ids.length === 0)
  {
    return null
  }
  const at = currentId === null ? -1 : ids.indexOf(currentId)
  if (shuffle && ids.length > 1)
  {
    const others = ids.filter((_, i) => i !== at)
    return others[Math.min(others.length - 1, Math.floor(random() * others.length))]
  }
  if (at < 0)
  {
    return direction === 1 ? ids[0] : ids[ids.length - 1]
  }
  return ids[(at + direction + ids.length) % ids.length]
}

/** What plays when a track ends: the same track on repeat one, the next one, or nothing at the end without repeat. */
export function afterEnd(ids: readonly string[], currentId: string | null, repeat: RepeatMode, shuffle: boolean, random?: () => number): string | null
{
  if (currentId === null)
  {
    return null
  }
  if (repeat === 'one')
  {
    return currentId
  }
  const last = ids.indexOf(currentId) === ids.length - 1
  if (last && repeat === 'off' && !shuffle)
  {
    return null
  }
  return stepTrack(ids, currentId, 1, shuffle, random)
}

/** The tracks in a new id order; ids missing from the order keep their place at the end. */
export function reorderTracks(tracks: readonly Track[], order: readonly string[]): Track[]
{
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const placed = order.map((id) => byId.get(id)).filter((track): track is Track => track !== undefined)
  const rest = tracks.filter((track) => !order.includes(track.id))
  return [...placed, ...rest]
}

/** The tracks after the grid moves `ids` up, down, to the top, or to the bottom. */
export function moveTracks(tracks: readonly Track[], ids: readonly string[], to: GridMoveTo): Track[]
{
  return reorderTracks(tracks, moveGridRows(tracks.map((track) => track.id), ids, to))
}

/** The tracks after a pointer drop puts `ids`, in their current order, before `before`, or at the end when null. */
export function dropTracks(tracks: readonly Track[], ids: readonly string[], before: string | null): Track[]
{
  const moving = new Set(ids)
  const picked = tracks.filter((track) => moving.has(track.id))
  const rest = tracks.filter((track) => !moving.has(track.id))
  const at = before === null ? rest.length : rest.findIndex((track) => track.id === before)
  const index = at < 0 ? rest.length : at
  return [...rest.slice(0, index), ...picked, ...rest.slice(index)]
}
