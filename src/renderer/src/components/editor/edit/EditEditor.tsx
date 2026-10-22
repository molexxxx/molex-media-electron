/**
 * @module editor/edit/EditEditor
 * Timeline mode: the sources pane, the preview with its transport, the clip panel, the toolbar, and the timeline,
 * with a status line under it. The panes resize with splitters and fold away from the transport bar.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useEditorStore } from '../../../stores/editorStore'
import { IconButton } from '../../../ui/IconButton'
import { Splitter } from '../../../ui/Splitter'
import { useTimelineKeyboard } from '../hooks/useTimelineKeyboard'
import { useTimelineZoom } from '../hooks/useTimelineZoom'
import { modalOpen, ownsKey } from '../shared/keys'
import { formatTimecode, Readout } from '../shared/TimeDisplay'
import { ClipInspector } from './ClipInspector'
import { ExportDialog } from './ExportDialog'
import { Preview } from './Preview'
import { SourceBin } from './SourceBin'
import { HEADER_WIDTH, Timeline } from './Timeline'
import { Toolbar } from './Toolbar'

/** Pane size limits in px. */
export const TIMELINE_PANES = {
  sources: { min: 180, default: 240, max: 400 },
  inspector: { min: 260, default: 300, max: 440 },
  timeline: { min: 140, default: 260, max: 600 }
} as const

/** Below this width the side panes start folded. */
const NARROW_WIDTH = 900

/** Timeline mode. */
export function EditEditor(): ReactElement
{
  const coords = useTimelineZoom()
  useTimelineKeyboard({ coords })
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const inPoint = useEditorStore((s) => s.playback.inPoint)
  const outPoint = useEditorStore((s) => s.playback.outPoint)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const duration = useEditorStore((s) => s.timeline.duration)
  const selectedCount = useEditorStore((s) => s.selectedClipIds.length)
  const trackCount = useEditorStore((s) => s.timeline.tracks.length)
  const clipCount = useEditorStore((s) => s.timeline.clips.length)

  const containerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const [sourcesOpen, setSourcesOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [sourcesWidth, setSourcesWidth] = useState<number>(TIMELINE_PANES.sources.default)
  const [inspectorWidth, setInspectorWidth] = useState<number>(TIMELINE_PANES.inspector.default)
  const [timelineHeight, setTimelineHeight] = useState<number>(TIMELINE_PANES.timeline.default)
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() =>
  {
    const width = containerRef.current?.clientWidth ?? 0
    if (width > 0 && width < NARROW_WIDTH)
    {
      setSourcesOpen(false)
    }
  }, [])

  useEffect(() =>
  {
    const onKeyDown = (event: KeyboardEvent): void =>
    {
      if (useAppStore.getState().currentView !== 'editor' || useEditorStore.getState().mode !== 'edit' || modalOpen() || ownsKey(event.target, event.key))
      {
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e')
      {
        event.preventDefault()
        if (useEditorStore.getState().timeline.clips.length > 0)
        {
          setExportOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const togglePlayback = (): void => useEditorStore.getState().togglePlayback()
  const seek = (frame: number): void => useEditorStore.getState().seek(Math.max(0, frame))
  const fitWidth = (timelineRef.current?.clientWidth ?? 800) - HEADER_WIDTH - 24

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {sourcesOpen && (
          <>
            <SourceBin width={sourcesWidth} />
            <Splitter
              label="Sources width"
              value={sourcesWidth}
              min={TIMELINE_PANES.sources.min}
              max={TIMELINE_PANES.sources.max}
              defaultValue={TIMELINE_PANES.sources.default}
              onChange={setSourcesWidth}
            />
          </>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Preview />
          </div>
          <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line bg-panel px-2">
            <IconButton
              label={sourcesOpen ? 'Hide the sources' : 'Show the sources'}
              icon="editor.sources"
              pressed={sourcesOpen}
              onClick={() => setSourcesOpen(!sourcesOpen)}
            />
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
              <IconButton label="Go to the start" icon="editor.toIn" shortcut="Home" onClick={() => seek(0)} />
              <IconButton label="Step back one frame" icon="editor.stepBack" shortcut="Left" onClick={() => seek(currentFrame - 1)} />
              <IconButton label={isPlaying ? 'Pause' : 'Play'} icon={isPlaying ? 'action.pause' : 'action.start'} variant="primary" shortcut="Space" onClick={togglePlayback} />
              <IconButton label="Step forward one frame" icon="editor.stepForward" shortcut="Right" onClick={() => seek(currentFrame + 1)} />
              <IconButton label="Go to the end" icon="editor.toOut" shortcut="End" onClick={() => seek(duration)} />
              <Readout label="Playhead" value={formatTimecode(currentFrame, frameRate)} lit={false} className="ms-3 w-24" />
              {inPoint !== null && <Readout label="In" value={formatTimecode(inPoint, frameRate)} className="w-24" />}
              {outPoint !== null && <Readout label="Out" value={formatTimecode(outPoint, frameRate)} className="w-24" />}
            </div>
            <IconButton
              label={inspectorOpen ? 'Hide the clip panel' : 'Show the clip panel'}
              icon="editor.inspector"
              pressed={inspectorOpen}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            />
          </div>
        </div>
        {inspectorOpen && (
          <>
            <Splitter
              label="Clip panel width"
              pane="after"
              value={inspectorWidth}
              min={TIMELINE_PANES.inspector.min}
              max={TIMELINE_PANES.inspector.max}
              defaultValue={TIMELINE_PANES.inspector.default}
              onChange={setInspectorWidth}
            />
            <ClipInspector width={inspectorWidth} />
          </>
        )}
      </div>
      <Toolbar
        onZoomIn={coords.zoomIn}
        onZoomOut={coords.zoomOut}
        onFitToView={() => coords.fitToView(duration || 1800, fitWidth)}
        onExport={() => setExportOpen(true)}
      />
      <Splitter
        label="Timeline height"
        orientation="horizontal"
        pane="after"
        value={timelineHeight}
        min={TIMELINE_PANES.timeline.min}
        max={TIMELINE_PANES.timeline.max}
        defaultValue={TIMELINE_PANES.timeline.default}
        onChange={setTimelineHeight}
      />
      <div ref={timelineRef} className="flex shrink-0 flex-col overflow-hidden" style={{ height: timelineHeight }}>
        <Timeline coords={coords} />
      </div>
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-label text-ink-3" role="status">
        <span>{selectedCount === 0 ? 'No clip selected' : selectedCount === 1 ? '1 clip selected' : `${selectedCount} clips selected`}</span>
        <span className="ms-auto tabular-nums">
          {trackCount} {trackCount === 1 ? 'track' : 'tracks'} · {clipCount} {clipCount === 1 ? 'clip' : 'clips'}
        </span>
      </div>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  )
}
