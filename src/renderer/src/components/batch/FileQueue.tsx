/**
 * @module components/batch/FileQueue
 * @description Batch file queue with operation selector, drag-reorderable
 * queue list, per-file operation badges, and inline progress.
 */

import React, { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { FileItem } from '../../stores/types'
import { OperationPanel } from './components/OperationPanel'
import { QueueList } from './components/QueueList'

export default function FileQueue(): React.JSX.Element {
  const {
    files, addFiles, updateFile, resetBatch,
    config, batchOutputDir, setBatchOutputDir, tasks, isProcessing
  } = useAppStore()
  const [scanning, setScanning] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!addOpen) return
    const onClick = (e: MouseEvent): void => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [addOpen])

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
    const { batchOutputDir } = useAppStore.getState()
    const outputDir = batchOutputDir || undefined

    const taskSpecs = files.map((f) => ({
      filePath: f.path,
      operation: f.operation || useAppStore.getState().operation,
      outputDir,
      boostPercent: f.boostPercent,
      normalizeOptions: f.normalizeOptions,
      convertOptions: f.convertOptions,
      extractOptions: f.extractOptions,
      compressOptions: f.compressOptions,
    }))

    await window.api.startBatchQueue(taskSpecs)
  }

  const activeTasks = tasks.filter(
    (t) => t.status === 'processing' || t.status === 'analyzing' || t.status === 'finalizing'
  ).length
  const completedTasks = tasks.filter((t) => t.status === 'complete').length

  return (
    <div className="space-y-3 animate-fade-in min-h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">Batch<span className="hidden sm:inline"> Processor</span></h1>
          <p className="text-xs text-surface-500 mt-0.5">
            {isProcessing
              ? `${activeTasks} active · ${completedTasks}/${tasks.length} done`
              : files.length === 0
                ? 'Add files to get started'
                : `${files.length} file${files.length !== 1 ? 's' : ''} queued`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {files.length > 0 && !isProcessing && (
            <button onClick={resetBatch} className="px-2.5 py-1.5 text-xs text-surface-500 hover:text-red-400 rounded-lg transition-colors" title="Clear queue">
              Clear
            </button>
          )}
          {files.length > 0 && !isProcessing && (
            <button
              onClick={handleStart}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/20 hover:border-emerald-500/30 transition-all"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Process {files.length}
            </button>
          )}
          {/* Add dropdown */}
          <div ref={addRef} className="relative">
            <button
              onClick={() => setAddOpen((v) => !v)}
              disabled={isProcessing}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-40 ${
                addOpen ? 'bg-accent-500/25 text-accent-200 border border-accent-500/30' : 'bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 border border-accent-500/20 hover:border-accent-500/30'
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

      <OperationPanel />
      <QueueList files={files} onAddFiles={addFiles} />

      {/* Output directory — compact inline bar */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0 rounded-lg border border-white/[0.06] bg-surface-900/40 px-3 py-2">
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

    </div>
  )
}

