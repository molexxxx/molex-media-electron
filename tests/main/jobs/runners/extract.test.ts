import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioFacts, MediaFacts } from '../../../../src/shared/audio/types'
import type { JobId } from '../../../../src/shared/jobs/ids'
import type { ExtractRecipe } from '../../../../src/shared/jobs/recipes'
import type { FrozenPolicy, JobPlan, OutputPlan, SourceRef } from '../../../../src/shared/jobs/types'
import type { BuildCapabilities } from '../../../../src/main/ffmpeg/audio/encoders'
import { containerFor } from '../../../../src/main/ffmpeg/audio/containers'
import { parseDownmixInfo } from '../../../../src/main/ffmpeg/audio/downmix'
import type { Exec, ExecOptions, FfmpegProgress } from '../../../../src/main/ffmpeg/exec'
import type { JobLogger } from '../../../../src/main/jobs/deps'
import { OUTPUT_PLACEHOLDER, pathExists } from '../../../../src/main/jobs/runners/convert'
import type { RunContext, RunnableJob, RunOutcome } from '../../../../src/main/jobs/runners/types'
import { durationStatus, framesWithin } from '../../../../src/main/jobs/runners/verify-media'
import type { VerifyFiles } from '../../../../src/main/jobs/runners/verify-media'
import type { ExtractRunnerDeps } from '../../../../src/main/jobs/runners/extract'
import
{
  FRAME_PATTERN,
  baseName,
  buildExtractCommand,
  createExtractRunner,
  extractEstimate,
  makeFrameFolder,
  pcmBits,
  planExtract,
  runExtract,
  copyFits,
  frameSampling,
  gifGraph,
  pcmOnly,
  pictureIndex,
  planExtractAudio,
  rangeIssues,
  reencodeArgs,
  withLevelsPlaceholder,
  GIF_MAX_PLAYS,
  escapeImagePattern,
  extractSpan,
  frameFileName,
  framePattern,
  gifLoopArg,
  gifPlaysLabel,
  joinInside,
  rangeArgs,
  secondsArg
} from '../../../../src/main/jobs/runners/extract'

describe('extractSpan', () =>
{
  it('prefers an explicit duration', () =>
  {
    expect(extractSpan({ startSec: 0, durationSec: 10 }, 120)).toBe(10)
    expect(extractSpan({ startSec: 30, durationSec: 5 }, 120)).toBe(5)
  })

  it('uses what remains after the start time', () =>
  {
    expect(extractSpan({ startSec: 100, durationSec: null }, 120)).toBe(20)
  })

  it('falls back to the whole file', () =>
  {
    expect(extractSpan(null, 120)).toBe(120)
    expect(extractSpan({ startSec: 0, durationSec: null }, 120)).toBe(120)
  })

  it('never returns zero or negative', () =>
  {
    expect(extractSpan({ startSec: 500, durationSec: null }, 120)).toBeNull()
    expect(extractSpan({ startSec: 120, durationSec: 5 }, 120)).toBeNull()
    expect(extractSpan(null, 0)).toBeNull()
    expect(extractSpan(null, Number.NaN)).toBeNull()
  })

  it('cuts an explicit duration to what remains after the start', () =>
  {
    expect(extractSpan({ startSec: 110, durationSec: 20 }, 120)).toBe(10)
  })

  it('keeps an explicit duration when the source duration is unknown', () =>
  {
    expect(extractSpan({ startSec: 5, durationSec: 8 }, null)).toBe(8)
    expect(extractSpan({ startSec: 5, durationSec: null }, null)).toBeNull()
  })

  it('treats a negative start as the beginning', () =>
  {
    expect(extractSpan({ startSec: -4, durationSec: null }, 60)).toBe(60)
  })
})

describe('rangeArgs', () =>
{
  it('writes nothing for the whole source', () =>
  {
    expect(rangeArgs(null)).toEqual([])
    expect(rangeArgs({ startSec: 0, durationSec: null })).toEqual([])
  })

  it('writes the start and the duration in seconds to the millisecond', () =>
  {
    expect(rangeArgs({ startSec: 30, durationSec: 10 })).toEqual(['-ss', '30', '-t', '10'])
    expect(rangeArgs({ startSec: 1.23456, durationSec: null })).toEqual(['-ss', '1.235'])
    expect(rangeArgs({ startSec: 0, durationSec: 2.5 })).toEqual(['-t', '2.5'])
  })

  it('formats seconds without trailing noise', () =>
  {
    expect(secondsArg(0.1 + 0.2)).toBe('0.3')
    expect(secondsArg(60)).toBe('60')
  })
})

describe('GIF plays', () =>
{
  it('maps Forever to -loop 0', () =>
  {
    expect(gifLoopArg('infinite')).toBe(0)
    expect(gifPlaysLabel('infinite')).toBe('Forever')
  })

  it('maps Play once to -loop -1', () =>
  {
    expect(gifLoopArg(1)).toBe(-1)
    expect(gifPlaysLabel(1)).toBe('Play once')
  })

  it('maps Play n times to n - 1 repeats', () =>
  {
    expect(gifLoopArg(2)).toBe(1)
    expect(gifLoopArg(3)).toBe(2)
    expect(gifPlaysLabel(3)).toBe('Play 3 times')
  })

  it('clamps plays to what the loop field holds', () =>
  {
    expect(gifLoopArg(0)).toBe(-1)
    expect(gifLoopArg(Number.NaN)).toBe(-1)
    expect(gifLoopArg(GIF_MAX_PLAYS + 10)).toBe(65535)
    expect(gifLoopArg(2.6)).toBe(2)
  })
})

describe('frame folder names', () =>
{
  it('escapes every % for the image2 muxer', () =>
  {
    expect(escapeImagePattern('C:\\Media\\50% off\\clip%d')).toBe('C:\\Media\\50%% off\\clip%%d')
    expect(escapeImagePattern('/plain/folder')).toBe('/plain/folder')
  })

  it('joins with the folder\'s own separator', () =>
  {
    expect(joinInside('C:\\work\\frames', 'a.png')).toBe('C:\\work\\frames\\a.png')
    expect(joinInside('/work/frames', 'a.png')).toBe('/work/frames/a.png')
    expect(joinInside('/work/frames/', 'a.png')).toBe('/work/frames/a.png')
    expect(joinInside('C:\\work\\', 'a.png')).toBe('C:\\work\\a.png')
    expect(joinInside('C:/mixed\\path', 'a.png')).toBe('C:/mixed\\path/a.png')
  })

  it('writes the frame pattern after the escaped folder', () =>
  {
    expect(framePattern('C:\\out\\100% clips', 'png')).toBe(`C:\\out\\100%% clips\\${FRAME_PATTERN}.png`)
    expect(framePattern('/out/frames', 'jpg')).toBe('/out/frames/frame_%06d.jpg')
  })

  it('names frames as the muxer writes them', () =>
  {
    expect(frameFileName(1, 'png')).toBe('frame_000001.png')
    expect(frameFileName(1234567, 'webp')).toBe('frame_1234567.webp')
  })
})

const CAPS: BuildCapabilities =
{
  encoders: new Set([
    'aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'wmav2',
    'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be',
    'libx264', 'libvpx-vp9', 'png', 'mjpeg', 'libwebp', 'gif', 'srt', 'webvtt', 'ass'
  ]),
  experimental: new Set(),
  soxr: true
}

function audio(over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex: 0,
    streamIndex: 1,
    codecName: 'aac',
    profile: 'LC',
    channels: 2,
    layout: 'stereo',
    layoutGuessed: false,
    sampleRate: 48000,
    sampleFmt: 'fltp',
    bitsPerRawSample: null,
    bitRate: 192000,
    durationSec: 120,
    language: 'eng',
    title: null,
    disposition: { default: 1 },
    ...over
  }
}

/** A two-minute movie: H.264 with cover art, English AAC stereo, Japanese 24-bit FLAC 5.1(side), SRT and PGS subtitles. */
function movie(over: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: '/media/movie.mkv',
    container: 'mkv',
    formatName: 'matroska,webm',
    durationSec: 120,
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 5, codecName: 'mjpeg', cover: true }],
    audio: [
      audio(),
      audio({ audioIndex: 1, streamIndex: 2, codecName: 'flac', profile: null, channels: 6, layout: '5.1(side)', sampleFmt: 's32', bitsPerRawSample: 24, bitRate: null, language: 'jpn', disposition: { default: 0 } })
    ],
    subtitles: [
      { streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' },
      { streamIndex: 4, subIndex: 1, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'fre' }
    ],
    attachments: [],
    data: [],
    chapters: 0,
    ...over
  }
}

const BASE = { presetId: null, userPreset: null } as const

