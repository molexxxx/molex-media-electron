/** @module editor/shared/TimeDisplay - Timecode display component. */
import React from 'react'

/** Format a frame number as HH:MM:SS:FF timecode. */
export function formatTimecode(frame: number, frameRate: number): string {
  if (!frameRate || frameRate <= 0) return '00:00:00:00'
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

/** Format a frame number as HH:MM:SS.mmm wall-clock time. */
export function formatTime(frame: number, frameRate: number): string {
  if (!frameRate || frameRate <= 0) return '00:00:00.000'
  const seconds = Math.max(0, frame / frameRate)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  return `${pad2(h)}:${pad2(m)}:${pad2(Math.floor(s))}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`
}

/** Convert seconds to frame number. */
export function secondsToFrames(seconds: number, frameRate: number): number {
  return Math.round(seconds * frameRate)
}

/** Convert frame number to seconds. */
export function framesToSeconds(frames: number, frameRate: number): number {
  return frameRate > 0 ? frames / frameRate : 0
}

interface TimeDisplayProps {
  frame: number
  frameRate: number
  label?: string
  format?: 'timecode' | 'time'
  className?: string
}

export function TimeDisplay({ frame, frameRate, label, format = 'timecode', className = '' }: TimeDisplayProps): React.JSX.Element {
  const text = format === 'timecode' ? formatTimecode(frame, frameRate) : formatTime(frame, frameRate)
  return (
    <span className={`font-mono text-xs tabular-nums ${className}`}>
      {label && <span className="text-surface-500 mr-1">{label}</span>}
      {text}
    </span>
  )
}
