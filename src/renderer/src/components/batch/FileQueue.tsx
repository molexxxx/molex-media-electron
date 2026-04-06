/**
 * @module components/batch/FileQueue
 * @description Batch file queue with operation selector and processing controls.
 *
 * Manages the file list for batch operations (normalize, boost, convert,
 * extract, compress). Supports drag-and-drop file addition, folder scanning,
 * auto-probing for codec metadata, preset selection, and per-operation
 * configuration forms.
 */

import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { FileItem } from '../../stores/types'
import { VIDEO_EXTS } from './utils'
import { OperationPanel } from './components/OperationPanel'
import { FileTable } from './components/FileTable'

export default function FileQueue(): React.JSX.Element {
  const {
    files, addFiles, updateFile, removeFile, clearFiles,
    operation
  } = useAppStore()
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

  const handleStart = async () => {
    if (files.length === 0) return
    const paths = files.map((f) => f.path)

    if (operation === 'normalize') {
      await window.api.normalize(paths)
    } else if (operation === 'boost') {
      const { boostPercent } = useAppStore.getState()
      await window.api.boost(paths, boostPercent)
    } else if (operation === 'convert') {
      const { convertOptions } = useAppStore.getState()
      await window.api.convert(paths, convertOptions)
    } else if (operation === 'extract') {
      const { extractOptions } = useAppStore.getState()
      await window.api.extract(paths, extractOptions)
    } else if (operation === 'compress') {
      const { compressOptions } = useAppStore.getState()
      await window.api.compress(paths, compressOptions)
    }
  }

  const hasVideoFiles = files.some((f) => VIDEO_EXTS.has(f.ext))

  const startLabel = (() => {
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
  })()

  return (
    <div className="space-y-5 animate-fade-in h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Batch Processor</h1>
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

      <OperationPanel onStart={handleStart} startLabel={startLabel} hasVideoFiles={hasVideoFiles} />
      <FileTable files={files} onRemoveFile={removeFile} onAddFiles={addFiles} />
    </div>
  )
}