function audioRecipe(over: Partial<Extract<ExtractRecipe, { mode: 'audio' }>> = {}): ExtractRecipe
{
  return { kind: 'extract', ...BASE, mode: 'audio', stream: { by: 'default' }, audio: { kind: 'copy' }, container: 'm4a', sampleRate: null, channels: 'keep', range: null, ...over }
}

function framesRecipe(over: Partial<Extract<ExtractRecipe, { mode: 'frames' }>> = {}): ExtractRecipe
{
  return { kind: 'extract', ...BASE, mode: 'frames', sampling: { by: 'interval', seconds: 1 }, format: 'png', jpgQuality: null, range: null, ...over }
}

const MUXERS: Readonly<Record<string, string>> = { m4a: 'ipod', wav: 'wav', aiff: 'aiff', ogg: 'ogg', opus: 'opus', mp3: 'mp3', flac: 'flac', mp4: 'mp4', webm: 'webm', mkv: 'matroska', gif: 'gif', png: 'image2', jpg: 'image2', webp: 'image2', srt: 'srt', vtt: 'webvtt', ass: 'ass' }

function containerOf(recipe: ExtractRecipe): string
{
  switch (recipe.mode)
  {
    case 'audio':
    case 'video':
      return recipe.container
    case 'gif':
      return 'gif'
    default:
      return recipe.format
  }
}

function build(recipe: ExtractRecipe, facts: MediaFacts = movie(), output = '/work/out.part')
{
  const container = containerOf(recipe)
  return buildExtractCommand({ source: '/media/movie.mkv', facts, recipe, container, muxer: MUXERS[container], caps: CAPS, output, levels: null, showLevelsPlaceholder: false })
}

function argv(recipe: ExtractRecipe, facts?: MediaFacts, output?: string): string[]
{
  const built = build(recipe, facts, output)
  expect(built.command, JSON.stringify(built.issues)).not.toBeNull()
  return built.command!.args
}

function argAfter(args: readonly string[], flag: string): string | undefined
{
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}

describe('extract frames: count mode', () =>
{
  /** fps value from the frame filter. */
  function vfFps(args: string[]): number
  {
    const vf = argAfter(args, '-filter:v:0') ?? ''
    const m = /fps=([0-9.]+)/.exec(vf)
    expect(m, `no fps in the filter: ${vf}`).not.toBeNull()
    return parseFloat(m![1])
  }

  it('spaces the requested count across the whole file when no range is set', () =>
  {
    // 60 frames across 120 s.
    expect(vfFps(argv(framesRecipe({ sampling: { by: 'count', count: 60 } })))).toBeCloseTo(0.5, 6)
  })

  it('spaces the requested count across the selected range', () =>
  {
    // A 10 s window of a 120 s file takes all 24 frames, not 2.
    expect(vfFps(argv(framesRecipe({ sampling: { by: 'count', count: 24 }, range: { startSec: 30, durationSec: 10 } })))).toBeCloseTo(2.4, 6)
  })

  it('accounts for a start time with no explicit duration', () =>
  {
    // 60 s remain of 120 s.
    expect(vfFps(argv(framesRecipe({ sampling: { by: 'count', count: 30 }, range: { startSec: 60, durationSec: null } })))).toBeCloseTo(0.5, 6)
  })

  it('still passes the range through to ffmpeg', () =>
  {
    const args = argv(framesRecipe({ sampling: { by: 'count', count: 24 }, range: { startSec: 30, durationSec: 10 } }))
    expect(argAfter(args, '-ss')).toBe('30')
    expect(argAfter(args, '-t')).toBe('10')
    // -ss must precede -i so the seek is a fast input seek.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
  })

  it('expects the count it spaces, and refuses a count over an unknown duration', () =>
  {
    const built = build(framesRecipe({ sampling: { by: 'count', count: 24 }, range: { startSec: 30, durationSec: 10 } }))
    expect(built.command?.check).toEqual({ kind: 'frames', extension: 'png', expectedFrames: 24 })
    const unknown = build(framesRecipe({ sampling: { by: 'count', count: 24 } }), movie({ durationSec: Number.NaN }))
    expect(unknown.command).toBeNull()
    expect(unknown.issues.map((i) => [i.code, i.severity])).toEqual([['invalid-recipe', 'error']])
  })
})

