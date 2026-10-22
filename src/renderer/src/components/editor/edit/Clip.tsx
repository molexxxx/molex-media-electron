/**
 * @module editor/edit/Clip
 * One clip on its track: the clip color from the tokens, thumbnails or a waveform in the viz tokens, its name, the
 * level line, and the selection frame in accent with the selection wash. The Select tool moves it, the Trim tool
 * trims its edges (roll where it touches a neighbor, Alt slips, Alt+Shift slides), and the Split tool cuts it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { cx } from '../../../ui/cx'
import { Icon } from '../../../ui/Icon'
import type { TimelineCoords } from '../hooks/useTimelineZoom'
import { useTimelineDrag, type TrimCursor } from '../hooks/useTimelineDrag'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'
import { Waveform } from '../shared/Waveform'
import type { MediaSource, TimelineClip } from '../types'

/** How close to an edge, in px, the Trim tool trims instead of selecting. */
export const TRIM_EDGE_PX = 10

/** The CSS cursor for a trim at the pointer, with the modifier keys held. */
export function cursorForTrim(trimType: TrimCursor, altHeld: boolean, shiftHeld: boolean): string
{
  if (trimType === 'default')
  {
    if (altHeld && shiftHeld)
    {
      return 'ew-resize'
    }
    return altHeld ? 'grab' : 'default'
  }
  if (trimType === 'roll')
  {
    return 'col-resize'
  }
  return trimType === 'ripple-in' ? 'w-resize' : 'e-resize'
}

interface ClipProps
{
  clip: TimelineClip
  coords: TimelineCoords
  source?: MediaSource
  trackType: 'video' | 'audio'
  onDragStart: (clipId: string, event: MouseEvent) => void
}

function clipDur(clip: TimelineClip): number
{
  return (clip.sourceOut - clip.sourceIn) / clip.speed
}

function findLeftAdjacent(clip: TimelineClip, trackClips: TimelineClip[]): TimelineClip | null
{
  return trackClips.find((c) => c.id !== clip.id && Math.abs(c.timelineStart + clipDur(c) - clip.timelineStart) <= 1) ?? null
}

function findRightAdjacent(clip: TimelineClip, trackClips: TimelineClip[]): TimelineClip | null
{
  const end = clip.timelineStart + clipDur(clip)
  return trackClips.find((c) => c.id !== clip.id && Math.abs(c.timelineStart - end) <= 1) ?? null
}

