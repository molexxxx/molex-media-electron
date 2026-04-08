/**
 * @module components/batch/OperationPanel
 * @description Compact operation selector with sleek inline config.
 * Selects the default operation+options that new files get stamped with.
 */

import React, { useMemo, useState } from 'react'
import { useAppStore, BUILTIN_PRESETS } from '../../../stores/appStore'
import type { Operation, ConvertOptions, ExtractOptions, CompressOptions } from '../../../stores/types'
import {
  PRESET_CATEGORIES,
  detectConvertConflicts, type ConvertPreset, type ConflictWarning
} from '../presets'
import { PresetDropdown } from './PresetDropdown'
import { SelectDropdown } from './SelectDropdown'
import { FixedTip } from '../../shared/ui'

/* ------------------------------------------------------------------ */
/*  Operation definitions                                              */
/* ------------------------------------------------------------------ */

const OP_TABS: { id: Operation; label: string; tip: string; icon: React.JSX.Element }[] = [
  { id: 'convert', label: 'Convert', tip: 'Convert format/codec', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
    </svg>
  )},
  { id: 'normalize', label: 'Normalize', tip: 'Loudness normalization (EBU R128)', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 20h.01" /><path d="M7 20v-4" /><path d="M12 20v-8" /><path d="M17 20V8" /><path d="M22 4v16" />
    </svg>
  )},
  { id: 'boost', label: 'Volume', tip: 'Adjust volume level', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )},
  { id: 'compress', label: 'Compress', tip: 'Reduce file size', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" /><path d="m8 17 4 4 4-4" />
    </svg>
  )},
  { id: 'extract', label: 'Extract', tip: 'Extract audio from video', icon: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )},
]

/* ------------------------------------------------------------------ */
/*  Summary text helpers                                               */
/* ------------------------------------------------------------------ */

function getNormalizeSummary(preset: string | null, I: number, TP: number, LRA: number): string {
  const p = BUILTIN_PRESETS.find((x) => x.id === preset)
  const name = p ? p.name : 'Custom'
  return `${name} · ${I} LUFS / ${TP} dBTP / ${LRA} LU`
}

