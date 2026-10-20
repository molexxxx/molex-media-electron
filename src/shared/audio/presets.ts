/**
 * Built-in loudness presets with the documents they rest on, the app's gain presets, and the functions that
 * turn a preset into a whole recipe. Main plans with these values and the renderer shows them; no other module
 * holds preset values.
 */
import type { BoostRecipe, DynamicsSpec, EncoderPolicy, LoudnessTarget, MonoPolicy, NormalizeRecipe, ShortFormRule, UnreachablePolicy } from './types'

/** A built-in loudness preset; 'custom' marks a recipe that follows no preset. */
export type PresetId =
  | 'ebu-r128' | 'atsc-a85' | 'film-r128s4' | 'apple-podcasts' | 'spotify' | 'streaming-r128s2' | 'aes-streaming' | 'night' | 'custom'

/** A cited document: the clauses relied on (empty when the whole document is cited), its link, and the ISO date it was fetched. */
export interface StandardRef { name: string; clause: string; url: string; fetched: string }

/** A built-in loudness preset as the presets table and the standard line show it. */
export interface LoudnessPreset
{
  id: PresetId
  /** Short enough for a table cell, a toast, and a stamp tooltip. */
  label: string
  /** The name messages use; null when the preset is not a standard. */
  standardName: string | null
  target: LoudnessTarget
  /** Decimals the source uses when it states the target: EBU R 128 writes -23.0 LUFS, Apple -16 LKFS. */
  targetDecimals: 0 | 1
  /** The editable integrated range; null when the preset fixes the target. */
  targetRange: readonly [number, number] | null
  /** The editable true-peak range; null when the preset fixes the maximum. */
  truePeakRange: readonly [number, number] | null
  /** The standard's tolerance in its own words; null when it states none. */
  toleranceText: string | null
  /** The preset's word for deviations and checks. */
  deviationUnit: 'LU' | 'dB'
  policy: UnreachablePolicy
  maxLimitingDb: number
  /** Fixed by every preset except Custom. */
  mono: MonoPolicy
  monoToStereo: boolean
  minSampleRate: number | null
  dynamics: DynamicsSpec | null
  shortForm: ShortFormRule | null
  album: 'track' | 'track-or-album'
  /** False labels the preset as not a standard. */
  standard: boolean
  /** The standard an app preset takes its level from, named in its details; absent for a standard. */
  builtOn?: string
  supersededBy: string | null
  measurementNote: string | null
  sources: readonly StandardRef[]
}

/** An app gain preset; the page adds the values to the label ("Gentle lift +1.0 dB"). */
export type GainPresetId = 'gentle-lift' | 'quiet-recording' | 'voice-clarity' | 'phone-audio' | 'louder' | 'tone-down' | 'custom'

/** A gain preset and the recipe it applies. */
export interface GainPreset
{
  id: GainPresetId
  label: string
  recipe: Omit<BoostRecipe, 'userPreset'>
}

/** The preset a new install normalizes with. */
export const DEFAULT_LOUDNESS_PRESET: PresetId = 'streaming-r128s2'

/** The Clear dialogue compressor, also used by the 'reduce-dynamics' policy. */
export const NIGHT_DYNAMICS: DynamicsSpec = { thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 300 }

const FETCHED = '2026-10-15'

