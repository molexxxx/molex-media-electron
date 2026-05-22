/**
 * @module components/batch/OperationPanel
 * @description Compact operation selector with sleek inline config.
 * Selects the default operation+options that new files get stamped with.
 */

import React, { useMemo, useState, useRef, useEffect } from 'react'
import { useAppStore, BUILTIN_PRESETS, BUILTIN_BOOST_PRESETS, BUILTIN_COMPRESS_PRESETS, BUILTIN_EXTRACT_PRESETS } from '../../../stores/appStore'
import type { Operation, ConvertOptions, ExtractOptions, CompressOptions, CompressionLevel, DownmixMode, BoostOptions, CompressPreset, ExtractPreset } from '../../../stores/types'
import {
  PRESET_CATEGORIES, ALL_PRESETS,
  detectConvertConflicts, codecLabel, isLosslessCodec, isGpuAcceleratable,
  isSlowEncodeCodec, isAudioOnlyFormat,
  type ConvertPreset, type ConflictWarning, type PresetCategory
} from '../presets'
import { PresetDropdown } from './PresetDropdown'
import { SelectDropdown } from './SelectDropdown'
import { PresetIcon } from './PresetIcons'
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

function getBoostSummary(pct: number, opts?: BoostOptions): string {
  const db = pct === -100 ? '-∞' : (20 * Math.log10(1 + pct / 100)).toFixed(1)
  const dbStr = pct === 0 ? '0.0' : (pct > 0 ? '+' : '') + db
  const extras: string[] = []
  if (opts?.limiter) extras.push(`Lim ${opts.limiterCeiling} dBTP`)
  if (opts?.hpfHz && opts.hpfHz > 0) extras.push(`HPF ${opts.hpfHz}Hz`)
  const tail = extras.length ? ` · ${extras.join(' · ')}` : ''
  return `${pct > 0 ? '+' : ''}${pct}% (${dbStr} dB)${tail}`
}

function getConvertSummary(o: ConvertOptions): string {
  return `${o.outputFormat.toUpperCase()} · ${o.videoCodec === 'copy' ? 'Copy' : o.videoCodec} / ${o.audioCodec === 'copy' ? 'Copy' : o.audioCodec}`
}

function getExtractSummary(o: ExtractOptions, preset?: string | null): string {
  const p = preset ? BUILTIN_EXTRACT_PRESETS.find((x) => x.id === preset) : null
  if (p) return p.name
  const mode = o.mode || 'audio'
  if (mode === 'audio') return `Audio → ${o.outputFormat.toUpperCase()}${o.audioBitrate ? ` @ ${o.audioBitrate}` : ''}`
  if (mode === 'video') return `Silent Video${o.videoReencode ? ' (H.264)' : ' (copy)'}`
  if (mode === 'gif') return `GIF ${o.gifWidth || 480}w @ ${o.gifFps || 12}fps`
  if (mode === 'frames') return `Frames (${o.framesMode || 'interval'}, ${(o.frameFormat || 'png').toUpperCase()})`
  if (mode === 'subtitles') return `Subtitles → ${o.outputFormat.toUpperCase()}`
  return `→ ${o.outputFormat.toUpperCase()}`
}