function getBoostSummary(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct}% volume`
}

function getConvertSummary(o: ConvertOptions): string {
  return `${o.outputFormat.toUpperCase()} · ${o.videoCodec === 'copy' ? 'Copy' : o.videoCodec} / ${o.audioCodec === 'copy' ? 'Copy' : o.audioCodec}`
}

function getExtractSummary(o: ExtractOptions): string {
  return `→ ${o.outputFormat.toUpperCase()}${o.audioBitrate ? ` @ ${o.audioBitrate}` : ''}`
}

function getCompressSummary(o: CompressOptions): string {
  return `${o.quality.charAt(0).toUpperCase() + o.quality.slice(1)} quality${o.targetSizeMB ? ` · ${o.targetSizeMB} MB target` : ''}`
}

export { getNormalizeSummary, getBoostSummary, getConvertSummary, getExtractSummary, getCompressSummary }

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export { OP_TABS }

export function OperationPanel(): React.JSX.Element {
  const {
    operation, setOperation,
    boostPercent, setBoostPercent,
    selectedPreset, setSelectedPreset,
    normalizeOptions, setNormalizeOptions,
    convertOptions, setConvertOptions,
    extractOptions, setExtractOptions,
    compressOptions, setCompressOptions,
  } = useAppStore()

  const [expanded, setExpanded] = useState(false)

  const handleApplyPreset = (presetId: string) => {
    const preset = BUILTIN_PRESETS.find((p) => p.id === presetId)
    if (preset) {
      const { config } = useAppStore.getState()
      const norm = presetId === 'defaults' && config ? config.normalization : preset.normalization
      setNormalizeOptions(norm)
    }
    setSelectedPreset(presetId)
    setOperation('normalize')
  }

  const conflicts = useMemo(() =>
    operation === 'convert' ? detectConvertConflicts(convertOptions) : [],
    [operation, convertOptions]
  )

  // Summary line for current operation
  const summary = (() => {
    switch (operation) {
      case 'normalize': return getNormalizeSummary(selectedPreset, normalizeOptions.I, normalizeOptions.TP, normalizeOptions.LRA)
      case 'boost': return getBoostSummary(boostPercent)
      case 'convert': return getConvertSummary(convertOptions)
      case 'extract': return getExtractSummary(extractOptions)
      case 'compress': return getCompressSummary(compressOptions)
    }
  })()

  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-900/40 overflow-visible">
      {/* Operation selector row */}
      <div className="relative flex items-center gap-0.5 px-1.5 py-1.5 overflow-visible z-10">
        {OP_TABS.map((tab) => (
          <FixedTip key={tab.id} label={tab.tip}>
            <button
              onClick={() => { setOperation(tab.id) }}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                operation === tab.id
                  ? 'bg-accent-600/20 text-accent-300'
                  : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
              }`}
            >
              <span className={operation === tab.id ? 'text-accent-400' : 'text-surface-600 hover:text-surface-400'}>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          </FixedTip>
        ))}

        {/* Summary + expand toggle */}
        <div className="flex-1 min-w-0" />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs text-surface-400 hover:text-surface-200 bg-surface-800/30 hover:bg-surface-800/60 border border-white/[0.04] hover:border-white/[0.08] transition-all min-w-0"
        >
          <span className="truncate hidden sm:inline">{summary}</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            className={`shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* Expandable config area */}
      {expanded && (
        <div className="border-t border-white/5 px-3 py-3 animate-fade-in">
          {operation === 'normalize' && (
            <NormalizeConfig selectedPreset={selectedPreset} onApplyPreset={handleApplyPreset} />
          )}
          {operation === 'boost' && (
            <BoostConfig boostPercent={boostPercent} setBoostPercent={setBoostPercent} />
          )}
          {operation === 'convert' && (
            <ConvertConfig options={convertOptions} setOptions={setConvertOptions} conflicts={conflicts} />
          )}
          {operation === 'extract' && (
            <ExtractConfig options={extractOptions} setOptions={setExtractOptions} />
          )}
          {operation === 'compress' && (
            <CompressConfig options={compressOptions} setOptions={setCompressOptions} />
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Normalize                                                          */
/* ------------------------------------------------------------------ */

function NormalizeConfig({ selectedPreset, onApplyPreset }: {
  selectedPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  const { normalizeOptions, setNormalizeOptions, setSelectedPreset, config } = useAppStore()
  const [advanced, setAdvanced] = useState(false)

  return (
    <div className="space-y-2.5">
      {/* Preset row */}
      <div className="flex items-center gap-1 flex-wrap">
        {selectedPreset === null && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
            Custom
            <button onClick={() => onApplyPreset('defaults')} className="hover:text-white transition-colors">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </span>
        )}
        {BUILTIN_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onApplyPreset(p.id)}
            className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
              selectedPreset === p.id
                ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
            }`}
            title={p.description}
          >
            {p.name}
          </button>
        ))}
        <button
          onClick={() => setAdvanced(!advanced)}
          className={`ml-auto text-2xs px-2 py-0.5 rounded-md transition-all ${
            advanced ? 'text-accent-300 bg-accent-600/20' : 'text-surface-600 hover:text-surface-400'
          }`}
        >
          Sliders
        </button>
      </div>

      {/* Info strip */}
      <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
        <span className="font-mono">I={normalizeOptions.I} LUFS</span>
        <span className="font-mono">TP={normalizeOptions.TP} dBTP</span>
        <span className="font-mono">LRA={normalizeOptions.LRA} LU</span>
        {selectedPreset && (() => {
          const p = BUILTIN_PRESETS.find((x) => x.id === selectedPreset)
          if (!p) return null
          const codec = selectedPreset === 'defaults' && config ? config.audioCodec : p.audioCodec
          const bitrate = selectedPreset === 'defaults' && config ? config.audioBitrate : p.audioBitrate
          return <>
            <span className="text-surface-600">·</span>
            <span className="font-mono">{codec.toUpperCase()} {bitrate}</span>
            <span className="text-surface-600 ml-auto">{p.description}</span>
          </>
        })()}
      </div>

      {/* Advanced sliders */}
      {advanced && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <NormalizeSlider label="Loudness" unit="LUFS" value={normalizeOptions.I}
            min={-30} max={-5} step={0.5}
            onChange={(v) => { setNormalizeOptions({ I: v }); setSelectedPreset(null) }} />
          <NormalizeSlider label="True Peak" unit="dBTP" value={normalizeOptions.TP}
            min={-3} max={0} step={0.1}
            onChange={(v) => { setNormalizeOptions({ TP: v }); setSelectedPreset(null) }} />
          <NormalizeSlider label="LRA" unit="LU" value={normalizeOptions.LRA}
            min={1} max={25} step={0.5}
            onChange={(v) => { setNormalizeOptions({ LRA: v }); setSelectedPreset(null) }} />
        </div>
      )}
    </div>
  )
}

