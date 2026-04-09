/**
 * @module editor/inspect/InspectEditor
 * Inspect mode - displays FFprobe format metadata and per-stream details
 * for the currently loaded media source. Supports editing metadata tags
 * and removing streams via lossless remux.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import {
  VideoStreamInfo,
  AudioStreamInfo,
  SubtitleStreamInfo,
  DataStreamInfo
} from './StreamInfo'
import { KeyframeView } from './KeyframeView'

/** MediaInfo shape returned by `editor:probeDetailed`. */
interface ProbeMediaInfo {
  audioStreams: any[]
  videoStreams: any[]
  subtitleStreams: any[]
  dataStreams: any[]
  format: {
    filename: string
    duration: string
    size: string
    bit_rate: string
    format_name: string
    tags?: Record<string, string>
  }
  isVideoFile: boolean
  isAudioOnly: boolean
}

/** Format bytes to human-readable size. */
function formatSize(s: string | number): string {
  const n = typeof s === 'string' ? parseInt(s, 10) : s
  if (isNaN(n) || n === 0) return '-'
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)} MB`
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`
  return `${n} B`
}

/** Format duration seconds to HH:MM:SS.mmm. */
function formatDuration(s: string | number): string {
  const sec = typeof s === 'string' ? parseFloat(s) : s
  if (isNaN(sec) || sec <= 0) return '-'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = sec % 60
  const parts = [h, m].filter((_, i) => i === 1 || h > 0).map((v) => String(v).padStart(2, '0'))
  parts.push(ss.toFixed(3).padStart(6, '0'))
  return parts.join(':')
}

/** Format bitrate number-string to human-readable. */
function formatBitrate(br?: string): string {
  if (!br) return '-'
  const n = parseInt(br, 10)
  if (isNaN(n) || n === 0) return '-'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mb/s`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} kb/s`
  return `${n} b/s`
}

/** Collect all stream indices from probe data. */
function allStreamIndices(data: ProbeMediaInfo): number[] {
  const all = [
    ...data.videoStreams,
    ...data.audioStreams,
    ...data.subtitleStreams,
    ...data.dataStreams
  ]
  return all.map((s) => s.index).sort((a, b) => a - b)
}

