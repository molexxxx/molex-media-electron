/**
 * Contract tests for container capabilities and stream mapping.
 *
 * Every capability asserted here was measured by muxing real files with
 * the installed FFmpeg, and the measured result is recorded in the
 * comments. The behaviour these protect is data loss: with no `-map`,
 * FFmpeg's automatic selection keeps one audio stream and discards the
 * rest, and "replace" mode has already deleted the original by the time
 * anyone notices.
 */

import { describe, it, expect } from 'vitest'

import {
  normalizeContainer,
  containerCapabilities,
  isBitmapSubtitle,
  planStreamMap,
  type SourceStreams
} from '../../src/main/ffmpeg/processor/stream-map'

const source = (over: Partial<SourceStreams> = {}): SourceStreams => ({
  videoCount: 1,
  audioCount: 3,
  subtitles: [],
  ...over
})

/** Collect the values of every `-map` flag in an argv slice. */
function maps(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-map') out.push(args[i + 1])
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  Container normalisation                                            */
/* ------------------------------------------------------------------ */

describe('normalizeContainer', () => {
  it('accepts a format name or an extension, in any case', () => {
    expect(normalizeContainer('mp4')).toBe('mp4')
    expect(normalizeContainer('.mp4')).toBe('mp4')
    expect(normalizeContainer('MP4')).toBe('mp4')
    expect(normalizeContainer('.MKV')).toBe('mkv')
  })

  it('tolerates empty input', () => {
    expect(normalizeContainer('')).toBe('')
    expect(normalizeContainer(undefined as unknown as string)).toBe('')
  })
})

/* ------------------------------------------------------------------ */
/*  Capabilities                                                       */
/* ------------------------------------------------------------------ */

describe('containerCapabilities', () => {
  it('marks audio-only containers as carrying no video', () => {
    for (const c of ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'ac3']) {
      expect(containerCapabilities(c).video, c).toBe(false)
    }
  })

  it('marks video containers as carrying video', () => {
    for (const c of ['mp4', 'mkv', 'mov', 'webm', 'avi', 'ts', 'flv', 'wmv', 'ogv']) {
      expect(containerCapabilities(c).video, c).toBe(true)
    }
  })

  it('knows which audio containers reject a second audio stream', () => {
    // Measured: each of these rejected a 3-track map with "Exactly one
    // <format> audio stream is required" or the equivalent.
    for (const c of ['mp3', 'flac', 'wav', 'aac', 'ac3', 'aiff', 'wma']) {
      expect(containerCapabilities(c).multiAudio, c).toBe(false)
    }
  })

  it('knows which audio containers accept many audio streams', () => {
    // Measured: all three muxed 3 audio streams successfully.
    for (const c of ['m4a', 'ogg', 'opus']) {
      expect(containerCapabilities(c).multiAudio, c).toBe(true)
    }
  })

  it('gives mp4 and mov a text-only subtitle encoder', () => {
    // Measured: of copy/mov_text/webvtt/srt/ass, only mov_text muxed.
    for (const c of ['mp4', 'mov', 'm4v']) {
      expect(containerCapabilities(c).subtitleCodec, c).toBe('mov_text')
      expect(containerCapabilities(c).textSubtitlesOnly, c).toBe(true)
    }
  })

  it('lets mkv and ts copy subtitles through', () => {
    for (const c of ['mkv', 'ts']) {
      expect(containerCapabilities(c).subtitleCodec, c).toBe('copy')
      expect(containerCapabilities(c).textSubtitlesOnly, c).toBe(false)
    }
  })

  it('reports no subtitle support where every encoder was rejected', () => {
    // Measured: webm, avi, flv, wmv and ogv rejected copy, mov_text,
    // webvtt, srt and ass alike.
    for (const c of ['webm', 'avi', 'flv', 'wmv', 'ogv']) {
      expect(containerCapabilities(c).subtitleCodec, c).toBeNull()
    }
  })

  it('treats an unmeasured container permissively but without subtitles', () => {
    const caps = containerCapabilities('mxf')
    expect(caps.video).toBe(true)
    expect(caps.multiAudio).toBe(true)
    expect(caps.subtitleCodec).toBeNull()
  })
})

