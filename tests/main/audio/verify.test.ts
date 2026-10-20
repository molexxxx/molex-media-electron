/**
 * Output verification (D6, D16). The verify argv for soxr and swresample, passthrough streams mapped without a
 * graph branch, the parser over fixtures recorded from both builds (decode errors with one, two, or no context
 * prefixes, fatal lines, a title that contains [error], a damaged file with more errors than are kept), the judge
 * for every outcome and the swresample margin, the corrective encode, and the choice between two passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  CORRECTION_STEP_DB, LIMITER_FLOOR_DBTP, MAX_DECODE_ERRORS, METER_MARGIN_DB, better, buildVerifyArgs, correctedPlan, correction,
  isDecodeError, judge, parseVerify
} from '../../../src/main/ffmpeg/audio/verify'
import type { VerifySpec } from '../../../src/main/ffmpeg/audio/verify'
import { execArgv, signedExitCode } from '../../../src/main/ffmpeg/exec'
import type { Ceiling, GainPlan, LoudnessTarget, StreamVerdict, VerifiedStream } from '../../../src/shared/audio/types'
import { ERROR_TITLE, VERIFY_CASES, caseArgs, scenarioDocument } from '../fixtures/ffmpeg/verify/cases'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'verify')
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

const VARIANTS: ReadonlyArray<readonly [string, (text: string) => Iterable<string>]> =
[
  ['as captured', (text) => [text]],
  ['with flipped line endings', (text) => [flipLineEndings(text)]],
  ['as a line stream', (text) => text.split('\n')]
]

const MATRIX = BUILDS.flatMap((build) => VARIANTS.map(([variant, transform]) => [build, variant, transform] as const))

function caseOf(name: string): typeof VERIFY_CASES[number]
{
  const found = VERIFY_CASES.find((candidate) => candidate.name === name)
  if (found === undefined)
  {
    throw new Error(`No case ${name}`)
  }
  return found
}

function parseCase(build: Build, name: string, transform: (text: string) => Iterable<string>): ReturnType<typeof parseVerify>
{
  const run = caseOf(name)
  return parseVerify(transform(stderrOf(build, name)), run.specs, run.meter)
}

function verifySpec(outIndex: number, options: Partial<VerifySpec> = {}): VerifySpec
{
  return { outIndex, sampleRate: 44100, dualMono: false, weights: null, shortTerm: false, passthrough: false, preEncodeTruePeakDbtp: null, ...options }
}

function ceiling(options: Partial<Ceiling> = {}): Ceiling
{
  return {
    presetMaxDbtp: -1,
    codecCeilingDbtp: null,
    ceilingDbtp: -1,
    limiterCeilingDbtp: -1.5,
    gateDbtp: -1,
    decodedLimitDbtp: -1,
    outputClass: 'lossless',
    reason: 'lossless',
    basis: 'standard',
    ...options
  }
}

function plan(options: Partial<GainPlan> = {}): GainPlan
{
  return {
    audioIndex: 0,
    mode: 'linear',
    reason: 'fits',
    targetLufs: -23,
    requestedGainDb: 3,
    gainDb: 3,
    headroomDb: 5.5,
    limitingDb: 0,
    maxLimitingDb: 1,
    predictedLufs: -23,
    predictedTruePeakDbtp: -4,
    shortTermLimitLufs: null,
    predictedMaxShortTermLufs: null,
    ceiling: ceiling(),
    ...options
  }
}

function verified(options: Partial<VerifiedStream> = {}): VerifiedStream
{
  return {
    outIndex: 0,
    integratedLufs: -23,
    loudnessRangeLu: null,
    maxShortTermLufs: null,
    preEncodeTruePeakDbtp: -4,
    truePeakDbtp: -4,
    samplePeakDbfs: -4.2,
    meter: 'soxr-8x',
    ...options
  }
}

function target(options: Partial<LoudnessTarget> = {}): LoudnessTarget
{
  return { integratedLufs: -23, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 1, unit: 'LUFS', ...options }
}

const R128_SHORT = { limit: -18, toleranceLu: 0.2 }

describe('buildVerifyArgs', () =>
{
  it('splits each measured stream three ways with the soxr reference', () =>
  {
    expect(buildVerifyArgs('OUT/D.flac', [verifySpec(0)], 'soxr')).toEqual([
      '-loglevel', 'level+info', '-i', 'OUT/D.flac',
      '-filter_complex',
      '[0:a:0]asplit=3[x0][y0][z0];[x0]aformat=sample_fmts=dbl,ebur128@v0=peak=none:dualmono=false:framelog=verbose[v0];[y0]aformat=sample_fmts=dbl,aresample=resampler=soxr:precision=33:osr=352800:osf=dbl,astats@t0=measure_perchannel=none:measure_overall=Peak_level,anullsink;[z0]astats@s0=measure_perchannel=none:measure_overall=Peak_level,anullsink',
      '-map', '[v0]', '-f', 'null', '-'
    ])
  })

  it('uses swresample without libsoxr', () =>
  {
    const graph = buildVerifyArgs('OUT/D.flac', [verifySpec(0)], 'swr')[5]
    expect(graph).toContain('[y0]aformat=sample_fmts=dbl,aresample=osr=352800:osf=dbl,astats@t0=')
    expect(graph).not.toContain('soxr')
  })

  it('puts the Annex 3 pre-scale and the short-term printer on the loudness branch only', () =>
  {
    const graph = buildVerifyArgs('OUT/E.mkv', [verifySpec(1, { sampleRate: 48000, weights: 'pan=X', shortTerm: true, dualMono: true })], 'soxr')[5]
    expect(graph.split(';')).toEqual([
      '[0:a:1]asplit=3[x1][y1][z1]',
      '[x1]aformat=sample_fmts=dbl,pan=X,ebur128@v1=peak=none:dualmono=true:framelog=verbose:metadata=1,ametadata@s1=mode=print:key=lavfi.r128.S[v1]',
      '[y1]aformat=sample_fmts=dbl,aresample=resampler=soxr:precision=33:osr=384000:osf=dbl,astats@t1=measure_perchannel=none:measure_overall=Peak_level,anullsink',
      '[z1]astats@s1=measure_perchannel=none:measure_overall=Peak_level,anullsink'
    ])
  })

  it('maps passthrough streams directly and leaves the graph out when nothing is measured', () =>
  {
    const mixed = buildVerifyArgs('OUT/F.mkv', [verifySpec(0), verifySpec(2, { passthrough: true })], 'soxr')
    expect(mixed.slice(6)).toEqual(['-map', '[v0]', '-map', '0:a:2', '-f', 'null', '-'])
    expect(mixed[5]).not.toContain('0:a:2')
    expect(buildVerifyArgs('OUT/G.flac', [verifySpec(0, { passthrough: true })], 'soxr')).toEqual([
      '-loglevel', 'level+info', '-i', 'OUT/G.flac', '-map', '0:a:0', '-f', 'null', '-'
    ])
  })

  it('matches scenarios.json and the argv recorded on both builds', () =>
  {
    const document = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8')) as unknown
    expect(document).toEqual(JSON.parse(JSON.stringify(scenarioDocument())))
    for (const build of BUILDS)
    {
      const recorded = runs(build)
      expect(recorded.map((run) => run.name)).toEqual(VERIFY_CASES.map((run) => run.name))
      for (const run of VERIFY_CASES)
      {
        expect(recorded.find((candidate) => candidate.name === run.name)?.argv).toEqual(execArgv(caseArgs(run), 'kill'))
      }
    }
  })

  it('records why a graph without outputs is never built: 9.0.2 exits -40 where 2022 exits 0', () =>
  {
    const code = (build: Build, name: string): number | null =>
      signedExitCode(runs(build).find((run) => run.name === name)?.code ?? null)
    expect(code('2022-10-13', 'zero-outputs')).toBe(0)
    expect(code('9.0.2', 'zero-outputs')).toBe(-40)
    expect(code('2022-10-13', 'passthrough-only')).toBe(0)
    expect(code('9.0.2', 'passthrough-only')).toBe(0)
    expect(code('9.0.2', 'damaged')).toBe(0)
    expect(code('2022-10-13', 'damaged')).toBe(0)
  })
})

describe('isDecodeError', () =>
{
  it.each([
    '[mp3float @ 000001f07e79cec0] [error] Header missing',
    '[aist#0:0/mp3 @ 00000171b752bc00] [dec:mp3float @ 00000171b752b000] [error] Error submitting packet to decoder: x',
    '[error] Error while decoding stream #0:0: Invalid data found when processing input',
    '[fatal] Error opening input files: No such file or directory',
    '[fc#0 @ 00000238111cfd40] [fatal] A filtergraph has zero outputs, this is not supported',
    '[panic] Assertion failed'
  ])('matches %s', (line) =>
  {
    expect(isDecodeError(line)).toBe(true)
  })

  it.each([
    `[info]     title           : ${ERROR_TITLE}`,
    '[info] [error] tagged text',
    '[warning] Estimating duration from bitrate',
    '[mp3float @ 0x1] [warning] [error] quoted',
    'Error while decoding stream #0:0',
    '[mp3float @ 0x1] [error]Header missing',
    ''
  ])('ignores %j', (line) =>
  {
    expect(isDecodeError(line)).toBe(false)
  })
})

describe('parseVerify on recorded fixtures', () =>
{
  it.each(MATRIX)('reads the soxr and swresample references of a FLAC output (%s, %s)', (build, _variant, transform) =>
  {
    const soxr = parseCase(build, 'flac-soxr', transform)
    expect(soxr.decodeErrorCount).toBe(0)
    expect(soxr.streams.get(0)).toEqual({
      outIndex: 0,
      integratedLufs: -25.1,
      loudnessRangeLu: 0.1,
      maxShortTermLufs: null,
      preEncodeTruePeakDbtp: -14.630675,
      truePeakDbtp: -14.630675,
      samplePeakDbfs: -14.78779,
      meter: 'soxr-8x'
    })
    const swr = parseCase(build, 'flac-swr', transform)
    expect(swr.streams.get(0)).toMatchObject({ truePeakDbtp: -14.626676, samplePeakDbfs: -14.78779, meter: 'swr-8x' })
  })

  it.each(MATRIX)('keeps the encode run pre-encode value of a lossy output (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseCase(build, 'mp3-overs', transform)
    expect(result.decodeErrorCount).toBe(0)
    expect(result.streams.get(0)).toMatchObject(build === '2022-10-13'
      ? { integratedLufs: -1.4, preEncodeTruePeakDbtp: -0.92, truePeakDbtp: -1.787952, samplePeakDbfs: -1.995838 }
      : { integratedLufs: -1.4, preEncodeTruePeakDbtp: -0.92, truePeakDbtp: 0.119464, samplePeakDbfs: -0.456459 })
  })

  it.each(MATRIX)('reads two measured streams and decode-checks the passthrough one (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseCase(build, 'multi-mixed', transform)
    expect(result.decodeErrorCount).toBe(0)
    expect([...result.streams.keys()].sort()).toEqual([0, 1])
    expect(result.streams.get(0)).toMatchObject({
      integratedLufs: -19.6,
      maxShortTermLufs: null,
      truePeakDbtp: -15.654295,
      samplePeakDbfs: -15.603266
    })
    expect(result.streams.get(1)).toMatchObject({
      integratedLufs: -25.6,
      maxShortTermLufs: -25.571,
      truePeakDbtp: -14.884291,
      samplePeakDbfs: -15.348135
    })
  })

  it.each(MATRIX)('passes a passthrough-only decode with no stream entries (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseCase(build, 'passthrough-only', transform)
    expect(result).toEqual({ streams: new Map(), decodeErrors: [], decodeErrorCount: 0 })
  })

  it.each(MATRIX)('does not count a title that contains [error] (%s, %s)', (build, _variant, transform) =>
  {
    const text = stderrOf(build, 'tagged-title')
    expect(text.split(/\r?\n/).filter((line) => line.includes('[error]'))).toEqual([
      `[info]     title           : ${ERROR_TITLE}`,
      `[info]     title           : ${ERROR_TITLE}`
    ])
    const result = parseCase(build, 'tagged-title', transform)
    expect(result.decodeErrorCount).toBe(0)
    expect(result.streams.get(0)).toMatchObject({ integratedLufs: -21.8, samplePeakDbfs: -18.063656 })
  })

  it.each(MATRIX)('keeps the first 20 errors of a damaged file and counts every one (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseCase(build, 'damaged', transform)
    expect(result.decodeErrorCount).toBe(build === '2022-10-13' ? 43 : 32)
    expect(result.decodeErrors).toHaveLength(MAX_DECODE_ERRORS)
    const lines = stderrOf(build, 'damaged').split(/\r?\n/).filter((line) => /\[(?:error|fatal|panic)\]/.test(line))
    expect(result.decodeErrors).toEqual(lines.slice(0, MAX_DECODE_ERRORS))
    expect(result.decodeErrors[0]).toMatch(/^\[mp3float @ [0-9a-f]+\] \[error\] Header missing$/)
    if (build === '2022-10-13')
    {
      expect(result.decodeErrors[2]).toBe('[error] Error while decoding stream #0:0: Invalid data found when processing input')
    }
    else
    {
      expect(result.decodeErrors[1]).toMatch(/^\[aist#0:0\/mp3 @ [0-9a-f]+\] \[dec:mp3float @ [0-9a-f]+\] \[error\] Error submitting packet to decoder: /)
    }
  })

  it.each(MATRIX)('counts the fatal lines of a graph without outputs on 9.0.2 only (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseVerify(transform(stderrOf(build, 'zero-outputs')), [verifySpec(2, { passthrough: true })], 'soxr')
    if (build === '2022-10-13')
    {
      expect(result.decodeErrorCount).toBe(0)
      return
    }
    expect(result.decodeErrors).toHaveLength(2)
    expect(result.decodeErrors[0]).toMatch(/^\[fc#0 @ [0-9a-f]+\] \[fatal\] A filtergraph has zero outputs, this is not supported$/)
    expect(result.decodeErrors[1]).toBe('[fatal] Error : Function not implemented')
  })

  it.each(MATRIX)('fails a missing input with no stream entries (%s, %s)', (build, _variant, transform) =>
  {
    const result = parseCase(build, 'missing-input', transform)
    expect(result.streams.size).toBe(0)
    expect(result.decodeErrors).toEqual(build === '2022-10-13'
      ? ['[error] IN/missing.flac: No such file or directory']
      : [
          expect.stringMatching(/^\[in#0 @ [0-9a-f]+\] \[error\] Error opening input: No such file or directory$/),
          '[error] Error opening input file IN/missing.flac.',
          '[fatal] Error opening input files: No such file or directory'
        ])
  })
})

describe('parseVerify', () =>
{
  it('treats non-numeric peaks as missing and ignores lines outside Summary blocks', () =>
  {
    const text = [
      '[astats@t0 @ 0x1] [info] Peak level dB: nan',
      '[astats@s0 @ 0x2] [info] Peak level dB: -inf',
      '    I:         -9.0 LUFS',
      '[ebur128@v0 @ 0x3] [info] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -16.0 LUFS',
      '    Threshold: -26.0 LUFS'
    ].join('\n')
    expect(parseVerify(text, [verifySpec(0, { preEncodeTruePeakDbtp: -1.2 })], 'swr').streams.get(0)).toEqual({
      outIndex: 0,
      integratedLufs: -16,
      loudnessRangeLu: null,
      maxShortTermLufs: null,
      preEncodeTruePeakDbtp: -1.2,
      truePeakDbtp: null,
      samplePeakDbfs: null,
      meter: 'swr-8x'
    })
  })

  it('has no short-term maximum when the printer wrote nothing', () =>
  {
    const text = ['[ebur128@v0 @ 0x3] [info] Summary:', '', '  Integrated loudness:', '    I:         -16.0 LUFS'].join('\r\n')
    expect(parseVerify([text], [verifySpec(0, { shortTerm: true })], 'soxr').streams.get(0)?.maxShortTermLufs).toBeNull()
  })

  it('leaves out a measured stream whose Summary is missing', () =>
  {
    expect(parseVerify(['[astats@t0 @ 0x1] [info] Peak level dB: -3.0'], [verifySpec(0)], 'soxr').streams.size).toBe(0)
  })
})

describe('judge', () =>
{
  it('verifies a linear plan within tolerance, its bounds inclusive', () =>
  {
    const verdict = judge(plan(), verified({ integratedLufs: -24 }), target(), 1, 1, 0)
    expect(verdict).toEqual({
      audioIndex: 0,
      outcome: 'verified',
      loudness: {
        status: 'within',
        reference: 'target',
        referenceLufs: -23,
        deviationLu: -1,
        toleranceLu: 1,
        standardTolerance: { value: 1, unit: 'LU' }
      },
      shortTerm: { status: 'not-checked', limitLufs: null, maxLufs: null, toleranceLu: 0 },
      truePeak: { status: 'within', basis: 'pre-encode', gateDbtp: -1, overDb: null },
      decoded: { status: 'within', limitDbtp: -1, overDb: null },
      samplePeakOver: false,
      warnings: [],
      meterMarginDb: 0,
      encodePasses: 1
    })
    expect(judge(plan(), verified({ integratedLufs: -22.6 }), target(), 0.4, 1, 0).loudness).toMatchObject({ status: 'within', deviationLu: 0.4 })
  })

  it('is outside tolerance below or above the reference', () =>
  {
    const below = judge(plan(), verified({ integratedLufs: -24.1 }), target(), 1, 1, 0)
    const above = judge(plan(), verified({ integratedLufs: -21.9 }), target(), 1, 2, 0)
    expect(below).toMatchObject({ outcome: 'outside-tolerance', loudness: { status: 'below', deviationLu: -1.1 } })
    expect(above).toMatchObject({ outcome: 'outside-tolerance', loudness: { status: 'above', deviationLu: 1.1 }, encodePasses: 2 })
  })

  it('judges an album member against its own level, not the recipe target', () =>
  {
    const member = plan({ targetLufs: -21.4, predictedLufs: -21.4 })
    expect(judge(member, verified({ integratedLufs: -21.4 }), target(), 0.5, 1, 0).loudness).toMatchObject({ referenceLufs: -21.4, deviationLu: 0 })
  })

  it('verifies reachable plans, including a short-term cap, against the predicted level', () =>
  {
    const reachable = plan({ mode: 'reachable-linear', reason: 'headroom-capped', predictedLufs: -25.4 })
    expect(judge(reachable, verified({ integratedLufs: -25.4 }), target(), 1, 1, 0)).toMatchObject({
      outcome: 'verified-below-target',
      loudness: { reference: 'reachable', referenceLufs: -25.4, deviationLu: 0 }
    })
    const capped = plan({ mode: 'reachable-limited', reason: 'short-term-capped', predictedLufs: -24.2, shortTermLimitLufs: -18 })
    expect(judge(capped, verified({ integratedLufs: -24.3, maxShortTermLufs: -18.1 }), target(), 0.5, 1, 0, 0.2).outcome)
      .toBe('verified-below-target')
    const peakLimited = plan({ mode: 'peak-limited', reason: 'needs-limiting', predictedLufs: -23.4 })
    expect(judge(peakLimited, verified({ integratedLufs: -23.4 }), target(), 0.5, 1, 0).loudness.referenceLufs).toBe(-23)
  })

  it('fails on decode errors and on a missing verification, and reports passthrough streams', () =>
  {
    expect(judge(plan(), verified(), target(), 1, 1, 3).outcome).toBe('failed')
    expect(judge(plan(), undefined, target(), 1, 1, 0)).toMatchObject({
      outcome: 'failed',
      loudness: { status: 'not-checked', deviationLu: null },
      truePeak: { status: 'not-checked', overDb: null },
      decoded: { status: 'not-checked' },
      meterMarginDb: 0
    })
    const passthrough = plan({ mode: 'passthrough', reason: 'silent', gainDb: 0, predictedLufs: null, predictedTruePeakDbtp: null })
    expect(judge(passthrough, undefined, target(), 1, 1, 0)).toMatchObject({
      outcome: 'passthrough',
      loudness: { status: 'not-checked', referenceLufs: null }
    })
    expect(judge(passthrough, undefined, target(), 1, 1, 1).outcome).toBe('failed')
  })

  it.each([
    ['-0.21', -1.21, 'within', null],
    ['-0.20', -1.2, 'within', null],
    ['-0.19', -1.19, 'over', 0.01]
  ] as const)('applies the swresample margin %s dB from the gate', (_offset, peak, status, overDb) =>
  {
    const swr = judge(plan(), verified({ preEncodeTruePeakDbtp: peak, meter: 'swr-8x' }), target(), 1, 1, 0)
    expect(swr.meterMarginDb).toBe(METER_MARGIN_DB.swr)
    expect(swr.truePeak).toEqual({ status, basis: 'pre-encode', gateDbtp: -1, overDb })
    expect(swr.outcome).toBe(status === 'within' ? 'verified' : 'outside-tolerance')
    expect(judge(plan(), verified({ truePeakDbtp: peak, meter: 'swr-8x' }), target(), 1, 1, 0).decoded.status).toBe(status)
    expect(judge(plan(), verified({ preEncodeTruePeakDbtp: peak }), target(), 1, 1, 0).truePeak.status).toBe('within')
  })

  it('has no margin with soxr', () =>
  {
    expect(judge(plan(), verified({ preEncodeTruePeakDbtp: -1 }), target(), 1, 1, 0).truePeak.status).toBe('within')
    expect(judge(plan(), verified({ preEncodeTruePeakDbtp: -0.99 }), target(), 1, 1, 0).truePeak).toMatchObject({ status: 'over', overDb: 0.01 })
  })

  it('warns on a decoded overshoot without changing the outcome', () =>
  {
    const lossy = plan({ ceiling: ceiling({ decodedLimitDbtp: -1, gateDbtp: -1, codecCeilingDbtp: -2, outputClass: 'lossy-high', reason: 'aac-high' }) })
    const verdict = judge(lossy, verified({ preEncodeTruePeakDbtp: -2.4, truePeakDbtp: -0.6 }), target(), 1, 2, 0)
    expect(verdict).toMatchObject({ outcome: 'verified', warnings: ['decoded-overshoot'], decoded: { status: 'over', overDb: 0.4 } })
  })

  it('is outside tolerance when decoded samples pass 0 dBFS', () =>
  {
    expect(judge(plan(), verified({ samplePeakDbfs: 0 }), target(), 1, 1, 0).samplePeakOver).toBe(false)
    expect(judge(plan(), verified({ samplePeakDbfs: 0.12 }), target(), 1, 1, 0)).toMatchObject({ outcome: 'outside-tolerance', samplePeakOver: true })
    expect(judge(plan(), verified({ samplePeakDbfs: null }), target(), 1, 1, 0).samplePeakOver).toBe(false)
  })

  it('checks the maximum short-term loudness against its limit plus the rule tolerance', () =>
  {
    const shortForm = plan({ shortTermLimitLufs: R128_SHORT.limit })
    const at = judge(shortForm, verified({ maxShortTermLufs: -17.8 }), target(), 1, 1, 0, R128_SHORT.toleranceLu)
    expect(at).toMatchObject({ outcome: 'verified', shortTerm: { status: 'within', limitLufs: -18, maxLufs: -17.8, toleranceLu: 0.2 } })
    const over = judge(shortForm, verified({ maxShortTermLufs: -17.7 }), target(), 1, 1, 0, R128_SHORT.toleranceLu)
    expect(over).toMatchObject({ outcome: 'outside-tolerance', shortTerm: { status: 'over' } })
    const td1004 = plan({ targetLufs: -18, predictedLufs: -18, shortTermLimitLufs: -13 })
    expect(judge(td1004, verified({ integratedLufs: -18, maxShortTermLufs: -13 }), target({ integratedLufs: -18 }), 1, 1, 0).shortTerm.status).toBe('within')
    expect(judge(td1004, verified({ integratedLufs: -18, maxShortTermLufs: -12.9 }), target({ integratedLufs: -18 }), 1, 1, 0).shortTerm.status).toBe('over')
    expect(judge(shortForm, verified(), target(), 1, 1, 0, 0.2).shortTerm.status).toBe('not-checked')
  })

  it('lowers the gate for outputs louder than the louder-max level', () =>
  {
    const spotify = target({ integratedLufs: -14, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 }, toleranceLu: null })
    const loud = plan({ targetLufs: -14, predictedLufs: -14 })
    const at = judge(loud, verified({ integratedLufs: -14, preEncodeTruePeakDbtp: -1.5 }), spotify, 1, 1, 0)
    expect(at).toMatchObject({ outcome: 'verified', truePeak: { gateDbtp: -1, status: 'within' } })
    const above = judge(loud, verified({ integratedLufs: -13.9, preEncodeTruePeakDbtp: -1.5 }), spotify, 1, 1, 0)
    expect(above).toMatchObject({ outcome: 'outside-tolerance', truePeak: { gateDbtp: -2, status: 'over', overDb: 0.5 } })
    expect(above.loudness.standardTolerance).toBeNull()
  })

  it('names the tolerance unit the way the source states it', () =>
  {
    expect(judge(plan(), verified(), target({ unit: 'LKFS', toleranceLu: 2 }), 1, 1, 0).loudness.standardTolerance).toEqual({ value: 2, unit: 'dB' })
    expect(judge(plan(), verified(), null, 1, 1, 0).loudness.standardTolerance).toBeNull()
  })

  it('is outside tolerance when a value it needs is missing', () =>
  {
    expect(judge(plan(), verified({ integratedLufs: null }), target(), 1, 1, 0)).toMatchObject({ outcome: 'outside-tolerance', loudness: { status: 'not-checked' } })
    expect(judge(plan(), verified({ preEncodeTruePeakDbtp: null }), target(), 1, 1, 0)).toMatchObject({ outcome: 'outside-tolerance', truePeak: { status: 'not-checked' } })
  })
})

function verdictOf(p: GainPlan, v: VerifiedStream, tolerance = 1, pass: 1 | 2 = 1, shortTol = 0): StreamVerdict
{
  return judge(p, v, target(), tolerance, pass, 0, shortTol)
}

describe('correction', () =>
{
  it('lowers the limiter ceiling by the true-peak excess plus 0.3 dB', () =>
  {
    const v = verified({ preEncodeTruePeakDbtp: -0.8 })
    expect(correction(plan(), verdictOf(plan(), v), v)).toEqual({ gainDb: 3, limiterCeilingDbtp: -1.5 - (0.2 + CORRECTION_STEP_DB) })
  })

  it('takes the largest excess of the gate, the decoded limit, and 0 dBFS', () =>
  {
    const lossy = plan({ ceiling: ceiling({ decodedLimitDbtp: -1, codecCeilingDbtp: -2, outputClass: 'lossy-high', reason: 'aac-high', limiterCeilingDbtp: -2.5 }) })
    const decoded = verified({ preEncodeTruePeakDbtp: -2.6, truePeakDbtp: -0.4, samplePeakDbfs: -0.9 })
    expect(correction(lossy, verdictOf(lossy, decoded), decoded)?.limiterCeilingDbtp).toBe(-3.4)
    const clipped = verified({ preEncodeTruePeakDbtp: -2.6, truePeakDbtp: -1.2, samplePeakDbfs: 0.45 })
    expect(correction(lossy, verdictOf(lossy, clipped), clipped)?.limiterCeilingDbtp).toBe(-3.25)
  })

  it('lowers every true-peak limit by the swresample margin', () =>
  {
    const v = verified({ preEncodeTruePeakDbtp: -1.1, meter: 'swr-8x' })
    expect(correction(plan(), verdictOf(plan(), v), v)?.limiterCeilingDbtp).toBe(-1.9)
  })

  it('stops at the -24 dBTP floor', () =>
  {
    const low = plan({ ceiling: ceiling({ limiterCeilingDbtp: -23 }) })
    const v = verified({ preEncodeTruePeakDbtp: 1 })
    expect(correction(low, verdictOf(low, v), v)?.limiterCeilingDbtp).toBe(LIMITER_FLOOR_DBTP)
  })

  it('moves the gain of a linear plan by its deviation when no limiting follows', () =>
  {
    const v = verified({ integratedLufs: -24.6 })
    expect(correction(plan(), verdictOf(plan(), v), v, 'stop-at-reachable')).toEqual({ gainDb: 4.6, limiterCeilingDbtp: -1.5 })
    const loud = verified({ integratedLufs: -21.7 })
    expect(correction(plan(), verdictOf(plan(), loud), loud, 'stop-at-reachable')).toEqual({ gainDb: 1.7, limiterCeilingDbtp: -1.5 })
  })

  it('applies a loudness correction only within the limiting allowance', () =>
  {
    const v = verified({ integratedLufs: -26 })
    const verdict = verdictOf(plan(), v)
    expect(correction(plan(), verdict, v, 'stop-at-reachable')).toBeNull()
    expect(correction(plan(), verdict, v, 'peak-limit')).toEqual({ gainDb: 6, limiterCeilingDbtp: -1.5 })
    expect(correctedPlan(plan(), verdict, v)).toMatchObject({ gainDb: 6, limitingDb: 0.5, predictedLufs: -20, predictedTruePeakDbtp: -1 })
    const tight = plan({ maxLimitingDb: 0.4 })
    expect(correction(tight, verdictOf(tight, v), v, 'peak-limit')).toBeNull()
    const unknownPeak = plan({ predictedTruePeakDbtp: null })
    expect(correction(unknownPeak, verdictOf(unknownPeak, v), v)).toBeNull()
  })

  it('gives peak-limited and reachable plans no loudness correction', () =>
  {
    const v = verified({ integratedLufs: -23.7 })
    for (const mode of ['peak-limited', 'reachable-linear', 'reachable-limited'] as const)
    {
      const limited = plan({ mode, predictedLufs: -23 })
      expect(correction(limited, verdictOf(limited, v, 0.5), v)).toBeNull()
    }
  })

  it('caps the gain at the short-term limit and makes the plan short-term-capped', () =>
  {
    const shortForm = plan({ shortTermLimitLufs: -18, predictedMaxShortTermLufs: -17.5 })
    const v = verified({ maxShortTermLufs: -17.5 })
    const verdict = verdictOf(shortForm, v, 1, 1, 0.2)
    expect(verdict.shortTerm.status).toBe('over')
    expect(correctedPlan(shortForm, verdict, v)).toMatchObject({
      mode: 'reachable-linear',
      reason: 'short-term-capped',
      gainDb: 2.5,
      predictedLufs: -23.5,
      predictedMaxShortTermLufs: -18,
      predictedTruePeakDbtp: -4.5,
      ceiling: { limiterCeilingDbtp: -1.5 }
    })
    const limited = plan({ mode: 'peak-limited', reason: 'needs-limiting', shortTermLimitLufs: -18 })
    expect(correctedPlan(limited, verdictOf(limited, v, 1, 1, 0.2), v)).toMatchObject({ mode: 'reachable-limited', reason: 'short-term-capped' })
    const within = verified({ maxShortTermLufs: -17.8 })
    expect(correction(shortForm, verdictOf(shortForm, within, 1, 1, 0.2), within)).toBeNull()
  })

  it('takes the lower gain when the short-term cap and the loudness correction both apply', () =>
  {
    const shortForm = plan({ shortTermLimitLufs: -18 })
    const loudAndCapped = verified({ integratedLufs: -21, maxShortTermLufs: -17.5 })
    expect(correctedPlan(shortForm, verdictOf(shortForm, loudAndCapped), loudAndCapped)).toMatchObject({ gainDb: 1, reason: 'fits', mode: 'linear' })
    const quietButCapped = verified({ integratedLufs: -24.5, maxShortTermLufs: -17 })
    expect(correctedPlan(shortForm, verdictOf(shortForm, quietButCapped), quietButCapped)).toMatchObject({ gainDb: 2, reason: 'short-term-capped' })
  })

  it('applies both corrections in one re-encode', () =>
  {
    const v = verified({ integratedLufs: -24.5, preEncodeTruePeakDbtp: -0.5 })
    expect(correction(plan(), verdictOf(plan(), v), v)).toEqual({ gainDb: 4.5, limiterCeilingDbtp: -2.3 })
  })

  it('makes no correction on pass 2, for a failed or passthrough stream, or when nothing is off', () =>
  {
    const off = verified({ preEncodeTruePeakDbtp: 0 })
    expect(correction(plan(), verdictOf(plan(), off, 1, 2), off)).toBeNull()
    expect(correction(plan(), judge(plan(), off, target(), 1, 1, 2), off)).toBeNull()
    const passthrough = plan({ mode: 'passthrough', reason: 'below-floor' })
    expect(correction(passthrough, verdictOf(passthrough, off), off)).toBeNull()
    expect(correction(plan(), verdictOf(plan(), verified()), verified())).toBeNull()
    const noPeaks = verified({ preEncodeTruePeakDbtp: null, truePeakDbtp: null, samplePeakDbfs: null })
    expect(correction(plan(), verdictOf(plan(), noPeaks), noPeaks)).toBeNull()
  })

  it('keeps an unknown peak out of the corrected plan', () =>
  {
    const unknown = plan({ predictedTruePeakDbtp: null, headroomDb: null })
    const v = verified({ preEncodeTruePeakDbtp: -0.5 })
    expect(correctedPlan(unknown, verdictOf(unknown, v), v)).toMatchObject({
      headroomDb: null,
      limitingDb: 0,
      predictedTruePeakDbtp: null,
      ceiling: { limiterCeilingDbtp: -2.3 }
    })
  })
})

describe('better', () =>
{
  const pass = (p: GainPlan, v: VerifiedStream | undefined, errors = 0, encodePass: 1 | 2 = 1): StreamVerdict =>
    judge(p, v, target(), 1, encodePass, errors)

  it('ranks no failures first', () =>
  {
    expect(better([pass(plan(), verified(), 2)], [pass(plan(), verified({ integratedLufs: -26 }), 0, 2)])).toBe('second')
    expect(better([pass(plan(), verified({ integratedLufs: -26 }))], [pass(plan(), undefined, 0, 2)])).toBe('first')
  })

  it('then the true peak, overs, loudness, and the smaller deviation', () =>
  {
    const overPeak = pass(plan(), verified({ preEncodeTruePeakDbtp: -0.5 }))
    const overSamples = pass(plan(), verified({ samplePeakDbfs: 0.2, integratedLufs: -23 }))
    const missLoudness = pass(plan(), verified({ integratedLufs: -24.5 }))
    const close = pass(plan(), verified({ integratedLufs: -23.4 }))
    const closer = pass(plan(), verified({ integratedLufs: -23.1 }))
    expect(better([overPeak], [overSamples])).toBe('second')
    expect(better([overSamples], [missLoudness])).toBe('second')
    expect(better([missLoudness], [close])).toBe('second')
    expect(better([close], [closer])).toBe('second')
    expect(better([closer], [close])).toBe('first')
  })

  it('keeps the first pass on a tie and ignores passthrough streams', () =>
  {
    const passthrough = pass(plan({ mode: 'passthrough', reason: 'silent' }), undefined)
    expect(better([pass(plan(), verified()), passthrough], [pass(plan(), verified(), 0, 2), passthrough])).toBe('first')
  })

  it('keeps attempt 1 of the bimodal AC-3 track, whose correction overshot', () =>
  {
    const ac3 = plan({ ceiling: ceiling({ outputClass: 'broadcast-lossy', reason: 'ac3-high', codecCeilingDbtp: -1, decodedLimitDbtp: -1 }) })
    const first = verified({ integratedLufs: -21.8, preEncodeTruePeakDbtp: -6, truePeakDbtp: -5.8, samplePeakDbfs: -6.1 })
    const firstVerdict = judge(ac3, first, target(), 1, 1, 0)
    expect(firstVerdict).toMatchObject({ outcome: 'outside-tolerance', loudness: { status: 'above', deviationLu: 1.2 } })
    const fix = correctedPlan(ac3, firstVerdict, first)
    expect(fix?.gainDb).toBe(1.8)
    const second = verified({ integratedLufs: -25, preEncodeTruePeakDbtp: -7.2, truePeakDbtp: -7, samplePeakDbfs: -7.3 })
    const secondVerdict = judge(fix as GainPlan, second, target(), 1, 2, 0)
    expect(secondVerdict).toMatchObject({ outcome: 'outside-tolerance', loudness: { status: 'below', deviationLu: -2 } })
    expect(better([firstVerdict], [secondVerdict])).toBe('first')
  })
})
