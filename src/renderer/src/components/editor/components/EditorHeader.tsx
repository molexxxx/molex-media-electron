/**
 * @module components/editor/EditorHeader
 * @description Header bar showing clip name, duration, trim/inspect tab switcher,
 * and an Add dropdown matching the batch processor pattern (File Browser, Choose Files, Add Folder).
 * Responsive: collapses tab switcher to icons on narrow widths.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useEditorStore } from '../../../stores/editorStore'
import { formatTime, ALL_EXTS } from '../types'

interface EditorHeaderProps {
  onLoadFile: (file: File) => void
  onLoadFilePath: (path: string) => void
}

export function EditorHeader({ onLoadFile, onLoadFilePath }: EditorHeaderProps): React.JSX.Element {
  const { editorTab, setEditorTab, activeClip, clipDuration, loadingCount, hasClips, resetEditor } = useEditorStore()
  const clip = activeClip()
  const dur = clipDuration()
  const loading = loadingCount()
  const showClear = hasClips()

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

  return (
    <>
      <div className="flex items-center justify-between shrink-0 gap-3 relative z-30">
        {/* Left — title + subtitle */}
        <div className="min-w-0 flex-1">
          <h1 className="text-lg sm:text-xl font-medium text-surface-200 tracking-tight">Editor</h1>
          <p className="text-xs text-surface-400 mt-0.5 truncate">
            {clip
              ? <>{clip.name} <span className="text-surface-600">—</span> {formatTime(dur)} selected</>
              : 'Cut, trim, and merge media clips'}
            {loading > 0 && (
              <span className="ml-2 text-accent-400 animate-pulse">({loading} loading…)</span>
            )}
          </p>
        </div>

        {/* Right — tabs + add dropdown */}
        <div className="flex items-center gap-2.5">
          {/* Tab switcher */}
          <div className="flex bg-white/[0.03] border border-white/[0.06] rounded-xl p-1 gap-1 backdrop-blur-sm">
            {(['trim', 'inspect'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setEditorTab(tab)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 capitalize ${
                  editorTab === tab
                    ? 'bg-accent-500/15 text-accent-200 border border-accent-500/25 shadow-sm'
                    : 'text-surface-400 hover:text-surface-200 hover:bg-white/[0.04] border border-transparent'
                }`}
              >
                {tab === 'trim' ? 'Trim' : 'Inspect'}
              </button>
            ))}
          </div>

          {/* Clear all */}
          {showClear && (
            <button
              onClick={resetEditor}
              className="px-3 py-1.5 text-xs font-medium rounded-lg text-surface-400 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
              title="Reset editor to default state"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline mr-1 -mt-0.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}

          {/* Add dropdown */}
          <div ref={addRef} className="relative">
            <button
              onClick={() => setAddOpen((o) => !o)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                addOpen ? 'bg-accent-500/25 text-accent-200 border border-accent-500/30' : 'bg-accent-500/15 hover:bg-accent-500/25 text-accent-300 border border-accent-500/20 hover:border-accent-500/30'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span className="hidden sm:inline">Add</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`transition-transform duration-200 ${addOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6"/></svg>
            </button>
            {addOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-surface-900/95 border border-surface-700/60 shadow-xl shadow-black/40 backdrop-blur-xl z-50 overflow-hidden animate-fade-in">
                <button
                  onClick={handleChooseFiles}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-400 shrink-0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  Choose Files
                </button>
                <div className="border-t border-white/[0.06]" />
                <button
                  onClick={handleAddFolder}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-surface-300 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-400 shrink-0"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  Add Folder
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
