/**
 * Probed media facts. Every corpus file's ffprobe JSON, recorded on the 2022 build and the 9.0.2 build
 * (tests/main/fixtures/ffmpeg/probe), turns into the same MediaFacts on both builds. Unknown layouts resolve
 * by channel count the way FFmpeg guesses them, only where the count has one reading; cover art never makes
 * a file a video file; attachments and data streams stay as facts for the stream plan to report.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_LAYOUT, isBitmapSubtitle, isVideoFile, resolveLayout, toMediaFacts } from '../../../src/main/ffmpeg/audio/facts'
import type { AudioFacts, MediaFacts, ProbeJson, ProbeStream } from '../../../src/main/ffmpeg/audio/facts'
import { PROBE_BUILDS, recordedProbe, recordedProbes } from '../fixtures/ffmpeg/probe/corpus'
import type { ProbeBuild } from '../fixtures/ffmpeg/probe/corpus'

const AUDIO_MODULES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/main/ffmpeg/audio')

interface CorpusFile
{
  /** 'codec channels layout rate' per audio stream; a layout guessed by count carries a star. */
  audio: string[]
  /** 'codec' per video stream, 'codec cover' for attached pictures. */
  video?: string[]
  subtitles?: string[]
  attachments?: string[]
  data?: string[]
  chapters?: number
}

const CORPUS: Readonly<Record<string, CorpusFile>> =
{
  'brace.mp3': { audio: ['mp3 2 stereo 44100'] },
  'coherent51_s16.wav': { audio: ['pcm_s16le 6 5.1 48000'] },
  'cover.flac': { audio: ['flac 2 stereo 44100'], video: ['png cover'] },
  'cover.m4a': { audio: ['aac 2 stereo 44100'], video: ['png cover'] },
  'cover.mp3': { audio: ['mp3 2 stereo 44100'], video: ['png cover'] },
  'dts51side.mkv': { audio: ['dts 6 5.1(side) 48000'] },
  'dynamic.wav': { audio: ['pcm_s24le 2 stereo 48000'] },
  'eac3_51side_meta.mka': { audio: ['eac3 6 5.1(side) 48000'] },
  'eq51.wav': { audio: ['pcm_s24le 6 5.1 48000'] },
  'eq61.wav': { audio: ['pcm_s24le 7 6.1 48000'] },
  'eq61back.wav': { audio: ['pcm_s24le 7 6.1(back) 48000'] },
  'eq71.wav': { audio: ['pcm_s24le 8 7.1 48000'] },
  'hex.wav': { audio: ['pcm_s24le 6 hexagonal 48000'] },
  'hires96.flac': { audio: ['flac 2 stereo 96000'] },
  'isp_fs4.wav': { audio: ['pcm_s24le 2 stereo 48000'] },
  'loud.mp3': { audio: ['mp3 2 stereo 44100'] },
  'loud_aac.m4a': { audio: ['aac 2 stereo 44100'] },
  'loudmaster.wav': { audio: ['pcm_s16le 2 stereo* 44100'] },
  'mono_speech.wav': { audio: ['pcm_s16le 1 mono* 44100'] },
  'mono_speech_32k.wav': { audio: ['pcm_s16le 1 mono* 32000'] },
  'music4410.flac': { audio: ['flac 2 stereo 44100'] },
  'opus.opus': { audio: ['opus 2 stereo 48000'] },
  'opus.webm': { audio: ['opus 2 stereo 48000'] },
  'rear71.wav': { audio: ['pcm_s24le 8 7.1 48000'] },
  'short1500.wav': { audio: ['pcm_s24le 2 stereo 48000'] },
  'shortform30.wav': { audio: ['pcm_s24le 2 stereo 48000'] },
  'silence.wav': { audio: ['pcm_s16le 2 stereo* 48000'] },
  'spaced name ü.flac': { audio: ['flac 2 stereo 44100'] },
  'square_clip.wav': { audio: ['pcm_s16le 2 stereo* 44100'] },
  'surround51back.wav': { audio: ['pcm_s24le 6 5.1 48000'] },
  'surround51side.mkv': { audio: ['ac3 6 5.1(side) 48000'] },
  'surround71.wav': { audio: ['pcm_s24le 8 7.1 48000'] },
  'surroundonly51side.wav': { audio: ['pcm_s24le 6 5.1(side) 48000'] },
  'tiny300.wav': { audio: ['pcm_s24le 2 stereo 48000'] },
  'video_multi.mkv':
  {
    audio: ['aac 2 stereo 48000', 'ac3 6 5.1(side) 48000'],
    video: ['h264'],
    subtitles: ['subrip'],
    attachments: ['arial.ttf application/x-truetype-font'],
    chapters: 2
  },
  'video_multi.mp4':
  {
    audio: ['aac 2 stereo 48000', 'aac 2 stereo 48000'],
    video: ['h264'],
    subtitles: ['mov_text'],
    data: ['bin_data'],
    chapters: 2
  },
  'vorbis.ogg': { audio: ['vorbis 2 stereo 44100'] }
}

