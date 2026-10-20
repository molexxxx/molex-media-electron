/**
 * The FFmpeg runs behind the measure fixtures. scenarios.json is generated from these cases, and measure.test.ts
 * checks that every recorded run still carries the arguments buildMeasureArgs produces, so a builder change shows
 * until the fixtures are captured again on both builds.
 */
import { annex3Stage, buildMeasureArgs } from '../../../../../src/main/ffmpeg/audio/measure'
import type { MeasureSpec } from '../../../../../src/main/ffmpeg/audio/measure'

export interface FixtureInput
{
  name: string
  args: string[]
}

export interface MeasureCase
{
  name: string
  input: string
  durationSec: number
  specs: MeasureSpec[]
}

/** The exec prefix of a killable run. */
export const EXEC_PREFIX = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5']

const FLOAT = 'aformat=sample_fmts=dbl'

export const CHANNELS_71 = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']

function weights71(): string
{
  const result = annex3Stage('7.1', CHANNELS_71)
  if (!result.ok || result.stage === null)
  {
    throw new Error('7.1 needs the Annex 3 pre-scale')
  }
  return result.stage
}

function spec(audioIndex: number, options: Partial<MeasureSpec> = {}): MeasureSpec
{
  return { audioIndex, pre: [FLOAT], dualMono: false, weights: null, shortTerm: false, dialogue: false, ...options }
}

export const TAGGED_COMMENT = 'first line\n[ebur128@m0 @ 0000000000000000] [info] Summary:\n    I:          -1.0 LUFS\n    Peak:        0.0 dBFS'

export const MEASURE_INPUTS: FixtureInput[] =
[
  {
    name: 'multi.mkv',
    args: [
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=8:seed=11:amplitude=0.25',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=8:seed=12:amplitude=0.25',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=8:seed=13:amplitude=0.05',
      '-filter_complex', '[0:a]pan=stereo|c0=c0|c1=c0[st];[1:a][2:a]amerge=inputs=2,pan=5.1(side)|FL=c0|FR=c0|FC=c1|LFE=0*c0|SL=0.5*c0|SR=0.5*c0[sur]',
      '-map', '[st]', '-map', '[sur]', '-c:a', 'flac'
    ]
  },
  {
    name: 'eq71.wav',
    args: [
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=6:seed=21:amplitude=0.2',
      '-af', 'pan=7.1|FL=c0|FR=c0|FC=c0|LFE=0*c0|BL=c0|BR=c0|SL=c0|SR=c0', '-c:a', 'pcm_s24le'
    ]
  },
  {
    name: 'shortform.wav',
    args: [
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:sample_rate=48000:duration=12:seed=31:amplitude=0.05',
      '-af', 'volume=volume=10dB:enable=\'gte(t,8)\'', '-c:a', 'pcm_s24le'
    ]
  },
  { name: 'silence.wav', args: ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '2', '-c:a', 'pcm_s16le'] },
  { name: 'clip.wav', args: ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=0.3', '-c:a', 'pcm_s16le'] },
  {
    name: 'quiet.wav',
    args: ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=3', '-af', 'volume=-80dB', '-c:a', 'pcm_f32le']
  },
  {
    name: 'tagged.flac',
    args: [
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-metadata', 'title={"input_i" : "-99.00", "input_tp" : "+5.00", "input_lra" : "0.00", "target_offset" : "0.00"}',
      '-metadata', `comment=${TAGGED_COMMENT}`, '-c:a', 'flac'
    ]
  }
]

export const MEASURE_CASES: MeasureCase[] =
[
  { name: 'two-streams', input: 'IN/multi.mkv', durationSec: 8, specs: [spec(0), spec(1, { dialogue: true })] },
  { name: 'annex3-71', input: 'IN/eq71.wav', durationSec: 6, specs: [spec(0, { weights: weights71() })] },
  { name: 'all-branches', input: 'IN/eq71.wav', durationSec: 6, specs: [spec(0, { weights: weights71(), shortTerm: true, dialogue: true })] },
  { name: 'short-form', input: 'IN/shortform.wav', durationSec: 12, specs: [spec(0, { shortTerm: true })] },
  { name: 'silence', input: 'IN/silence.wav', durationSec: 2, specs: [spec(0)] },
  { name: 'clip', input: 'IN/clip.wav', durationSec: 0.3, specs: [spec(0, { shortTerm: true })] },
  { name: 'quiet-tone', input: 'IN/quiet.wav', durationSec: 3, specs: [spec(0)] },
  { name: 'brace-tags', input: 'IN/tagged.flac', durationSec: 4, specs: [spec(0, { dualMono: true })] }
]

/** The scenarios.json document of the measure fixtures. */
export function scenarioDocument(): object
{
  return {
    prefix: EXEC_PREFIX,
    inputs: MEASURE_INPUTS,
    runs: MEASURE_CASES.map((run) => ({ name: run.name, args: buildMeasureArgs(run.input, run.specs) }))
  }
}
