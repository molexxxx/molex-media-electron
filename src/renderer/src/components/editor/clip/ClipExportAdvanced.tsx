/**
 * @module editor/clip/ClipExportAdvanced
 * Advanced export panel for Clip/Trim mode. Surfaces:
 *  - GIF mode: fps, width, dither, palette quality, loop, reverse, boomerang
 *  - Video re-encode: codec, CRF, preset, max height, audio bitrate
 *  - Audio: bitrate
 *
 * Mirrors the Batch processor's export depth so users don't have to leave
 * Trim mode for typical "export this clip as a high-quality GIF" or
 * "export at a specific CRF" flows.
 */
import React from 'react'
import { Select, Toggle, NumberInput } from '../../shared/ui'

export type ExportFormat = 'mp4' | 'mkv' | 'webm' | 'wav' | 'mp3' | 'gif'

export interface GifOptions {
  fps: number
  width: number
  dither: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
  bayerScale: number
  highQuality: boolean
  loopCount: number // 0 = forever, -1 = once, N = N times
  reverse: boolean
  boomerang: boolean
}

export interface VideoOptions {
  codec: string
  crf: number
  preset: string
  maxHeight: number
  audioBitrate: string
}

export const DEFAULT_GIF: GifOptions = {
  fps: 15,
  width: 480,
  dither: 'sierra2_4a',
  bayerScale: 3,
  highQuality: true,
  loopCount: 0,
  reverse: false,
  boomerang: false
}

export const DEFAULT_VIDEO: VideoOptions = {
  codec: 'libx264',
  crf: 20,
  preset: 'medium',
  maxHeight: 0,
  audioBitrate: '192k'
}

const VIDEO_CODECS = [
  { value: 'libx264', label: 'H.264 (libx264)' },
  { value: 'libx265', label: 'H.265 (libx265)' },
  { value: 'libvpx-vp9', label: 'VP9 (libvpx-vp9)' },
  { value: 'libaom-av1', label: 'AV1 (libaom-av1)' }
]

const PRESETS = [
  { value: 'ultrafast', label: 'Ultrafast' },
  { value: 'fast', label: 'Fast' },
  { value: 'medium', label: 'Medium' },
  { value: 'slow', label: 'Slow' },
  { value: 'veryslow', label: 'Very slow' }
]

