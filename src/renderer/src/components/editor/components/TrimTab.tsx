/**
 * @module components/editor/components/TrimTab
 * @description Trim-mode content — preview area with video/canvas, clip sidebar,
 * interactive timeline with in/out handles, and export controls.
 */

import React, { type RefObject } from 'react'
import { type Clip, formatTime } from '../types'

interface TrimTabProps {
  clip: Clip | null
  clips: Clip[]
  activeIdx: number
  playing: boolean
  currentTime: number
  dragging: boolean
  processing: boolean
  message: string
  clipDuration: number
  videoRef: RefObject<HTMLVideoElement | null>
  audioRef: RefObject<HTMLAudioElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  timelineRef: RefObject<HTMLDivElement | null>
  dragCounterRef: RefObject<number>
  onSetActiveIdx: (idx: number) => void
  onDrop: (e: React.DragEvent) => void
  onSetDragging: (v: boolean) => void
  onMerge: () => void
  onRemoveClip: (idx: number) => void
  onTogglePlay: () => void
  onTimelineMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onSetIn: () => void
  onSetOut: () => void
  onResetPoints: () => void
  onCut: () => void
}

export function TrimTab({
  clip, clips, activeIdx, playing, currentTime, dragging, processing, message,
  clipDuration, videoRef, audioRef, canvasRef, timelineRef, dragCounterRef,
  onSetActiveIdx, onDrop, onSetDragging, onMerge, onRemoveClip,
  onTogglePlay, onTimelineMouseDown, onSetIn, onSetOut, onResetPoints, onCut
}: TrimTabProps): React.JSX.Element {
  return (
    <>
      {/* Main area: Preview + Clip List */}
      {clip ? (
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Preview */}
        <div
          className={`flex-1 relative rounded-2xl overflow-hidden border transition-all duration-300 ${
            dragging ? 'border-accent-400 bg-accent-500/[0.04]' : 'border-dashed border-white/[0.06] bg-white/[0.02]'
          }`}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; onSetDragging(true) }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDragLeave={(e) => { e.stopPropagation(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; onSetDragging(false) } }}
          onDrop={onDrop}
        >
          {clip.isVideo && (
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              playsInline
              preload="auto"
              muted={false}
            />
          )}
          {!clip.isVideo && (
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          )}
          {dragging && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-accent-500/[0.06] backdrop-blur-sm z-10">
              <div className="w-12 h-12 mb-3 rounded-full border-2 border-dashed border-accent-400/60 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-300">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <p className="text-accent-300 font-semibold">Drop to add</p>
            </div>
          )}
          <audio ref={audioRef} className="hidden" />
        </div>

        {/* Clip list sidebar */}
        {clips.length > 0 && (
          <div className="w-52 shrink-0 glass rounded-xl p-3 flex flex-col gap-2 overflow-auto">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">Clips ({clips.length})</span>
              {clips.length >= 2 && (
                <button
                  onClick={onMerge}
                  disabled={processing}
                  className="text-2xs font-semibold text-accent-400 hover:text-accent-300 disabled:opacity-40 transition-colors"
                >
                  Merge All
                </button>
              )}
            </div>
            {clips.map((c, i) => (
              <button
                key={c.id}
                onClick={() => onSetActiveIdx(i)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                  i === activeIdx
                    ? 'bg-accent-500/15 text-accent-300 border border-accent-500/20'
                    : 'text-surface-300 hover:bg-surface-700/50 border border-transparent'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-medium">{c.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveClip(i) }}
                    className="text-surface-500 hover:text-red-400 transition-colors shrink-0"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="text-2xs text-surface-500 mt-0.5 font-mono">
                  {formatTime(c.inPoint)} → {formatTime(c.outPoint)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      ) : (
      <div
        className="flex-1 flex items-center justify-center h-64 rounded-2xl border border-dashed border-white/[0.06] bg-white/[0.02]"
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounterRef.current++; onSetDragging(true) }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        onDragLeave={(e) => { e.stopPropagation(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; onSetDragging(false) } }}
        onDrop={onDrop}
      >
        {dragging ? (
          <div className="flex flex-col items-center justify-center">
            <div className="w-12 h-12 mb-3 rounded-full border-2 border-dashed border-accent-400/60 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-300">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <p className="text-accent-300 font-semibold">Drop to add</p>
          </div>
        ) : (
          <div className="text-center px-4">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.03] flex items-center justify-center border border-white/[0.04]">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-surface-500">
                <path d="M15.6 11.6L22 7v10l-6.4-4.6" />
                <rect x="2" y="6" width="14" height="12" rx="2" />
              </svg>
            </div>
            <p className="text-surface-400 text-sm font-medium">Drop media files here</p>
            <p className="text-surface-600 text-2xs mt-1.5">or use <span className="text-accent-400/80">+ Add</span> above</p>
          </div>
        )}
        <audio ref={audioRef} className="hidden" />
      </div>
      )}

      {/* Timeline */}
      {clip && (
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
                className="w-9 h-9 rounded-full bg-accent-500/20 hover:bg-accent-500/30 border border-accent-500/25 flex items-center justify-center text-accent-300 transition-all"
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
                className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-accent-500/15 hover:bg-accent-500/25 disabled:opacity-40 text-accent-300 border border-accent-500/20 hover:border-accent-500/30 transition-all"
              >
                {processing ? 'Exporting...' : 'Export Clip'}
              </button>
            </div>
          </div>

          {message && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              message.startsWith('Error') ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'
            }`}>
              {message}
            </div>
          )}
        </div>
      )}
    </>
  )
}
