/**
 * @module editor/edit/Clip
 * Renders a single clip rectangle on the timeline at the correct position/width.
 * Handles selection, context menu, drag initiation, and context-sensitive trim cursor.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { TimelineClip, MediaSource } from '../types'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import { useTimelineDrag, type TrimCursor } from '../hooks/useTimelineDrag'
import { Waveform } from '../shared/Waveform'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'

// Auto-assigned clip colours keyed by sourceId (hue rotation)
const SOURCE_COLORS: Record<string, string> = {}
let _hue = 210
function colorForSource(sourceId: string): string {
  if (!SOURCE_COLORS[sourceId]) {
    SOURCE_COLORS[sourceId] = `hsl(${_hue}, 55%, 50%)`
    _hue = (_hue + 47) % 360
  }
  return SOURCE_COLORS[sourceId]
}

/** Map trim cursor type to CSS cursor value. */
function cursorForTrim(trimType: TrimCursor, altHeld: boolean, shiftHeld: boolean): string {
  if (trimType === 'default') {
    if (altHeld && shiftHeld) return 'ew-resize' // slide
    if (altHeld) return 'grab' // slip
    return 'default'
  }
  if (trimType === 'roll') return 'col-resize'
  if (trimType === 'ripple-in') return 'w-resize'
  return 'e-resize' // ripple-out
}

interface ClipProps {
  clip: TimelineClip
  coords: TimelineCoords
  source?: MediaSource
  trackType: 'video' | 'audio'
  onDragStart: (clipId: string, e: React.MouseEvent) => void
}

