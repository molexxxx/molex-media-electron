/**
 * Audio recipe ranges and validation: no issue at any range limit, one issue for each field outside its range or
 * shape, and the Custom preset's editable ranges equal to these limits.
 */
import { describe, it, expect } from 'vitest'
import { AUDIO_LIMITS, HIGHPASS_HZ, OUTPUT_CODECS, validateAudioRecipe } from '../../../src/shared/audio/limits'
import { GAIN_PRESETS, LOUDNESS_PRESETS, applyGainPreset, applyLoudnessPreset, findLoudnessPreset, type GainPresetId } from '../../../src/shared/audio/presets'
import type { NormalizeRecipe } from '../../../src/shared/audio/types'

function normalize(change: Record<string, unknown> = {}): Record<string, unknown>
{
  return { ...applyLoudnessPreset('custom', { kind: 'codec', codec: 'aac', kbpsPerPair: 256 }), ...change }
}

function boost(change: Record<string, unknown> = {}): Record<string, unknown>
{
  return { ...applyGainPreset('gentle-lift', { kind: 'same-as-source' }), ...change }
}

function target(change: Record<string, unknown>): Record<string, unknown>
{
  return normalize({ target: { ...(normalize().target as object), ...change } })
}

function paths(input: unknown): string[]
{
  return validateAudioRecipe(input).map((issue) => issue.path)
}

describe('the Custom preset and the limits agree', () =>
{
  it('uses -60 to -5 LUFS and -9 to 0 dBTP for the editable ranges', () =>
  {
    const custom = findLoudnessPreset('custom')
    expect(custom?.targetRange).toEqual([AUDIO_LIMITS.integratedLufs.min, AUDIO_LIMITS.integratedLufs.max])
    expect(custom?.truePeakRange).toEqual([AUDIO_LIMITS.maxTruePeakDbtp.min, AUDIO_LIMITS.maxTruePeakDbtp.max])
    expect(AUDIO_LIMITS.integratedLufs).toEqual({ min: -60, max: -5, step: 0.5 })
    expect(AUDIO_LIMITS.maxTruePeakDbtp).toEqual({ min: -9, max: 0, step: 0.1 })
  })

  it('holds the allowance, gain, and boost peak ranges', () =>
  {
    expect(AUDIO_LIMITS.normalizeMaxLimitingDb).toMatchObject({ min: 0, max: 3 })
    expect(AUDIO_LIMITS.boostMaxLimitingDb).toMatchObject({ min: 0, max: 6 })
    expect(AUDIO_LIMITS.gainDb).toEqual({ min: -20, max: 12, step: 0.5 })
    expect(AUDIO_LIMITS.boostMaxTruePeakDbtp).toMatchObject({ min: -9, max: -1 })
    expect(HIGHPASS_HZ).toEqual([0, 20, 60, 80, 100])
    expect(OUTPUT_CODECS).toContain('wmav2')
  })

  it('keeps every preset editable range inside the limits', () =>
  {
    for (const preset of LOUDNESS_PRESETS)
    {
      for (const value of [...(preset.targetRange ?? []), preset.target.integratedLufs])
      {
        expect(value, preset.id).toBeGreaterThanOrEqual(AUDIO_LIMITS.integratedLufs.min)
        expect(value, preset.id).toBeLessThanOrEqual(AUDIO_LIMITS.integratedLufs.max)
      }
    }
  })
})

