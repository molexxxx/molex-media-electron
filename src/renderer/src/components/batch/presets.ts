/**
 * @module components/batch/presets
 * @description Conversion presets, codec data, and conflict detection logic
 * for the batch processing panel. Extracted for testability.
 */

import type { ConvertOptions } from '../../stores/types'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ConvertPreset {
  id: string
  label: string
  description: string
  icon: string
  options: Partial<ConvertOptions>
}

export interface ConflictWarning {
  type: 'error' | 'warning'
  message: string
}

/* ------------------------------------------------------------------ */
/*  Codec / format metadata                                            */
/* ------------------------------------------------------------------ */

/**
 * Codecs that produce bit-exact (mathematically lossless) output. Bitrate
 * settings on these are ignored by FFmpeg; quality is determined solely by
 * the source. UI surfaces a "lossless" badge so users understand a
 * bitrate dropdown has no effect.
 */
export const LOSSLESS_VIDEO_CODECS = new Set(['copy', 'ffv1', 'utvideo'])
export const LOSSLESS_AUDIO_CODECS = new Set(['copy', 'flac', 'alac', 'pcm_s16le', 'pcm_s24le'])

/**
 * Video codecs the GPU pipeline can hardware-accelerate. When the user
 * has GPU acceleration enabled in config, these codecs may transparently
 * be swapped for `_nvenc`/`_qsv`/`_amf` variants by `resolveGpuCodec`.
 * Used by the UI to show a "GPU-eligible" hint next to the codec.
 */
export const GPU_ACCELERATED_VIDEO_CODECS = new Set(['libx264', 'libx265'])

/**
 * Slow-encode codecs. Surfaced as a hint so users don't think the tool
 * has hung. AV1 in libaom is famously ~10× slower than H.264.
 */
export const SLOW_ENCODE_VIDEO_CODECS = new Set(['libaom-av1', 'libvpx-vp9'])

/** Human labels for codec values used by the summary line / chips. */
export const CODEC_LABELS: Record<string, string> = {
  copy: 'Copy',
  libx264: 'H.264',
  libx265: 'H.265',
  'libvpx-vp9': 'VP9',
  'libaom-av1': 'AV1',
  prores_ks: 'ProRes',
  ffv1: 'FFV1',
  utvideo: 'UT Video',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  libtheora: 'Theora',
  wmv2: 'WMV2',
  aac: 'AAC',
  libmp3lame: 'MP3',
  libopus: 'Opus',
  libvorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'AC3',
  eac3: 'E-AC3',
  alac: 'ALAC',
  pcm_s16le: 'PCM 16',
  pcm_s24le: 'PCM 24',
  wmav2: 'WMA'
}

/**
 * Return true when the codec produces mathematically lossless output.
 * `copy` counts as lossless because no re-encode happens.
 */
export function isLosslessCodec(codec: string, kind: 'video' | 'audio'): boolean {
  return kind === 'video'
    ? LOSSLESS_VIDEO_CODECS.has(codec)
    : LOSSLESS_AUDIO_CODECS.has(codec)
}

/**
 * Whether a video codec can be GPU-accelerated by the resolver. Used to
 * show a non-blocking hint in the UI.
 */
export function isGpuAcceleratable(codec: string): boolean {
  return GPU_ACCELERATED_VIDEO_CODECS.has(codec)
}

/** Whether a video codec is known to be slow to encode. */
export function isSlowEncodeCodec(codec: string): boolean {
  return SLOW_ENCODE_VIDEO_CODECS.has(codec)
}

/** Human label for any known codec value; falls back to the raw value. */
export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec
}

/**
 * Parse a bitrate string like `"5000k"`, `"5.5M"`, `"320k"` into a kbit/s
 * number. Returns 0 for empty / non-numeric / "0" (which we treat as
 * lossless sentinel). Used by the file-size estimator.
 */
