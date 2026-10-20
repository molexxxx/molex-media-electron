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
  adapterFor,
  adapterQuery,
  detectGpuSummary,
  gpuEncodersFor,
  listGpuAdapters,
  parseAdapterNames,
  vendorOfAdapter,
  vendorOfMode,
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

describe('adapter names', () => {
  // Recorded on Windows 11 from (Get-CimInstance Win32_VideoController).Name on a machine with two adapters.
  const WINDOWS = 'NVIDIA GeForce RTX 4070 SUPER\r\nAMD Radeon(TM) Graphics\r\n'
  const MAC = 'Graphics/Displays:\n\n    Apple M2:\n\n      Chipset Model: Apple M2\n      Type: GPU\n'
  const LINUX = '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)\n' +
    '01:00.0 3D controller: NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile] (rev a1)\n' +
    '00:1f.3 Audio device: Intel Corporation Cannon Lake PCH cAVS (rev 10)\n'

  it('parses the listing of each platform', () => {
    expect(parseAdapterNames('win32', WINDOWS)).toEqual(['NVIDIA GeForce RTX 4070 SUPER', 'AMD Radeon(TM) Graphics'])
    expect(parseAdapterNames('darwin', MAC)).toEqual(['Apple M2'])
    expect(parseAdapterNames('linux', LINUX)).toEqual(['Intel Corporation UHD Graphics 630', 'NVIDIA Corporation TU117M [GeForce GTX 1650 Mobile]'])
  })

  it('names the vendor of an adapter', () => {
    expect(vendorOfAdapter('NVIDIA GeForce RTX 4070 SUPER')).toBe('nvidia')
    expect(vendorOfAdapter('Quadro P2000')).toBe('nvidia')
    expect(vendorOfAdapter('Intel(R) UHD Graphics 770')).toBe('intel')
    expect(vendorOfAdapter('AMD Radeon(TM) Graphics')).toBe('amd')
    expect(vendorOfAdapter('Apple M2')).toBeNull()
  })

  it('picks the adapter of the encoding vendor, else the first one', () => {
    const names = parseAdapterNames('win32', WINDOWS)
    expect(adapterFor(names, 'nvidia')).toBe('NVIDIA GeForce RTX 4070 SUPER')
    expect(adapterFor(names, 'amd')).toBe('AMD Radeon(TM) Graphics')
    expect(adapterFor(names, 'intel')).toBe('NVIDIA GeForce RTX 4070 SUPER')
    expect(adapterFor(names, null)).toBe('NVIDIA GeForce RTX 4070 SUPER')
    expect(adapterFor([], 'nvidia')).toBeNull()
  })

  it('maps modes to vendors and encoders', () => {
    expect(vendorOfMode('nvenc')).toBe('nvidia')
    expect(vendorOfMode('qsv')).toBe('intel')
    expect(vendorOfMode('amf')).toBe('amd')
    expect(vendorOfMode('off')).toBeNull()
    expect(vendorOfMode('auto')).toBeNull()
    expect(gpuEncodersFor('nvenc')).toEqual(['h264_nvenc', 'hevc_nvenc'])
    expect(gpuEncodersFor('off')).toEqual([])
  })

  it('queries without a shell on each platform', () => {
    expect(adapterQuery('win32', 'D:\\Windows')).toEqual({
      file: 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name']
    })
    expect(adapterQuery('darwin')?.file).toBe('/usr/sbin/system_profiler')
    expect(adapterQuery('linux')?.file).toBe('lspci')
    expect(adapterQuery('aix')).toBeNull()
  })

  it('reads the listing once and keeps it until detection resets', async () => {
    mockRunCommand.mockReturnValue({ promise: Promise.resolve({ code: 0, stdout: WINDOWS, stderr: '' }) })
    expect(await listGpuAdapters('win32')).toHaveLength(2)
    expect(await listGpuAdapters('win32')).toHaveLength(2)
    expect(mockRunCommand).toHaveBeenCalledTimes(1)
    expect(mockRunCommand.mock.calls[0][3]).toEqual({ log: false })
    resetGpuDetection()
    await listGpuAdapters('win32')
    expect(mockRunCommand).toHaveBeenCalledTimes(2)
  })

  it('answers an empty list when the query fails, and tries again later', async () => {
    mockRunCommand.mockReturnValueOnce({ promise: Promise.resolve({ code: 1, stdout: '', stderr: 'denied' }) })
    expect(await listGpuAdapters('win32')).toEqual([])
    mockRunCommand.mockReturnValueOnce({ promise: Promise.reject(new Error('ENOENT')) })
    expect(await listGpuAdapters('linux')).toEqual([])
    expect(await listGpuAdapters('aix')).toEqual([])
    expect(mockRunCommand).toHaveBeenCalledTimes(2)
  })
})

describe('detection runs', () => {
  it('answers a concurrent request with the running detection', async () => {
    let finish: (r: unknown) => void = () => undefined
    mockRunCommand
      .mockReturnValueOnce({ promise: new Promise((resolve) => { finish = resolve }) })
      .mockReturnValue({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }) })
    const first = resolveEffectiveMode('/ffmpeg', 'auto')
    const second = resolveEffectiveMode('/ffmpeg', 'auto')
    finish({ code: 0, stdout: 'h264_qsv', stderr: '' })
    expect(await first).toBe('qsv')
    expect(await second).toBe('qsv')
  })

  it('retries later when no attempt could run', async () => {
    mockRunCommand.mockReturnValue({ promise: Promise.reject(new Error('ENOENT')) })
    expect(await resolveEffectiveMode('/ffmpeg', 'auto')).toBe('off')
    const calls = mockRunCommand.mock.calls.length
    await resolveEffectiveMode('/ffmpeg', 'auto')
    expect(mockRunCommand.mock.calls.length).toBeGreaterThan(calls)
  })

  it('treats an unknown mode as software for quality', () => {
    expect(getGpuQualityArgs('auto', 20)).toEqual(['-crf', '20'])
  })
})

describe('detectGpuSummary', () => {
  it('reports nothing for software encoding', async () => {
    expect(await detectGpuSummary('/ffmpeg', 'off', 'win32')).toEqual({ vendor: null, name: null, encoders: [] })
    expect(mockRunCommand).not.toHaveBeenCalled()
  })

  it('names the adapter of an explicit mode', async () => {
    mockRunCommand.mockReturnValue({ promise: Promise.resolve({ code: 0, stdout: 'NVIDIA GeForce RTX 4070 SUPER\r\nAMD Radeon(TM) Graphics', stderr: '' }) })
    expect(await detectGpuSummary('/ffmpeg', 'amf', 'win32')).toEqual({ vendor: 'amd', name: 'AMD Radeon(TM) Graphics', encoders: ['h264_amf', 'hevc_amf'] })
  })

  it('names the adapter auto detection settled on', async () => {
    mockRunCommand
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: 'h264_nvenc', stderr: '' }) })
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }) })
      .mockReturnValueOnce({ promise: Promise.resolve({ code: 0, stdout: 'AMD Radeon(TM) Graphics\nNVIDIA GeForce RTX 4070 SUPER', stderr: '' }) })
    expect(await detectGpuSummary('/ffmpeg', 'auto', 'win32')).toEqual({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', encoders: ['h264_nvenc', 'hevc_nvenc'] })
  })
})