describe('validateAudioRecipe accepts', () =>
{
  it('every recipe a loudness or gain preset produces', () =>
  {
    for (const preset of LOUDNESS_PRESETS)
    {
      expect(validateAudioRecipe(applyLoudnessPreset(preset.id, { kind: 'same-as-source' })), preset.id).toEqual([])
    }
    for (const preset of GAIN_PRESETS)
    {
      expect(validateAudioRecipe(applyGainPreset(preset.id as Exclude<GainPresetId, 'custom'>, { kind: 'same-as-source' })), preset.id).toEqual([])
    }
  })

  it.each([
    ['integrated at -60 LUFS', target({ integratedLufs: -60 })],
    ['integrated at -5 LUFS', target({ integratedLufs: -5 })],
    ['true peak at -9 dBTP', target({ maxTruePeakDbtp: -9 })],
    ['true peak at 0 dBTP', target({ maxTruePeakDbtp: 0 })],
    ['a tolerance of 0', target({ toleranceLu: 0 })],
    ['a louder-output maximum at its limits', target({ louderMax: { aboveLufs: -60, maxTruePeakDbtp: 0 } })],
    ['no limiting allowance', normalize({ maxLimitingDb: 0 })],
    ['a 3 dB limiting allowance', normalize({ maxLimitingDb: 3 })],
    ['a 32 kb/s pair', normalize({ output: { kind: 'codec', codec: 'opus', kbpsPerPair: 32 } })],
    ['a 640 kb/s pair', normalize({ output: { kind: 'codec', codec: 'eac3', kbpsPerPair: 640 } })],
    ['an encoder default bitrate', normalize({ output: { kind: 'codec', codec: 'flac', kbpsPerPair: null } })],
    ['a compressor at its limits', normalize({ policy: 'reduce-dynamics', dynamics: { thresholdOffsetDb: -30, ratio: 20, attackMs: 0.01, releaseMs: 9000 } })],
    ['a compressor at its other limits', normalize({ dynamics: { thresholdOffsetDb: 30, ratio: 1, attackMs: 2000, releaseMs: 0.01 } })],
    ['a short-form rule at its limits', normalize({ shortForm: { rule: { maxAboveTargetLu: 10, toleranceLu: 1, autoMaxDurationSec: 600 }, mode: 'on' } })],
    ['a short-form rule at its other limits', normalize({ shortForm: { rule: { maxAboveTargetLu: 0, toleranceLu: 0, autoMaxDurationSec: 1 }, mode: 'auto' } })],
    ['no short-form rule', normalize({ shortForm: null })],
    ['an album group', normalize({ albumGroupId: 'AA' })],
    ['a user preset', normalize({ userPreset: { id: 'u-1', name: 'Late shows' } })],
    ['dialog downmix', normalize({ downmix: 'dialog' })]
  ])('a normalize recipe with %s', (_name, recipe) =>
  {
    expect(validateAudioRecipe(recipe)).toEqual([])
  })

  it.each([
    ['-20 dB', boost({ gainDb: -20 })],
    ['+12 dB', boost({ gainDb: 12 })],
    ['a -9 dBTP maximum', boost({ maxTruePeakDbtp: -9 })],
    ['a -1 dBTP maximum', boost({ maxTruePeakDbtp: -1 })],
    ['no limiting allowance', boost({ maxLimitingDb: 0 })],
    ['a 6 dB allowance', boost({ maxLimitingDb: 6 })],
    ['a 100 Hz high-pass', boost({ highpassHz: 100 })],
    ['the custom id', boost({ presetId: 'custom' })]
  ])('a gain recipe at %s', (_name, recipe) =>
  {
    expect(validateAudioRecipe(recipe)).toEqual([])
  })
})

