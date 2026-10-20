/**
 * @module App
 * @description Root application component with view routing and global IPC setup.
 *
 * Initializes the IPC bridge via {@link useIPC}, handles global drag-and-drop
 * file additions, manages view mounting history for state preservation,
 * supports popout player mode, and conditionally renders the setup wizard
 * when FFmpeg is not available. Hosts the shell services: the notification
 * region, the F6 region cycle, the close confirmation (above the
 * initializing and setup screens), and the zoom keys in both windows.
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
import { PreviewBatch } from './dev/PreviewBatch'
import { ToastRegion } from './ui'
import { focusNextRegion } from './hooks/useF6Region'
import { listenUnclaimedKeys, useAppZoomKeys } from './hooks/useAppZoomKeys'

function App(): React.JSX.Element {
  useIPC()
  useAppZoomKeys()

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

  // A view that cycles its own regions claims F6 first; a modal dialog keeps focus inside itself
  useEffect(() => {
    if (isPopout) return
    return listenUnclaimedKeys((e) => {
      if (e.key !== 'F6' || e.ctrlKey || e.altKey || e.metaKey) return
      if (document.querySelector('dialog[open]')) return
      e.preventDefault()
      focusNextRegion(e.shiftKey ? 'previous' : 'next')
    })
  }, [isPopout])

  // -- Popout player mode --
  if (isPopout) {
    return <PopoutShell />
  }

  const withCloseConfirm = (body: React.JSX.Element): React.JSX.Element => (
    <>
      {body}
      <CloseConfirmModal />
    </>
  )

  if (ffmpegChecking) {
    return withCloseConfirm(
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
    return withCloseConfirm(
      <div className="h-full flex flex-col">
        <TitleBar />
        <SetupWizard />
      </div>
    )
  }

  const views: { id: View; el: React.JSX.Element }[] = [
    { id: 'dashboard', el: <Dashboard /> },
    { id: 'batch', el: import.meta.env.DEV ? <PreviewBatch /> : <FileQueue /> },
    { id: 'editor', el: <MediaEditor /> },
    { id: 'player', el: <MediaPlayer /> },
    { id: 'settings', el: <Settings /> },
    { id: 'logs', el: <LogViewer /> }
  ]

  const fixedLayoutViews = new Set<View>(['batch', 'logs', 'editor'])

  return withCloseConfirm(
    <div className="h-full flex relative">
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
                className={`absolute inset-0 ${
                  id === 'dashboard'
                    // Dashboard scrolls vertically; pad only the content
                    // side so the scrollbar sits flush against the right
                    // window border, with a small visual gap on the
                    // left provided by the inner content's own pr-*.
                    ? 'pl-3 sm:pl-4 md:pl-6 py-3 sm:py-4 md:py-6 pr-0'
                    : 'p-3 sm:p-4 md:p-6'
                } ${
                  fixedLayoutViews.has(id)
                    ? 'flex flex-col overflow-hidden'
                    : 'overflow-auto'
                }`}
                style={{ display: currentView === id ? (fixedLayoutViews.has(id) ? 'flex' : 'block') : 'none' }}
              >
                {el}
              </div>
            ) : null
          )}
          <ToastRegion onShowMore={() => setView('logs')} />
        </main>
      </div>
    </div>
  )
}

export default App
