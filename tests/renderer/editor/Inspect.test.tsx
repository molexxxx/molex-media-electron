/**
 * Inspect: ffprobe's report read into plain values before technical ones, copying values and reports, leaving streams
 * out and editing tags for a lossless copy with the earlier remux options, and the measured keyframes.
 */
import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  channelsName,
  codecName,
  containerName,
  flagWords,
  keyframeSummary,
  languageName,
  secondsWords
} from '../../../src/renderer/src/components/editor/inspect/describe'
import { InspectEditor, remuxOptions, tagsChanged, tagsRecord } from '../../../src/renderer/src/components/editor/inspect/InspectEditor'
import {
  chromaWords,
  colorWords,
  containerFacts,
  dynamicRangeWords,
  levelWords,
  lightLevelWords,
  parseReport,
  reportFromProbe,
  reportText,
  sampleFormatWords,
  scanWords,
  streamFacts,
  streamTitle,
  videoBitDepth,
  type ReportStream
} from '../../../src/renderer/src/components/editor/inspect/report'
import { factText } from '../../../src/renderer/src/components/editor/inspect/StreamInfo'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import { LiveRegion } from '../../../src/renderer/src/ui/LiveRegion'
import { loadProject, resetEditor, sampleReport, stubApi } from './harness'

let api: ReturnType<typeof stubApi>

beforeEach(() =>
{
  api = stubApi({ keyframeTimes: vi.fn(async () => ({ success: true, times: [0, 1, 2, 3.5] })) })
  resetEditor()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() =>
{
  vi.restoreAllMocks()
})

async function renderInspect(): Promise<void>
{
  loadProject('inspect')
  await act(async () =>
  {
    render(<LiveRegion><InspectEditor /></LiveRegion>)
  })
}

const HDR: ReportStream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'hevc',
  profile: 'Main 10',
  level: 93,
  width: 3840,
  height: 2160,
  pix_fmt: 'yuv420p10le',
  color_range: 'tv',
  color_space: 'bt2020nc',
  color_transfer: 'smpte2084',
  color_primaries: 'bt2020',
  field_order: 'progressive',
  r_frame_rate: '24000/1001',
  avg_frame_rate: '24000/1001',
  side_data_list: [
    { side_data_type: 'Mastering display metadata', max_luminance: '10000000/10000' },
    { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 }
  ]
}