describe('validateAudioRecipe reports one issue per field', () =>
{
  it.each([
    ['integrated under -60', target({ integratedLufs: -60.1 }), 'target.integratedLufs', 'Must be a number from -60 to -5 LUFS.'],
    ['integrated over -5', target({ integratedLufs: -4.9 }), 'target.integratedLufs', 'Must be a number from -60 to -5 LUFS.'],
    ['true peak under -9', target({ maxTruePeakDbtp: -9.1 }), 'target.maxTruePeakDbtp', 'Must be a number from -9 to 0 dBTP.'],
    ['true peak over 0', target({ maxTruePeakDbtp: 0.1 }), 'target.maxTruePeakDbtp', 'Must be a number from -9 to 0 dBTP.'],
    ['a non-finite target', target({ integratedLufs: Number.NaN }), 'target.integratedLufs', 'Must be a number from -60 to -5 LUFS.'],
    ['a text target', target({ integratedLufs: '-18' }), 'target.integratedLufs', 'Must be a number from -60 to -5 LUFS.'],
    ['an unknown unit', target({ unit: 'dB' }), 'target.unit', 'Must be one of: LUFS, LKFS.'],
    ['a negative tolerance', target({ toleranceLu: -1 }), 'target.toleranceLu', 'Must be a number from 0 to 10 LU.'],
    ['a louder maximum over 0', target({ louderMax: { aboveLufs: -14, maxTruePeakDbtp: 1 } }), 'target.louderMax.maxTruePeakDbtp', 'Must be a number from -9 to 0 dBTP.'],
    ['a louder threshold under -60', target({ louderMax: { aboveLufs: -61, maxTruePeakDbtp: -2 } }), 'target.louderMax.aboveLufs', 'Must be a number from -60 to -5 LUFS.'],
    ['a louder maximum that is not an object', target({ louderMax: 3 }), 'target.louderMax', 'Must be null or a louder-output maximum.'],
    ['an allowance over 3', normalize({ maxLimitingDb: 3.5 }), 'maxLimitingDb', 'Must be a number from 0 to 3 dB.'],
    ['a negative allowance', normalize({ maxLimitingDb: -0.5 }), 'maxLimitingDb', 'Must be a number from 0 to 3 dB.'],
    ['an unknown preset', normalize({ presetId: 'youtube' }), 'presetId', 'Must be one of: ebu-r128, atsc-a85, film-r128s4, apple-podcasts, spotify, streaming-r128s2, aes-streaming, night, custom.'],
    ['an unknown policy', normalize({ policy: 'loudnorm' }), 'policy', 'Must be one of: stop-at-reachable, peak-limit, reduce-dynamics.'],
    ['an unknown mono policy', normalize({ mono: 'one-speaker' }), 'mono', 'Must be one of: one-channel, two-speakers.'],
    ['a text duplication flag', normalize({ monoToStereo: 'yes' }), 'monoToStereo', 'Must be true or false.'],
    ['an unknown downmix', normalize({ downmix: 'binaural' }), 'downmix', 'Must be one of: null, standard, dialog.'],
    ['a missing cinematic flag', normalize({ cinematic: undefined }), 'cinematic', 'Must be true or false.'],
    ['a lowercase album group', normalize({ albumGroupId: 'a' }), 'albumGroupId', 'Must be null or one to three capital letters.'],
    ['a numeric album group', normalize({ albumGroupId: 1 }), 'albumGroupId', 'Must be null or one to three capital letters.'],
    ['a compressor ratio over 20', normalize({ dynamics: { thresholdOffsetDb: 0, ratio: 21, attackMs: 25, releaseMs: 300 } }), 'dynamics.ratio', 'Must be a number from 1 to 20.'],
    ['a compressor attack under 0.01', normalize({ dynamics: { thresholdOffsetDb: 0, ratio: 3, attackMs: 0, releaseMs: 300 } }), 'dynamics.attackMs', 'Must be a number from 0.01 to 2000 ms.'],
    ['a compressor release over 9000', normalize({ dynamics: { thresholdOffsetDb: 0, ratio: 3, attackMs: 25, releaseMs: 9001 } }), 'dynamics.releaseMs', 'Must be a number from 0.01 to 9000 ms.'],
    ['a compressor offset over 30', normalize({ dynamics: { thresholdOffsetDb: 31, ratio: 3, attackMs: 25, releaseMs: 300 } }), 'dynamics.thresholdOffsetDb', 'Must be a number from -30 to 30 dB.'],
    ['a compressor that is not an object', normalize({ dynamics: 'night' }), 'dynamics', 'Must be null or a compressor.'],
    ['reduce dynamics without a compressor', normalize({ policy: 'reduce-dynamics', dynamics: null }), 'dynamics', 'Must be set when the policy is reduce-dynamics.'],
    ['an unknown short-form mode', normalize({ shortForm: { rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'always' } }), 'shortForm.mode', 'Must be one of: auto, on, off.'],
    ['a short-form cap over 10', normalize({ shortForm: { rule: { maxAboveTargetLu: 11, toleranceLu: 0.2, autoMaxDurationSec: 120 }, mode: 'on' } }), 'shortForm.rule.maxAboveTargetLu', 'Must be a number from 0 to 10 LU.'],
    ['a short-form allowance over 1', normalize({ shortForm: { rule: { maxAboveTargetLu: 5, toleranceLu: 1.5, autoMaxDurationSec: 120 }, mode: 'on' } }), 'shortForm.rule.toleranceLu', 'Must be a number from 0 to 1 LU.'],
    ['a short-form duration over 600', normalize({ shortForm: { rule: { maxAboveTargetLu: 5, toleranceLu: 0.2, autoMaxDurationSec: 601 }, mode: 'auto' } }), 'shortForm.rule.autoMaxDurationSec', 'Must be a number from 1 to 600 s.'],
    ['a short-form rule that is not an object', normalize({ shortForm: { rule: null, mode: 'on' } }), 'shortForm.rule', 'Must be a short-form rule.'],
    ['a short-form setting that is not an object', normalize({ shortForm: true }), 'shortForm', 'Must be null or a short-form setting.'],
    ['a user preset without a name', normalize({ userPreset: { id: 'u-1' } }), 'userPreset', 'Must have a non-empty id and a name.'],
    ['a user preset with an empty id', normalize({ userPreset: { id: '', name: 'x' } }), 'userPreset', 'Must have a non-empty id and a name.'],
    ['a user preset that is text', normalize({ userPreset: 'Late shows' }), 'userPreset', 'Must be null or a user preset reference.'],
    ['a bitrate under 32', normalize({ output: { kind: 'codec', codec: 'aac', kbpsPerPair: 31 } }), 'output.kbpsPerPair', 'Must be a number from 32 to 640 kb/s.'],
    ['a bitrate over 640', normalize({ output: { kind: 'codec', codec: 'aac', kbpsPerPair: 641 } }), 'output.kbpsPerPair', 'Must be a number from 32 to 640 kb/s.'],
    ['an unknown codec', normalize({ output: { kind: 'codec', codec: 'dts', kbpsPerPair: 192 } }), 'output.codec', 'Must be one of: aac, mp3, opus, vorbis, flac, alac, ac3, eac3, pcm, wmav2.'],
    ['an unknown output kind', normalize({ output: { kind: 'inherit' } }), 'output.kind', 'Must be one of: same-as-source, codec.'],
    ['an output that is not an object', normalize({ output: 'aac' }), 'output', 'Must be an encoder policy.'],
    ['a target that is not an object', normalize({ target: -18 }), 'target', 'Must be a loudness target.']
  ])('a normalize recipe with %s', (_name, recipe, path, message) =>
  {
    expect(validateAudioRecipe(recipe)).toEqual([{ path, message }])
  })

  it.each([
    ['gain under -20', boost({ gainDb: -20.5 }), 'gainDb', 'Must be a number from -20 to 12 dB.'],
    ['gain over +12', boost({ gainDb: 12.5 }), 'gainDb', 'Must be a number from -20 to 12 dB.'],
    ['a maximum under -9', boost({ maxTruePeakDbtp: -9.5 }), 'maxTruePeakDbtp', 'Must be a number from -9 to -1 dBTP.'],
    ['a maximum over -1', boost({ maxTruePeakDbtp: -0.3 }), 'maxTruePeakDbtp', 'Must be a number from -9 to -1 dBTP.'],
    ['an allowance over 6', boost({ maxLimitingDb: 6.5 }), 'maxLimitingDb', 'Must be a number from 0 to 6 dB.'],
    ['a 50 Hz high-pass', boost({ highpassHz: 50 }), 'highpassHz', 'Must be one of: 0, 20, 60, 80, 100.'],
    ['the percent-era Maximize id', boost({ presetId: 'maximize' }), 'presetId', 'Must be one of: gentle-lift, quiet-recording, voice-clarity, phone-audio, louder, tone-down, custom.'],
    ['an unknown mono policy', boost({ mono: 'stereo' }), 'mono', 'Must be one of: one-channel, two-speakers.']
  ])('a gain recipe with %s', (_name, recipe, path, message) =>
  {
    expect(validateAudioRecipe(recipe)).toEqual([{ path, message }])
  })

  it('reports every field outside its range at once', () =>
  {
    const recipe = boost({ gainDb: 20, maxTruePeakDbtp: 0, maxLimitingDb: 9, highpassHz: 10 })
    expect(paths(recipe)).toEqual(['gainDb', 'highpassHz', 'maxTruePeakDbtp', 'maxLimitingDb'])
  })

  it('flags fields outside the shape', () =>
  {
    expect(validateAudioRecipe(normalize({ LRA: 11 }))).toEqual([{ path: 'LRA', message: 'Unknown field.' }])
    expect(paths(target({ LRA: 11 }))).toEqual(['target.LRA'])
    expect(paths(normalize({ output: { kind: 'same-as-source', codec: 'aac' } }))).toEqual(['output.codec'])
    expect(paths(boost({ percent: 15 }))).toEqual(['percent'])
  })

  it('rejects input that is not a recipe', () =>
  {
    expect(validateAudioRecipe(null)).toEqual([{ path: '', message: 'Must be a normalize or gain recipe.' }])
    expect(validateAudioRecipe([normalize()])).toEqual([{ path: '', message: 'Must be a normalize or gain recipe.' }])
    expect(validateAudioRecipe({ kind: 'convert' })).toEqual([{ path: 'kind', message: 'Must be one of: normalize, boost.' }])
  })

  it('reports a missing field once', () =>
  {
    const recipe = normalize() as Partial<NormalizeRecipe>
    delete recipe.target
    delete recipe.policy
    expect(paths(recipe)).toEqual(['target', 'policy'])
  })
})
