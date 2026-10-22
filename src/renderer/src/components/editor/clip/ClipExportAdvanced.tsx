/**
 * @module editor/clip/ClipExportAdvanced
 * Trim's export settings: the formats, the quality presets, the GIF and video options, and the options object
 * the export sends. The GIF and video options mirror the Batch encoder depth, so a precise GIF or a set CRF
 * never needs another page.
 */
import { useId, type ReactElement } from 'react'
import type { CutOptions } from '../../../../../shared/ipc/api'
import { NumberField } from '../../../ui/NumberField'
import { Select, type SelectOption } from '../../../ui/Select'
import { EditorField, SwitchRow } from '../shared/Field'

export type ExportFormat = 'mp4' | 'mkv' | 'webm' | 'wav' | 'mp3' | 'gif'

/** The quality presets; `lossless` copies the streams, the others re-encode at their CRF. */
export type ExportQuality = 'lossless' | 'high' | 'medium' | 'low'

export interface GifOptions
{
  fps: number
  width: number
  dither: 'sierra2_4a' | 'bayer' | 'floyd_steinberg' | 'none'
  bayerScale: number
  highQuality: boolean
  /** 0 loops forever, -1 plays once, N repeats N times. */
  loopCount: number
  reverse: boolean
  boomerang: boolean
}

