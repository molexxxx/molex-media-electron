/**
 * The stream rules behind the recipe picker's footer, the pinned-key toast, the inspector's consequence notes, and the
 * planner's issues: cover art never counts as video, operations that need audio name themselves, subtitle picks that
 * resolve to bitmap streams cannot become text, and output codecs hold a limited number of channels.
 */
import { describe, it, expect } from 'vitest'
import {
  CODEC_MAX_CHANNELS,
  SINGLE_AUDIO_CONTAINERS,
  applicability,
  applicabilityIssues,
  applicabilityMessage,
  factsFromProbe,
  factsFromSummary,
  outputChannels,
  resolvePick,
  type StreamFacts
} from '../../../src/shared/jobs/applicability'
import type { CompressRecipe, ConvertRecipe, ExtractRecipe, Recipe } from '../../../src/shared/jobs/recipes'
import type { MediaSummary } from '../../../src/shared/jobs/types'
import type { AudioFacts, MediaFacts, OutputCodec } from '../../../src/shared/audio/types'
import { applyGainPreset, applyLoudnessPreset } from '../../../src/shared/audio/presets'

const BASE = { presetId: null, userPreset: null }

const COMPRESS: CompressRecipe =
{
  kind: 'compress', ...BASE, target: { mode: 'crf', crf: 23 }, encoder: 'libx264', speed: 'medium', pixelFormat: 'yuv420p', tune: null,
  fit: null, audio: { kind: 'copy' }, container: 'source'
}
const CONVERT: ConvertRecipe =
{
  kind: 'convert', ...BASE, container: 'mp4', video: { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p' },
  audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }, channels: 'keep', subtitles: 'keep'
}
const EXTRACT_VIDEO: ExtractRecipe = { kind: 'extract', ...BASE, mode: 'video', container: 'mp4', reencode: null, range: null }
const GIF: ExtractRecipe = { kind: 'extract', ...BASE, mode: 'gif', fps: 15, width: null, dither: 'sierra2_4a', plays: 'infinite', range: null }
const FRAMES: ExtractRecipe = { kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'count', count: 10 }, format: 'png', jpgQuality: null, range: null }
const EXTRACT_AUDIO: ExtractRecipe =
{
  kind: 'extract', ...BASE, mode: 'audio', stream: { by: 'default' }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 },
  container: 'mp3', sampleRate: null, channels: 'keep', range: null
}
const SUBTITLES: ExtractRecipe = { kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'default' }, format: 'srt' }
const AUDIO_ONLY: ConvertRecipe = { ...CONVERT, container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }
const NORMALIZE = applyLoudnessPreset('ebu-r128', { kind: 'same-as-source' })
const GAIN = applyGainPreset('gentle-lift', { kind: 'same-as-source' })

function audio(channels: number, over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex: 0, streamIndex: 1, codecName: 'aac', profile: null, channels, layout: null, layoutGuessed: false, sampleRate: 48000,
    sampleFmt: 'fltp', bitsPerRawSample: null, bitRate: null, durationSec: 60, language: null, title: null, disposition: {}, ...over
  }
}

function probe(over: Partial<MediaFacts> = {}): MediaFacts
{
  return { path: '/m/a.mkv', container: 'mkv', formatName: 'matroska,webm', durationSec: 60, audio: [], video: [], subtitles: [], attachments: [], data: [], chapters: 0, ...over }
}

const COVER_ONLY = factsFromProbe(probe({ container: 'mp3', video: [{ streamIndex: 1, codecName: 'mjpeg', cover: true }], audio: [audio(2)] }))
const VIDEO = factsFromProbe(probe({ video: [{ streamIndex: 0, codecName: 'h264', cover: false }], audio: [audio(2)] }))
const SILENT_VIDEO = factsFromProbe(probe({ video: [{ streamIndex: 0, codecName: 'h264', cover: false }] }))

function facts(channels: number[], over: Partial<StreamFacts> = {}): StreamFacts
{
  return { video: true, audio: channels.map((count) => ({ channels: count, language: null, isDefault: false })), subtitles: [], subtitleCount: 0, ...over }
}

