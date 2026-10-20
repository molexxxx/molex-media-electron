/**
 * The audio pipeline's types for main-process code: the wire types shared with the renderer beside the main-only
 * specs of each audio module and of the FFmpeg spawn wrapper. Type-only, so importing it loads no module at runtime.
 */
export type * from '../../../shared/audio/types'
export type { AudioAnalysis, AudioEvent, AudioFailure, AudioJobResult, AudioStage } from '../../../shared/audio/events'
export type { CorrectionReason, StaticJobPlan, StaticStreamPlan, StreamMeasurement } from '../../../shared/audio/events'
export type { MessageKey, MessageRef } from '../../../shared/audio/messages'
export type { CeilingBand, CeilingBasis, CodecCeiling } from './ceilings'
export type { ChainOutput, ChainSpec, FilterPart } from './chains'
export type { ContainerRow, ContainerSpec, SubtitleAction, SubtitleRule } from './containers'
export type { DownmixCoefficients, DownmixLevels, FoldCoefficients } from './downmix'
export type { BuildCapabilities, EncoderDecision, EncoderLimits, EncoderOutput, EncoderRefusal } from './encoders'
export type { ProbeJson, ProbeStream } from './facts'
export type { Annex3Result, Ebur128Block, MeasureSpec } from './measure'
export type { AlbumMember, AlbumPlan, BoostPlanRecipe, NormalizePlanRecipe } from './plan'
export type { StreamPolicy } from './streams'
export type { VerifyParse, VerifySpec } from './verify'
export type { Exec, ExecOptions, ExecResult, FfmpegProgress, StopMode } from '../exec'
