/**
 * @module components/editor/components/InspectTab
 * @description Inspect-mode content — FFprobe stream viewer with per-stream
 * toggles, metadata tag editor, disposition flags, and lossless remux.
 */

import React from 'react'
import { DISPOSITION_FLAGS } from '../types'

interface InspectTabProps {
  hasClip: boolean
  probing: boolean
  probeData: any
  processing: boolean
  inspectMsg: string
  streamEnabled: Record<number, boolean>
  editMeta: Record<string, string>
  editDispositions: Record<number, Record<string, number>>
  onSetStreamEnabled: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  onSetEditMeta: React.Dispatch<React.SetStateAction<Record<string, string>>>
  onToggleDisposition: (streamIdx: number, flag: string) => void
  onRemux: () => void
}

function StreamPanel({ title, color, streams, streamEnabled, editDispositions, onSetStreamEnabled, onToggleDisposition }: {
  title: string
  color: string
  streams: any[]
  streamEnabled: Record<number, boolean>
  editDispositions: Record<number, Record<string, number>>
  onSetStreamEnabled: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
  onToggleDisposition: (streamIdx: number, flag: string) => void
}): React.JSX.Element | null {
  if (!streams?.length) return null

  const colorClasses: Record<string, { heading: string; index: string; checkbox: string; active: string }> = {
    blue: { heading: 'text-blue-400', index: 'text-blue-400', checkbox: 'accent-blue-500', active: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
    amber: { heading: 'text-amber-400', index: 'text-amber-400', checkbox: 'accent-amber-500', active: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    emerald: { heading: 'text-emerald-400', index: 'text-emerald-400', checkbox: 'accent-emerald-500', active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' }
  }
  const c = colorClasses[color] || colorClasses.blue

  return (
    <div className="glass rounded-xl p-4">
      <h3 className={`text-xs font-semibold uppercase tracking-wider ${c.heading} mb-3`}>{title}</h3>
      <div className="space-y-3">
        {streams.map((s: any) => (
          <div key={s.index} className="flex items-start gap-3 group">
            <input
              type="checkbox"
              checked={streamEnabled[s.index] ?? true}
              onChange={() => onSetStreamEnabled((p) => ({ ...p, [s.index]: !(p[s.index] ?? true) }))}
              className={`mt-1 w-3.5 h-3.5 rounded ${c.checkbox} bg-surface-700 border-surface-600`}
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className={`text-xs font-mono ${c.index}`}>#{s.index}</span>
                <span className="text-xs text-surface-200">{s.codec_name?.toUpperCase()}{s.profile ? ` (${s.profile})` : ''}</span>
                {/* Video-specific info */}
                {s.width && <span className="text-2xs text-surface-500">{s.width}x{s.height}</span>}
                {s.r_frame_rate && <span className="text-2xs text-surface-500">{s.r_frame_rate} fps</span>}
                {s.pix_fmt && <span className="text-2xs text-surface-500">{s.pix_fmt}</span>}
                {/* Audio-specific info */}
                {s.channels && <span className="text-2xs text-surface-500">{s.channels}ch {s.channel_layout || ''}</span>}
                {s.sample_rate && <span className="text-2xs text-surface-500">{s.sample_rate} Hz</span>}
                {/* Subtitle-specific info */}
                {s.tags?.language && !s.channels && !s.width && <span className="text-2xs text-surface-500">{s.tags.language}</span>}
                {s.tags?.title && !s.channels && !s.width && <span className="text-2xs text-surface-400">{s.tags.title}</span>}
                {/* Common */}
                {s.bit_rate && <span className="text-2xs text-surface-500">{(parseInt(s.bit_rate) / 1000).toFixed(0)} kbps</span>}
              </div>
              {s.tags && Object.keys(s.tags).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {Object.entries(s.tags).map(([k, v]) => (
                    <span key={k} className="text-2xs bg-surface-800 px-1.5 py-0.5 rounded text-surface-400">
                      {k}: <span className="text-surface-300">{String(v)}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {DISPOSITION_FLAGS.map((flag) => {
                  const val = editDispositions[s.index]?.[flag] ?? s.disposition?.[flag] ?? 0
                  return (
                    <button
                      key={flag}
                      onClick={() => onToggleDisposition(s.index, flag)}
                      className={`text-2xs px-1.5 py-0.5 rounded-md border transition-all ${
                        val ? c.active : 'text-surface-600 border-surface-700 hover:text-surface-400 hover:border-surface-600'
                      }`}
                    >
                      {flag}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function InspectTab({
  hasClip, probing, probeData, processing, inspectMsg,
  streamEnabled, editMeta, editDispositions,
  onSetStreamEnabled, onSetEditMeta, onToggleDisposition, onRemux
}: InspectTabProps): React.JSX.Element {
  if (!hasClip) {
    return (
      <div className="flex-1 flex items-center justify-center h-64">
        <p className="text-surface-500 text-sm">Add a file to inspect its streams and metadata</p>
      </div>
    )
  }

  if (probing) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-surface-400 text-sm flex items-center gap-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Probing file...
        </div>
      </div>
    )
  }

  if (!probeData) return <></>

  return (
    <>
      {/* Format info */}
      <div className="glass rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-3">Container</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><span className="text-2xs text-surface-500 block">Format</span><span className="text-xs text-surface-200 font-mono">{probeData.format?.format_name || '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block">Duration</span><span className="text-xs text-surface-200 font-mono">{probeData.format?.duration ? `${parseFloat(probeData.format.duration).toFixed(1)}s` : '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block">Size</span><span className="text-xs text-surface-200 font-mono">{probeData.format?.size ? `${(parseInt(probeData.format.size) / 1048576).toFixed(1)} MB` : '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block">Bitrate</span><span className="text-xs text-surface-200 font-mono">{probeData.format?.bit_rate ? `${(parseInt(probeData.format.bit_rate) / 1000).toFixed(0)} kbps` : '—'}</span></div>
        </div>
      </div>

      <StreamPanel
        title="Video Streams" color="blue" streams={probeData.videoStreams}
        streamEnabled={streamEnabled} editDispositions={editDispositions}
        onSetStreamEnabled={onSetStreamEnabled} onToggleDisposition={onToggleDisposition}
      />
      <StreamPanel
        title="Audio Streams" color="amber" streams={probeData.audioStreams}
        streamEnabled={streamEnabled} editDispositions={editDispositions}
        onSetStreamEnabled={onSetStreamEnabled} onToggleDisposition={onToggleDisposition}
      />
      <StreamPanel
        title="Subtitle Streams" color="emerald" streams={probeData.subtitleStreams}
        streamEnabled={streamEnabled} editDispositions={editDispositions}
        onSetStreamEnabled={onSetStreamEnabled} onToggleDisposition={onToggleDisposition}
      />
      <StreamPanel
        title="Data / Attachment Streams" color="blue" streams={probeData.dataStreams}
        streamEnabled={streamEnabled} editDispositions={editDispositions}
        onSetStreamEnabled={onSetStreamEnabled} onToggleDisposition={onToggleDisposition}
      />

      {/* Format metadata */}
      <div className="glass rounded-xl p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-3">Metadata Tags</h3>
        <div className="space-y-2">
          {Object.entries(editMeta).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-2xs text-surface-500 w-28 shrink-0 font-mono truncate" title={key}>{key}</span>
              <input
                type="text"
                value={value}
                onChange={(e) => onSetEditMeta((p) => ({ ...p, [key]: e.target.value }))}
                className="flex-1 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-accent-500 transition-colors"
              />
              <button
                onClick={() => onSetEditMeta((p) => { const next = { ...p }; delete next[key]; return next })}
                className="text-surface-600 hover:text-red-400 transition-colors shrink-0"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          ))}
          <button
            onClick={() => onSetEditMeta((p) => ({ ...p, [`tag_${Date.now()}`]: '' }))}
            className="text-2xs text-accent-400 hover:text-accent-300 transition-colors"
          >
            + Add tag
          </button>
        </div>
      </div>

      {/* Apply button */}
      <div className="flex items-center justify-between">
        {inspectMsg ? (
          <div className={`text-xs px-3 py-2 rounded-lg ${
            inspectMsg.startsWith('Error') ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'
          }`}>
            {inspectMsg}
          </div>
        ) : <div />}
        <button
          onClick={onRemux}
          disabled={processing}
          className="px-4 py-2 text-xs font-semibold rounded-xl bg-accent-600 hover:bg-accent-500 disabled:opacity-40 text-white shadow-glow hover:shadow-glow-lg transition-all"
        >
          {processing ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </>
  )
}