const R128 = { name: 'EBU R 128 V5 (November 2023)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128.pdf' }
const R128_S1 = { name: 'EBU R 128 s1 (August 2020)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s1.pdf' }
const R128_S2 = { name: 'EBU R 128 s2 V3 (November 2023)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s2.pdf' }
const R128_S4 = { name: 'EBU R 128 s4 (November 2023)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s4.pdf' }
const TECH_3344 = { name: 'EBU Tech 3344 version 2.1 (July 2016)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/tech/tech3344.pdf' }
const TECH_3343 = { name: 'EBU Tech 3343 (November 2023)', url: 'https://tech.ebu.ch/files/live/sites/tech/files/shared/tech/tech3343.pdf' }
const A85 = { name: 'ATSC A/85:2026-07 (8 July 2026)', url: 'https://www.atsc.org/wp-content/uploads/2026/07/A85-2026-07.pdf' }
const TD1004 = { name: 'AES TD1004.1.15-10 (version 1.0, 19 October 2015)', url: 'https://aes.org/wp-content/uploads/2024/01/AESTD1004_1_15_10.pdf' }
const SPOTIFY = { name: 'Spotify for Artists: Loudness normalization', url: 'https://support.spotify.com/us/artists/article/loudness-normalization/' }
const APPLE = { name: 'Apple Podcasts for Creators: Audio requirements', url: 'https://podcasters.apple.com/support/893-audio-requirements' }
const RADIO_WORLD =
{
  name: 'Radio World: AES Publishes Loudness Guidelines for Online Audio (2023-07-19)',
  url: 'https://www.radioworld.com/news-and-business/headlines/aes-publishes-loudness-guidelines-for-online-audio'
}
const TELOS = { name: 'Telos Alliance: Understanding Loudness for Streaming Audio', url: 'https://docs.telosalliance.com/docs/understanding-loudness-for-streaming-audio' }

function cite(doc: { name: string; url: string }, clause: string, fetched: string = FETCHED): StandardRef
{
  return { name: doc.name, clause, url: doc.url, fetched }
}

function target(integratedLufs: number, maxTruePeakDbtp: number, toleranceLu: number | null, unit: 'LUFS' | 'LKFS'): LoudnessTarget
{
  return { integratedLufs, maxTruePeakDbtp, louderMax: null, toleranceLu, unit }
}

