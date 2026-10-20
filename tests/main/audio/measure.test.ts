/**
 * Loudness measurement (D3, D4, D10, D11, N11). The measure argv for every stream in one decode, the BS.1770-5
 * Annex 3 pre-scale for every layout, the cache key, and the labeled Summary parser on fixtures recorded from both
 * builds: 2022 prints a bogus first Summary per ebur128 instance, 9.0.2 one block; silence, a 0.3 s clip, a
 * -98 dBFS tone, brace tags in the input dump, the center-channel branch, and the short-term printer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ANNEX3_FACTOR, annex3Stage, buildMeasureArgs, classify, ebur128Stage, isSummaryLine, measureKey, parseEbur128Blocks,
  shortTermStage, streamBlock
} from '../../../src/main/ffmpeg/audio/measure'
import type { Ebur128Block, MeasureSpec } from '../../../src/main/ffmpeg/audio/measure'
import { meterPrefix } from '../../../src/main/ffmpeg/audio/chains'
import { execArgv } from '../../../src/main/ffmpeg/exec'
import type { AudioJobInput } from '../../../src/shared/audio/types'
import { CHANNELS_71, MEASURE_CASES, MEASURE_INPUTS, TAGGED_COMMENT, scenarioDocument } from '../fixtures/ffmpeg/measure/cases'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'measure')
const BUILDS = ['2022-10-13', '9.0.2'] as const

type Build = typeof BUILDS[number]

interface RunRecord
{
  name: string
  argv: string[]
  code: number | null
  stderr: string | null
}

function runs(build: Build): RunRecord[]
{
  return (JSON.parse(fs.readFileSync(path.join(FIXTURES, build, 'runs.json'), 'utf8')) as { runs: RunRecord[] }).runs
}

function stderrOf(build: Build, name: string): string
{
  const run = runs(build).find((candidate) => candidate.name === name)
  if (run === undefined || run.stderr === null)
  {
    throw new Error(`No recorded stderr for ${name} on ${build}`)
  }
  return fs.readFileSync(path.join(FIXTURES, build, run.stderr), 'utf8')
}

function flipLineEndings(text: string): string
{
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.replace(/\n/g, '\r\n')
}

const VARIANTS: ReadonlyArray<readonly [string, (text: string) => string]> =
[
  ['as captured', (text) => text],
  ['with flipped line endings', flipLineEndings]
]

const MATRIX = BUILDS.flatMap((build) => VARIANTS.map(([variant, transform]) => [build, variant, transform] as const))

const FLOAT = 'aformat=sample_fmts=dbl'

function spec(audioIndex: number, options: Partial<MeasureSpec> = {}): MeasureSpec
{
  return { audioIndex, pre: [FLOAT], dualMono: false, weights: null, shortTerm: false, dialogue: false, ...options }
}

function block(options: Partial<Ebur128Block> = {}): Ebur128Block
{
  return {
    integratedLufs: -23,
    thresholdLufs: -33,
    loudnessRangeLu: 6.5,
    lraLowLufs: -27,
    lraHighLufs: -20.5,
    truePeakDbtp: -4.1,
    maxShortTermLufs: null,
    ...options
  }
}

function job(options: Partial<AudioJobInput> = {}): AudioJobInput
{
  return {
    jobId: 'J1',
    sourcePath: 'C:/music/a.flac',
    sourceSize: 1000,
    sourceMtimeMs: 1700000000000,
    recipe: { kind: 'boost', presetId: 'custom', userPreset: null, gainDb: 0, highpassHz: 0, maxTruePeakDbtp: -1, maxLimitingDb: 2, mono: 'one-channel', output: { kind: 'same-as-source' } },
    facts: null,
    output: { container: 'flac', muxer: 'flac' },
    ...options
  }
}

/** The scaled channels of an Annex 3 pan stage. */
function scaledChannels(stage: string): string[]
{
  return stage.split('|').slice(1).filter((term) => term.includes(`${ANNEX3_FACTOR}*`)).map((term) => term.split('=')[0])
}

