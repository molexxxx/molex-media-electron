import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AudioFacts, MediaFacts } from '../../../../src/shared/audio/types'
import { containerLabel } from '../../../../src/shared/jobs/describe'
import type { JobId } from '../../../../src/shared/jobs/ids'
import { VIDEO_CODEC_IDS, codecFit, videoEncoderFit } from '../../../../src/shared/jobs/muxing'
import type { ConvertRecipe, FrameFit, VideoEncoder } from '../../../../src/shared/jobs/recipes'
import type { FrozenPolicy, JobPlan, OutputPlan, SourceRef } from '../../../../src/shared/jobs/types'
import { pinStages } from '../../../../src/main/ffmpeg/audio/chains'
import { containerFor } from '../../../../src/main/ffmpeg/audio/containers'
import { buildDownmixProbeArgs, downmixStage, monoFoldStage, parseDownmixInfo } from '../../../../src/main/ffmpeg/audio/downmix'
import type { BuildCapabilities } from '../../../../src/main/ffmpeg/audio/encoders'
import type { DropReason, StreamKind } from '../../../../src/main/ffmpeg/audio/streams'
import { execArgv } from '../../../../src/main/ffmpeg/exec'
import type { Exec, ExecOptions, FfmpegProgress } from '../../../../src/main/ffmpeg/exec'
import type { GpuLease, JobLogger } from '../../../../src/main/jobs/deps'
import type { PlanInput, RunContext, RunnableJob, RunOutcome } from '../../../../src/main/jobs/runners/types'
import
{
  EVEN_CROP,
  OUTPUT_PLACEHOLDER,
  audioEncoderLabel,
  buildConvertArgs,
  channelStages,
  createConvertRunner,
  ffmpegCause,
  frameFitFilters,
  levelsPlaceholder,
  pathExists,
  planConvert,
  planConvertAudio,
  plannedCounts,
  runConvert,
  streamIssues,
  videoEncoderArgs,
  videoFilters
} from '../../../../src/main/jobs/runners/convert'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/jobs/runners/convert')

interface FrameFitFixture
{
  sources: Record<string, { display: string }>
  cases: Record<string, { fit: FrameFit; result: Record<string, [number, number, string]> }>
}

/** The size the filters' expressions give for a displayed picture, evaluated the way FFmpeg evaluates them. */
function modelSize(fit: FrameFit, displayW: number, displayH: number): [number, number]
{
  const ratios = [fit.maxWidth === null ? null : fit.maxWidth / displayW, fit.maxHeight === null ? null : fit.maxHeight / displayH]
    .filter((r): r is number => r !== null)
  const both = ratios.length === 2
  const k = Math.min(1, both && fit.mode === 'crop' ? Math.max(...ratios) : Math.min(...ratios))
  let w = Math.trunc(displayW * k / 2) * 2
  let h = Math.trunc(displayH * k / 2) * 2
  if (both && fit.mode === 'pad')
  {
    return [fit.maxWidth as number, fit.maxHeight as number]
  }
  if (both && fit.mode === 'crop')
  {
    w = Math.min(fit.maxWidth as number, w)
    h = Math.min(fit.maxHeight as number, h)
  }
  return [w, h]
}

describe('frameFitFilters', () =>
{
  it('caps the displayed picture inside the box without scaling up', () =>
  {
    expect(frameFitFilters({ maxWidth: 1280, maxHeight: 720, mode: 'fit' })).toEqual([
      "scale=w='trunc(iw*sar*min(1,min(1280/(iw*sar),720/ih))/2)*2':h='trunc(ih*min(1,min(1280/(iw*sar),720/ih))/2)*2'",
      'setsar=1'
    ])
  })

  it('pads to the even box size, centered', () =>
  {
    expect(frameFitFilters({ maxWidth: 1080, maxHeight: 1920, mode: 'pad' })).toEqual([
      "scale=w='trunc(iw*sar*min(1,min(1080/(iw*sar),1920/ih))/2)*2':h='trunc(ih*min(1,min(1080/(iw*sar),1920/ih))/2)*2'",
      'setsar=1',
      'pad=1080:1920:(ow-iw)/2:(oh-ih)/2'
    ])
    expect(frameFitFilters({ maxWidth: 1081, maxHeight: 1919, mode: 'pad' })[2]).toBe('pad=1080:1918:(ow-iw)/2:(oh-ih)/2')
  })

  it('fills the box and crops the overflow, centered', () =>
  {
    expect(frameFitFilters({ maxWidth: 1280, maxHeight: 720, mode: 'crop' })).toEqual([
      "scale=w='trunc(iw*sar*min(1,max(1280/(iw*sar),720/ih))/2)*2':h='trunc(ih*min(1,max(1280/(iw*sar),720/ih))/2)*2'",
      'setsar=1',
      "crop=w='min(1280,iw)':h='min(720,ih)'"
    ])
  })

  it('caps one side alone, and pad or crop with one cap act as fit', () =>
  {
    const width = ["scale=w='trunc(iw*sar*min(1,1280/(iw*sar))/2)*2':h='trunc(ih*min(1,1280/(iw*sar))/2)*2'", 'setsar=1']
    expect(frameFitFilters({ maxWidth: 1280, maxHeight: null, mode: 'fit' })).toEqual(width)
    expect(frameFitFilters({ maxWidth: 1280, maxHeight: null, mode: 'pad' })).toEqual(width)
    expect(frameFitFilters({ maxWidth: null, maxHeight: 720, mode: 'crop' }))
      .toEqual(["scale=w='trunc(iw*sar*min(1,720/ih)/2)*2':h='trunc(ih*min(1,720/ih)/2)*2'", 'setsar=1'])
  })

  it('adds nothing without a cap', () =>
  {
    expect(frameFitFilters({ maxWidth: null, maxHeight: null, mode: 'pad' })).toEqual([])
  })

  it('agrees with the sizes both builds wrote for rotated, anamorphic, and small sources', () =>
  {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, 'frame-fit.json'), 'utf8')) as FrameFitFixture
    for (const { fit, result } of Object.values(fixture.cases))
    {
      expect(frameFitFilters(fit).length).toBeGreaterThan(0)
      for (const [source, [w, h, sar]] of Object.entries(result))
      {
        const [displayW, displayH] = fixture.sources[source].display.split('x').map(Number)
        expect(modelSize(fit, displayW, displayH), `${JSON.stringify(fit)} on ${source}`).toEqual([w, h])
        expect(sar).toBe('1:1')
      }
    }
  })
})

describe('videoFilters', () =>
{
  it('runs the FrameFit, then the frame rate, then the pixel format', () =>
  {
    expect(videoFilters({ fit: { maxWidth: 1280, maxHeight: 720, mode: 'fit' }, fps: 30, pixelFormat: 'yuv420p' }))
      .toEqual([...frameFitFilters({ maxWidth: 1280, maxHeight: 720, mode: 'fit' }), 'fps=30', 'format=yuv420p'])
  })

  it('keeps the source pixel format and adds nothing it was not asked for', () =>
  {
    expect(videoFilters({ fit: null, fps: null, pixelFormat: 'source' })).toEqual([])
    expect(videoFilters({ fit: null, fps: 29.97, pixelFormat: 'yuv420p10le' })).toEqual(['fps=29.97', 'format=yuv420p10le'])
  })
})

