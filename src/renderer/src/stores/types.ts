/**
 * @module stores/types
 * @description Shared TypeScript types, interfaces, and built-in presets
 * used across the application state layer and UI components.
 */

export type View = 'dashboard' | 'batch' | 'editor' | 'player' | 'settings' | 'logs'
export type Operation = 'normalize' | 'boost' | 'convert' | 'extract' | 'compress'

/** Dynamic range compression strength (post-normalization tone control). */
export type CompressionLevel = 'off' | 'light' | 'medium' | 'heavy'

/**
 * Channel layout strategy.
 * - `keep`: Preserve original channel layout (5.1, 7.1, etc).
 * - `stereo`: Plain stereo downmix (FFmpeg default coefficients).
 * - `dialog-stereo`: Stereo downmix with the center channel boosted ~+3 dB
 *   and surrounds attenuated -3 dB. Recovers dialog from 5.1/7.1 mixes that
 *   sound mumbled on TV speakers.
 */
export type DownmixMode = 'keep' | 'stereo' | 'dialog-stereo'

export interface NormalizeOptions {
  /** Integrated loudness target, LUFS. */
  I: number
  /** True peak ceiling, dBTP. */
  TP: number
  /** Loudness range target, LU. Lower = more compressed-feeling. */
  LRA: number
  /** Dynamic range compression strength applied AFTER loudnorm. */
  compression?: CompressionLevel
  /** Channel layout strategy for the output. */
  downmix?: DownmixMode
}

export interface Preset {
  id: string
  name: string
  description: string
  /** Optional short category label shown in the preset chip group. */
  category?: 'Movies' | 'Speech' | 'Music' | 'Broadcast' | 'General'
  /** Glyph name for the PresetIcon registry. */
  icon?: string
  normalization: NormalizeOptions
  audioCodec: string
  audioBitrate: string
}

/**
 * Built-in normalization presets.
 *
 * The first group ("Movies") targets the common home-theatre problem where
 * action scenes are uncomfortably loud while dialog is barely intelligible.
 * Those presets use a tighter LRA target plus post-loudnorm dynamic range
 * compression, and (where appropriate) a dialog-boosted stereo downmix so
 * the result is listenable on TV speakers without constant volume riding.
 *
 * The other groups are reference targets for delivery, not loudness rescue.
 */
export const BUILTIN_PRESETS: Preset[] = [
  { id: 'defaults', name: 'Defaults', description: 'Uses your global normalization settings', category: 'General', icon: 'sliders',
    normalization: { I: -16, TP: -1.5, LRA: 11, compression: 'off', downmix: 'keep' },
    audioCodec: 'inherit', audioBitrate: '256k' },

  // ---- Movie rescue presets ----
  { id: 'movie-balance', name: 'Movie: Balanced', description: 'Tame loud action, lift dialog. Keeps surround layout.', category: 'Movies', icon: 'film',
    normalization: { I: -18, TP: -1.5, LRA: 9, compression: 'medium', downmix: 'keep' },
    audioCodec: 'inherit', audioBitrate: '384k' },
  { id: 'movie-dialog', name: 'Movie: Dialog Boost', description: '5.1 → stereo with center channel raised. Best for laptops/TV speakers.', category: 'Movies', icon: 'message-circle',
    normalization: { I: -16, TP: -1.5, LRA: 7, compression: 'medium', downmix: 'dialog-stereo' },
    audioCodec: 'aac', audioBitrate: '256k' },
  { id: 'movie-latenight', name: 'Movie: Late Night', description: 'Heavy compression + dialog-boosted stereo. Whispers audible, explosions tamed.', category: 'Movies', icon: 'moon',
    normalization: { I: -15, TP: -2, LRA: 5, compression: 'heavy', downmix: 'dialog-stereo' },
    audioCodec: 'aac', audioBitrate: '256k' },

  // ---- Speech ----
  { id: 'podcast', name: 'Podcast', description: 'Speech / podcast (-16 LUFS mono-friendly).', category: 'Speech', icon: 'mic',
    normalization: { I: -16, TP: -1.5, LRA: 8, compression: 'light', downmix: 'keep' },
    audioCodec: 'aac', audioBitrate: '128k' },

  // ---- Music ----
  { id: 'music-streaming', name: 'Music: Streaming', description: 'Spotify / YouTube target (-14 LUFS).', category: 'Music', icon: 'play',
    normalization: { I: -14, TP: -1, LRA: 11, compression: 'off', downmix: 'keep' },
    audioCodec: 'aac', audioBitrate: '320k' },
  { id: 'music-album', name: 'Music: Album', description: 'Audiophile album target (-18 LUFS, wide dynamics).', category: 'Music', icon: 'disc',
    normalization: { I: -18, TP: -1, LRA: 14, compression: 'off', downmix: 'keep' },
    audioCodec: 'aac', audioBitrate: '320k' },

  // ---- Broadcast ----
  { id: 'broadcast', name: 'Broadcast', description: 'EBU R128 / ATSC A/85 (-23 LUFS).', category: 'Broadcast', icon: 'radio-tower',
    normalization: { I: -23, TP: -1, LRA: 15, compression: 'off', downmix: 'keep' },
    audioCodec: 'ac3', audioBitrate: '448k' },
]

