/**
 * Recipes: the frozen settings a job runs with. A recipe is a value; applying a preset produces a whole recipe and
 * nothing merges partial recipes. Normalize and Gain take the audio recipes unchanged.
 */
import type { BoostRecipe, EncoderPolicy, NormalizeRecipe, UserPresetRef } from '../audio/types'

/** An operation as the code names it; users read 'boost' as Gain. */
export type Operation = 'normalize' | 'boost' | 'convert' | 'compress' | 'extract'

/** Every operation, in the order the page lists them. */
export const OPERATIONS: readonly Operation[] = ['normalize', 'boost', 'convert', 'compress', 'extract']

/** Any job's recipe; `kind` names its operation. */
export type Recipe = NormalizeRecipe | BoostRecipe | ConvertRecipe | CompressRecipe | ExtractRecipe

/** Audio output of a video operation: copied, or encoded by the audio encoder policy. */
export type AudioOut = { kind: 'copy' } | EncoderPolicy

/** The output channel rule: keep the layout, the standard stereo downmix, or the equal-weight mono fold. */
export type ChannelRule = 'keep' | 'stereo' | 'mono'

/** A video encoder a recipe can name. */
export type VideoEncoder =
  | 'libx264' | 'libx265' | 'libvpx-vp9' | 'libaom-av1' | 'libsvtav1'
  | 'prores_ks' | 'ffv1' | 'utvideo' | 'mpeg2video' | 'mpeg4' | 'libtheora' | 'wmv2'

/** Every video encoder a recipe can name. */
export const VIDEO_ENCODERS: readonly VideoEncoder[] =
  ['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1', 'prores_ks', 'ffv1', 'utvideo', 'mpeg2video', 'mpeg4', 'libtheora', 'wmv2']

/** 'source' keeps the source pixel format, so lossless output keeps 4:2:2, 4:4:4, and 10-bit. */
export type PixelFormat = 'source' | 'yuv420p' | 'yuv420p10le'

/** A frame size cap applied to the picture as displayed: keeps the display aspect and never upscales. */
export interface FrameFit
{
  maxWidth: number | null
  maxHeight: number | null
  mode: 'fit' | 'pad' | 'crop'
}

/** A Convert recipe. */
export interface ConvertRecipe
{
  kind: 'convert'
  presetId: string | null
  userPreset: UserPresetRef | null
  container: string
  video: { encoder: VideoEncoder | 'copy'; bitrateKbps: number | null; fit: FrameFit | null; fps: number | null; pixelFormat: PixelFormat } | null
  audio: AudioOut
  channels: ChannelRule
  subtitles: 'keep' | 'drop'
}

/** What a Compress recipe aims at; a size target is in bytes (1 MB is 1,000,000 bytes). */
export type CompressTarget =
  | { mode: 'quality'; tier: 'lossless' | 'high' | 'medium' | 'low' }
  | { mode: 'crf'; crf: number }
  | { mode: 'size'; targetBytes: number; twoPass: boolean }

/** A Compress recipe. */
export interface CompressRecipe
{
  kind: 'compress'
  presetId: string | null
  userPreset: UserPresetRef | null
  target: CompressTarget
  encoder: VideoEncoder
  speed: 'veryfast' | 'fast' | 'medium' | 'slow' | 'veryslow'
  pixelFormat: PixelFormat
  tune: 'film' | 'animation' | 'grain' | 'fastdecode' | 'zerolatency' | null
  fit: FrameFit | null
  audio: AudioOut
  /** 'source' keeps the source container when it can hold the encode. */
  container: 'source' | string
}

/** Which source stream an Extract recipe takes, resolved against the probe, never a raw index. */
export type StreamPick =
  | { by: 'default' }
  | { by: 'ordinal'; ordinal: number }
  | { by: 'language'; language: string }

/** A section of the source; durationSec null runs to the end. */
export interface TimeRange
{
  startSec: number
  durationSec: number | null
}

/** How Extract samples frames. */
export type FrameSampling =
  | { by: 'interval'; seconds: number }
  | { by: 'fps'; fps: number }
  | { by: 'count'; count: number }
  | { by: 'thumbnail' }

interface ExtractBase
{
  kind: 'extract'
  presetId: string | null
  userPreset: UserPresetRef | null
}

/** An Extract recipe, one shape per mode; `plays` counts plays, so one play is -loop -1 and N plays is N - 1. */
export type ExtractRecipe =
  | ExtractBase & { mode: 'audio'; stream: StreamPick; audio: AudioOut; container: string; sampleRate: number | null; channels: ChannelRule; range: TimeRange | null }
  | ExtractBase & { mode: 'video'; container: string; reencode: { encoder: 'libx264' | 'libvpx-vp9'; crf: number } | null; range: TimeRange | null }
  | ExtractBase & { mode: 'gif'; fps: number; width: number | null; dither: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'; plays: 'infinite' | number; range: TimeRange | null }
  | ExtractBase & { mode: 'frames'; sampling: FrameSampling; format: 'png' | 'jpg' | 'webp'; jpgQuality: number | null; range: TimeRange | null }
  | ExtractBase & { mode: 'subtitles'; stream: StreamPick; format: 'srt' | 'vtt' | 'ass' }

/** An Extract mode. */
export type ExtractMode = ExtractRecipe['mode']
