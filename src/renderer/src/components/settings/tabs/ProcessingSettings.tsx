/**
 * @module components/settings/tabs/ProcessingSettings
 * @description Processing tab - concurrency, output, and stream handling options.
 */

import React from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { SettingGroup, SettingRow, Toggle, NumberInput } from '../../shared/ui'

type GpuOption = 'off' | 'auto' | 'nvenc' | 'qsv' | 'amf'
const GPU_OPTIONS: { value: GpuOption; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'CPU only' },
  { value: 'auto', label: 'Auto', description: 'Detect best GPU' },
  { value: 'nvenc', label: 'NVENC', description: 'NVIDIA' },
  { value: 'qsv', label: 'QSV', description: 'Intel' },
  { value: 'amf', label: 'AMF', description: 'AMD' },
]

interface ProcessingSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onSelectOutputDir: () => void
}

export function ProcessingSettings({ config, onUpdate, onSelectOutputDir }: ProcessingSettingsProps): React.JSX.Element {
  const isKeepBoth = config.afterProcessing !== 'replace'

  return (
    <div className="space-y-4">
      {/* GPU Acceleration - card selector */}
      <div className="rounded-xl p-4 space-y-3 bg-white/[0.03] border border-white/[0.06]">
        <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">GPU Acceleration</span>
        <div className="grid grid-cols-5 gap-2">
          {GPU_OPTIONS.map((opt) => {
            const active = (config.gpuAcceleration || 'off') === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => onUpdate('gpuAcceleration', opt.value)}
                className={`group relative p-2.5 rounded-lg border text-center transition-all ${
                  active
                    ? 'border-accent-500/30 bg-accent-500/[0.08]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-accent-500/15 hover:bg-accent-500/[0.04]'
                }`}
              >
                <span className={`block text-xs font-medium ${active ? 'text-accent-300' : 'text-surface-400'}`}>
                  {opt.label}
                </span>
                <span className="block text-2xs text-surface-500 mt-0.5">{opt.description}</span>
                {active && <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent-400" />}
              </button>
            )
          })}
        </div>
        <p className="text-2xs text-surface-500">Use GPU hardware encoding for faster exports. Auto detects the best available encoder.</p>
      </div>

      {/* After Processing - card selector */}
      <div className="rounded-xl p-4 space-y-3 bg-white/[0.03] border border-white/[0.06]">
        <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">After Processing</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onUpdate('afterProcessing', 'keep-both')}
            className={`group relative p-3 rounded-lg border text-left transition-all ${
              isKeepBoth
                ? 'border-accent-500/30 bg-accent-500/[0.08]'
                : 'border-white/[0.06] bg-white/[0.02] hover:border-accent-500/15 hover:bg-accent-500/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={isKeepBoth ? 'text-accent-400' : 'text-surface-500'}>
                <rect x="2" y="3" width="8" height="13" rx="1" />
                <rect x="14" y="8" width="8" height="13" rx="1" />
              </svg>
              <span className={`text-sm font-medium ${isKeepBoth ? 'text-accent-300' : 'text-surface-400'}`}>Keep Both</span>
            </div>
            <p className="text-2xs text-surface-500 leading-relaxed">Save output alongside the original file</p>
            {isKeepBoth && <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-accent-400" />}
          </button>
          <button
            onClick={() => onUpdate('afterProcessing', 'replace')}
            className={`group relative p-3 rounded-lg border text-left transition-all ${
              !isKeepBoth
                ? 'border-accent-500/30 bg-accent-500/[0.08]'
                : 'border-white/[0.06] bg-white/[0.02] hover:border-accent-500/15 hover:bg-accent-500/[0.04]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={!isKeepBoth ? 'text-accent-400' : 'text-surface-500'}>
                <path d="M17 1l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 23l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              <span className={`text-sm font-medium ${!isKeepBoth ? 'text-accent-300' : 'text-surface-400'}`}>Replace Original</span>
            </div>
            <p className="text-2xs text-surface-500 leading-relaxed">Delete original after successful processing</p>
            {!isKeepBoth && <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-accent-400" />}
          </button>
        </div>
        {!isKeepBoth && (
          <div className="flex items-center justify-between pt-1 px-0.5">
            <div className="min-w-0">
              <p className="text-xs text-surface-300 font-medium">Confirm before replacing</p>
              <p className="text-2xs text-surface-500 mt-0.5">Show a warning each time processing starts</p>
            </div>
            <Toggle checked={config.confirmReplace} onChange={(v) => onUpdate('confirmReplace', v)} />
          </div>
        )}
      </div>

      {/* Output Directory - inline bar */}
      {isKeepBoth && (
        <div className="rounded-xl p-4 space-y-3 bg-white/[0.03] border border-white/[0.06]">
          <span className="text-2xs font-semibold uppercase tracking-wider text-surface-500">Output Directory</span>
          <div className="flex items-center gap-2 rounded-lg bg-white/[0.02] border border-white/[0.06] px-3 py-2.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-surface-500 shrink-0">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="flex-1 text-xs text-surface-300 truncate min-w-0" title={config.outputDirectory}>
              {config.outputDirectory || 'Same as source'}
            </span>
            <button
              onClick={onSelectOutputDir}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-surface-200 border border-white/[0.08] hover:border-white/[0.15] transition-colors"
            >
              Browse
            </button>
          </div>
          <p className="text-2xs text-surface-500">Processed files are saved here. Can be overridden per batch.</p>
        </div>
      )}

      {/* Concurrency */}
      <SettingGroup title="Concurrency">
        <SettingRow label="Max Workers" description="Parallel processing tasks. 0 = match CPU core count">
          <NumberInput value={config.maxWorkers} onChange={(v) => onUpdate('maxWorkers', Math.max(0, Math.round(v)))} min={0} max={32} step={1} />
        </SettingRow>
      </SettingGroup>

      {/* Stream Handling */}
      <SettingGroup title="Stream Handling">
        <SettingRow label="Preserve Subtitles" description="Copy subtitle streams into output files">
          <Toggle checked={config.preserveSubtitles} onChange={(v) => onUpdate('preserveSubtitles', v)} />
        </SettingRow>
        <SettingRow label="Preserve Metadata" description="Keep original tags, chapters, and metadata in output">
          <Toggle checked={config.preserveMetadata} onChange={(v) => onUpdate('preserveMetadata', v)} />
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
