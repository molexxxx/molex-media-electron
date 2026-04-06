/**
 * @module components/player/components/PlaylistPanel
 * @description Collapsible playlist sidebar with drag-to-reorder, now-playing
 * indicator, and per-track controls.
 */

import React, { useCallback, useState, useEffect } from 'react'
import type { Track } from '../types'

interface KnownFolder {
  name: string
  path: string
  icon: string
}

/** A single subfolder entry returned from browseDirectory */
interface SubEntry {
  name: string
  path: string
  isDirectory: boolean
}

/** Tracks expanded state & children per folder path */
interface ExpandedState {
  [folderPath: string]: { loading: boolean; children: SubEntry[] }
}

interface PlaylistPanelProps {
  playlist: Track[]
  trackIdx: number
  playing: boolean
  vertical?: boolean
  onPlayTrack: (idx: number) => void
  onRemoveTrack: (idx: number) => void
  onMoveTrack: (from: number, to: number) => void
  onClearPlaylist: () => void
  onLoadFolder?: (folderPath: string, mode: 'replace' | 'append') => void
}

const FOLDER_ICONS: Record<string, React.JSX.Element> = {
  desktop: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>,
  documents: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14,2 14,8 20,8" /></svg>,
  downloads: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  music: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>,
  video: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /></svg>,
  home: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>,
  drive: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>,
  folder: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>,
  picture: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>,
}

/** Caret arrow icon for expand/collapse */
const CaretIcon = ({ open }: { open: boolean }): React.JSX.Element => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
    className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
  >
    <polyline points="9 6 15 12 9 18" />
  </svg>
)