describe('plain names', () =>
{
  it('names codecs, containers, channels, languages, and flags plainly', () =>
  {
    expect(codecName('h264')).toBe('H.264')
    expect(codecName('eac3')).toBe('Dolby Digital Plus (E-AC-3)')
    expect(codecName('weird')).toBe('WEIRD')
    expect(codecName(undefined)).toBe('Unknown')
    expect(containerName('mov,mp4,m4a,3gp,3g2,mj2', 'clip-a.mp4')).toBe('MP4')
    expect(containerName('matroska,webm', 'clip')).toBe('MATROSKA')
    expect(containerName(undefined, 'clip')).toBe('Unknown')
    expect(channelsName(2, 'stereo')).toBe('Stereo')
    expect(channelsName(6, '5.1(side)')).toBe('5.1 surround')
    expect(channelsName(3, '2.1')).toBe('3 channels (2.1)')
    expect(channelsName(0, undefined)).toBe('Unknown')
    expect(languageName('und')).toBeNull()
    expect(languageName('eng')).toBe('English')
    expect(languageName('tlh')).toBe('tlh')
    expect(flagWords({ default: 1, forced: 1, dub: 0 })).toBe('Default, Forced')
    expect(flagWords({ default: 0 })).toBeNull()
    expect(flagWords({ still_image: 1 })).toBe('still image')
  })

  it('reads levels, depth, chroma, color, dynamic range, scan, and sample formats', () =>
  {
    expect(levelWords('h264', 41)).toBe('4.1')
    expect(levelWords('hevc', 93)).toBe('3.1')
    expect(levelWords('vp9', 2)).toBe('2')
    expect(levelWords('h264', undefined)).toBeNull()
    expect(videoBitDepth({ pix_fmt: 'yuv420p10le' })).toBe(10)
    expect(videoBitDepth({ bits_per_raw_sample: '8', pix_fmt: 'yuv420p' })).toBe(8)
    expect(videoBitDepth({ pix_fmt: 'yuv420p' })).toBe(8)
    expect(videoBitDepth({})).toBeNull()
    expect(chromaWords('yuv420p10le')).toBe('4:2:0')
    expect(chromaWords('yuv422p')).toBe('4:2:2')
    expect(chromaWords('yuv444p')).toBe('4:4:4')
    expect(chromaWords('rgb24')).toBe('RGB')
    expect(chromaWords('gray')).toBe('Grayscale')
    expect(chromaWords('pal8')).toBeNull()
    expect(colorWords(HDR)).toBe('BT.2020, limited range')
    expect(colorWords({ index: 0 })).toBeNull()
    expect(dynamicRangeWords(HDR)).toBe('HDR10 (PQ)')
    expect(dynamicRangeWords({ index: 0, color_transfer: 'arib-std-b67' })).toBe('HLG')
    expect(dynamicRangeWords({ index: 0, color_transfer: 'bt709' })).toBe('SDR')
    expect(dynamicRangeWords({ index: 0, side_data_list: [{ side_data_type: 'DOVI configuration record' }] })).toBe('Dolby Vision')
    expect(dynamicRangeWords({ index: 0 })).toBeNull()
    expect(lightLevelWords(HDR)).toBe('mastered to 1000 nits, content peak 1000 nits')
    expect(scanWords('progressive')).toBe('Progressive')
    expect(scanWords('tt')).toBe('Interlaced, top field first')
    expect(scanWords('bb')).toBe('Interlaced, bottom field first')
    expect(scanWords(undefined)).toBeNull()
    expect(sampleFormatWords('fltp')).toBe('32-bit float, planar')
    expect(sampleFormatWords('s16')).toBe('16-bit')
    expect(sampleFormatWords('weird')).toBeNull()
  })

  it('lists an HDR stream with color, depth, and dynamic range', () =>
  {
    const facts = Object.fromEntries(streamFacts(HDR).map((f) => [f.name, factText(f)]))
    expect(facts.Codec).toBe('H.265 (HEVC) (hevc · Main 10 · level 3.1)')
    expect(facts['Bit depth']).toBe('10-bit (4:2:0 · yuv420p10le)')
    expect(facts.Color).toBe('BT.2020, limited range (bt2020 · bt2020nc · smpte2084 · tv)')
    expect(facts['Dynamic range']).toBe('HDR10 (PQ) (mastered to 1000 nits, content peak 1000 nits · smpte2084)')
    expect(facts['Frame rate']).toBe('23.976 fps (24000/1001)')
    expect(facts.Scan).toBe('Progressive (progressive)')
  })

  it('names cover art, subtitles, and a variable frame rate', () =>
  {
    expect(streamTitle({ index: 2, codec_type: 'video', disposition: { attached_pic: 1 } })).toBe('Cover art')
    expect(streamTitle({ index: 3, codec_type: 'subtitle' })).toBe('Subtitles')
    expect(streamTitle({ index: 4, codec_type: 'attachment' })).toBe('Attachment')
    expect(streamTitle({ index: 5 })).toBe('Data')
    const vfr = streamFacts({ index: 0, codec_type: 'video', codec_name: 'h264', r_frame_rate: '30/1', avg_frame_rate: '2997/100' }).find((f) => f.name === 'Frame rate')
    expect(vfr).toEqual({ name: 'Frame rate', value: '29.97 fps, variable', detail: 'r 30/1 · avg 2997/100' })
    expect(streamFacts({ index: 3, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', DURATION: '00:01:02.000' } }).map((f) => f.name)).toEqual(['Format', 'Length', 'Language'])
  })

  it('reads a report, falls back to the app probe, and writes the report as text', () =>
  {
    expect(parseReport('not json')).toBeNull()
    expect(parseReport('null')).toBeNull()
    const report = parseReport(JSON.stringify(sampleReport('C:\\media\\clip-a.mp4')))!
    expect(containerFacts(report, 'clip-a.mp4').map((f) => f.name)).toEqual(['Container', 'Length', 'Size', 'Bit rate', 'Streams'])
    const text = reportText(report, 'clip-a.mp4', 'C:\\media\\clip-a.mp4')
    expect(text).toContain('Video, stream 0')
    expect(text).toContain('Codec: H.264 (h264 · High · level 3.1)')
    expect(text).toContain('Audio, stream 1')
    expect(text).toContain('encoder: Lavf59.34.101')
    const fallback = reportFromProbe({ videoStreams: [{ index: 0, codec_name: 'h264' }], audioStreams: [{ index: 1, codec_name: 'aac' }], subtitleStreams: [], dataStreams: [], format: {} })
    expect(fallback.streams.map((s) => s.codec_type)).toEqual(['video', 'audio'])
  })

  it('summarizes keyframe gaps', () =>
  {
    expect(keyframeSummary([0, 1, 2, 3.5], 4)).toEqual({ count: 4, average: 1, longest: 1.5 })
    expect(keyframeSummary([], 4)).toEqual({ count: 0, average: null, longest: null })
    expect(secondsWords(0.5)).toBe('0.5 s')
    expect(secondsWords(12.25)).toBe('12.3 s')
    expect(secondsWords(64)).toBe('1 min 4 s')
    expect(secondsWords(120)).toBe('2 min')
  })
})

describe('remux options', () =>
{
  it('sends the kept streams, and the tags only when they were edited', () =>
  {
    const rows = [{ id: 'a', key: 'title', value: 'Mine' }]
    expect(remuxOptions(new Set([1, 0]), false, { title: 'Old' }, rows)).toEqual({ keepStreams: [0, 1] })
    expect(remuxOptions(new Set([0]), true, { title: 'Old' }, rows)).toEqual({ keepStreams: [0], metadata: { title: 'Mine' } })
    expect(remuxOptions(new Set([0]), true, { title: 'Mine' }, rows)).toEqual({ keepStreams: [0] })
    expect(tagsChanged(undefined, {})).toBe(false)
    expect(tagsRecord([{ id: '1', key: 'a', value: '1' }, { id: '2', key: 'a', value: '2' }])).toEqual({ a: '2' })
  })
})

describe('the Inspect view', () =>
{
  it('lists the file and each stream with the plain value before the technical one', async () =>
  {
    await renderInspect()
    const file = screen.getByLabelText('File facts')
    expect(within(file).getByText('MP4')).toBeInTheDocument()
    expect(within(file).getByText('mov,mp4,m4a,3gp,3g2,mj2 · QuickTime / MOV')).toBeInTheDocument()
    expect(within(file).getByText('12.1 MB')).toBeInTheDocument()
    const video = screen.getByRole('region', { name: 'Video, stream 0' })
    expect(within(video).getByText('H.264')).toBeInTheDocument()
    expect(within(video).getByText('h264 · High · level 3.1')).toBeInTheDocument()
    expect(within(video).getByText('1280 × 720')).toBeInTheDocument()
    expect(within(video).getByText('BT.709, limited range')).toBeInTheDocument()
    expect(within(video).getByText('SDR')).toBeInTheDocument()
    const audio = screen.getByRole('region', { name: 'Audio, stream 1' })
    expect(within(audio).getByText('Stereo')).toBeInTheDocument()
    expect(within(audio).getByText('48 kHz')).toBeInTheDocument()
    expect(within(audio).getByText('32-bit float, planar')).toBeInTheDocument()
    expect(within(audio).getByText('Main mix')).toBeInTheDocument()
  })

  it('copies a value, the path, and the FFprobe report', async () =>
  {
    await renderInspect()
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>
    const video = screen.getByRole('region', { name: 'Video, stream 0' })
    await act(async () =>
    {
      fireEvent.click(within(video).getByRole('button', { name: 'Copy codec' }))
    })
    expect(writeText).toHaveBeenLastCalledWith('H.264 (h264 · High · level 3.1)')
    expect(within(video).getByRole('button', { name: 'Copied codec' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('menuitem', { hidden: true, name: /Copy the FFprobe report/ }))
    })
    expect(JSON.parse(writeText.mock.lastCall![0] as string).streams).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('menuitem', { hidden: true, name: 'Copy the file path' }))
    })
    expect(writeText).toHaveBeenLastCalledWith('C:\\media\\clip-a.mp4')
  })

  it('falls back to the app probe when FFprobe cannot print its report, and opens the file in Trim', async () =>
  {
    api.probeReport.mockResolvedValue({ success: false, error: 'FFprobe is not set up' })
    await renderInspect()
    expect(screen.getByRole('region', { name: 'Video, stream 0' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Trim' }))
    expect(useEditorStore.getState().mode).toBe('clip')
  })

  it('saves a copy without a stream left out', async () =>
  {
    await renderInspect()
    expect(screen.getByRole('button', { name: 'Save a copy' })).toHaveAttribute('aria-disabled', 'true')
    const audio = screen.getByRole('region', { name: 'Audio, stream 1' })
    fireEvent.click(within(audio).getByRole('checkbox', { name: 'Keep in the copy' }))
    expect(within(audio).getByText('Left out of the copy')).toBeInTheDocument()
    expect(screen.getByText('The copy leaves 1 stream out.')).toBeInTheDocument()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Save a copy' }))
    })
    expect(api.remuxMedia).toHaveBeenCalledWith('C:\\media\\clip-a.mp4', { keepStreams: [0] })
    expect(screen.getByText('Saved clip-a_remux.mp4')).toBeInTheDocument()
  })

  it('keeps a tag name field focused while it is typed in, and writes the edited tags', async () =>
  {
    await renderInspect()
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }))
    const name = screen.getAllByRole('textbox', { name: 'Tag name' })[0]
    name.focus()
    fireEvent.change(name, { target: { value: 'encoded_by' } })
    expect(document.activeElement).toBe(name)
    fireEvent.change(screen.getByRole('textbox', { name: 'Value of major_brand' }), { target: { value: 'mp42' } })
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Save a copy' }))
    })
    expect(api.remuxMedia).toHaveBeenCalledWith('C:\\media\\clip-a.mp4', {
      keepStreams: [0, 1],
      metadata: { encoded_by: 'Lavf59.34.101', major_brand: 'mp42' }
    })
  })

  it('finds the keyframes on request and sums them up', async () =>
  {
    await renderInspect()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Find keyframes' }))
    })
    expect(api.keyframeTimes).toHaveBeenCalledWith('C:\\media\\clip-a.mp4')
    const summary = screen.getByLabelText('Keyframe summary')
    expect(within(summary).getByText('4')).toBeInTheDocument()
    expect(within(summary).getByText('26.5 s')).toBeInTheDocument()
    expect(within(summary).getByText('7.5 s')).toBeInTheDocument()
  })

  it('names the problem and the way out when the keyframes cannot be read', async () =>
  {
    api.keyframeTimes.mockResolvedValueOnce({ success: false, error: 'FFprobe is not set up' })
    await renderInspect()
    await act(async () =>
    {
      fireEvent.click(screen.getByRole('button', { name: 'Find keyframes' }))
    })
    expect(screen.getByText(/Could not read the keyframes: FFprobe is not set up\. Check that the file has a video stream/)).toBeInTheDocument()
  })

  it('names a file that cannot be read and the way out', async () =>
  {
    api.probeReport.mockResolvedValue({ success: false, error: 'no report' })
    api.probeDetailed.mockResolvedValue({ success: false, error: 'Invalid data found when processing input' })
    await renderInspect()
    expect(screen.getByRole('heading', { name: 'Could not read clip-a.mp4' })).toBeInTheDocument()
    expect(screen.getByText(/Invalid data found when processing input\. Check that the file still exists/)).toBeInTheDocument()
  })
})