describe('extract audio', () =>
{
  const pcm16 = audio({ codecName: 'pcm_s16le', profile: null, sampleFmt: 's16', bitsPerRawSample: null, bitRate: 1536000 })
  const pcm24 = audio({ codecName: 'pcm_s24le', profile: null, sampleFmt: 's32', bitsPerRawSample: 24, bitRate: 2304000 })

  it('writes WAV with the PCM encoder of the source depth and no bitrate', () =>
  {
    const wav = audioRecipe({ container: 'wav', audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null } })
    const args16 = argv(wav, movie({ audio: [pcm16] }))
    expect(argAfter(args16, '-c:a:0')).toBe('pcm_s16le')
    expect(args16.some((a) => a.startsWith('-b:a'))).toBe(false)
    const args24 = argv(wav, movie({ audio: [pcm24] }))
    expect(argAfter(args24, '-c:a:0')).toBe('pcm_s24le')
    expect(argAfter(args24, '-filter_complex')).toContain('aformat=sample_fmts=s32:sample_rates=48000:channel_layouts=stereo')
  })

  it('keeps 24 bits for a 24-bit FLAC stream written to WAV', () =>
  {
    const wav = audioRecipe({ container: 'wav', stream: { by: 'language', language: 'jpn' }, audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null } })
    const args = argv(wav)
    expect(argAfter(args, '-c:a:0')).toBe('pcm_s24le')
    expect(argAfter(args, '-filter_complex')?.startsWith('[0:a:1]')).toBe(true)
  })

  it('extracts to ogg using libvorbis and to opus using libopus', () =>
  {
    const ogg = argv(audioRecipe({ container: 'ogg', audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: null } }))
    expect(argAfter(ogg, '-c:a:0')).toBe('libvorbis')
    const opus = argv(audioRecipe({ container: 'opus', audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 96 } }))
    expect(argAfter(opus, '-c:a:0')).toBe('libopus')
    expect(argAfter(opus, '-b:a:0')).toBe('96k')
  })

  it('remaps a 5.1(side) stream to the layout libopus writes instead of leaving it to the encoder', () =>
  {
    const built = build(audioRecipe({ container: 'opus', stream: { by: 'ordinal', ordinal: 2 }, audio: { kind: 'codec', codec: 'opus', kbpsPerPair: null } }))
    expect(built.command).not.toBeNull()
    const graph = argAfter(built.command!.args, '-filter_complex') ?? ''
    const layout = /channel_layouts=([^:[\]]+)/.exec(graph)?.[1]
    expect(layout).toBe(built.command!.audio!.choice!.layout)
    expect(layout).not.toBe('5.1(side)')
    expect(built.issues.map((i) => i.code)).toContain('layout-remapped')
    expect(graph.endsWith('[a0]')).toBe(true)
  })

  it('copies a stream the container holds and maps it explicitly', () =>
  {
    const built = build(audioRecipe())
    expect(built.command!.args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-i', '/media/movie.mkv',
      '-map', '0:a:0', '-c:a:0', 'copy', '-map_chapters', '-1', '-f', 'ipod', '/work/out.part'
    ])
    expect(built.command!.class).toBe('copy')
    expect(built.command!.streams.kept).toEqual([{ kind: 'audio', source: 1, output: 0, action: 'copy' }])
    expect(built.command!.streams.dropped.map((d) => d.source)).toEqual([0, 2, 3, 4, 5])
    expect(built.command!.check).toEqual({ kind: 'media', streams: { video: 0, audio: 1, subtitle: 0, attachment: 0 }, duration: { expectedSec: 120, rule: 'tolerance' } })
  })

  it('writes a copy that WAV or AIFF cannot hold as PCM, and refuses one any other container cannot hold', () =>
  {
    const aiff = build(audioRecipe({ container: 'aiff' }))
    expect(argAfter(aiff.command!.args, '-c:a:0')).toMatch(/^pcm_s(16|24|32)be$/)
    expect(aiff.command!.class).toBe('audio')
    const wav = build(audioRecipe({ container: 'wav', stream: { by: 'ordinal', ordinal: 2 } }))
    expect(argAfter(wav.command!.args, '-c:a:0')).toBe('pcm_s24le')
    const mp3 = build(audioRecipe({ container: 'mp3' }))
    expect(mp3.command).toBeNull()
    expect(mp3.issues.map((i) => i.code)).toEqual(['container-cannot-hold'])
  })

  it('reads the copy and PCM rules from the container matrix', () =>
  {
    expect(copyFits({ codecName: 'aac' }, containerFor('m4a'))).toBe(true)
    expect(copyFits({ codecName: 'aac' }, containerFor('wav'))).toBe(false)
    expect(copyFits({ codecName: 'opus' }, containerFor('ogg'))).toBe(true)
    expect(pcmOnly(containerFor('wav'))).toBe(true)
    expect(pcmOnly(containerFor('aiff'))).toBe(true)
    expect(pcmOnly(containerFor('m4a'))).toBe(false)
    expect(pcmOnly(containerFor('nothing'))).toBe(false)
  })

  it('treats a range copy as a trim that only has to cover the span', () =>
  {
    const built = build(audioRecipe({ range: { startSec: 30, durationSec: 10 } }))
    expect(built.command!.args.slice(5, 11)).toEqual(['-ss', '30', '-t', '10', '-i', '/media/movie.mkv'])
    expect(built.command!.spanSec).toBe(10)
    expect(built.command!.check).toMatchObject({ duration: { expectedSec: 10, rule: 'covers' } })
    const encoded = build(audioRecipe({ container: 'mp3', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 }, range: { startSec: 30, durationSec: 10 } }))
    expect(encoded.command!.check).toMatchObject({ duration: { expectedSec: 10, rule: 'tolerance' } })
  })

  it('resolves stream picks against the probe', () =>
  {
    expect(argAfter(argv(audioRecipe({ stream: { by: 'language', language: 'jpn' }, container: 'mkv' })), '-map')).toBe('0:a:1')
    expect(argAfter(argv(audioRecipe({ stream: { by: 'ordinal', ordinal: 2 }, container: 'mkv' })), '-map')).toBe('0:a:1')
    const swapped = movie({ audio: [audio({ disposition: { default: 0 } }), audio({ audioIndex: 1, streamIndex: 2, disposition: { default: 1 } })] })
    expect(argAfter(argv(audioRecipe(), swapped), '-map')).toBe('0:a:1')
    const missing = build(audioRecipe({ stream: { by: 'ordinal', ordinal: 3 } }))
    expect(missing.command).toBeNull()
    expect(missing.issues[0]).toMatchObject({ code: 'stream-not-found', severity: 'error' })
    expect(missing.issues[0].message).toContain('2 audio streams')
    const none = build(audioRecipe(), movie({ audio: [] }))
    expect(none.issues[0].message).toContain('0 audio streams')
    const one = build(audioRecipe({ stream: { by: 'language', language: 'deu' } }), movie({ audio: [audio()] }))
    expect(one.issues[0].message).toContain('1 audio stream.')
  })

  it('folds channels only by the standard downmix or the mono fold', () =>
  {
    const stereo = argv(audioRecipe({ container: 'mp3', stream: { by: 'ordinal', ordinal: 2 }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 }, channels: 'stereo' }))
    const graph = argAfter(stereo, '-filter_complex') ?? ''
    expect(graph).toContain('pan=stereo')
    expect(graph).toContain('channel_layouts=stereo')
    expect(stereo).not.toContain('-ac')
    const mono = argv(audioRecipe({ container: 'mp3', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 }, channels: 'mono' }))
    expect(argAfter(mono, '-filter_complex')).toContain('pan=mono|c0=0.5*c0+0.5*c1')
  })

  it('refuses a layout with no downmix, a codec the build lacks, and more channels than the codec holds', () =>
  {
    const odd = build(audioRecipe({ container: 'mp3', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 }, channels: 'stereo' }), movie({ audio: [audio({ channels: 8, layout: '7.1(wide)' })] }))
    expect(odd.issues.map((i) => i.code)).toEqual(['layout-unsupported'])
    const caps = { ...CAPS, encoders: new Set([...CAPS.encoders].filter((e) => e !== 'libmp3lame')) }
    const container = 'mp3'
    const missing = buildExtractCommand({ source: '/m', facts: movie(), recipe: audioRecipe({ container, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 } }), container, muxer: 'mp3', caps, output: '/o', levels: null, showLevelsPlaceholder: false })
    expect(missing.issues.map((i) => [i.code, i.field])).toEqual([['encoder-missing', 'encoder']])
    expect(missing.issues[0].message).toContain('(MP3)')
    const wide = build(audioRecipe({ container: 'mp3', stream: { by: 'ordinal', ordinal: 2 }, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 } }))
    expect(wide.issues.map((i) => i.code)).toEqual(['too-many-channels'])
    expect(wide.issues[0].message).toBe('MP3 holds at most 2 channels; audio stream 2 has 6.')
  })

  it('refuses WMA outside its own containers and a codec the container cannot hold', () =>
  {
    const wma = build(audioRecipe({ container: 'mka', audio: { kind: 'codec', codec: 'wmav2', kbpsPerPair: null } }))
    expect(wma.issues.map((i) => i.code)).toEqual(['container-cannot-hold'])
    const vorbisInM4a = build(audioRecipe({ container: 'm4a', audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: null } }))
    expect(vorbisInM4a.command).toBeNull()
    expect(vorbisInM4a.issues[0].code).toBe('container-cannot-hold')
  })

  it('takes the recipe\'s sample rate and warns when the encoder cannot write it', () =>
  {
    const resampled = build(audioRecipe({ container: 'wav', audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null }, sampleRate: 44100 }), movie({ audio: [pcm16] }))
    expect(argAfter(resampled.command!.args, '-filter_complex')).toContain('osr=44100')
    expect(resampled.issues).toEqual([])
    const opus = build(audioRecipe({ container: 'opus', audio: { kind: 'codec', codec: 'opus', kbpsPerPair: null }, sampleRate: 44100 }))
    expect(opus.issues.map((i) => [i.code, i.severity])).toContainEqual(['sample-rate-unsupported', 'warning'])
    expect(opus.command!.audio!.choice!.sampleRate).toBe(48000)
  })
})

function videoRecipe(over: Partial<Extract<ExtractRecipe, { mode: 'video' }>> = {}): ExtractRecipe
{
  return { kind: 'extract', ...BASE, mode: 'video', container: 'mp4', reencode: null, range: null, ...over }
}

function gifRecipe(over: Partial<Extract<ExtractRecipe, { mode: 'gif' }>> = {}): ExtractRecipe
{
  return { kind: 'extract', ...BASE, mode: 'gif', fps: 12, width: 480, dither: 'sierra2_4a', plays: 'infinite', range: null, ...over }
}

function subtitleRecipe(over: Partial<Extract<ExtractRecipe, { mode: 'subtitles' }>> = {}): ExtractRecipe
{
  return { kind: 'extract', ...BASE, mode: 'subtitles', stream: { by: 'default' }, format: 'srt', ...over }
}

describe('extract video', () =>
{
  it('copies the picture, skipping cover art, with no other stream', () =>
  {
    const built = build(videoRecipe())
    expect(built.command!.args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-i', '/media/movie.mkv',
      '-map', '0:v:0', '-c:v:0', 'copy', '-map_chapters', '-1', '-f', 'mp4', '/work/out.part'
    ])
    expect(built.command!.video).toBeNull()
    expect(built.command!.class).toBe('copy')
    const coverFirst = movie({ video: [{ streamIndex: 0, codecName: 'png', cover: true }, { streamIndex: 1, codecName: 'h264', cover: false }] })
    expect(argAfter(argv(videoRecipe(), coverFirst), '-map')).toBe('0:v:1')
    expect(pictureIndex(movie({ video: [{ streamIndex: 0, codecName: 'png', cover: true }] }))).toBeNull()
  })

  it('warns that a stream-copy trim snaps to a keyframe and checks only that the output covers the span', () =>
  {
    const built = build(videoRecipe({ range: { startSec: 3, durationSec: 4 } }))
    expect(built.issues.map((i) => [i.code, i.severity, i.fix])).toEqual([['keyframe-trim', 'warning', null]])
    expect(built.command!.check).toMatchObject({ duration: { expectedSec: 4, rule: 'covers' } })
    const fromStart = build(videoRecipe({ range: { startSec: 0, durationSec: 4 } }))
    expect(fromStart.issues).toEqual([])
    expect(fromStart.command!.check).toMatchObject({ duration: { expectedSec: 4, rule: 'covers' } })
  })

  it('re-encodes with x264 at the recipe CRF, even dimensions, and 4:2:0', () =>
  {
    const built = build(videoRecipe({ reencode: { encoder: 'libx264', crf: 18 }, range: { startSec: 3, durationSec: 4 } }))
    const args = built.command!.args
    expect(argAfter(args, '-c:v:0')).toBe('libx264')
    expect(argAfter(args, '-crf')).toBe('18')
    expect(argAfter(args, '-filter:v:0')).toBe("crop=w='trunc(iw/2)*2':h='trunc(ih/2)*2':x=0:y=0,format=yuv420p")
    expect(built.issues).toEqual([])
    expect(built.command!.check).toMatchObject({ duration: { expectedSec: 4, rule: 'tolerance' } })
    expect(built.command!.video).toMatchObject({ encoder: 'libx264', passes: 1, cpuFallback: null })
    expect(built.command!.class).toBe('video-cpu')
  })

  it('re-encodes WebM with VP9 in constant quality', () =>
  {
    const args = argv(videoRecipe({ container: 'webm', reencode: { encoder: 'libvpx-vp9', crf: 32 } }))
    expect(args).toEqual(expect.arrayContaining(['-c:v:0', 'libvpx-vp9', '-crf', '32', '-b:v:0', '0', '-row-mt', '1']))
    expect(argAfter(args, '-filter:v:0')).toBe('format=yuv420p')
    expect(reencodeArgs({ encoder: 'libx264', crf: 99 })).toContain('51')
    expect(reencodeArgs({ encoder: 'libvpx-vp9', crf: -3 })).toContain('0')
  })

  it('refuses a source without a picture', () =>
  {
    for (const recipe of [videoRecipe(), gifRecipe(), framesRecipe()])
    {
      const built = build(recipe, movie({ video: [] }))
      expect(built.command).toBeNull()
      expect(built.issues.map((i) => i.code)).toEqual(['no-video-stream'])
    }
  })
})

