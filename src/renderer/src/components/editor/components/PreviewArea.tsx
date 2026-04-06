/**
 * @module components/editor/PreviewArea
 * @description Video/audio preview pane with drag-and-drop file loading and audio-only canvas waveform.
 */

import React, { useRef, useState } from 'react'
import type { Clip } from '../types'

interface PreviewAreaProps {
  clip: Clip | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  audioRef: React.RefObject<HTMLAudioElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  onLoadFile: (file: File) => void
}

export function PreviewArea({ clip, videoRef, audioRef, canvasRef, onLoadFile }: PreviewAreaProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)

  return (
    <div
      className={`flex-1 relative rounded-2xl overflow-hidden border transition-colors ${
        dragging ? 'border-accent-400 bg-accent-500/5' : 'border-white/5 bg-surface-900/50'
      }`}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setDragging(true) }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
      onDragLeave={(e) => { e.stopPropagation(); dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setDragging(false) } }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dragCounter.current = 0
        setDragging(false)
        for (const file of Array.from(e.dataTransfer.files)) onLoadFile(file)
      }}
    >
      {clip && clip.isVideo && (
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain bg-black" playsInline preload="auto" muted={false} />
      )}
      {clip && !clip.isVideo && (
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      )}
      {!clip && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3">
              <path d="M15.6 11.6L22 7v10l-6.4-4.6" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
            <p className="text-surface-500 text-sm">Drop media files here to begin</p>
          </div>
        </div>
      )}
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm z-10">
          <p className="text-accent-300 font-semibold text-lg">Drop to add</p>
        </div>
      )}
      <audio ref={audioRef} className="hidden" />
    </div>
  )
}
