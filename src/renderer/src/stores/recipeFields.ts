/**
 * The inspector's recipe field model. For the selected jobs that are not in a batch it states what each field of
 * their operation shows (one value, or a mix with the distinct values and their counts), whether the field can be
 * edited and why not, and its error; it builds the one-field patches an edit sends and the whole recipes an operation
 * or preset choice assigns, and counts the consequences of a change with the stream rules the planner uses.
 */
import { AUDIO_LIMITS } from '../../../shared/audio/limits'
import
{
  NIGHT_DYNAMICS,
  findGainPreset,
  findLoudnessPreset,
  applyLoudnessPreset,
  presetName,
  type GainPreset,
  type LoudnessPreset
} from '../../../shared/audio/presets'
import type { EncoderPolicy, MonoPolicy, NormalizeRecipe, OutputCodec, UnreachablePolicy } from '../../../shared/audio/types'
import { applicability, applicabilityMessage, factsFromSummary, type Applicability, type StreamFacts } from '../../../shared/jobs/applicability'
import { audioCodecLabel, containerLabel, describeRecipe, isEdited, operationLabel, presetLabel, type PresetLookup } from '../../../shared/jobs/describe'
import { formatRunLabel, type JobId } from '../../../shared/jobs/ids'
import { CRF_RANGES, EXTRACT_SAMPLE_RATES, JOB_LIMITS, sizeBudget, type SizeBudget } from '../../../shared/jobs/limits'
import { videoEncoderFit } from '../../../shared/jobs/muxing'
import
{
  BUILTIN_PRESETS,
  CONVERT_PRESETS,
  EXTRACT_PRESETS,
  MEDIA_CATALOGS,
  PRESET_GROUPS,
  USER_PRESET_GROUP,
  applyDefaultPreset,
  applyPreset,
  findPreset,
  presetLookup,
  type BuiltinPreset,
  type PresetInfo
} from '../../../shared/jobs/presets'
import type
{
  AudioOut,
  ChannelRule,
  CompressRecipe,
  ConvertRecipe,
  ExtractMode,
  ExtractRecipe,
  FrameFit,
  FrameSampling,
  Operation,
  PixelFormat,
  Recipe,
  StreamPick,
  VideoEncoder
} from '../../../shared/jobs/recipes'
import type { JobView, MediaSummary, PresetState, UserPreset } from '../../../shared/jobs/types'
import { ACTIVE_STATES, TERMINAL_STATES } from '../../../shared/jobs/types'

/** How a field is drawn. */
export type FieldKind = 'select' | 'segmented' | 'number' | 'range' | 'checkbox' | 'radio' | 'input' | 'text'

/** An inclusive numeric range with the step its inputs use; max null has no upper bound. */
export interface NumberRange
{
  min: number
  max: number | null
  step: number
}

/** A mono source's treatment: one of the two measurement choices, or the Apple Podcasts duplication. */
export type MonoChoice = MonoPolicy | 'duplicate'

/** An Extract audio format: an output codec with the container it is written in. */
export type AudioFormat = 'mp3' | 'aac' | 'opus' | 'vorbis' | 'flac' | 'wav' | 'aiff' | 'copy'

/** The value type of each recipe field, by field key. */
export interface FieldValues
{
  target: number
  truePeak: number
  policy: UnreachablePolicy
  allowance: number
  mono: MonoChoice
  downmix: 'keep' | 'standard' | 'dialog'
  output: 'same-as-source' | OutputCodec
  bitrate: number
  album: boolean
  shortForm: 'auto' | 'on' | 'off'
  cinematic: boolean
  gain: number
  highpass: 0 | 20 | 60 | 80 | 100
  container: string
  videoCodec: VideoEncoder | 'copy'
  videoBitrate: number | null
  size: { maxWidth: number | null; maxHeight: number | null } | null
  fit: FrameFit['mode']
  fps: number | null
  pixelFormat: PixelFormat
  audio: 'copy' | 'same-as-source' | OutputCodec
  audioBitrate: number
  channels: ChannelRule
  subtitles: boolean
  compressMode: 'quality' | 'size'
  quality: 'lossless' | 'high' | 'medium' | 'low' | 'custom'
  crf: number
  targetSize: number
  twoPass: boolean
  encoder: VideoEncoder
  speed: CompressRecipe['speed']
  maxSize: FrameFit | null
  tune: CompressRecipe['tune']
  extractMode: ExtractMode
  /** Null for an output the format list does not name, such as ALAC. */
  audioFormat: AudioFormat | null
  sampleRate: number | null
  stream: StreamPick
  streamLanguage: string
  streamOrdinal: number
  start: number
  duration: number | null
  videoCopy: 'copy' | 'reencode'
  gifWidth: number | null
  gifFps: number
  dither: Extract<ExtractRecipe, { mode: 'gif' }>['dither']
  loop: 'infinite' | number
  loopCount: number
  sampling: FrameSampling
  samplingValue: number
  frameFormat: 'png' | 'jpg' | 'webp'
  jpgQuality: number
  subtitleFormat: 'srt' | 'vtt' | 'ass'
}

/** A recipe field's key. */
export type FieldKey = keyof FieldValues

/** An edit of one field: it sets that field on every editable selected job that has it, and nothing else. */
export type FieldPatch = { [K in FieldKey]: { field: K; value: FieldValues[K] } }[FieldKey]

/** What the model reads besides the selected jobs. */
export interface RecipeContext
{
  /** The user's presets, the pinned keys, and the recently applied recipes. */
  presets: PresetState
  /** The output policy starting and preset Normalize and Gain recipes take; same as the source unless a preset says otherwise. */
  output: EncoderPolicy
  /** Album letters already in use in the queue; a new album takes the next free one. */
  albumIds: readonly string[]
  /** Full stream facts of jobs whose probe detail the page holds, for one-job choices such as subtitle streams. */
  facts?: Readonly<Record<string, StreamFacts>>
  /** The keyframe interval of a one-job selection, in seconds, when the probe detail states it. */
  keyframeIntervalSec?: number | null
}

/** One value held by the editable jobs, with the number of jobs that hold it and its display text. */
export interface DistinctValue<T = unknown>
{
  value: T
  count: number
  text: string
}

/** An option of a select, segmented control, or radio list. */
export interface FieldOption<T = unknown>
{
  /** A stable string for the control's value attribute. */
  key: string
  value: T
  label: string
  description: string | null
  group: string | null
  disabled: boolean
  reason: string | null
  /** What choosing the option would block among the editable jobs, before anything is applied. */
  note: string | null
}

/** What one field shows for the editable selected jobs that have it. */
export interface FieldState<K extends FieldKey = FieldKey>
{
  key: K
  label: string
  kind: FieldKind
  /** The value every job shares; when mixed, the most common one, where a mixed slider rests. */
  value: FieldValues[K]
  mixed: boolean
  /** Each value with the number of jobs holding it, most common first. */
  distinct: DistinctValue<FieldValues[K]>[]
  /** The value's display text, or "Mixed". */
  text: string
  /** The distinct values and counts under a mixed field: "1.0 (7), 2.0 (1)". */
  mixedText: string | null
  disabled: boolean
  /** Why the field cannot be edited: the jobs are locked, or their preset fixes it. */
  reason: string | null
  hint: string | null
  /** A current value outside the field's range, for the first job that holds one. */
  error: string | null
  /** A consequence shown under the field, such as the size budget of one file. */
  note: string | null
  unit: string | null
  range: NumberRange | null
  options: FieldOption<FieldValues[K]>[] | null
  /** The field inside the checked option (the limiting allowance), enabled only while that option is checked. */
  nested: FieldState | null
  /** Shown behind "More settings". */
  more: boolean
  /** The jobs the field aggregates. */
  count: number
  /** How many of them differ from their preset in this field. */
  edited: number
  /** The values locked jobs keep when they differ from the field: "4 locked jobs keep −14.0 LUFS." */
  lockedNote: string | null
}

/** A stream rule a change would meet, counted over the editable jobs. */
export interface ConsequenceNote
{
  code: Applicability['code']
  severity: 'error' | 'info'
  /** Jobs the rule meets. */
  count: number
  text: string
}

/** One whole recipe for one job, as the assignRecipe command takes it. */
export interface RecipeAssignment
{
  jobId: JobId
  recipe: Recipe
}

/** What an edit, an operation choice, or a preset choice does to the selection. */
export interface RecipeEdit
{
  /** Each job whose recipe changes, with its whole new recipe. */
  assignments: RecipeAssignment[]
  /** Editable jobs left as they are: the field is not theirs, their preset fixes it, or nothing changes. */
  unchanged: JobId[]
  /** Editable jobs the value does not fit; they keep their recipes. */
  invalid: JobId[]
  /** Selected jobs in a batch; they keep their recipes. */
  locked: JobId[]
  /** What the new recipes would block, before anything is applied. */
  notes: ConsequenceNote[]
}

/** Why a selected job keeps its recipe: it is queued, running, or finished in a batch. */
export type JobLock = 'editable' | 'queued' | 'running' | 'finished'

/** Whether a job's recipe can be edited: only jobs that are not in a batch can. */
export function jobLock(job: Pick<JobView, 'state'>): JobLock
{
  if (job.state === 'pending')
  {
    return 'editable'
  }
  if (job.state === 'queued')
  {
    return 'queued'
  }
  if (TERMINAL_STATES.includes(job.state))
  {
    return 'finished'
  }
  return ACTIVE_STATES.includes(job.state) || job.state === 'held' ? 'running' : 'finished'
}

/** The selection split into the jobs an edit changes and the jobs that keep their recipes, in selection order. */
export function splitSelection<J extends Pick<JobView, 'state'>>(jobs: readonly J[]): { editable: J[]; locked: J[] }
{
  const editable: J[] = []
  const locked: J[] = []
  for (const job of jobs)
  {
    (jobLock(job) === 'editable' ? editable : locked).push(job)
  }
  return { editable, locked }
}

/** Why a locked job keeps its recipe, with the action that frees a queued job; null for an editable job. */
export function lockReason(job: Pick<JobView, 'state' | 'runId'>): { text: string; action: string | null } | null
{
  const lock = jobLock(job)
  if (lock === 'editable')
  {
    return null
  }
  const batch = job.runId === null ? 'the batch' : formatRunLabel(job.runId)
  if (lock === 'queued')
  {
    return { text: `Queued in ${batch}. Take it out of the batch to edit it.`, action: `Take out of ${batch}` }
  }
  return lock === 'running'
    ? { text: `Frozen when ${batch} started.`, action: null }
    : { text: `Frozen when ${batch} started. To change it, use Edit and retry.`, action: null }
}

function plural(count: number, one: string, many: string): string
{
  return count === 1 ? one : many
}

/** The inspector footer: which selected jobs a change applies to and how many keep their recipes. */
export function footerText(editable: number, locked: number): string
{
  if (locked === 0)
  {
    return `Changes apply to ${editable} selected ${plural(editable, 'job', 'jobs')}.`
  }
  return `Changes apply to ${editable} ${plural(editable, 'job', 'jobs')} not in a batch. ` +
    `${locked} queued, running, or finished ${plural(locked, 'job keeps its settings', 'jobs keep their settings')}.`
}

/** Why every selected job is read-only: one shared reason, else the count of jobs that keep their recipes. */
function selectionLockReason(locked: readonly JobView[]): { text: string; action: string | null }
{
  const reasons = locked.map((job) => lockReason(job) as { text: string; action: string | null })
  if (reasons.every((reason) => reason.text === reasons[0].text))
  {
    return reasons[0]
  }
  return { text: `${locked.length} queued, running, or finished jobs keep their settings.`, action: null }
}