function codes(recipe: Recipe, media: StreamFacts): string[]
{
  return applicability(recipe, media).map((rule) => rule.code)
}

describe('video streams', () =>
{
  it.each([['Compress', COMPRESS], ['Extract video', EXTRACT_VIDEO], ['GIF', GIF], ['Frames', FRAMES]])(
    '%s on a source with only cover art is blocked with no-video-stream', (operation, recipe) =>
    {
      const rules = applicability(recipe, COVER_ONLY)
      expect(rules).toEqual([{ code: 'no-video-stream', severity: 'error', operation }])
      expect(applicabilityMessage(rules[0], 'song.mp3')).toBe(`${operation} needs a video stream; song.mp3 has none. Cover art does not count.`)
      expect(applicability(recipe, VIDEO)).toEqual([])
    })

  it('notes that a Convert with a video encoder on a source without video gives audio only', () =>
  {
    const rules = applicability(CONVERT, COVER_ONLY)
    expect(rules).toEqual([{ code: 'audio-only-output', severity: 'info' }])
    expect(applicabilityMessage(rules[0], 'song.mp3')).toBe('song.mp3 has no video; the output is audio only.')
    expect(applicability({ ...CONVERT, video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } }, COVER_ONLY)
      .map((rule) => rule.code)).toEqual(['audio-only-output'])
    expect(applicability({ ...CONVERT, video: null, container: 'm4a' }, COVER_ONLY)).toEqual([])
    expect(applicability(CONVERT, VIDEO)).toEqual([])
  })

  it('reads cover art the same from a row summary', () =>
  {
    const summary: MediaSummary =
    {
      container: 'mp3', durationSec: 200, video: null, subtitles: 0, attachments: 0, chapters: 0, cover: true,
      audio: [{ codec: 'mp3', channels: 2, layout: 'stereo', sampleRate: 44100, bitsPerSample: null, bitrateKbps: 320, language: null }]
    }
    expect(codes(COMPRESS, factsFromSummary(summary))).toEqual(['no-video-stream'])
    expect(codes(CONVERT, factsFromSummary(summary))).toEqual(['audio-only-output'])
  })
})

describe('audio streams', () =>
{
  it.each([['Normalize', NORMALIZE], ['Gain', GAIN], ['Extract audio', EXTRACT_AUDIO], ['Convert', AUDIO_ONLY]])('%s without an audio stream is blocked and named', (operation, recipe) =>
  {
    const rules = applicability(recipe, SILENT_VIDEO)
    expect(rules).toEqual([{ code: 'no-audio-stream', severity: 'error', operation }])
    expect(applicabilityMessage(rules[0], 'clip.mkv')).toBe(`${operation} needs an audio stream; clip.mkv has none.`)
    expect(applicabilityIssues(recipe, SILENT_VIDEO, 'clip.mkv')[0].fix).toEqual({ kind: 'remove', scope: 'jobs' })
  })

  it('blocks a Convert whose output would be audio only when the source has no audio either', () =>
  {
    const silentCover = factsFromProbe(probe({ container: 'mp3', video: [{ streamIndex: 0, codecName: 'mjpeg', cover: true }] }))
    expect(applicability(CONVERT, silentCover)).toEqual([{ code: 'no-audio-stream', severity: 'error', operation: 'Convert' }])
    expect(applicability({ ...CONVERT, video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } }, silentCover)
      .map((rule) => rule.code)).toEqual(['no-audio-stream'])
    expect(applicability(AUDIO_ONLY, COVER_ONLY)).toEqual([])
    expect(applicability(AUDIO_ONLY, VIDEO)).toEqual([])
  })

  it('lets video operations run on a silent source', () =>
  {
    expect(applicability(COMPRESS, SILENT_VIDEO)).toEqual([])
    expect(applicability(CONVERT, SILENT_VIDEO)).toEqual([])
    expect(applicability({ ...CONVERT, video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } }, SILENT_VIDEO)).toEqual([])
    expect(applicability(GIF, SILENT_VIDEO)).toEqual([])
  })

  it('finds the picked audio stream or says which is missing', () =>
  {
    const two = facts([2, 6], { audio: [{ channels: 2, language: 'eng', isDefault: false }, { channels: 6, language: 'jpn', isDefault: true }] })
    expect(applicability({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 2 }, audio: { kind: 'copy' } }, two)).toEqual([])
    const missing = applicability({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 3 } }, two)
    expect(missing.map((rule) => rule.code)).toEqual(['stream-not-found'])
    expect(applicabilityMessage(missing[0], 'film.mkv')).toBe('film.mkv has 2 audio streams; the recipe asks for stream 3.')
    const one = applicability({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 2 } }, facts([2]))
    expect(applicabilityMessage(one[0], 'a.mkv')).toBe('a.mkv has 1 audio stream; the recipe asks for stream 2.')
    const language = applicability({ ...EXTRACT_AUDIO, stream: { by: 'language', language: 'fre' } }, two)
    expect(applicabilityMessage(language[0], 'film.mkv')).toBe('film.mkv has no audio stream in fre.')
  })
})

