/**
 * @module editor/edit/ShortcutsModal
 * Full keyboard shortcuts reference modal, grouped by category.
 */
import React, { useEffect } from 'react'

interface ShortcutsModalProps {
  open: boolean
  onClose: () => void
}

const SECTIONS: { title: string; items: { keys: string[][]; desc: string }[] }[] = [
  {
    title: 'Transport',
    items: [
      { keys: [['Space']], desc: 'Play / Pause' },
      { keys: [['←'], ['→']], desc: 'Step 1 frame' },
      { keys: [['Shift', '←'], ['Shift', '→']], desc: 'Step 10 frames' },
      { keys: [['Home'], ['End']], desc: 'Go to start / end' },
      { keys: [['↑'], ['↓']], desc: 'Previous / next edit point' },
      { keys: [['J'], ['K'], ['L']], desc: 'Reverse · Stop · Forward' }
    ]
  },
  {
    title: 'Tools',
    items: [
      { keys: [['V']], desc: 'Select tool' },
      { keys: [['T']], desc: 'Trim tool' },
      { keys: [['B']], desc: 'Razor / split tool' },
      { keys: [['N']], desc: 'Toggle snap' }
    ]
  },
  {
    title: 'Editing',
    items: [
      { keys: [['S']], desc: 'Split at playhead' },
      { keys: [['Del'], ['Backspace']], desc: 'Delete selected clips' },
      { keys: [['Shift', 'Del']], desc: 'Ripple delete' },
      { keys: [['I'], ['O']], desc: 'Mark in / out point' },
      { keys: [['Esc']], desc: 'Clear in/out (or deselect)' },
      { keys: [[',']], desc: 'Insert edit' },
      { keys: [['.']], desc: 'Overwrite edit' }
    ]
  },
  {
    title: 'Selection',
    items: [
      { keys: [['Ctrl', 'A']], desc: 'Select all clips' },
      { keys: [['Ctrl', 'D']], desc: 'Deselect all' },
      { keys: [['Ctrl', 'C'], ['Ctrl', 'X'], ['Ctrl', 'V']], desc: 'Copy / Cut / Paste' },
      { keys: [['Ctrl', 'Z']], desc: 'Undo' },
      { keys: [['Ctrl', 'Shift', 'Z']], desc: 'Redo' }
    ]
  },
  {
    title: 'Timeline',
    items: [
      { keys: [['Shift', 'Scroll']], desc: 'Pan' },
      { keys: [['Ctrl', 'Scroll']], desc: 'Zoom' },
      { keys: [['Ctrl', '='], ['Ctrl', '−']], desc: 'Zoom in / out' },
      { keys: [['Ctrl', '0']], desc: 'Fit to view' }
    ]
  }
]

/** Render a key combo like ['Ctrl', 'Shift', 'Z'] as styled kbd elements */
function KeyCombo({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-surface-600 text-[8px] mx-px">+</span>}
          <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-mono leading-none bg-white/[0.06] border border-white/[0.08] text-surface-300 min-w-[20px] text-center shadow-[0_1px_0_rgba(255,255,255,0.04)]">
            {k}
          </kbd>
        </React.Fragment>
      ))}
    </span>
  )
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface-900 border border-white/10 rounded-xl shadow-2xl w-[560px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h2 className="text-sm font-semibold text-surface-100">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-surface-500 hover:text-surface-200 text-lg leading-none px-1"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 grid grid-cols-2 gap-x-6 gap-y-5">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-[10px] font-semibold text-surface-500 uppercase tracking-wider mb-2">
                {section.title}
              </h3>
              <div className="space-y-1.5">
                {section.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-3 py-0.5"
                  >
                    <span className="text-[11px] text-surface-300 truncate">{item.desc}</span>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      {item.keys.map((combo, ci) => (
                        <React.Fragment key={ci}>
                          {ci > 0 && <span className="text-surface-600 text-[9px]">/</span>}
                          <KeyCombo keys={combo} />
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-white/5 text-center">
          <span className="text-[10px] text-surface-500">
            Press <kbd className="px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-[10px] font-mono">?</kbd> or <kbd className="px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-[10px] font-mono">Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  )
}
