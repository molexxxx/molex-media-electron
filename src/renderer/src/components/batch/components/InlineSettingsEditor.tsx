import React, { useState, useMemo } from 'react'
import type { FileItem, Operation, NormalizeOptions, ConvertOptions, ExtractOptions, CompressOptions, CompressionLevel, DownmixMode, BoostOptions } from '../../../stores/types'
import { BUILTIN_COMPRESS_PRESETS, BUILTIN_EXTRACT_PRESETS } from '../../../stores/types'
import { BUILTIN_PRESETS } from '../../../stores/types'
import { useAppStore } from '../../../stores/appStore'
import { BoostConfig, ConvertConfig, ExtractConfig, CompressConfig } from './OperationPanel'
import { detectConvertConflicts } from '../presets'
import { FixedTip } from '../../shared/ui'

/* ------------------------------------------------------------------ */
/*  Tooltip helper                                                     */
/* ------------------------------------------------------------------ */

function InfoDot({ tip }: { tip: string }): React.JSX.Element {
  return (
    <FixedTip label={tip} wide inline>
      <span
        className="inline-flex items-center justify-center w-3 h-3 rounded-full text-2xs text-surface-500 hover:text-accent-300 border border-surface-600/60 cursor-help select-none"
        aria-label={tip}
      >
        <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <line x1="12" y1="10" x2="12" y2="17" /><circle cx="12" cy="6.5" r="0.5" fill="currentColor" />
        </svg>
      </span>
    </FixedTip>
  )
}

/* ------------------------------------------------------------------ */
/*  Safe slider with visible thumb (no draggable-row conflict)         */
/* ------------------------------------------------------------------ */