describe('subtitle streams', () =>
{
  const mixed = factsFromProbe(probe({
    audio: [audio(2)],
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }],
    subtitles: [
      { streamIndex: 2, subIndex: 0, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'eng' },
      { streamIndex: 3, subIndex: 1, codecName: 'subrip', bitmap: false, language: 'spa' }
    ]
  }))

  it('blocks a pick that resolves to a bitmap subtitle and offers the first text one', () =>
  {
    const rules = applicability(SUBTITLES, mixed)
    expect(rules).toEqual([{ code: 'subtitle-bitmap', severity: 'error', stream: 1, codec: 'hdmv_pgs_subtitle', format: 'srt', firstText: 2 }])
    expect(applicabilityMessage(rules[0], 'film.mkv')).toBe('Stream 1 of film.mkv is a bitmap subtitle (hdmv_pgs_subtitle); it cannot become SRT.')
    const [issue] = applicabilityIssues(SUBTITLES, mixed, 'film.mkv')
    expect(issue.fix).toEqual({ kind: 'patch-recipe', label: 'Use the first text subtitle', patch: { field: 'stream', value: { by: 'ordinal', ordinal: 2 } }, scope: 'jobs' })
  })

  it('names the format each bitmap pick cannot become', () =>
  {
    expect(applicabilityMessage(applicability({ ...SUBTITLES, format: 'vtt' }, mixed)[0], 'f')).toMatch(/cannot become WebVTT\.$/)
    expect(applicabilityMessage(applicability({ ...SUBTITLES, format: 'ass' }, mixed)[0], 'f')).toMatch(/cannot become ASS\.$/)
  })

  it('lets a text pick through', () =>
  {
    expect(applicability({ ...SUBTITLES, stream: { by: 'language', language: 'SPA' } }, mixed)).toEqual([])
    expect(applicability({ ...SUBTITLES, stream: { by: 'ordinal', ordinal: 2 } }, mixed)).toEqual([])
  })

  it('removes the job when every subtitle is a bitmap', () =>
  {
    const bitmaps = facts([2], { subtitles: [{ codec: 'dvd_subtitle', bitmap: true, language: null }], subtitleCount: 1 })
    const [issue] = applicabilityIssues(SUBTITLES, bitmaps, 'dvd.vob')
    expect(issue.code).toBe('subtitle-bitmap')
    expect(issue.fix).toEqual({ kind: 'remove', scope: 'jobs' })
  })

  it('says when the picked subtitle is not there', () =>
  {
    const none = applicability(SUBTITLES, facts([2]))
    expect(none.map((rule) => rule.code)).toEqual(['stream-not-found'])
    expect(applicabilityMessage(none[0], 'a.mp4')).toBe('a.mp4 has no subtitle streams.')
    expect(applicabilityIssues(SUBTITLES, facts([2]), 'a.mp4')[0].fix).toEqual({ kind: 'remove', scope: 'jobs' })
    const beyond = applicabilityIssues({ ...SUBTITLES, stream: { by: 'ordinal', ordinal: 3 } }, mixed, 'film.mkv')
    expect(beyond[0].message).toBe('film.mkv has 2 subtitle streams; the recipe asks for stream 3.')
    expect(beyond[0].fix).toEqual({ kind: 'patch-recipe', label: 'Use the default stream', patch: { field: 'stream', value: { by: 'default' } }, scope: 'jobs' })
  })

  it('judges a row summary by the subtitle count alone', () =>
  {
    const counted = facts([2], { subtitles: null, subtitleCount: 2 })
    expect(applicability(SUBTITLES, counted)).toEqual([])
    expect(applicability({ ...SUBTITLES, stream: { by: 'language', language: 'eng' } }, counted)).toEqual([])
    expect(codes({ ...SUBTITLES, stream: { by: 'ordinal', ordinal: 3 } }, counted)).toEqual(['stream-not-found'])
    expect(codes(SUBTITLES, facts([2], { subtitles: null, subtitleCount: 0 }))).toEqual(['stream-not-found'])
  })
})

