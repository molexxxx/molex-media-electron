/**
 * Loudness and gain presets. Each built-in loudness preset carries the target, ranges, tolerance wording,
 * policy, mono rule, short-form rule, and cited clauses of its standard; gain presets are in dB with the
 * limiter always present; applying a preset yields a whole recipe that keeps nothing of the one it replaces.
 * The gain facts were first pinned in percent by the renderer preset test and are restated here in dB.
 */
import { describe, it, expect } from 'vitest'
import type { EncoderPolicy, NormalizeRecipe } from '../../../src/shared/audio/types'
import {
  DEFAULT_LOUDNESS_PRESET,
  GAIN_PRESETS,
  LOUDNESS_PRESETS,
  NIGHT_DYNAMICS,
  applyGainPreset,
  applyLoudnessPreset,
  findGainPreset,
  findLoudnessPreset,
  presetName,
  type LoudnessPreset,
  type PresetId
} from '../../../src/shared/audio/presets'

const ALL_IDS: PresetId[] = ['ebu-r128', 'atsc-a85', 'film-r128s4', 'apple-podcasts', 'spotify', 'streaming-r128s2', 'aes-streaming', 'night', 'custom']

function preset(id: PresetId): LoudnessPreset
{
  const found = findLoudnessPreset(id)
  if (!found)
  {
    throw new Error(`no preset ${id}`)
  }
  return found
}

const R128_S1 = { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }
const TD1004_SHORT_FORM = { maxAboveTargetLu: 5, toleranceLu: 0, autoMaxDurationSec: 60 }

