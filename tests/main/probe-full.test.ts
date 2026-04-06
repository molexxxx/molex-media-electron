import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

// Mock config
const mockGetConfig = vi.fn()
vi.mock('../../src/main/config', () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args)
}))

// Mock child_process spawn for ffprobe
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({ spawn: (...args: any[]) => mockSpawn(...args) }))

import { EventEmitter } from 'events'
import { probeMedia } from '../../src/main/ffmpeg/probe'

function createMockProbeProcess(jsonOutput: string) {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = vi.fn()

  // Emit stdout data on next tick
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(jsonOutput))
    proc.emit('close', 0)
  }, 0)

  return proc
}

const sampleProbeOutput = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      r_frame_rate: '30/1',
      pix_fmt: 'yuv420p',
      profile: 'High',
      duration: '120.5',
      bit_rate: '5000000',
      tags: { language: 'und' },
      disposition: { default: 1 }
    },
    {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
      sample_rate: '48000',
      bit_rate: '256000',
      channel_layout: 'stereo',
      profile: 'LC',
      tags: { language: 'eng', title: 'Main Audio' },
      disposition: { default: 1 }
    },
    {
      index: 2,
      codec_type: 'subtitle',
      codec_name: 'srt',
      tags: { language: 'eng', title: 'English' },
      disposition: { default: 0, forced: 0 }
    }
  ],
  format: {
    filename: '/test/video.mkv',
    duration: '120.5',
    size: '75000000',
    bit_rate: '5256000',
    format_name: 'matroska,webm',
    tags: { title: 'Test Video', ENCODER: 'ffmpeg' }
  }
}