/**
 * Volume boost options.
 *
 * - `percent`: primary gain, -50..+200. The displayed dB equivalent is
 *   `20·log10(1 + percent/100)`. +100% ≈ +6 dB (2×), +200% ≈ +9.5 dB.
 * - `limiter`: append `alimiter` after the volume filter so peaks above
 *   `limiterCeiling` are caught instead of clipping. Strongly recommended
 *   for any positive boost above ~+30%.
 * - `limiterCeiling`: dBTP. -1 is broadcast-safe, -0.3 maximizes loudness.
 * - `hpfHz`: high-pass filter cutoff applied BEFORE the volume stage.
 *   Removes sub-audible rumble that would otherwise consume headroom and
 *   force the limiter to clamp audible content. 0 = off, 20 = DC/rumble
 *   only, 60 = voice-friendly, 100 = aggressive (mobile / phone audio).
 */
export interface BoostOptions {
  percent: number
  limiter: boolean
  limiterCeiling: number
  hpfHz: number
}

export interface BoostPreset {
  id: string
  name: string
  description: string
  category: 'Voice' | 'Music' | 'General'
  /** Glyph name for the PresetIcon registry. */
  icon?: string
  options: BoostOptions
}

/**
 * Built-in volume boost presets.
 *
 * The library is intentionally small: most users only need a couple of
 * sensible defaults plus the ability to fine-tune via the advanced panel.
 */
export const BUILTIN_BOOST_PRESETS: BoostPreset[] = [
  { id: 'gentle-lift', name: 'Gentle Lift', category: 'General', icon: 'feather',
    description: 'Subtle +15% lift with a safety limiter. No tonal change.',
    options: { percent: 15, limiter: true, limiterCeiling: -1, hpfHz: 0 } },
  { id: 'quiet-rescue', name: 'Quiet Recording', category: 'Voice', icon: 'volume-2',
    description: 'Rescue under-recorded sources. +50% gain, voice HPF, brick-wall limiter at -1 dBTP.',
    options: { percent: 50, limiter: true, limiterCeiling: -1, hpfHz: 60 } },
  { id: 'voice-clarity', name: 'Voice Clarity', category: 'Voice', icon: 'mic',
    description: '+30% with aggressive low-cut. Best for podcasts, interviews, and dialog clips.',
    options: { percent: 30, limiter: true, limiterCeiling: -1, hpfHz: 80 } },
  { id: 'phone-audio', name: 'Phone Audio', category: 'Voice', icon: 'smartphone',
    description: '+75% with a 100 Hz HPF and a tight limiter. For phone-recorded clips.',
    options: { percent: 75, limiter: true, limiterCeiling: -1, hpfHz: 100 } },
  { id: 'maximize', name: 'Maximize', category: 'Music', icon: 'zap',
    description: '+100% (≈+6 dB) into a -0.3 dBTP brick-wall. Loud, no clipping.',
    options: { percent: 100, limiter: true, limiterCeiling: -0.3, hpfHz: 0 } },
  { id: 'tone-down', name: 'Tone Down', category: 'General', icon: 'volume-1',
    description: 'Quiet a too-loud source by 25%. No limiter needed.',
    options: { percent: -25, limiter: false, limiterCeiling: -1, hpfHz: 0 } },
]