const LAYOUTS: Readonly<Record<string, readonly string[]>> =
{
  mono: ['FC'],
  stereo: ['FL', 'FR'],
  '2.1': ['FL', 'FR', 'LFE'],
  '3.0': ['FL', 'FR', 'FC'],
  '3.0(back)': ['FL', 'FR', 'BC'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  quad: ['FL', 'FR', 'BL', 'BR'],
  'quad(side)': ['FL', 'FR', 'SL', 'SR'],
  '3.1': ['FL', 'FR', 'FC', 'LFE'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'],
  '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'],
  hexagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'],
  '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'],
  '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'],
  '7.1': CHANNELS_71,
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
  '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  octagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR'],
  '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'],
  '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'],
  '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '7.2.3': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBC', 'LFE2'],
  hexadecagonal: ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'WL', 'WR']
}

describe('annex3Stage', () =>
{
  it('is 1 / sqrt(1.41) to six places', () =>
  {
    expect(ANNEX3_FACTOR).toBeCloseTo(1 / Math.sqrt(1.41), 6)
  })

  it('scales the 7.1 back pair, which sits beside the side pair', () =>
  {
    expect(annex3Stage('7.1', CHANNELS_71)).toEqual({
      ok: true,
      stage: 'pan=7.1|FL=FL|FR=FR|FC=FC|LFE=LFE|BL=0.842152*BL|BR=0.842152*BR|SL=SL|SR=SR'
    })
  })

  it.each([
    ['7.0', ['BL', 'BR']],
    ['7.1', ['BL', 'BR']],
    ['octagonal', ['BL', 'BR', 'BC']],
    ['6.0', ['BC']],
    ['6.1', ['BC']],
    ['6.1(back)', ['BC']],
    ['hexagonal', ['BC']],
    ['7.1.2', ['BL', 'BR']],
    ['7.1.4', ['BL', 'BR', 'TBL', 'TBR']],
    ['5.1.4', ['TBL', 'TBR']],
    ['7.2.3', ['BL', 'BR', 'TBC']]
  ])('pre-scales %s on %j and passes every other channel through', (layout, scaled) =>
  {
    const result = annex3Stage(layout, LAYOUTS[layout])
    if (!result.ok || result.stage === null)
    {
      throw new Error(`${layout} has no pre-scale`)
    }
    expect(result.stage.startsWith(`pan=${layout}|`)).toBe(true)
    expect(scaledChannels(result.stage)).toEqual(scaled)
    expect(result.stage.split('|').slice(1).map((term) => term.split('=')[0])).toEqual(LAYOUTS[layout])
    for (const term of result.stage.split('|').slice(1).filter((t) => !t.includes('*')))
    {
      const [out, source] = term.split('=')
      expect(source).toBe(out)
    }
  })

  it.each(['mono', 'stereo', '2.1', '3.0', '3.0(back)', '4.0', 'quad', 'quad(side)', '3.1', '5.0', '5.0(side)', '4.1', '5.1',
    '5.1(side)', '6.0(front)', '6.1(front)', '7.0(front)', '7.1(wide)', '7.1(wide-side)', '5.1.2'])(
    'needs no pre-scale for %s', (layout) =>
    {
      expect(annex3Stage(layout, LAYOUTS[layout])).toEqual({ ok: true, stage: null })
    })

  it('refuses a layout with WL and WR, which have no position in the table', () =>
  {
    expect(annex3Stage('hexadecagonal', LAYOUTS.hexadecagonal)).toEqual({ ok: false, channel: 'WL' })
    expect(annex3Stage('custom', ['FL', 'FR', 'WR'])).toEqual({ ok: false, channel: 'WR' })
  })

  it('has nothing to scale without channels', () =>
  {
    expect(annex3Stage('unknown', [])).toEqual({ ok: true, stage: null })
  })
})

