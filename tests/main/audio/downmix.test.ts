/**
 * Explicit stereo downmixes (D13, N3). Every supported layout's `pan` expression and its coefficients against
 * the BS.775-4 and dialog tables, the stream's own Lo/Ro levels in place of 0.7071, refusal of unsupported
 * layouts, the mono fold, and the downmix side-data parser on ashowinfo output recorded from both builds:
 * 2022 prints the side data once, 9.0.2 twice.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  BS775, DIALOG, DOWNMIX_LAYOUTS, DOWNMIX_LEVEL_CODECS, LAYOUT_CHANNELS, MONO_FOLD, buildDownmixProbeArgs, downmixStage,
  monoFoldStage, parseDownmixInfo
} from '../../../src/main/ffmpeg/audio/downmix'
import type { DownmixLevels } from '../../../src/main/ffmpeg/audio/downmix'
import { execArgv } from '../../../src/main/ffmpeg/exec'
import { AC3_DEFAULT_LEVELS, PROBE_CASES, PROBE_PREFIX, probeRunArgs, scenarioDocuments } from '../fixtures/ffmpeg/downmix/cases'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ffmpeg', 'downmix')
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

/** Reads a `pan=stereo|FL=...|FR=...` expression back into a coefficient per input channel and side. */
function matrixOf(stage: string): Map<string, [number, number]>
{
  const match = /^pan=stereo\|FL=([^|]+)\|FR=([^|]+)$/.exec(stage)
  if (match === null)
  {
    throw new Error(`Not a stereo pan: ${stage}`)
  }
  const matrix = new Map<string, [number, number]>()
  ;[match[1], match[2]].forEach((sum, side) =>
  {
    for (const term of sum.split('+'))
    {
      const [coefficient, channel] = term.includes('*') ? [Number(term.split('*')[0]), term.split('*')[1]] : [1, term]
      const row = matrix.get(channel) ?? [0, 0]
      row[side] = coefficient
      matrix.set(channel, row)
    }
  })
  return matrix
}

const BS775_EXPRESSIONS: Readonly<Record<string, readonly [string, 'bs775' | 'bs775-extended']>> =
{
  '2.1': ['pan=stereo|FL=FL|FR=FR', 'bs775'],
  '3.0': ['pan=stereo|FL=FL+0.7071*FC|FR=FR+0.7071*FC', 'bs775'],
  '3.0(back)': ['pan=stereo|FL=FL+0.5*BC|FR=FR+0.5*BC', 'bs775-extended'],
  '4.0': ['pan=stereo|FL=FL+0.7071*FC+0.5*BC|FR=FR+0.7071*FC+0.5*BC', 'bs775-extended'],
  'quad': ['pan=stereo|FL=FL+0.7071*BL|FR=FR+0.7071*BR', 'bs775'],
  'quad(side)': ['pan=stereo|FL=FL+0.7071*SL|FR=FR+0.7071*SR', 'bs775'],
  '3.1': ['pan=stereo|FL=FL+0.7071*FC|FR=FR+0.7071*FC', 'bs775'],
  '4.1': ['pan=stereo|FL=FL+0.7071*FC+0.5*BC|FR=FR+0.7071*FC+0.5*BC', 'bs775-extended'],
  '5.0': ['pan=stereo|FL=FL+0.7071*FC+0.7071*BL|FR=FR+0.7071*FC+0.7071*BR', 'bs775'],
  '5.0(side)': ['pan=stereo|FL=FL+0.7071*FC+0.7071*SL|FR=FR+0.7071*FC+0.7071*SR', 'bs775'],
  '5.1': ['pan=stereo|FL=FL+0.7071*FC+0.7071*BL|FR=FR+0.7071*FC+0.7071*BR', 'bs775'],
  '5.1(side)': ['pan=stereo|FL=FL+0.7071*FC+0.7071*SL|FR=FR+0.7071*FC+0.7071*SR', 'bs775'],
  '6.0': ['pan=stereo|FL=FL+0.7071*FC+0.5*BC+0.7071*SL|FR=FR+0.7071*FC+0.5*BC+0.7071*SR', 'bs775-extended'],
  '6.1': ['pan=stereo|FL=FL+0.7071*FC+0.5*BC+0.7071*SL|FR=FR+0.7071*FC+0.5*BC+0.7071*SR', 'bs775-extended'],
  '6.1(back)': ['pan=stereo|FL=FL+0.7071*FC+0.7071*BL+0.5*BC|FR=FR+0.7071*FC+0.7071*BR+0.5*BC', 'bs775-extended'],
  '7.0': ['pan=stereo|FL=FL+0.7071*FC+0.7071*BL+0.7071*SL|FR=FR+0.7071*FC+0.7071*BR+0.7071*SR', 'bs775-extended'],
  '7.1': ['pan=stereo|FL=FL+0.7071*FC+0.7071*BL+0.7071*SL|FR=FR+0.7071*FC+0.7071*BR+0.7071*SR', 'bs775-extended']
}