describe('extract GIF', () =>
{
  it('reads the picked picture through a labeled palette graph, which FFmpeg 9 needs beside an explicit map', () =>
  {
    const built = build(gifRecipe({ range: { startSec: 2, durationSec: 3 } }), movie(), '/work/out.gif.part')
    const graph = '[0:v:0]fps=12,scale=480:-1:flags=lanczos,split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=sierra2_4a[gif]'
    expect(built.command!.args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-ss', '2', '-t', '3', '-i', '/media/movie.mkv',
      '-filter_complex', graph, '-map', '[gif]', '-loop', '0', '-map_chapters', '-1', '-f', 'gif', '/work/out.gif.part'
    ])
    expect(built.command!.video).toMatchObject({ encoder: 'gif', filters: [graph], notes: ['Forever'] })
    expect(built.command!.check).toMatchObject({ duration: { expectedSec: 3, rule: 'tolerance' } })
  })

  it('writes the plays as the muxer loop value', () =>
  {
    expect(argAfter(argv(gifRecipe({ plays: 1 })), '-loop')).toBe('-1')
    expect(argAfter(argv(gifRecipe({ plays: 3 })), '-loop')).toBe('2')
    expect(build(gifRecipe({ plays: 3 })).command!.video!.notes).toEqual(['Play 3 times'])
  })

  it('keeps the source width without a width and clamps the frame rate', () =>
  {
    expect(gifGraph('0:v:1', 12, null, 'none')).toBe('[0:v:1]fps=12,split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=none[gif]')
    expect(gifGraph('0:v:0', 500, 0, 'bayer')).toContain('fps=60,split')
    expect(gifGraph('0:v:0', 0, 320.4, 'bayer')).toContain('fps=1,scale=320:-1')
  })
})

describe('extract frames', () =>
{
  it('writes PNG frames into the escaped folder pattern with the image2 muxer', () =>
  {
    const built = build(framesRecipe({ sampling: { by: 'interval', seconds: 2 } }), movie(), 'C:\\Media\\.molex-work\\50% off')
    expect(built.command!.args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-i', '/media/movie.mkv',
      '-map', '0:v:0', '-filter:v:0', 'fps=1/2', '-c:v:0', 'png', '-f', 'image2', 'C:\\Media\\.molex-work\\50%% off\\frame_%06d.png'
    ])
    expect(built.command!.check).toEqual({ kind: 'frames', extension: 'png', expectedFrames: 60 })
    expect(built.command!.spanSec).toBe(120)
  })

  it('expects the frame counts the fps filter writes on both builds', async () =>
  {
    const { readFileSync } = await import('node:fs')
    const measured = JSON.parse(readFileSync(new URL('../../fixtures/jobs/runners/extract/measured.json', import.meta.url), 'utf8')) as
      { builds_results: Record<string, { frames: Record<string, { vf: string; spanSec: number; frames: number }> }> }
    for (const build of Object.values(measured.builds_results))
    {
      for (const [name, c] of Object.entries(build.frames))
      {
        const rate = c.vf.startsWith('fps=1/') ? 1 / Number(c.vf.slice(6)) : Number(c.vf.slice(4))
        const sampling = c.vf.startsWith('fps=1/') ? { by: 'interval' as const, seconds: Number(c.vf.slice(6)) } : { by: 'fps' as const, fps: rate }
        expect(frameSampling(sampling, null, c.spanSec)?.expected, name).toBe(c.frames)
      }
    }
  })

  it('samples by interval, by rate, and by count across the span', () =>
  {
    expect(frameSampling({ by: 'interval', seconds: 0.5 }, { startSec: 2, durationSec: 5 }, 5)).toEqual({ filter: 'fps=1/0.5', seekSec: null, expected: 10 })
    expect(frameSampling({ by: 'interval', seconds: 0 }, null, 1)).toEqual({ filter: 'fps=1/0.05', seekSec: null, expected: 20 })
    expect(frameSampling({ by: 'interval', seconds: 1 }, null, null)).toEqual({ filter: 'fps=1/1', seekSec: null, expected: null })
    expect(frameSampling({ by: 'fps', fps: 3 }, null, 10)).toEqual({ filter: 'fps=3', seekSec: null, expected: 30 })
    expect(frameSampling({ by: 'fps', fps: Number.NaN }, null, null)).toEqual({ filter: 'fps=1', seekSec: null, expected: null })
    expect(frameSampling({ by: 'fps', fps: 0.001 }, null, 10)).toEqual({ filter: 'fps=0.01', seekSec: null, expected: 1 })
    expect(frameSampling({ by: 'count', count: 10 }, { startSec: 1, durationSec: 3.3 }, 3.3)?.filter).toBe(`fps=${10 / 3.3}`)
    expect(frameSampling({ by: 'count', count: 0 }, null, 10)).toEqual({ filter: 'fps=0.1', seekSec: null, expected: 1 })
    expect(frameSampling({ by: 'count', count: 5 }, null, null)).toBeNull()
  })

  it('takes a thumbnail from the middle of the span', () =>
  {
    expect(frameSampling({ by: 'thumbnail' }, null, 120)).toEqual({ filter: null, seekSec: 60, expected: 1 })
    expect(frameSampling({ by: 'thumbnail' }, { startSec: 30, durationSec: 10 }, 10)).toEqual({ filter: null, seekSec: 35, expected: 1 })
    expect(frameSampling({ by: 'thumbnail' }, { startSec: 4, durationSec: null }, null)).toEqual({ filter: null, seekSec: 4, expected: 1 })
    const args = argv(framesRecipe({ sampling: { by: 'thumbnail' }, format: 'jpg', range: { startSec: 30, durationSec: 10 } }), movie(), '/work/thumb')
    expect(args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-ss', '35', '-i', '/media/movie.mkv',
      '-map', '0:v:0', '-frames:v', '1', '-c:v:0', 'mjpeg', '-q:v:0', '2', '-f', 'image2', '/work/thumb/frame_%06d.jpg'
    ])
    const start = argv(framesRecipe({ sampling: { by: 'thumbnail' } }), movie({ durationSec: Number.NaN }), '/work/thumb')
    expect(start).not.toContain('-ss')
    expect(build(framesRecipe({ sampling: { by: 'thumbnail' } })).command!.spanSec).toBeNull()
  })

  it('writes the JPEG quality and refuses WebP without libwebp', () =>
  {
    expect(argAfter(argv(framesRecipe({ format: 'jpg', jpgQuality: 40 })), '-q:v:0')).toBe('31')
    expect(argAfter(argv(framesRecipe({ format: 'webp' })), '-c:v:0')).toBe('libwebp')
    const caps = { ...CAPS, encoders: new Set([...CAPS.encoders].filter((e) => e !== 'libwebp')) }
    const missing = buildExtractCommand({ source: '/m', facts: movie(), recipe: framesRecipe({ format: 'webp' }), container: 'webp', muxer: 'image2', caps, output: '/o', levels: null, showLevelsPlaceholder: false })
    expect(missing.issues.map((i) => [i.code, i.field])).toEqual([['encoder-missing', 'encoder']])
  })
})

