/**
 * The FFmpeg runs behind the downmix and chain fixtures. Both scenarios.json files are generated from these
 * cases, and downmix.test.ts and chains.test.ts check that every recorded run still carries the arguments the
 * builders produce, so a builder change shows until the fixtures are captured again on both builds.
 */
import { encodeParts, exportLimiterTail, filterComplex, pinStages } from '../../../../../src/main/ffmpeg/audio/chains'
import type { ChainSpec } from '../../../../../src/main/ffmpeg/audio/chains'
import { DOWNMIX_LAYOUTS, LAYOUT_CHANNELS, buildDownmixProbeArgs, monoFoldStage } from '../../../../../src/main/ffmpeg/audio/downmix'
import type { DownmixLevels } from '../../../../../src/main/ffmpeg/audio/downmix'
import { NIGHT, compressorStage } from '../../../../../src/main/ffmpeg/audio/dynamics'
import type { Ceiling } from '../../../../../src/shared/audio/types'

export interface FixtureInput
{
  name: string
  args: string[]
}

export interface ProbeCase
{
  name: string
  input: string
  audioIndex: number
}

export interface ChainCase
{
  name: string
  inputs: string[]
  graph: string
  map: string
  codec: string[]
}

/** The exec prefix of a killable run, as execArgv([], 'kill') builds it. */
export const PROBE_PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5']

/** Chain runs record warnings only, so a clean run leaves no stderr file. */
export const CHAIN_PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+warning']

/** The AC-3 encoder's default Lo/Ro levels, which its own files carry: center -4.5 dB, surround -6 dB. */
export const AC3_DEFAULT_LEVELS: DownmixLevels = { centerLoRo: 0.594604, surroundLoRo: 0.5, preferred: 'unknown' }

const SINE_48K = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1']

/** The input file name of a layout's pink-noise WAV: 5.1(side) becomes layout-5.1-side.wav. */
export function layoutFile(layout: string): string
{
  return `layout-${slug(layout)}.wav`
}

/** A run-name form of a layout: 5.1(side) becomes 5.1-side. */
export function slug(layout: string): string
{
  return layout.replace('(', '-').replace(')', '')
}

function fanOut(layout: string): string
{
  return `pan=${layout}|${LAYOUT_CHANNELS[layout].map((_, index) => `c${index}=c0`).join('|')}`
}

const AC3_51SIDE: FixtureInput = { name: 'ac3-51side.ac3', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-c:a', 'ac3', '-b:a', '384k'] }

export const PROBE_INPUTS: FixtureInput[] =
[
  AC3_51SIDE,
  { name: 'eac3-loro.eac3', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-c:a', 'eac3', '-b:a', '384k', '-dmix_mode', 'loro', '-loro_cmixlev', '0.707', '-loro_surmixlev', '0.5'] },
  { name: 'eac3-ltrt.eac3', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-c:a', 'eac3', '-b:a', '384k', '-dmix_mode', 'ltrt', '-ltrt_cmixlev', '0.5', '-ltrt_surmixlev', '0.5'] },
  { name: 'ac3-dplii.ac3', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-c:a', 'ac3', '-b:a', '384k', '-dmix_mode', 'dplii'] },
  { name: 'ac3-stereo-dsur.ac3', args: [...SINE_48K, '-ac', '2', '-c:a', 'ac3', '-dsur_mode', 'on'] },
  { name: 'dts-51side.dts', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-strict', '-2', '-c:a', 'dca'] },
  { name: 'pcm-51side.wav', args: [...SINE_48K, '-af', fanOut('5.1(side)'), '-c:a', 'pcm_s16le'] },
  {
    name: 'two-audio.mkv',
    args: [
      ...SINE_48K, '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=1',
      '-filter_complex', `[1:a]${fanOut('5.1(side)')}[s]`, '-map', '0:a', '-map', '[s]', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-b:a:1', '384k'
    ]
  }
]

export const PROBE_CASES: ProbeCase[] =
[
  { name: 'ac3-51side', input: 'ac3-51side.ac3', audioIndex: 0 },
  { name: 'eac3-loro', input: 'eac3-loro.eac3', audioIndex: 0 },
  { name: 'eac3-ltrt', input: 'eac3-ltrt.eac3', audioIndex: 0 },
  { name: 'ac3-dplii', input: 'ac3-dplii.ac3', audioIndex: 0 },
  { name: 'ac3-stereo-dsur', input: 'ac3-stereo-dsur.ac3', audioIndex: 0 },
  { name: 'dts-51side', input: 'dts-51side.dts', audioIndex: 0 },
  { name: 'pcm-51side', input: 'pcm-51side.wav', audioIndex: 0 },
  { name: 'two-audio-second', input: 'two-audio.mkv', audioIndex: 1 }
]

export function probeRunArgs(probe: ProbeCase): string[]
{
  return buildDownmixProbeArgs(`IN/${probe.input}`, probe.audioIndex)
}

export const CHAIN_INPUTS: FixtureInput[] =
[
  { name: 'stereo-44k.flac', args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=1', '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's16'] },
  { name: 'stereo-96k.flac', args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=96000:duration=1', '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's32'] },
  { name: 'stereo-192k.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=192000:duration=1', '-ac', '2', '-c:a', 'pcm_s24le'] },
  { name: 'mono-44k.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=1', '-c:a', 'pcm_s16le'] },
  { name: 'mono-32k.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=32000:duration=1', '-c:a', 'pcm_s16le'] },
  AC3_51SIDE,
  ...DOWNMIX_LAYOUTS.map((layout) => ({
    name: layoutFile(layout),
    args: ['-f', 'lavfi', '-i', 'anoisesrc=d=1:c=pink:r=48000:a=0.1', '-af', fanOut(layout), '-c:a', 'pcm_s16le']
  }))
]