interface EncoderFixture
{
  cases: Record<string, {
    encoder: VideoEncoder
    kbps: number | null
    container: string
    muxer: string
    args: string[]
    result: Record<string, { exit: number; codec?: string; size?: string; error: string | null }>
  }>
}

const ENCODERS = JSON.parse(readFileSync(join(FIXTURES, 'encoders.json'), 'utf8')) as EncoderFixture

function codecArgsOf(args: readonly string[]): string[]
{
  return args.slice(args.indexOf('0:0') + 1, args.indexOf('-filter:v:0'))
}

describe('videoEncoderArgs', () =>
{
  it('writes the arguments both builds encoded with, for every encoder with and without a bitrate', () =>
  {
    const cases = Object.entries(ENCODERS.cases).filter(([name]) => !name.includes('odd'))
    expect(new Set(cases.map(([, c]) => c.encoder)).size).toBe(12)
    for (const [name, c] of cases)
    {
      expect(videoEncoderArgs(c.encoder, c.kbps, 0), name).toEqual(codecArgsOf(c.args))
      for (const [build, r] of Object.entries(c.result))
      {
        expect(r.exit, `${name} on ${build}`).toBe(0)
        expect(r.codec, `${name} on ${build}`).toBe(VIDEO_CODEC_IDS[c.encoder])
      }
    }
  })

  it('names the output stream on every option', () =>
  {
    expect(videoEncoderArgs('libx264', 5000, 1)).toEqual(['-c:v:1', 'libx264', '-b:v:1', '5000k'])
    expect(videoEncoderArgs('libvpx-vp9', null, 2)).toEqual(['-c:v:2', 'libvpx-vp9', '-crf:v:2', '31', '-b:v:2', '0'])
    expect(videoEncoderArgs('mpeg2video', null, 0)).toEqual(['-c:v:0', 'mpeg2video', '-q:v:0', '3'])
  })

  it('gives ProRes, FFV1, and UT Video no rate control, whatever the recipe says', () =>
  {
    expect(videoEncoderArgs('prores_ks', 8000, 0)).toEqual(['-c:v:0', 'prores_ks'])
    expect(videoEncoderArgs('ffv1', null, 0)).toEqual(['-c:v:0', 'ffv1'])
    expect(videoEncoderArgs('utvideo', 1000, 0)).toEqual(['-c:v:0', 'utvideo'])
  })
})

describe('even frame sizes', () =>
{
  it('crops an odd picture to even for the encoders that refuse odd sizes, measured on both builds', () =>
  {
    for (const encoder of ['libx264', 'libx265', 'libsvtav1'] as const)
    {
      const cropped = ENCODERS.cases[`${encoder} odd with even crop`]
      expect(cropped.args[cropped.args.indexOf('-filter:v:0') + 1]).toBe(`${EVEN_CROP},format=yuv420p`)
      for (const [build, r] of Object.entries(cropped.result))
      {
        expect(r, `${encoder} on ${build}`).toMatchObject({ exit: 0, size: '320x240' })
      }
      const refused = Object.entries(ENCODERS.cases[`${encoder} odd without crop`].result).filter(([, r]) => r.exit !== 0)
      expect(refused.length, encoder).toBeGreaterThan(0)
      expect(videoFilters({ fit: null, fps: null, pixelFormat: 'yuv420p' }, encoder)).toEqual([EVEN_CROP, 'format=yuv420p'])
    }
  })

  it('leaves the crop out when a FrameFit already writes even sizes, and for encoders that take odd sizes', () =>
  {
    const fit: FrameFit = { maxWidth: 1280, maxHeight: 720, mode: 'fit' }
    expect(videoFilters({ fit, fps: null, pixelFormat: 'source' }, 'libx264')).toEqual(frameFitFilters(fit))
    expect(videoFilters({ fit: { maxWidth: null, maxHeight: null, mode: 'fit' }, fps: null, pixelFormat: 'source' }, 'libx265')).toEqual([EVEN_CROP])
    expect(videoFilters({ fit: null, fps: 25, pixelFormat: 'source' }, 'ffv1')).toEqual(['fps=25'])
    expect(videoFilters({ fit: null, fps: null, pixelFormat: 'source' }, 'libvpx-vp9')).toEqual([])
  })
})