describe('extract subtitles', () =>
{
  it('converts a text stream with the encoder and muxer of each format', () =>
  {
    expect(build(subtitleRecipe()).command!.args).toEqual([
      '-n', '-analyzeduration', '200M', '-probesize', '200M', '-i', '/media/movie.mkv',
      '-map', '0:s:0', '-c:s:0', 'srt', '-map_chapters', '-1', '-f', 'srt', '/work/out.part'
    ])
    const vtt = build(subtitleRecipe({ format: 'vtt' }))
    expect(argAfter(vtt.command!.args, '-c:s:0')).toBe('webvtt')
    expect(argAfter(vtt.command!.args, '-f')).toBe('webvtt')
    expect(vtt.command!.check).toEqual({ kind: 'subtitle', format: 'vtt' })
    expect(argAfter(argv(subtitleRecipe({ format: 'ass' })), '-c:s:0')).toBe('ass')
    expect(build(subtitleRecipe()).command!.streams.kept).toEqual([{ kind: 'subtitle', source: 3, output: 0, action: 'convert' }])
  })

  it('refuses an image-based stream and a pick the source lacks', () =>
  {
    const bitmap = build(subtitleRecipe({ stream: { by: 'language', language: 'fre' } }))
    expect(bitmap.command).toBeNull()
    expect(bitmap.issues[0]).toMatchObject({ code: 'subtitle-bitmap', severity: 'error' })
    expect(bitmap.issues[0].message).toBe('Subtitle stream 2 is image-based (hdmv_pgs_subtitle), and FFmpeg converts only text subtitles to SRT.')
    const missing = build(subtitleRecipe({ stream: { by: 'ordinal', ordinal: 5 } }))
    expect(missing.issues[0].message).toContain('2 subtitle streams')
    const none = build(subtitleRecipe(), movie({ subtitles: [{ streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: null }] }))
    expect(none.command).not.toBeNull()
    const one = build(subtitleRecipe({ stream: { by: 'ordinal', ordinal: 2 } }), movie({ subtitles: [{ streamIndex: 3, subIndex: 0, codecName: 'subrip', bitmap: false, language: null }] }))
    expect(one.issues[0].message).toContain('1 subtitle stream.')
  })
})

describe('extract ranges', () =>
{
  it('refuses a range that starts at or after the end of the source', () =>
  {
    const built = build(videoRecipe({ range: { startSec: 130, durationSec: null } }))
    expect(built.command).toBeNull()
    expect(built.issues).toEqual([{ code: 'invalid-recipe', severity: 'error', field: 'recipe', fix: null, message: 'The range starts at 2:10, at or after the end of the source (2:00).' }])
    expect(rangeIssues({ startSec: 10, durationSec: null }, movie({ durationSec: Number.NaN }))).toEqual([])
    expect(rangeIssues(null, movie())).toEqual([])
  })

  it('drops chapters explicitly and lists every other stream as dropped', () =>
  {
    const built = build(videoRecipe(), movie({ chapters: 4, attachments: [{ streamIndex: 6, filename: 'font.ttf', mimetype: null }], data: [{ streamIndex: 7, codecName: 'bin_data' }] }))
    expect(built.command!.streams.chapters).toBe('dropped')
    expect(built.command!.streams.dropped.map((d) => `${d.kind}:${d.source}:${d.reason}`)).toEqual([
      'audio:1:policy', 'audio:2:policy', 'subtitle:3:policy', 'subtitle:4:policy', 'cover:5:policy', 'attachment:6:policy', 'data:7:policy'
    ])
  })
})

describe('downmix level placeholders', () =>
{
  it('shows the pan of an AC-3 stream folded to stereo as a placeholder', () =>
  {
    const ac3 = audio({ codecName: 'ac3', channels: 6, layout: '5.1', bitRate: 448000 })
    const planned = planExtractAudio({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'stereo', sampleRate: null }, ac3, containerFor('m4a'), CAPS, null)
    expect(planned.audio!.readsLevels).toBe(true)
    const shown = withLevelsPlaceholder(planned.audio!)
    expect(shown.stages).toContain('{downmix-a0}')
    const kept = planExtractAudio({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'keep', sampleRate: null }, ac3, containerFor('m4a'), CAPS, null)
    expect(kept.audio!.readsLevels).toBe(false)
    expect(withLevelsPlaceholder(kept.audio!)).toBe(kept.audio)
    const recipe = audioRecipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'stereo' })
    const built = buildExtractCommand({ source: '/m', facts: movie({ audio: [ac3] }), recipe, container: 'm4a', muxer: 'ipod', caps: CAPS, output: '/o', levels: null, showLevelsPlaceholder: true })
    expect(argAfter(built.command!.args, '-filter_complex')).toContain('{downmix-a0}')
  })
})

const SOURCE: SourceRef = { path: '/media/movie.mkv', size: 50_000_000, mtimeMs: 1, ext: 'mkv' } as unknown as SourceRef
const WORK = '/media/.molex-work-1'

type StepKind = 'levels' | 'encode' | 'decode'
interface Step
{
  code?: number | null
  signal?: string | null
  aborted?: boolean
  outputRefused?: boolean
  lines?: string[]
  progress?: FfmpegProgress[]
  throws?: Error
  onRun?(): void
}

function kindOf(args: readonly string[]): StepKind
{
  if (args.includes('level+info'))
  {
    return 'levels'
  }
  return args.includes(SOURCE.path) ? 'encode' : 'decode'
}

function scriptedExec(steps: Partial<Record<StepKind, Step>> = {})
{
  const calls: Array<{ kind: StepKind; args: string[]; options: ExecOptions }> = []
  const exec: Exec =
  {
    async run(args, options)
    {
      const kind = kindOf(args)
      calls.push({ kind, args: [...args], options })
      const step = steps[kind] ?? {}
      step.onRun?.()
      if (step.throws !== undefined)
      {
        throw step.throws
      }
      for (const p of step.progress ?? [])
      {
        options.onProgress?.(p)
      }
      for (const line of step.lines ?? [])
      {
        options.onStderrLine?.(line)
      }
      const code = step.code === undefined ? 0 : step.code
      return {
        code,
        exitName: code === null || code === 0 ? null : 'EINVAL',
        signal: step.signal ?? null,
        aborted: step.aborted ?? false,
        stopped: 'none',
        outputRefused: step.outputRefused ?? false,
        stderrTail: (step.lines ?? []).join('\n'),
        ms: 5
      }
    }
  }
  return Object.assign(exec, { calls })
}

interface HarnessOptions
{
  steps?: Partial<Record<StepKind, Step>>
  source?: MediaFacts | Error
  output?: MediaFacts
  onProbe?(file: string): void
}

function harness(o: HarnessOptions = {})
{
  const exec = scriptedExec(o.steps)
  const controller = new AbortController()
  const stages: string[] = []
  const progress: Array<{ outTimeSec: number | null; durationSec: number | null; speed: number | null; bytes: number | null }> = []
  const logs: string[] = []
  const folders: string[] = []
  const log: JobLogger =
  {
    debug: (m) => logs.push(`debug ${m}`),
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
    ffmpeg: (line) => logs.push(`ffmpeg ${line}`),
    child: () => log
  }
  const ctx: RunContext =
  {
    signal: controller.signal,
    exec,
    workDir: WORK,
    execution: 1,
    caps: CAPS,
    gpu: null,
    album: null,
    cache: { get: () => null, set: () => undefined },
    async probe(file)
    {
      o.onProbe?.(file)
      if (file === SOURCE.path)
      {
        if (o.source instanceof Error)
        {
          throw o.source
        }
        return o.source ?? movie()
      }
      return o.output ?? movie({ path: file, durationSec: 120, video: [], audio: [audio()], subtitles: [] })
    },
    output: (ext, encodePass) => `${WORK}/out-e${encodePass}.${ext}.part`,
    outputFolder: (name) =>
    {
      folders.push(name)
      return `${WORK}/${name}`
    },
    stage: (s) => stages.push(`${s.id} ${s.label}`),
    progress: (p) => progress.push(p),
    measured: () => undefined,
    log,
    now: () => 1234
  }
  return { ctx, exec, controller, stages, progress, logs, folders }
}

function plannedJob(recipe: ExtractRecipe, over: Partial<OutputPlan> = {}): RunnableJob<ExtractRecipe>
{
  const container = containerOf(recipe)
  const output: OutputPlan =
  {
    kind: recipe.mode === 'frames' ? 'folder' : 'file',
    finalPath: recipe.mode === 'frames' ? '/media/movie frames' : `/media/movie-extract.${container}`,
    container,
    muxer: MUXERS[container],
    containerChanged: null,
    conflict: 'none',
    resolution: 'place',
    renamedTo: null,
    displaces: null,
    ...over
  }
  const planned = planExtract({ recipe, source: SOURCE, facts: movie(), caps: CAPS, output, platform: 'linux' })
  const plan: JobPlan =
  {
    basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 },
    fingerprint: 'fp',
    source: { path: SOURCE.path, size: SOURCE.size, mtimeMs: SOURCE.mtimeMs },
    output,
    streams: planned.streams,
    video: planned.video,
    audio: planned.audio,
    class: planned.class,
    stages: planned.stages,
    estimate: { ...planned.estimate, reserveBytes: 0 },
    album: null,
    command: planned.command
  }
  const policy: FrozenPolicy =
    { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off', frozenAt: 1, date: '2026-10-18' }
  return { id: 'J1' as JobId, recipe, plan, policy, source: SOURCE, attempt: 1 }
}

