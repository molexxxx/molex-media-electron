/**
 * Audio data shared by the main process and the renderer: recipes, loudness targets, measurements, ceilings,
 * gain plans, verdicts, probed media facts, and the static stream plan. Every type is plain data that survives
 * structured clone and JSON, and a quantity that can be non-finite is typed number | null.
 */
import type { MessageRef } from './messages'
import type { GainPresetId, PresetId } from './presets'

/** The loudness unit a preset's source uses; LUFS and LKFS name the same quantity. */
export type LoudnessUnit = 'LUFS' | 'LKFS'

/** How a mono stream is measured: as one channel (ITU-R BS.1770-5), or as played at full level on two speakers. */
export type MonoPolicy = 'one-channel' | 'two-speakers'

/** What a normalize job does when its target needs more gain than the peaks allow. */
export type UnreachablePolicy = 'stop-at-reachable' | 'peak-limit' | 'reduce-dynamics'

/** Stereo downmix coefficients: the stream's own Lo/Ro levels, else ITU-R BS.775-4, or dialog emphasis. */
export type DownmixMode = 'standard' | 'dialog'

/** The output class that selects the codec ceiling and the app's loudness check. */
export type OutputClass = 'lossless' | 'broadcast-lossy' | 'lossy-high' | 'lossy-low'

/** How the processed signal is pinned before the encoder. */
export type PinFormat = 's16-dither' | 's32' | 'encoder'

/** Whether a stream could be measured; anything but 'measured' passes through unchanged. */
export type MeasureStatus = 'measured' | 'silent' | 'too-short' | 'below-floor'

/** One probed audio stream. */
export interface AudioFacts
{
  /** N in 0:a:N. */
  audioIndex: number
  /** The ffprobe absolute stream index. */
  streamIndex: number
  codecName: string
  profile: string | null
  channels: number
  /** The probed layout name, or FFmpeg's default for the channel count when probed as unknown. */
  layout: string | null
  layoutGuessed: boolean
  sampleRate: number
  sampleFmt: string | null
  bitsPerRawSample: number | null
  /** Bits per second; null when the container records none. */
  bitRate: number | null
  durationSec: number | null
  language: string | null
  title: string | null
  disposition: Readonly<Record<string, number>>
}

/** Everything the planners need from one probe of a source file. */
export interface MediaFacts
{
  path: string
  /** Lowercase extension without the dot. */
  container: string
  /** The ffprobe format_name. */
  formatName: string
  durationSec: number
  audio: AudioFacts[]
  video: Array<{ streamIndex: number; codecName: string; cover: boolean }>
  subtitles: Array<{ streamIndex: number; subIndex: number; codecName: string; bitmap: boolean; language: string | null }>
  attachments: Array<{ streamIndex: number; filename: string | null; mimetype: string | null }>
  data: Array<{ streamIndex: number; codecName: string }>
  chapters: number
}

/** A loudness target as its source states it. */
export interface LoudnessTarget
{
  integratedLufs: number
  maxTruePeakDbtp: number
  /** A lower true-peak maximum for outputs louder than a level (Spotify: above -14.0 LUFS, -2.0 dBTP). */
  louderMax: { aboveLufs: number; maxTruePeakDbtp: number } | null
  /** The standard's own tolerance; null when the source states none. */
  toleranceLu: number | null
  unit: LoudnessUnit
}

/** The short-form rule of EBU R 128 s1 and AES TD1004: a cap on the maximum short-term loudness. */
export interface ShortFormRule
{
  /** The cap above the target, 5 LU in both sources. */
  maxAboveTargetLu: number
  /** The allowance over the cap: R 128 s1 allows 0.2 LU, TD1004 none. */
  toleranceLu: number
  /** Items at or under this duration get the rule in automatic mode: 120 s for R 128 s1, 60 s for TD1004. */
  autoMaxDurationSec: number
}

/** One stream's loudness measurement. */
export interface LoudnessStats
{
  status: MeasureStatus
  integratedLufs: number | null
  thresholdLufs: number | null
  /** Null under 60 s, where lraStatus is 'not-applicable'. */
  loudnessRangeLu: number | null
  lraStatus: 'measured' | 'not-applicable'
  /** Recorded only when the short-form rule applies. */
  maxShortTermLufs: number | null
  /** Null for digital silence (status 'silent'), never -Infinity. */
  truePeakDbtp: number | null
  /** Center-channel integrated loudness (not dialogue-gated), cinematic jobs only. */
  dialogueLufs: number | null
  dualMono: boolean
  /** 'bs1770-annex3' when the measurement pre-scale for layouts beyond Annex 1 was applied. */
  channelWeights: 'bs1770-annex1' | 'bs1770-annex3'
}

