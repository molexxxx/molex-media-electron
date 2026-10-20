import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AudioFacts, MediaFacts } from '../../../../src/shared/audio/types'
import type { JobId } from '../../../../src/shared/jobs/ids'
import { MUX_TABLE, videoEncoderFit } from '../../../../src/shared/jobs/muxing'
import type { CompressRecipe, VideoEncoder } from '../../../../src/shared/jobs/recipes'
import type { FrozenPolicy, JobPlan, OutputPlan, SourceRef } from '../../../../src/shared/jobs/types'
import { containerFor } from '../../../../src/main/ffmpeg/audio/containers'
import type { BuildCapabilities } from '../../../../src/main/ffmpeg/audio/encoders'
import type { Exec, ExecOptions, FfmpegProgress } from '../../../../src/main/ffmpeg/exec'
import type { GpuLease, JobLogger } from '../../../../src/main/jobs/deps'
import { EVEN_CROP, OUTPUT_PLACEHOLDER, frameFitFilters, planConvertAudio } from '../../../../src/main/jobs/runners/convert'
import type { PlanInput, RunContext, RunnableJob } from '../../../../src/main/jobs/runners/types'
import
{
  CRF_TIERS,
  MIN_VIDEO_BPS,
  PASSLOG_PLACEHOLDER,
  SIZE_BUDGET,
  TWO_PASS_ENCODERS,
  UNKNOWN_AUDIO_BPS,
  acceptsTune,
  audioBudget,
  bitrateArgs,
  budgetNotes,
  buildCompressArgs,
  clampCrf,
  compressEstimate,
  compressIssues,
  createCompressRunner,
  displayedSize,
  gpuQp,
  gpuQualityArgs,
  isLossless,
  losslessArgs,
  outputSize,
  passLogFiles,
  passLogLeftovers,
  passLogPrefix,
  PASSLOG_PREFIX_MAX,
  pictureNotes,
  planCompress,
  qualityArgs,
  runCompress,
  sizeBudget,
  speedArgs
} from '../../../../src/main/jobs/runners/compress'
import type { CompressRunnerDeps } from '../../../../src/main/jobs/runners/compress'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/jobs/runners/compress')

interface EncoderFixture
{
  builds: Record<'pinned' | 'legacy', {
    version: string
    lossless: Record<string, { args: string[]; results: Record<'yuv420p' | 'yuv444p', { exit: number; psnr: string; pixFmt: string }> }>
    twoPass: Record<string, { pass1Exit: number; encodeExit: number; statsFiles: string[] }>
    target: Array<{ encoder: string; passes: number; targetBytes: number; videoBps: number; exit: number; bytes: number }>
  }>
}

const MEASURED = JSON.parse(readFileSync(join(FIXTURES, 'encoders.json'), 'utf8')) as EncoderFixture