function filesWith(o: { list?: Array<{ name: string; bytes: number }>; text?: string } = {}): VerifyFiles
{
  return { size: async () => 4096, text: async () => o.text ?? '', list: async () => o.list ?? [] }
}

function depsWith(o: { exists?: (file: string) => Promise<boolean>; makeFolder?: (folder: string) => Promise<void>; files?: VerifyFiles; verifyVideo?: 'full' | 'sampled' } = {}): ExtractRunnerDeps & { made: string[] }
{
  const made: string[] = []
  return {
    exists: o.exists ?? (async () => false),
    makeFolder: o.makeFolder ?? (async (folder) =>
    {
      made.push(folder)
    }),
    verifyVideo: () => o.verifyVideo ?? 'full',
    platform: 'linux',
    files: o.files ?? filesWith(),
    made
  }
}

/** Aborts a run from inside a dependency call and reports that it did. */
function abortNow(controller: AbortController): boolean
{
  controller.abort()
  return true
}

function frameList(n: number, ext = 'png'): Array<{ name: string; bytes: number }>
{
  return Array.from({ length: n }, (_, i) => ({ name: `frame_${String(i + 1).padStart(6, '0')}.${ext}`, bytes: 1000 }))
}

function failedError(outcome: RunOutcome)
{
  expect(outcome.kind).toBe('failed')
  return (outcome as Extract<RunOutcome, { kind: 'failed' }>).error
}

function produced(outcome: RunOutcome)
{
  expect(outcome.kind, JSON.stringify(outcome)).toBe('output')
  return outcome as Extract<RunOutcome, { kind: 'output' }>
}

describe('planExtract', () =>
{
  it('plans the command with the output as a placeholder and the stages of a run', () =>
  {
    const job = plannedJob(audioRecipe())
    expect(job.plan.command!.placeholders).toEqual([OUTPUT_PLACEHOLDER])
    expect(job.plan.command!.argv).toContain(OUTPUT_PLACEHOLDER)
    expect(job.plan.command!.argv).toContain('-nostdin')
    expect(job.plan.command!.display.startsWith('ffmpeg ')).toBe(true)
    expect(job.plan.stages.map((s) => s.id)).toEqual(['probe', 'encode', 'verify'])
    expect(job.plan.class).toBe('copy')
    expect(job.plan.estimate).toMatchObject({ outputBytes: 2_880_000, confidence: 'medium' })
  })

  it('plans a frame folder with the placeholder inside the image pattern', () =>
  {
    const job = plannedJob(framesRecipe())
    expect(job.plan.command!.argv).toContain(`${OUTPUT_PLACEHOLDER}/frame_%06d.png`)
    expect(job.plan.class).toBe('video-cpu')
    expect(job.plan.video).toMatchObject({ encoder: 'png', filters: ['fps=1/1'] })
  })

  it('names the levels placeholder of a folded AC-3 stream', () =>
  {
    const recipe = audioRecipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'stereo' })
    const output = { ...plannedJob(recipe).plan.output }
    const planned = planExtract({ recipe, source: SOURCE, facts: movie({ audio: [audio({ codecName: 'ac3', channels: 6, layout: '5.1' })] }), caps: CAPS, output, platform: 'linux' })
    expect(planned.command!.placeholders).toEqual([OUTPUT_PLACEHOLDER, '{downmix-a0}'])
    expect(planned.class).toBe('audio')
    expect(planned.estimate).toMatchObject({ outputBytes: 128 * 125 * 120, confidence: 'medium' })
  })

  it('keeps the issues and no command for a refused job', () =>
  {
    const cases: Array<[ExtractRecipe, string]> = [
      [subtitleRecipe({ stream: { by: 'ordinal', ordinal: 2 } }), 'copy'],
      [audioRecipe({ container: 'mp3' }), 'copy'],
      [audioRecipe({ container: 'mp3', audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 }, stream: { by: 'ordinal', ordinal: 2 } }), 'audio'],
      [videoRecipe({ reencode: { encoder: 'libx264', crf: 20 }, range: { startSec: 500, durationSec: null } }), 'video-cpu'],
      [videoRecipe({ range: { startSec: 500, durationSec: null } }), 'copy'],
      [gifRecipe({ range: { startSec: 500, durationSec: null } }), 'video-cpu']
    ]
    for (const [recipe, cls] of cases)
    {
      const planned = plannedJob(recipe).plan
      expect(planned.command).toBeNull()
      expect(planned.class).toBe(cls)
      expect(planned.streams).toEqual({ kept: [], dropped: [], chapters: 'none' })
      expect(planned.estimate.outputBytes).toBeNull()
    }
  })
})

describe('extractEstimate', () =>
{
  it('is exact for PCM, low for a copied picture, and unknown without a rate or a span', () =>
  {
    const pcm = build(audioRecipe({ container: 'wav', audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null }, stream: { by: 'ordinal', ordinal: 2 } }))
    expect(extractEstimate(pcm.command!, movie(), 1)).toEqual({ outputBytes: 48000 * 6 * 3 * 120, workSec: null, confidence: 'high' })
    const picture = build(videoRecipe({ range: { startSec: 0, durationSec: 30 } }))
    expect(extractEstimate(picture.command!, movie(), 1_200_000)).toEqual({ outputBytes: 300_000, workSec: null, confidence: 'low' })
    expect(extractEstimate(picture.command!, movie(), 0).outputBytes).toBeNull()
    const unrated = build(audioRecipe(), movie({ audio: [audio({ bitRate: null })] }))
    expect(extractEstimate(unrated.command!, movie(), 1).outputBytes).toBeNull()
    const flac = build(audioRecipe({ container: 'flac', audio: { kind: 'codec', codec: 'flac', kbpsPerPair: null } }))
    expect(extractEstimate(flac.command!, movie(), 1).outputBytes).toBeNull()
    const thumb = build(framesRecipe({ sampling: { by: 'thumbnail' } }))
    expect(extractEstimate(thumb.command!, movie(), 1).outputBytes).toBeNull()
    const gif = build(gifRecipe())
    expect(extractEstimate(gif.command!, movie(), 1).outputBytes).toBeNull()
  })

  it('reads PCM depth from the encoder name', () =>
  {
    expect(pcmBits('pcm_s16le')).toBe(16)
    expect(pcmBits('pcm_s24be')).toBe(24)
    expect(pcmBits('pcm_u8')).toBe(8)
    expect(pcmBits('pcm_f32le')).toBe(32)
    expect(pcmBits('aac')).toBeNull()
  })
})