/** A key that is equal for equal JSON values whatever the order of their object keys. */
export function valueKey(value: unknown): string
{
  if (value === undefined)
  {
    return 'undefined'
  }
  if (value === null || typeof value !== 'object')
  {
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
  {
    return `[${value.map(valueKey).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${valueKey(record[key])}`).join(',')}}`
}

/** The distinct values among a list, most common first, ties in order of first appearance. */
export function distinctValues<T>(values: readonly T[], text: (value: T, index: number) => string): DistinctValue<T>[]
{
  const byKey = new Map<string, DistinctValue<T>>()
  values.forEach((value, index) =>
  {
    const key = valueKey(value)
    const entry = byKey.get(key)
    if (entry)
    {
      entry.count += 1
    }
    else
    {
      byKey.set(key, { value, count: 1, text: text(value, index) })
    }
  })
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

/** The distinct values as the page lists them under a mixed field: "1.0 (7), 2.0 (1)". */
export function distinctText(distinct: readonly DistinctValue[]): string
{
  return distinct.map((entry) => `${entry.text} (${entry.count})`).join(', ')
}

const MINUS = '−'

/** A number with fixed decimals, negative numbers with U+2212 as the page renders them. */
export function formatNumber(value: number, decimals: number): string
{
  const text = Math.abs(value).toFixed(decimals)
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text
}

/** A signed number with fixed decimals: "+1.0", "−2.5", "0.0". */
export function formatSigned(value: number, decimals: number): string
{
  const text = formatNumber(value, decimals)
  return value > 0 && Number(Math.abs(value).toFixed(decimals)) !== 0 ? `+${text}` : text
}

/** A number with at most the given decimals and no trailing zeros: -23, -18.5. */
function shortNumber(value: number, decimals = 2): string
{
  const text = formatNumber(value, decimals)
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

function kbpsText(kbps: number): string
{
  return `${Math.round(kbps).toLocaleString('en-US')} kb/s`
}

/** A duration as the page writes it: 2:14, 1:02:03, with fractions of a second kept: 0:00.5. */
export function clockText(totalSec: number): string
{
  const totalMs = Math.round(totalSec * 1000)
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const restMs = totalMs % 60_000
  const fraction = restMs % 1000
  const seconds = `${String(Math.floor(restMs / 1000)).padStart(2, '0')}${fraction === 0 ? '' : `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`}`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

function rangeText(range: NumberRange, unit: string | null): string
{
  const tail = unit === null ? '' : ` ${unit}`
  return range.max === null ? `${shortNumber(range.min)}${tail} or more` : `${shortNumber(range.min)} to ${shortNumber(range.max)}${tail}`
}

/** The error of a value outside a range: "Enter −60 to −5 LUFS." */
export function rangeError(value: number, range: NumberRange, unit: string | null): string | null
{
  const inside = Number.isFinite(value) && value >= range.min - 1e-9 && (range.max === null || value <= range.max + 1e-9)
  return inside ? null : `Enter ${rangeText(range, unit)}.`
}

function languageName(code: string): string
{
  try
  {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  }
  catch
  {
    return code
  }
}

function joinNames(names: readonly string[]): string
{
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function unique<T>(values: readonly T[]): T[]
{
  return [...new Set(values)]
}

/** What a field reads besides its recipes: the context, the jobs it aggregates, and that job alone when there is one. */
interface FieldScope
{
  ctx: RecipeContext
  members: readonly JobView[]
  single: JobView | null
}

interface OptionInput<V>
{
  value: V
  label: string
  description?: string | null
  /** The reason the option cannot be chosen. */
  disabled?: string | null
}

/**
 * One field of one operation. Methods are declared as methods so a definition for one recipe kind can sit in the
 * registry of every recipe.
 */
interface FieldDef<R extends Recipe = Recipe, K extends FieldKey = FieldKey>
{
  key: K
  /** "{n}" is replaced with the number of jobs the field aggregates. */
  label: string
  kind: FieldKind
  more?: boolean
  /** Shown only inside its parent's option, never in the field list. */
  child?: boolean
  /** Fewer aggregated jobs hide the field. */
  minJobs?: number
  /** Whether the choices are judged with the stream rules before they are applied. */
  streams?: boolean
  /** The child fields and the parent values that hold them. */
  nested?: ReadonlyArray<{ key: FieldKey; on(value: FieldValues[K]): boolean }>
  has?(recipe: R): boolean
  get(recipe: R): FieldValues[K]
  set(recipe: R, value: FieldValues[K], ctx: RecipeContext): R
  text(value: FieldValues[K], recipe: R): string
  kindFor?(value: FieldValues[K]): FieldKind
  unit?(recipe: R): string | null
  range?(recipe: R): NumberRange | null
  /** The standard or preset that fixes the field for this recipe; null when the field can be edited. */
  fixed?(recipe: R): string | null
  /** A complete read-only reason for this recipe. */
  readOnly?(recipe: R): string | null
  validate?(value: FieldValues[K], recipe: R): string | null
  options?(recipes: readonly R[], scope: FieldScope): OptionInput<FieldValues[K]>[]
  hint?(recipes: readonly R[], scope: FieldScope): string | null
  note?(recipes: readonly R[], scope: FieldScope): string | null
}

function def<R extends Recipe, K extends FieldKey>(entry: FieldDef<R, K>): FieldDef
{
  return entry as unknown as FieldDef
}

function audioRange(range: { min: number; max: number; step: number }): NumberRange
{
  return { min: range.min, max: range.max, step: range.step }
}

const LOSSY_CODECS: readonly OutputCodec[] = ['aac', 'mp3', 'opus', 'vorbis', 'ac3', 'eac3', 'wmav2']
const SURROUND_CODECS: readonly OutputCodec[] = ['ac3', 'eac3']
const PAIR_RATES: readonly number[] = [128, 160, 192, 224, 256, 320]
const SURROUND_TOTALS: readonly number[] = [384, 448, 640]
const DEFAULT_PAIR_KBPS = 192
const DEFAULT_SURROUND_TOTAL = 448

/** An audio output with a new codec choice; a lossy codec keeps the bitrate of a lossy codec of its kind. */
function withCodec(current: AudioOut, choice: FieldValues['audio']): AudioOut
{
  if (choice === 'copy' || choice === 'same-as-source')
  {
    return { kind: choice }
  }
  if (!LOSSY_CODECS.includes(choice))
  {
    return { kind: 'codec', codec: choice, kbpsPerPair: null }
  }
  const surround = SURROUND_CODECS.includes(choice)
  const kept = current.kind === 'codec' && LOSSY_CODECS.includes(current.codec) && SURROUND_CODECS.includes(current.codec) === surround
    ? current.kbpsPerPair
    : null
  return { kind: 'codec', codec: choice, kbpsPerPair: kept ?? (surround ? DEFAULT_SURROUND_TOTAL / 3 : DEFAULT_PAIR_KBPS) }
}

function codecChoice(out: AudioOut): FieldValues['audio']
{
  return out.kind === 'codec' ? out.codec : out.kind
}

function hasLossyBitrate(out: AudioOut): boolean
{
  return out.kind === 'codec' && LOSSY_CODECS.includes(out.codec) && out.kbpsPerPair !== null
}

function bitrateText(kbpsPerPair: number, out: AudioOut): string
{
  return out.kind === 'codec' && SURROUND_CODECS.includes(out.codec) ? `${kbpsText(kbpsPerPair * 3)} at 5.1` : kbpsText(kbpsPerPair)
}

function bitrateOptions(outs: readonly AudioOut[], current: readonly number[]): OptionInput<number>[]
{
  const surround = outs.every((out) => out.kind === 'codec' && SURROUND_CODECS.includes(out.codec))
  const values = surround ? SURROUND_TOTALS.map((total) => total / 3) : [...PAIR_RATES]
  for (const value of current)
  {
    if (!values.some((known) => Math.abs(known - value) < 1e-9))
    {
      values.push(value)
    }
  }
  values.sort((a, b) => a - b)
  return values.map((value) => ({ value, label: surround ? `${kbpsText(value * 3)} at 5.1` : kbpsText(value) }))
}

const CODEC_CHOICE_LABELS: Readonly<Record<FieldValues['audio'], string>> =
{
  'copy': 'Copy (no re-encode)',
  'same-as-source': 'Same as source (recommended)',
  'aac': 'AAC',
  'mp3': 'MP3',
  'opus': 'Opus',
  'vorbis': 'Vorbis',
  'flac': 'FLAC',
  'alac': 'ALAC',
  'ac3': 'AC-3',
  'eac3': 'E-AC-3',
  'pcm': 'PCM',
  'wmav2': 'WMA (wmav2)'
}

/** The output codecs of Normalize and Gain; WMA is for Convert's Windows Media outputs only. */
const LOUDNESS_OUTPUTS: readonly FieldValues['output'][] = ['same-as-source', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm']

const ONE_CHANNEL_HINT = 'Measures a mono file as one channel, as ITU-R BS.1770-5 does. Players reproduce it 3 dB lower on each of two speakers.'
const TWO_SPEAKERS_HINT = 'Measures a mono file as if played at full level on both speakers, 3 dB louder. An app convention, not a standard.'

const MONO_OPTIONS: readonly OptionInput<MonoChoice>[] =
[
  { value: 'one-channel', label: 'One channel', description: ONE_CHANNEL_HINT },
  { value: 'two-speakers', label: 'Two speakers', description: TWO_SPEAKERS_HINT }
]

type AudioRecipe = NormalizeRecipe | Extract<Recipe, { kind: 'boost' }>

function outputDef<R extends AudioRecipe>(): FieldDef
{
  return def<R, 'output'>({
    key: 'output',
    label: 'Output codec',
    kind: 'select',
    streams: true,
    get: (recipe) => codecChoice(recipe.output) as FieldValues['output'],
    set: (recipe, value) => ({ ...recipe, output: withCodec(recipe.output, value) as EncoderPolicy }),
    text: (value) => CODEC_CHOICE_LABELS[value],
    options: () => LOUDNESS_OUTPUTS.map((value) => ({ value, label: CODEC_CHOICE_LABELS[value] }))
  })
}

function outputBitrateDef<R extends AudioRecipe>(): FieldDef
{
  return def<R, 'bitrate'>({
    key: 'bitrate',
    label: 'Bitrate per channel pair',
    kind: 'select',
    has: (recipe) => hasLossyBitrate(recipe.output),
    get: (recipe) => (recipe.output as { kbpsPerPair: number }).kbpsPerPair,
    set: (recipe, value) => ({ ...recipe, output: { ...(recipe.output as Extract<EncoderPolicy, { kind: 'codec' }>), kbpsPerPair: value } }),
    text: (value, recipe) => bitrateText(value, recipe.output),
    unit: () => 'kb/s',
    range: () => audioRange(AUDIO_LIMITS.kbpsPerPair),
    options: (recipes) => bitrateOptions(recipes.map((recipe) => recipe.output), recipes.map((recipe) => (recipe.output as { kbpsPerPair: number }).kbpsPerPair))
  })
}

const POLICY_TEXT: Readonly<Record<UnreachablePolicy, { label: string; description: string }>> =
{
  'stop-at-reachable':
  {
    label: 'Stop at the reachable level',
    description: 'Applies only the gain the peaks allow, without limiting. The result is quieter than the target, and Review and the stamp say by how much.'
  },
  'peak-limit':
  {
    label: 'Allow peak limiting up to {n} dB',
    description: 'Reaches the target with at most this much true-peak limiting (0 to 3 dB). Each dB of limiting changes the sound and can lower loudness by a few tenths of a LU.'
  },
  'reduce-dynamics':
  {
    label: 'Reduce dynamics first (not a standard)',
    description: 'Compresses before measuring, then normalizes linearly. Changes the program\'s dynamics, and reports call it non-standard.'
  }
}

function policyLabel(policy: UnreachablePolicy, allowance: number): string
{
  return POLICY_TEXT[policy].label.replace('{n}', formatNumber(allowance, 1))
}

/** The dynamics a normalize recipe keeps outside the reduce-dynamics policy: its preset's own, if any. */
function presetDynamics(recipe: NormalizeRecipe): NormalizeRecipe['dynamics']
{
  const dynamics = findLoudnessPreset(recipe.presetId)?.dynamics ?? null
  return dynamics === null ? null : { ...dynamics }
}

/** The album letter after those in use: A to Z, then AA, AB, and so on. */
export function nextAlbumId(used: readonly string[]): string
{
  const taken = new Set(used)
  for (let index = 0; ; index += 1)
  {
    let id = ''
    let rest = index
    do
    {
      id = String.fromCharCode(65 + (rest % 26)) + id
      rest = Math.floor(rest / 26) - 1
    }
    while (rest >= 0)
    if (!taken.has(id))
    {
      return id
    }
  }
}

const DOWNMIX_LABELS: Readonly<Record<FieldValues['downmix'], string>> =
{
  keep: 'Keep layout',
  standard: 'Stereo',
  dialog: 'Stereo, dialog emphasis (not a standard)'
}

const SHORT_FORM_LABELS: Readonly<Record<FieldValues['shortForm'], string>> = { auto: 'Automatic', on: 'Always', off: 'Never' }

/** Whether the jobs' outputs can have different codec ceilings: several jobs with different output codecs or sources. */
function outputsVary(recipes: readonly AudioRecipe[], members: readonly JobView[]): boolean
{
  if (members.length < 2)
  {
    return false
  }
  if (unique(recipes.map((recipe) => valueKey(recipe.output))).length > 1)
  {
    return true
  }
  return recipes[0].output.kind === 'same-as-source' && unique(members.map((job) => job.media?.audio[0]?.codec ?? null)).length > 1
}

const NORMALIZE_FIELDS: readonly FieldDef[] =
[
  def<NormalizeRecipe, 'target'>({
    key: 'target',
    label: 'Target, integrated',
    kind: 'range',
    get: (recipe) => recipe.target.integratedLufs,
    set: (recipe, value) => ({ ...recipe, target: { ...recipe.target, integratedLufs: value } }),
    text: (value, recipe) => `${formatNumber(value, 1)} ${recipe.target.unit}`,
    unit: (recipe) => recipe.target.unit,
    range: (recipe) =>
    {
      const range = findLoudnessPreset(recipe.presetId)?.targetRange ?? null
      return range === null ? null : { min: range[0], max: range[1], step: AUDIO_LIMITS.integratedLufs.step }
    },
    fixed: (recipe) => findLoudnessPreset(recipe.presetId)?.targetRange ? null : presetName(recipe.presetId)
  }),
  def<NormalizeRecipe, 'truePeak'>({
    key: 'truePeak',
    label: 'Maximum true peak',
    kind: 'number',
    get: (recipe) => recipe.target.maxTruePeakDbtp,
    set: (recipe, value) => ({ ...recipe, target: { ...recipe.target, maxTruePeakDbtp: value } }),
    text: (value) => `${formatNumber(value, 1)} dBTP`,
    unit: () => 'dBTP',
    range: (recipe) =>
    {
      const range = findLoudnessPreset(recipe.presetId)?.truePeakRange ?? null
      return range === null ? null : { min: range[0], max: range[1], step: AUDIO_LIMITS.maxTruePeakDbtp.step }
    },
    fixed: (recipe) => findLoudnessPreset(recipe.presetId)?.truePeakRange ? null : presetName(recipe.presetId),
    note: (recipes, scope) => outputsVary(recipes, scope.members) ? 'Varies with the output codec. See Output for each job.' : null
  }),
  def<NormalizeRecipe, 'policy'>({
    key: 'policy',
    label: 'When the target is out of reach',
    kind: 'radio',
    nested: [{ key: 'allowance', on: (value) => value === 'peak-limit' }],
    get: (recipe) => recipe.policy,
    set: (recipe, value) => ({
      ...recipe,
      policy: value,
      dynamics: value === 'reduce-dynamics' ? (recipe.dynamics ?? { ...NIGHT_DYNAMICS }) : presetDynamics(recipe)
    }),
    text: (value, recipe) => policyLabel(value, recipe.maxLimitingDb),
    options: (recipes) =>
    {
      const allowance = distinctValues(recipes.map((recipe) => recipe.maxLimitingDb), String)[0].value
      return (['stop-at-reachable', 'peak-limit', 'reduce-dynamics'] as const)
        .map((value) => ({ value, label: policyLabel(value, allowance), description: POLICY_TEXT[value].description }))
    }
  }),
  def<NormalizeRecipe, 'allowance'>({
    key: 'allowance',
    label: 'Peak limiting allowance',
    kind: 'number',
    child: true,
    get: (recipe) => recipe.maxLimitingDb,
    set: (recipe, value) => ({ ...recipe, maxLimitingDb: value }),
    text: (value) => `${formatNumber(value, 1)} dB`,
    unit: () => 'dB',
    range: () => audioRange(AUDIO_LIMITS.normalizeMaxLimitingDb)
  }),
  def<NormalizeRecipe, 'mono'>({
    key: 'mono',
    label: 'Mono sources',
    kind: 'segmented',
    get: (recipe) => recipe.monoToStereo ? 'duplicate' : recipe.mono,
    set: (recipe, value) => value === 'duplicate' ? recipe : { ...recipe, mono: value },
    text: (value, recipe) => value === 'duplicate'
      ? `Duplicated into two identical channels (${presetName(recipe.presetId)})`
      : (MONO_OPTIONS.find((option) => option.value === value) as OptionInput<MonoChoice>).label,
    kindFor: (value) => value === 'duplicate' ? 'text' : 'segmented',
    fixed: (recipe) => recipe.presetId === 'custom' ? null : presetName(recipe.presetId),
    options: () => [...MONO_OPTIONS]
  }),
  def<NormalizeRecipe, 'downmix'>({
    key: 'downmix',
    label: 'Downmix',
    kind: 'select',
    streams: true,
    get: (recipe) => recipe.downmix ?? 'keep',
    set: (recipe, value) => ({ ...recipe, downmix: value === 'keep' ? null : value }),
    text: (value) => DOWNMIX_LABELS[value],
    options: () => (['keep', 'standard', 'dialog'] as const).map((value) => ({
      value,
      label: DOWNMIX_LABELS[value],
      description: value === 'standard' ? 'Uses the stream\'s own downmix levels when it carries them, else ITU-R BS.775-4; the plan names which.' : null
    }))
  }),
  outputDef<NormalizeRecipe>(),
  outputBitrateDef<NormalizeRecipe>(),
  def<NormalizeRecipe, 'album'>({
    key: 'album',
    label: 'Normalize the {n} selected jobs as an album',
    kind: 'checkbox',
    minJobs: 2,
    has: (recipe) => findLoudnessPreset(recipe.presetId)?.album === 'track-or-album',
    get: (recipe) => recipe.albumGroupId !== null,
    set: (recipe, value, ctx) => ({ ...recipe, albumGroupId: value ? nextAlbumId(ctx.albumIds) : null }),
    text: (value) => value ? 'Album' : 'Track'
  }),
  def<NormalizeRecipe, 'shortForm'>({
    key: 'shortForm',
    label: 'Short-form limit',
    kind: 'segmented',
    has: (recipe) => recipe.shortForm !== null,
    get: (recipe) => (recipe.shortForm as NonNullable<NormalizeRecipe['shortForm']>).mode,
    set: (recipe, value) => ({ ...recipe, shortForm: { ...(recipe.shortForm as NonNullable<NormalizeRecipe['shortForm']>), mode: value } }),
    text: (value) => SHORT_FORM_LABELS[value],
    options: () => (['auto', 'on', 'off'] as const).map((value) => ({ value, label: SHORT_FORM_LABELS[value] })),
    hint: (recipes) =>
    {
      const rules = recipes.map((recipe) => (recipe.shortForm as NonNullable<NormalizeRecipe['shortForm']>).rule)
      const limits = unique(rules.map((rule) => rule.autoMaxDurationSec)).sort((a, b) => a - b).map((sec) => `${shortNumber(sec)} s`)
      const above = unique(rules.map((rule) => shortNumber(rule.maxAboveTargetLu))).join(' or ')
      return `Automatic applies to files of ${limits.join(' or ')} or less: maximum short-term loudness at most the target plus ${above} LU.`
    }
  }),
  def<NormalizeRecipe, 'cinematic'>({
    key: 'cinematic',
    label: 'Cinematic content',
    kind: 'checkbox',
    more: true,
    get: (recipe) => recipe.cinematic,
    set: (recipe, value) => ({ ...recipe, cinematic: value }),
    text: (value) => value ? 'On' : 'Off',
    hint: () => 'Reports a center-channel loudness estimate and the loudness-to-dialogue ratio for sources with a center channel. Changes no processing.'
  })
]

type BoostRecipe = Extract<Recipe, { kind: 'boost' }>

const HIGHPASS_LABELS: Readonly<Record<FieldValues['highpass'], string>> = { 0: 'Off', 20: '20 Hz', 60: '60 Hz', 80: '80 Hz', 100: '100 Hz' }

const BOOST_FIELDS: readonly FieldDef[] =
[
  def<BoostRecipe, 'gain'>({
    key: 'gain',
    label: 'Gain',
    kind: 'range',
    get: (recipe) => recipe.gainDb,
    set: (recipe, value) => ({ ...recipe, gainDb: value }),
    text: (value) => `${formatSigned(value, 1)} dB`,
    unit: () => 'dB',
    range: () => audioRange(AUDIO_LIMITS.gainDb)
  }),
  def<BoostRecipe, 'highpass'>({
    key: 'highpass',
    label: 'High-pass filter',
    kind: 'segmented',
    get: (recipe) => recipe.highpassHz,
    set: (recipe, value) => ({ ...recipe, highpassHz: value }),
    text: (value) => HIGHPASS_LABELS[value],
    options: () => ([0, 20, 60, 80, 100] as const).map((value) => ({ value, label: HIGHPASS_LABELS[value] }))
  }),
  def<BoostRecipe, 'truePeak'>({
    key: 'truePeak',
    label: 'Maximum true peak',
    kind: 'number',
    get: (recipe) => recipe.maxTruePeakDbtp,
    set: (recipe, value) => ({ ...recipe, maxTruePeakDbtp: value }),
    text: (value) => `${formatNumber(value, 1)} dBTP`,
    unit: () => 'dBTP',
    range: () => audioRange(AUDIO_LIMITS.boostMaxTruePeakDbtp),
    note: (recipes, scope) => outputsVary(recipes, scope.members) ? 'Varies with the output codec. See Output for each job.' : null
  }),
  def<BoostRecipe, 'allowance'>({
    key: 'allowance',
    label: 'Peak limiting allowance',
    kind: 'number',
    get: (recipe) => recipe.maxLimitingDb,
    set: (recipe, value) => ({ ...recipe, maxLimitingDb: value }),
    text: (value) => `${formatNumber(value, 1)} dB`,
    unit: () => 'dB',
    range: () => audioRange(AUDIO_LIMITS.boostMaxLimitingDb)
  }),
  def<BoostRecipe, 'mono'>({
    key: 'mono',
    label: 'Mono sources',
    kind: 'segmented',
    get: (recipe) => recipe.mono,
    set: (recipe, value) => value === 'duplicate' ? recipe : { ...recipe, mono: value },
    text: (value) => (MONO_OPTIONS.find((option) => option.value === value) as OptionInput<MonoChoice>).label,
    options: () => [...MONO_OPTIONS]
  }),
  outputDef<BoostRecipe>(),
  outputBitrateDef<BoostRecipe>()
]

type MediaRecipe = ConvertRecipe | CompressRecipe | Extract<ExtractRecipe, { mode: 'audio' }>

const MEDIA_AUDIO_CHOICES: readonly FieldValues['audio'][] = ['copy', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'alac', 'ac3', 'eac3', 'pcm']

/** Windows Media containers, the only outputs WMA is offered for. */
const WMA_CONTAINERS: readonly string[] = ['wma', 'wmv', 'asf']

function audioCodecDef<R extends ConvertRecipe | CompressRecipe>(): FieldDef
{
  return def<R, 'audio'>({
    key: 'audio',
    label: 'Audio codec',
    kind: 'select',
    streams: true,
    get: (recipe) => codecChoice(recipe.audio),
    set: (recipe, value) => ({ ...recipe, audio: withCodec(recipe.audio, value) }),
    text: (value) => value === 'same-as-source' ? 'Same as source' : CODEC_CHOICE_LABELS[value],
    options: (recipes) =>
    {
      const wma = recipes.some((recipe) => WMA_CONTAINERS.includes(recipe.container))
      return [...MEDIA_AUDIO_CHOICES, ...(wma ? ['wmav2' as const] : [])].map((value) => ({ value, label: CODEC_CHOICE_LABELS[value] }))
    }
  })
}

/** Whether a recipe has an audio output: every Convert and Compress, and Extract in audio mode only. */
function carriesAudio(recipe: Recipe): boolean
{
  return recipe.kind === 'convert' || recipe.kind === 'compress' || (recipe.kind === 'extract' && recipe.mode === 'audio')
}

function audioBitrateDef<R extends MediaRecipe>(label: string): FieldDef
{
  return def<R, 'audioBitrate'>({
    key: 'audioBitrate',
    label,
    kind: 'select',
    has: (recipe) => carriesAudio(recipe) && hasLossyBitrate(recipe.audio),
    get: (recipe) => (recipe.audio as { kbpsPerPair: number }).kbpsPerPair,
    set: (recipe, value) => ({ ...recipe, audio: { ...(recipe.audio as Extract<AudioOut, { kind: 'codec' }>), kbpsPerPair: value } }),
    text: (value, recipe) => bitrateText(value, recipe.audio),
    unit: () => 'kb/s',
    range: () => audioRange(AUDIO_LIMITS.kbpsPerPair),
    options: (recipes) => bitrateOptions(recipes.map((recipe) => recipe.audio), recipes.map((recipe) => (recipe.audio as { kbpsPerPair: number }).kbpsPerPair))
  })
}

const VIDEO_CODEC_LABELS: Readonly<Record<FieldValues['videoCodec'], string>> =
{
  'copy': 'Copy (no re-encode)',
  'libx264': 'H.264 (libx264)',
  'libx265': 'HEVC (libx265)',
  'libvpx-vp9': 'VP9 (libvpx-vp9)',
  'libaom-av1': 'AV1 (libaom)',
  'libsvtav1': 'AV1 (SVT-AV1)',
  'prores_ks': 'ProRes (prores_ks)',
  'ffv1': 'FFV1',
  'utvideo': 'UT Video',
  'mpeg4': 'MPEG-4',
  'mpeg2video': 'MPEG-2',
  'libtheora': 'Theora',
  'wmv2': 'WMV2'
}

/** Encoders whose output a bitrate does not set: copied video and the lossless and intermediate codecs. */
const NO_VIDEO_BITRATE: readonly FieldValues['videoCodec'][] = ['copy', 'prores_ks', 'ffv1', 'utvideo']

const PIXEL_FORMAT_LABELS: Readonly<Record<PixelFormat, string>> = { 'source': 'Keep source', 'yuv420p': '8-bit 4:2:0', 'yuv420p10le': '10-bit 4:2:0' }

const FIT_LABELS: Readonly<Record<FrameFit['mode'], string>> = { fit: 'Fit inside', pad: 'Pad to size', crop: 'Crop to fill' }

const FRAME_SIZES: ReadonlyArray<FieldValues['size']> =
[
  null,
  { maxWidth: 3840, maxHeight: 2160 },
  { maxWidth: 2560, maxHeight: 1440 },
  { maxWidth: 1920, maxHeight: 1080 },
  { maxWidth: 1280, maxHeight: 720 },
  { maxWidth: 854, maxHeight: 480 },
  { maxWidth: 640, maxHeight: 360 }
]

function sizeText(size: FieldValues['size']): string
{
  if (size === null)
  {
    return 'Original'
  }
  if (size.maxWidth !== null && size.maxHeight !== null)
  {
    return `${size.maxWidth}x${size.maxHeight}`
  }
  return size.maxHeight !== null ? `${size.maxHeight}p` : `${size.maxWidth} px wide`
}

/** A list of option values with the current values the list does not hold added at the end. */
function withCurrent<V>(values: readonly V[], current: readonly V[]): V[]
{
  const keys = new Set(values.map(valueKey))
  return [...values, ...unique(current.map(valueKey)).filter((key) => !keys.has(key)).map((key) => current.find((value) => valueKey(value) === key) as V)]
}

type ConvertVideo = NonNullable<ConvertRecipe['video']>

function encodesVideo(recipe: ConvertRecipe): boolean
{
  return recipe.video !== null && recipe.video.encoder !== 'copy'
}

function withVideo(recipe: ConvertRecipe, video: Partial<ConvertVideo>): ConvertRecipe
{
  return { ...recipe, video: { ...(recipe.video as ConvertVideo), ...video } }
}

const CONVERT_CONTAINERS: readonly string[] = unique(CONVERT_PRESETS.map((entry) => entry.recipe.container))

/** Why one of the containers cannot hold an encoder's output on the pinned build ("MP4 cannot hold Theora."); null when all can. */
function containerRefusal(containers: readonly string[], encoder: VideoEncoder): string | null
{
  return unique(containers).map((container) => videoEncoderFit(encoder, container)?.reason ?? null).find((reason) => reason !== null) ?? null
}

const CONVERT_FIELDS: readonly FieldDef[] =
[
  def<ConvertRecipe, 'container'>({
    key: 'container',
    label: 'Container',
    kind: 'select',
    get: (recipe) => recipe.container,
    set: (recipe, value) => ({ ...recipe, container: value }),
    text: (value) => containerLabel(value),
    options: (recipes) => withCurrent(CONVERT_CONTAINERS, recipes.map((recipe) => recipe.container)).map((value) => ({ value, label: containerLabel(value) }))
  }),
  def<ConvertRecipe, 'videoCodec'>({
    key: 'videoCodec',
    label: 'Video codec',
    kind: 'select',
    has: (recipe) => recipe.video !== null,
    get: (recipe) => (recipe.video as ConvertVideo).encoder,
    set: (recipe, value) => value === 'copy'
      ? withVideo(recipe, { encoder: value, bitrateKbps: null, fit: null, fps: null, pixelFormat: 'source' })
      : withVideo(recipe, { encoder: value, bitrateKbps: NO_VIDEO_BITRATE.includes(value) ? null : (recipe.video as ConvertVideo).bitrateKbps }),
    text: (value) => VIDEO_CODEC_LABELS[value],
    options: (recipes) => (Object.keys(VIDEO_CODEC_LABELS) as FieldValues['videoCodec'][]).map((value) => ({
      value,
      label: VIDEO_CODEC_LABELS[value],
      disabled: value === 'copy' ? null : containerRefusal(recipes.map((recipe) => recipe.container), value)
    }))
  }),
  def<ConvertRecipe, 'videoBitrate'>({
    key: 'videoBitrate',
    label: 'Video bitrate',
    kind: 'number',
    has: (recipe) => encodesVideo(recipe) && !NO_VIDEO_BITRATE.includes((recipe.video as ConvertVideo).encoder),
    get: (recipe) => (recipe.video as ConvertVideo).bitrateKbps,
    set: (recipe, value) => withVideo(recipe, { bitrateKbps: value }),
    text: (value) => value === null ? 'Auto' : kbpsText(value),
    unit: () => 'kb/s',
    range: () => ({ ...JOB_LIMITS.videoBitrateKbps, step: 100 }),
    options: () => [{ value: null, label: 'Auto' }]
  }),
  def<ConvertRecipe, 'size'>({
    key: 'size',
    label: 'Size',
    kind: 'select',
    has: encodesVideo,
    get: (recipe) =>
    {
      const fit = (recipe.video as ConvertVideo).fit
      return fit === null ? null : { maxWidth: fit.maxWidth, maxHeight: fit.maxHeight }
    },
    set: (recipe, value) => withVideo(recipe, { fit: value === null ? null : { ...value, mode: (recipe.video as ConvertVideo).fit?.mode ?? 'fit' } }),
    text: sizeText,
    validate: (value) =>
    {
      const sides = value === null ? [] : [value.maxWidth, value.maxHeight].filter((side): side is number => side !== null)
      const bad = sides.find((side) => rangeError(side, { ...JOB_LIMITS.frameSize, step: 1 }, 'px') !== null)
      return bad === undefined ? null : rangeError(bad, { ...JOB_LIMITS.frameSize, step: 1 }, 'px')
    },
    options: (recipes) => withCurrent(FRAME_SIZES, recipes.map((recipe) =>
    {
      const fit = (recipe.video as ConvertVideo).fit
      return fit === null ? null : { maxWidth: fit.maxWidth, maxHeight: fit.maxHeight }
    })).map((value) => ({ value, label: sizeText(value) }))
  }),
  def<ConvertRecipe, 'fit'>({
    key: 'fit',
    label: 'Fit',
    kind: 'segmented',
    has: (recipe) => encodesVideo(recipe) && (recipe.video as ConvertVideo).fit !== null,
    get: (recipe) => ((recipe.video as ConvertVideo).fit as FrameFit).mode,
    set: (recipe, value) => withVideo(recipe, { fit: { ...((recipe.video as ConvertVideo).fit as FrameFit), mode: value } }),
    text: (value) => FIT_LABELS[value],
    hint: () => 'Keeps the display aspect and never upscales.',
    options: () => (['fit', 'pad', 'crop'] as const).map((value) => ({ value, label: FIT_LABELS[value] }))
  }),
  def<ConvertRecipe, 'fps'>({
    key: 'fps',
    label: 'Frame rate',
    kind: 'select',
    has: encodesVideo,
    get: (recipe) => (recipe.video as ConvertVideo).fps,
    set: (recipe, value) => withVideo(recipe, { fps: value }),
    text: (value) => value === null ? 'Original' : `${shortNumber(value, 3)} fps`,
    unit: () => 'fps',
    range: () => ({ ...JOB_LIMITS.fps, step: 1 }),
    options: (recipes) => withCurrent<number | null>([null, 24, 25, 30, 50, 60], recipes.map((recipe) => (recipe.video as ConvertVideo).fps))
      .map((value) => ({ value, label: value === null ? 'Original' : `${shortNumber(value, 3)} fps` }))
  }),
  def<ConvertRecipe, 'pixelFormat'>({
    key: 'pixelFormat',
    label: 'Pixel format',
    kind: 'select',
    has: encodesVideo,
    get: (recipe) => (recipe.video as ConvertVideo).pixelFormat,
    set: (recipe, value) => withVideo(recipe, { pixelFormat: value }),
    text: (value) => PIXEL_FORMAT_LABELS[value],
    options: () => (['source', 'yuv420p', 'yuv420p10le'] as const).map((value) => ({ value, label: PIXEL_FORMAT_LABELS[value] }))
  }),
  audioCodecDef<ConvertRecipe>(),
  audioBitrateDef<ConvertRecipe>('Audio bitrate'),
  def<ConvertRecipe, 'channels'>({
    key: 'channels',
    label: 'Channels',
    kind: 'segmented',
    streams: true,
    get: (recipe) => recipe.channels,
    set: (recipe, value) => ({ ...recipe, channels: value }),
    text: (value) => CONVERT_CHANNEL_LABELS[value],
    options: () => (['keep', 'stereo', 'mono'] as const).map((value) => ({ value, label: CONVERT_CHANNEL_LABELS[value] }))
  }),
  def<ConvertRecipe, 'subtitles'>({
    key: 'subtitles',
    label: 'Keep subtitles',
    kind: 'checkbox',
    get: (recipe) => recipe.subtitles === 'keep',
    set: (recipe, value) => ({ ...recipe, subtitles: value ? 'keep' : 'drop' }),
    text: (value) => value ? 'Kept' : 'Dropped'
  })
]

const CONVERT_CHANNEL_LABELS: Readonly<Record<ChannelRule, string>> = { keep: 'Keep', stereo: 'Stereo', mono: 'Mono' }

const COMPRESS_ENCODERS: readonly VideoEncoder[] = ['libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9']

const QUALITY_LABELS: Readonly<Record<FieldValues['quality'], string>> = { lossless: 'Lossless', high: 'High', medium: 'Medium', low: 'Low', custom: 'Custom' }

const SPEED_LABELS: Readonly<Record<CompressRecipe['speed'], string>> = { veryfast: 'Very fast', fast: 'Fast', medium: 'Medium', slow: 'Slow', veryslow: 'Very slow' }

type Tune = NonNullable<CompressRecipe['tune']>

const TUNE_LABELS: Readonly<Record<Tune, string>> = { film: 'Film', animation: 'Animation', grain: 'Grain', fastdecode: 'Fast decode', zerolatency: 'Zero latency' }

/** The tunes each encoder accepts by these names; x265 has no film tune, and the AV1 and VP9 encoders take none of them. */
const ENCODER_TUNES: Readonly<Partial<Record<VideoEncoder, readonly Tune[]>>> =
{
  'libx264': ['film', 'animation', 'grain', 'fastdecode', 'zerolatency'],
  'libx265': ['animation', 'grain', 'fastdecode', 'zerolatency']
}

/** The CRF a Custom quality starts from when the recipe had none: each encoder's own default. */
const DEFAULT_CRF: Readonly<Partial<Record<VideoEncoder, number>>> = { 'libx264': 23, 'libx265': 28, 'libvpx-vp9': 31, 'libaom-av1': 32, 'libsvtav1': 35 }

const NO_LOSSLESS = 'SVT-AV1 has no lossless mode.'

/** The size target a switch to Target size starts from, in bytes. */
const DEFAULT_TARGET_BYTES = 25_000_000

function crfRange(encoder: VideoEncoder): NumberRange | null
{
  const range = CRF_RANGES[encoder]
  return range === null ? null : { min: range.min, max: range.max, step: 1 }
}

function clampCrf(crf: number, encoder: VideoEncoder): number
{
  const range = CRF_RANGES[encoder]
  return range === null || range.max === null ? crf : Math.min(Math.max(crf, range.min), range.max)
}

const MAX_HEIGHTS: readonly number[] = [2160, 1440, 1080, 720, 480]

function maxSizeText(fit: FrameFit | null): string
{
  if (fit === null)
  {
    return 'Original'
  }
  return fit.maxWidth === null && fit.maxHeight !== null ? `${fit.maxHeight}p` : sizeText({ maxWidth: fit.maxWidth, maxHeight: fit.maxHeight })
}

/** The kb/s each audio stream of a Compress output takes from a size budget: a chosen bitrate scaled by channels, else the source's. */
export function compressAudioKbps(recipe: CompressRecipe, media: MediaSummary): number[]
{
  return media.audio.map((stream) => recipe.audio.kind === 'codec' && recipe.audio.kbpsPerPair !== null
    ? Math.round(recipe.audio.kbpsPerPair * stream.channels / 2)
    : stream.bitrateKbps ?? 0)
}

/** The size budget of one job's Compress size target, as the planner computes it; null without a duration. */
export function jobSizeBudget(recipe: CompressRecipe, media: MediaSummary | null): SizeBudget | null
{
  if (recipe.target.mode !== 'size' || media === null || media.durationSec === null)
  {
    return null
  }
  return sizeBudget(recipe.target.targetBytes, media.durationSec, compressAudioKbps(recipe, media))
}

/**
 * Where a Compress output goes: the source container unless it cannot hold the encoder on the pinned build, then
 * .mkv with the reason; null for a named container.
 */
function containerNote(recipes: readonly CompressRecipe[], members: readonly JobView[]): string | null
{
  if (recipes.some((recipe) => recipe.container !== 'source'))
  {
    return null
  }
  const exts = unique(members.map((job) => job.source.ext.replace(/^\./, '').toLowerCase()))
  const kept = exts.length === 1 && exts[0] !== '' ? `the source container (.${exts[0]})` : 'each source container'
  const refusals = members.map((job, index) => videoEncoderFit(recipes[index].encoder, job.source.ext)?.reason ?? null)
  const moved = refusals.filter((reason): reason is string => reason !== null)
  if (moved.length === 0)
  {
    return `Compress keeps ${kept} unless it cannot hold the encode; then the output is .mkv and Plan says why.`
  }
  const rule = `Compress keeps ${kept} unless it cannot hold the encode.`
  const reasons = unique(moved)
  if (reasons.length === 1)
  {
    const cause = reasons[0].replace(/\.$/, '')
    return moved.length === members.length
      ? `${rule} ${cause}, so the output is .mkv.`
      : `${rule} ${cause}, so ${moved.length} of the ${members.length} jobs ${plural(moved.length, 'writes', 'write')} .mkv.`
  }
  const who = moved.length === members.length ? `All ${members.length} jobs` : `${moved.length} of the ${members.length} jobs`
  return `${rule} ${who} write .mkv; Plan says why.`
}

const COMPRESS_FIELDS: readonly FieldDef[] =
[
  def<CompressRecipe, 'compressMode'>({
    key: 'compressMode',
    label: 'Mode',
    kind: 'segmented',
    get: (recipe) => recipe.target.mode === 'size' ? 'size' : 'quality',
    set: (recipe, value) =>
    {
      if ((recipe.target.mode === 'size') === (value === 'size'))
      {
        return recipe
      }
      return { ...recipe, target: value === 'size' ? { mode: 'size', targetBytes: DEFAULT_TARGET_BYTES, twoPass: true } : { mode: 'quality', tier: 'medium' } }
    },
    text: (value) => value === 'size' ? 'Target size' : 'Quality',
    options: () => [{ value: 'quality' as const, label: 'Quality' }, { value: 'size' as const, label: 'Target size' }]
  }),
  def<CompressRecipe, 'quality'>({
    key: 'quality',
    label: 'Quality',
    kind: 'select',
    has: (recipe) => recipe.target.mode !== 'size',
    get: (recipe) => recipe.target.mode === 'quality' ? recipe.target.tier : 'custom',
    set: (recipe, value) =>
    {
      if (value !== 'custom')
      {
        return { ...recipe, target: { mode: 'quality', tier: value } }
      }
      const crf = recipe.target.mode === 'crf' ? recipe.target.crf : DEFAULT_CRF[recipe.encoder] ?? 23
      return { ...recipe, target: { mode: 'crf', crf } }
    },
    text: (value) => QUALITY_LABELS[value],
    validate: (value, recipe) => value === 'lossless' && recipe.encoder === 'libsvtav1' ? NO_LOSSLESS : null,
    options: (recipes) => (['lossless', 'high', 'medium', 'low', 'custom'] as const).map((value) => ({
      value,
      label: QUALITY_LABELS[value],
      disabled: value === 'lossless' && recipes.some((recipe) => recipe.encoder === 'libsvtav1') ? NO_LOSSLESS : null
    }))
  }),
  def<CompressRecipe, 'crf'>({
    key: 'crf',
    label: 'CRF',
    kind: 'number',
    has: (recipe) => recipe.target.mode === 'crf',
    get: (recipe) => (recipe.target as { crf: number }).crf,
    set: (recipe, value) => ({ ...recipe, target: { mode: 'crf', crf: value } }),
    text: (value) => `CRF ${shortNumber(value)}`,
    range: (recipe) => crfRange(recipe.encoder),
    hint: () => '0 to 51 for x264 and x265, 0 to 63 for VP9 and AV1'
  }),
  def<CompressRecipe, 'targetSize'>({
    key: 'targetSize',
    label: 'Target size',
    kind: 'number',
    has: (recipe) => recipe.target.mode === 'size',
    get: (recipe) => (recipe.target as { targetBytes: number }).targetBytes / 1_000_000,
    set: (recipe, value) => ({ ...recipe, target: { ...(recipe.target as Extract<CompressRecipe['target'], { mode: 'size' }>), targetBytes: Math.round(value * 1_000_000) } }),
    text: (value) => `${shortNumber(value, 1)} MB`,
    unit: () => 'MB',
    range: () => ({ min: JOB_LIMITS.targetBytes.min / 1_000_000, max: null, step: 1 }),
    hint: () => '1 MB is 1,000,000 bytes. The encode aims a little under the target, and the output must not exceed it.',
    note: (recipes, scope) =>
    {
      if (scope.single === null)
      {
        return 'Each file\'s bitrate follows its duration; see Plan.'
      }
      const budget = jobSizeBudget(recipes[0], scope.single.media)
      const duration = scope.single.media?.durationSec ?? null
      return budget === null || duration === null
        ? null
        : `For this ${clockText(duration)} file: video about ${kbpsText(budget.videoKbps)}, audio ${kbpsText(budget.audioKbps)}.`
    }
  }),
  def<CompressRecipe, 'twoPass'>({
    key: 'twoPass',
    label: 'Two-pass',
    kind: 'checkbox',
    has: (recipe) => recipe.target.mode === 'size',
    get: (recipe) => (recipe.target as { twoPass: boolean }).twoPass,
    set: (recipe, value) => ({ ...recipe, target: { ...(recipe.target as Extract<CompressRecipe['target'], { mode: 'size' }>), twoPass: value } }),
    text: (value) => value ? 'On' : 'Off'
  }),
  def<CompressRecipe, 'encoder'>({
    key: 'encoder',
    label: 'Encoder',
    kind: 'select',
    get: (recipe) => recipe.encoder,
    set: (recipe, value) => ({
      ...recipe,
      encoder: value,
      target: recipe.target.mode === 'crf' ? { mode: 'crf', crf: clampCrf(recipe.target.crf, value) } : recipe.target,
      tune: recipe.tune !== null && (ENCODER_TUNES[value] ?? []).includes(recipe.tune) ? recipe.tune : null
    }),
    text: (value) => VIDEO_CODEC_LABELS[value],
    note: (recipes, scope) => containerNote(recipes, scope.members),
    options: (recipes) => withCurrent(COMPRESS_ENCODERS, recipes.map((recipe) => recipe.encoder)).map((value) => ({
      value,
      label: VIDEO_CODEC_LABELS[value],
      disabled: value === 'libsvtav1' && recipes.some((recipe) => recipe.target.mode === 'quality' && recipe.target.tier === 'lossless') ? NO_LOSSLESS : null
    }))
  }),
  def<CompressRecipe, 'speed'>({
    key: 'speed',
    label: 'Speed',
    kind: 'select',
    get: (recipe) => recipe.speed,
    set: (recipe, value) => ({ ...recipe, speed: value }),
    text: (value) => SPEED_LABELS[value],
    options: () => (['veryfast', 'fast', 'medium', 'slow', 'veryslow'] as const).map((value) => ({ value, label: SPEED_LABELS[value] }))
  }),
  def<CompressRecipe, 'maxSize'>({
    key: 'maxSize',
    label: 'Maximum size',
    kind: 'select',
    get: (recipe) => recipe.fit,
    set: (recipe, value) => ({ ...recipe, fit: value === null ? null : { ...value } }),
    text: maxSizeText,
    hint: () => 'Applies to the picture as displayed, so portrait video is capped like landscape.',
    options: (recipes) => withCurrent<FrameFit | null>([null, ...MAX_HEIGHTS.map((height) => ({ maxWidth: null, maxHeight: height, mode: 'fit' as const }))],
      recipes.map((recipe) => recipe.fit)).map((value) => ({ value, label: maxSizeText(value) }))
  }),
  def<CompressRecipe, 'pixelFormat'>({
    key: 'pixelFormat',
    label: 'Pixel format',
    kind: 'select',
    get: (recipe) => recipe.pixelFormat,
    set: (recipe, value) => ({ ...recipe, pixelFormat: value }),
    text: (value) => PIXEL_FORMAT_LABELS[value],
    readOnly: (recipe) => recipe.target.mode === 'quality' && recipe.target.tier === 'lossless' ? 'Lossless keeps the source pixel format.' : null,
    options: () => (['source', 'yuv420p', 'yuv420p10le'] as const).map((value) => ({ value, label: PIXEL_FORMAT_LABELS[value] }))
  }),
  def<CompressRecipe, 'tune'>({
    key: 'tune',
    label: 'Tune',
    kind: 'select',
    has: (recipe) => recipe.tune !== null || (ENCODER_TUNES[recipe.encoder] ?? []).length > 0,
    get: (recipe) => recipe.tune,
    set: (recipe, value) => ({ ...recipe, tune: value }),
    text: (value) => value === null ? 'None' : TUNE_LABELS[value],
    validate: (value, recipe) => value !== null && !(ENCODER_TUNES[recipe.encoder] ?? []).includes(value)
      ? `${VIDEO_CODEC_LABELS[recipe.encoder]} has no ${TUNE_LABELS[value].toLowerCase()} tune.`
      : null,
    options: (recipes) =>
    {
      const accepted = (Object.keys(TUNE_LABELS) as Tune[]).filter((tune) => recipes.every((recipe) => (ENCODER_TUNES[recipe.encoder] ?? []).includes(tune)))
      return [{ value: null, label: 'None' }, ...accepted.map((value) => ({ value, label: TUNE_LABELS[value] }))]
    }
  }),
  audioCodecDef<CompressRecipe>(),
  audioBitrateDef<CompressRecipe>('Audio bitrate')
]

type ExtractAudio = Extract<ExtractRecipe, { mode: 'audio' }>
type ExtractVideo = Extract<ExtractRecipe, { mode: 'video' }>
type ExtractGif = Extract<ExtractRecipe, { mode: 'gif' }>
type ExtractFrames = Extract<ExtractRecipe, { mode: 'frames' }>
type ExtractStreamed = ExtractAudio | Extract<ExtractRecipe, { mode: 'subtitles' }>
type ExtractRanged = ExtractAudio | ExtractVideo | ExtractGif | ExtractFrames

const EXTRACT_MODE_LABELS: Readonly<Record<ExtractMode, string>> = { audio: 'Audio', video: 'Video', gif: 'GIF', frames: 'Frames', subtitles: 'Subtitles' }

const AUDIO_FORMATS: Readonly<Record<AudioFormat, { label: string; container: string; codec: OutputCodec | null; kbps: number | null }>> =
{
  mp3: { label: 'MP3', container: 'mp3', codec: 'mp3', kbps: 320 },
  aac: { label: 'AAC (M4A)', container: 'm4a', codec: 'aac', kbps: 256 },
  opus: { label: 'Opus', container: 'opus', codec: 'opus', kbps: 128 },
  vorbis: { label: 'Vorbis (OGG)', container: 'ogg', codec: 'vorbis', kbps: 192 },
  flac: { label: 'FLAC', container: 'flac', codec: 'flac', kbps: null },
  wav: { label: 'WAV', container: 'wav', codec: 'pcm', kbps: null },
  aiff: { label: 'AIFF', container: 'aiff', codec: 'pcm', kbps: null },
  copy: { label: 'Copy (no re-encode)', container: 'mka', codec: null, kbps: null }
}

function audioFormatOf(recipe: ExtractAudio): AudioFormat | null
{
  const out = recipe.audio
  if (out.kind === 'copy')
  {
    return 'copy'
  }
  if (out.kind !== 'codec')
  {
    return null
  }
  if (out.codec === 'pcm')
  {
    return recipe.container === 'aiff' || recipe.container === 'aif' ? 'aiff' : 'wav'
  }
  return (['mp3', 'aac', 'opus', 'vorbis', 'flac'] as const).find((format) => format === out.codec) ?? null
}

/** Why an encoder cannot write a sample rate; null when it can. */
function rateRefusal(out: AudioOut, rate: number): string | null
{
  if (out.kind !== 'codec')
  {
    return null
  }
  if (out.codec === 'opus' && rate !== 48000)
  {
    return 'Opus encodes at 48 kHz only.'
  }
  return out.codec === 'mp3' && rate > 48000 ? 'MP3 encodes at 48 kHz at most.' : null
}

function rateText(rate: number | null): string
{
  return rate === null ? 'Original' : `${shortNumber(rate / 1000, 1)} kHz`
}

const EXTRACT_CHANNEL_LABELS: Readonly<Record<ChannelRule, string>> = { keep: 'Original', mono: 'Mono', stereo: 'Stereo' }

const SOURCE_CODECS: Readonly<Record<string, string>> =
{
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC', dts: 'DTS',
  truehd: 'TrueHD', wmav2: 'WMA', subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', mov_text: 'MP4 text',
  hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'DVD', dvb_subtitle: 'DVB'
}

function sourceCodecLabel(codec: string): string
{
  if (codec.startsWith('pcm_'))
  {
    return 'PCM'
  }
  return Object.hasOwn(SOURCE_CODECS, codec) ? SOURCE_CODECS[codec] : codec.toUpperCase()
}

function knownLanguage(code: string | null): string | null
{
  return code === null || code === '' || code.toLowerCase() === 'und' ? null : languageName(code)
}

/** A source audio stream as the one-job Stream field lists it: "Audio 2 · English · AC-3 5.1(side) · 640 kb/s · default". */
export function audioStreamLabel(stream: MediaSummary['audio'][number], index: number): string
{
  const language = knownLanguage(stream.language)
  const format = [sourceCodecLabel(stream.codec), stream.layout].filter((part): part is string => part !== null).join(' ')
  return [`Audio ${index + 1}`, language, format, stream.bitrateKbps === null ? null : kbpsText(stream.bitrateKbps), stream.isDefault ? 'default' : null]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function pickText(pick: StreamPick): string
{
  if (pick.by === 'default')
  {
    return 'Default stream'
  }
  return pick.by === 'language' ? `First stream in ${languageName(pick.language)}` : `Stream ${pick.ordinal}`
}

function streamOptions(recipes: readonly ExtractStreamed[], scope: FieldScope): OptionInput<StreamPick>[]
{
  const single = scope.single
  const audio = recipes.every((recipe) => recipe.mode === 'audio')
  const subtitles = single === null ? undefined : scope.ctx.facts?.[single.id]?.subtitles ?? undefined
  if (single !== null && audio && single.media !== null && single.media.audio.length > 0)
  {
    return [{ value: { by: 'default' }, label: 'Default stream' },
      ...single.media.audio.map((stream, index) => ({ value: { by: 'ordinal' as const, ordinal: index + 1 }, label: audioStreamLabel(stream, index) }))]
  }
  if (single !== null && !audio && subtitles !== undefined && subtitles.length > 0)
  {
    return [{ value: { by: 'default' }, label: 'Default stream' }, ...subtitles.map((stream, index) => ({
      value: { by: 'ordinal' as const, ordinal: index + 1 },
      label: [`Subtitle ${index + 1}`, knownLanguage(stream.language), sourceCodecLabel(stream.codec)].filter((part): part is string => part !== null).join(' · '),
      disabled: stream.bitmap ? bitmapReason(stream.codec) : null
    }))]
  }
  const picks = recipes.map((recipe) => recipe.stream)
  const language = picks.find((pick): pick is Extract<StreamPick, { by: 'language' }> => pick.by === 'language')?.language ??
    scope.members[0].media?.audio.find((stream) => knownLanguage(stream.language) !== null)?.language ?? 'eng'
  const ordinal = picks.find((pick): pick is Extract<StreamPick, { by: 'ordinal' }> => pick.by === 'ordinal')?.ordinal ?? 1
  return [
    { value: { by: 'default' }, label: 'Default stream' },
    { value: { by: 'language', language }, label: 'First stream in a language' },
    { value: { by: 'ordinal', ordinal }, label: 'Stream number' }
  ]
}

function withRange<R extends ExtractRanged>(recipe: R, startSec: number, durationSec: number | null): R
{
  return { ...recipe, range: startSec === 0 && durationSec === null ? null : { startSec, durationSec } }
}

type LoopValue = FieldValues['loop']

function loopText(plays: LoopValue): string
{
  if (plays === 'infinite')
  {
    return 'Forever'
  }
  return plays === 1 ? 'Play once' : `Play ${plays} times`
}

const SAMPLING_DEFAULTS: Readonly<Record<Exclude<FrameSampling['by'], 'thumbnail'>, number>> = { interval: 1, fps: 1, count: 50 }

function samplingAmount(sampling: FrameSampling): number | null
{
  switch (sampling.by)
  {
    case 'interval':
      return sampling.seconds
    case 'fps':
      return sampling.fps
    case 'count':
      return sampling.count
    default:
      return null
  }
}

function samplingWith(by: FrameSampling['by'], amount: number): FrameSampling
{
  switch (by)
  {
    case 'interval':
      return { by, seconds: amount }
    case 'fps':
      return { by, fps: amount }
    case 'count':
      return { by, count: amount }
    default:
      return { by: 'thumbnail' }
  }
}

function samplingText(sampling: FrameSampling): string
{
  switch (sampling.by)
  {
    case 'interval':
      return `Every ${shortNumber(sampling.seconds)} ${plural(sampling.seconds, 'second', 'seconds')}`
    case 'fps':
      return `${shortNumber(sampling.fps)} per second`
    case 'count':
      return `${sampling.count} evenly spaced`
    default:
      return 'One thumbnail'
  }
}

const SAMPLING_RANGES: Readonly<Record<Exclude<FrameSampling['by'], 'thumbnail'>, NumberRange>> =
{
  interval: { min: JOB_LIMITS.frameIntervalSec.min, max: null, step: 0.05 },
  fps: { min: JOB_LIMITS.frameFps.min, max: null, step: 0.01 },
  count: { min: JOB_LIMITS.frameCount.min, max: JOB_LIMITS.frameCount.max, step: 1 }
}

const SAMPLING_UNITS: Readonly<Record<Exclude<FrameSampling['by'], 'thumbnail'>, string>> = { interval: 's', fps: 'per second', count: 'frames' }

const FRAME_FORMAT_LABELS: Readonly<Record<FieldValues['frameFormat'], string>> = { png: 'PNG', jpg: 'JPEG', webp: 'WebP' }

const DITHER_LABELS: Readonly<Record<FieldValues['dither'], string>> = { sierra2_4a: 'Sierra 2-4A', bayer: 'Bayer', floyd_steinberg: 'Floyd-Steinberg', none: 'None' }

const SUBTITLE_FORMAT_LABELS: Readonly<Record<FieldValues['subtitleFormat'], string>> = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' }

const EXTRACT_VIDEO_CONTAINERS: readonly string[] = ['mp4', 'mkv', 'mov', 'webm']

/** The JPEG quality a switch to JPEG starts from. */
const DEFAULT_JPG_QUALITY = 3

/** The CRF a switch to Re-encode starts from, as in the x264 silent-video preset. */
const DEFAULT_EXTRACT_CRF = 20

/** The re-encode an Extract video takes in a container: VP9 in WebM, x264 elsewhere. */
function reencodeFor(container: string, crf: number): NonNullable<ExtractVideo['reencode']>
{
  const encoder = reencodeEncoder(container)
  return { encoder, crf: clampCrf(crf, encoder) }
}

function reencodeEncoder(container: string): NonNullable<ExtractVideo['reencode']>['encoder']
{
  return container === 'webm' ? 'libvpx-vp9' : 'libx264'
}

/** Why a container cannot hold the re-encode an Extract video takes in it; null when it can. */
function reencodeRefusal(container: string): string | null
{
  return containerRefusal([container], reencodeEncoder(container))
}

/** The first Extract preset of a mode, the recipe a mode switch starts from. */
function modeStart(mode: ExtractMode): ExtractRecipe
{
  return structuredClone((EXTRACT_PRESETS.find((entry) => entry.recipe.mode === mode) as BuiltinPreset<ExtractRecipe>).recipe)
}

const EXTRACT_FIELDS: readonly FieldDef[] =
[
  def<ExtractRecipe, 'extractMode'>({
    key: 'extractMode',
    label: 'Extract',
    kind: 'segmented',
    streams: true,
    get: (recipe) => recipe.mode,
    set: (recipe, value) =>
    {
      if (recipe.mode === value)
      {
        return recipe
      }
      const next = modeStart(value)
      const range = recipe.mode === 'subtitles' ? null : recipe.range
      return next.mode === 'subtitles' ? next : { ...next, range }
    },
    text: (value) => EXTRACT_MODE_LABELS[value],
    options: () => (['audio', 'video', 'gif', 'frames', 'subtitles'] as const).map((value) => ({ value, label: EXTRACT_MODE_LABELS[value] }))
  }),
  def<ExtractAudio, 'audioFormat'>({
    key: 'audioFormat',
    label: 'Format',
    kind: 'select',
    streams: true,
    has: (recipe) => recipe.mode === 'audio',
    get: audioFormatOf,
    set: (recipe, value) =>
    {
      if (value === null)
      {
        return recipe
      }
      const format = AUDIO_FORMATS[value]
      const kept = format.codec === null ? null : withCodec(recipe.audio, format.codec)
      const audio: AudioOut = kept === null
        ? { kind: 'copy' }
        : (hasLossyBitrate(recipe.audio) || format.kbps === null ? kept : { ...(kept as Extract<AudioOut, { kind: 'codec' }>), kbpsPerPair: format.kbps })
      const sampleRate = recipe.sampleRate !== null && rateRefusal(audio, recipe.sampleRate) !== null ? null : recipe.sampleRate
      return { ...recipe, container: format.container, audio, sampleRate }
    },
    text: (value, recipe) => value === null
      ? (recipe.audio.kind === 'codec' ? audioCodecLabel(recipe.audio.codec) : 'Same as source')
      : AUDIO_FORMATS[value].label,
    options: () => (Object.keys(AUDIO_FORMATS) as AudioFormat[]).map((value) => ({ value, label: AUDIO_FORMATS[value].label }))
  }),
  audioBitrateDef<ExtractAudio>('Bitrate'),
  def<ExtractAudio, 'sampleRate'>({
    key: 'sampleRate',
    label: 'Sample rate',
    kind: 'select',
    has: (recipe) => recipe.mode === 'audio',
    get: (recipe) => recipe.sampleRate,
    set: (recipe, value) => ({ ...recipe, sampleRate: value }),
    text: rateText,
    validate: (value, recipe) => value === null ? null : rateRefusal(recipe.audio, value),
    options: (recipes) => [null, ...EXTRACT_SAMPLE_RATES].map((value) => ({
      value,
      label: rateText(value),
      disabled: value === null ? null : recipes.map((recipe) => rateRefusal(recipe.audio, value)).find((reason) => reason !== null) ?? null
    }))
  }),
  def<ExtractAudio, 'channels'>({
    key: 'channels',
    label: 'Channels',
    kind: 'segmented',
    streams: true,
    has: (recipe) => recipe.mode === 'audio',
    get: (recipe) => recipe.channels,
    set: (recipe, value) => ({ ...recipe, channels: value }),
    text: (value) => EXTRACT_CHANNEL_LABELS[value],
    options: () => (['keep', 'mono', 'stereo'] as const).map((value) => ({ value, label: EXTRACT_CHANNEL_LABELS[value] }))
  }),
  def<ExtractStreamed, 'stream'>({
    key: 'stream',
    label: 'Stream',
    kind: 'select',
    streams: true,
    nested: [
      { key: 'streamLanguage', on: (value) => value.by === 'language' },
      { key: 'streamOrdinal', on: (value) => value.by === 'ordinal' }
    ],
    has: (recipe) => recipe.mode === 'audio' || recipe.mode === 'subtitles',
    get: (recipe) => recipe.stream,
    set: (recipe, value) => ({ ...recipe, stream: value }),
    text: pickText,
    options: streamOptions
  }),
  def<ExtractStreamed, 'streamLanguage'>({
    key: 'streamLanguage',
    label: 'Language',
    kind: 'input',
    child: true,
    has: (recipe) => (recipe.mode === 'audio' || recipe.mode === 'subtitles') && recipe.stream.by === 'language',
    get: (recipe) => (recipe.stream as Extract<StreamPick, { by: 'language' }>).language,
    set: (recipe, value) => ({ ...recipe, stream: { by: 'language', language: value.trim() } }),
    text: languageName,
    validate: (value) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value.trim()) ? null : 'Enter a language code, such as eng or fr.'
  }),
  def<ExtractStreamed, 'streamOrdinal'>({
    key: 'streamOrdinal',
    label: 'Stream number',
    kind: 'number',
    child: true,
    has: (recipe) => (recipe.mode === 'audio' || recipe.mode === 'subtitles') && recipe.stream.by === 'ordinal',
    get: (recipe) => (recipe.stream as Extract<StreamPick, { by: 'ordinal' }>).ordinal,
    set: (recipe, value) => ({ ...recipe, stream: { by: 'ordinal', ordinal: value } }),
    text: (value) => `Stream ${value}`,
    range: () => ({ ...JOB_LIMITS.streamOrdinal, step: 1 })
  }),
  def<ExtractVideo, 'container'>({
    key: 'container',
    label: 'Container',
    kind: 'select',
    has: (recipe) => recipe.mode === 'video',
    get: (recipe) => recipe.container,
    set: (recipe, value) => ({ ...recipe, container: value, reencode: recipe.reencode === null ? null : reencodeFor(value, recipe.reencode.crf) }),
    text: (value) => containerLabel(value),
    options: (recipes) => withCurrent(EXTRACT_VIDEO_CONTAINERS, recipes.map((recipe) => recipe.container)).map((value) => ({
      value,
      label: containerLabel(value),
      disabled: recipes.some((recipe) => recipe.reencode !== null) ? reencodeRefusal(value) : null
    }))
  }),
  def<ExtractVideo, 'videoCopy'>({
    key: 'videoCopy',
    label: 'Video',
    kind: 'segmented',
    has: (recipe) => recipe.mode === 'video',
    get: (recipe) => recipe.reencode === null ? 'copy' : 'reencode',
    set: (recipe, value) =>
    {
      if ((recipe.reencode === null) === (value === 'copy'))
      {
        return recipe
      }
      return { ...recipe, reencode: value === 'copy' ? null : reencodeFor(recipe.container, DEFAULT_EXTRACT_CRF) }
    },
    text: (value) => value === 'copy' ? 'Copy (cuts at keyframes)' : 'Re-encode',
    options: (recipes) => [
      { value: 'copy' as const, label: 'Copy (cuts at keyframes)' },
      {
        value: 'reencode' as const,
        label: 'Re-encode',
        disabled: unique(recipes.map((recipe) => recipe.container)).map(reencodeRefusal).find((reason) => reason !== null) ?? null
      }
    ]
  }),
  def<ExtractVideo, 'crf'>({
    key: 'crf',
    label: 'CRF',
    kind: 'number',
    has: (recipe) => recipe.mode === 'video' && recipe.reencode !== null,
    get: (recipe) => (recipe.reencode as NonNullable<ExtractVideo['reencode']>).crf,
    set: (recipe, value) => ({ ...recipe, reencode: { ...(recipe.reencode as NonNullable<ExtractVideo['reencode']>), crf: value } }),
    text: (value) => `CRF ${shortNumber(value)}`,
    range: (recipe) => crfRange((recipe.reencode as NonNullable<ExtractVideo['reencode']>).encoder)
  }),
  def<ExtractGif, 'gifWidth'>({
    key: 'gifWidth',
    label: 'Width',
    kind: 'number',
    has: (recipe) => recipe.mode === 'gif',
    get: (recipe) => recipe.width,
    set: (recipe, value) => ({ ...recipe, width: value }),
    text: (value) => value === null ? 'Source width' : `${value} px`,
    unit: () => 'px',
    range: () => ({ ...JOB_LIMITS.gifWidth, step: 1 }),
    options: () => [{ value: null, label: 'Source width' }]
  }),
  def<ExtractGif, 'gifFps'>({
    key: 'gifFps',
    label: 'Frame rate',
    kind: 'number',
    has: (recipe) => recipe.mode === 'gif',
    get: (recipe) => recipe.fps,
    set: (recipe, value) => ({ ...recipe, fps: value }),
    text: (value) => `${shortNumber(value)} fps`,
    unit: () => 'fps',
    range: () => ({ ...JOB_LIMITS.gifFps, step: 1 })
  }),
  def<ExtractGif, 'dither'>({
    key: 'dither',
    label: 'Dither',
    kind: 'select',
    has: (recipe) => recipe.mode === 'gif',
    get: (recipe) => recipe.dither,
    set: (recipe, value) => ({ ...recipe, dither: value }),
    text: (value) => DITHER_LABELS[value],
    options: () => (['sierra2_4a', 'bayer', 'floyd_steinberg', 'none'] as const).map((value) => ({ value, label: DITHER_LABELS[value] }))
  }),
  def<ExtractGif, 'loop'>({
    key: 'loop',
    label: 'Loop',
    kind: 'select',
    nested: [{ key: 'loopCount', on: (value) => typeof value === 'number' && value >= 2 }],
    has: (recipe) => recipe.mode === 'gif',
    get: (recipe) => recipe.plays,
    set: (recipe, value) => ({ ...recipe, plays: value }),
    text: loopText,
    options: (recipes) =>
    {
      const several = recipes.map((recipe) => recipe.plays).find((plays): plays is number => typeof plays === 'number' && plays >= 2) ?? 2
      const values: LoopValue[] = ['infinite', 1, several]
      return values.map((value) => ({ value, label: loopText(value) }))
    }
  }),
  def<ExtractGif, 'loopCount'>({
    key: 'loopCount',
    label: 'Plays',
    kind: 'number',
    child: true,
    has: (recipe) => recipe.mode === 'gif' && typeof recipe.plays === 'number' && recipe.plays >= 2,
    get: (recipe) => recipe.plays as number,
    set: (recipe, value) => ({ ...recipe, plays: value }),
    text: (value) => `${value} times`,
    range: () => ({ min: 2, max: JOB_LIMITS.gifPlays.max, step: 1 })
  }),
  def<ExtractFrames, 'sampling'>({
    key: 'sampling',
    label: 'Sampling',
    kind: 'select',
    nested: [{ key: 'samplingValue', on: (value) => value.by !== 'thumbnail' }],
    has: (recipe) => recipe.mode === 'frames',
    get: (recipe) => recipe.sampling,
    set: (recipe, value) => ({ ...recipe, sampling: value }),
    text: samplingText,
    options: (recipes) => (['interval', 'fps', 'count', 'thumbnail'] as const).map((by) =>
    {
      const current = recipes.map((recipe) => recipe.sampling).find((sampling) => sampling.by === by)
      const value = current ?? samplingWith(by, by === 'thumbnail' ? 0 : SAMPLING_DEFAULTS[by])
      return { value, label: samplingText(value) }
    })
  }),
  def<ExtractFrames, 'samplingValue'>({
    key: 'samplingValue',
    label: 'Amount',
    kind: 'number',
    child: true,
    has: (recipe) => recipe.mode === 'frames' && recipe.sampling.by !== 'thumbnail',
    get: (recipe) => samplingAmount(recipe.sampling) as number,
    set: (recipe, value) => ({ ...recipe, sampling: samplingWith(recipe.sampling.by, value) }),
    text: (value, recipe) => samplingText(samplingWith(recipe.sampling.by, value)),
    unit: (recipe) => SAMPLING_UNITS[recipe.sampling.by as Exclude<FrameSampling['by'], 'thumbnail'>],
    range: (recipe) => SAMPLING_RANGES[recipe.sampling.by as Exclude<FrameSampling['by'], 'thumbnail'>]
  }),
  def<ExtractFrames, 'frameFormat'>({
    key: 'frameFormat',
    label: 'Format',
    kind: 'segmented',
    has: (recipe) => recipe.mode === 'frames',
    get: (recipe) => recipe.format,
    set: (recipe, value) => ({ ...recipe, format: value, jpgQuality: value === 'jpg' ? recipe.jpgQuality ?? DEFAULT_JPG_QUALITY : null }),
    text: (value) => FRAME_FORMAT_LABELS[value],
    options: () => (['png', 'jpg', 'webp'] as const).map((value) => ({ value, label: FRAME_FORMAT_LABELS[value] }))
  }),
  def<ExtractFrames, 'jpgQuality'>({
    key: 'jpgQuality',
    label: 'JPEG quality',
    kind: 'number',
    has: (recipe) => recipe.mode === 'frames' && recipe.format === 'jpg' && recipe.jpgQuality !== null,
    get: (recipe) => recipe.jpgQuality as number,
    set: (recipe, value) => ({ ...recipe, jpgQuality: value }),
    text: (value) => String(value),
    range: () => ({ ...JOB_LIMITS.jpgQuality, step: 1 }),
    hint: () => '2 is best, 31 is smallest.'
  }),
  def<Extract<ExtractRecipe, { mode: 'subtitles' }>, 'subtitleFormat'>({
    key: 'subtitleFormat',
    label: 'Format',
    kind: 'segmented',
    has: (recipe) => recipe.mode === 'subtitles',
    get: (recipe) => recipe.format,
    set: (recipe, value) => ({ ...recipe, format: value }),
    text: (value) => SUBTITLE_FORMAT_LABELS[value],
    options: () => (['srt', 'vtt', 'ass'] as const).map((value) => ({ value, label: SUBTITLE_FORMAT_LABELS[value] }))
  }),
  def<ExtractRanged, 'start'>({
    key: 'start',
    label: 'Start',
    kind: 'number',
    has: (recipe) => (recipe as ExtractRecipe).mode !== 'subtitles',
    get: (recipe) => recipe.range?.startSec ?? 0,
    set: (recipe, value) => withRange(recipe, value, recipe.range?.durationSec ?? null),
    text: clockText,
    unit: () => 's',
    range: () => ({ ...JOB_LIMITS.rangeStartSec, step: 0.1 }),
    note: (recipes, scope) =>
    {
      const recipe = recipes[0]
      const interval = scope.ctx.keyframeIntervalSec ?? null
      const copies = scope.single !== null && recipe.mode === 'video' && recipe.reencode === null && recipe.range !== null && recipe.range.startSec > 0
      return copies && interval !== null && interval > 0
        ? `Copy cuts at keyframes; the clip can start up to ${shortNumber(interval, 1)} s early. Re-encode for an exact cut.`
        : null
    }
  }),
  def<ExtractRanged, 'duration'>({
    key: 'duration',
    label: 'Duration',
    kind: 'number',
    has: (recipe) => (recipe as ExtractRecipe).mode !== 'subtitles',
    get: (recipe) => recipe.range?.durationSec ?? null,
    set: (recipe, value) => withRange(recipe, recipe.range?.startSec ?? 0, value),
    text: (value) => value === null ? 'To the end' : clockText(value),
    unit: () => 's',
    range: () => ({ ...JOB_LIMITS.rangeDurationSec, step: 0.1 }),
    options: () => [{ value: null, label: 'To the end' }]
  })
]

const FIELDS: Readonly<Record<Operation, readonly FieldDef[]>> =
{
  normalize: NORMALIZE_FIELDS,
  boost: BOOST_FIELDS,
  convert: CONVERT_FIELDS,
  compress: COMPRESS_FIELDS,
  extract: EXTRACT_FIELDS
}

function findDef(op: Operation, key: FieldKey): FieldDef | null
{
  return FIELDS[op].find((entry) => entry.key === key) ?? null
}

function holds(entry: FieldDef, recipe: Recipe): boolean
{
  return entry.has === undefined || entry.has(recipe)
}

/** The field keys of an operation in page order, child fields left out. */
export function fieldKeys(op: Operation): FieldKey[]
{
  return FIELDS[op].filter((entry) => entry.child !== true).map((entry) => entry.key)
}

function valueError(entry: FieldDef, value: unknown, recipe: Recipe): string | null
{
  const custom = entry.validate?.(value as never, recipe) ?? null
  if (custom !== null)
  {
    return custom
  }
  const range = entry.range?.(recipe) ?? null
  return range !== null && typeof value === 'number' ? rangeError(value, range, entry.unit?.(recipe) ?? null) : null
}

/** Why a value does not fit a field of this recipe; null when it fits or the recipe has no such field. */
export function fieldError(recipe: Recipe, patch: FieldPatch): string | null
{
  const entry = findDef(recipe.kind, patch.field)
  return entry === null || !holds(entry, recipe) ? null : valueError(entry, patch.value, recipe)
}

/**
 * The recipe with one field set and every other field kept. Null when the recipe has no such field, or its preset
 * fixes the field.
 */
export function applyFieldPatch(recipe: Recipe, patch: FieldPatch, ctx: RecipeContext): Recipe | null
{
  const entry = findDef(recipe.kind, patch.field)
  if (entry === null || !holds(entry, recipe) || (entry.fixed?.(recipe) ?? null) !== null || (entry.readOnly?.(recipe) ?? null) !== null)
  {
    return null
  }
  return entry.set(recipe, patch.value as never, ctx)
}

function streamFacts(job: JobView, ctx: Pick<RecipeContext, 'facts'>): StreamFacts | null
{
  const full = ctx.facts?.[job.id]
  if (full)
  {
    return full
  }
  return job.media === null ? null : factsFromSummary(job.media)
}

const NOTE_ORDER: readonly Applicability['code'][] =
  ['no-video-stream', 'no-audio-stream', 'stream-not-found', 'subtitle-bitmap', 'too-many-channels', 'audio-only-output']

function noteGroupKey(rule: Applicability): string
{
  switch (rule.code)
  {
    case 'no-video-stream':
    case 'no-audio-stream':
      return `${rule.code}:${rule.operation}`
    case 'stream-not-found':
      return `${rule.code}:${rule.kind}:${valueKey(rule.pick)}`
    case 'subtitle-bitmap':
      return `${rule.code}:${rule.codec}`
    case 'too-many-channels':
      return `${rule.code}:${rule.codec}:${rule.maxChannels}`
    default:
      return rule.code
  }
}

const BITMAP_NAMES: Readonly<Record<string, string>> =
  { hdmv_pgs_subtitle: 'PGS', pgssub: 'PGS', dvd_subtitle: 'DVD', dvdsub: 'DVD', dvb_subtitle: 'DVB', dvbsub: 'DVB', xsub: 'XSUB' }

/** Why a bitmap subtitle stream cannot be converted: "Bitmap subtitles (PGS) cannot become text subtitles." */
export function bitmapReason(codec: string): string
{
  const name = Object.hasOwn(BITMAP_NAMES, codec) ? BITMAP_NAMES[codec] : codec.toUpperCase()
  return `Bitmap subtitles (${name}) cannot become text subtitles.`
}

function missingStream(rule: Extract<Applicability, { code: 'stream-not-found' }>): string
{
  if (rule.pick.by === 'language')
  {
    return `No ${rule.kind} stream in ${languageName(rule.pick.language)}`
  }
  return rule.pick.by === 'ordinal' ? `No ${rule.kind} stream ${rule.pick.ordinal}` : `No ${rule.kind} stream`
}

interface NoteGroup
{
  rule: Applicability
  hits: Array<{ job: JobView; rule: Applicability }>
}

function countedText(group: NoteGroup, total: number): string
{
  const { rule } = group
  const count = group.hits.length
  const have = plural(count, 'has', 'have')
  switch (rule.code)
  {
    case 'no-video-stream':
    case 'no-audio-stream':
    {
      const kind = rule.code === 'no-video-stream' ? 'video' : 'audio'
      return `${count} of ${total} ${have} no ${kind} stream; ${rule.operation} needs one, so ${plural(count, 'it', 'they')} would be blocked.`
    }
    case 'audio-only-output':
      return `${count} of ${total} ${have} no video stream; ${plural(count, 'its output', 'their outputs')} will be audio only.`
    case 'too-many-channels':
    {
      const layouts = unique(group.hits.map(({ job, rule: hit }) =>
      {
        const channels = hit as Extract<Applicability, { code: 'too-many-channels' }>
        return job.media?.audio[channels.audioIndex]?.layout?.replace(/\(.*\)$/, '') ?? `${channels.channels}-channel`
      }))
      return `${audioCodecLabel(rule.codec)} holds at most ${rule.maxChannels} channels. ` +
        `${count} of the selected jobs ${have} ${layouts.join(' or ')} audio and would be blocked.`
    }
    case 'stream-not-found':
      return `${missingStream(rule)}. ${count} of the selected jobs would be blocked.`
    default:
      return `${bitmapReason(rule.codec)} ${count} of the selected jobs would be blocked.`
  }
}

/**
 * What recipes would meet on the given jobs, one note per rule with the jobs it meets, counted with the planner's
 * stream rules: "8 of 38 have no video stream; Compress needs one, so they would be blocked." One job reads the
 * planner's own sentence. Jobs that are not probed yet are not counted.
 */
export function consequenceNotes(jobs: readonly JobView[], recipeFor: (job: JobView) => Recipe | null,
  ctx: Pick<RecipeContext, 'facts'> = {}): ConsequenceNote[]
{
  const groups = new Map<string, NoteGroup>()
  for (const job of jobs)
  {
    const recipe = recipeFor(job)
    const facts = streamFacts(job, ctx)
    if (recipe === null || facts === null)
    {
      continue
    }
    const seen = new Set<string>()
    for (const rule of applicability(recipe, facts))
    {
      const key = noteGroupKey(rule)
      if (seen.has(key))
      {
        continue
      }
      seen.add(key)
      const group = groups.get(key)
      if (group)
      {
        group.hits.push({ job, rule })
      }
      else
      {
        groups.set(key, { rule, hits: [{ job, rule }] })
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => NOTE_ORDER.indexOf(a.rule.code) - NOTE_ORDER.indexOf(b.rule.code))
    .map((group) => ({
      code: group.rule.code,
      severity: group.rule.severity,
      count: group.hits.length,
      text: jobs.length === 1
        ? `${applicabilityMessage(group.rule, group.hits[0].job.source.name)}${group.rule.severity === 'error' ? ' It would be blocked.' : ''}`
        : countedText(group, jobs.length)
    }))
}

function notesText(notes: readonly ConsequenceNote[]): string | null
{
  return notes.length === 0 ? null : notes.map((note) => note.text).join(' ')
}

function intersectRanges(ranges: ReadonlyArray<NumberRange | null>): NumberRange | null
{
  const known = ranges.filter((range): range is NumberRange => range !== null)
  if (known.length === 0)
  {
    return null
  }
  return known.reduce((a, b) => ({
    min: Math.max(a.min, b.min),
    max: a.max === null ? b.max : b.max === null ? a.max : Math.min(a.max, b.max),
    step: Math.max(a.step, b.step)
  }))
}

/** Whether a job's value of this field differs from its preset's; album membership is not an edit. */
function fieldEdited(entry: FieldDef, recipe: Recipe, lookup: PresetLookup): boolean
{
  if (entry.key === 'album')
  {
    return false
  }
  const preset = lookup(recipe)
  return preset !== null && preset.recipe.kind === recipe.kind && holds(entry, preset.recipe) &&
    valueKey(entry.get(preset.recipe)) !== valueKey(entry.get(recipe))
}

interface BuildScope
{
  op: Operation
  editable: readonly JobView[]
  locked: readonly JobView[]
  ctx: RecipeContext
  lookup: PresetLookup
}

function lockedNote(entry: FieldDef, scope: BuildScope, shown: readonly DistinctValue[]): string | null
{
  const keys = new Set(shown.map((value) => valueKey(value.value)))
  const differing = scope.locked.filter((job) => job.recipe.kind === scope.op && holds(entry, job.recipe) && !keys.has(valueKey(entry.get(job.recipe))))
  if (differing.length === 0)
  {
    return null
  }
  const values = distinctValues(differing.map((job) => entry.get(job.recipe)), (value, index) => entry.text(value, differing[index].recipe))
  const text = values.length === 1 ? values[0].text : distinctText(values)
  return `${differing.length} locked ${plural(differing.length, 'job keeps', 'jobs keep')} ${text}.`
}

function fieldOption(entry: FieldDef, option: OptionInput<unknown>, members: readonly JobView[], scope: BuildScope, judge: boolean): FieldOption
{
  const patch = { field: entry.key, value: option.value } as FieldPatch
  const note = judge && entry.streams === true
    ? notesText(consequenceNotes(members, (job) => applyFieldPatch(job.recipe, patch, scope.ctx) ?? job.recipe, scope.ctx))
    : null
  return {
    key: valueKey(option.value),
    value: option.value,
    label: option.label,
    description: option.description ?? null,
    group: null,
    disabled: (option.disabled ?? null) !== null,
    reason: option.disabled ?? null,
    note
  }
}

function buildField(entry: FieldDef, scope: BuildScope, parentBlocked: boolean): FieldState | null
{
  const readOnly = scope.editable.length === 0
  const members = (readOnly ? scope.locked : scope.editable).filter((job) => job.recipe.kind === scope.op && holds(entry, job.recipe))
  if (members.length === 0 || members.length < (entry.minJobs ?? 1))
  {
    return null
  }
  const recipes = members.map((job) => job.recipe)
  const fieldScope: FieldScope = { ctx: scope.ctx, members, single: members.length === 1 ? members[0] : null }
  const distinct = distinctValues(recipes.map((recipe) => entry.get(recipe)), (value, index) => entry.text(value, recipes[index]))
  const mixed = distinct.length > 1
  const value = distinct[0].value
  const fixedBy = unique(recipes.map((recipe) => entry.fixed?.(recipe) ?? null).filter((name): name is string => name !== null))
  const ownReason = recipes.map((recipe) => entry.readOnly?.(recipe) ?? null).find((reason) => reason !== null) ?? null
  const reason = readOnly
    ? selectionLockReason(scope.locked).text
    : fixedBy.length > 0 ? `Fixed by ${joinNames(fixedBy)}. Choose Custom to set your own.` : ownReason
  const disabled = reason !== null || parentBlocked
  return {
    key: entry.key,
    label: entry.label.replace('{n}', String(members.length)),
    kind: mixed || entry.kindFor === undefined ? entry.kind : entry.kindFor(value),
    value,
    mixed,
    distinct,
    text: mixed ? 'Mixed' : distinct[0].text,
    mixedText: mixed ? distinctText(distinct) : null,
    disabled,
    reason,
    hint: entry.hint?.(recipes, fieldScope) ?? null,
    error: recipes.map((recipe) => valueError(entry, entry.get(recipe), recipe)).find((error) => error !== null) ?? null,
    note: entry.note?.(recipes, fieldScope) ?? null,
    unit: entry.unit?.(recipes[0]) ?? null,
    range: intersectRanges(recipes.map((recipe) => entry.range?.(recipe) ?? null)),
    options: entry.options ? entry.options(recipes, fieldScope).map((option) => fieldOption(entry, option, members, scope, !disabled)) : null,
    nested: nestedField(entry, scope, value, mixed, disabled),
    more: entry.more === true,
    count: members.length,
    edited: members.filter((job) => fieldEdited(entry, job.recipe, scope.lookup)).length,
    lockedNote: readOnly ? null : lockedNote(entry, scope, distinct)
  } as FieldState
}

/**
 * The child field inside the checked option: a single child always shows, enabled only while its option is checked;
 * of several children, the one the value holds shows.
 */
function nestedField(entry: FieldDef, scope: BuildScope, value: unknown, mixed: boolean, disabled: boolean): FieldState | null
{
  const candidates = entry.nested ?? []
  const pick = candidates.length === 1 ? candidates[0] : (mixed ? undefined : candidates.find((candidate) => candidate.on(value as never)))
  if (pick === undefined)
  {
    return null
  }
  return buildField(findDef(scope.op, pick.key) as FieldDef, scope, disabled || mixed || !pick.on(value as never))
}

/** Every field of an operation for the selection, in page order; a field no aggregated job has is left out. */
export function recipeFields(jobs: readonly JobView[], op: Operation, ctx: RecipeContext): FieldState[]
{
  const { editable, locked } = splitSelection(jobs)
  const scope: BuildScope = { op, editable, locked, ctx, lookup: presetLookup(ctx.presets.user) }
  return FIELDS[op]
    .filter((entry) => entry.child !== true)
    .map((entry) => buildField(entry, scope, false))
    .filter((state): state is FieldState => state !== null)
}

/** The edit a new recipe per editable job makes; a null recipe marks the job invalid, an equal one unchanged. */
function editWith(jobs: readonly JobView[], recipeFor: (job: JobView) => Recipe | null | 'unchanged', ctx: RecipeContext): RecipeEdit
{
  const { editable, locked } = splitSelection(jobs)
  const edit: RecipeEdit = { assignments: [], unchanged: [], invalid: [], locked: locked.map((job) => job.id), notes: [] }
  const next = new Map<JobId, Recipe>()
  for (const job of editable)
  {
    const recipe = recipeFor(job)
    if (recipe === null)
    {
      edit.invalid.push(job.id)
    }
    else if (recipe === 'unchanged' || valueKey(recipe) === valueKey(job.recipe))
    {
      edit.unchanged.push(job.id)
    }
    else
    {
      next.set(job.id, recipe)
      edit.assignments.push({ jobId: job.id, recipe })
    }
  }
  edit.notes = consequenceNotes(editable, (job) => next.get(job.id) ?? job.recipe, ctx)
  return edit
}

/**
 * One field set on every editable selected job that has it, every other field keeping each job's own value. Jobs
 * whose preset fixes the field, or that lack it, are unchanged; jobs the value does not fit keep their recipes.
 */
export function editField(jobs: readonly JobView[], patch: FieldPatch, ctx: RecipeContext): RecipeEdit
{
  return editWith(jobs, (job) => fieldError(job.recipe, patch) !== null ? null : applyFieldPatch(job.recipe, patch, ctx) ?? 'unchanged', ctx)
}

/** The Operation select's order. */
const OPERATION_ORDER: readonly Operation[] = ['convert', 'normalize', 'boost', 'compress', 'extract']

/** A narrowing choice of a mixed Operation select: "Select only Normalize (8)" with the jobs it keeps. */
export interface SelectOnly
{
  op: Operation
  count: number
  label: string
  jobIds: JobId[]
}

/** The Operation select of the Recipe tab, over the editable selected jobs. */
export interface OperationField
{
  label: string
  /** The operation every job shares; when mixed, the most common. */
  value: Operation
  mixed: boolean
  distinct: DistinctValue<Operation>[]
  /** "Normalize", or "Mixed: 8 Normalize, 4 Compress". */
  text: string
  /** Each operation with what its starting recipe would block among the editable jobs. */
  options: FieldOption<Operation>[]
  /** When mixed, the sentence that replaces the rest of the Recipe tab. */
  prompt: string | null
  /** When mixed, one narrowing choice per operation, most common first. */
  selectOnly: SelectOnly[]
  disabled: boolean
  reason: string | null
  count: number
}

/** The whole recipe an operation starts from, as the Operation select assigns it. */
export function operationStart(op: Operation, ctx: RecipeContext): Recipe
{
  return applyDefaultPreset(op, ctx.output)
}

/** The Operation select for the selection; null for an empty selection. */
export function operationField(jobs: readonly JobView[], ctx: RecipeContext): OperationField | null
{
  const { editable, locked } = splitSelection(jobs)
  const readOnly = editable.length === 0
  const members = readOnly ? locked : editable
  if (members.length === 0)
  {
    return null
  }
  const distinct = distinctValues(members.map((job) => job.recipe.kind), (op) => operationLabel(op))
  const mixed = distinct.length > 1
  const options = OPERATION_ORDER.map((op): FieldOption<Operation> => ({
    key: op,
    value: op,
    label: operationLabel(op),
    description: null,
    group: null,
    disabled: false,
    reason: null,
    note: readOnly ? null : notesText(consequenceNotes(editable, () => operationStart(op, ctx), ctx))
  }))
  return {
    label: 'Operation',
    value: distinct[0].value,
    mixed,
    distinct,
    text: mixed ? `Mixed: ${distinct.map((entry) => `${entry.count} ${entry.text}`).join(', ')}` : distinct[0].text,
    options,
    prompt: mixed ? `These jobs use different operations. Choose one operation for all ${members.length}, or narrow the selection:` : null,
    selectOnly: mixed
      ? distinct.map((entry) => ({
        op: entry.value,
        count: entry.count,
        label: `Select only ${entry.text} (${entry.count})`,
        jobIds: members.filter((job) => job.recipe.kind === entry.value).map((job) => job.id)
      }))
      : [],
    disabled: readOnly,
    reason: readOnly ? selectionLockReason(locked).text : null,
    count: members.length
  }
}

/** Every editable selected job given the operation's starting recipe as a whole recipe. */
export function chooseOperation(jobs: readonly JobView[], op: Operation, ctx: RecipeContext): RecipeEdit
{
  return editWith(jobs, () => operationStart(op, ctx), ctx)
}

/** The Preset select of the Recipe tab, over the editable selected jobs of one operation. */
export interface PresetField
{
  label: string
  /** The preset key every job shares (a built-in id, a user preset id, or custom); when mixed, the most common. */
  value: string
  mixed: boolean
  /** Each preset key with its label and the number of jobs on it. */
  distinct: DistinctValue<string>[]
  /** "Streaming (EBU R 128 s2)", with ", edited" when a job differs from it, or "Mixed: 2 presets". */
  text: string
  /** How many jobs differ from their preset. */
  edited: number
  /** "Reset to Streaming (EBU R 128 s2)", offered while the jobs share one preset and some differ from it. */
  reset: string | null
  /** The grouped choices; each option's value is what choosePreset takes. */
  options: FieldOption<string>[]
  disabled: boolean
  reason: string | null
  count: number
}

/** The prefix of a Recently used choice, followed by the recipe's index in the recent list. */
const RECENT_CHOICE = 'recent:'

/** How many recently used recipes the Preset select lists. */
const RECENT_LIMIT = 8

/** A recipe's preset key: its user preset, else its built-in preset, else custom. */
export function presetKey(recipe: Recipe): string
{
  return recipe.userPreset?.id ?? recipe.presetId ?? 'custom'
}

/** A loudness preset as an option: "EBU R 128 (−23 LUFS)"; a label that ends in parentheses takes the target after a comma. */
function loudnessOptionLabel(id: string): string
{
  const entry = findLoudnessPreset(id) as LoudnessPreset
  const target = `${shortNumber(entry.target.integratedLufs)} ${entry.target.unit}`
  return entry.label.endsWith(')') ? `${entry.label}, ${target}` : `${entry.label} (${target})`
}

/** A gain preset as an option, with its values: "Quiet recording +3.5 dB, 60 Hz high-pass". */
function gainOptionLabel(id: string): string
{
  const entry = findGainPreset(id) as GainPreset
  const highpass = entry.recipe.highpassHz > 0 ? `, ${entry.recipe.highpassHz} Hz high-pass` : ''
  return `${entry.label} ${formatSigned(entry.recipe.gainDb, 1)} dB${highpass}`
}

function presetOptionLabel(info: PresetInfo): string
{
  if (info.user)
  {
    return info.label
  }
  if (info.op === 'normalize')
  {
    return loudnessOptionLabel(info.id)
  }
  return info.op === 'boost' ? gainOptionLabel(info.id) : info.label
}

function presetDescription(info: PresetInfo, users: readonly UserPreset[]): string | null
{
  if (info.user)
  {
    return describeRecipe((users.find((entry) => entry.id === info.id) as UserPreset).recipe)
  }
  if (info.op === 'normalize' || info.op === 'boost')
  {
    return null
  }
  return (MEDIA_CATALOGS[info.op] as readonly BuiltinPreset[]).find((entry) => entry.id === info.id)?.description ?? null
}

/**
 * The whole recipe a Preset choice assigns: a preset id with the output policy, Custom from the audio settings'
 * Custom values (Gain's Custom starts from its default preset's values), or a recently used recipe. Null when the
 * choice names nothing this operation has.
 */
export function presetChoiceRecipe(choice: string, op: Operation, ctx: RecipeContext): Recipe | null
{
  if (choice.startsWith(RECENT_CHOICE))
  {
    const recent = ctx.presets.recent[Number(choice.slice(RECENT_CHOICE.length))]
    return recent === undefined ? null : structuredClone(recent)
  }
  if (choice === 'custom')
  {
    if (op === 'normalize')
    {
      return applyLoudnessPreset('custom', ctx.output)
    }
    return op === 'boost' ? { ...(applyDefaultPreset('boost', ctx.output) as BoostRecipe), presetId: 'custom' } : null
  }
  return applyPreset(choice, ctx.output, ctx.presets.user)
}

interface PresetEntry
{
  key: string
  value: string
  label: string
  description: string | null
  group: string | null
  disabled: boolean
}

/** Pinned, Recently used, the operation's groups in order, then Your presets; a current preset no list holds is added, disabled. */
function presetEntries(op: Operation, ctx: RecipeContext, current: readonly Recipe[]): PresetEntry[]
{
  const users = ctx.presets.user
  const lookup = presetLookup(users)
  const entries: PresetEntry[] = []
  const pins = ctx.presets.pins
  for (const slot of (Object.keys(pins) as Array<keyof PresetState['pins']>).sort())
  {
    const info = findPreset(pins[slot] as string, users)
    if (info !== null && info.op === op)
    {
      entries.push({ key: `pinned:${info.id}`, value: info.id, label: presetOptionLabel(info), description: `Alt+${slot}`, group: 'Pinned', disabled: false })
    }
  }
  ctx.presets.recent
    .map((recipe, index) => ({ recipe, index }))
    .filter((entry) => entry.recipe.kind === op)
    .slice(0, RECENT_LIMIT)
    .forEach(({ recipe, index }) => entries.push({
      key: `${RECENT_CHOICE}${index}`,
      value: `${RECENT_CHOICE}${index}`,
      label: `${presetLabel(recipe, lookup)}${isEdited(recipe, lookup) ? ', edited' : ''}`,
      description: describeRecipe(recipe),
      group: 'Recently used',
      disabled: false
    }))
  for (const group of PRESET_GROUPS[op])
  {
    if (group === 'Custom')
    {
      entries.push({ key: 'custom', value: 'custom', label: 'Custom', description: null, group, disabled: false })
      continue
    }
    for (const info of BUILTIN_PRESETS.filter((entry) => entry.op === op && entry.group === group))
    {
      entries.push({ key: info.id, value: info.id, label: presetOptionLabel(info), description: presetDescription(info, users), group, disabled: false })
    }
  }
  for (const user of users.filter((entry) => entry.recipe.kind === op))
  {
    const info = findPreset(user.id, users) as PresetInfo
    entries.push({ key: user.id, value: user.id, label: user.name, description: presetDescription(info, users), group: USER_PRESET_GROUP, disabled: false })
  }
  for (const recipe of current)
  {
    const key = presetKey(recipe)
    if (!entries.some((entry) => entry.key === key))
    {
      entries.push({ key, value: key, label: presetLabel(recipe, lookup), description: null, group: null, disabled: true })
    }
  }
  return entries
}

/** The Preset select for the selection's jobs of one operation; null when none of them has it. */
export function presetField(jobs: readonly JobView[], op: Operation, ctx: RecipeContext): PresetField | null
{
  const { editable, locked } = splitSelection(jobs)
  const readOnly = editable.length === 0
  const members = (readOnly ? locked : editable).filter((job) => job.recipe.kind === op)
  if (members.length === 0)
  {
    return null
  }
  const lookup = presetLookup(ctx.presets.user)
  const recipes = members.map((job) => job.recipe)
  const distinct = distinctValues(recipes.map(presetKey), (_key, index) => presetLabel(recipes[index], lookup))
  const mixed = distinct.length > 1
  const edited = recipes.filter((recipe) => isEdited(recipe, lookup)).length
  const notes = new Map<string, string | null>()
  const noteFor = (choice: string): string | null =>
  {
    if (!notes.has(choice))
    {
      const recipe = presetChoiceRecipe(choice, op, ctx)
      notes.set(choice, recipe === null ? null : notesText(consequenceNotes(members, () => recipe, ctx)))
    }
    return notes.get(choice) as string | null
  }
  return {
    label: 'Preset',
    value: distinct[0].value,
    mixed,
    distinct,
    text: mixed ? `Mixed: ${distinct.length} presets` : `${distinct[0].text}${edited > 0 ? ', edited' : ''}`,
    edited,
    reset: !readOnly && !mixed && edited > 0 ? `Reset to ${distinct[0].text}` : null,
    options: presetEntries(op, ctx, recipes).map((entry): FieldOption<string> => ({
      ...entry,
      reason: null,
      note: readOnly || entry.disabled ? null : noteFor(entry.value)
    })),
    disabled: readOnly,
    reason: readOnly ? selectionLockReason(locked).text : null,
    count: members.length
  }
}

/**
 * Every editable selected job given the chosen preset's whole recipe; nothing of an earlier recipe survives. Custom
 * loudness instead frees a Normalize job's own values from its preset, so editing starts where the job already is.
 */
export function choosePreset(jobs: readonly JobView[], op: Operation, choice: string, ctx: RecipeContext): RecipeEdit
{
  const recipe = presetChoiceRecipe(choice, op, ctx)
  if (choice === 'custom' && op === 'normalize')
  {
    return editWith(jobs, (job) => job.recipe.kind === 'normalize'
      ? { ...structuredClone(job.recipe), presetId: 'custom', userPreset: null }
      : recipe === null ? null : structuredClone(recipe), ctx)
  }
  return editWith(jobs, () => recipe === null ? null : structuredClone(recipe), ctx)
}

/** Each edited editable job given its preset's values again, keeping the preset it names and its album. */
export function resetToPreset(jobs: readonly JobView[], ctx: RecipeContext): RecipeEdit
{
  const lookup = presetLookup(ctx.presets.user)
  return editWith(jobs, (job) =>
  {
    const preset = lookup(job.recipe)
    if (preset === null || !isEdited(job.recipe, lookup))
    {
      return 'unchanged'
    }
    const kept: Record<string, unknown> = { presetId: job.recipe.presetId, userPreset: job.recipe.userPreset }
    if (job.recipe.kind === 'normalize')
    {
      kept.albumGroupId = job.recipe.albumGroupId
    }
    return { ...structuredClone(preset.recipe), ...kept } as Recipe
  }, ctx)
}