describe('isBitmapSubtitle', () => {
  it('recognises the bitmap subtitle codecs', () => {
    for (const c of ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'xsub']) {
      expect(isBitmapSubtitle(c), c).toBe(true)
    }
    expect(isBitmapSubtitle('HDMV_PGS_SUBTITLE')).toBe(true)
  })

  it('treats text subtitle codecs as non-bitmap', () => {
    for (const c of ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', undefined]) {
      expect(isBitmapSubtitle(c), String(c)).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Mapping                                                            */
/* ------------------------------------------------------------------ */

describe('planStreamMap', () => {
  it('always emits an explicit map', () => {
    // The whole point: no `-map` means FFmpeg keeps one audio stream.
    const plan = planStreamMap('mkv', source(), false)
    expect(plan.args.length).toBeGreaterThan(0)
    expect(maps(plan.args)).toContain('0:a?')
  })

  it('keeps every audio stream for a multi-audio container', () => {
    const plan = planStreamMap('mkv', source({ audioCount: 3 }), false)
    expect(maps(plan.args)).toEqual(['0:v?', '0:a?'])
    expect(plan.droppedAudio).toBe(0)
  })

  it('keeps the first audio stream only for a single-audio container', () => {
    const plan = planStreamMap('mp3', source({ audioCount: 3 }), false)
    expect(maps(plan.args)).toEqual(['0:a:0?'])
    expect(plan.droppedAudio).toBe(2)
  })

  it('reports nothing dropped when a single-audio container gets one track', () => {
    expect(planStreamMap('mp3', source({ audioCount: 1 }), false).droppedAudio).toBe(0)
  })

  it('never maps video into an audio-only container', () => {
    // Measured: `-map 0:v?` into mp3 fails the mux.
    for (const c of ['mp3', 'flac', 'wav', 'm4a', 'opus']) {
      expect(maps(planStreamMap(c, source(), false).args), c).not.toContain('0:v?')
    }
  })

  it('maps video when the container takes it and the source has it', () => {
    expect(maps(planStreamMap('mp4', source({ videoCount: 1 }), false).args)).toContain('0:v?')
  })

  it('maps no video when the source has none', () => {
    expect(maps(planStreamMap('mp4', source({ videoCount: 0 }), false).args)).not.toContain('0:v?')
  })

  it('maps no audio when the source has none', () => {
    const plan = planStreamMap('mp4', source({ audioCount: 0 }), false)
    expect(maps(plan.args).some((m) => m.startsWith('0:a'))).toBe(false)
  })

  it('omits subtitles entirely when the caller does not want them', () => {
    const plan = planStreamMap('mkv', source({ subtitles: [{ codec_name: 'subrip' }] }), false)
    expect(maps(plan.args).some((m) => m.startsWith('0:s'))).toBe(false)
    expect(plan.subtitleCodec).toBeNull()
  })

  it('copies subtitles through for mkv', () => {
    const plan = planStreamMap('mkv', source({ subtitles: [{ codec_name: 'subrip' }] }), true)
    expect(maps(plan.args)).toContain('0:s?')
    expect(plan.subtitleCodec).toBe('copy')
    expect(plan.droppedSubtitles).toBe(0)
  })

  it('transcodes text subtitles to mov_text for mp4', () => {
    // A blanket `-c:s copy` here fails with "Could not find tag for codec
    // subrip in stream #2, codec not currently supported in container".
    const plan = planStreamMap('mp4', source({ subtitles: [{ codec_name: 'subrip' }] }), true)
    expect(plan.subtitleCodec).toBe('mov_text')
    expect(maps(plan.args)).toContain('0:s:0?')
  })

  it('drops bitmap subtitles for a text-only container', () => {
    // mov_text cannot represent a rendered bitmap, and FFmpeg will not
    // convert bitmap subtitles to text.
    const plan = planStreamMap('mp4', source({
      subtitles: [{ codec_name: 'subrip' }, { codec_name: 'hdmv_pgs_subtitle' }, { codec_name: 'ass' }]
    }), true)
    expect(maps(plan.args)).toContain('0:s:0?')
    expect(maps(plan.args)).toContain('0:s:2?')
    expect(maps(plan.args)).not.toContain('0:s:1?')
    expect(plan.droppedSubtitles).toBe(1)
    expect(plan.subtitleCodec).toBe('mov_text')
  })

  it('emits no subtitle codec when every subtitle was bitmap', () => {
    const plan = planStreamMap('mp4', source({
      subtitles: [{ codec_name: 'hdmv_pgs_subtitle' }, { codec_name: 'dvd_subtitle' }]
    }), true)
    expect(maps(plan.args).some((m) => m.startsWith('0:s'))).toBe(false)
    expect(plan.subtitleCodec).toBeNull()
    expect(plan.droppedSubtitles).toBe(2)
  })

  it('keeps bitmap subtitles for mkv, which can carry them', () => {
    const plan = planStreamMap('mkv', source({ subtitles: [{ codec_name: 'hdmv_pgs_subtitle' }] }), true)
    expect(plan.subtitleCodec).toBe('copy')
    expect(plan.droppedSubtitles).toBe(0)
  })

  it('drops subtitles for containers that cannot store them', () => {
    for (const c of ['webm', 'avi', 'flv', 'wmv', 'ogv']) {
      const plan = planStreamMap(c, source({ subtitles: [{ codec_name: 'subrip' }] }), true)
      expect(plan.subtitleCodec, c).toBeNull()
      expect(plan.droppedSubtitles, c).toBe(1)
      expect(maps(plan.args).some((m) => m.startsWith('0:s')), c).toBe(false)
    }
  })

  it('never maps attachments or data streams', () => {
    // `-map 0` pulled these in and broke mkv -> mp4 outright.
    const plan = planStreamMap('mp4', source({ subtitles: [{ codec_name: 'subrip' }] }), true)
    expect(plan.args).not.toContain('0')
    expect(maps(plan.args).some((m) => m.startsWith('0:d') || m.startsWith('0:t'))).toBe(false)
  })

  it('produces a coherent plan for the reported mkv -> mp4 case', () => {
    const plan = planStreamMap('mp4', {
      videoCount: 1,
      audioCount: 3,
      subtitles: [{ codec_name: 'subrip' }]
    }, true)
    expect(maps(plan.args)).toEqual(['0:v?', '0:a?', '0:s:0?'])
    expect(plan.subtitleCodec).toBe('mov_text')
    expect(plan.droppedAudio).toBe(0)
  })
})