export interface ConvertOptions {
  outputFormat: string
  videoCodec: string
  audioCodec: string
  videoBitrate: string
  audioBitrate: string
  resolution: string
  framerate: string
}

export interface ExtractOptions {
  /**
   * Extraction mode. `audio` is the default and the legacy behaviour.
   * - `audio`     — demux/transcode an audio track to a standalone file.
   * - `video`     — strip audio, keep the video track (silent clip).
   * - `gif`       — render a section to an optimized GIF (palettegen).
   * - `frames`    — export still frames (PNG/JPG/WebP).
   * - `subtitles` — pull an embedded subtitle track to .srt/.vtt/.ass.
   */
  mode?: 'audio' | 'video' | 'gif' | 'frames' | 'subtitles'
  outputFormat: string
  streamIndex: number
  /* Audio */
  audioBitrate?: string
  sampleRate?: string
  channels?: string
  /* Video */
  videoReencode?: boolean
  videoCrf?: number
  /* GIF */
  gifFps?: number
  gifWidth?: number
  gifDither?: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
  gifLoop?: number
  /* Frames */
  framesMode?: 'interval' | 'fps' | 'thumbnail' | 'count'
  frameInterval?: number
  framesFps?: number
  frameCount?: number
  frameFormat?: 'png' | 'jpg' | 'webp'
  jpgQuality?: number
  /* Time range */
  startTime?: string
  duration?: string
}

/**
 * Built-in extraction preset.
 *
 * Bundles a full ExtractOptions snapshot with display metadata. Picking a
 * preset stamps the options atomically; manually editing any field clears
 * the preset selection ("Custom" badge appears).
 */
export interface ExtractPreset {
  id: string
  name: string
  description: string
  category: 'Audio' | 'Video' | 'GIF' | 'Frames' | 'Subtitles'
  icon?: string
  options: ExtractOptions
}

/**
 * Curated extraction presets covering the most common rip-and-repurpose
 * jobs:
 *
 * - **Audio**: pull a clean audio track at common quality tiers.
 * - **Video**: drop the audio (mute trailer, b-roll, silent clip).
 * - **GIF**: make tweet-friendly or HQ animated GIFs using the proper
 *   palettegen + paletteuse two-step pipeline.
 * - **Frames**: storyboard / thumbnail / contact sheet extractions.
 * - **Subtitles**: pull an embedded subtitle stream as a sidecar file.
 */
