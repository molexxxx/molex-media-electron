/**
 * Audio recipe ranges, held once for main's validation and the renderer's inputs, and the validator that checks a
 * normalize or gain recipe's shape and ranges before anything plans with it. An empty issue list means valid.
 */
import { GAIN_PRESETS, LOUDNESS_PRESETS } from './presets'
import type { OutputCodec, RecipeIssue } from './types'

/** An inclusive range with the step inputs use. */
export interface AudioRange
{
  min: number
  max: number
  step: number
}

/** Every audio range. The Custom preset's editable ranges equal integratedLufs and maxTruePeakDbtp. */
export const AUDIO_LIMITS =
{
  /** Normalize target, LUFS or LKFS. The floor stays above the -70 absolute gate, where gain stops being predictable. */
  integratedLufs: { min: -60, max: -5, step: 0.5 },
  /** Normalize maximum true peak, dBTP. */
  maxTruePeakDbtp: { min: -9, max: 0, step: 0.1 },
  /** Normalize limiting allowance, dB. */
  normalizeMaxLimitingDb: { min: 0, max: 3, step: 0.5 },
  /** Gain, dB. */
  gainDb: { min: -20, max: 12, step: 0.5 },
  /** Gain maximum true peak, dBTP. */
  boostMaxTruePeakDbtp: { min: -9, max: -1, step: 0.1 },
  /** Gain limiting allowance, dB. */
  boostMaxLimitingDb: { min: 0, max: 6, step: 0.5 },
  /** Output bitrate per channel pair, kb/s. */
  kbpsPerPair: { min: 32, max: 640, step: 1 },
  /** A standard's stated tolerance, LU. */
  toleranceLu: { min: 0, max: 10, step: 0.1 },
  /** Short-form rule: the cap above the target, LU. */
  shortFormAboveTargetLu: { min: 0, max: 10, step: 0.5 },
  /** Short-form rule: the allowance over the cap, LU. */
  shortFormToleranceLu: { min: 0, max: 1, step: 0.1 },
  /** Short-form rule: the longest item automatic mode applies to, seconds. */
  shortFormAutoMaxSec: { min: 1, max: 600, step: 1 },
  /** Compressor threshold offset from the measured loudness, dB. */
  dynamicsThresholdOffsetDb: { min: -30, max: 30, step: 0.5 },
  /** Compressor ratio (FFmpeg acompressor accepts 1 to 20). */
  dynamicsRatio: { min: 1, max: 20, step: 0.5 },
  /** Compressor attack, ms (FFmpeg acompressor accepts 0.01 to 2000). */
  dynamicsAttackMs: { min: 0.01, max: 2000, step: 1 },
  /** Compressor release, ms (FFmpeg acompressor accepts 0.01 to 9000). */
  dynamicsReleaseMs: { min: 0.01, max: 9000, step: 1 }
} as const satisfies Readonly<Record<string, AudioRange>>

/** High-pass corner frequencies a gain recipe offers; 0 is off. */
export const HIGHPASS_HZ: readonly number[] = [0, 20, 60, 80, 100]

