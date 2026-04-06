/**
 * @module components/batch/OperationPanel
 * @description Tab panel for selecting and configuring batch operations
 * (normalize, boost, convert, extract, compress).
 */

import React from 'react'
import { useAppStore, BUILTIN_PRESETS } from '../../../stores/appStore'
import type { Operation, ConvertOptions, ExtractOptions, CompressOptions } from '../../../stores/types'

const OP_TABS: { id: Operation; label: string }[] = [
  { id: 'convert', label: 'Convert' },
  { id: 'normalize', label: 'Normalize' },
  { id: 'boost', label: 'Boost' },
  { id: 'compress', label: 'Compress' },
  { id: 'extract', label: 'Extract Audio' },
]

export function OperationPanel({ onStart, startLabel, hasVideoFiles }: {
  onStart: () => void
  startLabel: string
  hasVideoFiles: boolean
}): React.JSX.Element {
  const {
    files, operation, setOperation,
    boostPercent, setBoostPercent,
    selectedPreset, setSelectedPreset,
    convertOptions, setConvertOptions,
    extractOptions, setExtractOptions,
    compressOptions, setCompressOptions,
    isProcessing
  } = useAppStore()

  const [copySubtitles, setCopySubtitles] = React.useState(true)
  const { config } = useAppStore()

  React.useEffect(() => {
    if (config) setCopySubtitles(config.preserveSubtitles)
  }, [config?.preserveSubtitles])

  const handleApplyPreset = (presetId: string) => {
    setSelectedPreset(presetId)
    setOperation('normalize')
  }

  const handleStart = async () => {
    if (hasVideoFiles && operation !== 'extract') {
      await window.api.saveConfig({ preserveSubtitles: copySubtitles })
    }
    onStart()
  }

  return (
    <div className="glass rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-surface-500 mr-2">Operation</span>
        <div className="flex bg-surface-800 rounded-lg p-0.5 flex-wrap gap-0.5">
          {OP_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setOperation(tab.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                operation === tab.id
                  ? 'bg-accent-600 text-white shadow-glow'
                  : 'text-surface-400 hover:text-surface-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {operation === 'normalize' && (
        <NormalizeOptions selectedPreset={selectedPreset} onApplyPreset={handleApplyPreset} />
      )}
      {operation === 'boost' && (
        <BoostOptions boostPercent={boostPercent} setBoostPercent={setBoostPercent} />
      )}
      {operation === 'convert' && (
        <ConvertForm options={convertOptions} setOptions={setConvertOptions} />
      )}
      {operation === 'extract' && (
        <ExtractForm options={extractOptions} setOptions={setExtractOptions} />
      )}
      {operation === 'compress' && (
        <CompressForm options={compressOptions} setOptions={setCompressOptions} />
      )}

      <div className="flex items-center justify-between">
        {hasVideoFiles && operation !== 'extract' ? (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={copySubtitles}
              onChange={(e) => setCopySubtitles(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-accent-500 bg-surface-700 border-surface-600"
            />
            <span className="text-xs text-surface-400">Copy subtitles</span>
          </label>
        ) : <div />}

        <button
          onClick={handleStart}
          disabled={files.length === 0 || isProcessing}
          className="px-5 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-surface-700 disabled:text-surface-500 text-white text-sm font-semibold rounded-xl transition-all shadow-glow hover:shadow-glow-lg disabled:shadow-none"
        >
          {isProcessing ? 'Processing...' : startLabel}
        </button>
      </div>
    </div>
  )
}

function NormalizeOptions({ selectedPreset, onApplyPreset }: {
  selectedPreset: string | null
  onApplyPreset: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-surface-500">Presets:</span>
        {BUILTIN_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onApplyPreset(p.id)}
            className={`px-2.5 py-1 text-2xs font-medium rounded-md transition-all ${
              selectedPreset === p.id
                ? 'bg-accent-600 text-white'
                : 'bg-surface-700/50 text-surface-400 hover:text-surface-200 hover:bg-surface-600/50'
            }`}
            title={p.description}
          >
            {p.name}
          </button>
        ))}
      </div>
      {selectedPreset && (
        <div className="flex items-center gap-4 text-xs text-surface-400 bg-surface-800/50 rounded-lg px-3 py-2">
          {(() => { const p = BUILTIN_PRESETS.find((x) => x.id === selectedPreset); return p ? (
            <>
              <span>I={p.normalization.I} LUFS</span>
              <span>TP={p.normalization.TP} dBFS</span>
              <span>LRA={p.normalization.LRA} LU</span>
              <span className="text-surface-500">·</span>
              <span>{p.audioCodec.toUpperCase()} {p.audioBitrate}</span>
              <span className="text-surface-500 ml-auto">{p.description}</span>
            </>
          ) : null })()}
        </div>
      )}
    </div>
  )
}