/** The true-peak ceiling of one output stream. */
export interface Ceiling
{
  presetMaxDbtp: number
  /** Null for lossless outputs. */
  codecCeilingDbtp: number | null
  /** C, the lower of the preset maximum and the codec ceiling. */
  ceilingDbtp: number
  /** L, C minus the 0.5 dB limiter margin. */
  limiterCeilingDbtp: number
  /** The preset's maximum, judged on the true peak before encoding. */
  gateDbtp: number
  /** The app's codec-overshoot limit on the decoded output: C for lossless, the preset maximum for lossy. */
  decodedLimitDbtp: number
  outputClass: OutputClass
  reason: CeilingReason
  basis: 'standard' | 'measured' | 'extrapolated'
}

/** The row of the codec ceiling table a ceiling came from. */
export type CeilingReason =
  | 'lossless' | 'ac3-high' | 'ac3-low' | 'eac3-high' | 'eac3-low' | 'mp2' | 'mp2-low' | 'aac-high' | 'aac-low' | 'mp3-high' | 'mp3-low'
  | 'opus-high' | 'opus-mid' | 'opus-low' | 'vorbis-high' | 'vorbis-low' | 'wma-high' | 'wma-low' | 'other-lossy'

/** How a stream's gain is applied. */
export type GainMode = 'linear' | 'peak-limited' | 'reachable-linear' | 'reachable-limited' | 'passthrough'

/** Why a plan took its mode; a passthrough plan carries the measure status. */
export type PlanReason = 'fits' | 'needs-limiting' | 'limiting-capped' | 'headroom-capped' | 'short-term-capped' | MeasureStatus

/** The gain plan of one stream. */
export interface GainPlan
{
  audioIndex: number
  mode: GainMode
  reason: PlanReason
  /** The normalize target, or the measured level plus the requested gain for a boost. */
  targetLufs: number | null
  requestedGainDb: number
  gainDb: number
  /** H, the limiter ceiling minus the measured true peak; null when the peak is null (passthrough). */
  headroomDb: number | null
  /** Z, the planned peak reduction. */
  limitingDb: number
  /** N, the limiting allowance. */
  maxLimitingDb: number
  predictedLufs: number | null
  /** The measured true peak plus the gain, before the limiter. */
  predictedTruePeakDbtp: number | null
  /** The target plus the short-form allowance when the short-form rule applies. */
  shortTermLimitLufs: number | null
  predictedMaxShortTermLufs: number | null
  ceiling: Ceiling
}

/** A compressor anchored to the program: threshold = measured integrated loudness + offset. */
export interface DynamicsSpec
{
  thresholdOffsetDb: number
  ratio: number
  attackMs: number
  releaseMs: number
}

/** An output codec a recipe can name; wmav2 serves only .wma, .wmv, and .asf outputs. */
export type OutputCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'alac' | 'ac3' | 'eac3' | 'pcm' | 'wmav2'

/** The output encoder: the source's own codec family, or a chosen codec with a bitrate per channel pair. */
export type EncoderPolicy =
  | { kind: 'same-as-source' }
  | { kind: 'codec'; codec: OutputCodec; kbpsPerPair: number | null }

/** The user preset a recipe was applied from; the name is copied at apply time. */
export interface UserPresetRef { id: string; name: string }

/** A whole normalize recipe; applying a preset replaces it, never merges into it. */
export interface NormalizeRecipe
{
  kind: 'normalize'
  /** The built-in preset, whose standard the messages name; 'custom' when none. */
  presetId: PresetId
  userPreset: UserPresetRef | null
  target: LoudnessTarget
  policy: UnreachablePolicy
  /** 0 to 3 dB. */
  maxLimitingDb: number
  /** Fixed by every preset except Custom. */
  mono: MonoPolicy
  /** Duplicate mono into two identical channels (Apple Podcasts); the duplicate is what is measured. */
  monoToStereo: boolean
  downmix: DownmixMode | null
  /** Night listening and the 'reduce-dynamics' policy. */
  dynamics: DynamicsSpec | null
  /** 'auto' applies the rule at or under rule.autoMaxDurationSec. */
  shortForm: { rule: ShortFormRule; mode: 'auto' | 'on' | 'off' } | null
  /** Adds the center-channel estimate for sources with a center channel. */
  cinematic: boolean
  /** The album group's letter; null outside a group. */
  albumGroupId: string | null
  output: EncoderPolicy
}

/** A whole gain recipe, in dB, with the limiter always present. */
export interface BoostRecipe
{
  kind: 'boost'
  /** 'custom' when the recipe did not come from a gain preset. */
  presetId: GainPresetId
  userPreset: UserPresetRef | null
  /** -20 to +12 dB. */
  gainDb: number
  highpassHz: 0 | 20 | 60 | 80 | 100
  /** -9 to -1 dBTP. */
  maxTruePeakDbtp: number
  /** 0 to 6 dB. */
  maxLimitingDb: number
  mono: MonoPolicy
  output: EncoderPolicy
}

