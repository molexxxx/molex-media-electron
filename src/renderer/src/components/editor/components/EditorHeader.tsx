/**
 * @module components/editor/EditorHeader
 * @description Header bar showing clip name, duration, and trim/inspect tab switcher.
 */

import React from 'react'
import type { Clip } from '../types'
import { formatTime } from '../types'

type EditorTab = 'trim' | 'inspect'

interface EditorHeaderProps {
  clip: Clip | null
  clipDuration: number
  editorTab: EditorTab
  onSetEditorTab: (tab: EditorTab) => void
  onFileSelect: () => void
}

export function EditorHeader({ clip, clipDuration, editorTab, onSetEditorTab, onFileSelect }: EditorHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between shrink-0">
      <div>
        <h1 className="text-2xl font-bold text-white">Editor</h1>
        <p className="text-sm text-surface-400 mt-0.5">
          {clip ? `${clip.name} — ${formatTime(clipDuration)} selected` : 'Cut, trim, and merge media clips'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex bg-surface-800 rounded-lg p-0.5 gap-0.5 mr-2">
          {(['trim', 'inspect'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onSetEditorTab(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize ${
                editorTab === tab
                  ? 'bg-accent-600 text-white shadow-glow'
                  : 'text-surface-400 hover:text-surface-200'
              }`}
            >
              {tab === 'trim' ? 'Trim' : 'Inspect'}
            </button>
          ))}
        </div>
        <button
          onClick={onFileSelect}
          className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white shadow-glow hover:shadow-glow-lg transition-all"
        >
          Add Files
        </button>
      </div>
    </div>
  )
}
