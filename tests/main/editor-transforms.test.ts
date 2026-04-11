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
  type ExportRequest,
  type ExportSource,
  type ExportClip,
  type ExportTrack,
  type ExportProject,
  type ExportOutputOptions,
  type ExportClipTransform,
  type ExportTransformKeyframe,
  type ExportBlendMode
} from '../../src/main/ffmpeg/processor/editor'

// ---------------------------------------------------------------------------
// Helpers (matching editor-pipeline.test.ts conventions)
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

function mkTransform(overrides: Partial<ExportClipTransform> = {}): ExportClipTransform {
  return {
    x: 960,
    y: 540,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    opacity: 1,
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

// ===========================================================================
// TESTS
// ===========================================================================

describe('buildExportCommand - spatial transforms', () => {
  // =========================================================================
  // Legacy path fallback
  // =========================================================================

  describe('legacy path fallback', () => {
    it('uses legacy path when no clips have transforms', async () => {
      const args = await buildExportCommand(mkRequest())
      const fc = getFilterComplex(args)
      // Legacy path: no black background, uses scale+pad (concat only with 2+ clips)
      expect(fc).not.toMatch(/color=c=black/)
      expect(fc).toMatch(/scale=.*pad=/)
    })

    it('uses legacy path for identity transforms', async () => {
      // A 1920x1080 source, identity transform → centered at (960,540), scale = 1.0
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform(), // defaults = identity for 1920x1080
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Legacy path: no black background
      expect(fc).not.toMatch(/color=c=black/)
    })
  })

  // =========================================================================
  // Static transform (non-identity triggers spatial path)
  // =========================================================================

  describe('static transform', () => {
    it('uses spatial compositing when clip has scale transform', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Spatial path starts with a black background
      expect(fc).toMatch(/color=c=black/)
      // Should contain overlay with position
      expect(fc).toMatch(/overlay=/)
    })

    it('generates scale filter for non-1:1 scale', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/scale=960:540/)
    })

    it('generates rotate filter for non-zero rotation', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ rotation: 45 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // rotate filter with radians
      expect(fc).toMatch(/rotate=/)
      expect(fc).toMatch(/format=rgba/)
    })

    it('generates opacity filter for opacity < 1', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ opacity: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/colorchannelmixer=aa=0\.5/)
    })

    it('includes enable=between for time-limited clips', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080,
          timelineStart: 30, // starts at 1 second (30fps)
          sourceIn: 0,
          sourceOut: 60
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/enable='between\(t,/)
    })

    it('includes trim and setpts for source in/out', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080,
          sourceIn: 30,  // 1 second in
          sourceOut: 120  // 4 seconds out
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/trim=start=/)
      expect(fc).toMatch(/setpts=PTS-STARTPTS/)
    })

    it('positions clip offset from center', async () => {
      // Position at (100, 200) instead of center (960, 540)
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ x: 100, y: 200, scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Should see a negative overlay position since it's far from center
      expect(fc).toMatch(/overlay=-?\d+:-?\d+/)
    })
  })

  // =========================================================================
  // Blend modes
  // =========================================================================

  describe('blend modes', () => {
    it('uses spatial path when blend mode is set', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          blendMode: 'multiply',
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/color=c=black/) // spatial path
    })

    it('generates blend filter for non-normal blend mode', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          blendMode: 'screen',
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/blend=all_mode=screen/)
    })

    it('converts both inputs to RGB (gbrp) before blend filter', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          blendMode: 'multiply',
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Foreground should be converted to gbrp before pad
      expect(fc).toMatch(/format=gbrp,pad=/)
      // Base should be converted to gbrp before blend
      expect(fc).toMatch(/format=gbrp\[.*\].*\[.*\]blend=/)
    })

    it('uses overlay (not blend) for normal blend mode in spatial path', async () => {
      // Trigger spatial path via a non-identity transform, normal blend
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          blendMode: 'normal',
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/overlay=/)
      expect(fc).not.toMatch(/blend=all_mode=/)
    })

    it('pads clip before blending to match output size', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          blendMode: 'overlay',
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/format=gbrp,pad=1920:1080/)
    })

    it('uses blend-neutral pad colour (white for multiply, black for screen)', async () => {
      // multiply neutral = white (0xFFFFFF)
      const argsM = await buildExportCommand(mkRequest({
        clips: [mkClip({ blendMode: 'multiply', width: 1920, height: 1080 })]
      }))
      expect(getFilterComplex(argsM)).toMatch(/pad=.*color=0xFFFFFF/)

      // screen neutral = black (0x000000)
      const argsS = await buildExportCommand(mkRequest({
        clips: [mkClip({ blendMode: 'screen', width: 1920, height: 1080 })]
      }))
      expect(getFilterComplex(argsS)).toMatch(/pad=.*color=0x000000/)

      // overlay neutral = mid-gray (0x808080)
      const argsO = await buildExportCommand(mkRequest({
        clips: [mkClip({ blendMode: 'overlay', width: 1920, height: 1080 })]
      }))
      expect(getFilterComplex(argsO)).toMatch(/pad=.*color=0x808080/)
    })

    it('passes clip opacity via blend all_opacity instead of colorchannelmixer', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          blendMode: 'screen',
          transform: mkTransform({ opacity: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/all_opacity=0\.5/)
      expect(fc).not.toMatch(/colorchannelmixer/)
    })

    it('maps all supported blend modes', async () => {
      const modes: ExportBlendMode[] = ['multiply', 'screen', 'overlay', 'darken', 'lighten', 'add', 'difference']
      for (const mode of modes) {
        const args = await buildExportCommand(mkRequest({
          clips: [mkClip({
            blendMode: mode,
            width: 1920,
            height: 1080
          })]
        }))
        const fc = getFilterComplex(args)
        expect(fc).toMatch(/blend=all_mode=/)
      }
    })
  })

  // =========================================================================
  // Keyframes (animated transforms)
  // =========================================================================

  describe('keyframes', () => {
    it('uses spatial path when clip has keyframes', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          keyframes: [
            { frame: 0, transform: mkTransform({ x: 0, y: 0 }), easing: 'linear' },
            { frame: 100, transform: mkTransform({ x: 1920, y: 1080 }), easing: 'linear' }
          ],
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/color=c=black/) // spatial path
    })

    it('generates eval=frame overlay for animated position', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          keyframes: [
            { frame: 0, transform: mkTransform({ x: 0 }), easing: 'linear' },
            { frame: 100, transform: mkTransform({ x: 1920 }), easing: 'linear' }
          ],
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/eval=frame/)
    })

    it('generates animated opacity expression when keyframe opacity varies', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ opacity: 1 }),
          keyframes: [
            { frame: 0, transform: mkTransform({ opacity: 0 }), easing: 'linear' },
            { frame: 100, transform: mkTransform({ opacity: 1 }), easing: 'linear' }
          ],
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/colorchannelmixer=aa='/)
    })

    it('pre-scales to max keyframe scale', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 1, scaleY: 1 }),
          keyframes: [
            { frame: 0, transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }), easing: 'linear' },
            { frame: 100, transform: mkTransform({ scaleX: 2, scaleY: 2 }), easing: 'linear' }
          ],
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Should pre-scale to max (scale 2 → 3840x2160)
      expect(fc).toMatch(/scale=3840:2160/)
    })
  })

  // =========================================================================
  // Multi-track spatial compositing
  // =========================================================================

  describe('multi-track spatial', () => {
    it('overlays clips from multiple video tracks', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [mkVideoTrack('v1', 1), mkVideoTrack('v2', 2), mkAudioTrack()],
        clips: [
          mkClip({
            id: 'c1',
            trackId: 'v1',
            transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
            width: 1920,
            height: 1080
          }),
          mkClip({
            id: 'c2',
            trackId: 'v2',
            sourceId: 'src-1',
            transform: mkTransform({ scaleX: 0.5, scaleY: 0.5, x: 100, y: 100 }),
            width: 1920,
            height: 1080
          })
        ]
      }))
      const fc = getFilterComplex(args)
      // Should have two overlays composited onto the black background
      const overlayCount = (fc.match(/\]overlay=/g) || []).length
      expect(overlayCount).toBe(2)
    })

    it('composites clips bottom track to top track', async () => {
      const args = await buildExportCommand(mkRequest({
        tracks: [mkVideoTrack('v1', 1), mkVideoTrack('v2', 2), mkAudioTrack()],
        clips: [
          mkClip({
            id: 'c1',
            trackId: 'v1', // bottom track
            transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
            width: 1920,
            height: 1080
          }),
          mkClip({
            id: 'c2',
            trackId: 'v2', // top track
            sourceId: 'src-1',
            transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
            width: 1920,
            height: 1080
          })
        ]
      }))
      const fc = getFilterComplex(args)
      // The filter chain should build sequentially: base → overlay c1 → overlay c2
      // We verify there are chained overlays
      expect(fc).toMatch(/overlay=.*\[.*\].*overlay=/)
    })

    it('includes audio output even in spatial mode', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      // Should still have -c:a for audio
      expect(args).toContain('-c:a')
    })
  })

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles clip with transform but no width/height (uses source dimensions)', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 })
          // no width/height - should fall back to source.width/height (1920x1080)
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/scale=960:540/)
    })

    it('handles combined transform + blend mode + keyframes', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          blendMode: 'screen',
          keyframes: [
            { frame: 0, transform: mkTransform({ x: 0 }), easing: 'linear' },
            { frame: 100, transform: mkTransform({ x: 960 }), easing: 'linear' }
          ],
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      // Should use spatial path
      expect(fc).toMatch(/color=c=black/)
      // Keyframed path with blend → blend filter
      expect(fc).toMatch(/blend=all_mode=screen/)
    })

    it('speed adjustment is preserved in spatial path', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [mkClip({
          speed: 2,
          transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
          width: 1920,
          height: 1080
        })]
      }))
      const fc = getFilterComplex(args)
      expect(fc).toMatch(/setpts=PTS\/2/)
    })

    it('muted clips are excluded from spatial compositing', async () => {
      const args = await buildExportCommand(mkRequest({
        clips: [
          mkClip({
            id: 'c1',
            muted: true,
            transform: mkTransform({ scaleX: 0.5, scaleY: 0.5 }),
            width: 1920,
            height: 1080
          }),
          mkClip({
            id: 'c2',
            sourceIn: 0,
            sourceOut: 150,
            width: 1920,
            height: 1080
          })
        ]
      }))
      const fc = getFilterComplex(args)
      // With the muted transform clip excluded, should fall back to legacy if c2 has no transform
      expect(fc).not.toMatch(/color=c=black/)
    })
  })
})