function audioLine(stream: AudioFacts): string
{
  return `${stream.codecName} ${stream.channels} ${stream.layout ?? 'null'}${stream.layoutGuessed ? '*' : ''} ${stream.sampleRate}`
}

function corpusFacts(build: ProbeBuild, input: string): MediaFacts
{
  const recorded = recordedProbe(build, input)
  return toMediaFacts(recorded.probe, recorded.path)
}

function audioStream(over: Partial<ProbeStream> = {}): ProbeStream
{
  return { index: 0, codec_type: 'audio', codec_name: 'aac', channels: 2, channel_layout: 'stereo', sample_rate: '48000', ...over }
}

function probeOf(streams: ProbeStream[], over: Partial<ProbeJson> = {}): ProbeJson
{
  return { streams, format: { format_name: 'matroska,webm', duration: '12.5' }, ...over }
}

describe('recorded corpus probes', () =>
{
  for (const build of PROBE_BUILDS)
  {
    it(`covers every corpus file on ${build}, each probe exiting 0 with a relative path`, () =>
    {
      const probes = recordedProbes(build)
      expect(probes.map((run) => run.input).sort()).toEqual(Object.keys(CORPUS).sort())
      for (const run of probes)
      {
        expect(run.code).toBe(0)
        expect(run.path).toBe(`IN/${run.input}`)
        expect((run.probe.format as { filename?: string }).filename).toBe(run.path)
      }
    })

    it(`turns every corpus probe from ${build} into the expected streams`, () =>
    {
      for (const [input, expected] of Object.entries(CORPUS))
      {
        const facts = corpusFacts(build, input)
        expect(facts.path).toBe(`IN/${input}`)
        expect(facts.container).toBe(input.slice(input.lastIndexOf('.') + 1))
        expect(facts.audio.map(audioLine), input).toEqual(expected.audio)
        expect(facts.audio.map((stream) => stream.audioIndex)).toEqual(expected.audio.map((_, n) => n))
        expect(facts.video.map((stream) => `${stream.codecName}${stream.cover ? ' cover' : ''}`), input).toEqual(expected.video ?? [])
        expect(facts.subtitles.map((stream) => stream.codecName), input).toEqual(expected.subtitles ?? [])
        expect(facts.attachments.map((stream) => `${stream.filename} ${stream.mimetype}`), input).toEqual(expected.attachments ?? [])
        expect(facts.data.map((stream) => stream.codecName), input).toEqual(expected.data ?? [])
        expect(facts.chapters, input).toBe(expected.chapters ?? 0)
        expect(facts.durationSec, input).toBeGreaterThan(0)
      }
    })

    it(`never counts cover art as video on ${build}`, () =>
    {
      for (const input of Object.keys(CORPUS))
      {
        expect(isVideoFile(corpusFacts(build, input)), input).toBe(input.startsWith('video_multi.'))
      }
      for (const input of ['cover.flac', 'cover.m4a', 'cover.mp3'])
      {
        const facts = corpusFacts(build, input)
        expect(facts.video).toEqual([{ streamIndex: 1, codecName: 'png', cover: true }])
        expect(facts.audio).toHaveLength(1)
      }
    })
  }

  it('reads the same facts on both builds apart from the MP3 duration and the MP4 track names', () =>
  {
    for (const input of Object.keys(CORPUS))
    {
      const [old, pinned] = PROBE_BUILDS.map((build) => corpusFacts(build, input))
      const comparable = (facts: MediaFacts): unknown => ({
        ...facts,
        durationSec: input.endsWith('.mp3') ? 0 : facts.durationSec,
        audio: facts.audio.map((stream) => ({
          ...stream,
          durationSec: input.endsWith('.mp3') ? 0 : stream.durationSec,
          title: input === 'video_multi.mp4' ? null : stream.title,
          disposition: Object.keys(stream.disposition).filter((flag) => stream.disposition[flag] === 1).sort()
        }))
      })
      expect(comparable(old), input).toEqual(comparable(pinned))
    }
    expect(corpusFacts('2022-10-13', 'brace.mp3').durationSec).toBe(20.035918)
    expect(corpusFacts('9.0.2', 'brace.mp3').durationSec).toBe(20)
  })

  it('keeps languages, titles, and dispositions of the multi-track MKV', () =>
  {
    for (const build of PROBE_BUILDS)
    {
      const facts = corpusFacts(build, 'video_multi.mkv')
      expect(facts.formatName).toBe('matroska,webm')
      expect(facts.durationSec).toBe(20.021)
      expect(facts.audio.map((stream) => [stream.streamIndex, stream.language, stream.title, stream.bitRate])).toEqual([
        [1, 'eng', 'Main Mix', null],
        [2, 'jpn', 'Commentary 5.1', 448000]
      ])
      expect(facts.audio[0].disposition.default).toBe(1)
      expect(facts.audio[1].disposition.comment).toBe(1)
      expect(facts.audio.map((stream) => stream.durationSec)).toEqual([20.021, 20])
      expect(facts.subtitles).toEqual([{ streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' }])
      expect(facts.attachments).toEqual([{ streamIndex: 4, filename: 'arial.ttf', mimetype: 'application/x-truetype-font' }])
    }
  })

  it('keeps the MP4 data stream and reads track names as titles where the build reports them', () =>
  {
    for (const build of PROBE_BUILDS)
    {
      const facts = corpusFacts(build, 'video_multi.mp4')
      expect(facts.formatName).toBe('mov,mp4,m4a,3gp,3g2,mj2')
      expect(facts.data).toEqual([{ streamIndex: 4, codecName: 'bin_data' }])
      expect(facts.subtitles).toEqual([{ streamIndex: 3, subIndex: 0, codecName: 'mov_text', bitmap: false, language: 'eng' }])
      expect(facts.audio.map((stream) => [stream.language, stream.bitRate, stream.profile])).toEqual([
        ['eng', 192114, 'LC'],
        ['spa', 192125, 'LC']
      ])
      expect(facts.audio.map((stream) => stream.disposition.default)).toEqual([1, 0])
    }
    expect(corpusFacts('2022-10-13', 'video_multi.mp4').audio.map((stream) => stream.title)).toEqual([null, null])
    expect(corpusFacts('9.0.2', 'video_multi.mp4').audio.map((stream) => stream.title)).toEqual(['Main Mix', 'Dynamic Track'])
  })

  it('records sample format, bit depth, bitrate, and duration per audio stream', () =>
  {
    for (const build of PROBE_BUILDS)
    {
      const dynamic = corpusFacts(build, 'dynamic.wav').audio[0]
      expect([dynamic.sampleFmt, dynamic.bitsPerRawSample, dynamic.bitRate, dynamic.durationSec]).toEqual(['s32', 24, 2304000, 30])
      const flac = corpusFacts(build, 'music4410.flac').audio[0]
      expect([flac.sampleFmt, flac.bitsPerRawSample, flac.bitRate]).toEqual(['s16', 16, null])
      const hires = corpusFacts(build, 'hires96.flac').audio[0]
      expect([hires.sampleFmt, hires.bitsPerRawSample, hires.sampleRate]).toEqual(['s32', 24, 96000])
      const mp3 = corpusFacts(build, 'loud.mp3').audio[0]
      expect([mp3.sampleFmt, mp3.bitsPerRawSample, mp3.bitRate]).toEqual(['fltp', null, 320000])
      const dts = corpusFacts(build, 'dts51side.mkv').audio[0]
      expect([dts.profile, dts.bitRate, dts.durationSec]).toEqual(['DTS', 1536000, 30.006])
      const vorbis = corpusFacts(build, 'vorbis.ogg').audio[0]
      expect([vorbis.title, vorbis.language]).toEqual(['Cover Test', null])
      expect(corpusFacts(build, 'cover.m4a').audio[0].language).toBe('und')
    }
  })

  it('guesses only the layouts FFmpeg left unknown', () =>
  {
    for (const build of PROBE_BUILDS)
    {
      const guessed = recordedProbes(build)
        .filter((run) => toMediaFacts(run.probe, run.path).audio.some((stream) => stream.layoutGuessed))
        .map((run) => run.input)
        .sort()
      expect(guessed).toEqual(['loudmaster.wav', 'mono_speech.wav', 'mono_speech_32k.wav', 'silence.wav', 'square_clip.wav'])
    }
  })
})

describe('resolveLayout', () =>
{
  it('guesses FFmpeg\'s default layout for 1, 2, 4, 6, and 8 channels', () =>
  {
    expect(resolveLayout(1, undefined)).toEqual({ layout: 'mono', guessed: true })
    expect(resolveLayout(2, undefined)).toEqual({ layout: 'stereo', guessed: true })
    expect(resolveLayout(4, undefined)).toEqual({ layout: '4.0', guessed: true })
    expect(resolveLayout(6, undefined)).toEqual({ layout: '5.1', guessed: true })
    expect(resolveLayout(8, undefined)).toEqual({ layout: '7.1', guessed: true })
  })

  it('leaves 3, 5, 7, and 12 channels, and no channels, without a layout', () =>
  {
    for (const channels of [0, 3, 5, 7, 12])
    {
      expect(resolveLayout(channels, undefined), String(channels)).toEqual({ layout: null, guessed: false })
    }
  })

  it('treats a missing, empty, unknown, or bare channel-count layout as unknown', () =>
  {
    for (const probed of [undefined, '', 'unknown', '6 channels'])
    {
      expect(resolveLayout(6, probed), String(probed)).toEqual({ layout: '5.1', guessed: true })
    }
    expect(resolveLayout(4, '4 channels')).toEqual({ layout: '4.0', guessed: true })
  })

  it('keeps a probed layout name as given, even where the default for the count differs', () =>
  {
    expect(resolveLayout(4, 'quad')).toEqual({ layout: 'quad', guessed: false })
    expect(resolveLayout(6, '5.1(side)')).toEqual({ layout: '5.1(side)', guessed: false })
    expect(resolveLayout(3, '2.1')).toEqual({ layout: '2.1', guessed: false })
    expect(resolveLayout(12, '7.1.4')).toEqual({ layout: '7.1.4', guessed: false })
  })

  it('names exactly the counts with one reading', () =>
  {
    expect(DEFAULT_LAYOUT).toEqual({ 1: 'mono', 2: 'stereo', 4: '4.0', 6: '5.1', 8: '7.1' })
  })
})

describe('isBitmapSubtitle', () =>
{
  it('recognizes bitmap subtitle codecs and their aliases in any case', () =>
  {
    for (const codec of ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub', 'HDMV_PGS_SUBTITLE'])
    {
      expect(isBitmapSubtitle(codec), codec).toBe(true)
    }
  })

  it('leaves text subtitle codecs as text', () =>
  {
    for (const codec of ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'dvb_teletext'])
    {
      expect(isBitmapSubtitle(codec), codec).toBe(false)
    }
  })
})

describe('toMediaFacts', () =>
{
  it('keeps source order per kind with absolute and per-kind indices', () =>
  {
    const facts = toMediaFacts(probeOf([
      { index: 0, codec_type: 'video', codec_name: 'hevc' },
      audioStream({ index: 1 }),
      { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { LANGUAGE: 'ger' } },
      audioStream({ index: 3, codec_name: 'truehd', channels: 8, channel_layout: '7.1' }),
      { index: 4, codec_type: 'subtitle', codec_name: 'ass' },
      { index: 5, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { index: 6, codec_type: 'attachment', codec_name: 'otf', tags: { FILENAME: 'font.otf' } },
      { index: 7, codec_type: 'data', codec_name: 'bin_data' }
    ]), 'D:\\Media\\Film.MKV')
    expect(facts.container).toBe('mkv')
    expect(facts.audio.map((stream) => [stream.audioIndex, stream.streamIndex, stream.codecName])).toEqual([[0, 1, 'aac'], [1, 3, 'truehd']])
    expect(facts.video).toEqual([{ streamIndex: 0, codecName: 'hevc', cover: false }, { streamIndex: 5, codecName: 'mjpeg', cover: true }])
    expect(facts.subtitles).toEqual([
      { streamIndex: 2, subIndex: 0, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'ger' },
      { streamIndex: 4, subIndex: 1, codecName: 'ass', bitmap: false, language: null }
    ])
    expect(facts.attachments).toEqual([{ streamIndex: 6, filename: 'font.otf', mimetype: null }])
    expect(facts.data).toEqual([{ streamIndex: 7, codecName: 'bin_data' }])
    expect(isVideoFile(facts)).toBe(true)
  })

  it('counts an audio file with only cover pictures as audio', () =>
  {
    const facts = toMediaFacts(probeOf([
      audioStream(),
      { index: 1, codec_type: 'video', codec_name: 'png', disposition: { attached_pic: 1 } },
      { index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1, default: 0 } }
    ]), 'song.mp3')
    expect(facts.video.every((stream) => stream.cover)).toBe(true)
    expect(isVideoFile(facts)).toBe(false)
  })

  it('treats attached_pic 0 as a real video stream', () =>
  {
    const facts = toMediaFacts(probeOf([audioStream(), { index: 1, codec_type: 'video', codec_name: 'png', disposition: { attached_pic: 0 } }]), 'clip.mka')
    expect(isVideoFile(facts)).toBe(true)
  })

  it('keeps streams of an unknown type as data and fills missing codec names', () =>
  {
    const facts = toMediaFacts(probeOf([
      audioStream({ codec_name: undefined }),
      { index: 1, codec_type: 'unknown' },
      { index: 2, codec_type: 'attachment' }
    ]), 'x.mkv')
    expect(facts.audio[0].codecName).toBe('unknown')
    expect(facts.data).toEqual([{ streamIndex: 1, codecName: 'unknown' }])
    expect(facts.attachments).toEqual([{ streamIndex: 2, filename: null, mimetype: null }])
  })

  it('reads numbers defensively', () =>
  {
    const facts = toMediaFacts(probeOf([
      audioStream({ channels: undefined, channel_layout: undefined, sample_rate: '', bit_rate: 'N/A', bits_per_raw_sample: '0', duration: '-1' }),
      audioStream({ index: 1, channels: 2, sample_rate: 'abc', bit_rate: '128000', bits_per_raw_sample: '24', duration: '0' })
    ]), 'a.mkv')
    const [first, second] = facts.audio
    expect([first.channels, first.layout, first.layoutGuessed, first.sampleRate, first.bitRate, first.bitsPerRawSample, first.durationSec])
      .toEqual([0, null, false, 0, null, null, null])
    expect([second.sampleRate, second.bitRate, second.bitsPerRawSample, second.durationSec]).toEqual([0, 128000, 24, 0])
    expect([first.profile, first.sampleFmt, first.language, first.title]).toEqual([null, null, null, null])
    expect(first.disposition).toEqual({})
  })

  it('parses a Matroska DURATION tag only when the stream has no duration', () =>
  {
    const facts = toMediaFacts(probeOf([
      audioStream({ tags: { DURATION: '01:02:03.500000000' } }),
      audioStream({ index: 1, duration: '7.25', tags: { DURATION: '00:00:09.000000000' } }),
      audioStream({ index: 2, tags: { DURATION: 'soon' } }),
      audioStream({ index: 3, tags: { DURATION: '00:61:00.0' } })
    ]), 'a.mka')
    expect(facts.audio.map((stream) => stream.durationSec)).toEqual([3723.5, 7.25, null, null])
  })

  it('reads tags in any case, and MP4 track names only in the MOV family', () =>
  {
    const mp4 = toMediaFacts(probeOf([audioStream({ tags: { Language: 'fre', name: 'Director' } })], { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }), 'a.mp4')
    expect([mp4.audio[0].language, mp4.audio[0].title]).toEqual(['fre', 'Director'])
    const titled = toMediaFacts(probeOf([audioStream({ tags: { TITLE: 'Stereo', name: 'Other' } })], { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }), 'a.m4a')
    expect(titled.audio[0].title).toBe('Stereo')
    const mkv = toMediaFacts(probeOf([audioStream({ tags: { name: 'Director' } })]), 'a.mkv')
    expect(mkv.audio[0].title).toBeNull()
  })

  it('copies dispositions instead of sharing the probe object', () =>
  {
    const disposition = { default: 1, comment: 0 }
    const facts = toMediaFacts(probeOf([audioStream({ disposition })]), 'a.mkv')
    disposition.default = 0
    expect(facts.audio[0].disposition).toEqual({ default: 1, comment: 0 })
  })

  it('takes the file duration from the format, else the longest stream, else 0', () =>
  {
    expect(toMediaFacts(probeOf([audioStream({ duration: '3' })]), 'a.wav').durationSec).toBe(12.5)
    const noFormat = { format_name: 'wav' }
    expect(toMediaFacts(probeOf([audioStream({ duration: '3' }), audioStream({ index: 1, duration: '4.5' })], { format: noFormat }), 'a.wav').durationSec).toBe(4.5)
    expect(toMediaFacts(probeOf([audioStream()], { format: noFormat }), 'a.wav').durationSec).toBe(0)
  })

  it('counts chapters and survives a probe with no streams or format', () =>
  {
    const chapters = [
      { id: 0, start_time: '0.000000', end_time: '5.000000' },
      { id: 1, start_time: '5.000000', end_time: '9.000000', tags: { title: 'Two' } }
    ]
    expect(toMediaFacts(probeOf([audioStream()], { chapters }), 'a.mka').chapters).toBe(2)
    const empty = toMediaFacts({} as ProbeJson, 'nothing')
    expect(empty).toEqual({
      path: 'nothing',
      container: '',
      formatName: '',
      durationSec: 0,
      audio: [],
      video: [],
      subtitles: [],
      attachments: [],
      data: [],
      chapters: 0
    })
  })
})

describe('module boundaries', () =>
{
  it('keeps facts, ceilings, and containers free of config, logger, electron, and fs', () =>
  {
    for (const name of ['facts', 'ceilings', 'containers'])
    {
      const source = fs.readFileSync(path.join(AUDIO_MODULES, `${name}.ts`), 'utf8')
      const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1])
      for (const specifier of specifiers)
      {
        expect(specifier.startsWith('./') || specifier.startsWith('../../../shared/'), `${name} imports ${specifier}`).toBe(true)
      }
      expect(source, name).not.toMatch(/\brequire\(|\bimport\(/)
    }
  })
})