export const BUILTIN_EXTRACT_PRESETS: ExtractPreset[] = [
  /* --- Audio --- */
  { id: 'audio-mp3-320', name: 'MP3 320k', category: 'Audio', icon: 'music',
    description: 'High quality MP3 — universal compatibility, transparent to most ears.',
    options: { mode: 'audio', outputFormat: 'mp3', streamIndex: 0, audioBitrate: '320k', sampleRate: '', channels: '' } },
  { id: 'audio-aac-256', name: 'AAC 256k', category: 'Audio', icon: 'headphones',
    description: 'AAC 256 kbps in .m4a — efficient lossy, ideal for podcasts and music ripping.',
    options: { mode: 'audio', outputFormat: 'm4a', streamIndex: 0, audioBitrate: '256k', sampleRate: '', channels: '' } },
  { id: 'audio-opus-128', name: 'Opus 128k', category: 'Audio', icon: 'volume-2',
    description: 'Opus 128 kbps — best quality at low bitrate, modern playback only.',
    options: { mode: 'audio', outputFormat: 'opus', streamIndex: 0, audioBitrate: '128k', sampleRate: '', channels: '' } },
  { id: 'audio-flac', name: 'FLAC Lossless', category: 'Audio', icon: 'gem',
    description: 'Lossless FLAC — identical to the source audio stream.',
    options: { mode: 'audio', outputFormat: 'flac', streamIndex: 0, audioBitrate: '', sampleRate: '', channels: '' } },
  { id: 'audio-wav', name: 'WAV PCM 16-bit', category: 'Audio', icon: 'waveform',
    description: 'Uncompressed PCM — large files, maximum compatibility with DAWs.',
    options: { mode: 'audio', outputFormat: 'wav', streamIndex: 0, audioBitrate: '', sampleRate: '', channels: '' } },
  { id: 'audio-podcast', name: 'Podcast Mono 96k', category: 'Audio', icon: 'mic',
    description: 'MP3 96 kbps mono, 44.1 kHz — tiny size for spoken-word distribution.',
    options: { mode: 'audio', outputFormat: 'mp3', streamIndex: 0, audioBitrate: '96k', sampleRate: '44100', channels: 'mono' } },

  /* --- Video (silent) --- */
  { id: 'video-silent-copy', name: 'Silent Video (copy)', category: 'Video', icon: 'film',
    description: 'Stream-copy the video track only — instant, lossless, no re-encode.',
    options: { mode: 'video', outputFormat: 'mp4', streamIndex: 0, videoReencode: false } },
  { id: 'video-silent-h264', name: 'Silent Video (H.264)', category: 'Video', icon: 'clapperboard',
    description: 'Re-encode the video to H.264 CRF 20 with no audio. Good for re-uploading.',
    options: { mode: 'video', outputFormat: 'mp4', streamIndex: 0, videoReencode: true, videoCrf: 20 } },

  /* --- GIF --- */
  { id: 'gif-hq', name: 'GIF: HQ 720p', category: 'GIF', icon: 'monitor',
    description: '720-wide, 15 fps, Sierra dither. Looks good but file size is large.',
    options: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 15, gifWidth: 720, gifDither: 'sierra2_4a', gifLoop: 0 } },
  { id: 'gif-web', name: 'GIF: Web 480p', category: 'GIF', icon: 'globe',
    description: '480-wide, 12 fps. Balanced quality and size for most web embeds.',
    options: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 12, gifWidth: 480, gifDither: 'sierra2_4a', gifLoop: 0 } },
  { id: 'gif-social', name: 'GIF: Social 360p', category: 'GIF', icon: 'message-circle',
    description: '360-wide, 10 fps. Tiny file, ideal for chat and forum posts.',
    options: { mode: 'gif', outputFormat: 'gif', streamIndex: 0, gifFps: 10, gifWidth: 360, gifDither: 'bayer', gifLoop: 0 } },

  /* --- Frames --- */
  { id: 'frames-thumb', name: 'Single Thumbnail', category: 'Frames', icon: 'monitor',
    description: 'One PNG taken at the middle of the clip — perfect cover image.',
    options: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'thumbnail', frameFormat: 'png' } },
  { id: 'frames-every-sec', name: 'Every 1 Second', category: 'Frames', icon: 'film',
    description: 'One PNG per second of source. Good for storyboarding short clips.',
    options: { mode: 'frames', outputFormat: 'png', streamIndex: 0, framesMode: 'interval', frameInterval: 1, frameFormat: 'png' } },
  { id: 'frames-every-5sec', name: 'Every 5 Seconds', category: 'Frames', icon: 'archive',
    description: 'One JPG every 5 seconds — compact contact sheet for long videos.',
    options: { mode: 'frames', outputFormat: 'jpg', streamIndex: 0, framesMode: 'interval', frameInterval: 5, frameFormat: 'jpg', jpgQuality: 3 } },
  { id: 'frames-scene-50', name: '50 Evenly-Spaced Frames', category: 'Frames', icon: 'clapperboard',
    description: '50 JPGs spread across the timeline — quick overview of any duration.',
    options: { mode: 'frames', outputFormat: 'jpg', streamIndex: 0, framesMode: 'count', frameCount: 50, frameFormat: 'jpg', jpgQuality: 4 } },

  /* --- Subtitles --- */
  { id: 'subs-srt', name: 'Subtitles → SRT', category: 'Subtitles', icon: 'book-open',
    description: 'Extract the first embedded subtitle track to a .srt sidecar file.',
    options: { mode: 'subtitles', outputFormat: 'srt', streamIndex: 0 } },
  { id: 'subs-vtt', name: 'Subtitles → WebVTT', category: 'Subtitles', icon: 'globe',
    description: 'WebVTT sidecar — ideal for HTML5 <track> captions.',
    options: { mode: 'subtitles', outputFormat: 'vtt', streamIndex: 0 } },
  { id: 'subs-ass', name: 'Subtitles → ASS', category: 'Subtitles', icon: 'feather',
    description: 'Advanced SubStation Alpha — keeps styling/positioning from anime rips.',
    options: { mode: 'subtitles', outputFormat: 'ass', streamIndex: 0 } },
]

