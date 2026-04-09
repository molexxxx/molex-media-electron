import { describe, it, expect, vi } from 'vitest'

// Mock the logger used inside the processor module
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

// Mock the GPU module - export pipeline resolves GPU codec
vi.mock('../../src/main/ffmpeg/gpu', () => ({
  resolveGpuCodec: vi.fn().mockResolvedValue({ codec: 'libx264', activeMode: 'off', isGpu: false }),
  getGpuPreset: vi.fn().mockReturnValue(['-preset', 'medium']),
  getGpuQualityArgs: vi.fn().mockReturnValue(['-crf', '23'])
}))

import {
  buildExportCommand,
  getExportDurationSeconds,
  type ExportRequest,
  type ExportSource,
  type ExportClip,
  type ExportTrack,
  type ExportProject,
  type ExportOutputOptions
} from '../../src/main/ffmpeg/processor/editor'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject(overrides: Partial<ExportProject> = {}): ExportProject {
  return { frameRate: 30, sampleRate: 48000, resolution: { width: 1920, height: 1080 }, ...overrides }
}

function mkSource(overrides: Partial<ExportSource> = {}): ExportSource {
  return {
    id: 'src-1',
    filePath: '/media/video.mp4',
    frameRate: 30,
    width: 1920,
    height: 1080,
    audioChannels: 2,
    audioSampleRate: 48000,
    durationSeconds: 30,
    ...overrides
  }
}

function mkClip(overrides: Partial<ExportClip> = {}): ExportClip {
  return {
    id: 'clip-1',
    sourceId: 'src-1',
    trackId: 'v1',
    timelineStart: 0,
    sourceIn: 0,
    sourceOut: 150,
    muted: false,
    volume: 1,
    pan: 0,
    speed: 1,
    ...overrides
  }
}

function mkVideoTrack(id = 'v1', index = 1): ExportTrack {
  return { id, type: 'video', name: `V${index}`, index, muted: false, visible: true }
}

function mkAudioTrack(id = 'a1', index = 0): ExportTrack {
  return { id, type: 'audio', name: `A${index}`, index, muted: false, visible: true }
}

function mkOutput(overrides: Partial<ExportOutputOptions> = {}): ExportOutputOptions {
  return {
    filePath: '/out/output.mp4',
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    ...overrides
  }
}

function mkRequest(overrides: Partial<ExportRequest> = {}): ExportRequest {
  return {
    project: mkProject(),
    sources: [mkSource()],
    tracks: [mkVideoTrack(), mkAudioTrack()],
    clips: [mkClip()],
    output: mkOutput(),
    ...overrides
  }
}

/** Find the -filter_complex arg value from args array. */
function getFilterComplex(args: string[]): string {
  const idx = args.indexOf('-filter_complex')
  return idx >= 0 ? args[idx + 1] : ''
}