function NormalizeSlider({ label, unit, value, min, max, step, onChange }: {
  label: string; unit: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-surface-500">{label}</span>
        <span className="text-2xs font-mono font-semibold text-surface-300">{value} {unit}</span>
      </div>
      <div className="relative h-4 flex items-center cursor-pointer">
        <div className="absolute left-0 right-0 h-1 rounded-full bg-surface-700">
          <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
        </div>
        <div
          className="absolute w-3 h-3 rounded-full bg-accent-400 border-2 border-accent-300 shadow-lg shadow-accent-500/30 pointer-events-none"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="norm-slider" />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Boost                                                              */
/* ------------------------------------------------------------------ */

function BoostConfig({ boostPercent, setBoostPercent }: {
  boostPercent: number; setBoostPercent: (v: number) => void
}): React.JSX.Element {
  const isBoost = boostPercent > 0
  const isReduce = boostPercent < 0
  const fillPct = ((boostPercent + 50) / 250) * 100

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold font-mono px-1.5 py-0.5 rounded ${
          isBoost ? 'bg-green-500/15 text-green-400' :
          isReduce ? 'bg-amber-500/15 text-amber-400' :
          'bg-surface-700/50 text-surface-400'
        }`}>
          {boostPercent > 0 ? '+' : ''}{boostPercent}%
        </span>
        <div className="flex items-center gap-0.5 flex-wrap">
          {[-50, -25, 0, 25, 50, 100, 200].map((v) => (
            <button key={v} onClick={() => setBoostPercent(v)}
              className={`px-1.5 py-0.5 text-2xs rounded transition-all ${
                boostPercent === v ? 'bg-accent-600 text-white' : 'text-surface-500 hover:text-surface-300 hover:bg-surface-700/60'
              }`}
            >
              {v > 0 ? `+${v}` : v}%
            </button>
          ))}
        </div>
      </div>

      <div className="relative group">
        <div className="h-1.5 rounded-full bg-surface-800/80 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-150 ${
            isBoost ? 'bg-linear-to-r from-accent-600 to-accent-400' :
            isReduce ? 'bg-linear-to-r from-amber-600 to-amber-400' : 'bg-surface-600'
          }`} style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }} />
        </div>
        <input type="range" min="-50" max="200" value={boostPercent}
          onChange={(e) => setBoostPercent(parseInt(e.target.value, 10))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
        <div className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 shadow pointer-events-none transition-all duration-150 ${
          isBoost ? 'bg-accent-400 border-accent-300' : isReduce ? 'bg-amber-400 border-amber-300' : 'bg-surface-300 border-surface-200'
        }`} style={{ left: `calc(${Math.max(0, Math.min(100, fillPct))}% - 6px)` }} />
      </div>

      {boostPercent > 100 && (
        <span className="text-2xs text-amber-400/80">High boost may cause clipping</span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Convert                                                            */
/* ------------------------------------------------------------------ */

function ConvertConfig({ options, setOptions, conflicts }: {
  options: ConvertOptions; setOptions: (o: Partial<ConvertOptions>) => void; conflicts: ConflictWarning[]
}): React.JSX.Element {
  const [activePresetId, setActivePresetId] = useState<string>('mp4-h264')
  const applyPreset = (preset: ConvertPreset) => { setActivePresetId(preset.id); setOptions(preset.options as Partial<ConvertOptions>) }
  const setCustom = (partial: Partial<ConvertOptions>) => { setActivePresetId(''); setOptions(partial) }
  const lbl = "text-2xs text-surface-500 block mb-0.5"

  return (
    <div className="space-y-3">
      {/* Preset */}
      <div className="flex items-center gap-3">
        <div>
          <label className={lbl}>Preset</label>
          <PresetDropdown categories={PRESET_CATEGORIES} activeId={activePresetId}
            onSelect={(p) => { if (!p.id) { setActivePresetId(''); return }; applyPreset(p) }} />
        </div>
        {activePresetId && (() => {
          const p = PRESET_CATEGORIES.flatMap((c) => c.presets).find((x) => x.id === activePresetId)
          return p ? <span className="text-2xs text-surface-600 truncate mt-4">{p.description}</span> : null
        })()}
      </div>

      {/* Options grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        <div>
          <label className={lbl}>Format</label>
          <SelectDropdown value={options.outputFormat} onChange={(v) => setCustom({ outputFormat: v })} className="w-full" items={[
            { label: 'Video', options: [
              { value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }, { value: 'mov', label: 'MOV' },
              { value: 'webm', label: 'WebM' }, { value: 'avi', label: 'AVI' }, { value: 'ts', label: 'MPEG-TS' },
              { value: 'flv', label: 'FLV' }, { value: 'wmv', label: 'WMV' }, { value: 'ogv', label: 'OGV' },
            ]},
            { label: 'Audio', options: [
              { value: 'mp3', label: 'MP3' }, { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV' },
              { value: 'm4a', label: 'M4A' }, { value: 'aac', label: 'AAC' }, { value: 'ogg', label: 'OGG' },
              { value: 'opus', label: 'Opus' }, { value: 'ac3', label: 'AC3' }, { value: 'wma', label: 'WMA' },
              { value: 'aiff', label: 'AIFF' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Video Codec</label>
          <SelectDropdown value={options.videoCodec} onChange={(v) => setCustom({ videoCodec: v })} className="w-full" items={[
            { label: 'Common', options: [
              { value: 'copy', label: 'Copy' }, { value: 'libx264', label: 'H.264' }, { value: 'libx265', label: 'H.265' },
            ]},
            { label: 'Modern', options: [
              { value: 'libvpx-vp9', label: 'VP9' }, { value: 'libaom-av1', label: 'AV1' },
            ]},
            { label: 'Pro', options: [
              { value: 'prores_ks', label: 'ProRes' }, { value: 'ffv1', label: 'FFV1' }, { value: 'utvideo', label: 'UT Video' },
            ]},
            { label: 'Legacy', options: [
              { value: 'mpeg4', label: 'MPEG-4' }, { value: 'mpeg2video', label: 'MPEG-2' },
              { value: 'libtheora', label: 'Theora' }, { value: 'wmv2', label: 'WMV2' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Codec</label>
          <SelectDropdown value={options.audioCodec} onChange={(v) => setCustom({ audioCodec: v })} className="w-full" items={[
            { label: 'Common', options: [
              { value: 'copy', label: 'Copy' }, { value: 'aac', label: 'AAC' }, { value: 'libmp3lame', label: 'MP3' },
            ]},
            { label: 'Modern', options: [
              { value: 'libopus', label: 'Opus' }, { value: 'libvorbis', label: 'Vorbis' }, { value: 'flac', label: 'FLAC' },
            ]},
            { label: 'Surround', options: [
              { value: 'ac3', label: 'AC3' }, { value: 'eac3', label: 'E-AC3' },
            ]},
            { label: 'Pro', options: [
              { value: 'alac', label: 'ALAC' }, { value: 'pcm_s16le', label: 'PCM 16' },
              { value: 'pcm_s24le', label: 'PCM 24' }, { value: 'wmav2', label: 'WMA' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Bitrate</label>
          <SelectDropdown value={options.audioBitrate} onChange={(v) => setCustom({ audioBitrate: v })} className="w-full" items={[
            { value: '', label: 'Auto' },
            { label: 'Common', options: [
              { value: '128k', label: '128k' }, { value: '192k', label: '192k' }, { value: '256k', label: '256k' }, { value: '320k', label: '320k' },
            ]},
            { label: 'High', options: [
              { value: '448k', label: '448k' }, { value: '640k', label: '640k' }, { value: '0', label: 'Lossless' },
            ]},
            { label: 'Low', options: [
              { value: '32k', label: '32k' }, { value: '64k', label: '64k' }, { value: '96k', label: '96k' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Video Bitrate</label>
          <SelectDropdown value={options.videoBitrate} onChange={(v) => setCustom({ videoBitrate: v })} className="w-full" items={[
            { value: '', label: 'Auto' },
            { label: 'Common', options: [
              { value: '1000k', label: '1M' }, { value: '2500k', label: '2.5M' }, { value: '5000k', label: '5M' },
              { value: '8000k', label: '8M' }, { value: '10000k', label: '10M' },
            ]},
            { label: 'High', options: [
              { value: '15000k', label: '15M' }, { value: '20000k', label: '20M' }, { value: '25000k', label: '25M' },
              { value: '35000k', label: '35M' }, { value: '50000k', label: '50M' },
            ]},
            { label: 'Low', options: [
              { value: '300k', label: '300k' }, { value: '500k', label: '500k' }, { value: '800k', label: '800k' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Resolution</label>
          <SelectDropdown value={options.resolution} onChange={(v) => setCustom({ resolution: v })} className="w-full" items={[
            { value: '', label: 'Original' },
            { label: '16:9', options: [
              { value: '3840x2160', label: '4K' }, { value: '2560x1440', label: '1440p' },
              { value: '1920x1080', label: '1080p' }, { value: '1280x720', label: '720p' },
              { value: '854x480', label: '480p' }, { value: '640x360', label: '360p' },
            ]},
            { label: 'Vertical', options: [
              { value: '1080x1920', label: '1080×1920' }, { value: '720x1280', label: '720×1280' },
            ]},
            { label: 'Square', options: [
              { value: '1080x1080', label: '1080²' }, { value: '720x720', label: '720²' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Framerate</label>
          <SelectDropdown value={options.framerate} onChange={(v) => setCustom({ framerate: v })} className="w-full" items={[
            { value: '', label: 'Original' },
            { label: 'Standard', options: [
              { value: '24', label: '24 fps' }, { value: '25', label: '25 fps' },
              { value: '30', label: '30 fps' }, { value: '60', label: '60 fps' },
            ]},
            { label: 'Broadcast', options: [
              { value: '23.976', label: '23.976' }, { value: '29.97', label: '29.97' },
              { value: '48', label: '48 fps' }, { value: '50', label: '50 fps' }, { value: '59.94', label: '59.94' },
            ]},
            { label: 'High', options: [
              { value: '120', label: '120 fps' }, { value: '144', label: '144 fps' },
            ]},
          ]} />
        </div>
      </div>

      {/* Conflict warnings */}
      {conflicts.length > 0 && (
        <div className="space-y-1">
          {conflicts.map((c, i) => (
            <div key={i} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-2xs ${
              c.type === 'error'
                ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
            }`}>
              {c.type === 'error' ? '✕' : '⚠'} {c.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Extract                                                            */
/* ------------------------------------------------------------------ */

function ExtractConfig({ options, setOptions }: {
  options: ExtractOptions; setOptions: (o: Partial<ExtractOptions>) => void
}): React.JSX.Element {
  const lbl = "text-2xs text-surface-500 block mb-0.5"
  return (
    <div className="flex items-end gap-2 flex-wrap">
      <div>
        <label className={lbl}>Format</label>
        <SelectDropdown value={options.outputFormat} onChange={(v) => setOptions({ outputFormat: v })} items={[
          { label: 'Lossy', options: [
            { value: 'mp3', label: 'MP3' }, { value: 'aac', label: 'AAC' }, { value: 'm4a', label: 'M4A' },
            { value: 'ogg', label: 'OGG' }, { value: 'opus', label: 'Opus' },
          ]},
          { label: 'Lossless', options: [
            { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV' }, { value: 'aiff', label: 'AIFF' },
          ]},
        ]} />
      </div>
      <div>
        <label className={lbl}>Stream</label>
        <input type="number" min="0" max="10" value={options.streamIndex}
          onChange={(e) => setOptions({ streamIndex: parseInt(e.target.value, 10) || 0 })}
          className="w-14 bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50 hover:border-white/[0.12] transition-colors" />
      </div>
      <div>
        <label className={lbl}>Bitrate</label>
        <SelectDropdown value={options.audioBitrate || ''} onChange={(v) => setOptions({ audioBitrate: v })} items={[
          { value: '', label: 'Auto' },
          { label: 'Common', options: [
            { value: '128k', label: '128k' }, { value: '192k', label: '192k' }, { value: '256k', label: '256k' }, { value: '320k', label: '320k' },
          ]},
        ]} />
      </div>
      <div>
        <label className={lbl}>Sample Rate</label>
        <SelectDropdown value={options.sampleRate || ''} onChange={(v) => setOptions({ sampleRate: v })} items={[
          { value: '', label: 'Original' },
          { value: '44100', label: '44.1k' }, { value: '48000', label: '48k' }, { value: '96000', label: '96k' },
        ]} />
      </div>
      <div>
        <label className={lbl}>Channels</label>
        <SelectDropdown value={options.channels || ''} onChange={(v) => setOptions({ channels: v })} items={[
          { value: '', label: 'Original' }, { value: 'mono', label: 'Mono' }, { value: 'stereo', label: 'Stereo' },
        ]} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Compress                                                           */
/* ------------------------------------------------------------------ */

function CompressConfig({ options, setOptions }: {
  options: CompressOptions; setOptions: (o: Partial<CompressOptions>) => void
}): React.JSX.Element {
  const lbl = "text-2xs text-surface-500 block mb-0.5"
  const codec = options.videoCodec || 'libx264'
  const QUALITY_PRESETS: Record<string, { speed: string; audioBitrate: string }> = {
    lossless: { speed: 'veryslow', audioBitrate: '' },
    high: { speed: 'slow', audioBitrate: '256k' },
    medium: { speed: 'medium', audioBitrate: '192k' },
    low: { speed: 'fast', audioBitrate: '128k' },
  }
  const CRF_INFO: Record<string, Record<string, number>> = {
    libx264: { lossless: 0, high: 18, medium: 23, low: 28 },
    libx265: { lossless: 0, high: 22, medium: 28, low: 33 },
    'libvpx-vp9': { lossless: 0, high: 24, medium: 31, low: 38 },
    'libaom-av1': { lossless: 0, high: 22, medium: 28, low: 35 },
  }
  const crfVal = (CRF_INFO[codec] || CRF_INFO.libx264)[options.quality] ?? 23

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5">
          {(['lossless', 'high', 'medium', 'low'] as const).map((q) => (
            <button key={q} onClick={() => setOptions({ quality: q, ...QUALITY_PRESETS[q] })}
              className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                options.quality === q
                  ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/50 border border-transparent'
              }`}
            >
              {q.charAt(0).toUpperCase() + q.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-2xs text-surface-600 font-mono">CRF {crfVal}</span>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <label className={lbl}>Encoder</label>
          <SelectDropdown value={codec} onChange={(v) => setOptions({ videoCodec: v })} items={[
            { value: 'libx264', label: 'H.264' }, { value: 'libx265', label: 'H.265' },
            { value: 'libvpx-vp9', label: 'VP9' }, { value: 'libaom-av1', label: 'AV1' },
          ]} />
        </div>
        <div>
          <label className={lbl}>Speed</label>
          <SelectDropdown value={options.speed || 'medium'} onChange={(v) => setOptions({ speed: v })} items={[
            { value: 'veryfast', label: 'Very Fast' }, { value: 'fast', label: 'Fast' },
            { value: 'medium', label: 'Medium' }, { value: 'slow', label: 'Slow' }, { value: 'veryslow', label: 'Very Slow' },
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio</label>
          <SelectDropdown value={options.audioBitrate || ''} onChange={(v) => setOptions({ audioBitrate: v })} items={[
            { value: '', label: 'Auto' }, { value: '128k', label: '128k' }, { value: '192k', label: '192k' },
            { value: '256k', label: '256k' }, { value: '320k', label: '320k' },
          ]} />
        </div>
        <div>
          <label className={lbl}>Target MB</label>
          <input type="number" min="0" value={options.targetSizeMB}
            onChange={(e) => setOptions({ targetSizeMB: parseFloat(e.target.value) || 0 })}
            className="w-16 bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50 hover:border-white/[0.12] transition-colors"
            title="0 = use CRF quality" />
        </div>
      </div>
    </div>
  )
}