/** The presets table, row by row: target, ranges, tolerance, policy, mono, and the rest of each row. */
const ROWS: Array<[PresetId, Partial<LoudnessPreset>]> =
[
  ['ebu-r128', {
    label: 'EBU R 128', standardName: 'EBU R 128',
    target: { integratedLufs: -23, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 0.2, unit: 'LUFS' }, targetDecimals: 1,
    targetRange: null, truePeakRange: null, toleranceText: '0.2 LU', deviationUnit: 'LU',
    policy: 'stop-at-reachable', mono: 'one-channel', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: R128_S1, album: 'track', standard: true, supersededBy: null, measurementNote: null
  }],
  ['atsc-a85', {
    label: 'ATSC A/85 (short-form method)', standardName: 'ATSC A/85',
    target: { integratedLufs: -24, maxTruePeakDbtp: -2, louderMax: null, toleranceLu: 2, unit: 'LKFS' }, targetDecimals: 0,
    targetRange: null, truePeakRange: null,
    toleranceText: '2 dB ("anticipated, due to measurement variations"; "should not be targeted to the high or low side")',
    deviationUnit: 'dB', policy: 'stop-at-reachable', mono: 'one-channel', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: null, album: 'track', standard: true, supersededBy: null,
    measurementNote: 'A/85\'s method for short-form content (section 5.2.6), not its method for long-form content'
  }],
  ['film-r128s4', {
    label: 'Film and series (EBU R 128 s4)', standardName: 'EBU R 128 s4',
    target: { integratedLufs: -23, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 0.2, unit: 'LUFS' }, targetDecimals: 1,
    targetRange: null, truePeakRange: null, toleranceText: '0.2 LU (s4 (l), (m) refer to R 128\'s tolerances)', deviationUnit: 'LU',
    policy: 'stop-at-reachable', mono: 'one-channel', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: null, album: 'track', standard: true, supersededBy: null,
    measurementNote: 'Measured on the full mix with a BS.1770 meter, as s4 (g) specifies for Programme Loudness'
  }],
  ['apple-podcasts', {
    label: 'Podcast (Apple Podcasts)', standardName: 'Apple Podcasts',
    target: { integratedLufs: -16, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 1, unit: 'LKFS' }, targetDecimals: 0,
    targetRange: null, truePeakRange: null, toleranceText: '1 dB', deviationUnit: 'dB',
    policy: 'peak-limit', maxLimitingDb: 1, mono: 'one-channel', monoToStereo: true, minSampleRate: 44100, dynamics: null,
    shortForm: null, album: 'track', standard: true, supersededBy: null, measurementNote: null
  }],
  ['spotify', {
    label: 'Music streaming (Spotify reference)', standardName: 'Spotify',
    target: { integratedLufs: -14, maxTruePeakDbtp: -1, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 }, toleranceLu: null, unit: 'LUFS' },
    targetDecimals: 0, targetRange: null, truePeakRange: null, toleranceText: null, deviationUnit: 'LU',
    policy: 'peak-limit', maxLimitingDb: 1, mono: 'two-speakers', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: null, album: 'track-or-album', standard: true, supersededBy: null, measurementNote: null
  }],
  ['streaming-r128s2', {
    label: 'Streaming (EBU R 128 s2)', standardName: 'EBU R 128 s2',
    target: { integratedLufs: -18, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: null, unit: 'LUFS' }, targetDecimals: 0,
    targetRange: [-20, -16], truePeakRange: null, toleranceText: null, deviationUnit: 'LU',
    policy: 'peak-limit', maxLimitingDb: 1, mono: 'one-channel', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: null, album: 'track-or-album', standard: true, supersededBy: null, measurementNote: null
  }],
  ['aes-streaming', {
    label: 'Streaming (AES TD1004, superseded)', standardName: 'AES TD1004',
    target: { integratedLufs: -18, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 0.5, unit: 'LUFS' }, targetDecimals: 0,
    targetRange: [-20, -16], truePeakRange: null,
    toleranceText: '0.5 LU ("prerecorded files may be matched within ±0.5 LU, for example", 4.B)', deviationUnit: 'LU',
    policy: 'stop-at-reachable', maxLimitingDb: 1, mono: 'two-speakers', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: TD1004_SHORT_FORM, album: 'track-or-album', standard: true, supersededBy: 'AES TD1008 (2021) and AES77-2023', measurementNote: null
  }],
  ['night', {
    label: 'Clear dialogue (movies and shows)', standardName: null,
    target: { integratedLufs: -18, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: null, unit: 'LUFS' }, targetDecimals: 0,
    targetRange: [-24, -14], truePeakRange: null, toleranceText: null, deviationUnit: 'LU',
    policy: 'reduce-dynamics', maxLimitingDb: 1, mono: 'two-speakers', monoToStereo: false, minSampleRate: null,
    dynamics: { thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 300 },
    shortForm: null, album: 'track', standard: false, supersededBy: null, measurementNote: null
  }],
  ['custom', {
    label: 'Custom', standardName: null,
    target: { integratedLufs: -18, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: null, unit: 'LUFS' }, targetDecimals: 1,
    targetRange: [-60, -5], truePeakRange: [-9, 0], toleranceText: null, deviationUnit: 'LU',
    policy: 'stop-at-reachable', mono: 'two-speakers', monoToStereo: false, minSampleRate: null, dynamics: null,
    shortForm: R128_S1, album: 'track', standard: false, supersededBy: null, measurementNote: null
  }]
]

/** The Sources column, row by row: the start of each document name and the exact clause list. */
const SOURCES: Record<PresetId, Array<[string, string]>> =
{
  'ebu-r128': [['EBU R 128 V5', '(h), (i), (m), (q)'], ['EBU R 128 s1', '(d)'], ['EBU Tech 3344', ''], ['EBU Tech 3343', 'sections 3.1 and 3.3']],
  'atsc-a85': [['ATSC A/85:2026-07', 'sections 5.1.1, 5.2.2, 5.2.4, 5.2.6, 6; Annex M footnotes 31 and 32']],
  'film-r128s4': [['EBU R 128 s4', '(g), (i), (j), (l), (m)'], ['EBU R 128 V5', '(i)']],
  'apple-podcasts': [['Apple Podcasts', '']],
  'spotify': [['Spotify', '']],
  'streaming-r128s2': [['EBU R 128 s2', '(d), (e), (g), (i)'], ['EBU R 128 V5', '(m)'], ['EBU Tech 3344', '']],
  'aes-streaming': [['AES TD1004', 'sections 3, 4.B, 4.C, 5, 6, 9 items 4 and 6'], ['Radio World', ''], ['Telos Alliance', '']],
  'night': [['EBU R 128 s2', '(g)']],
  'custom': []
}