/** A ChainSpec with the 44.1 kHz stereo 16-bit FLAC defaults of the normalize example, overridden per case. */
export function chainSpec(over: Partial<ChainSpec> = {}): ChainSpec
{
  return {
    inputLayout: 'stereo',
    processRate: 44100,
    monoToStereo: false,
    downmix: null,
    downmixLevels: null,
    dynamics: null,
    highpassHz: 0,
    gainDb: 0,
    limiterCeilingDbtp: -1.5,
    out: { sampleRate: 44100, layout: 'stereo', pin: 's16-dither' },
    preEncodeMeter: null,
    ...over
  }
}

/** An AAC 192k export ceiling: C = -2.0 dBTP, L = -2.5. */
export const EXPORT_CEILING: Ceiling =
{
  presetMaxDbtp: -1,
  codecCeilingDbtp: -2,
  ceilingDbtp: -2,
  limiterCeilingDbtp: -2.5,
  gateDbtp: -1,
  decodedLimitDbtp: -1,
  outputClass: 'lossy-high',
  reason: 'aac-high',
  basis: 'measured'
}

function encodeCase(name: string, input: string, spec: ChainSpec, codec: string[]): ChainCase
{
  return { name, inputs: [input], graph: filterComplex(encodeParts(spec, '0:a:0', 0)), map: '[a0]', codec }
}

const SURROUND_48K = { processRate: 48000 }
const STEREO_48K_ENCODER = { sampleRate: 48000, layout: 'stereo', pin: 'encoder' } as const