export interface CompressOptions {
  /** Encoding mode. `crf` = quality-targeted; `target-size` = bitrate to hit MB. */
  mode?: 'crf' | 'target-size'
  /** Target output size in MB. Only used when `mode === 'target-size'`. */
  targetSizeMB: number
  /** Quality tier. `custom` reads `customCrf`. */
  quality: 'low' | 'medium' | 'high' | 'lossless' | 'custom'
  /** Custom CRF / CQ value when `quality === 'custom'` (0-51). */
  customCrf?: number
  videoCodec?: string
  /** Encoder speed preset (or cpu-used analog for VP9/AV1). */
  speed?: string
  /** Pixel format: '' (encoder default), 'yuv420p' (max compat), 'yuv420p10le' (10-bit). */
  pixelFormat?: string
  /** Encoder tune: '' | film | animation | grain | fastdecode | zerolatency. x264/x265 only. */
  tune?: string
  /** Cap output height. 0 = no scaling. */
  maxHeight?: number
  /** Two-pass encoding (target-size mode only). */
  twoPass?: boolean
  /** Audio codec override. */
  audioCodec?: 'aac' | 'libopus' | 'flac' | 'copy'
  audioBitrate?: string
}

/**
 * Built-in compression preset.
 *
 * A bundle of CompressOptions plus presentation metadata. Selecting a
 * preset stamps every field onto the active CompressOptions, including
 * absent fields (which are explicitly set to '' / 0 to clear prior state).
 */
export interface CompressPreset {
  id: string
  name: string
  description: string
  category: 'Archive' | 'Web' | 'Mobile' | 'Modern' | 'Special' | 'Audio'
  /** Glyph name for the PresetIcon registry. */
  icon?: string
  options: CompressOptions
}

/**
 * Built-in compression presets.
 *
 * Curated for the most common delivery targets. Each preset is opinionated
 * about codec, CRF/target-size mode, pixel format, and audio. Users can
 * tweak any field after applying — selecting "Custom" exits the preset.
 *
 * Picking the right preset:
 * - **Archival / Master**: keep maximum quality for long-term storage.
 * - **Web 1080p / Web 720p**: balanced for YouTube/social re-uploads.
 * - **Discord 25 MB / 500 MB**: hit Discord's free / Nitro upload caps.
 * - **Mobile Friendly**: small files, broad device decode support.
 * - **Animation / Film Grain**: codec tune for content-aware encoding.
 * - **AV1 Streaming**: modern codec, ~30% smaller than H.265 at same quality.
 * - **Audio: Lossless / High AAC**: audio-only sources.
 */
