/**
 * @module components/batch/FileQueue
 * @description Batch file queue with operation selector and processing controls.
 *
 * Manages the file list for batch operations (normalize, boost, convert,
 * extract, compress). Supports drag-and-drop file addition, folder scanning,
 * auto-probing for codec metadata, preset selection, and per-operation
 * configuration forms.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { FileItem } from '../../stores/types'
import { OperationPanel } from './components/OperationPanel'
import { FileTable } from './components/FileTable'
import { FileBrowser } from '../shared'

export default function FileQueue(): React.JSX.Element {
  const {
    files, addFiles, updateFile, removeFile, clearFiles,
    operation, config, batchOutputDir, setBatchOutputDir
  } = useAppStore()
  const [scanning, setScanning] = useState(false)
  const [showBrowser, setShowBrowser] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  const MEDIA_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts',
    'mp3', 'wav', 'flac', 'ogg', 'm4a', 'wma', 'aac', 'opus']

  // Close dropdown on outside click
  useEffect(() => {
    if (!addOpen) return
    const onClick = (e: MouseEvent): void => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [addOpen])

  const handleBrowseSelect = useCallback((paths: string[]) => {
    const items: FileItem[] = paths.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() || p,
      size: 0,
      ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
    }))
    addFiles(items)
  }, [addFiles])

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
    const { batchOutputDir } = useAppStore.getState()
    const outputDir = batchOutputDir || undefined

    if (operation === 'normalize') {
      await window.api.normalize(paths, outputDir)
    } else if (operation === 'boost') {
      const { boostPercent } = useAppStore.getState()
      await window.api.boost(paths, boostPercent, outputDir)
    } else if (operation === 'convert') {
      const { convertOptions } = useAppStore.getState()
      await window.api.convert(paths, convertOptions, outputDir)
    } else if (operation === 'extract') {
      const { extractOptions } = useAppStore.getState()
      await window.api.extract(paths, extractOptions, outputDir)
    } else if (operation === 'compress') {
      const { compressOptions } = useAppStore.getState()
      await window.api.compress(paths, compressOptions, outputDir)
    }
  }

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
    <div className="space-y-4 animate-fade-in h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Batch Processor</h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {files.length === 0 ? 'Add files to get started' : `${files.length} file${files.length !== 1 ? 's' : ''} ready`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {files.length > 0 && (
            <button onClick={clearFiles} className="px-2.5 py-1.5 text-xs text-surface-500 hover:text-red-400 rounded-lg transition-colors">
              Clear
            </button>
          )}
          {/* Add dropdown */}
          <div ref={addRef} className="relative">
            <button
              onClick={() => setAddOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                addOpen ? 'bg-accent-600 text-white' : 'bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${addOpen ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-surface-800 border border-surface-600 shadow-2xl z-50 overflow-hidden animate-fade-in">
                <button
                  onClick={() => { setAddOpen(false); setShowBrowser(true) }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-surface-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400/80 shrink-0">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  File Browser
                </button>
                <button
                  onClick={() => { setAddOpen(false); handleAddFiles() }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-surface-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-400 shrink-0">
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14,2 14,8 20,8" />
                  </svg>
                  Choose Files
                </button>
                <div className="border-t border-white/5" />
                <button
                  onClick={() => { setAddOpen(false); handleAddFolder() }}
                  disabled={scanning}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-surface-700 transition-colors disabled:opacity-50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-400 shrink-0">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
                  </svg>
                  {scanning ? 'Scanning...' : 'Add Folder'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <OperationPanel onStart={handleStart} startLabel={startLabel} />
      <FileTable files={files} onRemoveFile={removeFile} onAddFiles={addFiles} />

      {/* Output directory — compact inline bar */}
      <div className="flex items-center gap-2 shrink-0 glass rounded-lg px-3 py-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-surface-500 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-2xs text-surface-500 font-medium shrink-0">Output</span>
        <input
          type="text"
          value={batchOutputDir}
          onChange={(e) => setBatchOutputDir(e.target.value)}
          placeholder={
            config?.overwriteOriginal
              ? 'Overwrite originals (global setting)'
              : config?.outputDirectory
                ? config.outputDirectory
                : 'Same as source (global setting)'
          }
          className="flex-1 bg-transparent text-surface-300 text-xs outline-none truncate min-w-0 placeholder:text-surface-600"
        />
        <button
          onClick={async () => {
            const dir = await window.api.selectOutputDir()
            if (dir) setBatchOutputDir(dir)
          }}
          className="shrink-0 text-2xs text-surface-500 hover:text-surface-200 transition-colors"
          title="Browse for output directory"
        >
          Browse
        </button>
        {batchOutputDir && (
          <button
            onClick={() => setBatchOutputDir('')}
            className="shrink-0 text-surface-600 hover:text-surface-300 transition-colors"
            title="Reset to global setting"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <FileBrowser
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        onSelect={handleBrowseSelect}
        extensions={MEDIA_EXTS}
        title="Browse Media Files"
      />
    </div>
  )
}

