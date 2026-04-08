/**
 * @module components/batch/QueueList
 * @description Drag-reorderable batch queue with per-file operation badges,
 * inline progress for active tasks, and contextual actions.
 */

import React, { useCallback, useState, useRef } from 'react'
import type { FileItem, ProcessingTask, Operation } from '../../../stores/types'
import { useAppStore } from '../../../stores/appStore'
import { formatSize, formatDuration, extColor } from '../utils'
import { OP_TABS } from './OperationPanel'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const OP_LABELS: Record<Operation, string> = {
  convert: 'Convert',
  normalize: 'Normalize',
  boost: 'Volume',
  compress: 'Compress',
  extract: 'Extract',
}

const OP_COLORS: Record<Operation, string> = {
  convert: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  normalize: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  boost: 'bg-green-500/20 text-green-400 border-green-500/30',
  compress: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  extract: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
}

function getOpIcon(op: Operation): React.JSX.Element | null {
  return OP_TABS.find((t) => t.id === op)?.icon || null
}

function findTask(tasks: ProcessingTask[], filePath: string): ProcessingTask | undefined {
  return tasks.find((t) => t.filePath === filePath)
}

function isActive(task?: ProcessingTask): boolean {
  return !!task && (task.status === 'processing' || task.status === 'analyzing' || task.status === 'finalizing')
}

/* ------------------------------------------------------------------ */
/*  Operation picker popover                                           */
/* ------------------------------------------------------------------ */

