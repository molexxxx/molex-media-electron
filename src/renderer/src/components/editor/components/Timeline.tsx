/**
 * @module components/editor/Timeline
 * @description Interactive timeline with scrubber, in/out handle dragging, and playback controls.
 */

import React, { type RefObject } from 'react'
import type { Clip, CutMode } from '../types'
import { formatTime, OUTPUT_FORMATS } from '../types'

interface TimelineProps {
  clip: Clip
  currentTime: number
  playing: boolean
  processing: boolean
  clipDuration: number
  message: string
  cutMode: CutMode
  outputFormat: string
  timelineRef: RefObject<HTMLDivElement | null>
  onTimelineMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onTogglePlay: () => void
  onSetIn: () => void
  onSetOut: () => void
  onResetPoints: () => void
  onCut: () => void
  onSetCutMode: (mode: CutMode) => void
  onSetOutputFormat: (fmt: string) => void
}

export function Timeline({
  clip, currentTime, playing, processing, clipDuration, message,
  cutMode, outputFormat,
  timelineRef, onTimelineMouseDown, onTogglePlay, onSetIn, onSetOut, onResetPoints, onCut,
  onSetCutMode, onSetOutputFormat
}: TimelineProps): React.JSX.Element {
  const srcExt = clip.name.split('.').pop()?.toLowerCase() || ''
  const formats = clip.isVideo ? OUTPUT_FORMATS.video : OUTPUT_FORMATS.audio
  return (
    <div className="shrink-0 glass rounded-xl px-5 py-4 space-y-3">
      <div
        ref={timelineRef}
        className="relative h-10 bg-surface-800 rounded-lg cursor-pointer group select-none"
        onMouseDown={onTimelineMouseDown}
      >
        <div
          className="absolute top-0 bottom-0 bg-accent-500/15"
          style={{
            left: `${(clip.inPoint / clip.duration) * 100}%`,
            width: `${((clip.outPoint - clip.inPoint) / clip.duration) * 100}%`
          }}
        />
        {/* In-point handle */}
        <div
          className="absolute top-0 bottom-0 w-1.5 cursor-col-resize z-20 group/handle"
          style={{ left: `calc(${(clip.inPoint / clip.duration) * 100}% - 3px)` }}
        >
          <div className="absolute inset-y-0 left-[2px] w-[2px] bg-blue-400 group-hover/handle:bg-blue-300 transition-colors" />
          <div className="absolute top-0 left-0 w-1.5 h-3 bg-blue-400 rounded-b-sm group-hover/handle:bg-blue-300 transition-colors" />
          <div className="absolute bottom-0 left-0 w-1.5 h-3 bg-blue-400 rounded-t-sm group-hover/handle:bg-blue-300 transition-colors" />
        </div>
        {/* Out-point handle */}
        <div
          className="absolute top-0 bottom-0 w-1.5 cursor-col-resize z-20 group/handle"
          style={{ left: `calc(${(clip.outPoint / clip.duration) * 100}% - 3px)` }}
        >
          <div className="absolute inset-y-0 left-[2px] w-[2px] bg-emerald-400 group-hover/handle:bg-emerald-300 transition-colors" />
          <div className="absolute top-0 left-0 w-1.5 h-3 bg-emerald-400 rounded-b-sm group-hover/handle:bg-emerald-300 transition-colors" />
          <div className="absolute bottom-0 left-0 w-1.5 h-3 bg-emerald-400 rounded-t-sm group-hover/handle:bg-emerald-300 transition-colors" />
        </div>
        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.5)] z-10 pointer-events-none"
          style={{ left: `${(currentTime / clip.duration) * 100}%` }}
        >
          <div className="absolute -top-1 -left-1.5 w-3.5 h-2.5 bg-white rounded-sm" />
        </div>
        {/* Time markers */}
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-1 pointer-events-none">
          {Array.from({ length: 11 }).map((_, i) => (
            <span key={i} className="text-[8px] text-surface-600 font-mono">
              {formatTime((clip.duration / 10) * i)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onTogglePlay}
            className="w-9 h-9 rounded-full bg-accent-600 hover:bg-accent-500 flex items-center justify-center text-white transition-all shadow-glow hover:shadow-glow-lg"
          >
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
            )}
          </button>
          <span className="text-xs font-mono text-surface-300 min-w-[70px]">
            {formatTime(currentTime)} / {formatTime(clip.duration)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={onSetIn} className="px-2.5 py-1 text-2xs font-semibold rounded-md bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 transition-all" title="Set In Point">
            In [{formatTime(clip.inPoint)}]
          </button>
          <button onClick={onSetOut} className="px-2.5 py-1 text-2xs font-semibold rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20 transition-all" title="Set Out Point">
            Out [{formatTime(clip.outPoint)}]
          </button>
          <button onClick={onResetPoints} className="px-2.5 py-1 text-2xs font-medium rounded-md text-surface-400 hover:text-surface-200 bg-surface-700/50 hover:bg-surface-600/50 transition-all">
            Reset
          </button>
          <div className="w-px h-5 bg-surface-700 mx-1" />
          <button
            onClick={onCut}
            disabled={processing || clipDuration <= 0}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 disabled:opacity-40 text-white shadow-glow hover:shadow-glow-lg transition-all"
          >
            {processing ? 'Exporting...' : 'Export Clip'}
          </button>
        </div>
      </div>

      {/* Export options row */}
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-surface-500 font-medium">Mode:</span>
          <button
            onClick={() => onSetCutMode('precise')}
            className={`px-2 py-0.5 rounded-md font-medium transition-all ${
              cutMode === 'precise'
                ? 'bg-accent-600/20 text-accent-400 border border-accent-500/30'
                : 'text-surface-400 hover:text-surface-200 bg-surface-700/50 hover:bg-surface-600/50'
            }`}
            title="Re-encodes for frame-accurate cuts that match the preview exactly"
          >
            Precise
          </button>
          <button
            onClick={() => onSetCutMode('fast')}
            className={`px-2 py-0.5 rounded-md font-medium transition-all ${
              cutMode === 'fast'
                ? 'bg-accent-600/20 text-accent-400 border border-accent-500/30'
                : 'text-surface-400 hover:text-surface-200 bg-surface-700/50 hover:bg-surface-600/50'
            }`}
            title="Stream-copy mode — fast but may snap to the nearest keyframe (±1-5s for video)"
          >
            Fast
          </button>
        </div>
        <div className="w-px h-4 bg-surface-700" />
        <div className="flex items-center gap-1.5">
          <span className="text-surface-500 font-medium">Format:</span>
          <select
            value={outputFormat}
            onChange={(e) => onSetOutputFormat(e.target.value)}
            className="bg-surface-800 text-surface-200 rounded-md px-2 py-0.5 text-xs border border-surface-700 hover:border-surface-600 focus:border-accent-500 outline-none transition-colors cursor-pointer"
          >
            <option value="">Same as source (.{srcExt})</option>
            {formats.map((fmt) => (
              <option key={fmt} value={fmt}>.{fmt}</option>
            ))}
          </select>
        </div>
        {cutMode === 'fast' && clip.isVideo && (
          <span className="text-yellow-500/70 text-2xs ml-auto">
            ⚠ Fast mode may not match preview exactly for video
          </span>
        )}
      </div>

      {message && (
        <div className={`text-xs px-3 py-2 rounded-lg ${
          message.startsWith('Error') ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'
        }`}>
          {message}
        </div>
      )}
    </div>
  )
}
