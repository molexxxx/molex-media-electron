/**
 * @module components/batch/FileTable
 * @description Sortable file table with drag-and-drop import, bulk removal, and codec info columns.
 */

import React, { useCallback, useState } from 'react'
import type { FileItem } from '../../../stores/types'
import { formatSize, formatDuration, formatCodecInfo, extColor } from '../utils'

export function FileTable({ files, onRemoveFile, onAddFiles }: {
  files: FileItem[]
  onRemoveFile: (path: string) => void
  onAddFiles: (items: FileItem[]) => void
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const items: FileItem[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.api.getFilePath(file)
      if (!p) continue
      items.push({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: file.size || 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      })
    }
    if (items.length) onAddFiles(items)
  }, [onAddFiles])

  return (
    <div
      className={`flex-1 min-h-0 rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col ${
        dragOver
          ? 'border-accent-400 bg-accent-500/5'
          : files.length === 0
            ? 'border-surface-700/50 bg-surface-900/30'
            : 'border-transparent bg-transparent'
      }`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
      onDragLeave={(e) => { e.stopPropagation(); setDragOver(false) }}
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
                      onClick={() => onRemoveFile(file.path)}
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
  )
}
