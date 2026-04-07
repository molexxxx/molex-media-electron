import React, { useState, useEffect, useCallback } from 'react'

export function CloseConfirmModal(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)

  useEffect(() => {
    const cleanup = window.api.onCloseConfirm(() => setVisible(true))
    return cleanup
  }, [])

  const respond = useCallback((action: 'minimize' | 'quit') => {
    setVisible(false)
    window.api.closeConfirmResponse(action, dontAsk)
    setDontAsk(false)
  }, [dontAsk])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setVisible(false); setDontAsk(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => { setVisible(false); setDontAsk(false) }}
    >
      <div
        className="w-full max-w-sm mx-4 rounded-2xl bg-surface-900 border border-white/10 shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-500/15 flex items-center justify-center shrink-0 mt-0.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-400">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-surface-100">Minimize to Tray?</h3>
            <p className="text-xs text-surface-400 mt-1 leading-relaxed">
              molexMedia will continue running in the system tray.
              Restore it by double-clicking the tray icon, or quit from the tray menu.
            </p>
          </div>
        </div>

        {/* Don't ask again */}
        <div className="px-5 pb-4">
          <label className="flex items-center gap-2 cursor-pointer group">
            <div
              className={`w-4 h-4 rounded border transition-colors flex items-center justify-center ${
                dontAsk
                  ? 'bg-accent-500 border-accent-500'
                  : 'border-surface-600 group-hover:border-surface-500'
              }`}
              onClick={() => setDontAsk(!dontAsk)}
            >
              {dontAsk && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </div>
            <span className="text-xs text-surface-400 select-none" onClick={() => setDontAsk(!dontAsk)}>Don&apos;t ask again</span>
          </label>
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex items-center gap-2">
          <button
            onClick={() => respond('minimize')}
            className="flex-1 px-4 py-2 text-xs font-semibold rounded-lg bg-accent-600 hover:bg-accent-500 text-white transition-colors"
          >
            Minimize to Tray
          </button>
          <button
            onClick={() => respond('quit')}
            className="flex-1 px-4 py-2 text-xs font-semibold rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-surface-100 border border-white/5 transition-colors"
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  )
}