describe('buildMeasureArgs', () =>
{
  it('measures two streams in one decode with the center-channel branch on the second', () =>
  {
    expect(buildMeasureArgs('IN/video_multi.mkv', [spec(0), spec(1, { dialogue: true })])).toEqual([
      '-loglevel', 'level+info', '-analyzeduration', '200M', '-probesize', '200M', '-i', 'IN/video_multi.mkv',
      '-filter_complex',
      '[0:a:0]aformat=sample_fmts=dbl,ebur128@m0=peak=true:dualmono=false:framelog=verbose[m0];[0:a:1]aformat=sample_fmts=dbl,asplit=2[p1][c1];[p1]ebur128@m1=peak=true:dualmono=false:framelog=verbose[m1];[c1]pan=mono|c0=FC,ebur128@d1=peak=none:dualmono=false:framelog=verbose,anullsink',
      '-map', '[m0]', '-map', '[m1]', '-f', 'null', '-'
    ])
  })

  it('reads loudness from the Annex 3 branch and the true peak from m<N>', () =>
  {
    const weights = annex3Stage('7.1', CHANNELS_71)
    if (!weights.ok)
    {
      throw new Error('7.1 is refused')
    }
    expect(buildMeasureArgs('IN/eq71.wav', [spec(0, { weights: weights.stage })])[9]).toBe(
      '[0:a:0]aformat=sample_fmts=dbl,asplit=2[p0][q0];[p0]ebur128@m0=peak=true:dualmono=false:framelog=verbose[m0];[q0]pan=7.1|FL=FL|FR=FR|FC=FC|LFE=LFE|BL=0.842152*BL|BR=0.842152*BR|SL=SL|SR=SR,ebur128@w0=peak=none:dualmono=false:framelog=verbose,anullsink'
    )
  })

  it('prints the short-term loudness after the meter that reads loudness', () =>
  {
    expect(buildMeasureArgs('IN/shortform30.wav', [spec(0, { shortTerm: true })])[9]).toBe(
      '[0:a:0]aformat=sample_fmts=dbl,ebur128@m0=peak=true:dualmono=false:framelog=verbose:metadata=1,ametadata@s0=mode=print:key=lavfi.r128.S[m0]'
    )
    const graph = buildMeasureArgs('IN/eq71.wav', [spec(2, { weights: 'pan=X', shortTerm: true, dialogue: true })])[9]
    expect(graph).toBe(
      '[0:a:2]aformat=sample_fmts=dbl,asplit=3[p2][q2][c2];[p2]ebur128@m2=peak=true:dualmono=false:framelog=verbose[m2];' +
      '[q2]pan=X,ebur128@w2=peak=none:dualmono=false:framelog=verbose:metadata=1,ametadata@s2=mode=print:key=lavfi.r128.S,anullsink;' +
      '[c2]pan=mono|c0=FC,ebur128@d2=peak=none:dualmono=false:framelog=verbose,anullsink'
    )
  })

  it('measures mono as one channel, as the delivered duplicate, or with the two-speaker convention (D3)', () =>
  {
    const prefix = { inputLayout: 'mono', downmix: null, dynamics: null }
    const one = buildMeasureArgs('IN/mono_speech.wav', [spec(0, { pre: meterPrefix({ ...prefix, monoToStereo: false }) })])[9]
    const duplicated = buildMeasureArgs('IN/mono_speech.wav', [spec(0, { pre: meterPrefix({ ...prefix, monoToStereo: true }) })])[9]
    const twoSpeakers = buildMeasureArgs('IN/mono_speech.wav', [spec(0, { dualMono: true })])[9]
    expect(one).toBe('[0:a:0]aformat=sample_fmts=dbl,ebur128@m0=peak=true:dualmono=false:framelog=verbose[m0]')
    expect(duplicated).toBe('[0:a:0]aformat=sample_fmts=dbl,pan=stereo|c0=c0|c1=c0,ebur128@m0=peak=true:dualmono=false:framelog=verbose[m0]')
    expect(twoSpeakers).toBe('[0:a:0]aformat=sample_fmts=dbl,ebur128@m0=peak=true:dualmono=true:framelog=verbose[m0]')
  })

  it('needs at least one stream', () =>
  {
    expect(() => buildMeasureArgs('IN/a.wav', [])).toThrow('at least one stream')
  })

  it('builds the stage helpers it shares with verification', () =>
  {
    expect(ebur128Stage('v3', 'none', true, true)).toBe('ebur128@v3=peak=none:dualmono=true:framelog=verbose:metadata=1')
    expect(shortTermStage('s3')).toBe('ametadata@s3=mode=print:key=lavfi.r128.S')
  })

  it('matches scenarios.json and the argv recorded on both builds', () =>
  {
    const document = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8')) as unknown
    expect(document).toEqual(JSON.parse(JSON.stringify(scenarioDocument())))
    expect(MEASURE_INPUTS.map((input) => input.name)).toContain('tagged.flac')
    for (const build of BUILDS)
    {
      const recorded = runs(build)
      expect(recorded.map((run) => run.name)).toEqual(MEASURE_CASES.map((run) => run.name))
      for (const run of MEASURE_CASES)
      {
        const record = recorded.find((candidate) => candidate.name === run.name)
        expect(record?.argv).toEqual(execArgv(buildMeasureArgs(run.input, run.specs), 'kill'))
        expect(record?.code).toBe(0)
      }
    }
  })
})

