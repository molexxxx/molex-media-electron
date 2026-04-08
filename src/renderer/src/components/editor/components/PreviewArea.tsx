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
  a2AudioRef: React.RefObject<HTMLAudioElement | null>
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  onLoadFile: (file: File) => void
}

export function PreviewArea({ clip, videoRef, audioRef, a2AudioRef, canvasRef, onLoadFile }: PreviewAreaProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragCounter = useRef(0)
  const loadingCount = useEditorStore((s) => s.loadingCount())
  const isClipLoading = clip ? clip.loadingState !== 'ready' && clip.loadingState !== 'error' : false

  return (
    <div
      className={`${clip ? 'flex-1 min-h-50 sm:min-h-70' : 'h-64'} relative rounded-2xl overflow-hidden transition-all duration-300 ${
        dragging
          ? 'border border-accent-400 bg-accent-500/[0.04]'
          : 'border border-dashed border-white/[0.06] bg-white/[0.02]'
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
        <>
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain bg-black" playsInline preload="auto" muted={false} />
          <div className="vignette absolute inset-0 pointer-events-none" />
        </>
      )}
      {clip && !clip.isVideo && clip.loadingState === 'ready' && (
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      )}
      {!clip && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center px-4">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.03] flex items-center justify-center border border-white/[0.04]">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-surface-500">
                <path d="M15.6 11.6L22 7v10l-6.4-4.6" />
                <rect x="2" y="6" width="14" height="12" rx="2" />
              </svg>
            </div>
            <p className="text-surface-400 text-sm font-medium">Drop media files here</p>
            <p className="text-surface-600 text-2xs mt-1.5">or use <span className="text-accent-400/80">+ Add</span> above</p>
          </div>
        </div>
      )}
      {dragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-500/[0.06] backdrop-blur-sm z-10">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full border-2 border-dashed border-accent-400/60 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-300"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <p className="text-accent-300 font-semibold">Drop to add</p>
          </div>
        </div>
      )}
      {isClipLoading && !dragging && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-950/80 backdrop-blur z-10">
          <div className="text-center">
            <div className="w-10 h-10 border-2 border-accent-500/20 border-t-accent-400 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-surface-200 text-sm font-medium">
              {clip!.loadingState === 'probing' ? 'Analyzing file…' : 'Preparing preview…'}
            </p>
            <p className="text-surface-500 text-2xs mt-1.5">
              {clip!.loadingState === 'probing' ? 'Reading media info' : 'Transcoding for playback'}
            </p>
            {loadingCount > 1 && (
              <p className="text-accent-400/60 text-2xs mt-3 font-mono">{loadingCount} files in queue</p>
            )}
          </div>
        </div>
      )}
      {clip?.loadingState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-950/80 z-10">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-red-500/10 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red-400">
                <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
            </div>
            <p className="text-red-300 text-sm font-medium">Failed to load file</p>
            <p className="text-surface-500 text-2xs mt-1">Unsupported format or corrupted file</p>
          </div>
        </div>
      )}
      <audio ref={audioRef} className="hidden" />
      <audio ref={a2AudioRef} className="hidden" />
    </div>
  )
}