/** What verification measured on one output stream. */
export interface VerifiedStream
{
  outIndex: number
  integratedLufs: number | null
  /** Null under 60 s. */
  loudnessRangeLu: number | null
  /** Short-form items only. */
  maxShortTermLufs: number | null
  /** The 8x reference on the signal entering the encoder; lossless outputs reuse the decoded value. */
  preEncodeTruePeakDbtp: number | null
  truePeakDbtp: number | null
  samplePeakDbfs: number | null
  meter: 'soxr-8x' | 'swr-8x'
}

/** A stream's verified outcome; a job's outcome is its worst stream's. */
export type Outcome = 'verified' | 'verified-below-target' | 'outside-tolerance' | 'passthrough' | 'failed'

/** The judgment of one output stream against its plan and its preset. */
export interface StreamVerdict
{
  audioIndex: number
  outcome: Outcome
  loudness:
  {
    status: 'within' | 'below' | 'above' | 'not-checked'
    reference: 'target' | 'reachable'
    referenceLufs: number | null
    deviationLu: number | null
    /** The app check: the standard's tolerance capped at 0.5 for lossless and 1.0 for lossy outputs. */
    toleranceLu: number
    /** The tolerance as the preset's source states it; null when it states none. */
    standardTolerance: { value: number; unit: 'LU' | 'dB' } | null
  }
  shortTerm: { status: 'within' | 'over' | 'not-checked'; limitLufs: number | null; maxLufs: number | null; toleranceLu: number }
  truePeak: { status: 'within' | 'over' | 'not-checked'; basis: 'pre-encode'; gateDbtp: number; overDb: number | null }
  /** The app's codec-overshoot check on the decoded output. */
  decoded: { status: 'within' | 'over' | 'not-checked'; limitDbtp: number; overDb: number | null }
  /** Decoded samples above 0 dBFS: the app's clipping check. */
  samplePeakOver: boolean
  warnings: Array<'decoded-overshoot'>
  /** 0 with the soxr reference; 0.2 with swresample, subtracted from every true-peak limit. */
  meterMarginDb: number
  encodePasses: 1 | 2
}

/** One audio job as the job engine hands it to the audio module. */
export interface AudioJobInput
{
  /** The engine's catalog number. */
  jobId: string
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  recipe: NormalizeRecipe | BoostRecipe
  /** From the engine's probe queue; probed by the analysis when null. */
  facts: MediaFacts | null
  /** Every encode passes -f with the muxer. */
  output: { container: string; muxer: string }
}

/** Why a stream or a whole file cannot run as its recipe and policy stand. */
export type RefusalCode =
  | 'no-audio' | 'too-many-channels' | 'layout-unsupported' | 'no-encoder' | 'container-cannot-hold'
  | 'invalid-recipe' | 'ffmpeg-below-minimum' | 'self-test-failed'

/** A refusal with its message; audioIndex is null for a file-level refusal. */
export interface Refusal
{
  audioIndex: number | null
  code: RefusalCode
  message: MessageRef
}

/** A fact the Review step and the stamp show, for example a remapped layout or a raised sample rate. */
export interface PlanNote
{
  audioIndex: number | null
  message: MessageRef
}

/** One problem in a recipe, in the same shape as the job engine's command issues. */
export interface RecipeIssue { path: string; message: string }

/** A fact the encoder choice records about one stream. */
export type EncoderNote = 'layout-remapped' | 'rate-converted' | 'rate-raised' | 'no-source-encoder' | 'lossless-kept-lossless' | 'container-changed'

/** The encoder, rate, layout, and pin chosen for one output stream. */
export interface EncoderChoice
{
  encoder: string
  bitrateKbps: number | null
  kbpsPerPair: number | null
  sampleRate: number
  layout: string
  channels: number
  pin: PinFormat
  extraArgs: readonly string[]
  notes: readonly EncoderNote[]
}

/** One audio output of a job: filtered through a graph label, or copied. */
export interface AudioOutput
{
  audioIndex: number
  outIndex: number
  /** The graph label when filtered, null when copied. */
  label: string | null
  /** Null when copied. */
  choice: EncoderChoice | null
}

/** A stream kind in the stream plan. */
export type StreamKind = 'video' | 'cover' | 'audio' | 'subtitle' | 'attachment' | 'data'

/** Why a source stream is not kept. */
export type DropReason = 'container-no-video' | 'container-one-audio' | 'subtitle-unsupported' | 'bitmap-subtitle'
  | 'attachments-unsupported' | 'cover-unsupported' | 'data-stream' | 'policy'

/** The explicit stream map of one output: never a bare -map 0, never automatic selection. */
export interface StreamPlan
{
  mapArgs: string[]
  codecArgs: string[]
  metadataArgs: string[]
  kept: Array<{ kind: StreamKind; source: number; output: number; action: 'copy' | 'encode' | 'convert' }>
  dropped: Array<{ kind: StreamKind; source: number; reason: DropReason }>
  chapters: 'kept' | 'dropped' | 'none'
}
