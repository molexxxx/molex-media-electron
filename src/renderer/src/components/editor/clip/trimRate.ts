/**
 * @module editor/clip/trimRate
 * Trim counts a file in its own frames so it steps and cuts on real frames; the timeline counts every source at the
 * project rate. These convert between the two.
 */
import type { MediaSource } from '../types'

type RatedSource = Pick<MediaSource, 'frameRate' | 'nativeFrameRate' | 'durationSeconds'>

/** The frame rate Trim counts a source in: the file's own rate when it has one, otherwise the project rate. */
export function trimRate(source: RatedSource): number
{
  return source.nativeFrameRate || source.frameRate
}

/** A source's length in Trim frames. */
export function trimLength(source: RatedSource): number
{
  return Math.round(source.durationSeconds * trimRate(source))
}

/** A Trim frame as a timeline source frame, so a range marked in Trim keeps its length on the timeline. */
export function toTimelineFrame(frame: number, source: RatedSource): number
{
  return Math.round((frame * source.frameRate) / trimRate(source))
}
