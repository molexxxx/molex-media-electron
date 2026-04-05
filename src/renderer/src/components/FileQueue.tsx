import { useCallback, useState, useEffect } from 'react'
import { useAppStore, FileItem, BUILTIN_PRESETS } from '../stores/appStore'

export default function FileQueue(): JSX.Element {
  const {
    files, addFiles, updateFile, removeFile, clearFiles,
    operation, setOperation, boostPercent, setBoostPercent,
    selectedPreset, setSelectedPreset,
    convertOptions, setConvertOptions,
    extractOptions, setExtractOptions,
    compressOptions, setCompressOptions,
    isProcessing, setView
  } = useAppStore()
  const [dragOver, setDragOver] = useState(false)
  const [scanning, setScanning] = useState(false)

  // Auto-probe newly added files for metadata
  useEffect(() => {
    const unprobed = files.filter((f) => !f.probed)
    if (unprobed.length === 0) return

    for (const file of unprobed) {
      updateFile(file.path, { probed: true })
      window.api.probeFile(file.path).then((info: any) => {
        if (!info) return
        const audio = info.audioStreams?.[0]
        const video = info.videoStreams?.[0]
        updateFile(file.path, {
          size: parseInt(info.format?.size, 10) || 0,
          duration: info.format?.duration || '0',
          audioStreams: info.audioStreams?.length || 0,
          videoStreams: info.videoStreams?.length || 0,
          audioCodec: audio?.codec_name,
          channels: audio?.channels,
          sampleRate: audio?.sample_rate,
          videoCodec: video?.codec_name,
          bitrate: info.format?.bit_rate,
          width: video?.width,
          height: video?.height
        })
      }).catch(() => {})
    }
  }, [files, updateFile])

  const handleAddFiles = async () => {
    const paths = await window.api.openFiles()
    if (paths?.length) {
      const items: FileItem[] = paths.map((p: string) => ({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      }))
      addFiles(items)
    }
  }

  const handleAddFolder = async () => {
    const dirPath = await window.api.openDirectory()
    if (!dirPath) return
    setScanning(true)
    try {
      const scanned = await window.api.scanDirectory(dirPath)
      addFiles(scanned)
    } finally {
      setScanning(false)
    }
  }

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const paths: string[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      paths.push((file as File & { path: string }).path)
    }
    if (paths.length) {
      const items: FileItem[] = paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      }))
      addFiles(items)
    }
  }, [addFiles])

  const handleApplyPreset = (presetId: string) => {
    setSelectedPreset(presetId)
    setOperation('normalize')
  }

  const handleStart = async () => {
    if (files.length === 0) return
    const paths = files.map((f) => f.path)
    setView('processing')

    if (operation === 'normalize') {
      await window.api.normalize(paths)
    } else if (operation === 'boost') {
      await window.api.boost(paths, boostPercent)
    } else if (operation === 'convert') {
      await window.api.convert(paths, convertOptions)
    } else if (operation === 'extract') {
      await window.api.extract(paths, extractOptions)
    } else if (operation === 'compress') {
      await window.api.compress(paths, compressOptions)
    }
  }

  const formatSize = (bytes: number): string => {
    if (!bytes) return '—'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  const formatDuration = (sec: string | undefined): string => {
    if (!sec) return '—'
    const s = parseFloat(sec)
    if (!s || s <= 0) return '—'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = Math.floor(s % 60)
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    return `${m}:${ss.toString().padStart(2, '0')}`
  }

  const formatCodecInfo = (file: FileItem): string => {
    const parts: string[] = []
    if (file.videoCodec) {
      let vc = file.videoCodec.toUpperCase()
      if (file.width && file.height) vc += ` ${file.width}x${file.height}`
      parts.push(vc)
    }
    if (file.audioCodec) {
      let ac = file.audioCodec.toUpperCase()
      if (file.channels) ac += ` ${file.channels}ch`
      parts.push(ac)
    }
    return parts.join(' · ') || '—'
  }

  const extColor = (ext: string): string => {
    const video = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']
    const lossless = ['.flac', '.wav']
    if (video.includes(ext)) return 'text-blue-400'
    if (lossless.includes(ext)) return 'text-emerald-400'
    return 'text-amber-400'
  }

  const opTabs: { id: typeof operation; label: string }[] = [
    { id: 'normalize', label: 'Normalize' },
    { id: 'boost', label: 'Boost' },
    { id: 'convert', label: 'Convert' },
    { id: 'extract', label: 'Extract Audio' },
    { id: 'compress', label: 'Compress' },
  ]

  const startLabel = (): string => {
    const n = files.length
    const s = n !== 1 ? 's' : ''
    const labels: Record<string, string> = {
      normalize: `Normalize ${n} File${s}`,
      boost: `Boost ${n} File${s}`,
      convert: `Convert ${n} File${s}`,
      extract: `Extract ${n} File${s}`,
      compress: `Compress ${n} File${s}`,
    }
    return labels[operation] || `Process ${n} File${s}`
  }

  return (
    <div className="space-y-5 animate-fade-in h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">File Queue</h1>
          <p className="text-sm text-surface-400 mt-0.5">
            {files.length === 0 ? 'Add files to get started' : `${files.length} file${files.length !== 1 ? 's' : ''} ready`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleAddFiles} className="px-3 py-1.5 text-sm font-medium text-surface-300 hover:text-white bg-surface-700/50 hover:bg-surface-600/50 rounded-lg transition-all">
            + Files
          </button>
          <button onClick={handleAddFolder} disabled={scanning} className="px-3 py-1.5 text-sm font-medium text-surface-300 hover:text-white bg-surface-700/50 hover:bg-surface-600/50 rounded-lg transition-all disabled:opacity-50">
            {scanning ? 'Scanning...' : '+ Folder'}
          </button>
          {files.length > 0 && (
            <button onClick={clearFiles} className="px-3 py-1.5 text-sm font-medium text-red-400/70 hover:text-red-400 rounded-lg transition-all">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Operation selector — tabs */}
      <div className="glass rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-surface-500 mr-2">Operation</span>
          <div className="flex bg-surface-800 rounded-lg p-0.5 flex-wrap gap-0.5">
            {opTabs.map((tab) => (
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

        {/* Operation-specific options */}
        {operation === 'normalize' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-surface-500">Presets:</span>
              {BUILTIN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleApplyPreset(p.id)}
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
        )}

        {operation === 'boost' && (
          <div className="flex items-center gap-3">
            <input type="range" min="-50" max="200" value={boostPercent} onChange={(e) => setBoostPercent(parseInt(e.target.value, 10))} className="w-32 accent-accent-500" />
            <div className="flex items-center gap-1">
              <input type="number" value={boostPercent} onChange={(e) => setBoostPercent(parseInt(e.target.value, 10) || 0)}
                className="w-16 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
              <span className="text-xs text-surface-500">%</span>
            </div>
          </div>
        )}

        {operation === 'convert' && (
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Output Format</label>
              <select value={convertOptions.outputFormat} onChange={(e) => setConvertOptions({ outputFormat: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="mp4">MP4</option><option value="mkv">MKV</option><option value="avi">AVI</option>
                <option value="mov">MOV</option><option value="webm">WebM</option><option value="mp3">MP3</option>
                <option value="flac">FLAC</option><option value="wav">WAV</option><option value="aac">AAC</option>
                <option value="ogg">OGG</option><option value="opus">Opus</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Video Codec</label>
              <select value={convertOptions.videoCodec} onChange={(e) => setConvertOptions({ videoCodec: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="copy">Copy (no re-encode)</option><option value="libx264">H.264</option>
                <option value="libx265">H.265 (HEVC)</option><option value="libvpx-vp9">VP9</option>
                <option value="libaom-av1">AV1</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Audio Codec</label>
              <select value={convertOptions.audioCodec} onChange={(e) => setConvertOptions({ audioCodec: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="copy">Copy</option><option value="aac">AAC</option><option value="ac3">AC3</option>
                <option value="libmp3lame">MP3</option><option value="libvorbis">Vorbis</option>
                <option value="libopus">Opus</option><option value="flac">FLAC</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Video Bitrate</label>
              <select value={convertOptions.videoBitrate} onChange={(e) => setConvertOptions({ videoBitrate: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="">Auto</option><option value="1000k">1 Mbps</option><option value="2500k">2.5 Mbps</option>
                <option value="5000k">5 Mbps</option><option value="8000k">8 Mbps</option>
                <option value="15000k">15 Mbps</option><option value="25000k">25 Mbps</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Resolution</label>
              <select value={convertOptions.resolution} onChange={(e) => setConvertOptions({ resolution: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="">Original</option><option value="3840x2160">4K (2160p)</option>
                <option value="1920x1080">1080p</option><option value="1280x720">720p</option>
                <option value="854x480">480p</option><option value="640x360">360p</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Framerate</label>
              <select value={convertOptions.framerate} onChange={(e) => setConvertOptions({ framerate: e.target.value })}
                className="w-full bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="">Original</option><option value="24">24 fps</option><option value="30">30 fps</option>
                <option value="60">60 fps</option>
              </select>
            </div>
          </div>
        )}

        {operation === 'extract' && (
          <div className="flex items-center gap-4">
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Output Format</label>
              <select value={extractOptions.outputFormat} onChange={(e) => setExtractOptions({ outputFormat: e.target.value })}
                className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="mp3">MP3</option><option value="aac">AAC</option><option value="flac">FLAC</option>
                <option value="wav">WAV</option><option value="ogg">OGG</option><option value="opus">Opus</option>
                <option value="m4a">M4A</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Audio Stream</label>
              <input type="number" min="0" max="10" value={extractOptions.streamIndex}
                onChange={(e) => setExtractOptions({ streamIndex: parseInt(e.target.value, 10) || 0 })}
                className="w-16 bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
            </div>
          </div>
        )}

        {operation === 'compress' && (
          <div className="flex items-center gap-4">
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Quality</label>
              <select value={compressOptions.quality} onChange={(e) => setCompressOptions({ quality: e.target.value as any })}
                className="bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-accent-500">
                <option value="lossless">Lossless</option><option value="high">High</option>
                <option value="medium">Medium</option><option value="low">Low (smallest)</option>
              </select>
            </div>
            <div>
              <label className="text-2xs text-surface-500 block mb-1">Target Size (MB, 0 = auto)</label>
              <input type="number" min="0" value={compressOptions.targetSizeMB}
                onChange={(e) => setCompressOptions({ targetSizeMB: parseFloat(e.target.value) || 0 })}
                className="w-24 bg-surface-800 border border-surface-600 rounded-md px-2 py-1.5 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500" />
            </div>
          </div>
        )}

        {/* Start button */}
        <div className="flex justify-end">
          <button
            onClick={handleStart}
            disabled={files.length === 0 || isProcessing}
            className="px-5 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-surface-700 disabled:text-surface-500 text-white text-sm font-semibold rounded-xl transition-all shadow-glow hover:shadow-glow-lg disabled:shadow-none"
          >
            {isProcessing ? 'Processing...' : startLabel()}
          </button>
        </div>
      </div>

      {/* Drop zone & file list */}
      <div
        className={`flex-1 min-h-0 rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col ${
          dragOver
            ? 'border-accent-400 bg-accent-500/5'
            : files.length === 0
              ? 'border-surface-700/50 bg-surface-900/30'
              : 'border-transparent bg-transparent'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {files.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-surface-800/50 border border-surface-700/50 flex items-center justify-center mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-surface-500">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17,8 12,3 7,8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className="text-surface-400 text-sm font-medium mb-1">Drop files here</p>
            <p className="text-surface-600 text-xs">or use the buttons above to browse</p>
            <p className="text-surface-700 text-2xs mt-3 font-mono">MP4 MKV AVI MOV MP3 WAV FLAC OGG M4A AAC +more</p>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface-900/90 backdrop-blur-sm">
                <tr className="text-left text-2xs font-semibold uppercase tracking-wider text-surface-500 border-b border-white/5">
                  <th className="py-2 px-3 w-8">#</th>
                  <th className="py-2 px-3">File</th>
                  <th className="py-2 px-3 w-20">Type</th>
                  <th className="py-2 px-3 w-44">Codec</th>
                  <th className="py-2 px-3 w-20 text-right">Duration</th>
                  <th className="py-2 px-3 w-24 text-right">Size</th>
                  <th className="py-2 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {files.map((file, i) => (
                  <tr
                    key={file.path}
                    className="border-b border-white/[0.03] hover:bg-surface-800/30 transition-colors group"
                  >
                    <td className="py-2 px-3 text-xs text-surface-600 font-mono">{i + 1}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-surface-200 truncate">{file.name}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`text-2xs font-mono font-bold uppercase ${extColor(file.ext)}`}>
                        {file.ext.replace('.', '')}
                      </span>
                    </td>
                    <td className="py-2 px-3">
                      <span className="text-2xs font-mono text-surface-400">{formatCodecInfo(file)}</span>
                    </td>
                    <td className="py-2 px-3 text-right text-xs text-surface-500 font-mono">{formatDuration(file.duration)}</td>
                    <td className="py-2 px-3 text-right text-xs text-surface-500 font-mono">{formatSize(file.size)}</td>
                    <td className="py-2 px-3">
                      <button
                        onClick={() => removeFile(file.path)}
                        className="opacity-0 group-hover:opacity-100 text-surface-500 hover:text-red-400 transition-all"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
