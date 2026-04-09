/** @module editor/clip/ClipExport - Export controls for Clip mode. */
import React, { useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { framesToSeconds, formatTimecode } from '../shared/TimeDisplay'
import { Select } from '../../shared/ui'
import { EncoderBadge } from '../../shared/EncoderBadge'
import type { MediaSource } from '../types'

type ExportFormat = 'mp4' | 'mkv' | 'webm' | 'wav' | 'mp3' | 'gif'
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
        ...(format === 'gif' ? { gifOptions: { loop: true, fps: 15, width: 480 } } : {})
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
    <div className="flex items-center gap-3 px-3 py-2 border-t border-white/5 text-xs">
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

      {/* Quality selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-surface-500 text-2xs font-medium">Quality</span>
        <Select
          value={quality}
          onChange={(v) => setQuality(v as ExportQuality)}
          options={QUALITY_OPTIONS}
          compact
        />
      </div>

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
    </div>
  )
}
