/**
 * @module App
 * @description Root application component with view routing and global IPC setup.
 *
 * Initialises the IPC bridge via {@link useIPC}, handles global drag-and-drop
 * file additions, manages view mounting history for state preservation,
 * supports popout player mode, and conditionally renders the setup wizard
 * when FFmpeg is not available.
 */

import React, { useState, useEffect } from 'react'
import { useIPC } from './hooks/useIPC'
import { useAppStore, View, FileItem } from './stores/appStore'
import { TitleBar, Sidebar, CloseConfirmModal } from './components/layout'
import { PopoutShell } from './components/layout/components/PopoutShell'
import { Dashboard } from './components/dashboard'
import { FileQueue } from './components/batch'
import { Settings } from './components/settings'
import { LogViewer } from './components/logs'
import { MediaEditor } from './components/editor'
import { MediaPlayer } from './components/player'
import { SetupWizard } from './components/setup'
import { AmbientBackground } from './components/dashboard/components/DashboardBackground'

function App(): React.JSX.Element {
  useIPC()

  const isPopout = window.location.hash === '#popout'

  const { currentView, showSetup, ffmpegChecking, goBack } = useAppStore()

  // Global updater status listener - captures events from auto-check on startup
  const setUpdateStatus = useAppStore((s) => s.setUpdateStatus)
  const setUpdateVersion = useAppStore((s) => s.setUpdateVersion)
  const setUpdateError = useAppStore((s) => s.setUpdateError)
  const setUpdateDownloadPercent = useAppStore((s) => s.setUpdateDownloadPercent)
  useEffect(() => {
    const cleanup = window.api.onUpdaterStatus?.((info: any) => {
      setUpdateStatus(info.status)
      if (info.version) setUpdateVersion(info.version)
      if (info.error) setUpdateError(info.error)
      if (info.percent != null) setUpdateDownloadPercent(info.percent)
    })
    // Re-hydrate cached status after renderer reload (Ctrl+R)
    window.api.getUpdaterStatus?.().then((info: any) => {
      if (info && info.status && info.status !== 'idle') {
        setUpdateStatus(info.status)
        if (info.version) setUpdateVersion(info.version)
        if (info.error) setUpdateError(info.error)
        if (info.percent != null) setUpdateDownloadPercent(info.percent)
      }
    }).catch(() => {})
    return cleanup
  }, [setUpdateStatus, setUpdateVersion, setUpdateError, setUpdateDownloadPercent])

  // Global drop fallback: files dropped anywhere in the window get added to batch
  const { addFiles, setView } = useAppStore()
  useEffect(() => {
    const MEDIA_EXTS = new Set([
      '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts',
      '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.wma', '.aac', '.opus'
    ])
    const onDrop = (e: DragEvent): void => {
      // Don't intercept if a component already handled it
      if (e.defaultPrevented) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files || [])
      if (files.length === 0) return
      const items: FileItem[] = []
      for (const file of files) {
        const p = window.api.getFilePath(file)
        if (!p) continue
        const ext = (p.match(/\.[^.]+$/) || [''])[0].toLowerCase()
        if (!MEDIA_EXTS.has(ext)) continue
        items.push({
          path: p,
          name: p.split(/[\\/]/).pop() || p,
          size: file.size || 0,
          ext
        })
      }
      if (items.length) {
        addFiles(items)
        if (currentView !== 'batch') setView('batch')
      }
    }
    const onDragOver = (e: DragEvent): void => {
      if (!e.defaultPrevented) e.preventDefault()
    }
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragover', onDragOver)
    return () => {
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragover', onDragOver)
    }
  }, [addFiles, setView, currentView])

  // Track which views have been visited so they stay mounted (preserving state)
  const [mounted, setMounted] = useState<Set<View>>(() => new Set([currentView]))
  useEffect(() => {
    setMounted((prev) => {
      if (prev.has(currentView)) return prev
      return new Set(prev).add(currentView)
    })
  }, [currentView])

  // Right-click context menu for text inputs and textareas
  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        e.preventDefault()
        window.api.showTextContextMenu()
      }
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  // Mouse back button (button 3) and Alt+Left for navigation history
  useEffect(() => {
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [goBack])

  // -- Popout player mode --
  if (isPopout) {
    return <PopoutShell />
  }

  if (ffmpegChecking) {
    return (
      <div className="h-full flex flex-col">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 border-2 border-accent-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-surface-300 text-sm font-medium tracking-wide">Initializing molexMedia...</p>
          </div>
        </div>
      </div>
    )
  }

  if (showSetup) {
    return (
      <div className="h-full flex flex-col">
        <TitleBar />
        <SetupWizard />
      </div>
    )
  }

  const views: { id: View; el: React.JSX.Element }[] = [
    { id: 'dashboard', el: <Dashboard /> },
    { id: 'batch', el: <FileQueue /> },
    { id: 'editor', el: <MediaEditor /> },
    { id: 'player', el: <MediaPlayer /> },
    { id: 'settings', el: <Settings /> },
    { id: 'logs', el: <LogViewer /> }
  ]

  return (
    <div className="h-full flex relative">
      <AmbientBackground />
      {/* Sidebar - full height of window */}
      <div className="shrink-0 h-full">
        <Sidebar />
      </div>
      {/* Title bar + content column */}
      <div className="flex flex-col flex-1 min-w-0">
        <TitleBar />
        <main className="flex-1 overflow-hidden relative">
          {views.map(({ id, el }) =>
            mounted.has(id) ? (
              <div
                key={id}
                className={`absolute inset-0 p-3 sm:p-4 md:p-6 ${
                  id === 'logs' || id === 'editor'
                    ? 'flex flex-col overflow-hidden'
                    : 'overflow-auto'
                }`}
                style={{ display: currentView === id ? (id === 'logs' || id === 'editor' ? 'flex' : 'block') : 'none' }}
              >
                {el}
              </div>
            ) : null
          )}
        </main>
      </div>
      <CloseConfirmModal />
    </div>
  )
}

export default App