describe('channel limits', () =>
{
  it('holds the limit of every output codec', () =>
  {
    expect(CODEC_MAX_CHANNELS).toEqual({ aac: 8, mp3: 2, opus: 8, vorbis: 8, flac: 8, alac: 6, ac3: 6, eac3: 6, pcm: null, wmav2: 2 })
  })

  it.each(Object.entries(CODEC_MAX_CHANNELS).filter(([, max]) => max !== null) as Array<[OutputCodec, number]>)(
    '%s holds %i channels and refuses one more without a downmix', (codec, max) =>
    {
      const recipe: ConvertRecipe = { ...CONVERT, container: 'mkv', audio: { kind: 'codec', codec, kbpsPerPair: null } }
      expect(applicability(recipe, facts([max]))).toEqual([])
      expect(applicability(recipe, facts([max + 1]))).toEqual([
        { code: 'too-many-channels', severity: 'error', codec, maxChannels: max, channels: max + 1, audioIndex: 0 }
      ])
      expect(applicability({ ...recipe, channels: 'stereo' }, facts([max + 1]))).toEqual([])
    })

  it('words the refusal as the audio module does', () =>
  {
    const recipe: ConvertRecipe = { ...CONVERT, container: 'mkv', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }
    const [issue] = applicabilityIssues(recipe, facts([6]), 'film.mkv')
    expect(issue).toEqual({
      code: 'too-many-channels',
      severity: 'error',
      message: 'MP3 holds at most 2 channels; this stream has 6. Choose another output codec or downmix to stereo.',
      field: 'encoder',
      fix: { kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'channels', value: 'stereo' }, scope: 'jobs' }
    })
    expect(applicabilityMessage(applicability({ ...recipe, audio: { kind: 'codec', codec: 'ac3', kbpsPerPair: 448 / 3 } }, facts([8]))[0], 'f'))
      .toBe('AC-3 holds at most 6 channels; this stream has 8. Choose another output codec or downmix to stereo.')
  })

  it('never limits PCM, copied audio, or the source codec', () =>
  {
    expect(applicability({ ...CONVERT, container: 'wav', video: null, audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null } }, facts([16]))).toEqual([])
    expect(applicability({ ...CONVERT, audio: { kind: 'copy' } }, facts([8]))).toEqual([])
    expect(applicability({ ...CONVERT, audio: { kind: 'same-as-source' } }, facts([8]))).toEqual([])
    expect(applicability(NORMALIZE, facts([8]))).toEqual([])
  })

  it('counts the channels after the recipe changes them', () =>
  {
    const mono = facts([1])
    const surround = facts([6])
    expect(outputChannels({ ...CONVERT, channels: 'mono' }, 6)).toBe(1)
    expect(outputChannels({ ...CONVERT, channels: 'stereo' }, 1)).toBe(1)
    expect(outputChannels({ ...CONVERT, channels: 'stereo' }, 6)).toBe(2)
    expect(outputChannels(NORMALIZE, 6)).toBe(6)
    expect(outputChannels({ ...NORMALIZE, downmix: 'dialog' }, 6)).toBe(2)
    expect(outputChannels({ ...NORMALIZE, monoToStereo: true }, 1)).toBe(2)
    expect(outputChannels({ ...NORMALIZE, monoToStereo: true }, 6)).toBe(6)
    expect(outputChannels(GAIN, 6)).toBe(6)
    expect(outputChannels(COMPRESS, 8)).toBe(8)
    const wma = { ...NORMALIZE, output: { kind: 'codec' as const, codec: 'wmav2' as const, kbpsPerPair: 192 } }
    expect(codes({ ...wma, monoToStereo: true }, mono)).toEqual([])
    expect(codes(wma, surround)).toEqual(['too-many-channels'])
    expect(codes({ ...wma, downmix: 'standard' }, surround)).toEqual([])
  })

  it('offers the fix each operation can apply', () =>
  {
    const mp3 = { kind: 'codec' as const, codec: 'mp3' as const, kbpsPerPair: 320 }
    const normalizeFix = applicabilityIssues({ ...NORMALIZE, output: mp3 }, facts([6]), 'f')[0].fix
    expect(normalizeFix).toEqual({ kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'downmix', value: 'standard' }, scope: 'jobs' })
    const extractFix = applicabilityIssues({ ...EXTRACT_AUDIO, audio: mp3 }, facts([6]), 'f')[0].fix
    expect(extractFix).toEqual({ kind: 'patch-recipe', label: 'Downmix to stereo', patch: { field: 'channels', value: 'stereo' }, scope: 'jobs' })
    const compressFix = applicabilityIssues({ ...COMPRESS, audio: mp3 }, facts([6]), 'f')[0].fix
    expect(compressFix).toEqual({ kind: 'patch-recipe', label: 'Use AAC audio', patch: { field: 'audio', value: { kind: 'codec', codec: 'aac', kbpsPerPair: 320 } }, scope: 'jobs' })
    expect(applicabilityIssues({ ...COMPRESS, audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: 192 } }, facts([10]), 'f')[0].fix).toBeNull()
    expect(applicabilityIssues({ ...GAIN, output: mp3 }, facts([6]), 'f')[0].fix).toBeNull()
  })

  it('checks every encoded stream, or only the one a single-audio container keeps', () =>
  {
    const mixed = facts([2, 6])
    const toMkv: ConvertRecipe = { ...CONVERT, container: 'mkv', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }
    expect(applicability(toMkv, mixed).map((rule) => rule.code === 'too-many-channels' && rule.audioIndex)).toEqual([1])
    const toMp3: ConvertRecipe = { ...toMkv, container: 'mp3', video: null }
    expect(applicability(toMp3, mixed)).toEqual([])
    const defaultSurround = facts([2, 6], { audio: [{ channels: 2, language: null, isDefault: false }, { channels: 6, language: null, isDefault: true }] })
    expect(codes(toMp3, defaultSurround)).toEqual(['too-many-channels'])
    expect(SINGLE_AUDIO_CONTAINERS).toEqual(['mp3', 'flac', 'wav', 'aiff', 'aif', 'ac3', 'eac3'])
    expect(codes(toMp3, facts([]))).toEqual(['no-audio-stream'])
    expect(codes({ ...toMkv, container: 'mp3' }, facts([]))).toEqual([])
    expect(codes({ ...COMPRESS, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }, mixed)).toEqual(['too-many-channels'])
    expect(codes({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 1 } }, mixed)).toEqual([])
    expect(codes({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 2 } }, mixed)).toEqual(['too-many-channels'])
    expect(codes({ ...EXTRACT_AUDIO, stream: { by: 'ordinal', ordinal: 2 }, channels: 'mono' }, mixed)).toEqual([])
  })
})