const HEIGHT_CAPS = [
  { value: '0', label: 'Original' },
  { value: '2160', label: '2160p (4K)' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' }
]

const AUDIO_BITRATES = [
  { value: '320k', label: '320 kbps' },
  { value: '256k', label: '256 kbps' },
  { value: '192k', label: '192 kbps' },
  { value: '128k', label: '128 kbps' },
  { value: '96k', label: '96 kbps' }
]

const DITHER_OPTIONS = [
  { value: 'sierra2_4a', label: 'Sierra (recommended)' },
  { value: 'floyd_steinberg', label: 'Floyd-Steinberg' },
  { value: 'bayer', label: 'Bayer (ordered)' },
  { value: 'none', label: 'None (posterized)' }
]

const LOOP_OPTIONS = [
  { value: '0', label: 'Loop forever' },
  { value: '-1', label: 'Play once' },
  { value: '1', label: 'Loop 1×' },
  { value: '3', label: 'Loop 3×' },
  { value: '5', label: 'Loop 5×' }
]

interface ClipExportAdvancedProps {
  format: ExportFormat
  gif: GifOptions
  video: VideoOptions
  onGifChange: (v: GifOptions) => void
  onVideoChange: (v: VideoOptions) => void
  onClose: () => void
}

export function ClipExportAdvanced({
  format,
  gif,
  video,
  onGifChange,
  onVideoChange,
  onClose
}: ClipExportAdvancedProps): React.JSX.Element {
  const isGif = format === 'gif'
  const isAudio = format === 'wav' || format === 'mp3'
  const isVideo = !isGif && !isAudio

  return (
    <div className="absolute bottom-full right-0 mb-2 w-md max-w-[calc(100vw-2rem)] rounded-xl bg-surface-900/95 backdrop-blur border border-white/10 shadow-xl shadow-black/50 p-4 z-50">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-surface-100">
          {isGif ? 'GIF Export Options' : isAudio ? 'Audio Export Options' : 'Video Export Options'}
        </h3>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded-md text-surface-500 hover:text-surface-200 hover:bg-white/6 transition-colors"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* GIF panel */}
      {isGif && (
        <div className="space-y-3">
          <Row label="Frame rate">
            <NumberInput
              value={gif.fps}
              onChange={(v) => onGifChange({ ...gif, fps: Math.max(1, Math.min(60, Math.round(v))) })}
              min={1}
              max={60}
              step={1}
              unit="fps"
            />
          </Row>
          <Row label="Width" hint="Height auto-scaled to preserve aspect.">
            <NumberInput
              value={gif.width}
              onChange={(v) => onGifChange({ ...gif, width: Math.max(64, Math.min(1920, Math.round(v))) })}
              min={64}
              max={1920}
              step={10}
              unit="px"
            />
          </Row>
          <Row label="Loop">
            <Select
              value={String(gif.loopCount)}
              onChange={(v) => onGifChange({ ...gif, loopCount: parseInt(v, 10) })}
              options={LOOP_OPTIONS}
              compact
            />
          </Row>
          <Row label="Dither" hint="Sierra gives smoothest gradients.">
            <Select
              value={gif.dither}
              onChange={(v) => onGifChange({ ...gif, dither: v as GifOptions['dither'] })}
              options={DITHER_OPTIONS}
              compact
            />
          </Row>
          {gif.dither === 'bayer' && (
            <Row label="Bayer scale" hint="Lower = more dithering (1–5).">
              <NumberInput
                value={gif.bayerScale}
                onChange={(v) => onGifChange({ ...gif, bayerScale: Math.max(1, Math.min(5, Math.round(v))) })}
                min={1}
                max={5}
                step={1}
              />
            </Row>
          )}
          <Row label="Optimized palette" hint="Two-pass palettegen → paletteuse. Higher quality, ~30% slower.">
            <Toggle
              checked={gif.highQuality}
              onChange={(v) => onGifChange({ ...gif, highQuality: v })}
            />
          </Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Reverse">
              <Toggle
                checked={gif.reverse}
                onChange={(v) => onGifChange({ ...gif, reverse: v })}
              />
            </Row>
            <Row label="Boomerang" hint="Forward then reversed.">
              <Toggle
                checked={gif.boomerang}
                onChange={(v) => onGifChange({ ...gif, boomerang: v })}
              />
            </Row>
          </div>
        </div>
      )}

      {/* Video panel */}
      {isVideo && (
        <div className="space-y-3">
          <Row label="Codec">
            <Select
              value={video.codec}
              onChange={(v) => onVideoChange({ ...video, codec: v })}
              options={VIDEO_CODECS}
              compact
            />
          </Row>
          <Row label="CRF" hint="Lower = higher quality. 18–24 typical.">
            <NumberInput
              value={video.crf}
              onChange={(v) => onVideoChange({ ...video, crf: Math.max(0, Math.min(51, Math.round(v))) })}
              min={0}
              max={51}
              step={1}
            />
          </Row>
          <Row label="Encoder speed" hint="Slower = better compression at the same CRF.">
            <Select
              value={video.preset}
              onChange={(v) => onVideoChange({ ...video, preset: v })}
              options={PRESETS}
              compact
            />
          </Row>
          <Row label="Max height">
            <Select
              value={String(video.maxHeight)}
              onChange={(v) => onVideoChange({ ...video, maxHeight: parseInt(v, 10) })}
              options={HEIGHT_CAPS}
              compact
            />
          </Row>
          <Row label="Audio bitrate">
            <Select
              value={video.audioBitrate}
              onChange={(v) => onVideoChange({ ...video, audioBitrate: v })}
              options={AUDIO_BITRATES}
              compact
            />
          </Row>
        </div>
      )}

      {/* Audio panel - minimal for now */}
      {isAudio && (
        <div className="space-y-3">
          <Row label="Audio bitrate" hint="Ignored for WAV (uncompressed PCM).">
            <Select
              value={video.audioBitrate}
              onChange={(v) => onVideoChange({ ...video, audioBitrate: v })}
              options={AUDIO_BITRATES}
              compact
            />
          </Row>
          <p className="text-2xs text-surface-500 leading-relaxed pt-1">
            For lossless audio, switch the export format to <span className="text-surface-300">WAV</span>.
            For best size/quality use <span className="text-surface-300">MP3 256k</span> or higher.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-surface-200">{label}</p>
        {hint && <p className="text-2xs text-surface-500 mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