describe('probeMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockResolvedValue({ ffprobePath: '/usr/bin/ffprobe' })
  })

  it('parses video, audio, and subtitle streams correctly', async () => {
    const proc = createMockProbeProcess(JSON.stringify(sampleProbeOutput))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/video.mkv')

    expect(result.videoStreams).toHaveLength(1)
    expect(result.videoStreams[0].codec_name).toBe('h264')
    expect(result.videoStreams[0].width).toBe(1920)
    expect(result.videoStreams[0].height).toBe(1080)

    expect(result.audioStreams).toHaveLength(1)
    expect(result.audioStreams[0].codec_name).toBe('aac')
    expect(result.audioStreams[0].channels).toBe(2)
    expect(result.audioStreams[0].sample_rate).toBe('48000')

    expect(result.subtitleStreams).toHaveLength(1)
    expect(result.subtitleStreams[0].codec_name).toBe('srt')
    expect(result.subtitleStreams[0].tags?.language).toBe('eng')
  })

  it('identifies video files correctly', async () => {
    const proc = createMockProbeProcess(JSON.stringify(sampleProbeOutput))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/video.mkv')
    expect(result.isVideoFile).toBe(true)
    expect(result.isAudioOnly).toBe(false)
  })

  it('identifies audio-only files correctly', async () => {
    const audioOnly = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' }
      ],
      format: { filename: 'song.mp3', duration: '180', size: '5000000', bit_rate: '320000', format_name: 'mp3' }
    }
    const proc = createMockProbeProcess(JSON.stringify(audioOnly))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/song.mp3')
    expect(result.isVideoFile).toBe(false)
    expect(result.isAudioOnly).toBe(true)
    expect(result.audioStreams).toHaveLength(1)
    expect(result.videoStreams).toHaveLength(0)
  })

  it('handles files with no subtitle streams', async () => {
    const noSubs = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'flac', channels: 2, sample_rate: '96000' }
      ],
      format: { filename: 'hires.flac', duration: '300', size: '100000000', bit_rate: '2800000', format_name: 'flac' }
    }
    const proc = createMockProbeProcess(JSON.stringify(noSubs))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/hires.flac')
    expect(result.subtitleStreams).toHaveLength(0)
  })

  it('throws when ffprobe path is not configured', async () => {
    mockGetConfig.mockResolvedValue({ ffprobePath: '' })
    await expect(probeMedia('/test/file.mp3')).rejects.toThrow('ffprobe path not configured')
  })

  it('parses format metadata correctly', async () => {
    const proc = createMockProbeProcess(JSON.stringify(sampleProbeOutput))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/video.mkv')
    expect(result.format.format_name).toBe('matroska,webm')
    expect(result.format.duration).toBe('120.5')
    expect(result.format.size).toBe('75000000')
    expect(result.format.tags?.title).toBe('Test Video')
  })

  it('falls back to fallback probe on JSON parse error', async () => {
    // Primary probe returns invalid JSON
    const primaryProc = createMockProbeProcess('NOT VALID JSON')
    // Fallback probe returns valid data
    const fallbackProc = createMockProbeProcess(JSON.stringify({
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' }
      ],
      format: { filename: 'test.mp3', duration: '60', size: '1000000', bit_rate: '128000', format_name: 'mp3' }
    }))
    mockSpawn.mockReturnValueOnce(primaryProc).mockReturnValueOnce(fallbackProc)

    const result = await probeMedia('/test/broken.mp3')
    expect(result.audioStreams).toHaveLength(1)
  })

  it('preserves disposition flags on streams', async () => {
    const proc = createMockProbeProcess(JSON.stringify(sampleProbeOutput))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/video.mkv')
    expect(result.videoStreams[0].disposition?.default).toBe(1)
    expect(result.audioStreams[0].disposition?.default).toBe(1)
    expect(result.subtitleStreams[0].disposition?.default).toBe(0)
  })

  it('handles channels as strings by parsing to int', async () => {
    const data = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'aac', channels: '6', sample_rate: '48000' }
      ],
      format: { filename: 'surround.m4a', duration: '180', size: '5000000', bit_rate: '640000', format_name: 'mov' }
    }
    const proc = createMockProbeProcess(JSON.stringify(data))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/surround.m4a')
    expect(result.audioStreams[0].channels).toBe(6)
  })

  it('uses fallback values for missing stream fields', async () => {
    const data = {
      streams: [
        { index: 0, codec_type: 'audio' },
        { index: 1, codec_type: 'video' },
        { index: 2, codec_type: 'subtitle' }
      ],
      format: {}
    }
    const proc = createMockProbeProcess(JSON.stringify(data))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/sparse.mkv')
    expect(result.audioStreams[0].codec_name).toBe('unknown')
    expect(result.audioStreams[0].channels).toBe(2)
    expect(result.audioStreams[0].sample_rate).toBe('48000')
    expect(result.videoStreams[0].codec_name).toBe('unknown')
    expect(result.videoStreams[0].width).toBe(0)
    expect(result.videoStreams[0].height).toBe(0)
    expect(result.subtitleStreams[0].codec_name).toBe('unknown')
    expect(result.format.duration).toBe('0')
    expect(result.format.size).toBe('0')
    expect(result.format.format_name).toBe('unknown')
  })

  it('returns default MediaInfo when fallback probe also fails', async () => {
    // Primary probe fails with invalid JSON
    const primaryProc = createMockProbeProcess('INVALID')
    // Fallback probe also fails (non-zero exit)
    const fallbackProc = new EventEmitter() as any
    fallbackProc.stdout = new EventEmitter()
    fallbackProc.stderr = new EventEmitter()
    fallbackProc.killed = false
    fallbackProc.kill = vi.fn()
    setTimeout(() => {
      fallbackProc.stderr.emit('data', Buffer.from('error'))
      fallbackProc.emit('close', 1)
    }, 0)

    mockSpawn.mockReturnValueOnce(primaryProc).mockReturnValueOnce(fallbackProc)

    const result = await probeMedia('/test/corrupt.mp3')
    expect(result.audioStreams).toHaveLength(1)
    expect(result.audioStreams[0].codec_name).toBe('unknown')
    expect(result.isAudioOnly).toBe(true)
  })

  it('handles empty streams array', async () => {
    const data = {
      streams: [],
      format: { filename: 'empty.dat', duration: '0', size: '0', bit_rate: '0', format_name: 'raw' }
    }
    const proc = createMockProbeProcess(JSON.stringify(data))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/empty.dat')
    expect(result.audioStreams).toHaveLength(0)
    expect(result.videoStreams).toHaveLength(0)
    expect(result.isVideoFile).toBe(false)
    expect(result.isAudioOnly).toBe(false)
  })

  it('parses data and attachment streams', async () => {
    const data = {
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
        { index: 1, codec_type: 'data', codec_name: 'bin_data', tags: { handler_name: 'SubtitleHandler' } },
        { index: 2, codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'font.ttf' }, disposition: { attached_pic: 0 } }
      ],
      format: { filename: 'test.mkv', duration: '120', size: '5000000', bit_rate: '300000', format_name: 'matroska' }
    }
    const proc = createMockProbeProcess(JSON.stringify(data))
    mockSpawn.mockReturnValue(proc)

    const result = await probeMedia('/test/with-data.mkv')
    expect(result.dataStreams).toHaveLength(2)
    expect(result.dataStreams![0].codec_type).toBe('data')
    expect(result.dataStreams![1].codec_type).toBe('attachment')
    expect(result.dataStreams![1].codec_name).toBe('ttf')
  })

  it('fallback probe provides audio even when no streams parsed', async () => {
    // Primary probe fails with invalid JSON
    const primaryProc = createMockProbeProcess('BROKEN JSON')
    // Fallback returns empty streams
    const fallbackProc = createMockProbeProcess(JSON.stringify({ streams: [] }))
    mockSpawn.mockReturnValueOnce(primaryProc).mockReturnValueOnce(fallbackProc)

    const result = await probeMedia('/test/empty-fallback.mp3')
    // fallbackProbe pushes a default audio stream when length === 0
    expect(result.audioStreams).toHaveLength(1)
    expect(result.audioStreams[0].codec_name).toBe('unknown')
    expect(result.audioStreams[0].channels).toBe(2)
  })

  it('fallback probe handles missing streams key in JSON', async () => {
    const primaryProc = createMockProbeProcess('BROKEN')
    const fallbackProc = createMockProbeProcess(JSON.stringify({ format: { duration: '60' } }))
    mockSpawn.mockReturnValueOnce(primaryProc).mockReturnValueOnce(fallbackProc)

    const result = await probeMedia('/test/no-streams-key.mp3')
    expect(result.audioStreams).toHaveLength(1)
    expect(result.audioStreams[0].codec_name).toBe('unknown')
  })

  it('fallback probe uses defaults for sparse stream fields', async () => {
    const primaryProc = createMockProbeProcess('BROKEN')
    const fallbackProc = createMockProbeProcess(JSON.stringify({
      streams: [{}]
    }))
    mockSpawn.mockReturnValueOnce(primaryProc).mockReturnValueOnce(fallbackProc)

    const result = await probeMedia('/test/sparse-fb.mp3')
    expect(result.audioStreams).toHaveLength(1)
    expect(result.audioStreams[0].index).toBe(0)
    expect(result.audioStreams[0].codec_name).toBe('unknown')
    expect(result.audioStreams[0].channels).toBe(2)
    expect(result.audioStreams[0].sample_rate).toBe('48000')
  })
})