const ENCODE_CASES: ChainCase[] =
[
  encodeCase('normalize-flac-s16', 'stereo-44k.flac', chainSpec({ gainDb: -2 }), ['-c:a:0', 'flac']),
  encodeCase('boost-flac-highpass', 'stereo-44k.flac', chainSpec({ highpassHz: 20, gainDb: 5.5 }), ['-c:a:0', 'flac']),
  encodeCase('alac-s16', 'stereo-44k.flac', chainSpec({ gainDb: -1.9, out: { sampleRate: 44100, layout: 'stereo', pin: 's16-dither', encoder: 'alac' } }), ['-c:a:0', 'alac']),
  encodeCase('alac-s32', 'stereo-44k.flac', chainSpec({ gainDb: -1.9, out: { sampleRate: 44100, layout: 'stereo', pin: 's32', encoder: 'alac' } }), ['-c:a:0', 'alac']),
  encodeCase('flac-s32-rate-change', 'stereo-96k.flac', chainSpec({ processRate: 96000, out: { sampleRate: 48000, layout: 'stereo', pin: 's32' } }), ['-c:a:0', 'flac']),
  encodeCase('pcm-s24', 'stereo-44k.flac', chainSpec({ gainDb: 12.64, out: { sampleRate: 44100, layout: 'stereo', pin: 's32' } }), ['-c:a:0', 'pcm_s24le']),
  encodeCase('mono-duplicated-s16', 'mono-44k.wav', chainSpec({ inputLayout: 'mono', monoToStereo: true, gainDb: 5 }), ['-c:a:0', 'pcm_s16le']),
  encodeCase('mono-duplicated-32k', 'mono-32k.wav', chainSpec({ inputLayout: 'mono', processRate: 32000, monoToStereo: true, gainDb: 5 }), ['-c:a:0', 'pcm_s16le']),
  encodeCase('mono-one-channel', 'mono-44k.wav', chainSpec({ inputLayout: 'mono', gainDb: 1, out: { sampleRate: 44100, layout: 'mono', pin: 's16-dither' } }), ['-c:a:0', 'pcm_s16le']),
  encodeCase('mono-duplicated-mp3-soxr', 'mono-44k.wav',
    chainSpec({ inputLayout: 'mono', monoToStereo: true, gainDb: 5, limiterCeilingDbtp: -2.5, out: { sampleRate: 44100, layout: 'stereo', pin: 'encoder' }, preEncodeMeter: 'soxr' }),
    ['-c:a:0', 'libmp3lame', '-b:a:0', '128k']),
  encodeCase('opus-51side-soxr', layoutFile('5.1(side)'),
    chainSpec({ ...SURROUND_48K, inputLayout: '5.1(side)', gainDb: -0.4, limiterCeilingDbtp: -3.5, out: { sampleRate: 48000, layout: '5.1', pin: 'encoder' }, preEncodeMeter: 'soxr' }),
    ['-c:a:0', 'libopus', '-b:a:0', '384k']),
  encodeCase('ac3-downmix-metadata-soxr', 'ac3-51side.ac3',
    chainSpec({ ...SURROUND_48K, inputLayout: '5.1(side)', downmix: 'standard', downmixLevels: AC3_DEFAULT_LEVELS, gainDb: 1.4, limiterCeilingDbtp: -2.5, out: STEREO_48K_ENCODER, preEncodeMeter: 'soxr' }),
    ['-c:a:0', 'ac3', '-b:a:0', '192k']),
  encodeCase('ac3-night-soxr', 'ac3-51side.ac3',
    chainSpec({ ...SURROUND_48K, inputLayout: '5.1(side)', dynamics: compressorStage(NIGHT, -22.6), gainDb: 10.5, limiterCeilingDbtp: -2.5, out: { sampleRate: 48000, layout: '5.1(side)', pin: 'encoder' }, preEncodeMeter: 'soxr' }),
    ['-c:a:0', 'ac3', '-b:a:0', '448k']),
  encodeCase('aac-swr', 'stereo-44k.flac',
    chainSpec({ gainDb: -8.9, limiterCeilingDbtp: -2.5, out: { sampleRate: 44100, layout: 'stereo', pin: 'encoder' }, preEncodeMeter: 'swr' }),
    ['-c:a:0', 'aac', '-b:a:0', '256k', '-aac_coder:a:0', 'fast']),
  encodeCase('flac-192k-no-oversampler', 'stereo-192k.wav', chainSpec({ processRate: 192000, out: { sampleRate: 192000, layout: 'stereo', pin: 's32' } }), ['-c:a:0', 'flac']),
  encodeCase('night-threshold-floor', 'stereo-44k.flac', chainSpec({ dynamics: compressorStage(NIGHT, -90) }), ['-c:a:0', 'flac']),
  encodeCase('night-threshold-top', 'stereo-44k.flac', chainSpec({ dynamics: compressorStage(NIGHT, 10) }), ['-c:a:0', 'flac']),
  encodeCase('limiter-clamp-low', 'stereo-44k.flac', chainSpec({ limiterCeilingDbtp: -30 }), ['-c:a:0', 'flac']),
  encodeCase('limiter-clamp-high', 'stereo-44k.flac', chainSpec({ limiterCeilingDbtp: 3 }), ['-c:a:0', 'flac']),
  {
    name: 'export-tail',
    inputs: ['stereo-44k.flac', 'stereo-44k.flac'],
    graph: `[0:a][1:a]amix=inputs=2:normalize=0[mix];${filterComplex([{ input: 'mix', stages: exportLimiterTail(EXPORT_CEILING, 44100, 'stereo'), output: 'aout' }])}`,
    map: '[aout]',
    codec: ['-c:a:0', 'aac', '-b:a:0', '192k', '-aac_coder:a:0', 'fast']
  }
]