const SAME_AS_SOURCE: EncoderPolicy = { kind: 'same-as-source' }

describe('LOUDNESS_PRESETS', () =>
{
  it('lists every preset id once, in the order the select shows them', () =>
  {
    expect(LOUDNESS_PRESETS.map((p) => p.id)).toEqual(ALL_IDS)
  })

  it.each(ROWS)('%s matches its row of the presets table', (id, expected) =>
  {
    expect(preset(id)).toMatchObject(expected)
  })

  it.each(ALL_IDS)('%s cites its sources with the exact clauses and the fetch date', (id) =>
  {
    const sources = preset(id).sources
    const expected = SOURCES[id]
    expect(sources.length).toBe(expected.length)
    sources.forEach((source, index) =>
    {
      expect(source.name.startsWith(expected[index][0]), source.name).toBe(true)
      expect(source.clause).toBe(expected[index][1])
      expect(source.url).toMatch(/^https:\/\/[^\s]+$/)
      expect(source.fetched).toBe(/Radio World|Telos/.test(source.name) ? '2026-10-16' : '2026-10-15')
    })
  })

  it('gives every standard at least one source', () =>
  {
    for (const p of LOUDNESS_PRESETS.filter((x) => x.standard))
    {
      expect(p.sources.length, p.id).toBeGreaterThan(0)
    }
  })

  it('makes Streaming (EBU R 128 s2) the new-install default', () =>
  {
    expect(DEFAULT_LOUDNESS_PRESET).toBe('streaming-r128s2')
    expect(findLoudnessPreset(DEFAULT_LOUDNESS_PRESET)?.label).toBe('Streaming (EBU R 128 s2)')
  })

  it('keeps labels short enough for a table cell, a toast, and a stamp tooltip', () =>
  {
    for (const p of LOUDNESS_PRESETS)
    {
      expect(p.label.length, p.label).toBeLessThanOrEqual(40)
    }
    expect(preset('aes-streaming').label).toBe('Streaming (AES TD1004, superseded)')
  })

  it('makes no claim the sources do not support', () =>
  {
    const text = JSON.stringify(LOUDNESS_PRESETS)
    for (const claim of ['YouTube', 'udiophile', 'center +3 dB', 'FFmpeg default', 'BS.1770-4', 'broadcast safe', 'ompliant'])
    {
      expect(text).not.toContain(claim)
    }
  })

  it('names the standard each sentence uses, and none for the presets that are not standards', () =>
  {
    expect(LOUDNESS_PRESETS.map((p) => p.standardName)).toEqual(
      ['EBU R 128', 'ATSC A/85', 'EBU R 128 s4', 'Apple Podcasts', 'Spotify', 'EBU R 128 s2', 'AES TD1004', null, null])
    for (const p of LOUDNESS_PRESETS)
    {
      expect(p.standard).toBe(p.standardName !== null)
    }
  })

  it('words deviations in dB for ATSC A/85 and Apple Podcasts and in LU otherwise', () =>
  {
    const dB = LOUDNESS_PRESETS.filter((p) => p.deviationUnit === 'dB').map((p) => p.id)
    expect(dB).toEqual(['atsc-a85', 'apple-podcasts'])
    expect(preset('atsc-a85').target.unit).toBe('LKFS')
    expect(preset('apple-podcasts').target.unit).toBe('LKFS')
  })

  it('states a tolerance in words exactly when the source states one', () =>
  {
    for (const p of LOUDNESS_PRESETS)
    {
      expect(p.toleranceText === null, p.id).toBe(p.target.toleranceLu === null)
    }
  })

  it('marks only the AES preset as superseded', () =>
  {
    expect(LOUDNESS_PRESETS.filter((p) => p.supersededBy !== null).map((p) => p.id)).toEqual(['aes-streaming'])
  })

  it('offers album normalization on Spotify, EBU R 128 s2, and AES only', () =>
  {
    expect(LOUDNESS_PRESETS.filter((p) => p.album === 'track-or-album').map((p) => p.id)).toEqual(['spotify', 'streaming-r128s2', 'aes-streaming'])
  })

  it('keeps every preset target inside its own editable range', () =>
  {
    for (const p of LOUDNESS_PRESETS)
    {
      if (p.targetRange)
      {
        expect(p.target.integratedLufs).toBeGreaterThanOrEqual(p.targetRange[0])
        expect(p.target.integratedLufs).toBeLessThanOrEqual(p.targetRange[1])
      }
      if (p.truePeakRange)
      {
        expect(p.target.maxTruePeakDbtp).toBeGreaterThanOrEqual(p.truePeakRange[0])
        expect(p.target.maxTruePeakDbtp).toBeLessThanOrEqual(p.truePeakRange[1])
      }
      expect(p.maxLimitingDb).toBeGreaterThanOrEqual(0)
      expect(p.maxLimitingDb).toBeLessThanOrEqual(3)
    }
  })

  it('uses the Clear dialogue compressor for the night preset', () =>
  {
    expect(NIGHT_DYNAMICS).toEqual({ thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 300 })
    expect(preset('night').dynamics).toEqual(NIGHT_DYNAMICS)
  })
})

