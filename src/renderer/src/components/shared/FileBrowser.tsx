/**
 * @module components/shared/FileBrowser
 * @description VLC-style file browser modal for navigating local folders
 * and selecting media files. Shows known locations (Music, Videos, etc.)
 * as quick-access shortcuts and supports full directory browsing.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BrowseEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  ext: string
}

interface KnownFolder {
  name: string
  path: string
  icon: string
}

export interface FileBrowserProps {
  open: boolean
  onClose: () => void
  /** Called with selected file/folder paths when user confirms. */
  onSelect: (paths: string[]) => void
  /** File extensions to show (without dot, lowercase). If empty, shows all. */
  extensions?: string[]
  /** Allow selecting entire folders (adds all matching files inside). */
  allowFolders?: boolean
  /** Title shown in the modal header. */
  title?: string
  /** Whether to allow selecting multiple files. Default true. */
  multiple?: boolean
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

const FOLDER_ICONS: Record<string, React.JSX.Element> = {
  desktop: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  documents: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14,2 14,8 20,8" />
    </svg>
  ),
  downloads: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  music: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  ),
  video: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" />
      <line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" />
    </svg>
  ),
  picture: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  home: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  ),
  drive: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  folder: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  file: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14,2 14,8 20,8" />
    </svg>
  ),
  audio: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11,5 6,9 2,9 2,15 6,15 11,19" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  ),
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'webm'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts'])

