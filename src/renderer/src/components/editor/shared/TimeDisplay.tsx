/**
 * @module editor/shared/TimeDisplay
 * Timecode math and the lit readout the editor shows positions and lengths in.
 */
import type { ReactElement } from 'react'
import { cx } from '../../../ui/cx'

/** A frame number as HH:MM:SS:FF timecode. */
export function formatTimecode(frame: number, frameRate: number): string
{
  if (!frameRate || frameRate <= 0)
  {
    return '00:00:00:00'
  }
  const totalFrames = Math.max(0, Math.round(frame))
  const fps = Math.round(frameRate)
  const f = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`
}

/** A frame number as HH:MM:SS.mmm clock time. */
export function formatTime(frame: number, frameRate: number): string
{
  if (!frameRate || frameRate <= 0)
  {
    return '00:00:00.000'
  }
  const seconds = Math.max(0, frame / frameRate)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  return `${pad2(h)}:${pad2(m)}:${pad2(Math.floor(s))}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`
}

/** Seconds as a frame number. */
export function secondsToFrames(seconds: number, frameRate: number): number
{
  return Math.round(seconds * frameRate)
}

/** A frame number as seconds. */
export function framesToSeconds(frames: number, frameRate: number): number
{
  return frameRate > 0 ? frames / frameRate : 0
}

/** Props of {@link Readout}. */
export interface ReadoutProps
{
  label: string
  value: string
  /** Draws the value lit in accent ink; a quiet readout uses primary ink. */
  lit?: boolean
  className?: string
}

/** A small caption over a timecode or length, lit for the values the user is setting. */
export function Readout({ label, value, lit = true, className }: ReadoutProps): ReactElement
{
  return (
    <div className={cx('flex min-w-0 flex-col', className)}>
      <span className="text-label text-ink-3">{label}</span>
      <span className={cx('text-body font-semibold tabular-nums', lit ? 'type-readout' : 'text-ink')}>{value}</span>
    </div>
  )
}
