/**
 * @module components/settings/tabs/AudioSettings
 * @description Audio tab - normalization targets (I / TP / LRA) and encoding defaults.
 */

import React from 'react'
import type { AppConfig } from '../../../stores/appStore'
import { SettingGroup, SettingRow, NumberInput, Select } from '../../shared/ui'

const CODEC_OPTIONS = [
  { value: 'inherit', label: 'Inherit (keep original)' },
  { value: 'ac3', label: 'AC3 (Dolby Digital)' },
  { value: 'aac', label: 'AAC' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC (lossless)' },
  { value: 'dts', label: 'DTS' },
  { value: 'eac3', label: 'E-AC3 (Dolby Digital+)' },
  { value: 'pcm_s16le', label: 'PCM (uncompressed)' }
]

const BITRATE_OPTIONS = [
  { value: '128k', label: '128k' },
  { value: '192k', label: '192k' },
  { value: '256k', label: '256k' },
  { value: '320k', label: '320k' },
  { value: '448k', label: '448k' },
  { value: '640k', label: '640k' }
]

interface AudioSettingsProps {
  config: AppConfig
  onUpdate: <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => void
  onUpdateNorm: (key: 'I' | 'TP' | 'LRA', val: number) => void
}

export function AudioSettings({ config, onUpdate, onUpdateNorm }: AudioSettingsProps): React.JSX.Element {
  return (
    <div className="space-y-5">
      <SettingGroup title="Normalization (ITU-R BS.1770-4)">
        <SettingRow label="Integrated Loudness (I)" description="Target loudness level. Broadcast: -23, Streaming: -14 to -16, Podcast: -16">
          <NumberInput value={config.normalization.I} onChange={(v) => onUpdateNorm('I', v)} min={-70} max={0} step={0.5} unit="LUFS" />
        </SettingRow>
        <SettingRow label="True Peak (TP)" description="Maximum peak level. Prevents clipping during playback">
          <NumberInput value={config.normalization.TP} onChange={(v) => onUpdateNorm('TP', v)} min={-10} max={0} step={0.1} unit="dBFS" />
        </SettingRow>
        <SettingRow label="Loudness Range (LRA)" description="Dynamic range. Higher = more dynamics preserved">
          <NumberInput value={config.normalization.LRA} onChange={(v) => onUpdateNorm('LRA', v)} min={1} max={30} step={0.5} unit="LU" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Encoding Defaults">
        <SettingRow label="Audio Codec" description="Codec used when re-encoding audio streams">
          <Select value={config.audioCodec} onChange={(v) => onUpdate('audioCodec', v)} options={CODEC_OPTIONS} />
        </SettingRow>
        <SettingRow label="Fallback Codec" description="Used when original codec is unsupported (only applies with 'Inherit')">
          <Select value={config.fallbackCodec} onChange={(v) => onUpdate('fallbackCodec', v)} options={CODEC_OPTIONS.filter((o) => o.value !== 'inherit')} />
        </SettingRow>
        <SettingRow label="Audio Bitrate" description="Target bitrate for encoded audio">
          <Select value={config.audioBitrate} onChange={(v) => onUpdate('audioBitrate', v)} options={BITRATE_OPTIONS} />
        </SettingRow>
      </SettingGroup>
    </div>
  )
}
