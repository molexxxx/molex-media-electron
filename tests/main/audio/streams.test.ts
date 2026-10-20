/**
 * The explicit stream map of one output. Plans for the corpus facts of both builds into MKV, MP4, TS, WebM,
 * MP3, FLAC, M4A, WAV, and Ogg; maps in source order with filtered audio by its label; codec arguments per
 * output index; language, title, and disposition written back for filtered audio; dropped streams with
 * their reasons; the chapters flag per container; and the metadata-off variant, which writes
 * -map_metadata:g -1 and never a stream-level -map_metadata.
 */
import { describe, it, expect } from 'vitest'
import { AUDIO_DISPOSITIONS, audioToKeep, dispositionValue, planStreams } from '../../../src/main/ffmpeg/audio/streams'
import type { StreamPolicy } from '../../../src/main/ffmpeg/audio/streams'
import { chooseEncoder } from '../../../src/main/ffmpeg/audio/encoders'
import type { BuildCapabilities } from '../../../src/main/ffmpeg/audio/encoders'
import { containerFor } from '../../../src/main/ffmpeg/audio/containers'
import { toMediaFacts } from '../../../src/main/ffmpeg/audio/facts'
import type { AudioFacts, AudioOutput, EncoderPolicy, MediaFacts, OutputCodec, StreamPlan } from '../../../src/shared/audio/types'
import { SINGLE_AUDIO_CONTAINERS } from '../../../src/shared/jobs/applicability'
import { PROBE_BUILDS, recordedProbe } from '../fixtures/ffmpeg/probe/corpus'
import type { ProbeBuild } from '../fixtures/ffmpeg/probe/corpus'

const CAPS: BuildCapabilities =
{
  encoders: new Set(['aac', 'ac3', 'eac3', 'flac', 'alac', 'libmp3lame', 'libopus', 'libvorbis', 'pcm_s16le', 'pcm_s24le', 'pcm_s16be', 'pcm_s24be']),
  experimental: new Set(),
  soxr: true
}

const ALL: StreamPolicy = { keepSubtitles: true, keepGlobalTags: true, keepCoverArt: true }
const BARE: StreamPolicy = { keepSubtitles: false, keepGlobalTags: false, keepCoverArt: false }
const INHERIT: EncoderPolicy = { kind: 'same-as-source' }

function codec(name: OutputCodec, kbpsPerPair: number | null = null): EncoderPolicy
{
  return { kind: 'codec', codec: name, kbpsPerPair }
}

function corpus(build: ProbeBuild, input: string): MediaFacts
{
  const recorded = recordedProbe(build, input)
  return toMediaFacts(recorded.probe, recorded.path)
}

/** Filtered outputs [a0], [a1], ... for the streams the container keeps, each with its encoder choice. */
function filtered(f: MediaFacts, container: string, policy: EncoderPolicy): AudioOutput[]
{
  return audioToKeep(f, containerFor(container)).map((a, k) =>
  {
    const decision = chooseEncoder(a, policy, container, { channels: a.channels, layout: a.layout ?? '', minSampleRate: null }, CAPS)
    if (!decision.ok || decision.containerChanged)
    {
      throw new Error(`no encoder for ${a.codecName} in ${container}`)
    }
    return { audioIndex: a.audioIndex, outIndex: k, label: `[a${k}]`, choice: decision.choice }
  })
}

function plan(f: MediaFacts, container: string, policy: EncoderPolicy, streams: StreamPolicy = ALL): StreamPlan
{
  return planStreams(f, containerFor(container), filtered(f, container, policy), streams)
}

function maps(p: StreamPlan): string[]
{
  return p.mapArgs.filter((_, n) => p.mapArgs[n - 1] === '-map')
}

function kept(p: StreamPlan): string[]
{
  return p.kept.map((k) => `${k.kind} ${k.source}>${k.output} ${k.action}`)
}

function dropped(p: StreamPlan): string[]
{
  return p.dropped.map((d) => `${d.kind} ${d.source} ${d.reason}`)
}

function audio(over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex: 0, streamIndex: 0, codecName: 'aac', profile: null, channels: 2, layout: 'stereo', layoutGuessed: false, sampleRate: 48000,
    sampleFmt: 'fltp', bitsPerRawSample: null, bitRate: null, durationSec: 10, language: null, title: null, disposition: {}, ...over
  }
}

