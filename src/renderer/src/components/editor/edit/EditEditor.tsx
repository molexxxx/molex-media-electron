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
import { formatTimecode } from '../shared/TimeDisplay'

/** Breakpoint for auto-collapsing source bin */
const COLLAPSE_BREAKPOINT = 768

export function EditEditor(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)

  const coords = useTimelineZoom()
  useTimelineKeyboard({ coords })

  const [sourceBinWidth, setSourceBinWidth] = useState(220)
  const [sourceBinCollapsed, setSourceBinCollapsed] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Auto-collapse source bin on small screens
  useEffect(() => {
    const check = (): void => {
      const w = containerRef.current?.clientWidth ?? window.innerWidth
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

  // Selected clip info
  const selectedClip = selectedClipIds.length === 1
    ? timeline.clips.find((c) => c.id === selectedClipIds[0])
    : null

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Top section: Source Bin + Preview */}
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
                className="w-1.5 cursor-col-resize bg-white/5 hover:bg-accent-500/30 active:bg-accent-500/40 transition-colors flex-shrink-0 touch:w-3"
                onMouseDown={handleSplitterMouseDown}
                onTouchStart={handleSplitterTouchStart}
              />
            )}
          </>
        )}

        {/* Preview area */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex-1 min-h-0">
            <Preview />
          </div>
          {/* Controls bar under preview */}
          <div className="flex items-center justify-between px-2 py-1 border-t border-white/5">
            <button
              onClick={() => setSourceBinCollapsed(!sourceBinCollapsed)}
              title={sourceBinCollapsed ? 'Show source bin' : 'Hide source bin'}
              className="text-[10px] text-surface-500 hover:text-surface-300 px-2 py-1 border border-white/10 rounded transition-colors min-h-[32px]"
            >
              {sourceBinCollapsed ? 'Show Sources' : 'Hide Sources'}
            </button>
            <button
              onClick={() => setExportOpen(true)}
              title="Export timeline"
              className="px-3 py-1.5 text-[11px] rounded bg-accent-500/15 text-accent-200 hover:bg-accent-500/25 transition-colors border border-accent-500/20 min-h-[32px]"
            >
              Export
            </button>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <Toolbar
        onZoomIn={coords.zoomIn}
        onZoomOut={coords.zoomOut}
        onFitToView={() => coords.fitToView(timeline.duration || 1800, 800)}
      />

      {/* Timeline */}
      <div className="flex flex-col flex-1 min-h-[160px] sm:min-h-[200px] overflow-hidden">
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
