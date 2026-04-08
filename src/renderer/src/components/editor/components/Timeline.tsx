/**
 * @module components/editor/Timeline
 * @description Enhanced interactive timeline with scrubber, in/out handle dragging,
 * playback controls, volume/speed, keyboard shortcuts, and export options.
 */

import React, { type RefObject, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime, OUTPUT_FORMATS } from '../types'
import { Select } from '../../shared/ui'

interface TimelineProps {
  currentTime: number
  playing: boolean
  timelineRef: RefObject<HTMLDivElement | null>
  onTimelineMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void
  onTogglePlay: () => void
  onSetIn: () => void
  onSetOut: () => void
  onCut: () => void
  onBrowseOutputDir: () => void
}

export function Timeline({
  currentTime, playing,
  timelineRef, onTimelineMouseDown, onTogglePlay, onSetIn, onSetOut, onCut,
  onBrowseOutputDir
}: TimelineProps): React.JSX.Element {
  const {
    processing, exportProgress, message, cutMode, outputFormat, outputDir, gifOptions,
    volume, playbackRate,
    setCutMode, setOutputFormat, setOutputDir, setGifOptions, resetPoints, clipDuration,
    activeClip, setVolume, setPlaybackRate
  } = useEditorStore()

  const clip = activeClip()
  if (!clip) return <></>

  const duration = clipDuration()
  const srcExt = clip.name.split('.').pop()?.toLowerCase() || ''
  const formats = clip.isVideo ? OUTPUT_FORMATS.video : OUTPUT_FORMATS.audio

  // -- Keyboard shortcuts --
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      switch (e.code) {
        case 'Space': e.preventDefault(); onTogglePlay(); break
        case 'KeyI': e.preventDefault(); onSetIn(); break
        case 'KeyO': e.preventDefault(); onSetOut(); break
        case 'KeyR': if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); resetPoints() } break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onTogglePlay, onSetIn, onSetOut]) // eslint-disable-line react-hooks/exhaustive-deps

  const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

  return (
    <div className="shrink-0 glass-panel rounded-2xl px-4 sm:px-5 py-3.5 sm:py-4 space-y-3">
      {/* Scrubber bar */}
      <div
        ref={timelineRef}
        className="relative h-9 sm:h-11 bg-surface-900/80 rounded-xl cursor-pointer group select-none touch-none overflow-hidden"
        onMouseDown={onTimelineMouseDown}
      >
        {/* Selected region */}
        <div
          className="absolute top-0 bottom-0 scrubber-region border-y border-accent-500/10"
          style={{
            left: `${(clip.inPoint / clip.duration) * 100}%`,
            width: `${((clip.outPoint - clip.inPoint) / clip.duration) * 100}%`
          }}
        />
        {/* In-point handle */}
        <div
          className="absolute top-0 bottom-0 w-2 cursor-col-resize z-20 group/handle"
          style={{ left: `calc(${(clip.inPoint / clip.duration) * 100}% - 4px)` }}
        >
          <div className="absolute inset-y-0 left-[3px] w-[2px] bg-blue-400/80 group-hover/handle:bg-blue-300 transition-colors" />
          <div className="absolute top-0 left-0.5 w-1.5 h-3.5 bg-blue-400 rounded-b group-hover/handle:bg-blue-300 transition-colors" />
          <div className="absolute bottom-0 left-0.5 w-1.5 h-3.5 bg-blue-400 rounded-t group-hover/handle:bg-blue-300 transition-colors" />
        </div>
        {/* Out-point handle */}
        <div
          className="absolute top-0 bottom-0 w-2 cursor-col-resize z-20 group/handle"
          style={{ left: `calc(${(clip.outPoint / clip.duration) * 100}% - 4px)` }}
        >
          <div className="absolute inset-y-0 left-[3px] w-[2px] bg-emerald-400/80 group-hover/handle:bg-emerald-300 transition-colors" />
          <div className="absolute top-0 left-0.5 w-1.5 h-3.5 bg-emerald-400 rounded-b group-hover/handle:bg-emerald-300 transition-colors" />
          <div className="absolute bottom-0 left-0.5 w-1.5 h-3.5 bg-emerald-400 rounded-t group-hover/handle:bg-emerald-300 transition-colors" />
        </div>
        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white z-10 pointer-events-none"
          style={{ left: `${(currentTime / clip.duration) * 100}%` }}
        >
          <div className="absolute -top-0.5 -left-[5px] w-3 h-3 bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.4)]" />
          <div className="absolute inset-y-0 -left-px w-1 bg-white/20 blur-sm" />
        </div>
        {/* Time markers */}
        <div className="absolute bottom-0.5 left-0 right-0 hidden sm:flex justify-between px-1.5 pointer-events-none">
          {Array.from({ length: 11 }).map((_, i) => (
            <span key={i} className="text-[8px] text-surface-600/80 font-mono">
              {formatTime((clip.duration / 10) * i)}
            </span>
          ))}
        </div>
      </div>

      {/* Playback + in/out controls */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            className="w-9 h-9 rounded-full bg-accent-500/15 border border-accent-500/25 hover:bg-accent-500/25 hover:border-accent-500/35 flex items-center justify-center text-accent-200 transition-all shadow-sm"
            title="Play/Pause (Space)"
          >
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20" /></svg>
            )}
          </button>
          <span className="text-xs font-mono text-surface-300 tabular-nums">
            {formatTime(currentTime)} <span className="text-surface-600">/</span> {formatTime(clip.duration)}
          </span>

          {/* Volume control */}
          <div className="hidden sm:flex items-center gap-1.5 ml-1">
            <button
              onClick={() => setVolume(volume > 0 ? 0 : 1)}
              className="text-surface-400 hover:text-surface-200 transition-colors"
              title={volume > 0 ? 'Mute' : 'Unmute'}
            >
              {volume === 0 ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              ) : volume < 0.5 ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
              )}
            </button>
            <input
              type="range"
              min={0} max={1} step={0.05}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-16 range-dark"
              style={{ '--range-progress': `${volume * 100}%` } as React.CSSProperties}
              title={`Volume: ${Math.round(volume * 100)}%`}
            />
          </div>

          {/* Speed control */}
          <div className="hidden sm:flex items-center gap-1">
            <Select
              value={String(playbackRate)}
              onChange={(v) => setPlaybackRate(parseFloat(v))}
              options={SPEED_OPTIONS.map((s) => ({ value: String(s), label: `${s}x` }))}
              compact
              title="Playback speed"
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={onSetIn} className="px-2.5 py-1 text-2xs font-semibold rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/15 transition-all" title="Set In Point (I)">
            In [{formatTime(clip.inPoint)}]
          </button>
          <button onClick={onSetOut} className="px-2.5 py-1 text-2xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/15 transition-all" title="Set Out Point (O)">
            Out [{formatTime(clip.outPoint)}]
          </button>
          <button onClick={() => resetPoints()} className="px-2.5 py-1 text-2xs font-medium rounded-lg text-surface-400 hover:text-surface-200 bg-surface-800/60 hover:bg-surface-700/60 transition-all" title="Reset Points (R)">
            Reset
          </button>
          <div className="w-px h-5 bg-surface-700/50 mx-1 hidden sm:block" />
          <button
            onClick={onCut}
            disabled={processing || duration <= 0}
            className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-accent-500/15 text-accent-200 border border-accent-500/25 hover:bg-accent-500/25 hover:border-accent-500/35 transition-all shadow-sm"
          >
            {processing ? `Exporting${exportProgress > 0 ? ` ${exportProgress}%` : '...'}` : 'Export Clip'}
          </button>
        </div>
      </div>

      {/* Export options */}
      <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-surface-500 font-medium mr-0.5">Mode:</span>
          <div className="flex bg-white/[0.03] border border-white/[0.06] rounded-lg p-0.5 gap-0.5 backdrop-blur-sm">
            <button
              onClick={() => setCutMode('precise')}
              className={`px-2.5 py-1 rounded-md font-medium transition-all duration-200 ${
                cutMode === 'precise'
                  ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'
              }`}
              title="Re-encodes for frame-accurate cuts that match the preview exactly"
            >
              Precise
            </button>
            <button
              onClick={() => setCutMode('fast')}
              className={`px-2.5 py-1 rounded-md font-medium transition-all duration-200 ${
                cutMode === 'fast'
                  ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'
              }`}
              title="Stream-copy mode — fast but may snap to the nearest keyframe (±1-5s for video)"
            >
              Fast
            </button>
          </div>
        </div>
        <div className="w-px h-4 bg-surface-700/50 hidden sm:block" />
        <div className="flex items-center gap-1.5">
          <span className="text-surface-500 font-medium">Format:</span>
          <Select
            value={outputFormat}
            onChange={(v) => setOutputFormat(v)}
            options={[{ value: '', label: `Same as source (.${srcExt})` }, ...formats.map((fmt) => ({ value: fmt, label: `.${fmt}` }))]}
            compact
          />
        </div>
        {cutMode === 'fast' && clip.isVideo && outputFormat !== 'gif' && (
          <span className="text-yellow-500/60 text-2xs ml-auto">
            ⚠ Fast mode may not match preview exactly for video
          </span>
        )}
        {outputFormat === 'gif' && (
          <span className="text-amber-400/60 text-2xs ml-auto">
            GIF always uses precise mode
          </span>
        )}
      </div>

      {/* GIF options row */}
      {outputFormat === 'gif' && (
        <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={gifOptions.loop}
              onChange={(e) => setGifOptions({ loop: e.target.checked })}
              className="w-3.5 h-3.5 rounded border-surface-600 bg-surface-900 text-accent-500 focus:ring-accent-500/30 cursor-pointer"
            />
            <span className="text-surface-300">Loop</span>
          </label>
          <div className="w-px h-4 bg-surface-700/50" />
          <div className="flex items-center gap-1.5">
            <span className="text-surface-500 font-medium">FPS:</span>
            <input
              type="number"
              min={1}
              max={30}
              value={gifOptions.fps}
              onChange={(e) => setGifOptions({ fps: Math.max(1, Math.min(30, parseInt(e.target.value) || 15)) })}
              className="w-14 bg-surface-900/80 text-surface-200 rounded-lg px-2 py-1 text-xs border border-white/[0.06] hover:border-white/[0.1] focus:border-accent-500/50 outline-none transition-colors"
            />
          </div>
          <div className="w-px h-4 bg-surface-700/50" />
          <div className="flex items-center gap-1.5">
            <span className="text-surface-500 font-medium">Width:</span>
            <Select
              value={String(gifOptions.width)}
              onChange={(v) => setGifOptions({ width: parseInt(v) })}
              options={[
                { value: '320', label: '320px' },
                { value: '480', label: '480px' },
                { value: '640', label: '640px' },
                { value: '800', label: '800px' },
                { value: '-1', label: 'Original' }
              ]}
              compact
            />
          </div>
        </div>
      )}

      {/* Output directory row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-surface-500 font-medium shrink-0">Output:</span>
        <input
          type="text"
          value={outputDir}
          onChange={(e) => setOutputDir(e.target.value)}
          placeholder="Same as source"
          className="flex-1 bg-surface-900/80 text-surface-200 rounded-lg px-2.5 py-1.5 text-xs border border-white/[0.06] hover:border-white/[0.1] focus:border-accent-500/50 outline-none transition-colors truncate min-w-0"
        />
        <button
          onClick={onBrowseOutputDir}
          className="shrink-0 px-2.5 py-1.5 text-2xs font-medium rounded-lg text-surface-300 hover:text-surface-100 bg-surface-800/60 hover:bg-surface-700/60 border border-white/[0.06] transition-all"
          title="Browse for output directory"
        >
          Browse
        </button>
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="hidden sm:flex items-center gap-3 text-2xs text-surface-600 pt-0.5">
        <span><kbd className="kbd-key">Space</kbd> Play/Pause</span>
        <span><kbd className="kbd-key">I</kbd> Set In</span>
        <span><kbd className="kbd-key">O</kbd> Set Out</span>
        <span><kbd className="kbd-key">R</kbd> Reset</span>
      </div>

      {processing && exportProgress > 0 && (
        <div className="w-full h-1 bg-surface-900 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${exportProgress}%`, background: 'linear-gradient(90deg, var(--color-accent-600), var(--color-accent-400))' }}
          />
        </div>
      )}

      {message && (
        <div className={`text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-2 ${
          message.startsWith('Error')
            ? 'bg-red-500/[0.08] text-red-300 border border-red-500/10'
            : 'bg-emerald-500/[0.08] text-emerald-300 border border-emerald-500/10'
        }`}>
          {message.startsWith('Error') ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          )}
          {message}
        </div>
      )}
    </div>
  )
}