export const BUILTIN_COMPRESS_PRESETS: CompressPreset[] = [
  { id: 'archival', name: 'Archival (Visually Lossless)', category: 'Archive', icon: 'archive',
    description: 'H.265 10-bit, CRF 18. Indistinguishable from source for archival. Large but smaller than raw.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'high', videoCodec: 'libx265', speed: 'slow',
               pixelFormat: 'yuv420p10le', tune: 'film', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '320k' } },
  { id: 'master', name: 'HQ Master', category: 'Archive', icon: 'gem',
    description: 'H.265 CRF 22, slow preset. Tiny quality loss, ~40% the size of source.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'high', videoCodec: 'libx265', speed: 'slow',
               pixelFormat: 'yuv420p', tune: 'film', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '256k' } },
  { id: 'web-1080p', name: 'Web 1080p', category: 'Web', icon: 'monitor',
    description: 'H.264 CRF 23, capped at 1080p. Plays everywhere. Best general-purpose web upload.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'medium', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: 'yuv420p', tune: '', maxHeight: 1080, twoPass: false,
               audioCodec: 'aac', audioBitrate: '192k' } },
  { id: 'web-720p', name: 'Web 720p Compact', category: 'Web', icon: 'globe',
    description: 'H.264 CRF 26 @ 720p. Small file, fast encode, universal playback.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'low', videoCodec: 'libx264', speed: 'fast',
               pixelFormat: 'yuv420p', tune: '', maxHeight: 720, twoPass: false,
               audioCodec: 'aac', audioBitrate: '128k' } },
  { id: 'discord-25mb', name: 'Discord (25 MB)', category: 'Web', icon: 'discord',
    description: 'Target 24 MB with two-pass H.264 @ 720p. Hits free-tier cap with safety margin.',
    options: { mode: 'target-size', targetSizeMB: 24, quality: 'medium', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: 'yuv420p', tune: '', maxHeight: 720, twoPass: true,
               audioCodec: 'aac', audioBitrate: '96k' } },
  { id: 'discord-nitro', name: 'Discord Nitro (500 MB)', category: 'Web', icon: 'discord',
    description: 'Target 480 MB two-pass H.264 @ 1080p. For longer Nitro uploads.',
    options: { mode: 'target-size', targetSizeMB: 480, quality: 'medium', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: 'yuv420p', tune: '', maxHeight: 1080, twoPass: true,
               audioCodec: 'aac', audioBitrate: '192k' } },
  { id: 'mobile', name: 'Mobile Friendly', category: 'Mobile', icon: 'smartphone',
    description: 'H.264 CRF 24 @ 1080p with fastdecode tune. Plays on phones, tablets, and older devices.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'medium', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: 'yuv420p', tune: 'fastdecode', maxHeight: 1080, twoPass: false,
               audioCodec: 'aac', audioBitrate: '128k' } },
  { id: 'youtube-master', name: 'YouTube Master', category: 'Web', icon: 'youtube',
    description: 'H.264 CRF 18, slow preset. Upload at high quality so YouTube\'s transcode keeps detail.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'high', videoCodec: 'libx264', speed: 'slow',
               pixelFormat: 'yuv420p', tune: 'film', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '384k' } },
  { id: 'animation', name: 'Animation / Cartoons', category: 'Special', icon: 'clapperboard',
    description: 'H.265 CRF 24 with animation tune. Optimized for flat colors and sharp edges.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'medium', videoCodec: 'libx265', speed: 'medium',
               pixelFormat: 'yuv420p', tune: 'animation', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '192k' } },
  { id: 'film-grain', name: 'Film Grain Preserve', category: 'Special', icon: 'film',
    description: 'H.265 10-bit CRF 20 with grain tune. Preserves film texture instead of smoothing it out.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'high', videoCodec: 'libx265', speed: 'slow',
               pixelFormat: 'yuv420p10le', tune: 'grain', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '256k' } },
  { id: 'av1-streaming', name: 'AV1 Streaming', category: 'Modern', icon: 'zap',
    description: 'AV1 CRF 32 + Opus 96k. ~30% smaller than H.265. Modern browsers / VLC only.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'medium', videoCodec: 'libaom-av1', speed: 'medium',
               pixelFormat: 'yuv420p', tune: '', maxHeight: 1080, twoPass: false,
               audioCodec: 'libopus', audioBitrate: '96k' } },
  { id: 'audio-flac', name: 'Audio: Lossless (FLAC)', category: 'Audio', icon: 'gem',
    description: 'Lossless FLAC for audio-only sources. Identical to source, ~50-60% the size of WAV.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'lossless', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: '', tune: '', maxHeight: 0, twoPass: false,
               audioCodec: 'flac', audioBitrate: '' } },
  { id: 'audio-aac', name: 'Audio: High AAC (256k)', category: 'Audio', icon: 'headphones',
    description: 'AAC 256k for audio-only sources. Transparent for most music, plays everywhere.',
    options: { mode: 'crf', targetSizeMB: 0, quality: 'high', videoCodec: 'libx264', speed: 'medium',
               pixelFormat: '', tune: '', maxHeight: 0, twoPass: false,
               audioCodec: 'aac', audioBitrate: '256k' } },
]

