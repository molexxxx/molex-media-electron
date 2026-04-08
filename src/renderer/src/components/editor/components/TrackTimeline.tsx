/**
 * @module components/editor/TrackTimeline
 * @description Unified NLE-style timeline: timecode ruler, V1 video track, A1 source
 * audio, optional A2 replacement audio, draggable playhead with in/out handles,
 * transport controls, and export options. Replaces both the old TrackTimeline and Timeline.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime, OUTPUT_FORMATS } from '../types'
import { Select } from '../../shared/ui'

interface TrackTimelineProps {
  currentTime: number
  playing: boolean
  onSeek: (time: number) => void
  onTogglePlay: () => void
  onSetIn: () => void
  onSetOut: () => void
  onSplit: () => void
  onClipSelection: () => void
  onDeleteSelection: () => void
  onCut: () => void
  onMerge: () => void
  onReplaceAudio: (clipId: string) => void
  onReplaceA1: (clipId: string) => void
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
  currentTime, playing, onSeek, onTogglePlay, onSetIn, onSetOut, onSplit, onClipSelection, onDeleteSelection, onCut,
  onMerge, onReplaceAudio, onReplaceA1, onBrowseOutputDir, onImportFile
}: TrackTimelineProps): React.JSX.Element {
  const {
    clips, activeIdx, processing, exportProgress, message, cutMode, outputFormat,
    outputDir, gifOptions, volume, playbackRate,
    setActiveIdx, moveClip, canMerge, removeClip,
    setCutMode, setOutputFormat, setOutputDir, setGifOptions, resetPoints,
    setVolume, setPlaybackRate, setClipVolume, toggleClipMute,
    setA2Volume, toggleA2Mute, setClipInPoint, setClipOutPoint,
    activeClip, clipDuration, deleteActiveClip
  } = useEditorStore()

  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const trackAreaRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  /* ---- A2 cross-segment drag ---- */
  const a2RowRef = useRef<HTMLDivElement>(null)
  const [a2DragClipId, setA2DragClipId] = useState<string | null>(null)

  /* ---- trim handle state ---- */
  const trimRef = useRef<{
    clipId: string; edge: 'left' | 'right'
    startX: number; startIn: number; startOut: number; dur: number; secPerPx: number
  } | null>(null)
  const [trimEdge, setTrimEdge] = useState<string | null>(null)

  const clip = activeClip()
  const duration = clipDuration()

  /* ---- sequence metrics ---- */
  const totalDur = clips.reduce((acc, c) => acc + c.duration, 0)
  const hasReplacementAudio = clips.some((c) => c.audioReplacement)
  // A1 always shown — video clips have source audio, audio clips are audio-only
  const hasAudioTrack = clips.length > 0

  // Cumulative start-time of each clip in merge sequence
  const clipStarts: number[] = []
  let cum = 0
  for (const c of clips) { clipStarts.push(cum); cum += c.duration }

  // Playhead position — convert source-relative currentTime to clip-relative
  const active = clips[activeIdx]
  const relTime = active ? currentTime - active.sourceStart : 0
  const seqTime = active
    ? clipStarts[activeIdx] + Math.max(0, Math.min(relTime, active.duration))
    : 0
  const playheadPct = totalDur > 0 ? Math.min(100, (seqTime / totalDur) * 100) : 0
  const marks = rulerMarks(totalDur)

  // In/out bracket positions — when brackets cover the full segment, show full timeline (no dimming)
  const isFullRange = active &&
    (active.inPoint - active.sourceStart) <= 0.05 &&
    ((active.sourceStart + active.duration) - active.outPoint) <= 0.05
  const inBracketPct = isFullRange ? 0
    : totalDur > 0 && active ? ((clipStarts[activeIdx] + (active.inPoint - active.sourceStart)) / totalDur) * 100 : 0
  const outBracketPct = isFullRange ? 100
    : totalDur > 0 && active ? ((clipStarts[activeIdx] + (active.outPoint - active.sourceStart)) / totalDur) * 100 : 100

  const srcExt = clip?.name.split('.').pop()?.toLowerCase() || ''
  const formats = clip?.isVideo ? OUTPUT_FORMATS.video : OUTPUT_FORMATS.audio

  /* ---- scrub: click/drag on ruler or tracks ---- */
  const scrubFromEvent = useCallback((e: MouseEvent | React.MouseEvent): void => {
    const area = trackAreaRef.current
    const scroll = scrollContainerRef.current
    if (!area || !scroll || clips.length === 0) return
    const rect = scroll.getBoundingClientRect()
    const contentWidth = area.scrollWidth
    const x = e.clientX - rect.left + scroll.scrollLeft
    const pct = Math.max(0, Math.min(1, x / contentWidth))
    const seqT = pct * totalDur

    // Find which clip this falls into
    for (let i = 0; i < clips.length; i++) {
      const segDur = clips[i].duration
      if (seqT <= clipStarts[i] + segDur || i === clips.length - 1) {
        if (i !== activeIdx) {
          // Silent switch — don't reset playing state during scrub
          useEditorStore.setState({ activeIdx: i })
        }
        const localT = Math.max(0, Math.min(segDur, seqT - clipStarts[i]))
        // Convert clip-relative to source-relative
        onSeek(localT + clips[i].sourceStart)
        break
      }
    }
  }, [clips, clipStarts, totalDur, activeIdx, setActiveIdx, onSeek])

  const handleA2DragStart = useCallback((clipId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const row = a2RowRef.current
    if (!row) return
    const s0 = useEditorStore.getState()
    const srcClip = s0.clips.find((c) => c.id === clipId)
    if (!srcClip?.audioReplacement) return
    setA2DragClipId(clipId)
    const startX = e.clientX
    const rowWidth = row.getBoundingClientRect().width
    const total = s0.clips.reduce((a, c) => a + c.duration, 0)
    let cumBefore = 0
    for (const c of s0.clips) { if (c.id === clipId) break; cumBefore += c.duration }
    const startAbs = cumBefore + srcClip.audioReplacement.offset
    let curSourceId = clipId
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      const timeDelta = (dx / rowWidth) * total
      const newAbs = Math.max(0, Math.min(total - 0.01, startAbs + timeDelta))
      const st = useEditorStore.getState()
      let acc = 0
      let targetIdx = st.clips.length - 1
      for (let i = 0; i < st.clips.length; i++) {
        if (newAbs >= acc && newAbs < acc + st.clips[i].duration) { targetIdx = i; break }
        acc += st.clips[i].duration
      }
      const targetClip = st.clips[targetIdx]
      const relOff = Math.max(0, Math.round((newAbs - acc) * 100) / 100)
      if (targetClip.id !== curSourceId) {
        if (targetClip.audioReplacement) return
        st.moveA2ToClip(curSourceId, targetIdx, relOff)
        curSourceId = targetClip.id
        setA2DragClipId(targetClip.id)
      } else {
        st.setAudioOffset(curSourceId, relOff)
      }
    }
    const onUp = (): void => {
      setA2DragClipId(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

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
      const ctrl = e.ctrlKey || e.metaKey
      switch (e.code) {
        case 'Space': e.preventDefault(); onTogglePlay(); break
        case 'KeyI': if (!ctrl) { e.preventDefault(); onSetIn() } break
        case 'KeyO': if (!ctrl) { e.preventDefault(); onSetOut() } break
        case 'KeyS': if (!ctrl) { e.preventDefault(); onSplit() } break
        case 'KeyR': if (!ctrl) { e.preventDefault(); resetPoints() } break
        case 'KeyZ':
          if (ctrl) {
            e.preventDefault()
            useEditorStore.getState().undo()
          }
          break
        case 'KeyY':
          if (ctrl) {
            e.preventDefault()
            useEditorStore.getState().redo()
          }
          break
        case 'Delete':
        case 'Backspace': if (!ctrl) { e.preventDefault(); deleteActiveClip() } break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onTogglePlay, onSetIn, onSetOut, onSplit, deleteActiveClip]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- zoom: Ctrl+wheel to zoom, plain wheel to scroll ---- */
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = container.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const scrollBefore = container.scrollLeft
        const contentBefore = container.scrollWidth
        const anchorPct = (mouseX + scrollBefore) / contentBefore

        setZoom((prev) => {
          const next = Math.max(1, Math.min(20, prev * (e.deltaY < 0 ? 1.25 : 0.8)))
          // Defer scroll adjustment to after render
          requestAnimationFrame(() => {
            const contentAfter = container.scrollWidth
            container.scrollLeft = anchorPct * contentAfter - mouseX
          })
          return next
        })
      } else if (zoom > 1) {
        // Horizontal scroll with trackpad or shift+wheel
        if (e.deltaX !== 0) return // let native horizontal scroll work
        e.preventDefault()
        container.scrollLeft += e.deltaY
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [zoom])

  /* ---- auto-scroll playhead into view during playback ---- */
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || zoom <= 1) return
    const contentWidth = container.scrollWidth
    const viewportWidth = container.clientWidth
    const playheadX = (playheadPct / 100) * contentWidth
    const margin = viewportWidth * 0.15
    if (playheadX < container.scrollLeft + margin) {
      container.scrollLeft = playheadX - margin
    } else if (playheadX > container.scrollLeft + viewportWidth - margin) {
      container.scrollLeft = playheadX - viewportWidth + margin
    }
  }, [playheadPct, zoom])

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
    const trackWidth = area.scrollWidth
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
        <div className="w-11 shrink-0 bg-surface-900/50 border-r border-white/[0.08]">
          <div className="h-6" />
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

        {/* Timeline content area — scrollable when zoomed */}
        <div ref={scrollContainerRef} className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-thin">
        <div ref={trackAreaRef} className="relative" style={{ width: zoom > 1 ? `${zoom * 100}%` : '100%' }}>
          {/* Timecode ruler — clickable for scrubbing */}
          <div
            className="h-6 relative border-b border-white/[0.08] bg-surface-950/60 cursor-pointer"
            onMouseDown={handleRulerMouseDown}
          >
            {marks.map((m, i) => (
              <div key={i} className="absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none" style={{ left: `${m.pct}%` }}>
                <div className="w-px h-2.5 bg-surface-500/50" />
                {i < marks.length - 1 && (
                  <span className="absolute bottom-1 left-1.5 text-[8px] text-surface-400 font-mono whitespace-nowrap select-none">
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
              const segDur = clip.duration
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
                  className={`group relative cursor-pointer transition-all duration-150 border-r border-white/5 last:border-r-0 overflow-hidden rounded-md mx-px first:ml-0 last:mr-0 ${
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
                    className={`absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-10 transition-all group/trim flex items-center justify-center ${
                      trimEdge === `${clip.id}-left` ? 'bg-blue-400/30' : 'hover:bg-blue-400/15'
                    }`}
                  >
                    <div className={`absolute left-0 top-0 bottom-0 w-[2px] transition-colors rounded-r ${
                      trimEdge === `${clip.id}-left` ? 'bg-blue-400' : 'bg-transparent group-hover/trim:bg-blue-400/60'
                    }`} />
                    <div className={`flex flex-col gap-0.5 pointer-events-none transition-opacity ${
                      trimEdge === `${clip.id}-left` ? 'opacity-80' : 'opacity-0 group-hover/trim:opacity-50'
                    }`}>
                      <div className="w-0.5 h-1 bg-blue-300 rounded-full" />
                      <div className="w-0.5 h-1 bg-blue-300 rounded-full" />
                      <div className="w-0.5 h-1 bg-blue-300 rounded-full" />
                    </div>
                  </div>

                  {/* Right trim handle */}
                  <div
                    onMouseDown={(e) => handleTrimStart(e, clip.id, 'right', i)}
                    className={`absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-10 transition-all group/trimr flex items-center justify-center ${
                      trimEdge === `${clip.id}-right` ? 'bg-emerald-400/30' : 'hover:bg-emerald-400/15'
                    }`}
                  >
                    <div className={`absolute right-0 top-0 bottom-0 w-[2px] transition-colors rounded-l ${
                      trimEdge === `${clip.id}-right` ? 'bg-emerald-400' : 'bg-transparent group-hover/trimr:bg-emerald-400/60'
                    }`} />
                    <div className={`flex flex-col gap-0.5 pointer-events-none transition-opacity ${
                      trimEdge === `${clip.id}-right` ? 'opacity-80' : 'opacity-0 group-hover/trimr:opacity-50'
                    }`}>
                      <div className="w-0.5 h-1 bg-emerald-300 rounded-full" />
                      <div className="w-0.5 h-1 bg-emerald-300 rounded-full" />
                      <div className="w-0.5 h-1 bg-emerald-300 rounded-full" />
                    </div>
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
                    {((clip.inPoint - clip.sourceStart) > 0.1 || clip.outPoint < (clip.sourceStart + clip.duration) - 0.1) && (
                      <div className="flex items-center gap-1 mt-px">
                        {(clip.inPoint - clip.sourceStart) > 0.1 && (
                          <span className="text-[6px] text-blue-400/40 font-mono">◁{formatTime(clip.inPoint - clip.sourceStart)}</span>
                        )}
                        {clip.outPoint < (clip.sourceStart + clip.duration) - 0.1 && (
                          <span className="text-[6px] text-emerald-400/40 font-mono">{formatTime((clip.sourceStart + clip.duration) - clip.outPoint)}▷</span>
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
                const segDur = clip.duration
                const isActive = i === activeIdx
                return (
                  <div
                    key={`a1-${clip.id}`}
                    className={`relative overflow-hidden border-r border-white/5 last:border-r-0 cursor-pointer rounded-md mx-px first:ml-0 last:mr-0 ${
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
                        {clip.isVideo && clip.loadingState === 'ready' && !clip.audioReplacement && (
                          <button
                            onClick={() => onReplaceAudio(clip.id)}
                            className="px-1 py-0.5 text-[7px] rounded font-medium text-surface-500 hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                            title="Add replacement audio (A2)"
                          >
                            +A2
                          </button>
                        )}
                        {clip.isVideo && clip.loadingState === 'ready' && (
                          <button
                            onClick={() => onReplaceA1(clip.id)}
                            className="w-4 h-4 rounded flex items-center justify-center text-surface-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                            title="Replace source audio"
                          >
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                          </button>
                        )}
                        {clip.isVideo && clip.loadingState === 'ready' && !clip.clipMuted && (
                          <button
                            onClick={() => { toggleClipMute(clip.id) }}
                            className="w-4 h-4 rounded flex items-center justify-center text-surface-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Remove source audio"
                          >
                            <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
              ref={a2RowRef}
              className="h-8 flex border-t border-white/5 bg-surface-950/5 cursor-pointer"
              onMouseDown={handleRulerMouseDown}
            >
              {clips.map((clip, i) => {
                const segDur = clip.duration
                const isActive = i === activeIdx
                return (
                  <div
                    key={`a2-${clip.id}`}
                    className={`relative overflow-hidden border-r border-white/5 last:border-r-0 rounded-md mx-px first:ml-0 last:mr-0 ${
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
                        isDragging={a2DragClipId === clip.id}
                        onDragStart={(cid, ev) => handleA2DragStart(cid, ev)}
                        onRemove={() => useEditorStore.getState().setAudioReplacement(clip.id, undefined)}
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
              {/* Dimmed regions outside in/out — dark overlay for excluded areas */}
              {inBracketPct > 0.1 && (
                <div className="absolute top-0 bottom-0 bg-black/45 pointer-events-none z-[5]" style={{ left: 0, width: `${inBracketPct}%` }} />
              )}
              {outBracketPct < 99.9 && (
                <div className="absolute top-0 bottom-0 bg-black/45 pointer-events-none z-[5]" style={{ left: `${outBracketPct}%`, right: 0 }} />
              )}
              {/* Highlighted selection region — subtle bright overlay */}
              {(inBracketPct > 0.1 || outBracketPct < 99.9) && (
                <div className="absolute top-0 bottom-0 bg-white/[0.03] border-y border-white/[0.06] pointer-events-none z-[5]" style={{ left: `${inBracketPct}%`, width: `${outBracketPct - inBracketPct}%` }} />
              )}
              {/* In-point bracket (blue) */}
              <div
                className="absolute top-0 bottom-0 z-10 pointer-events-none"
                style={{ left: `${inBracketPct}%` }}
              >
                <div className="absolute top-0 left-0 w-[2px] h-full bg-blue-400/50" />
                {/* Top handle */}
                <div
                  className="absolute -top-0.5 -left-[6px] w-[14px] h-5 pointer-events-auto cursor-col-resize group/inhandle"
                  onMouseDown={(e) => handleTrimStart(e, active.id, 'left', activeIdx)}
                >
                  <div className="w-full h-full rounded-[3px] bg-blue-500 group-hover/inhandle:bg-blue-400 transition-colors shadow-[0_0_8px_rgba(59,130,246,0.4)] flex items-center justify-center border border-blue-300/30">
                    <div className="flex gap-[2px]">
                      <div className="w-[1.5px] h-2.5 bg-blue-200/70 rounded-full" />
                      <div className="w-[1.5px] h-2.5 bg-blue-200/70 rounded-full" />
                    </div>
                  </div>
                </div>
                {/* Bottom bracket foot */}
                <div className="absolute bottom-0 left-0 w-3 h-[2px] bg-blue-400/60 rounded-r" />
              </div>
              {/* Out-point bracket (emerald) */}
              <div
                className="absolute top-0 bottom-0 z-10 pointer-events-none"
                style={{ left: `${outBracketPct}%` }}
              >
                <div className="absolute top-0 right-0 w-[2px] h-full bg-emerald-400/50" />
                {/* Top handle */}
                <div
                  className="absolute -top-0.5 -right-[6px] w-[14px] h-5 pointer-events-auto cursor-col-resize group/outhandle"
                  onMouseDown={(e) => handleTrimStart(e, active.id, 'right', activeIdx)}
                >
                  <div className="w-full h-full rounded-[3px] bg-emerald-500 group-hover/outhandle:bg-emerald-400 transition-colors shadow-[0_0_8px_rgba(16,185,129,0.4)] flex items-center justify-center border border-emerald-300/30">
                    <div className="flex gap-[2px]">
                      <div className="w-[1.5px] h-2.5 bg-emerald-200/70 rounded-full" />
                      <div className="w-[1.5px] h-2.5 bg-emerald-200/70 rounded-full" />
                    </div>
                  </div>
                </div>
                {/* Bottom bracket foot */}
                <div className="absolute bottom-0 right-0 w-3 h-[2px] bg-emerald-400/60 rounded-l" />
              </div>
            </>
          )}

          {/* Playhead — spans ruler + all tracks, draggable */}
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-none"
            style={{ left: `${playheadPct}%` }}
          >
            <div className="absolute top-0 left-[-0.5px] w-px h-full bg-red-400/90" />
            {/* Top playhead handle — red pill */}
            <div
              className="absolute -top-[1px] -left-[6px] pointer-events-auto cursor-col-resize group/playhead"
              onMouseDown={(e) => { e.stopPropagation(); handleRulerMouseDown(e) }}
            >
              <div className="w-[13px] h-[18px] rounded-[3px] bg-red-500 group-hover/playhead:bg-red-400 transition-colors shadow-[0_0_8px_rgba(239,68,68,0.5)] flex items-center justify-center border border-red-300/30">
                <div className="w-[1.5px] h-2.5 bg-red-200/70 rounded-full" />
              </div>
            </div>
            {/* Bottom playhead marker */}
            <div className="absolute -bottom-[1px] -left-[2px] w-[5px] h-[3px] bg-red-400/80 rounded-t" />
          </div>
        </div>
        </div>
      </div>

      {/* ========== TRANSPORT + IN/OUT ========== */}
      {clip && clip.loadingState === 'ready' && (
        <div className="border-t border-white/[0.08] px-3 sm:px-4 py-2.5 space-y-2 bg-surface-950/30">
          {/* Row 1: transport + in/out + export */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <button
                onClick={onTogglePlay}
                className="w-8 h-8 rounded-full bg-accent-500/15 border border-accent-500/25 hover:bg-accent-500/25 hover:border-accent-500/35 flex items-center justify-center text-accent-200 transition-all shadow-sm"
                title="Play/Pause (Space)"
              >
                {playing ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>
                )}
              </button>
              <span className="text-[11px] font-mono text-surface-300 tabular-nums">
                {formatTime(currentTime - (clip?.sourceStart ?? 0))} <span className="text-surface-600">/</span> {formatTime(clip.duration)}
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
                  className="w-14 range-dark"
                  style={{ '--range-progress': `${volume * 100}%` } as React.CSSProperties} />
              </div>

              {/* Speed */}
              <div className="hidden sm:block">
                <Select
                  value={String(playbackRate)}
                  onChange={(v) => setPlaybackRate(parseFloat(v))}
                  options={SPEED_OPTIONS.map((s) => ({ value: String(s), label: `${s}x` }))}
                  compact
                />
              </div>

              {/* Zoom */}
              <div className="hidden sm:flex items-center gap-1 ml-1">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-500">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="range" min={1} max={10} step={0.25} value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="w-14 range-dark"
                  style={{ '--range-progress': `${((zoom - 1) / 9) * 100}%` } as React.CSSProperties}
                  title={`Zoom: ${zoom.toFixed(1)}x (Ctrl+Scroll)`} />
                {zoom > 1 && (
                  <button onClick={() => setZoom(1)}
                    className="text-[8px] text-surface-500 hover:text-surface-300 font-mono transition-colors"
                    title="Reset zoom">
                    {zoom.toFixed(1)}x
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={onSetIn} className="px-2 sm:px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-500/20 transition-all shadow-sm" title="Set In (I)">
                In <span className="hidden sm:inline">[{formatTime(clip.inPoint)}]</span>
              </button>
              <button onClick={onSetOut} className="px-2 sm:px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/20 transition-all shadow-sm" title="Set Out (O)">
                Out <span className="hidden sm:inline">[{formatTime(clip.outPoint)}]</span>
              </button>
              <button onClick={() => resetPoints()} className="px-2 sm:px-2.5 py-1 text-[10px] font-medium rounded-lg text-surface-400 hover:text-surface-200 bg-surface-800/60 hover:bg-surface-700/60 border border-white/[0.06] transition-all" title="Reset (R)">
                Reset
              </button>
              <div className="w-px h-4 bg-surface-700/50 mx-0.5 hidden sm:block" />
              <button onClick={onSplit} className="px-2 sm:px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-orange-500/15 text-orange-300 hover:bg-orange-500/25 border border-orange-500/20 transition-all shadow-sm flex items-center gap-1" title="Split at playhead (S)">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                  <line x1="8" y1="19" x2="12" y2="6"/><line x1="16" y1="19" x2="12" y2="6"/><line x1="12" y1="2" x2="12" y2="6"/>
                </svg>
                Split
              </button>
              <div className="relative group/clip">
                <button className="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 border border-violet-500/20 transition-all shadow-sm flex items-center gap-1" title="Clip selection options">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                    <rect x="6" y="4" width="12" height="16" rx="1"/><line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="16" x2="18" y2="16"/>
                  </svg>
                  Clip
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="shrink-0 ml-0.5">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                <div className="absolute left-0 bottom-full mb-1 min-w-[140px] py-1 bg-surface-900/95 border border-surface-700/60 rounded-xl shadow-xl shadow-black/40 backdrop-blur-xl opacity-0 invisible group-hover/clip:opacity-100 group-hover/clip:visible transition-all z-50">
                  <button onClick={onClipSelection} className="w-full px-3 py-1.5 text-[10px] text-left text-surface-300 hover:bg-accent-600/15 hover:text-white transition-colors flex items-center gap-2">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-violet-400">
                      <rect x="6" y="4" width="12" height="16" rx="1"/><line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="16" x2="18" y2="16"/>
                    </svg>
                    Keep Selection
                  </button>
                  <button onClick={onDeleteSelection} className="w-full px-3 py-1.5 text-[10px] text-left text-surface-300 hover:bg-red-500/15 hover:text-red-200 transition-colors flex items-center gap-2">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-red-400">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                    Delete Selection
                  </button>
                </div>
              </div>
              {clips.length > 1 && (
                <button onClick={() => deleteActiveClip()} className="px-2.5 py-1 text-[10px] font-semibold rounded-lg bg-red-500/10 text-red-300/80 hover:bg-red-500/20 hover:text-red-300 border border-red-500/15 transition-all shadow-sm flex items-center gap-1" title="Delete selected clip (Del)">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                  </svg>
                  Delete
                </button>
              )}
              {canMerge() && (
                <>
                  <div className="w-px h-4 bg-surface-700/50 mx-0.5 hidden sm:block" />
                  <button onClick={onMerge} disabled={processing}
                    className="px-2.5 py-0.5 text-[10px] font-semibold rounded-md bg-accent-500/15 text-accent-200 border border-accent-500/25 hover:bg-accent-500/25 disabled:opacity-40 transition-all">
                    Merge All
                  </button>
                </>
              )}
              <div className="w-px h-4 bg-surface-700/50 mx-0.5 hidden sm:block" />
              <button onClick={onImportFile}
                className="px-2 py-0.5 text-[10px] font-medium rounded-md text-surface-400 hover:text-accent-200 bg-white/[0.03] hover:bg-accent-500/[0.04] border border-white/[0.06] hover:border-accent-500/15 transition-all"
                title="Import media file">
                + Import
              </button>
              <button onClick={onCut} disabled={processing || duration <= 0}
                className="px-3 py-1 text-[11px] font-semibold rounded-lg bg-accent-500/15 text-accent-200 border border-accent-500/25 hover:bg-accent-500/25 hover:border-accent-500/35 transition-all shadow-sm">
                {processing ? `Exporting${exportProgress > 0 ? ` ${exportProgress}%` : '...'}` : 'Export'}
              </button>
            </div>
          </div>

          {/* Row 2: mode / format / output */}
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <div className="flex items-center gap-0.5">
              <span className="text-surface-500 font-medium">Mode:</span>
              <div className="flex bg-white/[0.03] border border-white/[0.06] rounded-lg p-0.5 gap-0.5 backdrop-blur-sm">
                <button onClick={() => setCutMode('precise')}
                  className={`px-2 py-0.5 rounded-md font-medium transition-all ${cutMode === 'precise' ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm' : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'}`}>
                  Precise
                </button>
                <button onClick={() => setCutMode('fast')}
                  className={`px-2 py-0.5 rounded-md font-medium transition-all ${cutMode === 'fast' ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm' : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'}`}>
                  Fast
                </button>
              </div>
            </div>
            <div className="w-px h-3.5 bg-surface-700/50 hidden sm:block" />
            <div className="flex items-center gap-1">
              <span className="text-surface-500 font-medium">Format:</span>
              <Select
                value={outputFormat}
                onChange={(v) => setOutputFormat(v)}
                options={[{ value: '', label: `.${srcExt}` }, ...formats.map((f) => ({ value: f, label: `.${f}` }))]}
                compact
              />
            </div>
            <div className="w-px h-3.5 bg-surface-700/50 hidden sm:block" />
            <div className="flex items-center gap-1 w-full sm:w-auto sm:flex-1 min-w-0">
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
                <Select
                  value={String(gifOptions.width)}
                  onChange={(v) => setGifOptions({ width: parseInt(v) })}
                  options={[
                    { value: '320', label: '320px' }, { value: '480', label: '480px' },
                    { value: '640', label: '640px' }, { value: '800', label: '800px' },
                    { value: '-1', label: 'Original' }
                  ]}
                  compact
                />
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
  replacement: { name: string; duration: number; offset: number; volume: number; muted: boolean; trimIn: number; trimOut: number }
  isDragging: boolean
  onDragStart: (clipId: string, e: React.MouseEvent) => void
  onRemove: () => void
  onReplace: () => void
  onToggleMute: () => void
  onVolumeChange: (volume: number) => void
}

function AudioBlock({ clipId, clipDuration, replacement, isDragging, onDragStart, onRemove, onReplace, onToggleMute, onVolumeChange }: AudioBlockProps): React.JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const trimDragRef = useRef<{
    edge: 'left' | 'right'; startX: number; startTrimIn: number; startTrimOut: number; secPerPx: number
  } | null>(null)
  const [trimming, setTrimming] = useState<string | null>(null)

  const { offset, trimIn, trimOut, name } = replacement
  // Trimmed audio duration after applying in/out trim
  const trimmedDur = trimOut - trimIn

  // Position relative to the segment (clip) duration:
  // offset is where in the segment the A2 starts playing
  const leftPct = clipDuration > 0 ? (offset / clipDuration) * 100 : 0
  const widthPct = clipDuration > 0 ? (trimmedDur / clipDuration) * 100 : 100

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't start drag if we're trimming
    if (trimming) return
    onDragStart(clipId, e)
  }, [clipId, onDragStart, trimming])

  const handleTrimMouseDown = useCallback((e: React.MouseEvent, edge: 'left' | 'right') => {
    e.preventDefault()
    e.stopPropagation()
    const slotEl = slotRef.current
    if (!slotEl) return
    const slotWidth = slotEl.getBoundingClientRect().width
    const secPerPx = clipDuration / slotWidth
    trimDragRef.current = { edge, startX: e.clientX, startTrimIn: trimIn, startTrimOut: trimOut, secPerPx }
    setTrimming(`${clipId}-${edge}`)
  }, [clipId, clipDuration, trimIn, trimOut])

  useEffect(() => {
    if (!trimming) return
    const onMove = (e: MouseEvent): void => {
      const t = trimDragRef.current
      if (!t) return
      const deltaSec = (e.clientX - t.startX) * t.secPerPx
      const store = useEditorStore.getState()
      if (t.edge === 'left') {
        store.setA2TrimIn(clipId, t.startTrimIn + deltaSec)
      } else {
        store.setA2TrimOut(clipId, t.startTrimOut + deltaSec)
      }
    }
    const onUp = (): void => { trimDragRef.current = null; setTrimming(null) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [trimming, clipId])

  return (
    <div ref={slotRef} className="relative h-full">
      <div
        onMouseDown={handleMouseDown}
        className={`absolute top-0.5 bottom-0.5 rounded transition-colors overflow-hidden ${
          isDragging
            ? 'bg-amber-500/20 border border-amber-400/40 cursor-grabbing shadow-[0_0_8px_rgba(245,158,11,0.15)]'
            : 'bg-amber-500/10 border border-amber-500/20 cursor-grab hover:bg-amber-500/15 hover:border-amber-400/30'
        }`}
        style={{ left: `${Math.max(0, leftPct)}%`, width: `${widthPct}%`, minWidth: '30px' }}
      >
        {/* Left trim handle */}
        <div
          onMouseDown={(e) => handleTrimMouseDown(e, 'left')}
          className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors group/a2tl ${
            trimming?.endsWith('-left') ? 'bg-amber-400/30' : 'hover:bg-amber-400/20'
          }`}
        >
          <div className={`absolute left-0 top-0 bottom-0 w-[2px] rounded-r transition-colors ${
            trimming?.endsWith('-left') ? 'bg-amber-400' : 'bg-transparent group-hover/a2tl:bg-amber-400/60'
          }`} />
        </div>

        {/* Right trim handle */}
        <div
          onMouseDown={(e) => handleTrimMouseDown(e, 'right')}
          className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 transition-colors group/a2tr ${
            trimming?.endsWith('-right') ? 'bg-amber-400/30' : 'hover:bg-amber-400/20'
          }`}
        >
          <div className={`absolute right-0 top-0 bottom-0 w-[2px] rounded-l transition-colors ${
            trimming?.endsWith('-right') ? 'bg-amber-400' : 'bg-transparent group-hover/a2tr:bg-amber-400/60'
          }`} />
        </div>

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