describe('measureKey', () =>
{
  const specs = [spec(0), spec(1, { dialogue: true })]

  it('is stable for the same source, build, and specs', () =>
  {
    expect(measureKey(job(), 'n9.0.2', specs)).toBe(measureKey(job({ jobId: 'J2' }), 'n9.0.2', specs.map((s) => ({ ...s }))))
  })

  it('separates two files with identical size and modification time', () =>
  {
    const a = measureKey(job({ sourcePath: 'C:/music/a.flac' }), 'n9.0.2', specs)
    const b = measureKey(job({ sourcePath: 'C:/music/b.flac' }), 'n9.0.2', specs)
    expect(a).not.toBe(b)
  })

  it('misses on a build change, a changed file, or a changed spec', () =>
  {
    const base = measureKey(job(), 'n9.0.2', specs)
    expect(measureKey(job(), '2022-10-13', specs)).not.toBe(base)
    expect(measureKey(job({ sourceSize: 1001 }), 'n9.0.2', specs)).not.toBe(base)
    expect(measureKey(job({ sourceMtimeMs: 1700000000001 }), 'n9.0.2', specs)).not.toBe(base)
    expect(measureKey(job(), 'n9.0.2', [spec(0, { dualMono: true }), specs[1]])).not.toBe(base)
    expect(measureKey(job(), 'n9.0.2', [spec(0, { weights: 'pan=X' }), specs[1]])).not.toBe(base)
    expect(measureKey(job(), 'n9.0.2', [spec(0, { shortTerm: true }), specs[1]])).not.toBe(base)
    expect(measureKey(job(), 'n9.0.2', [spec(0, { pre: [FLOAT, 'pan=stereo|c0=c0|c1=c0'] }), specs[1]])).not.toBe(base)
  })
})

