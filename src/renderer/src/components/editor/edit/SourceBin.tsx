/**
 * @module editor/edit/SourceBin
 * Imported media browser panel - list of sources with drag-to-timeline.
 */
import React, { useCallback, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import type { MediaSource } from '../types'
import { formatTime } from '../shared/TimeDisplay'
import { setPendingDropSource, clearPendingDropSource } from './Timeline'
import { ThumbnailStrip } from '../shared/ThumbnailStrip'
import { Waveform } from '../shared/Waveform'

export function SourceBin(): React.JSX.Element {
  const sources = useEditorStore((s) => s.sources)
  const addSource = useEditorStore((s) => s.addSource)
  const removeSource = useEditorStore((s) => s.removeSource)
  const selectSource = useEditorStore((s) => s.selectSource)
  const selectedSourceId = useEditorStore((s) => s.selectedSourceId)
  const frameRate = useEditorStore((s) => s.project.frameRate)
  const [importing, setImporting] = useState(false)

  const handleImport = useCallback(async () => {
    setImporting(true)
    try {
      const result = await window.api.openFiles()
      if (!result || !Array.isArray(result)) return

      for (const filePath of result) {
        // Check if already imported
        if (sources.some((s) => s.filePath === filePath)) continue

        const probeResult = await window.api.probeDetailed(filePath)
        if (!probeResult?.success || !probeResult.data) continue

        const info = probeResult.data
        const video = info.videoStreams?.[0]
        const audio = info.audioStreams?.[0]
        const durationSec = parseFloat(info.format?.duration || '0')
        const totalFrames = Math.round(durationSec * frameRate)

        const newSource: MediaSource = {
          id: `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          filePath,
          fileName: filePath.split(/[\\/]/).pop() || filePath,
          duration: totalFrames,
          frameRate,
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
      }
    } catch (err) {
      console.error('Import failed:', err)
    } finally {
      setImporting(false)
    }
  }, [sources, frameRate, addSource])

  const handleDragStart = useCallback(
    (e: React.DragEvent, source: MediaSource) => {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('text/plain', source.id)
      setPendingDropSource(source.id)
    },
    []
  )

  const handleDragEnd = useCallback(() => {
    clearPendingDropSource()
  }, [])

  return (
    <div className="flex flex-col h-full border-r border-white/5 bg-surface-900/40">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <span className="text-xs font-semibold text-surface-300 uppercase tracking-wider">Sources</span>
        <button
          onClick={handleImport}
          disabled={importing}
          className="text-[11px] px-2 py-0.5 rounded bg-accent-500/15 text-accent-300 hover:bg-accent-500/25 disabled:opacity-50 transition-colors"
        >
          {importing ? 'Importing...' : '+ Import'}
        </button>
      </div>

      {/* Source list */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {sources.length === 0 && (
          <div className="text-center py-8 text-surface-600 text-xs">
            <p className="mb-1">No sources</p>
            <p>Click + Import or drag files</p>
          </div>
        )}

        {sources.map((source) => (
          <div
            key={source.id}
            draggable
            onDragStart={(e) => handleDragStart(e, source)}
            onDragEnd={handleDragEnd}
            onClick={() => selectSource(selectedSourceId === source.id ? null : source.id)}
            className={`flex items-start gap-2 p-2 rounded-md cursor-grab active:cursor-grabbing group transition-colors ${
              selectedSourceId === source.id
                ? 'bg-accent-500/15 ring-1 ring-accent-500/40'
                : 'bg-white/[0.03] hover:bg-white/[0.06]'
            }`}
          >
            {/* Source thumbnail / waveform */}
            <div className="w-10 h-7 rounded bg-surface-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
              {source.width > 0 ? (
                <ThumbnailStrip
                  filePath={source.filePath}
                  durationSeconds={source.durationSeconds}
                  width={40}
                  height={28}
                  numThumbnails={1}
                />
              ) : source.audioChannels > 0 ? (
                <Waveform
                  filePath={source.filePath}
                  width={40}
                  height={28}
                  color="rgba(124, 58, 237, 0.7)"
                  numSamples={40}
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-surface-400">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-surface-200 truncate font-medium">{source.fileName}</p>
              <p className="text-[10px] text-surface-500">
                {formatTime(source.duration, source.frameRate)}
                {source.width > 0 && ` · ${source.width}x${source.height}`}
              </p>
            </div>

            {/* Remove button */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                removeSource(source.id)
              }}
              className="text-surface-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove source"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
