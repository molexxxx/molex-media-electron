import { describe, it, expect } from 'vitest'
import {
  ALL_PRESETS,
  PRESET_CATEGORIES,
  GENERAL_PRESETS,
  WEB_PRESETS,
  DEVICE_PRESETS,
  PRODUCTION_PRESETS,
  AUDIO_PRESETS,
  AUDIO_ONLY_FORMATS,
  VIDEO_CONTAINERS,
  detectConvertConflicts,
  type ConvertPreset
} from '../../src/renderer/src/components/batch/presets'

/* ------------------------------------------------------------------ */
/*  Preset data validation                                             */
/* ------------------------------------------------------------------ */

describe('preset data integrity', () => {
  it('all presets have unique IDs', () => {
    const ids = ALL_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all presets have required fields', () => {
    for (const p of ALL_PRESETS) {
      expect(p.id).toBeTruthy()
      expect(p.label).toBeTruthy()
      expect(p.description).toBeTruthy()
      expect(p.icon).toBeTruthy()
      expect(p.options.outputFormat).toBeTruthy()
    }
  })

  it('all presets produce no errors from conflict detection', () => {
    for (const p of ALL_PRESETS) {
      const opts = {
        outputFormat: p.options.outputFormat!,
        videoCodec: p.options.videoCodec!,
        audioCodec: p.options.audioCodec!,
        videoBitrate: p.options.videoBitrate!,
        audioBitrate: p.options.audioBitrate!,
        resolution: p.options.resolution!,
        framerate: p.options.framerate!
      }
      const conflicts = detectConvertConflicts(opts)
      const errors = conflicts.filter((c) => c.type === 'error')
      expect(errors, `Preset "${p.id}" has errors: ${errors.map((e) => e.message).join(', ')}`).toHaveLength(0)
    }
  })

  it('has expected category count', () => {
    expect(PRESET_CATEGORIES).toHaveLength(5)
  })

  it('has expected preset counts per category', () => {
    expect(GENERAL_PRESETS).toHaveLength(5)
    expect(WEB_PRESETS).toHaveLength(5)
    expect(DEVICE_PRESETS).toHaveLength(3)
    expect(PRODUCTION_PRESETS).toHaveLength(5)
    expect(AUDIO_PRESETS).toHaveLength(6)
  })

  it('ALL_PRESETS equals the flat sum of all categories', () => {
    const total = GENERAL_PRESETS.length + WEB_PRESETS.length + DEVICE_PRESETS.length + PRODUCTION_PRESETS.length + AUDIO_PRESETS.length
    expect(ALL_PRESETS).toHaveLength(total)
  })
})

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

