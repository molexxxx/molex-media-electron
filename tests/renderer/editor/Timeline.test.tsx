/**
 * Timeline mode: the export request keeps its earlier shape, the export dialog's flow, the toolbar, the track
 * headers, the source list, the clip panel, the ruler as the playhead's slider, and the keyboard map.
 */
import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panWords } from '../../../src/renderer/src/components/editor/edit/ClipInspector'
import { cursorForTrim } from '../../../src/renderer/src/components/editor/edit/Clip'
import { EditEditor } from '../../../src/renderer/src/components/editor/edit/EditEditor'
import { buildExportRequest, DEFAULT_EXPORT_SETTINGS } from '../../../src/renderer/src/components/editor/edit/ExportDialog'
import { chooseStep } from '../../../src/renderer/src/components/editor/edit/Ruler'
import { sourceDetail } from '../../../src/renderer/src/components/editor/edit/SourceBin'
import { sortTracks } from '../../../src/renderer/src/components/editor/edit/Timeline'
import { placeSource } from '../../../src/renderer/src/components/editor/edit/Toolbar'
import { trackTitle } from '../../../src/renderer/src/components/editor/edit/TrackHeader'
import { EDITOR_SHORTCUTS, ShortcutsDialog } from '../../../src/renderer/src/components/editor/shell/ShortcutsDialog'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import { audioSource, loadProject, resetEditor, stubApi, videoSource } from './harness'

let api: ReturnType<typeof stubApi>