export function InspectEditor(): React.JSX.Element {
  const sources = useEditorStore((s) => s.sources)
  const clipMode = useEditorStore((s) => s.clipMode)
  const source = sources.find((s) => s.id === clipMode.sourceId)

  const [probeData, setProbeData] = useState<ProbeMediaInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // -- Editing state --
  const [includedStreams, setIncludedStreams] = useState<Set<number>>(new Set())
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [metadataEdits, setMetadataEdits] = useState<Record<string, string>>({})
  const [remuxing, setRemuxing] = useState(false)
  const [remuxResult, setRemuxResult] = useState<{ success: boolean; message: string } | null>(null)

  // Fetch probe data when the source changes
  useEffect(() => {
    if (!source) {
      setProbeData(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setRemuxResult(null)

    window.api
      .probeDetailed(source.filePath)
      .then((result: { success: boolean; data?: ProbeMediaInfo; error?: string }) => {
        if (cancelled) return
        if (result.success && result.data) {
          setProbeData(result.data)
          // Initialize all streams as included
          setIncludedStreams(new Set(allStreamIndices(result.data)))
          // Initialize metadata from existing tags
          setMetadataEdits(result.data.format.tags ? { ...result.data.format.tags } : {})
          setEditingMetadata(false)
        } else {
          setError(result.error || 'Failed to probe file')
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [source?.id, source?.filePath])

  // Toggle a stream in/out
  const toggleStream = useCallback((index: number) => {
    setIncludedStreams((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
    setRemuxResult(null)
  }, [])

  // Update a metadata tag value
  const updateMetadata = useCallback((key: string, value: string) => {
    setMetadataEdits((prev) => ({ ...prev, [key]: value }))
    setRemuxResult(null)
  }, [])

  // Add a new metadata tag
  const addMetadataTag = useCallback(() => {
    const key = `tag_${Date.now()}`
    setMetadataEdits((prev) => ({ ...prev, [key]: '' }))
  }, [])

  // Remove a metadata tag
  const removeMetadataTag = useCallback((key: string) => {
    setMetadataEdits((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // Rename a metadata key
  const renameMetadataKey = useCallback((oldKey: string, newKey: string) => {
    if (oldKey === newKey) return
    setMetadataEdits((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        next[k === oldKey ? newKey : k] = v
      }
      return next
    })
  }, [])

  // Check if anything has been modified
  const hasStreamChanges = probeData ? includedStreams.size !== allStreamIndices(probeData).length : false
  const hasMetadataChanges = probeData ? (() => {
    const original = probeData.format.tags || {}
    const origKeys = Object.keys(original).sort()
    const editKeys = Object.keys(metadataEdits).sort()
    if (origKeys.length !== editKeys.length) return true
    return origKeys.some((k, i) => k !== editKeys[i] || original[k] !== metadataEdits[editKeys[i]])
  })() : false
  const hasChanges = hasStreamChanges || (editingMetadata && hasMetadataChanges)

  // Execute remux
  const handleRemux = useCallback(async () => {
    if (!source || !probeData) return
    setRemuxing(true)
    setRemuxResult(null)

    try {
      const keepStreams = Array.from(includedStreams).sort((a, b) => a - b)
      if (keepStreams.length === 0) {
        setRemuxResult({ success: false, message: 'Must keep at least one stream' })
        setRemuxing(false)
        return
      }

      const options: {
        keepStreams: number[]
        metadata?: Record<string, string>
      } = { keepStreams }

      if (editingMetadata && hasMetadataChanges) {
        options.metadata = metadataEdits
      }

      const result = await window.api.remuxMedia(source.filePath, options)
      if (result.success) {
        setRemuxResult({ success: true, message: `Saved to ${result.outputPath}` })
      } else {
        setRemuxResult({ success: false, message: result.error || 'Remux failed' })
      }
    } catch (err: any) {
      setRemuxResult({ success: false, message: err.message || 'Remux failed' })
    } finally {
      setRemuxing(false)
    }
  }, [source, probeData, includedStreams, editingMetadata, hasMetadataChanges, metadataEdits])

  // -- No source loaded --
  if (!source) {
    return (
      <div className="flex items-center justify-center h-full text-surface-400">
        <div className="text-center">
          <SearchIcon />
          <p className="text-sm mt-2">Load a file in Clip mode to inspect its metadata</p>
        </div>
      </div>
    )
  }

  // -- Loading --
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-surface-400">
        <div className="text-center">
          <div className="w-5 h-5 border-2 border-accent-500/30 border-t-accent-400 rounded-full animate-spin mx-auto" />
          <p className="text-xs mt-2">Probing media…</p>
        </div>
      </div>
    )
  }

  // -- Error --
  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        <div className="text-center">
          <p className="text-sm font-medium">Probe failed</p>
          <p className="text-xs text-surface-500 mt-1 max-w-xs">{error}</p>
        </div>
      </div>
    )
  }

  const fmt = probeData?.format

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* File header */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {probeData?.isVideoFile ? <FileVideoIcon /> : <FileAudioIcon />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-surface-100 truncate">{source.fileName}</h2>
          <p className="text-2xs text-surface-500 font-mono truncate">{source.filePath}</p>
        </div>
        {/* Save button */}
        {hasChanges && (
          <button
            onClick={handleRemux}
            disabled={remuxing}
            className="shrink-0 px-3 py-1 rounded-lg text-xs font-medium bg-accent-500/20 text-accent-200 border border-accent-500/30 hover:bg-accent-500/30 disabled:opacity-50 transition-colors"
          >
            {remuxing ? 'Saving…' : 'Save as…'}
          </button>
        )}
      </div>

      {/* Remux result toast */}
      {remuxResult && (
        <div className={`rounded-lg px-3 py-2 text-xs ${remuxResult.success ? 'bg-green-500/10 text-green-300 border border-green-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
          {remuxResult.message}
        </div>
      )}

      {/* Format overview */}
      {fmt && (
        <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-surface-300 uppercase tracking-wide">Container / Format</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Format" value={fmt.format_name} />
            <Stat label="Duration" value={formatDuration(fmt.duration)} />
            <Stat label="Size" value={formatSize(fmt.size)} />
            <Stat label="Bitrate" value={formatBitrate(fmt.bit_rate)} />
          </div>

          {/* Metadata tags - read-only or editable */}
          <div className="mt-3 pt-2 border-t border-white/5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-2xs text-surface-500 uppercase tracking-wide">Metadata Tags</p>
              <button
                onClick={() => setEditingMetadata(!editingMetadata)}
                className="text-2xs text-accent-400 hover:text-accent-300 transition-colors"
              >
                {editingMetadata ? 'Cancel editing' : 'Edit'}
              </button>
            </div>

            {!editingMetadata ? (
              /* Read-only tags */
              (fmt.tags && Object.keys(fmt.tags).length > 0) ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs font-mono">
                  {Object.entries(fmt.tags).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-surface-500 shrink-0">{k}</span>
                      <span className="text-surface-300 truncate">{v}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-surface-600 italic">No metadata tags</p>
              )
            ) : (
              /* Editable tags */
              <div className="space-y-1.5">
                {Object.entries(metadataEdits).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <input
                      className="w-28 shrink-0 px-1.5 py-0.5 rounded bg-surface-800 border border-white/10 text-xs font-mono text-surface-200 focus:outline-none focus:border-accent-500/50"
                      value={key}
                      onChange={(e) => renameMetadataKey(key, e.target.value)}
                      spellCheck={false}
                    />
                    <input
                      className="flex-1 px-1.5 py-0.5 rounded bg-surface-800 border border-white/10 text-xs font-mono text-surface-200 focus:outline-none focus:border-accent-500/50"
                      value={value}
                      onChange={(e) => updateMetadata(key, e.target.value)}
                      spellCheck={false}
                    />
                    <button
                      onClick={() => removeMetadataTag(key)}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/20 text-surface-500 hover:text-red-400 transition-colors"
                      title="Remove tag"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                  </div>
                ))}
                <button
                  onClick={addMetadataTag}
                  className="text-2xs text-accent-400 hover:text-accent-300 transition-colors mt-1"
                >
                  + Add tag
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Streams - with toggle checkboxes */}
      {probeData && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-surface-300 uppercase tracking-wide">
              Streams ({probeData.videoStreams.length + probeData.audioStreams.length + probeData.subtitleStreams.length + probeData.dataStreams.length})
            </h3>
            {hasStreamChanges && (
              <span className="text-2xs text-amber-400">
                {includedStreams.size} of {allStreamIndices(probeData).length} selected
              </span>
            )}
          </div>
          {probeData.videoStreams.map((s) => (
            <VideoStreamInfo key={`v-${s.index}`} stream={s} included={includedStreams.has(s.index)} onToggle={toggleStream} />
          ))}
          {probeData.audioStreams.map((s) => (
            <AudioStreamInfo key={`a-${s.index}`} stream={s} included={includedStreams.has(s.index)} onToggle={toggleStream} />
          ))}
          {probeData.subtitleStreams.map((s) => (
            <SubtitleStreamInfo key={`s-${s.index}`} stream={s} included={includedStreams.has(s.index)} onToggle={toggleStream} />
          ))}
          {probeData.dataStreams.map((s) => (
            <DataStreamInfo key={`d-${s.index}`} stream={s} included={includedStreams.has(s.index)} onToggle={toggleStream} />
          ))}
        </div>
      )}

      {/* Keyframe analysis (video only) */}
      {probeData?.isVideoFile && source && (
        <KeyframeView filePath={source.filePath} />
      )}
    </div>
  )
}

/* -- Small inline SVG helpers -- */

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-2xs text-surface-500 uppercase tracking-wide">{label}</p>
      <p className="text-xs font-mono text-surface-200 mt-0.5">{value}</p>
    </div>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-surface-600">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function FileVideoIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <polygon points="10 12 16 15.5 10 19 10 12" />
    </svg>
  )
}

function FileAudioIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <circle cx="10" cy="16" r="2" />
      <path d="M12 12v4" />
      <path d="M12 12a2 2 0 0 1 2-2" />
    </svg>
  )
}