/** Recursive folder row with expandable children */
function FolderRow({
  name, path, icon, depth, expanded, onToggle, onSelect
}: {
  name: string
  path: string
  icon: React.JSX.Element
  depth: number
  expanded: ExpandedState
  onToggle: (path: string, e: React.MouseEvent) => void
  onSelect: (path: string) => void
}): React.JSX.Element {
  const isOpen = !!expanded[path]
  const entry = expanded[path]

  return (
    <>
      <div className="flex items-center group" style={{ paddingLeft: `${depth * 14 + 4}px` }}>
        <button
          onClick={(e) => onToggle(path, e)}
          className="w-5 h-5 shrink-0 flex items-center justify-center text-surface-600 hover:text-surface-300 transition-colors"
        >
          {entry?.loading ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="animate-spin">
              <circle cx="12" cy="12" r="10" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
          ) : (
            <CaretIcon open={isOpen} />
          )}
        </button>
        <button
          onClick={() => onSelect(path)}
          className="flex-1 flex items-center gap-2 py-1.5 pr-3 text-xs text-surface-300 hover:text-white transition-colors truncate"
          title={path}
        >
          <span className="text-surface-500 shrink-0">{icon}</span>
          <span className="truncate">{name}</span>
        </button>
      </div>
      {isOpen && entry && !entry.loading && entry.children.map((child) => (
        <FolderRow
          key={child.path}
          name={child.name}
          path={child.path}
          icon={FOLDER_ICONS.folder}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
      {isOpen && entry && !entry.loading && entry.children.length === 0 && (
        <div className="text-2xs text-surface-600 italic" style={{ paddingLeft: `${(depth + 1) * 14 + 24}px` }}>
          No subfolders
        </div>
      )}
    </>
  )
}

export function PlaylistPanel({
  playlist, trackIdx, playing, vertical, onPlayTrack, onRemoveTrack, onMoveTrack, onClearPlaylist, onLoadFolder
}: PlaylistPanelProps): React.JSX.Element {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [showFolders, setShowFolders] = useState(false)
  const [knownFolders, setKnownFolders] = useState<KnownFolder[]>([])
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ExpandedState>({})

  useEffect(() => {
    if (showFolders && knownFolders.length === 0) {
      window.api.getKnownFolders().then(setKnownFolders).catch(() => {})
    }
  }, [showFolders, knownFolders.length])

  // Reset expanded state when folder browser is hidden
  useEffect(() => {
    if (!showFolders) setExpanded({})
  }, [showFolders])

  const toggleExpand = useCallback(async (folderPath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (expanded[folderPath]) {
      // Collapse: remove this entry and any children underneath
      setExpanded((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          if (key === folderPath || key.startsWith(folderPath + '\\') || key.startsWith(folderPath + '/')) {
            delete next[key]
          }
        }
        return next
      })
    } else {
      // Expand: load children
      setExpanded((prev) => ({ ...prev, [folderPath]: { loading: true, children: [] } }))
      try {
        const result = await window.api.browseDirectory(folderPath)
        const dirs = (result.entries || []).filter((e: SubEntry) => e.isDirectory)
        setExpanded((prev) => ({ ...prev, [folderPath]: { loading: false, children: dirs } }))
      } catch {
        setExpanded((prev) => ({ ...prev, [folderPath]: { loading: false, children: [] } }))
      }
    }
  }, [expanded])

  const collapseAll = useCallback(() => setExpanded({}), [])

  const handleFolderClick = useCallback((folderPath: string) => {
    if (!onLoadFolder) return
    if (playlist.length > 0) {
      setConfirmFolder(folderPath)
    } else {
      onLoadFolder(folderPath, 'replace')
      setShowFolders(false)
    }
  }, [playlist.length, onLoadFolder])

  const handleConfirm = useCallback((mode: 'replace' | 'append') => {
    if (!confirmFolder || !onLoadFolder) return
    onLoadFolder(confirmFolder, mode)
    setConfirmFolder(null)
    setShowFolders(false)
  }, [confirmFolder, onLoadFolder])

  const handleDragStart = useCallback((idx: number) => setDragIdx(idx), [])

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault()
    setDragOverIdx(idx)
  }, [])

  const handleDrop = useCallback((idx: number) => {
    if (dragIdx !== null && dragIdx !== idx) onMoveTrack(dragIdx, idx)
    setDragIdx(null)
    setDragOverIdx(null)
  }, [dragIdx, onMoveTrack])

  const handleDragEnd = useCallback(() => {
    setDragIdx(null)
    setDragOverIdx(null)
  }, [])

  return (
    <div className={`${vertical ? 'w-full max-h-48' : 'h-full'} shrink-0 flex flex-col glass rounded-2xl border border-white/5 overflow-hidden`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <span className="text-sm font-semibold text-white">Playlist</span>
        <div className="flex items-center gap-1">
          {onLoadFolder && (
            <button
              onClick={() => setShowFolders((v) => !v)}
              className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                showFolders ? 'text-accent-400 bg-accent-500/15' : 'text-surface-500 hover:text-surface-300'
              }`}
              title="Browse folders"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          )}
          {playlist.length > 0 && (
            <button
              onClick={onClearPlaylist}
              className="text-2xs text-surface-500 hover:text-red-400 transition-colors px-1"
              title="Clear all"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Confirm dialog — clear or append */}
      {confirmFolder && (
        <div className="px-3 py-2.5 border-b border-white/5 bg-surface-800/60 space-y-2 animate-fade-in">
          <p className="text-2xs text-surface-300">Playlist has {playlist.length} track{playlist.length !== 1 ? 's' : ''}. What do you want to do?</p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleConfirm('replace')}
              className="flex-1 px-2 py-1.5 text-2xs font-medium rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
            >
              Replace
            </button>
            <button
              onClick={() => handleConfirm('append')}
              className="flex-1 px-2 py-1.5 text-2xs font-medium rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-200 transition-colors"
            >
              Append
            </button>
            <button
              onClick={() => setConfirmFolder(null)}
              className="px-2 py-1.5 text-2xs text-surface-500 hover:text-surface-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Folder browser panel */}
      {showFolders && !confirmFolder && (
        <div className="border-b border-white/5 bg-surface-950/40 animate-fade-in max-h-72 overflow-y-auto scrollbar-thin">
          {/* Header with collapse-all */}
          {Object.keys(expanded).length > 0 && (
            <div className="flex justify-end px-2 pt-1">
              <button
                onClick={collapseAll}
                className="text-2xs text-surface-600 hover:text-surface-300 transition-colors flex items-center gap-1 px-1"
                title="Collapse all"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          )}
          <div className="py-1">
            {knownFolders.map((folder) => (
              <FolderRow
                key={folder.path}
                name={folder.name}
                path={folder.path}
                icon={FOLDER_ICONS[folder.icon] || FOLDER_ICONS.folder}
                depth={0}
                expanded={expanded}
                onToggle={toggleExpand}
                onSelect={handleFolderClick}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {playlist.length === 0 ? (
          <div className="flex items-center justify-center h-full text-surface-500 text-xs p-4 text-center">
            <div>
              <p className="mb-2">No tracks yet</p>
              <p className="text-surface-600 text-2xs">Drop files, browse, or paste URLs</p>
            </div>
          </div>
        ) : (
          <div className="p-1">
            {playlist.map((t, idx) => (
              <div
                key={t.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className={`group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  idx === trackIdx
                    ? 'bg-accent-600/20 text-accent-300'
                    : 'text-surface-300 hover:bg-surface-800/50 hover:text-white'
                } ${dragOverIdx === idx && dragIdx !== idx ? 'border-t-2 border-accent-500' : ''} ${dragIdx === idx ? 'opacity-40' : ''}`}
                onClick={() => onPlayTrack(idx)}
              >
                <span className="w-5 text-center shrink-0 cursor-grab active:cursor-grabbing" title="Drag to reorder">
                  {idx === trackIdx && playing ? (
                    <span className="inline-flex gap-0.5 items-end h-3">
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '60%' }} />
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '100%', animationDelay: '0.15s' }} />
                      <span className="w-0.5 bg-accent-400 rounded animate-pulse" style={{ height: '40%', animationDelay: '0.3s' }} />
                    </span>
                  ) : (
                    <span className="text-2xs text-surface-600">{idx + 1}</span>
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{t.name}</p>
                  {t.videoUrl && <p className="text-2xs text-red-400/60 truncate">YouTube</p>}
                  {!t.isBlob && !t.videoUrl && t.src && <p className="text-2xs text-surface-600 truncate">{t.src}</p>}
                </div>
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-all">
                  <button
                    onClick={(e) => { e.stopPropagation(); if (idx > 0) onMoveTrack(idx, idx - 1) }}
                    className={`text-surface-500 hover:text-white transition-colors ${idx === 0 ? 'invisible' : ''}`}
                    title="Move up"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (idx < playlist.length - 1) onMoveTrack(idx, idx + 1) }}
                    className={`text-surface-500 hover:text-white transition-colors ${idx === playlist.length - 1 ? 'invisible' : ''}`}
                    title="Move down"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveTrack(idx) }}
                    className="text-surface-500 hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
