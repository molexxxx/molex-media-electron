/**
 * @module editor/edit/Timeline
 * The multi-track timeline: the ruler, the track headers beside their lanes, the clips, and the playhead. It moves
 * clips with snapping and a ghost at the drop place, draws a marquee from the empty lanes, takes sources dragged
 * from the source bin, and zooms with Ctrl and the wheel or pans with Shift and the wheel. The band above the ruler
 * takes the height splitter's hit area, which reaches 21 px into the pane it sizes, so the ruler stays reachable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { useTimelineSnap } from '../hooks/useTimelineSnap'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import type { TimelineClip, TimelineTrack } from '../types'
import { Playhead } from './Playhead'
import { Ruler } from './Ruler'
import { Track } from './Track'
import { TrackHeader } from './TrackHeader'

/** The track header column's width in px. */
export const HEADER_WIDTH = 184

interface MarqueeState
{
  startX: number
  startY: number
  currentX: number
  currentY: number
}

function clipDur(clip: TimelineClip): number
{
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

/** Video tracks top down from the highest index, then audio tracks from the lowest. */
export function sortTracks(tracks: readonly TimelineTrack[]): TimelineTrack[]
{
  const video = tracks.filter((t) => t.type === 'video').sort((a, b) => b.index - a.index)
  const audio = tracks.filter((t) => t.type === 'audio').sort((a, b) => a.index - b.index)
  return [...video, ...audio]
}

let pendingDropSourceId: string | null = null

/** Remembers the source the source bin is dragging, since drag data cannot be read before the drop. */
export function setPendingDropSource(sourceId: string): void
{
  pendingDropSourceId = sourceId
}

/** Forgets the dragged source once its drag ends. */
export function clearPendingDropSource(): void
{
  pendingDropSourceId = null
}

/** Props of {@link Timeline}. */
export interface TimelineProps
{
  coords: TimelineCoords
}

/** The timeline. */
export function Timeline({ coords }: TimelineProps): ReactElement
{
  const timeline = useEditorStore((s) => s.timeline)
  const sources = useEditorStore((s) => s.sources)
  const selectedTrackId = useEditorStore((s) => s.selectedTrackId)
  const selectTrack = useEditorStore((s) => s.selectTrack)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const moveClip = useEditorStore((s) => s.moveClip)
  const addClip = useEditorStore((s) => s.addClip)
  const addTrack = useEditorStore((s) => s.addTrack)
  const snap = useTimelineSnap()

  const containerRef = useRef<HTMLDivElement>(null)
  const trackAreaRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [laneWidth, setLaneWidth] = useState(800)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)

  useEffect(() =>
  {
    const element = containerRef.current
    if (!element)
    {
      return
    }
    const observer = new ResizeObserver((entries) =>
    {
      setLaneWidth(Math.max(0, (entries[0]?.contentRect.width ?? 0) - HEADER_WIDTH))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const sortedTracks = useMemo(() => sortTracks(timeline.tracks), [timeline.tracks])
  const totalHeight = useMemo(() => sortedTracks.reduce((sum, t) => sum + t.height, 0), [sortedTracks])
  const clipsByTrack = useMemo(() =>
  {
    const map = new Map<string, TimelineClip[]>()
    for (const clip of timeline.clips)
    {
      map.set(clip.trackId, [...(map.get(clip.trackId) ?? []), clip])
    }
    return map
  }, [timeline.clips])

  useEffect(() =>
  {
    const element = scrollRef.current
    if (!element)
    {
      return
    }
    const onWheel = (event: WheelEvent): void =>
    {
      if (event.ctrlKey || event.metaKey)
      {
        event.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect)
        {
          coords.handleWheelZoom(event as unknown as React.WheelEvent, rect.left + HEADER_WIDTH)
        }
      }
      else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))
      {
        event.preventDefault()
        const delta = event.shiftKey ? event.deltaY : event.deltaX
        const { scrollX, scrollY, setScroll } = useEditorStore.getState()
        setScroll(Math.max(0, scrollX + (delta / coords.zoom) * coords.frameRate * 3), scrollY)
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [coords])

  const trackAt = useCallback((y: number): { track: TimelineTrack, top: number } | null =>
  {
    let top = 0
    for (const track of sortedTracks)
    {
      if (y >= top && y < top + track.height)
      {
        return { track, top }
      }
      top += track.height
    }
    return null
  }, [sortedTracks])

  const topOf = useCallback((trackId: string): number =>
  {
    let top = 0
    for (const track of sortedTracks)
    {
      if (track.id === trackId)
      {
        return top
      }
      top += track.height
    }
    return 0
  }, [sortedTracks])

  const handleClipDragStart = useCallback((clipId: string, event: MouseEvent) =>
  {
    const clip = timeline.clips.find((c) => c.id === clipId)
    const area = trackAreaRef.current
    if (!clip || clip.locked || !area)
    {
      return
    }
    const rect = area.getBoundingClientRect()
    const offsetFrames = coords.pixelToFrame(event.clientX - rect.left) - clip.timelineStart
    const startX = event.clientX
    const startY = event.clientY
    const sourceType = timeline.tracks.find((t) => t.id === clip.trackId)?.type
    const widthPx = Math.max(4, (clipDur(clip) / coords.frameRate) * coords.zoom)
    const threshold = Math.round((10 / coords.zoom) * coords.frameRate)
    let target: { frame: number, trackId: string } | null = null

    const onMove = (moveEvent: globalThis.MouseEvent): void =>
    {
      if (target === null && Math.abs(moveEvent.clientX - startX) < 3 && Math.abs(moveEvent.clientY - startY) < 3)
      {
        return
      }
      let frame = coords.pixelToFrame(moveEvent.clientX - rect.left) - offsetFrames
      const snapped = snap.findSnap(frame, threshold, [clip.id])
      if (snapped !== null)
      {
        frame = snapped
      }
      else
      {
        const end = snap.findSnap(frame + clipDur(clip), threshold, [clip.id])
        if (end !== null)
        {
          frame = end - clipDur(clip)
        }
      }
      snap.showSnapIndicator(snapped ?? null)
      let trackId = clip.trackId
      let top = topOf(clip.trackId)
      const hit = trackAt(moveEvent.clientY - rect.top)
      if (hit && hit.track.type === sourceType)
      {
        trackId = hit.track.id
        top = hit.top
      }
      target = { frame: Math.max(0, frame), trackId }
      const ghost = ghostRef.current
      if (ghost)
      {
        const height = sortedTracks.find((t) => t.id === trackId)?.height ?? 0
        ghost.style.left = `${coords.frameToPixel(target.frame)}px`
        ghost.style.top = `${top + 2}px`
        ghost.style.width = `${widthPx}px`
        ghost.style.height = `${Math.max(0, height - 4)}px`
        ghost.hidden = false
      }
    }

    const onUp = (): void =>
    {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (target !== null)
      {
        moveClip(clipId, target.trackId, target.frame)
      }
      snap.showSnapIndicator(null)
      if (ghostRef.current)
      {
        ghostRef.current.hidden = true
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [timeline, coords, snap, sortedTracks, moveClip, trackAt, topOf])

  const handleAreaMouseDown = useCallback((event: MouseEvent) =>
  {
    const target = event.target as HTMLElement
    if (event.button !== 0 || (target !== event.currentTarget && !target.classList.contains('track-lane')))
    {
      return
    }
    clearSelection()
    const rect = trackAreaRef.current?.getBoundingClientRect()
    if (!rect)
    {
      return
    }
    const startX = event.clientX - rect.left
    const startY = event.clientY - rect.top
    setMarquee({ startX, startY, currentX: startX, currentY: startY })

    const onMove = (moveEvent: globalThis.MouseEvent): void =>
    {
      setMarquee((prev) => (prev ? { ...prev, currentX: moveEvent.clientX - rect.left, currentY: moveEvent.clientY - rect.top } : null))
    }

    const onUp = (): void =>
    {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setMarquee((prev) =>
      {
        if (!prev)
        {
          return null
        }
        const x1 = Math.min(prev.startX, prev.currentX)
        const x2 = Math.max(prev.startX, prev.currentX)
        const y1 = Math.min(prev.startY, prev.currentY)
        const y2 = Math.max(prev.startY, prev.currentY)
        const { clips } = useEditorStore.getState().timeline
        const hits: string[] = []
        let top = 0
        for (const track of sortedTracks)
        {
          for (const clip of clips)
          {
            if (clip.trackId !== track.id)
            {
              continue
            }
            const left = coords.frameToPixel(clip.timelineStart)
            const right = left + (clipDur(clip) / coords.frameRate) * coords.zoom
            if (right > x1 && left < x2 && top + track.height > y1 && top < y2)
            {
              hits.push(clip.id)
            }
          }
          top += track.height
        }
        if (hits.length > 0)
        {
          useEditorStore.setState({ selectedClipIds: hits })
        }
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [clearSelection, coords, sortedTracks])

  const handleTrackDrop = useCallback((trackId: string, frame: number): boolean =>
  {
    const sourceId = pendingDropSourceId
    pendingDropSourceId = null
    const source = sourceId ? useEditorStore.getState().sources.find((s) => s.id === sourceId) : undefined
    if (!source || !timeline.tracks.some((t) => t.id === trackId))
    {
      return false
    }
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
    return true
  }, [timeline.tracks, addClip])

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel pt-5"
      onTouchStart={(event) =>
      {
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect)
        {
          coords.handleTouchStart(event, rect.left + HEADER_WIDTH)
        }
      }}
    >
      <Ruler coords={coords} width={laneWidth} headerWidth={HEADER_WIDTH} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-x-hidden overflow-y-auto">
          <div className="flex" style={{ minHeight: totalHeight }}>
            <div className="flex shrink-0 flex-col border-e border-line bg-panel" style={{ width: HEADER_WIDTH }}>
              {sortedTracks.map((track) => (
                <TrackHeader key={track.id} track={track} isSelected={selectedTrackId === track.id} onSelect={() => selectTrack(track.id)} />
              ))}
              <div className="flex flex-col items-start gap-0.5 px-1 py-1.5">
                <Button variant="ghost" size="sm" icon="editor.add" onClick={() => addTrack('video')}>Add video track</Button>
                <Button variant="ghost" size="sm" icon="editor.add" onClick={() => addTrack('audio')}>Add audio track</Button>
              </div>
            </div>
            <div ref={trackAreaRef} data-track-area className="relative min-w-0 flex-1" onMouseDown={handleAreaMouseDown}>
              {sortedTracks.map((track) => (
                <Track
                  key={track.id}
                  track={track}
                  clips={clipsByTrack.get(track.id) ?? []}
                  sources={sources}
                  coords={coords}
                  isSelected={selectedTrackId === track.id}
                  onClipDragStart={handleClipDragStart}
                  onTrackDrop={handleTrackDrop}
                />
              ))}
              {timeline.clips.length === 0 && (
                <p className="pointer-events-none absolute start-3 text-body text-ink-3" style={{ top: totalHeight + 12 }}>
                  Drag a source onto a track, or select a source and choose Append.
                </p>
              )}
              <Playhead coords={coords} height={totalHeight} />
              <div ref={ghostRef} hidden data-drag-ghost className="pointer-events-none absolute rounded-xs bg-wash-selected outline-1 -outline-offset-1 outline-accent-ink" />
              {snap.snapIndicator !== null && (
                <div
                  aria-hidden="true"
                  data-snap-line
                  className="pointer-events-none absolute top-0 z-sticky w-px bg-accent-ink"
                  style={{ left: coords.frameToPixel(snap.snapIndicator), height: totalHeight }}
                />
              )}
              {marquee && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute z-sticky border border-accent-ink bg-wash-selected"
                  style={{
                    left: Math.min(marquee.startX, marquee.currentX),
                    top: Math.min(marquee.startY, marquee.currentY),
                    width: Math.abs(marquee.currentX - marquee.startX),
                    height: Math.abs(marquee.currentY - marquee.startY)
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