export interface FileItem {
  path: string
  name: string
  size: number
  ext: string
  probed?: boolean
  duration?: string
  audioStreams?: number
  videoStreams?: number
  audioCodec?: string
  videoCodec?: string
  channels?: number
  sampleRate?: string
  bitrate?: string
  width?: number
  height?: number
  // Per-file operation assignment (stamped by addFiles from global state if omitted)
  operation?: Operation
  boostPercent?: number
  boostOptions?: BoostOptions
  selectedPreset?: string | null
  selectedBoostPreset?: string | null
  selectedConvertPreset?: string | null
  selectedCompressPreset?: string | null
  selectedExtractPreset?: string | null
  normalizeOptions?: NormalizeOptions
  convertOptions?: ConvertOptions
  extractOptions?: ExtractOptions
  compressOptions?: CompressOptions
}

export interface ProcessingTask {
  id: string
  filePath: string
  fileName: string
  operation: Operation
  boostPercent?: number
  boostOptions?: BoostOptions
  preset?: string
  normalizeOptions?: NormalizeOptions
  status: 'queued' | 'analyzing' | 'processing' | 'finalizing' | 'complete' | 'error' | 'cancelled'
  progress: number
  message: string
  startedAt?: number
  completedAt?: number
  error?: string
  inputSize?: number
  outputSize?: number
  outputPath?: string
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'success' | 'debug' | 'ffmpeg'
  message: string
  details?: string
}

export interface AppConfig {
  version: string
  normalization: { I: number; TP: number; LRA: number }
  audioCodec: string
  fallbackCodec: string
  audioBitrate: string
  supportedExtensions: string[]
  maxWorkers: number
  logDir: string
  tempSuffix: string
  ffmpegPath: string
  ffprobePath: string
  theme: 'dark' | 'light'
  outputDirectory: string
  afterProcessing: 'replace' | 'keep-both'
  confirmReplace: boolean
  preserveSubtitles: boolean
  preserveMetadata: boolean
  showNotifications: boolean
  minimizeToTray: boolean
  showTrayNotification: boolean
  autoUpdate: boolean
  gpuAcceleration: 'off' | 'auto' | 'nvenc' | 'qsv' | 'amf'
  ytdlpBrowser: string
  sidebarCollapsed: boolean
}

export interface SystemInfo {
  platform: string
  arch: string
  cpus: number
  totalMemory: number
  freeMemory: number
  nodeVersion: string
  electronVersion: string
  ffmpegVersion: string
  appVersion: string
}