describe('runExtract', () =>
{
  it('extracts a trimmed audio copy with progress measured against the span', async () =>
  {
    const progress: FfmpegProgress[] = [{ outTimeSec: 5, speed: 20, totalSize: 1000, end: false }, { outTimeSec: 10, speed: 21, totalSize: 2000, end: true }]
    const h = harness({ steps: { encode: { progress } }, output: movie({ durationSec: 10.02, video: [], audio: [audio()], subtitles: [] }) })
    const job = plannedJob(audioRecipe({ range: { startSec: 30, durationSec: 10 } }))
    const outcome = produced(await runExtract(job, h.ctx, depsWith()))
    expect(h.stages).toEqual(['probe Reading the source', 'encode Extracting audio', 'verify Verifying'])
    const encode = h.exec.calls.find((c) => c.kind === 'encode')!
    expect(encode.options.durationSec).toBe(10)
    expect(encode.args).toContain(`${WORK}/out-e1.m4a.part`)
    expect(h.progress.slice(0, 2)).toEqual([
      { outTimeSec: 5, durationSec: 10, speed: 20, bytes: 1000 },
      { outTimeSec: 10, durationSec: 10, speed: 21, bytes: 2000 }
    ])
    expect(outcome.artifact).toEqual({ kind: 'file', path: `${WORK}/out-e1.m4a.part`, container: 'm4a', bytes: 4096, durationSec: 10.02, encoder: { video: null, audio: ['copy'] } })
    expect(outcome.verification.verdict).toBe('verified')
    expect(outcome.verification.media).toMatchObject({ duration: 'within', expectedDurationSec: 10 })
    expect(outcome.notes).toEqual([])
    expect(h.logs.some((l) => l.startsWith('info ') && l.includes('ffmpeg'))).toBe(true)
  })

  it('writes frames into a folder named after the final folder and validates the sequence', async () =>
  {
    const deps = depsWith({ files: filesWith({ list: frameList(24) }) })
    const h = harness()
    const job = plannedJob(framesRecipe({ sampling: { by: 'count', count: 24 }, range: { startSec: 30, durationSec: 10 } }), { finalPath: 'C:\\Media\\50% off' })
    const outcome = produced(await runExtract(job, h.ctx, deps))
    expect(h.folders).toEqual(['50% off'])
    expect(deps.made).toEqual([`${WORK}/50% off`])
    const encode = h.exec.calls.find((c) => c.kind === 'encode')!
    expect(encode.args[encode.args.length - 1]).toBe(`${WORK}/50%% off/frame_%06d.png`)
    expect(encode.options.durationSec).toBe(10)
    expect(h.exec.calls.filter((c) => c.kind === 'decode')).toEqual([])
    expect(outcome.artifact).toMatchObject({ kind: 'folder', path: `${WORK}/50% off`, container: 'png', bytes: 24000, encoder: { video: 'png', audio: [] } })
    expect(outcome.verification.media!.frames).toBe(24)
    expect(outcome.notes).toEqual(['24 frames written.'])
  })

  it('fails a sequence that wrote no frame instead of reporting zero frames extracted', async () =>
  {
    const h = harness()
    const error = failedError(await runExtract(plannedJob(framesRecipe()), h.ctx, depsWith({ files: filesWith({ list: [] }) })))
    expect(error).toMatchObject({ code: 'output-unreadable', short: 'No frames', stage: 'verify' })
  })

  it('reports a sequence off by more than one as outside tolerance, and one frame as singular', async () =>
  {
    const off = produced(await runExtract(plannedJob(framesRecipe()), harness().ctx, depsWith({ files: filesWith({ list: frameList(100) }) })))
    expect(off.verification.verdict).toBe('outside-tolerance')
    const thumb = produced(await runExtract(plannedJob(framesRecipe({ sampling: { by: 'thumbnail' }, format: 'jpg' })), harness().ctx, depsWith({ files: filesWith({ list: frameList(1, 'jpg') }) })))
    expect(thumb.notes).toEqual(['1 frame written.'])
    expect(thumb.verification.verdict).toBe('verified')
  })

  it('uses an empty frame folder the engine made, and never writes into one holding files', async () =>
  {
    const empty = depsWith({ exists: async () => true, files: filesWith({ list: frameList(120) }) })
    let listed = 0
    const files: VerifyFiles = { ...filesWith(), list: async () => (listed++ === 0 ? [] : frameList(120)) }
    produced(await runExtract(plannedJob(framesRecipe()), harness().ctx, { ...empty, files }))
    expect(empty.made).toEqual([])
    const busy = failedError(await runExtract(plannedJob(framesRecipe()), harness().ctx, depsWith({ exists: async () => true, files: filesWith({ list: frameList(3) }) })))
    expect(busy).toMatchObject({ code: 'internal', short: 'Work folder in use', stage: 'encode' })
    const broken = failedError(await runExtract(plannedJob(framesRecipe()), harness().ctx, depsWith({ makeFolder: () => Promise.reject(new Error('EACCES')) })))
    expect(broken.short).toBe('Work folder failed')
    expect(broken.message).toContain('EACCES')
    const odd = failedError(await runExtract(plannedJob(framesRecipe()), harness().ctx, depsWith({ makeFolder: () => Promise.reject('nope') })))
    expect(odd.message).toContain('nope')
  })

  it('lists the frame folder itself when no file reads are given', async () =>
  {
    const root = mkdtempSync(join(tmpdir(), 'extract-'))
    try
    {
      const folder = join(root, 'frames')
      await makeFrameFolder(folder)
      await expect(makeFrameFolder(folder)).rejects.toThrow()
      writeFileSync(join(folder, 'frame_000001.png'), 'x')
      const h = harness()
      h.ctx.outputFolder = () => folder
      const deps = { exists: pathExists, makeFolder: makeFrameFolder, verifyVideo: () => 'full' as const, platform: 'linux' as const }
      const error = failedError(await runExtract(plannedJob(framesRecipe()), h.ctx, deps))
      expect(error.short).toBe('Work folder in use')
    }
    finally
    {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts the cues of a subtitle output', async () =>
  {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n\n3\n00:00:05,000 --> 00:00:06,500\nThree\n'
    const outcome = produced(await runExtract(plannedJob(subtitleRecipe()), harness().ctx, depsWith({ files: filesWith({ text: srt }) })))
    expect(outcome.verification.media!.cues).toBe(3)
    expect(outcome.notes).toEqual(['3 cues written.'])
    expect(outcome.artifact.encoder).toEqual({ video: null, audio: [] })
    const one = produced(await runExtract(plannedJob(subtitleRecipe()), harness().ctx, depsWith({ files: filesWith({ text: srt.split('\n\n')[0] + '\n' }) })))
    expect(one.notes).toEqual(['1 cue written.'])
    const none = failedError(await runExtract(plannedJob(subtitleRecipe()), harness().ctx, depsWith({ files: filesWith({ text: '' }) })))
    expect(none.short).toBe('No subtitle cues')
  })

  it('counts the cues FFmpeg measurably wrote for SRT, WebVTT, and ASS', async () =>
  {
    const measured = JSON.parse(readFileSync(new URL('../../fixtures/jobs/runners/extract/measured.json', import.meta.url), 'utf8')) as
      { builds_results: Record<string, { subtitles: Record<'srt' | 'vtt' | 'ass', { text: string }> }> }
    for (const build of Object.values(measured.builds_results))
    {
      for (const format of ['srt', 'vtt', 'ass'] as const)
      {
        const outcome = produced(await runExtract(plannedJob(subtitleRecipe({ format })), harness().ctx, depsWith({ files: filesWith({ text: build.subtitles[format].text }) })))
        expect(outcome.verification.media!.cues, format).toBe(3)
      }
    }
  })

  it('names the encoders of a GIF and of a copied picture', async () =>
  {
    const picture = movie({ path: 'x', durationSec: 120, video: [{ streamIndex: 0, codecName: 'h264', cover: false }], audio: [], subtitles: [] })
    const gif = produced(await runExtract(plannedJob(gifRecipe()), harness({ output: { ...picture, codecName: 'gif' } as MediaFacts }).ctx, depsWith()))
    expect(gif.artifact.encoder).toEqual({ video: 'gif', audio: [] })
    const copy = produced(await runExtract(plannedJob(videoRecipe()), harness({ output: picture }).ctx, depsWith()))
    expect(copy.artifact.encoder).toEqual({ video: 'copy', audio: [] })
    const x264 = produced(await runExtract(plannedJob(videoRecipe({ reencode: { encoder: 'libx264', crf: 20 } })), harness({ output: picture }).ctx, depsWith()))
    expect(x264.artifact.encoder).toEqual({ video: 'libx264', audio: [] })
  })

  it('decodes in full whenever the placement displaces a file, whatever the setting', async () =>
  {
    const picture = movie({ path: 'x', durationSec: 120, video: [{ streamIndex: 0, codecName: 'h264', cover: false }], audio: [], subtitles: [] })
    const sampled = produced(await runExtract(plannedJob(videoRecipe()), harness({ output: picture }).ctx, depsWith({ verifyVideo: 'sampled' })))
    expect(sampled.verification.media!.decode).toBe('sampled')
    const over = produced(await runExtract(plannedJob(videoRecipe(), { resolution: 'overwrite' }), harness({ output: picture }).ctx, depsWith({ verifyVideo: 'sampled' })))
    expect(over.verification.media!.decode).toBe('full')
    const displaced = produced(await runExtract(plannedJob(videoRecipe(), { displaces: '/media/old.mp4' }), harness({ output: picture }).ctx, depsWith({ verifyVideo: 'sampled' })))
    expect(displaced.verification.media!.decode).toBe('full')
  })

  it('reads the downmix levels of a folded AC-3 stream before the encode', async () =>
  {
    const ac3 = movie({ audio: [audio({ codecName: 'ac3', channels: 6, layout: '5.1' })] })
    const recipe = audioRecipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'stereo' })
    const line = '[Parsed_ashowinfo_0 @ 0] side data - downmix: preferred downmix type - Lo/Ro Mix levels: center 0.500000 (0.707107 ltrt) - surround 0.500000 (0.707107 ltrt) - lfe 0.000000'
    const h = harness({ source: ac3, steps: { levels: { lines: [line] } } })
    produced(await runExtract(plannedJob(recipe), h.ctx, depsWith()))
    expect(h.exec.calls.map((c) => c.kind)).toEqual(['levels', 'encode', 'decode'])
    const graph = argAfter(h.exec.calls[1].args, '-filter_complex') ?? ''
    expect(graph).not.toContain('{downmix-a0}')
    expect(graph).toContain('pan=stereo')
    expect(parseDownmixInfo(line)).not.toBeNull()
  })

  it('takes the standard levels when the read fails, and stops when it aborts', async () =>
  {
    const ac3 = movie({ audio: [audio({ codecName: 'ac3', channels: 6, layout: '5.1' })] })
    const recipe = audioRecipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'stereo' })
    const thrown = harness({ source: ac3, steps: { levels: { throws: new Error('spawn failed') } } })
    produced(await runExtract(plannedJob(recipe), thrown.ctx, depsWith()))
    expect(thrown.logs.some((l) => l.startsWith('warn ') && l.includes('ITU-R BS.775-4'))).toBe(true)
    const failed = harness({ source: ac3, steps: { levels: { code: 1 } } })
    produced(await runExtract(plannedJob(recipe), failed.ctx, depsWith()))
    const aborted = harness({ source: ac3, steps: { levels: { aborted: true } } })
    expect(await runExtract(plannedJob(recipe), aborted.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const killed = harness({ source: ac3 })
    killed.exec.calls.length = 0
    const steps = { levels: { onRun: () => killed.controller.abort(), throws: new Error('killed') } }
    const abortedThrow = harness({ source: ac3, steps })
    steps.levels.onRun = () => abortedThrow.controller.abort()
    expect(await runExtract(plannedJob(recipe), abortedThrow.ctx, depsWith())).toEqual({ kind: 'aborted' })
  })

  it('refuses a job its probe no longer allows before FFmpeg runs', async () =>
  {
    const h = harness({ source: movie({ subtitles: [{ streamIndex: 3, subIndex: 0, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'eng' }] }) })
    const error = failedError(await runExtract(plannedJob(subtitleRecipe()), h.ctx, depsWith()))
    expect(error).toMatchObject({ code: 'plan-refused', stage: 'probe', encodePass: null })
    expect(error.message).toContain('image-based')
    expect(h.exec.calls).toEqual([])
  })

  it('fails a probe, and returns aborted for an abort at each await', async () =>
  {
    const probe = failedError(await runExtract(plannedJob(audioRecipe()), harness({ source: new Error('bad header') }).ctx, depsWith()))
    expect(probe).toMatchObject({ code: 'probe-failed', message: 'The source could not be read: bad header' })
    const before = harness()
    before.controller.abort()
    expect(await runExtract(plannedJob(audioRecipe()), before.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const during = harness({ onProbe: () => during.controller.abort() })
    expect(await runExtract(plannedJob(audioRecipe()), during.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const thrown = harness({ source: new Error('gone'), onProbe: () => thrown.controller.abort() })
    expect(await runExtract(plannedJob(audioRecipe()), thrown.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const checking = harness()
    expect(await runExtract(plannedJob(audioRecipe()), checking.ctx, depsWith({ exists: async () => !abortNow(checking.controller) }))).toEqual({ kind: 'aborted' })
    const folder = harness()
    expect(await runExtract(plannedJob(framesRecipe()), folder.ctx, depsWith({ exists: async () => !abortNow(folder.controller) }))).toEqual({ kind: 'aborted' })
    const encoding = harness({ steps: { encode: { aborted: true } } })
    expect(await runExtract(plannedJob(audioRecipe()), encoding.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const spawn = harness()
    const steps = { encode: { onRun: () => spawn.controller.abort(), throws: new Error('killed') } }
    const spawned = harness({ steps })
    steps.encode.onRun = () => spawned.controller.abort()
    expect(await runExtract(plannedJob(audioRecipe()), spawned.ctx, depsWith())).toEqual({ kind: 'aborted' })
    const verifying = harness({ steps: { decode: { aborted: true } } })
    expect(await runExtract(plannedJob(audioRecipe()), verifying.ctx, depsWith())).toEqual({ kind: 'aborted' })
  })

  it('never writes over an existing work file', async () =>
  {
    const present = failedError(await runExtract(plannedJob(audioRecipe()), harness().ctx, depsWith({ exists: async () => true })))
    expect(present).toMatchObject({ code: 'internal', short: 'Work file exists' })
    const unknown = failedError(await runExtract(plannedJob(audioRecipe()), harness().ctx, depsWith({ exists: () => Promise.reject(new Error('EPERM')) })))
    expect(unknown.short).toBe('Work file exists')
    const refused = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { outputRefused: true } } }).ctx, depsWith()))
    expect(refused.message).toContain('already there')
    expect(refused.command).not.toBeNull()
  })

  it('classifies a failed extraction by its stderr', async () =>
  {
    const encoder = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { code: 1, lines: ['Error while opening encoder for output stream #0:0'] } } }).ctx, depsWith()))
    expect(encoder).toMatchObject({ code: 'ffmpeg-failed', cause: 'encoder', short: 'Encoder failed', exitCode: 1, exitName: 'EINVAL', encodePass: 1 })
    expect(encoder.message).toBe('The encoder could not start: Error while opening encoder for output stream #0:0')
    expect(encoder.stderrTail).toContain('Error while opening encoder')
    const disk = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { code: 1, lines: ['av_interleaved_write_frame(): No space left on device'] } } }).ctx, depsWith()))
    expect(disk.code).toBe('disk-full')
    const silent = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { code: -22 } } }).ctx, depsWith()))
    expect(silent.message).toBe('FFmpeg could not extract from this file: FFmpeg ended with exit code -22 (EINVAL).')
    const signaled = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { code: null, signal: 'SIGKILL' } } }).ctx, depsWith()))
    expect(signaled.message).toContain('stopped by SIGKILL')
    const plain = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { code: 1, lines: ['  ', 'Conversion failed!'] } } }).ctx, depsWith()))
    expect(plain.message).toBe('FFmpeg could not extract from this file: Conversion failed!')
    const missing = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { encode: { throws: new Error('ENOENT ffmpeg') } } }).ctx, depsWith()))
    expect(missing).toMatchObject({ code: 'ffmpeg-unavailable', message: 'FFmpeg could not be started: ENOENT ffmpeg' })
  })

  it('fails an output whose decode check reports errors', async () =>
  {
    const error = failedError(await runExtract(plannedJob(audioRecipe()), harness({ steps: { decode: { code: 0, lines: ['[aac @ 0] Invalid data'] } } }).ctx, depsWith()))
    expect(error.code).toBe('decode-errors')
  })

  it('is the extract runner', () =>
  {
    const runner = createExtractRunner(depsWith())
    expect(runner.kind).toBe('extract')
    expect(runner.plan).toBe(planExtract)
    expect(baseName('C:\\Media\\clip frames')).toBe('clip frames')
    expect(baseName('/media/clip/')).toBe('clip')
    expect(baseName('')).toBe('')
  })
})