function OpPicker({ current, onChange, onClose }: {
  current: Operation; onChange: (op: Operation) => void; onClose: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-full left-0 mt-1 z-50 bg-surface-800 border border-surface-600 rounded-lg shadow-xl overflow-hidden animate-fade-in">
        {OP_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { onChange(tab.id); onClose() }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
              current === tab.id
                ? 'bg-accent-600/20 text-accent-300'
                : 'text-surface-300 hover:bg-surface-700 hover:text-white'
            }`}
          >
            <span className="text-surface-500">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  QueueRow                                                           */
/* ------------------------------------------------------------------ */

function QueueRow({ file, index, task, isDragging, onDragStart, onDragOver, onDrop, onRemove, onChangeOp }: {
  file: FileItem
  index: number
  task?: ProcessingTask
  isDragging: boolean
  onDragStart: (e: React.DragEvent, idx: number) => void
  onDragOver: (e: React.DragEvent, idx: number) => void
  onDrop: (e: React.DragEvent, idx: number) => void
  onRemove: (path: string) => void
  onChangeOp: (path: string, op: Operation) => void
}): React.JSX.Element {
  const [showPicker, setShowPicker] = useState(false)
  const active = isActive(task)
  const done = task?.status === 'complete'
  const failed = task?.status === 'error'
  const locked = active || done || failed

  return (
    <div
      draggable={!locked}
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      className={`group relative flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 sm:px-2.5 py-1.5 sm:py-2 rounded-lg transition-all ${
        isDragging ? 'opacity-40' : ''
      } ${active ? 'bg-accent-500/5 border border-accent-500/20' :
        done ? 'bg-emerald-500/5 border border-emerald-500/10' :
        failed ? 'bg-red-500/5 border border-red-500/10' :
        'hover:bg-surface-800/40 border border-transparent'
      }`}
    >
      {/* Drag handle */}
      {!locked ? (
        <div className="cursor-grab active:cursor-grabbing text-surface-700 hover:text-surface-400 transition-colors shrink-0" title="Drag to reorder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
            <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
          </svg>
        </div>
      ) : (
        <div className="w-3 shrink-0" />
      )}

      {/* Index */}
      <span className="text-2xs text-surface-600 font-mono w-4 text-right shrink-0">{index + 1}</span>

      {/* Operation badge — click to change */}
      <div className="relative shrink-0">
        <button
          onClick={() => !locked && setShowPicker(!showPicker)}
          disabled={locked}
          className={`flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium rounded-md border transition-all ${OP_COLORS[file.operation || 'normalize']} ${
            locked ? 'cursor-default' : 'cursor-pointer hover:brightness-125'
          }`}
          title={locked ? OP_LABELS[file.operation || 'normalize'] : `Click to change operation (${OP_LABELS[file.operation || 'normalize']})`}
        >
          <span className="[&>svg]:w-3 [&>svg]:h-3">{getOpIcon(file.operation || 'normalize')}</span>
          <span className="hidden sm:inline">{OP_LABELS[file.operation || 'normalize']}</span>
        </button>
        {showPicker && (
          <OpPicker
            current={file.operation || 'normalize'}
            onChange={(op) => onChangeOp(file.path, op)}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 sm:gap-2">
        <span className={`text-2xs font-mono font-bold uppercase shrink-0 ${extColor(file.ext)}`}>
          {file.ext.replace('.', '')}
        </span>
        <span className="text-xs sm:text-sm text-surface-200 truncate">{file.name}</span>
      </div>

      {/* Progress / Status for active tasks */}
      {active && task && (
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-20 h-1 rounded-full bg-surface-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-accent-500 transition-all duration-300"
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <span className="text-2xs font-mono text-accent-400 w-8 text-right">{task.progress}%</span>
        </div>
      )}

      {done && (
        <button
          onClick={() => window.api.showInFolder(task!.outputPath || task!.filePath)}
          className="text-2xs text-emerald-400 hover:text-emerald-300 transition-colors shrink-0"
          title="Show in folder"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {failed && (
        <span className="shrink-0" title={task?.error || 'Failed'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
            <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </span>
      )}

      {/* Duration + Size */}
      <span className="text-2xs text-surface-500 font-mono shrink-0 hidden sm:inline">{formatDuration(file.duration)}</span>
      <span className="text-2xs text-surface-600 font-mono shrink-0 hidden md:inline">{formatSize(file.size)}</span>

      {/* Remove */}
      {!locked && (
        <button
          onClick={() => onRemove(file.path)}
          className="opacity-0 group-hover:opacity-100 text-surface-600 hover:text-red-400 transition-all shrink-0"
          title="Remove from queue"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}

      {/* Active task message overlay */}
      {active && task && (
        <div className="absolute bottom-0 left-12 right-12 h-0.5">
          <div
            className="h-full bg-accent-500/40 rounded-full transition-all duration-300"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      )}

      {/* Inline error message */}
      {failed && task?.error && (
        <div className="w-full text-2xs text-red-400/80 truncate pl-7 -mt-0.5 pb-0.5">{task.error}</div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main QueueList                                                     */
/* ------------------------------------------------------------------ */

export function QueueList({ files, onAddFiles }: {
  files: FileItem[]
  onAddFiles: (items: FileItem[]) => void
}): React.JSX.Element {
  const { tasks, removeFile, reorderFiles, updateFileOperation, operation } = useAppStore()
  const [dragOver, setDragOver] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const dragCounter = useRef(0)

  // File drop handler
  const handleFileDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    // Ignore internal reorder drops
    if (e.dataTransfer.types.includes('text/queue-index')) return
    const items: FileItem[] = []
    for (const file of Array.from(e.dataTransfer.files)) {
      const p = window.api.getFilePath(file)
      if (!p) continue
      items.push({
        path: p,
        name: p.split(/[\\/]/).pop() || p,
        size: file.size || 0,
        ext: (p.match(/\.[^.]+$/) || [''])[0].toLowerCase(),
        operation
      })
    }
    if (items.length) onAddFiles(items)
  }, [onAddFiles, operation])

  // Reorder drag handlers
  const handleDragStart = (e: React.DragEvent, idx: number) => {
    e.dataTransfer.setData('text/queue-index', String(idx))
    e.dataTransfer.effectAllowed = 'move'
    setDragIdx(idx)
  }

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIdx(idx)
  }

  const handleReorderDrop = (e: React.DragEvent, toIdx: number) => {
    e.preventDefault()
    const fromStr = e.dataTransfer.getData('text/queue-index')
    if (fromStr === '') return
    const fromIdx = parseInt(fromStr, 10)

    // Don't allow dropping above active/done tasks
    const toTask = findTask(tasks, files[toIdx]?.path)
    if (isActive(toTask) || toTask?.status === 'complete' || toTask?.status === 'error') return

    if (fromIdx !== toIdx) {
      reorderFiles(fromIdx, toIdx)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  const handleDragEnd = () => {
    setDragIdx(null)
    setOverIdx(null)
  }

  const handleChangeOp = (path: string, op: Operation) => {
    const state = useAppStore.getState()
    updateFileOperation(path, op, {
      boostPercent: state.boostPercent,
      selectedPreset: state.selectedPreset,
      normalizeOptions: { ...state.normalizeOptions },
      convertOptions: { ...state.convertOptions },
      extractOptions: { ...state.extractOptions },
      compressOptions: { ...state.compressOptions },
    })
  }

  return (
    <div
      className={`flex-1 min-h-[180px] rounded-2xl transition-all duration-200 flex flex-col relative overflow-hidden ${
        dragOver
          ? 'border border-accent-400 bg-accent-500/[0.04]'
          : files.length === 0
            ? 'border border-dashed border-white/[0.06] bg-white/[0.02]'
            : 'border border-transparent bg-transparent'
      }`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/queue-index')) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('text/queue-index')) {
          dragCounter.current++
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('text/queue-index')) {
          dragCounter.current--
          if (dragCounter.current <= 0) {
            dragCounter.current = 0
            setDragOver(false)
          }
        }
      }}
      onDrop={handleFileDrop}
    >
      {files.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.04] flex items-center justify-center mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-surface-500">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17,8 12,3 7,8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="text-surface-400 text-sm font-medium">Drop files here to queue</p>
          <p className="text-surface-600 text-2xs mt-1.5">Files inherit the selected operation above</p>
          <p className="text-surface-700 text-2xs mt-3 font-mono">MP4 MKV AVI MOV MP3 WAV FLAC OGG M4A AAC +more</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-1 px-1" onDragEnd={handleDragEnd}>
          {files.map((file, i) => {
            const task = findTask(tasks, file.path)
            return (
              <React.Fragment key={file.path}>
                {overIdx === i && dragIdx !== null && dragIdx !== i && (
                  <div className="h-0.5 bg-accent-500 rounded-full mx-4 my-0.5" />
                )}
                <QueueRow
                  file={file}
                  index={i}
                  task={task}
                  isDragging={dragIdx === i}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleReorderDrop}
                  onRemove={removeFile}
                  onChangeOp={handleChangeOp}
                />
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
