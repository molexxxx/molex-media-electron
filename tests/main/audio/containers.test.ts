/**
 * Output container capabilities, one data-driven case per container: the audio encoders it accepts, several
 * audio streams, video, the subtitle action per source codec, attachments, cover art, chapters, and the muxer
 * passed with -f. Measured on the 2022 and 9.0.2 builds: Matroska refuses big-endian float PCM, MOV drops an
 * attached picture without an error, ASF keeps chapters as markers, Ogg keeps chapters only in an Opus stream,
 * and MKA stores a picture as a plain video track. Also the canonical audio container of every encoder.
 */
import { describe, it, expect } from 'vitest'
import {
  CONTAINER_ROWS, VIDEO_FALLBACK_CONTAINER, canonicalAudioContainer, codecOfEncoder, containerFor, isKnownContainer, keepsChapters
} from '../../../src/main/ffmpeg/audio/containers'
import type { SubtitleAction, SubtitleRule } from '../../../src/main/ffmpeg/audio/containers'
import { isBitmapSubtitle } from '../../../src/main/ffmpeg/audio/facts'

const PCM_LE = ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']
const PCM_BE = ['pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be']
const MATROSKA = [
  ...PCM_LE, 'pcm_s16be', 'pcm_s24be', 'pcm_s32be',
  'flac', 'alac', 'wavpack', 'tta', 'aac', 'libmp3lame', 'mp2', 'libopus', 'libvorbis', 'ac3', 'eac3', 'wmav2'
]

interface Case
{
  muxer: string
  encoders: readonly string[]
  multiAudio: boolean
  video: boolean
  subtitles: SubtitleRule
  attachments: boolean
  coverArt: boolean
  chapters: boolean
  chapterCodecs?: readonly string[]
}

