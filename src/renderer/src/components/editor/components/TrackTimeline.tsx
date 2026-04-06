/**
 * @module components/editor/TrackTimeline
 * @description Unified NLE-style timeline: timecode ruler, V1 video track, A1 source
 * audio, optional A2 replacement audio, draggable playhead with in/out handles,
 * transport controls, and export options. Replaces both the old TrackTimeline and Timeline.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime, OUTPUT_FORMATS } from '../types'

interface TrackTimelineProps {
  currentTime: number
  playing: boolean
  onSeek: (time: number) => void
  onTogglePlay: () => void
  onSetIn: () => void
  onSetOut: () => void
  onCut: () => void
  onMerge: () => void
  onReplaceAudio: (clipId: string) => void
  onBrowseOutputDir: () => void
  onImportFile: () => void
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

/** Generate evenly-spaced timecode marks. */
function rulerMarks(totalDur: number): { pct: number; label: string }[] {
  if (totalDur <= 0) return []
  let interval: number
  if (totalDur <= 5) interval = 1
  else if (totalDur <= 15) interval = 2
  else if (totalDur <= 30) interval = 5
  else if (totalDur <= 120) interval = 10
  else if (totalDur <= 300) interval = 30
  else interval = 60
  const out: { pct: number; label: string }[] = []
  for (let t = 0; t <= totalDur + 0.01; t += interval) {
    out.push({ pct: (t / totalDur) * 100, label: formatTime(t) })
  }
  return out
}

