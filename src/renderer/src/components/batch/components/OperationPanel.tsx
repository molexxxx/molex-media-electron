/**
 * @module components/batch/OperationPanel
 * @description Tab panel for selecting and configuring batch operations
 * (normalize, boost, convert, extract, compress).
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

/* ------------------------------------------------------------------ */
/*  Operation tabs                                                     */
/* ------------------------------------------------------------------ */

const OP_TABS: { id: Operation; label: string; icon: React.JSX.Element }[] = [
  { id: 'convert', label: 'Convert', icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
    </svg>
  )},
  { id: 'normalize', label: 'Normalize', icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 20h.01" /><path d="M7 20v-4" /><path d="M12 20v-8" /><path d="M17 20V8" /><path d="M22 4v16" />
    </svg>
  )},
  { id: 'boost', label: 'Volume', icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )},
  { id: 'compress', label: 'Compress', icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" /><path d="m8 17 4 4 4-4" />
    </svg>
  )},
  { id: 'extract', label: 'Extract', icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )},
]

export function OperationPanel({ onStart, startLabel }: {
  onStart: () => void
  startLabel: string
}): React.JSX.Element {
  const {
    files, operation, setOperation,
    boostPercent, setBoostPercent,
    selectedPreset, setSelectedPreset,
    normalizeOptions, setNormalizeOptions,
    convertOptions, setConvertOptions,
    extractOptions, setExtractOptions,
    compressOptions, setCompressOptions,
    isProcessing
  } = useAppStore()

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
  const hasErrors = conflicts.some((c) => c.type === 'error')

  return (
    <div className="glass rounded-xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-white/5">
        {OP_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setOperation(tab.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-medium transition-all relative ${
              operation === tab.id
                ? 'text-accent-300'
                : 'text-surface-500 hover:text-surface-200'
            }`}
          >
            <span className={operation === tab.id ? 'text-accent-400' : 'text-surface-600'}>{tab.icon}</span>
            {tab.label}
            {operation === tab.id && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent-500 rounded-full" />
            )}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={onStart}
          disabled={files.length === 0 || isProcessing || hasErrors}
          title={hasErrors ? 'Fix configuration errors before processing' : undefined}
          className="px-4 py-2 mr-2 bg-accent-600 hover:bg-accent-500 disabled:bg-surface-700 disabled:text-surface-500 text-white text-xs font-semibold rounded-lg transition-all shadow-glow hover:shadow-glow-lg disabled:shadow-none"
        >
          {isProcessing ? 'Processing...' : startLabel}
        </button>
      </div>

      {/* Config area */}
      <div className="p-4">
        {operation === 'normalize' && (
          <NormalizeOptions selectedPreset={selectedPreset} onApplyPreset={handleApplyPreset} />
        )}
        {operation === 'boost' && (
          <BoostOptions boostPercent={boostPercent} setBoostPercent={setBoostPercent} />
        )}
        {operation === 'convert' && (
          <ConvertForm options={convertOptions} setOptions={setConvertOptions} conflicts={conflicts} />
        )}
        {operation === 'extract' && (
          <ExtractForm options={extractOptions} setOptions={setExtractOptions} />
        )}
        {operation === 'compress' && (
          <CompressForm options={compressOptions} setOptions={setCompressOptions} />
        )}
      </div>
    </div>
  )
}

function NormalizeOptions({ selectedPreset, onApplyPreset }: {
  selectedPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  const { normalizeOptions, setNormalizeOptions, setSelectedPreset, config } = useAppStore()
  const [advanced, setAdvanced] = useState(false)

  /** Clear custom overrides → revert to Defaults preset */
  const clearCustom = () => {
    onApplyPreset('defaults')
  }

  return (
    <div className="space-y-3">
      {/* Preset buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-2xs text-surface-500 mr-1">Preset</span>
        {selectedPreset === null && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-2xs font-medium rounded-lg bg-amber-600/20 text-amber-300 border border-amber-500/30">
            Custom
            <button
              onClick={clearCustom}
              className="ml-0.5 hover:text-white transition-colors"
              title="Reset to Defaults"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </span>
        )}
        {BUILTIN_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onApplyPreset(p.id)}
            className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
              selectedPreset === p.id
                ? 'bg-accent-600 text-white'
                : 'bg-surface-800/60 text-surface-400 hover:text-surface-200 hover:bg-surface-700/60'
            }`}
            title={p.description}
          >
            {p.name}
          </button>
        ))}
        <button
          onClick={() => setAdvanced(!advanced)}
          className={`ml-auto px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
            advanced
              ? 'bg-accent-600/20 text-accent-300 border border-accent-500/30'
              : 'bg-surface-800/60 text-surface-500 hover:text-surface-300 hover:bg-surface-700/60'
          }`}
        >
          Advanced
        </button>
      </div>

      {/* Info row */}
      <div className="flex items-center gap-4 text-xs text-surface-400 bg-surface-800/40 rounded-lg px-3 py-2">
        <span>I={normalizeOptions.I} LUFS</span>
        <span>TP={normalizeOptions.TP} dBTP</span>
        <span>LRA={normalizeOptions.LRA} LU</span>
        {selectedPreset && (() => {
          const p = BUILTIN_PRESETS.find((x) => x.id === selectedPreset)
          if (!p) return null
          const codec = selectedPreset === 'defaults' && config ? config.audioCodec : p.audioCodec
          const bitrate = selectedPreset === 'defaults' && config ? config.audioBitrate : p.audioBitrate
          return (
            <>
              <span className="text-surface-500">·</span>
              <span>{codec.toUpperCase()} {bitrate}</span>
              <span className="text-surface-500 ml-auto">{p.description}</span>
            </>
          )
        })()}
      </div>

      {/* Advanced sliders */}
      {advanced && (
        <div className="grid grid-cols-3 gap-4 bg-surface-800/30 rounded-lg p-3 border border-white/5">
          <NormalizeSlider
            label="Integrated Loudness"
            unit="LUFS"
            value={normalizeOptions.I}
            min={-30}
            max={-5}
            step={0.5}
            onChange={(v) => { setNormalizeOptions({ I: v }); setSelectedPreset(null) }}
          />
          <NormalizeSlider
            label="True Peak"
            unit="dBTP"
            value={normalizeOptions.TP}
            min={-3}
            max={0}
            step={0.1}
            onChange={(v) => { setNormalizeOptions({ TP: v }); setSelectedPreset(null) }}
          />
          <NormalizeSlider
            label="Loudness Range"
            unit="LU"
            value={normalizeOptions.LRA}
            min={1}
            max={25}
            step={0.5}
            onChange={(v) => { setNormalizeOptions({ LRA: v }); setSelectedPreset(null) }}
          />
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
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-surface-500">{label}</span>
        <span className="text-2xs font-mono font-semibold text-surface-300">{value} {unit}</span>
      </div>
      <div className="relative h-5 flex items-center cursor-pointer">
        {/* Visual track */}
        <div className="absolute left-0 right-0 h-1.5 rounded-full bg-surface-700">
          <div
            className="h-full rounded-full bg-accent-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* Thumb */}
        <div
          className="absolute w-3.5 h-3.5 rounded-full bg-accent-400 border-2 border-accent-300 shadow-lg shadow-accent-500/30 pointer-events-none"
          style={{ left: `calc(${pct}% - 7px)` }}
        />
        {/* Hidden native input */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="norm-slider"
        />
      </div>
      <div className="flex items-center justify-between text-2xs text-surface-600">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Volume Boost / Reduce                                              */
/* ------------------------------------------------------------------ */

function BoostOptions({ boostPercent, setBoostPercent }: {
  boostPercent: number
  setBoostPercent: (v: number) => void
}): React.JSX.Element {
  const isBoost = boostPercent > 0
  const isReduce = boostPercent < 0
  const fillPct = ((boostPercent + 50) / 250) * 100

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-surface-400">Volume</span>
          <span className={`text-xs font-semibold font-mono px-2 py-0.5 rounded-md ${
            isBoost ? 'bg-green-500/15 text-green-400' :
            isReduce ? 'bg-amber-500/15 text-amber-400' :
            'bg-surface-700/50 text-surface-400'
          }`}>
            {boostPercent > 0 ? '+' : ''}{boostPercent}%
          </span>
        </div>
        <div className="flex items-center gap-1">
          {[-50, -25, 0, 25, 50, 100, 200].map((v) => (
            <button
              key={v}
              onClick={() => setBoostPercent(v)}
              className={`px-1.5 py-0.5 text-2xs rounded transition-all ${
                boostPercent === v
                  ? 'bg-accent-600 text-white'
                  : 'text-surface-500 hover:text-surface-300 hover:bg-surface-700/60'
              }`}
            >
              {v > 0 ? `+${v}` : v}%
            </button>
          ))}
        </div>
      </div>

      {/* Custom range slider */}
      <div className="relative group">
        <div className="h-2 rounded-full bg-surface-800/80 border border-surface-700/50 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-150 ${
            isBoost ? 'bg-linear-to-r from-accent-600 to-accent-400' :
            isReduce ? 'bg-linear-to-r from-amber-600 to-amber-400' :
              'bg-surface-600'
            }`}
            style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }}
          />
        </div>
        <input
          type="range" min="-50" max="200" value={boostPercent}
          onChange={(e) => setBoostPercent(parseInt(e.target.value, 10))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        {/* Thumb indicator */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 shadow-lg pointer-events-none transition-all duration-150 ${
            isBoost ? 'bg-accent-400 border-accent-300 shadow-accent-500/30' :
            isReduce ? 'bg-amber-400 border-amber-300 shadow-amber-500/30' :
            'bg-surface-300 border-surface-200 shadow-surface-500/30'
          }`}
          style={{ left: `calc(${Math.max(0, Math.min(100, fillPct))}% - 7px)` }}
        />
      </div>

      <div className="flex items-center justify-between text-2xs text-surface-600">
        <span>−50% (Quieter)</span>
        <span>0%</span>
        <span>+200% (Louder)</span>
      </div>

      {/* Number input */}
      <div className="flex items-center gap-2">
        <span className="text-2xs text-surface-500">Custom value</span>
        <div className="flex items-center gap-1">
          <input type="number" value={boostPercent} onChange={(e) => setBoostPercent(parseInt(e.target.value, 10) || 0)}
            className="w-16 bg-surface-800/60 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono text-center focus:outline-none focus:border-accent-500 transition-colors" />
          <span className="text-xs text-surface-500">%</span>
        </div>
        {boostPercent > 100 && (
          <span className="text-2xs text-amber-400/80 ml-2">⚠ High boost may cause clipping</span>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Convert form with presets + optgroups + conflict warnings           */
/* ------------------------------------------------------------------ */

function ConvertForm({ options, setOptions, conflicts }: {
  options: ConvertOptions
  setOptions: (o: Partial<ConvertOptions>) => void
  conflicts: ConflictWarning[]
}): React.JSX.Element {
  const [activePresetId, setActivePresetId] = useState<string>('mp4-h264')

  const applyPreset = (preset: ConvertPreset) => {
    setActivePresetId(preset.id)
    setOptions(preset.options as Partial<ConvertOptions>)
  }

  // Clear active preset when user manually changes any option
  const setOptionsCustom = (partial: Partial<ConvertOptions>) => {
    setActivePresetId('')
    setOptions(partial)
  }

  const sel = "w-full"
  const lbl = "text-2xs text-surface-500 block mb-1"

  return (
    <div className="space-y-4">
      {/* Preset dropdown */}
      <div className="flex items-center gap-3">
        <label className="text-2xs text-surface-500 shrink-0">Preset</label>
        <PresetDropdown
          categories={PRESET_CATEGORIES}
          activeId={activePresetId}
          onSelect={(preset) => {
            if (!preset.id) { setActivePresetId(''); return }
            applyPreset(preset)
          }}
        />
        {activePresetId && (() => {
          const p = PRESET_CATEGORIES.flatMap((c) => c.presets).find((x) => x.id === activePresetId)
          return p ? <span className="text-2xs text-surface-500 truncate">{p.description}</span> : null
        })()}
      </div>

      {/* Separator */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-surface-700/40" />
        <span className="text-2xs text-surface-600 uppercase tracking-wider">Output Settings</span>
        <div className="flex-1 h-px bg-surface-700/40" />
      </div>

      {/* Manual options grid */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={lbl}>Output Format</label>
          <SelectDropdown value={options.outputFormat} onChange={(v) => setOptionsCustom({ outputFormat: v })} className={sel} items={[
            { label: 'Video', options: [
              { value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }, { value: 'mov', label: 'MOV' },
              { value: 'webm', label: 'WebM' }, { value: 'avi', label: 'AVI' }, { value: 'ts', label: 'MPEG-TS' },
              { value: 'flv', label: 'FLV' }, { value: 'wmv', label: 'WMV' }, { value: 'ogv', label: 'OGV' },
            ]},
            { label: 'Audio', options: [
              { value: 'mp3', label: 'MP3' }, { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV' },
              { value: 'm4a', label: 'M4A (AAC)' }, { value: 'aac', label: 'AAC (raw)' }, { value: 'ogg', label: 'OGG' },
              { value: 'opus', label: 'Opus' }, { value: 'ac3', label: 'AC3' }, { value: 'wma', label: 'WMA' },
              { value: 'aiff', label: 'AIFF' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Video Codec</label>
          <SelectDropdown value={options.videoCodec} onChange={(v) => setOptionsCustom({ videoCodec: v })} className={sel} items={[
            { label: 'Common', options: [
              { value: 'copy', label: 'Copy (no re-encode)' }, { value: 'libx264', label: 'H.264 / AVC' }, { value: 'libx265', label: 'H.265 / HEVC' },
            ]},
            { label: 'Modern', options: [
              { value: 'libvpx-vp9', label: 'VP9' }, { value: 'libaom-av1', label: 'AV1' },
            ]},
            { label: 'Professional', options: [
              { value: 'prores_ks', label: 'Apple ProRes' }, { value: 'ffv1', label: 'FFV1 (Lossless)' }, { value: 'utvideo', label: 'UT Video (Lossless)' },
            ]},
            { label: 'Legacy', options: [
              { value: 'mpeg4', label: 'MPEG-4 Part 2' }, { value: 'mpeg2video', label: 'MPEG-2' },
              { value: 'libtheora', label: 'Theora' }, { value: 'wmv2', label: 'WMV2' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Codec</label>
          <SelectDropdown value={options.audioCodec} onChange={(v) => setOptionsCustom({ audioCodec: v })} className={sel} items={[
            { label: 'Common', options: [
              { value: 'copy', label: 'Copy (no re-encode)' }, { value: 'aac', label: 'AAC' }, { value: 'libmp3lame', label: 'MP3' },
            ]},
            { label: 'Modern', options: [
              { value: 'libopus', label: 'Opus' }, { value: 'libvorbis', label: 'Vorbis' }, { value: 'flac', label: 'FLAC (Lossless)' },
            ]},
            { label: 'Surround / Broadcast', options: [
              { value: 'ac3', label: 'AC3 / Dolby Digital' }, { value: 'eac3', label: 'E-AC3 / Dolby Digital+' },
            ]},
            { label: 'Professional', options: [
              { value: 'alac', label: 'ALAC (Apple Lossless)' }, { value: 'pcm_s16le', label: 'PCM 16-bit' },
              { value: 'pcm_s24le', label: 'PCM 24-bit' }, { value: 'wmav2', label: 'WMA' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Bitrate</label>
          <SelectDropdown value={options.audioBitrate} onChange={(v) => setOptionsCustom({ audioBitrate: v })} className={sel} items={[
            { label: 'Common', options: [
              { value: '', label: 'Auto' }, { value: '96k', label: '96 kbps' }, { value: '128k', label: '128 kbps' },
              { value: '160k', label: '160 kbps' }, { value: '192k', label: '192 kbps' }, { value: '256k', label: '256 kbps' },
              { value: '320k', label: '320 kbps' },
            ]},
            { label: 'High Fidelity / Surround', options: [
              { value: '448k', label: '448 kbps' }, { value: '512k', label: '512 kbps' },
              { value: '640k', label: '640 kbps' }, { value: '0', label: 'Lossless' },
            ]},
            { label: 'Low Bitrate', options: [
              { value: '32k', label: '32 kbps' }, { value: '64k', label: '64 kbps' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Video Bitrate</label>
          <SelectDropdown value={options.videoBitrate} onChange={(v) => setOptionsCustom({ videoBitrate: v })} className={sel} items={[
            { label: 'Common', options: [
              { value: '', label: 'Auto' }, { value: '1000k', label: '1 Mbps' }, { value: '2500k', label: '2.5 Mbps' },
              { value: '5000k', label: '5 Mbps' }, { value: '8000k', label: '8 Mbps' }, { value: '10000k', label: '10 Mbps' },
            ]},
            { label: 'High Quality', options: [
              { value: '15000k', label: '15 Mbps' }, { value: '20000k', label: '20 Mbps' },
              { value: '25000k', label: '25 Mbps' }, { value: '35000k', label: '35 Mbps' }, { value: '50000k', label: '50 Mbps' },
            ]},
            { label: 'Low / Compact', options: [
              { value: '300k', label: '300 kbps' }, { value: '500k', label: '500 kbps' },
              { value: '800k', label: '800 kbps' }, { value: '1500k', label: '1.5 Mbps' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Resolution</label>
          <SelectDropdown value={options.resolution} onChange={(v) => setOptionsCustom({ resolution: v })} className={sel} items={[
            { value: '', label: 'Original' },
            { label: 'Standard (16:9)', options: [
              { value: '3840x2160', label: '4K (2160p)' }, { value: '2560x1440', label: '1440p (QHD)' },
              { value: '1920x1080', label: '1080p (Full HD)' }, { value: '1280x720', label: '720p (HD)' },
              { value: '854x480', label: '480p (SD)' }, { value: '640x360', label: '360p' }, { value: '426x240', label: '240p' },
            ]},
            { label: 'Vertical (9:16)', options: [
              { value: '1080x1920', label: '1080×1920 (Vertical HD)' }, { value: '720x1280', label: '720×1280 (Vertical)' },
            ]},
            { label: 'Square', options: [
              { value: '1080x1080', label: '1080×1080' }, { value: '720x720', label: '720×720' },
            ]},
            { label: 'Ultra', options: [
              { value: '7680x4320', label: '8K (4320p)' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Framerate</label>
          <SelectDropdown value={options.framerate} onChange={(v) => setOptionsCustom({ framerate: v })} className={sel} items={[
            { value: '', label: 'Original' },
            { label: 'Standard', options: [
              { value: '24', label: '24 fps (Film)' }, { value: '25', label: '25 fps (PAL)' },
              { value: '30', label: '30 fps (NTSC)' }, { value: '60', label: '60 fps (Smooth)' },
            ]},
            { label: 'Broadcast / Cinema', options: [
              { value: '23.976', label: '23.976 fps (NTSC Film)' }, { value: '29.97', label: '29.97 fps (NTSC)' },
              { value: '48', label: '48 fps (HFR Cinema)' }, { value: '50', label: '50 fps (PAL)' },
              { value: '59.94', label: '59.94 fps (NTSC)' },
            ]},
            { label: 'High Performance', options: [
              { value: '120', label: '120 fps' }, { value: '144', label: '144 fps' },
            ]},
            { label: 'Low', options: [
              { value: '12', label: '12 fps' }, { value: '15', label: '15 fps' },
            ]},
          ]} />
        </div>
      </div>

      {/* Conflict warnings */}
      {conflicts.length > 0 && (
        <div className="space-y-1.5 animate-fade-in">
          {conflicts.map((c, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                c.type === 'error'
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                  : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
              }`}
            >
              <span className="shrink-0 mt-0.5">
                {c.type === 'error' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                )}
              </span>
              <span>{c.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Extract — expanded with bitrate, sample rate, channels             */
/* ------------------------------------------------------------------ */

function ExtractForm({ options, setOptions }: {
  options: ExtractOptions
  setOptions: (o: Partial<ExtractOptions>) => void
}): React.JSX.Element {
  const lbl = "text-2xs text-surface-500 block mb-1"

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div>
          <label className={lbl}>Output Format</label>
          <SelectDropdown value={options.outputFormat} onChange={(v) => setOptions({ outputFormat: v })} items={[
            { label: 'Lossy', options: [
              { value: 'mp3', label: 'MP3' }, { value: 'aac', label: 'AAC' }, { value: 'm4a', label: 'M4A' },
              { value: 'ogg', label: 'OGG Vorbis' }, { value: 'opus', label: 'Opus' },
              { value: 'wma', label: 'WMA' }, { value: 'ac3', label: 'AC3' },
            ]},
            { label: 'Lossless', options: [
              { value: 'flac', label: 'FLAC' }, { value: 'wav', label: 'WAV (PCM)' }, { value: 'aiff', label: 'AIFF' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Stream</label>
          <input type="number" min="0" max="10" value={options.streamIndex}
            onChange={(e) => setOptions({ streamIndex: parseInt(e.target.value, 10) || 0 })}
            className="w-16 bg-surface-800/60 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono text-center focus:outline-none focus:border-accent-500 transition-colors" />
        </div>
        <div>
          <label className={lbl}>Bitrate</label>
          <SelectDropdown value={options.audioBitrate || ''} onChange={(v) => setOptions({ audioBitrate: v })} items={[
            { value: '', label: 'Auto (from config)' },
            { label: 'Common', options: [
              { value: '128k', label: '128 kbps' }, { value: '160k', label: '160 kbps' },
              { value: '192k', label: '192 kbps' }, { value: '256k', label: '256 kbps' }, { value: '320k', label: '320 kbps' },
            ]},
            { label: 'Low Bitrate', options: [
              { value: '64k', label: '64 kbps' }, { value: '96k', label: '96 kbps' },
            ]},
            { label: 'High Fidelity', options: [
              { value: '448k', label: '448 kbps' }, { value: '640k', label: '640 kbps' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Sample Rate</label>
          <SelectDropdown value={options.sampleRate || ''} onChange={(v) => setOptions({ sampleRate: v })} items={[
            { value: '', label: 'Original' },
            { label: 'Standard', options: [
              { value: '44100', label: '44.1 kHz (CD)' }, { value: '48000', label: '48 kHz (Video)' },
            ]},
            { label: 'High Resolution', options: [
              { value: '96000', label: '96 kHz (Hi-Res)' }, { value: '192000', label: '192 kHz (Studio)' },
            ]},
            { label: 'Low', options: [
              { value: '8000', label: '8 kHz (Telephone)' }, { value: '22050', label: '22.05 kHz' }, { value: '32000', label: '32 kHz' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Channels</label>
          <SelectDropdown value={options.channels || ''} onChange={(v) => setOptions({ channels: v })} items={[
            { value: '', label: 'Original' }, { value: 'mono', label: 'Mono' }, { value: 'stereo', label: 'Stereo' },
          ]} />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Compress — expanded with codec, speed, audio bitrate               */
/* ------------------------------------------------------------------ */

function CompressForm({ options, setOptions }: {
  options: CompressOptions
  setOptions: (o: Partial<CompressOptions>) => void
}): React.JSX.Element {
  const lbl = "text-2xs text-surface-500 block mb-1"

  const codec = options.videoCodec || 'libx264'

  /** Quality preset bundles — each quality level sets speed + audio bitrate */
  const QUALITY_PRESETS: Record<string, { speed: string; audioBitrate: string }> = {
    lossless: { speed: 'veryslow', audioBitrate: '' },
    high:     { speed: 'slow',     audioBitrate: '256k' },
    medium:   { speed: 'medium',   audioBitrate: '192k' },
    low:      { speed: 'fast',     audioBitrate: '128k' },
  }

  /** CRF values displayed as info */
  const CRF_INFO: Record<string, Record<string, number>> = {
    libx264:        { lossless: 0, high: 18, medium: 23, low: 28 },
    libx265:        { lossless: 0, high: 22, medium: 28, low: 33 },
    'libvpx-vp9':   { lossless: 0, high: 24, medium: 31, low: 38 },
    'libaom-av1':   { lossless: 0, high: 22, medium: 28, low: 35 },
  }
  const crfTable = CRF_INFO[codec] || CRF_INFO.libx264
  const crfVal = crfTable[options.quality] ?? 23

  return (
    <div className="space-y-4">
      {/* Quality presets */}
      <div className="flex items-center gap-3">
        <span className="text-2xs text-surface-500">Quality</span>
        <div className="flex items-center gap-1">
          {(['lossless', 'high', 'medium', 'low'] as const).map((q) => (
            <button
              key={q}
              onClick={() => setOptions({ quality: q, ...QUALITY_PRESETS[q] })}
              className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                options.quality === q
                  ? 'bg-accent-600 text-white'
                  : 'bg-surface-800/60 text-surface-400 hover:text-surface-200 hover:bg-surface-700/60'
              }`}
            >
              {q.charAt(0).toUpperCase() + q.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-2xs text-surface-600 ml-auto font-mono">CRF {crfVal}</span>
      </div>

      {/* Options row */}
      <div className="flex items-center gap-4 flex-wrap">
        <div>
          <label className={lbl}>Video Encoder</label>
          <SelectDropdown value={codec} onChange={(v) => setOptions({ videoCodec: v })} items={[
            { label: 'Common', options: [
              { value: 'libx264', label: 'H.264 / AVC' }, { value: 'libx265', label: 'H.265 / HEVC' },
            ]},
            { label: 'Modern', options: [
              { value: 'libvpx-vp9', label: 'VP9' }, { value: 'libaom-av1', label: 'AV1' },
            ]},
          ]} />
        </div>
        <div>
          <label className={lbl}>Encoding Speed</label>
          <SelectDropdown value={options.speed || 'medium'} onChange={(v) => setOptions({ speed: v })} items={[
            { value: 'veryfast', label: 'Very Fast (lower quality)' },
            { value: 'fast', label: 'Fast' },
            { value: 'medium', label: 'Medium (balanced)' },
            { value: 'slow', label: 'Slow (better quality)' },
            { value: 'veryslow', label: 'Very Slow (best quality)' },
          ]} />
        </div>
        <div>
          <label className={lbl}>Audio Bitrate</label>
          <SelectDropdown value={options.audioBitrate || ''} onChange={(v) => setOptions({ audioBitrate: v })} items={[
            { value: '', label: 'Auto (from quality)' },
            { value: '96k', label: '96 kbps' }, { value: '128k', label: '128 kbps' },
            { value: '192k', label: '192 kbps' }, { value: '256k', label: '256 kbps' }, { value: '320k', label: '320 kbps' },
          ]} />
        </div>
        <div>
          <label className={lbl}>Target Size (MB)</label>
          <input type="number" min="0" value={options.targetSizeMB}
            onChange={(e) => setOptions({ targetSizeMB: parseFloat(e.target.value) || 0 })}
            className="w-20 bg-surface-800/60 border border-surface-700 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono text-center focus:outline-none focus:border-accent-500 transition-colors"
            title="0 = use CRF quality. Set a value to target a specific file size" />
        </div>
      </div>
      {options.targetSizeMB > 0 && (
        <div className="text-2xs text-amber-400/80 flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          Target size mode overrides CRF — quality may vary. Set to 0 for quality-based encoding.
        </div>
      )}
    </div>
  )
}