describe('parseEbur128Blocks on recorded fixtures', () =>
{
  it.each(BUILDS)('2022 prints a bogus first Summary per instance and 9.0.2 one (%s)', (build) =>
  {
    const headers = stderrOf(build, 'two-streams').replace(/\r\n?/g, '\n').split('\n').filter(isSummaryLine)
    expect(headers.length).toBe(build === '2022-10-13' ? 6 : 3)
  })

  it.each(MATRIX)('keeps the last block per label for two streams and the center branch (%s, %s)', (build, _variant, transform) =>
  {
    const blocks = parseEbur128Blocks(transform(stderrOf(build, 'two-streams')))
    expect([...blocks.keys()].sort()).toEqual(['d1', 'm0', 'm1'])
    expect(blocks.get('m0')).toEqual({
      integratedLufs: -23.6,
      thresholdLufs: -33.6,
      loudnessRangeLu: 0.1,
      lraLowLufs: -23.7,
      lraHighLufs: -23.6,
      truePeakDbtp: -13.7,
      maxShortTermLufs: null
    })
    expect(blocks.get('m1')).toMatchObject({ integratedLufs: -22.3, thresholdLufs: -32.3, truePeakDbtp: -14 })
    expect(blocks.get('d1')).toMatchObject({ integratedLufs: -40.6, thresholdLufs: -50.6, truePeakDbtp: null })
    const stats = classify(streamBlock(blocks, spec(1, { dialogue: true })), 8, false, blocks.get('d1'))
    expect(stats).toMatchObject({ status: 'measured', integratedLufs: -22.3, dialogueLufs: -40.6, truePeakDbtp: -14 })
  })

  it.each(MATRIX)('takes loudness from the Annex 3 branch and the peak from m0 (%s, %s)', (build, _variant, transform) =>
  {
    const blocks = parseEbur128Blocks(transform(stderrOf(build, 'annex3-71')))
    const run = MEASURE_CASES.find((candidate) => candidate.name === 'annex3-71') as typeof MEASURE_CASES[number]
    const reading = streamBlock(blocks, run.specs[0])
    expect(blocks.get('m0')?.integratedLufs).toBe(-19.2)
    expect(reading).toMatchObject({ integratedLufs: -19.7, thresholdLufs: -29.7, truePeakDbtp: -15.6 })
    const overRead = (blocks.get('m0')?.integratedLufs ?? 0) - (reading?.integratedLufs ?? 0)
    expect(Math.abs(overRead - 10 * Math.log10(8.64 / 7.82))).toBeLessThanOrEqual(0.1)
    expect(classify(reading, run.durationSec, false, undefined, true).channelWeights).toBe('bs1770-annex3')
  })

  it.each(MATRIX)('keeps the largest short-term value above the placeholder (%s, %s)', (build, _variant, transform) =>
  {
    const text = transform(stderrOf(build, 'short-form'))
    expect(text.match(/lavfi\.r128\.S=-120\.691/g)?.length).toBe(29)
    expect(text.match(/lavfi\.r128\.S=/g)?.length).toBe(120)
    const blocks = parseEbur128Blocks(text)
    expect(blocks.get('s0')?.maxShortTermLufs).toBe(-30.645)
    const stats = classify(streamBlock(blocks, spec(0, { shortTerm: true })), 12, false, undefined)
    expect(stats).toMatchObject({
      status: 'measured',
      integratedLufs: -34.7,
      maxShortTermLufs: -30.645,
      loudnessRangeLu: null,
      lraStatus: 'not-applicable',
      truePeakDbtp: -17.5
    })
  })

  it.each(MATRIX)('reads every branch of one stream (%s, %s)', (build, _variant, transform) =>
  {
    const blocks = parseEbur128Blocks(transform(stderrOf(build, 'all-branches')))
    const run = MEASURE_CASES.find((candidate) => candidate.name === 'all-branches') as typeof MEASURE_CASES[number]
    const stats = classify(streamBlock(blocks, run.specs[0]), run.durationSec, false, blocks.get('d0'), true)
    expect(stats).toMatchObject({
      status: 'measured',
      integratedLufs: -19.7,
      maxShortTermLufs: -19.645,
      truePeakDbtp: -15.6,
      dialogueLufs: -28.6,
      channelWeights: 'bs1770-annex3'
    })
  })

  it.each(MATRIX)('classifies digital silence by its -inf peak (%s, %s)', (build, _variant, transform) =>
  {
    const blocks = parseEbur128Blocks(transform(stderrOf(build, 'silence')))
    expect(blocks.get('m0')).toMatchObject({ integratedLufs: -70, thresholdLufs: 0, truePeakDbtp: -Infinity })
    const stats = classify(streamBlock(blocks, spec(0)), 2, false, undefined)
    expect(stats).toMatchObject({ status: 'silent', integratedLufs: null, truePeakDbtp: null })
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats)
  })

  it.each(MATRIX)('classifies a 0.3 s clip as too short, its short-term values all placeholders (%s, %s)', (build, _variant, transform) =>
  {
    const text = transform(stderrOf(build, 'clip'))
    expect(text.match(/lavfi\.r128\.S=-120\.691/g)?.length).toBe(3)
    const blocks = parseEbur128Blocks(text)
    expect(blocks.get('s0')?.maxShortTermLufs).toBeNull()
    expect(blocks.get('m0')).toMatchObject({ integratedLufs: -70, thresholdLufs: 0, truePeakDbtp: -18.1 })
    expect(classify(streamBlock(blocks, spec(0, { shortTerm: true })), 0.3, false, undefined)).toMatchObject({
      status: 'too-short',
      integratedLufs: null,
      maxShortTermLufs: null,
      truePeakDbtp: -18.1
    })
  })

  it.each(MATRIX)('classifies a -98 dBFS tone as below the absolute gate (%s, %s)', (build, _variant, transform) =>
  {
    const blocks = parseEbur128Blocks(transform(stderrOf(build, 'quiet-tone')))
    expect(blocks.get('m0')).toMatchObject({ integratedLufs: -70, thresholdLufs: 0, truePeakDbtp: -98.1 })
    expect(classify(streamBlock(blocks, spec(0)), 3, false, undefined)).toMatchObject({ status: 'below-floor', truePeakDbtp: -98.1 })
  })

  it.each(MATRIX)('ignores Summary text inside tags in the input dump (%s, %s)', (build, _variant, transform) =>
  {
    const text = transform(stderrOf(build, 'brace-tags'))
    expect(text).toContain('{"input_i" : "-99.00"')
    expect(text).toContain(TAGGED_COMMENT.split('\n')[1])
    const blocks = parseEbur128Blocks(text)
    expect([...blocks.keys()]).toEqual(['m0'])
    expect(blocks.get('m0')).toMatchObject({ integratedLufs: -18.7, thresholdLufs: -28.7, truePeakDbtp: -18.1 })
  })
})