function BoostOptions({ boostPercent, setBoostPercent }: {
  boostPercent: number
  setBoostPercent: (v: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input type="range" min="-50" max="200" value={boostPercent} onChange={(e) => setBoostPercent(parseInt(e.target.value, 10))} className="w-32 accent-accent-500" />
      <div className="flex items-center gap-1">
        <input type="number" value={boostPercent} onChange={(e) => setBoostPercent(parseInt(e.target.value, 10) || 0)}
          className="w-16 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
        <span className="text-xs text-surface-500">%</span>
      </div>
    </div>
  )
}

function ConvertForm({ options, setOptions }: {
  options: ConvertOptions
  setOptions: (o: Partial<ConvertOptions>) => void
}): React.JSX.Element {
  const sel = "w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500"
  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Output Format</label>
        <select value={options.outputFormat} onChange={(e) => setOptions({ outputFormat: e.target.value })} className={sel}>
          <option value="mp4">MP4</option><option value="mkv">MKV</option><option value="avi">AVI</option>
          <option value="mov">MOV</option><option value="webm">WebM</option><option value="mp3">MP3</option>
          <option value="flac">FLAC</option><option value="wav">WAV</option><option value="aac">AAC</option>
          <option value="ogg">OGG</option><option value="opus">Opus</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Video Codec</label>
        <select value={options.videoCodec} onChange={(e) => setOptions({ videoCodec: e.target.value })} className={sel}>
          <option value="copy">Copy (no re-encode)</option><option value="libx264">H.264</option>
          <option value="libx265">H.265 (HEVC)</option><option value="libvpx-vp9">VP9</option>
          <option value="libaom-av1">AV1</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Audio Codec</label>
        <select value={options.audioCodec} onChange={(e) => setOptions({ audioCodec: e.target.value })} className={sel}>
          <option value="copy">Copy</option><option value="aac">AAC</option><option value="ac3">AC3</option>
          <option value="libmp3lame">MP3</option><option value="libvorbis">Vorbis</option>
          <option value="libopus">Opus</option><option value="flac">FLAC</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Video Bitrate</label>
        <select value={options.videoBitrate} onChange={(e) => setOptions({ videoBitrate: e.target.value })} className={sel}>
          <option value="">Auto</option><option value="1000k">1 Mbps</option><option value="2500k">2.5 Mbps</option>
          <option value="5000k">5 Mbps</option><option value="8000k">8 Mbps</option>
          <option value="15000k">15 Mbps</option><option value="25000k">25 Mbps</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Resolution</label>
        <select value={options.resolution} onChange={(e) => setOptions({ resolution: e.target.value })} className={sel}>
          <option value="">Original</option><option value="3840x2160">4K (2160p)</option>
          <option value="1920x1080">1080p</option><option value="1280x720">720p</option>
          <option value="854x480">480p</option><option value="640x360">360p</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Framerate</label>
        <select value={options.framerate} onChange={(e) => setOptions({ framerate: e.target.value })} className={sel}>
          <option value="">Original</option><option value="24">24 fps</option><option value="30">30 fps</option>
          <option value="60">60 fps</option>
        </select>
      </div>
    </div>
  )
}

function ExtractForm({ options, setOptions }: {
  options: ExtractOptions
  setOptions: (o: Partial<ExtractOptions>) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Output Format</label>
        <select value={options.outputFormat} onChange={(e) => setOptions({ outputFormat: e.target.value })}
          className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
          <option value="mp3">MP3</option><option value="aac">AAC</option><option value="flac">FLAC</option>
          <option value="wav">WAV</option><option value="ogg">OGG</option><option value="opus">Opus</option>
          <option value="m4a">M4A</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Audio Stream</label>
        <input type="number" min="0" max="10" value={options.streamIndex}
          onChange={(e) => setOptions({ streamIndex: parseInt(e.target.value, 10) || 0 })}
          className="w-16 bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
      </div>
    </div>
  )
}

function CompressForm({ options, setOptions }: {
  options: CompressOptions
  setOptions: (o: Partial<CompressOptions>) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Quality</label>
        <select value={options.quality} onChange={(e) => setOptions({ quality: e.target.value as any })}
          className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
          <option value="lossless">Lossless</option><option value="high">High</option>
          <option value="medium">Medium</option><option value="low">Low (smallest)</option>
        </select>
      </div>
      <div>
        <label className="text-2xs text-surface-500 block mb-1">Target Size (MB, 0 = auto)</label>
        <input type="number" min="0" value={options.targetSizeMB}
          onChange={(e) => setOptions({ targetSizeMB: parseFloat(e.target.value) || 0 })}
          className="w-24 bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
      </div>
    </div>
  )
}