const CAPS: BuildCapabilities =
{
  encoders: new Set(['aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s24le', 'libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'mpeg4']),
  experimental: new Set(),
  soxr: true
}

function audio(audioIndex: number, streamIndex: number, over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex, streamIndex, codecName: 'aac', profile: 'LC', channels: 2, layout: 'stereo', layoutGuessed: false, sampleRate: 48000,
    sampleFmt: 'fltp', bitsPerRawSample: null, bitRate: 192000, durationSec: 120, language: null, title: null, disposition: {}, ...over
  }
}

/** The three-audio-track MKV of the earlier mapping suite: H.264, AAC 5.1, two AAC stereo tracks, and no subtitles. */
function movie(over: Partial<MediaFacts> = {}): MediaFacts
{
  return {
    path: '/media/movie.mkv', container: 'mkv', formatName: 'matroska,webm', durationSec: 120,
    audio: [audio(0, 1, { channels: 6, layout: '5.1', disposition: { default: 1 } }), audio(1, 2), audio(2, 3)],
    video: [{ streamIndex: 0, codecName: 'h264', cover: false }],
    subtitles: [], attachments: [], data: [], chapters: 0, ...over
  }
}

/** A stereo MP3 with no picture. */
function song(over: Partial<MediaFacts> = {}): MediaFacts
{
  return movie({
    path: '/media/song.mp3', container: 'mp3', formatName: 'mp3', durationSec: 200,
    audio: [audio(0, 0, { codecName: 'mp3', bitRate: 320000, sampleRate: 44100 })], video: [], ...over
  })
}

const SUBRIP = { streamIndex: 4, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' }

function recipe(over: Partial<CompressRecipe> = {}): CompressRecipe
{
  return {
    kind: 'compress', presetId: null, userPreset: null, target: { mode: 'quality', tier: 'medium' }, encoder: 'libx264', speed: 'medium',
    pixelFormat: 'source', tune: null, fit: null, audio: { kind: 'copy' }, container: 'source', ...over
  }
}

const MUXERS: Readonly<Record<string, string>> = { mp4: 'mp4', mkv: 'matroska', webm: 'webm', mp3: 'mp3', m4a: 'ipod', mov: 'mov', flac: 'flac', ogg: 'ogg', wav: 'wav' }

function compress(r: CompressRecipe, f: MediaFacts = movie(), o: { container?: string; videoBps?: number | null; passLog?: string | null; gpuEncoder?: string | null } = {}):
  ReturnType<typeof buildCompressArgs> & { issues: string[] }
{
  const container = containerFor(o.container ?? f.container)
  const planned = planConvertAudio({ audio: r.audio, channels: 'keep' }, f, container, CAPS, new Map(), container.video)
  const command = buildCompressArgs({
    source: f.path, facts: f, recipe: r, container, muxer: MUXERS[container.name], audio: planned.streams, gpuEncoder: o.gpuEncoder ?? null,
    videoBps: o.videoBps ?? null, passLog: o.passLog ?? null, output: '/w/out-e1.part'
  })
  return { ...command, issues: planned.issues.map((issue) => `${issue.code}: ${issue.message}`) }
}

/** Values of every -map flag, in order. */
function maps(args: readonly string[]): string[]
{
  return args.flatMap((arg, i) => (arg === '-map' ? [args[i + 1]] : []))
}

function argAfter(args: readonly string[], flag: string): string | undefined
{
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

function encodeArgs(c: { passes: string[][] }): string[]
{
  return c.passes[c.passes.length - 1]
}

describe('losslessArgs', () =>
{
  it('uses each encoder\'s own lossless switch', () =>
  {
    expect(losslessArgs('libx264', 0)).toEqual({ args: ['-crf:v:0', '0'], mode: 'exact' })
    expect(losslessArgs('libaom-av1', 0)).toEqual({ args: ['-crf:v:0', '0', '-b:v:0', '0'], mode: 'exact' })
    expect(losslessArgs('libx265', 0)).toEqual({ args: ['-x265-params:v:0', 'lossless=1'], mode: 'exact' })
    expect(losslessArgs('libvpx-vp9', 1)).toEqual({ args: ['-lossless:v:1', '1'], mode: 'exact' })
  })

  it('reports encoders that cannot do lossless at all', () =>
  {
    expect(losslessArgs('libsvtav1', 0)).toEqual({ args: [], mode: 'none' })
    expect(losslessArgs('h264_nvenc', 0).mode).toBe('none')
    expect(losslessArgs('prores_ks', 0).mode).toBe('none')
  })

  it('needs no switch for the encoders that are always lossless', () =>
  {
    expect(losslessArgs('ffv1', 0)).toEqual({ args: [], mode: 'exact' })
    expect(losslessArgs('utvideo', 0)).toEqual({ args: [], mode: 'exact' })
  })
})

describe('qualityArgs', () =>
{
  it('leaves non-lossless tiers on the CRF table', () =>
  {
    expect(qualityArgs('libx265', { mode: 'quality', tier: 'high' }, 0)).toEqual(['-crf:v:0', '22'])
    expect(qualityArgs('libx264', { mode: 'quality', tier: 'medium' }, 0)).toEqual(['-crf:v:0', '23'])
    expect(qualityArgs('libsvtav1', { mode: 'quality', tier: 'low' }, 0)).toEqual(['-crf:v:0', '36'])
  })

  it('pairs a CRF with -b:v 0 for VP9 and AV1, whose bitrate default is a target', () =>
  {
    expect(qualityArgs('libvpx-vp9', { mode: 'quality', tier: 'medium' }, 0)).toEqual(['-crf:v:0', '31', '-b:v:0', '0'])
    expect(qualityArgs('libaom-av1', { mode: 'crf', crf: 30 }, 0)).toEqual(['-crf:v:0', '30', '-b:v:0', '0'])
  })

  it('emits the lossless switch rather than a bare CRF', () =>
  {
    expect(qualityArgs('libx265', { mode: 'quality', tier: 'lossless' }, 0)).toEqual(['-x265-params:v:0', 'lossless=1'])
    expect(qualityArgs('libvpx-vp9', { mode: 'quality', tier: 'lossless' }, 0)).toEqual(['-lossless:v:0', '1'])
    expect(qualityArgs('libx264', { mode: 'quality', tier: 'lossless' }, 0)).toEqual(['-crf:v:0', '0'])
  })

  it('clamps a CRF to the encoder\'s range', () =>
  {
    expect(qualityArgs('libx264', { mode: 'crf', crf: 70 }, 0)).toEqual(['-crf:v:0', '51'])
    expect(clampCrf('libsvtav1', 0)).toBe(1)
    expect(clampCrf('libvpx-vp9', 62.6)).toBe(63)
    expect(clampCrf('mpeg4', -3)).toBe(0)
  })

  it('maps tiers to a quantizer or a ProRes profile for encoders without a CRF', () =>
  {
    expect(qualityArgs('mpeg4', { mode: 'quality', tier: 'high' }, 0)).toEqual(['-q:v:0', '2'])
    expect(qualityArgs('libtheora', { mode: 'quality', tier: 'low' }, 0)).toEqual(['-q:v:0', '4'])
    expect(qualityArgs('mpeg2video', { mode: 'crf', crf: 18 }, 0)).toEqual(['-q:v:0', '2'])
    expect(qualityArgs('wmv2', { mode: 'crf', crf: 23 }, 0)).toEqual(['-q:v:0', '4'])
    expect(qualityArgs('mpeg4', { mode: 'crf', crf: 30 }, 0)).toEqual(['-q:v:0', '8'])
    expect(qualityArgs('prores_ks', { mode: 'quality', tier: 'medium' }, 0)).toEqual(['-profile:v:0', '2'])
    expect(qualityArgs('ffv1', { mode: 'quality', tier: 'high' }, 0)).toEqual([])
  })

  it('has a CRF tier for every CRF encoder', () =>
  {
    expect(Object.keys(CRF_TIERS).sort()).toEqual(['libaom-av1', 'libsvtav1', 'libvpx-vp9', 'libx264', 'libx265'])
  })
})

describe('speedArgs and tunes', () =>
{
  it('translates the speed per encoder', () =>
  {
    expect(speedArgs('libx264', 'slow', 0)).toEqual(['-preset:v:0', 'slow'])
    expect(speedArgs('libx265', 'veryfast', 0)).toEqual(['-preset:v:0', 'veryfast'])
    expect(speedArgs('libvpx-vp9', 'fast', 0)).toEqual(['-cpu-used:v:0', '4'])
    expect(speedArgs('libaom-av1', 'veryslow', 0)).toEqual(['-cpu-used:v:0', '1'])
    expect(speedArgs('libsvtav1', 'medium', 0)).toEqual(['-preset:v:0', '6'])
    expect(speedArgs('mpeg4', 'medium', 0)).toEqual([])
  })

  it('takes a tune only where the encoder has it', () =>
  {
    expect(acceptsTune('libx264', 'film')).toBe(true)
    expect(acceptsTune('libx265', 'film')).toBe(false)
    expect(acceptsTune('libx265', 'grain')).toBe(true)
    expect(acceptsTune('libvpx-vp9', 'animation')).toBe(false)
  })
})

describe('sizeBudget', () =>
{
  it('budgets the encode at about 97 percent of the target, in decimal megabytes', () =>
  {
    expect(SIZE_BUDGET).toBe(0.97)
    const budget = sizeBudget(100_000_000, 120, 3 * 192_000)
    expect(budget.budgetBytes).toBe(97_000_000)
    expect(budget.videoBps).toBe(Math.floor((97_000_000 * 8) / 120 - 3 * 192_000))
    expect(budget.ok).toBe(true)
  })

  it('leaves more room for video as audio streams are removed', () =>
  {
    expect(sizeBudget(100_000_000, 120, 192_000).videoBps).toBeGreaterThan(sizeBudget(100_000_000, 120, 3 * 192_000).videoBps)
  })

  it('refuses a target that leaves less than the video floor, naming the smallest that works', () =>
  {
    const budget = sizeBudget(1_000_000, 120, 576_000)
    expect(budget.ok).toBe(false)
    expect(budget.minTargetBytes).toBe(11_000_000)
    expect(sizeBudget(budget.minTargetBytes, 120, 576_000).videoBps).toBeGreaterThanOrEqual(MIN_VIDEO_BPS)
  })

  it('sets the peak and buffer relative to the budgeted bitrate', () =>
  {
    expect(bitrateArgs(1_000_000, 0)).toEqual(['-b:v:0', '1000000', '-maxrate:v:0', '2000000', '-bufsize:v:0', '4000000'])
  })
})

describe('passLogPrefix', () =>
{
  it('lives inside the execution folder and is distinct for two jobs on one source', () =>
  {
    const one = passLogPrefix('/media/.molex-A', 'J1')
    const two = passLogPrefix('/media/.molex-B', 'J2')
    expect(one).toBe(join('/media/.molex-A', 'passlog-J1'))
    expect(one.startsWith(join('/media/.molex-A'))).toBe(true)
    expect(two).not.toBe(one)
    expect(passLogPrefix('/w', 'a:b/c')).toBe(join('/w', 'passlog-a_b_c'))
  })

  it('moves into the short folder only when the work folder is too deep for the encoders', () =>
  {
    const deep = join('/media', 'd'.repeat(PASSLOG_PREFIX_MAX))
    expect(passLogPrefix(deep, 'J1', '/tmp/molex-pass')).toBe(join('/tmp/molex-pass', 'passlog-J1'))
    expect(passLogPrefix(deep, 'J1')).toBe(join(deep, 'passlog-J1'))
    expect(passLogPrefix('/media/.molex-A', 'J1', '/tmp/molex-pass')).toBe(join('/media/.molex-A', 'passlog-J1'))
  })

  it('lists every log and tree of both pass indices, finished or in progress, once', () =>
  {
    expect(passLogLeftovers('/p', [{ pass1: 0, encode: 1 }])).toEqual([
      '/p-0.log', '/p-0.log.temp', '/p-0.log.mbtree', '/p-0.log.mbtree.temp', '/p-0.log.cutree', '/p-0.log.cutree.temp',
      '/p-1.log', '/p-1.log.temp', '/p-1.log.mbtree', '/p-1.log.mbtree.temp', '/p-1.log.cutree', '/p-1.log.cutree.temp'
    ])
    expect(passLogLeftovers('/p', [{ pass1: 0, encode: 0 }])).toHaveLength(6)
  })
})

describe('measured encoder facts', () =>
{
  const builds = Object.values(MEASURED.builds)

  it('writes bit-exact output with each encoder\'s lossless switch on both builds, keeping 4:4:4', () =>
  {
    const exact: Record<string, string> = { 'libx264': 'x264-crf0', 'libaom-av1': 'aom-crf0', 'libx265': 'x265-lossless', 'libvpx-vp9': 'vp9-lossless', 'ffv1': 'ffv1', 'utvideo': 'utvideo' }
    for (const build of builds)
    {
      for (const [encoder, row] of Object.entries(exact))
      {
        expect(losslessArgs(encoder, 0).mode).toBe('exact')
        expect(losslessArgs(encoder, 0).args.filter((arg) => !arg.startsWith('-cpu-used'))).toEqual(build.lossless[row].args.slice(0, losslessArgs(encoder, 0).args.length))
        expect(build.lossless[row].results.yuv420p.psnr, `${encoder} on ${build.version}`).toBe('inf')
        expect(build.lossless[row].results.yuv444p).toMatchObject({ psnr: 'inf', pixFmt: 'yuv444p' })
      }
    }
  })

  it('measured -crf 0 as lossy for x265, 4:4:4 VP9, and SVT-AV1, which also drops 4:4:4 to 4:2:0', () =>
  {
    for (const build of builds)
    {
      expect(build.lossless['x265-crf0'].results.yuv420p.psnr).not.toBe('inf')
      expect(build.lossless['vp9-crf0'].results.yuv444p.psnr).not.toBe('inf')
      expect(build.lossless['svt-crf0'].results.yuv420p.psnr).not.toBe('inf')
      expect(build.lossless['svt-crf1'].results.yuv444p).toMatchObject({ pixFmt: 'yuv420p' })
    }
    expect(losslessArgs('libsvtav1', 0).mode).toBe('none')
  })

  it('runs both passes for every two-pass encoder with the statistics inside the given folder', () =>
  {
    for (const build of builds)
    {
      for (const [encoder, row] of Object.entries(build.twoPass))
      {
        expect(row, `${encoder} on ${build.version}`).toMatchObject({ pass1Exit: 0, encodeExit: 0 })
        expect(row.statsFiles).toContain('stats-0.log')
      }
    }
  })

  it('lands x264 and x265 under a size target from a 97 percent budget, one or two passes', () =>
  {
    for (const build of builds)
    {
      for (const row of build.target.filter((r) => r.encoder !== 'libvpx-vp9'))
      {
        expect(row.videoBps).toBe(sizeBudget(row.targetBytes, 10, 128_000).videoBps)
        expect(row.bytes, `${row.encoder} ${row.passes} pass on ${build.version}`).toBeLessThanOrEqual(row.targetBytes)
        expect(row.bytes).toBeGreaterThan(row.targetBytes * 0.9)
      }
    }
  })
})

describe('buildCompressArgs: stream mapping', () =>
{
  it('keeps every audio track instead of letting FFmpeg pick one', () =>
  {
    const c = compress(recipe())
    expect(maps(encodeArgs(c))).toEqual(['0:0', '0:1', '0:2', '0:3'])
    expect(maps(encodeArgs(c))).not.toContain('0')
    expect(c.streams.kept.map((s) => s.kind)).toEqual(['video', 'audio', 'audio', 'audio'])
  })

  it('maps subtitles and copies them for an mkv source', () =>
  {
    const c = compress(recipe(), movie({ subtitles: [SUBRIP] }))
    expect(maps(encodeArgs(c))).toContain('0:4')
    expect(argAfter(encodeArgs(c), '-c:s:0')).toBe('copy')
  })

  it('maps only the re-encoded picture on the first of two passes, into the null muxer through -', () =>
  {
    const c = compress(recipe({ target: { mode: 'size', targetBytes: 100_000_000, twoPass: true } }), movie({ subtitles: [SUBRIP] }), { videoBps: 4_000_000, passLog: '/w/passlog-J1' })
    expect(c.passes).toHaveLength(2)
    const [first, second] = c.passes
    expect(maps(first)).toEqual(['0:0'])
    expect(first).not.toContain('-c:s:0')
    expect(first.slice(-3)).toEqual(['-f', 'null', '-'])
    expect(first).not.toContain('NUL')
    expect(first).not.toContain('/dev/null')
    expect(maps(second)).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4'])
    expect(argAfter(second, '-c:s:0')).toBe('copy')
    expect(c.passIndices).toEqual([{ pass1: 0, encode: 0 }])
  })

  it('gives both passes the same statistics prefix and pass numbers on the picture alone', () =>
  {
    const c = compress(recipe({ target: { mode: 'size', targetBytes: 100_000_000, twoPass: true } }), movie(), { videoBps: 4_000_000, passLog: '/w/passlog-J1' })
    expect(argAfter(c.passes[0], '-passlogfile:v:0')).toBe('/w/passlog-J1')
    expect(argAfter(c.passes[1], '-passlogfile:v:0')).toBe('/w/passlog-J1')
    expect(argAfter(c.passes[0], '-pass:v:0')).toBe('1')
    expect(argAfter(c.passes[1], '-pass:v:0')).toBe('2')
    expect(c.passes[1]).not.toContain('-pass')
  })

  it('records where the picture lands when an audio stream comes first, so the statistics can follow it', () =>
  {
    const f = movie({ audio: [audio(0, 0)], video: [{ streamIndex: 1, codecName: 'h264', cover: false }] })
    const c = compress(recipe({ target: { mode: 'size', targetBytes: 50_000_000, twoPass: true } }), f, { videoBps: 2_000_000, passLog: '/w/p' })
    expect(maps(c.passes[0])).toEqual(['0:1'])
    expect(c.passIndices).toEqual([{ pass1: 0, encode: 1 }])
  })

  it('does not set a pass log for single-pass encodes', () =>
  {
    const c = compress(recipe())
    expect(c.passes).toHaveLength(1)
    expect(encodeArgs(c).some((arg) => arg.startsWith('-passlogfile'))).toBe(false)
  })

  it('maps audio for an audio-only source and encodes no picture', () =>
  {
    const c = compress(recipe({ audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 192 } }), song())
    expect(maps(encodeArgs(c))).toEqual(['[a0]'])
    expect(c.video).toBeNull()
    expect(argAfter(encodeArgs(c), '-c:a:0')).toBe('libmp3lame')
    expect(encodeArgs(c).slice(-3)).toEqual(['-f', 'mp3', '/w/out-e1.part'])
  })

  it('copies cover art beside the re-encoded picture', () =>
  {
    const f = movie({ container: 'mp4', video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 4, codecName: 'mjpeg', cover: true }] })
    const c = compress(recipe(), f, { container: 'mp4' })
    const args = encodeArgs(c)
    expect(argAfter(args, '-c:v:0')).toBe('libx264')
    expect(argAfter(args, '-c:v:1')).toBe('copy')
    expect(args).not.toContain('-c:v')
  })
})

