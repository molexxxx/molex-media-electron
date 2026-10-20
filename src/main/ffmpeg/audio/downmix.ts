/**
 * Explicit stereo downmixes and the mono fold, written as `pan` expressions that run in float. `pan` ignores
 * the stream's downmix side data, so the result is the same on every build, unlike FFmpeg's automatic channel
 * conversion, whose coefficients changed in 8.0.
 */
import type { DownmixMode } from '../../../shared/audio/types'

export type { DownmixMode }

/** The channels of FFmpeg's standard layouts in FFmpeg's order (`ffmpeg -layouts` on 9.0.2, a superset of 2022). */
export const LAYOUT_CHANNELS: Readonly<Record<string, readonly string[]>> =
{
  'mono': ['FC'],
  'stereo': ['FL', 'FR'],
  '2.1': ['FL', 'FR', 'LFE'],
  '3.0': ['FL', 'FR', 'FC'],
  '3.0(back)': ['FL', 'FR', 'BC'],
  '4.0': ['FL', 'FR', 'FC', 'BC'],
  'quad': ['FL', 'FR', 'BL', 'BR'],
  'quad(side)': ['FL', 'FR', 'SL', 'SR'],
  '3.1': ['FL', 'FR', 'FC', 'LFE'],
  '5.0': ['FL', 'FR', 'FC', 'BL', 'BR'],
  '5.0(side)': ['FL', 'FR', 'FC', 'SL', 'SR'],
  '4.1': ['FL', 'FR', 'FC', 'LFE', 'BC'],
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'],
  '5.1(side)': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '6.0': ['FL', 'FR', 'FC', 'BC', 'SL', 'SR'],
  '6.0(front)': ['FL', 'FR', 'FLC', 'FRC', 'SL', 'SR'],
  '3.1.2': ['FL', 'FR', 'FC', 'LFE', 'TFL', 'TFR'],
  'hexagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC'],
  '6.1': ['FL', 'FR', 'FC', 'LFE', 'BC', 'SL', 'SR'],
  '6.1(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'BC'],
  '6.1(front)': ['FL', 'FR', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '7.0': ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR'],
  '7.0(front)': ['FL', 'FR', 'FC', 'FLC', 'FRC', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '7.1(wide)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'],
  '7.1(wide-side)': ['FL', 'FR', 'FC', 'LFE', 'FLC', 'FRC', 'SL', 'SR'],
  '5.1.2': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR'],
  '5.1.2(back)': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'TFL', 'TFR'],
  'octagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR'],
  'cube': ['FL', 'FR', 'BL', 'BR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '7.1.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR'],
  '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '7.2.3': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TBC', 'LFE2'],
  '9.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR'],
  '9.1.6': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'SL', 'SR', 'TFL', 'TFR', 'TBL', 'TBR', 'TSL', 'TSR'],
  'hexadecagonal': ['FL', 'FR', 'FC', 'BL', 'BR', 'BC', 'SL', 'SR', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'WL', 'WR'],
  'binaural': ['BIL', 'BIR'],
  'downmix': ['DL', 'DR'],
  '22.2': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR',
    'LFE2', 'TSL', 'TSR', 'BFC', 'BFL', 'BFR']
}

/**
 * ITU-R BS.775-4 Annex 4 Table 2, stereo 2/0: L = L + 0.7071 C + 0.7071 LS, and the mirror for R. Back pairs take
 * the surround coefficient and a back center splits at 0.5 per side, the two extensions beyond 3/2 sources. LFE
 * is omitted (Annex 7).
 */
export const BS775: Readonly<Record<string, readonly [number, number]>> =
{
  FL: [1, 0],
  FR: [0, 1],
  FC: [0.7071, 0.7071],
  SL: [0.7071, 0],
  SR: [0, 0.7071],
  BL: [0.7071, 0],
  BR: [0, 0.7071],
  BC: [0.5, 0.5],
  LFE: [0, 0],
  LFE2: [0, 0]
}

/** Dialog emphasis, not a standard downmix: the center at full level, the surrounds at -6 dB, LFE omitted. */
export const DIALOG: Readonly<Record<string, readonly [number, number]>> =
{
  FL: [1, 0],
  FR: [0, 1],
  FC: [1, 1],
  SL: [0.5, 0],
  SR: [0, 0.5],
  BL: [0.5, 0],
  BR: [0, 0.5],
  BC: [0.5, 0.5],
  LFE: [0, 0],
  LFE2: [0, 0]
}

/** The input layouts a stereo downmix supports. Mono and stereo need none; height and wide channels are refused. */
export const DOWNMIX_LAYOUTS: readonly string[] =
[
  '2.1', '3.0', '3.0(back)', '4.0', 'quad', 'quad(side)', '3.1', '4.1', '5.0', '5.0(side)', '5.1', '5.1(side)',
  '6.0', '6.1', '6.1(back)', '7.0', '7.1'
]

/** Codecs whose decoders export downmix levels as frame side data; DTS carries only a matrix encoding, PCM nothing. */
export const DOWNMIX_LEVEL_CODECS: ReadonlySet<string> = new Set(['ac3', 'eac3'])

/** The equal-weight fold of a stereo pair to one channel, an app rule rather than a standard. */
export const MONO_FOLD = 'pan=mono|c0=0.5*c0+0.5*c1'

/** The Lo/Ro downmix levels a stream carries, as linear factors. The Lt/Rt levels are never used. */
export interface DownmixLevels
{
  centerLoRo: number
  surroundLoRo: number
  preferred: 'Lo/Ro' | 'Lt/Rt' | 'Pro Logic II' | 'unknown'
}