function facts(over: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: 'IN/a.mkv', container: 'mkv', formatName: 'matroska,webm', durationSec: 10,
    audio: [audio()], video: [], subtitles: [], attachments: [], data: [], chapters: 0, ...over
  }
}

const MULTI_MKV_SUBTITLE = '0:3'
const MULTI_TAGS = [
  '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=Main Mix', '-disposition:a:0', 'default',
  '-metadata:s:a:1', 'language=jpn', '-metadata:s:a:1', 'title=Commentary 5.1', '-disposition:a:1', 'comment'
]

describe('corpus plans on both builds', () =>
{
  for (const build of PROBE_BUILDS)
  {
    describe(build, () =>
    {
      const multi = corpus(build, 'video_multi.mkv')

      it('keeps every stream of video_multi.mkv in MKV, in source order', () =>
      {
        const p = plan(multi, 'mkv', INHERIT)
        expect(p.mapArgs).toEqual(['-map', '0:0', '-map', '[a0]', '-map', '[a1]', '-map', MULTI_MKV_SUBTITLE, '-map', '0:4', '-map_chapters', '0'])
        expect(p.codecArgs).toEqual([
          '-c:v', 'copy', '-c:a:0', 'aac', '-b:a:0', '256k', '-aac_coder:a:0', 'fast', '-c:a:1', 'ac3', '-b:a:1', '448k', '-c:s:0', 'copy', '-c:t', 'copy'
        ])
        expect(p.metadataArgs).toEqual(MULTI_TAGS)
        expect(kept(p)).toEqual(['video 0>0 copy', 'audio 1>1 encode', 'audio 2>2 encode', 'subtitle 3>3 copy', 'attachment 4>4 copy'])
        expect(p.dropped).toEqual([])
        expect(p.chapters).toBe('kept')
      })

      it('converts the subtitle to mov_text and drops the font for MP4', () =>
      {
        const p = plan(multi, 'mp4', codec('aac', 192))
        expect(maps(p)).toEqual(['0:0', '[a0]', '[a1]', MULTI_MKV_SUBTITLE])
        expect(p.codecArgs).toEqual([
          '-c:v', 'copy', '-c:a:0', 'aac', '-b:a:0', '192k', '-aac_coder:a:0', 'fast', '-c:a:1', 'aac', '-b:a:1', '576k', '-aac_coder:a:1', 'fast',
          '-c:s:0', 'mov_text'
        ])
        expect(p.metadataArgs).toEqual(MULTI_TAGS)
        expect(kept(p)).toEqual(['video 0>0 copy', 'audio 1>1 encode', 'audio 2>2 encode', 'subtitle 3>3 convert'])
        expect(dropped(p)).toEqual(['attachment 4 attachments-unsupported'])
        expect(p.chapters).toBe('kept')
      })

      it('drops the text subtitle, the font, and the chapters for TS', () =>
      {
        const p = plan(multi, 'ts', codec('aac', 192))
        expect(p.mapArgs).toEqual(['-map', '0:0', '-map', '[a0]', '-map', '[a1]', '-map_chapters', '-1'])
        expect(dropped(p)).toEqual(['subtitle 3 subtitle-unsupported', 'attachment 4 attachments-unsupported'])
        expect(p.chapters).toBe('dropped')
      })

      it('converts the subtitle to WebVTT for WebM', () =>
      {
        const p = plan(multi, 'webm', codec('opus', 128))
        expect(maps(p)).toEqual(['0:0', '[a0]', '[a1]', MULTI_MKV_SUBTITLE])
        expect(p.codecArgs).toEqual(['-c:v', 'copy', '-c:a:0', 'libopus', '-b:a:0', '128k', '-c:a:1', 'libopus', '-b:a:1', '384k', '-c:s:0', 'webvtt'])
        expect(dropped(p)).toEqual(['attachment 4 attachments-unsupported'])
        expect(p.chapters).toBe('kept')
      })

      it('keeps the default-disposition stream alone for MP3, with its chapters', () =>
      {
        const p = plan(multi, 'mp3', codec('mp3', 192))
        expect(p.mapArgs).toEqual(['-map', '[a0]', '-map_chapters', '0'])
        expect(p.codecArgs).toEqual(['-c:a:0', 'libmp3lame', '-b:a:0', '192k'])
        expect(p.metadataArgs).toEqual(MULTI_TAGS.slice(0, 6))
        expect(kept(p)).toEqual(['audio 1>0 encode'])
        expect(dropped(p)).toEqual([
          'video 0 container-no-video', 'audio 2 container-one-audio', 'subtitle 3 subtitle-unsupported', 'attachment 4 attachments-unsupported'
        ])
      })

      it('keeps one stream and drops the chapters for FLAC and WAV', () =>
      {
        for (const [container, encoder] of [['flac', 'flac'], ['wav', 'pcm_s16le']] as const)
        {
          const p = plan(multi, container, codec(container === 'flac' ? 'flac' : 'pcm'))
          expect(p.mapArgs, container).toEqual(['-map', '[a0]', '-map_chapters', '-1'])
          expect(p.codecArgs, container).toEqual(['-c:a:0', encoder])
          expect(p.chapters, container).toBe('dropped')
          expect(dropped(p), container).toContain('audio 2 container-one-audio')
        }
      })

      it('keeps both audio streams and the chapters for M4A, without video or subtitles', () =>
      {
        const p = plan(multi, 'm4a', codec('aac', 192))
        expect(p.mapArgs).toEqual(['-map', '[a0]', '-map', '[a1]', '-map_chapters', '0'])
        expect(kept(p)).toEqual(['audio 1>0 encode', 'audio 2>1 encode'])
        expect(dropped(p)).toEqual(['video 0 container-no-video', 'subtitle 3 subtitle-unsupported', 'attachment 4 attachments-unsupported'])
        expect(p.metadataArgs).toEqual(MULTI_TAGS)
      })

      it('keeps the chapters in Ogg only with Opus', () =>
      {
        const vorbis = plan(multi, 'ogg', codec('vorbis', 160))
        expect(vorbis.codecArgs).toEqual(['-c:a:0', 'libvorbis', '-b:a:0', '160k', '-c:a:1', 'libvorbis', '-b:a:1', '480k'])
        expect([vorbis.chapters, vorbis.mapArgs.slice(-2)]).toEqual(['dropped', ['-map_chapters', '-1']])
        const opus = plan(multi, 'ogg', codec('opus', 128))
        expect([opus.chapters, opus.mapArgs.slice(-2)]).toEqual(['kept', ['-map_chapters', '0']])
      })

      it('keeps the font and drops the video and subtitle for MKA', () =>
      {
        const p = plan(multi, 'mka', INHERIT)
        expect(maps(p)).toEqual(['[a0]', '[a1]', '0:4'])
        expect(p.codecArgs.slice(-2)).toEqual(['-c:t', 'copy'])
        expect(dropped(p)).toEqual(['video 0 container-no-video', 'subtitle 3 subtitle-unsupported'])
      })

      it('turns the MP4 mov_text track into SubRip and never maps the chapter data track for MKV', () =>
      {
        const mp4 = corpus(build, 'video_multi.mp4')
        const p = plan(mp4, 'mkv', codec('aac', 192))
        expect(maps(p)).toEqual(['0:0', '[a0]', '[a1]', '0:3'])
        expect(p.codecArgs.slice(-2)).toEqual(['-c:s:0', 'srt'])
        expect(kept(p)).toEqual(['video 0>0 copy', 'audio 1>1 encode', 'audio 2>2 encode', 'subtitle 3>3 convert'])
        expect(dropped(p)).toEqual(['data 4 data-stream'])
        expect(p.chapters).toBe('kept')
        const titles = build === '9.0.2' ? ['-metadata:s:a:0', 'title=Main Mix'] : []
        expect(p.metadataArgs.slice(0, 2 + titles.length)).toEqual(['-metadata:s:a:0', 'language=eng', ...titles])
      })

      it('keeps the cover art of MP3, FLAC, and M4A sources and drops it where the container has none', () =>
      {
        for (const [input, container, policy] of [['cover.mp3', 'mp3', INHERIT], ['cover.flac', 'flac', INHERIT], ['cover.m4a', 'm4a', INHERIT],
          ['cover.mp3', 'flac', codec('flac')], ['cover.mp3', 'm4a', codec('aac', 256)]] as const)
        {
          const p = plan(corpus(build, input), container, policy)
          expect(p.mapArgs, `${input} to ${container}`).toEqual(['-map', '[a0]', '-map', '0:1'])
          expect(p.codecArgs.slice(0, 2), `${input} to ${container}`).toEqual(['-c:v', 'copy'])
          expect(kept(p), `${input} to ${container}`).toEqual(['audio 0>0 encode', 'cover 1>1 copy'])
        }
        for (const [container, policy] of [['wav', codec('pcm')], ['ogg', codec('vorbis', 160)], ['mka', INHERIT]] as const)
        {
          const p = plan(corpus(build, 'cover.mp3'), container, policy)
          expect(dropped(p), container).toEqual(['cover 1 cover-unsupported'])
          expect(p.codecArgs, container).not.toContain('-c:v')
        }
      })

      it('keeps the default disposition flag of a stream that has none as 0', () =>
      {
        const p = plan(corpus(build, 'cover.mp3'), 'mp3', INHERIT)
        expect(p.metadataArgs).toEqual(['-disposition:a:0', '0'])
      })

      it('writes the title of a Vorbis stream back into Ogg', () =>
      {
        const p = plan(corpus(build, 'vorbis.ogg'), 'ogg', INHERIT)
        expect(p.metadataArgs).toEqual(['-metadata:s:a:0', 'title=Cover Test', '-disposition:a:0', '0'])
        expect(p.mapArgs).toEqual(['-map', '[a0]'])
        expect(p.chapters).toBe('none')
      })
    })
  }
})