/** Every built-in loudness preset, in the order the preset select lists them. */
export const LOUDNESS_PRESETS: readonly LoudnessPreset[] =
[
  {
    id: 'ebu-r128',
    label: 'EBU R 128',
    standardName: 'EBU R 128',
    target: target(-23, -1, 0.2, 'LUFS'),
    targetDecimals: 1,
    targetRange: null,
    truePeakRange: null,
    toleranceText: '0.2 LU',
    deviationUnit: 'LU',
    policy: 'stop-at-reachable',
    maxLimitingDb: 1,
    mono: 'one-channel',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 },
    album: 'track',
    standard: true,
    supersededBy: null,
    measurementNote: null,
    sources: [cite(R128, '(h), (i), (m), (q)'), cite(R128_S1, '(d)'), cite(TECH_3344, ''), cite(TECH_3343, 'sections 3.1 and 3.3')]
  },
  {
    id: 'atsc-a85',
    label: 'ATSC A/85 (short-form method)',
    standardName: 'ATSC A/85',
    target: target(-24, -2, 2, 'LKFS'),
    targetDecimals: 0,
    targetRange: null,
    truePeakRange: null,
    toleranceText: '2 dB ("anticipated, due to measurement variations"; "should not be targeted to the high or low side")',
    deviationUnit: 'dB',
    policy: 'stop-at-reachable',
    maxLimitingDb: 1,
    mono: 'one-channel',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: null,
    album: 'track',
    standard: true,
    supersededBy: null,
    measurementNote: 'A/85\'s method for short-form content (section 5.2.6), not its method for long-form content',
    sources: [cite(A85, 'sections 5.1.1, 5.2.2, 5.2.4, 5.2.6, 6; Annex M footnotes 31 and 32')]
  },
  {
    id: 'film-r128s4',
    label: 'Film and series (EBU R 128 s4)',
    standardName: 'EBU R 128 s4',
    target: target(-23, -1, 0.2, 'LUFS'),
    targetDecimals: 1,
    targetRange: null,
    truePeakRange: null,
    toleranceText: '0.2 LU (s4 (l), (m) refer to R 128\'s tolerances)',
    deviationUnit: 'LU',
    policy: 'stop-at-reachable',
    maxLimitingDb: 1,
    mono: 'one-channel',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: null,
    album: 'track',
    standard: true,
    supersededBy: null,
    measurementNote: 'Measured on the full mix with a BS.1770 meter, as s4 (g) specifies for Programme Loudness',
    sources: [cite(R128_S4, '(g), (i), (j), (l), (m)'), cite(R128, '(i)')]
  },
  {
    id: 'apple-podcasts',
    label: 'Podcast (Apple Podcasts)',
    standardName: 'Apple Podcasts',
    target: target(-16, -1, 1, 'LKFS'),
    targetDecimals: 0,
    targetRange: null,
    truePeakRange: null,
    toleranceText: '1 dB',
    deviationUnit: 'dB',
    policy: 'peak-limit',
    maxLimitingDb: 1,
    mono: 'one-channel',
    monoToStereo: true,
    minSampleRate: 44100,
    dynamics: null,
    shortForm: null,
    album: 'track',
    standard: true,
    supersededBy: null,
    measurementNote: null,
    sources: [cite(APPLE, '')]
  },
  {
    id: 'spotify',
    label: 'Music streaming (Spotify reference)',
    standardName: 'Spotify',
    target: { integratedLufs: -14, maxTruePeakDbtp: -1, louderMax: { aboveLufs: -14, maxTruePeakDbtp: -2 }, toleranceLu: null, unit: 'LUFS' },
    targetDecimals: 0,
    targetRange: null,
    truePeakRange: null,
    toleranceText: null,
    deviationUnit: 'LU',
    policy: 'peak-limit',
    maxLimitingDb: 1,
    mono: 'two-speakers',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: null,
    album: 'track-or-album',
    standard: true,
    supersededBy: null,
    measurementNote: null,
    sources: [cite(SPOTIFY, '')]
  },
  {
    id: 'streaming-r128s2',
    label: 'Streaming (EBU R 128 s2)',
    standardName: 'EBU R 128 s2',
    target: target(-18, -1, null, 'LUFS'),
    targetDecimals: 0,
    targetRange: [-20, -16],
    truePeakRange: null,
    toleranceText: null,
    deviationUnit: 'LU',
    policy: 'peak-limit',
    maxLimitingDb: 1,
    mono: 'one-channel',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: null,
    album: 'track-or-album',
    standard: true,
    supersededBy: null,
    measurementNote: null,
    sources: [cite(R128_S2, '(d), (e), (g), (i)'), cite(R128, '(m)'), cite(TECH_3344, '')]
  },
  {
    id: 'aes-streaming',
    label: 'Streaming (AES TD1004, superseded)',
    standardName: 'AES TD1004',
    target: target(-18, -1, 0.5, 'LUFS'),
    targetDecimals: 0,
    targetRange: [-20, -16],
    truePeakRange: null,
    toleranceText: '0.5 LU ("prerecorded files may be matched within ±0.5 LU, for example", 4.B)',
    deviationUnit: 'LU',
    policy: 'stop-at-reachable',
    maxLimitingDb: 1,
    mono: 'two-speakers',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: { maxAboveTargetLu: 5, toleranceLu: 0, autoMaxDurationSec: 60 },
    album: 'track-or-album',
    standard: true,
    supersededBy: 'AES TD1008 (2021) and AES77-2023',
    measurementNote: null,
    sources:
    [
      cite(TD1004, 'sections 3, 4.B, 4.C, 5, 6, 9 items 4 and 6'),
      cite(RADIO_WORLD, '', '2026-10-16'),
      cite(TELOS, '', '2026-10-16')
    ]
  },
  {
    id: 'night',
    label: 'Clear dialogue (movies and shows)',
    standardName: null,
    target: target(-18, -1, null, 'LUFS'),
    targetDecimals: 0,
    targetRange: [-24, -14],
    truePeakRange: null,
    toleranceText: null,
    deviationUnit: 'LU',
    policy: 'reduce-dynamics',
    maxLimitingDb: 1,
    mono: 'two-speakers',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: NIGHT_DYNAMICS,
    shortForm: null,
    album: 'track',
    standard: false,
    builtOn: 'EBU R 128 s2',
    supersededBy: null,
    measurementNote: null,
    sources: [cite(R128_S2, '(g)')]
  },
  {
    id: 'custom',
    label: 'Custom',
    standardName: null,
    target: target(-18, -1, null, 'LUFS'),
    targetDecimals: 1,
    targetRange: [-60, -5],
    truePeakRange: [-9, 0],
    toleranceText: null,
    deviationUnit: 'LU',
    policy: 'stop-at-reachable',
    maxLimitingDb: 1,
    mono: 'two-speakers',
    monoToStereo: false,
    minSampleRate: null,
    dynamics: null,
    shortForm: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 },
    album: 'track',
    standard: false,
    supersededBy: null,
    measurementNote: null,
    sources: []
  }
]

