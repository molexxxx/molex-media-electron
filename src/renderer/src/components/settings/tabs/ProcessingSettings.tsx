/**
 * @module components/settings/tabs/ProcessingSettings
 * @description Processing tab — concurrency, output, and stream handling options.
 */

import React from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { SettingGroup, SettingRow, Toggle, NumberInput } from '../../shared/ui'

interface ProcessingSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onSelectOutputDir: () => void
}

export function ProcessingSettings({ config, onUpdate, onSelectOutputDir }: ProcessingSettingsProps): React.JSX.Element {
  return (
    <div className="space-y-5">
      <SettingGroup title="Concurrency">
        <SettingRow label="Max Workers" description="Concurrent processing tasks. 0 = match CPU core count">
          <NumberInput value={config.maxWorkers} onChange={(v) => onUpdate('maxWorkers', Math.max(0, Math.round(v)))} min={0} max={32} step={1} />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Output">
        <SettingRow label="Overwrite Original" description="Replace original files in-place. Off = write new files alongside originals">
          <Toggle checked={config.overwriteOriginal} onChange={(v) => onUpdate('overwriteOriginal', v)} />
        </SettingRow>
        {!config.overwriteOriginal && (
          <SettingRow label="Output Directory" description="Where to save processed files (blank = same folder as source)">
            <button
              onClick={onSelectOutputDir}
              className="px-3 py-1.5 text-sm text-surface-300 bg-surface-800 border border-surface-600 rounded-md hover:border-accent-500 transition-colors truncate max-w-[200px]"
            >
              {config.outputDirectory || 'Same as source'}
            </button>
          </SettingRow>
        )}
      </SettingGroup>
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
