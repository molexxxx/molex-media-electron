/**
 * @module hooks/useIPC
 * @description React hook that bridges the renderer process with Electron's main process.
 *
 * On mount, loads the persisted configuration, system information, FFmpeg
 * status, and the log buffer. Subscribes to IPC event channels (log entries,
 * task progress, batch lifecycle, download progress, and navigation) and
 * pipes them into the Zustand store. Cleans up all listeners on unmount.
 */

import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'

declare global {
  interface Window {
    api: any
  }
}

export function useIPC(): void {
  const {
    setConfig,
    setFFmpegReady,
    setFFmpegChecking,
    setShowSetup,
    setSystemInfo,
    setView,
    addLog,
    updateTask,
    setTasks,
    setActiveBatch,
    setIsProcessing,
    setIsPaused,
    setDownloadProgress,
    incrementProcessed,
    incrementErrors
  } = useAppStore()

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        if (cancelled) return
        // Load config
        const config = await window.api.loadConfig()
        setConfig(config)
        // Hydrate sidebar collapsed state from persisted config
        if (config && typeof config.sidebarCollapsed === 'boolean') {
          useAppStore.setState({ sidebarCollapsed: config.sidebarCollapsed })
        }

        // Load system info
        const sysInfo = await window.api.getSystemInfo()
        setSystemInfo(sysInfo)

        // Check FFmpeg
        setFFmpegChecking(true)
        const result = await window.api.checkFFmpeg()
        if (result.found) {
          setFFmpegReady(true, result.version)
          // Reload config with updated paths
          const updated = await window.api.loadConfig()
          setConfig(updated)
        } else {
          setShowSetup(true)
        }
        setFFmpegChecking(false)

        // Load existing logs
        const logs = await window.api.getLogBuffer()
        for (const log of logs) {
          addLog(log)
        }
      } catch (err) {
        console.error('Init error:', err)
        setFFmpegChecking(false)
      }
    }

    init()

    // Subscribe to IPC events
    const unsubLog = window.api.onLogEntry((entry: any) => {
      addLog(entry)
    })

    const unsubTaskProgress = window.api.onTaskProgress((task: any) => {
      updateTask(task)
      if (task.status === 'complete') incrementProcessed()
      if (task.status === 'error') incrementErrors()
    })

    const unsubBatchStarted = window.api.onBatchStarted((data: any) => {
      setTasks(data.tasks)
      setActiveBatch(data.batchId)
      setIsProcessing(true)
    })

    const unsubBatchComplete = window.api.onBatchComplete(() => {
      setIsProcessing(false)
      setActiveBatch(null)
      setIsPaused(false)
    })

    const unsubPaused = window.api.onPaused(() => {
      setIsPaused(true)
    })

    const unsubResumed = window.api.onResumed(() => {
      setIsPaused(false)
    })

    const unsubDownload = window.api.onDownloadProgress((progress: any) => {
      setDownloadProgress(progress)
    })

    const unsubNavigate = window.api.onNavigate?.((view: string) => {
      setView(view as any)
    })

    return () => {
      cancelled = true
      unsubLog?.()
      unsubTaskProgress?.()
      unsubBatchStarted?.()
      unsubBatchComplete?.()
      unsubPaused?.()
      unsubResumed?.()
      unsubDownload?.()
      unsubNavigate?.()
    }
  }, [])
}