const DIALOG_EXPRESSIONS: Readonly<Record<string, string>> =
{
  '3.0': 'pan=stereo|FL=FL+FC|FR=FR+FC',
  '4.0': 'pan=stereo|FL=FL+FC+0.5*BC|FR=FR+FC+0.5*BC',
  '3.1': 'pan=stereo|FL=FL+FC|FR=FR+FC',
  '4.1': 'pan=stereo|FL=FL+FC+0.5*BC|FR=FR+FC+0.5*BC',
  '5.0': 'pan=stereo|FL=FL+FC+0.5*BL|FR=FR+FC+0.5*BR',
  '5.0(side)': 'pan=stereo|FL=FL+FC+0.5*SL|FR=FR+FC+0.5*SR',
  '5.1': 'pan=stereo|FL=FL+FC+0.5*BL|FR=FR+FC+0.5*BR',
  '5.1(side)': 'pan=stereo|FL=FL+FC+0.5*SL|FR=FR+FC+0.5*SR',
  '6.0': 'pan=stereo|FL=FL+FC+0.5*BC+0.5*SL|FR=FR+FC+0.5*BC+0.5*SR',
  '6.1': 'pan=stereo|FL=FL+FC+0.5*BC+0.5*SL|FR=FR+FC+0.5*BC+0.5*SR',
  '6.1(back)': 'pan=stereo|FL=FL+FC+0.5*BL+0.5*BC|FR=FR+FC+0.5*BR+0.5*BC',
  '7.0': 'pan=stereo|FL=FL+FC+0.5*BL+0.5*SL|FR=FR+FC+0.5*BR+0.5*SR',
  '7.1': 'pan=stereo|FL=FL+FC+0.5*BL+0.5*SL|FR=FR+FC+0.5*BR+0.5*SR'
}

const UNSUPPORTED = ['mono', 'stereo', 'hexagonal', 'octagonal', '6.0(front)', '6.1(front)', '7.0(front)', '7.1(wide)',
  '7.1(wide-side)', '5.1.2', '7.1.4', 'hexadecagonal', '22.2', 'downmix', 'binaural', '5 channels', 'unknown', 'constructor', '']

describe('layout and coefficient tables', () =>
{
  it('lists the channels of the layouts FFmpeg names, in its order', () =>
  {
    expect(LAYOUT_CHANNELS['5.1(side)']).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'])
    expect(LAYOUT_CHANNELS['7.1']).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
    expect(LAYOUT_CHANNELS['6.1(back)']).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'])
    expect(LAYOUT_CHANNELS['3.0(back)']).toEqual(['FL', 'FR', 'BC'])
    expect(LAYOUT_CHANNELS['22.2']).toHaveLength(24)
  })

  it('supports exactly the 3/2 family plus the extended back layouts', () =>
  {
    expect([...DOWNMIX_LAYOUTS].sort()).toEqual(Object.keys(BS775_EXPRESSIONS).sort())
  })

  it('has a BS.775-4 and a dialog row for every channel of every supported layout', () =>
  {
    for (const layout of DOWNMIX_LAYOUTS)
    {
      for (const channel of LAYOUT_CHANNELS[layout])
      {
        expect(BS775[channel], `${layout} ${channel}`).toBeDefined()
        expect(DIALOG[channel], `${layout} ${channel}`).toBeDefined()
      }
    }
  })

  it('states BS.775-4 Annex 4 Table 2 with the back-pair and back-center extensions, LFE omitted', () =>
  {
    expect(BS775).toEqual({
      FL: [1, 0], FR: [0, 1], FC: [0.7071, 0.7071], SL: [0.7071, 0], SR: [0, 0.7071], BL: [0.7071, 0], BR: [0, 0.7071],
      BC: [0.5, 0.5], LFE: [0, 0], LFE2: [0, 0]
    })
  })

  it('states dialog emphasis: the center at full level, surrounds and back center at 0.5, LFE omitted', () =>
  {
    expect(DIALOG).toEqual({
      FL: [1, 0], FR: [0, 1], FC: [1, 1], SL: [0.5, 0], SR: [0, 0.5], BL: [0.5, 0], BR: [0, 0.5], BC: [0.5, 0.5],
      LFE: [0, 0], LFE2: [0, 0]
    })
  })
})