describe('measured Extract commands', () =>
{
  interface Ran
  {
    exitCode: number
    issues: string[]
    files?: number
    expected: number | { expectedSec: number; rule: 'tolerance' | 'covers' } | null
    duration?: number | null
    streams?: Array<{ codec_name: string; bits_per_sample?: number; sample_fmt?: string }>
  }
  const recorded = JSON.parse(readFileSync(new URL('../../fixtures/jobs/runners/extract/commands.json', import.meta.url), 'utf8')) as
    { results: Record<string, Record<string, Ran>> }

  it('ran every mode on both builds, each output passing the check its command names', () =>
  {
    expect(Object.keys(recorded.results)).toEqual(['legacy', 'pinned'])
    for (const [build, cases] of Object.entries(recorded.results))
    {
      expect(Object.keys(cases).length, build).toBe(14)
      for (const [name, ran] of Object.entries(cases))
      {
        expect(ran.exitCode, `${build} ${name}`).toBe(0)
        if (ran.files !== undefined)
        {
          expect(framesWithin(ran.files, ran.expected as number), `${build} ${name}`).toBe(true)
        }
        else if (ran.expected !== null && typeof ran.expected === 'object')
        {
          expect(durationStatus(ran.duration ?? null, ran.expected), `${build} ${name}`).toBe('within')
        }
      }
      expect(cases['wav-24'].streams![0]).toMatchObject({ codec_name: 'pcm_s24le', bits_per_sample: 24 })
      expect(cases['aiff-copy'].streams![0].codec_name).toBe('pcm_s16be')
      expect(cases['video-copy-trim'].issues).toEqual(['keyframe-trim'])
      expect(cases['frames-count'].files).toBe(24)
    }
  })
})