describe('buildCompressArgs: the picture', () =>
{
  it('emits the lossless switch rather than a bare CRF for x265, and says it is exact', () =>
  {
    const c = compress(recipe({ encoder: 'libx265', target: { mode: 'quality', tier: 'lossless' } }))
    expect(argAfter(encodeArgs(c), '-x265-params:v:0')).toBe('lossless=1')
    expect(encodeArgs(c).some((arg) => arg.startsWith('-crf'))).toBe(false)
    expect(c.video?.lossless).toBe('exact')
  })

  it('emits -lossless 1 for VP9 and CRF 0 for x264', () =>
  {
    expect(argAfter(encodeArgs(compress(recipe({ encoder: 'libvpx-vp9', target: { mode: 'quality', tier: 'lossless' } }), movie(), { container: 'mkv' })), '-lossless:v:0')).toBe('1')
    expect(argAfter(encodeArgs(compress(recipe({ target: { mode: 'quality', tier: 'lossless' } }))), '-crf:v:0')).toBe('0')
  })

  it('states no lossless mode for SVT-AV1', () =>
  {
    expect(compress(recipe({ encoder: 'libsvtav1', target: { mode: 'quality', tier: 'lossless' } })).video?.lossless).toBe('none')
    expect(compress(recipe({ encoder: 'libsvtav1' })).video?.lossless).toBe('not-requested')
  })

  it('keeps the source pixel format unless the recipe names one', () =>
  {
    expect(compress(recipe({ encoder: 'libvpx-vp9' })).video?.filters).toEqual([])
    expect(compress(recipe({ encoder: 'libvpx-vp9', pixelFormat: 'yuv420p10le' })).video?.filters).toEqual(['format=yuv420p10le'])
  })

  it('crops odd frame sizes to even for the encoders that refuse them, and fits the picture as displayed', () =>
  {
    expect(compress(recipe()).video?.filters).toEqual([EVEN_CROP])
    expect(argAfter(encodeArgs(compress(recipe({ encoder: 'libsvtav1' }))), '-filter:v:0')).toBe(EVEN_CROP)
    const fit = { maxWidth: null, maxHeight: 720, mode: 'fit' as const }
    const c = compress(recipe({ fit, pixelFormat: 'yuv420p' }))
    expect(c.video?.filters).toEqual([...frameFitFilters(fit), 'format=yuv420p'])
    expect(argAfter(encodeArgs(c), '-filter:v:0')).toBe([...frameFitFilters(fit), 'format=yuv420p'].join(','))
  })

  it('passes speed, quality, and tune per stream', () =>
  {
    const args = encodeArgs(compress(recipe({ speed: 'slow', tune: 'film', target: { mode: 'crf', crf: 20 } })))
    expect(argAfter(args, '-preset:v:0')).toBe('slow')
    expect(argAfter(args, '-crf:v:0')).toBe('20')
    expect(argAfter(args, '-tune:v:0')).toBe('film')
    expect(compress(recipe({ encoder: 'libvpx-vp9', tune: 'film' })).video?.tune).toBeNull()
  })

  it('budgets a size target as a bitrate with a capped peak', () =>
  {
    const args = encodeArgs(compress(recipe({ target: { mode: 'size', targetBytes: 100_000_000, twoPass: false } }), movie(), { videoBps: 5_000_000 }))
    expect(argAfter(args, '-b:v:0')).toBe('5000000')
    expect(argAfter(args, '-maxrate:v:0')).toBe('10000000')
    expect(argAfter(args, '-bufsize:v:0')).toBe('20000000')
    expect(args.some((arg) => arg.startsWith('-crf'))).toBe(false)
  })

  it('swaps in a leased hardware encoder with a constant quantizer, one pass, and no tune or pixel format', () =>
  {
    const r = recipe({ tune: 'film', pixelFormat: 'yuv420p', target: { mode: 'crf', crf: 26 } })
    const c = compress(r, movie(), { gpuEncoder: 'h264_nvenc', passLog: '/w/p' })
    const args = encodeArgs(c)
    expect(c.passes).toHaveLength(1)
    expect(argAfter(args, '-c:v:0')).toBe('h264_nvenc')
    expect(argAfter(args, '-qp:v:0')).toBe('26')
    expect(argAfter(args, '-rc:v:0')).toBe('constqp')
    expect(args.some((arg) => arg.startsWith('-tune') || arg.startsWith('-preset') || arg.startsWith('-pass'))).toBe(false)
    expect(c.video?.filters).toEqual([])
    const sized = compress(recipe({ target: { mode: 'size', targetBytes: 10_000_000, twoPass: true } }), movie(), { gpuEncoder: 'hevc_qsv', videoBps: 300_000, passLog: '/w/p' })
    expect(argAfter(encodeArgs(sized), '-b:v:0')).toBe('300000')
  })

  it('keeps the CPU encoder for a lossless target even with a hardware lease', () =>
  {
    const c = compress(recipe({ target: { mode: 'quality', tier: 'lossless' } }), movie(), { gpuEncoder: 'h264_nvenc' })
    expect(c.video?.encoder).toBe('libx264')
    expect(c.video?.lossless).toBe('exact')
  })
})