export function TrackTimeline({
  currentTime, playing, onSeek, onTogglePlay, onSetIn, onSetOut, onCut,
  onMerge, onReplaceAudio, onBrowseOutputDir, onImportFile
}: TrackTimelineProps): React.JSX.Element {
  const {
    clips, activeIdx, processing, exportProgress, message, cutMode, outputFormat,
    outputDir, gifOptions, volume, playbackRate,
    setActiveIdx, moveClip, canMerge, removeClip, setAudioOffset,
    setCutMode, setOutputFormat, setOutputDir, setGifOptions, resetPoints,
    setVolume, setPlaybackRate, setClipVolume, toggleClipMute,
    setA2Volume, toggleA2Mute, setClipInPoint, setClipOutPoint,
    activeClip, clipDuration
  } = useEditorStore()

  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const trackAreaRef = useRef<HTMLDivElement>(null)

  /* ---- trim handle state ---- */
  const trimRef = useRef<{
    clipId: string; edge: 'left' | 'right'
    startX: number; startIn: number; startOut: number; dur: number; secPerPx: number
  } | null>(null)
  const [trimEdge, setTrimEdge] = useState<string | null>(null)

  const clip = activeClip()
  const duration = clipDuration()

  /* ---- sequence metrics ---- */
  const totalDur = clips.reduce((acc, c) => acc + (c.outPoint - c.inPoint), 0)
  const hasReplacementAudio = clips.some((c) => c.audioReplacement)
  // A1 always shown — video clips have source audio, audio clips are audio-only
  const hasAudioTrack = clips.length > 0

  // Cumulative start-time of each clip in merge sequence
  const clipStarts: number[] = []
  let cum = 0
  for (const c of clips) { clipStarts.push(cum); cum += c.outPoint - c.inPoint }

  // Playhead position as percentage
  const active = clips[activeIdx]
  const seqTime = active
    ? clipStarts[activeIdx] + Math.max(0, Math.min(currentTime - active.inPoint, active.outPoint - active.inPoint))
    : 0
  const playheadPct = totalDur > 0 ? Math.min(100, (seqTime / totalDur) * 100) : 0
  const marks = rulerMarks(totalDur)

  // In/out bracket positions for the active clip
  const activeSegDur = active ? active.outPoint - active.inPoint : 0
  const inBracketPct = totalDur > 0 && active ? (clipStarts[activeIdx] / totalDur) * 100 : 0
  const outBracketPct = totalDur > 0 && active ? ((clipStarts[activeIdx] + activeSegDur) / totalDur) * 100 : 100

  const srcExt = clip?.name.split('.').pop()?.toLowerCase() || ''
  const formats = clip?.isVideo ? OUTPUT_FORMATS.video : OUTPUT_FORMATS.audio

  /* ---- scrub: click/drag on ruler or tracks ---- */
  const scrubFromEvent = useCallback((e: MouseEvent | React.MouseEvent): void => {
    const area = trackAreaRef.current
    if (!area || clips.length === 0) return
    const rect = area.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const seqT = pct * totalDur

    // Find which clip this falls into
    for (let i = 0; i < clips.length; i++) {
      const segDur = clips[i].outPoint - clips[i].inPoint
      if (seqT <= clipStarts[i] + segDur || i === clips.length - 1) {
        if (i !== activeIdx) setActiveIdx(i)
        const localT = clips[i].inPoint + Math.max(0, Math.min(segDur, seqT - clipStarts[i]))
        onSeek(localT)
        break
      }
    }
  }, [clips, clipStarts, totalDur, activeIdx, setActiveIdx, onSeek])

  const handleRulerMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    scrubFromEvent(e)
    const onMove = (me: MouseEvent): void => scrubFromEvent(me)
    const onUp = (): void => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [scrubFromEvent])

  /* ---- keyboard shortcuts ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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

  /* ---- drag-to-reorder ---- */
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx))
  }, [])
  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropIdx(idx)
  }, [])
  const handleDrop = useCallback((e: React.DragEvent, toIdx: number) => {
    e.preventDefault(); if (dragIdx !== null && dragIdx !== toIdx) moveClip(dragIdx, toIdx); setDragIdx(null); setDropIdx(null)
  }, [dragIdx, moveClip])
  const handleDragEnd = useCallback(() => { setDragIdx(null); setDropIdx(null) }, [])

  /* ---- trim handles: drag clip edges to adjust in/out points ---- */
  const handleTrimStart = useCallback((e: React.MouseEvent, clipId: string, edge: 'left' | 'right', clipIdx: number) => {
    e.preventDefault()
    e.stopPropagation()
    const area = trackAreaRef.current
    if (!area) return
    const c = clips.find((cl) => cl.id === clipId)
    if (!c) return
    if (clipIdx !== activeIdx) setActiveIdx(clipIdx)
    const trackWidth = area.getBoundingClientRect().width
    trimRef.current = {
      clipId, edge, startX: e.clientX,
      startIn: c.inPoint, startOut: c.outPoint,
      dur: c.duration, secPerPx: totalDur / trackWidth
    }
    setTrimEdge(`${clipId}-${edge}`)
  }, [clips, activeIdx, setActiveIdx, totalDur])

  useEffect(() => {
    if (!trimEdge) return
    const onMove = (e: MouseEvent): void => {
      const t = trimRef.current
      if (!t) return
      const deltaSec = (e.clientX - t.startX) * t.secPerPx
      if (t.edge === 'left') {
        setClipInPoint(t.clipId, t.startIn + deltaSec)
      } else {
        setClipOutPoint(t.clipId, t.startOut + deltaSec)
      }
    }
    const onUp = (): void => { trimRef.current = null; setTrimEdge(null) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [trimEdge, setClipInPoint, setClipOutPoint])

  if (clips.length === 0) return <></>

  return (
    <div className="glass-panel rounded-2xl overflow-hidden select-none shrink-0">
      {/* ========== TRACK AREA ========== */}
      <div className="flex">
        {/* Track labels */}
        <div className="w-11 shrink-0 bg-surface-900/40 border-r border-white/5">
          <div className="h-5" />
          <div className="h-11 flex items-center justify-center border-t border-white/5">
            <div className="flex flex-col items-center gap-0.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400/70">
                <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
              <span className="text-[8px] font-bold text-blue-400/70 tracking-wide">V1</span>
            </div>
          </div>
          {hasAudioTrack && (
            <div className="h-8 flex items-center justify-center border-t border-white/5">
              <div className="flex flex-col items-center gap-px">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400/70">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/>
                </svg>
                <span className="text-[7px] font-bold text-green-400/70 tracking-wide">A1</span>
              </div>
            </div>
          )}
          {hasReplacementAudio && (
            <div className="h-8 flex items-center justify-center border-t border-white/5">
              <div className="flex flex-col items-center gap-px">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400/70">
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
                <span className="text-[7px] font-bold text-amber-400/70 tracking-wide">A2</span>
              </div>
            </div>
          )}
        </div>

        {/* Timeline content area */}
        <div ref={trackAreaRef} className="flex-1 min-w-0 relative">
          {/* Timecode ruler — clickable for scrubbing */}
          <div
            className="h-5 relative border-b border-white/5 bg-surface-950/40 cursor-pointer"
            onMouseDown={handleRulerMouseDown}
          >
            {marks.map((m, i) => (
              <div key={i} className="absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none" style={{ left: `${m.pct}%` }}>
                <div className="w-px h-2 bg-surface-600/60" />
                {i < marks.length - 1 && (
                  <span className="absolute bottom-0.5 left-1 text-[7px] text-surface-600 font-mono whitespace-nowrap">
                    {m.label}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* V1 — Video / Media */}
          <div
            className="h-11 flex border-t border-white/5 bg-surface-950/20 cursor-pointer"
            onDragOver={(e) => e.preventDefault()}
            onMouseDown={handleRulerMouseDown}
          >
            {clips.map((clip, i) => {
              const segDur = clip.outPoint - clip.inPoint
              const isActive = i === activeIdx
              const isDragging = dragIdx === i
              const isDropTarget = dropIdx === i && dragIdx !== i

              return (
                <div
                  key={clip.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDragEnd={handleDragEnd}
                  onDrop={(e) => handleDrop(e, i)}
                  onClick={(e) => { e.stopPropagation(); setActiveIdx(i) }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className={`group relative cursor-pointer transition-all duration-150 border-r border-white/5 last:border-r-0 overflow-hidden ${
                    isDragging ? 'opacity-30' : ''
                  } ${isDropTarget ? 'ring-1 ring-accent-400 ring-inset' : ''} ${
                    isActive ? 'bg-accent-500/12' : 'bg-surface-900/40 hover:bg-surface-800/50'
                  }`}
                  style={{ flexGrow: segDur, flexShrink: 0, flexBasis: 0 }}
                >
                  {isActive && <div className="absolute top-0 left-0 right-0 h-0.5 bg-accent-500" />}

                  {/* Left trim handle */}
                  <div
                    onMouseDown={(e) => handleTrimStart(e, clip.id, 'left', i)}
                    className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors group/trim ${
                      trimEdge === `${clip.id}-left` ? 'bg-blue-400/40' : 'hover:bg-blue-400/25'
                    }`}
                  >
                    <div className={`absolute left-0 top-0 bottom-0 w-0.5 transition-colors ${
                      trimEdge === `${clip.id}-left` ? 'bg-blue-400' : 'bg-transparent group-hover/trim:bg-blue-400/50'
                    }`} />
                  </div>

                  {/* Right trim handle */}
                  <div
                    onMouseDown={(e) => handleTrimStart(e, clip.id, 'right', i)}
                    className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors group/trimr ${
                      trimEdge === `${clip.id}-right` ? 'bg-emerald-400/40' : 'hover:bg-emerald-400/25'
                    }`}
                  >
                    <div className={`absolute right-0 top-0 bottom-0 w-0.5 transition-colors ${
                      trimEdge === `${clip.id}-right` ? 'bg-emerald-400' : 'bg-transparent group-hover/trimr:bg-emerald-400/50'
                    }`} />
                  </div>

                  <div className="h-full flex flex-col justify-center px-2 py-1 min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      {clip.loadingState !== 'ready' && clip.loadingState !== 'error' && (
                        <div className="w-2.5 h-2.5 border border-accent-500/40 border-t-accent-400 rounded-full animate-spin shrink-0" />
                      )}
                      {clip.loadingState === 'error' && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400 shrink-0">
                          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                        </svg>
                      )}
                      <span className={`text-[10px] font-medium truncate ${isActive ? 'text-accent-200' : 'text-surface-300'}`}>
                        {clip.name}
                      </span>
                      {clip.clipMuted && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400/60 shrink-0">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                        </svg>
                      )}
                      {!clip.clipMuted && clip.clipVolume < 1 && (
                        <span className="text-[7px] text-surface-500 font-mono shrink-0">{Math.round(clip.clipVolume * 100)}%</span>
                      )}
                    </div>
                    <span className="text-[9px] font-mono text-surface-500 mt-0.5">{formatTime(segDur)}</span>
                    {/* Trim indicators — show available media beyond current edges */}
                    {(clip.inPoint > 0.1 || clip.outPoint < clip.duration - 0.1) && (
                      <div className="flex items-center gap-1 mt-px">
                        {clip.inPoint > 0.1 && (
                          <span className="text-[6px] text-blue-400/40 font-mono">◁{formatTime(clip.inPoint)}</span>
                        )}
                        {clip.outPoint < clip.duration - 0.1 && (
                          <span className="text-[6px] text-emerald-400/40 font-mono">{formatTime(clip.duration - clip.outPoint)}▷</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Hover controls — remove only (volume/mute controls are on A1/A2) */}
                  <div className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); removeClip(i) }}
                      className="w-5 h-5 rounded flex items-center justify-center text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remove"
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* A1 — Source / imported audio */}
          {hasAudioTrack && (
            <div
              className="h-8 flex border-t border-white/5 bg-surface-950/10 cursor-pointer"
              onMouseDown={handleRulerMouseDown}
            >
              {clips.map((clip, i) => {
                const segDur = clip.outPoint - clip.inPoint
                const isActive = i === activeIdx
                return (
                  <div
                    key={`a1-${clip.id}`}
                    className={`relative overflow-hidden border-r border-white/5 last:border-r-0 cursor-pointer ${
                      isActive ? 'bg-green-500/5' : ''
                    }`}
                    style={{ flexGrow: segDur, flexShrink: 0, flexBasis: 0 }}
                    onClick={() => setActiveIdx(i)}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {/* Selection indicator */}
                    {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-400/40" />}

                    {/* Left trim handle */}
                    <div
                      onMouseDown={(e) => handleTrimStart(e, clip.id, 'left', i)}
                      className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors ${
                        trimEdge === `${clip.id}-left` ? 'bg-blue-400/30' : 'hover:bg-blue-400/20'
                      }`}
                    />

                    {/* Right trim handle */}
                    <div
                      onMouseDown={(e) => handleTrimStart(e, clip.id, 'right', i)}
                      className={`absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-10 transition-colors ${
                        trimEdge === `${clip.id}-right` ? 'bg-emerald-400/30' : 'hover:bg-emerald-400/20'
                      }`}
                    />

                    <div className="h-full flex items-center group relative">
                      {/* Waveform hint bars */}
                      <div className="absolute inset-0 flex items-center gap-px opacity-15 pointer-events-none overflow-hidden px-0.5">
                        {Array.from({ length: 24 }, (_, i) => (
                          <div key={i} className={`w-0.5 rounded-full shrink-0 ${clip.isVideo ? 'bg-green-400' : 'bg-cyan-400'}`}
                            style={{ height: `${20 + Math.sin(i * 0.7 + (clip.inPoint || 0)) * 30 + Math.cos(i * 1.1) * 20}%` }} />
                        ))}
                      </div>
                      <span className={`relative text-[8px] font-medium px-1.5 truncate pointer-events-none ${clip.isVideo ? 'text-green-400/50' : 'text-cyan-400/50'}`}>
                        {clip.isVideo ? 'Source audio' : clip.name}
                      </span>
                      {clip.clipMuted && (
                        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400/60 shrink-0 pointer-events-none">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                        </svg>
                      )}
                      {!clip.clipMuted && clip.clipVolume < 1 && (
                        <span className="text-[6px] text-green-400/40 font-mono shrink-0 pointer-events-none">{Math.round(clip.clipVolume * 100)}%</span>
                      )}
                      {/* Volume/mute controls on hover */}
                      <div className="absolute right-0 top-0 bottom-0 flex items-center gap-0.5 pr-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => toggleClipMute(clip.id)}
                          className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${
                            clip.clipMuted ? 'text-red-400 bg-red-500/10' : 'text-surface-500 hover:text-green-400 hover:bg-green-500/10'
                          }`}
                          title={clip.clipMuted ? 'Unmute A1' : 'Mute A1'}
                        >
                          {clip.clipMuted ? (
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                          ) : (
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
                          )}
                        </button>
                        <input
                          type="range" min={0} max={1} step={0.05}
                          value={clip.clipVolume}
                          onChange={(e) => setClipVolume(clip.id, parseFloat(e.target.value))}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-10 h-0.5 accent-green-500 cursor-pointer"
                          title={`A1 Volume: ${Math.round(clip.clipVolume * 100)}%`}
                        />
                        {clip.isVideo && clip.loadingState === 'ready' && (
                          <button
                            onClick={() => onReplaceAudio(clip.id)}
                            className="px-1 py-0.5 text-[7px] rounded font-medium text-surface-500 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                            title="Add replacement audio"
                          >
                            +A2
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* A2 — Replacement audio track */}
          {hasReplacementAudio && (
            <div
              className="h-8 flex border-t border-white/5 bg-surface-950/5 cursor-pointer"
              onMouseDown={handleRulerMouseDown}
            >
              {clips.map((clip, i) => {
                const segDur = clip.outPoint - clip.inPoint
                const isActive = i === activeIdx
                return (
                  <div
                    key={`a2-${clip.id}`}
                    className={`relative overflow-hidden border-r border-white/5 last:border-r-0 ${
                      isActive && clip.audioReplacement ? 'bg-amber-500/5' : ''
                    }`}
                    style={{ flexGrow: segDur, flexShrink: 0, flexBasis: 0 }}
                    onClick={() => setActiveIdx(i)}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {isActive && clip.audioReplacement && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-400/40" />}
                    {clip.audioReplacement ? (
                      <AudioBlock
                        clipId={clip.id}
                        clipDuration={segDur}
                        replacement={clip.audioReplacement}
                        onRemove={() => useEditorStore.getState().setAudioReplacement(clip.id, undefined)}
                        onOffsetChange={(offset) => setAudioOffset(clip.id, offset)}
                        onReplace={() => onReplaceAudio(clip.id)}
                        onToggleMute={() => toggleA2Mute(clip.id)}
                        onVolumeChange={(v) => setA2Volume(clip.id, v)}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          {/* In/Out bracket markers — span all tracks */}
          {active && totalDur > 0 && (
            <>
              {/* In-point needle (blue) */}
              <div
                className="absolute top-0 bottom-0 z-10 pointer-events-none"
                style={{ left: `${inBracketPct}%` }}
              >
                <div className="absolute top-0 left-0 w-0.5 h-full bg-blue-400/30" />
                <div
                  className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] pointer-events-auto cursor-col-resize"
                  onMouseDown={(e) => handleTrimStart(e, active.id, 'left', activeIdx)}
                >
                  <div className="w-0 h-0 border-l-[4px] border-l-blue-400 border-y-[3px] border-y-transparent mt-px" />
                </div>
                {/* Bottom bracket foot */}
                <div className="absolute bottom-0 left-0 w-2 h-0.5 bg-blue-400/40" />
              </div>
              {/* Out-point needle (emerald) */}
              <div
                className="absolute top-0 bottom-0 z-10 pointer-events-none"
                style={{ left: `${outBracketPct}%` }}
              >
                <div className="absolute top-0 right-0 w-0.5 h-full bg-emerald-400/30" />
                <div
                  className="absolute -top-0.5 -left-[3px] w-[7px] h-[7px] pointer-events-auto cursor-col-resize"
                  onMouseDown={(e) => handleTrimStart(e, active.id, 'right', activeIdx)}
                >
                  <div className="w-0 h-0 border-r-[4px] border-r-emerald-400 border-y-[3px] border-y-transparent mt-px ml-auto" />
                </div>
                {/* Bottom bracket foot */}
                <div className="absolute bottom-0 right-0 w-2 h-0.5 bg-emerald-400/40" />
              </div>
              {/* Shaded region between in/out */}
              {inBracketPct > 0.1 && (
                <div className="absolute top-0 bottom-0 bg-blue-400/[0.03] pointer-events-none" style={{ left: 0, width: `${inBracketPct}%` }} />
              )}
              {outBracketPct < 99.9 && (
                <div className="absolute top-0 bottom-0 bg-emerald-400/[0.03] pointer-events-none" style={{ left: `${outBracketPct}%`, right: 0 }} />
              )}
            </>
          )}

          {/* Playhead — spans ruler + all tracks, draggable */}
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-none"
            style={{ left: `${playheadPct}%` }}
          >
            <div className="absolute top-0 left-0 w-px h-full bg-white/80" />
            <div className="absolute -top-0.5 -left-1 w-2.5 h-2.5 bg-white rounded-full shadow-[0_0_6px_rgba(255,255,255,0.5)] pointer-events-auto cursor-col-resize"
              onMouseDown={(e) => { e.stopPropagation(); handleRulerMouseDown(e) }}
            />
          </div>
        </div>
      </div>

      {/* ========== TRANSPORT + IN/OUT ========== */}
      {clip && clip.loadingState === 'ready' && (
        <div className="border-t border-white/5 px-3 sm:px-4 py-2.5 space-y-2">
          {/* Row 1: transport + in/out + export */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <button
                onClick={onTogglePlay}
                className="w-8 h-8 rounded-full btn-accent flex items-center justify-center text-white"
                title="Play/Pause (Space)"
              >
                {playing ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>
                )}
              </button>
              <span className="text-[11px] font-mono text-surface-300 tabular-nums">
                {formatTime(currentTime)} <span className="text-surface-600">/</span> {formatTime(clip.duration)}
              </span>

              {/* Volume */}
              <div className="hidden sm:flex items-center gap-1 ml-1">
                <button
                  onClick={() => setVolume(volume > 0 ? 0 : 1)}
                  className="text-surface-400 hover:text-surface-200 transition-colors"
                  title={volume > 0 ? 'Mute' : 'Unmute'}
                >
                  {volume === 0 ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                  ) : volume < 0.5 ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
                  )}
                </button>
                <input type="range" min={0} max={1} step={0.05} value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-14 h-1 accent-accent-500 cursor-pointer" />
              </div>

              {/* Speed */}
              <select
                value={playbackRate}
                onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                className="hidden sm:block bg-surface-900/80 text-surface-300 rounded-lg px-1.5 py-0.5 text-[10px] border border-white/5 outline-none cursor-pointer"
              >
                {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}x</option>)}
              </select>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={onSetIn} className="px-2 py-0.5 text-[10px] font-semibold rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/15 transition-all" title="Set In (I)">
                In [{formatTime(clip.inPoint)}]
              </button>
              <button onClick={onSetOut} className="px-2 py-0.5 text-[10px] font-semibold rounded-md bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/15 transition-all" title="Set Out (O)">
                Out [{formatTime(clip.outPoint)}]
              </button>
              <button onClick={() => resetPoints()} className="px-2 py-0.5 text-[10px] font-medium rounded-md text-surface-400 hover:text-surface-200 bg-surface-800/60 hover:bg-surface-700/60 transition-all" title="Reset (R)">
                Reset
              </button>
              {canMerge() && (
                <>
                  <div className="w-px h-4 bg-surface-700/50 mx-0.5 hidden sm:block" />
                  <button onClick={onMerge} disabled={processing}
                    className="px-2.5 py-0.5 text-[10px] font-semibold rounded-md btn-accent text-white disabled:opacity-40">
                    Merge All
                  </button>
                </>
              )}
              <div className="w-px h-4 bg-surface-700/50 mx-0.5 hidden sm:block" />
              <button onClick={onImportFile}
                className="px-2 py-0.5 text-[10px] font-medium rounded-md text-surface-400 hover:text-accent-300 bg-surface-800/60 hover:bg-accent-500/10 transition-all"
                title="Import media file">
                + Import
              </button>
              <button onClick={onCut} disabled={processing || duration <= 0}
                className="px-3 py-1 text-[11px] font-semibold rounded-lg btn-accent text-white">
                {processing ? `Exporting${exportProgress > 0 ? ` ${exportProgress}%` : '...'}` : 'Export'}
              </button>
            </div>
          </div>

          {/* Row 2: mode / format / output */}
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <div className="flex items-center gap-0.5">
              <span className="text-surface-500 font-medium">Mode:</span>
              <div className="flex bg-surface-900/80 rounded-md p-0.5 gap-0.5">
                <button onClick={() => setCutMode('precise')}
                  className={`px-2 py-0.5 rounded font-medium transition-all ${cutMode === 'precise' ? 'bg-accent-600/25 text-accent-300' : 'text-surface-400 hover:text-surface-200'}`}>
                  Precise
                </button>
                <button onClick={() => setCutMode('fast')}
                  className={`px-2 py-0.5 rounded font-medium transition-all ${cutMode === 'fast' ? 'bg-accent-600/25 text-accent-300' : 'text-surface-400 hover:text-surface-200'}`}>
                  Fast
                </button>
              </div>
            </div>
            <div className="w-px h-3.5 bg-surface-700/50 hidden sm:block" />
            <div className="flex items-center gap-1">
              <span className="text-surface-500 font-medium">Format:</span>
              <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)}
                className="bg-surface-900/80 text-surface-200 rounded-md px-2 py-0.5 text-[10px] border border-white/5 outline-none cursor-pointer">
                <option value="">.{srcExt}</option>
                {formats.map((f) => <option key={f} value={f}>.{f}</option>)}
              </select>
            </div>
            <div className="w-px h-3.5 bg-surface-700/50 hidden sm:block" />
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <span className="text-surface-500 font-medium shrink-0">Out:</span>
              <input type="text" value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="Same as source"
                className="flex-1 min-w-0 bg-surface-900/80 text-surface-200 rounded-md px-2 py-0.5 text-[10px] border border-white/5 outline-none truncate" />
              <button onClick={onBrowseOutputDir}
                className="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-md text-surface-300 hover:text-surface-100 bg-surface-800/60 hover:bg-surface-700/60 border border-white/5 transition-all">
                Browse
              </button>
            </div>
          </div>

          {/* GIF options */}
          {outputFormat === 'gif' && (
            <div className="flex flex-wrap items-center gap-2.5 text-[10px]">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={gifOptions.loop} onChange={(e) => setGifOptions({ loop: e.target.checked })}
                  className="w-3 h-3 rounded border-surface-600 bg-surface-900 text-accent-500 focus:ring-accent-500/30 cursor-pointer" />
                <span className="text-surface-300">Loop</span>
              </label>
              <div className="flex items-center gap-1">
                <span className="text-surface-500">FPS:</span>
                <input type="number" min={1} max={30} value={gifOptions.fps}
                  onChange={(e) => setGifOptions({ fps: Math.max(1, Math.min(30, parseInt(e.target.value) || 15)) })}
                  className="w-12 bg-surface-900/80 text-surface-200 rounded-md px-1.5 py-0.5 text-[10px] border border-white/5 outline-none" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-surface-500">Width:</span>
                <select value={gifOptions.width} onChange={(e) => setGifOptions({ width: parseInt(e.target.value) })}
                  className="bg-surface-900/80 text-surface-200 rounded-md px-2 py-0.5 text-[10px] border border-white/5 outline-none cursor-pointer">
                  <option value={320}>320px</option><option value={480}>480px</option>
                  <option value={640}>640px</option><option value={800}>800px</option>
                  <option value={-1}>Original</option>
                </select>
              </div>
            </div>
          )}

          {/* Progress / message */}
          {processing && exportProgress > 0 && (
            <div className="w-full h-1 bg-surface-900 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-300"
                style={{ width: `${exportProgress}%`, background: 'linear-gradient(90deg, var(--color-accent-600), var(--color-accent-400))' }} />
            </div>
          )}
          {message && (
            <div className={`text-[10px] px-3 py-2 rounded-lg flex items-center gap-2 ${
              message.startsWith('Error')
                ? 'bg-red-500/8 text-red-300 border border-red-500/10'
                : 'bg-emerald-500/8 text-emerald-300 border border-emerald-500/10'
            }`}>
              {message.startsWith('Error') ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              )}
              {message}
            </div>
          )}
        </div>
      )}

      {/* Minimal footer when no clip is ready */}
      {(!clip || clip.loadingState !== 'ready') && (
        <div className="border-t border-white/5 px-3 sm:px-4 py-2 flex items-center justify-between gap-2 text-2xs text-surface-500">
          <div className="flex items-center gap-2">
            <span className="font-mono">{clips.length} clip{clips.length !== 1 ? 's' : ''} · {formatTime(totalDur)}</span>
            {clips.length >= 2 && <><span className="text-surface-700">·</span><span>Drag to reorder</span></>}
          </div>
          <button
            onClick={onImportFile}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-surface-400 hover:text-accent-300 hover:bg-accent-500/5 border border-dashed border-surface-700 hover:border-accent-500/30 transition-all"
            title="Import media file"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Import
          </button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Audio Block (draggable within its A2 slot)                         */
/* ------------------------------------------------------------------ */

interface AudioBlockProps {
  clipId: string
  clipDuration: number
  replacement: { name: string; duration: number; offset: number; volume: number; muted: boolean }
  onRemove: () => void
  onOffsetChange: (offset: number) => void
  onReplace: () => void
  onToggleMute: () => void
  onVolumeChange: (volume: number) => void
}

function AudioBlock({ clipDuration, replacement, onRemove, onOffsetChange, onReplace, onToggleMute, onVolumeChange }: AudioBlockProps): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const { offset, duration: audioDur, name } = replacement
  const span = Math.max(clipDuration, offset + audioDur)
  const leftPct = span > 0 ? (offset / span) * 100 : 0
  const widthPct = span > 0 ? (audioDur / span) * 100 : 100

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const slot = slotRef.current
    if (!slot) return
    setDragging(true)
    const rect = slot.getBoundingClientRect()
    const startX = e.clientX
    const startOff = offset
    const onMove = (ev: MouseEvent): void => {
      const dSec = ((ev.clientX - startX) / rect.width) * span
      onOffsetChange(Math.max(0, Math.round((startOff + dSec) * 100) / 100))
    }
    const onUp = (): void => { setDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [offset, span, onOffsetChange])

  return (
    <div ref={slotRef} className="relative h-full">
      <div
        onMouseDown={handleMouseDown}
        className={`absolute top-0.5 bottom-0.5 rounded transition-colors overflow-hidden ${
          dragging
            ? 'bg-amber-500/20 border border-amber-400/40 cursor-grabbing shadow-[0_0_8px_rgba(245,158,11,0.15)]'
            : 'bg-amber-500/10 border border-amber-500/20 cursor-grab hover:bg-amber-500/15 hover:border-amber-400/30'
        }`}
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '40px' }}
      >
        {/* Waveform */}
        <div className="absolute inset-0 flex items-center gap-px opacity-20 pointer-events-none overflow-hidden px-0.5">
          {Array.from({ length: 16 }, (_, i) => (
            <div key={i} className="w-0.5 bg-amber-400 rounded-full shrink-0"
              style={{ height: `${25 + Math.sin(i * 0.9) * 35 + Math.cos(i * 1.4) * 18}%` }} />
          ))}
        </div>
        <div className="absolute inset-0 flex items-center gap-1 px-1.5 pointer-events-none">
          <span className="text-[7px] text-amber-300/80 font-medium truncate">{name}</span>
          {replacement.muted && (
            <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-red-400/60 shrink-0">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          )}
          {!replacement.muted && replacement.volume < 1 && (
            <span className="text-[6px] text-amber-400/40 font-mono shrink-0">{Math.round(replacement.volume * 100)}%</span>
          )}
        </div>
        <div className="absolute top-0 right-0 flex items-center gap-0.5 opacity-0 hover:opacity-100 transition-opacity pointer-events-auto">
          <button onClick={(e) => { e.stopPropagation(); onToggleMute() }}
            className={`p-0.5 transition-colors ${replacement.muted ? 'text-red-400' : 'text-surface-500 hover:text-amber-400'}`}
            title={replacement.muted ? 'Unmute A2' : 'Mute A2'}
          >
            {replacement.muted ? (
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
            ) : (
              <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
            )}
          </button>
          <input
            type="range" min={0} max={1} step={0.05}
            value={replacement.volume}
            onChange={(e) => { e.stopPropagation(); onVolumeChange(parseFloat(e.target.value)) }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-8 h-0.5 accent-amber-500 cursor-pointer"
            title={`A2 Volume: ${Math.round(replacement.volume * 100)}%`}
          />
          <button onClick={(e) => { e.stopPropagation(); onReplace() }} className="p-0.5 text-surface-500 hover:text-amber-400 transition-colors" title="Replace">
            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); onRemove() }} className="p-0.5 text-surface-500 hover:text-red-400 transition-colors" title="Remove">
            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>
  )
}