describe('the metadata-off variant', () =>
{
  it('writes -map_metadata:g -1 only, keeps the stream tags of filtered audio, and drops subtitles and cover art', () =>
  {
    const multi = corpus('9.0.2', 'video_multi.mkv')
    const p = plan(multi, 'mkv', INHERIT, BARE)
    expect(p.metadataArgs).toEqual(['-map_metadata:g', '-1', ...MULTI_TAGS])
    expect(dropped(p)).toEqual(['subtitle 3 policy'])
    expect(maps(p)).toEqual(['0:0', '[a0]', '[a1]', '0:4'])
    const cover = plan(corpus('9.0.2', 'cover.mp3'), 'mp3', INHERIT, BARE)
    expect(dropped(cover)).toEqual(['cover 1 policy'])
    expect(cover.metadataArgs).toEqual(['-map_metadata:g', '-1', '-disposition:a:0', '0'])
  })

  it('never writes a bare -map 0, -map_metadata -1, or a stream-level -map_metadata in any corpus plan', () =>
  {
    const cases: ReadonlyArray<readonly [string, string, EncoderPolicy]> = [
      ['video_multi.mkv', 'mkv', INHERIT], ['video_multi.mkv', 'mp4', codec('aac', 192)], ['video_multi.mkv', 'ts', codec('aac', 192)],
      ['video_multi.mkv', 'webm', codec('opus', 128)], ['video_multi.mkv', 'mp3', codec('mp3', 192)], ['video_multi.mkv', 'flac', codec('flac')],
      ['video_multi.mkv', 'm4a', codec('aac', 192)], ['video_multi.mkv', 'wav', codec('pcm')], ['video_multi.mkv', 'ogg', codec('vorbis', 160)],
      ['video_multi.mp4', 'mp4', INHERIT], ['cover.mp3', 'mp3', INHERIT], ['vorbis.ogg', 'ogg', INHERIT], ['opus.webm', 'webm', INHERIT]
    ]
    for (const build of PROBE_BUILDS)
    {
      for (const [input, container, policy] of cases)
      {
        for (const streams of [ALL, BARE])
        {
          const p = plan(corpus(build, input), container, policy, streams)
          const argv = [...p.mapArgs, ...p.codecArgs, ...p.metadataArgs]
          for (const target of maps(p))
          {
            expect(target, `${input} to ${container}`).toMatch(/^(0:\d+|\[a\d+\])$/)
          }
          expect(argv.filter((arg) => arg.startsWith('-map_metadata')), `${input} to ${container}`)
            .toEqual(streams.keepGlobalTags ? [] : ['-map_metadata:g'])
          expect(argv.indexOf('-map_metadata:g') === -1 || argv[argv.indexOf('-map_metadata:g') + 1] === '-1').toBe(true)
        }
      }
    }
  })
})

