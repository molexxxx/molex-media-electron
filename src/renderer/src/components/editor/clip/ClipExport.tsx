/** @module editor/clip/ClipExport - Export controls for Clip mode. */
import React, { useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { framesToSeconds, formatTimecode } from '../shared/TimeDisplay'
import { Select } from '../../shared/ui'
import { EncoderBadge } from '../../shared/EncoderBadge'
import type { MediaSource } from '../types'
import {
  ClipExportAdvanced,
  DEFAULT_GIF,
  DEFAULT_VIDEO,
  type ExportFormat,
  type GifOptions,
  type VideoOptions
} from './ClipExportAdvanced'

type ExportQuality = 'low' | 'medium' | 'high' | 'lossless'

const FORMAT_OPTIONS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'webm', label: 'WebM' },
  { value: 'wav', label: 'WAV' },
  { value: 'mp3', label: 'MP3' },
  { value: 'gif', label: 'GIF' }
]

const QUALITY_OPTIONS = [
  { value: 'lossless', label: 'Lossless (fast)' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]

interface ClipExportProps {
  source: MediaSource
}

export function ClipExport({ source }: ClipExportProps): React.JSX.Element {
  const inPoint = useEditorStore((s) => s.clipMode.inPoint)
  const outPoint = useEditorStore((s) => s.clipMode.outPoint)
  const frameRate = useEditorStore((s) => s.project.frameRate)

  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [gifOpts, setGifOpts] = useState<GifOptions>(DEFAULT_GIF)
  const [videoOpts, setVideoOpts] = useState<VideoOptions>(DEFAULT_VIDEO)

  const duration = outPoint - inPoint
  const durationText = formatTimecode(duration, frameRate)

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    setError(null)
    setProgress(0)
    setLastOutput(null)

    const cleanup = window.api.onEditorProgress(({ percent }) => {
      setProgress(percent)
    })

    try {
      const inSec = framesToSeconds(inPoint, frameRate)
      const outSec = framesToSeconds(outPoint, frameRate)
      const mode = quality === 'lossless' ? 'fast' : 'precise'

      const result = await window.api.cutMedia(source.filePath, inSec, outSec, {
        mode,
        outputFormat: format,
        ...(format === 'gif'
          ? {
              gifOptions: {
                fps: gifOpts.fps,
                width: gifOpts.width,
                loopCount: gifOpts.loopCount,
                dither: gifOpts.dither,
                bayerScale: gifOpts.bayerScale,
                highQuality: gifOpts.highQuality,
                reverse: gifOpts.reverse,
                boomerang: gifOpts.boomerang
              }
            }
          : format === 'mp4' || format === 'mkv' || format === 'webm'
            ? {
                videoOptions: {
                  codec: videoOpts.codec,
                  crf: videoOpts.crf,
                  preset: videoOpts.preset,
                  maxHeight: videoOpts.maxHeight,
                  audioBitrate: videoOpts.audioBitrate
                }
              }
            : {})
      })

      if (result?.success && result.outputPath) {
        setLastOutput(result.outputPath)
      } else {
        setError(result?.error || 'Export failed')
      }
    } catch (err: any) {
      setError(err?.message || 'Export failed')
    } finally {
      cleanup()
      setExporting(false)
      setProgress(0)
    }
  }

  const handleSendToEdit = (): void => {
    // Find the first video track
    const { timeline, addClip, setMode } = useEditorStore.getState()
    const videoTrack = timeline.tracks.find((t) => t.type === 'video')
    if (!videoTrack) return

    addClip({
      sourceId: source.id,
      trackId: videoTrack.id,
      timelineStart: timeline.duration,
      sourceIn: inPoint,
      sourceOut: outPoint,
      name: source.fileName,
      color: '#7c3aed',
      muted: false,
      locked: false,
      volume: 1,
      pan: 0,
      speed: 1
    })
    setMode('edit')
  }

  const showInFolder = (path: string): void => {
    window.api.showInFolder(path)
  }

  return (
    <div className="relative flex items-center gap-3 px-3 py-2 border-t border-white/5 text-xs">
      {/* Duration */}
      <span className="text-surface-400 font-mono tabular-nums">
        Duration: {durationText}
      </span>

      <div className="w-px h-4 bg-white/10" />

      {/* Format selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-surface-500 text-2xs font-medium">Format</span>
        <Select
          value={format}
          onChange={(v) => setFormat(v as ExportFormat)}
          options={FORMAT_OPTIONS}
          compact
        />
      </div>

      {/* Quality selector - hidden when GIF (uses its own controls) */}
      {format !== 'gif' && (
        <div className="flex items-center gap-1.5">
          <span className="text-surface-500 text-2xs font-medium">Quality</span>
          <Select
            value={quality}
            onChange={(v) => setQuality(v as ExportQuality)}
            options={QUALITY_OPTIONS}
            compact
          />
        </div>
      )}

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        title="Advanced export options"
        className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-2xs font-medium transition-colors ${
          showAdvanced
            ? 'bg-accent-500/15 border-accent-500/30 text-accent-200'
            : 'bg-white/4 border-white/8 text-surface-300 hover:text-surface-100 hover:border-white/15'
        }`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        Advanced
      </button>

      <EncoderBadge />

      <div className="flex-1" />

      {/* Progress bar */}
      {exporting && (
        <div className="w-32 h-1.5 bg-surface-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent-500 transition-all duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Error message */}
      {error && <span className="text-red-400 truncate max-w-48">{error}</span>}

      {/* Output path */}
      {lastOutput && (
        <button
          onClick={() => showInFolder(lastOutput)}
          className="text-accent-300 hover:text-accent-200 transition-colors truncate max-w-48"
          title={lastOutput}
        >
          Show in folder
        </button>
      )}

      {/* Send to Edit */}
      <button
        onClick={handleSendToEdit}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/4 border border-white/6 hover:border-white/12 text-surface-300 hover:text-surface-100 transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
        Edit Mode
      </button>

      {/* Export button */}
      <button
        onClick={handleExport}
        disabled={exporting || duration <= 0}
        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 hover:text-accent-200 border border-accent-500/20 hover:border-accent-500/30 disabled:opacity-40 disabled:pointer-events-none font-medium transition-colors"
      >
        {exporting ? (
          <>
            <div className="w-3 h-3 border-[1.5px] border-accent-400 border-t-transparent rounded-full animate-spin" />
            Exporting…
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export
          </>
        )}
      </button>

      {/* Advanced popover */}
      {showAdvanced && (
        <ClipExportAdvanced
          format={format}
          gif={gifOpts}
          video={videoOpts}
          onGifChange={setGifOpts}
          onVideoChange={setVideoOpts}
          onClose={() => setShowAdvanced(false)}
        />
      )}
    </div>
  )
}