/** Every output codec an encoder policy can name. */
export const OUTPUT_CODECS: readonly OutputCodec[] = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm', 'wmav2']

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields
{
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function join(path: string, key: string): string
{
  return path ? `${path}.${key}` : key
}

/** Collects one issue per field. */
class Check
{
  readonly issues: RecipeIssue[] = []

  add(path: string, message: string): void
  {
    this.issues.push({ path, message })
  }

  /** Flags keys outside the shape; returns the object, or null after flagging a non-object. */
  shape(value: unknown, path: string, keys: readonly string[], what: string): Fields | null
  {
    if (!isFields(value))
    {
      this.add(path, `Must be ${what}.`)
      return null
    }
    for (const key of Object.keys(value))
    {
      if (!keys.includes(key))
      {
        this.add(join(path, key), 'Unknown field.')
      }
    }
    return value
  }

  range(fields: Fields, path: string, key: string, range: AudioRange, unit: string): void
  {
    const value = fields[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max)
    {
      this.add(join(path, key), `Must be a number from ${range.min} to ${range.max}${unit ? ` ${unit}` : ''}.`)
    }
  }

  oneOf(fields: Fields, path: string, key: string, values: readonly unknown[]): void
  {
    if (!values.includes(fields[key]))
    {
      this.add(join(path, key), `Must be one of: ${values.map((v) => (v === null ? 'null' : String(v))).join(', ')}.`)
    }
  }

  flag(fields: Fields, path: string, key: string): void
  {
    if (typeof fields[key] !== 'boolean')
    {
      this.add(join(path, key), 'Must be true or false.')
    }
  }

  userPreset(fields: Fields, path: string): void
  {
    const value = fields.userPreset
    if (value === null)
    {
      return
    }
    const ref = this.shape(value, join(path, 'userPreset'), ['id', 'name'], 'null or a user preset reference')
    if (ref && (typeof ref.id !== 'string' || ref.id === '' || typeof ref.name !== 'string'))
    {
      this.add(join(path, 'userPreset'), 'Must have a non-empty id and a name.')
    }
  }

  output(fields: Fields, path: string): void
  {
    const at = join(path, 'output')
    const value = fields.output
    if (isFields(value) && value.kind === 'same-as-source')
    {
      this.shape(value, at, ['kind'], 'an encoder policy')
      return
    }
    const policy = this.shape(value, at, ['kind', 'codec', 'kbpsPerPair'], 'an encoder policy')
    if (!policy)
    {
      return
    }
    if (policy.kind !== 'codec')
    {
      this.add(join(at, 'kind'), 'Must be one of: same-as-source, codec.')
      return
    }
    this.oneOf(policy, at, 'codec', OUTPUT_CODECS)
    if (policy.kbpsPerPair !== null)
    {
      this.range(policy, at, 'kbpsPerPair', AUDIO_LIMITS.kbpsPerPair, 'kb/s')
    }
  }
}

const NORMALIZE_KEYS = ['kind', 'presetId', 'userPreset', 'target', 'policy', 'maxLimitingDb', 'mono', 'monoToStereo', 'downmix',
  'dynamics', 'shortForm', 'cinematic', 'albumGroupId', 'output']
const BOOST_KEYS = ['kind', 'presetId', 'userPreset', 'gainDb', 'highpassHz', 'maxTruePeakDbtp', 'maxLimitingDb', 'mono', 'output']
const MONO = ['one-channel', 'two-speakers']
const ALBUM_GROUP = /^[A-Z]{1,3}$/

function checkTarget(check: Check, recipe: Fields): void
{
  const target = check.shape(recipe.target, 'target', ['integratedLufs', 'maxTruePeakDbtp', 'louderMax', 'toleranceLu', 'unit'], 'a loudness target')
  if (!target)
  {
    return
  }
  check.range(target, 'target', 'integratedLufs', AUDIO_LIMITS.integratedLufs, 'LUFS')
  check.range(target, 'target', 'maxTruePeakDbtp', AUDIO_LIMITS.maxTruePeakDbtp, 'dBTP')
  check.oneOf(target, 'target', 'unit', ['LUFS', 'LKFS'])
  if (target.toleranceLu !== null)
  {
    check.range(target, 'target', 'toleranceLu', AUDIO_LIMITS.toleranceLu, 'LU')
  }
  if (target.louderMax !== null)
  {
    const louder = check.shape(target.louderMax, 'target.louderMax', ['aboveLufs', 'maxTruePeakDbtp'], 'null or a louder-output maximum')
    if (louder)
    {
      check.range(louder, 'target.louderMax', 'aboveLufs', AUDIO_LIMITS.integratedLufs, 'LUFS')
      check.range(louder, 'target.louderMax', 'maxTruePeakDbtp', AUDIO_LIMITS.maxTruePeakDbtp, 'dBTP')
    }
  }
}

function checkDynamics(check: Check, recipe: Fields): void
{
  if (recipe.dynamics === null)
  {
    if (recipe.policy === 'reduce-dynamics')
    {
      check.add('dynamics', 'Must be set when the policy is reduce-dynamics.')
    }
    return
  }
  const dynamics = check.shape(recipe.dynamics, 'dynamics', ['thresholdOffsetDb', 'ratio', 'attackMs', 'releaseMs'], 'null or a compressor')
  if (dynamics)
  {
    check.range(dynamics, 'dynamics', 'thresholdOffsetDb', AUDIO_LIMITS.dynamicsThresholdOffsetDb, 'dB')
    check.range(dynamics, 'dynamics', 'ratio', AUDIO_LIMITS.dynamicsRatio, '')
    check.range(dynamics, 'dynamics', 'attackMs', AUDIO_LIMITS.dynamicsAttackMs, 'ms')
    check.range(dynamics, 'dynamics', 'releaseMs', AUDIO_LIMITS.dynamicsReleaseMs, 'ms')
  }
}

function checkShortForm(check: Check, recipe: Fields): void
{
  if (recipe.shortForm === null)
  {
    return
  }
  const shortForm = check.shape(recipe.shortForm, 'shortForm', ['rule', 'mode'], 'null or a short-form setting')
  if (!shortForm)
  {
    return
  }
  check.oneOf(shortForm, 'shortForm', 'mode', ['auto', 'on', 'off'])
  const rule = check.shape(shortForm.rule, 'shortForm.rule', ['maxAboveTargetLu', 'toleranceLu', 'autoMaxDurationSec'], 'a short-form rule')
  if (rule)
  {
    check.range(rule, 'shortForm.rule', 'maxAboveTargetLu', AUDIO_LIMITS.shortFormAboveTargetLu, 'LU')
    check.range(rule, 'shortForm.rule', 'toleranceLu', AUDIO_LIMITS.shortFormToleranceLu, 'LU')
    check.range(rule, 'shortForm.rule', 'autoMaxDurationSec', AUDIO_LIMITS.shortFormAutoMaxSec, 's')
  }
}

function checkNormalize(check: Check, recipe: Fields): void
{
  check.oneOf(recipe, '', 'presetId', LOUDNESS_PRESETS.map((preset) => preset.id))
  check.userPreset(recipe, '')
  checkTarget(check, recipe)
  check.oneOf(recipe, '', 'policy', ['stop-at-reachable', 'peak-limit', 'reduce-dynamics'])
  check.range(recipe, '', 'maxLimitingDb', AUDIO_LIMITS.normalizeMaxLimitingDb, 'dB')
  check.oneOf(recipe, '', 'mono', MONO)
  check.flag(recipe, '', 'monoToStereo')
  check.oneOf(recipe, '', 'downmix', [null, 'standard', 'dialog'])
  checkDynamics(check, recipe)
  checkShortForm(check, recipe)
  check.flag(recipe, '', 'cinematic')
  if (recipe.albumGroupId !== null && (typeof recipe.albumGroupId !== 'string' || !ALBUM_GROUP.test(recipe.albumGroupId)))
  {
    check.add('albumGroupId', 'Must be null or one to three capital letters.')
  }
  check.output(recipe, '')
}

function checkBoost(check: Check, recipe: Fields): void
{
  check.oneOf(recipe, '', 'presetId', [...GAIN_PRESETS.map((preset) => preset.id), 'custom'])
  check.userPreset(recipe, '')
  check.range(recipe, '', 'gainDb', AUDIO_LIMITS.gainDb, 'dB')
  check.oneOf(recipe, '', 'highpassHz', HIGHPASS_HZ)
  check.range(recipe, '', 'maxTruePeakDbtp', AUDIO_LIMITS.boostMaxTruePeakDbtp, 'dBTP')
  check.range(recipe, '', 'maxLimitingDb', AUDIO_LIMITS.boostMaxLimitingDb, 'dB')
  check.oneOf(recipe, '', 'mono', MONO)
  check.output(recipe, '')
}

/** Every shape and range problem of a normalize or gain recipe, one issue per field; empty when the recipe is valid. */
export function validateAudioRecipe(input: unknown): RecipeIssue[]
{
  const check = new Check()
  if (!isFields(input))
  {
    check.add('', 'Must be a normalize or gain recipe.')
    return check.issues
  }
  if (input.kind === 'normalize')
  {
    check.shape(input, '', NORMALIZE_KEYS, 'a normalize recipe')
    checkNormalize(check, input)
  }
  else if (input.kind === 'boost')
  {
    check.shape(input, '', BOOST_KEYS, 'a gain recipe')
    checkBoost(check, input)
  }
  else
  {
    check.add('kind', 'Must be one of: normalize, boost.')
  }
  return check.issues
}
