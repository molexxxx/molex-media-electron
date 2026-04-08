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

  const colorClasses: Record<string, { heading: string; index: string; checkbox: string; active: string; border: string }> = {
    blue: { heading: 'text-blue-400', index: 'text-blue-400', checkbox: 'accent-blue-500', active: 'bg-blue-500/10 text-blue-300 border-blue-500/20', border: 'border-l-blue-500/40' },
    amber: { heading: 'text-amber-400', index: 'text-amber-400', checkbox: 'accent-amber-500', active: 'bg-amber-500/10 text-amber-300 border-amber-500/20', border: 'border-l-amber-500/40' },
    emerald: { heading: 'text-emerald-400', index: 'text-emerald-400', checkbox: 'accent-emerald-500', active: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20', border: 'border-l-emerald-500/40' }
  }
  const c = colorClasses[color] || colorClasses.blue

  return (
    <div className={`glass-panel rounded-2xl p-4 sm:p-5 border-l-2 ${c.border}`}>
      <h3 className={`text-xs font-semibold uppercase tracking-wider ${c.heading} mb-4`}>{title}</h3>
      <div className="space-y-4">
        {streams.map((s: any) => (
          <div key={s.index} className="flex items-start gap-3 group">
            <input
              type="checkbox"
              checked={streamEnabled[s.index] ?? true}
              onChange={() => onSetStreamEnabled((p) => ({ ...p, [s.index]: !(p[s.index] ?? true) }))}
              className={`mt-1 w-4 h-4 rounded ${c.checkbox} bg-surface-900 border-surface-600 cursor-pointer`}
            />
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className={`text-xs font-mono font-semibold ${c.index}`}>#{s.index}</span>
                <span className="text-xs text-surface-200 font-medium">{s.codec_name?.toUpperCase()}{s.profile ? ` (${s.profile})` : ''}</span>
                {s.width && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{s.width}&times;{s.height}</span>}
                {s.r_frame_rate && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{s.r_frame_rate} fps</span>}
                {s.pix_fmt && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{s.pix_fmt}</span>}
                {s.channels && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{s.channels}ch {s.channel_layout || ''}</span>}
                {s.sample_rate && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{s.sample_rate} Hz</span>}
                {s.tags?.language && !s.channels && !s.width && <span className="text-2xs text-surface-500">{s.tags.language}</span>}
                {s.tags?.title && !s.channels && !s.width && <span className="text-2xs text-surface-400">{s.tags.title}</span>}
                {s.bit_rate && <span className="text-2xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded">{(parseInt(s.bit_rate) / 1000).toFixed(0)} kbps</span>}
              </div>
              {s.tags && Object.keys(s.tags).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {Object.entries(s.tags).map(([k, v]) => (
                    <span key={k} className="text-2xs bg-surface-900/60 px-1.5 py-0.5 rounded text-surface-500">
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
                      className={`text-2xs px-2 py-0.5 rounded-lg border transition-all duration-200 ${
                        val ? c.active : 'text-surface-600 border-white/[0.04] hover:text-surface-400 hover:border-white/[0.08]'
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
      <div className="flex-1 flex items-center justify-center h-64 rounded-2xl border border-dashed border-white/[0.06] bg-white/[0.02]">
        <div className="text-center px-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-white/[0.03] flex items-center justify-center border border-white/[0.04]">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-surface-500"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <p className="text-surface-400 text-sm font-medium">Drop a file to inspect</p>
          <p className="text-surface-600 text-2xs mt-1.5">or use <span className="text-accent-400/80">+ Add</span> above to view streams and metadata</p>
        </div>
      </div>
    )
  }

  if (probing) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent-500/20 border-t-accent-400 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-surface-300 text-sm font-medium">Probing file…</p>
          <p className="text-surface-500 text-2xs mt-1">Reading streams and metadata</p>
        </div>
      </div>
    )
  }

  if (!probeData) return <></>

  return (
    <>
      {/* Format info */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-4">Container</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div><span className="text-2xs text-surface-500 block mb-0.5">Format</span><span className="text-xs text-surface-200 font-mono font-medium">{probeData.format?.format_name || '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block mb-0.5">Duration</span><span className="text-xs text-surface-200 font-mono font-medium">{probeData.format?.duration ? `${parseFloat(probeData.format.duration).toFixed(1)}s` : '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block mb-0.5">Size</span><span className="text-xs text-surface-200 font-mono font-medium">{probeData.format?.size ? `${(parseInt(probeData.format.size) / 1048576).toFixed(1)} MB` : '—'}</span></div>
          <div><span className="text-2xs text-surface-500 block mb-0.5">Bitrate</span><span className="text-xs text-surface-200 font-mono font-medium">{probeData.format?.bit_rate ? `${(parseInt(probeData.format.bit_rate) / 1000).toFixed(0)} kbps` : '—'}</span></div>
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
      <div className="glass-panel rounded-2xl p-4 sm:p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500 mb-4">Metadata Tags</h3>
        <div className="space-y-2.5">
          {Object.entries(editMeta).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2.5 group">
              <span className="text-2xs text-surface-500 w-28 shrink-0 font-mono truncate" title={key}>{key}</span>
              <input
                type="text"
                value={value}
                onChange={(e) => onSetEditMeta((p) => ({ ...p, [key]: e.target.value }))}
                className="flex-1 bg-surface-900/80 border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-accent-500/50 hover:border-white/[0.1] transition-colors"
              />
              <button
                onClick={() => onSetEditMeta((p) => { const next = { ...p }; delete next[key]; return next })}
                className="text-surface-600 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all shrink-0"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          ))}
          <button
            onClick={() => onSetEditMeta((p) => ({ ...p, [`tag_${Date.now()}`]: '' }))}
            className="text-2xs text-accent-400 hover:text-accent-300 transition-colors font-medium"
          >
            + Add tag
          </button>
        </div>
      </div>

      {/* Apply button */}
      <div className="flex items-center justify-between">
        {inspectMsg ? (
          <div className={`text-xs px-3.5 py-2.5 rounded-xl flex items-center gap-2 ${
            inspectMsg.startsWith('Error')
              ? 'bg-red-500/[0.08] text-red-300 border border-red-500/10'
              : 'bg-emerald-500/[0.08] text-emerald-300 border border-emerald-500/10'
          }`}>
            {inspectMsg}
          </div>
        ) : <div />}
        <button
          onClick={onRemux}
          disabled={processing}
          className="px-5 py-2.5 text-xs font-semibold rounded-xl btn-accent text-white"
        >
          {processing ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </>
  )
}
