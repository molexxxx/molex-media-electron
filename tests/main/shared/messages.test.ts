/**
 * Audio sentences. Every message key renders its reference sentence from corpus numbers, with the ASCII
 * hyphen-minus for logs and reports and U+2212 for numerals on screen; the loudness check clause has four
 * cases (a different tolerance, the same tolerance, none stated, not a standard) in the preset's own unit;
 * {preset} is the standard's name, or the label of a preset that is not a standard.
 */
import { describe, it, expect } from 'vitest'
import {
  MESSAGE_KEYS,
  codecLabel,
  formatNumber,
  renderMessage,
  type MessageKey,
  type MessageRef
} from '../../../src/shared/audio/messages'
import { stageLabel, type AudioStage } from '../../../src/shared/audio/events'
import { LOUDNESS_PRESETS, type PresetId } from '../../../src/shared/audio/presets'
import { toWire } from '../../../src/shared/jobs/wire'

function hyphen(key: MessageKey, params: MessageRef['params']): string
{
  return renderMessage({ key, params }, { minus: 'hyphen' })
}

function unicode(key: MessageKey, params: MessageRef['params']): string
{
  return renderMessage({ key, params }, { minus: 'unicode' })
}

/** The same sentence with every minus sign of a numeral set as U+2212. */
function withUnicodeMinus(sentence: string): string
{
  return sentence.replace(/(^|[\s(])-(?=\d)/g, '$1\u2212')
}

/** One reference sentence per key, from the corpus numbers of the loudness measurements. */
const CORPUS: Array<[MessageKey, MessageRef['params'], string]> =
[
  ['measured', { I: -20.94, LRA: 15.81, TP: -7.06, unit: 'LUFS' },
    '-20.9 LUFS integrated, 15.8 LU range, -7.1 dBTP true peak.'],
  ['measured-short', { I: -36.2, TP: -20.8, unit: 'LUFS' },
    '-36.2 LUFS integrated, -20.8 dBTP true peak. Loudness range is not applicable under 1 minute.'],
  ['mono-one', {},
    'Mono, measured as one channel (ITU-R BS.1770-5). Players reproduce it 3 dB lower on each of two speakers (EBU Tech 3344 section 6.16).'],
  ['mono-two', { d: 3.01 },
    'Mono, measured as played at full level on two speakers (an app convention, not a standard). A single-channel BS.1770 meter reads this file 3.0 LU lower.'],
  ['mono-duplicated', {},
    'Mono duplicated into two identical channels, as Apple Podcasts asks; measured as stereo.'],
  ['silent', {}, 'Silent stream. Copied unchanged.'],
  ['too-short', {}, 'Shorter than 0.4 s, too short to measure loudness. Copied unchanged.'],
  ['below-floor', {}, 'Below the -70 LUFS measurement floor. Copied unchanged.'],
  ['dialogue', { DL: -32.8, LDR: 11.9, unit: 'LUFS' },
    'Center-channel integrated loudness -32.8 LUFS (not dialogue-gated; an estimate). Loudness-to-dialogue ratio about 11.9 LU; ' +
    'EBU R 128 s4 (j): the LDR of cinematic content should not exceed 5 LU.'],
  ['short-term', { S: -30.646, limit: -18, above: 5, unit: 'LUFS', preset: 'ebu-r128' },
    'Maximum short-term loudness -30.6 LUFS; short-form limit -18.0 LUFS (EBU R 128 s1).'],
  ['plan-linear', { G: -2.1, P: -9.2, C: -2, codec: 'ac3' },
    'Gain -2.1 dB. Predicted true peak -9.2 dBTP, under the -2.0 dBTP ceiling for AC-3.'],
  ['plan-limited', { G: 5, Z: 2.5, C: -1, codec: 'flac' },
    'Gain +5.0 dB with about 2.5 dB of peak limiting to stay under the -1.0 dBTP ceiling for FLAC. Limiting can lower the result by a few tenths of a LU.'],
  ['plan-reachable', { T: -8, G: 6, H: 2.5, Y: -11.5, Z: 3.5, unit: 'LUFS', preset: 'custom' },
    '-8.0 LUFS needs +6.0 dB, but the peaks allow +2.5 dB. Normalizing to -11.5 LUFS instead. Reaching -8.0 LUFS would take 3.5 dB of peak limiting.'],
  ['plan-capped', { T: -9, G: 5, N: 1, Y: -10.5, unit: 'LUFS' },
    '-9.0 LUFS needs +5.0 dB. With the 1.0 dB limiting allowance the result is -10.5 LUFS.'],
  ['plan-short-term', { T: -23, G: 13.2, limit: -18, Y: -23.56, unit: 'LUFS', preset: 'ebu-r128' },
    '-23.0 LUFS needs +13.2 dB, but the short-form limit keeps the maximum short-term loudness at -18.0 LUFS. Normalizing to -23.6 LUFS instead.'],
  ['boost-reduced', { X: 5.5, R: 6, Z: 3.5, N: 3 },
    'Applying +5.5 dB of the requested +6.0 dB: the full gain needs 3.5 dB of peak limiting, over the 3.0 dB allowance.'],
  ['verified', { I: -16, unit: 'LKFS', preset: 'apple-podcasts', T: -16, tol: 0.5, class: 'lossless', stdTol: 1, TP: -3.9, gate: -1 },
    'Verified -16.0 LKFS (Apple Podcasts: -16 LKFS). Within this app\'s ±0.5 dB check for lossless outputs; Apple Podcasts states ±1 dB. ' +
    'True peak -3.9 dBTP before encoding, limit -1.0 dBTP.'],
  ['verified-below', { I: -19.1, T: -18, unit: 'LUFS', preset: 'streaming-r128s2' },
    'Verified -19.1 LUFS, the planned reachable level. Target -18.0 LUFS not reached without more peak limiting.'],
  ['off-loudness', { I: -21.8, unit: 'LUFS', dev: 1.2, reference: 'target', ref: -23, tol: 0.2, class: 'lossy-high', stdTol: 0.2, preset: 'ebu-r128' },
    'Measured -21.8 LUFS after encoding, +1.2 LU from the target of -23.0 LUFS. Outside ±0.2 LU, the tolerance EBU R 128 states.'],
  ['off-short-term', { S: -17.53, over: 0.47, limit: -18, unit: 'LUFS' },
    'Maximum short-term loudness -17.5 LUFS after encoding, 0.5 LU over the short-form limit of -18.0 LUFS.'],
  ['off-peak', { TP: -0.6, over: 0.4, gate: -1, preset: 'ebu-r128' },
    'True peak before encoding -0.6 dBTP is 0.4 dB over the -1.0 dBTP limit of EBU R 128.'],
  ['off-overs', { spk: 0.4 },
    'Decoded samples reach +0.4 dBFS, above full scale. This is the app\'s clipping check: players that decode to fixed point will clip them.'],
  ['decoded-peak', { TP: -4.4, codec: 'libmp3lame', lim: -1 },
    'Decoded true peak -4.4 dBTP after MP3 encoding (app check, limit -1.0 dBTP).'],
  ['decoded-overshoot', { TP: -1.59, codec: 'ac3', over: 0.41, lim: -2, preset: 'atsc-a85', TPpre: -2.4 },
    'Decoded true peak -1.6 dBTP after AC-3 encoding is 0.4 dB over -2.0 dBTP, even after one corrective encode. This is the app\'s ' +
    'codec-overshoot check; ATSC A/85 limits true peak before encoding, where it measured -2.4 dBTP.'],
  ['corrected', { dev: 1.2, devUnit: 'LU' }, 'Re-encoded once: loudness +1.2 LU from target.'],
  ['kept-first', { dev2: -2, devUnit: 'LU' }, 'The corrective encode measured further off (-2.0 LU); kept the first encode.'],
  ['decode-errors', { error: 'Error submitting packet to decoder: Invalid data found when processing input' },
    'The output does not decode cleanly: Error submitting packet to decoder: Invalid data found when processing input.'],
  ['container-changed', { codec: 'aac', ext: 'wav', newExt: 'm4a' }, 'AAC cannot be stored in .wav; the output is .m4a.'],
  ['layout-remapped', { from: '5.1(side)', to: '5.1', codec: 'libopus' }, '5.1(side) relabeled as 5.1 for Opus, which accepts only that layout.'],
  ['no-encoder', { source: 'wmapro', codec: 'aac' }, 'No encoder for WMA Pro; re-encoding as AAC.'],
  ['too-many-channels', { codec: 'libmp3lame', n: 2, m: 6 },
    'MP3 holds at most 2 channels; this stream has 6. Choose another output codec or downmix to stereo.'],
  ['rate-raised', { from: 32000, to: 44100, preset: 'apple-podcasts' },
    'Sample rate raised from 32 kHz to 44.1 kHz, the minimum Apple Podcasts accepts.'],
  ['downmix-metadata', { layout: '5.1(side)', c: 20 * Math.log10(0.594604), s: 20 * Math.log10(0.5) },
    'Downmixed 5.1(side) to stereo with the stream\'s own downmix levels: center -4.5 dB, surrounds -6.0 dB, LFE omitted.'],
  ['downmix-bs775', { layout: '5.1(side)' },
    'Downmixed 5.1(side) to stereo with ITU-R BS.775-4 coefficients (the stream carries no downmix levels): center and surrounds at -3 dB, LFE omitted.'],
  ['downmix-bs775-extended', { layout: '7.1' },
    'Downmixed 7.1 to stereo with ITU-R BS.775-4 coefficients extended to this layout: both surround pairs at -3 dB, back center at -6 dB ' +
    'on each side, LFE omitted.'],
  ['downmix-dialog', { layout: '5.1' },
    'Downmixed 5.1 to stereo with dialog emphasis: center at 0 dB, surrounds at -6 dB, LFE omitted. Not a standard downmix.'],
  ['mono-fold', { from: 'stereo' },
    'Mono output: stereo folded to one channel at equal weight, an app rule, not a standard. Matching channels keep their level; different ' +
    'channels sum about 3 dB lower.'],
  ['night', { LRA_in: 15.6, LRA_out: 9.3 }, 'Clear dialogue, built on EBU R 128 s2: loudness range 15.6 LU before, 9.3 LU after.'],
  ['dropped', { n: 1, kind: 'subtitle', ext: 'ts', codecs: 'subrip' }, 'Not kept: 1 subtitle stream that .ts cannot hold (subrip).'],
  ['chapters-dropped', { ext: 'wav', n: 3 }, '.wav cannot hold chapters; 3 chapters not kept.'],
  ['meter-swr', {},
    'True peak measured with the swresample 8x reference because this FFmpeg has no libsoxr. That reference can read up to 0.17 dB low on ' +
    'clipped audio, so true peak is held 0.2 dB under each limit.'],
  ['a85-measurement', {},
    'Measured on the full program mix, ATSC A/85\'s method for short-form content (section 5.2.6). For long-form content such as films ' +
    'and series, A/85 measures dialogue as the anchor element without the relative gate (sections 5.1.1, 5.2.2, and 5.2.4), which this ' +
    'app cannot do.'],
  ['album', { x: 'A', G: -10.149, n: 4, name: 'loudmaster.wav', I: -7.851, unit: 'LUFS', preset: 'streaming-r128s2' },
    'Album A: one gain of -10.1 dB for 4 tracks, anchored on the loudest track, loudmaster.wav at -7.9 LUFS (EBU R 128 s2 (i)).'],
  ['stage', { stage: 'encode', correction: 1 }, 'Re-encode (correction)']
]

describe('renderMessage, reference sentences', () =>
{
  it('has a reference sentence for every key', () =>
  {
    expect(CORPUS.map(([key]) => key).sort()).toEqual([...MESSAGE_KEYS].sort())
  })

  it.each(CORPUS)('%s renders its sentence with hyphen-minus numerals', (key, params, sentence) =>
  {
    expect(hyphen(key, params)).toBe(sentence)
  })

  it.each(CORPUS)('%s renders its sentence with U+2212 numerals', (key, params, sentence) =>
  {
    const rendered = unicode(key, params)
    expect(rendered).toBe(withUnicodeMinus(sentence))
    expect(rendered).not.toMatch(/(^|[\s(])-\d/)
  })

  it('keeps hyphens that are not minus signs', () =>
  {
    expect(unicode('mono-one', {})).toContain('ITU-R BS.1770-5')
    expect(unicode('decoded-overshoot', { TP: -1.6, codec: 'eac3', over: 0.4, lim: -2, preset: 'atsc-a85', TPpre: -2.4 }))
      .toContain('after E-AC-3 encoding')
    expect(unicode('decode-errors', { error: 'take -3.mp3 failed' })).toBe('The output does not decode cleanly: take -3.mp3 failed.')
  })
})

describe('the loudness check clause', () =>
{
  const lossless = (preset: PresetId, extra: MessageRef['params']): MessageRef['params'] =>
    ({ I: -16, unit: 'LKFS', preset, T: -16, TP: -3.9, gate: -1, class: 'lossless', ...extra })

  it('names both checks when the standard states a different tolerance', () =>
  {
    const params = lossless('apple-podcasts', { tol: 0.5, stdTol: 1 })
    expect(hyphen('verified', params)).toContain('. Within this app\'s ±0.5 dB check for lossless outputs; Apple Podcasts states ±1 dB. ')
    expect(hyphen('off-loudness', { ...params, I: -16.7, dev: -0.7, ref: -16, reference: 'target' })).toBe(
      'Measured -16.7 LKFS after encoding, -0.7 dB from the target of -16 LKFS. Outside this app\'s ±0.5 dB check for lossless outputs; ' +
      'Apple Podcasts states ±1 dB.')
  })

  it('names the standard\'s tolerance alone when the check equals it', () =>
  {
    expect(hyphen('verified', { I: -23, unit: 'LUFS', preset: 'ebu-r128', T: -23, tol: 0.2, class: 'lossless', stdTol: 0.2, TP: -2.4, gate: -1 })).toBe(
      'Verified -23.0 LUFS (EBU R 128: -23.0 LUFS). Within ±0.2 LU, the tolerance EBU R 128 states. True peak -2.4 dBTP before encoding, limit -1.0 dBTP.')
    expect(hyphen('verified', lossless('apple-podcasts', { class: 'lossy-high', tol: 1, stdTol: 1 })))
      .toContain('. Within ±1.0 dB, the tolerance Apple Podcasts states. ')
    expect(hyphen('off-loudness', { I: -18.9, preset: 'aes-streaming', dev: -0.9, ref: -18, reference: 'target', tol: 0.5, class: 'lossless', stdTol: 0.5 }))
      .toBe('Measured -18.9 LUFS after encoding, -0.9 LU from the target of -18 LUFS. Outside ±0.5 LU, the tolerance AES TD1004 states.')
  })

  it('says the standard states none when it gives no tolerance', () =>
  {
    expect(hyphen('verified', { I: -14.2, unit: 'LUFS', preset: 'spotify', T: -14, tol: 0.5, class: 'lossless', TP: -1.6, gate: -1 })).toBe(
      'Verified -14.2 LUFS (Spotify: -14 LUFS). Within this app\'s ±0.5 LU check for lossless outputs; Spotify states no tolerance. ' +
      'True peak -1.6 dBTP before encoding, limit -1.0 dBTP.')
    expect(hyphen('off-loudness', { I: -19.6, preset: 'streaming-r128s2', dev: -1.6, ref: -18, reference: 'target', tol: 1, class: 'lossy-low' }))
      .toBe('Measured -19.6 LUFS after encoding, -1.6 LU from the target of -18 LUFS. Outside this app\'s ±1.0 LU check for lossy outputs; ' +
        'EBU R 128 s2 states no tolerance.')
  })

  it('names only the app check for a preset that is not a standard', () =>
  {
    expect(hyphen('verified', { I: -18.1, unit: 'LUFS', preset: 'night', T: -18, tol: 1, class: 'lossy-high', TP: -2, gate: -1 })).toBe(
      'Verified -18.1 LUFS (Clear dialogue (movies and shows): -18 LUFS). Within this app\'s ±1.0 LU check for lossy outputs. ' +
      'True peak -2.0 dBTP before encoding, limit -1.0 dBTP.')
    expect(hyphen('off-loudness', { I: -13.2, preset: 'custom', dev: 0.8, ref: -14, reference: 'target', tol: 0.5, class: 'lossless' }))
      .toBe('Measured -13.2 LUFS after encoding, +0.8 LU from the target of -14.0 LUFS. Outside this app\'s ±0.5 LU check for lossless outputs.')
  })

  it.each(LOUDNESS_PRESETS.map((p) => [p.id, p.deviationUnit] as const))('%s words its check in %s', (preset, unit) =>
  {
    const params = { I: -20, preset, T: -20, tol: 0.5, class: 'lossless', TP: -3, gate: -1, dev: 0.7, ref: -20, reference: 'target', devUnit: 'LU' }
    const expected = preset === 'atsc-a85' || preset === 'apple-podcasts' ? 'dB' : 'LU'
    expect(unit).toBe(expected)
    expect(hyphen('verified', params)).toContain(`±0.5 ${expected} check`)
    expect(hyphen('off-loudness', params)).toContain(`+0.7 ${expected} from the target`)
  })

  it('measures from the reachable level with one decimal when the plan stopped short', () =>
  {
    expect(hyphen('off-loudness', { I: -12.4, unit: 'LUFS', dev: -0.9, reference: 'reachable', ref: -11.5, tol: 0.5, class: 'lossless', preset: 'spotify' }))
      .toBe('Measured -12.4 LUFS after encoding, -0.9 LU from the reachable level of -11.5 LUFS. Outside this app\'s ±0.5 LU check for lossless ' +
        'outputs; Spotify states no tolerance.')
  })

  it('uses the devUnit value, else LU, when the preset is not one of the built-in presets', () =>
  {
    expect(hyphen('off-loudness', { I: -17, unit: 'LKFS', dev: -1, devUnit: 'dB', ref: -16, reference: 'target', tol: 0.5, class: 'lossless' }))
      .toBe('Measured -17.0 LKFS after encoding, -1.0 dB from the target of -16.0 LKFS. Outside this app\'s ±0.5 dB check for lossless outputs.')
    expect(hyphen('kept-first', { dev2: 0.6 })).toBe('The corrective encode measured further off (+0.6 LU); kept the first encode.')
  })
})

describe('{preset} and the values a sentence looks up', () =>
{
  it('resolves {preset} to the standard\'s name, or the label of a preset that is not a standard', () =>
  {
    const offPeak = (preset: string): string => hyphen('off-peak', { TP: -0.5, over: 0.5, gate: -1, preset })
    expect(offPeak('aes-streaming')).toBe('True peak before encoding -0.5 dBTP is 0.5 dB over the -1.0 dBTP limit of AES TD1004.')
    expect(offPeak('film-r128s4')).toContain('limit of EBU R 128 s4.')
    expect(offPeak('night')).toContain('limit of Clear dialogue (movies and shows).')
    expect(offPeak('custom')).toContain('limit of Custom.')
    expect(offPeak('louder')).toContain('limit of Louder.')
    expect(offPeak('Weekly show')).toContain('limit of Weekly show.')
  })

  it('states a target as its source does in the reference, and with one decimal elsewhere', () =>
  {
    const verified = (preset: PresetId, T: number): string =>
      hyphen('verified', { I: T, preset, T, tol: 0.5, class: 'lossless', TP: -3, gate: -1 })
    expect(verified('atsc-a85', -24)).toContain('(ATSC A/85: -24 LKFS)')
    expect(verified('film-r128s4', -23)).toContain('(EBU R 128 s4: -23.0 LUFS)')
    expect(verified('streaming-r128s2', -17)).toContain('(EBU R 128 s2: -17.0 LUFS)')
    expect(hyphen('plan-capped', { T: -16, G: 4, N: 1, Y: -17, preset: 'apple-podcasts' }))
      .toBe('-16.0 LKFS needs +4.0 dB. With the 1.0 dB limiting allowance the result is -17.0 LKFS.')
  })

  it('names the short-form rule and the album method of each preset', () =>
  {
    expect(hyphen('short-term', { S: -20, limit: -13, above: 5, preset: 'aes-streaming' })).toContain('(AES TD1004 section 3).')
    expect(hyphen('short-term', { S: -20, limit: -13, above: 5, preset: 'custom' })).toContain('(the target plus 5 LU, an app rule).')
    const album = (preset: string): string => hyphen('album', { x: 'B', G: -2.5, n: 2, name: 'side-a.flac', I: -11.5, preset })
    expect(album('aes-streaming')).toBe('Album B: one gain of -2.5 dB for 2 tracks, anchored on the loudest track, side-a.flac at -11.5 LUFS (AES TD1004 section 6).')
    expect(album('spotify')).toContain('(an app method; Spotify publishes none).')
    expect(album('custom')).toContain('(an app method).')
  })

  it('credits a standard with a short-form limit only when the cap is that preset\'s own', () =>
  {
    const shortTerm = (preset: string, above: number | null, limit: number): string =>
      hyphen('short-term', { S: -30.6, limit, above, unit: 'LUFS', preset })
    expect(shortTerm('custom', 3, -21)).toBe('Maximum short-term loudness -30.6 LUFS; short-form limit -21.0 LUFS (the target plus 3 LU, an app rule).')
    expect(shortTerm('ebu-r128', 3, -20)).toBe('Maximum short-term loudness -30.6 LUFS; short-form limit -20.0 LUFS (the target plus 3 LU, an app rule).')
    expect(shortTerm('aes-streaming', 2.5, -15.5)).toContain('short-form limit -15.5 LUFS (the target plus 2.5 LU, an app rule).')
    expect(shortTerm('spotify', 5, -9)).toContain('(the target plus 5 LU, an app rule).')
    expect(shortTerm('ebu-r128', 5, -18)).toContain('short-form limit -18.0 LUFS (EBU R 128 s1).')
    expect(shortTerm('ebu-r128', null, -18)).toContain('(the target plus ? LU, an app rule).')
    expect(hyphen('short-term', { S: -30.6, limit: -18, preset: 'ebu-r128' })).toContain('(the target plus ? LU, an app rule).')
  })

  it('lists every reason for a corrective encode', () =>
  {
    expect(hyphen('corrected', { peakOver: 0.3 })).toBe('Re-encoded once: true peak before encoding 0.3 dB over the limit.')
    expect(hyphen('corrected', { peakOver: 0.31, decodedOver: 0.2, overs: 1, dev: -0.8, devUnit: 'dB', shortTermOver: 0.4 })).toBe(
      'Re-encoded once: true peak before encoding 0.3 dB over the limit; decoded true peak 0.2 dB over the app limit; decoded samples above ' +
      'full scale; loudness -0.8 dB from target; short-term loudness 0.4 LU over the short-form limit.')
    expect(hyphen('corrected', {})).toBe('Re-encoded once.')
  })

  it('counts in the singular and the plural', () =>
  {
    expect(hyphen('dropped', { n: 2, kind: 'cover', ext: 'wav', codecs: 'mjpeg, png' })).toBe('Not kept: 2 cover art streams that .wav cannot hold (mjpeg, png).')
    expect(hyphen('chapters-dropped', { ext: 'flac', n: 1 })).toBe('.flac cannot hold chapters; 1 chapter not kept.')
    expect(hyphen('too-many-channels', { codec: 'mono-only', n: 1, m: 2 })).toBe(
      'mono-only holds at most 1 channel; this stream has 2. Choose another output codec or downmix to stereo.')
    expect(hyphen('album', { x: 'C', G: 0, n: 1, name: 'solo.wav', I: -14, unit: 'LUFS', preset: 'spotify' })).toContain('one gain of 0.0 dB for 1 track,')
  })

  it('shows rates in kHz', () =>
  {
    expect(hyphen('rate-raised', { from: 22050, to: 44100, preset: 'apple-podcasts' })).toContain('from 22.05 kHz to 44.1 kHz')
  })
})

describe('stage labels', () =>
{
  const cases: Array<[AudioStage, 1 | 2 | null, string]> =
  [
    ['probe', null, 'Probe'],
    ['measure', null, 'Measure'],
    ['measure-dynamics', null, 'Measure after dynamics'],
    ['encode', 1, 'Encode'],
    ['verify', 1, 'Verify'],
    ['encode', 2, 'Re-encode (correction)'],
    ['verify', 2, 'Verify (correction)'],
    ['measure', 2, 'Measure']
  ]

  it.each(cases)('%s in encode pass %s is %s', (stage, pass, label) =>
  {
    expect(renderMessage(stageLabel(stage, pass), { minus: 'hyphen' })).toBe(label)
  })

  it('renders an unknown stage by its name', () =>
  {
    expect(hyphen('stage', { stage: 'finalize' })).toBe('finalize')
  })
})

describe('robustness', () =>
{
  it('prints a question mark for a missing or non-finite value and passes text through', () =>
  {
    expect(hyphen('measured', { I: Number.NaN, TP: Number.POSITIVE_INFINITY })).toBe('? LUFS integrated, ? LU range, ? dBTP true peak.')
    expect(hyphen('plan-linear', { G: '+2.0', P: -9, C: -2 })).toBe('Gain +2.0 dB. Predicted true peak -9.0 dBTP, under the -2.0 dBTP ceiling for ?.')
    expect(hyphen('off-peak', { TP: -0.5, over: 0.5, gate: -1 })).toContain('limit of ?.')
    expect(hyphen('container-changed', { codec: 'aac', ext: '', newExt: 'm4a' })).toBe('AAC cannot be stored in .?; the output is .m4a.')
  })

  it('prints a question mark for a null value', () =>
  {
    expect(hyphen('container-changed', { codec: 'aac', ext: null, newExt: 'm4a' })).toBe('AAC cannot be stored in .?; the output is .m4a.')
    expect(hyphen('dropped', { n: 2, kind: null, ext: 'wav', codecs: null })).toBe('Not kept: 2 ? streams that .wav cannot hold (?).')
    expect(hyphen('stage', { stage: null })).toBe('?')
    expect(hyphen('measured', { I: -20.94, LRA: null, TP: null, unit: 'LUFS' })).toBe('-20.9 LUFS integrated, ? LU range, ? dBTP true peak.')
  })

  it('words a reference the same live and after the wire turns its non-finite values into null', () =>
  {
    const refs: MessageRef[] =
    [
      { key: 'measured', params: { I: -20.94, LRA: Number.NaN, TP: Number.NEGATIVE_INFINITY, unit: 'LUFS' } },
      { key: 'off-peak', params: { TP: Number.POSITIVE_INFINITY, over: Number.NaN, gate: -1, preset: 'ebu-r128' } },
      { key: 'verified', params: { I: -23, unit: 'LUFS', preset: 'ebu-r128', T: Number.NaN, tol: Number.NaN, class: 'lossless', stdTol: 0.2, TP: -2.4, gate: -1 } },
      { key: 'too-many-channels', params: { codec: 'libmp3lame', n: Number.NaN, m: 6 } }
    ]
    for (const ref of refs)
    {
      const wired = toWire(ref)
      expect(Object.values(wired.params)).toContain(null)
      for (const minus of ['hyphen', 'unicode'] as const)
      {
        expect(renderMessage(wired, { minus }), ref.key).toBe(renderMessage(ref, { minus }))
      }
    }
    expect(renderMessage(toWire(refs[0]), { minus: 'hyphen' })).toBe('-20.9 LUFS integrated, ? LU range, ? dBTP true peak.')
    expect(renderMessage(toWire(refs[2]), { minus: 'hyphen' })).toBe(
      'Verified -23.0 LUFS (EBU R 128: ? LUFS). Within this app\'s ±? LU check for lossless outputs; EBU R 128 states ±0.2 LU. ' +
      'True peak -2.4 dBTP before encoding, limit -1.0 dBTP.')
  })

  it('renders a key it does not know as the key, and tolerates missing params', () =>
  {
    expect(renderMessage({ key: 'from-a-newer-version' as MessageKey, params: {} }, { minus: 'hyphen' })).toBe('from-a-newer-version')
    expect(renderMessage({ key: 'constructor' as MessageKey, params: {} }, { minus: 'hyphen' })).toBe('constructor')
    expect(renderMessage({ key: 'silent' } as MessageRef, { minus: 'unicode' })).toBe('Silent stream. Copied unchanged.')
  })
})

describe('formatNumber', () =>
{
  it('formats each style', () =>
  {
    expect(formatNumber(-23, 'level')).toBe('-23.0')
    expect(formatNumber(0.44, 'level')).toBe('+0.4')
    expect(formatNumber(3.25, 'gain')).toBe('+3.3')
    expect(formatNumber(-2.04, 'gain')).toBe('-2.0')
    expect(formatNumber(1.5, 'amount')).toBe('1.5')
    expect(formatNumber(6.4, 'count')).toBe('6')
    expect(formatNumber(48000, 'khz')).toBe('48')
    expect(formatNumber(1, 'stated')).toBe('1')
    expect(formatNumber(0.2, 'stated')).toBe('0.2')
    expect(formatNumber(-16, 'stated', 'unicode')).toBe('\u221216')
  })

  it('never prints a negative zero or a sign on zero', () =>
  {
    expect(formatNumber(-0.04, 'level')).toBe('0.0')
    expect(formatNumber(-0.04, 'gain', 'unicode')).toBe('0.0')
    expect(formatNumber(0.01, 'gain')).toBe('0.0')
    expect(formatNumber(-0.4, 'count')).toBe('0')
  })

  it('prints a question mark for a non-finite value', () =>
  {
    expect(formatNumber(Number.NaN, 'level')).toBe('?')
    expect(formatNumber(Number.NEGATIVE_INFINITY, 'gain')).toBe('?')
  })
})

describe('codecLabel', () =>
{
  it('names codecs and encoders the way sentences do', () =>
  {
    expect(['aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'alac', 'ac3', 'eac3', 'mp2', 'wmav2', 'wmapro', 'truehd', 'dts'].map(codecLabel))
      .toEqual(['AAC', 'MP3', 'Opus', 'Vorbis', 'FLAC', 'ALAC', 'AC-3', 'E-AC-3', 'MP2', 'WMA', 'WMA Pro', 'TrueHD', 'DTS'])
    expect(codecLabel('pcm_s24le')).toBe('PCM')
    expect(codecLabel('speex')).toBe('speex')
    expect(codecLabel('toString')).toBe('toString')
  })
})