const DOWNMIX_CASES: ChainCase[] =
[
  ...DOWNMIX_LAYOUTS.map((layout) => encodeCase(`downmix-bs775-${slug(layout)}`, layoutFile(layout),
    chainSpec({ ...SURROUND_48K, inputLayout: layout, downmix: 'standard', out: STEREO_48K_ENCODER }), ['-c:a:0', 'pcm_f32le'])),
  ...DOWNMIX_LAYOUTS.filter((layout) => LAYOUT_CHANNELS[layout].includes('FC')).map((layout) => encodeCase(`downmix-dialog-${slug(layout)}`, layoutFile(layout),
    chainSpec({ ...SURROUND_48K, inputLayout: layout, downmix: 'dialog', out: STEREO_48K_ENCODER }), ['-c:a:0', 'pcm_f32le'])),
  ...['3.0(back)', '4.0', '7.1'].map((layout) => encodeCase(`downmix-metadata-${slug(layout)}`, layoutFile(layout),
    chainSpec({ ...SURROUND_48K, inputLayout: layout, downmix: 'standard', downmixLevels: AC3_DEFAULT_LEVELS, out: STEREO_48K_ENCODER }), ['-c:a:0', 'pcm_f32le']))
]

function foldCase(layout: string, input: string, sampleRate: number, levels: DownmixLevels | null, name: string): ChainCase
{
  const fold = monoFoldStage(layout, levels)
  const stages = [...(fold === null ? [] : fold.stages), ...pinStages({ sampleRate, layout: 'mono', pin: 'encoder' })]
  return { name, inputs: [input], graph: filterComplex([{ input: '0:a:0', stages, output: 'a0' }]), map: '[a0]', codec: ['-c:a:0', 'pcm_f32le'] }
}

const FOLD_CASES: ChainCase[] =
[
  foldCase('stereo', 'stereo-44k.flac', 44100, null, 'fold-stereo'),
  foldCase('5.1(side)', 'ac3-51side.ac3', 48000, AC3_DEFAULT_LEVELS, 'fold-metadata-5.1-side'),
  ...DOWNMIX_LAYOUTS.map((layout) => foldCase(layout, layoutFile(layout), 48000, null, `fold-${slug(layout)}`))
]

export const CHAIN_CASES: ChainCase[] = [...ENCODE_CASES, ...DOWNMIX_CASES, ...FOLD_CASES]

export function chainRunArgs(chain: ChainCase): string[]
{
  return [
    ...chain.inputs.flatMap((input) => ['-i', `IN/${input}`]),
    '-filter_complex', chain.graph, '-map', chain.map, ...chain.codec, '-f', 'null', '-'
  ]
}

/** The two scenarios.json documents: the downmix probes, and the chain runs under chains/. */
export function scenarioDocuments(): { probes: unknown; chains: unknown }
{
  return {
    probes: { prefix: PROBE_PREFIX, inputs: PROBE_INPUTS, runs: PROBE_CASES.map((probe) => ({ name: probe.name, args: probeRunArgs(probe) })) },
    chains: { prefix: CHAIN_PREFIX, inputs: CHAIN_INPUTS, runs: CHAIN_CASES.map((chain) => ({ name: chain.name, args: chainRunArgs(chain) })) }
  }
}