export function parseBitrateKbps(value: string | undefined | null): number {
  if (!value) return 0
  const trimmed = String(value).trim()
  if (!trimmed || trimmed === '0') return 0
  const m = trimmed.match(/^(\d+(?:\.\d+)?)([kKmM]?)$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (unit === 'm') return n * 1000
  // Plain number or `k` → kbit/s.
  return n
}

/**
 * Estimate the output file size in megabytes for a given duration based
 * on the configured bitrates. Returns 0 when no bitrate is set on either
 * stream (e.g. "Auto" or a lossless codec) — the UI then suppresses the
 * estimate rather than show a misleading number.
 *
 * Formula: `bytes = (v_kbps + a_kbps) × duration_s × 1000 / 8`.
 * Conversion to MB uses the 1024² denominator since that's what users
 * typically see in file managers and upload-size limits.
 */
export function estimateOutputSizeMB(
  options: ConvertOptions,
  durationSec: number
): number {
  if (!durationSec || durationSec <= 0) return 0
  const vKbps = parseBitrateKbps(options.videoBitrate)
  const aKbps = parseBitrateKbps(options.audioBitrate)
  const total = vKbps + aKbps
  if (total <= 0) return 0
  const bytes = (total * 1000 / 8) * durationSec
  return bytes / (1024 * 1024)
}

/** Detect whether an `outputFormat` is an audio-only container. */
export function isAudioOnlyFormat(fmt: string): boolean {
  return AUDIO_ONLY_FORMATS.has(fmt)
}

/** Detect whether an `outputFormat` is a video container. */
export function isVideoContainerFormat(fmt: string): boolean {
  return VIDEO_CONTAINERS.has(fmt)
}


/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const AUDIO_ONLY_FORMATS = new Set(['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'ac3'])
export const VIDEO_CONTAINERS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'ts', 'flv', 'wmv', 'ogv'])

/* ------------------------------------------------------------------ */
/*  Preset categories                                                  */
/* ------------------------------------------------------------------ */

/**
 * Presets are organised into a flat list of categories.
 * Selecting a preset populates the custom options below (Handbrake-style).
 */
export interface PresetCategory {
  label: string
  presets: ConvertPreset[]
}

/* ------------------------------------------------------------------ */
/*  General presets - most commonly used conversions                    */
/* ------------------------------------------------------------------ */

export const GENERAL_PRESETS: ConvertPreset[] = [

  { id: 'mp4-h264',   label: 'MP4 (H.264/AAC)',     description: 'Universal compatibility - plays everywhere',          icon: 'film', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' }},
  { id: 'mkv-hevc',   label: 'MKV (HEVC/AAC)',       description: 'Smaller files, modern players',                      icon: 'package', options: { outputFormat: 'mkv', videoCodec: 'libx265', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' }},
  { id: 'webm-vp9',   label: 'WebM (VP9/Opus)',      description: 'Web-optimized, royalty-free',                         icon: 'globe', options: { outputFormat: 'webm', videoCodec: 'libvpx-vp9', audioCodec: 'libopus', videoBitrate: '2500k', audioBitrate: '192k', resolution: '', framerate: '' }},
  { id: 'mp3-320',    label: 'MP3 320k',             description: 'High quality audio extract',                          icon: 'music', options: { outputFormat: 'mp3', videoCodec: 'copy', audioCodec: 'libmp3lame', videoBitrate: '', audioBitrate: '320k', resolution: '', framerate: '' }},
  { id: 'flac',       label: 'FLAC Lossless',        description: 'Lossless audio archival',                             icon: 'gem', options: { outputFormat: 'flac', videoCodec: 'copy', audioCodec: 'flac', videoBitrate: '', audioBitrate: '0', resolution: '', framerate: '' }},
]

/* ------------------------------------------------------------------ */
/*  Web / Social presets - sets bitrate, resolution, framerate         */
/* ------------------------------------------------------------------ */

export const WEB_PRESETS: ConvertPreset[] = [
  { id: 'discord',    label: 'Discord (25 MB)',       description: '720p, low bitrate for free-tier upload limit',       icon: 'discord', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '1500k', audioBitrate: '128k', resolution: '1280x720', framerate: '30' }},
  { id: 'youtube',    label: 'YouTube Upload',        description: 'Recommended settings for YouTube processing',        icon: 'youtube', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '10000k', audioBitrate: '256k', resolution: '', framerate: '' }},
  { id: 'tiktok',     label: 'TikTok / Reels',       description: 'Short-form vertical video, 30 fps',                  icon: 'tiktok', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '4000k', audioBitrate: '192k', resolution: '1080x1920', framerate: '30' }},
  { id: 'instagram',  label: 'Instagram Reels',        description: 'Vertical 9:16, optimized for in-app playback',       icon: 'instagram', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '3500k', audioBitrate: '128k', resolution: '1080x1920', framerate: '30' }},
  { id: 'twitter',    label: 'Twitter / X',           description: '720p, compact for timeline playback',                icon: 'x-twitter', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '2500k', audioBitrate: '128k', resolution: '1280x720', framerate: '30' }},
  { id: '720p-web',   label: '720p Web',              description: 'Balanced quality for general web embedding',         icon: 'radio', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '2500k', audioBitrate: '192k', resolution: '1280x720', framerate: '30' }},
  { id: 'email-10mb', label: 'Email (10 MB)',        description: '480p, tiny bitrate for email attachments',           icon: 'mail', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '500k', audioBitrate: '96k', resolution: '854x480', framerate: '24' }},
  { id: 'telegram',   label: 'Telegram (2 GB)',       description: '1080p, generous limit, efficient HEVC',              icon: 'telegram', options: { outputFormat: 'mp4', videoCodec: 'libx265', audioCodec: 'aac', videoBitrate: '4000k', audioBitrate: '192k', resolution: '1920x1080', framerate: '' }},
]