export function TimelineClipComponent({ clip, coords, source, trackType, onDragStart }: ClipProps): React.JSX.Element {
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const selectClip = useEditorStore((s) => s.selectClip)
  const splitClip = useEditorStore((s) => s.splitClip)
  const activeTool = useEditorStore((s) => s.activeTool)

  const clipRef = useRef<HTMLDivElement>(null)
  const [clipSize, setClipSize] = useState<{ w: number; h: number } | null>(null)
  const { detectTrimCursor, startTrimDrag } = useTimelineDrag()

  const isSelected = selectedClipIds.includes(clip.id)
  const duration = (clip.sourceOut - clip.sourceIn) / clip.speed
  const left = coords.frameToPixel(clip.timelineStart)
  const width = Math.max(4, (duration / coords.frameRate) * coords.zoom)
  const bg = clip.color || colorForSource(clip.sourceId)

  // Track rendered clip size for waveform/thumbnail
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    clipRef.current = node
    if (!node) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setClipSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) })
    })
    ro.observe(node)
  }, [])

  // Determine whether to show waveform or thumbnails
  const showWaveform = trackType === 'audio' && source?.filePath
  const showThumbnails = trackType === 'video' && source?.filePath && source.width > 0

  // --- Context-sensitive cursor for trim tool ---
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool !== 'trim' || !clipRef.current) return
      const rect = clipRef.current.getBoundingClientRect()
      const px = e.clientX - rect.left
      const trimCursor = detectTrimCursor(clip, px, rect.width)
      clipRef.current.style.cursor = cursorForTrim(trimCursor, e.altKey, e.shiftKey)
    },
    [activeTool, clip, detectTrimCursor]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (e.button !== 0) return

      // Razor tool: split at click position
      if (activeTool === 'razor') {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const px = e.clientX - rect.left
        const frame = clip.timelineStart + Math.round((px / width) * duration)
        splitClip(clip.id, frame)
        return
      }

      // Trim tool: detect trim type and start trim drag
      if (activeTool === 'trim') {
        selectClip(clip.id, false)

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const px = e.clientX - rect.left
        const edgeThreshold = 10
        const { timeline } = useEditorStore.getState()
        const trackClips = timeline.clips.filter((c) => c.trackId === clip.trackId)

        // Check modifier keys for slip/slide
        if (e.altKey && e.shiftKey) {
          startTrimDrag(clip, 'slide', e, coords)
          return
        }
        if (e.altKey) {
          startTrimDrag(clip, 'slip', e, coords)
          return
        }

        // Near left edge
        if (px <= edgeThreshold) {
          const adj = findLeftAdjacent(clip, trackClips)
          if (adj) {
            startTrimDrag(clip, 'roll', e, coords, adj.id)
          } else {
            startTrimDrag(clip, 'ripple-in', e, coords)
          }
          return
        }

        // Near right edge
        if (px >= rect.width - edgeThreshold) {
          const adj = findRightAdjacent(clip, trackClips)
          if (adj) {
            startTrimDrag(adj, 'roll', e, coords, clip.id)
          } else {
            startTrimDrag(clip, 'ripple-out', e, coords)
          }
          return
        }

        // Middle of clip - no default trim action, just select
        return
      }

      // Select tool: select and initiate move drag
      selectClip(clip.id, e.ctrlKey || e.metaKey)
      if (activeTool === 'select') {
        onDragStart(clip.id, e)
      }
    },
    [clip, duration, width, activeTool, selectClip, splitClip, onDragStart, startTrimDrag, coords]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!selectedClipIds.includes(clip.id)) {
        selectClip(clip.id, false)
      }
    },
    [clip.id, selectedClipIds, selectClip]
  )

  const style: React.CSSProperties = useMemo(
    () => ({
      position: 'absolute',
      left,
      top: 0,
      width,
      height: '100%',
      backgroundColor: bg,
      opacity: clip.muted ? 0.4 : 1,
      cursor: activeTool === 'razor' ? 'crosshair' : undefined
    }),
    [left, width, bg, clip.muted, activeTool]
  )

  return (
    <div
      ref={measuredRef}
      className={`group rounded-sm overflow-hidden cursor-pointer transition-shadow ${
        isSelected ? 'ring-2 ring-accent-400 shadow-lg shadow-accent-500/20 z-10' : 'hover:ring-1 hover:ring-white/20'
      } ${clip.locked ? 'pointer-events-none opacity-70' : ''}`}
      style={style}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
    >
      {/* Clip name */}
      <div className="relative z-10 px-1.5 py-0.5 text-[10px] font-medium text-white/90 truncate select-none leading-tight drop-shadow-sm">
        {clip.name || source?.fileName || 'Clip'}
      </div>

      {/* Waveform overlay for audio clips */}
      {showWaveform && clipSize && clipSize.w > 8 && (
        <div className="absolute inset-0 top-4 opacity-50 pointer-events-none">
          <Waveform
            filePath={source!.filePath}
            width={clipSize.w}
            height={Math.max(1, clipSize.h - 16)}
            color="rgba(255,255,255,0.5)"
            rangeStart={source!.duration > 0 ? clip.sourceIn / source!.duration : 0}
            rangeEnd={source!.duration > 0 ? clip.sourceOut / source!.duration : 1}
          />
        </div>
      )}

      {/* Thumbnail strip overlay for video clips */}
      {showThumbnails && clipSize && clipSize.w > 20 && (
        <div className="absolute inset-0 opacity-40 pointer-events-none">
          <ThumbnailStrip
            filePath={source!.filePath}
            durationSeconds={source!.durationSeconds}
            width={clipSize.w}
            height={clipSize.h}
            rangeStart={source!.duration > 0 ? clip.sourceIn / source!.duration : 0}
            rangeEnd={source!.duration > 0 ? clip.sourceOut / source!.duration : 1}
          />
        </div>
      )}

      {/* Fallback gradient when no media visual loaded yet */}
      {!showWaveform && !showThumbnails && (
        <div className="absolute inset-0 top-4 opacity-30 pointer-events-none">
          <div className="h-full bg-gradient-to-t from-black/30 to-transparent" />
        </div>
      )}

      {/* Trim edge indicators (visible on hover when trim tool active) */}
      {activeTool === 'trim' && (
        <>
          <div className="absolute left-0 top-0 w-0.75 h-full bg-yellow-400/0 group-hover:bg-yellow-400/40 transition-colors" />
          <div className="absolute right-0 top-0 w-0.75 h-full bg-yellow-400/0 group-hover:bg-yellow-400/40 transition-colors" />
        </>
      )}

      {/* Volume level rubber band (visible on audio clips or when clip selected) */}
      {(trackType === 'audio' || isSelected) && (
        <div
          className="absolute left-0 right-0 h-0.5 pointer-events-none"
          style={{
            bottom: `${Math.max(2, Math.min(95, (clip.volume / 2) * 100))}%`,
            backgroundColor: clip.volume > 1 ? 'rgba(251, 191, 36, 0.7)' : 'rgba(74, 222, 128, 0.6)'
          }}
          title={`Volume: ${Math.round(clip.volume * 100)}%`}
        />
      )}

      {/* Locked overlay */}
      {clip.locked && (
        <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,0.06)_4px,rgba(255,255,255,0.06)_8px)]" />
      )}
    </div>
  )
}

// --- Adjacent clip finders ---

function clipDur(clip: TimelineClip): number {
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

function findLeftAdjacent(clip: TimelineClip, trackClips: TimelineClip[]): TimelineClip | null {
  return (
    trackClips.find((c) => {
      if (c.id === clip.id) return false
      const cEnd = c.timelineStart + clipDur(c)
      return Math.abs(cEnd - clip.timelineStart) <= 1
    }) ?? null
  )
}

function findRightAdjacent(clip: TimelineClip, trackClips: TimelineClip[]): TimelineClip | null {
  const clipEnd = clip.timelineStart + clipDur(clip)
  return (
    trackClips.find((c) => {
      if (c.id === clip.id) return false
      return Math.abs(c.timelineStart - clipEnd) <= 1
    }) ?? null
  )
}
