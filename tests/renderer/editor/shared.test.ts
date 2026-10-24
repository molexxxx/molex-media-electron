/**
 * The editor's shared helpers: canvas colors read from tokens and cached until the theme changes, plain-words
 * formatting, which keys a focused control keeps, and how files reach the editor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { droppedPaths, importSources, openPaths, openWithDialog } from '../../../src/renderer/src/components/editor/open'
import { canvasPalette, resetCanvasPalette } from '../../../src/renderer/src/components/editor/shared/canvasPalette'
import {
  formatBitRate,
  formatFileSize,
  formatFrameRate,
  formatLength,
  formatOpened,
  formatPreciseLength,
  formatSampleRate
} from '../../../src/renderer/src/components/editor/shared/format'
import { isTypingTarget, modalOpen, ownsKey } from '../../../src/renderer/src/components/editor/shared/keys'
import { formatTime, formatTimecode } from '../../../src/renderer/src/components/editor/shared/TimeDisplay'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import { clearToasts } from '../../../src/renderer/src/ui/Toast'
import { resetEditor, stubApi } from './harness'

beforeEach(() =>
{
  resetEditor()
  clearToasts()
})

afterEach(() =>
{
  document.documentElement.removeAttribute('style')
  resetCanvasPalette()
  vi.restoreAllMocks()
})

describe('canvas palette', () =>
{
  it('reads the color tokens once and again after a reset', () =>
  {
    document.documentElement.style.setProperty('--color-viz-1', '#66d2ff')
    resetCanvasPalette()
    const first = canvasPalette()
    expect(first.waveform).toBe('#66d2ff')
    expect(first.playhead).toBe('transparent')
    document.documentElement.style.setProperty('--color-viz-1', '#123456')
    expect(canvasPalette()).toBe(first)
    resetCanvasPalette()
    expect(canvasPalette().waveform).toBe('#123456')
  })
})

describe('plain-words formatting', () =>
{
  it('says when a file was opened', () =>
  {
    const now = new Date(2026, 9, 20, 15, 0).getTime()
    expect(formatOpened(new Date(2026, 9, 20, 13, 40).getTime(), now)).toBe('Today, 13:40')
    expect(formatOpened(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe('Yesterday, 09:05')
    expect(formatOpened(new Date(2026, 9, 14, 22, 10).getTime(), now)).toBe('Oct 14, 22:10')
    expect(formatOpened(new Date(2025, 2, 3, 8, 0).getTime(), now)).toBe('Mar 3, 2025')
    expect(formatOpened(Number.NaN, now)).toBe('')
  })

  it('formats lengths, sizes, and rates', () =>
  {
    expect(formatLength(30)).toBe('0:30')
    expect(formatLength(3724)).toBe('1:02:04')
    expect(formatLength(undefined)).toBe('')
    expect(formatPreciseLength('30')).toBe('00:30.000')
    expect(formatPreciseLength(3723.25)).toBe('1:02:03.250')
    expect(formatPreciseLength('x')).toBe('')
    expect(formatFileSize('12636000')).toBe('12.1 MB')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(undefined)).toBe('')
    expect(formatBitRate('3400000')).toBe('3.4 Mb/s')
    expect(formatBitRate(128000)).toBe('128 kb/s')
    expect(formatBitRate(900)).toBe('900 b/s')
    expect(formatBitRate('')).toBe('')
    expect(formatFrameRate('30000/1001')).toBe('29.97 fps')
    expect(formatFrameRate('25')).toBe('25 fps')
    expect(formatFrameRate('0/0')).toBe('')
    expect(formatSampleRate('44100')).toBe('44.1 kHz')
    expect(formatSampleRate(0)).toBe('')
    expect(formatTimecode(95, 30)).toBe('00:00:03:05')
    expect(formatTimecode(1, 0)).toBe('00:00:00:00')
    expect(formatTime(45, 30)).toBe('00:00:01.500')
  })
})

describe('keys a focused control keeps', () =>
{
  it('lets fields, buttons, sliders, menus, and grids keep their keys', () =>
  {
    const input = document.createElement('input')
    const button = document.createElement('button')
    const slider = document.createElement('div')
    slider.setAttribute('role', 'slider')
    const grid = document.createElement('div')
    grid.setAttribute('role', 'grid')
    const cell = document.createElement('span')
    grid.append(cell)
    document.body.append(input, button, slider, grid)
    expect(isTypingTarget(input)).toBe(true)
    expect(ownsKey(input, 'i')).toBe(true)
    expect(ownsKey(button, ' ')).toBe(true)
    expect(ownsKey(button, 'ArrowLeft')).toBe(false)
    expect(ownsKey(slider, 'ArrowLeft')).toBe(true)
    expect(ownsKey(cell, 'ArrowDown')).toBe(true)
    expect(ownsKey(document.body, ' ')).toBe(false)
    expect(ownsKey(null, ' ')).toBe(false)
    expect(modalOpen()).toBe(false)
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.append(dialog)
    expect(modalOpen()).toBe(true)
    document.body.replaceChildren()
  })
})

describe('opening files', () =>
{
  it('opens the first file as the active one and adds the rest to the timeline sources', async () =>
  {
    const api = stubApi()
    await openPaths(['C:\\media\\a.mp4', 'C:\\media\\b.mp4', 'C:\\media\\t.mp3'], 'edit')
    const state = useEditorStore.getState()
    expect(state.sources.map((s) => s.fileName)).toEqual(['a.mp4', 'b.mp4', 't.mp3'])
    expect(state.clipMode.sourceId).toBe(state.sources[0].id)
    expect(api.probeDetailed).toHaveBeenCalledTimes(3)
    await importSources(['C:\\media\\b.mp4'])
    expect(useEditorStore.getState().sources).toHaveLength(3)
  })

  it('counts a 60 fps file in project frames, so it keeps its real length on the timeline', async () =>
  {
    const base = stubApi().probeDetailed
    stubApi({
      probeDetailed: vi.fn(async (filePath: string) =>
      {
        const reply = await base(filePath)
        reply.data.videoStreams[0].r_frame_rate = '60/1'
        reply.data.format.duration = '10.000'
        return reply
      })
    })
    await openPaths(['C:\\media\\fast.mp4'], 'edit')
    const state = useEditorStore.getState()
    expect(state.sources[0]).toMatchObject({ frameRate: 30, duration: 300, nativeFrameRate: 60 })
    expect(state.clipMode.outPoint).toBe(600)
  })

  it('opens a file already among the sources again without listing it twice, keeping its id for the timeline', async () =>
  {
    stubApi()
    await openPaths(['C:\\media\\a.mp4'], 'clip')
    const first = useEditorStore.getState().sources[0]
    const track = useEditorStore.getState().timeline.tracks[0].id
    useEditorStore.getState().addClip({ sourceId: first.id, trackId: track, timelineStart: 0, sourceIn: 0, sourceOut: 100, name: 'a', color: '', muted: false, locked: false, volume: 1, pan: 0, speed: 1 })
    await openPaths(['C:\\media\\a.mp4'], 'clip')
    const state = useEditorStore.getState()
    expect(state.sources).toHaveLength(1)
    expect(state.sources[0].id).toBe(first.id)
    expect(state.clipMode.sourceId).toBe(first.id)
    expect(state.timeline.clips[0].sourceId).toBe(first.id)
  })

  it('opens only the first picked file outside the timeline, and nothing when the dialog is canceled', async () =>
  {
    const api = stubApi({ openFiles: vi.fn(async () => ['C:\\media\\a.mp4', 'C:\\media\\b.mp4']) })
    expect(await openWithDialog('clip')).toBe(true)
    expect(useEditorStore.getState().sources).toHaveLength(1)
    api.openFiles.mockResolvedValueOnce([])
    expect(await openWithDialog('clip')).toBe(false)
  })

  it('names a file that cannot be read in an error toast', async () =>
  {
    stubApi({ probeDetailed: vi.fn(async () => ({ success: false, error: 'Invalid data' })) })
    expect(await openPaths(['C:\\media\\bad.mp4'], 'clip')).toBe(false)
    expect(await importSources(['C:\\media\\bad.mp4', 'C:\\media\\worse.mp4'])).toBe(0)
    expect(await openPaths([], 'clip')).toBe(false)
  })

  it('reads dropped files through the bridge', () =>
  {
    stubApi()
    const file = new File(['x'], 'drop.mp4')
    expect(droppedPaths({ files: [file] } as unknown as DataTransfer)).toEqual(['C:\\media\\drop.mp4'])
  })
})