function getCompressSummary(o: CompressOptions, preset?: string | null): string {
  const p = preset ? BUILTIN_COMPRESS_PRESETS.find((x) => x.id === preset) : null
  if (p) return p.name
  const mode = o.mode === 'target-size' || (o.mode == null && o.targetSizeMB > 0)
  if (mode) return `Target ${o.targetSizeMB} MB${o.twoPass ? ' · 2-pass' : ''}`
  const q = o.quality.charAt(0).toUpperCase() + o.quality.slice(1)
  return `${q}${o.quality === 'custom' && o.customCrf != null ? ` CRF ${o.customCrf}` : ''}`
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
    boostOptions, setBoostOptions,
    selectedBoostPreset, setSelectedBoostPreset,
    selectedConvertPreset, setSelectedConvertPreset,
    selectedCompressPreset, setSelectedCompressPreset,
    selectedExtractPreset, setSelectedExtractPreset,
    selectedPreset, setSelectedPreset,
    normalizeOptions, setNormalizeOptions,
    convertOptions, setConvertOptions,
    extractOptions, setExtractOptions,
    compressOptions, setCompressOptions,
  } = useAppStore()

  const [expanded, setExpanded] = useState(true)

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

  const handleApplyCompressPreset = (presetId: string) => {
    const p = BUILTIN_COMPRESS_PRESETS.find((x) => x.id === presetId)
    if (p) setCompressOptions(p.options)
    setSelectedCompressPreset(presetId)
    setOperation('compress')
  }

  const handleApplyExtractPreset = (presetId: string) => {
    const p = BUILTIN_EXTRACT_PRESETS.find((x) => x.id === presetId)
    if (p) setExtractOptions(p.options)
    setSelectedExtractPreset(presetId || null)
    setOperation('extract')
  }

  const conflicts = useMemo(() =>
    operation === 'convert' ? detectConvertConflicts(convertOptions) : [],
    [operation, convertOptions]
  )

  // Summary line for current operation
  const summary = (() => {
    switch (operation) {
      case 'normalize': return getNormalizeSummary(selectedPreset, normalizeOptions.I, normalizeOptions.TP, normalizeOptions.LRA)
      case 'boost': return getBoostSummary(boostPercent, boostOptions)
      case 'convert': return getConvertSummary(convertOptions)
      case 'extract': return getExtractSummary(extractOptions, selectedExtractPreset)
      case 'compress': return getCompressSummary(compressOptions, selectedCompressPreset)
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
            <BoostConfig
              boostPercent={boostPercent}
              setBoostPercent={setBoostPercent}
              boostOptions={boostOptions}
              setBoostOptions={setBoostOptions}
              selectedBoostPreset={selectedBoostPreset}
              setSelectedBoostPreset={setSelectedBoostPreset}
            />
          )}
          {operation === 'convert' && (
            <ConvertConfig
              options={convertOptions}
              setOptions={setConvertOptions}
              conflicts={conflicts}
              selectedConvertPreset={selectedConvertPreset}
              setSelectedConvertPreset={setSelectedConvertPreset}
            />
          )}
          {operation === 'extract' && (
            <ExtractConfig
              options={extractOptions}
              setOptions={setExtractOptions}
              selectedExtractPreset={selectedExtractPreset}
              onApplyPreset={handleApplyExtractPreset}
            />
          )}
          {operation === 'compress' && (
            <CompressConfig
              options={compressOptions}
              setOptions={setCompressOptions}
              selectedCompressPreset={selectedCompressPreset}
              onApplyPreset={handleApplyCompressPreset}
            />
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Preset header — full-width description card + separator           */
/* ------------------------------------------------------------------ */

function PresetHeader({ name, description, icon }: { name: string; description: string; icon?: string }): React.JSX.Element {
  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gradient-to-r from-accent-500/[0.08] via-accent-500/[0.04] to-transparent border border-accent-500/15">
        <div className="w-7 h-7 rounded-md bg-accent-500/15 border border-accent-500/30 flex items-center justify-center shrink-0 text-accent-300">
          {icon
            ? <PresetIcon name={icon} size={14} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><circle cx="12" cy="8" r="0.5" fill="currentColor" />
              </svg>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xs uppercase tracking-wider text-accent-400/80 font-semibold leading-tight">{name}</div>
          <p className="text-xs text-surface-300 leading-snug truncate">{description}</p>
        </div>
      </div>
      <div className="h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent" />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Normalize                                                          */
/* ------------------------------------------------------------------ */

export function NormalizeConfig({ selectedPreset, onApplyPreset }: {
  selectedPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  const { normalizeOptions, setNormalizeOptions, setSelectedPreset, config } = useAppStore()
  const [advanced, setAdvanced] = useState(false)

  const compression: CompressionLevel = (normalizeOptions.compression as CompressionLevel) ?? 'off'
  const downmix: DownmixMode = (normalizeOptions.downmix as DownmixMode) ?? 'keep'
  const tpClipRisk = normalizeOptions.TP > -1

  const COMPRESSION_OPTIONS: { id: CompressionLevel; label: string; tip: string }[] = [
    { id: 'off', label: 'Off', tip: 'No dynamic range compression.' },
    { id: 'light', label: 'Light', tip: 'Gentle 2:1 compression. Smooths volume invisibly.' },
    { id: 'medium', label: 'Medium', tip: 'Best for most movies. Tames action, lifts dialog.' },
    { id: 'heavy', label: 'Heavy', tip: 'Late-night mode. Whispers stay audible.' },
  ]
  const DOWNMIX_OPTIONS: { id: DownmixMode; label: string; tip: string }[] = [
    { id: 'keep', label: 'Keep', tip: 'Preserve original channel layout.' },
    { id: 'stereo', label: 'Stereo', tip: 'Plain stereo downmix.' },
    { id: 'dialog-stereo', label: 'Dialog stereo', tip: 'Stereo downmix with center channel boosted +3 dB.' },
  ]

  const activeNormalizePreset = selectedPreset ? BUILTIN_PRESETS.find((x) => x.id === selectedPreset) : null

  return (
    <div className="flex flex-col gap-3">
      {activeNormalizePreset && <PresetHeader name={activeNormalizePreset.name} description={activeNormalizePreset.description} icon={activeNormalizePreset.icon} />}
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
      {/* Left column — chips, info strip, controls, advanced sliders */}
      <div className="flex-1 min-w-0 space-y-2.5">
        {/* Preset chips */}
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
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                selectedPreset === p.id
                  ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
              }`}
            >
              {p.icon && <PresetIcon name={p.icon} size={12} />}
              {p.name}
            </button>
          ))}
        </div>

        {/* Info strip */}
        <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
          <FixedTip label="Integrated loudness target (LUFS). -23 = broadcast, -16 = TV/podcast, -14 = streaming." wide inline>
            <span className="font-mono cursor-help">I={normalizeOptions.I} LUFS</span>
          </FixedTip>
          <FixedTip label="True peak ceiling (dBTP). -1 is broadcast safe. Above -1 risks clipping on lossy codecs." wide inline>
            <span className="font-mono cursor-help">TP={normalizeOptions.TP} dBTP</span>
          </FixedTip>
          <FixedTip label="Loudness range target (LU). Lower = more compressed feel. 6-9 movie dialog, 11 TV, 15+ wide." wide inline>
            <span className="font-mono cursor-help">LRA={normalizeOptions.LRA} LU</span>
          </FixedTip>
          {compression !== 'off' && (
            <FixedTip label="Dynamic range compression applied after loudness normalization." wide inline>
              <span className="font-mono text-accent-400/80 cursor-help">DRC:{compression}</span>
            </FixedTip>
          )}
          {downmix !== 'keep' && (
            <FixedTip label="Channel layout strategy. Dialog stereo boosts the center channel." wide inline>
              <span className="font-mono text-accent-400/80 cursor-help">{downmix}</span>
            </FixedTip>
          )}
          {selectedPreset && (() => {
            const p = BUILTIN_PRESETS.find((x) => x.id === selectedPreset)
            if (!p) return null
            const codec = selectedPreset === 'defaults' && config ? config.audioCodec : p.audioCodec
            const bitrate = selectedPreset === 'defaults' && config ? config.audioBitrate : p.audioBitrate
            return <>
              <span className="text-surface-600">·</span>
              <span className="font-mono">{codec.toUpperCase()} {bitrate}</span>
            </>
          })()}
        </div>

        {/* Compression + Downmix segmented controls (always visible) */}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <div className="flex flex-col gap-1">
            <FixedTip label="Applied after loudness normalization. Reduces the gap between loud action and quiet dialog." wide inline>
              <span className="text-2xs text-surface-500 cursor-help">Dynamic compression</span>
            </FixedTip>
            <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden w-fit">
              {COMPRESSION_OPTIONS.map((o) => (
                <FixedTip key={o.id} label={o.tip} wide inline>
                  <button type="button"
                    onClick={() => { setNormalizeOptions({ compression: o.id }); setSelectedPreset(null) }}
                    className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                      compression === o.id ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                    }`}
                  >{o.label}</button>
                </FixedTip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <FixedTip label="How multichannel input is rendered. 'Dialog stereo' lifts the center channel for clearer speech." wide inline>
              <span className="text-2xs text-surface-500 cursor-help">Channel layout</span>
            </FixedTip>
            <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden w-fit">
              {DOWNMIX_OPTIONS.map((o) => (
                <FixedTip key={o.id} label={o.tip} wide inline>
                  <button type="button"
                    onClick={() => { setNormalizeOptions({ downmix: o.id }); setSelectedPreset(null) }}
                    className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                      downmix === o.id ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                    }`}
                  >{o.label}</button>
                </FixedTip>
              ))}
            </div>
          </div>
        </div>

        {/* Advanced: sliders + safer TP stepper */}
        {advanced && (
          <div className="space-y-2 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <NormalizeSlider label="Loudness" unit="LUFS" value={normalizeOptions.I}
                min={-30} max={-5} step={0.5}
                tip="Integrated loudness target (LUFS). -23 broadcast, -16 TV/podcast, -14 streaming music."
                onChange={(v) => { setNormalizeOptions({ I: v }); setSelectedPreset(null) }} />
              <NormalizeSlider label="LRA" unit="LU" value={normalizeOptions.LRA}
                min={1} max={25} step={0.5}
                tip="Loudness range. Lower = more compressed feel. 6-9 for movie dialog, 11 TV, 15+ wide dynamics."
                onChange={(v) => { setNormalizeOptions({ LRA: v }); setSelectedPreset(null) }} />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <FixedTip label="Maximum allowed peak in dBTP. -1 is the broadcast-safe target. Above -1 risks inter-sample clipping on lossy codecs." wide inline>
                <span className="text-2xs text-surface-500 cursor-help">True Peak ceiling</span>
              </FixedTip>
              <div className="inline-flex items-center rounded-md border border-white/[0.06] bg-surface-900/60 overflow-hidden">
                <button type="button" aria-label="Lower true peak ceiling"
                  onClick={() => { setNormalizeOptions({ TP: Math.max(-9, +(normalizeOptions.TP - 0.5).toFixed(1)) }); setSelectedPreset(null) }}
                  className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
                >−</button>
                <span className="px-2 text-2xs font-mono text-surface-200 min-w-[3.5rem] text-center">{normalizeOptions.TP.toFixed(1)} dBTP</span>
                <button type="button" aria-label="Raise true peak ceiling"
                  onClick={() => { setNormalizeOptions({ TP: Math.min(0, +(normalizeOptions.TP + 0.5).toFixed(1)) }); setSelectedPreset(null) }}
                  className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
                >+</button>
              </div>
              {tpClipRisk && (
                <FixedTip label="At ceilings above -1 dBTP, lossy re-encoding may produce inter-sample peaks that clip on consumer hardware." wide inline>
                  <span className="inline-flex items-center gap-1 text-2xs text-amber-300/90 cursor-help">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    Clipping risk
                  </span>
                </FixedTip>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right column — Advanced toggle + preset description */}
      <div className="w-full md:w-72 lg:w-80 md:shrink-0 flex flex-col-reverse md:flex-col gap-2">
        <button
          onClick={() => setAdvanced(!advanced)}
          className={`w-full md:w-auto md:self-end text-2xs px-2 py-1.5 md:py-1 rounded-md border transition-all ${
            advanced
              ? 'text-accent-300 bg-accent-600/20 border-accent-500/30'
              : 'text-surface-500 border-white/[0.06] hover:text-surface-200 hover:bg-surface-800/40 hover:border-white/[0.1]'
          }`}
        >
          Advanced
        </button>
      </div>
      </div>
    </div>
  )
}

function NormalizeSlider({ label, unit, value, min, max, step, tip, onChange }: {
  label: string; unit: string; value: number; min: number; max: number; step: number
  tip?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        {tip ? (
          <FixedTip label={tip} wide inline>
            <span className="text-2xs text-surface-500 cursor-help">{label}</span>
          </FixedTip>
        ) : (
          <span className="text-2xs text-surface-500">{label}</span>
        )}
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

const HPF_OPTIONS: { id: number; label: string; tip: string }[] = [
  { id: 0,   label: 'Off',     tip: 'No high-pass filter. Preserves the full low end.' },
  { id: 20,  label: '20 Hz',   tip: 'Removes DC offset and sub-audible rumble below human hearing. Safe for music.' },
  { id: 60,  label: '60 Hz',   tip: 'Cuts room rumble and mains hum. Recommended for spoken voice.' },
  { id: 100, label: '100 Hz',  tip: 'Aggressive low-cut for phone-recorded or noisy speech. Removes more rumble at the cost of fullness.' },
]

const BOOST_STEPS = [-50, -25, 0, 25, 50, 100, 200]

/**
 * Default boostOptions when the host hasn't initialized them yet (legacy
 * file rows). Mirrors the store default.
 */
const DEFAULT_BOOST_OPTIONS: BoostOptions = {
  percent: 10, limiter: true, limiterCeiling: -1, hpfHz: 0
}

export function BoostConfig({
  boostPercent, setBoostPercent,
  boostOptions, setBoostOptions,
  selectedBoostPreset, setSelectedBoostPreset,
}: {
  boostPercent: number
  setBoostPercent: (v: number) => void
  boostOptions?: BoostOptions
  setBoostOptions?: (opts: Partial<BoostOptions>) => void
  selectedBoostPreset?: string | null
  setSelectedBoostPreset?: (id: string | null) => void
}): React.JSX.Element {
  const opts: BoostOptions = boostOptions ?? { ...DEFAULT_BOOST_OPTIONS, percent: boostPercent }
  const presetId = selectedBoostPreset ?? null
  const [advanced, setAdvanced] = useState(false)

  const isBoost = boostPercent > 0
  const isReduce = boostPercent < 0
  const fillPct = ((boostPercent + 50) / 250) * 100

  // dB equivalent of the current percent (20·log10(1+pct/100)).
  const dbLabel = boostPercent === -100
    ? '-∞ dB'
    : `${boostPercent > 0 ? '+' : boostPercent === 0 ? '' : ''}${(20 * Math.log10(1 + boostPercent / 100)).toFixed(1)} dB`

  // Clipping risk: any positive boost without the limiter, or a limiter
  // ceiling above -0.3 dBTP on a loud-ish source.
  const clipRisk = boostPercent > 30 && !opts.limiter
  const highRisk = boostPercent > 100 && !opts.limiter

  const applyPreset = (id: string) => {
    const p = BUILTIN_BOOST_PRESETS.find((x) => x.id === id)
    if (!p) return
    setBoostPercent(p.options.percent)
    if (setBoostOptions) setBoostOptions(p.options)
    if (setSelectedBoostPreset) setSelectedBoostPreset(id)
  }

  const setCustom = () => {
    if (setSelectedBoostPreset) setSelectedBoostPreset(null)
  }

  const activeBoostPreset = presetId ? BUILTIN_BOOST_PRESETS.find((x) => x.id === presetId) : null

  return (
    <div className="flex flex-col gap-3">
      {activeBoostPreset && <PresetHeader name={activeBoostPreset.name} description={activeBoostPreset.description} icon={activeBoostPreset.icon} />}
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
      {/* Left column */}
      <div className="flex-1 min-w-0 space-y-2.5">
        {/* Preset chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {presetId === null && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
              Custom
              <button onClick={() => applyPreset('gentle-lift')} className="hover:text-white transition-colors">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </span>
          )}
          {BUILTIN_BOOST_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                presetId === p.id
                  ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                  : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
              }`}
            >
              {p.icon && <PresetIcon name={p.icon} size={12} />}
              {p.name}
            </button>
          ))}
        </div>

        {/* Info strip */}
        <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
          <FixedTip label="Linear volume change as a percentage. +100% doubles the amplitude (≈+6 dB)." wide inline>
            <span className={`font-mono cursor-help font-semibold ${
              isBoost ? 'text-green-400' : isReduce ? 'text-amber-400' : 'text-surface-300'
            }`}>{boostPercent > 0 ? '+' : ''}{boostPercent}%</span>
          </FixedTip>
          <FixedTip label="dB equivalent. +6 dB ≈ ×2 amplitude. -6 dB ≈ ×0.5. Audio engineers think in dB; consumers think in percent." wide inline>
            <span className="font-mono text-surface-500 cursor-help">{dbLabel}</span>
          </FixedTip>
          {opts.limiter && (
            <FixedTip label="Brick-wall true-peak limiter applied after the gain stage. Prevents clipping when boost exceeds available headroom." wide inline>
              <span className="font-mono text-accent-400/80 cursor-help">Lim:{opts.limiterCeiling} dBTP</span>
            </FixedTip>
          )}
          {opts.hpfHz > 0 && (
            <FixedTip label="High-pass filter applied before the gain stage. Removes inaudible low-frequency energy that would otherwise consume headroom." wide inline>
              <span className="font-mono text-accent-400/80 cursor-help">HPF:{opts.hpfHz}Hz</span>
            </FixedTip>
          )}
          {clipRisk && (
            <FixedTip label="Positive boost without a limiter can clip on loud peaks. Enable the limiter in Advanced for safety." wide inline>
              <span className="inline-flex items-center gap-1 cursor-help text-amber-400/90">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                {highRisk ? 'High clip risk' : 'Clip risk'}
              </span>
            </FixedTip>
          )}
        </div>

        {/* Quick-step row */}
        <div className="flex items-center gap-1 flex-wrap">
          <FixedTip label="Snap to a common boost amount." wide inline>
            <span className="text-2xs text-surface-500 mr-1 cursor-help">Quick:</span>
          </FixedTip>
          {BOOST_STEPS.map((v) => (
            <button key={v} onClick={() => { setBoostPercent(v); setCustom() }}
              className={`px-2 py-0.5 text-2xs rounded transition-colors ${
                boostPercent === v ? 'bg-accent-600 text-white' : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/60'
              }`}
            >
              {v > 0 ? `+${v}` : v}%
            </button>
          ))}
        </div>

        {/* Smooth slider (no transitions on drag for instant feedback) */}
        <BoostSlider
          value={boostPercent}
          isBoost={isBoost}
          isReduce={isReduce}
          fillPct={fillPct}
          onChange={(v) => { setBoostPercent(v); setCustom() }}
        />

        {/* Advanced — limiter + HPF */}
        {advanced && setBoostOptions && (
          <div className="space-y-2.5 pt-1">
            {/* Limiter row */}
            <div className="flex items-center gap-3 flex-wrap">
              <FixedTip label="Append a brick-wall true-peak limiter after the gain stage so peaks never exceed the ceiling. Required for any aggressive boost." wide inline>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={opts.limiter}
                    onChange={(e) => { setBoostOptions({ limiter: e.target.checked }); setCustom() }}
                    className="accent-accent-500"
                  />
                  <span className="text-2xs text-surface-300">Peak limiter</span>
                </label>
              </FixedTip>
              {opts.limiter && (
                <div className="inline-flex items-center gap-2">
                  <FixedTip label="True-peak ceiling for the limiter. -1 dBTP is broadcast-safe; -0.3 maximizes loudness; -3 leaves extra headroom for downstream processing." wide inline>
                    <span className="text-2xs text-surface-500 cursor-help">Ceiling</span>
                  </FixedTip>
                  <div className="inline-flex items-center rounded-md border border-white/[0.06] bg-surface-900/60 overflow-hidden">
                    <button type="button" aria-label="Lower ceiling"
                      onClick={() => { setBoostOptions({ limiterCeiling: Math.max(-6, +(opts.limiterCeiling - 0.1).toFixed(1)) }); setCustom() }}
                      className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
                    >−</button>
                    <span className="px-2 text-2xs font-mono text-surface-200 min-w-[3.5rem] text-center">{opts.limiterCeiling.toFixed(1)} dBTP</span>
                    <button type="button" aria-label="Raise ceiling"
                      onClick={() => { setBoostOptions({ limiterCeiling: Math.min(0, +(opts.limiterCeiling + 0.1).toFixed(1)) }); setCustom() }}
                      className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
                    >+</button>
                  </div>
                </div>
              )}
            </div>

            {/* HPF segmented control */}
            <div className="flex flex-col gap-1">
              <FixedTip label="High-pass filter applied BEFORE the gain stage. Removes sub-audible content that would otherwise eat headroom and force the limiter to clamp audible signal." wide inline>
                <span className="text-2xs text-surface-500 cursor-help">High-pass filter</span>
              </FixedTip>
              <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden w-fit">
                {HPF_OPTIONS.map((o) => (
                  <FixedTip key={o.id} label={o.tip} wide inline>
                    <button type="button"
                      onClick={() => { setBoostOptions({ hpfHz: o.id }); setCustom() }}
                      className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                        opts.hpfHz === o.id ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                      }`}
                    >{o.label}</button>
                  </FixedTip>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right column — Advanced toggle + preset description */}
      <div className="w-full md:w-72 lg:w-80 md:shrink-0 flex flex-col-reverse md:flex-col gap-2">
        <button
          onClick={() => setAdvanced(!advanced)}
          className={`w-full md:w-auto md:self-end text-2xs px-2 py-1.5 md:py-1 rounded-md border transition-all ${
            advanced
              ? 'text-accent-300 bg-accent-600/20 border-accent-500/30'
              : 'text-surface-500 border-white/[0.06] hover:text-surface-200 hover:bg-surface-800/40 hover:border-white/[0.1]'
          }`}
        >
          Advanced
        </button>
      </div>
      </div>
    </div>
  )
}

/**
 * Boost slider — smooth, no-transition drag. Internally uncontrolled while
 * dragging so the React render loop doesn't introduce per-frame jitter; we
 * commit the final value to the store on `change` (release).
 */
function BoostSlider({ value, isBoost, isReduce, fillPct, onChange }: {
  value: number; isBoost: boolean; isReduce: boolean; fillPct: number
  onChange: (v: number) => void
}): React.JSX.Element {
  const [localValue, setLocalValue] = useState(value)
  const draggingRef = useRef(false)

  // Mirror external value into local when not actively dragging.
  useEffect(() => {
    if (!draggingRef.current) setLocalValue(value)
  }, [value])

  const displayValue = draggingRef.current ? localValue : value
  const displayFill = ((displayValue + 50) / 250) * 100
  const displayIsBoost = displayValue > 0
  const displayIsReduce = displayValue < 0
  void fillPct; void isBoost; void isReduce // (already derived below for the static info strip)

  return (
    <div className="relative group select-none">
      <div className="h-1.5 rounded-full bg-surface-800/80 overflow-hidden">
        <div className={`h-full rounded-full ${
          displayIsBoost ? 'bg-linear-to-r from-accent-600 to-accent-400' :
          displayIsReduce ? 'bg-linear-to-r from-amber-600 to-amber-400' : 'bg-surface-600'
        }`} style={{ width: `${Math.max(0, Math.min(100, displayFill))}%` }} />
      </div>
      <input
        type="range" min={-50} max={200} step={1}
        value={displayValue}
        onPointerDown={() => { draggingRef.current = true }}
        onPointerUp={() => { draggingRef.current = false; onChange(localValue) }}
        onPointerCancel={() => { draggingRef.current = false }}
        onInput={(e) => {
          const v = parseInt((e.currentTarget as HTMLInputElement).value, 10)
          setLocalValue(v)
        }}
        onChange={(e) => {
          // Keyboard / click moves (no pointerdown) — commit immediately.
          if (!draggingRef.current) onChange(parseInt(e.target.value, 10))
        }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      />
      <div
        className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 shadow pointer-events-none ${
          displayIsBoost ? 'bg-accent-400 border-accent-300' : displayIsReduce ? 'bg-amber-400 border-amber-300' : 'bg-surface-300 border-surface-200'
        }`}
        style={{ left: `calc(${Math.max(0, Math.min(100, displayFill))}% - 6px)` }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Convert                                                            */
/* ------------------------------------------------------------------ */

/**
 * Subset of categories surfaced as preset chips (top of card). Long-tail
 * containers / specialty presets stay reachable through the full preset
 * dropdown.
 */
const QUICK_CONVERT_PRESETS = [
  'mp4-h264', 'mkv-hevc', 'webm-vp9', 'mp3-320', 'discord', 'youtube'
]

export function ConvertConfig({
  options, setOptions, conflicts,
  selectedConvertPreset, setSelectedConvertPreset
}: {
  options: ConvertOptions
  setOptions: (o: Partial<ConvertOptions>) => void
  conflicts: ConflictWarning[]
  selectedConvertPreset?: string | null
  setSelectedConvertPreset?: (id: string | null) => void
}): React.JSX.Element {
  const presetId = selectedConvertPreset ?? null
  const [advanced, setAdvanced] = useState(false)

  const applyPreset = (preset: ConvertPreset) => {
    setOptions(preset.options as Partial<ConvertOptions>)
    if (setSelectedConvertPreset) setSelectedConvertPreset(preset.id)
  }
  const setCustom = (partial: Partial<ConvertOptions>) => {
    setOptions(partial)
    if (setSelectedConvertPreset) setSelectedConvertPreset(null)
  }

  const fmt = options.outputFormat
  const audioOnly = isAudioOnlyFormat(fmt)
  const vc = options.videoCodec
  const ac = options.audioCodec
  const losslessV = isLosslessCodec(vc, 'video')
  const losslessA = isLosslessCodec(ac, 'audio')
  const gpuEligible = isGpuAcceleratable(vc)
  const slowEncode = isSlowEncodeCodec(vc)
  const errorCount = conflicts.filter((c) => c.type === 'error').length

  const lbl = 'text-2xs text-surface-500 block mb-0.5'

  const activeConvertPreset = presetId ? ALL_PRESETS.find((x) => x.id === presetId) : null

  return (
    <div className="flex flex-col gap-3">
      {activeConvertPreset && <PresetHeader name={activeConvertPreset.label} description={activeConvertPreset.description} icon={activeConvertPreset.icon} />}
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
      {/* Left column */}
      <div className="flex-1 min-w-0 space-y-2.5">
        {/* Preset chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {presetId === null && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
              Custom
              <button
                onClick={() => {
                  const p = ALL_PRESETS.find((x) => x.id === 'mp4-h264')
                  if (p) applyPreset(p)
                }}
                className="hover:text-white transition-colors"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          )}
          {/* Active preset from outside the quick row — surfaced as a highlighted chip so the row never looks "nothing selected". */}
          {presetId !== null && !QUICK_CONVERT_PRESETS.includes(presetId) && (() => {
            const active = ALL_PRESETS.find((x) => x.id === presetId)
            if (!active) return null
            return (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 text-2xs font-medium rounded-lg bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm">
                {active.label}
              </span>
            )
          })()}
          {QUICK_CONVERT_PRESETS.map((id) => {
            const p = ALL_PRESETS.find((x) => x.id === id)
            if (!p) return null
            return (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                  presetId === p.id
                    ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                    : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
                }`}
              >
                {p.label}
              </button>
            )
          })}
          <PresetDropdown
            categories={PRESET_CATEGORIES}
            activeId={presetId ?? ''}
            onSelect={(p) => { if (!p.id) { if (setSelectedConvertPreset) setSelectedConvertPreset(null); return } applyPreset(p) }}
            triggerLabel="More"
            compact
          />
        </div>

        {/* Info strip */}
        <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
          <FixedTip label="Output container. Determines the file extension and which codecs are legal." wide inline>
            <span className="font-mono cursor-help font-semibold text-surface-200">{fmt.toUpperCase()}</span>
          </FixedTip>
          {!audioOnly && (
            <FixedTip
              label={`Video codec. ${losslessV ? 'Lossless / pass-through — bitrate is ignored.' : 'Lossy encode.'}${gpuEligible ? ' GPU acceleration available when enabled in settings.' : ''}`}
              wide
              inline
            >
              <span className="font-mono text-accent-400/80 cursor-help">V:{codecLabel(vc)}</span>
            </FixedTip>
          )}
          <FixedTip label={`Audio codec.${losslessA ? ' Lossless / pass-through — bitrate is ignored.' : ''}`} wide inline>
            <span className="font-mono text-accent-400/80 cursor-help">A:{codecLabel(ac)}</span>
          </FixedTip>
          {!audioOnly && options.videoBitrate && !losslessV && (
            <FixedTip label="Target video bitrate. Higher = better quality + larger file. Ignored when codec is Copy or a lossless codec." wide inline>
              <span className="font-mono text-surface-500 cursor-help">{options.videoBitrate}</span>
            </FixedTip>
          )}
          {options.audioBitrate && options.audioBitrate !== '0' && !losslessA && (
            <FixedTip label="Target audio bitrate. 128k acceptable, 192k good, 256k transparent for most listeners." wide inline>
              <span className="font-mono text-surface-500 cursor-help">{options.audioBitrate}</span>
            </FixedTip>
          )}
          {(losslessV || losslessA) && (
            <FixedTip label="At least one stream is lossless — output is bit-exact for that stream. Bitrate dropdowns are ignored." wide inline>
              <span className="inline-flex items-center gap-1 cursor-help text-emerald-400/90">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Lossless
              </span>
            </FixedTip>
          )}
          {gpuEligible && !losslessV && (
            <FixedTip label="This codec can be hardware-accelerated (NVENC / QSV / AMF) when GPU acceleration is enabled in settings. Encodes much faster, sometimes at slightly lower quality per bit." wide inline>
              <span className="font-mono text-accent-400/70 cursor-help">GPU</span>
            </FixedTip>
          )}
          {slowEncode && (
            <FixedTip label="This codec is known to be slow on CPU (often 5–10× slower than H.264). The app isn't hung — give it time, or pick H.264 / H.265 for faster encodes." wide inline>
              <span className="inline-flex items-center gap-1 cursor-help text-amber-400/80">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Slow encode
              </span>
            </FixedTip>
          )}
          {errorCount > 0 && (
            <FixedTip label="One or more codec/container combinations are invalid for this format. FFmpeg will refuse to mux. Fix the conflicts below." wide inline>
              <span className="inline-flex items-center gap-1 cursor-help text-red-400/90">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                {errorCount} conflict{errorCount === 1 ? '' : 's'}
              </span>
            </FixedTip>
          )}
        </div>

        {/* Basic controls — format + codecs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div>
            <FixedTip label="Output container format. Video containers (MP4, MKV, WebM…) carry both streams; audio containers (MP3, FLAC, WAV…) discard video." wide inline>
              <label className={`${lbl} cursor-help`}>Format</label>
            </FixedTip>
            <SelectDropdown value={fmt} onChange={(v) => setCustom({ outputFormat: v })} className="w-full" items={[
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
          {!audioOnly && (
            <div>
              <FixedTip label="Video codec. H.264 = universal. H.265/HEVC ≈ 50% smaller at same quality but slower. VP9/AV1 = royalty-free. ProRes/FFV1/UT Video = mastering / archival." wide inline>
                <label className={`${lbl} cursor-help`}>Video Codec</label>
              </FixedTip>
              <SelectDropdown value={vc} onChange={(v) => setCustom({ videoCodec: v })} className="w-full" items={[
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
          )}
          <div>
            <FixedTip label="Audio codec. AAC = compatible default. Opus = best quality at low bitrate. FLAC/ALAC/PCM = lossless. AC3/E-AC3 = surround." wide inline>
              <label className={`${lbl} cursor-help`}>Audio Codec</label>
            </FixedTip>
            <SelectDropdown value={ac} onChange={(v) => setCustom({ audioCodec: v })} className="w-full" items={[
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
        </div>

        {/* Advanced — bitrates / resolution / framerate */}
        {advanced && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 pt-1">
            <div>
              <FixedTip label="Audio bitrate target. 128k = streaming default, 192k = high quality, 256k = transparent, 320k = audiophile MP3. Ignored when audio codec is Copy or lossless." wide inline>
                <label className={`${lbl} cursor-help`}>Audio Bitrate</label>
              </FixedTip>
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
            {!audioOnly && (
              <>
                <div>
                  <FixedTip label="Video bitrate target. 1080p H.264 ≈ 5–8 Mbps for good quality. H.265 needs ~half that. Ignored when video codec is Copy or lossless." wide inline>
                    <label className={`${lbl} cursor-help`}>Video Bitrate</label>
                  </FixedTip>
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
                  <FixedTip label="Output resolution. Leave on Original to preserve source dimensions. Requires a re-encode codec (not Copy)." wide inline>
                    <label className={`${lbl} cursor-help`}>Resolution</label>
                  </FixedTip>
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
                  <FixedTip label="Output framerate. 23.976/29.97/59.94 = NTSC broadcast. 24 = cinema. 25/50 = PAL broadcast. Leave on Original unless you need a specific cadence." wide inline>
                    <label className={`${lbl} cursor-help`}>Framerate</label>
                  </FixedTip>
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
              </>
            )}
          </div>
        )}

        {/* Conflict warnings */}
        {conflicts.length > 0 && (
          <div className="space-y-1 pt-1">
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

      {/* Right column — Advanced toggle + preset description */}
      <div className="w-full md:w-72 lg:w-80 md:shrink-0 flex flex-col-reverse md:flex-col gap-2">
        <button
          onClick={() => setAdvanced(!advanced)}
          className={`w-full md:w-auto md:self-end text-2xs px-2 py-1.5 md:py-1 rounded-md border transition-all ${
            advanced
              ? 'text-accent-300 bg-accent-600/20 border-accent-500/30'
              : 'text-surface-500 border-white/[0.06] hover:text-surface-200 hover:bg-surface-800/40 hover:border-white/[0.1]'
          }`}
        >
          Advanced
        </button>
      </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Extract                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Extract                                                            */
/* ------------------------------------------------------------------ */

const EXTRACT_PRESET_CATEGORIES: { id: ExtractPreset['category']; label: string }[] = [
  { id: 'Audio',     label: 'Audio' },
  { id: 'Video',     label: 'Video' },
  { id: 'GIF',       label: 'GIF' },
  { id: 'Frames',    label: 'Frames' },
  { id: 'Subtitles', label: 'Subs' },
]

const EXTRACT_MODES: { id: NonNullable<ExtractOptions['mode']>; label: string; tip: string }[] = [
  { id: 'audio',     label: 'Audio',     tip: 'Pull an audio stream into a standalone file (MP3, FLAC, etc.).' },
  { id: 'video',     label: 'Video',     tip: 'Strip audio, keep the video track. Stream-copy or H.264 re-encode.' },
  { id: 'gif',       label: 'GIF',       tip: 'Render a section to an optimized GIF using palettegen + paletteuse.' },
  { id: 'frames',    label: 'Frames',    tip: 'Export still frames as PNG/JPG/WebP. Great for thumbnails or storyboards.' },
  { id: 'subtitles', label: 'Subs',      tip: 'Pull an embedded subtitle track to .srt / .vtt / .ass.' },
]

/** Map ExtractPreset category → ExtractOptions.mode. Used to drive quick chips off the active mode. */
const EXTRACT_CATEGORY_TO_MODE: Record<ExtractPreset['category'], NonNullable<ExtractOptions['mode']>> = {
  Audio: 'audio', Video: 'video', GIF: 'gif', Frames: 'frames', Subtitles: 'subtitles',
}

/** 2-3 most common presets per mode — shown as visible quick chips. Rest live in the "More" dropdown. */
const EXTRACT_QUICK_PRESETS: Record<NonNullable<ExtractOptions['mode']>, string[]> = {
  audio:     ['audio-mp3-320', 'audio-aac-256', 'audio-flac'],
  video:     ['video-silent-copy', 'video-silent-h264'],
  gif:       ['gif-web', 'gif-hq', 'gif-social'],
  frames:    ['frames-thumb', 'frames-every-sec', 'frames-scene-50'],
  subtitles: ['subs-srt', 'subs-vtt', 'subs-ass'],
}

/** Adapt the Extract preset library into the categorized shape the shared PresetDropdown expects. */
const EXTRACT_DROPDOWN_CATEGORIES: PresetCategory[] = EXTRACT_PRESET_CATEGORIES.map((cat) => ({
  label: cat.label,
  presets: BUILTIN_EXTRACT_PRESETS
    .filter((p) => p.category === cat.id)
    .map<ConvertPreset>((p) => ({
      id: p.id, label: p.name, description: p.description, icon: p.icon || '',
      options: p.options as unknown as Partial<ConvertOptions>,
    })),
})).filter((c) => c.presets.length > 0)

export function ExtractConfig({ options, setOptions, selectedExtractPreset, onApplyPreset }: {
  options: ExtractOptions
  setOptions: (o: Partial<ExtractOptions>) => void
  selectedExtractPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  const mode = options.mode || 'audio'

  const activePreset = selectedExtractPreset
    ? BUILTIN_EXTRACT_PRESETS.find((p) => p.id === selectedExtractPreset)
    : null

  /** Mutate options and clear the active preset (any manual edit = Custom). */
  const patch = (o: Partial<ExtractOptions>) => { setOptions(o); if (activePreset) onApplyPreset('') }

  /** Switch mode + reset to that mode's sensible defaults. */
  const switchMode = (next: NonNullable<ExtractOptions['mode']>) => {
    if (next === mode) return
    const defaults: Partial<ExtractOptions> = { mode: next }
    if (next === 'audio') {
      Object.assign(defaults, { outputFormat: 'mp3', audioBitrate: '320k', sampleRate: '', channels: '' })
    } else if (next === 'video') {
      Object.assign(defaults, { outputFormat: 'mp4', videoReencode: false, videoCrf: 20 })
    } else if (next === 'gif') {
      Object.assign(defaults, { outputFormat: 'gif', gifFps: 12, gifWidth: 480, gifDither: 'sierra2_4a', gifLoop: 0 })
    } else if (next === 'frames') {
      Object.assign(defaults, { outputFormat: 'png', framesMode: 'interval', frameInterval: 1, frameFormat: 'png' })
    } else if (next === 'subtitles') {
      Object.assign(defaults, { outputFormat: 'srt' })
    }
    patch(defaults)
  }

  /* ---- Rough GIF file-size estimate (very approximate) ---- */
  const gifEstimate = (() => {
    if (mode !== 'gif') return null
    const fps = options.gifFps || 12
    const width = options.gifWidth || 480
    // Empirical: ~0.00007 MB per pixel per frame for typical content.
    const perSec = width * (width * 9 / 16) * fps * 0.00000007
    return perSec > 0 ? Math.round(perSec * 10) / 10 : null
  })()

  const gifSizeWarn = gifEstimate != null && gifEstimate >= 1.0
  const trimActive = !!(options.startTime || options.duration)
  const videoCopyTip = mode === 'video' && !options.videoReencode

  const quickIds = EXTRACT_QUICK_PRESETS[mode] || []
  const activeIsQuick = !!selectedExtractPreset && quickIds.includes(selectedExtractPreset)
  const activeOffMode = !!activePreset && EXTRACT_CATEGORY_TO_MODE[activePreset.category] !== mode
  const showSubsTrim = false // subtitles never use trim
  const showTrimSection = mode !== 'audio' && !showSubsTrim
  const lblWide = 'text-2xs text-surface-500 block mb-0.5'

  return (
    <div className="flex flex-col gap-3">
      {activePreset && <PresetHeader name={activePreset.name} description={activePreset.description} icon={activePreset.icon} />}

      {/* Row 1 — Mode tabs + quick presets + More dropdown + Advanced toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Mode tabs */}
        <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden shrink-0">
          {EXTRACT_MODES.map((m) => (
            <FixedTip key={m.id} label={m.tip} wide inline>
              <button type="button"
                onClick={() => switchMode(m.id)}
                className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                  mode === m.id ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                }`}
              >{m.label}</button>
            </FixedTip>
          ))}
        </div>

        {/* Custom badge */}
        {!activePreset && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
            Custom
            <button onClick={() => onApplyPreset(quickIds[0] || 'audio-mp3-320')} className="hover:text-white transition-colors">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </span>
        )}

        {/* Active preset chip when the selection sits outside the visible quick row */}
        {activePreset && (!activeIsQuick || activeOffMode) && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm">
            {activePreset.icon && <PresetIcon name={activePreset.icon} size={11} />}{activePreset.name}
          </span>
        )}

        {/* Mode-aware quick chips */}
        {quickIds.map((id) => {
          const p = BUILTIN_EXTRACT_PRESETS.find((x) => x.id === id)
          if (!p) return null
          return (
            <FixedTip key={p.id} label={p.description} wide inline>
              <button onClick={() => onApplyPreset(p.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                  selectedExtractPreset === p.id
                    ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                    : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
                }`}
              >{p.icon && <PresetIcon name={p.icon} size={11} />}{p.name}</button>
            </FixedTip>
          )
        })}

        {/* All presets dropdown (categorized) */}
        <PresetDropdown
          categories={EXTRACT_DROPDOWN_CATEGORIES}
          activeId={selectedExtractPreset ?? ''}
          onSelect={(p) => { if (!p.id) { onApplyPreset(''); return } onApplyPreset(p.id) }}
          triggerLabel="More"
          compact
        />

        {/* Advanced toggle (right-aligned) — only when relevant */}
        {showTrimSection && (
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            className={`ml-auto text-2xs px-2 py-1 rounded-md border transition-all ${
              advanced
                ? 'text-accent-300 bg-accent-600/20 border-accent-500/30'
                : 'text-surface-500 border-white/[0.06] hover:text-surface-200 hover:bg-surface-800/40 hover:border-white/[0.1]'
            }`}
          >Advanced{trimActive ? ' • trim' : ''}</button>
        )}
      </div>

      {/* Validation pills */}
      {(videoCopyTip || (mode === 'video' && options.videoReencode) || gifSizeWarn || (mode === 'frames' && options.framesMode === 'count' && !trimActive)) && (
        <div className="flex items-center gap-1.5 flex-wrap text-2xs">
          {videoCopyTip && (
            <FixedTip label="Stream copy is instant and lossless. Container must accept the source codec." wide inline>
              <span className="text-2xs text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5 cursor-help">⚡ Lossless copy</span>
            </FixedTip>
          )}
          {mode === 'video' && options.videoReencode && (
            <span className="text-2xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">Re-encoding (slower)</span>
          )}
          {gifSizeWarn && (
            <FixedTip label="At these settings GIFs over ~5–10 MB are likely. Reduce width or fps for smaller files." wide inline>
              <span className="text-2xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 cursor-help">~{gifEstimate} MB/s est.</span>
            </FixedTip>
          )}
          {mode === 'frames' && options.framesMode === 'count' && !trimActive && (
            <FixedTip label="Without a duration, evenly-spaced count relies on the source's full length. Tip: add a start/duration trim for sub-clips." wide inline>
              <span className="text-2xs text-surface-400 bg-surface-800/60 border border-white/[0.06] rounded px-1.5 py-0.5 cursor-help">Full-duration sampling</span>
            </FixedTip>
          )}
        </div>
      )}

      {/* ---------------- Per-mode primary controls — responsive grid ---------------- */}

      {mode === 'audio' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          <div>
            <label className={lblWide}>Format</label>
            <SelectDropdown value={options.outputFormat} onChange={(v) => patch({ outputFormat: v })} className="w-full" items={[
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
            <label className={lblWide}>Stream</label>
            <input type="number" min="0" max="10" value={options.streamIndex}
              onChange={(e) => patch({ streamIndex: parseInt(e.target.value, 10) || 0 })}
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50 hover:border-white/[0.12] transition-colors" />
          </div>
          <div>
            <label className={lblWide}>Bitrate</label>
            <SelectDropdown value={options.audioBitrate || ''} onChange={(v) => patch({ audioBitrate: v })} className="w-full" items={[
              { value: '', label: 'Auto' },
              { label: 'Common', options: [
                { value: '96k', label: '96k' }, { value: '128k', label: '128k' }, { value: '192k', label: '192k' },
                { value: '256k', label: '256k' }, { value: '320k', label: '320k' },
              ]},
            ]} />
          </div>
          <div>
            <label className={lblWide}>Sample Rate</label>
            <SelectDropdown value={options.sampleRate || ''} onChange={(v) => patch({ sampleRate: v })} className="w-full" items={[
              { value: '', label: 'Original' },
              { value: '44100', label: '44.1k' }, { value: '48000', label: '48k' }, { value: '96000', label: '96k' },
            ]} />
          </div>
          <div>
            <label className={lblWide}>Channels</label>
            <SelectDropdown value={options.channels || ''} onChange={(v) => patch({ channels: v })} className="w-full" items={[
              { value: '', label: 'Original' }, { value: 'mono', label: 'Mono' }, { value: 'stereo', label: 'Stereo' },
            ]} />
          </div>
        </div>
      )}

      {mode === 'video' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <div>
            <label className={lblWide}>Container</label>
            <SelectDropdown value={options.outputFormat} onChange={(v) => patch({ outputFormat: v })} className="w-full" items={[
              { value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }, { value: 'mov', label: 'MOV' }, { value: 'webm', label: 'WebM' },
            ]} />
          </div>
          <div>
            <label className={lblWide}>Encoding</label>
            <SelectDropdown
              value={options.videoReencode ? 'reencode' : 'copy'}
              onChange={(v) => patch({ videoReencode: v === 'reencode' })}
              className="w-full"
              items={[
                { value: 'copy', label: 'Stream Copy (fastest)' },
                { value: 'reencode', label: 'Re-encode H.264' },
              ]} />
          </div>
          {options.videoReencode && (
            <div>
              <label className={lblWide}>CRF</label>
              <input type="number" min="0" max="51"
                value={options.videoCrf ?? 20}
                onChange={(e) => patch({ videoCrf: parseInt(e.target.value, 10) || 20 })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50 hover:border-white/[0.12] transition-colors" />
            </div>
          )}
        </div>
      )}

      {mode === 'gif' && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className={lblWide}>Width (px)</label>
            <input type="number" min="0" max="3840"
              value={options.gifWidth ?? 480}
              onChange={(e) => patch({ gifWidth: parseInt(e.target.value, 10) || 0 })}
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
          </div>
          <div>
            <label className={lblWide}>FPS</label>
            <input type="number" min="1" max="60"
              value={options.gifFps ?? 12}
              onChange={(e) => patch({ gifFps: parseInt(e.target.value, 10) || 12 })}
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
          </div>
          <div>
            <label className={lblWide}>Dither</label>
            <SelectDropdown value={options.gifDither || 'sierra2_4a'} onChange={(v) => patch({ gifDither: v as ExtractOptions['gifDither'] })} className="w-full" items={[
              { value: 'sierra2_4a', label: 'Sierra (best)' },
              { value: 'bayer', label: 'Bayer (small)' },
              { value: 'floyd_steinberg', label: 'Floyd-Steinberg' },
              { value: 'none', label: 'None' },
            ]} />
          </div>
          <div>
            <label className={lblWide}>Loop</label>
            <SelectDropdown
              value={String(options.gifLoop ?? 0)}
              onChange={(v) => patch({ gifLoop: parseInt(v, 10) })}
              className="w-full"
              items={[
                { value: '0', label: 'Infinite' },
                { value: '1', label: 'Once' },
                { value: '3', label: '3 times' },
              ]} />
          </div>
        </div>
      )}

      {mode === 'frames' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <div>
            <label className={lblWide}>Sampling</label>
            <SelectDropdown
              value={options.framesMode || 'interval'}
              onChange={(v) => patch({ framesMode: v as ExtractOptions['framesMode'] })}
              className="w-full"
              items={[
                { value: 'interval',  label: 'Every N seconds' },
                { value: 'fps',       label: 'Fixed FPS' },
                { value: 'count',     label: 'Evenly-spaced count' },
                { value: 'thumbnail', label: 'Single thumbnail' },
              ]} />
          </div>
          {(options.framesMode || 'interval') === 'interval' && (
            <div>
              <label className={lblWide}>Every (sec)</label>
              <input type="number" min="0.1" step="0.1"
                value={options.frameInterval ?? 1}
                onChange={(e) => patch({ frameInterval: parseFloat(e.target.value) || 1 })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
            </div>
          )}
          {options.framesMode === 'fps' && (
            <div>
              <label className={lblWide}>FPS</label>
              <input type="number" min="0.1" step="0.1"
                value={options.framesFps ?? 1}
                onChange={(e) => patch({ framesFps: parseFloat(e.target.value) || 1 })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
            </div>
          )}
          {options.framesMode === 'count' && (
            <div>
              <label className={lblWide}>Count</label>
              <input type="number" min="1" max="1000"
                value={options.frameCount ?? 25}
                onChange={(e) => patch({ frameCount: parseInt(e.target.value, 10) || 25 })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
            </div>
          )}
          <div>
            <label className={lblWide}>Format</label>
            <SelectDropdown
              value={options.frameFormat || 'png'}
              onChange={(v) => patch({ frameFormat: v as ExtractOptions['frameFormat'], outputFormat: v })}
              className="w-full"
              items={[
                { value: 'png',  label: 'PNG (lossless)' },
                { value: 'jpg',  label: 'JPG (smaller)' },
                { value: 'webp', label: 'WebP' },
              ]} />
          </div>
          {(options.frameFormat || 'png') === 'jpg' && (
            <div>
              <label className={lblWide}>JPG Quality</label>
              <input type="number" min="2" max="31"
                value={options.jpgQuality ?? 3}
                onChange={(e) => patch({ jpgQuality: parseInt(e.target.value, 10) || 3 })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
            </div>
          )}
        </div>
      )}

      {mode === 'subtitles' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div>
            <label className={lblWide}>Format</label>
            <SelectDropdown value={options.outputFormat} onChange={(v) => patch({ outputFormat: v })} className="w-full" items={[
              { value: 'srt', label: 'SRT' },
              { value: 'vtt', label: 'WebVTT' },
              { value: 'ass', label: 'ASS / SSA' },
            ]} />
          </div>
          <div>
            <label className={lblWide}>Stream</label>
            <input type="number" min="0" max="10" value={options.streamIndex}
              onChange={(e) => patch({ streamIndex: parseInt(e.target.value, 10) || 0 })}
              className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
          </div>
        </div>
      )}

      {/* Advanced (time trim) — collapsible */}
      {showTrimSection && advanced && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pl-3 border-l-2 border-white/[0.06]">
          <FixedTip label="Start offset. Accepts hh:mm:ss(.ms) or plain seconds. Empty = start of file." wide inline>
            <div>
              <label className={lblWide}>Start</label>
              <input type="text" placeholder="00:00:00"
                value={options.startTime || ''}
                onChange={(e) => patch({ startTime: e.target.value })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono focus:outline-none focus:border-accent-500/50" />
            </div>
          </FixedTip>
          <FixedTip label="Clip duration after start. hh:mm:ss(.ms) or seconds. Empty = run to end of source." wide inline>
            <div>
              <label className={lblWide}>Duration</label>
              <input type="text" placeholder="00:00:10"
                value={options.duration || ''}
                onChange={(e) => patch({ duration: e.target.value })}
                className="w-full bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-surface-200 font-mono focus:outline-none focus:border-accent-500/50" />
            </div>
          </FixedTip>
          {trimActive && (
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => patch({ startTime: '', duration: '' })}
                className="text-2xs text-surface-500 hover:text-amber-300 transition-colors px-2 py-1.5 border border-white/[0.06] rounded-lg hover:border-amber-500/30"
              >Clear trim</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Compress                                                           */
/* ------------------------------------------------------------------ */

/** Per-codec CRF lookup mirrored from the main-process processor. */
const COMPRESS_CRF_TABLE: Record<string, Record<string, number>> = {
  libx264:      { lossless: 0, high: 18, medium: 23, low: 28 },
  libx265:      { lossless: 0, high: 22, medium: 28, low: 33 },
  'libvpx-vp9': { lossless: 0, high: 24, medium: 31, low: 38 },
  'libaom-av1': { lossless: 0, high: 22, medium: 28, low: 35 },
  libsvtav1:    { lossless: 0, high: 24, medium: 30, low: 36 },
}

const COMPRESS_PRESET_CATEGORIES: { id: CompressPreset['category']; label: string }[] = [
  { id: 'Archive', label: 'Archive' },
  { id: 'Web',     label: 'Web' },
  { id: 'Mobile',  label: 'Mobile' },
  { id: 'Modern',  label: 'Modern' },
  { id: 'Special', label: 'Special' },
  { id: 'Audio',   label: 'Audio' },
]

/** A small curated set surfaced inline for one-click coverage of the most common deliveries. */
const QUICK_COMPRESS_PRESETS = ['web-1080p', 'web-720p', 'mobile-friendly', 'discord-25mb', 'archive-master']

/** Adapt the Compress preset library into the categorized shape the shared PresetDropdown expects. */
const COMPRESS_DROPDOWN_CATEGORIES: PresetCategory[] = COMPRESS_PRESET_CATEGORIES.map((cat) => ({
  label: cat.label,
  presets: BUILTIN_COMPRESS_PRESETS
    .filter((p) => p.category === cat.id)
    .map<ConvertPreset>((p) => ({
      id: p.id, label: p.name, description: p.description, icon: p.icon || '',
      options: p.options as unknown as Partial<ConvertOptions>,
    })),
})).filter((c) => c.presets.length > 0)

const COMPRESS_QUALITY_DEFAULTS: Record<string, Partial<CompressOptions>> = {
  lossless: { speed: 'veryslow', audioBitrate: '', audioCodec: 'flac' },
  high:     { speed: 'slow',     audioBitrate: '256k', audioCodec: 'aac' },
  medium:   { speed: 'medium',   audioBitrate: '192k', audioCodec: 'aac' },
  low:      { speed: 'fast',     audioBitrate: '128k', audioCodec: 'aac' },
}

export function CompressConfig({ options, setOptions, selectedCompressPreset, onApplyPreset }: {
  options: CompressOptions
  setOptions: (o: Partial<CompressOptions>) => void
  selectedCompressPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  const [advanced, setAdvanced] = useState(false)
  const codec = options.videoCodec || 'libx264'
  const isAv1OrVp9 = codec === 'libvpx-vp9' || codec === 'libaom-av1' || codec === 'libsvtav1'
  const supportsTune = codec === 'libx264' || codec === 'libx265'
  const is10Bit = options.pixelFormat === 'yuv420p10le'
  const effectiveMode: 'crf' | 'target-size' =
    options.mode === 'target-size' || (options.mode == null && options.targetSizeMB > 0)
      ? 'target-size' : 'crf'

  // CRF resolution (custom overrides table)
  const crfVal = options.quality === 'custom'
    ? options.customCrf ?? 23
    : (COMPRESS_CRF_TABLE[codec] || COMPRESS_CRF_TABLE.libx264)[options.quality] ?? 23

  const activePreset = selectedCompressPreset
    ? BUILTIN_COMPRESS_PRESETS.find((p) => p.id === selectedCompressPreset)
    : null

  // Clear preset when user manually changes settings
  const patch = (o: Partial<CompressOptions>) => { setOptions(o); if (activePreset) onApplyPreset('') }

  // Live target-size bitrate estimate (assumes 60s placeholder when no duration known)
  const estimatedKbps = (() => {
    if (effectiveMode !== 'target-size' || !options.targetSizeMB) return null
    // Use 60s reference for ballpark; actual encode uses real duration
    const audioKbps = parseInt(options.audioBitrate || '128k', 10) || 128
    const totalKbps = (options.targetSizeMB * 8 * 1024) / 60
    const videoKbps = Math.max(100, Math.round(totalKbps - audioKbps))
    return { video: videoKbps, audio: audioKbps }
  })()

  return (
    <div className="flex flex-col gap-3">
      {activePreset && <PresetHeader name={activePreset.name} description={activePreset.description} icon={activePreset.icon} />}
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
        {/* Left column */}
        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Preset selector — quick chips + categorized dropdown */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {!activePreset && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
                Custom
                <button onClick={() => onApplyPreset('web-1080p')} className="hover:text-white transition-colors">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </span>
            )}
            {/* Active preset chip when it isn't already in the quick row */}
            {activePreset && !QUICK_COMPRESS_PRESETS.includes(activePreset.id) && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm">
                {activePreset.icon && <PresetIcon name={activePreset.icon} size={11} />}{activePreset.name}
              </span>
            )}
            {QUICK_COMPRESS_PRESETS.map((id) => {
              const p = BUILTIN_COMPRESS_PRESETS.find((x) => x.id === id)
              if (!p) return null
              return (
                <FixedTip key={p.id} label={p.description} wide inline>
                  <button onClick={() => onApplyPreset(p.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                      selectedCompressPreset === p.id
                        ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                        : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
                    }`}
                  >{p.icon && <PresetIcon name={p.icon} size={11} />}{p.name}</button>
                </FixedTip>
              )
            })}
            <PresetDropdown
              categories={COMPRESS_DROPDOWN_CATEGORIES}
              activeId={selectedCompressPreset ?? ''}
              onSelect={(p) => { if (!p.id) { onApplyPreset(''); return } onApplyPreset(p.id) }}
              triggerLabel="More"
              compact
            />
          </div>

          {/* Mode toggle: Quality vs Target Size */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xs text-surface-500">Mode</span>
            <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden">
              <FixedTip label="Constant Rate Factor — target a perceptual quality level. Output size varies with content complexity." wide inline>
                <button type="button"
                  onClick={() => patch({ mode: 'crf', targetSizeMB: 0 })}
                  className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                    effectiveMode === 'crf' ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                  }`}
                >Quality (CRF)</button>
              </FixedTip>
              <FixedTip label="Target a specific file size. Best with two-pass encoding for accurate sizing." wide inline>
                <button type="button"
                  onClick={() => patch({ mode: 'target-size', targetSizeMB: options.targetSizeMB || 25 })}
                  className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                    effectiveMode === 'target-size' ? 'bg-accent-500/20 text-accent-200' : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                  }`}
                >Target Size</button>
              </FixedTip>
            </div>
            {effectiveMode === 'crf' && (
              <span className="text-2xs text-surface-600 font-mono">CRF {crfVal}</span>
            )}
            {effectiveMode === 'target-size' && estimatedKbps && (
              <FixedTip label="Estimated bitrate split. Actual encode uses real source duration." wide inline>
                <span className="text-2xs text-surface-600 font-mono cursor-help">
                  ≈ {estimatedKbps.video}k video / {estimatedKbps.audio}k audio
                </span>
              </FixedTip>
            )}
          </div>

          {/* Quality tier buttons (CRF mode) */}
          {effectiveMode === 'crf' && (
            <div className="flex items-center gap-1 flex-wrap">
              {(['lossless', 'high', 'medium', 'low', 'custom'] as const).map((q) => (
                <FixedTip key={q} label={
                  q === 'lossless' ? 'Mathematically perfect. Huge files. CRF 0.' :
                  q === 'high' ? 'Visually lossless on most sources. Recommended for archival.' :
                  q === 'medium' ? 'Standard web quality. Good size/quality balance.' :
                  q === 'low' ? 'Strong compression. Visible artifacts on detailed footage.' :
                  'Set your own CRF value with the slider below.'
                } wide inline>
                  <button onClick={() => patch(q === 'custom'
                    ? { quality: 'custom' }
                    : { quality: q, ...COMPRESS_QUALITY_DEFAULTS[q] })}
                    className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
                      options.quality === q
                        ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                        : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/50 border border-transparent'
                    }`}
                  >{q.charAt(0).toUpperCase() + q.slice(1)}</button>
                </FixedTip>
              ))}
            </div>
          )}

          {/* Custom CRF slider */}
          {effectiveMode === 'crf' && options.quality === 'custom' && (
            <div className="flex items-center gap-2">
              <span className="text-2xs text-surface-500 w-14">CRF</span>
              <input type="range" min={0} max={51} step={1}
                value={options.customCrf ?? 23}
                onChange={(e) => patch({ customCrf: parseInt(e.target.value, 10) })}
                className="flex-1 max-w-xs accent-accent-500" />
              <span className="text-2xs font-mono text-surface-300 w-8 text-center">{options.customCrf ?? 23}</span>
              <span className="text-2xs text-surface-600">
                {(options.customCrf ?? 23) <= 18 ? 'Visually lossless' :
                 (options.customCrf ?? 23) <= 23 ? 'High quality' :
                 (options.customCrf ?? 23) <= 28 ? 'Standard' :
                 (options.customCrf ?? 23) <= 33 ? 'Low' : 'Very low'}
              </span>
            </div>
          )}

          {/* Target size input */}
          {effectiveMode === 'target-size' && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-2xs text-surface-500 w-14">Size</span>
              <input type="number" min={1} value={options.targetSizeMB || ''}
                onChange={(e) => patch({ targetSizeMB: parseFloat(e.target.value) || 0 })}
                className="w-20 bg-surface-900/80 border border-white/[0.06] rounded-lg px-2 py-1 text-xs text-surface-200 font-mono text-center focus:outline-none focus:border-accent-500/50" />
              <span className="text-2xs text-surface-500">MB</span>
              <FixedTip label="Two-pass roughly doubles encoding time but hits the target size very accurately." wide inline>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={options.twoPass === true}
                    onChange={(e) => patch({ twoPass: e.target.checked })}
                    className="accent-accent-500" />
                  <span className="text-2xs text-surface-400">Two-pass (slower, accurate)</span>
                </label>
              </FixedTip>
              {estimatedKbps && estimatedKbps.video < 800 && (
                <FixedTip label="Very low video bitrate. Quality will suffer noticeably — consider a larger target or lower resolution." wide inline>
                  <span className="inline-flex items-center gap-1 text-2xs text-amber-300/90 cursor-help">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                    Low bitrate
                  </span>
                </FixedTip>
              )}
            </div>
          )}

          {/* Core controls: Encoder, Speed, Max Height, Audio */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <div>
              <label className="text-2xs text-surface-500 block mb-0.5">Encoder</label>
              <SelectDropdown className="w-full" value={codec} onChange={(v) => patch({ videoCodec: v })} items={[
                { value: 'libx264', label: 'H.264 — Universal' },
                { value: 'libx265', label: 'H.265 — Modern' },
                { value: 'libsvtav1', label: 'AV1 (SVT) — Fast' },
                { value: 'libaom-av1', label: 'AV1 (aom) — Reference' },
                { value: 'libvpx-vp9', label: 'VP9 — Web' },
              ]} />
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-0.5">Speed</label>
              <SelectDropdown className="w-full" value={options.speed || 'medium'} onChange={(v) => patch({ speed: v })} items={[
                { value: 'veryfast', label: 'Very Fast' }, { value: 'fast', label: 'Fast' },
                { value: 'medium', label: 'Medium' }, { value: 'slow', label: 'Slow' }, { value: 'veryslow', label: 'Very Slow' },
              ]} />
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-0.5">Max Height</label>
              <SelectDropdown className="w-full" value={String(options.maxHeight ?? 0)} onChange={(v) => patch({ maxHeight: parseInt(v, 10) })} items={[
                { value: '0', label: 'Source' }, { value: '2160', label: '2160p (4K)' },
                { value: '1440', label: '1440p (2K)' }, { value: '1080', label: '1080p' },
                { value: '720', label: '720p' }, { value: '480', label: '480p' },
              ]} />
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-0.5">Audio</label>
              <SelectDropdown className="w-full" value={options.audioCodec || 'aac'} onChange={(v) => patch({ audioCodec: v as CompressOptions['audioCodec'] })} items={[
                { value: 'aac', label: 'AAC' },
                { value: 'libopus', label: 'Opus' },
                { value: 'flac', label: 'FLAC (lossless)' },
                { value: 'copy', label: 'Copy stream' },
              ]} />
            </div>
            {options.audioCodec !== 'flac' && options.audioCodec !== 'copy' && (
              <div>
                <label className="text-2xs text-surface-500 block mb-0.5">A.Bitrate</label>
                <SelectDropdown className="w-full" value={options.audioBitrate || '192k'} onChange={(v) => patch({ audioBitrate: v })} items={[
                  { value: '96k', label: '96k' }, { value: '128k', label: '128k' },
                  { value: '160k', label: '160k' }, { value: '192k', label: '192k' },
                  { value: '256k', label: '256k' }, { value: '320k', label: '320k' },
                ]} />
              </div>
            )}
          </div>

          {/* Advanced: pixel format + tune */}
          {advanced && (
            <div className="pt-1">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div>
                  <label className="text-2xs text-surface-500 block mb-0.5">Pixel Format</label>
                  <SelectDropdown className="w-full" value={options.pixelFormat || 'yuv420p'} onChange={(v) => patch({ pixelFormat: v })} items={[
                    { value: 'yuv420p', label: '8-bit (yuv420p)' },
                    { value: 'yuv420p10le', label: '10-bit (yuv420p10le)' },
                  ]} />
                </div>
                {supportsTune && (
                  <div>
                    <label className="text-2xs text-surface-500 block mb-0.5">Tune</label>
                    <SelectDropdown className="w-full" value={options.tune || ''} onChange={(v) => patch({ tune: v })} items={[
                      { value: '', label: 'None' },
                      { value: 'film', label: 'Film (live action)' },
                      { value: 'animation', label: 'Animation' },
                      { value: 'grain', label: 'Grain (film grain)' },
                      { value: 'fastdecode', label: 'Fast decode' },
                      { value: 'zerolatency', label: 'Zero latency' },
                    ]} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Validation hint pills */}
          <div className="flex items-center gap-1.5 flex-wrap text-2xs">
            {isAv1OrVp9 && (
              <FixedTip label="AV1/VP9 cannot live in MP4 containers in older players. Use MKV or WebM for best compatibility." wide inline>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-300 border border-blue-500/25 cursor-help">
                  Use MKV/WebM container
                </span>
              </FixedTip>
            )}
            {is10Bit && (
              <FixedTip label="10-bit yuv420p10le reduces banding on gradients and HDR-prone footage. Slightly slower and not all hardware decodes it." wide inline>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-purple-500/15 text-purple-300 border border-purple-500/25 cursor-help">
                  10-bit color
                </span>
              </FixedTip>
            )}
            {options.tune === 'fastdecode' && (
              <FixedTip label="fastdecode trades a little efficiency for easier playback on older or low-power devices." wide inline>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-teal-500/15 text-teal-300 border border-teal-500/25 cursor-help">
                  Optimized for old devices
                </span>
              </FixedTip>
            )}
            {options.tune === 'grain' && (
              <FixedTip label="grain preserves film-grain texture instead of smoothing it away — best for film transfers." wide inline>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/25 cursor-help">
                  Grain preserved
                </span>
              </FixedTip>
            )}
            {effectiveMode === 'target-size' && options.twoPass && (
              <FixedTip label="Two-pass encoding analyzes the file first, then encodes — much more accurate target size." wide inline>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent-500/15 text-accent-300 border border-accent-500/25 cursor-help">
                  2-pass · ~2× encode time
                </span>
              </FixedTip>
            )}
          </div>
        </div>

        {/* Right column — Advanced toggle */}
        <div className="w-full md:w-72 lg:w-80 md:shrink-0 flex flex-col-reverse md:flex-col gap-2">
          <button
            onClick={() => setAdvanced(!advanced)}
            className={`w-full md:w-auto md:self-end text-2xs px-2 py-1.5 md:py-1 rounded-md border transition-all ${
              advanced
                ? 'text-accent-300 bg-accent-600/20 border-accent-500/30'
                : 'text-surface-500 border-white/[0.06] hover:text-surface-200 hover:bg-surface-800/40 hover:border-white/[0.1]'
            }`}
          >
            Advanced
          </button>
        </div>
      </div>
    </div>
  )
}