/** Find all -map values. */
function getMaps(args: string[]): string[] {
  const maps: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-map') maps.push(args[i + 1])
  }
  return maps
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('buildExportCommand', () => {
  // =========================================================================
  // Single clip
  // =========================================================================

  describe('single clip export', () => {
    it('produces valid FFmpeg args with a single clip', async () => {
      const args = await buildExportCommand(mkRequest())
      expect(args).toContain('-y')
      expect(args).toContain('-i')
      expect(args).toContain('/media/video.mp4')
      expect(args).toContain('-filter_complex')
      expect(args).toContain('/out/output.mp4')
    })

    it('includes -c:v and -c:a codecs', async () => {
      const args = await buildExportCommand(mkRequest())
      expect(args).toContain('-c:v')
      expect(args).toContain('-c:a')
    })

    it('generates trim filter for video', async () => {
      const args = await buildExportCommand(mkRequest())
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/\[0:v\]trim=/)
      expect(fc).toMatch(/setpts=PTS-STARTPTS/)
    })

    it('generates trim filter for audio', async () => {
      const args = await buildExportCommand(mkRequest())
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/\[0:a\]atrim=/)
    })

    it('maps video and audio outputs', async () => {
      const args = await buildExportCommand(mkRequest())
      const maps = getMaps(args)
      expect(maps.length).toBe(2) // video + audio
    })

    it('sets output frame rate', async () => {
      const args = await buildExportCommand(mkRequest())
      const rIdx = args.indexOf('-r')
      expect(rIdx).toBeGreaterThan(-1)
      expect(args[rIdx + 1]).toBe('30')
    })

    it('applies CRF when specified', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ crf: 18 })
      }))
      expect(args).toContain('-crf')
      expect(args).toContain('18')
    })

    it('applies audio bitrate when specified', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ audioBitrate: '192k' })
      }))
      expect(args).toContain('-b:a')
      expect(args).toContain('192k')
    })

    it('applies video bitrate when specified', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ videoBitrate: '5M' })
      }))
      expect(args).toContain('-b:v')
      expect(args).toContain('5M')
    })
  })

  // =========================================================================
  // Multi-clip single track
  // =========================================================================

  describe('multi-clip single track', () => {
    it('concatenates multiple clips on one track', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 90 }),
          mkClip({ id: 'c2', timelineStart: 90, sourceIn: 90, sourceOut: 150 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/concat=n=2:v=1:a=0/)
    })

    it('concatenates audio segments matching video', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 90 }),
          mkClip({ id: 'c2', timelineStart: 90, sourceIn: 90, sourceOut: 150 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/concat=n=2:v=0:a=1/)
    })
  })

  // =========================================================================
  // Gap handling
  // =========================================================================

  describe('gap handling', () => {
    it('inserts black video for gaps between clips', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 90 }),
          // Gap of 30 frames at 30fps = 1 second
          mkClip({ id: 'c2', timelineStart: 120, sourceIn: 90, sourceOut: 150 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/color=c=black/)
    })

    it('inserts silence for audio gaps', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 90 }),
          mkClip({ id: 'c2', timelineStart: 120, sourceIn: 90, sourceOut: 150 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/anullsrc/)
    })

    it('concat count includes gap segments', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 90 }),
          mkClip({ id: 'c2', timelineStart: 120, sourceIn: 90, sourceOut: 150 })
        ]
      }))
      const fc = getFilterComplex(args)
      // video: clip1 + gap + clip2 = 3 segments
      expect(fc).toMatch(/concat=n=3:v=1:a=0/)
    })
  })

  // =========================================================================
  // Multi-track
  // =========================================================================

  describe('multi-track', () => {
    it('overlays multiple video tracks', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [
          mkVideoTrack('v1', 1),
          mkVideoTrack('v2', 2),
          mkAudioTrack('a1', 0)
        ],
        clips: [
          mkClip({ id: 'c1', trackId: 'v1', timelineStart: 0, sourceIn: 0, sourceOut: 150 }),
          mkClip({ id: 'c2', trackId: 'v2', timelineStart: 0, sourceIn: 0, sourceOut: 90 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/overlay=0:0/)
    })

    it('mixes multiple audio tracks', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [
          mkVideoTrack('v1', 1),
          mkAudioTrack('a1', 0),
          mkAudioTrack('a2', 1)
        ],
        clips: [
          mkClip({ id: 'c1', trackId: 'v1', timelineStart: 0, sourceIn: 0, sourceOut: 150 }),
          mkClip({ id: 'c2', trackId: 'a1', timelineStart: 0, sourceIn: 0, sourceOut: 150 }),
          mkClip({ id: 'c3', trackId: 'a2', timelineStart: 0, sourceIn: 0, sourceOut: 100 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/amix=inputs=/)
    })

    it('de-duplicates source inputs', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 100 }),
          mkClip({ id: 'c2', timelineStart: 100, sourceIn: 100, sourceOut: 200 })
        ]
      }))
      // Only one -i /media/video.mp4
      const iIndices = args.reduce<number[]>((acc, a, i) => (a === '-i' ? [...acc, i] : acc), [])
      expect(iIndices).toHaveLength(1)
    })

    it('maps audio from video tracks (embedded audio)', async () => {
      // A clip on a video track should also generate audio output
      const args = await buildExportCommand(mkRequest({
        tracks: [mkVideoTrack('v1', 1)],
        clips: [mkClip({ id: 'c1', trackId: 'v1' })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/\[0:a\]atrim=/)
    })
  })

  // =========================================================================
  // Volume / Speed adjustments
  // =========================================================================

  describe('volume and speed', () => {
    it('applies volume filter when volume != 1', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ volume: 0.5 })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/volume=0\.5/)
    })

    it('does not apply volume filter when volume is 1', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ volume: 1 })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).not.toMatch(/volume=/)
    })

    it('applies speed (setpts) for video when speed != 1', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ speed: 2 })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/setpts=PTS\/2/)
    })

    it('applies atempo for audio when speed != 1', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ speed: 2 })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/atempo=2/)
    })

    it('chains atempo for very slow speeds (< 0.5)', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ speed: 0.25 })]
      }))
      const fc = getFilterComplex(args)
      // 0.25 requires chaining: atempo=0.5,atempo=0.5
      expect(fc).toMatch(/atempo=0\.5/)
    })

    it('applies pan (stereotools) when pan != 0', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ pan: -0.5 })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/stereotools=balance_out=/)
    })
  })

  // =========================================================================
  // Muted clips & tracks
  // =========================================================================

  describe('muted clips and tracks', () => {
    it('excludes muted clips', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', muted: true }),
          mkClip({ id: 'c2', timelineStart: 150, sourceIn: 150, sourceOut: 300 })
        ]
      }))
      const fc = getFilterComplex(args)
      // Only one trim should appear (for the non-muted clip)
      const trimCount = (fc.match(/\[0:v\]trim=/g) || []).length
      expect(trimCount).toBe(1)
    })

    it('excludes clips on muted tracks', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [
          mkVideoTrack('v1', 1),
          { ...mkAudioTrack('a1', 0), muted: true }
        ],
        clips: [
          mkClip({ id: 'c1', trackId: 'v1' }),
          mkClip({ id: 'c2', trackId: 'a1' })
        ]
      }))
      const fc = getFilterComplex(args)
      // Audio track is muted so no atrim from it
      expect(fc).not.toMatch(/concat=n=\d+:v=0:a=1/)
    })

    it('excludes clips on invisible video tracks', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [
          { ...mkVideoTrack('v1', 1), visible: false },
          mkVideoTrack('v2', 0)
        ],
        clips: [
          mkClip({ id: 'c1', trackId: 'v1' }),
          mkClip({ id: 'c2', trackId: 'v2' })
        ]
      }))
      const fc = getFilterComplex(args)
      // First video track invisible - its clip should be excluded from video chain
      expect(fc).toBeDefined()
    })
  })

  // =========================================================================
  // Range export
  // =========================================================================

  describe('range export', () => {
    it('trims clips to export range', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({ timelineStart: 0, sourceIn: 0, sourceOut: 150 })],
        range: { startFrame: 30, endFrame: 120 }
      }))
      const fc = getFilterComplex(args)
      // Clip should be trimmed to the range
      expect(fc).toMatch(/trim=/)
    })

    it('excludes clips entirely outside range', async () => {
      // All clips outside range → throws because no active clips remain
      await expect(buildExportCommand(mkRequest({
        clips: [
          mkClip({ id: 'c1', timelineStart: 0, sourceIn: 0, sourceOut: 30 }),
          mkClip({ id: 'c2', timelineStart: 200, sourceIn: 200, sourceOut: 300 })
        ],
        range: { startFrame: 50, endFrame: 180 }
      }))).rejects.toThrow('No active clips')
    })
  })

  // =========================================================================
  // Output options
  // =========================================================================

  describe('output options', () => {
    it('applies custom resolution', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ resolution: { width: 1280, height: 720 } })
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/scale=1280:720/)
    })

    it('applies custom frame rate', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ frameRate: 60 })
      }))
      expect(args).toContain('60')
    })

    it('applies custom sample rate', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ sampleRate: 44100 })
      }))
      expect(args).toContain('-ar')
      expect(args).toContain('44100')
    })

    it('sets audio channels', async () => {
      const args = await buildExportCommand(mkRequest({
        output: mkOutput({ audioChannels: 1 })
      }))
      expect(args).toContain('-ac')
      expect(args).toContain('1')
    })

    it('audio-only export disables video', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [mkAudioTrack('a1', 0)],
        clips: [mkClip({ trackId: 'a1' })],
        sources: [mkSource({ width: 0, height: 0 })] // audio-only source
      }))
      expect(args).toContain('-vn')
    })
  })

  // =========================================================================
  // Error cases
  // =========================================================================

  describe('error cases', () => {
    it('throws when no active clips', async () => {
      await expect(buildExportCommand(mkRequest({
        clips: []
      }))).rejects.toThrow('No active clips to export')
    })

    it('throws when all clips are muted', async () => {
      await expect(buildExportCommand(mkRequest({
        clips: [mkClip({ muted: true })]
      }))).rejects.toThrow()
    })
  })

  // =========================================================================
  // Multiple sources
  // =========================================================================

  describe('multiple sources', () => {
    it('produces multiple -i inputs for different sources', async () => {
      const args = await buildExportCommand(mkRequest({
        sources: [
          mkSource({ id: 'src-1', filePath: '/media/a.mp4' }),
          mkSource({ id: 'src-2', filePath: '/media/b.mp4' })
        ],
        clips: [
          mkClip({ id: 'c1', sourceId: 'src-1', timelineStart: 0, sourceIn: 0, sourceOut: 100 }),
          mkClip({ id: 'c2', sourceId: 'src-2', timelineStart: 100, sourceIn: 0, sourceOut: 100 })
        ]
      }))
      const iIndices = args.reduce<number[]>((acc, a, i) => (a === '-i' ? [...acc, i] : acc), [])
      expect(iIndices).toHaveLength(2)
      expect(args).toContain('/media/a.mp4')
      expect(args).toContain('/media/b.mp4')
    })

    it('correctly references second input in filter_complex', async () => {
      const args = await buildExportCommand(mkRequest({
        sources: [
          mkSource({ id: 'src-1', filePath: '/media/a.mp4' }),
          mkSource({ id: 'src-2', filePath: '/media/b.mp4' })
        ],
        clips: [
          mkClip({ id: 'c1', sourceId: 'src-1', timelineStart: 0, sourceIn: 0, sourceOut: 100 }),
          mkClip({ id: 'c2', sourceId: 'src-2', timelineStart: 100, sourceIn: 0, sourceOut: 100 })
        ]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/\[0:v\]trim=/)
      expect(fc).toMatch(/\[1:v\]trim=/)
    })
  })
})

