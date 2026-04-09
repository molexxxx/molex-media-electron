/** @module editor/clip/ClipPreview - Video/audio preview with letterboxing. */
import React, { useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTimecode } from '../shared/TimeDisplay'
import { Waveform } from '../shared/Waveform'
import type { MediaSource } from '../types'

interface ClipPreviewProps {
  source: MediaSource
  mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>
  mediaUrl: string
}

export function ClipPreview({ source, mediaRef, mediaUrl }: ClipPreviewProps): React.JSX.Element {
  const currentFrame = useEditorStore((s) => s.playback.currentFrame)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const [showTimecode, setShowTimecode] = useState(true)

  const isVideo = source.width > 0 && source.height > 0
  const isAudioOnly = !isVideo
  const waveContainerRef = useRef<HTMLDivElement>(null)
  const [waveSize, setWaveSize] = useState<{ w: number; h: number } | null>(null)

  // Track waveform container size for responsive rendering
  useEffect(() => {
    const el = waveContainerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWaveSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [isAudioOnly])

  // Sync video element when URL changes
  useEffect(() => {
    const el = mediaRef.current
    if (el && mediaUrl) {
      ;(el as HTMLVideoElement).src = mediaUrl
      el.load()
    }
  }, [mediaUrl, mediaRef])

  return (
    <div className="relative flex items-center justify-center h-full bg-black/40 rounded-lg overflow-hidden">
      {isVideo ? (
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          className="max-w-full max-h-full object-contain"
          preload="auto"
          playsInline
        />
      ) : (
        <>
          <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} preload="auto" />
          <div ref={waveContainerRef} className="flex flex-col items-center justify-center gap-3 text-surface-400 w-full h-full px-8">
            {/* Live waveform visualization */}
            {waveSize && waveSize.w > 40 && (
              <div className="relative w-full" style={{ height: Math.min(120, waveSize.h * 0.4) }}>
                <Waveform
                  filePath={source.filePath}
                  width={Math.min(waveSize.w - 32, 600)}
                  height={Math.min(120, waveSize.h * 0.4)}
                  color="rgba(124, 58, 237, 0.6)"
                  className="mx-auto"
                />
                {/* Playhead indicator on waveform */}
                {source.duration > 0 && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none"
                    style={{ left: `${(currentFrame / source.duration) * 100}%` }}
                  />
                )}
              </div>
            )}
            <p className="text-sm font-medium">{source.fileName}</p>
            <p className="text-xs text-surface-500">
              {source.codec} · {source.audioChannels}ch · {source.audioSampleRate}Hz
            </p>
          </div>
        </>
      )}

      {/* Timecode overlay */}
      {showTimecode && (
        <button
          onClick={() => setShowTimecode(false)}
          className="absolute top-2 right-2 bg-black/70 text-surface-200 font-mono text-xs px-2 py-0.5 rounded tabular-nums"
        >
          {formatTimecode(currentFrame, frameRate)}
        </button>
      )}

      {/* Audio-only: show timecode when overlay is hidden */}
      {isAudioOnly && !showTimecode && (
        <button
          onClick={() => setShowTimecode(true)}
          className="absolute top-2 right-2 text-surface-500 hover:text-surface-300 text-xs"
        >
          TC
        </button>
      )}
    </div>
  )
}