function SafeSlider({ value, min, max, step, onChange, ariaLabel }: {
  value: number; min: number; max: number; step: number
  onChange: (v: number) => void
  ariaLabel: string
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  // Stop drag/mousedown propagation so the parent row's HTML5 drag handle
  // never fires while the user is interacting with the slider.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div
      className="relative h-4 flex items-center"
      onMouseDown={stop}
      onPointerDown={stop}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
      draggable={false}
    >
      <div className="absolute left-0 right-0 h-1 rounded-full bg-surface-700 pointer-events-none">
        <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
      </div>
      <div
        className="absolute w-3 h-3 rounded-full bg-accent-400 border-2 border-accent-300 shadow-lg shadow-accent-500/30 pointer-events-none"
        style={{ left: `calc(${pct}% - 6px)` }}
      />
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="norm-slider"
        draggable={false}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline normalize editor (local-state version)                      */
/* ------------------------------------------------------------------ */

const COMPRESSION_OPTIONS: { id: CompressionLevel; label: string; tip: string }[] = [
  { id: 'off', label: 'Off', tip: 'No dynamic range compression. Preserves the original mix dynamics.' },
  { id: 'light', label: 'Light', tip: 'Gentle 2:1 compression. Smooths volume without sounding processed.' },
  { id: 'medium', label: 'Medium', tip: 'Tames loud action while keeping music musical. Best for most movies.' },
  { id: 'heavy', label: 'Heavy', tip: 'Aggressive 6:1 compression for late-night viewing. Whispers stay audible.' },
]

const DOWNMIX_OPTIONS: { id: DownmixMode; label: string; tip: string }[] = [
  { id: 'keep', label: 'Keep layout', tip: 'Preserve the original channel layout (e.g. 5.1, 7.1).' },
  { id: 'stereo', label: 'Stereo', tip: 'Plain stereo downmix using FFmpeg defaults.' },
  { id: 'dialog-stereo', label: 'Dialog stereo', tip: 'Stereo downmix with the center channel boosted +3 dB. Fixes mumbled 5.1 dialog on TV speakers.' },
]

function InlineNormalizeConfig({ normalizeOptions, setNormalizeOptions, selectedPreset, setSelectedPreset }: {
  normalizeOptions: NormalizeOptions
  setNormalizeOptions: (opts: NormalizeOptions) => void
  selectedPreset: string | null
  setSelectedPreset: (id: string | null) => void
}): React.JSX.Element {
  const { config } = useAppStore()

  const handleApplyPreset = (presetId: string) => {
    const preset = BUILTIN_PRESETS.find((p) => p.id === presetId)
    if (preset) {
      const norm = presetId === 'defaults' && config ? config.normalization : preset.normalization
      setNormalizeOptions({
        compression: 'off',
        downmix: 'keep',
        ...norm
      })
    }
    setSelectedPreset(presetId)
  }

  const compression: CompressionLevel = normalizeOptions.compression ?? 'off'
  const downmix: DownmixMode = normalizeOptions.downmix ?? 'keep'
  const tpClipRisk = normalizeOptions.TP > -1

  // Stop row-level HTML5 drag from anywhere inside the editor.
  const stopDrag = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation() }

  return (
    <div className="space-y-3" onDragStart={stopDrag}>
      {/* Preset chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {selectedPreset === null && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-2xs font-medium rounded-md bg-amber-600/20 text-amber-300 border border-amber-500/30">
            Custom
            <button onClick={() => handleApplyPreset('defaults')} className="hover:text-white transition-colors">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </span>
        )}
        {BUILTIN_PRESETS.map((p) => (
          <button key={p.id} onClick={() => handleApplyPreset(p.id)}
            className={`px-2.5 py-1 text-2xs font-medium rounded-lg transition-all ${
              selectedPreset === p.id
                ? 'bg-accent-500/20 text-accent-200 border border-accent-500/25 shadow-sm'
                : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50 border border-transparent'
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      {/* Preset description — elevated row */}
      {selectedPreset && (() => {
        const p = BUILTIN_PRESETS.find((x) => x.id === selectedPreset)
        if (!p) return null
        return (
          <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-accent-500/[0.04] border-l-2 border-accent-500/40">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-accent-400/80 mt-[1px] shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><circle cx="12" cy="8" r="0.5" fill="currentColor" />
            </svg>
            <p className="text-2xs text-surface-300 leading-relaxed italic">{p.description}</p>
          </div>
        )
      })()}

      {/* Info strip */}
      <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
        <span className="font-mono">I={normalizeOptions.I} LUFS</span>
        <span className="font-mono">TP={normalizeOptions.TP} dBTP</span>
        <span className="font-mono">LRA={normalizeOptions.LRA} LU</span>
        {compression !== 'off' && <span className="font-mono text-accent-400/80">DRC:{compression}</span>}
        {downmix !== 'keep' && <span className="font-mono text-accent-400/80">{downmix}</span>}
      </div>

      {/* Loudness + LRA sliders */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-surface-500 flex items-center gap-1">
              Loudness
              <InfoDot tip="Integrated loudness target (LUFS). -23 = broadcast, -16 = TV/podcast, -14 = streaming music. Higher (less negative) = louder." />
            </span>
            <span className="text-2xs font-mono font-semibold text-surface-300">{normalizeOptions.I} LUFS</span>
          </div>
          <SafeSlider
            value={normalizeOptions.I} min={-30} max={-5} step={0.5}
            ariaLabel="Integrated loudness target"
            onChange={(v) => { setNormalizeOptions({ ...normalizeOptions, I: v }); setSelectedPreset(null) }}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-surface-500 flex items-center gap-1">
              LRA
              <InfoDot tip="Loudness range (LU). Lower = more compressed feel. 6-9 = movie dialog rescue, 11 = TV, 15+ = wide dynamics (cinema, audiophile)." />
            </span>
            <span className="text-2xs font-mono font-semibold text-surface-300">{normalizeOptions.LRA} LU</span>
          </div>
          <SafeSlider
            value={normalizeOptions.LRA} min={1} max={25} step={0.5}
            ariaLabel="Loudness range target"
            onChange={(v) => { setNormalizeOptions({ ...normalizeOptions, LRA: v }); setSelectedPreset(null) }}
          />
        </div>
      </div>

      {/* True Peak: stepper (safer than a slider for clip-critical value) */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-2xs text-surface-500 flex items-center gap-1">
          True Peak ceiling
          <InfoDot tip="Maximum allowed peak in dBTP. -1 is the broadcast safe target. Values above -1 risk inter-sample clipping on lossy codecs." />
        </span>
        <div className="inline-flex items-center rounded-md border border-white/[0.06] bg-surface-900/60 overflow-hidden">
          <button
            type="button"
            onClick={() => { setNormalizeOptions({ ...normalizeOptions, TP: Math.max(-9, +(normalizeOptions.TP - 0.5).toFixed(1)) }); setSelectedPreset(null) }}
            className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
            aria-label="Lower true peak ceiling"
          >−</button>
          <span className="px-2 text-2xs font-mono text-surface-200 min-w-[3.5rem] text-center">{normalizeOptions.TP.toFixed(1)} dBTP</span>
          <button
            type="button"
            onClick={() => { setNormalizeOptions({ ...normalizeOptions, TP: Math.min(0, +(normalizeOptions.TP + 0.5).toFixed(1)) }); setSelectedPreset(null) }}
            className="px-2 py-0.5 text-surface-400 hover:text-white hover:bg-surface-800/50 transition-colors"
            aria-label="Raise true peak ceiling"
          >+</button>
        </div>
        {tpClipRisk && (
          <FixedTip label="At ceilings above -1 dBTP, lossy re-encoding (AAC, MP3, AC3) may produce inter-sample peaks that clip on consumer hardware." wide inline>
            <span className="inline-flex items-center gap-1 text-2xs text-amber-300/90 cursor-help">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Clipping risk
            </span>
          </FixedTip>
        )}
      </div>

      {/* Dynamic range compression */}
      <div className="space-y-1">
        <span className="text-2xs text-surface-500 flex items-center gap-1">
          Dynamic range compression
          <InfoDot tip="Applied AFTER loudness normalization. Reduces the gap between loud action and quiet dialog. Off = no compression, Heavy = late-night mode." />
        </span>
        <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden">
          {COMPRESSION_OPTIONS.map((o) => (
            <FixedTip key={o.id} label={o.tip} wide inline>
              <button
                type="button"
                onClick={() => { setNormalizeOptions({ ...normalizeOptions, compression: o.id }); setSelectedPreset(null) }}
                className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                  compression === o.id
                    ? 'bg-accent-500/20 text-accent-200'
                    : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                }`}
              >{o.label}</button>
            </FixedTip>
          ))}
        </div>
      </div>

      {/* Downmix */}
      <div className="space-y-1">
        <span className="text-2xs text-surface-500 flex items-center gap-1">
          Channel layout
          <InfoDot tip="Choose how multichannel input is rendered. 'Dialog stereo' boosts the center channel for clearer dialog on TV speakers and laptops." />
        </span>
        <div className="inline-flex rounded-md border border-white/[0.06] overflow-hidden">
          {DOWNMIX_OPTIONS.map((o) => (
            <FixedTip key={o.id} label={o.tip} wide inline>
              <button
                type="button"
                onClick={() => { setNormalizeOptions({ ...normalizeOptions, downmix: o.id }); setSelectedPreset(null) }}
                className={`px-2.5 py-1 text-2xs font-medium transition-colors ${
                  downmix === o.id
                    ? 'bg-accent-500/20 text-accent-200'
                    : 'text-surface-500 hover:text-surface-200 hover:bg-surface-800/50'
                }`}
              >{o.label}</button>
            </FixedTip>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main inline editor                                                 */
/* ------------------------------------------------------------------ */

interface InlineSettingsEditorProps {
  file: FileItem
  onClose: () => void
}

export function InlineSettingsEditor({ file, onClose }: InlineSettingsEditorProps): React.JSX.Element {
  const { updateFileOperation, files } = useAppStore()
  const op = file.operation || 'convert'

  // Local editable state - initialised from the file's stamped options
  const [boostPercent, setBoostPercent] = useState(file.boostPercent ?? 10)
  const [boostOptions, setBoostOptionsState] = useState<BoostOptions>(
    file.boostOptions || { percent: file.boostPercent ?? 10, limiter: true, limiterCeiling: -1, hpfHz: 0 }
  )
  const [selectedBoostPreset, setSelectedBoostPreset] = useState<string | null>(
    file.selectedBoostPreset ?? 'gentle-lift'
  )
  const setBoostOptions = (o: Partial<BoostOptions>) => {
    setBoostOptionsState((prev) => {
      const next = { ...prev, ...o }
      if (typeof o.percent === 'number') setBoostPercent(o.percent)
      return next
    })
  }
  const setBoostPercentSync = (v: number) => {
    setBoostPercent(v)
    setBoostOptionsState((prev) => ({ ...prev, percent: v }))
  }
  const [selectedPreset, setSelectedPreset] = useState<string | null>(file.selectedPreset ?? 'defaults')
  const [normalizeOptions, setNormalizeOptions] = useState<NormalizeOptions>(
    file.normalizeOptions || { I: -16, TP: -1.5, LRA: 11 }
  )
  const [convertOptions, setConvertOptions] = useState<ConvertOptions>(
    file.convertOptions || { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' }
  )
  const [selectedConvertPreset, setSelectedConvertPreset] = useState<string | null>(
    file.selectedConvertPreset ?? 'mp4-h264'
  )
  const [extractOptions, setExtractOptions] = useState<ExtractOptions>(
    file.extractOptions || { mode: 'audio', outputFormat: 'mp3', streamIndex: 0, audioBitrate: '320k', sampleRate: '', channels: '' }
  )
  const [selectedExtractPreset, setSelectedExtractPreset] = useState<string | null>(
    file.selectedExtractPreset ?? 'audio-mp3-320'
  )
  const [compressOptions, setCompressOptions] = useState<CompressOptions>(
    file.compressOptions || { mode: 'crf', targetSizeMB: 0, quality: 'medium', customCrf: 23, videoCodec: 'libx264', speed: 'medium', pixelFormat: 'yuv420p', tune: '', maxHeight: 1080, twoPass: false, audioCodec: 'aac', audioBitrate: '192k' }
  )
  const [selectedCompressPreset, setSelectedCompressPreset] = useState<string | null>(
    file.selectedCompressPreset ?? 'web-1080p'
  )

  const conflicts = useMemo(() =>
    op === 'convert' ? detectConvertConflicts(convertOptions) : [],
    [op, convertOptions]
  )

  const save = () => {
    const opts: Partial<FileItem> = {}
    switch (op) {
      case 'normalize':
        opts.normalizeOptions = normalizeOptions
        opts.selectedPreset = selectedPreset
        break
      case 'boost':
        opts.boostPercent = boostPercent
        opts.boostOptions = boostOptions
        opts.selectedBoostPreset = selectedBoostPreset
        break
      case 'convert':
        opts.convertOptions = convertOptions
        opts.selectedConvertPreset = selectedConvertPreset
        break
      case 'extract':
        opts.extractOptions = extractOptions
        opts.selectedExtractPreset = selectedExtractPreset
        break
      case 'compress':
        opts.compressOptions = compressOptions
        opts.selectedCompressPreset = selectedCompressPreset
        break
    }
    updateFileOperation(file.path, op, opts)
    onClose()
  }

  const applyToAll = () => {
    const opts: Partial<FileItem> = {}
    switch (op) {
      case 'normalize':
        opts.normalizeOptions = normalizeOptions
        opts.selectedPreset = selectedPreset
        break
      case 'boost':
        opts.boostPercent = boostPercent
        opts.boostOptions = boostOptions
        opts.selectedBoostPreset = selectedBoostPreset
        break
      case 'convert':
        opts.convertOptions = convertOptions
        opts.selectedConvertPreset = selectedConvertPreset
        break
      case 'extract':
        opts.extractOptions = extractOptions
        opts.selectedExtractPreset = selectedExtractPreset
        break
      case 'compress':
        opts.compressOptions = compressOptions
        opts.selectedCompressPreset = selectedCompressPreset
        break
    }
    for (const f of files) {
      if (f.operation === op) {
        updateFileOperation(f.path, op, opts)
      }
    }
    onClose()
  }

  const opLabel: Record<Operation, string> = {
    convert: 'Convert', normalize: 'Normalize', boost: 'Volume',
    compress: 'Compress', extract: 'Extract'
  }

  const sameOpCount = files.filter((f) => f.operation === op).length

  return (
    <div className="w-full border-t border-white/[0.06] bg-surface-900/60 px-3 py-3 animate-fade-in">
      {op === 'normalize' && (
        <InlineNormalizeConfig
          normalizeOptions={normalizeOptions}
          setNormalizeOptions={setNormalizeOptions}
          selectedPreset={selectedPreset}
          setSelectedPreset={setSelectedPreset}
        />
      )}
      {op === 'boost' && (
        <BoostConfig
          boostPercent={boostPercent}
          setBoostPercent={setBoostPercentSync}
          boostOptions={boostOptions}
          setBoostOptions={setBoostOptions}
          selectedBoostPreset={selectedBoostPreset}
          setSelectedBoostPreset={setSelectedBoostPreset}
        />
      )}
      {op === 'convert' && (
        <ConvertConfig
          options={convertOptions}
          setOptions={(o) => setConvertOptions((prev) => ({ ...prev, ...o }))}
          conflicts={conflicts}
          selectedConvertPreset={selectedConvertPreset}
          setSelectedConvertPreset={setSelectedConvertPreset}
        />
      )}
      {op === 'extract' && (
        <ExtractConfig
          options={extractOptions}
          setOptions={(o) => setExtractOptions((prev) => ({ ...prev, ...o }))}
          selectedExtractPreset={selectedExtractPreset}
          onApplyPreset={(id) => {
            if (!id) { setSelectedExtractPreset(null); return }
            const p = BUILTIN_EXTRACT_PRESETS.find((x) => x.id === id)
            if (p) setExtractOptions((prev) => ({ ...prev, ...p.options }))
            setSelectedExtractPreset(id)
          }}
        />
      )}
      {op === 'compress' && (
        <CompressConfig
          options={compressOptions}
          setOptions={(o) => setCompressOptions((prev) => ({ ...prev, ...o }))}
          selectedCompressPreset={selectedCompressPreset}
          onApplyPreset={(id) => {
            if (!id) { setSelectedCompressPreset(null); return }
            const p = BUILTIN_COMPRESS_PRESETS.find((x) => x.id === id)
            if (p) setCompressOptions((prev) => ({ ...prev, ...p.options }))
            setSelectedCompressPreset(id)
          }}
        />
      )}

      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/[0.06]">
        <button
          onClick={save}
          className="px-3 py-1 text-2xs font-medium rounded-lg bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 border border-accent-500/20 hover:border-accent-500/30 transition-all"
        >
          Save
        </button>
        {sameOpCount > 1 && (
          <button
            onClick={applyToAll}
            className="px-3 py-1 text-2xs font-medium rounded-lg text-surface-400 hover:text-surface-200 bg-surface-800/50 hover:bg-surface-700/50 border border-white/[0.06] transition-all"
          >
            Apply to all {opLabel[op]} files ({sameOpCount})
          </button>
        )}
        <button
          onClick={onClose}
          className="px-3 py-1 text-2xs text-surface-500 hover:text-surface-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