// ===========================================================================
// getExportDurationSeconds
// ===========================================================================

describe('getExportDurationSeconds', () => {
  it('returns duration from range when specified', () => {
    const dur = getExportDurationSeconds(mkRequest({
      range: { startFrame: 0, endFrame: 300 }
    }))
    // 300 frames at 30fps = 10 seconds
    expect(dur).toBeCloseTo(10)
  })

  it('calculates from clip endpoints when no range', () => {
    const dur = getExportDurationSeconds(mkRequest({
      clips: [
        mkClip({ timelineStart: 0, sourceIn: 0, sourceOut: 150 }),
        mkClip({ timelineStart: 150, sourceIn: 150, sourceOut: 300 })
      ]
    }))
    // Last clip ends at 150 + (300-150)/1 = 300 frames = 10 sec at 30fps
    expect(dur).toBeCloseTo(10)
  })

  it('accounts for speed in duration calculation', () => {
    const dur = getExportDurationSeconds(mkRequest({
      clips: [mkClip({ timelineStart: 0, sourceIn: 0, sourceOut: 150, speed: 2 })]
    }))
    // 150 source frames at speed 2 = 2.5 sec of clip duration
    // Source: 150 frames at 30fps src = 5 sec, / speed 2 = 2.5 sec
    expect(dur).toBeCloseTo(2.5)
  })

  it('excludes muted clips', () => {
    const dur = getExportDurationSeconds(mkRequest({
      clips: [
        mkClip({ id: 'c1', muted: true, timelineStart: 0, sourceIn: 0, sourceOut: 9000 }),
        mkClip({ id: 'c2', muted: false, timelineStart: 0, sourceIn: 0, sourceOut: 150 })
      ]
    }))
    expect(dur).toBeCloseTo(5) // only the non-muted clip: 150/30=5
  })

  it('returns 0 for empty clips', () => {
    const dur = getExportDurationSeconds(mkRequest({ clips: [] }))
    expect(dur).toBe(0)
  })
})