describe('gpuQualityArgs', () =>
{
  it('sets the quantizer each vendor reads', () =>
  {
    expect(gpuQualityArgs('hevc_nvenc', 24, 0)).toEqual(['-rc:v:0', 'constqp', '-qp:v:0', '24'])
    expect(gpuQualityArgs('h264_qsv', 24, 1)).toEqual(['-global_quality:v:1', '24'])
    expect(gpuQualityArgs('av1_amf', 30, 0)).toEqual(['-rc:v:0', 'cqp', '-qp_i:v:0', '30', '-qp_p:v:0', '30', '-qp_b:v:0', '30'])
    expect(gpuQualityArgs('h264_vaapi', 20, 0)).toEqual(['-qp:v:0', '20'])
  })

  it('runs a tier at the encoder\'s tier CRF and a CRF as itself', () =>
  {
    expect(gpuQp('libx265', { mode: 'quality', tier: 'low' })).toBe(33)
    expect(gpuQp('libx264', { mode: 'crf', crf: 99 })).toBe(51)
    expect(gpuQp('mpeg4', { mode: 'quality', tier: 'medium' })).toBe(23)
    expect(gpuQp('libx264', { mode: 'quality', tier: 'lossless' })).toBe(18)
  })

  it('tells a lossless target apart', () =>
  {
    expect(isLossless({ mode: 'quality', tier: 'lossless' })).toBe(true)
    expect(isLossless({ mode: 'crf', crf: 0 })).toBe(false)
  })
})

describe('displayedSize and outputSize', () =>
{
  it('swaps the stored size for a quarter turn, so a height cap applies to the picture as displayed', () =>
  {
    expect(displayedSize({ width: 1920, height: 1080, rotation: 90 })).toEqual({ width: 1080, height: 1920 })
    expect(displayedSize({ width: 1920, height: 1080, rotation: -90 })).toEqual({ width: 1080, height: 1920 })
    expect(displayedSize({ width: 1920, height: 1080, rotation: 180 })).toEqual({ width: 1920, height: 1080 })
    const fit = { maxWidth: null, maxHeight: 720, mode: 'fit' as const }
    expect(outputSize(displayedSize({ width: 1920, height: 1080, rotation: 90 }), fit, 'libx264')).toEqual({ width: 404, height: 720 })
    expect(outputSize({ width: 1920, height: 1080 }, fit, 'libx264')).toEqual({ width: 1280, height: 720 })
  })

  it('never scales up, and pads or crops to the even box', () =>
  {
    expect(outputSize({ width: 640, height: 360 }, { maxWidth: null, maxHeight: 720, mode: 'fit' }, 'libx264')).toEqual({ width: 640, height: 360 })
    expect(outputSize({ width: 1920, height: 1080 }, { maxWidth: 1081, maxHeight: 1081, mode: 'pad' }, 'libx264')).toEqual({ width: 1080, height: 1080 })
    expect(outputSize({ width: 1920, height: 1080 }, { maxWidth: 720, maxHeight: 720, mode: 'crop' }, 'libx264')).toEqual({ width: 720, height: 720 })
  })

  it('crops odd sizes to even only for the encoders that refuse them', () =>
  {
    expect(outputSize({ width: 1281, height: 721 }, null, 'libx265')).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ width: 1281, height: 721 }, { maxWidth: null, maxHeight: null, mode: 'fit' }, 'libsvtav1')).toEqual({ width: 1280, height: 720 })
    expect(outputSize({ width: 1281, height: 721 }, null, 'libvpx-vp9')).toEqual({ width: 1281, height: 721 })
  })
})

describe('pictureNotes', () =>
{
  it('states the output size and warns when an odd picture is cropped', () =>
  {
    const odd = pictureNotes(recipe(), { width: 1281, height: 721, rotation: 0 }, 'libx264')
    expect(odd.notes).toEqual(['Writes 1280x720; the source displays at 1281x721.'])
    expect(odd.issues).toEqual([expect.objectContaining({ code: 'odd-dimensions', severity: 'warning', message: 'The 1281x721 picture is cropped to 1280x720, because H.264 needs even sizes.' })])
    expect(pictureNotes(recipe(), { width: 1920, height: 1080, rotation: 0 }, 'libx264')).toEqual({ notes: ['Writes 1920x1080, the size as displayed.'], issues: [] })
  })

  it('needs no warning when a FrameFit writes even sizes, and says nothing without the size', () =>
  {
    const fitted = pictureNotes(recipe({ fit: { maxWidth: null, maxHeight: 720, mode: 'fit' } }), { width: 1080, height: 1921, rotation: 90 }, 'libx264')
    expect(fitted.issues).toEqual([])
    expect(fitted.notes).toEqual(['Writes 1280x720; the source displays at 1921x1080.'])
    expect(pictureNotes(recipe(), null, 'libx264')).toEqual({ notes: [], issues: [] })
    expect(pictureNotes(recipe(), { width: 0, height: 0, rotation: 0 }, 'libx264')).toEqual({ notes: [], issues: [] })
  })
})

const SOURCE: SourceRef = { path: '/media/movie.mkv', name: 'movie.mkv', ext: 'mkv', dir: '/media', size: 400_000_000, mtimeMs: 1, origin: 'files', subdir: '' }
const WORK = '/media/.molex-MM-0001-a1-x1.partial'

function output(over: Partial<OutputPlan> = {}): OutputPlan
{
  return {
    kind: 'file', finalPath: '/out/movie.mkv', container: 'mkv', muxer: 'matroska', containerChanged: null, conflict: 'none',
    resolution: 'place', renamedTo: null, displaces: null, ...over
  }
}

function planInput(r: CompressRecipe, f: MediaFacts = movie(), container = f.container): PlanInput<CompressRecipe>
{
  return { recipe: r, source: { ...SOURCE, path: f.path }, facts: f, caps: CAPS, output: output({ container, muxer: MUXERS[container] }), platform: 'linux' }
}

function codes(issues: ReadonlyArray<{ code: string; severity: string }>): string[]
{
  return issues.map((i) => `${i.severity} ${i.code}`)
}

