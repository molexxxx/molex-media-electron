/**
 * @module editor/clip/ClipPreview
 * Trim's preview: the video letterboxed on the sunken ground, or for an audio file its waveform with the playhead
 * and a plain line naming the audio.
 */
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatSampleRate } from '../shared/format'
import { Waveform } from '../shared/Waveform'
import type { MediaSource } from '../types'

interface ClipPreviewProps
{
  source: MediaSource
  mediaRef: RefObject<HTMLVideoElement | HTMLAudioElement | null>
  mediaUrl: string
}

/** "MP3 audio · 2 channels · 48 kHz". */
export function audioLine(source: Pick<MediaSource, 'codec' | 'audioChannels' | 'audioSampleRate'>): string
{
  const parts = [`${source.codec.toUpperCase()} audio`]
  if (source.audioChannels > 0)
  {
    parts.push(source.audioChannels === 1 ? '1 channel' : `${source.audioChannels} channels`)
  }
  const rate = formatSampleRate(source.audioSampleRate)
  if (rate)
  {
    parts.push(rate)
  }
  return parts.join(' · ')
}

/** The preview for the active file. */
export function ClipPreview({ source, mediaRef, mediaUrl }: ClipPreviewProps): ReactElement
{
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const isVideo = source.width > 0 && source.height > 0
  const waveRef = useRef<HTMLDivElement>(null)
  const [waveWidth, setWaveWidth] = useState(0)

  useEffect(() =>
  {
    const element = waveRef.current
    if (!element)
    {
      return
    }
    const observer = new ResizeObserver((entries) =>
    {
      setWaveWidth(Math.round(entries[0]?.contentRect.width ?? 0))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [isVideo])

  useEffect(() =>
  {
    const element = mediaRef.current
    if (element && mediaUrl)
    {
      element.src = mediaUrl
      element.load()
    }
  }, [mediaUrl, mediaRef])

  if (isVideo)
  {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          aria-label={`Preview of ${source.fileName}`}
          className="max-h-full max-w-full object-contain"
          preload="auto"
          playsInline
        />
      </div>
    )
  }

  const waveHeight = 120
  const width = Math.min(Math.max(0, waveWidth - 48), 960)
  const playheadLeft = source.duration > 0 ? (currentFrame / source.duration) * width : 0
  return (
    <div ref={waveRef} className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
      <audio ref={mediaRef as RefObject<HTMLAudioElement>} preload="auto" />
      {width > 40 && (
        <div className="relative" style={{ width, height: waveHeight }}>
          <Waveform filePath={source.filePath} width={width} height={waveHeight} />
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-playhead" style={{ left: playheadLeft }} />
        </div>
      )}
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-body text-ink">{source.fileName}</p>
        <p className="text-label text-ink-3">{audioLine(source)}</p>
      </div>
    </div>
  )
}
