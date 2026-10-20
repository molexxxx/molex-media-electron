/**
 * The encoder of one output stream. The same-as-source table row by row, the bitrate ladders, floors, and
 * defaults per channel pair, the channel, layout, and sample-rate limits measured on both builds, the
 * minimum-rate raise with the caps applied after it, container changes and refusals, the per-stream
 * encoder arguments, and the fallbacks when a build lacks an encoder. An experimental encoder is never
 * chosen and -strict is never written.
 */
import { describe, it, expect } from 'vitest'
import { ENCODER_LIMITS, chooseEncoder, encoderArgs, isLosslessSource } from '../../../src/main/ffmpeg/audio/encoders'
import type { BuildCapabilities, EncoderDecision, EncoderOutput } from '../../../src/main/ffmpeg/audio/encoders'
import { toMediaFacts } from '../../../src/main/ffmpeg/audio/facts'
import type { AudioFacts, EncoderChoice, EncoderNote, EncoderPolicy, OutputCodec } from '../../../src/shared/audio/types'
import { CODEC_MAX_CHANNELS } from '../../../src/shared/jobs/applicability'
import { PROBE_BUILDS, recordedProbe } from '../fixtures/ffmpeg/probe/corpus'

const EXPERIMENTAL = ['dca', 'mlp', 'opus', 's302m', 'sonic', 'sonicls', 'truehd', 'vorbis']

/** The audio encoders both builds list, with the native ones flagged experimental (A..X.. in -encoders). */
const CAPS: BuildCapabilities =
{
  encoders: new Set([
    'aac', 'ac3', 'alac', 'eac3', 'flac', 'mp2', 'libmp3lame', 'libopus', 'libvorbis', 'tta', 'wavpack', 'wmav2',
    'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_f32be', ...EXPERIMENTAL
  ]),
  experimental: new Set(EXPERIMENTAL),
  soxr: true
}

const INHERIT: EncoderPolicy = { kind: 'same-as-source' }

function without(...missing: string[]): BuildCapabilities
{
  return { ...CAPS, encoders: new Set([...CAPS.encoders].filter((name) => !missing.includes(name))) }
}

function codec(name: OutputCodec, kbpsPerPair: number | null = null): EncoderPolicy
{
  return { kind: 'codec', codec: name, kbpsPerPair }
}

function stream(over: Partial<AudioFacts> = {}): AudioFacts
{
  return {
    audioIndex: 0,
    streamIndex: 0,
    codecName: 'aac',
    profile: null,
    channels: 2,
    layout: 'stereo',
    layoutGuessed: false,
    sampleRate: 48000,
    sampleFmt: 'fltp',
    bitsPerRawSample: null,
    bitRate: null,
    durationSec: 10,
    language: null,
    title: null,
    disposition: {},
    ...over
  }
}

/** The output as the source stands: same channels and layout, no minimum rate. */
function same(a: AudioFacts, over: Partial<EncoderOutput> = {}): EncoderOutput
{
  return { channels: a.channels, layout: a.layout ?? '', minSampleRate: null, ...over }
}

type Accepted = Extract<EncoderDecision, { ok: true }>

function accept(decision: EncoderDecision): Accepted
{
  if (!decision.ok)
  {
    throw new Error(`refused: ${decision.reason} (${decision.encoder})`)
  }
  return decision
}

function choose(a: AudioFacts, policy: EncoderPolicy = INHERIT, container = 'mkv', over: Partial<EncoderOutput> = {},
  caps: BuildCapabilities = CAPS): Accepted
{
  return accept(chooseEncoder(a, policy, container, same(a, over), caps))
}

function choice(a: AudioFacts, policy: EncoderPolicy = INHERIT, container = 'mkv', over: Partial<EncoderOutput> = {},
  caps: BuildCapabilities = CAPS): EncoderChoice
{
  return choose(a, policy, container, over, caps).choice
}

function summary(c: EncoderChoice): string
{
  return `${c.encoder} ${c.bitrateKbps ?? '-'} ${c.layout} ${c.sampleRate} ${c.pin}`
}