const MATRIX: Readonly<Record<string, Case>> =
{
  mkv: { muxer: 'matroska', encoders: MATROSKA, multiAudio: true, video: true, subtitles: 'matroska', attachments: true, coverArt: false, chapters: true },
  mka: { muxer: 'matroska', encoders: MATROSKA, multiAudio: true, video: false, subtitles: 'none', attachments: true, coverArt: false, chapters: true },
  mp4:
  {
    muxer: 'mp4', encoders: ['aac', 'alac', 'libmp3lame', 'ac3', 'eac3', 'libopus'], multiAudio: true, video: true,
    subtitles: 'mov_text', attachments: false, coverArt: true, chapters: true
  },
  m4v:
  {
    muxer: 'mp4', encoders: ['aac', 'alac', 'libmp3lame', 'ac3', 'eac3', 'libopus'], multiAudio: true, video: true,
    subtitles: 'mov_text', attachments: false, coverArt: true, chapters: true
  },
  mov:
  {
    muxer: 'mov', encoders: ['aac', 'alac', 'libmp3lame', 'ac3', ...PCM_LE, ...PCM_BE], multiAudio: true, video: true,
    subtitles: 'mov_text', attachments: false, coverArt: false, chapters: true
  },
  m4a: { muxer: 'ipod', encoders: ['aac', 'alac', 'ac3'], multiAudio: true, video: false, subtitles: 'none', attachments: false, coverArt: true, chapters: true },
  webm: { muxer: 'webm', encoders: ['libopus', 'libvorbis'], multiAudio: true, video: true, subtitles: 'webvtt', attachments: false, coverArt: false, chapters: true },
  ts:
  {
    muxer: 'mpegts', encoders: ['aac', 'libmp3lame', 'mp2', 'ac3', 'eac3'], multiAudio: true, video: true,
    subtitles: 'dvb-copy', attachments: false, coverArt: false, chapters: false
  },
  m2ts:
  {
    muxer: 'mpegts', encoders: ['aac', 'libmp3lame', 'mp2', 'ac3', 'eac3'], multiAudio: true, video: true,
    subtitles: 'dvb-copy', attachments: false, coverArt: false, chapters: false
  },
  mts:
  {
    muxer: 'mpegts', encoders: ['aac', 'libmp3lame', 'mp2', 'ac3', 'eac3'], multiAudio: true, video: true,
    subtitles: 'dvb-copy', attachments: false, coverArt: false, chapters: false
  },
  avi:
  {
    muxer: 'avi', encoders: ['libmp3lame', 'ac3', 'mp2', ...PCM_LE], multiAudio: true, video: true,
    subtitles: 'none', attachments: false, coverArt: false, chapters: false
  },
  mp3: { muxer: 'mp3', encoders: ['libmp3lame'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: true, chapters: true },
  flac: { muxer: 'flac', encoders: ['flac'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: true, chapters: false },
  ogg:
  {
    muxer: 'ogg', encoders: ['libvorbis', 'libopus', 'flac'], multiAudio: true, video: false,
    subtitles: 'none', attachments: false, coverArt: false, chapters: true, chapterCodecs: ['opus']
  },
  oga:
  {
    muxer: 'oga', encoders: ['libvorbis', 'libopus', 'flac'], multiAudio: true, video: false,
    subtitles: 'none', attachments: false, coverArt: false, chapters: true, chapterCodecs: ['opus']
  },
  opus: { muxer: 'opus', encoders: ['libopus'], multiAudio: true, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: true },
  wav: { muxer: 'wav', encoders: PCM_LE, multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  aiff: { muxer: 'aiff', encoders: PCM_BE, multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  aif: { muxer: 'aiff', encoders: PCM_BE, multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  ac3: { muxer: 'ac3', encoders: ['ac3'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  eac3: { muxer: 'eac3', encoders: ['eac3'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  wma: { muxer: 'asf', encoders: ['wmav2'], multiAudio: true, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: true },
  asf: { muxer: 'asf', encoders: ['wmav2'], multiAudio: true, video: true, subtitles: 'none', attachments: false, coverArt: false, chapters: true },
  wmv: { muxer: 'asf', encoders: ['wmav2'], multiAudio: true, video: true, subtitles: 'none', attachments: false, coverArt: false, chapters: true },
  aac: { muxer: 'adts', encoders: ['aac'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  mp2: { muxer: 'mp2', encoders: ['mp2'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  wv: { muxer: 'wv', encoders: ['wavpack'], multiAudio: false, video: false, subtitles: 'none', attachments: false, coverArt: false, chapters: false },
  gif: { muxer: 'gif', encoders: [], multiAudio: false, video: true, subtitles: 'none', attachments: false, coverArt: false, chapters: false }
}

const SUBTITLE_CODECS = ['subrip', 'ass', 'ssa', 'webvtt', 'text', 'mov_text', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'] as const

/** The action for each source subtitle codec above, per subtitle rule. */
const SUBTITLE_ACTIONS: Readonly<Record<SubtitleRule, ReadonlyArray<SubtitleAction | null>>> =
{
  'matroska': ['copy', 'copy', 'copy', 'copy', 'copy', 'srt', 'copy', 'copy', 'copy', null],
  'mov_text': ['mov_text', 'mov_text', 'mov_text', 'mov_text', 'mov_text', 'mov_text', null, null, null, null],
  'webvtt': ['webvtt', 'webvtt', 'webvtt', 'webvtt', 'webvtt', 'webvtt', null, null, null, null],
  'dvb-copy': [null, null, null, null, null, null, null, null, 'copy', null],
  'none': [null, null, null, null, null, null, null, null, null, null]
}

const ALL_ENCODERS = [...new Set(Object.values(MATRIX).flatMap((entry) => entry.encoders))]

describe('containerFor', () =>
{
  for (const [name, expected] of Object.entries(MATRIX))
  {
    it(`describes ${name}`, () =>
    {
      const caps = containerFor(name)
      expect(caps.name).toBe(name)
      expect(caps.muxer).toBe(expected.muxer)
      expect([...caps.audioEncoders].sort()).toEqual([...expected.encoders].sort())
      expect([caps.multiAudio, caps.video, caps.attachments, caps.coverArt, caps.chapters])
        .toEqual([expected.multiAudio, expected.video, expected.attachments, expected.coverArt, expected.chapters])
      expect(caps.chapterCodecs === null ? null : [...caps.chapterCodecs]).toEqual(expected.chapterCodecs ?? null)
      expect(SUBTITLE_CODECS.map((codec) => caps.subtitle(codec, isBitmapSubtitle(codec)))).toEqual(SUBTITLE_ACTIONS[expected.subtitles])
      expect(isKnownContainer(name)).toBe(true)
    })
  }

  it('names every row of the table exactly once', () =>
  {
    const names = CONTAINER_ROWS.flatMap((row) => row.names)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(Object.keys(MATRIX).sort())
  })

  it('reads the extension with or without a dot, in any case, around spaces', () =>
  {
    for (const extension of ['.MKV', 'Mkv', ' .mkv ', 'mkv'])
    {
      const caps = containerFor(extension)
      expect(caps.name, extension).toBe('mkv')
      expect(caps.muxer, extension).toBe('matroska')
      expect(isKnownContainer(extension), extension).toBe(true)
    }
  })

  it('reads subtitle codec names in any case', () =>
  {
    expect(containerFor('mkv').subtitle('SubRip', false)).toBe('copy')
    expect(containerFor('mkv').subtitle('MOV_TEXT', false)).toBe('srt')
    expect(containerFor('mkv').subtitle('HDMV_PGS_SUBTITLE', true)).toBe('copy')
    expect(containerFor('ts').subtitle('DVB_SUBTITLE', true)).toBe('copy')
  })

  it('converts any other text codec to srt in Matroska and drops other bitmap codecs', () =>
  {
    expect(containerFor('mkv').subtitle('eia_608', false)).toBe('srt')
    expect(containerFor('mkv').subtitle('pgssub', true)).toBeNull()
  })

  it('carries nothing for an extension it has not measured', () =>
  {
    for (const extension of ['mpg', 'vob', 'flv', '', 'constructor'])
    {
      const caps = containerFor(extension)
      expect(caps.muxer, extension).toBeNull()
      expect(caps.audioEncoders.size, extension).toBe(0)
      expect([caps.multiAudio, caps.video, caps.attachments, caps.coverArt, caps.chapters, caps.chapterCodecs])
        .toEqual([false, false, false, false, false, null])
      expect(caps.subtitle('subrip', false)).toBeNull()
      expect(isKnownContainer(extension), extension).toBe(false)
    }
    expect(containerFor('.FLV').name).toBe('flv')
  })

  it('hands out fresh sets, so a caller cannot change the table', () =>
  {
    const first = containerFor('mp3')
    ;(first.audioEncoders as Set<string>).add('aac')
    expect(containerFor('mp3').audioEncoders.has('aac')).toBe(false)
  })
})

describe('chapters', () =>
{
  it('keeps chapters in Ogg only with an Opus stream', () =>
  {
    for (const name of ['ogg', 'oga'])
    {
      const caps = containerFor(name)
      expect(keepsChapters(caps, ['opus']), name).toBe(true)
      expect(keepsChapters(caps, ['vorbis', 'opus']), name).toBe(true)
      expect(keepsChapters(caps, ['vorbis']), name).toBe(false)
      expect(keepsChapters(caps, ['flac']), name).toBe(false)
      expect(keepsChapters(caps, []), name).toBe(false)
    }
  })

  it('keeps chapters with any codec where the container stores them', () =>
  {
    for (const name of ['mkv', 'mka', 'mp4', 'm4v', 'mov', 'm4a', 'webm', 'mp3', 'opus', 'wma', 'asf', 'wmv'])
    {
      expect(keepsChapters(containerFor(name), ['aac']), name).toBe(true)
      expect(keepsChapters(containerFor(name), []), name).toBe(true)
    }
  })

  it('drops chapters where the container cannot store them', () =>
  {
    for (const name of ['flac', 'wav', 'aiff', 'ts', 'avi', 'ac3', 'eac3', 'aac', 'mp2', 'wv', 'xyz'])
    {
      expect(keepsChapters(containerFor(name), ['opus']), name).toBe(false)
    }
  })

  it('names the codec each encoder writes', () =>
  {
    expect(['libmp3lame', 'libopus', 'libvorbis', 'aac', 'pcm_s16le', 'flac', 'toString'].map(codecOfEncoder))
      .toEqual(['mp3', 'opus', 'vorbis', 'aac', 'pcm_s16le', 'flac', 'toString'])
  })
})

describe('canonicalAudioContainer', () =>
{
  it('moves each encoder to its canonical audio container', () =>
  {
    const expected: Readonly<Record<string, string>> =
    {
      aac: 'm4a',
      alac: 'm4a',
      libopus: 'opus',
      libvorbis: 'ogg',
      flac: 'flac',
      libmp3lame: 'mp3',
      pcm_u8: 'wav',
      pcm_s16le: 'wav',
      pcm_s24le: 'wav',
      pcm_s32le: 'wav',
      pcm_f32le: 'wav',
      pcm_s16be: 'aiff',
      pcm_s24be: 'aiff',
      pcm_s32be: 'aiff',
      pcm_f32be: 'aiff',
      ac3: 'ac3',
      eac3: 'mka',
      mp2: 'mp2',
      wmav2: 'wma',
      wavpack: 'wv',
      tta: 'mka',
      dca: 'mka',
      constructor: 'mka'
    }
    for (const [encoder, container] of Object.entries(expected))
    {
      expect(canonicalAudioContainer(encoder), encoder).toBe(container)
    }
  })

  it('always lands in an audio container that accepts the encoder', () =>
  {
    for (const encoder of ALL_ENCODERS)
    {
      const caps = containerFor(canonicalAudioContainer(encoder))
      expect(caps.audioEncoders.has(encoder), encoder).toBe(true)
      expect(caps.video, encoder).toBe(false)
    }
  })

  it('moves video files to Matroska, which takes every encoder but big-endian float PCM', () =>
  {
    expect(VIDEO_FALLBACK_CONTAINER).toBe('mkv')
    const mkv = containerFor(VIDEO_FALLBACK_CONTAINER)
    expect(ALL_ENCODERS.filter((encoder) => !mkv.audioEncoders.has(encoder))).toEqual(['pcm_f32be'])
  })
})
