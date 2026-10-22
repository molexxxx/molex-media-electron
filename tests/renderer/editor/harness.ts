/**
 * Shared fixtures for the editor tests: a stub bridge that records calls, sample sources, and a store reset.
 */
import { vi } from 'vitest'
import { useAppStore } from '../../../src/renderer/src/stores/appStore'
import { useEditorStore } from '../../../src/renderer/src/stores/editorStore'
import type { MediaSource, TimelineClip } from '../../../src/renderer/src/components/editor/types'

/** A stub of every bridge call the editor makes. */
export function stubApi(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>>
{
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    openFiles: vi.fn(async () => []),
    probeDetailed: vi.fn(async (filePath: string) => ({
      success: true,
      data: {
        videoStreams: filePath.endsWith('.mp3') ? [] : [{ index: 0, codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1', pix_fmt: 'yuv420p', profile: 'High', bit_rate: '3200000', disposition: { default: 1 }, tags: { language: 'und' } }],
        audioStreams: [{ index: 1, codec_name: 'aac', channels: 2, channel_layout: 'stereo', sample_rate: '48000', bit_rate: '128000', profile: 'LC', disposition: { default: 1 } }],
        subtitleStreams: [],
        dataStreams: [],
        format: { filename: filePath, duration: '30.000', size: '12636000', bit_rate: '3400000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { encoder: 'Lavf59.34.101', major_brand: 'isom' } },
        isVideoFile: !filePath.endsWith('.mp3'),
        isAudioOnly: filePath.endsWith('.mp3')
      }
    })),
    createPreview: vi.fn(async () => ({ success: true, data: 'http://127.0.0.1:1/preview' })),
    extractWaveform: vi.fn(async () => ({ success: true, data: [0.2, 0.5, 0.8, 0.4] })),
    extractThumbnailStrip: vi.fn(async () => ({ success: false, error: 'stub' })),
    showInFolder: vi.fn(async () => undefined),
    cutMedia: vi.fn(async () => ({ success: true, outputPath: 'C:\\out\\clip-a_trimmed.mp4' })),
    onEditorProgress: vi.fn(() => () => undefined),
    exportTimeline: vi.fn(async () => ({ success: true, outputPath: 'C:\\out\\project.mp4' })),
    selectSavePath: vi.fn(async () => 'C:\\out\\project.mp4'),
    cancelExport: vi.fn(async () => undefined),
    remuxMedia: vi.fn(async () => ({ success: true, outputPath: 'C:\\out\\clip-a_remux.mp4' })),
    getFilePath: vi.fn((file: File) => `C:\\media\\${file.name}`),
    keyframeTimes: vi.fn(async () => ({ success: true, times: [0, 1, 2] })),
    probeReport: vi.fn(async (filePath: string) => ({ success: true, report: JSON.stringify(sampleReport(filePath)) })),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = api
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true })
  stubAudio()
  return api
}

/** An ffprobe report for a 30 second 1280 x 720 H.264 file with stereo AAC, or an audio-only MP3. */
export function sampleReport(filePath: string): Record<string, unknown>
{
  const audioOnly = filePath.endsWith('.mp3')
  const video = {
    index: 0,
    codec_name: 'h264',
    codec_long_name: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    profile: 'High',
    codec_type: 'video',
    width: 1280,
    height: 720,
    sample_aspect_ratio: '1:1',
    display_aspect_ratio: '16:9',
    pix_fmt: 'yuv420p',
    level: 31,
    color_range: 'tv',
    color_space: 'bt709',
    color_transfer: 'bt709',
    color_primaries: 'bt709',
    field_order: 'progressive',
    r_frame_rate: '30/1',
    avg_frame_rate: '30/1',
    duration: '30.000000',
    bit_rate: '3200000',
    bits_per_raw_sample: '8',
    nb_frames: '900',
    disposition: { default: 1, attached_pic: 0 },
    tags: { language: 'und' }
  }
  const audio = {
    index: audioOnly ? 0 : 1,
    codec_name: audioOnly ? 'mp3' : 'aac',
    profile: audioOnly ? undefined : 'LC',
    codec_type: 'audio',
    sample_fmt: 'fltp',
    sample_rate: '48000',
    channels: 2,
    channel_layout: 'stereo',
    bits_per_sample: 0,
    duration: '30.000000',
    bit_rate: '128000',
    disposition: { default: 1 },
    tags: { language: 'eng', title: 'Main mix' }
  }
  return {
    streams: audioOnly ? [audio] : [video, audio],
    format: { filename: filePath, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', format_long_name: 'QuickTime / MOV', start_time: '0.000000', duration: '30.000000', size: '12636000', bit_rate: '3400000', tags: { encoder: 'Lavf59.34.101', major_brand: 'isom' } },
    chapters: []
  }
}

/** A Web Audio stand-in for jsdom: nodes that connect and do nothing. */
function stubAudio(): void
{
  const node = (): Record<string, unknown> =>
  {
    const self: Record<string, unknown> = {
      gain: { value: 1 },
      pan: { value: 0 },
      disconnect: () => undefined
    }
    self.connect = () => self
    return self
  }
  class FakeAudioContext
  {
    state = 'running'
    destination = node()
    createGain = node
    createStereoPanner = node
    createMediaElementSource = node
    resume = async (): Promise<void> => undefined
    close = async (): Promise<void> => undefined
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  HTMLMediaElement.prototype.pause = function (): void {}
  HTMLMediaElement.prototype.load = function (): void {}
  HTMLMediaElement.prototype.play = async function (): Promise<void> {}
}

/** A 30 second 1280 x 720 video source at 30 fps. */
export function videoSource(id = 'src-a', fileName = 'clip-a.mp4'): MediaSource
{
  return {
    id,
    filePath: `C:\\media\\${fileName}`,
    fileName,
    duration: 900,
    frameRate: 30,
    width: 1280,
    height: 720,
    audioChannels: 2,
    audioSampleRate: 48000,
    codec: 'h264',
    format: 'mov,mp4',
    fileSize: 12636000,
    durationSeconds: 30
  }
}

/** A 20 second stereo audio source. */
export function audioSource(id = 'src-t', fileName = 'tone.mp3'): MediaSource
{
  return { ...videoSource(id, fileName), duration: 600, width: 0, height: 0, codec: 'mp3', durationSeconds: 20 }
}

/** A clip of `source` on `trackId`. */
export function clipOf(source: MediaSource, trackId: string, start: number, length: number, id: string): TimelineClip
{
  return {
    id,
    sourceId: source.id,
    trackId,
    timelineStart: start,
    sourceIn: 0,
    sourceOut: length,
    name: source.fileName,
    color: '',
    muted: false,
    locked: false,
    volume: 1,
    pan: 0,
    speed: 1
  }
}

/** Resets the editor to an empty project in the visible editor view. */
export function resetEditor(): void
{
  useEditorStore.getState().resetEditor()
  useAppStore.setState({ currentView: 'editor', config: null })
  window.localStorage.clear()
}

/** Loads sources and clips, with the first source active, in `mode`. */
export function loadProject(mode: 'clip' | 'edit' | 'inspect'): { video: MediaSource, second: MediaSource, audio: MediaSource }
{
  const video = videoSource()
  const second = videoSource('src-b', 'clip-b.mp4')
  const audio = audioSource()
  const tracks = useEditorStore.getState().timeline.tracks
  const v1 = tracks.find((t) => t.type === 'video')!.id
  const a1 = tracks.find((t) => t.type === 'audio')!.id
  const clips = [clipOf(video, v1, 0, 300, 'clip-1'), clipOf(second, v1, 300, 240, 'clip-2'), clipOf(audio, a1, 60, 450, 'clip-3')]
  useEditorStore.setState({
    sources: [video, second, audio],
    clipMode: { sourceId: video.id, inPoint: 0, outPoint: video.duration },
    timeline: { tracks, clips, duration: 540 },
    mode
  })
  return { video, second, audio }
}