describe('downmixStage', () =>
{
  it.each(Object.entries(BS775_EXPRESSIONS))('%s: BS.775-4 when the stream carries no levels', (layout, [expression, coefficients]) =>
  {
    expect(downmixStage('standard', layout, null)).toEqual({ stage: expression, coefficients })
  })

  it.each(DOWNMIX_LAYOUTS)('%s: the expression carries exactly the BS.775-4 coefficients', (layout) =>
  {
    const matrix = matrixOf((downmixStage('standard', layout, null) as { stage: string }).stage)
    for (const channel of LAYOUT_CHANNELS[layout])
    {
      const expected = BS775[channel]
      expect(matrix.get(channel) ?? [0, 0], `${layout} ${channel}`).toEqual([...expected])
    }
    expect(matrix.has('LFE')).toBe(false)
  })

  it.each(Object.entries(DIALOG_EXPRESSIONS))('%s: dialog emphasis', (layout, expression) =>
  {
    expect(downmixStage('dialog', layout, null)).toEqual({ stage: expression, coefficients: 'dialog' })
    const matrix = matrixOf(expression)
    for (const channel of LAYOUT_CHANNELS[layout])
    {
      expect(matrix.get(channel) ?? [0, 0], `${layout} ${channel}`).toEqual([...DIALOG[channel]])
    }
  })

  it('keeps dialog emphasis even when the stream carries levels, since it is not a standard downmix', () =>
  {
    expect(downmixStage('dialog', '5.1(side)', AC3_DEFAULT_LEVELS)).toEqual({ stage: DIALOG_EXPRESSIONS['5.1(side)'], coefficients: 'dialog' })
  })

  it.each(['2.1', '3.0(back)', 'quad', 'quad(side)'])('%s: dialog without a center channel takes the standard downmix', (layout) =>
  {
    expect(downmixStage('dialog', layout, null)).toEqual(downmixStage('standard', layout, null))
  })

  it('uses the stream levels of the corpus AC-3 file in place of 0.7071', () =>
  {
    expect(downmixStage('standard', '5.1(side)', AC3_DEFAULT_LEVELS)).toEqual({
      stage: 'pan=stereo|FL=FL+0.594604*FC+0.5*SL|FR=FR+0.594604*FC+0.5*SR',
      coefficients: 'stream-metadata'
    })
  })

  it('applies the surround level to both pairs and splits it equally for a back center', () =>
  {
    expect(downmixStage('standard', '7.1', AC3_DEFAULT_LEVELS)?.stage)
      .toBe('pan=stereo|FL=FL+0.594604*FC+0.5*BL+0.5*SL|FR=FR+0.594604*FC+0.5*BR+0.5*SR')
    expect(downmixStage('standard', '4.0', AC3_DEFAULT_LEVELS)?.stage)
      .toBe('pan=stereo|FL=FL+0.594604*FC+0.353553*BC|FR=FR+0.594604*FC+0.353553*BC')
    expect(downmixStage('standard', '4.1', { centerLoRo: 0.707107, surroundLoRo: 0.707107, preferred: 'Lo/Ro' })?.stage)
      .toBe('pan=stereo|FL=FL+0.707107*FC+0.5*BC|FR=FR+0.707107*FC+0.5*BC')
  })

  it('writes a level of 1 as the bare channel and leaves out a level of 0', () =>
  {
    const levels: DownmixLevels = { centerLoRo: 1, surroundLoRo: 0, preferred: 'Lo/Ro' }
    expect(downmixStage('standard', '5.1', levels)).toEqual({ stage: 'pan=stereo|FL=FL+FC|FR=FR+FC', coefficients: 'stream-metadata' })
  })

  it.each(UNSUPPORTED)('returns null for %j', (layout) =>
  {
    expect(downmixStage('standard', layout, null)).toBeNull()
    expect(downmixStage('dialog', layout, AC3_DEFAULT_LEVELS)).toBeNull()
  })
})

