/**
 * @module components/editor/EditorHeader
 * @description Header bar showing clip name, duration, trim/inspect tab switcher,
 * and an Add dropdown matching the batch processor pattern (File Browser, Choose Files, Add Folder).
 * Responsive: collapses tab switcher to icons on narrow widths.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime, ALL_EXTS } from '../types'
import { FileBrowser } from '../../shared'

interface EditorHeaderProps {
  onLoadFile: (file: File) => void
  onLoadFilePath: (path: string) => void
}

export function EditorHeader({ onLoadFile, onLoadFilePath }: EditorHeaderProps): React.JSX.Element {
  const { editorTab, setEditorTab, activeClip, clipDuration, loadingCount } = useEditorStore()
  const clip = activeClip()
  const dur = clipDuration()
  const loading = loadingCount()

  const [addOpen, setAddOpen] = useState(false)
  const [showBrowser, setShowBrowser] = useState(false)
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

  const handleChooseFiles = useCallback(() => {
    setAddOpen(false)
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = ALL_EXTS.map((e) => `.${e}`).join(',')
    input.onchange = () => { for (const f of Array.from(input.files || [])) onLoadFile(f) }
    input.click()
  }, [onLoadFile])

  const handleAddFolder = useCallback(async () => {
    setAddOpen(false)
    const dirPath = await window.api.openDirectory()
    if (!dirPath) return
    const scanned = await window.api.scanDirectory(dirPath)
    for (const item of scanned) onLoadFilePath(item.path)
  }, [onLoadFilePath])

  const handleBrowseSelect = useCallback((paths: string[]) => {
    for (const p of paths) onLoadFilePath(p)
    setShowBrowser(false)
  }, [onLoadFilePath])

  return (
    <>
      <div className="flex items-center justify-between shrink-0 flex-wrap gap-2">
        {/* Left — title + subtitle */}
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Editor</h1>
          <p className="text-xs sm:text-sm text-surface-400 mt-0.5 truncate">
            {clip
              ? `${clip.name} — ${formatTime(dur)} selected`
              : 'Cut, trim, and merge media clips'}
            {loading > 0 && (
              <span className="ml-2 text-accent-400 animate-pulse">({loading} loading…)</span>
            )}
          </p>
        </div>

        {/* Right — tabs + add dropdown */}
        <div className="flex items-center gap-2">
          {/* Tab switcher */}
          <div className="flex bg-surface-800 rounded-lg p-0.5 gap-0.5 mr-1">
            {(['trim', 'inspect'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setEditorTab(tab)}
                className={`px-2.5 sm:px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize ${
                  editorTab === tab
                    ? 'bg-accent-600 text-white shadow-glow'
                    : 'text-surface-400 hover:text-surface-200'
                }`}
              >
                {tab === 'trim' ? (
                  <>
                    <span className="hidden sm:inline">Trim</span>
                    <svg className="sm:hidden w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                  </>
                ) : (
                  <>
                    <span className="hidden sm:inline">Inspect</span>
                    <svg className="sm:hidden w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Add dropdown */}
          <div ref={addRef} className="relative">
            <button
              onClick={() => setAddOpen((o) => !o)}
              className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span className="hidden sm:inline">Add</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform ${addOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6"/></svg>
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-surface-800 border border-surface-700 rounded-xl shadow-xl z-50 py-1 animate-fade-in">
                <button
                  onClick={() => { setAddOpen(false); setShowBrowser(true) }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-surface-200 hover:bg-surface-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                  File Browser
                </button>
                <button
                  onClick={handleChooseFiles}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-surface-200 hover:bg-surface-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  Choose Files
                </button>
                <button
                  onClick={handleAddFolder}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-surface-200 hover:bg-surface-700 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  Add Folder
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <FileBrowser
        open={showBrowser}
        onClose={() => setShowBrowser(false)}
        onSelect={handleBrowseSelect}
        extensions={ALL_EXTS}
        title="Add Media Files"
      />
    </>
  )
}
