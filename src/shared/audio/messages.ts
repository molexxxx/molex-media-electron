/**
 * References for every audio sentence a user reads, and the one pure renderer main and the renderer share.
 * Results and events carry references, never rendered English, so a plan can be rendered before a job runs and
 * each side picks its minus sign: ASCII hyphen-minus for logs and reports, U+2212 for numerals on screen.
 */
import { findLoudnessPreset, presetName } from './presets'

/** The key of an audio sentence. */
export type MessageKey = 'measured' | 'measured-short' | 'mono-one' | 'mono-two' | 'mono-duplicated' | 'silent' | 'too-short' | 'below-floor'
  | 'dialogue' | 'short-term' | 'plan-linear' | 'plan-limited' | 'plan-reachable' | 'plan-capped' | 'plan-short-term' | 'boost-reduced'
  | 'verified' | 'verified-below' | 'off-loudness' | 'off-short-term' | 'off-peak' | 'off-overs' | 'decoded-peak' | 'decoded-overshoot' | 'corrected' | 'kept-first'
  | 'decode-errors' | 'container-changed' | 'layout-remapped' | 'no-encoder' | 'too-many-channels' | 'rate-raised'
  | 'downmix-metadata' | 'downmix-bs775' | 'downmix-bs775-extended' | 'downmix-dialog' | 'mono-fold' | 'night' | 'dropped' | 'chapters-dropped'
  | 'meter-swr' | 'a85-measurement' | 'album' | 'stage'

/**
 * A sentence as data: its key and the values it quotes. Numbers stay numbers so each side formats them. A value is
 * null after the wire turned a non-finite number into null, and prints as '?' like a missing one.
 */
export interface MessageRef { key: MessageKey; params: Readonly<Record<string, number | string | null>> }

/** The minus sign numerals get: 'hyphen' for logs and reports, 'unicode' (U+2212) for numerals on screen. */
export type MinusStyle = 'hyphen' | 'unicode'

/**
 * How a number prints: 'level' one decimal with a plus sign above zero (loudness and peaks), 'gain' one decimal
 * always signed, 'amount' one decimal without a plus sign (ranges, limiting, tolerances, overages), 'count' a whole
 * number, 'khz' a rate in Hz shown in kHz, and 'stated' at most one decimal with trailing zeros dropped, the way a
 * source states a value ("±1 dB", "-16 LKFS").
 */
export type NumberStyle = 'level' | 'gain' | 'amount' | 'count' | 'khz' | 'stated'

const UNICODE_MINUS = '\u2212'

