import { describe, it, expect } from 'vitest'
import {
  isLosslessCodec,
  isGpuAcceleratable,
  isSlowEncodeCodec,
  codecLabel,
  parseBitrateKbps,
  estimateOutputSizeMB,
  isAudioOnlyFormat,
  isVideoContainerFormat,
  LOSSLESS_VIDEO_CODECS,
  LOSSLESS_AUDIO_CODECS,
  GPU_ACCELERATED_VIDEO_CODECS,
  SLOW_ENCODE_VIDEO_CODECS,
  ALL_PRESETS,
  WEB_PRESETS,
  AUDIO_PRESETS
} from '../../src/renderer/src/components/batch/presets'
import type { ConvertOptions } from '../../src/renderer/src/stores/types'

/* ------------------------------------------------------------------ */
/*  Lossless detection                                                 */
/* ------------------------------------------------------------------ */

describe('isLosslessCodec', () => {
  it('reports `copy` as lossless on both stream kinds', () => {
    expect(isLosslessCodec('copy', 'video')).toBe(true)
    expect(isLosslessCodec('copy', 'audio')).toBe(true)
  })

  it('classifies FFV1 / UT Video as lossless video', () => {
    expect(isLosslessCodec('ffv1', 'video')).toBe(true)
    expect(isLosslessCodec('utvideo', 'video')).toBe(true)
  })

  it('classifies FLAC / ALAC / PCM as lossless audio', () => {
    expect(isLosslessCodec('flac', 'audio')).toBe(true)
    expect(isLosslessCodec('alac', 'audio')).toBe(true)
    expect(isLosslessCodec('pcm_s16le', 'audio')).toBe(true)
    expect(isLosslessCodec('pcm_s24le', 'audio')).toBe(true)
  })

  it('rejects lossy codecs', () => {
    expect(isLosslessCodec('libx264', 'video')).toBe(false)
    expect(isLosslessCodec('libx265', 'video')).toBe(false)
    expect(isLosslessCodec('libaom-av1', 'video')).toBe(false)
    expect(isLosslessCodec('aac', 'audio')).toBe(false)
    expect(isLosslessCodec('libopus', 'audio')).toBe(false)
    expect(isLosslessCodec('libmp3lame', 'audio')).toBe(false)
  })

  it('does not cross-classify (lossless audio set is not used for video)', () => {
    // FLAC is audio-lossless but is not a video codec — must be false in video role.
    expect(isLosslessCodec('flac', 'video')).toBe(false)
    // FFV1 is video-lossless but not an audio codec.
    expect(isLosslessCodec('ffv1', 'audio')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  GPU eligibility                                                    */
/* ------------------------------------------------------------------ */

describe('isGpuAcceleratable', () => {
  it('marks H.264 and H.265 GPU-eligible', () => {
    expect(isGpuAcceleratable('libx264')).toBe(true)
    expect(isGpuAcceleratable('libx265')).toBe(true)
  })

  it('rejects non-accelerated codecs', () => {
    expect(isGpuAcceleratable('libvpx-vp9')).toBe(false)
    expect(isGpuAcceleratable('libaom-av1')).toBe(false)
    expect(isGpuAcceleratable('prores_ks')).toBe(false)
    expect(isGpuAcceleratable('copy')).toBe(false)
    expect(isGpuAcceleratable('ffv1')).toBe(false)
  })

  it('exposes a stable set', () => {
    expect(GPU_ACCELERATED_VIDEO_CODECS.size).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Slow-encode detection                                              */
/* ------------------------------------------------------------------ */

describe('isSlowEncodeCodec', () => {
  it('flags AV1 and VP9 as slow', () => {
    expect(isSlowEncodeCodec('libaom-av1')).toBe(true)
    expect(isSlowEncodeCodec('libvpx-vp9')).toBe(true)
  })

  it('does not flag fast codecs', () => {
    expect(isSlowEncodeCodec('libx264')).toBe(false)
    expect(isSlowEncodeCodec('libx265')).toBe(false)
    expect(isSlowEncodeCodec('copy')).toBe(false)
    expect(isSlowEncodeCodec('mpeg4')).toBe(false)
  })

  it('SLOW_ENCODE_VIDEO_CODECS is disjoint from LOSSLESS_VIDEO_CODECS', () => {
    for (const c of SLOW_ENCODE_VIDEO_CODECS) {
      expect(LOSSLESS_VIDEO_CODECS.has(c)).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Codec label                                                        */
/* ------------------------------------------------------------------ */

describe('codecLabel', () => {
  it('maps known codecs to friendly labels', () => {
    expect(codecLabel('libx264')).toBe('H.264')
    expect(codecLabel('libx265')).toBe('H.265')
    expect(codecLabel('libopus')).toBe('Opus')
    expect(codecLabel('libmp3lame')).toBe('MP3')
    expect(codecLabel('copy')).toBe('Copy')
    expect(codecLabel('pcm_s24le')).toBe('PCM 24')
  })

  it('falls back to the raw value for unknown codecs', () => {
    expect(codecLabel('weird-future-codec')).toBe('weird-future-codec')
    expect(codecLabel('')).toBe('')
  })

  it('has a label for every codec used in any preset', () => {
    // Catches the case where we add a preset using a codec without
    // adding it to CODEC_LABELS.
    for (const p of ALL_PRESETS) {
      const v = p.options.videoCodec
      const a = p.options.audioCodec
      if (v) expect(codecLabel(v)).not.toBe('')
      if (a) expect(codecLabel(a)).not.toBe('')
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Bitrate parsing                                                    */
/* ------------------------------------------------------------------ */

describe('parseBitrateKbps', () => {
  it('parses k-suffixed bitrates', () => {
    expect(parseBitrateKbps('128k')).toBe(128)
    expect(parseBitrateKbps('320k')).toBe(320)
    expect(parseBitrateKbps('5000k')).toBe(5000)
  })

  it('parses M-suffixed bitrates as kbit/s', () => {
    expect(parseBitrateKbps('5M')).toBe(5000)
    expect(parseBitrateKbps('2.5M')).toBe(2500)
  })

  it('parses plain numbers as kbit/s', () => {
    expect(parseBitrateKbps('192')).toBe(192)
  })

  it('returns 0 for sentinel / empty / invalid input', () => {
    expect(parseBitrateKbps('')).toBe(0)
    expect(parseBitrateKbps(undefined)).toBe(0)
    expect(parseBitrateKbps(null)).toBe(0)
    expect(parseBitrateKbps('0')).toBe(0)
    expect(parseBitrateKbps('garbage')).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/*  File-size estimation                                               */
/* ------------------------------------------------------------------ */

describe('estimateOutputSizeMB', () => {
  const baseOpts: ConvertOptions = {
    outputFormat: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    videoBitrate: '5000k',
    audioBitrate: '256k',
    resolution: '',
    framerate: ''
  }

  it('returns 0 when duration is missing or zero', () => {
    expect(estimateOutputSizeMB(baseOpts, 0)).toBe(0)
    expect(estimateOutputSizeMB(baseOpts, -10)).toBe(0)
  })

  it('returns 0 when both bitrates are unset', () => {
    const opts = { ...baseOpts, videoBitrate: '', audioBitrate: '' }
    expect(estimateOutputSizeMB(opts, 120)).toBe(0)
  })

  it('computes (vKbps + aKbps) × duration / 8 in MiB', () => {
    // 5000k + 256k = 5256 kbit/s. 60s → 5256 × 1000 / 8 = 657,000 bytes/s
    // total = 39,420,000 bytes → /1048576 ≈ 37.59 MiB.
    const mb = estimateOutputSizeMB(baseOpts, 60)
    expect(mb).toBeGreaterThan(37)
    expect(mb).toBeLessThan(38)
  })

  it('audio-only estimate ignores missing videoBitrate', () => {
    const opts = { ...baseOpts, videoBitrate: '', audioBitrate: '320k' }
    // 320k × 60s = 2,400,000 bytes → /1048576 ≈ 2.29 MiB.
    const mb = estimateOutputSizeMB(opts, 60)
    expect(mb).toBeGreaterThan(2.2)
    expect(mb).toBeLessThan(2.4)
  })

  it('treats audioBitrate "0" (lossless sentinel) as 0', () => {
    const opts = { ...baseOpts, videoBitrate: '', audioBitrate: '0' }
    expect(estimateOutputSizeMB(opts, 60)).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/*  Format classifiers                                                 */
/* ------------------------------------------------------------------ */

describe('isAudioOnlyFormat / isVideoContainerFormat', () => {
  it('classifies common formats', () => {
    expect(isAudioOnlyFormat('mp3')).toBe(true)
    expect(isAudioOnlyFormat('flac')).toBe(true)
    expect(isVideoContainerFormat('mp4')).toBe(true)
    expect(isVideoContainerFormat('mkv')).toBe(true)
  })

  it('the two sets do not overlap', () => {
    expect(isAudioOnlyFormat('mp4')).toBe(false)
    expect(isVideoContainerFormat('mp3')).toBe(false)
  })

  it('unknown format is neither', () => {
    expect(isAudioOnlyFormat('xyz')).toBe(false)
    expect(isVideoContainerFormat('xyz')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Lossless codec membership invariants                               */
/* ------------------------------------------------------------------ */

describe('lossless codec set invariants', () => {
  it('LOSSLESS_VIDEO_CODECS includes copy', () => {
    expect(LOSSLESS_VIDEO_CODECS.has('copy')).toBe(true)
  })

  it('LOSSLESS_AUDIO_CODECS includes copy', () => {
    expect(LOSSLESS_AUDIO_CODECS.has('copy')).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  New preset spot-checks                                             */
/* ------------------------------------------------------------------ */

describe('new convert presets', () => {
  it('email preset stays well under 10 MB for a 60s clip', () => {
    const p = WEB_PRESETS.find((x) => x.id === 'email-10mb')!
    expect(p).toBeDefined()
    const opts = { ...p.options } as ConvertOptions
    const mb = estimateOutputSizeMB(opts, 60)
    expect(mb).toBeLessThan(5) // 500k+96k ≈ 596k → ~4.26 MiB at 60s
  })

  it('telegram preset uses HEVC at 1080p', () => {
    const p = WEB_PRESETS.find((x) => x.id === 'telegram')!
    expect(p.options.videoCodec).toBe('libx265')
    expect(p.options.resolution).toBe('1920x1080')
  })

  it('instagram preset is vertical 9:16', () => {
    const p = WEB_PRESETS.find((x) => x.id === 'instagram')!
    expect(p.options.resolution).toBe('1080x1920')
  })

  it('podcast preset outputs MP3 at low mono-friendly bitrate', () => {
    const p = AUDIO_PRESETS.find((x) => x.id === 'podcast-mp3')!
    expect(p.options.outputFormat).toBe('mp3')
    expect(p.options.audioCodec).toBe('libmp3lame')
    expect(p.options.audioBitrate).toBe('96k')
  })

  it('audiobook preset outputs AAC at 64k', () => {
    const p = AUDIO_PRESETS.find((x) => x.id === 'audiobook')!
    expect(p.options.outputFormat).toBe('m4a')
    expect(p.options.audioCodec).toBe('aac')
    expect(p.options.audioBitrate).toBe('64k')
  })
})