describe('lookups', () =>
{
  it('finds presets by id and returns null for an unknown id', () =>
  {
    expect(findLoudnessPreset('spotify')?.id).toBe('spotify')
    expect(findLoudnessPreset('youtube')).toBeNull()
    expect(findGainPreset('louder')?.id).toBe('louder')
    expect(findGainPreset('maximize')).toBeNull()
  })

  it('names a preset by its standard, else its label, and passes unknown ids through', () =>
  {
    expect(presetName('apple-podcasts')).toBe('Apple Podcasts')
    expect(presetName('aes-streaming')).toBe('AES TD1004')
    expect(presetName('night')).toBe('Clear dialogue (movies and shows)')
    expect(presetName('custom')).toBe('Custom')
    expect(presetName('quiet-recording')).toBe('Quiet recording')
    expect(presetName('My podcast preset')).toBe('My podcast preset')
  })
})

describe('GAIN_PRESETS', () =>
{
  it('holds the six app presets in dB', () =>
  {
    expect(GAIN_PRESETS.map((p) => [p.id, p.label, p.recipe.gainDb, p.recipe.highpassHz])).toEqual([
      ['gentle-lift', 'Gentle lift', 1, 0],
      ['quiet-recording', 'Quiet recording', 3.5, 60],
      ['voice-clarity', 'Voice clarity', 2.5, 80],
      ['phone-audio', 'Phone audio', 5, 100],
      ['louder', 'Louder', 6, 0],
      ['tone-down', 'Tone down', -2.5, 0]
    ])
  })

  it('sets -1.0 dBTP, a 3 dB allowance, two speakers, and the source codec on every preset', () =>
  {
    for (const p of GAIN_PRESETS)
    {
      expect(p.recipe).toEqual({
        kind: 'boost',
        presetId: p.id,
        gainDb: p.recipe.gainDb,
        highpassHz: p.recipe.highpassHz,
        maxTruePeakDbtp: -1,
        maxLimitingDb: 3,
        mono: 'two-speakers',
        output: { kind: 'same-as-source' }
      })
    }
  })

  it('has unique ids that include the canonical set, Quiet recording and Louder renamed from the percent era', () =>
  {
    const ids = GAIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['gentle-lift', 'quiet-recording', 'voice-clarity', 'phone-audio', 'louder', 'tone-down']))
    expect(ids).not.toContain('maximize')
    expect(ids).not.toContain('quiet-rescue')
  })

  it('keeps gain within -20 to +12 dB in 0.5 dB steps and the maximum within -9 to -1 dBTP', () =>
  {
    for (const p of GAIN_PRESETS)
    {
      expect(p.recipe.gainDb).toBeGreaterThanOrEqual(-20)
      expect(p.recipe.gainDb).toBeLessThanOrEqual(12)
      expect(Number.isInteger(p.recipe.gainDb * 2)).toBe(true)
      expect(p.recipe.maxTruePeakDbtp).toBeGreaterThanOrEqual(-9)
      expect(p.recipe.maxTruePeakDbtp).toBeLessThanOrEqual(-1)
      expect([0, 20, 60, 80, 100]).toContain(p.recipe.highpassHz)
    }
  })

  it('restates each percent-era preset as its gain in dB rounded to the 0.5 dB step', () =>
  {
    const percentEra: Record<string, number> = { 'gentle-lift': 15, 'quiet-recording': 50, 'voice-clarity': 30, 'phone-audio': 75, 'louder': 100, 'tone-down': -25 }
    for (const p of GAIN_PRESETS)
    {
      const db = 20 * Math.log10(1 + percentEra[p.id] / 100)
      expect(p.recipe.gainDb, p.id).toBe(Math.round(db * 2) / 2)
    }
  })

  it('gives the voice presets a high-pass filter', () =>
  {
    for (const id of ['quiet-recording', 'voice-clarity', 'phone-audio'])
    {
      expect(findGainPreset(id)?.recipe.highpassHz, id).toBeGreaterThan(0)
    }
  })

  it('replaces Maximize with Louder: +6.0 dB at -1.0 dBTP instead of a -0.3 dBTP ceiling', () =>
  {
    expect(findGainPreset('louder')?.recipe).toMatchObject({ gainDb: 6, maxTruePeakDbtp: -1 })
  })

  it('keeps the limiter on Tone down, a reduction', () =>
  {
    expect(findGainPreset('tone-down')?.recipe).toMatchObject({ gainDb: -2.5, maxLimitingDb: 3 })
  })
})

