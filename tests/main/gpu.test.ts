/**
 * Contract tests for GPU encoder argument translation.
 *
 * Every flag name and named constant asserted here was read out of the
 * encoders' own AVOption tables via `ffmpeg -h encoder=<name>`, which is
 * generated from the encoder source and therefore matches the binary
 * exactly. A wrong constant here does not fail loudly; FFmpeg rejects the
 * option and the whole encode dies, or silently ignores the intent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), ffmpeg: vi.fn() }
}))

const mockRunCommand = vi.fn()
vi.mock('../../src/main/ffmpeg/runner', () => ({
  runCommand: (...a: unknown[]) => mockRunCommand(...a)
}))

import {
  getGpuPreset,
  getGpuQualityArgs,
  getHwaccelInputArgs,
  resolveGpuCodec,
  resolveEffectiveMode,
  resetGpuDetection,
  type GpuMode
} from '../../src/main/ffmpeg/gpu'

beforeEach(() => {
  vi.clearAllMocks()
  resetGpuDetection()
})

/* ------------------------------------------------------------------ */
/*  Quality translation                                                */
/* ------------------------------------------------------------------ */

describe('getGpuQualityArgs', () => {
  it('uses constant-QP rate control for NVENC', () => {
    // h264_nvenc: -rc has a "constqp" constant; -qp is the constant
    // quantiser. (-cq is the VBR constant-quality knob, a different mode.)
    expect(getGpuQualityArgs('nvenc', 23)).toEqual(['-rc', 'constqp', '-qp', '23'])
  })

  it('uses global_quality for QSV', () => {
    // h264_qsv exposes no -crf; -global_quality is a generic encoder option.
    expect(getGpuQualityArgs('qsv', 23)).toEqual(['-global_quality', '23'])
  })

  it('sets every frame type\'s quantiser for AMF', () => {
    // h264_amf has -qp_i, -qp_p and -qp_b, each defaulting to -1 (encoder
    // chooses). Leaving qp_b unset left B-frames outside the requested
    // quality.
    expect(getGpuQualityArgs('amf', 23)).toEqual([
      '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-qp_b', '23'
    ])
  })

  it('falls back to crf when no GPU is active', () => {
    expect(getGpuQualityArgs('off', 18)).toEqual(['-crf', '18'])
  })

  it('carries the value through unchanged for every mode', () => {
    for (const mode of ['nvenc', 'qsv', 'amf', 'off'] as GpuMode[]) {
      expect(getGpuQualityArgs(mode, 0).join(' '), mode).toContain('0')
      expect(getGpuQualityArgs(mode, 51).join(' '), mode).toContain('51')
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Preset translation                                                 */
/* ------------------------------------------------------------------ */

describe('getGpuPreset', () => {
  it('maps to NVENC p-presets in the right direction', () => {
    // p1 is "fastest (lowest quality)", p7 is "slowest (best quality)".
    expect(getGpuPreset('nvenc', 'veryslow')).toEqual(['-preset', 'p7'])
    expect(getGpuPreset('nvenc', 'slow')).toEqual(['-preset', 'p6'])
    expect(getGpuPreset('nvenc', 'medium')).toEqual(['-preset', 'p4'])
    expect(getGpuPreset('nvenc', 'fast')).toEqual(['-preset', 'p2'])
    expect(getGpuPreset('nvenc', 'veryfast')).toEqual(['-preset', 'p1'])
  })

  it('maps to QSV preset names the encoder actually defines', () => {
    // h264_qsv -preset constants: veryfast faster fast medium slow slower veryslow
    const valid = new Set(['veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
    for (const p of ['veryslow', 'slow', 'medium', 'fast', 'veryfast']) {
      const args = getGpuPreset('qsv', p)
      expect(args[0]).toBe('-preset')
      expect(valid.has(args[1]), `${p} -> ${args[1]}`).toBe(true)
    }
  })

  it('uses -quality with AMF\'s own constants', () => {
    // h264_amf -quality constants: speed, balanced, quality.
    const valid = new Set(['speed', 'balanced', 'quality'])
    for (const p of ['veryslow', 'slow', 'medium', 'fast', 'veryfast']) {
      const args = getGpuPreset('amf', p)
      expect(args[0]).toBe('-quality')
      expect(valid.has(args[1]), `${p} -> ${args[1]}`).toBe(true)
    }
  })

  it('passes the software preset straight through when GPU is off', () => {
    expect(getGpuPreset('off', 'slower')).toEqual(['-preset', 'slower'])
  })

  it('falls back to a valid preset for an unknown speed name', () => {
    expect(getGpuPreset('nvenc', 'nonsense')).toEqual(['-preset', 'medium'])
  })
})

/* ------------------------------------------------------------------ */
/*  Hwaccel input flags                                                */
/* ------------------------------------------------------------------ */

describe('getHwaccelInputArgs', () => {
  it('returns the decode flags per mode', () => {
    expect(getHwaccelInputArgs('nvenc', false)).toEqual(['-hwaccel', 'cuda'])
    expect(getHwaccelInputArgs('qsv', false)).toEqual(['-hwaccel', 'qsv'])
    expect(getHwaccelInputArgs('amf', false)).toEqual(['-hwaccel', 'auto'])
  })

  it('never pins frames to GPU surfaces', () => {
    // -hwaccel_output_format would keep decoded frames on the device and
    // exhaust the surface pool when batch workers run concurrently
    // ("No decoder surfaces left").
    for (const mode of ['nvenc', 'qsv', 'amf'] as GpuMode[]) {
      expect(getHwaccelInputArgs(mode, false)).not.toContain('-hwaccel_output_format')
    }
  })

  it('drops hwaccel when a complex filtergraph is present', () => {
    // Filtergraphs need software pixel formats.
    for (const mode of ['nvenc', 'qsv', 'amf'] as GpuMode[]) {
      expect(getHwaccelInputArgs(mode, true), mode).toEqual([])
    }
  })

  it('returns nothing when GPU is off', () => {
    expect(getHwaccelInputArgs('off', false)).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/*  Codec resolution                                                   */
/* ------------------------------------------------------------------ */

describe('resolveGpuCodec', () => {
  it('passes software codecs through when GPU is off', async () => {
    const r = await resolveGpuCodec('/ffmpeg', 'libx264', 'off')
    expect(r).toEqual({ codec: 'libx264', activeMode: 'off', isGpu: false })
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('maps H.264 and H.265 for each vendor', async () => {
    for (const [mode, h264, h265] of [
      ['nvenc', 'h264_nvenc', 'hevc_nvenc'],
      ['qsv', 'h264_qsv', 'hevc_qsv'],
      ['amf', 'h264_amf', 'hevc_amf']
    ] as const) {
      expect((await resolveGpuCodec('/ffmpeg', 'libx264', mode)).codec).toBe(h264)
      expect((await resolveGpuCodec('/ffmpeg', 'libx265', mode)).codec).toBe(h265)
    }
  })

  it('falls back to software for codecs with no GPU equivalent', async () => {
    for (const codec of ['libvpx-vp9', 'libaom-av1', 'libsvtav1', 'prores_ks', 'ffv1']) {
      const r = await resolveGpuCodec('/ffmpeg', codec, 'nvenc')
      expect(r.codec, codec).toBe(codec)
      expect(r.isGpu, codec).toBe(false)
      expect(r.activeMode, codec).toBe('off')
    }
  })

  it('detects a working encoder in auto mode', async () => {
    mockRunCommand
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: 'h264_nvenc h264_qsv', stderr: '' }) })
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }) })
    const r = await resolveGpuCodec('/ffmpeg', 'libx264', 'auto')
    expect(r).toEqual({ codec: 'h264_nvenc', activeMode: 'nvenc', isGpu: true })
  })

  it('falls back to software when auto detection finds nothing', async () => {
    mockRunCommand.mockReturnValue({
      promise: Promise.resolve({ code: 1, stdout: '', stderr: 'no device' })
    })
    const r = await resolveGpuCodec('/ffmpeg', 'libx264', 'auto')
    expect(r.isGpu).toBe(false)
    expect(r.codec).toBe('libx264')
  })

  it('skips a vendor whose encoder is not compiled in', async () => {
    // Encoder list omits nvenc, so only qsv should be test-encoded.
    mockRunCommand
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: 'h264_qsv h264_amf', stderr: '' }) })
      .mockReturnValue({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }) })
    const r = await resolveGpuCodec('/ffmpeg', 'libx264', 'auto')
    expect(r.activeMode).toBe('qsv')
  })
})

describe('resolveEffectiveMode', () => {
  it('short-circuits for off', async () => {
    expect(await resolveEffectiveMode('/ffmpeg', 'off')).toBe('off')
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('returns an explicit mode without probing', async () => {
    expect(await resolveEffectiveMode('/ffmpeg', 'nvenc')).toBe('nvenc')
    expect(mockRunCommand).not.toHaveBeenCalled()
  })
})