function getFileIcon(ext: string): React.JSX.Element {
  const e = ext.replace('.', '')
  if (AUDIO_EXTENSIONS.has(e)) return FOLDER_ICONS.audio
  if (VIDEO_EXTENSIONS.has(e)) return FOLDER_ICONS.video
  if (e === 'jpg' || e === 'jpeg' || e === 'png' || e === 'gif' || e === 'webp') return FOLDER_ICONS.picture
  return FOLDER_ICONS.file
}

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function FileBrowser({
  open, onClose, onSelect, extensions = [], allowFolders = true,
  title = 'Browse Files', multiple = true
}: FileBrowserProps): React.JSX.Element | null {
  const [knownFolders, setKnownFolders] = useState<KnownFolder[]>([])
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pathInput, setPathInput] = useState('')
  const [editingPath, setEditingPath] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)

  const extSet = React.useMemo(() => new Set(extensions.map((e) => `.${e.toLowerCase()}`)), [extensions])

  // Load known folders on first open
  useEffect(() => {
    if (!open) return
    window.api.getKnownFolders().then(setKnownFolders).catch(() => {})
    setSelected(new Set())
    setCurrentPath(null)
    setEntries([])
    setError(null)
  }, [open])

  // Browse into a directory
  const browse = useCallback(async (dirPath: string) => {
    setLoading(true)
    setError(null)
    setSelected(new Set())
    try {
      const result = await window.api.browseDirectory(dirPath)
      if (!result.success) {
        setError(result.error || 'Cannot access this folder')
        setEntries([])
      } else {
        // Filter files by extension if specified
        const filtered = result.entries.filter((e) => {
          if (e.isDirectory) return true
          if (extSet.size === 0) return true
          return extSet.has(e.ext)
        })
        setEntries(filtered)
        setParentPath(result.parentPath)
      }
      setCurrentPath(dirPath)
      setPathInput(dirPath)
      listRef.current?.scrollTo(0, 0)
    } finally {
      setLoading(false)
    }
  }, [extSet])

  // Handle path input submission
  const handlePathSubmit = useCallback(() => {
    const p = pathInput.trim()
    if (p) browse(p)
    setEditingPath(false)
  }, [pathInput, browse])

  // Toggle selection
  const toggleSelect = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        if (!multiple) next.clear()
        next.add(path)
      }
      return next
    })
  }, [multiple])

  // Select all visible files
  const selectAll = useCallback(() => {
    const filePaths = entries.filter((e) => !e.isDirectory).map((e) => e.path)
    setSelected((prev) => {
      if (prev.size === filePaths.length) return new Set() // deselect all
      return new Set(filePaths)
    })
  }, [entries])

  // Confirm selection
  const handleConfirm = useCallback(() => {
    if (selected.size === 0) return
    onSelect(Array.from(selected))
    onClose()
  }, [selected, onSelect, onClose])

  // Double-click: open folder or select+confirm single file
  const handleDoubleClick = useCallback((entry: BrowseEntry) => {
    if (entry.isDirectory) {
      browse(entry.path)
    } else {
      onSelect([entry.path])
      onClose()
    }
  }, [browse, onSelect, onClose])

  // Add entire folder
  const handleAddFolder = useCallback(async (folderPath: string) => {
    if (!allowFolders) return
    setLoading(true)
    try {
      const result = await window.api.browseDirectory(folderPath)
      if (result.success) {
        const files = result.entries
          .filter((e) => !e.isDirectory && (extSet.size === 0 || extSet.has(e.ext)))
          .map((e) => e.path)
        if (files.length > 0) {
          onSelect(files)
          onClose()
        }
      }
    } finally {
      setLoading(false)
    }
  }, [allowFolders, extSet, onSelect, onClose])

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onClose(); e.preventDefault() }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey) && currentPath) { selectAll(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, selectAll, currentPath])

  // Focus path input when editing
  useEffect(() => {
    if (editingPath) pathInputRef.current?.focus()
  }, [editingPath])

  if (!open) return null

  const fileCount = entries.filter((e) => !e.isDirectory).length
  const dirCount = entries.filter((e) => e.isDirectory).length
  const selectedDirs = Array.from(selected).filter((p) => entries.find((e) => e.path === p)?.isDirectory)
  const selectedFiles = selected.size - selectedDirs.length

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-1 min-[520px]:p-3" onClick={onClose}>
      <div
        className="w-full max-w-none min-[520px]:max-w-[780px] h-full max-h-[95vh] min-[520px]:max-h-[85vh] flex flex-col bg-surface-900 border border-surface-700 rounded-xl min-[520px]:rounded-2xl shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 min-[520px]:px-4 min-[520px]:py-3 border-b border-white/5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-accent-400 shrink-0" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-surface-500 hover:text-white hover:bg-surface-700 transition-colors shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Horizontal locations strip — visible only on narrow viewports */}
        <div className="flex min-[480px]:hidden items-center gap-1 px-2 py-1.5 border-b border-white/5 shrink-0 overflow-x-auto scrollbar-thin bg-surface-950/40">
          {knownFolders.map((folder) => (
            <button
              key={folder.path}
              onClick={() => browse(folder.path)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs whitespace-nowrap shrink-0 transition-colors ${
                currentPath === folder.path
                  ? 'bg-accent-500/20 text-accent-300'
                  : 'text-surface-400 hover:text-white hover:bg-surface-800'
              }`}
              title={folder.name}
            >
              <span className={`shrink-0 ${currentPath === folder.path ? 'text-accent-400' : 'text-surface-500'}`}>
                {FOLDER_ICONS[folder.icon] || FOLDER_ICONS.folder}
              </span>
              <span>{folder.name}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar: known locations — hidden on narrow viewports */}
          <div className="hidden min-[480px]:block w-36 min-[500px]:w-40 shrink-0 border-r border-white/5 overflow-y-auto scrollbar-thin bg-surface-950/40 py-1.5">
            {knownFolders.map((folder) => (
              <button
                key={folder.path}
                onClick={() => browse(folder.path)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors ${
                  currentPath === folder.path
                    ? 'bg-accent-500/15 text-accent-300'
                    : 'text-surface-300 hover:text-white hover:bg-surface-800/60'
                }`}
                title={folder.name}
              >
                <span className={`shrink-0 ${currentPath === folder.path ? 'text-accent-400' : 'text-surface-500'}`}>
                  {FOLDER_ICONS[folder.icon] || FOLDER_ICONS.folder}
                </span>
                <span className="truncate">{folder.name}</span>
              </button>
            ))}
          </div>

          {/* Main content */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Breadcrumb / path bar */}
            {currentPath && (
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/5 shrink-0">
                <button
                  onClick={() => parentPath && parentPath !== currentPath && browse(parentPath)}
                  disabled={!parentPath || parentPath === currentPath}
                  className="w-6 h-6 rounded flex items-center justify-center text-surface-500 hover:text-white hover:bg-surface-700 disabled:opacity-30 transition-colors shrink-0"
                  title="Go up"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                {editingPath ? (
                  <input
                    ref={pathInputRef}
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    onBlur={() => { handlePathSubmit() }}
                    onKeyDown={(e) => { if (e.key === 'Enter') handlePathSubmit(); if (e.key === 'Escape') setEditingPath(false) }}
                    className="flex-1 bg-surface-800 text-surface-200 rounded px-2 py-0.5 text-xs border border-accent-500 outline-none font-mono min-w-0"
                  />
                ) : (
                  <button
                    onClick={() => setEditingPath(true)}
                    className="flex-1 text-left text-xs text-surface-400 hover:text-surface-200 font-mono truncate px-2 py-0.5 rounded hover:bg-surface-800 transition-colors min-w-0"
                    title="Click to edit path"
                  >
                    {currentPath}
                  </button>
                )}
                {fileCount > 0 && (
                  <button
                    onClick={selectAll}
                    className="text-2xs text-surface-500 hover:text-accent-400 px-2 shrink-0 transition-colors"
                    title="Select / deselect all files"
                  >
                    {selected.size === fileCount ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            )}

            {/* File list */}
            <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-thin">
              {!currentPath && (
                <div className="flex items-center justify-center h-full text-surface-500 text-sm">
                  <div className="text-center">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto text-surface-600 mb-3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <p>Select a location to browse</p>
                  </div>
                </div>
              )}
              {loading && (
                <div className="flex items-center justify-center h-32">
                  <div className="w-5 h-5 border-2 border-accent-500 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {error && (
                <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/20 text-xs text-red-300">
                  {error}
                </div>
              )}
              {!loading && !error && currentPath && entries.length === 0 && (
                <div className="flex items-center justify-center h-32 text-surface-500 text-xs">
                  No matching files in this folder
                </div>
              )}
              {!loading && entries.length > 0 && (
                <div className="p-1">
                  {entries.map((entry) => {
                    const isSelected = selected.has(entry.path)
                    return (
                      <div
                        key={entry.path}
                        className={`group flex items-center gap-2 px-2.5 py-1 rounded-lg cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-accent-600/20 text-accent-300'
                            : 'text-surface-300 hover:bg-surface-800/60 hover:text-white'
                        }`}
                        onClick={() => {
                          if (entry.isDirectory) {
                            browse(entry.path)
                          } else {
                            toggleSelect(entry.path)
                          }
                        }}
                        onDoubleClick={() => handleDoubleClick(entry)}
                      >
                        {/* Checkbox for files */}
                        {!entry.isDirectory && (
                          <span
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                              isSelected ? 'bg-accent-600 border-accent-500' : 'border-surface-600 group-hover:border-surface-400'
                            }`}
                            onClick={(e) => { e.stopPropagation(); toggleSelect(entry.path) }}
                          >
                            {isSelected && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </span>
                        )}
                        {/* Icon */}
                        <span className={`shrink-0 ${entry.isDirectory ? 'text-amber-400/80' : isSelected ? 'text-accent-400' : 'text-surface-500'}`}>
                          {entry.isDirectory ? FOLDER_ICONS.folder : getFileIcon(entry.ext)}
                        </span>
                        {/* Name */}
                        <span className="flex-1 text-xs truncate min-w-0">{entry.name}</span>
                        {/* Size */}
                        {!entry.isDirectory && entry.size > 0 && (
                          <span className="text-2xs text-surface-600 shrink-0 font-mono">{formatSize(entry.size)}</span>
                        )}
                        {/* Add folder button */}
                        {entry.isDirectory && allowFolders && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleAddFolder(entry.path) }}
                            className="text-2xs text-surface-500 hover:text-accent-400 opacity-0 group-hover:opacity-100 transition-all px-1.5 py-0.5 rounded hover:bg-accent-500/10 shrink-0"
                            title="Add all files from this folder"
                          >
                            + All
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer / status bar */}
            <div className="flex items-center justify-between px-2 py-1.5 min-[520px]:px-3 min-[520px]:py-2 border-t border-white/5 shrink-0 bg-surface-950/40 gap-2">
              <div className="text-2xs text-surface-500 truncate min-w-0">
                {currentPath ? (
                  <>
                    {selected.size > 0 ? (
                      <span className="text-accent-400">{selectedFiles} selected</span>
                    ) : (
                      <span>{dirCount} folder{dirCount !== 1 ? 's' : ''}, {fileCount} file{fileCount !== 1 ? 's' : ''}</span>
                    )}
                  </>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={onClose}
                  className="px-3 py-1 text-xs text-surface-400 hover:text-white rounded-lg hover:bg-surface-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={selected.size === 0}
                  className="px-3 py-1 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 disabled:opacity-30 disabled:cursor-not-allowed text-white transition-all"
                >
                  Add{selected.size > 0 ? ` (${selected.size})` : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
