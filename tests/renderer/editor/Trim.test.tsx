/**
 * Trim: the export options keep the earlier shape (the default export is unchanged and the quality presets now set
 * their CRF), the export panel's flow, the in and out handles as sliders, and the Trim keys.
 */
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClipEditor } from '../../../src/renderer/src/components/editor/clip/ClipEditor'
import { encoderNote } from '../../../src/renderer/src/components/editor/clip/ClipExport'
import {
  buildCutOptions,
  DEFAULT_GIF,
  DEFAULT_VIDEO,
  formatKind,
  qualityForCrf,
  qualityOptions
} from '../../../src/renderer/src/components/editor/clip/ClipExportAdvanced'
import { audioLine } from '../../../src/renderer/src/components/editor/clip/ClipPreview'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import { loadProject, resetEditor, stubApi } from './harness'

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

describe('trim export options', () =>
{
  it('sends the earlier default for MP4: precise, H.264 at CRF 20', () =>
  {
    expect(buildCutOptions('mp4', false, DEFAULT_GIF, DEFAULT_VIDEO)).toEqual({
      mode: 'precise',
      outputFormat: 'mp4',
      videoOptions: { codec: 'libx264', crf: 20, preset: 'medium', maxHeight: 0, audioBitrate: '192k' }
    })
  })

  it('copies the streams for Lossless and sends GIF options for a GIF', () =>
  {
    expect(buildCutOptions('mkv', true, DEFAULT_GIF, DEFAULT_VIDEO).mode).toBe('fast')
    expect(buildCutOptions('gif', false, DEFAULT_GIF, DEFAULT_VIDEO)).toEqual({
      mode: 'precise',
      outputFormat: 'gif',
      gifOptions: { fps: 15, width: 480, loopCount: 0, dither: 'sierra2_4a', bayerScale: 3, highQuality: true, reverse: false, boomerang: false }
    })
    expect(buildCutOptions('mp3', false, DEFAULT_GIF, DEFAULT_VIDEO)).toEqual({ mode: 'precise', outputFormat: 'mp3' })
  })

  it('maps the quality presets to their CRF and names a hand-set CRF', () =>
  {
    expect(qualityForCrf(20)).toBe('high')
    expect(qualityForCrf(23)).toBe('medium')
    expect(qualityForCrf(28)).toBe('low')
    expect(qualityForCrf(17)).toBeNull()
    expect(qualityOptions(false, 17).at(-1)).toEqual({ value: 'custom', label: 'Custom (CRF 17)' })
    expect(qualityOptions(true, 17).some((o) => o.value === 'custom')).toBe(false)
    expect(formatKind('webm')).toBe('video')
    expect(formatKind('wav')).toBe('audio')
  })

  it('names the encoder in one sentence', () =>
  {
    expect(encoderNote('off')).toBe('Video encodes on the CPU. GPU encoding can be turned on in Settings.')
    expect(encoderNote('nvenc')).toBe('Video encodes with NVENC where the codec allows.')
  })

  it('describes an audio file in plain words', () =>
  {
    expect(audioLine({ codec: 'mp3', audioChannels: 2, audioSampleRate: 48000 })).toBe('MP3 audio · 2 channels · 48 kHz')
    expect(audioLine({ codec: 'aac', audioChannels: 1, audioSampleRate: 44100 })).toBe('AAC audio · 1 channel · 44.1 kHz')
  })
})

describe('the Trim workspace', () =>
{
  it('exports the in to out range with the chosen settings and shows the saved file', async () =>
  {
    loadProject('clip')
    useEditorStore.setState({ clipMode: { sourceId: 'src-a', inPoint: 30, outPoint: 90 } })
    render(<ClipEditor />)
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'medium' } })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(api.cutMedia).toHaveBeenCalledWith('C:\\media\\clip-a.mp4', 1, 3, {
      mode: 'precise',
      outputFormat: 'mp4',
      videoOptions: { codec: 'libx264', crf: 23, preset: 'medium', maxHeight: 0, audioBitrate: '192k' }
    })
    expect(screen.getByText('Saved clip-a_trimmed.mp4')).toBeInTheDocument()
  })

  it('says nothing when the save dialog is canceled, and names the problem and the way out on a failure', async () =>
  {
    loadProject('clip')
    api.cutMedia.mockResolvedValueOnce({ success: false, error: 'Cancelled' })
    render(<ClipEditor />)
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.queryByText(/The export failed/)).not.toBeInTheDocument()
    api.cutMedia.mockResolvedValueOnce({ success: false, error: 'FFmpeg exited with code 1' })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    })
    expect(screen.getByText(/The export failed: FFmpeg exited with code 1\. Try another format or quality/)).toBeInTheDocument()
  })

  it('moves the in and out handles from the keyboard within their limits', () =>
  {
    loadProject('clip')
    render(<ClipEditor />)
    const handleIn = screen.getByRole('slider', { name: 'In point' })
    const handleOut = screen.getByRole('slider', { name: 'Out point' })
    fireEvent.keyDown(handleIn, { key: 'ArrowRight' })
    fireEvent.keyDown(handleIn, { key: 'ArrowRight', shiftKey: true })
    expect(useEditorStore.getState().clipMode.inPoint).toBe(11)
    fireEvent.keyDown(handleOut, { key: 'PageDown' })
    expect(useEditorStore.getState().clipMode.outPoint).toBe(870)
    fireEvent.keyDown(handleIn, { key: 'End' })
    expect(useEditorStore.getState().clipMode.inPoint).toBe(869)
    fireEvent.keyDown(handleOut, { key: 'Home' })
    expect(useEditorStore.getState().clipMode.outPoint).toBe(870)
    expect(handleIn).toHaveAttribute('aria-valuetext', '00:00:28:29')
  })

  it('marks in and out with I and O, resets them with Escape, and leaves typing alone', () =>
  {
    loadProject('clip')
    render(<ClipEditor />)
    act(() => useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 120 } })))
    fireEvent.keyDown(window, { key: 'i' })
    expect(useEditorStore.getState().clipMode.inPoint).toBe(120)
    act(() => useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 300 } })))
    fireEvent.keyDown(window, { key: 'o' })
    expect(useEditorStore.getState().clipMode.outPoint).toBe(300)
    const input = document.createElement('input')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'i' })
    expect(useEditorStore.getState().clipMode.inPoint).toBe(120)
    input.remove()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useEditorStore.getState().clipMode).toMatchObject({ inPoint: 0, outPoint: 900 })
  })

  it('sets the points from the Mark in and Mark out buttons and adds the range to the timeline', () =>
  {
    loadProject('clip')
    render(<ClipEditor />)
    act(() => useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 60 } })))
    fireEvent.click(screen.getByRole('button', { name: 'Mark in' }))
    act(() => useEditorStore.setState((s) => ({ playback: { ...s.playback, currentFrame: 150 } })))
    fireEvent.click(screen.getByRole('button', { name: 'Mark out' }))
    const before = useEditorStore.getState().timeline.clips.length
    fireEvent.click(screen.getByRole('button', { name: 'Add to timeline' }))
    const state = useEditorStore.getState()
    expect(state.mode).toBe('edit')
    expect(state.timeline.clips).toHaveLength(before + 1)
    expect(state.timeline.clips.at(-1)).toMatchObject({ sourceIn: 60, sourceOut: 150, timelineStart: 540 })
  })
})
