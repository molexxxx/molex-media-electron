/**
 * @module components/editor/PreviewArea
 * @description Video/audio preview pane with drag-and-drop file loading,
 * audio-only canvas waveform, and per-clip loading overlay.
 * Responsive: scales naturally with flex container.
 */

import React, { useRef, useState } from 'react'
import { useEditorStore, type EditorClip } from '../../../stores/editorStore'

interface PreviewAreaProps {
  clip: EditorClip | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  audioRef: React.RefObject<HTMLAudioElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  onLoadFile: (file: File) => void
}

export function PreviewArea({ clip, videoRef, audioRef, canvasRef, onLoadFile }: PreviewAreaProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)
  const loadingCount = useEditorStore((s) => s.loadingCount())
  const isClipLoading = clip ? clip.loadingState !== 'ready' && clip.loadingState !== 'error' : false

  return (
    <div
      className={`flex-1 relative rounded-2xl overflow-hidden border transition-colors min-h-50 sm:min-h-70 ${
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
      {clip && clip.isVideo && clip.loadingState === 'ready' && (
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain bg-black" playsInline preload="auto" muted={false} />
      )}
      {clip && !clip.isVideo && clip.loadingState === 'ready' && (
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      )}
      {!clip && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-4">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3">
              <path d="M15.6 11.6L22 7v10l-6.4-4.6" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </svg>
            <p className="text-surface-500 text-sm">Drop media files here to begin</p>
            <p className="text-surface-600 text-2xs mt-1">or use the Add button above</p>
          </div>
        </div>
      )}
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-500/10 backdrop-blur-sm z-10">
          <p className="text-accent-300 font-semibold text-lg">Drop to add</p>
        </div>
      )}
      {isClipLoading && !dragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-900/80 backdrop-blur-sm z-10">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-accent-500/30 border-t-accent-400 rounded-full animate-spin mx-auto mb-3" />
            <p className="text-surface-300 text-sm">
              {clip!.loadingState === 'probing' ? 'Analyzing file…' : 'Preparing preview…'}
            </p>
            <p className="text-surface-500 text-2xs mt-1">
              {clip!.loadingState === 'probing' ? 'Reading media info' : 'Transcoding for playback'}
            </p>
            {loadingCount > 1 && (
              <p className="text-accent-400/70 text-2xs mt-2">{loadingCount} files loading</p>
            )}
          </div>
        </div>
      )}
      {clip?.loadingState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-900/80 z-10">
          <div className="text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-red-400 mb-2">
              <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
            <p className="text-red-300 text-sm">Failed to load file</p>
            <p className="text-surface-500 text-2xs mt-1">Unsupported format or corrupted file</p>
          </div>
        </div>
      )}
      <audio ref={audioRef} className="hidden" />
    </div>
  )
}