describe('monoFoldStage', () =>
{
  it('folds a stereo source alone, at equal weight in float', () =>
  {
    expect(monoFoldStage('stereo', null)).toEqual({ stages: ['aformat=sample_fmts=dbl', 'pan=mono|c0=0.5*c0+0.5*c1'], coefficients: 'fold' })
    expect(MONO_FOLD).toBe('pan=mono|c0=0.5*c0+0.5*c1')
  })

  it('folds any two-channel layout by position', () =>
  {
    expect(monoFoldStage('downmix', AC3_DEFAULT_LEVELS)?.coefficients).toBe('fold')
  })

  it.each(DOWNMIX_LAYOUTS)('%s: the standard downmix, its stereo pin, then the fold', (layout) =>
  {
    const downmix = downmixStage('standard', layout, null) as { stage: string; coefficients: string }
    expect(monoFoldStage(layout, null)).toEqual({
      stages: ['aformat=sample_fmts=dbl', downmix.stage, 'aformat=sample_fmts=dbl:channel_layouts=stereo', MONO_FOLD],
      coefficients: downmix.coefficients
    })
  })

  it('downmixes with the stream levels before the fold when the stream carries them', () =>
  {
    expect(monoFoldStage('5.1(side)', AC3_DEFAULT_LEVELS)).toEqual({
      stages: [
        'aformat=sample_fmts=dbl', 'pan=stereo|FL=FL+0.594604*FC+0.5*SL|FR=FR+0.594604*FC+0.5*SR',
        'aformat=sample_fmts=dbl:channel_layouts=stereo', MONO_FOLD
      ],
      coefficients: 'stream-metadata'
    })
  })

  it.each(['mono', '7.1(wide)', '22.2', 'hexagonal', '5 channels', 'constructor'])('returns null for %j', (layout) =>
  {
    expect(monoFoldStage(layout, null)).toBeNull()
  })
})

describe('buildDownmixProbeArgs', () =>
{
  it('decodes one frame of the stream through ashowinfo at info level', () =>
  {
    expect(buildDownmixProbeArgs('IN/a.mkv', 2)).toEqual([
      '-loglevel', 'level+info', '-analyzeduration', '200M', '-probesize', '200M', '-i', 'IN/a.mkv',
      '-map', '0:a:2', '-frames:a', '1', '-af', 'ashowinfo', '-f', 'null', '-'
    ])
  })

  it('names the codecs whose decoders export downmix levels', () =>
  {
    expect([...DOWNMIX_LEVEL_CODECS].sort()).toEqual(['ac3', 'eac3'])
    for (const codec of ['dts', 'pcm_s16le', 'aac', 'truehd'])
    {
      expect(DOWNMIX_LEVEL_CODECS.has(codec)).toBe(false)
    }
  })
})

