/**
 * @module editor/edit/EditEditor
 * Main Edit mode container: source bin + preview + toolbar + timeline.
 * Responsive: collapsible source bin, stacked layout on small screens.
 */
import React, { useCallback, useRef, useState, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { useTimelineZoom } from '../hooks/useTimelineZoom'
import { useTimelineKeyboard } from '../hooks/useTimelineKeyboard'
import { SourceBin } from './SourceBin'
import { Toolbar } from './Toolbar'
import { Timeline } from './Timeline'
import { ExportDialog } from './ExportDialog'
import { Preview } from './Preview'
import { ClipInspector } from './ClipInspector'
import { TransformInspector } from '../inspect/TransformInspector'
import { FixedTip } from '../../shared/ui'
import { formatTimecode } from '../shared/TimeDisplay'

/** Breakpoint for auto-collapsing source bin */
const COLLAPSE_BREAKPOINT = 768

export function EditEditor(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)

  const coords = useTimelineZoom()
  useTimelineKeyboard({ coords })

  const playback = useEditorStore((s) => s.playback)

  const [sourceBinWidth, setSourceBinWidth] = useState(220)
  const [sourceBinCollapsed, setSourceBinCollapsed] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [transformPanelOpen, setTransformPanelOpen] = useState(false)
  const [transformPanelWidth, setTransformPanelWidth] = useState(240)
  const [timelineHeight, setTimelineHeight] = useState(260)
  const [isMobile, setIsMobile] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-collapse source bin on small screens
  useEffect(() => {
    const check = (): void => {
      const w = containerRef.current?.clientWidth ?? 0
      // Ignore when container is hidden (display:none gives 0 width)
      if (w === 0) return
      const mobile = w < COLLAPSE_BREAKPOINT
      setIsMobile(mobile)
      if (mobile) setSourceBinCollapsed(true)
    }
    check()
    const ro = new ResizeObserver(check)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Resizable source bin
  const resizing = useRef(false)
  const handleSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizing.current = true
      const startX = e.clientX
      const startWidth = sourceBinWidth

      const onMove = (ev: MouseEvent): void => {
        if (!resizing.current) return
        const newWidth = Math.max(140, Math.min(400, startWidth + ev.clientX - startX))
        setSourceBinWidth(newWidth)
      }
      const onUp = (): void => {
        resizing.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sourceBinWidth]
  )

  // Touch-friendly splitter
  const handleSplitterTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      const startX = touch.clientX
      const startWidth = sourceBinWidth

      const onTouchMove = (ev: TouchEvent): void => {
        const t = ev.touches[0]
        if (!t) return
        const newWidth = Math.max(140, Math.min(400, startWidth + t.clientX - startX))
        setSourceBinWidth(newWidth)
      }
      const onTouchEnd = (): void => {
        window.removeEventListener('touchmove', onTouchMove)
        window.removeEventListener('touchend', onTouchEnd)
      }
      window.addEventListener('touchmove', onTouchMove, { passive: true })
      window.addEventListener('touchend', onTouchEnd)
    },
    [sourceBinWidth]
  )

  // Resizable transform panel (drag from left edge)
  const handleTransformSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = transformPanelWidth

      const onMove = (ev: MouseEvent): void => {
        const newWidth = Math.max(180, Math.min(400, startWidth - (ev.clientX - startX)))
        setTransformPanelWidth(newWidth)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [transformPanelWidth]
  )

  // Resizable timeline (drag top edge)
  const handleTimelineSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = timelineHeight

      const onMove = (ev: MouseEvent): void => {
        const newH = Math.max(140, Math.min(600, startH - (ev.clientY - startY)))
        setTimelineHeight(newH)
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [timelineHeight]
  )

  // Selected clip info
  const selectedClip = selectedClipIds.length === 1
    ? timeline.clips.find((c) => c.id === selectedClipIds[0])
    : null

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Top section: Source Bin + Preview + Transform */}
      <div className={`flex ${isMobile ? 'flex-col' : ''} flex-1 min-h-0 overflow-hidden`}>
        {/* Source Bin */}
        {!sourceBinCollapsed && (
          <>
            <div
              style={isMobile ? { height: 200 } : { width: sourceBinWidth, minWidth: sourceBinWidth }}
              className={`flex-shrink-0 ${isMobile ? 'border-b border-white/5' : ''}`}
            >
              <SourceBin />
            </div>
            {/* Splitter (desktop only) */}
            {!isMobile && (
              <div
                className="v-splitter"
                onMouseDown={handleSplitterMouseDown}
                onTouchStart={handleSplitterTouchStart}
              />
            )}
          </>
        )}

        {/* Preview area */}
        <div className="flex-1 flex min-w-0 relative">
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 min-h-0">
              <Preview />
            </div>
            {/* Compact icon button bar under preview */}
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 border-t border-white/5">
              {/* Left: source toggle */}
              <FixedTip label={sourceBinCollapsed ? 'Show sources' : 'Hide sources'}>
                <button
                  onClick={() => setSourceBinCollapsed(!sourceBinCollapsed)}
                  className={`icon-btn ${!sourceBinCollapsed ? 'active' : ''}`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="1" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M9 4h6M9 8h6M9 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </FixedTip>

              <div className="w-px h-4 bg-white/[0.06] mx-0.5" />

              {/* Center: transport controls */}
              <FixedTip label="Go to start">
                <button
                  onClick={() => useEditorStore.getState().seek(0)}
                  className="icon-btn"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M3 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M13 3L6 8l7 5V3z" fill="currentColor" opacity="0.8" />
                  </svg>
                </button>
              </FixedTip>
              <FixedTip label={playback.isPlaying ? 'Pause (Space)' : 'Play (Space)'}>
                <button
                  onClick={() => { const s = useEditorStore.getState(); s.playback.isPlaying ? s.pause() : s.play() }}
                  className={`icon-btn ${playback.isPlaying ? 'active' : ''}`}
                >
                  {playback.isPlaying ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <rect x="3" y="2" width="3.5" height="12" rx="0.75" />
                      <rect x="9.5" y="2" width="3.5" height="12" rx="0.75" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4 2.5v11l9-5.5L4 2.5z" />
                    </svg>
                  )}
                </button>
              </FixedTip>

              <div className="flex-1" />

              {/* Right: transform + export */}
              <FixedTip label={transformPanelOpen ? 'Hide transform' : 'Show transform'}>
                <button
                  onClick={() => setTransformPanelOpen(!transformPanelOpen)}
                  className={`icon-btn ${transformPanelOpen ? 'active' : ''}`}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
                    <circle cx="2" cy="2" r="1.5" fill="currentColor" />
                    <circle cx="14" cy="2" r="1.5" fill="currentColor" />
                    <circle cx="2" cy="14" r="1.5" fill="currentColor" />
                    <circle cx="14" cy="14" r="1.5" fill="currentColor" />
                    <path d="M6 8h4M8 6v4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                  </svg>
                </button>
              </FixedTip>
              <FixedTip label="Export timeline">
                <button
                  onClick={() => setExportOpen(true)}
                  className="icon-btn text-emerald-400 hover:text-emerald-300"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </button>
              </FixedTip>
            </div>
          </div>

          {/* Transform Inspector panel (right sidebar, resizable) */}
          {transformPanelOpen && !isMobile && (
            <>
              <div
                className="v-splitter"
                onMouseDown={handleTransformSplitterMouseDown}
              />
              <div
                style={{ width: transformPanelWidth, minWidth: transformPanelWidth }}
                className="shrink-0 overflow-y-auto overflow-x-hidden bg-surface-900/80 border-l border-white/[0.04]"
              >
                <div className="p-2.5">
                  <TransformInspector />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <Toolbar
        onZoomIn={coords.zoomIn}
        onZoomOut={coords.zoomOut}
        onFitToView={() => coords.fitToView(timeline.duration || 1800, 800)}
      />

      {/* Timeline splitter + Timeline */}
      <div className="h-splitter" onMouseDown={handleTimelineSplitterMouseDown} />
      <div className="flex flex-col overflow-hidden" style={{ height: timelineHeight, minHeight: 140 }}>
        <Timeline />
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-2 sm:gap-4 px-2 sm:px-3 py-1 border-t border-white/5 text-[10px] text-surface-500 bg-surface-900/60 flex-wrap">
        <span>
          {selectedClipIds.length > 0
            ? `${selectedClipIds.length} clip${selectedClipIds.length > 1 ? 's' : ''} selected`
            : 'No selection'}
        </span>
        {selectedClip && !isMobile && (
          <>
            <span>In: {formatTimecode(selectedClip.sourceIn, frameRate)}</span>
            <span>Out: {formatTimecode(selectedClip.sourceOut, frameRate)}</span>
            <span>
              Dur: {formatTimecode(
                (selectedClip.sourceOut - selectedClip.sourceIn) / selectedClip.speed,
                frameRate
              )}
            </span>
            <span className="border-l border-white/10 pl-2 sm:pl-3">
              <ClipInspector clip={selectedClip} />
            </span>
          </>
        )}
        <span className="ml-auto">
          {timeline.tracks.length} tracks · {timeline.clips.length} clips
        </span>
      </div>

      {/* Export dialog */}
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  )
}
