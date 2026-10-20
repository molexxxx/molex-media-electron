/**
 * The FFmpeg runs behind the verify fixtures. scenarios.json is generated from these cases, and verify.test.ts
 * checks that every recorded run still carries the arguments buildVerifyArgs produces. The zero-outputs run is
 * the graph buildVerifyArgs never builds: a passthrough branch that ends in anullsink.
 */
import { annex3Stage } from '../../../../../src/main/ffmpeg/audio/measure'
import { buildVerifyArgs } from '../../../../../src/main/ffmpeg/audio/verify'
import type { VerifySpec } from '../../../../../src/main/ffmpeg/audio/verify'

export interface FixtureInput
{
  name: string
  args: string[]
}

export interface VerifyCase
{
  name: string
  input: string
  meter: 'soxr' | 'swr'
  specs: VerifySpec[]
  /** Arguments used as they stand instead of buildVerifyArgs. */
  args?: string[]
}

/** The exec prefix of a killable run. */
export const EXEC_PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5']

const CHANNELS_71 = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']

function weights71(): string
{
  const result = annex3Stage('7.1', CHANNELS_71)
  if (!result.ok || result.stage === null)
  {
    throw new Error('7.1 needs the Annex 3 pre-scale')
  }
  return result.stage
}

function spec(outIndex: number, sampleRate: number, options: Partial<VerifySpec> = {}): VerifySpec
{
  return {
    outIndex,
    sampleRate,
    dualMono: false,
    weights: null,
    shortTerm: false,
    passthrough: false,
    preEncodeTruePeakDbtp: null,
    durationSec: 6,
    ...options
  }
}

export const ERROR_TITLE = '[error] live take'

export const VERIFY_INPUTS: FixtureInput[] =
[
  {
    name: 'out.flac',
    args: ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=44100:duration=6:seed=41:amplitude=0.3', '-ac', '2', '-c:a', 'flac']
  },
  {
    name: 'square.mp3',
    args: ['-f', 'lavfi', '-i', 'aevalsrc=0.9*sgn(sin(2*PI*441*t)):s=44100:d=4', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k']
  },
  {
    name: 'multi.mka',
    args: [
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=6:seed=51:amplitude=0.2',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=6:seed=52:amplitude=0.2',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex', '[0:a]pan=7.1|FL=c0|FR=c0|FC=c0|LFE=0*c0|BL=c0|BR=c0|SL=c0|SR=c0[w];[1:a]pan=stereo|c0=c0|c1=c0[s];[2:a]atrim=duration=6[z]',
      '-map', '[w]', '-map', '[s]', '-map', '[z]', '-c:a', 'flac'
    ]
  },
  {
    name: 'tagged.flac',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-metadata', `title=${ERROR_TITLE}`, '-c:a', 'flac']
  },
  {
    name: 'damaged.mp3',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=6', '-c:a', 'libmp3lame', '-b:a', '128k', '-bsf:a', 'noise=amount=200']
  }
]

export const VERIFY_CASES: VerifyCase[] =
[
  { name: 'flac-soxr', input: 'IN/out.flac', meter: 'soxr', specs: [spec(0, 44100)] },
  { name: 'flac-swr', input: 'IN/out.flac', meter: 'swr', specs: [spec(0, 44100)] },
  { name: 'mp3-overs', input: 'IN/square.mp3', meter: 'soxr', specs: [spec(0, 44100, { preEncodeTruePeakDbtp: -0.92 })] },
  {
    name: 'multi-mixed',
    input: 'IN/multi.mka',
    meter: 'soxr',
    specs: [spec(0, 48000, { weights: weights71() }), spec(1, 48000, { shortTerm: true }), spec(2, 48000, { passthrough: true })]
  },
  { name: 'passthrough-only', input: 'IN/multi.mka', meter: 'soxr', specs: [spec(2, 48000, { passthrough: true })] },
  {
    name: 'zero-outputs',
    input: 'IN/multi.mka',
    meter: 'soxr',
    specs: [],
    args: [
      '-loglevel', 'level+info', '-i', 'IN/multi.mka',
      '-filter_complex', '[0:a:2]astats@s2=measure_perchannel=none:measure_overall=Peak_level,anullsink',
      '-map', '0:a:2', '-f', 'null', '-'
    ]
  },
  { name: 'tagged-title', input: 'IN/tagged.flac', meter: 'soxr', specs: [spec(0, 48000)] },
  { name: 'damaged', input: 'IN/damaged.mp3', meter: 'soxr', specs: [spec(0, 44100, { preEncodeTruePeakDbtp: -18.2 })] },
  { name: 'missing-input', input: 'IN/missing.flac', meter: 'soxr', specs: [spec(0, 48000)] }
]

/** The arguments of a case after the exec prefix. */
export function caseArgs(run: VerifyCase): string[]
{
  return run.args ?? buildVerifyArgs(run.input, run.specs, run.meter)
}

/** The scenarios.json document of the verify fixtures. */
export function scenarioDocument(): object
{
  return {
    prefix: EXEC_PREFIX,
    inputs: VERIFY_INPUTS,
    runs: VERIFY_CASES.map((run) => ({ name: run.name, args: caseArgs(run) }))
  }
}