function lookup<T>(map: Readonly<Record<string, T>>, key: string): T | undefined
{
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/** Formats one number; a non-finite value prints as '?'. */
export function formatNumber(value: number, style: NumberStyle, minus: MinusStyle = 'hyphen'): string
{
  if (!Number.isFinite(value))
  {
    return '?'
  }
  let text: string
  if (style === 'count')
  {
    text = String(Math.round(value))
  }
  else if (style === 'khz')
  {
    text = String(Math.round(value) / 1000)
  }
  else if (style === 'stated')
  {
    text = String(Number(value.toFixed(1)))
  }
  else
  {
    text = value.toFixed(1)
  }
  if (Number(text) === 0)
  {
    text = text.replace('-', '')
  }
  else if (value > 0 && (style === 'level' || style === 'gain'))
  {
    text = `+${text}`
  }
  return minus === 'unicode' ? text.replace('-', UNICODE_MINUS) : text
}

const CODEC_LABELS: Readonly<Record<string, string>> =
{
  aac: 'AAC',
  libfdk_aac: 'AAC',
  mp3: 'MP3',
  mp3float: 'MP3',
  libmp3lame: 'MP3',
  mp2: 'MP2',
  opus: 'Opus',
  libopus: 'Opus',
  vorbis: 'Vorbis',
  libvorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  truehd: 'TrueHD',
  mlp: 'MLP',
  dts: 'DTS',
  dca: 'DTS',
  wmav1: 'WMA',
  wmav2: 'WMA',
  wmapro: 'WMA Pro',
  wmalossless: 'WMA Lossless',
  wavpack: 'WavPack',
  tta: 'TTA',
  ape: 'Monkey\'s Audio',
  tak: 'TAK'
}

/** The name sentences use for an FFmpeg codec or encoder ('libmp3lame' is MP3, any pcm_* is PCM); unknown names pass through. */
export function codecLabel(name: string): string
{
  if (name.startsWith('pcm_'))
  {
    return 'PCM'
  }
  return lookup(CODEC_LABELS, name) ?? name
}

const STREAM_KIND_WORDS: Readonly<Record<string, string>> = { cover: 'cover art' }

const SHORT_FORM_BASIS: Readonly<Record<string, string>> = { 'ebu-r128': 'EBU R 128 s1', 'aes-streaming': 'AES TD1004 section 3' }

const ALBUM_BASIS: Readonly<Record<string, string>> =
{
  'streaming-r128s2': 'EBU R 128 s2 (i)',
  'aes-streaming': 'AES TD1004 section 6',
  'spotify': 'an app method; Spotify publishes none'
}

const STAGE_LABELS: Readonly<Record<string, readonly [string, string]>> =
{
  'probe': ['Probe', 'Probe'],
  'measure': ['Measure', 'Measure'],
  'measure-dynamics': ['Measure after dynamics', 'Measure after dynamics'],
  'encode': ['Encode', 'Re-encode (correction)'],
  'verify': ['Verify', 'Verify (correction)']
}

/** Reads one reference's values in the formats its sentence needs. */
class Reader
{
  readonly minus: string

  constructor(private readonly params: MessageRef['params'], private readonly style: MinusStyle)
  {
    this.minus = style === 'unicode' ? UNICODE_MINUS : '-'
  }

  has(name: string): boolean
  {
    const value = this.params[name]
    return typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value !== ''
  }

  text(name: string): string
  {
    const value = this.params[name]
    return value === undefined || value === null || value === '' ? '?' : String(value)
  }

  number(name: string, style: NumberStyle): string
  {
    const value = this.params[name]
    return typeof value === 'number' ? formatNumber(value, style, this.style) : this.text(name)
  }

  level(name: string): string
  {
    return this.number(name, 'level')
  }

  gain(name: string): string
  {
    return this.number(name, 'gain')
  }

  amount(name: string): string
  {
    return this.number(name, 'amount')
  }

  plural(name: string, word: string): string
  {
    return `${this.number(name, 'count')} ${this.params[name] === 1 ? word : `${word}s`}`
  }

  codec(name: string): string
  {
    return this.has(name) ? codecLabel(String(this.params[name])) : '?'
  }

  presetKey(): string
  {
    return this.has('preset') ? String(this.params.preset) : ''
  }

  preset(): string
  {
    return this.has('preset') ? presetName(this.presetKey()) : '?'
  }

  /** The loudness unit: the recipe's when given, else the preset's, else LUFS. */
  unit(): string
  {
    if (this.has('unit'))
    {
      return this.text('unit')
    }
    return findLoudnessPreset(this.presetKey())?.target.unit ?? 'LUFS'
  }

  /** The preset's word for deviations and checks; without a known preset the devUnit value, else LU. */
  deviationUnit(): string
  {
    const preset = findLoudnessPreset(this.presetKey())
    if (preset)
    {
      return preset.deviationUnit
    }
    return this.has('devUnit') ? this.text('devUnit') : 'LU'
  }

  /** The standard's name for the check clause; null when the preset is not a standard. */
  standard(): string | null
  {
    const preset = findLoudnessPreset(this.presetKey())
    return preset && preset.standard ? preset.standardName : null
  }

  /** A target as the preset's source states it when the value is that target, else with one decimal. */
  target(name: string): string
  {
    const value = this.params[name]
    const preset = findLoudnessPreset(this.presetKey())
    if (preset && preset.targetDecimals === 0 && value === preset.target.integratedLufs)
    {
      return this.number(name, 'stated')
    }
    return this.level(name)
  }
}

function sameValue(a: number | string | null | undefined, b: number | string | null | undefined): boolean
{
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9
}

function checkClause(r: Reader, params: MessageRef['params'], form: 'Within' | 'Outside'): string
{
  const unit = r.deviationUnit()
  const tolerance = `±${r.amount('tol')} ${unit}`
  const outputs = params.class === 'lossless' ? 'lossless' : 'lossy'
  const appCheck = `${form} this app's ${tolerance} check for ${outputs} outputs`
  const standard = r.standard()
  if (standard === null)
  {
    return `${appCheck}.`
  }
  if (!r.has('stdTol'))
  {
    return `${appCheck}; ${standard} states no tolerance.`
  }
  if (sameValue(params.tol, params.stdTol))
  {
    return `${form} ${tolerance}, the tolerance ${standard} states.`
  }
  return `${appCheck}; ${standard} states ±${r.number('stdTol', 'stated')} ${unit}.`
}

/**
 * The source of a short-form limit. A recipe may carry any cap in range, so a standard is named only when the cap
 * ('above', LU over the target) is that preset's own; any other cap is stated as the app rule it is.
 */
function shortFormBasis(r: Reader, params: MessageRef['params']): string
{
  const basis = lookup(SHORT_FORM_BASIS, r.presetKey())
  const own = findLoudnessPreset(r.presetKey())?.shortForm
  if (basis && own && sameValue(params.above, own.maxAboveTargetLu))
  {
    return basis
  }
  return `the target plus ${r.number('above', 'stated')} LU, an app rule`
}

function correctionReasons(r: Reader): string[]
{
  const reasons: string[] = []
  if (r.has('peakOver'))
  {
    reasons.push(`true peak before encoding ${r.amount('peakOver')} dB over the limit`)
  }
  if (r.has('decodedOver'))
  {
    reasons.push(`decoded true peak ${r.amount('decodedOver')} dB over the app limit`)
  }
  if (r.has('overs'))
  {
    reasons.push('decoded samples above full scale')
  }
  if (r.has('dev'))
  {
    reasons.push(`loudness ${r.gain('dev')} ${r.deviationUnit()} from target`)
  }
  if (r.has('shortTermOver'))
  {
    reasons.push(`short-term loudness ${r.amount('shortTermOver')} LU over the short-form limit`)
  }
  return reasons
}

type Template = (r: Reader, params: MessageRef['params']) => string

const TEMPLATES: Readonly<Record<MessageKey, Template>> =
{
  'measured': (r) => `${r.level('I')} ${r.unit()} integrated, ${r.amount('LRA')} LU range, ${r.level('TP')} dBTP true peak.`,
  'measured-short': (r) =>
    `${r.level('I')} ${r.unit()} integrated, ${r.level('TP')} dBTP true peak. Loudness range is not applicable under 1 minute.`,
  'mono-one': () =>
    'Mono, measured as one channel (ITU-R BS.1770-5). Players reproduce it 3 dB lower on each of two speakers (EBU Tech 3344 section 6.16).',
  'mono-two': (r) =>
    'Mono, measured as played at full level on two speakers (an app convention, not a standard). ' +
    `A single-channel BS.1770 meter reads this file ${r.amount('d')} LU lower.`,
  'mono-duplicated': () => 'Mono duplicated into two identical channels, as Apple Podcasts asks; measured as stereo.',
  'silent': () => 'Silent stream. Copied unchanged.',
  'too-short': () => 'Shorter than 0.4 s, too short to measure loudness. Copied unchanged.',
  'below-floor': (r) => `Below the ${r.minus}70 LUFS measurement floor. Copied unchanged.`,
  'dialogue': (r) =>
    `Center-channel integrated loudness ${r.level('DL')} ${r.unit()} (not dialogue-gated; an estimate). ` +
    `Loudness-to-dialogue ratio about ${r.amount('LDR')} LU; EBU R 128 s4 (j): the LDR of cinematic content should not exceed 5 LU.`,
  'short-term': (r, params) =>
    `Maximum short-term loudness ${r.level('S')} ${r.unit()}; short-form limit ${r.level('limit')} ${r.unit()} ` +
    `(${shortFormBasis(r, params)}).`,
  'plan-linear': (r) =>
    `Gain ${r.gain('G')} dB. Predicted true peak ${r.level('P')} dBTP, under the ${r.level('C')} dBTP ceiling for ${r.codec('codec')}.`,
  'plan-limited': (r) =>
    `Gain ${r.gain('G')} dB with about ${r.amount('Z')} dB of peak limiting to stay under the ${r.level('C')} dBTP ceiling for ` +
    `${r.codec('codec')}. Limiting can lower the result by a few tenths of a LU.`,
  'plan-reachable': (r) =>
    `${r.level('T')} ${r.unit()} needs ${r.gain('G')} dB, but the peaks allow ${r.gain('H')} dB. Normalizing to ` +
    `${r.level('Y')} ${r.unit()} instead. Reaching ${r.level('T')} ${r.unit()} would take ${r.amount('Z')} dB of peak limiting.`,
  'plan-capped': (r) =>
    `${r.level('T')} ${r.unit()} needs ${r.gain('G')} dB. With the ${r.amount('N')} dB limiting allowance the result is ` +
    `${r.level('Y')} ${r.unit()}.`,
  'plan-short-term': (r) =>
    `${r.level('T')} ${r.unit()} needs ${r.gain('G')} dB, but the short-form limit keeps the maximum short-term loudness at ` +
    `${r.level('limit')} ${r.unit()}. Normalizing to ${r.level('Y')} ${r.unit()} instead.`,
  'boost-reduced': (r) =>
    `Applying ${r.gain('X')} dB of the requested ${r.gain('R')} dB: the full gain needs ${r.amount('Z')} dB of peak limiting, ` +
    `over the ${r.amount('N')} dB allowance.`,
  'verified': (r, params) =>
    `Verified ${r.level('I')} ${r.unit()} (${r.preset()}: ${r.target('T')} ${r.unit()}). ${checkClause(r, params, 'Within')} ` +
    `True peak ${r.level('TP')} dBTP before encoding, limit ${r.level('gate')} dBTP.`,
  'verified-below': (r) =>
    `Verified ${r.level('I')} ${r.unit()}, the planned reachable level. Target ${r.level('T')} ${r.unit()} ` +
    'not reached without more peak limiting.',
  'off-loudness': (r, params) =>
  {
    const reachable = params.reference === 'reachable'
    const reference = reachable ? `reachable level of ${r.level('ref')}` : `target of ${r.target('ref')}`
    return `Measured ${r.level('I')} ${r.unit()} after encoding, ${r.gain('dev')} ${r.deviationUnit()} from the ${reference} ` +
      `${r.unit()}. ${checkClause(r, params, 'Outside')}`
  },
  'off-short-term': (r) =>
    `Maximum short-term loudness ${r.level('S')} ${r.unit()} after encoding, ${r.amount('over')} LU over the short-form limit ` +
    `of ${r.level('limit')} ${r.unit()}.`,
  'off-peak': (r) =>
    `True peak before encoding ${r.level('TP')} dBTP is ${r.amount('over')} dB over the ${r.level('gate')} dBTP limit of ${r.preset()}.`,
  'off-overs': (r) =>
    `Decoded samples reach ${r.level('spk')} dBFS, above full scale. This is the app's clipping check: players that decode to fixed ` +
    'point will clip them.',
  'decoded-peak': (r) =>
    `Decoded true peak ${r.level('TP')} dBTP after ${r.codec('codec')} encoding (app check, limit ${r.level('lim')} dBTP).`,
  'decoded-overshoot': (r) =>
    `Decoded true peak ${r.level('TP')} dBTP after ${r.codec('codec')} encoding is ${r.amount('over')} dB over ${r.level('lim')} dBTP, ` +
    `even after one corrective encode. This is the app's codec-overshoot check; ${r.preset()} limits true peak before encoding, ` +
    `where it measured ${r.level('TPpre')} dBTP.`,
  'corrected': (r) =>
  {
    const reasons = correctionReasons(r)
    return reasons.length > 0 ? `Re-encoded once: ${reasons.join('; ')}.` : 'Re-encoded once.'
  },
  'kept-first': (r) => `The corrective encode measured further off (${r.gain('dev2')} ${r.deviationUnit()}); kept the first encode.`,
  'decode-errors': (r) => `The output does not decode cleanly: ${r.text('error')}.`,
  'container-changed': (r) => `${r.codec('codec')} cannot be stored in .${r.text('ext')}; the output is .${r.text('newExt')}.`,
  'layout-remapped': (r) => `${r.text('from')} relabeled as ${r.text('to')} for ${r.codec('codec')}, which accepts only that layout.`,
  'no-encoder': (r) => `No encoder for ${r.codec('source')}; re-encoding as ${r.codec('codec')}.`,
  'too-many-channels': (r) =>
    `${r.codec('codec')} holds at most ${r.plural('n', 'channel')}; this stream has ${r.number('m', 'count')}. ` +
    'Choose another output codec or downmix to stereo.',
  'rate-raised': (r) =>
    `Sample rate raised from ${r.number('from', 'khz')} kHz to ${r.number('to', 'khz')} kHz, the minimum ${r.preset()} accepts.`,
  'downmix-metadata': (r) =>
    `Downmixed ${r.text('layout')} to stereo with the stream's own downmix levels: center ${r.level('c')} dB, ` +
    `surrounds ${r.level('s')} dB, LFE omitted.`,
  'downmix-bs775': (r) =>
    `Downmixed ${r.text('layout')} to stereo with ITU-R BS.775-4 coefficients (the stream carries no downmix levels): ` +
    `center and surrounds at ${r.minus}3 dB, LFE omitted.`,
  'downmix-bs775-extended': (r) =>
    `Downmixed ${r.text('layout')} to stereo with ITU-R BS.775-4 coefficients extended to this layout: both surround pairs at ` +
    `${r.minus}3 dB, back center at ${r.minus}6 dB on each side, LFE omitted.`,
  'downmix-dialog': (r) =>
    `Downmixed ${r.text('layout')} to stereo with dialog emphasis: center at 0 dB, surrounds at ${r.minus}6 dB, LFE omitted. ` +
    'Not a standard downmix.',
  'mono-fold': (r) =>
    `Mono output: ${r.text('from')} folded to one channel at equal weight, an app rule, not a standard. Matching channels keep ` +
    'their level; different channels sum about 3 dB lower.',
  'night': (r) => `Night listening (not a standard): loudness range ${r.amount('LRA_in')} LU before, ${r.amount('LRA_out')} LU after.`,
  'dropped': (r, params) =>
    `Not kept: ${r.number('n', 'count')} ${lookup(STREAM_KIND_WORDS, String(params.kind)) ?? r.text('kind')} ` +
    `${params.n === 1 ? 'stream' : 'streams'} that .${r.text('ext')} cannot hold (${r.text('codecs')}).`,
  'chapters-dropped': (r) => `.${r.text('ext')} cannot hold chapters; ${r.plural('n', 'chapter')} not kept.`,
  'meter-swr': () =>
    'True peak measured with the swresample 8x reference because this FFmpeg has no libsoxr. That reference can read up to ' +
    '0.17 dB low on clipped audio, so true peak is held 0.2 dB under each limit.',
  'a85-measurement': () =>
    'Measured on the full program mix, ATSC A/85\'s method for short-form content (section 5.2.6). For long-form content such ' +
    'as films and series, A/85 measures dialogue as the anchor element without the relative gate (sections 5.1.1, 5.2.2, ' +
    'and 5.2.4), which this app cannot do.',
  'album': (r) =>
    `Album ${r.text('x')}: one gain of ${r.gain('G')} dB for ${r.plural('n', 'track')}, anchored on the loudest track, ` +
    `${r.text('name')} at ${r.level('I')} ${r.unit()} (${lookup(ALBUM_BASIS, r.presetKey()) ?? 'an app method'}).`,
  'stage': (r, params) =>
  {
    const labels = lookup(STAGE_LABELS, String(params.stage))
    if (!labels)
    {
      return r.text('stage')
    }
    return labels[params.correction === 1 ? 1 : 0]
  }
}

/** Every message key, in the order the templates are declared. */
export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(TEMPLATES) as MessageKey[]

/** Renders a reference as English; pure, so main and the renderer always word a result the same way. */
export function renderMessage(ref: MessageRef, opts: { minus: MinusStyle }): string
{
  const template = lookup<Template>(TEMPLATES, ref.key)
  if (!template)
  {
    return ref.key
  }
  return template(new Reader(ref.params ?? {}, opts.minus), ref.params ?? {})
}