describe('stream picks and facts', () =>
{
  it('resolves ordinals, languages, and the default stream', () =>
  {
    const streams = [{ language: 'eng', isDefault: false }, { language: 'en-US', isDefault: false }, { language: 'jpn', isDefault: true }, { language: null }]
    expect(resolvePick(streams, { by: 'ordinal', ordinal: 1 })).toBe(0)
    expect(resolvePick(streams, { by: 'ordinal', ordinal: 4 })).toBe(3)
    expect(resolvePick(streams, { by: 'ordinal', ordinal: 5 })).toBeNull()
    expect(resolvePick(streams, { by: 'language', language: 'JPN' })).toBe(2)
    expect(resolvePick(streams, { by: 'language', language: 'en' })).toBe(1)
    expect(resolvePick(streams, { by: 'language', language: 'en-GB' })).toBeNull()
    expect(resolvePick([{ language: 'en' }], { by: 'language', language: 'en-GB' })).toBe(0)
    expect(resolvePick(streams, { by: 'language', language: 'kor' })).toBeNull()
    expect(resolvePick(streams, { by: 'default' })).toBe(2)
    expect(resolvePick([{ language: null }, { language: null }], { by: 'default' })).toBe(0)
    expect(resolvePick([], { by: 'default' })).toBeNull()
  })

  it('reads facts from a probe: cover art is not video, dispositions mark the default', () =>
  {
    const read = factsFromProbe(probe({
      video: [{ streamIndex: 0, codecName: 'png', cover: true }, { streamIndex: 1, codecName: 'h264', cover: false }],
      audio: [audio(2, { language: 'eng' }), audio(6, { language: 'jpn', disposition: { default: 1 } })],
      subtitles: [{ streamIndex: 4, subIndex: 0, codecName: 'ass', bitmap: false, language: 'eng' }]
    }))
    expect(read).toEqual({
      video: true,
      audio: [{ channels: 2, language: 'eng', isDefault: false }, { channels: 6, language: 'jpn', isDefault: true }],
      subtitles: [{ codec: 'ass', bitmap: false, language: 'eng' }],
      subtitleCount: 1
    })
    expect(COVER_ONLY.video).toBe(false)
  })

  it('reads facts from a row summary', () =>
  {
    const summary: MediaSummary =
    {
      container: 'mkv', durationSec: 60, cover: false, subtitles: 3, attachments: 1, chapters: 4,
      video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 24 },
      audio: [{ codec: 'ac3', channels: 6, layout: '5.1(side)', sampleRate: 48000, bitsPerSample: null, bitrateKbps: 448, language: 'eng' }]
    }
    expect(factsFromSummary(summary)).toEqual({ video: true, audio: [{ channels: 6, language: 'eng', isDefault: false }], subtitles: null, subtitleCount: 3 })
  })

  it('keeps the default audio stream a row summary marks, so the picker and the plan keep the same stream', () =>
  {
    const stream = { layout: null, sampleRate: 48000, bitsPerSample: null, bitrateKbps: null }
    const summary =
    {
      container: 'mkv', durationSec: 60, cover: false, subtitles: 0, attachments: 0, chapters: 0,
      video: { codec: 'h264', width: 1920, height: 1080, rotation: 0, fps: 24 },
      audio: [{ ...stream, codec: 'aac', channels: 2, language: 'eng', isDefault: false }, { ...stream, codec: 'ac3', channels: 6, language: 'eng', isDefault: true }]
    }
    const fromSummary = factsFromSummary(summary)
    const fromProbe = factsFromProbe(probe({
      video: [{ streamIndex: 0, codecName: 'h264', cover: false }],
      audio: [audio(2, { language: 'eng' }), audio(6, { language: 'eng', disposition: { default: 1 } })]
    }))
    expect(fromSummary.audio).toEqual(fromProbe.audio)
    expect(resolvePick(fromSummary.audio, { by: 'default' })).toBe(1)
    for (const recipe of [AUDIO_ONLY, EXTRACT_AUDIO])
    {
      expect(codes(recipe, fromSummary)).toEqual(['too-many-channels'])
      expect(codes(recipe, fromProbe)).toEqual(['too-many-channels'])
    }
  })

  it('reports issues in order: blocking rules before the audio-only note', () =>
  {
    const recipe: ConvertRecipe = { ...CONVERT, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }
    const issues = applicabilityIssues(recipe, facts([6], { video: false }), 'show.m4a')
    expect(issues.map((issue) => [issue.code, issue.severity, issue.field])).toEqual([
      ['too-many-channels', 'error', 'encoder'],
      ['audio-only-output', 'info', 'streams']
    ])
    expect(issues[1].fix).toBeNull()
    expect(applicabilityIssues(GIF, COVER_ONLY, 'song.mp3')[0]).toEqual({
      code: 'no-video-stream', severity: 'error', field: 'streams', fix: { kind: 'remove', scope: 'jobs' },
      message: 'GIF needs a video stream; song.mp3 has none. Cover art does not count.'
    })
  })
})