export interface VideoOptions
{
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

/** The CRF each re-encoding preset sets; High is the earlier default of 20, so a default export is unchanged. */
export const QUALITY_CRF: Readonly<Record<Exclude<ExportQuality, 'lossless'>, number>> = { high: 20, medium: 23, low: 28 }

export const FORMAT_OPTIONS: SelectOption[] = [
  { value: 'mp4', label: 'MP4 video' },
  { value: 'mkv', label: 'MKV video' },
  { value: 'webm', label: 'WebM video' },
  { value: 'wav', label: 'WAV audio' },
  { value: 'mp3', label: 'MP3 audio' },
  { value: 'gif', label: 'GIF animation' }
]

const VIDEO_CODECS: SelectOption[] = [
  { value: 'libx264', label: 'H.264 (libx264)' },
  { value: 'libx265', label: 'H.265 (libx265)' },
  { value: 'libvpx-vp9', label: 'VP9 (libvpx-vp9)' },
  { value: 'libaom-av1', label: 'AV1 (libaom-av1)' }
]

const PRESETS: SelectOption[] = [
  { value: 'ultrafast', label: 'Fastest' },
  { value: 'fast', label: 'Fast' },
  { value: 'medium', label: 'Balanced' },
  { value: 'slow', label: 'Slow' },
  { value: 'veryslow', label: 'Slowest' }
]

const HEIGHT_CAPS: SelectOption[] = [
  { value: '0', label: 'Same as source' },
  { value: '2160', label: '2160p (4K)' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' }
]

const AUDIO_BITRATES: SelectOption[] = [
  { value: '320k', label: '320 kbps' },
  { value: '256k', label: '256 kbps' },
  { value: '192k', label: '192 kbps' },
  { value: '128k', label: '128 kbps' },
  { value: '96k', label: '96 kbps' }
]

const DITHER_OPTIONS: SelectOption[] = [
  { value: 'sierra2_4a', label: 'Sierra, smoothest gradients' },
  { value: 'floyd_steinberg', label: 'Floyd-Steinberg' },
  { value: 'bayer', label: 'Bayer, ordered pattern' },
  { value: 'none', label: 'None, flat bands' }
]

const LOOP_OPTIONS: SelectOption[] = [
  { value: '0', label: 'Loop forever' },
  { value: '-1', label: 'Play once' },
  { value: '1', label: 'Repeat once' },
  { value: '3', label: 'Repeat 3 times' },
  { value: '5', label: 'Repeat 5 times' }
]

/** The family a format belongs to, which picks its fields. */
export function formatKind(format: ExportFormat): 'video' | 'audio' | 'gif'
{
  if (format === 'gif')
  {
    return 'gif'
  }
  return format === 'wav' || format === 'mp3' ? 'audio' : 'video'
}

/** The quality preset a CRF matches, or null for a custom CRF. */
export function qualityForCrf(crf: number): Exclude<ExportQuality, 'lossless'> | null
{
  const match = (Object.keys(QUALITY_CRF) as Array<keyof typeof QUALITY_CRF>).find((key) => QUALITY_CRF[key] === crf)
  return match ?? null
}

/** The Quality choices; a CRF set by hand adds a Custom choice that names it. */
export function qualityOptions(lossless: boolean, crf: number): SelectOption[]
{
  const options: SelectOption[] = [
    { value: 'lossless', label: 'Lossless, fastest' },
    { value: 'high', label: `High (CRF ${QUALITY_CRF.high})` },
    { value: 'medium', label: `Medium (CRF ${QUALITY_CRF.medium})` },
    { value: 'low', label: `Low (CRF ${QUALITY_CRF.low})` }
  ]
  if (!lossless && qualityForCrf(crf) === null)
  {
    options.push({ value: 'custom', label: `Custom (CRF ${crf})` })
  }
  return options
}

/** The options the trim export sends for these settings. */
export function buildCutOptions(format: ExportFormat, lossless: boolean, gif: GifOptions, video: VideoOptions): CutOptions
{
  const mode = lossless ? 'fast' : 'precise'
  const kind = formatKind(format)
  if (kind === 'gif')
  {
    return {
      mode,
      outputFormat: format,
      gifOptions: {
        fps: gif.fps,
        width: gif.width,
        loopCount: gif.loopCount,
        dither: gif.dither,
        bayerScale: gif.bayerScale,
        highQuality: gif.highQuality,
        reverse: gif.reverse,
        boomerang: gif.boomerang
      }
    }
  }
  if (kind === 'video')
  {
    return {
      mode,
      outputFormat: format,
      videoOptions: {
        codec: video.codec,
        crf: video.crf,
        preset: video.preset,
        maxHeight: video.maxHeight,
        audioBitrate: video.audioBitrate
      }
    }
  }
  return { mode, outputFormat: format }
}

/** Props of the GIF fields. */
export interface GifFieldsProps
{
  gif: GifOptions
  onChange: (next: GifOptions) => void
}

/** The GIF fields everyone sets: frame rate, width, and looping. */
export function GifFields({ gif, onChange }: GifFieldsProps): ReactElement
{
  const ids = { fps: useId(), width: useId(), loop: useId() }
  return (
    <>
      <EditorField label="Frame rate" htmlFor={ids.fps}>
        <NumberField id={ids.fps} value={gif.fps} min={1} max={60} step={1} unit="fps" onCommit={(fps) => onChange({ ...gif, fps })} />
      </EditorField>
      <EditorField label="Width" htmlFor={ids.width} note="The height follows the source's shape.">
        <NumberField id={ids.width} value={gif.width} min={64} max={1920} step={10} unit="px" onCommit={(width) => onChange({ ...gif, width })} />
      </EditorField>
      <EditorField label="Looping" htmlFor={ids.loop}>
        <Select id={ids.loop} value={String(gif.loopCount)} options={LOOP_OPTIONS} onChange={(value) => onChange({ ...gif, loopCount: parseInt(value, 10) })} className="w-full" />
      </EditorField>
    </>
  )
}

/** The GIF fields most exports leave alone. */
export function GifMoreFields({ gif, onChange }: GifFieldsProps): ReactElement
{
  const ids = { dither: useId(), bayer: useId() }
  return (
    <>
      <EditorField label="Dither" htmlFor={ids.dither}>
        <Select id={ids.dither} value={gif.dither} options={DITHER_OPTIONS} onChange={(value) => onChange({ ...gif, dither: value as GifOptions['dither'] })} className="w-full" />
      </EditorField>
      {gif.dither === 'bayer' && (
        <EditorField label="Bayer scale" htmlFor={ids.bayer} note="Lower values dither more, from 1 to 5.">
          <NumberField id={ids.bayer} value={gif.bayerScale} min={1} max={5} step={1} onCommit={(bayerScale) => onChange({ ...gif, bayerScale })} />
        </EditorField>
      )}
      <SwitchRow
        label="Optimized palette"
        note="Builds a palette from the clip first. Better color, about 30% slower."
        checked={gif.highQuality}
        onChange={(highQuality) => onChange({ ...gif, highQuality })}
      />
      <SwitchRow label="Reverse" checked={gif.reverse} onChange={(reverse) => onChange({ ...gif, reverse })} />
      <SwitchRow label="Boomerang" note="Plays forward, then backward." checked={gif.boomerang} onChange={(boomerang) => onChange({ ...gif, boomerang })} />
    </>
  )
}

/** Props of the video fields. */
export interface VideoFieldsProps
{
  video: VideoOptions
  onChange: (next: VideoOptions) => void
}

/** The video fields behind More settings: codec, CRF, encoder speed, height, and audio bit rate. */
export function VideoMoreFields({ video, onChange }: VideoFieldsProps): ReactElement
{
  const ids = { codec: useId(), crf: useId(), preset: useId(), height: useId(), audio: useId() }
  return (
    <>
      <EditorField label="Video codec" htmlFor={ids.codec}>
        <Select id={ids.codec} value={video.codec} options={VIDEO_CODECS} onChange={(codec) => onChange({ ...video, codec })} className="w-full" />
      </EditorField>
      <EditorField label="CRF" htmlFor={ids.crf} note="Lower is sharper and larger. 18 to 24 suits most video.">
        <NumberField id={ids.crf} value={video.crf} min={0} max={51} step={1} onCommit={(crf) => onChange({ ...video, crf })} />
      </EditorField>
      <EditorField label="Encoder speed" htmlFor={ids.preset} note="Slower makes smaller files at the same CRF.">
        <Select id={ids.preset} value={video.preset} options={PRESETS} onChange={(preset) => onChange({ ...video, preset })} className="w-full" />
      </EditorField>
      <EditorField label="Largest height" htmlFor={ids.height}>
        <Select id={ids.height} value={String(video.maxHeight)} options={HEIGHT_CAPS} onChange={(value) => onChange({ ...video, maxHeight: parseInt(value, 10) })} className="w-full" />
      </EditorField>
      <EditorField label="Audio bit rate" htmlFor={ids.audio}>
        <Select id={ids.audio} value={video.audioBitrate} options={AUDIO_BITRATES} onChange={(audioBitrate) => onChange({ ...video, audioBitrate })} className="w-full" />
      </EditorField>
    </>
  )
}
