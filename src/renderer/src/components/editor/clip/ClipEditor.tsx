/**
 * @module editor/clip/ClipEditor
 * Top-level Clip mode container.
 *
 * Layout: file drop zone / preview + transport bar + timeline + export.
 * Loads source media, wires up the playback hook and keyboard shortcuts.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { useEditorPlayback } from '../hooks/useEditorPlayback'
import { ClipPreview } from './ClipPreview'
import { ClipTimeline } from './ClipTimeline'
import { ClipExport } from './ClipExport'
import { TimeDisplay } from '../shared/TimeDisplay'
import type { MediaSource } from '../types'

/** Parse FFprobe frame rate strings like "30000/1001" or "30". */
function parseFrameRate(str: string): number {
  const parts = str.split('/')
  if (parts.length === 2) {
    const num = parseFloat(parts[0])
    const den = parseFloat(parts[1])
    return den > 0 ? num / den : 0
  }
  return parseFloat(str) || 0
}

export function ClipEditor(): React.JSX.Element {
  const sources = useEditorStore((s) => s.sources)
  const clipMode = useEditorStore((s) => s.clipMode)
  const playback = useEditorStore((s) => s.playback)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const addSource = useEditorStore((s) => s.addSource)
  const setClipSource = useEditorStore((s) => s.setClipSource)
  const setClipInPoint = useEditorStore((s) => s.setClipInPoint)
  const setClipOutPoint = useEditorStore((s) => s.setClipOutPoint)
  const resetEditor = useEditorStore((s) => s.resetEditor)

  const [mediaUrl, setMediaUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Active source
  const source: MediaSource | undefined = sources.find((s) => s.id === clipMode.sourceId)
  const totalFrames = source?.duration ?? 0

  const { mediaRef, togglePlayback, seekToFrame, stepFrames, handleJKL } =
    useEditorPlayback({ frameRate, totalFrames })

  // Load a file into Clip mode
  const loadFile = useCallback(
    async (filePath: string) => {
      setLoading(true)
      try {
        // Probe the file for metadata
        const probeResult = await window.api.probeDetailed(filePath)
        if (!probeResult?.success || !probeResult.data) {
          setLoading(false)
          return
        }

        const info = probeResult.data
        const video = info.videoStreams?.[0]
        const audio = info.audioStreams?.[0]
        const durationSec = parseFloat(info.format?.duration || '0')
        const fps = video?.r_frame_rate
          ? parseFrameRate(video.r_frame_rate) || frameRate
          : frameRate
        const totalFrames = Math.round(durationSec * fps)

        const newSource: MediaSource = {
          id: `src-${Date.now().toString(36)}`,
          filePath,
          fileName: filePath.split(/[\\/]/).pop() || filePath,
          duration: totalFrames,
          frameRate: fps,
          width: video?.width ?? 0,
          height: video?.height ?? 0,
          audioChannels: audio?.channels ?? 0,
          audioSampleRate: parseInt(audio?.sample_rate || '0', 10),
          codec: video?.codec_name || audio?.codec_name || 'unknown',
          format: info.format?.format_name || 'unknown',
          fileSize: parseInt(info.format?.size || '0', 10),
          durationSeconds: durationSec
        }

        addSource(newSource)
        setClipSource(newSource.id, totalFrames)

        // Register raw file for media:// streaming (preserves video track)
        const previewResult = await window.api.createPreview(filePath)
        if (previewResult?.success && previewResult.data) {
          setMediaUrl(previewResult.data)
        }
      } catch (err) {
        console.error('Failed to load file:', err)
      } finally {
        setLoading(false)
      }
    },
    [frameRate, addSource, setClipSource]
  )

  // Handle file open via dialog
  const openFile = useCallback(async () => {
    const files = await window.api.openFiles()
    if (files?.length > 0) loadFile(files[0])
  }, [loadFile])

  // Close file and reset editor
  const closeFile = useCallback(() => {
    const el = mediaRef.current
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    setMediaUrl('')
    resetEditor()
  }, [mediaRef, resetEditor])

  // Drop handler
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        const filePath = window.api.getFilePath(files[0])
        if (filePath) loadFile(filePath)
      }
    },
    [loadFile]
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onKeyDown = (e: KeyboardEvent): void => {
      // Don't capture when focused on input elements
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      const key = e.key.toLowerCase()

      switch (key) {
        case ' ':
          e.preventDefault()
          togglePlayback()
          break
        case 'i':
          e.preventDefault()
          setClipInPoint(playback.currentFrame)
          break
        case 'o':
          e.preventDefault()
          setClipOutPoint(playback.currentFrame)
          break
        case 'arrowleft':
          e.preventDefault()
          stepFrames(e.shiftKey ? -10 : -1)
          break
        case 'arrowright':
          e.preventDefault()
          stepFrames(e.shiftKey ? 10 : 1)
          break
        case 'home':
          e.preventDefault()
          seekToFrame(0)
          break
        case 'end':
          e.preventDefault()
          seekToFrame(totalFrames)
          break
        case 'j':
          e.preventDefault()
          handleJKL('j')
          break
        case 'k':
          e.preventDefault()
          handleJKL('k')
          break
        case 'l':
          e.preventDefault()
          handleJKL('l')
          break
        case 'escape':
          e.preventDefault()
          if (source) {
            setClipInPoint(0)
            setClipOutPoint(totalFrames)
          }
          break
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            if (e.shiftKey) {
              useEditorStore.getState().redo()
            } else {
              useEditorStore.getState().undo()
            }
          }
          break
      }
    }

    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [togglePlayback, stepFrames, seekToFrame, handleJKL, setClipInPoint, setClipOutPoint, playback.currentFrame, totalFrames, source])

  // No source loaded - show drop zone
  if (!source) {
    return (
      <div
        ref={containerRef}
        tabIndex={0}
        className="flex flex-col items-center justify-center h-full text-surface-400 outline-none"
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        {loading ? (
          <div className="text-center animate-fade-in">
            <div className="w-12 h-12 border-2 border-accent-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm font-medium text-surface-300">Loading media...</p>
            <p className="text-xs text-surface-500 mt-1">Probing file metadata</p>
          </div>
        ) : (
          <div className="text-center animate-fade-in">
            <div className="w-20 h-20 mx-auto mb-5 rounded-2xl bg-surface-800/60 border border-white/5 flex items-center justify-center">
              <svg
                className="w-10 h-10 text-surface-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
              </svg>
            </div>
            <p className="text-lg font-medium mb-1 text-surface-300">Drop a file to start</p>
            <p className="text-sm text-surface-500 mb-5">or click below to browse</p>
            <button
              onClick={openFile}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 hover:text-accent-200 border border-accent-500/20 hover:border-accent-500/30 text-sm font-medium transition-all hover:shadow-glow min-h-[44px]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Open File
            </button>
          </div>
        )}
      </div>
    )
  }

  // Source loaded - full Clip mode UI
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="flex flex-col h-full outline-none"
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {/* Preview with close button */}
      <div className="relative flex-1 min-h-0">
        <ClipPreview source={source} mediaRef={mediaRef} mediaUrl={mediaUrl} />
        <button
          onClick={closeFile}
          title="Close file"
          className="absolute top-2 left-2 z-10 flex items-center justify-center w-7 h-7 rounded-lg bg-surface-800/80 hover:bg-surface-700 text-surface-400 hover:text-surface-200 border border-white/5 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Transport bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/5">
        <TimeDisplay frame={clipMode.inPoint} frameRate={frameRate} label="IN" className="text-accent-300" />

        <div className="flex items-center gap-1">
          {/* Jump to in */}
          <TransportButton
            title="Jump to In (Home)"
            onClick={() => seekToFrame(clipMode.inPoint)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
          </TransportButton>

          {/* Step back */}
          <TransportButton
            title="Step back (←)"
            onClick={() => stepFrames(-1)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm12 0l-8.5 6 8.5 6z" /></svg>
          </TransportButton>

          {/* Play / Pause */}
          <TransportButton
            title="Play/Pause (Space)"
            onClick={togglePlayback}
            active={playback.isPlaying}
            className="w-8 h-8"
          >
            {playback.isPlaying ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </TransportButton>

          {/* Step forward */}
          <TransportButton
            title="Step forward (→)"
            onClick={() => stepFrames(1)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
          </TransportButton>

          {/* Jump to out */}
          <TransportButton
            title="Jump to Out (End)"
            onClick={() => seekToFrame(clipMode.outPoint)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
          </TransportButton>
        </div>

        <TimeDisplay frame={clipMode.outPoint} frameRate={frameRate} label="OUT" className="text-accent-300" />
      </div>

      {/* Timeline scrub bar */}
      <ClipTimeline totalFrames={totalFrames} seekToFrame={seekToFrame} source={source} />

      {/* Export footer */}
      <ClipExport source={source} />
    </div>
  )
}

/** Small transport button component - matches app ghost-button pattern with touch targets. */
function TransportButton({
  children,
  onClick,
  title,
  active,
  className = ''
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center justify-center w-8 h-8 sm:w-7 sm:h-7 rounded-lg border transition-colors min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 ${
        active
          ? 'bg-accent-500/15 text-accent-300 border-accent-500/20'
          : 'text-surface-400 hover:text-surface-100 hover:bg-white/6 border-transparent hover:border-white/6'
      } ${className}`}
    >
      {children}
    </button>
  )
}
