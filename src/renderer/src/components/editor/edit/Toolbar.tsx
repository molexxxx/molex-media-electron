/**
 * @module editor/edit/Toolbar
 * The timeline toolbar: the Select, Trim, and Split tools, the four ways to place the edit source, snapping, zoom,
 * undo and redo, and Export. Every icon button has a label and a tooltip with its key; the placing buttons keep
 * their words where the toolbar has room.
 */
import { useCallback, type ReactElement } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import type { IconName } from '../../../ui/icons'
import { Tooltip } from '../../../ui/Tooltip'
import type { EditTool } from '../types'

/** The tools, in toolbar order. */
export const TOOLS: ReadonlyArray<{ id: EditTool, label: string, icon: IconName, shortcut: string }> = [
  { id: 'select', label: 'Select and move clips', icon: 'editor.select', shortcut: 'V' },
  { id: 'trim', label: 'Trim clip edges', icon: 'editor.trimEdges', shortcut: 'T' },
  { id: 'razor', label: 'Split clips where you click', icon: 'editor.split', shortcut: 'B' }
]

/** How the edit source is placed. */
export type PlaceKind = 'insert' | 'overwrite' | 'append' | 'placeOnTop'

/** The placing actions, in toolbar order. */
export const PLACES: ReadonlyArray<{ id: PlaceKind, label: string, description: string, icon: IconName, shortcut?: string }> = [
  { id: 'insert', label: 'Insert', description: 'Insert the source at the playhead and push later clips right', icon: 'editor.insert', shortcut: ',' },
  { id: 'overwrite', label: 'Overwrite', description: 'Place the source at the playhead over what is there', icon: 'editor.overwrite', shortcut: '.' },
  { id: 'append', label: 'Append', description: 'Add the source after the last clip of the track', icon: 'editor.append' },
  { id: 'placeOnTop', label: 'On top', description: 'Place the source at the playhead on the first free video track above', icon: 'editor.onTop' }
]

/** Places the edit source (the selected source, or the active file) by `kind`, with Trim's in and out when they belong to it. */
export function placeSource(kind: PlaceKind): void
{
  const state = useEditorStore.getState()
  const sourceId = state.selectedSourceId || state.clipMode.sourceId
  const source = sourceId ? state.sources.find((s) => s.id === sourceId) : undefined
  if (!source)
  {
    return
  }
  const inOut: [number, number] = state.clipMode.sourceId === source.id ? [state.clipMode.inPoint, state.clipMode.outPoint] : [0, source.duration]
  const trackId = state.selectedTrackId || state.timeline.tracks.find((t) => t.type === 'video')?.id
  if (kind === 'placeOnTop')
  {
    state.placeOnTop(source.id, inOut, state.playback.currentFrame)
    return
  }
  if (!trackId)
  {
    return
  }
  if (kind === 'insert')
  {
    state.insertClip(source.id, inOut, state.playback.currentFrame, trackId)
  }
  else if (kind === 'overwrite')
  {
    state.overwriteClip(source.id, inOut, state.playback.currentFrame, trackId)
  }
  else
  {
    state.appendClip(source.id, inOut, trackId)
  }
}

interface ToolbarProps
{
  onZoomIn: () => void
  onZoomOut: () => void
  onFitToView: () => void
  onExport: () => void
}

function Divider(): ReactElement
{
  return <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line-strong" />
}

/** The toolbar row. */
export function Toolbar({ onZoomIn, onZoomOut, onFitToView, onExport }: ToolbarProps): ReactElement
{
  const activeTool = useEditorStore((s) => s.activeTool)
  const setActiveTool = useEditorStore((s) => s.setActiveTool)
  const snapEnabled = useEditorStore((s) => s.snapEnabled)
  const setSnapEnabled = useEditorStore((s) => s.setSnapEnabled)
  const zoom = useEditorStore((s) => s.zoom)
  const canUndo = useEditorStore((s) => s.history.currentIndex > 0)
  const canRedo = useEditorStore((s) => s.history.currentIndex < s.history.entries.length - 1)
  const hasSource = useEditorStore((s) => Boolean(s.selectedSourceId || s.clipMode.sourceId))
  const hasClips = useEditorStore((s) => s.timeline.clips.length > 0)
  const place = useCallback((kind: PlaceKind) => placeSource(kind), [])

  return (
    <div role="toolbar" aria-label="Timeline tools" className="@container flex h-10 shrink-0 items-center gap-1 border-t border-line bg-panel px-2">
      {TOOLS.map((tool) => (
        <IconButton
          key={tool.id}
          label={tool.label}
          icon={tool.icon}
          shortcut={tool.shortcut}
          pressed={activeTool === tool.id}
          onClick={() => setActiveTool(tool.id)}
        />
      ))}
      <Divider />
      {PLACES.map((entry) => (
        <span key={entry.id} className="contents">
          <span className="hidden @[60rem]:contents">
            <Tooltip content={hasSource ? entry.description : ''} shortcut={hasSource ? entry.shortcut : undefined}>
              <Button
                variant="ghost"
                size="sm"
                icon={entry.icon}
                unavailableReason={hasSource ? undefined : 'Open a file or select a source first.'}
                onClick={() => place(entry.id)}
              >
                {entry.label}
              </Button>
            </Tooltip>
          </span>
          <span className="contents @[60rem]:hidden">
            <IconButton
              label={entry.description}
              icon={entry.icon}
              shortcut={entry.shortcut}
              disabled={!hasSource}
              onClick={() => place(entry.id)}
            />
          </span>
        </span>
      ))}
      <Divider />
      <IconButton label="Snap to edges and the playhead" icon="editor.snap" shortcut="N" pressed={snapEnabled} onClick={() => setSnapEnabled(!snapEnabled)} />
      <Divider />
      <IconButton label="Zoom out" icon="editor.zoomOut" shortcut="Mod+-" onClick={onZoomOut} />
      <span className="w-12 shrink-0 text-center text-label tabular-nums text-ink-2">
        {Math.round((zoom / 50) * 100)}%
      </span>
      <IconButton label="Zoom in" icon="editor.zoomIn" shortcut="Mod+=" onClick={onZoomIn} />
      <IconButton label="Fit the timeline to the view" icon="editor.fit" shortcut="Mod+0" onClick={onFitToView} />
      <Divider />
      <IconButton label="Undo" icon="editor.undo" shortcut="Mod+Z" disabled={!canUndo} onClick={() => useEditorStore.getState().undo()} />
      <IconButton label="Redo" icon="editor.redo" shortcut="Mod+Shift+Z" disabled={!canRedo} onClick={() => useEditorStore.getState().redo()} />
      <div className="min-w-0 flex-1" />
      <Button
        variant="primary"
        size="sm"
        icon="action.export"
        unavailableReason={hasClips ? undefined : 'Add a clip to the timeline to export it.'}
        onClick={onExport}
      >
        Export
      </Button>
    </div>
  )
}
