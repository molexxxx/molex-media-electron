/**
 * Audio events and results: the payloads the audio module emits through the job engine, keyed by job id, and the
 * plan, analysis, and result shapes that the Review step, the stamp, and the report render.
 */
import type { MessageRef } from './messages'
import type { Ceiling, EncoderNote, GainPlan, LoudnessStats, MediaFacts, Outcome, PlanNote, Refusal, StreamPlan, StreamVerdict, VerifiedStream } from './types'

/** The stages of an audio job; a correction repeats encode and verify as encode pass 2. */
export type AudioStage = 'probe' | 'measure' | 'measure-dynamics' | 'encode' | 'verify'

/** The fixed maximum of encode passes: the first encode and at most one correction, so no total grows after the fact. */
export const MAX_ENCODE_PASSES = 2

/** Why a job takes its one corrective encode. */
export type CorrectionReason = 'true-peak-over' | 'sample-overs' | 'loudness-off' | 'short-term-over'

/** One stream's measurement before processing. */
export interface StreamMeasurement
{
  audioIndex: number
  layout: string
  channels: number
  sampleRate: number
  stats: LoudnessStats
  loudnessToDialogueLu: number | null
}

/** One stream's static plan: what the Review step shows before anything decodes. */
export interface StaticStreamPlan
{
  audioIndex: number
  encoder: string
  bitrateKbps: number | null
  outputLayout: string
  outputRate: number
  ceiling: Ceiling
  notes: readonly EncoderNote[]
}

/** A job's static plan: container decision, encoder and ceiling per stream, stream map, refusals. */
export interface StaticJobPlan
{
  container: string
  containerChanged: boolean
  streams: StaticStreamPlan[]
  streamPlan: StreamPlan
  /** Non-empty when the job cannot run as its recipe and policy stand. */
  refusals: Refusal[]
  notes: PlanNote[]
}

/** The measurement of a job, cached by the engine under its measure key. */
export interface AudioAnalysis
{
  cacheKey: string
  facts: MediaFacts
  /** Pass A. */
  source: StreamMeasurement[]
  /** Pass B, after the dynamics stage; null without dynamics. */
  afterDynamics: StreamMeasurement[] | null
  measuredAt: number
}

/** Why an FFmpeg run failed, with what the failure stamp needs to explain and repeat it. */
export interface AudioFailure
{
  stage: AudioStage
  encodePass: 1 | 2 | null
  /** Signed; null after a signal. */
  exitCode: number | null
  /** 'EINVAL' for -22, 'ENCODER_NOT_FOUND' for FFmpeg's tag, and so on. */
  exitName: string | null
  signal: string | null
  /** The full command, for "Copy command". */
  argv: string[]
  /** The last 2 KiB of stderr, cut at a line boundary. */
  stderrTail: string
  /** The first 20 decode-error lines verification found. */
  decodeErrors: string[]
  decodeErrorCount: number
}

/** The end of an audio job: before, plan, and after per stream, which the stamp renders. */
export interface AudioJobResult
{
  /** The worst stream outcome, or the job-level end. */
  outcome: Outcome | 'refused' | 'canceled'
  /** The work-folder path the engine places; null when refused, canceled, or failed. */
  outputPath: string | null
  /** 0 when refused or canceled before the first encode. */
  encodePasses: 0 | 1 | 2
  streams: Array<{ before: StreamMeasurement; plan: GainPlan; after: VerifiedStream | null; verdict: StreamVerdict }>
  container: string
  dropped: StreamPlan['dropped']
  /** Non-empty exactly when the outcome is 'refused'; nothing was spawned after the probe. */
  refusals: Refusal[]
  /** Set when the outcome is 'failed'. */
  failure: AudioFailure | null
  /** In display order. */
  messages: MessageRef[]
}

/** A payload the audio module emits; the job engine adds the envelope (sequence number and state machine). */
export type AudioEvent =
  | { type: 'audio.stage'; jobId: string; stage: AudioStage; encodePass: 1 | 2 | null; maxEncodePasses: typeof MAX_ENCODE_PASSES }
  | {
      type: 'audio.progress'; jobId: string; stage: AudioStage; encodePass: 1 | 2 | null
      fraction: number | null; outTimeSec: number | null; speed: number | null; bytes: number | null
    }
  | {
      type: 'audio.static-plan'; jobId: string; streams: StaticStreamPlan[]; refusals: Refusal[]; container: string
      containerChanged: boolean; dropped: StreamPlan['dropped']
    }
  | { type: 'audio.measured'; jobId: string; pass: 'source' | 'after-dynamics'; streams: StreamMeasurement[] }
  | { type: 'audio.planned'; jobId: string; plans: GainPlan[]; notes: PlanNote[] }
  | { type: 'audio.verified'; jobId: string; encodePass: 1 | 2; streams: Array<{ verified: VerifiedStream | null; verdict: StreamVerdict }> }
  | {
      type: 'audio.correcting'; jobId: string; reasons: CorrectionReason[]
      adjustments: Array<{ audioIndex: number; gainDb: number; limiterCeilingDbtp: number }>
    }

/** The label of a stage: Probe, Measure, Measure after dynamics, Encode, Verify, and the correction's Re-encode and Verify. */
export function stageLabel(stage: AudioStage, encodePass: 1 | 2 | null): MessageRef
{
  if (encodePass === 2 && (stage === 'encode' || stage === 'verify'))
  {
    return { key: 'stage', params: { stage, correction: 1 } }
  }
  return { key: 'stage', params: { stage } }
}
