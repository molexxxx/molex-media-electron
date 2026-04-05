import { useCallback, useState } from 'react'
import { useAppStore, FileItem } from '../stores/appStore'

export default function FileQueue(): JSX.Element {
  const {
    files, addFiles, removeFile, clearFiles,
    operation, setOperation, boostPercent, setBoostPercent,
    isProcessing, setView
  } = useAppStore()
  const [dragOver, setDragOver] = useState(false)
  const [scanning, setScanning] = useState(false)

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

  const handleStart = async () => {
    if (files.length === 0) return
    const paths = files.map((f) => f.path)
    setView('processing')

    if (operation === 'normalize') {
      await window.api.normalize(paths)
    } else {
      await window.api.boost(paths, boostPercent)
    }
  }

  const formatSize = (bytes: number): string => {
    if (!bytes) return '—'
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const extColor = (ext: string): string => {
    const video = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']
    const lossless = ['.flac', '.wav']
    if (video.includes(ext)) return 'text-blue-400'
    if (lossless.includes(ext)) return 'text-emerald-400'
    return 'text-amber-400'
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

      {/* Operation selector */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-surface-500">Operation</span>
          <div className="flex bg-surface-800 rounded-lg p-0.5">
            <button
              onClick={() => setOperation('normalize')}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                operation === 'normalize'
                  ? 'bg-accent-600 text-white shadow-glow'
                  : 'text-surface-400 hover:text-surface-200'
              }`}
            >
              Normalize
            </button>
            <button
              onClick={() => setOperation('boost')}
              className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                operation === 'boost'
                  ? 'bg-accent-600 text-white shadow-glow'
                  : 'text-surface-400 hover:text-surface-200'
              }`}
            >
              Boost
            </button>
          </div>

          {operation === 'boost' && (
            <div className="flex items-center gap-3 ml-4">
              <input
                type="range"
                min="-50"
                max="200"
                value={boostPercent}
                onChange={(e) => setBoostPercent(parseInt(e.target.value, 10))}
                className="w-32 accent-accent-500"
              />
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={boostPercent}
                  onChange={(e) => setBoostPercent(parseInt(e.target.value, 10) || 0)}
                  className="w-16 bg-surface-800 border border-surface-600 rounded-md px-2 py-1 text-sm text-white font-mono text-center focus:outline-none focus:border-accent-500"
                />
                <span className="text-xs text-surface-500">%</span>
              </div>
            </div>
          )}

          <div className="ml-auto">
            <button
              onClick={handleStart}
              disabled={files.length === 0 || isProcessing}
              className="px-5 py-2 bg-accent-600 hover:bg-accent-500 disabled:bg-surface-700 disabled:text-surface-500 text-white text-sm font-semibold rounded-xl transition-all shadow-glow hover:shadow-glow-lg disabled:shadow-none"
            >
              {isProcessing
                ? 'Processing...'
                : operation === 'normalize'
                  ? `Normalize ${files.length} File${files.length !== 1 ? 's' : ''}`
                  : `Boost ${files.length} File${files.length !== 1 ? 's' : ''}`
              }
            </button>
          </div>
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