const SIZE = (targetBytes: number, twoPass = false): CompressRecipe['target'] => ({ mode: 'size', targetBytes, twoPass })

describe('planCompress', () =>
{
  it('plans the command as it runs, with the work path as a placeholder', () =>
  {
    const plan = planCompress(planInput(recipe()))
    expect(plan.command?.placeholders).toEqual([OUTPUT_PLACEHOLDER])
    expect(plan.command?.argv.slice(-3)).toEqual(['-f', 'matroska', OUTPUT_PLACEHOLDER])
    expect(plan.command?.display.startsWith('ffmpeg -hide_banner -nostdin')).toBe(true)
    expect(plan.video).toEqual({ encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [EVEN_CROP], notes: [], cpuFallback: null })
    expect(plan.class).toBe('video-cpu')
    expect(plan.stages).toEqual([{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }])
    expect(plan.issues).toEqual([])
    expect(plan.estimate).toEqual({ outputBytes: SOURCE.size, workSec: null, confidence: 'low' })
  })

  it('shows both passes of a two-pass size target, with the statistics prefix as a placeholder', () =>
  {
    const plan = planCompress(planInput(recipe({ target: SIZE(100_000_000, true) })))
    expect(plan.command?.placeholders).toEqual([OUTPUT_PLACEHOLDER, PASSLOG_PLACEHOLDER])
    expect(plan.command?.display.split('\n')).toHaveLength(2)
    expect(plan.command?.argv).toContain('-pass:v:0')
    expect(plan.video?.passes).toBe(2)
    expect(plan.stages[1]).toEqual({ id: 'encode', passes: 2 })
    const videoBps = Math.floor((97_000_000 * 8) / 120 - 3 * 192_000)
    expect(plan.command?.argv[plan.command.argv.indexOf('-b:v:0') + 1]).toBe(String(videoBps))
    expect(plan.video?.notes).toEqual([`Aims at 97 MB of the 100 MB target: video at ${Math.floor(videoBps / 1000)} kbps.`])
    expect(plan.estimate).toEqual({ outputBytes: 97_000_000, workSec: null, confidence: 'medium' })
  })

  it('runs one pass for an encoder whose two passes were not measured', () =>
  {
    expect(TWO_PASS_ENCODERS.has('mpeg2video')).toBe(false)
    const plan = planCompress(planInput(recipe({ encoder: 'mpeg2video', target: SIZE(100_000_000, true) })))
    expect(plan.video?.passes).toBe(1)
    expect(plan.video?.notes).toContain('MPEG-2 runs one pass.')
  })

  it('states the lossless mode per encoder and refuses SVT-AV1 lossless', () =>
  {
    const lossless = { mode: 'quality', tier: 'lossless' } as const
    for (const encoder of ['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1'] as VideoEncoder[])
    {
      const plan = planCompress(planInput(recipe({ encoder, target: lossless })))
      expect(plan.video?.lossless, encoder).toBe('exact')
      expect(codes(plan.issues)).not.toContain('error lossless-unsupported')
    }
    const svt = planCompress(planInput(recipe({ encoder: 'libsvtav1', target: lossless })))
    expect(svt.video?.lossless).toBe('none')
    expect(svt.issues).toContainEqual(expect.objectContaining({ code: 'lossless-unsupported', severity: 'error', message: 'AV1 (libsvtav1) has no lossless mode, so a lossless target would be lossy.' }))
  })

  it('says when a lossless target converts the pixel format first', () =>
  {
    const plan = planCompress(planInput(recipe({ target: { mode: 'quality', tier: 'lossless' }, pixelFormat: 'yuv420p' })))
    expect(plan.video?.notes).toContain('Lossless after the conversion to yuv420p; the source pixel format is not kept.')
  })

  it('refuses a size target that leaves too little for the video, with a fix to the smallest that works', () =>
  {
    const plan = planCompress(planInput(recipe({ target: SIZE(1_000_000) })))
    const refusal = plan.issues.find((i) => i.code === 'invalid-recipe')
    expect(refusal?.severity).toBe('error')
    expect(refusal?.message).toBe('1 MB leaves 0 kbps for the video of this 2-minute file once the audio takes 576 kbps; the smallest target that works is 11 MB.')
    expect(refusal?.fix).toEqual({
      kind: 'patch-recipe', label: 'Use 11 MB', patch: { field: 'compress-target', value: { mode: 'size', targetBytes: 11_000_000, twoPass: false }, encoder: 'libx264' }, scope: 'jobs'
    })
    expect(plan.command?.argv.includes('-b:v:0')).toBe(false)
    expect(plan.estimate.confidence).toBe('low')
  })

  it('refuses a size target without a duration, a picture, or a rated encoder', () =>
  {
    expect(codes(planCompress(planInput(recipe({ target: SIZE(10_000_000) }), movie({ durationSec: Number.NaN }))).issues)).toContain('error invalid-recipe')
    expect(codes(planCompress(planInput(recipe({ encoder: 'ffv1', target: SIZE(10_000_000) }))).issues)).toContain('error invalid-recipe')
    const audioOnly = planCompress(planInput(recipe({ target: SIZE(5_000_000) }), song()))
    expect(audioOnly.issues).toEqual([expect.objectContaining({ code: 'invalid-recipe', severity: 'error', message: 'A size target sets the video bitrate, and this file keeps no video. Choose a quality instead.' })])
  })

  it('reserves a stated rate for audio streams that state none', () =>
  {
    const f = movie({ audio: [audio(0, 1, { bitRate: null }), audio(1, 2)] })
    const planned = planConvertAudio({ audio: { kind: 'copy' }, channels: 'keep' }, f, containerFor('mkv'), CAPS, new Map(), true)
    expect(audioBudget(planned.streams)).toEqual({ bps: UNKNOWN_AUDIO_BPS + 192_000, unknown: [0] })
    const notes = budgetNotes(recipe({ target: SIZE(100_000_000) }), f, planned.streams)
    expect(notes[1]).toBe('Audio stream 1 states no bitrate, so the budget reserves 256 kbps for each.')
    expect(budgetNotes(recipe(), f, planned.streams)).toEqual([])
    const encoded = planConvertAudio({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 96 }, channels: 'keep' }, movie(), containerFor('mkv'), CAPS, new Map(), true)
    expect(audioBudget(encoded.streams).bps).toBe(encoded.streams.reduce((sum, a) => sum + (a.output.choice?.bitrateKbps ?? 0) * 1000, 0))
  })

  it('reports a missing encoder, a container that cannot hold the codec, and tunes the encoder lacks', () =>
  {
    expect(codes(planCompress(planInput(recipe({ encoder: 'libtheora' }))).issues)).toContain('error encoder-missing')
    const pair = Object.entries(MUX_TABLE.pinned).flatMap(([encoder, row]) =>
      Object.entries(row).filter(([ext, cell]) => cell.status === 'refused' && ['mp4', 'mov', 'webm'].includes(ext)).map(([ext]) => [encoder as VideoEncoder, ext] as const))[0]
    const [encoder, ext] = pair
    const held = planCompress(planInput(recipe({ encoder }), movie({ container: ext }), ext))
    expect(held.issues).toContainEqual(expect.objectContaining({ code: 'container-cannot-hold', severity: 'error', message: videoEncoderFit(encoder, ext)?.reason }))
    expect(codes(planCompress(planInput(recipe({ encoder: 'libx265', tune: 'film' }))).issues)).toContain('error tune-unsupported')
    expect(planCompress(planInput(recipe({ encoder: 'libvpx-vp9', tune: 'grain' }))).issues)
      .toContainEqual(expect.objectContaining({ code: 'tune-unsupported', severity: 'info', message: 'VP9 takes no tune, so the grain tune is not used.' }))
  })

  it('reports dropped streams for the output container', () =>
  {
    const plan = planCompress(planInput(recipe(), movie({ container: 'mp4', subtitles: [{ ...SUBRIP, codecName: 'hdmv_pgs_subtitle', bitmap: true }] }), 'mp4'))
    expect(codes(plan.issues)).toContain('info streams-dropped')
  })

  it('no longer writes AAC into an MP3: the audio policy is judged against the container', () =>
  {
    const aac = planCompress(planInput(recipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 192 } }), song(), 'mp3'))
    expect(aac.issues.some((i) => i.severity === 'error')).toBe(true)
    expect(aac.command?.argv).not.toContain('aac')
    const mp3 = planCompress(planInput(recipe({ audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 160 } }), song(), 'mp3'))
    expect(mp3.issues).toEqual([])
    expect(mp3.command?.argv[mp3.command.argv.indexOf('-c:a:0') + 1]).toBe('libmp3lame')
    expect(mp3.command?.argv).toContain('160k')
    expect(mp3.class).toBe('audio')
    expect(mp3.video).toBeNull()
    expect(planCompress(planInput(recipe({ audio: { kind: 'copy' } }), song(), 'mp3')).class).toBe('copy')
  })

  it('keeps every audio-only container on a codec it holds', () =>
  {
    for (const ext of ['flac', 'ogg', 'wav', 'webm'])
    {
      const plan = planCompress(planInput(recipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } }), song({ path: `/media/song.${ext}`, container: ext }), ext))
      expect(plan.command?.argv.includes('aac') && !plan.issues.some((i) => i.severity === 'error'), ext).toBe(false)
    }
  })

  it('takes the picture size from the runner deps for the output note', () =>
  {
    const runner = createCompressRunner({ ...absent, picture: () => ({ width: 1281, height: 721, rotation: 0 }) })
    const plan = runner.plan(planInput(recipe()))
    expect(plan.video?.notes).toEqual(['Writes 1280x720; the source displays at 1281x721.'])
    expect(codes(plan.issues)).toEqual(['warning odd-dimensions'])
    expect(runner.kind).toBe('compress')
  })

  it('estimates the source size outside a size target', () =>
  {
    expect(compressEstimate(recipe(), movie(), [], 5)).toEqual({ outputBytes: 5, workSec: null, confidence: 'low' })
    expect(compressIssues(recipe(), song(), containerFor('mp3'), CAPS, [])).toEqual([])
  })
})