/** Where a downmix's coefficients came from. */
export type DownmixCoefficients = 'stream-metadata' | 'bs775' | 'bs775-extended' | 'dialog'

/** Where a mono fold's coefficients came from: the fold alone, or a standard downmix first. */
export type FoldCoefficients = 'fold' | Exclude<DownmixCoefficients, 'dialog'>

const SUPPORTED: ReadonlySet<string> = new Set(DOWNMIX_LAYOUTS)
const STEREO_FLOAT = 'aformat=sample_fmts=dbl:channel_layouts=stereo'
const FLOAT = 'aformat=sample_fmts=dbl'
const DOWNMIX_LINE = /side data - downmix: preferred downmix type - (.*?) Mix levels: center (\S+) \(\S+ ltrt\) - surround (\S+) \(\S+ ltrt\)/
const PREFERRED: Readonly<Record<string, DownmixLevels['preferred']>> =
{
  'Lo/Ro': 'Lo/Ro',
  'Lt/Rt': 'Lt/Rt',
  'Dolby Pro Logic II': 'Pro Logic II'
}

/** The highest mix level a downmix side-data block can state (+3 dB is 1.414). */
const MAX_LEVEL = 2

/** One decoded frame of an audio stream through ashowinfo, which prints its side data (twice on 9.0.2, once on 2022). */
export function buildDownmixProbeArgs(input: string, audioIndex: number): string[]
{
  return [
    '-loglevel', 'level+info', '-analyzeduration', '200M', '-probesize', '200M', '-i', input,
    '-map', `0:a:${audioIndex}`, '-frames:a', '1', '-af', 'ashowinfo', '-f', 'null', '-'
  ]
}

/** The Lo/Ro levels of the first downmix side-data line, or null when there is none or it does not parse. */
export function parseDownmixInfo(stderr: string): DownmixLevels | null
{
  const match = DOWNMIX_LINE.exec(stderr.replace(/\r\n?/g, '\n'))
  if (match === null)
  {
    return null
  }
  const centerLoRo = Number(match[2])
  const surroundLoRo = Number(match[3])
  if (!isLevel(centerLoRo) || !isLevel(surroundLoRo))
  {
    return null
  }
  const preferred = Object.hasOwn(PREFERRED, match[1]) ? PREFERRED[match[1]] : 'unknown'
  return { centerLoRo, surroundLoRo, preferred }
}

/**
 * The stereo downmix of a supported layout: the stream's Lo/Ro levels when it carries them, else BS.775-4, or
 * dialog emphasis on a layout with a center (a layout without one takes the standard downmix). Null for mono,
 * stereo, and unsupported layouts.
 */
export function downmixStage(mode: DownmixMode, layout: string, levels: DownmixLevels | null):
  { stage: string; coefficients: DownmixCoefficients } | null
{
  if (!SUPPORTED.has(layout))
  {
    return null
  }
  const channels = LAYOUT_CHANNELS[layout]
  if (mode === 'dialog' && channels.includes('FC'))
  {
    return { stage: panStereo(channels, DIALOG), coefficients: 'dialog' }
  }
  return standardDownmix(channels, levels)
}

/**
 * A mono output: the standard stereo downmix first when the source has more than two channels, then the
 * equal-weight fold, all in float. A stereo source gets the fold alone; mono and unsupported layouts get null.
 */
export function monoFoldStage(layout: string, levels: DownmixLevels | null):
  { stages: string[]; coefficients: FoldCoefficients } | null
{
  const channels = Object.hasOwn(LAYOUT_CHANNELS, layout) ? LAYOUT_CHANNELS[layout] : null
  if (channels === null || channels.length < 2)
  {
    return null
  }
  if (channels.length === 2)
  {
    return { stages: [FLOAT, MONO_FOLD], coefficients: 'fold' }
  }
  if (!SUPPORTED.has(layout))
  {
    return null
  }
  const downmix = standardDownmix(channels, levels)
  return { stages: [FLOAT, downmix.stage, STEREO_FLOAT, MONO_FOLD], coefficients: downmix.coefficients }
}

function standardDownmix(channels: readonly string[], levels: DownmixLevels | null):
  { stage: string; coefficients: Exclude<DownmixCoefficients, 'dialog'> }
{
  if (levels !== null)
  {
    return { stage: panStereo(channels, streamMatrix(levels)), coefficients: 'stream-metadata' }
  }
  const extended = channels.includes('BC') || (channels.includes('BL') && channels.includes('SL'))
  return { stage: panStereo(channels, BS775), coefficients: extended ? 'bs775-extended' : 'bs775' }
}

/** BS.775-4 with the stream's center and surround levels; a back center splits the surround level equally. */
function streamMatrix(levels: DownmixLevels): Readonly<Record<string, readonly [number, number]>>
{
  const c = levels.centerLoRo
  const s = levels.surroundLoRo
  const b = Number((s * Math.SQRT1_2).toFixed(6))
  return { ...BS775, FC: [c, c], SL: [s, 0], SR: [0, s], BL: [s, 0], BR: [0, s], BC: [b, b] }
}

function panStereo(channels: readonly string[], matrix: Readonly<Record<string, readonly [number, number]>>): string
{
  const side = (index: 0 | 1): string =>
    channels
      .filter((channel) => matrix[channel][index] !== 0)
      .map((channel) => term(matrix[channel][index], channel))
      .join('+')
  return `pan=stereo|FL=${side(0)}|FR=${side(1)}`
}

function term(coefficient: number, channel: string): string
{
  return coefficient === 1 ? channel : `${Number(coefficient.toFixed(6))}*${channel}`
}

function isLevel(value: number): boolean
{
  return Number.isFinite(value) && value >= 0 && value <= MAX_LEVEL
}
