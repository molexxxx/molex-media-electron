import React, { useState, useMemo } from 'react'
import type { FileItem, Operation, NormalizeOptions, ConvertOptions, ExtractOptions, CompressOptions } from '../../../stores/types'
import { BUILTIN_PRESETS } from '../../../stores/types'
import { useAppStore } from '../../../stores/appStore'
import { BoostConfig, ConvertConfig, ExtractConfig, CompressConfig } from './OperationPanel'
import { detectConvertConflicts } from '../presets'

/* ------------------------------------------------------------------ */
/*  Inline normalize editor (local-state version)                      */
/* ------------------------------------------------------------------ */

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
      setNormalizeOptions(norm)
    }
    setSelectedPreset(presetId)
  }

  return (
    <div className="space-y-2.5">
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
            title={p.description}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-2xs text-surface-400 flex-wrap">
        <span className="font-mono">I={normalizeOptions.I} LUFS</span>
        <span className="font-mono">TP={normalizeOptions.TP} dBTP</span>
        <span className="font-mono">LRA={normalizeOptions.LRA} LU</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
        {([
          { label: 'Loudness', unit: 'LUFS', key: 'I' as const, min: -30, max: -5, step: 0.5 },
          { label: 'True Peak', unit: 'dBTP', key: 'TP' as const, min: -3, max: 0, step: 0.1 },
          { label: 'LRA', unit: 'LU', key: 'LRA' as const, min: 1, max: 25, step: 0.5 },
        ]).map((s) => {
          const value = normalizeOptions[s.key]
          const pct = ((value - s.min) / (s.max - s.min)) * 100
          return (
            <div key={s.key} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-surface-500">{s.label}</span>
                <span className="text-2xs font-mono font-semibold text-surface-300">{value} {s.unit}</span>
              </div>
              <div className="relative h-4 flex items-center cursor-pointer">
                <div className="absolute left-0 right-0 h-1 rounded-full bg-surface-700">
                  <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
                </div>
                <input type="range" min={s.min} max={s.max} step={s.step} value={value}
                  onChange={(e) => {
                    setNormalizeOptions({ ...normalizeOptions, [s.key]: parseFloat(e.target.value) })
                    setSelectedPreset(null)
                  }}
                  className="norm-slider" />
              </div>
            </div>
          )
        })}
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
  const [selectedPreset, setSelectedPreset] = useState<string | null>(file.selectedPreset ?? 'defaults')
  const [normalizeOptions, setNormalizeOptions] = useState<NormalizeOptions>(
    file.normalizeOptions || { I: -16, TP: -1.5, LRA: 11 }
  )
  const [convertOptions, setConvertOptions] = useState<ConvertOptions>(
    file.convertOptions || { outputFormat: 'mp4', videoCodec: 'libx264', audioCodec: 'aac', videoBitrate: '5000k', audioBitrate: '256k', resolution: '', framerate: '' }
  )
  const [extractOptions, setExtractOptions] = useState<ExtractOptions>(
    file.extractOptions || { outputFormat: 'mp3', streamIndex: 0 }
  )
  const [compressOptions, setCompressOptions] = useState<CompressOptions>(
    file.compressOptions || { targetSizeMB: 0, quality: 'high', videoCodec: 'libx264', speed: 'slow', audioBitrate: '256k' }
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
        break
      case 'convert':
        opts.convertOptions = convertOptions
        break
      case 'extract':
        opts.extractOptions = extractOptions
        break
      case 'compress':
        opts.compressOptions = compressOptions
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
        break
      case 'convert':
        opts.convertOptions = convertOptions
        break
      case 'extract':
        opts.extractOptions = extractOptions
        break
      case 'compress':
        opts.compressOptions = compressOptions
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
        <BoostConfig boostPercent={boostPercent} setBoostPercent={setBoostPercent} />
      )}
      {op === 'convert' && (
        <ConvertConfig options={convertOptions} setOptions={(o) => setConvertOptions((prev) => ({ ...prev, ...o }))} conflicts={conflicts} />
      )}
      {op === 'extract' && (
        <ExtractConfig options={extractOptions} setOptions={(o) => setExtractOptions((prev) => ({ ...prev, ...o }))} />
      )}
      {op === 'compress' && (
        <CompressConfig options={compressOptions} setOptions={(o) => setCompressOptions((prev) => ({ ...prev, ...o }))} />
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