describe('parseEbur128Blocks', () =>
{
  const summary = (label: string, values: string[]): string =>
    [`[ebur128@${label} @ 0x55d0] Summary:`, '', '  Integrated loudness:', ...values].join('\n')

  it('turns non-finite values into null and keeps a -inf true peak', () =>
  {
    const text = [
      summary('m0', ['    I:         nan LUFS', '    Threshold: -inf LUFS', '', '  Loudness range:', '    LRA:         inf LU',
        '    Threshold:  -40.0 LUFS', '    LRA low:    -nan LUFS', '    LRA high:   -21.0 LUFS', '', '  True peak:', '    Peak:       -inf dBFS'])
    ].join('\n')
    expect(parseEbur128Blocks(text).get('m0')).toEqual({
      integratedLufs: null,
      thresholdLufs: null,
      loudnessRangeLu: null,
      lraLowLufs: null,
      lraHighLufs: -21,
      truePeakDbtp: -Infinity,
      maxShortTermLufs: null
    })
    const infinite = summary('m1', ['    I:         -20.0 LUFS', '', '  True peak:', '    Peak:        inf dBFS'])
    expect(parseEbur128Blocks(infinite).get('m1')?.truePeakDbtp).toBeNull()
  })

  it('ends a block at the next line that starts with [', () =>
  {
    const text = [summary('m0', ['    I:         -20.0 LUFS']), '[info] something else', '  True peak:', '    Peak:       -1.0 dBFS'].join('\r')
    expect(parseEbur128Blocks(text).get('m0')).toMatchObject({ integratedLufs: -20, truePeakDbtp: null })
  })

  it('ignores the sample peak section and unlabeled instances', () =>
  {
    const text = [
      summary('m0', ['    I:         -20.0 LUFS', '', '  Sample peak:', '    Peak:       -0.5 dBFS', '    Unknown:    -1.0 LUFS']),
      '[Parsed_ebur128_0 @ 0x55d1] Summary:',
      '    I:         -9.0 LUFS'
    ].join('\n')
    const blocks = parseEbur128Blocks(text)
    expect([...blocks.keys()]).toEqual(['m0'])
    expect(blocks.get('m0')).toMatchObject({ integratedLufs: -20, truePeakDbtp: null })
  })

  it('keeps the short-term maximum beside a Summary of the same label and skips values that are not numbers', () =>
  {
    const text = [
      '[ametadata@s0 @ 0x1] [info] lavfi.r128.S=-120.691',
      '[ametadata@s0 @ 0x1] [info] lavfi.r128.S=nan',
      '[ametadata@s0 @ 0x1] [info] lavfi.r128.S=-25.500',
      '[ametadata@s0 @ 0x1] [info] lavfi.r128.S=-26.000',
      '[ametadata@s1 @ 0x2] lavfi.r128.S=-31.250'
    ].join('\n')
    const blocks = parseEbur128Blocks(text)
    expect(blocks.get('s0')?.maxShortTermLufs).toBe(-25.5)
    expect(blocks.get('s0')?.integratedLufs).toBeNull()
    expect(blocks.get('s1')?.maxShortTermLufs).toBe(-31.25)
  })

  it('returns an empty map without Summary lines', () =>
  {
    expect(parseEbur128Blocks('').size).toBe(0)
    expect(isSummaryLine('[ebur128@m0 @ 0x1] [info] Summary:')).toBe(true)
    expect(isSummaryLine('[info]     comment : [ebur128@m0 @ 0x1] [info] Summary:')).toBe(false)
  })
})