describe('same-as-source table', () =>
{
  const rows: ReadonlyArray<readonly [string, Partial<AudioFacts>, string, string, readonly EncoderNote[], string]> =
  [
    ['16-bit PCM', { codecName: 'pcm_s16le', sampleFmt: 's16' }, 'wav', 'pcm_s16le - stereo 48000 s16-dither', [], 'wav'],
    ['16-bit big-endian PCM', { codecName: 'pcm_s16be', sampleFmt: 's16' }, 'aiff', 'pcm_s16be - stereo 48000 s16-dither', [], 'aiff'],
    ['24-bit PCM', { codecName: 'pcm_s24le', sampleFmt: 's32', bitsPerRawSample: 24 }, 'wav', 'pcm_s24le - stereo 48000 s32', [], 'wav'],
    ['24-bit big-endian PCM', { codecName: 'pcm_s24be', sampleFmt: 's32' }, 'aiff', 'pcm_s24be - stereo 48000 s32', [], 'aiff'],
    ['32-bit PCM', { codecName: 'pcm_s32le', sampleFmt: 's32' }, 'wav', 'pcm_s32le - stereo 48000 s32', [], 'wav'],
    ['float PCM', { codecName: 'pcm_f32le', sampleFmt: 'flt' }, 'wav', 'pcm_f32le - stereo 48000 encoder', [], 'wav'],
    ['8-bit PCM', { codecName: 'pcm_u8', sampleFmt: 'u8', channels: 1, layout: 'mono', sampleRate: 11025 }, 'wav', 'pcm_u8 - mono 11025 encoder', [], 'wav'],
    ['16-bit FLAC', { codecName: 'flac', sampleFmt: 's16', bitsPerRawSample: 16, sampleRate: 44100 }, 'flac', 'flac - stereo 44100 s16-dither', [], 'flac'],
    ['24-bit FLAC', { codecName: 'flac', sampleFmt: 's32', bitsPerRawSample: 24, sampleRate: 96000 }, 'flac', 'flac - stereo 96000 s32', [], 'flac'],
    ['16-bit ALAC', { codecName: 'alac', sampleFmt: 's16p', bitsPerRawSample: 16 }, 'm4a', 'alac - stereo 48000 s16-dither', [], 'm4a'],
    ['24-bit ALAC', { codecName: 'alac', sampleFmt: 's32p', bitsPerRawSample: 24 }, 'm4a', 'alac - stereo 48000 s32', [], 'm4a'],
    ['WavPack', { codecName: 'wavpack', sampleFmt: 's16p', bitsPerRawSample: 16 }, 'wv', 'wavpack - stereo 48000 s16-dither', [], 'wv'],
    ['float WavPack', { codecName: 'wavpack', sampleFmt: 'fltp', bitsPerRawSample: 32 }, 'wv', 'wavpack - stereo 48000 encoder', [], 'wv'],
    ['TTA', { codecName: 'tta', sampleFmt: 's32', bitsPerRawSample: 24 }, 'mka', 'tta - stereo 48000 s32', [], 'mka'],
    ['Monkey\'s Audio', { codecName: 'ape', sampleFmt: 's16p', bitsPerRawSample: 16 }, 'ape', 'flac - stereo 48000 s16-dither',
      ['no-source-encoder', 'lossless-kept-lossless', 'container-changed'], 'flac'],
    ['WMA Lossless', { codecName: 'wmalossless', sampleFmt: 's16p', bitsPerRawSample: 16 }, 'wma', 'flac - stereo 48000 s16-dither',
      ['no-source-encoder', 'lossless-kept-lossless', 'container-changed'], 'flac'],
    ['TAK', { codecName: 'tak', sampleFmt: 's32p', bitsPerRawSample: 24 }, 'mka', 'flac - stereo 48000 s32', ['no-source-encoder', 'lossless-kept-lossless'], 'mka'],
    ['TrueHD 7.1', { codecName: 'truehd', channels: 8, layout: '7.1', sampleFmt: 's32', bitsPerRawSample: 24 }, 'mkv', 'flac - 7.1 48000 s32',
      ['no-source-encoder', 'lossless-kept-lossless'], 'mkv'],
    ['MLP', { codecName: 'mlp', channels: 6, layout: '5.1', sampleFmt: 's32' }, 'mka', 'flac - 5.1 48000 s32', ['no-source-encoder', 'lossless-kept-lossless'], 'mka'],
    ['DTS-HD MA 7.1', { codecName: 'dts', profile: 'DTS-HD MA', channels: 8, layout: '7.1', sampleFmt: 's32p', bitsPerRawSample: 24 }, 'mkv',
      'flac - 7.1 48000 s32', ['no-source-encoder', 'lossless-kept-lossless'], 'mkv'],
    ['TrueHD 5.1 in MP4', { codecName: 'truehd', channels: 6, layout: '5.1', sampleFmt: 's32', bitsPerRawSample: 24 }, 'mp4', 'alac - 5.1 48000 s32',
      ['no-source-encoder', 'lossless-kept-lossless'], 'mp4'],
    ['DTS core 5.1(side)', { codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1(side)', bitRate: 1536000 }, 'mkv', 'eac3 640 5.1(side) 48000 encoder',
      ['no-source-encoder'], 'mkv'],
    ['DTS-ES 6.1', { codecName: 'dts', profile: 'DTS-ES', channels: 7, layout: '6.1', bitRate: 1536000 }, 'mkv', 'flac - 6.1 48000 s32', ['no-source-encoder'], 'mkv'],
    ['DTS-HD HRA 7.1', { codecName: 'dts', profile: 'DTS-HD HRA', channels: 8, layout: '7.1', bitRate: 1536000 }, 'mkv', 'flac - 7.1 48000 s32', ['no-source-encoder'], 'mkv'],
    ['HE-AAC', { codecName: 'aac', profile: 'HE-AAC', bitRate: 64000 }, 'm4a', 'aac 128 stereo 48000 encoder', [], 'm4a'],
    ['MP3', { codecName: 'mp3', bitRate: 320000, sampleRate: 44100 }, 'mp3', 'libmp3lame 320 stereo 44100 encoder', [], 'mp3'],
    ['MP2', { codecName: 'mp2', sampleFmt: 's16p', bitRate: 256000 }, 'mp2', 'mp2 256 stereo 48000 encoder', [], 'mp2'],
    ['Opus', { codecName: 'opus' }, 'opus', 'libopus 160 stereo 48000 encoder', [], 'opus'],
    ['Vorbis', { codecName: 'vorbis', bitRate: 160000, sampleRate: 44100 }, 'ogg', 'libvorbis 160 stereo 44100 encoder', [], 'ogg'],
    ['AC-3 5.1', { codecName: 'ac3', channels: 6, layout: '5.1(side)', bitRate: 448000 }, 'ac3', 'ac3 448 5.1(side) 48000 encoder', [], 'ac3'],
    ['E-AC-3 5.1', { codecName: 'eac3', channels: 6, layout: '5.1(side)', bitRate: 384000 }, 'mka', 'eac3 384 5.1(side) 48000 encoder', [], 'mka'],
    ['WMA v1', { codecName: 'wmav1', bitRate: 128000, sampleRate: 44100 }, 'wma', 'wmav2 128 stereo 44100 encoder', [], 'wma'],
    ['WMA v2', { codecName: 'wmav2', bitRate: 160000, sampleRate: 44100 }, 'asf', 'wmav2 160 stereo 44100 encoder', [], 'asf'],
    ['WMA Pro', { codecName: 'wmapro', channels: 6, layout: '5.1', bitRate: 384000 }, 'mkv', 'aac 384 5.1 48000 encoder', ['no-source-encoder'], 'mkv'],
    ['AMR-NB', { codecName: 'amr_nb', channels: 1, layout: 'mono', sampleRate: 8000, bitRate: 12200 }, 'mp4', 'aac 96 mono 8000 encoder', ['no-source-encoder'], 'mp4'],
    ['AMR-WB', { codecName: 'amr_wb', channels: 1, layout: 'mono', sampleRate: 16000, bitRate: 23850 }, 'mka', 'aac 96 mono 16000 encoder', ['no-source-encoder'], 'mka'],
    ['Cook', { codecName: 'cook', bitRate: 96000, sampleRate: 44100 }, 'mka', 'aac 128 stereo 44100 encoder', ['no-source-encoder'], 'mka'],
    ['ATRAC3', { codecName: 'atrac3', bitRate: 132000, sampleRate: 44100 }, 'mkv', 'aac 160 stereo 44100 encoder', ['no-source-encoder'], 'mkv'],
    ['QDM2', { codecName: 'qdm2', bitRate: 64000, sampleRate: 44100 }, 'mov', 'aac 128 stereo 44100 encoder', ['no-source-encoder'], 'mov'],
    ['GSM in WAV', { codecName: 'gsm_ms', channels: 1, layout: 'mono', sampleRate: 8000, bitRate: 13000 }, 'wav', 'aac 96 mono 8000 encoder',
      ['no-source-encoder', 'container-changed'], 'm4a'],
    ['ADPCM in WebM', { codecName: 'adpcm_ms', sampleRate: 44100 }, 'webm', 'libopus 160 stereo 48000 encoder', ['no-source-encoder', 'rate-converted'], 'webm'],
    ['an unknown lossy codec', { codecName: 'mystery' }, 'mkv', 'aac 256 stereo 48000 encoder', ['no-source-encoder'], 'mkv']
  ]

  for (const [label, facts, container, expected, notes, target] of rows)
  {
    it(`writes ${label} as ${expected.split(' ')[0]} in .${target}`, () =>
    {
      const decision = choose(stream(facts), INHERIT, container)
      expect(summary(decision.choice)).toBe(expected)
      expect(decision.choice.notes).toEqual(notes)
      expect(decision.container).toBe(target)
      expect(decision.containerChanged).toBe(target !== container)
    })
  }

  it('records every lossless source as lossless and every lossy one as lossy', () =>
  {
    for (const codecName of ['pcm_s16le', 'pcm_bluray', 'flac', 'alac', 'wavpack', 'tta', 'ape', 'wmalossless', 'tak', 'truehd', 'mlp'])
    {
      expect(isLosslessSource(stream({ codecName })), codecName).toBe(true)
    }
    expect(isLosslessSource(stream({ codecName: 'dts', profile: 'DTS-HD MA + DTS:X' }))).toBe(true)
    for (const codecName of ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'wmav2', 'wmapro'])
    {
      expect(isLosslessSource(stream({ codecName })), codecName).toBe(false)
    }
    expect(isLosslessSource(stream({ codecName: 'dts', profile: 'DTS' }))).toBe(false)
    expect(isLosslessSource(stream({ codecName: 'dts', profile: null }))).toBe(false)
  })

  it('writes PCM other than the planner\'s own as FLAC', () =>
  {
    const decision = choose(stream({ codecName: 'pcm_bluray', channels: 6, layout: '5.1', sampleFmt: 's32', bitsPerRawSample: 24 }), INHERIT, 'm2ts')
    expect(summary(decision.choice)).toBe('flac - 5.1 48000 s32')
    expect(decision.choice.notes).toEqual(['no-source-encoder', 'lossless-kept-lossless', 'container-changed'])
    expect(decision.container).toBe('flac')
    expect(summary(choice(stream({ codecName: 'pcm_f64le', sampleFmt: 'dbl' }), INHERIT, 'wav'))).toBe('flac - stereo 48000 s32')
  })

  it('writes multichannel PCM in Matroska as FLAC, which keeps the layout, and stereo PCM as PCM', () =>
  {
    const surround = choose(stream({ codecName: 'pcm_s24le', channels: 6, layout: '5.1(side)', sampleFmt: 's32' }), INHERIT, 'mkv')
    expect(summary(surround.choice)).toBe('flac - 5.1(side) 48000 s32')
    expect(surround.choice.notes).toEqual(['lossless-kept-lossless'])
    expect(surround.containerChanged).toBe(false)
    expect(summary(choice(stream({ codecName: 'pcm_s16le', sampleFmt: 's16' }), INHERIT, 'mka'))).toBe('pcm_s16le - stereo 48000 s16-dither')
  })

  it('keeps 7.1 lossless sources in FLAC and refuses them in the MP4 family, where only ALAC applies', () =>
  {
    const truehd = stream({ codecName: 'truehd', channels: 8, layout: '7.1', sampleFmt: 's32' })
    expect(choice(truehd, INHERIT, 'mka').layout).toBe('7.1')
    for (const container of ['mp4', 'm4a', 'mov'])
    {
      expect(chooseEncoder(truehd, INHERIT, container, same(truehd), CAPS)).toEqual({ ok: false, reason: 'too-many-channels', encoder: 'alac', maxChannels: 6 })
    }
    expect(chooseEncoder(stream({ codecName: 'alac', channels: 8, layout: '7.1' }), INHERIT, 'm4a', same(stream({ channels: 8, layout: '7.1' })), CAPS))
      .toEqual({ ok: false, reason: 'too-many-channels', encoder: 'alac', maxChannels: 6 })
  })

  it('moves a codec its container cannot hold to the canonical container, or to .mkv for a video file', () =>
  {
    const opus = stream({ codecName: 'opus' })
    expect(choose(opus, INHERIT, 'm4a')).toMatchObject({ container: 'opus', containerChanged: true })
    expect(choose(opus, INHERIT, 'm4a').choice.notes).toEqual(['container-changed'])
    expect(choose(opus, INHERIT, 'm4a', { video: true })).toMatchObject({ container: 'mkv', containerChanged: true })
    expect(choose(stream({ codecName: 'wmav2', bitRate: 128000 }), INHERIT, 'avi')).toMatchObject({ container: 'wma', containerChanged: true })
    expect(choose(stream({ codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1' }), INHERIT, 'avi', { video: true }))
      .toMatchObject({ container: 'mkv', containerChanged: true })
    expect(choose(stream(), INHERIT, 'xyz')).toMatchObject({ container: 'm4a', containerChanged: true })
  })

  it('reads a container with a dot or in capitals as the same container', () =>
  {
    expect(choose(stream(), INHERIT, '.MKV')).toMatchObject({ container: 'mkv', containerChanged: false })
  })

  it('refuses an output no fallback container can hold', () =>
  {
    const float = stream({ codecName: 'pcm_f32be', sampleFmt: 'flt' })
    expect(chooseEncoder(float, INHERIT, 'mp4', same(float, { video: true }), CAPS))
      .toEqual({ ok: false, reason: 'container-cannot-hold', encoder: 'pcm_f32be', maxChannels: null })
    expect(choose(float, INHERIT, 'mov').choice.encoder).toBe('pcm_f32be')
  })
})

describe('bitrate ladders, floors, and defaults', () =>
{
  it('states the ladders of the encoders', () =>
  {
    expect(ENCODER_LIMITS.aac.bitrate?.steps).toEqual([96, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640])
    const ends = (name: string): number[] =>
    {
      const steps = ENCODER_LIMITS[name].bitrate?.steps ?? []
      return [steps[0], steps[steps.length - 1]]
    }
    expect(ends('libmp3lame')).toEqual([128, 320])
    expect(ends('libopus')).toEqual([64, 510])
    expect(ends('libvorbis')).toEqual([128, 320])
    expect(ends('ac3')).toEqual([192, 640])
    expect(ends('eac3')).toEqual([192, 1024])
    for (const name of ['flac', 'alac', 'wavpack', 'tta'])
    {
      expect(ENCODER_LIMITS[name].bitrate, name).toBeNull()
    }
  })

  const cases: ReadonlyArray<readonly [string, Partial<AudioFacts>, string, number]> =
  [
    ['AAC under the floor', { bitRate: 100000 }, 'mkv', 128],
    ['AAC between steps', { bitRate: 130000 }, 'mkv', 160],
    ['AAC a fraction over a step', { bitRate: 256220 }, 'm4a', 256],
    ['AAC over the ladder', { bitRate: 700000 }, 'mkv', 640],
    ['AAC with no bitrate', {}, 'mkv', 256],
    ['mono AAC with no bitrate', { channels: 1, layout: 'mono' }, 'mkv', 128],
    ['mono AAC under the ladder', { channels: 1, layout: 'mono', bitRate: 48000 }, 'mkv', 96],
    ['5.1 AAC with no bitrate', { channels: 6, layout: '5.1' }, 'mkv', 640],
    ['5.1 AAC at the floor', { channels: 6, layout: '5.1', bitRate: 384000 }, 'mkv', 384],
    ['stereo MP3 with no bitrate', { codecName: 'mp3' }, 'mp3', 320],
    ['mono MP3 with no bitrate', { codecName: 'mp3', channels: 1, layout: 'mono' }, 'mp3', 160],
    ['mono MP3 at the mono floor', { codecName: 'mp3', channels: 1, layout: 'mono', bitRate: 64000 }, 'mp3', 64],
    ['stereo MP3 under the floor', { codecName: 'mp3', bitRate: 100000 }, 'mp3', 128],
    ['stereo MP3 between steps', { codecName: 'mp3', bitRate: 200000 }, 'mp3', 224],
    ['stereo Opus with no bitrate', { codecName: 'opus' }, 'mkv', 160],
    ['stereo Opus under the floor', { codecName: 'opus', bitRate: 64000 }, 'mkv', 96],
    ['mono Opus with no bitrate', { codecName: 'opus', channels: 1, layout: 'mono' }, 'mkv', 96],
    ['5.1 Opus with no bitrate', { codecName: 'opus', channels: 6, layout: '5.1' }, 'mkv', 510],
    ['stereo Vorbis with no bitrate', { codecName: 'vorbis' }, 'ogg', 192],
    ['5.1 Vorbis with no bitrate', { codecName: 'vorbis', channels: 6, layout: '5.1' }, 'ogg', 576],
    ['mono Vorbis under the floor', { codecName: 'vorbis', channels: 1, layout: 'mono', bitRate: 48000 }, 'ogg', 64],
    ['stereo AC-3 with no bitrate', { codecName: 'ac3' }, 'ac3', 192],
    ['5.1 AC-3 with no bitrate', { codecName: 'ac3', channels: 6, layout: '5.1' }, 'ac3', 448],
    ['5.1 AC-3 under the 5.1 floor', { codecName: 'ac3', channels: 6, layout: '5.1', bitRate: 320000 }, 'ac3', 384],
    ['stereo AC-3 under the 2.0 floor', { codecName: 'ac3', bitRate: 128000 }, 'ac3', 192],
    ['5.1 AC-3 at the ladder top', { codecName: 'ac3', channels: 6, layout: '5.1', bitRate: 640000 }, 'ac3', 640],
    ['stereo E-AC-3 with no bitrate', { codecName: 'eac3' }, 'mka', 256],
    ['5.1 E-AC-3 with no bitrate', { codecName: 'eac3', channels: 6, layout: '5.1' }, 'mka', 640],
    ['5.1 E-AC-3 over the ladder', { codecName: 'eac3', channels: 6, layout: '5.1', bitRate: 1536000 }, 'mka', 1024],
    ['stereo MP2 with no bitrate', { codecName: 'mp2' }, 'mp2', 256],
    ['mono MP2 under the floor', { codecName: 'mp2', channels: 1, layout: 'mono', bitRate: 64000 }, 'mp2', 96],
    ['stereo WMA with no bitrate', { codecName: 'wmav2' }, 'wma', 192],
    ['mono WMA with no bitrate', { codecName: 'wmav2', channels: 1, layout: 'mono' }, 'wma', 96],
    ['stereo WMA under the floor', { codecName: 'wmav2', bitRate: 64000 }, 'wma', 128]
  ]

  for (const [label, facts, container, kbps] of cases)
  {
    it(`gives ${label} ${kbps}k`, () =>
    {
      expect(choice(stream(facts), INHERIT, container).bitrateKbps).toBe(kbps)
    })
  }

  it('scales the source bitrate to the output channels after a downmix or a mono duplication', () =>
  {
    const ac3 = stream({ codecName: 'ac3', channels: 6, layout: '5.1', bitRate: 448000 })
    expect(choice(ac3, INHERIT, 'ac3', { channels: 2, layout: 'stereo' }).bitrateKbps).toBe(192)
    const mono = stream({ codecName: 'mp3', channels: 1, layout: 'mono', bitRate: 96000, sampleRate: 44100 })
    expect(choice(mono, INHERIT, 'mp3', { channels: 2, layout: 'stereo' }).bitrateKbps).toBe(192)
  })

  it('takes the source bitrate as it stands when the source channel count was not probed', () =>
  {
    expect(choice(stream({ channels: 0, bitRate: 160000 }), INHERIT, 'mkv', { channels: 2, layout: 'stereo' }).bitrateKbps).toBe(160)
  })

  it('records the rate per channel pair for the ceiling table', () =>
  {
    expect(choice(stream({ channels: 6, layout: '5.1', bitRate: 384000 })).kbpsPerPair).toBe(128)
    expect(choice(stream({ codecName: 'mp3', channels: 1, layout: 'mono', bitRate: 64000 }), INHERIT, 'mp3').kbpsPerPair).toBe(128)
    expect(choice(stream({ codecName: 'flac', sampleFmt: 's16' }), INHERIT, 'flac').kbpsPerPair).toBeNull()
  })

  const chosen: ReadonlyArray<readonly [string, Partial<AudioFacts>, EncoderPolicy, string, number | null]> =
  [
    ['AAC at 160 per pair for 5.1', { channels: 6, layout: '5.1' }, codec('aac', 160), 'mkv', 480],
    ['AAC at 64 per pair, raised to the ladder', {}, codec('aac', 64), 'm4a', 96],
    ['AAC at 256 per pair for 7.1, held at the ladder top', { channels: 8, layout: '7.1' }, codec('aac', 256), 'mp4', 640],
    ['AC-3 at its 448k 5.1 total', { channels: 6, layout: '5.1' }, codec('ac3', 448 / 3), 'ac3', 448],
    ['AC-3 between two of its rates, moved up', { channels: 6, layout: '5.1' }, codec('ac3', 150), 'ac3', 512],
    ['AC-3 over its top rate', { channels: 6, layout: '5.1' }, codec('ac3', 640), 'mkv', 640],
    ['MP3 between two of its rates, moved up', { codecName: 'pcm_s16le' }, codec('mp3', 200), 'mp3', 224],
    ['mono MP3 at 128 per pair', { codecName: 'pcm_s16le', channels: 1, layout: 'mono' }, codec('mp3', 128), 'mp3', 64],
    ['Opus 7.1 over the ladder', { channels: 8, layout: '7.1' }, codec('opus', 640), 'opus', 510],
    ['Opus under the ladder', {}, codec('opus', 32), 'webm', 64],
    ['Vorbis 7.1 under the ladder, raised to 128 per pair', { channels: 8, layout: '7.1' }, codec('vorbis', 32), 'ogg', 512],
    ['E-AC-3 with no rate given', {}, codec('eac3'), 'mka', 256],
    ['FLAC, which takes no bitrate', {}, codec('flac', 320), 'flac', null],
    ['ALAC, which takes no bitrate', {}, codec('alac', 320), 'm4a', null],
    ['PCM, which takes no bitrate', {}, codec('pcm', 320), 'wav', null]
  ]

  for (const [label, facts, policy, container, kbps] of chosen)
  {
    it(`writes ${label} at ${kbps ?? 'no'} kb/s`, () =>
    {
      const picked = choose(stream(facts), policy, container)
      expect(picked.choice.bitrateKbps).toBe(kbps)
      expect(picked.containerChanged).toBe(false)
    })
  }

  it('lowers MP3 to the MPEG-2 and MPEG-2.5 maxima at low sample rates', () =>
  {
    expect(choice(stream({ codecName: 'pcm_s16le', sampleRate: 22050 }), codec('mp3', 320), 'mp3').bitrateKbps).toBe(160)
    expect(choice(stream({ codecName: 'pcm_s16le', sampleRate: 16000 }), codec('mp3', 320), 'mp3').bitrateKbps).toBe(160)
    expect(choice(stream({ codecName: 'mp3', sampleRate: 8000, bitRate: 32000 }), INHERIT, 'mp3').bitrateKbps).toBe(64)
    expect(choice(stream({ codecName: 'mp3', channels: 1, layout: 'mono', sampleRate: 11025 }), INHERIT, 'mp3').bitrateKbps).toBe(64)
    expect(choice(stream({ codecName: 'mp3', sampleRate: 32000 }), INHERIT, 'mp3').bitrateKbps).toBe(320)
  })
})

describe('channel limits', () =>
{
  it('refuses an MP3 output from 5.1 without a downmix and accepts it after one', () =>
  {
    const surround = stream({ codecName: 'pcm_s24le', channels: 6, layout: '5.1', sampleFmt: 's32' })
    expect(chooseEncoder(surround, codec('mp3', 320), 'mp3', same(surround), CAPS))
      .toEqual({ ok: false, reason: 'too-many-channels', encoder: 'libmp3lame', maxChannels: 2 })
    expect(summary(choice(surround, codec('mp3', 320), 'mp3', { channels: 2, layout: 'stereo' }))).toBe('libmp3lame 320 stereo 48000 encoder')
  })

  const limits: ReadonlyArray<readonly [string, Partial<AudioFacts>, EncoderPolicy, string, string, number]> =
  [
    ['WMA v2 5.1', { codecName: 'pcm_s16le', channels: 6, layout: '5.1' }, codec('wmav2', 192), 'wma', 'wmav2', 2],
    ['MP2 5.1', { codecName: 'mp2', channels: 6, layout: '5.1' }, INHERIT, 'mp2', 'mp2', 2],
    ['AC-3 7.1', { codecName: 'pcm_s16le', channels: 8, layout: '7.1' }, codec('ac3', 192), 'ac3', 'ac3', 6],
    ['E-AC-3 7.1', { codecName: 'pcm_s16le', channels: 8, layout: '7.1' }, codec('eac3', 192), 'mka', 'eac3', 6],
    ['ALAC 6.1', { codecName: 'pcm_s16le', channels: 7, layout: '6.1(back)' }, codec('alac'), 'm4a', 'alac', 6],
    ['FLAC with 12 channels', { codecName: 'pcm_s24le', channels: 12, layout: '7.1.4' }, codec('flac'), 'flac', 'flac', 8],
    ['AAC with 12 channels', { codecName: 'pcm_s24le', channels: 12, layout: '7.1.4' }, codec('aac', 128), 'mkv', 'aac', 8],
    ['Opus with 12 channels', { codecName: 'pcm_s24le', channels: 12, layout: '7.1.4' }, codec('opus', 128), 'mkv', 'libopus', 8],
    ['Vorbis with 12 channels', { codecName: 'pcm_s24le', channels: 12, layout: '7.1.4' }, codec('vorbis', 128), 'ogg', 'libvorbis', 8]
  ]

  for (const [label, facts, policy, container, encoder, max] of limits)
  {
    it(`refuses ${label}`, () =>
    {
      const a = stream(facts)
      expect(chooseEncoder(a, policy, container, same(a), CAPS)).toEqual({ ok: false, reason: 'too-many-channels', encoder, maxChannels: max })
    })
  }

  it('keeps 7.1 in Vorbis, Opus, AAC, and FLAC, and any channel count in PCM', () =>
  {
    const eight = stream({ codecName: 'pcm_s24le', channels: 8, layout: '7.1', sampleFmt: 's32' })
    for (const name of ['vorbis', 'opus', 'aac', 'flac'] as const)
    {
      expect(choice(eight, codec(name, 128), 'mkv').layout, name).toBe('7.1')
    }
    const twelve = stream({ codecName: 'pcm_s24le', channels: 12, layout: '7.1.4', sampleFmt: 's32' })
    expect(summary(choice(twelve, INHERIT, 'wav'))).toBe('pcm_s24le - 7.1.4 48000 s32')
  })

  it('agrees with the channel limits the batch page offers and never takes fewer, with Vorbis up to 7.1', () =>
  {
    const encoders: Readonly<Record<OutputCodec, string | null>> =
    {
      aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', flac: 'flac', alac: 'alac', ac3: 'ac3', eac3: 'eac3', pcm: null, wmav2: 'wmav2'
    }
    for (const [name, offered] of Object.entries(CODEC_MAX_CHANNELS) as Array<[OutputCodec, number | null]>)
    {
      const encoder = encoders[name]
      const max = encoder === null ? null : ENCODER_LIMITS[encoder].maxChannels
      expect(max === null || (offered !== null && offered <= max), name).toBe(true)
      expect(max, name).toBe(name === 'vorbis' ? 8 : offered)
    }
  })
})

describe('layouts', () =>
{
  const remaps: ReadonlyArray<readonly [OutputCodec, string, string]> =
  [
    ['opus', '5.1(side)', '5.1'], ['opus', '5.0(side)', '5.0'], ['opus', 'quad(side)', 'quad'],
    ['aac', '5.1(side)', '5.1'], ['aac', '5.0(side)', '5.0'], ['aac', 'quad(side)', 'quad'],
    ['vorbis', '5.1(side)', '5.1'], ['alac', '5.1(side)', '5.1'], ['alac', '5.0(side)', '5.0']
  ]

  for (const [name, from, to] of remaps)
  {
    it(`relabels ${from} as ${to} for ${name}`, () =>
    {
      const a = stream({ codecName: 'pcm_s24le', channels: from.startsWith('5.1') ? 6 : from.startsWith('5.0') ? 5 : 4, layout: from, sampleFmt: 's32' })
      const picked = choice(a, codec(name, 128), 'mkv')
      expect(picked.layout).toBe(to)
      expect(picked.notes).toEqual(['layout-remapped'])
    })
  }

  it('relabels the side surrounds of a same-as-source AAC and Opus stream', () =>
  {
    expect(choice(stream({ channels: 6, layout: '5.1(side)' }), INHERIT, 'mp4').layout).toBe('5.1')
    expect(choice(stream({ codecName: 'opus', channels: 6, layout: '5.1(side)' }), INHERIT, 'mkv').layout).toBe('5.1')
    expect(choice(stream({ codecName: 'tta', channels: 6, layout: '5.1(side)', sampleFmt: 's16' }), INHERIT, 'mka').layout).toBe('5.1')
  })

  it('keeps 5.1(side) for AC-3 and E-AC-3, which code side and back surrounds alike', () =>
  {
    const side = stream({ codecName: 'pcm_s24le', channels: 6, layout: '5.1(side)', sampleFmt: 's32' })
    for (const name of ['ac3', 'eac3'] as const)
    {
      const picked = choice(side, codec(name, 128), 'mka')
      expect(picked.layout).toBe('5.1(side)')
      expect(picked.notes).toEqual([])
    }
    expect(choice(stream({ codecName: 'ac3', channels: 4, layout: 'quad' }), INHERIT, 'ac3').layout).toBe('quad')
  })

  const refused: ReadonlyArray<readonly [OutputCodec, string, number, string]> =
  [
    ['opus', '6.1(back)', 7, 'libopus'], ['opus', '4.0', 4, 'libopus'], ['opus', '2.1', 3, 'libopus'],
    ['aac', '6.1', 7, 'aac'], ['aac', 'hexagonal', 6, 'aac'], ['aac', '7.1(wide)', 8, 'aac'],
    ['vorbis', 'hexagonal', 6, 'libvorbis'], ['alac', 'quad', 4, 'alac'], ['ac3', 'hexagonal', 6, 'ac3'], ['mp3', 'downmix', 2, 'libmp3lame']
  ]

  for (const [name, layout, channels, encoder] of refused)
  {
    it(`refuses ${layout} for ${name}`, () =>
    {
      const a = stream({ codecName: 'pcm_s24le', channels, layout, sampleFmt: 's32' })
      const decision = chooseEncoder(a, codec(name, 128), 'mkv', same(a), CAPS)
      expect(decision).toMatchObject({ ok: false, reason: 'layout-unsupported', encoder })
    })
  }

  it('refuses a stream whose layout has no name, before choosing an encoder', () =>
  {
    for (const layout of ['', 'unknown', '6 channels'])
    {
      expect(chooseEncoder(stream(), INHERIT, 'mkv', { channels: 6, layout, minSampleRate: null }, CAPS))
        .toEqual({ ok: false, reason: 'layout-unsupported', encoder: null, maxChannels: null })
    }
    expect(chooseEncoder(stream(), INHERIT, 'mkv', { channels: 0, layout: 'stereo', minSampleRate: null }, CAPS))
      .toMatchObject({ ok: false, reason: 'layout-unsupported' })
  })

  it('keeps any named layout in FLAC, WavPack, and PCM', () =>
  {
    const hexagonal = stream({ codecName: 'pcm_s24le', channels: 6, layout: 'hexagonal', sampleFmt: 's32' })
    expect(choice(hexagonal, codec('flac'), 'flac').layout).toBe('hexagonal')
    expect(choice(hexagonal, INHERIT, 'wav').layout).toBe('hexagonal')
    expect(choice(stream({ codecName: 'wavpack', channels: 6, layout: 'hexagonal', sampleFmt: 's32p' }), INHERIT, 'wv').layout).toBe('hexagonal')
  })

  it('relabels only to layouts the encoder accepts', () =>
  {
    for (const [name, limits] of Object.entries(ENCODER_LIMITS))
    {
      for (const target of Object.values(limits.remap))
      {
        expect(limits.layouts, name).toContain(target)
      }
    }
  })
})

describe('sample rates', () =>
{
  it('raises 32000 and 22050 to the preset minimum of 44100 and keeps 48000 and 96000', () =>
  {
    const flac = (sampleRate: number): EncoderChoice => choice(stream({ codecName: 'flac', sampleFmt: 's16', sampleRate }), INHERIT, 'flac', { minSampleRate: 44100 })
    expect([flac(32000).sampleRate, flac(32000).notes]).toEqual([44100, ['rate-raised']])
    expect([flac(22050).sampleRate, flac(22050).notes]).toEqual([44100, ['rate-raised']])
    expect([flac(48000).sampleRate, flac(48000).notes]).toEqual([48000, []])
    expect([flac(96000).sampleRate, flac(96000).notes]).toEqual([96000, []])
    const pcm = choice(stream({ codecName: 'pcm_s16le', sampleFmt: 's16', channels: 1, layout: 'mono', sampleRate: 32000 }), INHERIT, 'wav', { minSampleRate: 44100 })
    expect([pcm.sampleRate, pcm.notes]).toEqual([44100, ['rate-raised']])
  })

  it('still applies a 48 kHz cap after the minimum', () =>
  {
    const mp3 = (sampleRate: number): EncoderChoice => choice(stream({ codecName: 'mp3', sampleRate }), INHERIT, 'mp3', { minSampleRate: 44100 })
    expect([mp3(96000).sampleRate, mp3(96000).notes]).toEqual([48000, ['rate-converted']])
    expect([mp3(32000).sampleRate, mp3(32000).notes]).toEqual([44100, ['rate-raised']])
    expect([mp3(22050).sampleRate, mp3(22050).notes]).toEqual([44100, ['rate-raised']])
    const opus = choice(stream({ codecName: 'opus', sampleRate: 22050 }), INHERIT, 'opus', { minSampleRate: 44100 })
    expect([opus.sampleRate, opus.notes]).toEqual([48000, ['rate-raised', 'rate-converted']])
  })

  const rates: ReadonlyArray<readonly [string, Partial<AudioFacts>, EncoderPolicy, string, number]> =
  [
    ['Opus at 44100', { codecName: 'opus', sampleRate: 44100 }, INHERIT, 'opus', 48000],
    ['Vorbis at 96000', { codecName: 'vorbis', sampleRate: 96000 }, INHERIT, 'ogg', 48000],
    ['Vorbis at 22050', { codecName: 'vorbis', sampleRate: 22050 }, INHERIT, 'ogg', 32000],
    ['MP3 at 88200', { codecName: 'mp3', sampleRate: 88200 }, INHERIT, 'mp3', 48000],
    ['MP2 at 22050', { codecName: 'mp2', sampleRate: 22050 }, INHERIT, 'mp2', 32000],
    ['MP2 at 96000', { codecName: 'mp2', sampleRate: 96000 }, INHERIT, 'mp2', 48000],
    ['AC-3 at 22050', { codecName: 'ac3', sampleRate: 22050 }, INHERIT, 'ac3', 32000],
    ['AC-3 at 96000', { codecName: 'ac3', sampleRate: 96000 }, INHERIT, 'ac3', 48000],
    ['E-AC-3 at 88200', { codecName: 'eac3', sampleRate: 88200 }, INHERIT, 'mka', 48000],
    ['AAC at 192000', { sampleRate: 192000 }, INHERIT, 'mkv', 96000],
    ['WMA v2 at 96000', { codecName: 'pcm_s24le', sampleRate: 96000 }, codec('wmav2', 192), 'wma', 48000],
    ['WMA v2 at 88200', { codecName: 'pcm_s24le', sampleRate: 88200 }, codec('wmav2', 192), 'wmv', 48000]
  ]

  for (const [label, facts, policy, container, rate] of rates)
  {
    it(`writes ${label} at ${rate}`, () =>
    {
      const picked = choice(stream(facts), policy, container)
      expect(picked.sampleRate).toBe(rate)
      expect(picked.notes).toContain('rate-converted')
    })
  }

  const kept: ReadonlyArray<readonly [string, Partial<AudioFacts>, EncoderPolicy, string]> =
  [
    ['AC-3 at 44100', { codecName: 'ac3', sampleRate: 44100 }, INHERIT, 'ac3'],
    ['MP3 at 22050', { codecName: 'mp3', sampleRate: 22050 }, INHERIT, 'mp3'],
    ['AAC at 96000', { sampleRate: 96000 }, INHERIT, 'mkv'],
    ['AAC at 8000', { sampleRate: 8000 }, INHERIT, 'mkv'],
    ['WMA v2 at 8000', { codecName: 'pcm_s16le', sampleRate: 8000 }, codec('wmav2', 128), 'wma'],
    ['WMA v2 at 22050', { codecName: 'pcm_s16le', sampleRate: 22050 }, codec('wmav2', 128), 'asf'],
    ['FLAC at 192000', { codecName: 'flac', sampleFmt: 's32', sampleRate: 192000 }, INHERIT, 'flac'],
    ['Vorbis at 44100', { codecName: 'vorbis', sampleRate: 44100 }, INHERIT, 'ogg']
  ]

  for (const [label, facts, policy, container] of kept)
  {
    it(`keeps ${label}`, () =>
    {
      const a = stream(facts)
      const picked = choice(a, policy, container)
      expect(picked.sampleRate).toBe(a.sampleRate)
      expect(picked.notes).toEqual([])
    })
  }

  it('writes a stream with no probed rate at 48000', () =>
  {
    expect(choice(stream({ codecName: 'pcm_s16le', sampleFmt: 's16', sampleRate: 0 }), INHERIT, 'wav').sampleRate).toBe(48000)
  })
})

describe('WMA v2', () =>
{
  it('takes at most two channels and 48 kHz, and never moves to another container when chosen', () =>
  {
    const stereo = stream({ codecName: 'pcm_s16le', sampleFmt: 's16', sampleRate: 96000 })
    for (const container of ['wma', 'wmv', 'asf'])
    {
      expect(summary(choice(stereo, codec('wmav2', 192), container)), container).toBe('wmav2 192 stereo 48000 encoder')
    }
    for (const container of ['mp4', 'm4a', 'webm', 'mp3'])
    {
      expect(chooseEncoder(stereo, codec('wmav2', 192), container, same(stereo), CAPS), container)
        .toEqual({ ok: false, reason: 'container-cannot-hold', encoder: 'wmav2', maxChannels: 2 })
    }
    const surround = stream({ codecName: 'pcm_s16le', channels: 6, layout: '5.1' })
    expect(chooseEncoder(surround, codec('wmav2', 192), 'wma', same(surround), CAPS)).toMatchObject({ ok: false, reason: 'too-many-channels', maxChannels: 2 })
    expect(choice(stream({ codecName: 'pcm_s16le', channels: 1, layout: 'mono' }), codec('wmav2', 128), 'wma').bitrateKbps).toBe(64)
  })
})

describe('chosen codecs and containers', () =>
{
  it('moves a chosen codec its container cannot hold, to .mkv for a video file', () =>
  {
    const aac = stream()
    expect(choose(aac, codec('vorbis', 192), 'mp4', { video: true })).toMatchObject({ container: 'mkv', containerChanged: true })
    expect(choose(stream({ codecName: 'pcm_s16le' }), codec('aac', 256), 'wav')).toMatchObject({ container: 'm4a', containerChanged: true })
    expect(choose(stream({ codecName: 'pcm_s16le' }), codec('aac', 256), 'wav').choice.notes).toEqual(['container-changed'])
    expect(choose(aac, codec('mp3', 192), 'ogg')).toMatchObject({ container: 'mp3', containerChanged: true })
  })

  const pcm: ReadonlyArray<readonly [string, Partial<AudioFacts>, string, string, string]> =
  [
    ['24-bit PCM into WAV', { codecName: 'pcm_s24le', sampleFmt: 's32' }, 'wav', 'pcm_s24le', 's32'],
    ['24-bit PCM into AIFF', { codecName: 'pcm_s24le', sampleFmt: 's32' }, 'aiff', 'pcm_s24be', 's32'],
    ['32-bit big-endian PCM into WAV', { codecName: 'pcm_s32be', sampleFmt: 's32' }, 'wav', 'pcm_s32le', 's32'],
    ['16-bit FLAC into WAV', { codecName: 'flac', sampleFmt: 's16', bitsPerRawSample: 16 }, 'wav', 'pcm_s16le', 's16-dither'],
    ['24-bit FLAC into WAV', { codecName: 'flac', sampleFmt: 's32', bitsPerRawSample: 24 }, 'wav', 'pcm_s24le', 's32'],
    ['32-bit FLAC into WAV', { codecName: 'flac', sampleFmt: 's32', bitsPerRawSample: 32 }, 'wav', 'pcm_s32le', 's32'],
    ['TrueHD with no bit depth into WAV', { codecName: 'truehd', sampleFmt: 's32' }, 'wav', 'pcm_s24le', 's32'],
    ['APE with no sample format into WAV', { codecName: 'ape', sampleFmt: null }, 'wav', 'pcm_s24le', 's32'],
    ['MP3 into WAV', { codecName: 'mp3' }, 'wav', 'pcm_s16le', 's16-dither'],
    ['float PCM into MOV', { codecName: 'pcm_f32le', sampleFmt: 'flt' }, 'mov', 'pcm_f32le', 'encoder'],
    ['float PCM into AIFF', { codecName: 'pcm_f64le', sampleFmt: 'dbl' }, 'aiff', 'pcm_f32be', 'encoder'],
    ['8-bit PCM into WAV', { codecName: 'pcm_u8', sampleFmt: 'u8' }, 'wav', 'pcm_u8', 'encoder'],
    ['8-bit PCM into AIFF', { codecName: 'pcm_u8', sampleFmt: 'u8' }, 'aiff', 'pcm_s16be', 's16-dither'],
    ['signed 8-bit PCM into WAV', { codecName: 'pcm_s8', sampleFmt: 'u8' }, 'wav', 'pcm_s16le', 's16-dither']
  ]

  for (const [label, facts, container, encoder, pin] of pcm)
  {
    it(`writes ${label} as ${encoder}`, () =>
    {
      const picked = choose(stream(facts), codec('pcm'), container)
      expect([picked.choice.encoder, picked.choice.pin, picked.containerChanged]).toEqual([encoder, pin, false])
    })
  }

  it('moves PCM out of a container that holds none to .wav', () =>
  {
    expect(choose(stream({ codecName: 'flac', sampleFmt: 's16' }), codec('pcm'), 'mp3')).toMatchObject({ container: 'wav', containerChanged: true })
  })

  it('pins lossless outputs of lossy sources to 16 bits and of DTS to 24', () =>
  {
    expect(choice(stream({ codecName: 'mp3' }), codec('flac'), 'flac').pin).toBe('s16-dither')
    expect(choice(stream(), codec('alac'), 'm4a').pin).toBe('s16-dither')
    expect(choice(stream({ codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1' }), codec('flac'), 'flac').pin).toBe('s32')
    expect(choice(stream({ codecName: 'dts', profile: 'DTS', bitsPerRawSample: 16 }), codec('flac'), 'flac').pin).toBe('s16-dither')
    expect(choice(stream({ codecName: 'pcm_f32le', sampleFmt: 'flt' }), codec('flac'), 'flac').pin).toBe('s32')
    expect(choice(stream({ codecName: 'wavpack', sampleFmt: 's32p', bitsPerRawSample: 24 }), INHERIT, 'wv').pin).toBe('s32')
    expect(choice(stream({ codecName: 'wavpack', sampleFmt: 'dblp' }), INHERIT, 'wv').pin).toBe('encoder')
  })
})

describe('missing and experimental encoders', () =>
{
  it('never chooses an experimental encoder and never writes -strict', () =>
  {
    const sources: ReadonlyArray<Partial<AudioFacts>> = [
      { codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1(side)' }, { codecName: 'dts', profile: 'DTS-HD MA', channels: 6, layout: '5.1(side)' },
      { codecName: 'truehd', channels: 8, layout: '7.1' }, { codecName: 'mlp', channels: 6, layout: '5.1' }, { codecName: 'opus' }, { codecName: 'vorbis' },
      { codecName: 'aac' }, { codecName: 'ac3', channels: 6, layout: '5.1' }, { codecName: 'eac3', channels: 6, layout: '5.1' }, { codecName: 'sonic' }
    ]
    for (const facts of sources)
    {
      for (const container of ['mkv', 'mka', 'mp4', 'webm', 'ogg', 'ts'])
      {
        const decision = chooseEncoder(stream(facts), INHERIT, container, same(stream(facts)), CAPS)
        if (decision.ok)
        {
          expect(EXPERIMENTAL, `${facts.codecName} in ${container}`).not.toContain(decision.choice.encoder)
          expect(encoderArgs(decision.choice, 0)).not.toContain('-strict')
        }
      }
    }
  })

  it('falls back to Opus or AAC with a note when the build lacks the source\'s own encoder', () =>
  {
    const vorbis = stream({ codecName: 'vorbis', bitRate: 160000, sampleRate: 44100 })
    expect(summary(choose(vorbis, INHERIT, 'ogg', {}, without('libvorbis')).choice)).toBe('libopus 160 stereo 48000 encoder')
    expect(choose(vorbis, INHERIT, 'ogg', {}, without('libvorbis')).choice.notes).toEqual(['no-source-encoder', 'rate-converted'])
    expect(choose(vorbis, INHERIT, 'mkv', {}, without('libvorbis')).choice.encoder).toBe('aac')
    const opus = choose(stream({ codecName: 'opus' }), INHERIT, 'webm', {}, without('libopus'))
    expect([opus.choice.encoder, opus.container, opus.choice.notes]).toEqual(['aac', 'm4a', ['no-source-encoder', 'container-changed']])
    expect(choose(stream({ codecName: 'mp3' }), INHERIT, 'mp3', {}, without('libmp3lame'))).toMatchObject({ container: 'm4a', choice: { encoder: 'aac' } })
    expect(choose(stream({ codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1', bitRate: 1536000 }), INHERIT, 'mkv', {}, without('eac3')).choice)
      .toMatchObject({ encoder: 'aac', bitrateKbps: 640, notes: ['no-source-encoder'] })
  })

  it('keeps a lossless source lossless when the build lacks its encoder', () =>
  {
    expect(choose(stream({ codecName: 'ape', sampleFmt: 's16p' }), INHERIT, 'mka', {}, without('flac')).choice)
      .toMatchObject({ encoder: 'alac', notes: ['no-source-encoder', 'lossless-kept-lossless'] })
    expect(choose(stream({ codecName: 'wavpack', sampleFmt: 's16p' }), INHERIT, 'wv', {}, without('wavpack')))
      .toMatchObject({ container: 'flac', choice: { encoder: 'flac', notes: ['no-source-encoder', 'lossless-kept-lossless', 'container-changed'] } })
  })

  it('refuses a chosen codec the build lacks, and a source when the build has no candidate at all', () =>
  {
    const a = stream()
    expect(chooseEncoder(a, codec('vorbis', 192), 'ogg', same(a), without('libvorbis'))).toEqual({ ok: false, reason: 'no-encoder', encoder: 'libvorbis', maxChannels: null })
    const native: BuildCapabilities = { encoders: new Set(['opus', 'vorbis']), experimental: new Set(['opus', 'vorbis']), soxr: false }
    expect(chooseEncoder(stream({ codecName: 'opus' }), INHERIT, 'opus', same(a), native)).toEqual({ ok: false, reason: 'no-encoder', encoder: null, maxChannels: null })
    expect(chooseEncoder(a, codec('opus', 128), 'opus', same(a), native)).toMatchObject({ ok: false, reason: 'no-encoder', encoder: 'libopus' })
  })
})

describe('encoder arguments', () =>
{
  it('gives AAC its bitrate and -aac_coder fast for output stream N', () =>
  {
    const aac = choice(stream({ bitRate: 256000 }))
    expect(aac.extraArgs).toEqual(['-aac_coder', 'fast'])
    expect(encoderArgs(aac, 1)).toEqual(['-c:a:1', 'aac', '-b:a:1', '256k', '-aac_coder:a:1', 'fast'])
  })

  it('gives lossy encoders their bitrate and lossless encoders none', () =>
  {
    expect(encoderArgs(choice(stream({ codecName: 'opus' }), INHERIT, 'opus'), 2)).toEqual(['-c:a:2', 'libopus', '-b:a:2', '160k'])
    expect(encoderArgs(choice(stream({ codecName: 'flac', sampleFmt: 's16' }), INHERIT, 'flac'), 0)).toEqual(['-c:a:0', 'flac'])
    expect(encoderArgs(choice(stream({ codecName: 'pcm_s24le', sampleFmt: 's32' }), INHERIT, 'wav'), 3)).toEqual(['-c:a:3', 'pcm_s24le'])
  })

  it('writes only whole option pairs', () =>
  {
    const odd: EncoderChoice = { ...choice(stream()), extraArgs: ['-aac_coder', 'fast', '-dangling'] }
    expect(encoderArgs(odd, 0).slice(-2)).toEqual(['-aac_coder:a:0', 'fast'])
  })
})

describe('corpus streams on both builds', () =>
{
  /** Same-as-source in the source's own container, per audio stream. */
  const CORPUS: Readonly<Record<string, readonly string[]>> =
  {
    'brace.mp3': ['libmp3lame 192 stereo 44100 encoder'],
    'coherent51_s16.wav': ['pcm_s16le - 5.1 48000 s16-dither'],
    'cover.flac': ['flac - stereo 44100 s16-dither'],
    'cover.m4a': ['aac 256 stereo 44100 encoder'],
    'cover.mp3': ['libmp3lame 256 stereo 44100 encoder'],
    'dts51side.mkv': ['eac3 640 5.1(side) 48000 encoder'],
    'eac3_51side_meta.mka': ['eac3 384 5.1(side) 48000 encoder'],
    'eq61back.wav': ['pcm_s24le - 6.1(back) 48000 s32'],
    'hex.wav': ['pcm_s24le - hexagonal 48000 s32'],
    'hires96.flac': ['flac - stereo 96000 s32'],
    'loud.mp3': ['libmp3lame 320 stereo 44100 encoder'],
    'loud_aac.m4a': ['aac 256 stereo 44100 encoder'],
    'mono_speech_32k.wav': ['pcm_s16le - mono 32000 s16-dither'],
    'opus.opus': ['libopus 160 stereo 48000 encoder'],
    'opus.webm': ['libopus 160 stereo 48000 encoder'],
    'surround51side.mkv': ['ac3 448 5.1(side) 48000 encoder'],
    'surround71.wav': ['pcm_s24le - 7.1 48000 s32'],
    'video_multi.mkv': ['aac 256 stereo 48000 encoder', 'ac3 448 5.1(side) 48000 encoder'],
    'video_multi.mp4': ['aac 192 stereo 48000 encoder', 'aac 192 stereo 48000 encoder'],
    'vorbis.ogg': ['libvorbis 160 stereo 44100 encoder']
  }

  for (const build of PROBE_BUILDS)
  {
    it(`chooses the same-as-source encoders for the corpus probes of ${build}`, () =>
    {
      for (const [input, expected] of Object.entries(CORPUS))
      {
        const recorded = recordedProbe(build, input)
        const facts = toMediaFacts(recorded.probe, recorded.path)
        const choices = facts.audio.map((a) => summary(choice(a, INHERIT, facts.container)))
        expect(choices, input).toEqual(expected)
      }
    })

    it(`raises the 32 kHz speech corpus file to the Apple Podcasts minimum on ${build}`, () =>
    {
      const recorded = recordedProbe(build, 'mono_speech_32k.wav')
      const [speech] = toMediaFacts(recorded.probe, recorded.path).audio
      const picked = choice(speech, INHERIT, 'wav', { channels: 2, layout: 'stereo', minSampleRate: 44100 })
      expect([summary(picked), picked.notes]).toEqual(['pcm_s16le - stereo 44100 s16-dither', ['rate-raised']])
    })
  }
})

describe('facts carried from the inherited-encoder tests of the processor module', () =>
{
  it('never writes DTS or TrueHD with their experimental encoders', () =>
  {
    expect(choice(stream({ codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1' })).encoder).toBe('eac3')
    expect(choice(stream({ codecName: 'truehd', channels: 6, layout: '5.1', sampleFmt: 's32' })).encoder).toBe('flac')
  })

  it('keeps AC-3, AAC, and E-AC-3 sources on their own encoders without -strict', () =>
  {
    for (const [codecName, encoder] of [['ac3', 'ac3'], ['aac', 'aac'], ['eac3', 'eac3']])
    {
      const picked = choice(stream({ codecName, channels: 6, layout: '5.1' }))
      expect(picked.encoder).toBe(encoder)
      expect(encoderArgs(picked, 0)).not.toContain('-strict')
    }
  })

  it('substitutes E-AC-3 for DTS up to 5.1, at 640k', () =>
  {
    expect(choice(stream({ codecName: 'dts', profile: 'DTS', channels: 6, layout: '5.1', bitRate: 768000 })))
      .toMatchObject({ encoder: 'eac3', bitrateKbps: 640 })
  })

  it('writes TrueHD and MLP losslessly instead of substituting E-AC-3', () =>
  {
    expect(choice(stream({ codecName: 'truehd', channels: 8, layout: '7.1', sampleFmt: 's32' })).encoder).toBe('flac')
    expect(choice(stream({ codecName: 'mlp', channels: 6, layout: '5.1', sampleFmt: 's32' })).encoder).toBe('flac')
  })

  it('keeps reliable source codecs', () =>
  {
    expect(choice(stream({ codecName: 'ac3', channels: 6, layout: '5.1' })).encoder).toBe('ac3')
    expect(choice(stream({ codecName: 'aac' })).encoder).toBe('aac')
  })

  it('writes 7.1 DTS as FLAC rather than raising a lossy bitrate', () =>
  {
    expect(choice(stream({ codecName: 'dts', profile: 'DTS', channels: 8, layout: '7.1' }))).toMatchObject({ encoder: 'flac', bitrateKbps: null })
  })

  it('keeps 256k for stereo AAC with no probed bitrate', () =>
  {
    expect(choice(stream({ codecName: 'aac' })).bitrateKbps).toBe(256)
  })

  it('never writes AC-3 above 640k', () =>
  {
    expect(choice(stream({ codecName: 'ac3', channels: 6, layout: '5.1', bitRate: 640000 }), INHERIT, 'ac3').bitrateKbps).toBe(640)
    expect(choice(stream({ codecName: 'pcm_s16le', channels: 6, layout: '5.1' }), codec('ac3', 640), 'ac3').bitrateKbps).toBe(640)
  })

  it('falls back to AAC, or Opus in WebM, for a codec without an encoder', () =>
  {
    expect(choice(stream({ codecName: 'unknown' }), INHERIT, 'mkv')).toMatchObject({ encoder: 'aac', notes: ['no-source-encoder'] })
    expect(choice(stream({ codecName: 'unknown' }), INHERIT, 'webm')).toMatchObject({ encoder: 'libopus', notes: ['no-source-encoder'] })
  })
})