const NORMALIZE_FIELDS = ['kind', 'presetId', 'userPreset', 'target', 'policy', 'maxLimitingDb', 'mono', 'monoToStereo', 'downmix',
  'dynamics', 'shortForm', 'cinematic', 'albumGroupId', 'output'].sort()

describe('applyLoudnessPreset', () =>
{
  it('builds the whole EBU R 128 recipe', () =>
  {
    expect(applyLoudnessPreset('ebu-r128', SAME_AS_SOURCE)).toEqual({
      kind: 'normalize',
      presetId: 'ebu-r128',
      userPreset: null,
      target: { integratedLufs: -23, maxTruePeakDbtp: -1, louderMax: null, toleranceLu: 0.2, unit: 'LUFS' },
      policy: 'stop-at-reachable',
      maxLimitingDb: 1,
      mono: 'one-channel',
      monoToStereo: false,
      downmix: null,
      dynamics: null,
      shortForm: { rule: R128_S1, mode: 'auto' },
      cinematic: false,
      albumGroupId: null,
      output: { kind: 'same-as-source' }
    })
  })

  it.each(ALL_IDS)('%s yields a recipe whose values are the preset\'s', (id) =>
  {
    const p = preset(id)
    const recipe = applyLoudnessPreset(id, SAME_AS_SOURCE)
    expect(Object.keys(recipe).sort()).toEqual(NORMALIZE_FIELDS)
    expect(recipe).toMatchObject({
      kind: 'normalize', presetId: id, userPreset: null, target: p.target, policy: p.policy, maxLimitingDb: p.maxLimitingDb,
      mono: p.mono, monoToStereo: p.monoToStereo, downmix: null, dynamics: p.dynamics, cinematic: id === 'film-r128s4', albumGroupId: null
    })
    if (p.shortForm)
    {
      expect(recipe.shortForm).toEqual({ rule: p.shortForm, mode: id === 'custom' ? 'off' : 'auto' })
    }
    else
    {
      expect(recipe.shortForm).toBeNull()
    }
  })

  it('replaces every field of the recipe it is applied over', () =>
  {
    const before: NormalizeRecipe =
    {
      kind: 'normalize',
      presetId: 'night',
      userPreset: { id: 'u1', name: 'Late shows' },
      target: { integratedLufs: -30, maxTruePeakDbtp: -6, louderMax: { aboveLufs: -10, maxTruePeakDbtp: -4 }, toleranceLu: 3, unit: 'LKFS' },
      policy: 'reduce-dynamics',
      maxLimitingDb: 3,
      mono: 'two-speakers',
      monoToStereo: false,
      downmix: 'dialog',
      dynamics: { thresholdOffsetDb: -4, ratio: 6, attackMs: 5, releaseMs: 50 },
      shortForm: { rule: TD1004_SHORT_FORM, mode: 'on' },
      cinematic: true,
      albumGroupId: 'B',
      output: { kind: 'codec', codec: 'opus', kbpsPerPair: 96 }
    }
    const after = applyLoudnessPreset('apple-podcasts', SAME_AS_SOURCE)
    for (const field of NORMALIZE_FIELDS.filter((name) => name !== 'kind'))
    {
      expect(after[field as keyof NormalizeRecipe], field).not.toEqual(before[field as keyof NormalizeRecipe])
    }
  })

  it('copies the output policy and the preset data instead of sharing them', () =>
  {
    const output: EncoderPolicy = { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }
    const recipe = applyLoudnessPreset('spotify', output)
    expect(recipe.output).toEqual(output)
    expect(recipe.output).not.toBe(output)
    expect(recipe.target.louderMax).toEqual({ aboveLufs: -14, maxTruePeakDbtp: -2 })
    recipe.target.integratedLufs = -9
    if (recipe.target.louderMax)
    {
      recipe.target.louderMax.aboveLufs = -9
    }
    const night = applyLoudnessPreset('night', output)
    if (night.dynamics)
    {
      night.dynamics.ratio = 10
    }
    const ebu = applyLoudnessPreset('ebu-r128', output)
    if (ebu.shortForm)
    {
      ebu.shortForm.rule.autoMaxDurationSec = 1
    }
    expect(preset('spotify').target).toEqual({ integratedLufs: -14, maxTruePeakDbtp: -1, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 }, toleranceLu: null, unit: 'LUFS' })
    expect(NIGHT_DYNAMICS.ratio).toBe(3)
    expect(preset('ebu-r128').shortForm?.autoMaxDurationSec).toBe(120)
  })

  it('falls back to Custom for an id it does not know', () =>
  {
    const recipe = applyLoudnessPreset('loudest' as PresetId, SAME_AS_SOURCE)
    expect(recipe.presetId).toBe('custom')
    expect(recipe.target.integratedLufs).toBe(-18)
    expect(recipe.shortForm?.mode).toBe('off')
  })
})

describe('applyGainPreset', () =>
{
  it('builds the whole gain recipe with the given output policy', () =>
  {
    const output: EncoderPolicy = { kind: 'codec', codec: 'flac', kbpsPerPair: null }
    const recipe = applyGainPreset('voice-clarity', output)
    expect(recipe).toEqual({
      kind: 'boost',
      presetId: 'voice-clarity',
      userPreset: null,
      gainDb: 2.5,
      highpassHz: 80,
      maxTruePeakDbtp: -1,
      maxLimitingDb: 3,
      mono: 'two-speakers',
      output: { kind: 'codec', codec: 'flac', kbpsPerPair: null }
    })
    expect(recipe.output).not.toBe(output)
  })

  it('falls back to Gentle lift for an id it does not know', () =>
  {
    expect(applyGainPreset('maximize' as 'louder', SAME_AS_SOURCE).presetId).toBe('gentle-lift')
  })
})