describe('streamBlock', () =>
{
  const blocks = new Map<string, Ebur128Block>([
    ['m0', block({ integratedLufs: -19.2, truePeakDbtp: -3 })],
    ['w0', block({ integratedLufs: -19.7, truePeakDbtp: null })],
    ['s0', block({ integratedLufs: null, truePeakDbtp: null, maxShortTermLufs: -15.2 })]
  ])

  it('is undefined when a block it needs is missing', () =>
  {
    expect(streamBlock(blocks, spec(1))).toBeUndefined()
    expect(streamBlock(new Map([['m0', block()]]), spec(0, { weights: 'pan=X' }))).toBeUndefined()
  })

  it('reads the short-term maximum only when the spec records it', () =>
  {
    expect(streamBlock(blocks, spec(0))).toMatchObject({ integratedLufs: -19.2, truePeakDbtp: -3, maxShortTermLufs: null })
    expect(streamBlock(blocks, spec(0, { weights: 'pan=X', shortTerm: true }))).toMatchObject({
      integratedLufs: -19.7,
      truePeakDbtp: -3,
      maxShortTermLufs: -15.2
    })
    expect(streamBlock(new Map([['m0', block()]]), spec(0, { shortTerm: true }))?.maxShortTermLufs).toBeNull()
  })
})

describe('classify', () =>
{
  it('is silent without a block or a true peak', () =>
  {
    expect(classify(undefined, 10, false, undefined).status).toBe('silent')
    expect(classify(block({ truePeakDbtp: null }), 10, false, undefined).status).toBe('silent')
    expect(classify(block({ truePeakDbtp: -Infinity }), 10, true, undefined)).toEqual({
      status: 'silent',
      integratedLufs: null,
      thresholdLufs: null,
      loudnessRangeLu: null,
      lraStatus: 'not-applicable',
      maxShortTermLufs: null,
      truePeakDbtp: null,
      dialogueLufs: null,
      dualMono: true,
      channelWeights: 'bs1770-annex1'
    })
  })

  it('splits a failed absolute gate at one gating block of 0.4 s', () =>
  {
    const gated = block({ integratedLufs: -70, thresholdLufs: 0, truePeakDbtp: -30 })
    expect(classify(gated, 0.39, false, undefined).status).toBe('too-short')
    expect(classify(gated, 0.4, false, undefined).status).toBe('below-floor')
    expect(classify(gated, null, false, undefined).status).toBe('below-floor')
    expect(classify(block({ integratedLufs: null }), 0.2, false, undefined).status).toBe('too-short')
    expect(classify(block({ integratedLufs: -70, thresholdLufs: -80 }), 5, false, undefined).status).toBe('measured')
  })

  it('reports the loudness range only for items of a minute or more', () =>
  {
    expect(classify(block(), 59.9, false, undefined)).toMatchObject({ loudnessRangeLu: null, lraStatus: 'not-applicable' })
    expect(classify(block(), 60, false, undefined)).toMatchObject({ loudnessRangeLu: 6.5, lraStatus: 'measured' })
    expect(classify(block(), null, false, undefined)).toMatchObject({ loudnessRangeLu: null, lraStatus: 'not-applicable' })
  })

  it('adds the center-channel estimate only when its branch passed the gate', () =>
  {
    expect(classify(block(), 90, false, block({ integratedLufs: -31.4, truePeakDbtp: null })).dialogueLufs).toBe(-31.4)
    expect(classify(block(), 90, false, block({ integratedLufs: -70, thresholdLufs: 0 })).dialogueLufs).toBeNull()
    expect(classify(block(), 90, false, undefined).dialogueLufs).toBeNull()
  })

  it('records the measured values and the channel weights', () =>
  {
    expect(classify(block({ maxShortTermLufs: -18.2 }), 90, true, undefined, true)).toEqual({
      status: 'measured',
      integratedLufs: -23,
      thresholdLufs: -33,
      loudnessRangeLu: 6.5,
      lraStatus: 'measured',
      maxShortTermLufs: -18.2,
      truePeakDbtp: -4.1,
      dialogueLufs: null,
      dualMono: true,
      channelWeights: 'bs1770-annex3'
    })
  })
})
