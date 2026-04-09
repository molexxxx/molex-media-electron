/**
 * @module editor/edit/Timeline
 * Multi-track timeline container with zoom/scroll, ruler, tracks, clips, and playhead.
 * Handles marquee selection, clip dragging, and source drops.
 */
import React, { useCallback, useRef, useState, useMemo, useEffect } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { useTimelineZoom } from '../hooks/useTimelineZoom'
import { useTimelineSnap } from '../hooks/useTimelineSnap'
import { Ruler } from './Ruler'
import { TrackHeader } from './TrackHeader'
import { Track } from './Track'
import { Playhead } from './Playhead'

const HEADER_WIDTH = 140

interface DragState {
  clipId: string
  startFrame: number
  startTrackId: string
  offsetFrames: number // click offset within the clip
}

interface MarqueeState {
  startX: number
  startY: number
  currentX: number
  currentY: number
}

export function Timeline(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const selectedTrackId = useEditorStore((s) => s.selectedTrackId)
  const selectTrack = useEditorStore((s) => s.selectTrack)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const moveClip = useEditorStore((s) => s.moveClip)
  const addClip = useEditorStore((s) => s.addClip)
  const addTrack = useEditorStore((s) => s.addTrack)

  const coords = useTimelineZoom()
  const snap = useTimelineSnap()

  const containerRef = useRef<HTMLDivElement>(null)
  const trackAreaRef = useRef<HTMLDivElement>(null)
  const scrollWrapperRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [, setDrag] = useState<DragState | null>(null)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const dragGhost = useRef<{ frame: number; trackId: string } | null>(null)

  // Track container size
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width - HEADER_WIDTH)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Sort tracks: video (highest index first), then audio (lowest index first)
  const sortedTracks = useMemo(() => {
    const videoTracks = timeline.tracks
      .filter((t) => t.type === 'video')
      .sort((a, b) => b.index - a.index)
    const audioTracks = timeline.tracks
      .filter((t) => t.type === 'audio')
      .sort((a, b) => a.index - b.index)
    return [...videoTracks, ...audioTracks]
  }, [timeline.tracks])

  const clipsForTrack = useCallback(
    (trackId: string) => timeline.clips.filter((c) => c.trackId === trackId),
    [timeline.clips]
  )

  const totalHeight = useMemo(
    () => sortedTracks.reduce((sum, t) => sum + t.height, 0),
    [sortedTracks]
  )

  // Wheel handler: Ctrl = zoom, Shift/deltaX = horizontal scroll, plain = native vertical
  // Attached as a native non-passive listener so preventDefault works for zoom/hscroll.
  useEffect(() => {
    const el = scrollWrapperRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) coords.handleWheelZoom(e as unknown as React.WheelEvent, rect.left + HEADER_WIDTH)
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        const delta = e.shiftKey ? e.deltaY : e.deltaX
        const { scrollX: sx, scrollY: sy, setScroll } = useEditorStore.getState()
        const frameDelta = (delta / coords.zoom) * coords.frameRate * 3
        setScroll(Math.max(0, sx + frameDelta), sy)
      }
      // Plain vertical scroll: let native overflow-y-auto handle it
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [coords])

  // --- Clip dragging ---
  const handleClipDragStart = useCallback(
    (clipId: string, e: React.MouseEvent) => {
      const clip = timeline.clips.find((c) => c.id === clipId)
      if (!clip || clip.locked) return
      const trackArea = trackAreaRef.current
      if (!trackArea) return

      const rect = trackArea.getBoundingClientRect()
      const px = e.clientX - rect.left
      const clickFrame = coords.pixelToFrame(px)
      const offsetFrames = clickFrame - clip.timelineStart

      setDrag({ clipId, startFrame: clip.timelineStart, startTrackId: clip.trackId, offsetFrames })

      const onMove = (ev: MouseEvent): void => {
        const px2 = ev.clientX - rect.left
        let targetFrame = coords.pixelToFrame(px2) - offsetFrames

        // Snap
        const snapped = snap.findSnap(targetFrame, Math.round(10 / coords.zoom * coords.frameRate))
        if (snapped !== null) targetFrame = snapped

        // Determine target track from Y
        let cumY = 0
        let targetTrackId = clip.trackId
        const py = ev.clientY - rect.top
        for (const t of sortedTracks) {
          if (py >= cumY && py < cumY + t.height) {
            // Only allow same-type track drops
            if (t.type === timeline.tracks.find((tr) => tr.id === clip.trackId)?.type) {
              targetTrackId = t.id
            }
            break
          }
          cumY += t.height
        }

        dragGhost.current = { frame: Math.max(0, targetFrame), trackId: targetTrackId }
        // Use direct DOM update for the ghost preview
        const ghostEl = document.getElementById('drag-ghost')
        if (ghostEl) {
          const left = coords.frameToPixel(Math.max(0, targetFrame))
          ghostEl.style.left = `${left}px`
          ghostEl.style.display = 'block'
        }
      }

      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        if (dragGhost.current) {
          moveClip(clipId, dragGhost.current.trackId, dragGhost.current.frame)
        }
        setDrag(null)
        dragGhost.current = null
        const ghostEl = document.getElementById('drag-ghost')
        if (ghostEl) ghostEl.style.display = 'none'
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [timeline, coords, snap, sortedTracks, moveClip]
  )

  // --- Marquee selection ---
  const handleTrackAreaMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('track-lane')) return
      if (e.button !== 0) return

      clearSelection()
      const rect = trackAreaRef.current?.getBoundingClientRect()
      if (!rect) return
      const startX = e.clientX - rect.left
      const startY = e.clientY - rect.top
      setMarquee({ startX, startY, currentX: startX, currentY: startY })

      const onMove = (ev: MouseEvent): void => {
        setMarquee((prev) =>
          prev ? { ...prev, currentX: ev.clientX - rect.left, currentY: ev.clientY - rect.top } : null
        )
      }

      const onUp = (_ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)

        setMarquee((prev) => {
          if (!prev) return null
          const x1 = Math.min(prev.startX, prev.currentX)
          const x2 = Math.max(prev.startX, prev.currentX)
          const y1 = Math.min(prev.startY, prev.currentY)
          const y2 = Math.max(prev.startY, prev.currentY)

          // Hit-test clips
          let cumY = 0
          const { clips } = useEditorStore.getState().timeline
          const hitIds: string[] = []
          for (const t of sortedTracks) {
            const trackClips = clips.filter((c) => c.trackId === t.id)
            for (const clip of trackClips) {
              const dur = (clip.sourceOut - clip.sourceIn) / clip.speed
              const clipLeft = coords.frameToPixel(clip.timelineStart)
              const clipRight = clipLeft + (dur / coords.frameRate) * coords.zoom
              const clipTop = cumY
              const clipBottom = cumY + t.height

              if (clipRight > x1 && clipLeft < x2 && clipBottom > y1 && clipTop < y2) {
                hitIds.push(clip.id)
              }
            }
            cumY += t.height
          }

          if (hitIds.length > 0) {
            useEditorStore.setState({ selectedClipIds: hitIds })
          }
          return null
        })
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [clearSelection, coords, sortedTracks]
  )

  // --- Source bin drops onto timeline ---
  const handleTrackDrop = useCallback(
    (trackId: string, frame: number) => {
      // sourceId comes from dataTransfer, set by SourceBin drag
      // Read from a module-level variable set during dragStart
      const sourceId = _pendingDropSourceId
      if (!sourceId) return
      _pendingDropSourceId = null

      const source = useEditorStore.getState().sources.find((s) => s.id === sourceId)
      if (!source) return

      const track = timeline.tracks.find((t) => t.id === trackId)
      if (!track) return

      addClip({
        sourceId: source.id,
        trackId,
        timelineStart: Math.max(0, frame),
        sourceIn: 0,
        sourceOut: source.duration,
        name: source.fileName,
        color: '',
        muted: false,
        locked: false,
        volume: 1,
        pan: 0,
        speed: 1
      })
    },
    [timeline.tracks, addClip]
  )

  return (
    <div
      ref={containerRef}
      className="flex flex-col flex-1 overflow-hidden"
      onTouchStart={(e) => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) coords.handleTouchStart(e, rect.left + HEADER_WIDTH)
      }}
    >
      {/* Ruler */}
      <Ruler coords={coords} width={containerWidth} headerWidth={HEADER_WIDTH} />

      {/* Tracks area */}
      <div className="flex-1 overflow-hidden relative">
        {/* Scroll wrapper - plain block with overflow-y so content height drives scrollbar */}
        <div
          className="h-full overflow-y-auto overflow-x-hidden"
          ref={scrollWrapperRef}
        >
          {/* Inner flex row keeps headers + tracks aligned */}
          <div className="flex" style={{ minHeight: totalHeight }}>
            {/* Headers */}
            <div
              className="flex flex-col flex-shrink-0 border-r border-white/5"
              style={{ width: HEADER_WIDTH }}
            >
              {sortedTracks.map((track) => (
                <TrackHeader
                  key={track.id}
                  track={track}
                  isSelected={selectedTrackId === track.id}
                  onSelect={() => selectTrack(track.id)}
                />
              ))}
              {/* Add track buttons */}
              <div className="flex gap-1 px-2 py-1.5">
                <button
                  onClick={() => addTrack('video')}
                  className="text-[10px] text-surface-500 hover:text-surface-300 px-1"
                  title="Add video track"
                >
                  +V
                </button>
                <button
                  onClick={() => addTrack('audio')}
                  className="text-[10px] text-surface-500 hover:text-surface-300 px-1"
                  title="Add audio track"
                >
                  +A
                </button>
              </div>
            </div>

            {/* Track lanes */}
            <div
              ref={trackAreaRef}
              className="flex-1 relative"
              onMouseDown={handleTrackAreaMouseDown}
            >
          {sortedTracks.map((track) => (
            <Track
              key={track.id}
              track={track}
              clips={clipsForTrack(track.id)}
              sources={sources}
              coords={coords}
              onClipDragStart={handleClipDragStart}
              onTrackDrop={handleTrackDrop}
            />
          ))}

          {/* Playhead */}
          <Playhead coords={coords} height={totalHeight} trackAreaRef={trackAreaRef} />

          {/* Drag ghost */}
          <div
            id="drag-ghost"
            className="absolute top-0 h-full bg-accent-400/20 border border-accent-400/40 rounded-sm pointer-events-none"
            style={{ display: 'none', width: 60 }}
          />

          {/* Snap indicator line */}
          {snap.snapIndicator !== null && (
            <div
              className="absolute top-0 w-px bg-green-400/80 pointer-events-none z-30"
              style={{
                left: coords.frameToPixel(snap.snapIndicator),
                height: totalHeight
              }}
            />
          )}

          {/* Marquee */}
          {marquee && (
            <div
              className="absolute border border-accent-400/60 bg-accent-400/10 pointer-events-none z-30"
              style={{
                left: Math.min(marquee.startX, marquee.currentX),
                top: Math.min(marquee.startY, marquee.currentY),
                width: Math.abs(marquee.currentX - marquee.startX),
                height: Math.abs(marquee.currentY - marquee.startY)
              }}
            />
          )}
        </div>
        {/* close inner flex row */}
        </div>
        {/* close scroll wrapper */}
        </div>
      </div>
    </div>
  )
}

// Module-level helper for cross-component drag data (avoids dataTransfer serialization issues)
let _pendingDropSourceId: string | null = null
export function setPendingDropSource(sourceId: string): void {
  _pendingDropSourceId = sourceId
}
export function clearPendingDropSource(): void {
  _pendingDropSourceId = null
}