/* ------------------------------------------------------------------ */
/*  Device presets - hardware compatibility targets                    */
/* ------------------------------------------------------------------ */

export const DEVICE_PRESETS: ConvertPreset[] = [
  { id: 'apple',      label: 'Apple Device',          description: 'iPhone / iPad / Mac / Apple TV compatible',          icon: 'apple', options: { outputFormat: 'mov', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '8000k', audioBitrate: '256k', resolution: '', framerate: '' }},
  { id: 'android',    label: 'Android',               description: 'Universal Android playback',                         icon: 'android', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '4000k', audioBitrate: '192k', resolution: '', framerate: '' }},
  { id: 'chromecast', label: 'Chromecast',             description: 'Google Cast compatible',                             icon: 'chromecast', options: { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '1920x1080', framerate: '' }},
]

/* ------------------------------------------------------------------ */
/*  Production presets - archival, editing, broadcast                  */
/* ------------------------------------------------------------------ */

export const PRODUCTION_PRESETS: ConvertPreset[] = [
  { id: 'mp4-av1',    label: 'MP4 AV1',              description: 'Next-gen codec, best compression (slow encode)',     icon: 'zap', options: { outputFormat: 'mp4', videoCodec: 'libaom-av1', audioCodec: 'libopus', videoBitrate: '2500k', audioBitrate: '192k', resolution: '', framerate: '' }},
  { id: 'mov-prores', label: 'ProRes (Editing)',      description: 'Intermediate codec for NLE timelines',               icon: 'clapperboard', options: { outputFormat: 'mov', videoCodec: 'prores_ks', audioCodec: 'pcm_s24le', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' }},
  { id: 'mkv-ffv1',   label: 'FFV1 Lossless',        description: 'Mathematically lossless video archival',              icon: 'archive', options: { outputFormat: 'mkv', videoCodec: 'ffv1', audioCodec: 'flac', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' }},
  { id: '4k-archive', label: '4K Archive',            description: 'Full 4K HEVC preservation',                          icon: 'monitor', options: { outputFormat: 'mkv', videoCodec: 'libx265', audioCodec: 'flac', videoBitrate: '25000k', audioBitrate: '0', resolution: '3840x2160', framerate: '' }},
  { id: 'ts-mpeg2',   label: 'MPEG-2 Broadcast',     description: 'Broadcast-compatible transport stream',               icon: 'radio-tower', options: { outputFormat: 'ts', videoCodec: 'mpeg2video', audioCodec: 'ac3', videoBitrate: '8000k', audioBitrate: '256k', resolution: '', framerate: '' }},
]

/* ------------------------------------------------------------------ */
/*  Audio-only presets                                                 */
/* ------------------------------------------------------------------ */

export const AUDIO_PRESETS: ConvertPreset[] = [
  { id: 'wav-pcm',    label: 'WAV 16-bit',           description: 'Uncompressed PCM audio',                              icon: 'disc', options: { outputFormat: 'wav', videoCodec: 'copy', audioCodec: 'pcm_s16le', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' }},
  { id: 'wav-24bit',  label: 'WAV 24-bit',           description: 'Studio-quality uncompressed',                          icon: 'sliders', options: { outputFormat: 'wav', videoCodec: 'copy', audioCodec: 'pcm_s24le', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' }},
  { id: 'alac',       label: 'ALAC (Apple Lossless)', description: 'Apple ecosystem lossless audio',                      icon: 'waveform', options: { outputFormat: 'm4a', videoCodec: 'copy', audioCodec: 'alac', videoBitrate: '', audioBitrate: '', resolution: '', framerate: '' }},
  { id: 'aac-m4a',    label: 'M4A AAC 256k',         description: 'Apple-compatible lossy audio',                         icon: 'headphones', options: { outputFormat: 'm4a', videoCodec: 'copy', audioCodec: 'aac', videoBitrate: '', audioBitrate: '256k', resolution: '', framerate: '' }},
  { id: 'opus-128',   label: 'Opus 128k',            description: 'Best quality at low bitrate',                          icon: 'volume-2', options: { outputFormat: 'ogg', videoCodec: 'copy', audioCodec: 'libopus', videoBitrate: '', audioBitrate: '128k', resolution: '', framerate: '' }},
  { id: 'podcast-mp3', label: 'Podcast MP3 96k',     description: 'Mono-friendly MP3 sized for podcast distribution',    icon: 'mic', options: { outputFormat: 'mp3', videoCodec: 'copy', audioCodec: 'libmp3lame', videoBitrate: '', audioBitrate: '96k', resolution: '', framerate: '' }},
  { id: 'audiobook',  label: 'Audiobook (M4A 64k)',  description: 'AAC mono-style, tiny size for spoken word',           icon: 'book-open', options: { outputFormat: 'm4a', videoCodec: 'copy', audioCodec: 'aac', videoBitrate: '', audioBitrate: '64k', resolution: '', framerate: '' }},
  { id: 'ac3-surr',   label: 'AC3 Surround',         description: 'Dolby Digital 5.1 surround',                           icon: 'volume-1', options: { outputFormat: 'ac3', videoCodec: 'copy', audioCodec: 'ac3', videoBitrate: '', audioBitrate: '448k', resolution: '', framerate: '' }},
]

/** All categories in display order. */
export const PRESET_CATEGORIES: PresetCategory[] = [
  { label: 'General',        presets: GENERAL_PRESETS },
  { label: 'Web / Social',   presets: WEB_PRESETS },
  { label: 'Devices',        presets: DEVICE_PRESETS },
  { label: 'Production',     presets: PRODUCTION_PRESETS },
  { label: 'Audio Only',     presets: AUDIO_PRESETS },
]

/** Flat list of all presets (for validation). */
export const ALL_PRESETS: ConvertPreset[] = PRESET_CATEGORIES.flatMap((c) => c.presets)

/* ------------------------------------------------------------------ */
/*  Conflict detection                                                 */
/* ------------------------------------------------------------------ */

/** Video codecs that only make sense in specific containers. */
const PRORES_CONTAINERS = new Set(['mov', 'mkv'])
const FFV1_CONTAINERS = new Set(['mkv', 'avi'])
const WEBM_VIDEO_CODECS = new Set(['copy', 'libvpx-vp9', 'libaom-av1'])
const WEBM_AUDIO_CODECS = new Set(['copy', 'libopus', 'libvorbis'])
const FLV_VIDEO_CODECS = new Set(['copy', 'libx264', 'mpeg4'])
const FLV_AUDIO_CODECS = new Set(['copy', 'aac', 'libmp3lame'])
const WMV_VIDEO_CODECS = new Set(['copy', 'wmv2'])
const WMV_AUDIO_CODECS = new Set(['copy', 'wmav2'])
const OGV_VIDEO_CODECS = new Set(['copy', 'libtheora', 'libvpx-vp9'])
const OGV_AUDIO_CODECS = new Set(['copy', 'libvorbis', 'libopus', 'flac'])
const MP4_INCOMPATIBLE_VIDEO = new Set(['libtheora', 'ffv1', 'utvideo', 'wmv2'])
const MP4_INCOMPATIBLE_AUDIO = new Set(['libvorbis', 'wmav2'])
const AVI_INCOMPATIBLE_VIDEO = new Set(['libvpx-vp9', 'libaom-av1', 'prores_ks'])
const ALAC_CONTAINERS = new Set(['m4a', 'mov', 'mp4'])

export function detectConvertConflicts(options: ConvertOptions): ConflictWarning[] {
  const warnings: ConflictWarning[] = []
  const fmt = options.outputFormat
  const vc = options.videoCodec
  const ac = options.audioCodec
  const isAudioOnly = AUDIO_ONLY_FORMATS.has(fmt)

  /* ---------- Audio-only format conflicts ---------- */
  if (isAudioOnly && vc !== 'copy' && vc !== '') {
    warnings.push({ type: 'warning', message: `Video codec "${vc}" is ignored for audio-only format ${fmt.toUpperCase()}` })
  }
  if (isAudioOnly && options.resolution) {
    warnings.push({ type: 'warning', message: `Resolution setting is ignored for audio-only format ${fmt.toUpperCase()}` })
  }
  if (isAudioOnly && options.videoBitrate) {
    warnings.push({ type: 'warning', message: 'Video bitrate is ignored for audio-only outputs' })
  }

  /* ---------- WebM ---------- */
  if (fmt === 'webm' && !WEBM_VIDEO_CODECS.has(vc)) {
    warnings.push({ type: 'error', message: `WebM does not support ${vc} - use VP9 or AV1` })
  }
  if (fmt === 'webm' && !WEBM_AUDIO_CODECS.has(ac)) {
    warnings.push({ type: 'error', message: `WebM requires Opus or Vorbis audio, not ${ac}` })
  }

  /* ---------- FLV ---------- */
  if (fmt === 'flv' && !FLV_VIDEO_CODECS.has(vc)) {
    warnings.push({ type: 'error', message: `FLV does not support ${vc} - use H.264 or MPEG-4` })
  }
  if (fmt === 'flv' && !FLV_AUDIO_CODECS.has(ac)) {
    warnings.push({ type: 'error', message: `FLV requires AAC or MP3 audio, not ${ac}` })
  }

  /* ---------- WMV ---------- */
  if (fmt === 'wmv' && !WMV_VIDEO_CODECS.has(vc)) {
    warnings.push({ type: 'error', message: `WMV container requires WMV2 video codec, not ${vc}` })
  }
  if (fmt === 'wmv' && !WMV_AUDIO_CODECS.has(ac)) {
    warnings.push({ type: 'error', message: `WMV container requires WMA audio codec, not ${ac}` })
  }

  /* ---------- OGV ---------- */
  if (fmt === 'ogv' && !OGV_VIDEO_CODECS.has(vc)) {
    warnings.push({ type: 'error', message: `OGV does not support ${vc} - use Theora or VP9` })
  }
  if (fmt === 'ogv' && !OGV_AUDIO_CODECS.has(ac)) {
    warnings.push({ type: 'error', message: `OGV requires Vorbis, Opus, or FLAC audio, not ${ac}` })
  }

  /* ---------- MP4 ---------- */
  if (fmt === 'mp4' && MP4_INCOMPATIBLE_VIDEO.has(vc)) {
    warnings.push({ type: 'error', message: `MP4 does not support ${vc} video codec` })
  }
  if (fmt === 'mp4' && MP4_INCOMPATIBLE_AUDIO.has(ac)) {
    warnings.push({ type: 'error', message: `MP4 does not support ${ac} audio codec` })
  }

  /* ---------- AVI ---------- */
  if (fmt === 'avi' && AVI_INCOMPATIBLE_VIDEO.has(vc)) {
    warnings.push({ type: 'error', message: `AVI does not support ${vc} video codec` })
  }

  /* ---------- TS ---------- */
  if (fmt === 'ts' && new Set(['libvpx-vp9', 'prores_ks', 'ffv1', 'utvideo']).has(vc)) {
    warnings.push({ type: 'error', message: `MPEG-TS does not support ${vc} video codec` })
  }

  /* ---------- MOV ---------- */
  if (fmt === 'mov' && new Set(['libvorbis', 'wmav2']).has(ac)) {
    warnings.push({ type: 'error', message: `MOV does not support ${ac} audio codec` })
  }

  /* ---------- ProRes / FFV1 container warnings ---------- */
  if (vc === 'prores_ks' && !PRORES_CONTAINERS.has(fmt) && !isAudioOnly) {
    warnings.push({ type: 'warning', message: `ProRes works best in MOV or MKV, not ${fmt.toUpperCase()}` })
  }
  if (vc === 'ffv1' && !FFV1_CONTAINERS.has(fmt) && !isAudioOnly) {
    warnings.push({ type: 'warning', message: `FFV1 works best in MKV or AVI, not ${fmt.toUpperCase()}` })
  }

  /* ---------- ALAC container ---------- */
  if (ac === 'alac' && !ALAC_CONTAINERS.has(fmt)) {
    warnings.push({ type: 'error', message: `ALAC audio requires M4A, MOV, or MP4 container` })
  }

  /* ---------- MP3 / OGG format + codec ---------- */
  if (fmt === 'mp3' && ac !== 'copy' && ac !== 'libmp3lame') {
    warnings.push({ type: 'warning', message: `MP3 container typically uses MP3 codec, not ${ac}` })
  }
  if (fmt === 'ogg' && !['copy', 'libvorbis', 'libopus', 'flac'].includes(ac)) {
    warnings.push({ type: 'warning', message: `OGG container typically uses Vorbis or Opus, not ${ac}` })
  }

  /* ---------- Copy codec restrictions ---------- */
  if (vc === 'copy' && options.resolution) {
    warnings.push({ type: 'error', message: 'Cannot change resolution when video codec is "Copy" - select a re-encode codec' })
  }
  if (vc === 'copy' && options.framerate) {
    warnings.push({ type: 'error', message: 'Cannot change framerate when video codec is "Copy" - select a re-encode codec' })
  }
  if (vc === 'copy' && options.videoBitrate) {
    warnings.push({ type: 'warning', message: 'Video bitrate is ignored when codec is "Copy"' })
  }
  if (ac === 'copy' && options.audioBitrate && options.audioBitrate !== '0') {
    warnings.push({ type: 'warning', message: 'Audio bitrate is ignored when audio codec is "Copy"' })
  }

  return warnings
}
