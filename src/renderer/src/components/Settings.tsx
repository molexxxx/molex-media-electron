import { useState, useEffect } from 'react'
import { useAppStore, AppConfig } from '../stores/appStore'

type SettingsTab = 'general' | 'audio' | 'video' | 'processing' | 'application'

interface SettingGroupProps {
  title: string
  children: React.ReactNode
}

function SettingGroup({ title, children }: SettingGroupProps): JSX.Element {
  return (
    <div className="glass rounded-xl p-5 space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-surface-500">{title}</h3>
      {children}
    </div>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <p className="text-sm text-surface-200 font-medium">{label}</p>
        {description && <p className="text-xs text-surface-500 mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full transition-colors duration-200 relative ${
        checked ? 'bg-accent-600' : 'bg-surface-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}

function NumberInput({ value, onChange, min, max, step = 0.1, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string
}): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        className="w-20 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500 transition-colors"
      />
      {unit && <span className="text-xs text-surface-500">{unit}</span>}
    </div>
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-accent-500 transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export default function Settings(): JSX.Element {
  const { config, setConfig } = useAppStore()
  const [localConfig, setLocalConfig] = useState<AppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  useEffect(() => {
    if (config) setLocalConfig({ ...config })
  }, [config])

  if (!localConfig) {
    return <div className="text-surface-400">Loading settings...</div>
  }

  const update = <K extends keyof AppConfig>(key: K, val: AppConfig[K]) => {
    setLocalConfig({ ...localConfig, [key]: val })
    setSaved(false)
  }

  const updateNorm = (key: 'I' | 'TP' | 'LRA', val: number) => {
    setLocalConfig({
      ...localConfig,
      normalization: { ...localConfig.normalization, [key]: val }
    })
    setSaved(false)
  }

  const handleSave = async () => {
    const result = await window.api.saveConfig(localConfig)
    setConfig(result)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSelectOutputDir = async () => {
    const dir = await window.api.selectOutputDir()
    if (dir) {
      update('outputDirectory', dir)
    }
  }

  const codecOptions = [
    { value: 'inherit', label: 'Inherit (keep original)' },
    { value: 'ac3', label: 'AC3 (Dolby Digital)' },
    { value: 'aac', label: 'AAC' },
    { value: 'opus', label: 'Opus' },
    { value: 'flac', label: 'FLAC (lossless)' },
    { value: 'dts', label: 'DTS' },
    { value: 'eac3', label: 'E-AC3 (Dolby Digital+)' },
    { value: 'pcm_s16le', label: 'PCM (uncompressed)' }
  ]

  const bitrateOptions = [
    { value: '128k', label: '128k' },
    { value: '192k', label: '192k' },
    { value: '256k', label: '256k' },
    { value: '320k', label: '320k' },
    { value: '448k', label: '448k' },
    { value: '640k', label: '640k' }
  ]

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'audio', label: 'Audio' },
    { id: 'video', label: 'Video' },
    { id: 'processing', label: 'Processing' },
    { id: 'application', label: 'Application' },
  ]

  return (
    <div className="space-y-5 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-sm text-surface-400 mt-0.5">Configure media processing, codecs, and application preferences</p>
        </div>
        <button
          onClick={handleSave}
          className={`px-5 py-2 text-sm font-semibold rounded-xl transition-all ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg'
          }`}
        >
          {saved ? '✓ Saved' : 'Save Settings'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex bg-surface-800/50 rounded-lg p-0.5 gap-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-all flex-1 ${
              activeTab === tab.id
                ? 'bg-surface-700 text-white shadow-sm'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'general' && (
        <div className="space-y-5">
          <SettingGroup title="Default Normalization (ITU-R BS.1770-4)">
            <p className="text-xs text-surface-500 -mt-1 mb-2">Fallback values when no preset is selected. Presets override these.</p>
            <SettingRow label="Integrated Loudness (I)" description="Target loudness level. Broadcast: -23, Streaming: -14 to -16, Podcast: -16">
              <NumberInput value={localConfig.normalization.I} onChange={(v) => updateNorm('I', v)} min={-70} max={0} step={0.5} unit="LUFS" />
            </SettingRow>
            <SettingRow label="True Peak (TP)" description="Maximum peak level. Prevents clipping during playback">
              <NumberInput value={localConfig.normalization.TP} onChange={(v) => updateNorm('TP', v)} min={-10} max={0} step={0.1} unit="dBFS" />
            </SettingRow>
            <SettingRow label="Loudness Range (LRA)" description="Dynamic range. Higher = more dynamics preserved">
              <NumberInput value={localConfig.normalization.LRA} onChange={(v) => updateNorm('LRA', v)} min={1} max={30} step={0.5} unit="LU" />
            </SettingRow>
          </SettingGroup>
        </div>
      )}

      {activeTab === 'audio' && (
        <div className="space-y-5">
          <SettingGroup title="Audio Encoding">
            <SettingRow label="Default Audio Codec" description="Codec used when re-encoding audio streams">
              <Select value={localConfig.audioCodec} onChange={(v) => update('audioCodec', v)} options={codecOptions} />
            </SettingRow>
            <SettingRow label="Fallback Codec" description="Used when original codec is unsupported (only with 'inherit')">
              <Select value={localConfig.fallbackCodec} onChange={(v) => update('fallbackCodec', v)} options={codecOptions.filter((o) => o.value !== 'inherit')} />
            </SettingRow>
            <SettingRow label="Audio Bitrate" description="Target bitrate for encoded audio">
              <Select value={localConfig.audioBitrate} onChange={(v) => update('audioBitrate', v)} options={bitrateOptions} />
            </SettingRow>
          </SettingGroup>
        </div>
      )}

      {activeTab === 'video' && (
        <div className="space-y-5">
          <SettingGroup title="Video Defaults">
            <SettingRow label="Preserve Subtitles" description="Copy subtitle streams to output video files">
              <Toggle checked={localConfig.preserveSubtitles} onChange={(v) => update('preserveSubtitles', v)} />
            </SettingRow>
            <SettingRow label="Preserve Metadata" description="Keep original file metadata and tags in output">
              <Toggle checked={localConfig.preserveMetadata} onChange={(v) => update('preserveMetadata', v)} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="Format Support">
            <div className="text-xs text-surface-400 leading-relaxed">
              <p className="mb-2"><span className="text-surface-300 font-medium">Video:</span> MP4, MKV, AVI, MOV, FLV, WMV, WebM, M4V, MPG, MPEG, TS</p>
              <p className="mb-2"><span className="text-surface-300 font-medium">Audio:</span> MP3, WAV, FLAC, OGG, M4A, WMA, AAC, Opus</p>
              <p><span className="text-surface-300 font-medium">Codecs:</span> H.264, H.265/HEVC, VP9, AV1, AAC, AC3, E-AC3, DTS, FLAC, Opus, Vorbis, MP3</p>
            </div>
          </SettingGroup>
        </div>
      )}

      {activeTab === 'processing' && (
        <div className="space-y-5">
          <SettingGroup title="Concurrency & Output">
            <SettingRow label="Max Workers" description="Number of concurrent processing tasks (0 = auto/CPU count)">
              <NumberInput value={localConfig.maxWorkers} onChange={(v) => update('maxWorkers', Math.max(0, Math.round(v)))} min={0} max={32} step={1} />
            </SettingRow>
            <SettingRow label="Overwrite Original" description="Replace original files (off = creates new files with prefix)">
              <Toggle checked={localConfig.overwriteOriginal} onChange={(v) => update('overwriteOriginal', v)} />
            </SettingRow>
            {!localConfig.overwriteOriginal && (
              <SettingRow label="Output Directory" description="Where to save processed files">
                <button
                  onClick={handleSelectOutputDir}
                  className="px-3 py-1.5 text-sm text-surface-300 bg-surface-800 border border-surface-600 rounded-md hover:border-accent-500 transition-colors truncate max-w-[200px]"
                >
                  {localConfig.outputDirectory || 'Same as source'}
                </button>
              </SettingRow>
            )}
          </SettingGroup>
        </div>
      )}

      {activeTab === 'application' && (
        <div className="space-y-5">
          <SettingGroup title="Notifications">
            <SettingRow label="Show Notifications" description="Desktop notifications when processing completes">
              <Toggle checked={localConfig.showNotifications} onChange={(v) => update('showNotifications', v)} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="Paths">
            <SettingRow label="FFmpeg Path" description="Path to FFmpeg binary">
              <span className="text-xs text-surface-500 font-mono max-w-[250px] truncate block">{localConfig.ffmpegPath || 'Not set'}</span>
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="About">
            <div className="text-xs text-surface-400 space-y-1">
              <p><span className="text-surface-300 font-medium">molexMedia</span> v{localConfig.version}</p>
              <p>Professional media processing toolkit powered by FFmpeg</p>
            </div>
          </SettingGroup>
        </div>
      )}
    </div>
  )
}