function gainPreset(id: GainPresetId, label: string, gainDb: number, highpassHz: BoostRecipe['highpassHz']): GainPreset
{
  return {
    id,
    label,
    recipe:
    {
      kind: 'boost',
      presetId: id,
      gainDb,
      highpassHz,
      maxTruePeakDbtp: -1,
      maxLimitingDb: 3,
      mono: 'two-speakers',
      output: { kind: 'same-as-source' }
    }
  }
}

/** The app's gain presets, not standards; each keeps the limiter at -1.0 dBTP with a 3 dB allowance. */
export const GAIN_PRESETS: readonly GainPreset[] =
[
  gainPreset('gentle-lift', 'Gentle lift', 1, 0),
  gainPreset('quiet-recording', 'Quiet recording', 3.5, 60),
  gainPreset('voice-clarity', 'Voice clarity', 2.5, 80),
  gainPreset('phone-audio', 'Phone audio', 5, 100),
  gainPreset('louder', 'Louder', 6, 0),
  gainPreset('tone-down', 'Tone down', -2.5, 0)
]

/** The loudness preset with this id, or null when the id names none. */
export function findLoudnessPreset(id: string): LoudnessPreset | null
{
  return LOUDNESS_PRESETS.find((preset) => preset.id === id) ?? null
}

/** The gain preset with this id, or null when the id names none. */
export function findGainPreset(id: string): GainPreset | null
{
  return GAIN_PRESETS.find((preset) => preset.id === id) ?? null
}

/** The name a sentence uses for a preset: the standard's name, else the label; an unknown id is returned as is. */
export function presetName(id: string): string
{
  const loudness = findLoudnessPreset(id)
  if (loudness)
  {
    return loudness.standardName ?? loudness.label
  }
  return findGainPreset(id)?.label ?? id
}

function copyOutput(output: EncoderPolicy): EncoderPolicy
{
  return output.kind === 'codec' ? { kind: 'codec', codec: output.codec, kbpsPerPair: output.kbpsPerPair } : { kind: 'same-as-source' }
}

/** A whole normalize recipe from a preset and an output policy; nothing of an earlier recipe survives. */
export function applyLoudnessPreset(id: PresetId, output: EncoderPolicy): NormalizeRecipe
{
  const preset = findLoudnessPreset(id) ?? (findLoudnessPreset('custom') as LoudnessPreset)
  const { louderMax } = preset.target
  return {
    kind: 'normalize',
    presetId: preset.id,
    userPreset: null,
    target: { ...preset.target, louderMax: louderMax ? { ...louderMax } : null },
    policy: preset.policy,
    maxLimitingDb: preset.maxLimitingDb,
    mono: preset.mono,
    monoToStereo: preset.monoToStereo,
    downmix: null,
    dynamics: preset.dynamics ? { ...preset.dynamics } : null,
    shortForm: preset.shortForm ? { rule: { ...preset.shortForm }, mode: preset.id === 'custom' ? 'off' : 'auto' } : null,
    cinematic: preset.id === 'film-r128s4',
    albumGroupId: null,
    output: copyOutput(output)
  }
}

/** A whole gain recipe from a gain preset and an output policy. */
export function applyGainPreset(id: Exclude<GainPresetId, 'custom'>, output: EncoderPolicy): BoostRecipe
{
  const preset = findGainPreset(id) ?? GAIN_PRESETS[0]
  return { ...preset.recipe, userPreset: null, output: copyOutput(output) }
}