beforeEach(() =>
{
  api = stubApi()
  resetEditor()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() =>
{
  vi.restoreAllMocks()
})

describe('the export request', () =>
{
  it('keeps the earlier request shape for the whole timeline', () =>
  {
    loadProject('edit')
    const request = buildExportRequest(useEditorStore.getState(), DEFAULT_EXPORT_SETTINGS, 'C:\\out\\x.mp4') as Record<string, any>
    expect(Object.keys(request)).toEqual(['project', 'sources', 'tracks', 'clips', 'output', 'range'])
    expect(request.output).toEqual({
      filePath: 'C:\\out\\x.mp4',
      format: 'mp4',
      videoCodec: 'libx264',
      audioCodec: 'aac',
      crf: 18,
      audioBitrate: '192k',
      resolution: undefined,
      frameRate: 30,
      sampleRate: 48000,
      audioChannels: 2
    })
    expect(request.range).toBeUndefined()
    expect(Object.keys(request.clips[0])).toEqual(['id', 'sourceId', 'trackId', 'timelineStart', 'sourceIn', 'sourceOut', 'muted', 'volume', 'pan', 'speed', 'transform', 'keyframes', 'blendMode'])
    expect(Object.keys(request.sources[0])).toEqual(['id', 'filePath', 'frameRate', 'width', 'height', 'audioChannels', 'audioSampleRate', 'durationSeconds'])
    expect(Object.keys(request.tracks[0])).toEqual(['id', 'type', 'name', 'index', 'muted', 'visible'])
  })

  it('limits the range to in and out or to the selected clips, and parses a size', () =>
  {
    loadProject('edit')
    useEditorStore.setState((s) => ({ playback: { ...s.playback, inPoint: 30, outPoint: 120 }, selectedClipIds: ['clip-2', 'clip-3'] }))
    const state = useEditorStore.getState()
    expect((buildExportRequest(state, { ...DEFAULT_EXPORT_SETTINGS, range: 'inout' }, 'x') as any).range).toEqual({ startFrame: 30, endFrame: 120 })
    expect((buildExportRequest(state, { ...DEFAULT_EXPORT_SETTINGS, range: 'selected' }, 'x') as any).range).toEqual({ startFrame: 60, endFrame: 540 })
    const webm = buildExportRequest(state, { ...DEFAULT_EXPORT_SETTINGS, format: 'webm', resolution: '1280x720', crf: '23' }, 'x') as any
    expect(webm.output).toMatchObject({ format: 'webm', videoCodec: 'libvpx-vp9', audioCodec: 'libopus', crf: 23, resolution: { width: 1280, height: 720 } })
  })
})

describe('the timeline workspace', () =>
{
  it('exports through the dialog: save path, request, progress, and the saved file', async () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Timeline tools' })).getByRole('button', { name: 'Export' }))
    const dialog = screen.getByRole('dialog', { name: 'Export the timeline' })
    expect(within(dialog).getByRole('radio', { name: 'In to out' })).toBeDisabled()
    await act(async () =>
    {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }))
    })
    expect(api.selectSavePath).toHaveBeenCalledWith('Untitled.mp4', [{ name: 'MP4', extensions: ['mp4'] }])
    expect(api.exportTimeline).toHaveBeenCalledTimes(1)
    expect(api.exportTimeline.mock.calls[0][0].output.filePath).toBe('C:\\out\\project.mp4')
    expect(within(dialog).getByText('Saved project.mp4')).toBeInTheDocument()
  })

  it('opens the export with Ctrl+E only while there are clips', () =>
  {
    render(<EditEditor />)
    act(() => useEditorStore.setState({ mode: 'edit' }))
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Export the timeline' })).not.toBeInTheDocument()
    act(() =>
    {
      loadProject('edit')
    })
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Export the timeline' })).toBeInTheDocument()
  })

  it('picks tools, toggles snapping, and undoes from the toolbar', () =>
  {
    loadProject('edit')
    useEditorStore.getState().pushHistory('Load')
    render(<EditEditor />)
    const toolbar = screen.getByRole('toolbar', { name: 'Timeline tools' })
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Split clips where you click' }))
    expect(useEditorStore.getState().activeTool).toBe('razor')
    expect(within(toolbar).getByRole('button', { name: 'Split clips where you click' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Snap to edges and the playhead' }))
    expect(useEditorStore.getState().snapEnabled).toBe(false)
    act(() => useEditorStore.getState().splitClip('clip-1', 150))
    expect(useEditorStore.getState().timeline.clips).toHaveLength(4)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Undo' }))
    expect(useEditorStore.getState().timeline.clips).toHaveLength(3)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Redo' }))
    expect(useEditorStore.getState().timeline.clips).toHaveLength(4)
  })

  it('places the chosen source with Append and Insert', () =>
  {
    loadProject('edit')
    useEditorStore.setState({ selectedSourceId: 'src-b' })
    placeSource('append')
    const appended = useEditorStore.getState().timeline.clips.at(-1)
    expect(appended).toMatchObject({ sourceId: 'src-b', timelineStart: 540, sourceIn: 0, sourceOut: 900 })
    useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 300 } }))
    placeSource('insert')
    expect(useEditorStore.getState().timeline.clips.some((c) => c.sourceId === 'src-b' && c.timelineStart === 300)).toBe(true)
  })

  it('toggles a track from its header and removes it from the track menu', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute Audio track A1' }))
    expect(useEditorStore.getState().timeline.tracks.find((t) => t.type === 'audio')?.muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Hide Video track V1' }))
    expect(useEditorStore.getState().timeline.tracks.find((t) => t.type === 'video')?.visible).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Video track V1, target for pastes and edits' }))
    expect(useEditorStore.getState().selectedTrackId).toBe(useEditorStore.getState().timeline.tracks.find((t) => t.type === 'video')?.id)
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Audio track A1' }))
    fireEvent.click(screen.getByRole('menuitem', { hidden: true, name: 'Remove track' }))
    expect(useEditorStore.getState().timeline.tracks.some((t) => t.type === 'audio')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add audio track' }))
    expect(useEditorStore.getState().timeline.tracks.some((t) => t.type === 'audio')).toBe(true)
  })

  it('chooses and removes sources from the keyboard', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    const list = screen.getByRole('listbox', { name: 'Sources' })
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(3)
    fireEvent.keyDown(options[1], { key: 'Enter' })
    expect(useEditorStore.getState().selectedSourceId).toBe('src-b')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(options[2], { key: 'Delete' })
    expect(useEditorStore.getState().sources.map((s) => s.id)).toEqual(['src-a', 'src-b'])
  })

  it('shows the selected clip in the clip panel and sets its volume and pan', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    act(() => useEditorStore.getState().selectClip('clip-3'))
    const panel = screen.getByRole('complementary', { name: 'Clip' })
    expect(within(panel).getByRole('heading', { name: 'tone.mp3' })).toBeInTheDocument()
    expect(within(panel).getByText('Audio track A1')).toBeInTheDocument()
    fireEvent.change(within(panel).getByRole('slider', { name: 'Volume' }), { target: { value: '150' } })
    fireEvent.pointerUp(within(panel).getByRole('slider', { name: 'Volume' }))
    fireEvent.keyDown(within(panel).getByRole('slider', { name: 'Pan' }), { key: 'ArrowLeft' })
    fireEvent.click(within(panel).getByRole('switch', { name: 'Mute this clip' }))
    const clip = useEditorStore.getState().timeline.clips.find((c) => c.id === 'clip-3')!
    expect(clip.muted).toBe(true)
    expect(within(panel).queryByRole('heading', { name: 'Picture' })).not.toBeInTheDocument()
  })

  it('shows the picture fields for a video clip and adds a keyframe at the playhead', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    act(() =>
    {
      useEditorStore.getState().selectClip('clip-1')
      useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 30 } }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add a keyframe at the playhead' }))
    expect(useEditorStore.getState().timeline.clips.find((c) => c.id === 'clip-1')?.keyframes?.map((k) => k.frame)).toEqual([30])
    expect(screen.getByRole('button', { name: 'Remove the keyframe at the playhead' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(screen.getByRole('combobox', { name: 'Blend mode' }), { target: { value: 'screen' } })
    expect(useEditorStore.getState().timeline.clips.find((c) => c.id === 'clip-1')?.blendMode).toBe('screen')
  })

  it('moves the playhead from the focused ruler', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    const ruler = screen.getByRole('slider', { name: 'Playhead' })
    fireEvent.keyDown(ruler, { key: 'ArrowRight', shiftKey: true })
    expect(useEditorStore.getState().playback.currentFrame).toBe(10)
    fireEvent.keyDown(ruler, { key: 'End' })
    expect(useEditorStore.getState().playback.currentFrame).toBe(540)
    fireEvent.keyDown(ruler, { key: 'Home' })
    expect(useEditorStore.getState().playback.currentFrame).toBe(0)
  })

  it('folds the side panes from the transport bar', () =>
  {
    loadProject('edit')
    render(<EditEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide the sources' }))
    expect(screen.queryByRole('listbox', { name: 'Sources' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide the clip panel' }))
    expect(screen.queryByRole('complementary', { name: 'Clip' })).not.toBeInTheDocument()
  })
})

describe('timeline helpers', () =>
{
  it('orders tracks video top down, then audio', () =>
  {
    const tracks = [
      { id: 'a1', type: 'audio', name: 'A1', index: 0, height: 60, muted: false, locked: false, visible: true },
      { id: 'v1', type: 'video', name: 'V1', index: 1, height: 80, muted: false, locked: false, visible: true },
      { id: 'v2', type: 'video', name: 'V2', index: 2, height: 80, muted: false, locked: false, visible: true },
      { id: 'a2', type: 'audio', name: 'A2', index: 1, height: 60, muted: false, locked: false, visible: true }
    ] as const
    expect(sortTracks(tracks.map((t) => ({ ...t }))).map((t) => t.id)).toEqual(['v2', 'v1', 'a1', 'a2'])
  })

  it('words tracks, pans, sources, cursors, and ruler steps plainly', () =>
  {
    expect(trackTitle({ type: 'video', name: 'V2' })).toBe('Video track V2')
    expect(panWords(0)).toBe('Center')
    expect(panWords(-0.3)).toBe('Left 30')
    expect(panWords(1)).toBe('Right 100')
    expect(sourceDetail(videoSource())).toBe('0:30 · 1280 × 720')
    expect(sourceDetail(audioSource())).toBe('0:20 · Audio')
    expect(cursorForTrim('roll', false, false)).toBe('col-resize')
    expect(cursorForTrim('ripple-in', false, false)).toBe('w-resize')
    expect(cursorForTrim('ripple-out', false, false)).toBe('e-resize')
    expect(cursorForTrim('default', true, true)).toBe('ew-resize')
    expect(cursorForTrim('default', true, false)).toBe('grab')
    expect(chooseStep(50)).toEqual({ major: 2, minor: 0.4 })
    expect(chooseStep(0.01)).toEqual({ major: 600, minor: 120 })
  })
})

describe('the keyboard map', () =>
{
  it('lists every key group and draws keycaps in the dialog', () =>
  {
    render(<ShortcutsDialog open onClose={() => undefined} />)
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const group of EDITOR_SHORTCUTS)
    {
      expect(within(dialog).getByRole('heading', { name: group.title })).toBeInTheDocument()
    }
    expect(within(dialog).getByText('Split at the playhead')).toBeInTheDocument()
    expect(within(dialog).getByText('Ctrl and scroll')).toBeInTheDocument()
    expect(dialog.querySelectorAll('kbd').length).toBeGreaterThan(40)
  })
})