describe('copied and directly encoded audio', () =>
{
  it('maps a copied stream by index with -c:a:N copy and writes no tags for it', () =>
  {
    const multi = corpus('2022-10-13', 'video_multi.mkv')
    const [first] = filtered(multi, 'mkv', INHERIT)
    const p = planStreams(multi, containerFor('mkv'), [first, { audioIndex: 1, outIndex: 1, label: null, choice: null }], ALL)
    expect(maps(p)).toEqual(['0:0', '[a0]', '0:2', '0:3', '0:4'])
    expect(p.codecArgs).toContain('-c:a:1')
    expect(p.codecArgs.slice(p.codecArgs.indexOf('-c:a:1'), p.codecArgs.indexOf('-c:a:1') + 2)).toEqual(['-c:a:1', 'copy'])
    expect(kept(p)).toContain('audio 2>2 copy')
    expect(p.metadataArgs.some((arg) => arg.endsWith(':a:1'))).toBe(false)
  })

  it('maps a stream encoded without a filter by index and leaves its tags to FFmpeg', () =>
  {
    const multi = corpus('2022-10-13', 'video_multi.mkv')
    const outputs = filtered(multi, 'mkv', INHERIT).map((output) => ({ ...output, label: null }))
    const p = planStreams(multi, containerFor('mkv'), outputs, ALL)
    expect(maps(p)).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4'])
    expect(kept(p).filter((line) => line.startsWith('audio'))).toEqual(['audio 1>1 encode', 'audio 2>2 encode'])
    expect(p.metadataArgs).toEqual([])
  })

  it('judges the chapters of an Ogg output by the codec of a copied stream', () =>
  {
    const f = facts({ container: 'opus', audio: [audio({ codecName: 'opus' })], chapters: 2 })
    expect(planStreams(f, containerFor('ogg'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL).chapters).toBe('kept')
    const vorbis = facts({ audio: [audio({ codecName: 'vorbis' })], chapters: 2 })
    expect(planStreams(vorbis, containerFor('ogg'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL).chapters).toBe('dropped')
  })
})

describe('single-audio containers', () =>
{
  const english = audio({ audioIndex: 0, streamIndex: 1, language: 'eng' })
  const commentary = audio({ audioIndex: 1, streamIndex: 2, language: 'jpn', disposition: { default: 1 } })
  const two = facts({ audio: [english, commentary] })

  it('keeps the default-disposition stream, else the first', () =>
  {
    expect(audioToKeep(two, containerFor('mp3')).map((a) => a.audioIndex)).toEqual([1])
    expect(audioToKeep(facts({ audio: [english, { ...commentary, disposition: {} }] }), containerFor('flac')).map((a) => a.audioIndex)).toEqual([0])
    expect(audioToKeep(two, containerFor('mkv')).map((a) => a.audioIndex)).toEqual([0, 1])
    expect(audioToKeep(facts({ audio: [] }), containerFor('wav'))).toEqual([])
  })

  it('keeps one of several given outputs and reports the rest as container-one-audio', () =>
  {
    const outputs: AudioOutput[] = [
      { audioIndex: 0, outIndex: 0, label: null, choice: null },
      { audioIndex: 1, outIndex: 0, label: null, choice: null }
    ]
    const p = planStreams(two, containerFor('ac3'), outputs, ALL)
    expect(maps(p)).toEqual(['0:2'])
    expect(dropped(p)).toEqual(['audio 1 container-one-audio'])
  })

  it('keeps the one output the job gave, even when it is not the default stream', () =>
  {
    const p = planStreams(two, containerFor('wav'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
    expect(maps(p)).toEqual(['0:1'])
    expect(dropped(p)).toEqual(['audio 2 container-one-audio'])
  })

  it('keeps one stream in exactly the single-audio containers the batch page names', () =>
  {
    for (const name of SINGLE_AUDIO_CONTAINERS)
    {
      expect(audioToKeep(two, containerFor(name)).map((a) => a.audioIndex), name).toEqual([1])
    }
    for (const name of ['mkv', 'mka', 'mp4', 'mov', 'm4a', 'webm', 'ts', 'ogg', 'oga', 'opus', 'wma', 'avi'])
    {
      expect(audioToKeep(two, containerFor(name)), name).toHaveLength(2)
    }
  })

  it('reports a stream the job left out of a multi-audio container as policy', () =>
  {
    const p = planStreams(two, containerFor('mka'), [{ audioIndex: 1, outIndex: 0, label: null, choice: null }], ALL)
    expect(maps(p)).toEqual(['0:2'])
    expect(dropped(p)).toEqual(['audio 1 policy'])
  })
})

describe('subtitles', () =>
{
  const subtitle = (streamIndex: number, codecName: string, bitmap: boolean): MediaFacts['subtitles'][number] =>
    ({ streamIndex, subIndex: streamIndex - 1, codecName, bitmap, language: null })

  const cases: ReadonlyArray<readonly [string, string, boolean, string, string]> =
  [
    ['mkv', 'hdmv_pgs_subtitle', true, 'copy', ''],
    ['mkv', 'dvd_subtitle', true, 'copy', ''],
    ['mkv', 'xsub', true, '', 'bitmap-subtitle'],
    ['mkv', 'ass', false, 'copy', ''],
    ['mkv', 'mov_text', false, 'srt', ''],
    ['mp4', 'subrip', false, 'mov_text', ''],
    ['mp4', 'hdmv_pgs_subtitle', true, '', 'bitmap-subtitle'],
    ['mov', 'ass', false, 'mov_text', ''],
    ['webm', 'subrip', false, 'webvtt', ''],
    ['webm', 'dvd_subtitle', true, '', 'bitmap-subtitle'],
    ['ts', 'dvb_subtitle', true, 'copy', ''],
    ['ts', 'hdmv_pgs_subtitle', true, '', 'bitmap-subtitle'],
    ['ts', 'subrip', false, '', 'subtitle-unsupported'],
    ['mp3', 'subrip', false, '', 'subtitle-unsupported'],
    ['mka', 'hdmv_pgs_subtitle', true, '', 'subtitle-unsupported']
  ]

  for (const [container, codecName, bitmap, action, reason] of cases)
  {
    it(`${action === '' ? `drops ${codecName} from` : `writes ${codecName} as ${action} into`} ${container}`, () =>
    {
      const f = facts({ audio: [audio({ streamIndex: 0 })], subtitles: [subtitle(1, codecName, bitmap)] })
      const p = planStreams(f, containerFor(container), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
      if (action === '')
      {
        expect(dropped(p)).toEqual([`subtitle 1 ${reason}`])
        expect(p.codecArgs.some((arg) => arg.startsWith('-c:s'))).toBe(false)
      }
      else
      {
        expect(maps(p)).toEqual(['0:0', '0:1'])
        expect(p.codecArgs.slice(-2)).toEqual(['-c:s:0', action])
        expect(kept(p)[1]).toBe(`subtitle 1>1 ${action === 'copy' ? 'copy' : 'convert'}`)
      }
    })
  }

  it('numbers subtitle outputs among the kept ones only', () =>
  {
    const f = facts({
      audio: [audio({ streamIndex: 0 })],
      subtitles: [subtitle(1, 'subrip', false), subtitle(2, 'hdmv_pgs_subtitle', true), subtitle(3, 'ass', false)]
    })
    const p = planStreams(f, containerFor('mp4'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
    expect(maps(p)).toEqual(['0:0', '0:1', '0:3'])
    expect(p.codecArgs.slice(-4)).toEqual(['-c:s:0', 'mov_text', '-c:s:1', 'mov_text'])
    expect(dropped(p)).toEqual(['subtitle 2 bitmap-subtitle'])
  })
})

describe('chapters per container', () =>
{
  const cases: ReadonlyArray<readonly [string, string, StreamPlan['chapters']]> =
  [
    ['mkv', 'aac', 'kept'], ['mka', 'flac', 'kept'], ['mp4', 'aac', 'kept'], ['mov', 'aac', 'kept'], ['m4a', 'alac', 'kept'], ['webm', 'opus', 'kept'],
    ['mp3', 'mp3', 'kept'], ['opus', 'opus', 'kept'], ['ogg', 'opus', 'kept'], ['oga', 'opus', 'kept'], ['ogg', 'vorbis', 'dropped'], ['ogg', 'flac', 'dropped'],
    ['wma', 'wmav2', 'kept'], ['flac', 'flac', 'dropped'], ['wav', 'pcm_s16le', 'dropped'], ['aiff', 'pcm_s16be', 'dropped'], ['ts', 'aac', 'dropped'],
    ['avi', 'mp3', 'dropped'], ['ac3', 'ac3', 'dropped'], ['eac3', 'eac3', 'dropped'], ['aac', 'aac', 'dropped']
  ]

  for (const [container, codecName, expected] of cases)
  {
    it(`${expected === 'kept' ? 'keeps' : 'drops'} chapters in ${container} with ${codecName}`, () =>
    {
      const f = facts({ audio: [audio({ codecName })], chapters: 3 })
      const p = planStreams(f, containerFor(container), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
      expect(p.chapters).toBe(expected)
      expect(p.mapArgs.slice(-2)).toEqual(['-map_chapters', expected === 'kept' ? '0' : '-1'])
    })
  }

  it('writes no chapter mapping for a source without chapters', () =>
  {
    const p = planStreams(facts(), containerFor('mkv'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
    expect([p.chapters, p.mapArgs]).toEqual(['none', ['-map', '0:0']])
  })
})

describe('video, attachments, and data streams', () =>
{
  it('copies every kept video stream with one -c:v copy and maps nothing it drops', () =>
  {
    const f = facts({
      audio: [audio({ streamIndex: 2 })],
      video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 1, codecName: 'mjpeg', cover: true }],
      attachments: [{ streamIndex: 3, filename: 'font.ttf', mimetype: 'font/ttf' }],
      data: [{ streamIndex: 4, codecName: 'bin_data' }]
    })
    const outputs: AudioOutput[] = [{ audioIndex: 0, outIndex: 0, label: null, choice: null }]
    const mkv = planStreams(f, containerFor('mkv'), outputs, ALL)
    expect(maps(mkv)).toEqual(['0:0', '0:2', '0:3'])
    expect(mkv.codecArgs).toEqual(['-c:v', 'copy', '-c:a:0', 'copy', '-c:t', 'copy'])
    expect(dropped(mkv)).toEqual(['cover 1 cover-unsupported', 'data 4 data-stream'])
    const mp4 = planStreams(f, containerFor('mp4'), outputs, ALL)
    expect(maps(mp4)).toEqual(['0:0', '0:1', '0:2'])
    expect(mp4.codecArgs.filter((arg) => arg === '-c:v')).toHaveLength(1)
    expect(dropped(mp4)).toEqual(['attachment 3 attachments-unsupported', 'data 4 data-stream'])
    const m4a = planStreams(f, containerFor('m4a'), outputs, BARE)
    expect(dropped(m4a)).toEqual(['video 0 container-no-video', 'cover 1 policy', 'attachment 3 attachments-unsupported', 'data 4 data-stream'])
    expect(m4a.codecArgs).toEqual(['-c:a:0', 'copy'])
  })

  it('reports streams of an unmeasured container as unsupported', () =>
  {
    const f = facts({ video: [{ streamIndex: 1, codecName: 'h264', cover: false }], subtitles: [{ streamIndex: 2, subIndex: 0, codecName: 'subrip', bitmap: false, language: null }] })
    const p = planStreams(f, containerFor('xyz'), [{ audioIndex: 0, outIndex: 0, label: null, choice: null }], ALL)
    expect(dropped(p)).toEqual(['video 1 container-no-video', 'subtitle 2 subtitle-unsupported'])
  })
})

describe('dispositions', () =>
{
  it('joins the audio flags with + and writes 0 when there are none', () =>
  {
    expect(dispositionValue({})).toBe('0')
    expect(dispositionValue({ default: 1, comment: 1, forced: 0 })).toBe('default+comment')
    expect(dispositionValue({ hearing_impaired: 1, default: 1 })).toBe('default+hearing_impaired')
  })

  it('leaves out picture flags and flags the 2022 build cannot parse', () =>
  {
    expect(dispositionValue({ attached_pic: 1, timed_thumbnails: 1, still_image: 1, non_diegetic: 1, multilayer: 1 })).toBe('0')
    expect(AUDIO_DISPOSITIONS).not.toContain('attached_pic')
    expect(AUDIO_DISPOSITIONS).not.toContain('non_diegetic')
    expect(AUDIO_DISPOSITIONS).not.toContain('multilayer')
    expect(dispositionValue(Object.fromEntries(AUDIO_DISPOSITIONS.map((flag) => [flag, 1])))).toBe(AUDIO_DISPOSITIONS.join('+'))
  })

  it('writes the language and title of a filtered stream only when the source has them', () =>
  {
    const f = facts({ audio: [audio({ language: 'fre' }), audio({ audioIndex: 1, streamIndex: 1, title: 'Director' })] })
    const outputs = filtered(f, 'mkv', INHERIT)
    expect(planStreams(f, containerFor('mkv'), outputs, ALL).metadataArgs).toEqual([
      '-metadata:s:a:0', 'language=fre', '-disposition:a:0', '0', '-metadata:s:a:1', 'title=Director', '-disposition:a:1', '0'
    ])
  })
})