/** The clip block. */
export function TimelineClipComponent({ clip, coords, source, trackType, onDragStart }: ClipProps): ReactElement
{
  const isSelected = useEditorStore((s) => s.selectedClipIds.includes(clip.id))
  const selectClip = useEditorStore((s) => s.selectClip)
  const splitClip = useEditorStore((s) => s.splitClip)
  const activeTool = useEditorStore((s) => s.activeTool)
  const clipRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number, h: number } | null>(null)
  const { detectTrimCursor, startTrimDrag } = useTimelineDrag()

  const duration = clipDur(clip)
  const left = coords.frameToPixel(clip.timelineStart)
  const width = Math.max(4, (duration / coords.frameRate) * coords.zoom)

  useEffect(() =>
  {
    const element = clipRef.current
    if (!element)
    {
      return
    }
    const observer = new ResizeObserver((entries) =>
    {
      const rect = entries[0]?.contentRect
      if (rect)
      {
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const showWaveform = trackType === 'audio' && Boolean(source?.filePath)
  const showThumbnails = trackType === 'video' && Boolean(source?.filePath) && (source?.width ?? 0) > 0
  const range = source && source.duration > 0
    ? { rangeStart: clip.sourceIn / source.duration, rangeEnd: clip.sourceOut / source.duration }
    : { rangeStart: 0, rangeEnd: 1 }

  const handleMouseMove = useCallback((event: MouseEvent) =>
  {
    const element = clipRef.current
    if (activeTool !== 'trim' || !element)
    {
      return
    }
    const rect = element.getBoundingClientRect()
    element.style.cursor = cursorForTrim(detectTrimCursor(clip, event.clientX - rect.left, rect.width), event.altKey, event.shiftKey)
  }, [activeTool, clip, detectTrimCursor])

  const handleMouseDown = useCallback((event: MouseEvent) =>
  {
    event.stopPropagation()
    if (event.button !== 0)
    {
      return
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const px = event.clientX - rect.left
    if (activeTool === 'razor')
    {
      splitClip(clip.id, clip.timelineStart + Math.round((px / width) * duration))
      return
    }
    if (activeTool === 'trim')
    {
      selectClip(clip.id, false)
      const trackClips = useEditorStore.getState().timeline.clips.filter((c) => c.trackId === clip.trackId)
      if (event.altKey)
      {
        startTrimDrag(clip, event.shiftKey ? 'slide' : 'slip', event, coords)
        return
      }
      if (px <= TRIM_EDGE_PX)
      {
        const neighbor = findLeftAdjacent(clip, trackClips)
        if (neighbor)
        {
          startTrimDrag(clip, 'roll', event, coords, neighbor.id)
        }
        else
        {
          startTrimDrag(clip, 'ripple-in', event, coords)
        }
        return
      }
      if (px >= rect.width - TRIM_EDGE_PX)
      {
        const neighbor = findRightAdjacent(clip, trackClips)
        if (neighbor)
        {
          startTrimDrag(neighbor, 'roll', event, coords, clip.id)
        }
        else
        {
          startTrimDrag(clip, 'ripple-out', event, coords)
        }
      }
      return
    }
    selectClip(clip.id, event.ctrlKey || event.metaKey)
    if (activeTool === 'select')
    {
      onDragStart(clip.id, event)
    }
  }, [clip, duration, width, activeTool, selectClip, splitClip, onDragStart, startTrimDrag, coords])

  const handleContextMenu = useCallback((event: MouseEvent) =>
  {
    event.preventDefault()
    event.stopPropagation()
    if (!useEditorStore.getState().selectedClipIds.includes(clip.id))
    {
      selectClip(clip.id, false)
    }
  }, [clip.id, selectClip])

  const style = useMemo<CSSProperties>(() => ({
    left,
    width,
    backgroundColor: trackType === 'audio' ? 'var(--color-clip-audio)' : 'var(--color-clip-video)',
    cursor: activeTool === 'razor' ? 'crosshair' : undefined
  }), [left, width, trackType, activeTool])

  const name = clip.name || source?.fileName || 'Clip'
  const levelBottom = `${Math.max(2, Math.min(95, (clip.volume / 2) * 100))}%`

  return (
    <div
      ref={clipRef}
      data-clip={clip.id}
      data-selected={isSelected || undefined}
      className={cx(
        'group absolute inset-y-0.5 overflow-hidden rounded-xs',
        isSelected ? 'z-raised outline-2 -outline-offset-2 outline-accent' : 'hover:outline-1 hover:-outline-offset-1 hover:outline-line-control-hover',
        clip.muted && 'opacity-40',
        clip.locked && 'pointer-events-none opacity-70'
      )}
      style={style}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onContextMenu={handleContextMenu}
    >
      {showThumbnails && size && size.w > 20 && source && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-50">
          <ThumbnailStrip filePath={source.filePath} durationSeconds={source.durationSeconds} width={size.w} height={size.h} {...range} />
        </div>
      )}
      {showWaveform && size && size.w > 8 && source && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-5 bottom-0 opacity-70">
          <Waveform filePath={source.filePath} width={size.w} height={Math.max(1, size.h - 20)} tone="onClip" {...range} />
        </div>
      )}
      {isSelected && <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-wash-selected" />}
      <div className="pointer-events-none relative flex min-w-0 items-center gap-1 px-1 pt-0.5">
        <span className="flex min-w-0 items-center gap-1 rounded-xs bg-scrim px-1 text-label font-medium text-ink">
          {clip.locked && <Icon name="status.locked" size="sm" />}
          <span className="truncate">{name}</span>
        </span>
      </div>
      {activeTool === 'trim' && (
        <>
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-0 w-1 bg-transparent group-hover:bg-accent" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 end-0 w-1 bg-transparent group-hover:bg-accent" />
        </>
      )}
      {(trackType === 'audio' || isSelected) && (
        <div
          aria-hidden="true"
          data-level
          className={cx('pointer-events-none absolute inset-x-0 h-0.5', clip.volume > 1 ? 'bg-warning' : 'bg-viz-3')}
          style={{ bottom: levelBottom }}
        />
      )}
    </div>
  )
}