const CAPS: BuildCapabilities =
{
  encoders: new Set(['aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'mp2', 'wmav2', 'pcm_s16le', 'pcm_s24le', 'libx264', 'libx265', 'libvpx-vp9', 'mpeg4']),
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

const SUBRIP = { streamIndex: 4, subIndex: 0, codecName: 'subrip', bitmap: false, language: 'eng' }
const PGS = { streamIndex: 4, subIndex: 0, codecName: 'hdmv_pgs_subtitle', bitmap: true, language: 'eng' }

function recipe(over: Partial<ConvertRecipe> = {}): ConvertRecipe
{
  return {
    kind: 'convert', presetId: null, userPreset: null, container: 'mp4',
    video: { encoder: 'libx264', bitrateKbps: 5000, fit: null, fps: null, pixelFormat: 'yuv420p' },
    audio: { kind: 'codec', codec: 'aac', kbpsPerPair: 128 }, channels: 'keep', subtitles: 'keep', ...over
  }
}

const MUXERS: Readonly<Record<string, string>> =
  { mp4: 'mp4', mkv: 'matroska', webm: 'webm', mp3: 'mp3', m4a: 'ipod', avi: 'avi', wma: 'asf', wmv: 'asf', asf: 'asf', mov: 'mov' }

function convert(r: ConvertRecipe, f: MediaFacts = movie(), gpuEncoder: string | null = null): ReturnType<typeof buildConvertArgs> & { issues: string[] }
{
  const container = containerFor(r.container)
  const planned = planConvertAudio(r, f, container, CAPS, new Map(), container.video)
  const command = buildConvertArgs({
    source: f.path, facts: f, recipe: r, container, muxer: MUXERS[r.container], audio: planned.streams, gpuEncoder, output: '/w/out-e1.part'
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

describe('buildConvertArgs: stream mapping', () =>
{
  it('keeps every audio track when converting to mp4', () =>
  {
    const { args, issues } = convert(recipe())
    expect(issues).toEqual([])
    expect(maps(args)).toEqual(['0:0', '[a0]', '[a1]', '[a2]'])
    expect(args.filter((arg) => /^-c:a:\d$/.test(arg))).toEqual(['-c:a:0', '-c:a:1', '-c:a:2'])
  })

  it('never emits a blanket -map 0 or leaves the choice to FFmpeg', () =>
  {
    const { args } = convert(recipe(), movie({ subtitles: [SUBRIP] }))
    expect(maps(args)).not.toContain('0')
    expect(maps(args)).toEqual(['0:0', '[a0]', '[a1]', '[a2]', '0:4'])
    expect(maps(args).every((m) => /^(0:\d+|\[a\d+\])$/.test(m))).toBe(true)
  })

  it('converts text subtitles to mov_text for mp4 rather than copying', () =>
  {
    const { args, streams } = convert(recipe(), movie({ subtitles: [SUBRIP] }))
    expect(argAfter(args, '-c:s:0')).toBe('mov_text')
    expect(streams.kept.find((s) => s.kind === 'subtitle')).toEqual({ kind: 'subtitle', source: 4, output: 4, action: 'convert' })
  })

  it('copies subtitles through for mkv', () =>
  {
    const { args } = convert(recipe({ container: 'mkv' }), movie({ subtitles: [SUBRIP] }))
    expect(argAfter(args, '-c:s:0')).toBe('copy')
    expect(maps(args)).toContain('0:4')
  })

  it('drops bitmap subtitles when targeting mp4', () =>
  {
    const { args, streams } = convert(recipe(), movie({ subtitles: [PGS] }))
    expect(maps(args)).not.toContain('0:4')
    expect(args.some((arg) => arg.startsWith('-c:s'))).toBe(false)
    expect(streams.dropped).toEqual([{ kind: 'subtitle', source: 4, reason: 'bitmap-subtitle' }])
  })

  it('emits no subtitle arguments for a container that cannot carry them, and WebVTT for webm', () =>
  {
    const mpeg4 = { encoder: 'mpeg4' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p' as const }
    const avi = convert(recipe({ container: 'avi', video: mpeg4, audio: { kind: 'codec', codec: 'ac3', kbpsPerPair: 192 } }), movie({ subtitles: [SUBRIP] }))
    expect(avi.issues).toEqual([])
    expect(avi.args.some((arg) => arg.startsWith('-c:s'))).toBe(false)
    expect(maps(avi.args)).not.toContain('0:4')
    expect(avi.streams.dropped).toEqual([{ kind: 'subtitle', source: 4, reason: 'subtitle-unsupported' }])
    const vp9 = { encoder: 'libvpx-vp9' as const, bitrateKbps: 2500, fit: null, fps: null, pixelFormat: 'yuv420p' as const }
    const webm = convert(recipe({ container: 'webm', video: vp9, audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 96 } }), movie({ subtitles: [SUBRIP] }))
    expect(argAfter(webm.args, '-c:s:0')).toBe('webvtt')
  })

  it('maps a single audio stream and no video for an audio-only target, downmixed by the standard downmix', () =>
  {
    const { args, issues, streams } = convert(recipe({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 }, channels: 'stereo' }))
    expect(issues).toEqual([])
    expect(maps(args)).toEqual(['[a0]'])
    expect(args.some((arg) => arg.startsWith('-c:v'))).toBe(false)
    expect(streams.dropped.map((d) => `${d.kind} ${d.source} ${d.reason}`))
      .toEqual(['video 0 container-no-video', 'audio 2 container-one-audio', 'audio 3 container-one-audio'])
    expect(argAfter(args, '-filter_complex')).toContain(downmixStage('standard', '5.1', null)?.stage)
  })

  it('refuses a 5.1 stream for MP3 without a downmix instead of folding it silently', () =>
  {
    const { issues } = convert(recipe({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }))
    expect(issues).toEqual(['too-many-channels: MP3 holds at most 2 channels; audio stream 1 has 6.'])
  })

  it('keeps all audio streams for m4a, which accepts many', () =>
  {
    const { args } = convert(recipe({ container: 'm4a', video: null }))
    expect(maps(args)).toEqual(['[a0]', '[a1]', '[a2]'])
  })

  it('maps no subtitles when the recipe drops them, and still maps every audio stream explicitly', () =>
  {
    const { args, streams } = convert(recipe({ subtitles: 'drop' }), movie({ subtitles: [SUBRIP] }))
    expect(maps(args)).toEqual(['0:0', '[a0]', '[a1]', '[a2]'])
    expect(streams.dropped).toEqual([{ kind: 'subtitle', source: 4, reason: 'policy' }])
  })

  it('still maps audio for an audio-only source', () =>
  {
    const flac = movie({ path: '/media/song.flac', container: 'flac', video: [], audio: [audio(0, 0, { codecName: 'flac', sampleRate: 44100, bitRate: null })] })
    const { args } = convert(recipe({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } }), flac)
    expect(maps(args)).toEqual(['[a0]'])
  })
})

describe('buildConvertArgs: the command', () =>
{
  it('writes with -n to the work path, naming the muxer with -f', () =>
  {
    const { args } = convert(recipe({ container: 'mkv' }))
    expect(args[0]).toBe('-n')
    expect(args.slice(-3)).toEqual(['-f', 'matroska', '/w/out-e1.part'])
    expect(args.filter((arg) => arg === '-f')).toHaveLength(1)
  })

  it('encodes the picture with its FrameFit chain and copies cover art beside it', () =>
  {
    const fit: FrameFit = { maxWidth: 1280, maxHeight: 720, mode: 'fit' }
    const f = movie({ video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 5, codecName: 'mjpeg', cover: true }] })
    const { args, video } = convert(recipe({ video: { encoder: 'libx264', bitrateKbps: 1500, fit, fps: 30, pixelFormat: 'yuv420p' } }), f)
    const filters = [...frameFitFilters(fit), 'fps=30', 'format=yuv420p']
    expect(video).toEqual({ encoder: 'libx264', filters })
    expect(args).toEqual(expect.arrayContaining(['-c:v:0', 'libx264', '-b:v:0', '1500k', '-filter:v:0', filters.join(','), '-c:v:1', 'copy']))
    expect(args).not.toContain('-c:v')
    expect(args).not.toContain('-filter:v:1')
  })

  it('copies the video with one -c:v copy when the recipe copies it', () =>
  {
    const { args, video } = convert(recipe({ container: 'mkv', video: { encoder: 'copy', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } }))
    expect(video).toBeNull()
    expect(argAfter(args, '-c:v')).toBe('copy')
    expect(args.some((arg) => arg.startsWith('-filter:v'))).toBe(false)
  })

  it('runs a leased hardware encoder with the recipe bitrate and the FrameFit, without the pixel format', () =>
  {
    const fit: FrameFit = { maxWidth: 1920, maxHeight: 1080, mode: 'fit' }
    const { args, video } = convert(recipe({ video: { encoder: 'libx264', bitrateKbps: 8000, fit, fps: null, pixelFormat: 'yuv420p' } }), movie(), 'h264_nvenc')
    expect(video).toEqual({ encoder: 'h264_nvenc', filters: frameFitFilters(fit) })
    expect(args).toEqual(expect.arrayContaining(['-c:v:0', 'h264_nvenc', '-b:v:0', '8000k', '-filter:v:0', frameFitFilters(fit).join(',')]))
    const quality = convert(recipe({ video: { encoder: 'libx264', bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' } }), movie(), 'h264_nvenc')
    expect(quality.args).toEqual(expect.arrayContaining(['-c:v:0', 'h264_nvenc']))
    expect(quality.args.some((arg) => arg.startsWith('-b:v') || arg.startsWith('-filter:v'))).toBe(false)
  })

  it('copies audio by index when the recipe copies it, with no graph', () =>
  {
    const { args } = convert(recipe({ container: 'mkv', audio: { kind: 'copy' } }))
    expect(args).not.toContain('-filter_complex')
    expect(maps(args)).toEqual(['0:0', '0:1', '0:2', '0:3'])
    expect(args).toEqual(expect.arrayContaining(['-c:a:0', 'copy', '-c:a:1', 'copy', '-c:a:2', 'copy']))
  })

  it('counts the streams the plan keeps, cover art as video', () =>
  {
    const f = movie({ video: [{ streamIndex: 0, codecName: 'h264', cover: false }, { streamIndex: 5, codecName: 'mjpeg', cover: true }], subtitles: [SUBRIP] })
    expect(plannedCounts(convert(recipe(), f).streams)).toEqual({ video: 2, audio: 3, subtitle: 1, attachment: 0 })
    expect(plannedCounts({ kept: [{ kind: 'attachment', source: 9, output: 0, action: 'copy' }, { kind: 'data', source: 8, output: 1, action: 'copy' }] }))
      .toEqual({ video: 0, audio: 0, subtitle: 0, attachment: 1 })
  })
})

describe('channelStages', () =>
{
  const surround = audio(0, 1, { channels: 6, layout: '5.1' })

  it('downmixes more than two channels to stereo through the standard downmix', () =>
  {
    const folded = channelStages('stereo', surround, null)
    const downmix = downmixStage('standard', '5.1', null)
    expect(folded).toMatchObject({ channels: 2, layout: 'stereo', coefficients: downmix?.coefficients })
    expect(folded?.stages).toContain(downmix?.stage)
  })

  it('folds to mono through the mono fold, after the standard downmix for surround', () =>
  {
    expect(channelStages('mono', audio(0, 1), null)).toEqual({ ...monoFoldStage('stereo', null), channels: 1, layout: 'mono' })
    expect(channelStages('mono', surround, null)).toEqual({ ...monoFoldStage('5.1', null), channels: 1, layout: 'mono' })
  })

  it('takes the stream levels an AC-3 stream carries', () =>
  {
    const levels = { centerLoRo: 0.5, surroundLoRo: 0.5, preferred: 'Lo/Ro' as const }
    const folded = channelStages('stereo', audio(0, 1, { codecName: 'ac3', channels: 6, layout: '5.1(side)' }), levels)
    expect(folded?.coefficients).toBe('stream-metadata')
    expect(folded?.stages).toContain(downmixStage('standard', '5.1(side)', levels)?.stage)
  })

  it('adds nothing when the channels already fit the rule', () =>
  {
    expect(channelStages('keep', surround, null)).toEqual({ stages: [], channels: 6, layout: '5.1', coefficients: null })
    expect(channelStages('stereo', audio(0, 1), null)).toEqual({ stages: [], channels: 2, layout: 'stereo', coefficients: null })
    expect(channelStages('mono', audio(0, 1, { channels: 1, layout: 'mono' }), null)).toEqual({ stages: [], channels: 1, layout: 'mono', coefficients: null })
  })

  it('has no stages for a layout without a downmix', () =>
  {
    const odd = audio(0, 1, { channels: 16, layout: 'hexadecagonal' })
    expect(channelStages('stereo', odd, null)).toBeNull()
    expect(channelStages('mono', odd, null)).toBeNull()
  })
})

describe('planConvertAudio', () =>
{
  function plan(r: Partial<ConvertRecipe>, f: MediaFacts = movie(), caps: BuildCapabilities = CAPS, levels = new Map())
  {
    const full = recipe(r)
    const container = containerFor(full.container)
    return planConvertAudio(full, f, container, caps, levels, container.video)
  }

  it('pins every encoded stream to its encoder rate, layout, and sample format after the channel stages', () =>
  {
    const { streams, issues } = plan({ container: 'm4a', video: null, channels: 'mono' })
    expect(issues).toEqual([])
    expect(streams).toHaveLength(3)
    for (const s of streams)
    {
      const choice = s.output.choice
      expect(choice?.layout).toBe('mono')
      const pin = pinStages({ sampleRate: choice?.sampleRate ?? 0, layout: 'mono', pin: choice?.pin ?? 'encoder', encoder: choice?.encoder ?? '' })
      expect(s.part?.stages.slice(-pin.length)).toEqual(pin)
      expect(s.part?.stages.slice(0, -pin.length)).toEqual(monoFoldStage(s.source.layout ?? '', null)?.stages)
      expect(s.part?.input).toBe(`0:a:${s.source.audioIndex}`)
      expect(s.output.label).toBe(`[a${s.output.outIndex}]`)
    }
  })

  it('reads the levels of AC-3 and E-AC-3 streams it folds, and of nothing else', () =>
  {
    const f = movie({ audio: [audio(0, 1, { codecName: 'ac3', channels: 6, layout: '5.1(side)' }), audio(1, 2, { codecName: 'eac3' }), audio(2, 3, { channels: 6, layout: '5.1' })] })
    expect(plan({ container: 'mkv', channels: 'stereo' }, f).streams.map((s) => s.readsLevels)).toEqual([true, false, false])
    expect(plan({ container: 'mkv', channels: 'keep' }, f).streams.map((s) => s.readsLevels)).toEqual([false, false, false])
  })

  it('copies every kept stream untouched when the recipe copies audio', () =>
  {
    const { streams, issues } = plan({ container: 'mkv', audio: { kind: 'copy' } })
    expect(issues).toEqual([])
    expect(streams.map((s) => [s.output.label, s.output.choice, s.part])).toEqual([[null, null, null], [null, null, null], [null, null, null]])
  })

  it('writes WMA only into .wma, .wmv, and .asf', () =>
  {
    const wma = { kind: 'codec' as const, codec: 'wmav2' as const, kbpsPerPair: 192 }
    const stereo = movie({ audio: [audio(0, 1)] })
    for (const container of ['wma', 'wmv', 'asf'])
    {
      const { streams, issues } = plan({ container, video: null, audio: wma }, stereo)
      expect(issues, container).toEqual([])
      expect(streams[0].output.choice?.encoder).toBe('wmav2')
    }
    for (const container of ['mkv', 'mka', 'mp4'])
    {
      const { streams, issues } = plan({ container, video: null, audio: wma }, stereo)
      expect(streams, container).toEqual([])
      expect(issues.map((issue) => issue.code), container).toEqual(['container-cannot-hold'])
    }
    const inherited = plan({ container: 'mkv', video: null, audio: { kind: 'same-as-source' } }, movie({ audio: [audio(0, 1, { codecName: 'wmav2' })] }))
    expect(inherited.issues.map((issue) => `${issue.code}: ${issue.message}`)).toEqual([`container-cannot-hold: ${containerLabel('mkv')} cannot hold WMA audio.`])
  })

  it('refuses a container change, a missing encoder, and a layout without a downmix', () =>
  {
    const vorbis = plan({ audio: { kind: 'codec', codec: 'vorbis', kbpsPerPair: 160 } })
    expect(vorbis.issues.map((issue) => `${issue.code} ${issue.field}`)).toEqual(['container-cannot-hold container', 'container-cannot-hold container', 'container-cannot-hold container'])
    expect(vorbis.issues[0].message).toBe('MP4 cannot hold Vorbis audio.')
    const noOpus = plan({ container: 'mkv', audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 96 } }, movie({ audio: [audio(0, 1)] }),
      { ...CAPS, encoders: new Set([...CAPS.encoders].filter((e) => e !== 'libopus')) })
    expect(noOpus.issues.map((issue) => `${issue.code} ${issue.field} ${issue.severity}`)).toEqual(['encoder-missing encoder error'])
    expect(noOpus.issues[0].message).toBe('This FFmpeg build has no encoder for audio stream 1 (Opus).')
    const wide = plan({ container: 'mkv', channels: 'stereo' }, movie({ audio: [audio(0, 1, { channels: 16, layout: 'hexadecagonal' })] }))
    expect(wide.issues.map((issue) => `${issue.code}: ${issue.message}`)).toEqual(['layout-unsupported: Audio stream 1 has the hexadecagonal layout, which has no stereo downmix.'])
  })
})

describe('audioEncoderLabel', () =>
{
  it('names encoders by the codec people know', () =>
  {
    expect(['libmp3lame', 'libopus', 'libvorbis', 'wmav1', 'pcm_s24le', 'aac', 'eac3', 'truehd'].map(audioEncoderLabel))
      .toEqual(['MP3', 'Opus', 'Vorbis', 'WMA', 'PCM', 'AAC', 'E-AC-3', 'TRUEHD'])
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

function planInput(r: ConvertRecipe, f: MediaFacts = movie(), over: Partial<PlanInput<ConvertRecipe>> = {}): PlanInput<ConvertRecipe>
{
  return { recipe: r, source: SOURCE, facts: f, caps: CAPS, output: output({ container: r.container, muxer: MUXERS[r.container] }), platform: 'linux', ...over }
}

describe('planConvert', () =>
{
  it('plans the command as it runs, with the work path as a placeholder', () =>
  {
    const r = recipe({ container: 'mkv' })
    const plan = planConvert(planInput(r))
    const direct = convert(r)
    expect(plan.command?.argv).toEqual(execArgv([...direct.args.slice(0, -1), OUTPUT_PLACEHOLDER], 'kill'))
    expect(plan.command?.placeholders).toEqual([OUTPUT_PLACEHOLDER])
    expect(plan.command?.display.startsWith('ffmpeg -hide_banner -nostdin')).toBe(true)
    expect(plan.stages).toEqual([{ id: 'probe', passes: 1 }, { id: 'encode', passes: 1 }, { id: 'verify', passes: 1 }])
    expect(plan.class).toBe('video-cpu')
    expect(plan.video).toEqual({ encoder: 'libx264', gpu: null, lossless: 'not-requested', passes: 1, filters: [EVEN_CROP, 'format=yuv420p'], notes: [], cpuFallback: null })
    expect(plan.audio).toEqual([])
    expect(plan.streams.kept.map((s) => `${s.kind} ${s.source}>${s.output} ${s.action}`)).toEqual(['video 0>0 copy', 'audio 1>1 encode', 'audio 2>2 encode', 'audio 3>3 encode'])
    expect(plan.issues).toEqual([])
  })

  it('writes a placeholder where the levels of a folded AC-3 stream are read at run time', () =>
  {
    const f = movie({ audio: [audio(0, 1, { codecName: 'ac3', channels: 6, layout: '5.1(side)' })] })
    const plan = planConvert(planInput(recipe({ container: 'mkv', channels: 'stereo' }), f))
    expect(plan.command?.placeholders).toEqual([OUTPUT_PLACEHOLDER, levelsPlaceholder(0)])
    const graph = argAfter(plan.command?.argv ?? [], '-filter_complex') ?? ''
    expect(graph).toContain(levelsPlaceholder(0))
    expect(graph).not.toContain(downmixStage('standard', '5.1(side)', null)?.stage)
  })

  it('classes remuxes, audio-only encodes, and picture encodes', () =>
  {
    const copyVideo = { encoder: 'copy' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' as const }
    expect(planConvert(planInput(recipe({ container: 'mkv', video: copyVideo, audio: { kind: 'copy' } }))).class).toBe('copy')
    expect(planConvert(planInput(recipe({ container: 'mkv', video: copyVideo }))).class).toBe('audio')
    expect(planConvert(planInput(recipe({ container: 'mkv', video: copyVideo }))).video?.encoder).toBe('copy')
    expect(planConvert(planInput(recipe({ container: 'm4a', video: null }))).video).toBeNull()
  })

  it('estimates bitrate times duration when every rate is known, else the source size', () =>
  {
    expect(planConvert(planInput(recipe({ container: 'mkv' }))).estimate).toEqual({ outputBytes: Math.round((5000 + 3 * 128 + 128 + 128) * 125 * 120), workSec: null, confidence: 'medium' })
    const copyVideo = { encoder: 'copy' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' as const }
    expect(planConvert(planInput(recipe({ container: 'mkv', video: copyVideo }))).estimate).toEqual({ outputBytes: SOURCE.size, workSec: null, confidence: 'low' })
    const copyAudio = planConvert(planInput(recipe({ container: 'm4a', video: null, audio: { kind: 'copy' } })))
    expect(copyAudio.estimate).toEqual({ outputBytes: Math.round(3 * 192 * 125 * 120), workSec: null, confidence: 'medium' })
    expect(planConvert(planInput(recipe({ container: 'mkv' }), movie({ durationSec: Number.NaN }))).estimate.confidence).toBe('low')
  })

  it('refuses a missing video encoder and a container that cannot hold the codec', () =>
  {
    const hevc = { encoder: 'libx265' as const, bitrateKbps: 4000, fit: null, fps: null, pixelFormat: 'yuv420p' as const }
    const noX265 = { ...CAPS, encoders: new Set([...CAPS.encoders].filter((e) => e !== 'libx265')) }
    expect(planConvert(planInput(recipe({ container: 'mkv', video: hevc }), movie(), { caps: noX265 })).issues.map((i) => `${i.code} ${i.field}: ${i.message}`))
      .toEqual(['encoder-missing encoder: This FFmpeg build has no HEVC encoder (libx265).'])
    const theora = { encoder: 'libtheora' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'yuv420p' as const }
    const inMp4 = planConvert(planInput(recipe({ video: theora }), movie(), { caps: { ...CAPS, encoders: new Set([...CAPS.encoders, 'libtheora']) } }))
    expect(inMp4.issues.map((i) => `${i.code} ${i.severity}`)).toEqual(['container-cannot-hold error'])
    expect(inMp4.issues[0].message).toBe(videoEncoderFit('libtheora', 'mp4')?.reason)
    const copyVideo = { encoder: 'copy' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' as const }
    const h264InWebm = planConvert(planInput(recipe({ container: 'webm', video: copyVideo, audio: { kind: 'codec', codec: 'opus', kbpsPerPair: 96 } })))
    expect(h264InWebm.issues.map((i) => `${i.code}: ${i.message}`)).toEqual([`container-cannot-hold: ${codecFit('h264', 'webm')?.reason}`])
  })

  it('reports dropped streams and chapters as info, grouped by kind and reason', () =>
  {
    const f = movie({ subtitles: [PGS, { ...PGS, streamIndex: 5, subIndex: 1 }], data: [{ streamIndex: 6, codecName: 'bin_data' }], chapters: 3 })
    const plan = planConvert(planInput(recipe({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 }, channels: 'stereo' }), f))
    expect(plan.issues.map((i) => `${i.code} ${i.severity}: ${i.message}`)).toEqual([
      'streams-dropped info: 1 video stream dropped: MP3 holds no video.',
      'streams-dropped info: 2 audio streams dropped: MP3 holds one audio stream.',
      'streams-dropped info: 2 subtitle streams dropped: MP3 cannot hold these subtitles.',
      'streams-dropped info: 1 data stream dropped: data streams are not kept.'
    ])
    const mp4 = planConvert(planInput(recipe(), movie({ subtitles: [PGS], attachments: [{ streamIndex: 7, filename: 'font.ttf', mimetype: 'font/ttf' }] })))
    expect(mp4.issues.map((i) => i.message)).toEqual([
      '1 subtitle stream dropped: MP4 cannot hold bitmap subtitles.',
      '1 attachment dropped: MP4 cannot hold attachments.'
    ])
    const wav = planConvert(planInput(recipe({ container: 'wav', video: null, audio: { kind: 'codec', codec: 'pcm', kbpsPerPair: null }, channels: 'stereo' }), movie({ chapters: 2 })))
    expect(wav.issues.map((i) => `${i.code}: ${i.message}`)).toContain('chapters-dropped: WAV cannot hold chapters, so they are dropped.')
  })
})

describe('streamIssues', () =>
{
  it('names every drop reason and leaves out audio the job refused', () =>
  {
    const reasons: Array<[StreamKind, DropReason]> = [['cover', 'cover-unsupported'], ['subtitle', 'policy'], ['audio', 'policy']]
    const issues = streamIssues({ dropped: reasons.map(([kind, reason], source) => ({ kind, source, reason })), chapters: 'kept' }, containerFor('webm'))
    expect(issues.map((i) => i.message)).toEqual(['1 cover image dropped: WebM cannot hold cover art.', '1 subtitle stream dropped: the recipe drops them.'])
  })
})

describe('ffmpegCause', () =>
{
  it('sorts FFmpeg failures into encoder, muxer, decode, and other', () =>
  {
    expect(ffmpegCause('[vost#0:0/libx264] [enc:libx264] Error while opening encoder - maybe incorrect parameters')).toBe('encoder')
    expect(ffmpegCause('Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0')).toBe('encoder')
    expect(ffmpegCause('[libx265] Cannot open libx265 encoder.')).toBe('encoder')
    expect(ffmpegCause("[mp4] Could not find tag for codec theora in stream #0, codec not currently supported in container")).toBe('muxer')
    expect(ffmpegCause('Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument')).toBe('muxer')
    expect(ffmpegCause('/media/movie.mkv: Invalid data found when processing input')).toBe('decode')
    expect(ffmpegCause('Conversion failed!')).toBe('other')
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

type StepKind = 'levels' | 'encode' | 'decode'

function stepKind(args: readonly string[]): StepKind
{
  if (args.includes('ashowinfo'))
  {
    return 'levels'
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

function harness(o: { steps?: Partial<Record<StepKind, Step>>; source?: MediaFacts; output?: MediaFacts | Error; gpu?: GpuLease | null; onProbe?(file: string): void } = {}): Harness
{
  const exec = scriptedExec(o.steps)
  const controller = new AbortController()
  const stages: string[] = []
  const progress: Harness['progress'] = []
  const logs: string[] = []
  const probes: string[] = []
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
    gpu: o.gpu ?? null,
    album: null,
    cache: { get: () => null, set: () => undefined },
    async probe(file)
    {
      probes.push(file)
      o.onProbe?.(file)
      if (file === SOURCE.path)
      {
        return o.source ?? movie()
      }
      if (o.output instanceof Error)
      {
        throw o.output
      }
      return o.output ?? movie({ path: file, container: 'mkv' })
    },
    output: (ext, encodePass) => `${WORK}/out-e${encodePass}.${ext}.part`,
    outputFolder: (name) => `${WORK}/${name}.part`,
    stage: (s) => stages.push(`${s.id} ${s.pass}/${s.passes} ${s.label}`),
    progress: (p) => progress.push(p),
    measured: () => undefined,
    log,
    now: () => 1234
  }
  return { ctx, exec, controller, stages, progress, logs, probes }
}

function job(r: ConvertRecipe, over: Partial<OutputPlan> = {}): RunnableJob<ConvertRecipe>
{
  const planned = planConvert(planInput(r))
  const plan: JobPlan =
  {
    basis: { inputsRev: 1, policyRev: 1, capabilitiesRev: 1 },
    fingerprint: 'fp',
    source: { path: SOURCE.path, size: SOURCE.size, mtimeMs: SOURCE.mtimeMs },
    output: output({ container: r.container, muxer: MUXERS[r.container], ...over }),
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
    { rev: 1, destination: { mode: 'next-to-source' }, template: '{name}', conflict: 'rename', displaced: 'trash', gpu: 'off', frozenAt: 1, date: '2026-10-17' }
  return { id: 'J1' as JobId, recipe: r, plan, policy, source: SOURCE, attempt: 2 }
}

const absent = { exists: async () => false, verifyVideo: () => 'full' as const, platform: 'linux' as const, files: { size: async () => 1000, text: async () => '', list: async () => [] } }

describe('runConvert', () =>
{
  it('probes, encodes into the work path with -f, verifies there, and returns the artifact', async () =>
  {
    const h = harness({ steps: { encode: { lines: ['frame=1'], progress: [{ outTimeSec: 60, speed: 2, totalSize: 5000, end: false }] } } })
    const checked: string[] = []
    const runner = createConvertRunner({ ...absent, exists: async (file) => { checked.push(file); return false } })
    expect(runner.kind).toBe('convert')
    expect(runner.plan).toBe(planConvert)
    const outcome = await runner.run(job(recipe({ container: 'mkv' })), h.ctx)
    const out = `${WORK}/out-e1.mkv.part`
    expect(h.stages).toEqual(['probe 1/1 Reading the source', 'encode 1/1 Converting', 'verify 1/1 Verifying'])
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
      artifact: { kind: 'file', path: out, container: 'mkv', bytes: 1000, durationSec: 120, encoder: { video: 'libx264', audio: ['aac', 'aac', 'aac'] } },
      verification: { verdict: 'verified', encodePasses: 1, audio: null },
      measurement: null,
      notes: []
    })
  })

  it('names copied streams as copy in the artifact', async () =>
  {
    const h = harness()
    const copyVideo = { encoder: 'copy' as const, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' as const }
    const outcome = await runConvert(job(recipe({ container: 'mkv', video: copyVideo, audio: { kind: 'copy' } })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'output', artifact: { encoder: { video: 'copy', audio: ['copy', 'copy', 'copy'] } } })
    const audioOnly = harness({ output: movie({ video: [], audio: [audio(0, 0), audio(1, 1), audio(2, 2)] }) })
    const m4a = await runConvert(job(recipe({ container: 'm4a', video: null })), audioOnly.ctx, absent)
    expect(m4a).toMatchObject({ kind: 'output', artifact: { encoder: { video: null } } })
  })

  it('checks the work path is absent before the spawn and writes nothing over it', async () =>
  {
    for (const exists of [async () => true, async () => { throw new Error('EPERM') }])
    {
      const h = harness()
      const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, { ...absent, exists })
      expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal', short: 'Work file exists', stage: 'encode', attempt: 2, encodePass: 1, at: 1234 } })
      expect(h.exec.calls.filter((c) => c.kind === 'encode')).toEqual([])
    }
  })

  it('fails a run whose output FFmpeg refused as existing, even with exit 0', async () =>
  {
    const h = harness({ steps: { encode: { code: 0, outputRefused: true, lines: ["File '/x' already exists. Exiting."] } } })
    const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'internal', short: 'Work file exists' } })
    expect(h.exec.calls.filter((c) => c.kind === 'decode')).toEqual([])
  })

  it('returns aborted, never a failure, wherever the signal aborts', async () =>
  {
    const before = harness()
    before.controller.abort()
    expect(await runConvert(job(recipe({ container: 'mkv' })), before.ctx, absent)).toEqual({ kind: 'aborted' })
    expect(before.exec.calls).toEqual([])

    const probing = harness({ onProbe: () => probing.controller.abort() })
    expect(await runConvert(job(recipe({ container: 'mkv' })), probing.ctx, absent)).toEqual({ kind: 'aborted' })

    const failingProbe = harness({ source: undefined, onProbe: () => { failingProbe.controller.abort(); throw new Error('gone') } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), failingProbe.ctx, absent)).toEqual({ kind: 'aborted' })

    const checking = harness()
    const exists = async () => { checking.controller.abort(); return false }
    expect(await runConvert(job(recipe({ container: 'mkv' })), checking.ctx, { ...absent, exists })).toEqual({ kind: 'aborted' })

    const encoding = harness({ steps: { encode: { aborted: true, code: null, signal: 'SIGTERM' } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), encoding.ctx, absent)).toEqual({ kind: 'aborted' })

    const spawning = harness({ steps: { encode: { onRun: () => spawning.controller.abort(), throws: new Error('spawn') } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), spawning.ctx, absent)).toEqual({ kind: 'aborted' })

    const verifying = harness({ steps: { decode: { onRun: () => verifying.controller.abort(), aborted: true } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), verifying.ctx, absent)).toEqual({ kind: 'aborted' })
  })

  it('fails with probe-failed when the source cannot be read', async () =>
  {
    const h = harness({ onProbe: () => { throw new Error('moov atom not found') } })
    const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'probe-failed', stage: 'probe', encodePass: null, message: 'The source could not be read: moov atom not found', command: null } })
  })

  it('refuses before FFmpeg runs when the source no longer fits the recipe', async () =>
  {
    const h = harness()
    const r = recipe({ container: 'mp3', video: null, audio: { kind: 'codec', codec: 'mp3', kbpsPerPair: 320 } })
    const outcome = await runConvert(job(r), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'plan-refused', short: 'Plan refused', message: 'MP3 holds at most 2 channels; audio stream 1 has 6.' } })
    expect(h.exec.calls).toEqual([])
  })

  it('classifies a failed encode and keeps its command, exit, and stderr tail', async () =>
  {
    const lines = ['[libx264 @ 0x1] width not divisible by 2 (321x241)', '[vost#0:0/libx264] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height']
    const h = harness({ steps: { encode: { code: -22, lines } } })
    const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
    expect(outcome.kind).toBe('failed')
    const error = (outcome as Extract<RunOutcome, { kind: 'failed' }>).error
    expect(error).toMatchObject({ code: 'ffmpeg-failed', short: 'Encoder failed', cause: 'encoder', stage: 'encode', exitCode: -22, exitName: 'EINVAL', signal: null, hint: null, fsError: null })
    expect(error.message).toBe(`The encoder could not start: ${lines[1]}`)
    expect(error.stderrTail).toBe(lines.join('\n'))
    expect(error.command?.argv.slice(0, 7)).toEqual(execArgv([], 'kill'))
    expect(error.command?.argv.slice(-3)).toEqual(['-f', 'matroska', `${WORK}/out-e1.mkv.part`])
    expect(error.command?.display.startsWith('ffmpeg -hide_banner')).toBe(true)
  })

  it('names a stopped or silent failure by its signal or exit code', async () =>
  {
    const killed = harness({ steps: { encode: { code: null, signal: 'SIGKILL' } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), killed.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { code: 'ffmpeg-failed', cause: 'other', message: 'FFmpeg could not convert this file: FFmpeg was stopped by SIGKILL.' } })
    const silent = harness({ steps: { encode: { code: 1 } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), silent.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { message: 'FFmpeg could not convert this file: FFmpeg ended with exit code 1 (EINVAL).' } })
    const unnamed = harness({ steps: { encode: { code: 1 } } })
    const run = unnamed.exec.run.bind(unnamed.exec)
    unnamed.ctx = { ...unnamed.ctx, exec: { run: async (args, o) => ({ ...(await run(args, o)), exitName: null }) } }
    expect(await runConvert(job(recipe({ container: 'mkv' })), unnamed.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { message: 'FFmpeg could not convert this file: FFmpeg ended with exit code 1.' } })
  })

  it('reports a full disk, and the GPU failures the lease recognizes', async () =>
  {
    const disk = harness({ steps: { encode: { code: -28, lines: ['av_interleaved_write_frame(): No space left on device'] } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), disk.ctx, absent)).toMatchObject({ kind: 'failed', error: { code: 'disk-full', short: 'Disk full' } })
    for (const [verdict, code] of [['session-limit', 'gpu-session-limit'], ['init-failed', 'gpu-init-failed'], [null, 'ffmpeg-failed']] as const)
    {
      const gpu: GpuLease = { encoder: 'h264_nvenc', classify: () => verdict }
      const h = harness({ gpu, steps: { encode: { code: -40, lines: ['OpenEncodeSessionEx failed: out of memory (10)'] } } })
      const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
      expect(outcome, String(verdict)).toMatchObject({ kind: 'failed', error: { code } })
      expect(h.exec.calls.find((c) => c.kind === 'encode')?.args).toEqual(expect.arrayContaining(['-c:v:0', 'h264_nvenc']))
    }
  })

  it('fails with ffmpeg-unavailable when FFmpeg cannot be spawned', async () =>
  {
    const h = harness({ steps: { encode: { throws: new Error('spawn ENOENT') } } })
    expect(await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent))
      .toMatchObject({ kind: 'failed', error: { code: 'ffmpeg-unavailable', message: 'FFmpeg could not be started: spawn ENOENT' } })
  })

  it('fails the run with the verification error when the output does not verify', async () =>
  {
    const h = harness({ steps: { decode: { lines: ['[h264 @ 0x2] error while decoding MB 4 5'] } } })
    const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'decode-errors', stage: 'verify', attempt: 2, encodePass: 1, at: 1234 } })
    const missing = harness({ output: movie({ audio: [audio(0, 1)] }) })
    expect(await runConvert(job(recipe({ container: 'mkv' })), missing.ctx, absent)).toMatchObject({ kind: 'failed', error: { code: 'output-unreadable', short: 'Streams missing' } })
  })

  it('keeps an output outside the duration tolerance for the engine to decide', async () =>
  {
    const h = harness({ output: movie({ durationSec: 100 }) })
    const outcome = await runConvert(job(recipe({ container: 'mkv' })), h.ctx, absent)
    expect(outcome).toMatchObject({ kind: 'output', verification: { verdict: 'outside-tolerance', media: { duration: 'outside', durationSec: 100, expectedDurationSec: 120 } } })
    const unknown = harness({ source: movie({ durationSec: Number.NaN }) })
    const noSpan = await runConvert(job(recipe({ container: 'mkv' })), unknown.ctx, absent)
    expect(noSpan).toMatchObject({ kind: 'output', verification: { media: { duration: 'not-checked' } } })
    expect(unknown.exec.calls.find((c) => c.kind === 'encode')?.o.durationSec).toBeUndefined()
  })

  it('samples the decode check only when the setting asks and the placement displaces nothing', async () =>
  {
    const sampled = { ...absent, verifyVideo: () => 'sampled' as const }
    const cases: Array<[Partial<OutputPlan>, 'full' | 'sampled']> = [
      [{}, 'sampled'],
      [{ resolution: 'overwrite', displaces: '/out/movie.mkv' }, 'full'],
      [{ resolution: 'replace-original', displaces: SOURCE.path }, 'full'],
      [{ resolution: 'overwrite' }, 'full']
    ]
    for (const [over, decode] of cases)
    {
      const h = harness()
      const outcome = await runConvert(job(recipe({ container: 'mkv' }), over), h.ctx, sampled)
      expect(outcome, JSON.stringify(over)).toMatchObject({ kind: 'output', verification: { media: { decode } } })
      expect(h.exec.calls.find((c) => c.kind === 'decode')?.args.includes('-ss')).toBe(decode === 'sampled')
    }
  })

  it('reads the downmix levels of a folded AC-3 stream and writes its own coefficients', async () =>
  {
    const ac3 = movie({ audio: [audio(0, 1, { codecName: 'ac3', channels: 6, layout: '5.1(side)' })] })
    const side = 'side data - downmix: preferred downmix type - Lo/Ro Mix levels: center 0.500000 (0.707107 ltrt) - surround 0.500000 (0.707107 ltrt)'
    const levels = parseDownmixInfo(side)
    expect(levels).not.toBeNull()
    const h = harness({ source: ac3, output: movie({ audio: [audio(0, 1)] }), steps: { levels: { lines: ['Stream #0:1: Audio: ac3', side] } } })
    const outcome = await runConvert(job(recipe({ container: 'mkv', channels: 'stereo' })), h.ctx, absent)
    expect(outcome.kind).toBe('output')
    const read = h.exec.calls.find((c) => c.kind === 'levels')
    expect(read?.args).toEqual(buildDownmixProbeArgs(SOURCE.path, 0))
    const graph = argAfter(h.exec.calls.find((c) => c.kind === 'encode')?.args ?? [], '-filter_complex') ?? ''
    expect(graph).toContain(downmixStage('standard', '5.1(side)', levels)?.stage)
    expect(graph).not.toContain(levelsPlaceholder(0))
  })

  it('takes BS.775-4 when the levels cannot be read, and stops when the read aborts', async () =>
  {
    const ac3 = movie({ audio: [audio(0, 1, { codecName: 'ac3', channels: 6, layout: '5.1(side)' })] })
    const bs775 = downmixStage('standard', '5.1(side)', null)?.stage
    for (const step of [{ throws: new Error('spawn') }, { code: 1 }, { lines: ['no side data'] }])
    {
      const h = harness({ source: ac3, output: movie({ audio: [audio(0, 1)] }), steps: { levels: step } })
      const outcome = await runConvert(job(recipe({ container: 'mkv', channels: 'stereo' })), h.ctx, absent)
      expect(outcome.kind).toBe('output')
      expect(argAfter(h.exec.calls.find((c) => c.kind === 'encode')?.args ?? [], '-filter_complex')).toContain(bs775)
      expect(h.logs.some((l) => l.startsWith('warn Reading the downmix levels of audio stream 1 failed'))).toBe('throws' in step)
    }
    const aborted = harness({ source: ac3, steps: { levels: { aborted: true } } })
    expect(await runConvert(job(recipe({ container: 'mkv', channels: 'stereo' })), aborted.ctx, absent)).toEqual({ kind: 'aborted' })
    const thrown = harness({ source: ac3, steps: { levels: { onRun: () => thrown.controller.abort(), throws: new Error('killed') } } })
    expect(await runConvert(job(recipe({ container: 'mkv', channels: 'stereo' })), thrown.ctx, absent)).toEqual({ kind: 'aborted' })
    expect(thrown.exec.calls.filter((c) => c.kind === 'encode')).toEqual([])
  })
})

describe('pathExists', () =>
{
  it('reports a present file, an absent one, and treats an unreadable answer as present', async () =>
  {
    const dir = mkdtempSync(join(tmpdir(), 'convert-'))
    try
    {
      const file = join(dir, 'out-e1.mkv.part')
      writeFileSync(file, '')
      expect(await pathExists(file)).toBe(true)
      expect(await pathExists(join(dir, 'missing.part'))).toBe(false)
      const spy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
      expect(await pathExists(file)).toBe(true)
      spy.mockRestore()
    }
    finally
    {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
