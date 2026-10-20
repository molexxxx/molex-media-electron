/**
 * @module App
 * @description Root application component with view routing and global IPC setup.
 *
 * Initializes the IPC bridge via {@link useIPC}, keeps the main window's jobs
 * store in step with the engine, routes files dropped outside the Batch page
 * to the engine, manages view mounting history for state preservation,
 * supports popout player mode, and conditionally renders the setup wizard
 * when FFmpeg is not available. Hosts the shell services: the notification
 * region, the F6 region cycle, the close confirmation (above the
 * initializing and setup screens), and the zoom keys in both windows.
 */

import React, { useState, useEffect } from 'react'
import type { JobsApi } from '../../shared/jobs/contract'
import { isMediaPath } from '../../shared/jobs/extensions'
import { useIPC } from './hooks/useIPC'
import { useJobs, windowJobsApi } from './hooks/useJobs'
import { useAppStore, View } from './stores/appStore'
import { useJobsStore, type JobsState } from './stores/jobs'
import { selectGroupCounts } from './stores/jobsSelectors'
import { filesAddedToast } from './copy/batch'
import { TitleBar, Sidebar, CloseConfirmModal } from './components/layout'
import { PopoutShell } from './components/layout/components/PopoutShell'
import { Dashboard } from './components/dashboard'
import { BatchPage } from './components/batch/BatchPage'
import { Settings } from './components/settings'
import { LogViewer } from './components/logs'
import { MediaEditor } from './components/editor'
import { MediaPlayer } from './components/player'
import { SetupWizard } from './components/setup'
import { ToastRegion, toast, type ToastOptions } from './ui'
import { focusNextRegion } from './hooks/useF6Region'
import { listenUnclaimedKeys, useAppZoomKeys } from './hooks/useAppZoomKeys'

/** A file or folder dropped on the window, outside the Batch page. */
export interface DroppedItem {
  path: string
  directory: boolean
}

/** What {@link addDroppedItems} needs from the shell. */
export interface DropAddDeps {
  add: JobsApi['add']
  /** The run setting "Include subfolders". */
  includeSubfolders: () => boolean
  showBatch: () => void
  notify: (options: ToastOptions) => void
}

/** Codes of refused paths that are not media at all. */
const NOT_MEDIA_CODES: ReadonlySet<string> = new Set(['not-media', 'unsupported'])

/**
 * Adds dropped files and folders as new jobs through one jobs:add with the
 * "New files get" recipe, then shows Batch. A drop with no media file and no
 * folder is ignored; main's extension list decides the rest and reports what
 * it skipped. A folder scan reports itself on the Batch page.
 */
export async function addDroppedItems(items: readonly DroppedItem[], deps: DropAddDeps): Promise<void> {
  if (!items.some((item) => item.directory || isMediaPath(item.path))) return
  deps.showBatch()
  const reply = await deps.add({
    paths: items.map((item) => item.path),
    recipe: null,
    origin: 'drop',
    after: null,
    recursive: deps.includeSubfolders(),
    allowSecondJobs: false,
    force: false
  })
  if (!reply.ok) {
    deps.notify({ tone: 'error', title: reply.error.message })
    return
  }
  const result = reply.value
  if (result.added.length === 0 && result.scanIds.length > 0) return
  const words = filesAddedToast(result.added.length, {
    notMedia: result.refused.filter((entry) => NOT_MEDIA_CODES.has(entry.code)).length,
    duplicates: result.duplicates.paths.length,
    outputs: result.previousOutputs.length
  })
  const added = result.added.length > 0
  deps.notify({
    tone: added ? 'success' : 'warning',
    title: added ? words.title : 'No files were added.',
    ...(words.body === null ? {} : { body: words.body })
  })
}

/** Whether the engine holds a batch in progress or jobs that wait, so a fresh start opens on Batch. */
export function opensOnBatch(state: JobsState): boolean {
  if ((state.run?.status ?? 'idle') !== 'idle') return true
  return selectGroupCounts(state).waiting > 0
}

/**
 * Chooses the first view once, when the first engine snapshot lands: Batch
 * while a batch runs or jobs wait, otherwise the Dashboard. A view the user
 * already chose is left alone.
 */
function useInitialView(): void {
  useEffect(() => {
    const decide = (state: JobsState): boolean => {
      if (state.hydrations === 0) return false
      const app = useAppStore.getState()
      if (opensOnBatch(state) && app.currentView === 'dashboard' && app.viewHistory.length === 0) {
        useAppStore.setState({ currentView: 'batch' })
      }
      return true
    }
    if (decide(useJobsStore.getState())) return undefined
    const stop = useJobsStore.subscribe((state) => {
      if (decide(state)) stop()
    })
    return stop
  }, [])
}

/**
 * The main window's engine link: subscribes the jobs store and picks the
 * first view. Only the main shell renders it, so the popout player never
 * subscribes to the batch.
 */
function MainWindowJobs(): null {
  useJobs()
  useInitialView()
  return null
}

/** The paths of a drop's files and whether each is a folder. */
function droppedItems(transfer: DataTransfer | null): DroppedItem[] {
  if (!transfer) return []
  const entries = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file')
  const items: DroppedItem[] = []
  Array.from(transfer.files).forEach((file, index) => {
    const path = window.api.getFilePath(file)
    if (!path) return
    const entry = entries[index]?.webkitGetAsEntry?.() ?? null
    items.push({ path, directory: entry?.isDirectory ?? false })
  })
  return items
}

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

  // A drop the Batch page or another view did not take becomes new jobs; the popout never adds to the batch
  const setView = useAppStore((s) => s.setView)
  useEffect(() => {
    if (isPopout) return
    const onDrop = (e: DragEvent): void => {
      if (e.defaultPrevented) return
      e.preventDefault()
      const jobs = windowJobsApi() as JobsApi | null
      const items = droppedItems(e.dataTransfer)
      if (jobs === null || items.length === 0) return
      void addDroppedItems(items, {
        add: (request) => jobs.add(request),
        includeSubfolders: () => useJobsStore.getState().settings?.includeSubfolders ?? true,
        showBatch: () => {
          if (useAppStore.getState().currentView !== 'batch') setView('batch')
        },
        notify: (options) => {
          toast.show(options)
        }
      })
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
  }, [isPopout, setView])

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
      <MainWindowJobs />
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
    { id: 'batch', el: <BatchPage /> },
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
                  id === 'batch'
                    // Batch regions meet the window edges
                    ? ''
                    : id === 'dashboard'
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