describe('recorded downmix probes', () =>
{
  it('come from the generated scenarios with the exec prefix of a killable run', () =>
  {
    const scenarios = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'scenarios.json'), 'utf8')) as unknown
    expect(scenarios).toEqual(JSON.parse(JSON.stringify(scenarioDocuments().probes)))
    expect(PROBE_PREFIX).toEqual(execArgv([], 'kill'))
  })

  it.each(BUILDS)('%s: every probe ran with the builder arguments and exited 0', (build) =>
  {
    const recorded = runs(build)
    expect(recorded.map((run) => run.name)).toEqual(PROBE_CASES.map((probe) => probe.name))
    for (const probe of PROBE_CASES)
    {
      const run = recorded.find((candidate) => candidate.name === probe.name) as RunRecord
      expect(run.argv, probe.name).toEqual([...PROBE_PREFIX, ...probeRunArgs(probe)])
      expect(run.code, probe.name).toBe(0)
    }
  })

  it('prints the downmix side data once on 2022 and twice on 9.0.2', () =>
  {
    const count = (build: Build): number => (stderrOf(build, 'ac3-51side').match(/side data - downmix:/g) ?? []).length
    expect(count('2022-10-13')).toBe(1)
    expect(count('9.0.2')).toBe(2)
  })

  const expected: ReadonlyArray<readonly [Build, string, DownmixLevels | null]> =
  [
    ['2022-10-13', 'ac3-51side', AC3_DEFAULT_LEVELS],
    ['9.0.2', 'ac3-51side', AC3_DEFAULT_LEVELS],
    ['2022-10-13', 'eac3-loro', { centerLoRo: 0.707107, surroundLoRo: 0.5, preferred: 'Lo/Ro' }],
    ['9.0.2', 'eac3-loro', { centerLoRo: 0.707107, surroundLoRo: 0.5, preferred: 'Lo/Ro' }],
    ['2022-10-13', 'eac3-ltrt', { centerLoRo: 0.594604, surroundLoRo: 0.5, preferred: 'Lt/Rt' }],
    ['9.0.2', 'eac3-ltrt', { centerLoRo: 0.594604, surroundLoRo: 0.5, preferred: 'Lt/Rt' }],
    ['2022-10-13', 'ac3-dplii', { centerLoRo: 0.594604, surroundLoRo: 0.5, preferred: 'Pro Logic II' }],
    ['9.0.2', 'ac3-dplii', AC3_DEFAULT_LEVELS],
    ['2022-10-13', 'ac3-stereo-dsur', AC3_DEFAULT_LEVELS],
    ['9.0.2', 'ac3-stereo-dsur', null],
    ['2022-10-13', 'dts-51side', null],
    ['9.0.2', 'dts-51side', null],
    ['2022-10-13', 'pcm-51side', null],
    ['9.0.2', 'pcm-51side', null],
    ['2022-10-13', 'two-audio-second', AC3_DEFAULT_LEVELS],
    ['9.0.2', 'two-audio-second', AC3_DEFAULT_LEVELS]
  ]

  it.each(expected.flatMap(([build, name, levels]) => VARIANTS.map(([variant, transform]) => [build, name, variant, transform, levels] as const)))(
    '%s %s %s', (build, name, _variant, transform, levels) =>
    {
      expect(parseDownmixInfo(transform(stderrOf(build, name)))).toEqual(levels)
    })

  it('reads the Lo/Ro levels, never the Lt/Rt ones, whatever the preferred type', () =>
  {
    const text = stderrOf('9.0.2', 'eac3-ltrt')
    expect(text).toContain('center 0.594604 (0.500000 ltrt)')
    expect(parseDownmixInfo(text)?.centerLoRo).toBe(0.594604)
  })

  it('returns null for a matrix-only line, as DTS and stereo AC-3 on 9.0.2 print', () =>
  {
    expect(stderrOf('9.0.2', 'dts-51side')).toContain('side data - matrix encoding: none')
    expect(stderrOf('9.0.2', 'ac3-stereo-dsur')).toContain('side data - matrix encoding: Dolby Surround')
  })
})

describe('parseDownmixInfo', () =>
{
  const line = (type: string, center: string, surround: string): string =>
    `[Parsed_ashowinfo_0 @ 0000] [info]   side data - downmix: preferred downmix type - ${type} Mix levels: ` +
    `center ${center} (0.707107 ltrt) - surround ${surround} (0.707107 ltrt) - lfe 0.000000\n`

  it('takes the first side-data line', () =>
  {
    expect(parseDownmixInfo(line('Lo/Ro', '0.707107', '0.500000') + line('Lt/Rt', '0.500000', '0.500000')))
      .toEqual({ centerLoRo: 0.707107, surroundLoRo: 0.5, preferred: 'Lo/Ro' })
  })

  it('names a type it does not know unknown', () =>
  {
    expect(parseDownmixInfo(line('Something New', '0.5', '0.5'))?.preferred).toBe('unknown')
    expect(parseDownmixInfo(line('constructor', '0.5', '0.5'))?.preferred).toBe('unknown')
  })

  it.each([
    ['a level that is not a number', line('Lo/Ro', 'nan', '0.500000')],
    ['an infinite level', line('Lo/Ro', '0.707107', 'inf')],
    ['a level above +6 dB', line('Lo/Ro', '2.500000', '0.500000')],
    ['a negative level', line('Lo/Ro', '-0.500000', '0.500000')],
    ['no side data', '[info] Stream mapping:\n'],
    ['nothing', '']
  ])('returns null for %s, so BS.775-4 applies', (_name, text) =>
  {
    expect(parseDownmixInfo(text)).toBeNull()
  })

  it('accepts the E-AC-3 range: 0 to 1.414', () =>
  {
    expect(parseDownmixInfo(line('Lo/Ro', '1.414214', '0.000000'))).toEqual({ centerLoRo: 1.414214, surroundLoRo: 0, preferred: 'Lo/Ro' })
  })
})