interface Step
{
  lines?: string[]
  code?: number | null
  signal?: string | null
  aborted?: boolean
  outputRefused?: boolean
  progress?: FfmpegProgress[]
  throws?: Error
  onRun?(): void
}

type StepKind = 'pass1' | 'encode' | 'decode'

function stepKind(args: readonly string[]): StepKind
{
  const pass = args.indexOf('-pass:v:0')
  if (pass !== -1 && args[pass + 1] === '1')
  {
    return 'pass1'
  }
  return args.includes('null') ? 'decode' : 'encode'
}

function scriptedExec(steps: Partial<Record<StepKind, Step>> = {}): Exec & { calls: Array<{ kind: StepKind; args: readonly string[]; o: ExecOptions }> }
{
  const calls: Array<{ kind: StepKind; args: readonly string[]; o: ExecOptions }> = []
  return {
    calls,
    async run(args, o)
    {
      const kind = stepKind(args)
      calls.push({ kind, args, o })
      const step = steps[kind] ?? {}
      step.onRun?.()
      if (step.throws !== undefined)
      {
        throw step.throws
      }
      for (const p of step.progress ?? [])
      {
        o.onProgress?.(p)
      }
      for (const line of step.lines ?? [])
      {
        o.onStderrLine?.(line)
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
}

interface Harness
{
  ctx: RunContext
  exec: ReturnType<typeof scriptedExec>
  controller: AbortController
  stages: string[]
  progress: Array<{ outTimeSec: number | null; durationSec: number | null; speed: number | null; bytes: number | null }>
  logs: string[]
  probes: string[]
}

function harness(o: { steps?: Partial<Record<StepKind, Step>>; source?: MediaFacts; output?: MediaFacts | Error; gpu?: GpuLease | null; workDir?: string; onProbe?(file: string): void } = {}): Harness
{
  const exec = scriptedExec(o.steps)
  const controller = new AbortController()
  const stages: string[] = []
  const progress: Harness['progress'] = []
  const logs: string[] = []
  const probes: string[] = []
  const workDir = o.workDir ?? WORK
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
    workDir,
    execution: 1,
    caps: CAPS,
    gpu: o.gpu ?? null,
    album: null,
    cache: { get: () => null, set: () => undefined },
    async probe(file)
    {
      probes.push(file)
      o.onProbe?.(file)
      if (file === SOURCE.path || file === '/media/song.mp3')
      {
        return o.source ?? movie()
      }
      if (o.output instanceof Error)
      {
        throw o.output
      }
      return o.output ?? o.source ?? movie({ path: file })
    },
    output: (ext, encodePass) => `${workDir}/out-e${encodePass}.${ext}.part`,
    outputFolder: (name) => `${workDir}/${name}.part`,
    stage: (s) => stages.push(`${s.id} ${s.pass}/${s.passes} ${s.label}`),
    progress: (p) => progress.push(p),
    measured: () => undefined,
    log,
    now: () => 1234
  }
  return { ctx, exec, controller, stages, progress, logs, probes }
}

function job(r: CompressRecipe, o: { id?: string; facts?: MediaFacts; output?: Partial<OutputPlan> } = {}): RunnableJob<CompressRecipe>
{
  const facts = o.facts ?? movie()
  const container = o.output?.container ?? facts.container
  const planned = planCompress(planInput(r, facts, container))
  const plan: JobPlan =
  {
    basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 },
    fingerprint: 'fp',
    source: { path: facts.path, size: SOURCE.size, mtimeMs: SOURCE.mtimeMs },
    output: output({ container, muxer: MUXERS[container], ...o.output }),
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
  return { id: (o.id ?? 'J1') as JobId, recipe: r, plan, policy, source: { ...SOURCE, path: facts.path }, attempt: 2 }
}

const absent: CompressRunnerDeps =
  { exists: async () => false, verifyVideo: () => 'full', platform: 'linux', files: { size: async () => 1000, text: async () => '', list: async () => [] } }

/** A source whose audio stream comes before its picture. */
function audioFirst(): MediaFacts
{
  return movie({ audio: [audio(0, 0)], video: [{ streamIndex: 1, codecName: 'h264', cover: false }] })
}

describe('runCompress', () =>
{
  it('probes, encodes into the work path with -f, verifies there, and returns the artifact', async () =>
  {
    const h = harness({ steps: { encode: { lines: ['frame=1'], progress: [{ outTimeSec: 60, speed: 2, totalSize: 5000, end: false }] } } })
    const checked: string[] = []
    const runner = createCompressRunner({ ...absent, exists: async (file) => { checked.push(file); return false } })
    const outcome = await runner.run(job(recipe()), h.ctx)
    const out = `${WORK}/out-e1.mkv.part`
    expect(h.stages).toEqual(['probe 1/1 Reading the source', 'encode 1/1 Compressing', 'verify 1/1 Verifying'])
    expect(checked).toEqual([out])
    const encode = h.exec.calls.find((c) => c.kind === 'encode')
    expect(encode?.args.slice(-3)).toEqual(['-f', 'matroska', out])
    expect(encode?.args[0]).toBe('-n')
    expect(encode?.o).toMatchObject({ stop: 'kill', durationSec: 120 })
    expect(h.progress[0]).toEqual({ outTimeSec: 60, durationSec: 120, speed: 2, bytes: 5000 })
    expect(h.logs).toContain('ffmpeg frame=1')
    expect(h.logs.some((l) => l.startsWith('info > ffmpeg -hide_banner -nostdin'))).toBe(true)
    expect(h.probes).toEqual([SOURCE.path, out])
    expect(outcome).toMatchObject({
      kind: 'output',
      artifact: { kind: 'file', path: out, container: 'mkv', bytes: 1000, durationSec: 120, encoder: { video: 'libx264', audio: ['copy', 'copy', 'copy'] } },
      verification: { verdict: 'verified', encodePasses: 1, audio: null },
      measurement: null,
      notes: []
    })
  })

  it('runs two passes with the statistics inside the execution folder, distinct for two jobs on one source', async () =>
  {
    const r = recipe({ target: SIZE(100_000_000, true) })
    const one = harness({ workDir: '/media/.molex-MM-0001-a1-x1.partial' })
    const two = harness({ workDir: '/media/.molex-MM-0002-a1-x1.partial' })
    await runCompress(job(r, { id: 'J1' }), one.ctx, absent)
    await runCompress(job(r, { id: 'J2' }), two.ctx, absent)
    const prefixes = [one, two].map((h) =>
    {
      expect(h.exec.calls.map((c) => c.kind)).toEqual(['pass1', 'encode', 'decode'])
      const [first, second] = h.exec.calls
      const prefix = argAfter(first.args, '-passlogfile:v:0') as string
      expect(argAfter(second.args, '-passlogfile:v:0')).toBe(prefix)
      expect(prefix.startsWith(join(h.ctx.workDir))).toBe(true)
      expect(first.args.slice(-3)).toEqual(['-f', 'null', '-'])
      expect(h.stages).toEqual(['probe 1/1 Reading the source', 'encode 1/2 Analyzing, pass 1 of 2', 'encode 2/2 Compressing, pass 2 of 2', 'verify 1/1 Verifying'])
      return prefix
    })
    expect(prefixes[0]).not.toBe(prefixes[1])
    expect(prefixes[0]).toBe(passLogPrefix('/media/.molex-MM-0001-a1-x1.partial', 'J1'))
  })

  it('writes the statistics of a deep work folder into the short folder and deletes them after the run', async () =>
  {
    const deep = join('/media', 'd'.repeat(PASSLOG_PREFIX_MAX))
    const r = recipe({ target: SIZE(100_000_000, true) })
    const removed: string[] = []
    const deps: CompressRunnerDeps = { ...absent, passLogDir: async () => '/tmp/molex-pass', remove: async (file) => { removed.push(file) } }
    const ok = harness({ workDir: deep })
    await runCompress(job(r, { id: 'J1' }), ok.ctx, deps)
    const prefix = argAfter(ok.exec.calls[0].args, '-passlogfile:v:0') as string
    expect(prefix).toBe(join('/tmp/molex-pass', 'passlog-J1'))
    expect(argAfter(ok.exec.calls[1].args, '-passlogfile:v:0')).toBe(prefix)
    expect(removed).toContain(`${prefix}-0.log.mbtree`)
    expect(removed).toContain(`${prefix}-0.log.mbtree.temp`)

    removed.length = 0
    const failed = harness({ workDir: deep, steps: { pass1: { code: 1, lines: ['ratecontrol_init: can\'t open stats file'] } } })
    const outcome = await runCompress(job(r, { id: 'J2' }), failed.ctx, deps)
    expect(outcome.kind).toBe('failed')
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.every((file) => file.startsWith(join('/tmp/molex-pass', 'passlog-J2')))).toBe(true)
  })

  it('keeps a deep work folder\'s statistics beside it when the short folder cannot be made, and still runs', async () =>
  {
    const deep = join('/media', 'd'.repeat(PASSLOG_PREFIX_MAX))
    const removed: string[] = []
    const h = harness({ workDir: deep })
    const deps: CompressRunnerDeps = { ...absent, passLogDir: async () => { throw new Error('EACCES') }, remove: async (file) => { removed.push(file) } }
    const outcome = await runCompress(job(recipe({ target: SIZE(100_000_000, true) }), { id: 'J1' }), h.ctx, deps)
    expect(outcome.kind).toBe('output')
    expect(argAfter(h.exec.calls[0].args, '-passlogfile:v:0')).toBe(join(deep, 'passlog-J1'))
    expect(h.logs.some((line) => line.includes('short statistics folder could not be created'))).toBe(true)
    expect(removed).toEqual([])
  })

  it('logs a statistics file it could not delete and still returns the outcome', async () =>
  {
    const deep = join('/media', 'd'.repeat(PASSLOG_PREFIX_MAX))
    const h = harness({ workDir: deep })
    const deps: CompressRunnerDeps = { ...absent, passLogDir: async () => '/tmp/molex-pass', remove: async () => { throw new Error('EBUSY') } }
    const outcome = await runCompress(job(recipe({ target: SIZE(100_000_000, true) }), { id: 'J1' }), h.ctx, deps)
    expect(outcome.kind).toBe('output')
    expect(h.logs.some((line) => line.includes('could not be deleted') && line.includes('EBUSY'))).toBe(true)
  })

  it('reports bytes only for the pass that writes the output', async () =>
  {
    const progress = [{ outTimeSec: 30, speed: 1, totalSize: 900, end: false }]
    const h = harness({ steps: { pass1: { progress }, encode: { progress } } })
    await runCompress(job(recipe({ target: SIZE(100_000_000, true) })), h.ctx, absent)
    expect(h.progress.slice(0, 2).map((p) => p.bytes)).toEqual([null, 900])
  })

  it('moves the statistics of pass 1 when the picture lands at another output index', async () =>
  {
    const f = audioFirst()
    const h = harness({ source: f, output: f })
    const renames: Array<[string, string]> = []
    const rename = async (from: string, to: string): Promise<void> =>
    {
      renames.push([from, to])
      if (from.endsWith('.cutree'))
      {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    }
    const outcome = await runCompress(job(recipe({ target: SIZE(50_000_000, true) }), { facts: { ...f, path: SOURCE.path } }), h.ctx, { ...absent, rename })
    const prefix = passLogPrefix(WORK, 'J1')
    expect(renames).toEqual(passLogFiles(prefix, 0).map((from, i) => [from, passLogFiles(prefix, 1)[i]]))
    expect(outcome.kind).toBe('output')
  })

  it('fails when the statistics cannot be moved', async () =>
  {
    const f = audioFirst()
    const h = harness({ source: f, output: f })
    const rename = async (): Promise<void> => { throw Object.assign(new Error('EPERM: busy'), { code: 'EPERM' }) }
    const outcome = await runCompress(job(recipe({ target: SIZE(50_000_000, true) }), { facts: { ...f, path: SOURCE.path } }), h.ctx, { ...absent, rename })
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal', short: 'Pass log unusable', message: 'The statistics of pass 1 could not be moved for pass 2: EPERM: busy' } })
    expect(h.exec.calls.map((c) => c.kind)).toEqual(['pass1'])
  })

  it('stops after the statistics move when the signal aborts', async () =>
  {
    const f = audioFirst()
    const h = harness({ source: f, output: f })
    const rename = async (): Promise<void> => { h.controller.abort() }
    const outcome = await runCompress(job(recipe({ target: SIZE(50_000_000, true) }), { facts: { ...f, path: SOURCE.path } }), h.ctx, { ...absent, rename })
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  it('verifies a size target with no allowance over it and notes an output larger than the source', async () =>
  {
    const over = await runCompress(job(recipe({ target: SIZE(1_000_000_000) })), harness().ctx, { ...absent, files: { size: async () => 1_000_000_001, text: async () => '', list: async () => [] } })
    expect(over).toMatchObject({
      kind: 'output',
      verification: { verdict: 'outside-tolerance', media: { size: { bytes: 1_000_000_001, targetBytes: 1_000_000_000, status: 'over' } } },
      notes: ['The output is larger than the source (1000 MB from 400 MB).']
    })
    const at = await runCompress(job(recipe({ target: SIZE(1_000_000_000) })), harness().ctx, { ...absent, files: { size: async () => 1_000_000_000, text: async () => '', list: async () => [] } })
    expect(at).toMatchObject({ kind: 'output', verification: { verdict: 'verified', media: { size: { status: 'within' } } } })
  })

  it('compresses an audio-only file into its own container with an encoder it holds', async () =>
  {
    const f = song()
    const h = harness({ source: f, output: f })
    const outcome = await runCompress(job(recipe({ audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 128 } }), { facts: f }), h.ctx, absent)
    const encode = h.exec.calls.find((c) => c.kind === 'encode')
    expect(encode?.args.slice(-3)).toEqual(['-f', 'mp3', `${WORK}/out-e1.mp3.part`])
    expect(argAfter(encode?.args ?? [], '-c:a:0')).toBe('libmp3lame')
    expect(outcome).toMatchObject({ kind: 'output', artifact: { container: 'mp3', encoder: { video: null, audio: ['libmp3lame'] } } })
  })

  it('refuses before FFmpeg when the plan cannot run', async () =>
  {
    const h = harness()
    const outcome = await runCompress(job(recipe({ encoder: 'libsvtav1', target: { mode: 'quality', tier: 'lossless' } })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'plan-refused', short: 'Plan refused', stage: 'probe', attempt: 2, encodePass: null, at: 1234 } })
    expect(h.exec.calls).toEqual([])
    const aac = await runCompress(job(recipe({ audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 } }), { facts: song() }), harness({ source: song() }).ctx, absent)
    expect(aac).toMatchObject({ kind: 'failed', error: { code: 'plan-refused' } })
  })

  it('swaps in a leased hardware encoder and runs one pass', async () =>
  {
    const gpu: GpuLease = { encoder: 'h264_nvenc', classify: () => null }
    const h = harness({ gpu })
    const outcome = await runCompress(job(recipe({ target: SIZE(100_000_000, true) })), h.ctx, absent)
    expect(h.exec.calls.map((c) => c.kind)).toEqual(['encode', 'decode'])
    expect(argAfter(h.exec.calls[0].args, '-c:v:0')).toBe('h264_nvenc')
    expect(h.exec.calls[0].args.some((arg) => arg.startsWith('-pass'))).toBe(false)
    expect(outcome).toMatchObject({ kind: 'output', artifact: { encoder: { video: 'h264_nvenc' } } })
  })

  it('names a failed pass with the pass of two, the exit, and the last line FFmpeg wrote', async () =>
  {
    const h = harness({ steps: { pass1: { code: 1, lines: ['Error while opening encoder for output stream #0:0'] } } })
    const outcome = await runCompress(job(recipe({ target: SIZE(100_000_000, true) })), h.ctx, absent)
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: {
        code: 'ffmpeg-failed', short: 'Encoder failed', cause: 'encoder', stage: 'encode', encodePass: 1, exitCode: 1, exitName: 'EINVAL',
        message: 'The encoder could not start (pass 1 of 2): Error while opening encoder for output stream #0:0',
        stderrTail: 'Error while opening encoder for output stream #0:0'
      }
    })
    expect(outcome.kind === 'failed' && outcome.error.command?.argv.includes('-pass:v:0')).toBe(true)
    expect(h.exec.calls).toHaveLength(1)
  })

  it('names a signal or a bare exit when FFmpeg says nothing', async () =>
  {
    const stopped = await runCompress(job(recipe()), harness({ steps: { encode: { code: null, signal: 'SIGSEGV' } } }).ctx, absent)
    expect(stopped).toMatchObject({ kind: 'failed', error: { short: 'FFmpeg failed', message: 'FFmpeg could not compress this file: FFmpeg was stopped by SIGSEGV.' } })
    const exited = await runCompress(job(recipe()), harness({ steps: { encode: { code: 2 } } }).ctx, absent)
    expect(exited).toMatchObject({ kind: 'failed', error: { message: 'FFmpeg could not compress this file: FFmpeg ended with exit code 2 (EINVAL).' } })
    const plain = harness()
    plain.ctx = { ...plain.ctx, exec: { run: async () => ({ code: 3, exitName: null, signal: null, aborted: false, stopped: 'none', outputRefused: false, stderrTail: '', ms: 1 }) } }
    expect(await runCompress(job(recipe()), plain.ctx, absent)).toMatchObject({ kind: 'failed', error: { message: 'FFmpeg could not compress this file: FFmpeg ended with exit code 3.' } })
  })

  it('reports GPU session limits, GPU start failures, and a full disk', async () =>
  {
    const lease = (kind: 'session-limit' | 'init-failed' | null): GpuLease => ({ encoder: 'hevc_nvenc', classify: () => kind })
    const limit = await runCompress(job(recipe()), harness({ gpu: lease('session-limit'), steps: { encode: { code: 1 } } }).ctx, absent)
    expect(limit).toMatchObject({ kind: 'failed', error: { code: 'gpu-session-limit', short: 'GPU sessions full' } })
    const init = await runCompress(job(recipe()), harness({ gpu: lease('init-failed'), steps: { encode: { code: 1 } } }).ctx, absent)
    expect(init).toMatchObject({ kind: 'failed', error: { code: 'gpu-init-failed', message: 'The hevc_nvenc encoder could not start.' } })
    const full = await runCompress(job(recipe()), harness({ steps: { encode: { code: 1, lines: ['av_interleaved_write_frame(): No space left on device'] } } }).ctx, absent)
    expect(full).toMatchObject({ kind: 'failed', error: { code: 'disk-full', short: 'Disk full' } })
  })

  it('fails without spawning when the work file exists or cannot be checked', async () =>
  {
    const present = harness()
    expect(await runCompress(job(recipe()), present.ctx, { ...absent, exists: async () => true }))
      .toMatchObject({ kind: 'failed', error: { code: 'internal', short: 'Work file exists' } })
    expect(present.exec.calls).toEqual([])
    const unknown = harness()
    expect(await runCompress(job(recipe()), unknown.ctx, { ...absent, exists: async () => { throw new Error('EACCES') } }))
      .toMatchObject({ kind: 'failed', error: { code: 'internal' } })
    const refused = harness({ steps: { encode: { outputRefused: true } } })
    expect(await runCompress(job(recipe()), refused.ctx, absent)).toMatchObject({ kind: 'failed', error: { code: 'internal', short: 'Work file exists' } })
  })

  it('fails with the probe error, and names a failed spawn', async () =>
  {
    const h = harness()
    h.ctx = { ...h.ctx, probe: async () => { throw new Error('moov atom not found') } }
    expect(await runCompress(job(recipe()), h.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { code: 'probe-failed', stage: 'probe', message: 'The source could not be read: moov atom not found' } })
    const spawn = harness({ steps: { encode: { throws: new Error('ENOENT ffmpeg') } } })
    expect(await runCompress(job(recipe()), spawn.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { code: 'ffmpeg-unavailable', message: 'FFmpeg could not be started: ENOENT ffmpeg' } })
    const thrown = harness()
    thrown.ctx = { ...thrown.ctx, probe: async () => { throw 'gone' } }
    expect(await runCompress(job(recipe()), thrown.ctx, absent)).toMatchObject({ kind: 'failed', error: { message: 'The source could not be read: gone' } })
  })

  it('returns aborted at every await instead of throwing', async () =>
  {
    const before = harness()
    before.controller.abort()
    expect(await runCompress(job(recipe()), before.ctx, absent)).toEqual({ kind: 'aborted' })
    expect(before.stages).toEqual([])
    const probing = harness({ onProbe: () => probing.controller.abort() })
    expect(await runCompress(job(recipe()), probing.ctx, absent)).toEqual({ kind: 'aborted' })
    const probeThrows = harness()
    probeThrows.ctx = { ...probeThrows.ctx, probe: async () => { probeThrows.controller.abort(); throw new Error('stopped') } }
    expect(await runCompress(job(recipe()), probeThrows.ctx, absent)).toEqual({ kind: 'aborted' })
    const checking = harness()
    expect(await runCompress(job(recipe()), checking.ctx, { ...absent, exists: async () => { checking.controller.abort(); return false } })).toEqual({ kind: 'aborted' })
    const encoding = harness({ steps: { encode: { aborted: true } } })
    expect(await runCompress(job(recipe()), encoding.ctx, absent)).toEqual({ kind: 'aborted' })
    const spawnAbort = harness({ steps: { encode: { onRun: () => spawnAbort.controller.abort(), throws: new Error('killed') } } })
    expect(await runCompress(job(recipe()), spawnAbort.ctx, absent)).toEqual({ kind: 'aborted' })
    const verifying = harness({ steps: { decode: { onRun: () => verifying.controller.abort(), aborted: true } } })
    expect(await runCompress(job(recipe()), verifying.ctx, absent)).toEqual({ kind: 'aborted' })
  })

  it('fails on a failed verification, and always decodes in full for a displacing placement', async () =>
  {
    const unreadable = harness({ output: new Error('Invalid data found when processing input') })
    expect(await runCompress(job(recipe()), unreadable.ctx, absent)).toMatchObject({ kind: 'failed', error: { code: 'output-unreadable' } })
    const sampled = harness()
    await runCompress(job(recipe(), { output: { resolution: 'replace-original', displaces: '/media/movie.mkv' } }), sampled.ctx, { ...absent, verifyVideo: () => 'sampled' })
    const decode = sampled.exec.calls.find((c) => c.kind === 'decode')
    expect(decode?.args.filter((arg) => arg === '-i')).toHaveLength(1)
  })

  it('verifies without a duration when the source states none', async () =>
  {
    const f = movie({ durationSec: Number.NaN })
    const h = harness({ source: f, output: movie() })
    const outcome = await runCompress(job(recipe(), { facts: { ...f, path: SOURCE.path } }), h.ctx, absent)
    expect(h.exec.calls[0].o.durationSec).toBeUndefined()
    expect(outcome.kind).toBe('output')
  })
})