describe('format constants', () => {
  it('AUDIO_ONLY_FORMATS includes all audio containers', () => {
    for (const fmt of ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'ac3']) {
      expect(AUDIO_ONLY_FORMATS.has(fmt)).toBe(true)
    }
  })

  it('VIDEO_CONTAINERS includes all video containers', () => {
    for (const fmt of ['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'flv', 'wmv', 'ogv']) {
      expect(VIDEO_CONTAINERS.has(fmt)).toBe(true)
    }
  })

  it('no overlap between audio-only and video formats', () => {
    for (const fmt of AUDIO_ONLY_FORMATS) {
      expect(VIDEO_CONTAINERS.has(fmt)).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Conflict detection                                                 */
/* ------------------------------------------------------------------ */

const base = {
  outputFormat: 'mp4',
  videoCodec: 'libx264',
  audioCodec: 'aac',
  videoBitrate: '5000k',
  audioBitrate: '256k',
  resolution: '',
  framerate: ''
}

describe('detectConvertConflicts', () => {
  it('returns no conflicts for valid MP4 H.264 config', () => {
    expect(detectConvertConflicts(base)).toHaveLength(0)
  })

  /* ---- Audio-only format warnings ---- */
  it('warns when video codec is set for audio-only format', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'mp3', videoCodec: 'libx264' })
    expect(c.some((w) => w.type === 'warning' && w.message.includes('ignored'))).toBe(true)
  })

  it('warns when resolution is set for audio-only format', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'flac', resolution: '1920x1080' })
    expect(c.some((w) => w.message.includes('Resolution'))).toBe(true)
  })

  it('warns when video bitrate is set for audio-only format', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'wav', videoBitrate: '5000k' })
    expect(c.some((w) => w.message.includes('Video bitrate'))).toBe(true)
  })

  /* ---- WebM ---- */
  it('errors on WebM + H.264', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'webm', videoCodec: 'libx264' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('WebM'))).toBe(true)
  })

  it('errors on WebM + H.265', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'webm', videoCodec: 'libx265' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  it('errors on WebM + AAC audio', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'webm', videoCodec: 'libvpx-vp9', audioCodec: 'aac' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('Opus or Vorbis'))).toBe(true)
  })

  it('accepts WebM + VP9 + Opus', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'webm', videoCodec: 'libvpx-vp9', audioCodec: 'libopus' })
    expect(c.filter((w) => w.type === 'error')).toHaveLength(0)
  })

  /* ---- FLV ---- */
  it('errors on FLV + H.265', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'flv', videoCodec: 'libx265' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('FLV'))).toBe(true)
  })

  it('errors on FLV + Opus audio', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'flv', audioCodec: 'libopus' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('FLV'))).toBe(true)
  })

  it('accepts FLV + H.264 + AAC', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'flv' })
    expect(c.filter((w) => w.type === 'error')).toHaveLength(0)
  })

  /* ---- WMV ---- */
  it('errors on WMV + H.264', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'wmv' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('WMV'))).toBe(true)
  })

  it('accepts WMV + wmv2 + wmav2', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'wmv', videoCodec: 'wmv2', audioCodec: 'wmav2' })
    expect(c.filter((w) => w.type === 'error')).toHaveLength(0)
  })

  /* ---- OGV ---- */
  it('errors on OGV + H.264', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ogv' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('OGV'))).toBe(true)
  })

  it('accepts OGV + Theora + Vorbis', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ogv', videoCodec: 'libtheora', audioCodec: 'libvorbis' })
    expect(c.filter((w) => w.type === 'error')).toHaveLength(0)
  })

  /* ---- MP4 incompatible codecs ---- */
  it('errors on MP4 + Theora', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'libtheora' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  it('errors on MP4 + FFV1', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'ffv1' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  it('errors on MP4 + Vorbis audio', () => {
    const c = detectConvertConflicts({ ...base, audioCodec: 'libvorbis' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  /* ---- AVI ---- */
  it('errors on AVI + VP9', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'avi', videoCodec: 'libvpx-vp9' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  it('errors on AVI + AV1', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'avi', videoCodec: 'libaom-av1' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  /* ---- TS ---- */
  it('errors on TS + VP9', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ts', videoCodec: 'libvpx-vp9' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  it('errors on TS + ProRes', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ts', videoCodec: 'prores_ks' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  /* ---- MOV ---- */
  it('errors on MOV + Vorbis audio', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'mov', audioCodec: 'libvorbis' })
    expect(c.some((w) => w.type === 'error')).toBe(true)
  })

  /* ---- ProRes / FFV1 container warnings ---- */
  it('warns ProRes in MP4 container', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'prores_ks' })
    expect(c.some((w) => w.type === 'warning' && w.message.includes('ProRes'))).toBe(true)
  })

  it('no warning for ProRes in MOV', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'mov', videoCodec: 'prores_ks', audioCodec: 'aac' })
    expect(c.filter((w) => w.message.includes('ProRes'))).toHaveLength(0)
  })

  it('warns FFV1 in MP4 container', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'ffv1' })
    // Also gets an error for MP4+FFV1, so just check the warning exists
    expect(c.some((w) => w.message.includes('FFV1'))).toBe(true)
  })

  /* ---- ALAC container ---- */
  it('errors on ALAC in OGG', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ogg', audioCodec: 'alac', videoCodec: 'copy' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('ALAC'))).toBe(true)
  })

  it('accepts ALAC in M4A', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'm4a', audioCodec: 'alac', videoCodec: 'copy' })
    expect(c.filter((w) => w.type === 'error' && w.message.includes('ALAC'))).toHaveLength(0)
  })

  /* ---- MP3 / OGG format + codec ---- */
  it('warns MP3 format with non-MP3 codec', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'mp3', audioCodec: 'aac', videoCodec: 'copy' })
    expect(c.some((w) => w.message.includes('MP3 container'))).toBe(true)
  })

  it('warns OGG format with AAC', () => {
    const c = detectConvertConflicts({ ...base, outputFormat: 'ogg', audioCodec: 'aac', videoCodec: 'copy' })
    expect(c.some((w) => w.message.includes('OGG container'))).toBe(true)
  })

  /* ---- Copy codec restrictions ---- */
  it('errors on copy codec + resolution', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'copy', resolution: '1280x720' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('resolution'))).toBe(true)
  })

  it('errors on copy codec + framerate', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'copy', framerate: '30' })
    expect(c.some((w) => w.type === 'error' && w.message.includes('framerate'))).toBe(true)
  })

  it('warns on copy video codec + video bitrate', () => {
    const c = detectConvertConflicts({ ...base, videoCodec: 'copy' })
    expect(c.some((w) => w.type === 'warning' && w.message.includes('Video bitrate'))).toBe(true)
  })

  it('warns on copy audio codec + audio bitrate', () => {
    const c = detectConvertConflicts({ ...base, audioCodec: 'copy', audioBitrate: '256k' })
    expect(c.some((w) => w.type === 'warning' && w.message.includes('Audio bitrate'))).toBe(true)
  })

  it('no warning on copy audio codec + lossless bitrate', () => {
    const c = detectConvertConflicts({ ...base, audioCodec: 'copy', audioBitrate: '0' })
    expect(c.filter((w) => w.message.includes('Audio bitrate'))).toHaveLength(0)
  })
})
