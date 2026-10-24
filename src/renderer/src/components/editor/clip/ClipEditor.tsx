/**
 * @module editor/clip/ClipEditor
 * Trim: the preview, the transport with lit in, out, and length readouts, the trim bar, and the export panel.
 * Its keys act while the editor shows Trim and no field, slider, menu, or dialog owns them.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useAppStore } from '../../../stores/appStore'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import { Splitter } from '../../../ui/Splitter'
import { Tooltip } from '../../../ui/Tooltip'
import { useEditorPlayback } from '../hooks/useEditorPlayback'
import { modalOpen, ownsKey } from '../shared/keys'
import { formatTimecode, Readout } from '../shared/TimeDisplay'
import type { MediaSource } from '../types'
import { ClipExport } from './ClipExport'
import { ClipPreview } from './ClipPreview'
import { ClipTimeline } from './ClipTimeline'

/** The export panel's width limits in px. */
export const TRIM_PANEL_WIDTH = { min: 260, default: 300, max: 440 } as const

/** Trim mode for the active file; nothing while no file is open. */
export function ClipEditor(): ReactElement | null
{
  const sources = useEditorStore((s) => s.sources)
  const sourceId = useEditorStore((s) => s.clipMode.sourceId)
  const source: MediaSource | undefined = sources.find((s) => s.id === sourceId)
  if (!source)
  {
    return null
  }
  return <TrimWorkspace key={source.id} source={source} />
}

function TrimWorkspace({ source }: { source: MediaSource }): ReactElement
{
  const inPoint = useEditorStore((s) => s.clipMode.inPoint)
  const outPoint = useEditorStore((s) => s.clipMode.outPoint)
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const isPlaying = useEditorStore((s) => s.playback.isPlaying)
  const projectRate = useEditorStore((s) => s.project.frameRate)
  const frameRate = source.frameRate || projectRate
  const setClipInPoint = useEditorStore((s) => s.setClipInPoint)
  const setClipOutPoint = useEditorStore((s) => s.setClipOutPoint)
  const mediaUrl = useEditorStore((s) => s.mediaPreviewUrl)
  const totalFrames = source.duration
  const [panelWidth, setPanelWidth] = useState<number>(TRIM_PANEL_WIDTH.default)

  const { mediaRef, togglePlayback, seekToFrame, stepFrames, handleJKL } = useEditorPlayback({ frameRate, totalFrames })

  const markIn = (): void => setClipInPoint(useEditorStore.getState().playback.currentFrame)
  const markOut = (): void => setClipOutPoint(useEditorStore.getState().playback.currentFrame)

  useEffect(() =>
  {
    const onKeyDown = (event: KeyboardEvent): void =>
    {
      const state = useEditorStore.getState()
      if (useAppStore.getState().currentView !== 'editor' || state.mode !== 'clip' || event.defaultPrevented || modalOpen())
      {
        return
      }
      if (ownsKey(event.target, event.key))
      {
        return
      }
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z')
      {
        event.preventDefault()
        if (event.shiftKey)
        {
          state.redo()
        }
        else
        {
          state.undo()
        }
        return
      }
      if (mod || event.altKey)
      {
        return
      }
      switch (event.key)
      {
        case ' ':
          event.preventDefault()
          togglePlayback()
          break
        case 'i':
        case 'I':
          event.preventDefault()
          setClipInPoint(state.playback.currentFrame)
          break
        case 'o':
        case 'O':
          event.preventDefault()
          setClipOutPoint(state.playback.currentFrame)
          break
        case 'ArrowLeft':
          event.preventDefault()
          stepFrames(event.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          event.preventDefault()
          stepFrames(event.shiftKey ? 10 : 1)
          break
        case 'Home':
          event.preventDefault()
          seekToFrame(0)
          break
        case 'End':
          event.preventDefault()
          seekToFrame(totalFrames)
          break
        case 'j':
        case 'J':
        case 'k':
        case 'K':
        case 'l':
        case 'L':
          event.preventDefault()
          handleJKL(event.key.toLowerCase() as 'j' | 'k' | 'l')
          break
        case 'Escape':
          event.preventDefault()
          setClipInPoint(0)
          setClipOutPoint(totalFrames)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlayback, stepFrames, seekToFrame, handleJKL, setClipInPoint, setClipOutPoint, totalFrames])

  const length = Math.max(0, outPoint - inPoint)

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 bg-sunken">
          <ClipPreview source={source} mediaRef={mediaRef} mediaUrl={mediaUrl} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-t border-line bg-panel px-4 py-2">
          <div className="flex items-center gap-5">
            <Readout label="In" value={formatTimecode(inPoint, frameRate)} />
            <Readout label="Out" value={formatTimecode(outPoint, frameRate)} />
            <Readout label="Length" value={formatTimecode(length, frameRate)} />
          </div>
          <div className="flex flex-1 items-center justify-center gap-1">
            <IconButton label="Go to the in point" icon="editor.toIn" onClick={() => seekToFrame(inPoint)} />
            <IconButton label="Step back one frame" icon="editor.stepBack" shortcut="Left" onClick={() => stepFrames(-1)} />
            <IconButton
              label={isPlaying ? 'Pause' : 'Play'}
              icon={isPlaying ? 'action.pause' : 'action.start'}
              variant="primary"
              shortcut="Space"
              onClick={togglePlayback}
            />
            <IconButton label="Step forward one frame" icon="editor.stepForward" shortcut="Right" onClick={() => stepFrames(1)} />
            <IconButton label="Go to the out point" icon="editor.toOut" onClick={() => seekToFrame(outPoint)} />
            <Readout label="Playhead" value={formatTimecode(currentFrame, frameRate)} lit={false} className="ms-3 w-24" />
          </div>
          <div className="flex items-center gap-2">
            <Tooltip content="Set the in point at the playhead" shortcut="I">
              <Button size="sm" onClick={markIn}>Mark in</Button>
            </Tooltip>
            <Tooltip content="Set the out point at the playhead" shortcut="O">
              <Button size="sm" onClick={markOut}>Mark out</Button>
            </Tooltip>
          </div>
        </div>
        <ClipTimeline totalFrames={totalFrames} frameRate={frameRate} seekToFrame={seekToFrame} source={source} />
      </div>
      <Splitter
        label="Export panel width"
        pane="after"
        value={panelWidth}
        min={TRIM_PANEL_WIDTH.min}
        max={TRIM_PANEL_WIDTH.max}
        defaultValue={TRIM_PANEL_WIDTH.default}
        onChange={setPanelWidth}
      />
      <ClipExport source={source} width={panelWidth} />
    </div>
  )
}
